import {captureQueuedReplacementFence,queuedDraftsClean,queuedReplacementOperation} from './queued-replacement-fence.js';
import {rasterImportCancellation,type RasterImportCancellation} from '../protocol/raster-import.js';
import {readUndoAvailability} from './history-availability.js';
import { createValueModel } from '@en-reve/primitives/state/value.js';
import type { createSessionClient } from './session-client.js';
import { RecoveryCache, RecoveryPublicationConflict } from './recovery-cache.js';
import { RecoveryConsumer } from './recovery-client.js';
import { BrowserJournal } from './browser-journal.js';
import {reserveCommandWire,measureControl} from './control-memory.js';
import {CommandControlReads,readCommandEvents,COMMAND_RESULT_LIMITS} from './command-results.js';
import {readRetainedPrompt} from '../observability/prompt-memory.js';
import {ViewModelOwners,ViewModelReads,VIEW_MODEL_LIMITS,canonicalControlHash,ownDownload,type ViewModelInput,type ViewModelSlot} from './view-models.js';
import { DraftPersistence } from './draft-persistence.js';
import { DocumentResources } from './document-lifecycle.js';
import {collectOwnedDocuments,type OwnedDocumentList} from './document-list.js';
import {readOwnedJSON,createOwnedModel,cloneOwnedModel,modelPayloadBytes,reserveModelBytes,ModelPayload,type OwnedModel,type ModelKind} from '../observability/model-memory.js';
import { EMPTY_EXPECTED_VERSIONS, type Command, type CommandRequest, type BlobRef, type DocumentCreationBackground, type Document, type DomainEvent, type Receipt, type Checkpoint, type HistoryNode } from '../protocol/store.js';
import type { CommandResult, EventPage, PendingInventory } from '../protocol/recovery.js';
import type { Asset, StagingCreateRequest, StagingRecord, StagingRecoveryPage } from '../protocol/assets.js';
import type { ImageState, ImageHistoryNode, ImageEditReview } from '../protocol/history.js';
import type { Bundle, BundleReview, RecoveryDisclosure } from '../protocol/portable.js';
import type { RasterReview } from '../protocol/raster.js';
import type { FontVersion } from '../protocol/text.js';
import type { DocumentExportOptions, ExportCancellation } from '../protocol/export.js';
import type { UICheckpoint, UIRequest, UIReceipt, Preferences, UIInventory } from '../protocol/ui.js';
import { SHA256 } from '../protocol/sha256.js';
import { canonical, parseControlJSON } from '../protocol/json.js';
import { event as validateEvent } from '../protocol/validate.js';
import type {NavigationTarget} from '../observability/navigation-observations.js';
import {browserPhases} from '../observability/browser.js';
import type {AdapterOpaqueUpload} from '../observability/adapter-upload-hook.js';
import {allocationLedger} from '../observability/allocations.js';
import type {PhaseContext,PhaseName} from '../observability/phases.js';

type Session = ReturnType<typeof createSessionClient>;
type Delivery = { request: CommandRequest; wire: string; result?: CommandResult; label: string };
export type ExportCancellationResult = ExportCancellation;
export type ExportCancellationOwner = {session:Session;identity:string|null};
export type CandidateReviewCancellationOwner = ExportCancellationOwner;
export type RasterImportCancellationOwner = ExportCancellationOwner;
export type CandidateReviewCancellationResult = {protocolVersion:1;commandId:string;status:'canceled'|'completed'};
export type Review = { kind: 'image'; asset: Asset; review: RasterReview; name: string; target: Document | null }
 | { kind: 'edit'; review: ImageEditReview }
 | { kind: 'bundle'; review: BundleReview; name: string };
export type Download = { path: string; name: string; hash: string; bytes: string; kind: 'copy' | 'image'; documentId:string;revision:string; mediaType?:string; recovery?:RecoveryDisclosure; status: 'ready' | 'writing' | 'unconfirmed' | 'confirmed' | 'failed' };
export type EditorView = {
  ready: boolean; busy: boolean; message: string; error: string; recovery: string;
  documents: Document[]; document: Document | null; image: ImageState | null;
  history: ImageHistoryNode[]; historyNext: string | null; undoAvailable:boolean|null; checkpoints: Checkpoint[];checkpointNext:string|null;
  review: Review | null; download: Download | null; selected: string[];
  save: { pendingCommandCount: number; draftDirty: boolean; documentChangedSinceCheckpoint: boolean; bundleOutdated: boolean } | null;
  drafts: string; pending: Delivery[];pendingAfter:string|null;pendingDirection:'next'|'prev';pendingPrevious:string|null;pendingNext:string|null;pendingCreate:boolean;uiPending:string[]; cursor: string; uiChoices:UIInventory['items'];uiNext:string|null;stages:StagingRecoveryPage['items'];stageNext:string|null;
};
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const commandPhase=(type:Command['body']['type']):PhaseName|undefined=>({PrepareRequestSource:'source.capture',PrepareRequestMask:'mask.plan',PrepareCandidateAdoption:'result.prepare',PrepareRaster:'raster.prepare',SaveCopy:'project.copy',SaveRecoveryCopy:'project.copy',ImportBundle:'project.import',ExportDocument:'document.export'} as Partial<Record<Command['body']['type'],PhaseName>>)[type];
const adoptionTraceId=(body:Command['body']):string|undefined=>body.type==='AdoptCandidate'?body.previewId:body.type==='AdoptReviewedCandidate'?body.reviewId:undefined;
export class EditorClient {
  readonly state = createValueModel<EditorView>({ready:false,busy:false,message:'Connect locally to open your work.',error:'',recovery:'',documents:[],document:null,image:null,history:[],historyNext:null,undoAvailable:null,checkpoints:[],checkpointNext:null,review:null,download:null,selected:[],save:null,drafts:'',pending:[],pendingAfter:null,pendingDirection:'next',pendingPrevious:null,pendingNext:null,pendingCreate:false,uiPending:[],cursor:'0',uiChoices:[],uiNext:null,stages:[],stageNext:null});
  private cache?: RecoveryCache;
  private documentsMetadata?:OwnedDocumentList;
  private queuedReplacementActive=false;
  private viewModels=new ViewModelOwners();
  private viewReads=new ViewModelReads();
  private controlReads=new CommandControlReads();
  private selectedDocumentMetadata?:OwnedDocumentList;
  private selectedDocumentPin?:()=>void;
  private consumer?: RecoveryConsumer;
  private recoveryDrain:Promise<void>=Promise.resolve();
  private recoveryFailure?:unknown;
  private disposalTask?:Promise<void>;
  private disposalPending=false;
  private disposalPublicationFailure?:unknown;
  private disposalPublicationFailed=false;
  private connectWork?:Promise<void>;
  private connectWorkOwner?:string|null;
  private connectWorkLifetime?:number;
  private retiredConnections?:Set<RecoveryCache|BrowserJournal>;
  private lateConnectionFailure?:{error:unknown};
  private journal?: BrowserJournal;
  private pendingRead=0;
  private retiredDraftOwners=new Set<DraftPersistence>();
  private draftOwnerDrains=new Map<DraftPersistence,Promise<void>>();
  private restoreUIActive=false;
  private readonly navigationStatusSource=crypto.randomUUID();
  private navigationPublicationDepth=0;
  private lifecycle = 0;
  private documentLifetime=0;
  private closingDocument?:Promise<void>;
  private uploads=new Set<AbortController>();
  private uploadSettlements=new Map<AbortController,Promise<void>>();
  private draftReads=new Map<AbortController,Promise<string>>();
  private importAdmissions=new Map<string,Promise<void>>();
  private exportAdmissions=new Map<string,Promise<void>>();
  private reviewAdmissions=new Map<string,Promise<void>>();
  readonly documentResources=new DocumentResources();
  private stream?: AbortController;
  private streamTask?: Promise<void>;
  private syncTask?: Promise<void>;
  private refreshTask?: Promise<void>;
  private refreshAgain=false;
  private owner: string | null = null;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retryDelay=250;
  private draftFlush?:Promise<void>;
  private uiTail: Promise<unknown> = Promise.resolve();
  private draftTimer?: ReturnType<typeof setTimeout>;
  draftOwner?: DraftPersistence;
  private uiModel?:OwnedModel<UICheckpoint>;
  get ui(){return this.uiModel?.value;}
  set ui(value:UICheckpoint|undefined){
    if(value===this.ui)return;let next:OwnedModel<UICheckpoint>|undefined;
    if(value){const owner=this.draftOwner;if(!owner)throw Error('UI_CHECKPOINT_OWNER_REQUIRED');if(value!==owner.checkpoint)owner.checkpoint=value;next=owner.borrowCheckpoint(owner.checkpoint!);}
    const prior=this.uiModel;this.uiModel=next;prior?.release();
  }
  registerDraft(id:string,documentId:string){if(!this.draftOwner||this.view.document?.id!==documentId)throw Error('DRAFT_OWNER_CHANGED');return this.draftOwner.registerDraft(id,documentId);}
  private retireDraftOwner(owner:DraftPersistence){
    const active=this.draftOwnerDrains.get(owner);if(active)return active;this.retiredDraftOwners.add(owner);
    const task=owner.dispose().then(()=>{this.retiredDraftOwners.delete(owner);}).finally(()=>{this.draftOwnerDrains.delete(owner);});this.draftOwnerDrains.set(owner,task);void task.catch(()=>{});return task;
  }
  private async drainDraftOwners(){const results=await Promise.allSettled([...this.retiredDraftOwners].map(async owner=>this.retireDraftOwner(owner))),errors=results.filter((result):result is PromiseRejectedResult=>result.status==='rejected').map(result=>result.reason);if(errors.length)throw new AggregateError(errors,'DRAFT_OWNER_CLEANUP_FAILED');}
  private assertDraftOwnerCapacity(){if(this.retiredDraftOwners.size>=8)throw Error('Previous draft cleanup is incomplete. Retry closing before opening another checkpoint.');}
  pinUI(){return this.uiModel?.pin()??(()=>{});}
  renderUI(){const model=this.uiModel;return model?[{value:model.value,pin:()=>model.pin()}]:[];}
  constructor(readonly session: Session) {
    this.mountViewMetadata();
    this.documentResources.register('editor-draft-results',{release:async()=>{const results=await Promise.allSettled([this.draftOwner?.release(),this.drainDraftOwners()]);const errors=results.filter((result):result is PromiseRejectedResult=>result.status==='rejected').map(result=>result.reason);if(errors.length)throw new AggregateError(errors,'DRAFT_OWNER_CLEANUP_FAILED');},inspect:()=>({...(this.draftOwner?.ownership??{}),retiredDraftOwners:this.retiredDraftOwners.size,retiringDraftOwners:this.draftOwnerDrains.size})});
    this.documentResources.register('editor-command-results',{release:()=>this.controlReads.release(),inspect:()=>this.controlReads.ownership});
    this.documentResources.register('editor-view-models',{release:()=>this.viewReads.release(),inspect:()=>({...this.viewReads.ownership,...this.viewModels.ownership})});
    this.documentResources.register('editor-client',{release:async()=>{for(const abort of [...this.uploads,...this.draftReads.keys()])abort.abort();await Promise.allSettled([...this.uploadSettlements.values(),...this.draftReads.values()]);},inspect:()=>({uploads:this.uploads.size,draftReads:this.draftReads.size})});
  }
  patch(value: Partial<EditorView>) {
    if(value.review&&value.review!==this.view.review&&!this.viewModels.isCurrent('review',value.review)){measureControl(value.review,1024*1024);const model=cloneOwnedModel('editor-review-model',value.review);try{this.publishViewModels([this.viewInput('review',model,'prepared-review',model.value)],{...value,review:model.value});}catch(error){model.release();throw error;}return;}
    if(value.download&&value.download!==this.view.download&&!this.viewModels.isCurrent('download',value.download)){
      const model=ownDownload(value.download);try{this.publishViewModels([this.viewInput('download',model,'prepared-download',model.value)],{...value,download:model.value});}catch(error){model.release();throw error;}return;
    }
    const previousDocument=this.view.document;
    const changesDocument='document' in value&&value.document!==this.view.document;
    if(changesDocument&&!Object.hasOwn(value,'undoAvailable'))value={...value,undoAvailable:null};
    // Active document metadata borrows a row from the published list. Pin that
    // owner across replacement scans until the active document is replaced or
    // closed; a failed image refresh can legitimately keep the prior row live.
    const nextOwner=changesDocument&&value.document?this.documentRowOwner(value.document):undefined,nextPin=nextOwner?.pin();
    try{this.viewModels.publishControlView({...this.state.value.get(),...value},next=>this.publishNavigationView(next));}catch(error){nextPin?.();throw error;}
    this.viewModels.clearReplaced(value);
    if(changesDocument&&(previousDocument?.id!==value.document?.id||previousDocument?.revision!==value.document?.revision||previousDocument?.image?.state.hash!==value.document?.image?.state.hash||previousDocument?.image?.compositeAssetId!==value.document?.image?.compositeAssetId)||value.image===null)browserPhases.resetNavigation();
    if(changesDocument){this.selectedDocumentPin?.();this.selectedDocumentPin=nextPin;this.selectedDocumentMetadata=nextOwner;}
  }
  private navigationStatusContext(view:EditorView=this.view){return {sourceId:this.navigationStatusSource,lifecycle:this.lifecycle,documentGeneration:this.documentLifetime,sessionId:this.sessionId,documentId:view.document?.id??null,revision:view.document?.revision??null,cursor:view.cursor};}
  private recordNavigationPublication(view:EditorView){browserPhases.recordNavigationStatus?.({...this.navigationStatusContext(view),message:view.message,ready:view.ready,busy:view.busy,hasError:!!view.error,hasRecovery:!!view.recovery});}
  private publishNavigationView(view:EditorView){
    // A failed or reentrant publication cannot leave a complete diagnostic
    // history. The actual public state and existing owner error remain primary.
    if(this.navigationPublicationDepth)browserPhases.invalidateNavigationStatus?.();
    this.navigationPublicationDepth++;
    try{this.state.set(view);this.recordNavigationPublication(view);}catch(error){browserPhases.invalidateNavigationStatus?.();throw error;}finally{this.navigationPublicationDepth--;}
  }
  private recordNavigationCheckpoint(command:Command,receipt:Receipt){
    if(command.body.type!=='SaveCheckpoint'||receipt.status!=='accepted')return;
    const context=this.navigationStatusContext();
    if(receipt.commandId!==command.commandId||receipt.transactionId!==command.transactionId||command.sessionId!==context.sessionId||command.clientId!==this.session.identity()||context.documentId!==command.documentId||context.revision!==receipt.documentRevision)return;
    // Called only after the original accepted receipt, complete command events,
    // published projection and draft-owner recovery have all settled.
    browserPhases.recordNavigationAuthority?.({...context,kind:'checkpoint',commandId:receipt.commandId,transactionId:receipt.transactionId,fromSeq:receipt.fromSeq,toSeq:receipt.toSeq});
  }
  pinDownload(value:Download){return this.viewModels.borrow(value);}
  mountViewMetadata(){this.patch({});}
  renderViewMetadata(value:EditorView){return this.viewModels.renderControlView(value);}
  renderViewModels(...values:(object|null|undefined)[]){const roots=new Map<object,{value:object;pin:()=>()=>void}>();for(const value of values){if(!value)continue;const document=this.documentRowOwner(value as Document),model=document?{value:document.documents,pin:()=>document.pin()}:this.viewModels.renderModel(value);roots.set(model.value,model);}return [...roots.values()];}
  pinViewModels(...values:(object|null|undefined)[]){
    const releases:(()=>void)[]=[],documents=new Set<OwnedDocumentList>(),other:object[]=[];
    try{for(const value of values){if(!value)continue;const document=this.documentRowOwner(value as Document);if(document)documents.add(document);else other.push(value);}for(const document of documents)releases.push(document.pin());releases.push(this.viewModels.borrowMany(other));}
    catch(error){for(const release of releases)release();throw error;}finally{values.length=0;documents.clear();other.length=0;}return ()=>{for(const release of releases)release();releases.length=0;};
  }
  private publishViewModels(inputs:ViewModelInput[],patch:Partial<EditorView>){this.viewModels.publish(inputs,()=>this.patch(patch));}
  private viewInput<T>(slot:ViewModelSlot,model:OwnedModel<T>,identity:string,exposed:unknown):ViewModelInput{return {slot,model,identity,exposed,references:function*(){const root=model.value;if(root&&typeof root==='object')yield root as object;if(exposed&&typeof exposed==='object'&&exposed!==root)yield exposed as object;if(slot==='image'){for(const layer of (root as ImageState).layers)yield layer;}else if(Array.isArray(exposed))for(const row of exposed)if(row&&typeof row==='object')yield row;}};}
  private patchSave(patch:Partial<NonNullable<EditorView['save']>>,before?:()=>void,viewPatch:Partial<EditorView>={}){const prior=this.view.save;if(!prior){before?.();if(Object.keys(viewPatch).length)this.patch(viewPatch);return;}const model=createOwnedModel('editor-save-status',modelPayloadBytes(prior)+modelPayloadBytes(patch)+128,()=>({...prior,...patch}));try{this.viewModels.publish([this.viewInput('save',model,'local-save',model.value)],()=>{before?.();this.patch({...viewPatch,save:model.value});});}catch(error){model.release();throw error;}}
  private documentRowOwner(document:Document){return this.documentsMetadata?.documents.includes(document)?this.documentsMetadata:this.selectedDocumentMetadata?.documents.includes(document)?this.selectedDocumentMetadata:undefined;}
  get view() { return this.state.value.get(); }
  get documentEpoch(){return this.documentLifetime;}
  get sessionId() { return this.ui?.sessionId ?? 'editor_' + this.owner; }
  navigationTarget(document:Document|null=this.view.document):NavigationTarget|null {return document?.image?.compositeAssetId?{sessionId:this.sessionId,generation:this.documentEpoch,documentId:document.id,revision:document.revision,assetId:document.image.compositeAssetId,assetHash:document.image.state.hash}:null;}
  navigationControlsRendered(document:Document|null,enabled:boolean){browserPhases.recordNavigationControlsRendered(this.navigationTarget(document),enabled);}
  navigationControlsCommitted(viewportCurrent:boolean,enabled:boolean){browserPhases.recordNavigationControlsCommitted(this.navigationTarget(),viewportCurrent,enabled);}
  navigationRenderSubmitted(){const target=this.navigationTarget();if(target)browserPhases.recordNavigationRenderSubmitted(target);}
  navigationViewportUnavailable(){browserPhases.recordNavigationViewportUnavailable();}
  viewportDecoded(target:{documentId:string;revision:string;assetId:string},started?:number){browserPhases.viewportDecoded(target,started);}
  setViewportProbe(probe:()=>string|null){browserPhases.setViewportProbe(probe);}
  feedbackRendered(){browserPhases.feedbackSubmitted();}
  beginFeedback(intentTime?:number){const d=this.view.document;browserPhases.beginIntent(d?{documentId:d.id,revision:d.revision}:{},intentTime);}
  beginAdoption(context:PhaseContext,preparedDurable:boolean,intentTime?:number){browserPhases.beginAdoption(context,preparedDurable,intentTime);}
  adoptionFailed(previewId:string){browserPhases.adoptionFailed(previewId);}
  async json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.session.transport(path, init);
    if(response.status===204)return undefined as T;
    const value = await response.json();
    if (!response.ok) throw new Error(value.error?.code ?? 'CONTENT_UNAVAILABLE');
    return value as T;
  }
  ownedJSON<T>(path:string,owner:string,init?:RequestInit,owns?:()=>boolean,maxBytes=1024**2,kind:ModelKind='control'):Promise<OwnedModel<T>> {
    return readOwnedJSON<T>(this.session.transport.bind(this.session),path,{owner,init,owns,maxBytes,kind});
  }
  async withJSON<T,R>(path:string,owner:string,work:(value:T)=>R|Promise<R>,init?:RequestInit,owns?:()=>boolean,maxBytes=65536,kind:ModelKind='control'):Promise<R>{
    return this.controlReads.run(async signal=>{const model=await this.ownedJSON<T>(path,owner,{...init,signal},owns,maxBytes,kind);try{return await work(model.value);}finally{model.release();}},init?.signal);
  }
  private ownedPost<T>(path:string,owner:string,body:unknown,signal?:AbortSignal){const admitted=reserveCommandWire(body);return this.ownedJSON<T>(path,owner,{method:'POST',headers:{'Content-Type':'application/json'},body:admitted.wire,signal},undefined,COMMAND_RESULT_LIMITS.controlBytes).finally(()=>admitted.release());}
  async withCommandEvents<T>(body:Command['body'],work:(events:readonly DomainEvent[])=>T|Promise<T>,document:Pick<Document,'id'|'revision'>|null=this.view.document,newId?:string,onJournaled?:(commandId:string)=>void):Promise<T>{
    const scope=this.controlContext(),args=reserveCommandWire({body,document:document?{id:document.id,revision:document.revision}:null,newId});
    try{return await this.controlReads.run(async signal=>{scope.check(signal);const result=await this.ownedCommand(args.request.body,args.request.document,args.request.newId,onJournaled);try{scope.check(signal);return await work(result.value);}finally{result.release();}});}finally{args.release();}
  }
  private async post<T>(path:string,body:unknown){const admitted=reserveCommandWire(body);try{return await this.json<T>(path,{method:'POST',headers:{'Content-Type':'application/json'},body:admitted.wire});}finally{admitted.release();}}
  private checkLateConnectionFailure(){if(this.lateConnectionFailure)throw this.lateConnectionFailure.error;}
  async connect() {
    // Waiting callers are outside connectWork: disposal must not await a
    // reconnect that is itself waiting for that disposal to finish.
    const requested=this.lifecycle,retirement=this.disposalTask,identity=this.session.identity();
    if(retirement)await retirement;
    this.checkLateConnectionFailure();
    if(requested!==this.lifecycle||identity!==this.session.identity())return;
    const active=this.connectWork;
    if(active){
      if(this.connectWorkOwner===identity&&this.connectWorkLifetime===requested)return active;
      await active.catch(()=>{});
      if(requested!==this.lifecycle||identity!==this.session.identity())return;
      this.checkLateConnectionFailure();
    }
    const work=this.connectOwned();this.connectWork=work;this.connectWorkOwner=identity;this.connectWorkLifetime=this.lifecycle;
    try{await work;}finally{if(this.connectWork===work){this.connectWork=undefined;this.connectWorkOwner=undefined;this.connectWorkLifetime=undefined;}}
  }
  private async connectOwned() {
    const connection=this.session,owner=connection.identity(); if (!owner) { this.disconnect(); return; }
    const previousOwner=this.owner;
    const lifetime = ++this.lifecycle;browserPhases.resetNavigation();clearTimeout(this.retryTimer);this.stream?.abort();const retired=this.stopRecovery();await Promise.all([this.streamTask,retired,this.viewReads.release(),this.controlReads.release(),this.draftOwner?.release()]);
    // Retire reads from the previous session before replacing their cache/consumer.
    // Their failures remain visible until this fresh recovery succeeds.
    await this.syncTask?.catch(()=>{});await this.refreshTask?.catch(()=>{});
    if(lifetime!==this.lifecycle)return;
    this.owner = owner; this.patch({ready:false,review:null,message:'Recovering complete local transactions…',error:'',recovery:''});
    if(this.cache)this.retireConnection(this.cache,true);
    const cache=await RecoveryCache.open('ie-projection-' + owner);this.cache=cache;
    const current=()=>lifetime===this.lifecycle&&connection===this.session&&owner===connection.identity();
    if(!current()){this.retireConnection(cache,true);return;}
    if(!this.journal||previousOwner!==owner){
      if(this.journal)this.retireConnection(this.journal,true);const journal=await BrowserJournal.open(owner);this.journal=journal;
      if(!current()){this.retireConnection(journal,true);return;}
    }
    this.consumer = new RecoveryConsumer(cache, this.session.transport, this.session.csrf);
    const storageKey='ie-ui-session:'+owner;
    const sessionId=sessionStorage.getItem(storageKey)??'ui_'+crypto.randomUUID();sessionStorage.setItem(storageKey,sessionId);
    if(!this.draftOwner||this.draftOwner.sessionId!==sessionId){this.assertDraftOwnerCapacity();const prior=this.draftOwner;this.draftOwner = new DraftPersistence(sessionId, this.session.transport, this.session.csrf,this.journal);if(prior)void this.retireDraftOwner(prior);this.patch({drafts:'Opening saved UI state…'});}
    const connectedDraftOwner=this.draftOwner;await connectedDraftOwner.restore();
    if(lifetime!==this.lifecycle||connection!==this.session||owner!==connection.identity()||connectedDraftOwner!==this.draftOwner)return;
    this.ui=connectedDraftOwner.checkpoint!;
    await this.sync(); if (lifetime !== this.lifecycle) return;
    const preferred = this.ui.preferences.documentId;
    if (preferred && this.view.documents.some(d=>d.id===preferred)) await this.open(preferred, false);
    else if(this.ui.uiSeq==='0'&&this.view.documents.length===1)await this.open(this.view.documents[0].id,false);
    for(const read of [()=>this.listUI(),()=>this.listStages(),()=>this.discoverPending(),()=>this.listPending('first')]){
      if(!current()||connectedDraftOwner!==this.draftOwner)return;await read();
    }
    if(lifetime!==this.lifecycle||connection!==this.session||owner!==connection.identity()||this.owner!==owner||connectedDraftOwner!==this.draftOwner)return;
    browserPhases.recordNavigationAuthority?.({...this.navigationStatusContext(),kind:'recovered'});
    this.patch({ready:true,uiPending:connectedDraftOwner.pendingRequests(),message:'Local recovery complete. Accepted edits are saved locally.'});
    this.startStream(lifetime);await this.drainDraftOwners();
  }
  private invalidateConnection() {
    browserPhases.reset();
    this.lifecycle++; this.stream?.abort(); clearTimeout(this.draftTimer);clearTimeout(this.retryTimer);
    void this.stopRecovery();
  }
  disconnect() {
    this.invalidateConnection();
    this.patch({ready:false,review:null,recovery:'Disconnected. Drafts remain editable in this tab; document commands require the local writer.'});
  }
  private stopRecovery(){
    const consumer=this.consumer;consumer?.cancel();const prior=this.recoveryDrain;
    this.recoveryDrain=prior.catch(error=>{if(!consumer)throw error;}).then(()=>consumer?.release()).then(()=>{this.recoveryFailure=undefined;});
    void this.recoveryDrain.catch(error=>{this.recoveryFailure=error;this.fail(error);});return this.recoveryDrain;
  }
  private startStream(lifetime: number) {
    const consumer=this.consumer;if(!consumer||this.syncTask||this.recoveryFailure||lifetime!==this.lifecycle||this.stream&&!this.stream.signal.aborted)return;
    const abort = new AbortController(); this.stream=abort;
    // Poll only the published pointer while the real SSE consumer publishes whole transactions.
    let cursor=this.view.cursor;
    const timer=setInterval(()=>{void this.cache?.published().then(p=>{if(p.cursor!==cursor){cursor=p.cursor;void this.refresh().catch(e=>this.fail(e));}});},100);
    this.streamTask=consumer.consumeStream(abort.signal).catch(error=>{
      if(!abort.signal.aborted&&lifetime===this.lifecycle){
        this.patch({recovery:'Updates interrupted. Recovering complete transactions; the last valid view is retained.'});
        abort.abort();clearTimeout(this.retryTimer);
        this.retryTimer=setTimeout(()=>{const d=this.view.document,reconnect=browserPhases.recorder.start('reconnect',d?{documentId:d.id,revision:d.revision}:{});void this.sync().then(()=>{if(lifetime!==this.lifecycle){reconnect.end('cancelled');return;}reconnect.end('incomplete',{boundary:'observed'});this.retryDelay=250;this.patch({recovery:''});this.startStream(lifetime);}).catch(e=>{reconnect.end('error');this.fail(e);this.retryDelay=Math.min(4000,this.retryDelay*2);this.startStream(lifetime);});},this.retryDelay);
      }
    }).finally(()=>clearInterval(timer));
  }
  async sync() {
    if(this.syncTask)return this.syncTask;
    this.syncTask=(async()=>{
      const cache=this.cache,consumer=this.consumer!,lifetime=this.lifecycle;
      this.stream?.abort();await this.streamTask;
      await consumer.release();await this.recoveryDrain;
      if(lifetime!==this.lifecycle||cache!==this.cache)return;
      for(;;){
        try{await consumer.recover();break;}
        catch(error){
          // Another tab won the pointer CAS (or retired our selected base).
          // Start a whole new leased recovery, never accept its pointer as our
          // command proof or retry unrelated storage/authority/validation errors.
          if(!(error instanceof RecoveryPublicationConflict)||lifetime!==this.lifecycle||cache!==this.cache)throw error;
        }
      }
      await this.refresh();
    })().finally(()=>{this.syncTask=undefined;});
    return this.syncTask;
  }
  private async refresh() {
    if(this.refreshTask){this.refreshAgain=true;return this.refreshTask;}
    this.refreshTask=(async()=>{
      const cache=this.cache!,lifetime=this.lifecycle,next=await collectOwnedDocuments(cache,()=>cache===this.cache&&lifetime===this.lifecycle);
      if(!next)return;
      const current=next.documents.find(d=>d.id===this.view.document?.id)??null,previous=this.documentsMetadata;
      this.documentsMetadata=next;
      try{this.patch({documents:next.documents,cursor:next.cursor});}catch(error){this.documentsMetadata=previous;next.release();throw error;}
      previous?.release();
      if(current)await this.loadDocument(current);
      else if(this.view.document)this.patch({document:null,image:null,history:[],checkpoints:[],selected:[],save:null});
    })().finally(()=>{this.refreshTask=undefined;if(this.refreshAgain){this.refreshAgain=false;void this.refresh().catch(e=>this.fail(e));}});return this.refreshTask;
  }
  private async loadDocument(document:Document) {
    const unpin=this.documentRowOwner(document)?.pin();
    try{return await this.viewReads.run(async signal=>{
      const lifetime=this.lifecycle,documentLifetime=this.documentLifetime,sessionId=this.sessionId,cache=this.cache!,published=await cache.published();
      const current=()=>!signal.aborted&&lifetime===this.lifecycle&&documentLifetime===this.documentLifetime&&cache===this.cache&&this.view.document?.id===document.id;
      if(!current())return;
      const identity=lifetime+':'+document.id+':'+document.revision,owned:OwnedModel<unknown>[]=[],inputs:ViewModelInput[]=[];let installed=false;
      const read=async<T>(slot:ViewModelSlot,path:string,key:string)=>{const prior=slot==='save'?undefined:this.viewModels.reuse<T>(slot,key);if(prior){owned.push(prior);return {model:prior,reused:true,key};}const model=await this.ownedJSON<T>(path,'editor-'+slot+'-model',{signal},current,VIEW_MODEL_LIMITS.responseBytes);owned.push(model);const same=slot==='save'?this.viewModels.same<T>(slot,model.value):undefined;if(same){model.release();owned.push(same);return {model:same,reused:true,key};}return {model,reused:false,key};};
      try{
        const outcomes=await Promise.allSettled([
          read<ImageState>('image','/api/v1/documents/'+document.id+'/image',identity+':'+(document.image?.state.hash??'empty')),
          read<{items:ImageHistoryNode[];next:string|null}>('history','/api/v1/documents/'+document.id+'/history',identity+':history:first'),
          read<{items:Checkpoint[];next:string|null}>('checkpoints','/api/v1/documents/'+document.id+'/checkpoints',identity+':checkpoints:first'),
          read<EditorView['save']>('save','/api/v1/documents/'+document.id+'/save-status?sessionId='+this.sessionId,identity+':save'),
        ] as const);
        const failures=outcomes.filter((r):r is PromiseRejectedResult=>r.status==='rejected');if(failures.length)throw new AggregateError(failures.map(r=>r.reason),'DOCUMENT_MODEL_READ_FAILED');
        const [imageRow,historyRow,checkpointRow,saveRow]=outcomes.map(r=>(r as PromiseFulfilledResult<any>).value) as [Awaited<ReturnType<typeof read<ImageState>>>,Awaited<ReturnType<typeof read<{items:ImageHistoryNode[];next:string|null}>>>,Awaited<ReturnType<typeof read<{items:Checkpoint[];next:string|null}>>>,Awaited<ReturnType<typeof read<EditorView['save']>>>];
        const image=imageRow.model.value,history=historyRow.model.value,checkpoints=checkpointRow.model.value,save=saveRow.model.value;
        if(!current())return;
        if(document.image&&!imageRow.reused&&canonicalControlHash(image)!==document.image.state.hash)return;
        const undoAvailable=await readUndoAvailability(cache,document);
        const live=await this.session.transport('/api/v1/documents/'+document.id,{method:'HEAD',signal}),version=live.headers.get('X-App-Entity-Version');
        if(!current())return;if(!live.ok||version===null||!/^(0|[1-9][0-9]*)$/.test(version))throw Error('DOCUMENT_VERSION_UNAVAILABLE');
        if(version!==document.revision||(await cache.published()).generation!==published.generation||!current())return;
        if(!await this.viewModels.validateDocumentRead(cache,document,current))return;
        // A concurrently paged/replaced root may retire a borrowed reuse while
        // the other responses drain. Never republish it under a released pin.
        if(imageRow.reused&&!this.viewModels.isCurrent('image',image)||historyRow.reused&&!this.viewModels.isCurrent('history',history)||checkpointRow.reused&&!this.viewModels.isCurrent('checkpoints',checkpoints)||saveRow.reused&&!this.viewModels.isCurrent('save',save))return;
        // Another same-revision refresh may replace both recognized list owners
        // while this read retains its own old-row pin. That private pin keeps
        // validation safe, but cannot make the retired row publishable again.
        if(!this.documentRowOwner(document))return;
        if(!imageRow.reused)inputs.push(this.viewInput('image',imageRow.model,imageRow.key,image));
        if(!historyRow.reused)inputs.push(this.viewInput('history',historyRow.model,historyRow.key,history.items));
        if(!checkpointRow.reused)inputs.push(this.viewInput('checkpoints',checkpointRow.model,checkpointRow.key,checkpoints.items));
        if(!saveRow.reused)inputs.push(this.viewInput('save',saveRow.model,saveRow.key,save));
        this.publishViewModels(inputs,{document,image,history:history.items,historyNext:history.next,undoAvailable,checkpoints:checkpoints.items,checkpointNext:checkpoints.next,save,selected:this.view.selected.filter(id=>document.orderedLayerIds.includes(id))});installed=true;
        // Only validated, successfully published authority is model-ready. The
        // stored image model and canonical asset do not imply fresh text shaping.
        const navigation=this.navigationTarget();if(navigation&&sessionId===this.sessionId)browserPhases.recordNavigationModelReady({...navigation,snapshotId:published.generation});
      }finally{for(const model of owned)if(!installed||!inputs.some(input=>input.model===model))model.release();}
    });}finally{unpin?.();}
  }
  async open(id:string,persist=true) {
    const span=browserPhases.recorder.start('reopen',{documentId:id});
    const lifetime=this.lifecycle,owner=this.draftOwner,connection=this.session,identity=connection.identity();
    try{
    if(this.closingDocument)await this.closingDocument;
    if(lifetime!==this.lifecycle||owner!==this.draftOwner){span.end('cancelled');return;}
    const document=this.view.documents.find(d=>d.id===id);if(!document)throw Error('DOCUMENT_UNAVAILABLE');
    const documentLifetime=++this.documentLifetime;browserPhases.resetNavigation();
    this.patch({document,review:null,selected:[],image:null,history:[],historyNext:null,checkpoints:[],checkpointNext:null,save:null});await this.loadDocument(document);
    if(lifetime!==this.lifecycle||owner!==this.draftOwner||documentLifetime!==this.documentLifetime||this.view.document?.id!==id){span.end('cancelled',{revision:document.revision});return;}
    if(persist)await this.preferences({documentId:id,selectedLayerIds:[]});else this.patch({selected:this.ui?.preferences.selectedLayerIds.filter(id=>document.orderedLayerIds.includes(id))??[]});
    if(persist&&lifetime===this.lifecycle&&owner===this.draftOwner&&connection===this.session&&identity===connection.identity()&&documentLifetime===this.documentLifetime&&this.view.document?.id===id&&this.view.image!==null){
      browserPhases.recordNavigationAuthority?.({...this.navigationStatusContext(),kind:'opened'});
      this.patch({message:'Local document opened.'});
    }
    // Model recovery is observed here. The independent presentation observer
    // joins viewport decode/draw; this span alone cannot qualify R39 completion.
    span.end(lifetime===this.lifecycle&&owner===this.draftOwner&&documentLifetime===this.documentLifetime?'incomplete':'cancelled',{revision:document.revision,boundary:'observed'});
    }catch(error){span.end('error');throw error;}
  }
  closeDocument(){
    if(this.closingDocument)return this.closingDocument;
    this.closingDocument=this.closeCurrentDocument().finally(()=>{this.closingDocument=undefined;});return this.closingDocument;
  }
  private async closeCurrentDocument(){
    const document=this.view.document;if(!document){
      if(this.documentResources.snapshot.failed){await this.documentResources.release();this.patch({error:'',message:'Document resources released. Saved drafts, history and pending jobs remain local.'});}
      return;
    }
    const owner=this.draftOwner,lifetime=this.lifecycle,documentLifetime=this.documentLifetime;
    const current=()=>owner===this.draftOwner&&lifetime===this.lifecycle&&documentLifetime===this.documentLifetime&&this.view.document?.id===document.id;
    if(!owner||!this.view.ready)throw Error('Connect before closing so the current drafts can be saved.');
    // The live SSE consumer belongs to the session. A previously cancelled
    // recovery must drain before a document can report successful release.
    await this.recoveryDrain;if(!current())throw Error('DOCUMENT_CHANGED');
    await this.flushDrafts();await this.uiTail;
    if(!current())throw Error('DOCUMENT_CHANGED');owner.assertDocumentSaved(document.id);
    await owner.restore();if(!current())throw Error('DOCUMENT_CHANGED');this.ui=owner.checkpoint!;
    await this.preferences({documentId:null,selectedLayerIds:[]});
    if(!current())throw Error('DOCUMENT_CHANGED');owner.assertDocumentSaved(document.id);
    // Preferences and drafts are durable before invalidating any live consumer.
    // Closing never sends a queue cancellation or changes retained history.
    this.documentLifetime++;clearTimeout(this.draftTimer);for(const upload of this.uploads)upload.abort();browserPhases.reset();
    owner.releaseDocument(document.id);
    this.patch({document:null,image:null,review:null,download:null,history:[],historyNext:null,checkpoints:[],checkpointNext:null,selected:[],save:null,drafts:'',error:'',message:'Document closed. Saved drafts, history and pending jobs remain local.'});
    await this.documentResources.release();
    performance.clearMarks('ie.document.closed');performance.mark('ie.document.closed',{detail:{documentId:document.id,...this.documentResources.snapshot}});
  }
  async openCheckpoint(checkpoint:Checkpoint){
    const document=this.view.document;if(!document||checkpoint.documentId!==document.id)throw Error('DOCUMENT_CHANGED');const unpin=this.pinViewModels(document,checkpoint);
    try{await this.viewReads.run(async signal=>{const epoch=this.documentLifetime,current=()=>!signal.aborted&&epoch===this.documentLifetime&&this.view.document?.id===document.id;let after:string|null=null;
      do{const page:OwnedModel<{items:(ImageHistoryNode|HistoryNode)[];next:string|null}>=await this.ownedJSON<{items:(ImageHistoryNode|HistoryNode)[];next:string|null}>('/api/v1/documents/'+document.id+'/history'+(after?'?after='+after:''),'editor-checkpoint-navigation',{signal},current,VIEW_MODEL_LIMITS.responseBytes);
        try{if(!current())return;const node=page.value.items.find(n=>n.id===checkpoint.historyHead);if(node){if(!('kind' in node)&&!node.forward.after.image)throw Error('This retained empty-document checkpoint has no image state to restore.');await this.withCommandEvents({type:'SwitchBranch',branchId:node.branchId,historyNode:node.id},()=>undefined,document);return;}after=page.value.next;}finally{page.release();}
      }while(after);throw Error('CHECKPOINT_CONTENT_UNAVAILABLE');
    });}finally{unpin();}
  }
  async historyPage(kind:'history'|'checkpoints',after:string|null=null){
    const document=this.view.document,cache=this.cache,lifetime=this.lifecycle,documentLifetime=this.documentLifetime;if(!document||!cache)return;const unpin=this.pinViewModels(document);
    try{await this.viewReads.run(async signal=>{const current=()=>!signal.aborted&&lifetime===this.lifecycle&&documentLifetime===this.documentLifetime&&cache===this.cache&&this.view.document?.id===document.id,published=await cache.published();
      const page=await this.ownedJSON<{items:ImageHistoryNode[]|Checkpoint[];next:string|null}>('/api/v1/documents/'+document.id+'/'+kind+(after?'?after='+after:''),'editor-'+kind+'-page',{signal},current,VIEW_MODEL_LIMITS.responseBytes);let installed=false;
      try{const probe=await this.session.transport('/api/v1/documents/'+document.id,{method:'HEAD',signal}),finalPublication=await cache.published();if(!current()||finalPublication.generation!==published.generation)return;
        const revision=probe.headers.get('X-App-Entity-Version');if(!probe.ok||revision===null||!/^(0|[1-9][0-9]*)$/.test(revision))throw Error('DOCUMENT_VERSION_UNAVAILABLE');if(revision!==document.revision||this.view.document!.revision!==document.revision)return;
        const patch=kind==='history'?{history:page.value.items as ImageHistoryNode[],historyNext:page.value.next}:{checkpoints:page.value.items as Checkpoint[],checkpointNext:page.value.next};
        this.publishViewModels([this.viewInput(kind,page,lifetime+':'+document.id+':'+document.revision+':'+kind+':'+(after??'first'),page.value.items)],patch);installed=true;
      }finally{if(!installed)page.release();}
    });}finally{unpin();}
  }
  async listUI(next:string|null=null){
    if(next!==null&&next.length>2048)throw Error('UI_CURSOR_LIMIT');const session=this.session,identity=session.identity(),lifetime=this.lifecycle;
    return this.controlReads.run(async signal=>{const current=()=>!signal.aborted&&session===this.session&&identity===session.identity()&&lifetime===this.lifecycle;
      const page=await this.ownedJSON<UIInventory>('/api/v1/ui'+(next?'?cursor='+next:''),'editor-ui-inventory',{signal},current,65536);let installed=false;
      try{if(page.value.kind!=='ui-inventory'||page.value.semantics!=='current-at-page-read'||!Array.isArray(page.value.items)||page.value.items.length>128)throw Error('UI_INVENTORY_UNAVAILABLE');
        const same=this.viewModels.same<UIInventory>('uiChoices',page.value);if(same){same.release();return;}
        this.publishViewModels([this.viewInput('uiChoices',page,'ui-inventory',page.value.items)],{uiChoices:page.value.items,uiNext:page.value.next});installed=true;
      }finally{if(!installed)page.release();}
    });
  }
  async restoreUI(choice:UIInventory['items'][number]){
    if(this.restoreUIActive)throw Error('A saved checkpoint is already opening. Wait for it to finish.');
    const unpin=this.pinViewModels(choice),session=this.session,identity=session.identity(),lifetime=this.lifecycle,prior=this.draftOwner;let owner:DraftPersistence|undefined,installed=false;this.restoreUIActive=true;
    try{
      if(prior&&(prior.hasRefusedChanges||[...prior.drafts.values()].some(d=>d.generation!==d.savedGeneration||d.pending)))throw Error('Save or cancel the current unsaved draft before restoring another checkpoint.');
      this.assertDraftOwnerCapacity();owner=new DraftPersistence(choice.sessionId,session.transport,session.csrf,this.journal);await owner.restore();
      if(session!==this.session||identity!==session.identity()||lifetime!==this.lifecycle||prior!==this.draftOwner)throw Error('UI_OWNER_CHANGED');
      if(owner.checkpoint!.uiSeq!==choice.uiSeq)throw Error('UI_CHANGED_IN_ANOTHER_TAB');
      this.draftOwner=owner;try{this.ui=owner.checkpoint!;}catch(error){this.draftOwner=prior;throw error;}installed=true;
      sessionStorage.setItem('ie-ui-session:'+this.owner,choice.sessionId);this.patch({drafts:'Restoring saved UI checkpoint…'});if(prior)await this.retireDraftOwner(prior);
      if(this.ui!.preferences.documentId)await this.open(this.ui!.preferences.documentId,false);
      this.patch({selected:this.ui!.preferences.selectedLayerIds,drafts:'Restored UI checkpoint. Drafts remain unapplied.'});
    }finally{try{if(owner&&!installed)await this.retireDraftOwner(owner);}finally{unpin();this.restoreUIActive=false;}}
  }
  async preferences(patch:Partial<Preferences>) {
    const captured=reserveCommandWire(patch);
    const run=async()=>{if(!this.ui)return;const owner=this.draftOwner!,unpin=this.pinUI();try{const request:UIRequest={protocolVersion:1,requestId:crypto.randomUUID(),sessionId:this.sessionId,expectedUISeq:this.ui.uiSeq,body:{type:'SetPreferences',preferences:{...this.ui.preferences,...captured.request}}},receipt=await owner.ownedDispatch(request);
      try{if(receipt.value.status==='rejected'){await owner.restore();if(owner===this.draftOwner)this.ui=owner.checkpoint!;throw Error('UI_CHANGED_IN_ANOTHER_TAB');}if(owner!==this.draftOwner)throw Error('UI_OWNER_CHANGED');this.ui={...this.ui!,uiSeq:receipt.value.uiSeq,preferences:request.body.type==='SetPreferences'?request.body.preferences:this.ui!.preferences};if(this.view.save)this.patchSave({bundleOutdated:true});}finally{receipt.release();}
    }finally{unpin();}};this.uiTail=this.uiTail.catch(()=>{}).then(run).finally(()=>captured.release());return this.uiTail;
  }
  select(ids:string[]) { this.patch({selected:ids});void this.preferences({documentId:this.view.document?.id??null,selectedLayerIds:ids}).catch(e=>this.fail(e)); }
  async run(label:string,action:()=>Promise<void>,intentTime=performance.now()) {
    if(this.view.busy)return;
    this.beginFeedback(intentTime);
    this.patch({busy:true,message:label+'…',error:''});performance.clearMarks('ie.intent.'+label);performance.mark('ie.intent.'+label,{startTime:intentTime});
    // Yield pending feedback without holding asynchronous journal/transport work
    // until the next display frame. Hashing already yields in bounded slices.
    await tick();
    try{await action();}catch(error){this.fail(error);}finally{this.patch({busy:false});performance.clearMarks('ie.complete.'+label);performance.mark('ie.complete.'+label);}
  }
  fail(error:unknown) {
    const code=error instanceof Error&&error.message?(error.message.length<=65536?error.message:'The diagnostic is too large to display. The previous editing state and original delivery remain retained.'):'CONTENT_UNAVAILABLE';
    const message=/STALE|CHANGED|CONFLICT/.test(code)?'Stale conflict. Your draft is retained. Review the current document before applying again.':/STORAGE_FULL|waiting-for-resources|CAPACITY/.test(code)?'Storage paused. Original bytes and command identities are retained. Free resources, then retry the same operation.':/MISSING|CORRUPT|UNAVAILABLE|NOT_FOUND/.test(code)?'Content unavailable or missing. Accepted records are retained; restore the exact resource, then reconnect.':/EXPIRED|SESSION|CSRF/.test(code)?'Connection or review expired. Reconnect and prepare a fresh review; the original command is unchanged.':code==='Failed to fetch'?'Local server disconnected. The original delivery is retained for receipt lookup.':code;
    this.patch({uiPending:this.draftOwner?.pendingRequests()??[],error:message,message:'Action needs attention.'});
  }
  private controlContext(){
    const session=this.session,identity=session.identity(),owner=this.owner,sessionId=this.sessionId,lifetime=this.lifecycle,epoch=this.documentLifetime,journal=this.journal;
    const current=()=>session===this.session&&identity===session.identity()&&owner===this.owner&&sessionId===this.sessionId&&lifetime===this.lifecycle&&epoch===this.documentLifetime&&journal===this.journal;
    const check=(signal?:AbortSignal)=>{if(signal?.aborted||!current())throw new DOMException('The original command owner changed. Its journaled delivery remains available.','AbortError');};
    return {session,identity,owner,sessionId,journal,current,check};
  }
  async ownedCommand(body:Command['body'],document:Pick<Document,'id'|'revision'>|null=this.view.document,newId?:string,onJournaled?:(commandId:string)=>void):Promise<OwnedModel<DomainEvent[]>> {
    const scope=this.controlContext();if(!scope.owner||!scope.identity||scope.owner!==scope.identity||!scope.journal)throw Error('SESSION_REQUIRED');const journal=scope.journal;
    const validation=browserPhases.recorder.start('component.proposal',{...(document?{documentId:document.id,revision:document.revision}:{})});
    const proposal:CommandRequest={protocolVersion:1,command:{schemaVersion:1,commandId:crypto.randomUUID(),clientId:scope.owner,sessionId:scope.sessionId,correlationId:crypto.randomUUID(),causationId:null,transactionId:crypto.randomUUID(),documentId:newId??document?.id??null,expectedDocumentRevision:document?.revision??null,expectedEntityVersions:EMPTY_EXPECTED_VERSIONS,issuedAt:new Date().toISOString(),body}};
    let envelope:ReturnType<typeof reserveCommandWire<CommandRequest>>;
    try{envelope=reserveCommandWire(proposal);}catch(error){validation.end('error');throw error;}
    const request=envelope.request;
    try{
    const context={commandId:request.command.commandId,transactionId:request.command.transactionId,correlationId:request.command.correlationId,...(request.command.documentId?{documentId:request.command.documentId}:{}),...(document?{revision:document.revision}:{})};
    validation.end('ok',context);const adoptionId=adoptionTraceId(request.command.body);if(adoptionId)browserPhases.bindAdoption(adoptionId,context);
    const delivery:Delivery={request,wire:envelope.wire,label:request.command.body.type};
    const phase=commandPhase(request.command.body.type),operation=phase?browserPhases.recorder.start(phase,context):undefined;
    // A cancel requested immediately after journaling must follow the original
    // submission's admission response. Waiting for the full command here would
    // prevent cancellation while the encoder is actually running.
    let submitted:(()=>void)|undefined;
    if(request.command.body.type==='InspectRasterOriginal'||request.command.body.type==='PrepareRaster')this.importAdmissions.set(request.command.commandId,new Promise<void>(resolve=>{submitted=resolve;}));
    else if(request.command.body.type==='ExportDocument')this.exportAdmissions.set(request.command.commandId,new Promise<void>(resolve=>{submitted=resolve;}));
    else if(request.command.body.type==='ReviewCandidatePlacement'&&request.command.body.preparation==='encoded-rebuild')this.reviewAdmissions.set(request.command.commandId,new Promise<void>(resolve=>{submitted=resolve;}));
    try{
    return await this.controlReads.run(async signal=>{scope.check(signal);
    await journal.put('command:'+request.command.commandId,delivery);scope.check(signal);
    onJournaled?.(request.command.commandId);scope.check(signal);
    await this.restorePending(undefined,signal);scope.check(signal);
    const events=await this.deliverOwned(delivery,false,signal,submitted,scope);try{scope.check(signal);const registered=events.value.find(e=>e.type==='AssetRegistered');operation?.end('incomplete',{boundary:request.command.body.type==='PrepareCandidateAdoption'?'prepared-durable':'authority-durable',...(registered?.type==='AssetRegistered'?{outputAssetId:registered.payload.asset.id,assetHash:registered.payload.asset.blob.hash}:{})});return events;}catch(error){events.release();throw error;}
    });
    }catch(error){operation?.end('error');throw error;}finally{submitted?.();this.importAdmissions.delete(request.command.commandId);this.exportAdmissions.delete(request.command.commandId);this.reviewAdmissions.delete(request.command.commandId);}
    }finally{envelope.release();}
  }
  async command(body:Command['body'],document:Pick<Document,'id'|'revision'>|null=this.view.document,newId?:string,onJournaled?:(commandId:string)=>void):Promise<DomainEvent[]> {
    if(!this.owner)throw Error('SESSION_REQUIRED');
    const validation=browserPhases.recorder.start('component.proposal',{...(document?{documentId:document.id,revision:document.revision}:{})});
    const proposal:CommandRequest={protocolVersion:1,command:{schemaVersion:1,commandId:crypto.randomUUID(),clientId:this.owner,sessionId:this.sessionId,correlationId:crypto.randomUUID(),causationId:null,transactionId:crypto.randomUUID(),documentId:newId??document?.id??null,expectedDocumentRevision:document?.revision??null,expectedEntityVersions:EMPTY_EXPECTED_VERSIONS,issuedAt:new Date().toISOString(),body}};
    let envelope:ReturnType<typeof reserveCommandWire<CommandRequest>>;
    try{envelope=reserveCommandWire(proposal);}catch(error){validation.end('error');throw error;}
    const request=envelope.request;
    try{
    const context={commandId:request.command.commandId,transactionId:request.command.transactionId,correlationId:request.command.correlationId,...(request.command.documentId?{documentId:request.command.documentId}:{}),...(document?{revision:document.revision}:{})};
    validation.end('ok',context);const adoptionId=adoptionTraceId(body);if(adoptionId)browserPhases.bindAdoption(adoptionId,context);
    const delivery:Delivery={request,wire:envelope.wire,label:body.type};
    const phase=commandPhase(body.type),operation=phase?browserPhases.recorder.start(phase,context):undefined;
    // A cancel requested immediately after journaling must follow the original
    // submission's admission response. Waiting for the full command here would
    // prevent cancellation while the encoder is actually running.
    let submitted:(()=>void)|undefined;
    if(body.type==='InspectRasterOriginal'||body.type==='PrepareRaster')this.importAdmissions.set(request.command.commandId,new Promise<void>(resolve=>{submitted=resolve;}));
    else if(body.type==='ExportDocument')this.exportAdmissions.set(request.command.commandId,new Promise<void>(resolve=>{submitted=resolve;}));
    else if(body.type==='ReviewCandidatePlacement'&&body.preparation==='encoded-rebuild')this.reviewAdmissions.set(request.command.commandId,new Promise<void>(resolve=>{submitted=resolve;}));
    try{
    await this.journal!.put('command:'+request.command.commandId,delivery);
    onJournaled?.(request.command.commandId);
    await this.restorePending();
    const events=await this.deliver(delivery,false,submitted);const registered=events.find(e=>e.type==='AssetRegistered');operation?.end('incomplete',{boundary:body.type==='PrepareCandidateAdoption'?'prepared-durable':'authority-durable',...(registered?.type==='AssetRegistered'?{outputAssetId:registered.payload.asset.id,assetHash:registered.payload.asset.blob.hash}:{})});return events;
    }catch(error){operation?.end('error');throw error;}finally{submitted?.();this.importAdmissions.delete(request.command.commandId);this.exportAdmissions.delete(request.command.commandId);this.reviewAdmissions.delete(request.command.commandId);}
    }finally{envelope.release();}
  }
  private async deliver(delivery:Delivery,lookup:boolean,submitted?:()=>void):Promise<DomainEvent[]> {
    const id=delivery.request.command.commandId;
    const command=delivery.request.command,context:PhaseContext={commandId:id,transactionId:command.transactionId,correlationId:command.correlationId,...(command.documentId?{documentId:command.documentId}:{}),...(command.expectedDocumentRevision?{revision:command.expectedDocumentRevision}:{}),replay:lookup};
    const acceptance=browserPhases.recorder.start('command.accept',context);
    const adoptionId=adoptionTraceId(command.body);
    try{
    let value:CommandResult;
    try{
      if(lookup){const response=await this.session.transport('/api/v1/commands/'+id);value=await response.json();if(value.kind==='unknown'||value.kind==='pending'&&value.phase==='waiting-for-resources')value=await this.json('/api/v1/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:delivery.wire});}
      else value=await this.json('/api/v1/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:delivery.wire});
    }finally{submitted?.();}
    let receiptDelay=0;
    for(;;){
      delivery={...delivery,result:value};await this.journal!.put('command:'+id,delivery);await this.restorePending();
      if(value.kind!=='pending')break;
      if(value.phase==='waiting-for-resources')throw Error('waiting-for-resources');
      // A local command can finish while its pending identity is journaled.
      // Probe promptly, then back off to the existing sustained cadence. Only
      // one lookup is in flight; a wake never substitutes for its exact receipt.
      await pause(receiptDelay);receiptDelay=receiptDelay===0?4:Math.min(30,receiptDelay*2);
      value=await this.json<CommandResult>('/api/v1/commands/'+id);
    }
    if(value.kind!=='receipt')throw Error('RECEIPT_UNKNOWN');
    if(value.receipt.status==='rejected'){
      acceptance.end('rejected',{boundary:'authority-durable'});if(adoptionId)browserPhases.adoptionFailed(adoptionId,'rejected');
      const detail=value.rejectionDetails?.kind==='inline'?JSON.stringify(value.rejectionDetails.value):'';
      throw Error(value.receipt.code+' '+detail);
    }
    // Exact result inspection and complete projection recovery are independent
    // reads of an already durable receipt. Keep both proofs, without serial
    // transport waits. A joined older recovery must still reach this receipt.
    const receipt=value.receipt;
    const receivedAt=performance.now();acceptance.end('ok',{boundary:'authority-durable'});
    const [events]=await Promise.all([this.events(receipt),(async()=>{do{await this.sync();}while(BigInt((await this.cache!.published()).cursor)<BigInt(receipt.toSeq));})()]);
    if(adoptionId){const adopted=events.find(e=>e.type==='ImageEdited'||e.type==='DocumentCreated');if(adopted&&(adopted.type==='ImageEdited'||adopted.type==='DocumentCreated')){const d=adopted.payload.document;if(d.image?.compositeAssetId)browserPhases.adoptionDurable(id,{documentId:d.id,revision:d.revision,assetId:d.image.compositeAssetId},receivedAt);}}
    await this.draftOwner?.restoreForCommand();this.ui=this.draftOwner?.checkpoint??undefined;this.startStream(this.lifecycle);
    this.recordNavigationCheckpoint(delivery.request.command,receipt);
    this.patch({message:delivery.label+' accepted and saved locally.',recovery:'',drafts:this.draftStatus()});return events;
    }catch(error){acceptance.end('error');if(adoptionId)browserPhases.adoptionFailed(adoptionId);throw error;}
  }
  private async deliverOwned(delivery:Delivery,lookup:boolean,signal:AbortSignal,submitted?:()=>void,scope=this.controlContext()):Promise<OwnedModel<DomainEvent[]>> {
    scope.check(signal);const journal=scope.journal;if(!journal)throw Error('COMMAND_JOURNAL_UNAVAILABLE');
    const command=delivery.request.command,id=command.commandId,session=scope.session,context:PhaseContext={commandId:id,transactionId:command.transactionId,correlationId:command.correlationId,...(command.documentId?{documentId:command.documentId}:{}),...(command.expectedDocumentRevision?{revision:command.expectedDocumentRevision}:{}),replay:lookup};
    const acceptance=browserPhases.recorder.start('command.accept',context),adoptionId=adoptionTraceId(command.body);let value:OwnedModel<CommandResult>|undefined,events:OwnedModel<DomainEvent[]>|undefined,returned=false;
    const read=(path:string,init?:RequestInit)=>{scope.check(signal);return readOwnedJSON<CommandResult>(session.transport.bind(session),path,{owner:'command-result-receipt',init:{...init,signal},owns:scope.current,maxBytes:COMMAND_RESULT_LIMITS.controlBytes});};
    const validate=(result:CommandResult)=>{if(result.protocolVersion!==1||!['unknown','pending','receipt'].includes(result.kind)||result.kind!=='receipt'&&result.commandId!==id||result.kind==='receipt'&&(result.receipt.commandId!==id||!['accepted','rejected'].includes(result.receipt.status)||result.receipt.status==='accepted'&&(result.receipt.transactionId!==command.transactionId||!/^([1-9][0-9]{0,127})$/.test(result.receipt.fromSeq)||!/^([1-9][0-9]{0,127})$/.test(result.receipt.toSeq)||BigInt(result.receipt.toSeq)<BigInt(result.receipt.fromSeq))))throw Error('RECEIPT_UNKNOWN');};
    try{
      try{value=await read(lookup?'/api/v1/commands/'+id:'/api/v1/commands',lookup?undefined:{method:'POST',headers:{'Content-Type':'application/json'},body:delivery.wire});validate(value.value);
        if(lookup&&(value.value.kind==='unknown'||value.value.kind==='pending'&&value.value.phase==='waiting-for-resources')){const next=await read('/api/v1/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:delivery.wire});value.release();value=next;validate(value.value);}
      }finally{submitted?.();}
      let delay=0;for(;;){scope.check(signal);await journal.put('command:'+id,{...delivery,result:value.value});scope.check(signal);await this.restorePending(undefined,signal);scope.check(signal);if(value.value.kind!=='pending')break;if(value.value.phase==='waiting-for-resources')throw Error('waiting-for-resources');await pause(delay);delay=delay===0?4:Math.min(30,delay*2);const next=await read('/api/v1/commands/'+id);value.release();value=next;validate(value.value);}
      if(value.value.kind!=='receipt')throw Error('RECEIPT_UNKNOWN');
      if(value.value.receipt.status==='rejected'){acceptance.end('rejected',{boundary:'authority-durable'});if(adoptionId)browserPhases.adoptionFailed(adoptionId,'rejected');const details=value.value.rejectionDetails?.kind==='inline'?reserveCommandWire(value.value.rejectionDetails.value):undefined;try{throw Error(value.value.receipt.code+' '+(details?.wire??''));}finally{details?.release();}}
      const receipt=value.value.receipt,receivedAt=performance.now();acceptance.end('ok',{boundary:'authority-durable'});
      const outcomes=await Promise.allSettled([readCommandEvents(session.transport.bind(session),receipt,signal),(async()=>{do{scope.check(signal);await this.sync();scope.check(signal);}while(BigInt((await this.cache!.published()).cursor)<BigInt(receipt.toSeq));})()]);
      if(outcomes[0].status==='fulfilled')events=outcomes[0].value;
      const errors=outcomes.filter((result):result is PromiseRejectedResult=>result.status==='rejected').map(result=>result.reason);if(errors.length)throw new AggregateError(errors,'COMMAND_RESULT_PROOF_FAILED');
      scope.check(signal);
      if(adoptionId){const adopted=events!.value.find(event=>event.type==='ImageEdited'||event.type==='DocumentCreated');if(adopted&&(adopted.type==='ImageEdited'||adopted.type==='DocumentCreated')){const d=adopted.payload.document;if(d.image?.compositeAssetId)browserPhases.adoptionDurable(id,{documentId:d.id,revision:d.revision,assetId:d.image.compositeAssetId},receivedAt);}}
      scope.check(signal);const draftOwner=this.draftOwner;await draftOwner?.restoreForCommand();scope.check(signal);if(draftOwner!==this.draftOwner)throw Error('UI_OWNER_CHANGED');this.ui=draftOwner?.checkpoint??undefined;this.startStream(this.lifecycle);this.recordNavigationCheckpoint(command,receipt);this.patch({message:delivery.label+' accepted and saved locally.',recovery:'',drafts:this.draftStatus()});returned=true;return events!;
    }catch(error){acceptance.end('error');if(adoptionId)browserPhases.adoptionFailed(adoptionId);throw error;}finally{value?.release();if(!returned)events?.release();}
  }
  async ownedRetry(id:string):Promise<OwnedModel<DomainEvent[]>>{
    const scope=this.controlContext(),journal=scope.journal;if(!journal)throw Error('COMMAND_JOURNAL_UNAVAILABLE');
    const copy=allocationLedger.reserve({owner:'command-retry-control',kind:'control',cpuBytes:1024*1024,handles:1});
    try{return await this.controlReads.run(async signal=>{scope.check(signal);const delivery=await journal.get<Delivery>('command:'+id);scope.check(signal);if(!delivery)throw Error('COMMAND_UNAVAILABLE');return this.deliverOwned(delivery,true,signal,undefined,scope);});}finally{copy.release();}
  }
  private async events(receipt:Extract<Receipt,{status:'accepted'}>):Promise<DomainEvent[]> {
    const page=await this.json<EventPage>('/api/v1/commands/'+receipt.commandId+'/result');
    if(page.kind!=='batches')throw Error('TRANSACTION_UNAVAILABLE');
    try{
      const batch=page.batches[0];if(!batch||batch.fromSeq!==receipt.fromSeq||batch.toSeq!==receipt.toSeq||batch.transactionId!==receipt.transactionId)throw Error('TRANSACTION_UNAVAILABLE');
      const outputs=new Map<string,DomainEvent>();let count=0n;
      const accept=(event:DomainEvent)=>{validateEvent(event);if(event.commandId!==receipt.commandId||event.transactionId!==receipt.transactionId||BigInt(event.workspaceSeq)!==BigInt(receipt.fromSeq)+count)throw Error('TRANSACTION_CHANGED');count++;outputs.set(event.type,event);};
      if(batch.kind==='inline')batch.events.forEach(accept);
      else{
        const ref=batch.content;const response=await this.session.transport(ref.url);
        if(!response.ok||!response.body||response.headers.get('etag')!=='"'+ref.blob.hash+'"'||response.headers.get('content-length')!==ref.blob.byteLength){await response.body?.cancel();throw Error('TRANSACTION_UNAVAILABLE');}
        // At most one partial line, one joined line and its replacement tail
        // overlap. This reserves before every application-created byte array;
        // the browser-owned response buffer is accounted when delivered.
        const hash=new SHA256();let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,readerLease:ReturnType<typeof allocationLedger.reserve>|undefined,assembly:ReturnType<typeof allocationLedger.reserve>|undefined,length=0n,pending=new Uint8Array(0);
        try{assembly=allocationLedger.reserve({owner:'events-line-assembly',kind:'copy',cpuBytes:65536,handles:3});readerLease=allocationLedger.reserve({owner:'events-response-reader',kind:'staging',handles:1});reader=response.body.getReader();for(;;){const {done,value}=await reader.read();if(done)break;
          const incoming=allocationLedger.reserve({owner:'events-received-chunk',kind:'staging',cpuBytes:value.byteLength,handles:1});
          try{length+=BigInt(value.length);hash.update(value);
            for(let offset=0;offset<value.length;offset+=16384){const chunk=value.subarray(offset,offset+16384),joined=new Uint8Array(pending.length+chunk.length);joined.set(pending);joined.set(chunk,pending.length);let start=0;
              for(let i=0;i<joined.length;i++)if(joined[i]===10){if(i-start>16384)throw Error('TRANSACTION_CORRUPT');accept(parseControlJSON(joined.subarray(start,i)) as DomainEvent);start=i+1;}
              if(joined.length-start>16384)throw Error('TRANSACTION_CORRUPT');pending=joined.slice(start);
            }
          }finally{incoming.release();}
        }}finally{try{if(reader)await reader.cancel();else await response.body.cancel();}finally{
          assembly?.release();try{reader?.releaseLock();readerLease?.release();}catch{readerLease?.markUnused();}
        }}
        if(pending.length||String(length)!==ref.blob.byteLength||hash.digest()!==ref.blob.hash||String(count)!==ref.recordCount)throw Error('TRANSACTION_CORRUPT');
      }
      if(count!==BigInt(receipt.toSeq)-BigInt(receipt.fromSeq)+1n)throw Error('TRANSACTION_INCOMPLETE');
      const proof=await this.json<EventPage>('/api/v1/events?after='+receipt.toSeq+'&recoveryId='+page.recovery.recoveryId);
      if(proof.more||proof.batches.length||proof.recovery.writerEpoch!==page.recovery.writerEpoch)throw Error('TRANSACTION_CHANGED');
      return [...outputs.values()];
    }finally{await this.post('/api/v1/recovery/'+page.recovery.recoveryId+'/release',{protocolVersion:1}).catch(()=>{});}
  }
  private async discoverPending() {
    const journal=this.journal!,identity=this.owner,session=this.session,lifetime=this.lifecycle;
    return this.controlReads.run(async signal=>{let cursor:string|null=null;const current=()=>!signal.aborted&&journal===this.journal&&identity===this.owner&&session===this.session&&lifetime===this.lifecycle;
      do{const page:OwnedModel<PendingInventory>=await this.ownedJSON<PendingInventory>('/api/v1/commands/pending'+(cursor?'?cursor='+cursor:''),'pending-command-inventory',{signal},current,65536);
        try{if(page.value.kind!=='pending-inventory'||page.value.semantics!=='pending-at-page-read'||!Array.isArray(page.value.items)||page.value.items.length>128)throw Error('PENDING_INVENTORY_UNAVAILABLE');
          for(const item of page.value.items){if(!current())throw Error('PENDING_OWNER_CHANGED');if(await journal.has('command:'+item.commandId))continue;
            const admitted=allocationLedger.reserve({owner:'pending-original-response',kind:'control',handles:1});let response:Response;
            try{response=await session.transport('/api/v1/commands/'+item.commandId+'/original',{signal});}catch(error){admitted.release();throw error;}
            const header=response.headers.get('content-length'),size=header!==null&&/^(0|[1-9][0-9]*)$/.test(header)?Number(header):NaN;
            const retained=await readRetainedPrompt(response,response.ok&&size<=65536?size:NaN,current,signal,admitted);
            try{const scratch=allocationLedger.reserve({owner:'pending-original-decode',kind:'control',cpuBytes:retained.text.length*12+4096,handles:3});
              try{const request=parseControlJSON(new TextEncoder().encode(retained.text)) as CommandRequest,hash=canonicalControlHash(request);
                if(request.command.clientId!==identity||request.command.commandId!==item.commandId||hash!==item.commandHash)throw Error('ORIGINAL_COMMAND_CHANGED');
                await this.withJSON<CommandResult,void>('/api/v1/commands/'+item.commandId,'pending-original-receipt',async result=>{if(!current())throw Error('PENDING_OWNER_CHANGED');await journal.put('command:'+item.commandId,{request,wire:retained.text,result,label:item.label} satisfies Delivery);},{signal},current);
              }finally{scratch.release();}
            }finally{retained.lease.release();}
          }
          if(page.value.next!==null&&(typeof page.value.next!=='string'||page.value.next.length>2048))throw Error('PENDING_CURSOR_LIMIT');cursor=page.value.next;
        }finally{page.release();}
      }while(cursor);
    });
  }
  /** Keyset navigation over the exact local delivery records. These cursors
   * describe a page read, not a total or a frozen inventory across receipts. */
  async listPending(page:'first'|'previous'|'next'='first') {
    if(!['first','previous','next'].includes(page))throw Error('PENDING_PAGE_INVALID');
    const after=page==='first'?null:page==='previous'?this.view.pendingPrevious:this.view.pendingNext;
    if(page!=='first'&&after===null)return;
    await this.restorePending({after,direction:page==='previous'?'prev':'next'});
  }
  private async restorePending(selection?:{after:string|null;direction:'next'|'prev'},trackedSignal?:AbortSignal) {
    const journal=this.journal;if(!journal)return;const read=++this.pendingRead,lifetime=this.lifecycle,owner=this.owner,session=this.session,identity=session.identity();
    // Own captured cursor scalars before the tracked read's first async turn.
    // Native IDB cloning retains its existing explicit one-record uncertainty.
    const cursorBytes=4*256*2,metadata=new ModelPayload(allocationLedger.reserve({owner:'command-pending-control',kind:'control',cpuBytes:cursorBytes,handles:1})),selected=selection??{after:this.view.pendingAfter,direction:this.view.pendingDirection};let installed=false;
    const work=async(signal:AbortSignal)=>{
      const pending:Delivery[]=[];
      const current=()=>!signal.aborted&&read===this.pendingRead&&lifetime===this.lifecycle&&journal===this.journal&&owner===this.owner&&session===this.session&&identity===session.identity();
      let after=selected.after,direction=selected.direction,first:string|null=null,last:string|null=null,more=false;
      const collect=async()=>{await journal.scan<Delivery>('command:',(delivery,key)=>{
        if(!current())return false;if(delivery.result?.kind==='receipt')return;
        if(pending.length===32){more=true;return false;}
        metadata.resize(cursorBytes+(pending.length+1)*1024*1024,pending.length+2);pending.push(delivery);
        first??=key;last=key;
      },{after,direction});};
      if(!current())return;await collect();if(!current())return;
        // A last-page receipt may resolve the entire selected range. One
        // bounded first-page fallback leaves remaining deliveries reachable.
        if(!pending.length&&after!==null){after=null;direction='next';more=false;first=null;last=null;await collect();if(!current())return;}
        if(direction==='prev'){pending.reverse();const priorFirst=first;first=last;last=priorFirst;}
        let earlier=direction==='prev'&&more,later=direction==='next'&&more;
        if(pending.length&&after!==null){const boundary=direction==='next'?first:last;let opposite=false;
          await journal.scan<Delivery>('command:',delivery=>{if(!current())return false;if(delivery.result?.kind==='receipt')return;opposite=true;return false;},{after:boundary,direction:direction==='next'?'prev':'next'});
          if(!current())return;if(direction==='next')earlier=opposite;else later=opposite;
        }
        const pendingCreate=await this.pendingCreation(journal,current);if(!current())return;
        const model={value:pending,release:()=>metadata.release(),pin:()=>metadata.pin()};
        this.publishViewModels([this.viewInput('pending',model,'pending-deliveries',pending)],{pending,pendingAfter:after,pendingDirection:direction,pendingPrevious:earlier?first:null,pendingNext:later?last:null,pendingCreate});installed=true;
    };
    // An owned command already supplies a tracked signal and awaits this work;
    // independent navigation must register its own drainable operation.
    try{if(trackedSignal)await work(trackedSignal);else await this.controlReads.run(work);}finally{if(!installed)metadata.release();}
  }
  private async unresolvedCreation():Promise<boolean>{
    const journal=this.journal;if(!journal)return this.view.pending.some(item=>item.request.command.body.type==='CreateDocument');
    const lifetime=this.lifecycle,owner=this.owner,session=this.session,identity=session.identity();
    return this.controlReads.run(async signal=>{const current=()=>!signal.aborted&&journal===this.journal&&lifetime===this.lifecycle&&owner===this.owner&&session===this.session&&identity===session.identity();if(!current())throw Error('PENDING_OWNER_CHANGED');const found=await this.pendingCreation(journal,current);if(!current())throw Error('PENDING_OWNER_CHANGED');return found;});
  }
  private async pendingCreation(journal:BrowserJournal,current:()=>boolean):Promise<boolean>{
    let found=false;if(!current())return false;await journal.scan<Delivery>('command:',delivery=>{if(!current())return false;if(delivery.result?.kind!=='receipt'&&delivery.request.command.body.type==='CreateDocument'){found=true;return false;}});return found;
  }
  async retry(id:string) {
    const copy=allocationLedger.reserve({owner:'command-retry-control',kind:'control',cpuBytes:1024*1024,handles:1});
    try{const delivery=await this.journal!.get<Delivery>('command:'+id);if(!delivery)throw Error('COMMAND_UNAVAILABLE');return await this.deliver(delivery,true);}finally{copy.release();}
  }
  async listStages(cursor:string|null=null){
    if(cursor!==null&&cursor.length>2048)throw Error('STAGING_CURSOR_LIMIT');const identity=this.session.identity(),lifetime=this.lifecycle;
    return this.controlReads.run(async signal=>{const page=await this.ownedJSON<StagingRecoveryPage>('/api/v1/assets/staging/recovery'+(cursor?'?cursor='+cursor:''),'editor-staging-inventory',{signal},()=>identity===this.session.identity()&&lifetime===this.lifecycle,65536);let installed=false;
      try{if(page.value.protocolVersion!==1||!Array.isArray(page.value.items)||page.value.items.length>128)throw Error('STAGING_INVENTORY_UNAVAILABLE');const same=this.viewModels.same<StagingRecoveryPage>('stages',page.value);if(same){same.release();return;}
        this.publishViewModels([this.viewInput('stages',page,'staging-inventory',page.value.items)],{stages:page.value.items,stageNext:page.value.nextCursor});installed=true;
      }finally{if(!installed)page.release();}
    });
  }
  async resumeStage(file:File,id:string){
    return this.withJSON<StagingRecord,void>('/api/v1/assets/staging/'+id,'editor-staging-resume',async stage=>{
      if(stage.ownerClientId!==this.owner)throw Error('OWNER_REQUIRED');
      if(stage.purpose==='image')await this.importImage(file,stage);else if(stage.purpose==='bundle')await this.openBundle(file,stage);else throw Error('This staged content is retained; it has no active editor import workflow.');
    });
  }
  async ownedUpload(file:Blob,purpose:StagingCreateRequest['purpose'],mediaType:string,existing?:StagingRecord,stillCurrent:()=>boolean=()=>true,externalSignal?:AbortSignal,diagnosticUpload?:AdapterOpaqueUpload):Promise<OwnedModel<StagingCreateRequest>> {
    return this.controlReads.run(async operationSignal=>{
      const staging=browserPhases.recorder.start('asset.stage',{bytes:file.size}),session=this.session,identity=session.identity(),sessionId=this.sessionId,draftOwner=this.draftOwner,lifetime=this.lifecycle,documentLifetime=this.documentLifetime,owner=this.owner,abort=new AbortController(),forward=()=>abort.abort();
      operationSignal.addEventListener('abort',forward,{once:true});if(operationSignal.aborted)abort.abort();this.uploads.add(abort);let settled!:()=>void;this.uploadSettlements.set(abort,new Promise<void>(resolve=>settled=resolve));
      let request:OwnedModel<StagingCreateRequest>|undefined,stage:OwnedModel<StagingRecord>|undefined,returned=false;
      const check=()=>{if(abort.signal.aborted||session!==this.session||identity!==session.identity()||sessionId!==this.sessionId||draftOwner!==this.draftOwner||lifetime!==this.lifecycle||documentLifetime!==this.documentLifetime||owner!==this.owner||!stillCurrent()){abort.abort();throw Error('UPLOAD_OWNER_CHANGED');}};
      const read=<T>(path:string,init:RequestInit={})=>{check();return readOwnedJSON<T>(session.transport.bind(session),path,{owner:'upload-control-response',init:{...init,signal:abort.signal},owns:()=>{check();return true;},maxBytes:COMMAND_RESULT_LIMITS.controlBytes});};
      try{
        if(diagnosticUpload){request=await diagnosticUpload({file,purpose,mediaType,existing,transport:session.transport.bind(session),check,signal:abort.signal,tick,
          owner:{sessionId,draftSessionId:draftOwner?.sessionId??null,documentId:this.view.document?.id??null,documentEpoch:documentLifetime,editorEpoch:lifetime,clientId:identity}});
          check();staging.end('ok',{assetHash:request.value.sha256,boundary:'local-durable'});returned=true;return request;}
        check();if(typeof mediaType!=='string'||mediaType.length>256||existing&&(!/^[A-Za-z0-9_-]{1,128}$/.test(existing.stagingId)||existing.mediaType.length>256))throw Error('UPLOAD_CONTROL_LIMIT');
        const digestOwner=reserveModelBytes('upload-digest-workspace',4096,2);let sha256:string;
        try{const hash=new SHA256();let at=0,started=performance.now();while(at<file.size){check();const length=Math.min(65536,file.size-at),buffer=allocationLedger.reserve({owner:'upload-hash-buffer',kind:'staging',cpuBytes:length,handles:1});try{const bytes=new Uint8Array(await file.slice(at,at+length).arrayBuffer());check();hash.update(bytes);at+=bytes.length;}finally{buffer.release();}if(performance.now()-started>4){await tick();check();started=performance.now();}}sha256=hash.digest();}finally{digestOwner.release();}
        if(existing&&(existing.sha256!==sha256||existing.expectedBytes!==String(file.size)))throw Error('ORIGINAL_FILE_HASH_MISMATCH');
        request=createOwnedModel<StagingCreateRequest>('upload-retained-request',4096,()=>({protocolVersion:1,stagingId:existing?.stagingId??crypto.randomUUID(),purpose:existing?.purpose??purpose,expectedBytes:String(file.size),sha256,mediaType:existing?.mediaType??mediaType}));
        if(!existing){const wire=reserveCommandWire(request.value);try{const created=await read('/api/v1/assets/staging',{method:'POST',headers:{'Content-Type':'application/json'},body:wire.wire});created.release();}finally{wire.release();}}
        let currentStage:OwnedModel<StagingRecord>=await read<StagingRecord>('/api/v1/assets/staging/'+request.value.stagingId);stage=currentStage;
        const validate=()=>{const value=currentStage.value;if(value.stagingId!==request!.value.stagingId||value.sha256!==sha256||value.expectedBytes!==String(file.size)||!/^(0|[1-9][0-9]*)$/.test(value.committedOffset)||value.committedOffset.length>32||BigInt(value.committedOffset)>BigInt(file.size))throw Error('STAGING_CHANGED');};validate();
        while(BigInt(currentStage.value.committedOffset)<BigInt(file.size)){check();const offset=Number(currentStage.value.committedOffset),length=Math.min(1048576,file.size-offset),transfer=allocationLedger.reserve({owner:'upload-put-body',kind:'staging',cpuBytes:length*2,handles:2});try{const bytes=await file.slice(offset,offset+length).arrayBuffer();check();const next:OwnedModel<StagingRecord>=await read<StagingRecord>('/api/v1/assets/staging/'+request.value.stagingId,{method:'PUT',headers:{'Content-Type':'application/octet-stream','Upload-Offset':currentStage.value.committedOffset},body:bytes});currentStage.release();stage=currentStage=next;validate();if(BigInt(currentStage.value.committedOffset)<=BigInt(offset))throw Error('STAGING_NOT_ADVANCING');}finally{transfer.release();}}
        check();staging.end('ok',{assetHash:sha256,boundary:'local-durable'});returned=true;return request;
      }catch(error){staging.end('error');throw error;}finally{stage?.release();if(!returned)request?.release();operationSignal.removeEventListener('abort',forward);abort.abort();this.uploads.delete(abort);this.uploadSettlements.delete(abort);settled();}
    },externalSignal);
  }
  async ownedStageTextBlob(blob:Blob,mediaType:string,purpose:StagingCreateRequest['purpose']='text',stillCurrent:()=>boolean=()=>true):Promise<OwnedModel<BlobRef>> {
    const session=this.session,identity=session.identity(),epoch=this.documentLifetime,lifetime=this.lifecycle,owner=this.draftOwner,current=()=>stillCurrent()&&session===this.session&&identity===session.identity()&&epoch===this.documentLifetime&&lifetime===this.lifecycle&&owner===this.draftOwner;
    const stage=await this.ownedUpload(blob,purpose,purpose==='caption'?'text/plain':'application/octet-stream',undefined,current);
    try{if(!current())throw Error('UPLOAD_OWNER_CHANGED');return await this.withCommandEvents({type:'FinalizeStaging',stagingId:stage.value.stagingId,expectedSha256:stage.value.sha256},events=>{if(!current())throw Error('UPLOAD_OWNER_CHANGED');const asset=this.asset(events);if(typeof mediaType!=='string'||mediaType.length>256)throw Error('BLOB_MEDIA_TYPE_LIMIT');return createOwnedModel('text-blob-result',modelPayloadBytes(asset.blob)+mediaType.length*2+64,()=>({...asset.blob,mediaType}));},null);}finally{stage.release();}
  }
  async ownedFontAssets(requested:readonly FontVersion[]):Promise<OwnedModel<Asset[]>> {
    const count=requested.length;if(count>16)throw Error('FONT_SELECTION_LIMIT');
    // Snapshot projections are individually bounded to 64 KiB; the allowance
    // precedes native cursor clone exposure and the complete returned array.
    const payload=reserveModelBytes('font-asset-results',count*65536*4,count+2);let installed=false;
    try{const wanted=new Set<string>();for(const font of requested){if(typeof font.id!=='string'||font.id.length>128)throw Error('FONT_SELECTION_LIMIT');wanted.add(font.id);}const cache=this.cache!,values=await cache.collect<Asset>('asset',asset=>{const id=asset.font?.id;if(!id||!wanted.has(id))return false;wanted.delete(id);return true;},wanted.size);if(this.cache!==cache)throw Error('FONT_LIBRARY_CHANGED');const bytes=modelPayloadBytes(values);if(bytes>count*65536*4)throw Error('FONT_ASSET_METADATA_LIMIT');payload.resize(bytes,values.length+1);installed=true;return Object.freeze({value:values,release:()=>payload.release(),pin:()=>payload.pin()});}finally{if(!installed)payload.release();}
  }
  async ownedPrepareExport(options:DocumentExportOptions|undefined,document:Document,onJournaled?:(commandId:string)=>void):Promise<OwnedModel<Asset>> {
    return this.withCommandEvents({type:'ExportDocument',historyHead:document.historyHead,...(options?{options}:{})},events=>cloneOwnedModel('export-command-asset',this.asset(events)),document,undefined,onJournaled);
  }
  async upload(file:Blob,purpose:StagingCreateRequest['purpose'],mediaType:string,existing?:StagingRecord,stillCurrent:()=>boolean=()=>true,externalSignal?:AbortSignal) {
    const staging=browserPhases.recorder.start('asset.stage',{bytes:file.size});
    const session=this.session,identity=session.identity(),sessionId=this.sessionId,draftOwner=this.draftOwner,lifetime=this.lifecycle,documentLifetime=this.documentLifetime,owner=this.owner,abort=new AbortController();this.uploads.add(abort);
    const forwardAbort=()=>abort.abort();externalSignal?.addEventListener('abort',forwardAbort,{once:true});if(externalSignal?.aborted)forwardAbort();
    let settled!:()=>void;this.uploadSettlements.set(abort,new Promise<void>(resolve=>settled=resolve));
    const check=()=>{if(abort.signal.aborted||session!==this.session||identity!==session.identity()||sessionId!==this.sessionId||draftOwner!==this.draftOwner||lifetime!==this.lifecycle||documentLifetime!==this.documentLifetime||owner!==this.owner||!stillCurrent()){abort.abort();throw Error('UPLOAD_OWNER_CHANGED');}};
    const read=async<T>(path:string,init:RequestInit={}):Promise<T>=>{
      check();const response=await session.transport(path,{...init,signal:abort.signal});check();const value=await response.json();check();
      if(!response.ok)throw Error(value.error?.code??'CONTENT_UNAVAILABLE');return value as T;
    };
    try{
      check();const hash=new SHA256();let at=0,started=performance.now();
      while(at<file.size){
        check();const length=Math.min(65536,file.size-at),buffer=allocationLedger.reserve({owner:'upload-hash-buffer',kind:'staging',cpuBytes:length,handles:1});
        try{const bytes=new Uint8Array(await file.slice(at,at+length).arrayBuffer());check();hash.update(bytes);at+=bytes.length;}
        finally{buffer.release();}
        if(performance.now()-started>4){await tick();check();started=performance.now();}
      }
      const sha256=hash.digest();
      if(existing&&(existing.sha256!==sha256||existing.expectedBytes!==String(file.size)))throw Error('ORIGINAL_FILE_HASH_MISMATCH');
      const request:StagingCreateRequest=existing??{protocolVersion:1,stagingId:crypto.randomUUID(),purpose,expectedBytes:String(file.size),sha256,mediaType};
      if(!existing)await read('/api/v1/assets/staging',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});
      let stage=await read<StagingRecord>('/api/v1/assets/staging/'+request.stagingId);
      while(BigInt(stage.committedOffset)<BigInt(file.size)){
        check();const offset=Number(stage.committedOffset),length=Math.min(1048576,file.size-offset);
        // Fetch extracts a copy of an ArrayBuffer body. Reserve both copies
        // before creating the source and retain them through response drain.
        const transfer=allocationLedger.reserve({owner:'upload-put-body',kind:'staging',cpuBytes:length*2,handles:2});
        try{const bytes=await file.slice(offset,offset+length).arrayBuffer();check();
          stage=await read<StagingRecord>('/api/v1/assets/staging/'+request.stagingId,{method:'PUT',headers:{'Content-Type':'application/octet-stream','Upload-Offset':stage.committedOffset},body:bytes});
        }finally{transfer.release();}
      }
      check();staging.end('ok',{assetHash:sha256,boundary:'local-durable'});return request;
    }catch(error){staging.end('error');throw error;}finally{externalSignal?.removeEventListener('abort',forwardAbort);abort.abort();this.uploads.delete(abort);this.uploadSettlements.delete(abort);settled();}
  }
  async stageTextBlob(blob:Blob,mediaType:string,purpose:StagingCreateRequest['purpose']='text',stillCurrent:()=>boolean=()=>true) {
    const stage=await this.upload(blob,purpose,purpose==='caption'?'text/plain':'application/octet-stream',undefined,stillCurrent);
    if(!stillCurrent())throw Error('UPLOAD_OWNER_CHANGED');
    const asset=this.asset(await this.command({type:'FinalizeStaging',stagingId:stage.stagingId,expectedSha256:stage.sha256},null));
    if(!stillCurrent())throw Error('UPLOAD_OWNER_CHANGED');
    return {...asset.blob,mediaType};
  }
  async fontAssets(requested:readonly FontVersion[]) {
    if(requested.length>16)throw Error('FONT_SELECTION_LIMIT');
    const wanted=new Set(requested.map(font=>font.id));
    const cache=this.cache!,fonts=await cache.collect<Asset>('asset',asset=>{
      const id=asset.font?.id;if(!id||!wanted.has(id))return false;wanted.delete(id);return true;
    },wanted.size);
    // The immutable snapshot may advance while autosave registers unrelated
    // draft assets. Exact font bytes are checked again at the content boundary.
    if(this.cache!==cache)throw Error('FONT_LIBRARY_CHANGED');return fonts;
  }
  async caption(text:string) {
    const backing=allocationLedger.reserve({owner:'caption-blob-workspace',kind:'prompt',cpuBytes:text.length*3,handles:1});
    try{const stage=await this.ownedUpload(new Blob([text]),'caption','text/plain');try{return await this.withCommandEvents({type:'FinalizeStaging',stagingId:stage.value.stagingId,expectedSha256:stage.value.sha256},events=>this.asset(events).id,null);}finally{stage.release();}}finally{backing.release();}
  }
  private asset(events:readonly DomainEvent[]) { let event:DomainEvent|undefined;for(let i=events.length-1;i>=0;i--)if(events[i].type==='AssetRegistered'){event=events[i];break;}if(!event||event.type!=='AssetRegistered')throw Error('ASSET_UNAVAILABLE');return event.payload.asset; }
  async importImage(file:File,existing?:StagingRecord) {
    const target=this.view.document,unpin=this.pinViewModels(target),identity=this.session.identity(),epoch=this.documentLifetime,lifetime=this.lifecycle;
    const current=()=>identity===this.session.identity()&&epoch===this.documentLifetime&&lifetime===this.lifecycle;
    try{const stage=await this.ownedUpload(file,'image',file.type,existing,current);try{
      await this.withCommandEvents({type:'FinalizeStaging',stagingId:stage.value.stagingId,expectedSha256:stage.value.sha256},async original=>{
        if(!current())throw Error('IMPORT_OWNER_CHANGED');await this.withCommandEvents({type:'PrepareRaster',assetId:this.asset(original).id},async prepared=>{
          if(!current())throw Error('IMPORT_OWNER_CHANGED');const asset=this.asset(prepared);await this.withCommandEvents({type:'ReviewRaster',assetId:asset.id},async events=>{
            const event=events.find(e=>e.type==='RasterReviewPrepared');if(!event||event.type!=='RasterReviewPrepared')throw Error('REVIEW_UNAVAILABLE');
            await this.withJSON<RasterReview,void>('/api/v1/assets/raster-reviews/'+event.payload.reviewId,'editor-raster-review',review=>{if(!current())throw Error('IMPORT_OWNER_CHANGED');this.patch({review:{kind:'image',asset,review,name:file.name,target},message:'Conversion ready. Review the pixels and choose Apply or Cancel.'});},undefined,current);
          },null);
        },null);
      },null);
    }finally{stage.release();}}finally{unpin();}
  }
  async create(width:number,height:number,options:{name?:string;background?:DocumentCreationBackground}={}) {
    const scope=this.controlContext(),pending=await this.unresolvedCreation();scope.check();
    if(pending)throw Error('A document creation receipt is unresolved. Check and retry the original command first.');
    const id=crypto.randomUUID();await this.withCommandEvents({type:'CreateDocument',name:options.name??'Untitled document',width,height,background:options.background??{kind:'transparent'}},()=>undefined,null,id);await this.open(id);
  }
  async applyReview() {
    const selected=this.view.review;if(!selected)throw Error('REVIEW_UNAVAILABLE');const unpin=this.pinViewModels(selected),identity=this.session.identity(),epoch=this.documentLifetime;const current=()=>identity===this.session.identity()&&epoch===this.documentLifetime;
    try{if(selected.kind==='image'){
      await this.withCommandEvents({type:'ApproveRaster',assetId:selected.asset.id,reviewId:selected.review.reviewId,reviewHash:selected.review.reviewHash},async events=>{
        const asset=this.asset(events);if(!current())throw Error('REVIEW_OWNER_CHANGED');if(!selected.target)await this.create(asset.raster!.width,asset.raster!.height);
        const target=selected.target??this.view.document!;await this.withCommandEvents({type:'ImportAsset',assetId:asset.id,layerId:crypto.randomUUID(),name:selected.name,draft:null},()=>undefined,target);
      },null);
    }else if(selected.kind==='edit'){
      const d=this.view.documents.find(d=>d.id===selected.review.preview.documentId);if(!d||d.revision!==selected.review.preview.documentRevision)throw Error('STALE_REVISION');
      await this.withCommandEvents({type:selected.review.preview.kind==='resample-image'?'ResampleImage':'CreateFlattenedCopy',previewId:selected.review.preview.previewId,reviewId:selected.review.reviewId,reviewHash:selected.review.reviewHash,draft:null},()=>undefined,d);
    }else{
      if(!selected.review.editable)throw Error(selected.review.reason??'BUNDLE_INSPECTION_ONLY');
      await this.withCommandEvents({type:'ImportBundle',reviewId:selected.review.reviewId,reviewHash:selected.review.reviewHash},()=>undefined,null);await this.open(selected.review.documentId);
      await this.listUI();this.patch({drafts:'Portable UI checkpoints available in Open. Choose one to restore its drafts and view.'});
    }
    if(this.view.review===selected)this.patch({review:null});}finally{unpin();}
  }
  async prepareEdit(body:Extract<Command['body'],{type:'PrepareImageResample'|'PrepareFlattenedCopy'}>) {
    const document=this.view.document!,unpin=this.pinViewModels(document),epoch=this.documentLifetime,identity=this.session.identity();const current=()=>epoch===this.documentLifetime&&identity===this.session.identity()&&this.view.document?.id===document.id&&this.view.document.revision===document.revision;
    try{await this.withCommandEvents(body,async events=>{const event=events.find(e=>e.type==='ImageEditPreviewPrepared');if(!event||event.type!=='ImageEditPreviewPrepared')throw Error('PREVIEW_UNAVAILABLE');if(!current())throw Error('EDIT_OWNER_CHANGED');
      await this.withCommandEvents({type:'ReviewImageEdit',previewId:event.payload.preview.previewId},async reviewed=>{const fact=reviewed.find(e=>e.type==='ImageEditReviewPrepared');if(!fact||fact.type!=='ImageEditReviewPrepared')throw Error('REVIEW_UNAVAILABLE');
        await this.withJSON<ImageEditReview,void>('/api/v1/image-edit-reviews/'+fact.payload.reviewId,'editor-image-edit-review',review=>{if(!current())throw Error('EDIT_OWNER_CHANGED');this.patch({review:{kind:'edit',review},message:'Prepared image edit ready for explicit review.'});},undefined,current);
      },document);
    },document);}finally{unpin();}
  }
  async openBundle(file:File,existing?:StagingRecord) {
    const identity=this.session.identity(),lifetime=this.lifecycle,current=()=>identity===this.session.identity()&&lifetime===this.lifecycle;
    const stage=await this.ownedUpload(file,'bundle','application/x-ideogram-project',existing,current);
    try{await this.withCommandEvents({type:'PreviewBundleImport',stagingId:stage.value.stagingId,expectedSha256:stage.value.sha256},async events=>{
      const event=events.find(e=>e.type==='BundleImportReviewed');if(!event||event.type!=='BundleImportReviewed')throw Error('REVIEW_UNAVAILABLE');
      await this.withJSON<BundleReview,void>('/api/v1/bundle-reviews/'+event.payload.reviewId,'editor-bundle-review',review=>{if(!current())throw Error('BUNDLE_OWNER_CHANGED');this.patch({review:{kind:'bundle',review,name:file.name},message:review.recovery?'Incomplete sanitized recovery copy. Inspection only; it cannot reopen an editable document.':review.editable?'Portable project ready for review. Opening creates a new local identity.':'Portable project inspection only: '+review.reason});},undefined,current);
    },null);}finally{stage.release();}
  }
  async copy() {
    await this.flushDrafts();await this.uiTail;
    await this.withCommandEvents({type:'SaveCopy'},events=>{const event=events.find(e=>e.type==='BundlePrepared');if(!event||event.type!=='BundlePrepared')throw Error('COPY_UNAVAILABLE');const bundle:Bundle=event.payload.bundle;if(!bundle.complete||bundle.status!=='copy-ready')throw Error('COMPLETE_COPY_UNAVAILABLE');this.patch({download:{path:'/api/v1/bundles/'+bundle.bundleId+'/content',name:'project.ideogram-project',hash:bundle.blob.hash,bytes:bundle.blob.byteLength,kind:'copy',documentId:bundle.documentId,revision:bundle.documentRevision,status:'ready'},message:'Copy ready. External destination is unconfirmed.'});});
  }
  async copyRecovery(acknowledgementId:string) {
    const document=this.view.document,identity=this.owner,session=this.sessionId,transport=this.session,lifetime=this.lifecycle,epoch=this.documentLifetime;
    if(!document||!identity||this.session.identity()!==identity||!this.view.ready||typeof acknowledgementId!=='string'||! /^[a-zA-Z0-9_-]{1,128}$/.test(acknowledgementId))throw Error('RECOVERY_COPY_REVIEW_REQUIRED');
    // Drafts and UI checkpoints are explicitly outside this current-state rescue.
    const unpin=this.pinViewModels(document);try{await this.withCommandEvents({type:'SaveRecoveryCopy',acknowledgementId},events=>{
    const event=events.find(e=>e.type==='BundlePrepared');if(!event||event.type!=='BundlePrepared')throw Error('RECOVERY_COPY_UNAVAILABLE');
    const bundle:Bundle=event.payload.bundle;
    if(bundle.complete||bundle.status!=='recovery-copy-ready'||bundle.recovery.acknowledgementId!==acknowledgementId||bundle.documentId!==document.id||bundle.documentRevision!==document.revision)throw Error('RECOVERY_COPY_IDENTITY_CHANGED');
    if(this.owner!==identity||this.session!==transport||this.session.identity()!==identity||this.sessionId!==session||this.lifecycle!==lifetime||this.documentLifetime!==epoch||this.view.document?.id!==document.id)return;
    this.patch({download:{path:'/api/v1/bundles/'+bundle.bundleId+'/content',name:'project.recovery.ideogram-project',hash:bundle.blob.hash,bytes:bundle.blob.byteLength,kind:'copy',documentId:bundle.documentId,revision:bundle.documentRevision,recovery:bundle.recovery,status:'ready'},message:'Incomplete sanitized recovery copy ready. Current safe content only; inspection only. External destination is unconfirmed.'});
    },document);}finally{unpin();}
  }
  async prepareExport(options:DocumentExportOptions|undefined,document:Document,onJournaled?:(commandId:string)=>void) {
    return this.asset(await this.command({type:'ExportDocument',historyHead:document.historyHead,...(options?{options}:{})},document,undefined,onJournaled));
  }
  async cancelRasterImport(commandId:string,expectedOwner:RasterImportCancellationOwner={session:this.session,identity:this.session.identity()}):Promise<RasterImportCancellation> {
    const current=()=>expectedOwner.session===this.session&&expectedOwner.identity!==null&&expectedOwner.identity===this.session.identity();
    if(!current())throw Error('RASTER_IMPORT_CANCELLATION_OWNER_CHANGED');
    await this.importAdmissions.get(commandId);
    if(!current())throw Error('RASTER_IMPORT_CANCELLATION_OWNER_CHANGED');
    // An aborted upload/preview signal never controls this independent request.
    // Unknown admission or response leaves the original journaled identity live.
    const wire=reserveCommandWire({protocolVersion:1});let model:OwnedModel<unknown>|undefined;
    try{
      // ownedJSON binds the current session synchronously. Finish the bounded
      // response drain even if that owner changes, then reject before copying.
      model=await this.ownedJSON<unknown>('/api/v1/commands/'+encodeURIComponent(commandId)+'/cancel-raster-import','raster-import-cancellation',{method:'POST',headers:{'Content-Type':'application/json'},body:wire.wire,signal:new AbortController().signal},undefined,65536,'control');
      if(!current())throw Error('RASTER_IMPORT_CANCELLATION_OWNER_CHANGED');
      const result=model.value;try{rasterImportCancellation(result,commandId);}catch{throw Error('RASTER_IMPORT_CANCELLATION_UNCONFIRMED');}
      const r=result.receipt;
      return {protocolVersion:1,commandId:result.commandId,status:result.status,receipt:r.status==='accepted'?{status:'accepted',commandId:r.commandId,fromSeq:r.fromSeq,toSeq:r.toSeq,documentRevision:r.documentRevision,transactionId:r.transactionId}:{status:'rejected',commandId:r.commandId,code:r.code,currentRevision:r.currentRevision,details:{hash:r.details.hash,byteLength:r.details.byteLength,mediaType:r.details.mediaType}}};
    }finally{model?.release();wire.release();}
  }
  async ownedCancelRasterImport(commandId:string,expectedOwner:RasterImportCancellationOwner={session:this.session,identity:this.session.identity()}):Promise<OwnedModel<RasterImportCancellation>> {
    return this.controlReads.run(async signal=>{
      const current=()=>expectedOwner.session===this.session&&expectedOwner.identity!==null&&expectedOwner.identity===this.session.identity();if(!current())throw Error('RASTER_IMPORT_CANCELLATION_OWNER_CHANGED');await this.importAdmissions.get(commandId);if(!current())throw Error('RASTER_IMPORT_CANCELLATION_OWNER_CHANGED');
      const model=await this.ownedPost<unknown>('/api/v1/commands/'+encodeURIComponent(commandId)+'/cancel-raster-import','raster-import-cancellation',{protocolVersion:1},signal);let returned=false;
      try{if(!current())throw Error('RASTER_IMPORT_CANCELLATION_OWNER_CHANGED');try{rasterImportCancellation(model.value,commandId);}catch{throw Error('RASTER_IMPORT_CANCELLATION_UNCONFIRMED');}returned=true;return model as OwnedModel<RasterImportCancellation>;}finally{if(!returned)model.release();}
    });
  }
  async ownedCancelExport(commandId:string,expectedOwner:ExportCancellationOwner={session:this.session,identity:this.session.identity()}):Promise<OwnedModel<ExportCancellationResult>> {
    return this.controlReads.run(async signal=>{
    const current=()=>expectedOwner.session===this.session&&expectedOwner.identity!==null&&expectedOwner.identity===this.session.identity();
    if(!current())throw Error('EXPORT_CANCELLATION_OWNER_CHANGED');
    await this.exportAdmissions.get(commandId);
    if(!current())throw Error('EXPORT_CANCELLATION_OWNER_CHANGED');
    // A failed original transport may still have reached the writer. Its exact
    // ID can be queried for cancellation, but NOT_FOUND remains unconfirmed.
    const result=await this.ownedPost<ExportCancellationResult>('/api/v1/commands/'+encodeURIComponent(commandId)+'/cancel-export','command-cancellation-response',{protocolVersion:1},signal);
    let returned=false;try{
    if(!current())throw Error('EXPORT_CANCELLATION_OWNER_CHANGED');
    if(!result.value||result.value.protocolVersion!==1||result.value.commandId!==commandId||!['canceled','completed'].includes(result.value.status)||!result.value.receipt||result.value.receipt.commandId!==commandId||!['accepted','rejected'].includes(result.value.receipt.status)||result.value.status==='canceled'&&(result.value.receipt.status!=='rejected'||result.value.receipt.code!=='INVALID_INPUT'))throw Error('EXPORT_CANCELLATION_UNCONFIRMED');
    returned=true;return result;
    }finally{if(!returned)result.release();}
    });
  }
  async cancelExport(commandId:string,expectedOwner:ExportCancellationOwner={session:this.session,identity:this.session.identity()}):Promise<ExportCancellationResult> {
    const current=()=>expectedOwner.session===this.session&&expectedOwner.identity!==null&&expectedOwner.identity===this.session.identity();
    if(!current())throw Error('EXPORT_CANCELLATION_OWNER_CHANGED');
    await this.exportAdmissions.get(commandId);
    if(!current())throw Error('EXPORT_CANCELLATION_OWNER_CHANGED');
    // A failed original transport may still have reached the writer. Its exact
    // ID can be queried for cancellation, but NOT_FOUND remains unconfirmed.
    const result=await this.post<ExportCancellationResult>('/api/v1/commands/'+encodeURIComponent(commandId)+'/cancel-export',{protocolVersion:1});
    if(!current())throw Error('EXPORT_CANCELLATION_OWNER_CHANGED');
    if(!result||result.protocolVersion!==1||result.commandId!==commandId||!['canceled','completed'].includes(result.status)||!result.receipt||result.receipt.commandId!==commandId||!['accepted','rejected'].includes(result.receipt.status)||result.status==='canceled'&&(result.receipt.status!=='rejected'||result.receipt.code!=='INVALID_INPUT'))throw Error('EXPORT_CANCELLATION_UNCONFIRMED');
    return result;
  }
  async ownedCancelCandidateReview(commandId:string,expectedOwner:CandidateReviewCancellationOwner={session:this.session,identity:this.session.identity()}):Promise<OwnedModel<CandidateReviewCancellationResult>> {
    return this.controlReads.run(async signal=>{
    const current=()=>expectedOwner.session===this.session&&expectedOwner.identity!==null&&expectedOwner.identity===this.session.identity();
    if(!current())throw Error('CANDIDATE_REVIEW_CANCELLATION_OWNER_CHANGED');
    // Cancel the original review after its admission, while preparation may
    // still be running. Never wait for the full review or issue another review.
    await this.reviewAdmissions.get(commandId);
    if(!current())throw Error('CANDIDATE_REVIEW_CANCELLATION_OWNER_CHANGED');
    const result=await this.ownedPost<CandidateReviewCancellationResult>('/api/v1/commands/'+encodeURIComponent(commandId)+'/cancel-candidate-review','command-cancellation-response',{protocolVersion:1,commandId},signal);
    let returned=false;try{
    if(!current())throw Error('CANDIDATE_REVIEW_CANCELLATION_OWNER_CHANGED');
    if(!result.value||result.value.protocolVersion!==1||result.value.commandId!==commandId||!['canceled','completed'].includes(result.value.status))throw Error('CANDIDATE_REVIEW_CANCELLATION_UNCONFIRMED');
    returned=true;return result;
    }finally{if(!returned)result.release();}
    });
  }
  async cancelCandidateReview(commandId:string,expectedOwner:CandidateReviewCancellationOwner={session:this.session,identity:this.session.identity()}):Promise<CandidateReviewCancellationResult> {
    const current=()=>expectedOwner.session===this.session&&expectedOwner.identity!==null&&expectedOwner.identity===this.session.identity();
    if(!current())throw Error('CANDIDATE_REVIEW_CANCELLATION_OWNER_CHANGED');
    // Cancel the original review after its admission, while preparation may
    // still be running. Never wait for the full review or issue another review.
    await this.reviewAdmissions.get(commandId);
    if(!current())throw Error('CANDIDATE_REVIEW_CANCELLATION_OWNER_CHANGED');
    const result=await this.post<CandidateReviewCancellationResult>('/api/v1/commands/'+encodeURIComponent(commandId)+'/cancel-candidate-review',{protocolVersion:1,commandId});
    if(!current())throw Error('CANDIDATE_REVIEW_CANCELLATION_OWNER_CHANGED');
    if(!result||result.protocolVersion!==1||result.commandId!==commandId||!['canceled','completed'].includes(result.status))throw Error('CANDIDATE_REVIEW_CANCELLATION_UNCONFIRMED');
    return result;
  }
  confirmExport(asset:Asset,document:Document) {
    if(!asset.raster||asset.raster.role!=='export'||!['image/png','image/jpeg'].includes(asset.blob.mediaType))throw Error('EXPORT_UNAVAILABLE');
    const jpeg=asset.blob.mediaType==='image/jpeg';
    this.patch({download:{path:'/api/v1/assets/'+asset.id+'/content',name:'image.'+(jpeg?'jpg':'png'),hash:asset.blob.hash,bytes:asset.blob.byteLength,mediaType:asset.blob.mediaType,kind:'image',documentId:document.id,revision:document.revision,status:'ready'},message:'Export ready. External destination is unconfirmed.'});
  }
  async export() {
    const document=this.view.document!,unpin=this.pinViewModels(document),owner=this.owner,lifetime=this.lifecycle,documentLifetime=this.documentLifetime;
    try{const asset=await this.ownedPrepareExport(undefined,document);try{if(owner===this.owner&&lifetime===this.lifecycle&&documentLifetime===this.documentLifetime&&this.view.document?.id===document.id)this.confirmExport(asset.value,document);}finally{asset.release();}}finally{unpin();}
  }
  changeDraft(id:string,kind:'prompt'|'inspector'|'mask'|'text'|'composition'|'request',text:string,targetLayerId:string|null,composing:boolean,expectedRevision?:string) {
    const document=this.view.document;if(!document||!this.draftOwner)return;
    const prior=this.draftOwner.drafts.get(id);if(prior&&prior.text===text&&prior.composing===composing&&prior.expectedDocumentRevision===(expectedRevision??document.revision)){this.draftOwner.acceptRetained(id,text);return;}
    this.patchSave({draftDirty:true,bundleOutdated:true},()=>this.draftOwner!.change({id,kind,text,documentId:document.id,targetLayerId,expectedDocumentRevision:expectedRevision??document.revision,composing}),{drafts:'Unsaved UI draft'});clearTimeout(this.draftTimer);
    this.draftTimer=setTimeout(()=>{void this.flushDrafts().catch(e=>this.fail(e));},700);
  }
  async flushDrafts() {
    if(this.draftFlush)return this.draftFlush;
    this.draftFlush=this.saveDrafts().finally(()=>{this.draftFlush=undefined;
      if(this.view.ready&&[...this.draftOwner?.drafts.values()??[]].some(d=>d.generation!==d.savedGeneration&&!d.composing&&!d.pending&&!d.error)){
        clearTimeout(this.draftTimer);this.draftTimer=setTimeout(()=>void this.flushDrafts().catch(e=>this.fail(e)),700);
      }
    });return this.draftFlush;
  }
  private draftStatus(){
    const drafts=[...this.draftOwner?.drafts.values()??[]].filter(d=>d.documentId===this.view.document?.id);
    if(drafts.some(d=>d.savedGeneration!==d.generation))return 'Unsaved UI draft';
    if(drafts.some(d=>!this.ui?.drafts.some(p=>p.id===d.id&&p.generation===d.generation&&p.status==='applied'))||this.ui?.drafts.some(d=>d.documentId===this.view.document?.id&&d.status==='saved-unapplied'))return 'Draft saved locally; not applied to the document';
    return '';
  }
  private async saveDrafts() {
    clearTimeout(this.draftTimer);const owner=this.draftOwner,lifetime=this.lifecycle;if(!owner)return;
    const current=()=>owner===this.draftOwner&&lifetime===this.lifecycle;
    for(const [id,draft] of owner.drafts){if(draft.savedGeneration===draft.generation||draft.pending||draft.composing&&draft.kind!=='text')continue;
      // A refused workspace or interrupted delivery must not poison the tail
      // forever. DraftPersistence retries any retained original delivery ID.
      this.patch({drafts:'Draft saving…'});await this.uiTail.catch(()=>{});if(!current())return;
      // The retained source and outgoing-generation pin are separate. This
      // workspace covers parsed UTF-16 payload (2), output JSON (2), UTF-8 (3),
      // validation round-trip text (2) and Blob payload (3) per source unit.
      const pending=owner.ownedSave(id,async text=>{
        const workspace=allocationLedger.reserve({owner:'draft-save-scratch',kind:'prompt',cpuBytes:text.length*12,handles:4});
        try{
          if(draft.kind==='request'){const {draft:value,text:prompt}=JSON.parse(text);const bytes=new TextEncoder().encode(prompt);if(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)!==prompt)throw Error('Invalid Unicode prompt retained.');const ref=await this.ownedStageTextBlob(new Blob([bytes]),'text/plain');try{value.prompt.text=ref.value;return await this.caption(canonical(value));}finally{ref.release();}}
          if(draft.kind==='composition'){const value=JSON.parse(text),graph=await this.ownedStageTextBlob(new Blob([canonical(value)]),'application/json');try{return await this.caption(canonical({schemaVersion:1,kind:'composition-draft-1',graph:graph.value,raw:[...value.composition.raw,...(value.composition.review?[value.composition.review.prompt]:[])],bindings:value.bindings}));}finally{graph.release();}}
          if(draft.kind!=='text')return await this.caption(text);
          const value=JSON.parse(text);if(new TextDecoder('utf-8',{ignoreBOM:true}).decode(new TextEncoder().encode(value.text))!==value.text)throw Error('Invalid Unicode draft retained in the editor. Replace the invalid character before saving.');const textUtf8=await this.ownedStageTextBlob(new Blob([value.text]),'text/plain');try{return await this.caption(canonical({...(value.description?{schemaVersion:3,kind:'text-draft-3',placement:value.placement,description:value.description}:value.placement?{schemaVersion:2,kind:'text-draft-2',placement:value.placement}:{schemaVersion:1,kind:'text-draft-1'}),textUtf8:textUtf8.value,style:value.style,frame:value.frame,fonts:value.fonts}));}finally{textUtf8.release();}
        }finally{workspace.release();}
      });this.uiTail=pending.then(()=>undefined,()=>undefined);const receipt=await pending;
      try{if(!current())return;this.ui=owner.checkpoint!;if(receipt?.value.status==='rejected')throw Error(receipt.value.reason??'DRAFT_CHANGED');}finally{receipt?.release();}

    }
    if(!current())return;
    if(this.view.document)await this.loadDocument(this.view.document);
    if(current())this.patch({drafts:this.draftStatus()});
  }
  async ownedDraftText(id:string):Promise<OwnedModel<string>> {
    const owner=this.draftOwner,session=this.session,identity=session.identity(),sessionId=this.sessionId,epoch=this.documentLifetime,lifetime=this.lifecycle;if(!owner)throw Error('DRAFT_UNAVAILABLE');
    return this.controlReads.run(async signal=>{
      const current=()=>!signal.aborted&&owner===this.draftOwner&&session===this.session&&identity===session.identity()&&sessionId===this.sessionId&&epoch===this.documentLifetime&&lifetime===this.lifecycle;
      if(!current())throw new DOMException('Draft read was cancelled.','AbortError');
      if(owner.drafts.has(id))return owner.drafts.borrowText(id);
      const checkpoint=owner.checkpoint,checkpointPin=owner.pinCheckpoint(checkpoint),sourceCurrent=()=>current()&&owner.checkpoint===checkpoint;try{const saved=checkpoint?.drafts.find(draft=>draft.id===id);if(!saved)throw Error('DRAFT_UNAVAILABLE');
        const admitted=allocationLedger.reserve({owner:'draft-text-response',kind:'prompt',handles:1});let response:Response;
        try{response=await session.transport('/api/v1/assets/'+saved.assetId+'/content',{signal});}catch(error){admitted.release();throw error;}
        const header=response.headers.get('content-length'),expected=response.ok&&header!==null&&/^(0|[1-9][0-9]*)$/.test(header)?Number(header):NaN;
        const retained=await readRetainedPrompt(response,expected,sourceCurrent,signal,admitted);
        try{if(!sourceCurrent())throw new DOMException('Draft read was cancelled.','AbortError');if(!owner.drafts.has(id))owner.drafts.set(id,{...saved,text:retained.text,savedGeneration:saved.generation,pending:false,error:null});return owner.drafts.borrowText(id);}finally{retained.lease.release();}
      }finally{checkpointPin();}
    });
  }
  async draftText(id:string) {
    const owner=this.draftOwner!,epoch=this.documentLifetime,abort=new AbortController();
    const operation=(async()=>{try{await owner.restoreDraft(id,async assetId=>{
      const response=await this.session.transport('/api/v1/assets/'+assetId+'/content',{signal:abort.signal});if(!response.ok)throw Error('DRAFT_UNAVAILABLE');
      const text=await response.text();if(abort.signal.aborted||owner!==this.draftOwner||epoch!==this.documentLifetime)throw Error('DRAFT_READ_CANCELLED');return text;
    });return abort.signal.aborted||owner!==this.draftOwner||epoch!==this.documentLifetime?'':owner.drafts.get(id)?.text??'';}catch(error){if(abort.signal.aborted)return '';throw error;}})();
    this.draftReads.set(abort,operation);try{return await operation;}finally{abort.abort();this.draftReads.delete(abort);}
  }
  /** Adopt only a saved replacement; concurrent local input keeps its existing owner. */
  async refreshQueuedReplacement(draftId:string,expectedOwner:DraftPersistence,expectedSessionId:string,onAdopt?:(owner:DraftPersistence)=>void,canAdopt:()=>boolean=()=>true){
    if(this.queuedReplacementActive)throw Error('A saved replacement is already opening. Wait for it to finish before retrying.');
    this.assertDraftOwnerCapacity();const operation=queuedReplacementOperation(draftId,expectedSessionId);this.queuedReplacementActive=true;
    try{
      const session=this.session,identity=this.session.identity(),lifetime=this.lifecycle,documentLifetime=this.documentLifetime,documentId=this.view.document?.id;
      const current=()=>canAdopt()&&this.session===session&&this.draftOwner===expectedOwner&&this.sessionId===expectedSessionId&&this.session.identity()===identity&&this.lifecycle===lifetime&&this.documentLifetime===documentLifetime&&this.view.document?.id===documentId;
      await this.uiTail;if(!current()||!queuedDraftsClean(expectedOwner))throw Error('Save the current input before opening the retained replacement draft.');
      const fence=captureQueuedReplacementFence(expectedOwner);let restored:DraftPersistence|undefined,adopted=false;
      try{restored=new DraftPersistence(expectedSessionId,this.session.transport,this.session.csrf,this.journal);await restored.restore();if(!current()||!queuedDraftsClean(expectedOwner)||!fence.unchanged(expectedOwner))throw Error('Current input changed. The replacement remains saved for explicit recovery.');
        const checkpoint=restored.checkpoint,draft=checkpoint?.drafts.find(d=>d.id===draftId&&d.kind==='request'&&d.status==='saved-unapplied'&&d.documentId===documentId);
        if(!checkpoint||!draft||restored.hasPendingRequests)throw Error('The saved replacement requires recovery before editing.');
        this.draftOwner=restored;this.ui=checkpoint;adopted=true;
        // The invoking UI action can still pin a registered old Entry. Let its
        // publication finish before waiting for that action's own finally.
        // Retirement stays charged, capped and awaited by Close/dispose.
        const retired=this.retireDraftOwner(expectedOwner);void retired.catch(error=>this.fail(error));
        const publicationErrors:unknown[]=[];try{onAdopt?.(restored);}catch(error){publicationErrors.push(error);}
        try{this.patch({drafts:'Replacement request draft saved. Prepare a fresh review before enqueueing.'});}catch(error){publicationErrors.push(error);}
        if(publicationErrors.length===1)throw publicationErrors[0];if(publicationErrors.length>1)throw new AggregateError(publicationErrors,'QUEUED_REPLACEMENT_PUBLICATION_FAILED');
      }finally{try{if(!adopted&&restored)await this.retireDraftOwner(restored);}finally{fence.release();}}
    }finally{this.queuedReplacementActive=false;operation.release();}
  }
  async retryDraft(id:string){
    const owner=this.draftOwner!,receipt=await owner.ownedRetry(id);try{await owner.restore();if(owner!==this.draftOwner)throw Error('UI_OWNER_CHANGED');this.ui=owner.checkpoint!;this.patch({uiPending:owner.pendingRequests(),drafts:receipt.value.status==='accepted'?'Draft saved locally; not applied to the document':'Draft conflict retained'});if(receipt.value.status==='rejected')throw Error(receipt.value.reason??'DRAFT_CHANGED');}finally{receipt.release();}
  }
  async ownedRequestReview(body:Extract<UIRequest['body'],{type:'PrepareRequestReview'|'AcceptRequestReview'}>):Promise<OwnedModel<UIReceipt>> {
    const owner=this.draftOwner,scope=this.controlContext();if(!owner||!this.view.ready)throw Error('Connect before reviewing.');
    const captured=reserveCommandWire(body);
    try{return await this.controlReads.run(async signal=>{
      const check=()=>{scope.check(signal);if(owner!==this.draftOwner)throw Error('Draft owner changed; the original receipt remains durable.');};
      check();await this.flushDrafts();check();await this.uiTail;check();
      const request:UIRequest={protocolVersion:1,requestId:crypto.randomUUID(),sessionId:scope.sessionId,expectedUISeq:owner.checkpoint!.uiSeq,body:captured.request},pending=owner.ownedDispatch(request);this.uiTail=pending.then(()=>undefined,()=>undefined);
      const receipt=await pending;let returned=false;try{check();this.ui=owner.checkpoint!;if(receipt.value.status!=='accepted')throw Error(receipt.value.reason??'Request review rejected.');returned=true;return receipt;}finally{if(!returned)receipt.release();}
    });}finally{captured.release();}
  }
  async requestReview(body:Extract<UIRequest['body'],{type:'PrepareRequestReview'|'AcceptRequestReview'}>){
    const owner=this.draftOwner,session=this.sessionId;if(!owner||!this.view.ready)throw Error('Connect before reviewing.');
    await this.flushDrafts();await this.uiTail;if(owner!==this.draftOwner||session!==this.sessionId)throw Error('Draft owner changed.');
    const request:UIRequest={protocolVersion:1,requestId:crypto.randomUUID(),sessionId:session,expectedUISeq:owner.checkpoint!.uiSeq,body};
    this.uiTail=owner.dispatch(request);const receipt=await this.uiTail as UIReceipt;
    if(owner!==this.draftOwner||session!==this.sessionId)throw Error('Draft owner changed; the original receipt remains durable.');
    this.ui=owner.checkpoint!;if(receipt.status!=='accepted')throw Error(receipt.reason??'Request review rejected.');return receipt;
  }
  async clearDraft(id:string) {
    const owner=this.draftOwner!,draft=owner.drafts.get(id);if(!draft)return;const generation=draft.generation;
    await this.uiTail;const request:UIRequest={protocolVersion:1,requestId:crypto.randomUUID(),sessionId:this.sessionId,expectedUISeq:owner.checkpoint!.uiSeq,body:{type:'ClearDraft',draftId:id,generation}},receipt=await owner.ownedDispatch(request);
    try{if(receipt.value.status!=='accepted')throw Error('DRAFT_CHANGED');owner.drafts.delete(id);await owner.restore();if(owner!==this.draftOwner)throw Error('UI_OWNER_CHANGED');this.ui=owner.checkpoint!;this.patch({drafts:''});if(this.view.document)await this.loadDocument(this.view.document);}finally{receipt.release();}
  }
  private retireConnection(value:RecoveryCache|BrowserJournal,late=false){
    // At most the current connect's two handles can arrive late. A refused
    // native close stays reachable for disposal retry and blocks reconnect.
    (this.retiredConnections??=new Set()).add(value);
    try{value.close();}catch(error){if(late)this.lateConnectionFailure={error};throw error;}
    this.retiredConnections.delete(value);
    if(this.cache===value)this.cache=undefined;if(this.journal===value)this.journal=undefined;
  }
  dispose():Promise<void>{
    if(!this.disposalPending){
      const drains:Promise<unknown>[]=[],errors:unknown[]=[];
      try{this.invalidateConnection();}catch(error){errors.push(error);}this.pendingRead++;
      const cache=this.cache,journal=this.journal,consumer=this.consumer,draft=this.draftOwner,priorLateFailure=this.lateConnectionFailure;
      // Start every independent release even when a sibling throws before
      // returning a promise. Only confirmed cleanup can permit a later connect.
      const drain=(work:()=>unknown)=>{try{drains.push(Promise.resolve(work()));}catch(error){errors.push(error);}};
      if(draft)drain(()=>this.retireDraftOwner(draft));
      for(const work of [this.connectWork,this.streamTask,this.syncTask,this.refreshTask,this.uiTail,this.draftFlush])if(work)drain(()=>work.catch(()=>{}));
      drain(()=>this.recoveryDrain);drain(()=>this.viewReads.release());drain(()=>this.controlReads.release());drain(()=>this.drainDraftOwners());
      // The shell owns Session retirement after these dependent cleanup
      // requests finish; clearing its authority here would strand lease POSTs.
      this.disposalPending=true;
      const task=Promise.allSettled(drains).then(results=>{
        for(const result of results)if(result.status==='rejected')errors.push(result.reason);
        if(this.disposalPublicationFailed)errors.push(this.disposalPublicationFailure);
        // A close refused by an open that completed during this disposal must
        // remain a visible failure. Only a later explicit disposal may retry it.
        if(this.lateConnectionFailure&&this.lateConnectionFailure!==priorLateFailure)errors.push(this.lateConnectionFailure.error);
        if(errors.length)throw new AggregateError(errors,'EDITOR_DISPOSAL_INCOMPLETE');
        // The only late arrivals are fenced opens from the settled connect.
        // Failed closes remain reachable; no successor connect can enter until
        // this promise succeeds. Attempt both independent native closes.
        const handles=new Set([...(this.retiredConnections??[]),cache,journal]);
        for(const value of handles)if(value)try{this.retireConnection(value);}catch(error){errors.push(error);}
        if(errors.length)throw new AggregateError(errors,'EDITOR_DISPOSAL_INCOMPLETE');
        if(this.lateConnectionFailure===priorLateFailure)this.lateConnectionFailure=undefined;
        if(this.consumer===consumer)this.consumer=undefined;
        if(this.draftOwner===draft)this.draftOwner=undefined;
      }).finally(()=>{this.disposalPending=false;});
      this.disposalTask=task;void task.catch(()=>{});
    }
    // This service root was admitted before construction. Cleanup must not
    // allocate a fresh metadata owner just to clear a client under pressure.
    // Publish first: a failed setter leaves every prior owner retained, and its
    // failure also blocks reconnect until an explicit successful disposal retry.
    try{
      const terminal=this.viewModels.terminalView();this.publishNavigationView(terminal);
      this.viewModels.clearReplaced(terminal);this.selectedDocumentPin?.();this.selectedDocumentPin=undefined;this.selectedDocumentMetadata=undefined;
      this.ui=undefined;this.documentsMetadata?.release();this.documentsMetadata=undefined;this.viewModels.releaseControlView();
      this.disposalPublicationFailed=false;this.disposalPublicationFailure=undefined;
    }catch(error){this.disposalPublicationFailed=true;this.disposalPublicationFailure=error;throw error;}
    return this.disposalTask!;
  }
}
