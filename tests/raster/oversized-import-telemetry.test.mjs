import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {deflateSync} from 'node:zlib';
import {ActiveCompute,ACTIVE_COMPUTE_RESERVATION_BYTES} from '../../dist/local/server/raster/active-compute.js';
import {PhaseRecorder} from '../../dist/local/src/observability/phases.js';
import {ImportTelemetry} from '../../dist/local/server/raster/import-telemetry.js';
import {importContributionRow} from '../../dist/local/server/raster/import-file-transform.js';
import {preparePNGImport} from '../../dist/local/server/raster/png-import.js';
import {chunk,PNG_SIGNATURE} from '../../dist/local/server/raster/png.js';
const owners=new Set(),reads=[];
function activeOwner(options){const active=new ActiveCompute(options);owners.add(active);return active;}
function importOwner(...args){const owner=new ImportTelemetry(...args);owners.add(owner);return owner;}
function finishActive(active,outcome){active.finish(outcome);const read=active.readSnapshot();reads.push(read);return read.value;}
test.afterEach(()=>{for(const read of reads.splice(0))read.release();for(const owner of [...owners].reverse())owner.dispose();owners.clear();});
function readPhases(recorder,inspect){const read=recorder.readSnapshot();try{return inspect(read.value.records);}finally{read.release();}}
test('large CP1 footprint counts actual synchronous chunks while excluding simulated reads and safepoint waits',async()=>{
 let now=0,reads=0,checks=0;const active=activeOwner({now:()=>now,wallNow:()=>1000});
 const source={width:8193,height:1,get(_x,_y,out){active.exclude(()=>{now+=37;reads++;});now+=2;out.set([255,255,255,255]);}};
 const row=await importContributionRow(source,0,1,[1/8193,0,0,1,0,0],()=>{checks++;now+=1000;},active);
 assert.deepEqual([...row],[255,255,255,255]);assert.equal(reads,8193);assert.ok(checks>=5);const snapshot=finishActive(active);assert.equal(snapshot.complete,true);assert.equal(snapshot.invalid,0);assert.equal(snapshot.operations.resample,3);assert.equal(snapshot.unionMs,2*8193);assert.equal(snapshot.totalMs,snapshot.unionMs);assert.ok(now>snapshot.totalMs);
});
test('crop preserves hidden RGB and ends synchronous intervals before a cancellation safepoint',async()=>{
 let now=0,reads=0;const active=activeOwner({now:()=>now,wallNow:()=>1000}),source={width:8192,height:1,get(_x,_y,out){reads++;now++;out.set([99,12,34,0]);}};
 await assert.rejects(importContributionRow(source,0,8192,[1,0,0,1,0,0],()=>{throw Error('RASTER_CANCELED');},active),/RASTER_CANCELED/);
 assert.equal(reads,4095);const snapshot=finishActive(active,'failed');assert.equal(snapshot.complete,false);assert.equal(snapshot.outcome,'failed');assert.equal(snapshot.unionMs,4095);assert.equal(snapshot.invalid,0);
 const pixel=await importContributionRow(source,0,1,[1,0,0,1,0,0],()=>{});assert.deepEqual([...pixel],[99,12,34,0]);
});
test('observed phase spans carry actual context, elapsed boundaries and terminal cancellation without fabricated completion',t=>{
 let now=0;const active=activeOwner({now:()=>now,wallNow:()=>1000}),recorder=new PhaseRecorder({lane:'raster-worker',capacity:16,openSpans:4,now:()=>now,wallNow:()=>1000}),telemetry=importOwner(active,recorder,{commandId:'import-command'},()=>now);
 t.after(()=>recorder.dispose());const decode=telemetry.start('decode',{sourceWidth:8193,sourceHeight:1});now=4;decode.end();decode.end();const resample=telemetry.start('resample',{width:1,height:1});now=7;resample.end();telemetry.start('encode');now=9;telemetry.fail(Error('RASTER_CANCELED'));telemetry.complete();
 assert.deepEqual(telemetry.metrics,{decodeMs:4,computeMs:3,encodeMs:2});readPhases(recorder,rows=>{assert.deepEqual(rows.map(row=>[row.phase,row.durationMs,row.outcome]),[['raster.decode',4,'ok'],['raster.resample',3,'ok'],['raster.encode',2,'cancelled']]);assert.ok(rows.every(row=>row.context.commandId==='import-command'));assert.equal(rows[0].context.boundary,'decoded');});
 const unfinished=importOwner(active);unfinished.start('decode');assert.throws(()=>unfinished.complete(),/RASTER_IMPORT_PHASE_UNFINISHED/);unfinished.fail(Error('RASTER_DECODE'));
});
test('real PNG import emits decode/resample/encode spans and bounded active computation without changing crop bytes',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'import-telemetry-'));t.after(()=>rm(directory,{recursive:true,force:true}));const input=join(directory,'original.png'),header=Buffer.alloc(13);header.writeUInt32BE(2);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;
 const encoded=Buffer.concat([PNG_SIGNATURE,chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,99,12,34,0,17,28,39,255]))),chunk('IEND',Buffer.alloc(0))]);await writeFile(input,encoded,{mode:0o600});
 const active=activeOwner(),recorder=new PhaseRecorder({lane:'raster-worker',capacity:16,openSpans:4}),telemetry=importOwner(active,recorder,{commandId:'actual-import'});let admissions=0;t.after(()=>recorder.dispose());
 const result=await preparePNGImport(input,directory,{kind:'crop',x:0,y:0,width:1,height:1},async plan=>{admissions++;assert.equal(plan.allocations.activeKernelTelemetry,ACTIVE_COMPUTE_RESERVATION_BYTES);},()=>{},false,telemetry);telemetry.complete();
 assert.equal(admissions,1);assert.deepEqual([...await readFile(result.raw)],[99,12,34,0]);assert.deepEqual(await readFile(input),encoded);readPhases(recorder,rows=>assert.deepEqual(rows.map(row=>[row.phase,row.outcome]),[['raster.decode','ok'],['raster.resample','ok'],['raster.encode','ok']]));const snapshot=finishActive(active);assert.equal(snapshot.complete,true);assert.ok(snapshot.operations.resample>0);assert.equal(snapshot.invalid,0);assert.ok(Object.values(telemetry.metrics).every(value=>Number.isFinite(value)&&value>=0));
});
