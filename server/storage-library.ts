import type {IncomingMessage,ServerResponse} from 'node:http';
import type {Session} from './sessions.js';
import type {Writer} from './storage/writer.js';
import type {AssetAuth} from './storage/assets.js';
import {STORAGE_RESPONSE_BYTES,STORAGE_CATEGORIES,validateStorageCacheClearRequest,type StorageCategory} from '../src/protocol/storage.js';
import {CONTROL_BYTES,parseControlJSON} from './control-json.js';
import {ProtocolError} from './errors.js';
import {isId} from './storage/canonical.js';
import {sendCompositionJSON} from './composition-memory.js';
import type {StorageRead} from './storage-reads.js';
/** Called only inside an admitted storage operation. A fixed CONTROL buffer
 * avoids retaining an array of arbitrarily fragmented request chunks. */
async function storageBody(request:IncomingMessage){
  if(!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(request.headers['content-type']??'')||request.headers['content-encoding']!==undefined)throw new ProtocolError('MEDIA_TYPE');
  const length=request.headers['content-length'];if(length!==undefined&&(!/^(0|[1-9][0-9]*)$/.test(length)||BigInt(length)>BigInt(CONTROL_BYTES)))throw new ProtocolError(!/^(0|[1-9][0-9]*)$/.test(length)?'MALFORMED_REQUEST':'PAYLOAD_TOO_LARGE');
  const bytes=Buffer.alloc(CONTROL_BYTES);let size=0;
  for await(const chunk of request.iterator({destroyOnReturn:false})){if(size+chunk.length>bytes.length)throw new ProtocolError('PAYLOAD_TOO_LARGE');bytes.set(chunk,size);size+=chunk.length;}
  if(Object.keys(request.trailers).length)throw new ProtocolError('MALFORMED_REQUEST');return parseControlJSON(bytes.subarray(0,size));
}
type Route={allow:string[];kind:string;id?:string;query:string[]};
export class StorageLibraryRoutes {
  constructor(private writer:Writer,private now:()=>number){}
  private auth(s:Session):AssetAuth{return {clientId:s.clientId,sessionHash:s.cookieHash,expires:Math.floor(Math.min(s.expires,s.idle)),now:Math.floor(this.now())};}
  match(path:string):Route|null{
    if(path==='/api/v1/storage')return {allow:['GET'],kind:'storage-summary',query:[]};
    if(path==='/api/v1/storage/assets')return {allow:['GET'],kind:'storage-assets',query:['category','cursor']};
    if(path==='/api/v1/storage/preview-cache/clear')return {allow:['POST'],kind:'storage-clear',query:[]};
    const dependency=/^\/api\/v1\/storage\/assets\/([^/]+)\/dependencies$/.exec(path);
    if(dependency){if(!isId(dependency[1]))throw new ProtocolError('MALFORMED_REQUEST');return {allow:['GET'],kind:'storage-dependencies',id:dependency[1],query:['cursor']};}
    const restore=/^\/api\/v1\/storage\/assets\/([^/]+)\/relink$/.exec(path);
    if(restore){if(!isId(restore[1]))throw new ProtocolError('MALFORMED_REQUEST');return {allow:['POST'],kind:'storage-repair',id:restore[1],query:[]};}
    const repair=/^\/api\/v1\/storage\/assets\/([^/]+)\/relink\/([a-f0-9]{64})$/.exec(path);
    if(repair){if(!isId(repair[1]))throw new ProtocolError('MALFORMED_REQUEST');return {allow:['GET'],kind:'storage-relink',id:repair[1]+':'+repair[2],query:[]};}
    return null;
  }
  async handle(request:IncomingMessage,response:ServerResponse,route:Route,params:URLSearchParams,authenticate:()=>Session,assertRoot:()=>Promise<void>){
    const auth=()=>this.auth(authenticate());let result:StorageRead<unknown>|undefined;const cursor=params.get('cursor');
    if(cursor!==null&&!isId(cursor))throw new ProtocolError('MALFORMED_REQUEST');
    try{if(route.kind==='storage-clear'){
      result=await this.writer.storageClear(async()=>{try{validateStorageCacheClearRequest(await storageBody(request));}catch(error){if(error instanceof ProtocolError)throw error;throw new ProtocolError('MALFORMED_REQUEST');}await assertRoot();return auth();});
    }else if(route.kind==='storage-repair'){result=await this.writer.storageRepair(route.id!,async()=>{const value=await storageBody(request);await assertRoot();return {value,auth:auth()};});
    }else if(route.kind==='storage-summary')result=await this.writer.storageSummary(auth());
    else if(route.kind==='storage-assets'){
      const category=params.get('category');if(!STORAGE_CATEGORIES.includes(category as StorageCategory))throw new ProtocolError('MALFORMED_REQUEST');result=await this.writer.storageAssets(category as StorageCategory,cursor,auth());
    }else if(route.kind==='storage-dependencies')result=await this.writer.storageDependencies(route.id!,cursor,auth());
    else if(route.kind==='storage-relink'){const [id,hash]=route.id!.split(':');result=await this.writer.storageRepairReview(id!,'sha256:'+hash!,auth());}
    else throw new ProtocolError('NOT_FOUND');
    authenticate();await sendCompositionJSON(response,result.value,STORAGE_RESPONSE_BYTES,result,async()=>{await assertRoot();authenticate();});
    }finally{await result?.release();}
  }
}
