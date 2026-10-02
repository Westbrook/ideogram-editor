// Shared source-only loader for the existing request controller suites. All
// controllers and validators are real; Lit and the DOM-only image directive
// expose their template values to the Node assertions.
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,posix} from 'node:path';
import {pathToFileURL} from 'node:url';
import {transformWithOxc,parseSync} from 'vite';
const {allocationsURL,ownedPreviewURL,promptMemoryURL,diagnosticMemoryURL,compositionObservationsURL}=await import(pathToFileURL(resolve('tests/owned-preview-module.mjs')).href);
const {displayPreviewURL}=await import(pathToFileURL(resolve('tests/display-module.mjs')).href);
export {allocationsURL,promptMemoryURL};
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const lit=data('export const nothing=null;export const noChange=Symbol.for("lit-noChange");export function html(strings,...values){return {strings,values};}export const svg=html;');
const modules=new Map([
 ['lit',Promise.resolve(lit)],
 ['lit/directives/repeat.js',Promise.resolve(data('export const repeat=(items,key,render)=>Array.from(items,render);'))],
 ['src/ui/display-image.js',Promise.resolve(data('export const displayImage=value=>value;'))],
 ['src/observability/allocations.js',Promise.resolve(allocationsURL)],
 ['src/observability/diagnostic-memory.js',Promise.resolve(diagnosticMemoryURL)],
 ['src/observability/composition-observations.js',Promise.resolve(compositionObservationsURL)],
 ['src/observability/owned-preview.js',Promise.resolve(ownedPreviewURL)],
 ['src/observability/prompt-memory.js',Promise.resolve(promptMemoryURL)],
 ['src/observability/display-preview.js',Promise.resolve(displayPreviewURL)],
]);
const roots=[...new Set([process.env.REQUEST_PROMPT_ROOT,process.env.REQUEST_RESPONSES_ROOT,process.env.REQUEST_EDIT_RESPONSES_ROOT,process.env.REQUEST_CONTROLLER_SUPPORT_ROOT,'.'].filter(Boolean))];
async function source(path){
 for(const root of roots){try{return await readFile(resolve(root,path.replace(/\.js$/,'.ts')),'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}}
 throw Error('Missing request controller source: '+path);
}
function moduleURL(path){
 if(modules.has(path))return modules.get(path);
 if(!path.startsWith('src/ui/')&&!path.startsWith('src/observability/')&&path!=='src/composition/memory.js')return Promise.resolve(pathToFileURL(resolve('dist/local',path)).href);
 const pending=(async()=>{
  const original=await source(path),sourceHash=createHash('sha256').update(original).digest('hex');
  let code=(await transformWithOxc(original,path.replace(/\.js$/,'.ts'))).code;
  const parsed=parseSync(path,code,{lang:'js'});
  if(parsed.errors.length)throw Error('Invalid request controller fixture source: '+path);
  // Only module declarations are rewritten. Template text can contain words
  // such as "import" and "from" without becoming a fixture dependency.
  const imports=parsed.program.body.filter(node=>['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration'].includes(node.type)&&node.source);
  for(const node of imports.reverse()){
   const specifier=node.source.value;
   // CSS is the only browser side effect removed; controller code is unchanged.
   if(node.type==='ImportDeclaration'&&!node.specifiers.length&&specifier.endsWith('.css')){code=code.slice(0,node.start)+code.slice(node.end);continue;}
   const dependency=specifier.startsWith('.')?posix.normalize(posix.join(posix.dirname(path),specifier)):specifier;
   if(!dependency.startsWith('src/')&&!modules.has(dependency))throw Error('Unsupported request controller dependency: '+specifier+' in '+path);
   const url=await moduleURL(dependency);code=code.slice(0,node.source.start)+JSON.stringify(url)+code.slice(node.source.end);
  }
  // V8 uses this source identity in stacks instead of expanding nested data URLs.
  // It names the actual input bytes; no controller or stack frame is substituted.
  return data(code+'\n//# sourceURL=ideogram-request-controller/'+path.replace(/\.js$/,'.ts')+'?sha256='+sourceHash+'\n');
 })();modules.set(path,pending);return pending;
}
export const modelMemoryURL=await moduleURL('src/observability/model-memory.js');
export const {createOwnedModel,cloneOwnedModel,modelPayloadBytes,readOwnedJSON}=await import(modelMemoryURL);
export const {allocationLedger}=await import(allocationsURL);
export const {RequestEditing}=await import(await moduleURL('src/ui/request.js'));
