import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {partitionHostTraffic} from './host-final-traffic.mjs';
import {monitorHarness} from './monitor-harness.mjs';
import {hostFixture,injectedHostFinal} from './host-final-fixtures.mjs';
import {privateServerRows} from './header-fixtures.mjs';
const saved=JSON.parse(readFileSync(new URL('./host-final282.json',import.meta.url))),clone=structuredClone;
function exposed(post='full',get='full'){
 const x=clone(saved),r=x.host.registrations[0];
 for(const [index,mode]of [post,get].entries()){
  const receipt=index?x.host.documents[0]:x.host.bodies[0],url=x.origin+receipt.path,id='private.'+index,pwId=index+100,status=receipt.responseStatus,headers=index?{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'none'; base-uri 'none'; frame-ancestors 'none'"}:{},responseHeaders={...headers,date:'Mon, 28 Sep 2026 13:00:00 GMT',connection:'close',...index?{'transfer-encoding':'chunked'}:{}};
  if(mode==='none')continue;
  x.network.push({name:'Network.responseReceived',params:{requestId:id,frameId:r.context.frameId,response:{url,status,headers:responseHeaders}}});
  if(mode==='partial')continue;
  x.requests.push({id:pwId,url,method:receipt.method,originalRequestObject:true,redirectedFrom:null,redirectedTo:null,frameExposure:{ownerPage:true,ownerFrame:true,ownerContext:true},actualHeaders:clone(receipt.headers)});
  x.responses.push({requestId:pwId,url,status,originalRequestObject:true,originalPairConfirmed:true,fromServiceWorker:false,actualHeaders:clone(responseHeaders)});x.terminals.push({requestId:pwId,url,kind:'finished',originalRequestObject:true});
  x.network.push({name:'Network.requestWillBeSent',params:{requestId:id,frameId:r.context.frameId,request:{url,method:receipt.method,headers:clone(receipt.headers)}}},{name:'Network.requestWillBeSentExtraInfo',params:{requestId:id,headers:clone(receipt.headers)}},{name:'Network.responseReceivedExtraInfo',params:{requestId:id,statusCode:status,headers:clone(responseHeaders)}},{name:'Network.loadingFinished',params:{requestId:id,encodedDataLength:200}});
 }
 return x;
}
for(const post of ['full','partial','none'])for(const get of ['full','partial','none'])test('saved282 original header ledger with simulated POST '+post+' GET '+get,()=>{
 const result=partitionHostTraffic(exposed(post,get));assert.equal(result.private.records.length,2);const getRow=result.private.records.find(r=>r.kind==='receiver');assert.equal(getRow.headerEvidence.declared['content-type'],'text/html; charset=utf-8');assert.deepEqual(getRow.headerEvidence.getHeaders,{});assert.equal(getRow.headerEvidence.call.name,'writeHead');assert(result.private.records.every(r=>r.qualified===false));assert.equal(result.network.length,0);
});
const faults={
 orphanID:x=>x.server.push({...clone(x.server[1]),id:999,sequence:999}),orphanURL:x=>x.server.push({...clone(x.server[1]),id:999,path:'/elsewhere',sequence:999}),orphanPath:x=>x.server.push({...clone(x.server[1]),id:999,url:'/elsewhere',sequence:999}),
 missingCall:x=>x.server.splice(1,1),missingReturn:x=>x.server.splice(2,1),duplicateCall:x=>x.server.splice(2,0,clone(x.server[1])),
 failedCall:x=>x.server[2].kind='header-throw',wrongMethod:x=>x.server[1].method='GET',wrongURL:x=>x.server[1].url='/elsewhere',wrongPID:x=>x.server[1].pid++,wrongServer:x=>x.server[1].serverId++,wrongPath:x=>x.server[1].path='/elsewhere',wrongObject:x=>x.server[1].sameResponseObject=false,wrongReturnObject:x=>x.server[2].returnIsResponse=false,wrongReturnName:x=>x.server[2].name='setHeader',unsent:x=>x.server[2].headersSent=false,wrongStatusBefore:x=>x.server[1].statusBefore=503,wrongWrittenStatus:x=>x.server[1].args[0]=503,
 impossibleGetHeaders:x=>x.server[7].headers={'content-type':'text/html; charset=utf-8'},changedDrain:x=>x.server[9].headers={unknown:'yes'},progressiveCall:x=>x.server[1].name='setHeader',ambiguousHeaders:x=>x.server[6].args[1]['content-type']='other',outOfOrder:x=>x.server[2].sequence=x.server[1].sequence,
 conflictingDeclaredHeader:x=>x.server[6].args[1]['Content-Type']='text/plain',missingDeclaredHeader:x=>delete x.server[6].args[1]['Content-Type'],unattributedCSP:x=>x.responses[0].actualHeaders['content-security-policy']='other',foreignExtraInfo:x=>x.network.find(n=>n.name==='Network.responseReceivedExtraInfo').params.statusCode=503,
 bodylessChunked:x=>x.network[0].params.response.headers['transfer-encoding']='chunked',bodylessLength:x=>x.network[0].params.response.headers['content-length']='0',bodyData:x=>x.network.push({name:'Network.dataReceived',params:{requestId:'private.0',dataLength:1,encodedDataLength:0}}),
 splitFraming:x=>{x.server[6].args[1]['Content-Length']='72';x.network.find(n=>n.params.requestId==='private.1'&&n.name==='Network.responseReceivedExtraInfo').params.headers['content-length']='72';},
 keepAliveClose:x=>x.network[0].params.response.headers['keep-alive']='timeout=5',malformedDate:x=>x.network[0].params.response.headers.date='Monday',crossSourceDate:x=>x.responses[0].actualHeaders.date='Mon, 28 Sep 2026 14:00:00 GMT',
 laterHeaderWrite:x=>x.server.push({...clone(x.server[6]),sequence:999}),ownerlessDrain:x=>delete x.server[9].responseRequestSame,
};
for(const [name,change]of Object.entries(faults))test('actual partition refuses header/framing '+name,()=>{const x=exposed();change(x);assert.throws(()=>partitionHostTraffic(x));});
test('204 encoded wire length is retained without inventing consumed body bytes',()=>{const x=exposed();x.network.push({name:'Network.dataReceived',params:{requestId:'private.0',dataLength:0,encodedDataLength:50}});assert.equal(partitionHostTraffic(x).private.records.length,2);});
for(const kind of ['chunked','body-data'])test('actual monitor refuses late204 '+kind,async()=>{
 let h;const factory=async args=>{const base=await injectedHostFinal(args);return {...base,async depart(e){await base.depart(e);const f=hostFixture(e),r=f.registration,b=f.body,d={...clone(b),id:2,path:r.receiver,method:'GET',responseStatus:200,inert:true};e.hostSnapshot={run:r.run,origin:r.origin,pid:r.pid,instance:r.instance,errors:[],registrations:[r],bodies:[b],documents:[d]};h.serverRows.push(...privateServerRows(b,1),...privateServerRows(d,2));h.saveLedger();h.pageSession.emit('Network.responseReceived',{requestId:'private',response:{url:r.origin+r.path,status:204,headers:{}}});}};};
 h=await monitorHarness({hostFactory:factory});await h.monitor.closeEpoch();await h.monitor.beforeNavigate();await h.pagehide();await h.monitor.beforeServerStop();
 if(kind==='chunked')h.pageSession.emit('Network.responseReceivedExtraInfo',{requestId:'private',statusCode:204,headers:{'transfer-encoding':'chunked'}});else h.pageSession.emit('Network.dataReceived',{requestId:'private',dataLength:1,encodedDataLength:0});
 await h.monitor.detach();await assert.rejects(()=>h.monitor.finish(true),/Bodyless204/);assert.equal(h.record().complete,false);
});

async function closed(){const h=await monitorHarness();await h.monitor.closeEpoch();await h.monitor.beforeNavigate();await h.pagehide();await h.monitor.detach();return h;}
function assertSaved(h,label){const e=h.record().epochs[0],s=e.shutdownEvidence;assert.equal(s.epoch,e.epoch);assert.equal(s.pid,h.server.pid);assert.equal(s.instance,h.server.instance);assert.equal(s.origin,h.server.origin);assert.deepEqual(s.owner,e.owner);assert.deepEqual(s.shutdown,h.server.shutdown);assert.deepEqual(s.lifecycle,h.server.lifecycle);if(process.env.EDITOR_RECEIPT){const dir=join(process.env.EDITOR_RECEIPT,'monitor-save-readbacks');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,label+'.json'),JSON.stringify({scope:'Actual monitor serialization with explicitly injected NON-BROWSER lifecycle inputs',monitorPath:h.out,record:h.record()},null,2),{flag:'wx'});}return s;}
test('actual monitor save/readback retains complete graceful shutdown and correlated envelope',async()=>{const h=await closed();await h.monitor.finish(true);const s=assertSaved(h,'graceful');assert.equal(s.shutdown.reply.recorder.after.phase,'closed');assert.equal(s.lifecycle.messages[0].type,'close-injected-control');assert.deepEqual(s.lifecycle.messages[0].value,s.shutdown.reply);assert.deepEqual(s.shutdown.exit,{code:0,signal:null});});
test('actual monitor save/readback keeps abrupt last-live SIGKILL with no after sample',async()=>{const h=await closed();h.onShutdownReceipt((s,rows)=>{rows.pop();s.shutdown={mode:'restart',errors:[],attempts:[{mode:'restart'}],exit:{code:null,signal:'SIGKILL'},reply:{type:'completion-closed',cleanupOnly:false,serverClosed:false,failures:[],recorder:{kind:'abrupt',before:s.shutdown.reply.recorder.before}}};s.lifecycle.exit=clone(s.shutdown.exit);s.lifecycle.messages=[{type:'close-injected-restart',value:clone(s.shutdown.reply)}];});await h.monitor.finish(true);const s=assertSaved(h,'abrupt');assert.equal(s.shutdown.reply.serverClosed,false);assert.equal(s.shutdown.reply.recorder.kind,'abrupt');assert.equal(s.shutdown.reply.recorder.after,undefined);assert.equal(s.shutdown.exit.signal,'SIGKILL');});
const shutdownFaults={cleanupOnly:s=>s.shutdown.reply.cleanupOnly=true,refused:s=>s.shutdown.reply.type='close-refused',parentError:s=>s.shutdown.errors.push({phase:'close',message:'retained original error'}),childError:s=>s.shutdown.reply.failures.push({phase:'server-close',message:'retained child failure'}),afterError:s=>s.shutdown.reply.recorder.after.failures.push({message:'late observer failure'}),missingExit:s=>delete s.shutdown.exit,missingAfter:s=>delete s.shutdown.reply.recorder.after,missingReceipt:s=>s.shutdown=null};
for(const [name,change]of Object.entries(shutdownFaults))test('actual monitor retains rejected '+name+' shutdown receipt',async()=>{const h=await closed();h.onShutdownReceipt(change);await assert.rejects(()=>h.monitor.finish(true));assertSaved(h,name);assert.equal(h.record().complete,false);});
