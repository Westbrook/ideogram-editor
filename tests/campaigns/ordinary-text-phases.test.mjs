import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {inspectOrdinaryTextObservation} from '../../tooling/qualification/campaigns/ordinary-text-phases.mjs';

const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
// Synthetic scalar observations exercise pure admission only. They cannot
// issue campaign authority, native input, physical presentation or R07 proof.
function fixture(operation = 'text.font-set') {
  const binding = {actionId:'preview-a',documentId:'document-a',documentRevision:'3',layerId:'layer-a',layerVersion:'2',
    sessionId:'session-a',draftId:'draft-a',generation:7,sourceHash:hash('Text'),dependencyHash:hash('dependencies'),
    rasterHash:hash('pixels'),width:20,height:10,fontFaces:4,fontBytes:1024};
  const preview = {id:'preview-a',generation:7,layerVersion:'2',textHash:binding.sourceHash,dependencyHash:binding.dependencyHash,
    rasterHash:binding.rasterHash,width:20,height:10};
  const state = {active:true,...Object.fromEntries(['documentId','documentRevision','layerId','layerVersion','sessionId','draftId','generation','sourceHash'].map(key=>[key,binding[key]])),savedGeneration:7,
    preview:null,canvas:null};
  const trace = (lane, records = [], origin = 1000) => ({schemaVersion:1,lane,clockOriginUnixMs:origin,clockUncertaintyMs:null,records,dropped:0,invalid:0});
  const product = () => ({schemaVersion:1,trace:trace('browser-main'),workerObservations:{schemaVersion:1,traces:[],dropped:0,invalid:0,clockJoin:'external-calibration-required'}});
  const before = {timeOrigin:1000,observedMs:90,state:clone(state),productPhases:product()};
  const after = {timeOrigin:1000,observedMs:220,state:clone(state),productPhases:product()};
  const actualGeneration = 7;
  const common = {documentId:'document-a',revision:'3',layerId:'layer-a',sessionId:'session-a',generation:actualGeneration};
  const font = {sequence:1,phase:'font.ready',startedMs:10,endedMs:50,durationMs:40,outcome:'ok',context:{...common,count:4,bytes:1024,boundary:'observed'}};
  const layout = {sequence:1,phase:'text.layout',startedMs:100,endedMs:200,durationMs:100,outcome:'incomplete',context:{...common,snapshotId:'draft-a',previewId:'preview-a',
    assetHash:binding.rasterHash,evidenceHash:binding.dependencyHash,width:20,height:10,boundary:operation === 'text.apply' ? 'authority-durable' : 'render-submitted'}};
  after.productPhases.trace.records.push(layout);
  after.productPhases.workerObservations.traces.push(trace('text-worker',[font],4000));
  const ready = value => {value.preview = clone(preview);value.canvas={sha256:binding.rasterHash,width:20,height:10};};
  if (operation === 'text.apply') {
    ready(before.state);after.state={active:false};
    after.receipt={commandId:'command-a',correlationId:'correlation-a',transactionId:'transaction-a',resultingRevision:'4',draft:{sessionId:'session-a',draftId:'draft-a',generation:'7'}};
    after.accepted={documentId:'document-a',documentRevision:'4',layerId:'layer-a',layerVersion:'3',sourceHash:binding.sourceHash,dependencyHash:binding.dependencyHash,rasterHash:binding.rasterHash,width:20,height:10};
    for(const key of ['commandId','correlationId','transactionId','resultingRevision'])layout.context[key]=after.receipt[key];
  } else ready(after.state);
  return {operation,binding,before,after};
}
const layout = value => value.after.productPhases.trace.records[0];
const worker = value => value.after.productPhases.workerObservations.traces[0];

test('fresh exact preparation admits separate worker and submission scopes without physical authority',()=>{
  for(const operation of ['text.font-set','text.active-layout']) {
    const result=inspectOrdinaryTextObservation(fixture(operation));assert.equal(result.status,'PASS');assert.deepEqual(result.missing,[]);assert.deepEqual(result.failures,[]);
    assert.deepEqual(result.phases.map(row=>row.name),['text.font-ready.worker','text.preview.render-submitted']);
    assert.deepEqual(result.phases.map(row=>row.durationMs),[40,100]);assert.deepEqual(result.phases.map(row=>row.clockOriginUnixMs),[4000,1000]);
    assert.equal(result.qualification,false);assert.equal(result.physicalPresentation,false);assert.equal(result.clockJoin,'none');
    assert.equal(result.evidence.fullR34DurationMs,null);assert.equal(result.evidence.fontRegistration.fullFontSetDurationMs,null);
    assert.equal(result.evidence.registrationUpperBound.exactMs,null);assert.equal(result.evidence.registrationUpperBound.ceilingBreachProvesFailure,false);
    assert(result.phases.every(row=>!['text.font-set','text.active-layout','text.apply'].includes(row.name)));
  }
});

test('Apply joins the actual unchanged or once-saved generation, receipt and source without claiming canonical viewport paint',()=>{
  const value=fixture('text.apply'),result=inspectOrdinaryTextObservation(value);assert.equal(result.status,'PASS');
  assert.equal(result.evidence.generation,7);assert.equal(result.phases[1].name,'text.apply.authority-durable');assert.equal(result.phases[1].context.commandId,'command-a');
  assert.equal(result.evidence.registrationUpperBound,null);assert.equal(result.evidence.firstPaint,false);assert.equal(result.evidence.physicalScanout,false);assert.equal(result.evidence.completeDisplaySlots,false);
  const saved=fixture('text.apply');saved.after.receipt.draft.generation='8';layout(saved).context.generation=8;worker(saved).records[0].context.generation=8;
  const admitted=inspectOrdinaryTextObservation(saved);assert.equal(admitted.status,'PASS');assert.equal(admitted.evidence.generation,8);
});

test('unchanged retained prefixes are allowed, but a replaced row, drained sequence or stale worker is rejected',()=>{
  const value=fixture(),old=clone(worker(value));old.records[0].context.generation=6;
  value.before.productPhases.workerObservations.traces=[clone(old)];value.after.productPhases.workerObservations.traces.unshift(clone(old));
  const row={sequence:1,phase:'component.proposal',startedMs:20,endedMs:30,durationMs:10,outcome:'ok',context:{}};
  value.before.productPhases.trace.records=[clone(row)];value.after.productPhases.trace.records.unshift(clone(row));value.after.productPhases.trace.records[1].sequence=2;
  assert.equal(inspectOrdinaryTextObservation(value).status,'PASS');
  const replaced=clone(value);replaced.after.productPhases.trace.records[0].context.requestId='changed';assert.equal(inspectOrdinaryTextObservation(replaced).status,'FAIL');
  const drained=clone(value);drained.after.productPhases.trace.records.shift();assert.equal(inspectOrdinaryTextObservation(drained).status,'FAIL');
  const stale=fixture();stale.before.productPhases.workerObservations=clone(stale.after.productPhases.workerObservations);const result=inspectOrdinaryTextObservation(stale);assert.equal(result.status,'INCONCLUSIVE');assert(result.missing.includes('fresh-text-layout-and-font-registration-required'));
});

test('all bounded loss counters remain missing evidence rather than a successful cherry-picked row',()=>{
  for(const target of ['main-dropped','main-invalid','workers-dropped','workers-invalid','child-dropped','child-invalid']) {
    const value=fixture(),[scope,key]=target.split('-');const object=scope==='main'?value.after.productPhases.trace:scope==='workers'?value.after.productPhases.workerObservations:worker(value);object[key]=1;
    const result=inspectOrdinaryTextObservation(value);assert.equal(result.status,'INCONCLUSIVE',target);assert.equal(result.phases.length,0);assert.equal(result.evidence,null);
  }
});

test('ambiguous duplicate preparations and retry traces cannot select a convenient matching child',()=>{
  for(const mode of ['worker','layout','font']) {
    const value=fixture();
    if(mode==='worker')value.after.productPhases.workerObservations.traces.push(clone(worker(value)));
    else if(mode==='layout'){const copy=clone(layout(value));copy.sequence=2;value.after.productPhases.trace.records.push(copy);}
    else {const copy=clone(worker(value).records[0]);copy.sequence=2;worker(value).records.push(copy);}
    const result=inspectOrdinaryTextObservation(value);assert.equal(result.status,'FAIL',mode);assert.equal(result.phases.length,0);
  }
});

test('stale exact-token fields, literal hashes, dependency hashes and canvas pixels are all rejected',()=>{
  const mutate=[value=>value.after.state.sessionId='other',value=>value.after.state.documentRevision='4',value=>value.after.state.layerVersion='3',
    value=>value.after.state.generation=8,value=>value.after.state.savedGeneration=6,value=>value.after.state.savedGeneration=null,value=>value.after.state.sourceHash=hash('other'),value=>value.binding.actionId='foreign-preview',
    value=>value.after.state.preview.textHash=hash('other'),value=>value.after.state.preview.dependencyHash=hash('other'),
    value=>value.after.state.canvas.sha256=hash('other'),value=>value.after.state.preview.layerVersion='3',
    value=>layout(value).context.snapshotId='other',value=>layout(value).context.previewId='other',value=>layout(value).context.assetHash=hash('other'),
    value=>layout(value).context.evidenceHash=hash('other'),value=>worker(value).records[0].context.generation=6,
    value=>worker(value).records[0].context.sessionId='other',value=>worker(value).records[0].context.count=3,value=>worker(value).records[0].context.bytes=1023];
  for(const edit of mutate){const value=fixture();edit(value);assert.equal(inspectOrdinaryTextObservation(value).status,'FAIL');}
});

test('changed realm, outside-window endpoints and fabricated duration/outcome/boundary fail',()=>{
  const mutate=[value=>value.after.timeOrigin++,value=>value.after.productPhases.trace.clockOriginUnixMs++,
    value=>{layout(value).startedMs=89;layout(value).durationMs=111;},value=>{layout(value).endedMs=221;layout(value).durationMs=121;},
    value=>layout(value).durationMs=1,value=>layout(value).outcome='ok',value=>layout(value).context.boundary='presented',
    value=>worker(value).records[0].outcome='error',value=>worker(value).records[0].context.boundary='render-submitted'];
  for(const edit of mutate){const value=fixture();edit(value);assert.equal(inspectOrdinaryTextObservation(value).status,'FAIL');}
});

test('accepted command/source tampering and unexpected additional draft saves fail Apply admission',()=>{
  const mutate=[value=>value.after.receipt.draft.generation='6',value=>value.after.receipt.draft.generation='8',value=>value.after.receipt.draft.generation='9',
    value=>value.after.receipt.draft.draftId='other',value=>value.after.receipt.commandId='other',value=>value.after.receipt.correlationId='other',
    value=>value.after.receipt.transactionId='other',value=>value.after.receipt.resultingRevision='5',value=>value.after.accepted.layerVersion='2',
    value=>value.after.accepted.dependencyHash=hash('other'),value=>value.after.accepted.sourceHash=hash('other'),value=>value.after.accepted.rasterHash=hash('other'),
    value=>value.after.state.active=true];
  for(const edit of mutate){const value=fixture('text.apply');edit(value);assert.equal(inspectOrdinaryTextObservation(value).status,'FAIL');}
});

test('missing required snapshots and accepted source remain explicitly unavailable',()=>{
  const value=fixture();value.after.productPhases=null;assert.equal(inspectOrdinaryTextObservation(value).status,'INCONCLUSIVE');
  const apply=fixture('text.apply');delete apply.after.accepted;assert.equal(inspectOrdinaryTextObservation(apply).status,'INCONCLUSIVE');
  for(const savedGeneration of [null,6]){const unsaved=fixture();unsaved.before.state.savedGeneration=savedGeneration;unsaved.after.state.savedGeneration=savedGeneration;const result=inspectOrdinaryTextObservation(unsaved);assert.equal(result.status,'PASS');assert.equal(result.qualification,false);}
  const savedDuringPreview=fixture();savedDuringPreview.before.state.savedGeneration=null;assert.equal(inspectOrdinaryTextObservation(savedDuringPreview).status,'PASS');
});

test('bounded arrays, invalid scalars and context accessors are rejected without executing an accessor',()=>{
  const tooMany=fixture();tooMany.after.productPhases.workerObservations.traces=Array(33).fill(worker(tooMany));assert.equal(inspectOrdinaryTextObservation(tooMany).status,'FAIL');
  const invalid=fixture();invalid.binding.generation=Number.MAX_SAFE_INTEGER;assert.equal(inspectOrdinaryTextObservation(invalid).status,'FAIL');
  const getter=fixture();let called=false;Object.defineProperty(layout(getter).context,'unsafe',{enumerable:true,get(){called=true;return 'private';}});
  assert.equal(inspectOrdinaryTextObservation(getter).status,'FAIL');assert.equal(called,false);
});

test('worker clock origins remain separate and a broad late upper bound never becomes a false registration failure',()=>{
  const value=fixture();worker(value).clockOriginUnixMs=9_000_000;layout(value).endedMs=10_100;layout(value).durationMs=10_000;value.after.observedMs=10_101;
  const result=inspectOrdinaryTextObservation(value);assert.equal(result.status,'PASS');assert.equal(result.phases[0].durationMs,40);assert.equal(result.evidence.registrationUpperBound.upperBoundMs,10_000);
  assert.equal(result.evidence.registrationUpperBound.ceilingBreachProvesFailure,false);assert.equal(result.clockJoin,'none');
});

test('stable diagnostic wall origin need not equal performance.timeOrigin and is never used for duration arithmetic',()=>{
  const value=fixture();value.before.productPhases.trace.clockOriginUnixMs=1000.75;value.after.productPhases.trace.clockOriginUnixMs=1000.75;
  const result=inspectOrdinaryTextObservation(value);assert.equal(result.status,'PASS');assert.equal(result.phases[1].durationMs,100);assert.equal(result.phases[1].clockOriginUnixMs,1000.75);assert.equal(result.clockJoin,'none');
});
