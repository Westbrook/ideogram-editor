import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Writer } from './storage/writer.js';
import type { Session } from './sessions.js';
import { ProtocolError } from './errors.js';
import { isId } from './storage/canonical.js';
import { sendJSON } from './protocol.js';
import type { AssetRoute } from './assets.js';
export class PortableRoutes {
  private streams=0;
  constructor(private writer:Writer,private now:()=>number){}
  private auth(s:Session){return {clientId:s.clientId,sessionHash:s.cookieHash,expires:Math.min(s.expires,s.idle),now:this.now()};}
  match(path:string):AssetRoute|null {
    if(path==='/api/v1/bundles/recovery')return {allow:['GET'],kind:'portable-inventory',query:['after']};
    const m=/^\/api\/v1\/(bundles|bundle-reviews)\/([^/]+)(\/(?:content|mapping))?$/.exec(path);
    if(!m)return null;if(!isId(m[2])||m[1]==='bundle-reviews'&&m[3]==='/content'||m[1]==='bundles'&&m[3]==='/mapping')throw new ProtocolError('MALFORMED_REQUEST');
    if(m[3]==='/mapping')return {allow:['GET'],kind:'bundle-mapping',id:m[2],query:['kind','after']};
    return {allow:m[3]?['GET','HEAD']:['GET'],kind:m[3]?'bundle-content':m[1]==='bundles'?'bundle':'bundle-review',id:m[2],query:[]};
  }
  async handle(req:IncomingMessage,res:ServerResponse,route:AssetRoute,params:URLSearchParams,authenticate:()=>Session,assertRoot:()=>Promise<void>){
    const auth=this.auth(authenticate());let value;
    if(route.kind==='bundle-content'){await this.content(req,res,route.id!,authenticate,assertRoot);return;}
    if(route.kind==='bundle-mapping')value=await this.writer.bundleMapping(route.id!,params.get('kind')??'document',params.get('after')??'',auth);
    else if(route.kind==='bundle')value=await this.writer.bundle(route.id!,auth);
    else if(route.kind==='bundle-review')value=await this.writer.bundleReview(route.id!,auth);
    else value=await this.writer.portableInventory(params.get('after')??'',auth);
    authenticate();sendJSON(res,200,value);
  }
  private async content(req:IncomingMessage,res:ServerResponse,id:string,authenticate:()=>Session,assertRoot:()=>Promise<void>){
    if(this.streams>=16)throw new ProtocolError('LOCAL_BUSY',undefined,'read-or-transfer');this.streams++;
    let handle:string|undefined;
    try {
      authenticate();const verified=await this.writer.bundleVerify(id,this.auth(authenticate()));handle=verified.handle;authenticate();const ref=verified.bundle.blob;const total=BigInt(ref.byteLength);let start=0n;let end=total-1n;let status=200;const etag='"'+ref.hash+'"';
      if((req.headersDistinct.range?.length??0)>1||(req.headersDistinct['if-range']?.length??0)>1)throw new ProtocolError('MALFORMED_REQUEST');
      const range=req.headers.range;if(range!==undefined){
        const bad=():never=>{res.setHeader('Content-Range','bytes */'+total);throw new ProtocolError('RANGE_NOT_SATISFIABLE',{kind:'range',byteLength:ref.byteLength},'read-or-transfer');};
        const m=/^bytes=(\d*)-(\d*)$/.exec(range);if(!m||(!m[1]&&!m[2]))bad();
        if(m![1]){start=BigInt(m![1]);end=m![2]?BigInt(m![2]):end;if(end>=total)end=total-1n;}else{const n=BigInt(m![2]);start=n<total?total-n:0n;if(!n)start=total;}
        if(start>end||start>=total)bad();status=206;
        if(req.headers['if-range']!==undefined&&req.headers['if-range']!==etag){status=200;start=0n;end=total-1n;}
      }
      res.writeHead(status,{'Content-Type':'application/x-ideogram-project','Content-Disposition':'attachment; filename="project.ideogram-project"','Content-Security-Policy':"sandbox; default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",'X-Content-Type-Options':'nosniff','Cache-Control':'no-store',ETag:etag,'Accept-Ranges':'bytes','Content-Length':String(end-start+1n),...(status===206?{'Content-Range':`bytes ${start}-${end}/${total}`}:{})});
      if(req.method==='HEAD'){res.end();return;}
      for(let at=start;at<=end;){await assertRoot();authenticate();const n=Number(end-at+1n>32768n?32768n:end-at+1n);const bytes=await this.writer.bundleContent(handle,String(at),n,this.auth(authenticate()));authenticate();if(res.destroyed)return;await new Promise<void>((resolve,reject)=>res.write(bytes,e=>e?reject(e):resolve()));at+=BigInt(n);}res.end();
    }finally{if(handle)await this.writer.bundleRelease(handle);this.streams--;}
  }
}
