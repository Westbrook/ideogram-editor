import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {envelope,terminal,eventFor} from '../raster/helpers.mjs';

// Same public command and accepted-receipt assertion as operate. A capacity
// rejection is observed once; it never gains an automatic retry or a new grant.
export async function queueWithDiagnostics(f,body,context){
 const before=process.memoryUsage(),request=envelope(f,body),response=await terminal(f,request);
 try{assert.equal(response.json.receipt.status,'accepted',response.text);}catch(error){
  if(response.json.receipt.code==='CAPACITY'&&response.json.rejectionDetails?.kind==='inline'&&response.json.rejectionDetails.value?.issues?.some(issue=>issue.code==='QUEUE_METADATA_ADMISSION'))try{
   const commandId=request.command.commandId,trigger=join(f.root,'j19-diagnostic-request.json'),result=join(f.root,'j19-diagnostic-'+commandId+'.json');
   let snapshot;
   await writeFile(trigger,JSON.stringify({commandId}),{mode:0o600});
   for(let n=0;n<20;n++){
    try{const bytes=await readFile(result);assert(bytes.length<=262144);snapshot=JSON.parse(bytes);break;}catch(readError){if(readError.code!=='ENOENT')throw readError;}
    await new Promise(resolve=>setTimeout(resolve,25));
   }
   snapshot??={kind:'j19-diagnostic-unavailable-1',reason:'capture-deadline'};
   const packet={kind:'candidate-copy-queue-capacity-diagnostic-1',commandId,operation:body.type,context,assertionProcess:{pid:process.pid,before,after:process.memoryUsage()},receipt:response.json.receipt,rejectionDetails:response.json.rejectionDetails,snapshot};
   const bytes=Buffer.from(JSON.stringify(packet));assert(bytes.length<=270336);
   const output=resolve(process.env.IE_CHAIN_DIAGNOSTIC_OUTPUT??'artifacts/agent-integration/chain-diagnostics');await mkdir(output,{recursive:true});const destination=join(output,commandId+'.json');await writeFile(destination,bytes,{mode:0o600,flag:'wx'});error.message+='\nChained adoption diagnostic: '+destination;
  }catch(captureError){error.message+='\nChained adoption diagnostic unavailable: '+String(captureError.code??captureError.name).slice(0,80);}
  throw error;
 }
 return {command:request,receipt:response.json.receipt,event:await eventFor(f,response.json.receipt)};
}

// Same state assertion as the fixture, with observation only after it fails.
// No new request, candidate retry, deadline extension or state reinterpretation.
export async function assertCandidatePrepared(f,view,context){
 try{assert.equal(view.items[0]?.state,'prepared',JSON.stringify(view));}catch(error){
  try{
   const commandId=randomUUID(),candidate=view.items[0]??null;
   await writeFile(join(f.root,'j19-diagnostic-request.json'),JSON.stringify({commandId}),{mode:0o600});
   let snapshot;
   for(let n=0;n<20;n++){
    try{const bytes=await readFile(join(f.root,'j19-diagnostic-'+commandId+'.json'));assert(bytes.length<=262144);snapshot=JSON.parse(bytes);break;}
    catch(readError){if(readError.code!=='ENOENT')throw readError;}
    await new Promise(resolve=>setTimeout(resolve,25));
   }
   snapshot??={kind:'j19-diagnostic-unavailable-1',reason:'capture-deadline'};
   let rasterFailure=null;
   try{
    const bytes=await readFile(join(f.root,'candidate-copy-raster-failure.json'));assert(bytes.length<=270336);
    const value=JSON.parse(bytes);
    if(candidate&&value.slot==='candidate-prepare:'+candidate.id)rasterFailure=value;
   }catch(readError){if(readError.code!=='ENOENT')throw readError;}
   const packet={kind:'candidate-copy-preparation-diagnostic-1',diagnosticId:commandId,context,candidate:candidate?{id:candidate.id,jobId:candidate.jobId,attemptId:candidate.attemptId,state:candidate.state,encodedAssetId:candidate.encodedAssetId,preparedAssetId:candidate.preparedAssetId,warning:candidate.warning}:null,assertionProcess:{pid:process.pid,after:process.memoryUsage()},snapshot,rasterFailure};
   const bytes=Buffer.from(JSON.stringify(packet));assert(bytes.length<=544768);
   const output=resolve(process.env.IE_CHAIN_DIAGNOSTIC_OUTPUT??'artifacts/agent-integration/chain-diagnostics');await mkdir(output,{recursive:true});const destination=join(output,commandId+'.json');await writeFile(destination,bytes,{mode:0o600,flag:'wx'});error.message+='\nChained candidate preparation diagnostic: '+destination;
  }catch(captureError){error.message+='\nChained candidate preparation diagnostic unavailable: '+String(captureError.code??captureError.name).slice(0,80);}
  throw error;
 }
}
