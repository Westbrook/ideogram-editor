// Provisioning for explicit Fast CI selections; never a qualification result.
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import {lstat, mkdir, mkdtemp, open, chmod, link, unlink, rmdir} from 'node:fs/promises';
import {get as httpsGet} from 'node:https';
import {join, dirname, posix, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseSync} from 'rolldown/utils';
import {developmentPlan} from './development-plan.mjs';
import {createBrowserPlan} from './container/browser-plan.mjs';
import {historyRequirements, fixtureRequirements, adapterSourceURL, verifyAdapterFixture} from './container/inputs.mjs';
import {rendererReceiptOwner, rendererReceiptRequirement} from './r18-ci-inputs.mjs';

const historicalHostedFiles = new Set([
  'tests/history/mask-text-compatibility.test.mjs',
  'tests/composition/retained-text.test.mjs',
  'tests/text-state/native.test.mjs',
  'tests/text-state/placement-text-compatibility.test.mjs',
]);
// Current-root negative harnesses use the pinned Playwright runner with synthetic
// handles. Retain the maintained Chromium prerequisite, without legacy history.
const currentRecoveryHostedFiles = new Set([
  'tests/recovery/owner-runner.test.mjs',
  'tests/recovery/persistent-runner.test.mjs',
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

// Manual dispatch admits only these reviewed current-root whole families.
// The existing adapters and shell configurations are Chromium-only; no engine is substituted.
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
  'request-review', 'request-v45-generation', 'request-v45-edit', 'queue', 'e2', 'e3', 'e4', 'adapters', 'text', 'shell',
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
  const hostedGates = plan.gates.filter(gate => gate.browserPrerequisites);
  const hosted = hostedGates.flatMap(gate => gate.browserPrerequisites.files);
  if (hosted.some(file => !historicalHostedFiles.has(file) && !currentRecoveryHostedFiles.has(file)) || plan.requiredBrowsers.some(engine => engine !== 'chromium')) throw Error('Selected Node-hosted browser prerequisite is not provisioned by Fast CI');
  if (!same(plan.requiredBrowsers, hosted.length ? ['chromium'] : []) || new Set(hosted).size !== hosted.length ||
      hostedGates.some(gate => !same(gate.browserPrerequisites.engines, ['chromium']) || !same(gate.browserPrerequisites.files, gate.files)) ||
      hosted.some(file => !plan.selectedFiles.includes(file))) throw Error('Inconsistent selected browser prerequisites');
  const historicalHosted = hosted.filter(file => historicalHostedFiles.has(file));
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
  if (historicalHosted.length) {
    const defaultCommit = priorContract(read(priorPath));
    for (const path of historicalHosted) admit(path, requiredCommit(path, read(path), defaultCommit), archivePaths);
  }
  if (plan.selectedFiles.includes(directHistoryOwner)) {
    const {commit, paths} = directHistory(read(directHistoryOwner));
    admit(directHistoryOwner, commit, paths);
  }
  const adapterOwners = plan.selectedFiles.filter(path => path.startsWith('tests/adapters/'));
  let adapterFixture = null;
  if (adapterOwners.length) {
    read('tooling/qualification/container/inputs.mjs');
    adapterFixture = {...publicAdapterRequirement(), owners: adapterOwners};
  }
  return {kind: 'fast-ci-selected-setup-1', qualification: false, selectedFiles: [...plan.selectedFiles], requiredBrowsers: [...plan.requiredBrowsers], gates,
    gateBudgetMs, setupReserveMs, finalizationReserveMs, totalBudgetMs, jobMinutes: fastSelectedJobMinutes, sources, history: historyInputs, adapterFixture,
    rendererReceipts: plan.selectedFiles.includes(rendererReceiptOwner) ? rendererReceiptRequirement() : null};
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
  if (plan.browserGroups === 'adapters' && plan.browsers !== 'chromium') throw Error('The complete adapters family requires Chromium');
  if (plan.browserGroups === 'shell' && plan.browsers !== 'chromium') throw Error('The complete shell family requires Chromium');
  if (plan.gates.some(gate => gate.files?.length || gate.freshFixtureFiles?.length || gate.browserPrerequisites || gate.completionPrerequisites)) throw Error('Browser dispatch does not provision Node or legacy packet fixtures');
  const full = createBrowserPlan({selection: plan.browsers, scope: 'features', output: plan.browserPlan?.output});
  const tests = full.steps.filter(step => step.config && step.family === plan.browserGroups);
  if (tests.length !== 1 || tests[0].browser !== plan.browsers) throw Error('Reviewed browser family no longer selects one engine');
  const fixtures = new Set(tests.flatMap(step => step.prerequisites));
  const steps = full.steps.filter(step => fixtures.has(step.id) || step.id === tests[0].id);
  if (!same(plan.browserPlan.steps, steps) || !same(plan.requiredBrowsers, [plan.browsers])) throw Error('Browser dispatch must preserve the complete maintained family and fixture plan');
  const limits = browserDeadlineLimits(sourceFor);
  const adapterFixture = plan.browserGroups === 'adapters' ? {...publicAdapterRequirement(), owners: tests.flatMap(step => step.files)} : null;
  if (adapterFixture) {
    const path = 'tooling/qualification/container/inputs.mjs', bytes = Buffer.from(sourceFor(path));
    limits.sources.push({path, bytes: bytes.length, sha256: sha256(bytes)});
  }
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
    sources: limits.sources, history: [], adapterFixture};
}
export function selectedFastBrowserSetup(root, family, engine) {
  if (!fastBrowserFamilies.includes(family) || !fastBrowserEngines.includes(engine)) throw Error('Choose one reviewed whole editor family and one engine');
  if (family === 'adapters' && engine !== 'chromium') throw Error('The complete adapters family requires Chromium');
  if (family === 'shell' && engine !== 'chromium') throw Error('The complete shell family requires Chromium');
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

function provisionPublicAdapterChild(root, expected, execute) {
  const args = [fileURLToPath(import.meta.url), '--public-adapter', root];
  const value = JSON.parse(execute(process.execPath, args, {cwd: root, timeout: 11 * 60_000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe']}).toString());
  if (value.kind !== 'fast-public-adapter-provisioning-1' || value.status !== 'PASS' || !same(value.expected, publicAdapterRequirement()) || value.actual?.path !== join(root, expected.path) || value.actual.bytes !== expected.bytes || value.actual.sha256 !== expected.sha256 || !['existing', 'downloaded'].includes(value.mode)) throw Error('Public adapter provisioning receipt differs');
  return {...value, command: [process.execPath, ...args]};
}

export function provisionFastBrowserSetup(root, plan, {execute = execFileSync, record = () => {}} = {}) {
  if (plan.kind !== 'fast-ci-browser-setup-1' || !fastBrowserFamilies.includes(plan.family) || !fastBrowserEngines.includes(plan.engine) || !same(plan.requiredBrowsers, [plan.engine]) || plan.history.length) throw Error('Reviewed browser provisioning selection required');
  if (plan.family === 'adapters' && plan.engine !== 'chromium') throw Error('The complete adapters family requires Chromium');
  if (plan.family === 'shell' && plan.engine !== 'chromium') throw Error('The complete shell family requires Chromium');
  const owners = plan.family === 'adapters' ? createBrowserPlan({selection: 'chromium', scope: 'features', output: join(root, 'artifacts/validation/run/browser')}).steps.filter(step => step.family === 'adapters' && step.config).flatMap(step => step.files) : [];
  const expectedAdapter = owners.length ? {...publicAdapterRequirement(), owners} : null;
  if (plan.family === 'adapters' && (!owners.length || !same(plan.selectedFiles, owners)) || !same(plan.adapterFixture ?? null, expectedAdapter)) throw Error('Selected public adapter prerequisite differs from pinned input');
  const receipt = {kind: 'fast-ci-browser-provisioning-1', qualification: false, plan, status: 'PENDING', browser: null, adapterFixture: null};
  record(receipt);
  try {
    if (expectedAdapter) { receipt.adapterFixture = provisionPublicAdapterChild(root, expectedAdapter, execute); record(receipt); }
    const args = [join(root, 'node_modules/playwright/cli.js'), 'install', '--with-deps', plan.engine];
    execute(process.execPath, args, {cwd: root, timeout: 7 * 60_000, stdio: 'inherit'});
    receipt.browser = {command: [process.execPath, ...args], status: 'PASS'};
    receipt.status = 'PASS';
  } catch (error) {
    receipt.status = 'FAIL'; receipt.error = String(error); throw error;
  } finally { record(receipt); }
  return receipt;
}

function provisionRendererReceipts(root, expected, execute) {
  const args = [fileURLToPath(new URL('./r18-ci-inputs.mjs', import.meta.url)), root];
  // The child owns a bounded process group for all Git/materialization work.
  // This outer limit leaves its existing 5-second drain ample time to finish.
  const value = JSON.parse(execute(process.execPath, args, {cwd: root, timeout: 11 * 60_000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe']}).toString());
  if (value.kind !== 'fast-renderer-receipt-provisioning-1' || value.status !== 'PASS' || value.qualification !== false || !same(value.expected, expected) || !same(value.files, expected.files) || typeof value.receipt?.path !== 'string') throw Error('Renderer receipt provisioning result differs');
  const directory = dirname(value.receipt.path), parent = join(root, 'artifacts/validation');
  if (dirname(directory) !== parent || !/^r18-inputs-[A-Za-z0-9]+$/.test(directory.slice(parent.length + 1)) || value.receipt.path !== join(directory, 'receipt.json')) throw Error('Renderer receipt provisioning path differs');
  const bytes = readFileSync(value.receipt.path), recorded = JSON.parse(bytes);
  if (bytes.length !== value.receipt.bytes || sha256(bytes) !== value.receipt.sha256 || recorded.status !== 'PASS' || recorded.qualification !== false || !same(recorded.expected, expected) || recorded.headBefore !== recorded.headAfter || !same(recorded.transport?.copied, expected.files)) throw Error('Renderer receipt provisioning readback differs');
  return {...value, command: [process.execPath, ...args]};
}

export function provisionFastSetup(root, plan, {execute = execFileSync, record = () => {}} = {}) {
  const expectedRenderer = plan.selectedFiles.includes(rendererReceiptOwner) ? rendererReceiptRequirement() : null;
  if (!same(plan.rendererReceipts ?? null, expectedRenderer)) throw Error('Selected renderer receipt prerequisite differs from approved input');
  const adapterOwners = plan.selectedFiles.filter(path => path.startsWith('tests/adapters/'));
  const expectedAdapter = adapterOwners.length ? {...publicAdapterRequirement(), owners: adapterOwners} : null;
  if (!same(plan.adapterFixture ?? null, expectedAdapter)) throw Error('Selected public adapter prerequisite differs from pinned input');
  const receipt = {kind: 'fast-ci-selected-provisioning-1', qualification: false, plan, status: 'PENDING', history: [], browser: null, adapterFixture: null, rendererReceipts: null};
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
    if (expectedAdapter) {
      receipt.adapterFixture = provisionPublicAdapterChild(root, expectedAdapter, execute); record(receipt);
    }
    if (expectedRenderer) { receipt.rendererReceipts = provisionRendererReceipts(root, expectedRenderer, execute); record(receipt); }
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

// Fixed public structural fixture only. This never downloads a model result,
// accepts credentials, follows redirects, or changes product/test-child egress.
function publicAdapterRequirement() {
  const rows = fixtureRequirements.filter(row => row.path === 'artifacts/p27-evidence/fal-public-lora-example/provider-example.safetensors');
  if (rows.length !== 1) throw Error('Exact public adapter input declaration missing');
  const url = new URL(adapterSourceURL);
  if (url.protocol !== 'https:' || url.hostname !== 'v3b.fal.media' || url.port || url.username || url.password || url.search || url.hash || url.href !== adapterSourceURL) throw Error('Public adapter input URL declaration differs');
  return {...rows[0], sourceURL: adapterSourceURL};
}
/** Small-file unit fixtures exercise this bounded byte primitive. Only the
 * private provisioning entry point chooses the genuine admitted descriptor. */
export async function stagePinnedAdapterResponse(response, path, expected, signal) {
  if (!Number.isSafeInteger(expected.bytes) || expected.bytes <= 0 || !/^[a-f0-9]{64}$/.test(expected.sha256)) throw Error('Invalid pinned adapter byte identity');
  signal?.throwIfAborted();
  if (response.statusCode !== 200 || response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity' || response.headers['content-length'] !== String(expected.bytes)) throw Error('Public adapter response status/encoding/length differs');
  const file = await open(path, 'wx', 0o600), hash = createHash('sha256');
  let received = 0;
  try {
    for await (const chunk of response) {
      signal?.throwIfAborted();
      if (!(chunk instanceof Uint8Array) || !chunk.length) throw Error('Invalid public adapter chunk');
      received += chunk.length;
      if (received > expected.bytes) throw Error('Public adapter exceeds pinned length');
      hash.update(chunk);
      for (let at = 0; at < chunk.length;) {
        signal?.throwIfAborted();
        const {bytesWritten} = await file.write(chunk, at, chunk.length - at);
        if (!bytesWritten) throw Error('Public adapter write did not progress');
        at += bytesWritten;
      }
    }
    signal?.throwIfAborted();
    const actual = {bytes: received, sha256: hash.digest('hex')};
    if (!same(actual, {bytes: expected.bytes, sha256: expected.sha256})) throw Error('Public adapter downloaded identity differs');
    await file.sync();
    return actual;
  } finally { await file.close(); }
}
/** Hard-link publication is atomic and refuses an existing destination. The
 * caller has already verified bytes; it verifies the published path again. */
export async function publishPinnedAdapterFile(staged, destination) {
  await chmod(staged, 0o444);
  await link(staged, destination);
}
export async function provisionFastAdapterFixture(root) {
  root = resolve(root);
  const expected = publicAdapterRequirement(), destination = join(root, expected.path);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw Error('Public adapter root must be a real directory');
  // Existing mismatches are evidence, never silently overwritten or replaced.
  let exists = false;
  try { await lstat(destination); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (exists) return {kind: 'fast-public-adapter-provisioning-1', status: 'PASS', mode: 'existing', expected, actual: await verifyAdapterFixture({root})};
  let parent = root;
  for (const part of expected.path.split('/').slice(0, -1)) {
    parent = join(parent, part);
    try { await mkdir(parent, {mode: 0o700}); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Public adapter parent must be a real directory');
  }
  const temporary = await mkdtemp(join(dirname(destination), '.public-adapter-'));
  const staged = join(temporary, 'download.safetensors'), controller = new AbortController();
  const timer = setTimeout(() => controller.abort(Error('Public adapter download exceeded 600 seconds')), 600_000);
  let request, response, requestClosed, responseClosed;
  try {
    await new Promise((resolveResponse, reject) => {
      request = httpsGet(expected.sourceURL, {agent: false, headers: {'Accept-Encoding': 'identity'}, signal: controller.signal}, res => {
        response = res;
        responseClosed = new Promise(resolveClose => { if (res.closed) resolveClose(); else res.once('close', resolveClose); });
        resolveResponse();
      });
      requestClosed = new Promise(resolveClose => { if (request.closed) resolveClose(); else request.once('close', resolveClose); });
      request.once('error', reject);
    });
    await stagePinnedAdapterResponse(response, staged, expected, controller.signal);
    await verifyAdapterFixture({root, path: staged});
    controller.signal.throwIfAborted();
    await publishPinnedAdapterFile(staged, destination);
    const actual = await verifyAdapterFixture({root});
    await unlink(staged); await rmdir(temporary);
    return {kind: 'fast-public-adapter-provisioning-1', status: 'PASS', mode: 'downloaded', expected, actual};
  } catch (error) {
    throw Error('Public adapter provisioning failed; retained staging ' + temporary + ': ' + String(error), {cause: error});
  } finally {
    clearTimeout(timer); request?.destroy(); response?.destroy();
    await Promise.all([requestClosed, responseClosed].filter(Boolean));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--public-adapter') {
    if (process.argv.length !== 4) throw Error('Usage: fast-ci-setup.mjs --public-adapter <root>');
    process.stdout.write(JSON.stringify(await provisionFastAdapterFixture(process.argv[3])) + '\n');
  } else {
    const output = process.argv[2] && resolve(process.argv[2]);
    if (!output || process.argv.length !== 3) throw Error('Usage: fast-ci-setup.mjs <provisioning-receipt.json>');
    const root = resolve('.'), plan = selectedFastDispatchSetup(root, process.env);
    const provision = plan.kind === 'fast-ci-browser-setup-1' ? provisionFastBrowserSetup : provisionFastSetup;
    provision(root, plan, {record: receipt => writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n')});
  }
}
