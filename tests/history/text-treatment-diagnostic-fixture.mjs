// Preserve the exact request-edit observer; add only explicit failure snapshots.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {openSync,fstatSync,readFileSync,closeSync} from 'node:fs';
import {observeNativeRequestWriter} from './native-request-memory-observation.mjs';
import {captureOwnedDiagnostics,installFailureDiagnostics} from './returned-description-observer-fixture.mjs';
import {installCandidatePreparationObservation} from './candidate-preparation-observation.mjs';
export async function setup(store){
 let resultSize='512';
 try{resultSize=await readFile(join(store.root,'text-treatment-result-size'),'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
 assert(resultSize==='512'||resultSize==='256','Only the existing local observer result grids are allowed');
 const {setup:setupObserver}=await import(new URL('../request-edits/observer-fixture.mjs?resultSize='+resultSize,import.meta.url).href);
 // Only the actual bounded native child opts into the additional transition ring.
 let observeRequests=false;
 try{const fd=openSync(join(store.root,'native-fixture-config.json'),'r');try{const stat=fstatSync(fd);if(stat.isFile()&&stat.size>0&&stat.size<=128){const config=JSON.parse(readFileSync(fd,'utf8'));observeRequests=config.version===1&&config.bounds===true&&config.encoded===false;}}finally{closeSync(fd);}}catch{}
 const closeObserver=await setupObserver(store),stopDiagnostics=installFailureDiagnostics(store),requestMemory=observeRequests?observeNativeRequestWriter(store):null;
 const stopCandidateObservation=installCandidatePreparationObservation(store,captureOwnedDiagnostics,requestMemory?{requestMemory:invocation=>requestMemory.snapshotForFailure(invocation.outputAssetId,{documentId:invocation.documentId})}:{});
 return async()=>{stopCandidateObservation();requestMemory?.close();stopDiagnostics();await closeObserver();};
}
