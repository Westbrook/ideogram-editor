import {allocationLedger} from './allocations.js';

const PREVIEW_LIMIT=128*1024*1024,PART_BYTES=64*1024;
type PreviewOptions={owner:string;maxBytes?:number;expectedBytes?:number;previewCache?:boolean;signal?:AbortSignal;owns?:()=>boolean};
type PreviewLease=ReturnType<typeof allocationLedger.reserve>;
const urls=new Map<string,PreviewLease>();

/** Encoded, response-backed bytes only. Browser image decoding and GPU storage
 * are opaque and are not represented as known allocations by this helper. */
export type OwnedPreview={readonly blob:Blob;createURL():string;release():void};

/** Reserve before reading. Staging includes the encoded backing plus an equally
 * large copy allowance and one bounded assembly slab. The copy allowance
 * covers one admitted incoming stream chunk while encoded parts are retained;
 * engine-owned network buffers and physical Blob residency remain unknown. Small responses reserve
 * their declared size; an unknown length must fit the explicit preview bound. */
export async function readOwnedPreviewResponse(response:Response,options:PreviewOptions):Promise<OwnedPreview>{
 let lease:PreviewLease|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
 const check=()=>{if(options.signal?.aborted||options.owns&&!options.owns())throw Error('Preview loading was superseded.');};
 const abort=()=>{void reader?.cancel().catch(()=>{});};
 try{
  check();const max=options.maxBytes??PREVIEW_LIMIT,header=response.headers.get('content-length');
  if(!Number.isSafeInteger(max)||max<0||max>PREVIEW_LIMIT)throw Error('PREVIEW_CAPACITY: Invalid preview byte limit.');
  if(header!==null&&!/^(0|[1-9][0-9]*)$/.test(header))throw Error('Preview content length is invalid.');
  const declared=header===null?undefined:Number(header),expected=options.expectedBytes??declared;
  if(expected!==undefined&&(!Number.isSafeInteger(expected)||expected<0||expected>max)||declared!==undefined&&(!Number.isSafeInteger(declared)||declared>max)||options.expectedBytes!==undefined&&declared!==undefined&&declared!==options.expectedBytes)throw Error('PREVIEW_CAPACITY: Preview content length exceeds its reserved bound or differs from its asset.');
  const bound=expected??max,slabBytes=Math.min(PART_BYTES,bound);
  lease=allocationLedger.reserve({owner:options.owner,kind:'blob',cpuBytes:2*bound+slabBytes,previewCacheBytes:options.previewCache===false?0:bound,handles:1});
  if(!response.body)throw Error('Preview content is unavailable.');
  reader=response.body.getReader();options.signal?.addEventListener('abort',abort,{once:true});check();
  const parts:Blob[]=[];let slab=new Uint8Array(slabBytes),used=0,total=0;
  for(;;){
   check();const part=await reader.read();check();if(part.done)break;
   if(part.value.byteLength>bound-total)throw Error('PREVIEW_CAPACITY: Preview content exceeds its reserved bound.');
   total+=part.value.byteLength;
   for(let offset=0;offset<part.value.byteLength;){const count=Math.min(slab.length-used,part.value.byteLength-offset);slab.set(part.value.subarray(offset,offset+count),used);used+=count;offset+=count;if(used===slab.length){lease.resize({handles:parts.length+2});parts.push(new Blob([slab]));used=0;}}
  }
  if(expected!==undefined&&total!==expected)throw Error('Preview content is incomplete.');
  if(used){lease.resize({handles:parts.length+2});parts.push(new Blob([slab.subarray(0,used)]));}
  check();lease.resize({handles:parts.length+2});let blob:Blob|null=new Blob(parts,{type:response.headers.get('content-type')?.split(';')[0]??''});parts.length=0;slab=new Uint8Array(0);
  lease.resize({cpuBytes:blob.size,previewCacheBytes:options.previewCache===false?0:blob.size,handles:2});
  // Finish native reader ownership before transferring the backing to a caller.
  // A failed unlock must not suppress the return after losing its lease owner.
  reader.releaseLock();reader=undefined;lease.resize({handles:1});
  const owned=lease;lease=undefined;let state:'owned'|'transferred'|'released'='owned';
  return {get blob(){if(!blob)throw Error('Preview backing has already been transferred or released.');return blob;},createURL(){if(state!=='owned'||!blob)throw Error('Preview backing has already been transferred or released.');check();const url=URL.createObjectURL(blob);urls.set(url,owned);state='transferred';blob=null;return url;},release(){if(state==='owned'){state='released';blob=null;owned.release();}}};
 }catch(error){if(reader)await reader.cancel().catch(()=>{});else await response.body?.cancel().catch(()=>{});throw error;}
 finally{options.signal?.removeEventListener('abort',abort);if(reader)try{reader.releaseLock();}catch(error){lease?.markUnused();throw error;}lease?.release();}
}

export async function createOwnedPreviewURL(response:Response,options:PreviewOptions):Promise<string>{const preview=await readOwnedPreviewResponse(response,options);try{return preview.createURL();}finally{preview.release();}}

/** Only the creator may transfer a URL into this map. Repeated cleanup cannot
 * release another owner's allocation or revoke a later, unrelated URL. */
export function revokeOwnedPreviewURL(url:string){const lease=urls.get(url);if(!lease)return;try{URL.revokeObjectURL(url);}catch(error){lease.markUnused();throw error;}urls.delete(url);lease.release();}
