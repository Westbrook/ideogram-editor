import {NativeControlMemory,NATIVE_CONTROL_LIMITS,nativeDiagnostic} from './native-control-memory.js';
import {measureControl} from '../state/control-memory.js';
import {PromptReaderCleanupError} from '../observability/prompt-memory.js';
import {validString} from '../composition/core.js';
import {makeReturnedDescriptionReview,validateReturnedDescriptionSelection,type ReturnedTextProposal,type ReturnedDescriptionSelection} from '../text/returned-description.js';
import {html,nothing,type LitElement} from 'lit';
import {EditingController} from '@en-reve/primitives/interactions/editing-controller.js';
import {createDraftModel} from '@en-reve/primitives/state/draft.js';
import type {DraftInputDetail} from '@en-reve/primitives/interactions/events.js';
import type {EditorClient} from '../state/editor-client.js';
import type {Document,BlobRef} from '../protocol/store.js';
import type {ImageLayer} from '../protocol/history.js';
import type {FontVersion,TextSource,TextDraft,TextStyle,TextPlacement} from '../protocol/text.js';
import type {Draft} from '../protocol/ui.js';
import {TextRenderer,releasePrepared,textMemory,type TextRequest} from '../text/client.js';
import {DurableTextPreparation,releaseTextRealm,type TextStorage} from '../text/durable.js';
import {textPlacement} from '../protocol/text.js';
import {TextFailure,hashBytes,cancelTextAssetResponse,readTextAssetResponse,retryTextAssetCleanup,retainTextAssetCleanup,LIMITS} from '../text/contracts.js';
import {canonical} from '../protocol/json.js';
import {ControlAdapter} from './adapters.js';
import {TextLibrary,fontChoices} from './text-library.js';
import {browserPhases} from '../observability/browser.js';
import type {PhaseSpan} from '../observability/phases.js';
import {allocationLedger,type AllocationLease} from '../observability/allocations.js';
import {hashRelinkInputs} from './font-relink.js';
import {cloneOwnedModel,modelPayloadBytes,type OwnedModel} from '../observability/model-memory.js';
import {paintTextPreview} from './native-text-preview.js';

class AdmittedEditingBridge extends EditingController {
  constructor(host:LitElement,options:ConstructorParameters<typeof EditingController>[1],private paused:()=>boolean,private finishAdmitted:()=>void){super(host,options);}
  override sync(){if(!this.paused?.())super.sync();}
  override hostDisconnected(){if(this.paused())this.finishAdmitted();super.hostDisconnected();}
  reset(reconnect:boolean){this.finishAdmitted();super.hostDisconnected();if(reconnect)super.hostConnected();}
}
type TextFocusReturn={epoch:number;documentId:string|undefined;documentRevision:string|undefined};
type Presentation='anchored'|'inspector';
type PresentationRequest={sequence:number;target:Presentation;epoch:number;revision:number;textRevision:number;documentRevision:string;layerVersion:string};
type PresentationIdentity=Pick<PresentationRequest,'sequence'|'epoch'|'revision'|'textRevision'>;
type PresentationRejection='superseded'|'stale-session'|'stale-generation'|'stale-text-version'|'stale-version'|'cancelled';
type NativeDocument=Pick<Document,'id'|'revision'|'width'|'height'>;
type NativeLayer=Pick<ImageLayer,'id'|'version'|'name'|'locked'|'kind'>;
type NativeDraft=Pick<Draft,'id'|'targetLayerId'|'expectedDocumentRevision'>;
type NativeViewSnapshot={document:NativeDocument;readRevision:string;layer:NativeLayer|null;draft:NativeDraft|null;returned?:ReturnedTextProposal};
type Session={id:string;document:NativeDocument;layerId:string;layerVersion:string;name:string;draftId:string;original?:TextSource;locked:boolean;text:string;style:TextStyle;frame:{width:number;height:number};fonts:FontVersion[];placement?:TextPlacement;description?:ReturnedDescriptionSelection};
type Preview={revision:number;hash:string;overflow:boolean;width:number;height:number;pixels:Uint8ClampedArray<ArrayBuffer>;id:string;generation:number;layerVersion:string;textHash:string;dependencyHash:string};
export class NativeTextEditing {
  readonly control=document.createElement('textarea');
  private model=createDraftModel();private bridge:AdmittedEditingBridge;private adapter=new ControlAdapter();
  private session?:Session;private epoch=0;private revision=0;private textRevision=0;private focusEpoch=0;private presentationEpoch=0;private presentation:Presentation='anchored';
  private pendingSwitch?:PresentationRequest;private pendingSwitchOwner?:OwnedModel<PresentationRequest>;private pendingSwitchCancelled=false;private cancelIntentEpoch?:number;private cancelFocusEpoch?:number;private cancelDispatchEpoch?:number;private pendingAction?:'apply'|'cancel';private timer?:ReturnType<typeof setTimeout>;
  private pendingActionTime?:number;private inputPhase?:{span:PhaseSpan;epoch:number};
  private sessionDraftOwners=new WeakMap<Session,EditorClient['draftOwner']>();
  private sessionOwners=new WeakMap<Session,OwnedModel<Session>>();
  private renderPins=new Map<Session,()=>void>();private renderSequence=0;private renderCommit?:Promise<void>;
  private switchFrame?:number;private switchCancel?:()=>void;
  private switchRequestSequence=0;private switchRequestEpoch=0;private switchRequestGeneration=0;private switchSettled=0;private switchRejected=0;private switchSuperseded=0;private switchReason:PresentationRejection|''='';
  private switchRejectedEpoch=0;private switchRejectedGeneration=0;private switchRejectedCurrentEpoch=0;private switchRejectedCurrentGeneration=0;
  private switchRequestTextVersion=0;private switchRejectedTextVersion=0;private switchRejectedCurrentTextVersion=0;private switchRejectedGuards=0;private switchRejectedBoundary='';
  private previewLease?:{release():void};
  private previewSurfaceLease?:AllocationLease;
  private readCleanupErrors=new Set<unknown>();private stageOwners=new Set<OwnedModel<BlobRef>>();
  private renderer?:TextRenderer;private preparation?:DurableTextPreparation;private preview?:Preview;
  private opener?:HTMLElement;private restoring='';private restoringEpoch=0;private work=0;
  private preparedHash='';private fontLoadFailed=false;private library:TextLibrary;private storage:TextStorage;private files:readonly File[]=[];private licenses:readonly File[]=[];
  private abort=new AbortController();private reads=new AbortController();private pending=new Set<Promise<unknown>>();private closing=false;private disposed=false;private releasing?:Promise<void>;private embeddingReviewed=false;
  private inputProposal=0;private capacityError=false;private nativeRefused=false;private nativeComposing=false;private nativeLease?:AllocationLease;private compositionUnits=0;private inputCandidate?:OwnedModel<Session>;
  private memory:NativeControlMemory;private formOwner?:OwnedModel<typeof this.form>;
  private form={error:'',message:'',fontId:fontChoices[0].id,fontStatus:'Exact font selected'};
  private actionLifetime=0;
  private fileOwners=new Map<'files'|'licenses',OwnedModel<readonly File[]>>();private actionTimers=new Map<ReturnType<typeof setTimeout>,()=>void>();
  private get error(){return this.capacityError?'Text workspace is full. Full native input remains available; shorten it or release another preview, then edit again to save. The previous saved draft is retained.':this.form.error;}
  private set error(value:string){this.fontLoadFailed=false;this.setForm('error',nativeDiagnostic(value));}
  private get message(){return this.form.message;}private set message(value:string){this.setForm('message',value);}
  private get fontId(){return this.form.fontId;}private set fontId(value:string){this.setForm('fontId',value);}
  private get fontStatus(){return this.form.fontStatus;}private set fontStatus(value:string){this.setForm('fontStatus',value);}
  private setForm(key:keyof NativeTextEditing['form'],value:string){
    if(this.form[key]===value)return true;if(value.length>NATIVE_CONTROL_LIMITS.diagnosticUnits){this.capacityError=true;return false;}
    try{const next=this.memory.create('form',(modelPayloadBytes(this.form)-this.form[key].length*2+value.length*2)*2,()=>({...this.form,[key]:value}),form=>modelPayloadBytes(form)*2),old=this.formOwner;this.form=next.value;this.formOwner=next;if(old)this.memory.retire(old);return true;}catch{this.capacityError=true;return false;}
  }
  private commitSession(next:OwnedModel<Session>,draftOwner=this.session?this.sessionDraftOwners.get(this.session):this.editor.draftOwner){
    const prior=this.session;if(!prior||prior.text!==next.value.text)this.textRevision++;this.sessionOwners.set(next.value,next);this.sessionDraftOwners.set(next.value,draftOwner);this.session=next.value;if(prior){const old=this.sessionOwners.get(prior);if(old)this.memory.retire(old);}return next.value;
  }
  // Each live/rendered generation also reserves 8 KiB for its derived template
  // strings: <=16 fixed/local font labels (<=64 units each), <=16 numeric fields
  // (<=25 units), RGB/ARIA attributes and both live control/template aliases.
  // Layer-name aliases are separately sized for its two rendered text nodes;
  // the fixed allowance includes the validated 71-unit prepared pixel identity.
  // Native text itself is never interpolated into a Lit value binding.
  private ownSession(create:()=>Session,allowance:number,nameUnits:number){
    const model=this.memory.create('session',allowance+8192+nameUnits*4,create,value=>{if(value.fonts.length>16)throw Error('FONT_SELECTION_LIMIT');return modelPayloadBytes(value)+8192+value.name.length*4;});let releaseDraft:()=>void;
    try{releaseDraft=this.editor.registerDraft(model.value.draftId,model.value.document.id);}catch(error){model.release();throw error;}
    // Register before this generation can become editable. Its admission survives
    // until the same real action/render consumers release the Session generation.
    let refs=1,live=true;const unref=()=>{if(!--refs){model.release();releaseDraft();}};
    return Object.freeze({value:model.value,release:()=>{if(live){live=false;unref();}},pin:()=>{if(!refs)throw Error('NATIVE_TEXT_SESSION_UNOWNED');refs++;let pinned=true;return ()=>{if(pinned){pinned=false;unref();}};}});
  }
  private proposeSession(current:Session,extra:number,change:(next:Session)=>void){return this.ownSession(()=>{const next=structuredClone(current);change(next);return next;},modelPayloadBytes(current)+extra,current.name.length);}
  private admitNative(text:string,initial=false,compositionUnits=this.compositionUnits){
    // Accepted draft-model value, previous draft during dispatch, incoming draft,
    // native value and the bridge's last composition alias. This is logical
    // UTF-16 content, not the browser's private native undo/history allocation.
    const bytes=2*((initial?text.length:this.model.value.get().length)+(initial?text.length:this.model.draft.get().length)+text.length*2+compositionUnits);
    if(this.nativeLease)this.nativeLease.resize({cpuBytes:bytes});else this.nativeLease=this.memory.workspace('edit-values',bytes,4);
  }
  private settleNativeBooking(){const epoch=this.epoch;queueMicrotask(()=>{if(epoch!==this.epoch||this.nativeRefused||!this.nativeLease)return;try{this.admitNative(this.control.value);}catch{this.refuseNative();}});}
  private refuseNative(){
    this.nativeRefused=true;this.capacityError=true;const s=this.session;if(s&&this.sameDraftOwner(s))this.editor.draftOwner?.refuseChange(s.draftId,s.document.id);this.changed();
  }
  private captureNative(event:Event){
    const s=this.session;if(!s||!this.available()){
      event.stopImmediatePropagation();
      if(event.type==='compositionend'&&this.cancelIntentEpoch!==undefined){this.rejectPendingSwitch('cancelled','cancel-unavailable');this.pendingAction=undefined;this.pendingActionTime=undefined;this.cancelIntentEpoch=undefined;this.cancelFocusEpoch=undefined;}
      this.nativeComposing=false;this.model.endComposition('');this.model.setValue('');this.control.value='';return;
    }
    if(event.type==='compositionstart')this.nativeComposing=true;if(event.type==='compositionend')this.nativeComposing=false;if(event.type==='input')this.nativeComposing=(event as InputEvent).isComposing===true;
    const value=this.control.value,nextCompositionUnits=event.type==='compositionstart'?0:event.type==='compositionend'?value.length:event.type==='input'&&!(event as InputEvent).isComposing?0:this.compositionUnits;let next:OwnedModel<Session>|undefined;
    try{if(value!==s.text)next=this.proposeSession(s,Math.max(0,(value.length-s.text.length)*2),candidate=>{candidate.text=value;});this.admitNative(value,false,this.compositionUnits+nextCompositionUnits);
      this.inputCandidate?.release();this.inputCandidate=next;next=undefined;this.nativeRefused=false;
      this.compositionUnits=nextCompositionUnits;
      if(event.type==='change'&&!this.composing)this.input({value,isComposing:false,inputType:'change'},true);
      const proposal=++this.inputProposal;queueMicrotask(()=>{if(this.inputProposal===proposal){this.inputCandidate?.release();this.inputCandidate=undefined;}this.settleNativeBooking();});
    }catch{next?.release();event.stopImmediatePropagation();if(event.type==='compositionend')this.model.endComposition(this.model.draft.get());this.refuseNative();}
  }
  private deferredAction(event:Event,work:()=>void){
    let release:()=>void;try{release=this.memory.action();}catch{this.capacityError=true;this.changed();return;}
    const target=event.currentTarget as Node,lifetime=this.actionLifetime;const timer=setTimeout(()=>{this.actionTimers.delete(timer);try{if(!event.defaultPrevented&&target.isConnected&&lifetime===this.actionLifetime&&this.available())work();}catch(error){this.error=nativeDiagnostic(error);this.editor.fail(error);this.changed();}finally{release();}},0);this.actionTimers.set(timer,release);
  }
  private filesChanged(event:Event,key:'files'|'licenses',epoch:number){
    const host=event.currentTarget as HTMLElement&{files:readonly File[]};let candidate:OwnedModel<readonly File[]>|undefined;
    try{const files=host.files;if(files.length>1)throw Error('Choose one file for this field.');const file=files[0],limit=key==='files'?LIMITS.faceBytes:65536;if(file&&(!(file instanceof File)||file.size>limit||file.name.length>4096||file.type.length>256))throw Error('File exceeds the local font or license allowance.');
      /* File handles may be disk-backed; size is an admission limit, not RAM. */const bytes=file?(file.name.length+file.type.length)*2+16:0;candidate=this.memory.create('selected-file',bytes,()=>file?[file]:[],()=>bytes);
    }catch(error){event.preventDefault();this.adapter.write(host,'files',this[key]);this.error=nativeDiagnostic(error);this.changed();return;}
    this.adapter.settled(event,()=>true,()=>{if(!this.available()||epoch!==this.epoch||!this.session)return;const next=candidate!;candidate=undefined;const old=this.fileOwners.get(key);this.fileOwners.set(key,next);this[key]=next.value;if(old)this.memory.retire(old);this.changed();});queueMicrotask(()=>candidate?.release());
  }
  private fieldValue(label:string,s:Session):string{
    const values:Record<string,number|string>={'New text X (document px)':s.placement?.x??0,'New text Y (document px)':s.placement?.y??0,'Text size (document px)':s.style.sizePx,'Line height multiplier':s.style.lineHeightMultiplier,'Text alignment':s.style.align,'Text direction':s.style.direction,'Text alpha (0–255)':s.style.fill[3],'Text frame width (document px)':s.frame.width,'Text frame height (document px)':s.frame.height};
    return label==='Text fill'?'#'+s.style.fill.slice(0,3).map(n=>n.toString(16).padStart(2,'0')).join(''):String(values[label]);
  }
  private async readControl<T>(path:string){
    try{return await this.editor.ownedJSON<T>(path,'native-descriptor',{signal:this.reads.signal},()=>!this.reads.signal.aborted,65536,'prompt');}
    catch(error){if(error instanceof PromptReaderCleanupError)this.controlCleanup.add(error);throw error;}
  }
  private controlCleanup=new Set<PromptReaderCleanupError>();
  constructor(private host:LitElement,private editor:EditorClient,private draw:()=>void,private screenPoint:(p:readonly [number,number])=>readonly [number,number]){
    this.memory=new NativeControlMemory(host);
    allocationLedger.observeTextReservations(()=>textMemory.snapshot.textBytes,textMemory);
    this.library=new TextLibrary(editor);
    this.storage={admit:id=>this.admission(id),releaseAdmission:id=>this.admission(id,true),stage:async(blob,media)=>{const s=this.session,epoch=this.epoch,revision=this.revision;if(!s)throw Error('TEXT_DOCUMENT_RELEASED');this.assert(s,epoch,revision);let workspace:AllocationLease|undefined;try{if(media==='application/json'&&blob.size<=65536){/* UTF-16 decode + bounded parsed logical JSON, retained through upload. */workspace=this.memory.workspace('candidate-json',blob.size*6+8,3);const candidate=JSON.parse(await blob.text());this.assert(s,epoch,revision);if(candidate.source?.render){const hash=candidate.source.render.pixels.hash;if(typeof hash!=='string'||!/^sha256:[a-f0-9]{64}$/.test(hash))throw Error('TEXT_CANDIDATE_HASH');this.preparedHash=hash;}}if(this.stageOwners.size>=16)throw Error('TEXT_STAGE_REFERENCES');const result=await editor.ownedStageTextBlob(blob,media,'text',()=>this.owns(s,epoch,revision));try{this.assert(s,epoch,revision);this.stageOwners.add(result);return result.value;}catch(error){result.release();throw error;}}finally{workspace?.release();}}};
    this.control.id='native-text-content';this.control.rows=6;this.control.spellcheck=false;this.control.setAttribute('aria-describedby','native-text-policy');
    for(const type of ['input','change','compositionstart','compositionend'])this.control.addEventListener(type,e=>this.captureNative(e),{capture:true});
    this.control.addEventListener('beforeinput',e=>this.observeInput(e),{capture:true});
    this.control.addEventListener('input',e=>this.observeInput(e),{capture:true});
    this.bridge=new AdmittedEditingBridge(host,{model:this.model,control:()=>this.control,onInput:d=>{if(d.value===this.model.draft.get()&&d.value===this.control.value)this.input(d,true);},adoptInitialValue:()=>false},()=>this.nativeRefused,()=>this.model.endComposition(this.model.draft.get()));
    this.control.addEventListener('keydown',e=>this.key(e));
    this.control.addEventListener('compositionend',()=>this.settle());
    // Any later deliberate focus cancels a scheduled restoration, even in public shadow controls.
    document.addEventListener('focusin',()=>{this.focusEpoch++;},{signal:this.abort.signal});
    for(const type of ['pointerdown','keydown','wheel'])document.addEventListener(type,()=>{this.focusEpoch++;},{capture:true,signal:this.abort.signal});
  }
  get active(){return !!this.session;}
  get lifecycle(){return Object.freeze({activeSession:!!this.session,closing:this.closing,pendingOperations:this.pending.size,retainedTextUnits:this.model.value.get().length+this.model.draft.get().length+this.control.value.length,retainedFiles:this.files.length+this.licenses.length,previewBytes:this.preview?.pixels.byteLength??0,rendererWorkers:(this.renderer?.lifecycle.activeWorkers??0)+(this.renderer?.lifecycle.idleWorkers??0),activePreparations:this.preparation?1:0,fontBackingBytes:this.library.lifecycle.retainedFontBytes,nativeInputRefused:this.nativeRefused,unadmittedNativeUnits:this.nativeRefused?this.control.value.length:0,controlMemory:this.memory.inspect(),queuedActions:this.actionTimers.size});}
  private track<T>(start:()=>Promise<T>):Promise<T>{let release:()=>void;try{release=this.memory.action();}catch(error){return Promise.reject(error);}let work:Promise<T>;try{work=start();}catch(error){release();return Promise.reject(error);}const pending=work.finally(()=>{release();this.pending.delete(pending);});this.pending.add(pending);void pending.catch(()=>{});return pending;}
  // View rows are borrowed only for this synchronous copy. The admitted thin
  // snapshot has its own lifetime and never retains image/history/layer arrays.
  private captureView(layer?:ImageLayer,draft?:Draft,returned?:ReturnedTextProposal):OwnedModel<NativeViewSnapshot>|undefined{
    const document=this.editor.view.document;if(!document||!this.editor.view.ready)return;
    const release=this.editor.pinViewModels(document,layer);
    try{return cloneOwnedModel('native-text-view',{document:{id:document.id,revision:draft?.expectedDocumentRevision??document.revision,width:document.width,height:document.height},readRevision:document.revision,layer:layer?{id:layer.id,version:layer.version,name:layer.name,locked:layer.locked,kind:layer.kind}:null,draft:draft?{id:draft.id,targetLayerId:draft.targetLayerId,expectedDocumentRevision:draft.expectedDocumentRevision}:null,...returned?{returned}:{}});}
    finally{release();}
  }
  private withSession<T>(session:Session,work:()=>Promise<T>):Promise<T>{
    const owner=this.sessionOwners.get(session);if(!owner)throw Error('NATIVE_TEXT_SESSION_UNOWNED');const releases=[owner.pin(),...Array.from(this.fileOwners.values(),file=>file.pin())];const release=()=>{for(const end of releases)end();};
    try{return work().finally(release);}catch(error){release();throw error;}
  }
  private retireSession(){this.fontLoadFailed=false;this.rejectPendingSwitch('stale-session');const session=this.session;this.session=undefined;this.cancelSwitchFrame();if(session){this.bridge.reset(!this.disposed);const owner=this.sessionOwners.get(session);if(owner)this.memory.retire(owner);this.nativeRefused=false;this.nativeComposing=false;this.model.endComposition('');this.model.setValue('');this.bridge.sync();this.control.value='';this.nativeLease?.release();this.nativeLease=undefined;this.compositionUnits=0;this.preparedHash='';this.inputCandidate?.release();this.inputCandidate=undefined;}}
  private available(){return !this.closing&&!this.disposed&&!this.readCleanupErrors.size&&!this.controlCleanup.size;}
  // The caller saves the draft and closed view before invoking this method. It
  // relinquishes only ephemeral ownership; Cancel is the separate draft deletion.
  releaseDocument():Promise<void>{
    if(this.releasing)return this.releasing;
    this.closing=true;this.actionLifetime++;this.nativeRefused=false;this.nativeComposing=false;this.compositionUnits=0;this.inputCandidate?.release();this.inputCandidate=undefined;for(const [timer,release]of this.actionTimers){clearTimeout(timer);release();}this.actionTimers.clear();this.epoch++;this.revision++;this.focusEpoch++;this.presentationEpoch++;
    clearTimeout(this.timer);this.timer=undefined;this.adapter.invalidate();this.reads.abort();this.library.invalidate();
    this.inputPhase?.span.end('cancelled');this.inputPhase=undefined;this.pendingActionTime=undefined;
    this.retireSession();this.pendingSwitch=undefined;this.pendingAction=undefined;this.cancelIntentEpoch=undefined;this.cancelFocusEpoch=undefined;this.cancelDispatchEpoch=undefined;this.opener=undefined;this.restoring='';this.restoringEpoch=0;
    this.model.endComposition('');this.model.setValue('');this.bridge.sync();this.control.value='';this.nativeLease?.release();this.nativeLease=undefined;this.control.setSelectionRange(0,0);this.control.scrollTop=0;this.control.scrollLeft=0;
    this.files=[];this.licenses=[];for(const file of this.fileOwners.values())this.memory.retire(file);this.fileOwners.clear();this.embeddingReviewed=false;if(this.formOwner)this.memory.retire(this.formOwner);this.formOwner=undefined;this.form={error:'',message:'',fontId:fontChoices[0].id,fontStatus:'Exact font selected'};this.capacityError=false;
    this.preparedHash='';this.presentation='anchored';this.clearPreview();
    const settling=[...this.pending];
    // Install the shared release promise before a native termination can fail.
    // Independent owners still drain; a failed renderer stays attached for the
    // next explicit release attempt instead of losing its retry handle.
    this.releasing=Promise.resolve().then(async()=>{
      const errors:unknown[]=[];
      try{this.renderer?.dispose();this.renderer=undefined;}catch(error){errors.push(error);}
      try{this.preparation?.dispose();this.preparation=undefined;}catch(error){errors.push(error);}
      await Promise.allSettled(settling);this.releaseStageOwners();
      try{await this.memory.drain();await this.host.updateComplete;await this.renderCommit;if(this.renderPins.size)throw Error('NATIVE_TEXT_RENDER_RETAINED');}catch(error){errors.push(error);}for(const error of this.controlCleanup)try{await error.retry();this.controlCleanup.delete(error);}catch(error){errors.push(error);}
      for(const error of this.readCleanupErrors){try{if(await retryTextAssetCleanup(error))this.readCleanupErrors.delete(error);}catch{}}
      if(this.readCleanupErrors.size)errors.push(new AggregateError([...this.readCleanupErrors],'TEXT_CONTENT_CLEANUP'));
      try{await this.library.releaseDocument();}catch(error){errors.push(error);}
      try{await releaseTextRealm(this.storage);}catch(error){errors.push(error);}
      if(errors.length)throw new AggregateError(errors,'TEXT_DOCUMENT_RELEASE_FAILED');
    }).finally(()=>{this.closing=false;this.releasing=undefined;if(!this.disposed)this.reads=new AbortController();this.changed();});
    this.changed();
    return this.releasing;
  }
  get composing(){return this.nativeComposing||this.model.isComposing.get();}
  get stale(){const s=this.session;return !!s&&(this.editor.sessionId!==s.id||this.sessionDraftOwners.get(s)!==this.editor.draftOwner||this.editor.view.document?.id!==s.document.id||this.editor.view.document?.revision!==s.document.revision);}
  private changed(){this.host.requestUpdate();this.draw();}
  private async admission(id:string,release=false){if(!release&&!this.available())throw Error('TEXT_DOCUMENT_RELEASED');try{await this.editor.withJSON('/api/v1/text-admission/'+id+(release?'/release':''),'native-admission',()=>undefined,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"protocolVersion":1}'});}catch(error){if(error instanceof PromptReaderCleanupError)this.controlCleanup.add(error);throw error;}}
  private clearPreview(){if(this.preview)this.preview.pixels=new Uint8ClampedArray(0);this.preview=undefined;const canvas=this.host.querySelector<HTMLCanvasElement>('#native-text-preview');if(canvas){canvas.width=0;canvas.height=0;}this.previewLease?.release();this.previewLease=undefined;this.previewSurfaceLease?.release();this.previewSurfaceLease=undefined;}
  private invalidate(){this.revision++;if(!this.pendingSwitchCancelled)this.rejectPendingSwitch('stale-generation');this.clearPreview();this.renderer?.cancel();this.preparation?.cancel();if(!this.fontLoadFailed)this.error='';this.changed();}
  private eventTime(event:Event){const now=browserPhases.recorder.timestamp();return Number.isFinite(event.timeStamp)&&event.timeStamp>=0&&event.timeStamp<=now?event.timeStamp:undefined;}
  private observeInput(event:Event){
    const s=this.session;if(!s||!this.available())return;
    if(event.type==='input'&&this.inputPhase)return;
    this.inputPhase?.span.end('incomplete',{boundary:'observed'});
    const phase={epoch:this.epoch,span:browserPhases.recorder.start('text.edit',{documentId:s.document.id,revision:s.document.revision,layerId:s.layerId,inputSource:event.isTrusted?'trusted-event':'synthetic-event',composing:(event as InputEvent).isComposing===true},this.eventTime(event))};
    this.inputPhase=phase;
    // A cancelled beforeinput may never produce input. Do not invent a paint.
    queueMicrotask(()=>{if(this.inputPhase===phase){this.inputPhase=undefined;phase.span.end(event.defaultPrevented?'cancelled':'incomplete',{boundary:'observed'});}});
  }
  private input(detail:DraftInputDetail,captured=false){
    const phase=this.inputPhase;this.inputPhase=undefined;
    const s=this.session;if(!s||!this.available()){phase?.span.end('cancelled');this.model.endComposition('');this.model.setValue('');this.bridge.sync();this.control.value='';return;}
    if(this.nativeRefused){phase?.span.end('error');return;}
    try{if(!captured)this.admitNative(detail.value);if(s.text!==detail.value){const next=this.inputCandidate?.value.text===detail.value?this.inputCandidate:this.proposeSession(s,Math.max(0,(detail.value.length-s.text.length)*2),candidate=>{candidate.text=detail.value;});this.inputCandidate=undefined;this.commitSession(next);this.invalidate();}this.save(detail.isComposing??false);if(!detail.isComposing)this.settle();}catch(error){if(this.sameDraftOwner(this.session!))this.editor.draftOwner?.refuseChange(this.session!.draftId,this.session!.document.id);this.capacityError=true;this.editor.fail(error);this.changed();}this.settleNativeBooking();
    if(phase)void this.host.updateComplete.then(()=>phase.span.end(this.session&&this.epoch===phase.epoch?'incomplete':'cancelled',{boundary:'render-submitted'}),()=>phase.span.end('error'));
  }
  private save(composing=this.composing,s=this.session){
    if(!s||s.locked||!this.sameDraftOwner(s))return;
    if(this.nativeRefused)throw Error('Full native input is outside the current text workspace; revise it before saving.');
    const base={text:'',style:s.style,frame:s.frame,fonts:s.fonts,...s.placement?{placement:s.placement}:{},...s.description?{description:s.description}:{}};let workspace:AllocationLease|undefined;
    try{const bytes=measureControl(base,65536).encodedBytes+s.text.length*6;/* Each UTF-16 unit may become six ASCII escape units during composition. */workspace=this.memory.workspace('save-json',bytes*2,1);const value=JSON.stringify({...base,text:s.text});this.editor.changeDraft(s.draftId,'text',value,s.original?s.layerId:null,composing,s.document.revision);this.capacityError=false;}catch(error){if(s===this.session)this.editor.draftOwner?.refuseChange(s.draftId,s.document.id);throw error;}finally{workspace?.release();}
  }
  private acceptSession(next:OwnedModel<Session>){
    const current=this.session!;this.sessionDraftOwners.set(next.value,this.sessionDraftOwners.get(current));const owner=this.editor.draftOwner,hadRefusal=owner?.hasRefusedChanges;
    try{this.save(this.composing,next.value);}catch(error){next.release();if(!hadRefusal){const saved=owner?.drafts.get(current.draftId);if(saved)owner?.acceptRetained(current.draftId,saved.text);}throw error;}this.commitSession(next);this.invalidate();
  }
  private settle(){
    clearTimeout(this.timer);const epoch=this.epoch;
    this.timer=setTimeout(()=>{if(epoch!==this.epoch||this.composing||!this.session)return;
      try{this.save(false);}catch(error){if(this.pendingSwitchCancelled)this.rejectPendingSwitch('cancelled','cancel-save-refused');this.capacityError=true;this.editor.fail(error);this.changed();return;}if(this.stale){this.rejectPendingSwitch(this.editor.sessionId!==this.session?.id?'stale-session':'stale-version');this.pendingAction=undefined;this.pendingActionTime=undefined;if(this.cancelDispatchEpoch===undefined){this.cancelIntentEpoch=undefined;this.cancelFocusEpoch=undefined;}this.changed();return;}
      const action=this.pendingAction,intentTime=this.pendingActionTime;this.pendingAction=undefined;this.pendingActionTime=undefined;
      if(action==='cancel'){this.runCancel();return;}
      if(this.pendingSwitchCancelled){if(this.cancelDispatchEpoch!==undefined)return;this.rejectPendingSwitch('cancelled','cancel-not-retired');this.changed();return;}
      const target=this.pendingSwitch,owner=this.pendingSwitchOwner;this.pendingSwitch=undefined;this.pendingSwitchOwner=undefined;this.pendingSwitchCancelled=false;
      try{const work=target?this.switchTo(target.target,target):undefined;if(work)void work.finally(()=>owner?.release()).catch(()=>{});else owner?.release();}catch(error){owner?.release();throw error;}
      if(action==='apply')void this.run('Apply text',()=>this.apply(intentTime));
      this.changed();
    },0);
  }
  private runCancel(focus=this.focusEpoch){
    if(this.cancelDispatchEpoch!==undefined)return;
    const intent=this.cancelIntentEpoch??this.epoch,sequence=this.pendingSwitch?.sequence;this.cancelIntentEpoch=intent;this.cancelFocusEpoch??=focus;this.cancelDispatchEpoch=intent;
    void this.run('Cancel text edit',()=>this.cancel(),this.cancelFocusEpoch).finally(()=>{
      // The intent fence also covers the dispatcher's async tick and cleanup.
      // Never clear a successor session's independently queued Cancel.
      if(this.cancelDispatchEpoch!==intent)return;this.cancelDispatchEpoch=undefined;if(this.cancelIntentEpoch!==intent)return;
      // Native composition may restart while the dispatcher awaits its tick.
      // cancel() then re-defers the SAME intent until that actual native end.
      if(this.epoch===intent&&this.composing&&this.pendingAction==='cancel')return;
      this.cancelIntentEpoch=undefined;this.cancelFocusEpoch=undefined;
      if(sequence!==undefined&&this.pendingSwitch?.sequence===sequence&&this.pendingSwitchCancelled)this.rejectPendingSwitch('cancelled','cancel-not-retired');
      this.changed();
    }).catch(()=>{});
  }
  private key(event:KeyboardEvent){
    if(!this.available()||!this.session||event.defaultPrevented||event.isComposing||this.composing||event.keyCode===229)return;
    if(event.key==='Escape'){event.preventDefault();this.runCancel();}
    else if(event.key==='Enter'&&(event.metaKey||event.ctrlKey)){event.preventDefault();void this.run('Apply text',()=>this.apply(this.eventTime(event)));}
  }
  private run(label:string,work:()=>Promise<void|TextFocusReturn>,focus=this.focusEpoch){const session=this.session;if(!this.available()||!session)return Promise.resolve();return this.track(()=>this.withSession(session,()=>this.runAction(label,work,focus))).catch(error=>{if(this.available()){this.error=nativeDiagnostic(error);this.editor.fail(error);this.changed();}});}
  private diagnostic(error:unknown,name=this.session?.name){
    if(!(error instanceof TextFailure))return nativeDiagnostic(error);
    if(typeof error.code!=='string'||error.code.length>128)return 'Text operation returned an unsupported diagnostic. Full text is retained.';
    if(error.code==='TEXT_ASSET_LOAD'){const missing=(error.details as {fontHTTPStatus?:unknown}|null)?.fontHTTPStatus===404;return (name?.slice(0,128)||'Text')+': '+(missing?'Missing exact font bytes.':'Text resources are unavailable.')+' Draft and accepted appearance are retained; '+(missing?'relink the exact font or preview a substitution.':'retry Preview text when the local service is available.');}
    if(error.code!=='TEXT_MISSING_GLYPHS')return error.code;
    const points=(error.details as {codepoints?:unknown}|null)?.codepoints;
    if(!Array.isArray(points)||points.length>256||!points.every(point=>Number.isInteger(point)&&point>=0&&point<=0x10ffff))return 'Missing glyphs in selected fonts. Full text and accepted appearance are retained.';
    let workspace:AllocationLease|undefined;try{workspace=this.memory.workspace('diagnostic',8192);return 'Missing glyphs in selected fonts: '+points.map(point=>'U+'+point.toString(16).toUpperCase()).join(', ')+'. Full text and accepted appearance are retained.';}catch{return 'Missing glyphs in selected fonts. Full text and accepted appearance are retained.';}finally{workspace?.release();}
  }
  private async runAction(label:string,work:()=>Promise<void|TextFocusReturn>,focus=this.focusEpoch){
    const signal=this.reads.signal,name=this.session?.name,opener=this.opener,sessionId=this.editor.sessionId,draftOwner=this.editor.draftOwner,lifetime=this.actionLifetime,documentId=this.editor.view.document?.id,documentRevision=this.editor.view.document?.revision;
    const independentCancel=label==='Cancel text edit'&&this.editor.view.busy;
    if(this.work||(this.editor.view.busy&&!independentCancel))return;this.work++;this.changed();
    const focusResult:{value?:TextFocusReturn}={};
    const perform=async()=>{try{const result=await work();if(result)focusResult.value=result;}catch(error){if(signal.aborted||!this.available())return;this.error=this.diagnostic(error,name);this.fontLoadFailed=error instanceof TextFailure&&error.code==='TEXT_ASSET_LOAD';if(this.fontLoadFailed)this.editor.patch({uiPending:this.editor.draftOwner?.pendingRequests()??[],error:this.error,message:'Action needs attention.'});else throw error;}finally{this.work--;this.changed();}};
    // Cancelling this draft must not clear another action's busy state.
    if(independentCancel){try{await perform();}catch(error){this.editor.fail(error);}}
    else await this.editor.run(label,perform);
    const retired=focusResult.value;if(!retired)return;
    // The dispatcher must release busy before the host and public control commit
    // their enabled state. Later user intent or a successor owner wins focus.
    const current=()=>retired.documentId===documentId&&(label!=='Cancel text edit'||retired.documentRevision===documentRevision)&&this.available()&&this.host.isConnected&&!signal.aborted&&!this.session&&this.epoch===retired.epoch&&this.actionLifetime===lifetime&&this.focusEpoch===focus&&this.editor.sessionId===sessionId&&this.editor.draftOwner===draftOwner&&this.editor.view.ready&&this.editor.view.document?.id===retired.documentId&&this.editor.view.document?.revision===retired.documentRevision&&(independentCancel||!this.editor.view.busy);
    if(!current())return;await this.host.updateComplete;if(!current())return;
    const target=!this.editor.view.busy&&opener?.isConnected?opener:this.host.querySelector<HTMLElement>('#inspector');if(!target?.isConnected)return;
    const updated=(target as HTMLElement&{updateComplete?:Promise<unknown>}).updateComplete;if(updated)await updated;
    if(current()&&target.isConnected&&(target!==opener||!this.editor.view.busy))target.focus();
  }
  private action(e:Event,label:string,work:()=>Promise<void|TextFocusReturn>,epoch=this.epoch){const focus=this.focusEpoch;this.deferredAction(e,()=>{
    if(!this.session||this.epoch!==epoch||!this.available())return;
    if(this.composing&&(label==='Apply text'||label==='Cancel text edit')){
      if(label==='Apply text'&&this.cancelIntentEpoch!==undefined)return;
      this.pendingAction=label==='Apply text'?'apply':'cancel';if(label==='Cancel text edit'){this.cancelIntentEpoch??=this.epoch;this.cancelFocusEpoch??=focus;if(this.pendingSwitch)this.pendingSwitchCancelled=true;}
      this.pendingActionTime=this.eventTime(e);this.message=label+' after composition';this.changed();return;}
    if(label==='Cancel text edit')this.runCancel(focus);else if(this.cancelIntentEpoch===undefined)void this.run(label,work,focus);
  });}
  private sameDraftOwner(s:Session){return this.editor.sessionId===s.id&&this.sessionDraftOwners.get(s)===this.editor.draftOwner;}
  private assertDraftOwner(s:Session){if(!this.sameDraftOwner(s))throw Error('Text draft owner changed. Full text remains available to copy; no successor draft was changed.');}
  private async flushCurrent(s:Session){
    this.assertDraftOwner(s);await this.editor.flushDrafts();this.assertDraftOwner(s);
    const draft=this.editor.draftOwner?.drafts.get(s.draftId);
    if(draft&&draft.savedGeneration!==draft.generation){if(draft.error)throw Error(draft.error);await this.editor.flushDrafts();this.assertDraftOwner(s);}
    const saved=this.editor.draftOwner?.drafts.get(s.draftId);if(saved&&saved.savedGeneration!==saved.generation)throw Error('Text draft changed while saving. Full text is retained.');
  }
  private owns(s:Session,epoch=this.epoch,revision=this.revision){return this.available()&&this.session===s&&epoch===this.epoch&&revision===this.revision&&!this.stale;}
  private assert(s:Session,epoch:number,revision:number){if(!this.owns(s,epoch,revision)||this.composing)throw Error('Text draft changed. Your text is retained; prepare a fresh preview.');}
  private async readText(path:string,ref:BlobRef,kind:'accepted'|'draft'='accepted'){
    const signal=this.reads.signal;signal.throwIfAborted();const expected=Number(ref.byteLength);
    if(!Number.isSafeInteger(expected)||expected<0||expected>16*1024**2||kind==='accepted'&&expected>LIMITS.textBytes)throw Error('TEXT_BYTES');
    let workspace:ReturnType<typeof textMemory.reserve>|undefined=textMemory.reserve(expected*6+65536);
    try{const response=await this.editor.session.transport(path+'&content=1',{signal});
      if(!response.ok){await cancelTextAssetResponse(response);throw Error('Text source is unavailable. Reopen the current layer or saved draft.');}
      const bytes=await readTextAssetResponse(response,expected,signal);signal.throwIfAborted();if(await hashBytes(bytes)!==ref.hash)throw Error('Text source identity changed. Retained text was not replaced.');
      const buffer=await bytes.arrayBuffer();signal.throwIfAborted();return this.memory.create('decoded-text',expected*2,()=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(buffer));
    }catch(error){if(workspace&&retainTextAssetCleanup(error,workspace))workspace=undefined;if(error instanceof Error&&'code' in error&&error.code==='TEXT_ASSET_CLEANUP')this.readCleanupErrors.add(error);throw error;}
    finally{workspace?.release();}
  }
  begin(trigger:HTMLElement,layer?:ImageLayer){
    if(!this.available())return Promise.resolve();if(this.session){this.control.focus();return Promise.resolve();}if(layer&&layer.kind!=='text')return Promise.resolve();
    let snapshot:OwnedModel<NativeViewSnapshot>|undefined;try{snapshot=this.captureView(layer);}catch(error){return Promise.reject(error);}if(!snapshot)return Promise.resolve();
    const signal=this.reads.signal;return this.track(()=>this.beginSession(trigger,snapshot!).catch(error=>{if(!signal.aborted)throw error;})).finally(()=>snapshot!.release());
  }
  beginFromReturnedDescription(trigger:HTMLElement,proposal:ReturnedTextProposal){
    if(!this.available())return Promise.reject(Error('Text editor is unavailable.'));if(this.session)return Promise.reject(Error('Apply or cancel the current text draft first.'));
    validateReturnedDescriptionSelection(proposal.selection);textPlacement(proposal.placement);
    if(!validString(proposal.literal)||![proposal.frame.width,proposal.frame.height].every(n=>Number.isFinite(n)&&n>0&&n<=8192)||Math.ceil(proposal.frame.width)*Math.ceil(proposal.frame.height)>25000000)return Promise.reject(Error('Review a supported literal and frame.'));
    const snapshot=this.captureView(undefined,undefined,proposal);if(!snapshot)return Promise.reject(Error('Open a current document first.'));
    const signal=this.reads.signal;return this.track(()=>this.beginSession(trigger,snapshot!).catch(error=>{if(!signal.aborted)throw error;})).finally(()=>snapshot!.release());
  }
  private async beginSession(trigger:HTMLElement,snapshot:OwnedModel<NativeViewSnapshot>){
    const {document:d,layer}=snapshot.value,release=snapshot.pin();const loaded:OwnedModel<unknown>[]=[];
    try{
    const epoch=++this.epoch,focus=this.focusEpoch,sessionId=this.editor.sessionId,draftOwner=this.editor.draftOwner;this.opener=trigger;this.message='Preparing text editor…';this.changed();
    let source:TextSource|undefined,text=snapshot.value.returned?.literal??'',fonts:FontVersion[];
    if(layer){const path='/api/v1/documents/'+d.id+'/text?layerId='+layer.id+'&revision='+d.revision,metadata=await this.readControl<{source:TextSource;layerVersion:string}>(path);loaded.push(metadata);source=metadata.value.source;const decoded=await this.readText(path,source.text.textUtf8);loaded.push(decoded);text=decoded.value;fonts=source.text.fonts;}
    else{const font=await this.library.bundled(fontChoices[0].id);loaded.push(font);fonts=[font.value];}
    if(epoch!==this.epoch||this.editor.sessionId!==sessionId||this.editor.draftOwner!==draftOwner||!this.editor.view.ready||this.editor.view.document?.id!==d.id||this.editor.view.document?.revision!==d.revision)return;
    const proposal:Session={id:this.editor.sessionId,document:d,layerId:layer?.id??crypto.randomUUID(),layerVersion:layer?.version??'0',name:layer?.name??'Text',draftId:crypto.randomUUID(),original:source,locked:!!layer?.locked,text,fonts,style:source?.text.style??{primaryFont:fonts[0].bytes.hash,explicitFallbacks:[],sizePx:32,lineHeightMultiplier:1.2,fill:[40,40,40,255],align:'start',direction:'auto'},frame:source?.text.frame??snapshot.value.returned?.frame??{width:Math.min(d.width,360),height:Math.min(d.height,180)},...layer?{}:{placement:snapshot.value.returned?.placement??{x:0,y:0}},...snapshot.value.returned?{description:snapshot.value.returned.selection}:{}};
    const owned=this.ownSession(()=>structuredClone(proposal),modelPayloadBytes(proposal),proposal.name.length);try{this.admitNative(text,true);}catch(error){owned.release();throw error;}const s=this.commitSession(owned,draftOwner);this.nativeRefused=false;
    this.fontId=fontChoices.find(f=>'sha256:'+f.sha256===fonts[0].bytes.hash)?.id??fonts[0].id;
    this.model.setValue(text);this.bridge.sync();this.presentation='anchored';this.revision++;this.error='';this.message=layer?.locked?'Unlock to edit. Text remains selectable and copyable.':'Text draft. Preview and Apply explicitly; typing never generates.';
    if(s.description){this.message='Returned description draft. Confirm the literal, approximate placement and local font; preview then apply. Existing pixels stay unchanged.';this.save(false);}
    const revision=this.revision,parent=this.control.parentNode;
    void this.checkFonts(s);this.changed();await this.host.updateComplete;
    if(this.owns(s,epoch,revision)&&this.focusEpoch===focus&&this.control.isConnected&&this.control.parentNode===parent)this.control.focus({preventScroll:true});
    }finally{for(const value of loaded)value.release();release();snapshot.release();}
  }
  sync(){if(!this.available())return Promise.resolve();const signal=this.reads.signal;return this.track(()=>this.restoreSession().catch(error=>{if(!signal.aborted)throw error;}));}
  private async restoreSession(){
    if(this.session){if(this.stale){this.rejectPendingSwitch(this.editor.sessionId!==this.session?.id?'stale-session':'stale-version');this.pendingAction=undefined;this.pendingActionTime=undefined;if(this.cancelDispatchEpoch===undefined){this.cancelIntentEpoch=undefined;this.cancelFocusEpoch=undefined;}this.renderer?.cancel();this.preparation?.cancel();}return;}
    const sessionId=this.editor.sessionId,draftOwner=this.editor.draftOwner,key=sessionId+':'+(this.editor.view.document?.id??'');if(!this.editor.view.ready||key===this.restoring)return;
    // Draft rows are not view-model identities. Copy their needed scalars in the
    // same synchronous snapshot; never keep a checkpoint row across a read.
    const snapshot=this.captureRestoreView();this.restoring=key;if(!snapshot)return;
    let transferred=false;const loaded:OwnedModel<unknown>[]=[],release=snapshot.pin(),epoch=++this.epoch;this.restoringEpoch=epoch;
    try{
    const {document:d,layer,draft}=snapshot.value;if(!draft)return;
    const path='/api/v1/ui/'+sessionId+'/text?draftId='+draft.id;
    const current=()=>epoch===this.epoch&&key===this.restoring&&!this.session&&this.editor.sessionId===sessionId&&this.editor.draftOwner===draftOwner&&this.editor.view.ready&&this.editor.view.document?.id===d.id&&this.editor.view.document.revision===snapshot.value.readRevision;
    const metadata=await this.readControl<{draft:Draft;value:TextDraft}>(path);loaded.push(metadata);const value=metadata.value;if(!current())return;
    const decoded=await this.readText(path+'&generation='+value.draft.generation,value.value.textUtf8,'draft');loaded.push(decoded);const text=decoded.value;if(!current())return;
    let original:TextSource|undefined;
    if(layer?.kind==='text'){const current=await this.readControl<{source:TextSource}>('/api/v1/documents/'+d.id+'/text?layerId='+layer.id+'&revision='+snapshot.value.readRevision);loaded.push(current);original=current.value.source;}
    if(!current())return;
    const proposal:Session={id:sessionId,document:d,layerId:layer?.id??crypto.randomUUID(),layerVersion:layer?.version??'0',name:layer?.name??'Recovered text',draftId:draft.id,original,locked:!!layer?.locked,text,fonts:value.value.fonts,style:value.value.style,frame:value.value.frame,...original?{}:{placement:value.value.kind==='text-draft-2'||value.value.kind==='text-draft-3'?value.value.placement:{x:0,y:0}},...value.value.kind==='text-draft-3'?{description:value.value.description}:{}};
    const owned=this.ownSession(()=>structuredClone(proposal),modelPayloadBytes(proposal),proposal.name.length);try{this.admitNative(text,true);}catch(error){owned.release();throw error;}const s=this.commitSession(owned,draftOwner);transferred=true;this.nativeRefused=false;
    this.model.setValue(text);this.bridge.sync();this.revision++;this.message='Recovered text draft. It has not been applied.';this.error='';void this.checkFonts(s);this.changed();
    }finally{for(const value of loaded)value.release();release();snapshot.release();if(!transferred){if(this.restoring===key&&this.restoringEpoch===epoch){this.restoring='';this.restoringEpoch=0;}}}
  }
  private captureRestoreView(){const draft=this.editor.ui?.drafts.find(value=>value.kind==='text'&&value.status==='saved-unapplied'&&value.documentId===this.editor.view.document?.id);if(!draft)return;return this.captureView(this.editor.view.image?.layers.find(layer=>layer.id===draft.targetLayerId),draft);}
  private checkFonts(s:Session){return this.track(()=>this.withSession(s,()=>this.readFontStatus(s))).catch(error=>{if(this.available()&&this.session?.draftId===s.draftId){this.error=nativeDiagnostic(error);this.editor.fail(error);this.changed();}});}
  private async readFontStatus(s:Session){
    const epoch=this.epoch,signal=this.reads.signal,fonts=s.fonts;this.fontStatus='Checking exact font resources…';this.changed();
    let metadata:Awaited<ReturnType<EditorClient['ownedFontAssets']>>|undefined;
    try{if(fonts.length>16)throw Error('FONT_SELECTION_LIMIT');metadata=await this.editor.ownedFontAssets(fonts);const assets=metadata.value;signal.throwIfAborted();for(const font of fonts){const asset=assets.find(a=>a.font?.id===font.id);if(!asset)throw Error();const response=await this.editor.session.transport('/api/v1/assets/'+asset.id+'/content',{method:'HEAD',signal});signal.throwIfAborted();if(!response.ok)throw Error();}if(this.session?.draftId===s.draftId&&this.epoch===epoch&&this.session.fonts.length===fonts.length&&this.session.fonts.every((font,i)=>font.id===fonts[i].id))this.fontStatus='Available exact font versions. Accepted appearance is retained.';}catch{if(this.session?.draftId===s.draftId&&this.epoch===epoch&&this.session.fonts.length===fonts.length&&this.session.fonts.every((font,i)=>font.id===fonts[i].id))this.fontStatus='Missing exact font bytes. Frozen appearance is retained when available. Relink or preview a substitution before reflow.';}finally{metadata?.release();}if(this.session?.draftId===s.draftId&&this.epoch===epoch)this.changed();
  }
  private recordSwitch(token:PresentationIdentity){this.switchRequestEpoch=token.epoch;this.switchRequestGeneration=token.revision;this.switchRequestTextVersion=token.textRevision;}
  // Separate draft text from general invalidation and accepted document/layer
  // versions. A formatting change advances generation without changing text.
  private presentationGuards(token:PresentationIdentity,accepted?:PresentationRequest){
    const session=this.session,layer=session?this.editor.view.image?.layers.find(value=>value.id===session.layerId):undefined;
    return (!session||token.epoch!==this.epoch||this.editor.sessionId!==session.id||this.sessionDraftOwners.get(session)!==this.editor.draftOwner?1:0)|(token.revision!==this.revision?2:0)|(token.textRevision!==this.textRevision?4:0)|
      (accepted&&session&&(this.editor.view.document?.id!==session.document.id||this.editor.view.document?.revision!==accepted.documentRevision||accepted.documentRevision!==session.document.revision||accepted.layerVersion!==session.layerVersion||!!session.original&&(!layer||layer.version!==accepted.layerVersion))?8:0);
  }
  private rejectSwitch(token:PresentationIdentity,reason:PresentationRejection,guards=this.presentationGuards(token),boundary='admission'){
    this.switchRejected=token.sequence;this.switchRejectedEpoch=token.epoch;this.switchRejectedGeneration=token.revision;this.switchRejectedCurrentEpoch=this.epoch;this.switchRejectedCurrentGeneration=this.revision;
    this.switchRejectedTextVersion=token.textRevision;this.switchRejectedCurrentTextVersion=this.textRevision;this.switchRejectedGuards=guards;this.switchRejectedBoundary=boundary;
    this.switchReason=reason;if(reason==='superseded')this.switchSuperseded=token.sequence;
  }
  private rejectPendingSwitch(reason:PresentationRejection,boundary='invalidation'){
    const pending=this.pendingSwitch,owner=this.pendingSwitchOwner;this.pendingSwitch=undefined;this.pendingSwitchOwner=undefined;this.pendingSwitchCancelled=false;
    try{if(pending)this.rejectSwitch(pending,reason,this.presentationGuards(pending,pending),boundary);}finally{owner?.release();}
  }
  private switchTo(target:Presentation,request?:PresentationRequest){
    const session=this.session;if(!session||this.cancelIntentEpoch!==undefined)return;
    const token=request??{sequence:++this.switchRequestSequence,target,epoch:this.epoch,revision:this.revision,textRevision:this.textRevision,documentRevision:session.document.revision,layerVersion:session.layerVersion};
    if(!request)this.recordSwitch(token);
    const guards=this.presentationGuards(token,token)|(this.nativeRefused||this.control.value!==session.text?4:0),rejection:PresentationRejection|undefined=guards&1?'stale-session':guards&2?'stale-generation':guards&4?'stale-text-version':guards&8?'stale-version':undefined;
    if(rejection){this.rejectSwitch(token,rejection,guards);this.changed();return;}
    if(this.composing){
      const owner=this.memory.clone('presentation',token);this.rejectPendingSwitch('superseded');this.pendingSwitchOwner=owner;this.pendingSwitch=owner.value;this.pendingSwitchCancelled=this.pendingAction==='cancel';
      this.message='Switch after composition';this.changed();return;
    }
    return this.track(async()=>{
      this.switchSettled=token.sequence;
      const epoch=this.epoch,revision=this.revision,textRevision=token.textRevision,node=this.control,parent=node.parentNode;
      const range={start:node.selectionStart,end:node.selectionEnd,direction:node.selectionDirection,top:node.scrollTop,left:node.scrollLeft};
      const focus=this.focusEpoch,sequence=++this.presentationEpoch;this.presentation=target;this.changed();this.cancelSwitchFrame();
      await this.host.updateComplete;
      if(this.epoch!==epoch||this.cancelIntentEpoch!==undefined||this.textRevision!==textRevision||this.nativeRefused||this.control.value!==this.session?.text||sequence!==this.presentationEpoch||!this.available())return;
      await new Promise<void>((resolve,reject)=>{
        this.switchCancel=()=>{if(this.switchFrame!==undefined)cancelAnimationFrame(this.switchFrame);this.switchFrame=undefined;this.switchCancel=undefined;resolve();};
        this.switchFrame=requestAnimationFrame(()=>{this.switchFrame=undefined;this.switchCancel=undefined;try{const session=this.session;
          if(!session||!this.owns(session,epoch,revision)||this.cancelIntentEpoch!==undefined||this.textRevision!==textRevision||this.nativeRefused||this.control.value!==session.text||this.composing||this.focusEpoch!==focus||sequence!==this.presentationEpoch||!node.isConnected||node.parentNode!==parent||node.selectionStart!==range.start||node.selectionEnd!==range.end||node.selectionDirection!==range.direction)return;
          node.focus({preventScroll:true});if(!this.owns(session,epoch,revision)||this.cancelIntentEpoch!==undefined||this.textRevision!==textRevision||this.nativeRefused||this.control.value!==session.text||this.composing||document.activeElement!==node)return;
          if(node.selectionStart!==range.start||node.selectionEnd!==range.end||node.selectionDirection!==range.direction)node.setSelectionRange(range.start,range.end,range.direction);
          node.scrollTop=range.top;node.scrollLeft=range.left;this.message=target==='inspector'?'Text editor in inspector':'Text editor by canvas';this.changed();
        }catch(error){reject(error);}finally{resolve();}});
      });
    }).catch(error=>{if(this.available()){this.error=nativeDiagnostic(error);this.editor.fail(error);this.changed();}});
  }
  private cancelSwitchFrame(){this.switchCancel?.();}
  private preserveSwitchFocus(e:PointerEvent){if(this.composing||document.activeElement===this.control)e.preventDefault();}
  private switchAction(e:Event,target:Presentation,epoch=this.epoch){const revision=this.revision,textRevision=this.textRevision;this.deferredAction(e,()=>{if(this.cancelIntentEpoch!==undefined)return;const reason=this.epoch!==epoch||!this.session?'stale-session':this.revision!==revision?'stale-generation':this.textRevision!==textRevision?'stale-text-version':undefined;if(reason){const token={sequence:++this.switchRequestSequence,epoch,revision,textRevision};this.recordSwitch(token);this.rejectSwitch(token,reason);this.changed();return;}if(this.available())this.switchTo(target);});}
  private preventCompositionFocus(e:PointerEvent){if(this.composing)e.preventDefault();}
  private mutate(e:Event,read:(session:Session)=>void,epoch=this.epoch,label=''){const host=e.currentTarget as HTMLInputElement;this.adapter.settled(e,()=>true,()=>{const session=this.session;if(!session||this.epoch!==epoch||!this.available()||session.locked)return;try{const next=this.proposeSession(session,host.value.length*8+1024,read);this.acceptSession(next);}catch(error){this.adapter.write(host,'value',this.fieldValue(label,session));this.error=nativeDiagnostic(error);this.changed();}});}
  private number(label:string,value:number,write:(session:Session,n:number)=>void){const epoch=this.epoch;return html`<en-number-field label=${label} .value=${String(value)} ?disabled=${this.session?.locked||!!this.work} @en-change=${(e:Event)=>{const h=e.currentTarget as HTMLInputElement;this.mutate(e,session=>write(session,Number(h.value)),epoch,label);}}></en-number-field>`;}
  private select(label:string,value:string,choices:string[],write:(session:Session,value:string)=>void){const epoch=this.epoch;return html`<en-select label=${label} .value=${value} ?disabled=${this.session?.locked||!!this.work} @en-change=${(e:Event)=>{const h=e.currentTarget as HTMLInputElement;this.mutate(e,session=>{if(!choices.includes(h.value))throw Error('Choose an available text style.');write(session,h.value);},epoch,label);}}>${choices.map(v=>html`<en-select-option value=${v}>${v}</en-select-option>`)}</en-select>`;}
  private async importFont(exact=false){
    const s=this.session;if(!s)return;
    if(!this.files[0]||!this.licenses[0]||!exact&&!this.embeddingReviewed)throw Error(exact?'Choose the exact font and its license record.':'Choose the font and its license record and confirm embedding permission.');
    const epoch=this.epoch,fontFile=this.files[0],licenseFile=this.licenses[0];
    if(exact){
      const {hash,license}=await hashRelinkInputs(fontFile,licenseFile);this.assert(s,epoch,this.revision);const prior=s.fonts.find(f=>f.bytes.hash===hash&&f.licenseRecord.hash===license);if(!prior)throw Error('Exact relink requires matching retained font and license bytes.');
      await this.cleanupRender();this.assert(s,epoch,this.revision);const imported=await this.library.import(fontFile,licenseFile,prior.origin);imported.release();if(!this.owns(s,epoch))throw Error('Text session changed. Reopen font status.');this.invalidate();void this.checkFonts(s);this.message='Exact font relinked. Prepare a fresh text preview.';
    }else{
      await this.cleanupRender();this.assert(s,epoch,this.revision);const imported=await this.library.import(fontFile,licenseFile,'local-file');try{const font=imported.value;if(!this.owns(s,epoch))throw Error('Text session changed. Choose the font again.');const next=this.proposeSession(s,modelPayloadBytes(font)+1024,candidate=>{candidate.fonts=[structuredClone(font)];candidate.style={...candidate.style,primaryFont:font.bytes.hash,explicitFallbacks:[]};});this.acceptSession(next);}finally{imported.release();}this.fontStatus='Substitution draft: validated local regular font. Preview before Apply.';
    }
  }
  private async chooseFont(id:string,append=false){
    const s=this.session;if(!s)return;if(append&&s.fonts.length>=LIMITS.faces)throw Error('FONT_SELECTION_LIMIT');const epoch=this.epoch;await this.cleanupRender();this.assert(s,epoch,this.revision);
    const imported=await this.library.bundled(id);try{const font=imported.value;if(!this.owns(s,epoch))throw Error('Text session changed. Choose the font again.');
    if(append&&s.fonts.some(f=>f.bytes.hash===font.bytes.hash))return;
    const next=this.proposeSession(s,modelPayloadBytes(font)+2048,candidate=>{candidate.fonts=append?[...candidate.fonts,structuredClone(font)]:[structuredClone(font)];candidate.style={...candidate.style,primaryFont:candidate.fonts[0].bytes.hash,explicitFallbacks:candidate.fonts.slice(1).map(f=>f.bytes.hash)};});this.acceptSession(next);
    this.fontId=id;this.fontStatus='Available exact font versions.';this.message='Font substitution draft. Preview reflow before Apply; previous history is unchanged.';}finally{imported.release();}
  }
  private async request():Promise<OwnedModel<TextRequest>>{
    const s=this.session;if(!s||!this.available())throw Error('Open a text draft first.');const epoch=this.epoch,revision=this.revision;
    if(this.nativeRefused)throw Error('Revise the full native input before preparing text.');if(s.locked)throw Error('Unlock to edit.');if(this.stale)throw Error('Stale text draft. Copy your text or cancel before opening the current layer.');
    if(s.placement)textPlacement(s.placement);const loaded=await this.library.load(s.fonts);let requestOwner:OwnedModel<TextRequest>|undefined,transferred=false;try{const fonts=loaded.value;this.assert(s,epoch,revision);
    const token={documentId:s.document.id,documentRevision:s.document.revision,layerId:s.layerId,layerVersion:s.layerVersion,sessionId:s.id,generation:Number(this.editor.draftOwner?.drafts.get(s.draftId)?.generation??'0')},metadata={token,text:s.text,style:s.style,frame:s.frame,fonts:[]};let bytes=modelPayloadBytes(metadata);for(const font of fonts)bytes+=modelPayloadBytes({hash:font.hash,bytes:null,faceIndex:font.faceIndex,origin:font.origin,license:font.license});
    requestOwner=this.memory.create('request',bytes,()=>({token,text:s.text,style:structuredClone(s.style),frame:{...s.frame},fonts:fonts.map(font=>({...font,license:{...font.license}}))}),()=>bytes,fonts.length+1);
    // Request Blob aliases borrow the loader's real backing. Join that owner to
    // the request rather than relying on the library's independently clearable root.
    const request=requestOwner;let refs=1,live=true;const unref=()=>{if(!--refs){request.release();loaded.release();}};
    const result=Object.freeze({value:request.value,release:()=>{if(live){live=false;unref();}},pin:()=>{if(!refs)throw Error('NATIVE_TEXT_REQUEST_RELEASED');refs++;let pinned=true;return ()=>{if(pinned){pinned=false;unref();}};}});transferred=true;return result;
    }finally{if(!transferred){requestOwner?.release();loaded.release();}}
  }
  private async preparePreview(){
    const s=this.session;if(!s)return;if(this.composing)throw Error('Finish composition before previewing.');
    const previewId=crypto.randomUUID(),layout=browserPhases.recorder.start('text.layout',{documentId:s.document.id,revision:s.document.revision,layerId:s.layerId,sessionId:s.id,snapshotId:s.draftId,previewId});
    try{
    const epoch=this.epoch,revision=this.revision;this.clearPreview();await this.cleanupRender();this.assert(s,epoch,revision);this.message='Preparing text layout…';this.changed();
    let requestOwner:OwnedModel<TextRequest>|undefined;try{requestOwner=await this.request();const request=requestOwner.value;this.assert(s,epoch,revision);this.renderer=new TextRenderer();const value=await this.renderer.prepare(request);
      let pixelsLease:ReturnType<typeof textMemory.reserve>|undefined,surfaceLease:AllocationLease|undefined;
      try{this.assert(s,epoch,revision);/* Fixed 4 KiB also owns bounded scalar preview/token diagnostics through preview retirement. */pixelsLease=textMemory.reserve(value.rgba.size*2+4096);surfaceLease=allocationLedger.reserve({owner:'native-text-preview',kind:'canvas',gpuBytes:value.rgba.size,previewCacheBytes:value.rgba.size,handles:1});const pixels=new Uint8ClampedArray(await value.rgba.arrayBuffer());this.assert(s,epoch,revision);
        // Until arrayBuffer settles these reservations belong to this operation,
        // so input invalidation/Close cannot release its still-pending backing.
        this.previewLease=pixelsLease;pixelsLease=undefined;this.previewSurfaceLease=surfaceLease;surfaceLease=undefined;this.preview={revision,hash:value.rasterHash,overflow:value.overflow,width:value.width,height:value.height,pixels,id:previewId,generation:request.token.generation,layerVersion:request.token.layerVersion,textHash:value.textHash,dependencyHash:value.dependencyHash};this.message='Text preview ready. Accepted appearance is unchanged.';}
      finally{pixelsLease?.release();surfaceLease?.release();releasePrepared(value);}
    }finally{try{this.renderer?.dispose();this.renderer=undefined;this.library.clear();this.changed();}finally{requestOwner?.release();requestOwner=undefined;}}
    await this.host.updateComplete;this.assert(s,epoch,revision);
    if(!this.preview||this.preview.id!==previewId||!this.paintPreview())throw Error('Text preview submission unavailable.');
    this.error='';this.changed();
    // putImageData is an app-owned submission, never a presented-frame witness.
    layout.end('incomplete',{boundary:'render-submitted',generation:this.preview.generation,assetHash:this.preview.hash,evidenceHash:this.preview.dependencyHash,width:this.preview.width,height:this.preview.height});
    }catch(error){layout.end(!this.available()||this.session!==s?'cancelled':'error');throw error;}
  }
  private paintPreview(){const p=this.preview,canvas=this.host.querySelector<HTMLCanvasElement>('#native-text-preview');if(!p||!canvas)return false;paintTextPreview(canvas,p);return true;}
  private async apply(intentTime?:number){
    const s=this.session;if(!s)return;if(this.cancelIntentEpoch!==undefined)return;if(this.composing){this.pendingAction='apply';this.pendingActionTime=intentTime??browserPhases.recorder.timestamp();this.message='Apply after composition';this.changed();return;}
    const layout=browserPhases.recorder.start('text.layout',{documentId:s.document.id,revision:s.document.revision,layerId:s.layerId,sessionId:s.id,snapshotId:s.draftId,...this.preview?{previewId:this.preview.id,assetHash:this.preview.hash,evidenceHash:this.preview.dependencyHash,width:this.preview.width,height:this.preview.height}:{}},intentTime);
    try {
    if(!this.preview||this.preview.revision!==this.revision)throw Error('Preview the current text and font layout before Apply.');
    if(!s.original&&!s.text)throw Error('Enter text before creating a layer.');
    const epoch=this.epoch,revision=this.revision,preview=this.preview;this.clearPreview();
    this.save(false);await this.flushCurrent(s);this.assert(s,epoch,revision);
    const saved=this.editor.draftOwner!.drafts.get(s.draftId);if(!saved||saved.savedGeneration!==saved.generation)throw Error('Save the current draft before Apply.');
    let requestOwner:OwnedModel<TextRequest>|undefined,descriptionOwner:OwnedModel<ReturnType<typeof makeReturnedDescriptionReview>>|undefined;try{requestOwner=await this.request();const request=requestOwner.value;this.assert(s,epoch,revision);this.preparation=new DurableTextPreparation(this.storage);
      const result=await this.preparation.prepare(request,s.fonts);this.assert(s,epoch,revision);if(this.preparedHash!==preview.hash)throw Error('Text preview identity changed. Prepare a fresh preview before Apply.');
      // Reviewed pixels are recomputed by the unchanged adapter/writer; identities fence every step.
      let replacement=false;if(s.original){const bytes=measureControl(s.original.text.fonts,65536).encodedBytes+measureControl(s.fonts,65536).encodedBytes,workspace=this.memory.workspace('font-comparison',bytes*6+4096,2);try{replacement=canonical(s.original.text.fonts)!==canonical(s.fonts);}finally{workspace.release();}}
      const common={layerId:s.layerId,candidate:result.candidate,draft:{sessionId:s.id,draftId:s.draftId,generation:saved.generation},admissionId:result.admissionId};
      let description:ReturnType<typeof makeReturnedDescriptionReview>|undefined;
      if(s.description){const lease=textMemory.reserve(s.text.length*4+65536);try{const bytes=new TextEncoder().encode(s.text),{kind,...selection}=s.description;const hash=await hashBytes(bytes),input={...selection,id:crypto.randomUUID(),documentId:s.document.id,documentRevision:s.document.revision,literal:{hash,byteLength:String(bytes.length),mediaType:'text/plain'},frame:s.frame,placement:s.placement!,style:s.style,fonts:s.fonts},allowance=measureControl(input,65536).logicalBytes*3+65536;descriptionOwner=this.memory.create('returned-review',allowance,()=>makeReturnedDescriptionReview(input));description=descriptionOwner.value;this.assert(s,epoch,revision);}finally{lease.release();}}
      return await this.editor.withCommandEvents(s.original?{type:replacement?'ReplaceTextFont':'CommitTextEdit',...common,layerVersion:s.layerVersion,reviewedDependencyHash:result.dependencyHash}:description?{type:'CreateTextFromReturnedDescription',...common,name:s.name,placement:s.placement!,description}:{type:'CreateTextLayer',...common,name:s.name,placement:s.placement},events=>{
      const accepted=events.find(e=>e.type==='ImageEdited');
      // The receipt and local projection have arrived. Correct-pixel presentation
      // is a separate external trace, so this parent remains censored.
      layout.end('incomplete',{boundary:'authority-durable',generation:request.token.generation,evidenceHash:result.dependencyHash,...(accepted?{commandId:accepted.commandId,correlationId:accepted.correlationId,transactionId:accepted.transactionId,resultingRevision:accepted.resultingDocumentRevision??undefined}:{})});
      if(this.session===s&&this.revision===revision){this.retireSession();this.epoch++;this.preview=undefined;this.message='Text applied and saved locally.';this.editor.select([s.layerId]);return this.returnFocus();}
      else if(this.available()&&this.epoch===epoch)this.message='The reviewed version was saved; newer typing remains an unapplied draft.';
      },s.document);
    }finally{try{await this.cleanupRender(false);this.changed();}finally{descriptionOwner?.release();descriptionOwner=undefined;requestOwner?.release();requestOwner=undefined;}
      // Both native consumers have settled/disposed before request backing is
      // released. Realm shutdown must observe that final request release.
      if(!this.previewLease&&!this.closing)await releaseTextRealm(this.storage);
    }
    }catch(error){layout.end(!this.available()||this.session!==s?'cancelled':'error');throw error;}
  }
  private releaseStageOwners(){for(const result of this.stageOwners)result.release();this.stageOwners.clear();}
  private async cleanupRender(releaseRealm=true){this.renderer?.dispose();this.renderer=undefined;this.preparation?.dispose();this.preparation=undefined;this.library.clear();this.releaseStageOwners();if(releaseRealm&&!this.previewLease&&!this.closing)await releaseTextRealm(this.storage);}
  private async cancel(){
    if(this.composing){this.pendingAction='cancel';this.cancelIntentEpoch??=this.epoch;this.cancelFocusEpoch??=this.focusEpoch;if(this.pendingSwitch)this.pendingSwitchCancelled=true;this.message='Cancel text edit after composition';this.changed();return;}
    const s=this.session;if(!s)return;this.assertDraftOwner(s);const epoch=++this.epoch;this.pendingAction=undefined;
    // Explicit Cancel owns this still-pending intent through native end. It can
    // never present after Cancel is queued; native input must not retire it
    // early. Drop it here, at the actual Cancel boundary, before async cleanup.
    this.rejectPendingSwitch('cancelled',this.pendingSwitchCancelled?'cancel-native-end':'cancel');this.clearPreview();await this.cleanupRender();
    if(!this.available()||this.session!==s||this.epoch!==epoch)return;await this.flushCurrent(s);if(!this.available()||this.session!==s||this.epoch!==epoch)return;this.assertDraftOwner(s);if(this.editor.draftOwner?.drafts.has(s.draftId))await this.editor.clearDraft(s.draftId);this.assertDraftOwner(s);
    if(!this.available()||this.session!==s||this.epoch!==epoch)return;
    if(this.session===s)this.retireSession();this.error='';this.message='Text draft cancelled. Accepted appearance is unchanged.';this.changed();return this.returnFocus();
  }
  private returnFocus():TextFocusReturn{return {epoch:this.epoch,documentId:this.editor.view.document?.id,documentRevision:this.editor.view.document?.revision};}
  overlay(ctx:CanvasRenderingContext2D){const s=this.session;if(!s)return;const layer=this.editor.view.image?.layers.find(l=>l.id===s.layerId);ctx.save();if(layer)ctx.transform(...layer.layerToDocument);else if(s.placement)ctx.translate(s.placement.x,s.placement.y);ctx.strokeStyle='#9866cc';ctx.setLineDash([4,3]);ctx.lineWidth=1;ctx.strokeRect(0,0,s.frame.width,s.frame.height);ctx.restore();}
  dispose(){this.disposed=true;this.abort.abort();return this.releaseDocument();}
  render(){
    const s=this.session,disabled=!!this.work||this.editor.view.busy||!this.editor.view.ready||this.stale||!!s?.locked;
    // Template values remain reachable until Lit commits their replacement.
    // One pin per rendered session covers that interval; callbacks below retain
    // only epochs and reacquire live sessions instead of retaining retired ones.
    if(s&&!this.renderPins.has(s)){const owner=this.sessionOwners.get(s);if(!owner)throw Error('NATIVE_TEXT_SESSION_UNOWNED');this.renderPins.set(s,owner.pin());}
    const sequence=++this.renderSequence;
    this.renderCommit=this.host.updateComplete.then(()=>{if(sequence!==this.renderSequence)return;for(const [prior,release]of this.renderPins)if(prior!==s){this.renderPins.delete(prior);release();}});
    void this.renderCommit.catch(()=>{});
    this.control.setAttribute('aria-invalid',String(!!this.error));this.control.setAttribute('aria-describedby',this.error?'native-text-policy native-text-error':'native-text-policy');if(this.error)this.control.setAttribute('aria-errormessage','native-text-error');else this.control.removeAttribute('aria-errormessage');
    this.control.readOnly=!!s?.locked;this.control.dir=s?.style.direction==='auto'?'auto':s?.style.direction??'auto';
    const layer=this.editor.view.image?.layers.find(l=>l.id===s?.layerId),point=this.screenPoint([layer?.layerToDocument[4]??s?.placement?.x??0,layer?.layerToDocument[5]??s?.placement?.y??0]);
    const renderEpoch=this.epoch;void this.host.updateComplete.then(()=>{if(renderEpoch!==this.epoch||!this.available())return;const region=this.host.querySelector<HTMLElement>('#native-text-editor');region?.style.setProperty('--text-left',Math.max(12,Math.min(innerWidth-460,point[0]))+'px');region?.style.setProperty('--text-top',Math.max(155,Math.min(innerHeight-300,point[1]))+'px');});
    return html`<section id="native-text-editor" class="native-text-editor" data-presentation=${this.presentation} ?hidden=${!s} aria-label="Text editing" data-session=${s?.draftId??''} data-text-session-id=${s?.id??''} data-text-document-id=${s?.document.id??''} data-text-document-revision=${s?.document.revision??''} data-text-layer-id=${s?.layerId??''} data-text-layer-version=${s?.layerVersion??''} data-text-generation=${s?this.editor.draftOwner?.drafts.get(s.draftId)?.generation??'':''} data-text-saved-generation=${s?this.editor.draftOwner?.drafts.get(s.draftId)?.savedGeneration??'':''} data-preview-id=${this.preview?.id??''} data-preview-generation=${this.preview?.generation??''} data-preview-layer-version=${this.preview?.layerVersion??''} data-preview-text-hash=${this.preview?.textHash??''} data-preview-dependency-hash=${this.preview?.dependencyHash??''} data-preview-raster-hash=${this.preview?.hash??''} data-preview-width=${this.preview?.width??''} data-preview-height=${this.preview?.height??''} data-revision=${this.revision} data-text-version=${this.textRevision} data-presentation-pending=${this.pendingSwitch?.target??''} data-presentation-request=${this.switchRequestSequence} data-presentation-request-epoch=${this.switchRequestEpoch} data-presentation-request-generation=${this.switchRequestGeneration} data-presentation-request-text-version=${this.switchRequestTextVersion} data-presentation-settled=${this.switchSettled} data-presentation-rejected=${this.switchRejected} data-presentation-rejected-epoch=${this.switchRejectedEpoch} data-presentation-rejected-generation=${this.switchRejectedGeneration} data-presentation-rejected-current-epoch=${this.switchRejectedCurrentEpoch} data-presentation-rejected-current-generation=${this.switchRejectedCurrentGeneration} data-presentation-rejected-text-version=${this.switchRejectedTextVersion} data-presentation-rejected-current-text-version=${this.switchRejectedCurrentTextVersion} data-presentation-rejected-guards=${this.switchRejectedGuards} data-presentation-rejected-boundary=${this.switchRejectedBoundary} data-presentation-reason=${this.switchReason} data-presentation-superseded=${this.switchSuperseded}>
    <en-card><h2 slot="header">${s?.name??'Text'} <en-badge>Text draft</en-badge></h2>
    <en-stack gap="small"><label for="native-text-content">Edit text — ${s?.name??'Text'}</label><div class="native-text-host">${this.control}</div>
    <en-toolbar label="Text editing actions" keyboard-navigation="tab">
    <en-button ?disabled=${disabled||this.cancelIntentEpoch!==undefined} @pointerdown=${(e:PointerEvent)=>this.preventCompositionFocus(e)} @click=${(e:Event)=>this.action(e,'Apply text',()=>this.apply(this.eventTime(e)),renderEpoch)}>Apply text</en-button>
    <en-button variant="secondary" ?disabled=${!!this.work} @pointerdown=${(e:PointerEvent)=>this.preventCompositionFocus(e)} @click=${(e:Event)=>this.action(e,'Cancel text edit',()=>this.cancel(),renderEpoch)}>Cancel text edit</en-button>
    <en-button variant="secondary" ?disabled=${this.stale||this.cancelIntentEpoch!==undefined} @pointerdown=${(e:PointerEvent)=>this.preserveSwitchFocus(e)} @click=${(e:Event)=>this.switchAction(e,(this.pendingSwitch?.target??this.presentation)==='anchored'?'inspector':'anchored',renderEpoch)}>${(this.pendingSwitch?.target??this.presentation)==='anchored'?'Continue in inspector':'Return to card'}</en-button>
    ${this.pendingSwitch?html`<en-button @pointerdown=${(e:PointerEvent)=>this.preventCompositionFocus(e)} @click=${(e:Event)=>this.deferredAction(e,()=>{if(this.epoch!==renderEpoch||!this.available())return;this.rejectPendingSwitch('cancelled');this.message='Switch cancelled';this.changed();})}>Cancel switch</en-button>`:nothing}</en-toolbar>
    <en-alert announcement="polite">${this.stale?'Stale text draft. Full text is retained; copy it or Cancel before opening the current layer.':this.message}</en-alert>
    ${s?.description?html`<en-alert announcement="none">Creating editable text from retained description element ${s.description.elementIndex+1}. Caption geometry is approximate; the selected local font is not recovered from the image. Existing generated lettering remains in its pixels. Placement choice: ${s.description.placementChoice}. Apply confirms the literal and local preview shown here.</en-alert>`:nothing}
    <p id="native-text-policy" class="muted">One style for the whole frame. Enter inserts a newline. Preview then Apply; Cancel preserves the accepted layer. Native typing undo stays in this field.</p>
    ${this.error?html`<en-alert id="native-text-error" variant="warning" announcement="polite">${this.error}</en-alert>`:nothing}
    ${s?html`<div class="text-style-grid">${s.placement?html`${this.number('New text X (document px)',s.placement.x,(s,v)=>s.placement={...s.placement!,x:v})}${this.number('New text Y (document px)',s.placement.y,(s,v)=>s.placement={...s.placement!,y:v})}`:nothing}
    <en-select label="Font choice" .value=${this.fontId} ?disabled=${disabled} @en-change=${(e:Event)=>{const host=e.currentTarget as HTMLInputElement,value=host.value;this.adapter.settled(e,()=>value,id=>{if(!this.available()||this.epoch!==renderEpoch||!this.session)return;if(!fontChoices.some(font=>font.id===id)){this.adapter.write(host,'value',this.fontId);this.error='Choose a bundled regular font.';}else if(!this.setForm('fontId',id))this.adapter.write(host,'value',this.fontId);this.changed();});}}>${fontChoices.map(f=>html`<en-select-option value=${f.id}>${f.id} · Regular · ${f.sha256.slice(0,8)}</en-select-option>`)}</en-select>
    ${this.number('Text size (document px)',s.style.sizePx,(s,v)=>s.style={...s.style,sizePx:v})}${this.number('Line height multiplier',s.style.lineHeightMultiplier,(s,v)=>s.style={...s.style,lineHeightMultiplier:v})}
    ${this.select('Text alignment',s.style.align,['left','center','right','start','end'],(s,v)=>s.style={...s.style,align:v as TextStyle['align']})}${this.select('Text direction',s.style.direction,['auto','ltr','rtl'],(s,v)=>s.style={...s.style,direction:v as TextStyle['direction']})}
    <en-color-field label="Text fill" .value=${'#'+s.style.fill.slice(0,3).map(n=>n.toString(16).padStart(2,'0')).join('')} ?disabled=${disabled} @en-change=${(e:Event)=>{const h=e.currentTarget as HTMLInputElement;this.mutate(e,s=>{const v=h.value;if(!/^#[a-fA-F0-9]{6}$/.test(v))throw Error('Choose a six-digit sRGB color.');s.style={...s.style,fill:[parseInt(v.slice(1,3),16),parseInt(v.slice(3,5),16),parseInt(v.slice(5,7),16),s.style.fill[3]]};},renderEpoch,'Text fill');}}></en-color-field>
    ${this.number('Text alpha (0–255)',s.style.fill[3],(s,v)=>s.style={...s.style,fill:[s.style.fill[0],s.style.fill[1],s.style.fill[2],v]})}
    ${this.number('Text frame width (document px)',s.frame.width,(s,v)=>s.frame={...s.frame,width:v})}${this.number('Text frame height (document px)',s.frame.height,(s,v)=>s.frame={...s.frame,height:v})}</div>
    <en-stack direction="horizontal" wrap><en-button ?disabled=${disabled} @click=${(e:Event)=>this.action(e,'Choose text font',()=>this.chooseFont(this.fontId),renderEpoch)}>Use selected font</en-button><en-button variant="secondary" ?disabled=${disabled} @click=${(e:Event)=>this.action(e,'Add explicit fallback',()=>this.chooseFont(this.fontId,true),renderEpoch)}>Add explicit fallback</en-button></en-stack>
    <en-alert announcement="none">${this.fontStatus}</en-alert><en-alert announcement="none">Exact font order: ${s.fonts.map(f=>fontChoices.find(x=>'sha256:'+x.sha256===f.bytes.hash)?.id??('Local regular font · '+f.id.slice(7,15))).join(' → ')}. ${s.original?'Retained appearance stays available while edits are previewed. Font substitution changes this version only.':'New frame position is applied with text in one Undo unit. Existing layer Transform controls move, rotate or scale without reflow.'} Frame dimensions reflow text; layer scale does not.</en-alert>
    <en-accordion-item label="Local font import and exact relink"><en-file-upload label="Font file" accept=".ttf,.otf" .files=${this.files} .maxFileSize=${LIMITS.faceBytes} @en-change=${(e:Event)=>this.filesChanged(e,'files',renderEpoch)}></en-file-upload><en-file-upload label="Font license record" accept="text/plain,.txt" .files=${this.licenses} .maxFileSize=${65536} @en-change=${(e:Event)=>this.filesChanged(e,'licenses',renderEpoch)}></en-file-upload><en-alert announcement="none">Import only a supported static regular font with editable embedding permission. Exact relink must match the retained bytes and license; a different font requires substitution preview.</en-alert><en-switch label="I have permission to embed this font" .checked=${this.embeddingReviewed} @en-change=${(e:Event)=>{const h=e.currentTarget as unknown as {checked:boolean};this.adapter.settled(e,()=>h.checked,v=>{if(!this.available()||this.epoch!==renderEpoch||!this.session)return;this.embeddingReviewed=v;this.changed();});}}></en-switch><en-button ?disabled=${disabled||!this.embeddingReviewed} @click=${(e:Event)=>this.action(e,'Import local font',()=>this.importFont(),renderEpoch)}>Import as substitution draft</en-button><en-button variant="secondary" ?disabled=${disabled} @click=${(e:Event)=>this.action(e,'Relink exact font',()=>this.importFont(true),renderEpoch)}>Relink exact font</en-button></en-accordion-item>
    <en-button variant="secondary" ?disabled=${disabled||this.composing} @click=${(e:Event)=>this.action(e,'Preview text',()=>this.preparePreview(),renderEpoch)}>Preview text</en-button>
    ${this.preview?html`<en-alert variant=${this.preview.overflow?'warning':'info'} announcement="none">${this.preview.overflow?'Clipped overflow. Full text is retained. Enlarge the frame, reduce text size or line height, or Apply this clipped preview.':'Text fits the preview frame.'} Draft preview only.</en-alert><canvas id="native-text-preview" width="0" height="0" aria-label="Canonical text draft preview"></canvas>`:nothing}`:nothing}
    </en-stack></en-card></section>`;
  }
}
