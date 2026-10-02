import {lstat,writeFile} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {performance} from 'node:perf_hooks';
import {boundedChild} from '../container/bounded-child.mjs';
import {createGateLog} from '../container/gate-log.mjs';
import {executionEnvironment} from '../core.mjs';
import {readEvidenceJSON,fileIdentity} from '../evidence-volume.mjs';

const names=['application-identity.json','host-final-issuers.json'];
export const completionIssuerArguments=output=>['--import','./tests/session/no-egress.mjs','tooling/qualification/completion-issuers/index.mjs','--output',resolve(output)];
const same=(a,b)=>a.bytes===b.bytes&&a.sha256===b.sha256;

// The unchanged producer has already audited its full source/build/AST closure.
// This parent reads only the bounded receipt and verifies exact returned files;
// it never repeats the synchronous application/issuer audit on the monitor lane.
export async function readPreparedCompletionIssuers(output){
 const destination=resolve(output),directory=await lstat(destination);
 if(!directory.isDirectory()||directory.isSymbolicLink())throw Error('Regular issuer output directory required');
 const receiptPath=join(destination,'receipt.json'),{value:receipt,identity}=await readEvidenceJSON(receiptPath,{withIdentity:true});
 if(receipt.schema!==1||receipt.kind!=='COMPLETION-ISSUER-ADOPTION-1'||receipt.status!=='prepared'||
    !Array.isArray(receipt.candidateFiles)||receipt.candidateFiles.length!==2||
    receipt.candidateFiles.some((pin,index)=>pin.path!==names[index]||!Number.isSafeInteger(pin.bytes)||pin.bytes<1||pin.bytes>16*1024*1024||!/^[a-f0-9]{64}$/.test(pin.sha256)))throw Error('Invalid non-adopting issuer receipt');
 for(const pin of receipt.candidateFiles)if(!same(await fileIdentity(join(destination,pin.path)),pin))throw Error('Prepared issuer file differs from its receipt: '+pin.path);
 if(!same(await fileIdentity(receiptPath),identity))throw Error('Issuer receipt changed during verification');
 return {output:destination,adopted:false,receipt:receiptPath,env:{COMPLETION_APPLICATION_IDENTITY:join(destination,names[0]),COMPLETION_ISSUER_MANIFEST:join(destination,names[1])}};
}

/** Isolate the CPU/synchronous filesystem producer from the periodic observer.
 * Existing boundedChild owns interruption/deadline cleanup; no retry or adoption. */
export async function prepareCompletionIssuersChild(output,root,{env={},abortSignal,timeoutMs=300000}={}, {runChild=boundedChild}={}){
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1)throw Error('Positive issuer preparation deadline required');
 const cwd=resolve(root),destination=resolve(output),started=performance.now(),budget=Math.min(timeoutMs,300000);
 for(const path of [destination,destination+'.child.json'])try{await lstat(path);throw Error('Fresh issuer receipt directory required');}catch(error){if(error.code!=='ENOENT')throw error;}
 const limit=new AbortController(),signal=abortSignal?AbortSignal.any([abortSignal,limit.signal]):limit.signal;
 const logPath=destination+'.log',resultPath=destination+'.child.json',log=createGateLog(logPath,signal),args=completionIssuerArguments(destination);
 const observation={kind:'completion-issuer-child-1',startedAt:new Date().toISOString(),command:[process.execPath,...args],cwd,output:destination,log:logPath,status:'failed',child:null};
 let bytes=0,result,failure,preparation;
 const append=chunk=>{bytes+=Buffer.byteLength(chunk);if(bytes>1048576){limit.abort('Completion issuer log exceeded1MiB');return;}log.append(chunk);};
 try{
  const remaining=Math.floor(budget-(performance.now()-started));
  if(remaining<1)throw Object.assign(Error('Completion issuer preparation exceeded its deadline'),{timedOut:true});
  observation.child=await runChild(process.execPath,args,{cwd,env:executionEnvironment(env,join(cwd,'.toolchain/bin'),dirname(destination)),timeoutMs:remaining,abortSignal:log.signal,onStdout:append,onStderr:append});
  const child=observation.child;
  if(child.code!==0||child.signal||child.timedOut||child.interrupted||child.error||log.signal.aborted)throw Object.assign(Error('Completion issuer child did not complete successfully'),child,{interrupted:child.interrupted||log.signal.aborted});
  if(log.error)throw log.error;
  result=await readPreparedCompletionIssuers(destination);
  if(log.signal.aborted)throw Object.assign(Error('Completion issuer preparation interrupted'),{interrupted:true});
  if(performance.now()-started>budget)throw Object.assign(Error('Completion issuer preparation exceeded its deadline'),{timedOut:true});
  observation.status='complete';
 }catch(error){failure=error;observation.error=String(error.message??error);throw error;}
 finally{
  log.close();if(log.error){observation.status='failed';observation.error=String(log.error);}
  observation.endedAt=new Date().toISOString();observation.elapsedMs=performance.now()-started;observation.logIdentity=await fileIdentity(logPath);
  await writeFile(resultPath,JSON.stringify(observation,null,2)+'\n',{flag:'wx',mode:0o600});
  preparation={path:resultPath,...await fileIdentity(resultPath)};
  if(failure)failure.issuerPreparation=preparation;
  if(log.error)throw Object.assign(log.error,{issuerPreparation:preparation});
 }
 return {...result,childObservation:resultPath,preparation};
}
