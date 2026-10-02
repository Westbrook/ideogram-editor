import {resolveAdapterUploadModules,stagedModuleURL} from './adapter-upload-module.mjs';
const moduleURL=(name,replacements={},identity='')=>stagedModuleURL('src/observability/'+name+'.ts',replacements,identity);
// One actual module identity transfers bootstrap diagnostics into the same
// central ledger used by every tested owner. No snapshot or clone bypass.
export const diagnosticMemoryURL=await moduleURL('diagnostic-memory');
export const compositionObservationsURL=await moduleURL('composition-observations',{'./diagnostic-memory.js':diagnosticMemoryURL});
export const allocationsURL=await moduleURL('allocations',{'./diagnostic-memory.js':diagnosticMemoryURL,'./composition-observations.js':compositionObservationsURL});
export const phasesURL=await moduleURL('phases',{'./diagnostic-memory.js':diagnosticMemoryURL});
export const workerPhasesURL=await moduleURL('browser-worker-observations',{'./phases.js':phasesURL,'./diagnostic-memory.js':diagnosticMemoryURL});
export const navigationObservationsURL=await moduleURL('navigation-observations',{'./phases.js':phasesURL,'./diagnostic-memory.js':diagnosticMemoryURL});
export const promptMemoryURL=await moduleURL('prompt-memory',{'./allocations.js':allocationsURL});
export const {adapterUploadURL,adapterUploadHookURL}=await resolveAdapterUploadModules({diagnosticMemoryURL,allocationsURL,promptMemoryURL});
export const browserPhasesURL=await moduleURL('browser',{'./navigation-observations.js':navigationObservationsURL,'./phases.js':phasesURL,'./browser-worker-observations.js':workerPhasesURL,'./allocations.js':allocationsURL,'./diagnostic-memory.js':diagnosticMemoryURL,'./composition-observations.js':compositionObservationsURL,'./adapter-upload-hook.js':adapterUploadHookURL,'./adapter-upload.js':adapterUploadURL});
export const ownedPreviewURL=await moduleURL('owned-preview',{'./allocations.js':allocationsURL});

// Failure fixtures intentionally keep native cleanup owners. Each receives an
// independent *real* graph so those retained failures cannot taint another case.
let diagnosticSerial=0;
export async function isolatedDiagnosticModules(){
 const identity='isolated-diagnostic-fixture-'+ ++diagnosticSerial;
 const diagnosticMemoryURL=await moduleURL('diagnostic-memory',{},identity);
 const compositionObservationsURL=await moduleURL('composition-observations',{'./diagnostic-memory.js':diagnosticMemoryURL},identity);
 const allocationsURL=await moduleURL('allocations',{'./diagnostic-memory.js':diagnosticMemoryURL,'./composition-observations.js':compositionObservationsURL},identity);
 return {diagnosticMemoryURL,compositionObservationsURL,allocationsURL};
}
// Assertion-only projection: subtract the one frozen instrumentation baseline.
// Do not use this for admission. A new or leaked owner of any kind stays visible.
export function allocationDeltaSnapshot(ledger){
 const baseline=ledger.snapshot(),keys=['cpuBytes','gpuBytes','previewCacheBytes','handles'];
 return ()=>{const current=ledger.snapshot(),result={...current};
  for(const key of [...keys,'activeRecords','unusedHandles'])result[key]-=baseline[key];
  result.byKind=Object.fromEntries(Object.entries(current.byKind).map(([kind,value])=>[kind,Object.fromEntries(keys.map(key=>[key,value[key]-baseline.byKind[kind][key]]))]));
  result.peaks=Object.fromEntries(keys.map(key=>[key,current.peaks[key]-baseline.peaks[key]]));
  return result;
 };
}
