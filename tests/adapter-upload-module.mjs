import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {transformWithOxc} from 'vite';

const root=process.env.OBSERVABILITY_STAGED_ROOT??'.';
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');

// A partial source overlay supplies changed modules; unchanged dependencies
// retain the exact checkout source. No product modules execute in this resolver.
export async function readStagedSource(path){
 try{return await readFile(root+'/'+path,'utf8');}
 catch(error){if(root==='.'||error.code!=='ENOENT')throw error;return readFile(path,'utf8');}
}
export async function stagedModuleURL(path,replacements={},identity=''){
 let code=(await transformWithOxc(await readStagedSource(path),path)).code;
 for(const [name,url]of Object.entries(replacements))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));
 return data(code+(identity?'\n// '+identity:''));
}

// Accept the fixture's existing owners so the upload producer and BrowserPhases
// share the same diagnostic ledger and hook. Build only URLs: the large producer
// is still imported by the real ensureAdapterUploads/prepare dynamic boundary.
// This helper deliberately does not import owned-preview-module (no cycle).
export async function resolveAdapterUploadModules({diagnosticMemoryURL,allocationsURL,promptMemoryURL,modelMemoryURL,identity=''}={}){
 diagnosticMemoryURL??=await stagedModuleURL('src/observability/diagnostic-memory.ts',{},identity);
 if(!allocationsURL){
  const compositionObservationsURL=await stagedModuleURL('src/observability/composition-observations.ts',{'./diagnostic-memory.js':diagnosticMemoryURL},identity);
  allocationsURL=await stagedModuleURL('src/observability/allocations.ts',{'./diagnostic-memory.js':diagnosticMemoryURL,'./composition-observations.js':compositionObservationsURL},identity);
 }
 promptMemoryURL??=await stagedModuleURL('src/observability/prompt-memory.ts',{'./allocations.js':allocationsURL},identity);
 modelMemoryURL??=await stagedModuleURL('src/observability/model-memory.ts',{'./allocations.js':allocationsURL,'./prompt-memory.js':promptMemoryURL},identity);
 const sha256URL=await stagedModuleURL('src/protocol/sha256.ts',{},identity);
 const controlMemoryURL=await stagedModuleURL('src/state/control-memory.ts',{'../observability/allocations.js':allocationsURL},identity);
 // A type-only hook has no emitted owner imports. Bind its module identity to
 // the actual owners explicitly so independent real graphs cannot share it.
 const hookIdentity='adapter-upload-fixture-'+createHash('sha256').update(diagnosticMemoryURL).update('\0').update(allocationsURL).update('\0').update(identity).digest('hex');
 const adapterUploadHookURL=await stagedModuleURL('src/observability/adapter-upload-hook.ts',{},hookIdentity);
 const adapterUploadURL=await stagedModuleURL('src/observability/adapter-upload.ts',{
  '../protocol/sha256.js':sha256URL,'../state/control-memory.js':controlMemoryURL,
  './allocations.js':allocationsURL,'./model-memory.js':modelMemoryURL,
  './diagnostic-memory.js':diagnosticMemoryURL,'./adapter-upload-hook.js':adapterUploadHookURL,
 },identity);
 return {diagnosticMemoryURL,allocationsURL,promptMemoryURL,modelMemoryURL,sha256URL,controlMemoryURL,adapterUploadHookURL,adapterUploadURL};
}
