import {StorageReads} from '../storage-reads.js';
import {CompositionReads} from '../composition-memory.js';
import {allocationLedger,type AllocationLease} from '../../src/observability/allocations.js';
import {DiagnosticReceiver,STORAGE_DIAGNOSTIC_BYTES,STORAGE_DIAGNOSTIC_HANDLES,STORAGE_DIAGNOSTIC_REPLY_BYTES,type DiagnosticIngress} from '../observability/diagnostic-memory.js';
import type {DiagnosticRead} from '../../src/observability/diagnostic-memory.js';
import type {QueueStore} from './queue.js';
import type { Portables } from './portable.js';
import { Worker } from 'node:worker_threads';
import type { BlobRef, Document, DomainEvent, Receipt } from '../../src/protocol/store.js';
import { acquireRoot } from './ownership.js';
import { StoreError, safeError } from './errors.js';
import type { StoreErrorCode } from './errors.js';
import type { RecoveryStore, StoredContent } from './recovery.js';
import type { Assets, AssetAuth } from './assets.js';
import type { Adapters } from './adapters.js';
import type { Histories } from './history.js';
import type { UIStore } from './ui.js';
import type { Rasters } from './raster.js';
import type { Displays } from './display.js';
import type {StorageLibrary} from './library.js';
import type {StorageRepairs} from './storage-repair.js';
import type {StorageCategory} from '../../src/protocol/storage.js';
import type { DisplayRequest, DisplayInfo } from '../../src/protocol/display.js';
import type { StoreDatabase } from './database.js';
import { IO_CHUNK } from './objects.js';
import { PrivateRootError } from '../private-root.js';
import type { ProviderRuntimeConfig } from '../provider/config.js';
import type { ProviderView } from '../../src/protocol/provider.js';
import { adapterResources } from '../observability/adapter-resources.js';
import type { WorkerAdapterResourceSnapshot } from './worker.js';

function combineAdapterResources(worker:WorkerAdapterResourceSnapshot){
  const main=adapterResources.snapshot(),intact=main.droppedTransitions===0&&main.unscopedReturnedBuffers===0;
  const aggregate=main.aggregate,aggregateBound=aggregate.shared&&worker.ledger.aggregate.shared&&aggregate.aggregateId===worker.ledger.aggregate.aggregateId;
  const writers=main.ownedWorkerThreads.filter(thread=>thread.kind==='writer'),knownWriter=writers.length===1&&writers[0].threadId===worker.ledger.threadId&&worker.ledger.pid===main.pid;
  const observed=intact&&aggregate.integrityComplete&&aggregateBound;
  const baseCoverage={...worker.coverage,processTree:worker.coverage.processTree&&knownWriter&&observed,workerThreads:worker.coverage.workerThreads&&knownWriter&&observed,
    stagingBuffers:worker.coverage.stagingBuffers&&observed,ioCopies:worker.coverage.ioCopies&&observed,metadataConsumers:worker.coverage.metadataConsumers&&observed,
    assetReadHandles:worker.coverage.assetReadHandles&&observed,streamHandles:worker.coverage.streamHandles&&observed};
  const finiteHandles=(groups:typeof main.groups)=>groups.filter(group=>group.owner!=='owned-worker').reduce((sum,group)=>sum+group.handles,0);
  const serviceHandles=(groups:typeof main.groups)=>groups.filter(group=>group.owner==='owned-worker').reduce((sum,group)=>sum+group.handles,0);
  const activeOwners={mainHandles:finiteHandles(main.groups),responseBuffers:main.groups.filter(group=>group.owner==='protocol-response'||group.owner==='composition-response').reduce((sum,group)=>sum+group.buffers,0),workerMethods:worker.owners.activeMethods.reduce((sum,entry)=>sum+entry.count,0),
    assetPreparations:worker.owners.assets.runningPreparations,preparationPromises:worker.owners.assets.preparationPromises,
    assetChunkLeases:worker.owners.assets.chunkLeases,assetContentReaders:worker.owners.assets.contentReaders};
  const settled=Object.values(activeOwners).every(count=>count===0),baseComplete=Object.values(baseCoverage).every(Boolean);
  const completeScopedOwnerSnapshot=baseComplete&&worker.owners.quiescence.complete&&settled;
  const retainedHandles=completeScopedOwnerSnapshot?finiteHandles(worker.ledger.groups)+worker.owners.objects.proofReservations+main.returnedBuffers+worker.ledger.returnedBuffers:null;
  const coverage={...baseCoverage,handles:completeScopedOwnerSnapshot};
  const intervalQuiescenceProven=observed&&baseComplete&&aggregate.lifecycleWindow?.coverage.complete===true;
  return {kind:'adapter-resource-observation-1' as const,worker,main,aggregate:{...aggregate,integrityComplete:aggregate.integrityComplete&&aggregateBound,coverageComplete:intervalQuiescenceProven},coverage,
    scope:{kind:'backend-owned-process-and-threads',processes:[{pid:main.pid,parentPid:main.parentPid}],completeScopedOwnerSnapshot,intervalQuiescenceProven},
    handleClassification:{kind:'scoped-handle-classification-1' as const,complete:completeScopedOwnerSnapshot,settled,serviceHandles:{main:serviceHandles(main.groups),worker:serviceHandles(worker.ledger.groups)},activeOwners,retainedHandles},
    ...(retainedHandles===null?{}:{unusedHandles:retainedHandles})};
}

export type WriterOptions = { root: string; quotaBytes?: string; provider?: ProviderRuntimeConfig };
// Internal process/filesystem tests only. Not an HTTP/CLI/environment setting.
export type WriterTestOptions = { phase?: string; gate?: SharedArrayBuffer; onBarrier?: (phase: string) => void;
  onFailure?: (failure: { code?: string; sqliteCode?: number }) => void; maxPageCount?: number; effectCounters?: SharedArrayBuffer; setupModule?:string };
export async function openWriter(options: WriterOptions, testing?: WriterTestOptions) {
  if (process.versions.node !== '26.10.0') throw new StoreError('UNSUPPORTED_STORAGE');
  if (options.quotaBytes !== undefined && !/^[1-9][0-9]*$/.test(options.quotaBytes)) throw new StoreError('MALFORMED_REQUEST');
  const releaseOpening=adapterResources.uncovered('writer-opening');
  const owner = await acquireRoot(options.root).catch(error => {
    releaseOpening();
    throw error instanceof PrivateRootError ? new StoreError('ROOT_UNSAFE') : safeError(error);
  });
  let worker: Worker;let diagnosticGrant:AllocationLease|undefined;
  const diagnosticReads=new DiagnosticReceiver('diagnostic-writer-ingress',STORAGE_DIAGNOSTIC_REPLY_BYTES);
  const diagnosticPending=new Map<number,DiagnosticIngress<unknown>>();
  function admitDiagnostic():DiagnosticIngress<unknown>{
    const ingress=diagnosticReads.admit<unknown>(),release=adapterResources.uncovered('writer-diagnostic-read');
    return Object.freeze({
      receive(value:unknown){const read=ingress.receive(value);return Object.freeze({get value(){return read.value;},release(){read.release();release();}});},
      settledWithoutValue(){ingress.settledWithoutValue();release();},
      get pending(){return ingress.pending;}
    });
  }
  const adapterResourceParticipant=adapterResources.reserveAggregateParticipant();
  try {
    diagnosticGrant=allocationLedger.reserve({owner:'diagnostic-storage-worker',kind:'control',cpuBytes:STORAGE_DIAGNOSTIC_BYTES,handles:STORAGE_DIAGNOSTIC_HANDLES});
    worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: { diagnosticBytes:STORAGE_DIAGNOSTIC_BYTES, root: owner.path, identity: owner.identity, quotaBytes: options.quotaBytes, provider: options.provider,
      adapterResourceAggregate:adapterResources.aggregateBuffer(),adapterResourceParticipant,
      testing: testing ? { phase: testing.phase, gate: testing.gate, maxPageCount: testing.maxPageCount, effectCounters: testing.effectCounters, setupModule:testing.setupModule } : undefined },
      ...(process.execArgv.some(arg => arg.startsWith('--input-type')) ?
        { execArgv: process.execArgv.filter(arg => !arg.startsWith('--input-type')) } : {}),
      env: {}, resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 } });
  } catch (error) { adapterResources.retireAggregateParticipant(adapterResourceParticipant);releaseOpening();diagnosticGrant?.release();owner.close(); throw safeError(error); }
  const releaseWorkerIdentity=adapterResources.worker('writer',worker.threadId);
  let sequence = 0; let ended = false; let closing = false;let closeAcknowledged=false;let compositionReads:CompositionReads|undefined;let storageReads:StorageReads|undefined;let storageExited:Promise<void>|undefined;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void;release:()=>void;method:string }>();
  const fail = (code: StoreErrorCode) => { for (const item of pending.values()){item.release();item.reject(new StoreError(code));} pending.clear(); };
  let readyResolve: (epoch: string) => void; let readyReject: (error: Error) => void;
  const ready = new Promise<string>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const exited = new Promise<void>(resolve => worker.once('exit', () => {
    adapterResources.retireAggregateParticipant(adapterResourceParticipant,!closeAcknowledged);releaseWorkerIdentity();
    ended = true; compositionReads?.nativeExited();storageExited=storageReads?.nativeExited();void storageExited?.catch(()=>{});diagnosticReads.nativeExited();for(const diagnostic of diagnosticPending.values())diagnostic.settledWithoutValue();diagnosticPending.clear();diagnosticGrant!.release();owner.close(); fail('CLOSED'); readyReject(new StoreError('STORAGE_FAILURE')); resolve();
  }));
  worker.on('error', () => { fail('STORAGE_FAILURE'); readyReject(new StoreError('STORAGE_FAILURE')); });
  worker.on('message', message => {
    if (message.type === 'ready') { readyResolve(message.epoch); return; }
    if (message.type === 'startup-error') { readyReject(new StoreError(message.code,message.detail)); return; }
    if (message.type === 'barrier') { testing?.onBarrier?.(message.phase); return; }
    if (message.type === 'failure') { testing?.onFailure?.(message.failure); return; }
    const item=pending.get(message.id),diagnostic=diagnosticPending.get(message.id);diagnosticPending.delete(message.id);
    if(!item){diagnostic?.settledWithoutValue();return;}pending.delete(message.id);item.release();
    if(message.type==='result'){
      if(message.result instanceof Uint8Array)adapterResources.returnedBuffer('writer-receiver','result-bytes',message.result);
      else if(message.result?.bytes instanceof Uint8Array)adapterResources.returnedBuffer('writer-receiver','result-bytes',message.result.bytes);
      if(item.method==='close')closeAcknowledged=true;
    }
    if(message.type==='error'){diagnostic?.settledWithoutValue();item.reject(new StoreError(message.code,message.detail));}
    else if(diagnostic){try{const result=item.method==='diagnostics'?{...message.result,observer:combineAdapterResources(message.result.observer)}:message.result;item.resolve(diagnostic.receive(result));}catch(error){diagnostic.settledWithoutValue();item.reject(error instanceof Error?error:new StoreError('STORAGE_FAILURE'));}}
    else item.resolve(message.result);
  });
  let epoch: string;
  try { epoch = await ready; owner.check(); } catch (error) { await worker.terminate(); await exited; throw error; } finally {releaseOpening();}
  function request<T>(method: string, args: Record<string, unknown> = {},diagnostic?:DiagnosticIngress<unknown>): Promise<T> {
    const refuse=(error:unknown):Promise<T>=>{diagnostic?.settledWithoutValue();return Promise.reject(error);};
    if (ended || (closing && method !== 'close')) return refuse(new StoreError('CLOSED'));
    if (pending.size >= 64 && method !== 'close' && method !== 'displayRelease' && method !== 'assetRelease' && method !== 'compositionRelease' && method !== 'compositionContentDrop' && method !== 'dropContent') return refuse(new StoreError('QUEUE_FULL'));
    try { if (method !== 'close') owner.check(); } catch (error) { return refuse(safeError(error)); }
    return new Promise<T>((resolve, reject) => {
      const releaseRequest=method==='adapterResourceSnapshot'?()=>{}:adapterResources.handle('writer-sender','pending-request');
      const releaseBytes=args.bytes instanceof Uint8Array?adapterResources.buffer('writer-sender','request-bytes',args.bytes):()=>{};
      const release=()=>{releaseBytes();releaseRequest();};
      const id = ++sequence; pending.set(id, { resolve, reject,release,method });if(diagnostic)diagnosticPending.set(id,diagnostic);
      try { worker.postMessage({ id, method, args: { epoch, ...args } }); }
      catch (error) { pending.delete(id);release();diagnosticPending.delete(id);diagnostic?.settledWithoutValue();reject(safeError(error)); }
    });
  }
  compositionReads=new CompositionReads((method,args)=>{
    const cleanup=method==='compositionRelease'||method==='compositionContentDrop'||method==='dropContent';
    if(cleanup&&(ended||closing))return exited.then(()=>undefined);
    return request(method,args);
  });
  storageReads=new StorageReads((method,args)=>{
    if(method==='compositionRelease'&&(ended||closing))return exited.then(()=>undefined);
    return request(method,args);
  });
  let closePromise: Promise<void> | undefined;
  return {
    root: owner.path, epoch,
    releaseResourceBytes:(bytes:Uint8Array)=>adapterResources.releaseReturned(bytes),
    consumeMetadata:async <T>(ref:BlobRef,consume:(bytes:Uint8Array)=>T|Promise<T>):Promise<T>=>{
      const bytes=await request<Uint8Array>('metadata',{ref}),release=adapterResources.handle('writer-consumer','metadata');
      try{return await consume(bytes);}finally{adapterResources.releaseReturned(bytes);release();}
    },
    openCompositionRead:(current?:()=>void)=>compositionReads!.open(current),
    storageSummary:(auth:AssetAuth)=>storageReads!.read('summary',storageScope=>request<ReturnType<StorageLibrary['summary']>>('storageSummary',{auth,storageScope})),
    storageAssets:(category:StorageCategory,cursor:string|null,auth:AssetAuth)=>storageReads!.read('assets',storageScope=>request<ReturnType<StorageLibrary['assets']>>('storageAssets',{category,cursor,auth,storageScope})),
    storageDependencies:(id:string,cursor:string|null,auth:AssetAuth)=>storageReads!.read('dependencies',storageScope=>request<ReturnType<StorageLibrary['dependencies']>>('storageDependencies',{id,cursor,auth,storageScope})),
    storageClear:(input:()=>Promise<AssetAuth>)=>storageReads!.read('clear',async storageScope=>request<ReturnType<StorageLibrary['clear']>>('storageClear',{auth:await input(),storageScope})),
    storageRepairReview:(id:string,hash:string,auth:AssetAuth)=>storageReads!.read('review',storageScope=>request<Awaited<ReturnType<StorageRepairs['review']>>>('storageRepairReview',{id,hash,auth,storageScope})),
    storageRepair:(id:string,input:()=>Promise<{value:unknown;auth:AssetAuth}>)=>storageReads!.read('repair',async storageScope=>request<Awaited<ReturnType<StorageRepairs['repair']>>>('storageRepair',{id,...await input(),storageScope})),
    providerView:()=>request<ProviderView>('providerView'),
    adapterCommand:(bytes:Uint8Array,auth:AssetAuth)=>request<Awaited<ReturnType<Adapters['command']>>>('adapterCommand',{bytes,auth}),
    adapterList:(...params:Parameters<Adapters['list']>)=>request<ReturnType<Adapters['list']>>('adapterList',{params}),
    adapterView:(id:string)=>request<ReturnType<Adapters['view']>>('adapterView',{id}),
    adapterUpdates:(id:string)=>request<ReturnType<Adapters['updates']>>('adapterUpdates',{id}),
    adapterDeletionReview:(id:string,auth:AssetAuth)=>request<ReturnType<Adapters['deletionReview']>>('adapterDeletionReview',{id,auth}),
    queueCommand:(bytes:Uint8Array,auth:AssetAuth)=>request<Awaited<ReturnType<QueueStore['command']>>>('queueCommand',{bytes,auth}),
    candidateHistory:(documentId:string,after='')=>request<import('../../src/protocol/candidates.js').CandidateHistory>('candidateHistory',{documentId,after}),
    candidateView:(jobId:string,attemptId?:string,after='')=>request<import('../../src/protocol/candidates.js').CandidateView>('candidateView',{jobId,attemptId,after}),
    candidatePrompt:(jobId:string,attemptId:string,kind:'requested'|'submitted'|'returned'|'text-treatment',offset:string)=>request<{bytes:Uint8Array;byteLength:string;offset:string;nextOffset:string|null}>('candidatePrompt',{jobId,attemptId,kind,offset}),
    deletionList:(after:string)=>request<ReturnType<import('./deletion.js').Deletions['list']>>('deletionList',{after}),
    deletionView:(documentId:string,auth:AssetAuth,after='')=>request<ReturnType<import('./deletion.js').Deletions['view']>>('deletionView',{documentId,auth,after}),
    queueView:(after='')=>request<ReturnType<QueueStore['view']>>('queueView',{after}),
    queueReserve:(jobId:string)=>request<ReturnType<QueueStore['reserve']>>('queueReserve',{jobId}),
    queueDispatch:(...params:Parameters<QueueStore['dispatch']>)=>request<ReturnType<QueueStore['dispatch']>>('queueDispatch',{params}),
    queueOutcome:(...params:Parameters<QueueStore['outcome']>)=>request<ReturnType<QueueStore['outcome']>>('queueOutcome',{params}),
    queueRecovery:(...params:Parameters<QueueStore['recovery']>)=>request<ReturnType<QueueStore['recovery']>>('queueRecovery',{params}),
    textAdmission:(id:string,auth:AssetAuth,release=false)=>request<{id:string;bytes:number}>('textAdmission',{id,auth,release}),
    get available() { return !ended && !closing; },
    async submit(bytes: Uint8Array, writerEpoch: string): Promise<Receipt> {
      if (!(bytes instanceof Uint8Array)) throw new StoreError('MALFORMED_REQUEST');
      if (bytes.byteLength > 65536) throw new StoreError('PAYLOAD_TOO_LARGE');
      return request<Receipt>('submit', { bytes, epoch: writerEpoch });
    },
    portableCommand:(bytes:Uint8Array,auth:AssetAuth)=>request<Receipt|null>('portableCommand',{bytes,auth}),
    bundle:(id:string,auth:AssetAuth)=>request<ReturnType<Portables['bundle']>>('bundle',{id,auth}),
    bundleMapping:(id:string,kind:string,after:string,auth:AssetAuth)=>request<ReturnType<Portables['mapping']>>('bundleMapping',{id,kind,after,auth}),
    bundleReview:(id:string,auth:AssetAuth)=>request<ReturnType<Portables['review']>>('bundleReview',{id,auth}),
    bundleVerify:(id:string,auth:AssetAuth)=>request<Awaited<ReturnType<Portables['verifyBundle']>>>('bundleVerify',{id,auth}),
    bundleContent:(handle:string,offset:string,length:number,auth:AssetAuth)=>request<Uint8Array>('bundleContent',{handle,offset,length,auth}),
    bundleRelease:(handle:string)=>request<void>('bundleRelease',{handle}),
    portableInventory:(after:string,auth:AssetAuth)=>request<ReturnType<Portables['inventory']>>('portableInventory',{after,auth}),
    assetCreate: (value:unknown,auth:AssetAuth)=>request<ReturnType<Assets['create']>>('assetCreate',{value,auth}),
    assetGet: (id:string,auth:AssetAuth)=>request<ReturnType<Assets['get']>>('assetGet',{id,auth}),
    assetInventory: (cursor:string|null,auth:AssetAuth)=>request<ReturnType<Assets['inventory']>>('assetInventory',{cursor,auth}),
    assetReview: (id:string,auth:AssetAuth)=>request<ReturnType<Assets['review']>>('assetReview',{id,auth}),
    assetBeginChunk: (id:string,offset:string,length:number,auth:AssetAuth)=>request<string>('assetBeginChunk',{id,offset,length,auth}),
    assetCheckChunk: (token:string,auth:AssetAuth)=>request<void>('assetCheckChunk',{token,auth}),
    assetChunk: (token:string,bytes:Uint8Array,auth:AssetAuth)=>request<ReturnType<Assets['chunk']>>('assetChunk',{token,bytes,auth}),
    assetAbortChunk: (token:string)=>request<void>('assetAbortChunk',{token}),
    assetCommand: (bytes:Uint8Array,auth:AssetAuth)=>request<Receipt|null>('assetCommand',{bytes,auth}),
    imagePreview:(id:string,auth:AssetAuth)=>request<ReturnType<Histories['preview']>>('imagePreview',{id,auth}),
    imageEditReview:(id:string,auth:AssetAuth,acceptCommandId?:string)=>request<ReturnType<Histories['review']>>('imageEditReview',{id,auth,...(acceptCommandId===undefined?{}:{acceptCommandId})}),
    historyCommand:(bytes:Uint8Array,auth:AssetAuth)=>request<Receipt|null>('historyCommand',{bytes,auth}),
    cancelCandidateReview:(id:string,auth:AssetAuth)=>request<Awaited<ReturnType<Histories['cancelCandidateReview']>>>('cancelCandidateReview',{id,auth}),
    cancelExport:(id:string,auth:AssetAuth)=>request<Awaited<ReturnType<Histories['cancelExport']>>>('cancelExport',{id,auth}),
    imageState:(id:string)=>request<ReturnType<Histories['state']>>('imageState',{id}),
    historyClosure:(id:string,after:string)=>request<ReturnType<Histories['closure']>>('historyClosure',{id,after}),
    historyPage:(id:string,after:string,kind:'history'|'checkpoints')=>request<ReturnType<Histories['page']>>('historyPage',{id,after,kind}),
    saveStatus:(id:string,sessionId:string,auth:AssetAuth)=>request<ReturnType<Histories['status']>>('saveStatus',{id,sessionId,auth}),
    requestReviews:(id:string,auth:AssetAuth)=>request<ReturnType<UIStore['requestReviews']>>('requestReviews',{id,auth}),
    uiRead:(id:string,auth:AssetAuth)=>request<ReturnType<UIStore['read']>>('uiRead',{id,auth}),
    uiPersist:(bytes:Uint8Array,auth:AssetAuth)=>request<Awaited<ReturnType<UIStore['persist']>>>('uiPersist',{bytes,auth}),
    rasterCommand: (bytes:Uint8Array,auth:AssetAuth)=>request<Receipt|null>('rasterCommand',{bytes,auth}),
    rasterImportInspection:(id:string,auth:AssetAuth)=>request<ReturnType<Rasters['importInspection']>>('rasterImportInspection',{id,auth}),
    cancelRasterImport:(id:string,auth:AssetAuth)=>request<Awaited<ReturnType<Rasters['cancelImport']>>>('cancelRasterImport',{id,auth}),
    rasterReview: (id:string,auth:AssetAuth)=>request<ReturnType<Rasters['review']>>('rasterReview',{id,auth}),
    readRasterEncodedEvidence:():Promise<DiagnosticRead<Record<string,unknown>[]>>=>{try{return request('rasterEncodedEvidence',{},admitDiagnostic());}catch(error){return Promise.reject(error);}},
    rasterWorkerState:()=>request<ReturnType<Rasters['rasterWorkerState']>>('rasterWorkerState'),
    restartRasterWorker:(expectedGeneration:number)=>request<Awaited<ReturnType<Rasters['restartIdleWorker']>>>('restartRasterWorker',{expectedGeneration}),
    rasterSample: (id:string,x:number,y:number)=>request<Awaited<ReturnType<Rasters['sample']>>>('rasterSample',{id,x,y}),
    rasterManifest: (id:string)=>request<ReturnType<Rasters['manifest']>>('rasterManifest',{id}),
    displayBegin: (id:string,assetId:string,display:DisplayRequest)=>request<DisplayInfo>('displayBegin',{id,assetId,display}),
    displayRead: (id:string,offset:string,length:number)=>request<ReturnType<Displays['read']>>('displayRead',{id,offset,length}),
    displayRelease: (id:string)=>request<void>('displayRelease',{id}),
    assetPending: (id:string)=>request<ReturnType<Assets['pending']>>('assetPending',{id}),
    assetProjection: (id:string)=>request<{asset:ReturnType<Assets['asset']>;highWater:string}>('assetProjection',{id}),
    assetVerify: (id:string)=>request<Awaited<ReturnType<Assets['verify']>>>('assetVerify',{id}),
    assetContent: (id:string,handle:string,offset:string,length:number)=>request<Uint8Array>('assetContent',{id,handle,offset,length}),
    assetRelease: (handle:string)=>request<void>('assetRelease',{handle}),
    uiInventory: (clientId:string,after:string,high:string|null)=>request<ReturnType<StoreDatabase['uiInventory']>>('uiInventory',{clientId,after,high}),
    pendingInventory: (clientId:string,after:string,high:string|null)=>request<ReturnType<StoreDatabase['pendingInventory']>>('pendingInventory',{clientId,after,high}),
    originalCommand: (id:string,clientId:string)=>request<string|null>('originalCommand',{id,clientId}),
    commandState: (id:string)=>request<{record:ReturnType<StoreDatabase['lookup']>;pending:ReturnType<Assets['pending']>}>('commandState',{id}),
    lookup: (id: string) => request<ReturnType<StoreDatabase['lookup']>>('lookup', { id }),
    document: (id: string) => request<Document | null>('document', { id }),
    documentRevision:(id:string)=>request<string|null>('documentRevision',{id}),
    history: (id: string) => request<ReturnType<StoreDatabase['entity']>>('history', { id }),
    checkpoint: (id: string) => request<ReturnType<StoreDatabase['entity']>>('checkpoint', { id }),
    events: (after = '0', limit = 100) => request<{ highWater: string; events: DomainEvent[] }>('events', { after, limit }),
    projection: (id: string) => request<{ document: Document | null; highWater: string }>('projection', { id }),
    documentProjection:(id:string)=>request<ReturnType<RecoveryStore['documentProjection']>>('documentProjection',{id}),
    safeJSON: (kind: 'document' | 'receipt', id: string) => request<StoredContent>('safeJSON', { kind, id }),
    protocolDefaults: () => request<void>('protocolDefaults'),
    recoverClient: (hash: string, now: number) => request<string | null>('recoverClient', { hash, now }),
    rememberClient: (hash: string, clientId: string, expires: number, oldHash?: string) => request<void>('rememberClient', { hash, clientId, expires, oldHash }),
    forgetClient: (hash: string) => request<void>('forgetClient', { hash }),
    capture: () => request<ReturnType<RecoveryStore['capture']>>('capture'),
    boundary: (after: string, highWater: string) => request<ReturnType<RecoveryStore['boundary']>>('boundary', { after, highWater }),
    batch: (after: string, highWater: string) => request<ReturnType<RecoveryStore['batch']>>('batch', { after, highWater }),
    snapshotKnown: (id: string) => request<boolean>('snapshotKnown', { id }),
    snapshotContent: (id: string) => request<StoredContent>('snapshotContent', { id }),
    namespaceContent: (eventId:string, highWater:string) => request<ReturnType<RecoveryStore['namespaceContent']>>('namespaceContent', {eventId,highWater}),
    verifyContent: (handle: string) => request<void>('verifyContent', { handle }),
    content: (handle: string, offset: string, length: number) => request<Uint8Array>('content', { handle, offset, length }),
    dropContent: (handle: string) => request<void>('dropContent', { handle }),
    releasedOwner: (id: string) => request<string | null>('releasedOwner', { id }),
    release: (id: string, clientId: string) => request<void>('release', { id, clientId }),
    health: () => request<ReturnType<StoreDatabase['health']>>('health'),
    readDiagnostics: ():Promise<DiagnosticRead<ReturnType<StoreDatabase['diagnostics']>&{observer:ReturnType<typeof combineAdapterResources>}>> => {try{return request('diagnostics',{},admitDiagnostic());}catch(error){return Promise.reject(error);}},
    adapterResourceSnapshot: async (options:{resetPeaks?:boolean;beginLifecycleWindow?:boolean;endLifecycleWindow?:boolean}={}) => {
      if(options.beginLifecycleWindow&&options.endLifecycleWindow)throw Error('Choose one lifecycle boundary');
      if(options.beginLifecycleWindow)adapterResources.beginLifecycleWindow();if(options.endLifecycleWindow)adapterResources.endLifecycleWindow();
      if(options.resetPeaks)adapterResources.resetPeaks();return combineAdapterResources(await request<WorkerAdapterResourceSnapshot>('adapterResourceSnapshot',{resetPeaks:options.resetPeaks===true}));
    },
    readMetadata: (ref: BlobRef) => request<Uint8Array>('metadata', { ref }),
    openTextContent: (ref: BlobRef) => request<string>('textContentOpen', { ref }),
    async putObject(source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, descriptor: { byteLength: string; mediaType: string; hash?: string }, writerEpoch: string): Promise<BlobRef> {
      const id = await request<string>('begin', { ...descriptor, epoch: writerEpoch });
      try {
        for await (const bytes of source) {
          if (!(bytes instanceof Uint8Array)) throw new StoreError('MALFORMED_REQUEST');
          for (let start = 0; start < bytes.byteLength; start += IO_CHUNK) {
            await request('chunk', { id, bytes: bytes.subarray(start, start + IO_CHUNK), epoch: writerEpoch });
          }
        }
        return await request<BlobRef>('finish', { id, epoch: writerEpoch });
      } catch (error) { await request('abort', { id, epoch: writerEpoch }).catch(() => {}); throw error; }
    },
    close(): Promise<void> {
      if(!closePromise){const previouslyClosing=closing;
        const work=(async()=>{closing=true;diagnosticReads.close();
          try{if(!ended&&!previouslyClosing)await request('close');}
          finally{await worker.terminate();await exited;await storageExited;}
        })();closePromise=work;void work.catch(()=>{if(closePromise===work)closePromise=undefined;});
      }
      return closePromise;
    },
  };
}
export type Writer = Awaited<ReturnType<typeof openWriter>>;
