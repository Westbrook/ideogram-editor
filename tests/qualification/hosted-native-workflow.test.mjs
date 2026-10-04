import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {qualificationTestPlan} from '../../tooling/qualification/test.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('hosted setup boundary owner is registered with the guarded qualification inventory', () => {
  const plan = qualificationTestPlan(root);
  assert(plan.files.includes('tests/qualification/hosted-native-workflow.test.mjs'));
  assert(plan.command.includes('./tests/session/no-egress.mjs'));
});

test('hosted setup authenticates job identity, fixed GCC11 selection and closed export boundaries', async t => {
  const {stdout, stderr} = await promisify(execFile)('python3', ['-I','-S','-B', join(root, 'tests/qualification/fixtures/hosted-setup-unit.py'), join(root, 'tooling/rollback-producer/hosted-setup.py')],
    {cwd: root, env: {PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1', LANG: 'C'}, timeout: 30_000, maxBuffer: 65536});
  const result = JSON.parse(stdout);
  assert.deepEqual(result, {tests: 65, failures: 0, errors: 0});
  t.diagnostic(stderr.trim());
});


test('standalone freezer probe enforces bounded nonroot and private-control refusals', async t => {
  const {stdout, stderr} = await promisify(execFile)('python3', ['-I','-S','-B', join(root, 'tests/qualification/fixtures/hosted-freezer-probe-unit.py'), join(root, 'tooling/rollback-producer/hosted-freezer-probe.py')],
    {cwd: root, env: {PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1', LANG: 'C'}, timeout: 30_000, maxBuffer: 65536});
  assert.deepEqual(JSON.parse(stdout), {tests: 18, failures: 0, errors: 0});
  t.diagnostic(stderr.trim());
});


test('standalone freezer probe remains outside the native producer source closure', async () => {
  const {readFile} = await import('node:fs/promises');
  const native = JSON.parse(await readFile(join(root, 'tooling/rollback-producer/hosted-sources.json'), 'utf8'));
  assert(!native.files.some(row => row.path.includes('hosted-freezer-probe')));
});
