import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceIdentity, sha256 } from '../core.mjs';
import { fileIdentity } from './common.mjs';

const CONTROL_REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const bare = value => typeof value === 'string' ? value.replace(/^sha256:/, '') : null;
const safeCell = value => value.replace(/[^A-Za-z0-9_.-]/g, '_');
export function adapterAuditJobs(jobId) {
  if (jobId === 'AC3') return ['AC1', 'AC2'];
  if (jobId === 'AH3') return ['AH1', 'AH2'];
  throw Error('Adapter audit requires AC3 or AH3');
}
export function sharedAuditConfiguration(value) {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  const { auditReceipts: _descriptors, ...shared } = value; return shared;
}

/** Pure contract check follows full file/evidence verification in the caller. */
export function checkAdapterAuditBinding({ receipt, descriptor, inputs, configuration, fixtureHash, source, control }) {
  assert(['AC1', 'AC2', 'AH1', 'AH2'].includes(descriptor.job), 'Only adapter import/selection predecessors can be audited');
  assert.equal(receipt.kind, 'perf-runtime-campaign-1');
  assert.equal(receipt.plan.campaign, 'P'); assert.equal(receipt.plan.features, 'adapters');
  assert.deepEqual(receipt.plan.selectedJobIds, [descriptor.job], 'Audit input must contain exactly its prescribed predecessor job');
  assert.equal(receipt.summary.status, 'PASS', 'A failed or incomplete predecessor cannot pass its audit');
  for (const side of ['before', 'after']) {
    assert.equal(receipt.identity[side].digest, source.digest, 'Predecessor subject source changed');
    assert.equal(receipt.identity[side].head, source.head, 'Predecessor subject revision changed');
  }
  for (const side of ['controlBefore', 'controlAfter']) {
    assert.equal(receipt.identity[side].digest, control.digest, 'Predecessor control source changed');
    assert.equal(receipt.identity[side].head, control.head, 'Predecessor control revision changed');
  }
  assert.equal(inputs.length, receipt.groups.length); assert(inputs.length > 0);
  for (const input of inputs) {
    assert.equal(input.cell.jobId, descriptor.job); assert.equal(input.cell.workload, 'WA');
    assert.equal(bare(input.fixtureIdentity?.sha256), bare(fixtureHash), 'Predecessor must use the same sealed WA fixture');
    assert.deepEqual(sharedAuditConfiguration(input.configuration), sharedAuditConfiguration(configuration), 'Shared consumed configuration changed; only auditReceipts may differ');
  }
  return { nodeId: descriptor.nodeId, job: descriptor.job, receiptPath: descriptor.path, receiptSha256: descriptor.sha256,
    cache: receipt.plan.cache, fixtureHash, sourceDigest: source.digest, sourceHead: source.head, controlDigest: control.digest, controlHead: control.head,
    groups: receipt.groups.length, counts: receipt.summary.counts, status: 'PASS' };
}

async function sealedGroupInput(receipt, directory, group) {
  const relative = safeCell(group.id) + '/input.json', declaration = receipt.evidence.find(item => item.path === relative);
  assert(declaration, 'Predecessor group input must be sealed in its receipt');
  const bytes = await readFile(join(directory, relative));
  assert.equal(bytes.length, declaration.bytes); assert.equal(sha256(bytes), bare(declaration.sha256)); return JSON.parse(bytes.toString('utf8'));
}

export async function performAdapterAudit(context, cell) {
  const expected = adapterAuditJobs(cell.jobId), descriptors = context.configuration?.auditReceipts;
  const startMs = performance.now(), missing = [], verified = [];
  if (!Array.isArray(descriptors) || !descriptors.length) missing.push('Immutable predecessor receipt descriptors are absent; fresh writer diagnostics cannot verify adapter campaign counts.');
  const fixtureHash = context.fixture?.seal?.sha256 ?? context.fixtureIdentity?.sha256 ?? null;
  if (!/^[a-f0-9]{64}$/.test(bare(fixtureHash) ?? '')) missing.push('Current sealed WA fixture identity is unavailable.');
  if (!missing.length) {
    assert.equal(descriptors.length, expected.length); assert.deepEqual([...descriptors.map(item => item.job)].sort(), [...expected].sort());
    assert.equal(new Set(descriptors.map(item => item.path)).size, descriptors.length);
    const source = sourceIdentity(context.subjectRepo ?? context.repo), control = sourceIdentity(CONTROL_REPO);
    const { verifyCampaignReceipt } = await import('./run.mjs');
    for (const descriptor of descriptors) {
      assert(typeof descriptor.nodeId === 'string' && descriptor.nodeId.length > 0); assert(isAbsolute(descriptor.path)); assert(/^[a-f0-9]{64}$/.test(descriptor.sha256));
      let before;
      try { before = await fileIdentity(descriptor.path); } catch (error) { if (error.code !== 'ENOENT') throw error; missing.push('Retained predecessor receipt is unavailable: ' + descriptor.nodeId); continue; }
      assert.equal(bare(before.sha256), descriptor.sha256, 'Bound predecessor receipt changed');
      const bytes = await readFile(descriptor.path); assert.equal(sha256(bytes), descriptor.sha256);
      const reproduced = await verifyCampaignReceipt(descriptor.path); assert.equal(reproduced.status, 'PASS', 'Predecessor counts, cache protocol and complete outcome must reproduce PASS');
      const receipt = JSON.parse(bytes.toString('utf8')), inputs = [];
      for (const group of receipt.groups) inputs.push(await sealedGroupInput(receipt, dirname(descriptor.path), group));
      verified.push({ ...checkAdapterAuditBinding({ receipt, descriptor, inputs, configuration: context.configuration, fixtureHash, source, control }), verifier: reproduced });
      assert.deepEqual(await fileIdentity(descriptor.path), before, 'Predecessor receipt changed during audit');
    }
  }
  const endMs = performance.now();
  return { status: missing.length ? 'inconclusive' : 'pass', phases: [{ name: 'adapter.audit-predecessors', startMs, endMs, durationMs: endMs - startMs, outcome: 'expected' }],
    assertions: [{ id: 'exact-verified-predecessor-receipts', passed: missing.length ? null : verified.length === expected.length, evidence: verified }],
    observations: { expectedJobs: expected, verified, unrelatedWriterOpened: false, originalsRetained: true }, evidence: verified.map(item => ({ path: item.receiptPath, sha256: item.receiptSha256 })), missing };
}
