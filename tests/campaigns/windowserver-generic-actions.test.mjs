import test from 'node:test';
import assert from 'node:assert/strict';
import {firstUseEnvironmentBinding} from '../../tooling/qualification/campaigns/windowserver-first-use.mjs';
import {discreteInputDescriptor} from '../../tooling/qualification/campaigns/browser-discrete-input.mjs';
import {genericInteractionInventory, genericNativeActionId, genericSessionNativeId} from '../../tooling/qualification/campaigns/browser-generic-input.mjs';
import {genericNativeConfiguration, genericOracleInventory, bracketGenericAction, createGenericWindowServerTransaction} from '../../tooling/qualification/campaigns/windowserver-generic-actions.mjs';

// AUTHORED ONLY. Protocol doubles never launch capture, mint a replay token,
// supply independently reviewed pixels, or establish qualification.
const sessionId = 'input-generic-lifecycle';
const runtime = () => ({headless: false, browserPid: 321, engine: 'chromium', version: '1.2.3', revision: '123',
  executableIdentity: {sha256: 'sha256:' + 'a'.repeat(64)}, fixtureSeal: {sha256: 'b'.repeat(64)},
  viewport: {width: 1440, height: 900}, deviceScaleFactor: 2});
const selection = () => ({kind: 'windowserver-generic-actions-configuration-1',
  build: {receiptPath: '/private/build/receipt.json', receiptSha256: 'c'.repeat(64)},
  oracle: {path: '/private/oracle/oracle.json', sha256: 'd'.repeat(64)}, displayID: 1, roi: {x: 10, y: 10, width: 2, height: 1},
  evidenceAllocation: {path: '/private/evidence/allocation.json', bytes: 128, sha256: 'e'.repeat(64)},
  evidenceReservation: {bytes: 1024 ** 3, trace: {bytes: 1024, files: 1, directories: 0},
    oracle: {bytes: 1024, files: 1, directories: 1}, control: {bytes: 1024, files: 3, directories: 0}}});
const descriptor = () => discreteInputDescriptor({sessionId, actionId: 'action-0', stepId: 'activate', family: 'undo', target: {control: 'mask-undo'}, input: {kind: 'click'}});
function oracle(selected) {
  return {kind: 'generic-action-pixel-oracle-1', schemaVersion: 1, profile: 'interaction-100-2400-60hz-60s-1', pixelFormat: 'BGRA8',
    binding: {fixtureSha256: selected.environment.fixtureSha256, browserEnvironmentSha256: selected.environment.browserEnvironmentSha256},
    display: {id: 1, width: 100, height: 60}, roi: {...selected.selection.roi},
    actions: genericInteractionInventory().map((action, sequence) => ({sequence, family: action.kind, stateSha256: 'a'.repeat(64),
      endpoints: Array.from({length: action.kind === 'stroke' ? 120 : 1}, (_, ordinal) => ({ordinal,
        subject: action.kind === 'stroke' ? 'mask-stroke-prefix' : action.kind + '-complete-action', kind: 'unavailable', reason: 'independent-oracle-not-reviewed'})),
      ...(action.kind === 'stroke' ? {acknowledgement: {kind: 'unavailable', reason: 'meaningful-stroke-prefix-not-reviewed'}} : {})}))};
}
function lifecycle({startFailure, stopFailure, displayMismatch = false} = {}) {
  const calls = [], selected = genericNativeConfiguration(selection(), runtime()), expectedOracle = oracle(selected);
  let time = 10;
  const capture = {ready: {display: displayMismatch ? {...expectedOracle.display, id: 2} : expectedOracle.display, windowAdmission: {windowNumber: 7}},
    config: {schemaVersion: 2}, processIdentity: {kind: 'synthetic-process-observation'},
    async captureClock(id) {calls.push(id); return {schemaVersion: 2, event: 'clock', id, mach: String(++time)};},
    async stop() {calls.push('stop'); if (stopFailure) throw stopFailure; return {manifest: {path: '/retained/manifest.json'}, process: {kind: 'synthetic-process-observation'}};}};
  const transaction = createGenericWindowServerTransaction({sessionId, config: selected.config,
    binding: {browser: runtime(), environment: selected.environment}, oracle: expectedOracle, oracleBytes: Buffer.from('{}'),
    oracleSha256: 'd'.repeat(64), pixelIdentities: [], async startCapture() {calls.push('start'); if (startFailure) throw startFailure; return capture;}});
  return {transaction, calls};
}

test('generic selection binds the owned headed process while its oracle environment remains stable', () => {
  const value = genericNativeConfiguration(selection(), runtime());
  assert.equal(value.config.expectedBrowserPid, 321); assert.equal(value.config.profile, 'interaction-100-2400-60hz-60s-1');
  assert.deepEqual(genericNativeConfiguration(selection(), {...runtime(), browserPid: 999}).environment, value.environment);
  assert.notEqual(firstUseEnvironmentBinding({...runtime(), version: '1.2.4'}).browserEnvironmentSha256, value.environment.browserEnvironmentSha256);
  assert.equal(value.config.evidenceBudget, undefined); // Live budget inspection supplies this later.
});

test('unsupported selection keys, unheaded runtimes and malformed ROI fail before capture', () => {
  for (const change of [
    value => {value.kind = 'other';}, value => {value.arbitraryBinary = '/private/unreviewed';},
    value => {value.roi.width = 0;}, value => {value.roi.x = -1;}, value => {value.oracle.sha256 = 'unsealed';},
    value => {value.build.receiptPath = 'relative';},
  ]) {const value = selection(); change(value); assert.throws(() => genericNativeConfiguration(value, runtime()));}
  assert.throws(() => genericNativeConfiguration(selection(), {...runtime(), headless: true}));
});

test('oracle preflight retains the complete action, diagnostic and acknowledgement census without making pixels', () => {
  const selected = genericNativeConfiguration(selection(), runtime()), value = oracle(selected), inventory = genericOracleInventory(value, selected);
  assert.equal(value.actions.length, 100); assert.equal(value.actions.reduce((sum, action) => sum + action.endpoints.length, 0), 2480);
  assert.equal(value.actions.filter(action => action.acknowledgement).length, 20);
  assert.deepEqual(inventory.files, []); assert.equal(inventory.pixelBytes, 0); assert.deepEqual(inventory.directories, ['.']);
});

test('oracle preflight deduplicates only exactly matching paths and retains required directories', () => {
  const selected = genericNativeConfiguration(selection(), runtime()), value = oracle(selected);
  const before = {path: 'panels/before.bgra', sha256: 'c'.repeat(64), bytes: 8}, after = {path: 'panels/after.bgra', sha256: 'd'.repeat(64), bytes: 8};
  for (const sequence of [1, 6]) value.actions[sequence].endpoints[0] = {ordinal: 0, subject: 'undo-complete-action', kind: 'pixels', before: {...before}, after: {...after}};
  const inventory = genericOracleInventory(value, selected);
  assert.equal(inventory.files.length, 2); assert.equal(inventory.pixelBytes, 16); assert(inventory.directories.includes('panels'));
  value.actions[6].endpoints[0].before.sha256 = 'e'.repeat(64); assert.throws(() => genericOracleInventory(value, selected), /conflicting pins/);
});

test('oracle preflight rejects missing actions, wrong semantic endpoints and unsafe pixel identities', () => {
  const selected = genericNativeConfiguration(selection(), runtime());
  for (const change of [
    value => {value.actions.pop();}, value => {value.actions[0].endpoints.pop();}, value => {value.actions[1].family = 'layer';},
    value => {value.actions[1].endpoints[0].subject = 'unrelated-spinner';}, value => {value.binding.fixtureSha256 = 'e'.repeat(64);},
    value => {value.roi.x++;}, value => {value.actions[1].endpoints[0] = {ordinal: 0, subject: 'undo-complete-action', kind: 'pixels',
      before: {path: '../escape.bgra', sha256: 'c'.repeat(64), bytes: 8}, after: {path: 'after.bgra', sha256: 'd'.repeat(64), bytes: 8}};},
    value => {delete value.actions[0].acknowledgement;},
  ]) {const value = oracle(selected); change(value); assert.throws(() => genericOracleInventory(value, selected));}
});

test('native bracket encloses the actual product call once and preserves its return identity', async () => {
  const calls = [], expected = {dispatchCompleted: true}, d = descriptor(), actionId = genericNativeActionId(d);
  const result = await bracketGenericAction({descriptor: d, async captureClock(id) {calls.push(id); return {schemaVersion: 2, event: 'clock', id, mach: id.endsWith('before') ? '10' : '20'};},
    async run() {calls.push('product'); return expected;}});
  assert.deepEqual(calls, [actionId + '-before', 'product', actionId + '-after']); assert.equal(result.value, expected); assert.equal(result.bracket.status, 'complete');
});

test('clock failure preserves a completed product call and unavailable instrumentation', async () => {
  let products = 0;
  const result = await bracketGenericAction({descriptor: descriptor(), async captureClock() {throw Error('clock unavailable');},
    async run() {products++; return {dispatchCompleted: true};}});
  assert.equal(products, 1); assert.equal(result.value.dispatchCompleted, true); assert.equal(result.bracket.status, 'unavailable');
  assert.equal(result.bracket.before, null); assert.equal(result.bracket.after, null);
});

test('frozen and primitive product exceptions survive native instrumentation unchanged', async () => {
  for (const failure of [Object.freeze(Error('product failure')), 'product failure', undefined]) {
    let clocks = 0;
    await bracketGenericAction({descriptor: descriptor(), async captureClock(id) {clocks++; return {schemaVersion: 2, event: 'clock', id, mach: '10'};},
      async run() {throw failure;}}).then(() => assert.fail('Expected original product exception'), error => assert.equal(error, failure));
    assert.equal(clocks, 1);
  }
});

test('transaction starts lazily, retains full anchors and closes once with detached diagnostics', async () => {
  const {transaction, calls} = lifecycle(); assert.deepEqual(calls, []);
  const begin = await transaction.start(), d = descriptor();
  assert.equal(begin.kind, 'generic-native-session-anchor-1'); assert.equal(begin.ack.schemaVersion, 2);
  assert.equal(begin.ack.id, genericSessionNativeId(sessionId) + '-begin');
  await transaction.hook({descriptor: d, async run() {calls.push('product'); return {dispatchCompleted: true};}});
  const end = await transaction.end(); assert.equal(end.ack.id, genericSessionNativeId(sessionId) + '-end');
  const result = await transaction.finish({result: {nativeSessionStart: begin, nativeSessionEnd: end}, actionCompleted: false});
  assert.equal(calls.filter(value => value === 'product').length, 1); assert.equal(calls.at(-1), 'stop');
  assert.equal(result.join, null); assert.equal(result.qualification, false); assert(result.missing.includes('generic-product-session-not-completed'));
  result.binding.browser.browserPid = 999;
  assert.equal((await transaction.finish()).binding.browser.browserPid, 321); assert.equal(calls.filter(value => value === 'stop').length, 1);
});

test('failed native startup still permits the existing product input and retains missing evidence', async () => {
  const {transaction, calls} = lifecycle({startFailure: Error('native start failed')}), begin = await transaction.start();
  assert.equal(begin.status, 'unavailable'); let products = 0;
  const step = await transaction.hook({descriptor: descriptor(), async run() {products++; return {dispatchCompleted: true};}});
  assert.equal(products, 1); assert.equal(step.bracket.status, 'unavailable');
  await transaction.end(); const result = await transaction.finish({actionCompleted: false});
  assert(result.missing.includes('generic-native-session-start-unavailable')); assert.equal(result.join, null); assert(!calls.includes('stop'));
});

test('display admission or native stop failure cannot turn a product input into a pixel qualification', async () => {
  for (const options of [{displayMismatch: true}, {stopFailure: Error('native stop failed')}]) {
    const {transaction, calls} = lifecycle(options); await transaction.start();
    let products = 0; await transaction.hook({descriptor: descriptor(), async run() {products++; return {dispatchCompleted: true};}});
    await transaction.end(); const result = await transaction.finish({actionCompleted: false});
    assert.equal(products, 1); assert.equal(calls.filter(value => value === 'stop').length, 1);
    assert.equal(result.join, null); assert.equal(result.qualification, false);
    assert(result.missing.includes(options.displayMismatch ? 'generic-native-session-start-unavailable' : 'generic-native-closure-unavailable'));
  }
});

test('duplicate, wrong-session and post-end dispatches fail without replaying product input', async () => {
  const {transaction} = lifecycle(), d = descriptor(); let products = 0;
  const run = async () => {products++; return {dispatchCompleted: true};};
  await assert.rejects(transaction.hook({descriptor: d, run})); await transaction.start();
  await assert.rejects(transaction.hook({descriptor: {...d, sessionId: 'other-session'}, run}));
  await transaction.hook({descriptor: d, run}); await assert.rejects(transaction.hook({descriptor: d, run}));
  await transaction.end(); await assert.rejects(transaction.hook({descriptor: {...d, actionId: 'action-1'}, run}));
  await assert.rejects(transaction.end()); await transaction.finish({actionCompleted: false}); await assert.rejects(transaction.start());
  assert.equal(products, 1);
});
