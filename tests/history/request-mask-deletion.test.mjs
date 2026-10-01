import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setup,call,cookieFrom,readHeaders,mutationHeaders} from '../protocol/helpers.mjs';
import {importRaster,operate,terminal,eventFor,binary} from '../raster/helpers.mjs';
import {startLocalServer} from '../../dist/local/server/http.js';

const documentId='document_1';
const pathFor=(f,ref)=>join(f.root,'objects','sha256',ref.hash.slice(7,9),ref.hash.slice(7));
async function retained(f,ref){
  const bytes=await readFile(pathFor(f,ref));
  assert.equal('sha256:'+createHash('sha256').update(bytes).digest('hex'),ref.hash);
  assert.equal(String(bytes.length),ref.byteLength);
  return bytes;
}
function query(f,sql,...params){
  const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});
  try{return db.prepare(sql).all(...params);}finally{db.close();}
}
async function edit(f,body){
  const current=(await f.read('/api/v1/documents/'+documentId)).json.projection.value;
  const result=await terminal(f,f.command({documentId,expectedDocumentRevision:current.revision,body}));
  assert.equal(result.json.receipt.status,'accepted',result.text);
  return {receipt:result.json.receipt,event:await eventFor(f,result.json.receipt)};
}
async function reopen(f,servers){
  const cookie=cookieFrom(f.paired);
  await f.server.close();
  const server=await startLocalServer({root:f.root});
  servers.push(server);
  const paired=await call(server.origin,'/api/v1/session/bootstrap',{method:'POST',headers:{Origin:server.origin,Cookie:cookie},body:{protocolVersion:1,pairingToken:new URL(server.issuePairingURL()).hash.slice(9)}});
  assert.equal(paired.status,200,paired.text);
  return {root:f.root,server,paired,
    read:path=>call(server.origin,path,{headers:readHeaders(cookieFrom(paired))}),
    post:(path,body)=>call(server.origin,path,{method:'POST',body,headers:mutationHeaders(server,paired)}),
    command:(patch={},body={})=>f.command({...patch,clientId:paired.json.clientId},body)};
}
async function noProviderWork(f){
  const queue=await f.read('/api/v1/queue');assert.equal(queue.status,200,queue.text);
  assert.deepEqual(queue.json.jobs,[]);
  assert.deepEqual(await readdir(join(f.root,'backend-transport')),[]);
  assert.deepEqual(query(f,'SELECT id FROM raster_preparations'),[]);
}

test('independent request mask ownership survives source deletion restart before and after garbage collection',async t=>{
  const servers=[];t.after(async()=>{for(const server of servers.toReversed())await server.close();});
  let f=await setup(t);servers.push(f.server);
  assert.equal((await terminal(f,f.command({}, {width:1,height:1}))).json.receipt.status,'accepted');
  const {input,asset}=await importRaster(f,'white.png');
  const originalBytes=await retained(f,input.blob),nativePixels=await retained(f,asset.raster.pixels);
  assert.deepEqual(nativePixels,Buffer.from([255,255,255,255]));
  await edit(f,{type:'ImportAsset',assetId:asset.id,layerId:'picture',name:'Opaque source',draft:null});
  const source=(await edit(f,{type:'PrepareRequestSource',scope:'single-layer',layerIds:['picture']})).event.payload.asset;
  const body={type:'PrepareRequestMask',sourceAssetId:source.id,plan:{width:1,height:1,feather:0,operations:[{kind:'shape',shape:{kind:'rectangle',x:0,y:0,width:1,height:1},mode:'replace'}]},clip:null};
  // A workspace command with no saved/attached draft must still belong to the
  // captured document for deletion; its null command.documentId cannot do that.
  const prepared=await operate(f,body),mask=prepared.event.payload.asset;
  assert.equal(prepared.command.command.documentId,null);
  assert.equal(prepared.command.command.expectedDocumentRevision,null);
  assert.equal((await f.read('/api/v1/assets/'+mask.id+'/raster')).json.plan.sourceAssetId,source.id);
  assert(query(f,'SELECT hash FROM roots WHERE owner=?','request-mask:'+documentId+':'+mask.id).length>0);
  await noProviderWork(f);

  const current=(await f.read('/api/v1/documents/'+documentId)).json.projection.value;
  await operate(f,{type:'PreviewDocumentDeletion',documentId,expectedRevision:current.revision});
  const preview=(await f.read('/api/v1/documents/'+documentId+'/deletion')).json.plan;
  assert.equal(preview.drafts,0);assert.equal(preview.jobs,0);
  await operate(f,{type:'DeleteDocument',documentId,planId:preview.id,planHash:preview.planHash,expectedRevision:preview.documentRevision,rootGeneration:preview.rootGeneration,acknowledgeRunningAndUncertain:true});
  assert.deepEqual(query(f,'SELECT hash FROM roots WHERE owner=?','request-mask:'+documentId+':'+mask.id),[]);
  await retained(f,source.raster.manifest);
  await retained(f,mask.raster.manifest);

  // Reopen while the deleted graph's bytes still exist. Bootstrap must not
  // mistake its deliberately released roots for a corrupt live raster graph.
  f=await reopen(f,servers);
  assert.equal((await f.read('/api/v1/documents/'+documentId)).status,404);
  assert.equal((await f.read('/api/v1/documents/'+documentId+'/deletion')).json.receipt.status,'cleanup-pending');
  const rejected=await terminal(f,f.command({documentId:null,expectedDocumentRevision:null,body}));
  assert.equal(rejected.json.receipt.status,'rejected',rejected.text);
  assert.equal(rejected.json.receipt.code,'STALE_REVISION',rejected.text);
  assert.match((await retained(f,rejected.json.receipt.details)).toString(),/DOCUMENT_DELETED/);
  await noProviderWork(f);

  await operate(f,{type:'CollectDocumentGarbage',documentId});
  const cleaned=(await f.read('/api/v1/documents/'+documentId+'/deletion')).json.receipt;
  assert.equal(cleaned.status,'cleanup-complete');assert.equal(cleaned.pendingBytes,'0');
  assert(BigInt(cleaned.actualFreedBytes)>0n);
  await assert.rejects(readFile(pathFor(f,source.raster.manifest)),{code:'ENOENT'});
  await assert.rejects(readFile(pathFor(f,mask.raster.manifest)),{code:'ENOENT'});

  f=await reopen(f,servers);
  assert.equal((await f.read('/api/v1/documents/'+documentId)).status,404);
  assert.deepEqual((await f.read('/api/v1/documents/'+documentId+'/deletion')).json.receipt,cleaned);
  const unavailable=await terminal(f,f.command({documentId:null,expectedDocumentRevision:null,body}));
  assert.equal(unavailable.json.receipt.status,'rejected',unavailable.text);
  assert.equal(unavailable.json.receipt.code,'MISSING_ASSET',unavailable.text);
  assert.match((await retained(f,unavailable.json.receipt.details)).toString(),/REQUEST_SOURCE_CAPTURE_UNAVAILABLE/);
  // Independent originals and native rasters retain their own roots and exact
  // bytes even when a deleted capture referenced the same opaque pixel bytes.
  assert.deepEqual((await f.read('/api/v1/assets/'+input.id)).json.projection.value,input);
  assert.deepEqual((await f.read('/api/v1/assets/'+asset.id)).json.projection.value,asset);
  assert.equal(input.qualification,'pending-decoder');assert.equal(input.safety,'unknown');
  assert.equal((await binary(f,input.id)).status,403,'Retained encoded originals remain unavailable through the approved-content route');
  assert.deepEqual(await retained(f,input.blob),originalBytes);
  const content=await binary(f,asset.id);assert.equal(content.status,200);assert.deepEqual(content.bytes,await retained(f,asset.blob));
  assert.deepEqual(await retained(f,asset.raster.pixels),nativePixels);
  assert.equal((await f.read('/api/v1/assets/'+asset.id+'/raster')).status,200);
  await noProviderWork(f);
});
