import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {CompositionMemory} from '../../dist/local/server/storage/composition-memory.js';
import {validateCommit,validateCommitAsync,withLayerValues} from '../../dist/local/server/storage/composition.js';
import {assertCurrentCompositionText} from '../../dist/local/server/storage/composition-text.js';
import {StoreError} from '../../dist/local/server/storage/errors.js';
import {canonical} from '../../dist/local/src/protocol/json.js';
import {emptyComposition,emptyElement,linkField,serialize} from '../../dist/local/src/composition/core.js';
import {exportCompositionText} from '../../dist/local/src/composition/text-export.js';
import {newV45Draft} from '../../dist/local/src/request/family.js';

const MiB=1024**2,gates=new Set(),actions=new Set(),memories=new Set();
const defer=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});const gate={promise,resolve};gates.add(gate);promise.then(()=>gates.delete(gate));return gate;};
const track=p=>{actions.add(p);p.then(()=>actions.delete(p),()=>actions.delete(p));return p;};
function budget(){let rss=0,other=0,memory;memory=new CompositionMemory(()=>memory.bytes+other,()=>rss);memories.add(memory);return {memory,setRSS:value=>{rss=value;},setOther:value=>{other=value;}};}
test.afterEach(async()=>{for(const gate of gates)gate.resolve();await Promise.allSettled([...actions]);actions.clear();for(const memory of memories)assert.equal(memory.bytes,0,'all actual consumers drained');memories.clear();});
function fixture({count=1,text='retained native heading',review=false}={}){
 const objects=new Map(),reads=[];
 const put=(value,mediaType='application/json')=>{const bytes=Buffer.isBuffer(value)?value:Buffer.from(value),ref={hash:'sha256:'+createHash('sha256').update(bytes).digest('hex'),byteLength:String(bytes.length),mediaType};objects.set(ref.hash,bytes);return ref;};
 const read=ref=>{reads.push(ref.hash);const bytes=objects.get(ref.hash);if(!bytes||bytes.byteLength!==Number(ref.byteLength)||'sha256:'+createHash('sha256').update(bytes).digest('hex')!==ref.hash)throw new StoreError('CORRUPT_OBJECT');return Uint8Array.from(bytes);};
 const textRef=put(text,'text/plain'),source=put(canonical({text:{frame:{width:80,height:40},textUtf8:textRef}}));
 const layers=Array.from({length:count},(_,i)=>({id:'layer_'+i,version:'1',kind:'text',name:'Native layer',assetId:'asset',source,layerToDocument:[1,0,0,1,0,0],opacity:1,visible:true,locked:false,appearanceDescription:'native',blend:'normal',mask:null}));
 const state={schemaVersion:5,width:100,height:100,composition:null,layers},c=emptyComposition(100,100,'next_composition'),bindings={};
 const values=layers.map(l=>({id:l.id,version:l.version,kind:l.kind,text,appearance:l.appearanceDescription,bounds:{rect:[0,0,80,40],transform:l.layerToDocument}}));
 if(review){const e=emptyElement('text','heading');e.text=linkField('text-content',values[0]);c.elements=[e];bindings.layer_0='layer_0';const result=serialize(c,values,bindings);c.review={serializer:'caption-json-1',sourceId:c.id,frame:structuredClone(c.frame),request:structuredClone(c.request),dependencies:result.dependencies,boxes:result.boxes,prompt:put(result.prompt,'text/plain')};}
 const next={id:c.id,value:put(canonical(c)),bindings},asset=()=>({id:'asset',raster:{width:80,height:40}});
 const run=(memory,reader=read)=>memory.compositions([next,state.composition],()=>validateCommit(review?'ApprovePromptProjection':'CommitCompositionVersion',next,state,reader,asset,memory));
 return {objects,reads,put,read,textRef,source,state,c,next,values,asset,run};
}

test('a tiny Composition with100 full native layers books decoded payload through the last row',()=>{
 const f=fixture({count:100,text:'x'.repeat(16384)}),{memory}=budget();let consumed=false,assetReads=0;
 withLayerValues(f.state,ref=>{assert(memory.bytes>=100*32768);return f.read(ref);},id=>{assetReads++;assert(memory.bytes>=100*32768);return f.asset(id);},memory,values=>{
  consumed=true;assert.equal(values.length,100);assert.equal(values[99].text.length,16384);assert(memory.bytes>=100*32768);
 });
 assert(consumed);assert.equal(assetReads,100);assert.equal(memory.bytes,0);assert(Number(f.next.value.byteLength)<1024);
});
test('shared raster/text debt and actual RSS refuse native allocation before asset or source IO',()=>{
 const f=fixture(),b=budget();let touched=false;const never=()=>{touched=true;throw Error('unadmitted IO');};
 for(const useRSS of [false,true]){b.setRSS(useRSS?511*MiB:0);b.setOther(useRSS?0:511*MiB);assert.throws(()=>withLayerValues(f.state,never,never,b.memory,()=>assert.fail()),/CAPACITY/);assert.equal(touched,false);assert.equal(b.memory.bytes,0);}
});
test('commit keeps native owner alive through final projection proof, and refunds after proof failure',()=>{
 const f=fixture({review:true}),{memory}=budget(),graphBytes=Number(f.next.value.byteLength)*12+MiB;let finalRead=false;
 f.run(memory,ref=>{assert(memory.bytes>graphBytes);if(ref.hash===f.c.review.prompt.hash)finalRead=true;return f.read(ref);});assert(finalRead);assert.equal(memory.bytes,0);
 const failure=new Error('last proof failed');assert.throws(()=>f.run(memory,ref=>{if(ref.hash===f.c.review.prompt.hash){assert(memory.bytes>graphBytes);throw failure;}return f.read(ref);}),error=>error===failure);assert.equal(memory.bytes,0);
});
test('native source and literal bounds are checked before their respective reads',()=>{
 for(const size of ['65537','999999999999999999999']){const f=fixture(),{memory}=budget();f.state.layers[0].source={...f.source,byteLength:size};let reads=0;assert.throws(()=>withLayerValues(f.state,()=>{reads++;assert.fail('oversized source read');},f.asset,memory,()=>assert.fail()),/PAYLOAD_TOO_LARGE/);assert.equal(reads,0);assert.equal(memory.bytes,0);}
 for(const size of ['16385','999999999999999999999']){const f=fixture(),{memory}=budget();f.state.layers[0].source=f.put(canonical({text:{frame:{width:80,height:40},textUtf8:{...f.textRef,byteLength:size}}}));assert.throws(()=>withLayerValues(f.state,f.read,f.asset,memory,()=>assert.fail()),/PAYLOAD_TOO_LARGE/);assert.equal(f.reads.includes(f.textRef.hash),false);assert.equal(memory.bytes,0);}
});
test('invalid dimensions and invalid UTF8 fail without leaving partially decoded rows charged',()=>{
 for(const invalidFrame of [true,false]){const f=fixture(),{memory}=budget();const literal=invalidFrame?f.textRef:f.put(Buffer.from([0xff]),'text/plain');f.state.layers[0].source=f.put(canonical({text:{frame:{width:invalidFrame?8193:80,height:40},textUtf8:literal}}));assert.throws(()=>withLayerValues(f.state,f.read,f.asset,memory,()=>assert.fail()));if(invalidFrame)assert.equal(f.reads.includes(literal.hash),false);assert.equal(memory.bytes,0);}
});
test('101 layers refuse before semantic IO and callback exceptions release all100 rows',()=>{
 const f=fixture({count:101}),{memory}=budget();let read=false;assert.throws(()=>withLayerValues(f.state,()=>{read=true;assert.fail();},f.asset,memory,()=>assert.fail()),/CAPACITY/);assert.equal(read,false);
 f.state.layers.pop();const failure=new Error('consumer failed');assert.throws(()=>withLayerValues(f.state,f.read,f.asset,memory,()=>{throw failure;}),error=>error===failure);assert.equal(memory.bytes,0);
});
test('current Composition text review joins graph/native owners and preserves stale-source refusal',()=>{
 const f=fixture({review:true}),{memory}=budget(),exported=exportCompositionText(f.c,f.values,f.next.bindings),prompt={mode:'plain',text:f.put(exported.prompt,'text/plain'),projection:exported.review,composition:f.next},draft=newV45Draft(prompt.text);draft.prompt=prompt;f.state.composition=f.next;
 let nativeRead=false;assertCurrentCompositionText(draft,f.state,ref=>{if(ref.hash===f.textRef.hash){nativeRead=true;assert(memory.bytes>4*MiB);}return f.read(ref);},f.asset,memory);assert(nativeRead);assert.equal(memory.bytes,0);
 f.state.composition={...f.next,id:'changed'};let called=false;assert.throws(()=>assertCurrentCompositionText(draft,f.state,()=>{called=true;assert.fail();},f.asset,memory),error=>error.issues?.[0]?.code==='COMPOSITION_TEXT_CHANGED');assert.equal(called,false);assert.equal(memory.bytes,0);
});
test('portable transition owns prior inputs while its native text read is pending, through final validation',async()=>{
 const f=fixture({review:true}),{memory}=budget(),entered=defer(),resume=defer();let settled=false,atNative=0,assetReads=0;
 const pending=track(validateCommitAsync('ApprovePromptProjection',f.next,f.state,async ref=>{assert(memory.bytes>0);if(ref.hash===f.textRef.hash){atNative=memory.bytes;entered.resolve();await resume.promise;}return f.read(ref);},id=>{assetReads++;assert(memory.bytes>atNative);return f.asset(id);},memory,()=>{}).finally(()=>{settled=true;}));
 try{await Promise.race([entered.promise,pending.then(()=>{throw Error('consumer settled before read barrier');})]);assert.equal(settled,false);assert(atNative>2*MiB+Number(f.source.byteLength)+Number(f.textRef.byteLength));assert.equal(memory.bytes,atNative);resume.resolve();await pending;assert.equal(assetReads,1);assert.equal(memory.bytes,0);}finally{resume.resolve();await pending.catch(()=>{});}
});
test('portable cancellation during read drains the actual read before releasing cache or graph',async()=>{
 const f=fixture(),{memory}=budget(),entered=defer(),resume=defer(),failure=new Error('READ_CONTEXT_EXPIRED');let current=true,settled=false;
 const pending=track(validateCommitAsync('CommitCompositionVersion',f.next,f.state,async ref=>{if(ref.hash===f.textRef.hash){entered.resolve();await resume.promise;}return f.read(ref);},f.asset,memory,()=>{if(!current)throw failure;}).finally(()=>{settled=true;}));
 try{await Promise.race([entered.promise,pending.then(()=>{throw Error('consumer settled before read barrier');})]);current=false;assert.equal(settled,false);assert(memory.bytes>0);resume.resolve();await assert.rejects(pending,error=>error===failure);assert.equal(memory.bytes,0);}finally{resume.resolve();await pending.catch(()=>{});}
});
test('portable read failure and malformed source drain retained predecessor inputs',async()=>{
 for(const malformed of [false,true]){const f=fixture(),{memory}=budget(),failure=new StoreError('STORAGE_FAILURE');if(malformed)f.state.layers[0].source=f.put('{}');let sourceRead=false;
  await assert.rejects(track(validateCommitAsync('CommitCompositionVersion',f.next,f.state,async ref=>{assert(memory.bytes>0);if(ref.hash===f.state.layers[0].source.hash){sourceRead=true;if(!malformed)throw failure;}return f.read(ref);},f.asset,memory,()=>{})),error=>malformed?error instanceof StoreError:error===failure);assert(sourceRead);assert.equal(memory.bytes,0);
 }
});
test('portable prospective cache growth refuses before the next reader allocates',async()=>{
 const f=fixture({text:'x'.repeat(16384)}),b=budget();let literalRead=false;
 await assert.rejects(track(validateCommitAsync('CommitCompositionVersion',f.next,f.state,async ref=>{if(ref.hash===f.textRef.hash)literalRead=true;const bytes=f.read(ref);if(ref.hash===f.source.hash)b.setOther(512*MiB-b.memory.bytes-1);return bytes;},f.asset,b.memory,()=>{})),/CAPACITY/);assert.equal(literalRead,false);assert.equal(b.memory.bytes,0);
});
test('portable duplicate inputs reuse one admitted buffer but malformed retained length is refused',async()=>{
 const f=fixture({count:100}),{memory}=budget();await track(validateCommitAsync('CommitCompositionVersion',f.next,f.state,async ref=>f.read(ref),f.asset,memory,()=>{}));assert.equal(f.reads.filter(hash=>hash===f.source.hash).length,1);assert.equal(f.reads.filter(hash=>hash===f.textRef.hash).length,1);assert.equal(memory.bytes,0);
 f.state.layers[1].source={...f.source,byteLength:String(Number(f.source.byteLength)+1)};await assert.rejects(track(validateCommitAsync('CommitCompositionVersion',f.next,f.state,async ref=>f.read(ref),f.asset,memory,()=>{})),/CORRUPT_OBJECT/);assert.equal(memory.bytes,0);
});
test('portable cache count and input ceiling refuse before unbounded reads, release prior reservations',async()=>{
 const {memory}=budget(),empty={hash:'sha256:'+'0'.repeat(64),byteLength:'0',mediaType:'application/json'};let retained;
 await assert.rejects(memory.commitCache(async reserve=>{retained=reserve;for(let i=0;i<205;i++)reserve(empty);}),/CAPACITY/);assert.equal(memory.bytes,0);assert.throws(()=>retained(empty),/CLOSED/);
 await assert.rejects(memory.commitCache(async reserve=>reserve({...empty,byteLength:'8388609'})),/PAYLOAD_TOO_LARGE/);assert.equal(memory.bytes,0);
});

test('impossible oversized reviewed caption refuses before sync or portable prompt IO',async()=>{
 const f=fixture({review:true}),{memory}=budget();f.c.review.prompt={...f.c.review.prompt,byteLength:'262145'};f.next.value=f.put(canonical(f.c));let promptReads=0;
 const read=ref=>{if(ref.hash===f.c.review.prompt.hash){promptReads++;assert.fail('oversized review read');}return f.read(ref);};
 assert.throws(()=>f.run(memory,read),/PAYLOAD_TOO_LARGE/);assert.equal(promptReads,0);assert.equal(memory.bytes,0);
 await assert.rejects(track(validateCommitAsync('ApprovePromptProjection',f.next,f.state,async ref=>read(ref),f.asset,memory,()=>{})),/PAYLOAD_TOO_LARGE/);assert.equal(promptReads,0);assert.equal(memory.bytes,0);
});
test('portable extraction preserves canonical-byte checks for graph and native source',async()=>{
 for(const source of [false,true]){const f=fixture(),{memory}=budget();if(source)f.state.layers[0].source=f.put(' '+canonical({text:{frame:{width:80,height:40},textUtf8:f.textRef}}));else f.next.value=f.put(' '+canonical(f.c));
  await assert.rejects(track(validateCommitAsync('CommitCompositionVersion',f.next,f.state,async ref=>f.read(ref),f.asset,memory,()=>{})),/MALFORMED_REQUEST/);assert.equal(memory.bytes,0);assert.equal(f.reads.includes(f.textRef.hash),false);
 }
});


// These deterministic API samples exercise the real default constructor path.
// They are admission/ownership controls, never physical RSS or speed evidence.
import {adapterResources as rssAdmissionResources} from '../../dist/local/server/observability/adapter-resources.js';
const rssOwnership=()=>{const s=rssAdmissionResources.snapshot();return {backingBytes:s.backingBytes,reservedBytes:s.reservedBytes,activeLeases:s.activeLeases,returnedBuffers:s.returnedBuffers,droppedTransitions:s.droppedTransitions,uncoveredOwners:s.uncoveredOwners};};
function withCompositionRSSMethods({rss,full=()=>assert.fail('Default admission must not collect the full memory report')},run){
 const descriptor=Object.getOwnPropertyDescriptor(process,'memoryUsage'),original=descriptor.value,rssDescriptor=Object.getOwnPropertyDescriptor(original,'rss');
 const replacement=function(...args){return Reflect.apply(full,this,args);};Object.defineProperty(replacement,'rss',{...rssDescriptor,value:function(...args){return Reflect.apply(rss,this,args);}});
 Object.defineProperty(process,'memoryUsage',{...descriptor,value:replacement});try{return run();}finally{Object.defineProperty(process,'memoryUsage',descriptor);assert.deepEqual(Object.getOwnPropertyDescriptor(process,'memoryUsage'),descriptor);assert.deepEqual(Object.getOwnPropertyDescriptor(original,'rss'),rssDescriptor);}
}

test('default metadata admission freshly samples RSS in order at the exact ceiling and one byte over',()=>{
 const bytes=37,allowance=bytes*12+MiB,debt=91,limit=512*MiB-debt-allowance,events=[],before=rssOwnership();let rss=limit,samples=0,memory,builds=0;
 withCompositionRSSMethods({rss(){samples++;events.push('rss');return rss;}},()=>{
  memory=new CompositionMemory(()=>{events.push('other');return memory.bytes+debt;});memories.add(memory);assert.deepEqual(events,[],'Construction does not sample or cache RSS');const empty=memory.resourceOwnership();
  const acquire=()=>memory.ownedMetadata(bytes,()=>{events.push('build');builds++;assert.equal(memory.bytes,allowance);assert.equal(memory.resourceOwnership().borrowers,1);return {ok:true};});
  let owner=acquire();try{assert.deepEqual(owner.value,{ok:true});assert.deepEqual(events,['rss','other','build']);}finally{owner.release();}assert.deepEqual(memory.resourceOwnership(),empty);assert.deepEqual(rssOwnership(),before);
  rss=limit+1;events.length=0;assert.throws(acquire,{code:'CAPACITY'});assert.deepEqual(events,['rss','other']);assert.equal(builds,1);assert.deepEqual(memory.resourceOwnership(),empty);assert.deepEqual(rssOwnership(),before);
  rss=limit;events.length=0;owner=acquire();try{assert.deepEqual(owner.value,{ok:true});assert.deepEqual(events,['rss','other','build']);}finally{owner.release();owner.release();}assert.equal(samples,3);assert.equal(builds,2);assert.deepEqual(memory.resourceOwnership(),empty);assert.deepEqual(rssOwnership(),before);
 });
});

test('default native layer admission refuses before actual semantic reads and admits the unchanged exact boundary',()=>{
 const f=fixture(),allowance=4*MiB+f.state.layers.length*4096+32768,limit=512*MiB-allowance,before=rssOwnership();let rss=limit+1,samples=0,assets=0,consumed=0,memory;
 withCompositionRSSMethods({rss(){samples++;return rss;}},()=>{
  memory=new CompositionMemory(()=>memory.bytes);memories.add(memory);const empty=memory.resourceOwnership(),run=()=>withLayerValues(f.state,f.read,id=>{assets++;return f.asset(id);},memory,values=>{consumed++;assert.equal(memory.bytes,allowance);assert.equal(values[0].text,'retained native heading');});
  assert.throws(run,{code:'CAPACITY'});assert.equal(assets,0);assert.deepEqual(f.reads,[]);assert.equal(consumed,0);assert.deepEqual(memory.resourceOwnership(),empty);assert.deepEqual(rssOwnership(),before);
  rss=limit;run();assert.equal(samples,2);assert.equal(assets,1);assert.deepEqual(f.reads,[f.source.hash,f.textRef.hash]);assert.equal(consumed,1);assert.deepEqual(memory.resourceOwnership(),empty);assert.deepEqual(rssOwnership(),before);
 });
});

test('default resize samples only actual growth and preserves the original RSS plus current debt ordering',()=>{
 const id='11111111-1111-4111-8111-111111111111',debt=17,before=rssOwnership(),events=[];let memory,rss=512*MiB-debt-100,samples=0;
 withCompositionRSSMethods({rss(){samples++;events.push('rss');return rss;}},()=>{
  memory=new CompositionMemory(()=>{events.push('other');return memory.bytes+debt;});memories.add(memory);const empty=memory.resourceOwnership();
  try{
   memory.resize(id,100);assert.equal(memory.bytes,100);assert.deepEqual(events,['rss','other']);events.length=0;rss=512*MiB;
   memory.resize(id,100);memory.resize(id,90);assert.equal(memory.bytes,90);assert.deepEqual(events,[],'Equal size and shrinking do not add a new RSS sample');assert.equal(samples,1);
   rss=512*MiB-debt-120;memory.resize(id,120);assert.equal(memory.bytes,120);assert.deepEqual(events,['rss','other']);events.length=0;const held=memory.resourceOwnership(),owned=rssOwnership();
   rss=512*MiB-debt-121+1;assert.throws(()=>memory.resize(id,121),{code:'CAPACITY'});assert.equal(memory.bytes,120);assert.deepEqual(events,['rss','other']);assert.deepEqual(memory.resourceOwnership(),held);assert.deepEqual(rssOwnership(),owned);assert.equal(samples,3);
  }finally{memory.drop(id,()=>assert.fail('No content reader was opened'));}assert.deepEqual(memory.resourceOwnership(),empty);assert.deepEqual(rssOwnership(),before);
 });
});

for(const phase of ['rss','other','builder'])test('default admission '+phase+' failure preserves exact identity and leaves no owner',()=>{
 const failure=Object.freeze({phase}),events=[],before=rssOwnership();let memory;
 withCompositionRSSMethods({rss(){events.push('rss');if(phase==='rss')throw failure;return 0;}},()=>{
  memory=new CompositionMemory(()=>{events.push('other');if(phase==='other')throw failure;return memory.bytes;});memories.add(memory);const empty=memory.resourceOwnership();
  assert.throws(()=>memory.ownedMetadata(1,()=>{events.push('builder');assert.equal(memory.resourceOwnership().borrowers,1);throw failure;}),error=>error===failure);
  assert.deepEqual(events,phase==='rss'?['rss']:phase==='other'?['rss','other']:['rss','other','builder']);assert.deepEqual(memory.resourceOwnership(),empty);assert.deepEqual(rssOwnership(),before);
 });
});

test('explicit Composition RSS injection stays fresh and never consults either process API',()=>{
 const before=rssOwnership(),events=[];let rss=0,memory;
 withCompositionRSSMethods({rss:()=>assert.fail('Injected admission called process RSS'),full:()=>assert.fail('Injected admission collected full memory')},()=>{
  memory=new CompositionMemory(()=>{events.push('other');return memory.bytes;},()=>{events.push('injected');return rss;});memories.add(memory);const empty=memory.resourceOwnership();let consumed=0;
  memory.nativeLayers({layers:[]},()=>{consumed++;assert.equal(memory.bytes,4*MiB);});assert.equal(consumed,1);assert.deepEqual(events,['injected','other']);assert.deepEqual(memory.resourceOwnership(),empty);
  rss=512*MiB-4*MiB+1;events.length=0;assert.throws(()=>memory.nativeLayers({layers:[]},()=>{consumed++;}),{code:'CAPACITY'});assert.deepEqual(events,['injected','other']);assert.equal(consumed,1);assert.deepEqual(memory.resourceOwnership(),empty);assert.deepEqual(rssOwnership(),before);
 });
});
