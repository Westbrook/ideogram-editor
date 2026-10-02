import {validateAssetProjection} from '../protocol/asset-projection.js';
import {allocationLedger,StreamReaderCompletion,type AllocationLease} from '../observability/allocations.js';
import {withDisplayRead} from '../observability/display-scheduler.js';
import {DISPLAY_HEADERS,DISPLAY_PROFILE,DISPLAY_TILE_SIZE,DISPLAY_MAX_LOD,displayPath} from '../protocol/display.js';
import {SHA256} from '../protocol/sha256.js';
import {ownDisplayControl,readOwnedDisplayControl,DISPLAY_CONTROL_ROOT_BYTES,DISPLAY_SOURCE_CONTROL_BYTES,DISPLAY_TILE_CONTROL_BYTES} from '../observability/display-control.js';
import type {OwnedModel} from '../observability/model-memory.js';

export const DISPLAY_CACHE_TARGET=64*1024**2,DISPLAY_CACHE_LIMIT=128*1024**2;
// Covers even the finest intermediate LOD before the pixel-budget fallback.
const DISPLAY_MAX_TILE_SPECS=Math.ceil(8192/DISPLAY_TILE_SIZE)**2;
export type DisplaySource={assetId:string;identity:string;width:number;height:number};
export type DisplayViewport={width:number;height:number;zoom:number;x:number;y:number;ratio:number};
export type TileSpec={key:string;lod:number;x:number;y:number;width:number;height:number;sourceX:number;sourceY:number;sourceWidth:number;sourceHeight:number};
export type DisplayTile=TileSpec&{bitmap:ImageBitmap;serial:number;bytes:number;lease:AllocationLease};
type Transport=(path:string,init?:RequestInit)=>Promise<Response>;
const hash=/^sha256:[a-f0-9]{64}$/;
function check(signal?:AbortSignal){if(signal?.aborted)throw new DOMException('Display read cancelled.','AbortError');}

/** Keep viewport backing bounded independently of document extent. On an
 * unusually large/high-DPI window only display resolution is reduced. */
export function viewportBacking(width:number,height:number,ratio:number){
  if(!Number.isFinite(width)||!Number.isFinite(height)||width<0||height<0||!Number.isFinite(ratio)||ratio<=0)throw Error('DISPLAY_VIEWPORT');
  const cssWidth=Math.max(1,width),cssHeight=Math.max(1,height);
  const scale=Math.min(ratio,8192/cssWidth,8192/cssHeight,Math.sqrt(16*1024**2/(cssWidth*cssHeight)));
  return {width:Math.max(1,Math.floor(cssWidth*scale)),height:Math.max(1,Math.floor(cssHeight*scale)),ratio:scale};
}

/** Required tiles cover only the viewport intersection. A coarser display LOD
 * is selected when fringe tiles would exceed the 64 MiB cache target. Native
 * level zero remains exact; no retained pixels or request sizes are changed. */
export function visibleTiles(source:DisplaySource,view:DisplayViewport):TileSpec[]{
  if(!Number.isSafeInteger(source.width)||!Number.isSafeInteger(source.height)||source.width<1||source.height<1||source.width>8192||source.height>8192||source.width*source.height>25000000||![view.width,view.height,view.zoom,view.x,view.y,view.ratio].every(Number.isFinite)||view.zoom<=0||view.ratio<=0||view.width<0||view.height<0)throw Error('DISPLAY_VIEWPORT');
  const left=Math.max(0,Math.min(source.width,source.width/2-(view.width/2+view.x)/view.zoom));
  const top=Math.max(0,Math.min(source.height,source.height/2-(view.height/2+view.y)/view.zoom));
  const right=Math.max(0,Math.min(source.width,source.width/2+(view.width/2-view.x)/view.zoom));
  const bottom=Math.max(0,Math.min(source.height,source.height/2+(view.height/2-view.y)/view.zoom));
  if(right<=left||bottom<=top)return [];
  let lod=Math.min(DISPLAY_MAX_LOD,Math.max(0,Math.floor(Math.log2(1/(view.zoom*view.ratio)))));
  for(;;lod++){
    const scale=2**lod,w=Math.ceil(source.width/scale),h=Math.ceil(source.height/scale),scaleX=source.width/w,scaleY=source.height/h,tiles:TileSpec[]=[];
    const x0=Math.floor(left/scaleX/DISPLAY_TILE_SIZE),y0=Math.floor(top/scaleY/DISPLAY_TILE_SIZE),x1=Math.ceil(right/scaleX/DISPLAY_TILE_SIZE),y1=Math.ceil(bottom/scaleY/DISPLAY_TILE_SIZE);
    let bytes=0;
    for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
      const width=Math.min(DISPLAY_TILE_SIZE,w-x*DISPLAY_TILE_SIZE),height=Math.min(DISPLAY_TILE_SIZE,h-y*DISPLAY_TILE_SIZE),sourceX=x*DISPLAY_TILE_SIZE*scaleX,sourceY=y*DISPLAY_TILE_SIZE*scaleY;
      bytes+=width*height*4;tiles.push({key:`${lod}:${x}:${y}`,lod,x,y,width,height,sourceX,sourceY,sourceWidth:width*scaleX,sourceHeight:height*scaleY});
    }
    if(bytes<=DISPLAY_CACHE_TARGET||lod===DISPLAY_MAX_LOD)return tiles;
  }
}

/** The current required set and every still-running older viewport each keep
 * their own reference. Admission precedes every intermediate LOD array. */
export function ownedVisibleTiles(source:DisplaySource,view:DisplayViewport):OwnedModel<readonly TileSpec[]>{
 return ownDisplayControl('display-visible-tiles',DISPLAY_CONTROL_ROOT_BYTES+DISPLAY_MAX_TILE_SPECS*DISPLAY_TILE_CONTROL_BYTES,()=>{
  const tiles=visibleTiles(source,view);if(tiles.length>DISPLAY_MAX_TILE_SPECS)throw Error('DISPLAY_TILE_COUNT');
  for(const tile of tiles)Object.freeze(tile);return Object.freeze(tiles);
 });
}

export function isDisplayAbort(error:unknown){return error instanceof Error&&error.name==='AbortError';}
const nextTask=()=>new Promise<void>(resolve=>setTimeout(resolve,0));

/** Failed native cleanup keeps both its retry function and charged owner.
 * Retrying a bitmap close/unlock may establish release; an unsuccessful source
 * cancellation remains explicit because a second cancel on a closed stream
 * cannot prove the underlying source's failed cleanup subsequently succeeded. */
export class DisplayCleanupRegistry {
  private tasks=new Set<{run:()=>Promise<void>;error:unknown}>();
  get size(){return this.tasks.size;}
  retain(run:()=>Promise<void>,error:unknown){this.tasks.add({run,error});}
  async retry(){const failures:unknown[]=[];for(const task of this.tasks){try{await task.run();this.tasks.delete(task);}catch(error){task.error=error;failures.push(error);}}
    if(failures.length)throw new AggregateError(failures,'DISPLAY_CLEANUP_INCOMPLETE');
  }
}

const sourceCleanup=new DisplayCleanupRegistry();
export function displaySourceCleanupOwnership(){return {pendingCleanup:sourceCleanup.size};}
export function retryDisplaySourceCleanup(){return sourceCleanup.retry();}

async function displayBytes(response:Response,bound:number,exact:boolean,signal:AbortSignal,owns:()=>boolean,cleanup:DisplayCleanupRegistry,ownedReader:AllocationLease):Promise<Uint8Array<ArrayBuffer>>{
  let completion:StreamReaderCompletion|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined,readerLease:AllocationLease|undefined=ownedReader,cancellation:Promise<void>|undefined,cancelFailure:unknown,failedCancel=false,finished=false;
  const current=()=>{check(signal);if(!owns())throw new DOMException('Display owner changed.','AbortError');};
  const cancel=()=>cancellation??=Promise.resolve().then(async()=>{if(!reader&&response.body){readerLease?.resize({handles:2});reader=response.body.getReader();completion=new StreamReaderCompletion(reader);}if(completion)await completion.cancel();else await response.body?.cancel();});
  const abort=()=>{void cancel().catch(()=>{});};
  const release=async()=>{
    const failures:unknown[]=[];
    if(!finished){try{await cancel();}catch(error){failedCancel=true;cancelFailure=error;}}
    if(reader){try{reader.releaseLock();reader=undefined;}catch(error){failures.push(error);}}
    if(failedCancel)failures.push(cancelFailure);
    if(failures.length){readerLease?.markUnused();throw new AggregateError(failures,'DISPLAY_READER_RELEASE_FAILED');}
    readerLease?.release();readerLease=undefined;
  };
  let primary:unknown,failed=false;
  try{
    current();if(!response.body)throw Error('DISPLAY_BODY');
    readerLease?.resize({handles:2});reader=response.body.getReader();completion=new StreamReaderCompletion(reader);
    signal.addEventListener('abort',abort,{once:true});current();
    const bytes=new Uint8Array(bound);let used=0,deadline=performance.now()+4;
    for(;;){const part=await completion.read();current();if(part.done){finished=true;break;}if(part.value.byteLength>bound-used)throw Error('DISPLAY_BODY_SIZE');
      for(let at=0;at<part.value.byteLength;at+=32768){const section=part.value.subarray(at,at+32768);bytes.set(section,used);used+=section.byteLength;
        if(performance.now()>=deadline){await nextTask();current();deadline=performance.now()+4;}
      }
    }
    if(exact&&used!==bound)throw Error('DISPLAY_BODY_SIZE');current();return bytes.subarray(0,used);
  }catch(error){primary=error;failed=true;throw error;}
  finally{
    signal.removeEventListener('abort',abort);
    try{await release();}catch(error){cleanup.retain(release,error);throw new AggregateError(failed?[primary,error]:[error],'DISPLAY_CLEANUP_INCOMPLETE',{cause:failed?primary:error});}
  }
}

function retryPause(milliseconds:number,signal:AbortSignal){return new Promise<void>((resolve,reject)=>{
  const done=()=>{signal.removeEventListener('abort',abort);resolve();},abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(new DOMException('Display read cancelled.','AbortError'));},timer=setTimeout(done,milliseconds);
  signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
});}
async function fetchDisplayTile(transport:Transport,path:string,signal:AbortSignal,owns:()=>boolean,cleanup:DisplayCleanupRegistry){
  for(let attempt=0;;attempt++){
    check(signal);if(!owns())throw new DOMException('Display owner changed.','AbortError');
    // Busy control responses are bounded separately from the tile bytes. Each
    // attempt drains its native response before another request is admitted.
    const workspace=allocationLedger.reserve({owner:'display-tile-busy',kind:'control',cpuBytes:6144,handles:2});
    let responseLease:AllocationLease|undefined;
    try{
      responseLease=allocationLedger.reserve({owner:'display-tile-response',kind:'staging',cpuBytes:DISPLAY_CONTROL_ROOT_BYTES,handles:1});
      const response=await transport(path,{signal});
      if(response.status!==429){const lease=responseLease;responseLease=undefined;return {response,lease};}
      const owned=responseLease;responseLease=undefined;
      const bytes=await displayBytes(response,1024,false,signal,owns,cleanup,owned),value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as {error?:{code?:string;retry?:string}};
      if(value.error?.code!=='LOCAL_BUSY'||value.error.retry!=='read-or-transfer'||attempt>=5)throw Error('DISPLAY_LOCAL_BUSY');
    }finally{responseLease?.release();workspace.release();}
    await retryPause(Math.min(1000,100*2**attempt),signal);
  }
}

async function cancelDisplayBody(response:Response,lease:AllocationLease,cleanup:DisplayCleanupRegistry){
 let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,completion:StreamReaderCompletion|undefined,cancellation:Promise<void>|undefined;
 const release=async()=>{const failures:unknown[]=[];
  try{if(!cancellation)cancellation=(async()=>{if(response.body){lease.resize({handles:2});reader=response.body.getReader();completion=new StreamReaderCompletion(reader);await completion.cancel();}})();await cancellation;}catch(error){failures.push(error);}
  if(reader)try{reader.releaseLock();reader=undefined;}catch(error){failures.push(error);}
  if(failures.length){lease.markUnused();throw new AggregateError(failures,'DISPLAY_READER_RELEASE_FAILED');}lease.release();
 };
 try{await release();}catch(error){cleanup.retain(release,error);throw error;}
}

export async function readDisplaySource(transport:Transport,assetId:string,width:number,height:number,signal:AbortSignal,cleanup:DisplayCleanupRegistry=sourceCleanup):Promise<DisplaySource>{
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(assetId))throw Error('DISPLAY_SOURCE');
  return withDisplayRead(signal,async()=>{
    const bound=65536,workspace=allocationLedger.reserve({owner:'display-source-json',kind:'control',cpuBytes:bound*6,handles:3});let response:Response|undefined,bodyRead=false,responseLease:AllocationLease|undefined;
    try{
      check(signal);responseLease=allocationLedger.reserve({owner:'display-source-response',kind:'staging',cpuBytes:DISPLAY_CONTROL_ROOT_BYTES,handles:1});response=await transport('/api/v1/assets/'+encodeURIComponent(assetId),{signal});check(signal);
      if(!response.ok)throw Error('DISPLAY_SOURCE_UNAVAILABLE');
      const length=response.headers.get('content-length');if(length!==null&&(!/^(0|[1-9][0-9]*)$/.test(length)||Number(length)>bound))throw Error('DISPLAY_SOURCE_SIZE');
      bodyRead=true;const owned=responseLease!;responseLease=undefined;const bytes=await displayBytes(response,bound,false,signal,()=>true,cleanup,owned);
      const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));check(signal);const asset=validateAssetProjection(value);
      if(asset?.id!==assetId||asset.safety!=='safe'||asset.availability!=='available'||!asset.raster||asset.raster.width!==width||asset.raster.height!==height||!hash.test(asset.raster.pixelIdentity))throw Error('DISPLAY_SOURCE_CHANGED');
      return {assetId,identity:asset.raster.pixelIdentity,width,height};
    }catch(error){if(response&&!bodyRead){const owned=responseLease!;responseLease=undefined;try{await cancelDisplayBody(response,owned,cleanup);}catch(failure){throw new AggregateError([error,failure],'DISPLAY_READER_RELEASE_FAILED');}}throw error;}
    finally{responseLease?.release();workspace.release();}
  });
}

/** Product source descriptors retain their own lease after parse workspace
 * retirement. The old bare export is for callers with independent ownership. */
export function readOwnedDisplaySource(transport:Transport,assetId:string,width:number,height:number,signal:AbortSignal,cleanup:DisplayCleanupRegistry=sourceCleanup):Promise<OwnedModel<DisplaySource>>{
 return readOwnedDisplayControl('display-canvas-source',DISPLAY_SOURCE_CONTROL_BYTES,async()=>Object.freeze(await readDisplaySource(transport,assetId,width,height,signal,cleanup)));
}

/** One owner per CanvasView. Tiles from another immutable source never remain
 * resident after that source is retired. Only the required set is pinned;
 * unused tiles leave in LRU order before new allocation admission. */
export class DisplayTileCache {
  private entries=new Map<string,DisplayTile>();private bytes=0;private pinned=new Set<string>();private pinLease:AllocationLease|undefined;private unusable=new Set<string>();private serial=0;
  private created=0;private released=0;private reused=0;private starts=0;
  readonly cleanup=new DisplayCleanupRegistry();
  constructor(private transport:Transport){}
  get ownership(){return {decodedBitmaps:this.entries.size,cacheBytes:this.bytes,createdBitmaps:this.created,releasedBitmaps:this.released,reusedBitmaps:this.reused,decodeStarts:this.starts,pendingCleanup:this.cleanup.size+this.unusable.size};}
  get(key:string){if(this.unusable.has(key))return undefined;const tile=this.entries.get(key);if(tile){this.entries.delete(key);this.entries.set(key,tile);}return tile;}
  contains(key:string){return this.entries.has(key)&&!this.unusable.has(key);}
  tiles(){return [...this.entries.values()].filter(tile=>!this.unusable.has(tile.key));}
  /** Synchronous draw borrows bitmap owners and books only the temporary index. */
  withTiles(draw:(tiles:DisplayTile[])=>void){const lease=allocationLedger.reserve({owner:'display-draw-index',kind:'control',cpuBytes:DISPLAY_CONTROL_ROOT_BYTES+this.entries.size*16,handles:1});try{draw(this.tiles());}finally{lease.release();}}
  pin(specs:readonly TileSpec[]){
    if(specs.length>DISPLAY_MAX_TILE_SPECS||specs.some(spec=>typeof spec.key!=='string'||spec.key.length>64))throw Error('DISPLAY_TILE_COUNT');
    const lease=allocationLedger.reserve({owner:'display-pinned-index',kind:'control',cpuBytes:DISPLAY_CONTROL_ROOT_BYTES+specs.reduce((bytes,spec)=>bytes+spec.key.length*2+16,0),handles:1});
    let next:Set<string>;try{next=new Set(specs.map(tile=>tile.key));}catch(error){lease.release();throw error;}
    const prior=this.pinLease;this.pinned=next;this.pinLease=lease;prior?.release();this.evict(0);
  }
  has(specs:readonly TileSpec[]){return specs.every(spec=>this.contains(spec.key));}
  reuse(specs:readonly TileSpec[]){for(const spec of specs)if(this.contains(spec.key))this.reused++;}
  private drop(key:string){const tile=this.entries.get(key);if(!tile)return;this.unusable.add(key);try{tile.bitmap.close();}catch(error){tile.lease.markUnused();throw error;}this.entries.delete(key);this.unusable.delete(key);this.bytes-=tile.bytes;this.released++;tile.lease.release();}
  private evict(additional:number){for(const key of this.entries.keys()){if(this.bytes+additional<=DISPLAY_CACHE_TARGET&&!this.unusable.has(key))continue;if(!this.pinned.has(key)||this.unusable.has(key))this.drop(key);}if(this.bytes+additional>DISPLAY_CACHE_LIMIT)throw Error('DISPLAY_CACHE_CAPACITY');}
  clear(){this.pinned.clear();this.pinLease?.release();this.pinLease=undefined;const failures:unknown[]=[];for(const key of this.entries.keys())try{this.drop(key);}catch(error){failures.push(error);}if(failures.length)throw new AggregateError(failures,'DISPLAY_RELEASE_FAILED');}
  async retryCleanup(){const failures:unknown[]=[];try{await this.cleanup.retry();}catch(error){failures.push(error);}for(const key of this.unusable)try{this.drop(key);}catch(error){failures.push(error);}if(failures.length)throw new AggregateError(failures,'DISPLAY_CLEANUP_INCOMPLETE');}
  async load(source:DisplaySource,spec:TileSpec,signal:AbortSignal,owns:()=>boolean):Promise<void>{
    check(signal);if(!owns())return;if(this.contains(spec.key)){this.reused++;return;}
    await withDisplayRead(signal,async()=>{
      check(signal);if(!owns())return;await this.retryCleanup();check(signal);if(!owns())return;
      const bytes=spec.width*spec.height*4;this.evict(bytes);
      const workspace=allocationLedger.reserve({owner:'display-tile-copy',kind:'staging',cpuBytes:bytes*2+65536,handles:2});
      let lease:AllocationLease|undefined,bitmap:ImageBitmap|undefined,response:Response|undefined,bodyRead=false,responseLease:AllocationLease|undefined;
      let primary:unknown,failed=false;
      const releaseBitmap=async()=>{if(bitmap){try{bitmap.close();this.released++;bitmap=undefined;}catch(error){lease?.markUnused();throw error;}}lease?.release();lease=undefined;};
      try{
        const received=await fetchDisplayTile(this.transport,displayPath(source.assetId,{kind:'tile',basis:'pixels',identity:source.identity,lod:spec.lod,x:spec.x,y:spec.y}),signal,owns,this.cleanup);response=received.response;responseLease=received.lease;check(signal);
        const h=response.headers,etag=h.get('etag');
        if(!response.ok||h.get(DISPLAY_HEADERS.profile)!==DISPLAY_PROFILE||h.get(DISPLAY_HEADERS.source)!==source.identity||h.get(DISPLAY_HEADERS.basis)!=='pixels'||h.get(DISPLAY_HEADERS.width)!==String(spec.width)||h.get(DISPLAY_HEADERS.height)!==String(spec.height)||h.get(DISPLAY_HEADERS.sourceWidth)!==String(source.width)||h.get(DISPLAY_HEADERS.sourceHeight)!==String(source.height)||h.get(DISPLAY_HEADERS.lod)!==String(spec.lod)||h.get('content-type')?.split(';')[0]!=='application/x-ideogram-rgba8'||h.get('content-length')!==String(bytes)||!etag||!/^"sha256:[a-f0-9]{64}"$/.test(etag)||!response.body)throw Error('DISPLAY_TILE_MISMATCH');
        bodyRead=true;const owned=responseLease!;responseLease=undefined;const rgba=await displayBytes(response,bytes,true,signal,owns,this.cleanup,owned),digest=new SHA256();let deadline=performance.now()+4;
        for(let at=0;at<rgba.length;at+=32768){digest.update(rgba.subarray(at,at+32768));if(performance.now()>=deadline){await nextTask();check(signal);if(!owns())return;deadline=performance.now()+4;}}
        if(digest.digest()!==etag.slice(1,-1))throw Error('DISPLAY_TILE_HASH');check(signal);if(!owns())return;
        // The same owner retains the copied spec and resident/index bookkeeping
        // until the bitmap really closes, including unsuccessful close retries.
        lease=allocationLedger.reserve({owner:'display-tile',kind:'bitmap',cpuBytes:bytes+DISPLAY_TILE_CONTROL_BYTES,gpuBytes:bytes,previewCacheBytes:bytes,handles:1});
        this.starts++;bitmap=await createImageBitmap(new ImageData(new Uint8ClampedArray(rgba.buffer,rgba.byteOffset,rgba.byteLength),spec.width,spec.height,{colorSpace:'srgb'}),{premultiplyAlpha:'none',colorSpaceConversion:'none'});const serial=++this.serial;this.created++;
        check(signal);if(!owns())return;if(bitmap.width!==spec.width||bitmap.height!==spec.height)throw Error('DISPLAY_TILE_DIMENSIONS');
        if(this.contains(spec.key))return;
        this.entries.set(spec.key,{key:spec.key,lod:spec.lod,x:spec.x,y:spec.y,width:spec.width,height:spec.height,sourceX:spec.sourceX,sourceY:spec.sourceY,sourceWidth:spec.sourceWidth,sourceHeight:spec.sourceHeight,bitmap,serial,bytes,lease});this.bytes+=bytes;bitmap=undefined;lease=undefined;
      }catch(error){primary=error;failed=true;
        if(response&&!bodyRead){const owned=responseLease!;responseLease=undefined;try{await cancelDisplayBody(response,owned,this.cleanup);}catch(failure){throw new AggregateError([error,failure],'DISPLAY_READER_RELEASE_FAILED');}}throw error;
      }finally{
        responseLease?.release();workspace.release();try{await releaseBitmap();}catch(error){this.cleanup.retain(releaseBitmap,error);throw new AggregateError(failed?[primary,error]:[error],'DISPLAY_BITMAP_RELEASE_FAILED',{cause:failed?primary:error});}
      }
    });
  }
}
