import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function processIdentity(pid) {
  try {
    // The command name may contain spaces and parentheses. Fields after its
    // final ')' begin at field 3; starttime is field 22 and identifies PID reuse.
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { pid, parent: Number(fields[1]), start: fields[19] };
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error.code)) return null;
    throw error;
  }
}
async function descendants(root) {
  // Linux /proc also finds browser processes that create their own process
  // group. On other POSIX systems only the owned process group is available.
  if (process.platform !== 'linux') return [];
  const processes = (await Promise.all((await readdir('/proc')).filter(name => /^\d+$/.test(name)).map(name => processIdentity(Number(name))))).filter(Boolean);
  const owned = new Set([root]);
  for (let changed = true; changed;) {
    changed = false;
    for (const item of processes) if (owned.has(item.parent) && !owned.has(item.pid)) { owned.add(item.pid); changed = true; }
  }
  return processes.filter(item => owned.has(item.pid));
}
function signalGroup(pid, signal) {
  try { process.kill(-pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
async function signalIdentities(owned, signal) {
  for (const identity of owned) {
    const current = await processIdentity(identity.pid);
    if (current?.start !== identity.start) continue;
    try { process.kill(identity.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

export async function boundedChild(executable, args, { cwd, env, timeoutMs, graceMs = 5_000, onStdout, onStderr, abortSignal }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(graceMs) || graceMs < 1) throw Error('Positive deadlines are required');
  if (process.platform === 'win32') throw Error('Container qualification requires a POSIX process group');
  if (abortSignal?.aborted) return { code: null, signal: null, exitObserved: false, timedOut: false, interrupted: true,
    reason: String(abortSignal.reason ?? 'Aborted'), timeoutMs, requestedSignals: [] };
  const child = spawn(executable, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', onStdout ?? (() => {}));
  child.stderr.on('data', onStderr ?? (() => {}));
  let timer, terminationWork, observedExit, resolveTermination, rejectTermination;
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { observedExit = { code, signal }; resolve(observedExit); });
  });
  const terminated = new Promise((resolve, reject) => { resolveTermination = resolve; rejectTermination = reject; });
  function terminate(interrupted, reason) {
    // Keep the first cause authoritative if a timeout and caller cancellation
    // arrive together; both use exactly the same owned-tree cleanup.
    if (terminationWork) return;
    clearTimeout(timer);
    terminationWork = (async () => {
        const owned = [];
        try {
          owned.push(...await descendants(child.pid));
          signalGroup(child.pid, 'SIGTERM');
          await signalIdentities(owned, 'SIGTERM');
          await pause(graceMs);
          // Recheck descendants before killing parents; captured starttimes also
          // cover children reparented after their npm/test process exited.
          owned.push(...await descendants(child.pid));
        } finally {
          // A failed /proc observation must still terminate the owned group.
          try { await signalIdentities(owned, 'SIGKILL'); }
          finally { signalGroup(child.pid, 'SIGKILL'); child.stdout.destroy(); child.stderr.destroy(); }
        }
        // Preserve the observed root exit separately from signals requested of
        // the tree. A graceful root exit still fails after its deadline.
        await Promise.race([closed, pause(100)]);
        return { ...(observedExit ?? { code: null, signal: null }), exitObserved: Boolean(observedExit), timedOut: !interrupted, interrupted,
          ...(interrupted ? { reason } : {}), timeoutMs,
          requestedSignals: ['SIGTERM', 'SIGKILL'],
          processTree: process.platform === 'linux' ? 'owned-group-and-proc-descendants' : 'owned-group' };
    })();
    terminationWork.then(resolveTermination, rejectTermination);
  }
  const abort = () => terminate(true, String(abortSignal.reason ?? 'Aborted'));
  timer = setTimeout(() => terminate(false), timeoutMs);
  abortSignal?.addEventListener('abort', abort, { once: true });
  if (abortSignal?.aborted) abort();
  try {
    const result = await Promise.race([closed, terminated]);
    // A child can exit after TERM while a descendant remains. Always finish the
    // deadline's hard-kill phase rather than reporting that early exit as a pass.
    return terminationWork ? await terminationWork : { ...result, timedOut: false, interrupted: false, timeoutMs };
  } finally {
    clearTimeout(timer);
    abortSignal?.removeEventListener('abort', abort);
  }
}
