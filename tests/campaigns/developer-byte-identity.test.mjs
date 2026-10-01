import test from 'node:test';
import assert from 'node:assert/strict';
import { digestJSON } from '../../tooling/qualification/core.mjs';
import { digest } from '../../tooling/qualification/campaigns/common.mjs';
import { developerPostBuildIdentity, verifyDeveloperBuildObservation } from '../../tooling/qualification/campaigns/developer-byte-verification.mjs';

const json = value => JSON.stringify(value, null, 2) + '\n';
const file = (path, text) => ({ path, bytes: Buffer.byteLength(text), sha256: digest(text).slice(7) });
function specimen() {
  const files = [file('package.json', '{"type":"module"}'), file('src/main.ts', 'export const value = 1;')];
  const source = { head: 'a'.repeat(40), files, digest: digestJSON(files) };
  const artifacts = { files: [file('app/assets/main.js', 'const value=1;'), file('local/server/main.js', 'export {};')] };
  artifacts.sha256 = digest(json(artifacts.files)).slice(7);
  return { source, artifacts };
}
function reseal(artifacts) { artifacts.sha256 = digest(json(artifacts.files)).slice(7); }

test('developer byte identities use the independent post-build manifest with explicit dist paths', () => {
  const { artifacts, source } = specimen();
  // Neither a pre-command build identity nor the claimed D11 inventory is an
  // input to the independent identity adapter.
  artifacts.d11 = { inventory: { files: [{ file: 'assets/forged.js', rawBytes: 0 }] } };
  const actual = developerPostBuildIdentity(artifacts, source);
  assert.deepEqual(actual.buildFiles, artifacts.files.map(row => ({ ...row, path: 'dist/' + row.path, sha256: 'sha256:' + row.sha256 })));
  assert.equal(actual.sourceFiles, source.files);
  assert.equal(actual.buildFiles.some(row => row.path.includes('forged')), false);
});

test('developer byte identities reject edited post-build files without their independent manifest seal', () => {
  for (const edit of [value => value.files[0].bytes++, value => { value.files[0].sha256 = 'b'.repeat(64); }, value => value.files.pop()]) {
    const { artifacts, source } = specimen(); edit(artifacts);
    assert.throws(() => developerPostBuildIdentity(artifacts, source), /manifest.*unsealed/);
  }
});

test('developer byte identities reject unsafe, duplicated and malformed paths even if resealed', () => {
  const mutations = [
    value => { value.files[0].path = '../app/main.js'; },
    value => { value.files[0].path = '/app/main.js'; },
    value => { value.files[0].path = 'C:/app/main.js'; },
    value => { value.files[0].path = 'app\\main.js'; },
    value => { value.files[0].path = 'app//main.js'; },
    value => { value.files[0].path = 'app/./main.js'; },
    value => { value.files[0].path = 'app/\u0000main.js'; },
    value => { value.files[0].bytes = -1; },
    value => { value.files[0].sha256 = 'sha256:' + value.files[0].sha256; },
    value => { value.files.push({ ...value.files[0] }); },
  ];
  for (const mutate of mutations) {
    const { artifacts, source } = specimen(); mutate(artifacts); reseal(artifacts);
    assert.throws(() => developerPostBuildIdentity(artifacts, source), Error);
  }
});

test('developer byte identities require actual post-build app and server output inventories', () => {
  for (const prefix of ['app/', 'local/']) {
    const { artifacts, source } = specimen();
    artifacts.files = artifacts.files.filter(row => row.path.startsWith(prefix)); reseal(artifacts);
    assert.throws(() => developerPostBuildIdentity(artifacts, source), /both actual post-build app and server/);
  }
});

test('developer byte identities retain the exact subject source seal and reject malformed resealed subjects', () => {
  const changes = [
    value => { value.files[0].bytes++; },
    value => { value.files.push({ ...value.files[0] }); value.digest = digestJSON(value.files); },
    value => { value.files[0].path = '../package.json'; value.digest = digestJSON(value.files); },
    value => { value.files[0].sha256 = 'invalid'; value.digest = digestJSON(value.files); },
  ];
  for (const mutate of changes) {
    const { artifacts, source } = specimen(); mutate(source);
    assert.throws(() => developerPostBuildIdentity(artifacts, source), Error);
  }
});

test('passing developer builds cannot omit a retained D11 audit while earlier failures remain reportable', async () => {
  for (const id of ['C2/production-build', 'I1/command-groups']) {
    const cell = { id, handler: 'developer' };
    await assert.rejects(verifyDeveloperBuildObservation({ cell, attempt: { status: 'PASS', result: {} } }), /lacks its retained D11 audit/);
    assert.deepEqual(await verifyDeveloperBuildObservation({ cell, attempt: { status: 'FAIL', result: null } }),
      { verified: false, reason: 'Build did not produce a D11 observation' });
  }
});
