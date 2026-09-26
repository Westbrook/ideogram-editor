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
} catch (error) {
  port.postMessage({ type: 'startup-error', code: safeError(error).code }); port.close();
}
port.on('message', message => {
  try {
    let result: unknown;
    const { method, args } = message;
    if (method === 'close') { store.close(); result = null; }
    else {
      store.fence(args.epoch);
      switch (method) {
        case 'submit': result = store.submit(args.bytes, args.epoch); break;
        case 'lookup': result = store.lookup(args.id); break;
        case 'document': result = store.document(args.id); break;
        case 'history': result = store.entity('history', args.id); break;
        case 'checkpoint': result = store.entity('checkpoints', args.id); break;
        case 'events': result = store.events(args.after, args.limit); break;
        case 'diagnostics': result = store.diagnostics(); break;
        case 'begin': result = store.objects.begin(args.byteLength, args.mediaType, args.hash); break;
        case 'chunk': store.objects.chunk(args.id, args.bytes); result = null; break;
        case 'finish': result = store.objects.finish(args.id); break;
        case 'abort': store.objects.abort(args.id); result = null; break;
        case 'metadata': result = store.objects.verify(args.ref, true); break;
        default: throw new StoreError('MALFORMED_REQUEST');
      }
    }
    port.postMessage({ type: 'result', id: message.id, result });
    if (method === 'close') port.close();
  } catch (error) {
    if (workerData.testing && error && typeof error === 'object') {
      const native = error as { code?: unknown; errcode?: unknown };
      port.postMessage({ type: 'failure', failure: {
        code: typeof native.code === 'string' && /^[A-Z_0-9]{1,64}$/.test(native.code) ? native.code : undefined,
        sqliteCode: typeof native.errcode === 'number' ? native.errcode : undefined,
      } });
    }
    port.postMessage({ type: 'error', id: message.id, code: safeError(error).code });
  }
});
