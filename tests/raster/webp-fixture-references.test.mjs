// Small synthetic reference contracts only. These bytes cannot qualify a
// candidate, issuer, native decoder, fixture corpus, or complete capsule.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {declaredWebPFixtureEncoderReferences} from '../../tooling/raster/import-seals/webp-fixture-references.mjs';
import {createWebPAlphaProofReader} from '../../tooling/raster/import-seals/webp-alpha-proof.mjs';
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const ref = repositoryPath => ({repositoryPath, path: 'encoder/files/' + repositoryPath + '.data', bytes: 1, hash: hash('x')});
const fixture = () => ({schemaVersion: 1, kind: 'webp-host-fixtures-v1', encoder: {
  schemaVersion: 1, kind: 'webp-fixture-encoder-v1', files: [ref('node_modules/toy/index.js')],
  authority: {inputs: [ref('server/raster/codec-platform.ts'), ref('server/raster/identity.ts')]},
}});

test('only exact fixture schema enumerates retained encoder files and authority inputs', () => {
  const value = fixture(), rows = [...value.encoder.files, ...value.encoder.authority.inputs];
  assert.deepEqual(declaredWebPFixtureEncoderReferences(value), rows.map(({repositoryPath, ...row}) => row));
  assert.deepEqual(declaredWebPFixtureEncoderReferences({...value, schemaVersion: 2}), []);
  assert.deepEqual(declaredWebPFixtureEncoderReferences({...value, kind: 'unrelated-provenance'}), []);
});

test('fixture reference discovery refuses omitted inputs and provenance path escapes', () => {
  const missing = fixture(); delete missing.encoder.authority.inputs;
  assert.throws(() => declaredWebPFixtureEncoderReferences(missing));
  for (const path of ['../outside.data', '/outside.data', 'encoder/files/other.data']) {
    const value = fixture(); value.encoder.files[0].path = path;
    assert.throws(() => declaredWebPFixtureEncoderReferences(value));
  }
  const duplicate = fixture(); duplicate.encoder.files.push(duplicate.encoder.files[0]);
  assert.throws(() => declaredWebPFixtureEncoderReferences(duplicate), /Duplicate/);
});

test('an omitted fixture byte mapping is refused before any original-path access', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ie-alpha-missing-fixture-')));
  try {
    const qualificationHash = hash('synthetic qualification label only');
    const bytes = Buffer.from(JSON.stringify({schemaVersion: 2, qualificationHash, references: []}));
    writeFileSync(join(directory, 'proof-capsule.json'), bytes, {flag: 'wx', mode: 0o600});
    const proof = createWebPAlphaProofReader({directory, qualificationHash,
      manifest: {schemaVersion: 1, files: [{path: 'proof-capsule.json', bytes: bytes.length, hash: hash(bytes)}]},
      qualificationPath: '/never-open/qualification.json', proofReader: {read() { throw Error('unexpected outer read'); }}});
    const expected = declaredWebPFixtureEncoderReferences(fixture())[0];
    assert.throws(() => proof.get(qualificationHash, expected), /Missing exact original proof mapping/);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});
