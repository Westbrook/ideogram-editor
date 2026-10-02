// WF operation-input evidence. Public read preparation is not a scenario prime,
// decoded-cache hit, OS-cache measurement, or standalone corpus qualification.
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {open, writeFile} from 'node:fs/promises';
import {isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {auth, phase} from './backend-common.mjs';
import {selectQueueResultFixture} from './backend-queue-control.mjs';
import {prepareFastInvalidInput} from './backend-queue.mjs';

const SHA = /^sha256:[a-f0-9]{64}$/, DEC = /^(0|[1-9][0-9]*)$/;
const root = fileURLToPath(new URL('../../../', import.meta.url));
const same = (a,b,message) => assert(isDeepStrictEqual(a,b), message);
export const FAST_WARM_PROOF_LIMIT = 1024 * 1024;
export const fastWarmDigest = value => 'sha256:' + createHash('sha256').update(typeof value === 'string' || value instanceof Uint8Array ? value : JSON.stringify(value)).digest('hex');
export const FAST_WARM_SOURCE_PATHS = Object.freeze([
  'tooling/qualification/campaigns/backend-fast-warm-proof.mjs', 'tooling/qualification/campaigns/backend-reset.mjs',
  'tooling/qualification/campaigns/backend.mjs', 'tooling/qualification/campaigns/backend-common.mjs',
  'tooling/qualification/campaigns/backend-queue.mjs', 'tooling/qualification/campaigns/backend-queue-control.mjs',
  'tooling/qualification/campaigns/backend-queue-worker.mjs', 'tooling/qualification/campaigns/backend-wq-cache.mjs',
  'tooling/qualification/campaigns/verification.mjs', 'tooling/qualification/campaigns/fixture-product.mjs',
  'dist/local/server/storage/writer.js', 'dist/local/src/request/core.js', 'dist/local/src/protocol/storage.js',
]);
const selectedCell = cell => ({id:cell.id, handler:cell.handler, operation:cell.operation, workload:cell.workload, parameters:cell.parameters ?? {}});
const selectedSample = sample => ({cache:sample.cache, ordinal:sample.ordinal ?? null, prime:sample.prime ?? null});
const OWNER_SOURCE_PATHS = ['tooling/qualification/campaigns/backend-wq-cache.mjs','tooling/qualification/campaigns/backend.mjs','tooling/qualification/campaigns/backend-common.mjs','tooling/qualification/campaigns/fixture-product.mjs','tooling/qualification/campaigns/backend-queue.mjs','tooling/qualification/campaigns/backend-queue-worker.mjs','tooling/qualification/campaigns/backend-queue-control.mjs','dist/local/server/storage/worker.js','dist/local/server/storage/database.js','dist/local/server/storage/queue.js'];
const stableState = value => {const {filesystem:_filesystem,...storage}=value.storage;return {...value,storage};};
const sameState = (a,b,message) => same(stableState(a),stableState(b),message);
const operationIdentity = operation => ({status:String(operation.status).toUpperCase(),jobId:operation.observations?.jobId??null,attemptId:operation.observations?.attemptId??null,resultFixture:operation.observations?.resultFixture??null});
export const isFastWarmCell = (cell,sample) => cell?.handler === 'backend' && cell.operation === 'fast.workflow' && cell.workload === 'WF'
  && (!sample || ['cold','warm'].includes(sample.cache));

async function original(path, expected, signal, maximum=64*1024*1024) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    assert(before.isFile() && before.nlink === 1 && before.size > 0 && before.size <= maximum, 'WF original must be an ordinary bounded file');
    if (expected?.byteLength!==undefined) assert.equal(String(before.size), String(expected.byteLength), 'WF original length changed');
    const scratch = Buffer.alloc(65536), hash = createHash('sha256'); let bytes = 0;
    for (;;) { signal?.throwIfAborted(); const read = await file.read(scratch,0,scratch.length,bytes); if (!read.bytesRead) break; bytes += read.bytesRead;
      assert(bytes <= before.size, 'WF original grew'); hash.update(scratch.subarray(0,read.bytesRead)); }
    const after = await file.stat();
    assert(['dev','ino','size','mtimeMs','ctimeMs'].every(key => before[key] === after[key]), 'WF original changed during complete read');
    const value = {bytes,sha256:'sha256:' + hash.digest('hex')};
    assert.equal(bytes,before.size); if (expected) assert.equal(value.sha256,expected.sha256,'WF original hash changed'); return value;
  } finally { await file.close(); }
}

export function selectFastWarmInputs(context, cell) {
  assert(isFastWarmCell(cell), 'WF proof is backend-only');
  const caseId = cell.parameters?.caseId; assert(/^WF(0[1-9]|1[0-6])$/.test(caseId), 'Exact WF case required');
  assert(SHA.test(context.fixture?.seal?.sha256 ?? ''), 'Separately sealed selected WF fixture required');
  const valid = selectQueueResultFixture(context,cell);
  if (valid) return {caseId, fixtureSeal:context.fixture.seal.sha256, kind:'valid', manifest:valid.manifest, files:valid.files};
  if (/^WF(0[7-9]|1[0-2])$/.test(caseId)) return {caseId, fixtureSeal:context.fixture.seal.sha256, kind:'invalid',
    expectedField:{WF07:'source',WF08:'mask',WF09:'adapters',WF10:'acceleration',WF11:'expansion',WF12:'size'}[caseId], files:[]};
  const matches = context.fixture.corpus?.files?.filter(file => file.role === 'fast-fault-candidate') ?? [];
  assert.equal(matches.length,1,'WF fault requires its one separately sealed fixed original');
  const file = matches[0]; assert.equal(String(file.byteLength),'8388608'); assert(SHA.test(file.sha256));
  assert.equal(file.width,512); assert.equal(file.height,512);assert.equal(file.format,'png');assert.equal(file.index,0);
  return {caseId,fixtureSeal:context.fixture.seal.sha256,kind:'fault',manifest:{speed:'BALANCED',expansion:'None',width:512,height:512,count:1,format:'png'},
    files:[{id:file.id,role:file.role,path:resolve(context.fixture.root ?? context.repo ?? process.cwd(),file.path),byteLength:String(file.byteLength),sha256:file.sha256,width:512,height:512,format:'png',index:0}]};
}

// The public queue has pages of at most 20; it has no total-attempt bound.
// Bound complete JSON before serializing or copying a row, and cumulatively
// before retaining it. Oversized history is refused, never truncated as complete.
function boundedJSONBytes(value,maximum){let bytes=0;const add=n=>{bytes+=n;assert(bytes<=maximum,'WF complete queue evidence exceeds retained bound');};
  function visit(item,depth){assert(depth<=64,'WF queue JSON depth exceeds evidence bound');
    if(item===null){add(4);return;}if(typeof item==='string'){assert(Buffer.byteLength(item)<=maximum-bytes,'WF queue string exceeds evidence bound');add(Buffer.byteLength(JSON.stringify(item)));return;}
    if(typeof item!=='object'){add(Buffer.byteLength(JSON.stringify(item)));return;}
    add(2);if(Array.isArray(item)){assert(item.length<=maximum,'WF queue array exceeds evidence bound');for(let i=0;i<item.length;i++){if(i)add(1);visit(item[i],depth+1);}}
    else {let first=true;for(const key of Object.keys(item)){if(item[key]===undefined)continue;if(!first)add(1);first=false;visit(key,depth+1);add(1);visit(item[key],depth+1);}}}
  visit(value,0);return bytes;}

/** The public writer returns a StorageRead, not a bare summary. Consume and
 * bound its complete DTO while the loan is live, retain only detached evidence,
 * and await release before exposing that evidence or reporting a failure. */
export async function readFastStorageSummary(writer,{highWater}={}) {
  const read=await writer.storageSummary(auth());let failure;
  try {
    const value=read.value;
    assert.equal(value.epoch,writer.epoch);if(highWater!==undefined)assert.equal(value.highWater,highWater);
    assert.equal(value.accounting,'logical-content-bytes; categories may overlap');assert.equal(value.appPhysicalBytes,null);
    assert.equal(value.registeredObjects.complete,true,'WF logical storage inventory is incomplete');
    // Matches the public StorageSummary response bound; no product cap changes.
    boundedJSONBytes(value,60*1024-1);
    return structuredClone(value);
  } catch(error) {failure=error;throw error;}
  finally {try {await read.release();}catch(error){if(failure)throw new AggregateError([failure,error],'WF storage observation and release both failed');throw error;}}
}

/** Complete public pages and full logical storage summary, never a SQL census.
 * Captures are checked around reads; all retained global rows remain visible. */
export async function observeFastWarmState(f, {signal} = {}) {
  signal?.throwIfAborted(); const writer=f.writer, capture=await writer.capture(), document=await writer.document(f.documentId), image=await writer.imageState(f.documentId);
  assert(document && image && Array.isArray(image.layers),'WF current document must exist');
  let cursor='', total=null, active=0, retainedBytes=0; const cursors=new Set(), ids=new Set(), jobs=[], hash=createHash('sha256');
  do {
    signal?.throwIfAborted(); assert(!cursors.has(cursor),'WF queue cursor repeated'); cursors.add(cursor);
    assert(cursors.size<=65536,'WF global queue observation exceeds bounded evidence inventory');
    const page=await writer.queueView(cursor); assert(Array.isArray(page.jobs) && page.jobs.length<=20 && Number.isSafeInteger(page.totalJobs)&&page.totalJobs>=0,'WF public queue page invalid');
    if(total===null)total=page.totalJobs; else assert.equal(page.totalJobs,total,'WF queue changed during observation');
    for(const job of page.jobs){assert(!ids.has(job.id) && Array.isArray(job.attempts));retainedBytes+=boundedJSONBytes(job,FAST_WARM_PROOF_LIMIT-retainedBytes);ids.add(job.id);hash.update(JSON.stringify(job)+'\n');
      const attempts=job.attempts.map(attempt=>({id:attempt.id,state:attempt.state,hold:attempt.hold,requestId:attempt.requestId??null}));active+=attempts.filter(attempt=>attempt.hold).length;
      jobs.push({id:job.id,documentId:job.documentId,disposition:job.disposition,attempts});}
    cursor=page.nextCursor??'';
  }while(cursor);
  assert.equal(jobs.length,total,'WF complete global queue count differs');
  const storage=await readFastStorageSummary(writer,{highWater:capture.highWater});
  same(await writer.capture(),capture,'WF public read observation mutated durable capture');
  same(await writer.document(f.documentId),document); same(await writer.imageState(f.documentId),image);
  return {documentId:f.documentId,documentHash:fastWarmDigest(document),imageHash:fastWarmDigest(image),width:document.width,height:document.height,layers:image.layers.length,
    highWater:capture.highWater,snapshot:capture.snapshot,queue:{total,active,sha256:'sha256:'+hash.digest('hex'),jobs},storage,
    reads:['capture','document','imageState','all-queue-pages','storageSummary','capture','document','imageState']};
}

function empty(state) {
  assert.equal(state.width,2048);assert.equal(state.height,2048);assert.equal(state.layers,0,'WF base must be an empty W0 document');
  assert.equal(state.queue.active,0,'WF global held attempts must be inactive');
  assert(!state.queue.jobs.some(job=>job.documentId===state.documentId),'WF new namespace cannot reuse an accepted job');
}
function cleanProvider(value) {
  assert(Array.isArray(value?.routes),'Complete provider route inventory required');
  for(const route of value.routes){
    assert.equal(route.closed,false);same(Object.fromEntries(['status','dropAcknowledgement','mediaStatus','offline'].map(key=>[key,route.controls[key]])),{status:'IN_QUEUE',dropAcknowledgement:false,mediaStatus:200,offline:false},'WF provider controls were not reset');
    for(const key of ['effects','errors','controlReads','jobIds','enrolledJobIds','enrolledAttemptIds','submittedJobIds','submittedAttemptIds','requestIds'])same(route[key],[],'WF provider '+key+' retained prior activity');
    for(const key of ['lastSubmit','lastConfigured','lastTick','lastKnownRead','lastStatusObservation'])assert.equal(route[key],null,'WF provider callback state was not reset');
  }
}
function providerInputs(value,selected){for(const route of value.routes){
  assert(Object.keys(route.controls).every(key=>['status','dropAcknowledgement','mediaStatus','offline','resultFiles'].includes(key)),'WF undeclared provider control');
  if(selected.kind==='valid'){same(route.controls.resultFiles,selected.files,'WF provider original selection changed');same(route.resultFixture,{kind:'fast-valid-result-family',caseId:selected.caseId,manifest:selected.manifest,fixtureSeal:selected.fixtureSeal,files:selected.files});}
  else{assert.equal(route.controls.resultFiles,undefined);assert.equal(route.resultFixture,null);}
}}
function validOwner(owner){assert(owner?.kind==='store-instance-connection'&&isAbsolute(owner.root??'')&&DEC.test(owner.epoch??''));
  assert(Number.isSafeInteger(owner.pid)&&owner.pid>0&&Number.isSafeInteger(owner.threadId)&&owner.threadId>=0);
  for(const key of ['connectionId','moduleInstanceId'])assert(typeof owner[key]==='string'&&owner[key].length>0);
  same(owner.sources?.map(row=>row.path),OWNER_SOURCE_PATHS,'WF actual-owner source inventory changed');
  for(const row of owner.sources)assert(Number.isSafeInteger(row.bytes)&&row.bytes>0&&SHA.test(row.sha256));}
function resetContinuity(reset,previous,preparation){if(!previous)return;
  const observations=reset?.observations;assert(observations?.disposal?.deletion?.status==='cleanup-complete'&&observations.disposal.deletion.pendingBytes==='0','WF public cleanup remains incomplete');
  assert.equal(observations.disposal.documentId,previous.after.documentId);assert.equal(observations.previousDocumentId,previous.after.documentId);
  assert.equal(observations.documentId,preparation.base.documentId);assert.equal(observations.writerEpoch,preparation.owner.epoch);assert.equal(observations.writerWorkerRestarted,false);
  assert.equal(observations.providerReset?.receipt?.reset,true,'WF complete provider reset receipt required');cleanProvider(observations.providerReset.after);
  same(observations.providerReset.after,preparation.provider,'WF reset provider observation changed');
  assert.equal(observations.rebuilt?.preparation?.retainedWriter,true);assert.equal(observations.rebuilt.documentId,preparation.base.documentId);
  assert(BigInt(observations.globalHighWater.before)>=BigInt(previous.after.highWater));assert(BigInt(observations.globalHighWater.afterDisposal)>=BigInt(observations.globalHighWater.before));
  assert.equal(observations.globalHighWater.afterReseed,preparation.base.highWater);
}
const draftRecord = prepared => prepared ? {kind:prepared.kind,caseId:prepared.caseId,documentId:prepared.documentId,draftId:prepared.draftId,generation:'1',assetId:prepared.retained.id,
  blob:prepared.retained.blob,rawHash:prepared.retainedHash,uiHash:fastWarmDigest(prepared.original),expectedField:prepared.expectedField} : null;
async function checkDraft(f,prepared){if(!prepared)return null;assert.equal(prepared.writer,f.writer);assert.equal(prepared.documentId,f.documentId);
  same(await f.writer.uiRead('request_session',auth()),prepared.original,'WF durable unapplied draft changed');assert.equal(fastWarmDigest(await f.writer.readMetadata(prepared.retained.blob)),prepared.retainedHash);return draftRecord(prepared);}

/** All preparation finishes before resetCell returns and its receipt is journaled.
 * First warm uses the actual copied W0 seed; it neither primes nor deletes it. */
export async function prepareFastWarmProof(f,context,cell,sample,{reset,previous=null}={}) {
  if(!isFastWarmCell(cell,sample))return null;
  assert.equal(sample.prime,false,'WF has no additional scenario primes');assert(reset && Array.isArray(reset.phases));
  const writer=f.writer,control=f.queueWorker,documentId=f.documentId;assert(control?.cacheOwner && control.snapshot,'Actual retained writer bridge required');
  const phases=reset.phases,sourceFiles=[];
  await phase(phases,'fast-input.source-identity',async()=>{for(const path of FAST_WARM_SOURCE_PATHS)sourceFiles.push({path,...await original(join(path.startsWith('dist/')?context.repo??root:root,path),null,context.signal)});});
  const owner=await phase(phases,'fast-input.actual-owner',()=>control.cacheOwner());
  validOwner(owner);assert.equal(owner.root,resolve(f.root));assert.equal(owner.epoch,writer.epoch);
  const guard=async()=>{assert.equal(f.writer,writer);assert.equal(f.queueWorker,control);assert.equal(f.documentId,documentId);assert.equal(writer.available,true);same(await control.cacheOwner(),owner,'WF measurement writer changed');};
  const base=await phase(phases,'fast-input.empty-base-public-observation',()=>observeFastWarmState(f,context));empty(base);
  const provider=await phase(phases,'fast-input.provider-reset-observation',()=>control.snapshot());cleanProvider(provider);
  if(previous){assert.equal(sample.cache,'warm');same(owner,previous.finalOwner,'WF warm steady writer was replaced');assert.notEqual(documentId,previous.after.documentId,'WF reused the prior sample document');
    assert(BigInt(base.highWater)>=BigInt(previous.after.highWater));assert(base.queue.total>=previous.after.queue.total);
    for(const old of previous.after.queue.jobs){const retained=base.queue.jobs.find(row=>row.id===old.id);assert(retained,'WF prior accepted job was removed from global history');
      if(old.documentId===previous.after.documentId)assert(retained.disposition==='deleted' && retained.attempts.every(attempt=>!attempt.hold),'WF prior sample job remains eligible');}
    assert(reset.observations?.disposal?.deletion?.status==='cleanup-complete' && reset.observations.disposal.deletion.pendingBytes==='0','WF public cleanup remains incomplete');
    assert.equal(reset.observations.providerReset?.receipt?.reset,true,'WF complete provider reset receipt required');
  }
  const selected=selectFastWarmInputs(context,cell), originals=[];providerInputs(provider,selected);
  const manifestPath=context.fixture.seal.path??context.fixture.manifestPath;assert(isAbsolute(manifestPath??''),'WF separately retained manifest path required');
  const manifest=await phase(phases,'fast-input.selected-manifest-readback',async()=>({path:manifestPath,...await original(manifestPath,{sha256:selected.fixtureSeal},context.signal,128*1024*1024)}));
  await phase(phases,'fast-input.selected-original-readback',async()=>{for(const file of selected.files) originals.push({...file,...await original(file.path,file,context.signal)});});
  const warmed=sample.cache==='warm'?await phase(phases,'fast-input.measurement-connection-public-reads',()=>observeFastWarmState(f,context)):null;
  if(warmed)sameState(warmed,base,'WF read preparation changed its exact base');
  const prepared=await prepareFastInvalidInput(context,cell,f,phases);
  const draft=await phase(phases,'fast-input.durable-draft-observation',()=>checkDraft(f,prepared));
  const ready=await phase(phases,'fast-input.ready-public-observation',()=>observeFastWarmState(f,context));empty(ready);await guard();
  const preparation={kind:'fast-input-preparation-1',cell:selectedCell(cell),sample:selectedSample(sample),serial:previous?previous.serial+1:1,previous:previous?fastWarmDigest(previous):null,
    owner,sourceFiles,selected,manifest,originals,base,provider,warmed,draft,ready,cacheProfile:{kind:sample.cache==='warm'?'same-writer-public-read-prepared':'fresh-writer-common-input-validation',additionalScenarioPrimes:0,
      decodedCache:'not claimed',writeCache:'not claimed',jitCache:'not claimed',operatingSystemPageCache:'unobserved'},preparedAtMs:performance.now()};
  resetContinuity(reset,previous,preparation);
  if(reset.qualification)reset.accumulatedWorkspaceQualification=structuredClone(reset.qualification);
  reset.fastWarmPreparation=preparation;reset.qualification={status:'pass',scope:'WF selected-input preparation only; completed bound operation proof required',missing:[]};
  let entered=false,finished=false,entry=null,entryAtMs=null;
  return {runContext:{fastPreparedInput:prepared},
    async enter(){assert(!entered&&!finished);await guard();same(await checkDraft(f,prepared),draft);entry=await observeFastWarmState(f,context);sameState(entry,ready,'WF prepared namespace changed before operation');entered=true;entryAtMs=performance.now();},
    async finish(outcome){assert(entered&&!finished);await guard();const after=await phase(outcome.phases,'fast-input.after-operation-observation',()=>observeFastWarmState(f,context));
      const finalProvider=await phase(outcome.phases,'fast-input.after-provider-observation',()=>control.snapshot());await guard();
      const originalsAfter=await phase(outcome.phases,'fast-input.final-original-readback',async()=>{const values=[];for(const file of selected.files)values.push({...file,...await original(file.path,file,context.signal)});return values;});
      const manifestAfter=await phase(outcome.phases,'fast-input.final-manifest-readback',async()=>({path:manifestPath,...await original(manifestPath,{sha256:selected.fixtureSeal},context.signal,128*1024*1024)}));
      if(selected.kind==='invalid'){same(after.queue,ready.queue,'WF invalid request created accepted queue work');same(finalProvider,provider,'WF invalid request caused provider activity');same(await checkDraft(f,prepared),draft);
        outcome.observations.providerEffects=0;outcome.observations.providerEffectsObservation={before:provider,after:finalProvider};}
      const packet={kind:'backend-fast-input-proof-1',serial:preparation.serial,previous:preparation.previous,preparation,entry,entryAtMs,after,finalProvider,finalOwner:owner,originalsAfter,manifestAfter,
        completedAtMs:performance.now(),operation:operationIdentity(outcome),
        growth:{before:base.storage,prepared:ready.storage,after:after.storage,scope:'full retained global logical totals; no subtraction; physical bytes unavailable'}};
      const verdict=inspectFastWarmProof(packet,{cell,sample,previous,fixture:context.fixture,reset,operation:outcome});
      const bytes=Buffer.from(JSON.stringify(packet,null,2)+'\n');assert(bytes.length<=FAST_WARM_PROOF_LIMIT,'WF proof exceeds evidence bound');
      const path=join(context.output,'backend-fast-input-'+randomUUID()+'.json');await writeFile(path,bytes,{flag:'wx',mode:0o600});
      outcome.fastWarmInput={kind:packet.kind,artifact:{path,bytes:bytes.length,sha256:fastWarmDigest(bytes)},verdict};finished=true;return packet;
    }};
}

export function inspectFastWarmProof(packet,{cell,sample,previous=null,fixture,reset,operation}={}) {
  assert(isFastWarmCell(cell,sample));assert.equal(packet?.kind,'backend-fast-input-proof-1');const p=packet.preparation;
  same(p.cell,selectedCell(cell));same(p.sample,selectedSample(sample));assert.equal(sample.prime,false);same(p,reset?.fastWarmPreparation,'WF journaled reset preparation changed');
  same(p.selected,selectFastWarmInputs({fixture},cell),'WF independently selected corpus differs');
  assert.equal(packet.serial,previous?previous.serial+1:1);assert.equal(packet.previous,previous?fastWarmDigest(previous):null);assert.equal(p.serial,packet.serial);assert.equal(p.previous,packet.previous);
  validOwner(p.owner);same(packet.finalOwner,p.owner);assert.equal(p.owner.root,reset.observations?.root);same(packet.operation,operationIdentity(operation),'WF completed operation differs from its journal result');
  same(p.sourceFiles.map(row=>row.path),FAST_WARM_SOURCE_PATHS);for(const row of p.sourceFiles)assert(SHA.test(row.sha256)&&Number.isSafeInteger(row.bytes)&&row.bytes>0);
  empty(p.base);empty(p.ready);cleanProvider(p.provider);providerInputs(p.provider,p.selected);providerInputs(packet.finalProvider,p.selected);sameState(packet.entry,p.ready);
  assert(Number.isFinite(p.preparedAtMs)&&p.preparedAtMs<=packet.entryAtMs&&packet.entryAtMs<=packet.completedAtMs);
  same(p.cacheProfile,{kind:sample.cache==='warm'?'same-writer-public-read-prepared':'fresh-writer-common-input-validation',additionalScenarioPrimes:0,decodedCache:'not claimed',writeCache:'not claimed',jitCache:'not claimed',operatingSystemPageCache:'unobserved'});
  if(sample.cache==='warm')sameState(p.warmed,p.base);else{assert.equal(p.warmed,null);assert.equal(previous,null);}
  same(p.manifest,{path:fixture.seal.path??fixture.manifestPath,bytes:p.manifest.bytes,sha256:fixture.seal.sha256});assert(Number.isSafeInteger(p.manifest.bytes)&&p.manifest.bytes>0&&p.manifest.bytes<=128*1024*1024);
  same(packet.manifestAfter,p.manifest);same(packet.originalsAfter,p.originals);
  assert.equal(p.originals.length,p.selected.files.length);for(const [i,file]of p.selected.files.entries())same(p.originals[i],{...file,bytes:Number(file.byteLength),sha256:file.sha256});
  same(packet.growth,{before:p.base.storage,prepared:p.ready.storage,after:packet.after.storage,scope:'full retained global logical totals; no subtraction; physical bytes unavailable'});
  for(const state of [p.base,p.ready,packet.after]){assert(DEC.test(state.highWater));assert.equal(state.storage.highWater,state.highWater);assert.equal(state.storage.epoch,p.owner.epoch);assert.equal(state.storage.registeredObjects.complete,true);assert.equal(state.storage.appPhysicalBytes,null);}
  assert(BigInt(p.ready.highWater)>=BigInt(p.base.highWater)&&BigInt(packet.after.highWater)>=BigInt(p.ready.highWater));
  assert(packet.after.queue.total>=p.ready.queue.total);assert.equal(packet.after.documentId,p.base.documentId);
  if(previous){same(p.owner,previous.finalOwner);same(p.sourceFiles,previous.preparation.sourceFiles);same(p.manifest,previous.preparation.manifest);same(p.selected,previous.preparation.selected);resetContinuity(reset,previous,p);assert.notEqual(p.base.documentId,previous.after.documentId);assert(BigInt(p.base.highWater)>=BigInt(previous.after.highWater));assert(p.base.queue.total>=previous.after.queue.total);
    for(const old of previous.after.queue.jobs){const retained=p.base.queue.jobs.find(row=>row.id===old.id);assert(retained);if(old.documentId===previous.after.documentId)assert(retained.disposition==='deleted'&&retained.attempts.every(a=>!a.hold));}}
  if(p.selected.kind==='invalid'){assert(p.draft?.kind==='fast-durable-invalid-input-1'&&p.draft.caseId===p.selected.caseId&&p.draft.documentId===p.base.documentId&&p.draft.expectedField===p.selected.expectedField);
    assert(SHA.test(p.draft.rawHash)&&p.draft.rawHash===p.draft.blob.hash&&SHA.test(p.draft.uiHash));same(packet.after.queue,p.ready.queue);same(packet.finalProvider,p.provider);
    assert.equal(packet.operation.jobId,null);assert.equal(operation?.observations?.providerEffects,0);same(operation.observations.retainedDraft,p.draft.blob);same(operation.observations.providerEffectsObservation,{before:p.provider,after:packet.finalProvider});
  }else{assert.equal(p.draft,null);assert(packet.operation.jobId && !p.base.queue.jobs.some(job=>job.id===packet.operation.jobId),'WF operation reused a prior accepted job');
    const job=packet.after.queue.jobs.find(row=>row.id===packet.operation.jobId);assert(job?.documentId===p.base.documentId&&job.attempts.some(attempt=>attempt.id===packet.operation.attemptId));
    if(p.selected.kind==='fault')assert.equal(packet.operation.resultFixture?.exactEightMiB,true);}
  return {complete:true,scope:'WF exact selected inputs, writer and public reset continuity',serial:packet.serial,cache:sample.cache,globalGrowth:packet.growth};
}

export async function verifyFastWarmAttempt({cell,attempt,previous=null,fixture,workerProcessIdentity,readRetained,controlFiles=[],buildFiles=[]}) {
  if(!isFastWarmCell(cell,attempt))return null;const ref=attempt.result?.fastWarmInput?.artifact;
  if(!ref){assert.notEqual(attempt.status,'PASS','Passing WF attempt lacks completed exact-input proof');return null;}
  assert(Number.isSafeInteger(ref.bytes)&&ref.bytes>0&&ref.bytes<=FAST_WARM_PROOF_LIMIT&&SHA.test(ref.sha256));
  const bytes=await readRetained(ref.path,{maximum:FAST_WARM_PROOF_LIMIT});assert.equal(bytes.length,ref.bytes);assert.equal(fastWarmDigest(bytes),ref.sha256);
  const packet=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  inspectFastWarmProof(packet,{cell,sample:attempt,previous,fixture,reset:attempt.reset,operation:attempt.result});
  assert.equal(packet.preparation.owner.pid,workerProcessIdentity.pid,'WF proof belongs to another worker');
  const rows=[...controlFiles,...buildFiles];for(const wanted of [...packet.preparation.sourceFiles,...packet.preparation.owner.sources]){
    const actual=rows.find(row=>row.path===wanted.path);assert(actual&&!actual.deleted,'WF executable identity absent from sealed control/build inputs');
    same({bytes:actual.bytes,sha256:actual.sha256.startsWith('sha256:')?actual.sha256:'sha256:'+actual.sha256},{bytes:wanted.bytes,sha256:wanted.sha256},'WF executable source changed');}
  const phases=attempt.reset.phases??[];for(const name of ['fast-input.source-identity','fast-input.actual-owner','fast-input.empty-base-public-observation','fast-input.provider-reset-observation','fast-input.selected-manifest-readback','fast-input.selected-original-readback','fast-input.durable-draft-observation','fast-input.ready-public-observation',...(attempt.cache==='warm'?['fast-input.measurement-connection-public-reads']:[])]){
    const found=phases.filter(row=>row.name===name);assert.equal(found.length,1,'WF charged preparation phase missing or duplicated');const row=found[0];assert(row.outcome==='completed'&&row.startMs<=row.endMs&&row.endMs<=packet.preparation.preparedAtMs&&row.endMs<=attempt.startMs);}
  for(const name of ['fast-input.after-operation-observation','fast-input.after-provider-observation','fast-input.final-original-readback','fast-input.final-manifest-readback']){
    const found=(attempt.result.phases??[]).filter(row=>row.name===name);assert.equal(found.length,1,'WF charged completion phase missing or duplicated');const row=found[0];assert(row.outcome==='completed'&&row.startMs>=packet.entryAtMs&&row.startMs<=row.endMs&&row.endMs<=packet.completedAtMs&&row.endMs<=attempt.endMs);}
  assert(packet.entryAtMs>=attempt.startMs&&packet.completedAtMs<=attempt.endMs,'WF operation proof lies outside its charged attempt');return packet;
}
