// Authored source-only; execute only after coordinated promotion.
import {viewModelDependencies} from '../view-model-module.mjs';
import {draftStateDependencies} from '../draft-state-module.mjs';
import {allocationsURL as allocations} from '../owned-preview-module.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';
const root=process.env.COMMAND_JOURNAL_ROOT??'.';
const data=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
async function moduleURL(path,imports={}){let source=(await transformWithOxc(await readFile(path,'utf8'),path)).code;for(const [name,url]of Object.entries(imports))source=source.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));return data(source);}
const control=await moduleURL(root+'/src/state/control-memory.ts',{'../observability/allocations.js':allocations});
const idb=await moduleURL(root+'/src/state/idb-ownership.ts',{'../observability/allocations.js':allocations});
const journalURL=await moduleURL(root+'/src/state/browser-journal.ts',{'../observability/allocations.js':allocations,'./control-memory.js':control,'./idb-ownership.js':idb});
const {allocationLedger,ALLOCATION_LIMITS}=await import(allocations),{measureControl,reserveCommandWire,journalRecordBytes,JOURNAL_RECORD_BYTES}=await import(control),{BrowserJournal,journalReadCoverage}=await import(journalURL);
const state=()=>allocationLedger.snapshot();
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const flush=async()=>{for(let n=0;n<8;n++)await Promise.resolve();};

test('control size matches native UTF-8 JSON for scalar, escaped and multibyte input',()=>{
 for(const value of [{name:'a\nb\t\u0000"\\漢😀',unset:undefined},{v:[0,-0,1e-7,true,false,null,'é']},{}])assert.equal(measureControl(value).encodedBytes,new TextEncoder().encode(JSON.stringify(value)).byteLength);
 const before=state(),body={name:'original'},owned=reserveCommandWire(body);body.name='changed';assert.equal(owned.request.name,'original');assert.equal(owned.wire,'{"name":"original"}');assert(state().cpuBytes>before.cpuBytes);owned.release();owned.release();assert.equal(state().cpuBytes,before.cpuBytes);
});
test('large control and accessors refuse without invoking user serialization hooks',()=>{
 let called=0;assert.throws(()=>reserveCommandWire({type:'SaveCheckpoint',name:'a'.repeat(65536)}),/Shorten the checkpoint name/);
 assert.throws(()=>reserveCommandWire({get name(){called++;return 'x';}}),/unsupported control data/);
 const hook=Object.defineProperty({},'toJSON',{value(){called++;return 'x';}});assert.throws(()=>reserveCommandWire(hook),/unsupported control data/);assert.equal(called,0);
 const omitted={["k".repeat(JOURNAL_RECORD_BYTES/2+1)]:undefined};assert.throws(()=>journalRecordBytes(omitted),/Shorten the checkpoint name/);const extra=[];extra.payload='x'.repeat(JOURNAL_RECORD_BYTES);assert.throws(()=>journalRecordBytes(extra),/unsupported control data/);
});
test('command workspace refuses before constructing its wire when central capacity is exhausted',()=>{
 const before=state(),blocker=allocationLedger.reserve({owner:'command-test-blocker',kind:'control',cpuBytes:ALLOCATION_LIMITS.cpuBytes-ALLOCATION_LIMITS.textPartitionBytes-before.cpuBytes});
 try{assert.throws(()=>reserveCommandWire({name:'small'}),/ALLOCATION_BUDGET/);assert.equal(state().activeRecords,before.activeRecords+1);}finally{blocker.release();}
});

function events(value){const listeners=new Map();return Object.assign(value,{addEventListener(name,fn){const set=listeners.get(name)??new Set();set.add(fn);listeners.set(name,set);},removeEventListener(name,fn){listeners.get(name)?.delete(fn);},emit(name){for(const fn of [...listeners.get(name)??[]])fn({type:name});value['on'+name]?.();}});}
const keyRange=(lower,upper,lowerOpen=false,upperOpen=false)=>({lower,upper,lowerOpen,upperOpen});
const ownedState=()=>{const {cpuBytes,handles,activeRecords}=state();return {cpuBytes,handles,activeRecords};};
async function database(t,rows=[],options={}){
 let transactions=0,putCalls=0,aborts=0,last,cursorReads=0,continues=0,lastRange,lastDirection;
 const records=rows.map((value,index)=>({key:options.keys?.[index]??'command:'+String(index).padStart(4,'0'),value}));
 const db=events({transaction(){
  transactions++;let stopped=false;const request={result:undefined};
  const complete=()=>{if(!stopped&&options.autoComplete!==false)queueMicrotask(()=>tx.emit('complete'));};
  const tx=events({error:null,abort(){aborts++;stopped=true;queueMicrotask(()=>tx.emit('abort'));},objectStore(){return {
   put(){putCalls++;return request;},
   get(){queueMicrotask(()=>{request.result=rows[0];request.onsuccess?.();complete();});return request;},
   openCursor(range,direction='next'){
    lastRange=range;lastDirection=direction;
    const selected=records.filter(({key})=>(range.lowerOpen?key>range.lower:key>=range.lower)&&(range.upperOpen?key<range.upper:key<=range.upper)).sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
    if(direction==='prev')selected.reverse();let at=0;
    const next=()=>queueMicrotask(()=>{if(stopped)return;let continued=false;const record=selected[at++];if(record)cursorReads++;
     request.result=record?{key:record.key,value:record.value,continue(){continues++;continued=true;next();}}:null;
     request.onsuccess?.();if(!continued)complete();
    });next();return request;
   }
  };}});last=tx;return tx;
 },close(){}});
 const previous=globalThis.indexedDB;globalThis.indexedDB={open(){const request={result:db};queueMicrotask(()=>request.onsuccess());return request;}};
 let journal;try{journal=await BrowserJournal.open('unit');}finally{globalThis.indexedDB=previous;}t.after(()=>journal.close());
 return {journal,get transactions(){return transactions;},get putCalls(){return putCalls;},get aborts(){return aborts;},get tx(){return last;},get cursorReads(){return cursorReads;},get continues(){return continues;},get range(){return lastRange;},get direction(){return lastDirection;}};
}
test('journal writes validate before native clone and keep admission until abort settlement',async t=>{
 const f=await database(t),before=state();await assert.rejects(f.journal.put('command:x',{name:'a'.repeat(JOURNAL_RECORD_BYTES)}),/Shorten the checkpoint name/);assert.equal(f.transactions,0);
 const work=f.journal.put('command:x',{name:'short'}).then(()=>({ok:true}),error=>({error}));assert.equal(f.putCalls,1);const held=state().cpuBytes;assert(held>before.cpuBytes);
 f.tx.error=Error('idb error');f.tx.emit('error');await flush();assert.equal(state().cpuBytes,held);f.tx.emit('abort');assert.equal((await work).error.message,'idb error');assert.equal(state().cpuBytes,before.cpuBytes);
});
test('legacy oversized cursor value is rejected before visit with explicit native uncertainty',async t=>{
 const previousRange=globalThis.IDBKeyRange;globalThis.IDBKeyRange={bound:keyRange};
 const oversized={name:'x'.repeat(JOURNAL_RECORD_BYTES)},rows=[oversized,{name:'later'}],f=await database(t,rows),before=state(),coverage=journalReadCoverage();let visited=0;
 try{const pending=f.journal.scan('command:',()=>visited++);assert.equal(journalReadCoverage().activeUnverifiedReads,coverage.activeUnverifiedReads+1);assert.equal(journalReadCoverage().nativeCloneBytesKnown,false);await assert.rejects(pending,/remains in IndexedDB/);assert.equal(visited,0);assert.equal(f.aborts,1);assert.equal(rows[0],oversized);assert.equal(rows.length,2);assert.equal(journalReadCoverage().rejectedRecords,coverage.rejectedRecords+1);assert.equal(journalReadCoverage().activeUnverifiedReads,coverage.activeUnverifiedReads);assert.equal(state().cpuBytes,before.cpuBytes);}finally{globalThis.IDBKeyRange=previousRange;}
});
test('legacy get rejects oversized records and falsey visitor errors are preserved through abort',async t=>{
 const before=state(),f=await database(t,[{name:'x'.repeat(JOURNAL_RECORD_BYTES)}]);await assert.rejects(f.journal.get('command:x'),/remains in IndexedDB/);assert.equal(state().cpuBytes,before.cpuBytes);
 const previousRange=globalThis.IDBKeyRange;globalThis.IDBKeyRange={bound:keyRange};
 try{const one=await database(t,[{name:'ok'}]),result=await one.journal.scan('command:',()=>{throw undefined;}).then(()=>({ok:true}),error=>({error}));assert.deepEqual(result,{error:undefined});assert.equal(state().cpuBytes,before.cpuBytes);}finally{globalThis.IDBKeyRange=previousRange;}
});


test('journal keyset scan excludes its cursor and stops before an unvisited oversized record',async t=>{
 const previousRange=globalThis.IDBKeyRange;globalThis.IDBKeyRange={bound:keyRange};
 const oversized={name:'x'.repeat(JOURNAL_RECORD_BYTES)},rows=[{name:'outside before'},{name:'one'},{name:'two'},{name:'three'},oversized,{name:'outside after'}];
 const f=await database(t,rows,{keys:['before:x','command:0001','command:0002','command:0003','command:0004','ui-request:x']}),before=ownedState(),coverage=journalReadCoverage(),visited=[];
 try{
  await f.journal.scan('command:',(value,key)=>{visited.push([key,value.name]);return visited.length<2;},{after:'command:0001'});
  assert.deepEqual(f.range,keyRange('command:0001','command:\uffff',true,false));assert.equal(f.direction,'next');
  assert.deepEqual(visited,[['command:0002','two'],['command:0003','three']]);assert.equal(f.cursorReads,2);assert.equal(f.continues,1);assert.equal(f.aborts,0);
  assert.equal(rows[4],oversized);assert.equal(journalReadCoverage().rejectedRecords,coverage.rejectedRecords);assert.equal(journalReadCoverage().activeUnverifiedReads,coverage.activeUnverifiedReads);assert.deepEqual(ownedState(),before);
 }finally{globalThis.IDBKeyRange=previousRange;}
});
test('journal reverse keyset scan excludes its cursor and visits matching keys in descending order',async t=>{
 const previousRange=globalThis.IDBKeyRange;globalThis.IDBKeyRange={bound:keyRange};
 const f=await database(t,[{name:'one'},{name:'two'},{name:'three'},{name:'four'},{name:'other'}],{keys:['command:0001','command:0002','command:0003','command:0004','ui-request:x']}),before=ownedState(),visited=[];
 try{
  await f.journal.scan('command:',(value,key)=>{visited.push([key,value.name]);return visited.length<2;},{after:'command:0004',direction:'prev'});
  assert.deepEqual(f.range,keyRange('command:','command:0004',false,true));assert.equal(f.direction,'prev');
  assert.deepEqual(visited,[['command:0003','three'],['command:0002','two']]);assert.equal(f.cursorReads,2);assert.equal(f.continues,1);assert.deepEqual(ownedState(),before);
 }finally{globalThis.IDBKeyRange=previousRange;}
});
test('stopping a journal cursor retains its read and handles until transaction completion',async t=>{
 const previousRange=globalThis.IDBKeyRange;globalThis.IDBKeyRange={bound:keyRange};
 const f=await database(t,[{name:'first'},{name:'x'.repeat(JOURNAL_RECORD_BYTES)}],{autoComplete:false}),before=ownedState(),coverage=journalReadCoverage();let settled=false,visited=0;
 const pending=f.journal.scan('command:',()=>{visited++;return false;}).then(()=>{settled=true;return {ok:true};},error=>{settled=true;return {error};});
 try{
  await flush();assert.equal(visited,1);assert.equal(f.cursorReads,1);assert.equal(f.continues,0);assert.equal(settled,false);
  assert.equal(journalReadCoverage().activeUnverifiedReads,coverage.activeUnverifiedReads+1);const held=ownedState();assert(held.cpuBytes>before.cpuBytes);assert(held.handles>before.handles);assert(held.activeRecords>before.activeRecords);
  f.tx.emit('complete');assert.deepEqual(await pending,{ok:true});assert.equal(journalReadCoverage().activeUnverifiedReads,coverage.activeUnverifiedReads);assert.deepEqual(ownedState(),before);
 }finally{f.tx.emit('complete');await pending;globalThis.IDBKeyRange=previousRange;}
});
test('invalid journal keyset controls reject before admitting a read or creating a transaction',async t=>{
 const previousRange=globalThis.IDBKeyRange;let ranges=0;globalThis.IDBKeyRange={bound(...args){ranges++;return keyRange(...args);}};
 const f=await database(t,[{name:'retained'}]),before=ownedState(),coverage=journalReadCoverage();let visited=0;
 try{
  for(const [prefix,options]of [['x'.repeat(257),{}],['command:',{after:'command:'+'x'.repeat(249)}],['command:',{after:'ui-request:foreign'}],['command:',{direction:'sideways'}]])await assert.rejects(f.journal.scan(prefix,()=>visited++,options));
  assert.equal(f.transactions,0);assert.equal(f.cursorReads,0);assert.equal(visited,0);assert.equal(ranges,0);assert.deepEqual(journalReadCoverage(),coverage);assert.deepEqual(ownedState(),before);
 }finally{globalThis.IDBKeyRange=previousRange;}
});

const resource=await moduleURL('src/state/document-lifecycle.ts');
const {viewURL,memoryURL}=await viewModelDependencies(allocations,{controlURL:control});
const {commandsURL}=await draftStateDependencies(allocations,{memoryURL,controlURL:control});
const source=(await transformWithOxc(await readFile(root+'/src/state/editor-client.ts','utf8'),'editor-client.ts')).code.replace(/^import\s+[\s\S]*?\sfrom\s+["'][^"']+["'];?\n/gm,'');
const {EditorClient}=await import(data(`import {ModelPayload} from ${JSON.stringify(memoryURL)};import {ViewModelOwners,ViewModelReads,canonicalControlHash,VIEW_MODEL_LIMITS,ownDownload} from ${JSON.stringify(viewURL)};import {CommandControlReads} from ${JSON.stringify(commandsURL)};import {allocationLedger} from ${JSON.stringify(allocations)};import {reserveCommandWire} from ${JSON.stringify(control)};import {DocumentResources} from ${JSON.stringify(resource)};
const createValueModel=initial=>{let value=initial;return {value:{get:()=>value},set:next=>{value=next;}};};const EMPTY_EXPECTED_VERSIONS={hash:'hash',byteLength:'0',mediaType:'application/json'};const browserPhases={resetNavigation(){},reset(){},recorder:{start(){return {end(){}};}}};\n`+source));
test('EditorClient oversized checkpoint preserves the exact prior view and never journals or sends',async()=>{
 const initial=state(),client=new EditorClient({transport:async()=>{throw Error('must not send');}});client.owner='client';const prior=client.view,before=state();let writes=0;client.journal={put:async()=>writes++};
 try{await assert.rejects(client.command({type:'SaveCheckpoint',name:'x'.repeat(65536)},null),/Shorten the checkpoint name/);assert.equal(writes,0);assert.equal(client.view,prior);assert.equal(state().cpuBytes,before.cpuBytes);}finally{client.viewModels.releaseControlView();}assert.equal(state().cpuBytes,initial.cpuBytes);
});
test('EditorClient envelope stays owned through journal and delivery and survives caller mutation',async()=>{
 const before=state(),journal=deferred(),delivery=deferred(),client=new EditorClient({}),body={type:'SaveCheckpoint',name:'original'},idle=state();client.owner='client';let saved,submitted;
 client.journal={async put(key,value){saved=value;await journal.promise;}};client.restorePending=async()=>{};client.deliver=async value=>{submitted=value;await delivery.promise;return [];};
 const work=client.command(body,null);body.name='changed';assert(state().cpuBytes>idle.cpuBytes);assert.equal(saved.request.command.body.name,'original');journal.resolve();await flush();assert.equal(submitted,saved);assert(state().cpuBytes>idle.cpuBytes);delivery.resolve();await work;assert.equal(state().cpuBytes,idle.cpuBytes);client.viewModels.releaseControlView();assert.equal(state().cpuBytes,before.cpuBytes);
});
test('pending scan refusal keeps the previous complete list and releases partial admission',async()=>{
 const before=state(),client=new EditorClient({identity:()=> 'client'}),prior=[{label:'prior'}];client.patch({pending:prior});const idle=state();client.journal={async scan(prefix,visit){visit({request:{command:{commandId:'new',body:{type:'Checkpoint'}}},wire:'{}',label:'new'},'command:new');throw Error('legacy oversized record');}};
 try{await assert.rejects(client.restorePending(),/legacy oversized record/);assert.equal(client.view.pending,prior);assert.equal(state().cpuBytes,idle.cpuBytes);}finally{client.viewModels.releaseControlView();}assert.equal(state().cpuBytes,before.cpuBytes);
});
