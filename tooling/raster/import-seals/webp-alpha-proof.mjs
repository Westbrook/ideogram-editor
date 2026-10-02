// Read-only bridge from the unchanged schema-2 capsule reader to the pure alpha
// source-audit validator. Original paths are virtual provenance labels only;
// every byte comes from a manifest-bound retained file, never captured code.
import assert from 'node:assert/strict';
import {constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync} from 'node:fs';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {digest, hash, inside, MAX_CAPSULE_BYTES, MAX_FILES, MAX_FILE_BYTES, MAX_JSON_BYTES, relativePath} from './files.mjs';

// Match the parent's source-audit callback bound. This covers the 5120 x 5120
// RGBA fixture (104,857,600 bytes) and retained Node/libvips encoder artifacts.
// JSON keeps its separate 8 MiB bound; larger raw entries have no fallback.
const MAX_AUDIT_BYTES = 256 * 1048576;
const identity = value => ({bytes: value.bytes, hash: value.hash});
const stamp = value => [value.dev, value.ino, value.mode, value.nlink, value.size, value.mtimeNs, value.ctimeNs].map(String).join(':');
function exactKeys(value, names, label) {
  assert(value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)), label + ' must be a record');
  assert.deepEqual(Reflect.ownKeys(value).sort(), [...names].sort(), label + ' fields differ');
}
function byteCount(value, maximum) {
  assert(Number.isSafeInteger(value) && value >= 0 && value <= maximum, 'Retained byte bound exceeded');
}
function originalPath(value) {
  assert(typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0'), 'Invalid original path');
  assert(isAbsolute(value) && resolve(value) === value, 'Original parent path must be normalized and absolute');
  return value;
}
function literalReference(value) {
  assert(typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0'), 'Invalid original reference');
  return value;
}

function heldRead(directory, retained, maximum) {
  byteCount(retained.bytes, maximum); digest(retained.hash);
  const path = inside(directory, retained.path);
  assert.equal(realpathSync(path), path, 'Retained proof path must be canonical');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, {bigint: true});
    assert(before.isFile() && before.nlink === 1n && before.size === BigInt(retained.bytes), 'Retained proof must be an exact singly linked file');
    const data = Buffer.alloc(retained.bytes);
    for (let offset = 0; offset < data.length;) {
      const count = readSync(fd, data, offset, data.length - offset, offset);
      assert(count > 0, 'Retained proof shortened during read'); offset += count;
    }
    assert.equal(stamp(before), stamp(fstatSync(fd, {bigint: true})), 'Retained proof changed during read');
    assert.equal(stamp(before), stamp(lstatSync(path, {bigint: true})), 'Retained proof pathname changed');
    assert.equal(realpathSync(path), path, 'Retained proof ancestry changed');
    assert.equal(hash(data), retained.hash, 'Retained proof bytes differ');
    return {data, bytes: data.length, hash: retained.hash};
  } finally { closeSync(fd); }
}

/**
 * get/readBound return {path,data,bytes,hash}; path is the resolved ORIGINAL
 * provenance label. readJSON adds value parsed from the same held bytes.
 *
 * qualificationPath may seed an independently established original directory.
 * The fallback is a deterministic virtual origin; it is never opened. Call
 * register(path,hash) for another independently established parent origin.
 * A hash with several origins requires an explicit registered parentPath.
 * The outer managed proofReader.finish() owns whole-capsule cardinality.
 */
export function createWebPAlphaProofReader({directory, manifest, qualificationHash, proofReader, qualificationPath}) {
  digest(qualificationHash);
  assert(typeof directory === 'string' && isAbsolute(directory) && resolve(directory) === directory);
  assert.equal(realpathSync(directory), directory, 'Capsule directory must be canonical');
  assert(lstatSync(directory).isDirectory(), 'Capsule directory required');
  assert(proofReader && typeof proofReader.read === 'function', 'Managed proof reader required');
  assert(manifest && manifest.schemaVersion === 1 && Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= MAX_FILES);
  const files = new Map(); let totalBytes = 0;
  for (const input of manifest.files) {
    exactKeys(input, ['path', 'bytes', 'hash'], 'Manifest file'); relativePath(input.path);
    assert(input.path !== 'adoption.json' && !files.has(input.path), 'Duplicate or self-referential manifest file');
    byteCount(input.bytes, MAX_FILE_BYTES); digest(input.hash); totalBytes += input.bytes;
    assert(totalBytes <= MAX_CAPSULE_BYTES, 'Capsule byte bound exceeded');
    files.set(input.path, Object.freeze({path: input.path, ...identity(input)}));
  }
  const proofFile = files.get('proof-capsule.json'); assert(proofFile, 'Manifest must bind proof-capsule.json');
  const proofBytes = heldRead(directory, proofFile, MAX_JSON_BYTES);
  const proof = JSON.parse(proofBytes.data.toString('utf8'));
  exactKeys(proof, ['schemaVersion', 'qualificationHash', 'references'], 'Proof capsule');
  assert.equal(proof.schemaVersion, 2); assert.equal(proof.qualificationHash, qualificationHash);
  assert(Array.isArray(proof.references) && proof.references.length <= MAX_FILES, 'Proof mapping bound exceeded');
  const mappings = new Map(), capturedPaths = new Set(), knownHashes = new Set([qualificationHash]);
  for (const input of proof.references) {
    exactKeys(input, ['parentHash', 'originalReference', 'capturedPath', 'bytes', 'hash'], 'Proof mapping');
    digest(input.parentHash); digest(input.hash); literalReference(input.originalReference); relativePath(input.capturedPath);
    byteCount(input.bytes, MAX_FILE_BYTES);
    const key = input.parentHash + '\n' + input.originalReference, file = files.get(input.capturedPath);
    assert(!mappings.has(key), 'Duplicate original proof mapping');
    assert(!capturedPaths.has(input.capturedPath), 'Retained path represents more than one original proof mapping');
    assert(file, 'Proof mapping is absent from the manifest'); assert.deepEqual(identity(input), identity(file), 'Proof mapping differs from manifest identity');
    mappings.set(key, Object.freeze({...input})); capturedPaths.add(input.capturedPath);
    knownHashes.add(input.parentHash); knownHashes.add(input.hash);
  }

  const pathHashes = new Map(), hashPaths = new Map(), edgePaths = new Map();
  function register(path, parentHash) {
    originalPath(path); digest(parentHash); assert(knownHashes.has(parentHash), 'Original parent hash is not in the proof capsule');
    const previous = pathHashes.get(path);
    assert(previous === undefined || previous === parentHash, 'Conflicting hashes for one original path');
    if (previous === undefined) {
      assert(pathHashes.size < 2 * MAX_FILES + 1, 'Original path registry bound exceeded');
      pathHashes.set(path, parentHash);
      if (!hashPaths.has(parentHash)) hashPaths.set(parentHash, new Set());
      hashPaths.get(parentHash).add(path);
    }
    return path;
  }
  const origin = qualificationPath === undefined ? '/__webp_alpha_proof__/' + qualificationHash.slice(7) + '/qualification.json' : qualificationPath;
  register(origin, qualificationHash);

  function parentOrigin(parentHash, explicit) {
    digest(parentHash);
    if (explicit !== undefined) {
      originalPath(explicit); assert.equal(pathHashes.get(explicit), parentHash, 'Parent origin was not registered for this hash'); return explicit;
    }
    const paths = hashPaths.get(parentHash);
    assert(paths && paths.size === 1, 'Missing or ambiguous original parent origin; supply a registered parentPath');
    return paths.values().next().value;
  }
  function get(parentHash, reference, {parentPath} = {}) {
    assert(reference && typeof reference === 'object' && !Array.isArray(reference), 'Proof reference required');
    literalReference(reference.path); digest(reference.hash);
    const key = digest(parentHash) + '\n' + reference.path, row = mappings.get(key);
    assert(row, 'Missing exact original proof mapping: ' + reference.path);
    assert.equal(row.hash, reference.hash, 'Original proof hash differs');
    if (reference.bytes !== undefined) { byteCount(reference.bytes, MAX_FILE_BYTES); assert.equal(row.bytes, reference.bytes, 'Original proof byte count differs'); }
    const parent = parentOrigin(parentHash, parentPath), path = originalPath(resolve(dirname(parent), reference.path));
    const priorPath = edgePaths.get(key);
    assert(priorPath === undefined || priorPath === path, 'Ambiguous schema-2 mapping resolves to different original paths');
    const isJSON = /\.json$/i.test(reference.path), maximum = isJSON ? MAX_JSON_BYTES : MAX_AUDIT_BYTES;
    const held = heldRead(directory, files.get(row.capturedPath), maximum);
    // Preserve the existing capsule reader's exact edge accounting, including
    // non-JSON edges for which that reader intentionally returns undefined.
    const managed = proofReader.read(parentHash, reference);
    if (isJSON) assert.deepEqual(managed, JSON.parse(held.data.toString('utf8')), 'Managed proof JSON differs from held bytes');
    else assert.equal(managed, undefined, 'Managed non-JSON proof unexpectedly supplied parsed data');
    register(path, row.hash); edgePaths.set(key, path);
    return {path, ...held};
  }
  function readJSON(parentHash, reference, options) {
    assert(reference && /\.json$/i.test(reference.path), 'JSON reads require an original .json reference');
    const held = get(parentHash, reference, options);
    return {...held, value: JSON.parse(held.data.toString('utf8'))};
  }
  function readBound(parentPath, reference) {
    originalPath(parentPath); const parentHash = pathHashes.get(parentPath);
    assert(parentHash, 'Unknown original parent path'); return get(parentHash, reference, {parentPath});
  }
  return Object.freeze({qualificationPath: origin, register, get, readJSON, readBound});
}
