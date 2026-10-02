// Trusted finite normalization of SOURCE DATA slots, never captured execution.
// All remaining code, metadata, membership and identities stay exact.
import assert from 'node:assert/strict';
import {canonical} from './pinned-canonical.mjs';
import {digest, hash} from './files.mjs';

const identity = row => ({bytes: row.bytes, hash: row.hash});
export const alphaTemplateIdentity = value => {
  const data = Buffer.from(canonical(value), 'utf8'); return {data, bytes: data.length, hash: hash(data)};
};
export function normalizeAlphaIssuerAuthority(data, actualDriver) {
  assert(Buffer.isBuffer(data)); const source = data.toString('utf8');
  assert(Buffer.from(source, 'utf8').equals(data), 'Issuer authority must be lossless UTF-8');
  const pattern = /^export const HOST_DRIVER = Object\.freeze\(\{directory:'host-campaigns-v3',bytes:(null|[1-9][0-9]*),\n  hash:(null|'sha256:[a-f0-9]{64}')\}\);$/gm;
  const matches = [...source.matchAll(pattern)]; assert.equal(matches.length, 1, 'Exact fixed-directory HOST_DRIVER data slot required');
  const match = matches[0], bytes = match[1] === 'null' ? null : Number(match[1]);
  const digestValue = match[2] === 'null' ? null : match[2].slice(1, -1);
  assert((bytes === null) === (digestValue === null), 'Partial issuer driver identity is forbidden');
  if (bytes !== null) { assert(Number.isSafeInteger(bytes) && bytes > 0); digest(digestValue); }
  if (actualDriver) assert.deepEqual({bytes, hash: digestValue}, identity(actualDriver),
    'Issuer executable literal must bind the actual retained driver manifest');
  const replacement = "export const HOST_DRIVER = Object.freeze({directory:'host-campaigns-v3',bytes:null,\n  hash:null});";
  const normalized = Buffer.from(source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length), 'utf8');
  return {data: normalized, bytes: normalized.length, hash: hash(normalized)};
}

// rawFiles have already been read and hashed as held inert bytes. Only the
// named template rows may replace their raw identities in this normalized view.
export function normalizeAlphaSourceManifest(value, {directory, rawFiles, normalizedRows, driverIdentity, normalizedDriverIdentity}) {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  assert(Array.isArray(value.files) && value.files.length > 0);
  assert(rawFiles instanceof Map && normalizedRows instanceof Map);
  const fixedDirectory = directory === 'host-campaigns-v3' ? 'loader/baseline.json' :
    directory === 'issuer-alpha-02' ? 'authority.mjs' : null;
  assert(fixedDirectory, 'Unknown alpha source-template directory');
  assert.deepEqual([...normalizedRows.keys()], [fixedDirectory], 'Source normalization row whitelist differs');
  assert.deepEqual([...rawFiles.keys()].sort(), value.files.map(row => row.path).sort());
  assert.equal(new Set(value.files.map(row => row.path)).size, value.files.length);
  // Preserve the raw reviewed order (historical manifests use locale order);
  // the final fixed normalized manifest identity binds that order exactly.
  for (const row of value.files) {
    assert.deepEqual(Object.keys(row).sort(), ['bytes', 'hash', 'path']);
    assert.deepEqual(identity(row), identity(rawFiles.get(row.path)), 'Raw source manifest file identity differs');
  }
  if (Object.hasOwn(value, 'fileCount')) assert.equal(value.fileCount, value.files.length);
  const total = value.files.reduce((n, row) => n + row.bytes, 0); assert(Number.isSafeInteger(total));
  if (Object.hasOwn(value, 'totalBytes')) assert.equal(value.totalBytes, total);
  const normalized = structuredClone(value);
  normalized.files = value.files.map(row => normalizedRows.has(row.path) ? {path: row.path, ...identity(normalizedRows.get(row.path))} : row);
  if (Object.hasOwn(value, 'totalBytes')) normalized.totalBytes = normalized.files.reduce((n, row) => n + row.bytes, 0);
  if (directory === 'issuer-alpha-02') {
    assert(driverIdentity && normalizedDriverIdentity);
    assert.deepEqual(value.hostDriver, {directory: 'host-campaigns-v3', ...identity(driverIdentity)},
      'Issuer source manifest must bind the actual retained driver manifest');
    normalized.hostDriver = {directory: 'host-campaigns-v3', ...identity(normalizedDriverIdentity)};
  } else {
    assert.equal(driverIdentity, undefined); assert.equal(normalizedDriverIdentity, undefined);
  }
  return normalized;
}
