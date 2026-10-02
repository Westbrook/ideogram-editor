import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {Rasters} from '../../dist/local/server/storage/raster.js';
import {CompositionMemory} from '../../dist/local/server/storage/composition-memory.js';
import {CompositionReads,compositionJSONBytes,sendCompositionJSON} from '../../dist/local/server/composition-memory.js';
import {allocationLedger} from '../../dist/local/src/observability/allocations.js';
import {emptyComposition} from '../../dist/local/src/composition/core.js';
import {DRAFT_GRAPH_BYTES,COMPOSITION_DRAFT_VIEW_BYTES} from '../../dist/local/src/composition/view.js';
const ref=bytes=>({hash:'sha256:'+createHash('sha256').update(bytes).digest('hex'),byteLength:String(bytes.byteLength),mediaType:'application/json'});
const gates=new Set(),responses=new Set(),owners=new Set(),actions=new Set();
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;}),gate={promise,resolve,reject};gates.add(gate);promise.then(()=>gates.delete(gate),()=>gates.delete(gate));return gate;};
const track=p=>{actions.add(p);p.then(()=>actions.delete(p),()=>actions.delete(p));return p;};
const own=async(registry,current)=>{const read=await registry.open(current);owners.add(read);return read;};
test.afterEach(async()=>{for(const response of responses)if(response.callback&&!response.destroyed)response.finish();for(const gate of gates)gate.resolve();await Promise.allSettled([...actions]);const results=await Promise.allSettled([...owners].map(read=>read.release()));const errors=results.filter(x=>x.status==='rejected').map(x=>x.reason);if(errors.length)await Promise.allSettled([...owners].map(read=>read.release()));responses.clear();owners.clear();actions.clear();if(errors.length)throw new AggregateError(errors,'fixture cleanup failed');});
function graphAt(n){const graph={composition:emptyComposition(1,1,'composition'),bindings:{},rawText:''};const overhead=Buffer.byteLength(JSON.stringify(graph));graph.rawText='x'.repeat(n-overhead);const bytes=Buffer.from(JSON.stringify(graph));assert.equal(bytes.length,n);return {graph,bytes,envelope:{schemaVersion:1,kind:'composition-draft-1',graph:ref(bytes),raw:[],bindings:{}}};}
function objectReader(bytes,override={}){const reads=[];return {reads,verify(){},readRange(_ref,offset,length){assert.equal(typeof offset,'string');assert(length<=65536);reads.push({offset,length});return bytes.subarray(Number(offset),Number(offset)+length);},...override};}
const amounts=()=>{const s=allocationLedger.snapshot();return {cpu:s.cpuBytes,handles:s.handles,records:s.activeRecords};};
function peer(bytes=Buffer.from('{}'),behavior={}){
 const handles=new Map(),calls=[];let count=0,memory;memory=new CompositionMemory(()=>memory.bytes,()=>0);
 const rpc=async(method,args)=>{calls.push({method,...args});if(behavior.before)await behavior.before(method,args);
  if(method==='compositionResize'){memory.resize(args.id,args.bytes);if(behavior.afterResize)await behavior.afterResize(args);return null;}
  if(method==='compositionRelease'){memory.drop(args.id,h=>handles.delete(h));return null;}
  if(method==='compositionContentOpen')return memory.openContent(args.id,()=>{const h='content-'+ ++count;handles.set(h,args.ref);return h;});
  if(method==='compositionContentDrop'){memory.dropContent(args.id,args.handle,h=>handles.delete(h));return null;}
  if(method==='content'){assert(handles.has(args.handle));return bytes.subarray(Number(args.offset),Number(args.offset)+args.length);}
  throw Error('Unexpected RPC '+method);
 };return {rpc,handles,calls,memory};
}
class Response extends EventEmitter {constructor(){super();responses.add(this);}destroyed=false;headers=null;body=null;entered=defer();writeHead(status,headers){this.status=status;this.headers=headers;}end(body,callback){this.body=body;this.callback=callback;this.entered.resolve();}finish(){this.callback();}disconnect(){this.destroyed=true;this.emit('close');}}

test('typed draft reader accepts exact8MiB, uses bounded exact bytes, and releases on callback failure',()=>{
 const v=graphAt(DRAFT_GRAPH_BYTES),objects=objectReader(v.bytes);let memory;memory=new CompositionMemory(()=>memory.bytes,()=>0);let visited=false;
 memory.draft(objects,v.envelope,graph=>{visited=true;assert.deepEqual(graph,v.graph);assert.equal(memory.bytes,DRAFT_GRAPH_BYTES*12+1024**2);});assert(visited);assert.equal(objects.reads.length,128);assert.equal(memory.bytes,0);
 assert.throws(()=>memory.draft(objects,v.envelope,()=>{throw Error('borrower failed');}),/borrower failed/);assert.equal(memory.bytes,0);
});
test('typed draft limit, MIME, hash, truncation and malformed graph fail without escaping the loan',()=>{
 const v=graphAt(70000);let memory;memory=new CompositionMemory(()=>memory.bytes,()=>0);let reads=0;const objects=objectReader(v.bytes,{verify(){reads++;}});
 for(const graph of [{...v.envelope.graph,byteLength:String(DRAFT_GRAPH_BYTES+1)},{...v.envelope.graph,mediaType:'text/plain'}]){assert.throws(()=>memory.draft(objects,{...v.envelope,graph},()=>assert.fail('invalid descriptor published')));assert.equal(reads,0);assert.equal(memory.bytes,0);}
 assert.throws(()=>memory.draft(objects,{...v.envelope,graph:{...v.envelope.graph,hash:'sha256:'+'0'.repeat(64)}},()=>assert.fail()),/CORRUPT_OBJECT/);assert.equal(memory.bytes,0);
 assert.throws(()=>memory.draft(objectReader(v.bytes.subarray(0,30)),v.envelope,()=>assert.fail()),/CORRUPT_OBJECT/);assert.equal(memory.bytes,0);
 const invalid=Buffer.from('{"composition":null,"bindings":{}}');let published=false;assert.throws(()=>memory.draft(objectReader(invalid),{...v.envelope,graph:ref(invalid)},()=>{published=true;}));assert.equal(published,false);assert.equal(memory.bytes,0);
});
test('writer shared reservation refuses before object IO and includes main mirrors during synchronous reads',()=>{
 const v=graphAt(70000);let memory;memory=new CompositionMemory(()=>memory.bytes,()=>501*1024**2);const id=randomUUID();memory.resize(id,10*1024**2);let touched=false;
 assert.throws(()=>memory.draft(objectReader(v.bytes,{verify(){touched=true;}}),v.envelope,()=>assert.fail()),/CAPACITY/);assert.equal(touched,false);assert.equal(memory.bytes,10*1024**2);memory.drop(id,()=>{});assert.equal(memory.bytes,0);
});
test('JSON response byte preflight exactly preserves escapes, astral/lone surrogates and numeric values',()=>{
 const value={text:'\0\b\t\n\f\r"\\東京😀\ud800',values:[-0,1e-20,1e30,Number.MAX_SAFE_INTEGER,true,false,null],nested:{'control\nkey':'value'}};
 const expected=Buffer.byteLength(JSON.stringify(value));assert.equal(compositionJSONBytes(value,expected),expected);assert.throws(()=>compositionJSONBytes(value,expected-1),/PAYLOAD_TOO_LARGE/);
 assert.throws(()=>compositionJSONBytes({x:undefined},100));let getterCalled=false;assert.throws(()=>compositionJSONBytes({get x(){getterCalled=true;return 1;}},100),/MALFORMED_REQUEST/);assert.equal(getterCalled,false);const cycle={};cycle.self=cycle;assert.throws(()=>compositionJSONBytes(cycle,10000),/MALFORMED_REQUEST/);
});
test('main response retains mirror and central control through actual end callback',async()=>{
 const base=amounts(),p=peer(),registry=new CompositionReads(p.rpc),read=await own(registry),response=new Response();let sent=false;
 const sending=track(sendCompositionJSON(response,{graph:'x'.repeat(70000)},COMPOSITION_DRAFT_VIEW_BYTES,read,async()=>{}).then(()=>{sent=true;}));await response.entered.promise;
 assert.equal(sent,false);assert(p.memory.bytes>1024**2);assert(amounts().cpu>base.cpu);assert.equal(response.headers['Content-Length'],response.body.byteLength);response.finish();await sending;assert(p.memory.bytes>0);await read.release();assert.equal(p.memory.bytes,0);assert.deepEqual(amounts(),base);
});
for(const stop of ['context','disconnect'])test('main response releases after '+stop+' refusal without premature refund',async()=>{
 const base=amounts(),p=peer(),registry=new CompositionReads(p.rpc),read=await own(registry),response=new Response();
 const pending=track(sendCompositionJSON(response,{x:1},100,read,async()=>{if(stop==='context')throw Error('READ_CONTEXT_EXPIRED');}));
 if(stop==='disconnect'){await response.entered.promise;response.disconnect();}
 await assert.rejects(pending,stop==='context'?/READ_CONTEXT_EXPIRED/:/CLOSED/);assert(p.memory.bytes>0);await read.release();assert.deepEqual(amounts(),base);assert.equal(p.memory.bytes,0);
});
test('interrupted pending content chunk settles then drops exact handle and loan',async()=>{
 const base=amounts(),bytes=Buffer.alloc(70000,65),entered=defer(),resume=defer();let current=true;
 const p=peer(bytes,{async before(method){if(method==='content'){entered.resolve();await resume.promise;}}}),registry=new CompositionReads(p.rpc),read=await own(registry,()=>{if(!current)throw Error('READ_CONTEXT_EXPIRED');});
 const reading=track(read.read(ref(bytes),8388608));await entered.promise;current=false;resume.resolve();await assert.rejects(reading,/READ_CONTEXT_EXPIRED/);assert.equal(p.handles.size,0);assert.equal(p.calls.filter(x=>x.method==='content').length,1);await read.release();assert.deepEqual(amounts(),base);
});
test('content cleanup failure stays owned and scope release retries actual handle before refund',async()=>{
 const base=amounts(),bytes=Buffer.from('{"x":1}');let failDrop=true;
 const p=peer(bytes,{before(method){if(method==='compositionContentDrop'&&failDrop){failDrop=false;throw Error('drop refused');}}}),registry=new CompositionReads(p.rpc),read=await own(registry);
 await assert.rejects(read.read(ref(bytes),100),/drop refused/);assert.equal(p.handles.size,1);assert(p.memory.bytes>0);assert(amounts().cpu>base.cpu);await read.release();assert.equal(p.handles.size,0);assert.equal(p.memory.bytes,0);assert.deepEqual(amounts(),base);
});
test('lost acquisition acknowledgement drops caller-known mirror before refund',async()=>{
 const base=amounts();let fail=true;const p=peer(Buffer.from('{}'),{afterResize(){if(fail){fail=false;throw Error('lost acknowledgement');}}}),registry=new CompositionReads(p.rpc);
 await assert.rejects(registry.open(),/lost acknowledgement/);assert.equal(p.memory.bytes,0);assert(p.calls.some(x=>x.method==='compositionRelease'));assert.deepEqual(amounts(),base);
});
test('failed scope cleanup remains charged and next open drains original scope first',async()=>{
 const base=amounts();let fail=true;const p=peer(Buffer.from('{}'),{before(method){if(method==='compositionRelease'&&fail){fail=false;throw Error('release refused');}}}),registry=new CompositionReads(p.rpc),read=await own(registry);
 await assert.rejects(read.release(),/release refused/);assert(p.memory.bytes>0);assert(amounts().cpu>base.cpu);const next=await own(registry);assert.equal(p.memory.bytes,1024**2);await next.release();assert.deepEqual(amounts(),base);
});
test('mirror growth refusal precedes content allocation and restores prior charge',async()=>{
 const base=amounts(),bytes=Buffer.alloc(70000);const p=peer(bytes,{before(method,args){if(method==='compositionResize'&&args.bytes>1024**2)throw Error('CAPACITY');}}),registry=new CompositionReads(p.rpc),read=await own(registry);
 await assert.rejects(read.read(ref(bytes),8388608),/CAPACITY/);assert.equal(p.calls.filter(x=>x.method==='compositionContentOpen').length,0);assert.equal(p.memory.bytes,1024**2);assert.equal(amounts().cpu-base.cpu,1024**2);await read.release();assert.deepEqual(amounts(),base);
});
test('final read hashes actual assembled bytes and drains corruption before release',async()=>{
 const base=amounts(),bytes=Buffer.from('{"x":1}'),p=peer(bytes),registry=new CompositionReads(p.rpc),read=await own(registry);await assert.rejects(read.read({...ref(bytes),hash:'sha256:'+'0'.repeat(64)},100),/CORRUPT_OBJECT/);assert.equal(p.handles.size,0);await read.release();assert.deepEqual(amounts(),base);
});
test('worker exit does not refund an active main consumer until release',async()=>{
 const base=amounts(),p=peer(),registry=new CompositionReads(p.rpc),read=await own(registry);registry.nativeExited();assert(amounts().cpu>base.cpu);await read.release();assert.deepEqual(amounts(),base);
});

test('worker exit discharges a failed scope release only after native handles are gone',async()=>{
 const base=amounts(),p=peer(Buffer.from('{}'),{before(method){if(method==='compositionRelease')throw Error('worker unavailable');}}),registry=new CompositionReads(p.rpc),read=await own(registry);
 await assert.rejects(read.release(),/worker unavailable/);assert(amounts().cpu>base.cpu);registry.nativeExited();assert.deepEqual(amounts(),base);await read.release();assert.deepEqual(amounts(),base);
});
for(const outcome of ['resolve','reject'])test('accepted graph borrower stays reserved through final async walk '+outcome,async()=>{
 const gate=defer(),entered=defer();let memory;memory=new CompositionMemory(()=>memory.bytes,()=>0);const composition={id:'composition',value:{hash:'sha256:'+'1'.repeat(64),byteLength:'1048576',mediaType:'application/json'},bindings:{}};
 const action=track(memory.compositionsAsync([composition],async()=>{entered.resolve();await gate.promise;}));await entered.promise;assert.equal(memory.bytes,13*1024**2);const id=randomUUID();assert.throws(()=>memory.resize(id,500*1024**2),/CAPACITY/);assert.equal(memory.bytes,13*1024**2);
 if(outcome==='reject'){gate.reject(Error('proof refused'));await assert.rejects(action,/proof refused/);}else{gate.resolve();await action;}assert.equal(memory.bytes,0);
});
test('accepted synchronous pair is admitted before parse and releases validation failure',()=>{
 let memory;memory=new CompositionMemory(()=>memory.bytes,()=>0);const composition={id:'composition',value:{hash:'sha256:'+'1'.repeat(64),byteLength:'1048576',mediaType:'application/json'},bindings:{}};
 assert.throws(()=>memory.compositions([composition,composition],()=>{assert.equal(memory.bytes,25*1024**2);throw Error('validation refused');}),/validation refused/);assert.equal(memory.bytes,0);
 let touched=false;assert.throws(()=>memory.compositions([{...composition,value:{...composition.value,byteLength:'1048577'}}],()=>{touched=true;}));assert.equal(touched,false);assert.equal(memory.bytes,0);
});

function descriptorGraph(extra=false){
 const assets=new Map(),ids=[];let serial=1;
 const next=()=>({hash:'sha256:'+String(serial++).padStart(64,'0'),byteLength:'1',mediaType:'application/octet-stream'});
 for(let i=0;i<512;i++){const id='asset_'+i;ids.push(id);assets.set(id,{availability:'available',blob:next(),dependencies:Array.from({length:3+(extra&&i===0?1:0)},next)});}
 return {ids,context:{check(){},assets:{asset:id=>assets.get(id)}}};
}
test('actual V45 accumulator transfers exactly2048 ordered descriptors under one bounded owner',()=>{
 let memory;memory=new CompositionMemory(()=>memory.bytes,()=>0);const {ids,context}=descriptorGraph();
 const owned=memory.referenceCollection(()=>Rasters.prototype.v45InputGraph.call(context,ids));assert.equal(memory.bytes,8*1024**2);assert.equal(owned.value.length,2048);assert.deepEqual(owned.value.map(ref=>ref.hash),Array.from({length:2048},(_,i)=>'sha256:'+String(i+1).padStart(64,'0')));
 owned.release();assert.equal(memory.bytes,0);assert.throws(()=>owned.value,/CLOSED/);owned.release();assert.equal(memory.bytes,0);
});
test('descriptor capacity refuses before build and actual2049th identity releases its owner',()=>{
 const full=new CompositionMemory(()=>510*1024**2,()=>0);let built=false;assert.throws(()=>full.referenceCollection(()=>{built=true;return [];}),/CAPACITY/);assert.equal(built,false);assert.equal(full.bytes,0);
 let memory;memory=new CompositionMemory(()=>memory.bytes,()=>0);const {ids,context}=descriptorGraph(true);assert.throws(()=>memory.referenceCollection(()=>Rasters.prototype.v45InputGraph.call(context,ids)),/CAPACITY/);assert.equal(memory.bytes,0);
});
test('descriptor owner remains live through proof-transfer wait and releases failed transfer',async()=>{
 let memory;memory=new CompositionMemory(()=>memory.bytes,()=>0);const {ids,context}=descriptorGraph(),gate=defer(),entered=defer();
 const action=track((async()=>{const owned=memory.referenceCollection(()=>Rasters.prototype.v45InputGraph.call(context,ids));try{for(const ref of owned.value){assert(ref.hash);entered.resolve();await gate.promise;}}finally{owned.release();}})());
 await entered.promise;assert.equal(memory.bytes,8*1024**2);gate.reject(Error('proof refused'));await assert.rejects(action,/proof refused/);assert.equal(memory.bytes,0);
});

for(const [label,invalid,code] of [
 ['MIME', {mediaType:'application/'+ 'x'.repeat(117)},'MALFORMED_REQUEST'],
 ['decimal length', {byteLength:'1'.repeat(21)},'CAPACITY'],
])test('actual V45 accumulator refuses oversized '+label+' before retaining a descriptor',()=>{
 let memory;memory=new CompositionMemory(()=>memory.bytes,()=>0);const {ids,context}=descriptorGraph();
 Object.assign(context.assets.asset(ids[0]).blob,invalid);let published=false;
 assert.throws(()=>{const owned=memory.referenceCollection(()=>Rasters.prototype.v45InputGraph.call(context,ids));published=true;owned.release();},error=>error.code===code);
 assert.equal(published,false);assert.equal(memory.bytes,0);
});
