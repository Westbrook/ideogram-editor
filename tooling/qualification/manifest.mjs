// Stable execution units. These are suite identities, not TEST-1 case coverage
// claims or the WD sizing fixture's fixed case selections.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { nodeGroups, nodeGuard, nodeGuardOverrides, expandNodeGateSelection, requiredSuiteEnvironment, freshFixtureFiles, completionPrerequisitesFor } from './suite-prerequisites.mjs';
import { nativeNodeBrowserFiles } from './developer-campaigns/selectors.mjs';

export const sourceRevision = 'TEST-1+A3.1/PERF-8+A3';
export const versions = Object.freeze({ node: '26.10.0', npm: '12.1.0', playwright: '1.63.0' });
const {base, features, helpers} = nodeGroups;
const capabilityPreflightFile = 'tests/recovery/editor-capability-preflight.test.mjs';

function filesIn(root, directory) {
  const files = [];
  function walk(path) {
    for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
      const next = `${path}/${entry.name}`;
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile() && entry.name.endsWith('.test.mjs')) files.push(next);
    }
  }
  walk(directory);
  return files.sort();
}

export function functionalGates(root) {
  const gates = [
    { id: 'typecheck', command: ['npm', 'run', 'typecheck'], dependencies: [], timeoutMs: 300_000 },
    { id: 'preflight', command: ['node', 'tooling/qualification/preflight.mjs'], dependencies: ['typecheck'], timeoutMs: 60_000 },
    { id: 'vendor', command: ['npm', 'run', 'verify:vendor'], dependencies: ['preflight'], timeoutMs: 300_000 },
    { id: 'text-inputs', command: ['npm', 'run', 'verify:text'], dependencies: ['vendor'], timeoutMs: 300_000 },
    { id: 'imports', command: ['npm', 'run', 'verify:imports'], dependencies: ['text-inputs'], timeoutMs: 60_000 },
    { id: 'raster-inputs', command: ['npm', 'run', 'verify:raster'], dependencies: ['imports'], timeoutMs: 300_000 },
    { id: 'build-app', command: ['npm', 'run', 'build:app'], dependencies: ['raster-inputs'], timeoutMs: 300_000 },
    { id: 'build-server', command: ['npm', 'run', 'build:server'], dependencies: ['build-app'], timeoutMs: 300_000 },
  ];
  for (const group of [...base, ...features, ...helpers]) {
    const capabilityPreflight = group === 'editor-capability-preflight';
    const discovered = filesIn(root, `tests/${capabilityPreflight ? 'recovery' : group}`);
    // This SQLite-only preflight must keep the stricter no-network guard.
    // Other recovery files retain recursive discovery and their existing guard.
    const files = capabilityPreflight ? discovered.filter(file => file === capabilityPreflightFile)
      : group === 'recovery' ? discovered.filter(file => file !== capabilityPreflightFile) : discovered;
    if (!files.length) throw Error(`No discovered Node files for ${group}`);
    const overrides = nodeGuardOverrides.filter(item => item.group === group);
    const partitions = [
      {id: `node:${group}`, guard: nodeGuard(group), files: files.filter(file => !overrides.some(item => item.files.includes(file)))},
      ...overrides.map(item => ({id: `node:${group}:${item.suffix}`, selectionGroup: `node:${group}`, guard: item.guard, files: files.filter(file => item.files.includes(file))})),
    ].filter(partition => partition.files.length);
    for (const {id, selectionGroup, guard, files} of partitions) {
      const browserFiles = files.filter(file => nativeNodeBrowserFiles.includes(file));
      gates.push({ id, ...(selectionGroup ? {selectionGroup} : {}), command: ['node', '--import', `./${guard}`, '--test', '--test-reporter=tap', '--test-concurrency=1', ...files], dependencies: ['build-server'], files, guard,
        ...(freshFixtureFiles(files).length ? {freshFixtureFiles: freshFixtureFiles(files)} : {}),
        ...(Object.keys(requiredSuiteEnvironment(files)).length ? {requiredEnvironment: requiredSuiteEnvironment(files)} : {}),
        ...(completionPrerequisitesFor(files) ? { completionPrerequisites: completionPrerequisitesFor(files) } : {}),
        ...(browserFiles.length ? { browserPrerequisites: { engines: ['chromium'], files: browserFiles, scope: 'Node-hosted cases launch actual Chromium; install pinned Playwright browsers before this gate.' } } : {}),
        ...(files.includes('tests/text-state/native.test.mjs') ? { fixtureBuild: { id: 'text-state-app', config: 'tests/text-state/vite.config.ts', outputEnvironment: 'TEXT_STATE_APP' } } : {}), timeoutMs: 1_800_000 });
    }
  }
  const assigned = new Set(gates.flatMap(gate => gate.files ?? []));
  const unassigned = filesIn(root, 'tests').filter(file => !assigned.has(file));
  if (unassigned.length) throw Error(`Unmapped required Node test files: ${unassigned.join(', ')}`);
  return gates;
}

export function selectGates(gates, selector, { includeDependencies = true } = {}) {
  const known = new Map(gates.map(gate => [gate.id, gate]));
  if (known.size !== gates.length) throw Error('Duplicate gate identity');
  const selections = {
    base: ['typecheck', 'vendor', 'text-inputs', 'imports', 'raster-inputs', 'build-app', 'build-server', ...base.map(name => `node:${name}`)],
    features: features.map(name => `node:${name}`),
    'base-features': [...base, ...features].map(name => `node:${name}`),
    helpers: helpers.map(name => `node:${name}`),
    all: gates.map(gate => gate.id),
  };
  const requested = selections[selector] ?? selector.split(',');
  if (new Set(requested).size !== requested.length) throw Error('Duplicate selected gate');
  const expanded = expandNodeGateSelection(gates, requested);
  if (!expanded.length || expanded.some(id => !known.has(id))) throw Error(`Unknown qualification selector: ${selector}`);
  const selected = new Set();
  const visiting = new Set();
  function add(id) {
    if (visiting.has(id)) throw Error(`Dependency cycle at ${id}`);
    const gate = known.get(id);
    if (!gate) throw Error(`Unknown dependency: ${id}`);
    if (selected.has(id)) return;
    visiting.add(id);
    if (includeDependencies) gate.dependencies.forEach(add);
    visiting.delete(id);
    selected.add(id);
  }
  expanded.forEach(add);
  // Preserve the repository's cheapest-first order even for reversed selectors.
  return gates.filter(gate => selected.has(gate.id));
}

const pCore = [...Array.from({ length: 11 }, (_, i) => `C${i}`), ...Array.from({ length: 11 }, (_, i) => `H${i}`)];
const pAdapter = ['AC0', 'AC1', 'AC2', 'AC3', 'AH0', 'AH1', 'AH2', 'AH3'];
const pTraining = ['TC0', 'TC1', 'TC2', 'TC3', 'TC4', 'TH0', 'TH1', 'TH2', 'TH3', 'TH4'];
const qCore = ['I0', 'I1', 'I2', 'I3', 'I4', 'I5a', 'I5b', 'I6C', 'I6H', 'I7N', 'I10C', 'I10H', 'I11H', 'I12C', 'I12H', 'I13H'];
const qAdapter = ['I7A', 'I8C', 'I8H'];
const qTraining = ['I7T', 'I9C', 'I9H'];

export function campaignJobs(campaign, features = 'core') {
  if (!['P', 'Q3'].includes(campaign) || !['core', 'adapters', 'training'].includes(features)) throw Error('Choose campaign P/Q3 and features core/adapters/training');
  const table = campaign === 'P' ? [pCore, pAdapter, pTraining] : [qCore, qAdapter, qTraining];
  return [...table[0], ...(features !== 'core' ? table[1] : []), ...(features === 'training' ? table[2] : [])];
}

export function validateCampaignSchedule({ campaign, features, revisions, jobs }) {
  if (!Array.isArray(revisions) || ![1, 2].includes(revisions.length) || revisions.some(revision => !/^[a-f0-9]{40}$/.test(revision)) || new Set(revisions).size !== revisions.length) throw Error('Require one candidate revision or distinct fresh base and candidate revisions');
  if (!Array.isArray(jobs)) throw Error('Schedule jobs must be an array');
  const required = revisions.flatMap(revision => campaignJobs(campaign, features).map(id => `${revision}:${id}`));
  const actual = jobs.map(job => `${job.revision}:${job.id}`);
  if (new Set(actual).size !== actual.length) throw Error('Duplicate scheduled job');
  const missing = required.filter(id => !actual.includes(id));
  const orphan = actual.filter(id => !required.includes(id));
  if (missing.length || orphan.length) throw Error(`Campaign mismatch: missing=${missing.join(',')} orphan=${orphan.join(',')}`);
  return { campaign, features, revisions: [...revisions], jobs: actual.length, qualification: false, reason: 'Schedule equality proves inventory only; exact cells, samples, environments and executed receipts remain required.' };
}

export const manualProtocols = Object.freeze([
  { id: 'AX10-Safari-VoiceOver', environment: 'Native macOS Safari and VoiceOver', steps: 'TEST §9 AX10, applicable J1–J24', syntheticSubstitution: false },
  { id: 'AX10-Chromium-VoiceOver', environment: 'Native macOS Chromium and VoiceOver', steps: 'TEST §9 AX10, applicable J1–J24', syntheticSubstitution: false },
  { id: 'M-IME-Japanese', environment: 'Native Japanese IME, WXn', seconds: 60, compositions: 10, commits: 8, cancels: 2, presentationRequests: 6, syntheticSubstitution: false },
  { id: 'M-IME-Chinese', environment: 'Native Simplified Chinese IME, WXs', seconds: 60, compositions: 10, commits: 8, cancels: 2, presentationRequests: 6, syntheticSubstitution: false },
  { id: 'AX10-Windows-NVDA', environment: 'Native Windows Firefox and NVDA', conditional: 'Before any Windows support claim', syntheticSubstitution: false },
]);
