import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { retainBrowserEvidence } from '../../tooling/qualification/container/browser-evidence.mjs';
import { caseIdentity } from '../../tooling/qualification/developer-campaigns/selectors.mjs';

async function fixture(fn) {
  const output = await mkdtemp(join(tmpdir(), 'qualification-browser-evidence-'));
  const file = 'tests/one.spec.ts';
  const step = { files: [file], reportFile: join(output, 'browser.json'), caseReportFile: join(output, 'cases.ndjson') };
  const report = { stats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0 }, errors: [], suites: [{ specs: [{ id: 'one', file, tests: [{ projectName: '', results: [{ status: 'passed' }] }] }] }] };
  const cases = [{ type: 'discovery', ids: ['one'] }, { type: 'case', frameworkId: 'one', id: caseIdentity('B', file, 'actual case'), file, name: 'actual case', method: 'B', occurrence: 1, status: 'passed' }, { type: 'end', status: 'passed' }];
  try { await fn({ output, step, report, cases, write: async () => { await writeFile(step.reportFile, JSON.stringify(report)); await writeFile(step.caseReportFile, cases.map(value => JSON.stringify(value)).join('\n') + '\n'); } }); }
  finally { await rm(output, { recursive: true, force: true }); }
}

test('retained browser results require both independent JSON and exact discovered/completed case ledger', async () => fixture(async ({ output, step, write }) => {
  await write();
  const evidence = await retainBrowserEvidence(step, output);
  assert.equal(evidence.outcome, 'PASS'); assert.equal(evidence.browserCases.discovered, 1); assert.equal(evidence.browserCases.executed, 1); assert.equal(evidence.browserCases.skipped, 0);
  for (const [key, path] of [['browserReport', step.reportFile], ['browserCases', step.caseReportFile]]) {
    const bytes = await readFile(path);
    assert.equal(evidence[key].sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal((await stat(path)).mode & 0o222, 0);
  }
}));

test('failed browser run preserves hashes and failure counts instead of losing the report on nonzero exit', async () => fixture(async ({ output, step, write, report, cases }) => {
  report.stats.expected = 0; report.stats.unexpected = 1; report.suites[0].specs[0].tests[0].results[0].status = 'failed';
  cases[1].status = 'failed'; cases[2].status = 'failed'; await write();
  const evidence = await retainBrowserEvidence(step, output);
  assert.equal(evidence.outcome, 'FAIL'); assert.equal(evidence.browserReport.counts.unexpected, 1);
  assert.equal(evidence.browserCases.executed, 1); assert.equal(evidence.browserCases.passed, 0); assert.ok(evidence.browserCases.sha256);
}));

test('missing or malformed reporter output retains the other reporter and cannot pass', async () => fixture(async ({ output, step, write }) => {
  await write(); await writeFile(step.reportFile, '{malformed');
  const malformed = await retainBrowserEvidence(step, output);
  assert.equal(malformed.outcome, 'INCONCLUSIVE'); assert.ok(malformed.browserReport.sha256); assert.equal(malformed.browserCases.outcome, 'PASS');
  await rm(step.caseReportFile);
  const missing = await retainBrowserEvidence(step, output);
  assert.equal(missing.outcome, 'INCONCLUSIVE'); assert.ok(missing.failures.some(value => value.startsWith('browserCases:')));
}));

test('successful JSON exit summary cannot hide a missing discovered case completion', async () => fixture(async ({ output, step, write, cases }) => {
  cases[0].ids.push('missing'); await write();
  const evidence = await retainBrowserEvidence(step, output);
  assert.equal(evidence.browserReport.outcome, 'PASS'); assert.equal(evidence.outcome, 'FAIL');
  assert.ok(evidence.browserCases.reasons.includes('browser-discovery-completion-mismatch'));
}));
