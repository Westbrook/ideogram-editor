import test from 'node:test';
import assert from 'node:assert/strict';
import { planNarrowFixture } from '../../tooling/qualification/campaigns/fixture-narrow.mjs';
import { workloadDefinition } from '../../tooling/qualification/campaigns/fixtures.mjs';
const input=()=>({definition:workloadDefinition('WNarrow'),corpus:{files:[{id:'narrow-original',role:'raster-original',path:'/fixture/narrow.jpg',sha256:'sha256:'+'1'.repeat(64),byteLength:'8000000',width:8192,height:3000,format:'jpeg'}]}});
test('narrow fixture keeps actual8192side and24.576-megapixel data independent of W2 history',()=>{const spec=input(),plan=planNarrowFixture(spec);assert.equal(plan.width*plan.height,24576000);assert.equal(spec.definition.events,null);assert.match(plan.scope,/without a10k\/100k/);});
test('narrow fixture rejects scaled dimensions, aliased formats and missing originals',()=>{for(const mutate of [s=>s.definition.width=5000,s=>s.corpus.files=[],s=>s.corpus.files[0].height=2999,s=>s.corpus.files[0].format='binary',s=>s.corpus.files[0].byteLength=String(32*1048576+1),s=>s.corpus.files.push({...s.corpus.files[0]})]){const s=input();mutate(s);assert.throws(()=>planNarrowFixture(s));}});
