import {mkdtemp,realpath,mkdir,cp,rm,access,writeFile,readdir,readFile,lstat,readlink,open} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID,createHash} from 'node:crypto';import assert from 'node:assert/strict';
import {openWriter} from '../../dist/local/server/storage/writer.js';import {EMPTY_EXPECTED_VERSIONS} from '../../dist/local/src/protocol/store.js';import {newDraft,hash} from '../../dist/local/src/request/core.js';import {command,encode} from '../store/helpers.mjs';
import {TransportEvidenceStore} from '../../dist/local/server/provider/evidence.js';
export {command,encode,EMPTY_EXPECTED_VERSIONS};
export function envelope(body){return command(EMPTY_EXPECTED_VERSIONS,{documentId:null,expectedDocumentRevision:null,body});}
export const auth=()=>({clientId:'client_1',sessionHash:'a'.repeat(64),now:Date.now(),expires:Date.now()+3600000});
// A protected semantic fixture, not an executed provider exchange. The real
// evidence writer owns these bytes; no transport capability or wire claim is minted.
export function legacyAcknowledgement(root,attemptId,requestId,urls,policy){
 const bytes=Buffer.from(JSON.stringify({request_id:requestId,status:'IN_QUEUE',status_url:urls.status,response_url:urls.result,cancel_url:urls.cancel}));assert(bytes.length>0&&bytes.length<=65536);
 const cap=BigInt(bytes.length);let reserved=0n,committed=0n,releases=0;
 const reservation={purpose:'provider-response',ensure(total){assert.equal(releases,0);assert(total>=committed&&total<=cap);reserved=total;},committed(total){assert.equal(releases,0);assert(total>=committed&&total<=reserved);committed=total;},release(){assert.equal(releases,0);releases++;}};
 const evidence=new TransportEvidenceStore(root),sink=evidence.begin(attemptId,'response',reservation,policy,{'content-type':'application/json'});let body;
 try{sink.append(bytes);body=sink.finish(true);}catch(error){sink.finish(false);throw error;}
 const metadata=evidence.inspect(body.recordId);assert.equal(metadata.attemptId,attemptId);assert.equal(metadata.direction,'response');assert.equal(metadata.completeness,'complete');assert.equal(metadata.sha256,createHash('sha256').update(bytes).digest('hex'));
 assert.equal(metadata.receivedBytes,String(bytes.length));assert.equal(metadata.retainedBytes,String(bytes.length));assert.equal(Object.hasOwn(metadata,'wireExecution'),false);assert.equal(Object.hasOwn(metadata,'wireBodyIdentity'),false);assert.deepEqual(Buffer.concat([...evidence.read(body.recordId)]),bytes);
 assert.equal(reserved,cap);assert.equal(committed,cap);assert.equal(releases,1);
 return {kind:'ack',requestId,urls,responseRecord:body.recordId};
}
export async function manifest(root){
 const out=[],scratch=Buffer.alloc(65536);
 async function fileHash(path,expectedBytes){
  const handle=await open(path,'r');
  try{
   const hash=createHash('sha256');let total=0;
   for(;;){const {bytesRead}=await handle.read(scratch,0,scratch.length,null);if(!bytesRead)break;total+=bytesRead;assert(total<=expectedBytes,'Evidence file byte count changed while hashing');hash.update(scratch.subarray(0,bytesRead));}
   assert.equal(total,expectedBytes,'Evidence file byte count changed while hashing');return hash.digest('hex');
  }finally{await handle.close();}
 }
 async function walk(dir,key=''){for(const name of (await readdir(dir)).sort()){
  const path=join(dir,name),rel=key+name,stat=await lstat(path);
  if(stat.isDirectory())await walk(path,rel+'/');
  else if(stat.isSymbolicLink())out.push({path:rel,link:await readlink(path)});
  else out.push({path:rel,bytes:stat.size,sha256:await fileHash(path,stat.size)});
 }}
 await walk(root);return out;
}
export async function fixture(t,size={width:1024,height:1024}){const root=await mkdtemp(join(await realpath(tmpdir()),'p23-queue-')),owned=[];let writer=await openWriter({root});owned.push(writer);const cleanup={root,closed:false,archived:null,removed:false};
 t.after(async()=>{for(const w of owned)await w.close();cleanup.closed=true;const dest=join(process.env.QUEUE_EVIDENCE??'artifacts/p23',t.name.replace(/[^A-Za-z0-9_-]/g,'_')+'-'+randomUUID());await mkdir(dest,{recursive:true});const before=await manifest(root);await cp(root,join(dest,'private'),{recursive:true,preserveTimestamps:true});assert.deepEqual(await manifest(root),before);assert.deepEqual(await manifest(join(dest,'private')),before);await writeFile(join(dest,'manifest.json'),JSON.stringify(before,null,2));cleanup.archived=dest;cleanup.verified=true;await rm(root,{recursive:true});await assert.rejects(access(root));cleanup.removed=true;await writeFile(join(dest,'cleanup.json'),JSON.stringify(cleanup,null,2));});
 await writer.rememberClient(auth().sessionHash,'client_1',Date.now()+3600000);await writer.protocolDefaults();assert.equal((await writer.submit(encode(command(EMPTY_EXPECTED_VERSIONS,{},size)),writer.epoch)).status,'accepted');
 return {root,get writer(){return writer;},async reopen(){await writer.close();writer=await openWriter({root});owned.push(writer);return writer;},async close(){await writer.close();}};
}
export async function caption(w,text){const bytes=Buffer.from(text),stagingId=randomUUID(),sha256=hash(text),a=auth();await w.assetCreate({protocolVersion:1,stagingId,purpose:'caption',expectedBytes:String(bytes.length),sha256,mediaType:'text/plain'},a);const token=await w.assetBeginChunk(stagingId,'0',bytes.length,a);await w.assetChunk(token,bytes,a);const c=envelope({type:'FinalizeStaging',stagingId,expectedSha256:sha256});await w.assetCommand(encode(c),a);let record;for(let i=0;i<400&&!record;i++){record=await w.lookup(c.command.commandId);if(!record)await new Promise(r=>setTimeout(r,5));}assert.equal(record?.receipt.status,'accepted');const events=(await w.events(String(BigInt(record.receipt.fromSeq)-1n))).events;return events.find(e=>e.commandId===c.command.commandId).payload.asset;}
export async function ui(w,body){const state=await w.uiRead('request_session',auth());return w.uiPersist(encode({protocolVersion:1,requestId:randomUUID(),sessionId:'request_session',expectedUISeq:state.uiSeq,body}),auth());}
export async function prepare(w,modify=()=>{},generation='1'){const prompt=await caption(w,'Queue exact Café 東京'),d=newDraft(prompt.blob);modify(d);const asset=await caption(w,JSON.stringify(d));const saved=await ui(w,{type:'SaveDraft',draft:{id:'queue_draft',generation,kind:'request',documentId:'document_1',targetLayerId:null,expectedDocumentRevision:await w.documentRevision('document_1'),assetId:asset.id,composing:false}});assert.equal(saved.status,'accepted');return accept(w,generation);}
export async function accept(w,generation='1'){const p=await ui(w,{type:'PrepareRequestReview',draftId:'queue_draft',generation});assert.equal(p.status,'accepted',JSON.stringify(p));const a=await ui(w,{type:'AcceptRequestReview',reviewId:p.review.id,token:p.review.token});assert.equal(a.status,'accepted',JSON.stringify(a));return {review:p.review,body:{type:'QueueInference',reviewId:p.review.id,token:p.review.token,acceptanceId:a.requestId}};}
export async function enqueue(w,body){const request=envelope(body),receipt=await w.queueCommand(encode(request),auth());assert.equal(receipt.status,'accepted',JSON.stringify(receipt));const events=(await w.events(String(BigInt(receipt.fromSeq)-1n))).events,jobId=events.find(e=>e.commandId===request.command.commandId&&e.type==='JobQueued')?.payload.id;assert(jobId);let after='',job;do{const view=await w.queueView(after);job=view.jobs.find(j=>j.id===jobId);after=view.nextCursor;}while(!job&&after);assert(job);return {job,request,receipt};}
export async function config(w,cap){const {session}=await w.queueView();return w.queueCommand(encode(envelope({type:'SetSpendGuard',spendSessionId:session.id,cap,expectedConfigVersion:session.version})),auth());}
