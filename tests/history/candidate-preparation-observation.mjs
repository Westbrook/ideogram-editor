// Test-only observation of the actual candidate raster rejection. This hook
// grants no capacity, retries no operation, and never substitutes its outcome.
import assert from 'node:assert/strict';
import {writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';

export function installCandidatePreparationObservation(store,captureOwnedDiagnostics,{requestMemory}={}){
 const owner=store.rasters,original=owner.prepareDocument;let active=true;
 const observed=async function(...args){
  try{return await Reflect.apply(original,this,args);}catch(error){
   if(active&&args[0]?.type==='PrepareCandidate')try{
    // The second argument is the proposed output asset ID, not a public queue
    // command ID. Keep the historical commandId field for existing readers.
    const value={kind:'candidate-copy-raster-failure-1',commandId:args[1],outputAssetId:args[1],slot:args[2],inputAssetId:args[0].assetId,documentId:args[5]??null,error:{name:String(error?.name??'Unknown').slice(0,80),code:typeof error?.code==='string'?error.code.slice(0,80):null,reason:typeof error?.reason==='string'?error.reason.slice(0,160):null},snapshot:JSON.parse(captureOwnedDiagnostics(store,args[1]))};
    // The optional observer returns only bounded scalar transition evidence;
    // keep it outside the independently bounded owned-resource snapshot.
    if(requestMemory)try{const observation=requestMemory({outputAssetId:args[1],slot:args[2],inputAssetId:args[0].assetId,documentId:args[5]??null});if(Buffer.byteLength(JSON.stringify(observation))<=6144)value.requestMemory=observation;}catch{}
    const bytes=Buffer.from(JSON.stringify(value));assert(bytes.length<=270336);
    const path=join(store.root,'candidate-copy-raster-failure.json');writeFileSync(path+'.tmp',bytes,{mode:0o600});renameSync(path+'.tmp',path);
   }catch{}
   throw error;
  }
 };
 owner.prepareDocument=observed;
 return ()=>{active=false;if(owner.prepareDocument===observed)owner.prepareDocument=original;};
}
