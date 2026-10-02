import type {LitElement} from 'lit';
import type {EditorClient} from '../state/editor-client.js';
import {createOwnedModel,modelPayloadBytes,reserveModelBytes,type OwnedModel,type ModelPayload} from '../observability/model-memory.js';
import {UIModelOwner} from './model-owner.js';

export const REQUEST_NAVIGATION_LIMITS=Object.freeze({pages:256,pageBytes:8*1024**2,history:1024,historyBytes:65536,announcements:8192,announcementBytes:2*1024**2,files:256,fileMetadataBytes:256*1024});
export type CandidatePageLocation=Readonly<{cursor:string;back:readonly string[]}>;
export type CandidatePageProposal={cursor:string;back:readonly string[];take?:number;last?:string};

function candidateLocation(proposal:CandidatePageProposal){
 const {cursor,back,last}=proposal,take=proposal.take??back.length;
 if(typeof cursor!=='string'||cursor.length>16384||!Number.isSafeInteger(take)||take<0||take>back.length)throw Error('REQUEST_NAVIGATION_HISTORY_LIMIT');
 const length=take+(last===undefined?0:1);let bytes=cursor.length*2+(last===undefined?0:last.length*2);
 if(length>REQUEST_NAVIGATION_LIMITS.history)throw Error('REQUEST_NAVIGATION_HISTORY_LIMIT');
 for(let index=0;index<take;index++){if(typeof back[index]!=='string')throw Error('REQUEST_NAVIGATION_HISTORY_LIMIT');bytes+=back[index]!.length*2;if(bytes>REQUEST_NAVIGATION_LIMITS.historyBytes)throw Error('REQUEST_NAVIGATION_HISTORY_LIMIT');}
 if(bytes>REQUEST_NAVIGATION_LIMITS.historyBytes)throw Error('REQUEST_NAVIGATION_HISTORY_LIMIT');
 return createOwnedModel<CandidatePageLocation>('request-candidate-location',bytes+128,()=>{const history:string[]=[];for(let index=0;index<take;index++)history.push(back[index]!);if(last!==undefined)history.push(last);return {cursor,back:history};});
}

/** Parsed result pages remain owned through both active actions and the next
 * actual render commit. Only the current queue/history page is retained: the
 * durable writer remains the authority for older pages and exact candidates. */
export class RequestNavigationMemory {
 readonly controls:UIModelOwner;readonly candidates:UIModelOwner;readonly prompts:UIModelOwner;readonly files:UIModelOwner;
 private entries=new Map<string,{bytes:number;location:CandidatePageLocation}>();private bytes=0;private candidateRevision=0;private fileSizes=new Map<string,number>();private fileBytes=0;
 private candidateReads=new Map<string,{navigation:boolean}>();private pendingCandidateReads=new Set<object>();
 constructor(host:LitElement,editor:EditorClient){
  this.controls=new UIModelOwner(host,editor,'request-navigation','control',{slots:32});
  this.candidates=new UIModelOwner(host,editor,'request-result-pages','control',{slots:REQUEST_NAVIGATION_LIMITS.pages});
  this.prompts=new UIModelOwner(host,editor,'request-prompt-page','prompt');
  this.files=new UIModelOwner(host,editor,'request-repair-files','control',{slots:REQUEST_NAVIGATION_LIMITS.files});
 }
 get lifecycle(){return {controls:this.controls.lifecycle,candidates:this.candidates.lifecycle,prompts:this.prompts.lifecycle,candidatePages:this.entries.size,candidateBytes:this.bytes,candidateReads:this.pendingCandidateReads.size,files:this.files.lifecycle,fileBytes:this.fileBytes};}
 run<T>(work:()=>T|Promise<T>){const unpin=this.hold();return Promise.resolve().then(work).finally(unpin);}
 hold(){const releases:Array<()=>void>=[];try{releases.push(this.controls.hold());releases.push(this.candidates.hold());releases.push(this.prompts.hold());releases.push(this.files.hold());}catch(error){for(const release of releases)release();throw error;}let live=true;return ()=>{if(live){live=false;for(const release of releases)release();}};}
 candidatePage(key:string):CandidatePageLocation|undefined{return this.entries.get(key)?.location;}
 candidatePending(key:string){return this.candidateReads.has(key);}
 candidateNavigating(key:string){return this.candidateReads.get(key)?.navigation??false;}
 beginCandidateRead(key:string,navigation=false){
  if(key.length>256||this.pendingCandidateReads.size>=8||this.candidates.releasing)throw Error('REQUEST_CANDIDATE_READ_LIMIT');
  const payload=reserveModelBytes('request-candidate-read-generation',key.length*2+32),token={navigation};let live=true;
  this.candidateReads.set(key,token);this.pendingCandidateReads.add(token);
  return {current:()=>live&&this.candidateReads.get(key)===token,close:()=>{if(!live)return;live=false;if(this.candidateReads.get(key)===token)this.candidateReads.delete(key);this.pendingCandidateReads.delete(token);payload.release();}};
 }
 /** The caller still owns model until commit succeeds. Preparing navigation
  * and the RequestEdits index first makes the two publications all-or-nothing.
  * Commit performs no new admission, and refuses an intervening page change. */
 prepareCandidate(key:string,model:OwnedModel<unknown>,proposal?:CandidatePageProposal){
  if(key.length>256||this.candidates.releasing)throw Error('REQUEST_RESULT_ID_LIMIT');
  const existing=this.entries.get(key),prior=existing?.location;
  const location=candidateLocation(proposal??{cursor:prior?.cursor??'',back:prior?.back??[]});
  let metadata:ModelPayload|undefined,closed=false,committed=false;
  try{
   const bytes=modelPayloadBytes(model.value)+modelPayloadBytes(location.value)+key.length*4+16,previous=existing?.bytes??0;
   if(!existing&&this.entries.size>=REQUEST_NAVIGATION_LIMITS.pages||bytes>REQUEST_NAVIGATION_LIMITS.pageBytes-(this.bytes-previous))throw Error('REQUEST_RESULT_PAGE_LIMIT');
   metadata=reserveModelBytes('request-result-index',key.length*4+16);const indexOwner=metadata,revision=this.candidateRevision;
   const wrapped:OwnedModel<unknown>=Object.freeze({value:model.value,release(){try{model.release();}finally{try{location.release();}finally{indexOwner.release();}}},pin(){const pins:Array<()=>void>=[];try{pins.push(model.pin());pins.push(location.pin());pins.push(indexOwner.pin());}catch(error){for(const unpin of pins)unpin();throw error;}return ()=>{for(const unpin of pins)unpin();};}});
   return {location:location.value,commit:()=>{if(closed||revision!==this.candidateRevision||this.candidates.releasing)throw Error('REQUEST_RESULT_PAGE_CHANGED');this.candidates.replace(key,wrapped);this.entries.set(key,{bytes,location:location.value});this.bytes+=bytes-previous;this.candidateRevision++;closed=committed=true;},release:()=>{if(closed)return;closed=true;location.release();indexOwner.release();}};
  }catch(error){if(!committed){location.release();metadata?.release();}throw error;}
 }
 adoptCandidate(key:string,model:OwnedModel<unknown>){const proposal=this.prepareCandidate(key,model);try{proposal.commit();}finally{proposal.release();}}
 clearCandidate(key:string){const entry=this.entries.get(key);this.candidateReads.delete(key);if(entry===undefined)return;this.entries.delete(key);this.bytes-=entry.bytes;this.candidateRevision++;this.candidates.clear(key);}
 clearCandidates(){this.entries.clear();this.candidateReads.clear();this.bytes=0;this.candidateRevision++;this.candidates.clearAll();}
 adoptFile(key:string,file:File){
  const metadata={id:key,name:file.name,type:file.type,size:file.size,lastModified:file.lastModified},bytes=modelPayloadBytes(metadata),previous=this.fileSizes.get(key)??0;
  if(key.length>256||!this.fileSizes.has(key)&&this.fileSizes.size>=REQUEST_NAVIGATION_LIMITS.files||bytes>REQUEST_NAVIGATION_LIMITS.fileMetadataBytes-(this.fileBytes-previous))throw Error('REQUEST_REPAIR_METADATA_LIMIT');
  const model=this.files.model(file,REQUEST_NAVIGATION_LIMITS.fileMetadataBytes,metadata,1);try{this.files.replace(key,model);}catch(error){model.release();throw error;}this.fileSizes.set(key,bytes);this.fileBytes+=bytes-previous;
 }
 clearFile(key:string){const bytes=this.fileSizes.get(key);if(bytes===undefined)return;this.fileSizes.delete(key);this.fileBytes-=bytes;this.files.clear(key);}
 clearFiles(){this.fileSizes.clear();this.fileBytes=0;this.files.clearAll();}
 async release(){this.clearCandidates();this.clearFiles();const results=await Promise.allSettled([this.controls.release(),this.candidates.release(),this.prompts.release(),this.files.release()]);const errors=results.filter((r):r is PromiseRejectedResult=>r.status==='rejected').map(r=>r.reason);if(errors.length)throw new AggregateError(errors,'REQUEST_NAVIGATION_RELEASE_INCOMPLETE');}
}

export function navigationHistory(values:readonly string[],last?:string,take=values.length){
 if(!Number.isSafeInteger(take)||take<0||take>values.length)throw Error('REQUEST_NAVIGATION_HISTORY_LIMIT');
 const length=take+(last===undefined?0:1);let bytes=last===undefined?0:last.length*2;
 if(length>REQUEST_NAVIGATION_LIMITS.history)throw Error('REQUEST_NAVIGATION_HISTORY_LIMIT');
 for(let index=0;index<take;index++){bytes+=values[index]!.length*2;if(bytes>REQUEST_NAVIGATION_LIMITS.historyBytes)throw Error('REQUEST_NAVIGATION_HISTORY_LIMIT');}
 if(bytes>REQUEST_NAVIGATION_LIMITS.historyBytes)throw Error('REQUEST_NAVIGATION_HISTORY_LIMIT');
 return createOwnedModel('request-queue-history',bytes,()=>{const result:string[]=[];for(let index=0;index<take;index++)result.push(values[index]!);if(last!==undefined)result.push(last);return result;});
}

/** The map is never rendered or handed to asynchronous consumers. A caller
 * separately owns any text it publishes; updates admit before mutating this map. */
export class BoundedAnnouncementMap extends Map<string,string> {
 private payload:ModelPayload|undefined;private bytes=0;
 override set(key:string,value:string){
  const previous=this.get(key),next=this.bytes+(key.length+value.length)*2-(previous===undefined?0:(key.length+previous.length)*2);
  if(!this.has(key)&&this.size>=REQUEST_NAVIGATION_LIMITS.announcements||next>REQUEST_NAVIGATION_LIMITS.announcementBytes)throw Error('REQUEST_ANNOUNCEMENT_LIMIT');
  if(this.payload)this.payload.resize(next);else this.payload=reserveModelBytes('request-announcement-cache',next);
  super.set(key,value);this.bytes=next;return this;
 }
 override delete(key:string){const prior=this.get(key);if(prior===undefined)return false;const removed=super.delete(key);this.bytes-=(key.length+prior.length)*2;if(this.size)this.payload?.resize(this.bytes);else{this.payload?.release();this.payload=undefined;}return removed;}
 override clear(){super.clear();this.bytes=0;this.payload?.release();this.payload=undefined;}
}
