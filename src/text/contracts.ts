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
export type TextAssetCleanupLease = Readonly<{bytes:number;release():void}>;
type AssetReader = ReadableStreamDefaultReader<Uint8Array>;
type CleanupRecord = {response:Response;reader:AssetReader|null;unlockPending:boolean;cancelFailed:boolean;leases:Set<TextAssetCleanupLease>};
const assetCleanupRecords = new WeakMap<object,CleanupRecord>();
function cleanupFailed(error:unknown,record:CleanupRecord):never {
  const failure=new TextFailure('TEXT_ASSET_CLEANUP',error);assetCleanupRecords.set(failure,record);throw failure;
}
// Transfer an existing caller reservation; the cleanup record then owns it.
// Unknown errors confer no cleanup authority and leave the caller responsible.
export function retainTextAssetCleanup(error:unknown,lease:TextAssetCleanupLease):boolean {
  if(!error||typeof error!=='object')return false;
  const record=assetCleanupRecords.get(error);if(!record)return false;
  record.leases.add(lease);return true;
}
// A failed cancellation retains the actual response and reader even if unlock
// succeeded. Retrying a closed stream's cancel would be a no-op, not evidence
// that its source released resources. Only a failed unlock can be retried.
export async function retryTextAssetCleanup(error:unknown):Promise<boolean> {
  if(!error||typeof error!=='object')return false;
  const record=assetCleanupRecords.get(error);if(!record)return false;
  if(record.unlockPending){if(!record.reader)return false;record.reader.releaseLock();record.unlockPending=false;}
  if(record.cancelFailed)return false;
  for(const lease of record.leases){lease.release();record.leases.delete(lease);}
  assetCleanupRecords.delete(error);return true;
}
class TextAssetReaderCompletion {
  private closedState:'pending'|'closed'|'errored'='pending';private closedReason:unknown;
  constructor(private readonly reader:AssetReader){
    // Capture the original promise before cancel/releaseLock can change it.
    const closed=reader.closed;if(closed)void closed.then(()=>{this.closedState='closed';},reason=>{this.closedState='errored';this.closedReason=reason;});
  }
  read(){return this.reader.read();}
  async cancel(){
    try{await this.reader.cancel();}catch(reason){
      await Promise.resolve();if(this.closedState!=='errored'||!Object.is(this.closedReason,reason))throw reason;
    }
  }
}
function acquireAssetReader(response:Response){
  let reader:AssetReader|null=null;
  try{reader=response.body!.getReader();return {reader,completion:new TextAssetReaderCompletion(reader)};}
  catch(error){cleanupFailed(error,{response,reader,unlockPending:reader!==null,cancelFailed:true,leases:new Set()});}
}
async function finishAssetReader(response:Response,reader:AssetReader,cancel?:()=>Promise<void>){
  let cancelFailed=false,cancelError:unknown,unlockFailed=false,unlockError:unknown;
  try{if(cancel)await cancel();}catch(error){cancelFailed=true;cancelError=error;}
  try{reader.releaseLock();}catch(error){unlockFailed=true;unlockError=error;}
  if(cancelFailed||unlockFailed)cleanupFailed(cancelFailed&&unlockFailed?new AggregateError([cancelError,unlockError],'Text reader cleanup failed'):cancelFailed?cancelError:unlockError,
    {response,reader,unlockPending:unlockFailed,cancelFailed,leases:new Set()});
}
export async function cancelTextAssetResponse(response:Response):Promise<void> {
  if(!response.body)return;
  const {reader,completion}=acquireAssetReader(response);
  await finishAssetReader(response,reader,()=>completion.cancel());
}
export async function readSealedAsset(url: URL, expected: number, signal?: AbortSignal): Promise<Blob> {
  if (url.origin !== location.origin) fail('TEXT_ASSET_ORIGIN');
  if (!Number.isSafeInteger(expected) || expected < 0 || expected > LIMITS.wasmBytes) fail('TEXT_ASSET_SIZE');
  const response = await fetch(url, { credentials: 'same-origin', redirect: 'error', signal });
  return readTextAssetResponse(response, expected, signal);
}
// The caller reserves its loader workspace before fetch. Fragmentation cannot
// create one retained object per incoming byte: only bounded 64 KiB Blob parts
// and one assembly slab survive a read iteration.
export async function readTextAssetResponse(response: Response, expected: number, signal?: AbortSignal): Promise<Blob> {
  if(!response.body)fail(signal?.aborted?'TEXT_CANCELLED':'TEXT_ASSET_LOAD');
  const {reader,completion}=acquireAssetReader(response),parts:Blob[]=[];
  let slab=new Uint8Array(0),used=0,size=0,ended=false,complete=false;
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    if (!cancellation) {
      cancellation=completion.cancel();
      // Abort is an event callback; the same promise is awaited before unlock.
      void cancellation.catch(() => {});
    }
    return cancellation;
  };
  const aborted = () => { void cancel(); };
  const check = () => { if (signal?.aborted) fail('TEXT_CANCELLED'); };
  signal?.addEventListener('abort', aborted, { once: true });
  try {
    check();
    const length=response.headers.get('content-length'),coding=response.headers.get('content-encoding')?.toLowerCase();
    const compressed=coding==='gzip'||coding==='br'||coding==='deflate';
    if(!Number.isSafeInteger(expected)||expected<0||expected>LIMITS.wasmBytes||!response.ok)fail('TEXT_ASSET_LOAD');
    if(coding!==undefined&&coding!=='identity'&&!compressed)fail('TEXT_ASSET_LOAD');
    // Fetch exposes decoded bytes for these HTTP codings; Content-Length still
    // describes the encoded transfer. It must remain valid metadata, while the
    // sealed decoded size is enforced on every chunk and again at EOF below.
    if(length!==null&&(!/^(0|[1-9][0-9]*)$/.test(length)||!Number.isSafeInteger(Number(length))||Number(length)>LIMITS.wasmBytes||!compressed&&Number(length)!==expected))fail('TEXT_ASSET_LOAD');
    slab=new Uint8Array(Math.min(expected,65536));
    for (;;) {
      check();const part=await completion.read();
      check();const {done,value}=part;if (done) { ended = true; break; }
      if (value.byteLength > expected - size) fail('TEXT_ASSET_SIZE'); size += value.byteLength;
      for (let offset = 0; offset < value.byteLength;) {
        const count = Math.min(slab.length - used, value.byteLength - offset);
        slab.set(value.subarray(offset, offset + count), used); used += count; offset += count;
        if (used === slab.length) { parts.push(new Blob([slab])); used = 0; }
      }
    }
    if (size !== expected) fail('TEXT_ASSET_SIZE');
    if (used) parts.push(new Blob([slab.subarray(0, used)]));
    complete = true;
  } finally {
    signal?.removeEventListener('abort', aborted);
    slab = new Uint8Array(0);if(!complete)parts.length=0;
    try{await finishAssetReader(response,reader,!ended||cancellation?cancel:undefined);}
    catch(error){parts.length=0;throw error;}
  }
  const result = new Blob(parts); parts.length = 0; return result;
}
export function frozen<T>(value: T): T {
  if (value && typeof value === 'object' && !(value instanceof Blob)) {
    Object.values(value).forEach(frozen); Object.freeze(value);
  }
  return value;
}
