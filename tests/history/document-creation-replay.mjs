// Executed only by document-creation.test.mjs with both no-network and
// no-raster preloads. A successful reopen/idempotent retry cannot re-render.
import assert from 'node:assert/strict';
import {openWriter} from '../../dist/local/server/storage/writer.js';
import {encode} from '../store/helpers.mjs';
const [root,json,importedId]=process.argv.slice(2),request=JSON.parse(json);
const writer=await openWriter({root});
try{
  const original=await writer.document(request.command.documentId),imported=await writer.document(importedId);
  const auth={clientId:request.command.clientId,sessionHash:'f'.repeat(64),now:Date.now(),expires:Date.now()+1800000};
  const receipt=await writer.historyCommand(encode(request),auth);assert.equal(receipt.status,'accepted');
  const effects=globalThis.__storeNetworkCounters.read();assert(Object.values(effects).every(value=>value===0));
  process.stdout.write(JSON.stringify({original,imported,receipt,effects}));
}finally{await writer.close();}
