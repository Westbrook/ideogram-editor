import {randomBytes} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join, sep} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {attemptIdentity, digest} from './common.mjs';
import {collectAcceptedDocumentFonts, inspectAcceptedDocumentFonts} from './browser-text-fonts.mjs';
import {collectOrdinaryFontInvariant, replayOrdinaryFontInvariant, ordinaryFontInvariantMeasurement, ORDINARY_FONT_INVARIANT_SOURCE_FILES} from './browser-text-invariant.mjs';

export const TEXT_RECOVERY_FONT_SCENARIOS = Object.freeze(['missing-font', 'corrupt-font', 'restricted-font', 'mismatched-font-hash', 'missing-glyph', 'cancelled-over-limit-composition']);
export const RECOVERY_FONT_NAMES = Object.freeze(['R35CurrentFontFaces', 'R35SingleFontBytes', 'R35CurrentFontSetBytes', 'R35SilentFontSubstitutionCount']);
const proofs = new WeakMap(), SHA = /^sha256:[a-f0-9]{64}$/, SOURCE_SHA = /^[a-f0-9]{64}$/, ID = /^[A-Za-z0-9_-]{1,128}$/;
const limits = {raw: 4 * 1048576, binding: 128 * 1024};
const demand = (ok, message) => {if (!ok) throw Error('Recovery fonts: ' + message);};
const same = (a, b, message) => demand(isDeepStrictEqual(a, b), message);
const finite = value => Number.isFinite(value) && value >= 0;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
const decode = bytes => JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
const encode = value => Buffer.from(JSON.stringify(value));
function fixtureIdentity(fixture, cell) {
  const scenario = cell?.parameters?.scenario, text = fixture?.text;
  const recovery = text?.recoveryCases?.[scenario] ?? text?.recovery;
  demand(TEXT_RECOVERY_FONT_SCENARIOS.includes(scenario) && recovery?.scenario === scenario, 'exact sealed recovery scenario unavailable');
  const draftHash = scenario === 'missing-glyph' ? recovery.textHash : scenario === 'cancelled-over-limit-composition' ? digest('x'.repeat(16385)) : text.corpus?.sha256;
  demand(ID.test(text.documentId ?? '') && ID.test(text.activeLayerId ?? '') && SHA.test(draftHash ?? ''), 'accepted document, layer and recovery draft required');
  return {documentId: text.documentId, layerId: text.activeLayerId, scenario, draftHash, specimenSha256: digest(JSON.stringify(recovery)),
    rejectedFontHash: scenario === 'restricted-font' ? recovery.sha256 : null};
}
export function recoveryFontOutcome(recovery, missing = 0) {
  return recovery ? {scenario: recovery.scenario, draftHash: recovery.draftHash, retained: recovery.retained,
    rejectedFontHash: recovery.rejectedFontHash ?? null, cancelDeferredUntilNativeEnd: recovery.cancelDeferredUntilNativeEnd === true, missing} : null;
}
function acceptedIdentity(fonts) {return {root: fonts.before, layers: fonts.layers, fonts: fonts.fonts, files: fonts.files};}
function expectedError(scenario) {
  return scenario === 'missing-font' ? /Missing exact font bytes|Missing exact font registration/ : scenario === 'restricted-font' ? /FONT_EMBEDDING_RESTRICTED/ :
    ['corrupt-font', 'mismatched-font-hash'].includes(scenario) ? /FONT_HASH/ : scenario === 'missing-glyph' ? /Missing glyphs/ : null;
}
/** Numeric identities and a bounded native hash only. Oversized recovery drafts
 * are deliberately separate from ordinary successful-preview admission. */
export async function readRecoveryFontState(page, scenario) {
  demand(TEXT_RECOVERY_FONT_SCENARIOS.includes(scenario), 'known refusal scenario required');
  return page.evaluate(async pattern => {
    const node = document.querySelector('#native-text-editor'), control = document.querySelector('#native-text-content');
    const errorNode = document.querySelector('#native-text-error');
    const check = () => {if (!node?.isConnected || node.hidden || !control?.isConnected || document.querySelector('#native-text-editor') !== node ||
      document.querySelector('#native-text-content') !== control || document.querySelector('#native-text-error') !== errorNode) throw Error('RECOVERY_NATIVE_BOUNDARY');};
    const attr = name => {const value = node.getAttribute(name); if (typeof value !== 'string' || value.length > 128) throw Error('RECOVERY_NATIVE_ATTRIBUTE'); return value;};
    const snapshot = () => {
      check();
      const draft = control.value; if (typeof draft !== 'string' || draft.length > 65536) throw Error('RECOVERY_NATIVE_BOUNDARY');
      const buttons = [...node.querySelectorAll('en-button')]; if (buttons.length > 64) throw Error('RECOVERY_CONTROL_BOUND');
      const disabled = name => {const values = buttons.filter(button => button.textContent?.trim() === name); if (values.length !== 1 || !values[0].isConnected) throw Error('RECOVERY_CONTROL_IDENTITY'); return values[0].hasAttribute('disabled');};
      const error = errorNode?.textContent ?? ''; if (error.length > 4096) throw Error('RECOVERY_ERROR_BOUND');
      return {documentId: attr('data-text-document-id'), revision: attr('data-text-document-revision'), layerId: attr('data-text-layer-id'), layerVersion: attr('data-text-layer-version'),
        sessionId: attr('data-text-session-id'), draftId: attr('data-session'), generation: attr('data-text-generation'), previewId: attr('data-preview-id'),
        draft, errorVisible: !!(pattern && errorNode && new RegExp(pattern).test(error) && errorNode.getClientRects().length && getComputedStyle(errorNode).visibility !== 'hidden'),
        overLimitAdmission: document.querySelector('#native-text-admission')?.textContent === 'UTF-8 text uses 16385 bytes; one layer permits 16384 bytes. Review a split, shorten manually, or cancel.',
        previewDisabled: disabled('Preview text'), applyDisabled: disabled('Apply text')};
    };
    const before = snapshot();
    for (const character of before.draft) {const code = character.codePointAt(0); if (code >= 0xd800 && code <= 0xdfff) throw Error('RECOVERY_NATIVE_UNICODE');}
    const value = new TextEncoder().encode(before.draft); if (value.byteLength > 65536) throw Error('RECOVERY_NATIVE_BOUNDARY');
    const sha256 = 'sha256:' + [...new Uint8Array(await crypto.subtle.digest('SHA-256', value))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const after = snapshot(); if (JSON.stringify(before) !== JSON.stringify(after)) throw Error('RECOVERY_NATIVE_CHANGED_DURING_READ');
    const {draft: _draft, ...identity} = after;
    return {timeOrigin: performance.timeOrigin, atMs: performance.now(), ...identity, draftHash: sha256, draftBytes: value.byteLength};
  }, expectedError(scenario)?.source ?? null);
}

function inspectRefusal(raw, binding) {
  const step = raw.refusal, scenario = binding.recovery.scenario;
  demand(exact(step, ['startedMs', 'endedMs', 'before', 'after', 'completed']) && step.completed === true && finite(step.startedMs) && finite(step.endedMs) &&
    step.startedMs >= raw.actionStartedMs && step.endedMs >= step.startedMs && step.endedMs <= raw.actionEndedMs, 'one completed original refusal required');
  const a = step.before, b = step.after;
  const keys = ['timeOrigin', 'atMs', 'documentId', 'revision', 'layerId', 'layerVersion', 'sessionId', 'draftId', 'generation', 'previewId', 'draftHash', 'draftBytes', 'overLimitAdmission', 'errorVisible', 'previewDisabled', 'applyDisabled'];
  for (const state of [a, b]) {
    demand(exact(state, keys) && finite(state.timeOrigin) && state.timeOrigin > 0 && finite(state.atMs) &&
      ['documentId', 'layerId', 'sessionId', 'draftId'].every(key => ID.test(state[key])) &&
      ['revision', 'layerVersion', 'generation'].every(key => /^(0|[1-9][0-9]*)$/.test(state[key])) &&
      (state.previewId === '' || ID.test(state.previewId)) && SHA.test(state.draftHash) && Number.isSafeInteger(state.draftBytes) && state.draftBytes >= 0 && state.draftBytes <= 65536 &&
      ['overLimitAdmission', 'errorVisible', 'previewDisabled', 'applyDisabled'].every(key => typeof state[key] === 'boolean'), 'bounded native refusal identity required');
  }
  const identity = state => Object.fromEntries(['documentId', 'revision', 'layerId', 'layerVersion', 'sessionId', 'draftId', 'generation', 'previewId', 'draftHash', 'draftBytes'].map(key => [key, state[key]]));
  same(identity(a), identity(b), 'refusal changed the native draft/session or created a preview');
  demand(a.timeOrigin === b.timeOrigin && a.timeOrigin === raw.before.timeOrigin && a.atMs <= b.atMs && a.atMs >= raw.before.endMs && b.atMs <= raw.after.startMs,
    'refusal browser realm or boundary order differs');
  demand(a.documentId === binding.recovery.documentId && a.revision === raw.before.before.revision && a.layerId === binding.recovery.layerId && a.draftHash === binding.recovery.draftHash,
    'refusal differs from accepted document or exact scenario draft');
  const layer = raw.before.layers.find(value => value.id === a.layerId);
  demand(layer?.kind === 'text' && layer.version === a.layerVersion, 'refusal layer differs from accepted source');
  if (scenario === 'cancelled-over-limit-composition') demand(a.draftBytes === 16385 && a.overLimitAdmission && b.overLimitAdmission && a.previewDisabled && b.previewDisabled && a.applyDisabled && b.applyDisabled,
    'over-limit refusal must be actual admission with both controls disabled');
  else demand(!a.errorVisible && b.errorVisible, 'fresh expected rejection required; a stale alert is not evidence');
}
/** Pure bounded replay; only the immutable validator issuer can prove zero. */
export function inspectRecoveryFontRaw(raw, binding, {fontInvariantProof} = {}) {
  const missing = [], failures = [], measurements = [];
  demand(exact(raw, ['kind', 'nonce', 'binding', 'clock', 'startedMs', 'endedMs', 'actionStartedMs', 'actionEndedMs', 'before', 'after', 'refusal', 'outcome', 'failed', 'fontInvariant', 'missing']) &&
    raw.kind === 'recovery-font-raw-1' && raw.nonce === binding.nonce && raw.clock === 'runner-monotonic' && typeof raw.failed === 'boolean' && Array.isArray(raw.missing) && raw.missing.length <= 32,
    'raw observation shape differs');
  same(raw.binding, binding.attempt, 'raw attempt differs');
  demand(TEXT_RECOVERY_FONT_SCENARIOS.includes(binding.recovery?.scenario), 'recovery scenario differs');
  missing.push(...raw.missing);
  if (raw.failed) missing.push('Original recovery action did not complete; unchanged accepted state cannot supply recovery proof');
  if (!raw.before || !raw.after || !raw.refusal || !raw.outcome || raw.refusal.completed !== true || raw.outcome.missing !== 0) missing.push('Original recovery or accepted closure is incomplete');
  if (missing.length) return {kind: 'recovery-font-analysis-1', qualification: false, acceptedDocumentOnly: true, draftRendering: false, physicalPresentation: false, measurements, missing: [...new Set(missing)], failures};
  try {
    demand([raw.startedMs, raw.endedMs, raw.actionStartedMs, raw.actionEndedMs].every(finite) && raw.startedMs <= raw.actionStartedMs && raw.actionStartedMs <= raw.actionEndedMs && raw.actionEndedMs <= raw.endedMs, 'original action bracket unavailable');
    const before = inspectAcceptedDocumentFonts(raw.before, binding.attempt), after = inspectAcceptedDocumentFonts(raw.after, binding.attempt);
    if (before.missing.length || after.missing.length || before.measurements.length !== 3 || after.measurements.length !== 3) {
      missing.push('Both complete accepted font closures are required', ...before.missing, ...after.missing);
      return {kind: 'recovery-font-analysis-1', qualification: false, acceptedDocumentOnly: true, draftRendering: false, physicalPresentation: false, measurements, missing: [...new Set(missing)], failures};
    }
    same(acceptedIdentity(raw.before), acceptedIdentity(raw.after), 'accepted document/source/font closure changed across recovery');
    demand(raw.before.before.documentId === binding.recovery.documentId && raw.before.timeOrigin === raw.after.timeOrigin && raw.before.endMs <= raw.after.startMs, 'accepted font browser realm/order differs');
    inspectRefusal(raw, binding);
    const outcome = raw.outcome;
    demand(exact(outcome, ['scenario', 'draftHash', 'retained', 'rejectedFontHash', 'cancelDeferredUntilNativeEnd', 'missing']) && outcome.scenario === binding.recovery.scenario && outcome.draftHash === binding.recovery.draftHash && outcome.retained === true && outcome.missing === 0 && outcome.rejectedFontHash === binding.recovery.rejectedFontHash,
      'original recovery result lacks exact refusal and retained draft');
    demand(outcome.cancelDeferredUntilNativeEnd === (binding.recovery.scenario === 'cancelled-over-limit-composition'), 'deferred cancellation differs');
    if (outcome.cancelDeferredUntilNativeEnd) demand(raw.after.nativeEditorAfter.hidden === true && raw.after.nativeEditorAfter.session === '', 'deferred cancellation did not close the native editor');
    else demand(raw.after.nativeEditorAfter.hidden === false && raw.after.nativeEditorAfter.session === raw.refusal.after.draftId, 'rejected draft is no longer open');
    if (!raw.failed && !missing.length) {
      measurements.push(...after.measurements);
      const invariant = ordinaryFontInvariantMeasurement({fonts: raw.after, evidence: raw.fontInvariant, proof: fontInvariantProof});
      if (invariant) measurements.push({...invariant, method: 'Unchanged accepted document image, ordered sources, validated layouts, text and exact font bytes across the original rejected recovery action; hidden layers included. Invalid draft, worker success, native display, presentation and physical memory are excluded.'});
      else missing.push('Accepted recovery closure lacks immutable source/layout/text/font replay');
    }
  } catch (error) {failures.push(error.message);}
  return {kind: 'recovery-font-analysis-1', qualification: false, acceptedDocumentOnly: true, draftRendering: false, physicalPresentation: false,
    measurements: failures.length ? [] : measurements, missing: [...new Set(missing)], failures};
}
function measurementRows(analysis, artifact) {return analysis.measurements.map(row => ({...row, evidence: [{kind: 'recovery-font-retained-observation-1', artifact}]}));}
export function recoveryFontMeasurement({cell, sample, rule, proof}) {
  const value = proof && proofs.get(proof);
  if (!value || cell?.operation !== 'text.recovery' || value.binding.recovery.scenario !== cell.parameters?.scenario ||
    !isDeepStrictEqual(value.binding.attempt, {cellId: cell.id, id: attemptIdentity(cell, sample.cache, sample.ordinal, sample.prime), cache: sample.cache, ordinal: sample.ordinal, prime: Boolean(sample.prime), serial: value.binding.attempt.serial})) return {reason: 'Current owned recovery-font observation proof unavailable'};
  const row = value.measurements.find(item => item.name === rule.name);
  return row && rule.budgetId === 'R35' && rule.unit === row.unit ? {measurement: structuredClone(row)} : {reason: 'Exact accepted recovery-font registry row is unavailable'};
}
/** Observe the original recovery including setup and fault cleanup. Extra reads
 * are charged observation I/O and may warm caches; they prove no load latency. */
export function createRecoveryFontObserver({page, repo, root, cell, sample, serial, fixture, runtime, environment, processIdentity, output, signal, journal}) {
  demand(cell.operation === 'text.recovery', 'recovery cell required');
  const nonce = randomBytes(16).toString('hex'), prefix = 'recovery-font-' + nonce;
  const binding = {kind: 'recovery-font-binding-1', nonce, operation: cell.operation,
    attempt: {cellId: cell.id, id: attemptIdentity(cell, sample.cache, sample.ordinal, sample.prime), cache: sample.cache, ordinal: sample.ordinal, prime: Boolean(sample.prime), serial},
    fixtureSeal: fixture.seal, recovery: fixtureIdentity(fixture, cell), environment, processIdentity, runtime};
  const raw = {kind: 'recovery-font-raw-1', nonce, binding: binding.attempt, clock: 'runner-monotonic', startedMs: performance.now(), endedMs: null,
    actionStartedMs: null, actionEndedMs: null, before: null, after: null, refusal: null, outcome: null, failed: true, fontInvariant: null, missing: []};
  let observing = false, observed = false, finished = false, fontInvariantProof;
  const capture = () => collectAcceptedDocumentFonts({page, documentId: fixture.text.documentId, fontAssetIds: fixture.native?.fontAssetIds ?? [], binding: binding.attempt, signal});
  const missing = code => {if (!raw.missing.includes(code)) raw.missing.push(code);};
  return {
    async observe(action) {
      demand(!observing && !observed && !finished, 'one recovery observation required'); observing = true; observed = true;
      try {raw.before = await capture();} catch {missing('recovery-accepted-baseline-unavailable');}
      raw.actionStartedMs = performance.now();
      try {raw.outcome = await action(); raw.failed = false;}
      finally {
        raw.actionEndedMs = performance.now();
        try {
          // runRecovery's finally has removed injected font routes before this read.
          raw.after = await capture();
          const invariant = await collectOrdinaryFontInvariant({repo, root, fonts: raw.after, nonce, output, signal});
          raw.fontInvariant = invariant.evidence; fontInvariantProof = invariant.proof;
        } catch {missing('recovery-accepted-closure-unavailable');}
        observing = false;
      }
    },
    async refusal(action) {
      demand(observing && !raw.refusal, 'one original recovery refusal required');
      const step = raw.refusal = {startedMs: performance.now(), endedMs: null, before: null, after: null, completed: false};
      try {step.before = await readRecoveryFontState(page, binding.recovery.scenario);} catch {missing('recovery-refusal-baseline-unavailable');}
      try {const value = await action(); step.completed = true; return value;}
      finally {try {step.after = await readRecoveryFontState(page, binding.recovery.scenario);} catch {missing('recovery-refusal-endpoint-unavailable');} step.endedMs = performance.now();}
    },
    async finish({failed = false} = {}) {
      demand(!observing && !finished, 'recovery observer must settle'); finished = true; raw.failed ||= failed; raw.endedMs = performance.now();
      const retain = async (name, value, maximum) => {const bytes = encode(value); demand(bytes.length <= maximum, 'retained artifact bound'); const path = prefix + '-' + name + '.json'; await writeFile(join(output, path), bytes, {mode: 0o600, flag: 'wx'}); return {path, bytes: bytes.length, sha256: digest(bytes)};};
      const bindingArtifact = await retain('binding', binding, limits.binding), artifact = await retain('raw', raw, limits.raw);
      const analysis = inspectRecoveryFontRaw(raw, binding, {fontInvariantProof});
      const observation = {kind: 'recovery-font-observation-1', nonce, binding: bindingArtifact, raw: artifact, analysis, qualification: false, acceptedDocumentOnly: true};
      const measurements = measurementRows(analysis, {...artifact, path: join(output, artifact.path)}), proof = Object.freeze({}); proofs.set(proof, {binding, measurements});
      await journal?.({event: 'recovery-font-observed', cellId: cell.id, nonce, binding: bindingArtifact, raw: artifact}); return {proof, observation};
    },
  };
}

/** Replay exact retained source/native/attempt evidence before any publication. */
export async function verifyRecoveryFontEvidence({attempt, cell, serial, fixture, environment, workerProcessIdentity, groupOutput, retainedFiles, readRetained, controlFiles, sourceFiles, sourceRoot, browserCache, tools, developerState, developerStateIdentity, journalEvents}) {
  if (cell?.operation !== 'text.recovery') return null;
  const observation = attempt.result?.observations?.recoveryFonts;
  const published = (attempt.result?.measurements ?? []).filter(row => RECOVERY_FONT_NAMES.includes(row.name));
  if (!observation) {demand(!published.length && attempt.status !== 'PASS' && attempt.result?.status !== 'PASS', 'recovery measurements or PASS lack retained observation'); return null;}
  demand(observation.kind === 'recovery-font-observation-1' && observation.qualification === false && observation.acceptedDocumentOnly === true && /^[a-f0-9]{32}$/.test(observation.nonce ?? ''), 'observation scope or nonce differs');
  const seals = new Map(retainedFiles.map(file => [file.path, file])), prefix = 'recovery-font-' + observation.nonce;
  const read = async (identity, name, maximum) => {
    demand(identity?.path === prefix + '-' + name + '.json' && Number.isSafeInteger(identity.bytes) && identity.bytes > 0 && identity.bytes <= maximum && SHA.test(identity.sha256), 'retained member differs');
    const seal = seals.get(identity.path); demand(seal?.bytes === identity.bytes && seal.sha256 === identity.sha256, 'outer seal differs');
    const bytes = await readRetained(identity.path, {maximum}); demand(bytes.length === identity.bytes && digest(bytes) === identity.sha256, 'retained bytes differ'); return decode(bytes);
  };
  const binding = await read(observation.binding, 'binding', limits.binding), raw = await read(observation.raw, 'raw', limits.raw);
  demand(exact(binding, ['kind', 'nonce', 'operation', 'attempt', 'fixtureSeal', 'recovery', 'environment', 'processIdentity', 'runtime']) && binding.kind === 'recovery-font-binding-1' && binding.nonce === observation.nonce && binding.operation === cell.operation, 'binding differs');
  same(binding.attempt, {cellId: cell.id, id: attempt.id, cache: attempt.cache, ordinal: attempt.ordinal, prime: attempt.prime, serial}, 'scheduled attempt differs');
  same(binding.fixtureSeal, fixture.seal, 'fixture seal differs'); same(binding.recovery, fixtureIdentity(fixture, cell), 'sealed recovery specimen differs');
  same(binding.environment, environment, 'source/build identity differs'); same(binding.processIdentity, workerProcessIdentity, 'worker differs');
  demand(workerProcessIdentity?.node === 'v26.10.0' && workerProcessIdentity.pid > 1 && finite(attempt.startMs) && finite(attempt.endMs) && finite(raw.startedMs) && finite(raw.endedMs) && raw.startedMs >= attempt.startMs && raw.endedMs <= attempt.endMs, 'worker clock window differs');
  // core.sourceIdentity supplies bare source/control hashes. Build, tool and
  // retained-artifact identities use common.digest's explicit sha256 prefix.
  demand(['sourceDigest', 'controlDigest'].every(key => SOURCE_SHA.test(environment?.[key] ?? '')) &&
    ['buildDigest', 'toolsDigest'].every(key => SHA.test(environment?.[key] ?? '')), 'Recovery font executable bindings missing');
  for (const name of ['browser.mjs', 'browser-text.mjs', 'browser-text-recovery-fonts.mjs', 'browser-text-fonts.mjs', 'browser-text-invariant.mjs', 'ordinary-text-phases.mjs', 'browser-measurements.mjs', 'worker.mjs', 'run.mjs', 'verification.mjs']) demand(controlFiles?.some(file => file.path === 'tooling/qualification/campaigns/' + name && SOURCE_SHA.test(file.sha256)), 'Recovery font control source closure missing: ' + name);
  for (const name of ['src/ui/native-text.ts', 'src/ui/shell.ts', 'src/state/editor-client.ts', 'src/observability/browser.ts', 'src/observability/navigation-observations.ts']) demand(sourceFiles?.some(file => file.path === name && SOURCE_SHA.test(file.sha256)), 'Recovery font application source closure missing: ' + name);
  demand(controlFiles?.some(file => file.path === 'tooling/qualification/evidence-volume.mjs' && SOURCE_SHA.test(file.sha256)), 'Ordinary font invariant evidence allocation control closure missing');
  for (const name of ORDINARY_FONT_INVARIANT_SOURCE_FILES) demand(sourceFiles?.some(file => file.path === name && SOURCE_SHA.test(file.sha256)), 'Ordinary font invariant validator source closure missing: ' + name);
  const runtime = decode(await readRetained('browser-runtime.json', {maximum: 1024 * 1024})); same(binding.runtime, runtime, 'Recovery font actual browser differs'); same(runtime.fixtureSeal, fixture.seal, 'Recovery font browser fixture differs');
  demand(runtime.ownedLaunch?.context?.createdBy === 'browser.newContext' && runtime.browserPid > 1 && runtime.backendPid > 1 && runtime.playwrightModule?.startsWith(join(sourceRoot, 'node_modules') + sep) && runtime.executable?.startsWith(browserCache + sep), 'Recovery font owned browser path differs');
  const pins = tools?.browserPins?.browsers?.filter(pin => pin.name === runtime.engine);
  demand(pins?.length === 1 && pins[0].revision === runtime.revision && pins[0].browserVersion === runtime.version && SHA.test(runtime.executableIdentity?.sha256 ?? ''), 'Recovery font browser version pin differs');
  demand(developerState?.kind === 'developer-runtime-state-1' && digest(JSON.stringify(developerState.state, null, 2) + '\n').slice(7) === developerState.sha256?.replace(/^sha256:/, '') && SHA.test(developerStateIdentity?.sha256 ?? ''), 'Recovery font prepared executable evidence is missing');
  const state = developerState.state, workspace = state.h?.source === sourceRoot ? state.h : state.p;
  const completed = workspace === state.h ? workspace?.completed === true : workspace?.completed?.includes('production-build') && workspace.completed.includes('browser-cache');
  demand(completed && !workspace.failure && !workspace.active && state.productRepo === sourceRoot && workspace.source === sourceRoot && state.sourceDigest === environment.sourceDigest, 'Recovery font prepared source differs');
  const selectedCache = state.playwrightBrowsersPath ?? workspace.browserCache, prepared = workspace.browserIdentity?.engines?.filter(value => value.engine === runtime.engine);
  demand(selectedCache === browserCache && prepared?.length === 1 && prepared[0].executable === runtime.executable && prepared[0].version === runtime.version && prepared[0].revision === runtime.revision &&
    prepared[0].bytes === runtime.executableIdentity.bytes && prepared[0].sha256?.replace(/^sha256:/, '') === runtime.executableIdentity.sha256.slice(7), 'Recovery font browser immutable preparation differs');
  for (const kind of ['browser', 'backend']) {
    const pid = runtime[kind + 'Pid'], entries = retainedFiles.filter(file => new RegExp('^owned-process-' + pid + '-[a-f0-9-]{36}\\.json$').test(file.path));
    demand(entries.length === 1, 'Recovery font process ownership missing'); const record = decode(await readRetained(entries[0].path, {maximum: 65536})), process = record.processes?.[0];
    demand(record.ownerPid === workerProcessIdentity.pid && record.kind === 'perf-owned-processes-1' && record.processes?.length === 1 && process.kind === kind && process.pid === pid && process.pgid > 1, 'Recovery font process ownership differs');
    if (kind === 'browser') demand(runtime.ownedLaunch.process?.registration?.path === join(groupOutput, entries[0].path) && runtime.ownedLaunch.process?.startedAtIdentity === process.startedAtIdentity && process.executable === runtime.executable, 'Recovery font browser launch differs');
  }
  const events = journalEvents.filter(event => event.event === 'recovery-font-observed' && event.nonce === observation.nonce && event.cellId === cell.id);
  demand(events.length === 1 && events[0].monotonicMs >= raw.endedMs && events[0].monotonicMs <= attempt.endMs, 'journal closure differs');
  same(events[0].binding, observation.binding, 'journal binding differs'); same(events[0].raw, observation.raw, 'journal raw differs');
  if (raw.outcome) same(raw.outcome, recoveryFontOutcome(attempt.result?.observations?.recovery, raw.outcome.missing), 'published recovery outcome differs');
  if (raw.refusal?.completed) {
    const actions = (attempt.result?.observations?.actions ?? []).filter(action => action.id === 'text-recovery');
    demand(actions.length === 1 && actions[0].kind === 'recovery' && actions[0].outcome === 'completed' && finite(actions[0].inputMs) && finite(actions[0].readyMs) &&
      actions[0].inputMs >= raw.actionStartedMs && actions[0].inputMs <= raw.refusal.startedMs && actions[0].readyMs >= raw.refusal.endedMs && actions[0].readyMs <= raw.actionEndedMs,
      'original recovery action differs from the refusal interval');
  }
  const fontInvariantProof = raw.fontInvariant ? await replayOrdinaryFontInvariant({repo: sourceRoot, fonts: raw.after, nonce: binding.nonce, output: groupOutput,
    evidence: raw.fontInvariant, readRetained, retainedFiles}) : undefined;
  const analysis = inspectRecoveryFontRaw(raw, binding, {fontInvariantProof}); same(analysis, observation.analysis, 'retained analysis differs');
  demand(!analysis.failures.length || attempt.status === 'FAIL' && attempt.result.status === 'FAIL', 'accepted-state contradiction was not reported as failure');
  demand(!analysis.missing.length || attempt.status !== 'PASS' && attempt.result.status !== 'PASS', 'missing recovery evidence was reported complete');
  const measurements = measurementRows(analysis, {...observation.raw, path: join(groupOutput, observation.raw.path)});
  same(published, measurements.filter(row => (cell.requiredMeasurements ?? []).some(rule => rule.name === row.name)), 'published accepted-font rows differ');
  const proof = Object.freeze({}); proofs.set(proof, {binding, measurements}); return proof;
}
