import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';
import {allocationsURL,promptMemoryURL} from './owned-preview-module.mjs';
export {allocationsURL,promptMemoryURL};
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
export async function uiModule(path,replacements={}){
  let code=(await transformWithOxc(await readFile(path,'utf8'),path)).code;
  for(const [name,url]of Object.entries(replacements))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));
  return data(code);
}
export const modelMemoryURL=await uiModule('src/observability/model-memory.ts',{'./allocations.js':allocationsURL,'./prompt-memory.js':promptMemoryURL});
export const uiModelOwnerURL=await uiModule('src/ui/model-owner.ts',{'../observability/model-memory.js':modelMemoryURL,'../observability/prompt-memory.js':promptMemoryURL});
export const {readOwnedJSON}=await import(modelMemoryURL);
/** Existing UI fixtures may continue replacing json() for their protocol
 * scenarios; the actual bounded reader/parsed owner now consumes that result. */
export function ownFixtureJSON(editor){
  editor.ownedJSON=(path,owner,init,owns,maxBytes,kind)=>readOwnedJSON(async()=>{
    const text=JSON.stringify(await editor.json(path,init)),bytes=new TextEncoder().encode(text);
    return new Response(bytes,{headers:{'Content-Type':'application/json','Content-Length':String(bytes.length)}});
  },path,{owner,init,owns,maxBytes,kind});return editor;
}
