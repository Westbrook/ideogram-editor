// Actual state owners sharing the caller's exact allocation/diagnostic singleton.
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {rolldown} from 'rolldown';
import {transformWithOxc} from 'vite';
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
async function moduleURL(path,imports={}){let code=(await transformWithOxc(await readFile(path,'utf8'),path)).code;for(const [name,url]of Object.entries(imports))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));return data(code);}
// Keep the real managed command-result validator available before server builds.
// Cache only its pure current-source module; caller-owned diagnostic graphs stay separate.
let validatorModule;
async function validatorSourceURL(){
 return validatorModule??=(async()=>{
  const bundle=await rolldown({input:resolve('src/protocol/validate.ts'),platform:'neutral',logLevel:'silent'});
  try{const {output}=await bundle.generate({format:'esm'});if(output.length!==1||output[0].type!=='chunk')throw Error('Expected one protocol validator module');return data(output[0].code);}finally{await bundle.close();}
 })();
}
export async function draftStateDependencies(allocationsURL,options={}){
 const root=options.root??process.env.IE_DRAFT_METADATA_SOURCE_ROOT??'.',commandsRoot=options.commandsRoot??process.env.CLIENT_CONTROL_ROOT??'.';
 const promptURL=options.promptURL??await moduleURL('src/observability/prompt-memory.ts',{'./allocations.js':allocationsURL});
 const memoryURL=options.memoryURL??await moduleURL('src/observability/model-memory.ts',{'./allocations.js':allocationsURL,'./prompt-memory.js':promptURL});
 const controlURL=options.controlURL??await moduleURL('src/state/control-memory.ts',{'../observability/allocations.js':allocationsURL});
 const imports={'../observability/allocations.js':allocationsURL,'../observability/prompt-memory.js':promptURL,'../observability/model-memory.js':memoryURL,'./control-memory.js':controlURL};
 const jsonURL=await moduleURL('src/protocol/json.ts'),shaURL=await moduleURL('src/protocol/sha256.ts'),validatorURL=await validatorSourceURL();
 const commandsURL=await moduleURL(commandsRoot+'/src/state/command-results.ts',{...imports,'../protocol/json.js':jsonURL,'../protocol/sha256.js':shaURL,'../protocol/validate.js':validatorURL});
 const valuesURL=await moduleURL(root+'/src/state/draft-values.ts',imports),draftURL=await moduleURL(root+'/src/state/draft-persistence.ts',{...imports,'./draft-values.js':valuesURL,'./command-results.js':commandsURL});
 return {draftURL,valuesURL,commandsURL,memoryURL,controlURL,promptURL,jsonURL,shaURL,validatorURL};
}
export const jsonResponse=value=>{const text=JSON.stringify(value);return new Response(text,{headers:{'content-type':'application/json','content-length':String(Buffer.byteLength(text))}});};
export async function discardOwned(result){const owner=await result;try{return undefined;}finally{owner?.release();}}
