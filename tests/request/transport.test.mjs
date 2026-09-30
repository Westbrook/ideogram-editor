import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,realpath,readFile,rm,access,writeFile} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {randomUUID,createHash} from 'node:crypto';import {transformWithOxc} from 'vite';
import {openWriter} from '../../dist/local/server/storage/writer.js';import {startLocalServer} from '../../dist/local/server/http.js';import {EMPTY_EXPECTED_VERSIONS} from '../../dist/local/src/protocol/store.js';import {command,encode} from '../store/helpers.mjs';import {pair,cookieFrom} from '../session/helpers.mjs';
const code=(await transformWithOxc(await readFile('tests/request/persistence-witness.ts','utf8'),'persistence-witness.ts')).code;
const {publicReadRequest}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
test('shared witness construction obeys actual authenticated checkpoint/content GET and document HEAD boundaries',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'p22-public-read-')),text='Public read fixture Café 東京',bytes=Buffer.from(text),hash='sha256:'+createHash('sha256').update(bytes).digest('hex');let writer,server;const results=[];let closed=false,removed=false;
 try{
  // Seed through the existing isolated writer, not through the transport under test.
  writer=await openWriter({root});await writer.protocolDefaults();assert.equal((await writer.submit(encode(command(EMPTY_EXPECTED_VERSIONS,{}, {width:3,height:2})),writer.epoch)).status,'accepted');
  const auth={clientId:'client_1',sessionHash:'a'.repeat(64),expires:Date.now()+60000,now:Date.now()},stagingId=randomUUID();
  await writer.assetCreate({protocolVersion:1,stagingId,purpose:'caption',expectedBytes:String(bytes.length),sha256:hash,mediaType:'text/plain'},auth);
  const token=await writer.assetBeginChunk(stagingId,'0',bytes.length,auth);await writer.assetChunk(token,bytes,auth);
  const finalize=command(EMPTY_EXPECTED_VERSIONS,{documentId:null,body:{type:'FinalizeStaging',stagingId,expectedSha256:hash}});await writer.assetCommand(encode(finalize),auth);let terminal;
  for(let i=0;i<200&&!terminal;i++){terminal=await writer.lookup(finalize.command.commandId);if(!terminal)await new Promise(resolve=>setTimeout(resolve,5));}assert.equal(terminal?.receipt.status,'accepted');
  const asset=(await writer.events('0')).events.find(e=>e.payload.asset)?.payload.asset;assert(asset);await writer.close();writer=undefined;
  server=await startLocalServer({root});const paired=await pair(server);assert.equal(paired.status,200);const cookie=cookieFrom(paired);
  for(const [path,method,kind]of [['/api/v1/ui/transport_fixture','GET','checkpoint'],['/api/v1/assets/'+asset.id+'/content','GET','content'],['/api/v1/documents/document_1','HEAD','version']]){
   const request=publicReadRequest(path,method);assert.deepEqual(request.init,{method,headers:{'X-App-Client':'LP-1'},credentials:'same-origin',cache:'no-store',redirect:'error'});assert(!('body'in request.init));
   for(const marker of ['valid','missing','wrong']){
    const headers={...request.init.headers,Cookie:cookie,'Sec-Fetch-Site':'same-origin'};if(marker==='missing')delete headers['X-App-Client'];if(marker==='wrong')headers['X-App-Client']='wrong';assert(!('Origin'in headers));
    const response=await fetch(server.origin+request.path,{...request.init,headers}),body=await response.text();results.push({method,path,marker,status:response.status,cacheControl:response.headers.get('cache-control')});
    assert.equal(response.status,marker==='valid'?200:403,kind+' '+marker);assert.equal(response.headers.get('cache-control'),'no-store');
    if(marker==='valid'){if(kind==='checkpoint')assert.equal(JSON.parse(body).sessionId,'transport_fixture');if(kind==='content')assert.equal(body,text);if(kind==='version'){assert.equal(response.headers.get('X-App-Entity-Version'),'1');assert.equal(body,'');}}
    else if(method==='GET')assert.equal(JSON.parse(body).error.code,'ORIGIN_DENIED');
   }
  }
 }finally{await writer?.close();await server?.close();closed=true;await rm(root,{recursive:true,force:true});removed=true;await assert.rejects(access(root));if(process.env.TRANSPORT_RECEIPT)await writeFile(process.env.TRANSPORT_RECEIPT,JSON.stringify({results,fixture:{closed,removed},scope:'One ordinary pairing bootstrap; seed uses the local writer; all nine transport-under-test calls are GET/HEAD, no forged Origin or external call.'},null,2));}
 assert.equal(results.length,9);
});
