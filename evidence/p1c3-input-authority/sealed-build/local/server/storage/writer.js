import { Worker } from 'node:worker_threads';
import { acquireRoot } from './ownership.js';
import { StoreError, safeError } from './errors.js';
import { IO_CHUNK } from './objects.js';
import { PrivateRootError } from '../private-root.js';
export async function openWriter(options, testing) {
    if (process.versions.node !== '26.10.0')
        throw new StoreError('UNSUPPORTED_STORAGE');
    if (options.quotaBytes !== undefined && !/^[1-9][0-9]*$/.test(options.quotaBytes))
        throw new StoreError('MALFORMED_REQUEST');
    const owner = await acquireRoot(options.root).catch(error => {
        throw error instanceof PrivateRootError ? new StoreError('ROOT_UNSAFE') : safeError(error);
    });
    let worker;
    try {
        worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: { root: owner.path, identity: owner.identity, quotaBytes: options.quotaBytes,
                testing: testing ? { phase: testing.phase, gate: testing.gate, maxPageCount: testing.maxPageCount, effectCounters: testing.effectCounters } : undefined },
            ...(process.execArgv.some(arg => arg.startsWith('--input-type')) ?
                { execArgv: process.execArgv.filter(arg => !arg.startsWith('--input-type')) } : {}),
            env: {}, resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 } });
    }
    catch (error) {
        owner.close();
        throw safeError(error);
    }
    let sequence = 0;
    let ended = false;
    let closing = false;
    const pending = new Map();
    const fail = (code) => { for (const item of pending.values())
        item.reject(new StoreError(code)); pending.clear(); };
    let readyResolve;
    let readyReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const exited = new Promise(resolve => worker.once('exit', () => {
        ended = true;
        owner.close();
        fail('CLOSED');
        readyReject(new StoreError('STORAGE_FAILURE'));
        resolve();
    }));
    worker.on('error', () => { fail('STORAGE_FAILURE'); readyReject(new StoreError('STORAGE_FAILURE')); });
    worker.on('message', message => {
        if (message.type === 'ready') {
            readyResolve(message.epoch);
            return;
        }
        if (message.type === 'startup-error') {
            readyReject(new StoreError(message.code, message.detail));
            return;
        }
        if (message.type === 'barrier') {
            testing?.onBarrier?.(message.phase);
            return;
        }
        if (message.type === 'failure') {
            testing?.onFailure?.(message.failure);
            return;
        }
        const item = pending.get(message.id);
        if (!item)
            return;
        pending.delete(message.id);
        if (message.type === 'error')
            item.reject(new StoreError(message.code, message.detail));
        else
            item.resolve(message.result);
    });
    let epoch;
    try {
        epoch = await ready;
        owner.check();
    }
    catch (error) {
        await worker.terminate();
        await exited;
        throw error;
    }
    function request(method, args = {}) {
        if (ended || (closing && method !== 'close'))
            return Promise.reject(new StoreError('CLOSED'));
        if (pending.size >= 64 && method !== 'close')
            return Promise.reject(new StoreError('QUEUE_FULL'));
        try {
            if (method !== 'close')
                owner.check();
        }
        catch (error) {
            return Promise.reject(safeError(error));
        }
        return new Promise((resolve, reject) => {
            const id = ++sequence;
            pending.set(id, { resolve, reject });
            try {
                worker.postMessage({ id, method, args: { epoch, ...args } });
            }
            catch (error) {
                pending.delete(id);
                reject(safeError(error));
            }
        });
    }
    let closePromise;
    return {
        root: owner.path, epoch,
        textAdmission: (id, auth, release = false) => request('textAdmission', { id, auth, release }),
        get available() { return !ended && !closing; },
        async submit(bytes, writerEpoch) {
            if (!(bytes instanceof Uint8Array))
                throw new StoreError('MALFORMED_REQUEST');
            if (bytes.byteLength > 65536)
                throw new StoreError('PAYLOAD_TOO_LARGE');
            return request('submit', { bytes, epoch: writerEpoch });
        },
        portableCommand: (bytes, auth) => request('portableCommand', { bytes, auth }),
        bundle: (id, auth) => request('bundle', { id, auth }),
        bundleMapping: (id, kind, after, auth) => request('bundleMapping', { id, kind, after, auth }),
        bundleReview: (id, auth) => request('bundleReview', { id, auth }),
        bundleVerify: (id, auth) => request('bundleVerify', { id, auth }),
        bundleContent: (handle, offset, length, auth) => request('bundleContent', { handle, offset, length, auth }),
        bundleRelease: (handle) => request('bundleRelease', { handle }),
        portableInventory: (after, auth) => request('portableInventory', { after, auth }),
        assetCreate: (value, auth) => request('assetCreate', { value, auth }),
        assetGet: (id, auth) => request('assetGet', { id, auth }),
        assetInventory: (cursor, auth) => request('assetInventory', { cursor, auth }),
        assetReview: (id, auth) => request('assetReview', { id, auth }),
        assetBeginChunk: (id, offset, length, auth) => request('assetBeginChunk', { id, offset, length, auth }),
        assetCheckChunk: (token, auth) => request('assetCheckChunk', { token, auth }),
        assetChunk: (token, bytes, auth) => request('assetChunk', { token, bytes, auth }),
        assetAbortChunk: (token) => request('assetAbortChunk', { token }),
        assetCommand: (bytes, auth) => request('assetCommand', { bytes, auth }),
        imagePreview: (id, auth) => request('imagePreview', { id, auth }),
        imageEditReview: (id, auth) => request('imageEditReview', { id, auth }),
        historyCommand: (bytes, auth) => request('historyCommand', { bytes, auth }),
        imageState: (id) => request('imageState', { id }),
        historyClosure: (id, after) => request('historyClosure', { id, after }),
        historyPage: (id, after, kind) => request('historyPage', { id, after, kind }),
        saveStatus: (id, sessionId, auth) => request('saveStatus', { id, sessionId, auth }),
        uiRead: (id, auth) => request('uiRead', { id, auth }),
        uiPersist: (bytes, auth) => request('uiPersist', { bytes, auth }),
        rasterCommand: (bytes, auth) => request('rasterCommand', { bytes, auth }),
        rasterReview: (id, auth) => request('rasterReview', { id, auth }),
        rasterSample: (id, x, y) => request('rasterSample', { id, x, y }),
        rasterManifest: (id) => request('rasterManifest', { id }),
        assetPending: (id) => request('assetPending', { id }),
        assetProjection: (id) => request('assetProjection', { id }),
        assetVerify: (id) => request('assetVerify', { id }),
        assetContent: (id, handle, offset, length) => request('assetContent', { id, handle, offset, length }),
        assetRelease: (handle) => request('assetRelease', { handle }),
        uiInventory: (clientId, after, high) => request('uiInventory', { clientId, after, high }),
        pendingInventory: (clientId, after, high) => request('pendingInventory', { clientId, after, high }),
        originalCommand: (id, clientId) => request('originalCommand', { id, clientId }),
        commandState: (id) => request('commandState', { id }),
        lookup: (id) => request('lookup', { id }),
        document: (id) => request('document', { id }),
        documentRevision: (id) => request('documentRevision', { id }),
        history: (id) => request('history', { id }),
        checkpoint: (id) => request('checkpoint', { id }),
        events: (after = '0', limit = 100) => request('events', { after, limit }),
        projection: (id) => request('projection', { id }),
        documentProjection: (id) => request('documentProjection', { id }),
        safeJSON: (kind, id) => request('safeJSON', { kind, id }),
        protocolDefaults: () => request('protocolDefaults'),
        recoverClient: (hash, now) => request('recoverClient', { hash, now }),
        rememberClient: (hash, clientId, expires, oldHash) => request('rememberClient', { hash, clientId, expires, oldHash }),
        forgetClient: (hash) => request('forgetClient', { hash }),
        capture: () => request('capture'),
        boundary: (after, highWater) => request('boundary', { after, highWater }),
        batch: (after, highWater) => request('batch', { after, highWater }),
        snapshotKnown: (id) => request('snapshotKnown', { id }),
        snapshotContent: (id) => request('snapshotContent', { id }),
        namespaceContent: (eventId, highWater) => request('namespaceContent', { eventId, highWater }),
        verifyContent: (handle) => request('verifyContent', { handle }),
        content: (handle, offset, length) => request('content', { handle, offset, length }),
        dropContent: (handle) => request('dropContent', { handle }),
        releasedOwner: (id) => request('releasedOwner', { id }),
        release: (id, clientId) => request('release', { id, clientId }),
        health: () => request('health'),
        diagnostics: () => request('diagnostics'),
        readMetadata: (ref) => request('metadata', { ref }),
        async putObject(source, descriptor, writerEpoch) {
            const id = await request('begin', { ...descriptor, epoch: writerEpoch });
            try {
                for await (const bytes of source) {
                    if (!(bytes instanceof Uint8Array))
                        throw new StoreError('MALFORMED_REQUEST');
                    for (let start = 0; start < bytes.byteLength; start += IO_CHUNK) {
                        await request('chunk', { id, bytes: bytes.subarray(start, start + IO_CHUNK), epoch: writerEpoch });
                    }
                }
                return await request('finish', { id, epoch: writerEpoch });
            }
            catch (error) {
                await request('abort', { id, epoch: writerEpoch }).catch(() => { });
                throw error;
            }
        },
        close() {
            closePromise ??= (async () => {
                closing = true;
                try {
                    if (!ended)
                        await request('close');
                }
                finally {
                    await worker.terminate();
                    await exited;
                }
            })();
            return closePromise;
        },
    };
}
