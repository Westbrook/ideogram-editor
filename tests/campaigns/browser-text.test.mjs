import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
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

const recoveryScenarios = ['missing-font', 'corrupt-font', 'restricted-font', 'mismatched-font-hash', 'missing-glyph', 'cancelled-over-limit-composition'];
async function recoveryFixture(t, scenario) {
  // This isolates driver sequencing from font parsing and product rendering.
  // Synthetic files satisfy the driver's exact input seals, not qualification.
  const repo = await mkdtemp(join(tmpdir(), 'ideogram-text-recovery-driver-'));
  t.after(() => rm(repo, {recursive: true, force: true}));
  const data = fixture(), recovery = {scenario};
  await mkdir(join(repo, 'src', 'text'), {recursive: true});
  await writeFile(join(repo, 'src', 'text', 'profile.json'), JSON.stringify({fonts: data.text.fonts.map(font => ({id: font.id, sha256: font.sha256.slice(7), bytes: font.bytes}))}));
  if (['missing-font', 'corrupt-font', 'mismatched-font-hash'].includes(scenario)) recovery.assetId = 'font_recovery';
  if (scenario === 'mismatched-font-hash') {
    const alternate = Buffer.from('synthetic alternate font bytes');
    recovery.replacementPath = join(repo, 'alternate.bin'); recovery.replacementHash = hash(alternate);
    await writeFile(recovery.replacementPath, alternate);
  }
  if (scenario === 'restricted-font') {
    const font = Buffer.from('synthetic restricted font bytes'), license = Buffer.from('synthetic license record');
    recovery.path = join(repo, 'restricted.bin'); recovery.sha256 = hash(font);
    recovery.licensePath = join(repo, 'license.txt'); recovery.licenseSha256 = hash(license);
    await writeFile(recovery.path, font); await writeFile(recovery.licensePath, license);
  }
  if (scenario === 'missing-glyph') {recovery.text = '\u0378'; recovery.textHash = hash(recovery.text);}
  data.text.recoveryCases = {[scenario]: recovery};
  data.text.recovery = {scenario: 'unselected-decoy', assetId: 'never_selected'};
  return {repo, data, recovery, cell: {id: 'recovery-' + scenario, operation: 'text.recovery', workload: 'WXn', parameters: {scenario}}};
}

function recoveryPage(scenario, {enabledAdmission = false, suppressAlert = false} = {}) {
  // Only documented Page/Locator calls are implemented. The driver supplies
  // event callbacks and route handlers; the fake does not inspect their source.
  const trace = [], state = {node: {value: ''}, open: false, composing: false, cancelPending: false, selectedFont: null, fonts: [], permission: false, alert: '', route: null, fulfilled: [], uploads: new Map(), previewClicks: 0, observedOutcome: undefined};
  const visible = options => {assert.deepEqual(options, {state: 'visible'});};
  const match = (pattern, text) => typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text);
  const native = {
    async waitFor(options) {visible(options); assert(state.open);},
    async fill(value) {assert(state.open); state.node.value = value; state.alert = ''; trace.push('input:fill');},
    async inputValue() {return state.node.value;},
    async focus() {assert(state.open); trace.push('input:focus');},
    async evaluate(callback, argument) {const result = callback(state.node, argument); trace.push('input:evaluate'); return result;},
    async dispatchEvent(type, init) {
      assert(state.open); trace.push('event:' + type + (type === 'input' ? ':' + init.isComposing : ''));
      if (type === 'compositionstart') {assert(!state.composing); state.composing = true;}
      else if (type === 'compositionend') {assert(state.composing); state.composing = false; if (state.cancelPending) state.open = false;}
      else {assert.equal(type, 'input'); assert.equal(init.inputType, 'insertCompositionText'); assert.equal(init.isComposing, state.composing);}
    },
  };
  const editor = {
    async isVisible() {return state.open;},
    async waitFor(options) {assert.deepEqual(options, {state: 'hidden'}); assert(!state.open); trace.push('editor:hidden');},
  };
  const button = name => ({
    async waitFor(options) {assert.equal(name, 'Preview text'); visible(options); assert(state.open);},
    async isDisabled() {
      assert(['Preview text', 'Apply text'].includes(name)); trace.push('disabled:' + name);
      return !enabledAdmission && Buffer.byteLength(state.node.value) > 16384;
    },
    async click() {
      trace.push('click:' + name);
      if (name === 'Text') {assert(!state.open); state.open = true; return;}
      assert(state.open);
      if (name === 'Use selected font' || name === 'Add explicit fallback') {assert(state.selectedFont); state.fonts.push(state.selectedFont); return;}
      if (name === 'Local font import and exact relink') return;
      if (name === 'Import as substitution draft') {
        assert.equal(scenario, 'restricted-font'); assert.equal(state.uploads.size, 2); assert(state.permission);
        if (!suppressAlert) state.alert = 'FONT_EMBEDDING_RESTRICTED'; return;
      }
      if (name === 'Preview text') {
        state.previewClicks++;
        assert(Buffer.byteLength(state.node.value) <= 16384, 'disabled Preview must never be clicked');
        if (state.route) await state.route.handler({async fulfill(response) {state.fulfilled.push(response); trace.push('route:fulfill');}});
        if (!suppressAlert) state.alert = scenario === 'missing-font' ? 'Missing exact font bytes' : scenario === 'missing-glyph' ? 'Missing glyphs' : 'FONT_HASH';
        return;
      }
      assert.equal(name, 'Cancel text edit');
      if (state.composing) {state.cancelPending = true; trace.push('cancel:deferred');} else state.open = false;
    },
  });
  const page = {
    locator(selector) {
      if (selector === '#native-text-content') return native;
      if (selector === '#native-text-editor') return editor;
      if (selector === '#native-text-error') return {filter({hasText}) {return {last() {return {async waitFor(options) {visible(options); assert(state.open && match(hasText, state.alert), 'expected action error must actually be visible'); trace.push('alert:visible');}};}};}};
      if (selector === '#native-text-admission') return {filter({hasText}) {return {async waitFor(options) {visible(options); assert(state.open && !state.composing); assert(match(hasText, 'UTF-8 text uses ' + Buffer.byteLength(state.node.value) + ' bytes; one layer permits 16384 bytes. Review a split, shorten manually, or cancel.')); trace.push('admission:visible');}};}};
      assert(['en-file-upload[label="Font file"] input', 'en-file-upload[label="Font license record"] input'].includes(selector));
      return {async setInputFiles(file) {assert(Buffer.isBuffer(file.buffer)); state.uploads.set(selector, file); trace.push('upload:' + file.name);}};
    },
    getByRole(role, options) {
      assert.equal(options.exact, true);
      if (role === 'button') return button(options.name);
      if (role === 'combobox') {assert.equal(options.name, 'Font choice'); return {async selectOption(value) {state.selectedFont = value; trace.push('font:select');}};}
      assert.equal(role, 'switch'); assert.equal(options.name, 'I have permission to embed this font');
      return {async check() {state.permission = true; trace.push('font:permission');}};
    },
    getByText(pattern) {
      assert(pattern.test('Exact font order:'));
      return {filter({hasText}) {return {async waitFor(options) {visible(options); assert(state.fonts.includes(hasText)); trace.push('font:registered');}};}};
    },
    async route(pattern, handler) {assert.equal(state.route, null); state.route = {pattern, handler}; trace.push('route:install');},
    async unroute(pattern, handler) {assert.equal(state.route?.pattern, pattern); assert.equal(state.route?.handler, handler); state.route = null; trace.push('route:remove');},
  };
  let observing = false, refusals = 0;
  const recoveryFonts = {
    async observe(action) {
      assert(!observing); observing = true; trace.push('observe:start');
      try {state.observedOutcome = await action(); return state.observedOutcome;}
      finally {assert.equal(state.route, null, 'fault route must be removed before accepted endpoint observation'); observing = false; trace.push('observe:exit');}
    },
    async refusal(action) {
      assert(observing); assert.equal(++refusals, 1); assert(state.open); trace.push('refusal:start');
      try {return await action();} finally {trace.push('refusal:exit');}
    },
  };
  return {page, recoveryFonts, trace, state};
}

for (const scenario of recoveryScenarios) test('original recovery driver is observed once through ' + scenario, async t => {
  const f = await recoveryFixture(t, scenario), h = recoveryPage(scenario);
  const result = await runTextBrowserCell({page: h.page, cell: f.cell, fixture: f.data, repo: f.repo, services: {recoveryFonts: h.recoveryFonts}});
  assert.equal(result.status, 'PASS'); assert.deepEqual(result.missing, []);
  assert.equal(result.observations.actions.length, 1); assert.equal(result.observations.actions[0].id, 'text-recovery');
  assert.equal(result.observations.actions[0].outcome, 'completed'); assert.equal(result.phases.length, 1);
  assert.equal(h.trace[0], 'observe:start'); assert.equal(h.trace.at(-1), 'observe:exit');
  assert.equal(h.trace.filter(event => event === 'refusal:start').length, 1); assert.equal(h.trace.filter(event => event === 'refusal:exit').length, 1);
  assert(h.trace.indexOf('click:Text') < h.trace.indexOf('refusal:start'));
  assert(h.trace.lastIndexOf('font:registered') < h.trace.indexOf('refusal:start'));
  assert.deepEqual(h.state.fonts, f.data.text.fonts.map(font => font.id));
  const cancelled = scenario === 'cancelled-over-limit-composition', draft = cancelled ? 'x'.repeat(16385) : scenario === 'missing-glyph' ? f.recovery.text : f.data.text.corpus.text;
  assert.deepEqual(h.state.observedOutcome, {scenario, draftHash: hash(draft), retained: true, rejectedFontHash: f.recovery.sha256 ?? null, cancelDeferredUntilNativeEnd: cancelled, missing: 0});
  assert.equal(h.state.node.value, draft);
  assert(!JSON.stringify(result).includes(f.data.text.corpus.text));
  if (['missing-font', 'corrupt-font', 'mismatched-font-hash'].includes(scenario)) {
    assert(h.trace.indexOf('route:install') < h.trace.indexOf('refusal:start'));
    assert(h.trace.indexOf('refusal:exit') < h.trace.indexOf('route:remove'));
    assert.equal(h.state.fulfilled.length, 1);
    const response = h.state.fulfilled[0]; assert.equal(response.status, scenario === 'missing-font' ? 404 : 200);
    if (scenario === 'missing-font') assert.equal(response.body, '');
    else if (scenario === 'corrupt-font') assert.deepEqual(response.body, Buffer.from([0, 1, 2, 3]));
    else assert.equal(hash(response.body), f.recovery.replacementHash);
  }
  if (scenario === 'restricted-font') {
    assert.equal(hash(h.state.uploads.get('en-file-upload[label="Font file"] input').buffer), f.recovery.sha256);
    assert.equal(hash(h.state.uploads.get('en-file-upload[label="Font license record"] input').buffer), f.recovery.licenseSha256);
    assert(h.trace.indexOf('refusal:start') < h.trace.indexOf('click:Import as substitution draft'));
  }
  if (cancelled) {
    assert.equal(h.state.previewClicks, 0);
    assert.deepEqual(h.trace.slice(h.trace.indexOf('refusal:start'), h.trace.indexOf('refusal:exit') + 1), ['refusal:start', 'admission:visible', 'disabled:Preview text', 'disabled:Apply text', 'refusal:exit']);
    assert.deepEqual(h.trace.slice(h.trace.indexOf('refusal:exit') + 1), ['event:compositionstart', 'click:Cancel text edit', 'cancel:deferred', 'event:compositionend', 'editor:hidden', 'observe:exit']);
    assert.equal(h.state.open, false); assert.equal(h.state.composing, false); assert.equal(result.observations.recovery.cancelDeferredUntilNativeEnd, true);
  } else {
    assert(h.trace.indexOf('refusal:start') < h.trace.indexOf('alert:visible'));
    assert(h.trace.indexOf('alert:visible') < h.trace.indexOf('refusal:exit')); assert.equal(h.state.open, true);
  }
});

test('incorrectly enabled over-limit controls fail without Preview or completed cancellation', async t => {
  const f = await recoveryFixture(t, 'cancelled-over-limit-composition'), h = recoveryPage(f.recovery.scenario, {enabledAdmission: true});
  const result = await runTextBrowserCell({page: h.page, cell: f.cell, fixture: f.data, repo: f.repo, services: {recoveryFonts: h.recoveryFonts}});
  assert.equal(result.status, 'FAIL'); assert.equal(result.error.code, 'RECOVERY_ADMISSION_NOT_DISABLED');
  assert.equal(result.observations.actions[0].outcome, 'failed'); assert.equal(result.observations.recovery, undefined);
  assert.equal(h.state.previewClicks, 0); assert(!h.trace.includes('click:Cancel text edit'));
  assert.equal(h.trace.at(-1), 'observe:exit'); assert.equal(h.state.observedOutcome, undefined);
});

test('failed font recovery still removes its injected route before observer endpoint', async t => {
  const f = await recoveryFixture(t, 'missing-font'), h = recoveryPage(f.recovery.scenario, {suppressAlert: true});
  const result = await runTextBrowserCell({page: h.page, cell: f.cell, fixture: f.data, repo: f.repo, services: {recoveryFonts: h.recoveryFonts}});
  assert.equal(result.status, 'FAIL'); assert.equal(result.observations.actions[0].outcome, 'failed');
  assert.equal(result.observations.recovery, undefined); assert.equal(h.state.route, null);
  assert.deepEqual(h.trace.slice(-3), ['refusal:exit', 'route:remove', 'observe:exit']); assert.equal(h.state.observedOutcome, undefined);
});

test('mismatched recovery selection yields no UI action or recovery outcome inside the observer', async t => {
  const f = await recoveryFixture(t, 'missing-font'), h = recoveryPage('missing-font');
  delete f.data.text.recoveryCases;
  const result = await runTextBrowserCell({page: h.page, cell: f.cell, fixture: f.data, repo: f.repo, services: {recoveryFonts: h.recoveryFonts}});
  assert.equal(result.status, 'INCONCLUSIVE'); assert(result.missing.includes('sealed recovery fixture matching the exact selected scenario'));
  assert.deepEqual(result.observations.actions, []); assert.deepEqual(result.phases, []); assert.equal(h.state.observedOutcome, null);
  assert.deepEqual(h.trace, ['observe:start', 'observe:exit']);
});
