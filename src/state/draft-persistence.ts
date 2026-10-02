import type { Draft, UICheckpoint, UIReceipt, UIRequest } from '../protocol/ui.js';
import type {AllocationLease} from '../observability/allocations.js';
import {allocationLedger} from '../observability/allocations.js';
import {readOwnedJSON,reserveModelBytes,ModelPayload,type OwnedModel} from '../observability/model-memory.js';
import {measureControl,reserveCommandWire} from './control-memory.js';
import {CommandControlReads} from './command-results.js';
import {DraftValues,DraftRegistrations,DRAFT_REFUSAL,nextDraftGeneration,type LocalDraft} from './draft-values.js';

type DeliveryJournal={put(key:string,value:unknown):Promise<void>;scan<T>(prefix:string,visit:(value:T)=>void|boolean):Promise<void>};
type SavedDelivery={request:UIRequest;draftId:string;generation:string;done?:boolean};
class RequestValues extends Map<string,SavedDelivery>{
  private leases=new Map<string,ModelPayload>();
  override set(id:string,value:SavedDelivery){
    if(!this.leases.has(id)){if(this.size>=64)throw Error('DRAFT_DELIVERY_LIMIT');this.leases.set(id,new ModelPayload(allocationLedger.reserve({owner:'draft-pending-control',kind:'control',cpuBytes:1024*1024,handles:1})));}
    return super.set(id,value);
  }
  pin(id:string){const lease=this.leases.get(id);if(!lease)throw Error('Unknown draft delivery');return lease.pin();}
  override delete(id:string){const removed=super.delete(id);this.leases.get(id)?.release();this.leases.delete(id);return removed;}
  override clear(){super.clear();for(const lease of this.leases.values())lease.release();this.leases.clear();}
  validateAdoption(source:RequestValues){let count=this.size;for(const id of source.keys())if(!this.has(id))count++;if(count>64)throw Error('DRAFT_DELIVERY_LIMIT');}
  adopt(source:RequestValues){this.validateAdoption(source);for(const [id,value]of source){if(!this.has(id)){super.set(id,value);this.leases.set(id,source.leases.get(id)!);source.leases.delete(id);}source.delete(id);}}
}
type Transport = (path:string,init?:RequestInit)=>Promise<Response>;
// The editor adapter owns native controls. This owner only records current draft
// generations and durable local receipts; it never writes DOM/focus or a document.
export class DraftPersistence {
  private lifetime=0;
  private readLifetime=0;
  private disposed=false;
  private registrations=new DraftRegistrations();
  private refused=this.registrations;
  private requests=new RequestValues();
  readonly drafts=new DraftValues(this.registrations);
  private checkpointModel?:OwnedModel<UICheckpoint>;
  private checkpointModels=new WeakMap<UICheckpoint,OwnedModel<UICheckpoint>>();
  private reads=new CommandControlReads();private saves=new Set<Promise<unknown>>();private restoreSerial=0;private drain?:Promise<void>;
  get checkpoint(){return this.checkpointModel?.value??null;}
  set checkpoint(value:UICheckpoint|null){
    if(value===this.checkpoint)return;
    if(!value){const old=this.checkpointModel;this.checkpointModel=undefined;old?.release();return;}
    const measured=measureControl(value,65536);
    if(typeof value.uiSeq!=='string'||value.uiSeq.length>128||!/^(0|[1-9][0-9]*)$/.test(value.uiSeq))throw Error('UI_CHECKPOINT_SEQUENCE');
    // Local receipts advance only uiSeq, bounded to 128 units. Reserve that
    // scalar's maximum growth before publishing the mutable checkpoint root.
    const payload=reserveModelBytes('draft-checkpoint-model',measured.logicalBytes+256,1);let next:OwnedModel<UICheckpoint>;
    try{const copy=structuredClone(value);next=Object.freeze({value:copy,release:()=>payload.release(),pin:()=>payload.pin()});}catch(error){payload.release();throw error;}
    const old=this.checkpointModel;this.checkpointModels.set(next.value,next);this.checkpointModel=next;old?.release();
  }
  borrowCheckpoint(value:UICheckpoint=this.checkpoint!):OwnedModel<UICheckpoint>{const model=this.checkpointModels.get(value);if(!model)throw Error('UI_CHECKPOINT_UNOWNED');return {value:model.value,release:model.pin(),pin:()=>model.pin()};}
  pinCheckpoint(value:UICheckpoint|null=this.checkpoint){return value?this.borrowCheckpoint(value).release:()=>{};}
  get ownership(){return {...this.reads.ownership,pendingSaves:this.saves.size,checkpointModels:this.checkpointModel?1:0};}
  get metadataOwnership(){return {...this.registrations.inspect(),...this.drafts.inspect()};}
  release(){return this.reads.release();}
  constructor(readonly sessionId:string,private transport:Transport,private csrf:()=>string,private journal?:DeliveryJournal){}
  registerDraft(id:string,documentId:string){if(this.disposed)throw Error('DRAFT_OWNER_DISPOSED');return this.registrations.register(id,documentId);}
  async restore(){
    if(this.disposed)throw Error('DRAFT_OWNER_DISPOSED');
    const lifetime=this.lifetime,readLifetime=this.readLifetime,serial=++this.restoreSerial;
    return this.reads.run(async signal=>{
      const current=()=>!signal.aborted&&!this.disposed&&lifetime===this.lifetime&&readLifetime===this.readLifetime&&serial===this.restoreSerial;
      const model=await readOwnedJSON<UICheckpoint>(this.transport,'/api/v1/ui/'+this.sessionId,{owner:'draft-checkpoint-response',maxBytes:65536,init:{signal},owns:current}),restored=new RequestValues();
      try{if(!current())return;const checkpoint=model.value;if(!checkpoint||checkpoint.sessionId!==this.sessionId||!Array.isArray(checkpoint.drafts)||!checkpoint.preferences)throw Error('UI_CHECKPOINT_UNAVAILABLE');
        await this.journal?.scan<SavedDelivery>('ui-request:'+this.sessionId+':',item=>{if(!current())return false;if(!item.done&&!this.requests.has(item.request.requestId))restored.set(item.request.requestId,item);});
        if(!current())return;this.requests.validateAdoption(restored);this.checkpoint=checkpoint;this.requests.adopt(restored);return this.checkpoint!;
      }finally{restored.clear();model.release();}
    });
  }
  // The editor chooses its bounded text reader/viewer before loading a draft.
  // No transcript replay eagerly materializes all caption assets in memory.
  async restoreDraft(id:string,read:(assetId:string)=>Promise<string>){
    if(this.disposed)throw Error('DRAFT_OWNER_DISPOSED');
    const lifetime=this.lifetime,readLifetime=this.readLifetime,checkpoint=this.checkpoint,release=this.pinCheckpoint(checkpoint);
    try{const draft=checkpoint?.drafts.find(d=>d.id===id);if(!draft)throw new Error('Draft missing');
      if(this.drafts.has(id))return;const generation=draft.generation,assetId=draft.assetId,fence=reserveModelBytes('draft-restore-identity',(generation.length+assetId.length)*2,1);
      try{const text=await read(assetId);
        if(lifetime!==this.lifetime||readLifetime!==this.readLifetime||this.drafts.has(id)||this.checkpoint!==checkpoint||checkpoint?.drafts.find(value=>value.id===id)!==draft||draft.generation!==generation||draft.assetId!==assetId)return;
        this.drafts.set(id,{...draft,text,savedGeneration:generation,pending:false,error:null});
      }finally{fence.release();}
    }finally{release();}
  }
  change(draft:Omit<LocalDraft,'generation'|'savedGeneration'|'pending'|'error'>){
    if(this.disposed)throw Error('DRAFT_OWNER_DISPOSED');
    const release=this.registrations.attachRow(draft.id,draft.documentId);let workspace:AllocationLease|undefined;
    try{const old=this.drafts.get(draft.id),persisted=this.checkpoint?.drafts.find(d=>d.id===draft.id)?.generation??'0';
      workspace=allocationLedger.reserve({owner:'draft-generation-work',kind:'control',cpuBytes:128*6,handles:1});const generation=nextDraftGeneration(old?.generation??persisted);
      this.drafts.set(draft.id,{...draft,generation,savedGeneration:null,pending:false,error:null});this.refused.delete(draft.id);return generation;
    }catch(error){this.refuseChange(draft.id,draft.documentId);throw error;}finally{workspace?.release();release();}
  }
  // A native control may already own the user's new input when admission is
  // refused. Do not copy it, overwrite the previous generation, or allow Close
  // to mistake that previous saved generation for the refused current input.
  refuseChange(id:string,documentId:string){this.registrations.refuse(id,documentId);}
  acceptRetained(id:string,text:string){if(this.drafts.get(id)?.text===text)this.refused.delete(id);}
  get hasRefusedChanges(){return this.refused.size>0;}
  // prepare is the approved caption staging path supplied by the editor owner.
  // Its complete bytes become durable before SaveDraft is submitted.
  async save(id:string,prepare:(text:string)=>Promise<string>){
    if(this.disposed)throw Error('DRAFT_OWNER_DISPOSED');
    const refused=this.refused.get(id);if(refused)throw Error(DRAFT_REFUSAL);
    if(!this.checkpoint)throw new Error('Load the draft checkpoint first');
    const current=this.drafts.get(id);if(!current)throw new Error('Draft missing');
    for(const [requestId,pending] of this.requests)if(pending.draftId===id)return this.deliver(requestId,this.lifetime);
    let pin:OwnedModel<LocalDraft>;
    try{pin=this.drafts.borrow(id);}catch(error){current.pending=false;current.error='Draft workspace is full. Release another preview or revise this input, then edit again to save.';throw error;}
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
  ownedSave(id:string,prepare:(text:string)=>Promise<string>){
    if(this.disposed)throw Error('DRAFT_OWNER_DISPOSED');if(this.saves.size>=8)throw Error('DRAFT_SAVE_LIMIT');const lease=reserveModelBytes('draft-save-operation',1024,2);
    const task=this.saveOwned(id,prepare).finally(()=>{this.saves.delete(task);lease.release();});this.saves.add(task);return task;
  }
  private async saveOwned(id:string,prepare:(text:string)=>Promise<string>){
    if(this.disposed)throw Error('DRAFT_OWNER_DISPOSED');
    const refused=this.refused.get(id);if(refused)throw Error(DRAFT_REFUSAL);
    if(!this.checkpoint)throw new Error('Load the draft checkpoint first');
    const current=this.drafts.get(id);if(!current)throw new Error('Draft missing');
    for(const [requestId,pending] of this.requests)if(pending.draftId===id)return this.deliverOwned(requestId,this.lifetime);
    let pin:OwnedModel<LocalDraft>;
    try{pin=this.drafts.borrow(id);}catch(error){current.pending=false;current.error='Draft workspace is full. Release another preview or revise this input, then edit again to save.';throw error;}
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
    return await this.deliverOwned(request.requestId,lifetime);
    }finally{pin.release();}
  }
  // Unknown delivery is retried under the exact original ID and envelope.
  retry(requestId:string){return this.deliver(requestId,this.lifetime);}
  dispatch(request:UIRequest){
    if(request.sessionId!==this.sessionId)throw Error('UI session changed');
    this.requests.set(request.requestId,{request,draftId:'',generation:'0'});
    return this.deliver(request.requestId,this.lifetime);
  }
  get hasPendingRequests(){return this.requests.size>0;}
  ownedRetry(requestId:string){return this.deliverOwned(requestId,this.lifetime);}
  ownedDispatch(request:UIRequest){
    if(this.disposed)throw Error('DRAFT_OWNER_DISPOSED');if(request.sessionId!==this.sessionId)throw Error('UI session changed');
    const wire=reserveCommandWire(request);try{this.requests.set(wire.request.requestId,{request:wire.request,draftId:'',generation:'0'});}finally{wire.release();}
    return this.deliverOwned(request.requestId,this.lifetime);
  }
  pendingRequests(){return [...this.requests.keys()];}
  assertDocumentSaved(documentId:string){
    this.registrations.assertSaved(documentId);
    for(const draft of this.drafts.values())if(draft.documentId===documentId&&(draft.pending||draft.savedGeneration!==draft.generation))throw Error('Save the current drafts before closing. Unsaved text and original deliveries are retained.');
    for(const request of this.requests.values())if(request.request.body.type==='SaveDraft'&&request.request.body.draft.documentId===documentId||request.draftId&&this.drafts.get(request.draftId)?.documentId===documentId)throw Error('Save the current drafts before closing. Unsaved text and original deliveries are retained.');
  }
  releaseDocument(documentId:string){
    this.assertDocumentSaved(documentId);this.readLifetime++;
    for(const [id,draft] of this.drafts)if(draft.documentId===documentId)this.drafts.delete(id);
  }
  private owns(id:string,generation:string,lifetime:number){return this.lifetime===lifetime&&this.drafts.get(id)?.generation===generation;}
  private async deliverOwned(id:string,lifetime:number):Promise<OwnedModel<UIReceipt>>{
    return this.reads.run(async signal=>{
    const pending=this.requests.get(id);if(!pending)throw new Error('Unknown draft delivery');
    const unpin=this.requests.pin(id);let wire:ReturnType<typeof reserveCommandWire<UIRequest>>|undefined;let model:OwnedModel<UIReceipt>|undefined,returned=false;
    try{
      wire=reserveCommandWire(pending.request);
      await this.journal?.put('ui-request:'+this.sessionId+':'+id,pending);
      model=await readOwnedJSON<UIReceipt>(this.transport,'/api/v1/ui/'+this.sessionId,{owner:'draft-receipt-response',maxBytes:65536,init:{method:'POST',headers:{'Content-Type':'application/json','X-App-Csrf':this.csrf()},body:wire.wire,signal}});
      const receipt=model.value;if(!receipt||receipt.requestId!==id||receipt.protocolVersion!==1||!['accepted','rejected'].includes(receipt.status)||typeof receipt.uiSeq!=='string'||receipt.uiSeq.length>128||!/^(0|[1-9][0-9]*)$/.test(receipt.uiSeq))throw Error('Invalid draft receipt');
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
      returned=true;return model;
    }catch(error){if(this.owns(pending.draftId,pending.generation,lifetime)){const draft=this.drafts.get(pending.draftId)!;draft.pending=false;draft.error='Draft receipt unknown; retry the original delivery';}throw error;}finally{wire?.release();unpin();if(!returned)model?.release();}
    });
  }
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
  invalidate(){this.drafts.invalidate();this.lifetime++;}
  dispose(){if(!this.disposed){this.disposed=true;this.lifetime++;this.readLifetime++;this.restoreSerial++;this.drafts.clear();this.refused.clear();this.registrations.dispose();this.requests.clear();this.checkpoint=null;}return this.drain??=(async()=>{const reads=this.reads.release();void reads.catch(()=>{});await Promise.allSettled([...this.saves]);await this.registrations.drain();await reads;})().finally(()=>{this.drain=undefined;});}
}
