import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {allocationsURL}=await import(pathToFileURL(resolve('tests/owned-preview-module.mjs')).href);
export {allocationsURL};
const root=process.env.IE_DISPLAY_SOURCE_ROOT?process.env.IE_DISPLAY_SOURCE_ROOT.replace(/\/$/,'')+'/':'',data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
async function module(path,replacements={}){let code=(await transformWithOxc(await readFile(root+path,'utf8'),path)).code;for(const [name,url]of Object.entries(replacements))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));return data(code);}
export const displayProtocolURL=await module('src/protocol/display.ts');
export const displaySchedulerURL=await module('src/observability/display-scheduler.ts');
const shaURL=data((await transformWithOxc(await readFile('src/protocol/sha256.ts','utf8'),'sha256.ts')).code);
export const displayPreviewURL=await module('src/observability/display-preview.ts',{'./allocations.js':allocationsURL,'./display-scheduler.js':displaySchedulerURL,'../protocol/display.js':displayProtocolURL,'../protocol/sha256.js':shaURL});
