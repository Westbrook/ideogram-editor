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

type Presentation='anchored'|'inspector';
type Session={id:string;document:Document;layerId:string;layerVersion:string;name:string;draftId:string;original?:TextSource;locked:boolean;text:string;style:TextStyle;frame:{width:number;height:number};fonts:FontVersion[];placement?:TextPlacement};
type Preview={revision:number;hash:string;overflow:boolean;width:number;height:number;pixels:Uint8ClampedArray<ArrayBuffer>};
export class NativeTextEditing {
  readonly control=document.createElement('textarea');
  private model=createDraftModel();private bridge:EditingController;private adapter=new ControlAdapter();
  private session?:Session;private epoch=0;private revision=0;private focusEpoch=0;private presentationEpoch=0;private presentation:Presentation='anchored';
  private pendingSwitch?:Presentation;private pendingAction?:'apply'|'cancel';private timer?:ReturnType<typeof setTimeout>;
  private pendingActionTime?:number;private inputPhase?:{span:PhaseSpan;session:Session;epoch:number};
  private previewLease?:{release():void};
  private previewSurfaceLease?:AllocationLease;
  private readCleanupErrors=new Set<unknown>();
  private renderer?:TextRenderer;private preparation?:DurableTextPreparation;private preview?:Preview;
  private opener?:HTMLElement;private restoring='';private work=0;private error='';private message='';
  private preparedHash='';private library:TextLibrary;private storage:TextStorage;private files:File[]=[];private licenses:File[]=[];
  private abort=new AbortController();private reads=new AbortController();private pending=new Set<Promise<unknown>>();private closing=false;private disposed=false;private releasing?:Promise<void>;private fontId=fontChoices[0].id;private embeddingReviewed=false;private fontStatus='Exact font selected';
  constructor(private host:LitElement,private editor:EditorClient,private draw:()=>void,private screenPoint:(p:readonly [number,number])=>readonly [number,number]){
    allocationLedger.observeTextReservations(()=>textMemory.snapshot.textBytes);
    this.library=new TextLibrary(editor);
    this.storage={admit:id=>this.admission(id),releaseAdmission:id=>this.admission(id,true),stage:async(blob,media)=>{const s=this.session,epoch=this.epoch,revision=this.revision;if(!s)throw Error('TEXT_DOCUMENT_RELEASED');this.assert(s,epoch,revision);if(media==='application/json'&&blob.size<=65536){const candidate=JSON.parse(await blob.text());this.assert(s,epoch,revision);if(candidate.source?.render)this.preparedHash=candidate.source.render.pixels.hash;}return editor.stageTextBlob(blob,media,'text',()=>this.owns(s,epoch,revision));}};
    this.control.id='native-text-content';this.control.rows=6;this.control.spellcheck=false;this.control.setAttribute('aria-describedby','native-text-policy');
    this.control.addEventListener('beforeinput',e=>this.observeInput(e),{capture:true});
    this.control.addEventListener('input',e=>this.observeInput(e),{capture:true});
    this.bridge=new EditingController(host,{model:this.model,control:()=>this.control,onInput:d=>this.input(d),adoptInitialValue:()=>false});
    this.control.addEventListener('keydown',e=>this.key(e));
    this.control.addEventListener('compositionend',()=>this.settle());
    // Any later deliberate focus cancels a scheduled restoration, even in public shadow controls.
    document.addEventListener('focusin',()=>{this.focusEpoch++;},{signal:this.abort.signal});
    for(const type of ['pointerdown','keydown','wheel'])document.addEventListener(type,()=>{this.focusEpoch++;},{capture:true,signal:this.abort.signal});
  }
  get active(){return !!this.session;}
  get lifecycle(){return Object.freeze({activeSession:!!this.session,closing:this.closing,pendingOperations:this.pending.size,retainedTextUnits:this.model.value.get().length+this.model.draft.get().length+this.control.value.length,retainedFiles:this.files.length+this.licenses.length,previewBytes:this.preview?.pixels.byteLength??0,rendererWorkers:(this.renderer?.lifecycle.activeWorkers??0)+(this.renderer?.lifecycle.idleWorkers??0),activePreparations:this.preparation?1:0,fontBackingBytes:this.library.lifecycle.retainedFontBytes});}
  private track<T>(work:Promise<T>):Promise<T>{this.pending.add(work);void work.finally(()=>this.pending.delete(work)).catch(()=>{});return work;}
  private available(){return !this.closing&&!this.disposed&&!this.readCleanupErrors.size;}
  // The caller saves the draft and closed view before invoking this method. It
  // relinquishes only ephemeral ownership; Cancel is the separate draft deletion.
  releaseDocument():Promise<void>{
    if(this.releasing)return this.releasing;
    this.closing=true;this.epoch++;this.revision++;this.focusEpoch++;this.presentationEpoch++;
    clearTimeout(this.timer);this.timer=undefined;this.adapter.invalidate();this.reads.abort();this.library.invalidate();
    this.inputPhase?.span.end('cancelled');this.inputPhase=undefined;this.pendingActionTime=undefined;
    this.session=undefined;this.pendingSwitch=undefined;this.pendingAction=undefined;this.opener=undefined;this.restoring='';
    this.model.endComposition('');this.model.setValue('');this.bridge.sync();this.control.value='';this.control.setSelectionRange(0,0);this.control.scrollTop=0;this.control.scrollLeft=0;
    this.files=[];this.licenses=[];this.embeddingReviewed=false;this.fontId=fontChoices[0].id;this.fontStatus='Exact font selected';
    this.preparedHash='';this.error='';this.message='';this.presentation='anchored';this.clearPreview();
    const settling=[...this.pending];
    // Install the shared release promise before a native termination can fail.
    // Independent owners still drain; a failed renderer stays attached for the
    // next explicit release attempt instead of losing its retry handle.
    this.releasing=Promise.resolve().then(async()=>{
      const errors:unknown[]=[];
      try{this.renderer?.dispose();this.renderer=undefined;}catch(error){errors.push(error);}
      try{this.preparation?.dispose();this.preparation=undefined;}catch(error){errors.push(error);}
      await Promise.allSettled(settling);
      for(const error of this.readCleanupErrors){try{if(await retryTextAssetCleanup(error))this.readCleanupErrors.delete(error);}catch{}}
      if(this.readCleanupErrors.size)errors.push(new AggregateError([...this.readCleanupErrors],'TEXT_CONTENT_CLEANUP'));
      try{await this.library.releaseDocument();}catch(error){errors.push(error);}
      try{await releaseTextRealm(this.storage);}catch(error){errors.push(error);}
      if(errors.length)throw new AggregateError(errors,'TEXT_DOCUMENT_RELEASE_FAILED');
    }).finally(()=>{this.closing=false;this.releasing=undefined;if(!this.disposed)this.reads=new AbortController();this.changed();});
    this.changed();
    return this.releasing;
  }
  get composing(){return this.model.isComposing.get();}
  get stale(){const s=this.session;return !!s&&(this.editor.sessionId!==s.id||this.editor.view.document?.id!==s.document.id||this.editor.view.document?.revision!==s.document.revision);}
  private changed(){this.host.requestUpdate();this.draw();}
  private async admission(id:string,release=false){if(!release&&!this.available())throw Error('TEXT_DOCUMENT_RELEASED');await this.editor.json('/api/v1/text-admission/'+id+(release?'/release':''),{method:'POST',headers:{'Content-Type':'application/json'},body:'{"protocolVersion":1}'});}
  private clearPreview(){if(this.preview)this.preview.pixels=new Uint8ClampedArray(0);this.preview=undefined;const canvas=this.host.querySelector<HTMLCanvasElement>('#native-text-preview');if(canvas){canvas.width=0;canvas.height=0;}this.previewLease?.release();this.previewLease=undefined;this.previewSurfaceLease?.release();this.previewSurfaceLease=undefined;}
  private invalidate(){this.revision++;this.clearPreview();this.renderer?.cancel();this.preparation?.cancel();this.error='';this.changed();}
  private eventTime(event:Event){const now=browserPhases.recorder.timestamp();return Number.isFinite(event.timeStamp)&&event.timeStamp>=0&&event.timeStamp<=now?event.timeStamp:undefined;}
  private observeInput(event:Event){
    const s=this.session;if(!s||!this.available())return;
    if(event.type==='input'&&this.inputPhase)return;
    this.inputPhase?.span.end('incomplete',{boundary:'observed'});
    const phase={session:s,epoch:this.epoch,span:browserPhases.recorder.start('text.edit',{documentId:s.document.id,revision:s.document.revision,layerId:s.layerId,inputSource:event.isTrusted?'trusted-event':'synthetic-event',composing:(event as InputEvent).isComposing===true},this.eventTime(event))};
    this.inputPhase=phase;
    // A cancelled beforeinput may never produce input. Do not invent a paint.
    queueMicrotask(()=>{if(this.inputPhase===phase){this.inputPhase=undefined;phase.span.end(event.defaultPrevented?'cancelled':'incomplete',{boundary:'observed'});}});
  }
  private input(detail:DraftInputDetail){
    const phase=this.inputPhase;this.inputPhase=undefined;
    const s=this.session;if(!s||!this.available()){phase?.span.end('cancelled');this.model.endComposition('');this.model.setValue('');this.bridge.sync();this.control.value='';return;}
    if(s.text!==detail.value){s.text=detail.value;this.invalidate();}
    this.save(detail.isComposing??false);if(!detail.isComposing)this.settle();
    if(phase)void this.host.updateComplete.then(()=>phase.span.end(this.session===phase.session&&this.epoch===phase.epoch?'incomplete':'cancelled',{boundary:'render-submitted'}),()=>phase.span.end('error'));
  }
  private save(composing=this.composing){
    const s=this.session;if(!s||s.locked)return;
    this.editor.changeDraft(s.draftId,'text',JSON.stringify({text:s.text,style:s.style,frame:s.frame,fonts:s.fonts,...s.placement?{placement:s.placement}:{}}),s.original?s.layerId:null,composing,s.document.revision);
  }
  private settle(){
    clearTimeout(this.timer);const epoch=this.epoch;
    this.timer=setTimeout(()=>{if(epoch!==this.epoch||this.composing||!this.session)return;
      this.save(false);if(this.stale){this.pendingSwitch=undefined;this.pendingAction=undefined;this.pendingActionTime=undefined;this.changed();return;}
      const action=this.pendingAction,intentTime=this.pendingActionTime;this.pendingAction=undefined;this.pendingActionTime=undefined;
      if(action==='cancel'){this.pendingSwitch=undefined;void this.run('Cancel text edit',()=>this.cancel());return;}
      const target=this.pendingSwitch;this.pendingSwitch=undefined;if(target)this.switchTo(target);
      if(action==='apply')void this.run('Apply text',()=>this.apply(intentTime));
      this.changed();
    },0);
  }
  private key(event:KeyboardEvent){
    if(!this.available()||!this.session||event.defaultPrevented||event.isComposing||this.composing||event.keyCode===229)return;
    if(event.key==='Escape'){event.preventDefault();void this.run('Cancel text edit',()=>this.cancel());}
    else if(event.key==='Enter'&&(event.metaKey||event.ctrlKey)){event.preventDefault();void this.run('Apply text',()=>this.apply(this.eventTime(event)));}
  }
  private run(label:string,work:()=>Promise<void>){if(!this.available()||!this.session)return Promise.resolve();return this.track(this.runAction(label,work));}
  private async runAction(label:string,work:()=>Promise<void>){
    const signal=this.reads.signal;
    const independentCancel=label==='Cancel text edit'&&this.editor.view.busy;
    if(this.work||(this.editor.view.busy&&!independentCancel))return;this.work++;this.changed();
    const perform=async()=>{try{await work();}catch(error){if(signal.aborted||!this.available())return;this.error=error instanceof TextFailure&&error.code==='TEXT_MISSING_GLYPHS'?'Missing glyphs in selected fonts: '+((error.details as {codepoints?:number[]})?.codepoints??[]).map(n=>'U+'+n.toString(16).toUpperCase()).join(', ')+'. Full text and accepted appearance are retained.':error instanceof TextFailure?error.code+' '+JSON.stringify(error.details):error instanceof Error?error.message:String(error);throw error;}finally{this.work--;this.changed();}};
    // Cancelling this draft must not clear another action's busy state.
    if(independentCancel){try{await perform();}catch(error){this.editor.fail(error);}}
    else await this.editor.run(label,perform);
  }
  private action(e:Event,label:string,work:()=>Promise<void>){const session=this.session,epoch=this.epoch;this.adapter.action(e,()=>{
    if(!session||this.session!==session||this.epoch!==epoch||!this.available())return;
    if(this.composing&&(label==='Apply text'||label==='Cancel text edit')){this.pendingAction=label==='Apply text'?'apply':'cancel';this.pendingActionTime=this.eventTime(e);if(this.pendingAction==='cancel')this.pendingSwitch=undefined;this.message=label+' after composition';this.changed();return;}
    void this.run(label,work);
  });}
  private async flushCurrent(s:Session){
    await this.editor.flushDrafts();
    const draft=this.editor.draftOwner?.drafts.get(s.draftId);
    if(draft&&draft.savedGeneration!==draft.generation){if(draft.error)throw Error(draft.error);await this.editor.flushDrafts();}
    const saved=this.editor.draftOwner?.drafts.get(s.draftId);if(saved&&saved.savedGeneration!==saved.generation)throw Error('Text draft changed while saving. Full text is retained.');
  }
  private owns(s:Session,epoch=this.epoch,revision=this.revision){return this.available()&&this.session===s&&epoch===this.epoch&&revision===this.revision&&!this.stale;}
  private assert(s:Session,epoch:number,revision:number){if(!this.owns(s,epoch,revision)||this.composing)throw Error('Text draft changed. Your text is retained; prepare a fresh preview.');}
  private async readText(path:string,ref:BlobRef,kind:'accepted'|'draft'='accepted'){
    const signal=this.reads.signal;signal.throwIfAborted();const expected=Number(ref.byteLength);
    if(!Number.isSafeInteger(expected)||expected<0||kind==='accepted'&&expected>LIMITS.textBytes)throw Error('TEXT_BYTES');
    // Draft recovery preserves over-limit input. Rendering still enforces LIMITS;
    // this read must first fit the independently bounded text workspace.
    let workspace:ReturnType<typeof textMemory.reserve>|undefined=textMemory.reserve(expected*6+65536);
    try{const response=await this.editor.session.transport(path+'&content=1',{signal});
      if(!response.ok){await cancelTextAssetResponse(response);throw Error('Text source is unavailable. Reopen the current layer or saved draft.');}
      const bytes=await readTextAssetResponse(response,expected,signal);signal.throwIfAborted();if(await hashBytes(bytes)!==ref.hash)throw Error('Text source identity changed. Retained text was not replaced.');
      const buffer=await bytes.arrayBuffer();signal.throwIfAborted();return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(buffer);
    }catch(error){if(workspace&&retainTextAssetCleanup(error,workspace))workspace=undefined;if(error instanceof Error&&'code' in error&&error.code==='TEXT_ASSET_CLEANUP')this.readCleanupErrors.add(error);throw error;}
    finally{workspace?.release();}
  }
  begin(trigger:HTMLElement,layer?:ImageLayer){if(!this.available())return Promise.resolve();const signal=this.reads.signal;return this.track(this.beginSession(trigger,layer).catch(error=>{if(!signal.aborted)throw error;}));}
  private async beginSession(trigger:HTMLElement,layer?:ImageLayer){
    if(this.session){this.control.focus();return;}
    const d=this.editor.view.document;if(!d||!this.editor.view.ready)return;
    const epoch=++this.epoch,focus=this.focusEpoch,sessionId=this.editor.sessionId;this.opener=trigger;this.message='Preparing text editor…';this.changed();
    let source:TextSource|undefined,text='',fonts:FontVersion[];
    if(layer){if(layer.kind!=='text')return;const path='/api/v1/documents/'+d.id+'/text?layerId='+layer.id+'&revision='+d.revision,value=await this.editor.json<{source:TextSource;layerVersion:string}>(path,{signal:this.reads.signal});source=value.source;text=await this.readText(path,source.text.textUtf8);fonts=source.text.fonts;}
    else fonts=[await this.library.bundled(fontChoices[0].id)];
    if(epoch!==this.epoch||this.editor.sessionId!==sessionId||!this.editor.view.ready||this.editor.view.document?.id!==d.id||this.editor.view.document?.revision!==d.revision)return;
    this.session={id:this.editor.sessionId,document:d,layerId:layer?.id??crypto.randomUUID(),layerVersion:layer?.version??'0',name:layer?.name??'Text',draftId:crypto.randomUUID(),original:source,locked:!!layer?.locked,text,fonts,style:source?.text.style??{primaryFont:fonts[0].bytes.hash,explicitFallbacks:[],sizePx:32,lineHeightMultiplier:1.2,fill:[40,40,40,255],align:'start',direction:'auto'},frame:source?.text.frame??{width:Math.min(d.width,360),height:Math.min(d.height,180)},...layer?{}:{placement:{x:0,y:0}}};
    this.fontId=fontChoices.find(f=>'sha256:'+f.sha256===fonts[0].bytes.hash)?.id??fonts[0].id;
    this.model.setValue(text);this.bridge.sync();this.presentation='anchored';this.revision++;this.error='';this.message=layer?.locked?'Unlock to edit. Text remains selectable and copyable.':'Text draft. Preview and Apply explicitly; typing never generates.';
    const s=this.session,revision=this.revision,parent=this.control.parentNode;
    void this.checkFonts(s);this.changed();await this.host.updateComplete;
    // Opening may await fonts or retained text. Later input/focus intent owns the
    // destination even when this session still legitimately finishes opening.
    if(this.owns(s,epoch,revision)&&this.focusEpoch===focus&&this.control.isConnected&&this.control.parentNode===parent)this.control.focus({preventScroll:true});
  }
  sync(){if(!this.available())return Promise.resolve();const signal=this.reads.signal;return this.track(this.restoreSession().catch(error=>{if(!signal.aborted)throw error;}));}
  private async restoreSession(){
    if(this.session){if(this.stale){this.pendingSwitch=undefined;this.pendingAction=undefined;this.renderer?.cancel();this.preparation?.cancel();}return;}
    const key=this.editor.sessionId+':'+(this.editor.view.document?.id??'');if(!this.editor.view.ready||key===this.restoring)return;this.restoring=key;
    const draft=this.editor.ui?.drafts.find(d=>d.kind==='text'&&d.status==='saved-unapplied'&&d.documentId===this.editor.view.document?.id);if(!draft)return;
    const epoch=++this.epoch,path='/api/v1/ui/'+this.editor.sessionId+'/text?draftId='+draft.id,value=await this.editor.json<{draft:Draft;value:TextDraft}>(path,{signal:this.reads.signal}),text=await this.readText(path+'&generation='+value.draft.generation,value.value.textUtf8,'draft');
    if(epoch!==this.epoch||key!==this.restoring||this.session)return;
    const d=this.editor.view.document!,layer=this.editor.view.image?.layers.find(l=>l.id===draft.targetLayerId);
    let original:TextSource|undefined;
    if(layer?.kind==='text'){const current=await this.editor.json<{source:TextSource}>('/api/v1/documents/'+d.id+'/text?layerId='+layer.id+'&revision='+d.revision,{signal:this.reads.signal});original=current.source;}
    if(epoch!==this.epoch||key!==this.restoring||this.session)return;
    this.session={id:this.editor.sessionId,document:{...d,revision:draft.expectedDocumentRevision},layerId:layer?.id??crypto.randomUUID(),layerVersion:layer?.version??'0',name:layer?.name??'Recovered text',draftId:draft.id,original,locked:!!layer?.locked,text,fonts:value.value.fonts,style:value.value.style,frame:value.value.frame,...original?{}:{placement:value.value.kind==='text-draft-2'?value.value.placement:{x:0,y:0}}};
    this.model.setValue(text);this.bridge.sync();this.revision++;this.message='Recovered text draft. It has not been applied.';this.error='';void this.checkFonts(this.session);this.changed();
  }
  private checkFonts(s:Session){return this.track(this.readFontStatus(s));}
  private async readFontStatus(s:Session){
    const epoch=this.epoch,signal=this.reads.signal,fonts=s.fonts;this.fontStatus='Checking exact font resources…';this.changed();
    let metadata:ReturnType<typeof allocationLedger.reserve>|undefined;
    try{if(fonts.length>16)throw Error('FONT_SELECTION_LIMIT');metadata=allocationLedger.reserve({owner:'font-status-control',kind:'control',cpuBytes:fonts.length*65536,handles:1});const assets=await this.editor.fontAssets(fonts);signal.throwIfAborted();for(const font of fonts){const asset=assets.find(a=>a.font?.id===font.id);if(!asset)throw Error();const response=await this.editor.session.transport('/api/v1/assets/'+asset.id+'/content',{method:'HEAD',signal});signal.throwIfAborted();if(!response.ok)throw Error();}if(this.session===s&&this.epoch===epoch&&s.fonts===fonts)this.fontStatus='Available exact font versions. Accepted appearance is retained.';}catch{if(this.session===s&&this.epoch===epoch&&s.fonts===fonts)this.fontStatus='Missing exact font bytes. Frozen appearance is retained when available. Relink or preview a substitution before reflow.';}finally{metadata?.release();}if(this.session===s&&this.epoch===epoch)this.changed();
  }
  private switchTo(target:Presentation){
    if(!this.session)return;if(this.composing){this.pendingSwitch=target;this.message='Switch after composition';this.changed();return;}
    if(this.stale)return;
    const s=this.session,epoch=this.epoch,revision=this.revision,node=this.control,parent=node.parentNode;
    const range={start:node.selectionStart,end:node.selectionEnd,direction:node.selectionDirection,top:node.scrollTop,left:node.scrollLeft};
    const focus=this.focusEpoch,sequence=++this.presentationEpoch;this.presentation=target;this.changed();
    void this.host.updateComplete.then(()=>requestAnimationFrame(()=>{
      if(!this.owns(s,epoch,revision)||this.composing||this.focusEpoch!==focus||sequence!==this.presentationEpoch||!node.isConnected||node.parentNode!==parent||node.selectionStart!==range.start||node.selectionEnd!==range.end||node.selectionDirection!==range.direction)return;
      node.focus({preventScroll:true});if(!this.owns(s,epoch,revision)||this.composing||document.activeElement!==node)return;
      if(node.selectionStart!==range.start||node.selectionEnd!==range.end||node.selectionDirection!==range.direction)node.setSelectionRange(range.start,range.end,range.direction);
      node.scrollTop=range.top;node.scrollLeft=range.left;this.message=target==='inspector'?'Text editor in inspector':'Text editor by canvas';this.changed();
    }));
  }
  private preserveSwitchFocus(e:PointerEvent){if(this.composing||document.activeElement===this.control)e.preventDefault();}
  private switchAction(e:Event,target:Presentation){this.adapter.action(e,()=>this.switchTo(target));}
  private preventCompositionFocus(e:PointerEvent){if(this.composing)e.preventDefault();}
  private mutate(e:Event,read:()=>void){const session=this.session,epoch=this.epoch;this.adapter.settled(e,()=>true,()=>{if(!session||this.session!==session||this.epoch!==epoch||!this.available()||session.locked)return;read();this.invalidate();this.save();});}
  private number(label:string,value:number,write:(n:number)=>void){return html`<en-number-field label=${label} .value=${String(value)} ?disabled=${this.session?.locked||!!this.work} @en-change=${(e:Event)=>{const h=e.currentTarget as HTMLInputElement;this.mutate(e,()=>write(Number(h.value)));}}></en-number-field>`;}
  private select(label:string,value:string,choices:string[],write:(s:string)=>void){return html`<en-select label=${label} .value=${value} ?disabled=${this.session?.locked||!!this.work} @en-change=${(e:Event)=>{const h=e.currentTarget as HTMLInputElement;this.mutate(e,()=>write(h.value));}}>${choices.map(v=>html`<en-select-option value=${v}>${v}</en-select-option>`)}</en-select>`;}
  private async chooseFont(id:string,append=false){
    const s=this.session;if(!s)return;const epoch=this.epoch;await this.cleanupRender();this.assert(s,epoch,this.revision);
    const font=await this.library.bundled(id);if(!this.owns(s,epoch))throw Error('Text session changed. Choose the font again.');
    if(append&&s.fonts.some(f=>f.bytes.hash===font.bytes.hash))return;
    s.fonts=append?[...s.fonts,font]:[font];s.style={...s.style,primaryFont:s.fonts[0].bytes.hash,explicitFallbacks:s.fonts.slice(1).map(f=>f.bytes.hash)};
    this.fontId=id;this.fontStatus='Available exact font versions.';this.invalidate();this.save();this.message='Font substitution draft. Preview reflow before Apply; previous history is unchanged.';
  }
  private async request():Promise<TextRequest>{
    const s=this.session;if(!s||!this.available())throw Error('Open a text draft first.');const epoch=this.epoch,revision=this.revision;
    if(s.locked)throw Error('Unlock to edit.');if(this.stale)throw Error('Stale text draft. Copy your text or cancel before opening the current layer.');
    if(s.placement)textPlacement(s.placement);const fonts=await this.library.load(s.fonts);this.assert(s,epoch,revision);
    return {token:{documentId:s.document.id,documentRevision:s.document.revision,layerId:s.layerId,layerVersion:s.layerVersion,sessionId:s.id,generation:Number(this.editor.draftOwner?.drafts.get(s.draftId)?.generation??'0')},text:s.text,style:structuredClone(s.style),frame:{...s.frame},fonts};
  }
  private async preparePreview(){
    const s=this.session;if(!s)return;if(this.composing)throw Error('Finish composition before previewing.');
    const epoch=this.epoch,revision=this.revision;this.clearPreview();await this.cleanupRender();this.assert(s,epoch,revision);this.message='Preparing text layout…';this.changed();
    try{const request=await this.request();this.assert(s,epoch,revision);this.renderer=new TextRenderer();const value=await this.renderer.prepare(request);
      let pixelsLease:ReturnType<typeof textMemory.reserve>|undefined,surfaceLease:AllocationLease|undefined;
      try{this.assert(s,epoch,revision);pixelsLease=textMemory.reserve(value.rgba.size*2);surfaceLease=allocationLedger.reserve({owner:'native-text-preview',kind:'canvas',gpuBytes:value.rgba.size,previewCacheBytes:value.rgba.size,handles:1});const pixels=new Uint8ClampedArray(await value.rgba.arrayBuffer());this.assert(s,epoch,revision);
        // Until arrayBuffer settles these reservations belong to this operation,
        // so input invalidation/Close cannot release its still-pending backing.
        this.previewLease=pixelsLease;pixelsLease=undefined;this.previewSurfaceLease=surfaceLease;surfaceLease=undefined;this.preview={revision,hash:value.rasterHash,overflow:value.overflow,width:value.width,height:value.height,pixels};this.message='Text preview ready. Accepted appearance is unchanged.';}
      finally{pixelsLease?.release();surfaceLease?.release();releasePrepared(value);}
    }finally{this.renderer?.dispose();this.renderer=undefined;this.library.clear();this.changed();}
    await this.host.updateComplete;this.paintPreview();
  }
  private paintPreview(){const p=this.preview,canvas=this.host.querySelector<HTMLCanvasElement>('#native-text-preview');if(!p||!canvas)return;canvas.width=p.width;canvas.height=p.height;canvas.getContext('2d')!.putImageData(new ImageData(p.pixels,p.width,p.height),0,0);}
  private async apply(intentTime?:number){
    const s=this.session;if(!s)return;if(this.composing){this.pendingAction='apply';this.pendingActionTime=intentTime??browserPhases.recorder.timestamp();this.message='Apply after composition';this.changed();return;}
    const layout=browserPhases.recorder.start('text.layout',{documentId:s.document.id,revision:s.document.revision,layerId:s.layerId,sessionId:s.id},intentTime);
    try {
    if(!this.preview||this.preview.revision!==this.revision)throw Error('Preview the current text and font layout before Apply.');
    if(!s.original&&!s.text)throw Error('Enter text before creating a layer.');
    const epoch=this.epoch,revision=this.revision,preview=this.preview;this.clearPreview();
    this.save(false);await this.flushCurrent(s);this.assert(s,epoch,revision);
    const saved=this.editor.draftOwner!.drafts.get(s.draftId);if(!saved||saved.savedGeneration!==saved.generation)throw Error('Save the current draft before Apply.');
    try{const request=await this.request();this.assert(s,epoch,revision);this.preparation=new DurableTextPreparation(this.storage);
      const result=await this.preparation.prepare(request,s.fonts);this.assert(s,epoch,revision);if(this.preparedHash!==preview.hash)throw Error('Text preview identity changed. Prepare a fresh preview before Apply.');
      // Reviewed pixels are recomputed by the unchanged adapter/writer; identities fence every step.
      const replacement=s.original&&canonical(s.original.text.fonts)!==canonical(s.fonts);
      const common={layerId:s.layerId,candidate:result.candidate,draft:{sessionId:s.id,draftId:s.draftId,generation:saved.generation},admissionId:result.admissionId};
      const events=await this.editor.command(s.original?{type:replacement?'ReplaceTextFont':'CommitTextEdit',...common,layerVersion:s.layerVersion,reviewedDependencyHash:result.dependencyHash}:{type:'CreateTextLayer',...common,name:s.name,placement:s.placement},s.document);
      const accepted=events.find(e=>e.type==='ImageEdited');
      // The receipt and local projection have arrived. Correct-pixel presentation
      // is a separate external trace, so this parent remains censored.
      layout.end('incomplete',{boundary:'authority-durable',generation:request.token.generation,...(accepted?{commandId:accepted.commandId,correlationId:accepted.correlationId,transactionId:accepted.transactionId,resultingRevision:accepted.resultingDocumentRevision??undefined}:{})});
      if(this.session===s&&this.revision===revision){this.session=undefined;this.epoch++;this.preview=undefined;this.message='Text applied and saved locally.';this.editor.select([s.layerId]);this.returnFocus();}
      else if(this.available()&&this.epoch===epoch)this.message='The reviewed version was saved; newer typing remains an unapplied draft.';
    }finally{await this.cleanupRender();this.changed();}
    }catch(error){layout.end(!this.available()||this.session!==s?'cancelled':'error');throw error;}
  }
  private async cleanupRender(){this.renderer?.dispose();this.renderer=undefined;this.preparation?.dispose();this.preparation=undefined;this.library.clear();if(!this.previewLease&&!this.closing)await releaseTextRealm(this.storage);}
  private async cancel(){
    if(this.composing){this.pendingAction='cancel';this.pendingSwitch=undefined;this.message='Cancel text edit after composition';this.changed();return;}
    const s=this.session;if(!s)return;const epoch=++this.epoch;this.pendingAction=undefined;this.pendingSwitch=undefined;this.clearPreview();await this.cleanupRender();
    if(!this.available()||this.session!==s||this.epoch!==epoch)return;await this.flushCurrent(s);if(!this.available()||this.session!==s||this.epoch!==epoch)return;if(this.editor.draftOwner?.drafts.has(s.draftId))await this.editor.clearDraft(s.draftId);
    if(!this.available()||this.session!==s||this.epoch!==epoch)return;
    if(this.session===s)this.session=undefined;this.error='';this.message='Text draft cancelled. Accepted appearance is unchanged.';this.returnFocus();this.changed();
  }
  private returnFocus(){if(this.opener?.isConnected)this.opener.focus();else this.host.querySelector<HTMLElement>('#inspector')?.focus();}
  overlay(ctx:CanvasRenderingContext2D){const s=this.session;if(!s)return;const layer=this.editor.view.image?.layers.find(l=>l.id===s.layerId);ctx.save();if(layer)ctx.transform(...layer.layerToDocument);else if(s.placement)ctx.translate(s.placement.x,s.placement.y);ctx.strokeStyle='#9866cc';ctx.setLineDash([4,3]);ctx.lineWidth=1;ctx.strokeRect(0,0,s.frame.width,s.frame.height);ctx.restore();}
  dispose(){this.disposed=true;this.abort.abort();return this.releaseDocument();}
  render(){
    const s=this.session,disabled=!!this.work||this.editor.view.busy||!this.editor.view.ready||this.stale||!!s?.locked;
    this.control.setAttribute('aria-invalid',String(!!this.error));this.control.setAttribute('aria-describedby',this.error?'native-text-policy native-text-error':'native-text-policy');if(this.error)this.control.setAttribute('aria-errormessage','native-text-error');else this.control.removeAttribute('aria-errormessage');
    this.control.readOnly=!!s?.locked;this.control.dir=s?.style.direction==='auto'?'auto':s?.style.direction??'auto';
    const layer=this.editor.view.image?.layers.find(l=>l.id===s?.layerId),point=this.screenPoint([layer?.layerToDocument[4]??s?.placement?.x??0,layer?.layerToDocument[5]??s?.placement?.y??0]);
    const renderEpoch=this.epoch;void this.host.updateComplete.then(()=>{if(renderEpoch!==this.epoch||!this.available())return;const region=this.host.querySelector<HTMLElement>('#native-text-editor');region?.style.setProperty('--text-left',Math.max(12,Math.min(innerWidth-460,point[0]))+'px');region?.style.setProperty('--text-top',Math.max(155,Math.min(innerHeight-300,point[1]))+'px');});
    return html`<section id="native-text-editor" class="native-text-editor" data-presentation=${this.presentation} ?hidden=${!s} aria-label="Text editing" data-session=${s?.draftId??''} data-revision=${this.revision}>
    <en-card><h2 slot="header">${s?.name??'Text'} <en-badge>Text draft</en-badge></h2>
    <en-stack gap="small"><label for="native-text-content">Edit text — ${s?.name??'Text'}</label><div class="native-text-host">${this.control}</div>
    <en-toolbar label="Text editing actions" keyboard-navigation="tab">
    <en-button ?disabled=${disabled} @pointerdown=${(e:PointerEvent)=>this.preventCompositionFocus(e)} @click=${(e:Event)=>this.action(e,'Apply text',()=>this.apply(this.eventTime(e)))}>Apply text</en-button>
    <en-button variant="secondary" ?disabled=${!!this.work} @pointerdown=${(e:PointerEvent)=>this.preventCompositionFocus(e)} @click=${(e:Event)=>this.action(e,'Cancel text edit',()=>this.cancel())}>Cancel text edit</en-button>
    <en-button variant="secondary" ?disabled=${this.stale} @pointerdown=${(e:PointerEvent)=>this.preserveSwitchFocus(e)} @click=${(e:Event)=>this.switchAction(e,this.presentation==='anchored'?'inspector':'anchored')}>${this.presentation==='anchored'?'Continue in inspector':'Return to card'}</en-button>
    ${this.pendingSwitch?html`<en-button @pointerdown=${(e:PointerEvent)=>this.preventCompositionFocus(e)} @click=${(e:Event)=>this.adapter.action(e,()=>{this.pendingSwitch=undefined;this.message='Switch cancelled';this.changed();})}>Cancel switch</en-button>`:nothing}</en-toolbar>
    <en-alert announcement="polite">${this.stale?'Stale text draft. Full text is retained; copy it or Cancel before opening the current layer.':this.message}</en-alert>
    <p id="native-text-policy" class="muted">One style for the whole frame. Enter inserts a newline. Preview then Apply; Cancel preserves the accepted layer. Native typing undo stays in this field.</p>
    ${this.error?html`<en-alert id="native-text-error" variant="warning" announcement="polite">${this.error}</en-alert>`:nothing}
    ${s?html`<div class="text-style-grid">${s.placement?html`${this.number('New text X (document px)',s.placement.x,v=>s.placement={...s.placement!,x:v})}${this.number('New text Y (document px)',s.placement.y,v=>s.placement={...s.placement!,y:v})}`:nothing}
    <en-select label="Font choice" .value=${this.fontId} ?disabled=${disabled} @en-change=${(e:Event)=>{const value=(e.currentTarget as HTMLInputElement).value;this.adapter.settled(e,()=>value,id=>{if(!this.available()||this.session!==s)return;this.fontId=id;this.changed();});}}>${fontChoices.map(f=>html`<en-select-option value=${f.id}>${f.id} · Regular · ${f.sha256.slice(0,8)}</en-select-option>`)}</en-select>
    ${this.number('Text size (document px)',s.style.sizePx,v=>s.style={...s.style,sizePx:v})}${this.number('Line height multiplier',s.style.lineHeightMultiplier,v=>s.style={...s.style,lineHeightMultiplier:v})}
    ${this.select('Text alignment',s.style.align,['left','center','right','start','end'],v=>s.style={...s.style,align:v as TextStyle['align']})}${this.select('Text direction',s.style.direction,['auto','ltr','rtl'],v=>s.style={...s.style,direction:v as TextStyle['direction']})}
    <en-color-field label="Text fill" .value=${'#'+s.style.fill.slice(0,3).map(n=>n.toString(16).padStart(2,'0')).join('')} ?disabled=${disabled} @en-change=${(e:Event)=>{const h=e.currentTarget as HTMLInputElement;this.mutate(e,()=>{const v=h.value;if(!/^#[a-fA-F0-9]{6}$/.test(v))throw Error('Choose a six-digit sRGB color.');s.style={...s.style,fill:[parseInt(v.slice(1,3),16),parseInt(v.slice(3,5),16),parseInt(v.slice(5,7),16),s.style.fill[3]]};});}}></en-color-field>
    ${this.number('Text alpha (0–255)',s.style.fill[3],v=>s.style={...s.style,fill:[s.style.fill[0],s.style.fill[1],s.style.fill[2],v]})}
    ${this.number('Text frame width (document px)',s.frame.width,v=>s.frame={...s.frame,width:v})}${this.number('Text frame height (document px)',s.frame.height,v=>s.frame={...s.frame,height:v})}</div>
    <en-stack direction="horizontal" wrap><en-button ?disabled=${disabled} @click=${(e:Event)=>this.action(e,'Choose text font',()=>this.chooseFont(this.fontId))}>Use selected font</en-button><en-button variant="secondary" ?disabled=${disabled} @click=${(e:Event)=>this.action(e,'Add explicit fallback',()=>this.chooseFont(this.fontId,true))}>Add explicit fallback</en-button></en-stack>
    <en-alert announcement="none">${this.fontStatus}</en-alert><en-alert announcement="none">Exact font order: ${s.fonts.map(f=>fontChoices.find(x=>'sha256:'+x.sha256===f.bytes.hash)?.id??('Local regular font · '+f.id.slice(7,15))).join(' → ')}. ${s.original?'Retained appearance stays available while edits are previewed. Font substitution changes this version only.':'New frame position is applied with text in one Undo unit. Existing layer Transform controls move, rotate or scale without reflow.'} Frame dimensions reflow text; layer scale does not.</en-alert>
    <en-accordion-item label="Local font import and exact relink"><en-file-upload label="Font file" accept=".ttf,.otf" @en-change=${(e:Event)=>{const h=e.currentTarget as unknown as {files:File[]};this.adapter.settled(e,()=>h.files,v=>{if(this.available()&&this.session===s)this.files=v;});}}></en-file-upload><en-file-upload label="Font license record" accept="text/plain,.txt" @en-change=${(e:Event)=>{const h=e.currentTarget as unknown as {files:File[]};this.adapter.settled(e,()=>h.files,v=>{if(this.available()&&this.session===s)this.licenses=v;});}}></en-file-upload><en-alert announcement="none">Import only a supported static regular font with editable embedding permission. Exact relink must match the retained bytes and license; a different font requires substitution preview.</en-alert><en-switch label="I have permission to embed this font" .checked=${this.embeddingReviewed} @en-change=${(e:Event)=>{const h=e.currentTarget as unknown as {checked:boolean};this.adapter.settled(e,()=>h.checked,v=>{if(!this.available()||this.session!==s)return;this.embeddingReviewed=v;this.changed();});}}></en-switch><en-button ?disabled=${disabled||!this.embeddingReviewed} @click=${(e:Event)=>this.action(e,'Import local font',async()=>{if(!this.embeddingReviewed||!this.files[0]||!this.licenses[0])throw Error('Choose the font and its license record and confirm embedding permission.');const epoch=this.epoch,fontFile=this.files[0],licenseFile=this.licenses[0];await this.cleanupRender();this.assert(s,epoch,this.revision);const font=await this.library.import(fontFile,licenseFile,'local-file');if(!this.owns(s,epoch))throw Error('Text session changed. Choose the font again.');s.fonts=[font];s.style={...s.style,primaryFont:font.bytes.hash,explicitFallbacks:[]};this.fontStatus='Substitution draft: validated local regular font. Preview before Apply.';this.invalidate();this.save();})}>Import as substitution draft</en-button><en-button variant="secondary" ?disabled=${disabled} @click=${(e:Event)=>this.action(e,'Relink exact font',async()=>{if(!this.files[0]||!this.licenses[0])throw Error('Choose the exact font and its license record.');const epoch=this.epoch,fontFile=this.files[0],licenseFile=this.licenses[0];const {hash,license}=await hashRelinkInputs(fontFile,licenseFile);this.assert(s,epoch,this.revision);const prior=s.fonts.find(f=>f.bytes.hash===hash&&f.licenseRecord.hash===license);if(!prior)throw Error('Exact relink requires matching retained font and license bytes.');await this.cleanupRender();this.assert(s,epoch,this.revision);await this.library.import(fontFile,licenseFile,prior.origin);if(!this.owns(s,epoch))throw Error('Text session changed. Reopen font status.');this.invalidate();void this.checkFonts(s);this.message='Exact font relinked. Prepare a fresh text preview.';})}>Relink exact font</en-button></en-accordion-item>
    <en-button variant="secondary" ?disabled=${disabled||this.composing} @click=${(e:Event)=>this.action(e,'Preview text',()=>this.preparePreview())}>Preview text</en-button>
    ${this.preview?html`<en-alert variant=${this.preview.overflow?'warning':'info'} announcement="none">${this.preview.overflow?'Clipped overflow. Full text is retained. Enlarge the frame, reduce text size or line height, or Apply this clipped preview.':'Text fits the preview frame.'} Draft preview only.</en-alert><canvas id="native-text-preview" aria-label="Canonical text draft preview"></canvas>`:nothing}`:nothing}
    </en-stack></en-card></section>`;
  }
}
