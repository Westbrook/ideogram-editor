// Pure synthetic source-template tests, never accepted qualification evidence.
import assert from 'node:assert/strict';
import test from 'node:test';
import {normalizeAlphaIssuerAuthority, normalizeAlphaSourceManifest} from '../../tooling/raster/import-seals/webp-alpha-source-template.mjs';
const digest = digit => 'sha256:' + digit.repeat(64);
const source = (bytes, hash) => Buffer.from("// Synthetic inert declaration\nexport const HOST_DRIVER = Object.freeze({directory:'host-campaigns-v3',bytes:" + bytes + ",\n  hash:" + (hash === null ? 'null' : "'" + hash + "'") + "});\n");

test('issuer template normalizes only the exact reviewed driver identity literal', () => {
  const left = normalizeAlphaIssuerAuthority(source(4, digest('1')), {bytes: 4, hash: digest('1')});
  const right = normalizeAlphaIssuerAuthority(source(8, digest('2')), {bytes: 8, hash: digest('2')});
  assert.deepEqual(left, right);
  assert(left.data.equals(source(null, null)));
  assert.throws(() => normalizeAlphaIssuerAuthority(source(4, digest('1')), {bytes: 8, hash: digest('2')}), /actual retained driver/);
  assert.throws(() => normalizeAlphaIssuerAuthority(Buffer.from(source(4, digest('1')).toString().replace('host-campaigns-v3', 'host-campaigns-v4'))), /fixed-directory/);
  assert.throws(() => normalizeAlphaIssuerAuthority(Buffer.concat([source(4, digest('1')), source(4, digest('1'))])), /data slot/);
  assert.throws(() => normalizeAlphaIssuerAuthority(source(null, digest('1'))), /Partial/);
  const changed = normalizeAlphaIssuerAuthority(Buffer.concat([source(4, digest('1')), Buffer.from('throw Error("changed executable");\n')]));
  assert.notEqual(changed.hash, left.hash, 'Other executable bytes are never normalized');
});

test('source manifest normalization verifies raw identities and changes only induced rows and totals', () => {
  const raw = {schemaVersion: 1, kind: 'synthetic-driver-template', totalBytes: 6, fileCount: 2,
    files: [{path: 'loader/baseline.json', bytes: 4, hash: digest('1')}, {path: 'run.mjs', bytes: 2, hash: digest('2')}]};
  const inputs = {directory: 'host-campaigns-v3', rawFiles: new Map(raw.files.map(row => [row.path, row])),
    normalizedRows: new Map([['loader/baseline.json', {bytes: 3, hash: digest('3')}]])};
  const result = normalizeAlphaSourceManifest(raw, inputs);
  assert.equal(raw.totalBytes, 6); assert.equal(result.totalBytes, 5);
  assert.deepEqual(result.files[1], raw.files[1]); assert.equal(result.kind, raw.kind);
  const reviewedOrder = {...raw, files: [...raw.files].reverse()};
  const preserved = normalizeAlphaSourceManifest(reviewedOrder, inputs);
  assert.deepEqual(preserved.files.map(row => row.path), reviewedOrder.files.map(row => row.path),
    'Historical locale order is preserved for the fixed template hash, never sorted into another order');
  assert.throws(() => normalizeAlphaSourceManifest({...raw, totalBytes: 9}, inputs));
  assert.throws(() => normalizeAlphaSourceManifest(raw, {...inputs, normalizedRows: new Map([['run.mjs', {bytes: 3, hash: digest('3')}]])}), /whitelist/);
  assert.throws(() => normalizeAlphaSourceManifest(raw, {...inputs, rawFiles: new Map()}));
});

test('issuer manifest raw driver tuple must equal the actual retained driver before normalization', () => {
  const file = {path: 'authority.mjs', bytes: 4, hash: digest('1')};
  const raw = {files: [file], totalBytes: 4, hostDriver: {directory: 'host-campaigns-v3', bytes: 12, hash: digest('2')}};
  const inputs = {directory: 'issuer-alpha-02', rawFiles: new Map([['authority.mjs', file]]),
    normalizedRows: new Map([['authority.mjs', {bytes: 3, hash: digest('3')}]]),
    driverIdentity: {bytes: 12, hash: digest('2')}, normalizedDriverIdentity: {bytes: 8, hash: digest('4')}};
  const result = normalizeAlphaSourceManifest(raw, inputs);
  assert.deepEqual(result.hostDriver, {directory: 'host-campaigns-v3', bytes: 8, hash: digest('4')});
  assert.throws(() => normalizeAlphaSourceManifest(raw, {...inputs, driverIdentity: {bytes: 13, hash: digest('2')}}), /actual retained driver/);
});
