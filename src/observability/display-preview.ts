import {validateAssetProjection} from '../protocol/asset-projection.js';
import {allocationLedger,StreamReaderCompletion,type AllocationLease} from './allocations.js';
import {withDisplayRead} from './display-scheduler.js';
import {DISPLAY_HEADERS,DISPLAY_PROFILE,displayDimensions,displayPath,type DisplayBasis,type DisplayInfo} from '../protocol/display.js';
import type {Asset} from '../protocol/assets.js';
import {SHA256} from '../protocol/sha256.js';
import {ownDisplayControl,DISPLAY_CONTROL_ROOT_BYTES,DISPLAY_SOURCE_CONTROL_BYTES,DISPLAY_PREVIEW_CONTROL_BYTES,DISPLAY_READ_CONTROL_BYTES} from './display-control.js';
import {modelPayloadBytes,reserveModelBytes} from './model-memory.js';

export type DisplaySource=Readonly<{assetId:string;basis:DisplayBasis;identity:string;width:number;height:number}>;
type Transport=(path:string,init?:RequestInit)=>Promise<Response>;
type Owner={owner:string;signal?:AbortSignal;owns?:()=>boolean};
type PreviewOptions=Owner&{edge:256|1024};
type Consumer={release:()=>void};
type Resident={info:Readonly<DisplayInfo>;source:DisplaySource;encoded:AllocationLease;consumers:Set<Consumer>};
const urls=new Map<string,Resident>();
const reads=new Map<AbortController,Promise<unknown>>(),failedURLs=new Set<string>(),failedConsumers=new Set<Consumer>();
class DisplayCleanupError extends Error{constructor(readonly resource:'READER'|'BODY'|'BITMAP'|'URL'|'CONSUMER',cause?:unknown){super('DISPLAY_'+resource+'_RELEASE_FAILED',cause===undefined?undefined:{cause});}}
type NativeCleanup={owners:{response?:Response;reader?:ReadableStreamDefaultReader<Uint8Array>;bitmap?:ImageBitmap};retry:()=>void|Promise<void>;sticky:boolean;error:DisplayCleanupError};
// Each entry retains actual native owners and its already-admitted lease. The
// ledger's record/handle caps bound this registry; entries are never evicted.
const failedNative=new Map<AllocationLease,NativeCleanup>();
function retainNative(lease:AllocationLease,cleanup:NativeCleanup){lease.markUnused();const prior=failedNative.get(lease);if(prior?.sticky){Object.assign(prior.owners,cleanup.owners);return;}failedNative.set(lease,cleanup);}
const HASH=/^sha256:[a-f0-9]{64}$/;
const positive=(value:string|null)=>value!==null&&/^[1-9][0-9]*$/.test(value)&&Number.isSafeInteger(Number(value))?Number(value):null;
function check(options:Owner){if(options.signal?.aborted||options.owns&&!options.owns())throw new DOMException('Display loading was superseded.','AbortError');}
const cleanupFailure=(error:unknown):error is DisplayCleanupError=>error instanceof DisplayCleanupError;
function ownedRead<T>(options:Owner,work:(owned:Owner)=>Promise<T>):Promise<T>{
 try{check(options);if(typeof options.owner!=='string'||options.owner.length>128)throw Error('DISPLAY_READ_OWNER');if(reads.size>=256)throw Error('DISPLAY_READ_CAPACITY');}catch(error){return Promise.reject(error);}
 let lease:AllocationLease;try{lease=allocationLedger.reserve({owner:'display-read-owner',kind:'control',cpuBytes:DISPLAY_READ_CONTROL_BYTES,handles:2});}catch(error){return Promise.reject(error);}
 const abort=new AbortController(),forward=()=>abort.abort();options.signal?.addEventListener('abort',forward,{once:true});if(options.signal?.aborted)forward();
 const pending=Promise.resolve().then(()=>work({owner:options.owner,signal:abort.signal,owns:options.owns})).finally(()=>{options.signal?.removeEventListener('abort',forward);reads.delete(abort);lease.release();});
 reads.set(abort,pending);return pending;
}
/** Called only by the document owner; individual controls abort their own signal. */
export function cancelDisplayPreviewReads(){for(const abort of reads.keys())abort.abort();}
export async function waitForDisplayPreviewReads(){while(reads.size)await Promise.allSettled([...reads.values()]);if(failedNative.size||failedURLs.size||failedConsumers.size)throw Error('DISPLAY_RELEASE_UNCONFIRMED: '+[...[...failedNative.values()].map(value=>value.error.message),...(failedURLs.size?['DISPLAY_URL_RELEASE_FAILED']:[]),...(failedConsumers.size?['DISPLAY_CONSUMER_RELEASE_FAILED']:[])].join(', '));}
/** Explicit retries may close a retained bitmap or unlock a retained reader.
 * A rejected cancellation promise is sticky: a later no-op cancel is not proof
 * that the original native cancellation completed. Such an owner stays charged. */
export async function retryDisplayPreviewCleanup(){
 for(const [lease,cleanup]of failedNative){if(cleanup.sticky)continue;try{await cleanup.retry();failedNative.delete(lease);lease.release();}catch{/* Keep the original failure and owner for another explicit retry. */}}
 for(const consumer of failedConsumers)try{consumer.release();}catch{/* Retained by its URL and lease. */}
 for(const url of failedURLs)try{revokeDisplayPreviewURL(url);}catch{/* Retained by its URL and lease. */}
 await waitForDisplayPreviewReads();
}
export function displayPreviewOwnership(){return Object.freeze({activeReads:reads.size,previewURLs:urls.size,imageConsumers:[...urls.values()].reduce((sum,row)=>sum+row.consumers.size,0),failedNativeOwners:failedNative.size,cleanupFailures:failedNative.size+failedURLs.size+failedConsumers.size});}
async function cancelBody(response:Response,lease:AllocationLease){
 let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,primary:unknown;
 try{if(response.body){reader=response.body.getReader();await new StreamReaderCompletion(reader).cancel();}}
 catch(cause){primary=cause;const error=new DisplayCleanupError('BODY',cause);retainNative(lease,{owners:{response,reader},retry:()=>{},sticky:true,error});throw error;}
 finally{if(reader)try{reader.releaseLock();}catch(cause){const retained=reader,error=new DisplayCleanupError('READER',new AggregateError([primary,cause],'Response cleanup and unlock failed'));retainNative(lease,{owners:{response,reader:retained},retry:()=>retained.releaseLock(),sticky:false,error});throw error;}}
}
function retryPause(milliseconds:number,options:Owner){return new Promise<void>((resolve,reject)=>{const done=()=>{options.signal?.removeEventListener('abort',abort);resolve();},abort=()=>{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);reject(new DOMException('Display loading was superseded.','AbortError'));},timer=setTimeout(done,milliseconds);options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();});}
async function fetchPreview(transport:Transport,path:string,options:Owner){
 for(let attempt=0;;attempt++){
  check(options);const lease=allocationLedger.reserve({owner:'display-busy-response',kind:'control',cpuBytes:6144,handles:2});let failed=false;
  try{const response=await transport(path,{signal:options.signal});if(response.status!==429)return response;const bytes=await readBounded(response,1024,false,options,lease),value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as {error?:{code?:string;retry?:string}};if(value.error?.code!=='LOCAL_BUSY'||value.error.retry!=='read-or-transfer'||attempt>=5)throw Error('DISPLAY_LOCAL_BUSY');}
  catch(error){failed=cleanupFailure(error);throw error;}finally{if(!failed)lease.release();}
  await retryPause(Math.min(1000,100*2**attempt),options);check(options);
 }
}

/** Identities describe the retained source; a rendition's PNG hash is separate. */
export function sourceFromAsset(asset:Asset,basis:DisplayBasis='pixels'):DisplaySource{
 const raster=asset?.raster,identity=basis==='pixels'?raster?.pixelIdentity:asset?.blob?.hash;
 if(!asset||!raster||!['pixels','encoded'].includes(basis)||!HASH.test(identity??'')||!/^[A-Za-z0-9_-]{1,128}$/.test(asset.id)||asset.availability!=='available'||asset.safety!=='safe')throw Error('DISPLAY_SOURCE');
 displayDimensions(raster.width,raster.height,{basis,identity:identity!,kind:'preview',edge:1024});
 return Object.freeze({assetId:asset.id,basis,identity:identity!,width:raster.width,height:raster.height});
}

/** Product callers keep the descriptor through validation and the complete
 * asynchronous consumer. The legacy bare reader remains a compatibility API. */
export function withDisplaySource<T>(transport:Transport,assetId:string,options:Owner,consume:(source:DisplaySource)=>Promise<T>):Promise<T>{
 return ownedRead(options,async owned=>{
  const payload=reserveModelBytes('display-source-descriptor',DISPLAY_SOURCE_CONTROL_BYTES);
  try{const source=await readSource(transport,assetId,owned),bytes=DISPLAY_CONTROL_ROOT_BYTES+modelPayloadBytes(source);if(bytes>DISPLAY_SOURCE_CONTROL_BYTES)throw Error('DISPLAY_CONTROL_ALLOWANCE');payload.resize(bytes);check(owned);return await consume(source);}
  finally{payload.release();}
 });
}
export async function withAssetDisplaySource<T>(asset:Asset,basis:DisplayBasis,consume:(source:DisplaySource)=>Promise<T>):Promise<T>{
 const source=ownDisplayControl('display-source-descriptor',DISPLAY_SOURCE_CONTROL_BYTES,()=>sourceFromAsset(asset,basis));
 try{return await consume(source.value);}finally{source.release();}
}

/** One destination buffer and at most one admitted incoming chunk are booked by
 * the caller. Native transport buffers are not process-memory measurements. */
async function readBounded(response:Response,bound:number,exact:boolean,options:Owner,lease:AllocationLease):Promise<Uint8Array>{
 let completion:StreamReaderCompletion|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined,cancellation:Promise<void>|undefined,primary:unknown;
 const cancel=()=>cancellation??=(async()=>{if(!reader&&response.body){reader=response.body.getReader();completion=new StreamReaderCompletion(reader);}if(completion)await completion.cancel();else await response.body?.cancel();})();
 const abort=()=>{void cancel().catch(()=>{});};
 try{
  check(options);if(!response.body)throw Error('DISPLAY_BODY');reader=response.body.getReader();completion=new StreamReaderCompletion(reader);options.signal?.addEventListener('abort',abort,{once:true});check(options);
  const bytes=new Uint8Array(bound);let used=0;
  for(;;){check(options);const part=await completion.read();check(options);if(part.done)break;if(part.value.byteLength>bound-used)throw Error('DISPLAY_BODY_SIZE');bytes.set(part.value,used);used+=part.value.byteLength;}
  if(exact&&used!==bound)throw Error('DISPLAY_BODY_SIZE');check(options);if(cancellation)await cancellation;
  // Complete the native ownership handshake before returning the byte owner.
  reader.releaseLock();reader=undefined;return bytes.subarray(0,used);
 }catch(error){primary=error;try{await cancel();}catch(cause){const failure=new DisplayCleanupError('BODY',new AggregateError([error,cause],'Read and cancellation failed'));primary=failure;retainNative(lease,{owners:{response,reader},retry:()=>{},sticky:true,error:failure});throw failure;}throw error;}
 finally{
  options.signal?.removeEventListener('abort',abort);
  if(reader)try{reader.releaseLock();}catch(cause){const retained=reader,error=new DisplayCleanupError('READER',new AggregateError([primary,cause],'Read and reader unlock failed'));retainNative(lease,{owners:{response,reader:retained},retry:()=>retained.releaseLock(),sticky:false,error});throw error;}
 }
}

/** Metadata is a bounded control payload; retained raster bytes are never read. */
export function readDisplaySource(transport:Transport,assetId:string,options:Owner):Promise<DisplaySource>{return ownedRead(options,owned=>readSource(transport,assetId,owned));}
async function readSource(transport:Transport,assetId:string,options:Owner):Promise<DisplaySource>{
 if(!/^[A-Za-z0-9_-]{1,128}$/.test(assetId))throw Error('DISPLAY_SOURCE');check(options);
 const bound=65536,lease=allocationLedger.reserve({owner:options.owner,kind:'control',cpuBytes:bound*6,handles:2});let cleanupFailed=false;
 try{
  const response=await transport('/api/v1/assets/'+encodeURIComponent(assetId),{signal:options.signal});
  if(!response.ok){await cancelBody(response,lease);throw Error('DISPLAY_SOURCE_UNAVAILABLE');}
  const length=response.headers.get('content-length');if(length!==null&&(positive(length)===null||Number(length)>bound)){await cancelBody(response,lease);throw Error('DISPLAY_SOURCE_SIZE');}
  const bytes=await readBounded(response,bound,false,options,lease),parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  check(options);const asset=validateAssetProjection(parsed);if(asset.id!==assetId)throw Error('DISPLAY_SOURCE');return sourceFromAsset(asset);
 }catch(error){cleanupFailed=cleanupFailure(error);throw error;}
 finally{if(!cleanupFailed)lease.release();}
}

function infoFromResponse(response:Response,source:DisplaySource,edge:256|1024):Readonly<DisplayInfo>{
 const request={basis:source.basis,identity:source.identity,kind:'preview' as const,edge},dimensions=displayDimensions(source.width,source.height,request),h=response.headers;
 const width=positive(h.get(DISPLAY_HEADERS.width)),height=positive(h.get(DISPLAY_HEADERS.height)),length=positive(h.get('content-length')),etag=h.get('etag');
 if(!response.ok||h.get(DISPLAY_HEADERS.profile)!==DISPLAY_PROFILE||h.get(DISPLAY_HEADERS.source)!==source.identity||h.get(DISPLAY_HEADERS.basis)!==source.basis||h.get(DISPLAY_HEADERS.sourceWidth)!==String(source.width)||h.get(DISPLAY_HEADERS.sourceHeight)!==String(source.height)||h.get(DISPLAY_HEADERS.lod)!=='0'||width!==dimensions.width||height!==dimensions.height||h.get('content-type')?.split(';')[0]!=='image/png'||!etag||!/^"sha256:[a-f0-9]{64}"$/.test(etag)||length===null||length>dimensions.width*dimensions.height*4+dimensions.height+65536)throw Error('DISPLAY_DESCRIPTOR');
 return Object.freeze({profile:DISPLAY_PROFILE,source:source.identity,basis:source.basis,width,height,sourceWidth:source.width,sourceHeight:source.height,lod:0,byteLength:String(length),hash:etag.slice(1,-1),mediaType:'image/png'});
}

/** Validate geometry before invoking a browser decoder. Only the server's
 * static, non-interlaced RGBA8 PNG profile is admitted; no APNG frames. */
function validatePNG(bytes:Uint8Array,info:DisplayInfo){
 const signature=[137,80,78,71,13,10,26,10];if(bytes.length<45||signature.some((byte,i)=>bytes[i]!==byte))throw Error('DISPLAY_PNG');
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let at=8,chunks=0,ihdr=false,idat=false,ended=false;
 while(at<bytes.length){if(++chunks>1024||at+12>bytes.length)throw Error('DISPLAY_PNG');const size=view.getUint32(at),end=at+12+size;if(end>bytes.length)throw Error('DISPLAY_PNG');const type=String.fromCharCode(...bytes.subarray(at+4,at+8));
  if(!ihdr){if(type!=='IHDR'||size!==13||view.getUint32(at+8)!==info.width||view.getUint32(at+12)!==info.height||bytes[at+16]!==8||bytes[at+17]!==6||bytes[at+18]!==0||bytes[at+19]!==0||bytes[at+20]!==0)throw Error('DISPLAY_PNG_DIMENSIONS');ihdr=true;}
  else if(type==='IHDR'||type==='acTL'||type==='fcTL'||type==='fdAT')throw Error('DISPLAY_PNG');
  if(type==='IDAT')idat=true;if(type==='IEND'){if(size!==0||end!==bytes.length||!idat)throw Error('DISPLAY_PNG');ended=true;}at=end;
 }
 if(!ended)throw Error('DISPLAY_PNG');
}

/** A URL owns its encoded PNG. The temporary verification bitmap is closed
 * before publication; every HTML/SVG consumer separately admits its bounded
 * RGBA CPU/GPU allowance before assigning src/href. */
export function createDisplayPreviewURL(transport:Transport,source:DisplaySource,options:PreviewOptions):Promise<string>{return ownedRead(options,owned=>{
 // Admit the read control before copying only the bounded canonical fields.
 if(!/^[A-Za-z0-9_-]{1,128}$/.test(source.assetId))throw Error('DISPLAY_SOURCE');
 displayDimensions(source.width,source.height,{kind:'preview',basis:source.basis,identity:source.identity,edge:options.edge});
 const frozen=Object.freeze({assetId:source.assetId,basis:source.basis,identity:source.identity,width:source.width,height:source.height});
 return createPreview(transport,frozen,{...owned,edge:options.edge});
});}
async function createPreview(transport:Transport,source:DisplaySource,options:PreviewOptions):Promise<string>{
 check(options);const request={basis:source.basis,identity:source.identity,kind:'preview' as const,edge:options.edge},dimensions=displayDimensions(source.width,source.height,request),path=displayPath(source.assetId,request);
 return withDisplayRead(options.signal,async()=>{
  check(options);const rgba=dimensions.width*dimensions.height*4;
  let decoded:AllocationLease|undefined=allocationLedger.reserve({owner:options.owner,kind:'bitmap',cpuBytes:rgba*2+DISPLAY_CONTROL_ROOT_BYTES,gpuBytes:rgba,previewCacheBytes:rgba*2,handles:3}),encoded:AllocationLease|undefined,bitmap:ImageBitmap|undefined,response:Response|undefined,bodyRead=false,primary:unknown;
  try{
   response=await fetchPreview(transport,path,options);check(options);const info=infoFromResponse(response,source,options.edge),length=Number(info.byteLength);
   // The encoded owner also retains its descriptor, source, URL and registry
   // control through the last actual revoke (including failed cleanup retries).
   encoded=allocationLedger.reserve({owner:options.owner,kind:'blob',cpuBytes:length*2+DISPLAY_PREVIEW_CONTROL_BYTES,previewCacheBytes:length,handles:2});bodyRead=true;
   let bytes:Uint8Array<ArrayBufferLike>|null=await readBounded(response,length,true,options,encoded);check(options);
   const hash=new SHA256();let sliceStart=performance.now();for(let at=0;at<bytes.length;at+=32768){hash.update(bytes.subarray(at,at+32768));if(performance.now()-sliceStart>=4){await new Promise<void>(resolve=>setTimeout(resolve,0));check(options);sliceStart=performance.now();}}if(hash.digest()!==info.hash)throw Error('DISPLAY_CONTENT_IDENTITY');validatePNG(bytes,info);
   const blob=new Blob([bytes as Uint8Array<ArrayBuffer>],{type:'image/png'});bytes=null;encoded.resize({cpuBytes:length+DISPLAY_PREVIEW_CONTROL_BYTES,handles:1});
   bitmap=await createImageBitmap(blob);check(options);if(bitmap.width!==info.width||bitmap.height!==info.height)throw Error('DISPLAY_DECODE_DIMENSIONS');bitmap.close();bitmap=undefined;
   decoded.release();decoded=undefined;encoded.resize({handles:2});check(options);
   const url=URL.createObjectURL(blob);urls.set(url,{info,source,encoded,consumers:new Set()});encoded=undefined;
   // A browser-generated URL is bounded before it reaches any consumer. If
   // revocation fails the registered owner remains charged for that failure.
   if(url.length>2048){revokeDisplayPreviewURL(url);throw Error('DISPLAY_URL_SIZE');}
   return url;
  }catch(error){
   primary=error;
   if(response&&!bodyRead)try{await cancelBody(response,decoded!);}catch(cleanup){decoded=undefined;if(cleanupFailure(cleanup))throw new DisplayCleanupError(cleanup.resource,new AggregateError([error,cleanup],'Preview and response cleanup failed'));throw cleanup;}
   if(cleanupFailure(error))encoded=undefined;
   throw error;
  }finally{
   if(bitmap)try{bitmap.close();}catch(cause){const retained=bitmap,error=new DisplayCleanupError('BITMAP',new AggregateError([primary,cause],'Preview and bitmap close failed'));if(decoded)retainNative(decoded,{owners:{bitmap:retained},retry:()=>retained.close(),sticky:false,error});encoded?.release();throw error;}
   encoded?.release();decoded?.release();
  }
 });
}

export function displayPreviewInfo(url:string){return urls.get(url)?.info;}
export function validateDisplayImage(image:Pick<HTMLImageElement,'naturalWidth'|'naturalHeight'>,url:string){const info=displayPreviewInfo(url);if(!info||image.naturalWidth!==info.width||image.naturalHeight!==info.height)throw Error('DISPLAY_DECODE_DIMENSIONS');return info;}
/** Called by displayImage's connection lifecycle, before the browser sees the
 * resource attribute. Multiple elements never assume a shared native decode. */
export function acquireDisplayPreviewConsumer(url:string,detach:()=>void):Consumer{
 const resident=urls.get(url);if(!resident)throw Error('DISPLAY_PREVIEW_RETIRED');const bytes=resident.info.width*resident.info.height*4;
 const lease=allocationLedger.reserve({owner:'display-image-consumer',kind:'bitmap',cpuBytes:bytes+256,gpuBytes:bytes,previewCacheBytes:bytes*2,handles:2});let live=true;
 const consumer:Consumer={release(){if(!live)return;try{detach();}catch{lease.markUnused();failedConsumers.add(consumer);throw new DisplayCleanupError('CONSUMER');}live=false;resident.consumers.delete(consumer);failedConsumers.delete(consumer);lease.release();}};
 resident.consumers.add(consumer);return consumer;
}
export function revokeDisplayPreviewURL(url:string){const resident=urls.get(url);if(!resident)return;let failed=false;for(const consumer of resident.consumers)try{consumer.release();}catch{failed=true;}if(failed){failedURLs.add(url);throw new DisplayCleanupError('CONSUMER');}try{URL.revokeObjectURL(url);}catch{resident.encoded.markUnused();failedURLs.add(url);throw new DisplayCleanupError('URL');}urls.delete(url);failedURLs.delete(url);resident.encoded.release();}
