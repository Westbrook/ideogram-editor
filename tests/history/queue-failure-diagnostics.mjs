import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {envelope,terminal,eventFor} from '../raster/helpers.mjs';

// Same public command and accepted-receipt assertion as operate. A capacity
// rejection is observed once; it never gains an automatic retry or a new grant.
export async function queueWithDiagnostics(f,body,context,{retain=true,report,failureOnly=false}={}){
 const before=failureOnly?null:process.memoryUsage(),request=envelope(f,body),response=await terminal(f,request);
 try{assert.equal(response.json.receipt.status,'accepted',response.text);}catch(error){
  if(response.json.receipt.code==='CAPACITY'&&response.json.rejectionDetails?.kind==='inline'&&response.json.rejectionDetails.value?.issues?.some(issue=>issue.code==='QUEUE_METADATA_ADMISSION'))try{
   const commandId=request.command.commandId,trigger=join(f.root,'j19-diagnostic-request.json'),result=join(f.root,'j19-diagnostic-'+commandId+'.json');
   let snapshot;
   // Failure-only callers retain an explicit unavailable observation, never a
   // stale command's snapshot. The legacy caller keeps its original behavior.
   if(failureOnly&&response.json.receipt.commandId!==commandId)snapshot={kind:'j19-diagnostic-unavailable-1',commandId,reason:'receipt-command-mismatch'};
   else try{
    await writeFile(trigger,JSON.stringify({commandId}),{mode:0o600});
    for(let n=0;n<20;n++){
     try{const bytes=await readFile(result);assert(bytes.length<=262144);snapshot=JSON.parse(bytes);break;}catch(readError){if(readError.code!=='ENOENT')throw readError;}
     await new Promise(resolve=>setTimeout(resolve,25));
    }
    if(failureOnly&&snapshot!==undefined&&(!snapshot||!['j19-owned-diagnostics-1','j19-diagnostic-unavailable-1'].includes(snapshot.kind)||snapshot.commandId!==commandId))snapshot={kind:'j19-diagnostic-unavailable-1',commandId,reason:'capture-identity-mismatch'};
   }catch(captureError){
    if(!failureOnly)throw captureError;
    snapshot={kind:'j19-diagnostic-unavailable-1',commandId,reason:'capture-'+String(captureError.code??captureError.name).slice(0,80)};
   }
   snapshot??={kind:'j19-diagnostic-unavailable-1',reason:'capture-deadline'};
   const packet={kind:'candidate-copy-queue-capacity-diagnostic-1',commandId,operation:body.type,context,assertionProcess:{pid:process.pid,before,after:process.memoryUsage()},receipt:response.json.receipt,rejectionDetails:response.json.rejectionDetails,snapshot};
   const bytes=Buffer.from(JSON.stringify(packet));assert(bytes.length<=270336);
   if(report)await report(packet);
   if(retain){const output=resolve(process.env.IE_CHAIN_DIAGNOSTIC_OUTPUT??'artifacts/agent-integration/chain-diagnostics');await mkdir(output,{recursive:true});const destination=join(output,commandId+'.json');await writeFile(destination,bytes,{mode:0o600,flag:'wx'});error.message+='\nChained adoption diagnostic: '+destination;}
  }catch(captureError){if(retain)error.message+='\nChained adoption diagnostic unavailable: '+String(captureError.code??captureError.name).slice(0,80);}
  throw error;
 }
 return {command:request,receipt:response.json.receipt,event:await eventFor(f,response.json.receipt)};
}

// Same state assertion as the fixture, with observation only after it fails.
// No new request, candidate retry, deadline extension or state reinterpretation.
export async function assertCandidatePrepared(f,view,context,{retain=true,report,nativeRequestMemory=false}={}){
 try{assert.equal(view.items[0]?.state,'prepared',JSON.stringify(view));}catch(error){
  try{
   const commandId=randomUUID(),candidate=view.items[0]??null;
   let requestMemoryUnavailable;
   if(nativeRequestMemory)try{const bytes=JSON.stringify({documentId:candidate?.documentId??null,queueCommandId:context?.queueCommandId??null,jobId:candidate?.jobId??null});assert(Buffer.byteLength(bytes)<=1024);await writeFile(join(f.root,'native-request-memory-context-'+commandId+'.json'),bytes,{mode:0o600});}catch{requestMemoryUnavailable='context-publication-failed';}
   await writeFile(join(f.root,'j19-diagnostic-request.json'),JSON.stringify({commandId}),{mode:0o600});
   let snapshot,mainRequestMemory;
   for(let n=0;n<20;n++){
    if(!snapshot)try{const bytes=await readFile(join(f.root,'j19-diagnostic-'+commandId+'.json'));assert(bytes.length<=262144);snapshot=JSON.parse(bytes);}
    catch(readError){if(readError.code!=='ENOENT')throw readError;}
    if(nativeRequestMemory&&!mainRequestMemory&&!requestMemoryUnavailable)try{const bytes=await readFile(join(f.root,'native-request-memory-main-'+commandId+'.json'));assert(bytes.length<=6144);mainRequestMemory=JSON.parse(bytes);}
    catch(readError){if(readError.code!=='ENOENT')requestMemoryUnavailable='main-capture-invalid';}
    if(snapshot&&(!nativeRequestMemory||mainRequestMemory||requestMemoryUnavailable))break;
    await new Promise(resolve=>setTimeout(resolve,25));
   }
   snapshot??={kind:'j19-diagnostic-unavailable-1',reason:'capture-deadline'};
   let rasterFailure=null,rasterFailureObservation='unavailable';
   try{
    const bytes=await readFile(join(f.root,'candidate-copy-raster-failure.json'));assert(bytes.length<=270336);
    const value=JSON.parse(bytes);
    // A retained failure from another candidate, encoded asset or document
    // cannot explain this assertion. Never report that record as its cause.
    if(candidate&&typeof candidate.id==='string'&&typeof candidate.encodedAssetId==='string'&&typeof candidate.documentId==='string'&&value.kind==='candidate-copy-raster-failure-1'&&value.slot==='candidate-prepare:'+candidate.id&&value.inputAssetId===candidate.encodedAssetId&&value.documentId===candidate.documentId&&typeof value.outputAssetId==='string'&&value.outputAssetId.length>0&&value.commandId===value.outputAssetId){rasterFailure=value;rasterFailureObservation='matched';}
    else rasterFailureObservation='identity-mismatch';
   }catch(readError){if(readError.code!=='ENOENT')throw readError;}
   const packet={kind:'candidate-copy-preparation-diagnostic-1',diagnosticId:commandId,context,candidate:candidate?{id:candidate.id,documentId:candidate.documentId,jobId:candidate.jobId,attemptId:candidate.attemptId,state:candidate.state,encodedAssetId:candidate.encodedAssetId,preparedAssetId:candidate.preparedAssetId,warning:candidate.warning}:null,assertionProcess:{pid:process.pid,after:process.memoryUsage()},snapshot,rasterFailureObservation,rasterFailure};
   if(nativeRequestMemory)packet.requestMemory=requestMemoryUnavailable?{kind:'native-request-memory-join-1',status:'unavailable',reason:requestMemoryUnavailable,main:null}:joinNativeRequestMemory({main:mainRequestMemory,writer:rasterFailure?.requestMemory,diagnosticId:commandId,outputAssetId:rasterFailure?.outputAssetId,candidate,context});
   const bytes=Buffer.from(JSON.stringify(packet));assert(bytes.length<=544768);
   if(report)await report(packet);
   if(retain){const output=resolve(process.env.IE_CHAIN_DIAGNOSTIC_OUTPUT??'artifacts/agent-integration/chain-diagnostics');await mkdir(output,{recursive:true});const destination=join(output,commandId+'.json');await writeFile(destination,bytes,{mode:0o600,flag:'wx'});error.message+='\nChained candidate preparation diagnostic: '+destination;}
  }catch(captureError){error.message+='\nChained candidate preparation diagnostic unavailable: '+String(captureError.code??captureError.name).slice(0,80);}
  throw error;
 }
}

// Both records are diagnostic observations, never admission or completion proof.
// Bind the existing public candidate/queue identity and actual review cohort;
// a stale record from an earlier candidate cannot explain this failure.
export function joinNativeRequestMemory({main,writer,diagnosticId,outputAssetId,candidate,context}){
 const unavailable=reason=>({kind:'native-request-memory-join-1',status:'unavailable',reason,main:null});
 const bounded=value=>value&&Buffer.byteLength(JSON.stringify(value))<=6144;
 const valid=(value,role,uuid)=>{
  if(!bounded(value)||value.kind!=='native-request-memory-transitions-1'||value.role!==role||value.diagnosticId!==uuid||!value.binding||value.binding.documentId!==candidate.documentId||value.binding.queueCommandId!==context.queueCommandId)return false;
  const p=value.processIdentity;if(!p||!Number.isSafeInteger(p.pid)||p.pid<1||!Number.isSafeInteger(p.threadId)||p.threadId<0||!Number.isFinite(p.clockOriginUnixMs))return false;
  if(value.rssScope!=='whole-process'||value.heapScope!=='record-threadId'||value.lifetimeMaxRSSScope!=='process-lifetime-high-water'||value.nativeAllocationOwner!=='unobserved')return false;
  const names=['sequence','descriptorId','phase','outcome','pid','threadId','workerThreadId','workerInstance','rpcId','clockOriginUnixMs','atMs','rss','heapTotal','heapUsed','external','arrayBuffers','lifetimeMaxRSSBytes','documentResolvedAtSample'];
  if(JSON.stringify(value.fields)!==JSON.stringify(names)||!Array.isArray(value.records)||value.records.length>12||!Array.isArray(value.descriptors)||value.descriptors.length!==3)return false;
  for(const row of value.records)if(!Array.isArray(row)||row.length!==names.length||row.some(n=>typeof n!=='number'||!Number.isFinite(n))||row[4]!==p.pid||row[5]!==p.threadId||row[9]!==p.clockOriginUnixMs)return false;
  for(const name of ['documentId','queueCommandId','reviewId','prepareRequestId','acceptRequestId','acceptanceId'])if(typeof value.binding[name]!=='string'||!value.binding[name].length||value.binding[name].length>128)return false;
  if(value.binding.acceptRequestId!==value.binding.acceptanceId)return false;
  const expected=[['PrepareRequestReview','requestId','prepareRequestId'],['AcceptRequestReview','requestId','acceptRequestId'],['QueueInference','commandId','queueCommandId']];
  for(const [operation,key,bindingKey]of expected){const matches=value.descriptors.filter(d=>d.operation===operation);if(matches.length!==1)return false;const d=matches[0];if(d[key]!==value.binding[bindingKey]||d.documentId!==value.binding.documentId||d.reviewId!==value.binding.reviewId||!Number.isSafeInteger(d.id)||!value.records.some(row=>row[1]===d.id))return false;}
  const queue=value.descriptors.find(d=>d.operation==='QueueInference');if(queue.acceptanceId!==value.binding.acceptanceId)return false;
  const ids=new Set(value.descriptors.map(d=>d.id));if(ids.size!==3||value.records.some(row=>!ids.has(row[1])))return false;
  const seen=new Set();let sequence=0;
  for(const row of value.records){const d=value.descriptors.find(d=>d.id===row[1]),key=row[1]+':'+row[2];if(seen.has(key)||!Number.isSafeInteger(row[0])||row[0]<=sequence||![1,2].includes(row[2])||![0,1,2,3,4].includes(row[3])||row[2]===1&&row[3]!==0||row[2]===2&&row[3]===0||row[6]!==d.workerThreadId||row[7]!==d.workerInstance||row[8]!==d.rpcId||![0,1].includes(row[17]))return false;seen.add(key);sequence=row[0];}
  if(value.incomplete===false&&value.descriptors.some(d=>!seen.has(d.id+':1')||!seen.has(d.id+':2')))return false;
  return true;
 };
 try{
  if(!candidate||typeof candidate.documentId!=='string'||typeof candidate.jobId!=='string'||context?.jobId!==candidate.jobId||typeof context.queueCommandId!=='string')return unavailable('candidate-context-mismatch');
  if(!main||!writer)return unavailable('capture-unavailable');
  if(!valid(main,'http-main',diagnosticId)||!valid(writer,'writer',outputAssetId))return unavailable('record-binding-or-shape-mismatch');
  if(main.processIdentity.pid!==writer.processIdentity.pid||main.processIdentity.threadId!==0||writer.processIdentity.threadId<1)return unavailable('process-or-isolate-mismatch');
  if(main.descriptors.some(d=>d.workerThreadId!==writer.processIdentity.threadId)||writer.descriptors.some(d=>d.workerThreadId!==writer.processIdentity.threadId))return unavailable('observed-worker-mismatch');
  for(const name of ['documentId','queueCommandId','reviewId','prepareRequestId','acceptRequestId','acceptanceId'])if(main.binding[name]!==writer.binding[name])return unavailable('review-cohort-mismatch');
  if(main.context?.jobId!==candidate.jobId||main.context?.queueCommandId!==context.queueCommandId||main.context?.documentId!==candidate.documentId||writer.context?.documentId!==candidate.documentId)return unavailable('failure-context-mismatch');
  return {kind:'native-request-memory-join-1',status:'matched',main,writerLocation:'rasterFailure.requestMemory',incomplete:main.incomplete!==false||writer.incomplete!==false,qualification:false};
 }catch{return unavailable('observation-fault');}
}
