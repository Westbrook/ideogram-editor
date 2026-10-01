import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {transformWithOxc} from 'vite';

// Real destination control flow and native ReadableStream; only the external
// writable boundary is controlled to expose admission and drain timing.
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const compile=async path=>(await transformWithOxc(await readFile(path,'utf8'),path)).code;
const [source,allocationSource,shaSource]=await Promise.all([
 compile('src/state/destination.ts'),compile('src/observability/allocations.ts'),compile('src/protocol/sha256.ts'),
]);
let sequence=0;
async function modules(){
 const allocationURL=data(allocationSource+'\n// Isolated native-boundary fixture '+(++sequence));
 const destinationURL=data(source.replaceAll('../observability/allocations.js',allocationURL).replaceAll('../protocol/sha256.js',data(shaSource)));
 return {...await import(allocationURL),...await import(destinationURL)};
}
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const observed=promise=>promise.then(value=>({value}),error=>({error}));
const payload=Uint8Array.of(31,22,13,4);
const download={path:'/exact',name:'exact.bin',bytes:String(payload.length),hash:'sha256:'+createHash('sha256').update(payload).digest('hex')};
function response({close=true,cancel=()=>{}}={}){
 return new Response(new ReadableStream({start(controller){controller.enqueue(payload);if(close)controller.close();},cancel}),{headers:{etag:'"'+download.hash+'"','content-length':download.bytes}});
}

test('destination reserves copying before write and retains writer ownership through close',async()=>{
 const {writeDestination,allocationLedger}=await modules(),writeEntered=deferred(),writeRelease=deferred(),closeEntered=deferred(),closeRelease=deferred();
 const writes=[],sink={async write(bytes){writes.push(new Uint8Array(bytes));writeEntered.resolve();await writeRelease.promise;},async close(){closeEntered.resolve();await closeRelease.promise;},async abort(){assert.fail('successful stream must not abort');}};
 const work=writeDestination(download,async()=>response(),Promise.resolve({async createWritable(){return sink;}}));
 await writeEntered.promise;const duringWrite=allocationLedger.snapshot();assert.equal(duringWrite.cpuBytes,12);assert.equal(duringWrite.byKind.copy.cpuBytes,8);assert.equal(duringWrite.handles,5);
 writeRelease.resolve();await closeEntered.promise;const duringClose=allocationLedger.snapshot();assert.equal(duringClose.cpuBytes,0);assert.equal(duringClose.handles,1);
 closeRelease.resolve();assert.equal(await work,'confirmed');assert.deepEqual(writes,[payload]);assert.equal(allocationLedger.snapshot().activeRecords,0);
});

test('destination refuses the explicit copy before native write and drains prior owners',async()=>{
 const {writeDestination,allocationLedger,ALLOCATION_LIMITS}=await modules();let writes=0,aborts=0,cancels=0;
 const pressure=allocationLedger.reserve({owner:'test-destination-pressure',kind:'control',cpuBytes:ALLOCATION_LIMITS.cpuBytes-ALLOCATION_LIMITS.textPartitionBytes-payload.length});
 const sink={async write(){writes++;},async close(){assert.fail('refused allocation cannot commit');},async abort(){aborts++;}};
 try{await assert.rejects(writeDestination(download,async()=>response({close:false,cancel(){cancels++;}}),Promise.resolve({async createWritable(){return sink;}})),/ALLOCATION_BUDGET/);
  assert.equal(writes,0);assert.equal(aborts,1);assert.equal(cancels,1);assert.equal(allocationLedger.snapshot().activeRecords,1);
 }finally{pressure.release();}
 assert.equal(allocationLedger.snapshot().activeRecords,0);
});

test('a rejected write remains charged until native abort settles',async()=>{
 const {writeDestination,allocationLedger}=await modules(),abortEntered=deferred(),abortRelease=deferred();
 const sink={async write(){throw Error('NATIVE_WRITE_FAILED');},async close(){assert.fail('failed write cannot commit');},async abort(){abortEntered.resolve();await abortRelease.promise;}};
 const result=observed(writeDestination(download,async()=>response(),Promise.resolve({async createWritable(){return sink;}})));
 await abortEntered.promise;const waiting=allocationLedger.snapshot();assert.equal(waiting.cpuBytes,8);assert.equal(waiting.byKind.copy.handles,2);assert.equal(waiting.activeRecords,2);
 abortRelease.resolve();assert.match((await result).error?.message??'',/NATIVE_WRITE_FAILED/);assert.equal(allocationLedger.snapshot().activeRecords,0);
});

test('uncertain native abort keeps the failed copy charged and marked unused',async()=>{
 const {writeDestination,allocationLedger}=await modules();
 const sink={async write(){throw Error('NATIVE_WRITE_FAILED');},async close(){assert.fail('failed write cannot commit');},async abort(){throw Error('NATIVE_ABORT_FAILED');}};
 await assert.rejects(writeDestination(download,async()=>response(),Promise.resolve({async createWritable(){return sink;}})),error=>error instanceof AggregateError&&error.errors.some(item=>item.message==='NATIVE_ABORT_FAILED'));
 const unresolved=allocationLedger.snapshot();assert.equal(unresolved.cpuBytes,8);assert.equal(unresolved.activeRecords,2);assert.equal(unresolved.unusedHandles,3);
 // This fixture owns an isolated ledger. A failed native owner is deliberately
 // not reset or relabeled released merely to make the accounting return zero.
});

test('source cancellation failure preserves the error while the settled reader lock is released',async()=>{
 const {writeDestination,allocationLedger}=await modules(),controller=new AbortController(),reason=Error('USER_CANCEL'),cleanupFailure=Error('SOURCE_CANCEL_FAILED');
 const sink={async write(){controller.abort(reason);},async close(){assert.fail('canceled stream cannot commit');},async abort(){}};
 await assert.rejects(writeDestination(download,async()=>response({close:false,cancel(){throw cleanupFailure;}}),Promise.resolve({async createWritable(){return sink;}}),controller.signal),error=>error instanceof AggregateError&&error.errors[0]===reason&&error.errors[1]===cleanupFailure);
 assert.equal(allocationLedger.snapshot().activeRecords,0);
});

test('response validation refusal cancels the body before a reader was acquired',async()=>{
 const {writeDestination,allocationLedger}=await modules();let cancels=0,aborts=0;
 const sink={async write(){assert.fail('invalid response must not write');},async close(){assert.fail('invalid response must not commit');},async abort(){aborts++;}};
 const invalid=response({close:false,cancel(){cancels++;}});invalid.headers.set('etag','"incorrect"');
 await assert.rejects(writeDestination(download,async()=>invalid,Promise.resolve({async createWritable(){return sink;}})),/DOWNLOAD_UNAVAILABLE/);
 assert.equal(cancels,1);assert.equal(aborts,1);assert.equal(allocationLedger.snapshot().activeRecords,0);
});

test('reader handle refusal cancels the body and aborts the already admitted writer',async()=>{
 const {writeDestination,allocationLedger,ALLOCATION_LIMITS}=await modules();let cancels=0,aborts=0;
 const pressure=allocationLedger.reserve({owner:'test-reader-pressure',kind:'control',handles:ALLOCATION_LIMITS.handles-1});
 const sink={async write(){assert.fail('reader refusal must not write');},async close(){assert.fail('reader refusal must not commit');},async abort(){aborts++;}};
 try{await assert.rejects(writeDestination(download,async()=>response({close:false,cancel(){cancels++;}}),Promise.resolve({async createWritable(){return sink;}})),/ALLOCATION_BUDGET/);
  assert.equal(cancels,1);assert.equal(aborts,1);assert.equal(allocationLedger.snapshot().activeRecords,1);
 }finally{pressure.release();}
 assert.equal(allocationLedger.snapshot().activeRecords,0);
});
