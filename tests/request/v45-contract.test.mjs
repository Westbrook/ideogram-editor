import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {newV45GenerateFields,resolveV45Generate,wireV45Generate,V45_GENERATION_SIZES,V45_GENERATION_PRESET_DIMENSIONS} from '../../dist/local/src/request/v45.js';
const resolve=(fields={},prompt='An exact reviewed prompt',promptMode='plain')=>resolveV45Generate({operation:'generate-v45',prompt,promptMode,fields:{...newV45GenerateFields(),...fields}});
test('V45 new fields produce explicit reviewed defaults without any V4 field or safety assertion',()=>{
 const r=resolve(),wire=JSON.parse(wireV45Generate(r));assert.deepEqual(wire,{enable_prompt_expansion:true,image_size:'square_hd',num_images:1,prompt:'An exact reviewed prompt',quality:'medium',sync_mode:false});
 assert.equal(r.endpoint,'ideogram/v4.5');assert.deepEqual(r.requested,{width:1024,height:1024});assert.equal(r.outputFormat,'provider-controlled');assert.equal(r.safetyAdmission,'blocked-unavailable-evidence');assert.equal(r.estimate.cents,6);assert.equal(r.estimate.actualCharge,null);
});
test('all 36 generation sizes exactly match the retained official contract and all presets use V45 geometry',async()=>{
 const schema=JSON.parse(await readFile(new URL('../../tooling/provider/research/20260930-v45-generation-schema.json',import.meta.url),'utf8'));
 const listed=[...schema.components.schemas.V45Input.properties.image_size.description.matchAll(/\b([0-9]+)x([0-9]+)\b/g)].map(([,w,h])=>[Number(w),Number(h)]);
 const unique=[...new Map(listed.map(size=>[size.join('x'),size])).values()];assert.equal(V45_GENERATION_SIZES.length,36);assert.deepEqual([...V45_GENERATION_SIZES].sort(),unique.sort());
 for(const [width,height] of V45_GENERATION_SIZES)assert.deepEqual(resolve({size:'custom',width:String(width),height:String(height)}).requested,{width,height});
 for(const [size,[width,height]] of Object.entries(V45_GENERATION_PRESET_DIMENSIONS))assert.deepEqual(resolve({size}).requested,{width,height});
 assert.deepEqual(resolve({size:'square'}).requested,{width:1024,height:1024});assert.deepEqual(resolve({size:'portrait_4_3'}).requested,{width:864,height:1152});
});
test('legacy dimensions, controls, routes and composition cannot silently become V45 requests',()=>{
 for(const pair of [[512,512],[1040,1040],[2048,1024],[0,1024]])assert.throws(()=>resolve({size:'custom',width:String(pair[0]),height:String(pair[1])}),{code:'V45_SIZE'});
 for(const key of ['expansion_model','expansion','strength','output_format','format','enable_safety_checker','speed','acceleration','rendering_speed'])assert.throws(()=>resolve({[key]:'legacy'}),{code:'V45_FIELDS'});
 assert.throws(()=>resolve({},'caption','composition'),{code:'V45_COMPOSITION_UNQUALIFIED'});
 assert.throws(()=>resolveV45Generate({operation:'generate',prompt:'x',promptMode:'plain',fields:newV45GenerateFields()}),{code:'V45_OPERATION'});
});
test('count stays app 1 through 4 and prompt bounds count Unicode scalar values',()=>{
 for(const count of ['1','2','3','4'])assert.equal(resolve({count}).body.num_images,Number(count));
 for(const count of ['0','5','8','1.5','01'])assert.throws(()=>resolve({count}),{code:'V45_APP_COUNT'});
 assert.equal(resolve({},'🦋'.repeat(10000)).body.prompt.length,20000);
 for(const prompt of ['','🦋'.repeat(10001),'\ud800'])assert.throws(()=>resolve({},prompt),{code:'V45_PROMPT_LENGTH'});
});
test('boolean expansion is explicit, exact seed token never rounds, and estimates vary by actual quality/count',()=>{
 const decimal='184467440737095516151234567890';const r=resolve({seed:decimal,promptExpansion:'disabled',quality:'high',count:'4'}),wire=wireV45Generate(r);
 assert(wire.includes('"seed":'+decimal));assert.equal(r.body.enable_prompt_expansion,false);assert.equal(r.estimate.cents,88);
 assert.equal(Object.hasOwn(JSON.parse(wireV45Generate(resolve())),'seed'),false);
 for(const seed of ['1.0','+1','01','NaN'])assert.throws(()=>resolve({seed}),{code:'V45_SEED'});
 for(const promptExpansion of ['None','Medium','Large','true'])assert.throws(()=>resolve({promptExpansion}),{code:'V45_PROMPT_EXPANSION'});
});
test('wire serializer refuses altered route, size, sync mode and forged legacy body properties',()=>{
 for(const mutate of [r=>r.endpoint='ideogram/v4',r=>r.body.enable_safety_checker=true,r=>r.body.sync_mode=true,r=>r.requested.width=512,r=>r.body.output_format='png',r=>r.seed={kind:'integer',decimal:18446744073709551615},r=>r.estimate.cents=0,r=>r.estimate.rateSourceHash='forged',r=>r.estimate.actualCharge=6]){
  const r=resolve();mutate(r);assert.throws(()=>wireV45Generate(r));
 }
});
