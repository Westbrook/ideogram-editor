import {shortcutPath,shortcutFocus,shortcutActivation,shortcutModalConflict} from './keyboard-scope.js';
import {validateAssetProjection} from '../protocol/asset-projection.js';
import {ViewModelReads} from '../state/view-models.js';
import {FRIENDLY_TRANSFORM_HELP} from './inspector-transform.js';
import {RenderModelOwners,type RenderModel} from './render-models.js';
import {newInspector,ownInspector,restoredInspector,serializedInspector,changedInspector,inspectorTransform,sizedInspector,friendlyInspectorAvailable,type InspectorSnapshot,type InspectorValues} from './inspector-model.js';
import {cloneOwnedModel,createOwnedModel,reserveModelBytes,modelPayloadBytes,type OwnedModel} from '../observability/model-memory.js';
import {displayImage} from './display-image.js';
import {NewDocumentControls,documentDisplayName} from './new-document.js';
import {CommandSearch,type ShellCommand} from './command-search.js';
import {isAppearance, setAppearance} from '../theme/appearance.js';
import {currentDensity, isDensity, setDensity} from '../theme/density.js';
import {singleKeyShortcutsEnabled, setSingleKeyShortcutsEnabled, isKeyboardPreferenceStorageKey} from '../state/keyboard-preferences.js';
import {DocumentDeletion} from './deletion.js';
import type {StorageLibrary} from './storage-library.js';
import {RequestEditing} from './request.js';
import type {ReviewedCanvasPreview} from './request-edits.js';
import {ProviderControls} from './provider.js';
import type {ExportControls} from './export.js';
import {ImageImportControls} from './image-import.js';
import {allocationLedger} from '../observability/allocations.js';
import { CompositionEditing } from './composition.js';
import { NativeTextEditing } from './native-text.js';
import type {TextSource} from '../protocol/text.js';
import { Authoring } from './authoring.js';
import { iconDefinition } from '@en-reve/elements/definitions/icon.js';
import { linkDefinition } from '@en-reve/elements/definitions/link.js';
import { colorFieldDefinition } from '@en-reve/elements/definitions/color-field.js';
import { segmentedControlDefinition } from '@en-reve/elements/definitions/segmented-control.js';
import { accordionItemDefinition } from '@en-reve/elements/definitions/accordion-item.js';
import { accordionDefinition } from '@en-reve/elements/definitions/accordion.js';
import { alertDefinition } from '@en-reve/elements/definitions/alert.js';
import { badgeDefinition } from '@en-reve/elements/definitions/badge.js';
import { cardDefinition } from '@en-reve/elements/definitions/card.js';
import { stackDefinition } from '@en-reve/elements/definitions/stack.js';
import { LitElement, html, nothing, render as renderInto } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { createElementScope } from '@en-reve/elements/element-scope.js';
import { buttonDefinition } from '@en-reve/elements/definitions/button.js';
import { textareaDefinition } from '@en-reve/elements/definitions/textarea.js';
import { textFieldDefinition } from '@en-reve/elements/definitions/text-field.js';
import { numberFieldDefinition } from '@en-reve/elements/definitions/number-field.js';
import { selectDefinition } from '@en-reve/elements/definitions/select.js';
import { selectOptionDefinition } from '@en-reve/elements/definitions/select-option.js';
import { splitterDefinition } from '@en-reve/elements/definitions/splitter.js';
import { toolbarDefinition } from '@en-reve/elements/definitions/toolbar.js';
import { tabsDefinition } from '@en-reve/elements/definitions/tabs.js';
import { tabDefinition } from '@en-reve/elements/definitions/tab.js';
import { tabPanelDefinition } from '@en-reve/elements/definitions/tab-panel.js';
import { fileUploadDefinition } from '@en-reve/elements/definitions/file-upload.js';
import { treeDefinition } from '@en-reve/elements/definitions/tree.js';
import { activityFeedDefinition } from '@en-reve/elements/definitions/activity-feed.js';
import { switchDefinition } from '@en-reve/elements/definitions/switch.js';
import { sliderDefinition } from '@en-reve/elements/definitions/slider.js';
import { validationSummaryDefinition } from '@en-reve/elements/definitions/validation-summary.js';
import { popoverDefinition } from '@en-reve/elements/definitions/popover.js';
import { SignalController } from '@en-reve/primitives/interactions/signal-controller.js';
import type { EnTextarea } from '@en-reve/elements/textarea.js';
import type { EnFileUpload } from '@en-reve/elements/file-upload.js';
import type { EnTree } from '@en-reve/elements/tree.js';
import type { EnSelect } from '@en-reve/elements/select.js';
import type { EnNumberField } from '@en-reve/elements/number-field.js';
import type { EnSwitch } from '@en-reve/elements/switch.js';
import type { EnSlider } from '@en-reve/elements/slider.js';
import type { EnSplitter } from '@en-reve/elements/splitter.js';
import type { EnDialog } from '@en-reve/elements/dialog.js';
import type { DraftInputEvent } from '@en-reve/elements/events.js';
import type { ActivityRecord } from '@en-reve/elements/activity-feed.js';
import type { ImageLayer, ImageHistoryNode } from '../protocol/history.js';
import type { Command, Document } from '../protocol/store.js';
import { createSessionClient } from '../state/session-client.js';
import { EditorClient } from '../state/editor-client.js';
import { chooseDestination, writeDestination, destinationResources, settleDestinationDownloads } from '../state/destination.js';
import { ControlAdapter } from './adapters.js';
import { CanvasView } from './canvas-view.js';
import {createDisplayPreviewURL,withDisplaySource,displayPreviewInfo,validateDisplayImage,revokeDisplayPreviewURL,cancelDisplayPreviewReads,waitForDisplayPreviewReads,displayPreviewOwnership} from '../observability/display-preview.js';
import { icon } from './icons.js';
import { SHA256 } from '../protocol/sha256.js';
import {renderShellWordmark} from './shell-wordmark.js';

const scope=createElementScope({document,registry:'auto'});
scope.register([iconDefinition,linkDefinition,colorFieldDefinition,segmentedControlDefinition,accordionItemDefinition,accordionDefinition,alertDefinition,badgeDefinition,cardDefinition,stackDefinition,buttonDefinition,textareaDefinition,textFieldDefinition,numberFieldDefinition,selectDefinition,selectOptionDefinition,splitterDefinition,toolbarDefinition,tabsDefinition,tabDefinition,tabPanelDefinition,fileUploadDefinition,treeDefinition,activityFeedDefinition,switchDefinition,sliderDefinition,validationSummaryDefinition,popoverDefinition]);
const requestOperationChoices=[
 {id:'generate',legacyId:'0',label:'Generate image'},
 {id:'instant',legacyId:'1',label:'Generate with Instant'},
 {id:'fast',legacyId:'2',label:'Generate with Fast'},
 {id:'transform',legacyId:'3',label:'Transform image'},
 {id:'inpaint',legacyId:'4',label:'Edit masked region'},
 {id:'generate-adapters',legacyId:'5',label:'Generate with adapters'},
 {id:'transform-adapters',legacyId:'6',label:'Transform with adapters'},
 {id:'inpaint-adapters',legacyId:'7',label:'Edit with adapters'},
 {id:'generate-v45',legacyId:null,label:'Generate with Ideogram v4.5'},
 {id:'transform-v45',legacyId:null,label:'Transform with Ideogram v4.5'},
 {id:'inpaint-v45',legacyId:null,label:'Edit masked region with Ideogram v4.5'},
] as const;
const operations=requestOperationChoices.map(choice=>choice.label);
const legacyOperation=(label:string)=>requestOperationChoices.some(choice=>choice.label===label&&choice.legacyId!==null);
const connection=createSessionClient();
const editor=new EditorClient(connection);
let wordmark=renderShellWordmark;
const developmentShells=import.meta.hot?new Set<EditorShell>():null;
// The editor/session singletons outlive individual shell elements. A new mount
// cannot resume while any prior shell still owns asynchronous retirement.
let shellConnectionGeneration=0;
let shellAttached=false;
type ShellRetirement={promise:Promise<void>;retry():Promise<void>};
let shellRetirement:ShellRetirement|undefined;
// Native module loading is shared without retaining a detached shell owner.
let exportModuleLoading:Promise<typeof import('./export.js')>|undefined;
const statusName={checking:'Connecting',paired:'Connected locally',unpaired:'Pairing needed',offline:'Server offline',error:'Connection error'};
type Fields=InspectorValues;
type RasterizeReview={document:InspectorSnapshot['document'];layer:InspectorSnapshot['layer'];render:string;session:string};
const RASTERIZE_REVIEW_BYTES=64*1024;
class EditorShell extends LitElement {
  private readonly read=new SignalController(this,()=>({view:editor.state.value.get(),session:connection.state.value.get()}));
  private adapter=new ControlAdapter();
  private lifecycle?:AbortController;
  private canvas?:CanvasView;
  private canvasElement?:HTMLCanvasElement;
  private canvasMountEpoch=0;
  private connectionGeneration=0;
  private connectionAdmitted=false;
  private connectionRestoring=false;
  private retiredControllers?:{newDocument:NewDocumentControls;search:CommandSearch;semantic:CompositionEditing;text:NativeTextEditing;storage:StorageLibrary|undefined};
  private connectionStart?:{generation:number;promise:Promise<void>;issued:boolean;settled:boolean;pair:(token:string)=>void};
  private resize?:ResizeObserver;
  private connectedOwner:string|null=null;
  private sessionBusy=true;
  private composition=false;
  private singleKeyShortcuts=singleKeyShortcutsEnabled();
  private interactionEpoch=0;
  private operation:string=operations[0];
  private deletionFlow=new DocumentDeletion(this,editor,()=>this.composition);
  private storageFlow?:StorageLibrary;
  private reviewedCanvasPreview:ReviewedCanvasPreview|null=null;
  private requestFlow=new RequestEditing(this,editor,(preview,restoreReviewId)=>this.showReviewedCanvas(preview,restoreReviewId),(trigger,proposal)=>this.textEditing.beginFromReturnedDescription(trigger,proposal),()=>{this.structure='composition';this.inspectorOpen=true;this.requestUpdate();void this.updateComplete.then(()=>this.querySelector<HTMLElement>('#inspector')?.focus());},value=>this.requestOperationChanged(value));
  private requestOperationChanged(value:string){this.operation=value;if(legacyOperation(value))this.semantic.operationChanged(value);this.requestUpdate();}
  private providerFlow=new ProviderControls(this,editor);
  private exportFlow?:ExportControls;
  private exportOpening?:AbortController;
  private exportOpeningCurrent?:()=>boolean;
  private exportLoadFailed=false;
  private imageImport=new ImageImportControls(this,editor);
  private createNewDocumentControls(){return new NewDocumentControls(this,editor,()=>this.closePanel());}
  private newDocumentFlow=this.createNewDocumentControls();
  private createCommandSearch(){return new CommandSearch(this,editor,()=>this.#searchableCommands(),()=>this.panels());}
  private commandSearch=this.createCommandSearch();
  private destinationWrite:{controller:AbortController;committing:boolean;cleanupFailure:unknown;done?:Promise<void>}|null=null;
  private tool='Pan';
  private authoring=new Authoring(editor,()=>this.requestUpdate(),()=>this.draw(),asset=>this.displayPreview(asset),()=>this.updateComplete,(point,out)=>this.zoomAtPoint(point,out));
  private createNativeTextEditing(){return new NativeTextEditing(this,editor,()=>this.draw(),p=>this.canvas?.screenPoint(p,this.zoom,this.pan.x,this.pan.y)??[0,0]);}
  private textEditing=this.createNativeTextEditing();
  private structure='layers';
  private createCompositionEditing(){return new CompositionEditing(this,editor,()=>{this.structure='composition';this.requestUpdate();},()=>this.draw(),()=>this.panels(),id=>{this.structure='layers';editor.select([id]);this.requestUpdate();});}
  private semantic=this.createCompositionEditing();
  private zoom=1;
  private pan={x:0,y:0};
  private gesture:{id:number;x:number;y:number;oldX:number;oldY:number;temporary?:boolean}|null=null;
  private temporaryPan:{session:string;identity:unknown;epoch:number;documentId:string;revision:string}|null=null;
  private panelReady=false;
  private panelLoading?:Promise<void>;
  private panel:'new'|'open'|'import'|'resample'|'flatten'|'bounds'|'copy'|'rasterize'|'export'|'storage'|null=null;
  private recoveryCopyAcknowledgement:string|null=null;
  private copyPanelEpoch=0;
  private rasterizeOwner?:OwnedModel<RasterizeReview>;
  private get rasterizeReview(){return this.rasterizeOwner?.value??null;}
  private setRasterizeReview(next?:OwnedModel<RasterizeReview>){const prior=this.rasterizeOwner;this.rasterizeOwner=next;prior?.release();}
  private inspectorKey='';
  private restoredUI='';
  private previewLoaded=false;
  private readonly renderModelOwners=new RenderModelOwners();
  private inspectorTasks=new Set<Promise<unknown>>();
  private inspectorDrain?:Promise<void>;
  private inspectorSizeReads=new ViewModelReads();
  private inspectorSizeAbort?:AbortController;
  private trackInspector<T>(work:()=>Promise<T>){if(this.inspectorDrain)return Promise.reject(new DOMException('Inspector actions are closing.','AbortError'));if(this.inspectorTasks.size>=8)return Promise.reject(Error('Wait for the current inspector action, then retry.'));const lease=allocationLedger.reserve({owner:'editor-inspector-action',kind:'control',handles:1});const task=Promise.resolve().then(work).finally(()=>{this.inspectorTasks.delete(task);lease.release();});this.inspectorTasks.add(task);return task;}
  private drainInspector(){if(this.inspectorDrain)return this.inspectorDrain;this.inspectorSizeAbort?.abort();const dimensions=this.inspectorSizeReads.release();this.inspectorDrain=(async()=>{const results=await Promise.allSettled([dimensions,...this.inspectorTasks]),failures=results.filter((r):r is PromiseRejectedResult=>r.status==='rejected');if(failures.length)throw new AggregateError(failures.map(r=>r.reason),'INSPECTOR_ACTION_DRAIN_FAILED');})().finally(()=>{this.inspectorDrain=undefined;});return this.inspectorDrain;}
  private fieldsOwner?:OwnedModel<InspectorSnapshot>;
  private inspectorFieldsGeneration=0;
  private get fields(){return this.fieldsOwner?.value;}
  private setFields(next?:OwnedModel<InspectorSnapshot>,metadataOnly=false){if(!metadataOnly)this.inspectorFieldsGeneration=(this.inspectorFieldsGeneration??0)+1;const prior=this.fieldsOwner,p=prior?.value,n=next?.value;if(p&&(!n||p.document.id!==n.document.id||p.document.revision!==n.document.revision||p.layer.id!==n.layer.id||p.layer.version!==n.layer.version||p.layer.assetId!==n.layer.assetId))this.inspectorSizeAbort?.abort();this.fieldsOwner=next;prior?.release();}
  private editInspector(key:keyof Fields,value:string|boolean,composing=false){const fields=this.fields;if(!fields||!Object.hasOwn(fields.values,key))return;if(editor.view.document?.id!==fields.document.id||editor.view.selected[0]!==fields.layer.id||this.inspectorKey!==fields.document.id+':'+fields.layer.id)throw Error('DOCUMENT_CHANGED');if(typeof value!==typeof fields.values[key])throw Error('INSPECTOR_FIELD_TYPE');const next=changedInspector(fields,key,value);let installed=false;try{this.persistInspector(next.value,composing);this.setFields(next);installed=true;this.requestUpdate();}catch(error){if(!installed)next.release();throw error;}}
  private previewURL='';
  private previewAsset='';
  private previewRead?:AbortController;
  private unregisterResources?:()=>void;
  private renderGeneration=0;
  private repaintKey='';
  private narrow=matchMedia('(max-width:1100px)').matches;
  private extreme=matchMedia('(max-width:720px)').matches;
  private requestNode=document.createElement('section');
  private inspectorNode=document.createElement('aside');
  private get drawerMode(){return this.narrow&&!this.extreme&&this.panelReady;}
  private requestOpen=false;
  private inspectorOpen=false;
  constructor(){if(shellAttached)throw Error('SHELL_ALREADY_CONNECTED');super();this.renderOptions.creationScope=scope.creationScope;}
  protected createRenderRoot(){return this;}
  connectedCallback(){
    if(shellAttached){this.connectionRestoring=true;throw Error('SHELL_ALREADY_CONNECTED');}
    shellAttached=true;this.connectionAdmitted=true;
    // The same client may outlive an unmounted shell. Admit its new metadata
    // root before Lit reconnects and can publish the first replacement render.
    const canvasEpoch=++this.canvasMountEpoch;
    try{editor.mountViewMetadata();super.connectedCallback();}catch(error){shellAttached=false;this.connectionAdmitted=false;throw error;}this.lifecycle=new AbortController();const signal=this.lifecycle.signal;
    const connectionGeneration=this.connectionGeneration=++shellConnectionGeneration;this.connectionStart=undefined;this.connectedOwner=null;this.sessionBusy=true;this.connectionRestoring=!!shellRetirement;
    this.addEventListener('ie-display-error',event=>editor.fail(Error((event as CustomEvent<{message:string}>).detail.message)),{signal});
    developmentShells?.add(this);
    window.addEventListener('ie-pairing',()=>{let token=window.__IE_PAIRING__;delete window.__IE_PAIRING__;void this.startConnection(token,true).catch(()=>{});token=undefined;},{signal});
    this.addEventListener('keydown',this.shortcut,{signal});
    window.addEventListener('keyup',event=>{if(event.key===' '||event.code==='Space')this.endTemporaryPan();},{signal});
    this.ownerDocument.addEventListener('visibilitychange',()=>{if(this.ownerDocument.visibilityState!=='visible')this.endTemporaryPan();},{signal});
    window.addEventListener('blur',()=>this.endTemporaryPan(),{signal});
    this.ownerDocument.addEventListener('focusin',event=>{if(this.temporaryPan&&(!event.composedPath().includes(this.querySelector('#canvas')!)||this.editable(event)||shortcutActivation(event.composedPath().filter((node):node is HTMLElement=>node instanceof HTMLElement))))this.endTemporaryPan();},{signal});
    for(const type of ['pointerdown','keydown','focusin'])this.addEventListener(type,()=>{this.interactionEpoch++;},{signal,capture:true});
    window.addEventListener('storage',event=>{if(isKeyboardPreferenceStorageKey(event.key)){this.singleKeyShortcuts=singleKeyShortcutsEnabled();this.requestUpdate();}},{signal});
    this.addEventListener('compositionstart',()=>{this.endTemporaryPan();this.composition=true;this.requestUpdate();},{signal});
    this.addEventListener('compositionend',()=>{this.composition=false;setTimeout(()=>void this.updateLayout(),0);this.requestUpdate();void editor.flushDrafts().catch(e=>editor.fail(e));},{signal});
    for(const query of ['(max-width:1100px)','(max-width:720px)'])matchMedia(query).addEventListener('change',()=>void this.updateLayout(),{signal});
    if(this.narrow&&!this.extreme)void this.updateLayout();
    if(this.canvas&&!this.connectionRestoring)void this.remountCanvas(canvasEpoch).catch(error=>editor.fail(error));
    // An explicit mount claims its initial pairing token synchronously after
    // append. Only an otherwise unclaimed reattachment resumes from the cookie.
    if(shellRetirement)queueMicrotask(()=>{if(this.isConnected&&connectionGeneration===this.connectionGeneration&&connectionGeneration===shellConnectionGeneration&&this.connectionStart?.generation!==connectionGeneration)void this.startConnection().catch(()=>{});});
  }
  assertConnectionAdmission(){if(!this.connectionAdmitted)throw Error('SHELL_CONNECTION_NOT_ADMITTED');}
  async startConnection(token?:string,explicit=false){
    const generation=this.connectionGeneration,signal=this.lifecycle?.signal;
    const current=()=>this.connectionAdmitted&&this.isConnected&&!signal?.aborted&&generation===this.connectionGeneration&&generation===shellConnectionGeneration;
    if(!current()){token=undefined;return;}
    const prior=this.connectionStart;
    if(prior?.generation===generation&&(!explicit||!prior.settled)){
      // One queued start per mount. A fresh explicit pairing may replace its
      // unissued token; repeated checks join without discarding that token.
      if(explicit&&!prior.issued&&token!==undefined)prior.pair(token);
      token=undefined;return prior.promise;
    }
    const forget=()=>{token=undefined;};signal?.addEventListener('abort',forget,{once:true});
    const retirement=shellRetirement,canvasEpoch=this.canvasMountEpoch;let claim!:NonNullable<EditorShell['connectionStart']>;
    const promise=(async()=>{try{
      await Promise.resolve();if(!current())return;
      await (explicit?retirement?.retry():retirement?.promise);if(!current())return;
      editor.mountViewMetadata();this.restoreRetiredControllers();this.requestUpdate();await this.updateComplete;if(!current())return;
      this.connectionRestoring=false;if(this.canvas)await this.remountCanvas(canvasEpoch);else this.ensureCanvasForConnectedRender();if(!current())return;
      claim.issued=true;const pending=connection.start(token);token=undefined;await pending;
    }catch(error){if(current())editor.fail(error);throw error;}finally{token=undefined;claim.settled=true;signal?.removeEventListener('abort',forget);}})();
    claim={generation,promise,issued:false,settled:false,pair:value=>{token=value;}};this.connectionStart=claim;return promise;
  }
  private sessionAction(action:'renew'|'revoke'){if(!this.connectionAdmitted||!this.isConnected||this.connectionRestoring||this.connectionGeneration!==shellConnectionGeneration)return;if(action==='renew')return connection.renew();if(action==='revoke')return connection.revoke();throw new Error('Unsupported session action');}
  private restoreRetiredControllers(){
    const prior=this.retiredControllers;if(!prior)return;
    // Store each successfully admitted replacement immediately. A later
    // constructor failure can retry without abandoning that new owned instance.
    if(this.newDocumentFlow===prior.newDocument)this.newDocumentFlow=this.createNewDocumentControls();
    if(this.commandSearch===prior.search)this.commandSearch=this.createCommandSearch();
    if(this.semantic===prior.semantic)this.semantic=this.createCompositionEditing();
    if(this.textEditing===prior.text)this.textEditing=this.createNativeTextEditing();
    if(this.storageFlow===prior.storage)this.storageFlow=undefined;
    this.retiredControllers=undefined;this.panel=null;this.copyPanelEpoch++;this.composition=false;this.gesture=null;this.temporaryPan=null;
  }
  disconnectedCallback(){
    if(!this.connectionAdmitted)return;this.connectionAdmitted=false;this.exportOpening?.abort();
    this.canvasMountEpoch++;this.renderGeneration++;this.connectionGeneration=++shellConnectionGeneration;this.connectionRestoring=true;
    const prior=shellRetirement;
    const {fieldsOwner,rasterizeOwner,canvasElement,adapter,lifecycle,resize,unregisterResources,previewRead,newDocumentFlow,commandSearch,canvas,authoring,semantic,requestFlow,providerFlow,exportFlow,imageImport,deletionFlow,storageFlow,textEditing,destinationWrite,previewURL}=this;
    this.retiredControllers={newDocument:newDocumentFlow,search:commandSearch,semantic,text:textEditing,storage:storageFlow};
    // Capture the exact owners now. Successful callbacks are discarded; only
    // failed owners remain eligible for an explicit, independently joined retry.
    type Release={work:()=>unknown;task:Promise<unknown>};let releases:Release[]=[];
    let pending:Promise<void>|undefined,initialized=false,retireSession=true,resolveInitial!:()=>void,rejectInitial!:(error:unknown)=>void;
    const initial=new Promise<void>((resolve,reject)=>{resolveInitial=resolve;rejectInitial=reject;});
    const retirement:ShellRetirement={promise:initial,retry:()=>initialized?drain(true):initial};
    shellRetirement=retirement;shellAttached=false;void initial.catch(()=>{});
    const attempt=(work:()=>unknown)=>{try{return Promise.resolve(work());}catch(error){return Promise.reject(error);}};
    const cleanup=(work:()=>unknown)=>releases.push({work,task:attempt(work)});
    if(prior)releases.push({work:()=>prior.retry(),task:prior.promise});
    const panGesture=this.temporaryPan&&this.gesture?.temporary?this.gesture:null;this.temporaryPan=null;
    if(panGesture){this.pan={x:panGesture.oldX,y:panGesture.oldY};if(this.gesture===panGesture)this.gesture=null;}
    cleanup(()=>{if(panGesture&&canvasElement?.hasPointerCapture(panGesture.id))canvasElement.releasePointerCapture(panGesture.id);});
    cleanup(()=>super.disconnectedCallback());developmentShells?.delete(this);
    cleanup(()=>this.clearRenderedModels());cleanup(()=>{fieldsOwner?.release();if(this.fieldsOwner===fieldsOwner){this.fieldsOwner=undefined;this.inspectorFieldsGeneration++;}});cleanup(()=>{rasterizeOwner?.release();if(this.rasterizeOwner===rasterizeOwner)this.rasterizeOwner=undefined;});
    cleanup(()=>adapter.invalidate());cleanup(()=>lifecycle?.abort());cleanup(()=>resize?.disconnect());cleanup(()=>{unregisterResources?.();if(this.unregisterResources===unregisterResources)this.unregisterResources=undefined;});cleanup(()=>previewRead?.abort());cleanup(()=>cancelDisplayPreviewReads());
    cleanup(()=>newDocumentFlow.dispose());cleanup(()=>commandSearch.dispose());
    cleanup(()=>canvas?.suspend());cleanup(()=>authoring.dispose());cleanup(()=>semantic.dispose());cleanup(()=>requestFlow.releaseDocument());cleanup(()=>providerFlow.dispose());cleanup(()=>exportFlow?.releaseAndWait());cleanup(()=>imageImport.releaseDocument());cleanup(()=>deletionFlow.dispose());cleanup(()=>storageFlow?.dispose());
    cleanup(()=>{if(destinationWrite&&!destinationWrite.committing)destinationWrite.controller.abort();});cleanup(async()=>{await destinationWrite?.done;if(destinationWrite?.cleanupFailure)throw destinationWrite.cleanupFailure;await settleDestinationDownloads();const downloads=destinationResources();if(downloads.copyingFallbacks||downloads.spoolDatabases)throw Error('DESTINATION_RELEASE_INCOMPLETE');});cleanup(()=>textEditing.dispose());cleanup(()=>{if(previewURL)revokeDisplayPreviewURL(previewURL);if(this.previewURL===previewURL)this.previewURL='';});cleanup(()=>waitForDisplayPreviewReads());cleanup(()=>this.drainInspector());cleanup(()=>editor.dispose());
    const drain=(retry:boolean):Promise<void>=>{
      if(pending)return pending;const current=releases;
      // Publish this retry before invoking owner callbacks that can synchronously
      // notify subscribers. Reentrant requests must join the same actual drain.
      pending=Promise.resolve().then(async()=>{
        if(retry)for(const release of current)release.task=attempt(release.work);
        const results=await Promise.allSettled(current.map(release=>release.task));
        releases=current.filter((_release,index)=>results[index].status==='rejected');const failures=results.filter((result):result is PromiseRejectedResult=>result.status==='rejected').map(result=>result.reason);
        if(failures.length)throw new AggregateError(failures,'SHELL_RETIREMENT_INCOMPLETE');
        // Recovery/control cleanup may still require this exact session's CSRF.
        // Retire that authority only after its dependent owners have drained.
        if(retireSession){try{await connection.dispose();retireSession=false;}catch(error){throw new AggregateError([error],'SHELL_RETIREMENT_INCOMPLETE');}}
      }).catch(error=>{try{editor.fail(error);}catch(publication){throw new AggregateError([error,publication],'SHELL_RETIREMENT_REPORT_FAILED');}throw error;}).finally(()=>{pending=undefined;});
      retirement.promise=pending;void pending.catch(()=>{});return pending;
    };
    initialized=true;void drain(false).then(resolveInitial,rejectInitial);
  }
  protected firstUpdated(){this.ensureCanvasForConnectedRender();}
  private ensureCanvasForConnectedRender(){
    if(!this.isConnected||this.connectionRestoring||this.canvas)return;const canvas=this.querySelector<HTMLCanvasElement>('canvas');if(!canvas)return;
    this.createCanvasView(canvas);editor.setViewportProbe(()=>this.canvas?.decodedAssetId??null);this.mountCanvasResources();
  }
  private createCanvasView(canvas:HTMLCanvasElement){
    const owner=new CanvasView(canvas,connection.transport,{changed:()=>{if(this.canvas?.ownership.contextLost){editor.navigationViewportUnavailable();this.endTemporaryPan();this.gesture=null;this.authoring.cancelGesture();this.semantic.cancelDrag();}else if(!this.canvas?.ownership.contextRestoring){try{this.draw();}catch(error){editor.fail(error);}}this.requestUpdate();},restored:async()=>{if(editor.documentResources.snapshot.releasing)return;const review=this.reviewedCanvasPreview;if(review)await this.showReviewedCanvas(review);else await this.paint();},failed:error=>editor.fail(error)});this.canvasElement=canvas;this.canvas=owner;
  }
  private async remountCanvas(epoch:number){
    await this.updateComplete;const prior=this.canvas,element=this.querySelector<HTMLCanvasElement>('canvas');
    if(!prior||!element||!this.isConnected||epoch!==this.canvasMountEpoch)return;
    editor.navigationViewportUnavailable();await prior.suspend();
    const current=()=>this.isConnected&&epoch===this.canvasMountEpoch&&this.canvas===prior&&this.querySelector('canvas')===element;
    if(!current())return;
    if(element===this.canvasElement)await prior.resume();
    else{await prior.retire();if(!current())return;this.createCanvasView(element);}
    if(!this.isConnected||epoch!==this.canvasMountEpoch||this.querySelector('canvas')!==element)return;
    this.mountCanvasResources();this.repaintKey='';await this.paint();
  }
  private mountCanvasResources(){
    const canvas=this.querySelector<HTMLCanvasElement>('canvas');if(!canvas||canvas!==this.canvasElement||!this.canvas||this.canvas.ownership.suspended||!this.isConnected)return;
    this.resize??=new ResizeObserver(()=>this.draw());this.resize.observe(canvas);
    if(this.unregisterResources)return;
    this.unregisterResources=editor.documentResources.register('editor-shell',{release:()=>this.releaseDocument(),inspect:()=>{const exported=this.exportFlow?.inspectMemory(),exportState=this.exportFlow?.inspect();return {
      decodedBitmaps:this.canvas?.lifecycle.decodedBitmaps??0,canvasReads:this.canvas?.lifecycle.pendingReads??0,canvasBytes:this.canvas?.lifecycle.canvasBytes??0,
      reviewObjectURLs:this.previewURL?1:0,displayPreviewReads:displayPreviewOwnership().activeReads,displayPreviewURLs:displayPreviewOwnership().previewURLs,displayImageConsumers:displayPreviewOwnership().imageConsumers,displayPreviewCleanupFailures:displayPreviewOwnership().cleanupFailures,overlayCanvases:this.authoring.lifecycle.overlayCanvases,overlayPatterns:this.authoring.lifecycle.overlayPatterns,inspectorDrafts:this.fields?1:0,inspectorActions:this.inspectorTasks.size,inspectorDimensionReads:this.inspectorSizeReads.ownership.activeReads,inspectorDimensionCleanup:this.inspectorSizeReads.ownership.cleanupFailures,renderModelRoots:this.renderModelOwners.ownership.roots,renderModelPending:this.renderModelOwners.ownership.pending,
      storageModels:this.storageFlow?.lifecycle.models??0,storageReads:this.storageFlow?.lifecycle.reads??0,storageOperations:this.storageFlow?.lifecycle.pending??0,storageCleanupFailures:this.storageFlow?.lifecycle.cleanupFailures??0,
      newDocumentModels:this.newDocumentFlow.lifecycle.models,newDocumentOperations:this.newDocumentFlow.lifecycle.pending,newDocumentRetiring:this.newDocumentFlow.lifecycle.retiring,commandSearchModels:this.commandSearch.lifecycle.models,commandSearchOperations:this.commandSearch.lifecycle.pending,commandSearchRetiring:this.commandSearch.lifecycle.retiring,
      nativeTextActive:this.textEditing.active,nativeTextPending:this.textEditing.lifecycle.pendingOperations,nativePreparations:this.textEditing.lifecycle.activePreparations,nativeTextCharacters:this.textEditing.lifecycle.retainedTextUnits,nativeTextFiles:this.textEditing.lifecycle.retainedFiles,nativePreviewBytes:this.textEditing.lifecycle.previewBytes,nativeWorkers:this.textEditing.lifecycle.rendererWorkers,fontBackingBytes:this.textEditing.lifecycle.fontBackingBytes,maskDrafts:this.authoring.lifecycle.drafts,compositionModels:this.semantic.lifecycle.models,exportPreviewURLs:exportState?.previewURLs??0,exportReads:exportState?.activeReads??0,exportPreparations:exportState?.pendingPreparations??0,exportCancellations:exportState?.pendingCancellations??0,exportCleanupFailures:exportState?.cleanupFailures??0,exportModels:exported?.models??0,exportOperationRecords:exported?.records.operation??0,exportOwnerRecords:exported?.records.owner??0,exportActionRecords:exported?.records.action??0,exportRetiredModels:exported?.retired??0,exportRetirementPending:exported?.pending??0,exportRetirementFailures:exported?.failed??0,exportCallbacks:exported?.callbacks??0,exportTimers:exported?.timers??0,imageImportFiles:this.imageImport.inspect().files,imageImportPreviews:this.imageImport.inspect().previewURLs,imageImportPending:this.imageImport.inspect().pendingOperations,imageImportCleanupFailures:this.imageImport.inspect().cleanupFailures,destinationWrites:this.destinationWrite?1:0,...destinationResources()};}});
  }
  get documentLifecycle(){return editor.documentResources.snapshot;}
  get renderReadiness(){return Object.freeze({schemaVersion:1,clock:'browser-performance',timeOrigin:performance.timeOrigin,observedMs:performance.now(),viewport:this.canvas?.ownership??null,review:this.reviewedCanvasPreview?{...this.reviewedCanvasPreview}:null});}
  private get canvasEditingBlocked(){return this.connectionRestoring||!this.canvas||this.canvas.ownership.suspended||!!this.reviewedCanvasPreview||!!this.canvas?.ownership.contextLost||!!this.canvas?.ownership.contextRestoring;}
  private async releaseDocument(){
    this.exportOpening?.abort();this.endTemporaryPan();
    const failures:unknown[]=[],releases:Promise<unknown>[]=[];
    const release=(work:()=>unknown)=>{try{releases.push(Promise.resolve(work()));}catch(error){failures.push(error);}};
    this.renderGeneration++;this.adapter.invalidate();this.previewRead?.abort();this.previewRead=undefined;cancelDisplayPreviewReads();
    release(()=>{if(this.previewURL)revokeDisplayPreviewURL(this.previewURL);this.previewURL='';});this.previewAsset='';this.previewLoaded=false;
    this.gesture=null;this.reviewedCanvasPreview=null;this.setFields();this.inspectorKey='';this.restoredUI='';this.repaintKey='';this.setRasterizeReview();
    // One failed native release must not prevent independent owners from
    // cancelling and draining their actual work.
    release(()=>this.authoring.releaseDocument());release(()=>this.semantic.releaseDocument());release(()=>this.requestFlow.releaseDocument());release(()=>this.providerFlow.dispose());release(()=>this.deletionFlow.dispose());release(()=>this.storageFlow?.releaseDocument());release(()=>this.exportFlow?.releaseAndWait());release(()=>this.imageImport.releaseDocument());
    release(()=>this.drainInspector());
    release(()=>this.commandSearch.close(false));
    // Retire the New dialog without awaiting Create: that same promise opens
    // the next document. Its admitted operation pin survives until settlement.
    release(async()=>{try{if(this.panel==='new')this.closePanel();}finally{await this.newDocumentFlow.releaseView();}});
    release(()=>this.canvas?.releaseDocument());release(()=>this.textEditing.releaseDocument());release(()=>waitForDisplayPreviewReads());
    release(async()=>{const destination=this.destinationWrite;await destination?.done;if(destination?.cleanupFailure)throw destination.cleanupFailure;await settleDestinationDownloads();const downloads=destinationResources();if(downloads.copyingFallbacks||downloads.spoolDatabases)throw Error('DESTINATION_RELEASE_INCOMPLETE');});
    for(const result of await Promise.allSettled(releases))if(result.status==='rejected')failures.push(result.reason);
    this.requestUpdate();try{await this.updateComplete;}catch(error){failures.push(error);}
    if(failures.length)throw new AggregateError(failures,'DOCUMENT_RELEASE_INCOMPLETE');
  }
  private clearRenderedModels(){const errors:unknown[]=[];for(const root of [this.requestNode,this.inspectorNode,this.renderRoot])try{renderInto(nothing,root,{host:this,creationScope:scope.creationScope});}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'EDITOR_RENDER_CLEAR_INCOMPLETE');this.renderModelOwners.clear();}
  private async closeDocument(){
    if(this.composition||this.textEditing.composing)throw Error('Finish composing text before closing. Your draft is retained.');
    await editor.closeDocument();await this.updateComplete;this.querySelector<HTMLElement>('#canvas')?.focus({preventScroll:true});
  }
  protected updated(){
    if(!this.isConnected)return;this.ensureCanvasForConnectedRender();
    if(this.temporaryPan&&!this.temporaryPanCurrent())this.endTemporaryPan();
    this.renderModelOwners.commit();
    if(this.connectionRestoring||this.connectionGeneration!==shellConnectionGeneration)return;
    const {view,session}=this.read.snapshot;
    if(this.exportOpeningCurrent&&!this.exportOpeningCurrent())this.exportOpening?.abort();
    void this.textEditing.sync().catch(e=>editor.fail(e));
    void this.authoring.sync().catch(e=>editor.fail(e));
    void this.semantic.sync().catch(e=>editor.fail(e));
    void this.requestFlow.sync().catch(e=>editor.fail(e));
    void this.providerFlow.sync().catch(e=>editor.fail(e));
    this.exportFlow?.sync();
    performance.clearMarks('ie.editor.updated');performance.mark('ie.editor.updated',{detail:{busy:view.busy,ready:view.ready,documentId:view.document?.id??null,revision:view.document?.revision??null,selected:view.selected}});
    if(view.busy||this.requestNode.querySelector('[aria-busy="true"]'))editor.feedbackRendered();
    if(!session.busy&&(this.sessionBusy||this.connectedOwner!==connection.identity())){
      this.connectedOwner=connection.identity();if(session.connection==='paired')void editor.connect().catch(e=>editor.fail(e));else editor.disconnect();
    }
    this.sessionBusy=session.busy;
    const uiKey=editor.sessionId+':'+(view.document?.id??'');
    if(view.ready&&uiKey!==this.restoredUI){this.restoredUI=uiKey;void this.restoreUI(uiKey).catch(e=>editor.fail(e));}
    const tree=this.querySelector<EnTree>('#layer-tree');if(tree&&JSON.stringify(tree.selectedKeys)!==JSON.stringify(view.selected))this.adapter.write(tree,'selectedKeys',[...view.selected]);
    this.syncInspector(view.image?.layers.find(l=>l.id===view.selected[0]),view.document);
    const paintKey=(view.document?.image?.compositeAssetId??'')+':'+view.document?.width+':'+view.document?.height;
    if(paintKey!==this.repaintKey){this.repaintKey=paintKey;void this.paint().catch(e=>editor.fail(e));}
    const review=view.review;
    const asset=review?.kind==='image'?review.asset.id:review?.kind==='edit'?review.review.preview.after.compositeAssetId:null;
    if(asset&&asset!==this.previewAsset){this.previewLoaded=false;if(this.previewURL)revokeDisplayPreviewURL(this.previewURL);this.previewURL='';this.previewAsset=asset;void this.reviewImage(asset);}
    if(!review&&this.previewURL){revokeDisplayPreviewURL(this.previewURL);this.previewURL='';this.previewAsset='';}
    editor.navigationControlsCommitted(this.navigationViewportCurrent(),view===editor.view&&view.ready&&!view.busy&&!this.canvasEditingBlocked);
  }
  private async restoreUI(key:string){
    const ui=editor.ui;if(!ui)return;
    this.zoom=ui.preferences.viewport.zoom;
    for(const [id,pixels] of [['left-divider',ui.preferences.panels.left],['right-divider',ui.preferences.panels.right]] as const){const h=this.querySelector<EnSplitter>('#'+id);if(h&&!this.narrow){const width=h.parentElement!.getBoundingClientRect().width-1;const value=Math.max(h.min,Math.min(h.max,(id==='left-divider'?pixels:width-pixels)/width*100));this.adapter.write(h,'value',value);h.parentElement!.style.setProperty('--pane-ratio',String(value/100));}}
    this.pan={x:ui.preferences.viewport.x,y:ui.preferences.viewport.y};this.draw();
    // Typed request restoration owns the public prompt control.
    const panX=this.querySelector<EnNumberField>('#pan-x'),panY=this.querySelector<EnNumberField>('#pan-y');if(panX)this.adapter.write(panX,'value',String(this.pan.x));if(panY)this.adapter.write(panY,'value',String(this.pan.y));
    this.requestUpdate();
  }
  private restoreInspector(key:string){return this.trackInspector(()=>this.restoreInspectorOwned(key));}
  private syncInspector(selected:ImageLayer|undefined,document:Document|null){
    const key=(document?.id??'')+':'+(selected?.id??'');
    if(key===this.inspectorKey&&selected&&document&&this.fields&&!this.fields.dirty&&this.fields.document.revision!==document.revision){this.setFields(this.newFields(selected,document));this.requestUpdate();void this.updateComplete.then(()=>this.writeFields()).catch(error=>editor.fail(error));}
    if(key!==this.inspectorKey){const next=selected&&document?this.newFields(selected,document):undefined;try{this.adapter.invalidate();}catch(error){next?.release();throw error;}this.setFields(next);this.inspectorKey=key;this.requestUpdate();void this.updateComplete.then(async()=>{this.writeFields();await this.restoreInspector(key);}).catch(error=>editor.fail(error));}
    this.loadInspectorDimensions();
  }
  private async restoreInspectorOwned(key:string){
    const f=this.fields,owner=this.fieldsOwner,generation=this.inspectorFieldsGeneration;if(!f||!owner)return;const unpin=owner.pin();
    let unpinUI:(()=>void)|undefined;
    try{unpinUI=editor.pinUI();const checkpoint=editor.ui,draft=checkpoint?.drafts.find(d=>d.kind==='inspector'&&d.documentId===f.document.id&&d.targetLayerId===f.layer.id&&d.status==='saved-unapplied');if(!draft)return;
      const text=await editor.ownedDraftText(draft.id);try{if(editor.ui!==checkpoint||key!==this.inspectorKey||this.inspectorFieldsGeneration!==generation||!this.fields||this.fields.dirty||f.dirty)return;
        this.setFields(restoredInspector(this.fields,text.value,draft.expectedDocumentRevision,draft.id));this.writeFields();editor.patch({drafts:'Restored unapplied inspector draft'});this.requestUpdate();
      }finally{text.release();}
    }finally{try{unpinUI?.();}finally{unpin();}}
  }
  private draftId(kind:string,...parts:string[]){const legacy=[kind,...parts].join('_');if(legacy.length<=128)return legacy;const hash=new SHA256();hash.update(new TextEncoder().encode(JSON.stringify([kind,...parts])));return kind+'_'+hash.digest().slice(7);}
  private newFields(layer:ImageLayer,document:Document){const prior=this.fields,extent=prior?.layer.assetId===layer.assetId&&prior.intrinsic.status==='ready'?{width:prior.intrinsic.width,height:prior.intrinsic.height}:undefined;return newInspector(layer,document,this.draftId('inspector',document.id,layer.id),extent);}
  private loadInspectorDimensions(retry=false){
    const prior=this.fields;if(!prior||this.inspectorDrain||this.inspectorTasks.size>=8||this.inspectorSizeAbort||editor.documentResources.releasing||!prior.layer.assetId||prior.document.id!==editor.view.document?.id||prior.document.revision!==editor.view.document.revision||prior.intrinsic.status==='ready'||!retry&&prior.intrinsic.status!=='unread')return;
    const next=ownInspector({...prior,intrinsic:{status:'requested'}});this.setFields(next,true);const f=next.value,unpin=next.pin(),abort=new AbortController(),session=editor.session,identity=session.identity(),sessionId=editor.sessionId,documentEpoch=editor.documentEpoch;this.inspectorSizeAbort=abort;
    const current=()=>!abort.signal.aborted&&editor.session===session&&editor.session.identity()===identity&&editor.sessionId===sessionId&&editor.documentEpoch===documentEpoch&&editor.view.document?.id===f.document.id&&editor.view.document.revision===f.document.revision&&editor.view.selected[0]===f.layer.id&&this.fields?.layer.id===f.layer.id&&this.fields.layer.version===f.layer.version&&this.fields.layer.assetId===f.layer.assetId&&this.fields.document.revision===f.document.revision;
    try{return this.trackInspector(async()=>{try{
      await this.inspectorSizeReads.run(async signal=>{const forward=()=>abort.abort();signal.addEventListener('abort',forward,{once:true});if(signal.aborted)forward();try{const model=await editor.ownedJSON<unknown>('/api/v1/assets/'+encodeURIComponent(f.layer.assetId),'editor-inspector-dimensions',{signal:abort.signal},current,65536);try{if(!current())return;const asset=validateAssetProjection(model.value),raster=asset.raster;if(asset?.id!==f.layer.assetId||!raster)throw Error('Layer dimensions are unavailable. Use the advanced matrix controls.');const sized=sizedInspector(this.fields!,{width:raster.width,height:raster.height});this.setFields(sized,true);this.requestUpdate();}finally{model.release();}}finally{signal.removeEventListener('abort',forward);}});
    }catch(error){if(current()&&!(error instanceof Error&&error.name==='AbortError'))editor.fail(error);}finally{unpin();if(this.inspectorSizeAbort===abort)this.inspectorSizeAbort=undefined;this.requestUpdate();}}).catch(error=>editor.fail(error));}catch(error){unpin();if(this.inspectorSizeAbort===abort)this.inspectorSizeAbort=undefined;throw error;}
  }
  private friendlyNumber(key:'width'|'height'|'rotation',label:string){const f=this.fields!;return html`<en-number-field id=${'transform-'+key} label=${label} data-field=${key} .value=${f.values[key]} .step=${1} ?disabled=${!friendlyInspectorAvailable(f)} @en-input=${this.input} @en-change=${this.changed}></en-number-field>`;}
  private writeFields(){if(!this.fields)return;const slider=this.querySelector<EnSlider>('en-slider');if(slider)this.adapter.write(slider,'value',Number(this.fields.values.opacity)||0);for(const [key,value] of Object.entries(this.fields.values)){
    const host=this.querySelector<HTMLElement>('[data-field="'+key+'"]');if(host){if(typeof value==='boolean')this.adapter.write(host as EnSwitch,'checked',value);else this.adapter.write(host as EnNumberField,'value',value);}
  }}
  private navigationViewportCurrent(){const target=editor.navigationTarget();return !!target&&this.isConnected&&!this.canvasEditingBlocked&&this.canvas?.decodedAssetId===target.assetId;}
  private async paint(){
    const generation=++this.renderGeneration,canvas=this.canvas,d=editor.view.document,session=editor.session,identity=session.identity(),sessionId=editor.sessionId,epoch=editor.documentEpoch;
    if(!canvas||!this.isConnected||canvas.ownership.suspended)return;
    const documentId=d?.id,revision=d?.revision,assetId=d?.image?.compositeAssetId,assetHash=d?.image?.state.hash;
    const current=()=>generation===this.renderGeneration&&canvas===this.canvas&&this.isConnected&&!canvas.ownership.suspended&&session===editor.session&&identity===session.identity()&&sessionId===editor.sessionId&&epoch===editor.documentEpoch&&documentId===editor.view.document?.id&&revision===editor.view.document?.revision&&assetId===editor.view.document?.image?.compositeAssetId&&assetHash===editor.view.document?.image?.state.hash;
    this.reviewedCanvasPreview=null;editor.navigationViewportUnavailable();this.requestUpdate();const paintStarted=performance.now();
    await canvas.show(assetId??null,d?.width??0,d?.height??0,{zoom:this.zoom,...this.pan});
    if(!current()||!this.draw()||!current())return;
    if(documentId&&revision&&assetId&&canvas.decodedAssetId===assetId)editor.viewportDecoded({documentId,revision,assetId},paintStarted);
    performance.clearMarks('ie.canvas.drawn');performance.mark('ie.canvas.drawn',{detail:{documentId:documentId??null,revision:revision??null,assetId:assetId??null}});
  }
  private async displayPreview(asset:string|null){const d=editor.view.document;if(!this.canvas||!d)return;this.reviewedCanvasPreview=null;editor.navigationViewportUnavailable();this.requestUpdate();const generation=++this.renderGeneration;await this.canvas.show(asset??d.image?.compositeAssetId??null,d.width,d.height,{zoom:this.zoom,...this.pan});if(generation===this.renderGeneration)this.draw();}
  private async showReviewedCanvas(preview:ReviewedCanvasPreview|null,restoreReviewId?:string){
    if(!preview){if(!this.reviewedCanvasPreview||restoreReviewId&&this.reviewedCanvasPreview.reviewId!==restoreReviewId)return;await this.paint();return;}
    const d=editor.view.document;if(!this.canvas||!d||d.id!==preview.documentId||d.revision!==preview.revision)throw Error('The canvas placement review is stale. Prepare a current review.');
    if(this.authoring.drawing||this.semantic.dragging||this.textEditing.active)throw Error('Finish the active canvas edit before showing a reviewed placement.');
    const generation=++this.renderGeneration;this.endTemporaryPan();this.gesture=null;this.reviewedCanvasPreview=preview;editor.navigationViewportUnavailable();this.requestUpdate();
    try{await this.canvas.show(preview.assetId,preview.width,preview.height,{zoom:this.zoom,...this.pan});if(generation!==this.renderGeneration||!this.draw())return;performance.clearMarks('ie.reviewed-canvas.drawn');performance.mark('ie.reviewed-canvas.drawn',{detail:{reviewId:preview.reviewId,previewId:preview.previewId,documentId:preview.documentId,revision:preview.revision,assetId:preview.assetId}});}
    catch(error){if(generation===this.renderGeneration){this.reviewedCanvasPreview=null;await this.paint();}throw error;}
  }
  private draw(){const submitted=this.canvas?.draw(this.zoom,this.pan.x,this.pan.y,ctx=>{if(this.canvasEditingBlocked)return;this.authoring.overlay(ctx);this.semantic.overlay(ctx);this.textEditing.overlay(ctx);});if(!submitted){editor.navigationViewportUnavailable();return false;}if(this.navigationViewportCurrent())editor.navigationRenderSubmitted();else editor.navigationViewportUnavailable();performance.clearMarks('ie.viewport.drawn');performance.mark('ie.viewport.drawn',{detail:{zoom:this.zoom,x:this.pan.x,y:this.pan.y}});return true;}
  private async reviewImage(asset:string){this.previewRead?.abort();const abort=new AbortController();this.previewRead=abort;const epoch=editor.documentEpoch,owns=()=>!abort.signal.aborted&&epoch===editor.documentEpoch&&this.previewAsset===asset;try{const transport=connection.transport.bind(connection),url=await withDisplaySource(transport,asset,{owner:'image-review-descriptor',signal:abort.signal,owns},source=>createDisplayPreviewURL(transport,source,{owner:'image-review',edge:1024,signal:abort.signal,owns}));if(!owns()){revokeDisplayPreviewURL(url);return;}if(this.previewURL)revokeDisplayPreviewURL(this.previewURL);this.previewURL=url;this.requestUpdate();}catch(error){if(owns())editor.fail(error);}finally{if(this.previewRead===abort)this.previewRead=undefined;}}
  private async panels(){
    if(this.panelReady)return;
    this.panelLoading??=import('./editor-panels.js').then(({panelDefinitions})=>{scope.register(panelDefinitions);this.panelReady=true;this.requestUpdate();}).catch(error=>{this.panelLoading=undefined;throw error;});
    await this.panelLoading;await this.updateComplete;
  }
  private showPanel(panel:NonNullable<EditorShell['panel']>,loadStorage?:()=>Promise<{StorageLibrary:typeof StorageLibrary}>){
    if(editor.view.busy||panel==='export'&&!this.exportFlow||panel==='storage'&&!this.storageFlow&&!loadStorage)return;
    this.exportOpening?.abort();
    const importEpoch=this.panel==='import'&&panel!=='import'?this.copyPanelEpoch:undefined;
    const storageEpoch=this.panel==='storage'&&panel!=='storage'?this.copyPanelEpoch:undefined;
    const storageOpening=panel==='storage',openingEpoch=this.copyPanelEpoch,session=editor.sessionId,documentEpoch=editor.documentEpoch,connection=editor.session,identity=connection?.identity();
    const current=()=>(importEpoch===undefined||(this.panel==='import'&&this.copyPanelEpoch===importEpoch))&&(storageEpoch===undefined||(this.panel==='storage'&&this.copyPanelEpoch===storageEpoch))&&(!(storageOpening||storageEpoch!==undefined)||(editor.sessionId===session&&editor.documentEpoch===documentEpoch&&editor.session===connection&&connection?.identity()===identity&&this.copyPanelEpoch===openingEpoch));
    void editor.run('Open '+panel,async()=>{
      await this.panels();if(!current())return;
      // Import and storage remain reachable until their actual owner drains.
      if(importEpoch!==undefined){await this.imageImport.releaseDocument();if(!current())return;}
      if(storageEpoch!==undefined){await this.storageFlow?.releaseDocument();if(!current())return;}
      if(panel==='open'){await editor.listUI();if(!current())return;await editor.listStages();if(!current())return;}
      if(storageOpening&&!this.storageFlow){if(!loadStorage)return;const {StorageLibrary}=await loadStorage();if(!current())return;this.storageFlow=new StorageLibrary(this,editor,{onRestoreCopy:()=>this.showPanel('open'),onImport:()=>this.showPanel('import')});}
      if(panel==='export')this.exportFlow!.begin();if(panel==='import')this.imageImport.begin();if(panel==='new')this.newDocumentFlow.begin();
      const publishedEpoch=++this.copyPanelEpoch;this.recoveryCopyAcknowledgement=null;this.panel=panel;this.requestUpdate();await this.updateComplete;
      if((importEpoch!==undefined||storageEpoch!==undefined||storageOpening)&&(this.panel!==panel||this.copyPanelEpoch!==publishedEpoch||editor.sessionId!==session||editor.documentEpoch!==documentEpoch||editor.session!==connection||connection?.identity()!==identity))return;
      this.querySelector<EnDialog>('#editor-dialog')?.show();if(panel==='new')this.querySelector<HTMLElement>('#new-name')?.focus();
      if(storageOpening)await this.storageFlow!.open();
    });
  }
  #showStorage(event?:Event){
    const open=()=>this.showPanel('storage',()=>import('./storage-library.js'));
    if(event)this.adapter.action(event,open);else open();
  }
  #showExport(){
    if(editor.view.busy)return;
    if(this.exportFlow){this.showPanel('export');return;}
    this.exportOpening?.abort();const intent=new AbortController();this.exportOpening=intent;this.exportLoadFailed=false;
    const origin=this.panel,originEpoch=this.copyPanelEpoch,session=editor.sessionId,documentEpoch=editor.documentEpoch,connection=editor.session,identity=connection.identity();
    const mount=this.connectionGeneration,lifetime=this.lifecycle,documentId=editor.view.document?.id,revision=editor.view.document?.revision;
    const current=()=>this.exportOpening===intent&&!intent.signal.aborted&&this.connectionAdmitted&&this.isConnected&&this.connectionGeneration===mount&&this.lifecycle===lifetime&&!lifetime?.signal.aborted&&editor.view.ready&&editor.sessionId===session&&editor.documentEpoch===documentEpoch&&editor.session===connection&&connection.identity()===identity&&editor.view.document?.id===documentId&&editor.view.document?.revision===revision;
    const atOrigin=()=>current()&&this.panel===origin&&this.copyPanelEpoch===originEpoch;
    this.exportOpeningCurrent=current;let loadingEpoch:number|undefined;
    void editor.run('Open export',async()=>{
      try{
        await this.panels();if(!atOrigin())return;
        // Existing panel owners remain reachable until their actual drain.
        if(origin==='import'){await this.imageImport.releaseDocument();if(!atOrigin())return;}
        if(origin==='storage'){await this.storageFlow?.releaseDocument();if(!atOrigin())return;}
        loadingEpoch=++this.copyPanelEpoch;this.recoveryCopyAcknowledgement=null;this.panel='export';this.requestUpdate();await this.updateComplete;
        if(!current()||this.panel!=='export'||this.copyPanelEpoch!==loadingEpoch)return;
        this.querySelector<EnDialog>('#editor-dialog')?.show();
        // Cancel releases this owner wait. Native module loading may continue,
        // but its shared promise never owns a particular shell or controller.
        const signal=intent.signal;let cancel!:()=>void;
        const cancelled=new Promise<undefined>(resolve=>{cancel=()=>resolve(undefined);});
        signal.addEventListener('abort',cancel,{once:true});
        try{
          const loading=exportModuleLoading??=import('./export.js');
          const loaded=await Promise.race([loading,cancelled]);
          if(!loaded||!current()||this.panel!=='export'||this.copyPanelEpoch!==loadingEpoch)return;
          this.exportFlow=new loaded.ExportControls(this,editor,()=>this.closePanel());
        }catch(error){
          if(!current()||this.panel!=='export'||this.copyPanelEpoch!==loadingEpoch)return;
          this.exportLoadFailed=true;this.requestUpdate();
          throw Error('Export controls could not be loaded. Close this dialog and reload the editor to retry.',{cause:error});
        }finally{signal.removeEventListener('abort',cancel);}
        if(!current())return;
        this.exportFlow!.begin();this.requestUpdate();await this.updateComplete;
        if(current()&&this.panel==='export'&&this.copyPanelEpoch===loadingEpoch)this.querySelector<EnDialog>('#editor-dialog')?.show();
      }finally{
        if(this.exportOpening===intent){
          // Retire only this invalidated loading view; a replacement panel and
          // its document must not receive a stale publication or global error.
          if(!current()&&loadingEpoch!==undefined&&this.panel==='export'&&this.copyPanelEpoch===loadingEpoch&&!this.exportFlow){
            this.panel=null;this.copyPanelEpoch++;this.recoveryCopyAcknowledgement=null;
            if(this.connectionAdmitted&&this.isConnected)this.requestUpdate();
          }
          this.exportOpening=undefined;this.exportOpeningCurrent=undefined;
        }
      }
    });
  }
  private action(event:Event,label:string,work:()=>Promise<void>){
    const dialog=event.currentTarget instanceof HTMLElement?event.currentTarget.closest<EnDialog>('en-dialog'):null;
    this.adapter.action(event,()=>{
      const interaction=this.interactionEpoch,session=editor.sessionId;
      void editor.run(label,work,event.timeStamp).then(async()=>{
        if(!editor.view.error||!dialog)return;
        await this.updateComplete;
        if(this.interactionEpoch===interaction&&editor.sessionId===session&&dialog.isConnected&&dialog.open)dialog.querySelector<HTMLElement>('en-validation-summary')?.focus();
      });
    });
  }
  private statusNavigation=(event:KeyboardEvent)=>{
    const region=event.currentTarget;
    if(event.defaultPrevented||event.isComposing||this.composition||event.keyCode===229||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey||!['Home','End'].includes(event.key)||!(region instanceof HTMLElement)||region.tagName!=='SECTION'||event.target!==region||document.activeElement!==region||!region.isConnected||region.isContentEditable)return;
    // Only this app-owned scroll region consumes its own navigation keys.
    // Descendant native editing/activation and normal page navigation keep ownership.
    event.preventDefault();region.scrollTo({top:event.key==='Home'?0:region.scrollHeight,behavior:'instant'});
  };
  private reviewTextRaster(){return this.trackInspector(()=>this.reviewTextRasterOwned());}
  private async reviewTextRasterOwned(){
    const fields=this.fields,owner=this.fieldsOwner,document=fields?.document,layer=fields?.layer;
    if(!document||!layer||!owner||layer.kind!=='text'||layer.locked)throw Error('Select an unlocked text layer.');
    const unpin=owner.pin();let workspace:ReturnType<typeof reserveModelBytes>|undefined,next:OwnedModel<RasterizeReview>|undefined,reviewPin:(()=>void)|undefined,installed=false;
    try{
      // Own bounded path and authority aliases before constructing the request.
      workspace=reserveModelBytes('editor-rasterize-operation',4096,1);
      const session=editor.sessionId,connection=editor.session,identity=connection.identity(),epoch=editor.documentEpoch,panelEpoch=this.copyPanelEpoch;
      const current=()=>identity!==null&&!this.inspectorDrain&&editor.session===connection&&connection.identity()===identity&&editor.sessionId===session&&editor.documentEpoch===epoch&&this.copyPanelEpoch===panelEpoch&&editor.view.document?.id===document.id&&editor.view.document.revision===document.revision&&this.fieldsOwner===owner;
      next=await editor.withJSON<{source:TextSource},OwnedModel<RasterizeReview>>('/api/v1/documents/'+document.id+'/text?layerId='+layer.id+'&revision='+document.revision,'editor-rasterize-response',value=>{
        const render=value?.source?.render?.id;if(typeof render!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(render))throw Error('Text render is unavailable.');
        const review={document,layer,render,session},bytes=modelPayloadBytes(review);if(bytes>RASTERIZE_REVIEW_BYTES)throw Error('This text layer’s review metadata is too large. Shorten its name before reviewing a raster copy.');
        return createOwnedModel('editor-rasterize-review',bytes,()=>structuredClone(review));
      },{signal:this.lifecycle?.signal},current,65536);
      await this.panels();if(!current())throw Error('Text changed. Review the raster copy again.');
      reviewPin=next.pin();this.setRasterizeReview(next);installed=true;this.panel='rasterize';this.requestUpdate();await this.updateComplete;
      if(!current()||this.rasterizeOwner!==next)throw Error('Text changed. Review the raster copy again.');this.querySelector<EnDialog>('#editor-dialog')?.show();
    }finally{reviewPin?.();if(!installed)next?.release();workspace?.release();unpin();}
  }
  private applyTextRaster(){return this.trackInspector(()=>this.applyTextRasterOwned());}
  private async applyTextRasterOwned(){
    const r=this.rasterizeReview,owner=this.rasterizeOwner;
    if(!r||!owner||editor.sessionId!==r.session||editor.view.document?.id!==r.document.id||editor.view.document.revision!==r.document.revision)throw Error('Text changed. Cancel and review the raster copy again.');
    const unpin=owner.pin();try{await editor.withCommandEvents({type:'RasterizeTextDerivative',layerId:r.layer.id,layerVersion:r.layer.version,newLayerId:crypto.randomUUID(),name:r.layer.name+' raster copy',hideOriginal:true,reviewedRender:r.render,draft:null},()=>undefined,r.document);
    this.closePanel();}finally{unpin();}
  }
  private closePanel(){
    this.exportOpening?.abort();
    if(this.panel==='storage'){
      const epoch=++this.copyPanelEpoch,current=()=>this.panel==='storage'&&this.copyPanelEpoch===epoch;
      void(async()=>{
        try{await this.storageFlow?.releaseDocument();if(!current())return;this.panel=null;this.recoveryCopyAcknowledgement=null;this.setRasterizeReview();this.requestUpdate();}
        catch(error){editor.fail(error);if(!current())return;try{this.requestUpdate();await this.updateComplete;}catch(updateError){editor.fail(updateError);}if(current())this.querySelector<EnDialog>('#editor-dialog')?.show();}
      })().catch(error=>editor.fail(error));
      return;
    }
    if(this.panel==='import'){
      const epoch=++this.copyPanelEpoch,current=()=>this.panel==='import'&&this.copyPanelEpoch===epoch;
      // Stay synchronous: an Import task may itself be completing a UI action.
      // Its actual drain, rather than the close proposal, releases the panel.
      void(async()=>{
        try{await this.imageImport.releaseDocument();if(!current())return;this.panel=null;this.recoveryCopyAcknowledgement=null;this.setRasterizeReview();this.requestUpdate();}
        catch(error){
          editor.fail(error);if(!current())return;
          try{this.requestUpdate();await this.updateComplete;}catch(updateError){editor.fail(updateError);}
          // Native dismissal may already have closed EnDialog while .open's
          // rendered expression stayed true. Reopen through its public method.
          if(current())this.querySelector<EnDialog>('#editor-dialog')?.show();
        }
      })().catch(error=>editor.fail(error));
      return;
    }
    if(this.panel==='export')this.exportFlow?.cancel();if(this.panel==='new')this.newDocumentFlow.cancel();this.panel=null;this.recoveryCopyAcknowledgement=null;this.copyPanelEpoch++;this.setRasterizeReview();this.requestUpdate();
  }
  private recoveryCopyOwner(){const d=editor.view.document;return this.panel==='copy'&&d&&editor.view.ready?JSON.stringify([connection.identity(),editor.sessionId,editor.documentEpoch,d.id,d.revision,this.copyPanelEpoch]):null;}
  private async prepareRecoveryCopy(){
    const owner=this.recoveryCopyOwner();
    if(!owner||this.recoveryCopyAcknowledgement!==owner)throw Error('Review and acknowledge the incomplete recovery copy for this document again.');
    this.recoveryCopyAcknowledgement=null;this.requestUpdate();
    await editor.copyRecovery(crypto.randomUUID());
    if(this.recoveryCopyOwner()===owner)this.closePanel();
  }
  private async prepare(work:()=>Promise<void>){await this.panels();await work();this.panel=null;this.requestUpdate();await this.updateComplete;this.querySelector<EnDialog>('#review-dialog')?.show();}
  private input=(event:DraftInputEvent)=>{
    if(event.composedPath()[0]!==event.currentTarget)return;
    const key=(event.currentTarget as HTMLElement).dataset.field as keyof Fields;
    if(!key||!this.fields)return;
    try{this.editInspector(key,event.detail.value,event.detail.isComposing??this.composition);}catch(error){const value=this.fields?.values[key];if(value!==undefined)this.adapter.write(event.currentTarget as EnNumberField,'value',String(value));editor.fail(error);}
  };
  private persistInspector(fields:InspectorSnapshot,composing=false){if(editor.view.document?.id!==fields.document.id||editor.view.selected[0]!==fields.layer.id)throw Error('DOCUMENT_CHANGED');const serialized=serializedInspector(fields.values);try{editor.changeDraft(fields.draftId,'inspector',serialized.wire,fields.layer.id,composing,fields.document.revision);}finally{serialized.release();}}
  private saveInspector(composing=false){const fields=this.fields;if(fields)this.persistInspector(fields,composing);}
  private changed=(event:Event)=>{const host=event.currentTarget as EnNumberField;this.adapter.settled(event,()=>host.value,value=>{const key=host.dataset.field as keyof Fields;try{this.editInspector(key,value);}catch(error){const previous=this.fields?.values[key];if(previous!==undefined)this.adapter.write(host,'value',String(previous));editor.fail(error);}});};
  private applyFields(kind:'properties'|'transform'|'appearance'){return this.trackInspector(()=>this.applyFieldsOwned(kind));}
  private async applyFieldsOwned(kind:'properties'|'transform'|'appearance'){
    const f=this.fields,owner=this.fieldsOwner;if(!f||!owner||this.composition)return;const unpin=owner.pin();
    try{await editor.flushDrafts();if(this.fields!==f)throw Error('DRAFT_CHANGED');
    const v=f.values;const id=f.draftId;const saved=editor.draftOwner?.drafts.get(id);
    const draft=saved&&saved.savedGeneration===saved.generation&&!editor.ui?.drafts.some(d=>d.id===id&&d.generation===saved.generation&&d.status==='applied')?{sessionId:editor.sessionId,draftId:id,generation:saved!.generation}:null;
    let body:Command['body'];
    if(kind==='appearance'){body={type:'SetLayerAppearance',layerId:f.layer.id,layerVersion:f.layer.version,description:v.appearance,draft};}
    else if(kind==='properties'){const opacity=Number(v.opacity);if(v.opacity.trim()===''||!Number.isFinite(opacity)||opacity<0||opacity>1)throw Error('Enter opacity between 0 and 1.');body={type:'SetLayerProperties',layerId:f.layer.id,layerVersion:f.layer.version,properties:{name:v.name,opacity,visible:v.visible,locked:v.locked},draft};}
    else{const transform=inspectorTransform(f);body={type:'ApplyTransform',layerId:f.layer.id,layerVersion:f.layer.version,transform,draft};}
    // Commands consume only the captured document identity/revision fence.
    await editor.withCommandEvents(body,()=>undefined,f.document);const layer=editor.view.image?.layers.find(l=>l.id===f.layer.id);if(layer&&editor.view.document){this.setFields(this.newFields(layer,editor.view.document));this.writeFields();this.requestUpdate();}
    }finally{unpin();}
  }
  private resetFields(){const old=this.fields;if(old)void editor.clearDraft(old.draftId).catch(e=>editor.fail(e));const layer=editor.view.image?.layers.find(l=>l.id===editor.view.selected[0]);if(layer&&editor.view.document){this.setFields(this.newFields(layer,editor.view.document));this.writeFields();this.requestUpdate();}}
  private async importHandoff(files:readonly File[],work:()=>Promise<void>){
    if(!files.length)return;if(files.length>32||files.some(file=>file.name.length>4096))throw Error('Choose up to 32 images with bounded filenames.');
    const lease=allocationLedger.reserve({owner:'image-import-handoff',kind:'control',cpuBytes:files.length*8448,handles:files.length}),session=editor.sessionId,client=editor.session.identity(),epoch=editor.documentEpoch;
    try{await this.panels();if(!editor.view.ready||session!==editor.sessionId||client!==editor.session.identity()||epoch!==editor.documentEpoch)throw Error('The import owner changed before the files could be reviewed.');this.copyPanelEpoch++;this.panel='import';this.requestUpdate();await this.updateComplete;this.querySelector<EnDialog>('#editor-dialog')?.show();await work();}finally{lease.release();}
  }
  private openImportFiles(files:readonly File[]){return this.importHandoff(files,()=>this.imageImport.select(files));}
  private resumeImage(file:File,id:string){return this.importHandoff([file],()=>this.imageImport.resumeTransfer(file,id));}
  private file=(event:Event,kind:'image'|'bundle')=>{const host=event.currentTarget as EnFileUpload;this.adapter.settled(event,()=>host.files,files=>{if(kind==='image'){void this.openImportFiles(files).catch(error=>editor.fail(error));return;}const file=files[0];if(file)void editor.run('Inspect portable project',()=>this.prepare(()=>editor.openBundle(file)));});};
  private drop=(event:DragEvent)=>{
    if(this.canvasEditingBlocked||this.composition||this.textEditing.composing||this.editable(event)){event.preventDefault();return;}
    if(event.defaultPrevented||!event.dataTransfer?.types.includes('Files'))return;event.preventDefault();
    const files=[...event.dataTransfer.files];if(!files.some(file=>file.type.startsWith('image/'))){editor.fail(Error('Drop PNG, JPEG or static WebP images on the canvas import target. Use Open for a portable project.'));return;}
    void this.openImportFiles(files).catch(error=>editor.fail(error));
  };
  private paste=(event:ClipboardEvent)=>{if(this.canvasEditingBlocked||event.defaultPrevented||this.composition||this.textEditing.composing||this.editable(event))return;const files=[...(event.clipboardData?.files??[])];if(!files.some(file=>file.type.startsWith('image/')))return;event.preventDefault();void this.openImportFiles(files).catch(error=>editor.fail(error));};
  private editable(event:Event){return event.composedPath().some(n=>n instanceof HTMLElement&&(n.matches('input,textarea,select,[contenteditable]:not([contenteditable="false"])')||n.isContentEditable));}
  private temporaryPanCurrent(){const owner=this.temporaryPan,d=editor.view.document;return !!owner&&!!d&&!this.canvasEditingBlocked&&!this.composition&&!this.textEditing.active&&!this.textEditing.composing&&!shortcutModalConflict(this,[])&&owner.session===editor.sessionId&&owner.identity===editor.session.identity()&&owner.epoch===editor.documentEpoch&&owner.documentId===d?.id&&owner.revision===d.revision;}
  private endTemporaryPan(){if(!this.temporaryPan)return;this.temporaryPan=null;const gesture=this.gesture;if(gesture?.temporary){this.pan={x:gesture.oldX,y:gesture.oldY};this.gesture=null;if(this.canvasElement?.hasPointerCapture(gesture.id))this.canvasElement.releasePointerCapture(gesture.id);this.draw();}this.requestUpdate();}
  private shortcut=(event:KeyboardEvent)=>this.handleShortcut(event);
  private handleShortcut(event:KeyboardEvent){
    const path=shortcutPath(event,this);if(!path||this.canvasEditingBlocked||this.composition||this.textEditing.composing||this.textEditing.active||shortcutModalConflict(this,path))return;
    const mod=event.metaKey||event.ctrlKey;if(event.altKey||event.metaKey&&event.ctrlKey)return;
    if(event.key==='Escape'&&this.semantic.dragging){event.preventDefault();this.semantic.cancelDrag();return;}
    if(event.key==='Escape'&&this.authoring.drawing){event.preventDefault();this.authoring.cancelGesture();return;}
    if(mod&&event.key.toLowerCase()==='s'){event.preventDefault();if(event.shiftKey)this.showPanel('copy');else if(editor.view.document)void editor.run('Save checkpoint',async()=>{await editor.withCommandEvents({type:'SaveCheckpoint',name:'Checkpoint '+new Date().toLocaleString()},()=>undefined);});return;}
    if(mod&&event.key.toLowerCase()==='o'){event.preventDefault();this.showPanel('open');return;}
    if(mod&&event.key.toLowerCase()==='z'&&!event.shiftKey&&this.tool==='Mask'&&this.authoring.undoStroke()){event.preventDefault();return;}
    if(mod&&event.key.toLowerCase()==='z'&&editor.view.document){event.preventDefault();this.historyAction(event.shiftKey?'Redo':'Undo');return;}
    if(mod)return;
    const canvas=this.querySelector<HTMLElement>('#canvas'),tools=this.querySelector<HTMLElement>('.tool-rail'),tree=this.querySelector<HTMLElement>('#layer-tree');
    const inCanvas=!!canvas&&path.includes(canvas),inTools=!!tools&&path.includes(tools),inLayers=!!tree&&path.includes(tree);
    if(event.key==='Delete'&&!event.shiftKey&&(inCanvas||inLayers)&&!shortcutActivation(path)){
      const d=editor.view.document,f=this.fields,selected=editor.view.selected,treeItem=inLayers?path.find(node=>node.getAttribute('role')==='treeitem'):undefined;
      if(inLayers&&(!treeItem||treeItem.getAttribute('aria-selected')!=='true'||(tree as EnTree).selectedKeys.length!==1||(tree as EnTree).selectedKeys[0]!==selected[0]))return;
      if(!editor.view.ready||editor.view.busy||!d||!f||selected.length!==1||selected[0]!==f.layer.id||f.layer.locked||f.dirty||f.document.id!==d.id||f.document.revision!==d.revision)return;
      const id=d.id,revision=d.revision,epoch=editor.documentEpoch,session=editor.sessionId,identity=editor.session.identity(),draftId=f.draftId,layerId=f.layer.id,version=f.layer.version;
      this.adapter.action(event,()=>{
        const current=editor.view.document,fields=this.fields;
        if(inLayers&&(!treeItem?.isConnected||treeItem.getAttribute('aria-selected')!=='true'||(tree as EnTree).selectedKeys.length!==1||(tree as EnTree).selectedKeys[0]!==layerId))return;
        if(!shortcutFocus(path,this)||shortcutModalConflict(this,path)||this.canvasEditingBlocked||this.composition||this.textEditing.active||this.textEditing.composing||editor.view.busy||!editor.view.ready||editor.documentEpoch!==epoch||editor.sessionId!==session||editor.session.identity()!==identity||current?.id!==id||current.revision!==revision||!fields||fields.draftId!==draftId||fields.layer.id!==layerId||fields.layer.version!==version||fields.layer.locked||fields.dirty||editor.view.selected.length!==1||editor.view.selected[0]!==layerId)return;
        void editor.run('Delete selected layer',()=>this.inspectorLayerAction('delete',draftId),event.timeStamp);
      });return;
    }
    if(!this.singleKeyShortcuts&&event.key.length===1)return;
    if(event.key==='?'){void this.panels().then(()=>this.querySelector<EnDialog>('#help-drawer')?.show());return;}
    if(!inCanvas&&!inTools)return;
    const key=event.key.toLowerCase(),tool=({v:'Move',m:'Select',b:'Mask',h:'Pan',i:'Sample',c:'Crop'} as Record<string,string>)[key];
    if(tool){const id=editor.view.document?.id,revision=editor.view.document?.revision,epoch=editor.documentEpoch,session=editor.sessionId,identity=editor.session.identity();this.adapter.action(event,()=>{if(!shortcutFocus(path,this)||shortcutModalConflict(this,path)||this.composition||this.textEditing.active||this.textEditing.composing||editor.documentEpoch!==epoch||editor.sessionId!==session||editor.session.identity()!==identity||editor.view.document?.id!==id||editor.view.document?.revision!==revision)return;void this.chooseTool(tool,canvas??this).catch(error=>editor.fail(error));});return;}
    if(!inCanvas)return;
    if(event.key===' '&&!event.shiftKey&&!shortcutActivation(path)){
      const d=editor.view.document;if(!d||!editor.view.ready||editor.view.busy||this.authoring.drawing||this.semantic.dragging||this.gesture)return;
      event.preventDefault();this.temporaryPan={session:editor.sessionId,identity:editor.session.identity(),epoch:editor.documentEpoch,documentId:d.id,revision:d.revision};this.requestUpdate();return;
    }
    if(event.key==='Enter'&&!shortcutActivation(path)){const layer=editor.view.image?.layers.find(l=>l.id===editor.view.selected[0]);if(layer?.kind==='text'){event.preventDefault();void editor.run('Edit text',()=>this.textEditing.begin(canvas!,layer));return;}}
    if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)&&!shortcutActivation(path)){event.preventDefault();const n=event.shiftKey?50:10;this.pan={x:this.pan.x+(event.key==='ArrowLeft'?-n:event.key==='ArrowRight'?n:0),y:this.pan.y+(event.key==='ArrowUp'?-n:event.key==='ArrowDown'?n:0)};this.draw();void editor.preferences({viewport:{...this.pan,zoom:this.zoom}}).catch(e=>editor.fail(e));}
    if(['+','-','0'].includes(event.key)){event.preventDefault();if(event.key==='0')this.fit();else this.setZoom(this.zoom*(event.key==='+'?1.1:1/1.1));}
    if(event.key==='Escape'){this.endTemporaryPan();if(this.gesture){this.pan={x:this.gesture.oldX,y:this.gesture.oldY};this.gesture=null;this.draw();}}
  }
  private undoReason(){if(!editor.view.document)return 'Open or create a document first.';return editor.view.undoAvailable===null?'Wait for the current accepted history to finish loading.':!editor.view.undoAvailable?'There is no earlier accepted edit to restore.':'';}
  private historyAction(type:'Undo'|'Redo'){if(this.canvasEditingBlocked||type==='Undo'&&!!this.undoReason())return;void editor.run(type,()=>this.trackInspector(async()=>{const d=editor.view.document;if(!d||type==='Undo'&&!!this.undoReason()||type==='Redo'&&!d.redo)return;const unpin=editor.pinViewModels(d);try{await editor.withCommandEvents(type==='Undo'?{type,historyHead:d.historyHead}:{type,historyNode:d.redo!},()=>undefined,d);}finally{unpin();}}));}
  private setZoom(value:number){if(!Number.isFinite(value)||value<=0){editor.fail(Error('Enter a positive, finite zoom percentage.'));return;}this.zoom=value;this.draw();void editor.preferences({viewport:{...this.pan,zoom:value}}).catch(e=>editor.fail(e));this.requestUpdate();}
  private zoomAtPoint(point:readonly [number,number],out:boolean){
    if(!this.canvas)return;const value=this.zoom*(out?1/1.1:1.1);if(!Number.isFinite(value)||value<=0)return;
    const before=this.canvas.screenPoint(point,this.zoom,this.pan.x,this.pan.y),after=this.canvas.screenPoint(point,value,this.pan.x,this.pan.y),pan={x:this.pan.x+before[0]-after[0],y:this.pan.y+before[1]-after[1]};
    if(!Number.isFinite(pan.x)||!Number.isFinite(pan.y))return;performance.clearMarks('ie.intent.View zoom');performance.mark('ie.intent.View zoom');this.pan=pan;this.setZoom(value);
  }
  private fit(){const d=editor.view.document,c=this.querySelector('canvas');if(!d||!c)return;const box=c.getBoundingClientRect();this.pan={x:0,y:0};this.setZoom(Math.max(Number.EPSILON,Math.min((box.width-40)/d.width,(box.height-40)/d.height)));}
  private split=(event:Event)=>{const host=event.currentTarget as EnSplitter;this.adapter.settled(event,()=>host.value,value=>{host.parentElement!.style.setProperty('--pane-ratio',String(value/100));});};
  private persistSplit=(event:Event)=>{const host=event.currentTarget as EnSplitter;setTimeout(()=>{const p=editor.ui?.preferences.panels;if(p)void editor.preferences({panels:{...p,[host.id==='left-divider'?'left':'right']:(host.parentElement!.getBoundingClientRect().width-1)*(host.id==='left-divider'?host.value:100-host.value)/100}}).catch(e=>editor.fail(e));},0);};
  private numeric(id:string){const host=this.querySelector<EnNumberField>('#'+id)!;const raw=host.value;if(raw.trim()===''||!Number.isFinite(Number(raw)))throw Error('Enter a valid value for '+host.label+'.');return Number(raw);}
  private async download(){
    const item=editor.view.download;if(!item||editor.view.busy||this.destinationWrite)return;
    const unpin=editor.pinDownload(item);
    try{const operation={controller:new AbortController(),committing:false,cleanupFailure:null as unknown,done:undefined as Promise<void>|undefined};
    const session=editor.sessionId,identity=connection.identity(),epoch=editor.documentEpoch;
    const current=()=>this.destinationWrite===operation&&editor.sessionId===session&&connection.identity()===identity&&editor.documentEpoch===epoch&&editor.view.download?.path===item.path&&editor.view.download.hash===item.hash;
    this.destinationWrite=operation;let chosen:ReturnType<typeof chooseDestination>;try{chosen=chooseDestination(item.name,operation.controller.signal);}catch(error){this.destinationWrite=null;this.requestUpdate();throw error;}
    operation.done=editor.run('Write '+item.kind,async()=>{
      if(!current()){operation.controller.abort();return;}
      editor.patch({download:{...item,status:'writing'}});
      try{
        const status=await writeDestination(item,path=>connection.transport(path,{signal:operation.controller.signal}),chosen,operation.controller.signal,phase=>{operation.committing=phase==='committing';this.requestUpdate();});
        if(current())editor.patch({download:{...item,status},message:status==='confirmed'?'Saved to destination: browser write completed.':'Download initiated. External destination remains unconfirmed.'});
      }catch(error){
        if(error instanceof AggregateError)operation.cleanupFailure=error;
        if(!current())return;
        if(error instanceof DOMException&&error.name==='AbortError'){editor.patch({download:{...item,status:operation.committing?'failed':'ready'},message:operation.committing?'Destination commit was not confirmed. Prepared local bytes remain available; inspect the chosen destination before retrying.':'Destination write canceled. Prepared bytes and previous destination files are retained.'});return;}
        editor.patch({download:{...item,status:'failed'}});throw error;
      }finally{if(this.destinationWrite===operation){this.destinationWrite=null;this.requestUpdate();}}
    });
    try{await operation.done;}finally{if(this.destinationWrite===operation){this.destinationWrite=null;this.requestUpdate();}}
    }finally{unpin();}
  }
  private number(id:string,label:string,value:string,field?:keyof Fields){return html`<en-number-field id=${id} label=${label} .defaultValue=${value} data-field=${field??''} @en-input=${field?this.input:nothing} @en-change=${field?this.changed:nothing}></en-number-field>`;}
  private inspectorLayerAction(kind:'duplicate'|'delete'|'up'|'down'|'lock',expected:string|undefined){return this.trackInspector(()=>this.inspectorLayerActionOwned(kind,expected));}
  private async inspectorLayerActionOwned(kind:'duplicate'|'delete'|'up'|'down'|'lock',expected:string|undefined){
    const f=this.fields,owner=this.fieldsOwner,document=editor.view.document;if(!f||!owner||!document||f.draftId!==expected||f.document.id!==document.id)throw Error('DOCUMENT_CHANGED');const unpin=owner.pin();
    try{if(kind==='duplicate')return await this.leaf({type:'DuplicateLayer',layerId:f.layer.id,layerVersion:f.layer.version,newLayerId:crypto.randomUUID(),name:f.layer.name+' copy',draft:null});
      if(kind==='delete')return await this.leaf({type:'DeleteLayer',layerId:f.layer.id,layerVersion:f.layer.version,draft:null});
      if(kind==='lock')return await this.leaf({type:'SetLayerProperties',layerId:f.layer.id,layerVersion:f.layer.version,properties:{locked:!f.layer.locked},draft:null});
      const copy=cloneOwnedModel('editor-layer-order',document.orderedLayerIds);try{const ids=copy.value as string[],i=ids.indexOf(f.layer.id);if(kind==='up'&&i>=0&&i<ids.length-1)[ids[i],ids[i+1]]=[ids[i+1],ids[i]];if(kind==='down'&&i>0)[ids[i],ids[i-1]]=[ids[i-1],ids[i]];await this.leaf({type:'MoveLayers',orderedLayerIds:ids,draft:null});}finally{copy.release();}
    }finally{unpin();}
  }
  private async leaf(body:Command['body']){if(this.canvasEditingBlocked)throw Error('Return to the accepted document and wait for canvas recovery before editing it.');await editor.withCommandEvents(body,()=>undefined);}
  private historyItem=(item:ActivityRecord)=>{const nodeId=item.key,node=editor.view.history.find(n=>n.id===nodeId);return html`<p>${item.text}</p>${node?.kind==='image-edit'?html`<en-button slot="actions" size="small" variant="secondary" ?disabled=${editor.view.busy} @click=${(e:Event)=>this.action(e,'Switch retained branch',async()=>{const current=editor.view.history.find(n=>n.id===nodeId);if(current)await this.leaf({type:'SwitchBranch',branchId:current.branchId,historyNode:current.id});})}>Open this history state</en-button>`:nothing}`;};
  private renderPanes(){
    this.inspectorNode.inert=this.canvasEditingBlocked;
    const view=editor.view,d=view.document,f=this.fields,fieldId=f?.draftId,locked=!view.ready||view.busy;
    for(const [node,id,label,classes,open] of [[this.requestNode,'request','Request','request-panel panel',this.requestOpen],[this.inspectorNode,'inspector','Layers and properties','inspector panel',this.inspectorOpen]] as const){node.id=id;node.className=classes;node.tabIndex=-1;node.setAttribute('aria-label',label);node.hidden=this.narrow&&!this.drawerMode&&!open;}
    renderInto(html`<div class="panel-heading"><h1>Request</h1><en-badge>Draft</en-badge></div><div class="request-fields"><en-select label="Operation" .value=${this.requestFlow.operation} @en-change=${this.requestFlow.operationChoice(value=>this.requestOperationChanged(value))}>${operations.map(name=>html`<en-select-option value=${name}>${name}</en-select-option>`)}</en-select>
    ${legacyOperation(this.requestFlow.operation)?this.semantic.request():nothing}${this.requestFlow.render()}${this.providerFlow.render()}</div>`,this.requestNode,{host:this,creationScope:scope.creationScope});
    renderInto(html`<en-tabs label="Document structure" .value=${this.structure} @en-change=${(e:Event)=>{const h=e.currentTarget as HTMLElement&{value:string};this.adapter.settled(e,()=>h.value,v=>{this.semantic.cancelReview();this.structure=v;this.requestUpdate();});}}><en-tab slot="tab" value="layers">Layers</en-tab><en-tab slot="tab" value="composition">Composition</en-tab><en-tab-panel slot="panel" value="layers">
    <en-tree id="layer-tree" label="Image layers" .multiple=${true} .items=${[...(view.image?.layers??[])].reverse().map(l=>({key:l.id,label:(l.kind==='text'?'Text · ':'Image · ')+l.name+(l.visible?' · visible':' · hidden')+(l.locked?' · locked':'' )}))} @en-change=${(e:Event)=>{const h=e.currentTarget as EnTree;this.adapter.settled(e,()=>[...h.selectedKeys],ids=>{performance.clearMarks('ie.intent.Select layers');performance.mark('ie.intent.Select layers',{startTime:e.timeStamp});editor.select(ids);});}}></en-tree>
    ${!d?html`<p class="empty">No layers yet. Import an image to begin.</p>`:nothing}
    <en-stack class="actions" direction="horizontal" wrap gap="small"><en-button variant="secondary" ?disabled=${locked||!f} @click=${(e:Event)=>this.action(e,'Duplicate layer',()=>this.inspectorLayerAction('duplicate',fieldId))}>Duplicate</en-button><en-button variant="ghost" ?disabled=${locked||!f} @click=${(e:Event)=>this.action(e,'Delete layer',()=>this.inspectorLayerAction('delete',fieldId))}>Delete layer</en-button><en-button variant="secondary" ?disabled=${locked||!f} @click=${(e:Event)=>this.action(e,'Move layer up',()=>this.inspectorLayerAction('up',fieldId))}>Move up</en-button><en-button variant="secondary" ?disabled=${locked||!f} @click=${(e:Event)=>this.action(e,'Move layer down',()=>this.inspectorLayerAction('down',fieldId))}>Move down</en-button></en-stack>
    </en-tab-panel><en-tab-panel slot="panel" value="composition">${this.semantic.inspector()}</en-tab-panel></en-tabs>
    <section class="properties" ?hidden=${this.structure!=='layers'}><h2>Layer properties</h2>${f?.layer.kind==='text'?html`<en-button id="edit-selected-text" ?disabled=${locked} @click=${(e:Event)=>{const trigger=e.currentTarget as HTMLElement;this.action(e,'Edit text',()=>{const layer=editor.view.image?.layers.find(layer=>layer.id===this.fields?.layer.id);return this.textEditing.begin(trigger,layer);});}}>Edit text</en-button><en-button variant="secondary" ?disabled=${locked||f.layer.locked} @click=${(e:Event)=>this.action(e,'Review text raster copy',()=>this.reviewTextRaster())}>Rasterize text copy…</en-button>`:nothing}${f?html`<p>${f.dirty?'Unapplied inspector draft':'Accepted layer'} · base revision ${f.document.revision}</p><en-text-field label="Layer name" data-field="name" @en-input=${this.input} @en-change=${this.changed}></en-text-field>${this.number('opacity','Opacity (0–1)',f.values.opacity,'opacity')}
    <en-slider label="Opacity preview" .min=${0} .max=${1} .step=${.01} .defaultValue=${Number(f.values.opacity)||0} @en-change=${(e:Event)=>{const host=e.currentTarget as EnSlider;this.adapter.settled(e,()=>host.value,v=>{try{this.editInspector('opacity',String(v));}catch(error){editor.fail(error);return;}this.adapter.write(this.querySelector<EnNumberField>('#opacity')!,'value',String(v));});}}></en-slider>
    ${(['visible','locked'] as const).map(key=>html`<en-switch data-field=${key} label=${key==='visible'?'Visible':'Locked'} @en-change=${(e:Event)=>{const host=e.currentTarget as EnSwitch;this.adapter.settled(e,()=>host.checked,v=>{try{this.editInspector(key,v);}catch(error){editor.fail(error);}});}}></en-switch>`) }
    <en-button variant="secondary" ?disabled=${locked} @click=${(e:Event)=>this.action(e,'Change layer lock',()=>this.inspectorLayerAction('lock',fieldId))}>${f.layer.locked?'Unlock layer':'Lock layer'}</en-button><en-stack class="actions" direction="horizontal" wrap gap="small"><en-button ?disabled=${locked||this.composition||f.layer.locked} @click=${(e:Event)=>this.action(e,'Apply properties',()=>this.applyFields('properties'))}>Apply properties</en-button><en-button variant="ghost" @click=${(e:Event)=>this.adapter.action(e,()=>this.resetFields())}>Cancel changes</en-button></en-stack>
    <en-textarea label="Layer appearance description" data-field="appearance" @en-input=${this.input} @en-change=${this.changed}></en-textarea><en-button variant="secondary" ?disabled=${locked||f.layer.locked} @click=${(e:Event)=>this.action(e,'Apply appearance description',()=>this.applyFields('appearance'))}>Apply appearance description</en-button>${this.semantic.linked(f.layer.id).length?html`<en-button variant="secondary" @click=${(e:Event)=>this.adapter.action(e,()=>{const id=this.fields?.layer.id;if(id)this.semantic.reveal(id);})}>Reveal linked semantic element</en-button>`:nothing}<h2>Transform</h2><p class="muted">${FRIENDLY_TRANSFORM_HELP}</p><div class="property-grid">${this.number('transform-x','X (document px)',f.values.x,'x')}${this.number('transform-y','Y (document px)',f.values.y,'y')}${this.friendlyNumber('width','Width along layer axis (px)')}${this.friendlyNumber('height','Height along layer axis (px)')}${this.friendlyNumber('rotation','Rotation (degrees clockwise)')}</div>${!friendlyInspectorAvailable(f)?html`<p>${this.inspectorSizeAbort?'Loading layer dimensions…':f.intrinsic.status==='ready'?'Correct the advanced matrix to enable width, height and rotation.':'Layer dimensions are unavailable. The advanced matrix remains editable.'}</p>${!this.inspectorSizeAbort&&f.intrinsic.status!=='ready'?html`<en-button variant="secondary" @click=${(e:Event)=>this.action(e,'Read layer dimensions',async()=>this.loadInspectorDimensions(true))}>Retry layer dimensions</en-button>`:nothing}`:nothing}<en-accordion-item label="Advanced affine matrix"><p>X/Y above are the translation coefficients. A/B/C/D retain the complete linear transform.</p><div class="property-grid">${(['a','b','c','d'] as const).map(k=>this.number('transform-'+k,k.toUpperCase(),f.values[k],k))}</div></en-accordion-item><en-button ?disabled=${locked||f.layer.locked} @click=${(e:Event)=>this.action(e,'Apply transform',()=>this.applyFields('transform'))}>Apply transform</en-button><en-button variant="secondary" ?disabled=${locked||f.layer.locked||f.layer.kind==='text'} @click=${()=>this.showPanel('resample')}>Resample image…</en-button>`:html`<p>Select a layer to inspect it.</p>`}
    ${this.authoring.render()}<en-stack class="actions" direction="horizontal" wrap gap="small"><en-button variant="secondary" ?disabled=${locked||!d} @click=${()=>this.showPanel('bounds')}>Canvas bounds…</en-button><en-button variant="secondary" ?disabled=${locked||!d?.image} @click=${()=>this.showPanel('flatten')}>Flatten copy…</en-button></en-stack></section>`,this.inspectorNode,{host:this,creationScope:scope.creationScope});
  }
  private async updateLayout(){
    if(this.composition)return;
    let active:Element|null=document.activeElement;while(active?.shadowRoot?.activeElement)active=active.shadowRoot.activeElement;
    const focus=active instanceof HTMLElement?active:null;
    const selection=active instanceof HTMLInputElement||active instanceof HTMLTextAreaElement?[active.selectionStart,active.selectionEnd,active.selectionDirection] as const:null;
    const inRequest=!!active&&this.requestNode.contains(document.activeElement),inInspector=!!active&&this.inspectorNode.contains(document.activeElement);
    const narrow=matchMedia('(max-width:1100px)').matches,extreme=matchMedia('(max-width:720px)').matches;
    if(narrow&&!extreme)await this.panels();
    if(this.composition)return;
    this.narrow=narrow;this.extreme=extreme;
    this.requestOpen ||= inRequest;this.inspectorOpen ||= inInspector;
    this.requestUpdate();await this.updateComplete;
    if(this.drawerMode){const drawer=this.querySelector<EnDialog>(inRequest?'#request-drawer':'#inspector-drawer');if(inRequest||inInspector)await drawer?.updateComplete;}
    if(focus?.isConnected&&(inRequest||inInspector)){focus.focus({preventScroll:true});if(selection&&selection[0]!==null)(focus as HTMLInputElement).setSelectionRange(selection[0],selection[1],selection[2]??undefined);}
  }
  private async togglePane(kind:'request'|'inspector',force?:boolean){
    if(this.narrow&&!this.extreme)await this.panels();
    if(kind==='request')this.requestOpen=force??!this.requestOpen;else this.inspectorOpen=force??!this.inspectorOpen;
    this.requestUpdate();await this.updateComplete;
  }
  private async chooseTool(name:string,trigger:HTMLElement){
    this.endTemporaryPan();
    if(this.canvasEditingBlocked||!['Pan','Zoom'].includes(name)&&(!editor.view.ready||editor.view.busy||!editor.view.document))return;
    this.tool=name;this.authoring.choose(name);this.requestUpdate();
    if(name==='Text')await editor.run('Open text editor',()=>this.textEditing.begin(trigger));
    if(name==='Crop')this.showPanel('bounds');
    if(['Select','Mask','Sample','Move'].includes(name))await this.togglePane('inspector',true);
  }
  #searchableCommands():readonly ShellCommand[]{
    const view=editor.view,d=view.document;
    const unavailable=!view.ready?'Connect to the local editor first.':view.busy?'Wait for the current local operation to finish.':this.canvasEditingBlocked?'Return to the accepted document and wait for canvas recovery.':'';
    const documentReason=unavailable||(!d?'Open or create a document first.':'');
    const run=(label:string,work:()=>Promise<void>)=>()=>editor.run(label,work),tool=(name:string)=>()=>this.chooseTool(name,this.querySelector<HTMLElement>('#command-search-trigger')!);
    return [
      {id:'new-document',label:'New document',description:'Choose a name, dimensions and transparent or solid background.',disabledReason:unavailable||(view.pendingCreate?'Check and retry the unresolved original document creation first.':''),run:()=>this.showPanel('new')},
      {id:'open-document',label:'Open document',description:'Open a retained local document or a portable project.',disabledReason:unavailable,run:()=>this.showPanel('open')},
      {id:'storage-library',label:'Storage library',description:'Inspect retained assets, references and recomputable preview storage.',disabledReason:!view.ready?'Connect to the local editor first.':view.busy?'Wait for the current local operation to finish.':'',run:()=>this.#showStorage()},
      {id:'import-image',label:'Import image',description:'Choose an image and review its conversion before Apply.',disabledReason:unavailable,run:()=>this.showPanel('import')},
      {id:'save-checkpoint',label:'Save checkpoint',description:'Save a checkpoint of the current accepted document.',disabledReason:documentReason,run:run('Save checkpoint',()=>this.leaf({type:'SaveCheckpoint',name:'Checkpoint '+new Date().toLocaleString()}))},
      {id:'save-copy',label:'Save copy',description:'Prepare a full-history portable copy for an explicit destination.',disabledReason:documentReason,run:()=>this.showPanel('copy')},
      {id:'export-image',label:'Export image',description:'Review the image scope, output dimensions and format.',disabledReason:documentReason,run:()=>this.#showExport()},
      {id:'close-document',label:!d&&editor.documentResources.snapshot.failed?'Retry close':'Close document',description:'Close the document and finish releasing its local resources.',disabledReason:unavailable||(!d&&!editor.documentResources.snapshot.failed?'Open or create a document first.':'')||(this.composition||this.textEditing.composing?'Finish composing the current field first.':''),run:run('Close document',()=>this.closeDocument())},
      {id:'undo',label:'Undo',description:'Undo the current accepted document edit.',disabledReason:documentReason||this.undoReason(),run:()=>this.historyAction('Undo')},
      {id:'redo',label:'Redo',description:'Restore the retained redo state.',disabledReason:documentReason||(!d?.redo?'There is no retained redo state.':''),run:()=>this.historyAction('Redo')},
      {id:'history-first',label:'First history page',description:'Navigate to the first page of retained document history.',disabledReason:documentReason,run:run('Read first history page',()=>editor.historyPage('history'))},
      {id:'canvas-bounds',label:'Canvas bounds',description:'Review a canvas resize or crop using numeric fields.',disabledReason:documentReason,run:()=>this.showPanel('bounds')},
      {id:'fit-canvas',label:'Fit canvas',description:'Fit the current document in its viewport.',disabledReason:documentReason,run:()=>this.fit()},
      {id:'actual-size',label:'View at 100%',description:'Set the canvas zoom to one display pixel per document pixel.',disabledReason:documentReason,run:()=>this.setZoom(1)},
      {id:'zoom-in',label:'Zoom in',description:'Increase the canvas zoom by ten percent.',disabledReason:unavailable,run:()=>this.setZoom(this.zoom*1.1)},
      {id:'zoom-out',label:'Zoom out',description:'Decrease the canvas zoom using the minus-key step.',disabledReason:unavailable,run:()=>this.setZoom(this.zoom/1.1)},
      {id:'move-tool',label:'Move tool',description:'Choose the Move tool and open numeric layer transforms.',disabledReason:documentReason,run:tool('Move')},
      {id:'text-tool',label:'Text tool',description:'Open a native text draft with explicit Apply.',disabledReason:documentReason,run:tool('Text')},
      {id:'selection-tool',label:'Selection tool',description:'Choose the Select tool and open numeric selection controls.',disabledReason:documentReason,run:tool('Select')},
      {id:'mask-tool',label:'Mask tool',description:'Choose the Mask tool and open editable numeric mask controls.',disabledReason:documentReason,run:tool('Mask')},
      {id:'sample-tool',label:'Sample tool',description:'Choose the Sample tool and open numeric pixel sampling.',disabledReason:documentReason,run:tool('Sample')},
      {id:'pan-tool',label:'Pan tool',description:'Choose Pan, the same tool as the H canvas shortcut.',disabledReason:unavailable,run:tool('Pan')},
      {id:'request-panel',label:'Show request panel',description:'Focus the operation, prompt and explicit input controls.',disabledReason:'',run:()=>this.requestDetails('request')},
      {id:'layers-panel',label:'Show layers panel',description:'Open the layers and properties panel.',disabledReason:'',run:()=>this.togglePane('inspector',true)},
      {id:'help',label:'Editor help',description:'Read visible keyboard commands and recovery guidance.',disabledReason:'',run:async()=>{await this.panels();this.querySelector<EnDialog>('#help-drawer')?.show();}},
    ];
  }
  private async requestDetails(id:string){const documentId=editor.view.document?.id,owner=editor.draftOwner;await this.togglePane('request',true);if(owner!==editor.draftOwner||documentId!==editor.view.document?.id)return;const target=this.querySelector<HTMLElement>('#'+id);if(target){if(!target.hasAttribute('tabindex'))target.tabIndex=-1;target.scrollIntoView({block:'nearest'});target.focus();}}
  protected render(){if(!this.isConnected)return nothing;const {view,session}=this.read.snapshot;const renderModels:RenderModel[]=[editor.renderViewMetadata(view),...editor.renderViewModels(view.download,view.image,view.save,view.document,view.documents[0],view.history.length?view.history:undefined,view.checkpoints.length?view.checkpoints:undefined,view.review,view.uiChoices.length?view.uiChoices:undefined,view.stages.length?view.stages:undefined,view.pending.length?view.pending:undefined),...editor.renderUI(),...connection.renderCapabilities(session.capabilities)];for(const model of [this.fieldsOwner,this.rasterizeOwner])if(model)renderModels.push({value:model.value,pin:()=>model.pin()});this.renderModelOwners.begin(renderModels);const d=view.document,f=this.fields;const locked=!view.ready||view.busy||this.canvasEditingBlocked,destinationWrite=this.destinationWrite;editor.navigationControlsRendered(d,!locked&&!!d);this.renderPanes();
    return html`
    <div class="skip-links">${[['request','Request'],['canvas','Canvas'],['inspector','Layers'],['results','History']].map(([id,label])=>html`<en-link href=${'#'+id} @click=${async(e:Event)=>{e.preventDefault();if(id==='request'||id==='inspector')await this.togglePane(id,true);this.requestUpdate();await this.updateComplete;this.querySelector<HTMLElement>('#'+id)?.focus();const u=new URL(location.href);u.hash=id;history.replaceState(history.state,'',u);}}>Go to ${label}</en-link>`)}</div>
    <header class="document-bar"><div class="identity"><span class="brand-mark"><en-icon name="sparkles"></en-icon></span><div><strong>${wordmark()}</strong><span class="document-name">${d?`${documentDisplayName(d)} · ${d.width} × ${d.height} · revision ${d.revision}`:'No document open'}</span></div></div>
    <en-toolbar label="Document actions" keyboard-navigation="tab"><en-button variant="ghost" ?disabled=${locked} @click=${()=>this.showPanel('new')}>New</en-button><en-button variant="ghost" ?disabled=${locked} @click=${()=>this.showPanel('open')}>Open</en-button><en-button id="storage-library-trigger" variant="ghost" ?disabled=${!view.ready||view.busy} @click=${(event:Event)=>this.#showStorage(event)}>Storage library</en-button><en-button id="close-document" variant="ghost" ?disabled=${!view.ready||view.busy||(!d&&!editor.documentResources.snapshot.failed)||this.composition||this.textEditing.composing} @click=${(e:Event)=>this.action(e,'Close document',()=>this.closeDocument())}>${!d&&editor.documentResources.snapshot.failed?'Retry close':'Close document'}</en-button><en-button variant="ghost" ?disabled=${locked} @click=${()=>this.showPanel('import')}>Import image</en-button><en-button variant="ghost" ?disabled=${locked||!!this.undoReason()} @click=${(e:Event)=>this.adapter.action(e,()=>this.historyAction('Undo'))}>Undo</en-button><en-button variant="ghost" ?disabled=${locked||!d?.redo} @click=${(e:Event)=>this.adapter.action(e,()=>this.historyAction('Redo'))}>Redo</en-button></en-toolbar>
    <div class="bar-end"><en-select label="Appearance" .value=${document.documentElement.dataset.enAppearance??'auto'} @en-change=${(e:Event)=>{const host=e.currentTarget as EnSelect;this.adapter.settled(e,()=>host.value,value=>{if(isAppearance(value)){setAppearance(value);this.requestUpdate();}});}}><en-select-option value="auto">System</en-select-option><en-select-option value="light">Light</en-select-option><en-select-option value="dark">Dark</en-select-option></en-select><en-select label="Density" .value=${currentDensity()} @en-change=${(e:Event)=>{const host=e.currentTarget as EnSelect;this.adapter.settled(e,()=>host.value,value=>{if(isDensity(value)){setDensity(value);this.requestUpdate();}});}}><en-select-option value="comfortable">Comfortable</en-select-option><en-select-option value="compact">Compact</en-select-option><en-select-option value="spacious">Spacious</en-select-option></en-select><en-button id="session-trigger" variant="ghost">${statusName[session.connection]}</en-button><en-popover for="session-trigger" label="Local connection"><p>${session.message}</p><p>Provider configuration and per-attempt dispatch approval are in the Request panel.</p><en-stack class="actions" direction="horizontal" wrap gap="small"><en-button variant="secondary" ?disabled=${session.busy} @click=${()=>{void this.startConnection(undefined,true).catch(()=>{});}}>Check connection</en-button><en-button variant="secondary" ?disabled=${this.connectionRestoring||session.busy||session.connection!=='paired'} @click=${()=>this.sessionAction('renew')}>Renew connection</en-button><en-button variant="ghost" ?disabled=${this.connectionRestoring||session.busy||session.connection!=='paired'} @click=${()=>this.sessionAction('revoke')}>Disconnect</en-button></en-stack></en-popover>
    <en-button variant="secondary" ?disabled=${locked||!d} @click=${()=>this.showPanel('copy')}>Save copy</en-button><en-button ?disabled=${locked||!d} @click=${()=>this.#showExport()}>Export image</en-button><en-button ?disabled=${this.connectionRestoring} id="command-search-trigger" variant="ghost" @click=${(event:Event)=>{const opener=event.currentTarget as HTMLElement;this.adapter.action(event,()=>void this.commandSearch.open(opener).catch(error=>editor.fail(error)));}}>Command search</en-button><en-button id="help-trigger" variant="ghost" aria-describedby="help-description" @click=${()=>void this.panels().then(()=>this.querySelector<EnDialog>('#help-drawer')?.show())}>Help</en-button><span id="help-description" class="help-description">Shortcuts and recovery</span></div></header>
    ${session.connection!=='paired'?html`<section class="connection-panel"><p>${session.message}</p><en-button variant="secondary" ?disabled=${session.busy} @click=${()=>{void this.startConnection(undefined,true).catch(()=>{});}}>Check connection</en-button></section>`:nothing}
    <section class="operation-status" aria-label="Operation status" tabindex="0" @keydown=${this.statusNavigation} aria-busy=${view.busy}><en-alert class="operation-message" announcement="polite">${view.message}</en-alert>${view.recovery?html`<en-alert variant="warning">${view.recovery}</en-alert><en-button @click=${(e:Event)=>this.action(e,'Reconnect',async()=>{const generation=this.connectionGeneration;await shellRetirement?.retry();if(!this.isConnected||generation!==this.connectionGeneration||generation!==shellConnectionGeneration)return;this.repaintKey='';await editor.connect();})}>Reconnect</en-button>`:nothing}${view.error&&!this.panel&&!view.review?html`<en-validation-summary heading="Action needs attention" .items=${[{target:'inspector',message:view.error}]} @en-action=${(e:Event)=>{e.preventDefault();this.inspectorOpen=true;this.requestUpdate();void this.updateComplete.then(()=>this.querySelector<HTMLElement>('#inspector')?.focus());}}></en-validation-summary>`:nothing}
    ${view.uiPending.map(id=>html`<p>UI change receipt unknown. Current draft text is retained.</p><en-button ?disabled=${view.busy||!view.ready} @click=${(e:Event)=>this.action(e,'Retry original UI draft',()=>editor.retryDraft(id))}>Retry original draft delivery</en-button>`)}${view.pending.length||view.pendingPrevious||view.pendingNext?html`<div role="group" aria-label="Pending operations"><p role="status">${view.pending.length} pending operations on this page. Original requests remain saved locally.</p><en-stack class="actions" direction="horizontal" wrap gap="small">${([['first','First pending page'],['previous','Previous pending page'],['next','Next pending page']] as const).map(([direction,label])=>html`<en-button variant="secondary" ?disabled=${view.busy||!view.ready||(direction==='next'?view.pendingNext:view.pendingPrevious)===null} @click=${(e:Event)=>this.action(e,label,()=>editor.listPending(direction))}>${label}</en-button>`)}</en-stack>${view.pending.map(p=>{const commandId=p.request.command.commandId;return html`<en-card class="pending"><span>${p.label} · ${p.result?.kind==='pending'?p.result.phase:'receipt unknown'}</span><en-button variant="secondary" ?disabled=${view.busy||!view.ready} @click=${(e:Event)=>this.action(e,'Retry original operation',async()=>{const result=await editor.ownedRetry(commandId);try{/* The shell consumes only successful settlement. */}finally{result.release();}})}>Check and retry original</en-button></en-card>`;})}</div>`:nothing}</section>
    <div class="mobile-openers"><en-button variant="secondary" id="request-opener" @click=${()=>void this.togglePane('request')}>${this.requestOpen?'Hide request':'Show request'}</en-button><en-button variant="secondary" id="inspector-opener" @click=${()=>void this.togglePane('inspector')}>${this.inspectorOpen?'Hide layers':'Show layers'}</en-button></div>
    <main class="workspace" aria-label="Image editor"><aside class="tool-rail" ?inert=${this.canvasEditingBlocked}><en-toolbar label="Canvas tools" orientation=${this.narrow?'horizontal':'vertical'}>${[['Move','move'],['Text','text'],['Select','select'],['Mask','mask'],['Crop','crop'],['Sample','sample'],['Pan','hand'],['Zoom','zoom']].map(([name,glyph])=>html`<en-button class="tool" variant="ghost" ?disabled=${!(['Pan','Zoom'].includes(name)||!locked&&!!d)} aria-pressed=${this.tool===name} aria-keyshortcuts=${this.singleKeyShortcuts?({Move:"V",Select:"M",Mask:"B",Pan:"H",Sample:"I",Crop:"C"} as Record<string,string>)[name]??nothing:nothing} @click=${(e:Event)=>{const trigger=e.currentTarget as HTMLElement;this.adapter.action(e,()=>{void this.chooseTool(name,trigger).catch(error=>editor.fail(error));});}}><span slot="prefix" aria-hidden="true">${icon(glyph)}</span><span slot="label">${name}</span></en-button>`)}</en-toolbar></aside>
    <div class="outer-grid">${this.drawerMode?nothing:this.requestNode}
    <en-splitter id="left-divider" label="Request panel width" orientation="vertical" .value=${24} .min=${18} .max=${38} @en-change=${this.split} @pointerup=${this.persistSplit} @keyup=${this.persistSplit}></en-splitter>
    <div class="inner-grid"><section id="canvas" class="canvas-panel" tabindex="0" aria-label="Canvas · image import drop target" aria-describedby="canvas-document-name" @paste=${this.paste} @dragover=${(e:DragEvent)=>{if(e.dataTransfer?.types.includes('Files'))e.preventDefault();}} @drop=${this.drop}><en-toolbar class="canvas-toolbar" label="View controls" keyboard-navigation="tab"><span>${this.canvas?.ownership.contextLost?'Canvas unavailable · waiting for graphics recovery':this.canvas?.ownership.contextRestoring?'Restoring canvas from retained pixels':this.reviewedCanvasPreview?'Reviewed result preview · read-only · not adopted':this.textEditing.active?'Text draft':this.temporaryPanCurrent()?'Temporary pan (Space)':this.tool} · ${d?'retained raster':'no document'}</span><en-number-field id="zoom" label="Zoom percentage" .value=${String(Math.round(this.zoom*100))} .min=${0.01} .step=${10} @en-change=${(e:Event)=>{const h=e.currentTarget as EnNumberField;this.adapter.settled(e,()=>h.value,v=>{performance.clearMarks('ie.intent.View zoom');performance.mark('ie.intent.View zoom',{startTime:e.timeStamp});this.setZoom(Number(v)/100);});}}></en-number-field><en-button variant="ghost" @click=${(e:Event)=>this.adapter.action(e,()=>this.fit())} ?disabled=${!d}>Fit</en-button><en-button variant="ghost" @click=${(e:Event)=>this.adapter.action(e,()=>this.setZoom(1))} ?disabled=${!d}>100%</en-button></en-toolbar>
    <div class="canvas-viewport"><canvas width="0" height="0" aria-label="Document raster preview" aria-describedby="canvas-document-name" @dblclick=${()=>{if(this.canvasEditingBlocked)return;const layer=editor.view.image?.layers.find(l=>l.id===editor.view.selected[0]);if(layer?.kind==='text')void editor.run('Edit text',()=>this.textEditing.begin(this.querySelector('#canvas')!,layer));}} @pointerdown=${(e:PointerEvent)=>{if(this.temporaryPan&&!this.temporaryPanCurrent()){this.endTemporaryPan();return;}if(this.canvasEditingBlocked)return;if(!this.temporaryPanCurrent()&&this.semantic.pointerDown(e,this.canvas!.point(e.clientX,e.clientY,this.zoom,this.pan.x,this.pan.y)))return;if(!this.temporaryPanCurrent()&&this.authoring.pointerDown(e,this.canvas!.point(e.clientX,e.clientY,this.zoom,this.pan.x,this.pan.y)))return;if(e.button!==0)return;this.gesture={id:e.pointerId,x:e.clientX,y:e.clientY,oldX:this.pan.x,oldY:this.pan.y,temporary:this.temporaryPanCurrent()};(e.target as HTMLElement).setPointerCapture(e.pointerId);}} @pointermove=${(e:PointerEvent)=>{if(this.temporaryPan&&!this.temporaryPanCurrent()){this.endTemporaryPan();return;}if(this.canvasEditingBlocked)return;if(!this.gesture?.temporary&&this.semantic.pointerMove(e,this.canvas!.point(e.clientX,e.clientY,this.zoom,this.pan.x,this.pan.y)))return;if(!this.gesture?.temporary&&this.authoring.pointerMove(e,this.canvas!.point(e.clientX,e.clientY,this.zoom,this.pan.x,this.pan.y)))return;const g=this.gesture;if(!g||g.id!==e.pointerId)return;performance.clearMarks('ie.intent.Pan');performance.mark('ie.intent.Pan',{startTime:e.timeStamp});this.pan={x:g.oldX+e.clientX-g.x,y:g.oldY+e.clientY-g.y};this.draw();}} @pointerup=${(e:PointerEvent)=>{if(this.temporaryPan&&!this.temporaryPanCurrent()){this.endTemporaryPan();return;}if(this.canvasEditingBlocked)return;if(!this.gesture?.temporary&&this.semantic.pointerUp(e,this.canvas!.point(e.clientX,e.clientY,this.zoom,this.pan.x,this.pan.y)))return;if(!this.gesture?.temporary&&this.authoring.pointerUp(e,this.canvas!.point(e.clientX,e.clientY,this.zoom,this.pan.x,this.pan.y)))return;this.gesture=null;void editor.preferences({viewport:{...this.pan,zoom:this.zoom}}).catch(e=>editor.fail(e));}} @pointercancel=${()=>{this.semantic.cancelDrag();this.authoring.cancelGesture();const g=this.gesture;if(g)this.pan={x:g.oldX,y:g.oldY};this.gesture=null;this.draw();}}></canvas>
    ${!d?html`<div class="canvas-empty"><h2>A little room to create.</h2><p>Choose or drop images, then select the reviewed subset to import.</p><en-file-upload label="Import an image" choose-label="Choose images" multiple accept="image/png,image/jpeg,image/webp" ?disabled=${locked} @en-change=${(e:Event)=>this.file(e,'image')}></en-file-upload><p>PNG, JPEG or static WebP. Original bytes are retained.</p></div>`:nothing}</div><div class="canvas-caption"><span id="canvas-document-name">${d?`${documentDisplayName(d)} · ${d.width} × ${d.height} pixels · ${view.selected.length} selected`:'No image accepted'}</span><span>Paste an image here to review</span></div><en-toolbar class="pan-fields" label="Numeric view controls" keyboard-navigation="tab">${this.number('pan-x','View X (px)',String(this.pan.x))}${this.number('pan-y','View Y (px)',String(this.pan.y))}<en-button variant="secondary" @click=${(e:Event)=>this.adapter.action(e,()=>{this.pan={x:this.numeric('pan-x'),y:this.numeric('pan-y')};this.draw();void editor.preferences({viewport:{...this.pan,zoom:this.zoom}}).catch(e=>editor.fail(e));})}>Apply view</en-button></en-toolbar></section>
    <en-splitter id="right-divider" label="Canvas and inspector width" orientation="vertical" .value=${73} .min=${45} .max=${80} @en-change=${this.split} @pointerup=${this.persistSplit} @keyup=${this.persistSplit}></en-splitter>
    ${this.drawerMode?nothing:this.inspectorNode}</div></div></main>
    ${this.textEditing.render()}${this.deletionFlow.render()}
    <section id="results" class="results-tray" tabindex="-1" aria-label="Activity"><en-accordion-item label="Activity" .open=${true}><en-tabs label="Activity views" value="history"><en-tab slot="tab" value="results">Results</en-tab><en-tab slot="tab" value="jobs">Jobs</en-tab><en-tab slot="tab" value="history">History</en-tab><en-tab-panel slot="panel" value="results"><p>Retained results include safety status, exact provenance, previews and deliberate adoption.</p><en-button ?disabled=${locked||!d} @click=${(e:Event)=>this.action(e,'Inspect retained results',()=>this.requestDetails('request-candidate-history'))}>Inspect retained results</en-button></en-tab-panel><en-tab-panel slot="panel" value="jobs"><p>The durable queue records submissions, request limits, cancellation and recovery.</p><en-button ?disabled=${locked||!d} @click=${(e:Event)=>this.action(e,'Inspect durable jobs',()=>this.requestDetails('durable-queue'))}>Inspect durable jobs</en-button></en-tab-panel><en-tab-panel slot="panel" value="history"><en-activity-feed label="Retained document history" mode="paginated" .pageSize=${20} .items=${view.history.map(n=>({key:n.id,author:n.kind==='image-edit'?n.operation:'Document created',text:(n.kind==='image-edit'?n.operation:'Creation')+' · '+n.id+(n.id===d?.historyHead?' · current':''),label:'History '+n.id}))} .renderItem=${this.historyItem}></en-activity-feed>
    ${d?html`<en-button variant="ghost" @click=${(e:Event)=>this.action(e,'Read first history page',()=>editor.historyPage('history'))}>First history page</en-button>`:nothing}${view.historyNext?html`<en-button variant="secondary" @click=${(e:Event)=>this.action(e,'Read next history page',()=>editor.historyPage('history',editor.view.historyNext))}>Next history page</en-button>`:nothing}
    <en-stack class="actions" direction="horizontal" wrap gap="small"><en-text-field id="checkpoint-name" label="Checkpoint name" value="My checkpoint"></en-text-field><en-button ?disabled=${locked||!d} @click=${(e:Event)=>this.action(e,'Save checkpoint',()=>this.leaf({type:'SaveCheckpoint',name:(this.querySelector('#checkpoint-name') as EnNumberField).value}))}>Save checkpoint</en-button></en-stack><p>Checkpoints retain their full history.</p>${view.checkpoints.map(checkpoint=>{const checkpointId=checkpoint.id;return html`<en-button variant="secondary" ?disabled=${locked||!checkpoint.image} @click=${(e:Event)=>this.action(e,'Open checkpoint',async()=>{const current=editor.view.checkpoints.find(row=>row.id===checkpointId);if(current)await editor.openCheckpoint(current);})}>Open checkpoint: ${checkpoint.name}</en-button>`;})}${view.checkpointNext?html`<en-button variant="secondary" @click=${(e:Event)=>this.action(e,'Read next checkpoints',()=>editor.historyPage('checkpoints',editor.view.checkpointNext))}>Next checkpoint page</en-button>`:nothing}</en-tab-panel></en-tabs></en-accordion-item></section>
    ${view.download?html`<en-card class="download-panel" role="region" aria-label="Prepared file"><p>${view.download.recovery?'Incomplete sanitized recovery copy':view.download.kind==='copy'?'Full-history copy':view.download.mediaType==='image/jpeg'?'Reviewed JPEG':'PNG export'} · ${view.download.bytes} bytes · captured revision ${view.download.revision}${view.download.documentId!==d?.id||view.download.revision!==d?.revision?' (earlier document state)':''} · ${view.download.status==='confirmed'?'Saved to destination':view.download.status==='unconfirmed'?'Download initiated — destination unconfirmed':view.download.status==='writing'?'Writing destination…':view.download.status==='failed'?'Destination write failed; local bytes retained':'Ready — destination unconfirmed'}</p>${view.download.recovery?html`<p>Inspection only: current safe content with omissions. History, drafts, jobs and live authority are excluded. Exact originals remain local; this file cannot reopen an editable document.</p>`:nothing}<en-button ?disabled=${view.busy} @click=${(e:Event)=>this.adapter.action(e,()=>void this.download())}>${typeof (window as unknown as {showSaveFilePicker?:unknown}).showSaveFilePicker==='function'?'Choose destination and save':'Download prepared file'}</en-button>${destinationWrite?html`<en-button variant="secondary" ?disabled=${destinationWrite.committing} @click=${(event:Event)=>{this.adapter.action(event,()=>{if(this.destinationWrite===destinationWrite&&!destinationWrite.committing)destinationWrite.controller.abort();});}}>Cancel destination write</en-button><p>${destinationWrite.committing?'Committing the destination file; cancellation is no longer available.':'Cancel stops the pending write and keeps prepared local bytes.'}</p>`:nothing}</en-card>`:nothing}
    <footer class="status-bar"><span>${view.busy?'Operation pending':view.ready?'Accepted edits saved locally':'Local authority unavailable'} · ${view.drafts||'No local draft change'}</span><span>${!d?'No document checkpoint':view.save?.documentChangedSinceCheckpoint?'Checkpoint outdated':'Checkpoint content current'} · ${!d?'No portable copy':view.save?.bundleOutdated?'Portable copy outdated':'Copy state current'} · External destination ${view.download?.status==='confirmed'?'confirmed for prepared file':'unconfirmed'}</span></footer>
    ${this.panelReady?html`<en-drawer id="request-drawer" label="Request panel" placement="start" .open=${this.drawerMode&&this.requestOpen} @en-change=${(e:Event)=>{const h=e.currentTarget as EnDialog;this.adapter.settled(e,()=>h.open,v=>{this.requestOpen=v;this.requestUpdate();});}}>${this.drawerMode?this.requestNode:nothing}</en-drawer><en-drawer id="inspector-drawer" label="Layers and properties panel" placement="end" .open=${this.drawerMode&&this.inspectorOpen} @en-change=${(e:Event)=>{const h=e.currentTarget as EnDialog;this.adapter.settled(e,()=>h.open,v=>{this.inspectorOpen=v;this.requestUpdate();});}}>${this.drawerMode?this.inspectorNode:nothing}</en-drawer>`:nothing}
    ${this.panelReady?this.dialogs():nothing}${this.panelReady?this.semantic.dialog():nothing}${this.panelReady?this.commandSearch.render():nothing}
    ${new URL(location.href).searchParams.has('progress-report')?html`<en-link class="report-return" href=${__PROGRESS_REPORT_URL__}>Progress Report ↗</en-link>`:nothing}`;
  }
  private dialogs(){const view=editor.view,d=view.document,r=view.review,recoveryOwner=this.recoveryCopyOwner();const title=this.panel==='new'?'New document':this.panel==='open'?'Open document':this.panel==='storage'?'Storage library':this.panel==='import'?'Import image':this.panel==='resample'?'Resample intrinsic image':this.panel==='flatten'?'Flatten a copy':this.panel==='copy'?'Save project copy':this.panel==='rasterize'?'Review text raster copy':this.panel==='export'?'Export image':'Canvas bounds';const close=(e:Event)=>{const host=e.currentTarget as EnDialog,panel=this.panel,epoch=this.copyPanelEpoch;this.adapter.settled(e,()=>host.open,open=>{if(!open&&this.panel===panel&&this.copyPanelEpoch===epoch)this.closePanel();});};
    return html`<en-drawer id="help-drawer" label="Editor help" for="help-trigger"><p>Import → review → Apply → edit → Undo → Save copy → reopen → Export image.</p><p>Cmd/Ctrl+S saves a checkpoint; Shift+Cmd/Ctrl+S prepares a full-history copy; Cmd/Ctrl+O opens a local document or portable file. Native fields keep their own undo and clipboard shortcuts. Focus Request draft keyboard actions or the immutable request review and use Cmd/Ctrl+Enter to prepare or revisit the exact review. Only an already explicitly accepted review is enqueued; this shortcut never accepts a review or authorizes a paid attempt.</p><p>Canvas or tool rail: V Move, M Select, B Mask, H Pan, I Sample, C Crop. Canvas: hold Space to pan temporarily, +/− zoom, 0 Fit. Delete removes one current unlocked selected layer only from canvas or layer-list focus; Undo restores it. With Zoom selected, click to zoom in at the pointer; Alt-click to zoom out. Dragging does not change the view. Use numeric view fields without a pointer. Conversion, resample and flatten review require Apply.</p><en-switch id="single-key-shortcuts" label="Enable single-key shortcuts" .checked=${this.singleKeyShortcuts} @en-change=${(event:Event)=>{const control=event.currentTarget as EnSwitch;this.adapter.settled(event,()=>control.checked,enabled=>{this.singleKeyShortcuts=enabled;setSingleKeyShortcutsEnabled(enabled);this.requestUpdate();});}}></en-switch><p>Applies to V, M, B, H, I, C, Space, +, −, 0 and ? in this browser. Text fields, IME and modal dialogs retain their own keys. Toolbar controls and modified keyboard shortcuts remain available.</p><p>Restart the launcher on the same private root, pair, then open recovered documents. An expired review needs a fresh review. Accepted commands and originals stay retained.</p></en-drawer>
    <en-dialog id="editor-dialog" label=${title} .open=${this.panel!==null} @en-change=${close}><span slot="label">${title}</span>
    ${view.error&&this.panel&&this.panel!=='new'?html`<en-validation-summary heading="Action needs attention" .items=${[{target:'editor-dialog',message:view.error}]}></en-validation-summary>`:nothing}
    ${this.panel==='export'?(this.exportFlow?this.exportFlow.render():html`<p role="status">${this.exportLoadFailed?'Export controls are unavailable. Close this dialog and reload the editor to retry.':'Loading export controls…'}</p>`):nothing}
    ${this.panel==='storage'?this.storageFlow?.render()??nothing:nothing}
    ${this.panel==='new'?this.newDocumentFlow.fields():nothing}
    ${this.panel==='open'?html`<h2>Recovered local documents</h2>${view.documents.map(doc=>{const documentId=doc.id;return html`<en-button variant="secondary" @click=${(e:Event)=>this.action(e,'Open local document',async()=>{await editor.open(documentId);this.closePanel();})}>${documentDisplayName(doc)} · ${doc.id} · ${doc.width} × ${doc.height} · revision ${doc.revision}</en-button>`;})}<h2>Interrupted file transfers</h2><p>Reselect the exact original file to resume from its committed offset. Bytes never uploaded and unadmitted requests cannot be reconstructed after losing this tab.</p>${view.stages.map(stage=>{const stagingId=stage.stagingId,purpose=stage.purpose;return html`<section><p>${stage.purpose} · ${stage.committedOffset} / ${stage.expectedBytes} bytes · ${stage.state}</p>${stage.ownerClientId===connection.identity()&&['image','bundle'].includes(stage.purpose)?html`<en-file-upload label=${'Resume '+stagingId} choose-label="Reselect exact original" ?disabled=${view.busy} @en-change=${(e:Event)=>{const host=e.currentTarget as EnFileUpload;this.adapter.settled(e,()=>host.files,files=>{if(files[0]){if(purpose==='image')void this.resumeImage(files[0],stagingId).catch(error=>editor.fail(error));else void editor.run('Resume original transfer',()=>this.prepare(()=>editor.resumeStage(files[0],stagingId)));}});}}></en-file-upload>`:html`<p>Retained content; current client has no import authority for this entry.</p>`}</section>`;})}${view.stageNext?html`<en-button @click=${(e:Event)=>this.action(e,'Read next transfers',()=>editor.listStages(editor.view.stageNext))}>Next transfer page</en-button>`:nothing}<h2>Saved views and drafts</h2><p>Choose a current checkpoint to restore its view and unapplied drafts. A sequence belongs only to that checkpoint.</p>${view.uiChoices.map(choice=>{const sessionId=choice.sessionId,uiSeq=choice.uiSeq;return html`<en-button variant="secondary" @click=${(e:Event)=>this.action(e,'Restore UI checkpoint',async()=>{const current=editor.view.uiChoices.find(value=>value.sessionId===sessionId&&value.uiSeq===uiSeq);if(!current)throw Error('The saved UI checkpoint changed. Refresh the list and choose it again.');await editor.restoreUI(current);this.restoredUI='';this.inspectorKey='';this.closePanel();})}>Restore ${choice.sessionId} · document ${choice.documentId??'none'} · sequence ${choice.uiSeq}</en-button>`;})}${view.uiNext?html`<en-button variant="secondary" @click=${(e:Event)=>this.action(e,'Read next UI checkpoints',()=>editor.listUI(editor.view.uiNext))}>Next saved views page</en-button>`:nothing}<en-file-upload label="Open portable project" choose-label="Choose project" accept=".ideogram-project" ?disabled=${view.busy} @en-change=${(e:Event)=>this.file(e,'bundle')}></en-file-upload>`:nothing}
    ${this.panel==='import'?this.imageImport.render():nothing}
    ${this.panel==='resample'?html`<p>Change intrinsic source dimensions. Document bounds and layer transform remain unchanged. Review the resulting full document before Apply.</p>${this.number('resample-width','Intrinsic width (px)','1024')}${this.number('resample-height','Intrinsic height (px)','1024')}<en-button ?disabled=${view.busy} @click=${(e:Event)=>this.action(e,'Prepare resample',()=>this.prepare(()=>editor.prepareEdit({type:'PrepareImageResample',layerId:this.fields!.layer.id,layerVersion:this.fields!.layer.version,width:this.numeric('resample-width'),height:this.numeric('resample-height')})))}>Prepare preview</en-button>`:nothing}
    ${this.panel==='flatten'?html`<en-select id="flatten-scope" label="Flatten scope" value="visible"><en-select-option value="visible">All visible layers</en-select-option><en-select-option value="selected">Selected layers</en-select-option></en-select><en-switch id="flatten-hidden" label="Include hidden selected layers"></en-switch><en-switch id="flatten-hide" label="Hide originals after creating the copy"></en-switch><p>Originals and retained branches remain. The topmost copy can change the visible result; review the actual full document.</p><en-button ?disabled=${view.busy} @click=${(e:Event)=>this.action(e,'Prepare flatten copy',()=>this.prepare(()=>editor.prepareEdit({type:'PrepareFlattenedCopy',layerIds:(this.querySelector('#flatten-scope') as EnSelect).value==='visible'?editor.view.image!.layers.filter(l=>l.visible).map(l=>l.id):editor.view.selected,includeHidden:(this.querySelector('#flatten-hidden') as EnSwitch).checked,hideOriginals:(this.querySelector('#flatten-hide') as EnSwitch).checked,newLayerId:crypto.randomUUID(),name:'Flattened copy'})))}>Prepare preview</en-button>`:nothing}
    ${this.panel==='bounds'?html`<en-select id="bounds-mode" label="Bounds action" value="resize"><en-select-option value="resize">Resize canvas</en-select-option><en-select-option value="crop">Crop document</en-select-option></en-select><div class="property-grid">${this.number('bounds-width','Width (px)',String(d?.width??1024))}${this.number('bounds-height','Height (px)',String(d?.height??1024))}${this.number('bounds-x','X offset / crop origin (px)','0')}${this.number('bounds-y','Y offset / crop origin (px)','0')}</div><en-alert announcement="none">Apply moves layers and retained mask origins by the reviewed offset; crop uses the negative crop origin. Original pixels and hard/effective coverage stay intact. Outside a retained mask grid, coverage is zero, including inverted masks. Later expansion can reveal coverage hidden by these bounds.</en-alert><en-button ?disabled=${view.busy} @click=${(e:Event)=>this.action(e,'Apply canvas bounds',async()=>{const width=this.numeric('bounds-width'),height=this.numeric('bounds-height'),x=this.numeric('bounds-x'),y=this.numeric('bounds-y');await editor.withCommandEvents((this.querySelector('#bounds-mode') as EnSelect).value==='crop'?{type:'CropDocument',width,height,x,y,draft:null}:{type:'ResizeCanvas',width,height,offsetX:x,offsetY:y,draft:null},()=>undefined);this.closePanel();})}>Apply bounds</en-button>`:nothing}
    ${this.panel==='rasterize'&&this.rasterizeReview?html`<en-card><h2>Rasterize ${this.rasterizeReview.layer.name}</h2><en-alert announcement="none">Create an image copy at the same layer position using its accepted pixels, transform, opacity and mask. The editable text original will be hidden and retained with its fonts and history. The visible appearance stays unchanged; one Undo restores the original. Unapplied text edits stay separate.</en-alert><en-button ?disabled=${view.busy} @click=${(e:Event)=>this.action(e,'Rasterize text copy',()=>this.applyTextRaster())}>Create raster copy</en-button></en-card>`:nothing}
    ${this.panel==='copy'?html`<p>This copy includes all retained branches, edits, checkpoints, images, editable text, exact fonts, layouts, rendered appearance, Composition links, original raw captions and saved unapplied drafts for this document. Other documents are excluded. Missing or corrupt dependencies in any retained history block a complete copy; substituting a current font does not repair older history.</p><p>Preparing bytes does not confirm an external destination. Choose a destination after the complete copy is ready.</p><en-button ?disabled=${view.busy} @click=${(e:Event)=>this.action(e,'Prepare full-history copy',async()=>{await editor.copy();this.closePanel();})}>Prepare complete copy</en-button><h2>Incomplete sanitized recovery copy</h2><p>Rescue current safe document content, safe images and authored text. Unavailable content and unsafe provider images or returned prompts are omitted. History, checkpoints, drafts, jobs, creation-background and text-origin provenance, and backend transport are excluded. This file grants no request or adoption authority and cannot reopen an editable document. Exact originals remain retained locally.</p><p>The prepared file is explicitly labelled incomplete and inspection only. You must choose a destination separately.</p><en-switch id="recovery-copy-acknowledgement" label="I understand this is an incomplete sanitized recovery copy" .checked=${!!recoveryOwner&&this.recoveryCopyAcknowledgement===recoveryOwner} ?disabled=${view.busy||!recoveryOwner} @en-change=${(event:Event)=>{const control=event.currentTarget as EnSwitch;this.adapter.settled(event,()=>control.checked,checked=>{if(this.recoveryCopyOwner()!==recoveryOwner)return;this.recoveryCopyAcknowledgement=checked?recoveryOwner:null;this.requestUpdate();});}}></en-switch><en-button variant="secondary" ?disabled=${view.busy||!recoveryOwner||this.recoveryCopyAcknowledgement!==recoveryOwner} @click=${(event:Event)=>this.action(event,'Prepare incomplete recovery copy',()=>this.prepareRecoveryCopy())}>Prepare incomplete recovery copy</en-button>`:nothing}
    <en-stack slot="footer" direction="horizontal" wrap gap="small"><en-button variant="secondary" @click=${()=>this.closePanel()}>${this.panel==='storage'?'Close':'Cancel'}</en-button>${this.panel==='new'?this.newDocumentFlow.createButton():nothing}</en-stack></en-dialog>
    <en-dialog id="review-dialog" label=${r?.kind==='image'?'Review image conversion':r?.kind==='edit'?'Review prepared image edit':'Review portable project'} .open=${!!r} @en-change=${(e:Event)=>{const host=e.currentTarget as EnDialog;this.adapter.settled(e,()=>host.open,open=>{if(!open&&!editor.view.busy)editor.patch({review:null});});}}>
    ${view.error&&r?html`<en-validation-summary heading="Action needs attention" .items=${[{target:'review-dialog',message:view.error}]}></en-validation-summary>`:nothing}
    ${r?.kind==='image'?html`<p>${r.name}</p><p>${r.asset.raster!.width} × ${r.asset.raster!.height} working pixels · ${r.review.conversion?.profile} → sRGB · orientation ${r.review.conversion?.orientation} · ${r.review.conversion?.colorChanged?'color conversion applied':'color unchanged'} · ${r.review.conversion?.orientationChanged?'orientation normalized':'orientation unchanged'} · no resize · alpha retained</p><p>${r.target?'Apply adds a layer to revision '+r.target.revision:'Apply creates a document at the image dimensions.'}</p>`:nothing}
    ${r?.kind==='edit'?html`<p>${r.review.preview.kind} · source revision ${r.review.preview.documentRevision}. This is the prepared full-document result. Apply commits these exact retained pixels.</p>`:nothing}
    ${r&&r.kind!=='bundle'?html`<img class="review-image" src=${displayImage(this.previewURL||nothing)} alt="Scaled preview of the exact prepared raster" @load=${(event:Event)=>{try{validateDisplayImage(event.currentTarget as HTMLImageElement,this.previewURL);this.previewLoaded=true;}catch(error){this.previewLoaded=false;editor.fail(error);}this.requestUpdate();}}><p class="identity-note">Scaled preview · original ${displayPreviewInfo(this.previewURL)?.sourceWidth} × ${displayPreviewInfo(this.previewURL)?.sourceHeight}. Review expires ${r.review.expiresAt}. Restart or connection renewal invalidates unaccepted authority.</p>`:nothing}
    ${r?.kind==='bundle'?html`<p>${r.name} · ${r.review.source.byteLength} bytes</p><p>${r.review.objectCount} objects · ${r.review.entityCount} entities · ${r.review.eventCount} events · ${r.review.uiSessionCount} UI checkpoints</p>${r.review.recovery?html`<p>Incomplete sanitized recovery copy. Current safe content only; history, checkpoints, drafts, jobs, creation-background and text-origin provenance, protected transport and unsafe or unavailable content are omitted. This file grants no request or adoption authority and cannot reopen an editable document.</p>`:html`<p>Includes this document’s current drafts and all retained domain history. Obsolete unattributed UI-only content is excluded and retained locally.</p>`}<p>${r.review.editable?'Apply opens a new local identity. Imported records do not schedule provider work.':'Inspection only: '+r.review.reason}</p>`:nothing}
    <en-stack slot="footer" class="actions" direction="horizontal" wrap gap="small"><en-button variant="secondary" ?disabled=${view.busy} @click=${()=>editor.patch({review:null,message:'Review canceled. Original bytes remain retained; no document edit was accepted.'})}>Cancel review</en-button><en-button ?disabled=${view.busy||!r||r.kind==='bundle'&&!r.review.editable||r.kind!=='bundle'&&!this.previewLoaded} @click=${(e:Event)=>this.action(e,'Apply reviewed result',()=>editor.applyReview())}>Apply reviewed result</en-button></en-stack></en-dialog>`;
  }
}
scope.register([{tagName:'ie-shell',elementClass:EditorShell}]);
export async function mount(token?:string){if(shellAttached){token=undefined;throw Error('SHELL_ALREADY_CONNECTED');}const shell=scope.createElement('ie-shell') as EditorShell;document.querySelector('#app')!.append(shell);try{shell.assertConnectionAdmission();}catch(error){token=undefined;throw error;}void shell.startConnection(token).catch(()=>{});token=undefined;await shell.updateComplete;}
if(import.meta.hot)import.meta.hot.accept('./shell-wordmark.js',module=>{
  if(!module||typeof module.renderShellWordmark!=='function'){import.meta.hot!.invalidate('The shell view update is incompatible.');return;}
  wordmark=module.renderShellWordmark;
  for(const shell of developmentShells!)shell.requestUpdate();
});
