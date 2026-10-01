import test from 'node:test';
import assert from 'node:assert/strict';
import {allocationsURL} from '../owned-preview-module.mjs';
const {AllocationLedger,ALLOCATION_LIMITS:L}=await import(allocationsURL);
const reserve=(ledger,value={})=>ledger.reserve({owner:'test-owner',kind:'scratch',...value});

test('combined CPU admission leaves the sealed text group its own enforced capacity without counting the backend mirror',()=>{
 const ledger=new AllocationLedger();let text=0;ledger.observeTextReservations(()=>text);
 const lease=reserve(ledger,{cpuBytes:L.cpuBytes-L.textPartitionBytes});
 assert.throws(()=>reserve(ledger,{cpuBytes:1}),/ALLOCATION_BUDGET/);
 text=L.textPartitionBytes;const full=ledger.snapshot();assert.equal(full.cpuBytes,L.cpuBytes);assert.equal(full.text.ownedReservationBytes,text);assert.equal(full.text.reservedAdmissionCapacityBytes,text);
 assert.equal(full.byKind.text.cpuBytes,text);assert.equal(full.peaks.cpuBytes,L.cpuBytes-text);assert.equal(full.text.observedPeakBytes,text);assert.equal(full.peakScope,'lease-owners-only-text-observed-separately');
 text=0;lease.release();assert.equal(ledger.snapshot().cpuBytes,0);
});
test('over-budget resize is atomic and a released booking cannot be resurrected',()=>{
 const ledger=new AllocationLedger(),lease=reserve(ledger,{cpuBytes:10,handles:1});
 assert.throws(()=>lease.resize({cpuBytes:L.cpuBytes}),/ALLOCATION_BUDGET/);assert.equal(ledger.snapshot().cpuBytes,10);
 lease.release();lease.release();assert.equal(ledger.snapshot().cpuBytes,0);assert.equal(ledger.snapshot().handles,0);assert.throws(()=>lease.resize({cpuBytes:1}),/ALLOCATION_RELEASED/);
});
test('preview cache is a subset of charged CPU or estimated GPU and has no extra allowance',()=>{
 const ledger=new AllocationLedger();assert.throws(()=>reserve(ledger,{cpuBytes:1,previewCacheBytes:2}),/ALLOCATION_INVALID/);
 const lease=reserve(ledger,{cpuBytes:L.previewCacheBytes,previewCacheBytes:L.previewCacheBytes});assert.throws(()=>reserve(ledger,{cpuBytes:1,previewCacheBytes:1}),/ALLOCATION_BUDGET/);lease.release();
 const gpu=reserve(ledger,{gpuBytes:L.gpuBytes});assert.throws(()=>reserve(ledger,{gpuBytes:1}),/ALLOCATION_BUDGET/);gpu.release();
});
test('all live caption and prompt owners share one 64 MiB workspace envelope',()=>{
 const ledger=new AllocationLedger(),a=reserve(ledger,{kind:'prompt',cpuBytes:L.promptBytes/2}),b=reserve(ledger,{kind:'prompt',cpuBytes:L.promptBytes/2});
 assert.throws(()=>reserve(ledger,{kind:'prompt',cpuBytes:1}),/PROMPT_MEMORY_BUDGET/);assert.throws(()=>a.resize({cpuBytes:L.promptBytes}),/PROMPT_MEMORY_BUDGET/);
 assert.equal(ledger.snapshot().promptBytes,L.promptBytes);b.release();a.resize({cpuBytes:L.promptBytes});a.release();assert.equal(ledger.snapshot().promptBytes,0);assert.equal(ledger.snapshot().promptPeakBytes,L.promptBytes);
});
test('uncertain native cleanup remains charged and marks its unused handle until actual release',()=>{
 const ledger=new AllocationLedger(),lease=reserve(ledger,{cpuBytes:4096,handles:2});lease.markUnused();lease.markUnused();assert.equal(ledger.snapshot().unusedHandles,2);assert.equal(ledger.snapshot().cpuBytes,4096);lease.release();assert.equal(ledger.snapshot().unusedHandles,0);
});
test('allocation metadata and handles are bounded even for zero-byte objects',()=>{
 const ledger=new AllocationLedger(),leases=Array.from({length:L.records},()=>reserve(ledger));assert.throws(()=>reserve(ledger),/ALLOCATION_BUDGET/);for(const lease of leases)lease.release();assert.equal(ledger.snapshot().activeRecords,0);
 const handles=reserve(ledger,{handles:L.handles});assert.throws(()=>reserve(ledger,{handles:1}),/ALLOCATION_BUDGET/);handles.release();
});
test('invalid counts and raw payload-like owner labels never enter the read-only snapshot',()=>{
 const ledger=new AllocationLedger();for(const cpuBytes of [-1,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>reserve(ledger,{cpuBytes}),/ALLOCATION_INVALID/);
 assert.throws(()=>reserve(ledger,{owner:'https://private.invalid/prompt'}),/ALLOCATION_INVALID/);assert.equal(ledger.snapshot().activeRecords,0);
 const snapshot=ledger.snapshot();assert.equal(snapshot.complete,false);assert.equal(snapshot.deviceTextureLimit,null);assert.equal(snapshot.textureSide,null);assert.equal(snapshot.coverage.gpu,false);assert(snapshot.missing.includes('native-blob-residency'));
});
test('text observer cannot silently publish a negative or over-cap reservation',()=>{
 for(const bytes of [-1,L.textPartitionBytes+1,NaN])assert.throws(()=>new AllocationLedger().observeTextReservations(()=>bytes),/ALLOCATION_TEXT_OBSERVER/);
});

// This declaration is deliberately not the independent source/build proof used
// by resource qualification, and cannot make incomplete payload coverage pass.
test('Canvas2D reports bounded RGBA estimates without inventing an owned texture or device limit',()=>{
 const ledger=new AllocationLedger(),lease=reserve(ledger,{cpuBytes:64,gpuBytes:64,kind:'canvas'}),value=ledger.snapshot();
 assert.deepEqual(value.rendererOwnership,{contract:'canvas2d-owned-rgba-v1',backend:'main-thread-canvas-2d',appOwnedTextureAPIs:[],appOwnedTextureCount:0,textureLimitApplicability:'not-applicable',rgbaBackingEstimateBytes:64});
 assert.equal(value.complete,false);assert.equal(value.coverage.textureLimits,false);assert.equal(value.textureSide,null);assert.equal(value.deviceTextureLimit,null);assert(value.missing.includes('app-payload-ownership-incomplete'));
 lease.release();assert.equal(ledger.snapshot().rendererOwnership.rgbaBackingEstimateBytes,0);
});
