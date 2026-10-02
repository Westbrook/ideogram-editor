import {createTapCounter} from './gate-log-reader.mjs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { functionalGates, versions } from './manifest.mjs';
import { boundedChild } from './container/bounded-child.mjs';
import { gateOutcome } from './core.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export function qualificationTestPlan(repository = root) {
  const gate = functionalGates(repository).find(gate => gate.id === 'node:qualification');
  if (!gate?.files.length) throw Error('No qualification tooling tests discovered');
  return { ...gate, dependencies: [], scope: 'Recursive qualification tooling tests only; no product build or runtime/browser campaign is executed by this entry point.' };
}

async function main(args) {
  if (args.length > 1 || args.length && args[0] !== '--list') throw Error('Usage: node tooling/qualification/test.mjs [--list]');
  const plan = qualificationTestPlan();
  if (args[0] === '--list') { console.log(JSON.stringify(plan, null, 2)); return; }
  if (process.versions.node !== versions.node) throw Error(`Use pinned Node ${versions.node}`);
  const controller = new AbortController(), interrupt = () => controller.abort('SIGINT'), terminate = () => controller.abort('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  const counter = createTapCounter();
  try {
    const result = await boundedChild(process.execPath, plan.command.slice(1), { cwd: root, env: process.env, timeoutMs: plan.timeoutMs, abortSignal: controller.signal,
      onStdout: bytes => { process.stdout.write(bytes); counter.append(bytes); }, onStderr: bytes => { process.stderr.write(bytes); counter.append(bytes); } });
    const summary = counter.finish();
    const outcome = gateOutcome({ ...result, exitCode: result.code, counts: summary.counts, logError: summary.error }, true);
    if (outcome !== 'PASS') process.exitCode = result.interrupted ? result.reason === 'SIGINT' ? 130 : 143 : result.code || 1;
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
}

if (import.meta.main) await main(process.argv.slice(2));
