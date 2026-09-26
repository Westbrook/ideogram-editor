// Prepared values are candidates only. The durable writer must validate and stage
// every dependency before accepting a text version; this module has no authority.
export const LIMITS = Object.freeze({ textBytes: 16384, lines: 256, faces: 16,
  faceBytes: 16 * 1024 ** 2, fontBytes: 64 * 1024 ** 2, wasmBytes: 32 * 1024 ** 2,
  pixels: 25000000, side: 8192, layoutBytes: 8 * 1024 ** 2, deadlineMs: 20000 });

export type FontInput = Readonly<{ hash: string; bytes: Blob; faceIndex: 0;
  origin: 'bundled' | 'local-file'; license: Readonly<{ hash: string; embedding: 'permitted' }> }>;
export type TextStyle = Readonly<{ primaryFont: string; explicitFallbacks: readonly string[];
  sizePx: number; lineHeightMultiplier: number; fill: readonly [number, number, number, number];
  align: 'left' | 'center' | 'right' | 'start' | 'end'; direction: 'auto' | 'ltr' | 'rtl' }>;
export type TextToken = Readonly<{ documentId: string; documentRevision: string;
  layerId: string; layerVersion: string; sessionId: string; generation: number }>;
export type TextRequest = Readonly<{ token: TextToken; text: string; style: TextStyle;
  frame: Readonly<{ width: number; height: number }>; fonts: readonly FontInput[] }>;
export type PreparedText = Readonly<{ kind: 'prepared-text-1'; token: TextToken;
  rendererProfile: string; dependencyHash: string;
  dependencies: readonly Readonly<{ hash: string; licenseHash: string; faceIndex: 0;
    format: 'static-ttf' | 'static-otf'; parserProfile: string; fsType: number; bytes: Blob }>[];
  textUtf8: Blob; textHash: string; layout: Blob; layoutHash: string;
  rgba: Blob; rasterHash: string; width: number; height: number; overflow: boolean;
  allocation: Readonly<{ wasmHeapBytes: number; uniqueFontBytes: number; rasterBytes: number;
    layoutBytes: number; gpuBytes: 0 }> }>;
export class TextFailure extends Error {
  constructor(readonly code: string, readonly details: unknown = null) { super(code); this.name = 'TextFailure'; }
}
export function fail(code: string, details?: unknown): never { throw new TextFailure(code, details); }
export async function hashBytes(bytes: BufferSource | Blob): Promise<string> {
  const data = bytes instanceof Blob ? await bytes.arrayBuffer() : bytes;
  return 'sha256:' + Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), b => b.toString(16).padStart(2, '0')).join('');
}
export async function readSealedAsset(url: URL, expected: number, signal?: AbortSignal): Promise<Blob> {
  if (url.origin !== location.origin) fail('TEXT_ASSET_ORIGIN');
  const response = await fetch(url, { credentials: 'same-origin', redirect: 'error', signal });
  const length = response.headers.get('content-length');
  if (!response.ok || length !== null && Number(length) !== expected || !response.body) {
    await response.body?.cancel(); fail('TEXT_ASSET_LOAD');
  }
  const reader = response.body!.getReader(), chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    for (;;) {
      const {done,value} = await reader.read(); if (done) break;
      size += value.byteLength; if (size > expected) fail('TEXT_ASSET_SIZE');
      chunks.push(new Uint8Array(value));
    }
    if (size !== expected) fail('TEXT_ASSET_SIZE');
    return new Blob(chunks);
  } finally { await reader.cancel(); reader.releaseLock(); }
}
export function frozen<T>(value: T): T {
  if (value && typeof value === 'object' && !(value instanceof Blob)) {
    Object.values(value).forEach(frozen); Object.freeze(value);
  }
  return value;
}
