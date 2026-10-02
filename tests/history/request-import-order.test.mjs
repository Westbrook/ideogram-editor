import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

const execute=promisify(execFile);
const compiled=new URL('../../dist/local/',import.meta.url).href;
const entries=[
 'server/storage/history.js', 'server/storage/canonical.js',
 'src/request/core.js', 'src/request/family.js', 'src/request/review.js',
 'src/protocol/validate.js', 'src/protocol/queue.js', 'src/protocol/v45-inputs.js',
];
// Each entry starts a fresh ESM graph. Importing all entries in one process can
// hide a temporal-dead-zone failure once a favorable first import has completed.
const program=String.raw`
import assert from 'node:assert/strict';
const [compiled,entry]=process.argv.slice(1);
await import(new URL(entry,compiled));
const v4=await import(new URL('src/request/core.js',compiled));
const family=await import(new URL('src/request/family.js',compiled));
const queue=await import(new URL('src/protocol/queue.js',compiled));
const vocabulary=await import(new URL('src/protocol/queue-events.js',compiled));
const validation=await import(new URL('src/protocol/validate.js',compiled));
assert.deepEqual(v4.operations,['generate','instant','fast','transform','inpaint','generate-adapters','transform-adapters','inpaint-adapters']);
assert.deepEqual(family.operations,[...v4.operations,'generate-v45','transform-v45','inpaint-v45']);
assert.deepEqual(family.labels.slice(0,v4.labels.length),v4.labels);
for(const operation of v4.operations)assert.deepEqual(family.routes[operation],v4.routes[operation]);
assert.equal(queue.queueEvents,vocabulary.queueEvents);
assert.deepEqual(queue.queueEvents,['LocalQueueReordered','JobQueued','QueueStateChanged','SpendGuardChanged','SpendSessionStarted','CandidateStateChanged','DocumentDeletionPreviewed','DocumentDeleted','DocumentGarbageCollected']);
const prompt='Retained literal prompt',draft=v4.newDraft({hash:v4.hash(prompt),byteLength:String(Buffer.byteLength(prompt)),mediaType:'text/plain'});
const request=v4.resolve(draft,prompt);
assert.deepEqual(family.resolve(draft,prompt),request);
assert.equal(family.bodyTemplate(request,prompt),v4.bodyTemplate(request,prompt));
const event={schemaVersion:1,payloadVersion:1,eventId:'event_1',workspaceSeq:'1',streamId:'assets',streamSeq:'1',documentId:null,resultingDocumentRevision:null,commandId:'command_1',correlationId:'correlation_1',causationId:null,transactionId:'transaction_1',writerEpoch:'1',recordedAt:'2026-09-30T00:00:00.000Z',type:'JobQueued',payload:{id:'job_1',version:'1',state:{hash:'sha256:'+'0'.repeat(64),byteLength:'0',mediaType:'application/json'}}};
for(const type of queue.queueEvents){validation.event({...event,type});assert.throws(()=>validation.event({...event,type,documentId:'document_1'}));}
process.stdout.write(JSON.stringify({entry,imported:true}));
`;
for(const entry of entries)test('request graph initializes when '+entry+' is imported first',{timeout:15000},async()=>{
 const {stdout}=await execute(process.execPath,[
  '--import',fileURLToPath(new URL('../session/no-egress.mjs',import.meta.url)),
  '--input-type=module','--eval',program,compiled,entry,
 ],{timeout:10000,killSignal:'SIGKILL',maxBuffer:65536});
 assert.deepEqual(JSON.parse(stdout),{entry,imported:true});
});
