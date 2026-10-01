import { join, resolve } from 'node:path';

const engines = ['chromium', 'firefox', 'webkit'];
const editorFiles = ['authoring', 'composition-save', 'composition', 'destination', 'destination-cancellation', 'destination-success', 'error-monitor', 'export', 'export-destination-commit', 'failures', 'integration-reads', 'interactions', 'journey', 'native-text', 'owned-opfs', 'portable', 'recovery', 'tool-rail'].map(name => `tests/editor/${name}.spec.ts`);
const textFiles = ['tests/text/renderer.spec.ts', 'tests/text/budget-boundary.spec.ts'];
const webkitBoundary = 'WebKit native profile sharing remains an environment negative and ephemeral OPFS is unavailable';
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
// These deliberately failing browser harnesses execute through Node parents,
// which assert their unsuccessful exits and cleanup. They are not product cases.
export const browserHarnessExclusions = freeze([
  { file: 'tests/recovery/owner-runner.spec.ts', parent: 'tests/recovery/owner-runner.test.mjs', reason: 'Synthetic teardown failures asserted by the Node parent.' },
  { file: 'tests/recovery/persistent-runner.spec.ts', parent: 'tests/recovery/persistent-runner.test.mjs', reason: 'Synthetic persistent-context failures asserted by the Node parent.' },
]);
function reportCases(report) {
  if (!Array.isArray(report.suites)) throw Error('Playwright result has no discovered suites');
  const cases = [];
  function visit(suite) {
    for (const spec of suite.specs ?? []) for (const result of spec.tests ?? []) {
      if (typeof spec.id !== 'string' || typeof spec.file !== 'string' || !Array.isArray(result.results)) throw Error('Incomplete Playwright case identity');
      cases.push({ id: `${spec.id}:${result.projectName ?? ''}`, file: spec.file.replaceAll('\\', '/'), project: result.projectName ?? '', result });
    }
    for (const child of suite.suites ?? []) visit(child);
  }
  report.suites.forEach(visit);
  return cases;
}
// The stable onBegin/onTestEnd ledger is checked separately by the runner.
// Also verify the independent Playwright JSON tree against every selected file.
export function browserReportOutcome(report, selection) {
  const stats = report?.stats, fields = ['expected', 'unexpected', 'flaky', 'skipped'];
  if (!stats || fields.some(field => !Number.isSafeInteger(stats[field]) || stats[field] < 0) || !Array.isArray(report.errors)) throw Error('Incomplete Playwright JSON result');
  const counts = Object.fromEntries(fields.map(field => [field, stats[field]])), problems = [];
  let discovered = null;
  if (selection) {
    if (!Array.isArray(selection.files) || !selection.files.length || new Set(selection.files).size !== selection.files.length) throw Error('Required browser files must be distinct and nonempty');
    const cases = reportCases(report); discovered = cases.length;
    if (new Set(cases.map(value => value.id)).size !== cases.length) problems.push('Duplicate discovered case identity');
    if (fields.reduce((n, key) => n + stats[key], 0) !== cases.length) problems.push('Summary count differs from discovered case tree');
    const matches = (actual, required) => actual === required || actual.endsWith('/' + required) || required.endsWith('/' + actual);
    for (const file of selection.files) if (!cases.some(value => matches(value.file, file))) problems.push(`Required file was not discovered: ${file}`);
    for (const value of cases) {
      if (!selection.files.some(file => matches(value.file, file))) problems.push(`Unexpected discovered file: ${value.file}`);
      if (selection.project && value.project !== selection.project) problems.push(`Unexpected project: ${value.project}`);
      if (!value.result.results.length) problems.push(`No result for discovered case: ${value.id}`);
    }
  }
  const outcome = report.errors.length || stats.unexpected || stats.flaky ? 'FAIL' : problems.length || !stats.expected || stats.skipped ? 'INCONCLUSIVE' : 'PASS';
  return { outcome, counts, discovered, errors: report.errors.length, problems };
}

// App/server builds are same-invocation prerequisites supplied by the shared
// functional runner. Fixture builds below execute before their consumers.
export function createBrowserPlan({ selection = 'chromium', scope = 'features', output, fixtureRoot = output, batchEditor = false, editorSelection = editorFiles } = {}) {
  if (![...engines, 'all'].includes(selection)) throw Error('Select chromium, firefox, webkit, or all');
  if (!['base', 'features'].includes(scope)) throw Error('Select base or features scope');
  if (typeof output !== 'string' || !output.trim() || output.includes('\0')) throw Error('A browser output root is required');
  if(!Array.isArray(editorSelection)||!editorSelection.length||new Set(editorSelection).size!==editorSelection.length||editorSelection.some(file=>!editorFiles.includes(file)))throw Error('Invalid editor batch selection');
  const fixtures = resolve(fixtureRoot);
  const root = resolve(output), selectedBrowsers = selection === 'all' ? [...engines] : [selection];
  const requiredBrowsers = engines.filter(engine => selectedBrowsers.includes(engine) || engine === 'chromium');
  const extraBrowsers = requiredBrowsers.filter(engine => !selectedBrowsers.includes(engine));
  const extraBrowserReasons = extraBrowsers.length ? { chromium: 'The public consumer, shell, recovery projection, raster and history fixtures require Chromium; feature scope also includes the adapter fixture.' } : {};
  const steps = [];
  function build(id, args, env = {}, fixtureOutput = null) {
    steps.push({ id, family: 'fixture-build', browser: null, executable: 'npm', args, config: null, files: [], env, outputRoot: fixtureOutput, output: fixtureOutput, reportFile: null, timeoutMs: 300_000 });
  }
  function playwright({ family, browser, config, files, env, destination, report = 'browser.json', project, args = [], contracts = [], reason, prerequisites = [] }) {
    const reportFile = join(destination, report), caseReportFile = join(destination, 'cases.ndjson');
    steps.push({ id: `${family}-${browser}`, family, browser, executable: 'npm',
      args: ['exec', '--', 'playwright', 'test', '--config', config, ...files, ...(project ? ['--project', project] : []), ...args,
        '--forbid-only', '--max-failures=1', '--reporter', 'list,json,./tooling/qualification/developer-campaigns/browser-reporter.mjs'],
      config, files, ...(project ? { project } : {}), env: { ...env, PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile, QUALIFICATION_CASE_REPORT: caseReportFile },
      outputRoot: Object.values(env).find(value => typeof value === 'string' && value.startsWith(root)) ?? destination,
      output: destination, reportFile, caseReportFile, timeoutMs: 1_800_000, contracts, prerequisites, reason });
  }
  build('build-consumer', ['run', 'build:consumer']);
  const consumer = join(root, 'consumer-chromium');
  playwright({ family: 'consumer', browser: 'chromium', config: 'tests/consumer/playwright.config.ts', files: ['tests/consumer/registration.spec.ts'], env: { IE_CONSUMER_OUTPUT: consumer }, destination: consumer, report: 'consumer-browser.json', prerequisites: ['build-consumer'], reason: 'Packed public component registration and lazy readiness.' });
  const shell = join(root, 'shell-chromium');
  playwright({ family: 'shell', browser: 'chromium', config: 'tests/browser/playwright.config.ts', files: ['tests/browser/shell.spec.ts'], env: { IE_SHELL_OUTPUT: shell }, destination: shell, report: 'shell-browser.json', reason: 'Complete shell, session, layout, keyboard, report-link and CSP suite.' });
  const recovery = join(fixtures, 'projection-chromium');
  build('build-recovery-consumer', ['exec', '--', 'vite', 'build', '--config', 'tests/recovery/vite.config.ts'], { IE_RECOVERY_OUTPUT: recovery }, join(recovery, 'browser-app'));
  playwright({ family: 'projection', browser: 'chromium', config: 'tests/recovery/playwright.config.ts', files: ['tests/recovery/consumer.spec.ts', 'tests/recovery/metadata.spec.ts'], env: { IE_RECOVERY_APP: join(recovery,'browser-app'), IE_RECOVERY_OUTPUT: join(root,'projection-chromium') }, destination: join(root, 'projection-chromium'), report: 'recovery-browser.json', prerequisites: ['build-recovery-consumer'], reason: 'Snapshot/tail/SSE projection and multi-tab recovery; deliberate failure harnesses remain in their Node parents.' });
  const history = join(root, 'history-chromium');
  playwright({ family: 'history', browser: 'chromium', config: 'tests/history/playwright.config.ts', files: ['tests/history/consumer.spec.ts'], env: { IE_HISTORY_OUTPUT: history, IE_RECOVERY_APP: join(recovery,'browser-app') }, destination: history, report: 'history-browser.json', prerequisites: ['build-recovery-consumer'], reason: 'Atomic image/history publication through the built recovery consumer.' });
  const raster = join(fixtures, 'raster-chromium');
  build('build-raster-consumer', ['exec', '--', 'vite', 'build', '--config', 'tests/raster/vite.config.ts'], { IE_RASTER_OUTPUT: raster }, join(raster, 'browser-app'));
  playwright({ family: 'raster', browser: 'chromium', config: 'tests/raster/playwright.config.ts', files: ['tests/raster/consumer.spec.ts'], env: { IE_RASTER_APP: join(raster,'browser-app'), IE_RASTER_OUTPUT: join(root,'raster-chromium') }, destination: join(root, 'raster-chromium'), report: 'browser-results.json', prerequisites: ['build-raster-consumer'], reason: 'Conversion review, approval, recovery and exact PNG content.' });
  const textApp = join(fixtures, 'text-app');
  build('build-text-consumer', ['exec', '--', 'vite', 'build', '--config', 'tests/text/vite.config.ts'], {TEXT_APP: textApp}, textApp);
  for (const browser of selectedBrowsers) {
    const display = join(root, `display-image-${browser}`);
    playwright({family: 'display-image', browser, config: 'tests/editor/display-image.config.ts', files: ['tests/editor/display-image.spec.ts'], env: {IE_DISPLAY_IMAGE_OUTPUT: display, EDITOR_BROWSER: browser, EDITOR_RECEIPT: display}, destination: display, report: 'results.json', project: browser, reason: 'Native image decoding and allocation through the dedicated display fixture.'});
    const text = join(root, `text-${browser}`);
    playwright({ family: 'text', browser, config: 'tests/text/playwright.config.ts', files: [...textFiles], env: { TEXT_RECEIPT: text, TEXT_APP: textApp }, destination: text, report: 'results.json', project: browser, prerequisites: ['build-text-consumer'], reason: 'Native shaping/rendering, actual 16 KiB/256-line and 14 KiB single-paragraph budget boundaries, worker admission, retained fonts and lifecycle.' });
    if (batchEditor) {
      const out=join(root, `editor-batch-${browser}`);
      playwright({family:'editor-batch',browser,config:'tests/editor/integration-regression.config.ts',files:[...editorSelection],
        env:{EDITOR_RECEIPT:out,EDITOR_BROWSER:browser,IE_VALIDATION_BATCH:'1'},destination:out,
        args:browser!=='webkit'?['--grep-invert',webkitBoundary+'$']:[],
        reason:'Development batch: serial files with per-spec evidence namespaces; persistent-profile and restart boundaries remain intact.'});
    } else {
    for (const file of editorFiles) {
      const family = 'editor-' + file.split('/').at(-1).replace('.spec.ts', ''), out = join(root, `${family}-${browser}`);
      playwright({ family, browser, config: 'tests/editor/integration-regression.config.ts', files: [file], env: { EDITOR_RECEIPT: out, EDITOR_BROWSER: browser }, destination: out,
        args: file.endsWith('/owned-opfs.spec.ts') && browser !== 'webkit' ? ['--grep-invert', webkitBoundary + '$'] : [],
        reason: 'Full editor regression selection with one isolated artifact root per spec. The explicitly WebKit-only environment specimen is selected on WebKit only.' });
    }
    }
    const e1 = join(root, `e1-${browser}`);
    playwright({ family: 'e1', browser, config: 'tests/editor/integration.config.ts', files: ['tests/editor/integration.spec.ts'], env: { EDITOR_RECEIPT: e1, EDITOR_BROWSER: browser }, destination: e1, contracts: ['E1'], reason: 'Integrated native text/image authoring, restart, complete copies, historical fonts and draft barriers.' });
    const density = join(root, `density-${browser}`);
    playwright({ family: 'density', browser, config: 'tests/browser/density.config.ts', files: ['tests/browser/density.spec.ts'], env: { DENSITY_OUTPUT: density, DENSITY_BROWSER: browser }, destination: join(density, 'focused', browser), report: 'results.json', reason: 'Persisted compact/comfortable density and automatic/light/dark appearance in the public editor.' });
    for (const [family, file, extra, folder] of [
      ['spectrum', 'spectrum-controls', { SPECTRUM_CONTROLS: '1' }, 'focused'],
      ['spectrum-appearance', 'spectrum', {}, 'full'],
      ['spectrum-alignment', 'spectrum-alignment', { SPECTRUM_FOCUSED: '1' }, 'full'],
    ]) {
      const out = join(root, `${family}-${browser}`);
      playwright({ family, browser, config: 'tests/browser/spectrum.config.ts', files: [`tests/browser/${file}.spec.ts`], env: { SPECTRUM_OUTPUT: out, SPECTRUM_BROWSER: browser, ...extra }, destination: join(out, folder, browser), report: 'results.json', reason: 'Complete public Spectrum control, appearance and layout selections.' });
    }
    if (scope === 'features') {
      for (const [family, config, file, contracts] of [
        ['request-review', 'tests/request/playwright.config.ts', 'tests/request/review.spec.ts', []],
        ['queue', 'tests/queue/playwright.config.ts', 'tests/queue/public.spec.ts', []],
        ['e2', 'tests/candidates/playwright.config.ts', 'tests/candidates/public.spec.ts', ['E2']],
        ['e3', 'tests/request-edits/playwright.config.ts', 'tests/request-edits/public.spec.ts', ['E3']],
        ['e4', 'tests/recovery/p25.config.ts', 'tests/recovery/e4.spec.ts', ['E4']],
      ]) {
        const out = join(root, `${family}-${browser}`);
        playwright({ family, browser, config, files: [file], env: { EDITOR_RECEIPT: out, EDITOR_BROWSER: browser }, destination: out, contracts, reason: 'Full controlled provider/request/candidate/mask/recovery browser assembly.' });
      }
      for (const probe of ['mapping', 'theme']) {
        const out = join(root, `request-${probe}-${browser}`);
        playwright({ family: `request-${probe}`, browser, config: 'tests/request/alignment.config.ts', files: ['tests/request/alignment.spec.ts'], env: { EDITOR_RECEIPT: out, EDITOR_BROWSER: browser, REVIEW_PROBE: probe }, destination: out, reason: 'Exercise each public request alignment/retained-draft probe branch.' });
      }
      for (const family of ['a11y', 'axe']) {
        const out = join(root, `${family}-${browser}`);
        playwright({ family, browser, config: `tests/qualification/${family}.config.ts`, files: family === 'axe' ? ['tests/qualification/axe.spec.ts', 'tests/qualification/axe-populated.spec.ts', 'tests/qualification/axe-recovery.spec.ts'] : ['tests/qualification/a11y.spec.ts'],
          env: { [family === 'axe' ? 'QUALIFICATION_AXE_OUTPUT' : 'QUALIFICATION_A11Y_OUTPUT']: out, QUALIFICATION_BROWSER: browser }, destination: join(out, 'focused', browser), report: 'results.json', contracts: ['AX-automated'], reason: 'All automated keyboard/accessibility states; native AT and manual adjudication remain separate.' });
      }
    }
  }
  if (scope === 'features') {
    const out = join(root, 'adapters-chromium');
    playwright({ family: 'adapters', browser: 'chromium', config: 'tests/adapters/browser.config.ts', files: ['tests/adapters/browser.spec.ts'], env: { ADAPTER_OUTPUT: out }, destination: join(out, 'chromium'), report: 'results.json', reason: 'Public adapter library, immutable review and dependency-aware deletion.' });
  }
  return freeze({ schema: 2, selection, scope, output: root, fixtureRoot: fixtures, selectedBrowsers, requiredBrowsers, extraBrowsers, extraBrowserReasons, steps: [...steps.filter(step => !step.config), ...steps.filter(step => step.config)],
    prerequisites: ['build-app', 'build-server'], exclusions: browserHarnessExclusions,
    limits: 'Full selected-engine automated inventory. No native AT/IME, physical PERF C/H, live-provider, training E5 or release qualification is implied. Actual discovery/counts and all outcomes are required.' });
}
