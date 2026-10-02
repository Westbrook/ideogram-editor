// Retained-data verification only. No retained JavaScript/TypeScript, native
// library, archive member, producer, or host campaign is executed here.
import assert from 'node:assert/strict';
import {closeSync, constants, fstatSync, lstatSync, openSync, readSync} from 'node:fs';
import {checkParents, digest, hash, inside, MAX_JSON_BYTES, relativePath} from './files.mjs';
import {
  ALPHA_BASE_CODEC, ALPHA_ORIGINAL, ALPHA_PREDECESSOR, ALPHA_PRODUCER_REVIEW,
  ALPHA_REPAIR, ALPHA_SELECTED, ALPHA_SOURCE, ALPHA_SOURCE_FREEZE,
} from './webp-alpha-authority.mjs';

const ordinal = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
const id = row => ({bytes: row.bytes, hash: row.hash});
const keys = (value, expected, label) => assert.deepEqual(Object.keys(value).sort(), expected.slice().sort(), label);
const positive = value => Number.isSafeInteger(value) && value > 0;
const same = (a, b) => ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);

// Historical WebP producer serialization is sorted JSON.stringify, not the
// application's canonical serializer with additional control escaping.
export function alphaProducerJSON(value) {
  if (Array.isArray(value)) return '[' + value.map(alphaProducerJSON).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + alphaProducerJSON(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

// Embedded upstream inventories include names such as m4/lt~obsolete.m4.
// These are record names only: they are never joined to a capsule path or opened.
function sourceRecordPath(value) {
  assert.equal(typeof value, 'string');
  assert(value.length > 0 && value.length <= 1024 && !value.startsWith('/') &&
    !/^[A-Za-z]:/.test(value) &&
    !value.includes('\\') && !value.includes('\0') &&
    value.split('/').every(part => part && part !== '.' && part !== '..'), 'Invalid source record path');
}

function rows(value, label, {zero = false, sourceRecords = false} = {}) {
  assert(Array.isArray(value) && value.length > 0 && value.length <= 8192, label + ' is empty or oversized');
  const names = new Set();
  for (const row of value) {
    keys(row, ['path', 'bytes', 'hash'], label + ' row keys differ');
    (sourceRecords ? sourceRecordPath : relativePath)(row.path); digest(row.hash);
    assert(!names.has(row.path), label + ' has duplicate paths'); names.add(row.path);
    assert(Number.isSafeInteger(row.bytes) && row.bytes >= (zero ? 0 : 1), label + ' has invalid bytes');
  }
  return value;
}

function retained(directory, files, path, expected) {
  const captured = heldAlphaSource(directory, files, path, expected);
  assert.deepEqual(id(captured), id(expected), 'Retained alpha input changed: ' + path);
}

function boundJSON(directory, files, prefix, ref) {
  const path = prefix + ref.path;
  const result = heldAlphaSource(directory, files, path, ref);
  return {path: ref.path, bytes: result.bytes, hash: result.hash, value: JSON.parse(result.data.toString('utf8'))};
}

// All retained producer inputs fit the explicit JSON/source bound, including
// the 4.3 MB upstream archive. Return only bytes from the checked held descriptor.
export function heldAlphaSource(directory, files, path, expected) {
  relativePath(path); assert(files.has(path), 'Missing retained alpha input: ' + path);
  assert(positive(expected.bytes) && expected.bytes <= MAX_JSON_BYTES); digest(expected.hash);
  const full = inside(directory, path); checkParents(full);
  const before = lstatSync(full, {bigint: true});
  assert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n, 'Alpha input must be singly linked');
  assert.equal(before.size, BigInt(expected.bytes), 'Retained alpha input changed: ' + path);
  const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    assert(same(before, fstatSync(fd, {bigint: true})), 'Alpha input changed before open');
    const bytes = Buffer.alloc(expected.bytes);
    for (let at = 0; at < bytes.length;) {
      const count = readSync(fd, bytes, at, bytes.length - at, at);
      assert(count > 0, 'Alpha input shortened'); at += count;
    }
    assert(same(before, fstatSync(fd, {bigint: true})) && same(before, lstatSync(full, {bigint: true})),
      'Alpha input changed during read');
    const capturedHash = hash(bytes);
    assert.equal(capturedHash, expected.hash, 'Retained alpha input changed: ' + path);
    return {data: bytes, bytes: bytes.length, hash: capturedHash};
  } finally { closeSync(fd); }
}

function exactNamespace(files, prefix, expected) {
  const actual = [...files].filter(path => path.startsWith(prefix)).sort();
  assert.deepEqual(actual, expected.map(row => prefix + row.path).sort(), 'Retained namespace differs: ' + prefix);
}

function manifestRows(ref, directory) {
  rows(ref.value.files, directory + ' files');
  return [...ref.value.files, {path: 'source-manifest.json', ...id(ref)}]
    .map(row => ({path: directory + '/' + row.path, ...id(row)}));
}

function verifyAlphaSourceRecords(candidate, repair, plan) {
  const m = repair.value, d = candidate.producerDefinition;
  assert.equal(m.schemaVersion, 1);
  assert.equal(m.kind, 'webp-paletted-alpha-prefix-repair-v1');
  assert.equal(m.status, 'source-only-unbuilt-unqualified');
  assert.equal(m.proposedArtifactVersion, ALPHA_SELECTED.version);
  assert.equal(m.member, 'src/dec/vp8l_dec.c');
  assert.deepEqual(m.baseArchive, {path: ALPHA_SOURCE.archive, ...id(ALPHA_SOURCE)});
  const binding = {manifest: {...ALPHA_REPAIR}, baseArchive: m.baseArchive,
    member: m.member, before: m.before, after: m.after, patch: m.patch};
  assert.deepEqual(candidate.alphaRepair, binding); assert.deepEqual(d.alphaRepair, binding);
  assert.deepEqual(candidate.source.changes, [{kind: m.kind, member: m.member,
    before: m.before, after: m.after, patch: m.patch}]);
  const paths = [...plan.decoderMembers, ...plan.commonDspMembers, ...plan.utilityMembers, ...plan.arm64DspMembers].sort();
  assert.equal(new Set(paths).size, paths.length); for (const path of paths) relativePath(path);
  keys(d.sourceTrees, ['oracle', 'pristine', 'repaired'], 'Source tree roles differ');
  const pristine = rows(d.sourceTrees.pristine, 'Pristine source tree', {zero: true, sourceRecords: true});
  const repaired = rows(d.sourceTrees.repaired, 'Repaired source tree', {zero: true, sourceRecords: true});
  assert.deepEqual(rows(d.sourceTrees.oracle, 'Oracle source tree', {zero: true, sourceRecords: true}), pristine, 'Oracle source was repaired');
  assert.deepEqual(pristine.map(row => row.path), repaired.map(row => row.path), 'Repair changed source membership');
  assert.equal(pristine.filter(row => row.path === m.member).length, 1);
  for (let index = 0; index < pristine.length; index++) {
    const before = pristine[index];
    if (before.path === m.member) {
      assert.deepEqual(before, {path: m.member, ...m.before}); assert.deepEqual(repaired[index], m.after);
    } else assert.deepEqual(repaired[index], before, 'Repair changed another source member: ' + before.path);
  }
  for (const [name, tree] of [['pristineMembers', pristine], ['members', repaired], ['oracleMembers', pristine]]) {
    rows(d[name], name); assert.deepEqual(d[name].map(row => row.path), paths, 'Compiled source membership differs');
    assert.deepEqual(d[name], paths.map(path => tree.find(row => row.path === path)), 'Compiled source differs from its full tree');
  }
  assert.deepEqual(candidate.build.sourceMembers, d.members);
  assert.deepEqual(candidate.build.sourceMembersBeforeRepair, d.pristineMembers);
  assert.deepEqual(candidate.build.oracleSourceMembers, d.oracleMembers);
  const applied = {applied: true, member: m.member, before: m.before, after: id(m.after)};
  const oracle = {applied: false, member: m.member, before: m.before, after: m.before};
  assert.deepEqual(candidate.build.sourceRepairs, {first: applied, second: applied, oracle});
  assert.deepEqual(candidate.oracle.sourceRepair, oracle);
  assert.equal(candidate.oracle.meaning, 'Separate unmodified libwebp1.6.0 build; pinned-codec differential, not independent implementation');
  return binding;
}

/** Verify the exact retained producer closure, independently of issuer/gates. */
export function validateAlphaProducer({directory, manifest, files, candidate, candidateHash, authority}) {
  assert(files instanceof Set, 'Verified capsule file membership is required');
  const selected = ALPHA_SELECTED;
  assert.equal(candidateHash, selected.candidate.hash, 'Unreviewed alpha candidate receipt');
  const captured = boundJSON(directory, files, '', {path: 'build-candidate.json', ...selected.candidate});
  assert.deepEqual(candidate, captured.value, 'Candidate argument differs from retained receipt');
  assert.equal(candidate.schemaVersion, 1); assert.equal(candidate.status, 'built-unqualified');
  assert.equal(candidate.name, 'ideogram-webp-advanced'); assert.equal(candidate.transport, 'webp-advanced-file-v1');
  assert.equal(candidate.version, selected.version); assert.equal(candidate.producerDirectory, selected.producerDirectory);
  assert.equal(candidate.platform, selected.platform); assert.equal(candidate.arch, selected.arch);
  assert.equal(candidate.abiVersion, 1); assert.equal(candidate.decoderVersion, 0x010600);
  assert.equal(candidate.sourceFreezeHash, selected.sourceFreezeHash);
  assert.equal(candidate.recipeManifestHash, selected.recipe.hash); assert.equal(candidate.producerHash, selected.producerHash);
  assert.deepEqual(candidate.artifact, selected.artifact);
  assert.equal(candidate.source.version, ALPHA_SOURCE.version); assert.equal(candidate.source.archive, ALPHA_SOURCE.archive);
  assert.equal(candidate.source.archiveHash, ALPHA_SOURCE.hash); assert.equal(candidate.source.hash, ALPHA_SOURCE.hash);
  assert.equal(candidate.source.bytes, ALPHA_SOURCE.bytes);
  assert.equal(candidate.build.reproduction, 'two fresh artifacts byte-identical');
  assert.deepEqual(candidate.execution, {mode: 'native', image: null});
  assert.deepEqual(candidate.qualification, {issued: false, nativeTests: false, halo: null, colorCP1: false, cleanup: false, rss: false});
  assert(positive(candidate.residentCodeBytes) && candidate.residentCodeBytes >= candidate.artifact.bytes);
  retained(directory, files, candidate.artifact.path, selected.artifact);
  retained(directory, files, 'libwebp-1.6.0.tar.gz', ALPHA_SOURCE);

  const sourceFreeze = boundJSON(directory, files, 'producer-inputs/', ALPHA_SOURCE_FREEZE);
  assert.equal(sourceFreeze.value.schemaVersion, 1); assert.equal(sourceFreeze.value.status, 'source-frozen-unqualified');
  const frozen = rows(sourceFreeze.value.files, 'Frozen source inputs'); assert.equal(frozen.length, 9);
  const recipe = boundJSON(directory, files, 'producer-inputs/', {path: selected.producerDirectory + '/source-manifest.json', ...selected.recipe});
  assert.equal(recipe.value.schemaVersion, 3); assert.equal(recipe.value.status, 'producer-alpha-repair-source-frozen-unexecuted');
  assert.equal(recipe.value.producerDirectory, selected.producerDirectory); assert.equal(recipe.value.sourceFreezeHash, sourceFreeze.hash);
  const predecessor = boundJSON(directory, files, 'producer-inputs/', ALPHA_PREDECESSOR);
  assert.equal(predecessor.value.schemaVersion, 2); assert.equal(predecessor.value.status, 'producer-successor-source-frozen-unexecuted');
  assert.equal(predecessor.value.producerDirectory, 'producer-v2'); assert.equal(predecessor.value.sourceFreezeHash, sourceFreeze.hash);
  assert.equal(recipe.value.predecessorManifestHash, predecessor.hash);
  const original = boundJSON(directory, files, 'producer-inputs/', ALPHA_ORIGINAL);
  assert.equal(original.value.schemaVersion, 1); assert.equal(original.value.status, 'producer-preparation-frozen-unexecuted');
  assert.equal(original.value.sourceFreezeHash, sourceFreeze.hash); assert.equal(predecessor.value.predecessorManifestHash, original.hash);
  assert.equal(predecessor.value.reviewRecordHash, ALPHA_PRODUCER_REVIEW.hash);
  const review = boundJSON(directory, files, 'producer-inputs/', ALPHA_PRODUCER_REVIEW);
  const repair = boundJSON(directory, files, 'producer-inputs/', ALPHA_REPAIR);
  assert.deepEqual(recipe.value.alphaRepairManifest, id(repair));
  const packetPrefix = 'artifacts/oversized-import-staging/webp/';
  assert.deepEqual(repair.value.predecessorProducer, {path: packetPrefix + ALPHA_PREDECESSOR.path, ...id(predecessor)});

  const predecessorDependencies = rows(predecessor.value.dependencies, 'Predecessor dependencies');
  const hostDependencies = predecessorDependencies.filter(row => row.path.startsWith('server/raster/'));
  assert.equal(hostDependencies.length, 4);
  assert.deepEqual(hostDependencies.map(row => row.path), ['server/raster/codec-platform.ts', 'server/raster/identity.ts',
    'server/raster/identities/linux-arm64-v1.ts', 'server/raster/identities/linux-x64-v1.ts']);
  const predecessorFiles = rows(predecessor.value.files, 'Predecessor producer files');
  const build = predecessorFiles.find(row => row.path === 'build.mjs'); assert(build);
  const inheritedProducerDependencies = [{path: packetPrefix + 'producer-v2/build.mjs', ...id(build)},
    {path: packetPrefix + ALPHA_PREDECESSOR.path, ...id(predecessor)}];
  assert.deepEqual(rows(recipe.value.dependencies, 'Alpha recipe dependencies'), [...hostDependencies, ...inheritedProducerDependencies]);
  const inventoryRef = predecessorFiles.find(row => row.path === 'dependency-inventory.json'); assert(inventoryRef);
  const dependencyInventory = boundJSON(directory, files, 'producer-inputs/producer-v2/', inventoryRef);
  assert.deepEqual(dependencyInventory.value.modules, predecessorDependencies);

  const repairRows = [ALPHA_REPAIR, ...[repair.value.after, repair.value.patch]
    .map(row => ({path: 'alpha-repair-v1/' + row.path, ...id(row)}))];
  const candidateInputs = [...frozen, {...ALPHA_SOURCE_FREEZE}, ...repairRows,
    ...manifestRows(recipe, selected.producerDirectory)].sort(ordinal);
  rows(candidateInputs, 'Complete candidate input closure'); assert.equal(candidateInputs.length, 19);
  assert.deepEqual(rows(candidate.inputs, 'Candidate input records').slice().sort(ordinal), candidateInputs);
  const packetInputs = [...candidateInputs, ...manifestRows(predecessor, 'producer-v2'),
    ...manifestRows(original, 'producer'), {path: review.path, ...id(review)}].sort(ordinal);
  rows(packetInputs, 'Complete retained producer closure'); assert.equal(packetInputs.length, 43);
  exactNamespace(files, 'producer-inputs/', packetInputs);
  exactNamespace(files, 'dependency-inputs/', hostDependencies);
  for (const row of packetInputs) retained(directory, files, 'producer-inputs/' + row.path, row);
  for (const row of hostDependencies) retained(directory, files, 'dependency-inputs/' + row.path, row);
  for (const row of inheritedProducerDependencies) {
    assert(row.path.startsWith(packetPrefix));
    assert.deepEqual(packetInputs.find(item => item.path === row.path.slice(packetPrefix.length)),
      {path: row.path.slice(packetPrefix.length), ...id(row)}, 'Inherited producer dependency is not retained');
  }

  const definition = candidate.producerDefinition;
  assert.deepEqual(definition.inputs, candidate.inputs); assert.deepEqual(definition.upstream, candidate.source);
  assert.equal(definition.platform, candidate.platform); assert.equal(definition.arch, candidate.arch);
  assert.equal(definition.sourceFreezeHash, sourceFreeze.hash);
  assert.equal(hash(alphaProducerJSON(definition)), selected.producerHash, 'WebP producer definition dialect or bytes differ');
  const planRef = frozen.find(row => row.path === 'producer-inputs.json'); assert(planRef);
  const plan = boundJSON(directory, files, 'producer-inputs/', planRef);
  const alphaRepair = verifyAlphaSourceRecords(candidate, repair, plan.value);
  for (const name of ['COPYING', 'PATENTS', 'AUTHORS']) {
    const row = definition.sourceTrees.pristine.find(item => item.path === name); assert(row);
    retained(directory, files, name, row);
  }

  const baseInputs = hostDependencies.filter(row => ['server/raster/codec-platform.ts', 'server/raster/identity.ts'].includes(row.path));
  assert.equal(baseInputs.length, 2); exactNamespace(files, 'authority-inputs/', baseInputs);
  const registry = heldAlphaSource(directory, files, 'authority-inputs/' + baseInputs[0].path, baseInputs[0]).data.toString('utf8');
  const source = heldAlphaSource(directory, files, 'authority-inputs/' + baseInputs[1].path, baseInputs[1]).data.toString('utf8');
  const literal = source.match(/export const CODECS = (\{[\s\S]*\}) as const;/);
  const exported = source.match(/export const CODEC_ID = ['"](sha256:[a-f0-9]{64})['"]/);
  assert(literal && exported, 'Retained codec source must contain the pinned JSON literal');
  const codecs = JSON.parse(literal[1]); assert.equal(hash(JSON.stringify(codecs)), exported[1]);
  assert.equal(exported[1], ALPHA_BASE_CODEC); assert.equal(codecs.platform, selected.platform); assert.equal(codecs.arch, selected.arch);
  assert(registry.includes("import { CODECS as MAC_CODECS, CODEC_ID as MAC_CODEC_ID } from './identity.js';"));
  assert(registry.includes('{ codecs: MAC_CODECS, codecId: MAC_CODEC_ID }'));
  const baseCodecAuthority = {codecId: exported[1], platform: selected.platform, arch: selected.arch, inputs: baseInputs};
  assert.deepEqual(candidate.baseCodecAuthority, baseCodecAuthority); assert.deepEqual(authority, baseCodecAuthority);
  assert.deepEqual(manifest.baseCodecAuthority, baseCodecAuthority);
  assert.equal(manifest.sourceFreezeHash, sourceFreeze.hash); assert.equal(manifest.producerDirectory, selected.producerDirectory);
  assert.equal(manifest.recipeManifestHash, recipe.hash);
  assert.deepEqual(manifest.producerClosure, {candidateInputCount: 19, retainedPacketInputCount: 43,
    hostDependencyCount: 4, inheritedProducerDependencyCount: 2});
  digest(manifest.qualificationHash);
  assert.equal(manifest.vendorPath, 'vendor/raster/advanced-webp/' + selected.version + '/darwin-arm64/' + manifest.qualificationHash.slice(7));
  return {sourceFreeze, recipe, repair, candidateInputs, packetInputs, hostDependencies,
    inheritedProducerDependencies, baseCodecAuthority, alphaRepair, sourceHash: ALPHA_SOURCE.hash, producerHash: selected.producerHash};
}
