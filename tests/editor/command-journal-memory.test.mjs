// Authored source-only; execute only after coordinated promotion.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';
const root=process.env.COMMAND_JOURNAL_ROOT??'.';
const data=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
async function moduleURL(path,imports={}){let source=(await transformWithOxc(await readFile(path,'utf8'),path)).code;for(const [name,url]of Object.entries(imports))source=source.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));return data(source);}
const allocations=await moduleURL('src/observability/allocations.ts'),control=await moduleURL(root+'/src/state/control-memory.ts',{'../observability/allocations.js':allocations});
const journalURL=await moduleURL(root+'/src/state/browser-journal.ts',{'../observability/allocations.js':allocations,'./control-memory.js':control});
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

function database(rows=[]){
 let transactions=0,putCalls=0,aborts=0,last;
 const db={transaction(){transactions++;let stopped=false;const request={result:undefined},tx={error:null,oncomplete:null,onabort:null,onerror:null,abort(){aborts++;stopped=true;queueMicrotask(()=>tx.onabort?.());},objectStore(){return {put(){putCalls++;},get(){queueMicrotask(()=>{request.result=rows[0];request.onsuccess?.();if(!stopped)queueMicrotask(()=>tx.oncomplete?.());});return request;},openCursor(){let at=0;const next=()=>queueMicrotask(()=>{if(stopped)return;let continued=false;request.result=at<rows.length?{value:rows[at++],continue(){continued=true;next();}}:null;request.onsuccess?.();if(!continued&&!stopped)queueMicrotask(()=>tx.oncomplete?.());});next();return request;}};}};last=tx;return tx;},close(){}};
 return {journal:new BrowserJournal(db),get transactions(){return transactions;},get putCalls(){return putCalls;},get aborts(){return aborts;},get tx(){return last;}};
}
test('journal writes validate before native clone and keep admission until abort settlement',async()=>{
 const f=database(),before=state();await assert.rejects(f.journal.put('command:x',{name:'a'.repeat(JOURNAL_RECORD_BYTES)}),/Shorten the checkpoint name/);assert.equal(f.transactions,0);
 const work=f.journal.put('command:x',{name:'short'}).then(()=>({ok:true}),error=>({error}));assert.equal(f.putCalls,1);const held=state().cpuBytes;assert(held>before.cpuBytes);
 f.tx.error=Error('idb error');f.tx.onerror();await flush();assert.equal(state().cpuBytes,held);f.tx.onabort();assert.equal((await work).error.message,'idb error');assert.equal(state().cpuBytes,before.cpuBytes);
});
test('legacy oversized cursor value is rejected before visit with explicit native uncertainty',async()=>{
 const previousRange=globalThis.IDBKeyRange;globalThis.IDBKeyRange={bound:(a,b)=>[a,b]};
 const oversized={name:'x'.repeat(JOURNAL_RECORD_BYTES)},rows=[oversized,{name:'later'}],f=database(rows),before=state(),coverage=journalReadCoverage();let visited=0;
 try{const pending=f.journal.scan('command:',()=>visited++);assert.equal(journalReadCoverage().activeUnverifiedReads,coverage.activeUnverifiedReads+1);assert.equal(journalReadCoverage().nativeCloneBytesKnown,false);await assert.rejects(pending,/remains in IndexedDB/);assert.equal(visited,0);assert.equal(f.aborts,1);assert.equal(rows[0],oversized);assert.equal(rows.length,2);assert.equal(journalReadCoverage().rejectedRecords,coverage.rejectedRecords+1);assert.equal(journalReadCoverage().activeUnverifiedReads,coverage.activeUnverifiedReads);assert.equal(state().cpuBytes,before.cpuBytes);}finally{globalThis.IDBKeyRange=previousRange;}
});
test('legacy get rejects oversized records and falsey visitor errors are preserved through abort',async()=>{
 const before=state(),f=database([{name:'x'.repeat(JOURNAL_RECORD_BYTES)}]);await assert.rejects(f.journal.get('command:x'),/remains in IndexedDB/);assert.equal(state().cpuBytes,before.cpuBytes);
 const previousRange=globalThis.IDBKeyRange;globalThis.IDBKeyRange={bound:(a,b)=>[a,b]};
 try{const one=database([{name:'ok'}]),result=await one.journal.scan('command:',()=>{throw undefined;}).then(()=>({ok:true}),error=>({error}));assert.deepEqual(result,{error:undefined});assert.equal(state().cpuBytes,before.cpuBytes);}finally{globalThis.IDBKeyRange=previousRange;}
});

const resource=await moduleURL('src/state/document-lifecycle.ts');
const source=(await transformWithOxc(await readFile(root+'/src/state/editor-client.ts','utf8'),'editor-client.ts')).code.replace(/^import\s+[\s\S]*?\sfrom\s+["'][^"']+["'];?\n/gm,'');
const {EditorClient}=await import(data(`import {allocationLedger} from ${JSON.stringify(allocations)};import {reserveCommandWire} from ${JSON.stringify(control)};import {DocumentResources} from ${JSON.stringify(resource)};
const createValueModel=initial=>{let value=initial;return {value:{get:()=>value},set:next=>{value=next;}};};const EMPTY_EXPECTED_VERSIONS={hash:'hash',byteLength:'0',mediaType:'application/json'};const browserPhases={reset(){},recorder:{start(){return {end(){}};}}};\n`+source));
test('EditorClient oversized checkpoint preserves the exact prior view and never journals or sends',async()=>{
 const client=new EditorClient({transport:async()=>{throw Error('must not send');}});client.owner='client';const prior=client.view,before=state();let writes=0;client.journal={put:async()=>writes++};
 await assert.rejects(client.command({type:'SaveCheckpoint',name:'x'.repeat(65536)},null),/Shorten the checkpoint name/);assert.equal(writes,0);assert.equal(client.view,prior);assert.equal(state().cpuBytes,before.cpuBytes);
});
test('EditorClient envelope stays owned through journal and delivery and survives caller mutation',async()=>{
 const before=state(),journal=deferred(),delivery=deferred(),client=new EditorClient({}),body={type:'SaveCheckpoint',name:'original'};client.owner='client';let saved,submitted;
 client.journal={async put(key,value){saved=value;await journal.promise;}};client.restorePending=async()=>{};client.deliver=async value=>{submitted=value;await delivery.promise;return [];};
 const work=client.command(body,null);body.name='changed';assert(state().cpuBytes>before.cpuBytes);assert.equal(saved.request.command.body.name,'original');journal.resolve();await flush();assert.equal(submitted,saved);assert(state().cpuBytes>before.cpuBytes);delivery.resolve();await work;assert.equal(state().cpuBytes,before.cpuBytes);
});
test('pending scan refusal keeps the previous complete list and releases partial admission',async()=>{
 const before=state(),client=new EditorClient({}),prior=[{label:'prior'}];client.patch({pending:prior});client.journal={async scan(prefix,visit){visit({label:'new'});throw Error('legacy oversized record');}};
 await assert.rejects(client.restorePending(),/legacy oversized record/);assert.equal(client.view.pending,prior);assert.equal(state().cpuBytes,before.cpuBytes);
});
