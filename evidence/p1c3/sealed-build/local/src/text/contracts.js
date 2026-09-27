// Prepared values are candidates only. The durable writer must validate and stage
// every dependency before accepting a text version; this module has no authority.
export const LIMITS = Object.freeze({ textBytes: 16384, lines: 256, faces: 16,
    faceBytes: 16 * 1024 ** 2, fontBytes: 64 * 1024 ** 2, wasmBytes: 32 * 1024 ** 2,
    pixels: 25000000, side: 8192, layoutBytes: 8 * 1024 ** 2, deadlineMs: 20000 });
export class TextFailure extends Error {
    code;
    details;
    constructor(code, details = null) {
        super(code);
        this.code = code;
        this.details = details;
        this.name = 'TextFailure';
    }
}
export function fail(code, details) { throw new TextFailure(code, details); }
export async function hashBytes(bytes) {
    const data = bytes instanceof Blob ? await bytes.arrayBuffer() : bytes;
    return 'sha256:' + Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), b => b.toString(16).padStart(2, '0')).join('');
}
export async function readSealedAsset(url, expected, signal) {
    if (url.origin !== location.origin)
        fail('TEXT_ASSET_ORIGIN');
    const response = await fetch(url, { credentials: 'same-origin', redirect: 'error', signal });
    const length = response.headers.get('content-length');
    if (!response.ok || length !== null && Number(length) !== expected || !response.body) {
        await response.body?.cancel();
        fail('TEXT_ASSET_LOAD');
    }
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            size += value.byteLength;
            if (size > expected)
                fail('TEXT_ASSET_SIZE');
            chunks.push(new Uint8Array(value));
        }
        if (size !== expected)
            fail('TEXT_ASSET_SIZE');
        return new Blob(chunks);
    }
    finally {
        await reader.cancel();
        reader.releaseLock();
    }
}
export function frozen(value) {
    if (value && typeof value === 'object' && !(value instanceof Blob)) {
        Object.values(value).forEach(frozen);
        Object.freeze(value);
    }
    return value;
}
