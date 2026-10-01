import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {transformWithOxc} from 'vite';
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
// Exercise the real EditorClient upload/checkpoint methods and incremental hash.
// Unused recovery/browser dependencies are stand-ins; transport is recorded.
const source=(await transformWithOxc(await readFile('src/state/editor-client.ts','utf8'),'editor-client.ts')).code.replace(/^import\s+[\s\S]*?\sfrom\s+["'][^"']+["'];?\n/gm,'');
const sha='import {SHA256} from '+JSON.stringify(data((await transformWithOxc(await readFile('src/protocol/sha256.ts','utf8'),'sha256.ts')).code))+';';
const allocationsURL=data((await transformWithOxc(await readFile('src/observability/allocations.ts','utf8'),'allocations.ts')).code);
const {allocationLedger,ALLOCATION_LIMITS}=await import(allocationsURL);
const allocations='import {allocationLedger} from '+JSON.stringify(allocationsURL)+';';
const phaseURL=data((await transformWithOxc(await readFile('src/observability/phases.ts','utf8'),'phases.ts')).code);
const workerURL=data((await transformWithOxc(await readFile('src/observability/browser-worker-observations.ts','utf8'),'browser-worker-observations.ts')).code.replaceAll('./phases.js',phaseURL));
const browserURL=data((await transformWithOxc(await readFile('src/observability/browser.ts','utf8'),'browser.ts')).code.replaceAll('./phases.js',phaseURL).replaceAll('./browser-worker-observations.js',workerURL).replaceAll('./allocations.js',allocationsURL));
const resourcesURL=data((await transformWithOxc(await readFile('src/state/document-lifecycle.ts','utf8'),'document-lifecycle.ts')).code);
const lifecycle='import {DocumentResources} from '+JSON.stringify(resourcesURL)+';import {browserPhases} from '+JSON.stringify(browserURL)+';';
const stub='const createValueModel=initial=>{let v=initial;return {value:{get:()=>v},set:next=>v=next};};';
const {EditorClient}=await import(data(stub+sha+allocations+lifecycle+source));
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function fixture(size=1048577){
 const bytes=new Uint8Array(size).fill(19),requests=[],slices=[];let identity='first',hook=async()=>{};const transport=async(path,init={})=>{const method=init.method??'GET';requests.push({path,method,init,identity});await hook(method);const offset=method==='PUT'?String(Number(init.headers['Upload-Offset'])+init.body.byteLength):'0';return {ok:true,async json(){await hook(method+' JSON');return {committedOffset:offset};}};};
 const client=new EditorClient({identity:()=>identity,transport});client.draftOwner={drafts:new Map()};client.ui={sessionId:'session'};
 let beforeSlice=async()=>{};const file={size,slice(start,end){slices.push([start,end]);return {async arrayBuffer(){await beforeSlice(slices.length,start,end);return bytes.slice(start,end).buffer;}};}};
 return {client,bytes,file,requests,slices,identity(value){identity=value;},hook(value){hook=value;},sliceHook(value){beforeSlice=value;}};
}
test('successful upload preserves exact hash, bounded hash reads and 1MiB transfer parts',async()=>{const f=fixture(),r=await f.client.upload(f.file,'adapter','application/octet-stream');assert.equal(r.sha256,'sha256:'+createHash('sha256').update(f.bytes).digest('hex'));assert.deepEqual(f.requests.map(r=>r.method),['POST','GET','PUT','PUT']);assert.deepEqual(f.requests.filter(r=>r.method==='PUT').map(r=>r.init.body.byteLength),[1048576,1]);assert(f.slices.slice(0,-2).every(([start,end])=>end-start>0&&end-start<=65536));assert(f.requests.every(r=>r.identity==='first'));});
for(const boundary of ['identity','session','ui-session','draft-owner','disconnect','predicate'])test('hash completion after '+boundary+' cannot create a staging transfer',async()=>{
 const f=fixture(4),entered=deferred(),release=deferred();let current=true;f.sliceHook(async()=>{entered.resolve();await release.promise;});const pending=f.client.upload(f.file,'adapter','application/octet-stream',undefined,()=>current);await entered.promise;
 if(boundary==='identity')f.identity('second');if(boundary==='session')f.client.session={...f.client.session};if(boundary==='ui-session')f.client.ui={sessionId:'other'};if(boundary==='draft-owner')f.client.draftOwner={drafts:new Map()};if(boundary==='disconnect')f.client.disconnect();if(boundary==='predicate')current=false;release.resolve();await assert.rejects(pending,/UPLOAD_OWNER_CHANGED/);assert.equal(f.requests.length,0);
});
for(const phase of ['POST','POST JSON','GET','GET JSON','PUT','PUT JSON'])test('owner change during '+phase+' stops every subsequent transfer request',async()=>{
 const f=fixture(),entered=deferred(),release=deferred();let blocked=false;f.hook(async method=>{if(method===phase&&!blocked){blocked=true;entered.resolve();await release.promise;}});const pending=f.client.upload(f.file,'adapter','application/octet-stream');await entered.promise;const before=f.requests.length;f.identity('second');release.resolve();await assert.rejects(pending,/UPLOAD_OWNER_CHANGED/);assert.equal(f.requests.length,before);assert(f.requests.every(r=>r.identity==='first'));assert(f.requests.at(-1).init.signal.aborted);
});
test('owner change while reading a transfer part cannot send that part',async()=>{const f=fixture(4),entered=deferred(),release=deferred();f.sliceHook(async n=>{if(n===2){entered.resolve();await release.promise;}});const pending=f.client.upload(f.file,'adapter','application/octet-stream');await entered.promise;f.identity('second');release.resolve();await assert.rejects(pending,/UPLOAD_OWNER_CHANGED/);assert.deepEqual(f.requests.map(r=>r.method),['POST','GET']);});
test('an already stale caller cannot even read the local file',async()=>{const f=fixture();await assert.rejects(f.client.upload(f.file,'adapter','application/octet-stream',undefined,()=>false),/UPLOAD_OWNER_CHANGED/);assert.equal(f.slices.length,0);assert.equal(f.requests.length,0);});
test('an image-bearing document root checkpoint switches to the exact retained branch',async()=>{const f=fixture(1),doc={id:'doc',revision:'1'};f.client.patch({document:doc});f.client.json=async()=>({items:[{id:'root',documentId:'doc',branchId:'branch',parent:null,forward:{before:null,after:{...doc,image:{state:{hash:'retained'}}}},inverse:{},roots:[]}],next:null});const commands=[];f.client.command=async(body,document)=>{commands.push({body,document});return [];};await f.client.openCheckpoint({documentId:'doc',historyHead:'root'});assert.deepEqual(commands,[{body:{type:'SwitchBranch',branchId:'branch',historyNode:'root'},document:doc}]);});
test('an empty document root still explains that no image can be restored',async()=>{const f=fixture(1),doc={id:'doc',revision:'1'};f.client.patch({document:doc});f.client.json=async()=>({items:[{id:'root',documentId:'doc',branchId:'branch',parent:null,forward:{before:null,after:doc},inverse:{},roots:[]}],next:null});f.client.command=async()=>assert.fail('empty root must not navigate');await assert.rejects(f.client.openCheckpoint({documentId:'doc',historyHead:'root'}),/empty-document checkpoint/);});

test('hash buffer admission precedes the native read and remains charged until it settles',async()=>{
 const before=allocationLedger.snapshot(),f=fixture(4),entered=deferred(),release=deferred();
 f.sliceHook(async()=>{assert.equal(allocationLedger.snapshot().cpuBytes-before.cpuBytes,4);entered.resolve();await release.promise;});
 const work=f.client.upload(f.file,'adapter','application/octet-stream');await entered.promise;
 f.identity('changed');assert.equal(allocationLedger.snapshot().cpuBytes-before.cpuBytes,4);release.resolve();
 await assert.rejects(work,/UPLOAD_OWNER_CHANGED/);assert.equal(allocationLedger.snapshot().cpuBytes,before.cpuBytes);assert.equal(allocationLedger.snapshot().activeRecords,before.activeRecords);
});

test('upload PUT retains both owned body allowances until the transport response drains',async()=>{
 const before=allocationLedger.snapshot(),f=fixture(4),entered=deferred(),release=deferred();
 f.hook(async method=>{if(method==='PUT JSON'){entered.resolve();await release.promise;}});
 const work=f.client.upload(f.file,'adapter','application/octet-stream');await entered.promise;
 assert.equal(allocationLedger.snapshot().cpuBytes-before.cpuBytes,8);assert.equal(allocationLedger.snapshot().byKind.staging.handles-before.byKind.staging.handles,2);
 release.resolve();await work;assert.equal(allocationLedger.snapshot().cpuBytes,before.cpuBytes);assert.equal(allocationLedger.snapshot().activeRecords,before.activeRecords);
});

test('hash admission refuses before any native file read or transfer',async()=>{
 const before=allocationLedger.snapshot(),f=fixture(4),pressure=allocationLedger.reserve({owner:'test-upload-pressure',kind:'control',cpuBytes:ALLOCATION_LIMITS.cpuBytes-ALLOCATION_LIMITS.textPartitionBytes-before.cpuBytes-3});
 try{await assert.rejects(f.client.upload(f.file,'adapter','application/octet-stream'),/ALLOCATION_BUDGET/);assert.deepEqual(f.slices,[]);assert.deepEqual(f.requests,[]);}
 finally{pressure.release();}
 assert.equal(allocationLedger.snapshot().activeRecords,before.activeRecords);
});

test('PUT admission refuses before creating the transfer body after hashing succeeds',async()=>{
 const before=allocationLedger.snapshot(),f=fixture(4);let pressure;
 f.hook(async method=>{if(method==='GET JSON')pressure=allocationLedger.reserve({owner:'test-upload-put-pressure',kind:'control',cpuBytes:ALLOCATION_LIMITS.cpuBytes-ALLOCATION_LIMITS.textPartitionBytes-before.cpuBytes-7});});
 try{await assert.rejects(f.client.upload(f.file,'adapter','application/octet-stream'),/ALLOCATION_BUDGET/);assert.equal(f.slices.length,1);assert.deepEqual(f.requests.map(request=>request.method),['POST','GET']);}
 finally{pressure?.release();}
 assert.equal(allocationLedger.snapshot().activeRecords,before.activeRecords);
});
