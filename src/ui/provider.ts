import {html,nothing} from 'lit';
import type {LitElement} from 'lit';
import type {EditorClient} from '../state/editor-client.js';
import type {ProviderView,ProviderAuthorizationBody} from '../protocol/provider.js';
import type {QueueJob,QueueView} from '../protocol/queue.js';
import {ControlAdapter} from './adapters.js';
import {canonical} from '../protocol/json.js';

type Owner={session:EditorClient['session'];identity:string|null;sessionId:string;draftOwner:EditorClient['draftOwner'];documentId:string|null;revision:string|null;lifetime:number};
type DispatchReview={provider:ProviderView;job:QueueJob;body:ProviderAuthorizationBody;owner:Owner;prompt:{text:string;offset:string;next:string|null}|null;promptLoading:boolean};

/** A live attempt is authorized only by the exact displayed, deliberately confirmed review. */
export class ProviderControls {
 private controls=new ControlAdapter();private lifetime=0;private generation=0;private actionEpoch=0;private owner:Owner|null=null;
 private provider:ProviderView|null=null;private queue:QueueView|null=null;private review:DispatchReview|null=null;
 private busy=false;private composing=false;private message='';
 constructor(private host:LitElement,private editor:EditorClient){}
 private capture():Owner{const d=this.editor.view.document;return {session:this.editor.session,identity:this.editor.session.identity(),sessionId:this.editor.sessionId,draftOwner:this.editor.draftOwner,documentId:d?.id??null,revision:d?.revision??null,lifetime:this.lifetime};}
 private current(o:Owner){const n=this.capture();return this.editor.view.ready&&!!this.editor.view.document&&Object.keys(n).every(k=>n[k as keyof Owner]===o[k as keyof Owner]);}
 private changed(){this.host.requestUpdate();}
 private reset(){this.lifetime++;this.actionEpoch++;this.controls.invalidate();this.generation++;this.busy=false;this.composing=false;this.review=null;this.provider=null;this.queue=null;this.message='';}
 dispose(){this.lifetime++;this.reset();this.owner=null;}
 async sync(){
  if(!this.editor.view.ready||!this.editor.view.document){if(this.owner){this.reset();this.owner=null;this.changed();}return;}
  if(this.owner&&this.current(this.owner))return;
  this.reset();this.owner=this.capture();await this.refresh(this.owner);
 }
 private async refresh(owner:Owner,after=''){
  if(!this.current(owner))return;const generation=++this.generation;this.busy=true;this.review=null;this.changed();
  try{
   const [provider,queue]=await Promise.all([this.editor.json<ProviderView>('/api/v1/provider'),this.editor.json<QueueView>('/api/v1/queue'+(after?'?after='+encodeURIComponent(after):''))]);
   if(!this.current(owner)||generation!==this.generation)return;
   this.provider=provider;this.queue=queue;this.message=provider.message;
  }catch(error){if(this.current(owner)&&generation===this.generation){this.provider=null;this.queue=null;this.message=error instanceof Error?error.message:'Provider state unavailable.';}}
  finally{if(this.current(owner)&&generation===this.generation){this.busy=false;this.changed();}}
 }
 private reason(provider:ProviderView,job:QueueJob){
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
  this.controls.action(event,()=>{if(this.busy||this.composing||!this.current(owner)||generation!==this.generation)return;const actionEpoch=++this.actionEpoch;void Promise.resolve().then(work).catch(error=>{if(this.current(owner)&&actionEpoch===this.actionEpoch){this.review=null;this.message=error instanceof Error?error.message:'Provider action unavailable.';this.changed();}});});
 }
 private async inspect(provider:ProviderView,job:QueueJob,owner:Owner){
  if(this.provider!==provider||!this.queue?.jobs.includes(job)||!this.current(owner))return;
  const reason=this.reason(provider,job);if(reason)throw Error(reason);
  const profile=provider.profile!,attempt=job.attempts.at(-1)!;
  this.review={provider:structuredClone(provider),job:structuredClone(job),owner,prompt:null,promptLoading:false,body:{type:'AuthorizeProviderJob',jobId:job.id,attemptId:attempt.id,expectedVersion:job.version,reviewToken:job.review.token,configurationId:provider.configurationId!,configurationHash:provider.configurationHash!,epoch:provider.epoch,profileId:profile.id,profileVersion:profile.version,disclosureDigest:profile.disclosureDigest,acknowledgeChargeAndPrivacy:true}};
  this.message='Review this exact paid attempt and remote privacy fallback before authorizing it.';this.changed();
  const review=this.review;await this.readPrompt(review);await this.host.updateComplete;if(this.review===review&&this.current(owner))this.host.querySelector<HTMLElement>('#provider-dispatch-review')?.focus();
 }
 private async readPrompt(review:DispatchReview,offset='0'){
  if(this.review!==review||!this.current(review.owner)||review.promptLoading)return;
  review.promptLoading=true;this.changed();
  try{
   const page=await this.editor.json<{bytes:string;byteLength:string;offset:string;nextOffset:string|null}>('/api/v1/jobs/'+review.body.jobId+'/candidates?attempt='+review.body.attemptId+'&prompt=requested&offset='+offset);
   if(this.review!==review||!this.current(review.owner))return;
   if(page.byteLength!==review.job.review.prompt.byteLength||page.offset!==offset||typeof page.bytes!=='string'||page.bytes.length>44000)throw Error('Frozen prompt page identity is unavailable. Refresh and review again.');
   const bytes=Uint8Array.from(atob(page.bytes),c=>c.charCodeAt(0)),end=BigInt(offset)+BigInt(bytes.length),total=BigInt(page.byteLength);
   if(end>total||end<total&&bytes.length===0||page.nextOffset!==(end===total?null:String(end)))throw Error('Frozen prompt page is incomplete.');
   review.prompt={text:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes),offset,next:page.nextOffset};
  }finally{if(this.review===review&&this.current(review.owner)){review.promptLoading=false;this.changed();}}
 }
 private async authorize(review:DispatchReview){
  if(this.review!==review||!this.current(review.owner)||!this.provider||!review.prompt||review.promptLoading)return;
  if(canonical(this.provider)!==canonical(review.provider))throw Error('Provider configuration changed. Refresh and review this attempt again.');
  const job=this.queue?.jobs.find(j=>j.id===review.job.id);if(!job||canonical(job)!==canonical(review.job))throw Error('The job changed. Refresh and review its current attempt.');
  const reason=this.reason(this.provider,job);if(reason)throw Error(reason);
  this.busy=true;this.review=null;this.message='Saving authorization for this exact attempt…';this.changed();
  try{
   await this.editor.command(review.body,null);
   if(!this.current(review.owner))return;
   await this.refresh(review.owner);
   if(this.current(review.owner)){this.message='Authorization recorded. Inspect the durable queue for submission, uncertainty and retained results. Cancellation does not guarantee a refund.';this.changed();}
  }catch(error){if(this.current(review.owner)){this.busy=false;this.message='Authorization could not be confirmed. Inspect the durable queue before any further action. '+(error instanceof Error?error.message:'');this.changed();}}
 }
 render(){
  const owner=this.capture(),provider=this.provider,review=this.review,limits=provider?.limits;
  const act=(event:Event,work:()=>void|Promise<void>)=>this.action(event,owner,work);
  return html`<en-accordion-item label="Live provider" class="provider-controls" @compositionstart=${()=>{this.composing=true;this.review=null;this.controls.invalidate();this.changed();}} @compositionend=${()=>{this.composing=false;}}>
   <section aria-label="Live provider authorization" aria-busy=${String(this.busy)}>
    <p role="status">${this.message||'Provider configuration is read from the local backend.'}</p>
    <en-button id="refresh-provider" ?disabled=${this.busy||!this.editor.view.ready} @click=${(e:Event)=>act(e,()=>this.refresh(owner))}>Refresh provider and eligible jobs</en-button>
    ${provider?html`<p>Provider: ${provider.mode==='fal'?'Fal · '+provider.endpoint:'Disabled'}. ${provider.credentialConfigured?'Server credential configured.':'No server credential configured.'}</p>`:nothing}
    ${limits?html`<p>Configured allowance: ${limits.usedRequests} of ${limits.maximumRequests} requests; ${limits.usedImages} of ${limits.maximumImages} images. Expires ${limits.expiresAt}. ${limits.width} × ${limits.height}, one PNG per request, expansion None.</p><p>This request limit is not a monetary ceiling. Actual charges are unavailable; an uncertain attempt consumes its allowance and is never automatically resubmitted.</p>`:nothing}
    ${provider?.profile?html`<en-accordion-item label="Remote privacy and availability"><p>Profile ${provider.profile.id}, version ${provider.profile.version}.</p>${provider.profile.disclosure.map(line=>html`<p>${line}</p>`)}</en-accordion-item>`:nothing}
    ${provider?.ready?this.queue?.jobs.filter(j=>j.documentId===owner.documentId&&j.attempts.at(-1)?.state==='not-started').map(job=>{const reason=this.reason(provider,job);return html`<en-card><p>Job ${job.id} · ${job.review.endpoint} · ${job.review.request.settings.count} output(s).</p>${reason?html`<p>${reason}</p>`:nothing}<en-button ?disabled=${this.busy||!!reason} @click=${(e:Event)=>act(e,()=>this.inspect(provider,job,owner))}>Review live dispatch for ${job.id}</en-button></en-card>`;}):nothing}
    ${this.queue?.nextCursor?html`<en-button ?disabled=${this.busy} @click=${(e:Event)=>act(e,()=>this.refresh(owner,this.queue!.nextCursor!))}>Next queued jobs for provider review</en-button>`:nothing}
    ${review?html`<en-card id="provider-dispatch-review" tabindex="-1"><h2>Authorize this paid Fal attempt?</h2><p>Job ${review.body.jobId}, attempt ${review.body.attemptId}. Endpoint ${review.job.review.endpoint}. One ${review.provider.limits!.width} × ${review.provider.limits!.height} PNG; expansion None.</p><p>The frozen prompt and settings leave this computer. No source image, mask or adapter is sent by this operation. Prompt identity ${review.job.review.prompt.hash}; ${review.job.review.prompt.byteLength} bytes.</p><en-accordion-item label="Frozen request settings"><pre>${JSON.stringify(review.job.review.request,null,2)}</pre></en-accordion-item>${review.prompt?html`<en-textarea label="Exact frozen prompt page" readOnly .rows=${6} .value=${review.prompt.text}></en-textarea><p>Prompt page starts at byte ${review.prompt.offset} of ${review.job.review.prompt.byteLength}.</p>${review.prompt.next?html`<en-button ?disabled=${review.promptLoading} @click=${(e:Event)=>act(e,()=>this.readPrompt(review,review.prompt!.next!))}>Next frozen prompt page</en-button>`:nothing}${review.prompt.offset!=='0'?html`<en-button ?disabled=${review.promptLoading} @click=${(e:Event)=>act(e,()=>this.readPrompt(review))}>First frozen prompt page</en-button>`:nothing}`:html`<p>Loading the exact retained prompt before authorization…</p>`}<p>Published estimate: USD ${review.job.review.estimate.rate} per ${review.job.review.estimate.unit}, count ${review.job.review.estimate.count}. Actual and total spend are unknown. Unknown estimate components: ${review.job.review.estimate.unknown.join(', ')}.</p>${review.provider.profile!.disclosure.map(line=>html`<p>${line}</p>`)}<p>This approval is for this exact attempt and current provider configuration. Cancellation may arrive after completion and is not a refund. Local deletion does not erase provider copies.</p><en-button id="authorize-provider" ?disabled=${this.busy||review.promptLoading||!review.prompt} @click=${(e:Event)=>act(e,()=>this.authorize(review))}>Acknowledge paid attempt and privacy fallback; authorize dispatch</en-button><en-button @click=${(e:Event)=>act(e,()=>{if(this.review===review){this.review=null;this.message='Live dispatch was not authorized.';this.changed();}})}>Keep this request local</en-button></en-card>`:nothing}
   </section>
  </en-accordion-item>`;
 }
}
