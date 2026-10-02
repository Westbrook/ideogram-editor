import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {allocationLedger,ALLOCATION_LIMITS} from '../../dist/local/src/observability/allocations.js';
import {CompositionReads,sendCompositionJSON} from '../../dist/local/server/composition-memory.js';
import {CompositionMemory} from '../../dist/local/server/storage/composition-memory.js';
import {StorageReads} from '../../dist/local/server/storage-reads.js';
import {StorageLibraryMemory,STORAGE_OPERATION_BYTES,STORAGE_REGISTRY_BYTES} from '../../dist/local/server/storage/library-memory.js';

const MiB=1024**2,capacity=ALLOCATION_LIMITS.cpuBytes-ALLOCATION_LIMITS.textPartitionBytes;
const bytes=()=>allocationLedger.snapshot().cpuBytes;
function harness(){
  const baseline=bytes(),ids=new Set(),reads=new Set();let mirror,releaseFails=false,exited=false;
  mirror=new CompositionMemory(()=>mirror.bytes,()=>0);
  // Only the transport/ack seam is controlled: both accounting owners and
  // every mirror admission/release are the production implementations.
  const rpc=async(method,args)=>{
    if(exited)throw Error('worker exited');
    if(method==='compositionResize'){mirror.resize(args.id,args.bytes,args.family);ids.add(args.id);return;}
    if(method==='compositionRelease'){if(releaseFails)throw Error('release acknowledgement lost');mirror.drop(args.id,()=>{});ids.delete(args.id);return;}
    throw Error('unexpected RPC '+method);
  };
  const owner=new StorageReads(rpc),memory=new StorageLibraryMemory(mirror);
  const acquire=async(kind,produce=()=>({ok:true}))=>{
    const read=await owner.read(kind,async scope=>{const loan=memory.enter(scope,kind);try{loan.check();return await produce(scope,loan);}finally{loan.release();}});reads.add(read);return read;
  };
  const exit=async()=>{exited=true;for(const id of ids)mirror.drop(id,()=>{});ids.clear();await owner.nativeExited();};
  const close=async()=>{releaseFails=false;for(const read of reads)await read.release();memory.close();await exit();assert.equal(bytes(),baseline);assert.equal(mirror.bytes,0);};
  return {baseline,mirror,memory,rpc,owner,acquire,exit,close,setReleaseFailure:value=>{releaseFails=value;}};
}

test('storage exhausts actual central capacity before dispatch or metadata production',async()=>{
  const h=harness();let fill,calls=0;
  try{
    const warm=await h.acquire('summary');await warm.release();assert.equal(bytes(),h.baseline+STORAGE_REGISTRY_BYTES);
    fill=allocationLedger.reserve({owner:'storage-exact-capacity-test',kind:'control',cpuBytes:capacity-bytes()-MiB});
    const filled=bytes();assert.equal(capacity-filled,MiB,'exact real headroom permits only the initial request loan');
    await assert.rejects(h.acquire('dependencies',()=>{calls++;throw Error('metadata must not be read');}),/ALLOCATION_BUDGET/);
    assert.equal(calls,0);assert.equal(bytes(),filled);assert.equal(h.mirror.bytes,STORAGE_REGISTRY_BYTES);
  }finally{fill?.release();await h.close();}
});

class HeldResponse extends EventEmitter {
  destroyed=false;callback;body;headers;started;
  constructor(){super();this.started=new Promise(resolve=>{this.startedResolve=resolve;});}
  writeHead(status,headers){this.status=status;this.headers=headers;}
  end(body,callback){this.body=body;this.callback=callback;this.startedResolve();}
  finish(){this.callback?.();}
  close(){this.destroyed=true;this.emit('close');}
}

test('actual JSON serializer retains the reply loan until end, close, or error completion',async()=>{
  for(const terminal of ['end','close','error']){
    const h=harness(),response=new HeldResponse();let read,pending;
    try{
      read=await h.acquire('assets',()=>({items:[{id:'owned'}]}));
      pending=(async()=>{try{await sendCompositionJSON(response,read.value,60*1024,read,async()=>{});}finally{await read.release();}})();
      const observed=pending.then(()=>null,error=>error);await Promise.race([response.started,pending]);
      assert.equal(response.status,200);assert.equal(response.headers['Content-Length'],response.body.byteLength);
      assert.equal(bytes(),h.baseline+STORAGE_REGISTRY_BYTES+STORAGE_OPERATION_BYTES.assets+response.body.byteLength*3);
      assert.equal(read.value.items[0].id,'owned','unfinished native response still owns its reply');
      if(terminal==='end')response.finish();else if(terminal==='close')response.close();else response.emit('error',Error('response failure'));
      const error=await observed;if(terminal==='end')assert.equal(error,null);else assert(error instanceof Error);
      assert.throws(()=>read.value,{code:'CLOSED'});assert.equal(bytes(),h.baseline+STORAGE_REGISTRY_BYTES);
    }finally{response.close();await pending?.catch(()=>{});await read?.release();await h.close();}
  }
});

test('native-exit notification refunds registry but retains a completed consumer graph until release',async()=>{
  const h=harness();try{
    const read=await h.acquire('summary');assert.equal(bytes(),h.baseline+STORAGE_REGISTRY_BYTES+STORAGE_OPERATION_BYTES.summary);
    await h.exit();assert.equal(bytes(),h.baseline+STORAGE_OPERATION_BYTES.summary);assert.deepEqual(read.value,{ok:true});
    await assert.rejects(h.acquire('summary'),{code:'CLOSED'});await read.release();assert.equal(bytes(),h.baseline);
  }finally{await h.close();}
});

test('uncertain release stays booked until native-exit notification resolves lost ownership',async()=>{
  const h=harness();try{
    const read=await h.acquire('review');h.setReleaseFailure(true);
    await assert.rejects(read.release(),/release acknowledgement lost/);assert.throws(()=>read.value,{code:'CLOSED'});
    assert.equal(bytes(),h.baseline+STORAGE_REGISTRY_BYTES+STORAGE_OPERATION_BYTES.review);
    await h.exit();assert.equal(bytes(),h.baseline);
  }finally{await h.close();}
});

test('pending dispatch failure after native-exit notification releases the request and persistent registry',async()=>{
  const h=harness();let entered,fail;const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise((_,reject)=>{fail=reject;});
  const pending=h.acquire('repair',async()=>{entered();await gate;});const observed=pending.catch(error=>error);
  try{await Promise.race([started,pending]);assert.equal(bytes(),h.baseline+STORAGE_REGISTRY_BYTES+STORAGE_OPERATION_BYTES.repair);await h.exit();fail(Error('worker exited during materialization'));assert.match((await observed).message,/worker exited/);assert.equal(bytes(),h.baseline);}
  finally{fail(Error('test cleanup'));await observed;await h.close();}
});

test('storage scopes exclude only their own grants and preserve all four Composition slots',async()=>{
  const h=harness(),composition=new CompositionReads(h.rpc),other=[];let first,second;
  try{
    for(let i=0;i<4;i++)other.push(await composition.open());
    first=await h.acquire('summary',(scope)=>{
      assert.equal(h.memory.otherBytes(scope),4*MiB);
      assert.throws(()=>h.memory.otherBytes({...scope,kind:'repair'}),{code:'CLOSED'});
      let opens=0;for(const id of [scope.loanId,scope.registryId])assert.throws(()=>h.mirror.openContent(id,()=>{opens++;return 'forbidden';}),{code:'MALFORMED_REQUEST'});
      assert.equal(opens,0);return {ok:true};
    });
    second=await h.acquire('summary');let dispatches=0;
    await assert.rejects(h.acquire('summary',()=>{dispatches++;}),{code:'CAPACITY'});assert.equal(dispatches,0);
    await assert.rejects(composition.open(),{code:'CAPACITY'});
    await first.release();await second.release();for(const read of other)await read.release();
    const exact=await h.acquire('summary',scope=>{assert.equal(h.memory.otherBytes(scope),0);return {ok:true};});await exact.release();
  }finally{await first?.release();await second?.release();for(const read of other)await read.release();await h.close();}
});
