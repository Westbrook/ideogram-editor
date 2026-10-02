// Authored source fixtures; execution belongs to the coordinated gate owner.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {transformWithOxc} from 'vite';
import {Signal} from 'signal-polyfill';
import {allocationsURL as allocationURL} from '../owned-preview-module.mjs';
const root=process.env.STATE_CONTROL_ROOT??'.',resultsRoot=process.env.CLIENT_CONTROL_ROOT??'.';
const data=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64');
async function source(path,imports={}){let code=(await transformWithOxc(await readFile(path,'utf8'),path)).code;for(const [name,url]of Object.entries(imports))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));return data(code);}
const promptURL=await source('src/observability/prompt-memory.ts',{'./allocations.js':allocationURL}),memoryURL=await source('src/observability/model-memory.ts',{'./allocations.js':allocationURL,'./prompt-memory.js':promptURL}),controlURL=await source('src/state/control-memory.ts',{'../observability/allocations.js':allocationURL}),jsonURL=await source('src/protocol/json.ts'),shaURL=await source('src/protocol/sha256.ts');
const resultsURL=await source(resultsRoot+'/src/state/command-results.ts',{'../observability/allocations.js':allocationURL,'../observability/model-memory.js':memoryURL,'../observability/prompt-memory.js':promptURL,'./control-memory.js':controlURL,'../protocol/json.js':jsonURL,'../protocol/sha256.js':shaURL,'../protocol/validate.js':pathToFileURL(resolve('dist/local/src/protocol/validate.js')).href});
const imports={'../observability/allocations.js':allocationURL,'../observability/model-memory.js':memoryURL,'../observability/prompt-memory.js':promptURL,'./control-memory.js':controlURL,'./command-results.js':resultsURL};
const valuesURL=await source(root+'/src/state/draft-values.ts',imports);
const draftURL=await source(root+'/src/state/draft-persistence.ts',{...imports,'./draft-values.js':valuesURL}),sessionURL=await source(root+'/src/state/session-client.ts',{...imports,'@en-reve/primitives/state/value.js':import.meta.resolve('@en-reve/primitives/state/value.js')});
const {DraftPersistence}=await import(draftURL),{createSessionClient}=await import(sessionURL),{allocationLedger,ALLOCATION_LIMITS}=await import(allocationURL),{ControlAdmissionError}=await import(controlURL);
const totals=()=>{const s=allocationLedger.snapshot();return {cpu:s.cpuBytes,handles:s.handles,records:s.activeRecords};},flush=async()=>{for(let i=0;i<80;i++)await Promise.resolve();},deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const response=value=>{const body=JSON.stringify(value);return new Response(body,{headers:{'content-type':'application/json','content-length':String(Buffer.byteLength(body))}});};
const checkpoint=(seq='1')=>({sessionId:'session',uiSeq:seq,preferences:{documentId:'document',tool:'select',viewport:{x:0,y:0,zoom:1},panels:{left:280,right:320,active:'layers'},selectedLayerIds:[]},drafts:[],reconciledLayerIds:[]});
const receipt=(id='request')=>({protocolVersion:1,requestId:id,status:'accepted',uiSeq:'2',reason:null});
const request=()=>({protocolVersion:1,requestId:'request',sessionId:'session',expectedUISeq:'1',body:{type:'FocusRequested',target:'canvas',generation:'1'}});
const local=text=>({id:'draft',kind:'prompt',documentId:'document',targetLayerId:null,expectedDocumentRevision:'1',composing:false,text});

test('checkpoint replacement retains actual borrowed root until final explicit pin release',async()=>{const baseline=totals(),owner=new DraftPersistence('session',async()=>response(checkpoint()),()=> 'csrf');let borrow;try{await owner.restore();borrow=owner.borrowCheckpoint();const first=borrow.value;owner.checkpoint=checkpoint('2');assert.notEqual(owner.checkpoint,first);await owner.dispose();assert.equal(borrow.value.uiSeq,'1');assert(totals().cpu>baseline.cpu);borrow.release();assert.deepEqual(totals(),baseline);}finally{borrow?.release();await owner.dispose();}});
test('oversized prospective checkpoint replacement refuses before changing previous root',async()=>{const baseline=totals(),owner=new DraftPersistence('session',async()=>response(checkpoint()),()=> 'csrf');try{await owner.restore();const prior=owner.checkpoint;assert.throws(()=>{owner.checkpoint={...checkpoint('2'),reconciledLayerIds:['x'.repeat(65536)]};},error=>error instanceof ControlAdmissionError&&error.reason==='size'&&error.limit===65536);assert.equal(owner.checkpoint,prior);}finally{await owner.dispose();}assert.deepEqual(totals(),baseline);});
test('late checkpoint response cannot overwrite a newer restore',async()=>{const baseline=totals(),gate=deferred();let calls=0;const owner=new DraftPersistence('session',async()=>{if(++calls===1){await gate.promise;return response(checkpoint('1'));}return response(checkpoint('2'));},()=> 'csrf');const earlier=owner.restore();void earlier.catch(()=>{});try{await flush();await owner.restore();gate.resolve();await earlier.catch(()=>{});assert.equal(owner.checkpoint.uiSeq,'2');}finally{gate.resolve();await earlier.catch(()=>{});await owner.dispose();}assert.deepEqual(totals(),baseline);});
test('owned receipt survives its draft owner disposal through its actual caller pin',async()=>{const baseline=totals(),owner=new DraftPersistence('session',async()=>response(receipt()),()=> 'csrf'),input=request();let result,pin;try{owner.checkpoint=checkpoint();result=await owner.ownedDispatch(input);pin=result.pin();result.release();await owner.dispose();assert.equal(result.value.requestId,'request');assert(totals().cpu>baseline.cpu);pin();assert.deepEqual(totals(),baseline);}finally{pin?.();result?.release();await owner.dispose();}});
test('dispatch owns immutable wire before first journal await and releases every temporary root',async()=>{const baseline=totals(),gate=deferred(),recorded=[];let sent;const journal={async put(_key,value){recorded.push(structuredClone(value));if(recorded.length===1)await gate.promise;},async scan(){}},owner=new DraftPersistence('session',async(_path,init)=>{sent=JSON.parse(init.body);return response(receipt());},()=> 'csrf',journal),input=request();const pending=owner.ownedDispatch(input);void pending.catch(()=>{});let result;try{input.body.target='history';await flush();gate.resolve();result=await pending;assert.equal(sent.body.target,'canvas');assert.equal(recorded[0].request.body.target,'canvas');assert.equal(recorded[1].done,true);}finally{gate.resolve();result?.release();await pending.catch(()=>{});await owner.dispose();}assert.deepEqual(totals(),baseline);});
test('save pins the exact original text while replacement and disposal await preparation',async()=>{const baseline=totals(),gate=deferred(),owner=new DraftPersistence('session',async()=>response(receipt()),()=> 'csrf');owner.checkpoint=checkpoint();owner.change(local('original'));let seen;const pending=owner.ownedSave('draft',async text=>{seen=text;await gate.promise;return 'caption';});let done=false;try{await flush();owner.change(local('replacement'));const drain=owner.dispose().then(()=>{done=true;});await flush();assert.equal(done,false);assert.equal(seen,'original');assert(totals().cpu>baseline.cpu);gate.resolve();assert.equal(await pending,undefined);await drain;}finally{gate.resolve();const result=await pending.catch(()=>undefined);result?.release();await owner.dispose();}assert.deepEqual(totals(),baseline);});
test('real failed reader unlock remains charged through repeated draft disposal and drains on retry',async()=>{const baseline=totals(),bodyText=JSON.stringify(checkpoint()),body=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(bodyText));c.close();}}),native=body.getReader.bind(body);let refuse=true;body.getReader=()=>{const reader=native();return {get closed(){return reader.closed;},read:()=>reader.read(),cancel:()=>reader.cancel(),releaseLock(){if(refuse)throw Error('unlock refused');reader.releaseLock();}};};const owner=new DraftPersistence('session',async()=>new Response(body,{headers:{'content-length':String(Buffer.byteLength(bodyText))}}),()=> 'csrf');try{await assert.rejects(owner.restore());for(let n=0;n<3;n++){await assert.rejects(owner.dispose(),/CLEANUP/);assert.equal(owner.ownership.controlCleanupFailures,1);}assert.equal(body.locked,true);assert(totals().handles>baseline.handles);refuse=false;await owner.dispose();assert.equal(body.locked,false);}finally{refuse=false;await owner.dispose();}assert.deepEqual(totals(),baseline);});
test('initial pressure rejects dispatch before journaling or fetching',async()=>{const baseline=totals();let called=false;const owner=new DraftPersistence('session',async()=>{called=true;return response(receipt());},()=> 'csrf',{async put(){called=true;},async scan(){}}),held=allocationLedger.reserve({owner:'state-test-pressure',kind:'control',cpuBytes:ALLOCATION_LIMITS.cpuBytes-ALLOCATION_LIMITS.textPartitionBytes-baseline.cpu});try{assert.throws(()=>owner.ownedDispatch(request()),/ALLOCATION_BUDGET/);assert.equal(called,false);assert.equal(owner.hasPendingRequests,false);}finally{held.release();await owner.dispose();}assert.deepEqual(totals(),baseline);});
test('session capability render pin preserves previous actual response root through renewal and disposal',async()=>{const baseline=totals(),originalFetch=globalThis.fetch;let generation=0;const client=createSessionClient();let pin;globalThis.fetch=async url=>String(url).endsWith('/capabilities')?response({protocolVersion:1,limits:[],profiles:[{name:String(generation)}]}):response({protocolVersion:1,clientId:'client',csrfToken:'secret',sessionExpiresAt:'2099-01-01T00:00:00.000Z',idleExpiresAt:'2099-01-01T00:00:00.000Z'});try{await client.resume();const old=client.state.value.get().capabilities;pin=client.renderCapabilities(old)[0].pin();generation++;await client.renew();assert.notEqual(client.state.value.get().capabilities,old);await client.dispose();assert.equal(old.profiles[0].name,'0');assert(totals().cpu>baseline.cpu);pin();assert.deepEqual(totals(),baseline);}finally{pin?.();await client.dispose();globalThis.fetch=originalFetch;}});

const sessionValue=id=>({protocolVersion:1,clientId:id,csrfToken:'csrf_'+id,sessionExpiresAt:'2099-01-01T00:00:00.000Z',idleExpiresAt:'2099-01-01T00:00:00.000Z'});
const capabilitiesValue=name=>({protocolVersion:1,limits:[],profiles:[{name}]});
test('interrupted session bootstrap shares disposal and releases its full action before same-client resume',{timeout:10000},async()=>{
 const baseline=totals(),originalFetch=globalThis.fetch,entered=deferred(),cancelling=deferred(),cancelGate=deferred(),calls=[],client=createSessionClient();let cancels=0,old,drain;
 const body=new ReadableStream({pull(){entered.resolve();},cancel(){cancels++;cancelling.resolve();return cancelGate.promise;}},{highWaterMark:0});
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});if(calls.length===1)return new Response(body,{headers:{'content-length':'1'}});return String(url).endsWith('/capabilities')?response(capabilitiesValue('resumed')):response(sessionValue('resumed'));};
 try{
  old=client.start('one-use-pairing-token');void old.catch(()=>{});await entered.promise;
  assert.equal(client.state.value.get().busy,true);assert.equal(calls[0].init.method,'POST');assert.equal(JSON.parse(calls[0].init.body).pairingToken,'one-use-pairing-token');
  drain=client.dispose();assert.equal(client.dispose(),drain);let finished=false;void drain.then(()=>{finished=true;},()=>{finished=true;});
  assert.equal(client.identity(),null);assert.equal(client.csrf(),'');assert.equal(client.state.value.get().busy,false);assert.equal(calls[0].init.signal.aborted,true);
  await cancelling.promise;await flush();assert.equal(finished,false);assert.equal(body.locked,true);assert(totals().handles>baseline.handles);
  cancelGate.resolve();await drain;
  assert.deepEqual(totals(),baseline,'Disposal includes the bootstrap wire and outer action cleanup');
  assert.equal(body.locked,false);assert.equal(cancels,1);await old;
  await client.resume();assert.equal(client.state.value.get().connection,'paired');assert.equal(client.state.value.get().busy,false);assert.equal(client.identity(),'resumed');
  assert.deepEqual(calls.map(call=>call.url),['/api/v1/session/bootstrap','/api/v1/session','/api/v1/capabilities']);assert.equal(calls[1].init.method,'GET');
 }finally{cancelGate.resolve();try{await client.dispose();await old?.catch(()=>{});await drain?.catch(()=>{});}finally{globalThis.fetch=originalFetch;}}
 assert.deepEqual(totals(),baseline);
});
test('session resume waits the old capabilities drain and its completion cannot clear the new action',{timeout:10000},async()=>{
 const baseline=totals(),originalFetch=globalThis.fetch,oldEntered=deferred(),cancelling=deferred(),cancelGate=deferred(),newEntered=deferred(),calls=[],client=createSessionClient();let sessionCalls=0,capabilityCalls=0,newController,old,queued,drain,newFinished=false;
 const oldBody=new ReadableStream({pull(){oldEntered.resolve();},cancel(){cancelling.resolve();return cancelGate.promise;}},{highWaterMark:0});
 const freshBytes=new TextEncoder().encode(JSON.stringify(capabilitiesValue('fresh'))),newBody=new ReadableStream({start(controller){newController=controller;},pull(){newEntered.resolve();}},{highWaterMark:0});
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});if(String(url).endsWith('/session'))return response(sessionValue(++sessionCalls===1?'old':'fresh'));return ++capabilityCalls===1?new Response(oldBody,{headers:{'content-length':'1'}}):new Response(newBody,{headers:{'content-length':String(freshBytes.length)}});};
 try{
  old=client.resume();void old.catch(()=>{});await oldEntered.promise;assert.equal(client.identity(),'old');assert.equal(client.csrf(),'csrf_old');
  drain=client.dispose();assert.equal(client.identity(),null);assert.equal(client.csrf(),'');assert.equal(client.state.value.get().capabilities,null);assert.equal(client.state.value.get().busy,false);
  queued=client.resume();void queued.then(()=>{newFinished=true;},()=>{newFinished=true;});await cancelling.promise;await flush();
  assert.equal(newFinished,false);assert.equal(calls.length,2);assert.equal(oldBody.locked,true);
  cancelGate.resolve();await drain;await old;await newEntered.promise;
  assert.equal(oldBody.locked,false);assert.equal(client.identity(),'fresh');assert.equal(client.csrf(),'csrf_fresh');assert.equal(client.state.value.get().busy,true);assert.equal(client.state.value.get().capabilities,null);assert.equal(client.ownership.controlReads,1);
  newController.enqueue(freshBytes);newController.close();await queued;
  assert.equal(client.state.value.get().connection,'paired');assert.equal(client.state.value.get().busy,false);assert.equal(client.state.value.get().capabilities.profiles[0].name,'fresh');assert.equal(sessionCalls,2);assert.equal(capabilityCalls,2);
 }finally{cancelGate.resolve();try{await drain?.catch(()=>{});await client.dispose();await old?.catch(()=>{});await queued?.catch(()=>{});}finally{globalThis.fetch=originalFetch;}}
 assert.deepEqual(totals(),baseline);
});
test('failed session reader cleanup blocks resume until an explicit successful disposal retry',{timeout:10000},async()=>{
 const baseline=totals(),originalFetch=globalThis.fetch,client=createSessionClient(),text=JSON.stringify(sessionValue('broken'));let refuse=true,calls=0,unlocks=0,failure;
 const body=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(text));controller.close();}}),native=body.getReader.bind(body);
 body.getReader=()=>{const reader=native();return {get closed(){return reader.closed;},read:()=>reader.read(),cancel:()=>reader.cancel(),releaseLock(){unlocks++;if(refuse)throw Error('session unlock refused');reader.releaseLock();}};};
 globalThis.fetch=async url=>{if(++calls===1)return new Response(body,{headers:{'content-length':String(Buffer.byteLength(text))}});return String(url).endsWith('/capabilities')?response(capabilitiesValue('retry')):response(sessionValue('retry'));};
 try{
  await client.resume();assert.equal(body.locked,true);assert.equal(client.ownership.controlCleanupFailures,1);
  const first=client.dispose();assert.equal(client.dispose(),first);await assert.rejects(first,error=>{failure=error;return error instanceof AggregateError&&error.message==='SESSION_RELEASE_INCOMPLETE';});
  assert.equal(body.locked,true);assert.equal(client.ownership.controlCleanupFailures,1);assert(totals().handles>baseline.handles);const attempts=unlocks;
  refuse=false;await assert.rejects(client.resume(),error=>error===failure);assert.equal(calls,1);assert.equal(unlocks,attempts);assert.equal(body.locked,true);
  const retry=client.dispose();assert.notEqual(retry,first);assert.equal(client.dispose(),retry);await retry;
  assert.equal(body.locked,false);assert.equal(client.ownership.controlCleanupFailures,0);assert.deepEqual(totals(),baseline);
  await client.resume();assert.equal(client.identity(),'retry');assert.equal(client.state.value.get().connection,'paired');assert.equal(client.state.value.get().busy,false);
 }finally{refuse=false;try{await client.dispose();}finally{globalThis.fetch=originalFetch;}}
 assert.deepEqual(totals(),baseline);
});
test('session disposal still drains reads and retains the capability owner when state publication throws',{timeout:10000},async()=>{
 const baseline=totals(),originalFetch=globalThis.fetch,client=createSessionClient(),publishFailure=Error('session state publication failed');let calls=0,originalSet,failure;
 globalThis.fetch=async url=>{calls++;return String(url).endsWith('/capabilities')?response(capabilitiesValue('held')):response(sessionValue('held'));};
 try{
  await client.resume();originalSet=client.state.set;client.state.set=()=>{throw publishFailure;};
  const drain=client.dispose();assert.equal(client.dispose(),drain);assert.equal(client.identity(),null);assert.equal(client.csrf(),'');
  await assert.rejects(drain,error=>{failure=error;return error instanceof AggregateError&&error.errors.includes(publishFailure);});
  assert.equal(client.ownership.controlReads,0);assert.equal(client.ownership.sessionModels,1);assert(totals().cpu>baseline.cpu);const priorCalls=calls;
  await assert.rejects(client.resume(),error=>error===failure);assert.equal(calls,priorCalls);
  client.state.set=originalSet;await client.dispose();assert.equal(client.ownership.sessionModels,0);assert.equal(client.state.value.get().connection,'offline');assert.equal(client.state.value.get().busy,false);assert.deepEqual(totals(),baseline);
 }finally{if(originalSet)client.state.set=originalSet;try{await client.dispose();}finally{globalThis.fetch=originalFetch;}}
});

test('real signal busy notification schedules disposal after notify and drains the admitted action',{timeout:10000},async()=>{
 const baseline=totals(),originalFetch=globalThis.fetch,client=createSessionClient(),scheduled=deferred(),phases=[];let calls=0,notified=0,inNotify=false,outsideNotify=false,drain,old,oldFinished=false;
 // Watcher notify schedules work only. Reading or mutating signals belongs
 // to the deferred callback, after the library's notification phase ends.
 const watcher=new Signal.subtle.Watcher(()=>{inNotify=true;notified++;phases.push('notify');queueMicrotask(()=>{try{outsideNotify=!inNotify;phases.push('dispose');drain=client.dispose();void drain.catch(()=>{});scheduled.resolve();}catch(error){scheduled.reject(error);}});inNotify=false;});
 globalThis.fetch=async url=>{calls++;return String(url).endsWith('/capabilities')?response(capabilitiesValue('retry')):response(sessionValue('retry'));};
 try{
  client.state.value.get();watcher.watch(client.state.value);
  old=client.start('interrupted-bootstrap');void old.then(()=>{oldFinished=true;},()=>{oldFinished=true;});
  assert.equal(notified,1);assert.deepEqual(phases,['notify']);assert.equal(drain,undefined);assert.equal(client.state.value.get().busy,true);assert.equal(client.ownership.controlReads,1);assert(totals().cpu>baseline.cpu);
  await scheduled.promise;assert.equal(outsideNotify,true);assert.deepEqual(phases,['notify','dispose']);assert(drain);assert.equal(client.dispose(),drain);
  await drain;assert.equal(oldFinished,true,'Disposal waits the whole action admitted before busy publication');await old;
  assert.equal(client.identity(),null);assert.equal(client.csrf(),'');assert.equal(client.state.value.get().busy,false);assert.equal(client.ownership.controlReads,0);assert.equal(client.ownership.sessionModels,0);assert.deepEqual(totals(),baseline);
  const interruptedCalls=calls;assert(interruptedCalls<=1,'A deferred interruption may enter the original session transport once');
  watcher.unwatch(client.state.value);await client.resume();assert.equal(client.identity(),'retry');assert.equal(client.state.value.get().connection,'paired');assert.equal(calls,interruptedCalls+2);
 }finally{watcher.unwatch(client.state.value);try{await client.dispose();await old?.catch(()=>{});await drain?.catch(()=>{});}finally{globalThis.fetch=originalFetch;}}
 assert.deepEqual(totals(),baseline);
});
test('real signal paired notification defers disposal and preserves the actual caller capability pin',{timeout:10000},async()=>{
 const baseline=totals(),originalFetch=globalThis.fetch,client=createSessionClient(),scheduled=deferred(),phases=[];let calls=0,notified=0,inNotify=false,outsideNotify=false,arm=true,drain,old,visible,pin;
 const watcher=new Signal.subtle.Watcher(()=>{inNotify=true;notified++;phases.push('notify');queueMicrotask(()=>{try{outsideNotify=!inNotify;phases.push('dispose');visible=client.state.value.get().capabilities;pin=client.renderCapabilities(visible)[0].pin();drain=client.dispose();void drain.catch(()=>{});scheduled.resolve();}catch(error){scheduled.reject(error);}});inNotify=false;});
 globalThis.fetch=async url=>{calls++;if(String(url).endsWith('/capabilities')){if(arm){arm=false;client.state.value.get();watcher.watch(client.state.value);}return response(capabilitiesValue('visible'));}return response(sessionValue('visible'));};
 try{
  old=client.resume();void old.catch(()=>{});await scheduled.promise;
  assert.equal(notified,1);assert.equal(outsideNotify,true);assert.deepEqual(phases,['notify','dispose']);assert(drain);assert.equal(client.dispose(),drain);assert.equal(visible.profiles[0].name,'visible');
  await drain;await old;assert.equal(calls,2);assert.equal(client.identity(),null);assert.equal(client.csrf(),'');assert.equal(client.state.value.get().connection,'offline');assert.equal(client.state.value.get().capabilities,null);assert.equal(client.state.value.get().busy,false);assert.equal(client.ownership.controlReads,0);assert.equal(client.ownership.sessionModels,0);
  assert(totals().cpu>baseline.cpu,'The real caller pin keeps the capability root charged after disposal');assert.equal(visible.profiles[0].name,'visible');pin();pin=undefined;assert.deepEqual(totals(),baseline);
  watcher.unwatch(client.state.value);await client.resume();assert.equal(client.identity(),'visible');assert.equal(client.state.value.get().connection,'paired');assert.equal(client.state.value.get().capabilities.profiles[0].name,'visible');assert.equal(calls,4);
 }finally{watcher.unwatch(client.state.value);pin?.();try{await client.dispose();await old?.catch(()=>{});await drain?.catch(()=>{});}finally{globalThis.fetch=originalFetch;}}
 assert.deepEqual(totals(),baseline);
});
test('wrapped paired setter can dispose reentrantly without installing a capability owner after cleanup',{timeout:10000},async()=>{
 const baseline=totals(),originalFetch=globalThis.fetch,client=createSessionClient(),originalSet=client.state.set;let armed=true,drain,old;
 // This explicit setter seam permits reentrancy after the real publication;
 // unlike Signal notify, it is outside the library's notification phase.
 client.state.set=next=>{const changed=originalSet(next);if(armed&&next.connection==='paired'){armed=false;drain=client.dispose();void drain.catch(()=>{});}return changed;};
 globalThis.fetch=async url=>String(url).endsWith('/capabilities')?response(capabilitiesValue('paired')):response(sessionValue('paired'));
 try{
  old=client.resume();void old.catch(()=>{});await old;assert(drain);await drain;
  assert.equal(client.identity(),null);assert.equal(client.csrf(),'');assert.equal(client.state.value.get().connection,'offline');assert.equal(client.state.value.get().busy,false);assert.equal(client.state.value.get().capabilities,null);assert.equal(client.ownership.sessionModels,0);assert.equal(client.ownership.controlReads,0);assert.deepEqual(totals(),baseline);
  client.state.set=originalSet;await client.resume();assert.equal(client.identity(),'paired');assert.equal(client.state.value.get().connection,'paired');
 }finally{client.state.set=originalSet;try{await client.dispose();await old?.catch(()=>{});await drain?.catch(()=>{});}finally{globalThis.fetch=originalFetch;}}
 assert.deepEqual(totals(),baseline);
});
test('failed paired publication retains previous and prospective capability roots until explicit disposal',{timeout:10000},async()=>{
 const baseline=totals(),originalFetch=globalThis.fetch,client=createSessionClient(),originalSet=client.state.set,publishFailure=Error('paired setter refused completion');let calls=0,version=0,oldPin,newPin;
 globalThis.fetch=async url=>{calls++;return String(url).endsWith('/capabilities')?response(capabilitiesValue(String(version))):response(sessionValue('owner'+version));};
 try{
  await client.resume();const prior=client.state.value.get().capabilities;version++;
  client.state.set=next=>{const changed=originalSet(next);if(next.connection==='paired'&&next.capabilities?.profiles[0].name==='1'&&next.busy)throw publishFailure;return changed;};
  await assert.rejects(client.renew(),error=>error===publishFailure);
  const next=client.state.value.get().capabilities;assert.notEqual(next,prior);assert.equal(next.profiles[0].name,'1');assert.equal(client.identity(),null);assert.equal(client.ownership.sessionModels,2);
  oldPin=client.renderCapabilities(prior)[0].pin();newPin=client.renderCapabilities(next)[0].pin();oldPin();newPin();oldPin=newPin=undefined;
  const priorCalls=calls;await assert.rejects(client.resume(),error=>error===publishFailure);assert.equal(calls,priorCalls);assert.equal(client.ownership.sessionModels,2);
  client.state.set=originalSet;await client.dispose();assert.equal(client.state.value.get().capabilities,null);assert.equal(client.ownership.sessionModels,0);assert.deepEqual(totals(),baseline);
 }finally{client.state.set=originalSet;oldPin?.();newPin?.();try{await client.dispose();}finally{globalThis.fetch=originalFetch;}}
});
