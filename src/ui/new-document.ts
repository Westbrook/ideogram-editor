import {html,nothing,type LitElement} from 'lit';
import type {EditorClient} from '../state/editor-client.js';
import type {Document,DocumentCreationBackground} from '../protocol/store.js';
import {validDocumentName} from '../protocol/document-creation.js';
import type {OwnedModel} from '../observability/model-memory.js';
import {ControlAdapter} from './adapters.js';
import {DialogOwnership} from './dialog-ownership.js';

type Draft={name:string;width:string;height:string;background:'transparent'|'solid';color:string};
type Issue={target:'new-name'|'new-width'|'new-height'|'new-background-color'|'new-document-create';message:string};
const defaults=():Draft=>({name:'Untitled document',width:'1024',height:'1024',background:'transparent',color:'#FFFFFF'});
const dimensions=(raw:string)=>raw.trim()!==''&&/^\d+$/.test(raw.trim())&&Number.isSafeInteger(Number(raw))&&Number(raw)>=1&&Number(raw)<=8192;
export function documentDisplayName(document:Pick<Document,'id'|'metadata'>):string{return document.metadata?.name??'Untitled document';}
/** Raw fields are bounded separately from the accepted UTF-8 protocol name. */
export function validateNewDocumentDraft(draft:Draft):Issue[]{
  const issues:Issue[]=[],name=draft.name.trim();
  if(!validDocumentName(name)||/[\u0000-\u001f\u007f]/.test(draft.name))issues.push({target:'new-name',message:'Enter a document name of 1–256 UTF-8 bytes without control characters.'});
  if(!dimensions(draft.width))issues.push({target:'new-width',message:'Width must be a whole number from 1 to 8192 pixels.'});
  if(!dimensions(draft.height))issues.push({target:'new-height',message:'Height must be a whole number from 1 to 8192 pixels.'});
  if(dimensions(draft.width)&&dimensions(draft.height)&&Number(draft.width)*Number(draft.height)>25_000_000)issues.push({target:'new-width',message:'Width × height must not exceed 25,000,000 pixels. Change either dimension.'});
  if(draft.background==='solid'&&!/^#[0-9a-fA-F]{6}$/.test(draft.color))issues.push({target:'new-background-color',message:'Enter an opaque sRGB color as #RRGGBB, for example #FFFFFF.'});
  return issues;
}

/** This draft belongs to the workspace, so a successful Create can open the
 * new document without awaiting its own document-release callback. */
export class NewDocumentControls{
  private controls=new ControlAdapter();private draft:Draft|null=null;private lease:OwnedModel<{draft:Draft|null;issues:Issue[]}>|null=null;private memory:DialogOwnership;private disposed=false;
  private issues:Issue[]=[];private epoch=0;private interaction=0;private abort=new AbortController();private opened=false;private composing=false;private submitting=false;private pending:Promise<void>|null=null;
  constructor(private host:LitElement,private editor:EditorClient,private close:()=>void){this.memory=new DialogOwnership(host,'new-document-ui');for(const type of ['pointerdown','keydown','focusin'])host.addEventListener(type,()=>{this.interaction++;},{capture:true,signal:this.abort.signal});}
  private changed(){this.host.requestUpdate();}
  private publish(create:()=>{draft:Draft|null;issues:Issue[]}){const next=this.memory.create(8192,create),prior=this.lease;this.lease=next;this.draft=next.value.draft;this.issues=next.value.issues;if(prior)void this.memory.retire(prior).catch(error=>this.editor.fail(error));}
  private problems(issues:()=>Issue[]){this.publish(()=>({draft:this.draft,issues:issues()}));}
  private action(event:Event,work:()=>void){let release:()=>void;try{release=this.memory.action([this.lease],{epoch:this.epoch});}catch(error){event.preventDefault();this.editor.fail(error);return;}this.controls.action(event,()=>{try{work();}catch(error){this.editor.fail(error);}});setTimeout(release,0);}
  begin(){
    if(this.disposed)throw Error('NEW_DOCUMENT_DISPOSED');
    this.publish(()=>({draft:this.draft??defaults(),issues:[]}));this.opened=true;this.composing=false;this.epoch++;this.changed();
  }
  cancel(){
    this.epoch++;this.controls.invalidate();this.opened=false;this.composing=false;this.draft=null;this.issues=[];const lease=this.lease;this.lease=null;
    if(lease)void this.memory.retire(lease).catch(error=>this.editor.fail(error));else this.changed();
  }
  /** Document replacement retires visible UI, but Create is the workspace
   * action that can be awaiting that replacement. Never await it here. */
  async releaseView(){const errors:unknown[]=[];try{this.cancel();}catch(error){errors.push(error);}try{await this.memory.drainRetired();}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'NEW_DOCUMENT_VIEW_RELEASE_FAILED');}
  async dispose(){this.disposed=true;this.abort.abort();const errors:unknown[]=[];try{this.cancel();}catch(error){errors.push(error);}await Promise.allSettled(this.pending?[this.pending]:[]);try{await this.memory.drain();}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'NEW_DOCUMENT_RELEASE_FAILED');}
  get lifecycle(){return {...this.memory.lifecycle,pending:this.pending?1:0};}
  private owns(epoch:number,identity:string|null,session:string){return !this.disposed&&this.opened&&this.epoch===epoch&&this.editor.session.identity()===identity&&this.editor.sessionId===session;}
  private field(event:Event,key:keyof Draft,max:number,epoch:number,identity:string|null,session:string){
    const control=event.currentTarget as HTMLElement&{value:string};if(!this.owns(epoch,identity,session)){event.preventDefault();return;}
    let release:()=>void;try{release=this.memory.action([this.lease],{epoch,key});}catch(error){this.controls.write(control,'value',this.draft?.[key]??'');this.editor.fail(error);return;}
    this.controls.settled(event,()=>control.value,value=>{try{
      if(!this.owns(epoch,identity,session)||!this.draft||this.submitting)return;
      // The native field also has maxLength; no unbounded copy enters the model.
      if(value.length>max){this.controls.write(control,'value',this.draft[key]);this.problems(()=>[{target:key==='name'?'new-name':key==='height'?'new-height':key==='color'?'new-background-color':'new-width',message:'This field exceeds its stated input limit.'}]);this.changed();return;}
      if(key==='background'&&value!=='transparent'&&value!=='solid')return;
      try{this.publish(()=>({draft:{...this.draft!,[key]:value},issues:[]}));}catch(error){this.controls.write(control,'value',this.draft[key]);throw error;}this.changed();
    }catch(error){this.editor.fail(error);}});queueMicrotask(release);
  }
  private focus(target:string,priorInteraction?:number){const epoch=this.epoch,release=this.memory.action([this.lease],{epoch,target});void Promise.resolve().then(()=>{this.changed();return this.host.updateComplete;}).then(()=>{if(!this.disposed&&this.opened&&epoch===this.epoch&&(priorInteraction===undefined||this.interaction===priorInteraction))this.host.querySelector<HTMLElement>('#'+target)?.focus();}).catch(error=>this.editor.fail(error)).finally(release);}
  private focusSummary(priorInteraction?:number){this.focus('new-document-errors',priorInteraction);}
  private focusInvalid(){const target=this.issues[0]?.target;if(target)this.focus(target);}
  private navigate(event:Event){
    if(event.defaultPrevented)return;const target=(event as CustomEvent).detail?.data?.target;
    if(!this.issues.some(issue=>issue.target===target))return;event.preventDefault();this.host.querySelector<HTMLElement>('#'+target)?.focus();
  }
  private unresolved(){return this.editor.view.pendingCreate;}
  submit(event:Event,renderEpoch=this.epoch,renderIdentity=this.editor.session.identity(),renderSession=this.editor.sessionId){
    if(!this.owns(renderEpoch,renderIdentity,renderSession)){event.preventDefault();return;}
    this.action(event,()=>{
      if(!this.owns(renderEpoch,renderIdentity,renderSession)||!this.draft||this.submitting||this.composing||!this.editor.view.ready||this.editor.view.busy||this.unresolved())return;
      this.problems(()=>validateNewDocumentDraft(this.draft!));if(this.issues.length){this.focusInvalid();return;}
      const draft=this.draft,epoch=this.epoch,identity=this.editor.session.identity(),session=this.editor.sessionId,unpin=this.memory.action([this.lease],{epoch,identity,session}),priorInteraction=this.interaction;
      const color=draft.color;const background:DocumentCreationBackground=draft.background==='transparent'?{kind:'transparent'}:{kind:'solid',color:[parseInt(color.slice(1,3),16),parseInt(color.slice(3,5),16),parseInt(color.slice(5,7),16),255]};
      this.submitting=true;
      const pending=Promise.resolve().then(()=>{this.changed();return this.editor.run('Create document',async()=>{
        if(!this.owns(epoch,identity,session))return;
        try{await this.editor.create(Number(draft.width),Number(draft.height),{name:draft.name.trim(),background});}
        catch(error){
          if(this.owns(epoch,identity,session)){
            const raw=error instanceof Error?error.message:'Document creation failed.',message=raw.slice(0,512);
            const storage=raw.length<=512&&!/STALE|CHANGED|CONFLICT/.test(message)&&/STORAGE_FULL|waiting-for-resources|CAPACITY/.test(message);
            const explanation=storage?'Storage paused. Original bytes and command identities are retained. Free resources, then retry the same operation.':message;
            this.problems(()=>[{target:'new-document-create',message:explanation+' Your dialog draft is retained.'}]);this.focusSummary(priorInteraction);
          }
          throw error;
        }
        if(this.owns(epoch,identity,session))this.close();
      },event.timeStamp);}).finally(()=>{unpin();if(this.pending===pending){this.pending=null;this.submitting=false;this.changed();}});
      this.pending=pending;void pending.catch(error=>this.editor.fail(error));
    });
  }
  fields(){
    const draft=this.draft;if(!this.opened||!draft)return nothing;const disabled=this.submitting;
    const epoch=this.epoch,identity=this.editor.session.identity(),session=this.editor.sessionId,owns=()=>this.owns(epoch,identity,session);
    const field=(key:keyof Draft,max:number)=>(event:Event)=>this.field(event,key,max,epoch,identity,session),error=(target:Issue['target'])=>this.issues.find(issue=>issue.target===target)?.message??'';
    return html`<section aria-label="New document settings" @compositionstart=${()=>{if(owns()){this.composing=true;this.changed();}}} @compositionend=${()=>{if(owns()){this.composing=false;this.changed();}}}>
      <p>Create a named sRGB, 8-bit document. Solid color creates an actual Background raster layer.</p>
      <en-validation-summary id="new-document-errors" heading="New document needs attention" .items=${this.issues} @en-action=${(event:Event)=>{if(owns())this.navigate(event);}}></en-validation-summary>
      <en-text-field id="new-name" label="Document name" description="1–256 UTF-8 bytes. Leading and trailing spaces are removed when created." .value=${draft.name} .error=${error('new-name')} .maxLength=${256} ?disabled=${disabled} @en-input=${field('name',256)} @en-change=${field('name',256)}></en-text-field>
      <en-number-field id="new-width" label="Width (px)" .value=${draft.width} .error=${error('new-width')} .min=${1} .max=${8192} .step=${1} ?disabled=${disabled} @en-input=${field('width',16)} @en-change=${field('width',16)}></en-number-field>
      <en-number-field id="new-height" label="Height (px)" .value=${draft.height} .error=${error('new-height')} .min=${1} .max=${8192} .step=${1} ?disabled=${disabled} @en-input=${field('height',16)} @en-change=${field('height',16)}></en-number-field><p>Up to 8192 pixels per side and 25,000,000 pixels in total.</p>
      <en-select id="new-background" label="Background" .value=${draft.background} ?disabled=${disabled} @en-change=${field('background',11)}><en-select-option value="transparent">Transparent</en-select-option><en-select-option value="solid">Solid color</en-select-option></en-select>
      ${draft.background==='solid'?html`<en-text-field id="new-background-color" label="Background color (opaque sRGB hex)" description="Opaque color, alpha 255. Enter #RRGGBB; for example #336699." .value=${draft.color} .error=${error('new-background-color')} .maxLength=${7} ?disabled=${disabled} @en-input=${field('color',7)} @en-change=${field('color',7)}></en-text-field>`:html`<p>Transparent starts with no layers. The checkerboard is a display aid.</p>`}
      ${this.unresolved()?html`<p id="new-document-pending" role="status">A document creation receipt is unresolved. Close this dialog and use “Check and retry original” before creating another document.</p>`:nothing}
      ${error('new-document-create')?html`<p id="new-document-submit-error">${error('new-document-create')}</p>`:nothing}
      ${this.composing?html`<p role="status">Finish composing the current field before creating the document.</p>`:nothing}
    </section>`;
  }
  createButton(){const epoch=this.epoch,identity=this.editor.session.identity(),session=this.editor.sessionId,description=[this.unresolved()?'new-document-pending':'',this.issues.some(issue=>issue.target==='new-document-create')?'new-document-submit-error':''].filter(Boolean).join(' ');return html`<en-button id="new-document-create" ?disabled=${this.submitting||this.composing||!this.editor.view.ready||this.editor.view.busy||this.unresolved()} aria-describedby=${description||nothing} @click=${(event:Event)=>this.submit(event,epoch,identity,session)}>Create</en-button>`;}
}
