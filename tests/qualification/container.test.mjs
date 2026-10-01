import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { boundedChild } from '../../tooling/qualification/container/bounded-child.mjs';

test('a completed command preserves its status and output', async () => {
  const chunks = [];
  const result = await boundedChild(process.execPath, ['-e', 'process.stdout.write("observed");process.exitCode=7'],
    { timeoutMs: 5_000, onStdout: chunk => chunks.push(chunk) });
  assert.equal(result.code, 7);
  assert.equal(result.timedOut, false);
  assert.equal(Buffer.concat(chunks).toString(), 'observed');
});

test('a timeout stops TERM-resistant parent and descendant activity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qualification-process-tree-'));
  const heartbeat = join(directory, 'heartbeat');
  const descendant = `const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'.'),10);`;
  const parent = `const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit',detached:${process.platform === 'linux'}});setInterval(()=>{},10);`;
  try {
    const result = await boundedChild(process.execPath, ['-e', parent], { timeoutMs: 2_000, graceMs: 100 });
    assert.equal(result.timedOut, true);
    assert.deepEqual(result.requestedSignals, ['SIGTERM', 'SIGKILL']);
    const stopped = await readFile(heartbeat, 'utf8');
    assert.ok(stopped.length > 0, 'The descendant must have run before the deadline');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await readFile(heartbeat, 'utf8'), stopped, 'No descendant activity survives the deadline');
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('a graceful root exit after a deadline remains a failed timeout', async () => {
  const result = await boundedChild(process.execPath,
    ['-e', "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},10)"],
    { timeoutMs: 1_000, graceMs: 100 });
  assert.equal(result.timedOut, true);
  assert.equal(result.exitObserved, true);
  assert.equal(result.code, 0);
  assert.deepEqual(result.requestedSignals, ['SIGTERM', 'SIGKILL']);
});

test('a pre-aborted signal prevents command execution', async () => {
  const controller = new AbortController();
  controller.abort('cancelled before launch');
  const result = await boundedChild('/command-that-must-not-launch', [], { timeoutMs: 1_000, abortSignal: controller.signal });
  assert.equal(result.interrupted, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.reason, 'cancelled before launch');
  assert.equal(result.exitObserved, false);
  assert.deepEqual(result.requestedSignals, []);
});

test('interruption awaits a resistant descendant after the root exits gracefully', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qualification-process-abort-'));
  const heartbeat = join(directory, 'heartbeat');
  const controller = new AbortController();
  const descendant = `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.appendFileSync(${JSON.stringify(heartbeat)},'.');process.stdout.write('ready');setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'.'),10);`;
  const parent = `const {spawn}=require('node:child_process');process.on('SIGTERM',()=>process.exit(0));const c=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','pipe','ignore'],detached:${process.platform === 'linux'}});c.stdout.once('data',()=>process.stdout.write('ready'));setInterval(()=>{},10);`;
  try {
    const result = await boundedChild(process.execPath, ['-e', parent], {
      timeoutMs: 5_000, graceMs: 100, abortSignal: controller.signal,
      onStdout: chunk => { if (chunk.toString().includes('ready')) controller.abort('owned cancellation'); },
    });
    assert.equal(result.interrupted, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.reason, 'owned cancellation');
    assert.equal(result.exitObserved, true);
    assert.equal(result.code, 0, 'The root may exit successfully while a descendant still needs cleanup');
    assert.deepEqual(result.requestedSignals, ['SIGTERM', 'SIGKILL']);
    const stopped = await readFile(heartbeat, 'utf8');
    assert.ok(stopped.length > 0);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await readFile(heartbeat, 'utf8'), stopped, 'Cancellation must finish descendant cleanup before resolving');
  } finally {
    await rm(directory, { recursive: true });
  }
});
