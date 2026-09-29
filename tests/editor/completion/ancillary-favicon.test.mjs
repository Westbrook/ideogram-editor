import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {accountFavicon,faviconSourceProof} from './ancillary-favicon.mjs';
import {monitorHarness} from './monitor-harness.mjs';
import {EXPECTED} from './app-buffer-core.mjs';

const saved=JSON.parse(readFileSync(new URL('./ancillary-favicon168.json',import.meta.url)));
function fixture(index=0){
 const f=structuredClone(saved.cases[index]);assert(f.sourceAdmission.noStaticIcon&&f.sourceAdmission.origins.includes(f.origin));
 return {x:{page:f.owner,epoch:f.epoch,currentEpoch:f.epoch,requests:f.publicIconRequests,responses:f.publicIconResponses,terminals:f.publicIconTerminals,server:f.server,network:f.network,recorder:f.recorder},admission:{origin:f.origin,epoch:f.epoch,owner:structuredClone(f.owner),frame:f.frame,defaultContext:f.defaultContext,serverOwner:f.serverOwner,source:faviconSourceProof(),noPublicIconLink:true}};
}
const event=(f,name)=>f.x.network.find(n=>n.name==='Network.'+name).params;
const server=(f,kind)=>f.x.server.find(n=>n.kind===kind);
for(let i=0;i<saved.cases.length;i++)test('saved168 '+saved.cases[i].case+' metadata-only association, never historical acceptance',()=>{
 const f=fixture(i),before=structuredClone(f),r=accountFavicon(f.x,f.admission);assert.deepEqual(f,before);assert.equal(r.server.length,0);assert.equal(r.network.length,0);assert.equal(r.account.records.length,1);const record=r.account.records[0];
 for(const k of ['qualified','pwQualified','byteQualified','nativeQualified','wasmQualified','hostFinalQualified','transportQualified','errorWaiver','consumerEOF','bodyObserved','pwExposure'])assert.equal(record[k],false);
 assert.equal(record.bodyHash,null);assert.equal(record.status,404);assert.deepEqual(record.counters,{data:163,encodedData:174,terminalEncoded:935});assert.equal(record.serverRows.length,f.x.server.length);
});

const negatives=[
 ['foreign page',f=>f.x.page.targetId='foreign',/Ancillary owner/],
 ['foreign epoch',f=>f.x.currentEpoch='foreign',/ERR_ASSERTION/],
 ['foreign admission epoch',f=>f.admission.epoch='foreign',/ERR_ASSERTION/],
 ['missing loader',f=>delete f.admission.frame.loaderId,/document loader/],
 ['foreign default frame',f=>f.admission.defaultContext.frameId='foreign',/ERR_ASSERTION/],
 ['foreign default epoch',f=>f.admission.defaultContext.epoch='foreign',/ERR_ASSERTION/],
 ['missing default identity',f=>delete f.admission.defaultContext.uniqueId,/default-context binding/],
 ['source icon present',f=>f.admission.source.noStaticIcon=false,/source admission/],
 ['source icon link',f=>f.admission.source.noIconLinkSource=false,/source admission/],
 ['public icon link',f=>f.admission.noPublicIconLink=false,/public icon link/],
 ['wrong suppression source',f=>f.admission.source.coreSHA256='0'.repeat(64),/ERR_ASSERTION/],
 ['wrong package',f=>f.admission.source.version='other',/ERR_ASSERTION/],
 ['recorder error',f=>f.x.recorder.failures.push({message:'error'}),/recorder errors/],
 ['foreign recorder instance',f=>f.x.recorder.instance='other',/ERR_ASSERTION/],
 ['foreign recorder pid',f=>f.x.recorder.pid++,/ERR_ASSERTION/],
 ['missing original recorder',f=>f.x.recorder.originalInstallation=false,/ERR_ASSERTION/],
 ['server duplicate',f=>f.x.server.unshift(structuredClone(server(f,'request'))),/unique server request/],
 ['server missing request',f=>f.x.server=f.x.server.filter(r=>r.kind!=='request'),/unique server request/],
 ['server foreign pid',f=>server(f,'request').pid++,/ERR_ASSERTION/],
 ['server foreign origin',f=>server(f,'request').url='http://127.0.0.1:9999/favicon.ico',/exact path/],
 ['server query',f=>server(f,'request').url='/favicon.ico?q=1',/exact path/],
 ['server fragment',f=>server(f,'request').url='/favicon.ico#x',/exact path/],
 ['server method',f=>server(f,'request').method='POST',/ERR_ASSERTION/],
 ['server orphan',f=>f.x.server.push({...structuredClone(server(f,'response')),id:99}),/orphan server row/],
 ['server object mismatch',f=>server(f,'response').responseRequestSame=false,/original server objects/],
 ['incoming raw duplicate',f=>server(f,'request').rawHeaders.push('Host',new URL(f.admission.origin).host),/duplicate raw header/],
 ['incoming raw independent',f=>server(f,'request').rawHeaders[1]='wrong',/raw incoming snapshot/],
 ['incoming independent',f=>server(f,'request').headers.accept='wrong',/raw incoming snapshot/],
 ['request ExtraInfo independent',f=>event(f,'requestWillBeSentExtraInfo').headers.Accept='wrong',/full incoming ExtraInfo/],
 ['regular request independent',f=>event(f,'requestWillBeSent').request.headers['Accept-Language']='wrong',/regular request header/],
 ['nonempty Referer hint',f=>event(f,'requestWillBeSent').request.headers.Referer='http://foreign/',/no-referrer hint/],
 ['outgoing independent',f=>server(f,'response').headers['content-type']='application/wasm',/Node drain headers/],
 ['header-call independent',f=>f.x.server.find(r=>r.kind==='header-call').args[1]='wrong',/header return snapshot/],
 ['header-return independent',f=>f.x.server.find(r=>r.kind==='header-return').headers['x-extra']='wrong',/header return snapshot/],
 ['response ExtraInfo independent',f=>event(f,'responseReceivedExtraInfo').headers['Content-Type']='application/wasm',/regular response versus ExtraInfo/],
 ['regular response independent',f=>event(f,'responseReceived').response.headers['Content-Type']='application/wasm',/regular response versus ExtraInfo/],
 ['raw response duplicate',f=>event(f,'responseReceivedExtraInfo').headersText=event(f,'responseReceivedExtraInfo').headersText.replace('\r\n\r\n','\r\nContent-Type: application/json\r\n\r\n'),/duplicate raw header/],
 ['status',f=>event(f,'responseReceived').response.status=200,/ERR_ASSERTION/],
 ['MIME',f=>event(f,'responseReceived').response.mimeType='application/wasm',/ERR_ASSERTION/],
 ['redirect',f=>event(f,'requestWillBeSent').redirectResponse={},/ERR_ASSERTION/],
 ['cache',f=>event(f,'responseReceived').response.fromDiskCache=true,/substituted response/],
 ['service worker',f=>event(f,'responseReceived').response.fromServiceWorker=true,/substituted response/],
 ['prefetch',f=>event(f,'responseReceived').response.fromPrefetchCache=true,/substituted response/],
 ['failed terminal',f=>f.x.network.find(n=>n.name==='Network.loadingFinished').name='Network.loadingFailed',/failed\/cache\/unexplained/],
 ['incomplete Node close',f=>server(f,'response-close').writableFinished=false,/completed Node response/],
 ['not destroyed Node close',f=>server(f,'response-close').destroyed=false,/original Node finish\/close/],
 ['foreign frame',f=>event(f,'requestWillBeSent').frameId='foreign',/Ancillary frame/],
 ['foreign loader',f=>event(f,'responseReceived').loaderId='foreign',/Ancillary loader/],
 ['foreign controller',f=>f.x.network[0].controllerSessionLabel='foreign',/Ancillary controller/],
 ['foreign document',f=>event(f,'requestWillBeSent').documentURL='http://foreign/',/ERR_ASSERTION/],
 ['PW request exposure',f=>f.x.requests.push({id:999,url:f.admission.origin+'/favicon.ico'}),/public PW exposure/],
 ['PW orphan response exposure',f=>f.x.responses.push({requestId:999,url:f.admission.origin+'/favicon.ico'}),/public PW exposure/],
 ['PW orphan terminal exposure',f=>f.x.terminals.push({requestId:999,url:f.admission.origin+'/favicon.ico'}),/public PW exposure/],
];
for(const name of ['requestWillBeSent','requestWillBeSentExtraInfo','responseReceived','responseReceivedExtraInfo','loadingFinished']){
 negatives.push(['missing '+name,f=>f.x.network=f.x.network.filter(n=>n.name!=='Network.'+name),/Ancillary/]);
 negatives.push(['duplicate '+name,f=>f.x.network.push(structuredClone(f.x.network.find(n=>n.name==='Network.'+name))),/Ancillary/]);
}
for(const kind of ['header-call','header-return','response','response-close'])negatives.push(['missing Node '+kind,f=>{const i=f.x.server.findIndex(r=>r.kind===kind);f.x.server.splice(i,1);},/Ancillary|ERR_ASSERTION/]);
for(const [name,change,reason]of negatives)test('ancillary refuses '+name,()=>{const f=fixture();change(f);assert.throws(()=>accountFavicon(f.x,f.admission),reason);});
test('orphan protocol and unrelated native/private traffic remain original objects for mandatory downstream accounting',()=>{
 const f=fixture(),serverRow={kind:'request',id:100,url:'/__p1c6-completion/unknown/final'},networkRow={name:'Network.dataReceived',params:{requestId:'orphan',dataLength:1,encodedDataLength:1}};f.x.server.push(serverRow);f.x.network.push(networkRow);const r=accountFavicon(f.x,f.admission);assert.deepEqual(r.server,[serverRow]);assert.equal(r.server[0],serverRow);assert.equal(r.network[0],networkRow);
});
test('late balanced identity replacement fails retained signature',()=>{const f=fixture(),previous=accountFavicon(f.x,f.admission).account;for(const n of f.x.network)n.params.requestId='replacement';for(const n of f.x.server)n.id=88;assert.throws(()=>accountFavicon(f.x,f.admission,{previous}),/late identity\/cardinality/);});
test('no favicon removes nothing and late addition fails',()=>{const f=fixture(),empty={...f.x,server:[],network:[]};const previous=accountFavicon(empty,f.admission).account;assert.equal(previous.records.length,0);assert.throws(()=>accountFavicon(f.x,f.admission,{previous}),/late identity\/cardinality/);});

function inject(h,change=()=>{},index=1){
 const f=fixture(),origin=h.server.origin;
 const replace=v=>JSON.parse(JSON.stringify(v).replaceAll(f.admission.origin,origin).replaceAll(new URL(f.admission.origin).host,new URL(origin).host).replaceAll(f.admission.frame.id,'page').replaceAll(f.admission.frame.loaderId,'document-loader-'+index));
 const rows=replace(f.x.server),network=replace(f.x.network);
 for(const r of rows){r.pid=h.server.pid;r.id=7000+index;if(r.kind==='request')r.localPort=Number(new URL(origin).port);}
 for(const n of network)n.params.requestId='favicon.'+index;
 change({rows,network,h});h.serverRows.push(...rows);h.saveLedger();for(const n of network)h.pageSession.emit(n.name,n.params);return {rows,network};
}
async function finish(h){await h.monitor.closeEpoch();await h.monitor.beforeNavigate();await h.pagehide();await h.monitor.beforeServerStop();await h.monitor.detach();await h.monitor.finish(true);return h.record();}
test('actual native monitor accounts missing-PW favicon beside genuine control native group and preserves raw ledgers',async()=>{
 const h=await monitorHarness();inject(h);await h.preview();const r=await finish(h),e=r.epochs[0];assert(r.complete&&e.qualification.qualified);assert.equal(e.ancillary.records.length,1);assert.equal(e.ancillary.qualified,false);assert(r.network.some(n=>n.params.request?.url.endsWith('/favicon.ico')));assert(e.ancillaryChecks.length>=5);assert(e.qualification.browserBytes.length>0);
});
for(const [name,change,reason]of [
 ['foreign frame',({network})=>network.find(n=>n.name==='Network.requestWillBeSent').params.frameId='foreign',/Ancillary frame/],
 ['independent header',({network})=>network.find(n=>n.name==='Network.requestWillBeSentExtraInfo').params.headers.Accept='wrong',/full incoming ExtraInfo/],
 ['incomplete close',({rows})=>rows.find(r=>r.kind==='response-close').writableFinished=false,/completed Node response/],
 ['private server orphan',({rows})=>rows.push({kind:'request',id:8000,pid:123,serverId:1,method:'POST',url:'/__p1c6-completion/foreign/final',requestObject:true,responseObject:true,responseRequestSame:true}),/Unaccounted server/],
])test('actual monitor refuses '+name,async()=>{const h=await monitorHarness();inject(h,change);await h.preview();await assert.rejects(h.monitor.closeEpoch(),reason);assert.equal(h.record().complete,false);});
for(const stage of ['closure','navigation','retained','shutdown'])test('actual monitor late favicon contradiction at '+stage,async()=>{
 const h=await monitorHarness(),v=inject(h);await h.preview();
 if(stage==='closure')h.onCapture(()=>{v.rows.find(r=>r.kind==='response-close').writableFinished=false;h.saveLedger();});
 else {await h.monitor.closeEpoch();if(stage==='navigation'){v.rows.find(r=>r.kind==='response-close').writableFinished=false;h.saveLedger();}}
 if(stage==='closure')await assert.rejects(h.monitor.closeEpoch(),/completed Node response/);
 if(stage==='navigation')await assert.rejects(h.monitor.beforeNavigate(),/completed Node response/);
 if(stage==='retained'){await h.monitor.beforeNavigate();await h.pagehide();v.rows.find(r=>r.kind==='response-close').writableFinished=false;h.saveLedger();await assert.rejects(h.monitor.beforeServerStop(),/completed Node response/);}
 if(stage==='shutdown'){await h.monitor.beforeNavigate();await h.pagehide();await h.monitor.beforeServerStop();await h.monitor.detach();h.onShutdown(()=>{v.rows.find(r=>r.kind==='response-close').writableFinished=false;});await assert.rejects(h.monitor.finish(true),/completed Node response/);}
 assert.equal(h.record().complete,false);
});
test('actual monitor valid ancillary cannot rescue missing original WASM Response',async()=>{const h=await monitorHarness();inject(h);h.withholdWasmResponse();await h.preview();const before=h.record(),q=before.requests.find(r=>r.url===h.server.origin+EXPECTED.wasmPath);assert(q);assert.equal(before.responses.filter(p=>p.requestId===q.id).length,0);assert.equal(before.terminals.filter(t=>t.requestId===q.id).length,1);await assert.rejects(h.monitor.closeEpoch(),new RegExp('Unaccounted page candidate request[.]'+q.id+'$'));assert.equal(h.record().complete,false);});
test('actual monitor valid ancillary cannot rescue cleanup false',async()=>{const h=await monitorHarness();inject(h);await h.preview();await h.monitor.closeEpoch();await h.monitor.beforeNavigate();await h.pagehide();await h.monitor.detach();await assert.rejects(h.monitor.finish(false),/Independent owned cleanup/);assert.equal(h.record().complete,false);});
test('actual monitor without favicon retains original native completion',async()=>{const h=await monitorHarness();await h.preview();const r=await finish(h);assert(r.complete);assert.equal(r.epochs[0].ancillary.records.length,0);});

test('actual monitor valid ancillary cannot rescue incomplete body',async()=>{const h=await monitorHarness();inject(h);await h.preview();h.onCapture(()=>({base64Encoded:true,body:'AA=='}));await assert.rejects(h.monitor.closeEpoch(),/Closed-group capture failed/);assert.equal(h.record().complete,false);});
test('actual monitor valid ancillary cannot rescue foreign native cohort',async()=>{const h=await monitorHarness();inject(h);await h.preview();h.rootSession.emit('Target.targetInfoChanged',{targetInfo:{...h.target('worker-1'),parentId:'foreign'}});await assert.rejects(h.monitor.closeEpoch());assert.equal(h.record().complete,false);});
test('actual monitor retains unowned protocol for final exhaustive refusal',async()=>{const h=await monitorHarness();inject(h);await h.preview();h.pageSession.emit('Network.dataReceived',{requestId:'orphan',dataLength:1,encodedDataLength:1});await assert.rejects(finish(h),/Every protocol event owns exactly one epoch/);assert.equal(h.record().complete,false);});

for(const kind of ['response','response-close','header-call','header-return'])for(const shape of ['relative','absolute'])test('ancillary refuses orphan '+kind+' through '+shape+' URL without path masking',()=>{const f=fixture(),row=structuredClone(server(f,kind));row.id=991;delete row.path;row.url=shape==='relative'?'/favicon.ico':f.admission.origin+'/favicon.ico';f.x.server.push(row);assert.throws(()=>accountFavicon(f.x,f.admission),/orphan server row/);});
for(const [label,edit,reason]of [
 ['nested arguments',f=>f.x.server.find(r=>r.kind==='header-call'&&r.name==='writeHead').args[1]['Content-Type']='application/wasm',/original writeHead headers/],
 ['nested setter',f=>f.x.server.find(r=>r.kind==='header-call'&&r.name==='setHeader'&&r.args[0]==='Content-Type').args[1]='wrong',/nested declaration/],
 ['nested return name',f=>f.x.server.find(r=>r.kind==='header-return'&&r.name==='setHeader'&&r.status===404).name='writeHead',/matching header return/],
 ['outer return name',f=>f.x.server.find(r=>r.kind==='header-return'&&r.name==='writeHead').name='setHeader',/matching header return/],
])test('ancillary exact nested control '+label,()=>{const f=fixture();edit(f);assert.throws(()=>accountFavicon(f.x,f.admission),reason);});

for(const [mode,fixture]of [['EMPTY-NATIVE','busy-actions']])test('ancillary admission is absent in '+mode,async()=>{const h=await monitorHarness({mode,fixture});h.monitor.save();const e=h.record().epochs[0];assert.equal(e.ancillaryAdmission,undefined);assert.equal(e.ancillaryFrame,undefined);assert.equal(e.ancillary,undefined);});

const restoredClose=async(h,phase='restart')=>{await h.monitor.closeEpoch();await h.monitor.beforeNavigate();await h.monitor.depart(phase);await h.monitor.beforeServerStop();};
async function restoredPair(change=()=>{}){
 const h=await monitorHarness({mode:'RESTORED-NON-NATIVE',fixture:'restored-reads'});h.originalRequest('/');const first=inject(h);
 const registration=h.monitor.restoredRoute('**/api/v1/assets/image/content','/api/v1/assets/image/content');registration.registered();await restoredClose(h);await h.nextEpoch();
 const second=inject(h,change,2),q=h.originalRequest('/api/v1/assets/image/content'),receipt=registration.hold({request:()=>q,continue:async()=>{}});receipt.release();await receipt.continue();registration.removing();registration.removed();registration.confirmedRestoration();return {h,first,second};
}
const noAncillaryQualification=record=>{for(const k of ['qualified','pwQualified','byteQualified','nativeQualified','wasmQualified','hostFinalQualified','transportQualified','errorWaiver','consumerEOF'])assert.equal(record[k],false);};
test('actual restored monitor accounts exact hidden favicon in both epochs through final shutdown',async()=>{
 const {h,first,second}=await restoredPair(),snapshots=[structuredClone(first),structuredClone(second)];await restoredClose(h,'terminal');await h.monitor.detach();await h.monitor.finish(true);const r=h.record();assert(r.complete);assert.equal(r.epochs.length,2);
 for(const [i,e]of r.epochs.entries()){assert.equal(e.ancillary.records.length,1);noAncillaryQualification(e.ancillary);noAncillaryQualification(e.ancillary.records[0]);assert.equal(e.ancillary.records[0].bodyHash,null);assert.equal(e.ancillary.records[0].pwExposure,false);assert.equal(e.ancillary.records[0].bodyObserved,false);assert(e.ancillaryChecks.length>=5);assert.equal(e.collector,undefined);assert.equal(e.qualification,undefined);assert.equal(e.restoredNative.qualified,false);assert.equal(e.restoredNative.transportQualified,false);assert.equal(e.ancillaryAdmission.frame.loaderId,'document-loader-'+(i+1));}
 assert.deepEqual(first,snapshots[0]);assert.deepEqual(second,snapshots[1]);assert.equal(r.requests.filter(q=>q.url.endsWith('/favicon.ico')).length,0);assert.equal(r.network.filter(n=>n.name==='Network.requestWillBeSent'&&n.params.request.url.endsWith('/favicon.ico')).length,2);assert.equal(h.monitor.qualifies({}),false);assert(!h.calls.some(c=>['Network.getResponseBody','Network.configureDurableMessages'].includes(c.method)));
});
for(const [name,change,reason]of [
 ['foreign frame',({network})=>network.find(n=>n.name==='Network.requestWillBeSent').params.frameId='foreign',/Ancillary frame/],
 ['foreign loader',({network})=>network.find(n=>n.name==='Network.responseReceived').params.loaderId='foreign',/Ancillary loader/],
 ['foreign server',({rows})=>rows.find(r=>r.kind==='request').pid++,/strictly equal/],
 ['query',({rows})=>rows.find(r=>r.kind==='request').url='/favicon.ico?unknown',/exact path/],
 ['missing response',({network})=>network.splice(network.findIndex(n=>n.name==='Network.responseReceived'),1),/Ancillary/],
 ['missing terminal',({network})=>network.splice(network.findIndex(n=>n.name==='Network.loadingFinished'),1),/Ancillary/],
 ['duplicate response',({network})=>network.push(structuredClone(network.find(n=>n.name==='Network.responseReceived'))),/Ancillary/],
 ['ambiguous request',({network})=>network.push(structuredClone(network.find(n=>n.name==='Network.requestWillBeSent'))),/Ancillary/],
 ['orphan server',({rows})=>rows.push({...structuredClone(rows.find(r=>r.kind==='response')),id:9999}),/orphan server row/],
 ['unknown server',({rows,h})=>rows.push({kind:'request',id:9000,pid:h.server.pid,method:'GET',url:'/unknown',requestObject:true,responseObject:true,responseRequestSame:true}),/No orphan server request/],
 ['unknown protocol',({network})=>network.push({name:'Network.requestWillBeSent',params:{requestId:'unknown',request:{url:'http://127.0.0.1:34568/unknown',method:'GET'}}}),/No orphan protocol group/],
 ])test('actual restored ancillary refuses '+name,async()=>{const {h}=await restoredPair(change);await assert.rejects(h.monitor.closeEpoch(),reason);assert.equal(h.record().complete,false);});
for(const [name,change,reason]of [
 ['PW request',({h})=>h.originalRequest('/ordinary',{type:'script'}),/forbids native requests/],
 ['PW response',({h})=>h.originalRequest('/ordinary',{pwResponseHeaders:{'content-type':'application/wasm'}}),/forbids native responses/],
 ['CDP response',({network})=>network.find(n=>n.name==='Network.responseReceivedExtraInfo').params.headers['Content-Type']='application/wasm',/forbids native protocol/],
 ['typed Node outgoing',({rows})=>rows.find(r=>r.kind==='response').headers['content-type']=['text/plain','application/wasm'],/forbids native server/],
 ])test('actual restored native '+name+' is refused before favicon partition',async()=>{const {h}=await restoredPair(change);await assert.rejects(h.monitor.closeEpoch(),reason);const e=h.record().epochs[1];assert.equal(e.ancillary,undefined);assert.equal(e.restoredNative,undefined);assert(!h.calls.some(c=>c.method==='Network.getResponseBody'));});
for(const stage of ['closure','navigation','retained','shutdown'])test('actual restored late ancillary contradiction at '+stage,async()=>{
 const {h,second}=await restoredPair();const change=()=>{second.rows.find(r=>r.kind==='response-close').writableFinished=false;h.saveLedger();};
 if(stage==='closure'){change();await assert.rejects(h.monitor.closeEpoch(),/completed Node response/);}
 else {await h.monitor.closeEpoch();if(stage==='navigation'){change();await assert.rejects(h.monitor.beforeNavigate(),/completed Node response/);}else {await h.monitor.beforeNavigate();await h.monitor.depart('terminal');if(stage==='retained'){change();await assert.rejects(h.monitor.beforeServerStop(),/completed Node response/);}else {await h.monitor.beforeServerStop();await h.monitor.detach();h.onShutdown(change);await assert.rejects(h.monitor.finish(true),/completed Node response/);}}}
 assert.equal(h.record().complete,false);
});
test('EMPTY-NATIVE refuses native work without admitting a hidden favicon exception',async()=>{const h=await monitorHarness({mode:'EMPTY-NATIVE',fixture:'busy-actions'});inject(h);let called=false;await assert.rejects(h.monitor.operation('Preview',async()=>{called=true;}));assert.equal(called,false);h.monitor.save();const e=h.record().epochs[0];assert.equal(e.ancillaryFrame,undefined);assert.equal(e.ancillaryAdmission,undefined);assert.equal(e.ancillary,undefined);assert.equal(h.monitor.qualifies({}),false);});

import {restoredRoutes} from './restored-route.mjs';
import {restoredRouteFlow} from './restored-route-flow.mjs';
const cancelPath='/api/v1/assets/image/content',cancelPattern='**'+cancelPath;
async function canceledFixture(){
 const f=fixture(),events=[],objects=new Map(),rows=[],page={},context={},frame={page:()=>page};page.context=()=>context;page.mainFrame=()=>frame;let sequence=0;
 const ep=i=>({index:i,mode:'RESTORED-NON-NATIVE',fixture:'restored-reads',epoch:i===2?f.x.epoch:'prior',owner:structuredClone(f.x.page),origin:f.admission.origin,pid:f.admission.serverOwner.pid,server:{origin:f.admission.origin,instance:f.admission.serverOwner.instance}}),epochs=[ep(1)];let current=epochs[0];
 const api=restoredRoutes({current:()=>current,epochs:()=>epochs,page,context,id:q=>q.id,objects,rows,events,order:()=>++sequence,fail:()=>{}}),reg=api.register(cancelPattern,cancelPath);reg.registered();current=ep(2);epochs.push(current);api.begin(current);api.activate(current);
 const start=structuredClone(f.x.network.find(n=>n.name==='Network.requestWillBeSent'));start.sequence=++sequence;
 const terminal={sequence:++sequence,controllerSessionLabel:start.controllerSessionLabel,name:'Network.loadingFailed',params:{requestId:start.params.requestId,type:'Other',errorText:'net::ERR_ABORTED',canceled:true}};
 f.x.network=[start,terminal];f.x.server=[];const q={id:1,frame:()=>frame,method:()=> 'GET',url:()=>current.origin+cancelPath};objects.set(1,q);const receipt=reg.hold({request:()=>q,continue:async()=>{}});receipt.release();await receipt.continue();reg.removing();reg.removed();
 f.window=api.ancillaryWindow(current);return f;
}
const canceled=f=>accountFavicon(f.x,f.admission,{cancellation:f.window});
test('observed cancellation uses actual route receipts, retains originals and makes only negative claims',async()=>{
 const f=await canceledFixture(),before=structuredClone(f),r=canceled(f),a=r.account.records[0];assert.equal(a.kind,'OBSERVED-CANCELED-FAVICON-NO-SERVER-WITNESS');assert.equal(a.cancellationCause,'unobserved');assert.equal(a.preNetworkDispatch,'unproved');assert.equal(a.serverWitness,false);assert.equal(a.responseObserved,false);assert.equal(a.bodyHash,null);assert.equal(a.status,undefined);noAncillaryQualification(a);noAncillaryQualification(r.account);assert.equal(r.network.length,0);assert.equal(r.server.length,0);assert.deepEqual(f,before);assert.deepEqual(accountFavicon(f.x,f.admission,{cancellation:f.window,previous:r.account}).account,r.account);
});
const cancellationNegatives=[
 ['no route',f=>f.window=null,/route window required/],['native mode',f=>f.window.mode='NATIVE-COMPLETION',/restored mode only/],['empty mode',f=>f.window.mode='EMPTY-NATIVE',/restored mode only/],['first epoch',f=>f.window.epochIndex=1,/second epoch only/],
 ['foreign window epoch',f=>f.window.epoch='foreign',/strictly equal/],['foreign window owner',f=>f.window.owner.contextId='foreign',/route owner/],['foreign window server',f=>f.window.serverOwner.instance='foreign',/route server/],['wrong route pattern',f=>f.window.pattern='**/*',/strictly equal/],
 ['query',f=>f.x.network[0].params.request.url+='?query',/exact URL/],['fragment',f=>f.x.network[0].params.request.url+='#fragment',/exact URL/],['foreign origin',f=>f.x.network[0].params.request.url='http://foreign/favicon.ico',/exact URL/],
 ['POST',f=>f.x.network[0].params.request.method='POST',/GET/],['wrong type',f=>f.x.network[0].params.type='Fetch',/ancillary type/],['terminal type',f=>f.x.network[1].params.type='Fetch',/terminal type/],['initiator',f=>f.x.network[0].params.initiator={type:'script'},/initiator/],
 ['post data',f=>f.x.network[0].params.request.postData='data',/request body/],['post entries',f=>f.x.network[0].params.request.postDataEntries=[],/request body/],['has post',f=>f.x.network[0].params.request.hasPostData=true,/request body/],
 ['referrer policy',f=>f.x.network[0].params.request.referrerPolicy='unsafe-url',/referrer policy/],['referrer',f=>f.x.network[0].params.request.headers.Referer='http://foreign/',/no referrer/],['content length',f=>f.x.network[0].params.request.headers['content-length']='1',/content length/],['framing',f=>f.x.network[0].params.request.headers['transfer-encoding']='chunked',/no framing/],
 ['native header',f=>f.x.network[0].params.request.headers['content-type']='application/wasm',/native headers/],['native destination',f=>f.x.network[0].params.request.headers['sec-fetch-dest']='worker',/native headers/],
 ['foreign frame',f=>f.x.network[0].params.frameId='foreign',/ancillary frame/],['foreign loader',f=>f.x.network[0].params.loaderId='foreign',/ancillary loader/],['foreign document',f=>f.x.network[0].params.documentURL='http://foreign/',/ancillary document/],['redirect',f=>f.x.network[0].params.redirectResponse={},/no redirect/],
 ['foreign start controller',f=>f.x.network[0].controllerSessionLabel='foreign',/ancillary controller/],['foreign terminal controller',f=>f.x.network[1].controllerSessionLabel='foreign',/ancillary controller/],
 ['other error',f=>f.x.network[1].params.errorText='net::ERR_FAILED',/abort text/],['not canceled',f=>f.x.network[1].params.canceled=false,/canceled flag/],['missing canceled',f=>delete f.x.network[1].params.canceled,/canceled flag/],['blocked reason',f=>f.x.network[1].params.blockedReason='other',/blocked reason/],['cors reason',f=>f.x.network[1].params.corsErrorStatus={},/CORS/],
 ['before window',f=>f.x.network[0].sequence=f.window.begin.sequence-1,/inside observed route window/],['start tie',f=>f.x.network[0].sequence=f.window.begin.sequence,/inside observed route window/],['remove tie',f=>f.x.network[1].sequence=f.window.removing.sequence,/inside observed route window/],['after removal',f=>f.x.network[1].sequence=f.window.removed.sequence+1,/inside observed route window/],['terminal before start',f=>f.x.network[1].sequence=f.x.network[0].sequence,/terminal order/],
 ['missing terminal',f=>f.x.network.pop(),/unique server request/],['foreign terminal ID',f=>f.x.network[1].params.requestId='foreign',/unique server request/],['duplicate start',f=>f.x.network.push(structuredClone(f.x.network[0])),/unique protocol start/],['duplicate terminal',f=>f.x.network.push(structuredClone(f.x.network[1])),/exactly original start/],
 ['reordered originals',f=>f.x.network.reverse(),/original start order/],
 ['foreign default context',f=>f.admission.defaultContext.frameId='foreign',/strictly equal/],['foreign owner',f=>f.x.page.contextId='foreign',/Ancillary owner/],['foreign epoch',f=>f.x.currentEpoch='foreign',/strictly equal/],['source icon',f=>f.admission.source.noStaticIcon=false,/source admission/],['public icon',f=>f.admission.noPublicIconLink=false,/public icon/],['recorder error',f=>f.x.recorder.failures.push({message:'late'}),/recorder errors/],['server identity',f=>f.x.recorder.instance='foreign',/strictly equal/],
];
for(const key of ['registration','begin','removing','removed'])cancellationNegatives.push(['missing '+key,f=>delete f.window[key],/route receipt/]);
for(const name of ['responseReceived','responseReceivedExtraInfo','requestWillBeSentExtraInfo','dataReceived','loadingFinished','requestServedFromCache'])cancellationNegatives.push(['extra '+name,f=>f.x.network.push({name:'Network.'+name,controllerSessionLabel:f.x.network[0].controllerSessionLabel,sequence:99,params:{requestId:f.x.network[0].params.requestId,...name==='responseReceived'?{response:{url:f.admission.origin+'/favicon.ico'}}:{}}}),/exactly original start/]);
for(const channel of ['requests','responses','terminals'])cancellationNegatives.push(['PW '+channel,f=>f.x[channel].push({url:f.admission.origin+'/favicon.ico'}),/no original PW witness/]);
for(const kind of ['request','response','response-close','header-call','header-return'])cancellationNegatives.push(['Node '+kind,f=>f.x.server.push({kind,id:99,path:'/favicon.ico',url:'/favicon.ico'}),kind==='request'?/unique protocol response/:/no retained server witness/]);
for(const [name,change,reason]of cancellationNegatives)test('observed canceled account refuses '+name,async()=>{const f=await canceledFixture();change(f);assert.throws(()=>canceled(f),reason);});
test('canceled observation removes only its two original rows and no unrelated server evidence',async()=>{const f=await canceledFixture(),s={kind:'request',id:99,url:'/ordinary'},n={name:'Network.dataReceived',params:{requestId:'orphan'}};f.x.server.push(s);f.x.network.push(n);const r=canceled(f);assert.equal(r.server[0],s);assert.equal(r.network[0],n);});
test('canceled retained identity is permanent even with balanced replacement',async()=>{const f=await canceledFixture(),previous=canceled(f).account;for(const n of f.x.network)n.params.requestId='replacement';assert.throws(()=>accountFavicon(f.x,f.admission,{cancellation:f.window,previous}),/late identity/);});

async function canceledPair({change=()=>{},during,firstCanceled=false}={}){
 const h=await monitorHarness({mode:'RESTORED-NON-NATIVE',fixture:'restored-reads'});h.originalRequest('/');const first=inject(h);let callback,forwarded=0,removed=0;
 h.page.route=async(p,fn)=>{assert.equal(p,cancelPattern);callback=fn;};h.page.unroute=async p=>{assert.equal(p,cancelPattern);removed++;};
 const registration=h.monitor.restoredRoute(cancelPattern,cancelPath),flow=restoredRouteFlow({page:h.page,pattern:cancelPattern,observer:registration,onHold:()=>{}});await flow.install();await restoredClose(h);await h.nextEpoch();
 const f=fixture(),params=structuredClone(f.x.network.find(n=>n.name==='Network.requestWillBeSent').params);Object.assign(params,{requestId:'canceled-icon-2',frameId:'page',loaderId:'document-loader-2',documentURL:h.server.origin+'/'});params.request.url=h.server.origin+'/favicon.ico';const terminal={requestId:params.requestId,type:'Other',errorText:'net::ERR_ABORTED',canceled:true};change({h,params,terminal});h.pageSession.emit('Network.requestWillBeSent',params);h.pageSession.emit('Network.loadingFailed',terminal);during?.(h);
 const q=h.originalRequest(cancelPath,{deferCallbacks:true}),pending=callback({request:()=>q,continue:async()=>{forwarded++;q.deliver();}});await flow.release();await pending;registration.confirmedRestoration();assert.equal(forwarded,1);assert.equal(removed,1);return {h,first,params,terminal,registration};
}
test('actual restored monitor observes canceled second epoch beside strict404 first, through owned shutdown',async()=>{const {h}=await canceledPair();await restoredClose(h,'terminal');await h.monitor.detach();await h.monitor.finish(true);const r=h.record();assert(r.complete);assert.equal(r.epochs[0].ancillary.records[0].kind,'BROWSER-FAVICON-METADATA');assert.equal(r.epochs[1].ancillary.records[0].kind,'OBSERVED-CANCELED-FAVICON-NO-SERVER-WITNESS');for(const e of r.epochs){assert.equal(e.qualification,undefined);noAncillaryQualification(e.ancillary.records[0]);assert(e.ancillaryChecks.length>=5);}assert.equal(r.network.filter(n=>n.params.requestId==='canceled-icon-2').length,2);assert.equal(r.requests.filter(q=>q.url.endsWith('/favicon.ico')).length,0);assert(!h.calls.some(c=>['Network.getResponseBody','Network.configureDurableMessages'].includes(c.method)));});
for(const [name,change,reason]of [
 ['native CDP',({params})=>params.request.headers['content-type']='application/wasm',/forbids native protocol/],
 ['foreign loader',({params})=>params.loaderId='foreign',/ancillary loader/],['other abort',({terminal})=>terminal.errorText='other',/abort text/],
])test('actual restored canceled monitor refuses '+name,async()=>{const {h}=await canceledPair({change});await assert.rejects(h.monitor.closeEpoch(),reason);assert.equal(h.record().complete,false);});
for(const stage of ['closure','navigation','retained','shutdown'])test('actual canceled account late contradiction at '+stage,async()=>{
 const {h,terminal}=await canceledPair(),change=()=>{terminal.canceled=false;};
 if(stage==='closure'){change();await assert.rejects(h.monitor.closeEpoch(),/canceled flag/);}else{await h.monitor.closeEpoch();if(stage==='navigation'){change();await assert.rejects(h.monitor.beforeNavigate(),/canceled flag/);}else{await h.monitor.beforeNavigate();await h.monitor.depart('terminal');if(stage==='retained'){change();await assert.rejects(h.monitor.beforeServerStop(),/canceled flag/);}else{await h.monitor.beforeServerStop();await h.monitor.detach();h.onShutdown(change);await assert.rejects(h.monitor.finish(true),/canceled flag/);}}}assert.equal(h.record().complete,false);
});
for(const mode of ['NATIVE-COMPLETION','RESTORED-NON-NATIVE'])test('actual no-route canceled observation cannot enter '+mode+' first epoch',async()=>{const h=await monitorHarness({mode,fixture:mode==='EMPTY-NATIVE'?'busy-actions':mode==='RESTORED-NON-NATIVE'?'restored-reads':'combined'});const f=fixture(),p=structuredClone(f.x.network[0].params);Object.assign(p,{requestId:'cancel-first',frameId:'page',loaderId:'document-loader-1',documentURL:h.server.origin+'/'});p.request.url=h.server.origin+'/favicon.ico';h.pageSession.emit('Network.requestWillBeSent',p);h.pageSession.emit('Network.loadingFailed',{requestId:p.requestId,type:'Other',errorText:'net::ERR_ABORTED',canceled:true});await assert.rejects(h.monitor.closeEpoch(),mode==='EMPTY-NATIVE'?/orphan|original|empty|Empty|Unaccounted/:/route window required/);assert.equal(h.record().complete,false);});

test('missing canceled start stays unaccounted for mandatory original-channel refusal',async()=>{const f=await canceledFixture(),terminal=f.x.network.pop();f.x.network=[terminal];const r=canceled(f);assert.equal(r.account.records.length,0);assert.equal(r.network[0],terminal);noAncillaryQualification(r.account);});
for(const channel of ['response','server','PW'])test('canceled account refuses independent foreign '+channel+' witness',async()=>{const f=await canceledFixture();if(channel==='response')f.x.network.push({name:'Network.responseReceived',params:{requestId:'foreign',response:{url:f.admission.origin+'/favicon.ico'}}});if(channel==='server')f.x.server.push({kind:'response',id:99,url:'http://foreign/favicon.ico'});if(channel==='PW')f.x.responses.push({url:'http://foreign/favicon.ico'});assert.throws(()=>canceled(f),/no other favicon protocol witness|no foreign server witness|no original PW witness/);});

test('actual EMPTY monitor has no canceled ancillary admission or qualification',async()=>{const h=await monitorHarness({mode:'EMPTY-NATIVE',fixture:'busy-actions'});const f=await canceledFixture();for(const n of f.x.network)h.pageSession.emit(n.name,n.params);h.monitor.save();const e=h.record().epochs[0];assert.equal(e.ancillaryAdmission,undefined);assert.equal(e.ancillary,undefined);assert.equal(h.monitor.qualifies({}),false);f.window.mode='EMPTY-NATIVE';assert.throws(()=>canceled(f),/restored mode only/);assert.equal(h.record().network.length>=2,true);});

for(const [name,change]of [
 ['default context',f=>f.admission.defaultContext.uniqueId='foreign'],
 ['source hash',f=>f.admission.source.indexSHA256='0'.repeat(64)],
 ['route observation',f=>f.window.removed.callerTick++],
])test('canceled retained metadata cannot mutate by reference: '+name,async()=>{const f=await canceledFixture(),previous=canceled(f).account,snapshot=structuredClone(previous);change(f);assert.deepEqual(previous,snapshot);assert.throws(()=>accountFavicon(f.x,f.admission,{cancellation:f.window,previous}),/late identity/);});
for(const [name,change,reason]of [
 ['native PW',({h})=>h.originalRequest(EXPECTED.wasmPath),/forbids native requests/],
 ['native typed Node',({h})=>{h.originalRequest('/ordinary');h.serverRows.find(r=>r.kind==='response').headers['content-type']=['text/plain','application/wasm'];h.saveLedger();},/forbids native server/],
])test('actual canceled account cannot hide original '+name,async()=>{const {h}=await canceledPair({change});await assert.rejects(h.monitor.closeEpoch(),reason);assert.equal(h.record().epochs[1].ancillary,undefined);});
for(const name of ['PW','Node','response','context','route'])test('actual canceled late '+name+' contradiction cannot be qualified',async()=>{const {h,registration}=await canceledPair();await h.monitor.closeEpoch();if(name==='PW'){const q={testId:900,url:()=>h.server.origin+'/favicon.ico',method:()=> 'GET',resourceType:()=> 'other',redirectedFrom:()=>null,redirectedTo:()=>null,frame:()=>h.page.mainFrame(),allHeaders:async()=>({})};h.context.emit('request',q);}if(name==='Node'){h.serverRows.push({kind:'request',id:999,pid:h.server.pid,url:'/favicon.ico',path:'/favicon.ico',headers:{}});h.saveLedger();}if(name==='response')h.pageSession.emit('Network.responseReceived',{requestId:'canceled-icon-2',response:{url:h.server.origin+'/favicon.ico'}});if(name==='context')h.page.context=()=>({});if(name==='route'){registration.removalFailed(Error('late route contradiction'));h.monitor.save();assert(h.record().errors.some(e=>e.includes('late route contradiction')));}await assert.rejects(h.monitor.beforeNavigate(),name==='PW'?/no original PW witness/:name==='Node'?/unique protocol response/:name==='response'?/exactly original start/:name==='context'?/Original window context/:/Permanent epoch failure/);assert.equal(h.record().complete,false);});
