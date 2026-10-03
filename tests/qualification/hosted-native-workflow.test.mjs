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

test('hosted setup authenticates job identity, source paths and actual closed export boundaries', async t => {
  const {stdout, stderr} = await promisify(execFile)('python3', ['-I','-S','-B', join(root, 'tests/qualification/fixtures/hosted-setup-unit.py'), join(root, 'tooling/rollback-producer/hosted-setup.py')],
    {cwd: root, env: {PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1', LANG: 'C'}, timeout: 30_000, maxBuffer: 65536});
  const result = JSON.parse(stdout);
  assert.deepEqual(result, {tests: 17, failures: 0, errors: 0});
  t.diagnostic(stderr.trim());
});
