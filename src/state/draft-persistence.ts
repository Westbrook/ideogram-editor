import type { Draft, UICheckpoint, UIReceipt, UIRequest } from '../protocol/ui.js';

type Transport = (path:string,init?:RequestInit)=>Promise<Response>;
type LocalDraft = Omit<Draft,'assetId'|'status'> & { text:string; savedGeneration:string|null; pending:boolean; error:string|null };
// The editor adapter owns native controls. This owner only records current draft
// generations and durable local receipts; it never writes DOM/focus or a document.
export class DraftPersistence {
  private lifetime=0;
  private requests=new Map<string,{request:UIRequest;draftId:string;generation:string}>();
  readonly drafts=new Map<string,LocalDraft>();
  checkpoint:UICheckpoint|null=null;
  constructor(readonly sessionId:string,private transport:Transport,private csrf:()=>string){}
  async restore(){
    const lifetime=this.lifetime,r=await this.transport('/api/v1/ui/'+this.sessionId);if(!r.ok)throw new Error('Draft checkpoint unavailable');
    const checkpoint=await r.json() as UICheckpoint;
    if(lifetime!==this.lifetime)return;
    this.checkpoint=checkpoint;
    return checkpoint;
  }
  // The editor chooses its bounded text reader/viewer before loading a draft.
  // No transcript replay eagerly materializes all caption assets in memory.
  async restoreDraft(id:string,read:(assetId:string)=>Promise<string>){
    const lifetime=this.lifetime,draft=this.checkpoint?.drafts.find(d=>d.id===id);
    if(!draft)throw new Error('Draft missing');
    if(this.drafts.has(id))return;
    const text=await read(draft.assetId);
    if(lifetime!==this.lifetime||this.drafts.has(id))return;
    this.drafts.set(id,{...draft,text,savedGeneration:draft.generation,pending:false,error:null});
  }
  change(draft:Omit<LocalDraft,'generation'|'savedGeneration'|'pending'|'error'>){
    const old=this.drafts.get(draft.id);const persisted=this.checkpoint?.drafts.find(d=>d.id===draft.id)?.generation??'0';
    const generation=String(BigInt(old?.generation??persisted)+1n);
    const next={...draft,generation,savedGeneration:null,pending:false,error:null};this.drafts.set(draft.id,next);return generation;
  }
  // prepare is the approved caption staging path supplied by the editor owner.
  // Its complete bytes become durable before SaveDraft is submitted.
  async save(id:string,prepare:(text:string)=>Promise<string>){
    if(!this.checkpoint)throw new Error('Load the draft checkpoint first');
    const current=this.drafts.get(id);if(!current)throw new Error('Draft missing');
    const lifetime=this.lifetime,generation=current.generation,text=current.text;current.pending=true;current.error=null;
    let assetId:string;
    try{assetId=await prepare(text);}catch(error){if(this.owns(id,generation,lifetime)){current.pending=false;current.error='Draft bytes were not saved';}throw error;}
    if(!this.owns(id,generation,lifetime))return;
    const {id:draftId,generation:draftGeneration,kind,documentId,targetLayerId,expectedDocumentRevision,composing}=current;
    const draft={id:draftId,generation:draftGeneration,kind,documentId,targetLayerId,expectedDocumentRevision,composing};
    const request:UIRequest={protocolVersion:1,requestId:crypto.randomUUID(),sessionId:this.sessionId,expectedUISeq:this.checkpoint.uiSeq,body:{type:'SaveDraft',draft:{...draft,assetId}}};
    this.requests.set(request.requestId,{request,draftId:id,generation});
    return this.deliver(request.requestId,lifetime);
  }
  // Unknown delivery is retried under the exact original ID and envelope.
  retry(requestId:string){return this.deliver(requestId,this.lifetime);}
  pendingRequests(){return [...this.requests.keys()];}
  private owns(id:string,generation:string,lifetime:number){return this.lifetime===lifetime&&this.drafts.get(id)?.generation===generation;}
  private async deliver(id:string,lifetime:number):Promise<UIReceipt>{
    const pending=this.requests.get(id);if(!pending)throw new Error('Unknown draft delivery');
    try{
      const response=await this.transport('/api/v1/ui/'+this.sessionId,{method:'POST',headers:{'Content-Type':'application/json','X-App-Csrf':this.csrf()},body:JSON.stringify(pending.request)});
      if(!response.ok)throw new Error('Draft receipt unavailable');const receipt=await response.json() as UIReceipt;
      if(receipt.requestId!==id||receipt.protocolVersion!==1||!['accepted','rejected'].includes(receipt.status)||!/^(0|[1-9][0-9]*)$/.test(receipt.uiSeq))throw new Error('Invalid draft receipt');
      this.requests.delete(id);
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
}
