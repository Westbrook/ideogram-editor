import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildTextInteractionPlan, inspectTextFixture, summarizeNativeWitness, supportedTextOperations, TEXT_INTERACTION_COUNTS, runTextBrowserCell } from '../../tooling/qualification/campaigns/browser-text.mjs';
const hash = x => 'sha256:' + createHash('sha256').update(x).digest('hex');
const fixture = () => ({ workload: 'WXn', text: { schema: 'browser-text-fixture-1', manifestHash: hash('manifest'), corpus: { text: 'private sealed corpus', sha256: hash('private sealed corpus'), fragments: Array.from({ length: 20 }, (_, i) => 'fragment ' + i), fragmentsHash: hash(JSON.stringify(Array.from({ length: 20 }, (_, i) => 'fragment ' + i))), scripts: ['latin-combining', 'arabic-rtl', 'devanagari', 'cjk', 'emoji', 'newlines', 'unbroken'] }, fonts: Array.from({ length: 4 }, (_, i) => ({ kind: 'bundled', id: 'font-' + i, sha256: hash('font-' + i), bytes: 1024 })), semanticItemIds: ['one', 'two'] } });
test('IText has exactly the specified 106 retained intents and composition allocations', () => {
  const plan = buildTextInteractionPlan(); assert.equal(plan.length, 106);
  for (const [kind, count] of Object.entries(TEXT_INTERACTION_COUNTS)) assert.equal(plan.filter(a => a.kind === kind).length, count, kind);
  assert.equal(new Set(plan.map(a => a.id)).size, 106); assert.equal(plan.filter(a => a.kind === 'composition-end' && a.mode === 'commit').length, 8); assert.equal(plan.filter(a => a.kind === 'composition-end' && a.mode === 'cancel').length, 2);
  const presentations = plan.filter(a => a.kind === 'presentation'); assert.deepEqual(presentations.map(a => a.mode), ['immediate', 'immediate', 'immediate', 'deferred', 'deferred-latest', 'deferred-cancelled']);
  assert.deepEqual(presentations.slice(0, 3).map(a => a.range), ['forward', 'backward', 'none']);
  assert.equal(plan.at(-1).cancelSession, true); assert(plan.at(-1).scheduledMs < 59400);
  assert(plan.every((a, i) => a.scheduledMs >= 0 && (i === 0 || a.scheduledMs > plan[i - 1].scheduledMs)));
});
test('corpus identity and exact workload font limits are prerequisites', () => {
  const f = fixture(); assert.deepEqual(inspectTextFixture(f, 'text.interaction', 'WXn'), []);
  f.text.corpus.text += 'tampering'; assert(inspectTextFixture(f, 'text.interaction', 'WXn').some(x => x.includes('UTF-8')));
  f.text.corpus.sha256 = hash(f.text.corpus.text); f.text.fonts[0].bytes = 17 * 1024 * 1024; assert(inspectTextFixture(f, 'text.font-set', 'WXn').some(x => x.includes('16 MiB')));
  f.text.fonts[0].bytes = 1024; assert(inspectTextFixture(f, 'text.font-set', 'WXs').some(x => x.includes('16-face')));
});
test('missing corpus/fonts never runs UI or claims an operation passed', async () => {
  let touched = false; const page = new Proxy({}, { get() { touched = true; throw Error('must not touch page'); } });
  const result = await runTextBrowserCell({ page, cell: { operation: 'text.active-layout', workload: 'WXn' }, fixture: {} });
  assert.equal(result.status, 'INCONCLUSIVE'); assert.equal(touched, false); assert.equal(result.observations.actions.length, 0); assert(result.missing.length);
});
test('native IME cannot be supplied by synthetic or incomplete witness', async () => {
  assert.equal(summarizeNativeWitness(null, 'WXn').valid, false);
  const valid = { schema: 'native-ime-witness-1', inputMethod: 'japanese', synthetic: false, durationMs: 60000, commits: 8, cancels: 2, presentationRequests: 6, trustedCompositionEvents: 30, osBuildHash: hash('os'), settingsHash: hash('settings'), eventTraceHash: hash('events'), corpusHash: hash('corpus'), operatorMethodHash: hash('operator') };
  assert.equal(summarizeNativeWitness(valid, 'WXn').valid, true); assert.equal(summarizeNativeWitness({ ...valid, synthetic: true }, 'WXn').valid, false); assert.equal(summarizeNativeWitness(valid, 'WXs').valid, false);
  const result = await runTextBrowserCell({ page: null, cell: { operation: 'text.native-ime', workload: 'WXn' }, fixture: { text: { nativeWitness: { ...valid, privateContent: 'secret text' } } } });
  assert.equal(result.status, 'INCONCLUSIVE'); assert.equal(result.observations.nativeWitness.externalWitness, true); assert(!JSON.stringify(result).includes('secret text'));
});
test('all advertised text operations are exact and receipts omit supplied private text', async () => {
  assert.equal(supportedTextOperations.length, 7); assert(supportedTextOperations.includes('text.recovery'));
  const f = fixture(); f.text.corpus.sha256 = hash('wrong');
  const result = await runTextBrowserCell({ page: null, cell: 'text.interaction', fixture: f });
  const serialized = JSON.stringify(result); assert(!serialized.includes(f.text.corpus.text)); assert(!serialized.includes('fragment 0'));
});
test('duplicate faces, missing script declarations and malformed text cannot qualify', () => {
  const f = fixture(); f.text.fonts[1].sha256 = f.text.fonts[0].sha256; f.text.corpus.scripts = ['latin-combining'];
  f.text.corpus.text = '\ud800'; f.text.corpus.sha256 = hash(f.text.corpus.text);
  const missing = inspectTextFixture(f, 'text.interaction', 'WXn'); assert(missing.some(x => x.includes('distinct'))); assert(missing.some(x => x.includes('mixed-script'))); assert(missing.some(x => x.includes('Unicode')));
});
test('native witness rejects undefined, NaN, strings and noninteger event counts without echoing fields', async () => {
  const base = { schema: 'native-ime-witness-1', inputMethod: 'japanese', synthetic: false, durationMs: 60000, commits: 8, cancels: 2, presentationRequests: 6, trustedCompositionEvents: 30, osBuildHash: hash('os'), settingsHash: hash('settings'), eventTraceHash: hash('events'), corpusHash: hash('corpus'), operatorMethodHash: hash('operator') };
  for (const patch of [{ durationMs: undefined }, { durationMs: NaN }, { durationMs: Infinity }, { durationMs: 'private text' }, { trustedCompositionEvents: undefined }, { trustedCompositionEvents: NaN }, { trustedCompositionEvents: 30.1 }, { eventTraceHash: 'private trace' }, { inputMethod: 'private source' }]) {
    const result = summarizeNativeWitness({ ...base, ...patch }, 'WXn'); assert.equal(result.valid, false); assert.equal(result.observation, null); assert(!JSON.stringify(result).includes('private'));
  }
});
test('recovery selects the exact cell scenario and cannot relabel one fixture six ways', async () => {
  const { selectedRecovery } = await import('../../tooling/qualification/campaigns/browser-text.mjs');
  const text = { recovery: { scenario: 'missing-font', assetId: 'font_1' } };
  assert.equal(selectedRecovery(text, { parameters: { scenario: 'missing-font' } }).missing.length, 0);
  for (const scenario of ['corrupt-font', 'restricted-font', 'mismatched-font-hash', 'missing-glyph', 'cancelled-over-limit-composition', 'invented', undefined]) assert(selectedRecovery(text, { parameters: { scenario } }).missing.length);
  assert.equal(selectedRecovery({ recoveryCases: { 'missing-font': text.recovery } }, { parameters: { scenario: 'missing-font' } }).recovery.assetId, 'font_1');
});
