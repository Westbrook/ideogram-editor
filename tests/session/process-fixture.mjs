import { startLocalServer } from '../../dist/local/server/http.js';
const server = await startLocalServer({ root: process.argv[2] });
process.send({ origin: server.origin });
process.on('message', message => {
  if (message === 'pair') process.send({ pairingURL: server.issuePairingURL() });
});
process.on('SIGTERM', () => { void server.close().then(() => process.disconnect()); });
