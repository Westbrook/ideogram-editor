import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {digestJSON} from '../../tooling/qualification/core.mjs';
import {createJournal, digest, fileIdentity, sanitize} from '../../tooling/qualification/campaigns/common.mjs';
import {observedAdapterFileChunks, readBackAdapterAsset, collectAdapterImportProof, retainAdapterImportObservation,
  verifyAdapterImportObservation, verifiedAdapterImportMeasurements, isOrdinaryAdapterImport} from '../../tooling/qualification/campaigns/adapter-import-observation.mjs';
import {evaluateRequiredMeasurements, executionGroups, summarize, summarizeRetainedCampaign} from '../../tooling/qualification/campaigns/run.mjs';
import {verifySealedEvidence} from '../../tooling/qualification/campaigns/verification.mjs';

const chunk = 1048576, clone = value => structuredClone(value);
const worker = {pid: 4207, startedAt: 'unit-process-start', node: 'v26.10.0'};
const cell = {id: 'AC1/unit-import', handler: 'adapters', host: 'C', kind: 'operation', workload: 'WA', operation: 'adapter.import', parameters: {bytes: 4}};
const processIdentity = JSON.stringify({...worker, writerEpoch: '1', root: '/unit/private-root'});
const reference = (bytes, mediaType = 'application/octet-stream') => ({hash: digest(bytes), byteLength: String(bytes.length), mediaType});
async function directory(t) {const path = await mkdtemp(join(await realpath(tmpdir()), 'ordinary-import-unit-')); t.after(() => rm(path, {recursive: true, force: true})); return path;}
async function stored(root, ref, bytes) {
  const hex = ref.hash.slice(7), path = join(root, 'objects', 'sha256', hex.slice(0,2), hex);
  await mkdir(join(root, 'objects', 'sha256', hex.slice(0,2)), {recursive:true}); await writeFile(path,bytes); return path;
}
function fixture() {
  const data = {weights: Buffer.from('abcd'), config: Buffer.from('{}\n'), provenance: Buffer.from('{"origin":"unit"}'), validation: Buffer.from('{"valid":true}')};
  const refs = Object.fromEntries(Object.entries(data).map(([role, bytes]) => [role, reference(bytes, role === 'weights' ? 'application/octet-stream' : role === 'config' ? 'text/plain' : 'application/json')]));
  const asset = (id, blob) => ({id, version: '1', blob});
  const assets = {weights: asset('weights', refs.weights), config: asset('config', refs.config)};
  assets.registration = {...asset('registration', refs.weights), dependencies: [refs.config, refs.provenance, refs.validation], adapter: {
    weights: refs.weights, config: refs.config, sources: {weightsAssetId: 'weights', configAssetId: 'config', provenanceAssetId: null}, qualification: 'structurally-valid', origin: {kind: 'import', provenance: refs.provenance, original: null},
    validation: {runtimeVerified: false, locallyEligible: false, report: refs.validation}}};
  const view = {versionId: 'registration', available: true, qualification: 'structurally-valid', weights: refs.weights, config: refs.config, runtimeVerified: false, locallyEligible: false};
  const local = role => ({path: '/unit/' + role, hash: refs[role].hash, bytes: data[role].length, mediaType: refs[role].mediaType});
  const imported = {asset: assets.registration, view, fixture: local('weights'), config: local('config'), binding: null, storedAssets: assets};
  const phases = ['weights', 'config'].map((role, index) => ({name: 'local-' + role + '-hash', hash: refs[role].hash, bytes: data[role].length,
    chunks: 1, maxChunk: data[role].length, outcome: 'expected', startMs: 120 + index, endMs: 121 + index, durationMs: 1}));
  const names = ['weights-stage-hash-durable', 'config-stage-hash-durable', 'header-profile-config-inspection-and-registration-durable'];
  for (const [index, role] of ['weights','config','registration'].entries()) {
    const commandId = 'command-' + role, seq = String(index + 1), receipt = {status: 'accepted', commandId, fromSeq: seq, toSeq: seq};
    phases.push({name: names[index], commandId, commandType: index === 2 ? 'RegisterAdapterVersion' : 'FinalizeStaging', receipt, eventSeq: seq,
      event: {seq, commandId, type: 'AssetRegistered', payload: {asset: assets[role]}}, outcome: 'expected', startMs: 130 + index, endMs: 131 + index, durationMs: 1});
  }
  phases.push({name: 'durable-entry-observation', startMs: 140, endMs: 141, durationMs: 1, outcome: 'expected'});
  phases.push({name: 'adapter.import-durable', startMs: 119, endMs: 200, durationMs: 81, elapsedMs: 81, outcome: 'expected'});
  const counters = Object.fromEntries(['submit','upload','poll','cancel','fetch','socket','dns','datagram'].map(key => [key, 0]));
  const proof = {readBack: ['weights','config','registration'].map(role => ({role, assetId: assets[role].id, expected: assets[role].blob,
    hash: assets[role].blob.hash, bytes: Number(assets[role].blob.byteLength), chunks: 1, maxChunk: Number(assets[role].blob.byteLength)})),
    metadata: ['provenance','validation'].map(role => ({role, expected: refs[role], hash: refs[role].hash, bytes: data[role].length})),
    durability: phases.filter(value => value.commandId).map(value => ({phase: value.name, commandId: value.commandId, receipt: value.receipt, event: value.event})),
    ownedLookup: {before: clone(counters), after: clone(counters), expected: view, observed: view, scope: 'patched-network-APIs-main-and-writer'}};
  return {data, refs, imported, phases, proof};
}
async function retained(t, mutate = () => {}) {
  const f = fixture(), output = await directory(t); mutate(f);
  const retained = await retainAdapterImportObservation({output, cell, sample: {cache: 'cold', ordinal: 1, prime: false}, workerProcessIdentity: worker,
    processIdentity, imported: f.imported, phases: f.phases, proof: f.proof, sampling: null, backendHighWaterRssBytes: 300});
  const result = sanitize({status: 'INCONCLUSIVE', phases: f.phases, adapterImport: retained.observation, measurements: retained.measurements});
  const bytes = await readFile(retained.observation.artifact.path);
  return {f, result, bytes, attempt: {id: 'AC1/unit-import/cold/scored/1', result}, retained};
}
const replay = value => verifyAdapterImportObservation({cell, attempt: value.attempt, workerProcessIdentity: worker,
  readRetained: async path => {assert.equal(path, value.result.adapterImport.artifact.path); return value.bytes;}});
function rewrite(value, mutate) {
  const packet = JSON.parse(value.bytes); mutate(packet); value.bytes = Buffer.from(JSON.stringify(packet, null, 2) + '\n');
  const artifact = {...value.result.adapterImport.artifact, bytes: value.bytes.length, sha256: digest(value.bytes)};
  value.result.adapterImport.artifact = artifact;
  for (const row of value.result.measurements) row.evidence = clone(value.result.adapterImport);
}

test('ordinary import scope excludes browser, lifecycle, other workload and unowned handlers', () => {
  assert(isOrdinaryAdapterImport(cell));
  for (const change of [{host:'H'}, {kind:'lifecycle'}, {workload:'W1'}, {handler:'browser'}, {operation:'adapter.transfer'}]) assert.equal(isOrdinaryAdapterImport({...cell,...change}), false);
});

test('bounded file reads book one backing store until completion and never prefetch another chunk', async t => {
  const root = await directory(t), path = join(root, 'weights'), original = Buffer.alloc(2 * chunk + 19, 17); await writeFile(path, original);
  let live = 0, peak = 0, released = 0, booked = 0, readers = 0; const pieces = [];
  const resources = {handle(owner, kind) {assert.equal(owner, 'adapter-import-observer'); assert.equal(kind, 'file-reader'); readers++; return () => {readers--;};}, buffer(owner, kind, value) {assert.equal(owner, 'adapter-import-observer'); assert.equal(kind, 'file-buffer'); booked++; live += value.buffer.byteLength; peak = Math.max(peak, live); return () => {live -= value.buffer.byteLength; released++;};}};
  for await (const bytes of observedAdapterFileChunks(path, {resources})) {assert.equal(live, chunk); assert.equal(readers, 1); pieces.push(Buffer.from(bytes));}
  assert.deepEqual(Buffer.concat(pieces), original); assert.equal(booked, 1); assert.equal(released, 1); assert.equal(live, 0); assert.equal(peak, chunk); assert.equal(readers, 0);
});

test('consumer failure, abort and symlink refusal release only the actual owned read', async t => {
  const root = await directory(t), path = join(root, 'weights'); await writeFile(path, Buffer.alloc(chunk + 2));
  let released = 0, readers = 0; const resources = {handle: () => {readers++; return () => {readers--;};}, buffer: () => () => {released++;}};
  await assert.rejects(async () => {for await (const bytes of observedAdapterFileChunks(path, {resources})) {assert(bytes.length); throw Error('consumer failed');}}, /consumer failed/);
  assert.equal(released, 1); assert.equal(readers, 0);
  const signal = AbortSignal.abort(Error('aborted'));
  await assert.rejects(async () => {for await (const _ of observedAdapterFileChunks(path, {resources, signal})) assert.fail();}, /aborted/); assert.equal(released, 2); assert.equal(readers, 0);
  const link = join(root, 'link'); await symlink(path, link);
  await assert.rejects(async () => {for await (const _ of observedAdapterFileChunks(link, {resources})) assert.fail();}); assert.equal(released, 2); assert.equal(readers, 0);
});

test('private stored readback hashes every byte with one released backing buffer while public content stays unused', async t => {
  const root = await directory(t), bytes = Buffer.alloc(chunk + 13, 83), asset = {id:'weights',blob:reference(bytes)};
  await stored(root,asset.blob,bytes); let live=0, releases=0;
  const resources={buffer(owner,kind,value){live+=value.buffer.byteLength;return()=>{live-=value.buffer.byteLength;releases++;};}};
  const result = await readBackAdapterAsset(root,asset,undefined,resources); assert.equal(result.hash, asset.blob.hash); assert.equal(result.bytes, bytes.length); assert.equal(result.chunks, 2);
  assert.equal(result.maxChunk,chunk); assert.equal(live,0); assert.equal(releases,1);
});

test('private readback refuses corrupt, short, oversized, symlinked and missing content without changing product safety', async t => {
  for (const mode of ['corrupt','short','oversized','symlink','missing']) {
    const root=await directory(t), bytes=Buffer.from('original'), asset={id:'weights',blob:reference(bytes)};
    const path=await stored(root,asset.blob,mode==='corrupt'?Buffer.from('changed!'):mode==='short'?Buffer.from('short'):mode==='oversized'?Buffer.from('oversized'):bytes);
    if(mode==='symlink'){await rm(path);await writeFile(join(root,'elsewhere'),bytes);await symlink(join(root,'elsewhere'),path);}
    if(mode==='missing') await rm(path);
    let live=0; const resources={buffer(owner,kind,value){live+=value.buffer.byteLength;return()=>{live-=value.buffer.byteLength;};}};
    await assert.rejects(readBackAdapterAsset(root,asset,undefined,resources));assert.equal(live,0);
  }
});

test('complete byte and receipt witnesses retain truthful T06 rows while absent allocations remain unavailable', async t => {
  const value=await retained(t); assert.equal(verifiedAdapterImportMeasurements(value.result,cell).length,0);
  const result=await replay(value); assert.equal(result.complete,false); assert.match(result.missing.join(';'),/allocation/);
  const rows=verifiedAdapterImportMeasurements(value.result,cell); assert.equal(rows.length,5); assert.equal(rows.find(row=>row.name==='T06ArtifactHashOrDurabilityMismatchCount').value,0);
  assert(!rows.some(row=>row.name==='R18CpuAllocationBytes')); rows[0].value = 99; assert.equal(verifiedAdapterImportMeasurements(value.result,cell)[0].value,0); assert.equal(verifiedAdapterImportMeasurements(clone(value.result),cell).length,0);
});

test('ordinary campaign evaluation refuses copied serialized rows until retained replay authenticates this result', async t => {
  const value=await retained(t), rule={name:'T06ArtifactHashOrDurabilityMismatchCount',unit:'violations',ceiling:0,target:0};
  const selected={...cell,requiredMeasurements:[rule]}, attempts=[{...value.attempt,cache:'cold',prime:false,status:'INCONCLUSIVE'}];
  assert.equal(evaluateRequiredMeasurements(selected,attempts)[0].status,'INCONCLUSIVE'); await replay(value);
  assert.equal(evaluateRequiredMeasurements(selected,attempts)[0].status,'PASS');
  value.result.measurements[0].value=7; assert.equal(evaluateRequiredMeasurements(selected,attempts)[0].status,'INCONCLUSIVE');
});

test('retained re-sealing cannot hide an omitted dependency, changed full hash, event, receipt, role or qualification', async t => {
  const mutations=[
    p=>{p.metadata.pop();}, p=>{p.metadata[0].hash=digest('changed');}, p=>{p.imported.asset.dependencies.pop();},
    p=>{p.readBack[0].hash=digest('changed');}, p=>{p.readBack[1].bytes++;}, p=>{p.readBack[2].role='weights';},
    p=>{p.durability[0].receipt.status='rejected';}, p=>{p.durability[1].event.payload.asset.id='other';},
    p=>{p.durability[2].event.seq='999';}, p=>{p.imported.view.versionId='other';},
    p=>{p.imported.asset.adapter.validation.locallyEligible=true;}, p=>{p.imported.asset.adapter.validation.runtimeVerified=true;},
    p=>{p.imported.fixture.bytes++;}, p=>{p.phases[0].hash=digest('changed');},
  ];
  for(const mutation of mutations){const value=await retained(t);rewrite(value,mutation);await assert.rejects(replay(value));assert.equal(verifiedAdapterImportMeasurements(value.result,cell).length,0);}
});

test('wrong process, cold/warm, prime/scored and ordinal bindings cannot reuse an intact packet', async t => {
  for(const change of [p=>{p.workerProcessIdentity.pid++;},p=>{p.attemptId='AC1/unit-import/warm/scored/1';},p=>{p.attemptId='AC1/unit-import/cold/prime/1';},p=>{p.attemptId='AC1/unit-import/cold/scored/2';},p=>{p.cellId='AC1/other';},p=>{p.processIdentity=JSON.stringify({...JSON.parse(p.processIdentity),pid:9000});}]){
    const value=await retained(t);rewrite(value,change);await assert.rejects(replay(value));
  }
});

test('artifact mutation, fabricated rows and claimed PASS with missing resource evidence fail closed', async t => {
  let value=await retained(t);value.bytes=Buffer.concat([value.bytes,Buffer.from(' ')]);await assert.rejects(replay(value),/bytes changed/);
  value=await retained(t);value.result.measurements.push({name:'R18CpuAllocationBytes',value:0,unit:'bytes',method:'fixture',evidence:value.result.adapterImport});await assert.rejects(replay(value),/rows differ/);
  value=await retained(t);value.result.status='PASS';await assert.rejects(replay(value),/omits required/);
});

test('missing network guard remains unavailable and observed attempted effects remain nonzero', async t => {
  const absent=await retained(t,f=>{f.proof.ownedLookup=null;});await replay(absent);
  assert(!verifiedAdapterImportMeasurements(absent.result,cell).some(row=>row.name==='T06UnchangedOwnedAssetFetches'));
  const nonzero=await retained(t,f=>{f.proof.ownedLookup.after.fetch=1;});await replay(nonzero);
  assert.equal(verifiedAdapterImportMeasurements(nonzero.result,cell).find(row=>row.name==='T06UnchangedOwnedAssetFetches').value,1);
});

test('malformed, missing or decreasing counter buckets cannot become owned-hit zeroes', async t => {
  for(const change of [f=>{delete f.proof.ownedLookup.after.dns;},f=>{f.proof.ownedLookup.before.socket=1;},f=>{f.proof.ownedLookup.after.extra=0;},f=>{f.proof.ownedLookup.observed.versionId='other';}]) await assert.rejects(retained(t,change));
});

test('collector repeats receipts/events and closes private byte readers without calling public adapter content APIs', async t => {
  const f=fixture(),root=await directory(t),reads=[];let live=0,closed=0;
  for(const role of ['weights','config']) await stored(root,f.refs[role],f.data[role]);
  const resources={buffer(owner,kind,value){live+=value.buffer.byteLength;return()=>{live-=value.buffer.byteLength;closed++;};}};
  const writer={assetVerify:async()=>assert.fail('Adapter public content is intentionally withheld'),
    consumeMetadata:async(ref,consume)=>{const role=Object.keys(f.refs).find(role=>f.refs[role]===ref);reads.push(role);return consume(f.data[role]);},
    lookup:async id=>({receipt:f.phases.find(p=>p.commandId===id).receipt}),events:async from=>({events:[f.phases.find(p=>p.eventSeq===String(BigInt(from)+1n)).event]}),
    adapterView:async()=>f.imported.view};
  const actual=await collectAdapterImportProof({writer,root,resources,imported:f.imported,phases:f.phases});assert.equal(actual.ownedLookup,null);
  assert.deepEqual(actual.readBack,f.proof.readBack);assert.deepEqual(actual.metadata,f.proof.metadata);assert.deepEqual(actual.durability,f.proof.durability);
  assert.deepEqual(reads,['provenance','validation']);assert.equal(live,0);assert.equal(closed,3);
  writer.lookup=async()=>({receipt:{status:'rejected'}});await assert.rejects(collectAdapterImportProof({writer,root,resources,imported:f.imported,phases:f.phases}),/receipt changed/);
  assert.equal(live,0);
});

test('actual adapter storage keeps public bytes withheld while the private observer proves exact durable originals and metadata', {timeout:30000}, async t => {
  const {rootFor,command,encode} = await import('../store/helpers.mjs');
  const {openWriter} = await import('../../dist/local/server/storage/writer.js');
  const {EMPTY_EXPECTED_VERSIONS} = await import('../../dist/local/src/protocol/store.js');
  const {adapterResources} = await import('../../dist/local/server/observability/adapter-resources.js');
  const {writeAdapterFixture} = await import('../../tooling/qualification/campaigns/adapters.mjs');
  const root=await rootFor(t), output=await directory(t), writer=await openWriter({root});t.after(()=>writer.close());await writer.protocolDefaults();
  const now=Date.now(),auth={clientId:'client_1',sessionHash:'a'.repeat(64),now,expires:now+43200000},phases=[];
  async function commit(body,method,name) {
    const request=command(EMPTY_EXPECTED_VERSIONS,{documentId:null,expectedDocumentRevision:null,body});await writer[method](encode(request),auth);
    let record;
    for(let i=0;i<1000;i++){record=await writer.lookup(request.command.commandId);if(record)break;await new Promise(done=>setTimeout(done,5));}
    assert.equal(record?.receipt.status,'accepted');
    const event=(await writer.events(String(BigInt(record.receipt.fromSeq)-1n))).events.find(event=>event.commandId===request.command.commandId);
    assert(event);phases.push({name,commandId:request.command.commandId,commandType:body.type,receipt:record.receipt,eventSeq:event.seq,event,outcome:'expected'});return event.payload.asset;
  }
  async function stage(data,purpose,name) {
    const stagingId=randomUUID(),blob=reference(data,purpose==='adapter'?'application/octet-stream':'text/plain');
    await writer.assetCreate({protocolVersion:1,stagingId,purpose,expectedBytes:blob.byteLength,sha256:blob.hash,mediaType:blob.mediaType},auth);
    const token=await writer.assetBeginChunk(stagingId,'0',data.length,auth);await writer.assetChunk(token,data,auth);
    return commit({type:'FinalizeStaging',stagingId,expectedSha256:blob.hash},'assetCommand',name);
  }
  const fixture=await writeAdapterFixture(join(output,'unit.safetensors'),4096), weightBytes=await readFile(fixture.path), configBytes=Buffer.from('{}\n');
  const weights=await stage(weightBytes,'adapter','weights-stage-hash-durable'),config=await stage(configBytes,'caption','config-stage-hash-durable');
  const asset=await commit({type:'RegisterAdapterVersion',adapterId:null,previousVersionId:null,weightsAssetId:weights.id,configAssetId:config.id,provenanceAssetId:null,
    name:'Unit private readback',declaredFamily:'ideogram-v4',declaredFormat:'fal',provenanceText:'Structural correctness fixture only.'},'adapterCommand','header-profile-config-inspection-and-registration-durable');
  await assert.rejects(writer.assetVerify(weights.id),{code:'CONTENT_WITHHELD'});await assert.rejects(writer.assetVerify(asset.id),{code:'CONTENT_WITHHELD'});
  const imported={asset,view:await writer.adapterView(asset.id),storedAssets:{weights,config,registration:asset}};
  const proof=await collectAdapterImportProof({writer,root,resources:adapterResources,imported,phases});
  assert.equal(proof.readBack.length,3);assert.equal(proof.metadata.length,2);assert.equal(proof.durability.length,3);
  assert.equal(proof.readBack[0].hash,fixture.hash);assert.equal(proof.readBack[1].hash,digest(configBytes));
  assert.equal(proof.ownedLookup,null);assert.equal(imported.view.locallyEligible,false);assert.equal(imported.view.runtimeVerified,false);
});


// Small structural witnesses exercise the real retained summary pipeline. They
// do not stand in for exact-size WA inputs, resource coverage or host eligibility.
async function sealedImportCampaign(t, {rss = 300, status = 'INCONCLUSIVE', alter = async () => {}} = {}) {
  const output = await directory(t), requiredMeasurements = [
    {budgetId:'T05',name:'T05IncompleteOrUnverifiedIdentityAcceptanceCount',unit:'violations',target:0,ceiling:0},
    {budgetId:'T05',name:'T05BrowserTensorBytes',unit:'bytes',target:0,ceiling:0},
    {budgetId:'T06',name:'T06UnchangedOwnedAssetFetches',unit:'count',target:0,ceiling:0},
    {budgetId:'T06',name:'T06ArtifactHashOrDurabilityMismatchCount',unit:'violations',target:0,ceiling:0},
    {budgetId:'R17',name:'R17BackendRssBytes',unit:'bytes',target:256*chunk,ceiling:512*chunk},
    {budgetId:'R18',name:'R18CpuAllocationBytes',unit:'bytes',target:384*chunk,ceiling:512*chunk},
  ];
  const plannedCell = {...cell, cold:1, warm:0, primes:0, requiredMeasurements};
  const plan = {campaign:'P',selectedJobIds:['AC1'],jobs:[{id:'AC1',cells:[plannedCell]}],extraAuditCohorts:[]};
  const [scheduled] = executionGroups(plan), folder = scheduled.id.replace(/[^A-Za-z0-9_.-]/g, '_'), groupOutput = join(output, folder);
  await mkdir(groupOutput);
  const f = fixture(), retained = await retainAdapterImportObservation({output:groupOutput,cell:scheduled.cell,
    sample:{cache:'cold',ordinal:1,prime:false},workerProcessIdentity:worker,processIdentity,
    imported:f.imported,phases:f.phases,proof:f.proof,sampling:null,backendHighWaterRssBytes:rss});
  const value = {result:sanitize({status,elapsedMs:100,phases:f.phases,adapterImport:retained.observation,measurements:retained.measurements}),
    bytes:await readFile(retained.observation.artifact.path)};
  await alter(value);
  const result = value.result, initial = {id:cell.id+'/cold/scored/1',cache:'cold',ordinal:1,prime:false,status:'INCONCLUSIVE',reset:null,result:null};
  const attempt = {...initial,status,reset:{cache:'cold',fresh:true},startMs:110,endMs:210,resetElapsedMs:2,elapsedMs:100,result};
  const workerReceipt = {kind:'perf-campaign-process-1',schemaVersion:1,cell:scheduled.cell,cache:'cold',processIdentity:worker,
    startedAt:worker.startedAt,status,preparation:null,attempts:[attempt],cleanup:null,finishedAt:'unit-process-end'};
  const input = {...scheduled,output:groupOutput,repo:'/unit/subject',fixture:null,configuration:{}};
  const group = {...scheduled,...workerReceipt,output:groupOutput,timedOut:false,
    process:{exitCode:0,signal:null,timedOut:false,interrupted:false}};
  const source = {head:'a'.repeat(40),files:[],digest:digestJSON([])}, build = {files:[],missing:[],digest:digest([])};
  const receipt = {kind:'perf-runtime-campaign-1',subjectRepo:input.repo,plan,planDigest:digest(plan),groups:[group],
    host:{observed:{platform:'darwin'},attestation:null,hostChecks:[]},
    identity:{before:source,after:clone(source),controlBefore:clone(source),controlAfter:clone(source),buildsBefore:build,buildsAfter:clone(build),buildProvenance:null},
    inputIdentities:{hostAttestation:null,fixtureManifest:null,configuration:null,buildProvenance:null},evidence:[]};
  const writeJSON = async (path, data) => {
    await mkdir(dirname(join(output,path)),{recursive:true}); await writeFile(join(output,path),JSON.stringify(data,null,2)+'\n');
  };
  await writeJSON('plan.json',plan); await writeJSON('host.json',receipt.host);
  await writeJSON('source-before.json',receipt.identity.before); await writeJSON('source-after.json',receipt.identity.after);
  await writeJSON(folder+'/input.json',input); await writeJSON(folder+'/controller.json',group); await writeJSON(folder+'/receipt.json',workerReceipt);
  await writeFile(join(groupOutput,'process.log'),'structural import replay fixture\n');
  const journal = await createJournal(join(groupOutput,'events.jsonl'));
  try {
    for (const event of [
      {event:'process-start',cellId:cell.id,processIdentity:worker}, {event:'cell-prepared',preparation:null},
      {event:'attempt-start',attempt:initial},
      {event:'attempt-action-start',id:attempt.id,startMs:attempt.startMs,reset:attempt.reset,resetElapsedMs:attempt.resetElapsedMs},
      {event:'attempt-end',attempt}, {event:'process-cleanup',cleanup:null}, {event:'process-end',status},
    ]) await journal.append(event);
  } finally {await journal.close();}
  async function seal(directory, prefix = '') {
    for (const entry of await readdir(directory,{withFileTypes:true})) {
      const path = prefix+entry.name;
      if (entry.isDirectory()) await seal(join(directory,entry.name),path+'/');
      else if (entry.isFile()) receipt.evidence.push({path,...await fileIdentity(join(output,path))});
    }
  }
  await seal(output); receipt.evidence.sort((a,b)=>a.path.localeCompare(b.path));
  return {receipt,output,cell:scheduled.cell,result,attempt,group};
}

const structuralRowNames = [
  'R17BackendRssBytes', 'T05BrowserTensorBytes', 'T05IncompleteOrUnverifiedIdentityAcceptanceCount',
  'T06ArtifactHashOrDurabilityMismatchCount', 'T06UnchangedOwnedAssetFetches',
];
const summaryOptions = {hostEligible:false,sourceStable:true};
async function replaySerializedSummary(p, serialized, options = summaryOptions) {
  const result = serialized.groups[0].attempts[0].result;
  assert.equal(verifiedAdapterImportMeasurements(result,p.cell).length,0,'serialized scalar rows carry no replay authority');
  const replayed = await verifySealedEvidence(serialized,p.output);
  assert.equal(replayed.groups,1); assert.equal(replayed.attempts,1); assert.equal(replayed.byteAuditGroups,0);
  return summarize(serialized.plan,serialized.groups,{...options,
    nativeHotEdits:replayed.nativeHotEdits,nativeFirstUses:replayed.nativeFirstUses,nativeSessions:replayed.nativeSessions,
    nativeImes:replayed.nativeImes,nativeNavigations:replayed.nativeNavigations});
}

test('ordinary live summary authenticates retained import rows before matching serialized offline replay', async t => {
  const p = await sealedImportCampaign(t), serialized = JSON.parse(JSON.stringify(p.receipt));
  assert.equal(verifiedAdapterImportMeasurements(p.result,p.cell).length,0);
  const live = await summarizeRetainedCampaign(p.receipt,p.output,summaryOptions);
  assert.equal(p.receipt.nativeReplayError,undefined); assert.equal(p.receipt.runError,undefined);
  assert.deepEqual(verifiedAdapterImportMeasurements(p.result,p.cell).map(row=>row.name).sort(),structuralRowNames);
  assert.equal(live.status,'INCONCLUSIVE'); assert.equal(live.qualification,false); assert.deepEqual(live.integrityErrors,[]);
  assert.deepEqual(live.cells[0].measurements.filter(row=>row.status==='PASS').map(row=>row.name).sort(),structuralRowNames);
  const absent = live.cells[0].measurements.find(row=>row.name==='R18CpuAllocationBytes');
  assert.equal(absent.status,'INCONCLUSIVE'); assert.equal(absent.observations[0].value,null); assert(!absent.observations[0].valid);
  const offline = await replaySerializedSummary(p,serialized); assert.deepEqual(offline,live);
  assert.deepEqual(verifiedAdapterImportMeasurements(serialized.groups[0].attempts[0].result,p.cell),verifiedAdapterImportMeasurements(p.result,p.cell));
});

test('ordinary live and offline summaries preserve proven R17 failure while R18 coverage is unavailable', async t => {
  const p = await sealedImportCampaign(t,{rss:512*chunk+1}), serialized = JSON.parse(JSON.stringify(p.receipt));
  assert.equal(p.group.status,'INCONCLUSIVE'); assert.equal(p.attempt.status,'INCONCLUSIVE');
  assert.equal(verifiedAdapterImportMeasurements(p.result,p.cell).length,0);
  const live = await summarizeRetainedCampaign(p.receipt,p.output,summaryOptions);
  assert.equal(p.receipt.nativeReplayError,undefined); assert.equal(live.status,'FAIL'); assert.equal(live.cells[0].status,'FAIL'); assert.equal(live.qualification,false);
  const measured = live.cells[0].measurements.find(row=>row.name==='R17BackendRssBytes');
  assert.equal(measured.status,'FAIL'); assert.equal(measured.observations[0].value,512*chunk+1); assert.equal(measured.observations[0].valid,true);
  assert.equal(live.cells[0].measurements.find(row=>row.name==='R18CpuAllocationBytes').status,'INCONCLUSIVE');
  assert.deepEqual(await replaySerializedSummary(p,serialized),live);
});

test('ordinary live summary rejects resealed corrupt proof and preserves an independently failed attempt', async t => {
  for (const status of ['INCONCLUSIVE','FAIL']) {
    const p = await sealedImportCampaign(t,{status,alter:async value=>{
      rewrite(value,packet=>{packet.metadata[0].hash=digest('substituted metadata');});
      await writeFile(value.result.adapterImport.artifact.path,value.bytes);
    }}), serialized = JSON.parse(JSON.stringify(p.receipt));
    assert.equal(verifiedAdapterImportMeasurements(p.result,p.cell).length,0);
    const live = await summarizeRetainedCampaign(p.receipt,p.output,summaryOptions);
    assert.match(p.receipt.nativeReplayError?.message ?? '',/Imported metadata full hash\/length differs/);
    assert.deepEqual(p.receipt.runError,p.receipt.nativeReplayError);
    assert.equal(verifiedAdapterImportMeasurements(p.result,p.cell).length,0);
    assert(live.cells[0].measurements.every(row=>row.status==='INCONCLUSIVE'));
    assert.equal(live.status,status); assert.equal(live.qualification,false);
    await assert.rejects(verifySealedEvidence(serialized,p.output),/Imported metadata full hash\/length differs/);
  }
});

test('ordinary cell triggers live replay after its adapter artifact is omitted despite fabricated passing rows', async t => {
  const p = await sealedImportCampaign(t,{status:'PASS',alter:async value=>{
    await rm(value.result.adapterImport.artifact.path); delete value.result.adapterImport;
    value.result.measurements=value.result.measurements.map(row=>({...row,evidence:{kind:'unverified-unit-claim'}}));
    value.result.measurements.push({name:'R18CpuAllocationBytes',value:0,unit:'bytes',method:'unverified unit claim',evidence:{kind:'unverified-unit-claim'}});
  }}), serialized = JSON.parse(JSON.stringify(p.receipt));
  assert.equal(p.result.adapterImport,undefined); assert(!p.receipt.evidence.some(file=>file.path.includes('/adapter-import-')));
  assert.equal(verifiedAdapterImportMeasurements(p.result,p.cell).length,0);
  const live = await summarizeRetainedCampaign(p.receipt,p.output,summaryOptions);
  assert.match(p.receipt.nativeReplayError?.message ?? '',/Passing ordinary import lacks retained proof/);
  assert.deepEqual(p.receipt.runError,p.receipt.nativeReplayError); assert.equal(live.status,'INCONCLUSIVE'); assert.equal(live.qualification,false);
  assert(live.cells[0].measurements.every(row=>row.status==='INCONCLUSIVE' && row.observations.every(observation=>!observation.valid)));
  assert.equal(verifiedAdapterImportMeasurements(p.result,p.cell).length,0);
  await assert.rejects(verifySealedEvidence(serialized,p.output),/Passing ordinary import lacks retained proof/);
});


test('successful retained replay preserves caller audit records and their definite failure', async t => {
  const p = await sealedImportCampaign(t), serialized = JSON.parse(JSON.stringify(p.receipt));
  // An unexpected failed audit is an adversarial summary input, not qualifying D11 evidence.
  // The replay report has a zero audit count; it must neither replace nor discard this array.
  const byteAuditGroups = [{id:'unexpected-unit-byte-audit',cell:p.cell,status:'FAIL',attempts:[]}];
  const options = {...summaryOptions,byteAuditGroups}, before = structuredClone(options);
  const live = await summarizeRetainedCampaign(p.receipt,p.output,options);
  assert.equal(p.receipt.nativeReplayError,undefined); assert.equal(p.receipt.runError,undefined);
  assert.equal(live.status,'FAIL'); assert.equal(live.qualification,false);
  assert.equal(live.byteAudits.status,'FAIL'); assert.equal(live.byteAudits.plannedGroups,0); assert.equal(live.byteAudits.executedGroups,1);
  assert.deepEqual(live.byteAudits.errors,['Byte audit contract/order differs: unexpected-unit-byte-audit']);
  assert.deepEqual(verifiedAdapterImportMeasurements(p.result,p.cell).map(row=>row.name).sort(),structuralRowNames);
  assert.deepEqual(await replaySerializedSummary(p,serialized,options),live);
  assert.deepEqual(options,before,'summary must not mutate the supplied audit records');
});
