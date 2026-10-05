import test from 'node:test';
import assert from 'node:assert/strict';
import {createToolchainQuiescence, parseKernelObservation, CREDENTIAL_POLICY, SYNCHRONIZATION_WINDOW_MS, COMMAND_ALLOWANCE_MS, OBSERVATION_CADENCE_MS, COVERAGE_BOUND_MS} from '../../tooling/rollback-producer/local-toolchain-quiescence.mjs';

const writer = () => ({id: 'a'.repeat(64), runId: 'ie-linux-' + 'b'.repeat(32), image: 'sha256:' + 'c'.repeat(64), user: '1001:1001'});
const observer = () => ({id: 'd'.repeat(64), user: '1002:1002'});
const member = (pid, startTime = String(pid * 10)) => ({pid, startTime, parent: pid === 1 ? 0 : 1, uids: [1001, 1001, 1001, 1001], gids: [1001, 1001, 1001, 1001], groups: [], capabilities: ['0', '0', '0', '0', '0'], noNewPrivs: '1', cgroupPath: '/writer'});
function snapshot(frozen) {
  return {kind: 'local-cgroup-observation-1', status: 'PASS', credentialPolicy: CREDENTIAL_POLICY, frozen,
    binding: {writer: {pid: 1, startTime: '10'}, cgroup: {path: '/writer', dev: 7, ino: 11, mountId: 12}, ancestry: [{path: '/'}], observerCgroup: {path: '/observer', dev: 7, ino: 14}},
    members: [member(1), member(2)], observer: {...member(90), uids: [1002, 1002, 1002, 1002], gids: [1002, 1002, 1002, 1002], cgroupPath: '/observer'}};
}
function fixture({alter, reject, retainHook, selectedWriter = writer(), selectedObserver = observer()} = {}) {
  let now = 0, kernelCount = 0;
  const commands = [], traces = [], uncertainties = [];
  const args = {writer: selectedWriter, kernelObserver: selectedObserver,
    clock: () => now,
    onUncertain: async value => { uncertainties.push(value); },
    retain: async trace => { traces.push(structuredClone(trace)); if (retainHook) await retainHook(trace, advance); },
    command: async (label, argv, options) => {
      commands.push({label, argv, options}); now += 10;
      if (reject?.(label, commands.length)) throw Error('SYNTHETIC_COMMAND_FAILURE');
      if (argv[0] === 'exec') {
        const value = snapshot(Number(argv.at(-1)));
        alter?.(value, kernelCount++, label);
        return JSON.stringify(value);
      }
      return selectedWriter.id;
    },
  };
  function advance(ms) { now += ms; }
  return {args, scheduler: createToolchainQuiescence(args), commands, traces, uncertainties, advance, scan: async ({outerDeadlineMs}) => { assert.ok(outerDeadlineMs > now); advance(30); return {bytes: 4096}; }};
}

test('only full distinct CIDs and distinct nonroot numeric owners can enter the scheduler', () => {
  for (const delta of [w => { w.id = 'abc123'; }, w => { w.runId = 'arbitrary'; }, w => { w.image = 'ubuntu:latest'; }, w => { w.user = '0:0'; }]) {
    const w = writer(); delta(w); assert.throws(() => fixture({selectedWriter: w}));
  }
  assert.throws(() => fixture({selectedObserver: {...observer(), id: writer().id}}));
  assert.throws(() => fixture({selectedObserver: {...observer(), user: '1001:1002'}}));
});

test('admission is required and the entire successful scan is enclosed by actual frozen kernel observations', async () => {
  const f = fixture();
  await assert.rejects(f.scheduler.observe(f.scan), /OBSERVATION_STATE/);
  const idle = await f.scheduler.admit(); assert.equal(idle.frozen, 0);
  const result = await f.scheduler.observe(f.scan);
  assert.deepEqual(result.observation, {bytes: 4096});
  assert.deepEqual(f.commands.map(x => x.label), ['toolchain-kernel-0', 'toolchain-pause', 'toolchain-kernel-1', 'toolchain-kernel-1', 'toolchain-unpause', 'toolchain-kernel-0']);
  assert.ok(result.coordination.frozenMs <= result.coordination.scanStartedMs);
  assert.ok(result.coordination.scanEndedMs <= result.coordination.recheckedMs);
  assert.ok(result.coordination.recheckedMs <= result.coordination.thawRequestedMs);
  assert.equal(result.coordination.frozen.membersSHA256, result.coordination.rechecked.membersSHA256);
  assert.equal(result.coordination.failure, null); assert.equal(result.coordination.cleanupFailure, null);
  assert.deepEqual([SYNCHRONIZATION_WINDOW_MS, COMMAND_ALLOWANCE_MS, OBSERVATION_CADENCE_MS, COVERAGE_BOUND_MS], [1000, 2000, 2000, 4000]);
  const closed = await f.scheduler.close(); assert.equal(closed.complete, true); assert.equal(closed.kernelObservation.frozen, 0);
  // Closing proves thaw, not an empty kernel cgroup: init remains alive.
  assert.equal(closed.kernelObservation.members.length, 2);
});

test('caller mutation cannot redirect exact-CID control or the observer worker', async () => {
  const w = writer(), o = observer(), f = fixture({selectedWriter: w, selectedObserver: o});
  w.id = 'e'.repeat(64); o.id = 'f'.repeat(64); o.user = '0:0';
  await f.scheduler.admit(); await f.scheduler.observe(f.scan);
  assert.ok(f.commands.filter(x => x.argv[0] !== 'exec').every(x => x.argv[1] === 'a'.repeat(64)));
  for (const {argv} of f.commands.filter(x => x.argv[0] === 'exec')) {
    assert.deepEqual(argv.slice(0, 9), ['exec', '--user', '1002:1002', 'd'.repeat(64), '/usr/bin/python3', '-I', '-S', '-B', '/inputs/local-cgroup-observer.py']);
  }
});

test('a pause command refusal still attempts exact-CID unpause and proves thaw', async () => {
  const f = fixture({reject: label => label === 'toolchain-pause'}); await f.scheduler.admit();
  await assert.rejects(f.scheduler.observe(f.scan), error => { assert.equal(error.coordinationTrace.cleanupFailure, null); return /SYNTHETIC_COMMAND_FAILURE/.test(error.message); });
  assert.deepEqual(f.commands.slice(-2).map(x => x.label), ['toolchain-unpause', 'toolchain-kernel-0']);
  assert.equal(f.scheduler.summary().needsThaw, false);
  await assert.rejects(f.scheduler.observe(f.scan), /OBSERVATION_STATE/);
});

test('Docker pause success alone never admits a scan', async () => {
  const f = fixture({alter: (value, count) => { if (count === 1) value.frozen = 0; }}); await f.scheduler.admit();
  let scanned = false;
  await assert.rejects(f.scheduler.observe(async () => { scanned = true; }), /KERNEL_STATE/);
  assert.equal(scanned, false); assert.equal(f.commands.at(-2).label, 'toolchain-unpause');
});

test('PID reuse, changed membership and privilege changes during the frozen scan refuse the observation', async () => {
  for (const mutate of [value => { value.members[1].startTime = '21'; }, value => { value.members.push(member(3)); }, value => { value.members[1].capabilities[2] = '1'; }]) {
    const f = fixture({alter: (value, count) => { if (count === 2) mutate(value); }}); await f.scheduler.admit();
    await assert.rejects(f.scheduler.observe(f.scan), /MEMBERSHIP_DRIFT|KERNEL_CREDENTIAL/);
    assert.equal(f.scheduler.summary().cleanupUncertain, false);
    assert.equal(f.commands.at(-1).label, 'toolchain-kernel-0');
  }
});

test('group replacement or changed namespace-init identity cannot reuse an admitted binding', async () => {
  for (const mutate of [value => { value.binding.cgroup.ino += 1; }, value => { value.binding.writer.startTime = '11'; value.members[0].startTime = '11'; }, value => { value.binding.ancestry.push({path: '/changed'}); }]) {
    const f = fixture({alter: (value, count) => { if (count === 1) mutate(value); }}); await f.scheduler.admit();
    await assert.rejects(f.scheduler.observe(f.scan), /IDENTITY_DRIFT/);
    assert.equal(f.commands.at(-2).label, 'toolchain-unpause');
  }
});

test('a failed or overlong scan still thaws and cannot be retried on the same scheduler', async () => {
  for (const scan of [async () => { throw Error('SYNTHETIC_SCAN_FAILURE'); }, async f => { f.advance(1001); }]) {
    const f = fixture(); await f.scheduler.admit();
    await assert.rejects(f.scheduler.observe(() => scan(f)));
    assert.equal(f.commands.at(-2).label, 'toolchain-unpause');
    assert.equal(f.commands.at(-2).options.cleanup, true);
    assert.ok(f.commands.at(-2).options.deadlineMs > f.commands[1].options.deadlineMs);
    await assert.rejects(f.scheduler.observe(f.scan), /OBSERVATION_STATE/);
  }
});

test('unknown thaw is sticky and signals retained lease even if subsequent close obtains thaw proof', async () => {
  let refused = false;
  const f = fixture({reject: label => { if (label === 'toolchain-unpause' && !refused) { refused = true; return true; } return false; }});
  await f.scheduler.admit();
  await assert.rejects(f.scheduler.observe(f.scan));
  assert.equal(f.uncertainties.length, 1); assert.equal(f.scheduler.summary().needsThaw, true);
  const result = await f.scheduler.close();
  assert.equal(result.thawed, true); assert.equal(result.complete, false); assert.equal(result.cleanupUncertain, true);
  const count = f.commands.length; assert.equal((await f.scheduler.close()).complete, false); assert.equal(f.commands.length, count);
});

test('failed kernel thaw readback counts as uncertain even if Docker unpause returns success', async () => {
  const f = fixture({alter: (value, count) => { if (count === 3) value.frozen = 1; }}); await f.scheduler.admit();
  await assert.rejects(f.scheduler.observe(f.scan), /KERNEL_STATE/);
  assert.equal(f.scheduler.summary().cleanupUncertain, true); assert.equal(f.uncertainties.length, 1);
});

test('new members after successful thaw are allowed, but the frozen observations must agree', async () => {
  const f = fixture({alter: (value, count) => { if (count === 3) value.members.push(member(3)); }}); await f.scheduler.admit();
  assert.equal((await f.scheduler.observe(f.scan)).coordination.failure, null);
});

test('slow trace retention is charged to the same window and retains the subsequent refusal', async () => {
  let delayed = false;
  const f = fixture({retainHook: async (trace, advance) => { if (trace.kind === 'local-toolchain-coordination-1' && !delayed) { delayed = true; advance(1001); } }}); await f.scheduler.admit();
  await assert.rejects(f.scheduler.observe(f.scan), /WINDOW_EXCEEDED/);
  assert.equal(f.traces.at(-1).failure.code, 'LOCAL_QUIESCENCE_WINDOW_EXCEEDED');
  assert.equal(f.scheduler.summary().needsThaw, false);
});

test('cancellation and journal failure preserve refusal while cleanup remains enabled', async () => {
  const f = fixture(); await f.scheduler.admit();
  await assert.rejects(f.scheduler.observe(async () => { const error = Error('CANCELLED'); error.name = 'AbortError'; throw error; }), /CANCELLED/);
  assert.ok(f.commands.slice(-2).every(row => row.options.cleanup === true));
  assert.equal(f.scheduler.summary().failure, 'CANCELLED');
  const g = fixture({retainHook: trace => { if (trace.kind === 'local-toolchain-coordination-1') throw Error('JOURNAL_FAILURE'); }});
  await g.scheduler.admit();
  await assert.rejects(g.scheduler.observe(g.scan), /JOURNAL_FAILURE/);
  assert.equal(g.scheduler.summary().failure, 'JOURNAL_FAILURE');
  assert.equal(g.scheduler.summary().needsThaw, false);
  await assert.rejects(g.scheduler.observe(g.scan), /OBSERVATION_STATE/);
});

test('overlapping observation is refused and close waits for active scan and thaw before its final proof', async () => {
  const f = fixture(); await f.scheduler.admit();
  let release, entered;
  const scanEntered = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const running = f.scheduler.observe(async () => { entered(); await wait; return 5; });
  await scanEntered;
  await assert.rejects(f.scheduler.observe(f.scan), /OBSERVATION_STATE/);
  const closing = f.scheduler.close(); release();
  assert.equal((await running).observation, 5); assert.equal((await closing).complete, true);
  assert.deepEqual(f.commands.slice(-3).map(x => x.label), ['toolchain-unpause', 'toolchain-kernel-0', 'toolchain-kernel-0']);
  await assert.rejects(f.scheduler.observe(f.scan), /OBSERVATION_STATE/);
});

test('kernel envelopes reject missing real proof, observer overlap, unordered members and init mismatch', () => {
  for (const mutate of [v => { v.status = 'FAIL'; }, v => { delete v.binding; }, v => { v.members.reverse(); }, v => { v.observer.pid = 1; }, v => { v.binding.writer.startTime = '999'; }, v => { v.binding.observerCgroup.path = '/writer'; }, v => { v.binding.ancestry = []; }]) {
    const value = snapshot(1); mutate(value); assert.throws(() => parseKernelObservation(JSON.stringify(value), 1));
  }
  assert.throws(() => parseKernelObservation('x'.repeat(65537), 1), /KERNEL_BOUND/);
  assert.throws(() => parseKernelObservation('{', 1), /KERNEL_JSON/);
});

test('the explicit local group policy accepts only empty or a single already-required primary group and retains its raw form', async () => {
  for (const writerPrimary of [false, true]) for (const observerPrimary of [false, true]) {
    const f = fixture({alter: value => {
      if (writerPrimary) value.members.forEach(row => { row.groups = [1001]; });
      if (observerPrimary) value.observer.groups = [1002];
    }});
    const idle = await f.scheduler.admit();
    assert.deepEqual(idle.members[0].groups, writerPrimary ? [1001] : []);
    assert.deepEqual(idle.observer.groups, observerPrimary ? [1002] : []);
    const result = await f.scheduler.observe(f.scan);
    assert.equal(result.coordination.credentialPolicy, 'local-primary-group-authority-1');
    assert.equal(result.coordination.frozen.credentialPolicy, CREDENTIAL_POLICY);
    const closed = await f.scheduler.close();
    assert.equal(closed.complete, true);
    assert.deepEqual(closed.kernelObservation.members[0].groups, writerPrimary ? [1001] : []);
    assert.ok(f.traces.every(trace => trace.credentialPolicy === CREDENTIAL_POLICY));
    assert.equal(f.scheduler.summary().credentialPolicy, CREDENTIAL_POLICY);
  }
});

test('both writer and observer refuse unrelated, duplicate, root, mixed and malformed supplemental group lists', () => {
  for (const role of ['writer', 'observer']) {
    const gid = role === 'writer' ? 1001 : 1002;
    for (const groups of [[0], [gid + 5], [gid, gid], [gid, gid + 5], [0, gid], [String(gid)], null, '']) {
      const value = snapshot(1), row = role === 'writer' ? value.members[0] : value.observer;
      row.groups = groups;
      assert.throws(() => parseKernelObservation(JSON.stringify(value), 1), /KERNEL_CREDENTIAL/);
    }
  }
});

test('primary-only supplemental groups do not weaken all-four expected GID or nonroot admission', async () => {
  for (const role of ['writer', 'observer']) {
    for (const gids of [[0, 0, 0, 0], [1008, 1008, 1008, 1008], [1001, 1002, 1001, 1001]]) {
      const f = fixture({alter: value => {
        const row = role === 'writer' ? value.members[0] : value.observer;
        row.gids = gids; row.groups = [gids[0]];
      }});
      await assert.rejects(f.scheduler.admit(), /KERNEL_CREDENTIAL|KERNEL_OWNER/);
      assert.equal(f.commands.length, 1);
    }
  }
});

test('old or mismatched credential policy markers cannot be reinterpreted as successor evidence', () => {
  for (const policy of [undefined, null, '', 'local-primary-group-authority-0', 'hosted-empty-groups-1']) {
    const value = snapshot(1); value.credentialPolicy = policy;
    assert.throws(() => parseKernelObservation(JSON.stringify(value), 1), /CREDENTIAL_POLICY/);
  }
});

test('a change between empty and primary-only raw group lists during freeze is still membership drift', async () => {
  const f = fixture({alter: (value, count) => { if (count === 2) value.members[1].groups = [1001]; }});
  await f.scheduler.admit();
  await assert.rejects(f.scheduler.observe(f.scan), /MEMBERSHIP_DRIFT/);
  assert.equal(f.commands.at(-2).label, 'toolchain-unpause');
  assert.equal(f.scheduler.summary().cleanupUncertain, false);
});
