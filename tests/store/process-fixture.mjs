import { openWriter } from '../../dist/local/server/storage/writer.js';
const [root, optionsJSON = '{}'] = process.argv.slice(2);
const options = JSON.parse(optionsJSON);
const gate = new SharedArrayBuffer(4);
let writer;
try {
  writer = await openWriter({ root, quotaBytes: options.quotaBytes }, { phase: options.phase, gate, maxPageCount: options.maxPageCount,
    effectCounters: globalThis.__storeNetworkCounters.shared,
    onFailure: failure => process.send({ type: 'failure', failure }),
    onBarrier: phase => process.send({ type: 'barrier', phase }) });
  process.send({ type: 'ready', epoch: writer.epoch });
} catch (error) { process.send({ type: 'startup-error', code: error.code }); process.disconnect(); }
if (writer) process.on('message', async message => {
  const { id, method, args = [] } = message;
  try {
    let result;
    if (method === 'release') { Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0); result = true; }
    else if (method === 'effects') result = globalThis.__storeNetworkCounters.read();
    else if (method === 'put') {
      const [bytes, descriptor, epoch] = args;
      result = await writer.putObject([bytes], descriptor, epoch ?? writer.epoch);
    } else if (method === 'submit') result = await writer.submit(args[0], args[1] ?? writer.epoch);
    else result = await writer[method](...args);
    process.send({ type: 'result', id, result });
    if (method === 'close') process.disconnect();
  } catch (error) { process.send({ type: 'error', id, code: error.code, message: error.message }); }
});
