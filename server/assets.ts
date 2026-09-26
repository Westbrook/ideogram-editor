import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Session } from './sessions.js';
import type { Writer } from './storage/writer.js';
import { isId, isSeq } from './storage/canonical.js';
import { ProtocolError } from './errors.js';
import { parseControlJSON, readControlBytes } from './control-json.js';
import { sendJSON } from './protocol.js';
import type { AssetAuth } from './storage/assets.js';
export type AssetRoute={allow:string[];kind:string;id?:string;query:string[]};
export class AssetRoutes {
  private streams=0;
  constructor(private writer:Writer,private now:()=>number){}
  auth(s:Session):AssetAuth{return {clientId:s.clientId,sessionHash:s.cookieHash,expires:s.expires,now:this.now()};}
  match(path:string):AssetRoute|null {
    if(path==='/api/v1/assets/staging')return {allow:['POST'],kind:'asset-create',query:[]};
    if(path==='/api/v1/assets/staging/recovery')return {allow:['GET'],kind:'asset-inventory',query:['cursor']};
    let m=/^\/api\/v1\/assets\/staging\/transfer-reviews\/([^/]+)$/.exec(path);
    if(m){if(!isId(m[1]))throw new ProtocolError('MALFORMED_REQUEST');return {allow:['GET'],kind:'asset-review',id:m[1],query:[]};}
    m=/^\/api\/v1\/assets\/staging\/([^/]+)(\/finalize)?$/.exec(path);
    if(m){if(!isId(m[1]))throw new ProtocolError('MALFORMED_REQUEST');return {allow:m[2]?['POST']:['GET','PUT'],kind:m[2]?'asset-finalize':'asset-stage',id:m[1],query:[]};}
    m=/^\/api\/v1\/assets\/([^/]+)(\/content)?$/.exec(path);
    if(m){if(!isId(m[1])||['staging','transfer-reviews','recovery'].includes(m[1]))throw new ProtocolError('NOT_FOUND');return {allow:m[2]?['GET','HEAD']:['GET'],kind:m[2]?'asset-content':'asset-view',id:m[1],query:[]};}
    return null;
  }
  async handle(req:IncomingMessage,res:ServerResponse,route:AssetRoute,params:URLSearchParams,authenticate:()=>Session,assertRoot:()=>Promise<void>){
    const auth=()=>this.auth(authenticate());const id=route.id!;
    if(route.kind==='asset-create'){const value=parseControlJSON(await readControlBytes(req));await assertRoot();const result=await this.writer.assetCreate(value,auth());authenticate();sendJSON(res,result.created?201:200,result.record);}
    else if(route.kind==='asset-inventory'){const cursor=params.get('cursor');if(cursor!==null&&!isId(cursor))throw new ProtocolError('MALFORMED_REQUEST');const result=await this.writer.assetInventory(cursor,auth());authenticate();sendJSON(res,200,result);}
    else if(route.kind==='asset-review'){const result=await this.writer.assetReview(id,auth());authenticate();sendJSON(res,200,result);}
    else if(route.kind==='asset-stage'&&req.method==='GET'){const result=await this.writer.assetGet(id,auth());authenticate();sendJSON(res,200,result);}
    else if(route.kind==='asset-stage'){
      if(req.headers['content-type']!=='application/octet-stream'||req.headers['content-encoding']!==undefined)throw new ProtocolError('MEDIA_TYPE');
      const offset=req.headers['upload-offset'];const length=req.headers['content-length'];
      if(typeof offset!=='string'||!isSeq(offset)||typeof length!=='string'||!isSeq(length)||(req.headersDistinct['upload-offset']?.length??0)!==1)throw new ProtocolError('MALFORMED_REQUEST');
      if(BigInt(length)>1048576n)throw new ProtocolError('PAYLOAD_TOO_LARGE');
      const token=await this.writer.assetBeginChunk(id,offset,Number(length),auth());
      try{
        const bytes=Buffer.alloc(Number(length));let at=0;let checkedAt=this.now();req.setTimeout(30000,()=>req.destroy());
        for await(const chunk of req){authenticate();if(this.now()-checkedAt>=30000){await assertRoot();await this.writer.assetCheckChunk(token,auth());checkedAt=this.now();}if(at+chunk.length>bytes.length)throw new ProtocolError('PAYLOAD_TOO_LARGE');bytes.set(chunk,at);at+=chunk.length;}
        if(at!==bytes.length)throw new ProtocolError('MALFORMED_REQUEST');await assertRoot();const result=await this.writer.assetChunk(token,bytes,auth());authenticate();sendJSON(res,200,result);
      }finally{await this.writer.assetAbortChunk(token);}
    }else if(route.kind==='asset-view'){const view=await this.writer.assetProjection(id);if(!view.asset)throw new ProtocolError('NOT_FOUND');authenticate();sendJSON(res,200,{protocolVersion:1,entityVersion:view.asset.version,projectionSchema:2,highWater:view.highWater,projection:{kind:'inline',value:view.asset}});}
    else if(route.kind==='asset-content')await this.content(req,res,id,authenticate,assertRoot);
  }
  private async content(req:IncomingMessage,res:ServerResponse,id:string,authenticate:()=>Session,assertRoot:()=>Promise<void>){
    if(this.streams>=16)throw new ProtocolError('LOCAL_BUSY',undefined,'read-or-transfer');this.streams++;
    let handle:string|undefined;
    try {
      authenticate();const verified=await this.writer.assetVerify(id);handle=verified.handle;const asset=verified.asset;authenticate();const ref=asset.blob;const total=BigInt(ref.byteLength);let start=0n;let end=total-1n;let status=200;const etag='"'+ref.hash+'"';
      if((req.headersDistinct.range?.length??0)>1||(req.headersDistinct['if-range']?.length??0)>1)throw new ProtocolError('MALFORMED_REQUEST');
      const range=req.headers.range;if(range!==undefined){
        const bad=():never=>{res.setHeader('Content-Range','bytes */'+total);throw new ProtocolError('RANGE_NOT_SATISFIABLE',{kind:'range',byteLength:ref.byteLength},'read-or-transfer');};
        const m=/^bytes=(\d*)-(\d*)$/.exec(range);if(!m||(!m[1]&&!m[2]))bad();
        if(m![1]){start=BigInt(m![1]);end=m![2]?BigInt(m![2]):end;if(end>=total)end=total-1n;}else{const n=BigInt(m![2]);start=n<total?total-n:0n;if(!n)start=total;}
        if(start>end||start>=total)bad();status=206;
        if(req.headers['if-range']!==undefined&&req.headers['if-range']!==etag){status=200;start=0n;end=total-1n;}
      }
      res.writeHead(status,{'Content-Type':asset.measuredMediaType,'Content-Disposition':'attachment; filename="asset.txt"','X-Content-Type-Options':'nosniff','Cache-Control':'no-store',ETag:etag,'Accept-Ranges':'bytes','Content-Length':String(end-start+1n),...(status===206?{'Content-Range':`bytes ${start}-${end}/${total}`}:{})});
      if(req.method==='HEAD'){res.end();return;}
      for(let at=start;at<=end;){await assertRoot();authenticate();const n=Number(end-at+1n>32768n?32768n:end-at+1n);const bytes=await this.writer.assetContent(id,handle,String(at),n);authenticate();if(res.destroyed)return;await new Promise<void>((resolve,reject)=>res.write(bytes,e=>e?reject(e):resolve()));at+=BigInt(n);}res.end();
    }finally{if(handle)await this.writer.assetRelease(handle);this.streams--;}
  }
}
