// Test-only owning-writer instrumentation. The provider emulator is the same
// guarded fixture used by deferred adoption; storage and raster work stay real.
import {readFileSync,writeFileSync,renameSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {installFailureDiagnostics} from './returned-description-observer-fixture.mjs';
import {AssetRejection} from '../../dist/local/server/storage/assets.js';

export async function setup(store){
 let resultSize='512';try{resultSize=readFileSync(join(store.root,'text-treatment-result-size'),'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
 assert(resultSize==='512'||resultSize==='256','Only the existing local observer result grids are allowed');
 const {setup:providerSetup}=await import(new URL('../request-edits/observer-fixture.mjs?resultSize='+resultSize,import.meta.url).href);
 const closeProvider=await providerSetup(store),config=JSON.parse(readFileSync(join(store.root,'encoded-guard-config.json'),'utf8'));
 const stopDiagnostics=installFailureDiagnostics(store);
 const original={command:store.histories.command,prepare:store.histories.prepare,liveReview:store.histories.liveReview,compute:store.rasters.compute,preserve:store.rasters.prepareEncodedPreservation,retained:store.candidates.retainedPreservation};
 for(const key of ['prove','verify','readRange'])original[key]=store.objects[key];
 const guarded=new Set(),rawPaths=new Set(),violations=[],commands=[],workerJobs=[],workDirectories=[],proofs=()=>store.objects.proofInventory();
 let armed=false,current,liveReadCount=0,windowEnd=null;
 const protecting=()=>armed&&windowEnd===null;
 const heldSnapshot=()=>{const path=join(store.root,'encoded-acceptance-held.json');writeFileSync(path+'.tmp',JSON.stringify({commandId:current,liveReadCount,leases:store.histories.encodedReviewProofInventory(),proofs:proofs()}),{mode:0o600});renameSync(path+'.tmp',path);};
 const fail=(operation,identity)=>{violations.push({operation,identity});throw new AssetRejection('INVALID_INPUT','ENCODED_GUARD_OLD_RAW_READ');};
 const save=()=>{const rasterRead=store.rasters.readDiagnostics();try{const path=join(store.root,'encoded-guard-observation.json');writeFileSync(path+'.tmp',JSON.stringify({armed,windowEnd,guarded:[...guarded],violations,commands,workerJobs,workRemoved:workDirectories.map(directory=>!existsSync(directory)),proofs:proofs(),leases:store.histories.encodedReviewProofInventory(),raster:rasterRead.value,observations:rasterRead.value.observations.filter(item=>item.phase==='encoded-input-rebuild')}),{mode:0o600});renameSync(path+'.tmp',path);}finally{rasterRead.release();}};
 store.histories.command=function(bytes,auth){
  const request=JSON.parse(Buffer.from(bytes).toString('utf8'));
  // Only the explicitly identified post-read checkpoint may end this test's
  // negative acceptance/read window. The actual public history mutation still
  // proves its full retained closure with the normal product implementation.
  const boundaryPath=join(store.root,'encoded-guard-checkpoint-boundary.json');
  if(protecting()&&request.command.body.type==='SaveCheckpoint'&&existsSync(boundaryPath)){
   const boundary=JSON.parse(readFileSync(boundaryPath,'utf8')),row=store.db.prepare('SELECT original,receipt FROM commands WHERE id=?').get(boundary.acceptedCommandId),accepted=row&&JSON.parse(row.original).command,receipt=row&&JSON.parse(row.receipt),proofState=proofs(),leases=store.histories.encodedReviewProofInventory();
   if(boundary.checkpointCommandId!==request.command.commandId||accepted?.body.type!=='AdoptReviewedCandidate'||accepted.body.reviewId!==boundary.reviewId||accepted.documentId!==request.command.documentId||receipt?.status!=='accepted'||receipt.commandId!==boundary.acceptedCommandId||receipt.documentRevision!==request.command.expectedDocumentRevision||violations.length||Object.values(proofState).some(value=>value!==0)||Object.values(leases).some(value=>value!==0))throw Error('ENCODED_GUARD_CHECKPOINT_BOUNDARY_INVALID');
   windowEnd={checkpointCommandId:boundary.checkpointCommandId,acceptedCommandId:boundary.acceptedCommandId,reviewId:boundary.reviewId,proofs:proofState,leases,violations:[...violations]};save();
  }
  if(request.command.body.type==='AdoptReviewedCandidate'){
   const row=store.db.prepare('SELECT json FROM image_edit_reviews WHERE id=?').get(request.command.body.reviewId),review=row&&JSON.parse(row.json);
   if(review?.inputs?.encodedRebuild){
    current=request.command.commandId;
    if(!armed){for(const row of store.db.prepare("SELECT DISTINCT r.hash,r.media_type,o.byte_length FROM roots r JOIN objects o ON o.hash=r.hash WHERE r.media_type IN ('application/x-ideogram-rgba8','application/x-ideogram-r16le')").all()){
     guarded.add(row.hash);rawPaths.add(store.objects.path({hash:row.hash,byteLength:row.byte_length,mediaType:row.media_type}));
    }armed=true;}
   }
  }
  return original.command.call(this,bytes,auth);
 };
 for(const key of ['prove','verify','readRange'])store.objects[key]=function(ref,...args){
  if(protecting()&&guarded.has(ref.hash))fail(key,ref.hash);
  return original[key].call(this,ref,...args);
 };
 store.candidates.retainedPreservation=function(...args){if(protecting())fail('retainedPreservation','global-Q-lookup');return original.retained.apply(this,args);};
 const capability=value=>{if(protecting()&&typeof value==='string'&&rawPaths.has(value))fail('worker-capability',value);if(value&&typeof value==='object')for(const item of Object.values(value))capability(item);};
 store.rasters.compute=function(job,slot,...args){if(armed){capability(job);workerJobs.push({type:job.type,slot});workDirectories.push(job.directory);}return original.compute.call(this,job,slot,...args);};
 store.rasters.prepareEncodedPreservation=async function(...args){
  if(config.hold){
   heldSnapshot();
   const deadline=Date.now()+15000;
   while(!existsSync(join(store.root,'encoded-acceptance-release'))){if(Date.now()>=deadline)throw new AssetRejection('INVALID_INPUT','ENCODED_GUARD_HOLD_EXPIRED');await new Promise(resolve=>setTimeout(resolve,5));}
  }
  const result=await original.preserve.apply(this,args);
  if(config.failure){for(const proof of result.proofs)store.objects.releaseProof(proof.token);throw new AssetRejection('INVALID_INPUT','ENCODED_GUARD_AFTER_PRESERVE');}
  return result;
 };
 store.histories.liveReview=function(...args){const result=original.liveReview.apply(this,args);if(armed){if(config.hold){liveReadCount++;heldSnapshot();}save();}return result;};
 store.histories.prepare=async function(id,...args){try{return await original.prepare.call(this,id,...args);}finally{if(armed&&id===current){const row=store.db.prepare('SELECT receipt FROM commands WHERE id=?').get(id);commands.push({commandId:id,receipt:row?JSON.parse(row.receipt):null,proofs:proofs(),leases:store.histories.encodedReviewProofInventory()});save();}}};
 return async()=>{
  stopDiagnostics();
  store.histories.command=original.command;store.histories.prepare=original.prepare;store.histories.liveReview=original.liveReview;store.rasters.compute=original.compute;store.rasters.prepareEncodedPreservation=original.preserve;store.candidates.retainedPreservation=original.retained;
  for(const key of ['prove','verify','readRange'])store.objects[key]=original[key];
  await closeProvider();if(armed)save();
 };
}
