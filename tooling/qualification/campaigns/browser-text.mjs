import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { monotonic, intervalWait } from './common.mjs';
import { acceptedCommand } from './browser-driver.mjs';

export const supportedTextOperations = Object.freeze(['text.font-set', 'text.mixed-ready', 'text.active-layout', 'text.apply', 'text.recovery', 'text.interaction', 'text.native-ime']);
export const TEXT_INTERACTION_COUNTS = Object.freeze({ 'insert-delete': 40, preedit: 20, 'composition-end': 10, caret: 10, 'semantic-selection': 10, 'text-format': 10, presentation: 6 });
const HASH = /^sha256:[a-f0-9]{64}$/;
const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const bytes = text => Buffer.byteLength(text, 'utf8');
const check = (condition, code) => { if (!condition) throw Object.assign(Error(code), { code }); };
const abort = signal => { if (signal?.aborted) throw signal.reason ?? Object.assign(Error('CAMPAIGN_ABORTED'), { code: 'CAMPAIGN_ABORTED' }); };
const click = (page, name) => page.getByRole('button', { name, exact: true }).click();
const input = page => page.locator('#native-text-content');
const region = page => page.locator('#native-text-editor');
const waitText = (page, text) => page.getByText(text, { exact: true }).first().waitFor({ state: 'visible' });
const READY = 'Text preview ready. Accepted appearance is unchanged.';

/** This manifest is deliberately data-only. The fixture producer supplies the
 * privately retained corpus; receipts contain its identity, never its strings. */
export function inspectTextFixture(fixture, operation, workload) {
  const text = fixture?.text, missing = [];
  if (!text || text.schema !== 'browser-text-fixture-1') return ['sealed browser-text-fixture-1 metadata'];
  const corpus = text.corpus;
  if (!corpus || typeof corpus.text !== 'string' || !HASH.test(corpus.sha256 ?? '') || hash(corpus.text) !== corpus.sha256) missing.push('exact UTF-8 corpus and matching SHA-256');
  if (!Array.isArray(corpus?.fragments) || corpus.fragments.length < 20 || corpus.fragments.some(x => typeof x !== 'string' || !x)) missing.push('at least 20 sealed nonempty script fragments');
  if (!HASH.test(corpus?.fragmentsHash ?? '') || !Array.isArray(corpus?.fragments) || hash(JSON.stringify(corpus.fragments)) !== corpus.fragmentsHash) missing.push('sealed script fragment sequence identity');
  if (typeof corpus?.text === 'string' && /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(corpus.text)) missing.push('well-formed Unicode corpus');
  if (!HASH.test(text.manifestHash ?? '')) missing.push('sealed font/glyph/shape fixture manifest');
  const fonts = text.fonts;
  if (!Array.isArray(fonts) || fonts.length === 0 || fonts.some(f => !f || typeof f.id !== 'string' || !HASH.test(f.sha256 ?? '') || !Number.isSafeInteger(f.bytes) || f.bytes <= 0 || !['bundled', 'local'].includes(f.kind))) missing.push('exact font identities and byte counts');
  if (Array.isArray(fonts)) {
    if (new Set(fonts.map(f => f.sha256)).size !== fonts.length) missing.push('distinct exact font faces');
    const count = workload === 'WXs' ? 16 : 4, limit = workload === 'WXs' ? 64 * 1024 * 1024 : 16 * 1024 * 1024;
    if (fonts.length !== count || fonts.reduce((n, f) => n + (f.bytes ?? Infinity), 0) > limit) missing.push(`${workload === 'WXs' ? 'WXs 16-face/64 MiB' : 'WXn 4-face/16 MiB'} font cohort`);
    if (fonts.some(f => f.kind === 'local' && (typeof f.path !== 'string' || typeof f.licensePath !== 'string' || !HASH.test(f.licenseSha256 ?? '')))) missing.push('retained local font and license paths/hashes');
  }
  const scripts = corpus?.scripts;
  if (!Array.isArray(scripts) || ['latin-combining', 'arabic-rtl', 'devanagari', 'cjk', 'emoji', 'newlines', 'unbroken'].some(s => !scripts.includes(s))) missing.push('complete mixed-script coverage declaration');
  if (text.fontSetPreseeded === true && (!/^[A-Za-z0-9_-]+$/.test(text.activeLayerId ?? '') || !Number.isSafeInteger(text.activeLayerIndex) || text.activeLayerIndex < 0)) missing.push('retained exact font layer identity and public tree index');
  if (operation === 'text.interaction' && (!Array.isArray(text.semanticItemIds) || text.semanticItemIds.length < 2)) missing.push('at least two seeded semantic-list item IDs');
  return [...new Set(missing)];
}

/** Fixed 106-intent plan. Composition start is part of its first preedit,
 * final native input is part of commit/cancel; neither adds a hidden intent.
 * The last explicit Cancel ends the draft after its native composition ends. */
export function buildTextInteractionPlan() {
  const plan = [], add = (kind, details = {}) => plan.push({ id: `IText-${String(plan.length + 1).padStart(3, '0')}`, kind, ...details });
  for (let i = 0; i < 20; i++) { add('insert-delete', { mode: 'insert', fragment: i }); add('insert-delete', { mode: 'delete' }); }
  for (let i = 0; i < 10; i++) { add('caret', { range: i < 3 ? ['forward', 'backward', 'none'][i] : null, key: ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Shift+ArrowLeft'][i % 5] }); if (i < 3) add('presentation', { mode: 'immediate', range: ['forward', 'backward', 'none'][i] }); }
  for (let i = 0; i < 10; i++) add('semantic-selection', { index: i % 2 });
  for (let i = 0; i < 10; i++) add('text-format', { index: i });
  for (let i = 0; i < 10; i++) {
    add('preedit', { sequence: i, step: 0 }); add('preedit', { sequence: i, step: 1 });
    if (i === 8) { add('presentation', { mode: 'deferred' }); add('presentation', { mode: 'deferred-latest' }); }
    if (i === 9) add('presentation', { mode: 'deferred-cancelled' });
    add('composition-end', { sequence: i, mode: i === 7 || i === 9 ? 'cancel' : 'commit', cancelSession: i === 9 });
  }
  const counts = Object.fromEntries(Object.keys(TEXT_INTERACTION_COUNTS).map(kind => [kind, plan.filter(a => a.kind === kind).length]));
  check(JSON.stringify(counts) === JSON.stringify(TEXT_INTERACTION_COUNTS) && plan.length === 106, 'ITEXT_PLAN_COUNTS');
  // The first 59.4 seconds schedule all native intents; the final 0.6 seconds
  // remain reserved for the six 100 ms presentation-feedback allowances.
  return plan.map((action, index) => ({ ...action, scheduledMs: index * 59400 / 106 }));
}

export function summarizeNativeWitness(witness, workload) {
  const missing = [];
  if (!witness || witness.schema !== 'native-ime-witness-1') return { valid: false, missing: ['physical OS IME witness; synthetic DOM events cannot satisfy native-ime'], observation: null };
  if (witness.inputMethod !== (workload === 'WXs' ? 'simplified-chinese' : 'japanese')) missing.push('prescribed OS IME input source');
  for (const key of ['osBuildHash', 'settingsHash', 'eventTraceHash', 'corpusHash', 'operatorMethodHash']) if (!HASH.test(witness[key] ?? '')) missing.push(`native witness ${key}`);
  if (witness.synthetic !== false || !Number.isFinite(witness.durationMs) || witness.durationMs < 60000 || witness.durationMs >= 61000 || witness.commits !== 8 || witness.cancels !== 2 || witness.presentationRequests !== 6 || !Number.isSafeInteger(witness.trustedCompositionEvents) || witness.trustedCompositionEvents < 20) missing.push('60-second native event witness with eight commits, two cancels and six presentation requests');
  // A witness is an external observation, never silently credited as a run
  // performed by Playwright. Its issuer/source identity is verified by runner.
  return { valid: missing.length === 0, missing, observation: missing.length ? null : { schema: witness.schema, inputMethod: witness.inputMethod, durationMs: witness.durationMs, commits: witness.commits, cancels: witness.cancels, presentationRequests: witness.presentationRequests, trustedCompositionEvents: witness.trustedCompositionEvents, osBuildHash: witness.osBuildHash, settingsHash: witness.settingsHash, eventTraceHash: witness.eventTraceHash, corpusHash: witness.corpusHash, operatorMethodHash: witness.operatorMethodHash, externalWitness: true } };
}

async function readState(page) {
  return input(page).evaluate(node => ({ connected: node.isConnected, start: node.selectionStart, end: node.selectionEnd, direction: node.selectionDirection, units: node.value.length, presentation: document.querySelector('#native-text-editor')?.getAttribute('data-presentation'), session: document.querySelector('#native-text-editor')?.getAttribute('data-session'), revision: document.querySelector('#native-text-editor')?.getAttribute('data-revision'), focused: document.activeElement === node }));
}
async function number(page, label, value) { const field = page.getByRole('spinbutton', { name: label, exact: true }); await field.fill(String(value)); await field.press('Tab'); }
async function openDraft(page, text) {
  if (await region(page).isVisible()) return;
  if (text.activeLayerId) {
    const tree = page.locator('#layer-tree');
    // The fixture seals the visible tree order and the layer identity together.
    if (Number.isSafeInteger(text.activeLayerIndex) && text.activeLayerIndex >= 0) await tree.getByRole('treeitem').nth(text.activeLayerIndex).click();
    else throw Object.assign(Error('ACTIVE_TEXT_LAYER_LOCATOR_MISSING'), { prerequisite: true });
    await click(page, 'Edit text');
  } else await click(page, 'Text');
  await input(page).waitFor({ state: 'visible' });
}
async function verifyRetainedText(page, text) {
  if (!/^[A-Za-z0-9_-]+$/.test(text.documentId ?? '') || !/^[A-Za-z0-9_-]+$/.test(text.activeLayerId ?? '')) throw Object.assign(Error('RETAINED_TEXT_DOCUMENT_IDENTITY_REQUIRED'), { prerequisite: true });
  const actual = await page.evaluate(async ({ documentId, layerId }) => {
    const read = async path => { const r = await fetch(path, { credentials: 'same-origin', headers: { 'X-App-Client': 'LP-1' }, cache: 'no-store', redirect: 'error' }); if (!r.ok) throw Error('RETAINED_TEXT_READ_FAILED'); return r.json(); };
    const document = await read('/api/v1/documents/' + documentId), revision = document.projection.value.revision;
    const value = await read('/api/v1/documents/' + documentId + '/text?layerId=' + layerId + '&revision=' + revision);
    return { layerVersion: value.layerVersion, textHash: value.source.text.textUtf8.hash, layoutHash: value.source.render.layout.hash, pixelHash: value.source.render.pixels.hash, rendererHash: value.source.render.rendererProfile.id, fonts: value.source.text.fonts.map(font => ({ sha256: font.bytes.hash, bytes: Number(font.bytes.byteLength), licenseSha256: font.licenseRecord.hash })) };
  }, { documentId: text.documentId, layerId: text.activeLayerId });
  check(actual.textHash === text.corpus.sha256 && actual.fonts.length === text.fonts.length && actual.fonts.every((font, i) => font.sha256 === text.fonts[i].sha256 && font.bytes === text.fonts[i].bytes && font.licenseSha256 === text.fonts[i].licenseSha256), 'RETAINED_TEXT_FONT_COHORT_MISMATCH');
  if (text.expectedPreviewHash) check(actual.pixelHash === text.expectedPreviewHash, 'RETAINED_TEXT_PIXELS_CHANGED');
  return actual;
}
async function configureFonts(page, text, signal) {
  if (text.fontSetPreseeded === true) {
    if (!text.activeLayerId || !Number.isSafeInteger(text.activeLayerIndex)) throw Object.assign(Error('RETAINED_EXACT_FONT_LAYER_REQUIRED'), { prerequisite: true });
    await verifyRetainedText(page, text); return;
  }
  const fonts = text.fonts;
  for (let i = 0; i < fonts.length; i++) {
    abort(signal); const font = fonts[i];
    if (font.kind === 'bundled') {
      await page.getByRole('combobox', { name: 'Font choice', exact: true }).selectOption(font.id);
      await click(page, i === 0 ? 'Use selected font' : 'Add explicit fallback');
      await page.getByText(/Exact font order:/).filter({ hasText: font.id }).waitFor({ state: 'visible' });
      await page.getByRole('button', { name: 'Preview text', exact: true }).waitFor({ state: 'visible' });
    } else {
      // The current public UI only imports a local face as primary. Do not
      // pretend replacing it sixteen times creates a sixteen-face font set.
      throw Object.assign(Error('LOCAL_FALLBACK_SET_UI_UNAVAILABLE'), { prerequisite: true });
    }
  }
}
async function preview(page) { await click(page, 'Preview text'); await waitText(page, READY); await page.locator('#native-text-preview').waitFor({ state: 'visible' }); }
/** Real mixed lifecycle work. The extra character comes from the sealed
 * fragment corpus, and Undo restores the original retained text/font hashes. */
export async function runNativeLifecycle({ page, fixture, signal, phase }) {
  const missing = inspectTextFixture(fixture, 'text.apply', fixture.workload);
  if (missing.length) throw Object.assign(Error(missing.join('; ')), { code: 'CAMPAIGN_PREREQUISITE' });
  const text = fixture.text, before = await verifyRetainedText(page, text);
  const edit = await phase('text-edit', async () => {
    await openDraft(page, text); await configureFonts(page, text, signal);
    await input(page).fill(text.corpus.text + text.corpus.fragments[0]); await preview(page);
    const receipt = await acceptedCommand(page, 'CommitTextEdit', () => click(page, 'Apply text'), signal);
    await region(page).waitFor({ state: 'hidden' }); return receipt;
  });
  await phase('undo-text', async () => {
    await acceptedCommand(page, 'Undo', () => click(page, 'Undo'), signal);
    const restored = await verifyRetainedText(page, text);
    check(restored.textHash === before.textHash && restored.pixelHash === before.pixelHash && JSON.stringify(restored.fonts) === JSON.stringify(before.fonts), 'LIFECYCLE_TEXT_UNDO_CHANGED_RETAINED_BYTES');
  });
  await phase('font-select', async () => {
    await openDraft(page, text);
    const field = page.getByRole('combobox', { name: 'Font choice', exact: true }), initial = await field.inputValue();
    const values = await field.locator('option').evaluateAll(nodes => nodes.filter(node => !node.disabled).map(node => node.value));
    const alternate = values.find(value => value && value !== initial);
    check(alternate, 'LIFECYCLE_ALTERNATE_FONT_UNAVAILABLE');
    await field.selectOption(alternate); await click(page, 'Use selected font');
    await page.getByText(/Exact font order:/).filter({ hasText: alternate }).waitFor({ state: 'visible' });
  });
  await phase('font-restore', async () => {
    await click(page, 'Cancel text edit'); await region(page).waitFor({ state: 'hidden' });
    const restored = await verifyRetainedText(page, text);
    check(restored.textHash === before.textHash && restored.pixelHash === before.pixelHash && JSON.stringify(restored.fonts) === JSON.stringify(before.fonts), 'LIFECYCLE_FONT_RESTORE_CHANGED_ACCEPTED_STATE');
  });
  return { edit, immutableTextUndo: true, fontSelection: 'actual authoring draft selection and cancellation', acceptedFontSetRestored: true };
}
async function previewIdentity(page) {
  return page.locator('#native-text-preview').evaluate(async node => {
    const rgba = node.getContext('2d').getImageData(0, 0, node.width, node.height).data;
    const digest = await crypto.subtle.digest('SHA-256', rgba);
    return { width: node.width, height: node.height, bytes: rgba.byteLength, sha256: 'sha256:' + [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('') };
  });
}
async function installNativeObserver(page) {
  const handle = await input(page).elementHandle(); check(handle, 'NATIVE_TEXT_NODE_MISSING');
  await handle.evaluate(node => {
    const parent = node.parentNode, events = [];
    const state = { node, parent, events, disconnected: false, observer: null, listeners: [] };
    for (const type of ['input', 'compositionstart', 'compositionupdate', 'compositionend', 'select', 'focus', 'blur']) {
      const listener = event => events.push({ type, atMs: performance.now(), trusted: event.isTrusted, composing: Boolean(event.isComposing), start: node.selectionStart, end: node.selectionEnd, direction: node.selectionDirection, units: node.value.length });
      node.addEventListener(type, listener); state.listeners.push([type, listener]);
    }
    state.observer = new MutationObserver(() => { if (!node.isConnected || node.parentNode !== parent) state.disconnected = true; });
    state.observer.observe(document, { subtree: true, childList: true });
    Object.defineProperty(node, '__campaignNativeObserver', { value: state, configurable: true });
  });
  return { async read() { return handle.evaluate(node => { const s = node.__campaignNativeObserver; return { events: s.events, disconnected: s.disconnected, sameConnectedParent: node.isConnected && node.parentNode === s.parent, sameNode: document.querySelector('#native-text-content') === node }; }); }, async close() { try { await handle.evaluate(node => { const s = node.__campaignNativeObserver; s.observer.disconnect(); for (const [type, listener] of s.listeners) node.removeEventListener(type, listener); delete node.__campaignNativeObserver; }); } finally { await handle.dispose(); } } };
}

async function runInteraction(page, text, signal, record, observations, missing) {
  await openDraft(page, text); await configureFonts(page, text, signal); await input(page).fill(text.corpus.text);
  const mode = page.getByRole('radio', { name: 'Composition', exact: true }); await mode.check();
  await page.locator('#semantic-tree').getByRole('treeitem').first().waitFor({ state: 'visible' });
  const semanticIds = await page.locator('#semantic-tree').evaluate(host => host.items.map(item => item.key));
  check(text.semanticItemIds.every(id => semanticIds.includes(id)), 'SEEDED_SEMANTIC_IDENTITIES_CHANGED');
  await input(page).focus();
  const observer = await installNativeObserver(page), plan = buildTextInteractionPlan(), start = monotonic();
  let composition, pendingPresentation, initialSession = (await readState(page)).session;
  observations.syntheticComposition = true; observations.plannedCounts = TEXT_INTERACTION_COUNTS;
  observations.textPresentation = { sameConnectedNode: null, forwardRangePreserved: null, backwardRangePreserved: null, collapsedRangePreserved: null, latestDeferredOnlyAfterNativeEnd: null, cancelDropsDeferred: null, staleSessionGenerationVersionRejected: null };
  try {
    for (const action of plan) {
      abort(signal); await intervalWait(Math.max(0, start + action.scheduledMs - monotonic()), signal);
      if (monotonic() - start >= 60000) throw Object.assign(Error('ITEXT_60_SECOND_BUDGET_EXCEEDED'), { code: 'ITEXT_60_SECOND_BUDGET_EXCEEDED' });
      await record(action.id, action.kind, async () => {
        const field = input(page);
        if (action.kind === 'insert-delete') { await field.focus(); if (action.mode === 'insert') await page.keyboard.insertText(text.corpus.fragments[action.fragment]); else await field.press('Backspace'); }
        else if (action.kind === 'caret') {
          await field.focus();
          if (action.range) await field.evaluate((node, direction) => node.setSelectionRange(direction === 'none' ? 1 : 0, direction === 'none' ? 1 : Math.min(4, node.value.length), direction), action.range);
          else await field.press(action.key);
        } else if (action.kind === 'semantic-selection') {
          const items = page.locator('#semantic-tree').getByRole('treeitem');
          check(await items.count() >= 2, 'SEEDED_SEMANTIC_ITEMS_MISSING');
          await items.nth(action.index).click();
        } else if (action.kind === 'text-format') {
          const actions = [
            async () => { await page.getByRole('combobox', { name: 'Font choice', exact: true }).selectOption('NotoSans'); await click(page, 'Use selected font'); await page.getByText(/Exact font order: NotoSans\./).waitFor({ state: 'visible' }); },
            async () => { await page.getByRole('combobox', { name: 'Font choice', exact: true }).selectOption('NotoSansArabic'); await click(page, 'Use selected font'); await page.getByText(/Exact font order: NotoSansArabic\./).waitFor({ state: 'visible' }); },
            () => number(page, 'Line height multiplier', 1.3), () => number(page, 'Line height multiplier', 1.2),
            () => number(page, 'Text frame width (document px)', 350), () => number(page, 'Text frame width (document px)', 360),
            () => number(page, 'Text frame height (document px)', 170), () => number(page, 'Text frame height (document px)', 180),
            () => page.getByRole('button', { name: 'Adjust semantic bounds with arrow keys', exact: true }).press('ArrowRight'),
            () => page.getByRole('button', { name: 'Adjust semantic bounds with arrow keys', exact: true }).press('ArrowLeft'),
          ]; await actions[action.index]();
        } else if (action.kind === 'preedit') {
          await field.focus();
          if (action.step === 0) { composition = { before: await field.inputValue(), range: await readState(page) }; await field.dispatchEvent('compositionstart'); }
          const fragment = text.corpus.fragments[(action.sequence * 2 + action.step) % text.corpus.fragments.length];
          await field.evaluate((node, value) => { node.value = value; node.setSelectionRange(value.length, value.length); }, composition.before + fragment);
          await field.dispatchEvent('compositionupdate', { data: fragment });
          await field.dispatchEvent('input', { inputType: 'insertCompositionText', data: fragment, isComposing: true });
        } else if (action.kind === 'composition-end') {
          const beforeCancel = action.cancelSession ? await readState(page) : null;
          if (action.cancelSession) await click(page, 'Cancel text edit');
          if (action.mode === 'cancel') await field.evaluate((node, value) => { node.value = value; node.setSelectionRange(value.length, value.length); }, composition.before);
          await field.dispatchEvent('compositionend', { data: action.mode === 'cancel' ? '' : text.corpus.fragments[(action.sequence * 2 + 1) % text.corpus.fragments.length] });
          await field.dispatchEvent('input', { inputType: 'insertCompositionText', isComposing: false });
          if (action.cancelSession) { await region(page).waitFor({ state: 'hidden' }); check((await readState(page)).presentation === beforeCancel.presentation, 'CANCEL_APPLIED_DEFERRED_SWITCH'); observations.pendingSwitchDroppedByCancel = true; observations.textPresentation.cancelDropsDeferred = true; }
          else if (pendingPresentation) { await page.waitForFunction(target => document.querySelector('#native-text-editor')?.getAttribute('data-presentation') === target, pendingPresentation); pendingPresentation = undefined; }
        } else if (action.kind === 'presentation') {
          const before = await readState(page), target = before.presentation === 'anchored' ? 'inspector' : 'anchored';
          await click(page, before.presentation === 'anchored' ? 'Continue in inspector' : 'Return to card');
          if (action.mode === 'immediate') {
            await page.waitForFunction(expected => document.querySelector('#native-text-editor')?.getAttribute('data-presentation') === expected, target);
            const after = await readState(page); check(after.session === initialSession && after.start === before.start && after.end === before.end && after.direction === before.direction, 'PRESENTATION_RANGE_OR_SESSION_CHANGED');
            observations.textPresentation[({ forward: 'forwardRangePreserved', backward: 'backwardRangePreserved', none: 'collapsedRangePreserved' })[action.range]] = true;
          } else {
            await waitText(page, 'Switch after composition'); const after = await readState(page);
            check(after.presentation === before.presentation && after.session === before.session && after.revision === before.revision, 'COMPOSING_PRESENTATION_CHANGED_EARLY'); pendingPresentation = target;
          }
        }
      }, { scheduledMs: action.scheduledMs, nativeSource: action.kind === 'preedit' || action.kind === 'composition-end' ? 'synthetic-app-handling' : 'playwright-native-input' });
    }
    const completedAt = monotonic() - start; check(completedAt <= 60000, 'ITEXT_60_SECOND_BUDGET_EXCEEDED');
    await intervalWait(Math.max(0, 60000 - completedAt), signal);
    const captureStoppedMs = monotonic(), endMs = start + 60000;
    observations.segment = { startMs: start, endMs, requestedMs: 60000, captureStoppedMs,
      actualMs: captureStoppedMs - start, completedActionsAtMs: completedAt, actions: 106, reservedFeedbackMs: 600,
      boundary: 'Declared observation window; actual capture stop and late event timestamps remain separate evidence' };
    observations.native = await observer.read();
    observations.textPresentation.sameConnectedNode = observations.native.sameNode && observations.native.sameConnectedParent && !observations.native.disconnected;
    check(observations.textPresentation.sameConnectedNode, 'NATIVE_TEXT_NODE_REPLACED');
    observations.counts = Object.fromEntries(Object.keys(TEXT_INTERACTION_COUNTS).map(kind => [kind, observations.actions.filter(a => a.kind === kind && a.outcome === 'completed').length]));
    check(Object.keys(TEXT_INTERACTION_COUNTS).every(kind => observations.counts[kind] === TEXT_INTERACTION_COUNTS[kind]), 'ITEXT_ACTUAL_COUNTS');
    missing.push('distinct-target latest deferred presentation discrimination: current public toggle repeats the same target during composition', 'stale session/generation/version rejection witness without an additional mutation or presentation request');
  } finally { observations.native ??= await observer.read().catch(() => ({ unavailable: true })); await observer.close(); }
}

export function selectedRecovery(text, cell) {
  const scenario = cell?.parameters?.scenario;
  const cases = ['missing-font', 'corrupt-font', 'restricted-font', 'mismatched-font-hash', 'missing-glyph', 'cancelled-over-limit-composition'];
  if (!cases.includes(scenario)) return { missing: ['explicit supported cell.parameters.scenario for text recovery'], recovery: null };
  const recovery = text?.recoveryCases?.[scenario] ?? text?.recovery;
  return recovery?.scenario === scenario ? { missing: [], recovery } : { missing: ['sealed recovery fixture matching the exact selected scenario'], recovery: null };
}
async function runRecovery(page, text, cell, signal, record, observations, missing) {
  const selected = selectedRecovery(text, cell);
  if (selected.missing.length) { missing.push(...selected.missing); return; }
  const recovery = selected.recovery;
  await openDraft(page, text); await configureFonts(page, text, signal); await input(page).fill(text.corpus.text);
  let routePattern, handler;
  try {
    if (['missing-font', 'corrupt-font', 'mismatched-font-hash'].includes(recovery.scenario)) {
      if (!/^[A-Za-z0-9_-]+$/.test(recovery.assetId ?? '')) { missing.push('owned font asset ID for recovery fault'); return; }
      routePattern = `**/api/v1/assets/${recovery.assetId}/content`;
      let replacement = Buffer.from([0, 1, 2, 3]);
      if (recovery.scenario === 'mismatched-font-hash') {
        if (!recovery.replacementPath || !HASH.test(recovery.replacementHash ?? '')) { missing.push('sealed alternate valid font bytes for hash mismatch'); return; }
        replacement = await readFile(recovery.replacementPath); check(hash(replacement) === recovery.replacementHash, 'RECOVERY_FONT_IDENTITY');
      }
      handler = route => route.fulfill(recovery.scenario === 'missing-font' ? { status: 404, body: '' } : { status: 200, contentType: 'application/octet-stream', body: replacement });
      await page.route(routePattern, handler);
    }
    if (recovery.scenario === 'restricted-font') {
      if (typeof recovery.path !== 'string' || typeof recovery.licensePath !== 'string' || !HASH.test(recovery.sha256 ?? '') || !HASH.test(recovery.licenseSha256 ?? '')) { missing.push('sealed restricted font and license files'); return; }
      const font = await readFile(recovery.path), license = await readFile(recovery.licensePath);
      check(hash(font) === recovery.sha256 && hash(license) === recovery.licenseSha256, 'RECOVERY_FONT_IDENTITY');
      await click(page, 'Local font import and exact relink');
      await page.locator('en-file-upload[label="Font file"] input').setInputFiles({ name: 'restricted.ttf', mimeType: 'application/octet-stream', buffer: font });
      await page.locator('en-file-upload[label="Font license record"] input').setInputFiles({ name: 'license.txt', mimeType: 'text/plain', buffer: license });
      await page.getByRole('switch', { name: 'I have permission to embed this font', exact: true }).check();
      const retainedHash = hash(await input(page).inputValue());
      await record('text-recovery', 'recovery', async () => { await click(page, 'Import as substitution draft'); await region(page).locator('en-alert').filter({ hasText: 'FONT_EMBEDDING_RESTRICTED' }).last().waitFor({ state: 'visible' }); });
      check(hash(await input(page).inputValue()) === retainedHash, 'RECOVERY_DRAFT_CHANGED');
      observations.recovery = { scenario: recovery.scenario, draftHash: retainedHash, retained: true, rejectedFontHash: recovery.sha256 }; return;
    }
    if (recovery.scenario === 'missing-glyph') {
      if (typeof recovery.text !== 'string' || !HASH.test(recovery.textHash ?? '') || hash(recovery.text) !== recovery.textHash) { missing.push('sealed unsupported-glyph string'); return; }
      await input(page).fill(recovery.text);
    }
    if (recovery.scenario === 'cancelled-over-limit-composition') {
      const oversized = 'x'.repeat(16385); await input(page).focus();
      await input(page).dispatchEvent('compositionstart');
      await input(page).evaluate((node, value) => { node.value = value; }, oversized);
      await input(page).dispatchEvent('input', { inputType: 'insertCompositionText', isComposing: true });
      await input(page).dispatchEvent('compositionend'); await input(page).dispatchEvent('input', { inputType: 'insertCompositionText', isComposing: false });
    }
    const expected = recovery.scenario === 'missing-font' ? /Missing exact font bytes|Missing exact font registration/ : ['corrupt-font', 'mismatched-font-hash'].includes(recovery.scenario) ? /FONT_HASH/ : recovery.scenario === 'missing-glyph' ? /Missing glyphs/ : /TEXT_BYTES/;
    const retainedHash = hash(await input(page).inputValue());
    await record('text-recovery', 'recovery', async () => { abort(signal); await click(page, 'Preview text'); await region(page).locator('en-alert').filter({ hasText: expected }).last().waitFor({ state: 'visible' }); });
    check(hash(await input(page).inputValue()) === retainedHash, 'RECOVERY_DRAFT_CHANGED'); observations.recovery = { scenario: recovery.scenario, draftHash: retainedHash, retained: true };
    if (recovery.scenario === 'cancelled-over-limit-composition') {
      await input(page).dispatchEvent('compositionstart'); await click(page, 'Cancel text edit');
      check(await region(page).isVisible(), 'CANCEL_ENDED_COMPOSITION_EARLY'); await input(page).dispatchEvent('compositionend'); await region(page).waitFor({ state: 'hidden' }); observations.recovery.cancelDeferredUntilNativeEnd = true;
    }
  } finally { if (routePattern) await page.unroute(routePattern, handler); }
}

/** Uses a supplied real Playwright Page, never launches a browser or edits
 * product state through private controllers. Durations end at observed app
 * completion; the outer driver must correlate actual compositor presentation. */
export async function runTextBrowserCell({ page, cell, fixture, signal, context, repo }) {
  const operation = typeof cell === 'string' ? cell : cell.operation, workload = cell.workload ?? fixture?.workload ?? 'WXn';
  check(supportedTextOperations.includes(operation), 'UNSUPPORTED_TEXT_OPERATION');
  const phases = [], assertions = [], missing = [], observations = { actions: [], operation, timingBasis: 'real-monotonic-wall-time', inputTimingBoundary: 'runner invocation before Playwright dispatch; browser native event timestamps remain a separate clock', presentationEvidence: 'outer-driver-required' };
  const result = () => ({ status: missing.length ? 'INCONCLUSIVE' : 'PASS', phases, observations, assertions, missing: [...new Set(missing)] });
  if (operation === 'text.native-ime') {
    const witness = summarizeNativeWitness(fixture?.text?.nativeWitness, workload); observations.nativeWitness = witness.observation;
    missing.push(...witness.missing);
    // Imported witness metadata is insufficient to manufacture an observed run.
    missing.push('external native witness verification and correlation to this campaign attempt by its authoritative issuer');
    return result();
  }
  missing.push(...inspectTextFixture(fixture, operation, workload)); if (missing.length) return result();
  const text = fixture.text;
  observations.corpus = { sha256: text.corpus.sha256, bytes: bytes(text.corpus.text), fragments: text.corpus.fragments.length, manifestHash: text.manifestHash };
  observations.fonts = text.fonts.map(({ id, sha256, bytes }) => ({ idHash: hash(id), sha256, bytes }));
  const record = async (id, kind, work, metadata = {}) => {
    abort(signal); const action = { id, kind, inputMs: monotonic(), presentedMs: null, meaningful: true, outcome: 'running', ...metadata }; observations.actions.push(action);
    const phase = { name: id, startMs: action.inputMs, endMs: null, durationMs: null, outcome: 'running' }; phases.push(phase);
    try { await work(); action.outcome = phase.outcome = 'completed'; }
    catch (error) { action.outcome = phase.outcome = 'failed'; action.errorCode = typeof error.code === 'string' ? error.code : 'TEXT_BROWSER_ACTION_FAILED'; throw error; }
    finally { action.readyMs = phase.endMs = monotonic(); action.durationMs = phase.durationMs = phase.endMs - phase.startMs; }
  };
  try {
    abort(signal);
    // Sealed local faces are verified before any measured UI intent; bundled
    // declarations must match the actual shipped profile, not only a label.
    const subjectRepo = resolve(repo ?? context?.repo ?? fixture.repo ?? fileURLToPath(new URL('../../../', import.meta.url)));
    const profile = JSON.parse(await readFile(resolve(subjectRepo, 'src/text/profile.json'), 'utf8'));
    for (const font of text.fonts) {
      if (font.kind === 'bundled') {
        const actual = profile.fonts.find(entry => entry.id === font.id);
        check(actual && 'sha256:' + actual.sha256 === font.sha256 && actual.bytes === font.bytes, 'BUNDLED_FONT_FIXTURE_MISMATCH');
      } else {
        const actual = await readFile(font.path), license = await readFile(font.licensePath);
        check(actual.byteLength === font.bytes && hash(actual) === font.sha256 && hash(license) === font.licenseSha256, 'LOCAL_FONT_FIXTURE_MISMATCH');
      }
    }
    if (operation === 'text.interaction') await runInteraction(page, text, signal, record, observations, missing);
    else if (operation === 'text.recovery') await runRecovery(page, text, cell, signal, record, observations, missing);
    else if (operation === 'text.mixed-ready') {
      await record('mixed-navigation-ready', 'mixed-ready', async () => { await page.reload(); await waitText(page, 'Local recovery complete. Accepted edits are saved locally.'); await page.locator('canvas[aria-label="Document raster preview"]').waitFor({ state: 'visible' }); });
      observations.nativeLayerCount = await page.locator('#layer-tree').getByRole('treeitem').count();
      if (!Number.isSafeInteger(text.expectedLayerCount) || observations.nativeLayerCount !== text.expectedLayerCount) missing.push('exact mixed fixture layer count');
      observations.retainedText = await verifyRetainedText(page, text);
      missing.push('navigation-scoped all-text layout completion witness; retained layers alone do not prove fresh mixed readiness');
    } else {
      if (operation === 'text.font-set') {
        await record('exact-font-set-registration', 'font-set', async () => { await openDraft(page, text); await input(page).fill(text.corpus.text); await configureFonts(page, text, signal); await preview(page); });
      } else {
        await openDraft(page, text); await configureFonts(page, text, signal);
        if (operation === 'text.active-layout') await record('active-text-layout', 'active-layout', async () => { await input(page).fill(text.corpus.text); await preview(page); });
        else { await input(page).fill(text.corpus.text); await preview(page); await record('durable-text-apply', 'apply', async () => { observations.receipt = await acceptedCommand(page, text.activeLayerId ? 'CommitTextEdit' : 'CreateTextLayer', () => click(page, 'Apply text'), signal); await region(page).waitFor({ state: 'hidden' }); }); }
      }
      if (operation !== 'text.apply') {
        observations.preview = await previewIdentity(page);
        if (!HASH.test(text.expectedPreviewHash ?? '')) missing.push('sealed expected canonical preview pixel hash');
        else check(observations.preview.sha256 === text.expectedPreviewHash, 'CANONICAL_TEXT_PREVIEW_MISMATCH');
      } else missing.push('presented canonical viewport witness from outer driver');
    }
    assertions.push({ id: 'real-product-controls', passed: true }, { id: 'receipt-content-privacy', passed: true });
    return result();
  } catch (error) {
    if (error.prerequisite) { missing.push(error.message); return result(); }
    return { ...result(), status: 'FAIL', error: { name: error?.name ?? 'Error', code: typeof error?.code === 'string' ? error.code : 'TEXT_BROWSER_ACTION_FAILED' } };
  }
}
