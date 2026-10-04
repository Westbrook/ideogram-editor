import test from 'node:test';
import assert from 'node:assert/strict';
import {projectFirefoxProfile, isFirefoxProfileProjection} from './firefox-profile-projection.mjs';

// Synthetic raw Gecko36 schema from the pinned native sources, never a real profile.
// Categories are copied from profiling_categories.yaml, not from projector internals.
const categories = [{"name":"Idle","subcategories":["Other"]},{"name":"Other","subcategories":["Other","Preference Read","Profiling"]},{"name":"Test","subcategories":["Test"]},{"name":"Layout","subcategories":["Other","Frame construction","Reflow","CSS parsing","Selector query","Style computation","Layout cleanup","Printing"]},{"name":"JavaScript","subcategories":["Other","Parsing","JIT Compile (baseline)","JIT Compile (ion)","Interpreter","JIT (baseline-interpreter)","JIT (baseline)","JIT (ion)","Builtin API","Wasm (ion)","Wasm (baseline)","Wasm (other)"]},{"name":"GC / CC","subcategories":["Other","Minor GC","Major GC (Other)","Major GC (Mark)","Major GC (Sweep)","Major GC (Compact)","Unmark Gray","Barrier","CC (Free Snow White)","CC (Build Graph)","CC (Scan Roots)","CC (Collect White)","CC (Finalize)"]},{"name":"Network","subcategories":["Other"]},{"name":"Graphics","subcategories":["Other","DisplayList building","DisplayList merging","Layer building","Tile allocation","WebRender display list","Rasterization","Flushing async paints","Image decoding","WebGPU","VSync triggered animation"]},{"name":"DOM","subcategories":["Other"]},{"name":"Android","subcategories":["Other"]},{"name":"AndroidX","subcategories":["Other"]},{"name":"Java","subcategories":["Other"]},{"name":"Mozilla","subcategories":["Other"]},{"name":"Kotlin","subcategories":["Other"]},{"name":"Blocked","subcategories":["Other"]},{"name":"Mailnews","subcategories":["Other"]},{"name":"IPC","subcategories":["Other"]},{"name":"Media","subcategories":["Other","Cubeb","Playback","Real-time rendering"]},{"name":"Accessibility","subcategories":["Other"]},{"name":"Profiler","subcategories":["Other"]},{"name":"Timer","subcategories":["Other"]},{"name":"Remote-Protocol","subcategories":["Other"]},{"name":"Sandbox","subcategories":["Other"]},{"name":"Telemetry","subcategories":["Other"]},{"name":"ML","subcategories":["Other","Inference","Setup"]},{"name":"Logs","subcategories":["Other"]}];
const epoch = 1700000000000;
const context = () => ({p4WallMs:epoch+1100,realmTimeOriginMs:epoch,f5WallMs:epoch+1000,f5MonotonicMs:1000,f6WallMs:epoch+1400,f6MonotonicMs:1400,queueReadEntryMonotonicMs:1125,queueReadCallbackMonotonicMs:1375});
const meta = startTime => ({version:36,startTime,profilingStartTime:0,contentEarliestTime:0,profilingEndTime:200000,shutdownTime:200000,categories:structuredClone(categories),configuration:{capacity:16777216,interval:4,activeTabID:0,features:['js','stackwalk','nomarkerstacks'],threads:['GeckoMain']}});
function fixture() {
 const marker = (name,time) => [0,time,0,0,8,{type:'UserTiming',name,entryType:'mark',innerWindowID:77}];
 const thread = {name:'GeckoMain',processType:'tab',stringTable:['UserTiming','PRIVATE_FUNCTION https://private.invalid/?token=SECRET','baseline'],
  samples:{schema:{stack:0,time:1,eventDelay:2,argumentValues:3,threadCPUDelta:4},data:[[0,5599],[0,5600],[1,6100],[2,6250],[3,6375],[4,6500],[5,6600],[null,6700],[0,7100],[0,7101]]},
  stackTable:{schema:{prefix:0,frame:1},data:[[null,0],[0,1],[1,2],[null,3],[null,4],[null,5]]},
  frameTable:{schema:{location:0,relevantForJS:1,innerWindowID:2,implementation:3,line:4,column:5,category:6,subcategory:7},data:[[1,true,77,2,9,3,4,0],[1,false,77,null,null,null,3,0],[1,false,77,null,null,null,5,0],[1,false,77,null,null,null,0,0],[1,false,77,null,null,null,2,0],[1,false,0]]},
  markers:{schema:{name:0,startTime:1,endTime:2,phase:3,category:4,data:5},data:[marker('p25.F5',6000),marker('p25.F6',6400),[1,6002,0,0,1]]}};
 return {meta:meta(epoch-100000),threads:[],processes:[{meta:meta(epoch-5000),threads:[thread],processes:[]}]};
}
const child = p => p.processes[0];
const thread = p => child(p).threads[0];
async function* chunks(value, sizes=[16384]) {
 const bytes=typeof value==='string'?Buffer.from(value):value;let offset=0,index=0;
 while(offset<bytes.length){const size=sizes[index++%sizes.length];yield bytes.subarray(offset,offset+size);offset+=size;}
}
const project = (profile=fixture(), c=context(), sizes) => projectFirefoxProfile(chunks(JSON.stringify(profile),sizes),c);
function safe(result) {
 assert.equal(isFirefoxProfileProjection(result),true);
 assert.equal(result.coverage,'NOT_CERTIFIED');assert.equal(result.attribution,'UNATTRIBUTED');assert.equal(result.timingQualified,false);
 assert.ok(Buffer.byteLength(JSON.stringify(result))<=262144);assert.ok(result.numericBytesPeak<=16777216);
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE_|SECRET|private\.invalid|file:\/\/|Bearer|UserTiming|GeckoMain|p25\.F[56]/);
 return result;
}
function status(result, expected, reason) {
 safe(result);assert.equal(result.status,expected);assert.equal(result.reason,reason);
 if(expected!=='projected'){assert.deepEqual(result.samples,[]);assert.equal(result.alignment,null);assert.equal(result.sampleCount,0);assert.deepEqual(result.categoryCounts,[0,0,0,0,0,0]);}
}

test('raw36 uses the selected child epoch and root-to-leaf categories without timing or native attribution',async()=>{
 const result=safe(await project());status(result,'projected','NONE');
 assert.deepEqual(result.samples,[[-500,[3]],[0,[3,2]],[150,[3,2,4]],[275,[0]],[400,[1]],[500,[5]],[600,[]],[1000,[3]]]);
 assert.deepEqual(result.categoryCounts,[1,1,1,2,1,2]);assert.equal(result.sampleCount,8);
 assert.deepEqual(result.alignment,{f5ResidualMs:0,f6ResidualMs:0,deltaResidualMs:0,wallClockUnitMs:1,clockUncertaintyMs:null});
 assert.equal(result.rawBytes,Buffer.byteLength(JSON.stringify(fixture())));
});

test('arbitrary byte, UTF8 and escape boundaries preserve the same safe projection',async()=>{
 const profile=fixture();profile.private={url:'PRIVATE_東京😀',escaped:'PRIVATE_\\\"\n\t\u0000',headers:{Authorization:'Bearer SECRET'}};
 const raw=JSON.stringify(profile).replace('PRIVATE_東京😀','PRIVATE_\\u6771\\u4eac\\ud83d\\ude00');
 const expected=safe(await projectFirefoxProfile(chunks(raw),context()));
 for(const sizes of [[1],[2,3,5,7],[16383,1]])assert.deepEqual(safe(await projectFirefoxProfile(chunks(raw,sizes),context())),expected);
 const utf8=JSON.stringify(profile);assert.deepEqual((await projectFirefoxProfile(chunks(utf8,[1]),context())).samples,expected.samples);
});

test('native table order, exact feature permutations and absent optional cells remain admissible',async()=>{
 const p=fixture(),t=thread(p);child(p).meta.configuration.features=['nomarkerstacks','js','stackwalk'];
 t.samples.data=t.samples.data.map(row=>[...row,null,17,null]);
 const reordered={markers:t.markers,frameTable:t.frameTable,stackTable:t.stackTable,samples:t.samples,stringTable:t.stringTable,processType:t.processType,name:t.name};
 child(p).threads=[reordered];status(await project(p),'projected','NONE');
 assert.deepEqual((await project(p)).samples,(await project()).samples);
});

for(const feature of ['__proto__','constructor','toString','screenshots','default'])test(`unrequested or inherited feature ${feature} cannot stand in for a native feature`,async()=>{
 const p=fixture();child(p).meta.configuration.features=['js','stackwalk','nomarkerstacks',feature];status(await project(p),'refused','CONFIG_INVALID');
});

test('feature omission, duplication and native capacity or thread-filter changes refuse attribution',async()=>{
 for(const alter of [c=>c.features.pop(),c=>c.features.push('js'),c=>c.capacity++,c=>c.interval=1,c=>c.interval=2,c=>c.threads.push('GeckoMain'),c=>c.threads=['PRIVATE_THREAD']]){
  const p=fixture();alter(child(p).meta.configuration);status(await project(p),'refused','CONFIG_INVALID');
 }
});

test('raw private metadata, frame locations and non-target marker payloads never escape',async()=>{
 const p=fixture(),t=thread(p);p.private={path:'file:///PRIVATE_PATH',headers:{Authorization:'Bearer SECRET'},source:'PRIVATE_SOURCE',environment:'PRIVATE_ENV'};
 t.pid=991827;t.tid=773619;t.stringTable.push('PRIVATE_TITLE');t.markers.data.push([3,6200,0,0,1,{type:'PRIVATE_MARKER',name:'PRIVATE_PAYLOAD',url:'https://private.invalid/?token=SECRET'}]);
 const result=safe(await project(p));status(result,'projected','NONE');assert.deepEqual(result.samples,(await project()).samples);
 assert.doesNotMatch(JSON.stringify(result),/991827|773619/);
});

test('input failures are sanitized and parser refusal closes its owned async iterator',async()=>{
 const poison=new Error('PRIVATE_ERROR Bearer SECRET');let closed=0,secondRead=0;
 async function* broken(){try{yield Buffer.from('{');throw poison;}finally{closed++;}}
 status(await projectFirefoxProfile(broken(),context()),'refused','INPUT_FAILURE');assert.equal(closed,1);
 async function* malformed(){try{yield Buffer.from('!');secondRead++;yield Buffer.from('PRIVATE_LATE');}finally{closed++;}}
 status(await projectFirefoxProfile(malformed(),context()),'refused','JSON_INVALID');assert.equal(secondRead,0);assert.equal(closed,2);
 async function* nonbytes(){yield 'PRIVATE_NOT_BYTES';}
 status(await projectFirefoxProfile(nonbytes(),context()),'refused','INPUT_FAILURE');
});

test('parsing drains before delayed context and rejected context supplies no guessed authority',async()=>{
 let complete=false,resolveContext;const delayed=new Promise(resolve=>{resolveContext=resolve;});
 const raw=Buffer.from(JSON.stringify(fixture()));async function* input(){yield raw;complete=true;}
 const pending=projectFirefoxProfile(input(),delayed);let settled=false;pending.then(()=>{settled=true;});
 try{for(let i=0;i<20&&!complete;i++)await Promise.resolve();assert.equal(complete,true);await Promise.resolve();assert.equal(settled,false);}finally{resolveContext(context());}
 status(await pending,'projected','NONE');
 status(await project(fixture(),Promise.reject(new Error('PRIVATE_CONTEXT SECRET'))),'unknown','CONTEXT_UNAVAILABLE');
 status(await project(fixture(),null),'unknown','CONTEXT_UNAVAILABLE');
});

test('malformed UTF8, truncated or trailing JSON, duplicate critical keys and invalid tokens refuse safely',async()=>{
 const raw=JSON.stringify(fixture());
 for(const bytes of [Buffer.from(raw.slice(0,-1)),Buffer.from(raw+' {}'),Buffer.from(raw.replace('"version":36','"version":36,"version":36')),Buffer.from(raw.replace('"version":36','"version":1e999')),Buffer.from('{"private":"\\q"}'),Buffer.from([123,34,120,34,58,34,0xc3,0x28,34,125])]){
  const result=await projectFirefoxProfile(chunks(bytes,[3,5]),context());safe(result);assert.equal(result.status,'refused');assert.ok(['JSON_INVALID','SCHEMA_INVALID'].includes(result.reason));
 }
});

for(const [label,alter] of [
 ['schema column swap',p=>{thread(p).samples.schema.stack=1;}],
 ['missing schema column',p=>{delete thread(p).frameTable.schema.subcategory;}],
 ['extra frame cell',p=>thread(p).frameTable.data[0].push(0)],
 ['short marker row',p=>thread(p).markers.data.push([1,6000,0,0])],
 ['selected UserTiming category',p=>{thread(p).markers.data[0][4]=4;}],
 ['category reorder',p=>{child(p).meta.categories.reverse();}],
 ['subcategory drift',p=>{child(p).meta.categories[4].subcategories[0]='PRIVATE_SUBCATEGORY';}],
])test(`native schema refusal: ${label}`,async()=>{const p=fixture();alter(p);status(await project(p),'refused','SCHEMA_INVALID');});

for(const [label,alter] of [
 ['stack cycle',p=>{thread(p).stackTable.data[0][0]=2;}],
 ['missing frame',p=>{thread(p).stackTable.data[0][1]=99;}],
 ['missing location',p=>{thread(p).frameTable.data[0][0]=99;}],
 ['missing implementation',p=>{thread(p).frameTable.data[0][3]=99;}],
 ['category index',p=>{thread(p).frameTable.data[0][6]=26;}],
 ['negative sample index',p=>{thread(p).samples.data[0][0]=-1;}],
 ['decreasing samples',p=>{thread(p).samples.data.reverse();}],
 ['wrong mark name index',p=>{thread(p).markers.data[0][0]=1;}],
])test(`native reference refusal: ${label}`,async()=>{const p=fixture();alter(p);status(await project(p),'refused','REFERENCE_INVALID');});

test('unsupported raw version and malformed same-run context never yield a sampled target',async()=>{
 const p=fixture();p.meta.version=35;status(await project(p),'refused','VERSION_UNSUPPORTED');
 for(const alter of [c=>c.extra=0,c=>delete c.p4WallMs,c=>c.p4WallMs=NaN,c=>c.f6WallMs=-1,c=>c.f5WallMs+=6,c=>c.p4WallMs=c.f6WallMs+1,c=>c.queueReadCallbackMonotonicMs=1401,c=>c.queueReadEntryMonotonicMs=999]){
  const c=context();alter(c);status(await project(fixture(),c),'refused','CONTEXT_INVALID');
 }
});

test('target selection requires unique same-window content main-thread marks and matching frame ownership',async()=>{
 const absent=fixture();thread(absent).markers.data=[];status(await project(absent),'unknown','TARGET_UNAVAILABLE');
 const parent=fixture();thread(parent).processType='default';status(await project(parent),'unknown','TARGET_UNAVAILABLE');
 for(const alter of [p=>thread(p).markers.data.push(structuredClone(thread(p).markers.data[0])),p=>{thread(p).markers.data[1][5].innerWindowID=78;},p=>p.processes.push(structuredClone(child(p))),p=>{thread(p).frameTable.data[0][2]=78;}]){
  const p=fixture();alter(p);status(await project(p),'unknown','TARGET_AMBIGUOUS');
 }
});

test('clock tolerance admits a bounded residual but refuses wrong child epochs and divergent mark deltas',async()=>{
 const edge=fixture();child(edge).meta.startTime+=5;const result=await project(edge);status(result,'projected','NONE');assert.equal(result.alignment.f5ResidualMs,5);assert.equal(result.alignment.f6ResidualMs,5);assert.equal(result.alignment.clockUncertaintyMs,null);
 for(const alter of [p=>{child(p).meta.startTime+=6;},p=>{child(p).meta.startTime=p.meta.startTime;},p=>{thread(p).markers.data[1][1]+=6;}]){
  const p=fixture();alter(p);status(await project(p),'unknown','CLOCK_UNKNOWN');
 }
});

test('metadata and bracketing samples cannot certify an interval with no selected critical sample',async()=>{
 for(const alter of [p=>{delete child(p).meta.contentEarliestTime;},p=>{child(p).meta.profilingStartTime=6001;},p=>{child(p).meta.shutdownTime=6399;},p=>{thread(p).samples.data=[[0,6250]];},p=>{thread(p).samples.data=[[0,6000],[0,6400]];},p=>{thread(p).samples.data=[];}]){
  const p=fixture();alter(p);status(await project(p),'unknown','COVERAGE_UNKNOWN');
 }
});

test('raw stream ceiling admits the exact byte boundary and refuses one more without spill',async()=>{
 const raw=Buffer.from(JSON.stringify(fixture()));
 async function* padded(total){yield raw;let left=total-raw.length;const spaces=Buffer.alloc(16384,32);while(left){const n=Math.min(left,spaces.length);yield spaces.subarray(0,n);left-=n;}}
 const exact=await projectFirefoxProfile(padded(16777216),context());status(exact,'projected','NONE');assert.equal(exact.rawBytes,16777216);
 const over=await projectFirefoxProfile(padded(16777217),context());status(over,'refused','RAW_LIMIT');assert.ok(over.rawBytes<=16777216);
 status(await projectFirefoxProfile((async function*(){yield Buffer.alloc(16385,32);})(),context()),'refused','CHUNK_LIMIT');
});

test('token and nesting ceilings reject hostile discarded metadata before retaining unbounded content',async()=>{
 const raw=JSON.stringify(fixture());
 for(const value of ['"'+('x'.repeat(16385))+'"','1'.repeat(33),'['.repeat(48)+'0'+']'.repeat(48)]){
  const result=await projectFirefoxProfile(chunks(raw.slice(0,-1)+',"private":'+value+'}',[16384]),context());safe(result);assert.equal(result.status,'refused');assert.ok(['TOKEN_LIMIT','DEPTH_LIMIT'].includes(result.reason));
 }
 const within=raw.slice(0,-1)+',"private":'+'['.repeat(47)+'0'+']'.repeat(47)+'}';status(await projectFirefoxProfile(chunks(within),context()),'projected','NONE');
});

test('value and native table cardinality ceilings apply even to irrelevant profile data',async()=>{
 const raw='{"private":['+'0,'.repeat(1000000)+'0]}';status(await projectFirefoxProfile(chunks(raw),context()),'refused','VALUE_LIMIT');
 for(const alter of [p=>{thread(p).stringTable=Array(100001).fill('PRIVATE_ROW');},p=>{p.pages=Array.from({length:257},()=>({url:'PRIVATE_PAGE'}));},p=>{p.processes=Array.from({length:8},()=>({meta:meta(epoch),threads:[],processes:[]}));},p=>{child(p).threads=Array.from({length:65},()=>structuredClone(thread(fixture())));}]){
  const p=fixture();alter(p);status(await project(p),'refused','ROW_LIMIT');
 }
});

test('selected sample and stack ceilings refuse instead of truncating a successful projection',async()=>{
 const boundary=fixture();thread(boundary).samples.data=[[0,6000],...Array.from({length:9998},()=>[0,6250]),[0,6400]];const admitted=await project(boundary);status(admitted,'projected','NONE');assert.equal(admitted.sampleCount,10000);
 thread(boundary).samples.data.splice(1,0,[0,6250]);status(await project(boundary),'refused','OUTPUT_LIMIT');
 for(const [depth,count] of [[129,3],[128,513]]){
  const p=fixture(),t=thread(p);t.stackTable.data=Array.from({length:depth},(_,i)=>[i?i-1:null,0]);t.samples.data=Array.from({length:count},(_,i)=>[depth-1,i===0?6000:i===count-1?6400:6250]);status(await project(p),'refused','OUTPUT_LIMIT');
 }
});

test('IPC validation rejects forged privacy, timing, counts, order and unknown keys',async()=>{
 const good=await project();assert.equal(isFirefoxProfileProjection(good),true);
 for(const alter of [v=>v.private='SECRET',v=>v.coverage='COMPLETE',v=>v.attribution='NATIVE',v=>v.timingQualified=true,v=>v.reason='PRIVATE_ERROR',v=>v.categoryCounts[0]++,v=>v.samples.reverse(),v=>v.samples[0][1].push(6),v=>v.alignment.clockUncertaintyMs=0,v=>v.alignment.f5ResidualMs=6,v=>v.rawBytes=16777217,v=>v.numericBytesPeak=16777217]){
  const v=structuredClone(good);alter(v);assert.equal(isFirefoxProfileProjection(v),false);
 }
 const evil={get schema(){throw Error('PRIVATE_GETTER');}};assert.equal(isFirefoxProfileProjection(evil),false);
});


test('scalar-only native roles cannot silently compact object or array entries',async()=>{
 for(const alter of [p=>child(p).meta.configuration.features.push({}),p=>child(p).meta.configuration.threads.push([]),p=>thread(p).stringTable.unshift({private:'SECRET'}),p=>{thread(p).samples.schema.stack={};},p=>{child(p).meta.categories[4].subcategories[0]=[];}]){
  const p=fixture();alter(p);status(await project(p),'refused','SCHEMA_INVALID');
 }
});


test('actual native active-tab and duration metadata must match the unrestricted fixed request',async()=>{
 for(const alter of [c=>{delete c.activeTabID;},c=>{c.activeTabID=77;},c=>{c.activeTabID={};},c=>{c.duration=0;},c=>{c.duration=null;},c=>{c.duration=[];}]){
  const p=fixture();alter(child(p).meta.configuration);status(await project(p),'refused','CONFIG_INVALID');
 }
});
