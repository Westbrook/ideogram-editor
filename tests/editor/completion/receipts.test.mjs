import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {pageReceiptSink} from './page-sink.mjs';
import {emptyNative} from './empty-native.mjs';
import {OriginalSSEFrames} from './sse-frames.mjs';
import {sseDescriptor,ssePublication,sseQualification} from './sse-publication.mjs';
import {recoveryFixture} from './recovery-fixture.mjs';
import {recoveryReaderHarness} from './recovery-reader-harness.mjs';
import {originalRecoveryCompletion} from '../integration-network.mjs';
const clone=structuredClone,origin='http://127.0.0.1:34567';
async function sinkHarness(){const session=new EventEmitter(),receipts=[],errors=[],commands=[];const sink=pageReceiptSink({session,name:'receipt',receipts,fail:e=>errors.push(String(e)),send:async(method,params)=>commands.push({method,params})});await sink.install();const created=(id=1,uniqueId='u1',more={})=>session.emit('Runtime.executionContextCreated',{context:{id,uniqueId,origin,auxData:{isDefault:true,frameId:'frame'},...more}});created();sink.bind({origin,frameId:'frame'},'epoch');const emit=(value,id=1)=>session.emit('Runtime.bindingCalled',{name:'receipt',executionContextId:id,payload:JSON.stringify({origin,epoch:'epoch',deliverySequence:1,kind:'pagehide',observation:{epoch:'epoch',rows:[],errors:[]},...value})});return {sink,session,receipts,errors,commands,created,emit};}
test('actual page sink retains delayed old default-context receipt after destruction without current-epoch lookup',async()=>{const h=await sinkHarness();h.session.emit('Runtime.executionContextDestroyed',{executionContextId:1,executionContextUniqueId:'u1'});h.created(2,'u2');h.sink.bind({origin,frameId:'frame'},'next');h.emit({});assert(h.sink.final('epoch'));assert(!h.sink.final('next'));assert.equal(h.receipts[0].executionContextUniqueId,'u1');await h.sink.remove();assert.equal(h.errors.length,0);});
for(const [label,mutate]of Object.entries({
 'unknown context':h=>h.emit({},9),'wrong epoch':h=>h.emit({epoch:'next'}),'wrong origin':h=>h.emit({origin:'http://other'}),'lost row':h=>h.emit({deliverySequence:2}),'duplicate final':h=>{h.emit({});h.emit({deliverySequence:2});},'post-final activity':h=>{h.emit({});h.emit({deliverySequence:2,kind:'row',row:{}});},'recycled numeric context':h=>{h.session.emit('Runtime.executionContextDestroyed',{executionContextId:1});h.created(1,'u2');h.emit({});},'unbound foreign context':h=>{h.created(2,'u2',{auxData:{isDefault:false,frameId:'frame'}});h.emit({},2);},'wrong default frame':h=>{h.created(2,'u2',{auxData:{isDefault:true,frameId:'other'}});h.emit({},2);},'malformed payload':h=>h.session.emit('Runtime.bindingCalled',{name:'receipt',executionContextId:1,payload:'{'})
}))test('actual page sink permanently refuses '+label,async()=>{const h=await sinkHarness();mutate(h);assert(h.errors.length);assert.throws(()=>h.sink.final('epoch'));await assert.rejects(()=>h.sink.remove());});
test('navigation/context destruction is not a final receipt',async()=>{const h=await sinkHarness();h.session.emit('Runtime.executionContextsCleared',{});assert.equal(h.sink.final('epoch'),false);});

function emptyFixture(){const q={id:1,url:origin+'/api/v1/commands',method:'POST',originalRequestObject:true,frameExposure:{ownerPage:true,ownerContext:true},redirectedFrom:null,redirectedTo:null,actualHeaders:{provisional:'retained'}},p={requestId:1,url:q.url,status:204,originalRequestObject:true,originalPairConfirmed:true,fromServiceWorker:false,actualHeaders:{}},t={requestId:1,url:q.url,kind:'finished',originalRequestObject:true};return {x:{page:{origin},requests:[q],responses:[p],terminals:[t],server:[],network:[]},e:{mode:'EMPTY-NATIVE',fixture:'busy-actions',epoch:'epoch',operations:[],proofs:[],workers:{rows:[]},nativeClosed:{rows:[]},discovery:[]},routes:[{epoch:'epoch',requestId:1,originalRouteRequest:true,hold:1,release:2,continueStarted:3,continueFulfilled:4,command:{body:{type:'SaveCheckpoint'}},publicBefore:{previewDisabled:true,applyDisabled:true,cancelDisabled:false,text:'Keep this draft during checkpoint',acceptedNative:[]},publicAfter:{editorHidden:true,stillHeld:true,commands:[],acceptedNative:[]}}]};}
const assessEmpty=f=>emptyNative(f.x,f.e,f.routes);
test('busy-only result retains provisional headers but cannot confer any positive qualification',()=>{const p=assessEmpty(emptyFixture());for(const k of ['qualified','nativeQualified','byteQualified','wasmQualified'])assert.equal(p[k],false);assert.equal(p.kind,'EMPTY-NATIVE');});
for(const [label,mutate]of Object.entries({
 'unselected fixture':v=>v.e.fixture='combined','fallback mode':v=>v.e.mode='NATIVE-COMPLETION','worker':v=>v.e.workers.rows.push({}),'operation':v=>v.e.operations.push({}),'valid proof':v=>v.e.proofs.push({qualified:true}),'valid bytes':v=>v.e.captures={matchesCompleteSealedWASM:true},'native snapshot':v=>v.e.nativeClosed.rows.push({kind:'created',workerId:1}),'late target':v=>v.e.discovery.push({params:{targetInfo:{type:'worker'}}}),'native request':v=>v.x.requests[0].actualHeaders['sec-fetch-dest']='worker','native wire':v=>v.x.network.push({params:{response:{mimeType:'application/wasm'}}}),'borrowed response':v=>v.x.responses[0].originalPairConfirmed=false,'wrong page':v=>v.x.requests[0].frameExposure.ownerPage=false,'lost terminal':v=>v.x.terminals=[],'wrong terminal':v=>v.x.terminals[0].originalRequestObject=false,'missing hold':v=>delete v.routes[0].hold,'missing release':v=>delete v.routes[0].release,'early continuation':v=>v.routes[0].continueStarted=1,'failed continue':v=>v.routes[0].error='failed','different held Request':v=>v.routes[0].requestId=9,'different command':v=>v.routes[0].command.body.type='CommitTextEdit','disabled Cancel':v=>v.routes[0].publicBefore.cancelDisabled=true,'changed accepted state':v=>v.routes[0].publicAfter.acceptedNative=['changed'],'Cancel after release':v=>v.routes[0].publicAfter.stillHeld=false
}))test('actual EMPTY-NATIVE rejects '+label,()=>{const f=emptyFixture();mutate(f);assert.throws(()=>assessEmpty(f));});

const chunk=(b,at=10)=>({kind:'chunk',readerNumber:1,reads:1,count:b.length,at,frameId:1,document:'document',operation:1,start:1,url:origin+'/api/v1/events/stream?after=0',owners:[{clientId:'client',sessionId:'session'}]});
test('actual SSE parser frames an open stream, multiple frames and exact delivered byte ranges',()=>{const f=recoveryFixture(),s=new OriginalSSEFrames(),bytes=Buffer.concat([f.frame,f.frame]);s.push(chunk(bytes),bytes);assert.equal(s.frames.length,2);assert.deepEqual(s.failures,[]);assert.equal(s.frames[0].byteEnd,f.frame.length);assert.equal(s.frames[1].byteStart,f.frame.length);assert.equal(s.frames[1].byteEnd,bytes.length);assert.equal(s.ended,undefined);});
test('actual SSE parser preserves split UTF-8 and chunk boundaries',()=>{const bytes=Buffer.from('data: {"protocolVersion":1,"kind":"framing-only","label":"é🧭"}\n\n'),s=new OriginalSSEFrames();let count=0,reads=0;for(const byte of bytes){count++;reads++;s.push({...chunk(bytes),count,reads},Buffer.from([byte]));}assert.equal(s.frames[0].value.label,'é🧭');assert.equal(s.frames[0].byteEnd,bytes.length);assert.deepEqual(s.failures,[]);});
for(const [label,bytes]of [['malformed',Buffer.from('bad\n\n')],['overflow',Buffer.from('data: '+'x'.repeat(65665))],['invalid UTF8',Buffer.from([0xff,10,10])],['duplicate data',Buffer.from('data: {}\ndata: {}\n\n')]])test('actual SSE parser refuses '+label,()=>{const s=new OriginalSSEFrames();s.push(chunk(bytes),bytes);assert(s.failures.length);});
test('actual SSE parser cannot promote a partial frame or lost/repeated original read',()=>{for(const mode of ['partial','lost','repeated','other reader']){const f=recoveryFixture(),s=new OriginalSSEFrames(),b=f.frame.subarray(0,-1),e=chunk(b);if(mode==='lost')e.reads=2;if(mode==='other reader')e.readerNumber=2;s.push(e,b);if(mode==='repeated')s.push(e,b);s.finish({...e,reads:2});assert(s.failures.length);assert.equal(s.frames.length,0);}});

function publicationFixture(){const f=recoveryFixture(),s=new OriginalSSEFrames();s.push(chunk(f.frame),f.frame);const c={...s.frames[0],parserFailures:[],headers:{type:'text/event-stream'},status:200,responseURL:origin+'/api/v1/events/stream?after=0'},d={control:c,owner:f.reference,recovery:f.reference.recovery,content:f.reference.content};
 const proof={...c,readerCount:1,association:'unique-frame-time-window',responseStatus:200,redirectedFrom:null,browserResponseURL:c.url};const e={frameId:1,document:'document',start:15,end:20,owners:clone(c.owners)};
 const final={...e,owners:clone(e.owners),end:30,url:origin+'/api/v1/events?after=2&recoveryId=recovery_fixture',value:f.final,originalProof:{association:'unique-frame-time-window',responseStatus:200,redirectedFrom:null,readerCount:1}};
 const writes=f.values.map((v,i)=>({...e,kind:'publication-writes',db:'ie-projection-client',at:25+i,transaction:i+1,records:[{store:'rows',key:['generation','event',v.eventId],value:v.workspaceSeq},{store:'rows',key:['generation','document',f.doc.id],value:i?f.finalDocument:f.doc}]}));writes.push({...e,kind:'publication-writes',db:'ie-projection-client',at:40,transaction:3,records:[{store:'meta',key:'published',value:{generation:'generation',cursor:'2',epoch:'1'},at:39}]});
 return {e,d,values:f.values,controls:[final],committed:writes,aborted:[],events:[],cachePrefix:'ie-projection-',proof};}
test('actual SSE branch accepts exact toSeq publication beside later batches and later stream abort',()=>{const f=publicationFixture();Object.assign(f.proof,{earlyCancel:true,readError:true,protocolFailure:{errorText:'net::ERR_ABORTED'}});sseDescriptor(f.d,f.proof);const p=ssePublication(f);assert.equal(p.publication.value.cursor,'2');assert.equal(p.finalCheck.value.nextCursor,'3');assert.equal(p.eventWrites.length,2);});
test('actual SSE descriptor accepts the pinned server charset media type',()=>{const f=publicationFixture();f.proof.headers.type='text/event-stream; charset=utf-8';sseDescriptor(f.d,f.proof);f.proof.headers.type='application/json';assert.throws(()=>sseDescriptor(f.d,f.proof));});
for(const [label,mutate]of Object.entries({
 'wrong offered boundary':f=>f.d.control.offeredId='3','wrong reader':f=>f.proof.readerCount=2,'malformed frames':f=>f.d.control.parserFailures=['bad'],'wrong schema':f=>f.d.recovery.projectionSchema=0,'wrong content URL':f=>f.d.content.url+='x','wrong frame range':f=>f.d.control.byteEnd=999999,'missing original response':f=>f.proof.responseStatus=undefined,'cloned response':f=>f.proof.cloned=true
}))test('actual SSE descriptor refuses '+label,()=>{const f=publicationFixture();mutate(f);assert.throws(()=>sseDescriptor(f.d,f.proof));});
for(const [label,mutate]of Object.entries({
 'wrong client':f=>f.e.owners=[{clientId:'other',sessionId:'session'}],'wrong session':f=>f.e.owners[0].sessionId='other','wrong frame':f=>f.e.frameId=2,'wrong epoch':f=>f.e.document='next','no final':f=>f.controls=[],'wrong validation cursor':f=>f.controls[0].url=f.controls[0].url.replace('after=2','after=3'),'failed validation response':f=>f.controls[0].originalProof.responseStatus=503,'wrong validation context':f=>f.controls[0].value={...f.controls[0].value,recovery:{...f.controls[0].value.recovery,writerEpoch:'2'}},'revalidation clone':f=>f.controls[0].originalProof.cloned=true,'uncommitted generation':f=>f.committed.pop(),'later cursor':f=>f.committed[2].records[0].value.cursor='3','wrong publication epoch':f=>f.committed[2].records[0].value.epoch='2','wrong generation':f=>f.committed[2].records[0].value.generation='other','missing event marker':f=>f.committed[0].records.shift(),'wrong event transaction':f=>f.committed[0].transaction=undefined,'missing intermediate document':f=>f.committed[0].records.pop(),'wrong document transaction':f=>{f.committed[0].records.pop();},'conflicting publication':f=>f.committed.push({...clone(f.committed[2]),at:35}),'aborted generation':f=>f.aborted.push({...clone(f.committed[0]),kind:'publication-aborted'}),'later root recovery':f=>f.events.push({...f.e,kind:'start',start:21,url:origin+'/api/v1/events?after=0'}),'later SSE recovery':f=>f.events.push({...f.e,kind:'start',start:21,url:origin+'/api/v1/events/stream?after=0'}),'equal hash other recovery':f=>f.d.recovery={...f.d.recovery,recoveryId:'other'}
}))test('actual SSE publication refuses '+label,()=>{const f=publicationFixture();mutate(f);assert.throws(()=>ssePublication(f));});
test('SSE qualification cannot be claimed from a flag or an HTTP publication',()=>{assert.equal(sseQualification({validationKind:'sse-reference-publication',validated:true}),false);assert.equal(sseQualification({validationKind:'recovery-publication'}),false);});

test('SSE reference keeps an earlier frame publication before its own content request distinct',()=>{const f=publicationFixture(),prior=clone(f.committed[2]);prior.at=12;prior.records[0].value={generation:'previous',cursor:'0',epoch:'1'};f.committed.unshift(prior);assert.equal(ssePublication(f).publication.value.cursor,'2');prior.at=22;assert.throws(()=>ssePublication(f));});

test('immutable event writer epochs may precede the current recovery writer epoch',()=>{const f=publicationFixture();for(const v of f.values)v.writerEpoch='0';assert.equal(ssePublication(f).publication.value.epoch,'1');});

test('SSE imported events require corresponding committed namespace writes before their markers',()=>{const f=publicationFixture(),v=f.values[0];v.type='BundleImported';v.payload={namespaceId:'namespace',namespaceHash:'sha256:'+'a'.repeat(64),source:{hash:'sha256:'+'b'.repeat(64),byteLength:'4',mediaType:'application/x-ideogram-project'},document:v.payload.document};const ns={...clone(f.committed[0]),at:24,transaction:4,records:[{store:'rows',key:['generation','namespace','namespace'],value:{eventId:v.eventId,namespaceHash:v.payload.namespaceHash}}]};f.committed.unshift(ns);assert.equal(ssePublication(f).eventWrites.length,2);ns.records[0].value.namespaceHash='sha256:'+'c'.repeat(64);assert.throws(()=>ssePublication(f));ns.records[0].value.namespaceHash=v.payload.namespaceHash;ns.at=29;assert.throws(()=>ssePublication(f));});

function boundedPublicationFixture(){
 const f=publicationFixture();f.e.operation=2;
 const root={kind:'start',frameId:1,document:'document',operation:4,start:50,method:'GET',url:origin+'/api/v1/events?after=2',owners:clone(f.e.owners)};
 const proof={...clone(root),kind:'response',responseURL:root.url,browserResponseURL:root.url,responseAt:51,requestStart:50.5,requestId:4,requestFrame:1,association:'unique-frame-time-window',eligibleRequests:[4],concurrentOperations:[],redirectedFrom:null,redirected:false,fromServiceWorker:false};
 f.events.push(root);f.rootStarts=[{...clone(root),originalProof:proof}];
 const later=clone(f.committed.at(-1));later.at=60;later.transaction=4;later.records[0].value.generation='later';f.committed.push(later);return f;
}
test('actual SSE assessor bounds the first publication by the uniquely owned original next root without changing retained rows',()=>{
 const f=boundedPublicationFixture(),before=clone(f),p=ssePublication(f);assert.equal(p.publication.completedAt,40);assert.equal(p.nextRecoveryStart,50);assert.equal(p.referenceWindow.starts[0].originalProof.requestId,4);assert.deepEqual(f,before);
});
test('actual SSE assessor supports a later original stream start and excludes foreign frame/document/origin roots',()=>{
 for(const path of ['/api/v1/events?after=2','/api/v1/events/stream?after=2']){const f=boundedPublicationFixture();for(const x of [f.events[0],f.rootStarts[0],f.rootStarts[0].originalProof])x.url=origin+path;f.rootStarts[0].originalProof.responseURL=f.rootStarts[0].originalProof.browserResponseURL=origin+path;for(const delta of [{frameId:2},{document:'foreign'},{url:'http://foreign/api/v1/events?after=0'}])f.events.push({...clone(f.events[0]),start:21,...delta});assert.equal(ssePublication(f).nextRecoveryStart,50);}
});
for(const [label,mutate,reason]of [
 ['duplicate inside window',f=>f.committed.push({...clone(f.committed[2]),at:41,transaction:5}),'One committed publication'],
 ['later only',f=>f.committed.splice(2,1),'One committed publication'],
 ['competing before commit',f=>{for(const x of [f.events[0],f.rootStarts[0],f.rootStarts[0].originalProof])x.start=35;f.rootStarts[0].originalProof.responseAt=36;f.rootStarts[0].originalProof.requestStart=35.5;},'One committed publication'],
 ['absent boundary',f=>{f.events=[];f.rootStarts=[];},'One committed publication'],
 ['missing original association',f=>f.rootStarts=[],'One committed publication'],
 ['foreign earliest owner',f=>f.events[0].owners[0].clientId='other','One committed publication'],
 ['foreign earliest session',f=>f.events[0].owners[0].sessionId='other','One committed publication'],
 ['ambiguous earliest time',f=>f.events.push({...clone(f.events[0]),operation:5}),'One committed publication'],
 ['duplicate root association',f=>f.rootStarts.push(clone(f.rootStarts[0])),'One committed publication'],
 ['foreign earliest then convenient later',f=>{f.events[0].owners[0].sessionId='foreign';f.events.push({...clone(f.rootStarts[0]),start:55,operation:6});f.rootStarts.push({...clone(f.rootStarts[0]),start:55,operation:6});},'One committed publication'],
 ['tied publication and start',f=>f.committed[2].at=50,'One committed publication'],
 ['tied descriptor and start',f=>f.events[0].start=f.d.control.end,'Root start order'],
 ['missing start time',f=>f.events[0].start=NaN,'Finite original root start'],
 ['forged original request id',f=>f.rootStarts[0].originalProof.requestId=99,'One committed publication'],
 ['multiple original requests',f=>f.rootStarts[0].originalProof.eligibleRequests.push(9),'One committed publication'],
 ['overlapping original operation',f=>f.rootStarts[0].originalProof.concurrentOperations=[5],'One committed publication'],
 ['forged original frame',f=>f.rootStarts[0].originalProof.requestFrame=2,'One committed publication'],
 ['forged document',f=>f.rootStarts[0].originalProof.document='other','One committed publication'],
 ['forged operation',f=>f.rootStarts[0].originalProof.operation=5,'One committed publication'],
 ['forged original browser response',f=>f.rootStarts[0].originalProof.browserResponseURL+='x','One committed publication'],
 ['forged observed response URL',f=>f.rootStarts[0].originalProof.responseURL+='x','One committed publication'],
 ['forged original URL',f=>f.rootStarts[0].originalProof.url+='x','One committed publication'],
 ['forged owner on original response',f=>f.rootStarts[0].originalProof.owners[0].sessionId='foreign','One committed publication'],
 ['response before original start',f=>f.rootStarts[0].originalProof.responseAt=49,'One committed publication'],
 ['request outside original window',f=>f.rootStarts[0].originalProof.requestStart=60,'One committed publication'],
 ['redirected root',f=>f.rootStarts[0].originalProof.redirectedFrom='http://foreign','One committed publication'],
 ['service worker root',f=>f.rootStarts[0].originalProof.fromServiceWorker=true,'One committed publication'],
 ['lost generation',f=>f.committed[2].records[0].value.generation='foreign','One committed original event marker'],
 ['lost original event',f=>f.committed[0].records.shift(),'One committed original event marker'],
 ['lost original document',f=>f.committed[0].records.pop(),'Corresponding committed document write'],
 ['aborted generation',f=>f.aborted.push({...clone(f.committed[0]),kind:'publication-aborted'}),'Aborted generation'],
 ['conflicting earlier pointer',f=>{const p=clone(f.committed[2]);p.at=22;p.records[0].value.cursor='0';f.committed.push(p);},'No conflicting publication']
])test('bounded actual SSE assessor refuses '+label,()=>{const f=boundedPublicationFixture();mutate(f);assert.throws(()=>ssePublication(f),new RegExp(reason));});
test('unproved later root retains a valid isolated publication without inventing a bound',()=>{const f=boundedPublicationFixture();f.committed.pop();f.rootStarts=[];const p=ssePublication(f);assert.equal(p.publication.completedAt,40);assert.equal(p.nextRecoveryStart,null);});

async function boundedReader(mutate=()=>{}){
 const h=await recoveryReaderHarness();const r=await h.scenario({mutate:(events,send)=>{
  const base=clone(events.find(e=>e.kind==='start'&&e.operation===3));Object.assign(base,{operation:4,start:50,responseAt:51,url:origin+'/api/v1/events?after=2',responseURL:origin+'/api/v1/events?after=2'});
  const q={testId:44,url:()=>base.url,method:()=> 'GET',frame:()=>h.frame,timing:()=>({startTime:50.5}),redirectedFrom:()=>null,failure:()=>null};
  const response={request:()=>q,status:()=>200,url:()=>base.url,headers:()=>({'content-type':'application/json','cache-control':'no-store'}),finished:async()=>null,fromServiceWorker:()=>false};h.context.emit('request',q);h.context.emit('response',response);send({...base,kind:'start'});send({...base,kind:'response'});
  const later=clone(events.find(e=>e.kind==='publication-writes'&&e.transaction===3));later.transaction=4;later.at=60;later.records[0].value.generation='later';send(later);mutate(events,h,q,base);
 }});return r;
}
const failedRecovery=p=>({channel:'requestfailed',resourceType:'fetch',failure:{errorText:'net::ERR_ABORTED'},method:'GET',requestId:p.requestId,url:p.url,response:{requestId:p.requestId,url:p.url,method:'GET',status:200,contentType:'application/x-ndjson',contentLength:String(p.bytes),etag:'"sha256:'+p.sha256+'"'}});
test('actual original reader assembles next-root identity and unchanged final classifier rechecks the bounded claim',async()=>{
 const r=await boundedReader();assert.deepEqual(r.errors,[]);const p=r.proofs[0];assert.equal(p.validated,true,p.validationError);assert.equal(p.nextRecoveryStart,50);assert.equal(p.referenceWindow.starts[0].originalProof.requestId,44);assert.equal(originalRecoveryCompletion(failedRecovery(p),[p]),true);
 for(const mutate of [p=>p.nextRecoveryStart=60,p=>p.nextRecoveryStart=null,p=>p.referenceWindow.starts[0].originalProof.requestId=99,p=>p.referenceWindow.starts[0].owners[0].sessionId='other',p=>p.referenceWindow.starts[0].originalProof.document='foreign',p=>p.referenceWindow.starts[0].originalProof.operation=9,p=>p.referenceWindow.starts.push(clone(p.referenceWindow.starts[0])),p=>p.publication.completedAt=50,p=>p.descriptor.at=50,p=>delete p.referenceWindow,p=>p.eventWrites=[],p=>p.publication.value.generation='',p=>p.publication.value.generation='foreign',p=>p.publication.value.epoch='other']){const x=clone(p);mutate(x);assert.equal(originalRecoveryCompletion(failedRecovery(p),[x]),false,mutate.toString());}
});
for(const [label,mutate]of Object.entries({
 'missing original response observation':es=>es.splice(es.findIndex(e=>e.kind==='response'&&e.operation===4),1),
 'foreign response owner':es=>es.find(e=>e.kind==='response'&&e.operation===4).owners[0].sessionId='foreign',
 'duplicate original Request':(es,h,q)=>h.context.emit('request',{...q,testId:45}),
 'earlier unproved root':es=>es.push({...clone(es.find(e=>e.kind==='start'&&e.operation===4)),operation:5,start:45}),
 'duplicate own publication':es=>es.push({...clone(es.find(e=>e.kind==='publication-writes'&&e.transaction===3)),transaction:5,at:41})
}))test('actual original reader keeps '+label+' unqualified',async()=>{const r=await boundedReader(mutate),p=r.proofs[0];assert.equal(p.validated,false);assert.equal(originalRecoveryCompletion(failedRecovery(p),[p]),false);});


for(const schema of [2,3,4,5,6,7,8,9])test('LP'+schema+' original SSE descriptor and publication retain old exact events',()=>{
 const f=publicationFixture();f.d.recovery.projectionSchema=schema;f.controls[0].value.recovery.projectionSchema=schema;sseDescriptor(f.d,f.proof);assert.equal(ssePublication(f).validated,true);
});
test('original SSE qualification rejects future or mixed recovery versions',()=>{
 const future=publicationFixture();future.d.recovery.projectionSchema=10;assert.throws(()=>sseDescriptor(future.d,future.proof));assert.throws(()=>ssePublication(future));
 const mixed=publicationFixture();mixed.d.recovery.projectionSchema=9;mixed.controls[0].value.recovery={...mixed.controls[0].value.recovery,projectionSchema:8};assert.throws(()=>ssePublication(mixed));
});
test('original SSE qualification refuses metadata mislabeled LP8 and accepts the same typed payload under LP9',()=>{
 const f=publicationFixture(),metadata={schemaVersion:1,name:'Café 東京',creationBackground:{kind:'transparent'}};
 f.values[0].payload.document.metadata=metadata;f.committed[1].records.find(r=>r.key[1]==='document').value.metadata=metadata;
 assert.throws(()=>ssePublication(f));f.d.recovery.projectionSchema=9;f.controls[0].value.recovery.projectionSchema=9;assert.equal(ssePublication(f).validated,true);
});
