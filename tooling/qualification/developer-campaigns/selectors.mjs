import {readFile, readdir} from 'node:fs/promises';
import {join, relative, resolve} from 'node:path';
import {sha256, json, safeRelative} from './common.mjs';
import {nodeGuardForFile} from '../suite-prerequisites.mjs';

export function caseIdentity(method, file, name, occurrence = 1) {
  if (!['U', 'L', 'B'].includes(method) || !Number.isSafeInteger(occurrence) || occurrence < 1 || !name) throw Error('Invalid stable case identity');
  return `${method}-${sha256(JSON.stringify([safeRelative(file), name, occurrence])).slice(0, 24)}`;
}
const integrationDirectories = new Set(['session', 'store', 'protocol', 'assets', 'raster', 'history', 'queue', 'candidates', 'text-state', 'portable', 'recovery', 'export']);
export const nativeNodeBrowserFiles = Object.freeze([
  'tests/composition/retained-text.test.mjs', 'tests/editor/model-memory-browser.test.mjs',
  'tests/history/mask-text-compatibility.test.mjs',
  'tests/portable/browser-recovery.test.mjs', 'tests/text-state/native.test.mjs',
  'tests/text-state/placement-text-compatibility.test.mjs',
  'tests/browser/wa-observation.test.mjs',
]);
const integrationNames = /(?:writer|transport|backend|flow|deletion|upload-owner|retention|compatibility|retained-text|initialization|network|process|host)/;
// This mixed helper owner includes real writer/Composition archive controls.
// Keep those controls in the integration suite despite its historical filename.
const integrationFiles = new Set(['tests/campaigns/fixture-portable.test.mjs']);
export function nodeClassification(file) {
  const [, directory, ...parts] = safeRelative(file).split('/');
  // Classification follows the real execution boundary. These Node-hosted
  // cases launch Chromium and belong after browser provisioning in full B.
  const method = nativeNodeBrowserFiles.includes(file) ? 'B' : integrationFiles.has(file) || integrationDirectories.has(directory) || integrationNames.test(parts.at(-1)) ? 'L' : 'U';
  const group = file === 'tests/recovery/editor-capability-preflight.test.mjs' ? 'editor-capability-preflight' : directory;
  const guard = nodeGuardForFile(group, file);
  const contract = {request: 'route', provider: 'provider', queue: 'job', candidates: 'job', composition: 'composition', adapters: 'adapter', raster: 'raster', history: 'state', store: 'store', portable: 'copy', 'text-state': 'text', 'ui-state': 'controls', recovery: 'recovery', assets: 'assets', session: 'session', protocol: 'protocol', editor: 'controls', browser: 'controls', text: 'text', qualification: 'runner', campaigns: 'runner', export: 'raster'}[directory];
  if (!contract) throw Error(`Unmapped required test directory: ${file}`);
  return {method, guard, contracts: [`${method}-${contract}`]};
}
const endToEndAliases = Object.freeze({
  'B-3f7d6d524c026d406b8dcdca': 'E1', 'B-8b57edd2191e621a52c9deb1': 'E2',
  'B-cbaff1c92f64f8853cdb47d5': 'E3', 'B-a965e40ef8a89858e4f8b2ff': 'E4',
});
export function contractsForCase(method, file, name, occurrence = 1) {
  const id = caseIdentity(method, file, name, occurrence);
  if (method !== 'B') return nodeClassification(file).contracts;
  const family = safeRelative(file).split('/')[1];
  const contract = {consumer: 'controls', browser: 'controls', editor: 'document', request: 'controls', 'request-edits': 'raster',
    raster: 'raster', history: 'raster', adapters: 'library', queue: 'job', candidates: 'job', recovery: 'job',
    text: 'text', 'text-state': 'text', composition: 'composition', portable: 'reopen', qualification: 'a11y'}[family];
  if (!contract) throw Error('Unmapped browser test family: ' + file);
  const contracts = ['B-' + contract];
  if (endToEndAliases[id]) contracts.push(endToEndAliases[id]);
  if (/^tests\/qualification\/axe(?:-[\w-]+)?\.spec\.ts$/.test(file)) contracts.push('AX01');
  if (id === 'B-5abf9a5825e4e4979116d480') contracts.push('AX01', 'AX02', 'AX05', 'AX06', 'AX07');
  return contracts;
}
export async function discoverNodeFiles(root) {
  const files = [];
  async function walk(path) {
    for (const entry of await readdir(join(root, path), {withFileTypes: true})) {
      const next = `${path}/${entry.name}`;
      if (entry.isDirectory()) await walk(next);
      else if (entry.isFile() && entry.name.endsWith('.test.mjs')) files.push(next);
    }
  }
  await walk('tests');
  return files.sort().map(file => ({file, ...nodeClassification(file)}));
}
export function exactPattern(names) {
  if (!Array.isArray(names) || !names.length || new Set(names).size !== names.length) throw Error('Focused names must be nonempty and unique within a file');
  return `^(?:${names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`;
}
export function validateFocused(fixture) {
  if (fixture?.kind !== 'developer-focused-selection-1') throw Error('Unsupported focused selector');
  for (const [group, count, method] of [['unit', 100, 'U'], ['integration', 10, 'L'], ['browser', 5, 'B']]) {
    const cases = fixture[group];
    if (!Array.isArray(cases) || cases.length !== count || new Set(cases.map(item => item.id)).size !== count) throw Error(`Require exactly ${count} distinct ${group} cases`);
    for (const item of cases) {
      if (caseIdentity(method, item.file, item.name) !== item.id || !Array.isArray(item.contracts) || !item.contracts.length) throw Error(`Invalid ${group} contract mapping`);
      if (group !== 'browser' && nodeClassification(item.file).method !== method) throw Error(`Wrong method classification: ${item.file}`);
      if (group === 'browser') safeRelative(item.config);
    }
  }
  return fixture;
}
export async function readFocused(root) {
  return validateFocused(JSON.parse(await readFile(join(root, 'tooling/qualification/developer-campaigns/focused.json'))));
}
export function classifySuite(records, {method, files, expected = null}) {
  if (!Array.isArray(records) || !Array.isArray(files) || !files.length || new Set(files).size !== files.length || !['U', 'L', 'B'].includes(method)) throw Error('Invalid suite evidence input');
  files.forEach(safeRelative);
  const cases = records.filter(item => item.type === 'case');
  const failures = cases.filter(item => item.status !== 'passed' && !(expected && item.status === 'skipped' && !expected.some(value => value.file === item.file && value.name === item.name)));
  const executed = cases.filter(item => item.status !== 'skipped');
  const reasons = [];
  const occurrences = new Map(), ids = new Set();
  for (const item of cases) {
    try {
      if (typeof item.name !== 'string' || !item.name || !['passed', 'failed', 'skipped', 'todo', 'timedOut', 'interrupted'].includes(item.status) || item.id !== caseIdentity(item.method, item.file, item.name, item.occurrence)) throw Error('Invalid case');
      const key = JSON.stringify([item.file, item.name]), next = (occurrences.get(key) ?? 0) + 1;
      if (item.occurrence !== next || ids.has(item.id)) throw Error('Duplicate or unordered case');
      occurrences.set(key, next); ids.add(item.id);
    } catch { reasons.push('invalid-stable-case-identity'); }
  }
  if (!executed.length) reasons.push('zero-executed-cases');
  if (failures.length) reasons.push('failed-skipped-or-incomplete-required-case');
  const fileSet = new Set(executed.map(item => item.file));
  if (files.some(file => !fileSet.has(file))) reasons.push('missing-required-file');
  if (executed.some(item => !files.includes(item.file) || item.method !== method)) reasons.push('orphan-case');
  if (expected && (executed.length !== expected.length || expected.some(item => !executed.some(actual => actual.id === item.id)))) reasons.push('focused-selection-mismatch');
  const ends = records.filter(item => item.type === 'end');
  if (ends.length !== 1 || ends[0].status !== 'passed') reasons.push('missing-or-failed-run-completion');
  if (method === 'B') {
    const discovery = records.filter(item => item.type === 'discovery');
    if (discovery.length !== 1 || !Array.isArray(discovery[0].ids) || discovery[0].ids.length !== executed.length || new Set(executed.map(item => item.frameworkId)).size !== executed.length || discovery[0].ids.some(id => !executed.some(item => item.frameworkId === id))) reasons.push('browser-discovery-completion-mismatch');
  }
  return {outcome: reasons.length ? 'FAIL' : 'PASS', reasons, discovered: cases.length, executed: executed.length,
    passed: executed.filter(item => item.status === 'passed').length, skipped: cases.filter(item => item.status === 'skipped').length,
    cases, identity: sha256(json(cases.map(({id, file, name, method, occurrence}) => ({id, file, name, method, occurrence}))))};
}
export function validateBrowserSelection(records, files, expected = null) {
  return classifySuite(records, {method: 'B', files, expected});
}
export function normalizeCasePath(cwd, file) {
  const path = relative(resolve(cwd), resolve(file)).split('\\').join('/'); return safeRelative(path);
}
