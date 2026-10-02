import {isDeepStrictEqual} from 'node:util';
import {isAbsolute, join, sep} from 'node:path';
import {buildNativeImePlan, inspectNativeImeTrace} from './native-ime-contract.mjs';
import {nativeImeHash, nativeImeJSON, nativeImeSelection, inspectNativeImeOperator, inspectNativeImeReview, NATIVE_IME_LIMITS} from './native-ime-authority.mjs';

const proofs = new WeakMap();
// Conservative admission tolerance for rounded browser epoch timestamps. This
// is not an observed precision, latency bound, or physical clock authority.
export const NATIVE_IME_EPOCH_FRESHNESS_TOLERANCE_MS = 100;
const demand = (condition, message) => {if (!condition) throw Error(message);};
const same = (a, b, message) => demand(isDeepStrictEqual(a, b), message);
const pin = value => /^sha256:[a-f0-9]{64}$/.test(value ?? '');
const decode = bytes => JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
export function isNativeImeEvidencePath(path) {return /(?:^|\/)native-ime-[a-f0-9]{32}\/(?:operator|review)-evidence-[0-3]\.record$/.test(path);}
/** Process-local authority is issued only after exact retained-byte replay.
 * It proves the externally reviewed native compatibility session, no physical
 * paint, scanout, INP, language distribution or independent guard branches. */
export function evaluateNativeImeProof(proof, observation) {
  const entry = proof && proofs.get(proof);
  if (!entry || !isDeepStrictEqual(entry.observation, observation)) return {outcome: 'INCONCLUSIVE', missing: ['Fresh authoritative native IME retained-byte replay']};
  return {outcome: 'PASS', authority: 'external-independent-operator-review', nativeCompatibility: true, qualification: false, physicalPresentation: false, scanout: false, observation: entry.trace};
}

export async function verifyNativeImeEvidence({attempt, cell, serial, configuration, groupOutput, retainedPaths, retainedFiles, readRetained, fixture, workerProcessIdentity, sourceRoot, engine, developerState, developerStateIdentity, browserCache, tools, environment, controlFiles, journalEvents}) {
  const observation = attempt?.result?.observations?.nativeIme;
  if (cell?.operation !== 'text.native-ime' || !observation?.reviewReceipt || !observation.raw || !observation.binding || !observation.plan || !observation.review || !observation.seal || attempt.status === 'FAIL') return null;
  demand(observation.kind === 'native-ime-observation-1' && observation.qualification === false && observation.physicalPresentation === false, 'Native IME observation scope differs');
  const selected = nativeImeSelection(configuration?.browser?.nativeIme, cell.workload);
  demand(attempt.cache === 'cold' && attempt.ordinal === 1 && attempt.prime === false && serial === 1 && attempt.id === cell.id + '/cold/scored/1' && attempt.reset?.status === 'PASS' && attempt.reset.cache === 'cold' && !attempt.reset.missing?.length, 'Native IME fresh attempt/reset differs');
  demand(Number.isFinite(attempt.startMs) && Number.isFinite(attempt.endMs) && attempt.endMs >= attempt.startMs, 'Native IME journal action window missing');
  demand(/^[a-f0-9]{32}$/.test(observation.nonce ?? '') && isAbsolute(groupOutput ?? ''), 'Native IME nonce or original group unavailable');
  const prefix = 'native-ime-' + observation.nonce + '/', paths = new Set(retainedPaths), seals = new Map(retainedFiles.map(file => [file.path, file]));
  async function bytes(identity, maximum, expectedName) {
    demand(identity?.path === prefix + expectedName && paths.has(identity.path), 'Native IME member leaves its attempt or is missing');
    demand(Number.isSafeInteger(identity.bytes) && identity.bytes > 0 && identity.bytes <= maximum && pin(identity.sha256), 'Native IME member exceeds its read bound');
    const outer = seals.get(identity.path);
    demand(outer?.bytes === identity.bytes && outer.sha256 === identity.sha256, 'Native IME member differs from outer seal');
    const value = await readRetained(identity.path, {maximum});
    demand(value.length === identity.bytes && nativeImeHash(value) === identity.sha256, 'Native IME original bytes differ');
    return value;
  }
  const binding = decode(await bytes(observation.binding, NATIVE_IME_LIMITS.json, 'binding.json'));
  demand(binding.kind === 'native-ime-binding-1', 'Native IME binding version differs');
  same(binding.attempt, {cellId: cell.id, id: attempt.id, cache: 'cold', ordinal: 1, prime: false, serial}, 'Native IME binding attempt differs');
  same(binding.processIdentity, workerProcessIdentity, 'Native IME worker differs');
  demand(workerProcessIdentity?.node === 'v26.10.0' && workerProcessIdentity.pid > 1 && Number.isFinite(Date.parse(workerProcessIdentity.startedAt)), 'Native IME worker identity unavailable');
  same(binding.environment, environment, 'Native IME executable or host environment differs');
  demand(pin(environment?.sourceDigest) && pin(environment?.buildDigest) && pin(environment?.toolsDigest) && pin(environment?.controlDigest), 'Native IME source/build/tool binding missing');
  for (const name of ['browser.mjs', 'browser-text.mjs', 'browser-native-ime.mjs', 'browser-native-ime-observer.mjs', 'native-ime-contract.mjs', 'native-ime-authority.mjs', 'native-ime-verification.mjs', 'worker.mjs', 'run.mjs', 'verification.mjs']) demand(controlFiles?.some(file => file.path === 'tooling/qualification/campaigns/' + name && pin(file.sha256)), 'Native IME executed source closure missing: ' + name);
  demand(binding.acceptedBefore?.documentId === fixture.text.documentId && binding.acceptedBefore?.layerId === fixture.text.activeLayerId && binding.acceptedBefore?.sourceHash === fixture.text.corpus.sha256, 'Native IME accepted state belongs to another fixture document/layer/text');
  same(binding.fixtureSeal, fixture.seal, 'Native IME fixture differs');
  same(binding.selection, selected, 'Native IME consumed operator selection differs');
  const plan = buildNativeImePlan(fixture, cell.workload);
  same(decode(await bytes(observation.plan, NATIVE_IME_LIMITS.json, 'plan.json')), plan, 'Native IME sealed plan differs from original corpus contract');
  same(binding.plan, observation.plan, 'Native IME binding plan differs');
  const runtime = decode(await readRetained('browser-runtime.json', {maximum: 1024 * 1024}));
  same(binding.runtime, runtime, 'Native IME actual browser differs');
  demand(runtime.headless === false && runtime.engine === engine && runtime.browserPid > 1 && runtime.ownedLaunch?.context?.createdBy === 'browser.newContext' && runtime.ownedLaunch.context.freshAtLaunch === true && runtime.playwrightModule?.startsWith(join(sourceRoot, 'node_modules') + sep), 'Native IME owned headed browser unavailable');
  same(runtime.fixtureSeal, fixture.seal, 'Native IME browser fixture differs');
  if (!developerState || !developerStateIdentity) return null;
  demand(developerState.kind === 'developer-runtime-state-1' && nativeImeHash(nativeImeJSON(developerState.state)).slice(7) === developerState.sha256?.replace(/^sha256:/, '') && pin(developerStateIdentity.sha256), 'Native IME consumed browser preparation differs');
  const state = developerState.state, workspace = state.h?.source === sourceRoot ? state.h : state.p;
  const completed = workspace === state.h ? workspace?.completed === true : workspace?.completed?.includes('production-build') && workspace.completed.includes('browser-cache');
  demand(completed && !workspace.failure && !workspace.active && state.productRepo === sourceRoot && workspace.source === sourceRoot && state.sourceDigest === environment.sourceDigest, 'Native IME prepared source unavailable');
  const cache = state.playwrightBrowsersPath ?? workspace.browserCache, prepared = workspace.browserIdentity?.engines?.filter(value => value.engine === engine), tool = tools?.browserPins?.browsers?.filter(value => value.name === engine);
  demand(isAbsolute(cache ?? '') && browserCache === cache && runtime.executable?.startsWith(cache + sep) && prepared?.length === 1 && tool?.length === 1, 'Native IME prepared browser selection differs');
  demand([prepared[0], runtime.executableIdentity].every(value => Number.isSafeInteger(value?.bytes) && value.bytes > 0 && /^(?:sha256:)?[a-f0-9]{64}$/.test(value.sha256 ?? '')), 'Native IME actual/prepared browser immutable identity missing');
  demand(prepared[0].executable === runtime.executable && prepared[0].version === runtime.version && prepared[0].revision === runtime.revision && prepared[0].bytes === runtime.executableIdentity?.bytes && prepared[0].sha256?.replace(/^sha256:/, '') === runtime.executableIdentity?.sha256?.replace(/^sha256:/, '') && tool[0].revision === runtime.revision && tool[0].browserVersion === runtime.version, 'Native IME actual browser does not match pinned preparation');
  for (const kind of ['browser', 'backend']) {
    const pid = runtime[kind + 'Pid'], registrations = retainedPaths.filter(path => new RegExp('^owned-process-' + pid + '-[a-f0-9-]{36}\\.json$').test(path));
    if (registrations.length !== 1) return null;
    const registration = decode(await readRetained(registrations[0], {maximum: 65536})), process = registration.processes?.[0];
    demand(registration.kind === 'perf-owned-processes-1' && registration.ownerPid === workerProcessIdentity.pid && registration.processes?.length === 1 && process.kind === kind && process.pid === pid && process.pgid > 1 && typeof process.startedAtIdentity === 'string' && process.startedAtIdentity.length > 0, 'Native IME owned process registration differs');
    if (kind === 'browser') demand(process.executable === runtime.executable && runtime.ownedLaunch.process?.pid === pid && runtime.ownedLaunch.process?.startedAtIdentity === process.startedAtIdentity && runtime.ownedLaunch.process?.registration?.path === join(groupOutput, registrations[0]), 'Native IME launch registration differs');
  }
  const operator = decode(await bytes(binding.operator, NATIVE_IME_LIMITS.json, 'operator.json'));
  if (inspectNativeImeOperator(operator, plan).status !== 'PASS') return null;
  demand(operator.os.version === environment.host.osVersion && operator.os.build === environment.host.osBuild && environment.host.platform === 'darwin', 'Native IME independently observed OS differs from operator evidence');
  async function evidence(original, retained, prefixName) {
    demand(Array.isArray(retained) && retained.length === original.length, 'Native IME external evidence inventory differs');
    for (const [index, row] of original.entries()) {
      const copy = retained[index]; demand(copy.originalPath === row.path && copy.sha256 === row.sha256 && copy.bytes === row.bytes, 'Native IME original evidence pin differs');
      await bytes(copy, NATIVE_IME_LIMITS.evidence, prefixName + '-' + index + '.record');
    }
  }
  await evidence(operator.evidence, binding.operatorEvidence, 'operator-evidence');
  const raw = decode(await bytes(observation.raw, NATIVE_IME_LIMITS.raw, 'raw.json')), seal = decode(await bytes(observation.seal, NATIVE_IME_LIMITS.json, 'raw-seal.json'));
  demand(seal.kind === 'native-ime-raw-seal-1', 'Native IME raw seal version differs');
  same(seal.raw, observation.raw, 'Native IME raw seal differs'); same(seal.binding, observation.binding, 'Native IME source binding seal differs'); same(seal.plan, observation.plan, 'Native IME plan seal differs');
  demand(binding.nonce === observation.nonce && seal.nonce === observation.nonce && seal.reviewTimeoutMs === selected.reviewTimeoutMs, 'Native IME seal nonce or review window differs');
  const replay = inspectNativeImeTrace(raw, {fixture, plan, nonce: observation.nonce, acceptedBefore: binding.acceptedBefore, acceptedAfter: seal.acceptedAfter});
  same(seal.analysis, replay, 'Native IME raw trace analysis differs'); same(observation.trace, replay.observation, 'Native IME published trace differs');
  if (replay.status !== 'PASS') return null;
  const events = name => journalEvents.filter(row => row.event === name && row.nonce === observation.nonce && row.cellId === cell.id);
  const capture = events('native-ime-capture-start'), ready = events('native-ime-ready'), sealed = events('native-ime-raw-sealed'), reviewed = events('native-ime-reviewed');
  demand(capture.length === 1 && ready.length === 1 && sealed.length === 1 && reviewed.length === 1, 'Native IME actual capture/review journal boundaries missing');
  const captureUtc = Date.parse(capture[0].utc), readyUtc = Date.parse(ready[0].utc), sealedUtc = Date.parse(sealed[0].utc), reviewedUtc = Date.parse(reviewed[0].utc);
  const tolerance = NATIVE_IME_EPOCH_FRESHNESS_TOLERANCE_MS;
  demand([captureUtc, readyUtc, sealedUtc, reviewedUtc].every(Number.isFinite) && captureUtc <= readyUtc && readyUtc <= sealedUtc && sealedUtc <= reviewedUtc &&
    raw.timeOrigin + raw.armedMs >= captureUtc - tolerance && raw.timeOrigin + raw.armedMs <= readyUtc + tolerance &&
    [raw.startMs, raw.endMs, raw.captureStoppedMs].every(value => raw.timeOrigin + value >= captureUtc - tolerance && raw.timeOrigin + value <= sealedUtc + tolerance),
    'Native IME browser epoch is outside its fresh worker capture window');
  const review = decode(await bytes(observation.review, NATIVE_IME_LIMITS.json, 'review.json')), receipt = decode(await bytes(observation.reviewReceipt, NATIVE_IME_LIMITS.json, 'review-receipt.json'));
  demand(receipt.kind === 'native-ime-review-receipt-1' && receipt.nonce === observation.nonce, 'Native IME review receipt version/nonce differs');
  same(receipt.review, observation.review, 'Native IME received review differs');
  const authority = inspectNativeImeReview(review, {operator, plan, nonce: observation.nonce, binding: observation.binding, raw: observation.raw, planArtifact: observation.plan, sealedAt: seal.sealedAt, receivedAt: receipt.receivedAt, reviewTimeoutMs: selected.reviewTimeoutMs});
  same(receipt.authority, authority, 'Native IME external authority review differs');
  if (authority.status !== 'PASS' || !Number.isFinite(receipt.receivedElapsedMs) || receipt.receivedElapsedMs < 0 || receipt.receivedElapsedMs > selected.reviewTimeoutMs) return null;
  await evidence(review.evidence, receipt.evidence, 'review-evidence');
  demand(capture.length === 1 && capture[0].monotonicMs >= attempt.startMs && ready.length === 1 && sealed.length === 1 && reviewed.length === 1 && ready[0].monotonicMs >= attempt.startMs && ready[0].monotonicMs >= capture[0].monotonicMs && sealed[0].monotonicMs - capture[0].monotonicMs >= 60000 && reviewed[0].monotonicMs >= sealed[0].monotonicMs && reviewed[0].monotonicMs <= attempt.endMs && reviewed[0].monotonicMs - sealed[0].monotonicMs <= selected.reviewTimeoutMs + 1000, 'Native IME authority was not received inside this fresh worker action');
  demand([captureUtc, sealedUtc, reviewedUtc].every(Number.isFinite) && seal.sealedAt >= captureUtc && seal.sealedAt <= sealedUtc && receipt.receivedAt >= sealedUtc && receipt.receivedAt <= reviewedUtc, 'Native IME external review wall clock is outside its actual journal boundaries');
  same(ready[0].binding, observation.binding, 'Native IME ready journal differs'); same(sealed[0].raw, observation.raw, 'Native IME raw journal differs'); same(reviewed[0].review, observation.review, 'Native IME review journal differs');
  const proof = Object.freeze({}); proofs.set(proof, {observation: structuredClone(observation), trace: replay.observation}); return proof;
}
