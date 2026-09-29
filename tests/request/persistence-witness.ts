import {createHash} from 'node:crypto';
export type DraftExpectation={sessionId:string;documentId:string;revision:string;generation:string;prompt:string;operation:string};
// This is a public receipt/checkpoint/content witness, never an application-state hook.
export function savedDraftWitness(expected:DraftExpectation,input:{request:any;receipt:any;checkpoint:any;value:any;content:string;revision:string}){
 const {request,receipt,checkpoint,value,content,revision}=input,draft=request?.body?.draft;
 const require=(condition:unknown,reason:string)=>{if(!condition)throw Error('DRAFT_NOT_SETTLED: '+reason);};
 require(request?.protocolVersion===1&&request?.body?.type==='SaveDraft','SaveDraft request');
 require(request.sessionId===expected.sessionId&&checkpoint?.sessionId===expected.sessionId,'current owner');
 require(checkpoint.preferences?.documentId===expected.documentId&&draft?.documentId===expected.documentId,'current document');
 require(revision===expected.revision&&draft.expectedDocumentRevision===expected.revision,'current revision');
 require(draft.kind==='request'&&draft.targetLayerId===null&&!draft.composing&&draft.generation===expected.generation,'current draft generation');
 require(receipt?.protocolVersion===1&&receipt.requestId===request.requestId&&receipt.status==='accepted','matching accepted receipt');
 require(receipt.uiSeq===checkpoint.uiSeq,'current checkpoint sequence');
 const saved=checkpoint.drafts?.find((d:any)=>d.id===draft.id);
 require(saved&&saved.status==='saved-unapplied','saved draft');
 for(const key of ['id','generation','kind','documentId','targetLayerId','expectedDocumentRevision','assetId','composing'])require(saved[key]===draft[key],'saved '+key);
 require(value?.operation===expected.operation&&value.prompt?.mode==='plain','expected operation and prompt mode');
 require(content===expected.prompt,'exact retained prompt');
 const hash='sha256:'+createHash('sha256').update(expected.prompt).digest('hex');
 require(value.prompt.text.hash===hash&&value.prompt.text.byteLength===String(Buffer.byteLength(expected.prompt))&&value.prompt.text.mediaType==='text/plain','exact retained prompt bytes');
 return {sessionId:expected.sessionId,documentId:expected.documentId,revision,generation:draft.generation,draftId:draft.id,assetId:draft.assetId,requestId:request.requestId,uiSeq:receipt.uiSeq,promptHash:hash,promptBytes:Buffer.byteLength(expected.prompt)};
}

// Same public GET/HEAD construction as the application's session transport.
// Browser-generated fetch metadata and the existing same-origin cookie remain authoritative.
export function publicReadRequest(path:string,method:'GET'|'HEAD'='GET'){
 if(!path.startsWith('/api/v1/')||path.includes('#')||/[\r\n]/.test(path))throw Error('PUBLIC_READ_PATH_REQUIRED');
 return {path,init:{method,headers:{'X-App-Client':'LP-1'},credentials:'same-origin' as const,cache:'no-store' as const,redirect:'error' as const}};
}

type ObservedRequest={sequence:number;request:any;path?:string};
type EditStart={actionId:string;expected:Omit<DraftExpectation,'generation'>;promptBefore:string;checkpoint:any;requestBoundary:number;priorRequests:ObservedRequest[];pendingMutations:number};
type EditBinding={actionId:string;request:any;expected:DraftExpectation;draftId:string;assetId:string;requestId:string;generation:string;firstSequence:number};
// A fresh public draft is the theme fixture's precondition. No native-event count
// predicts its generation: bind the unique original save identity after the edit.
export class CurrentEditBinding{
 private readonly start:EditStart;
 private readonly observed:ObservedRequest[]=[];
 private readonly refusals:{at:string;reason:string}[]=[];
 private actionComplete=false;
 private binding:EditBinding|null=null;
 constructor(start:EditStart){
  this.start=structuredClone(start);const e=this.start.expected,c=this.start.checkpoint;
  if(!start.actionId||start.promptBefore!==''||start.pendingMutations!==0)this.refuse('PRE_ACTION_NOT_SETTLED');
  if(c?.sessionId!==e.sessionId||c.preferences?.documentId!==e.documentId||!Array.isArray(c.drafts)||c.drafts.some((d:any)=>d.kind==='request'&&d.documentId===e.documentId))this.refuse('PRE_ACTION_DRAFT_NOT_FRESH');
  if(start.priorRequests.some(x=>x.path?.startsWith('/api/v1/assets/staging')))this.refuse('PRE_ACTION_STAGING');
  for(const event of start.priorRequests)this.observe(event);
 }
 private refuse(reason:string):never{this.refusals.push({at:new Date().toISOString(),reason});throw Error('EDIT_BINDING_REFUSED: '+reason);}
 observe(event:ObservedRequest){if(event.request?.body?.type==='SaveDraft')this.observed.push(structuredClone(event));}
 completeAction(publicPrompt:string){if(this.actionComplete||publicPrompt!==this.start.expected.prompt)this.refuse('EDIT_ACTION_MISMATCH');this.actionComplete=true;}
 get bound(){return this.binding?structuredClone(this.binding):null;}
 snapshot(){return {start:structuredClone(this.start),actionComplete:this.actionComplete,observed:structuredClone(this.observed),binding:this.bound,refusals:structuredClone(this.refusals)};}
 bind():EditBinding|null{
  if(!this.actionComplete)return null;
  const e=this.start.expected,unique=new Map<string,ObservedRequest>();
  for(const event of this.observed){
   const r=event.request,d=r.body.draft;
   if(event.sequence<=this.start.requestBoundary)this.refuse('STALE_PRE_ACTION_SAVE');
   if(r.protocolVersion!==1||typeof r.requestId!=='string'||!r.requestId||r.sessionId!==e.sessionId||d?.documentId!==e.documentId)this.refuse('SAVE_OWNER_CHANGED');
   if(d.kind!=='request'||d.targetLayerId!==null||d.composing!==false||d.expectedDocumentRevision!==e.revision)this.refuse('SAVE_DRAFT_CONTEXT_CHANGED');
   if(r.expectedUISeq!==this.start.checkpoint.uiSeq||!/^([1-9][0-9]*)$/.test(d.generation)||typeof d.id!=='string'||!d.id||typeof d.assetId!=='string'||!d.assetId||this.start.checkpoint.drafts.some((x:any)=>x.id===d.id))this.refuse('SAVE_IDENTITY_INVALID');
   const prior=unique.get(r.requestId);if(prior&&JSON.stringify(prior.request)!==JSON.stringify(r))this.refuse('REQUEST_ENVELOPE_CHANGED');
   if(!prior)unique.set(r.requestId,event);
  }
  if(unique.size>1)this.refuse('AMBIGUOUS_OR_SUPERSEDING_SAVE');
  if(!unique.size)return null;
  const event=[...unique.values()][0],r=event.request,d=r.body.draft;
  if(this.binding){if(JSON.stringify(this.binding.request)!==JSON.stringify(r))this.refuse('BOUND_IDENTITY_CHANGED');return this.bound;}
  this.binding={actionId:this.start.actionId,request:structuredClone(r),expected:{...e,generation:d.generation},draftId:d.id,assetId:d.assetId,requestId:r.requestId,generation:d.generation,firstSequence:event.sequence};return this.bound;
 }
 assertCurrent(){if(!this.binding)this.refuse('EDIT_NOT_BOUND');this.bind();}
 receipt(receipts:any[]){
  this.assertCurrent();const matches=receipts.filter(r=>r.requestId===this.binding!.requestId);
  if(!matches.length)return null;
  if(matches.some(r=>JSON.stringify(r)!==JSON.stringify(matches[0])))this.refuse('AMBIGUOUS_RECEIPT');
  return structuredClone(matches[0]);
 }
}
