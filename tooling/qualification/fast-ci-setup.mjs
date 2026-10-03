// Provisioning for explicit Fast CI selections; never a qualification result.
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import {join, posix, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {developmentPlan} from './development-plan.mjs';
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

function parsed(path, text) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (source.parseDiagnostics.length) throw Error(`Historical declaration does not parse: ${path}`);
  return source;
}
function calls(source, name) {
  const found = [];
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) found.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source); return found;
}
const identifier = (node, name) => !!node && ts.isIdentifier(node) && node.text === name;
function literalCommit(source, name) {
  const declarations = source.statements.filter(ts.isVariableStatement).flatMap(statement => [...statement.declarationList.declarations]).filter(declaration => identifier(declaration.name, name));
  const value = declarations.length === 1 && declarations[0].initializer;
  if (!value || !ts.isStringLiteral(value) || !/^[a-f0-9]{40}$/.test(value.text)) throw Error(`Require one literal historical ${name} in ${source.fileName}`);
  return value.text;
}
function requireImport(path, source, name, target) {
  const imports = source.statements.filter(ts.isImportDeclaration).filter(node => ts.isStringLiteral(node.moduleSpecifier) && posix.normalize(posix.join(posix.dirname(path), node.moduleSpecifier.text)) === target);
  const bindings = imports.flatMap(node => node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) ? [...node.importClause.namedBindings.elements] : []);
  if (bindings.filter(node => identifier(node.name, name) && (!node.propertyName || identifier(node.propertyName, name))).length !== 1) throw Error(`Historical ${name} import changed: ${path}`);
}
function directHistory(source) {
  requireImport(directHistoryOwner, source, 'compileLegacy', compilerPath);
  const uses = calls(source, 'compileLegacy'), args = uses[0]?.arguments;
  if (uses.length !== 1 || args.length !== 3 || !ts.isStringLiteral(args[1]) || !/^[a-f0-9]{40}$/.test(args[1].text) || !ts.isArrayLiteralExpression(args[2]) || !args[2].elements.every(ts.isStringLiteral) || !same(args[2].elements.map(item => item.text), codePaths)) throw Error('Direct historical compiler declaration changed');
  return {commit: args[1].text, paths: [...codePaths]};
}
function priorContract(source) {
  requireImport(priorPath, source, 'compileLegacy', compilerPath);
  const functions = source.statements.filter(node => ts.isFunctionDeclaration(node) && identifier(node.name, 'priorWriter'));
  const fn = functions[0], parameters = fn?.parameters;
  if (functions.length !== 1 || parameters.length !== 2 || !identifier(parameters[0].name, 't') || !identifier(parameters[1].name, 'commit') || !identifier(parameters[1].initializer, 'priorCommit')) throw Error('Historical priorWriter signature changed');
  const compile = calls(source, 'compileLegacy');
  const args = compile[0]?.arguments, paths = args?.[2];
  if (compile.length !== 1 || args.length !== 3 || !identifier(args[1], 'commit') || !ts.isArrayLiteralExpression(paths) || !paths.elements.every(ts.isStringLiteral) || !same(paths.elements.map(item => item.text), archivePaths)) throw Error('Historical compiler archive closure changed');
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
  const root = resolve('.'), plan = selectedFastSetup(root, process.env.SELECTED_NODE_FILES);
  provisionFastSetup(root, plan, {record: receipt => writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n')});
}
