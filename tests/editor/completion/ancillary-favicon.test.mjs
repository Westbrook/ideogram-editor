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

function inject(h,change=()=>{}){
 const f=fixture(),origin=h.server.origin;
 const replace=v=>JSON.parse(JSON.stringify(v).replaceAll(f.admission.origin,origin).replaceAll(new URL(f.admission.origin).host,new URL(origin).host).replaceAll(f.admission.frame.id,'page').replaceAll(f.admission.frame.loaderId,'document-loader-1'));
 const rows=replace(f.x.server),network=replace(f.x.network);
 for(const r of rows){r.pid=h.server.pid;r.id=7001;if(r.kind==='request')r.localPort=Number(new URL(origin).port);}
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

for(const [mode,fixture]of [['EMPTY-NATIVE','busy-actions'],['RESTORED-NON-NATIVE','restored-reads']])test('ancillary admission is absent in '+mode,async()=>{const h=await monitorHarness({mode,fixture});h.monitor.save();const e=h.record().epochs[0];assert.equal(e.ancillaryAdmission,undefined);assert.equal(e.ancillaryFrame,undefined);assert.equal(e.ancillary,undefined);});
