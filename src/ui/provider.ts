import {html,nothing} from 'lit';
import type {LitElement} from 'lit';
import type {EditorClient} from '../state/editor-client.js';
import type {ProviderView,ProviderV4View,ProviderAuthorizationBody} from '../protocol/provider.js';
import type {QueueJob,QueueView} from '../protocol/queue.js';
import {ControlAdapter} from './adapters.js';
import {cloneOwnedModel,type OwnedModel} from '../observability/model-memory.js';
import {PromptReaderCleanupError} from '../observability/prompt-memory.js';
import {decodeFrozenPromptPage,frozenSettings,sameProviderValue,type FrozenPromptPage,type PromptPage} from './provider-payload.js';
import {renderRequestEstimate} from './request-v45.js';

type Owner={session:EditorClient['session'];identity:string|null;sessionId:string;draftOwner:EditorClient['draftOwner'];documentId:string|null;revision:string|null;lifetime:number};
type DispatchReview={provider:ProviderV4View;job:QueueJob;body:ProviderAuthorizationBody;owner:Owner;prompt:PromptPage|null;promptLoading:boolean;settings:string};

/** A live attempt is authorized only by the exact displayed, deliberately confirmed review. */
export class ProviderControls {
 private controls=new ControlAdapter();private lifetime=0;private generation=0;private actionEpoch=0;private owner:Owner|null=null;
 private provider:ProviderView|null=null;private queue:QueueView|null=null;private review:DispatchReview|null=null;
 private busy=false;private composing=false;private message='';private fresh=false;private reviewSerial=0;
 private providerPayload:OwnedModel<ProviderView>|null=null;private queuePayload:OwnedModel<QueueView>|null=null;private reviewPayload:OwnedModel<{provider:ProviderV4View;job:QueueJob;body:ProviderAuthorizationBody}>|null=null;private settingsPayload:OwnedModel<string>|null=null;private promptPayload:OwnedModel<PromptPage>|null=null;
 private reads=new Set<AbortController>();private pending=new Set<Promise<unknown>>();private cleanupFailures=new Set<PromptReaderCleanupError>();private releasing?:Promise<void>;
 constructor(private host:LitElement,private editor:EditorClient){}
 private capture():Owner{const d=this.editor.view.document;return {session:this.editor.session,identity:this.editor.session.identity(),sessionId:this.editor.sessionId,draftOwner:this.editor.draftOwner,documentId:d?.id??null,revision:d?.revision??null,lifetime:this.lifetime};}
 private current(o:Owner){const n=this.capture();return this.editor.view.ready&&!!this.editor.view.document&&Object.keys(n).every(k=>n[k as keyof Owner]===o[k as keyof Owner]);}
 private changed(){this.host.requestUpdate();}
 private rememberCleanup(error:unknown){if(error instanceof PromptReaderCleanupError)this.cleanupFailures.add(error);else if(error instanceof AggregateError)for(const cause of error.errors)this.rememberCleanup(cause);}
 private track<T>(work:()=>Promise<T>){const task=work();this.pending.add(task);void task.then(()=>this.pending.delete(task),error=>{this.pending.delete(task);this.rememberCleanup(error);});return task;}
 private clearReview(){this.reviewSerial++;this.review=null;this.reviewPayload?.release();this.reviewPayload=null;this.settingsPayload?.release();this.settingsPayload=null;this.promptPayload?.release();this.promptPayload=null;}
 private reset(){this.lifetime++;this.actionEpoch++;this.controls.invalidate();this.generation++;for(const read of this.reads)read.abort();this.busy=false;this.fresh=false;this.composing=false;this.clearReview();this.provider=null;this.queue=null;this.providerPayload?.release();this.providerPayload=null;this.queuePayload?.release();this.queuePayload=null;this.message='';}
 private async drain(){while(this.pending.size)await Promise.allSettled([...this.pending]);const errors:unknown[]=[];for(const error of this.cleanupFailures)try{await error.retry();this.cleanupFailures.delete(error);}catch(failure){errors.push(failure);}if(errors.length)throw new AggregateError(errors,'PROVIDER_RELEASE_INCOMPLETE');}
 releaseDocument(){if(this.releasing)return this.releasing;this.reset();this.owner=null;this.releasing=this.drain().finally(()=>{this.releasing=undefined;});return this.releasing;}
 dispose(){return this.releaseDocument();}
 get lifecycle(){return {models:Number(!!this.providerPayload)+Number(!!this.queuePayload)+Number(!!this.reviewPayload),promptCharacters:this.review?.prompt?.text.length??0,pendingOperations:this.pending.size,pendingReads:this.reads.size,cleanupFailures:this.cleanupFailures.size};}
 private async read<T>(path:string,label:string,owner:Owner,maxBytes:number,generation=this.generation,kind:'control'|'prompt'='control'){
  const abort=new AbortController();this.reads.add(abort);const owns=()=>!abort.signal.aborted&&this.current(owner)&&generation===this.generation;
  try{return await this.editor.ownedJSON<T>(path,label,{signal:abort.signal},owns,maxBytes,kind);}finally{this.reads.delete(abort);}
 }
 sync(){return this.track(()=>this.syncOwned());}
 private async syncOwned(){
  if(this.releasing)return;
  if(!this.editor.view.ready||!this.editor.view.document){if(this.owner){this.reset();this.owner=null;this.changed();}return;}
  if(this.owner&&this.current(this.owner))return;
  this.reset();this.owner=this.capture();await this.refresh(this.owner);
 }
 private refresh(owner:Owner,after=''){return this.track(()=>this.refreshOwned(owner,after));}
 private async refreshOwned(owner:Owner,after=''){
  if(!this.current(owner)||this.releasing)return;for(const read of this.reads)read.abort();const generation=++this.generation;this.busy=true;this.fresh=false;this.changed();
  let provider:OwnedModel<ProviderView>|undefined,queue:OwnedModel<QueueView>|undefined;
  try{
   const settled=await Promise.allSettled([this.read<ProviderView>('/api/v1/provider','provider-view',owner,65536,generation),this.read<QueueView>('/api/v1/queue'+(after?'?after='+encodeURIComponent(after):''),'provider-queue',owner,8*1024**2,generation)]);
   const first=settled[0],second=settled[1];if(first.status==='fulfilled')provider=first.value;if(second.status==='fulfilled')queue=second.value;
   const failures=settled.filter((result):result is PromiseRejectedResult=>result.status==='rejected').map(result=>result.reason);if(failures.length)throw new AggregateError(failures,'Provider state could not be refreshed. The previous view is retained.');
   if(!this.current(owner)||generation!==this.generation)return;
   this.clearReview();this.providerPayload?.release();this.queuePayload?.release();this.providerPayload=provider!;this.queuePayload=queue!;provider=undefined;queue=undefined;
   this.provider=this.providerPayload.value;this.queue=this.queuePayload.value;this.fresh=true;this.message=this.provider.message;
  }catch(error){this.rememberCleanup(error);if(this.current(owner)&&generation===this.generation)this.message=error instanceof Error?error.message:'Provider state unavailable.';}
  finally{provider?.release();queue?.release();if(this.current(owner)&&generation===this.generation){this.busy=false;this.changed();}}
 }
 private reason(provider:ProviderView,job:QueueJob){
  if(provider.operation==='generate-v45')return 'v4.5 live dispatch is unavailable while per-output safety admission is unqualified. Returned images remain withheld from ordinary display, adoption and export.';
  const r=job.review.request,l=provider.limits,a=job.attempts.at(-1);
  if(a?.providerAuthorization)return a.providerAuthorization.epoch===provider.epoch&&a.providerAuthorization.configurationHash===provider.configurationHash?'This attempt is already authorized. Inspect the durable queue for its current state; it does not need another approval.':'This authorization belongs to an earlier provider session or configuration. Cancel this unstarted job locally, then prepare and enqueue a fresh request for a new review. The old attempt will not be submitted automatically.';
  if(!provider.ready||provider.mode!=='fal'||!provider.profile||!l||!provider.configurationId||!provider.configurationHash)return 'Live dispatch is unavailable in this configuration.';
  if(job.documentId!==this.editor.view.document?.id||job.disposition!=='eligible'||job.local==='locally-cancelled'||a?.state!=='not-started')return 'This retained job is not eligible for a new live submission.';
  if(r.kind!=='generate'||job.review.endpoint!==provider.endpoint||r.size.kind!=='custom'||r.size.width!==l.width||r.size.height!==l.height||r.settings.count!==l.imagesPerRequest||r.settings.format!==l.format||r.settings.expansion!==l.expansion)return `This configuration permits Generate image only: ${l.width} × ${l.height}, one PNG, expansion None. Prepare and enqueue that exact request first.`;
  if(Date.parse(l.expiresAt)<=Date.now()||l.usedRequests>=l.maximumRequests||l.usedImages>=l.maximumImages)return 'The configured request allowance has expired or is exhausted.';
  return null;
 }
 private action(event:Event,owner:Owner,work:()=>void|Promise<void>){
  const generation=this.generation;
  this.controls.action(event,()=>{if(this.busy||this.composing||!this.current(owner)||generation!==this.generation)return;const actionEpoch=++this.actionEpoch;void Promise.resolve().then(work).catch(error=>{if(this.current(owner)&&actionEpoch===this.actionEpoch){this.rememberCleanup(error);this.message=error instanceof Error?error.message:'Provider action unavailable.';this.changed();}});});
 }
 private inspect(provider:ProviderView,job:QueueJob,owner:Owner){
  if(!this.fresh||this.provider!==provider||!this.queue?.jobs.includes(job)||!this.current(owner))return;if(provider.operation!=='generate')throw Error(this.reason(provider,job)??'This provider operation is unavailable.');
  const reason=this.reason(provider,job);if(reason)throw Error(reason);
  const profile=provider.profile!,attempt=job.attempts.at(-1)!;
  const body:ProviderAuthorizationBody={type:'AuthorizeProviderJob',jobId:job.id,attemptId:attempt.id,expectedVersion:job.version,reviewToken:job.review.token,configurationId:provider.configurationId!,configurationHash:provider.configurationHash!,epoch:provider.epoch,profileId:profile.id,profileVersion:profile.version,disclosureDigest:profile.disclosureDigest,acknowledgeChargeAndPrivacy:true};
  let copy:OwnedModel<{provider:ProviderV4View;job:QueueJob;body:ProviderAuthorizationBody}>|undefined,settings:OwnedModel<string>|undefined;
  try{copy=cloneOwnedModel('provider-dispatch-review',{provider,job,body});settings=frozenSettings(job.review.request);
   this.clearReview();this.reviewPayload=copy;this.settingsPayload=settings;this.review={...copy.value,owner,prompt:null,promptLoading:false,settings:settings.value};copy=undefined;settings=undefined;
  }finally{copy?.release();settings?.release();}
  this.message='Review this exact paid attempt and remote privacy fallback before authorizing it.';this.changed();
  const serial=this.reviewSerial;return this.readPrompt(this.review!).catch(error=>{
   // A failed initial prompt cannot leave a confirmable review. Paging an
   // already valid prompt has its separate retained-page failure path.
   if(this.reviewSerial===serial&&this.current(owner))this.clearReview();throw error;
  }).then(async()=>{
   try{await this.host.updateComplete;}catch(error){if(this.reviewSerial!==serial||!this.current(owner))return;this.clearReview();throw error;}
   if(this.reviewSerial===serial&&this.current(owner))this.host.querySelector<HTMLElement>('#provider-dispatch-review')?.focus();
  });
 }
 private readPrompt(review:DispatchReview,offset='0'){return this.track(()=>this.readPromptOwned(review,offset));}
 private async readPromptOwned(review:DispatchReview,offset='0'){
  if(this.review!==review||!this.current(review.owner)||review.promptLoading||!this.fresh)return;
  const pins=[this.reviewPayload!.pin(),this.settingsPayload!.pin(),...(this.promptPayload?[this.promptPayload.pin()]:[])];review.promptLoading=true;this.changed();let page:OwnedModel<FrozenPromptPage>|undefined,next:OwnedModel<PromptPage>|undefined;
  try{
   page=await this.read<FrozenPromptPage>('/api/v1/jobs/'+review.body.jobId+'/candidates?attempt='+review.body.attemptId+'&prompt=requested&offset='+offset,'provider-frozen-prompt-page',review.owner,65536,this.generation,'prompt');
   if(this.review!==review||!this.current(review.owner))return;
   next=decodeFrozenPromptPage(page.value,review.job.review.prompt.byteLength,offset);
   const old=this.promptPayload;this.promptPayload=next;review.prompt=next.value;next=undefined;old?.release();
  }finally{page?.release();next?.release();for(const unpin of pins)unpin();if(this.review===review&&this.current(review.owner)){review.promptLoading=false;this.changed();}}
 }
 private authorize(review:DispatchReview){return this.track(async()=>{
  try{await this.authorizeOwned(review);}catch(error){
   // Identity/eligibility refusal happens before delivery takes over the view.
   // Retire only this stale confirmation; a later owner's review is unrelated.
   if(this.review===review&&this.current(review.owner))this.clearReview();throw error;
  }
 });}
 private async authorizeOwned(review:DispatchReview){
  if(!this.fresh||this.busy||this.review!==review||!this.current(review.owner)||!this.provider||!review.prompt||review.promptLoading)return;
  if(!sameProviderValue(this.provider,review.provider))throw Error('Provider configuration changed. Refresh and review this attempt again.');
  const job=this.queue?.jobs.find(j=>j.id===review.job.id);if(!job||!sameProviderValue(job,review.job))throw Error('The job changed. Refresh and review its current attempt.');
  const reason=this.reason(this.provider,job);if(reason)throw Error(reason);
  const pins=[this.reviewPayload!.pin(),this.settingsPayload!.pin(),this.promptPayload!.pin(),this.providerPayload!.pin(),this.queuePayload!.pin()];
  this.busy=true;this.clearReview();this.message='Saving authorization for this exact attempt…';this.changed();
  try{
   await this.editor.withCommandEvents(review.body,()=>undefined,null);
   if(!this.current(review.owner))return;
   await this.refresh(review.owner);
   if(this.current(review.owner)){this.message='Authorization recorded. Inspect the durable queue for submission, uncertainty and retained results. Cancellation does not guarantee a refund.';this.changed();}
  }catch(error){this.rememberCleanup(error);if(this.current(review.owner)){this.busy=false;this.message='Authorization could not be confirmed. Inspect the durable queue before any further action. '+(error instanceof Error?error.message:'');this.changed();}}
  finally{for(const unpin of pins)unpin();}
 }
 render(){
  const owner=this.capture(),provider=this.provider,review=this.review,limits=provider?.limits;
  const act=(event:Event,work:()=>void|Promise<void>)=>this.action(event,owner,work);
  return html`<en-accordion-item label="Live provider" class="provider-controls" @compositionstart=${()=>{this.composing=true;this.clearReview();this.controls.invalidate();this.changed();}} @compositionend=${()=>{this.composing=false;}}>
   <section aria-label="Live provider authorization" aria-busy=${String(this.busy)}>
    <p role="status">${this.message||'Provider configuration is read from the local backend.'}</p>
    <en-button id="refresh-provider" ?disabled=${this.busy||!this.editor.view.ready} @click=${(e:Event)=>act(e,()=>this.refresh(owner))}>Refresh provider and eligible jobs</en-button>
    ${provider?html`<p>Provider: ${provider.mode==='fal'?'Fal · '+provider.endpoint:'Disabled'}. ${provider.credentialConfigured?'Server credential configured.':'No server credential configured.'}</p>`:nothing}
    ${provider?.operation==='generate-v45'?html`<en-alert id="provider-v45-admission" announcement="none">v4.5 live dispatch is blocked. Per-output safety evidence is unavailable; ordinary image display, adoption and export are withheld.</en-alert>`:nothing}
    ${limits?html`<p>Configured allowance: ${limits.usedRequests} of ${limits.maximumRequests} requests; ${limits.usedImages} of ${limits.maximumImages} images. Expires ${limits.expiresAt}. ${limits.width} × ${limits.height}, one output per request. ${provider?.operation==='generate-v45'?html`Provider-controlled format, ${provider.limits!.quality} quality; prompt expansion ${provider.limits!.enablePromptExpansion?'enabled':'disabled'}.`:html`PNG; expansion None.`}</p><p>This request limit is not a monetary ceiling. Actual charges are unavailable; an uncertain attempt consumes its allowance and is never automatically resubmitted.</p>`:nothing}
    ${provider?.profile?html`<en-accordion-item label="Remote privacy and availability"><p>Profile ${provider.profile.id}, version ${provider.profile.version}.</p>${provider.profile.disclosure.map(line=>html`<p>${line}</p>`)}</en-accordion-item>`:nothing}
    ${provider?.ready?this.queue?.jobs.filter(j=>j.documentId===owner.documentId&&j.attempts.at(-1)?.state==='not-started').map(job=>{const reason=this.reason(provider,job);return html`<en-card><p>Job ${job.id} · ${job.review.endpoint} · ${job.review.request.settings.count} output(s).</p>${reason?html`<p>${reason}</p>`:nothing}<en-button ?disabled=${this.busy||!this.fresh||!!reason} @click=${(e:Event)=>act(e,()=>this.inspect(provider,job,owner))}>Review live dispatch for ${job.id}</en-button></en-card>`;}):nothing}
    ${this.queue?.nextCursor?html`<en-button ?disabled=${this.busy} @click=${(e:Event)=>act(e,()=>this.refresh(owner,this.queue!.nextCursor!))}>Next queued jobs for provider review</en-button>`:nothing}
    ${review?html`<en-card id="provider-dispatch-review" tabindex="-1"><h2>Authorize this paid Fal attempt?</h2><p>Job ${review.body.jobId}, attempt ${review.body.attemptId}. Endpoint ${review.job.review.endpoint}. One ${review.provider.limits!.width} × ${review.provider.limits!.height} PNG; expansion None.</p><p>The frozen prompt and settings leave this computer. No source image, mask or adapter is sent by this operation. Prompt identity ${review.job.review.prompt.hash}; ${review.job.review.prompt.byteLength} bytes.</p><en-accordion-item label="Frozen request settings"><pre>${review.settings}</pre></en-accordion-item>${review.prompt?html`<en-textarea label="Exact frozen prompt page" readOnly .rows=${6} .value=${review.prompt.text}></en-textarea><p>Prompt page starts at byte ${review.prompt.offset} of ${review.job.review.prompt.byteLength}.</p>${review.prompt.next?html`<en-button ?disabled=${review.promptLoading} @click=${(e:Event)=>act(e,()=>this.readPrompt(review,review.prompt!.next!))}>Next frozen prompt page</en-button>`:nothing}${review.prompt.offset!=='0'?html`<en-button ?disabled=${review.promptLoading} @click=${(e:Event)=>act(e,()=>this.readPrompt(review))}>First frozen prompt page</en-button>`:nothing}`:html`<p>Loading the exact retained prompt before authorization…</p>`}${renderRequestEstimate(review.job.review.estimate)}${review.provider.profile!.disclosure.map(line=>html`<p>${line}</p>`)}<p>This approval is for this exact attempt and current provider configuration. Cancellation may arrive after completion and is not a refund. Local deletion does not erase provider copies.</p><en-button id="authorize-provider" ?disabled=${this.busy||!this.fresh||review.promptLoading||!review.prompt} @click=${(e:Event)=>act(e,()=>this.authorize(review))}>Acknowledge paid attempt and privacy fallback; authorize dispatch</en-button><en-button @click=${(e:Event)=>act(e,()=>{if(this.review===review){this.clearReview();this.message='Live dispatch was not authorized.';this.changed();}})}>Keep this request local</en-button></en-card>`:nothing}
   </section>
  </en-accordion-item>`;
 }
}
