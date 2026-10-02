import test from 'node:test';
import assert from 'node:assert/strict';
import { disposeWarmDocument, resetWarmProductFixture } from '../../tooling/qualification/campaigns/backend-reset.mjs';
import { sanitize } from '../../tooling/qualification/campaigns/common.mjs';
import { FAST_QUEUE_FIXTURE_FAMILIES } from '../../tooling/qualification/campaigns/backend-queue-control.mjs';
import { FAST_WARM_PROOF_LIMIT, FAST_WARM_SOURCE_PATHS, fastWarmDigest, selectFastWarmInputs, inspectFastWarmProof, verifyFastWarmAttempt } from '../../tooling/qualification/campaigns/backend-fast-warm-proof.mjs';

const copy = value => structuredClone(value);
function queued(id, state = 'not-started', documentId = 'old_document') {
  return { id, documentId, version: '1', disposition: 'eligible', review: { endpoint: 'ideogram/v4' },
    attempts: [{ id: id + '_attempt', state, hold: ['acknowledged', 'submission-uncertain', 'dispatching'].includes(state),
      requestId: state === 'acknowledged' ? 'request_' + id : null, terminal: null, recoveryRequired: false }] };
}

// Deliberately strict protocol model: commands must name the currently observed
// version and current deletion preview. These tests exercise reset refusal and
// orchestration. They are not product performance or real provider evidence.
function fixture(values = [], options = {}) {
  const state = { jobs: copy(values), commands: [], bridge: [], document: { id: 'old_document', revision: '7' },
    receipt: null, plan: null, mutation: 0, pageCalls: [], rejected: options.rejected };
  const writer = {
    epoch: '29', root: '/unused/warm',
    queueView: async cursor => {
      state.pageCalls.push(cursor);
      const start = cursor ? Number(cursor) : 0, limit = options.pageSize ?? 2;
      return { jobs: copy(state.jobs.slice(start, start + limit)), nextCursor: start + limit < state.jobs.length ? String(start + limit) : null };
    },
    document: async id => id === state.document?.id ? copy(state.document) : null,
    documentRevision: async () => state.document.revision,
    deletionView: async () => ({ plan: copy(state.plan), receipt: copy(state.receipt) }),
    queueCommand: async bytes => {
      const request = JSON.parse(Buffer.from(bytes)), body = request.command.body;
      state.commands.push(copy(body));
      if (body.type === state.rejected) return { status: 'rejected', code: 'STALE_REVISION' };
      const job = state.jobs.find(value => value.id === body.jobId), attempt = job?.attempts.find(value => value.id === body.attemptId);
      if (job) {
        assert.equal(body.expectedVersion, job.version);
        assert(attempt);
        if (body.type === 'CancelJob') {
          job.disposition = 'cancel-requested'; attempt.cancel = 'requested';
          if (attempt.state === 'not-started') { attempt.state = 'locally-cancelled'; attempt.hold = false; }
        } else if (body.type === 'RecoverJob') { attempt.recoveryRequested = true; attempt.recoveryRequired = false; }
        else if (body.type === 'OverrideUncertainHold') {
          assert.equal(attempt.state, 'submission-uncertain'); assert.equal(body.acknowledgeOverlapAndChargeRisk, true);
          assert(state.bridge.includes('closeNamespace'), 'The exact loopback namespace must close before the local risk override');
          attempt.hold = false; attempt.override = true;
        } else assert.fail('Unexpected modeled job command');
        job.version = String(BigInt(job.version) + 1n);
      } else if (body.type === 'PreviewDocumentDeletion') {
        assert.equal(body.expectedRevision, state.document.revision);
        state.plan = { id: 'current_plan', documentId: state.document.id, documentRevision: state.document.revision,
          rootGeneration: 'root_generation_' + state.mutation, planHash: 'exact_plan_hash',
          unresolvedAttempts: state.jobs.filter(job => job.documentId === state.document.id).flatMap(job => job.attempts).filter(attempt => attempt.state === 'submission-uncertain').map(attempt => attempt.id) };
      } else if (body.type === 'DeleteDocument') {
        const plan = state.plan;
        assert.equal(body.planId, plan.id); assert.equal(body.planHash, plan.planHash);
        assert.equal(body.rootGeneration, plan.rootGeneration); assert.equal(body.expectedRevision, plan.documentRevision);
        assert.equal(body.acknowledgeRunningAndUncertain, plan.unresolvedAttempts.length > 0);
        for (const job of state.jobs.filter(job => job.documentId === state.document.id)) job.disposition = 'deleted';
        state.document = null; state.receipt = { accepted: true, status: 'cleanup-pending', actualFreedBytes: '0', pendingBytes: '16' };
      } else if (body.type === 'CollectDocumentGarbage') {
        if (!options.cleanupPending) state.receipt = { ...state.receipt, status: 'cleanup-complete', actualFreedBytes: '16', pendingBytes: '0' };
        options.afterCollect?.(f);
      } else assert.fail('Unexpected modeled document command');
      state.mutation++;
      return { status: 'accepted', commandId: request.command.commandId, fromSeq: String(state.mutation), toSeq: String(state.mutation) };
    },
  };
  const f = { root: writer.root, documentId: 'old_document', writer, context: {}, setDocumentId(id) { this.documentId = id; } };
  f.queueWorker = {
    snapshot: async () => ({ controls: { status: options.providerStatus ?? 'IN_QUEUE' }, submittedJobIds: options.unowned ? [] : state.jobs.map(job => job.id),
      submittedAttemptIds: options.submittedAttemptIds ?? state.jobs.flatMap(job => job.attempts.map(attempt => attempt.id)),
      requestIds: state.jobs.flatMap(job => job.attempts.map(attempt => attempt.requestId)).filter(Boolean) }),
    configure: async (route, controls) => { state.bridge.push('configure'); assert.equal(route, 'ideogram/v4'); assert.equal(controls.status, options.providerStatus === 'COMPLETED' ? 'COMPLETED' : 'CANCELLED'); },
    observeStatus: async (id, attemptId, status) => {
      state.bridge.push('observeStatus'); assert.equal(status, options.providerStatus === 'COMPLETED' ? 'COMPLETED' : 'CANCELLED');
      const job = state.jobs.find(job => job.id === id), attempt = job.attempts.find(attempt => attempt.id === attemptId);
      if (!options.leaveHeld) { attempt.hold = false; attempt.state = 'provider-terminal'; attempt.terminal = status.toLowerCase(); job.version = String(BigInt(job.version) + 1n); }
      return { outcome: 'complete', evidence: 'modeled-status-only' };
    },
    tick: async () => {
      state.bridge.push('tick');
      if (options.recoverKnown) {
        const job = state.jobs[0], attempt = job.attempts[0];
        attempt.requestId = 'recovered_request'; attempt.state = options.recoverTerminal ? 'provider-terminal' : 'acknowledged';
        if (options.recoverTerminal) { attempt.hold = false; attempt.terminal = 'cancelled'; }
        job.version = String(BigInt(job.version) + 1n);
      }
    },
    closeNamespace: async () => { state.bridge.push('closeNamespace'); return { closed: true, requestsRetained: true }; },
  };
  return { f, state };
}

test('warm cleanup traverses all pages, deactivates only the prior document, and preserves queue history', async () => {
  const { f, state } = fixture([queued('one'), queued('two'), queued('other', 'not-started', 'other_document')], { pageSize: 1 });
  const phases = [], receipt = await disposeWarmDocument(f, {}, phases);
  assert.deepEqual(state.commands.map(value => value.type), ['CancelJob', 'CancelJob', 'PreviewDocumentDeletion', 'DeleteDocument', 'CollectDocumentGarbage']);
  assert.equal(state.jobs.length, 3); assert.equal(state.jobs[2].attempts[0].state, 'not-started');
  assert.equal(state.jobs[2].disposition, 'eligible'); assert.equal(receipt.retainedJobs, 2);
  assert.equal(receipt.deletion.actualFreedBytes, '16'); assert.equal(receipt.deleted, true);
  assert(state.pageCalls.includes('2')); assert.equal(f.documentId, 'old_document');
  assert(phases.every(span => span.outcome === 'completed' && span.durationMs >= 0));
});

test('known loopback cancellation needs actual terminal observation before deleting the document', async () => {
  const { f, state } = fixture([queued('known', 'acknowledged')]);
  const receipt = await disposeWarmDocument(f);
  assert.deepEqual(state.bridge, ['configure', 'observeStatus']);
  assert.equal(state.jobs[0].attempts[0].state, 'provider-terminal');
  assert.equal(receipt.reconciliations[0].outcome, 'observed-loopback-cancelled');
  assert.equal(state.commands.some(command => command.type === 'OverrideUncertainHold'), false);
});

test('an already completed fixture outcome is observed without rewriting it as cancelled', async () => {
  const { f, state } = fixture([queued('known', 'acknowledged')], { providerStatus: 'COMPLETED' });
  const receipt = await disposeWarmDocument(f);
  assert.equal(state.jobs[0].attempts[0].terminal, 'completed');
  assert.equal(receipt.reconciliations[0].outcome, 'observed-loopback-completed');
});

test('an unsupported failed-terminal fixture response is not replaced with invented cancellation evidence', async () => {
  const { f, state } = fixture([queued('known', 'acknowledged')], { providerStatus: 'FAILED' });
  await assert.rejects(disposeWarmDocument(f), /failed-terminal response/); assert.deepEqual(state.commands, []);
});

test('a copied active provider lifetime rejects before changing even an earlier queued job', async () => {
  const { f, state } = fixture([queued('local'), queued('foreign', 'acknowledged')], { unowned: true });
  await assert.rejects(disposeWarmDocument(f), { code: 'FIXTURE_REQUIRED' });
  assert.deepEqual(state.commands, []); assert.deepEqual(state.bridge, []); assert(state.document);
});

test('lost acknowledgment keeps its durable uncertainty and uses only an explicit local hold override', async () => {
  const { f, state } = fixture([queued('uncertain', 'submission-uncertain')]);
  const receipt = await disposeWarmDocument(f);
  assert.deepEqual(state.commands.map(command => command.type), ['CancelJob', 'RecoverJob', 'OverrideUncertainHold', 'PreviewDocumentDeletion', 'DeleteDocument', 'CollectDocumentGarbage']);
  assert.deepEqual(state.bridge, ['configure', 'tick', 'closeNamespace']);
  const retained = state.jobs[0].attempts[0];
  assert.equal(retained.requestId, null); assert.equal(retained.state, 'submission-uncertain'); assert.equal(retained.hold, false);
  assert.equal(receipt.unresolvedHistoricalAttempts, 1);
  assert.equal(receipt.reconciliations[0].remoteStatusKnown, false); assert.equal(receipt.reconciliations[0].submittedAgain, false);
});

test('an uncertain submission cannot be overridden without a bridge namespace-close capability', async () => {
  const { f, state } = fixture([queued('uncertain', 'submission-uncertain')]); delete f.queueWorker.closeNamespace;
  await assert.rejects(disposeWarmDocument(f), /lacks the required/);
  assert.deepEqual(state.commands, []);
});

for (const terminal of [false, true]) test('recovery rereads an uncertain attempt that becomes ' + (terminal ? 'terminal' : 'known') + ' without closing its provider namespace', async () => {
  const { f, state } = fixture([queued('uncertain', 'submission-uncertain')], { recoverKnown: true, recoverTerminal: terminal });
  const receipt = await disposeWarmDocument(f);
  assert.equal(state.bridge.includes('closeNamespace'), false);
  assert.equal(state.commands.some(body => body.type === 'OverrideUncertainHold'), false);
  assert.equal(state.jobs[0].attempts[0].requestId, 'recovered_request');
  assert.equal(state.jobs[0].attempts[0].hold, false);
  assert.equal(receipt.reconciliations[0].outcome, terminal ? 'recovered-loopback-cancelled' : 'observed-loopback-cancelled');
});

test('a submitted earlier attempt does not authenticate a different uncertain retry on the same job', async () => {
  const value = queued('retry', 'submission-uncertain');
  value.attempts.unshift({ id: 'earlier_attempt', state: 'provider-terminal', terminal: 'completed', requestId: 'earlier_request', hold: false });
  const { f, state } = fixture([value], { submittedAttemptIds: ['earlier_attempt'] });
  await assert.rejects(disposeWarmDocument(f), /different provider lifetime/);
  assert.deepEqual(state.commands, []);
});

test('cancellation acknowledgment alone never clears a real scheduling hold', async () => {
  const { f, state } = fixture([queued('known', 'acknowledged')], { leaveHeld: true });
  await assert.rejects(disposeWarmDocument(f), /terminal evidence must release/);
  assert.deepEqual(state.commands.map(command => command.type), ['CancelJob']); assert(state.document);
});

test('failed current-preview deletion prevents garbage collection and exposes the failed reset phase', async () => {
  const { f, state } = fixture([], { rejected: 'DeleteDocument' }), phases = [];
  await assert.rejects(disposeWarmDocument(f, {}, phases), /STALE_REVISION/);
  assert.equal(state.commands.some(command => command.type === 'CollectDocumentGarbage'), false);
  assert(state.document); assert.equal(f.documentId, 'old_document');
  assert.equal(phases.at(-1).outcome, 'failed');
});

test('an accepted collection with pending readers or object leases is not a completed warm reset', async () => {
  const { f, state } = fixture([], { cleanupPending: true });
  await assert.rejects(disposeWarmDocument(f), /garbage collection remains pending/);
  assert.equal(state.receipt.status, 'cleanup-pending'); assert.equal(state.receipt.pendingBytes, '16');
  await assert.rejects(disposeWarmDocument(f), /garbage collection remains pending/);
  assert.equal(state.commands.filter(command => command.type === 'CollectDocumentGarbage').length, 2);
});

test('a retry with an already deleted document resumes real collection before accepting cleanup', async () => {
  const options = { cleanupPending: true }, { f, state } = fixture([], options);
  await assert.rejects(disposeWarmDocument(f), /garbage collection remains pending/);
  options.cleanupPending = false;
  const receipt = await disposeWarmDocument(f);
  assert.equal(receipt.resumedDeletion, true); assert.equal(receipt.deletion.status, 'cleanup-complete');
  assert.equal(state.commands.filter(command => command.type === 'DeleteDocument').length, 1);
  assert.equal(state.commands.filter(command => command.type === 'CollectDocumentGarbage').length, 2);
});

test('an already aborted reset issues no public command and does not select another document', async () => {
  const { f, state } = fixture([queued('local')]), controller = new AbortController(); controller.abort(Error('cancelled reset'));
  await assert.rejects(disposeWarmDocument(f, { signal: controller.signal }), /cancelled reset/);
  assert.deepEqual(state.commands, []); assert.equal(f.documentId, 'old_document');
});

test('warm cleanup refuses a swapped writer even when the public deletion succeeded', async () => {
  const { f } = fixture([], { afterCollect: f => { f.writer = { epoch: '30' }; } });
  await assert.rejects(disposeWarmDocument(f), /same LocalWriter/);
});

test('a missing document is harmless only if it has no remaining hold', async () => {
  const empty = fixture(); empty.state.document = null;
  assert.equal((await disposeWarmDocument(empty.f)).existed, false);
  const held = fixture([queued('known', 'acknowledged')]); held.state.document = null;
  await assert.rejects(disposeWarmDocument(held.f), /unresolved active hold/);
});

test('unsupported warm seeds and a missing WQ snapshot controller refuse before deletion', async () => {
  const { f, state } = fixture();
  await assert.rejects(resetWarmProductFixture(f, {}, { workload: 'W1' }, { cache: 'warm' }), /requires W0\/WF or WQ/);
  await assert.rejects(resetWarmProductFixture(f, {}, { workload: 'WQ' }, { cache: 'warm' }), /recovery scheduling controller/);
  assert.deepEqual(state.commands, []); assert(state.document);
});

test('repeated queue cursors refuse instead of looping or omitting a page', async () => {
  const { f, state } = fixture(); f.writer.queueView = async () => ({ jobs: [], nextCursor: 'same' });
  await assert.rejects(disposeWarmDocument(f), { code: 'WARM_RESET_INVALID' }); assert.deepEqual(state.commands, []);
});

// Contract-only packets exercise proof refusal. They are not observations from
// a real writer, executed performance samples, or full WF corpus qualification.
const wfHash = label => fastWarmDigest('WF contract: ' + label);
const wfCategories = ['all','originals','canonical','masks','candidates','adapters','datasets','history','staging','previews'];
const wfSourceRows = () => [...new Set([...FAST_WARM_SOURCE_PATHS,'dist/local/server/storage/worker.js','dist/local/server/storage/database.js','dist/local/server/storage/queue.js'])].map(path => ({path,bytes:64,sha256:wfHash(path)}));
const wfOwnerPaths = ['tooling/qualification/campaigns/backend-wq-cache.mjs','tooling/qualification/campaigns/backend.mjs','tooling/qualification/campaigns/backend-common.mjs','tooling/qualification/campaigns/fixture-product.mjs','tooling/qualification/campaigns/backend-queue.mjs','tooling/qualification/campaigns/backend-queue-worker.mjs','tooling/qualification/campaigns/backend-queue-control.mjs','dist/local/server/storage/worker.js','dist/local/server/storage/database.js','dist/local/server/storage/queue.js'];
const wfOwner = () => ({kind:'store-instance-connection',connectionId:'contract-connection',moduleInstanceId:'contract-module',pid:123,threadId:9,root:'/contract-only/owned-wf',epoch:'7',sources:wfOwnerPaths.map(path => copy(wfSourceRows().find(row => row.path===path)))});
function wfStorage(highWater, count = 1) {
  return {protocolVersion:1,epoch:'7',highWater,categories:wfCategories.map(id => ({id,label:id,assetCount:count,objectCount:count,knownBytes:String(count * 64),complete:true,unknownCount:0,assetRows:true})),
    registeredObjects:{count,knownBytes:String(count * 64),complete:true},filesystem:{availableBytes:'1000000',totalBytes:'2000000'},appPhysicalBytes:null,
    accounting:'logical-content-bytes; categories may overlap',previewCache:{entries:0,knownBytes:'0',pinnedEntries:0,activeBuilds:0,clearableEntries:0,clearableBytes:'0',scope:'registered-display-derivatives'}};
}
function wfState(documentId, highWater, jobs = [], count = 1) {
  return {documentId,documentHash:wfHash(documentId),imageHash:wfHash('empty image'),width:2048,height:2048,layers:0,highWater,snapshot:null,
    queue:{total:jobs.length,active:jobs.flatMap(job => job.attempts).filter(attempt => attempt.hold).length,sha256:fastWarmDigest(jobs),jobs:copy(jobs)},storage:wfStorage(highWater,count),
    reads:['capture','document','imageState','all-queue-pages','storageSummary','capture','document','imageState']};
}
function wfFixture(caseId = 'WF01') {
  const family = FAST_QUEUE_FIXTURE_FAMILIES.find(row => row.caseId === caseId), files = family ? Array.from({length:family.count},(_,index) => ({
    id:`wf-${family.width}-${family.format}-${index}`,role:'fast-candidate',path:`/contract-only/corpus/${caseId}-${index}.${family.format}`,byteLength:'128',sha256:wfHash(caseId + '-' + index),width:family.width,height:family.height,format:family.format,index,
  })) : /^WF1[3-6]$/.test(caseId) ? [{id:'wf-fault-8MiB',role:'fast-fault-candidate',path:'/contract-only/corpus/fault.png',byteLength:'8388608',sha256:wfHash('fixed fault PNG'),width:512,height:512,format:'png',index:0}] : [];
  return {root:'/contract-only/corpus',seal:{path:'/contract-only/corpus/fixture.json',sha256:wfHash('separately sealed manifest')},corpus:{files,fast:{validFamilies:copy(FAST_QUEUE_FIXTURE_FAMILIES)}}};
}
function wfContract(caseId = 'WF01', {cache = 'warm', previous = null} = {}) {
  const cell = {id:'contract/WF/' + caseId,handler:'backend',operation:'fast.workflow',workload:'WF',parameters:{caseId}}, sample = {cache,ordinal:previous ? previous.preparation.sample.ordinal + 1 : 1,prime:false};
  const fixture = wfFixture(caseId), family = FAST_QUEUE_FIXTURE_FAMILIES.find(row => row.caseId === caseId), invalid = /^WF(0[7-9]|1[0-2])$/.test(caseId);
  const selected = {caseId,fixtureSeal:fixture.seal.sha256,kind:family ? 'valid' : invalid ? 'invalid' : 'fault',...(invalid ? {expectedField:{WF07:'source',WF08:'mask',WF09:'adapters',WF10:'acceleration',WF11:'expansion',WF12:'size'}[caseId]} : {manifest:family ? copy(family) : {speed:'BALANCED',expansion:'None',width:512,height:512,count:1,format:'png'}}),files:copy(fixture.corpus.files)};
  const serial = previous ? previous.serial + 1 : 1, documentId = 'wf_document_' + serial, highWater = previous ? String(BigInt(previous.after.highWater) + 5n) : '1';
  const priorJobs = previous ? previous.after.queue.jobs.map(job => ({...copy(job),disposition:'deleted',attempts:job.attempts.map(attempt => ({...copy(attempt),state:'provider-terminal',hold:false}))})) : [];
  const base = wfState(documentId,highWater,priorJobs,serial), ready = copy(base), provider = {routes:[],worker:{epoch:'7',threadId:9}}, owner = previous ? copy(previous.finalOwner) : wfOwner();
  const jobId = invalid ? null : 'wf_job_' + serial, attemptId = invalid ? null : 'wf_attempt_' + serial;
  if(invalid){ready.highWater=String(BigInt(highWater)+2n);ready.storage=wfStorage(ready.highWater,serial+1);}
  const after = invalid ? copy(ready) : wfState(documentId,String(BigInt(ready.highWater)+3n),[...priorJobs,{id:jobId,documentId,disposition:'eligible',attempts:[{id:attemptId,state:'acknowledged',hold:true,requestId:'wf_request_'+serial}]}],serial+2);
  const draftHash=wfHash(caseId+' durable draft'), draft=invalid ? {kind:'fast-durable-invalid-input-1',caseId,documentId,draftId:'wf_draft_'+serial,generation:'1',assetId:'wf_draft_asset_'+serial,blob:{hash:draftHash,byteLength:'64',mediaType:'text/plain'},rawHash:draftHash,uiHash:wfHash(caseId+' persisted UI'),expectedField:selected.expectedField} : null;
  const preparation = {kind:'fast-input-preparation-1',cell:copy(cell),sample:copy(sample),serial,previous:previous ? fastWarmDigest(previous) : null,owner,
    sourceFiles:FAST_WARM_SOURCE_PATHS.map(path => copy(wfSourceRows().find(row => row.path===path))),selected,manifest:{path:fixture.seal.path,bytes:512,sha256:fixture.seal.sha256},originals:selected.files.map(file => ({...copy(file),bytes:Number(file.byteLength)})),base,provider,warmed:cache==='warm' ? copy(base) : null,draft,ready,
    cacheProfile:{kind:cache==='warm'?'same-writer-public-read-prepared':'fresh-writer-common-input-validation',additionalScenarioPrimes:0,decodedCache:'not claimed',writeCache:'not claimed',jitCache:'not claimed',operatingSystemPageCache:'unobserved'},preparedAtMs:10};
  const resultFixture=selected.kind==='fault'?{bytes:8388608,sha256:selected.files[0].sha256,exactEightMiB:true}:selected.kind==='valid'?{kind:'fast-valid-result-family',caseId,manifest:copy(selected.manifest),fixtureSeal:selected.fixtureSeal,files:copy(selected.files)}:null;
  const finishNames=['fast-input.after-operation-observation','fast-input.after-provider-observation','fast-input.final-original-readback','fast-input.final-manifest-readback'];
  const operation={status:'pass',phases:finishNames.map((name,index)=>({name,startMs:22+index,endMs:22.5+index,durationMs:0.5,outcome:'completed'})),observations:{jobId,attemptId,resultFixture,...(invalid?{providerEffects:0,retainedDraft:copy(draft.blob),providerEffectsObservation:{before:copy(provider),after:copy(provider)}}:{})}};
  const packet={kind:'backend-fast-input-proof-1',serial,previous:preparation.previous,preparation,entry:copy(ready),entryAtMs:21,after,finalProvider:copy(provider),finalOwner:copy(owner),originalsAfter:copy(preparation.originals),manifestAfter:copy(preparation.manifest),completedAtMs:30,
    operation:{status:operation.status.toUpperCase(),jobId,attemptId,resultFixture:copy(resultFixture)},growth:{before:copy(base.storage),prepared:copy(ready.storage),after:copy(after.storage),scope:'full retained global logical totals; no subtraction; physical bytes unavailable'}};
  const names=['fast-input.source-identity','fast-input.actual-owner','fast-input.empty-base-public-observation','fast-input.provider-reset-observation','fast-input.selected-manifest-readback','fast-input.selected-original-readback',...(cache==='warm'?['fast-input.measurement-connection-public-reads']:[]),'fast-input.durable-draft-observation','fast-input.ready-public-observation'];
  const reset={phases:names.map((name,index)=>({name,startMs:index,endMs:index+0.5,durationMs:0.5,outcome:'completed'})),fastWarmPreparation:copy(preparation),observations:{root:owner.root,...(previous?{
    previousDocumentId:previous.after.documentId,documentId,writerEpoch:owner.epoch,writerWorkerRestarted:false,
    disposal:{documentId:previous.after.documentId,deletion:{status:'cleanup-complete',pendingBytes:'0'}},providerReset:{receipt:{reset:true},after:copy(provider)},
    rebuilt:{documentId,preparation:{retainedWriter:true}},globalHighWater:{before:previous.after.highWater,afterDisposal:String(BigInt(previous.after.highWater)+2n),afterReseed:highWater},
  }:{})}};
  return {packet,options:{cell,sample,previous,fixture,reset,operation}};
}
const wfMirrorPreparation = value => {value.options.reset.fastWarmPreparation=copy(value.packet.preparation);};
const wfInspect = value => inspectFastWarmProof(value.packet,value.options);
function retainedWF(value) {
  const bytes=Buffer.from(JSON.stringify(value.packet)+'\n'),raw={...copy(value.options.sample),status:'PASS',startMs:20,endMs:40,reset:copy(value.options.reset),result:{...copy(value.options.operation),fastWarmInput:{artifact:{path:'wf-proof.json',bytes:bytes.length,sha256:fastWarmDigest(bytes)}}}};
  const attempt=sanitize(raw), files=wfSourceRows();
  const args={cell:value.options.cell,attempt,previous:value.options.previous,fixture:value.options.fixture,workerProcessIdentity:{pid:123},controlFiles:files.filter(row=>row.path.startsWith('tooling/')),buildFiles:files.filter(row=>row.path.startsWith('dist/')),
    readRetained:async(path,limits)=>{assert.equal(path,'wf-proof.json');assert.deepEqual(limits,{maximum:FAST_WARM_PROOF_LIMIT});return bytes;}};
  return {bytes,attempt,artifact:attempt.result.fastWarmInput.artifact,args};
}

test('WF proof contracts retain one owner while publicly disclosed history grows across fresh sample namespaces', async () => {
  const first=wfContract(),second=wfContract('WF01',{previous:first.packet});
  for(const value of [first,second,wfContract('WF02'),wfContract('WF01',{cache:'cold'}),...Array.from({length:10},(_,i)=>wfContract('WF'+String(i+7).padStart(2,'0')))]){
    assert.equal(wfInspect(value).complete,true);assert.deepEqual(await verifyFastWarmAttempt(retainedWF(value).args),value.packet);
  }
  assert.deepEqual(second.packet.preparation.owner,first.packet.finalOwner);assert.notEqual(second.packet.entry.documentId,first.packet.entry.documentId);
  assert.equal(second.packet.after.queue.total,2);assert.equal(second.packet.preparation.base.queue.jobs[0].disposition,'deleted');assert.equal(second.packet.preparation.base.queue.active,0);
  assert(BigInt(second.packet.after.highWater)>BigInt(first.packet.after.highWater));assert.notDeepEqual(second.packet.growth.after,first.packet.growth.after);
  for(const caseId of ['WF07','WF08','WF09','WF10','WF11','WF12'])assert.deepEqual(wfContract(caseId).packet.preparation.originals,[],'Invalid Fast controls do not claim provider-result consumption');
});

test('WF selection preserves every sealed valid member and the separate fixed eight-MiB batch-one fault original', () => {
  for(const family of FAST_QUEUE_FIXTURE_FAMILIES){const value=wfContract(family.caseId);assert.deepEqual(selectFastWarmInputs({fixture:value.options.fixture},value.options.cell),value.packet.preparation.selected);assert.equal(value.packet.preparation.selected.files.length,family.count);}
  for(const caseId of ['WF13','WF14','WF15','WF16']){const value=wfContract(caseId),selected=selectFastWarmInputs({fixture:value.options.fixture},value.options.cell);assert.equal(selected.manifest.count,1);assert.equal(selected.files[0].byteLength,'8388608');assert.equal(selected.files[0].role,'fast-fault-candidate');}
  const changes=[['missing seal',v=>delete v.options.fixture.seal],['missing selected member',v=>v.options.fixture.corpus.files.pop()],['duplicate member',v=>v.options.fixture.corpus.files.push(copy(v.options.fixture.corpus.files[0]))],['wrong dimensions',v=>v.options.fixture.corpus.files[0].width++],['wrong format',v=>v.options.fixture.corpus.files[0].format='png'],['wrong index',v=>v.options.fixture.corpus.files[0].index=7],['changed family manifest',v=>v.options.fixture.corpus.fast.validFamilies[1].count=1]];
  for(const [reason,change]of changes){const value=wfContract('WF02');change(value);assert.throws(()=>selectFastWarmInputs({fixture:value.options.fixture},value.options.cell),undefined,reason);}
  for(const [reason,change]of [['short fault',v=>v.options.fixture.corpus.files[0].byteLength='8388607'],['two fault originals',v=>v.options.fixture.corpus.files.push(copy(v.options.fixture.corpus.files[0]))],['wrong fault dimensions',v=>v.options.fixture.corpus.files[0].height=1024],['wrong fault format',v=>v.options.fixture.corpus.files[0].format='jpeg'],['wrong fault index',v=>v.options.fixture.corpus.files[0].index=1]]){const value=wfContract('WF13');change(value);assert.throws(()=>selectFastWarmInputs({fixture:value.options.fixture},value.options.cell),undefined,reason);}
});

test('WF replay refuses absent, oversized, truncated or changed retained proof bytes', async () => {
  for(const [reason,change]of [['missing PASS proof',v=>delete v.attempt.result.fastWarmInput],['changed digest',v=>v.artifact.sha256=wfHash('tampered proof')],['changed byte count',v=>v.artifact.bytes++],['oversized proof',v=>v.artifact.bytes=FAST_WARM_PROOF_LIMIT+1],['truncated read',v=>v.args.readRetained=async()=>v.bytes.subarray(0,-1)]]){
    const value=retainedWF(wfContract());change(value);await assert.rejects(()=>verifyFastWarmAttempt(value.args),undefined,reason);
  }
  const absent=retainedWF(wfContract());absent.attempt.status='INCONCLUSIVE';delete absent.attempt.result.fastWarmInput;assert.equal(await verifyFastWarmAttempt(absent.args),null);
  for(const change of [v=>v.args.cell.handler='browser',v=>v.args.cell.operation='queue.fault',v=>v.args.cell.workload='WQ']){const value=retainedWF(wfContract());change(value);assert.equal(await verifyFastWarmAttempt(value.args),null);}
});

test('semantically resealed WF proofs reject old owners, substituted inputs, hidden growth and invented cache preparation', async () => {
  const prior=wfContract().packet;
  const changes=[
    ['owner changed',v=>{v.packet.preparation.owner.connectionId='other-owner';v.packet.finalOwner=copy(v.packet.preparation.owner);}],
    ['wrong predecessor',v=>v.packet.previous=wfHash('unrelated predecessor')],['skipped serial',v=>v.packet.serial++],
    ['reused document namespace',v=>v.packet.preparation.base.documentId=prior.after.documentId],
    ['prior accepted job removed',v=>{v.packet.preparation.base.queue.jobs=[];v.packet.preparation.base.queue.total=0;v.packet.preparation.warmed=copy(v.packet.preparation.base);}],
    ['prior job still eligible',v=>{v.packet.preparation.base.queue.jobs[0].disposition='eligible';v.packet.preparation.warmed=copy(v.packet.preparation.base);}],
    ['old hold remains',v=>{v.packet.preparation.base.queue.jobs[0].attempts[0].hold=true;v.packet.preparation.base.queue.active=1;}],
    ['global event history goes backwards',v=>{v.packet.preparation.base.highWater='0';v.packet.preparation.base.storage.highWater='0';v.packet.preparation.warmed=copy(v.packet.preparation.base);v.packet.growth.before=copy(v.packet.preparation.base.storage);v.options.reset.observations.globalHighWater.afterReseed='0';}],
    ['growth omitted',v=>delete v.packet.growth],['growth relabeled as fresh',v=>v.packet.growth.scope='fresh workspace only'],
    ['incomplete logical inventory',v=>{v.packet.after.storage.registeredObjects.complete=false;v.packet.growth.after=copy(v.packet.after.storage);}],['physical usage invented',v=>{v.packet.after.storage.appPhysicalBytes='4096';v.packet.growth.after=copy(v.packet.after.storage);}],
    ['consumed original substituted',v=>{v.packet.preparation.originals[0].sha256=wfHash('other same-length bytes');v.packet.originalsAfter=copy(v.packet.preparation.originals);}],
    ['independent manifest substituted',v=>v.options.fixture.seal.sha256=wfHash('different sealed manifest')],
    ['manifest changed after operation',v=>v.packet.manifestAfter.sha256=wfHash('changed final manifest')],['original changed after operation',v=>v.packet.originalsAfter[0].sha256=wfHash('changed final original')],
    ['read warming absent',v=>v.packet.preparation.warmed=null],['read warming differs',v=>v.packet.preparation.warmed.documentHash=wfHash('different public document')],
    ['scenario prime claimed',v=>v.packet.preparation.cacheProfile.additionalScenarioPrimes=1],['OS warmth inferred',v=>v.packet.preparation.cacheProfile.operatingSystemPageCache='warm'],
    ['cleanup receipt absent',v=>delete v.options.reset.observations.disposal],['cleanup still pending',v=>v.options.reset.observations.disposal.deletion.pendingBytes='64'],['provider reset absent',v=>delete v.options.reset.observations.providerReset],
    ['reset bound to another root',v=>v.options.reset.observations.root='/contract-only/other'],['reset writer restarted',v=>v.options.reset.observations.writerWorkerRestarted=true],
    ['reset deleted another namespace',v=>v.options.reset.observations.disposal.documentId='unrelated-document'],['reset reseeded another namespace',v=>v.options.reset.observations.rebuilt.documentId='unrelated-document'],
    ['reset event history goes backwards',v=>v.options.reset.observations.globalHighWater.before='0'],['reset provider observation differs',v=>v.options.reset.observations.providerReset.after.worker.epoch='8'],
  ];
  for(const [reason,change]of changes){const value=wfContract('WF01',{previous:prior});change(value);wfMirrorPreparation(value);const retained=retainedWF(value);await assert.rejects(()=>verifyFastWarmAttempt(retained.args),undefined,reason);}
});

test('WF replay binds the actual sample, completed operation and each independently sealed executable input', async () => {
  const changes=[
    ['wrong worker',v=>v.args.workerProcessIdentity.pid++],['wrong case',v=>v.args.cell.parameters.caseId='WF02'],['wrong ordinal',v=>v.attempt.ordinal++],['prime relabel',v=>v.attempt.prime=true],['cold relabel',v=>v.attempt.cache='cold'],
    ['different completed job',v=>v.attempt.result.observations.jobId='other-job'],['different completed attempt',v=>v.attempt.result.observations.attemptId='other-attempt'],['different operation status',v=>v.attempt.result.status='fail'],
    ['source missing',v=>v.args.controlFiles.shift()],['source deleted',v=>v.args.controlFiles[0].deleted=true],['source hash changed',v=>v.args.controlFiles[0].sha256=wfHash('different controller')],['build bytes changed',v=>v.args.buildFiles[0].bytes++],
    ['read phase absent',v=>v.attempt.reset.phases=v.attempt.reset.phases.filter(row=>row.name!=='fast-input.measurement-connection-public-reads')],
    ['read phase duplicated',v=>v.attempt.reset.phases.push(copy(v.attempt.reset.phases.find(row=>row.name==='fast-input.measurement-connection-public-reads')))],
    ['read phase failed',v=>v.attempt.reset.phases.find(row=>row.name==='fast-input.measurement-connection-public-reads').outcome='failed'],
    ['manifest read phase absent',v=>v.attempt.reset.phases=v.attempt.reset.phases.filter(row=>row.name!=='fast-input.selected-manifest-readback')],
    ['completion phase absent',v=>v.attempt.result.phases.pop()],['completion phase duplicated',v=>v.attempt.result.phases.push(copy(v.attempt.result.phases[0]))],
    ['completion phase failed',v=>v.attempt.result.phases[0].outcome='failed'],['completion phase outside entry',v=>v.attempt.result.phases[0].startMs=0],
    ['preparation charged after start',v=>v.attempt.startMs=0],['completion outside attempt',v=>v.attempt.endMs=25],
  ];
  for(const [reason,change]of changes){const value=retainedWF(wfContract());change(value);await assert.rejects(()=>verifyFastWarmAttempt(value.args),undefined,reason);}
  const value=wfContract(),path='tooling/qualification/campaigns/backend.mjs';value.packet.preparation.sourceFiles.find(row=>row.path===path).sha256=wfHash('self-consistent substitute');value.packet.preparation.owner.sources.find(row=>row.path===path).sha256=wfHash('self-consistent substitute');value.packet.finalOwner=copy(value.packet.preparation.owner);wfMirrorPreparation(value);
  await assert.rejects(()=>verifyFastWarmAttempt(retainedWF(value).args),/source changed/,'A resealed packet cannot replace independently sealed executable inputs');
});
