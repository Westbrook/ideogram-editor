import {html,nothing} from 'lit';
import type {LitElement} from 'lit';
import type {EditorClient} from '../state/editor-client.js';
import type {Draft} from '../request/family.js';
import type {Composition,CompositionRef,LayerValue} from '../composition/core.js';
import {exportCompositionText,type CompositionTextReview} from '../composition/text-export.js';
import {canonical} from '../protocol/json.js';
import {createOwnedModel,modelPayloadBytes,type OwnedModel} from '../observability/model-memory.js';
import {reservePromptPayload,jsonPayloadUnits} from '../observability/prompt-memory.js';

type Hooks={draft:()=>Draft|undefined;owns:()=>()=>boolean;hold:()=>()=>void;apply:(expected:Draft,prompt:string,composition:CompositionRef,review:CompositionTextReview)=>void};
type Preview={prompt:string;review:CompositionTextReview;composition:CompositionRef;excluded:number};
type Source={documentId:string;revision:string;composition:CompositionRef;key:string};
/** This is an explicit local text conversion, never a V45 caption-schema claim.
 * The ordinary immutable request review and provider admission still follow. */
export class CompositionTextEditing {
 private serial=0;private disposed=false;
 private reads=new Map<AbortController,Promise<unknown>>();
 private preview:OwnedModel<Preview>|null=null;
 private owner:{draft:Draft;owns:()=>boolean;release:()=>void}|null=null;
 private retired=new Set<OwnedModel<Preview>>();private releaseTask:Promise<void>|undefined;
 constructor(private host:LitElement,private editor:EditorClient,private hooks:Hooks){}
 private retire(){
  if(this.releaseTask)return this.releaseTask;if(!this.retired.size)return Promise.resolve();
  const batch=[...this.retired],task=Promise.resolve().then(()=>{this.host.requestUpdate();return this.host.updateComplete;}).then(()=>{for(const prior of batch){prior.release();this.retired.delete(prior);}});
  this.releaseTask=task;void task.then(()=>{if(this.releaseTask===task)this.releaseTask=undefined;if(this.retired.size)return this.retire();},()=>{if(this.releaseTask===task)this.releaseTask=undefined;}).catch(()=>{});return task;
 }
 private clear(){const prior=this.preview,owner=this.owner;this.preview=null;this.owner=null;if(prior)this.retired.add(prior);try{owner?.release();}finally{if(this.retired.size)void this.retire().catch(()=>{});else this.host.requestUpdate();}}
 cancel(){this.serial++;for(const abort of this.reads.keys())abort.abort();this.clear();}
 async dispose(){this.disposed=true;this.cancel();await Promise.allSettled([...this.reads.values()]);const errors:unknown[]=[];while(this.retired.size){try{await this.retire();}catch(error){errors.push(error);if(errors.length>=2)throw new AggregateError(errors,'COMPOSITION_TEXT_RELEASE_INCOMPLETE');}}}
 private captureSource(){const document=this.editor.view.document,source=this.editor.view.image?.composition;if(!document||!source)throw Error('Choose a v4.5 request and an applied, approved Composition first.');return createOwnedModel<Source>('composition-text-source-context',modelPayloadBytes(source)*8+4096,()=>({documentId:document.id,revision:document.revision,composition:structuredClone(source),key:canonical(source)}),'prompt');}
 async prepare(){
  const draft=this.hooks.draft();
  if(this.disposed||draft?.kind!=='request-draft-v45-1')throw Error('Choose a v4.5 request and an applied, approved Composition first.');
  if(this.reads.size>=8||this.retired.size>=64)throw Error('Composition text reads or previews are still releasing.');
  this.cancel();const context=this.captureSource();let entryRelease:()=>void;try{entryRelease=this.hooks.hold();}catch(error){context.release();throw error;}
  const {documentId,revision,composition:source,key:sourceKey}=context.value,serial=this.serial,owner=this.hooks.owns(),abort=new AbortController(),release=()=>{try{context.release();}finally{entryRelease();}};let transferred=false;
  const owns=()=>!this.disposed&&!abort.signal.aborted&&serial===this.serial&&owner()&&this.hooks.draft()===draft&&canonical(this.editor.view.image?.composition??null)===sourceKey;
  const task=(async()=>{
   const current=await this.editor.ownedJSON<{composition:Composition|null;compositionRef:CompositionRef|null;bindings:Record<string,string>;layers:LayerValue[];revision:string}>('/api/v1/documents/'+documentId+'/composition?revision='+revision,'composition-text-source',{signal:abort.signal},owns,8*1024**2,'prompt');
   try{
    if(!owns())return;const view=current.value,c=view.composition;if(!c?.review||c.id!==source.id)throw Error('Apply Composition and approve its current local projection before exporting text.');
    if(view.revision!==revision||canonical(view.compositionRef)!==sourceKey||canonical(view.bindings)!==canonical(source.bindings))throw Error('Composition source identity changed. Preview the current version again.');
    const scratch=reservePromptPayload('composition-text-export',jsonPayloadUnits(view)*20+modelPayloadBytes(view)*2+65536);
    let next:OwnedModel<Preview>;
    try{const exported=exportCompositionText(c,view.layers,view.bindings),value={...exported,composition:source,excluded:c.elements.filter(element=>element.excluded).length};next=createOwnedModel('composition-text-preview',modelPayloadBytes(value)*2+4096,()=>structuredClone(value),'prompt');}
    finally{scratch.release();}
    if(!owns()){next.release();return;}this.clear();this.preview=next;this.owner={draft,owns,release};transferred=true;this.host.requestUpdate();await this.host.updateComplete;if(owns())this.host.querySelector<HTMLElement>('#request-composition-text-preview')?.focus();
   }finally{current.release();}
  })();this.reads.set(abort,task);this.host.requestUpdate();
  try{await task;}finally{this.reads.delete(abort);try{if(!transferred)release();}finally{this.host.requestUpdate();}}
 }
 accept(expected=this.preview){const owner=this.owner,preview=this.preview;if(!owner||!preview||preview!==expected||!owner.owns())throw Error('Composition, document or request changed. Preview the text again.');const value=preview.value;this.hooks.apply(owner.draft,value.prompt,value.composition,value.review);this.cancel();}
 render(action:(event:Event,work:()=>void|Promise<void>)=>void){
  const displayed=this.preview,preview=displayed?.value,valid=!!this.owner?.owns();
  return html`<en-button id="request-composition-text-prepare" ?disabled=${this.disposed||this.reads.size>0||!this.editor.view.image?.composition} @click=${(event:Event)=>action(event,()=>this.prepare())}>Preview Composition as plain text</en-button>
   <p>Preview a plain-text brief from your approved Composition.</p>
   ${preview?html`<en-card id="request-composition-text-preview" tabindex="-1"><h3>Review Composition text export</h3><en-textarea label="Exact Composition text brief" .value=${preview.prompt} readOnly .rows=${8}></en-textarea>
    <p>Source Composition ${preview.composition.id}. ${preview.excluded} explicitly excluded elements stay excluded. Positions describe the approved source frame ${preview.review.sourceProjection.frame.width??'auto'} × ${preview.review.sourceProjection.frame.height??'auto'}; output dimensions are reviewed separately. This brief cannot guarantee exact text or layout.</p>
    <p>Confirming replaces only this request's prompt with the displayed brief. Confirming does not generate an image. Prompt expansion and edit settings may rewrite the brief; review those settings and the final request before generating.</p>
    ${valid?nothing:html`<p>The source or request changed. Prepare a new preview.</p>`}
    <en-button id="request-composition-text-confirm" ?disabled=${!valid} @click=${(event:Event)=>action(event,()=>this.accept(displayed))}>Use reviewed plain-text brief</en-button><en-button id="request-composition-text-cancel" variant="secondary" @click=${(event:Event)=>action(event,()=>this.cancel())}>Cancel text export</en-button></en-card>`:nothing}`;
 }
}
