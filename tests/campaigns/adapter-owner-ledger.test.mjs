// Source-only staging. Run only after promotion and the normal server build.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { AdapterResourceObserver } from '../../dist/local/server/observability/adapter-resources.js';

const moduleURL = new URL('../../dist/local/server/observability/adapter-resources.js', import.meta.url);
const aggregate = observer => observer.snapshot().aggregate;
function peer(parent) {
  const participant = parent.reserveAggregateParticipant();
  assert.notEqual(participant, null);
  const observer = new AdapterResourceObserver();
  observer.bindAggregate(parent.aggregateBuffer(), participant);
  return { observer, participant };
}

test('shared backing views are counted once and release is idempotent', () => {
  const observer = new AdapterResourceObserver(), backing = new ArrayBuffer(4096);
  const first = observer.buffer('unit', 'first', new Uint8Array(backing, 0, 512));
  const second = observer.buffer('unit', 'second', new Uint8Array(backing, 512, 1024));
  assert.equal(observer.snapshot().cpuBytes, 4096);
  assert.equal(aggregate(observer).currentCpuBytes, 4096);
  first(); first(); assert.equal(aggregate(observer).currentCpuBytes, 4096);
  second(); assert.equal(aggregate(observer).currentCpuBytes, 0);
  assert.equal(aggregate(observer).peakCpuBytes, 4096);
});

test('non-overlapping realm peaks are not added into a fictional concurrent peak', () => {
  const main = new AdapterResourceObserver(), { observer: writer, participant } = peer(main);
  const a = main.buffer('main', 'bytes', new Uint8Array(8192)); a();
  const b = writer.buffer('writer', 'bytes', new Uint8Array(16384)); b();
  assert.equal(main.snapshot().peakCpuBytes + writer.snapshot().peakCpuBytes, 24576);
  assert.equal(aggregate(main).peakCpuBytes, 16384);
  assert.equal(aggregate(main).aggregateId, aggregate(writer).aggregateId);
  main.retireAggregateParticipant(participant);
  assert.equal(aggregate(main).integrityComplete, true);
});

test('concurrent owned buffers and actual booked leases share one aggregate', () => {
  const main = new AdapterResourceObserver(), { observer: writer, participant } = peer(main);
  const a = main.buffer('main', 'bytes', new Uint8Array(4096));
  const b = writer.buffer('writer', 'bytes', new Uint8Array(8192));
  const reservation = writer.reservation('writer', 'proof-metadata', 2048);
  assert.equal(aggregate(main).currentCpuBytes, 14336);
  assert.equal(aggregate(writer).peakCpuBytes, 14336);
  b(); reservation(); a();
  assert.equal(aggregate(main).currentCpuBytes, 0);
  main.resetPeaks(); writer.resetPeaks();
  assert.equal(aggregate(main).peakCpuBytes, 14336);
  assert.equal(aggregate(main).window, 0);
  assert.equal(aggregate(main).peakScope, 'process-lifetime');
  main.retireAggregateParticipant(participant);
});

test('nested scopes and rejection relinquish observed ownership', async () => {
  const observer = new AdapterResourceObserver();
  await assert.rejects(observer.scope('outer', async () => {
    observer.retain('outer', 'bytes', new Uint8Array(4096));
    await observer.scope('inner', () => { observer.retain('inner', 'bytes', new Uint8Array(8192)); });
    assert.equal(aggregate(observer).currentCpuBytes, 4096);
    throw Error('rejection');
  }), /rejection/);
  assert.equal(observer.snapshot().activeLeases, 0);
  assert.equal(aggregate(observer).currentCpuBytes, 0);
  assert.equal(aggregate(observer).peakCpuBytes, 12288);
});

test('evidence gaps survive local peak reset and shared payloads are not double-counted', () => {
  const observer = new AdapterResourceObserver();
  observer.buffer('unit', 'shared-payload', new Uint8Array(new SharedArrayBuffer(64)))();
  observer.retain('unit', 'unscoped', new Uint8Array(8));
  observer.resetPeaks();
  assert.equal(aggregate(observer).currentCpuBytes, 0);
  assert.equal(aggregate(observer).integrityComplete, false);
  assert.equal(aggregate(observer).droppedTransitions, 2);
  assert.equal(observer.snapshot().unscopedReturnedBuffers, 1);
});

test('bounded observer overflow cannot become complete after reset', () => {
  const observer = new AdapterResourceObserver(), releases = [];
  for (let index = 0; index < 129; index++) releases.push(observer.handle('unit', 'group-' + index));
  for (const release of releases) release();
  observer.resetPeaks();
  assert.equal(observer.snapshot().groups.length, 128);
  assert.equal(observer.snapshot().droppedTransitions, 1);
  assert.equal(aggregate(observer).integrityComplete, false);
});

test('returned byte ownership outlives promise delivery and ends on consumer release', async () => {
  const observer=new AdapterResourceObserver(),bytes=new Uint8Array(4096);
  const delivered=await Promise.resolve(observer.returnedBuffer('receiver','bytes',bytes));
  assert.equal(observer.snapshot().returnedBuffers,1);assert.equal(aggregate(observer).currentCpuBytes,4096);
  observer.releaseReturned(delivered);observer.releaseReturned(delivered);
  assert.equal(observer.snapshot().returnedBuffers,0);assert.equal(aggregate(observer).currentCpuBytes,0);
});

test('independent B0 window excludes a larger preparation-only peak', () => {
  const observer=new AdapterResourceObserver();
  const preparation=observer.buffer('preparation','bytes',new Uint8Array(32768));preparation();
  observer.beginLifecycleWindow();const first=aggregate(observer).lifecycleWindow;
  assert.equal(first.scope,'independent-B0-lifecycle-window');assert.equal(first.currentCpuBytes,0);
  const lifecycle=observer.buffer('lifecycle','bytes',new Uint8Array(4096));lifecycle();observer.endLifecycleWindow();
  const result=aggregate(observer),window=result.lifecycleWindow;
  assert.equal(result.peakCpuBytes,32768);assert.equal(window.peakCpuBytes,4096);
  assert.equal(window.currentCpuBytes,0);assert.equal(window.sealed,true);assert.equal(window.integrityComplete,true);
  assert.equal(window.id,first.id);assert.ok(BigInt(window.endMonotonicNs)>=BigInt(window.startMonotonicNs));
  observer.beginLifecycleWindow();assert.notEqual(aggregate(observer).lifecycleWindow.id,window.id);observer.endLifecycleWindow();
  assert.equal(aggregate(observer).lifecycleWindow.peakCpuBytes,0);assert.equal(aggregate(observer).peakCpuBytes,32768);
});

test('B0 window starts from actual currently owned bytes and preserves gaps', () => {
  const observer=new AdapterResourceObserver(),release=observer.reservation('proof','metadata',2048);
  observer.beginLifecycleWindow();assert.equal(aggregate(observer).lifecycleWindow.peakCpuBytes,2048);
  assert.throws(()=>observer.beginLifecycleWindow(),/already active/);
  const unknown=observer.returnedBuffer('receiver','unknown-shared',new Uint8Array(new SharedArrayBuffer(8)));observer.releaseReturned(unknown);
  release();observer.endLifecycleWindow();const window=aggregate(observer).lifecycleWindow;
  assert.equal(window.sealed,true);assert.equal(window.integrityComplete,false);
  assert.throws(()=>observer.endLifecycleWindow(),/No active/);
});

test('short uncovered ownership between samples invalidates interval coverage', () => {
  const observer=new AdapterResourceObserver();observer.beginLifecycleWindow();
  const before=aggregate(observer);assert.equal(before.coverageWitness.activeUncoveredOwners,0);
  const release=observer.uncovered('unit-uncovered');release();release();
  observer.endLifecycleWindow();const result=aggregate(observer);
  assert.equal(result.coverageWitness.activeUncoveredOwners,0);assert.equal(result.coverageWitness.activationCount,1);
  assert.equal(result.lifecycleWindow.coverage.startActivationCount,0);assert.equal(result.lifecycleWindow.coverage.endActivationCount,1);
  assert.equal(result.lifecycleWindow.coverage.complete,false);assert.equal(result.coverageComplete,false);
  assert.deepEqual(observer.snapshot().uncoveredOwners,[]);assert.equal(observer.snapshot().uncoveredActivations,1);
});

test('preparation activity is retained as history without poisoning a later covered interval', () => {
  const observer=new AdapterResourceObserver();observer.uncovered('preparation')();
  observer.beginLifecycleWindow();const release=observer.buffer('adapter','bytes',new Uint8Array(4096));release();observer.endLifecycleWindow();
  const result=aggregate(observer);assert.equal(result.coverageWitness.activationCount,1);
  assert.equal(result.lifecycleWindow.coverage.startActivationCount,1);assert.equal(result.lifecycleWindow.coverage.endActivationCount,1);
  assert.equal(result.coverageComplete,true);
});

test('an uncovered owner already active at B0 cannot gain coverage by becoming idle', () => {
  const observer=new AdapterResourceObserver(),release=observer.uncovered('retained-owner');
  observer.beginLifecycleWindow();release();observer.endLifecycleWindow();
  const result=aggregate(observer);assert.equal(result.lifecycleWindow.coverage.startActiveUncoveredOwners,1);
  assert.equal(result.lifecycleWindow.coverage.endActiveUncoveredOwners,0);assert.equal(result.coverageComplete,false);
});

test('uncovered transitions from a bound realm share the atomic interval witness', () => {
  const main=new AdapterResourceObserver(),{observer:writer,participant}=peer(main);
  main.beginLifecycleWindow();writer.uncovered('writer-other-rpc')();main.endLifecycleWindow();
  const result=aggregate(main);assert.equal(result.coverageWitness.activationCount,1);assert.equal(result.coverageComplete,false);
  assert.equal(result.lifecycleWindow.coverage.endActivationCount,aggregate(writer).lifecycleWindow.coverage.endActivationCount);
  main.retireAggregateParticipant(participant);
});

function launchObservedWorker(parent, bytes = 8192) {
  const participant = parent.reserveAggregateParticipant(); assert.notEqual(participant, null);
  const source = `
    import { parentPort, workerData } from 'node:worker_threads';
    import { AdapterResourceObserver } from ${JSON.stringify(moduleURL.href)};
    const observer = new AdapterResourceObserver();
    observer.bindAggregate(workerData.aggregate, workerData.participant);
    const release = observer.buffer('worker', 'owned', new Uint8Array(workerData.bytes));
    const releaseProof = observer.reservation('worker', 'proof-metadata', 2048);
    parentPort.postMessage({ kind: 'held', snapshot: observer.snapshot() });
    parentPort.once('message', () => {
      release(); releaseProof();
      parentPort.postMessage({ kind: 'released', snapshot: observer.snapshot() });
      parentPort.close();
    });
  `;
  const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(source)), {
    workerData: { aggregate: parent.aggregateBuffer(), participant, bytes },
  });
  const exited = once(worker, 'exit');
  return { worker, participant, exited };
}

test('actual worker threads update the same simultaneous peak', { timeout: 10000 }, async () => {
  const main = new AdapterResourceObserver(), { worker, participant, exited } = launchObservedWorker(main);
  let retired = false;
  try {
    const [held] = await once(worker, 'message'); assert.equal(held.kind, 'held');
    assert.equal(held.snapshot.aggregate.aggregateId, aggregate(main).aggregateId);
    assert.equal(aggregate(main).currentCpuBytes, 10240);
    const release = main.buffer('main', 'owned', new Uint8Array(16384));
    assert.equal(aggregate(main).peakCpuBytes, 26624); release();
    const released = once(worker, 'message'); worker.postMessage('release');
    assert.equal((await released)[0].kind, 'released'); await exited;
    main.retireAggregateParticipant(participant); retired = true;
    assert.equal(aggregate(main).currentCpuBytes, 0);
    assert.equal(aggregate(main).peakCpuBytes, 26624);
    assert.equal(aggregate(main).activeParticipants, 1);
    assert.equal(aggregate(main).integrityComplete, true);
  } finally { if (!retired) { await worker.terminate(); await exited.catch(() => {}); main.retireAggregateParticipant(participant, true); } }
});

test('confirmed abnormal worker exit invalidates integrity and retires its contribution', { timeout: 10000 }, async () => {
  const main = new AdapterResourceObserver(), { worker, participant, exited } = launchObservedWorker(main);
  try { await once(worker, 'message'); }
  finally { await worker.terminate(); await exited.catch(() => {}); main.retireAggregateParticipant(participant, true); }
  assert.equal(aggregate(main).currentCpuBytes, 0);
  assert.equal(aggregate(main).peakCpuBytes, 10240);
  assert.equal(aggregate(main).integrityComplete, false);
  main.resetPeaks(); assert.equal(aggregate(main).integrityComplete, false);
});

test('concurrent snapshots never invert current, window peak and lifetime peak', { timeout:10000 }, async()=>{
  const main=new AdapterResourceObserver(),participant=main.reserveAggregateParticipant();assert.notEqual(participant,null);
  const source=`
    import {parentPort,workerData} from 'node:worker_threads';
    import {AdapterResourceObserver} from ${JSON.stringify(moduleURL.href)};
    const observer=new AdapterResourceObserver();observer.bindAggregate(workerData.aggregate,workerData.participant);
    parentPort.postMessage('ready');parentPort.once('message',async()=>{
      for(let n=0;n<1000;n++){const release=observer.buffer('writer','churn',new Uint8Array(4096+(n%8)*1024));await new Promise(resolve=>setImmediate(resolve));release();}
      parentPort.postMessage('done');parentPort.close();
    });`;
  const worker=new Worker(new URL('data:text/javascript,'+encodeURIComponent(source)),{workerData:{aggregate:main.aggregateBuffer(),participant}}),exited=once(worker,'exit');
  let done=false,retired=false;
  try{await once(worker,'message');worker.on('message',message=>{if(message==='done')done=true;});main.beginLifecycleWindow();worker.postMessage('go');
    while(!done){const snapshot=aggregate(main);assert.ok(snapshot.currentCpuBytes<=snapshot.peakCpuBytes);const window=snapshot.lifecycleWindow;
      if(window?.integrityComplete){assert.ok(window.currentCpuBytes<=window.peakCpuBytes);assert.ok(window.peakCpuBytes<=snapshot.peakCpuBytes);}
      await new Promise(resolve=>setImmediate(resolve));
    }
    await exited;main.retireAggregateParticipant(participant);retired=true;main.endLifecycleWindow();const snapshot=aggregate(main);
    assert.equal(snapshot.lifecycleWindow.sealed,true);assert.equal(snapshot.lifecycleWindow.integrityComplete,true);assert.ok(snapshot.lifecycleWindow.peakCpuBytes<=snapshot.peakCpuBytes);
  }finally{if(!retired){await worker.terminate();await exited.catch(()=>{});main.retireAggregateParticipant(participant,true);}}
});
