import {displayImage} from './display-image.js';
import {createDisplayPreviewURL,withAssetDisplaySource,displayPreviewInfo,validateDisplayImage,revokeDisplayPreviewURL} from '../observability/display-preview.js';
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
import {modelPayloadBytes,reserveModelBytes,type OwnedModel} from '../observability/model-memory.js';
import {ExportMemory,EXPORT_MEMORY_LIMITS,exportDiagnostic,type ExportRecord} from './export-memory.js';

type Owner={id:number;session:EditorClient['session'];identity:string|null;sessionId:string;draftOwner:number;documentId:string|null;documentEpoch:number;epoch:number};
type Prepared={id:number;record:ExportRecord;payloads:OwnedModel<unknown>[];document:Document;options:DocumentExportOptions;asset:Asset;url:string;loaded:boolean;confirmed:boolean;width:number;height:number};
type ExportOperation={id:number;record:ExportRecord;owner:Owner;commandId:string|null;cancelRequested:boolean;cancelTask:Promise<void>|null;cancelOutcome:'canceled'|'completed'|'failed'|null;durable:boolean;phase:PhaseSpan;preparing:boolean;pendingCancellation:boolean;cleanupError:string|null};
type CleanupFailure={record:ExportRecord;retired:boolean;commandId:string;owner:{session:EditorClient['session'];identity:string|null};message:string;pending:Promise<void>|null};

/** Encoding happens once. Display renditions are derived from the exact encoded export. */
export class ExportControls {
 private controls=new ControlAdapter();private epoch=0;private generation=0;private fieldGeneration=0;private owner:Owner|null=null;private active:ExportOperation|null=null;private abort:AbortController|null=null;
 private form:ExportForm|null=null;private prepared:Prepared|null=null;private busy=false;private composing=false;private message='';private error='';
 private operations=new Set<ExportOperation>();private cleanupFailures=new Map<string,CleanupFailure>();private cleanupWaiters=new Set<()=>void>();
 private memory:ExportMemory;private formOwner:OwnedModel<ExportForm>|null=null;private ownerRecord:ExportRecord|null=null;private serial=0;private draftSerial=0;private draftIds=new WeakMap<object,number>();
 private callbacks=new Set<Promise<void>>();private timers=new Map<ReturnType<typeof setTimeout>,()=>void>();private releaseTask:Promise<void>|null=null;
 constructor(private host:LitElement,private editor:EditorClient,private onConfirmed:()=>void=()=>{}){this.memory=new ExportMemory(host,()=>this.signalCleanup());}
 inspectMemory(){return {...this.memory.inspect(),callbacks:this.callbacks.size,timers:this.timers.size};}
 private changed(){this.host.requestUpdate();}
 private draftIdentity(){const draft=this.editor.draftOwner;if(!draft)return 0;let id=this.draftIds.get(draft);if(id===undefined){id=++this.draftSerial;this.draftIds.set(draft,id);}return id;}
 private capture():Owner{const identity=this.editor.session.identity(),sessionId=this.editor.sessionId,documentId=this.editor.view.document?.id??null;if((identity?.length??0)+sessionId.length+(documentId?.length??0)>1536)throw Error('EXPORT_OWNER_LIMIT');return {id:++this.serial,session:this.editor.session,identity,sessionId,draftOwner:this.draftIdentity(),documentId,documentEpoch:this.editor.documentEpoch,epoch:this.epoch};}
 private current(owner:Owner){return this.editor.view.ready&&!!owner.documentId&&owner.epoch===this.epoch&&owner.documentId===this.editor.view.document?.id&&owner.documentEpoch===this.editor.documentEpoch&&owner.session===this.editor.session&&owner.identity===this.editor.session.identity()&&owner.sessionId===this.editor.sessionId&&owner.draftOwner===this.draftIdentity();}
 private resolveOwner(id:number){const owner=this.owner;return owner?.id===id&&this.current(owner)?owner:null;}
 private clearPrepared(){const prepared=this.prepared;if(!prepared)return;revokeDisplayPreviewURL(prepared.url);this.prepared=null;for(const model of prepared.payloads)this.memory.retire(model);this.memory.retire(prepared.record);}
 private clearPreview(preserveFieldCallbacks=false){const active=this.active;if(active&&!active.durable)void this.requestCancellation(active);this.abort?.abort();this.abort=null;this.clearPrepared();this.active=null;this.busy=false;this.generation++;if(!preserveFieldCallbacks)this.fieldGeneration++;this.controls.invalidate();}
 releaseDocument(){this.clearPreview();this.epoch++;this.owner=null;this.ownerRecord?.release();this.ownerRecord=null;this.form=null;if(this.formOwner)this.memory.retire(this.formOwner);this.formOwner=null;for(const [timer,finish]of this.timers){clearTimeout(timer);finish();}this.timers.clear();this.composing=false;this.message='';this.error='';this.changed();}
 dispose(){this.releaseDocument();}
 inspect(){const pendingPreparations=[...this.operations].filter(operation=>operation.preparing).length,pendingCancellations=[...this.operations].filter(operation=>operation.pendingCancellation||operation.cancelRequested&&!operation.durable&&!operation.cancelOutcome&&!operation.cleanupError).length+[...this.cleanupFailures.values()].filter(failure=>failure.pending).length,cleanupFailures=[...this.operations].filter(operation=>operation.cleanupError).length+[...this.cleanupFailures.values()].filter(failure=>failure.message).length;return {previewURLs:this.prepared?1:0,activeReads:this.abort?1:0,retainedDocument:this.prepared!==null||pendingPreparations>0,preparing:this.busy||pendingPreparations>0,pendingPreparations,pendingCancellations,cleanupFailures};}
 private signalCleanup(){for(const resolve of this.cleanupWaiters)resolve();this.cleanupWaiters.clear();}
 private removeCleanup(commandId:string){const failure=this.cleanupFailures.get(commandId);if(!failure)return;this.cleanupFailures.delete(commandId);failure.retired=true;if(!failure.pending)failure.record.release();}
 private trackSettlement(operation:ExportOperation){
  if(!operation.preparing&&!operation.pendingCancellation){
   // A visible uncertain operation still owns its same-command Retry action.
   // Transfer its record only after that active owner has been detached.
   if(operation.cleanupError&&this.active===operation&&this.current(operation.owner)){this.signalCleanup();return;}
   let transferred=false;if(operation.cleanupError&&operation.commandId&&!this.cleanupFailures.has(operation.commandId)){this.cleanupFailures.set(operation.commandId,{record:operation.record,retired:false,commandId:operation.commandId,owner:{session:operation.owner.session,identity:operation.owner.identity},message:operation.cleanupError,pending:null});transferred=true;}
   if(operation.cleanupError||!operation.cancelRequested||operation.durable||operation.cancelOutcome||!operation.commandId){if(this.operations.delete(operation)&&!transferred)operation.record.release();}
  }
  this.signalCleanup();
 }
 private retryCleanup(failure:CleanupFailure){
  if(failure.pending)return;failure.message='';failure.pending=this.editor.ownedCancelExport(failure.commandId,failure.owner).then(result=>{try{this.removeCleanup(failure.commandId);}finally{result.release();}}).catch(error=>{failure.message=exportDiagnostic(error,'EXPORT_CANCELLATION_UNCONFIRMED');}).finally(()=>{failure.pending=null;if(failure.retired)failure.record.release();this.signalCleanup();this.changed();});
 }
 releaseAndWait(timeoutMs=30_000){if(this.releaseTask)return this.releaseTask;const task=this.releaseAndWaitOwned(timeoutMs);this.releaseTask=task.finally(()=>{this.releaseTask=null;});void this.releaseTask.catch(()=>{});return this.releaseTask;}
 private async releaseAndWaitOwned(timeoutMs:number){
  this.releaseDocument();for(const operation of this.operations)if(operation.cleanupError&&!operation.pendingCancellation)void this.requestCancellation(operation);for(const failure of this.cleanupFailures.values())this.retryCleanup(failure);
  const deadline=performance.now()+timeoutMs;let retirementRequested=false;
  for(;;){
   if(this.owner)throw Error('EXPORT_RELEASE_SUPERSEDED: A new export review opened while prior cleanup was draining.');
   for(const operation of this.operations)if(operation.preparing&&(operation.owner.session!==this.editor.session||operation.owner.identity!==this.editor.session.identity()))operation.cleanupError='EXPORT_CANCELLATION_OWNER_CHANGED';
   const failure=[...this.operations].find(operation=>operation.cleanupError)?.cleanupError??[...this.cleanupFailures.values()].find(value=>value.message)?.message;
   if(failure)throw Error('EXPORT_RELEASE_UNCONFIRMED: '+failure);
   if(!this.operations.size&&!this.cleanupFailures.size&&!this.callbacks.size){if(!retirementRequested){this.memory.retryRetirements();retirementRequested=true;}const memory=this.memory.inspect();if(memory.failed)throw Error('EXPORT_RELEASE_UNCONFIRMED: EXPORT_RENDER_RELEASE_UNCONFIRMED');if(!memory.pending&&!memory.retired&&!memory.models&&!memory.records.operation&&!memory.records.owner&&!memory.records.action)return;}
   const remaining=deadline-performance.now();if(remaining<=0){for(const operation of this.operations)operation.cleanupError='Export preparation or cancellation has not settled.';for(const pending of this.cleanupFailures.values())pending.message='Export cancellation has not settled.';this.signalCleanup();throw Error('EXPORT_RELEASE_UNCONFIRMED: Export preparation, cancellation or UI release has not settled.');}
   await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);this.cleanupWaiters.delete(done);resolve();},timer=setTimeout(done,remaining);this.cleanupWaiters.add(done);});
  }
 }
 sync(){if(this.owner&&!this.current(this.owner))this.releaseDocument();this.signalCleanup();}
 begin(){const document=this.editor.view.document;if(!document||!this.editor.view.ready){this.releaseDocument();return;}let record:ExportRecord|undefined,form:OwnedModel<ExportForm>|undefined;
  try{record=this.memory.record('owner');const owner=this.capture();form=this.memory.create('form',8192,()=>initialExportForm(document),EXPORT_MEMORY_LIMITS.formBytes);this.releaseDocument();owner.epoch=this.epoch;this.owner=owner;this.ownerRecord=record;record=undefined;this.formOwner=form;this.form=form.value;form=undefined;this.message='Choose the exact scope and output settings, then prepare their preview. Unapplied drafts are excluded.';this.changed();}
  catch(error){record?.release();form?.release();this.error=exportDiagnostic(error);this.changed();}
 }
 cancel(){
  const active=this.active;
  if(active&&!active.durable){this.abort?.abort();this.abort=null;this.generation++;this.fieldGeneration++;this.controls.invalidate();active.cancelRequested=true;this.busy=true;this.error='';this.message='Cancellation requested. Waiting for the local export worker to stop and release its partial output. Previous prepared files and destination files remain available.';void this.requestCancellation(active);this.changed();return;}
  const durable=active?.durable||!!this.prepared;this.clearPreview();this.message=durable?'Export preview closed. Encoding already completed; its exact bytes remain saved locally. Previous destination files remain available.':'Export review canceled. Previous prepared files and destination files remain available.';this.error='';this.changed();
 }
 private finishCancellation(operation:ExportOperation,status:'canceled'|'completed'|'failed',code?:string){
  operation.cancelOutcome=status;operation.cleanupError=null;if(operation.commandId)this.removeCleanup(operation.commandId);if(!operation.durable)operation.phase.end(status==='canceled'?'cancelled':status==='failed'?'rejected':'incomplete',{boundary:'cancel-intent'});this.trackSettlement(operation);
  if(this.active!==operation||!this.current(operation.owner))return;
  this.abort?.abort();this.abort=null;this.active=null;this.busy=false;this.generation++;this.fieldGeneration++;this.controls.invalidate();this.error='';
  this.message=status==='canceled'?'Export canceled. The local worker has stopped and its partial output has been removed. Previous prepared files and destination files remain available.':status==='failed'?'The original export failed before cancellation completed. Its rejected receipt is retained. Previous prepared files and destination files remain available.':'Export finished before cancellation. Its exact encoded bytes remain saved locally; the preview is closed. Previous destination files remain available.';if(status==='failed')this.error=exportDiagnostic(code,'EXPORT_UNAVAILABLE');this.changed();
 }
 private requestCancellation(operation:ExportOperation){
  operation.cancelRequested=true;if(operation.cancelOutcome||operation.cancelTask||!operation.commandId)return operation.cancelTask;operation.cleanupError=null;operation.pendingCancellation=true;this.removeCleanup(operation.commandId);this.operations.add(operation);
  operation.cancelTask=this.editor.ownedCancelExport(operation.commandId,{session:operation.owner.session,identity:operation.owner.identity}).then(model=>{try{const result=model.value;this.finishCancellation(operation,result.status==='completed'&&result.receipt.status==='rejected'?'failed':result.status,result.receipt.status==='rejected'?result.receipt.code:undefined);}finally{model.release();}}).catch(error=>{
   operation.cancelTask=null;if(operation.durable||operation.cancelOutcome)return;operation.cleanupError=exportDiagnostic(error,'EXPORT_CANCELLATION_UNCONFIRMED');
   if(!operation.durable)operation.phase.end('incomplete',{boundary:'cancel-intent'});
   if(this.active!==operation||!this.current(operation.owner))return;
   this.error='Cancellation is unconfirmed. '+exportDiagnostic(error,'The local writer could not be reached.');this.message='The original export may still complete. Retry cancellation for this same command or inspect its retained receipt before preparing another export.';this.changed();
  }).finally(()=>{operation.pendingCancellation=false;this.trackSettlement(operation);this.changed();});return operation.cancelTask;
 }
 private callbackOwner(){const record=this.memory.record('action');let done!:()=>void;const task=new Promise<void>(resolve=>done=resolve);this.callbacks.add(task);let live=true;return ()=>{if(live){live=false;record.release();this.callbacks.delete(task);done();this.signalCleanup();}};}
 private fieldHandler(key:keyof ExportForm,ownerId:number,generation:number){return (event:Event)=>{
  if(!this.resolveOwner(ownerId)||generation!==this.fieldGeneration)return;const host=event.currentTarget as HTMLElement&{value:string;checked:boolean};let finish:()=>void;try{finish=this.callbackOwner();}catch(error){const form=this.form;if(form){if(key==='includeHidden')this.controls.write(host,'checked',form.includeHidden);else this.controls.write(host,'value',form[key]);}this.error=exportDiagnostic(error);this.changed();return;}
  try{this.controls.settled(event,()=>key==='includeHidden'?host.checked:host.value,value=>{const owner=this.resolveOwner(ownerId),form=this.form;if(!owner||!form||this.busy||generation!==this.fieldGeneration)return;
   let next:OwnedModel<ExportForm>|undefined;try{const bytes=modelPayloadBytes(form)-modelPayloadBytes(form[key])+modelPayloadBytes(value);next=this.memory.create('form',bytes,()=>({...form,[key]:value}),EXPORT_MEMORY_LIMITS.formBytes);this.clearPreview();const prior=this.formOwner;this.formOwner=next;this.form=next.value;next=undefined;if(prior)this.memory.retire(prior);this.error='';this.message='Settings changed. Prepare a fresh preview before confirming export.';this.changed();}
   catch(error){next?.release();if(key==='includeHidden')this.controls.write(host,'checked',form.includeHidden);else this.controls.write(host,'value',form[key]);this.error=exportDiagnostic(error);this.changed();}
  });}finally{queueMicrotask(finish);}
 };}
 private actionHandler(kind:'prepare'|'confirm'|'cancel',ownerId:number,generation:number,target=0){return (event:Event)=>{
  if(!this.resolveOwner(ownerId)||generation!==this.generation)return;let finish:()=>void;try{finish=this.callbackOwner();}catch(error){this.error=exportDiagnostic(error);this.changed();return;}const host=event.currentTarget as Node,intentTime=event.timeStamp;
  const timer=setTimeout(()=>{this.timers.delete(timer);const owner=this.resolveOwner(ownerId);
   if(event.defaultPrevented||!host?.isConnected||!owner||generation!==this.generation){finish();return;}
   let task:Promise<void>|void=undefined;try{if(kind==='cancel'){const active=this.active;if(active?.id===target&&!active.cancelTask)this.cancel();}else if(!this.busy&&!this.composing&&!this.editor.view.busy){if(kind==='prepare')task=this.prepare(owner,intentTime);else{const prepared=this.prepared;if(prepared?.id===target)this.confirm(prepared,owner);}}}
   catch(error){this.error=exportDiagnostic(error);this.changed();finish();return;}
   void Promise.resolve(task).catch(error=>{if(this.resolveOwner(ownerId)){this.error=exportDiagnostic(error);this.changed();}}).finally(finish);
  },0);this.timers.set(timer,finish);
 };}
 // Native IME insertion can commit before the next render. Revoke prior actions
 // and previews while keeping that same field's accepted-change callback live.
 private compositionHandler(start:boolean,ownerId:number){return ()=>{if(!this.resolveOwner(ownerId))return;this.composing=start;if(start)this.clearPreview(true);this.changed();};}
 private async prepare(owner:Owner,intentTime=performance.now()){
  let document:Document|null|undefined=this.editor.view.document;if(!document||!this.form||!this.current(owner))return;
  let record:ExportRecord|undefined,reviewRecord:ExportRecord|undefined,documentModel:OwnedModel<Document>|undefined,optionsModel:OwnedModel<DocumentExportOptions>|undefined,assetModel:OwnedModel<Asset>|undefined,responseModel:OwnedModel<Asset>|undefined;let token:ExportOperation|undefined;
  try{
   record=this.memory.record('operation');documentModel=this.memory.clone('document',document);document=undefined;const frozen=documentModel.value,inputBytes=modelPayloadBytes(this.form)+modelPayloadBytes(this.editor.view.selected);
   if(this.editor.view.selected.length>100||inputBytes>EXPORT_MEMORY_LIMITS.modelBytes/4)throw Error('EXPORT_OPTIONS_LIMIT');
   const scratch=reserveModelBytes('export-options-scratch',inputBytes*4+8192);try{optionsModel=this.memory.create('options',inputBytes+8192,()=>exportOptions(this.form!,frozen,this.editor.view.image,this.editor.view.selected));}finally{scratch.release();}
   const options=optionsModel.value;this.generation++;this.fieldGeneration++;this.controls.invalidate();const phase=browserPhases.recorder.start('document.export',{documentId:frozen.id,revision:frozen.revision,boundary:'intent'},intentTime);
   token={id:++this.serial,record,owner,commandId:null,cancelRequested:false,cancelTask:null,cancelOutcome:null,durable:false,phase,preparing:true,pendingCancellation:false,cleanupError:null};record=undefined;const operation=token,generation=this.generation;this.operations.add(operation);this.active=operation;this.busy=true;this.error='';this.message='Compositing and encoding the chosen revision. Preparing durable local export bytes…';this.changed();
   const current=()=>this.current(owner)&&this.active===operation&&this.generation===generation;
   // Keep the returned asset admitted until our independent review clone owns it.
   responseModel=await this.editor.ownedPrepareExport(options,frozen,commandId=>{operation.commandId=commandId;if(operation.cancelRequested)void this.requestCancellation(operation);});let received:Asset|undefined=responseModel.value;if(operation.cancelOutcome==='canceled'||operation.cancelOutcome==='failed')return;
   const mediaType=options.format==='jpeg'?'image/jpeg':'image/png',width=options.resize?.width??frozen.width,height=options.resize?.height??frozen.height;
   if(received.blob.mediaType!==mediaType||received.raster?.role!=='export'||received.raster.width!==width||received.raster.height!==height)throw Error('Prepared export identity does not match the chosen settings.');
   phase.end('ok',{boundary:'authority-durable',outputAssetId:received.id,assetHash:received.blob.hash});operation.durable=true;
   if(operation.cancelRequested){this.finishCancellation(operation,'completed');return;}if(!current())return;
   reviewRecord=this.memory.record('owner');assetModel=this.memory.clone('asset',received);received=undefined;responseModel.release();responseModel=undefined;const asset=assetModel.value;
   const abort=new AbortController();this.abort=abort;this.message='Local bytes are ready. Loading a bounded preview of the actual encoded file before confirmation…';this.changed();
   const url=await withAssetDisplaySource(asset,'encoded',source=>createDisplayPreviewURL(owner.session.transport.bind(owner.session),source,{owner:'export-preview',edge:1024,signal:abort.signal,owns:current}));
   if(!current()){revokeDisplayPreviewURL(url);return;}
   try{this.clearPrepared();}catch(error){revokeDisplayPreviewURL(url);throw error;}
   this.prepared={id:++this.serial,record:reviewRecord,payloads:[documentModel,optionsModel,assetModel],document:frozen,options,asset,url,loaded:false,confirmed:false,width,height};documentModel=undefined;optionsModel=undefined;assetModel=undefined;reviewRecord=undefined;this.abort=null;this.message='Inspect the scaled preview of the actual encoded export, original size and matte. Confirmation exports the retained original bytes.';
  }catch(error){if(token&&!token.durable&&(!token.cancelRequested||!token.commandId))token.phase.end('error');if((!token||!(token.cancelRequested&&token.commandId))&&(!token||this.active===token)&&this.current(owner)){this.abort?.abort();this.abort=null;this.error=exportDiagnostic(error);this.message='Export could not be prepared. Previous complete preview and prepared files remain available.';this.busy=false;this.active=null;this.changed();}}
  finally{responseModel?.release();documentModel?.release();optionsModel?.release();assetModel?.release();record?.release();reviewRecord?.release();if(token){if(this.active===token&&this.current(owner)&&!token.cancelRequested){this.busy=false;this.active=null;this.abort=null;this.changed();}token.preparing=false;if(token.durable||token.cancelOutcome)token.cleanupError=null;this.trackSettlement(token);}}
 }
 private loadHandler(id:number){return (event:Event)=>{const prepared=this.prepared,image=event.currentTarget as HTMLImageElement;if(prepared?.id!==id||!this.owner||!this.current(this.owner)||image.src!==prepared.url)return;try{validateDisplayImage(image,prepared.url);prepared.loaded=true;}catch{this.error='Decoded preview dimensions differ from the declared display rendition.';prepared.loaded=false;}this.changed();};}
 private imageErrorHandler(id:number){return ()=>{const prepared=this.prepared;if(prepared?.id===id&&this.owner&&this.current(this.owner)){prepared.loaded=false;this.error='Encoded export could not be displayed. Confirmation is blocked.';this.changed();}};}
 private confirm(prepared:Prepared,owner:Owner){if(!this.current(owner)||this.prepared!==prepared||!prepared.loaded||prepared.confirmed||this.composing)return;this.editor.confirmExport(prepared.asset,prepared.document);prepared.confirmed=true;this.message='Export ready. Choose a destination for the prepared file. A download request alone does not confirm a destination write.';this.changed();this.onConfirmed();}
 render(){
  const form=this.form,owner=this.owner,prepared=this.prepared,active=this.active;if(!form||!owner)return html`<p>Open a document before preparing an export.</p>`;
  const text=(key:Exclude<keyof ExportForm,'includeHidden'>)=>this.fieldHandler(key,owner.id,this.fieldGeneration),disabled=this.busy||this.editor.view.busy||!this.current(owner);
  return html`<section class="export-controls" aria-label="Export settings and preview" aria-busy=${String(this.busy)} @compositionstart=${this.compositionHandler(true,owner.id)} @compositionend=${this.compositionHandler(false,owner.id)}>
   <p role="status">${this.message}</p>${this.error?html`<p role="alert">${this.error}</p>`:nothing}
   <en-select id="export-scope" label="Export scope" .value=${form.scope} ?disabled=${disabled} @en-change=${text('scope')}><en-select-option value="visible-document">Whole visible document</en-select-option><en-select-option value="selected-layers">Explicit selected-layer composite</en-select-option></en-select>
   ${form.scope==='selected-layers'?html`<p>${this.editor.view.selected.length} selected layers; original document bounds and layer order are retained.</p><en-switch id="export-include-hidden" label="Include hidden selected layers" .checked=${form.includeHidden} ?disabled=${disabled} @en-change=${this.fieldHandler('includeHidden',owner.id,this.fieldGeneration)}></en-switch>`:nothing}
   <en-select id="export-format" label="Export format" .value=${form.format} ?disabled=${disabled} @en-change=${text('format')}><en-select-option value="png">PNG with alpha</en-select-option><en-select-option value="jpeg">JPEG with opaque matte</en-select-option></en-select>
   <en-select id="export-dimensions" label="Export dimensions" .value=${form.dimensions} ?disabled=${disabled} @en-change=${text('dimensions')}><en-select-option value="native">Native document dimensions</en-select-option><en-select-option value="resize">Deliberate export resize</en-select-option></en-select>
   ${form.dimensions==='resize'?html`<div class="property-grid"><en-number-field id="export-width" label="Export width (px)" .value=${form.width} .min=${1} .max=${8192} .step=${1} ?disabled=${disabled} @en-change=${text('width')}></en-number-field><en-number-field id="export-height" label="Export height (px)" .value=${form.height} .min=${1} .max=${8192} .step=${1} ?disabled=${disabled} @en-change=${text('height')}></en-number-field></div><p>Resize changes only this export. Review the actual result before approval.</p>`:nothing}
   ${form.format==='jpeg'?html`<en-text-field id="export-matte" label="Opaque sRGB matte (#RRGGBB)" .value=${form.matte} ?disabled=${disabled} @en-change=${text('matte')}></en-text-field><en-number-field id="export-quality" label="JPEG quality (0.01–1)" .value=${form.quality} .min=${0.01} .max=${1} .step=${0.01} ?disabled=${disabled} @en-change=${text('quality')}></en-number-field><p>JPEG removes alpha over this explicit matte and is lossy. Quality defaults to 0.9. The preview uses the actual encoded JPEG.</p>`:html`<p>PNG retains alpha. Native-size whole-document export uses the accepted canonical pixels.</p>`}
   <p>Provider output format is a separate request setting. Export changes no layers, checkpoint or request and performs no provider work.</p>
   <en-button id="prepare-export" ?disabled=${disabled||this.composing} @click=${this.actionHandler('prepare',owner.id,this.generation)}>Prepare export preview</en-button>
   ${this.busy?html`<en-button id="cancel-export-preparation" ?disabled=${!!active?.cancelTask&&!active.cancelOutcome} @click=${this.actionHandler('cancel',owner.id,this.generation,active?.id??0)}>${active?.cancelRequested?'Retry cancellation status':'Cancel export preparation'}</en-button>`:nothing}
   ${prepared?html`<en-card id="export-review"><h2>Review frozen export</h2><p>Revision ${prepared.document.revision} · ${prepared.width} × ${prepared.height} · ${prepared.options.format.toUpperCase()} · ${prepared.asset.blob.byteLength} bytes</p><p>${prepared.options.scope.kind==='visible-document'?'Whole visible document':prepared.options.scope.layerIds.length+' explicitly selected layers'+(prepared.options.scope.includeHidden?' including hidden layers':' excluding hidden layers')}. ${prepared.options.resize?'Deliberately resized export.':'Native dimensions.'} ${prepared.options.format==='jpeg'?'Opaque matte '+prepared.options.matte+'; quality '+prepared.options.quality+'.':'Alpha retained.'}</p>${this.editor.view.document?.revision!==prepared.document.revision?html`<p>The document has changed since this export was frozen. This preview still contains revision ${prepared.document.revision}.</p>`:nothing}<img id="export-preview" class="review-image" src=${displayImage(prepared.url)} alt="Scaled preview of the actual encoded export for the frozen revision" @load=${this.loadHandler(prepared.id)} @error=${this.imageErrorHandler(prepared.id)}><p>The transparency checkerboard is a display aid; it is excluded from the file. Scaled preview ${displayPreviewInfo(prepared.url)?.width} × ${displayPreviewInfo(prepared.url)?.height}; the export retains its original dimensions and encoded bytes.</p><en-button id="confirm-export" ?disabled=${disabled||!prepared.loaded||prepared.confirmed||this.composing} @click=${this.actionHandler('confirm',owner.id,this.generation,prepared.id)}>Confirm reviewed export</en-button></en-card>`:nothing}
  </section>`;
 }
}
