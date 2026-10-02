import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startLocalServer } from '../../dist/local/server/http.js';

const root = process.argv[2];
const resultSize = process.env.IE_REQUEST_EDITS_RESULT_SIZE;
if (resultSize !== undefined && resultSize !== '256' && resultSize !== '512') throw Error('REQUEST_EDITS_FIXTURE_RESULT_SIZE');
const setupModule = new URL('./observer-fixture.mjs', import.meta.url);
if (resultSize !== undefined) setupModule.searchParams.set('resultSize', resultSize);
const server = await startLocalServer({ root, staticDirectory: process.argv[3], credentialConfigured: false }, {
  writer: { setupModule: setupModule.href },
});
process.send({ type: 'ready', origin: server.origin });
process.on('message', message => {
  if (message === 'pair') process.send({ type: 'pair', url: server.issuePairingURL() });
  if (message === 'effects') void readFile(join(root, 'request-edits-fixture.json'), 'utf8')
    .then(value => process.send({ type: 'effects', value: JSON.parse(value) }));
  if (message === 'close') void server.close().then(() => process.disconnect());
});
