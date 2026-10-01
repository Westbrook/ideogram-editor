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

const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
async function staged(t,bytes){const directory=await mkdtemp(join(tmpdir(),'native-layout-'));t.after(()=>rm(directory,{recursive:true,force:true}));const layoutPath=join(directory,'layout.json');await writeFile(layoutPath,bytes);return {layoutPath,layoutHash:hash(bytes)};}

test('current and retained streamed verification hash every chunk without materializing prepared JSON',async t=>{
 const bytes=Buffer.from('{"value":"'+'a'.repeat(3*65536+17)+'"}'),expected=await staged(t,bytes);
 const prepared={layoutHash:hash(bytes),layout:{text(){throw Error('current layout must not be decoded');},get size(){throw Error('current layout must not be read');}}};
 for(const id of [profile.id,frameOrderPrior.id,ownershipPrior.id])await verifyPreparedLayout(expected,prepared,id,'a'.repeat(16384));
 const corrupted=Buffer.from(bytes);corrupted[65536+10]=98;await writeFile(expected.layoutPath,corrupted);
 for(const id of [profile.id,frameOrderPrior.id,ownershipPrior.id])await assert.rejects(verifyPreparedLayout(expected,prepared,id,'a'),/TEXT_NATIVE_MISMATCH/);
});

test('current and retained streamed layout require exact bytes even when reordered JSON is semantically equal',async t=>{
 const expected=await staged(t,Buffer.from('{"a":1,"b":2}')),layout=new Blob(['{"b":2,"a":1}']);
 for(const id of [profile.id,frameOrderPrior.id,ownershipPrior.id])await assert.rejects(verifyPreparedLayout(expected,{layout,layoutHash:hash(Buffer.from(await layout.text()))},id,'a'),/TEXT_NATIVE_MISMATCH/);
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
 await assert.rejects(verifyPreparedLayout(expected,{layoutHash:expected.layoutHash},profile.id,'a'),/TEXT_NATIVE_MISMATCH/);
});

test('retained streamed profile keeps its exact manifest and full16KiB admission',()=>{
 for(const [file,retained]of [['7a4dbc6c',frameOrderPrior],['4fd6f6a1',ownershipPrior]]){
  const bytes=fs.readFileSync(new URL('../../src/text/retained-profiles/'+file+'.json',import.meta.url)),manifest={hash:hash(bytes),byteLength:String(bytes.length),mediaType:'application/json'};
  assert(retainedProfile({schemaVersion:1,id:retained.id,manifest}));assert.equal(retainedProfile({schemaVersion:1,id:retained.id,manifest:{...manifest,hash:hash(Buffer.from('changed'))}}),false);
  assert.equal(usesStreamingLayout(retained.id),true);
  const text='a'.repeat(16384),budget=verificationBudget(text,120,70,1024,profile.engine.wasm.bytes,{legacy:!usesStreamingLayout(retained.id)});
  assert(budget.bytes<=134217728);assert.throws(()=>verificationBudget(text,120,70,1024,profile.engine.wasm.bytes,{legacy:true}),/TEXT_VERIFICATION_CAPACITY/);
 }
 assert.equal(usesStreamingLayout(profile.id),true);assert.equal(usesStreamingLayout(retained.id),false);assert.equal(usesStreamingLayout('unknown'),false);
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
