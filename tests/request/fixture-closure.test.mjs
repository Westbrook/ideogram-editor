import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureClosureResources,assertFixtureClosure} from '../request-edits/fixture-closure.mjs';
const quiet=()=>({objects:{reservedBytes:'0',activeTransfers:0},raster:{activeWorkers:0,reservedCPU:0},text:{reservedCPU:0,externalBytes:0},fixture:{listening:false,sockets:0,pending:false}});

test('fixture closure reads actual post-drain ownership counters without reading disposed diagnostic rings',()=>{
 const workerService={closed:true,workerCount:0,activeJobs:0},fixture={listening:false,sockets:0,pending:false};let reads=0;
 const store={objects:{reservationInventory:()=>({reservedBytes:'16',activeTransfers:1})},rasters:{resourceOwnership:()=>{reads++;return {activeWorkers:2,bookedCPUBytes:32,workerService};},readDiagnostics(){throw Error('A disposed diagnostic ring must not be read');}},texts:{reservedCPU:4,externalBytes:()=>8}};
 const value=fixtureClosureResources(store,fixture);
 assert.equal(reads,1);assert.deepEqual(value,{objects:{reservedBytes:'16',activeTransfers:1},raster:{activeWorkers:2,reservedCPU:32,workerService},text:{reservedCPU:4,externalBytes:8},fixture});
 assert.notStrictEqual(value.fixture,fixture);assert.equal(value.raster.observations,undefined);assert.equal(value.raster.workerPhases,undefined);assert.throws(()=>assertFixtureClosure(value,[],[]),{code:'ERR_ASSERTION'});
});

test('fixture closure accepts only the actual zero-resource receipt and leaves it unchanged',()=>{const value=quiet(),before=structuredClone(value);assertFixtureClosure(value,[],[]);assert.deepEqual(value,before);});
for(const [name,change]of [
 ['object transfers',value=>value.objects.activeTransfers=1],['object reservation',value=>value.objects.reservedBytes='1'],
 ['native raster work',value=>value.raster.activeWorkers=1],['raster reservation',value=>value.raster.reservedCPU=1],
 ['fixture server',value=>value.fixture.listening=true],['fixture sockets',value=>value.fixture.sockets=1],['fixture task',value=>value.fixture.pending=true],
])test('fixture closure preserves refusal for '+name,()=>{const value=quiet();change(value);assert.throws(()=>assertFixtureClosure(value,[],[]),{code:'ERR_ASSERTION'});});
for(const field of ['errors','egress'])test('fixture closure retains '+field+' failures after resources drain',()=>{assert.throws(()=>assertFixtureClosure(quiet(),field==='errors'?['actual fixture failure']:[],field==='egress'?[{method:'fetch'}]:[]),{code:'ERR_ASSERTION'});});
