import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileIdentity, errorRecord } from './common.mjs';
const exec = promisify(execFile);

async function observedProcess(pid) {
  try {
    const { stdout } = await exec('/bin/ps', ['-p', String(pid), '-o', 'pgid=', '-o', 'lstart='], { timeout: 5000, maxBuffer: 4096, env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
    const line = stdout.trim(), match = /^(\d+)\s+(.+)$/.exec(line);
    return match ? { pgid: Number(match[1]), startedAtIdentity: match[2].trim() } : null;
  } catch (error) { if (error.code === 1) return null; throw error; }
}

/** Playwright and the admitted native WindowServer observer create detached
 * process groups. Its child-owned
 * immutable registration is validated against current OS process identity before
 * cleanup, so a recycled PID or unrelated process is never killed. */
export async function cleanupOwnedProcesses(output, ownerPid, hooks = {}) {
  const observe = hooks.observe ?? observedProcess, kill = hooks.kill ?? ((pid, signal) => process.kill(pid, signal));
  const groupAlive = hooks.groupAlive ?? (pgid => { try { process.kill(-pgid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } });
  const pause = hooks.pause ?? (() => new Promise(resolve => setTimeout(resolve, 25)));
  async function confirmExit(entry) {
    const deadline = performance.now() + 2000;
    for (let poll = 0; poll < 80 && performance.now() < deadline; poll++) {
      const current = await observe(entry.pid);
      if (current && (current.pgid !== entry.pgid || current.startedAtIdentity !== entry.startedAtIdentity)) return 'identity-changed-not-touched';
      if (!current && !await groupAlive(entry.pgid)) return 'exit-confirmed';
      await pause();
    }
    throw Error('Owned process exit could not be confirmed after termination');
  }
  const results = [];
  for (const name of (await readdir(output)).filter(name => /^owned-process-\d+-[A-Za-z0-9-]+\.json$/.test(name)).sort()) {
    const record = JSON.parse(await readFile(join(output, name), 'utf8'));
    if (record.kind !== 'perf-owned-processes-1' || record.ownerPid !== ownerPid || !Array.isArray(record.processes)) throw Error('Owned process registration does not belong to this worker');
    for (const entry of record.processes) {
      if (!['browser', 'backend', 'windowserver'].includes(entry.kind) || !Number.isSafeInteger(entry.pid) || entry.pid < 2 || !Number.isSafeInteger(entry.pgid) || entry.pgid < 2 || entry.pid === process.pid || entry.pgid === process.pid || entry.pid === ownerPid) throw Error('Unsafe owned process registration');
      const current = await observe(entry.pid);
      if (!current) { results.push({ pid: entry.pid, status: await confirmExit(entry) }); continue; }
      if (current.pgid !== entry.pgid || current.startedAtIdentity !== entry.startedAtIdentity) { results.push({ pid: entry.pid, status: 'identity-changed-not-touched' }); continue; }
      if (entry.pgid === ownerPid) { results.push({ pid: entry.pid, status: await confirmExit(entry) }); continue; }
      if (entry.pgid !== entry.pid || !['browser', 'windowserver'].includes(entry.kind)) throw Error('Unexpected detached owned process group');
      try { kill(-entry.pgid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      results.push({ pid: entry.pid, pgid: entry.pgid, status: await confirmExit(entry), registration: { path: name, ...await fileIdentity(join(output, name)) } });
    }
  }
  return results;
}
