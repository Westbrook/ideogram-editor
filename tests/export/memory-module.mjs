// Load the actual ownership helpers with the same ledger/reader instances as
// display fixtures. The optional root is for an explicitly overlaid source run.
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';
import {allocationsURL,promptMemoryURL} from '../owned-preview-module.mjs';
export {allocationsURL};
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const root=process.env.IE_EXPORT_SOURCE_ROOT?process.env.IE_EXPORT_SOURCE_ROOT.replace(/\/$/,'')+'/':'';
async function module(path,replacements={}){
 let code=(await transformWithOxc(await readFile(path,'utf8'),path)).code;
 for(const [name,url]of Object.entries(replacements))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));
 return data(code);
}
export const modelMemoryURL=await module('src/observability/model-memory.ts',{'./allocations.js':allocationsURL,'./prompt-memory.js':promptMemoryURL});
export const exportMemoryURL=await module(root+'src/ui/export-memory.ts',{'../observability/model-memory.js':modelMemoryURL});
