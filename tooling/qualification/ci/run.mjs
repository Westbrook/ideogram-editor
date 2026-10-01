#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {readFile, lstat, realpath} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCiPlan, validateCiPlan, workflowExport, executionState, sourceRoles, digest, sha256} from './plan.mjs';
import {makeCampaignPlan} from '../campaigns/inventory.mjs';
import {verifyCampaignReceipt} from '../campaigns/run.mjs';
import {evaluateHost, loadHostAttestation} from '../campaigns/host.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// Keep this exact source boundary aligned with qualification/core.mjs.
const selectedSource = /^(src\/|server\/|tooling\/|tests\/|docs\/spec\/|vendor\/|\.github\/workflows\/|\.npmrc$|\.progress-report\/project\.json$|index\.html$|package(?:-lock)?\.json$|tsconfig[^/]*\.json$|vite[^/]*\.ts$|AGENTS\.md$)/;
function git(repository, args) {
  const result = spawnSync('git', args, {cwd: repository, maxBuffer: 256 * 1024 * 1024, env: {PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'}});
  if (result.error || result.status !== 0) throw Error(`Cannot read immutable Git inputs: ${result.error?.message ?? result.stderr?.toString()}`);
  return result.stdout;
}
function commitId(value) { if (!/^[a-f0-9]{40}$/.test(value ?? '')) throw Error('Use a full immutable 40-character commit SHA'); return value; }
export function immutableSource(repository, revision, readGit = git) {
  commitId(revision);
  const commit = readGit(repository, ['rev-parse', '--verify', `${revision}^{commit}`]).toString().trim();
  if (commit !== revision) throw Error('Revision must identify the exact commit');
  const tree = readGit(repository, ['rev-parse', '--verify', `${revision}^{tree}`]).toString().trim();
  const entries = readGit(repository, ['ls-tree', '-rz', '--full-tree', revision]).toString().split('\0').filter(Boolean);
  const files = [];
  for (const entry of entries) {
    const split = entry.indexOf('\t'), metadata = entry.slice(0, split).split(' '), path = entry.slice(split + 1);
    if (!selectedSource.test(path)) continue;
    if (split < 0 || !['100644','100755'].includes(metadata[0]) || metadata[1] !== 'blob' || !/^[a-f0-9]{40}$/.test(metadata[2])) throw Error('Selected source must be regular immutable blobs');
    const bytes = readGit(repository, ['cat-file', 'blob', metadata[2]]);
    files.push({path, bytes: bytes.length, sha256: sha256(bytes)});
  }
  files.sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return {commit, tree, digest: digest(files)};
}
export function immutableDiff(repository, base, candidate, readGit = git) {
  commitId(base); commitId(candidate);
  // No rename collapsing: deleted source and added destination both select risk.
  const raw = readGit(repository, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', base, candidate, '--']);
  const paths = [...new Set(raw.toString('utf8').split('\0').filter(Boolean))].sort();
  return {base, candidate, paths, pathsDigest: digest(paths), rawSha256: sha256(raw)};
}
export function verifyImmutablePlan(repository,plan,readGit=git) {
  validateCiPlan(plan);
  for(const role of sourceRoles(plan.spec)) if(digest(immutableSource(repository,plan.spec[role].commit,readGit))!==digest(plan.spec[role])) throw Error('Immutable source differs from imported CI plan');
  if(digest(immutableSource(repository,plan.spec.control.commit,readGit))!==digest(plan.spec.control)) throw Error('Immutable control differs from imported CI plan');
  if(plan.spec.purpose !== 'initial-baseline' && digest(immutableDiff(repository,plan.spec.base.commit,plan.spec.candidate.commit,readGit))!==digest(plan.spec.diff)) throw Error('Immutable diff differs from imported CI plan');
  return plan;
}
async function ordinaryBytes(path) {
  const full = resolve(path), info = await lstat(full);
  if (!info.isFile() || info.isSymbolicLink() || await realpath(full) !== full) throw Error('Expected canonical regular evidence file');
  return readFile(full);
}
export async function verifyInputs(inputs) {
  for (const side of ['C','H']) {
    const value = inputs[side];
    for (const key of ['hostAttestation','fixtureManifest','configuration']) {
      const bytes = await ordinaryBytes(value[key].path);
      if (sha256(bytes) !== value[key].sha256) throw Error(`Changed sealed ${side} ${key}`);
    }
    const host = await loadHostAttestation(value.hostAttestation.path);
    if (host.profile !== side || host.hostnameHash !== value.physicalHostId) throw Error('Physical host profile/identity mismatch');
  }
}

/** This reads and reproduces child results. A supplied boolean such as
 * qualification:true, an exit code, or a synthetic outer PASS is insufficient. */
export function validateNodeReceiptIdentity(plan, nodeId, child) {
  validateCiPlan(plan);
  const node = plan.nodes.find(item => item.id === nodeId); if (!node) throw Error('Unknown CI node');
  if (child.kind !== 'perf-runtime-campaign-1') throw Error('Expected actual runtime campaign receipt');
  const expected = makeCampaignPlan({campaign: node.campaign, features: plan.spec.features, cache: node.cache, jobs: node.jobs});
  if (digest(child.plan) !== digest(expected)) throw Error('Child campaign selection differs from CI node');
  for (const key of ['before','after']) if (child.identity?.[key]?.head !== node.source.commit || child.identity[key].digest !== node.source.digest || digest(child.identity[key].files) !== node.source.digest) throw Error('Executed source differs from immutable revision');
  for(const key of ['controlBefore','controlAfter']) if(child.identity?.[key]?.head!==plan.spec.control.commit||child.identity?.[key]?.digest!==plan.spec.control.digest) throw Error('Executed control differs from immutable controller');
  const argv = child.argv?.slice(2);
  if (digest(argv) !== digest(node.command.slice(2))) throw Error('Executed runtime arguments differ from planned node');
  for (const key of ['hostAttestation','fixtureManifest','configuration']) {
    const actual = child.inputIdentities?.[key], expected = node.inputs[key];
    if (!actual || actual.path !== expected.path || actual.sha256 !== 'sha256:' + expected.sha256 || !Number.isSafeInteger(actual.bytes) || actual.bytes < 0) throw Error('Executed input byte identity is absent or differs: ' + key);
  }
  return {node, expected};
}
export async function verifyNodeReceipt(plan, nodeId, receiptPath) {
  const bytes = await ordinaryBytes(receiptPath), child = JSON.parse(bytes);
  const {node, expected} = validateNodeReceiptIdentity(plan, nodeId, child);
  await verifyInputs(plan.spec.inputs);
  const host = await loadHostAttestation(node.inputs.hostAttestation.path);
  const profiles = [...new Set(expected.jobs.flatMap(job => job.cells.map(cell => cell.host)))];
  const checks = profiles.map(profile => evaluateHost(child.host?.observed ?? {}, profile, host));
  if (host.hostnameHash !== node.physicalHostId || child.host?.observed?.hostnameHash !== node.physicalHostId || digest(checks) !== digest(child.host?.hostChecks) || !checks.every(check => check.eligible)) throw Error('Physical host eligibility cannot be reproduced');
  if (child.host?.attestation?.identity?.sha256 !== 'sha256:' + node.inputs.hostAttestation.sha256) throw Error('Executed host attestation differs from plan');
  const verified = await verifyCampaignReceipt(resolve(receiptPath));
  if (verified.status === 'PASS' && verified.qualification !== true) throw Error('Passing command lacks runtime qualification');
  const observation = {kind: 'ci-qualification-node-observation-1', planDigest: plan.digest, nodeId,
    source: node.source, side: node.side, physicalHostId: node.physicalHostId, inputs: node.inputs,
    command: node.command, output: node.output, receiptSha256: sha256(bytes),
    startedAt: child.startedAt, finishedAt: child.finishedAt, outcome: verified.status};
  return observation;
}

export function parseOptions(args) {
  const mode = args[0] ?? 'plan', options = {mode};
  if (!['plan','export','verify'].includes(mode)) throw Error('Use plan, export or verify');
  const allowed = new Set(['base','candidate','inputs','features','cache','output-root','plan','receipts','repo','purpose','control','approved-main','approved-main-sha256','approved-main-revision']);
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i]?.slice(2);
    if (!args[i]?.startsWith('--') || !allowed.has(key) || options[key] !== undefined || !args[i+1] || args[i+1].startsWith('--')) throw Error('Unknown, duplicate or missing CI option');
    options[key] = args[i+1];
  }
  return options;
}
async function main(args) {
  const options = parseOptions(args);
  if (options.mode === 'plan') {
    if (!options.inputs || !options['output-root']) throw Error('Plan requires --inputs and a unique --output-root');
    const repository = resolve(options.repo ?? root), inputs = JSON.parse(await ordinaryBytes(options.inputs));
    await verifyInputs(inputs);
    const purpose = options.purpose ?? 'comparison';
    if (!['comparison','initial-baseline'].includes(purpose)) throw Error('Use comparison or initial-baseline purpose');
    if (purpose === 'initial-baseline' && options.base !== undefined) throw Error('Initial baseline must not specify --base');
    const approvedOptions=['approved-main','approved-main-sha256','approved-main-revision'];
    if(approvedOptions.some(key=>options[key]!==undefined)&&!approvedOptions.every(key=>options[key]!==undefined)) throw Error('Approved main requires protected-controller packet path, SHA-256 and source revision together');
    const approvedMain=options['approved-main']?{packet:{path:resolve(options['approved-main']),sha256:options['approved-main-sha256']},source:immutableSource(repository,options['approved-main-revision'])}:null;
    const plan = createCiPlan({purpose,control:immutableSource(repository,options.control??options.candidate),approvedMain, base: purpose === 'comparison' ? immutableSource(repository, options.base) : null, candidate: immutableSource(repository, options.candidate),
      diff: purpose === 'comparison' ? immutableDiff(repository, options.base, options.candidate) : null, features: options.features ?? 'adapters', cache: options.cache ?? 'normal', inputs, outputRoot: options['output-root']});
    console.log(JSON.stringify(plan, null, 2)); return;
  }
  if (!options.plan) throw Error('Expected --plan /retained-plan.json');
  const plan = verifyImmutablePlan(resolve(options.repo??root),JSON.parse(await ordinaryBytes(options.plan)));
  if (options.mode === 'export') {console.log(JSON.stringify(workflowExport(plan), null, 2)); return;}
  if (!options.receipts) throw Error('Verify requires --receipts /node-receipts.json');
  const entries = JSON.parse(await ordinaryBytes(options.receipts));
  if (!Array.isArray(entries)) throw Error('Expected nodeId/receiptPath array');
  const observations = [];
  for (const entry of entries) observations.push(await verifyNodeReceipt(plan, entry.nodeId, entry.receiptPath));
  const state = executionState(plan, observations); console.log(JSON.stringify(state, null, 2));
  process.exitCode = state.outcome === 'COMMANDS_COMPLETE' ? 0 : state.outcome === 'FAIL' ? 1 : 2;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(error => {console.error(error.message); process.exitCode = 1;});
