import {ownTestRoot} from '../../tooling/qualification/owned-test-roots.mjs';
import { fork } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
export const encode = value => Buffer.from(JSON.stringify(value));
export const zeroEffects = { submit: 0, upload: 0, poll: 0, cancel: 0, fetch: 0, socket: 0, dns: 0, datagram: 0 };
export const expectedBytes = Buffer.from('{"entities":[],"schemaVersion":1}');
export const refFor = bytes => ({ hash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, byteLength: String(bytes.length), mediaType: 'application/json' });
export async function rootFor(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ideogram-store-'));
  return ownTestRoot(root);
}
export async function childFor(t, root, options = {}) {
  const child = fork(fileURLToPath(new URL('./process-fixture.mjs', import.meta.url)), [root, JSON.stringify(options)], {
    execArgv: ['--import', fileURLToPath(new URL('./no-network.mjs', import.meta.url))], serialization: 'advanced',
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
  let nextId = 0; const pending = new Map(); const messages = []; const listeners = [];
  const exit = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; } });
  child.on('message', message => {
    if (message.id !== undefined) {
      const promise = pending.get(message.id); if (!promise) return;
      pending.delete(message.id);
      if (message.type === 'error') promise.reject(Object.assign(new Error(message.code), { code: message.code }));
      else promise.resolve(message.result);
    } else {
      const index = listeners.findIndex(item => item.type === message.type);
      if (index >= 0) listeners.splice(index, 1)[0].resolve(message); else messages.push(message);
    }
  });
  child.on('exit', () => { for (const p of pending.values()) p.reject(new Error('Child exited')); pending.clear(); });
  function wait(type) {
    const index = messages.findIndex(message => message.type === type);
    return index >= 0 ? Promise.resolve(messages.splice(index, 1)[0]) : new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}: ${stderr}`)), 10000).unref();
      listeners.push({ type, resolve: value => { clearTimeout(timer); resolve(value); } });
    });
  }
  const startup = await Promise.race([wait('ready'), wait('startup-error'), exit.then(() => { throw new Error(`Startup exited: ${stderr}`); })]);
  function call(method, ...args) {
    return new Promise((resolve, reject) => {
      const id = ++nextId; pending.set(id, { resolve, reject });
      child.send({ id, method, args }, error => { if (error) { pending.delete(id); reject(error); } });
    });
  }
  return { child, startup, epoch: startup.epoch, call, wait, stderr: () => stderr,
    async kill() { child.kill('SIGKILL'); await exit; },
    async close() { await call('close'); await exit; },
    async assertNoEffects() { assert.deepEqual(await call('effects'), zeroEffects); },
  };
}
export async function putExpected(child) { return child.call('put', expectedBytes, refFor(expectedBytes)); }
export function command(ref, patch = {}, bodyPatch = {}) {
  return { protocolVersion: 1, command: { schemaVersion: 1, commandId: randomUUID(), clientId: 'client_1', sessionId: 'session_1',
    correlationId: 'correlation_1', causationId: null, transactionId: randomUUID(), documentId: 'document_1',
    expectedDocumentRevision: null, expectedEntityVersions: ref, issuedAt: '2026-09-26T03:00:00.000Z',
    body: { type: 'NewDocument', width: 1200, height: 800, color: 'sRGB', depth: 8, ...bodyPatch }, ...patch } };
}
export function checkpoint(ref, revision, name = 'Checkpoint') {
  return command(ref, { expectedDocumentRevision: revision, body: { type: 'SaveCheckpoint', name } });
}
