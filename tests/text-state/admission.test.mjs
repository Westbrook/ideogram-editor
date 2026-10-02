import {ownTestRoot} from '../../tooling/qualification/owned-test-roots.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,readFile,writeFile,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {Texts} from '../../dist/local/server/storage/text.js';
import {Rasters} from '../../dist/local/server/storage/raster.js';
const auth={clientId:'client_1',sessionHash:'session_hash',now:Date.now(),expires:Date.now()+60000};
const realm='11111111-1111-4111-8111-111111111111';
async function owners(t){
 const root=ownTestRoot(await mkdtemp(join(await realpath(tmpdir()),'text-phase-'))),db=new DatabaseSync(join(root,'owners.sqlite'));
 db.exec('CREATE TABLE text_admissions(id TEXT PRIMARY KEY,client_id TEXT,session_hash TEXT,epoch TEXT);CREATE TABLE assets(id TEXT,json TEXT)');
 // Empty durable ownership tables are still inspected by raster startup/diagnostics.
 // Match their production definitions, including the roots object dependency.
 db.exec(`CREATE TABLE objects (hash TEXT PRIMARY KEY, byte_length TEXT NOT NULL) STRICT;
 CREATE TABLE roots (owner TEXT NOT NULL, hash TEXT NOT NULL REFERENCES objects(hash),
 media_type TEXT NOT NULL, PRIMARY KEY(owner,hash)) STRICT;
 CREATE TABLE deletion_work (path TEXT PRIMARY KEY, document_id TEXT NOT NULL) STRICT;
 CREATE TABLE raster_preparations (id TEXT PRIMARY KEY, hash TEXT NOT NULL, original TEXT NOT NULL,
 canonical TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE, phase TEXT NOT NULL) STRICT;`);
 let texts,rasters;
 t.after(async()=>{try{await rasters?.close();}finally{texts?.closeObservations();db.close();}});
 texts=new Texts(db,{}, {},'epoch');let diskReservations=0;const objectPaths=new Map();let proofSerial=0;
 const verifyBytes=async(path,ref)=>{const bytes=await readFile(path);assert.equal(String(bytes.length),ref.byteLength);assert.equal('sha256:'+createHash('sha256').update(bytes).digest('hex'),ref.hash);};
 const objectStore={reserve:()=>{diskReservations++;},capacity:()=>{},path:ref=>{assert(objectPaths.has(ref.hash));return objectPaths.get(ref.hash);},prove:async ref=>{await verifyBytes(objectStore.path(ref),ref);return 'proof_'+ ++proofSerial;},proven(){},releaseProof(){},adoptFile:async(path,ref)=>{await verifyBytes(path,ref);objectPaths.set(ref.hash,path);return 'proof_'+ ++proofSerial;}};
 rasters=new Rasters(db,objectStore,{},root,'epoch',()=>{},()=>{},()=>{},()=>{});
 texts.backendCPU=()=>rasters.reservedBytes;rasters.externalCPU=()=>texts.externalBytes()+texts.reservedCPU;
 const path=join(root,'input.png'),bytes=await readFile(resolve('tests/raster/fixtures/white.png')),ref={hash:'sha256:'+createHash('sha256').update(bytes).digest('hex'),byteLength:String(bytes.length)};
 await writeFile(path,bytes,{mode:0o600});
 let serial=0;async function raster(){const directory=join(root,'job-'+serial++);await mkdir(directory,{mode:0o700});return rasters.validatePortable(path,'image/png',ref,directory,'portable:phase_'+serial,()=>{});}
 async function retainedText(){
  const index=serial++,sourceBytes=Buffer.from('{}'),pixelBytes=Buffer.alloc(16*16*4);for(let i=3;i<pixelBytes.length;i+=4)pixelBytes[i]=255;
  const save=async(bytes,mediaType,name)=>{const path=join(root,name+'-'+index),ref={hash:'sha256:'+createHash('sha256').update(bytes).digest('hex'),byteLength:String(bytes.length),mediaType};await writeFile(path,bytes,{mode:0o600});objectPaths.set(ref.hash,path);return ref;};
  const source=await save(sourceBytes,'application/json','source'),pixels=await save(pixelBytes,'application/x-ideogram-rgba8','pixels');
  return rasters.prepareDocument({type:'RetainText',source,pixels,width:16,height:16},'retained_'+index,'display:text_'+index,()=>{});
 }
 return {texts,rasters,db,raster,retainedText,diskReservations:()=>diskReservations};
}
test('text admission books current owners and preserves the old generation on capacity refusal',async t=>{
 const {texts,db}=await owners(t),id=n=>realm+'_'+n+'_70000000';
 texts.admission(id(1),auth);texts.admission(id(2),auth);
 const goodRead=texts.readObservations();try{const good=goodRead.value.at(-1);assert.equal(good.combined,good.processRSS+good.browserBytes+good.backendBytes);assert.equal(good.browserBytes,134217728);assert(good.admitted);
 texts.backendCPU=()=>536870912;
 assert.throws(()=>texts.admission(id(3),auth),{code:'CAPACITY'});const badRead=texts.readObservations();try{const bad=badRead.value.at(-1);assert(!bad.admitted);assert.equal(bad.backendBytes,536870912);assert(bad.combined>bad.limit);
 assert.deepEqual(db.prepare('SELECT id FROM text_admissions').all().map(r=>r.id),[id(2)]);
 texts.backendCPU=()=>0;texts.admission(id(3),auth);assert.equal(db.prepare('SELECT id FROM text_admissions').get().id,id(3));
 const nextRead=texts.readObservations();try{t.diagnostic(JSON.stringify({positive:good,refusal:bad,next:nextRead.value.at(-1),reservationControl:'synthetic active backend booking, no allocated-memory or RSS peak claim'}));}finally{nextRead.release();}
 }finally{badRead.release();}}finally{goodRead.release();}
});
test('real CP-1 worker rechecks owners at plan escalation without duplicating its own preflight',{timeout:10000},async t=>{
 const {texts,rasters,raster,diskReservations}=await owners(t);
 const first=raster(),outcome=first.then(value=>({value}),error=>({error}));
 // Let directory creation finish and the actual worker start before admitting
 // a browser owner. The promise exposes no native plan until its next message.
 while(!rasters.reservedBytes){const settled=await Promise.race([outcome,new Promise(r=>setImmediate(()=>r(null)))]);if(settled)throw settled.error??Error('Worker finished before reservation was observed');}
 assert.equal(rasters.reservedBytes,134217728);texts.admission(realm+'_1_70000000',auth);await first;
 const allowedRead=rasters.readDiagnostics();try{const allowed=allowedRead.value.observations.find(x=>x.phase==='resource-admission');assert(allowed.admitted);assert.equal(allowed.externalCPU,134217728);assert.equal(allowed.replacedCPU,134217728);assert.equal(allowed.combinedReservedBytes,allowed.processRSS+allowed.externalCPU+allowed.plan.cpuBytes);assert.equal(rasters.reservedBytes,0);assert.equal(diskReservations(),1);
 texts.releaseAdmission(realm+'_1_70000000',auth);
 let calls=0;rasters.externalCPU=()=>++calls===1?0:536870912;
 await assert.rejects(raster(),{code:'CAPACITY'});
 const refusedRead=rasters.readDiagnostics();try{const refused=refusedRead.value.observations.at(-1);assert.equal(refused.externalCPU,536870912);assert(!refused.admitted);assert.equal(diskReservations(),1);assert.equal(rasters.reservedBytes,0);
 t.diagnostic(JSON.stringify({allowed,refused,liveOverlap:'browser admission during actual CP-1 preflight',refusalControl:'synthetic external reservation introduced after preflight; no physical allocation claim'}));
 }finally{refusedRead.release();}}finally{allowedRead.release();}
});


test('RetainText keeps cold128MiB startup and preflights its complete copy plan only on its ready generation',{timeout:10000},async t=>{
 const {rasters,retainedText,diskReservations}=await owners(t);
 const first=await retainedText(),cold=rasters.rasterWorkerState();assert.equal(cold.completedJobs,1);assert.equal(cold.idleWorkers,1);
 const second=await retainedText(),warm=rasters.rasterWorkerState();assert.deepEqual(warm.identity,cold.identity);assert.equal(warm.completedJobs,2);
 const read=rasters.readDiagnostics();try{
  const rows=read.value.observations.filter(row=>row.phase==='resource-admission');assert.equal(rows.length,2);
  assert.equal(rows[0].replacedCPU,134217728);assert.equal(rows[1].replacedCPU,109119488);
  assert.deepEqual(rows[0].plan,rows[1].plan);
  assert.deepEqual(rows[1].plan,{width:16,height:16,rawBytes:1024,allocations:{nativeDecoderAndColor:0,nativeStackAndIO:0,encodedInput:0,rawOutput:0,orientationRowsAndTiles:0,metadataAndProfileCopies:4194304,pngAndHashIO:4194304,workerHeapAndRuntime:83886080,concurrentBackendHeadroom:16777216,activeKernelTelemetry:65536,retainedTextCopy:1024,retainedTextIdentityTile:1024},cpuBytes:109119488,diskBytes:2100224});
  for(const row of rows){assert.equal(row.combinedReservedBytes,row.processRSS+row.externalCPU+row.plan.cpuBytes);assert(row.admitted);}
  assert.equal(first.asset.raster.pixelIdentity,second.asset.raster.pixelIdentity);assert.equal(diskReservations(),2);assert.equal(rasters.reservedBytes,0);
 }finally{read.release();}
});

test('ready RetainText still rechecks all external owners before complete copy-plan admission',{timeout:10000},async t=>{
 const {rasters,retainedText,diskReservations}=await owners(t);await retainedText();const before=rasters.rasterWorkerState();let calls=0;
 rasters.externalCPU=()=>++calls===1?0:536870912;
 await assert.rejects(retainedText(),{code:'CAPACITY'});
 const read=rasters.readDiagnostics();try{
  const refused=read.value.observations.findLast(row=>row.phase==='resource-admission');assert.equal(refused.admitted,false);assert.equal(refused.externalCPU,536870912);assert.equal(refused.replacedCPU,109119488);assert.equal(refused.plan.cpuBytes,109119488);
  assert.equal(refused.worker.generation,before.identity.generation);assert.equal(refused.worker.threadId,before.identity.threadId);assert.equal(diskReservations(),1);assert.equal(rasters.reservedBytes,0);assert.equal(rasters.rasterWorkerState().workerCount,0);
  t.diagnostic('Refusal uses a synthetic external reservation after real warm preflight; it is not a physical memory measurement.');
 }finally{read.release();}
});


test('RetainText accepts the exact ceiling and refuses one extra byte at both warm admission boundaries',{timeout:10000},async t=>{
 const {rasters,retainedText,diskReservations}=await owners(t);
 const limit=536870912,coldCPU=134217728,warmCPU=109119488,controlledRSS=268435456;
 const memoryUsage=process.memoryUsage;
 // Control only the admission arithmetic. Files, SQLite and worker lifecycle
 // remain real; these synthetic RSS/owner operands are not a measured peak.
 const controlledMemoryUsage=t.mock.method(process,'memoryUsage',()=>({...memoryUsage(),rss:controlledRSS}));
 try{
  rasters.externalCPU=()=>limit-controlledRSS-coldCPU+1;
  await assert.rejects(retainedText(),{code:'CAPACITY'});
  const coldRefusalRead=rasters.readDiagnostics();try{
   const row=coldRefusalRead.value.observations.at(-1);assert.equal(row.phase,'resource-preflight');assert.equal(row.preflightCPU,coldCPU);assert.equal(row.processRSS,controlledRSS);assert.equal(row.combinedReservedBytes,limit+1);assert.equal(row.admitted,false);
  }finally{coldRefusalRead.release();}
  assert.equal(rasters.rasterWorkerState().generation,0);assert.equal(rasters.rasterWorkerState().workerCount,0);assert.equal(diskReservations(),0);assert.equal(rasters.reservedBytes,0);

  rasters.externalCPU=()=>limit-controlledRSS-coldCPU;await retainedText();const before=rasters.rasterWorkerState();assert.equal(before.completedJobs,1);assert.equal(before.idleWorkers,1);
  rasters.externalCPU=()=>limit-controlledRSS-warmCPU;
  await retainedText();const accepted=rasters.rasterWorkerState();assert.deepEqual(accepted.identity,before.identity);assert.equal(accepted.completedJobs,2);assert.equal(accepted.idleWorkers,1);
  const acceptedRead=rasters.readDiagnostics();try{
   const rows=acceptedRead.value.observations.filter(row=>row.phase==='resource-admission');assert.equal(rows.length,2);
   const cold=rows[0];assert.equal(cold.processRSS,controlledRSS);assert.equal(cold.externalCPU,limit-controlledRSS-coldCPU);assert.equal(cold.replacedCPU,coldCPU);assert.equal(cold.plan.cpuBytes,warmCPU);assert.equal(cold.combinedReservedBytes,limit-coldCPU+warmCPU);assert.equal(cold.admitted,true);
   const row=rows.at(-1);assert.equal(row.processRSS,controlledRSS);assert.equal(row.externalCPU,limit-controlledRSS-warmCPU);assert.equal(row.replacedCPU,warmCPU);assert.equal(row.plan.cpuBytes,warmCPU);assert.equal(row.combinedReservedBytes,limit);assert.equal(row.admitted,true);
  }finally{acceptedRead.release();}
  assert.equal(diskReservations(),2);assert.equal(rasters.reservedBytes,0);

  rasters.externalCPU=()=>limit-controlledRSS-warmCPU+1;
  await assert.rejects(retainedText(),{code:'CAPACITY'});
  const warmRefusalRead=rasters.readDiagnostics();try{
   const row=warmRefusalRead.value.observations.at(-1);assert.equal(row.phase,'resource-preflight');assert.equal(row.preflightCPU,warmCPU);assert.equal(row.processRSS,controlledRSS);assert.equal(row.combinedReservedBytes,limit+1);assert.equal(row.admitted,false);
   assert.equal(warmRefusalRead.value.observations.filter(row=>row.phase==='resource-admission').length,2);
  }finally{warmRefusalRead.release();}
  const unchanged=rasters.rasterWorkerState();assert.deepEqual(unchanged.identity,accepted.identity);assert.equal(unchanged.completedJobs,2);assert.equal(unchanged.idleWorkers,1);assert.equal(diskReservations(),2);assert.equal(rasters.reservedBytes,0);

  let calls=0;rasters.externalCPU=()=>limit-controlledRSS-warmCPU+(++calls===1?0:1);
  await assert.rejects(retainedText(),{code:'CAPACITY'});
  const recheckRead=rasters.readDiagnostics();try{
   const rows=recheckRead.value.observations.filter(row=>row.phase==='resource-admission');assert.equal(rows.length,3);
   const row=rows.at(-1);assert.equal(row.processRSS,controlledRSS);assert.equal(row.externalCPU,limit-controlledRSS-warmCPU+1);assert.equal(row.replacedCPU,warmCPU);assert.equal(row.plan.cpuBytes,warmCPU);assert.equal(row.combinedReservedBytes,limit+1);assert.equal(row.admitted,false);
   assert.equal(row.worker.generation,accepted.identity.generation);assert.equal(row.worker.threadId,accepted.identity.threadId);
  }finally{recheckRead.release();}
  assert(calls>=2);assert.equal(rasters.rasterWorkerState().completedJobs,2);assert.equal(rasters.rasterWorkerState().workerCount,0);assert.equal(diskReservations(),2);assert.equal(rasters.reservedBytes,0);
  t.diagnostic('Exact ceiling and one-byte refusals use synthetic process RSS and external reservations with real workers; they establish arithmetic and owner lifecycle only, not physical memory qualification.');
 }finally{controlledMemoryUsage.mock.restore();}
});
