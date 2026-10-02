#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { loadAllocation, sampleVolume, volumeAlarm, createRetentionIndex, verifyEvidenceExport, eligibleEvidence, verifyEvidenceAudit, readEvidenceJSON } from './evidence-volume.mjs';
const readJSON = path => readEvidenceJSON(resolve(path));
export async function main(args) {
  args = [...args]; const mode = args.shift(), options = {};
  if (!['root', 'sample', 'index', 'verify-export', 'eligible', 'verify-audit'].includes(mode)) throw Error('Use root|sample|index|verify-export|eligible|verify-audit. No command deletes evidence.');
  const allowed = { root: ['allocation'], sample: ['allocation'], index: ['allocation', 'entries', 'output'], 'verify-export': ['allocation', 'index', 'export-root', 'output'], eligible: ['allocation', 'index', 'export-receipt', 'now'], 'verify-audit': ['receipt'] }[mode];
  for (let i = 0; i < args.length; i += 2) { const key = args[i]?.slice(2); if (!args[i]?.startsWith('--') || !allowed.includes(key) || Object.hasOwn(options, key) || !args[i + 1]) throw Error('Unknown, repeated or missing lifecycle argument'); options[key] = args[i + 1]; }
  if (mode === 'verify-audit') { const receiptPath = resolve(options.receipt), receipt = await readJSON(receiptPath), result = await verifyEvidenceAudit(receipt.evidenceStorage, receiptPath); console.log(JSON.stringify(result)); process.exitCode = result.status === 'PASS' ? 0 : result.status === 'FAIL' ? 1 : 2; return; }
  const allocation = await loadAllocation(options.allocation ?? process.env.IE_EVIDENCE_ALLOCATION);
  if (mode === 'root') { console.log(allocation.root); return; }
  let result;
  if (mode === 'sample') { const sample = await sampleVolume(allocation); result = { sample, alarm: volumeAlarm(sample, allocation.capacityBytes), continuousCoverage: false }; }
  if (mode === 'index') result = await createRetentionIndex({ allocation, output: resolve(options.output), entries: await readJSON(options.entries) });
  if (mode === 'verify-export') result = await verifyEvidenceExport({ allocation, indexPath: resolve(options.index), exportRoot: resolve(options['export-root']), output: resolve(options.output) });
  if (mode === 'eligible') result = await eligibleEvidence({ allocation, indexPath: resolve(options.index), exportReceiptPath: resolve(options['export-receipt']), ...(options.now ? { now: options.now } : {}) });
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
