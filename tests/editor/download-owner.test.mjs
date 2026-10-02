// Source-only ownership fixtures; runtime execution belongs to root's gates.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';
import {viewModelDependencies} from '../view-model-module.mjs';
import {draftStateDependencies} from '../draft-state-module.mjs';
import {allocationsURL as allocations} from '../owned-preview-module.mjs';
const root=process.env.CLIENT_DOWNLOAD_ROOT??'.',data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const {viewURL,memoryURL}=await viewModelDependencies(allocations,{root}),resources=data((await transformWithOxc(await readFile('src/state/document-lifecycle.ts','utf8'),'resources.ts')).code);
const {commandsURL}=await draftStateDependencies(allocations,{memoryURL});
const {allocationLedger,ALLOCATION_LIMITS}=await import(allocations);
const clientCode=(await transformWithOxc(await readFile(root+'/src/state/editor-client.ts','utf8'),'editor-client.ts')).code.replace(/^import\s+[\s\S]*?\sfrom\s+["'][^"']+["'];?\n/gm,'');
const {EditorClient}=await import(data(`import {ViewModelOwners,ViewModelReads,ownDownload} from ${JSON.stringify(viewURL)};import {CommandControlReads} from ${JSON.stringify(commandsURL)};import {DocumentResources} from ${JSON.stringify(resources)};const createValueModel=initial=>{let value=initial;return {value:{get:()=>value},set:next=>{value=next;}};};const browserPhases={resetNavigation(){},reset(){}};\n`+clientCode));
const totals=()=>{const s=allocationLedger.snapshot();return {cpu:s.cpuBytes,handles:s.handles,records:s.activeRecords};};
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const download=(name='image.png')=>({path:'/api/v1/assets/export/content',name,hash:'sha256:'+'0'.repeat(64),bytes:'4294967296',kind:'image',mediaType:'image/png',documentId:'document',revision:'1',status:'ready',recovery:{kind:'recovery-copy',complete:false,omitted:[{kind:'resource',reason:'unavailable'}]}});
function fixture(){const client=new EditorClient({identity:()=> 'owner'});return {client,async close(){client.dispose();await turn();}};}
test('Download publication owns the complete disclosure and clones before replacing prior state',async()=>{
 const before=totals(),f=fixture(),input=download();try{f.client.patch({download:input});const admitted=f.client.view.download;assert.notEqual(admitted,input);assert.notEqual(admitted.recovery,input.recovery);input.recovery.omitted[0].reason='changed';assert.equal(admitted.recovery.omitted[0].reason,'unavailable');assert(totals().cpu>before.cpu);assert(totals().cpu-before.cpu<65536);assert.throws(()=>f.client.patch({download:download('x'.repeat(65536))}),/previous download is retained/);assert.equal(f.client.view.download,admitted);}finally{await f.close();}assert.deepEqual(totals(),before);
});
test('Download refusal preserves the previous exact root and active writer pins survive replacement',async()=>{
 const before=totals(),f=fixture();let pressure,release;try{f.client.patch({download:download()});const prior=f.client.view.download;release=f.client.pinDownload(prior);pressure=allocationLedger.reserve({owner:'download-test-pressure',kind:'control',cpuBytes:ALLOCATION_LIMITS.cpuBytes-ALLOCATION_LIMITS.textPartitionBytes-allocationLedger.snapshot().cpuBytes});assert.throws(()=>f.client.patch({download:download('next.png')}),/ALLOCATION_BUDGET/);assert.equal(f.client.view.download,prior);pressure.release();pressure=undefined;f.client.patch({download:download('next.png')});assert.equal(f.client.viewModels.ownership.retiredPinnedRoots,1);release();release=undefined;assert.throws(()=>f.client.pinDownload(prior),/VIEW_MODEL_UNOWNED/);assert.equal(f.client.viewModels.ownership.retiredPinnedRoots,0);}finally{pressure?.release();release?.();await f.close();}assert.deepEqual(totals(),before);
});
test('Dispose drops the Download root while an actual action retains its pin until settlement',async()=>{
 const before=totals(),f=fixture();f.client.patch({download:download()});const item=f.client.view.download,release=f.client.pinDownload(item);await f.close();assert.equal(f.client.view.download,null);assert(totals().cpu>before.cpu);release();assert.deepEqual(totals(),before);
});

const compiled=(await transformWithOxc(await readFile(root+'/src/ui/shell.ts','utf8'),'shell.ts')).code;
const shellClass=compiled.slice(compiled.indexOf('class EditorShell'),compiled.lastIndexOf('scope.register('));
const shellModule=await import(data(`class LitElement{};let editor,chooseDestination,writeDestination;const connection={identity:()=> 'owner',transport(){}};export function dependencies(client,picker,writer){editor=client;chooseDestination=picker;writeDestination=writer;}\n`+shellClass+'\nexport {EditorShell};'));
function shell(client,picker,writer){shellModule.dependencies(client,picker,writer);client.run=async(_label,work)=>{await work();};const value=Object.create(shellModule.EditorShell.prototype);Object.assign(value,{destinationWrite:null,requestUpdate(){}});return value;}
test('The actual destination action retains an earlier Download until its writer drains',async()=>{
 const before=totals(),f=fixture(),gate=deferred(),entered=deferred();let received;f.client.patch({download:download()});const original=f.client.view.download,s=shell(f.client,()=>null,async item=>{received=item;entered.resolve();await gate.promise;return 'confirmed';});
 // A successor export has its own asset path/hash; renaming the same prepared
 // bytes does not create a new destination-write identity.
 let work;try{work=s.download();await entered.promise;assert.equal(received,original);assert.equal(f.client.viewModels.ownership.activePins,1);f.client.patch({download:{...download('successor.png'),path:'/api/v1/assets/successor/content',hash:'sha256:'+'1'.repeat(64)}});const successor=f.client.view.download;assert.notEqual(successor.path,original.path);assert.notEqual(successor.hash,original.hash);assert.equal(f.client.viewModels.ownership.retiredPinnedRoots,1);gate.resolve();await work;assert.equal(f.client.view.download,successor);assert.equal(f.client.view.download.name,'successor.png');assert.equal(f.client.view.download.status,'ready');assert.equal(s.destinationWrite,null);assert.equal(f.client.viewModels.ownership.activePins,0);assert.throws(()=>f.client.pinDownload(original),/VIEW_MODEL_UNOWNED/);}finally{gate.resolve();try{await work;}finally{await f.close();}}assert.deepEqual(totals(),before);
});
test('A synchronous native picker failure releases the action pin and leaves the prepared Download retryable',async()=>{
 const before=totals(),f=fixture();f.client.patch({download:download()});const prior=f.client.view.download,s=shell(f.client,()=>{throw Error('picker failed');},async()=>assert.fail('writer must not begin'));
 try{await assert.rejects(s.download(),/picker failed/);assert.equal(s.destinationWrite,null);assert.equal(f.client.view.download,prior);assert.equal(f.client.viewModels.ownership.activePins,0);}finally{await f.close();}assert.deepEqual(totals(),before);
});
