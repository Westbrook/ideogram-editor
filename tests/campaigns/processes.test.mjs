import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupOwnedProcesses } from '../../tooling/qualification/campaigns/processes.mjs';

async function registration(t, entry = {}) {
  const output = await mkdtemp(join(tmpdir(), 'owned-campaign-process-'));
  t.after(() => rm(output, { force: true, recursive: true }));
  const owned = { kind: 'browser', pid: 900001, pgid: 900001, startedAtIdentity: 'known-birth', ...entry };
  await writeFile(join(output, 'owned-process-1-browser.json'), JSON.stringify({ kind: 'perf-owned-processes-1', ownerPid: 900000, processes: [owned] }));
  return { output, owned };
}

test('termination needs observed process and whole group exit before recovery can proceed', async t => {
  const { output, owned } = await registration(t), signals = []; let observations = 0, pauses = 0;
  const rows = await cleanupOwnedProcesses(output, 900000, {
    observe: async () => ++observations < 3 ? owned : null,
    groupAlive: async () => observations < 4,
    kill: (...args) => signals.push(args), pause: async () => { pauses++; },
  });
  assert.deepEqual(signals, [[-900001, 'SIGKILL']]);
  assert.equal(rows[0].status, 'exit-confirmed'); assert.equal(pauses, 2);
});

test('a changed PID identity is never signalled', async t => {
  const { output, owned } = await registration(t);
  const rows = await cleanupOwnedProcesses(output, 900000, {
    observe: async () => ({ ...owned, startedAtIdentity: 'unrelated-reused-pid' }),
    kill: () => assert.fail('unrelated process must not be touched'),
  });
  assert.equal(rows[0].status, 'identity-changed-not-touched');
});

test('signal delivery alone cannot certify cleanup', async t => {
  const { output, owned } = await registration(t); let pauses = 0;
  await assert.rejects(cleanupOwnedProcesses(output, 900000, {
    observe: async () => owned, groupAlive: async () => true,
    kill: () => {}, pause: async () => { pauses++; },
  }), /exit could not be confirmed/);
  assert.equal(pauses, 80);
});

test('worker group members are checked after controller termination without another kill', async t => {
  const { output, owned } = await registration(t, { kind: 'backend', pgid: 900000 }); let observed = 0;
  const rows = await cleanupOwnedProcesses(output, 900000, {
    observe: async () => ++observed === 1 ? owned : null, groupAlive: async () => false,
    kill: () => assert.fail('worker group was terminated by its controller'), pause: async () => {},
  });
  assert.equal(rows[0].status, 'exit-confirmed');
});

test('missing leader with a live group remains unresolved and cannot trigger recovery', async t => {
  const { output } = await registration(t);
  await assert.rejects(cleanupOwnedProcesses(output, 900000, {
    observe: async () => null, groupAlive: async () => true,
    kill: () => assert.fail('no current leader identity authorizes termination'), pause: async () => {},
  }), /exit could not be confirmed/);
});
