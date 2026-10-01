import test from 'node:test';
import assert from 'node:assert/strict';
import { qualificationTestPlan } from '../../tooling/qualification/test.mjs';

test('qualification npm entry recursively selects the closed tooling suite with its original network guard', () => {
  const plan = qualificationTestPlan();
  assert.ok(plan.files.includes('tests/qualification/campaigns/metrics.test.mjs'));
  assert.ok(plan.files.includes('tests/qualification/runner.test.mjs'));
  assert.ok(plan.files.includes('tests/qualification/test-entry.test.mjs'));
  assert.equal(new Set(plan.files).size, plan.files.length);
  assert.ok(plan.files.every(file => file.startsWith('tests/qualification/') && file.endsWith('.test.mjs')));
  assert.deepEqual(plan.command.slice(0, 6), ['node', '--import', './tests/session/no-egress.mjs', '--test', '--test-reporter=tap', '--test-concurrency=1']);
  assert.deepEqual(plan.dependencies, []);
});
