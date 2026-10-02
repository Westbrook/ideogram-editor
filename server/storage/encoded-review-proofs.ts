import type {BlobRef} from '../../src/protocol/store.js';
import {adapterResources} from '../observability/adapter-resources.js';
import {AssetRejection} from './assets.js';
import {canonical,isId,isSeq} from './canonical.js';
import {PROOF_LIMIT,PROOF_METADATA_BYTES,PROOF_METADATA_BUDGET,type Objects} from './objects.js';

export type EncodedReviewProof={readonly ref:Readonly<BlobRef>;readonly token:string};
export type EncodedReviewProofBinding={
  reviewId:string;reviewHash:string;writerEpoch:string;targetClientId:string;
  documentId:string;sessionHash:string;expiresAt:number;
};
type Timer={unref():unknown};
type Options={now?:()=>number;monotonicNow?:()=>number;schedule?:(callback:()=>void,delay:number)=>Timer;cancel?:(timer:Timer)=>void};
type Lease={binding:Readonly<EncodedReviewProofBinding>;proofs:readonly EncodedReviewProof[];timer?:Timer;deadline:number;metadataDeadline:number;releaseCoverage:()=>void};
const MAX_LEASES=8,MAX_AGE_MS=30*60*1000;
export const ENCODED_REVIEW_OWNER_GRACE_MS=4000;
const stale=()=>new AssetRejection('STALE_REVISION','ENCODED_REBUILD_REVIEW_REQUIRED');
export const encodedReviewRaw=(ref:Readonly<BlobRef>):boolean=>ref.mediaType==='application/x-ideogram-rgba8'||ref.mediaType==='application/x-ideogram-r16le';
const bindingKey=(b:Readonly<EncodedReviewProofBinding>)=>canonical({reviewId:b.reviewId,reviewHash:b.reviewHash,writerEpoch:b.writerEpoch,targetClientId:b.targetClientId,documentId:b.documentId,sessionHash:b.sessionHash,expiresAt:b.expiresAt});

/** Live, bounded ownership of genuine Objects content-proof tokens. These are
 * not serialized, recreated from roots, or shared across writer instances.
 * hold transfers only the returned tokens after success; take transfers every
 * stored token to its caller, which must release them even if adoption fails. */
export class EncodedReviewProofLeases {
  private readonly leases=new Map<string,Lease>();
  private readonly tokens=new Set<string>();
  private closed=false;
  private readonly now:()=>number;
  private readonly monotonicNow:()=>number;
  private readonly schedule:(callback:()=>void,delay:number)=>Timer;
  private readonly cancel:(timer:Timer)=>void;
  constructor(private readonly objects:Pick<Objects,'proven'|'releaseProof'>,options:Options={}){
    this.now=options.now??Date.now;
    this.monotonicNow=options.monotonicNow??(()=>performance.now());
    this.schedule=options.schedule??((callback,delay)=>setTimeout(callback,delay));
    this.cancel=options.cancel??(timer=>clearTimeout(timer as NodeJS.Timeout));
  }
  inventory(){return {leases:this.leases.size,proofs:this.tokens.size,metadataBytes:this.tokens.size*PROOF_METADATA_BYTES};}
  private validBinding(b:EncodedReviewProofBinding):boolean {
    const now=this.now();return isId(b.reviewId)&&/^sha256:[a-f0-9]{64}$/.test(b.reviewHash)&&isSeq(b.writerEpoch)&&isId(b.targetClientId)&&isId(b.documentId)&&/^[a-f0-9]{64}$/.test(b.sessionHash)&&Number.isSafeInteger(b.expiresAt)&&b.expiresAt>now&&b.expiresAt-now<=MAX_AGE_MS;
  }
  hold(binding:EncodedReviewProofBinding,proofs:readonly EncodedReviewProof[]):ReadonlySet<string>{
    if(this.closed||!this.validBinding(binding)||this.leases.has(binding.reviewId))throw stale();
    const selected:EncodedReviewProof[]=[],refs=new Set<string>(),tokens=new Set<string>();
    for(const proof of proofs){
      if(!encodedReviewRaw(proof.ref))continue;
      // Only Objects can establish a content proof. No database root, file
      // stamp, supplied hash, or caller-created token grants this authority.
      this.objects.proven(proof.ref,proof.token);
      const key=canonical(proof.ref);if(refs.has(key))continue;
      if(tokens.has(proof.token)||this.tokens.has(proof.token))throw stale();
      refs.add(key);tokens.add(proof.token);selected.push(Object.freeze({ref:Object.freeze({...proof.ref}),token:proof.token}));
    }
    if(!selected.length)throw stale();
    const total=this.tokens.size+selected.length;
    if(this.leases.size>=MAX_LEASES||total>PROOF_LIMIT||total*PROOF_METADATA_BYTES>PROOF_METADATA_BUDGET)throw new AssetRejection('CAPACITY','ENCODED_REBUILD_REVIEW_LIMIT');
    const at=this.monotonicNow();if(!Number.isFinite(at))throw stale();
    const metadataDeadline=at+(binding.expiresAt-this.now());
    const lease:Lease={binding:Object.freeze({...binding}),proofs:Object.freeze(selected),metadataDeadline,deadline:Math.min(metadataDeadline,at+ENCODED_REVIEW_OWNER_GRACE_MS),releaseCoverage:adapterResources.uncovered('encoded-review-proof-lease')};
    this.leases.set(binding.reviewId,lease);for(const token of tokens)this.tokens.add(token);
    try{
      this.arm(lease);
    }catch(error){this.detach(binding.reviewId,lease);lease.releaseCoverage();throw error;}
    return tokens;
  }
  private arm(lease:Lease):void {
    if(lease.timer)this.cancel(lease.timer);
    lease.timer=this.schedule(()=>{
      if(this.leases.get(lease.binding.reviewId)!==lease)return;
      const at=this.monotonicNow();
      if(!Number.isFinite(at)||at>=lease.deadline){this.discard(lease.binding.reviewId);return;}
      // Early timer delivery cannot extend the last authenticated deadline.
      try{this.arm(lease);}catch{this.discard(lease.binding.reviewId);}
    },Math.max(0,lease.deadline-this.monotonicNow()));
    lease.timer.unref();
  }
  /** Authenticated public review reads renew only the exact current owner.
   * Delayed timers, a missing lease, or a stale binding cannot revive tokens. */
  renew(binding:EncodedReviewProofBinding):void {
    const lease=this.leases.get(binding.reviewId);if(!lease)throw stale();
    if(bindingKey(binding)!==bindingKey(lease.binding))throw stale();
    const at=this.monotonicNow();
    if(this.closed||!Number.isFinite(at)||at>=lease.deadline||!this.validBinding(binding)){this.discard(binding.reviewId);throw stale();}
    try{
      for(const proof of lease.proofs)this.objects.proven(proof.ref,proof.token);
      lease.deadline=Math.min(lease.metadataDeadline,at+ENCODED_REVIEW_OWNER_GRACE_MS);this.arm(lease);
    }catch{this.discard(binding.reviewId);throw stale();}
  }
  private detach(id:string,lease:Lease):void {
    if(lease.timer)this.cancel(lease.timer);
    this.leases.delete(id);for(const proof of lease.proofs)this.tokens.delete(proof.token);
  }
  take(binding:EncodedReviewProofBinding):readonly EncodedReviewProof[]{
    const lease=this.leases.get(binding.reviewId);if(!lease)throw stale();
    this.detach(binding.reviewId,lease);
    try{
      const at=this.monotonicNow();
      if(this.closed||!Number.isFinite(at)||at>=lease.deadline||!this.validBinding(binding)||bindingKey(binding)!==bindingKey(lease.binding))throw stale();
      for(const proof of lease.proofs)this.objects.proven(proof.ref,proof.token);
      lease.releaseCoverage();return lease.proofs;
    }catch{
      for(const proof of lease.proofs)this.objects.releaseProof(proof.token);
      lease.releaseCoverage();throw stale();
    }
  }
  discard(reviewId:string):boolean {
    const lease=this.leases.get(reviewId);if(!lease)return false;
    this.detach(reviewId,lease);for(const proof of lease.proofs)this.objects.releaseProof(proof.token);lease.releaseCoverage();return true;
  }
  discardDocument(documentId:string):number {
    let released=0;for(const [reviewId,lease] of [...this.leases])if(lease.binding.documentId===documentId&&this.discard(reviewId))released++;return released;
  }
  discardSession(sessionHash:string):number {
    let released=0;for(const [reviewId,lease] of [...this.leases])if(lease.binding.sessionHash===sessionHash&&this.discard(reviewId))released++;return released;
  }
  close():void {this.closed=true;for(const id of [...this.leases.keys()])this.discard(id);}
}
