import { join } from 'node:path';
import { retainEncodedDiagnosticEvidence } from './diagnostic-evidence.mjs';
import { pathToFileURL } from 'node:url';
// The controller's campaign harness may test a different subject revision.
// Resolve production code from that revision, never from the harness checkout.
const [root, staticDirectory, repo, setupModule, diagnosticOutput] = process.argv.slice(2);
const { startLocalServer } = await import(pathToFileURL(join(repo, 'dist/local/server/http.js')).href);
const server = await startLocalServer({ root, staticDirectory, credentialConfigured: false }, {
  writer: setupModule ? { setupModule } : { effectCounters: globalThis.__storeNetworkCounters?.shared },
});
process.send({ type: 'ready', origin: server.origin });
const pending = new Set(); let closing = false, closePromise;
const send = value => new Promise((resolveSend, rejectSend) => {
  const cleanup = () => { process.off('disconnect', disconnected); };
  const failed = error => { cleanup(); rejectSend(error); };
  const disconnected = () => failed(Error('DIAGNOSTIC_IPC_DISCONNECTED'));
  process.once('disconnect', disconnected);
  try {
    if (!process.connected || typeof process.send !== 'function') throw Error('DIAGNOSTIC_IPC_DISCONNECTED');
    process.send(value, error => { cleanup(); if (error) rejectSend(error); else resolveSend(); });
  } catch (error) { failed(error); }
});
const close = () => closePromise ??= (async () => {
  closing = true; await Promise.allSettled([...pending]); await server.close();
  if (process.connected) process.disconnect();
})();
process.once('disconnect', () => { void close().catch(() => { process.exitCode = 1; }); });
process.on('message', message => {
  if (message === 'close') { void close().catch(() => { process.exitCode = 1; }); return; }
  if (closing) return;
  if (message === 'pair') process.send({ type: 'pair', url: server.issuePairingURL() });
  if (message === 'resources') process.send({ type: 'resources', value: process.memoryUsage() });
  if (message === 'effects') process.send({ type: 'effects', value: globalThis.__storeNetworkCounters?.read() ?? null });
  if (message && typeof message === 'object' && /^[A-Za-z0-9_-]{1,128}$/.test(message.id ?? '') && ['raster-worker-state','restart-raster-worker','encoded-rebuild-evidence'].includes(message.type)) {
    if (pending.size >= 4) {
      void send({ type: 'raster-maintenance-reply', id: message.id, error: { code: 'DIAGNOSTIC_READ_LIMIT' } }).catch(() => {}); return;
    }
    const work = (async () => {
      let read;
      try {
        if (message.type === 'encoded-rebuild-evidence') {
          read = await server.rasterMaintenance.readEncodedEvidence();
          const value = await retainEncodedDiagnosticEvidence(diagnosticOutput, read.value);
          // No raw diagnostic graph crosses IPC. Complete retention and release
          // must succeed before publishing the detached bounded projection.
          read.release(); read = undefined;
          await send({ type: 'raster-maintenance-reply', id: message.id, value });
        } else {
          const value = await (message.type === 'raster-worker-state' ? server.rasterMaintenance.state() : server.rasterMaintenance.restartIdle(message.expectedGeneration));
          await send({ type: 'raster-maintenance-reply', id: message.id, value });
        }
      } catch (error) {
        if (process.connected) await send({ type: 'raster-maintenance-reply', id: message.id, error: { code: /^[A-Z_]{1,64}$/.test(error?.code ?? '') ? error.code : 'MAINTENANCE_FAILED' } }).catch(() => {});
      } finally { read?.release(); }
    })();
    pending.add(work); void work.finally(() => pending.delete(work)).catch(() => { process.exitCode = 1; });
  }
});
