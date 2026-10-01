import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {supportedCells,loadNativeAdmission,inspectNativeAdmission,readNativeStateFile,runNativeWorkerAdmission,runCell} from '../../tooling/qualification/campaigns/backend-composition-native.mjs';
import {makeCompositionFixture} from '../../tooling/qualification/campaigns/backend-composition.mjs';

const repo=fileURLToPath(new URL('../../',import.meta.url));
test('native fixture inventory is exactly WJ25–WJ30',()=>{
 assert(Object.isFrozen(supportedCells));assert.deepEqual(supportedCells,['WJ25','WJ26','WJ27','WJ28','WJ29','WJ30']);
});
test('finite admission uses shipped source and production document totals',async()=>{
 const api=await loadNativeAdmission({repo});
 assert.deepEqual(api.identity.sources.map(source=>source.path),['src/text/contracts.ts','src/text/admission.ts']);
 for(const source of api.identity.sources){assert.match(source.sha256,/^sha256:[a-f0-9]{64}$/);assert.match(source.transformedHash,/^sha256:[a-f0-9]{64}$/);}
 for(const id of supportedCells){const fixture=makeCompositionFixture(id),value=JSON.parse(fixture.bytes),result=inspectNativeAdmission(api,value);assert.equal(result.code,value.expected,id);assert.equal(result.outcomes.length,value.texts.length,id);
  if(['WJ26','WJ29','WJ30'].includes(id))assert(result.documentChecked,id);
  if(id==='WJ26')assert.equal(result.admittedTextBytes,1048577);
  if(id==='WJ30')assert.equal(result.admittedTextBytes,1048576);
 }
});
test('WJ28 keeps escaped lone surrogate bytes available for recovery',()=>{
 const fixture=makeCompositionFixture('WJ28');assert(fixture.bytes.includes(Buffer.from('\\ud800')));assert(!fixture.bytes.includes(Buffer.from([0xef,0xbf,0xbd])));assert.equal(JSON.parse(fixture.bytes).texts[0].charCodeAt(0),0xd800);
});
test('unsupported or cancelled native cells cannot pass',async()=>{
 assert.equal((await runCell({repo},{id:'WJ24'})).status,'inconclusive');
 const controller=new AbortController();controller.abort();const cancelled=await runCell({repo,signal:controller.signal},{id:'WJ25'});assert.equal(cancelled.status,'inconclusive');assert.equal(cancelled.assertions.length,0);
});

test('retained native state mailbox verifies immutable owned input identity',async t=>{
 const root=await mkdtemp(join(tmpdir(),'ideogram-native-input-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'qualification-composition-inputs'));
 const state={schemaVersion:2,layers:[]},bytes=Buffer.from(JSON.stringify(state)),path='qualification-composition-inputs/native-'+randomUUID()+'.json';
 await writeFile(join(root,path),bytes);
 const descriptor={path,sha256:'sha256:'+createHash('sha256').update(bytes).digest('hex'),byteLength:String(bytes.length)};
 assert.deepEqual(await readNativeStateFile(root,descriptor),state);
 await assert.rejects(readNativeStateFile(root,{...descriptor,byteLength:String(bytes.length+1)}));
 await assert.rejects(readNativeStateFile(root,{...descriptor,sha256:'sha256:'+'0'.repeat(64)}));
 await assert.rejects(readNativeStateFile(root,{...descriptor,path:'../native-'+randomUUID()+'.json'}));
 await assert.rejects(readNativeStateFile(root,{...descriptor,byteLength:'1048577'}));
});

test('missing retained native worker never closes or reopens its borrowed writer',async()=>{
 const context={repo,productFixture:{close(){throw Error('borrowed fixture closed');},direct(){throw Error('borrowed writer closed');},reopen(){throw Error('borrowed writer reopened');}}};
 const result=await runCell(context,{id:'WJ25'});
 assert.equal(result.status,'inconclusive');assert.equal(result.missing[0].code,'NATIVE_RETAINED_WORKER_UNAVAILABLE');
});

test('native worker preserves a failed admission phase across its result boundary',async()=>{
 // Deliberately malformed state fails before touching a store capability. This
 // verifies failure transport, not native source acceptance through a substitute.
 const result=await runNativeWorkerAdmission({}, {action:'native-admission',caseId:'WJ25'}, {repo,state:{layers:null}});
 assert.equal(result.error.name,'AssertionError');assert.equal(result.error.code,'ERR_ASSERTION');
 assert.equal(result.phase.name,'text.admission');assert.equal(result.phase.outcome,'failed');
 assert(Number.isFinite(result.phase.startMs));assert(Number.isFinite(result.phase.endMs));
 assert.equal(result.phase.durationMs,result.phase.endMs-result.phase.startMs);assert(result.phase.durationMs>=0);
 assert.equal(result.admission,null);assert.equal(result.storedAdmission,null);
});

// Real owned writer storage, append and restart. Run under the same guarded
// local prerequisites as the other backend campaigns; no mock writer is used.
for(const id of supportedCells)test(`${id} durable recovery keeps exact original JSON after restart`,async t=>{
 const output=await mkdtemp(join(tmpdir(),'ideogram-native-campaign-'));t.after(()=>rm(output,{recursive:true,force:true}));
 const fixture=makeCompositionFixture(id),path=join(output,id+'.json');await writeFile(path,fixture.bytes);
 const context={repo,output,fixture:{corpus:{files:[{id,path,sha256:fixture.sha256,byteLength:fixture.byteLength}]}}};
 const result=await runCell(context,{id});assert.equal(result.status,'inconclusive',JSON.stringify(result));assert.deepEqual(result.missing,['R33 durable native source validation/loading is not exercised by the metadata-only document-limit fixture']);
 assert(result.assertions.every(item=>item.passed));assert(result.phases.some(item=>item.name==='native-admission.composition-history-append'));
 assert.equal(result.phases.filter(item=>item.name==='text.admission').length,1);
 assert(result.phases.some(item=>item.name==='native-admission.reopen-and-verify-original-closure'));
 assert(result.observations.notClaimed.includes('native layout/raster correctness'));assert.equal(result.evidence.length,1);
});
