import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {textFeedbackInvocation, textRawFeedbackCohort, createTextFeedbackServices, browserActionOutcome} from '../../tooling/qualification/campaigns/browser.mjs';
import {buildTextInteractionPlan} from '../../tooling/qualification/campaigns/browser-text.mjs';
import {sanitize, PrerequisiteError} from '../../tooling/qualification/campaigns/common.mjs';

const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const fixture = (workload = 'WXn') => {
  const corpus = 'private mixed corpus', fragments = Array.from({length: 20}, (_, index) => 'private fragment ' + index);
  return {workload, seal: {sha256: hash('fixture')}, text: {schema: 'browser-text-fixture-1', manifestHash: hash('manifest'),
    corpus: {text: corpus, sha256: hash(corpus), fragments, fragmentsHash: hash(JSON.stringify(fragments)),
      scripts: ['latin-combining', 'arabic-rtl', 'devanagari', 'cjk', 'emoji', 'newlines', 'unbroken']},
    fonts: Array.from({length: workload === 'WXs' ? 16 : 4}, (_, index) => ({id: 'font-' + index, kind: 'bundled', bytes: 1024, sha256: hash('font-' + index)})),
    semanticItemIds: ['one', 'two']}};
};
const bindingArgs = (workload = 'WXn') => {
  const value = fixture(workload);
  return {cell: {id: 'cell-1', operation: 'text.interaction', workload}, sample: {cache: 'cold', ordinal: 0, prime: false}, serial: 1,
    sessionId: 'input-1', fixture: value, runtime: {fixtureSeal: structuredClone(value.seal)},
    processIdentity: {pid: process.pid, startedAt: '2026-09-30T12:00:00.000Z', node: process.version}, output: '/tmp/text-feedback'};
};
const complete = () => {
  const plan = buildTextInteractionPlan(), startMs = 100;
  const actions = plan.map(action => ({id: action.id, kind: action.kind, scheduledMs: action.scheduledMs,
    inputMs: startMs + action.scheduledMs, readyMs: startMs + action.scheduledMs + 1, outcome: 'completed',
    nativeSource: 'explicit-per-substep-delivery'}));
  return {plan, actions, segment: {startMs, endMs: 60_100, requestedMs: 60_000, captureStoppedMs: 60_102,
    actualMs: 60_002, completedActionsAtMs: actions.at(-1).readyMs - startMs, actions: 106, reservedFeedbackMs: 600}};
};
const harness = (overrides = {}) => {
  const calls = [], missing = [], full = complete();
  const native = {start: async () => {calls.push('native-start'); return {status: 'complete'};},
    hook: async ({run}) => ({value: await run(), bracket: {status: 'complete'}}), end: async () => {calls.push('native-end'); return {status: 'complete'};}, ...overrides.native};
  const trace = {start: async () => {calls.push('trace-start'); return {status: 'recording'};},
    stop: async options => {calls.push(['trace-stop', options]); return {};}, ...overrides.trace};
  const services = createTextFeedbackServices({native, trace, rawFeedbackSelected: overrides.rawFeedbackSelected ?? true,
    sessionId: 'input-1', plan: full.plan, missing});
  return {services, calls, missing, full, request: {sessionId: 'input-1', segment: full.segment, actions: full.actions}};
};

test('text binding pins the worker attempt, original plan and exact fixture without corpus strings', async () => {
  const args = bindingArgs(), binding = await textFeedbackInvocation(args);
  assert.deepEqual(Object.keys(binding.invocation).sort(), ['cellId', 'operation', 'producerPath', 'rawFeedback', 'sample', 'serial', 'tracePath']);
  assert.equal(binding.textAttempt.attemptId, 'cell-1/cold/scored/0');
  assert.deepEqual(binding.textAttempt.processIdentity, args.processIdentity);
  assert.equal(binding.textAttempt.actionPlan.sourcePlanSha256, hash(JSON.stringify(buildTextInteractionPlan())));
  assert.equal(binding.textAttempt.actionPlan.sha256, hash(JSON.stringify(binding.textAttempt.actionPlan.actions)));
  assert.equal(hash(JSON.stringify(sanitize(binding).textAttempt.actionPlan.actions)), binding.textAttempt.actionPlan.sha256);
  assert.equal(binding.textAttempt.actionPlan.actions.find(action => action.kind === 'caret').inputKey, 'ArrowLeft');
  assert.equal(binding.textAttempt.actionPlan.actions.length, 106);
  assert.equal(binding.textAttempt.actionPlan.observedExecution, false);
  assert.equal(binding.textAttempt.actionPlan.physicalInput, false);
  assert.equal(binding.textAttempt.textFixture.corpus.bytes, Buffer.byteLength(args.fixture.text.corpus.text));
  assert.equal(binding.invocation.producerPath, '/tmp/text-feedback/browser-cell-1.json');
  assert(!JSON.stringify(binding).includes('private mixed corpus'));
  assert(!JSON.stringify(binding).includes('private fragment'));
});

test('prime and scored attempts retain distinct canonical IDs', async () => {
  const args = bindingArgs(), scored = await textFeedbackInvocation(args);
  args.sample.prime = true;
  const prime = await textFeedbackInvocation(args);
  assert.notEqual(prime.textAttempt.attemptId, scored.textAttempt.attemptId);
  assert.equal(prime.textAttempt.attemptId, 'cell-1/cold/prime/0');
  assert.equal(prime.invocation.sample.prime, true);
});

test('WXs retains all sixteen font identities and raw selection with the exact output path', async () => {
  const args = bindingArgs('WXs');
  args.rawFeedbackSelection = {ownership: {browserInstanceId: 'configured-1'}, selectionProvenance: 'configured-campaign-local-scope-not-ownership-proof', actualRuntime: {engine: 'chromium'}};
  const value = await textFeedbackInvocation(args);
  assert.equal(value.textAttempt.textFixture.fonts.length, 16);
  assert.equal(value.invocation.rawFeedback.artifactPath, '/tmp/text-feedback/browser-feedback-1.raw.json');
  assert.notEqual(value.invocation.rawFeedback.ownership, args.rawFeedbackSelection.ownership);
  assert.equal(value.invocation.rawFeedback.selectionProvenance, args.rawFeedbackSelection.selectionProvenance);
});

test('changed launch seal, corrupted corpus, absent worker identity and invalid attempts cannot bind', async () => {
  for (const change of [value => {value.runtime.fixtureSeal.sha256 = hash('changed');},
    value => {value.fixture.text.corpus.text += 'tampered';}, value => {value.processIdentity = null;},
    value => {value.processIdentity.pid += 1;}, value => {value.processIdentity.node = 'v0.0.0';},
    value => {value.sample.ordinal = -1;}, value => {value.sample.prime = 'false';},
    value => {value.cell.workload = 'other';}, value => {value.cell.operation = 'text.native-ime';}]) {
    const args = bindingArgs(); change(args); await assert.rejects(textFeedbackInvocation(args));
  }
});

test('complete IText receipts map the original106 IDs to a diagnostic declaration only', () => {
  const value = textRawFeedbackCohort(complete());
  assert.equal(value.actions.length, 106); assert.equal(value.durationMs, 60_000); assert.equal(value.refreshHz, 60);
  assert.deepEqual(value.actions.map(action => action.id), buildTextInteractionPlan().map(action => action.id));
  assert.equal(value.observedExecution, false); assert.equal(value.qualification, false);
  assert.equal(value.actions.filter(action => action.kind === 'presentation-request').length, 6);
  assert.equal(value.actions.filter(action => action.kind === 'composition-commit-cancel').length, 10);
  assert.equal(value.actions.filter(action => action.kind === 'caret-selection').length, 10);
  assert.equal(value.actions.filter(action => action.kind === 'semantic-list').length, 10);
  assert.equal(value.actions.filter(action => action.kind === 'font-wrap-transform-guide').length, 10);
});

test('partial, failed, reordered, relabeled or late action receipts never create a complete cohort', () => {
  for (const change of [value => value.actions.pop(), value => {value.actions[0].outcome = 'failed';},
    value => {[value.actions[0], value.actions[1]] = [value.actions[1], value.actions[0]];},
    value => {value.actions[0].id = 'unobserved';}, value => {value.actions[0].scheduledMs += 1;},
    value => {value.actions.find(action => action.kind === 'preedit').nativeSource = 'physical-ime';},
    value => {value.actions[0].nativeSource = 'playwright-native-input';},
    value => {value.actions.find(action => action.kind === 'preedit').nativeSource = 'synthetic-app-handling';},
    value => {value.actions[0].readyMs = value.segment.endMs + 1;},
    value => {value.actions[0].inputMs = value.segment.startMs - 1;}]) {
    const value = complete(); change(value); assert.throws(() => textRawFeedbackCohort(value));
  }
});

test('missing or shortened windows and fabricated endpoints never create a complete cohort', () => {
  for (const change of [value => {value.segment = undefined;}, value => {value.segment.requestedMs = 59_000;},
    value => {value.segment.endMs -= 1;}, value => {value.segment.captureStoppedMs = value.segment.endMs - 1;},
    value => {value.segment.actualMs = 60_000;}, value => {value.segment.completedActionsAtMs = 60_001;},
    value => {value.segment.actions = 100;}, value => {value.segment.reservedFeedbackMs = 0;}]) {
    const value = complete(); change(value); assert.throws(() => textRawFeedbackCohort(value));
  }
});

test('one native anchor precedes one raw start and original end precedes one drain', async () => {
  const h = harness();
  await Promise.all([h.services.textSessionStart(h.request), h.services.textSessionStart(h.request)]);
  await Promise.all([h.services.textSessionEnd(h.request), h.services.textSessionEnd(h.request)]);
  assert.deepEqual(h.calls.slice(0, 3), ['native-start', 'trace-start', 'native-end']);
  assert.equal(h.calls.length, 4); assert.equal(h.calls[3][0], 'trace-stop');
  assert.equal(h.calls[3][1].rawFeedbackCohort.actions.length, 106);
  assert.deepEqual(h.missing, []);
});

test('native-only selection does not start or stop a second diagnostic trace', async () => {
  const h = harness({rawFeedbackSelected: false});
  await h.services.textSessionStart(h.request); await h.services.textSessionEnd(h.request);
  assert.deepEqual(h.calls, ['native-start', 'native-end']);
});

test('wrong session IDs never operate native anchors or the raw collector', async () => {
  const h = harness(), request = {...h.request, sessionId: 'different'};
  assert.equal((await h.services.textSessionStart(request)).status, 'unavailable');
  assert.equal((await h.services.textSessionEnd(request)).status, 'unavailable');
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.missing, ['text-native-start-session-mismatch', 'text-native-end-session-mismatch']);
});

test('native start failure leaves raw unavailable while the original product action still runs once', async () => {
  const h = harness({native: {start: async () => {throw 0;}}}); let runs = 0;
  assert.equal((await h.services.textSessionStart(h.request)).status, 'unavailable');
  assert.equal((await h.services.textInputHook({run: async () => ++runs})).value, 1);
  assert.equal(runs, 1); assert(!h.calls.includes('trace-start'));
  assert(h.missing.includes('text-native-start-unavailable')); assert(h.missing.includes('raw-feedback-native-start-unavailable'));
});

test('raw start failures are missing evidence without changing the native anchor', async () => {
  for (const start of [async () => ({status: 'unavailable'}), async () => {throw Error('CDP unavailable');}]) {
    const h = harness({trace: {start}});
    assert.equal((await h.services.textSessionStart(h.request)).status, 'complete');
    assert(h.missing.includes('raw-feedback-start-unavailable'));
  }
});

test('failed native end still drains the trace and records both closure failures separately', async () => {
  const h = harness({native: {end: async () => {throw false;}}, trace: {stop: async () => {throw Error('write failed');}}});
  assert.equal((await h.services.textSessionEnd(h.request)).status, 'unavailable');
  assert(h.missing.includes('text-native-end-unavailable')); assert(h.missing.includes('raw-feedback-stop-unavailable'));
});

test('partial text end drains without inventing the complete106 cohort', async () => {
  const h = harness(); h.request.actions = h.request.actions.slice(0, 2); h.request.segment = undefined;
  await h.services.textSessionEnd(h.request);
  assert.deepEqual(h.calls[1], ['trace-stop', {}]);
  assert(h.missing.includes('raw-feedback-itext-completed-cohort-unavailable'));
});

test('duplicate callback attempts preserve one exact original return object', async () => {
  const h = harness({native: {hook: async ({run}) => {await run(); return {value: await run(), bracket: {status: 'complete'}};}}});
  const original = {retained: true}; let runs = 0;
  assert.equal((await h.services.textInputHook({run: async () => {runs++; return original;}})).value, original);
  assert.equal(runs, 1); assert(h.missing.includes('text-native-duplicate-operation-attempt'));
});

test('instrumentation omission or failure before dispatch invokes the original operation once', async () => {
  for (const hook of [async () => undefined, async () => {throw 'instrumentation';}]) {
    const h = harness({native: {hook}}); let runs = 0;
    const observed = await h.services.textInputHook({run: async () => ++runs});
    assert.equal(observed.value, 1); assert.equal(observed.bracket, null);
    assert.equal(runs, 1); assert(h.missing.includes('text-native-hook-omitted-operation'));
  }
});

test('instrumentation failure after dispatch cannot replace a successful original value', async () => {
  const h = harness({native: {hook: async ({run}) => {await run(); throw 'instrumentation';}}});
  const original = Symbol('operation-result'); let runs = 0;
  const observed = await h.services.textInputHook({run: async () => {runs++; return original;}});
  assert.equal(observed.value, original); assert.equal(observed.bracket, null);
  assert.equal(runs, 1); assert(h.missing.includes('text-native-hook-failed'));
});

test('primitive or falsy original rejection survives instrumentation swallowing or rethrowing', async () => {
  for (const original of [undefined, null, false, 0, '', 'product-failure']) for (const swallow of [false, true]) {
    const h = harness({native: {hook: async ({run}) => {if (swallow) {try {await run();} catch {return 'ignored';}} else await run();}}});
    let runs = 0, caught = false;
    try {await h.services.textInputHook({run: async () => {runs++; throw original;}});} catch (error) {caught = true; assert.equal(error, original);}
    assert.equal(caught, true); assert.equal(runs, 1); assert(!h.missing.includes('text-native-hook-failed'));
  }
});

test('the execute classification seam treats every caught primitive as FAIL despite missing trace evidence', () => {
  for (const failure of [undefined, null, false, 0, '', 'product-failure']) {
    const result = browserActionOutcome({failure, caughtFailure: true, resultStatus: 'INCONCLUSIVE', missing: ['raw-feedback-unavailable']});
    assert.equal(result.status, 'FAIL'); assert.equal(result.failurePresent, true);
    assert.equal(result.actionCompleted, false); assert.equal(result.error.name, 'ThrownValue');
    assert.equal(result.error.code, null);
  }
  assert.equal(browserActionOutcome({resultStatus: 'PASS'}).status, 'PASS');
  assert.equal(browserActionOutcome({resultStatus: 'INCONCLUSIVE', missing: ['display-slots-unavailable']}).actionCompleted, true);
  assert.equal(browserActionOutcome({resultStatus: 'FAIL'}).actionCompleted, false);
  assert.equal(browserActionOutcome({nativeEvidenceStatuses: ['FAIL'], missing: ['display-slots-unavailable']}).status, 'FAIL');
});

test('failure diagnostics do not call thrown accessors and retain genuine prerequisite status', () => {
  let reads = 0;
  const failure = Object.defineProperties({}, Object.fromEntries(['name', 'code', 'message'].map(key => [key, {get() {reads++; throw Error('getter invoked');}}])));
  const result = browserActionOutcome({failure, caughtFailure: true});
  assert.equal(result.status, 'FAIL'); assert.equal(result.error.name, 'ThrownValue'); assert.equal(reads, 0);
  const prerequisite = browserActionOutcome({failure: new PrerequisiteError('exact missing prerequisite'), caughtFailure: true});
  assert.equal(prerequisite.status, 'INCONCLUSIVE'); assert.equal(prerequisite.actionCompleted, false);
  assert.equal(prerequisite.error.message, 'exact missing prerequisite');
});

test('discarded run promise is observed while native instrumentation waits without changing its rejection', async () => {
  const h = harness({native: {hook: async ({run}) => {void run(); await new Promise(resolve => setImmediate(resolve));}}});
  let caught = false, runs = 0;
  try {await h.services.textInputHook({run: async () => {runs++; throw false;}});} catch (error) {caught = true; assert.equal(error, false);}
  assert.equal(caught, true); assert.equal(runs, 1);
});

test('driver textAttempt services retain a detached exact identity without mutating the producer binding', async () => {
  const {textAttempt} = await textFeedbackInvocation(bindingArgs());
  const services = createTextFeedbackServices({native: {}, trace: {}, rawFeedbackSelected: false, sessionId: textAttempt.sessionId,
    plan: textAttempt.actionPlan.actions, textAttempt, missing: []});
  assert.deepEqual(services.textAttempt, textAttempt); assert.notEqual(services.textAttempt, textAttempt);
  services.textAttempt.textFixture.fonts[0].bytes += 1;
  assert.notEqual(services.textAttempt.textFixture.fonts[0].bytes, textAttempt.textFixture.fonts[0].bytes);
});

test('the actual native envelope survives while a mismatched value cannot carry its bracket', async () => {
  const original = Object.freeze({before: 'observed', after: 'observed'}), bracket = {before: {status: 'complete'}, after: {status: 'complete'}};
  let envelope;
  const h = harness({native: {hook: async ({run}) => {envelope = {value: await run(), bracket}; return envelope;}}});
  assert.equal(await h.services.textInputHook({run: async () => original}), envelope);
  assert.equal(envelope.value, original); assert.equal(envelope.bracket, bracket); assert.deepEqual(h.missing, []);
  const invalid = harness({native: {hook: async ({run}) => {await run(); return {value: {different: true}, bracket};}}});
  const fallback = await invalid.services.textInputHook({run: async () => original});
  assert.equal(fallback.value, original); assert.equal(fallback.bracket, null);
  assert(invalid.missing.includes('text-native-hook-envelope-unavailable'));
});
