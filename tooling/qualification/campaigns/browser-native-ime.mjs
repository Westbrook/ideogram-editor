import {constants} from 'node:fs';
import {lstat, mkdir, open, realpath, writeFile} from 'node:fs/promises';
import {isAbsolute, join, resolve, sep} from 'node:path';
import {randomBytes} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {attemptIdentity} from './common.mjs';
import {observeNativeIme} from './browser-native-ime-observer.mjs';
import {buildNativeImePlan, inspectNativeImeTrace} from './native-ime-contract.mjs';
import {nativeImeHash, nativeImeJSON, nativeImeSelection, inspectNativeImeOperator, inspectNativeImeReview, NATIVE_IME_LIMITS} from './native-ime-authority.mjs';

/** Bounded original ordinary-file read. No symlink, FIFO, growth, replacement or
 * caller-declared size may turn external authority input into an unbounded read. */
export async function readNativeImeFile(path, maximum) {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > NATIVE_IME_LIMITS.raw) throw Error('Native IME read bound is invalid');
  if (!isAbsolute(path) || await realpath(path) !== resolve(path)) throw Error('Native IME input must be an original absolute ordinary path');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > maximum) throw Error('Native IME input exceeds bound or is not a nonempty regular file');
    const bytes = Buffer.alloc(before.size + 1); let offset = 0;
    while (offset < bytes.length) {const read = await handle.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead;}
    const after = await handle.stat(), current = await lstat(path);
    if (offset !== before.size || after.size !== before.size || after.ino !== before.ino || after.dev !== before.dev || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || current.isSymbolicLink() || current.ino !== before.ino || current.dev !== before.dev || await realpath(path) !== resolve(path)) throw Error('Native IME original input changed during bounded read');
    return bytes.subarray(0, offset);
  } finally {await handle.close();}
}
const decode = bytes => JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
const artifact = (path, bytes) => ({path, bytes: bytes.length, sha256: nativeImeHash(bytes)});
async function accepted(page, text) {
  return page.evaluate(async ({documentId, layerId}) => {
    const read = async path => {const r = await fetch(path, {credentials: 'same-origin', headers: {'X-App-Client': 'LP-1'}, cache: 'no-store', redirect: 'error'}); if (!r.ok) throw Error('NATIVE_IME_ACCEPTED_READ_FAILED'); return r.json();};
    const document = (await read('/api/v1/documents/' + documentId)).projection.value;
    const value = await read('/api/v1/documents/' + documentId + '/text?layerId=' + layerId + '&revision=' + document.revision);
    return {documentId, documentRevision: document.revision, imageDigest: document.image.semanticDigest, layerId, layerVersion: value.layerVersion, sourceHash: value.source.text.textUtf8.hash};
  }, {documentId: text.documentId, layerId: text.activeLayerId});
}
const sleep = (ms, signal) => new Promise((resolve, reject) => {const abort = () => {clearTimeout(timer); reject(signal.reason ?? Error('Native IME interrupted'));}; const timer = setTimeout(() => {signal?.removeEventListener('abort', abort); resolve();}, ms); signal?.addEventListener('abort', abort, {once: true}); if (signal?.aborted) abort();});

/** Only the real browser owner installs this service. It never drives input.
 * External operator and independent review bytes are consumed, never authored. */
export function createNativeImeService({page, cell, sample, serial, fixture, runtime, environment, processIdentity, configuration, output, signal, journal}) {
  return async () => {
    const missing = [], observation = {kind: 'native-ime-observation-1', qualification: false, physicalPresentation: false, raw: null, binding: null, plan: null, review: null};
    let directory;
    const retain = async (name, bytes) => {if (!directory || bytes.length > NATIVE_IME_LIMITS.raw) throw Error('Native IME retained artifact bound'); await writeFile(join(output, directory, name), bytes, {mode: 0o600, flag: 'wx'}); return artifact(directory + '/' + name, bytes);};
    const retainEvidence = async (rows, prefix) => {
      const retained = [];
      for (const [index, row] of rows.entries()) {
        const bytes = await readNativeImeFile(row.path, NATIVE_IME_LIMITS.evidence);
        if (bytes.length !== row.bytes || nativeImeHash(bytes) !== row.sha256) throw Error('Native IME external evidence differs from its original pin');
        retained.push({...await retain(prefix + '-' + index + '.record', bytes), originalPath: row.path});
      }
      return retained;
    };
    try {
      signal?.throwIfAborted();
      if (cell.operation !== 'text.native-ime' || sample.cache !== 'cold' || sample.ordinal !== 1 || sample.prime !== false || serial !== 1 || runtime?.headless !== false || runtime?.ownedLaunch?.context?.freshAtLaunch !== true || !environment || processIdentity?.node !== 'v26.10.0') throw Error('Native IME requires its fresh owned headed cold attempt');
      const selection = nativeImeSelection(configuration, cell.workload), plan = buildNativeImePlan(fixture, cell.workload);
      const operatorBytes = await readNativeImeFile(selection.operatorPath, NATIVE_IME_LIMITS.json), operator = decode(operatorBytes);
      const admission = inspectNativeImeOperator(operator, plan);
      if (admission.status !== 'PASS') return {status: 'INCONCLUSIVE', missing: admission.missing, observation};
      const nonce = randomBytes(16).toString('hex'); directory = 'native-ime-' + nonce;
      await mkdir(join(output, directory), {mode: 0o700});
      observation.nonce = nonce; observation.plan = await retain('plan.json', nativeImeJSON(plan));
      const operatorArtifact = await retain('operator.json', operatorBytes), operatorEvidence = await retainEvidence(operator.evidence, 'operator-evidence');
      const attempt = {cellId: cell.id, id: attemptIdentity(cell, 'cold', 1, false), cache: 'cold', ordinal: 1, prime: false, serial};
      const before = await accepted(page, fixture.text);
      const binding = {kind: 'native-ime-binding-1', nonce, attempt, processIdentity, runtime, environment, fixtureSeal: fixture.seal, plan: observation.plan, operator: operatorArtifact, operatorEvidence, selection, acceptedBefore: before};
      observation.binding = await retain('binding.json', nativeImeJSON(binding));
      const onArmed = async acknowledgement => {
        await journal?.({event: 'native-ime-ready', cellId: cell.id, directory: join(output, directory), nonce, binding: observation.binding});
        await retain('ready.json', nativeImeJSON({kind: 'native-ime-ready-1', nonce, acknowledgement, binding: observation.binding, plan: observation.plan, instruction: 'Perform the ten sealed native composition sequences and six public presentation requests. Capture begins on the first trusted editor input and lasts exactly 60000 ms. No Apply. A separate reviewer must supply review.json only after raw-seal.json exists.', reviewPath: join(output, directory, 'review.json')}));
      };
      await journal?.({event: 'native-ime-capture-start', cellId: cell.id, nonce});
      const raw = await observeNativeIme(page, {nonce, plan, signal, armTimeoutMs: selection.armTimeoutMs, onArmed});
      observation.raw = await retain('raw.json', Buffer.from(JSON.stringify(raw)));
      let after = null;
      try {after = await accepted(page, fixture.text);} catch {missing.push('Accepted document/layer state could not be read after native capture');}
      const sealedAt = Date.now(), sealedMono = performance.now();
      const analysis = inspectNativeImeTrace(raw, {fixture, plan, nonce, acceptedBefore: before, acceptedAfter: after});
      const seal = {kind: 'native-ime-raw-seal-1', nonce, raw: observation.raw, binding: observation.binding, plan: observation.plan, acceptedAfter: after, sealedAt, reviewTimeoutMs: selection.reviewTimeoutMs, analysis};
      observation.seal = await retain('raw-seal.json', nativeImeJSON(seal));
      await journal?.({event: 'native-ime-raw-sealed', cellId: cell.id, nonce, raw: observation.raw, reviewPath: join(output, directory, 'review.json')});
      observation.trace = analysis.observation;
      if (analysis.status !== 'PASS') return {status: analysis.status, missing: [...missing, ...analysis.missing], failures: analysis.failures, observation};
      let reviewBytes;
      while (performance.now() - sealedMono <= selection.reviewTimeoutMs) {
        signal?.throwIfAborted();
        try {reviewBytes = await readNativeImeFile(join(output, directory, 'review.json'), NATIVE_IME_LIMITS.json); break;}
        catch (error) {if (error.code !== 'ENOENT') throw error;}
        await sleep(Math.min(100, Math.max(1, selection.reviewTimeoutMs - (performance.now() - sealedMono))), signal);
      }
      if (!reviewBytes) return {status: 'INCONCLUSIVE', missing: ['Independent native IME review was not supplied within this live attempt'], observation};
      const receivedAt = Date.now(), receivedElapsedMs = performance.now() - sealedMono, review = decode(reviewBytes);
      observation.review = artifact(directory + '/review.json', reviewBytes);
      const authority = inspectNativeImeReview(review, {operator, plan, nonce, binding: observation.binding, raw: observation.raw, planArtifact: observation.plan, sealedAt, receivedAt, reviewTimeoutMs: selection.reviewTimeoutMs});
      observation.reviewReceipt = await retain('review-receipt.json', nativeImeJSON({kind: 'native-ime-review-receipt-1', nonce, review: observation.review, receivedAt, receivedElapsedMs, evidence: authority.status === 'PASS' ? await retainEvidence(review.evidence, 'review-evidence') : [], authority}));
      await journal?.({event: 'native-ime-reviewed', cellId: cell.id, nonce, review: observation.review, reviewReceipt: observation.reviewReceipt});
      if (receivedElapsedMs > selection.reviewTimeoutMs) missing.push('Independent native review exceeded the live monotonic review bound');
      missing.push(...authority.missing);
      return {status: missing.length ? 'INCONCLUSIVE' : 'PASS', missing, observation};
    } catch (error) {
      signal?.throwIfAborted();
      return {status: 'INCONCLUSIVE', missing: ['Native IME evidence admission unavailable: ' + String(error?.message ?? error).slice(0, 1024)], observation};
    }
  };
}
