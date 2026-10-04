import {randomBytes} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join, sep} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {attemptIdentity, digest} from './common.mjs';
import {collectAcceptedDocumentFonts, inspectAcceptedDocumentFonts} from './browser-text-fonts.mjs';
import {collectOrdinaryFontInvariant, replayOrdinaryFontInvariant, ordinaryFontInvariantMeasurement, ORDINARY_FONT_INVARIANT_SOURCE_FILES} from './browser-text-invariant.mjs';

export const REOPEN_FONT_NAMES = Object.freeze(['R35CurrentFontFaces', 'R35SingleFontBytes', 'R35CurrentFontSetBytes', 'R35SilentFontSubstitutionCount']);
const proofs = new WeakMap(), SHA = /^sha256:[a-f0-9]{64}$/, SOURCE_SHA = /^[a-f0-9]{64}$/, ID = /^[A-Za-z0-9_-]{1,128}$/, SEQ = /^(0|[1-9][0-9]{0,19})$/;
const id = value => typeof value === 'string' && ID.test(value);
const seq = value => typeof value === 'string' && SEQ.test(value);
const limits = {raw: 4 * 1048576, binding: 128 * 1024};
const demand = (ok, message) => {if (!ok) throw Error('Reopen fonts: ' + message);};
const same = (a, b, message) => demand(isDeepStrictEqual(a, b), message);
const finite = value => Number.isFinite(value) && value >= 0;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
const decode = bytes => JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
const encode = value => Buffer.from(JSON.stringify(value));
const blob = value => exact(value, ['hash', 'byteLength', 'mediaType']) && SHA.test(value.hash) && seq(value.byteLength) && Number(value.byteLength) > 0 && Number(value.byteLength) <= 1048576 && value.mediaType === 'application/json';

/** A separately sealed projection of the actual final imported current graph.
 * No ordinary draft, corpus, preview or seed-to-import ID translation exists. */
export function reopenFontFixtureIdentity(fixture) {
  const text = fixture?.text, native = fixture?.native;
  demand(exact(text, ['schema', 'documentId', 'revision', 'imageState', 'semanticDigest', 'orderedLayerIds']) && text.schema === 'browser-reopen-text-fixture-1' && text.documentId === fixture.documentId && id(text.documentId) && seq(text.revision) && blob(text.imageState) && SHA.test(text.semanticDigest), 'actual portable current document projection required');
  demand(Array.isArray(text.orderedLayerIds) && text.orderedLayerIds.length > 0 && text.orderedLayerIds.length <= 100 && text.orderedLayerIds.every(value => id(value)) && new Set(text.orderedLayerIds).size === text.orderedLayerIds.length, 'complete portable layer order required');
  demand(exact(native, ['schema', 'textFacts', 'fonts', 'fontAssetIds']) && native.schema === 'browser-reopen-native-fixture-1' && Array.isArray(native.textFacts) && native.textFacts.length > 0 && native.textFacts.length <= 100 && Array.isArray(native.fonts) && native.fonts.length > 0 && native.fonts.length <= 16 && Array.isArray(native.fontAssetIds) && native.fontAssetIds.length === native.fonts.length && native.fontAssetIds.every(value => id(value)) && new Set(native.fontAssetIds).size === native.fontAssetIds.length, 'nonempty bounded current native font projection required');
  const layers = new Set(), fonts = new Set();
  for (const fact of native.textFacts) {
    demand(exact(fact, ['layerId', 'sourceHash', 'textHash', 'textBytes', 'layoutHash', 'pixelHash', 'rendererHash', 'fonts']) && id(fact.layerId) && text.orderedLayerIds.includes(fact.layerId) && !layers.has(fact.layerId) && ['sourceHash', 'textHash', 'layoutHash', 'pixelHash', 'rendererHash'].every(key => SHA.test(fact[key])) && Number.isSafeInteger(fact.textBytes) && fact.textBytes >= 0 && fact.textBytes <= 16384 && Array.isArray(fact.fonts) && fact.fonts.length > 0 && fact.fonts.length <= 16 && fact.fonts.every(value => SHA.test(value)), 'bounded unique portable text fact required');
    layers.add(fact.layerId);
  }
  for (const font of native.fonts) {demand(font && SHA.test(font.id) && !fonts.has(font.id), 'unique current typed font identity required'); fonts.add(font.id);}
  // The sealed fixture keeps the full ordered sequences. Binding their exact
  // canonical string-array bytes once per layer admits 100 layers x 16 fonts
  // without enlarging the existing binding envelope or truncating the graph.
  const compact = {...native, schema: 'browser-reopen-native-binding-1', textFacts: native.textFacts.map(({fonts, ...fact}) =>
    ({...fact, fontSequenceHash: digest(JSON.stringify(fonts)), fontCount: fonts.length}))};
  const result = {text, native: compact}; demand(encode(result).length <= 112 * 1024, 'portable font binding capacity exceeded');
  return structuredClone(result);
}
export function reopenFontOutcome(result) {
  return result ? Object.fromEntries(['documentId', 'acceptedTestEdit', 'startupBoundary', 'publicOpenCompleted', 'viewportAsset', 'authoritativeDOMReadyMs'].map(key => [key, result[key]])) : null;
}
function inspectFixtureClosure(fonts, fixture, invariant) {
  const {text, native} = fixture;
  demand(fonts.before.documentId === text.documentId, 'current document differs from portable fixture');
  same(fonts.before.imageState, text.imageState, 'current image differs from portable fixture');
  same(fonts.before.semanticDigest, text.semanticDigest, 'current semantic graph differs from portable fixture');
  same(fonts.before.orderedLayerIds, text.orderedLayerIds, 'complete current order differs from portable fixture');
  const observed = fonts.layers.filter(layer => layer.kind === 'text'); demand(observed.length === native.textFacts.length, 'missing or extra current text layer');
  same([...fonts.fonts].sort((a, b) => a.id.localeCompare(b.id)), [...native.fonts].sort((a, b) => a.id.localeCompare(b.id)), 'actual current typed font union differs');
  const fontById = new Map(fonts.fonts.map(font => [font.id, font]));
  for (const fact of native.textFacts) {
    const layer = observed.find(value => value.id === fact.layerId);
    demand(layer && layer.source.hash === fact.sourceHash && layer.textHash === fact.textHash && layer.rasterHash === fact.pixelHash && layer.renderer.id === fact.rendererHash, 'current accepted text source differs from portable fixture');
    demand(layer.fontIds.length === fact.fontCount, 'current font sequence length differs from portable fixture');
    same(digest(JSON.stringify(layer.fontIds.map(id => fontById.get(id)?.bytes.hash))), fact.fontSequenceHash, 'current ordered font bytes differ from portable fixture');
    // The exact source hash commits to the layout/text refs. Independent
    // production replay checks that source and every referenced immutable byte.
    if (invariant) {
      demand(invariant.members.some(member => member.ref.hash === fact.layoutHash) && invariant.members.some(member => member.ref.hash === fact.textHash && member.bytes === fact.textBytes), 'retained layout/text bytes differ from portable fixture');
    }
  }
  demand(fonts.files.every(file => native.fontAssetIds.includes(file.assetId)), 'font locator differs from portable current graph');
}

/** Bounded structural replay grants no source/runtime or physical authority. */
export function inspectReopenFontRaw(raw, binding, {fontInvariantProof} = {}) {
  const measurements = [], missing = [], failures = [];
  demand(exact(raw, ['kind', 'nonce', 'binding', 'clock', 'startedMs', 'endedMs', 'actionStartedMs', 'actionEndedMs', 'priorRealm', 'afterRealm', 'navigations', 'navigationCount', 'checkpoint', 'fonts', 'outcome', 'failed', 'fontInvariant', 'missing']) && raw.kind === 'reopen-font-raw-1' && raw.nonce === binding.nonce && raw.clock === 'runner-monotonic' && typeof raw.failed === 'boolean' && Array.isArray(raw.missing) && raw.missing.length <= 32 && raw.missing.every(value => typeof value === 'string' && value.length <= 256), 'bounded raw shape differs');
  same(raw.binding, binding.attempt, 'raw attempt differs'); missing.push(...raw.missing);
  if (raw.failed) missing.push('Original portable reopen did not complete');
  if (!raw.priorRealm || !raw.afterRealm || !raw.fonts || !raw.outcome || !raw.checkpoint) missing.push('Original navigation, accepted checkpoint or current font closure is incomplete');
  if (missing.length) return {kind: 'reopen-font-analysis-1', qualification: false, acceptedDocumentOnly: true, draftRendering: false, physicalPresentation: false, measurements, missing: [...new Set(missing)], failures};
  try {
    demand([raw.startedMs, raw.endedMs, raw.actionStartedMs, raw.actionEndedMs].every(finite) && raw.startedMs <= raw.actionStartedMs && raw.actionStartedMs <= raw.actionEndedMs && raw.actionEndedMs <= raw.endedMs, 'original runner action bracket differs');
    demand(raw.navigationCount === 1 && Array.isArray(raw.navigations) && raw.navigations.length === 1 && finite(raw.navigations[0]) && raw.navigations[0] >= raw.actionStartedMs && raw.navigations[0] <= raw.actionEndedMs, 'exactly one original main-frame navigation required');
    for (const realm of [raw.priorRealm, raw.afterRealm]) demand(exact(realm, ['timeOrigin', 'atMs']) && finite(realm.timeOrigin) && realm.timeOrigin > 0 && finite(realm.atMs), 'actual browser realm required');
    demand(raw.afterRealm.timeOrigin > raw.priorRealm.timeOrigin && raw.fonts.timeOrigin === raw.afterRealm.timeOrigin && raw.fonts.endMs <= raw.afterRealm.atMs, 'accepted fonts are not in the original fresh realm');
    const outcome = raw.outcome, checkpoint = raw.checkpoint;
    demand(exact(outcome, ['documentId', 'acceptedTestEdit', 'startupBoundary', 'publicOpenCompleted', 'viewportAsset', 'authoritativeDOMReadyMs']) && outcome.documentId === binding.fixture.text.documentId && outcome.acceptedTestEdit === true && outcome.startupBoundary === 'document-ready-via-Open' && outcome.publicOpenCompleted === true && typeof outcome.viewportAsset === 'string' && outcome.viewportAsset.length <= 128 && finite(outcome.authoritativeDOMReadyMs) && outcome.authoritativeDOMReadyMs >= raw.actionStartedMs && outcome.authoritativeDOMReadyMs <= raw.actionEndedMs, 'original public reopen result differs');
    demand(exact(checkpoint, ['commandId', 'documentId', 'status', 'observedDurableReceiptMs', 'replyObservedMs', 'expectedDocumentRevision', 'documentRevision', 'transactionId']) && id(checkpoint.commandId) && id(checkpoint.transactionId) && checkpoint.documentId === outcome.documentId && checkpoint.status === 'accepted' && seq(checkpoint.expectedDocumentRevision) && seq(checkpoint.documentRevision) && BigInt(checkpoint.expectedDocumentRevision) >= BigInt(binding.fixture.text.revision) && BigInt(checkpoint.documentRevision) >= BigInt(checkpoint.expectedDocumentRevision) && checkpoint.documentRevision === raw.fonts.before?.revision && finite(checkpoint.replyObservedMs) && checkpoint.replyObservedMs >= raw.actionStartedMs && checkpoint.replyObservedMs <= raw.actionEndedMs && finite(checkpoint.observedDurableReceiptMs) && checkpoint.observedDurableReceiptMs >= raw.actionEndedMs && checkpoint.observedDurableReceiptMs <= raw.endedMs, 'original checkpoint accepted revision and receipt unavailable');
    const accepted = inspectAcceptedDocumentFonts(raw.fonts, binding.attempt);
    if (accepted.missing.length || accepted.measurements.length !== 3) missing.push(...accepted.missing, 'Complete accepted post-reopen font closure required');
    else {
      inspectFixtureClosure(raw.fonts, binding.fixture, raw.fontInvariant);
      measurements.push(...accepted.measurements);
      const invariant = ordinaryFontInvariantMeasurement({fonts: raw.fonts, evidence: raw.fontInvariant, proof: fontInvariantProof});
      if (invariant) measurements.push({...invariant, method: 'Actual accepted current document after the original portable navigation, Open and checkpoint; exact fixture-associated text sources, layouts, text and font bytes replayed through production validators, hidden layers included. No preview, native display, resource peak or physical-presentation claim.'});
      else missing.push('Accepted reopened closure lacks immutable source/layout/text/font replay');
    }
  } catch (error) {failures.push(error.message);}
  return {kind: 'reopen-font-analysis-1', qualification: false, acceptedDocumentOnly: true, draftRendering: false, physicalPresentation: false, measurements: failures.length ? [] : measurements, missing: [...new Set(missing)], failures};
}
function measurementRows(analysis, artifact) {return analysis.measurements.map(row => ({...row, evidence: [{kind: 'reopen-font-retained-observation-1', artifact}]}));}
export function reopenFontMeasurement({cell, sample, rule, proof}) {
  const value = proof && proofs.get(proof);
  if (!value || cell?.operation !== 'portable.reopen' || !isDeepStrictEqual(value.binding.attempt, {cellId: cell.id, id: attemptIdentity(cell, sample.cache, sample.ordinal, sample.prime), cache: sample.cache, ordinal: sample.ordinal, prime: Boolean(sample.prime), serial: value.binding.attempt.serial})) return {reason: 'Current owned portable reopen font proof unavailable'};
  const row = value.measurements.find(item => item.name === rule.name);
  return row && rule.budgetId === 'R35' && rule.unit === row.unit ? {measurement: structuredClone(row)} : {reason: 'Exact accepted reopen font registry row is unavailable'};
}

async function readCheckpoint(page, command, signal) {
  const nonce = randomBytes(16).toString('hex'); signal?.throwIfAborted();
  const cancel = () => {void page.evaluate(n => globalThis.__IDEOGRAM_REOPEN_CHECKPOINT_READS__?.get(n)?.abort(), nonce).catch(() => {});};
  signal?.addEventListener('abort', cancel, {once: true});
  try {
    await page.evaluate(n => {const owners = globalThis.__IDEOGRAM_REOPEN_CHECKPOINT_READS__ ??= new Map(); if (owners.size) throw Error('REOPEN_CHECKPOINT_BUSY'); owners.set(n, new AbortController());}, nonce);
    signal?.throwIfAborted();
    const receipt = await page.evaluate(async ({nonce, commandId, transactionId}) => {
      const owners = globalThis.__IDEOGRAM_REOPEN_CHECKPOINT_READS__, aborter = owners?.get(nonce); if (!aborter || owners.size !== 1) throw Error('REOPEN_CHECKPOINT_OWNER');
      const timeout = setTimeout(() => aborter.abort(), 30000); let response, reader;
      try {
        response = await fetch('/api/v1/commands/' + commandId, {credentials: 'same-origin', headers: {'X-App-Client': 'LP-1'}, cache: 'no-store', redirect: 'error', signal: aborter.signal});
        if (response.status !== 200 || !response.body || response.body.locked) throw Error('REOPEN_CHECKPOINT_READ');
        const length = response.headers.get('content-length'); if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > 65536)) throw Error('REOPEN_CHECKPOINT_BOUND');
        const bytes = new Uint8Array(65536); let offset = 0; reader = response.body.getReader();
        for (;;) {aborter.signal.throwIfAborted(); const item = await reader.read(); if (item.done) break; if (!(item.value instanceof Uint8Array) || offset + item.value.length > bytes.length) throw Error('REOPEN_CHECKPOINT_BOUND'); bytes.set(item.value, offset); offset += item.value.length;}
        const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(0, offset))).receipt;
        if (value?.status !== 'accepted' || value.commandId !== commandId || value.transactionId !== transactionId || !/^(0|[1-9][0-9]{0,19})$/.test(value.documentRevision ?? '')) throw Error('REOPEN_CHECKPOINT_NOT_ACCEPTED');
        return {commandId: value.commandId, status: value.status, transactionId: value.transactionId, documentRevision: value.documentRevision};
      } finally {
        try {if (reader) {try {await reader.cancel();} finally {reader.releaseLock();}} else if (response?.body && !response.body.locked) await response.body.cancel();}
        finally {clearTimeout(timeout); aborter.abort(); owners.delete(nonce); if (!owners.size) delete globalThis.__IDEOGRAM_REOPEN_CHECKPOINT_READS__;}
      }
    }, {nonce, commandId: command.commandId, transactionId: command.transactionId});
    signal?.throwIfAborted(); return {...receipt, documentId: command.documentId, expectedDocumentRevision: command.expectedDocumentRevision, replyObservedMs: command.replyObservedMs, observedDurableReceiptMs: performance.now()};
  } finally {
    signal?.removeEventListener('abort', cancel);
    await page.evaluate(n => {const owners = globalThis.__IDEOGRAM_REOPEN_CHECKPOINT_READS__, owner = owners?.get(n); if (owner) {owner.abort(); owners.delete(n); if (!owners.size) delete globalThis.__IDEOGRAM_REOPEN_CHECKPOINT_READS__;}}, nonce).catch(() => {});
  }
}

/** The original action runs once, unmodified. All document/font reads occur
 * after its authoritative endpoint; there is no pre-action editor requirement. */
export function createReopenFontObserver({page, repo, root, cell, sample, serial, fixture, runtime, environment, processIdentity, output, signal, journal}) {
  demand(cell.operation === 'portable.reopen', 'portable reopen cell required');
  const nonce = randomBytes(16).toString('hex'), prefix = 'reopen-font-' + nonce;
  const binding = {kind: 'reopen-font-binding-1', nonce, operation: cell.operation,
    attempt: {cellId: cell.id, id: attemptIdentity(cell, sample.cache, sample.ordinal, sample.prime), cache: sample.cache, ordinal: sample.ordinal, prime: Boolean(sample.prime), serial},
    fixtureSeal: fixture.seal, fixture: reopenFontFixtureIdentity(fixture), environment, processIdentity, runtime};
  const raw = {kind: 'reopen-font-raw-1', nonce, binding: binding.attempt, clock: 'runner-monotonic', startedMs: performance.now(), endedMs: null,
    actionStartedMs: null, actionEndedMs: null, priorRealm: null, afterRealm: null, navigations: [], navigationCount: 0, checkpoint: null, fonts: null, outcome: null, failed: true, fontInvariant: null, missing: []};
  let observing = false, observed = false, finished = false, fontInvariantProof;
  const missing = code => {if (!raw.missing.includes(code)) raw.missing.push(code);};
  return {
    async navigation(action) {
      demand(!observing && !observed && !finished, 'one original reopen observation required'); observing = true; observed = true;
      let command = null, requestOwner = null, requestCount = 0, responseCount = 0;
      const navigation = frame => {if (frame === page.mainFrame()) {raw.navigationCount++; if (raw.navigations.length < 2) raw.navigations.push(performance.now());}};
      const request = value => {
        try {
          if (value.method() !== 'POST' || new URL(value.url()).pathname !== '/api/v1/commands') return;
          const body = value.postData(); if (typeof body !== 'string' || body.length > 65536) {missing('reopen-command-body-unavailable'); return;}
          const candidate = JSON.parse(body)?.command; if (candidate?.body?.type !== 'SaveCheckpoint') return;
          requestCount++; if (requestCount !== 1 || !id(candidate.commandId) || !id(candidate.transactionId) || !seq(candidate.expectedDocumentRevision ?? '') || candidate.documentId !== fixture.documentId) {missing('reopen-checkpoint-request-differs'); return;}
          command = {commandId: candidate.commandId, documentId: candidate.documentId, expectedDocumentRevision: candidate.expectedDocumentRevision, transactionId: candidate.transactionId, replyObservedMs: null}; requestOwner = value;
        } catch {missing('reopen-checkpoint-request-unavailable');}
      };
      const response = value => {try {if (requestOwner && value.request() === requestOwner) {responseCount++; if (responseCount !== 1 || ![200, 202].includes(value.status())) missing('reopen-checkpoint-response-differs'); else command.replyObservedMs = performance.now();}} catch {missing('reopen-checkpoint-response-unavailable');}};
      try {raw.priorRealm = await page.evaluate(() => ({timeOrigin: performance.timeOrigin, atMs: performance.now()}));} catch {missing('reopen-prior-realm-unavailable');}
      page.on('framenavigated', navigation); page.on('request', request); page.on('response', response);
      raw.actionStartedMs = performance.now();
      try {const result = await action(); raw.outcome = reopenFontOutcome(result); raw.failed = false; return result;}
      finally {
        raw.actionEndedMs = performance.now(); page.off('request', request); page.off('response', response);
        try {
          if (raw.failed) missing('original-reopen-action-failed');
          else {
            if (requestCount === 1 && responseCount === 1 && command) {try {raw.checkpoint = await readCheckpoint(page, command, signal);} catch {missing('reopen-checkpoint-accepted-receipt-unavailable');}}
            else missing('single-original-reopen-checkpoint-unavailable');
            try {
              raw.fonts = await collectAcceptedDocumentFonts({page, documentId: fixture.documentId, fontAssetIds: fixture.native.fontAssetIds, binding: binding.attempt, signal});
              const invariant = await collectOrdinaryFontInvariant({repo, root, fonts: raw.fonts, nonce, output, signal}); raw.fontInvariant = invariant.evidence; fontInvariantProof = invariant.proof;
            } catch {missing('reopen-accepted-font-closure-unavailable');}
          }
          try {raw.afterRealm = await page.evaluate(() => ({timeOrigin: performance.timeOrigin, atMs: performance.now()}));} catch {missing('reopen-final-realm-unavailable');}
        } finally {page.off('framenavigated', navigation); observing = false;}
      }
    },
    async finish({failed = false} = {}) {
      demand(!observing && !finished, 'reopen observer must settle'); finished = true; raw.failed ||= failed; raw.endedMs = performance.now();
      const retain = async (name, value, maximum) => {const bytes = encode(value); demand(bytes.length <= maximum, 'retained artifact bound'); const path = prefix + '-' + name + '.json'; await writeFile(join(output, path), bytes, {mode: 0o600, flag: 'wx'}); return {path, bytes: bytes.length, sha256: digest(bytes)};};
      const bindingArtifact = await retain('binding', binding, limits.binding), artifact = await retain('raw', raw, limits.raw);
      const analysis = inspectReopenFontRaw(raw, binding, {fontInvariantProof});
      const observation = {kind: 'reopen-font-observation-1', nonce, binding: bindingArtifact, raw: artifact, analysis, qualification: false, acceptedDocumentOnly: true};
      const measurements = measurementRows(analysis, {...artifact, path: join(output, artifact.path)}), proof = Object.freeze({}); proofs.set(proof, {binding, measurements});
      await journal?.({event: 'reopen-font-observed', cellId: cell.id, nonce, binding: bindingArtifact, raw: artifact}); return {proof, observation};
    },
  };
}

/** Replay exact retained source/native/attempt evidence before any publication. */
export async function verifyReopenFontEvidence({attempt, cell, serial, fixture, environment, workerProcessIdentity, groupOutput, retainedFiles, readRetained, controlFiles, sourceFiles, sourceRoot, browserCache, tools, developerState, developerStateIdentity, journalEvents}) {
  if (cell?.operation !== 'portable.reopen') return null;
  const observation = attempt.result?.observations?.reopenFonts;
  const published = (attempt.result?.measurements ?? []).filter(row => REOPEN_FONT_NAMES.includes(row.name));
  if (!observation) {demand(!published.length && attempt.status !== 'PASS' && attempt.result?.status !== 'PASS', 'reopen measurements or PASS lack retained observation'); return null;}
  demand(observation.kind === 'reopen-font-observation-1' && observation.qualification === false && observation.acceptedDocumentOnly === true && /^[a-f0-9]{32}$/.test(observation.nonce ?? ''), 'observation scope or nonce differs');
  const seals = new Map(retainedFiles.map(file => [file.path, file])), prefix = 'reopen-font-' + observation.nonce;
  const read = async (identity, name, maximum) => {
    demand(identity?.path === prefix + '-' + name + '.json' && Number.isSafeInteger(identity.bytes) && identity.bytes > 0 && identity.bytes <= maximum && SHA.test(identity.sha256), 'retained member differs');
    const seal = seals.get(identity.path); demand(seal?.bytes === identity.bytes && seal.sha256 === identity.sha256, 'outer seal differs');
    const bytes = await readRetained(identity.path, {maximum}); demand(bytes.length === identity.bytes && digest(bytes) === identity.sha256, 'retained bytes differ'); return decode(bytes);
  };
  const binding = await read(observation.binding, 'binding', limits.binding), raw = await read(observation.raw, 'raw', limits.raw);
  demand(exact(binding, ['kind', 'nonce', 'operation', 'attempt', 'fixtureSeal', 'fixture', 'environment', 'processIdentity', 'runtime']) && binding.kind === 'reopen-font-binding-1' && binding.nonce === observation.nonce && binding.operation === cell.operation, 'binding differs');
  same(binding.attempt, {cellId: cell.id, id: attempt.id, cache: attempt.cache, ordinal: attempt.ordinal, prime: attempt.prime, serial}, 'scheduled attempt differs');
  same(binding.fixtureSeal, fixture.seal, 'fixture seal differs'); same(binding.fixture, reopenFontFixtureIdentity(fixture), 'sealed portable current graph differs');
  same(binding.environment, environment, 'source/build identity differs'); same(binding.processIdentity, workerProcessIdentity, 'worker differs');
  demand(workerProcessIdentity?.node === 'v26.10.0' && workerProcessIdentity.pid > 1 && finite(attempt.startMs) && finite(attempt.endMs) && finite(raw.startedMs) && finite(raw.endedMs) && raw.startedMs >= attempt.startMs && raw.endedMs <= attempt.endMs, 'worker clock window differs');
  // core.sourceIdentity supplies bare source/control hashes. Build, tool and
  // retained-artifact identities use common.digest's explicit sha256 prefix.
  demand(['sourceDigest', 'controlDigest'].every(key => SOURCE_SHA.test(environment?.[key] ?? '')) &&
    ['buildDigest', 'toolsDigest'].every(key => SHA.test(environment?.[key] ?? '')), 'Reopen font executable bindings missing');
  for (const name of ['browser.mjs', 'browser-driver.mjs', 'browser-reopen-fonts.mjs', 'browser-text-fonts.mjs', 'browser-text-invariant.mjs', 'browser-text-resources.mjs', 'fixture-portable.mjs', 'fixtures.mjs', 'browser-measurements.mjs', 'worker.mjs', 'run.mjs', 'verification.mjs']) demand(controlFiles?.some(file => file.path === 'tooling/qualification/campaigns/' + name && SOURCE_SHA.test(file.sha256)), 'Reopen font control source closure missing: ' + name);
  for (const name of ['src/ui/native-text.ts', 'src/ui/shell.ts', 'src/state/editor-client.ts', 'src/observability/browser.ts', 'src/observability/navigation-observations.ts']) demand(sourceFiles?.some(file => file.path === name && SOURCE_SHA.test(file.sha256)), 'Reopen font application source closure missing: ' + name);
  demand(controlFiles?.some(file => file.path === 'tooling/qualification/evidence-volume.mjs' && SOURCE_SHA.test(file.sha256)), 'Ordinary font invariant evidence allocation control closure missing');
  for (const name of ORDINARY_FONT_INVARIANT_SOURCE_FILES) demand(sourceFiles?.some(file => file.path === name && SOURCE_SHA.test(file.sha256)), 'Ordinary font invariant validator source closure missing: ' + name);
  const runtime = decode(await readRetained('browser-runtime.json', {maximum: 1024 * 1024})); same(binding.runtime, runtime, 'Reopen font actual browser differs'); same(runtime.fixtureSeal, fixture.seal, 'Reopen font browser fixture differs');
  demand(runtime.ownedLaunch?.context?.createdBy === 'browser.newContext' && runtime.browserPid > 1 && runtime.backendPid > 1 && runtime.playwrightModule?.startsWith(join(sourceRoot, 'node_modules') + sep) && runtime.executable?.startsWith(browserCache + sep), 'Reopen font owned browser path differs');
  const pins = tools?.browserPins?.browsers?.filter(pin => pin.name === runtime.engine);
  demand(pins?.length === 1 && pins[0].revision === runtime.revision && pins[0].browserVersion === runtime.version && SHA.test(runtime.executableIdentity?.sha256 ?? ''), 'Reopen font browser version pin differs');
  demand(developerState?.kind === 'developer-runtime-state-1' && digest(JSON.stringify(developerState.state, null, 2) + '\n').slice(7) === developerState.sha256?.replace(/^sha256:/, '') && SHA.test(developerStateIdentity?.sha256 ?? ''), 'Reopen font prepared executable evidence is missing');
  const state = developerState.state, workspace = state.h?.source === sourceRoot ? state.h : state.p;
  const completed = workspace === state.h ? workspace?.completed === true : workspace?.completed?.includes('production-build') && workspace.completed.includes('browser-cache');
  demand(completed && !workspace.failure && !workspace.active && state.productRepo === sourceRoot && workspace.source === sourceRoot && state.sourceDigest === environment.sourceDigest, 'Reopen font prepared source differs');
  const selectedCache = state.playwrightBrowsersPath ?? workspace.browserCache, prepared = workspace.browserIdentity?.engines?.filter(value => value.engine === runtime.engine);
  demand(selectedCache === browserCache && prepared?.length === 1 && prepared[0].executable === runtime.executable && prepared[0].version === runtime.version && prepared[0].revision === runtime.revision &&
    prepared[0].bytes === runtime.executableIdentity.bytes && prepared[0].sha256?.replace(/^sha256:/, '') === runtime.executableIdentity.sha256.slice(7), 'Reopen font browser immutable preparation differs');
  for (const kind of ['browser', 'backend']) {
    const pid = runtime[kind + 'Pid'], entries = retainedFiles.filter(file => new RegExp('^owned-process-' + pid + '-[a-f0-9-]{36}\\.json$').test(file.path));
    demand(entries.length === 1, 'Reopen font process ownership missing'); const record = decode(await readRetained(entries[0].path, {maximum: 65536})), process = record.processes?.[0];
    demand(record.ownerPid === workerProcessIdentity.pid && record.kind === 'perf-owned-processes-1' && record.processes?.length === 1 && process.kind === kind && process.pid === pid && process.pgid > 1, 'Reopen font process ownership differs');
    if (kind === 'browser') demand(runtime.ownedLaunch.process?.registration?.path === join(groupOutput, entries[0].path) && runtime.ownedLaunch.process?.startedAtIdentity === process.startedAtIdentity && process.executable === runtime.executable, 'Reopen font browser launch differs');
  }
  const events = journalEvents.filter(event => event.event === 'reopen-font-observed' && event.nonce === observation.nonce && event.cellId === cell.id);
  demand(events.length === 1 && events[0].monotonicMs >= raw.endedMs && events[0].monotonicMs <= attempt.endMs, 'journal closure differs');
  same(events[0].binding, observation.binding, 'journal binding differs'); same(events[0].raw, observation.raw, 'journal raw differs');
  if (raw.outcome) same(raw.outcome, reopenFontOutcome(attempt.result?.observations), 'published original reopen outcome differs');
  if (raw.checkpoint) {
    const replies = (attempt.result?.evidence?.observedCommandReceipts ?? []).filter(receipt => receipt.commandId === raw.checkpoint.commandId);
    // The shared recorder timestamps completion of asynchronous JSON decoding;
    // the passive response event above is the original action boundary witness.
    demand(replies.length === 1 && finite(replies[0].observedMs) && replies[0].observedMs >= raw.checkpoint.replyObservedMs && replies[0].observedMs <= attempt.endMs,
      'original attempt lacks its independently observed checkpoint response');
  }
  const fontInvariantProof = raw.fontInvariant ? await replayOrdinaryFontInvariant({repo: sourceRoot, fonts: raw.fonts, nonce: binding.nonce, output: groupOutput,
    evidence: raw.fontInvariant, readRetained, retainedFiles}) : undefined;
  const analysis = inspectReopenFontRaw(raw, binding, {fontInvariantProof}); same(analysis, observation.analysis, 'retained analysis differs');
  demand(!analysis.failures.length || attempt.status === 'FAIL' && attempt.result.status === 'FAIL', 'accepted-state contradiction was not reported as failure');
  demand(!analysis.missing.length || attempt.status !== 'PASS' && attempt.result.status !== 'PASS', 'missing reopen evidence was reported complete');
  const measurements = measurementRows(analysis, {...observation.raw, path: join(groupOutput, observation.raw.path)});
  same(published, measurements.filter(row => (cell.requiredMeasurements ?? []).some(rule => rule.name === row.name)), 'published accepted-font rows differ');
  const proof = Object.freeze({}); proofs.set(proof, {binding, measurements}); return proof;
}
