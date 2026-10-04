import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {terminal} from '../raster/helpers.mjs';

// Diagnostic-only: preserve the caller's original assertion and terminal wait.
// A failed pending operation is never reposted or granted more capacity here.
export async function terminalWithDiagnostics(f,request,baseline,run=()=>terminal(f,request),report){
 try{return await run();}catch(error){
  let status;try{status=await f.read('/api/v1/commands/'+request.command.commandId);}catch{}
  if(status?.status===202&&status.json?.phase==='waiting-for-resources')try{
   const commandId=request.command.commandId,trigger=join(f.root,'j19-diagnostic-request.json'),result=join(f.root,'j19-diagnostic-'+commandId+'.json');
   let snapshot;
   try{
    await writeFile(trigger,JSON.stringify({commandId}),{mode:0o600});
    for(let n=0;n<20;n++){try{const bytes=await readFile(result);assert(bytes.length<=262144);snapshot=JSON.parse(bytes);break;}catch(readError){if(readError.code!=='ENOENT')throw readError;}await new Promise(resolve=>setTimeout(resolve,25));}
    if(!snapshot)snapshot={kind:'j19-diagnostic-unavailable-1',reason:'capture-deadline'};
   }catch(captureError){snapshot={kind:'j19-diagnostic-unavailable-1',reason:String(captureError.code??captureError.name).slice(0,80)};}
   const packet={kind:'j19-waiting-diagnostic-1',commandId,operation:request.command.body.type,pending:status.json,baseline,snapshot};
   const bytes=Buffer.from(JSON.stringify(packet));assert(bytes.length<=270336);
   // Retain the exact bounded serialization; reporting cannot replace failure.
   if(typeof report==='function'){try{report(bytes.toString('utf8'));}catch{}}
   else{
   const output=resolve(process.env.IE_J19_DIAGNOSTIC_OUTPUT??'artifacts/agent-integration/j19-diagnostics');await mkdir(output,{recursive:true});const destination=join(output,commandId+'.json');await writeFile(destination,bytes,{mode:0o600,flag:'wx'});error.message+='\nJ19 diagnostic: '+destination;
   }
  }catch(captureError){if(typeof report!=='function')error.message+='\nJ19 diagnostic capture unavailable: '+String(captureError.code??captureError.name).slice(0,80);}
  throw error;
 }
}
