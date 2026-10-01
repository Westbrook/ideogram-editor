import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {supportedCells,runCell} from '../../tooling/qualification/campaigns/backend-composition-cp.mjs';

const repo=fileURLToPath(new URL('../../',import.meta.url));

test('CP inventory is exactly the 16 frozen fixture identities',()=>{
 assert(Object.isFrozen(supportedCells));
 assert.deepEqual(supportedCells,Array.from({length:16},(_,i)=>`CP${String(i+1).padStart(2,'0')}`));
});

test('unsupported cells, absent builds and interrupted cells cannot report success',async()=>{
 const unsupported=await runCell({repo},{id:'CP17'});assert.equal(unsupported.status,'inconclusive');assert.equal(unsupported.missing[0].code,'UNSUPPORTED_CP_CELL');
 const noBuild=await runCell({repo:repo+'__missing_cp_build__'},{id:'CP01'});assert.equal(noBuild.status,'inconclusive');assert.equal(noBuild.missing[0].code,'ERR_MODULE_NOT_FOUND');assert.equal(noBuild.assertions.length,0);
 const controller=new AbortController();controller.abort();const aborted=await runCell({repo,signal:controller.signal},{id:'CP01'});assert.equal(aborted.status,'inconclusive');assert.equal(aborted.missing[0].code,'ABORT_ERR');assert.equal(aborted.phases.length,0);
});

// Imports are deliberately lazy in runCell, so inventory/negative tests need no
// build. The positive fixture tests require the ordinary build:server gate.
for(const id of supportedCells)test(`${id} runs its production finite bundle with literal invariants`,async()=>{
 const result=await runCell({repo},{id:'qualification-cell-'+id,operation:id});
 assert.equal(result.status,'pass',JSON.stringify(result));assert.deepEqual(result.missing,[]);
 assert(result.assertions.length>=2);assert(result.assertions.every(a=>a.passed===true));
 assert.deepEqual(result.phases.map(p=>p.name),['load-production-modules','finite-assertion-bundle']);
 for(const phase of result.phases){assert(Number.isFinite(phase.startMs));assert(phase.endMs>=phase.startMs);assert.equal(phase.durationMs,phase.endMs-phase.startMs);}
 if(id==='CP02'){
  for(const text of ['contiguous multilayer','exact rendered slot','undo and redo','new-document route','no retained visible overlay','stale source revision','changed stack fingerprint','changed native render/source'])assert(result.assertions.some(a=>a.name.includes(text)),text);
  const scope=result.observations.find(o=>o.scope==='finite-production-route-harness');assert(scope);assert(scope.notClaimed.includes('durable Undo/Redo commit'));assert(scope.substitutedBoundaries.length>0);
 }
});
