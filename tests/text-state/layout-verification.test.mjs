import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {verifyPreparedLayout,restoreRetainedFrameOrder} from '../../dist/local/server/text/render-worker.mjs';
import {profile,usesStreamingLayout,retainedProfile} from '../../dist/local/server/text/validation.js';
import {verificationBudget} from '../../dist/local/src/protocol/text-budget.js';
import retained from '../../src/text/retained-profiles/c19791ae.json' with {type:'json'};
import frameOrderPrior from '../../src/text/retained-profiles/7a4dbc6c.json' with {type:'json'};
import ownershipPrior from '../../src/text/retained-profiles/4fd6f6a1.json' with {type:'json'};
import integrationPrior from '../../src/text/retained-profiles/68efa85f.json' with {type:'json'};
import combinedCPUPrior from '../../src/text/retained-profiles/6d77f925.json' with {type:'json'};
import adapterOwnershipPrior from '../../src/text/retained-profiles/c6ca02c2.json' with {type:'json'};
import httpFramingPrior from '../../src/text/retained-profiles/1c399d52.json' with {type:'json'};
import deferredManifestPrior from '../../src/text/retained-profiles/e648eede.json' with {type:'json'};
import startupProfilePrior from '../../src/text/retained-profiles/891a4688.json' with {type:'json'};
import textResourcesPrior from '../../src/text/retained-profiles/b96236b0.json' with {type:'json'};

const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
async function staged(t,bytes){const directory=await mkdtemp(join(tmpdir(),'native-layout-'));t.after(()=>rm(directory,{recursive:true,force:true}));const layoutPath=join(directory,'layout.json');await writeFile(layoutPath,bytes);return {layoutPath,layoutHash:hash(bytes)};}

test('current and retained streamed verification hash every chunk without materializing prepared JSON',async t=>{
 const bytes=Buffer.from('{"value":"'+'a'.repeat(3*65536+17)+'"}'),expected=await staged(t,bytes);
 const prepared={layoutHash:hash(bytes),layout:{text(){throw Error('current layout must not be decoded');},get size(){throw Error('current layout must not be read');}}};
 for(const id of [profile.id,frameOrderPrior.id,ownershipPrior.id,integrationPrior.id,combinedCPUPrior.id,adapterOwnershipPrior.id,httpFramingPrior.id,deferredManifestPrior.id,startupProfilePrior.id,textResourcesPrior.id])await verifyPreparedLayout(expected,prepared,id,'a'.repeat(16384));
 const corrupted=Buffer.from(bytes);corrupted[65536+10]=98;await writeFile(expected.layoutPath,corrupted);
 for(const id of [profile.id,frameOrderPrior.id,ownershipPrior.id,integrationPrior.id,combinedCPUPrior.id,adapterOwnershipPrior.id,httpFramingPrior.id,deferredManifestPrior.id,startupProfilePrior.id,textResourcesPrior.id])await assert.rejects(verifyPreparedLayout(expected,prepared,id,'a'),/TEXT_NATIVE_MISMATCH/);
});

test('current and retained streamed layout require exact bytes even when reordered JSON is semantically equal',async t=>{
 const expected=await staged(t,Buffer.from('{"a":1,"b":2}')),layout=new Blob(['{"b":2,"a":1}']);
 for(const id of [profile.id,frameOrderPrior.id,ownershipPrior.id,integrationPrior.id,combinedCPUPrior.id,adapterOwnershipPrior.id,httpFramingPrior.id,deferredManifestPrior.id,startupProfilePrior.id,textResourcesPrior.id])await assert.rejects(verifyPreparedLayout(expected,{layout,layoutHash:hash(Buffer.from(await layout.text()))},id,'a'),/TEXT_NATIVE_MISMATCH/);
});

test('retained profile accepts historical canonical ordering only inside original planner bound',async t=>{
 const expected=await staged(t,Buffer.from('{"a":1,"b":2}')),prepared={layout:new Blob(['{"b":2,"a":1}'])};
 await verifyPreparedLayout(expected,prepared,retained.id,'a'.repeat(480));
 await assert.rejects(verifyPreparedLayout(expected,prepared,retained.id,'a'.repeat(481)),/TEXT_NATIVE_MISMATCH/);
 await assert.rejects(verifyPreparedLayout(expected,{layout:new Blob(['{"a":3,"b":2}'])},retained.id,'a'),/TEXT_NATIVE_MISMATCH/);
 await assert.rejects(verifyPreparedLayout({...expected,layoutHash:hash(Buffer.from('other'))},prepared,retained.id,'a'),/TEXT_NATIVE_MISMATCH/);
 await assert.rejects(verifyPreparedLayout(expected,prepared,'unknown-profile','a'),/TEXT_NATIVE_MISMATCH/);
});

test('verification rejects staged bytes beyond the frozen8MiB layout ceiling',async t=>{
 const bytes=Buffer.alloc(8388609,32),expected=await staged(t,bytes);
 for(const id of [profile.id,startupProfilePrior.id,textResourcesPrior.id])await assert.rejects(verifyPreparedLayout(expected,{layoutHash:expected.layoutHash},id,'a'),/TEXT_NATIVE_MISMATCH/);
});

test('retained streamed profile keeps its exact manifest and full16KiB admission',()=>{
 assert.notEqual(profile.id,integrationPrior.id,'Integrated adoption must generate a new current application profile');
 assert.deepEqual(profile.engine,integrationPrior.engine,'Native engine identity remains unchanged');assert.deepEqual(profile.fonts,integrationPrior.fonts,'Exact bundled font identities remain unchanged');
 for(const [file,retained]of [['7a4dbc6c',frameOrderPrior],['4fd6f6a1',ownershipPrior],['68efa85f',integrationPrior],['6d77f925',combinedCPUPrior],['c6ca02c2',adapterOwnershipPrior],['1c399d52',httpFramingPrior],['e648eede',deferredManifestPrior],['891a4688',startupProfilePrior],['b96236b0',textResourcesPrior]]){
  const bytes=fs.readFileSync(new URL('../../src/text/retained-profiles/'+file+'.json',import.meta.url)),manifest={hash:hash(bytes),byteLength:String(bytes.length),mediaType:'application/json'};
  assert(retainedProfile({schemaVersion:1,id:retained.id,manifest}));assert.equal(retainedProfile({schemaVersion:1,id:retained.id,manifest:{...manifest,hash:hash(Buffer.from('changed'))}}),false);
  assert.equal(usesStreamingLayout(retained.id),true);
  const text='a'.repeat(16384),budget=verificationBudget(text,120,70,1024,profile.engine.wasm.bytes,{legacy:!usesStreamingLayout(retained.id)});
  assert(budget.bytes<=134217728);assert.throws(()=>verificationBudget(text,120,70,1024,profile.engine.wasm.bytes,{legacy:true}),/TEXT_VERIFICATION_CAPACITY/);
 }
 assert.equal(usesStreamingLayout(profile.id),true);assert.equal(usesStreamingLayout(retained.id),false);assert.equal(usesStreamingLayout('unknown'),false);
});

test('combined CPU successor retains the exact6d77 predecessor and sealed native identities',()=>{
 const bytes=fs.readFileSync(new URL('../../src/text/retained-profiles/6d77f925.json',import.meta.url));
 assert.equal(hash(bytes),'sha256:a00135bd564fa7926b97752024a1a00ec7c23ba520f4aecca63b74ad1cd2e599');
 assert.equal(combinedCPUPrior.id,'sha256:6d77f9257b26a86e34dc7ec88e63e061e4ca64b299343105f30edb8477b706c0');
 assert.notEqual(profile.id,combinedCPUPrior.id,'Observer source changes require the established profile producer');
 for(const key of ['engine','fonts','memory','rasterProfile'])assert.deepEqual(profile[key],combinedCPUPrior[key],key+' is unchanged by the observation bridge');
 assert.deepEqual(profile.sourceRecipe.find(row=>row.path==='src/text/retained-profiles/6d77f925.json'),{path:'src/text/retained-profiles/6d77f925.json',bytes:bytes.length,sha256:hash(bytes).slice(7)});
});

test('adapter ownership successor retains exact c6ca02c2 profile and observer source closure',()=>{
 const path='src/text/retained-profiles/c6ca02c2.json',bytes=fs.readFileSync(new URL('../../'+path,import.meta.url));
 assert.equal(hash(bytes),'sha256:d3ef40a7cbf8b4119627dc2f4ce1a11cb1bb1c9eedfb6b9d8321e04afeb249dd');
 assert.equal(adapterOwnershipPrior.id,'sha256:c6ca02c202544552292385704ecdf9e7d0d90cd0016b7f65e4677b3952f5fa22');
 assert.notEqual(profile.id,adapterOwnershipPrior.id,'Ownership source changes require the established profile producer');
 for(const key of ['engine','fonts','memory','rasterProfile'])assert.deepEqual(profile[key],adapterOwnershipPrior[key],key+' is unchanged by the ownership bridge');
 assert.deepEqual(profile.sourceRecipe.find(row=>row.path===path),{path,bytes:bytes.length,sha256:hash(bytes).slice(7)});
 const observerPath='server/observability/adapter-resources.ts',observer=fs.readFileSync(new URL('../../'+observerPath,import.meta.url));
 assert.deepEqual(profile.sourceRecipe.find(row=>row.path===observerPath),{path:observerPath,bytes:observer.length,sha256:hash(observer).slice(7)});
});

test('HTTP framing successor retains exact 1c399d52 profile and current HTTP source identity',()=>{
 const path='src/text/retained-profiles/1c399d52.json',bytes=fs.readFileSync(new URL('../../'+path,import.meta.url));
 assert.equal(hash(bytes),'sha256:140b72169cfae3e5fe727f58a0395b3a21ec7da6cf36283e87c9320a6a6c6ee8');
 assert.equal(httpFramingPrior.id,'sha256:1c399d52158fa57e2a420cb254290237e15c75d5493b71b1704cde33a18d5a5a');
 assert.notEqual(profile.id,httpFramingPrior.id,'HTTP source changes require the established profile producer');
 for(const key of ['engine','fonts','memory','rasterProfile'])assert.deepEqual(profile[key],httpFramingPrior[key],key+' is unchanged by HTTP framing');
 assert.deepEqual(profile.sourceRecipe.find(row=>row.path===path),{path,bytes:bytes.length,sha256:hash(bytes).slice(7)});
 const httpPath='server/http.ts',http=fs.readFileSync(new URL('../../'+httpPath,import.meta.url));
 assert.deepEqual(profile.sourceRecipe.find(row=>row.path===httpPath),{path:httpPath,bytes:http.length,sha256:hash(http).slice(7)});
});

test('deferred manifest successor retains exact e648eede profile and current durable source identity',()=>{
 const path='src/text/retained-profiles/e648eede.json',bytes=fs.readFileSync(new URL('../../'+path,import.meta.url));
 assert.equal(hash(bytes),'sha256:1015d4832862ab35edb4fe9010d129d88a8d2fe4d1cefae4ffbe63054e62a6e5');
 assert.equal(deferredManifestPrior.id,'sha256:e648eede47148f93c4ffaa4c053991210fc40f62785974ba7b182087a19904a1');
 assert.notEqual(profile.id,deferredManifestPrior.id,'Manifest-loading source changes require the established profile producer');
 for(const key of ['engine','fonts','memory','rasterProfile'])assert.deepEqual(profile[key],deferredManifestPrior[key],key+' is unchanged by deferred manifest loading');
 assert.deepEqual(profile.sourceRecipe.find(row=>row.path===path),{path,bytes:bytes.length,sha256:hash(bytes).slice(7)});
 const durablePath='src/text/durable.ts',durable=fs.readFileSync(new URL('../../'+durablePath,import.meta.url));
 assert.deepEqual(profile.adapterSources.find(row=>row.path===durablePath),{path:durablePath,bytes:durable.length,sha256:hash(durable).slice(7)});
});

test('startup profile successor retains exact 891a4688 profile and current durable source identity',()=>{
 const path='src/text/retained-profiles/891a4688.json',bytes=fs.readFileSync(new URL('../../'+path,import.meta.url));
 assert.equal(bytes.length,18360);
 assert.equal(hash(bytes),'sha256:f7c063fd77161f6be59b2a20559ddfda42e4bf8fcd2d04297d7321d324232a17');
 assert.equal(startupProfilePrior.id,'sha256:891a46885f73e530cac73ba438a1ca437d28f4bb54949dcd0b40d6da6d0cbe68');
 assert.notEqual(profile.id,startupProfilePrior.id,'Startup source changes require the established profile producer');
 for(const key of ['engine','fonts','memory','rasterProfile'])assert.deepEqual(profile[key],startupProfilePrior[key],key+' is unchanged by startup profile retention');
 assert.deepEqual(profile.sourceRecipe.filter(row=>row.path===path),[{path,bytes:bytes.length,sha256:hash(bytes).slice(7)}]);
 const durablePath='src/text/durable.ts',durable=fs.readFileSync(new URL('../../'+durablePath,import.meta.url));
 assert.deepEqual(profile.adapterSources.find(row=>row.path===durablePath),{path:durablePath,bytes:durable.length,sha256:hash(durable).slice(7)});
});

// Observe the real bounded file reads and confirm the actual OS descriptor is
// closed on both success and refusal, rather than inferring release from counts.
function observedRestore(expected,frame){
 const originals={openSync:fs.openSync,readSync:fs.readSync,closeSync:fs.closeSync};let descriptor,readBytes=0,maxRead=0,result,error;
 fs.openSync=(...args)=>(descriptor=originals.openSync(...args));
 fs.readSync=(...args)=>{maxRead=Math.max(maxRead,args[3]);const count=originals.readSync(...args);readBytes+=count;return count;};
 syncBuiltinESMExports();
 try{result=restoreRetainedFrameOrder(expected,frame);}catch(value){error=value;}
 finally{Object.assign(fs,originals);syncBuiltinESMExports();}
 if(descriptor!==undefined)assert.throws(()=>fs.fstatSync(descriptor),{code:'EBADF'});
 assert(readBytes<=512);assert(maxRead<=512);return {result,error,readBytes};
}
const layoutHeader=frame=>'{'+'"version":"layout-1","policy":"text-layout-1","frame":'+frame+',"indexConvention":"half-open"';

test('retained streamed header restores either original frame order from at most512 bytes',async t=>{
 for(const original of [{width:120,height:70},{height:70,width:120}]){
  const expected=await staged(t,Buffer.from(layoutHeader(JSON.stringify(original))+',"tail":"'+'x'.repeat(65536)+'"}'));
  const observed=observedRestore(expected,{height:70,width:120});assert.equal(observed.error,undefined);assert.deepEqual(Object.keys(observed.result),Object.keys(original));assert.deepEqual(observed.result,original);assert.equal(observed.readBytes,512);
 }
});

test('retained streamed frame restoration rejects mismatches and malformed headers and closes files',async t=>{
 for(const header of [
  layoutHeader('{"width":121,"height":70}'),
  layoutHeader('{"width":120,"height":70,"width":120}'),
  layoutHeader('{"width":120,"height":70,"extra":0}'),
  layoutHeader('{"width":"120","height":70}'),
  layoutHeader('{"width":120,"height":7e1}'),
  layoutHeader('{"width":120,"height":70}').replace('layout-1','layout-2'),
  layoutHeader('{"width":120,"height":70}').slice(0,40),
  ' '.repeat(513)+layoutHeader('{"width":120,"height":70}'),
 ]){const expected=await staged(t,Buffer.from(header)),observed=observedRestore(expected,{width:120,height:70});assert.match(observed.error?.message??'',/TEXT_NATIVE_MISMATCH/);}
 const expected=await staged(t,Buffer.from(layoutHeader('{"width":120,"height":70}')));
 for(const frame of [{width:Infinity,height:70},{width:120,height:0},{width:120,height:70,extra:0}])assert.match(observedRestore(expected,frame).error?.message??'',/TEXT_NATIVE_MISMATCH/);
 assert.equal(observedRestore({layoutPath:expected.layoutPath+'.missing'},{width:120,height:70}).error?.code,'ENOENT');
});

test('text resource successor retains exact b96236b0 bytes and seals its synchronous source bridge',()=>{
 const path='src/text/retained-profiles/b96236b0.json',bytes=fs.readFileSync(new URL('../../'+path,import.meta.url));
 assert.equal(bytes.length,18536);assert.equal(hash(bytes),'sha256:0c2857d4033926a7db23957fd3bf002929aa33a201e059626a9f8f286227d288');
 assert.equal(textResourcesPrior.id,'sha256:b96236b05b653557864970ea57839fe9a03f1d7540fd847c1788095d6a94e68c');assert.notEqual(profile.id,textResourcesPrior.id);
 for(const key of ['engine','fonts','memory','rasterProfile'])assert.deepEqual(profile[key],textResourcesPrior[key]);
 assert.deepEqual(profile.sourceRecipe.filter(row=>row.path===path),[{path,bytes:bytes.length,sha256:hash(bytes).slice(7)}]);
 for(const [path,rows]of [['src/text/memory.ts',profile.adapterSources],['src/observability/diagnostic-memory.ts',profile.sourceRecipe]]){
  const bytes=fs.readFileSync(new URL('../../'+path,import.meta.url));assert.deepEqual(rows.filter(row=>row.path===path),[{path,bytes:bytes.length,sha256:hash(bytes).slice(7)}]);
 }
});
