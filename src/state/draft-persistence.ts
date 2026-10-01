import type { Draft, UICheckpoint, UIReceipt, UIRequest } from '../protocol/ui.js';
import {reservePromptPayload} from '../observability/prompt-memory.js';
import type {AllocationLease} from '../observability/allocations.js';
import {allocationLedger} from '../observability/allocations.js';

type DeliveryJournal={put(key:string,value:unknown):Promise<void>;scan<T>(prefix:string,visit:(value:T)=>void|boolean):Promise<void>};
type SavedDelivery={request:UIRequest;draftId:string;generation:string;done?:boolean};
class RequestValues extends Map<string,SavedDelivery>{
  private leases=new Map<string,AllocationLease>();
  override set(id:string,value:SavedDelivery){
    if(!this.leases.has(id))this.leases.set(id,allocationLedger.reserve({owner:'draft-pending-control',kind:'control',cpuBytes:1024*1024,handles:1}));
    return super.set(id,value);
  }
  override delete(id:string){const removed=super.delete(id);this.leases.get(id)?.release();this.leases.delete(id);return removed;}
  override clear(){super.clear();for(const lease of this.leases.values())lease.release();this.leases.clear();}
  adopt(source:RequestValues){for(const [id,value]of source){if(!this.has(id)){super.set(id,value);this.leases.set(id,source.leases.get(id)!);source.leases.delete(id);}source.delete(id);}}
}
type Transport = (path:string,init?:RequestInit)=>Promise<Response>;
type LocalDraft = Omit<Draft,'assetId'|'status'> & { text:string; savedGeneration:string|null; pending:boolean; error:string|null };
class DraftValues extends Map<string,LocalDraft>{
  private leases=new Map<string,AllocationLease>();
  override set(id:string,draft:LocalDraft){
    const lease=this.leases.get(id),bytes=draft.text.length*2;
    if(lease)lease.resize({cpuBytes:bytes});else this.leases.set(id,reservePromptPayload('draft-retained-text',bytes));
    return super.set(id,draft);
  }
  override delete(id:string){const deleted=super.delete(id);this.leases.get(id)?.release();this.leases.delete(id);return deleted;}
  override clear(){super.clear();for(const lease of this.leases.values())lease.release();this.leases.clear();}
}
// The editor adapter owns native controls. This owner only records current draft
// generations and durable local receipts; it never writes DOM/focus or a document.
export class DraftPersistence {
  private lifetime=0;
  private readLifetime=0;
  private disposed=false;
  private refused=new Map<string,{documentId:string;message:string}>();
  private requests=new RequestValues();
  readonly drafts=new DraftValues();
  checkpoint:UICheckpoint|null=null;
  constructor(readonly sessionId:string,private transport:Transport,private csrf:()=>string,private journal?:DeliveryJournal){}
  async restore(){
    if(this.disposed)throw Error('DRAFT_OWNER_DISPOSED');
    const lifetime=this.lifetime,readLifetime=this.readLifetime,r=await this.transport('/api/v1/ui/'+this.sessionId);if(!r.ok)throw new Error('Draft checkpoint unavailable');
    const checkpoint=await r.json() as UICheckpoint;
    if(lifetime!==this.lifetime||readLifetime!==this.readLifetime)return;
    const restored=new RequestValues();
    try{
      await this.journal?.scan<SavedDelivery>('ui-request:'+this.sessionId+':',item=>{
        if(lifetime!==this.lifetime||readLifetime!==this.readLifetime)return false;
        if(!item.done&&!this.requests.has(item.request.requestId))restored.set(item.request.requestId,item);
      });
      if(lifetime!==this.lifetime||readLifetime!==this.readLifetime)return;
      this.checkpoint=checkpoint;this.requests.adopt(restored);return checkpoint;
    }finally{restored.clear();}
  }
  // The editor chooses its bounded text reader/viewer before loading a draft.
  // No transcript replay eagerly materializes all caption assets in memory.
  async restoreDraft(id:string,read:(assetId:string)=>Promise<string>){
    if(this.disposed)throw Error('DRAFT_OWNER_DISPOSED');
    const lifetime=this.lifetime,readLifetime=this.readLifetime,draft=this.checkpoint?.drafts.find(d=>d.id===id);
    if(!draft)throw new Error('Draft missing');
    if(this.drafts.has(id))return;
    const text=await read(draft.assetId);
    if(lifetime!==this.lifetime||readLifetime!==this.readLifetime||this.drafts.has(id))return;
    this.drafts.set(id,{...draft,text,savedGeneration:draft.generation,pending:false,error:null});
  }
  change(draft:Omit<LocalDraft,'generation'|'savedGeneration'|'pending'|'error'>){
    if(this.disposed)throw Error('DRAFT_OWNER_DISPOSED');
    const old=this.drafts.get(draft.id);const persisted=this.checkpoint?.drafts.find(d=>d.id===draft.id)?.generation??'0';
    const generation=String(BigInt(old?.generation??persisted)+1n);
    const next={...draft,generation,savedGeneration:null,pending:false,error:null};
    try{this.drafts.set(draft.id,next);}catch(error){this.refuseChange(draft.id,draft.documentId);throw error;}
    this.refused.delete(draft.id);return generation;
  }
  // A native control may already own the user's new input when admission is
  // refused. Do not copy it, overwrite the previous generation, or allow Close
  // to mistake that previous saved generation for the refused current input.
  refuseChange(id:string,documentId:string){this.refused.set(id,{documentId,message:'Draft workspace is full. Your new input remains in the editor; revise it or release another preview, then edit again to save. The previous saved draft is retained.'});}
  acceptRetained(id:string,text:string){if(this.drafts.get(id)?.text===text)this.refused.delete(id);}
  get hasRefusedChanges(){return this.refused.size>0;}
  // prepare is the approved caption staging path supplied by the editor owner.
  // Its complete bytes become durable before SaveDraft is submitted.
  async save(id:string,prepare:(text:string)=>Promise<string>){
    if(this.disposed)throw Error('DRAFT_OWNER_DISPOSED');
    const refused=this.refused.get(id);if(refused)throw Error(refused.message);
    if(!this.checkpoint)throw new Error('Load the draft checkpoint first');
    const current=this.drafts.get(id);if(!current)throw new Error('Draft missing');
    for(const [requestId,pending] of this.requests)if(pending.draftId===id)return this.deliver(requestId,this.lifetime);
    let pin:ReturnType<typeof reservePromptPayload>;
    try{pin=reservePromptPayload('draft-save-generation',current.text.length*2);}catch(error){current.pending=false;current.error='Draft workspace is full. Release another preview or revise this input, then edit again to save.';throw error;}
    try{
    const lifetime=this.lifetime,generation=current.generation,text=current.text;current.pending=true;current.error=null;
    let assetId:string;
    try{assetId=await prepare(text);}catch(error){if(this.owns(id,generation,lifetime)){current.pending=false;current.error='Draft bytes were not saved';}throw error;}
    if(!this.owns(id,generation,lifetime))return;
    const {id:draftId,generation:draftGeneration,kind,documentId,targetLayerId,expectedDocumentRevision,composing}=current;
    const draft={id:draftId,generation:draftGeneration,kind,documentId,targetLayerId,expectedDocumentRevision,composing};
    const request:UIRequest={protocolVersion:1,requestId:crypto.randomUUID(),sessionId:this.sessionId,expectedUISeq:this.checkpoint.uiSeq,body:{type:'SaveDraft',draft:{...draft,assetId}}};
    try{this.requests.set(request.requestId,{request,draftId:id,generation});}
    catch(error){if(this.owns(id,generation,lifetime)){current.pending=false;current.error='Draft delivery workspace is full. The current input and previous saved draft are retained.';}throw error;}
    return await this.deliver(request.requestId,lifetime);
    }finally{pin.release();}
  }
  // Unknown delivery is retried under the exact original ID and envelope.
  retry(requestId:string){return this.deliver(requestId,this.lifetime);}
  dispatch(request:UIRequest){
    if(request.sessionId!==this.sessionId)throw Error('UI session changed');
    this.requests.set(request.requestId,{request,draftId:'',generation:'0'});
    return this.deliver(request.requestId,this.lifetime);
  }
  pendingRequests(){return [...this.requests.keys()];}
  assertDocumentSaved(documentId:string){
    const refused=[...this.refused.values()].find(value=>value.documentId===documentId);if(refused)throw Error(refused.message);
    if([...this.drafts.values()].some(d=>d.documentId===documentId&&(d.pending||d.savedGeneration!==d.generation))||
      [...this.requests.values()].some(r=>r.request.body.type==='SaveDraft'&&r.request.body.draft.documentId===documentId||r.draftId&&this.drafts.get(r.draftId)?.documentId===documentId))
      throw Error('Save the current drafts before closing. Unsaved text and original deliveries are retained.');
  }
  releaseDocument(documentId:string){
    this.assertDocumentSaved(documentId);this.readLifetime++;
    for(const [id,draft] of this.drafts)if(draft.documentId===documentId)this.drafts.delete(id);
  }
  private owns(id:string,generation:string,lifetime:number){return this.lifetime===lifetime&&this.drafts.get(id)?.generation===generation;}
  private async deliver(id:string,lifetime:number):Promise<UIReceipt>{
    const pending=this.requests.get(id);if(!pending)throw new Error('Unknown draft delivery');
    try{
      await this.journal?.put('ui-request:'+this.sessionId+':'+id,pending);
      const response=await this.transport('/api/v1/ui/'+this.sessionId,{method:'POST',headers:{'Content-Type':'application/json','X-App-Csrf':this.csrf()},body:JSON.stringify(pending.request)});
      if(!response.ok)throw new Error('Draft receipt unavailable');const receipt=await response.json() as UIReceipt;
      if(receipt.requestId!==id||receipt.protocolVersion!==1||!['accepted','rejected'].includes(receipt.status)||!/^(0|[1-9][0-9]*)$/.test(receipt.uiSeq))throw new Error('Invalid draft receipt');
      await this.journal?.put('ui-request:'+this.sessionId+':'+id,{...pending,done:true});
      this.requests.delete(id);
      if(receipt.status==='accepted'&&pending.request.body.type==='ClearDraft')this.drafts.delete(pending.request.body.draftId);
      if(receipt.status==='accepted'&&pending.request.body.type==='ClearDraft')this.refused.delete(pending.request.body.draftId);
      if(this.lifetime===lifetime&&this.checkpoint&&BigInt(receipt.uiSeq)>BigInt(this.checkpoint.uiSeq))this.checkpoint.uiSeq=receipt.uiSeq;
      if(this.owns(pending.draftId,pending.generation,lifetime)){
        const draft=this.drafts.get(pending.draftId)!;draft.pending=false;
        if(receipt.status==='accepted'){draft.savedGeneration=pending.generation;draft.error=null;}
        else draft.error=receipt.reason??'Draft changed in another view';
      }
      return receipt;
    }catch(error){if(this.owns(pending.draftId,pending.generation,lifetime)){const draft=this.drafts.get(pending.draftId)!;draft.pending=false;draft.error='Draft receipt unknown; retry the original delivery';}throw error;}
  }
  invalidate(){this.lifetime++;for(const draft of this.drafts.values()){draft.generation=String(BigInt(draft.generation)+1n);draft.pending=false;draft.savedGeneration=null;}}
  dispose(){this.disposed=true;this.lifetime++;this.readLifetime++;this.drafts.clear();this.refused.clear();this.requests.clear();this.checkpoint=null;}
}
