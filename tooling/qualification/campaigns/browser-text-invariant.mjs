import {createHash} from 'node:crypto';
import {lstat, open, statfs, writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {loadAllocation, evidenceDestination, relativeMember, observeVolume, volumeAlarm, validateEvidenceObservation} from '../evidence-volume.mjs';

// This observer validates one already accepted, immutable current image. It
// does not shape text, change a draft, or infer native rendering from counts.
// 317 members covers one image + three inputs for each of 100 layers +16 font
// files. The byte ceiling is derived from those existing per-input bounds:
// 1MiB +100*(64KiB +8MiB +16KiB) +64MiB =915,210,240 bytes.
// It bounds retained evidence only; parent evidence allocation still controls
// cumulative attempts and none of the product/resource limits are increased.
export const ORDINARY_FONT_INVARIANT_LIMITS = Object.freeze({image: 1048576, source: 65536, layout: 8388608,
  text: 16384, font: 16777216, fontSet: 64 * 1048576, total: 1048576 + 100 * (65536 + 8388608 + 16384) + 64 * 1048576, members: 317});
export const ORDINARY_FONT_INVARIANT_SOURCE_FILES = Object.freeze(['server/text/validation.ts', 'server/storage/canonical.ts', 'server/storage/objects.ts', 'server/storage/files.ts',
  'src/protocol/history-validation.ts', 'src/protocol/text.ts', 'src/protocol/json.ts', 'src/protocol/validate.ts', 'src/text/profile.json']);
const validatorInputs = ['dist/local/server/text/validation.js', 'dist/local/server/storage/canonical.js',
  'dist/local/server/storage/objects.js', 'dist/local/server/storage/files.js',
  'dist/local/src/protocol/history-validation.js', 'dist/local/src/protocol/text.js', 'dist/local/src/protocol/json.js',
  'dist/local/src/protocol/validate.js', 'src/text/profile.json'];
const proofs = new WeakMap(), SHA = /^sha256:[a-f0-9]{64}$/;
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const demand = (value, message) => {if (!value) throw Error('Ordinary font invariant: ' + message);};
const same = (left, right, message) => demand(isDeepStrictEqual(left, right), message);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');
function checkedRef(ref, maximum, media) {
  demand(exact(ref, ['hash', 'byteLength', 'mediaType']) && SHA.test(ref.hash) && /^(0|[1-9][0-9]{0,19})$/.test(ref.byteLength) &&
    Number.isSafeInteger(Number(ref.byteLength)) && Number(ref.byteLength) <= maximum && typeof ref.mediaType === 'string' &&
    ref.mediaType.length > 0 && ref.mediaType.length <= 128 && (!media || ref.mediaType === media), 'bounded exact BlobRef required');
  return Number(ref.byteLength);
}
function prefix(nonce) {demand(/^[a-f0-9]{32}$/.test(nonce ?? ''), 'attempt nonce required'); return 'ordinary-text-' + nonce + '-font-invariant-';}
const admissionLimitations = Object.freeze(['Initial allocation traversal and projected file allowances are non-atomic diagnostic admission, not a filesystem quota.',
  'Other concurrent growth and filesystem-wide metadata remain unobserved; the existing outer evidence monitor and final storage audit are still required.',
  'Private immutable reads, validation, hashing, sidecar writes and replay are observation I/O and may warm unobserved OS caches; no extra product action, shaping or scenario prime is introduced.']);
const rounded = (bytes, block) => Math.ceil(bytes / block) * block;
// Reserve the two existing ordinary observation envelopes as well as the
// sidecars. These are their unchanged 4MiB raw/128KiB binding ceilings.
const metadataAllowance = block => rounded(4 * 1048576, block) + rounded(128 * 1024, block) + 2 * block;
function admissionSample(admission) {
  validateEvidenceObservation(admission.observation);
  demand(admission.observation.selectedAttempt !== null, 'complete evidence allocation observation unavailable');
  const sample = admission.observation.attempts[admission.observation.selectedAttempt].sample;
  demand(volumeAlarm(sample, admission.allocation.capacityBytes).status === 'PASS' && Number.isSafeInteger(sample.entries) &&
    sample.entries >= 0 && sample.entries <= 100000, 'evidence allocation already at its existing ceiling');
  return sample;
}
function projectedAdmission(admission, sample, member, index, charged) {
  const chargedAllocatedBytes = rounded(member.bytes, admission.blockBytes) + admission.blockBytes;
  const projectedAllocatedBytes = sample.observedAllocatedBytes + admission.metadataAllowanceBytes + charged + chargedAllocatedBytes;
  const projectedEntries = sample.entries + admission.metadataEntries + index + 1;
  demand(Number.isSafeInteger(projectedAllocatedBytes) && projectedEntries <= 100000 &&
    volumeAlarm({...sample, observedAllocatedBytes: projectedAllocatedBytes}, admission.allocation.capacityBytes).status === 'PASS',
    'new sidecar exceeds existing evidence allocation');
  return {path: member.path, bytes: member.bytes, chargedAllocatedBytes, projectedAllocatedBytes, projectedEntries};
}
async function evidenceAdmission(output, signal) {
  signal?.throwIfAborted(); const allocation = await loadAllocation(process.env.IE_EVIDENCE_ALLOCATION);
  await evidenceDestination(allocation.root, output, {directory: true, mustExist: true});
  const observation = await observeVolume(allocation), filesystem = await statfs(allocation.root, {bigint: true});
  signal?.throwIfAborted(); const blockBytes = Number(filesystem.bsize);
  demand(Number.isSafeInteger(blockBytes) && blockBytes >= 512 && blockBytes <= 1048576, 'bounded filesystem block unit unavailable');
  const value = {kind: 'ordinary-font-invariant-admission-1', allocation: {allocationId: allocation.allocationId, root: allocation.root,
    capacityBytes: allocation.capacityBytes, identity: allocation.identity, directoryIdentity: allocation.directoryIdentity}, output,
    observation, blockBytes, metadataAllowanceBytes: metadataAllowance(blockBytes), metadataEntries: 2, members: [], limitations: [...admissionLimitations]};
  const sample = admissionSample(value); let charged = 0;
  return {value, async admit(member) {
    signal?.throwIfAborted();
    const root = await lstat(allocation.root, {bigint: true});
    demand(root.isDirectory() && !root.isSymbolicLink() && String(root.dev) === allocation.directoryIdentity.dev && String(root.ino) === allocation.directoryIdentity.ino,
      'evidence allocation owner changed');
    await evidenceDestination(allocation.root, join(output, member.path));
    const row = projectedAdmission(value, sample, member, value.members.length, charged);
    charged += row.chargedAllocatedBytes; value.members.push(row);
  }};
}
function replayAdmission(admission, members, output) {
  demand(exact(admission, ['kind', 'allocation', 'output', 'observation', 'blockBytes', 'metadataAllowanceBytes', 'metadataEntries', 'members', 'limitations']) &&
    admission.kind === 'ordinary-font-invariant-admission-1' && admission.output === output && isAbsolute(output ?? '') &&
    exact(admission.allocation, ['allocationId', 'root', 'capacityBytes', 'identity', 'directoryIdentity']) &&
    isAbsolute(admission.allocation.root ?? '') && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(admission.allocation.allocationId ?? '') &&
    exact(admission.allocation.identity, ['bytes', 'sha256']) && Number.isSafeInteger(admission.allocation.identity.bytes) &&
    admission.allocation.identity.bytes > 0 && admission.allocation.identity.bytes <= 16 * 1048576 && /^[a-f0-9]{64}$/.test(admission.allocation.identity.sha256 ?? '') &&
    exact(admission.allocation.directoryIdentity, ['dev', 'ino']) && ['dev', 'ino'].every(key => /^(0|[1-9][0-9]*)$/.test(admission.allocation.directoryIdentity[key] ?? '')) &&
    Number.isSafeInteger(admission.blockBytes) && admission.blockBytes >= 512 && admission.blockBytes <= 1048576 &&
    admission.metadataAllowanceBytes === metadataAllowance(admission.blockBytes) && admission.metadataEntries === 2 &&
    Array.isArray(admission.members) && admission.members.length === members.length, 'evidence admission identity differs');
  relativeMember(admission.allocation.root, output);
  same(admission.limitations, [...admissionLimitations], 'evidence admission scope differs');
  const sample = admissionSample(admission); let charged = 0;
  for (const [index, member] of members.entries()) {
    const row = projectedAdmission(admission, sample, member, index, charged);
    same(admission.members[index], row, 'evidence admission projection differs'); charged += row.chargedAllocatedBytes;
  }
}
async function validators(repo) {
  demand(isAbsolute(repo ?? ''), 'owned source root required');
  const load = name => import(pathToFileURL(resolve(repo, 'dist/local', name)).href);
  const identity = [];
  for (const path of validatorInputs) {
    const handle = await open(join(repo, path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat(); demand(before.isFile() && before.size > 0 && before.size <= 1048576, 'validator input exceeds bound');
      const bytes = Buffer.alloc(before.size); let offset = 0;
      while (offset < bytes.length) {const read = await handle.read(bytes, offset, bytes.length - offset, offset); demand(read.bytesRead > 0, 'validator input truncated'); offset += read.bytesRead;}
      const after = await handle.stat(); demand(after.dev === before.dev && after.ino === before.ino && after.size === before.size &&
        after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs, 'validator input changed');
      identity.push({path, bytes: bytes.length, sha256: hash(bytes)});
    } finally {await handle.close();}
  }
  const [text, history, json] = await Promise.all([load('server/text/validation.js'), load('src/protocol/history-validation.js'), load('src/protocol/json.js')]);
  return {text, history, json, identity};
}

/** Both capture and retained replay call the actual production validators.
 * The reader supplies immutable bytes, never a caller-approved validation bit. */
async function evaluate(fonts, read, production) {
  demand(fonts?.kind === 'current-document-fonts-1' && Array.isArray(fonts.layers) && fonts.layers.length <= 100 &&
    Array.isArray(fonts.fonts) && fonts.fonts.length <= 1600 && Array.isArray(fonts.files) && fonts.files.length <= 16 &&
    Array.isArray(fonts.missing) && fonts.missing.length === 0, 'complete current font snapshot required');
  demand(fonts.files.every(file => Number.isSafeInteger(file.bytes) && file.bytes >= 12 && file.bytes <= ORDINARY_FONT_INVARIANT_LIMITS.font) &&
    fonts.files.reduce((sum, file) => sum + file.bytes, 0) <= ORDINARY_FONT_INVARIANT_LIMITS.fontSet, 'actual font file set exceeds bound');
  same(fonts.before, fonts.after, 'current root changed');
  const stateBytes = await read(fonts.before.imageState, ORDINARY_FONT_INVARIANT_LIMITS.image, 'application/json');
  const state = production.json.parseControlJSON(stateBytes, ORDINARY_FONT_INVARIANT_LIMITS.image);
  production.history.imageState(state);
  same(state.layers.map(layer => layer.id), fonts.before.orderedLayerIds, 'accepted image layer order differs');
  demand(state.layers.length === fonts.layers.length, 'accepted image layer inventory differs');
  const expectedFonts = new Map(fonts.fonts.map(font => [font.id, font]));
  demand(expectedFonts.size === fonts.fonts.length, 'font versions duplicated');
  const usedFonts = new Set(), checkedFiles = new Map();
  for (const [index, layer] of state.layers.entries()) {
    const observed = fonts.layers[index];
    same({id: layer.id, version: layer.version, kind: layer.kind},
      {id: observed.id, version: observed.version, kind: observed.kind}, 'accepted layer identity differs');
    if (layer.kind !== 'text') continue;
    same(layer.source, observed.source, 'accepted source ref differs');
    const sourceBytes = await read(layer.source, ORDINARY_FONT_INVARIANT_LIMITS.source, 'application/json');
    const source = production.text.validateSource(production.json.parseControlJSON(sourceBytes, ORDINARY_FONT_INVARIANT_LIMITS.source));
    same({textVersion: source.text.id, renderVersion: source.render.id, renderer: source.render.rendererProfile,
      fontIds: source.text.fonts.map(font => font.id), textHash: source.text.textUtf8.hash,
      renderDependencyHash: source.render.dependencyHash, rasterHash: source.render.pixels.hash, width: source.render.width, height: source.render.height},
    Object.fromEntries(['textVersion', 'renderVersion', 'renderer', 'fontIds', 'textHash', 'renderDependencyHash', 'rasterHash', 'width', 'height'].map(key => [key, observed[key]])),
    'accepted source differs from public font snapshot');
    demand(production.text.dependencyIdentity(source) === source.render.dependencyHash, 'text dependency hash differs');
    const layout = await read(source.render.layout, ORDINARY_FONT_INVARIANT_LIMITS.layout);
    const text = await read(source.text.textUtf8, ORDINARY_FONT_INVARIANT_LIMITS.text);
    // Includes exact ordered fontMetrics hashes and every run's declared font,
    // plus text/UTF-8/cluster coverage; the same check used by lifecycle capture.
    production.text.validateLayout(source, layout, text);
    for (const font of source.text.fonts) {
      same(font, expectedFonts.get(font.id), 'declared font version differs from actual current set'); usedFonts.add(font.id);
      const file = fonts.files.find(item => item.hash === font.bytes.hash);
      demand(file && file.fontIds.includes(font.id) && file.bytes === Number(font.bytes.byteLength) &&
        file.observedHash === font.bytes.hash && file.observedBytes === file.bytes, 'actual public font byte proof missing');
      const prior = checkedFiles.get(font.bytes.hash);
      if (prior) same(prior, font.bytes, 'one font file has conflicting identities');
      else {await read(font.bytes, ORDINARY_FONT_INVARIANT_LIMITS.font); checkedFiles.set(font.bytes.hash, font.bytes);}
    }
  }
  demand(usedFonts.size === expectedFonts.size && checkedFiles.size === fonts.files.length, 'unassociated current font/file inventory');
}
function issue(fonts, evidence) {
  const proof = Object.freeze({}); proofs.set(proof, {fonts: hash(canonical(fonts)), evidence: hash(canonical(evidence))}); return proof;
}
export function ordinaryFontInvariantMeasurement({fonts, evidence, proof}) {
  const value = proof && proofs.get(proof);
  if (!value || !fonts || !evidence || value.fonts !== hash(canonical(fonts)) || value.evidence !== hash(canonical(evidence))) return null;
  return {name: 'R35SilentFontSubstitutionCount', value: 0, unit: 'violations',
    method: 'Actual accepted image, TextSource, layout, text and font bytes are hash-verified; production source/layout/dependency validators establish declared font metrics and run membership for every current text layer, including hidden layers. Exact existing current-root and native-preview lineage remain required; no native-rendering or physical-presentation claim.'};
}

export async function collectOrdinaryFontInvariant({repo, root, fonts, nonce, output, signal}) {
  const name = prefix(nonce), admission = await evidenceAdmission(output, signal), production = await validators(repo), load = file => import(pathToFileURL(resolve(repo, 'dist/local', file)).href);
  const [{Objects}, files] = await Promise.all([load('server/storage/objects.js'), load('server/storage/files.js')]);
  demand(isAbsolute(root ?? '') && isAbsolute(output ?? ''), 'owned root and output required');
  files.assertComponents(root); files.assertComponents(output); files.assertPrivate(output, true);
  for (const directory of [root, join(root, 'objects'), join(root, 'objects', 'sha256'), join(root, 'staging')]) files.assertPrivate(directory, true);
  const evidence = {kind: 'ordinary-font-invariant-1', binding: structuredClone(fonts.binding), root: structuredClone(fonts.before), validatorInputs: production.identity, admission: admission.value, members: []};
  const check = () => signal?.throwIfAborted(), objects = new Objects(root, check, () => {throw Error('ORDINARY_FONT_INVARIANT_READ_ONLY');});
  const retained = new Map(); let total = 0;
  try {
    await evaluate(fonts, async (ref, maximum, media) => {
      check(); const length = checkedRef(ref, maximum, media), old = retained.get(ref.hash);
      if (old) same(old.ref, ref, 'retained ref identity changed');
      else {
        demand(evidence.members.length < ORDINARY_FONT_INVARIANT_LIMITS.members && total + length <= ORDINARY_FONT_INVARIANT_LIMITS.total, 'retained input capacity exceeded'); total += length;
        await admission.admit({path: name + String(evidence.members.length).padStart(3, '0') + '.bin', bytes: length});
      }
      const token = await objects.prove(ref, check);
      try {
        check(); const bytes = Buffer.alloc(length);
        for (let offset = 0; offset < length; offset += 1048576) {check(); Buffer.from(objects.readRange(ref, String(offset), Math.min(1048576, length - offset))).copy(bytes, offset);}
        objects.proven(ref, token); demand(hash(bytes) === ref.hash, 'read input hash differs');
        if (!old) {
          const path = name + String(evidence.members.length).padStart(3, '0') + '.bin';
          await writeFile(join(output, path), bytes, {mode: 0o600, flag: 'wx'}); check();
          const member = {ref: structuredClone(ref), path, bytes: length, sha256: ref.hash}; evidence.members.push(member); retained.set(ref.hash, member);
        }
        return bytes;
      } finally {objects.releaseProof(token);}
    }, production);
    check(); return {evidence, proof: issue(fonts, evidence)};
  } finally {objects.close();}
}

export async function replayOrdinaryFontInvariant({repo, fonts, nonce, output, evidence, readRetained, retainedFiles, signal}) {
  const name = prefix(nonce);
  demand(exact(evidence, ['kind', 'binding', 'root', 'validatorInputs', 'admission', 'members']) && evidence.kind === 'ordinary-font-invariant-1' &&
    Array.isArray(evidence.members) && evidence.members.length > 0 && evidence.members.length <= ORDINARY_FONT_INVARIANT_LIMITS.members, 'retained proof shape differs');
  same(evidence.binding, fonts?.binding, 'retained attempt differs'); same(evidence.root, fonts?.before, 'retained root differs');
  const seals = new Map(retainedFiles.map(file => [file.path, file])), members = new Map(), used = new Set(); let total = 0;
  for (const [index, member] of evidence.members.entries()) {
    demand(exact(member, ['ref', 'path', 'bytes', 'sha256']), 'retained member shape differs');
    const length = checkedRef(member.ref, ORDINARY_FONT_INVARIANT_LIMITS.font);
    demand(member.path === name + String(index).padStart(3, '0') + '.bin' && member.bytes === length && member.sha256 === member.ref.hash &&
      !members.has(member.ref.hash) && (total += length) <= ORDINARY_FONT_INVARIANT_LIMITS.total, 'retained member identity or capacity differs');
    const seal = seals.get(member.path); demand(seal?.bytes === length && seal.sha256 === member.sha256, 'retained outer seal differs');
    members.set(member.ref.hash, member);
  }
  replayAdmission(evidence.admission, evidence.members, output);
  const production = await validators(repo); same(evidence.validatorInputs, production.identity, 'production validator/build inputs differ');
  await evaluate(fonts, async (ref, maximum, media) => {
    signal?.throwIfAborted(); const length = checkedRef(ref, maximum, media), member = members.get(ref.hash);
    demand(member, 'retained immutable input missing'); same(member.ref, ref, 'retained input ref differs');
    const bytes = await readRetained(member.path, {maximum});
    demand(bytes instanceof Uint8Array && bytes.byteLength === length && hash(bytes) === ref.hash, 'retained input bytes differ');
    used.add(ref.hash); return bytes;
  }, production);
  demand(used.size === members.size, 'unreferenced retained inputs'); signal?.throwIfAborted(); return issue(fonts, evidence);
}
