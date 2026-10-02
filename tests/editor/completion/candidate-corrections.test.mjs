import {privateServerRows} from './header-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {ownServerProcess} from './owned-process.mjs';
import {acquireOwnedSetup} from './setup-owned.mjs';
import {monitorHarness} from './monitor-harness.mjs';
import {hostFixture,injectedHostFinal} from './host-final-fixtures.mjs';
import {partitionHostTraffic} from './host-final-traffic.mjs';
const clone=structuredClone;

for(const phase of ['provisional','drained','shutdown'])test('actual monitor refuses recorder errors first reported at '+phase,async()=>{
 const h=await monitorHarness();await h.preview();await h.monitor.closeEpoch();
 if(phase==='provisional'){h.recorderFailures.push('late provisional');await assert.rejects(()=>h.monitor.beforeNavigate(),/Recorder observation/);}
 else {await h.monitor.beforeNavigate();await h.pagehide();await h.monitor.beforeServerStop();if(phase==='drained'){h.recorderFailures.push('late drained');await assert.rejects(()=>h.monitor.beforeServerStop(),/Recorder observation/);}else h.onShutdown(()=>h.recorderFailures.push('at shutdown'));}
 await h.monitor.detach().catch(()=>{});await assert.rejects(()=>h.monitor.finish(true));assert.notEqual(h.record().complete,true);
});
test('actual monitor refuses missing final close evidence',async()=>{const h=await monitorHarness();await h.monitor.closeEpoch();await h.monitor.beforeNavigate();await h.pagehide();await h.monitor.detach();h.onShutdown(()=>Object.defineProperty(h.server,'shutdown',{set(){},get(){return null;}}));await assert.rejects(()=>h.monitor.finish(true),/process exit/);});
test('actual monitor refuses live recorder ownership loss',async()=>{const h=await monitorHarness();const original=h.server.recorder;h.server.recorder=async()=>({...await original(),installed:false});await assert.rejects(()=>h.monitor.closeEpoch());});

function traffic(e){
 const x=hostFixture(e),r=x.registration,b=x.body,d={...clone(b),id:2,path:r.receiver,method:'GET',responseStatus:200,inert:true};
 const host={run:r.run,origin:r.origin,pid:r.pid,instance:r.instance,errors:[],registrations:[r],bodies:[b],documents:[d]},server=[];
 for(const [i,receipt]of [b,d].entries())server.push(...privateServerRows(receipt,i+1));
 const id='private.1',url=r.origin+r.path,common={requestId:id,frameId:r.context.frameId};
 const network=[{name:'Network.requestWillBeSent',params:{...common,request:{url,method:'POST',headers:clone(b.headers)}}},{name:'Network.requestWillBeSentExtraInfo',params:{requestId:id,headers:clone(b.headers)}},{name:'Network.responseReceived',params:{...common,response:{url,status:204,headers:{},fromDiskCache:false,fromServiceWorker:false}}},{name:'Network.responseReceivedExtraInfo',params:{requestId:id,statusCode:204,headers:{}}},{name:'Network.loadingFinished',params:{requestId:id,encodedDataLength:0}}];
 return {origin:r.origin,host,server,network,requests:[],responses:[],terminals:[]};
}
for(const exposure of ['full','partial','none'])test('actual private partition preserves valid '+exposure+' exposure',()=>{const x=traffic();if(exposure==='partial')x.network=x.network.slice(0,2);if(exposure==='none')x.network=[];const p=partitionHostTraffic(x);assert.equal(p.private.records.length,2);assert.equal(p.network.length,0);});
const contradictions={
 extraStatus:x=>x.network[3].params.statusCode=503,
 requestHeader:x=>x.network[1].params.headers.accept='application/wasm',
 responseHeader:x=>x.network[3].params.headers['content-type']='application/wasm',
 responseURL:x=>x.network[2].params.response.url='/wrong',
 responseStatus:x=>x.network[2].params.response.status=503,
 frame:x=>x.network[0].params.frameId='foreign',
 target:x=>x.network[0].params.targetId='foreign',
 resource:x=>x.network[0].params.type='Script',
 context:x=>x.network[2].params.browserContextId='foreign',
 session:x=>x.network[0].controllerSessionLabel='worker',
 method:x=>x.network[0].params.request.method='GET',
 redirect:x=>x.network[0].params.redirectResponse={},
 diskCache:x=>x.network[2].params.response.fromDiskCache=true,
 sw:x=>x.network[2].params.response.fromServiceWorker=true,
 prefetch:x=>x.network[2].params.response.fromPrefetchCache=true,
 cacheEvent:x=>x.network.push({name:'Network.requestServedFromCache',params:{requestId:'private.1'}}),
 dualTerminal:x=>x.network.push({name:'Network.loadingFailed',params:{requestId:'private.1',errorText:'net::ERR_ABORTED'}}),
 rawHeader:x=>x.network[3].params.headersText='HTTP/1.1 503 Wrong\r\n',
 malformedData:x=>x.network.push({name:'Network.dataReceived',params:{requestId:'private.1',dataLength:-1,encodedDataLength:0}}),
 unrelatedSameID:x=>x.network.push({name:'Network.requestWillBeSent',params:{requestId:'private.1',request:{url:x.origin+'/assets/engine.wasm',method:'GET',headers:{}}}}),
};
for(const index of [0,1,2,3,4])contradictions['duplicate'+index]=x=>x.network.push(clone(x.network[index]));
for(const [name,mutate]of Object.entries(contradictions))test('complete same-ID private group rejects '+name,()=>{const x=traffic();mutate(x);assert.throws(()=>partitionHostTraffic(x));});
test('private PW/protocol terminal contradiction cannot be partitioned',()=>{const x=traffic(),url=x.origin+x.host.registrations[0].path;x.requests.push({id:9,url,method:'POST',originalRequestObject:true,redirectedFrom:null,redirectedTo:null,frameExposure:{ownerPage:true,ownerFrame:true,ownerContext:true},actualHeaders:clone(x.host.bodies[0].headers)});x.terminals.push({requestId:9,url,kind:'failed',originalRequestObject:true,failure:{errorText:'net::ERR_ABORTED'}});assert.throws(()=>partitionHostTraffic(x),/terminal agreement/);});
test('actual monitor rejects late private ExtraInfo contradiction beside complete host receipt',async()=>{
 let h;
 const factory=async args=>{const base=await injectedHostFinal(args);return {...base,async depart(e){await base.depart(e);const x=traffic(e);e.hostSnapshot=x.host;h.serverRows.push(...x.server);h.saveLedger();for(const n of x.network.slice(0,3))h.pageSession.emit(n.name,n.params);}};};
 h=await monitorHarness({hostFactory:factory});await h.monitor.closeEpoch();await h.monitor.beforeNavigate();await h.pagehide();await h.monitor.beforeServerStop();h.pageSession.emit('Network.responseReceivedExtraInfo',{requestId:'private.1',statusCode:503,headers:{}});await h.monitor.detach();await assert.rejects(()=>h.monitor.finish(true),/ExtraInfo status/);assert.notEqual(h.record().complete,true);
});

function childStub(mode){
 const c=Object.assign(new EventEmitter(),{pid:12345,stderr:new EventEmitter(),exitCode:null,signalCode:null,connected:true,requests:[],kill(signal){this.signalCode=signal;this.emit('exit',null,signal);return true;}});
 const stop=()=>{c.exitCode=0;c.emit('exit',0,null);};
 c.send=(m,callback)=>{c.requests.push(m);queueMicrotask(()=>{callback?.();if(m==='close'){stop();return;}if(m.type==='host'){c.emit('message',{type:m.reply,...mode==='precheck'?{error:{message:'precheck refused'}}:{value:true}});return;}if(m.type==='completion-close'){
  if(mode==='disconnect'){c.emit('disconnect');return;}if(mode==='missing')return;
  if(mode==='race'&&!m.cleanupOnly){c.emit('message',{type:m.reply,value:{type:'close-refused',failures:[{phase:'child-precheck'}]}});return;}
  c.emit('message',{type:m.reply,value:{type:'completion-closed',failures:mode==='close-error'?[{phase:'server-close',message:'own error'}]:[],cleanupOnly:m.cleanupOnly}});stop();
 }});return true;};
 queueMicrotask(()=>mode==='readiness'?c.emit('error',Error('readiness rejected')):c.emit('message',{type:'ready',origin:'http://127.0.0.1:34567',instance:'instance'}));return c;
}
for(const mode of ['precheck','race','close-error','missing','disconnect','readiness'])test('actual parent independently cleans '+mode+' while retaining refusal',async()=>{
 const c=childStub(mode);let owner,error;try{owner=await ownServerProcess(c,{completion:true,timeout:5});await owner.close();}catch(e){error=e;}
 assert(error);assert(c.exitCode!==null||c.signalCode!==null,'Own process physically ended');const lifecycle=owner?.lifecycle??error.lifecycle;assert(lifecycle.errors.length);if(mode!=='readiness')assert.equal(c.requests.filter(m=>m.type==='completion-close'&&m.cleanupOnly).length,mode==='close-error'?0:1);
});
for(const stage of ['font','guard','issuer','listeners'])test('actual setup acquisition closes owned child and context after '+stage+' rejection',async()=>{
 let c;const seen=[];await assert.rejects(()=>acquireOwnedSetup([['context',async()=>({}),async()=>{seen.push('context');}],['server',()=>ownServerProcess(c=childStub('normal'),{completion:true,timeout:5}),async s=>{seen.push('server');await s.close({cleanupOnly:true});}],[stage,async()=>{throw Error(stage);}]]),/setup/);assert.deepEqual(seen,['server','context']);assert.equal(c.exitCode,0);
});
test('setup preserves primary and independent later cleanup failures',async()=>{let caught;try{await acquireOwnedSetup([['one',async()=>1,async()=>{throw Error('cleanup one');}],['two',async()=>2,async()=>{throw Error('cleanup two');}],['reject',async()=>{throw Error('setup original');}]]);}catch(e){caught=e;}assert.equal(caught.primary.message,'setup original');assert.deepEqual(caught.cleanup.map(x=>x.error.message),['cleanup two','cleanup one']);});


// Exercise the real launch selection and environment construction. Only fork
// is replaced; readiness and cleanup use the actual owned-process helper.
import {readFileSync as readLaunchSource} from 'node:fs';
import {stripTypeScriptTypes as stripLaunchTypes} from 'node:module';
import {loadApplicationIdentity} from './application-identity.mjs';
import {loadHostIssuers} from './host-final-issuers.mjs';
const launchData=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
const forkURL=launchData('export const calls=[];let child;export const useChild=value=>{child=value;};export const fork=(...args)=>{calls.push(args);return child;};');
const launchFork=await import(forkURL);
const launchSource=stripLaunchTypes(readLaunchSource(new URL('../process.ts',import.meta.url),'utf8'),{mode:'strip'});
assert.equal(launchSource.split("'node:child_process'").length,2);assert.equal(launchSource.split("'./completion/owned-process.mjs'").length,2);
const launchModule=await import(launchData(launchSource.replace("'node:child_process'",JSON.stringify(forkURL)).replace("'./completion/owned-process.mjs'",JSON.stringify(new URL('./owned-process.mjs',import.meta.url).href))));
async function launchWithEnvironment(values,ledger){
 const names=['PATH','TMPDIR','COMPLETION_APPLICATION_IDENTITY','COMPLETION_ISSUER_MANIFEST','UNRELATED_PROVIDER_SECRET','NODE_OPTIONS'];
 const before=new Map(names.map(name=>[name,{present:Object.hasOwn(process.env,name),value:process.env[name]}]));let owner;
 try{
  for(const name of names)delete process.env[name];Object.assign(process.env,{PATH:'/fixture/toolchain',TMPDIR:'/fixture/tmp',UNRELATED_PROVIDER_SECRET:'test-only-not-a-credential',NODE_OPTIONS:'--trace-warnings'},values);
  const c=childStub('normal');launchFork.useChild(c);launchFork.calls.length=0;
  owner=await launchModule.serverProcess('/fixture/root',23,ledger);
  assert.equal(owner.pid,c.pid);assert.equal(owner.origin,'http://127.0.0.1:34567');assert.equal(launchFork.calls.length,1);
  const call=launchFork.calls[0],closing=owner;owner=undefined;await closing.close({cleanupOnly:true});assert.equal(c.exitCode,0);return call;
 }finally{
  try{if(owner)await owner.close({cleanupOnly:true});}finally{for(const [name,old]of before)if(old.present)process.env[name]=old.value;else delete process.env[name];}
 }
}
test('completion child receives only the two explicit current receipt paths with all launch guards intact',async()=>{
 const paths={COMPLETION_APPLICATION_IDENTITY:'/fixture/run/application-identity.json',COMPLETION_ISSUER_MANIFEST:'/fixture/run/host-final-issuers.json'};
 const [file,args,options]=await launchWithEnvironment(paths,'/fixture/run/ledger.jsonl');
 assert(file.endsWith('/tests/editor/process-completion-fixture.mjs'));
 assert.deepEqual(args,['/fixture/root',new URL('../../../dist/app',import.meta.url).pathname,'23','/fixture/run/ledger.jsonl']);
 assert.deepEqual(options.env,{PATH:'/fixture/toolchain',TMPDIR:'/fixture/tmp',...paths});
 assert.deepEqual(options.execArgv,['--import',new URL('../../protocol/no-effects.mjs',import.meta.url).pathname]);assert.deepEqual(options.stdio,['ignore','ignore','pipe','ipc']);
});
test('ordinary child keeps its original environment even when completion receipts are present',async()=>{
 const [file,args,options]=await launchWithEnvironment({COMPLETION_APPLICATION_IDENTITY:'/fixture/run/application-identity.json',COMPLETION_ISSUER_MANIFEST:'/fixture/run/host-final-issuers.json'});
 assert(file.endsWith('/tests/editor/process-fixture.mjs'));assert.deepEqual(args,['/fixture/root',new URL('../../../dist/app',import.meta.url).pathname,'23','']);
 assert.deepEqual(options.env,{PATH:'/fixture/toolchain',TMPDIR:'/fixture/tmp'});assert.deepEqual(options.execArgv,['--import',new URL('../../protocol/no-effects.mjs',import.meta.url).pathname]);assert.deepEqual(options.stdio,['ignore','ignore','pipe','ipc']);
 const [, , completion]=await launchWithEnvironment({},'/fixture/run/ledger.jsonl');assert.deepEqual(completion.env,{PATH:'/fixture/toolchain',TMPDIR:'/fixture/tmp'});
});
test('invalid explicit completion paths reach strict loaders without omission or fallback',async()=>{
 for(const value of ['', 'relative-receipt.json']){
  const [, , options]=await launchWithEnvironment({COMPLETION_APPLICATION_IDENTITY:value,COMPLETION_ISSUER_MANIFEST:value},'/fixture/run/ledger.jsonl');
  assert.equal(options.env.COMPLETION_APPLICATION_IDENTITY,value);assert.equal(options.env.COMPLETION_ISSUER_MANIFEST,value);
  let reads=0;const read=()=>{reads++;throw Error('No file should be selected');};
  assert.throws(()=>loadApplicationIdentity({env:options.env,read}),/explicit absolute file path/);assert.throws(()=>loadHostIssuers({env:options.env,read}),/absolute completion issuer manifest/);assert.equal(reads,0);
 }
 const paths={COMPLETION_APPLICATION_IDENTITY:'/fixture/missing-identity.json',COMPLETION_ISSUER_MANIFEST:'/fixture/missing-issuers.json'},[, , options]=await launchWithEnvironment(paths,'/fixture/run/ledger.jsonl'),selected=[];
 const missing=path=>{selected.push(path);throw Error('Explicit receipt missing');};
 assert.throws(()=>loadApplicationIdentity({env:options.env,read:missing}),/Explicit receipt missing/);assert.throws(()=>loadHostIssuers({env:options.env,read:missing}),/Explicit receipt missing/);
 assert.deepEqual(selected,Object.values(paths));
});
