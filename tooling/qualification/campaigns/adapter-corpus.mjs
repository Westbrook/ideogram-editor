// Resolve WA specimens from the independently sealed fixture. This module does
// not generate weights, install profiles, or grant inference eligibility.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

const MiB = 1048576;
const NORMAL_BYTES = 256 * MiB, STRESS_BYTES = 1024 * MiB;
const SHA = /^sha256:[a-f0-9]{64}$/;
const MIME = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const abort = signal => { if (signal?.aborted) throw signal.reason ?? Error('Adapter corpus resolution aborted'); };
const unchanged = (before, after) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => before[key] === after[key]);
const inconclusive = (missing, specimen = null) => ({ status: 'inconclusive', specimen, missing });
const blob = file => ({ hash: file.hash, byteLength: String(file.bytes), mediaType: file.mediaType });

function confined(path, root) {
  assert(typeof path === 'string' && path.length > 0 && !path.includes('\0'), 'Adapter corpus path is invalid');
  const absolute = resolve(root, path);
  assert(absolute.startsWith(root + sep), 'Adapter corpus file escapes the sealed fixture directory');
  return absolute;
}

/** Accept both existing corpus records and normalized adapter IO records, while
 * refusing contradictory aliases. Association authority still comes only from
 * the sealed descriptor and matching role-bearing corpus record. */
function normalizeFile(input, root, role, defaultMediaType) {
  assert(plain(input), 'Adapter corpus file descriptor is invalid');
  const digest = input.sha256 ?? input.hash;
  assert(SHA.test(digest ?? ''), 'Adapter corpus file hash is invalid');
  if (input.sha256 !== undefined && input.hash !== undefined) assert.equal(input.sha256, input.hash, 'Contradictory file hash aliases');
  const count = input.byteLength ?? input.bytes;
  assert((typeof count === 'string' && /^(0|[1-9][0-9]*)$/.test(count)) || (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0), 'Adapter corpus file length is invalid');
  const bytes = Number(count);
  assert(Number.isSafeInteger(bytes), 'Adapter corpus file length is excessive');
  if (input.byteLength !== undefined && input.bytes !== undefined) assert.equal(String(input.byteLength), String(input.bytes), 'Contradictory file length aliases');
  const mediaType = input.mediaType ?? defaultMediaType;
  assert(typeof mediaType === 'string' && mediaType.length <= 128 && MIME.test(mediaType), 'Adapter corpus media type is invalid');
  if (input.role !== undefined) assert.equal(input.role, role, 'Adapter corpus file role contradicts its association');
  return { path: confined(input.path, root), hash: digest, bytes, mediaType, role };
}

async function checkedFile(path, { maximumBytes, expected, retainBytes = false, signal }) {
  abort(signal);
  const before = await lstat(path);
  assert(before.isFile() && !before.isSymbolicLink(), 'Adapter corpus input must be a regular nonsymlink file');
  assert.equal(await realpath(path), path, 'Adapter corpus input contains a symlink');
  assert(before.size <= maximumBytes, 'Adapter corpus input exceeds its bounded size');
  if (expected) assert.equal(before.size, expected.bytes, 'Adapter corpus byte length changed');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const digest = createHash('sha256'), retained = [], buffer = Buffer.alloc(Math.min(MiB, Math.max(1, before.size)));
  let total = 0;
  try {
    assert(unchanged(before, await handle.stat()), 'Adapter corpus file changed before reading');
    for (;;) {
      abort(signal);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      assert(total <= maximumBytes && total <= before.size, 'Adapter corpus input grew while reading');
      const part = buffer.subarray(0, bytesRead); digest.update(part);
      if (retainBytes) retained.push(Buffer.from(part));
    }
    assert.equal(total, before.size, 'Adapter corpus file changed while reading');
    assert(unchanged(before, await handle.stat()), 'Adapter corpus file changed while hashing');
    const after = await lstat(path);
    assert(after.isFile() && !after.isSymbolicLink() && unchanged(before, after), 'Adapter corpus path changed while hashing');
    assert.equal(await realpath(path), path, 'Adapter corpus path changed to a symlink');
    const sha256 = 'sha256:' + digest.digest('hex');
    if (expected) assert.equal(sha256, expected.hash, 'Adapter corpus hash changed');
    return { sha256, byteLength: String(total), ...(retainBytes ? { contents: Buffer.concat(retained, total) } : {}) };
  } finally { await handle.close(); }
}

function bindCorpusFile(file, files, root) {
  const matches = files.filter(record => plain(record) && record.role === file.role && typeof record.path === 'string'
    && resolve(root, record.path) === file.path);
  assert.equal(matches.length, 1, 'Each adapter association requires exactly one matching sealed corpus file');
  const actual = normalizeFile(matches[0], root, file.role, file.mediaType);
  assert.deepEqual(actual, file, 'Adapter association differs from its sealed corpus identity');
}

function descriptorFrom(manifest) {
  const direct = manifest.adapterCorpus;
  const nestedManifest = manifest.adapterLibrary?.fixtureManifest;
  const nested = nestedManifest?.adapterCorpus ?? (nestedManifest?.kind === 'wa-adapter-corpus-1' ? nestedManifest : undefined);
  if (direct !== undefined && nested !== undefined) assert.deepEqual(direct, nested, 'Conflicting sealed adapter corpus descriptors');
  return direct ?? nested;
}

function verifyProjection(fixture, manifest) {
  // Re-read associations rather than trusting a caller's changed in-memory
  // projection, including a descriptor injected through run configuration.
  for (const key of ['adapterCorpus', 'corpus']) {
    if (fixture[key] !== undefined) assert.deepEqual(fixture[key], manifest[key], 'Caller changed the sealed fixture ' + key);
  }
  if (fixture.adapterLibrary?.fixtureManifest !== undefined)
    assert.deepEqual(fixture.adapterLibrary.fixtureManifest, manifest.adapterLibrary?.fixtureManifest, 'Caller changed the sealed adapter library manifest');
}

/** The fixture seal must already be independently retained by the controller.
 * Rechecking it here binds every association, including the legacy structural
 * fallback, to those exact bytes. A ready specimen is an eligible *candidate*,
 * never a claim that the current production profile accepts it. */
export async function resolveAdapterCorpus(fixture, { signal, requiredBytes = NORMAL_BYTES } = {}) {
  assert([NORMAL_BYTES, STRESS_BYTES].includes(requiredBytes), 'WA specimen must be exactly 256 MiB or 1 GiB');
  if (!fixture?.manifestPath || !fixture?.seal)
    return inconclusive(['The separately sealed WA fixture manifest is unavailable.']);
  assert(typeof fixture.manifestPath === 'string' && isAbsolute(fixture.manifestPath), 'WA fixture manifest path must be absolute');
  const manifestPath = resolve(fixture.manifestPath), seal = fixture.seal;
  assert.equal(manifestPath, fixture.manifestPath, 'WA fixture manifest path must be canonical');
  assert(plain(seal) && seal.path === manifestPath && SHA.test(seal.sha256 ?? ''), 'WA fixture manifest seal is invalid');
  const read = await checkedFile(manifestPath, { maximumBytes: 16 * MiB, retainBytes: true, signal });
  assert.equal(read.sha256, seal.sha256, 'WA fixture manifest seal changed');
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read.contents));
  assert(manifest.kind === 'sealed-performance-fixture' && manifest.workload === 'WA' && manifest.outcome === 'prepared', 'A complete sealed WA fixture is required');
  verifyProjection(fixture, manifest);
  const root = dirname(manifestPath), files = manifest.corpus?.files;
  assert(Array.isArray(files), 'WA fixture has no sealed corpus inventory');
  const descriptor = descriptorFrom(manifest), slot = requiredBytes === NORMAL_BYTES ? 'normal' : 'stress';
  let association, kind = 'eligible-candidate', missing = [];
  if (descriptor !== undefined) {
    assert(plain(descriptor) && descriptor.kind === 'wa-adapter-corpus-1', 'Unsupported WA adapter corpus descriptor');
    association = descriptor[slot];
    if (association === undefined) return inconclusive(['The sealed adapter corpus has no ' + slot + ' specimen association.']);
    assert(plain(association) && association.declaredFamily === 'ideogram-v4' && association.declaredFormat === 'fal', 'Invalid genuine WA adapter declaration');
    assert(typeof association.expectedProfileId === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(association.expectedProfileId), 'WA expected profile ID is invalid');
  } else {
    // Existing generated fixtures remain usable for real structural imports.
    // Their corpus files are sealed, but no eligibility is inferred from them.
    const weights = files.filter(file => file.role === 'adapter-weights' && String(file.byteLength ?? file.bytes) === String(requiredBytes));
    const configs = files.filter(file => file.role === 'adapter-config');
    missing = ['A sealed genuine eligible ' + requiredBytes + '-byte adapter/config association is unavailable; structural import coverage does not qualify the same-import lifecycle.'];
    if (!weights.length || !configs.length) return inconclusive(missing);
    assert.equal(weights.length, 1, 'Legacy sealed WA weights selection is ambiguous');
    assert.equal(configs.length, 1, 'Legacy sealed WA config association is ambiguous');
    association = { weights: weights[0], config: configs[0], declaredFamily: 'ideogram-v4', declaredFormat: 'fal', expectedProfileId: null };
    kind = 'structural-only';
  }
  const weights = normalizeFile(association.weights, root, 'adapter-weights', 'application/octet-stream');
  const config = normalizeFile(association.config, root, 'adapter-config', 'text/plain');
  const provenance = association.provenance == null ? null : normalizeFile(association.provenance, root, 'adapter-provenance', 'text/plain');
  assert.equal(weights.bytes, requiredBytes, 'WA weights differ from the prescribed exact size');
  assert.equal(weights.mediaType, 'application/octet-stream', 'WA weights media type is invalid');
  assert.equal(config.mediaType, 'text/plain', 'WA config must match the public local-import retained media type');
  assert(config.bytes >= 1 && config.bytes <= MiB, 'WA config must be between 1 byte and 1 MiB');
  if (provenance) {
    assert.equal(provenance.mediaType, 'text/plain', 'WA provenance must match the public local-import retained media type');
    assert(provenance.bytes >= 1 && provenance.bytes <= MiB, 'WA provenance must be between 1 byte and 1 MiB');
  }
  const artifacts = [weights, config, ...(provenance ? [provenance] : [])];
  assert.equal(new Set(artifacts.map(file => file.path)).size, artifacts.length, 'WA artifact roles must use distinct files');
  for (const file of artifacts) {
    bindCorpusFile(file, files, root);
    await checkedFile(file.path, { maximumBytes: file.role === 'adapter-weights' ? requiredBytes : MiB, expected: file, signal });
  }
  // Catch replacement of the sealed association while a large weights file was
  // streamed. The independently retained seal remains the authority.
  const finalManifest = await checkedFile(manifestPath, { maximumBytes: 16 * MiB, signal });
  assert.equal(finalManifest.sha256, seal.sha256, 'WA fixture manifest changed while resolving artifacts');
  const specimen = { kind, weights, config, provenance, declaredFamily: association.declaredFamily, declaredFormat: association.declaredFormat,
    expectedProfileId: association.expectedProfileId, descriptorIdentity: { manifestPath, sha256: seal.sha256, association: slot,
      associationSha256: hash(Buffer.from(JSON.stringify(association))) },
    limits: ['File identity and sealed association do not grant product eligibility or provider runtime verification.'] };
  return { status: missing.length ? 'inconclusive' : 'ready', specimen, missing };
}

/** Check returned production records, never assign their eligibility fields.
 * isSupportedAdapterProfile must be the current subject product's function; an
 * absent callback keeps the result inconclusive. The controller separately
 * retains actual durable receipts/events; this helper does not manufacture them.
 */
export function assertImportedAdapterBinding({ asset, view, specimen, isSupportedAdapterProfile }) {
  assert(plain(specimen) && ['eligible-candidate', 'structural-only'].includes(specimen.kind), 'Resolved WA specimen is required');
  const weights = blob(specimen.weights), config = blob(specimen.config), provenance = specimen.provenance ? blob(specimen.provenance) : null;
  const adapter = asset?.adapter, validation = adapter?.validation;
  assert(plain(adapter) && plain(validation) && plain(view), 'Production adapter records are required');
  assert(typeof asset.id === 'string' && asset.id.length > 0 && asset.id === adapter.id && asset.id === view.versionId, 'Imported adapter version ID changed');
  assert(typeof adapter.adapterId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(adapter.adapterId), 'Imported adapter family ID is invalid');
  assert(typeof adapter.version === 'string' && /^[1-9][0-9]*$/.test(adapter.version), 'Imported immutable version is invalid');
  assert.equal(asset.purpose, 'adapter'); assert.equal(asset.qualification, 'adapter-version'); assert.equal(asset.availability, 'available');
  assert.deepEqual(asset.blob, weights, 'Imported asset weights differ from sealed weights');
  assert.deepEqual(adapter.weights, weights, 'Registered weights differ from sealed weights');
  assert.deepEqual(adapter.config, config, 'Registered configuration differs from the sealed association');
  assert.deepEqual(view.weights, weights, 'Observed weights differ from sealed weights');
  assert.deepEqual(view.config, config, 'Observed configuration differs from the sealed association');
  assert.equal(adapter.origin?.kind, 'import'); assert.deepEqual(adapter.origin.original, provenance, 'Imported original provenance differs from its sealed association');
  assert.equal(view.origin, 'import'); assert.equal(view.adapterId, adapter.adapterId); assert.equal(view.version, adapter.version);
  assert.equal(adapter.declaredFamily, specimen.declaredFamily); assert.equal(adapter.declaredFormat, specimen.declaredFormat);
  assert.equal(view.declaredFamily, specimen.declaredFamily); assert.equal(view.declaredFormat, specimen.declaredFormat);
  assert.equal(view.qualification, adapter.qualification); assert.equal(view.available, true);
  assert.equal(validation.runtimeVerified, false, 'Local import cannot claim provider runtime verification');
  assert.equal(view.runtimeVerified, false, 'Local metadata cannot claim provider runtime verification');
  assert.equal(typeof validation.locallyEligible, 'boolean'); assert.equal(view.locallyEligible, validation.locallyEligible);
  assert(validation.profileId === null || (typeof validation.profileId === 'string' && validation.profileId.length > 0), 'Product profile ID is invalid');
  assert.equal(view.profileId, validation.profileId, 'Observed product profile changed');
  if (validation.locallyEligible) assert(adapter.qualification === 'structurally-valid' && validation.profileId !== null, 'Product local-eligibility claim contradicts its qualification');
  const missing = [];
  if (specimen.kind !== 'eligible-candidate') missing.push('No sealed genuine eligible specimen association was supplied.');
  if (adapter.qualification !== 'structurally-valid') missing.push('The product did not establish structurally valid adapter weights/config.');
  if (!validation.locallyEligible) missing.push('The current product did not establish local eligibility for these exact weights/config.');
  if (typeof isSupportedAdapterProfile !== 'function') missing.push('The current subject product profile authority was not supplied.');
  else if (isSupportedAdapterProfile(validation.profileId) !== true) missing.push('The observed product profile is not supported by the current subject.');
  if (specimen.expectedProfileId === null || validation.profileId !== specimen.expectedProfileId)
    missing.push('The observed product profile does not match the sealed expected profile.');
  return { eligible: missing.length === 0, missing, binding: { kind: 'wa-imported-adapter-binding-1', versionId: asset.id,
    adapterId: adapter.adapterId, version: adapter.version, weights, config, provenance, profileId: validation.profileId,
    locallyEligible: validation.locallyEligible, runtimeVerified: false, descriptorIdentity: specimen.descriptorIdentity } };
}
