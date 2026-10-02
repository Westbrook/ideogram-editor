import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {nativeOperation,qualifiedWasmAbort} from './operation.mjs';
import {completionMonitor} from './monitor.mjs';
import {sha,EXPECTED} from './app-buffer-core.mjs';
import {wireEpoch} from './wire.mjs';
import {monitorHarness} from './monitor-harness.mjs';
import {independentSteps,nativeTargetsDisposed,installBoundary} from './boundary.mjs';
const clone=structuredClone;
function fixture(kind='Preview'){
 const action={id:kind+'-fresh',kind,text:'Current literal',draftId:'draft',documentId:'document',documentRevision:'2',sessionId:'ui-session',generation:3,revision:'7',beforeReady:kind==='Apply',workerURL:'http://127.0.0.1:34567/worker.js'};
 const token={documentId:'document',documentRevision:'2',sessionId:'ui-session',generation:3,layerId:'layer',layerVersion:'1'},hash='sha256:'+'a'.repeat(64);
 const rows=[];const push=(kind,v={})=>rows.push({kind,epoch:'epoch',sequence:rows.length+1,actionId:action.id,...v});
 push('action-begin',{action});push('created',{workerId:1,url:action.workerURL,type:'module',name:'ideogram-text-1'});push('message',{workerId:1,workerAction:action.id,ready:true});push('post',{workerId:1,workerAction:action.id,token,text:action.text});push('post-return',{workerId:1});push('message',{workerId:1,workerAction:action.id,ok:true,token,rasterHash:hash,rgbaBytes:400,width:10,height:10});push('terminate',{workerId:1});push('terminate-return',{workerId:1});push('action-end');
 const source={render:{pixels:{hash}}},acceptedBefore={document:{id:'document',revision:'2'}};
 return {action,observation:{rows,epoch:'epoch',errors:[]},acceptedBefore,after:kind==='Preview'?{sameTextarea:true,connected:true,editable:true,ready:true,value:action.text,draftId:action.draftId,revision:action.revision}:{hidden:true},acceptedAfter:kind==='Preview'?clone(acceptedBefore):{document:{id:'document',revision:'3'},layer:{id:'layer'},source,text:action.text,pixelSHA256:hash,pixelBytes:400,commandSucceeded:true},...(kind==='Apply'?{priorPreview:{qualified:true,actionId:'Preview-fresh',draftId:action.draftId,revision:action.revision,rasterHash:hash,token},candidate:{token,source},command:{body:{type:'CommitTextEdit',layerId:'layer',draft:{sessionId:action.sessionId,draftId:action.draftId,generation:'3'}}}}:{})};
}
test('adopted helpers preserve original evidence and explicitly pin reviewed derivatives',()=>{
 const originalBytes=readFileSync(new URL('./adoption.json',import.meta.url)),a=JSON.parse(originalBytes),derivatives=JSON.parse(readFileSync(new URL('./adoption-derivatives.json',import.meta.url)));
 assert.equal(derivatives.schema,1);assert.equal(derivatives.originalAdoptionSHA256,sha(originalBytes));assert.equal(derivatives.priorCampaignQualificationInherited,false);
 assert.deepEqual(derivatives.files.map(file=>file.name).sort(),['app-buffer-core.mjs','completion-public.mjs']);
 for(const file of derivatives.files){const original=a.files.find(input=>input.name===file.name);assert(original);assert.equal(file.originalSHA256,original.sha256);assert.equal(sha(readFileSync(new URL(file.originalPath,import.meta.url))),original.sha256);assert(file.reason.length>0&&file.regressions.length>0);for(const regression of file.regressions)assert(readFileSync(new URL(regression,import.meta.url)).length>0);}
 for(const file of a.files){const derivative=derivatives.files.find(input=>input.name===file.name);assert.equal(sha(readFileSync(new URL(file.name,import.meta.url))),derivative?.sha256??file.sha256,'Adopted helper '+file.name);}
});
for(const kind of ['Preview','Apply']){
 test(kind+' requires its own fresh native result',()=>assert(nativeOperation(fixture(kind)).qualified));
 const changes={
  'observer loss':x=>x.observation.errors.push('lost'),
  'wrong epoch':x=>x.observation.rows[3].epoch='borrowed',
  'wrong action':x=>x.observation.rows[4].actionId='borrowed',
  'duplicate action':x=>x.observation.rows.push(clone(x.observation.rows[0])),
  'wrong worker':x=>x.observation.rows[5].workerId=2,
  'wrong worker URL':x=>x.observation.rows[1].url='other',
  'missing ready':x=>x.observation.rows[2].ready=false,
  'cancelled preparation':x=>x.observation.rows[4].kind='cancelled',
  'failed result':x=>x.observation.rows[5].ok=false,
  'wrong result token':x=>x.observation.rows[5].token={...x.observation.rows[5].token,generation:5},
  'wrong expected generation':x=>x.action.generation=5,
  'draft is not UI session':x=>x.action.draftId=x.action.sessionId,
  'wrong native text':x=>x.observation.rows[3].text='stale',
  'superseded input':x=>x.observation.rows[4].kind='native-input',
  'wrong original post owner':x=>x.observation.rows[3].workerAction='other',
  'wrong result owner':x=>x.observation.rows[5].workerAction='other',
  'malformed raster hash':x=>x.observation.rows[5].rasterHash='a'.repeat(64),
  'pixel dimensions mismatch':x=>x.observation.rows[5].rgbaBytes=404,
  'termination throws':x=>x.observation.rows[7].kind='terminate-error',
  'late success':x=>x.observation.rows.push({...clone(x.observation.rows[5]),sequence:10}),
  'recycled worker':x=>{x.observation.rows.push({...clone(x.observation.rows[1]),sequence:10});},
 };
 for(const [label,mutate]of Object.entries(changes))test(kind+' rejects '+label,()=>{const x=fixture(kind);mutate(x);assert.throws(()=>nativeOperation(x));});
}
for(const [label,mutate]of Object.entries({
 'old ready':x=>x.action.beforeReady=true,
 'disconnected native field':x=>x.after.connected=false,
 'changed revision':x=>x.after.revision='8',
 'changed accepted state':x=>x.acceptedAfter.document.revision='3',
 'own native command during Preview':x=>x.command={body:{}},
}))test('Preview rejects '+label,()=>{const x=fixture();mutate(x);assert.throws(()=>nativeOperation(x));});
for(const [label,mutate]of Object.entries({
 'missing prior explicit preview':x=>x.priorPreview=undefined,
 'same action pretending to be Preview and Apply':x=>x.priorPreview.actionId=x.action.id,
 'borrowed preview draft':x=>x.priorPreview.draftId='other',
 'stale preview revision':x=>x.priorPreview.revision='old',
 'preview raster differs':x=>x.priorPreview.rasterHash='sha256:'+'b'.repeat(64),
 'preview token differs':x=>x.priorPreview.token={...x.priorPreview.token,layerId:'other'},
 'native editor remains visible':x=>x.after.hidden=false,
 'wrong writer command':x=>x.command.body.type='Undo',
 'wrong candidate token':x=>x.candidate.token={...x.candidate.token,generation:99},
 'wrong command layer':x=>x.command.body.layerId='other',
 'wrong command draft':x=>x.command.body.draft.draftId='other',
 'wrong command generation':x=>x.command.body.draft.generation='99',
 'wrong accepted document':x=>x.acceptedAfter.document.id='other',
 'unchanged accepted revision':x=>x.acceptedAfter.document.revision='2',
 'wrong accepted layer':x=>x.acceptedAfter.layer.id='other',
 'different accepted source':x=>x.acceptedAfter.source={other:true},
 'different accepted text':x=>x.acceptedAfter.text='old',
 'different accepted pixels':x=>x.acceptedAfter.pixelSHA256='other',
 'different pixel size':x=>x.acceptedAfter.pixelBytes=404,
 'unaccepted command receipt':x=>x.acceptedAfter.commandSucceeded=false,
}))test('Apply rejects '+label,()=>{const x=fixture('Apply');mutate(x);assert.throws(()=>nativeOperation(x));});

const mockedMonitor=monitorHarness;
test('actual monitor installs ordinary page collection and independently closes empty epoch',async()=>{const h=await mockedMonitor();await h.monitor.closeEpoch();await h.monitor.beforeNavigate();await h.pagehide();await h.monitor.detach();await h.monitor.finish(true);const r=JSON.parse(readFileSync(join(h.out,'wasm-completion.json')));assert(r.complete&&r.detach.passed);assert.equal(r.epochs[0].qualification,undefined);assert(!h.calls.some(c=>c.method==='Network.getResponseBody'||c.method==='Target.attachToTarget'||c.method==='Runtime.runIfWaitingForDebugger'));});
test('actual monitor failed epoch is sticky and cannot retry collection',async()=>{const h=await mockedMonitor();h.setSnapshot({epoch:'other',rows:[],errors:[]});await assert.rejects(()=>h.monitor.closeEpoch());const n=h.calls.length;await assert.rejects(()=>h.monitor.closeEpoch(),/[Pp]ermanent/);assert.equal(h.calls.length,n);await assert.rejects(()=>h.monitor.detach());await assert.rejects(()=>h.monitor.finish(true));});
test('actual monitor never promotes missing independent cleanup',async()=>{const h=await mockedMonitor();await h.monitor.closeEpoch();await assert.rejects(()=>h.monitor.detach());await assert.rejects(()=>h.monitor.finish(false),/cleanup/);});
test('resource-specific abort classification preserves every other error and missing proof',()=>{
 const event={channel:'requestfailed',requestId:7,url:'http://127.0.0.1:34567/engine.wasm',method:'GET',resourceType:'fetch',failure:{errorText:'net::ERR_ABORTED'},response:{requestId:7,url:'http://127.0.0.1:34567/engine.wasm',method:'GET',status:200,contentType:'application/wasm',contentLength:'4979358'}};
 const epochs=[{qualification:{qualified:true,cleanup:true,observedEOF:false},initial:{originals:[{q:{id:7,url:event.url,method:'GET',resourceType:'fetch'},t:{kind:'failed',failure:{errorText:'net::ERR_ABORTED'}}}]}}];assert(qualifiedWasmAbort(event,epochs));
 for(const mutate of [e=>e.channel='console',e=>e.failure.errorText='net::ERR_FAILED',e=>e.method='HEAD',e=>e.resourceType='script',e=>e.requestId=8,e=>e.url+='?other',e=>e.response=null,e=>e.response.requestId=8,e=>e.response.url+='?other',e=>e.response.method='POST',e=>e.response.status=404,e=>e.response.contentType='font/ttf',e=>e.response.contentLength='0']){const e=clone(event);mutate(e);assert.equal(qualifiedWasmAbort(e,epochs),false);}
 for(const mutate of [e=>e[0].qualification.qualified=false,e=>e[0].qualification.cleanup=false,e=>e[0].qualification.observedEOF=true,e=>e[0].initial.originals[0].t.kind='finished',e=>e[0].initial.originals[0].t.failure.errorText='other']){const e=clone(epochs);mutate(e);assert.equal(qualifiedWasmAbort(event,e),false);}
});
test('actual wire partition retains original local image records without inventing server requests',()=>{
 const origin='http://127.0.0.1:34567',url='blob:'+origin+'/image',q={id:1,url,method:'GET',resourceType:'image',originalRequestObject:true,frameExposure:{ownerPage:true},redirectedFrom:null,redirectedTo:null},p={requestId:1,url,status:200,originalRequestObject:true,originalPairConfirmed:true,fromServiceWorker:false,actualHeaders:{'content-type':'image/png'}},t={requestId:1,url,kind:'finished',originalRequestObject:true};
 const x={origin,requests:[q,{...q,id:2,url:origin+'/engine.wasm',resourceType:'fetch'}],responses:[p],terminals:[t],network:[{name:'Network.requestWillBeSent',params:{requestId:'image.1',request:{url}}},{name:'Network.responseReceived',params:{requestId:'image.1',response:{url,status:200,mimeType:'image/png'}}},{name:'Network.loadingFinished',params:{requestId:'image.1'}}]};const y=wireEpoch(x);assert.equal(y.localImages.length,1);assert.equal(y.requests.length,1);assert.equal(y.requests[0].id,2);assert.equal(y.network.length,0);
 for(const mutate of [v=>v.requests[0].resourceType='fetch',v=>v.requests[0].method='POST',v=>v.requests[0].originalRequestObject=false,v=>v.requests[0].frameExposure.ownerPage=false,v=>v.responses[0].originalPairConfirmed=false,v=>v.responses[0].status=404,v=>v.responses[0].actualHeaders['content-type']='application/wasm',v=>v.terminals[0].kind='failed',v=>v.terminals=[],v=>v.network[1].params.response.url+='?other',v=>v.network[2].name='Network.loadingFailed',v=>v.network.push({name:'Network.requestWillBeSentExtraInfo',params:{requestId:'image.1',headers:{accept:'application/wasm'}}})]){const v=clone(x);mutate(v);assert.throws(()=>wireEpoch(v));}
});

test('actual monitor retains a failed collection disable and refuses completion',async()=>{const h=await mockedMonitor();h.failDisable();await assert.rejects(()=>h.monitor.closeEpoch(),/disable failure/);const r=JSON.parse(readFileSync(join(h.out,'wasm-completion.json')));assert(r.epochs[0].collector.disableError);await assert.rejects(()=>h.monitor.detach());await assert.rejects(()=>h.monitor.finish(true));assert.equal(h.monitor.qualifies({}),false);});

test('actual monitor completes one original Preview with retained pagehide and independently verified cleanup',async()=>{const h=await mockedMonitor();await h.preview();await h.monitor.closeEpoch();await h.monitor.beforeNavigate();await h.pagehide();await h.monitor.detach();await h.monitor.finish(true);const r=h.record();assert(r.complete);assert(r.epochs[0].qualification.qualified);assert.equal(r.epochs[0].qualification.observedEOF,false);assert.equal(r.epochs[0].captures.captures.length,1);});
const lateMutations={
 'target parent':h=>h.rootSession.emit('Target.targetInfoChanged',{targetInfo:{...h.target('worker-1'),parentId:'other'}}),
 'target context':h=>h.rootSession.emit('Target.targetInfoChanged',{targetInfo:{...h.target('worker-1'),browserContextId:'other'}}),
 'extra target':h=>h.rootSession.emit('Target.targetCreated',{targetInfo:h.target('extra-target')}),
 'extra original Worker':h=>h.page.emit('worker',Object.assign(new EventEmitter(),{url:()=>h.target('x').url})),
 'extra request':h=>h.originalRequest('/extra-late'),
 'same-worker success':h=>h.realm.lastWorker.emit('message',{data:{ok:true,value:{rasterHash:'sha256:'+'b'.repeat(64)}}}),
 'same-worker error':h=>h.realm.lastWorker.emit('error',{message:'late native error'}),
 'native input':h=>h.nativeInput(),
};
for(const phase of ['body capture','after provisional close','pre-navigation gap','retained after navigation'])for(const [label,mutate]of Object.entries(lateMutations))test('actual monitor rejects '+label+' at '+phase+' permanently',async()=>{
 const h=await mockedMonitor();await h.preview();let failure;
 try{
  if(phase==='body capture')h.onCapture(()=>mutate(h));
  await h.monitor.closeEpoch();
  if(phase==='after provisional close')mutate(h);
  await h.monitor.beforeNavigate();
  if(phase==='pre-navigation gap')mutate(h);
  await h.pagehide();
  if(phase==='retained after navigation')mutate(h);
  await h.monitor.detach();await h.monitor.finish(true);
 }catch(e){failure=e;}
 assert(failure,'Late contradiction must fail the actual monitor');assert.equal(h.monitor.qualifies({}),false);
 await assert.rejects(()=>h.monitor.finish(true));assert.notEqual(h.record().complete,true);
});
for(const phase of ['during close','before navigation','after navigation'])for(const label of ['worker','target','request','input'])test('actual empty epoch rejects new '+label+' '+phase,async()=>{
 const h=await mockedMonitor();const mutate=()=>label==='worker'?h.page.emit('worker',Object.assign(new EventEmitter(),{url:()=>h.target('x').url})):label==='target'?h.rootSession.emit('Target.targetCreated',{targetInfo:h.target('extra')}):label==='request'?h.originalRequest('/late-empty'):h.nativeInput();
 let failed=false;try{if(phase==='during close')h.onDisable(mutate);await h.monitor.closeEpoch();if(phase==='before navigation')mutate();await h.monitor.beforeNavigate();await h.pagehide();if(phase==='after navigation')mutate();await h.monitor.detach();await h.monitor.finish(true);}catch{failed=true;}
 assert(failed);assert.notEqual(h.record().complete,true);await assert.rejects(()=>h.monitor.finish(true));
});
test('actual monitor requires original pagehide and lossless owned metadata',async()=>{for(const mode of ['missing hide','duplicate hide','lost row','wrong epoch']){const h=await mockedMonitor();await h.preview();await h.monitor.closeEpoch();await h.monitor.beforeNavigate();if(mode==='missing hide')await assert.rejects(()=>h.monitor.detach());else if(mode==='duplicate hide'){await h.pagehide();await assert.rejects(()=>h.pagehide(),/One original departure/);}else{if(mode==='lost row')h.realm.__integrationNativeCompletion.snapshot().rows.pop();else h.realm.__integrationNativeCompletion.snapshot().rows[0].epoch='other';await assert.rejects(()=>h.pagehide(),/snapshot unchanged/);}await assert.rejects(()=>h.monitor.finish(true));assert.notEqual(h.record().complete,true);}});
test('actual independent teardown detaches before storage closes the page and retains both failures',async()=>{const seen=[],failures=[];await independentSteps([['detach',async()=>{seen.push('detach');throw Error('own detach');}],['storage',async()=>{seen.push('storage');throw Error('own storage');}],['context',async()=>seen.push('context')]],failures);assert.deepEqual(seen,['detach','storage','context']);assert.deepEqual(failures.map(x=>x.phase),['detach','storage']);});
test('native target disposal ignores page closure while rejecting wrong missing duplicate and recycled worker targets',()=>{
 const owner={targetId:'page',frameId:'page',contextId:'context',origin:'http://127.0.0.1:34567'},info={type:'worker',targetId:'worker',parentId:'page',parentFrameId:'page',browserContextId:'context',url:owner.origin+EXPECTED.workerPath},workers=[{originalObject:true,closed:true,closeSameObject:true}],discovery=[{name:'Target.targetCreated',params:{targetInfo:info}},{name:'Target.targetDestroyed',params:{targetId:'probe-page'}},{name:'Target.targetDestroyed',params:{targetId:'worker'}}];const x={owner,workers,discovery};assert(nativeTargetsDisposed(x));const missing=clone(x);missing.discovery.pop();assert.equal(nativeTargetsDisposed(missing),false);
 for(const mutate of [v=>v.discovery[0].params.targetInfo.parentId='other',v=>v.discovery[0].params.targetInfo.parentFrameId='other',v=>v.discovery[0].params.targetInfo.browserContextId='other',v=>v.discovery[0].params.targetInfo.url+='?other',v=>v.discovery.push(clone(v.discovery[2])),v=>v.discovery.push(clone(v.discovery[0]))]){const v=clone(x);mutate(v);assert.throws(()=>nativeTargetsDisposed(v));}
});
test('exact owned storage probe partition cannot hide a WASM error or application request',()=>{
 const origin='http://127.0.0.1:34567',path='/__e1_storage_owned',url=origin+path,q={id:1,url,method:'GET',resourceType:'document',originalRequestObject:true,frameExposure:{ownerPage:false,ownerContext:true,pageId:2},redirectedFrom:null,redirectedTo:null},p={requestId:1,url,status:200,originalRequestObject:true,originalPairConfirmed:true,fromServiceWorker:false,actualHeaders:{'content-type':'text/html'}},t={requestId:1,url,kind:'finished',originalRequestObject:true};const x={origin,requests:[q],responses:[p],terminals:[t],network:[],server:[],storageProbePath:path};assert.equal(wireEpoch(x).storageProbes.length,1);assert.equal(wireEpoch(x).requests.length,0);
 for(const mutate of [v=>v.requests[0].method='POST',v=>v.requests[0].resourceType='fetch',v=>v.requests[0].frameExposure.ownerPage=true,v=>v.requests[0].frameExposure.ownerContext=false,v=>delete v.requests[0].frameExposure.pageId,v=>v.responses[0].originalPairConfirmed=false,v=>v.responses[0].actualHeaders['content-type']='application/wasm',v=>v.responses[0].status=500,v=>v.terminals[0].kind='failed',v=>v.server.push({kind:'request',url:path}),v=>v.network.push({name:'Network.requestWillBeSent',params:{requestId:'probe',request:{url}}})]){const v=clone(x);mutate(v);assert.throws(()=>wireEpoch(v));}const unknown=clone(x);unknown.storageProbePath='/different';assert.equal(wireEpoch(unknown).requests.length,1);assert.equal(wireEpoch(unknown).storageProbes.length,0);
});

// Exercise the real monitor guard through exact, scoped public-text fixture queries.
test('actual monitor admits native work only after the exact saved contentinfo text',async()=>{
 const h=await monitorHarness(),order=[];h.publicText.elsewhere.push('Unrelated status');
 h.onReadState(()=>{assert.deepEqual(h.textQueries[0],{scope:'contentinfo',text:'Accepted edits saved locally · Draft saved locally; not applied to the document',exact:true});order.push('saved-state');});
 await h.monitor.operation('Preview',async()=>{assert(order.length>0);order.push('native-work');await h.nativeSuccess();});
 assert.equal(order.at(-1),'saved-state');assert.equal(order.filter(step=>step==='native-work').length,1);assert.equal(h.record().epochs[0].operations[0].completed,true);
});
for(const [label,mutate] of Object.entries({
 'unsaved footer':h=>{h.publicText.contentinfo=['Accepted edits saved locally · Unsaved UI draft'];},
 'missing footer':h=>{h.publicText.contentinfo=[];},
 'saved phrase on another surface':h=>{h.publicText.contentinfo=['Accepted edits saved locally · Unsaved UI draft'];h.publicText.elsewhere=['Accepted edits saved locally · Draft saved locally; not applied to the document'];},
 'standalone draft fragment':h=>{h.publicText.contentinfo=['Draft saved locally; not applied to the document'];},
 'decorated saved footer':h=>{h.publicText.contentinfo=['Accepted edits saved locally · Draft saved locally; not applied to the document stale'];},
 'simultaneous unsaved indicator':h=>{h.publicText.elsewhere=['Unsaved UI draft'];},
}))test('actual monitor refuses '+label+' before saved-state or native work',async()=>{
 const h=await monitorHarness();mutate(h);let reads=0,work=0;h.onReadState(()=>reads++);
 await assert.rejects(()=>h.monitor.operation('Preview',async()=>{work++;await h.nativeSuccess();}),/text fixture/);
 assert.equal(reads,0);assert.equal(work,0);h.monitor.save();assert.deepEqual(h.record().epochs[0].operations,[]);assert.deepEqual(h.record().epochs[0].proofs,[]);
});
