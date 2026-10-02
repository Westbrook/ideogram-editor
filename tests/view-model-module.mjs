// Real ownership dependencies with the caller's allocation singleton.
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
async function moduleURL(path,imports={}){let code=(await transformWithOxc(await readFile(path,'utf8'),path)).code;for(const [name,url]of Object.entries(imports))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));return data(code);}
export async function viewModelDependencies(allocationsURL,options={}){
 const root=options.root??process.env.CLIENT_ALLOCATION_ROOT??'.';
 const promptURL=options.promptURL??await moduleURL('src/observability/prompt-memory.ts',{'./allocations.js':allocationsURL});
 const memoryURL=options.memoryURL??await moduleURL('src/observability/model-memory.ts',{'./allocations.js':allocationsURL,'./prompt-memory.js':promptURL});
 const controlURL=options.controlURL??await moduleURL('src/state/control-memory.ts',{'../observability/allocations.js':allocationsURL});
 const jsonURL=await moduleURL('src/protocol/json.ts'),shaURL=await moduleURL('src/protocol/sha256.ts');
 const viewURL=await moduleURL(root+'/src/state/view-models.ts',{'../observability/allocations.js':allocationsURL,'../observability/model-memory.js':memoryURL,'../observability/prompt-memory.js':promptURL,'./control-memory.js':controlURL,'../protocol/json.js':jsonURL,'../protocol/sha256.js':shaURL});
 return {viewURL,memoryURL,controlURL};
}
