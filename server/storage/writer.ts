import { Worker } from 'node:worker_threads';
import type { BlobRef, Document, DomainEvent, Receipt } from '../../src/protocol/store.js';
import { acquireRoot } from './ownership.js';
import { StoreError, safeError } from './errors.js';
import type { StoreErrorCode } from './errors.js';
import type { RecoveryStore, StoredContent } from './recovery.js';
import type { StoreDatabase } from './database.js';
import { IO_CHUNK } from './objects.js';
import { PrivateRootError } from '../private-root.js';

export type WriterOptions = { root: string; quotaBytes?: string };
// Internal process/filesystem tests only. Not an HTTP/CLI/environment setting.
export type WriterTestOptions = { phase?: string; gate?: SharedArrayBuffer; onBarrier?: (phase: string) => void;
  onFailure?: (failure: { code?: string; sqliteCode?: number }) => void; maxPageCount?: number; effectCounters?: SharedArrayBuffer };
export async function openWriter(options: WriterOptions, testing?: WriterTestOptions) {
  if (process.versions.node !== '26.10.0') throw new StoreError('UNSUPPORTED_STORAGE');
  if (options.quotaBytes !== undefined && !/^[1-9][0-9]*$/.test(options.quotaBytes)) throw new StoreError('MALFORMED_REQUEST');
  const owner = await acquireRoot(options.root).catch(error => {
    throw error instanceof PrivateRootError ? new StoreError('ROOT_UNSAFE') : safeError(error);
  });
  let worker: Worker;
  try {
    worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: { root: owner.path, identity: owner.identity, quotaBytes: options.quotaBytes,
      testing: testing ? { phase: testing.phase, gate: testing.gate, maxPageCount: testing.maxPageCount, effectCounters: testing.effectCounters } : undefined },
      ...(process.execArgv.some(arg => arg.startsWith('--input-type')) ?
        { execArgv: process.execArgv.filter(arg => !arg.startsWith('--input-type')) } : {}),
      env: {}, resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 } });
  } catch (error) { owner.close(); throw safeError(error); }
  let sequence = 0; let ended = false; let closing = false;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const fail = (code: StoreErrorCode) => { for (const item of pending.values()) item.reject(new StoreError(code)); pending.clear(); };
  let readyResolve: (epoch: string) => void; let readyReject: (error: Error) => void;
  const ready = new Promise<string>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const exited = new Promise<void>(resolve => worker.once('exit', () => {
    ended = true; owner.close(); fail('CLOSED'); readyReject(new StoreError('STORAGE_FAILURE')); resolve();
  }));
  worker.on('error', () => { fail('STORAGE_FAILURE'); readyReject(new StoreError('STORAGE_FAILURE')); });
  worker.on('message', message => {
    if (message.type === 'ready') { readyResolve(message.epoch); return; }
    if (message.type === 'startup-error') { readyReject(new StoreError(message.code)); return; }
    if (message.type === 'barrier') { testing?.onBarrier?.(message.phase); return; }
    if (message.type === 'failure') { testing?.onFailure?.(message.failure); return; }
    const item = pending.get(message.id); if (!item) return;
    pending.delete(message.id);
    if (message.type === 'error') item.reject(new StoreError(message.code)); else item.resolve(message.result);
  });
  let epoch: string;
  try { epoch = await ready; owner.check(); } catch (error) { await worker.terminate(); await exited; throw error; }
  function request<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    if (ended || (closing && method !== 'close')) return Promise.reject(new StoreError('CLOSED'));
    if (pending.size >= 64 && method !== 'close') return Promise.reject(new StoreError('QUEUE_FULL'));
    try { if (method !== 'close') owner.check(); } catch (error) { return Promise.reject(safeError(error)); }
    return new Promise<T>((resolve, reject) => {
      const id = ++sequence; pending.set(id, { resolve, reject });
      try { worker.postMessage({ id, method, args: { epoch, ...args } }); }
      catch (error) { pending.delete(id); reject(safeError(error)); }
    });
  }
  let closePromise: Promise<void> | undefined;
  return {
    root: owner.path, epoch,
    get available() { return !ended && !closing; },
    async submit(bytes: Uint8Array, writerEpoch: string): Promise<Receipt> {
      if (!(bytes instanceof Uint8Array)) throw new StoreError('MALFORMED_REQUEST');
      if (bytes.byteLength > 65536) throw new StoreError('PAYLOAD_TOO_LARGE');
      return request<Receipt>('submit', { bytes, epoch: writerEpoch });
    },
    lookup: (id: string) => request<ReturnType<StoreDatabase['lookup']>>('lookup', { id }),
    document: (id: string) => request<Document | null>('document', { id }),
    history: (id: string) => request<ReturnType<StoreDatabase['entity']>>('history', { id }),
    checkpoint: (id: string) => request<ReturnType<StoreDatabase['entity']>>('checkpoint', { id }),
    events: (after = '0', limit = 100) => request<{ highWater: string; events: DomainEvent[] }>('events', { after, limit }),
    projection: (id: string) => request<{ document: Document | null; highWater: string }>('projection', { id }),
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
    verifyContent: (handle: string) => request<void>('verifyContent', { handle }),
    content: (handle: string, offset: string, length: number) => request<Uint8Array>('content', { handle, offset, length }),
    dropContent: (handle: string) => request<void>('dropContent', { handle }),
    releasedOwner: (id: string) => request<string | null>('releasedOwner', { id }),
    release: (id: string, clientId: string) => request<void>('release', { id, clientId }),
    health: () => request<ReturnType<StoreDatabase['health']>>('health'),
    diagnostics: () => request<ReturnType<StoreDatabase['diagnostics']>>('diagnostics'),
    readMetadata: (ref: BlobRef) => request<Uint8Array>('metadata', { ref }),
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
      closePromise ??= (async () => {
        closing = true;
        try { if (!ended) await request('close'); }
        finally { await worker.terminate(); await exited; }
      })();
      return closePromise;
    },
  };
}
export type Writer = Awaited<ReturnType<typeof openWriter>>;
