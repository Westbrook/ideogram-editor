import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {monitorHarness} from './monitor-harness.mjs';
import {injectedHostFinal,hostFixture} from './host-final-fixtures.mjs';
import {privateServerRows} from './header-fixtures.mjs';
import {EXPECTED} from './app-buffer-core.mjs';
import {RESTORED_MODE,restoredNative,refuseRestoredNative,restoredNodeNativeHeaders} from './restored-native.mjs';
import {restoredRouteFlow} from './restored-route-flow.mjs';
import {restoredRoutes,validRestoredReadPath} from './restored-route.mjs';
const path='/api/v1/assets/image/content',pattern='**'+path;
test('restored ancillary admission keeps explicit original-channel ordering and no collector',async()=>{const h=await monitorHarness({mode:RESTORED_MODE,fixture:'restored-reads'});h.monitor.save();const e=h.record().epochs[0];assert.equal(e.ancillaryAdmission.owner.origin,h.server.origin);assert.equal(e.ancillaryFrame.loaderId,'document-loader-1');assert.equal(e.collector,undefined);const s=readFileSync('tests/editor/completion/monitor.mjs','utf8');assert(s.indexOf('restoredOriginalChannels({origin:e.origin')<s.indexOf('const ancillary=accountFavicon('));});
const close=async h=>{await h.monitor.closeEpoch();await h.monitor.beforeNavigate();await h.monitor.depart('restart');await h.monitor.beforeServerStop();};
async function setup({preactivation=false,readPath=path}={}){const h=await monitorHarness({mode:RESTORED_MODE,fixture:'restored-reads'});h.originalRequest('/');const registration=h.monitor.restoredRoute('**'+readPath,readPath);registration.registered();await close(h);await h.nextEpoch({activate:!preactivation});return {h,registration};}
async function forward(h,registration,{reject=false,readPath=path}={}){const q=h.originalRequest(readPath),calls=[];const route={request:()=>q,continue:async(...args)=>{calls.push(args);if(reject)throw Error('original forward rejected');}};const receipt=registration.hold(route);return {q,route,receipt,calls};}
async function finish(h,registration,held){held.receipt.release();await held.receipt.continue();registration.removing();registration.removed();registration.confirmedRestoration();await close(h);await h.monitor.detach();await h.monitor.finish(true);return h.record();}
for(const preactivation of [false,true])test('actual restored monitor: original route '+(preactivation?'before':'after')+' activation',async()=>{const {h,registration}=await setup({preactivation});const held=await forward(h,registration);if(preactivation)await h.monitor.activate();const result=await finish(h,registration,held);assert(result.complete);assert.equal(result.epochs.length,2);assert.equal(result.routes[0].arrivalActivated,!preactivation);assert.deepEqual(held.calls,[[]]);for(const e of result.epochs){assert.equal(e.collector,undefined);assert.equal(e.qualification,undefined);for(const k of ['qualified','nativeQualified','wasmQualified','byteQualified','transportQualified','observedEOF'])assert.equal(e.restoredNative[k],false);}assert(!h.calls.some(c=>['Network.getResponseBody','Network.configureDurableMessages'].includes(c.method)));assert.equal(h.monitor.qualifies({}),false);});
test('actual restored monitor retains differing provisional and wire headers',async()=>{const {h,registration}=await setup(),held=await forward(h,registration);const serverRow=h.serverRows.find(r=>r.kind==='request');serverRow.headers={...serverRow.headers,'sec-fetch-site':'same-origin'};h.saveLedger();const r=await finish(h,registration,held);assert.equal(r.epochs[1].restoredNative.transportQualified,false);assert.equal(r.requests.find(q=>q.id===held.q.testId).actualHeaders['sec-fetch-site'],undefined);assert.equal(h.serverRows.find(r=>r.kind==='request').headers['sec-fetch-site'],'same-origin');});
for(const kind of ['native-operation','worker-object','worker-target','native-request','native-response','native-server','native-protocol','native-observer'])for(const late of [false,true])test('actual restored monitor refuses '+kind+(late?' after closure':' before closure'),async()=>{const {h,registration}=await setup(),held=await forward(h,registration);held.receipt.release();await held.receipt.continue();registration.removing();registration.removed();registration.confirmedRestoration();if(late)await h.monitor.closeEpoch();
 if(kind==='native-operation'){let ran=false;await assert.rejects(h.monitor.operation('Preview',async()=>{ran=true;}));assert.equal(ran,false);return;}
 if(kind==='worker-object')h.page.emit('worker',{url:()=>h.server.origin+'/foreign-worker.js'});
 if(kind==='worker-target')h.rootSession.emit('Target.targetCreated',{targetInfo:h.target('native-late')});
 if(kind==='native-request')h.originalRequest(EXPECTED.wasmPath);
 if(kind==='native-response')h.originalRequest('/other',{pwResponseHeaders:{'content-type':'application/wasm'}});
 if(kind==='native-server')h.originalRequest('/other',{nodeRequestHeaders:{'sec-fetch-dest':'worker'}});
 if(kind==='native-protocol')h.originalRequest('/other',{protocolResponseHeaders:{'content-type':'application/wasm'}});
 if(kind==='native-observer')h.nativeInput();
 const reasons={'worker-object':/forbids any Worker/,'worker-target':/forbids any worker/,'native-request':/forbids native requests/,'native-response':/forbids native responses/,'native-server':/forbids native server/,'native-protocol':/forbids native protocol/,'native-observer':/forbids native observer/};if(kind.startsWith('worker-')){await assert.rejects(late?h.monitor.beforeNavigate():h.monitor.closeEpoch(),/Permanent epoch failure/);h.monitor.save();assert.match(h.record().epochs.at(-1).failure,reasons[kind]);}else await assert.rejects(late?h.monitor.beforeNavigate():h.monitor.closeEpoch(),reasons[kind]);assert(!h.calls.some(c=>c.method==='Network.getResponseBody'));});
for(const defect of ['missing-response','missing-terminal','extra-image','duplicate-hold','no-release','no-forward','forward-failure','no-removal','early-forward','unactivated-release','foreign-registration','third-epoch','cleanup-failure','late-recorder'])test('actual restored route/monitor refuses '+defect,async()=>{
 const {h,registration}=await setup({preactivation:defect==='unactivated-release'});
 if(defect==='missing-response')h.context.removeAllListeners('response');if(defect==='missing-terminal')h.context.removeAllListeners('requestfinished');
 const held=await forward(h,registration,{reject:defect==='forward-failure'});
 if(defect==='duplicate-hold'){assert.throws(()=>registration.hold(held.route));return;}
 if(defect==='early-forward'){await assert.rejects(held.receipt.continue());return;}
 if(defect==='unactivated-release'){assert.throws(()=>held.receipt.release());return;}
 if(defect==='foreign-registration'){assert.throws(()=>h.monitor.restoredRoute(pattern,path));return;}
 if(defect==='no-release'||defect==='no-forward'){if(defect==='no-forward')held.receipt.release();await assert.rejects(h.monitor.closeEpoch());return;}
 if(defect==='forward-failure'){held.receipt.release();await assert.rejects(held.receipt.continue(),/original forward rejected/);await assert.rejects(h.monitor.closeEpoch());return;}
 held.receipt.release();await held.receipt.continue();if(defect!=='no-removal'){registration.removing();registration.removed();if(defect==='extra-image')h.originalRequest(path);registration.confirmedRestoration();}
 if(['missing-response','missing-terminal','extra-image','no-removal'].includes(defect)){await assert.rejects(h.monitor.closeEpoch());return;}
 await close(h);if(defect==='third-epoch'){assert.throws(()=>h.monitor.begin(h.server,'unused'));return;}
 await h.monitor.detach();if(defect==='late-recorder')h.onShutdown(()=>h.recorderFailures.push({phase:'late',error:'late recorder'}));await assert.rejects(h.monitor.finish(defect!=='cleanup-failure'));
});
// Direct actual assessor inputs cover orphan channels and every forbidden proof field.
function input(){const origin='http://127.0.0.1:34567',e={mode:RESTORED_MODE,fixture:'restored-reads',index:1,origin,pid:1,operations:[],proofs:[],workers:{rows:[]},nativeClosed:{rows:[{kind:'installed',actionId:null}]},discovery:[]};const q={id:1,url:origin+'/',method:'GET',actualHeaders:{accept:'*/*'},originalRequestObject:true,frameExposure:{ownerPage:true,ownerFrame:true,ownerContext:true},redirectedFrom:null,redirectedTo:null};const x={page:{origin,live:true,contextId:'context',frameId:'frame',targetId:'page'},requests:[q],responses:[{requestId:1,url:q.url,originalRequestObject:true,originalPairConfirmed:true,fromServiceWorker:false}],terminals:[{requestId:1,url:q.url,originalRequestObject:true,kind:'finished'}],server:[{kind:'request',id:1,pid:1,method:'GET',url:'/',requestObject:true,responseObject:true,responseRequestSame:true,headers:{host:'127.0.0.1:34567',accept:'*/*','sec-fetch-site':'same-origin'}}],network:[{name:'Network.requestWillBeSentExtraInfo',params:{requestId:'1',headers:{host:'127.0.0.1:34567','sec-fetch-site':'same-origin'}}}]};return {e,x};}
for(const field of ['collector','captures','initial','qualification'])test('actual negative assessor refuses '+field,()=>{const {e,x}=input();e[field]={};assert.throws(()=>refuseRestoredNative(e,x));});
for(const [label,mutate]of [
 ['operation',({e})=>e.operations.push({})],['proof',({e})=>e.proofs.push({})],['worker',({e})=>e.workers.rows.push({})],['wrong-mode',({e})=>e.mode='EMPTY-NATIVE'],['wrong-fixture',({e})=>e.fixture='combined'],
 ['duplicate-original',({x})=>x.requests.push(x.requests[0])],['orphan-response',({x})=>x.responses[0].requestId=2],['borrowed-response',({x})=>x.responses[0].originalPairConfirmed=false],['orphan-terminal',({x})=>x.terminals[0].requestId=2],['borrowed-terminal',({x})=>x.terminals[0].originalRequestObject=false],['foreign-page',({x})=>x.requests[0].frameExposure.ownerPage=false],['foreign-context',({x})=>x.requests[0].frameExposure.ownerContext=false],['foreign-frame',({x})=>x.requests[0].frameExposure.ownerFrame=false],['redirect',({x})=>x.requests[0].redirectedTo='elsewhere'],['service-worker',({x})=>x.responses[0].fromServiceWorker=true],
 ['orphan-server',({x})=>x.server[0].url='/orphan'],['missing-server',({x})=>x.server=[]],['duplicate-server',({x})=>x.server.push(x.server[0])],['orphan-server-terminal',({x})=>x.server.push({kind:'response',id:4})],['missing-protocol-owner',({x})=>x.network[0].params.headers={}],['orphan-protocol-url',({x})=>x.network[0]={name:'Network.requestWillBeSent',params:{requestId:'other',request:{url:'http://127.0.0.1:34567/orphan',method:'GET'}}}],['duplicate-protocol',({x})=>x.network.push(x.network[0])],
 ])test('actual negative assessor refuses '+label,()=>{const v=input();mutate(v);assert.throws(()=>restoredNative(v.x,v.e,{}));});
test('missing ordinary terminal remains absent and cannot qualify',()=>{const {e,x}=input();x.terminals=[];const r=restoredNative(x,e,{});assert.deepEqual(r.unobservedTerminals,[1]);assert.equal(r.transportQualified,false);assert.equal(r.observedEOF,false);});
test('raw ambiguous protocol candidates never become association proof',()=>{const {e,x}=input();x.requests.push({...x.requests[0],id:2});x.server.push({...x.server[0],id:2});const r=restoredNative(x,e,{});assert.deepEqual(r.protocol[0].candidateOriginalIds,[1,2]);assert.equal(r.qualified,false);});
function routeHarness(){const page={},context={},frame={page:()=>page};page.mainFrame=()=>frame;page.context=()=>context;const ep=i=>({index:i,mode:RESTORED_MODE,fixture:'restored-reads',epoch:'epoch'+i,owner:{contextId:'context',frameId:'frame',targetId:'page'},origin:'http://127.0.0.1:'+String(10000+i),pid:i,server:{instance:'server'+i,origin:'http://127.0.0.1:'+String(10000+i)}}),epochs=[ep(1)];let current=epochs[0];let order=0;const objects=new Map(),rows=[],events=[],failures=[],api=restoredRoutes({current:()=>current,epochs:()=>epochs,page,context,id:q=>q.id,objects,rows,order:()=>++order,events,fail:(e,error)=>failures.push(String(error))});const registration=api.register(pattern,path);registration.registered();current=ep(2);epochs.push(current);api.begin(current);api.activate(current);const q={id:1,frame:()=>frame,method:()=> 'GET',url:()=>current.origin+path},route={request:()=>q,continue:async()=>{}};objects.set(1,q);api.admit(q,{id:1,url:q.url(),method:'GET',frameExposure:{ownerPage:true,ownerFrame:true,ownerContext:true}});return {api,registration,route,q,rows,events,objects,epochs,page,context,frame,failures,current:()=>current,setCurrent:e=>current=e};}
for(const defect of ['reassigned-epoch','changed-origin','changed-server','foreign-route','foreign-frame','foreign-page','duplicate-release','release-after-seal','duplicate-registration'])test('actual route adapter refuses '+defect,async()=>{const h=routeHarness(),r=h.registration.hold(h.route);if(defect==='reassigned-epoch')h.setCurrent({...h.current()});if(defect==='changed-origin')h.current().origin='http://127.0.0.1:10009';if(defect==='changed-server')h.current().server.instance='other';if(defect==='foreign-route')h.route.request=()=>({...h.q});if(defect==='foreign-frame')h.q.frame=()=>({page:()=>h.page});if(defect==='foreign-page')h.frame.page=()=>({});if(defect==='release-after-seal')h.current().navigationSealed=true;if(defect==='duplicate-release')r.release();if(defect==='duplicate-registration'){assert.throws(()=>h.api.register(pattern,path));return;}assert.throws(()=>r.release());assert(h.failures.length);});
test('fixture selects only restored workflow for new mode',()=>{const s=readFileSync('tests/editor/integration-fixture.ts','utf8');assert(s.includes("name==='busy-actions'?'EMPTY-NATIVE':name==='restored-reads'?'RESTORED-NON-NATIVE':'NATIVE-COMPLETION'"));});

for(const channel of ['response','terminal'])for(const native of [false,true])for(const late of [false,true])test('actual original pre-filter '+channel+' orphan '+(native?'native':'ordinary')+(late?' late':''),async()=>{
 const {h,registration}=await setup(),held=await forward(h,registration);held.receipt.release();await held.receipt.continue();registration.removing();registration.removed();registration.confirmedRestoration();if(late)await h.monitor.closeEpoch();
 const url=h.server.origin+(native?EXPECTED.wasmPath:'/orphan'),q={testId:999,url:()=>url,failure:()=>null};
 if(channel==='response'){const p={request:()=>q,url:()=>url,status:()=>200,fromServiceWorker:()=>false,allHeaders:async()=>({'content-type':native?'application/wasm':'application/json'})};q.response=async()=>p;h.context.emit('response',p);}else h.context.emit('requestfinished',q);
 await assert.rejects(late?h.monitor.beforeNavigate():h.monitor.closeEpoch(),/orphan/);assert(!h.calls.some(c=>c.method==='Network.getResponseBody'));
});
// Actual shared public caller flow. Its original mock Response/terminal become
// available ONLY when the captured original continue is invoked, never at hold.
for(const failure of ['primary','receipt','forward','removal','normal'])test('actual public route caller '+failure+' forwards/removes once and preserves failures',async()=>{
 const h=routeHarness();let callback,continues=0,removes=0,response=false,terminal=false;const primary=Error('primary workflow failure');
 const route={request:()=>h.q,continue:function(...args){assert.equal(this,route);assert.deepEqual(args,[]);continues++;if(failure==='forward')return Promise.reject(Error('original forward failure'));response=true;terminal=true;return Promise.resolve();}};
 const page={route:async(p,fn)=>{assert.equal(p,pattern);callback=fn;},unroute:async p=>{assert.equal(p,pattern);removes++;if(failure==='removal')throw Error('original removal failure');}};
 // routeHarness already recorded registration; shared caller records its own.
 const observer={...h.registration,registered:()=>{}};if(failure==='receipt')observer.hold=()=>{throw Error('original receipt failure');};
 const flow=restoredRouteFlow({page,pattern,observer,onHold:()=>{}});await flow.install();const requestPromise=callback(route);requestPromise.catch(()=>{});assert(!response&&!terminal);assert.equal(continues,0);
 let result;if(failure==='normal'){await flow.release();result=await flow.cleanup();assert.equal(result,undefined);assert.equal(h.rows[0].normalContractFailed,undefined);}else{result=await flow.cleanup(primary);assert(result);const all=error=>error instanceof AggregateError?error.errors.flatMap(all):[error];assert(all(result).includes(primary));if(failure==='receipt')assert(all(result).some(e=>String(e).includes('receipt failure')));if(failure==='forward')assert(all(result).some(e=>String(e).includes('forward failure')));if(failure==='removal')assert(all(result).some(e=>String(e).includes('removal failure')));if(failure!=='receipt'){assert.equal(h.rows[0].release,undefined);assert.equal(h.rows[0].normalContractFailed,true);}assert.throws(()=>h.api.assess(h.current(),{requests:[],responses:[],terminals:[]}));}
 await Promise.allSettled([requestPromise]);assert.equal(continues,1);assert.equal(removes,1);assert.equal(response,failure!=='forward');assert.equal(terminal,failure!=='forward');await flow.cleanup(result);assert.equal(continues,1);assert.equal(removes,1);
});

test('actual restored input rejects malformed private evidence before application accounting',async()=>{
 const hostFactory=async options=>{const base=await injectedHostFinal(options);return {...base,async activate(e){await base.activate(e);e.hostSnapshot={origin:e.origin,errors:['deliberately malformed private evidence']};}};};
 const h=await monitorHarness({mode:RESTORED_MODE,fixture:'restored-reads',hostFactory});await assert.rejects(h.monitor.closeEpoch(),/deliberately malformed private evidence/);assert.equal(h.record().epochs[0].restoredNative,undefined);assert(!h.calls.some(c=>c.method==='Network.getResponseBody'));
});

const outgoingKinds=['header-return','response','response-close'];
test('actual monitor preserves saved433 numeric outgoing shape across both restored epochs',async()=>{
 const h=await monitorHarness({mode:RESTORED_MODE,fixture:'restored-reads'}),snapshots=[];
 const retain=q=>{const rows=h.serverRows.filter(r=>r.id===q.testId&&outgoingKinds.includes(r.kind));assert.deepEqual(rows.map(r=>r.kind),outgoingKinds);for(const r of rows)assert.equal(r.headers['content-length'],2182);snapshots.push({rows,raw:structuredClone(rows)});};
 const first=h.originalRequest('/',{bytes:2182});retain(first);const registration=h.monitor.restoredRoute(pattern,path);registration.registered();await close(h);await h.nextEpoch();
 const q=h.originalRequest(path,{bytes:2182});retain(q);const receipt=registration.hold({request:()=>q,continue:async()=>{}});const result=await finish(h,registration,{receipt});
 assert(result.complete);for(const s of snapshots)assert.deepEqual(s.rows,s.raw);
 for(const q of result.responses)assert.equal(typeof q.actualHeaders['content-length'],'string');
 for(const row of result.epochs.flatMap(e=>e.restoredNative.protocol))assert.equal(row.association,'unqualified candidates only');
 for(const e of result.epochs)for(const name of ['qualified','nativeQualified','wasmQualified','byteQualified','transportQualified','observedEOF'])assert.equal(e.restoredNative[name],false);
});
for(const kind of outgoingKinds)for(const [name,value,reason] of [
 ['content-type','application/wasm',/forbids native server records/],
 ['sec-fetch-dest','worker',/forbids native server records/],
 ['content-type',['application/wasm','text/plain'],/forbids native server records/],
 ['content-type',['text/plain','application/wasm'],/forbids native server records/],
 ['sec-fetch-dest',['worker','empty'],/forbids native server records/],
 ['sec-fetch-dest',['empty','worker'],/forbids native server records/],
 ['content-type',123,/native-relevant numeric header/],
 ['sec-fetch-dest',123,/native-relevant numeric header/],
 ['content-type',[],/native-relevant empty array/],
 ['content-type','malformed',/native-relevant malformed header/],
 ['x-test',null,/Node header value shape/],['x-test',true,/Node header value shape/],['x-test',{},/Node header value shape/],['x-test',['ok',1],/Node header value shape/],
 ])test('actual monitor typed Node '+kind+' refuses '+name+' '+JSON.stringify(value),async()=>{
 const h=await monitorHarness({mode:RESTORED_MODE,fixture:'restored-reads'});const q=h.originalRequest('/',{bytes:2182}),row=h.serverRows.find(r=>r.id===q.testId&&r.kind===kind);row.headers[name]=value;const raw=structuredClone(row);h.saveLedger();
 await assert.rejects(h.monitor.closeEpoch(),reason);assert.deepEqual(row,raw);assert(!h.calls.some(c=>c.method==='Network.getResponseBody'));
 // Other Node snapshots and original PW/CDP observations were not mutated.
 for(const r of h.serverRows.filter(r=>r.id===q.testId&&outgoingKinds.includes(r.kind)&&r!==row)){assert.equal(r.headers['content-length'],2182);assert.equal(r.headers['content-type'],'application/json');}
 const record=h.record();for(const p of record.responses)assert.equal(p.actualHeaders['content-type'],'application/json');
});
for(const late of [false,true])test('actual monitor numeric outgoing native evidence remains sticky '+(late?'late':'early'),async()=>{
 const {h,registration}=await setup(),held=await forward(h,registration);held.receipt.release();await held.receipt.continue();registration.removing();registration.removed();registration.confirmedRestoration();if(late)await h.monitor.closeEpoch();
 const row=h.serverRows.find(r=>r.kind==='response-close');row.headers['content-type']='application/wasm';h.saveLedger();await assert.rejects(late?h.monitor.beforeNavigate():h.monitor.closeEpoch(),/forbids native server records/);
 row.headers['content-type']='application/json';h.saveLedger();await assert.rejects(late?h.monitor.beforeNavigate():h.monitor.closeEpoch(),/Permanent epoch failure/);
});
for(const channel of ['PW','CDP'])test('typed Node support does not loosen '+channel+' string-only headers',async()=>{
 const h=await monitorHarness({mode:RESTORED_MODE,fixture:'restored-reads'});h.originalRequest('/',channel==='PW'?{pwResponseHeaders:{'content-length':2182}}:{protocolResponseHeaders:{'content-length':2182}});
 await assert.rejects(h.monitor.closeEpoch(),error=>String(error).includes("'number' !== 'string'"));
});
test('typed Node inspection preserves arrays and normalized duplicate refusal',()=>{
 const headers={'Content-Length':2182,'Content-Type':['application/json','text/plain'],'x-values':['first','second']},raw=structuredClone(headers);assert.equal(restoredNodeNativeHeaders(headers),false);assert.deepEqual(headers,raw);
 assert.throws(()=>restoredNodeNativeHeaders({'Content-Length':2182,'content-length':2182}),/Duplicate normalized Node header/);
 for(const value of [undefined,null,true,{},[null],[undefined],new Array(1)])assert.throws(()=>restoredNodeNativeHeaders({'x-value':value}),/Node header value shape/);
 for(const value of [NaN,Infinity])assert.throws(()=>restoredNodeNativeHeaders({'content-length':value}),/numeric header shape/);
 for(const value of [null,true,[],3])assert.throws(()=>restoredNodeNativeHeaders(value),/header map shape/);
});

async function sharedRestoration({preactivation=false,deferred=false}={}){
 const {h,registration}=await setup({preactivation});let callback,forwarded=0,removed=0,assertions=0,resolveHeaders;
 const headersReady=deferred?new Promise(resolve=>resolveHeaders=resolve):undefined;
 h.page.route=async(p,fn)=>{assert.equal(p,pattern);callback=fn;};h.page.unroute=async p=>{assert.equal(p,pattern);removed++;};
 const flow=restoredRouteFlow({page:h.page,pattern,observer:{...registration,registered:()=>{}},onHold:()=>{}});await flow.install();
 const q=h.originalRequest(path,{headersReady,deferCallbacks:deferred});const route={request:()=>q,continue:async()=>{forwarded++;}};const work=callback(route);work.catch(()=>{});
 const confirm=()=>flow.confirmRestored(async()=>{assert.equal(forwarded,1);assert.equal(removed,1);assertions++;});
 return {h,registration,flow,q,route,work,confirm,resolveHeaders,counts:()=>({forwarded,removed,assertions})};
}
for(const preactivation of [false,true])test('actual shared restored window keeps admitted late metadata and later gesture read '+preactivation,async()=>{
 const x=await sharedRestoration({preactivation,deferred:true});if(preactivation)await x.h.monitor.activate();await x.flow.release();const cut=await x.confirm();assert(Object.isFrozen(cut)&&Object.isFrozen(cut.requestIds));assert(cut.requestIds.includes(x.q.testId));
 const later=x.h.originalRequest(path);x.q.deliver();x.resolveHeaders();await x.work;await close(x.h);await x.h.monitor.detach();await x.h.monitor.finish(true);const record=x.h.record(),e=record.epochs[1],w=e.restoredNative.route.window;
 assert(record.complete);assert.equal(w.matchingRequestId,x.q.testId);assert(w.laterRequestIds.includes(later.testId));assert(!w.confirmed.requestIds.includes(later.testId));assert(record.responses.some(p=>p.requestId===x.q.testId&&p.originalPairConfirmed));assert(record.terminals.some(t=>t.requestId===x.q.testId&&t.kind==='finished'));assert.equal(record.requests.filter(q=>q.url===later.url()).length,2);assert.deepEqual(x.counts(),{forwarded:1,removed:1,assertions:1});assert.equal(e.restoredNative.transportQualified,false);assert.equal(e.restoredNative.observedEOF,false);
});
for(const when of ['before-forwarding','after-unroute','during-confirmation'])test('actual shared window refuses second admitted read '+when,async()=>{
 const x=await sharedRestoration();if(when==='before-forwarding')x.h.originalRequest(path);await x.flow.release();if(when==='after-unroute')x.h.originalRequest(path);
 if(when==='during-confirmation')await x.flow.confirmRestored(async()=>{x.h.originalRequest(path);});else await x.confirm();
 await assert.rejects(x.h.monitor.closeEpoch(),/One exact image read in confirmed restoration window/);
});
for(const defect of ['missing','before-release','before-removal','repeated','foreign-context','foreign-frame','changed-server','changed-origin','changed-epoch','changed-owner','duplicate-original'])test('actual restoration marker refuses '+defect,async()=>{
 const x=await sharedRestoration();
 if(defect==='before-release'){await assert.rejects(x.confirm(),/Successful shared release/);await x.flow.cleanup(Error('primary before release'));return;}
 if(defect==='before-removal'){assert.throws(()=>x.registration.confirmedRestoration(),/Successful original removal/);await x.flow.cleanup(Error('primary before removal'));return;}
 await x.flow.release();if(defect==='missing'){await assert.rejects(x.h.monitor.closeEpoch(),/Confirmed restoration boundary required/);return;}
 if(defect==='repeated'){await x.confirm();await assert.rejects(x.confirm(),/One shared restoration confirmation/);assert.throws(()=>x.registration.confirmedRestoration(),/Exactly one confirmed-restoration marker/);return;}
 if(defect==='foreign-context')x.h.page.context=()=>({});if(defect==='foreign-frame')x.h.page.mainFrame=()=>({});if(defect==='changed-server')x.h.server.instance='foreign';if(defect==='changed-origin')x.h.server.origin='http://127.0.0.1:9';
 if(defect==='changed-origin'){// The captured epoch origin is immutable; server identity is also checked.
  await assert.rejects(x.confirm(),/Original window server origin/);return;
 }
 if(defect==='changed-epoch'||defect==='changed-owner'){
  const h=routeHarness();const receipt=h.registration.hold(h.route);receipt.release();await receipt.continue();h.registration.removing();h.registration.removed();if(defect==='changed-epoch')h.current().epoch='foreign';else h.current().owner.contextId='foreign';assert.throws(()=>h.registration.confirmedRestoration(),defect==='changed-epoch'?/Original confirmed epoch/:/Original confirmed owner/);return;
 }
 if(defect==='duplicate-original'){const foreign={...x.q};x.h.context.emit('request',foreign);await assert.rejects(x.h.monitor.closeEpoch(),/Permanent epoch failure/);x.h.monitor.save();assert.match(x.h.record().epochs[1].failure,/Unique original admission/);return;}
 await assert.rejects(x.confirm(),defect==='foreign-context'?/Original window context/:defect==='foreign-frame'?/Original window frame/:/strictly equal/);
});
test('actual shared confirmation waits for successful public assertions and preserves primary failure',async()=>{
 const x=await sharedRestoration();await x.flow.release();const primary=Error('public accepted-state assertion failed');await assert.rejects(x.flow.confirmRestored(async()=>{throw primary;}),error=>error===primary);assert.equal(await x.flow.cleanup(primary),primary);await assert.rejects(x.h.monitor.closeEpoch(),/Confirmed restoration boundary required/);assert.deepEqual(x.counts(),{forwarded:1,removed:1,assertions:0});
});

// Use the actual monitor's original-object listeners and unchanged private
// partition, including the receiver navigation that occurs only after sealing.
for(const defect of ['none','late-ordinary','foreign-private-frame'])test('actual restored post-seal receiver '+defect,async()=>{
 let h,receiverId;
 const hostFactory=async options=>{const base=await injectedHostFinal(options);return {...base,async depart(e){
  await base.depart(e);if(e.index!==2)return;assert(e.closed&&e.navigationSealed);
  const f=hostFixture(e),r=f.registration,b=f.body;r.instance=b.instance=e.server.instance;
  const requestHeaders={host:new URL(e.origin).host,accept:'text/html','sec-fetch-site':'same-origin','sec-fetch-dest':'document'};
  const d={...structuredClone(b),id:2,path:r.receiver,method:'GET',headers:requestHeaders,rawHeaders:Object.entries(requestHeaders).flat(),responseStatus:200,inert:true};
  e.hostSnapshot={run:r.run,origin:e.origin,pid:e.pid,instance:e.server.instance,errors:[],registrations:[r],bodies:[b],documents:[d]};
  const rows=[...privateServerRows(b,9000),...privateServerRows(d,9001)];const offset=h.serverRows.length;h.serverRows.push(...rows.map((row,i)=>({...row,sequence:offset+i+1})));h.saveLedger();
  receiverId=9001;const url=e.origin+r.receiver,headers={'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'none'; base-uri 'none'; frame-ancestors 'none'"};
  const q={testId:receiverId,url:()=>url,method:()=> 'GET',resourceType:()=> 'document',redirectedFrom:()=>null,redirectedTo:()=>null,frame:()=>defect==='foreign-private-frame'?{page:()=>h.page}:h.page.mainFrame(),allHeaders:async()=>structuredClone(requestHeaders),response:async()=>p};
  const p={request:()=>q,url:()=>url,status:()=>200,fromServiceWorker:()=>false,allHeaders:async()=>structuredClone(headers)};
  h.context.emit('request',q);h.context.emit('response',p);h.context.emit('requestfinished',q);
  const requestId='private-receiver';for(const [name,params]of [
   ['Network.requestWillBeSent',{requestId,frameId:r.context.frameId,request:{url,method:'GET',headers:structuredClone(requestHeaders)}}],
   ['Network.requestWillBeSentExtraInfo',{requestId,headers:structuredClone(requestHeaders)}],
   ['Network.responseReceived',{requestId,frameId:r.context.frameId,response:{url,status:200,headers:structuredClone(headers)}}],
   ['Network.responseReceivedExtraInfo',{requestId,statusCode:200,headers:structuredClone(headers)}],
   ['Network.loadingFinished',{requestId,encodedDataLength:100}],
  ])h.pageSession.emit(name,params);
  if(defect==='late-ordinary')h.originalRequest('/ordinary-after-seal');
 }};};
 h=await monitorHarness({mode:RESTORED_MODE,fixture:'restored-reads',hostFactory});h.originalRequest('/');const registration=h.monitor.restoredRoute(pattern,path);registration.registered();await close(h);await h.nextEpoch();const held=await forward(h,registration);held.receipt.release();await held.receipt.continue();registration.removing();registration.removed();registration.confirmedRestoration();await h.monitor.closeEpoch();await h.monitor.beforeNavigate();
 if(defect==='late-ordinary'){await assert.rejects(h.monitor.depart('terminal'),/New original request after provisional closure/);assert.equal(h.record().epochs[1].privateTraffic.requestIds[0],receiverId);return;}
 if(defect==='foreign-private-frame'){await assert.rejects(h.monitor.depart('terminal'),/ownerPage&&q.frameExposure.ownerFrame&&q.frameExposure.ownerContext/);return;}
 await h.monitor.depart('terminal');await h.monitor.beforeServerStop();await h.monitor.detach();await h.monitor.finish(true);const record=h.record(),e=record.epochs[1];assert(record.complete);assert.deepEqual(e.privateTraffic.requestIds,[receiverId]);assert.deepEqual(e.privateTraffic.networkIds,['private-receiver']);assert(record.requests.some(q=>q.id===receiverId&&q.resourceType==='document'));assert(e.restoredNative.route.window.laterRequestIds.includes(receiverId));assert(!e.restoredNative.route.window.confirmed.requestIds.includes(receiverId));assert.equal(e.restoredNative.transportQualified,false);
});
for(const defect of ['reordered','missing-cut','missing-request','held-object'])test('actual membership refuses original receipt '+defect,async()=>{
 const h=routeHarness(),receipt=h.registration.hold(h.route);receipt.release();await receipt.continue();h.registration.removing();h.registration.removed();h.registration.confirmedRestoration();
 if(defect==='reordered')h.events.reverse();if(defect==='missing-cut')h.events.pop();if(defect==='missing-request')h.events.splice(h.events.findIndex(e=>e.kind==='restoration-request'),1);if(defect==='held-object')h.objects.set(h.q.id,{...h.q});
 const reasons={reordered:/Ordered original restoration receipts/,'missing-cut':/Original immutable boundary receipts/,'missing-request':/events.includes/,'held-object':/Original admitted object retained/};assert.throws(()=>h.api.assess(h.current(),{requests:[],responses:[],terminals:[]}),reasons[defect]);
});

async function observedRouteWindow(){const h=routeHarness(),r=h.registration.hold(h.route);r.release();await r.continue();h.registration.removing();h.registration.removed();return h;}
test('actual route window retains original callbacks and immutable caller order',async()=>{const h=await observedRouteWindow(),w=h.api.ancillaryWindow(h.current());assert.equal(w.mode,RESTORED_MODE);assert.equal(w.epochIndex,2);assert(w.registration.sequence<w.begin.sequence&&w.begin.sequence<w.removing.sequence&&w.removing.sequence<w.removed.sequence);for(const event of h.events)assert(Object.isFrozen(event));assert.deepEqual(h.api.ancillaryWindow(h.current()),w);});
for(const [name,change,reason]of [
 ['missing registration',h=>h.events.splice(h.events.findIndex(e=>e.kind==='route-registration-completed'),1),/immutable original route receipt/],
 ['cloned registration',h=>{const i=h.events.findIndex(e=>e.kind==='route-registration-completed');h.events[i]={...h.events[i]};},/immutable original route receipt/],
 ['duplicate registration',h=>h.events.push(h.events.find(e=>e.kind==='route-registration-completed')),/immutable original route receipt/],
 ['missing removal',h=>h.events.splice(h.events.findIndex(e=>e.kind==='route-removal-start'),1),/immutable original route receipt/],
 ['foreign page',h=>h.frame.page=()=>({}),/original frame page/],
 ['foreign context',h=>h.page.context=()=>({}),/Original window context/],
 ['foreign frame',h=>h.page.mainFrame=()=>({}),/Original window frame/],
 ['replaced registration',h=>h.api.registrations[0]={...h.api.registrations[0]},/original route objects/],
 ['changed pattern',h=>h.api.registrations[0].pattern='**/*',/strictly equal/],
 ['failed registration',h=>h.registration.registrationFailed(Error('failed')),/successful original route window/],
 ['failed removal',h=>h.registration.removalFailed(Error('failed')),/successful original route window/],
 ['cleanup removal',h=>h.registration.cleanupRemoving(),/successful original route window/],
 ['owner change',h=>h.current().owner.contextId='foreign',/original owner/],
 ['epoch change',h=>h.current().epoch='foreign',/original epoch binding/],
 ['server change',h=>h.current().server.instance='foreign',/strictly equal/],
 ['second route',h=>h.api.registrations.push(h.api.registrations[0]),/one original route/],
])test('actual canceled route observation refuses '+name,async()=>{const h=await observedRouteWindow();change(h);assert.throws(()=>h.api.ancillaryWindow(h.current()),reason);});
test('actual canceled window refuses absent completed removal',()=>{const h=routeHarness();assert.throws(()=>h.api.ancillaryWindow(h.current()),/successful original route window/);});

for(const key of ['registrationStarted','registered','removalStarted','removed'])test('actual canceled route refuses changed original tick '+key,async()=>{const h=await observedRouteWindow();h.api.registrations[0][key]++;assert.throws(()=>h.api.ancillaryWindow(h.current()),/immutable .* metadata/);});


const restoredTilePath='/api/v1/assets/image/display-tile?identity=sha256%3A'+'a'.repeat(64)+'&basis=pixels&lod=0&x=0&y=0';
test('restored current tile keeps exact original forwarding, one read and negative-only qualification',async()=>{
 const {h,registration}=await setup({readPath:restoredTilePath}),held=await forward(h,registration,{readPath:restoredTilePath}),r=await finish(h,registration,held),e=r.epochs[1];assert(r.complete);assert.deepEqual(held.calls,[[]]);assert.equal(r.routes[0].url,h.server.origin+restoredTilePath);assert.equal(e.restoredNative.route.registration.path,restoredTilePath);assert.equal(e.restoredNative.route.window.matchingRequestId,held.q.testId);assert.equal(e.restoredNative.route.held,1);for(const k of ['qualified','nativeQualified','wasmQualified','byteQualified','transportQualified','observedEOF'])assert.equal(e.restoredNative[k],false);assert.equal(e.collector,undefined);assert.equal(h.monitor.qualifies({}),false);assert(!h.calls.some(c=>['Network.getResponseBody','Network.configureDurableMessages'].includes(c.method)));
});
test('restored current tile refuses a second same-asset tile with a different query',async()=>{
 const {h,registration}=await setup({readPath:restoredTilePath}),held=await forward(h,registration,{readPath:restoredTilePath});held.receipt.release();await held.receipt.continue();registration.removing();registration.removed();h.originalRequest(restoredTilePath.replace('&x=0','&x=1'));registration.confirmedRestoration();await assert.rejects(h.monitor.closeEpoch(),/One exact image read in confirmed restoration window/);
});
test('restored tile registration refuses noncanonical paths and holds only its exact identity query',async()=>{
 assert.equal(validRestoredReadPath(path),true);assert.equal(validRestoredReadPath(restoredTilePath),true);
 for(const changed of [restoredTilePath.replace('identity=','other='),restoredTilePath.replace('%3A',':'),restoredTilePath.replace('%3A','%3a'),restoredTilePath.replace('basis=pixels','basis=encoded'),restoredTilePath.replace('lod=0','lod=1'),restoredTilePath.replace('x=0','x=1'),restoredTilePath.replace('y=0','y=1'),restoredTilePath+'&extra=1',restoredTilePath+'#fragment',restoredTilePath.replace('/display-tile?','/display?'),restoredTilePath.replace('/image/','/image%2Fother/'),'/api/v1/assets/image/display-tile',restoredTilePath.replace('a'.repeat(64),'a'.repeat(63))])assert.equal(validRestoredReadPath(changed),false,changed);
 const {h,registration}=await setup({readPath:restoredTilePath}),q=h.originalRequest(restoredTilePath.replace('a'.repeat(64),'b'.repeat(64)));assert.throws(()=>registration.hold({request:()=>q,continue:async()=>{}}),/strictly equal/);
});
