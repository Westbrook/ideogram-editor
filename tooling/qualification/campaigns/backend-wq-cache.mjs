// Q cache preparation: a fresh owned store and a read-exercised FINAL connection.
// No previous-case process reuse, write/JIT/decode/OS-cache or qualification claim.
import assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {threadId} from 'node:worker_threads';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {fileIdentity} from './common.mjs';
import {sealTree} from './fixtures.mjs';
import {inspectProductWriter, productCriteria, productWorkload} from './fixture-product.mjs';

const moduleInstanceId=randomUUID(), owners=new WeakMap(), controlRoot=fileURLToPath(new URL('../../../',import.meta.url));
const SHA=/^sha256:[a-f0-9]{64}$/;
const SOURCE_PATHS=Object.freeze(['tooling/qualification/campaigns/backend-wq-cache.mjs','tooling/qualification/campaigns/backend.mjs','tooling/qualification/campaigns/backend-common.mjs','tooling/qualification/campaigns/fixture-product.mjs','tooling/qualification/campaigns/backend-queue.mjs','tooling/qualification/campaigns/backend-queue-worker.mjs','tooling/qualification/campaigns/backend-queue-control.mjs','dist/local/server/storage/worker.js','dist/local/server/storage/database.js','dist/local/server/storage/queue.js']);
export const WQ_CACHE_PROOF_LIMIT=1048576;
const digest=value=>'sha256:'+createHash('sha256').update(typeof value==='string'||value instanceof Uint8Array?value:JSON.stringify(value)).digest('hex');
const equal=(a,b,message)=>assert(isDeepStrictEqual(a,b),message);
const abort=signal=>signal?.throwIfAborted();
export const isWQCacheCell=cell=>cell?.workload==='WQ'&&['queue.fault','queue.proxy-pair','queue.healthy-polling'].includes(cell.operation);
export async function retainWQStore(root){const seal=await sealTree(root);return {root:seal.root,files:seal.files.length,bytes:seal.files.reduce((total,row)=>total+Number(row.byteLength),0),sha256:seal.sha256};}

/** The token names this actual StoreDatabase instance, which owns one SQLite
 * connection until close. It is not a SQLite-provided identifier or authority.
 * Neither caller data nor the token can create an owner. */
export async function queueCacheOwner(store,repo){
  store.fence(store.epoch);
  let value=owners.get(store);
  if(!value){
    const sources=[];for(const path of SOURCE_PATHS)sources.push({path,...await fileIdentity(join(path.startsWith('dist/')?repo:controlRoot,path))});
    value={kind:'store-instance-connection',connectionId:randomUUID(),moduleInstanceId,pid:process.pid,threadId,root:resolve(store.root),epoch:store.epoch,sources};owners.set(store,value);
  }
  assert.equal(resolve(store.root),value.root);assert.equal(store.epoch,value.epoch);store.fence(value.epoch);
  return structuredClone(value);
}
export async function bindWQOwner(getIdentity){
  const identity=await getIdentity();
  return async()=>{const next=await getIdentity();equal(next,identity,'WQ measurement owner changed after preparation');return next;};
}
async function span(phases,name,work){const value={name,startMs:performance.now(),endMs:null,durationMs:null,outcome:'running'};phases.push(value);try{const out=await work();value.outcome='completed';return out;}catch(error){value.outcome='failed';throw error;}finally{value.endMs=performance.now();value.durationMs=value.endMs-value.startMs;}}

/** Real public read paths, bounded pages and metadata. No command, provider
 * dispatch, SQL mutation, fake cache hit, or scenario execution occurs here. */
export async function exerciseQueueConnection(reader,documentId,{signal}={}){
  abort(signal);const capture=await reader.capture(),document=await reader.document(documentId),image=await reader.imageState(documentId);
  assert(document&&image&&Array.isArray(image.layers),'WQ document and image projection required');
  let cursor='',pages=0,jobs=0,incomplete=0,cancelled=0,active=0,total=null,counts=null;
  const cursors=new Set(),ids=new Set(),hash=createHash('sha256');
  do{
    abort(signal);assert(!cursors.has(cursor),'WQ read cursor repeated');cursors.add(cursor);assert(++pages<=52,'WQ read exceeds its full fixture plus one scenario job');
    const page=await reader.queueView(cursor);assert(Array.isArray(page.jobs)&&page.jobs.length<=20,'WQ public queue page exceeds20');
    assert(Number.isSafeInteger(page.totalJobs)&&page.totalJobs>=0&&page.totalJobs<=1001,'WQ global queue differs from bounded fixture');
    if(total!==null){assert.equal(page.totalJobs,total,'WQ inventory changed during reads');equal(page.counts,counts,'WQ counters changed during reads');}else{total=page.totalJobs;counts=page.counts;}
    for(const job of page.jobs){assert(typeof job.id==='string'&&!ids.has(job.id)&&Array.isArray(job.attempts),'WQ duplicate or malformed job');ids.add(job.id);jobs++;hash.update(JSON.stringify(job)+'\n');const latest=job.attempts.at(-1);if(latest?.state==='not-started')incomplete++;if(job.local==='locally-cancelled')cancelled++;for(const attempt of job.attempts)if(attempt.hold)active++;}
    cursor=page.nextCursor??'';assert.equal(typeof cursor,'string');
  }while(cursor);
  assert.equal(jobs,total,'WQ public inventory is incomplete');assert.equal(active,counts.active,'WQ global active counter disagrees');
  abort(signal);const after=await reader.capture();equal(after,capture,'WQ read preparation changed durable capture');
  equal(await reader.document(documentId),document,'WQ document changed during reads');equal(await reader.imageState(documentId),image,'WQ image changed during reads');
  return {documentId,width:document.width,height:document.height,layers:image.layers.length,visibleLayers:image.layers.filter(layer=>layer.visible).length,
    imageHash:digest(image),documentHash:digest(document),highWater:capture.highWater,snapshot:capture.snapshot,queue:{pages,jobs,incomplete,cancelled,active,sha256:'sha256:'+hash.digest('hex')},
    reads:['capture','document','imageState','all-queue-pages','capture','document','imageState']};
}
const directReader=store=>({capture:()=>store.recovery.capture(),document:id=>store.document(id),imageState:id=>store.histories.state(id),queueView:after=>store.queue.view(after)});
const summary=observed=>({document:{id:observed.document.id,width:observed.document.width,height:observed.document.height},counts:observed.counts,documentHash:digest(observed.document),imageHash:digest(observed.state),snapshot:observed.snapshot,globalCounts:observed.globalCounts});
const cacheDescription=cache=>({profile:cache==='warm'?'fresh-store-public-read-warmed-measurement-connections':'fresh-store-without-optional-connection-read-warming',
  previousCaseCacheReuse:'not claimed',measurementWriter:'fresh worker after actual close/reopen; direct stages explicitly identify their separate connection',previousStoreReused:false,commonBootstrap:['StoreDatabase open/recovery','rememberClient','protocolDefaults','identity fence'],
  additionalScenarioPrimes:0,writeCache:'not claimed',jitCache:'not claimed',decodedCache:'not claimed',operatingSystemPageCache:'unobserved'});

/** The setup owner verifies exact GLOBAL WQ, then actually exits. The final
 * owner is different. Only the warm arm exercises its complete public reads.
 * Missing full fixture evidence stays inconclusive; small smoke tests do not
 * become qualification fixtures merely by traversing this helper. */
export async function prepareWQCache(f,context,cell,sample,phases){
  if(!isWQCacheCell(cell))return null;
  const selected=context.fixture;
  if(!selected?.seal||selected.preparation?.productionRestartVerified!==true||selected.status!=='complete')return null;
  assert(['cold','warm'].includes(sample.cache));assert.equal(sample.prime,false,'WQ fault/control cohorts have no scenario prime');
  assert(SHA.test(selected.seal.sha256)&&selected.root&&resolve(selected.root)!==resolve(f.root),'WQ requires a distinct copied sealed store');
  assert(f.queueWorker,'WQ preparation requires its actual writer identity bridge');
  const setupWriter=f.writer,setupControl=f.queueWorker;
  const setupOwner=await span(phases,'wq-cache.setup-owner',()=>setupControl.cacheOwner());
  const baseline=await span(phases,'wq-cache.verify-global-fixture',async()=>{
    const observed=await inspectProductWriter(setupWriter,f.documentId),criteria=productCriteria(productWorkload('WQ'),observed.counts);
    assert(criteria.every(row=>row.met),'WQ setup is not the exact complete global fixture');
    assert.equal(observed.document.id,selected.documentId);assert.equal(observed.document.width,2048);assert.equal(observed.document.height,2048);
    assert.equal(observed.globalCounts.jobs,1000);assert.equal(observed.globalCounts.events,10000);assert.equal(observed.globalCounts.active,0);
    return summary(observed);
  });
  const verificationPhase=structuredClone(phases.at(-1));
  await span(phases,'wq-cache.actual-writer-close-and-reopen',()=>f.reopen());
  const restartPhase=structuredClone(phases.at(-1));
  assert.equal(setupWriter.available,false,'WQ setup writer must actually close');
  const writer=f.writer,control=f.queueWorker;
  const owner=await span(phases,'wq-cache.final-owner',()=>control.cacheOwner());
  assert.notEqual(owner.epoch,setupOwner.epoch);assert.notEqual(owner.connectionId,setupOwner.connectionId);assert.notEqual(owner.threadId,setupOwner.threadId);
  const fixed=await bindWQOwner(async()=>{assert.equal(f.writer,writer);assert.equal(f.queueWorker,control);assert.equal(writer.available,true);assert.equal(writer.epoch,owner.epoch);return control.cacheOwner();});
  const packet={kind:'backend-wq-connection-cache-1',previousStore:context.wqPreviousStore??null,cell:{id:cell.id,operation:cell.operation,workload:cell.workload,parameters:cell.parameters??{}},sample:{cache:sample.cache,ordinal:sample.ordinal,prime:sample.prime},
    fixture:{seal:selected.seal.sha256,sourceRoot:resolve(selected.root),root:resolve(f.root),productionRestartVerified:true},cache:cacheDescription(sample.cache),setup:{owner:setupOwner,baseline,verificationPhase,restartPhase},owners:[],scenarioEntered:false};
  const first={label:'writer-before-scenario',before:owner,after:null,reads:null,entry:null};packet.owners.push(first);
  if(sample.cache==='warm')first.reads=await span(phases,'wq-cache.final-connection-public-reads',async()=>{
    const read=await exerciseQueueConnection(writer,f.documentId,{signal:context.signal});
    assert.equal(read.queue.jobs,1000);assert.equal(read.queue.incomplete,100);assert.equal(read.queue.cancelled,900);assert.equal(read.queue.active,0);assert.equal(read.highWater,'10000');
    equal(read.snapshot,baseline.snapshot);assert.equal(read.documentHash,baseline.documentHash);assert.equal(read.imageHash,baseline.imageHash);return read;
  });
  if(sample.cache==='warm')first.readPhase=structuredClone(phases.at(-1));
  first.after=await fixed();let currentGuard=fixed,currentRecord=first,entered=false,finished=false;
  const session={
    async assertWriter(){assert(!finished);const actual=await fixed();if(!entered){entered=true;packet.scenarioEntered=true;first.entry=actual;first.entryAtMs=performance.now();}return actual;},
    async prepareDirect(store,label,operationPhases){
      assert(entered&&!finished);assert(['direct-before-rejection','direct-before-dispatch'].includes(label));assert.equal(packet.owners.length,1,'Only one declared preparation handoff');
      const getIdentity=()=>f.directIdentity(store),guard=await bindWQOwner(getIdentity),before=await guard(),record={label,before,after:null,reads:null,entry:null};
      assert.equal(before.root,owner.root);assert.notEqual(before.epoch,owner.epoch);assert.notEqual(before.connectionId,owner.connectionId);
      if(sample.cache==='warm')record.reads=await span(operationPhases,'wq-cache.direct-connection-public-reads',()=>exerciseQueueConnection(directReader(store),f.documentId,{signal:context.signal}));
      if(sample.cache==='warm')record.readPhase=structuredClone(operationPhases.at(-1));
      record.after=await guard();record.entry=await guard();record.entryAtMs=performance.now();packet.owners.push(record);currentGuard=guard;currentRecord=record;
    },
    async measuredRestart(previous,next,restartPhase){
      assert.equal(cell.parameters?.scenario,'backend-restart');assert.equal(currentRecord.label,'direct-before-dispatch');
      assert.equal(previous.epoch,currentRecord.before.epoch);const nextOwner=await f.directIdentity(next);assert.notEqual(nextOwner.epoch,previous.epoch);assert.notEqual(nextOwner.connectionId,currentRecord.before.connectionId);
      packet.measuredRestart={before:currentRecord.after,after:nextOwner,phase:structuredClone(restartPhase)};currentGuard=await bindWQOwner(()=>f.directIdentity(next));
    },
    async finish(out){
      assert(entered&&!finished);packet.finalOwner=await currentGuard();finished=true;packet.outcome=out.status;
      if(packet.previousStore){packet.previousStoreAfter=await span(out.phases,'wq-cache.previous-store-unchanged',()=>retainWQStore(packet.previousStore.root));equal(packet.previousStoreAfter,packet.previousStore,'Previous WQ store changed');}
      inspectWQCacheProof(packet,{cell,sample,fixture:selected});
      const bytes=Buffer.from(JSON.stringify(packet)+'\n');assert(bytes.length<=WQ_CACHE_PROOF_LIMIT);
      const path=join(context.output,'wq-cache-'+randomUUID()+'.json');await writeFile(path,bytes,{flag:'wx',mode:0o600});
      out.wqCache={artifact:{path,bytes:bytes.length,sha256:digest(bytes)},profile:packet.cache.profile};return out;
    },
  };
  return session;
}

/** Source-bound observation replay; fixture doubles never establish actual
 * warmth. The campaign separately authenticates source/build and worker input. */
export function inspectWQCacheProof(packet,{cell,sample,fixture}){
  assert.equal(packet?.kind,'backend-wq-connection-cache-1');assert(isWQCacheCell(cell));
  equal(packet.cell,{id:cell.id,operation:cell.operation,workload:cell.workload,parameters:cell.parameters??{}},'WQ cache cell changed');
  equal(packet.sample,{cache:sample.cache,ordinal:sample.ordinal,prime:sample.prime},'WQ cache sample changed');assert.equal(sample.prime,false);
  equal(packet.cache,cacheDescription(sample.cache),'WQ cache claim changed');assert.equal(packet.fixture.seal,fixture.seal.sha256);assert.equal(packet.fixture.sourceRoot,resolve(fixture.root));assert.notEqual(packet.fixture.root,packet.fixture.sourceRoot);
  assert.equal(fixture.preparation?.productionRestartVerified,true);assert.equal(packet.fixture.productionRestartVerified,true);assert.equal(packet.scenarioEntered,true);
  const baseline=packet.setup.baseline;equal(baseline.document,{id:fixture.documentId,width:2048,height:2048},'WQ document dimensions changed');assert.equal(baseline.globalCounts.events,10000);assert.equal(baseline.globalCounts.jobs,1000);assert.equal(baseline.globalCounts.active,0);
  assert(productCriteria(productWorkload('WQ'),baseline.counts).every(row=>row.met),'WQ exact fixture changed');
  const validPhase=(value,name)=>{assert(value?.name===name&&value.outcome==='completed'&&Number.isFinite(value.startMs)&&Number.isFinite(value.endMs)&&value.startMs>=0&&value.endMs>=value.startMs);assert.equal(value.durationMs,value.endMs-value.startMs);};
  validPhase(packet.setup.verificationPhase,'wq-cache.verify-global-fixture');validPhase(packet.setup.restartPhase,'wq-cache.actual-writer-close-and-reopen');assert(packet.setup.verificationPhase.endMs<=packet.setup.restartPhase.startMs);
  const direct=['backend-restart','disk-full-admission'].includes(cell.parameters?.scenario);assert.equal(packet.owners.length,direct?2:1);
  const validOwner=identity=>{
    assert(identity?.kind==='store-instance-connection'&&identity.root===packet.fixture.root&&Number.isSafeInteger(identity.pid)&&identity.pid>0&&Number.isSafeInteger(identity.threadId)&&identity.threadId>=0);
    for(const key of ['connectionId','moduleInstanceId'])assert(typeof identity[key]==='string'&&identity[key].length>0);
    assert(/^[1-9][0-9]*$/.test(identity.epoch));
    equal(identity.sources.map(row=>row.path),SOURCE_PATHS,'WQ owner source set changed');for(const row of identity.sources)assert(SHA.test(row.sha256)&&Number.isSafeInteger(row.bytes)&&row.bytes>0);
  };
  validOwner(packet.setup.owner);validOwner(packet.finalOwner);
  if(packet.previousStore){assert.notEqual(packet.previousStore.root,packet.fixture.root);assert(SHA.test(packet.previousStore.sha256)&&Number.isSafeInteger(packet.previousStore.files)&&packet.previousStore.files>0&&Number.isSafeInteger(packet.previousStore.bytes)&&packet.previousStore.bytes>0);equal(packet.previousStoreAfter,packet.previousStore,'Previous WQ store changed');}
  else assert.equal(packet.previousStoreAfter,undefined);
  for(const [index,record]of packet.owners.entries()){
    const identity=record.before;validOwner(identity);validOwner(record.after);validOwner(record.entry);
    assert.equal(record.label,index===0?'writer-before-scenario':cell.parameters?.scenario==='disk-full-admission'?'direct-before-rejection':'direct-before-dispatch');
    equal(identity.sources,packet.setup.owner.sources,'Owner executable identities changed');assert.equal(identity.pid,packet.setup.owner.pid);
    if(index){assert.notEqual(identity.epoch,packet.owners[0].before.epoch);assert.notEqual(identity.connectionId,packet.owners[0].before.connectionId);}
    equal(record.after,identity,'Owner drift while reading');equal(record.entry,identity,'Owner drift before measurement');
    assert(Number.isFinite(record.entryAtMs)&&record.entryAtMs>=packet.setup.restartPhase.endMs);
    if(sample.cache==='cold'){assert.equal(record.reads,null,'Cold owner was optionally read-warmed');assert.equal(record.readPhase,undefined);}else{
      validPhase(record.readPhase,index===0?'wq-cache.final-connection-public-reads':'wq-cache.direct-connection-public-reads');assert(record.readPhase.startMs>=packet.setup.restartPhase.endMs&&record.readPhase.endMs<=record.entryAtMs);
      const read=record.reads;assert(read&&read.documentId===fixture.documentId);equal(read.reads,['capture','document','imageState','all-queue-pages','capture','document','imageState']);
      assert.equal(read.width,2048);assert.equal(read.height,2048);assert.equal(read.layers,20);assert.equal(read.visibleLayers,5);assert(SHA.test(read.queue.sha256));
      assert.equal(read.queue.jobs,index===0||cell.parameters?.scenario==='disk-full-admission'?1000:1001);assert.equal(read.queue.active,0);assert.equal(read.queue.cancelled,900);assert.equal(read.queue.incomplete,index===0||cell.parameters?.scenario==='disk-full-admission'?100:101);
      if(index===0){assert.equal(read.highWater,'10000');equal(read.snapshot,baseline.snapshot);assert.equal(read.documentHash,baseline.documentHash);assert.equal(read.imageHash,baseline.imageHash);}
    }
  }
  const first=packet.owners[0].before;assert.notEqual(first.epoch,packet.setup.owner.epoch);assert.notEqual(first.connectionId,packet.setup.owner.connectionId);assert.notEqual(first.threadId,packet.setup.owner.threadId);
  if(cell.parameters?.scenario==='backend-restart'){const restart=packet.measuredRestart;assert(restart);validPhase(restart.phase,'backend-close-and-reopen');assert(restart.phase.startMs>=packet.owners[1].entryAtMs);validOwner(restart.before);validOwner(restart.after);equal(restart.after.sources,packet.setup.owner.sources);assert.equal(restart.after.pid,packet.setup.owner.pid);equal(restart.before,packet.owners[1].after);assert.notEqual(restart.after.epoch,restart.before.epoch);assert.notEqual(restart.after.connectionId,restart.before.connectionId);equal(packet.finalOwner,restart.after);}
  else{assert.equal(packet.measuredRestart,undefined);equal(packet.finalOwner,packet.owners.at(-1).after);}
  return {profile:packet.cache.profile,root:packet.fixture.root,owners:packet.owners.length};
}

export async function verifyWQCacheAttempt({cell,attempt,fixture,workerProcessIdentity,readRetained,controlFiles,buildFiles,seenRoots=new Set()}){
  if(cell?.handler!=='backend'||!isWQCacheCell(cell))return null;const ref=attempt.result?.wqCache?.artifact;
  if(!ref){assert.notEqual(attempt.status,'PASS','Passing WQ attempt lacks final-connection cache proof');return null;}
  assert(Number.isSafeInteger(ref.bytes)&&ref.bytes>0&&ref.bytes<=WQ_CACHE_PROOF_LIMIT&&SHA.test(ref.sha256));
  const bytes=await readRetained(ref.path,{maximum:WQ_CACHE_PROOF_LIMIT});assert.equal(bytes.length,ref.bytes);assert.equal(digest(bytes),ref.sha256);
  const packet=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));inspectWQCacheProof(packet,{cell,sample:attempt,fixture});
  const retainedPhases=[...(attempt.reset?.phases??[]),...(attempt.result?.phases??[])];
  for(const wanted of [packet.setup.verificationPhase,packet.setup.restartPhase,...packet.owners.map(record=>record.readPhase),packet.measuredRestart?.phase].filter(Boolean)){const matches=retainedPhases.filter(value=>isDeepStrictEqual(value,wanted));assert.equal(matches.length,1,'WQ cache preparation phase is absent, duplicated or changed in the charged ledger');}
  const rows=[...controlFiles,...buildFiles];for(const owner of [packet.setup.owner,...packet.owners.map(row=>row.before),packet.finalOwner]){
    assert.equal(owner.pid,workerProcessIdentity.pid,'WQ owner belongs to another process');
    for(const row of owner.sources){const actual=rows.find(value=>value.path===row.path);assert(actual&&!actual.deleted,'WQ owner source/build input missing');equal({path:actual.path,bytes:actual.bytes,sha256:actual.sha256.startsWith('sha256:')?actual.sha256:'sha256:'+actual.sha256},row,'WQ owner source/build binding changed');}
  }
  assert(!seenRoots.has(packet.fixture.root),'WQ sample reused a prior store');seenRoots.add(packet.fixture.root);
  return packet;
}
