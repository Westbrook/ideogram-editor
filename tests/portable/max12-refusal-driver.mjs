// This driver imports only built-ins and two exact members of the verified old
// runtime. It registers no tests and does not import current product fixtures.
import assert from 'node:assert/strict';
import {readFile,writeFile,open,lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {request as httpRequest} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

const pause=()=>new Promise(resolve=>setTimeout(resolve,10));
const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
let stage='input',server,input,observation,failure,closed=false;
async function hashFile(path){
 const handle=await open(path,'r'),buffer=Buffer.allocUnsafe(1048576),digest=createHash('sha256');let total=0;
 try{for(;;){const {bytesRead}=await handle.read(buffer,0,buffer.length,null);if(!bytesRead)break;digest.update(buffer.subarray(0,bytesRead));total+=bytesRead;}}finally{await handle.close();}
 return {hash:'sha256:'+digest.digest('hex'),byteLength:String(total)};
}
function call(path,{method='GET',body,raw,headers={}}={}){
 const bytes=raw??(body===undefined?undefined:Buffer.from(JSON.stringify(body)));
 return new Promise((resolve,reject)=>{
  const request=httpRequest({hostname:'127.0.0.1',port:new URL(server.origin).port,path,method,agent:false,headers:{...(bytes?{'Content-Type':'application/json','Content-Length':bytes.length}:{}),...headers}},response=>{
   const parts=[];let size=0;response.on('data',chunk=>{size+=chunk.length;if(size>1048576){request.destroy(Error('PUBLIC_RESPONSE_BOUND'));return;}parts.push(chunk);});response.on('error',reject);response.on('end',()=>{try{const text=Buffer.concat(parts).toString();resolve({status:response.statusCode,headers:response.headers,json:text&&response.headers['content-type']?.startsWith('application/json')?JSON.parse(text):null});}catch{reject(Error('PUBLIC_RESPONSE_INVALID'));}});
  });request.setTimeout(10000,()=>request.destroy(Error('PUBLIC_REQUEST_DEADLINE')));request.on('error',reject);request.end(bytes);
 });
}
const tables=['documents','assets','portable_namespaces','portable_rows','portable_maps','queue_jobs','candidate_jobs','candidate_adoption_evidence','candidate_asset_evidence','image_edit_reviews'];
function counts(){const db=new DatabaseSync(join(input.storeRoot,'metadata.sqlite'),{readOnly:true});try{db.exec('BEGIN');return Object.fromEntries(tables.map(table=>[table,db.prepare('SELECT count(*) n FROM '+table).get().n]));}finally{db.close();}}
function stagedPath(id){const db=new DatabaseSync(join(input.storeRoot,'metadata.sqlite'),{readOnly:true});try{const row=db.prepare('SELECT filename FROM staged_assets WHERE id=?').get(id);assert(row);assert.equal(row.filename,resolve('/',row.filename).slice(1),'Staged filename must remain a basename');assert(!row.filename.includes('/'));return join(input.storeRoot,'uploads',row.filename);}finally{db.close();}}
try{
 input=JSON.parse(await readFile(process.argv[2],'utf8'));assert.equal(input.kind,'portable-max12-public-refusal-input-1');assert.equal(process.ppid,input.parentPid);assert.equal(process.versions.node,'26.10.0');assert.equal(process.execPath,join(input.retainedRoot,'.toolchain/node-v26.10.0-darwin-arm64/bin/node'));
 assert(process.execArgv.includes(join(input.retainedRoot,'tests/session/no-egress.mjs')));for(const key of ['NODE_OPTIONS','NODE_PATH','FAL_KEY','FAL_API_KEY','OPENAI_API_KEY','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY'])assert.equal(process.env[key],undefined);
 assert.equal(resolve(input.storeRoot),input.storeRoot);assert(!input.storeRoot.startsWith(input.retainedRoot+'/'));await assert.rejects(lstat(input.storeRoot),{code:'ENOENT'});
 assert.deepEqual(await hashFile(input.source.path),{hash:input.source.hash,byteLength:input.source.byteLength});
 stage='old-runtime-start';const {startLocalServer}=await import(pathToFileURL(join(input.retainedRoot,'dist/local/server/http.js')).href),{EMPTY_EXPECTED_VERSIONS}=await import(pathToFileURL(join(input.retainedRoot,'dist/local/src/protocol/store.js')).href);
 server=await startLocalServer({root:input.storeRoot,staticDirectory:join(input.retainedRoot,'dist/app'),provider:{mode:'disabled'}});
 stage='pair';const paired=await call('/api/v1/session/bootstrap',{method:'POST',headers:{Origin:server.origin},body:{protocolVersion:1,pairingToken:new URL(server.issuePairingURL()).hash.slice(9)}});assert.equal(paired.status,200);
 const cookie=paired.headers['set-cookie'][0].split(';')[0],readHeaders={Cookie:cookie,'Sec-Fetch-Site':'same-origin','X-App-Client':'LP-1'},mutationHeaders={Origin:server.origin,Cookie:cookie,'X-App-CSRF':paired.json.csrfToken};
 const read=path=>call(path,{headers:readHeaders}),post=(path,body)=>call(path,{method:'POST',body,headers:mutationHeaders});
 async function command(body){
  const command={schemaVersion:1,commandId:randomUUID(),clientId:paired.json.clientId,sessionId:'max12_refusal',correlationId:'max12_refusal',causationId:null,transactionId:randomUUID(),documentId:null,expectedDocumentRevision:null,expectedEntityVersions:EMPTY_EXPECTED_VERSIONS,issuedAt:new Date().toISOString(),body};
  let response=await post('/api/v1/commands',{protocolVersion:1,command});const deadline=Date.now()+30000;
  while(response.status===202&&Date.now()<deadline){assert.equal(response.headers.location,response.json.receiptUrl);await pause();response=await read('/api/v1/commands/'+command.commandId);}
  assert.equal(response.status,200);return response.json.receipt;
 }
 async function event(receipt){
  const response=await read('/api/v1/events?after='+String(BigInt(receipt.fromSeq)-1n));assert.equal(response.status,200);const recoveryId=response.json.recovery?.recoveryId;assert.equal(typeof recoveryId,'string');
  try{const batch=response.json.batches[0];assert.equal(batch.kind,'inline');assert.equal(batch.transactionId,receipt.transactionId);assert.equal(batch.events.length,1);assert.equal(batch.events[0].commandId,receipt.commandId);return batch.events[0];}
  finally{assert.equal((await post('/api/v1/recovery/'+recoveryId+'/release',{protocolVersion:1})).status,204);}
 }
 const before=counts();for(const table of ['documents','portable_namespaces','portable_rows','portable_maps','queue_jobs','candidate_jobs','candidate_adoption_evidence','candidate_asset_evidence','image_edit_reviews'])assert.equal(before[table],0);
 stage='stage-genuine-copy';const staging={protocolVersion:1,stagingId:randomUUID(),purpose:'bundle',expectedBytes:input.source.byteLength,sha256:input.source.hash,mediaType:'application/x-ideogram-project'};assert.equal((await post('/api/v1/assets/staging',staging)).status,201);
 const handle=await open(input.source.path,'r'),buffer=Buffer.allocUnsafe(1048576);let offset=0;
 try{for(;;){const {bytesRead}=await handle.read(buffer,0,buffer.length,null);if(!bytesRead)break;assert.equal((await call('/api/v1/assets/staging/'+staging.stagingId,{method:'PUT',raw:buffer.subarray(0,bytesRead),headers:{...mutationHeaders,'Content-Type':'application/octet-stream','Upload-Offset':String(offset)}})).status,200);offset+=bytesRead;}}finally{await handle.close();}assert.equal(String(offset),input.source.byteLength);
 const staged=stagedPath(staging.stagingId),expected={hash:input.source.hash,byteLength:input.source.byteLength};assert.deepEqual(await hashFile(staged),expected);assert.deepEqual(counts(),before);
 stage='public-preview';const preview=await command({type:'PreviewBundleImport',stagingId:staging.stagingId,expectedSha256:staging.sha256});assert.equal(preview.status,'accepted');const reviewed=await event(preview);assert.equal(reviewed.type,'BundleImportReviewed');const response=await read('/api/v1/bundle-reviews/'+reviewed.payload.reviewId);assert.equal(response.status,200);const review=response.json;
 assert.equal(review.formatVersion,13);assert.equal(review.documentSchema,13);assert.equal(review.editable,false);assert.equal(review.reason,'UNSUPPORTED_FORMAT_VERSION');assert.deepEqual(review.source,{...expected,mediaType:'application/x-ideogram-project'});for(const field of ['objectCount','entityCount','eventCount','uiSessionCount'])assert.equal(review[field],'0');assert.deepEqual(review.uiSessionIds,[]);assert.deepEqual(await hashFile(staged),expected);assert.deepEqual(counts(),before);
 stage='public-refusal';const rejected=await command({type:'ImportBundle',reviewId:review.reviewId,reviewHash:review.reviewHash});assert.equal(rejected.status,'rejected');assert.equal(rejected.code,'INCOMPATIBLE');
 assert(rejected.details);const detailsPath=join(input.storeRoot,'objects','sha256',rejected.details.hash.slice(7,9),rejected.details.hash.slice(7)),detailBytes=await readFile(detailsPath);assert.equal(hash(detailBytes),rejected.details.hash);assert.equal(String(detailBytes.length),rejected.details.byteLength);assert.equal(JSON.parse(detailBytes).issues[0].code,'BUNDLE_NOT_EDITABLE');assert.equal((await read('/api/v1/documents/'+review.documentId)).status,404);
 const after=counts();assert.deepEqual(after,before);assert.deepEqual(await hashFile(staged),expected);assert.deepEqual(await hashFile(input.source.path),expected);
 observation={kind:'portable-max12-public-refusal-observation-1',status:'PASS',nonce:input.nonce,pid:process.pid,parentPid:process.ppid,execPath:process.execPath,nodeVersion:process.versions.node,source:expected,formatVersion:review.formatVersion,documentSchema:review.documentSchema,editable:review.editable,reason:review.reason,importStatus:rejected.status,importCode:rejected.code,importReason:'BUNDLE_NOT_EDITABLE',decodedCounts:{objects:review.objectCount,entities:review.entityCount,events:review.eventCount,ui:review.uiSessionCount},before,after,stagedBytesUnchanged:true};
}catch{failure=true;process.stderr.write('MAX12_PUBLIC_REFUSAL_FAILED_AT_'+stage+'\n');process.exitCode=1;}
finally{if(server){try{await server.close();closed=true;}catch{failure=true;process.stderr.write('MAX12_PUBLIC_REFUSAL_CLOSE_FAILED\n');process.exitCode=1;}}}
if(observation&&!failure&&closed)await writeFile(input.resultPath,JSON.stringify({...observation,serverClosed:true})+'\n',{flag:'wx',mode:0o600});
// No process.exit(): a leaked writer/worker keeps this owned child alive, and
// boundedChild must classify the deadline/termination as a failed observation.
