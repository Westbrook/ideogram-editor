import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture,prepare,enqueue,envelope,encode,auth} from '../queue/helpers.mjs';
import {StoreDatabase} from '../../dist/local/server/storage/database.js';
import {acquireRoot} from '../../dist/local/server/storage/ownership.js';
import {QueueDispatcher} from '../../dist/local/server/provider/dispatcher.js';
import {emulator,fixtureProfile,SENTINEL_KEY} from './emulator.mjs';
import {egressAttempts} from './no-egress.mjs';

const digest=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const objectPath=(root,ref)=>join(root,'objects/sha256',ref.hash.slice(7,9),ref.hash.slice(7));

async function finish(writer,command,method){
 await writer[method](encode(command),auth());
 let record;
 for(let i=0;i<1000&&!record;i++){
  record=await writer.lookup(command.command.commandId);
  if(!record)await new Promise(resolve=>setTimeout(resolve,5));
 }
 assert.equal(record?.receipt.status,'accepted',JSON.stringify(record));
 return (await writer.events(String(BigInt(record.receipt.fromSeq)-1n))).events.find(event=>event.commandId===command.command.commandId);
}

async function sourceAsset(writer){
 const bytes=await readFile('tests/raster/fixtures/hidden-alpha.png'),sha256=digest(bytes),stagingId=randomUUID();
 await writer.assetCreate({protocolVersion:1,stagingId,purpose:'image',expectedBytes:String(bytes.length),sha256,mediaType:'image/png'},auth());
 const token=await writer.assetBeginChunk(stagingId,'0',bytes.length,auth());
 await writer.assetChunk(token,bytes,auth());
 const original=(await finish(writer,envelope({type:'FinalizeStaging',stagingId,expectedSha256:sha256}),'assetCommand')).payload.asset;
 const preview=(await finish(writer,envelope({type:'PrepareRaster',assetId:original.id}),'rasterCommand')).payload.asset;
 const reviewId=(await finish(writer,envelope({type:'ReviewRaster',assetId:preview.id}),'rasterCommand')).payload.reviewId;
 const review=await writer.rasterReview(reviewId,auth());
 return (await finish(writer,envelope({type:'ApproveRaster',assetId:preview.id,reviewId,reviewHash:review.reviewHash}),'rasterCommand')).payload.asset;
}

async function owned(f){
 await f.close();
 const owner=await acquireRoot(f.root),db=new StoreDatabase(f.root,()=>{});
 let closed=false;
 return {db,async close(){
  if(closed)return;
  closed=true;
  await db.candidates.close();await db.queue.close();await db.portables.close();
  await db.histories.close();await db.rasters.close();await db.assets.close();
  await db.recovery.settle();db.close();owner.close();
 }};
}

test('owned transform staging uploads through the real two-slot storage pool and replaces the source URL',async t=>{
 const cleanup=[],sockets=new Set(),effects=[],serverErrors=[];
 let owner,server,dispatcher,origin='';
 // Close the direct owner before the queue helper archives its private fixture.
 t.after(async()=>{
  dispatcher?.close();
  if(server?.listening){
   const closed=new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
   for(const socket of sockets)socket.destroy();
   await closed;
  }
  await owner?.close();
  for(const close of cleanup)await close();
  assert.deepEqual(serverErrors,[]);
  assert.deepEqual(egressAttempts(),[]);
 });
 const f=await fixture({name:t.name,after:close=>cleanup.push(close)},{width:3,height:2});
 const asset=await sourceAsset(f.writer),document=await f.writer.document('document_1');
 const prepared=await prepare(f.writer,draft=>{
  draft.operation='transform';
  draft.source={assetId:asset.id,version:asset.version,blob:asset.blob,pixels:asset.raster.pixels,width:3,height:2,scope:'asset',documentRevision:document.revision};
  draft.fields.width='6';draft.fields.height='4';draft.fields.strength='0.8';
  draft.conversion={from:{width:3,height:2},to:{width:6,height:4},mapping:'stretch',approved:true};
 });
 const queued=await enqueue(f.writer,prepared.body),stage=queued.job.stagePlan[0];
 assert.equal(queued.job.stagePlan.length,1);assert.equal(stage.role,'source');
 assert.notEqual(stage.transport.hash,stage.original.hash,'the upload must use the approved resized transport');
 const expected=await readFile(objectPath(f.root,stage.transport));
 assert.equal(digest(expected),stage.transport.hash);
 assert.equal(String(expected.length),stage.transport.byteLength);
 const template=JSON.parse(await readFile(objectPath(f.root,queued.job.review.template),'utf8'));
 assert.equal(template.image_url,'asset:'+asset.blob.hash);
 owner=await owned(f);
 const objects=owner.db.objects,acquire=objects.acquire.bind(objects),prove=objects.prove.bind(objects);
 const acquisitions=[],sourceProofs=[];
 objects.acquire=id=>{
  acquire(id);
  acquisitions.push(objects.reservationInventory().activeTransfers);
 };
 objects.prove=async(ref,check)=>{
  if(ref.hash===stage.transport.hash)sourceProofs.push(objects.reservationInventory().activeTransfers);
  return prove(ref,check);
 };
 assert.deepEqual(objects.reservationInventory(),{reservedBytes:'0',activeTransfers:0});

 server=createServer(async(req,res)=>{
  try{
   const bytes=Buffer.concat(await Array.fromAsync(req));
   effects.push({method:req.method,path:req.url,headers:req.headers,bytes});
   res.setHeader('Content-Type','application/json');
   if(req.method==='POST'&&req.url==='/upload'){
    res.end(JSON.stringify({url:origin+'/image/staged-source.png'}));
   }else if(req.method==='POST'&&req.url==='/'+queued.job.review.endpoint){
    const base=origin+'/'+queued.job.review.endpoint+'/requests/streamed_source';
    res.end(JSON.stringify({request_id:'streamed_source',status_url:base+'/status',response_url:base,cancel_url:base+'/cancel'}));
   }else{res.statusCode=404;res.end('{}');}
  }catch(error){serverErrors.push(error);res.destroy();}
 });
 server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 origin='http://127.0.0.1:'+server.address().port;
 const provider=emulator({queueOrigin:origin,mediaOrigin:origin,uploadOrigin:origin,profiles:[fixtureProfile({endpoint:queued.job.review.endpoint})]});
 dispatcher=new QueueDispatcher(owner.db.queue,provider,{profileId:'local-fixture-v1',queueOrigin:origin,uploadURL:origin+'/upload',mediaOrigin:origin});
 const result=await dispatcher.submit(queued.job.id);
 assert.equal(result.attempts[0].state,'acknowledged');
 assert.equal(result.attempts[0].requestId,'streamed_source');
 assert.deepEqual(sourceProofs,[2],'inputStream proves the source while request and response own both IO slots');
 assert.equal(Math.max(...acquisitions),2,'the native two-slot pool is sufficient for the entire dispatch');
 assert.deepEqual(objects.reservationInventory(),{reservedBytes:'0',activeTransfers:0});
 assert.equal(objects.hasLeases(),false,'source proof and transfer leases are released');
 assert.deepEqual(effects.map(effect=>[effect.method,effect.path]),[['POST','/upload'],['POST','/'+queued.job.review.endpoint]]);
 const [upload,submission]=effects;
 assert.deepEqual(upload.bytes,expected);
 assert.equal(digest(upload.bytes),stage.transport.hash);
 assert.equal(upload.headers['content-length'],stage.transport.byteLength);
 assert.equal(upload.headers['transfer-encoding'],undefined);
 assert.equal(upload.headers.authorization,'Key '+SENTINEL_KEY);
 assert.equal(upload.headers['content-type'],'application/octet-stream');
 assert.deepEqual(JSON.parse(submission.bytes.toString()),{...template,image_url:origin+'/image/staged-source.png'});
 assert.equal(submission.bytes.includes(Buffer.from('asset:')),false);
 assert.deepEqual(JSON.parse(await readFile(objectPath(f.root,queued.job.review.template),'utf8')),template);

 const evidence=owner.db.queue.evidence,records=[];
 for(const name of await readdir(join(f.root,'backend-transport'))){
  if(name.endsWith('.json'))records.push(evidence.inspect(name.slice(0,-5)));
 }
 const retained=records.filter(record=>record.direction==='request'&&record.headers['content-type']==='application/octet-stream');
 assert.equal(retained.length,1);
 assert.equal(retained[0].attemptId,result.attempts[0].id);
 assert.equal(retained[0].completeness,'complete');
 assert.equal('sha256:'+retained[0].sha256,stage.transport.hash);
 assert.equal(retained[0].retainedBytes,stage.transport.byteLength);
 assert.deepEqual(Buffer.concat([...evidence.read(retained[0].recordId)]),expected);
 assert.equal(await dispatcher.submit(queued.job.id),null);
 assert.equal(effects.length,2,'acknowledged work is never uploaded or submitted twice');
});
