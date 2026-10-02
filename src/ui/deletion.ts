import {html,nothing} from 'lit';
import type {LitElement} from 'lit';
import type {EditorClient} from '../state/editor-client.js';
import type {QueueJob} from '../protocol/queue.js';
import type {DeletionPlan,DeletionReceipt} from '../protocol/deletion.js';
import {ControlAdapter} from './adapters.js';
import {UIModelOwner} from './model-owner.js';
type Owner={session:EditorClient['session'];identity:string|null;lifetime:number;draftOwner:EditorClient['draftOwner'];documentId:string|undefined;revision:string|undefined};
type Action=Owner&{token:number;deleting:string|null;deleted:string|null};
const deletionIdentity=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
function deletionPath(documentId:string,after?:string){if(!deletionIdentity(documentId)||after!==undefined&&after!==''&&!deletionIdentity(after))throw Error('Deletion identity is unavailable.');return '/api/v1/documents/'+documentId+'/deletion'+(after===undefined?'':'?after='+encodeURIComponent(after));}
/** Each asynchronous operation and retained control belongs to its original owner. */
export class DocumentDeletion {
 private receipts:DeletionReceipt[]=[];private next:string|null=null;private jobs:QueueJob[]=[];private nextJob:string|null=null;private risk:QueueJob|null=null;
 private adapter=new ControlAdapter();private plan:DeletionPlan|null=null;private receipt:DeletionReceipt|null=null;private busy=false;private message='';private lifetime=0;private composing=false;
 private stateOwner:Owner|null=null;private active:Action|null=null;private generation=0;private planReady=false;private models:UIModelOwner;
 constructor(private host:LitElement,private editor:EditorClient,private composition:()=>boolean=()=>false){this.models=new UIModelOwner(host,editor,'deletion-ui-model');}
 dispose(){this.lifetime++;this.adapter.invalidate();this.invalidate();return this.models.release();}
 get lifecycle(){return this.models.lifecycle;}
 private changed(){this.host.requestUpdate();}
 private capture():Owner{const session=this.editor.session,d=this.editor.view.document;return {session,identity:session.identity(),lifetime:this.lifetime,draftOwner:this.editor.draftOwner,documentId:d?.id,revision:d?.revision};}
 private sameOwner(c:Owner){return c.session===this.editor.session&&c.identity===c.session.identity()&&c.lifetime===this.lifetime&&c.draftOwner===this.editor.draftOwner;}
 private selection(c:Owner){const d=this.editor.view.document;return c.documentId===d?.id&&c.revision===d?.revision;}
 private ready(){return !this.models.releasing&&!this.composing&&!this.composition()&&!this.editor.draftOwner?.hasRefusedChanges&&![...(this.editor.draftOwner?.drafts.values()??[])].some(d=>d.pending||d.composing||d.generation!==d.savedGeneration);}
 private invalidate(){const hadReview=!!(this.message||this.active||this.plan||this.receipt||this.receipts.length||this.jobs.length);this.generation++;this.active=null;this.busy=false;this.plan=null;this.planReady=false;this.receipt=null;this.receipts=[];this.jobs=[];this.next=null;this.nextJob=null;this.risk=null;this.message=hadReview?'Deletion view changed. Review the current document or retained receipts again.':'';this.stateOwner=null;this.models.clearAll();}
 private syncOwner(){
  const c=this.stateOwner,a=this.active;
  // A matching command may publish deletion before its promise returns. Keep
  // it busy, but only its acknowledged event can authorize subsequent reads.
  const pendingNull=a&&this.sameOwner(a)&&!this.editor.view.document&&(a.deleting===a.documentId||a.deleted===a.documentId);
  if(c&&(!this.sameOwner(c)||!this.ready()||!this.selection(c)&&!pendingNull))this.invalidate();
  if(!this.stateOwner)this.stateOwner=this.capture();
 }
 private current(c:Action){return this.active===c&&this.sameOwner(c)&&this.ready()&&(this.selection(c)||c.deleted===c.documentId&&c.deleted!==null&&!this.editor.view.document);}
 private action(event:Event,owner:Owner,generation:number,pending:string,work:(c:Action)=>Promise<void>){
  if(this.editor.draftOwner?.hasRefusedChanges)this.syncOwner();
  if(generation!==this.generation||!this.sameOwner(owner)||!this.selection(owner)||!this.ready()||this.busy)return;
  let unpin:()=>void;try{unpin=this.models.hold();}catch{this.message='The local workspace cannot admit another deletion action. Your previous view is retained.';this.changed();return;}let settled=false;
  this.adapter.action(event,()=>{
   settled=true;this.syncOwner();if(generation!==this.generation||!this.sameOwner(owner)||!this.selection(owner)||!this.ready()||this.busy){unpin();return;}
   const c:Action={...owner,token:++this.generation,deleting:null,deleted:null};this.active=c;this.busy=true;this.message=pending;this.models.clear('feedback');this.changed();
   let task:Promise<void>;try{task=this.models.run(()=>work(c));}catch(error){task=Promise.reject(error);}
   void task.catch(error=>{if(this.current(c)){const message=String(error)+'. Review a fresh deletion preview before confirming.';try{const model=this.models.model(message,65536);this.models.replace('feedback',model);this.message=message;}catch{this.message='The local workspace could not admit this view. Your previous view is retained; review a fresh deletion preview before confirming.';}}}).finally(()=>{
    if(this.active!==c)return;
    if(!this.current(c))this.invalidate();else{if(c.deleted&&!this.editor.view.document)this.stateOwner={...c,documentId:undefined,revision:undefined};this.active=null;this.busy=false;}
    this.changed();
   }).finally(unpin);
  });setTimeout(()=>{if(!settled)unpin();},0);
 }
 private async preview(c:Action){
  const d=this.editor.view.document;if(!d||!this.current(c))return;
  this.planReady=false;
  await this.editor.withCommandEvents({type:'PreviewDocumentDeletion',documentId:d.id,expectedRevision:d.revision},()=>undefined,null);if(!this.current(c))return;
  const model=await this.models.read<{plan:DeletionPlan}>(deletionPath(d.id),()=>this.current(c),4*1024**2);let adopted=false;
  try{if(!this.current(c))return;if(!model.value.plan)throw Error('Deletion preview is unavailable.');this.models.replace('plan',model);adopted=true;this.plan=model.value.plan;this.planReady=true;this.message='Review the affected history and retained bytes. No document has been deleted.';}finally{if(!adopted)model.release();}
 }
 private async confirm(plan:DeletionPlan,c:Action){
  if(this.plan!==plan||!this.planReady||!this.current(c)||plan.documentId!==c.documentId||plan.documentRevision!==c.revision)return;
  this.planReady=false;c.deleting=plan.documentId;
  await this.editor.withCommandEvents({type:'DeleteDocument',documentId:plan.documentId,planId:plan.id,planHash:plan.planHash,expectedRevision:plan.documentRevision,rootGeneration:plan.rootGeneration,acknowledgeRunningAndUncertain:true},async events=>{
  if(this.active!==c||!this.sameOwner(c)||!this.ready()||!this.selection(c)&&this.editor.view.document!==null)return;
  if(!events.some(e=>e.type==='DocumentDeleted'&&e.payload.id===plan.documentId))throw Error('Deletion acknowledgement unavailable; inspect the retained receipt before another action');
  c.deleted=plan.documentId;c.deleting=null;if(!this.current(c))return;
  this.plan=null;this.models.clear('plan');const model=await this.models.read<{receipt:DeletionReceipt}>(deletionPath(plan.documentId),()=>this.current(c),4*1024**2);
  try{if(!this.current(c))return;await this.inspect(model.value.receipt,c);}finally{model.release();}if(!this.current(c))return;
  this.message=this.receipt?.status==='cleanup-complete'?'Document deleted; retained receipt reports cleanup complete.':'Document deleted; cleanup pending. No space has been claimed as freed.';
  },null);
 }
 private async collect(receipt:DeletionReceipt,c:Action){
  if(this.receipt!==receipt||!this.current(c))return;
  await this.editor.withCommandEvents({type:'CollectDocumentGarbage',documentId:receipt.documentId},()=>undefined,null);if(!this.current(c))return;
  const model=await this.models.read<{receipt:DeletionReceipt}>(deletionPath(receipt.documentId),()=>this.current(c),4*1024**2);let adopted=false;
  try{if(!this.current(c))return;this.models.replace('receipt',model);adopted=true;this.receipt=model.value.receipt;this.message=this.receipt.status==='cleanup-complete'?'Document cleanup complete.':'Document deleted; cleanup pending while bytes are in use.';}finally{if(!adopted)model.release();}
 }
 private async list(c:Action,after=''){
  if(!this.current(c))return;if(after&&!deletionIdentity(after))throw Error('Deletion cursor is unavailable.');const model=await this.models.read<{items:DeletionReceipt[];next:string|null}>('/api/v1/deletions?after='+encodeURIComponent(after),()=>this.current(c));let adopted=false;
  try{if(!this.current(c))return;const page=model.value;if(!Array.isArray(page.items)||page.items.length>20||page.next!==null&&!deletionIdentity(page.next)||page.items.some(item=>!deletionIdentity(item.documentId)))throw Error('Deletion receipt page is unavailable.');this.models.replace('receipts',model);adopted=true;this.receipts=page.items;this.next=page.next;this.message='Retained deletion receipts are available below.';}finally{if(!adopted)model.release();}
 }
 private async inspect(receipt:DeletionReceipt,c:Action,after=''){
  if(!this.current(c))return;const model=await this.models.read<{receipt:DeletionReceipt;jobs:QueueJob[];next:string|null}>(deletionPath(receipt.documentId,after),()=>this.current(c),4*1024**2);let adopted=false;
  try{if(!this.current(c))return;const q=model.value;if(!Array.isArray(q.jobs)||q.jobs.length>20||q.next!==null&&!deletionIdentity(q.next))throw Error('Deleted request page is unavailable.');this.models.replace('detail',model);adopted=true;this.models.clear('receipt');this.receipt=q.receipt;this.jobs=q.jobs;this.nextJob=q.next;this.risk=null;this.message=q.receipt.status==='cleanup-complete'?'Receipt inspected: document cleanup is complete. Remote work and charges remain unconfirmed.':'Receipt inspected: document cleanup is pending. Remote work and charges remain unconfirmed.';}finally{if(!adopted)model.release();}
 }
 private async recover(job:QueueJob,attemptId:string,c:Action){
  if(!this.current(c)||!this.jobs.includes(job))return;const a=job.attempts.find(attempt=>attempt.id===attemptId);if(!a)return;
  await this.editor.withCommandEvents({type:'RecoverJob',jobId:job.id,attemptId:a.id,expectedVersion:job.version},()=>undefined,null);if(!this.current(c))return;
  await this.inspect(this.receipt!,c);if(!this.current(c))return;
  this.message='Checking this existing deleted-document request. No image will be retrieved or adopted.';
 }
 private async override(job:QueueJob,c:Action){
  if(this.risk!==job||!this.current(c))return;const a=job.attempts.find(a=>a.state==='submission-uncertain'&&a.hold);if(!a)return;
  await this.editor.withCommandEvents({type:'OverrideUncertainHold',jobId:job.id,attemptId:a.id,expectedVersion:job.version,acknowledgeOverlapAndChargeRisk:true},()=>undefined,null);if(!this.current(c))return;
  await this.inspect(this.receipt!,c);if(!this.current(c))return;
  this.message='Local hold released after your risk acknowledgement. Remote work and charges remain uncertain.';
 }
 render(){this.syncOwner();const d=this.editor.view.document,p=this.plan,r=this.receipt,risk=this.risk,owner=this.capture(),generation=this.generation,act=(event:Event,pending:string,work:(c:Action)=>Promise<void>)=>this.action(event,owner,generation,pending,work);return html`<section class="document-deletion" aria-label="Document deletion" aria-busy=${String(this.busy)} @compositionstart=${()=>{this.composing=true;this.invalidate();}} @compositionend=${()=>{this.composing=false;}}><en-button ?disabled=${this.busy} @click=${(e:Event)=>act(e,'Loading retained deletion receipts…',c=>this.list(c))}>Review pending document cleanup</en-button>${this.receipts.map(receipt=>html`<en-button ?disabled=${this.busy} @click=${(e:Event)=>act(e,'Inspecting retained deletion receipt…',c=>this.inspect(receipt,c))}>Inspect cleanup for ${receipt.documentId}</en-button>`)}${this.next?html`<en-button ?disabled=${this.busy} @click=${(e:Event)=>act(e,'Loading the next deletion receipts…',c=>this.list(c,this.next!))}>Next deletion receipts</en-button>`:nothing}<en-button id="preview-document-deletion" ?disabled=${!d||this.busy||this.editor.view.busy} @click=${(e:Event)=>act(e,'Preparing deletion preview…',c=>this.preview(c))}>Review document deletion</en-button>${this.message?html`<en-alert role="status">${this.message}</en-alert>`:nothing}${p&&d?.id===p.documentId?html`<en-card><h2>Delete this document permanently?</h2><p>Document ${p.documentId}, revision ${p.documentRevision}. This releases ${p.histories} history records, ${p.checkpoints} checkpoints, ${p.drafts} saved drafts and ${p.jobs} jobs. Normal Undo cannot restore it.</p><p>Estimated eligible bytes: ${p.exclusiveBytes}. Retained bytes: ${p.retainedBytes}. In-use bytes remain pending until readers stop. No bytes have been freed.</p><p>Shared assets, independent library roots, recovery snapshots, migration backups and external copies remain. Unattributed legacy temporary files remain protected. Deletion does not erase remote data or prove cancellation or a refund.</p><en-accordion-item label="Retained roots">${p.retainedRoots.map(root=>html`<p>${root}</p>`)}</en-accordion-item>${p.unresolvedAttempts.length?html`<en-alert>These attempts may still run or be charged: ${p.unresolvedAttempts.join(', ')}. Their holds and reconciliation records remain; no late image will recreate this document.</en-alert>`:nothing}<en-button ?disabled=${this.busy} @click=${(e:Event)=>act(e,'Preparing a complete copy…',async c=>{if(!this.current(c))return;this.plan=null;this.planReady=false;this.models.clear('plan');await this.editor.copy();if(!this.current(c))return;this.message='Copy prepared; external destination remains unconfirmed. Review deletion again when ready.';})}>Save a complete copy first</en-button><en-button ?disabled=${this.busy||!this.planReady} @click=${(e:Event)=>act(e,'Deleting the acknowledged document…',c=>this.confirm(p,c))}>${p.unresolvedAttempts.length?'Acknowledge running work and delete document':'Confirm permanent document deletion'}</en-button><en-button ?disabled=${this.busy} @click=${(e:Event)=>act(e,'Keeping this document…',async c=>{if(!this.current(c))return;this.plan=null;this.planReady=false;this.models.clear('plan');this.message='Document kept.';})}>Keep document</en-button></en-card>`:nothing}${r?html`<en-card><h2>${r.status==='cleanup-complete'?'Document cleanup complete':'Document deleted; cleanup pending'}</h2><p>Actual freed local backend bytes: ${r.actualFreedBytes}. Pending bytes: ${r.pendingBytes}. Retained shared or backup bytes: ${r.retainedBytes}.</p><en-button ?disabled=${this.busy} @click=${(e:Event)=>act(e,'Checking and reclaiming eligible local bytes…',c=>this.collect(r,c))}>Check and reclaim eligible bytes</en-button>${this.jobs.map(job=>html`<p>Deleted-document job ${job.id}. ${job.attempts.some(a=>a.hold)?'A remote slot remains held.':'No local slot remains held.'} Actual charges and remote erasure are unconfirmed.</p>${job.attempts.map(attempt=>{const attemptId=attempt.id;return html`<p>Attempt ${attemptId}: ${attempt.state}. ${attempt.requestId?'Known provider request retained.':'No durable provider identifier.'} ${attempt.recoveryRequired?'An explicit check is required.':'Last retained observation shown.'}</p><en-button ?disabled=${this.busy} @click=${(e:Event)=>act(e,'Requesting reconciliation of the selected deleted attempt…',c=>this.recover(job,attemptId,c))}>Check deleted request ${job.id}, attempt ${attemptId} (${attempt.state})</en-button>`;})}${job.attempts.some(a=>a.state==='submission-uncertain'&&a.hold)?html`<en-button ?disabled=${this.busy} @click=${(e:Event)=>act(e,'Opening the overlap-risk review…',async c=>{if(!this.current(c)||!this.jobs.includes(job))return;this.risk=job;this.message='Review the overlap and charge risk below. No hold has been released.';})}>Review possible overlap for deleted request</en-button>`:nothing}`)}${this.nextJob?html`<en-button ?disabled=${this.busy} @click=${(e:Event)=>act(e,'Loading the next deleted requests…',c=>this.inspect(r,c,this.nextJob!))}>Next deleted requests</en-button>`:nothing}${risk?html`<en-alert>The original request may still run and be charged. Releasing this local hold can overlap remote work; it does not cancel, refund or erase it.</en-alert><en-button ?disabled=${this.busy} @click=${(e:Event)=>act(e,'Recording your explicit overlap-risk acknowledgement…',c=>this.override(risk,c))}>Acknowledge overlap and release deleted request hold</en-button>`:nothing}<en-button ?disabled=${this.busy} @click=${(e:Event)=>act(e,'Refreshing retained deleted-request state…',c=>this.inspect(r,c))}>Refresh deleted request state</en-button></en-card>`:nothing}</section>`;}
}
