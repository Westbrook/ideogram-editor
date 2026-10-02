import {DiagnosticReads,diagnosticPayloadBytes} from '../../src/observability/diagnostic-memory.js';
import {adoptWorkerDiagnostics,STORAGE_DIAGNOSTIC_BYTES,STORAGE_DIAGNOSTIC_REPLY_BYTES,diagnosticReleases} from '../observability/diagnostic-memory.js';
import {beginCommandAcceptance,commandAcceptances,serverPhases} from '../observability/phases.js';
import { parentPort, workerData } from 'node:worker_threads';
import { StoreDatabase } from './database.js';
import { StoreError, safeError } from './errors.js';
import { assertPrivate } from './files.js';
import { ProviderRuntime } from '../provider/runtime.js';
import { adapterResources } from '../observability/adapter-resources.js';
import { parseControlJSON } from '../control-json.js';

if (!parentPort) throw new Error('Writer requires a dedicated worker');
adoptWorkerDiagnostics(workerData?.diagnosticBytes,STORAGE_DIAGNOSTIC_BYTES);
const diagnosticReads=new DiagnosticReads('diagnostic-storage-reply');
const port = parentPort;
if(workerData.adapterResourceAggregate!==undefined)adapterResources.bindAggregate(workerData.adapterResourceAggregate,workerData.adapterResourceParticipant??null);
const barrier = (phase: string) => {
  const testing = workerData.testing;
  if (testing?.phase === phase) {
    port.postMessage({ type: 'barrier', phase });
    const gate = new Int32Array(testing.gate);
    Atomics.wait(gate, 0, 0);
  }
};
let store: StoreDatabase;
let provider:ProviderRuntime|undefined;
let closeFixture:(()=>Promise<void>)|undefined;
const activeMethods=new Map<string,number>();
// This finite contract covers adapter import/selection and its scalar metadata
// RPCs. Other synchronous producers invalidate interval coverage even if their
// work finishes before the next periodic sample. Their background lifetimes
// additionally carry producer-specific activation leases.
const coveredAdapterMethods=new Set(['adapterCommand','adapterList','adapterView','adapterDeletionReview','assetCreate','assetGet','assetInventory','assetReview',
  'assetBeginChunk','assetCheckChunk','assetChunk','assetAbortChunk','assetCommand','assetPending','assetProjection','assetVerify','assetRelease','assetContent',
  'protocolDefaults','recoverClient','rememberClient','forgetClient','lookup','document','documentRevision','events','originalCommand','uiRead',
  'begin','chunk','finish','abort','metadata']);
function coveredAdapterMethod(method:string,bytes:unknown){
  if(coveredAdapterMethods.has(method))return true;
  if(method!=='uiPersist'||!(bytes instanceof Uint8Array))return false;
  try{const body=parseControlJSON(bytes).body as {type?:unknown}|undefined;return ['SetPreferences','SaveDraft','ClearDraft','FocusRequested'].includes(String(body?.type));}catch{return false;}
}
function adapterResourceSnapshot(){
  const ledger=adapterResources.snapshot(),intact=ledger.droppedTransitions===0&&ledger.unscopedReturnedBuffers===0;
  const assets=store.assets.resourceOwnership(),objects=store.objects.resourceOwnership(),recovery=store.recovery.resourceOwnership(),history=store.histories.resourceOwnership(),portable=store.portables.resourceOwnership(),
    raster=store.rasters.resourceOwnership(),text=store.texts.resourceOwnership(),display=store.displays.resourceOwnership(),candidates=store.candidates.resourceOwnership(),queue=store.queue.resourceOwnership(),
    providerOwner=provider?.resourceOwnership()??{disabled:false,pending:true,timer:false,dispatcher:false,resultObserver:false,transportHandlesObserved:false};
  const witnesses={objects:objects.repairs===0&&objects.repairReads===0,recovery:recovery.readers===0&&recovery.maintenanceReaders===0&&!recovery.maintenance,history:!history.running&&history.encodedReviewProofs.leases===0&&history.encodedReviewProofs.proofs===0&&history.encodedReviewProofs.metadataBytes===0&&history.encodedAcceptances===0,portable:!portable.running&&portable.readers===0,
    raster:!raster.running&&!raster.documentBusy&&raster.activeWorkers===0&&raster.bookedCPUBytes===0&&!raster.workerService.restarting&&raster.workerService.retainedJobReferences===0&&raster.compositionMemory.loans===0&&raster.compositionMemory.loanBytes===0&&raster.compositionMemory.borrowers===0&&raster.compositionMemory.borrowedBytes===0&&raster.compositionMemory.contentReaders===0,
    text:!text.verifying&&text.bookedCPUBytes===0&&text.readyLoans===0&&text.browserAdmissions===0&&!ledger.ownedWorkerThreads.some(worker=>worker.kind.startsWith('text-')),
    display:display.leases===0&&display.building===0,candidates:candidates.transfers===0,queue:queue.preparing===0&&queue.inputStreams===0,
    provider:providerOwner.disabled&&!providerOwner.pending&&providerOwner.transportHandlesObserved};
  const unrelatedQuiet=Object.values(witnesses).every(Boolean),rasterThreads=ledger.ownedWorkerThreads.filter(worker=>worker.kind==='raster');
  const knownThreads=rasterThreads.length===raster.workerService.workerCount&&(!raster.workerService.identity||rasterThreads.some(worker=>worker.threadId===raster.workerService.identity!.threadId));
  return {ledger,writerEpoch:store.epoch,
    coverage:{processTree:intact,workerThreads:intact&&knownThreads&&witnesses.raster&&witnesses.text,stagingBuffers:intact,hashBuffers:intact,headerBuffers:intact,configBuffers:intact,
      ioCopies:intact&&unrelatedQuiet,metadataConsumers:intact&&unrelatedQuiet,assetReadHandles:intact&&witnesses.recovery&&witnesses.portable&&witnesses.display,proofHandles:intact,streamHandles:intact&&witnesses.provider&&witnesses.candidates&&witnesses.queue},
    owners:{assets,objects,recovery,history,portable,raster,text,display,candidates,queue,provider:providerOwner,activeMethods:[...activeMethods].map(([method,count])=>({method,count})),
      quiescence:{kind:'point-in-time-owner-inventory',complete:intact&&unrelatedQuiet,intervalWitness:false,witnesses},
      unknown:Object.entries(witnesses).filter(([,quiet])=>!quiet).map(([owner])=>'active-uncovered-owner:'+owner),
      residencyExcludedFromCPU:['engine-private-V8-objects-and-strings','native-hash-state','native-ipc-queue','idle-native-allocator-residency'],residencyMetric:'process-tree-RSS'}};
}
export type WorkerAdapterResourceSnapshot=ReturnType<typeof adapterResourceSnapshot>;
try {
  await adapterResources.scope('writer-initialize',async()=>{
  const identity = assertPrivate(workerData.root, true);
  if (identity.dev !== workerData.identity.dev || identity.ino !== workerData.identity.ino) throw new StoreError('ROOT_UNSAFE');
  store = new StoreDatabase(workerData.root, barrier, { quotaBytes: workerData.quotaBytes, maxPageCount: workerData.testing?.maxPageCount });
  // The only provider configuration channel is explicit backend worker data.
  // The worker environment stays empty and never selects a provider fixture.
  provider=new ProviderRuntime(store,workerData.provider);
  // Internal test-process injection only; no CLI, environment, HTTP or imported archive can set this.
  if(workerData.testing?.setupModule){const fixture=await import(workerData.testing.setupModule);closeFixture=await fixture.setup(store);}
  port.postMessage({ type: 'ready', epoch: store.epoch });
  store.assets.schedule(true);
  store.rasters.schedule(true);
  store.histories.schedule(true);
  store.portables.schedule();
  });
} catch (error) {
  await provider?.close().catch(()=>{});
  port.postMessage({ type: 'startup-error', code: safeError(error).code, detail:safeError(error).detail }); port.close();
}
port.on('message', async message => {
  // This read deliberately skips diagnostics(), snapshot settlement, DB scans
  // and instrumentation of itself. It does not await ongoing cooperative hashes.
  if(message?.method==='adapterResourceSnapshot'){
    try{store.fence(message.args?.epoch);if(message.args?.resetPeaks===true)adapterResources.resetPeaks();port.postMessage({type:'result',id:message.id,result:adapterResourceSnapshot()});}
    catch(error){port.postMessage({type:'error',id:message.id,code:safeError(error).code,detail:safeError(error).detail});}return;
  }
  const closeResult:{response?:{id:unknown;result:unknown}}={};
  await adapterResources.scope('writer-rpc',async()=>{
  const methodName=typeof message?.method==='string'&&/^[a-zA-Z]{1,40}$/.test(message.method)?message.method:'unknown';
  const releaseUncovered=coveredAdapterMethod(methodName,message?.args?.bytes)?()=>{}:adapterResources.uncovered('writer-other-rpc');
  activeMethods.set(methodName,(activeMethods.get(methodName)??0)+1);
  if(message?.args?.bytes instanceof Uint8Array)adapterResources.retain('writer-rpc','received-bytes',message.args.bytes);
  const acceptance=beginCommandAcceptance(message?.method,message?.args?.bytes);
  const diagnosticOwners:{release():void}[]=[];
  const releaseMetadata=adapterResources.handle('writer-rpc','metadata-consumer');
  try {
    let result: unknown;
    const { method, args } = message;
    if(method!=='close')store.fence(args.epoch);
    // Reads/close may wait for a pending snapshot. Receipts normally do not;
    // only an exhausted tail waits for recovery before applying backpressure.
    if ((method==='submit'||method==='assetCommand'||method==='adapterCommand'||method==='rasterCommand'||method==='historyCommand'||method==='portableCommand'||method==='queueCommand')&&store.recovery.needsSnapshot()) await store.recovery.settle(true);
    else if (['close','capture','diagnostics'].includes(method)) await store.recovery.settle();
    if(method==='textAdmission'){result=args.release?store.texts.releaseAdmission(args.id,args.auth):store.texts.admission(args.id,args.auth);}
    else if (method === 'close') { await provider?.close(); await closeFixture?.(); await store.storageRepairs.close(); store.storageLibrary.close(); store.storageMemory.close(); await store.displays.close(); await store.candidates.close(); await store.queue.close(); await store.portables.close(); await store.histories.close(); await store.rasters.close(); await store.assets.close(); await store.recovery.settle(); store.close(); result = null; }
    else {
      store.fence(args.epoch);
      switch (method) {
        case 'storageSummary':result=store.storageLibrary.summary(args.auth,args.storageScope);break;
        case 'storageAssets':result=store.storageLibrary.assets(args.category,args.cursor,args.auth,args.storageScope);break;
        case 'storageDependencies':result=store.storageLibrary.dependencies(args.id,args.cursor,args.auth,args.storageScope);break;
        case 'storageClear':result=store.storageLibrary.clear(args.auth,args.storageScope);break;
        case 'storageRepairReview':result=await store.storageRepairs.review(args.id,args.hash,args.auth,args.storageScope);break;
        case 'storageRepair':result=await store.storageRepairs.repair(args.id,args.value,args.auth,args.storageScope);break;
        case 'providerView':result=provider!.view();break;
        case 'adapterCommand':result=await store.adapters.command(args.bytes,args.auth);break;
        case 'adapterList':result=store.adapters.list(...args.params as Parameters<typeof store.adapters.list>);break;
        case 'adapterView':result=store.adapters.view(args.id);break;
        case 'adapterUpdates':result=store.adapters.updates(args.id);break;
        case 'adapterDeletionReview':result=store.adapters.deletionReview(args.id,args.auth);break;
        case 'candidateHistory':result=store.candidates.history(args.documentId,args.after);break;
        case 'candidateView':result=store.candidates.view(args.jobId,args.attemptId,args.after);break;
        case 'candidatePrompt':result=store.candidates.prompt(args.jobId,args.attemptId,args.kind,args.offset);break;
        case 'queueCommand':result=await store.queue.command(args.bytes,args.auth);break;
        case 'deletionList':result=store.deletions.list(args.after);break;
        case 'deletionView':result=store.deletions.view(args.documentId,args.auth,args.after);break;
        case 'queueView':result=store.queue.view(args.after);break;
        case 'queueReserve':result=store.queue.reserve(args.jobId);break;
        case 'queueDispatch':result=store.queue.dispatch(...args.params as Parameters<typeof store.queue.dispatch>);break;
        case 'queueOutcome':result=store.queue.outcome(...args.params as Parameters<typeof store.queue.outcome>);break;
        case 'queueRecovery':result=store.queue.recovery(...args.params as Parameters<typeof store.queue.recovery>);break;
        case 'portableCommand':result=store.portables.command(args.bytes,args.auth);break;
        case 'bundle':result=store.portables.bundle(args.id,args.auth);break;
        case 'bundleMapping':result=store.portables.mapping(args.id,args.auth,args.kind,args.after);break;
        case 'bundleReview':result=store.portables.review(args.id,args.auth);break;
        case 'bundleVerify':result=await store.portables.verifyBundle(args.id,args.auth);break;
        case 'bundleContent':result=store.portables.content(args.handle,args.offset,args.length,args.auth);break;
        case 'bundleRelease':store.portables.release(args.handle);result=null;break;
        case 'portableInventory':result=store.portables.inventory(args.auth,args.after);break;
        case 'assetCreate': result=store.assets.create(args.value,args.auth);break;
        case 'assetGet': result=store.assets.get(args.id,args.auth);break;
        case 'assetInventory': result=store.assets.inventory(args.cursor,args.auth);break;
        case 'assetReview': result=store.assets.review(args.id,args.auth);break;
        case 'assetBeginChunk': result=store.assets.beginChunk(args.id,args.offset,args.length,args.auth);break;
        case 'assetCheckChunk': store.assets.checkChunk(args.token,args.auth);result=null;break;
        case 'assetChunk': result=store.assets.chunk(args.token,args.bytes,args.auth);break;
        case 'assetAbortChunk': store.assets.abortChunk(args.token);result=null;break;
        case 'assetCommand': result=store.assets.command(args.bytes,args.auth);break;
        case 'imagePreview':result=store.histories.preview(args.id,args.auth);break;
        case 'imageEditReview':result=store.histories.liveReview(args.id,args.auth);break;
        case 'historyCommand': result=store.histories.command(args.bytes,args.auth);break;
        case 'cancelCandidateReview': result=await store.histories.cancelCandidateReview(args.id,args.auth);break;
        case 'cancelExport': result=await store.histories.cancelExport(args.id,args.auth);break;
        case 'imageState': result=store.histories.state(args.id);break;
        case 'historyClosure': result=store.histories.closure(args.id,args.after);break;
        case 'historyPage': result=store.histories.page(args.id,args.after,args.kind);break;
        case 'saveStatus': result=store.histories.status(args.id,args.auth,args.sessionId);(result as any).pendingCommandCount+=store.portables.pendingCount(args.id,args.auth.clientId);const bundle=store.portables.latest(args.id);(result as any).bundleOutdated=!bundle||bundle.documentRevision!==store.document(args.id)?.revision||bundle.uiDigest!==store.portables.currentUIDigest(args.id);(result as any).copyStatus=bundle?'copy-ready':'none';(result as any).destinationStatus='unconfirmed';break;
        case 'requestReviews': result=store.ui.requestReviews(args.id,args.auth);break;
        case 'uiRead': result=store.ui.read(args.id,args.auth);break;
        case 'uiPersist': result=await store.ui.persist(args.bytes,args.auth);break;
        case 'rasterCommand': result=store.rasters.command(args.bytes,args.auth);break;
        case 'rasterImportInspection': result=store.rasters.importInspection(args.id,args.auth);break;
        case 'cancelRasterImport': result=await store.rasters.cancelImport(args.id,args.auth);break;
        case 'rasterReview': result=store.rasters.review(args.id,args.auth);break;
        case 'rasterEncodedEvidence': {const read=store.rasters.readDiagnostics();diagnosticOwners.push(read);result=read.value.observations.filter(item=>item.phase==='encoded-input-rebuild');break;}
        case 'rasterWorkerState': result=store.rasters.rasterWorkerState();break;
        case 'restartRasterWorker': result=await store.rasters.restartIdleWorker(args.expectedGeneration);break;
        case 'rasterSample': result=await store.rasters.sample(args.id,args.x,args.y);break;
        case 'rasterManifest': result=store.rasters.manifest(args.id);break;
        case 'displayBegin': result=await store.displays.begin(args.id,args.assetId,args.display);break;
        case 'displayRead': result=store.displays.read(args.id,args.offset,args.length);break;
        case 'displayRelease': result=await store.displays.release(args.id);break;
        case 'assetPending': result=store.assets.pending(args.id);break;
        case 'assetProjection': result={asset:store.assets.asset(args.id),highWater:store.recovery.highWater()};break;
        case 'assetVerify': result=await store.assets.verify(args.id);break;
        case 'assetRelease': store.assets.releaseContent(args.handle);result=null;break;
        case 'assetContent': result=store.assets.content(args.id,args.handle,args.offset,args.length);break;
        case 'protocolDefaults': store.protocolDefaults(); result = null; break;
        case 'recoverClient': result = store.recoverClient(args.hash,args.now); break;
        case 'rememberClient': store.rememberClient(args.hash,args.clientId,args.expires,args.oldHash); result = null; break;
        case 'forgetClient': store.forgetClient(args.hash); result = null; break;
        case 'submit': result = store.submit(args.bytes, args.epoch); break;
        case 'uiInventory': result=store.uiInventory(args.clientId,args.after,args.high);break;
        case 'pendingInventory': result=store.pendingInventory(args.clientId,args.after,args.high);break;
        case 'originalCommand': result=store.originalCommand(args.id,args.clientId);break;
        case 'commandState': result={record:store.lookup(args.id),pending:store.assets.pending(args.id)??store.rasters.pending(args.id)??store.histories.pending(args.id)??store.portables.pending(args.id)};break;
        case 'lookup': result = store.lookup(args.id); break;
        case 'document': result = store.document(args.id); break;
        case 'documentRevision': result=store.documentRevision(args.id);break;
        case 'history': result = store.entity('history', args.id); break;
        case 'checkpoint': result = store.entity('checkpoints', args.id); break;
        case 'events': result = store.events(args.after, args.limit); break;
        case 'projection': result = { document: store.document(args.id), highWater: store.recovery.highWater() }; break;
        case 'documentProjection': result=store.recovery.documentProjection(args.id);break;
        case 'safeJSON': result = store.recovery.safeJSON(args.kind,args.id); break;
        case 'capture': result = store.recovery.capture(); break;
        case 'boundary': result = store.recovery.boundary(args.after, args.highWater); break;
        case 'batch': result = store.recovery.batch(args.after, args.highWater); break;
        case 'snapshotKnown': result = store.recovery.snapshotKnown(args.id); break;
        case 'namespaceContent': result=store.recovery.namespaceContent(args.eventId,args.highWater);break;
        case 'snapshotContent': {
          const snapshot = store.recovery.getSnapshot(args.id);
          if (!snapshot) throw new StoreError('MISSING_OBJECT');
          result = store.recovery.issue(snapshot.content); break;
        }
        case 'verifyContent': store.recovery.verifyContent(args.handle); result = null; break;
        case 'content': result = store.recovery.content(args.handle, args.offset, args.length); break;
        case 'dropContent': store.recovery.drop(args.handle); result = null; break;
        case 'releasedOwner': result = store.recovery.releasedOwner(args.id); break;
        case 'release': store.recovery.release(args.id, args.clientId, args.epoch); result = null; break;
        case 'health': result = store.health(); break;
        case 'diagnostics': {
          const output=diagnosticReads.read(STORAGE_DIAGNOSTIC_REPLY_BYTES,()=>{
            const phases=serverPhases.readSnapshot();diagnosticOwners.push(phases);
            const rasters=store.rasters.readDiagnostics();diagnosticOwners.push(rasters);
            const text=store.texts.readObservations();diagnosticOwners.push(text);
            const history=store.histories.readObservations();diagnosticOwners.push(history);
            const portable=store.portables.readObservations();diagnosticOwners.push(portable);
            const value={...store.diagnostics(phases.value,rasters.value,text.value,history.value,portable.value),observer:adapterResourceSnapshot()};
            if(diagnosticPayloadBytes(value)>STORAGE_DIAGNOSTIC_REPLY_BYTES)throw new StoreError('CAPACITY');return value;
          });diagnosticOwners.push(output);result=output.value;break;
        }
        case 'begin': result = store.objects.begin(args.byteLength, args.mediaType, args.hash); break;
        case 'chunk': store.objects.chunk(args.id, args.bytes); result = null; break;
        case 'finish': result = store.objects.finish(args.id); break;
        case 'abort': store.objects.abort(args.id); result = null; break;
        case 'compositionResize': store.rasters.compositionMemory.resize(args.id,args.bytes,args.family);result=null;break;
        case 'compositionRelease': store.rasters.compositionMemory.drop(args.id,handle=>store.recovery.drop(handle));result=null;break;
        case 'compositionContentDrop': store.rasters.compositionMemory.dropContent(args.id,args.handle,handle=>store.recovery.drop(handle));result=null;break;
        case 'compositionContentOpen': result=store.rasters.compositionMemory.openContent(args.id,()=>store.recovery.openContent(args.ref));break;
        case 'metadata': result = store.objects.verify(args.ref, true); break;
        case 'textContentOpen': result = store.recovery.openContent(args.ref); break;
        default: throw new StoreError('MALFORMED_REQUEST');
      }
    }
    commandAcceptances.complete(acceptance,result);
    if(method==='close')closeResult.response={id:message.id,result};
    else port.postMessage({ type: 'result', id: message.id, result });
  } catch (error) {
    commandAcceptances.fail(acceptance);
    if (workerData.testing && error && typeof error === 'object') {
      const native = error as { code?: unknown; errcode?: unknown };
      port.postMessage({ type: 'failure', failure: {
        code: typeof native.code === 'string' && /^[A-Z_0-9]{1,64}$/.test(native.code) ? native.code : undefined,
        sqliteCode: typeof native.errcode === 'number' ? native.errcode : undefined,
      } });
    }
    port.postMessage({ type: 'error', id: message.id, code: safeError(error).code, detail:safeError(error).detail });
  }finally{try{diagnosticReleases(diagnosticOwners)();}finally{releaseMetadata();releaseUncovered();const count=activeMethods.get(methodName)!-1;if(count===0)activeMethods.delete(methodName);else activeMethods.set(methodName,count);}}
  });
  // The parent may terminate immediately after this acknowledgment. Publish it
  // only once all RPC scope leases have actually been released.
  if(closeResult.response){port.postMessage({type:'result',...closeResult.response});port.close();}
});
