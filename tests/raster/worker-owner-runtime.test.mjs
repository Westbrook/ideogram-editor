import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Run only after root promotes and builds the staged worker implementation
// under the repository's pinned native-codec environment. No injected port.
const {RasterWorkerOwner}=await import(pathToFileURL(resolve('dist/local/server/raster/worker-owner.js')).href);
const {compositionResourcePlan}=await import(pathToFileURL(resolve('dist/local/server/raster/resource-plan.js')).href);
test('real raster worker survives two jobs, restarts idle, then computes identical pixels on its replacement',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'ie-persistent-raster-')),owner=new RasterWorkerOwner(),admissions=[],phases=[];
 const hooks={check(){assert(process.memoryUsage().rss<=512*1024**2);},admit(plan){assert(Number.isSafeInteger(plan.cpuBytes));assert(plan.cpuBytes>0&&plan.cpuBytes<512*1024**2);assert(Number.isSafeInteger(plan.diskBytes)&&plan.diskBytes>0);admissions.push(plan);},failure(message){return Error(message.code);},telemetry(value){phases.push(value);}};
 try{
  const output=[];
  const work=async(index,warm=false)=>{const directory=join(root,String(index));await mkdir(directory,{mode:0o700});const lease=warm?owner.readyIdentity:undefined;if(warm)assert(lease);const result=await owner.run({type:'compose',directory,width:1,height:1,layers:[],inputs:[],dependencies:[]},'history:actual-'+index,hooks,lease);assert.deepEqual(result.plan,compositionResourcePlan(1,1,[],[]));assert.deepEqual(admissions.at(-1),result.plan);assert.deepEqual([...await readFile(join(directory,'pixels.rgba'))],[0,0,0,0]);output.push(result);return owner.snapshot;};
  const first=await work(1),second=await work(2,true);assert.equal(second.identity.threadId,first.identity.threadId);assert.equal(second.identity.generation,first.identity.generation);assert.equal(second.completedJobs,2);assert.equal(second.retainedJobReferences,0);assert.equal(second.idleWorkers,1);
  const receipt=await owner.restartIdle(second.generation);assert.notEqual(receipt.before.threadId,receipt.after.threadId);assert.equal(receipt.after.generation,receipt.before.generation+1);assert.equal(owner.snapshot.completedJobs,2,'Restart did not run an invented raster job');
  const third=await work(3);assert.equal(third.lastCompleted.generation,receipt.after.generation);assert.equal(third.completedJobs,3);assert.equal(third.retainedJobReferences,0);assert.equal(admissions.length,3);assert.equal(phases.length,3);
  assert.equal(output[0].info.pixelIdentity,output[1].info.pixelIdentity);assert.equal(output[0].info.pixelIdentity,output[2].info.pixelIdentity);assert.equal(output[0].png.hash,output[2].png.hash);
 }finally{await owner.close();assert.equal(owner.snapshot.workerCount,0);await rm(root,{recursive:true,force:true});}
});
