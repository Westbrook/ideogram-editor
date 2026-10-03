// Preserve the exact request-edit observer; add only explicit failure snapshots.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {captureOwnedDiagnostics,installFailureDiagnostics} from './returned-description-observer-fixture.mjs';
import {installCandidatePreparationObservation} from './candidate-preparation-observation.mjs';
export async function setup(store){
 let resultSize='512';
 try{resultSize=await readFile(join(store.root,'text-treatment-result-size'),'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
 assert(resultSize==='512'||resultSize==='256','Only the existing local observer result grids are allowed');
 const {setup:setupObserver}=await import(new URL('../request-edits/observer-fixture.mjs?resultSize='+resultSize,import.meta.url).href);
 const closeObserver=await setupObserver(store),stopDiagnostics=installFailureDiagnostics(store),stopCandidateObservation=installCandidatePreparationObservation(store,captureOwnedDiagnostics);
 return async()=>{stopCandidateObservation();stopDiagnostics();await closeObserver();};
}
