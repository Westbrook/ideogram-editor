import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep, join } from 'node:path';
import test from 'node:test';
import { createBrowserPlan, browserReportOutcome, browserHarnessExclusions } from '../../tooling/qualification/container/browser-plan.mjs';

const output = resolve('artifacts/qualification-plan-test'), engines = ['chromium', 'firefox', 'webkit'];
for (const scope of ['base', 'features']) for (const selection of [...engines, 'all']) {
  test(`${scope}/${selection} has explicit prerequisites, isolated reports and each required assembly`, () => {
    const plan = createBrowserPlan({ selection, scope, output }), selected = selection === 'all' ? engines : [selection];
    assert.deepEqual(plan.selectedBrowsers, selected);
    assert.deepEqual(plan.requiredBrowsers, engines.filter(browser => selected.includes(browser) || browser === 'chromium'));
    assert.deepEqual(plan.extraBrowsers, selected.includes('chromium') ? [] : ['chromium']);
    assert.deepEqual(plan.prerequisites, ['build-app', 'build-server']);
    const browserSteps = plan.steps.filter(step => step.browser), ids = new Set();
    assert.equal(new Set(browserSteps.map(step => step.output)).size, browserSteps.length);
    for (const step of plan.steps) {
      assert.ok(!ids.has(step.id));
      for (const dependency of step.prerequisites ?? []) assert.ok(ids.has(dependency), `${step.id} precedes its fixture producer`);
      ids.add(step.id);
      if (!step.browser) continue;
      assert.ok(existsSync(step.config));
      assert.ok(step.files.length > 0);
      for (const file of step.files) { assert.ok(existsSync(file), file); assert.ok(step.args.includes(file)); }
      assert.ok(step.timeoutMs > 0);
      assert.ok(isAbsolute(step.output));
      const inside = relative(output, step.output);
      assert.ok(inside && !inside.startsWith(`..${sep}`) && !isAbsolute(inside));
      assert.equal(step.env.PLAYWRIGHT_JSON_OUTPUT_FILE, step.reportFile);
      assert.equal(step.env.QUALIFICATION_CASE_REPORT, step.caseReportFile);
      assert.equal(step.caseReportFile, join(step.output, 'cases.ndjson'));
      assert.ok(step.args.includes('list,json,./tooling/qualification/developer-campaigns/browser-reporter.mjs'));
    }
    for (const family of ['consumer', 'shell', 'projection', 'raster', 'history']) assert.equal(browserSteps.filter(s => s.family === family).length, 1);
    for (const browser of selected) {
      for (const family of ['text', 'editor-authoring', 'editor-export', 'editor-destination', 'editor-destination-cancellation', 'editor-destination-success', 'e1', 'density', 'spectrum', 'spectrum-appearance', 'spectrum-alignment']) assert.ok(ids.has(`${family}-${browser}`));
      assert.equal(browserSteps.filter(s => s.browser === browser && s.contracts.includes('E1')).length, 1);
      const renderer = browserSteps.find(s => s.id === `text-${browser}`);
      assert.equal(renderer.project, browser); assert.equal(renderer.args[renderer.args.indexOf('--project') + 1], browser);
      assert.deepEqual(renderer.files, ['tests/text/renderer.spec.ts', 'tests/text/budget-boundary.spec.ts']);
      assert.deepEqual(renderer.prerequisites, ['build-text-consumer']);
      assert.equal(renderer.env.TEXT_RECEIPT, renderer.output);
      const editor = browserSteps.find(s => s.id === `editor-owned-opfs-${browser}`);
      assert.equal(editor.args.includes('--grep-invert'), browser !== 'webkit');
      for (const family of ['e2', 'e3', 'e4', 'queue', 'request-review', 'request-mapping', 'request-theme', 'a11y', 'axe']) assert.equal(ids.has(`${family}-${browser}`), scope === 'features');
    }
    assert.equal(ids.has('adapters-chromium'), scope === 'features');
  });
}

test('full inventory admits every browser spec or its exact negative-test owner', () => {
  function specs(directory) {
    return readdirSync(directory, {withFileTypes: true}).flatMap(entry => entry.isDirectory() ? specs(`${directory}/${entry.name}`) : entry.name.endsWith('.spec.ts') ? [`${directory}/${entry.name}`] : []);
  }
  const selected = new Set(createBrowserPlan({selection:'all', scope:'features', output}).steps.flatMap(step => step.files));
  const negative = new Set(browserHarnessExclusions.map(entry => entry.file));
  assert.deepEqual(browserHarnessExclusions.map(({file, parent}) => ({file, parent})), [
    {file:'tests/recovery/owner-runner.spec.ts', parent:'tests/recovery/owner-runner.test.mjs'},
    {file:'tests/recovery/persistent-runner.spec.ts', parent:'tests/recovery/persistent-runner.test.mjs'},
  ], 'Only these two synthetic failure harnesses are delegated to their Node parents');
  assert.equal(negative.size, browserHarnessExclusions.length, 'Negative harness ownership must not be duplicated');
  for (const entry of browserHarnessExclusions) {
    assert.ok(existsSync(entry.file)); assert.ok(existsSync(entry.parent));
    assert.ok(entry.reason.trim()); assert.ok(!selected.has(entry.file));
  }
  assert.deepEqual([...selected, ...negative].sort(), specs('tests').sort(), 'Every live browser spec must be selected or have its exact documented executable parent; stale inventory entries also fail');
});

test('full plan runs every text and editor spec on all three pinned browser projects', () => {
  const plan = createBrowserPlan({selection:'all', scope:'features', output});
  const browserSteps = plan.steps.filter(step => step.browser);
  for (const directory of ['tests/text', 'tests/editor']) {
    const files = readdirSync(directory).filter(name => name.endsWith('.spec.ts')).map(name => `${directory}/${name}`);
    for (const file of files) for (const browser of engines) {
      const matches = browserSteps.filter(step => step.browser === browser && step.files.includes(file));
      assert.equal(matches.length, 1, `${file} must execute exactly once on ${browser}`);
      const step = matches[0];
      if (directory === 'tests/text') {
        assert.equal(step.config, 'tests/text/playwright.config.ts');
        assert.equal(step.project, browser);
        assert.equal(step.args[step.args.indexOf('--project') + 1], browser);
        assert.ok(step.prerequisites.includes('build-text-consumer'));
      } else {
        assert.equal(step.env.EDITOR_BROWSER, browser);
        assert.equal(step.env.EDITOR_RECEIPT, step.output);
      }
    }
  }
  for (const browser of engines) {
    const destinations = ['destination', 'destination-success', 'destination-cancellation', 'export'].map(name => browserSteps.find(step => step.id === `editor-${name}-${browser}`));
    assert.ok(destinations.every(Boolean));
    assert.equal(new Set(destinations.map(step => step.output)).size, 4, 'Download success, cancellation, boundaries and export retain independent evidence');
  }
});

test('browser plan refuses invalid selections and remains immutable', () => {
  const plan = createBrowserPlan({output});
  assert.equal(plan.scope, 'features'); assert.equal(plan.selection, 'chromium');
  assert.throws(() => createBrowserPlan({output, selection:'safari'}), /Select chromium/);
  assert.throws(() => createBrowserPlan({output, scope:'complete'}), /Select base or features/);
  assert.throws(() => createBrowserPlan({}), /output root/);
  assert.throws(() => createBrowserPlan({output:'bad\0path'}), /output root/);
  assert.throws(() => plan.steps[0].args.push('unexpected'), TypeError);
});

function report(files = ['tests/one.spec.ts', 'tests/two.spec.ts']) {
  return {stats:{expected:files.length, unexpected:0, flaky:0, skipped:0}, errors:[], suites:[{specs:files.map((file, i) => ({id:String(i), file, tests:[{projectName:'chromium', results:[{status:'passed'}]}]}))}]};
}
test('browser evidence rejects missing files, orphan cases, duplicate identities, absent results and count drift', () => {
  const good = report(), selection = {files:['tests/one.spec.ts','tests/two.spec.ts'], project:'chromium'};
  assert.equal(browserReportOutcome(good, selection).outcome, 'PASS');
  for (const mutate of [
    value => value.suites[0].specs.pop(),
    value => { value.suites[0].specs[1].file = 'tests/orphan.spec.ts'; },
    value => { value.suites[0].specs[1].id = '0'; },
    value => { value.suites[0].specs[0].tests[0].results = []; },
    value => { value.suites[0].specs[0].tests[0].projectName = 'webkit'; },
    value => { value.stats.expected = 3; },
  ]) {
    const invalid = structuredClone(good); mutate(invalid);
    assert.equal(browserReportOutcome(invalid, selection).outcome, 'INCONCLUSIVE');
  }
  for (const [field, value, outcome] of [['expected',0,'INCONCLUSIVE'],['skipped',1,'INCONCLUSIVE'],['unexpected',1,'FAIL'],['flaky',1,'FAIL']]) {
    assert.equal(browserReportOutcome({...good, stats:{...good.stats,[field]:value}}, selection).outcome, outcome);
  }
  assert.equal(browserReportOutcome({...good,errors:[{message:'cleanup failed'}]},selection).outcome,'FAIL');
  assert.throws(() => browserReportOutcome({stats:{expected:1},errors:[]}), /Incomplete/);
  assert.throws(() => browserReportOutcome({...good,suites:undefined},selection), /discovered suites/);
});
