import { mkdir, writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { startLocalServer } from './source/dist/local/server/http.js';
import { command as makeCommand } from './source/tests/store/helpers.mjs';
import { EMPTY_EXPECTED_VERSIONS } from './source/dist/local/src/protocol/store.js';
import { call,pair,cookieFrom,readHeaders,mutationHeaders,exchange } from './source/tests/session/helpers.mjs';
export { call,pair,cookieFrom,readHeaders,mutationHeaders,exchange,DatabaseSync,join,randomUUID,startLocalServer };
export const hash=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
export const facts=[];
export async function record(id,value){facts.push({id,...value});await writeFile(new URL('./independent-facts.json',import.meta.url),JSON.stringify(facts,null,2));}
export async function fixture(t,name,options={},testing){const root=resolve('roots',name+'-'+randomUUID());await mkdir(root,{recursive:true,mode:0o700});const server=await startLocalServer({root,...options},testing);let paired=await pair(server);t.after(()=>server.close());return {root,server,get paired(){return paired},set paired(x){paired=x},read(path,extra={}){return call(server.origin,path,{headers:{...readHeaders(cookieFrom(paired)),...extra}})},post(path,body,extra={}){return call(server.origin,path,{method:'POST',body,headers:{...mutationHeaders(server,paired),...extra}})},command(body,patch={}){return makeCommand(EMPTY_EXPECTED_VERSIONS,{clientId:paired.json.clientId,documentId:null,expectedDocumentRevision:null,body,...patch})}}}
export async function create(f,bytes,extra={}){const s={protocolVersion:1,stagingId:randomUUID(),purpose:'caption',expectedBytes:String(bytes.length),sha256:hash(bytes),mediaType:'text/plain',...extra};const r=await f.post('/api/v1/assets/staging',s);if(r.status!==201)throw Error(r.text);return s;}
export const put=(f,s,b,offset='0',paired=f.paired)=>call(f.server.origin,'/api/v1/assets/staging/'+s.stagingId,{method:'PUT',raw:b,headers:{...mutationHeaders(f.server,paired),'Content-Type':'application/octet-stream','Upload-Offset':offset}});
export async function upload(f,b,extra={}){const s=await create(f,b,extra);for(let at=0;at<b.length;at+=1048576){const r=await put(f,s,b.subarray(at,at+1048576),String(at));if(r.status!==200)throw Error(r.text);}return s;}
export async function terminal(f,c){let r;for(let i=0;i<600;i++){r=await f.read('/api/v1/commands/'+c.command.commandId);if(r.status!==202)return r;await new Promise(r=>setTimeout(r,5));}throw Error('Pending timeout '+r.text);}
export async function finish(f,s){const c=f.command({type:'FinalizeStaging',stagingId:s.stagingId,expectedSha256:s.sha256});const admission=await f.post('/api/v1/commands',c);const r=admission.status===202?await terminal(f,c):admission;return {c,r,admission};}
export async function assetFor(f,r){const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});try{return JSON.parse(db.prepare('SELECT json FROM events_v2 WHERE seq=?').get(r.json.receipt.fromSeq).json).payload.asset;}finally{db.close();}}
export async function heldUpload(f,label){const s=await create(f,Buffer.from('abc'));const req=exchange(f.server.origin,'/api/v1/assets/staging/'+s.stagingId,{method:'PUT',defer:true,headers:{...mutationHeaders(f.server,f.paired),'Content-Type':'application/octet-stream','Content-Length':3,'Upload-Offset':'0'}});req.response.catch(()=>{});req.request.flushHeaders();req.request.write('a');await new Promise(r=>setTimeout(r,20));return {...req,s};}
