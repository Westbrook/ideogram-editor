// Explicit adaptation of JPEG resource-contract.mjs, sha256:ad333d1aef177cc7bb5f5a109bd8d4c7397feb375297c441b192839038aba0b9.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export const RSS_CAP=512*1048576,NATIVE_CAP=128*1048576,OUTPUT_CAP=Math.ceil(25000000*4/16384)*16384;
export const RESOURCE_CASES=Object.freeze(['lossless-oversized','lossy-oversized','repeated-lossless','repeated-lossy','contended-lossless','contended-lossy']);
const roles=['native-resources','writer-resources'];
const positive=n=>assert(Number.isSafeInteger(n)&&n>0);
const hash=h=>assert.match(h,/^sha256:[a-f0-9]{64}$/);
const name=n=>assert(typeof n==='string'&&n.length>0);
const nonnegative=n=>assert(Number.isSafeInteger(n)&&n>=0);
const whiteHashes=new Map();
export function expectedWhiteHash(bytes){positive(bytes);assert(bytes<=5120*5120*4);if(!whiteHashes.has(bytes)){const digest=createHash('sha256'),block=Buffer.alloc(65536,255);for(let at=0;at<bytes;at+=block.length)digest.update(block.subarray(0,Math.min(block.length,bytes-at)));whiteHashes.set(bytes,'sha256:'+digest.digest('hex'));}return whiteHashes.get(bytes);}
export const caseLossless=name=>name.includes('lossless');
export const requiredJobs=name=>name.startsWith('repeated-')?3:name.startsWith('contended-')?2:1;
function metric(m,budget) {
  assert.equal(m.nativeStatus,0);assert.equal(m.nativeRemaining,0);assert.equal(m.allocationDenied,0);assert.equal(m.outputRemaining,0);
  positive(m.nativePeak);assert(m.nativePeak<=NATIVE_CAP);positive(m.outputPeak);assert(m.outputPeak<=budget);positive(m.outputBytesWritten);
}
function rawBuffer(row,key,length){
  name(row[key+'Base64']);const value=Buffer.from(row[key+'Base64'],'base64');assert.equal(value.length,length);assert.equal(value.toString('base64'),row[key+'Base64']);
  hash(row[key+'Hash']);assert.equal(row[key+'Hash'],'sha256:'+createHash('sha256').update(value).digest('hex'));return value;
}
function nativeBufferProof(tile,{fixture,candidateHash,authorizationHash,outputBudget}){
  assert.equal(tile.candidateHash,candidateHash);assert.equal(tile.authorizationHash,authorizationHash);assert.equal(tile.outputBudget,outputBudget);
  const metrics=rawBuffer(tile,'metrics',48),request=rawBuffer(tile,'request',112);
  for(const [index,key]of ['nativePeak','nativeRemaining','allocationDenied','outputPeak','outputRemaining','outputBytesWritten'].entries())assert.equal(metrics.readBigUInt64LE(index*8),BigInt(tile[key]));
  assert.equal(request.readUInt32LE(0),1);assert.equal(request.readUInt32LE(4),112);assert.equal(request.readBigUInt64LE(8),BigInt(fixture.bytes));
  const image=fixture.descriptor.image;assert.equal(image.type,fixture.lossless?'VP8L':'VP8 ');positive(image.offset);positive(image.length);assert(image.offset+image.length<=fixture.bytes);
  assert.equal(request.readBigUInt64LE(16),BigInt(image.offset));assert.equal(request.readBigUInt64LE(24),BigInt(image.length));
  assert.equal(request.readBigUInt64LE(32),0n);assert.equal(request.readBigUInt64LE(40),0n);
  for(const [offset,value]of [[48,fixture.lossless?2:1],[52,fixture.width],[56,fixture.height],[60,0],[64,tile.region.cropLeft],[68,tile.region.cropTop],[72,tile.region.cropWidth],[76,tile.region.cropHeight],[80,0],[84,tile.region.cropWidth],[88,tile.region.cropHeight],[92,0]])assert.equal(request.readUInt32LE(offset),value);
  assert.equal(request.readBigUInt64LE(96),BigInt(NATIVE_CAP));assert.equal(request.readBigUInt64LE(104),BigInt(outputBudget));
}
export function validateResourceObservation(value,{role,caseName,fixture,candidateHash,artifactHash,haloProofHash,authorizationHash}) {
  assert(roles.includes(role)&&RESOURCE_CASES.includes(caseName));assert.equal(fixture.independentExpected,'uniform-white-rgba8');assert.equal(fixture.width,5120);assert.equal(fixture.height,5120);assert(fixture.width*fixture.height>25000000);hash(fixture.hash);assert.equal(fixture.lossless,caseLossless(caseName));
  assert.equal(value.kind,'webp-resource-job-observation-v1');assert.equal(value.status,'completed');assert.equal(value.role,role);assert.equal(value.case,caseName);name(value.id);
  positive(fixture.bytes);for(const [key,expected]of Object.entries({candidateHash,artifactHash,haloProofHash,authorizationHash})){hash(expected);assert.equal(value[key],expected);}
  assert.equal(value.measurement,'whole-process-rss');assert.equal(value.rssSource,'process.resourceUsage().maxRSS-kib');positive(value.maxRSSBytes);assert(value.maxRSSBytes<=RSS_CAP);
  assert.equal(value.nativeRemaining,0);assert.equal(value.outputRemaining,0);positive(value.process.pid);assert.equal(value.process.node,'26.10.0');assert(['darwin','linux'].includes(value.process.platform));assert(['arm64','x64'].includes(value.process.arch));
  assert.equal(value.completions.length,requiredJobs(caseName));const ids=new Set();
  for(const row of value.completions){
    name(row.id);assert(!ids.has(row.id));ids.add(row.id);assert.equal(row.status,'completed');assert.equal(row.inputHash,fixture.hash);assert.equal(row.originalWidth,fixture.width);assert.equal(row.originalHeight,fixture.height);
    positive(row.outputBudget);assert(row.outputBudget<=OUTPUT_CAP);metric(row,row.outputBudget);positive(row.tileCount);assert.equal(row.nativeTiles.length,row.tileCount);
    let written=0,corePixels=0;const tileIndices=new Set();
    for(const tile of row.nativeTiles){assert(Number.isSafeInteger(tile.tileIndex)&&tile.tileIndex>=0&&tile.tileIndex<row.tileCount);assert(!tileIndices.has(tile.tileIndex));tileIndices.add(tile.tileIndex);metric(tile,row.outputBudget);
      const region=tile.region;for(const key of ['width','height','cropWidth','cropHeight'])positive(region[key]);for(const key of ['x','y','cropLeft','cropTop','trimLeft','trimTop'])nonnegative(region[key]);
      assert(region.x+region.width<=fixture.width&&region.y+region.height<=fixture.height);assert(region.cropLeft+region.cropWidth<=fixture.width&&region.cropTop+region.cropHeight<=fixture.height);
      assert.equal(region.x-region.cropLeft,region.trimLeft);assert.equal(region.y-region.cropTop,region.trimTop);assert(region.trimLeft+region.width<=region.cropWidth&&region.trimTop+region.height<=region.cropHeight);
      assert.equal(region.cropLeft%2,0);assert.equal(region.cropTop%2,0);assert(region.cropWidth<=8192&&region.cropHeight<=8192&&region.cropWidth*region.cropHeight<=25000000);
      assert.equal(tile.outputBytesWritten,region.cropWidth*region.cropHeight*4);assert(tile.outputBytesWritten<=tile.outputPeak);written+=tile.outputBytesWritten;corePixels+=region.width*region.height;
      nativeBufferProof(tile,{fixture,candidateHash,authorizationHash,outputBudget:row.outputBudget});
      if(role==='native-resources'){
        assert(tile.attempts.length>0);for(const [ordinal,attempt]of tile.attempts.entries()){
          assert.equal(attempt.ordinal,ordinal);assert(Number.isFinite(attempt.startedAtMs)&&Number.isFinite(attempt.endedAtMs)&&attempt.startedAtMs<attempt.endedAtMs);
          assert.equal(attempt.nativeStatus,ordinal===tile.attempts.length-1?0:5);if(attempt.nativeStatus===5)assert(caseName.startsWith('contended-'));
          for(const key of ['nativePeak','outputPeak','outputBytesWritten'])nonnegative(attempt[key]);assert(attempt.nativePeak<=NATIVE_CAP&&attempt.outputPeak<=row.outputBudget);
          assert.equal(attempt.nativeRemaining,0);assert.equal(attempt.outputRemaining,0);assert.equal(attempt.allocationDenied,0);if(attempt.nativeStatus===5)assert.equal(attempt.outputBytesWritten,0);
          nativeBufferProof({...attempt,region},{fixture,candidateHash,authorizationHash,outputBudget:row.outputBudget});
        }
        for(const key of ['nativeStatus','nativePeak','nativeRemaining','allocationDenied','outputPeak','outputRemaining','outputBytesWritten','requestBase64','requestHash','metricsBase64','metricsHash'])assert.equal(tile[key],tile.attempts.at(-1)[key]);
        const output=tile.output,bytes=region.cropWidth*region.cropHeight*4;assert.equal(output.width,region.cropWidth);assert.equal(output.height,region.cropHeight);assert.equal(output.bytes,bytes);assert.equal(output.verifiedBytes,bytes);assert.equal(output.hash,expectedWhiteHash(bytes));assert.equal(output.expectedHash,output.hash);
      }
    }
    assert.equal(corePixels,fixture.width*fixture.height);for(let i=0;i<row.nativeTiles.length;i++)for(let j=i+1;j<row.nativeTiles.length;j++){const a=row.nativeTiles[i].region,b=row.nativeTiles[j].region;assert(a.x+a.width<=b.x||b.x+b.width<=a.x||a.y+a.height<=b.y||b.y+b.height<=a.y,'Core tiles must cover the original exactly once');}
    assert.equal(row.nativePeak,Math.max(...row.nativeTiles.map(t=>t.nativePeak)));assert.equal(row.outputPeak,Math.max(...row.nativeTiles.map(t=>t.outputPeak)));assert.equal(row.outputBytesWritten,written);
    const out=row.output;assert.equal(out.width,role==='native-resources'?fixture.width:5000);assert.equal(out.height,role==='native-resources'?fixture.height:5000);positive(out.bytes);assert.equal(out.bytes,out.width*out.height*4);assert.equal(out.verifiedBytes,out.bytes);hash(out.hash);hash(out.expectedHash);assert.equal(out.hash,out.expectedHash);assert.equal(out.expectedHash,expectedWhiteHash(out.bytes));
    if(role==='native-resources'){
      assert.equal(out.width,fixture.width);assert.equal(out.height,fixture.height);assert.equal(row.sourceOffsetPreserved,true);assert.equal(row.descriptors.remainingOwned,0);assert(row.descriptors.closed.length>=row.tileCount+2);assert(row.descriptors.closed.every(d=>d.closeReturned===true));
    }else{
      assert.equal(out.width,5000);assert.equal(out.height,5000);const commands=new Set();
      for(const c of row.commands){name(c.commandId);assert(!commands.has(c.commandId));commands.add(c.commandId);assert.equal(c.status,'accepted');}
      for(const type of ['InspectRasterOriginal','PrepareRaster','ReviewRaster','ApproveRaster'])assert.equal(row.commands.filter(c=>c.type===type).length,1);
      assert.equal(row.stagingDescriptorClosed,true);assert.equal(row.originalRetained,true);assert.equal(row.manifestVerified,true);
    }
  }
  if(caseName.startsWith('contended-')){
    const c=value.concurrency;assert.equal(c.kind,role==='native-resources'?'worker-overlap-v1':'writer-queue-overlap-v1');assert.equal(c.completed,2);assert.equal(c.overlapObserved,true);assert.equal(c.operations.length,2);assert.deepEqual(c.operations.map(o=>o.id).sort(),[...ids].sort());
    for(const o of c.operations)assert(Number.isFinite(o.startedAtMs)&&Number.isFinite(o.endedAtMs)&&o.startedAtMs<o.endedAtMs);
    assert(Math.max(...c.operations.map(o=>o.startedAtMs))<Math.min(...c.operations.map(o=>o.endedAtMs)));
    if(role==='native-resources'){
      const calls=value.completions.flatMap(row=>row.nativeTiles.flatMap(t=>t.attempts.map(a=>({id:row.id,tileIndex:t.tileIndex,ordinal:a.ordinal,startedAtMs:a.startedAtMs,endedAtMs:a.endedAtMs,nativeStatus:a.nativeStatus}))));assert.deepEqual(c.nativeCalls,calls);
      for(const call of calls){assert(Number.isFinite(call.startedAtMs)&&Number.isFinite(call.endedAtMs)&&call.startedAtMs<call.endedAtMs);assert([0,5].includes(call.nativeStatus));}
      assert(calls.some(a=>calls.some(b=>a.id!==b.id&&a.startedAtMs<b.endedAtMs&&b.startedAtMs<a.endedAtMs)),'Actual cross-worker native calls must overlap');
    }else{
      const commands=value.completions.map(row=>{const p=row.commands.find(x=>x.type==='PrepareRaster');return {id:row.id,commandId:p.commandId,startedAtMs:p.startedAtMs,endedAtMs:p.endedAtMs};}),byId=(a,b)=>a.id.localeCompare(b.id);assert.deepEqual([...c.prepareCommands].sort(byId),[...commands].sort(byId));
      for(const command of commands)assert(Number.isFinite(command.startedAtMs)&&Number.isFinite(command.endedAtMs)&&command.startedAtMs<command.endedAtMs);
      assert(Math.max(...commands.map(c=>c.startedAtMs))<Math.min(...commands.map(c=>c.endedAtMs)),'Actual PrepareRaster command intervals must overlap');
    }
  }
  if(role==='writer-resources'){
    assert(value.workerStates.length>0);for(const item of value.workerStates){assert.equal(item.state.activeJobs,0);assert.equal(item.state.retainedJobReferences,0);assert.equal(item.state.completedJobs,item.expectedCompletedJobs);assert.equal(item.state.workerCount,1);assert.equal(item.state.idleWorkers,1);positive(item.state.identity.threadId);assert.equal(item.ownedScratchEmpty,true);}
    if(caseName.startsWith('repeated-')){assert.equal(value.restart.completed,true);name(value.restart.previousEpoch);name(value.restart.newEpoch);assert.notEqual(value.restart.previousEpoch,value.restart.newEpoch);assert.equal(value.restart.priorAssetsVerified,2);}
  }else{assert.equal(value.libraryDescriptors.remainingOwned,0);assert(value.libraryDescriptors.closed.length>0);assert(value.libraryDescriptors.closed.every(d=>d.closeReturned===true));}
  return {id:value.id,case:caseName,role,status:'completed',originalWidth:fixture.width,originalHeight:fixture.height,maxRSSBytes:value.maxRSSBytes,nativeRemaining:0,outputRemaining:0};
}
export function summarizeResourceJobs(jobs){
  assert.equal(jobs.length,RESOURCE_CASES.length);assert.deepEqual(jobs.map(j=>j.case).sort(),[...RESOURCE_CASES].sort());const ids=new Set(),role=jobs[0].role;assert(roles.includes(role));
  for(const row of jobs){name(row.id);assert(!ids.has(row.id));ids.add(row.id);assert.equal(row.role,role);assert.equal(row.status,'completed');assert.equal(row.originalWidth,5120);assert.equal(row.originalHeight,5120);positive(row.maxRSSBytes);assert(row.maxRSSBytes<=RSS_CAP);assert.equal(row.nativeRemaining,0);assert.equal(row.outputRemaining,0);}
  const maximumPeakRSSBytes=Math.max(...jobs.map(j=>j.maxRSSBytes));return {jobs,completedJobs:jobs.length,maxRSSBytes:maximumPeakRSSBytes,maximumPeakRSSBytes,nativeRemaining:0,outputRemaining:0};
}
