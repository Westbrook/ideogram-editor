import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {isAbsolute, join} from 'node:path';
import {readVerifiedNavigationBounds, navigationWindowServerMeasurement}
  from '../../tooling/qualification/campaigns/windowserver-navigation-verification.mjs';
import {windowServerNavigationSpecimen, navigationSpecimenUUID}
  from './support/windowserver-navigation-specimen.mjs';

const bounds = (f, proof) => readVerifiedNavigationBounds(proof, f.attempt.result.nativeNavigation, {cell:f.cell,sample:f.sample});
const rejectOptions = async (t, cases) => {
  for (const [name,options] of cases) {
    const f=await windowServerNavigationSpecimen(t,options);
    await assert.rejects(f.replay,undefined,name);
  }
};

test('H1 offline replay admits three relocated original captures for both workloads and caches', async t => {
  for (const workload of ['W0','W1']) for (const cache of ['cold','warm']) {
    const f=await windowServerNavigationSpecimen(t,{workload,cache}), proof=await f.replay();
    assert.ok(proof); assert.equal(proof.qualification,false);
    const value=bounds(f,proof);
    assert.equal(value.exactLatency,false);
    assert.deepEqual(value.semantic,{complete:true,falsePendingOrCompletionCount:0,missing:[]});
    for (const [endpoint,expected,ceiling] of [['shell',50,750],['canvas',250,cache==='cold'?4000:2000]]) {
      assert.equal(value[endpoint].upperBoundMs,expected);
      assert.equal(value[endpoint].ceilingMs,ceiling);
      assert.equal(value[endpoint].exactLatencyMs,null);
      assert.equal(value[endpoint].observationId,f.attempt.id);
      assert.equal(value[endpoint].endpoint,'WindowServer-presented-semantic-pixels');
      assert.deepEqual(value[endpoint].artifact,f.attempt.result.nativeNavigation.artifact);
    }
    assert.deepEqual(f.resolutions,['anchor','shell','canvas'].map(stage=>f.folders[stage]+'/build-evidence/manifest.json'));
    assert.ok(f.reads.length>30); assert.ok(f.reads.every(path=>!isAbsolute(path)));
    assert.equal(f.attempt.result.nativeNavigation.binding.oracles.shell.pixels,'[omitted: private payload]');
    assert.ok(!f.archive.startsWith(f.groupOutput+'/'));
    await assert.rejects(readFile(join(f.historicalRoot,'compiler')),{code:'ENOENT'});
  }
});

test('genuine H1 proof is detached and cannot be copied, serialized or rebound to another observation', async t => {
  const f=await windowServerNavigationSpecimen(t), proof=await f.replay(); assert.ok(proof);
  const value=bounds(f,proof); value.canvas.upperBoundMs=0; value.shell.ceilingMs=0;
  assert.equal(bounds(f,proof).canvas.upperBoundMs,250); assert.equal(bounds(f,proof).shell.ceilingMs,750);
  for (const copied of [{...proof},structuredClone(proof),JSON.parse(JSON.stringify(proof)),{kind:proof.kind,verified:true}]) {
    assert.equal(bounds(f,copied),null);
  }
  for (const change of [value=>{value.joins.canvas.upperBoundMs=1;},value=>{value.navigationNonce='b'.repeat(48);},
    value=>{value.artifact.sha256='0'.repeat(64);},value=>{value.readiness.canvas.witness.canonical.revision='2';}]) {
    const observation=structuredClone(f.attempt.result.nativeNavigation); change(observation);
    assert.equal(readVerifiedNavigationBounds(proof,observation,{cell:f.cell,sample:f.sample}),null);
  }
  for (const cell of [{...f.cell,jobId:'H2'},{...f.cell,id:'H1/chromium-W1-ready',workload:'W1'},
    {...f.cell,parameters:{browser:'firefox'}}]) {
    assert.equal(readVerifiedNavigationBounds(proof,f.attempt.result.nativeNavigation,{cell,sample:f.sample}),null);
  }
  for (const sample of [{...f.sample,ordinal:2},{...f.sample,cache:'warm'},{...f.sample,prime:true}]) {
    assert.equal(readVerifiedNavigationBounds(proof,f.attempt.result.nativeNavigation,{cell:f.cell,sample}),null);
  }
});

test('H1 native R05 upper bound preserves null exact values and refuses over-cap claims', async t => {
  for (const cache of ['cold','warm']) {
    const f=await windowServerNavigationSpecimen(t,{cache}), proof=await f.replay(), rule=f.cell.requiredMeasurements[0];
    const admitted=navigationWindowServerMeasurement({cell:f.cell,sample:f.sample,rule,observation:f.attempt.result.nativeNavigation,proof});
    assert.deepEqual(admitted.measurement,f.attempt.result.measurements[0]);
    assert.equal(admitted.measurement.value,null); assert.equal(admitted.measurement.bound,'upper');
    const late=await windowServerNavigationSpecimen(t,{cache,canvasUpperBoundMs:rule.ceiling+0.001});
    const lateProof=await late.replay(); assert.ok(lateProof);
    const unavailable=navigationWindowServerMeasurement({cell:late.cell,sample:late.sample,rule,observation:late.attempt.result.nativeNavigation,proof:lateProof});
    assert.equal(Object.hasOwn(unavailable,'measurement'),false); assert.match(unavailable.reason,/exceeds the cap/);
    assert.deepEqual(late.attempt.result.measurements.map(value=>value.name),['R04FalsePendingOrCompletionCount']);
    assert.equal(late.attempt.result.measurements[0].value,0);
  }
});

test('the same retained status snapshot proves zero or real nonzero violations after optional recovery auto-open', async t => {
  for(const autoOpen of [false,true])for(const falsePendingOrCompletionCount of [0,1,2]){
    const f=await windowServerNavigationSpecimen(t,{autoOpen,falsePendingOrCompletionCount}),proof=await f.replay();assert.ok(proof);
    assert.deepEqual(bounds(f,proof).semantic,{complete:true,falsePendingOrCompletionCount,missing:[]});
    const rule=f.cell.requiredMeasurements.find(value=>value.name==='R04FalsePendingOrCompletionCount');
    const admitted=navigationWindowServerMeasurement({cell:f.cell,sample:f.sample,rule,observation:f.attempt.result.nativeNavigation,proof});
    assert.deepEqual(admitted.measurement,f.attempt.result.measurements.find(value=>value.name===rule.name));
    assert.equal(admitted.measurement.value,falsePendingOrCompletionCount);
    assert.equal(f.attempt.status,falsePendingOrCompletionCount?'FAIL':'PASS');
    assert.deepEqual(f.attempt.result.observations.productPhases,f.attempt.result.evidence.productPhases);
  }
});

test('incomplete semantic ledgers preserve native bounds without substituting a zero violation count', async t => {
  for(const change of [value=>{value.status.dropped=1;},value=>{value.status.invalid=1;},value=>{value.status.closed=true;},
    value=>{value.witness=null;},value=>{value.phaseSnapshot.trace.records=[];},value=>{value.authority('checkpoint').commandId='different-command';}]){
    const f=await windowServerNavigationSpecimen(t,{mutateSemantic:change}),proof=await f.replay();assert.ok(proof);
    const semantic=bounds(f,proof).semantic;assert.equal(semantic.complete,false);assert.equal(semantic.falsePendingOrCompletionCount,null);
    assert.ok(semantic.missing.length>0);assert.equal(bounds(f,proof).canvas.upperBoundMs,250);
    assert.equal(f.attempt.result.measurements.some(value=>value.name==='R04FalsePendingOrCompletionCount'),false);
    const row=navigationWindowServerMeasurement({cell:f.cell,sample:f.sample,rule:f.cell.requiredMeasurements[1],observation:f.attempt.result.nativeNavigation,proof});
    assert.equal(Object.hasOwn(row,'measurement'),false);assert.match(row.reason,/ledger is incomplete/);
  }
});

test('semantic status must belong to the fresh realm and the exact original outer phase snapshot', async t => {
  await rejectOptions(t,[
    ['different document clock',{mutateSemantic:value=>{value.status.timeOriginMs++;}}],
    ['driver-only phase edit',{mutateProducer:value=>{value.observations.productPhases=structuredClone(value.observations.productPhases);value.observations.productPhases.trace.records[0].durationMs++;}}],
    ['outer phase omission',{mutateProducer:value=>{value.evidence.productPhases=null;}}],
    ['driver-only ledger edit',{mutateProducer:value=>{value.observations.navigationSemantic=structuredClone(value.observations.navigationSemantic);value.observations.navigationSemantic.status.rows[0].cursor='1';}}],
  ]);
});

test('resealed caller measurements cannot turn an incomplete status ledger into zero violations', async t => {
  const f=await windowServerNavigationSpecimen(t,{mutateSemantic:value=>{value.status.dropped=1;},mutateProducer:value=>{
    const native=value.nativeNavigation;
    value.measurements.push({name:'R04FalsePendingOrCompletionCount',value:0,unit:'violations',
      method:'Replayed original synchronous navigation status ledger and accepted command authority',
      evidence:{kind:'navigation-semantic-ledger-1',artifact:native.artifact,navigationNonce:native.navigationNonce,
        observationId:native.binding.attempt.attemptId,timeOriginMs:native.semanticWitness.status.timeOriginMs}});
  }});
  await assert.rejects(f.replay,/published measurements differ/);
});

test('every retained native stage rejects changed raw records, pixels, config, process and build closure', async t => {
  const f=await windowServerNavigationSpecimen(t);
  for (const stage of ['anchor','shell','canvas']) for (const member of [
    'capture/frame-1.bgra','capture/frames.ndjson','capture/manifest.json','config.json','process.json','stdout.ndjson','stderr.log',
    'build-evidence/collector.swift','build-evidence/windowserver-capture','build-evidence/build-receipt.json',
    'build-evidence/sdk-manifest.json','build-evidence/manifest.json',
  ]) {
    const path=f.folders[stage]+'/'+member, original=await readFile(f.path(path));
    await f.write(path,Buffer.from('changed original member\n')); await assert.rejects(f.replay,undefined,path);
    await f.write(path,original);
  }
});

test('original browser producer, immutable input, runtime, raw authority and oracle bytes cannot drift', async t => {
  const f=await windowServerNavigationSpecimen(t);
  const paths=[f.rawName,f.producerName,'input.json','browser-runtime.json',
    ...['browser','backend'].map((_,i)=>'owned-process-'+(23+i)+'-'+navigationSpecimenUUID+'.json'),
    ...['shell','canvas'].flatMap(stage=>['oracle.json','before.bgra','after.bgra'].map(name=>f.oracleFolders[stage]+'/'+name))];
  for (const path of paths) {
    const original=await readFile(f.path(path));
    await f.write(path,Buffer.from('changed original authority\n')); await assert.rejects(f.replay,undefined,path);
    await f.write(path,original);
  }
});

test('missing original raw closure is unavailable and cannot be replaced with caller JSON', async t => {
  const f=await windowServerNavigationSpecimen(t);
  const paths=[f.rawName,f.producerName,'input.json','browser-runtime.json',
    ...['anchor','shell','canvas'].flatMap(stage=>['process.json','capture/frame-1.bgra','build-evidence/sdk-manifest.json'].map(name=>f.folders[stage]+'/'+name)),
    ...['shell','canvas'].map(stage=>f.oracleFolders[stage]+'/after.bgra')];
  for (const path of paths) {
    f.forget(path); assert.equal(await f.replay(),null,path); f.context.retainedPaths.push(path);
  }
  f.context.retainedPaths=[];
  f.attempt.result.nativeNavigation.verified=true;
  assert.equal(await f.replay(),null);
});

test('offline retained boundaries reject duplicate, escaping and unlisted capture or oracle members', async t => {
  for (const path of ['../outside','/outside','capture\\outside','a//b','a/./b']) {
    const f=await windowServerNavigationSpecimen(t); f.context.retainedPaths.push(path); await assert.rejects(f.replay,/retained member/);
  }
  const duplicate=await windowServerNavigationSpecimen(t); duplicate.context.retainedPaths.push(duplicate.rawName);
  await assert.rejects(duplicate.replay,/Duplicate/);
  for (const family of ['capture','oracle']) {
    const f=await windowServerNavigationSpecimen(t);
    f.context.retainedPaths.push(family==='capture'?f.folders.shell+'/capture/frame-2.bgra':f.oracleFolders.shell+'/other.bgra');
    await assert.rejects(f.replay,/membership|directory differs/);
  }
  const unbounded=await windowServerNavigationSpecimen(t);
  unbounded.context.readRetained=async (_path,{maximum})=>Buffer.alloc(maximum+1);
  await assert.rejects(unbounded.replay,/bounded reader/);
});

test('native process failures remain unavailable while resealed ownership and build forgery reject', async t => {
  for (const change of [value=>{value.close.code=1;},value=>{value.exit.signal='SIGTERM';},
    value=>{value.cleanupErrors.push({message:'not closed'});},value=>{value.requestedSignals.push('SIGKILL');},
    value=>{value.outcome='INCONCLUSIVE';}]) {
    const f=await windowServerNavigationSpecimen(t,{mutateProcess:({stage,process})=>{if(stage==='shell')change(process);}});
    assert.equal(await f.replay(),null);
  }
  await rejectOptions(t,[
    ['owner', {mutateProcess:({stage,process})=>{if(stage==='shell')process.processIdentity.ownerPid++;}}],
    ['birth', {mutateProcess:({stage,process})=>{if(stage==='shell')process.processIdentity.startedAtIdentity='another-birth';}}],
    ['command', {mutateProcess:({stage,process})=>{if(stage==='shell')process.command[1]='/outside/config.json';}}],
    ['binary', {mutateProcess:({stage,process})=>{if(stage==='shell')process.executable.sha256='0'.repeat(64);}}],
    ['source', {mutateProcess:({stage,process})=>{if(stage==='shell')process.build.sourceSha256='0'.repeat(64);}}],
    ['receipt', {mutateProcess:({stage,process})=>{if(stage==='shell')process.buildEvidence.receiptSha256='0'.repeat(64);}}],
    ['capture path', {mutateProcess:({stage,process})=>{if(stage==='shell')process.outputDirectory='/outside/capture';}}],
    ['process alias', {mutateNative:value=>{value.captures.canvas.process.receipt.path='/outside/process.json';}}],
  ]);
});

test('outer source, fixture, worker, configuration and prepared-browser authority must match originals', async t => {
  for (const change of [
    f=>{f.context.controlFiles[0].sha256='0'.repeat(64);},f=>{f.context.controlFiles.pop();},f=>{f.context.sourceFiles=[];},
    f=>{f.context.workerProcessIdentity.pid++;},f=>{f.context.workerProcessIdentity.startedAt='2026-10-01T00:00:00.000Z';},
    f=>{f.context.sourceRoot='/another/source';},f=>{f.context.fixture.seal.sha256='0'.repeat(64);},
    f=>{f.context.environment.sourceDigest='sha256:'+'0'.repeat(64);},f=>{f.context.environment.buildDigest='sha256:'+'0'.repeat(64);},
    f=>{f.context.configuration.browser.windowServerNavigation.profiles[0].canvas.sha256='0'.repeat(64);},
    f=>{f.context.browserCache='/another/cache';},f=>{f.context.developerState.state.h.completed=false;},
    f=>{f.context.developerStateIdentity=null;},f=>{f.context.tools.browserPins.browsers[0].revision='another-revision';},
  ]) {const f=await windowServerNavigationSpecimen(t);change(f);await assert.rejects(f.replay);}
  const absent=await windowServerNavigationSpecimen(t);delete absent.context.configuration.browser.windowServerNavigation;
  assert.equal(await absent.replay(),null);
});

test('headed owned browser and backend cannot be replaced by plausible runtime labels', async t => {
  await rejectOptions(t,[
    ['headless',{mutateBrowser:({runtime})=>{runtime.headless=true;}}],
    ['external Playwright',{mutateBrowser:({runtime})=>{runtime.playwrightModule='/foreign/node_modules/playwright/index.js';}}],
    ['unowned context',{mutateBrowser:({runtime})=>{runtime.ownedLaunch.context.createdBy='caller-asserted';}}],
    ['birth',{mutateBrowser:({runtime})=>{runtime.ownedLaunch.process.startedAtIdentity='another-birth';}}],
    ['version',{mutateBrowser:({runtime})=>{runtime.version='another-version';}}],
    ['revision',{mutateBrowser:({runtime})=>{runtime.revision='another-revision';}}],
    ['executable',{mutateBrowser:({runtime})=>{runtime.executableIdentity.sha256='sha256:'+'0'.repeat(64);}}],
  ]);
  for (const pid of [23,24]) {
    const f=await windowServerNavigationSpecimen(t);f.forget('owned-process-'+pid+'-'+navigationSpecimenUUID+'.json');
    await assert.rejects(f.replay,/ownership is absent/);
  }
});

test('native frame geometry, window ownership and native ACK order are replayed independently', async t => {
  await rejectOptions(t,[
    ['window owner',{mutateCapture:({stage,rows})=>{if(stage==='shell')rows[0].ownerPID++;}}],
    ['window number',{mutateCapture:({stage,rows})=>{if(stage==='shell')rows[0].windowNumber++;}}],
    ['occluded frame',{mutateCapture:({stage,rows})=>{if(stage==='shell')rows[0].intersectingAboveWindowCount=1;}}],
    ['occluded admission',{mutateCapture:({stage,admission})=>{if(stage==='shell')admission.intersectingAboveWindowCount=1;}}],
    ['scaled pixels',{mutateCapture:({stage,geometry})=>{if(stage==='shell')geometry.pointPixelScale=2;}}],
    ['window callback',{mutateCapture:({stage,rows})=>{if(stage==='shell')rows[0].windowObservationMach='1';}}],
    ['different timebase',{mutateCapture:({stage,timebase})=>{if(stage==='canvas')timebase.numer=2;}}],
    ['ACK name',{mutateNative:value=>{value.readiness.shell.ack.id='invented-clock';}}],
    ['ACK value',{mutateNative:value=>{value.readiness.canvas.ack.mach='999999999';}}],
    ['after-navigation anchor',{mutateNative:value=>{value.anchor.after={...value.anchor.before,id:'invented-after'};}}],
    ['dispatch',{mutateNative:value=>{value.anchor.dispatchCompleted=false;}}],
  ]);
});

test('resealed capture stages cannot overlap or reverse native and public readiness order', async t => {
  await rejectOptions(t,[
    ['anchor overlaps shell',{mutateCapture:({stage,timing})=>{if(stage==='shell')timing.startedMach='9000000';}}],
    ['shell overlaps canvas',{mutateCapture:({stage,timing})=>{if(stage==='canvas')timing.startedMach='50000000';}}],
    ['public readiness reversed',{mutateNative:value=>{value.readiness.shell.receivedRunnerMs=201;}}],
  ]);
});

test('semantic oracles cover the whole selected shell or canonical canvas and exact fixture environment', async t => {
  await rejectOptions(t,[
    ['marker oracle',{mutateOracle:({endpoint,oracle})=>{if(endpoint==='shell')oracle.subject='marker-square';}}],
    ['wrong fixture',{mutateOracle:({endpoint,oracle})=>{if(endpoint==='shell')oracle.binding.fixtureSha256='0'.repeat(64);}}],
    ['wrong browser',{mutateOracle:({endpoint,oracle})=>{if(endpoint==='shell')oracle.binding.browserEnvironmentSha256='0'.repeat(64);}}],
    ['wrong build',{mutateOracle:({endpoint,oracle})=>{if(endpoint==='canvas')oracle.binding.buildDigest='0'.repeat(64);}}],
    ['partial viewport',{mutateOracle:({endpoint,oracle})=>{if(endpoint==='shell')oracle.coverage.cssRectangle.width=1;}}],
    ['pending image',{mutateOracle:({endpoint,oracle})=>{if(endpoint==='canvas')oracle.after.state='pending';}}],
    ['wrong document',{mutateOracle:({endpoint,oracle})=>{if(endpoint==='canvas')oracle.canonical={...oracle.canonical,documentId:'another-document'};}}],
  ]);
});

test('resealed public witnesses still require a fresh visible realm, enabled controls and accepted stable edit', async t => {
  await rejectOptions(t,[
    ['old realm',{mutateNative:value=>{value.readiness.shell.witness.navigation.previousTimeOrigin=value.readiness.shell.witness.navigation.timeOrigin;}}],
    ['hidden realm',{mutateNative:value=>{value.readiness.shell.witness.navigation.visibility='hidden';}}],
    ['reload',{mutateNative:value=>{value.readiness.shell.witness.navigation.entry.type='reload';}}],
    ['disabled Open',{mutateNative:value=>{value.readiness.shell.witness.controls[1].enabled=false;}}],
    ['pending recovery',{mutateNative:value=>{value.readiness.shell.witness.recoveryText='Still pending';}}],
    ['unstable revision',{mutateNative:value=>{value.readiness.canvas.witness.stableRevision=false;}}],
    ['wrong accepted edit',{mutateNative:value=>{value.readiness.canvas.witness.acceptedEdit.documentRevision='2';}}],
    ['ACK before witness',{mutateNative:value=>{value.readiness.canvas.requestRunnerMs=199;}}],
    ['receipt before request',{mutateNative:value=>{value.readiness.canvas.receivedRunnerMs=200;}}],
    ['witness before dispatch',{mutateNative:value=>{value.readiness.shell.witness.readyMs=109;}}],
  ]);
});

test('producer normalization and public-action aliases cannot manufacture observed native bounds', async t => {
  for (const change of [
    value=>{value.nativeNavigation.joins.canvas.upperBoundMs=1;},value=>{value.measurements[0].upperBoundMs=1;},
    value=>{value.observations.publicOpenCompleted=false;},value=>{value.observations.acceptedTestEdit=false;},
    value=>{value.nativeNavigation.artifact.sha256='0'.repeat(64);},
  ]) {
    const f=await windowServerNavigationSpecimen(t);change(f.attempt.result);await assert.rejects(f.replay);
  }
  await rejectOptions(t,[
    ['recomputed published measurement',{mutateProducer:value=>{value.measurements[0].upperBoundMs=1;}}],
    ['resealed action flag',{mutateProducer:value=>{value.observations.publicOpenCompleted=false;}}],
    ['invented native join',{mutateNative:value=>{value.joins.canvas.upperBoundMs=1;}}],
    ['self-pinned raw authority',{mutateNative:value=>{value.artifact={path:'/forged',sha256:'0'.repeat(64),bytes:0};}}],
    ['different realm',{mutateProducer:value=>{value.observations.navigation={...value.observations.navigation,timeOrigin:300000};}}],
  ]);
});

test('incomplete native observations cannot be rescued by success labels', async t => {
  for (const options of [
    {mutateNative:value=>{value.missing.push('missing-semantic-endpoint');}},
    {mutateNative:value=>{value.failures.push('capture-failed');}},
  ]) {const f=await windowServerNavigationSpecimen(t,options);assert.equal(await f.replay(),null);}
});

test('an original failure retains replayable bounds without erasing the failed attempt', async t => {
  const f=await windowServerNavigationSpecimen(t,{mutateProducer:value=>{value.status='FAIL';}});
  const proof=await f.replay();assert.ok(proof);
  assert.equal(f.attempt.status,'FAIL');assert.equal(f.attempt.result.status,'FAIL');
  assert.equal(bounds(f,proof).canvas.upperBoundMs,250);
});

test('original scheduled attempt and runner window remain required after normalization', async t => {
  for (const change of [
    f=>{f.attempt.id+='-other';},f=>{f.attempt.cache='warm';},f=>{f.attempt.ordinal=2;},f=>{f.attempt.prime=true;},
    f=>{f.context.cell={...f.cell,parameters:{browser:'chromium',unselected:true}};},
  ]) {const f=await windowServerNavigationSpecimen(t);change(f);await assert.rejects(f.replay);}
  const missingProducer=await windowServerNavigationSpecimen(t);missingProducer.context.serial++;
  assert.equal(await missingProducer.replay(),null);
  const f=await windowServerNavigationSpecimen(t);
  await f.rewrite('input.json',value=>{value.attempts=[];});
  await assert.rejects(f.replay,/immutable schedule/);
});
