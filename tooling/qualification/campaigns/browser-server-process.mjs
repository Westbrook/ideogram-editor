import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
// The controller's campaign harness may test a different subject revision.
// Resolve production code from that revision, never from the harness checkout.
const [root, staticDirectory, repo, setupModule] = process.argv.slice(2);
const { startLocalServer } = await import(pathToFileURL(join(repo, 'dist/local/server/http.js')).href);
const server = await startLocalServer({ root, staticDirectory, credentialConfigured: false }, {
  writer: setupModule ? { setupModule } : { effectCounters: globalThis.__storeNetworkCounters?.shared },
});
process.send({ type: 'ready', origin: server.origin });
process.on('message', message => {
  if (message === 'pair') process.send({ type: 'pair', url: server.issuePairingURL() });
  if (message === 'resources') process.send({ type: 'resources', value: process.memoryUsage() });
  if (message === 'effects') process.send({ type: 'effects', value: globalThis.__storeNetworkCounters?.read() ?? null });
  if (message && typeof message === 'object' && /^[A-Za-z0-9_-]{1,128}$/.test(message.id ?? '') && ['raster-worker-state','restart-raster-worker'].includes(message.type)) {
    const work = message.type === 'raster-worker-state' ? server.rasterMaintenance.state() : server.rasterMaintenance.restartIdle(message.expectedGeneration);
    void work.then(value => process.send({ type: 'raster-maintenance-reply', id: message.id, value }), error => process.send({ type: 'raster-maintenance-reply', id: message.id, error: { code: /^[A-Z_]{1,64}$/.test(error?.code ?? '') ? error.code : 'MAINTENANCE_FAILED' } }));
  }
  if (message === 'close') void server.close().then(() => process.disconnect());
});
