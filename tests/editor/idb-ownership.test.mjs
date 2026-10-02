// Real wrapper/ledger source; manually ordered native-boundary doubles. These
// tests do not claim to measure IndexedDB backing or browser native reclamation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {transformWithOxc} from 'vite';
import {rolldown} from 'rolldown';
import {isolatedDiagnosticModules,allocationDeltaSnapshot} from '../owned-preview-module.mjs';
const root=process.env.IE_IDB_SOURCE_ROOT??'.',data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');let serial=0,validation;
async function module(path,imports={},id=''){let code=(await transformWithOxc(await readFile(path,'utf8'),path)).code;for(const [name,url]of Object.entries(imports))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));return data(code+'\n// '+id);}
async function validate(){return validation??= (async()=>{const bundle=await rolldown({input:resolve('src/protocol/validate.ts'),platform:'neutral',logLevel:'silent'});try{const {output}=await bundle.generate({format:'esm'});assert.equal(output.length,1);return data(output[0].code);}finally{await bundle.close();}})();}
const flush=async()=>{for(let n=0;n<12;n++)await Promise.resolve();};
function events(value={}){const listeners=new Map();return Object.assign(value,{addEventListener(name,fn){const set=listeners.get(name)??new Set();set.add(fn);listeners.set(name,set);},removeEventListener(name,fn){listeners.get(name)?.delete(fn);},emit(name){for(const fn of [...listeners.get(name)??[]])fn({type:name});value['on'+name]?.({type:name});}});}
function native(){
 const transactions=[],calls=[];let openCalls=0,closeCalls=0,openRequest,openError,transactionError,requestError,closeError;
 const makeTransaction=()=>{
  const pending=[],tx=events({error:null,abortCalls:0,abortError:null,abort(){this.abortCalls++;if(this.abortError)throw this.abortError;},objectStore(store){return Object.fromEntries(['get','getKey','put','delete','openCursor'].map(method=>[method,(...args)=>{calls.push({store,method,args});if(requestError)throw requestError;const request={result:undefined,error:null,onsuccess:null,onerror:null,succeed(value){this.result=value;this.onsuccess?.();},fail(error){this.error=error;this.onerror?.();}};pending.push(request);return request;} ]));}});
  tx.pending=pending;transactions.push(tx);return tx;
 };
 const db=events({createObjectStore(name){calls.push({method:'createObjectStore',name});},transaction(){if(transactionError)throw transactionError;return makeTransaction();},close(){closeCalls++;if(closeError)throw closeError;}});
 const api={open(){openCalls++;if(openError)throw openError;openRequest={result:db,error:null,transaction:null};return openRequest;}};
 return {api,db,transactions,calls,get tx(){return transactions.at(-1);},get request(){return openRequest;},get openCalls(){return openCalls;},get closeCalls(){return closeCalls;},set openError(v){openError=v;},set transactionError(v){transactionError=v;},set requestError(v){requestError=v;},set closeError(v){closeError=v;},upgrade(){openRequest.transaction=makeTransaction();openRequest.onupgradeneeded();},opened(){openRequest.onsuccess();},failed(error){openRequest.error=error;openRequest.onerror();}};
}
async function fixture(t){
 const id=String(++serial),{allocationsURL:allocations}=await isolatedDiagnosticModules(),control=await module('src/state/control-memory.ts',{'../observability/allocations.js':allocations},id),owned=await module(root+'/src/state/idb-ownership.ts',{'../observability/allocations.js':allocations},id);
 const journal=await module(root+'/src/state/browser-journal.ts',{'../observability/allocations.js':allocations,'./control-memory.js':control,'./idb-ownership.js':owned},id);
 const projection=await module('src/state/projection.ts',{},id),cache=await module(root+'/src/state/recovery-cache.ts',{'../observability/allocations.js':allocations,'./idb-ownership.js':owned,'./projection.js':projection,'../protocol/validate.js':await validate()},id);
 const api={...await import(allocations),...await import(owned),...await import(journal),...await import(cache)},boundary=native(),previous=globalThis.indexedDB,range=globalThis.IDBKeyRange;
 globalThis.indexedDB=boundary.api;globalThis.IDBKeyRange={bound:(...args)=>args};t.after(()=>{globalThis.indexedDB=previous;globalThis.IDBKeyRange=range;});
 // Capture import-time diagnostics once; only assertions use the fixed delta.
 // Pressure still books the actual ledger against its unchanged raw ceiling.
 const diagnosticHandles=api.allocationLedger.snapshot().handles,state=allocationDeltaSnapshot(api.allocationLedger);
 return {...api,native:boundary,state,diagnosticHandles,async journal(){const work=api.BrowserJournal.open('test');boundary.opened();return work;},async cache(){const work=api.RecoveryCache.open('test');boundary.opened();return work;}};
}
function pending(work){let settled=false;const result=work.then(value=>{settled=true;return {value};},error=>{settled=true;return {error};});return {result,get settled(){return settled;}};}

test('connection/open/possible-upgrade handles are all admitted before native open',async t=>{
 const f=await fixture(t),block=f.allocationLedger.reserve({owner:'idb-test-pressure',kind:'control',handles:f.ALLOCATION_LIMITS.handles-2-f.diagnosticHandles});
 assert.equal(f.ALLOCATION_LIMITS.handles-f.allocationLedger.snapshot().handles,2);
 await assert.rejects(f.BrowserJournal.open('test'),/ALLOCATION_BUDGET/);assert.equal(f.native.openCalls,0);assert.equal(f.state().handles,f.ALLOCATION_LIMITS.handles-2-f.diagnosticHandles);assert.equal(f.idbOwnershipCoverage().connections,0);block.release();
});
test('synchronous native open failure returns every reservation',async t=>{
 const f=await fixture(t);f.native.openError=Error('open failed');await assert.rejects(f.RecoveryCache.open('test'),/open failed/);assert.equal(f.state().handles,0);assert.equal(f.state().activeRecords,0);
});
test('pending open and its possible upgrade remain owned until actual request completion',async t=>{
 const f=await fixture(t),work=pending(f.BrowserJournal.open('test'));assert.equal(f.state().handles,3);await flush();assert.equal(work.settled,false);assert.equal(f.state().handles,3);
 f.native.opened();const {value:journal}=await work.result;assert.equal(f.state().handles,1);journal.close();assert.equal(f.state().handles,0);assert.equal(f.idbOwnershipCoverage().nativeCleanupObserved,false);
});
test('upgrade error alone cannot refund its pre-admitted native transaction',async t=>{
 const f=await fixture(t),work=pending(f.RecoveryCache.open('test'));f.native.upgrade();assert.equal(f.state().handles,3);assert.equal(f.native.calls.filter(c=>c.method==='createObjectStore').length,2);
 f.native.tx.error=Error('upgrade error');f.native.tx.emit('error');await flush();assert.equal(f.state().handles,3);assert.equal(work.settled,false);
 f.native.tx.emit('abort');assert.equal(f.state().handles,2);f.native.failed(Error('upgrade aborted'));assert.match((await work.result).error.message,/upgrade aborted/);assert.equal(f.state().handles,0);
});
test('Journal.has waits for transaction terminal and close fences new work while draining',async t=>{
 const f=await fixture(t),journal=await f.journal(),work=pending(journal.has('command:1'));assert.equal(f.state().handles,3);
 f.native.tx.pending[0].succeed('command:1');await flush();assert.equal(work.settled,false);assert.equal(f.state().handles,2);journal.close();assert.equal(f.native.closeCalls,1);assert.equal(f.state().handles,2);
 await assert.rejects(journal.has('command:2'),/IDB_CONNECTION_CLOSING/);assert.equal(f.native.transactions.length,1);f.native.tx.emit('complete');assert.deepEqual(await work.result,{value:true});assert.equal(f.state().handles,0);journal.close();assert.equal(f.native.closeCalls,1);
});
test('synchronous transaction refusal releases only its uncreated transaction handle',async t=>{
 const f=await fixture(t),cache=await f.cache();f.native.transactionError=Error('transaction refused');await assert.rejects(cache.published(),/transaction refused/);assert.equal(f.state().handles,1);cache.close();assert.equal(f.state().handles,0);
});
test('request admission occurs before native method and retains the transaction until abort',async t=>{
 const f=await fixture(t),cache=await f.cache(),block=f.allocationLedger.reserve({owner:'idb-test-pressure',kind:'control',handles:f.ALLOCATION_LIMITS.handles-2-f.diagnosticHandles});assert.equal(f.ALLOCATION_LIMITS.handles-f.allocationLedger.snapshot().handles,1);
 const work=pending(cache.published());assert.equal(f.native.calls.length,0);assert.equal(f.native.tx.abortCalls,1);await flush();assert.equal(work.settled,false);assert.equal(f.allocationLedger.snapshot().handles,f.ALLOCATION_LIMITS.handles);
 f.native.tx.emit('abort');assert.match((await work.result).error.message,/ALLOCATION_BUDGET/);block.release();assert.equal(f.state().handles,1);cache.close();assert.equal(f.state().handles,0);
});
test('synchronous request throw never uses an error as transaction terminal proof',async t=>{
 const f=await fixture(t),cache=await f.cache();f.native.requestError=Error('request failed');const work=pending(cache.published());assert.equal(f.native.tx.abortCalls,1);await flush();assert.equal(work.settled,false);assert.equal(f.state().handles,2);cache.close();assert.equal(f.state().handles,2);
 f.native.tx.emit('abort');assert.match((await work.result).error.message,/request failed/);assert.equal(f.state().handles,0);
});
test('prevented request/transaction errors remain owned until a later real terminal event',async t=>{
 const f=await fixture(t),cache=await f.cache(),work=pending(cache.published()),tx=f.native.tx,error=Error('request error');tx.pending[0].fail(error);tx.emit('error');await flush();assert.equal(work.settled,false);assert.equal(f.state().handles,3);
 tx.emit('complete');assert.equal((await work.result).error,error);assert.equal(f.state().handles,1);cache.close();assert.equal(f.state().handles,0);
});
test('native close throw keeps the exact connection until successful retry and drain',async t=>{
 const f=await fixture(t),journal=await f.journal(),work=pending(journal.has('x'));f.native.closeError=Error('close failed');assert.throws(()=>journal.close(),/close failed/);assert.equal(f.state().unusedHandles,1);assert.equal(f.idbOwnershipCoverage().unconfirmedClose,1);
 f.native.tx.pending[0].succeed(undefined);f.native.tx.emit('complete');assert.deepEqual(await work.result,{value:false});assert.equal(f.state().handles,1);await assert.rejects(journal.has('y'),/IDB_CONNECTION_CLOSING/);
 f.native.closeError=null;journal.close();assert.equal(f.native.closeCalls,2);assert.equal(f.state().handles,0);assert.equal(f.idbOwnershipCoverage().unconfirmedClose,0);
});
test('repeated successful normal open/close has no permanent logical handle accumulation',async t=>{
 const f=await fixture(t);for(let n=0;n<20;n++){const cache=await f.cache();assert.equal(f.state().handles,1);cache.close();assert.equal(f.state().handles,0);assert.equal(f.state().activeRecords,0);}assert.equal(f.native.closeCalls,20);assert.equal(f.idbOwnershipCoverage().nativeCloneBytesKnown,false);assert.equal(f.state().complete,false);
});
test('raw publication read exposes clone uncertainty and does not double-book caller payload slots',async t=>{
 const f=await fixture(t),cache=await f.cache(),cpu=f.state().cpuBytes,work=pending(cache.published()),legacy={generation:'legacy',cursor:'0',epoch:null,opaque:'x'.repeat(70000)};f.native.tx.pending[0].succeed(legacy);await flush();assert.equal(work.settled,false);assert.equal(f.state().cpuBytes,cpu);assert.equal(f.idbOwnershipCoverage().nativeCloneBytesKnown,false);
 f.native.tx.emit('complete');assert.equal((await work.result).value,legacy);cache.close();assert.equal(f.state().handles,0);
});
test('published pointer and selected row share one admitted transaction',async t=>{
 const f=await fixture(t),cache=await f.cache(),work=pending(cache.read('document','d')),tx=f.native.tx;tx.pending[0].succeed({generation:'g',cursor:'1',epoch:'1'});assert.equal(f.native.transactions.length,1);assert.equal(tx.pending.length,2);assert.deepEqual(f.native.calls[1].args[0],['g','document','d']);const row={id:'d'};tx.pending[1].succeed(row);await flush();assert.equal(work.settled,false);tx.emit('complete');assert.equal((await work.result).value,row);cache.close();assert.equal(f.state().handles,0);
});
test('row iterator yields only after cursor transaction drains and early return starts no further read',async t=>{
 const f=await fixture(t),cache=await f.cache(),rows=cache.rows('g','document'),work=pending(rows.next()),tx=f.native.tx;tx.pending[0].succeed({key:['g','document','d'],value:{id:'d'}});await flush();assert.equal(work.settled,false);assert.equal(f.state().handles,3);tx.emit('complete');assert.deepEqual((await work.result).value,{done:false,value:{id:'d',value:{id:'d'}}});assert.equal(f.state().handles,1);await rows.return();assert.equal(f.native.transactions.length,1);cache.close();
});
test('clone reuses one cursor token and retires completed writes without ending its transaction',async t=>{
 const f=await fixture(t),cache=await f.cache(),work=pending(cache.clone('old','new')),tx=f.native.tx;tx.pending[0].succeed({generation:'old'});const cursor=tx.pending[1];let continued=0;
 for(let n=0;n<30;n++){cursor.succeed({key:['old','document',String(n)],value:{id:String(n)},continue(){continued++;}});assert.equal(f.state().handles,4);tx.pending.at(-1).succeed(String(n));assert.equal(f.state().handles,3);}assert.equal(continued,30);cursor.succeed(null);await flush();assert.equal(work.settled,false);tx.emit('complete');assert.deepEqual(await work.result,{value:undefined});cache.close();assert.equal(f.state().handles,0);
});
test('falsey cursor callback failure and failed abort hold existing payload until terminal',async t=>{
 const f=await fixture(t),cache=await f.cache();let callbacks=0;const work=pending(cache.collect('font',()=>{callbacks++;throw undefined;},1)),tx=f.native.tx;tx.pending[0].succeed({generation:'g'});tx.abortError=Error('abort unavailable');tx.pending[1].succeed({value:{id:'bad'},continue(){assert.fail('Must not continue');}});assert.equal(tx.abortCalls,1);tx.pending[1].succeed({value:{id:'later'},continue(){assert.fail('Must not continue after failure');}});assert.equal(callbacks,1);await flush();assert.equal(work.settled,false);assert.equal(f.state().cpuBytes,1048576);assert.equal(f.state().handles,4);
 tx.emit('abort');const error=(await work.result).error;assert.equal(error.message,'IDB_ABORT_UNCONFIRMED');assert.equal(error.errors[0],undefined);assert.equal(f.state().cpuBytes,0);cache.close();assert.equal(f.state().handles,0);
});
test('publication conflict aborts before new pointer or old-generation discard',async t=>{
 const f=await fixture(t),cache=await f.cache(),work=pending(cache.publish({generation:'next',cursor:'2',epoch:'1'},{generation:'prior',cursor:'1',epoch:'1'})),tx=f.native.tx;tx.pending[0].succeed({generation:'different',cursor:'1',epoch:'1'});assert.equal(tx.abortCalls,1);assert.equal(f.native.calls.some(call=>call.method==='put'||call.method==='delete'),false);await flush();assert.equal(work.settled,false);tx.emit('abort');assert.equal((await work.result).error.name,'RecoveryPublicationConflict');cache.close();assert.equal(f.state().handles,0);
});
