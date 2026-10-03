// Provisioning for explicit Fast CI selections; never a qualification result.
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import {join, posix, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseSync} from 'rolldown/utils';
import {developmentPlan} from './development-plan.mjs';
import {createBrowserPlan} from './container/browser-plan.mjs';
import {historyRequirements} from './container/inputs.mjs';

const hostedFiles = new Set([
  'tests/history/mask-text-compatibility.test.mjs',
  'tests/composition/retained-text.test.mjs',
  'tests/text-state/native.test.mjs',
  'tests/text-state/placement-text-compatibility.test.mjs',
]);
const priorPath = 'tests/text-state/prior-writer.mjs';
const directHistoryOwner = 'tests/history/returned-description.test.mjs';
const compilerPath = 'tooling/qualification/legacy-compiler.mjs';
const codePaths = ['server', 'src', 'tooling', 'tsconfig.server.json'];
const archivePaths = ['server', 'src', 'tests', 'tooling', 'tsconfig.server.json'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const fastSelectedJobMinutes = 180;
const setupReserveMs = 40 * 60_000, finalizationReserveMs = 15 * 60_000;

// Manual dispatch admits only these reviewed current-root editor families.
// Exact files, configurations and commands still come from the maintained plan.
export const fastBrowserFamilies = Object.freeze([
  'editor-authoring', 'editor-composition-save', 'editor-composition',
  'editor-destination', 'editor-destination-cancellation', 'editor-destination-success',
  'editor-error-monitor', 'editor-export', 'editor-export-destination-commit',
  'editor-failures', 'editor-image-import', 'editor-integration-reads',
  'editor-interactions', 'editor-journey', 'editor-native-text', 'editor-owned-opfs',
  'editor-portable', 'editor-recovery', 'editor-recovery-copy', 'editor-storage-library',
  'editor-tool-rail', 'editor-zoom-tool', 'editor-display-image',
  'editor-candidate-comparison', 'editor-document-creation', 'editor-command-search', 'e1',
]);
const fastBrowserEngines = ['chromium', 'firefox', 'webkit'];

function parsed(path, text) {
  // The pinned TypeScript 7 root export contains version metadata, not the
  // legacy compiler AST API. Use the same lock-pinned parser as preflight.
  const result = parseSync(path, text, {lang: 'js', sourceType: 'module'});
  if (result.errors?.length || result.program?.type !== 'Program') throw Error(`Historical declaration does not parse: ${path}`);
  return {fileName: path, program: result.program};
}
function calls(source, name) {
  const found = [], pending = [source.program];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node.type !== 'string') continue;
    if (node.type === 'CallExpression' && identifier(node.callee, name)) found.push(node);
    for (const [key, value] of Object.entries(node)) {
      if (['parent', 'tokens', 'comments', 'loc', 'range'].includes(key)) continue;
      if (Array.isArray(value)) pending.push(...value);
      else if (value && typeof value === 'object') pending.push(value);
    }
  }
  return found;
}
const identifier = (node, name) => node?.type === 'Identifier' && node.name === name;
const stringLiteral = node => node?.type === 'Literal' && typeof node.value === 'string';
const declarations = source => source.program.body.map(node => node.type === 'ExportNamedDeclaration' ? node.declaration : node).filter(Boolean);
const literalPaths = node => node?.type === 'ArrayExpression' && node.elements.every(stringLiteral) ? node.elements.map(item => item.value) : null;
function literalCommit(source, name) {
  const matches = declarations(source).filter(node => node.type === 'VariableDeclaration').flatMap(node => node.declarations).filter(node => identifier(node.id, name));
  const value = matches.length === 1 && matches[0].init;
  if (!stringLiteral(value) || !/^[a-f0-9]{40}$/.test(value.value)) throw Error(`Require one literal historical ${name} in ${source.fileName}`);
  return value.value;
}
function requireImport(path, source, name, target) {
  const imports = source.program.body.filter(node => node.type === 'ImportDeclaration' && stringLiteral(node.source) && posix.normalize(posix.join(posix.dirname(path), node.source.value)) === target);
  const bindings = imports.flatMap(node => node.specifiers).filter(node => node.type === 'ImportSpecifier');
  if (bindings.filter(node => identifier(node.local, name) && identifier(node.imported, name)).length !== 1) throw Error(`Historical ${name} import changed: ${path}`);
}
function directHistory(source) {
  requireImport(directHistoryOwner, source, 'compileLegacy', compilerPath);
  const uses = calls(source, 'compileLegacy'), args = uses[0]?.arguments;
  if (uses.length !== 1 || args.length !== 3 || !stringLiteral(args[1]) || !/^[a-f0-9]{40}$/.test(args[1].value) || !same(literalPaths(args[2]), codePaths)) throw Error('Direct historical compiler declaration changed');
  return {commit: args[1].value, paths: [...codePaths]};
}
function priorContract(source) {
  requireImport(priorPath, source, 'compileLegacy', compilerPath);
  const functions = declarations(source).filter(node => node.type === 'FunctionDeclaration' && identifier(node.id, 'priorWriter'));
  const parameters = functions[0]?.params, commit = parameters?.[1];
  if (functions.length !== 1 || parameters.length !== 2 || !identifier(parameters[0], 't') || commit?.type !== 'AssignmentPattern' || !identifier(commit.left, 'commit') || !identifier(commit.right, 'priorCommit')) throw Error('Historical priorWriter signature changed');
  const compile = calls(source, 'compileLegacy'), args = compile[0]?.arguments;
  if (compile.length !== 1 || args.length !== 3 || !identifier(args[1], 'commit') || !same(literalPaths(args[2]), archivePaths)) throw Error('Historical compiler archive closure changed');
  return literalCommit(source, 'priorCommit');
}
function requiredCommit(path, source, defaultCommit) {
  requireImport(path, source, 'priorWriter', priorPath);
  const uses = calls(source, 'priorWriter');
  const native = path === 'tests/text-state/native.test.mjs';
  if (!uses.length || uses.some(node => node.arguments.length !== (native ? 1 : 2) || !identifier(node.arguments[0], 't') || (!native && !identifier(node.arguments[1], 'oldCommit')))) throw Error(`Historical priorWriter call changed: ${path}`);
  return native ? defaultCommit : literalCommit(source, 'oldCommit');
}

// Pure admission: callers supply a real development plan and source text. No
// test module is imported, and no Git/browser action happens until this passes.
export function fastSetupPlan(plan, {sourceFor, history = historyRequirements} = {}) {
  const gates = plan.gates.map(gate => {
    if (!Number.isSafeInteger(gate.timeoutMs) || gate.timeoutMs <= 0) throw Error('Selected gate has no bounded deadline');
    const graceMs = gate.graceMs ?? 5_000;
    if (!Number.isSafeInteger(graceMs) || graceMs < 0) throw Error('Selected gate has invalid drain allowance');
    return {id: gate.id, timeoutMs: gate.timeoutMs, graceMs};
  });
  const gateBudgetMs = gates.reduce((sum, gate) => sum + gate.timeoutMs + gate.graceMs, 0);
  const totalBudgetMs = gateBudgetMs + setupReserveMs + finalizationReserveMs;
  if (!Number.isSafeInteger(totalBudgetMs) || totalBudgetMs > fastSelectedJobMinutes * 60_000) throw Error('Selected plan exceeds the 180-minute Fast CI budget; split the whole-file selection');
  if (plan.gates.some(gate => gate.freshFixtureFiles?.length)) throw Error('Fast CI does not provision genuine schema18 executable packets');
  const hosted = plan.gates.flatMap(gate => gate.browserPrerequisites?.files ?? []);
  if (hosted.some(file => !hostedFiles.has(file)) || plan.requiredBrowsers.some(engine => engine !== 'chromium')) throw Error('Selected Node-hosted browser prerequisite is not provisioned by Fast CI');
  if (Boolean(hosted.length) !== Boolean(plan.requiredBrowsers.length)) throw Error('Inconsistent selected browser prerequisites');
  const sources = [], historyInputs = [];
  const read = path => {
    const text = sourceFor(path), bytes = Buffer.from(text);
    sources.push({path, bytes: bytes.length, sha256: sha256(bytes)});
    return parsed(path, text);
  };
  const admit = (path, commit, paths) => {
    const matches = history.filter(row => row.commit === commit);
    if (matches.length !== 1 || !same(matches[0].paths, paths)) throw Error(`Historical commit or archive closure is not admitted: ${path}`);
    const prior = historyInputs.find(row => row.commit === commit);
    if (prior) { if (!same(prior.paths, paths)) throw Error('Conflicting historical archive closure'); prior.owners.push(path); }
    else historyInputs.push({commit, paths: [...paths], owners: [path]});
  };
  if (hosted.length) {
    const defaultCommit = priorContract(read(priorPath));
    for (const path of hosted) admit(path, requiredCommit(path, read(path), defaultCommit), archivePaths);
  }
  if (plan.selectedFiles.includes(directHistoryOwner)) {
    const {commit, paths} = directHistory(read(directHistoryOwner));
    admit(directHistoryOwner, commit, paths);
  }
  return {kind: 'fast-ci-selected-setup-1', qualification: false, selectedFiles: [...plan.selectedFiles], requiredBrowsers: [...plan.requiredBrowsers], gates,
    gateBudgetMs, setupReserveMs, finalizationReserveMs, totalBudgetMs, jobMinutes: fastSelectedJobMinutes, sources, history: historyInputs};
}
export function selectedFastSetup(root, nodeFiles) {
  if (!nodeFiles) throw Error('Fast prerequisite setup requires a nonempty explicit whole-file selection');
  const plan = developmentPlan(root, {groups: 'all', browsers: 'none', workers: 1, nodeFiles});
  return fastSetupPlan(plan, {sourceFor: path => readFileSync(join(root, path), 'utf8')});
}

function objectProperty(node, name, required = true) {
  if (!['ObjectExpression', 'ObjectPattern'].includes(node?.type) || node.properties.some(item => item.type !== 'Property' || item.computed || item.method || item.kind !== 'init')) throw Error('Browser deadline options must remain explicit');
  const matches = node.properties.filter(item => identifier(item.key, name) || stringLiteral(item.key) && item.key.value === name);
  if (matches.length > 1 || required && matches.length !== 1) throw Error('Browser deadline property differs: ' + name);
  return matches[0]?.value;
}
function positiveLiteral(node, label) {
  if (node?.type !== 'Literal' || !Number.isSafeInteger(node.value) || node.value <= 0) throw Error('Browser deadline must be a positive literal: ' + label);
  return node.value;
}
function browserDeadlineLimits(sourceFor) {
  const sources = [];
  const read = path => {
    const text = sourceFor(path), bytes = Buffer.from(text);
    sources.push({path, bytes: bytes.length, sha256: sha256(bytes)});
    return parsed(path, text);
  };
  const child = read('tooling/qualification/container/bounded-child.mjs');
  const declarationsOfChild = declarations(child).filter(node => node.type === 'FunctionDeclaration' && identifier(node.id, 'boundedChild'));
  if (declarationsOfChild.length !== 1 || declarationsOfChild[0].params.length !== 3) throw Error('Bounded child deadline signature changed');
  const grace = objectProperty(declarationsOfChild[0].params[2], 'graceMs');
  if (grace?.type !== 'AssignmentPattern' || !identifier(grace.left, 'graceMs')) throw Error('Bounded child grace declaration changed');
  const defaultGraceMs = positiveLiteral(grace.right, 'default grace');
  const settling = calls(child, 'pause').filter(call => call.arguments[0]?.type === 'Literal');
  if (settling.length !== 1 || settling[0].arguments.length !== 1) throw Error('Bounded child exit observation changed');
  const exitObservationMs = positiveLiteral(settling[0].arguments[0], 'exit observation');
  const gateRunner = read('tooling/qualification/run.mjs');
  const gateCalls = calls(gateRunner, 'boundedChild').filter(call => identifier(call.arguments[0], 'command'));
  if (gateCalls.length !== 1 || gateCalls[0].arguments.length !== 3) throw Error('Gate child deadline call changed');
  const gateGrace = objectProperty(gateCalls[0].arguments[2], 'graceMs');
  if (gateGrace?.type !== 'LogicalExpression' || gateGrace.operator !== '??' || gateGrace.left?.type !== 'MemberExpression' || gateGrace.left.computed || !identifier(gateGrace.left.object, 'gate') || !identifier(gateGrace.left.property, 'graceMs')) throw Error('Gate grace declaration changed');
  const gateGraceMs = positiveLiteral(gateGrace.right, 'gate grace');
  const runner = read('tooling/qualification/development.mjs');
  const issuers = calls(runner, 'prepareCompletionIssuersChild'), browsers = calls(runner, 'boundedChild');
  if (issuers.length !== 1 || issuers[0].arguments.length !== 3 || browsers.length !== 1 || browsers[0].arguments.length !== 3) throw Error('Browser child deadline calls changed');
  const issuerTimeoutMs = positiveLiteral(objectProperty(issuers[0].arguments[2], 'timeoutMs'), 'issuer timeout');
  const browserGrace = objectProperty(browsers[0].arguments[2], 'graceMs', false);
  const preparation = read('tooling/qualification/completion-issuers/prepare-child.mjs');
  const children = calls(preparation, 'runChild');
  if (children.length !== 1 || children[0].arguments.length !== 3) throw Error('Issuer child deadline call changed');
  const issuerGrace = objectProperty(children[0].arguments[2], 'graceMs', false);
  // Preparation caps its own work at the requested timeout. The full requested
  // interval is conservative; the ordinary finalization reserve covers sealing.
  return {sources, gateGraceMs, exitObservationMs, browserGraceMs: browserGrace ? positiveLiteral(browserGrace, 'browser grace') : defaultGraceMs,
    issuerTimeoutMs, issuerGraceMs: issuerGrace ? positiveLiteral(issuerGrace, 'issuer grace') : defaultGraceMs};
}

export function fastBrowserSetupPlan(plan, {sourceFor} = {}) {
  if (plan.groups !== 'preflight' || plan.nodeFiles !== null || plan.selectedFiles.length || plan.workers !== 1 || plan.batchEditor || plan.browserGrep !== null || !fastBrowserFamilies.includes(plan.browserGroups) || !fastBrowserEngines.includes(plan.browsers)) throw Error('Choose one reviewed whole editor family and one engine, without Node selection, batching or grep');
  if (plan.gates.some(gate => gate.files?.length || gate.freshFixtureFiles?.length || gate.browserPrerequisites || gate.completionPrerequisites)) throw Error('Browser dispatch does not provision Node or legacy packet fixtures');
  const full = createBrowserPlan({selection: plan.browsers, scope: 'features', output: plan.browserPlan?.output});
  const tests = full.steps.filter(step => step.config && step.family === plan.browserGroups);
  if (tests.length !== 1 || tests[0].browser !== plan.browsers) throw Error('Reviewed browser family no longer selects one engine');
  const fixtures = new Set(tests.flatMap(step => step.prerequisites));
  const steps = full.steps.filter(step => fixtures.has(step.id) || step.id === tests[0].id);
  if (!same(plan.browserPlan.steps, steps) || !same(plan.requiredBrowsers, [plan.browsers])) throw Error('Browser dispatch must preserve the complete maintained family and fixture plan');
  const limits = browserDeadlineLimits(sourceFor);
  const budget = (items, graceMs, override = false) => items.map(item => {
    if (!Number.isSafeInteger(item.timeoutMs) || item.timeoutMs <= 0) throw Error('Selected browser plan has no bounded deadline');
    const grace = override ? item.graceMs ?? graceMs : graceMs;
    if (!Number.isSafeInteger(grace) || grace <= 0) throw Error('Selected browser plan has invalid drain allowance');
    return {id: item.id, timeoutMs: item.timeoutMs, graceMs: grace, exitObservationMs: limits.exitObservationMs};
  });
  const gates = budget(plan.gates, limits.gateGraceMs, true), browserSteps = budget(steps, limits.browserGraceMs);
  const needsIssuers = steps.some(step => step.config && !['consumer', 'editor-display-image', 'text', 'projection', 'history', 'raster'].includes(step.family));
  if (plan.gates.some(gate => gate.id === 'completion-source') !== needsIssuers) throw Error('Browser issuer prerequisite changed');
  const issuers = needsIssuers ? [{id: 'browser-completion-issuers', timeoutMs: limits.issuerTimeoutMs, graceMs: limits.issuerGraceMs, exitObservationMs: limits.exitObservationMs}] : [];
  const total = rows => rows.reduce((sum, row) => sum + row.timeoutMs + row.graceMs + row.exitObservationMs, 0);
  const gateBudgetMs = total(gates), browserBudgetMs = total(browserSteps), issuerBudgetMs = total(issuers);
  const totalBudgetMs = gateBudgetMs + browserBudgetMs + issuerBudgetMs + setupReserveMs + finalizationReserveMs;
  if (!Number.isSafeInteger(totalBudgetMs) || totalBudgetMs > fastSelectedJobMinutes * 60_000) throw Error('Selected browser plan exceeds the 180-minute Fast CI budget');
  return {kind: 'fast-ci-browser-setup-1', qualification: false, family: plan.browserGroups, engine: plan.browsers,
    selectedFiles: tests.flatMap(step => step.files), requiredBrowsers: [...plan.requiredBrowsers], gates, browserSteps, issuers,
    gateBudgetMs, browserBudgetMs, issuerBudgetMs, setupReserveMs, finalizationReserveMs, totalBudgetMs, jobMinutes: fastSelectedJobMinutes,
    sources: limits.sources, history: []};
}
export function selectedFastBrowserSetup(root, family, engine) {
  if (!fastBrowserFamilies.includes(family) || !fastBrowserEngines.includes(engine)) throw Error('Choose one reviewed whole editor family and one engine');
  const plan = developmentPlan(root, {groups: 'preflight', browsers: engine, browserGroups: family, workers: 1, batchEditor: false, output: join(root, 'artifacts/validation/run/browser')});
  return fastBrowserSetupPlan(plan, {sourceFor: path => readFileSync(join(root, path), 'utf8')});
}
export function selectedFastDispatchSetup(root, environment) {
  const nodeFiles = environment.SELECTED_NODE_FILES ?? '', family = environment.SELECTED_BROWSER_FAMILY ?? 'none';
  if (family !== '' && family !== 'none') {
    if (nodeFiles !== '') throw Error('Choose either whole Node files or one whole browser family');
    return selectedFastBrowserSetup(root, family, environment.SELECTED_BROWSER);
  }
  return selectedFastSetup(root, nodeFiles);
}

export function provisionFastBrowserSetup(root, plan, {execute = execFileSync, record = () => {}} = {}) {
  if (plan.kind !== 'fast-ci-browser-setup-1' || !fastBrowserFamilies.includes(plan.family) || !fastBrowserEngines.includes(plan.engine) || !same(plan.requiredBrowsers, [plan.engine]) || plan.history.length) throw Error('Reviewed browser provisioning selection required');
  const receipt = {kind: 'fast-ci-browser-provisioning-1', qualification: false, plan, status: 'PENDING', browser: null};
  record(receipt);
  try {
    const args = [join(root, 'node_modules/playwright/cli.js'), 'install', '--with-deps', plan.engine];
    execute(process.execPath, args, {cwd: root, timeout: 7 * 60_000, stdio: 'inherit'});
    receipt.browser = {command: [process.execPath, ...args], status: 'PASS'};
    receipt.status = 'PASS';
  } catch (error) {
    receipt.status = 'FAIL'; receipt.error = String(error); throw error;
  } finally { record(receipt); }
  return receipt;
}

export function provisionFastSetup(root, plan, {execute = execFileSync, record = () => {}} = {}) {
  const receipt = {kind: 'fast-ci-selected-provisioning-1', qualification: false, plan, status: 'PENDING', history: [], browser: null};
  const env = {...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0'};
  const git = (args, timeout = 60_000) => execute('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args], {env, timeout, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']});
  const head = () => git(['rev-parse', '--verify', 'HEAD']).toString().trim();
  receipt.headBefore = head(); record(receipt);
  try {
    for (const item of plan.history) {
      // Fetch exactly the reviewed commit; never broaden to full history or a
      // guessed replacement when a remote no longer exposes that object.
      git(['fetch', '--no-tags', '--depth=1', '--no-recurse-submodules', 'origin', item.commit], 120_000);
      if (git(['cat-file', '-t', item.commit]).toString().trim() !== 'commit') throw Error('Fetched historical input is not a commit');
      const archive = git(['archive', '--format=tar', item.commit, '--', ...item.paths]);
      receipt.history.push({...item, archive: {bytes: archive.length, sha256: sha256(archive)}}); record(receipt);
    }
    if (plan.requiredBrowsers.length) {
      // npm ci installed this exact lockfile-pinned CLI. No npx download or
      // alternative browser binary is permitted by this setup path.
      const args = [join(root, 'node_modules/playwright/cli.js'), 'install', '--with-deps', 'chromium'];
      execute(process.execPath, args, {cwd: root, timeout: 7 * 60_000, stdio: 'inherit'});
      receipt.browser = {command: [process.execPath, ...args], status: 'PASS'};
    }
    receipt.status = 'PASS';
  } catch (error) {
    receipt.status = 'FAIL'; receipt.error = String(error); throw error;
  } finally {
    try {
      receipt.headAfter = head();
      if (receipt.headAfter !== receipt.headBefore) throw Error('Historical provisioning changed current HEAD');
    } catch (error) {
      receipt.status = 'FAIL'; receipt.error ??= String(error); throw error;
    } finally { record(receipt); }
  }
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[2] && resolve(process.argv[2]);
  if (!output || process.argv.length !== 3) throw Error('Usage: fast-ci-setup.mjs <provisioning-receipt.json>');
  const root = resolve('.'), plan = selectedFastDispatchSetup(root, process.env);
  const provision = plan.kind === 'fast-ci-browser-setup-1' ? provisionFastBrowserSetup : provisionFastSetup;
  provision(root, plan, {record: receipt => writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n')});
}
