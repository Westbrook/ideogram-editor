import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {transformWithOxc} from 'vite';
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
export async function uiModule(path,replacements={}){let code=(await transformWithOxc(await readFile(path,'utf8'),path)).code;for(const [name,url]of Object.entries(replacements))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));return data(code);}
const {allocationsURL,promptMemoryURL}=await import(pathToFileURL(resolve('tests/owned-preview-module.mjs')).href);
export {allocationsURL,promptMemoryURL};
export const modelMemoryURL=await uiModule('src/observability/model-memory.ts',{'./allocations.js':allocationsURL,'./prompt-memory.js':promptMemoryURL});
export const uiModelOwnerURL=await uiModule((process.env.UI_MODEL_ROOT??'.')+'/src/ui/model-owner.ts',{'../observability/model-memory.js':modelMemoryURL,'../observability/prompt-memory.js':promptMemoryURL});
export const {readOwnedJSON}=await import(modelMemoryURL);
