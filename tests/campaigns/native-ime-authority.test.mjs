import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, symlink, rm, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {nativeImeHash, nativeImeSelection, inspectNativeImeOperator, inspectNativeImeReview} from '../../tooling/qualification/campaigns/native-ime-authority.mjs';
import {readNativeImeFile} from '../../tooling/qualification/campaigns/browser-native-ime.mjs';
import {evaluateNativeImeProof, isNativeImeEvidencePath, verifyNativeImeEvidence} from '../../tooling/qualification/campaigns/native-ime-verification.mjs';

// Synthetic authority objects below exercise validation; they are never an
// actual operator review, physical witness or qualification receipt.
const h = nativeImeHash;
function fixture() {
  const evidence = [{path: '/original/settings.record', role: 'os-input-settings', bytes: 8, sha256: h('settings')}];
  const plan = {inputSource: 'japanese'}, operator = {kind: 'native-ime-operator-1', actualNative: true, operatorId: 'operator-A', method: {kind: 'human', description: 'Synthetic unit fixture only'}, inputSource: {language: 'japanese', id: 'test.ime', build: '1'}, dictionary: 'default', settings: 'fixture', os: {name: 'macOS', version: '15.7', build: 'test'}, evidence};
  const nonce = 'a'.repeat(32), artifact = name => ({path: 'native-ime-' + nonce + '/' + name + '.json', bytes: 4, sha256: h(name)});
  const context = {operator, plan, nonce, binding: artifact('binding'), raw: artifact('raw'), planArtifact: artifact('plan'), sealedAt: 1000, receivedAt: 2000, reviewTimeoutMs: 120000};
  const review = {kind: 'native-ime-review-1', complete: true, actualNative: true, synthetic: false, collectorGenerated: false, reviewerId: 'reviewer-B', method: 'Independent synthetic unit fixture', observations: 'Not actual native evidence', evidence: evidence.map(row => ({...row, role: 'native-session-observation'})), nonce, binding: context.binding, raw: context.raw, plan: context.planArtifact, inputSource: 'japanese', reviewedAt: new Date(1500).toISOString()};
  return {operator, plan, review, context};
}
test('native selection is explicit, workload-specific and bounded outside the fixed segment', () => {
  assert.deepEqual(nativeImeSelection({kind: 'native-ime-selection-1', operatorPaths: {WXn: '/original/japanese.json', WXs: '/original/chinese.json'}}, 'WXs'), {kind: 'native-ime-selection-1', operatorPath: '/original/chinese.json', armTimeoutMs: 30000, reviewTimeoutMs: 120000});
  for (const change of [{reviewTimeoutMs: 120001}, {armTimeoutMs: 30001}, {reviewTimeoutMs: 0}, {allowSynthetic: true}, {operatorPaths: {other: '/tmp/a'}}]) assert.throws(() => nativeImeSelection({kind: 'native-ime-selection-1', operatorPaths: {WXn: '/tmp/a'}, ...change}, 'WXn'));
});
test('native operator metadata requires actual source, build, dictionary, settings and original evidence', () => {
  const {operator, plan} = fixture(); assert.equal(inspectNativeImeOperator(operator, plan).status, 'PASS');
  for (const change of [{actualNative: false}, {operatorId: ''}, {dictionary: ''}, {evidence: []}, {inputSource: {...operator.inputSource, language: 'simplified-chinese'}}]) assert.equal(inspectNativeImeOperator({...operator, ...change}, plan).status, 'INCONCLUSIVE');
  assert.equal(inspectNativeImeOperator(operator, plan).qualification, false);
});
test('summary booleans cannot replace independent fresh raw-bound review', () => {
  const {review, context} = fixture(); assert.equal(inspectNativeImeReview(review, context).status, 'PASS');
  for (const change of [{complete: false}, {actualNative: false}, {synthetic: true}, {collectorGenerated: true}, {reviewerId: '  OPERATOR-A  '}, {evidence: []}, {nonce: 'b'.repeat(32)}, {raw: {...review.raw, sha256: h('other')}}, {reviewedAt: new Date(999).toISOString()}, {reviewedAt: new Date(2001).toISOString()}]) assert.equal(inspectNativeImeReview({...review, ...change}, context).status, 'INCONCLUSIVE');
  assert.equal(inspectNativeImeReview(review, {...context, receivedAt: 121001}).status, 'INCONCLUSIVE');
  assert.equal(inspectNativeImeReview(review, context).physicalPresentation, false);
});
test('ordinary external authority reads retain exact bytes and refuse empty/oversized/symlink input', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'native-ime-authority-'))); t.after(() => rm(root, {recursive: true, force: true}));
  const path = join(root, 'original.record'); await writeFile(path, 'original');
  assert.equal((await readNativeImeFile(path, 8)).toString(), 'original');
  await assert.rejects(readNativeImeFile(path, 7), /bound/);
  await assert.rejects(readNativeImeFile(path, Infinity), /bound/);
  await assert.rejects(readNativeImeFile(path, 8 * 1024 * 1024 + 1), /bound/);
  const empty = join(root, 'empty'); await writeFile(empty, ''); await assert.rejects(readNativeImeFile(empty, 8), /nonempty/);
  const link = join(root, 'link'); await symlink(path, link); await assert.rejects(readNativeImeFile(link, 8), /ordinary path/);
  await assert.rejects(readNativeImeFile('relative', 8), /absolute/);
});
test('only finite new authority evidence paths enter retained inventory', () => {
  assert.equal(isNativeImeEvidencePath('group/native-ime-' + 'a'.repeat(32) + '/review-evidence-3.record'), true);
  for (const path of ['native-ime-a/review-evidence-0.record', 'native-ime-' + 'a'.repeat(32) + '/review-evidence-4.record', 'native-ime-' + 'a'.repeat(32) + '/arbitrary.bin']) assert.equal(isNativeImeEvidencePath(path), false);
});
test('missing bytes or a serialized proof never qualify native IME', async () => {
  assert.equal(evaluateNativeImeProof({nativeCompatibility: true}, {qualification: true}).outcome, 'INCONCLUSIVE');
  assert.equal(await verifyNativeImeEvidence({attempt: {result: {observations: {nativeIme: {qualification: true}}}}, cell: {operation: 'text.native-ime'}}), null);
});
