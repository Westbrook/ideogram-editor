import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {transformWithOxc} from 'vite';
import {modelMemoryURL,uiModelOwnerURL,allocationsURL,promptMemoryURL,readOwnedJSON} from '../ui-model-module.mjs';
export {modelMemoryURL,allocationsURL,readOwnedJSON};
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
export const litURL=data('export const nothing=null;export const html=(strings,...values)=>({strings,values});export const svg=html;');
export async function editModule(path,replacements={}){let code=(await transformWithOxc(await readFile(path,'utf8'),path)).code;code=code.replace(/import\s+["']\.\/(?:request-edits|candidate-comparison)\.css["'];?/g,'');for(const [key,value]of Object.entries(replacements))code=code.replaceAll(JSON.stringify(key),JSON.stringify(value)).replaceAll("'"+key+"'",JSON.stringify(value));return data(code);}
export const editModelsURL=await editModule('src/ui/request-edit-models.ts',{'../observability/model-memory.js':modelMemoryURL,'../observability/prompt-memory.js':promptMemoryURL,'./model-owner.js':uiModelOwnerURL});
const adaptersURL=await editModule('src/ui/adapters.ts');
const displayURL=data('export const displayImage=url=>url;export const readDisplaySource=()=>{throw Error("Unexpected display read");};export const createDisplayPreviewURL=readDisplaySource,withDisplaySource=readDisplaySource;export const displayPreviewInfo=()=>null;export const validateDisplayImage=()=>{};export const revokeDisplayPreviewURL=url=>globalThis.__requestEditRevoke?.(url);export async function retryDisplayPreviewCleanup(){}');
const common={'../observability/prompt-memory.js':promptMemoryURL,'lit':litURL,'../observability/model-memory.js':modelMemoryURL,'./adapters.js':adaptersURL,'./display-image.js':displayURL,'../observability/display-preview.js':displayURL};
const comparisonExtras={};if((await readFile('src/ui/candidate-comparison.ts','utf8')).includes('./comparison-view.js')){const viewport=await editModule('src/ui/comparison-viewport.ts',common),view=await editModule('src/ui/comparison-view.ts',{...common,'./comparison-viewport.js':viewport});Object.assign(comparisonExtras,{'./comparison-viewport.js':viewport,'./comparison-view.js':view});}
export const comparisonURL=await editModule('src/ui/candidate-comparison.ts',{...common,...comparisonExtras});
const selectionExtras={};if((await readFile('src/ui/request-edits.ts','utf8')).includes('./candidate-selection.js'))selectionExtras['./candidate-selection.js']=await editModule('src/ui/candidate-selection.ts',common);
const treatmentExtras={};if((await readFile('src/ui/request-edits.ts','utf8')).includes('./candidate-text-treatment.js'))treatmentExtras['./candidate-text-treatment.js']=await editModule('src/ui/candidate-text-treatment.ts',{...common,...Object.fromEntries(['protocol/json','protocol/sha256','request/text-treatment'].map(name=>['../'+name+'.js',pathToFileURL(resolve('dist/local/src/'+name+'.js')).href]))});
const maskURL=await editModule('src/ui/request-mask-memory.ts',{'../observability/allocations.js':allocationsURL});
export const requestEditsURL=await editModule('src/ui/request-edits.ts',{...common,...selectionExtras,...treatmentExtras,'./candidate-comparison.js':comparisonURL,'./request-mask-memory.js':maskURL,'./request-edit-models.js':editModelsURL,...Object.fromEntries(['protocol/json','protocol/asset-projection','request/core','request/raster-plan','raster/mask','raster/mapping'].map(name=>['../'+name+'.js',pathToFileURL(resolve('dist/local/src/'+name+'.js')).href]))});
