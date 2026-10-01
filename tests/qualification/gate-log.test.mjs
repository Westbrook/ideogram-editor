import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateLog } from '../../tooling/qualification/container/gate-log.mjs';
import { boundedChild } from '../../tooling/qualification/container/bounded-child.mjs';

test('gate logging applies bounded writes and handles partial filesystem writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qualification-log-'));
  try {
    const path = join(directory, 'log'), log = createGateLog(path, undefined, { write: (fd, bytes, offset, length) => writeSync(fd, bytes, offset, Math.min(3, length)) });
    log.append('complete bounded record'); log.close(); log.close();
    assert.equal(log.error, undefined); assert.equal(await readFile(path, 'utf8'), 'complete bounded record');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('filesystem log failure aborts and awaits the owned child cleanup instead of throwing from a pipe event', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qualification-log-'));
  try {
    const error = Object.assign(Error('simulated disk full'), { code: 'ENOSPC' });
    const log = createGateLog(join(directory, 'log'), undefined, { write: () => { throw error; } });
    const result = await boundedChild(process.execPath, ['--eval', "process.stdout.write('ready');setInterval(()=>{},1000)"], { cwd: directory, env: {}, timeoutMs: 5000, graceMs: 50, abortSignal: log.signal, onStdout: bytes => log.append(bytes), onStderr: bytes => log.append(bytes) });
    log.close();
    assert.equal(log.error, error); assert.equal(result.interrupted, true); assert.equal(result.timedOut, false);
    assert.deepEqual(result.requestedSignals, ['SIGTERM', 'SIGKILL']); assert.match(result.reason, /disk full/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an already cancelled parent prevents logging from launching new work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qualification-log-'));
  try {
    const controller = new AbortController(); controller.abort('parent cancelled');
    const log = createGateLog(join(directory, 'log'), controller.signal);
    assert.equal(log.signal.aborted, true); assert.equal(log.signal.reason, 'parent cancelled'); log.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
