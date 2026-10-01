import { createValueModel } from '@en-reve/primitives/state/value.js';
import type { createSessionClient } from './session-client.js';
import { RecoveryCache, RecoveryPublicationConflict } from './recovery-cache.js';
import { RecoveryConsumer } from './recovery-client.js';
import { BrowserJournal } from './browser-journal.js';
import {reserveCommandWire} from './control-memory.js';
import { DraftPersistence } from './draft-persistence.js';
import { DocumentResources } from './document-lifecycle.js';
import {collectOwnedDocuments,type OwnedDocumentList} from './document-list.js';
import {readOwnedJSON,type OwnedModel,type ModelKind} from '../observability/model-memory.js';
import { EMPTY_EXPECTED_VERSIONS, type Command, type CommandRequest, type Document, type DomainEvent, type Receipt, type Checkpoint, type HistoryNode } from '../protocol/store.js';
import type { CommandResult, EventPage, PendingInventory } from '../protocol/recovery.js';
import type { Asset, StagingCreateRequest, StagingRecord, StagingRecoveryPage } from '../protocol/assets.js';
import type { ImageState, ImageHistoryNode, ImageEditReview } from '../protocol/history.js';
import type { Bundle, BundleReview } from '../protocol/portable.js';
import type { RasterReview } from '../protocol/raster.js';
import type { FontVersion } from '../protocol/text.js';
import type { DocumentExportOptions, ExportCancellation } from '../protocol/export.js';
import type { UICheckpoint, UIRequest, UIReceipt, Preferences, UIInventory } from '../protocol/ui.js';
import { SHA256 } from '../protocol/sha256.js';
import { canonical, parseControlJSON } from '../protocol/json.js';
import { event as validateEvent } from '../protocol/validate.js';
import {browserPhases} from '../observability/browser.js';
import {allocationLedger} from '../observability/allocations.js';
import type {PhaseContext,PhaseName} from '../observability/phases.js';

type Session = ReturnType<typeof createSessionClient>;
type Delivery = { request: CommandRequest; wire: string; result?: CommandResult; label: string };
export type ExportCancellationResult = ExportCancellation;
export type ExportCancellationOwner = {session:Session;identity:string|null};
export type Review = { kind: 'image'; asset: Asset; review: RasterReview; name: string; target: Document | null }
 | { kind: 'edit'; review: ImageEditReview }
 | { kind: 'bundle'; review: BundleReview; name: string };
export type Download = { path: string; name: string; hash: string; bytes: string; kind: 'copy' | 'image'; documentId:string;revision:string; mediaType?:string; status: 'ready' | 'writing' | 'unconfirmed' | 'confirmed' | 'failed' };
export type EditorView = {
  ready: boolean; busy: boolean; message: string; error: string; recovery: string;
  documents: Document[]; document: Document | null; image: ImageState | null;
  history: ImageHistoryNode[]; historyNext: string | null; checkpoints: Checkpoint[];checkpointNext:string|null;
  review: Review | null; download: Download | null; selected: string[];
  save: { pendingCommandCount: number; draftDirty: boolean; documentChangedSinceCheckpoint: boolean; bundleOutdated: boolean } | null;
  drafts: string; pending: Delivery[];uiPending:string[]; cursor: string; uiChoices:UIInventory['items'];uiNext:string|null;stages:StagingRecoveryPage['items'];stageNext:string|null;
};
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const commandPhase=(type:Command['body']['type']):PhaseName|undefined=>({PrepareRequestSource:'source.capture',PrepareRequestMask:'mask.plan',PrepareCandidateAdoption:'result.prepare',PrepareRaster:'raster.prepare',SaveCopy:'project.copy',ImportBundle:'project.import',ExportDocument:'document.export'} as Partial<Record<Command['body']['type'],PhaseName>>)[type];
const adoptionTraceId=(body:Command['body']):string|undefined=>body.type==='AdoptCandidate'?body.previewId:body.type==='AdoptReviewedCandidate'?body.reviewId:undefined;
export class EditorClient {
  readonly state = createValueModel<EditorView>({ready:false,busy:false,message:'Connect locally to open your work.',error:'',recovery:'',documents:[],document:null,image:null,history:[],historyNext:null,checkpoints:[],checkpointNext:null,review:null,download:null,selected:[],save:null,drafts:'',pending:[],uiPending:[],cursor:'0',uiChoices:[],uiNext:null,stages:[],stageNext:null});
  private cache?: RecoveryCache;
  private documentsMetadata?:OwnedDocumentList;
  private selectedDocumentMetadata?:OwnedDocumentList;
  private selectedDocumentPin?:()=>void;
  private consumer?: RecoveryConsumer;
  private recoveryDrain:Promise<void>=Promise.resolve();
  private recoveryFailure?:unknown;
  private journal?: BrowserJournal;
  private pendingRead=0;
  private pendingMetadata?:ReturnType<typeof allocationLedger.reserve>;
  private lifecycle = 0;
  private documentLifetime=0;
  private closingDocument?:Promise<void>;
  private uploads=new Set<AbortController>();
  private uploadSettlements=new Map<AbortController,Promise<void>>();
  private draftReads=new Map<AbortController,Promise<string>>();
  private exportAdmissions=new Map<string,Promise<void>>();
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
  ui?: UICheckpoint;
  constructor(readonly session: Session) {
    this.documentResources.register('editor-client',{release:async()=>{for(const abort of [...this.uploads,...this.draftReads.keys()])abort.abort();await Promise.allSettled([...this.uploadSettlements.values(),...this.draftReads.values()]);},inspect:()=>({uploads:this.uploads.size,draftReads:this.draftReads.size})});
  }
  patch(value: Partial<EditorView>) {
    const changesDocument='document' in value&&value.document!==this.view.document;
    // Active document metadata borrows a row from the published list. Pin that
    // owner across replacement scans until the active document is replaced or
    // closed; a failed image refresh can legitimately keep the prior row live.
    const nextOwner=changesDocument&&value.document?this.documentRowOwner(value.document):undefined,nextPin=nextOwner?.pin();
    try{this.state.set({...this.state.value.get(),...value});}catch(error){nextPin?.();throw error;}
    if(changesDocument){this.selectedDocumentPin?.();this.selectedDocumentPin=nextPin;this.selectedDocumentMetadata=nextOwner;}
  }
  private documentRowOwner(document:Document){return this.documentsMetadata?.documents.includes(document)?this.documentsMetadata:this.selectedDocumentMetadata?.documents.includes(document)?this.selectedDocumentMetadata:undefined;}
  get view() { return this.state.value.get(); }
  get documentEpoch(){return this.documentLifetime;}
  get sessionId() { return this.ui?.sessionId ?? 'editor_' + this.owner; }
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
  private post<T>(path: string, body: unknown) { return this.json<T>(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); }
  async connect() {
    const owner = this.session.identity(); if (!owner) { this.disconnect(); return; }
    const previousOwner=this.owner;
    const lifetime = ++this.lifecycle;clearTimeout(this.retryTimer);this.stream?.abort();const retired=this.stopRecovery();await Promise.all([this.streamTask,retired]);
    // Retire reads from the previous session before replacing their cache/consumer.
    // Their failures remain visible until this fresh recovery succeeds.
    await this.syncTask?.catch(()=>{});await this.refreshTask?.catch(()=>{});
    if(lifetime!==this.lifecycle)return;
    this.owner = owner; this.patch({ready:false,review:null,message:'Recovering complete local transactions…',error:'',recovery:''});
    this.cache?.close();
    this.cache = await RecoveryCache.open('ie-projection-' + owner);
    if(!this.journal||previousOwner!==owner){this.journal?.close();this.journal = await BrowserJournal.open(owner);}
    this.consumer = new RecoveryConsumer(this.cache, this.session.transport, this.session.csrf);
    const storageKey='ie-ui-session:'+owner;
    const sessionId=sessionStorage.getItem(storageKey)??'ui_'+crypto.randomUUID();sessionStorage.setItem(storageKey,sessionId);
    if(!this.draftOwner||this.draftOwner.sessionId!==sessionId){this.draftOwner?.dispose();this.draftOwner = new DraftPersistence(sessionId, this.session.transport, this.session.csrf,this.journal);}
    await this.draftOwner.restore(); this.ui = this.draftOwner.checkpoint!;
    await this.sync(); if (lifetime !== this.lifecycle) return;
    const preferred = this.ui.preferences.documentId;
    if (preferred && this.view.documents.some(d=>d.id===preferred)) await this.open(preferred, false);
    else if(this.ui.uiSeq==='0'&&this.view.documents.length===1)await this.open(this.view.documents[0].id,false);
    await this.listUI();await this.listStages();await this.discoverPending();await this.restorePending();
    this.patch({ready:true,uiPending:this.draftOwner.pendingRequests(),message:'Local recovery complete. Accepted edits are saved locally.'});
    this.startStream(lifetime);
  }
  disconnect() {
    browserPhases.reset();
    this.lifecycle++; this.stream?.abort(); clearTimeout(this.draftTimer);clearTimeout(this.retryTimer);
    void this.stopRecovery();
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
    try{
    const lifetime=this.lifecycle,documentLifetime=this.documentLifetime,cache=this.cache!,published=await cache.published();
    const [image,history,checkpoints,save]=await Promise.all([
      this.json<ImageState>('/api/v1/documents/'+document.id+'/image'),
      this.json<{items:ImageHistoryNode[];next:string|null}>('/api/v1/documents/'+document.id+'/history'),
      this.json<{items:Checkpoint[];next:string|null}>('/api/v1/documents/'+document.id+'/checkpoints'),
      this.json<EditorView['save']>('/api/v1/documents/'+document.id+'/save-status?sessionId='+this.sessionId),
    ]);
    if(lifetime!==this.lifecycle||documentLifetime!==this.documentLifetime||this.view.document?.id!==document.id)return;
    // The image read is immutable only at its document revision. Recheck the recovered document.
    if(document.image){const hash=new SHA256();hash.update(new TextEncoder().encode(canonical(image)));if(hash.digest()!==document.image.state.hash)return;}
    // History/checkpoint reads share the current document, not a recovery lease.
    // A final monotonic revision check prevents publishing any newer side panel
    // alongside the older complete recovered transaction.
    const live=await this.session.transport('/api/v1/documents/'+document.id,{method:'HEAD'}),version=live.headers.get('X-App-Entity-Version');
    if(lifetime!==this.lifecycle||documentLifetime!==this.documentLifetime||cache!==this.cache||this.view.document?.id!==document.id)return;
    if(!live.ok||version===null||!/^(0|[1-9][0-9]*)$/.test(version))throw Error('DOCUMENT_VERSION_UNAVAILABLE');
    if(version!==document.revision||lifetime!==this.lifecycle||cache!==this.cache||this.view.document?.id!==document.id||(await cache.published()).generation!==published.generation)return;
    const latest=await this.cache!.read('document',document.id) as Document;
    if(latest?.revision!==document.revision||documentLifetime!==this.documentLifetime||this.view.document?.id!==document.id)return;
    this.patch({document,image,history:history.items,historyNext:history.next,checkpoints:checkpoints.items,checkpointNext:checkpoints.next,save,
      selected:this.view.selected.filter(id=>document.orderedLayerIds.includes(id))});
    }finally{unpin?.();}
  }
  async open(id:string,persist=true) {
    const span=browserPhases.recorder.start('reopen',{documentId:id});
    const lifetime=this.lifecycle,owner=this.draftOwner;
    try{
    if(this.closingDocument)await this.closingDocument;
    if(lifetime!==this.lifecycle||owner!==this.draftOwner){span.end('cancelled');return;}
    const document=this.view.documents.find(d=>d.id===id);if(!document)throw Error('DOCUMENT_UNAVAILABLE');
    const documentLifetime=++this.documentLifetime;
    this.patch({document,review:null,selected:[],image:null,history:[],historyNext:null,checkpoints:[],checkpointNext:null,save:null});await this.loadDocument(document);
    if(lifetime!==this.lifecycle||owner!==this.draftOwner||documentLifetime!==this.documentLifetime||this.view.document?.id!==id){span.end('cancelled',{revision:document.revision});return;}
    if(persist)await this.preferences({documentId:id,selectedLayerIds:[]});else this.patch({selected:this.ui?.preferences.selectedLayerIds.filter(id=>document.orderedLayerIds.includes(id))??[]});
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
    const document=this.view.document;if(!document||checkpoint.documentId!==document.id)throw Error('DOCUMENT_CHANGED');
    let after:string|null=null;
    do{const page:{items:(ImageHistoryNode|HistoryNode)[];next:string|null}=await this.json('/api/v1/documents/'+document.id+'/history'+(after?'?after='+after:''));
      const node=page.items.find(n=>n.id===checkpoint.historyHead);if(node){if(!('kind' in node)&&!node.forward.after.image)throw Error('This retained empty-document checkpoint has no image state to restore.');await this.command({type:'SwitchBranch',branchId:node.branchId,historyNode:node.id},document);return;}after=page.next;
    }while(after);throw Error('CHECKPOINT_CONTENT_UNAVAILABLE');
  }
  async historyPage(kind:'history'|'checkpoints',after:string|null=null){
    const document=this.view.document,cache=this.cache,lifetime=this.lifecycle,documentLifetime=this.documentLifetime;if(!document||!cache)return;
    const published=await cache.published();
    const page=await this.json<{items:ImageHistoryNode[]|Checkpoint[];next:string|null}>('/api/v1/documents/'+document.id+'/'+kind+(after?'?after='+after:''));
    const probe=await this.session.transport('/api/v1/documents/'+document.id,{method:'HEAD'});
    const finalPublication=await cache.published();
    if(lifetime!==this.lifecycle||documentLifetime!==this.documentLifetime||cache!==this.cache||this.view.document?.id!==document.id||finalPublication.generation!==published.generation)return;
    const revision=probe.headers.get('X-App-Entity-Version');if(!probe.ok||revision===null||!/^(0|[1-9][0-9]*)$/.test(revision))throw Error('DOCUMENT_VERSION_UNAVAILABLE');
    if(revision!==document.revision||this.view.document.revision!==document.revision)return;
    this.patch(kind==='history'?{history:page.items as ImageHistoryNode[],historyNext:page.next}:{checkpoints:page.items as Checkpoint[],checkpointNext:page.next});
  }
  async listUI(next:string|null=null){
    const page=await this.json<UIInventory>('/api/v1/ui'+(next?'?cursor='+next:''));
    if(page.kind!=='ui-inventory'||page.semantics!=='current-at-page-read')throw Error('UI_INVENTORY_UNAVAILABLE');
    this.patch({uiChoices:page.items,uiNext:page.next});
  }
  async restoreUI(choice:UIInventory['items'][number]){
    if(this.draftOwner&&(this.draftOwner.hasRefusedChanges||[...this.draftOwner.drafts.values()].some(d=>d.generation!==d.savedGeneration||d.pending)))throw Error('Save or cancel the current unsaved draft before restoring another checkpoint.');
    const owner=new DraftPersistence(choice.sessionId,this.session.transport,this.session.csrf,this.journal);await owner.restore();
    if(owner.checkpoint!.uiSeq!==choice.uiSeq)throw Error('UI_CHANGED_IN_ANOTHER_TAB');
    this.draftOwner?.dispose();this.draftOwner=owner;this.ui=owner.checkpoint!;
    sessionStorage.setItem('ie-ui-session:'+this.owner,choice.sessionId);
    if(this.ui.preferences.documentId)await this.open(this.ui.preferences.documentId,false);
    this.patch({selected:this.ui.preferences.selectedLayerIds,drafts:'Restored UI checkpoint. Drafts remain unapplied.'});
  }
  async preferences(patch:Partial<Preferences>) {
    const run=async()=>{if(!this.ui)return;const request:UIRequest={protocolVersion:1,requestId:crypto.randomUUID(),sessionId:this.sessionId,expectedUISeq:this.ui.uiSeq,body:{type:'SetPreferences',preferences:{...this.ui.preferences,...patch}}};
      const receipt=await this.draftOwner!.dispatch(request);
      if(receipt.status==='rejected'){await this.draftOwner!.restore();this.ui=this.draftOwner!.checkpoint!;throw Error('UI_CHANGED_IN_ANOTHER_TAB');}
      this.ui={...this.ui,uiSeq:receipt.uiSeq,preferences:request.body.type==='SetPreferences'?request.body.preferences:this.ui.preferences};this.draftOwner!.checkpoint=this.ui;if(this.view.save)this.patch({save:{...this.view.save,bundleOutdated:true}});};
    this.uiTail=this.uiTail.catch(()=>{}).then(run);return this.uiTail;
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
    const code=error instanceof Error&&error.message?error.message:'CONTENT_UNAVAILABLE';
    const message=/STALE|CHANGED|CONFLICT/.test(code)?'Stale conflict. Your draft is retained. Review the current document before applying again.':/STORAGE_FULL|waiting-for-resources|CAPACITY/.test(code)?'Storage paused. Original bytes and command identities are retained. Free resources, then retry the same operation.':/MISSING|CORRUPT|UNAVAILABLE|NOT_FOUND/.test(code)?'Content unavailable or missing. Accepted records are retained; restore the exact resource, then reconnect.':/EXPIRED|SESSION|CSRF/.test(code)?'Connection or review expired. Reconnect and prepare a fresh review; the original command is unchanged.':code==='Failed to fetch'?'Local server disconnected. The original delivery is retained for receipt lookup.':code;
    this.patch({uiPending:this.draftOwner?.pendingRequests()??[],error:message,message:'Action needs attention.'});
  }
  async command(body:Command['body'],document:Document|null=this.view.document,newId?:string,onJournaled?:(commandId:string)=>void):Promise<DomainEvent[]> {
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
    if(body.type==='ExportDocument')this.exportAdmissions.set(request.command.commandId,new Promise<void>(resolve=>{submitted=resolve;}));
    try{
    await this.journal!.put('command:'+request.command.commandId,delivery);
    onJournaled?.(request.command.commandId);
    await this.restorePending();
    const events=await this.deliver(delivery,false,submitted);const registered=events.find(e=>e.type==='AssetRegistered');operation?.end('incomplete',{boundary:body.type==='PrepareCandidateAdoption'?'prepared-durable':'authority-durable',...(registered?.type==='AssetRegistered'?{outputAssetId:registered.payload.asset.id,assetHash:registered.payload.asset.blob.hash}:{})});return events;
    }catch(error){operation?.end('error');throw error;}finally{submitted?.();this.exportAdmissions.delete(request.command.commandId);}
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
    await this.draftOwner?.restore();this.ui=this.draftOwner?.checkpoint??undefined;this.startStream(this.lifecycle);
    this.patch({message:delivery.label+' accepted and saved locally.',recovery:'',drafts:this.draftStatus()});return events;
    }catch(error){acceptance.end('error');if(adoptionId)browserPhases.adoptionFailed(adoptionId);throw error;}
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
    let cursor:string|null=null;
    do {
      const page:PendingInventory=await this.json<PendingInventory>('/api/v1/commands/pending'+(cursor?'?cursor='+cursor:''));
      if(page.kind!=='pending-inventory'||page.semantics!=='pending-at-page-read')throw Error('PENDING_INVENTORY_UNAVAILABLE');
      for(const item of page.items){
        if(await this.journal!.has('command:'+item.commandId))continue;
        const response=await this.session.transport('/api/v1/commands/'+item.commandId+'/original');
        if(!response.ok)throw Error('ORIGINAL_COMMAND_UNAVAILABLE');const wire=await response.text();
        const request=parseControlJSON(new TextEncoder().encode(wire)) as CommandRequest;
        const hash=new SHA256();hash.update(new TextEncoder().encode(canonical(request)));
        if(request.command.clientId!==this.owner||request.command.commandId!==item.commandId||hash.digest()!==item.commandHash)throw Error('ORIGINAL_COMMAND_CHANGED');
        // Completion can race the inventory. Lookup supplies its current terminal receipt.
        const result=await this.json<CommandResult>('/api/v1/commands/'+item.commandId);
        await this.journal!.put('command:'+item.commandId,{request,wire,result,label:item.label} satisfies Delivery);
      }
      cursor=page.next;
    }while(cursor);
  }
  private async restorePending() {
    const journal=this.journal;if(!journal)return;const read=++this.pendingRead,lifetime=this.lifecycle;
    const metadata=allocationLedger.reserve({owner:'command-pending-control',kind:'control',cpuBytes:0,handles:1}),pending:Delivery[]=[];let installed=false;
    const current=()=>read===this.pendingRead&&lifetime===this.lifecycle&&journal===this.journal;
    try{
      await journal.scan<Delivery>('command:',delivery=>{
        if(!current())return false;if(delivery.result?.kind==='receipt')return;
        metadata.resize({cpuBytes:(pending.length+1)*1024*1024,handles:pending.length+2});pending.push(delivery);
      });
      if(!current())return;
      this.patch({pending});this.pendingMetadata?.release();this.pendingMetadata=metadata;installed=true;
    }finally{if(!installed)metadata.release();}
  }
  async retry(id:string) {
    const copy=allocationLedger.reserve({owner:'command-retry-control',kind:'control',cpuBytes:1024*1024,handles:1});
    try{const delivery=await this.journal!.get<Delivery>('command:'+id);if(!delivery)throw Error('COMMAND_UNAVAILABLE');await this.deliver(delivery,true);}finally{copy.release();}
  }
  async listStages(cursor:string|null=null){
    const page=await this.json<StagingRecoveryPage>('/api/v1/assets/staging/recovery'+(cursor?'?cursor='+cursor:''));
    this.patch({stages:page.items,stageNext:page.nextCursor});
  }
  async resumeStage(file:File,id:string){
    const stage=await this.json<StagingRecord>('/api/v1/assets/staging/'+id);
    if(stage.ownerClientId!==this.owner)throw Error('OWNER_REQUIRED');
    if(stage.purpose==='image')await this.importImage(file,stage);else if(stage.purpose==='bundle')await this.openBundle(file,stage);else throw Error('This staged content is retained; it has no active editor import workflow.');
    await this.listStages();
  }
  async upload(file:Blob,purpose:StagingCreateRequest['purpose'],mediaType:string,existing?:StagingRecord,stillCurrent:()=>boolean=()=>true) {
    const staging=browserPhases.recorder.start('asset.stage',{bytes:file.size});
    const session=this.session,identity=session.identity(),sessionId=this.sessionId,draftOwner=this.draftOwner,lifetime=this.lifecycle,documentLifetime=this.documentLifetime,owner=this.owner,abort=new AbortController();this.uploads.add(abort);
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
    }catch(error){staging.end('error');throw error;}finally{abort.abort();this.uploads.delete(abort);this.uploadSettlements.delete(abort);settled();}
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
    const stage=await this.upload(new Blob([text]),'caption','text/plain');
    const events=await this.command({type:'FinalizeStaging',stagingId:stage.stagingId,expectedSha256:stage.sha256},null);
    return this.asset(events).id;
  }
  private asset(events:DomainEvent[]) { const event=[...events].reverse().find(e=>e.type==='AssetRegistered');if(!event||event.type!=='AssetRegistered')throw Error('ASSET_UNAVAILABLE');return event.payload.asset; }
  async importImage(file:File,existing?:StagingRecord) {
    const target=this.view.document;
    const stage=await this.upload(file,'image',file.type,existing);
    const original=this.asset(await this.command({type:'FinalizeStaging',stagingId:stage.stagingId,expectedSha256:stage.sha256},null));
    const asset=this.asset(await this.command({type:'PrepareRaster',assetId:original.id},null));
    const event=(await this.command({type:'ReviewRaster',assetId:asset.id},null)).find(e=>e.type==='RasterReviewPrepared');
    if(!event||event.type!=='RasterReviewPrepared')throw Error('REVIEW_UNAVAILABLE');
    const review=await this.json<RasterReview>('/api/v1/assets/raster-reviews/'+event.payload.reviewId);
    this.patch({review:{kind:'image',asset,review,name:file.name,target},message:'Conversion ready. Review the pixels and choose Apply or Cancel.'});
  }
  async create(width:number,height:number) {
    const id=crypto.randomUUID();await this.command({type:'NewDocument',width,height,color:'sRGB',depth:8},null,id);await this.open(id);
  }
  async applyReview() {
    const selected=this.view.review;if(!selected)throw Error('REVIEW_UNAVAILABLE');
    if(selected.kind==='image'){
      const asset=this.asset(await this.command({type:'ApproveRaster',assetId:selected.asset.id,reviewId:selected.review.reviewId,reviewHash:selected.review.reviewHash},null));
      if(!selected.target)await this.create(asset.raster!.width,asset.raster!.height);
      const target=selected.target??this.view.document!;
      await this.command({type:'ImportAsset',assetId:asset.id,layerId:crypto.randomUUID(),name:selected.name,draft:null},target);
    }else if(selected.kind==='edit'){
      const d=this.view.documents.find(d=>d.id===selected.review.preview.documentId);if(!d||d.revision!==selected.review.preview.documentRevision)throw Error('STALE_REVISION');
      await this.command({type:selected.review.preview.kind==='resample-image'?'ResampleImage':'CreateFlattenedCopy',previewId:selected.review.preview.previewId,reviewId:selected.review.reviewId,reviewHash:selected.review.reviewHash,draft:null},d);
    }else{
      if(!selected.review.editable)throw Error(selected.review.reason??'BUNDLE_INSPECTION_ONLY');
      await this.command({type:'ImportBundle',reviewId:selected.review.reviewId,reviewHash:selected.review.reviewHash},null);await this.open(selected.review.documentId);
      await this.listUI();this.patch({drafts:'Portable UI checkpoints available in Open. Choose one to restore its drafts and view.'});
    }
    if(this.view.review===selected)this.patch({review:null});
  }
  async prepareEdit(body:Extract<Command['body'],{type:'PrepareImageResample'|'PrepareFlattenedCopy'}>) {
    const document=this.view.document!;const events=await this.command(body,document);
    const event=events.find(e=>e.type==='ImageEditPreviewPrepared');if(!event||event.type!=='ImageEditPreviewPrepared')throw Error('PREVIEW_UNAVAILABLE');
    const reviewed=await this.command({type:'ReviewImageEdit',previewId:event.payload.preview.previewId},document);
    const fact=reviewed.find(e=>e.type==='ImageEditReviewPrepared');if(!fact||fact.type!=='ImageEditReviewPrepared')throw Error('REVIEW_UNAVAILABLE');
    this.patch({review:{kind:'edit',review:await this.json<ImageEditReview>('/api/v1/image-edit-reviews/'+fact.payload.reviewId)},message:'Prepared image edit ready for explicit review.'});
  }
  async openBundle(file:File,existing?:StagingRecord) {
    const stage=await this.upload(file,'bundle','application/x-ideogram-project',existing);
    const events=await this.command({type:'PreviewBundleImport',stagingId:stage.stagingId,expectedSha256:stage.sha256},null);
    const event=events.find(e=>e.type==='BundleImportReviewed');if(!event||event.type!=='BundleImportReviewed')throw Error('REVIEW_UNAVAILABLE');
    this.patch({review:{kind:'bundle',review:await this.json<BundleReview>('/api/v1/bundle-reviews/'+event.payload.reviewId),name:file.name},message:'Portable project ready for review. Opening creates a new local identity.'});
  }
  async copy() {
    await this.flushDrafts();await this.uiTail;
    const events=await this.command({type:'SaveCopy'});const event=events.find(e=>e.type==='BundlePrepared');if(!event||event.type!=='BundlePrepared')throw Error('COPY_UNAVAILABLE');
    const bundle:Bundle=event.payload.bundle;
    this.patch({download:{path:'/api/v1/bundles/'+bundle.bundleId+'/content',name:'project.ideogram-project',hash:bundle.blob.hash,bytes:bundle.blob.byteLength,kind:'copy',documentId:bundle.documentId,revision:bundle.documentRevision,status:'ready'},message:'Copy ready. External destination is unconfirmed.'});
  }
  async prepareExport(options:DocumentExportOptions|undefined,document:Document,onJournaled?:(commandId:string)=>void) {
    return this.asset(await this.command({type:'ExportDocument',historyHead:document.historyHead,...(options?{options}:{})},document,undefined,onJournaled));
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
  confirmExport(asset:Asset,document:Document) {
    if(!asset.raster||asset.raster.role!=='export'||!['image/png','image/jpeg'].includes(asset.blob.mediaType))throw Error('EXPORT_UNAVAILABLE');
    const jpeg=asset.blob.mediaType==='image/jpeg';
    this.patch({download:{path:'/api/v1/assets/'+asset.id+'/content',name:'image.'+(jpeg?'jpg':'png'),hash:asset.blob.hash,bytes:asset.blob.byteLength,mediaType:asset.blob.mediaType,kind:'image',documentId:document.id,revision:document.revision,status:'ready'},message:'Export ready. External destination is unconfirmed.'});
  }
  async export() {
    const document=this.view.document!,owner=this.owner,lifetime=this.lifecycle,documentLifetime=this.documentLifetime;
    const asset=await this.prepareExport(undefined,document);
    if(owner===this.owner&&lifetime===this.lifecycle&&documentLifetime===this.documentLifetime&&this.view.document?.id===document.id)this.confirmExport(asset,document);
  }
  changeDraft(id:string,kind:'prompt'|'inspector'|'mask'|'text'|'composition'|'request',text:string,targetLayerId:string|null,composing:boolean,expectedRevision?:string) {
    const document=this.view.document;if(!document||!this.draftOwner)return;
    const prior=this.draftOwner.drafts.get(id);if(prior&&prior.text===text&&prior.composing===composing&&prior.expectedDocumentRevision===(expectedRevision??document.revision)){this.draftOwner.acceptRetained(id,text);return;}
    this.draftOwner.change({id,kind,text,documentId:document.id,targetLayerId,expectedDocumentRevision:expectedRevision??document.revision,composing});
    this.patch({drafts:'Unsaved UI draft',save:this.view.save?{...this.view.save,draftDirty:true,bundleOutdated:true}:null});clearTimeout(this.draftTimer);
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
    clearTimeout(this.draftTimer);const owner=this.draftOwner;if(!owner)return;
    for(const [id,draft] of owner.drafts){if(draft.savedGeneration===draft.generation||draft.pending||draft.composing&&draft.kind!=='text')continue;
      // A refused workspace or interrupted delivery must not poison the tail
      // forever. DraftPersistence retries any retained original delivery ID.
      this.patch({drafts:'Draft saving…'});await this.uiTail.catch(()=>{});
      // The retained source and outgoing-generation pin are separate. This
      // workspace covers parsed UTF-16 payload (2), output JSON (2), UTF-8 (3),
      // validation round-trip text (2) and Blob payload (3) per source unit.
      this.uiTail=owner.save(id,async text=>{const workspace=allocationLedger.reserve({owner:'draft-save-scratch',kind:'prompt',cpuBytes:text.length*12,handles:4});try{if(draft.kind==='request'){const {draft:value,text:prompt}=JSON.parse(text);const bytes=new TextEncoder().encode(prompt);if(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)!==prompt)throw Error('Invalid Unicode prompt retained.');value.prompt.text=await this.stageTextBlob(new Blob([bytes]),'text/plain');return await this.caption(canonical(value));}if(draft.kind==='composition'){const value=JSON.parse(text),graph=await this.stageTextBlob(new Blob([canonical(value)]),'application/json');return await this.caption(canonical({schemaVersion:1,kind:'composition-draft-1',graph,raw:[...value.composition.raw,...(value.composition.review?[value.composition.review.prompt]:[])],bindings:value.bindings}));}if(draft.kind!=='text')return await this.caption(text);const value=JSON.parse(text);if(new TextDecoder('utf-8',{ignoreBOM:true}).decode(new TextEncoder().encode(value.text))!==value.text)throw Error('Invalid Unicode draft retained in the editor. Replace the invalid character before saving.');const textUtf8=await this.stageTextBlob(new Blob([value.text]),'text/plain');return await this.caption(canonical({...(value.placement?{schemaVersion:2,kind:'text-draft-2',placement:value.placement}:{schemaVersion:1,kind:'text-draft-1'}),textUtf8,style:value.style,frame:value.frame,fonts:value.fonts}));}finally{workspace.release();}});const receipt=await this.uiTail as UIReceipt|undefined;this.ui=owner.checkpoint!;
      if(receipt?.status==='rejected')throw Error(receipt.reason??'DRAFT_CHANGED');
    }
    if(this.view.document)await this.loadDocument(this.view.document);
    this.patch({drafts:this.draftStatus()});
  }
  async draftText(id:string) {
    const owner=this.draftOwner!,epoch=this.documentLifetime,abort=new AbortController();
    const operation=(async()=>{try{await owner.restoreDraft(id,async assetId=>{
      const response=await this.session.transport('/api/v1/assets/'+assetId+'/content',{signal:abort.signal});if(!response.ok)throw Error('DRAFT_UNAVAILABLE');
      const text=await response.text();if(abort.signal.aborted||owner!==this.draftOwner||epoch!==this.documentLifetime)throw Error('DRAFT_READ_CANCELLED');return text;
    });return abort.signal.aborted||owner!==this.draftOwner||epoch!==this.documentLifetime?'':owner.drafts.get(id)?.text??'';}catch(error){if(abort.signal.aborted)return '';throw error;}})();
    this.draftReads.set(abort,operation);try{return await operation;}finally{abort.abort();this.draftReads.delete(abort);}
  }
  async retryDraft(id:string){
    const receipt=await this.draftOwner!.retry(id);await this.draftOwner!.restore();this.ui=this.draftOwner!.checkpoint!;
    this.patch({uiPending:this.draftOwner!.pendingRequests(),drafts:receipt.status==='accepted'?'Draft saved locally; not applied to the document':'Draft conflict retained'});
    if(receipt.status==='rejected')throw Error(receipt.reason??'DRAFT_CHANGED');
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
    const owner=this.draftOwner!,draft=owner.drafts.get(id);if(!draft)return;
    await this.uiTail;const request:UIRequest={protocolVersion:1,requestId:crypto.randomUUID(),sessionId:this.sessionId,expectedUISeq:owner.checkpoint!.uiSeq,body:{type:'ClearDraft',draftId:id,generation:draft.generation}};
    const receipt=await owner.dispatch(request);if(receipt.status!=='accepted')throw Error('DRAFT_CHANGED');owner.drafts.delete(id);await owner.restore();this.ui=owner.checkpoint!;this.patch({drafts:''});if(this.view.document)await this.loadDocument(this.view.document);
  }
  dispose(){
    this.disconnect();this.pendingRead++;this.draftOwner?.dispose();const cache=this.cache,journal=this.journal;
    // Preserve synchronous invalidation while retiring native reads and cache
    // work before closing their captured handles. Failed drains remain visible.
    void Promise.all([this.recoveryDrain,this.syncTask?.catch(()=>{}),this.refreshTask?.catch(()=>{})]).then(()=>{cache?.close();journal?.close();}).catch(error=>this.fail(error));
    this.patch({pending:[],documents:[],document:null});this.pendingMetadata?.release();this.pendingMetadata=undefined;this.documentsMetadata?.release();this.documentsMetadata=undefined;
  }
}
