import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {runBrowserAction} from '../../tooling/qualification/campaigns/browser-driver.mjs';
import {browserActionOutcome, retainBrowserActionFailure} from '../../tooling/qualification/campaigns/browser.mjs';
import {extractBrowserMeasurements} from '../../tooling/qualification/campaigns/browser-measurements.mjs';
import {ORDINARY_COMPOSITION_NAMES} from '../../tooling/qualification/campaigns/browser-ordinary-composition.mjs';
import {queueBrowserScenario} from '../../tooling/qualification/campaigns/browser-queue.mjs';

// Behavioral orchestration tests use the actual driver and the actual nested
// controller body with strict boundary doubles. No browser, provider, physical
// observation, or qualification receipt is produced by these tests.
const sample = {cache: 'cold', ordinal: 1, prime: false};
const cell = () => ({id: 'ordinary-composition/reopen', operation: 'portable.reopen', workload: 'W1', requirements: {presentationTrace: false}, requiredMeasurements: []});
const copy = value => structuredClone(value);
const vmAssert = Object.assign((...args) => assert(...args), assert, {
  deepEqual(actual, expected, message) {assert.deepEqual(copy(actual), copy(expected), message);},
});

function navigationPage({failure, failAt} = {}) {
  const events = [], document = {width: 32, height: 16, revision: '7', image: {compositeAssetId: 'owned-composite'}};
  const record = event => {events.push(event); if (event === failAt) throw failure;};
  const locator = (role, name) => ({
    getByRole(childRole, options) {assert.equal(role, 'dialog'); return locator(childRole, options.name);},
    filter() {return this;},
    async click() {record(name instanceof RegExp ? 'select-document' : 'click:' + name);},
    async waitFor(options) {record('wait:' + name + ':' + options.state);},
    async getAttribute(name) {assert.equal(name, 'data-asset'); record('read:canvas-asset'); return 'owned-composite';},
  });
  const page = {
    async goto(url) {assert.equal(url, 'http://127.0.0.1:4000/paired'); record('goto');},
    getByRole(role, options) {return locator(role, options.name);},
    getByText(text) {return locator('text', text);},
    locator(selector) {return locator('selector', selector);},
    async evaluate(callback, path) {
      assert.equal(path, '/api/v1/documents/owned-document'); record('read:document');
      return copy(await runInNewContext('(' + callback.toString() + ')', {fetch: async actual => {
        assert.equal(actual, path); return {ok: true, json: async () => ({projection: {value: document}})};
      }})(path));
    },
  };
  return {page, events};
}

test('portable reopen brackets the original navigation, public Open, and accepted checkpoint exactly once', async () => {
  const {page, events} = navigationPage(); let entered = 0, exited = 0;
  const compositionObservation = {async navigation(action) {entered++; events.push('old-realm-close'); try {return await action();} finally {events.push('fresh-realm-close'); exited++;}}};
  const result = await runBrowserAction({page, cell: cell(), fixture: {documentId: 'owned-document'}, pair: async () => {events.push('pair'); return 'http://127.0.0.1:4000/paired';}, services: {compositionObservation}});
  assert.equal(entered, 1); assert.equal(exited, 1);
  assert.equal(events[0], 'old-realm-close'); assert.equal(events.at(-1), 'fresh-realm-close');
  for (const event of ['pair', 'goto', 'click:Open', 'select-document', 'click:Save checkpoint', 'wait:SaveCheckpoint accepted and saved locally.:visible']) assert.equal(events.filter(value => value === event).length, 1, event);
  assert.deepEqual(events.filter(event => event.startsWith('click:') || event === 'select-document'), ['click:Open', 'select-document', 'click:Save checkpoint']);
  assert(events.indexOf('click:Open') > events.indexOf('goto'));
  assert(events.indexOf('click:Save checkpoint') > events.indexOf('select-document'));
  assert.equal(result.documentId, 'owned-document'); assert.equal(result.acceptedTestEdit, true); assert.equal(result.publicOpenCompleted, true);
  assert.equal(result.presentation, 'awaiting independent trace correlation');
});

test('unobserved navigation retains the same one-action behavior', async () => {
  const {page, events} = navigationPage();
  const result = await runBrowserAction({page, cell: cell(), fixture: {documentId: 'owned-document'}, pair: async () => 'http://127.0.0.1:4000/paired'});
  assert.equal(events.filter(value => value === 'goto').length, 1); assert.equal(events.filter(value => value === 'click:Save checkpoint').length, 1);
  assert.equal(result.acceptedTestEdit, true); assert(!events.includes('old-realm-close'));
});

for (const failure of [Error('navigation failed'), null, undefined, false]) test('navigation retains rejection ' + String(failure) + ' and never repeats an action', async () => {
  const {page, events} = navigationPage({failure, failAt: 'goto'}); let closed = 0, caught = false;
  try {
    await runBrowserAction({page, cell: cell(), fixture: {documentId: 'owned-document'}, pair: async () => 'http://127.0.0.1:4000/paired',
      services: {compositionObservation: {async navigation(action) {try {return await action();} finally {closed++;}}}}});
  } catch (error) {caught = true; assert.equal(error, failure);}
  assert.equal(caught, true); assert.equal(closed, 1); assert.equal(events.filter(value => value === 'goto').length, 1);
  assert(!events.includes('click:Open')); assert(!events.includes('click:Save checkpoint'));
});

test('serialized composition observations and proof-shaped objects never issue resource measurements', () => {
  for (const operation of ['portable.reopen', 'fast.workflow', 'navigation.ready']) for (const name of ORDINARY_COMPOSITION_NAMES) {
    const rule = {name, budgetId: 'R38', unit: name.includes('Bytes') ? 'bytes' : 'violations'};
    const value = {cell: {...cell(), operation, requiredMeasurements: [rule]}, sample,
      result: {observations: {ordinaryComposition: {analysis: {measurements: [{...rule, value: 0}], missing: [], failures: []}, complete: true}}},
      ordinaryCompositionProof: {complete: true, binding: {cellId: cell().id}, measurements: [{...rule, value: 0}]}};
    const translated = extractBrowserMeasurements(value);
    assert.deepEqual(translated.measurements, []); assert.equal(translated.unavailable.length, 1);
    assert.equal(translated.unavailable[0].name, name); assert.equal(typeof translated.unavailable[0].reason, 'string');
  }
});

// Execute the real nested controller body so failures in ordering, exception
// handling, proof routing, or the surrounding finally cannot be hidden by a
// separately exported test-only approximation of those branches.
async function controllerHarness(options = {}) {
  const source = await readFile(new URL('../../tooling/qualification/campaigns/browser.mjs', import.meta.url), 'utf8');
  const begin = '  async function execute(cell, sample = {}) {', end = '\n  async function close() {';
  assert.equal(source.split(begin).length, 2); assert.equal(source.split(end).length, 2);
  const body = source.slice(source.indexOf(begin), source.indexOf(end));
  const events = [], privateProof = Object.freeze({}), observation = {analysis: {measurements: [], missing: options.missing ?? [], failures: options.failures ?? []}};
  let now = 1, actions = 0, finishes = 0, finishFailed, extractedProof;
  const fontProof = Object.freeze({}), fontObservation = {analysis: {measurements: [], missing: [], failures: []}};
  let fontCreated = 0, fontFinishes = 0, fontFailed, extractedFontProof, ownedFontObserver;
  const scope = {
    repo: '/fixture-product', root: '/fixture-root',
    assertCell() {}, closed: false, signal: new AbortController().signal, backendOnly: new Set(), prepareCell: async () => {}, resetMissing: [],
    fixture: {workload: 'W1'}, browserOptions: options.byteAudit ? {byteAudit: true} : {}, vitalOperations: new Set(), canonicalVitals: null,
    navigations: new Set(['navigation.ready', 'portable.reopen']), page: {evaluate: async () => 'visible', async goto() {events.push('later-navigation');}},
    serial: 0, errors: [], external: [], commandReceipts: [], queueOperations: new Set(['fast.workflow']), monotonic: () => now++,
    createBrowserTrace: () => ({start: async () => {}, stop: async () => ({})}), activeQueueTrace: undefined, browserGeneration: 1,
    randomUUID: () => '12345678-1234-4567-8901-123456789abc', d11Collector: null, byteAuditFeatureActions: () => [],
    browserActionOutcome, retainBrowserActionFailure, ORDINARY_TEXT_OPERATIONS: [], TEXT_RESOURCE_OPERATIONS: [], ORDINARY_COMPOSITION_OPERATIONS: ['portable.reopen', 'fast.workflow'],
    context: {services: options.services, ordinaryCompositionEnvironment: {sourceDigest: 'expected-environment'}, reopenFontEnvironment: {sourceDigest: 'expected-font-environment'}, processIdentity: {pid: 9}},
    nativeBrowserRuntime: {browserPid: 10}, output: '/evidence', pendingReplies: [], readinessEvidence: {}, replacedRealms: [], resources: {},
    rawVitals: {snapshot: () => ({})}, readPhaseSnapshot: async () => ({}), gestures: {}, lifecycleCycle: {}, readinessController: {},
    server: {pair: async () => 'http://127.0.0.1:4000/paired', pid: 11},
    createReopenFontObserver(args) {
      assert.equal(args.repo, scope.repo); assert.equal(args.root, scope.root);
      assert.equal(args.environment, scope.context.reopenFontEnvironment); assert.equal(args.runtime, scope.nativeBrowserRuntime);
      // Composition-only originals explicitly leave font evidence unavailable.
      // Opted controls below test ownership routing; this double issues no real font proof.
      if (!options.reopenFonts) return null;
      fontCreated++; ownedFontObserver = {navigation: action => action(), async finish({failed}) {fontFinishes++; fontFailed = failed; return {proof: fontProof, observation: fontObservation};}};
      return ownedFontObserver;
    },
    createOrdinaryCompositionObserver(args) {
      assert.equal(args.cell.operation, 'portable.reopen'); assert.equal(args.environment, scope.context.ordinaryCompositionEnvironment);
      assert.equal(args.runtime, scope.nativeBrowserRuntime); assert.equal(args.processIdentity, scope.context.processIdentity); events.push('created');
      return {
        async observe(action) {events.push('observe-start'); try {return await action();} finally {events.push('observe-end');}},
        async navigation(action) {return action();},
        async finish({failed}) {finishes++; finishFailed = failed; events.push('finish'); if (options.closureThrows) throw Error('capture failed'); return {proof: privateProof, observation};},
      };
    },
    async runBrowserAction(args) {
      actions++; events.push('action');
      if (options.reopenFonts && !options.byteAudit) assert.equal(args.services.reopenFonts, ownedFontObserver);
      if (!options.byteAudit) assert.equal(typeof args.services.compositionObservation.navigation, 'function');
      else assert.equal(args.services.compositionObservation, undefined);
      if (Object.hasOwn(options, 'actionFailure')) throw options.actionFailure;
      return options.result ?? {documentId: 'retained-document', acceptedTestEdit: true};
    },
    ownFailureData(value, name) {return value != null ? Object.getOwnPropertyDescriptor(Object(value), name)?.value : undefined;},
    releasePendingPhaseSnapshots: async () => {}, egress: {supported: true, evidence: () => ({counts: {accepted: 1}})},
    extractBrowserMeasurements(args) {events.push('extract'); extractedProof = args.ordinaryCompositionProof; extractedFontProof = args.reopenFontProof; return {measurements: [], unavailable: []};},
    interactionSession: () => null, readOrdinaryTextProof: () => null, sanitize: value => value, join,
    writeFile: async () => {events.push('publish');}, previousResult: null,
  };
  const execute = runInNewContext('(' + body + ')', scope);
  const result = await execute(cell(), sample);
  return {result, events, actions, finishes, finishFailed, privateProof, extractedProof, observation, fontProof, fontObservation, fontCreated, fontFinishes, fontFailed, extractedFontProof};
}

test('actual campaign controller observes the one action and forwards only its privately returned proof', async () => {
  const value = await controllerHarness();
  assert.equal(value.actions, 1); assert.equal(value.finishes, 1); assert.equal(value.finishFailed, false);
  assert.deepEqual(value.events, ['created', 'observe-start', 'action', 'observe-end', 'finish', 'extract', 'publish']);
  assert.equal(value.extractedProof, value.privateProof); assert.equal(value.result.observations.ordinaryComposition, value.observation);
  assert.equal(value.result.observations.documentId, 'retained-document'); assert.equal(value.result.observations.acceptedTestEdit, true);
  assert.equal(value.result.status, 'PASS');
});

for (const failure of [Error('product failed'), undefined, false]) test('actual campaign controller closes and keeps failed action ' + String(failure), async () => {
  const value = await controllerHarness({actionFailure: failure});
  assert.equal(value.actions, 1); assert.equal(value.finishes, 1); assert.equal(value.finishFailed, true);
  assert.equal(value.result.status, 'FAIL'); assert.equal(value.result.failureClassification.productFailureSeen, true);
  assert.equal(value.result.observations.ordinaryComposition, value.observation);
});

test('composition contradiction remains FAIL while missing or failed collection remains unavailable', async () => {
  const contradicted = await controllerHarness({failures: ['changed-prompt-counter']});
  assert.equal(contradicted.result.status, 'FAIL'); assert.equal(contradicted.result.failureClassification.productFailureSeen, true);
  const missing = await controllerHarness({missing: ['unobserved-realm-transition']});
  assert.equal(missing.result.status, 'INCONCLUSIVE'); assert(missing.result.missing.includes('unobserved-realm-transition'));
  const rejected = await controllerHarness({closureThrows: true});
  assert.equal(rejected.actions, 1); assert.equal(rejected.finishes, 1); assert.equal(rejected.extractedProof, undefined);
  assert.equal(rejected.result.status, 'INCONCLUSIVE'); assert(rejected.result.missing.includes('ordinary-composition-observation-closure-unavailable'));
});

test('reserved external observation service is rejected before any product action', async () => {
  const value = await controllerHarness({services: {compositionObservation: {observe: action => action()}}});
  assert.equal(value.actions, 0); assert.equal(value.finishes, 0); assert.equal(value.result.status, 'FAIL');
  assert.equal(value.extractedProof, undefined);
});

test('separate byte-audit keeps its original action and never creates a composition timing observer', async () => {
  const value = await controllerHarness({byteAudit: true});
  assert.equal(value.actions, 1); assert.equal(value.finishes, 0); assert.equal(value.extractedProof, undefined);
  assert.deepEqual(value.events, ['action', 'later-navigation', 'publish']);
});

async function queueNavigationHarness(scenario, options = {}) {
  const source = await readFile(new URL('../../tooling/qualification/campaigns/browser-queue.mjs', import.meta.url), 'utf8');
  const begin = 'export async function runQueueBrowserCell(';
  assert.equal(source.split(begin).length, 2);
  const body = source.slice(source.indexOf(begin)).replace(/^export /, '');
  const events = [], job = {id: 'job', attempts: [{id: 'attempt', state: 'acknowledged'}]}, document = {image: {asset: 'owned-image'}};
  let now = 1, submitted = false, submissions = 0, navigationCount = 0, navigationClosed = 0;
  const control = {counts: {submissions: 0, media: 0}, failures: []};
  const node = name => ({async selectOption() {}, async fill() {}, async click() {events.push('click:' + name);}, getByRole(_role, options) {return node(options.name);}, getByText() {return {first: () => ({waitFor: async () => {}})};}});
  const page = {getByRole(_role, options) {return node(options.name);}, async reload() {events.push('reload'); if (options.reloadFailure) throw Error('reload failed');},
    waitForRequest: async () => ({postDataJSON: () => ({command: {clientId: 'client', sessionId: 'session', expectedEntityVersions: {}}})}),
    context: () => ({setOffline: async value => events.push('offline:' + value)})};
  const controls = {read: async () => copy({...control, counts: {...control.counts, submissions}}), async set(value) {
    if (value.paused === false) submissions++;
    if (value.status === 'COMPLETED') control.counts.media++;
    return {quiescent: true, workerIdentity: {}, controlSequence: 1};
  }};
  const scope = {assert: vmAssert, queueBrowserScenario, monotonic: () => now++, PrerequisiteError: Error,
    allJobs: async () => submitted ? [job] : [], publicRead: async (_page, path) => path.includes('/candidates?') ? {items: [{id: 'candidate', state: 'prepared', preparedAssetId: 'asset'}]} : {projection: {value: document}},
    numeric: async () => {}, click: async (_page, name) => events.push('click:' + name),
    acceptedCommand: async (_page, _type, action) => {await action(); submitted = true; return {commandId: 'command'};},
    until: async (work, accept) => {const value = await work(); assert(accept(value)); return value;},
    reorderQueueForFixture: async () => ({}), showQueueJob: async () => {events.push('show-job'); return node('card');},
    ready: async () => events.push('ready'), openDocument: async () => events.push('open-document'), intervalWait: async () => {},
  };
  const compositionObservation = {async navigation(action) {navigationCount++; events.push('old-realm-close'); try {return await action();} finally {navigationClosed++; events.push('fresh-realm-close');}}};
  const run = runInNewContext('(' + body + ')', scope);
  const selected = scenario === 'reconnect' ? {operation: 'fast.workflow', parameters: {caseId: 'WF14'}} : {operation: 'queue.fault', parameters: {scenario}};
  let result, error;
  try {result = await run({page, cell: selected, fixture: {documentId: 'doc'}, controls, services: {compositionObservation}});} catch (caught) {error = caught;}
  return {result, error, events, navigationCount, navigationClosed, submissions};
}

for (const scenario of ['reconnect', 'offline-completion']) test('actual queue ' + scenario + ' retains one reload and exact before/after realm bracket', async () => {
  const value = await queueNavigationHarness(scenario);
  assert.equal(value.error, undefined); assert.equal(value.result.status, 'PASS'); assert.equal(value.submissions, 1);
  assert.equal(value.navigationCount, 1); assert.equal(value.navigationClosed, 1);
  assert.deepEqual(value.events.filter(event => ['old-realm-close', 'reload', 'ready', 'open-document', 'fresh-realm-close'].includes(event)), ['old-realm-close', 'reload', 'ready', 'open-document', 'fresh-realm-close']);
  if (scenario === 'reconnect') assert(value.events.indexOf('click:Check existing request attempt') < value.events.indexOf('fresh-realm-close'));
});

test('queue reload failure remains the original product failure without replay or second submission', async () => {
  const value = await queueNavigationHarness('reconnect', {reloadFailure: true});
  assert.equal(value.error?.message, 'reload failed'); assert.equal(value.result, undefined);
  assert.equal(value.navigationCount, 1); assert.equal(value.navigationClosed, 1); assert.equal(value.submissions, 1);
  assert.equal(value.events.filter(event => event === 'reload').length, 1); assert(!value.events.includes('open-document'));
});


// These additions bind the new factory in the real execute() extraction. They
// test private identity forwarding only; the font module owns proof validation.
test('actual campaign controller routes the owned reopen font observer and its returned proof only',async()=>{
 const forged={kind:'serialized-font-proof',complete:true};
 const value=await controllerHarness({reopenFonts:true,result:{documentId:'retained-document',acceptedTestEdit:true,publicOpenCompleted:true,startupBoundary:'document-ready-via-Open',authoritativeDOMReadyMs:75,reopenFontProof:forged}});
 assert.equal(value.actions,1);assert.equal(value.fontCreated,1);assert.equal(value.fontFinishes,1);assert.equal(value.fontFailed,false);
 assert.strictEqual(value.extractedFontProof,value.fontProof);assert.notStrictEqual(value.extractedFontProof,forged);assert.strictEqual(value.result.observations.reopenFonts,value.fontObservation);
 assert.strictEqual(value.extractedProof,value.privateProof);assert.equal(value.finishes,1);assert.equal(value.result.status,'PASS');
 assert.equal(value.result.observations.documentId,'retained-document');assert.equal(value.result.observations.acceptedTestEdit,true);assert.equal(value.result.observations.publicOpenCompleted,true);assert.equal(value.result.observations.startupBoundary,'document-ready-via-Open');assert.equal(value.result.observations.authoritativeDOMReadyMs,75);
});

test('actual campaign controller closes font observation on action failure and omits it in byte audit',async()=>{
 const failed=await controllerHarness({reopenFonts:true,actionFailure:false});
 assert.equal(failed.actions,1);assert.equal(failed.fontCreated,1);assert.equal(failed.fontFinishes,1);assert.equal(failed.fontFailed,true);assert.equal(failed.result.status,'FAIL');
 assert.equal(failed.result.failureClassification.productFailureSeen,true);assert.strictEqual(failed.extractedFontProof,failed.fontProof);
 const separate=await controllerHarness({reopenFonts:true,byteAudit:true});
 assert.equal(separate.actions,1);assert.equal(separate.fontCreated,0);assert.equal(separate.fontFinishes,0);assert.equal(separate.extractedFontProof,undefined);
});

test('actual campaign controller rejects external reopen observers before product action',async()=>{
 for(const name of ['reopenFonts','reopenResources']){
  const value=await controllerHarness({services:{[name]:{navigation:action=>action(),checkpoint:async()=>{}}},reopenFonts:true});
  assert.equal(value.actions,0);assert.equal(value.fontCreated,0);assert.equal(value.fontFinishes,0);assert.equal(value.extractedFontProof,undefined);assert.equal(value.result.status,'FAIL');
 }
});
