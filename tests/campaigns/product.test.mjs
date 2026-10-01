import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, fileIdentity } from '../../tooling/qualification/campaigns/common.mjs';
import { verifyPreparedSource } from '../../tooling/qualification/campaigns/product.mjs';

const seal = files => ({ files, sha256: digest(JSON.stringify(files, null, 2) + '\n') });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'campaign-prepared-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/a.js'), 'export const a = 1;\n');
  await writeFile(join(root, 'src/b.js'), 'export const b = 2;\n');
  const files = await Promise.all(['src/a.js', 'src/b.js'].map(async path => ({ path, ...await fileIdentity(join(root, path)) })));
  return { root, files };
}

test('removing a subject file and resealing the smaller prepared manifest cannot certify that revision', async t => {
  const { root, files } = await fixture(t);
  await rm(join(root, 'src/b.js'));
  await assert.rejects(verifyPreparedSource(root, seal(files.slice(0, 1)), files), /complete applicable subject path inventory/);
});

test('complete subject inventory accepts deleted subject entries only when absent', async t => {
  const { root, files } = await fixture(t);
  const subject = [...files, { path: 'src/deleted.js', deleted: true }];
  assert.equal((await verifyPreparedSource(root, seal(files), subject)).files.length, 2);
  await writeFile(join(root, 'src/deleted.js'), 'unexpected restored source');
  await assert.rejects(verifyPreparedSource(root, seal(files), subject), /Unsealed prepared product source/);
});

test('source policy includes workflow and repository instruction bytes', async t => {
  const { root, files } = await fixture(t);
  const instructions = { path: 'AGENTS.md', bytes: 9, sha256: digest('policy\n') };
  await assert.rejects(verifyPreparedSource(root, seal(files), [...files, instructions]), /complete applicable subject path inventory/);
});
