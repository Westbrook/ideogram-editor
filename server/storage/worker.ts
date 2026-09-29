import { parentPort, workerData } from 'node:worker_threads';
import { StoreDatabase } from './database.js';
import { StoreError, safeError } from './errors.js';
import { assertPrivate } from './files.js';

if (!parentPort) throw new Error('Writer requires a dedicated worker');
const port = parentPort;
const barrier = (phase: string) => {
  const testing = workerData.testing;
  if (testing?.phase === phase) {
    port.postMessage({ type: 'barrier', phase });
    const gate = new Int32Array(testing.gate);
    Atomics.wait(gate, 0, 0);
  }
};
let store: StoreDatabase;
try {
  const identity = assertPrivate(workerData.root, true);
  if (identity.dev !== workerData.identity.dev || identity.ino !== workerData.identity.ino) throw new StoreError('ROOT_UNSAFE');
  store = new StoreDatabase(workerData.root, barrier, { quotaBytes: workerData.quotaBytes, maxPageCount: workerData.testing?.maxPageCount });
  port.postMessage({ type: 'ready', epoch: store.epoch });
  store.assets.schedule(true);
  store.rasters.schedule(true);
  store.histories.schedule(true);
  store.portables.schedule();
} catch (error) {
  port.postMessage({ type: 'startup-error', code: safeError(error).code, detail:safeError(error).detail }); port.close();
}
port.on('message', async message => {
  try {
    let result: unknown;
    const { method, args } = message;
    if(method!=='close')store.fence(args.epoch);
    // Reads/close may wait for a pending snapshot. Receipts normally do not;
    // only an exhausted tail waits for recovery before applying backpressure.
    if ((method==='submit'||method==='assetCommand'||method==='rasterCommand'||method==='historyCommand'||method==='portableCommand'||method==='queueCommand')&&store.recovery.needsSnapshot()) await store.recovery.settle(true);
    else if (['close','capture','diagnostics'].includes(method)) await store.recovery.settle();
    if(method==='textAdmission'){result=args.release?store.texts.releaseAdmission(args.id,args.auth):store.texts.admission(args.id,args.auth);}
    else if (method === 'close') { await store.queue.close(); await store.portables.close(); await store.histories.close(); await store.rasters.close(); await store.assets.close(); await store.recovery.settle(); store.close(); result = null; }
    else {
      store.fence(args.epoch);
      switch (method) {
        case 'queueCommand':result=await store.queue.command(args.bytes,args.auth);break;
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
        case 'imageEditReview':result=store.histories.review(args.id,args.auth);break;
        case 'historyCommand': result=store.histories.command(args.bytes,args.auth);break;
        case 'imageState': result=store.histories.state(args.id);break;
        case 'historyClosure': result=store.histories.closure(args.id,args.after);break;
        case 'historyPage': result=store.histories.page(args.id,args.after,args.kind);break;
        case 'saveStatus': result=store.histories.status(args.id,args.auth,args.sessionId);(result as any).pendingCommandCount+=store.portables.pendingCount(args.id,args.auth.clientId);const bundle=store.portables.latest(args.id);(result as any).bundleOutdated=!bundle||bundle.documentRevision!==store.document(args.id)?.revision||bundle.uiDigest!==store.portables.currentUIDigest(args.id);(result as any).copyStatus=bundle?'copy-ready':'none';(result as any).destinationStatus='unconfirmed';break;
        case 'requestReviews': result=store.ui.requestReviews(args.id,args.auth);break;
        case 'uiRead': result=store.ui.read(args.id,args.auth);break;
        case 'uiPersist': result=await store.ui.persist(args.bytes,args.auth);break;
        case 'rasterCommand': result=store.rasters.command(args.bytes,args.auth);break;
        case 'rasterReview': result=store.rasters.review(args.id,args.auth);break;
        case 'rasterSample': result=await store.rasters.sample(args.id,args.x,args.y);break;
        case 'rasterManifest': result=store.rasters.manifest(args.id);break;
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
        case 'diagnostics': result = store.diagnostics(); break;
        case 'begin': result = store.objects.begin(args.byteLength, args.mediaType, args.hash); break;
        case 'chunk': store.objects.chunk(args.id, args.bytes); result = null; break;
        case 'finish': result = store.objects.finish(args.id); break;
        case 'abort': store.objects.abort(args.id); result = null; break;
        case 'metadata': result = store.objects.verify(args.ref, true); break;
        case 'textContentOpen': result = store.recovery.openContent(args.ref); break;
        default: throw new StoreError('MALFORMED_REQUEST');
      }
    }
    port.postMessage({ type: 'result', id: message.id, result });
    if(method==='textAdmission'){result=args.release?store.texts.releaseAdmission(args.id,args.auth):store.texts.admission(args.id,args.auth);}
    else if (method === 'close') port.close();
  } catch (error) {
    if (workerData.testing && error && typeof error === 'object') {
      const native = error as { code?: unknown; errcode?: unknown };
      port.postMessage({ type: 'failure', failure: {
        code: typeof native.code === 'string' && /^[A-Z_0-9]{1,64}$/.test(native.code) ? native.code : undefined,
        sqliteCode: typeof native.errcode === 'number' ? native.errcode : undefined,
      } });
    }
    port.postMessage({ type: 'error', id: message.id, code: safeError(error).code, detail:safeError(error).detail });
  }
});
