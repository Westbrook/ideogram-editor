import {html,nothing} from 'lit';
import type {LitElement} from 'lit';
import type {EditorClient} from '../state/editor-client.js';
import type {QueueJob} from '../protocol/queue.js';
import type {DeletionPlan,DeletionReceipt} from '../protocol/deletion.js';
import {ControlAdapter} from './adapters.js';
type Owner={session:EditorClient['session'];identity:string|null;lifetime:number;draftOwner:EditorClient['draftOwner'];documentId:string|undefined;revision:string|undefined};
type Action=Owner&{token:number;deleting:string|null;deleted:string|null};
/** Each asynchronous operation and retained control belongs to its original owner. */
export class DocumentDeletion {
 private receipts:DeletionReceipt[]=[];private next:string|null=null;private jobs:QueueJob[]=[];private nextJob:string|null=null;private risk:QueueJob|null=null;
 private adapter=new ControlAdapter();private plan:DeletionPlan|null=null;private receipt:DeletionReceipt|null=null;private busy=false;private message='';private lifetime=0;private composing=false;
 private stateOwner:Owner|null=null;private active:Action|null=null;private generation=0;
 constructor(private host:LitElement,private editor:EditorClient,private composition:()=>boolean=()=>false){}
 dispose(){this.lifetime++;this.adapter.invalidate();this.invalidate();}
 private changed(){this.host.requestUpdate();}
 private capture():Owner{const session=this.editor.session,d=this.editor.view.document;return {session,identity:session.identity(),lifetime:this.lifetime,draftOwner:this.editor.draftOwner,documentId:d?.id,revision:d?.revision};}
 private sameOwner(c:Owner){return c.session===this.editor.session&&c.identity===c.session.identity()&&c.lifetime===this.lifetime&&c.draftOwner===this.editor.draftOwner;}
 private selection(c:Owner){const d=this.editor.view.document;return c.documentId===d?.id&&c.revision===d?.revision;}
 private ready(){return !this.composing&&!this.composition()&&![...(this.editor.draftOwner?.drafts.values()??[])].some(d=>d.pending||d.composing||d.generation!==d.savedGeneration);}
 private invalidate(){this.generation++;this.active=null;this.busy=false;this.plan=null;this.receipt=null;this.receipts=[];this.jobs=[];this.next=null;this.nextJob=null;this.risk=null;this.message='Deletion view changed. Review the current document or retained receipts again.';this.stateOwner=null;}
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
  this.adapter.action(event,()=>{
   this.syncOwner();if(generation!==this.generation||!this.sameOwner(owner)||!this.selection(owner)||!this.ready()||this.busy)return;
   const c:Action={...owner,token:++this.generation,deleting:null,deleted:null};this.active=c;this.busy=true;this.message=pending;this.changed();
   void work(c).catch(error=>{if(this.current(c)){this.plan=null;this.message=String(error)+'. Review a fresh deletion preview before confirming.';}}).finally(()=>{
    if(this.active!==c)return;
    if(!this.current(c))this.invalidate();else{if(c.deleted&&!this.editor.view.document)this.stateOwner={...c,documentId:undefined,revision:undefined};this.active=null;this.busy=false;}
    this.changed();
   });
  });
 }
 private async preview(c:Action){
  const d=this.editor.view.document;if(!d||!this.current(c))return;
  await this.editor.command({type:'PreviewDocumentDeletion',documentId:d.id,expectedRevision:d.revision},null);if(!this.current(c))return;
  const v=await this.editor.json<{plan:DeletionPlan}>('/api/v1/documents/'+d.id+'/deletion');if(!this.current(c))return;
  this.plan=v.plan;this.message='Review the affected history and retained bytes. No document has been deleted.';
 }
 private async confirm(plan:DeletionPlan,c:Action){
  if(this.plan!==plan||!this.current(c)||plan.documentId!==c.documentId||plan.documentRevision!==c.revision)return;
  c.deleting=plan.documentId;
  const events=await this.editor.command({type:'DeleteDocument',documentId:plan.documentId,planId:plan.id,planHash:plan.planHash,expectedRevision:plan.documentRevision,rootGeneration:plan.rootGeneration,acknowledgeRunningAndUncertain:true},null);
  if(this.active!==c||!this.sameOwner(c)||!this.ready()||!this.selection(c)&&this.editor.view.document!==null)return;
  if(!events.some(e=>e.type==='DocumentDeleted'&&e.payload.id===plan.documentId))throw Error('Deletion acknowledgement unavailable; inspect the retained receipt before another action');
  c.deleted=plan.documentId;c.deleting=null;if(!this.current(c))return;
  this.plan=null;const v=await this.editor.json<{receipt:DeletionReceipt}>('/api/v1/documents/'+plan.documentId+'/deletion');if(!this.current(c))return;
  await this.inspect(v.receipt,c);if(!this.current(c))return;
  this.message=this.receipt?.status==='cleanup-complete'?'Document deleted; retained receipt reports cleanup complete.':'Document deleted; cleanup pending. No space has been claimed as freed.';
 }
 private async collect(receipt:DeletionReceipt,c:Action){
  if(this.receipt!==receipt||!this.current(c))return;
  await this.editor.command({type:'CollectDocumentGarbage',documentId:receipt.documentId},null);if(!this.current(c))return;
  const v=await this.editor.json<{receipt:DeletionReceipt}>('/api/v1/documents/'+receipt.documentId+'/deletion');if(!this.current(c))return;
  this.receipt=v.receipt;this.message=v.receipt.status==='cleanup-complete'?'Document cleanup complete.':'Document deleted; cleanup pending while bytes are in use.';
 }
 private async list(c:Action,after=''){
  if(!this.current(c))return;const page=await this.editor.json<{items:DeletionReceipt[];next:string|null}>('/api/v1/deletions?after='+encodeURIComponent(after));if(!this.current(c))return;
  this.receipts=page.items;this.next=page.next;this.message='Retained deletion receipts are available below.';
 }
 private async inspect(receipt:DeletionReceipt,c:Action,after=''){
  if(!this.current(c))return;const q=await this.editor.json<{receipt:DeletionReceipt;jobs:QueueJob[];next:string|null}>('/api/v1/documents/'+receipt.documentId+'/deletion?after='+encodeURIComponent(after));if(!this.current(c))return;
  this.receipt=q.receipt;this.jobs=q.jobs;this.nextJob=q.next;this.risk=null;this.message=q.receipt.status==='cleanup-complete'?'Receipt inspected: document cleanup is complete. Remote work and charges remain unconfirmed.':'Receipt inspected: document cleanup is pending. Remote work and charges remain unconfirmed.';
 }
 private async recover(job:QueueJob,c:Action){
  if(!this.current(c)||!this.jobs.includes(job))return;const a=job.attempts.at(-1)!;
  await this.editor.command({type:'RecoverJob',jobId:job.id,attemptId:a.id,expectedVersion:job.version},null);if(!this.current(c))return;
  await this.inspect(this.receipt!,c);if(!this.current(c))return;
  this.message='Checking this existing deleted-document request. No image will be retrieved or adopted.';
 }
 private async override(job:QueueJob,c:Action){
  if(this.risk!==job||!this.current(c))return;const a=job.attempts.find(a=>a.state==='submission-uncertain'&&a.hold);if(!a)return;
  await this.editor.command({type:'OverrideUncertainHold',jobId:job.id,attemptId:a.id,expectedVersion:job.version,acknowledgeOverlapAndChargeRisk:true},null);if(!this.current(c))return;
  await this.inspect(this.receipt!,c);if(!this.current(c))return;
  this.message='Local hold released after your risk acknowledgement. Remote work and charges remain uncertain.';
 }
 render(){this.syncOwner();const d=this.editor.view.document,p=this.plan,r=this.receipt,risk=this.risk,owner=this.capture(),generation=this.generation,act=(event:Event,pending:string,work:(c:Action)=>Promise<void>)=>this.action(event,owner,generation,pending,work);return html`<section class="document-deletion" aria-label="Document deletion" aria-busy=${String(this.busy)} @compositionstart=${()=>{this.composing=true;this.invalidate();}} @compositionend=${()=>{this.composing=false;}}><en-button ?disabled=${this.busy} @click=${(e:Event)=>act(e,'Loading retained deletion receipts…',c=>this.list(c))}>Review pending document cleanup</en-button>${this.receipts.map(receipt=>html`<en-button ?disabled=${this.busy} @click=${(e:Event)=>act(e,'Inspecting retained deletion receipt…',c=>this.inspect(receipt,c))}>Inspect cleanup for ${receipt.documentId}</en-button>`)}${this.next?html`<en-button ?disabled=${this.busy} @click=${(e:Event)=>act(e,'Loading the next deletion receipts…',c=>this.list(c,this.next!))}>Next deletion receipts</en-button>`:nothing}<en-button id="preview-document-deletion" ?disabled=${!d||this.busy||this.editor.view.busy} @click=${(e:Event)=>act(e,'Preparing deletion preview…',c=>this.preview(c))}>Review document deletion</en-button>${this.message?html`<en-alert role="status">${this.message}</en-alert>`:nothing}${p&&d?.id===p.documentId?html`<en-card><h2>Delete this document permanently?</h2><p>Document ${p.documentId}, revision ${p.documentRevision}. This releases ${p.histories} history records, ${p.checkpoints} checkpoints, ${p.drafts} saved drafts and ${p.jobs} jobs. Normal Undo cannot restore it.</p><p>Estimated eligible bytes: ${p.exclusiveBytes}. Retained bytes: ${p.retainedBytes}. In-use bytes remain pending until readers stop. No bytes have been freed.</p><p>Shared assets, independent library roots, recovery snapshots, migration backups and external copies remain. Unattributed legacy temporary files remain protected. Deletion does not erase remote data or prove cancellation or a refund.</p><en-accordion-item label="Retained roots">${p.retainedRoots.map(root=>html`<p>${root}</p>`)}</en-accordion-item>${p.unresolvedAttempts.length?html`<en-alert>These attempts may still run or be charged: ${p.unresolvedAttempts.join(', ')}. Their holds and reconciliation records remain; no late image will recreate this document.</en-alert>`:nothing}<en-button ?disabled=${this.busy} @click=${(e:Event)=>act(e,'Preparing a complete copy…',async c=>{if(!this.current(c))return;this.plan=null;await this.editor.copy();if(!this.current(c))return;this.message='Copy prepared; external destination remains unconfirmed. Review deletion again when ready.';})}>Save a complete copy first</en-button><en-button ?disabled=${this.busy} @click=${(e:Event)=>act(e,'Deleting the acknowledged document…',c=>this.confirm(p,c))}>${p.unresolvedAttempts.length?'Acknowledge running work and delete document':'Confirm permanent document deletion'}</en-button><en-button ?disabled=${this.busy} @click=${(e:Event)=>act(e,'Keeping this document…',async c=>{if(!this.current(c))return;this.plan=null;this.message='Document kept.';})}>Keep document</en-button></en-card>`:nothing}${r?html`<en-card><h2>${r.status==='cleanup-complete'?'Document cleanup complete':'Document deleted; cleanup pending'}</h2><p>Actual freed local backend bytes: ${r.actualFreedBytes}. Pending bytes: ${r.pendingBytes}. Retained shared or backup bytes: ${r.retainedBytes}.</p><en-button ?disabled=${this.busy} @click=${(e:Event)=>act(e,'Checking and reclaiming eligible local bytes…',c=>this.collect(r,c))}>Check and reclaim eligible bytes</en-button>${this.jobs.map(job=>html`<p>Deleted-document job ${job.id}. ${job.attempts.some(a=>a.hold)?'A remote slot remains held.':'No local slot remains held.'} Actual charges and remote erasure are unconfirmed.</p><en-button ?disabled=${this.busy} @click=${(e:Event)=>act(e,'Requesting reconciliation of the existing deleted request…',c=>this.recover(job,c))}>Check existing deleted request ${job.id}</en-button>${job.attempts.some(a=>a.state==='submission-uncertain'&&a.hold)?html`<en-button ?disabled=${this.busy} @click=${(e:Event)=>act(e,'Opening the overlap-risk review…',async c=>{if(!this.current(c)||!this.jobs.includes(job))return;this.risk=job;this.message='Review the overlap and charge risk below. No hold has been released.';})}>Review possible overlap for deleted request</en-button>`:nothing}`)}${this.nextJob?html`<en-button ?disabled=${this.busy} @click=${(e:Event)=>act(e,'Loading the next deleted requests…',c=>this.inspect(r,c,this.nextJob!))}>Next deleted requests</en-button>`:nothing}${risk?html`<en-alert>The original request may still run and be charged. Releasing this local hold can overlap remote work; it does not cancel, refund or erase it.</en-alert><en-button ?disabled=${this.busy} @click=${(e:Event)=>act(e,'Recording your explicit overlap-risk acknowledgement…',c=>this.override(risk,c))}>Acknowledge overlap and release deleted request hold</en-button>`:nothing}<en-button ?disabled=${this.busy} @click=${(e:Event)=>act(e,'Refreshing retained deleted-request state…',c=>this.inspect(r,c))}>Refresh deleted request state</en-button></en-card>`:nothing}</section>`;}
}
