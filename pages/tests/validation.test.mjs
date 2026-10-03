import test from 'node:test';
import assert from 'node:assert/strict';
import { pagesBrowserOutcome } from '../../tooling/pages/validate.mjs';

// A small Playwright JSON tree, including its nested file/describe suites. These
// observations exercise the actual Pages admission function, not a test copy.
function report() {
  const projects = ['chromium', 'firefox', 'webkit'];
  return {
    stats: { expected: 45, unexpected: 0, flaky: 0, skipped: 0 }, errors: [],
    suites: [['preview', 10], ['editor', 5]].map(([name, count]) => ({
      title: `${name}.spec.ts`, file: `pages/tests/${name}.spec.ts`, specs: [],
      suites: [{ title: 'Public Pages behavior', specs: Array.from({ length: count }, (_, index) => ({
        id: `${name}-${index}`, title: `${name} case ${index}`, file: `pages/tests/${name}.spec.ts`,
        tests: projects.map(projectName => ({ projectName, expectedStatus: 'passed', status: 'expected',
          results: [{ status: 'passed', retry: 0, duration: 1, errors: [] }] })),
      })), suites: [] }],
    })),
  };
}
const specs = value => value.suites.flatMap(suite => suite.suites[0].specs);
const cases = value => specs(value).flatMap(spec => spec.tests);
const refuses = (value, label) => assert.notEqual(pagesBrowserOutcome(value).outcome, 'PASS', label);

test('Pages admission accepts both complete views once in every required engine', () => {
  const value = report(), result = pagesBrowserOutcome(value);
  assert.equal(result.outcome, 'PASS');
  assert.equal(result.discovered, 45);
  assert.deepEqual(result.counts, { expected: 45, unexpected: 0, flaky: 0, skipped: 0 });
  assert.deepEqual(result.problems, []);
  for (const engine of ['chromium', 'firefox', 'webkit']) {
    assert.equal(result.inventory[engine]['pages/tests/preview.spec.ts'], 10);
    assert.equal(result.inventory[engine]['pages/tests/editor.spec.ts'], 5);
  }
  // Playwright may retain absolute paths and Windows separators in its report.
  for (const spec of specs(value)) spec.file = 'C:\\checkout\\' + spec.file.replaceAll('/', '\\');
  assert.equal(pagesBrowserOutcome(value).outcome, 'PASS');
});

test('Pages admission refuses an omitted view, engine or individual case even with honest totals', () => {
  const view = report(); view.suites.pop(); view.stats.expected = 30;
  refuses(view, 'editor view missing');
  const engine = report(); for (const spec of specs(engine)) spec.tests.pop(); engine.stats.expected = 30;
  refuses(engine, 'WebKit missing');
  const individual = report(); specs(individual)[0].tests.pop(); individual.stats.expected = 44;
  refuses(individual, 'one discovered result missing');
});

test('Pages admission refuses unexpected files and engines despite a passing summary', () => {
  const extraFile = report(); specs(extraFile)[0].file = 'pages/tests/other.spec.ts';
  refuses(extraFile, 'unexpected file replaces a required file');
  const extraEngine = report(); cases(extraEngine)[0].projectName = 'another-engine';
  refuses(extraEngine, 'unexpected engine replaces Chromium');
  const extraCase = report(), duplicate = structuredClone(specs(extraCase)[0]);
  duplicate.id = 'extra-case'; extraCase.suites[0].suites[0].specs.push(duplicate); extraCase.stats.expected = 48;
  refuses(extraCase, 'additional passing cases are not the required inventory');
});

test('Pages admission refuses swapped per-view or per-engine counts with forty-five passes', () => {
  const views = report(); specs(views)[0].file = 'pages/tests/editor.spec.ts';
  assert.equal(cases(views).length, 45); refuses(views, 'nine preview and six editor cases per engine');
  const engines = report(); specs(engines)[0].tests[0].projectName = 'webkit';
  assert.equal(cases(engines).length, 45); refuses(engines, 'Chromium result replaced by extra WebKit result');
});

test('Pages admission refuses skipped, flaky, failed and report-error observations', () => {
  const skipped = report(); skipped.stats.expected--; skipped.stats.skipped++;
  cases(skipped)[0].status = 'skipped'; cases(skipped)[0].results[0].status = 'skipped'; refuses(skipped, 'skipped');
  const flaky = report(); flaky.stats.expected--; flaky.stats.flaky++;
  cases(flaky)[0].status = 'flaky'; cases(flaky)[0].results.unshift({ status: 'failed', retry: 0 });
  cases(flaky)[0].results[1].retry = 1; assert.equal(pagesBrowserOutcome(flaky).outcome, 'FAIL');
  const failed = report(); failed.stats.expected--; failed.stats.unexpected++;
  cases(failed)[0].status = 'unexpected'; cases(failed)[0].results[0].status = 'failed';
  assert.equal(pagesBrowserOutcome(failed).outcome, 'FAIL');
  const error = report(); error.errors.push({ message: 'Browser owner did not close' });
  assert.equal(pagesBrowserOutcome(error).outcome, 'FAIL');
});

test('Pages admission checks actual single-pass results independently of success counters', () => {
  for (const [label, mutate] of [
    ['missing result', value => { value.results = []; }],
    ['duplicate result', value => { value.results.push(structuredClone(value.results[0])); }],
    ['retry', value => { value.results[0].retry = 1; }],
    ['actual failure', value => { value.results[0].status = 'failed'; }],
    ['expected failure', value => { value.expectedStatus = 'failed'; }],
    ['unexpected classification', value => { value.status = 'unexpected'; }],
  ]) {
    const value = report(); mutate(cases(value)[0]); refuses(value, label);
  }
});

test('Pages admission refuses duplicate case identities and malformed report structure', () => {
  const duplicate = report(); specs(duplicate)[1].id = specs(duplicate)[0].id;
  refuses(duplicate, 'duplicate identities cannot stand in for distinct cases');
  for (const field of ['stats', 'errors', 'suites']) {
    const value = report(); delete value[field]; assert.throws(() => pagesBrowserOutcome(value), undefined, field);
  }
  const summary = report(); summary.stats.expected = 46; refuses(summary, 'summary does not match tree');
});
