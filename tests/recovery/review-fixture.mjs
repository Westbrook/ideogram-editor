import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import sharp from 'sharp';
import {fixture,prepare,enqueue,auth,encode,envelope,caption,ui,command,EMPTY_EXPECTED_VERSIONS} from '../queue/helpers.mjs';
import {newDraft} from '../../dist/local/src/request/core.js';
import {StoreDatabase} from '../../dist/local/server/storage/database.js';
import {acquireRoot} from '../../dist/local/server/storage/ownership.js';
import {QueueDispatcher} from '../../dist/local/server/provider/dispatcher.js';
import {ResultObserver} from '../../dist/local/server/provider/observer.js';
import {emulator,fixtureProfile} from '../provider/emulator.mjs';
export const send=(db,body)=>db.queue.command(encode(envelope(body)),auth());
export async function remove(db,id='document_1'){
 assert.equal((await send(db,{type:'PreviewDocumentDeletion',documentId:id,expectedRevision:db.document(id).revision})).status,'accepted');
 const p=db.deletions.view(id,auth()).plan;
 assert.equal((await send(db,{type:'DeleteDocument',documentId:id,planId:p.id,planHash:p.planHash,expectedRevision:p.documentRevision,rootGeneration:p.rootGeneration,acknowledgeRunningAndUncertain:true})).status,'accepted');
}
export async function reviewFixture(t,{two=false}={}){
 const clean=[],f=await fixture({name:t.name,after:fn=>clean.push(fn)}),q=await enqueue(f.writer,(await prepare(f.writer)).body);let q2;
 if(two){
  assert.equal((await f.writer.submit(encode(command(EMPTY_EXPECTED_VERSIONS,{documentId:'document_2'})),f.writer.epoch)).status,'accepted');
  const prompt=await caption(f.writer,'Second document'),asset=await caption(f.writer,JSON.stringify(newDraft(prompt.blob)));
  assert.equal((await ui(f.writer,{type:'SaveDraft',draft:{id:'second_draft',generation:'1',kind:'request',documentId:'document_2',targetLayerId:null,expectedDocumentRevision:'1',assetId:asset.id,composing:false}})).status,'accepted');
  const p=await ui(f.writer,{type:'PrepareRequestReview',draftId:'second_draft',generation:'1'}),a=await ui(f.writer,{type:'AcceptRequestReview',reviewId:p.review.id,token:p.review.token});
  q2=await enqueue(f.writer,{type:'QueueInference',reviewId:p.review.id,token:p.review.token,acceptanceId:a.requestId});
 }
 await f.close();let db,owner,observer,dispatcher,origin='';
 const effects=[],controls={status:'COMPLETED',statusCode:200,requestId:'known',incomplete:false,mediaStatus:200},png=await sharp({create:{width:32,height:32,channels:4,background:'#3177ab'}}).png().toBuffer();
 const server=createServer(async(req,res)=>{
  await Array.fromAsync(req);effects.push({method:req.method,path:req.url});res.setHeader('Content-Type','application/json');
  if(req.method==='POST'){const base=origin+'/ideogram/v4/requests/known';res.end(JSON.stringify({request_id:'known',status_url:base+'/status',response_url:base,cancel_url:base+'/cancel'}));}
  else if(req.url.endsWith('/status')){res.statusCode=controls.statusCode;const body=JSON.stringify({request_id:controls.requestId,status:controls.status});if(controls.incomplete){res.setHeader('Content-Length',Buffer.byteLength(body)+10);res.write(body);res.flushHeaders();setImmediate(()=>res.destroy());}else res.end(body);}
  else if(req.url==='/image'){res.statusCode=controls.mediaStatus;res.setHeader('Content-Type','image/png');res.end(png);}
  else if(req.url.endsWith('/cancel')){res.statusCode=202;res.end('{}');}
  else res.end(JSON.stringify({images:[{url:origin+'/image',width:32,height:32}],prompt:'retained',seed:1,timings:{},has_nsfw_concepts:[false]}));
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');origin='http://127.0.0.1:'+server.address().port;
 const provider=emulator({queueOrigin:origin,mediaOrigin:origin,profiles:[fixtureProfile()]});
 async function close(){observer?.close();if(db){await db.candidates.close();await db.queue.close();await db.portables.close();await db.histories.close();await db.rasters.close();await db.assets.close();await db.recovery.settle();db.close();db=null;}owner?.close();owner=null;}
 async function open(){owner=await acquireRoot(f.root);db=new StoreDatabase(f.root,()=>{});dispatcher=new QueueDispatcher(db.queue,provider,{queueOrigin:origin,profileId:'local-fixture-v1'});observer=new ResultObserver(db.candidates,provider,dispatcher,'local-fixture-v1');}
 t.after(async()=>{await close();server.closeAllConnections();await new Promise(r=>server.close(r));for(const fn of clean)await fn();});await open();
 return {f,q,q2,png,effects,controls,get db(){return db;},get observer(){return observer;},get dispatcher(){return dispatcher;},close,async reopen(){await close();await open();}};
}
