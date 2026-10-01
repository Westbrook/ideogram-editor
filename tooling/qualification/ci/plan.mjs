import {createHash} from 'node:crypto';
import {posix} from 'node:path';
import {requiredCampaignJobs} from '../campaigns/inventory.mjs';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const digest = value => sha256(JSON.stringify(value));
export const runtime = 'tooling/qualification/campaigns/run.mjs';
export const orders = Object.freeze({
  C: ['C0','C1','C2','C3','C4','C5','C6','C7','C9','C10','C8'],
  H: ['H0','H1','H2','H3','H4','H5','H7','H8','H9','H10','H6'],
  AC: ['AC0','AC1','AC2','AC3'], AH: ['AH0','AH1','AH2','AH3'],
  QC: ['I1','I2','I6C','I7N','I7A','I8C','I10C','I12C'],
  QH: ['I3','I4','I5a','I5b','I6H','I8H','I10H','I11H','I12H','I13H'],
});
Object.values(orders).forEach(Object.freeze);
const hex = (value, n) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${n}}$`).test(value);
function assert(value, message) { if (!value) throw Error(message); }
function relative(path) {
  assert(typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.includes('\\') && !/[\x00-\x1f\x7f]/.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..'), 'Expected safe repository-relative path');
  return path;
}
function sealed(file) {
  assert(file && typeof file.path === 'string' && file.path.startsWith('/') && !/[\x00-\x1f\x7f]/.test(file.path) && posix.normalize(file.path) === file.path && hex(file.sha256, 64), 'Expected absolute sealed input path and SHA-256');
  return {path: file.path, sha256: file.sha256};
}
function source(value) {
  assert(value && hex(value.commit, 40) && hex(value.tree, 40) && hex(value.digest, 64), 'Expected immutable commit, tree and source-byte digest');
  return {commit: value.commit, tree: value.tree, digest: value.digest};
}

/** Conservative policy, not a coverage waiver. Unknown/new paths include all
 * active jobs. A deleted/renamed path must remain in the immutable diff input. */
export function selectAffectedQ3(paths, {features = 'adapters'} = {}) {
  const all = requiredCampaignJobs('Q3', features);
  assert(Array.isArray(paths), 'Expected changed paths');
  const selected = new Set(), reasons = [];
  for (const path of paths) {
    relative(path);
    let jobs = all, rule = 'unknown-or-shared-all';
    if (/^(?:src\/raster\/|server\/raster\/|tooling\/raster\/|vendor\/raster\/|tests\/raster\/)/.test(path) || path === 'src/request/raster-plan.ts') {
      rule = 'raster'; jobs = all.filter(id => id !== 'I2');
    } else if (/^(?:src\/text\/|server\/text\/|tooling\/text\/|vendor\/text\/|tests\/text\/|tests\/text-state\/|src\/composition\/|tests\/composition\/)/.test(path)) {
      rule = 'text-composition'; jobs = all.filter(id => id !== 'I2');
    } else if (/^(?:server\/provider\/|src\/request\/|tests\/provider\/|tests\/request\/|tests\/request-edits\/|tests\/queue\/|tests\/candidates\/|tests\/recovery\/|server\/portable\/|tests\/portable\/|tooling\/portable\/|src\/adapters\/|tests\/adapters\/)/.test(path) || path === 'server/adapters.ts') {
      rule = 'provider-retention-adapters'; jobs = all.filter(id => id !== 'I2');
    }
    jobs.forEach(id => selected.add(id)); reasons.push({path, rule, jobs});
  }
  return {jobs: all.filter(id => selected.has(id)), reasons, qualification: false};
}

function normalize(input) {
  assert(input && ['core','adapters'].includes(input.features ?? 'adapters'), 'Only implemented core/adapters profiles are supported');
  const purpose = input.purpose ?? 'comparison';
  assert(['comparison','initial-baseline'].includes(purpose), 'Invalid CI qualification purpose');
  const candidate = source(input.candidate), control = source(input.control ?? input.candidate), base = purpose === 'comparison' ? source(input.base) : null;
  assert(purpose!=='initial-baseline'||input.approvedMain==null,'Initial baseline cannot claim approved history');
  const approvedMain=input.approvedMain==null?null:{packet:sealed(input.approvedMain.packet),source:source(input.approvedMain.source)};
  if (base) assert(base.commit !== candidate.commit, 'Fresh distinct base and candidate commits required');
  else assert(input.base == null && input.diff == null, 'Initial baseline must not invent a base or changed-path diff');
  assert(['normal','cold'].includes(input.cache ?? 'normal'), 'Invalid P cache profile');
  const paths = [...new Set(input.diff?.paths ?? [])].sort(); paths.forEach(relative);
  if (base) {
    assert(input.diff && Array.isArray(input.diff.paths) && digest(paths) === input.diff.pathsDigest && hex(input.diff.rawSha256, 64), 'Immutable diff path digest mismatch');
    assert(input.diff.base === base.commit && input.diff.candidate === candidate.commit, 'Diff source identities differ from revisions');
  }
  const inputs = {};
  for (const side of ['C','H']) {
    const value = input.inputs?.[side];
    assert(value && /^sha256:[a-f0-9]{64}$/.test(value.physicalHostId ?? ''), 'Expected observed physical hostname hash');
    inputs[side] = {physicalHostId: value.physicalHostId, hostAttestation: sealed(value.hostAttestation), fixtureManifest: sealed(value.fixtureManifest), configuration: sealed(value.configuration)};
  }
  assert(inputs.C.physicalHostId !== inputs.H.physicalHostId, 'C and H must be independent physical hosts');
  const outputRoot = relative(input.outputRoot);
  assert(outputRoot.startsWith('artifacts/'), 'Fresh output root must be beneath artifacts/');
  return {purpose, base, candidate, control, approvedMain, features: input.features ?? 'adapters', cache: input.cache ?? 'normal', diff: base ? {base: base.commit, candidate: candidate.commit, paths, pathsDigest: digest(paths), rawSha256: input.diff.rawSha256} : null, inputs, outputRoot};
}

export function sourceRoles(spec) { return spec.purpose === 'initial-baseline' ? ['candidate'] : ['base','candidate']; }

/** Pure DAG construction: no commands, installs, services or schedules start. */
export function createCiPlan(input) {
  const spec = normalize(input), baseline = spec.purpose === 'initial-baseline', roles = sourceRoles(spec);
  const affected = baseline ? {jobs: requiredCampaignJobs('Q3', spec.features), reasons: [{rule: 'initial-baseline-all-implemented-jobs'}], qualification: false} : selectAffectedQ3(spec.diff.paths, spec);
  const nodes = [], stages = [], boundaries = [];
  function stage(key, side, jobs, campaign, cache, role, dependencies, extra = {}) {
    const nodeIds = [], before = dependencies.flatMap(id => stages.find(item => item.key === id)?.nodeIds.slice(-1) ?? []);
    let prior = [...new Set(before)];
    for (const job of jobs) {
      if(job==='I5b'&&jobs.includes('I5a'))continue;
      const selectedJobs=job==='I5a'&&jobs.includes('I5b')?['I5a','I5b']:[job];
      const id = `${key}-${job}`, output = `${spec.outputRoot}/${id}`, files = spec.inputs[side];
      const args = [runtime, 'run', '--campaign', campaign, '--features', spec.features, '--cache', cache, '--jobs', selectedJobs.join(','),
        '--host-attestation', files.hostAttestation.path, '--fixture-manifest', files.fixtureManifest.path,
        '--configuration', files.configuration.path, '--output', output];
      nodes.push({id, stage: key, side, job, jobs:selectedJobs, campaign, cache, role, source: spec[role], dependencies: prior,
        physicalHostId: files.physicalHostId, runnerLabels: ['self-hosted', `ideogram-perf-${side}`],
        command: ['node', ...args], output, inputs: files, ...extra});
      nodeIds.push(id); prior = [id];
    }
    assert(nodeIds.length > 0, 'Empty execution stage is not permitted');
    stages.push({key, side, role, campaign, cache, dependencies, nodeIds, ...extra}); return key;
  }
  function core(prefix, role, cache, dependencies, parent = null) {
    const extra = parent ? {parent} : {};
    const prepare = stage(`${prefix}-prepareC`, 'C', orders.C.slice(0,3), 'P', cache, role, dependencies, extra);
    const rest = stage(`${prefix}-restC`, 'C', orders.C.slice(3), 'P', cache, role, [prepare], extra);
    const host = stage(`${prefix}-H`, 'H', orders.H, 'P', cache, role, [prepare], {...extra, artifactFrom: `${prepare}-C2`});
    return [rest, host];
  }
  let preceding = [];
  if (!baseline) {
    preceding = core('p-base', 'base', spec.cache, []);
    preceding = core('p-candidate', 'candidate', spec.cache, preceding);
    boundaries.push({id:'p-core-pair',kind:'two-host-fresh-base-candidate-core',starts:[{cache:spec.cache,nodeIds:['p-base-prepareC-C0'],terminalStages:preceding}],
      targetMs:(spec.cache==='cold'?60:50)*60_000,ceilingMs:(spec.cache==='cold'?120:100)*60_000});
    if (spec.features === 'adapters') for (const role of roles) {
      const prior = preceding;
      const prepare = stage(`a-${role}-prepareC`, 'C', orders.AC.slice(0,1), 'P', spec.cache, role, prior);
      preceding = [stage(`a-${role}-C`, 'C', orders.AC.slice(1), 'P', spec.cache, role, [prepare]), stage(`a-${role}-H`, 'H', orders.AH, 'P', spec.cache, role, [prepare])];
    }
    if(spec.features==='adapters') boundaries.push({id:'p-adapter-pair',kind:'two-host-fresh-base-candidate-adapters',starts:[{cache:spec.cache,nodeIds:['a-base-prepareC-AC0'],terminalStages:preceding}],targetMs:10*60_000,ceilingMs:15*60_000});
  }
  for (const role of roles) {
    if (affected.jobs.includes('I0')) {
      const starts = [];
      for (const cache of ['normal','cold']) {
        const prefix = `q3-${role}-i0-${cache}`, first = nodes.length;
        preceding = core(prefix, role, cache, preceding, `q3-${role}-I0`);
        starts.push({cache, nodeIds: nodes.slice(first).map(node => node.id), terminalStages: preceding});
      }
      boundaries.push({id: `q3-${role}-I0`, role, source: spec[role], kind: 'two-host-core-normal-and-cold', starts,
        targetMs: 55 * 60_000, ceilingMs: 105 * 60_000,
        requiredReceipt: 'Whole-pipeline elapsed plus queue/provisioning and configuration receipts; summed child command times do not prove D08.'});
    }
    const prior = preceding, next = [];
    for (const side of ['C','H']) {
      const jobs = orders[`Q${side}`].filter(job => affected.jobs.includes(job));
      if (jobs.length) next.push(stage(`q3-${role}-${side}`, side, jobs, 'Q3', 'normal', role, prior));
    }
    if (next.length) preceding = next;
  }
  for (const role of roles) {
    const initial = nodes.filter(node => node.role === role && /^(?:p-|a-)/.test(node.stage)).flatMap(node => node.jobs).sort();
    assert(digest(initial) === digest(baseline ? [] : requiredCampaignJobs('P', spec.features).sort()), 'P source inventory is not completely scheduled');
    const selected = nodes.filter(node => node.role === role && node.campaign === 'Q3').flatMap(node => node.jobs);
    if (boundaries.some(boundary => boundary.id === `q3-${role}-I0`)) selected.push('I0');
    assert(digest(selected.sort()) === digest([...affected.jobs].sort()), 'Affected Q3 inventory is not completely scheduled');
  }
  const body = {kind: 'ci-qualification-plan-1', spec, affectedQ3: affected, nodes, stages, boundaries, terminalStages: preceding,
    restrictions: {qualification: false, providerCalls: 0, hostedTimingSubstitution: false, scheduledAutomationCreated: false,
      baselineScope: baseline ? 'First candidate-only Q3 baseline; all implemented jobs and absolute gates required. No prior or approved-main relative baseline exists; other cohorts remain unqualified.' : 'Fresh base/candidate P and affected Q3 comparison.',
      developerBridge: 'Developer-handler jobs require the implementation/configuration bridge; planning cannot provide it.',
      artifactTransfer: 'H0 verifies the matching immutable C2 product artifact and installs native H dependencies; node_modules is never transferred.',
      retainedEvidence: 'Keep first failures and all missing/failed/censored starts; never retry to replace a failure.'}};
  return {...body, digest: digest(body)};
}

export function validateCiPlan(plan) {
  assert(plan?.kind === 'ci-qualification-plan-1', 'Unsupported CI plan');
  const expected = createCiPlan(plan.spec);
  assert(digest(expected) === digest(plan), 'CI plan order, dependency, source, command or digest mismatch');
  return expected;
}

export function workflowExport(plan) {
  validateCiPlan(plan);
  const byId = new Map(plan.nodes.map(node => [node.id, node]));
  const stages = Object.fromEntries(plan.stages.map(stage => [stage.key, {...stage,
    source: plan.spec[stage.role], runnerLabels: ['self-hosted', `ideogram-perf-${stage.side}`],
    physicalHostId: plan.spec.inputs[stage.side].physicalHostId,
    commands: stage.nodeIds.map(id => {const node = byId.get(id); return {nodeId: id, executable: 'node', args: node.command.slice(1), output: node.output, dependencies: node.dependencies};}),
  }]));
  const pending = new Set(plan.stages.map(stage => stage.key)), done = new Set(), layers = [];
  while (pending.size) {
    const ready = [...pending].filter(key => stages[key].dependencies.every(dependency => done.has(dependency)));
    assert(ready.length, 'CI stage dependency cycle'); layers.push(ready);
    ready.forEach(key => {pending.delete(key); done.add(key);});
  }
  return {kind: 'ci-qualification-workflow-1', planDigest: plan.digest, stages, layers, matrix: {include: Object.values(stages)}, boundaries: plan.boundaries,
    state: 'planned', qualification: false, scheduleActivated: false};
}

/** Pure sequencing ledger only. The filesystem verifier constructs these
 * observations after reproducing each child campaign verdict and byte seals. */
export function executionState(plan, observations = []) {
  validateCiPlan(plan); assert(Array.isArray(observations), 'Expected verified observations');
  const byId = new Map(), intervals = [];
  for (const observed of observations) {
    const node = plan.nodes.find(value => value.id === observed.nodeId);
    assert(node && !byId.has(node.id), 'Unknown or duplicate CI observation');
    assert(observed.kind === 'ci-qualification-node-observation-1' && observed.planDigest === plan.digest && digest(observed.source) === digest(node.source), 'Observation source/plan mismatch');
    assert(observed.side === node.side && observed.physicalHostId === node.physicalHostId && observed.output === node.output && digest(observed.command) === digest(node.command), 'Observation command/host/output mismatch');
    assert(digest(observed.inputs) === digest(node.inputs) && hex(observed.receiptSha256,64), 'Observation sealed input/receipt mismatch');
    assert(['PASS','FAIL','INCONCLUSIVE'].includes(observed.outcome), 'Invalid observed outcome');
    const start = Date.parse(observed.startedAt), end = Date.parse(observed.finishedAt);
    assert(Number.isFinite(start) && Number.isFinite(end) && end >= start, 'Invalid observed interval');
    intervals.push({node, start, end}); byId.set(node.id, observed);
  }
  for (const {node, start, end} of intervals) {
    for (const dependency of node.dependencies) {
      const prior = byId.get(dependency);
      assert(prior?.outcome === 'PASS' && Date.parse(prior.finishedAt) <= start, 'Execution preceded a successful dependency');
    }
    assert(!intervals.some(other => other.node.id !== node.id && other.node.physicalHostId === node.physicalHostId && start < other.end && other.start < end), 'Competing timing on one physical host');
  }
  const states = plan.nodes.map(node => ({nodeId: node.id, state: byId.get(node.id)?.outcome ?? (node.dependencies.some(id => byId.has(id) && byId.get(id).outcome !== 'PASS') ? 'BLOCKED' : node.dependencies.every(id => byId.get(id)?.outcome === 'PASS') ? 'READY' : 'PENDING')}));
  return {kind: 'ci-qualification-state-1', planDigest: plan.digest, states,
    outcome: observations.some(item => item.outcome === 'FAIL') ? 'FAIL' : observations.some(item => item.outcome === 'INCONCLUSIVE') ? 'INCONCLUSIVE' : observations.length === plan.nodes.length ? 'COMMANDS_COMPLETE' : 'INCOMPLETE',
    qualification: false, boundaries: plan.boundaries.map(value => ({id: value.id, status: 'Requires independently sealed whole-pipeline receipt'}))};
}
