import {displayImage} from './display-image.js';
import {createDisplayPreviewURL,sourceFromAsset,displayPreviewInfo,validateDisplayImage,revokeDisplayPreviewURL} from '../observability/display-preview.js';
import {html,nothing} from 'lit';
import type {LitElement} from 'lit';
import type {EditorClient} from '../state/editor-client.js';
import type {Document} from '../protocol/store.js';
import type {Asset} from '../protocol/assets.js';
import type {DocumentExportOptions} from '../protocol/export.js';
import {ControlAdapter} from './adapters.js';
import {exportOptions,initialExportForm,type ExportForm} from '../state/export-options.js';
import {browserPhases} from '../observability/browser.js';
import type {PhaseSpan} from '../observability/phases.js';

type Owner={session:EditorClient['session'];identity:string|null;sessionId:string;draftOwner:EditorClient['draftOwner'];documentId:string|null;documentEpoch:number;epoch:number};
type Prepared={document:Document;options:DocumentExportOptions;asset:Asset;url:string;loaded:boolean;confirmed:boolean;width:number;height:number};
type ExportOperation={owner:Owner;commandId:string|null;cancelRequested:boolean;cancelTask:Promise<void>|null;cancelOutcome:'canceled'|'completed'|'failed'|null;durable:boolean;phase:PhaseSpan;preparing:boolean;pendingCancellation:boolean;cleanupError:string|null};
type CleanupFailure={commandId:string;owner:{session:EditorClient['session'];identity:string|null};message:string;pending:Promise<void>|null};

/** Encoding happens once. Display renditions are derived from the exact encoded export. */
export class ExportControls {
 private controls=new ControlAdapter();private epoch=0;private generation=0;private owner:Owner|null=null;private active:ExportOperation|null=null;private abort:AbortController|null=null;
 private form:ExportForm|null=null;private prepared:Prepared|null=null;private busy=false;private composing=false;private message='';private error='';
 private operations=new Set<ExportOperation>();private cleanupFailures=new Map<string,CleanupFailure>();private cleanupWaiters=new Set<()=>void>();
 constructor(private host:LitElement,private editor:EditorClient,private onConfirmed:()=>void=()=>{}){}
 private changed(){this.host.requestUpdate();}
 private capture():Owner{return {session:this.editor.session,identity:this.editor.session.identity(),sessionId:this.editor.sessionId,draftOwner:this.editor.draftOwner,documentId:this.editor.view.document?.id??null,documentEpoch:this.editor.documentEpoch,epoch:this.epoch};}
 private current(owner:Owner){const now=this.capture();return this.editor.view.ready&&!!now.documentId&&Object.keys(now).every(key=>now[key as keyof Owner]===owner[key as keyof Owner]);}
 private clearPreview(){const active=this.active;if(active&&!active.durable)void this.requestCancellation(active);this.abort?.abort();this.abort=null;if(this.prepared)revokeDisplayPreviewURL(this.prepared.url);this.prepared=null;this.active=null;this.busy=false;this.generation++;this.controls.invalidate();}
 releaseDocument(){this.clearPreview();this.epoch++;this.owner=null;this.form=null;this.composing=false;this.message='';this.error='';this.changed();}
 dispose(){this.releaseDocument();}
 inspect(){const pendingPreparations=[...this.operations].filter(operation=>operation.preparing).length,pendingCancellations=[...this.operations].filter(operation=>operation.pendingCancellation||operation.cancelRequested&&!operation.durable&&!operation.cancelOutcome&&!operation.cleanupError).length+[...this.cleanupFailures.values()].filter(failure=>failure.pending).length,cleanupFailures=[...this.operations].filter(operation=>operation.cleanupError).length+[...this.cleanupFailures.values()].filter(failure=>failure.message).length;return {previewURLs:this.prepared?1:0,activeReads:this.abort?1:0,retainedDocument:this.prepared!==null||pendingPreparations>0,preparing:this.busy||pendingPreparations>0,pendingPreparations,pendingCancellations,cleanupFailures};}
 private signalCleanup(){for(const resolve of this.cleanupWaiters)resolve();this.cleanupWaiters.clear();}
 private trackSettlement(operation:ExportOperation){
  if(!operation.preparing&&!operation.pendingCancellation){
   if(operation.cleanupError&&operation.commandId)this.cleanupFailures.set(operation.commandId,{commandId:operation.commandId,owner:{session:operation.owner.session,identity:operation.owner.identity},message:operation.cleanupError,pending:null});
   if(operation.cleanupError||!operation.cancelRequested||operation.durable||operation.cancelOutcome||!operation.commandId)this.operations.delete(operation);
  }
  this.signalCleanup();
 }
 private retryCleanup(failure:CleanupFailure){
  if(failure.pending)return;failure.message='';failure.pending=this.editor.cancelExport(failure.commandId,failure.owner).then(()=>{this.cleanupFailures.delete(failure.commandId);}).catch(error=>{failure.message=error instanceof Error?error.message:'EXPORT_CANCELLATION_UNCONFIRMED';}).finally(()=>{failure.pending=null;this.signalCleanup();this.changed();});
 }
 async releaseAndWait(timeoutMs=30_000){
  this.releaseDocument();for(const operation of this.operations)if(operation.cleanupError&&!operation.pendingCancellation)void this.requestCancellation(operation);for(const failure of this.cleanupFailures.values())this.retryCleanup(failure);
  const deadline=performance.now()+timeoutMs;
  for(;;){
   for(const operation of this.operations)if(operation.preparing&&(operation.owner.session!==this.editor.session||operation.owner.identity!==this.editor.session.identity()))operation.cleanupError='EXPORT_CANCELLATION_OWNER_CHANGED';
   const failure=[...this.operations].find(operation=>operation.cleanupError)?.cleanupError??[...this.cleanupFailures.values()].find(value=>value.message)?.message;
   if(failure)throw Error('EXPORT_RELEASE_UNCONFIRMED: '+failure);
   if(!this.operations.size&&!this.cleanupFailures.size)return;
   const remaining=deadline-performance.now();if(remaining<=0){for(const operation of this.operations)operation.cleanupError='Export preparation or cancellation has not settled.';for(const pending of this.cleanupFailures.values())pending.message='Export cancellation has not settled.';this.signalCleanup();throw Error('EXPORT_RELEASE_UNCONFIRMED: Export preparation or cancellation has not settled.');}
   await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);this.cleanupWaiters.delete(done);resolve();},timer=setTimeout(done,remaining);this.cleanupWaiters.add(done);});
  }
 }
 sync(){if(this.owner&&!this.current(this.owner))this.releaseDocument();this.signalCleanup();}
 begin(){this.releaseDocument();const document=this.editor.view.document;if(!document||!this.editor.view.ready)return;this.owner=this.capture();this.form=initialExportForm(document);this.message='Choose the exact scope and output settings, then prepare their preview. Unapplied drafts are excluded.';this.changed();}
 cancel(){
  const active=this.active;
  if(active&&!active.durable){this.abort?.abort();this.abort=null;this.generation++;this.controls.invalidate();active.cancelRequested=true;this.busy=true;this.error='';this.message='Cancellation requested. Waiting for the local export worker to stop and release its partial output. Previous prepared files and destination files remain available.';void this.requestCancellation(active);this.changed();return;}
  const durable=active?.durable||!!this.prepared;this.clearPreview();this.message=durable?'Export preview closed. Encoding already completed; its exact bytes remain saved locally. Previous destination files remain available.':'Export review canceled. Previous prepared files and destination files remain available.';this.error='';this.changed();
 }
 private finishCancellation(operation:ExportOperation,status:'canceled'|'completed'|'failed',code?:string){
  operation.cancelOutcome=status;operation.cleanupError=null;if(operation.commandId)this.cleanupFailures.delete(operation.commandId);if(!operation.durable)operation.phase.end(status==='canceled'?'cancelled':status==='failed'?'rejected':'incomplete',{boundary:'cancel-intent'});this.trackSettlement(operation);
  if(this.active!==operation||!this.current(operation.owner))return;
  this.abort?.abort();this.abort=null;this.active=null;this.busy=false;this.generation++;this.controls.invalidate();this.error='';
  this.message=status==='canceled'?'Export canceled. The local worker has stopped and its partial output has been removed. Previous prepared files and destination files remain available.':status==='failed'?'The original export failed before cancellation completed. Its rejected receipt is retained. Previous prepared files and destination files remain available.':'Export finished before cancellation. Its exact encoded bytes remain saved locally; the preview is closed. Previous destination files remain available.';if(status==='failed')this.error=code??'EXPORT_UNAVAILABLE';this.changed();
 }
 private requestCancellation(operation:ExportOperation){
  operation.cancelRequested=true;if(operation.cancelOutcome||operation.cancelTask||!operation.commandId)return operation.cancelTask;operation.cleanupError=null;operation.pendingCancellation=true;this.cleanupFailures.delete(operation.commandId);this.operations.add(operation);
  operation.cancelTask=this.editor.cancelExport(operation.commandId,{session:operation.owner.session,identity:operation.owner.identity}).then(result=>{this.finishCancellation(operation,result.status==='completed'&&result.receipt.status==='rejected'?'failed':result.status,result.receipt.status==='rejected'?result.receipt.code:undefined);}).catch(error=>{
   operation.cancelTask=null;if(operation.durable||operation.cancelOutcome)return;operation.cleanupError=error instanceof Error?error.message:'EXPORT_CANCELLATION_UNCONFIRMED';
   if(!operation.durable)operation.phase.end('incomplete',{boundary:'cancel-intent'});
   if(this.active!==operation||!this.current(operation.owner))return;
   this.error='Cancellation is unconfirmed. '+(error instanceof Error?error.message:'The local writer could not be reached.');this.message='The original export may still complete. Retry cancellation for this same command or inspect its retained receipt before preparing another export.';this.changed();
  }).finally(()=>{operation.pendingCancellation=false;this.trackSettlement(operation);this.changed();});return operation.cancelTask;
 }
 private edit<T>(event:Event,owner:Owner,read:()=>T,set:(value:T)=>void){this.controls.settled(event,read,value=>{if(!this.current(owner)||this.busy)return;set(value);this.clearPreview();this.error='';this.message='Settings changed. Prepare a fresh preview before confirming export.';this.changed();});}
 private action(event:Event,owner:Owner,work:()=>void|Promise<void>){const generation=this.generation;this.controls.action(event,()=>{if(!this.current(owner)||generation!==this.generation||this.busy||this.composing||this.editor.view.busy)return;void Promise.resolve().then(work).catch(error=>{if(this.current(owner)&&generation===this.generation){this.error=error instanceof Error?error.message:'Export unavailable.';this.changed();}});});}
 private async prepare(owner:Owner,intentTime=performance.now()){
  const document=this.editor.view.document;if(!document||!this.form||!this.current(owner))return;
  const frozen=structuredClone(document),options=exportOptions(this.form,document,this.editor.view.image,this.editor.view.selected);
  this.clearPreview();const phase=browserPhases.recorder.start('document.export',{documentId:frozen.id,revision:frozen.revision,boundary:'intent'},intentTime);
  const token:ExportOperation={owner,commandId:null,cancelRequested:false,cancelTask:null,cancelOutcome:null,durable:false,phase,preparing:true,pendingCancellation:false,cleanupError:null},generation=this.generation;this.operations.add(token);this.active=token;this.busy=true;this.error='';this.message='Compositing and encoding the chosen revision. Preparing durable local export bytes…';this.changed();
  const current=()=>this.current(owner)&&this.active===token&&this.generation===generation;
  try{
   const asset=await this.editor.prepareExport(options,frozen,commandId=>{token.commandId=commandId;if(token.cancelRequested)void this.requestCancellation(token);});if(token.cancelOutcome==='canceled'||token.cancelOutcome==='failed')return;
   const mediaType=options.format==='jpeg'?'image/jpeg':'image/png',width=options.resize?.width??frozen.width,height=options.resize?.height??frozen.height;
   if(asset.blob.mediaType!==mediaType||asset.raster?.role!=='export'||asset.raster.width!==width||asset.raster.height!==height)throw Error('Prepared export identity does not match the chosen settings.');
   phase.end('ok',{boundary:'authority-durable',outputAssetId:asset.id,assetHash:asset.blob.hash});token.durable=true;
   if(token.cancelRequested){this.finishCancellation(token,'completed');return;}if(!current())return;
   const abort=new AbortController();this.abort=abort;this.message='Local bytes are ready. Loading a bounded preview of the actual encoded file before confirmation…';this.changed();
   const url=await createDisplayPreviewURL(this.editor.session.transport.bind(this.editor.session),sourceFromAsset(asset,'encoded'),{owner:'export-preview',edge:1024,signal:abort.signal,owns:current});
   if(!current()){revokeDisplayPreviewURL(url);return;}
   this.prepared={document:frozen,options:structuredClone(options),asset:structuredClone(asset),url,loaded:false,confirmed:false,width,height};this.abort=null;this.message='Inspect the scaled preview of the actual encoded export, original size and matte. Confirmation exports the retained original bytes.';
  }catch(error){if(!token.durable&&(!token.cancelRequested||!token.commandId))phase.end('error');if(!(token.cancelRequested&&token.commandId)&&this.active===token&&this.current(owner)){this.abort?.abort();this.abort=null;this.error=error instanceof Error?error.message:'Export unavailable.';this.message='Export could not be prepared. Previous prepared files remain available.';this.busy=false;this.active=null;this.changed();}}
  finally{if(current()&&!token.cancelRequested){this.busy=false;this.active=null;this.abort=null;this.changed();}token.preparing=false;if(token.durable||token.cancelOutcome)token.cleanupError=null;this.trackSettlement(token);}
 }
 private loaded(event:Event,prepared:Prepared){const image=event.currentTarget as HTMLImageElement;if(this.prepared!==prepared||!this.owner||!this.current(this.owner)||image.src!==prepared.url)return;try{validateDisplayImage(image,prepared.url);prepared.loaded=true;}catch{this.error='Decoded preview dimensions differ from the declared display rendition.';prepared.loaded=false;}this.changed();}
 private confirm(prepared:Prepared,owner:Owner){if(!this.current(owner)||this.prepared!==prepared||!prepared.loaded||prepared.confirmed||this.composing)return;prepared.confirmed=true;this.editor.confirmExport(prepared.asset,prepared.document);this.message='Export ready. Choose a destination for the prepared file. A download request alone does not confirm a destination write.';this.changed();this.onConfirmed();}
 render(){
  const form=this.form,owner=this.owner,prepared=this.prepared,active=this.active;if(!form||!owner)return html`<p>Open a document before preparing an export.</p>`;
  const text=(key:Exclude<keyof ExportForm,'includeHidden'>)=>(event:Event)=>{const host=event.currentTarget as HTMLElement&{value:string};this.edit(event,owner,()=>host.value,value=>{(form as Record<string,unknown>)[key]=value;});};
  const act=(event:Event,work:()=>void|Promise<void>)=>this.action(event,owner,work),disabled=this.busy||this.editor.view.busy||!this.current(owner);
  return html`<section class="export-controls" aria-label="Export settings and preview" aria-busy=${String(this.busy)} @compositionstart=${()=>{this.composing=true;this.clearPreview();this.changed();}} @compositionend=${()=>{this.composing=false;this.changed();}}>
   <p role="status">${this.message}</p>${this.error?html`<p role="alert">${this.error}</p>`:nothing}
   <en-select id="export-scope" label="Export scope" .value=${form.scope} ?disabled=${disabled} @en-change=${text('scope')}><en-select-option value="visible-document">Whole visible document</en-select-option><en-select-option value="selected-layers">Explicit selected-layer composite</en-select-option></en-select>
   ${form.scope==='selected-layers'?html`<p>${this.editor.view.selected.length} selected layers; original document bounds and layer order are retained.</p><en-switch id="export-include-hidden" label="Include hidden selected layers" .checked=${form.includeHidden} ?disabled=${disabled} @en-change=${(event:Event)=>{const host=event.currentTarget as HTMLElement&{checked:boolean};this.edit(event,owner,()=>host.checked,value=>{form.includeHidden=value;});}}></en-switch>`:nothing}
   <en-select id="export-format" label="Export format" .value=${form.format} ?disabled=${disabled} @en-change=${text('format')}><en-select-option value="png">PNG with alpha</en-select-option><en-select-option value="jpeg">JPEG with opaque matte</en-select-option></en-select>
   <en-select id="export-dimensions" label="Export dimensions" .value=${form.dimensions} ?disabled=${disabled} @en-change=${text('dimensions')}><en-select-option value="native">Native document dimensions</en-select-option><en-select-option value="resize">Deliberate export resize</en-select-option></en-select>
   ${form.dimensions==='resize'?html`<div class="property-grid"><en-number-field id="export-width" label="Export width (px)" .value=${form.width} .min=${1} .max=${8192} .step=${1} ?disabled=${disabled} @en-change=${text('width')}></en-number-field><en-number-field id="export-height" label="Export height (px)" .value=${form.height} .min=${1} .max=${8192} .step=${1} ?disabled=${disabled} @en-change=${text('height')}></en-number-field></div><p>Resize changes only this export. Review the actual result before approval.</p>`:nothing}
   ${form.format==='jpeg'?html`<en-text-field id="export-matte" label="Opaque sRGB matte (#RRGGBB)" .value=${form.matte} ?disabled=${disabled} @en-change=${text('matte')}></en-text-field><en-number-field id="export-quality" label="JPEG quality (0.01–1)" .value=${form.quality} .min=${0.01} .max=${1} .step=${0.01} ?disabled=${disabled} @en-change=${text('quality')}></en-number-field><p>JPEG removes alpha over this explicit matte and is lossy. Quality defaults to 0.9. The preview uses the actual encoded JPEG.</p>`:html`<p>PNG retains alpha. Native-size whole-document export uses the accepted canonical pixels.</p>`}
   <p>Provider output format is a separate request setting. Export changes no layers, checkpoint or request and performs no provider work.</p>
   <en-button id="prepare-export" ?disabled=${disabled||this.composing} @click=${(event:Event)=>act(event,()=>this.prepare(owner,event.timeStamp))}>Prepare export preview</en-button>
   ${this.busy?html`<en-button id="cancel-export-preparation" ?disabled=${!!active?.cancelTask&&!active.cancelOutcome} @click=${(event:Event)=>this.controls.action(event,()=>{if(this.current(owner)&&active!==null&&this.active===active&&!active.cancelTask)this.cancel();})}>${active?.cancelRequested?'Retry cancellation status':'Cancel export preparation'}</en-button>`:nothing}
   ${prepared?html`<en-card id="export-review"><h2>Review frozen export</h2><p>Revision ${prepared.document.revision} · ${prepared.width} × ${prepared.height} · ${prepared.options.format.toUpperCase()} · ${prepared.asset.blob.byteLength} bytes</p><p>${prepared.options.scope.kind==='visible-document'?'Whole visible document':prepared.options.scope.layerIds.length+' explicitly selected layers'+(prepared.options.scope.includeHidden?' including hidden layers':' excluding hidden layers')}. ${prepared.options.resize?'Deliberately resized export.':'Native dimensions.'} ${prepared.options.format==='jpeg'?'Opaque matte '+prepared.options.matte+'; quality '+prepared.options.quality+'.':'Alpha retained.'}</p>${this.editor.view.document?.revision!==prepared.document.revision?html`<p>The document has changed since this export was frozen. This preview still contains revision ${prepared.document.revision}.</p>`:nothing}<img id="export-preview" class="review-image" src=${displayImage(prepared.url)} alt="Scaled preview of the actual encoded export for the frozen revision" @load=${(event:Event)=>this.loaded(event,prepared)} @error=${()=>{if(this.prepared===prepared){prepared.loaded=false;this.error='Encoded export could not be displayed. Confirmation is blocked.';this.changed();}}}><p>The transparency checkerboard is a display aid; it is excluded from the file. Scaled preview ${displayPreviewInfo(prepared.url)?.width} × ${displayPreviewInfo(prepared.url)?.height}; the export retains its original dimensions and encoded bytes.</p><en-button id="confirm-export" ?disabled=${disabled||!prepared.loaded||prepared.confirmed||this.composing} @click=${(event:Event)=>act(event,()=>this.confirm(prepared,owner))}>Confirm reviewed export</en-button></en-card>`:nothing}
  </section>`;
 }
}
