// Local prerequisite extraction only. This scheduler supplies no Docker/kernel
// capability grant and is never used for native builds, restores or timing work.
import {createHash} from 'node:crypto';

export const TOOLCHAIN_SCHEDULING = 'local-toolchain-quiescent-inodes-1';
export const SYNCHRONIZATION_WINDOW_MS = 1000;
export const COMMAND_ALLOWANCE_MS = 2000;
export const OBSERVATION_CADENCE_MS = 2000;
export const COVERAGE_BOUND_MS = 4000;
const require = (value, code) => { if (!value) throw Error(code); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hash = value => createHash('sha256').update(value).digest('hex');
const code = error => /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.message ?? '') ? error.message : 'LOCAL_QUIESCENCE_OPERATION_FAILED';
const cid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const processShape = row => positive(row?.pid) && typeof row.startTime === 'string' && /^[0-9]{1,20}$/.test(row.startTime)
  && Number.isSafeInteger(row.parent) && row.parent >= 0
  && ['uids', 'gids'].every(key => Array.isArray(row[key]) && row[key].length === 4 && row[key].every(positive))
  && Array.isArray(row.groups) && row.groups.length === 0
  && same(row.capabilities, ['0', '0', '0', '0', '0']) && row.noNewPrivs === '1' && typeof row.cgroupPath === 'string';
function owner(value) {
  require(typeof value === 'string' && /^[1-9][0-9]*:[1-9][0-9]*$/.test(value), 'LOCAL_QUIESCENCE_OWNER');
  const [uid, gid] = value.split(':').map(Number);
  require(positive(uid) && positive(gid), 'LOCAL_QUIESCENCE_OWNER');
  return {uid, gid};
}

// Raw worker output is retained by the controller's bounded command callback.
// These independently checked envelope fields bind comparisons to kernel data;
// the source-pinned worker owns complete hierarchy/credentials authentication.
export function parseKernelObservation(raw, expectedFrozen) {
  require(typeof raw === 'string' && Buffer.byteLength(raw) <= 65536, 'LOCAL_QUIESCENCE_KERNEL_BOUND');
  let value;
  try { value = JSON.parse(raw); } catch { throw Error('LOCAL_QUIESCENCE_KERNEL_JSON'); }
  require(value?.kind === 'local-cgroup-observation-1' && value.status === 'PASS' && value.frozen === expectedFrozen, 'LOCAL_QUIESCENCE_KERNEL_STATE');
  const binding = value.binding, group = binding?.cgroup;
  require(binding?.writer?.pid === 1 && typeof binding.writer.startTime === 'string' && /^[0-9]+$/.test(binding.writer.startTime) && group && typeof group.path === 'string' && group.path.startsWith('/') && Number.isSafeInteger(group.dev) && group.dev >= 0 && positive(group.ino) && positive(group.mountId), 'LOCAL_QUIESCENCE_KERNEL_BINDING');
  require(Array.isArray(binding.ancestry) && binding.ancestry.length > 0 && binding.ancestry.length <= 128 && typeof binding.observerCgroup?.path === 'string' && binding.observerCgroup.path !== group.path && Number.isSafeInteger(binding.observerCgroup.dev) && positive(binding.observerCgroup.ino), 'LOCAL_QUIESCENCE_KERNEL_INDEPENDENCE');
  require(Array.isArray(value.members) && value.members.length > 0 && value.members.length <= 4096 && value.members.every(row => positive(row.pid) && typeof row.startTime === 'string' && /^[0-9]+$/.test(row.startTime)) && value.members.every((row, i) => i === 0 || row.pid > value.members[i - 1].pid), 'LOCAL_QUIESCENCE_KERNEL_MEMBERS');
  require(value.members.some(row => row.pid === 1 && row.startTime === binding.writer.startTime) && positive(value.observer?.pid) && !value.members.some(row => row.pid === value.observer.pid), 'LOCAL_QUIESCENCE_KERNEL_INIT');
  require(value.members.every(row => processShape(row) && row.cgroupPath === group.path) && processShape(value.observer) && value.observer.cgroupPath === binding.observerCgroup.path, 'LOCAL_QUIESCENCE_KERNEL_CREDENTIAL');
  return value;
}

/**
 * command receives Docker subcommands (the controller pins binary/context),
 * retains raw output/actual intervals, and enforces absolute deadlineMs plus
 * the unchanged 2 s child bound. cleanup:true must work after cancellation.
 * A fresh admitted writer stays alive until close() has proved thaw. Container
 * and payload drainage are the controller's separate lifecycle responsibility.
 */
export function createToolchainQuiescence({writer, kernelObserver, command, retain, clock = () => performance.now(), onUncertain = () => {}}) {
  require(cid(writer?.id) && cid(kernelObserver?.id) && writer.id !== kernelObserver.id, 'LOCAL_QUIESCENCE_CID');
  require(typeof writer.runId === 'string' && /^ie-linux-[a-f0-9]{32}$/.test(writer.runId) && typeof writer.image === 'string' && /^sha256:[a-f0-9]{64}$/.test(writer.image), 'LOCAL_QUIESCENCE_WRITER');
  const writerOwner = owner(writer.user), observerOwner = owner(kernelObserver.user);
  require(writerOwner.uid !== observerOwner.uid, 'LOCAL_QUIESCENCE_DISTINCT_OWNER');
  require(typeof command === 'function' && typeof retain === 'function' && typeof clock === 'function' && typeof onUncertain === 'function', 'LOCAL_QUIESCENCE_CALLBACK');
  // Copy admission values so mutable caller objects cannot redirect cleanup.
  const selected = {...writer}, observer = {...kernelObserver};
  const argv = frozen => ['exec', '--user', observer.user, observer.id, '/usr/bin/python3', '-I', '-S', '-B', '/inputs/local-cgroup-observer.py', '--writer-uid', String(writerOwner.uid), '--writer-gid', String(writerOwner.gid), '--observer-uid', String(observerOwner.uid), '--observer-gid', String(observerOwner.gid), '--expect-frozen', String(frozen)];
  let binding = null, admitted = false, failure = null, cleanupUncertain = false, needsThaw = false, active = null, closing = false, closed = false, observations = 0, lastKernel = null;
  const fail = error => { failure ??= code(error); return error; };
  const check = deadline => require(Number.isFinite(clock()) && clock() <= deadline, 'LOCAL_QUIESCENCE_WINDOW_EXCEEDED');
  async function uncertain(error) {
    cleanupUncertain = true;
    try { await onUncertain({code: code(error), writerId: selected.id, observerId: observer.id}); } catch { /* sticky local flag still prevents a successful closure */ }
  }
  async function kernel(frozen, deadlineMs, cleanup = false) {
    const raw = await command('toolchain-kernel-' + frozen, argv(frozen), {deadlineMs, cleanup});
    const value = parseKernelObservation(raw, frozen);
    require(value.members.every(row => row.uids.every(uid => uid === writerOwner.uid) && row.gids.every(gid => gid === writerOwner.gid)) && value.observer.uids.every(uid => uid === observerOwner.uid) && value.observer.gids.every(gid => gid === observerOwner.gid), 'LOCAL_QUIESCENCE_KERNEL_OWNER');
    if (binding) require(same(value.binding, binding), 'LOCAL_QUIESCENCE_IDENTITY_DRIFT');
    lastKernel = value;
    return {value, evidence: {sha256: hash(raw), frozen, bindingSHA256: hash(JSON.stringify(value.binding)), membersSHA256: hash(JSON.stringify(value.members))}};
  }
  async function thaw(trace, deadlineMs) {
    trace.thawRequestedMs = clock();
    // Even an expired synchronization window gets one bounded cleanup attempt.
    // Its extra time is recorded as failure, never removed from elapsed time.
    const cleanupDeadline = Math.max(deadlineMs, clock() + COMMAND_ALLOWANCE_MS);
    await command('toolchain-unpause', ['unpause', selected.id], {deadlineMs: cleanupDeadline, cleanup: true});
    const result = await kernel(0, cleanupDeadline, true);
    trace.thawed = result.evidence;
    trace.thawedMs = clock();
    needsThaw = false;
    return result.value;
  }
  async function admit() {
    require(!admitted && !active && !closing && !closed && failure === null, 'LOCAL_QUIESCENCE_ADMISSION_STATE');
    // Reserve the lane synchronously; duplicate admits/observes cannot overlap.
    let settle;
    active = new Promise(resolve => { settle = resolve; });
    const startedMs = clock(), deadlineMs = startedMs + COMMAND_ALLOWANCE_MS;
    try {
      const result = await kernel(0, deadlineMs);
      check(deadlineMs);
      binding = structuredClone(result.value.binding);
      await retain({kind: 'local-toolchain-admission-1', policy: TOOLCHAIN_SCHEDULING, writer: selected, observer, startedMs, endedMs: clock(), kernel: result.evidence});
      check(deadlineMs);
      admitted = true;
      return result.value;
    } catch (error) { throw fail(error); }
    finally { active = null; settle(); }
  }
  async function observe(scan) {
    require(admitted && !active && !closing && !closed && failure === null && typeof scan === 'function', 'LOCAL_QUIESCENCE_OBSERVATION_STATE');
    let settle;
    active = new Promise(resolve => { settle = resolve; });
    const startedMs = clock(), deadlineMs = startedMs + SYNCHRONIZATION_WINDOW_MS;
    const trace = {kind: 'local-toolchain-coordination-1', policy: TOOLCHAIN_SCHEDULING, sequence: observations++, writerId: selected.id, observerId: observer.id, windowMs: SYNCHRONIZATION_WINDOW_MS, commandAllowanceMs: COMMAND_ALLOWANCE_MS, cadenceMs: OBSERVATION_CADENCE_MS, coverageBoundMs: COVERAGE_BOUND_MS, startedMs, pauseRequestedMs: null, frozenMs: null, scanStartedMs: null, scanEndedMs: null, recheckedMs: null, thawRequestedMs: null, thawedMs: null, endedMs: null, frozen: null, rechecked: null, thawed: null, failure: null, cleanupFailure: null};
    let observation, primary = null;
    try {
      check(deadlineMs);
      trace.pauseRequestedMs = clock(); needsThaw = true;
      await command('toolchain-pause', ['pause', selected.id], {deadlineMs, cleanup: false});
      const before = await kernel(1, deadlineMs);
      trace.frozen = before.evidence; trace.frozenMs = clock(); check(deadlineMs);
      trace.scanStartedMs = clock();
      observation = await scan({outerDeadlineMs: startedMs + COMMAND_ALLOWANCE_MS});
      trace.scanEndedMs = clock(); check(deadlineMs);
      const after = await kernel(1, deadlineMs);
      trace.rechecked = after.evidence; trace.recheckedMs = clock();
      require(same(before.value.members, after.value.members), 'LOCAL_QUIESCENCE_MEMBERSHIP_DRIFT');
      check(deadlineMs);
    } catch (error) { primary = error; trace.failure = {code: code(error)}; }
    finally {
      if (needsThaw) {
        try { await thaw(trace, deadlineMs); }
        catch (error) { trace.cleanupFailure = {code: code(error)}; primary ??= error; await uncertain(error); }
      }
      trace.endedMs = clock();
      if (trace.endedMs > deadlineMs) { primary ??= Error('LOCAL_QUIESCENCE_WINDOW_EXCEEDED'); trace.failure ??= {code: 'LOCAL_QUIESCENCE_WINDOW_EXCEEDED'}; }
      try {
        await retain(structuredClone(trace));
        // Journal I/O consumes elapsed time too. Preserve the earlier record
        // and append the refusal rather than making slow retention invisible.
        if (clock() > deadlineMs && !primary) {
          primary = Error('LOCAL_QUIESCENCE_WINDOW_EXCEEDED');
          trace.failure = {code: code(primary)}; trace.endedMs = clock();
          await retain(structuredClone(trace));
        }
      } catch (error) { primary ??= error; trace.failure ??= {code: code(error)}; }
      active = null; settle();
    }
    if (primary) { primary.coordinationTrace = trace; throw fail(primary); }
    return {observation, coordination: trace};
  }
  async function close() {
    if (closed) return {complete: !cleanupUncertain, thawed: !needsThaw, cleanupUncertain, kernelObservation: lastKernel};
    require(!closing, 'LOCAL_QUIESCENCE_CLOSE_OVERLAP');
    closing = true;
    if (active) await active;
    const startedMs = clock(), trace = {kind: 'local-toolchain-close-1', policy: TOOLCHAIN_SCHEDULING, writerId: selected.id, observerId: observer.id, startedMs, endedMs: null, failure: null};
    let primary = null;
    try {
      if (needsThaw) await thaw(trace, startedMs + COMMAND_ALLOWANCE_MS);
      else await kernel(0, startedMs + COMMAND_ALLOWANCE_MS, true);
      check(startedMs + COMMAND_ALLOWANCE_MS);
    } catch (error) { primary = error; trace.failure = {code: code(error)}; await uncertain(error); }
    trace.endedMs = clock();
    try { await retain(trace); } catch (error) { primary ??= error; }
    closed = true;
    if (primary) throw fail(primary);
    return {complete: !cleanupUncertain, thawed: !needsThaw, cleanupUncertain, kernelObservation: lastKernel};
  }
  return {admit, observe, close, summary: () => ({policy: TOOLCHAIN_SCHEDULING, admitted, closed, observations, failure, cleanupUncertain, needsThaw})};
}
