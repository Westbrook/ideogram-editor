import { createValueModel } from '@en-reve/primitives/state/value.js';
import type { createSessionClient } from './session-client.js';
import { RecoveryCache, RecoveryPublicationConflict } from './recovery-cache.js';
import { RecoveryConsumer } from './recovery-client.js';
import { BrowserJournal } from './browser-journal.js';
import { DraftPersistence } from './draft-persistence.js';
import { EMPTY_EXPECTED_VERSIONS, type Command, type CommandRequest, type Document, type DomainEvent, type Receipt, type Checkpoint } from '../protocol/store.js';
import type { CommandResult, EventPage, PendingInventory } from '../protocol/recovery.js';
import type { Asset, StagingCreateRequest, StagingRecord, StagingRecoveryPage } from '../protocol/assets.js';
import type { ImageState, ImageHistoryNode, ImageEditReview } from '../protocol/history.js';
import type { Bundle, BundleReview } from '../protocol/portable.js';
import type { RasterReview } from '../protocol/raster.js';
import type { UICheckpoint, UIRequest, UIReceipt, Preferences, UIInventory } from '../protocol/ui.js';
import { SHA256 } from '../protocol/sha256.js';
import { canonical, parseControlJSON } from '../protocol/json.js';
import { event as validateEvent } from '../protocol/validate.js';

type Session = ReturnType<typeof createSessionClient>;
type Delivery = { request: CommandRequest; wire: string; result?: CommandResult; label: string };
export type Review = { kind: 'image'; asset: Asset; review: RasterReview; name: string; target: Document | null }
 | { kind: 'edit'; review: ImageEditReview }
 | { kind: 'bundle'; review: BundleReview; name: string };
export type Download = { path: string; name: string; hash: string; bytes: string; kind: 'copy' | 'image'; documentId:string;revision:string; status: 'ready' | 'writing' | 'unconfirmed' | 'confirmed' | 'failed' };
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
export class EditorClient {
  readonly state = createValueModel<EditorView>({ready:false,busy:false,message:'Connect locally to open your work.',error:'',recovery:'',documents:[],document:null,image:null,history:[],historyNext:null,checkpoints:[],checkpointNext:null,review:null,download:null,selected:[],save:null,drafts:'',pending:[],uiPending:[],cursor:'0',uiChoices:[],uiNext:null,stages:[],stageNext:null});
  private cache?: RecoveryCache;
  private consumer?: RecoveryConsumer;
  private journal?: BrowserJournal;
  private lifecycle = 0;
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
  constructor(readonly session: Session) {}
  patch(value: Partial<EditorView>) { this.state.set({...this.state.value.get(),...value}); }
  get view() { return this.state.value.get(); }
  get sessionId() { return this.ui?.sessionId ?? 'editor_' + this.owner; }
  async json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.session.transport(path, init);
    if(response.status===204)return undefined as T;
    const value = await response.json();
    if (!response.ok) throw new Error(value.error?.code ?? 'CONTENT_UNAVAILABLE');
    return value as T;
  }
  private post<T>(path: string, body: unknown) { return this.json<T>(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); }
  async connect() {
    const owner = this.session.identity(); if (!owner) { this.disconnect(); return; }
    const previousOwner=this.owner;
    const lifetime = ++this.lifecycle;clearTimeout(this.retryTimer);this.stream?.abort();await this.streamTask;
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
    if(!this.draftOwner||this.draftOwner.sessionId!==sessionId)this.draftOwner = new DraftPersistence(sessionId, this.session.transport, this.session.csrf,this.journal);
    await this.draftOwner.restore(); this.ui = this.draftOwner.checkpoint!;
    await this.sync(); if (lifetime !== this.lifecycle) return;
    const preferred = this.ui.preferences.documentId;
    if (preferred && this.view.documents.some(d=>d.id===preferred)) await this.open(preferred, false);
    else if(this.view.documents.length===1)await this.open(this.view.documents[0].id,false);
    await this.listUI();await this.listStages();await this.discoverPending();await this.restorePending();
    this.patch({ready:true,uiPending:this.draftOwner.pendingRequests(),message:'Local recovery complete. Accepted edits are saved locally.'});
    this.startStream(lifetime);
  }
  disconnect() {
    this.lifecycle++; this.stream?.abort(); clearTimeout(this.draftTimer);clearTimeout(this.retryTimer);
    this.patch({ready:false,review:null,recovery:'Disconnected. Drafts remain editable in this tab; document commands require the local writer.'});
  }
  private startStream(lifetime: number) {
    const consumer=this.consumer;if(!consumer||lifetime!==this.lifecycle||this.stream&&!this.stream.signal.aborted)return;
    const abort = new AbortController(); this.stream=abort;
    // Poll only the published pointer while the real SSE consumer publishes whole transactions.
    let cursor=this.view.cursor;
    const timer=setInterval(()=>{void this.cache?.published().then(p=>{if(p.cursor!==cursor){cursor=p.cursor;void this.refresh().catch(e=>this.fail(e));}});},100);
    this.streamTask=consumer.consumeStream(abort.signal).catch(error=>{
      if(!abort.signal.aborted&&lifetime===this.lifecycle){
        this.patch({recovery:'Updates interrupted. Recovering complete transactions; the last valid view is retained.'});
        abort.abort();clearTimeout(this.retryTimer);
        this.retryTimer=setTimeout(()=>{void this.sync().then(()=>{if(lifetime!==this.lifecycle)return;this.retryDelay=250;this.patch({recovery:''});this.startStream(lifetime);}).catch(e=>{this.fail(e);this.retryDelay=Math.min(4000,this.retryDelay*2);this.startStream(lifetime);});},this.retryDelay);
      }
    }).finally(()=>clearInterval(timer));
  }
  async sync() {
    if(this.syncTask)return this.syncTask;
    this.syncTask=(async()=>{
      const cache=this.cache,consumer=this.consumer!,lifetime=this.lifecycle;
      this.stream?.abort();await this.streamTask;
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
      const cache=this.cache!;const published=await cache.published();const documents:Document[]=[];
      for await(const row of cache.rows(published.generation,'document'))documents.push(row.value as Document);
      // A competing publication invalidates this enumeration; never publish a partial document list.
      if((await cache.published()).generation!==published.generation)return;
      const current=documents.find(d=>d.id===this.view.document?.id)??null;
      this.patch({documents,cursor:published.cursor});
      if(current)await this.loadDocument(current);
    })().finally(()=>{this.refreshTask=undefined;if(this.refreshAgain){this.refreshAgain=false;void this.refresh().catch(e=>this.fail(e));}});return this.refreshTask;
  }
  private async loadDocument(document:Document) {
    const lifetime=this.lifecycle,cache=this.cache!,published=await cache.published();
    const [image,history,checkpoints,save]=await Promise.all([
      this.json<ImageState>('/api/v1/documents/'+document.id+'/image'),
      this.json<{items:ImageHistoryNode[];next:string|null}>('/api/v1/documents/'+document.id+'/history'),
      this.json<{items:Checkpoint[];next:string|null}>('/api/v1/documents/'+document.id+'/checkpoints'),
      this.json<EditorView['save']>('/api/v1/documents/'+document.id+'/save-status?sessionId='+this.sessionId),
    ]);
    if(lifetime!==this.lifecycle||this.view.document?.id!==document.id)return;
    // The image read is immutable only at its document revision. Recheck the recovered document.
    if(document.image){const hash=new SHA256();hash.update(new TextEncoder().encode(canonical(image)));if(hash.digest()!==document.image.state.hash)return;}
    // History/checkpoint reads share the current document, not a recovery lease.
    // A final monotonic revision check prevents publishing any newer side panel
    // alongside the older complete recovered transaction.
    const live=await this.session.transport('/api/v1/documents/'+document.id,{method:'HEAD'}),version=live.headers.get('X-App-Entity-Version');
    if(lifetime!==this.lifecycle||cache!==this.cache||this.view.document?.id!==document.id)return;
    if(!live.ok||version===null||!/^(0|[1-9][0-9]*)$/.test(version))throw Error('DOCUMENT_VERSION_UNAVAILABLE');
    if(version!==document.revision||lifetime!==this.lifecycle||cache!==this.cache||this.view.document?.id!==document.id||(await cache.published()).generation!==published.generation)return;
    const latest=await this.cache!.read('document',document.id) as Document;
    if(latest?.revision!==document.revision)return;
    this.patch({document,image,history:history.items,historyNext:history.next,checkpoints:checkpoints.items,checkpointNext:checkpoints.next,save,
      selected:this.view.selected.filter(id=>document.orderedLayerIds.includes(id))});
  }
  async open(id:string,persist=true) {
    const document=this.view.documents.find(d=>d.id===id);if(!document)throw Error('DOCUMENT_UNAVAILABLE');
    this.patch({document,review:null,selected:[],image:null,history:[],historyNext:null,checkpoints:[],checkpointNext:null,save:null});await this.loadDocument(document);
    if(persist)await this.preferences({documentId:id,selectedLayerIds:[]});else this.patch({selected:this.ui?.preferences.selectedLayerIds.filter(id=>document.orderedLayerIds.includes(id))??[]});
  }
  async openCheckpoint(checkpoint:Checkpoint){
    const document=this.view.document;if(!document||checkpoint.documentId!==document.id)throw Error('DOCUMENT_CHANGED');
    let after:string|null=null;
    do{const page:{items:ImageHistoryNode[];next:string|null}=await this.json('/api/v1/documents/'+document.id+'/history'+(after?'?after='+after:''));
      const node=page.items.find(n=>n.id===checkpoint.historyHead);if(node){if(node.kind!=='image-edit')throw Error('This retained empty-document checkpoint has no image state to restore.');await this.command({type:'SwitchBranch',branchId:node.branchId,historyNode:node.id},document);return;}after=page.next;
    }while(after);throw Error('CHECKPOINT_CONTENT_UNAVAILABLE');
  }
  async historyPage(kind:'history'|'checkpoints',after:string|null=null){
    const document=this.view.document,cache=this.cache,lifetime=this.lifecycle;if(!document||!cache)return;
    const published=await cache.published();
    const page=await this.json<{items:ImageHistoryNode[]|Checkpoint[];next:string|null}>('/api/v1/documents/'+document.id+'/'+kind+(after?'?after='+after:''));
    const probe=await this.session.transport('/api/v1/documents/'+document.id,{method:'HEAD'});
    if(lifetime!==this.lifecycle||cache!==this.cache||this.view.document?.id!==document.id||(await cache.published()).generation!==published.generation)return;
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
    if(this.draftOwner&&[...this.draftOwner.drafts.values()].some(d=>d.generation!==d.savedGeneration||d.pending))throw Error('Save or cancel the current unsaved draft before restoring another checkpoint.');
    const owner=new DraftPersistence(choice.sessionId,this.session.transport,this.session.csrf,this.journal);await owner.restore();
    if(owner.checkpoint!.uiSeq!==choice.uiSeq)throw Error('UI_CHANGED_IN_ANOTHER_TAB');
    this.draftOwner=owner;this.ui=owner.checkpoint!;
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
  async command(body:Command['body'],document:Document|null=this.view.document,newId?:string):Promise<DomainEvent[]> {
    if(!this.owner)throw Error('SESSION_REQUIRED');
    const request:CommandRequest={protocolVersion:1,command:{schemaVersion:1,commandId:crypto.randomUUID(),clientId:this.owner,sessionId:this.sessionId,correlationId:crypto.randomUUID(),causationId:null,transactionId:crypto.randomUUID(),documentId:newId??document?.id??null,expectedDocumentRevision:document?.revision??null,expectedEntityVersions:EMPTY_EXPECTED_VERSIONS,issuedAt:new Date().toISOString(),body}};
    const delivery:Delivery={request,wire:JSON.stringify(request),label:body.type};
    await this.journal!.put('command:'+request.command.commandId,delivery);
    await this.restorePending();
    return this.deliver(delivery,false);
  }
  private async deliver(delivery:Delivery,lookup:boolean):Promise<DomainEvent[]> {
    const id=delivery.request.command.commandId;
    let value:CommandResult;
    if(lookup){const response=await this.session.transport('/api/v1/commands/'+id);value=await response.json();if(value.kind==='unknown'||value.kind==='pending'&&value.phase==='waiting-for-resources')value=await this.json('/api/v1/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:delivery.wire});}
    else value=await this.json('/api/v1/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:delivery.wire});
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
      const detail=value.rejectionDetails?.kind==='inline'?JSON.stringify(value.rejectionDetails.value):'';
      throw Error(value.receipt.code+' '+detail);
    }
    // Exact result inspection and complete projection recovery are independent
    // reads of an already durable receipt. Keep both proofs, without serial
    // transport waits. A joined older recovery must still reach this receipt.
    const receipt=value.receipt;
    const [events]=await Promise.all([this.events(receipt),(async()=>{do{await this.sync();}while(BigInt((await this.cache!.published()).cursor)<BigInt(receipt.toSeq));})()]);
    await this.draftOwner?.restore();this.ui=this.draftOwner?.checkpoint??undefined;this.startStream(this.lifecycle);
    this.patch({message:delivery.label+' accepted and saved locally.',recovery:'',drafts:this.draftStatus()});return events;
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
        if(!response.ok||!response.body||response.headers.get('etag')!=='"'+ref.blob.hash+'"'||response.headers.get('content-length')!==ref.blob.byteLength)throw Error('TRANSACTION_UNAVAILABLE');
        const reader=response.body.getReader(),hash=new SHA256();let length=0n,pending=new Uint8Array(0);
        try{for(;;){const {done,value}=await reader.read();if(done)break;length+=BigInt(value.length);hash.update(value);
          for(let offset=0;offset<value.length;offset+=16384){const chunk=value.subarray(offset,offset+16384),joined=new Uint8Array(pending.length+chunk.length);joined.set(pending);joined.set(chunk,pending.length);let start=0;
            for(let i=0;i<joined.length;i++)if(joined[i]===10){if(i-start>16384)throw Error('TRANSACTION_CORRUPT');accept(parseControlJSON(joined.subarray(start,i)) as DomainEvent);start=i+1;}
            pending=joined.slice(start);if(pending.length>16384)throw Error('TRANSACTION_CORRUPT');
          }
        }}finally{await reader.cancel();}
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
        if(await this.journal!.get('command:'+item.commandId))continue;
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
  private async restorePending() { if(this.journal)this.patch({pending:(await this.journal.entries<Delivery>('command:')).filter(d=>d.result?.kind!=='receipt')}); }
  async retry(id:string) { const delivery=await this.journal!.get<Delivery>('command:'+id);if(!delivery)throw Error('COMMAND_UNAVAILABLE');await this.deliver(delivery,true); }
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
  async upload(file:Blob,purpose:StagingCreateRequest['purpose'],mediaType:string,existing?:StagingRecord) {
    const hash=new SHA256();let at=0,started=performance.now();
    while(at<file.size){const bytes=new Uint8Array(await file.slice(at,at+65536).arrayBuffer());hash.update(bytes);at+=bytes.length;if(performance.now()-started>4){await tick();started=performance.now();}}
    const sha256=hash.digest();
    if(existing&&(existing.sha256!==sha256||existing.expectedBytes!==String(file.size)))throw Error('ORIGINAL_FILE_HASH_MISMATCH');
    const request:StagingCreateRequest=existing??{protocolVersion:1,stagingId:crypto.randomUUID(),purpose,expectedBytes:String(file.size),sha256,mediaType};
    if(!existing)await this.post('/api/v1/assets/staging',request);
    let stage=await this.json<StagingRecord>('/api/v1/assets/staging/'+request.stagingId);
    while(BigInt(stage.committedOffset)<BigInt(file.size)){
      const offset=Number(stage.committedOffset),bytes=await file.slice(offset,offset+1048576).arrayBuffer();
      stage=await this.json<StagingRecord>('/api/v1/assets/staging/'+request.stagingId,{method:'PUT',headers:{'Content-Type':'application/octet-stream','Upload-Offset':stage.committedOffset},body:bytes});
    }
    return request;
  }
  async stageTextBlob(blob:Blob,mediaType:string,purpose:StagingCreateRequest['purpose']='text') {
    const stage=await this.upload(blob,purpose,purpose==='caption'?'text/plain':'application/octet-stream');
    const asset=this.asset(await this.command({type:'FinalizeStaging',stagingId:stage.stagingId,expectedSha256:stage.sha256},null));
    return {...asset.blob,mediaType};
  }
  async fontAssets() {
    const cache=this.cache!,fonts=await cache.collect<Asset>('asset',asset=>!!asset.font);
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
  async export() {
    const document=this.view.document!;
    const events=await this.command({type:'ExportDocument',historyHead:this.view.document!.historyHead});const asset=this.asset(events);
    this.patch({download:{path:'/api/v1/assets/'+asset.id+'/content',name:'image.png',hash:asset.blob.hash,bytes:asset.blob.byteLength,kind:'image',documentId:document.id,revision:document.revision,status:'ready'},message:'Exact PNG ready. External destination is unconfirmed.'});
  }
  changeDraft(id:string,kind:'prompt'|'inspector'|'mask'|'text',text:string,targetLayerId:string|null,composing:boolean,expectedRevision?:string) {
    const document=this.view.document;if(!document||!this.draftOwner)return;
    const prior=this.draftOwner.drafts.get(id);if(prior&&prior.text===text&&prior.composing===composing&&prior.expectedDocumentRevision===(expectedRevision??document.revision))return;
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
      this.patch({drafts:'Draft saving…'});await this.uiTail;
      this.uiTail=owner.save(id,async text=>{if(draft.kind!=='text')return this.caption(text);const value=JSON.parse(text);if(new TextDecoder('utf-8',{ignoreBOM:true}).decode(new TextEncoder().encode(value.text))!==value.text)throw Error('Invalid Unicode draft retained in the editor. Replace the invalid character before saving.');const textUtf8=await this.stageTextBlob(new Blob([value.text]),'text/plain');return this.caption(canonical({...(value.placement?{schemaVersion:2,kind:'text-draft-2',placement:value.placement}:{schemaVersion:1,kind:'text-draft-1'}),textUtf8,style:value.style,frame:value.frame,fonts:value.fonts}));});const receipt=await this.uiTail as UIReceipt|undefined;this.ui=owner.checkpoint!;
      if(receipt?.status==='rejected')throw Error(receipt.reason??'DRAFT_CHANGED');
    }
    if(this.view.document)await this.loadDocument(this.view.document);
    this.patch({drafts:this.draftStatus()});
  }
  async draftText(id:string) {
    const owner=this.draftOwner!;await owner.restoreDraft(id,async assetId=>{
      const response=await this.session.transport('/api/v1/assets/'+assetId+'/content');if(!response.ok)throw Error('DRAFT_UNAVAILABLE');
      return response.text();
    });return owner.drafts.get(id)?.text??'';
  }
  async retryDraft(id:string){
    const receipt=await this.draftOwner!.retry(id);await this.draftOwner!.restore();this.ui=this.draftOwner!.checkpoint!;
    this.patch({uiPending:this.draftOwner!.pendingRequests(),drafts:receipt.status==='accepted'?'Draft saved locally; not applied to the document':'Draft conflict retained'});
    if(receipt.status==='rejected')throw Error(receipt.reason??'DRAFT_CHANGED');
  }
  async clearDraft(id:string) {
    const owner=this.draftOwner!,draft=owner.drafts.get(id);if(!draft)return;
    await this.uiTail;const request:UIRequest={protocolVersion:1,requestId:crypto.randomUUID(),sessionId:this.sessionId,expectedUISeq:owner.checkpoint!.uiSeq,body:{type:'ClearDraft',draftId:id,generation:draft.generation}};
    const receipt=await owner.dispatch(request);if(receipt.status!=='accepted')throw Error('DRAFT_CHANGED');owner.drafts.delete(id);await owner.restore();this.ui=owner.checkpoint!;this.patch({drafts:''});if(this.view.document)await this.loadDocument(this.view.document);
  }
  dispose(){this.disconnect();this.cache?.close();this.journal?.close();}
}
