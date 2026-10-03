import {readGateLog} from './gate-log-reader.mjs';
import {readFileSync,existsSync,mkdirSync,openSync,closeSync,unlinkSync,writeFileSync,copyFileSync,fstatSync,lstatSync} from 'node:fs';
import {resolve,join,dirname,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {platform,arch,release} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createGateLog} from './container/gate-log.mjs';
import {developmentPlan} from './development-plan.mjs';
import {executeGate} from './run.mjs';
import {sourceIdentityAsync,executionEnvironment,digestJSON,gateOutcome} from './core.mjs';
import {treeIdentityAsync,gateInputKey,outputIdentityAsync,reusableAsync,saveAtomic} from './development-cache.mjs';
import {versions} from './manifest.mjs';
import {boundedChild} from './container/bounded-child.mjs';
import {retainBrowserEvidence} from './container/browser-evidence.mjs';

import {acquireTimingLock,timingLockDirectory} from './campaigns/host.mjs';
import {prepareFunctionalOutput} from './functional-output.mjs';
import {startEvidenceMonitor,retainEvidenceAudit,verifyEvidenceAudit,readEvidenceJSON,fileIdentity} from './evidence-volume.mjs';

const root=resolve(fileURLToPath(new URL('../../',import.meta.url)));
export function argumentsFor(args){
  const options={command:args.shift()??'plan',groups:'base',browsers:'none',workers:1,fresh:false};
  if(!['plan','run'].includes(options.command))throw Error('Choose validation plan or run');
  while(args.length){const flag=args.shift();if(flag==='--batch-browser'){options.batchEditor=true;continue;}if(flag==='--serial-browser'){options.batchEditor=false;continue;}if(flag==='--fresh'){options.fresh=true;continue;}
    const field={'--groups':'groups','--node-files':'nodeFiles','--browsers':'browsers','--browser-groups':'browserGroups','--browser-grep':'browserGrep','--workers':'workers','--resume':'resume','--output':'output'}[flag];
    if(!field||!args.length||args[0].startsWith('--'))throw Error(`Unknown or incomplete option: ${flag}`);
    options[field]=args.shift();
  }
  options.workers=Number(options.workers);
  return options;
}
function combinedOutcome(...outcomes){
  return outcomes.includes('FAIL')?'FAIL':outcomes.some(value=>value!=='PASS')?'INCONCLUSIVE':'PASS';
}
async function verifiedLog(entry){
  try{
    if(!entry?.logPath)return false;
    const summary=await readGateLog(entry.logPath),o=entry.observation;
    return !summary.error&&!o.logError&&summary.bytes===o.log.bytes&&summary.sha256===o.log.sha256&&digestJSON(summary.counts)===digestJSON(o.counts)&&gateOutcome(o,o.id.startsWith('node:'))==='PASS';
  }catch{return false;}
}
function receiptLogPath(receiptPath,entry){
  const member=entry?.observation?.log?.path;
  if(typeof member!=='string'||isAbsolute(member)||member.includes('\\')||member.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('Unsafe originating gate log path');
  return join(dirname(receiptPath),member);
}
async function auditedReceipt(path,auditVerifier,expectedIdentity){
  const record=await readEvidenceJSON(path,{withIdentity:true}),value=record.value;
  if(expectedIdentity&&digestJSON(record.identity)!==digestJSON(expectedIdentity))throw Error('Originating receipt identity changed');
  if(value?.kind!=='development-validation-run-1'||!['PASS','FAIL'].includes(value.outcome)||!Array.isArray(value.gates)||
      !value.before||!value.after||!Array.isArray(value.before.files)||!Array.isArray(value.after.files)||
      digestJSON(value.before.files)!==value.before.digest||digestJSON(value.after.files)!==value.after.digest||
      value.before.digest!==value.after.digest||value.dependenciesUnchanged!==true||value.finalizationErrors?.length||
      value.evidenceStorage?.kind!=='evidence-volume-reference-1'||value.evidenceStorage.campaignId!==value.id)throw Error('Reuse needs a stable development receipt with bound evidence');
  const ids=value.gates.map(entry=>entry.observation?.id);
  if(ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length)throw Error('Originating receipt has ambiguous gates');
  const audit=await auditVerifier(value.evidenceStorage,path);
  if(audit?.status!=='PASS')throw Error('Originating receipt requires a verified retained evidence audit PASS');
  if(digestJSON(await fileIdentity(path))!==digestJSON(record.identity))throw Error('Originating receipt changed during audit verification');
  return {...record,audit,path};
}
async function boundEntry(entry,gate,key,auditVerifier){
  if(!entry?.origin?.receiptPath||!entry.origin.receiptIdentity)return null;
  try{
    const record=await auditedReceipt(entry.origin.receiptPath,auditVerifier,entry.origin.receiptIdentity);
    const matches=record.value.gates.filter(item=>item.observation.id===gate.id&&item.key===key);
    const {origin,...candidate}=entry;
    if(matches.length!==1||digestJSON(matches[0])!==digestJSON(candidate))return null;
    const logPath=receiptLogPath(record.path,matches[0]);
    if(candidate.logPath!==logPath||!await verifiedLog({...candidate,logPath}))return null;
    return {...candidate,origin};
  }catch{return null;}
}
export async function executeDevelopment({cwd=root,options,gateExecutor=executeGate,sourceProvider=sourceIdentityAsync,dependencyProvider=()=>treeIdentityAsync(join(cwd,'node_modules')),environment=process.env,hostLeaseProvider=async id=>acquireTimingLock(await timingLockDirectory(),{receiptId:id}),monitorFactory=startEvidenceMonitor,auditRetainer=retainEvidenceAudit,auditVerifier=verifyEvidenceAudit}={}){
  const id=new Date().toISOString().replaceAll(':','-')+'-'+randomUUID();
  const selectedOutput=resolve(options.output??join(cwd,'artifacts/validation',id));
  const plan=developmentPlan(cwd,{...options,output:join(selectedOutput,'browser')});
  const {directory,lock:lockPath}=prepareFunctionalOutput(cwd,id,selectedOutput);
  const lock=openSync(lockPath,'wx'),lockIdentity=fstatSync(lock);
  const controller=new AbortController(),interrupt=()=>controller.abort('SIGINT'),terminate=()=>controller.abort('SIGTERM');
  process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);
  const receiptPath=join(directory,'receipt.json');
  const receipt={kind:'development-validation-run-1',id,directory,plan,startedAt:new Date().toISOString(),gates:[],browsers:[],qualification:false};
  let sourceStarted=false,dependencyStarted=false,dependenciesBefore,hostLease,monitor,retainedReceiptPath=null,audit=null,verifiedAudit=null,auditRetained=false,finishSucceeded=false;
  const start=performance.now(),cachePath=join(cwd,'artifacts/validation/cache.json');let before,cache={entries:{}},pending=[];
  const lifecycleErrors=[],save=()=>saveAtomic(receiptPath,receipt);
  const lifecycleFailure=(stage,error)=>lifecycleErrors.push({stage,error:String(error)});
  try{
    writeFileSync(lock,JSON.stringify({pid:process.pid,id,directory,kind:'development-validation'}));
    hostLease=await hostLeaseProvider(id);receipt.hostExclusion={path:hostLease.path,identity:hostLease.identity};
    // Null prevents the helper's process.env default from overriding an explicit environment.
    // The monitor commits its initial observation before this callback. Keep
    // that first alarm even if a later sample improves; the audit cannot recover
    // an unknown window or a witnessed ceiling failure. Receive the monitor
    // before refusing so the ordinary finalizer still seals and retains it.
    let initialEvidenceAlarm;
    monitor=await monitorFactory({allocationPath:environment.IE_EVIDENCE_ALLOCATION??null,output:directory,campaignId:id,allowUnavailable:false,onAlarm:alarm=>{initialEvidenceAlarm??={...alarm};console.error(JSON.stringify({evidenceStorageAlarm:alarm}));}});
    receipt.evidenceStorage=monitor.reference;
    if(initialEvidenceAlarm?.status!=='PASS'||!['normal','target'].includes(initialEvidenceAlarm.level))throw Object.assign(Error(`Initial evidence storage ${initialEvidenceAlarm?.status??'UNAVAILABLE'}; validation was not started`),{outcome:initialEvidenceAlarm?.status==='FAIL'?'FAIL':'INCONCLUSIVE'});
    sourceStarted=true;before=await sourceProvider(cwd);receipt.before=before;
    const hashStart=performance.now();dependencyStarted=true;const dependencies=await dependencyProvider();
    dependenciesBefore=dependencies;
    if(!dependencies)throw Error('Missing dependency installation; verify vendor then npm ci with the pinned toolchain');
    const envIdentity={node:process.versions.node,platform:platform(),arch:arch(),release:release(),cwd,dependencies:dependencies.digest,execution:executionEnvironment(environment,join(cwd,'.toolchain/bin'),'<run-evidence>')};
    receipt.identityCostMs=performance.now()-hashStart;receipt.environment=envIdentity;
    const env=executionEnvironment(environment,join(cwd,'.toolchain/bin'),directory);
    if(!options.fresh)env.IE_VALIDATION_LEGACY_CACHE=join(cwd,'artifacts/validation/legacy');
    if(!options.fresh&&existsSync(cachePath)){
      try{cache=JSON.parse(readFileSync(cachePath));}catch{cache={entries:{}};}
      if(!cache||!cache.entries||typeof cache.entries!=='object'||Array.isArray(cache.entries))cache={entries:{}};
    }
    const resume=options.resume?await auditedReceipt(resolve(options.resume),auditVerifier):null;
    for(const gate of plan.gates){
      if(controller.signal.aborted)throw Error(`Interrupted: ${controller.signal.reason}`);
      const gateStart=performance.now(),key=gateInputKey(gate,before,envIdentity);
      const prior=resume?.value.gates.find(entry=>entry.key===key&&entry.observation.id===gate.id&&gate.files&&!gate.freshFixtureFiles?.length&&!gate.browserPrerequisites&&!gate.fixtureBuild&&!gate.completionPrerequisites&&!entry.observation.fixturePreparations&&!entry.observation.adapterFixture);
      const cached=cache.entries?.[gate.id];
      let entry=null;
      if(!options.fresh&&prior)entry=await boundEntry({...prior,origin:{receiptPath:resume.path,receiptIdentity:resume.identity}},gate,key,auditVerifier);
      if(!options.fresh&&!entry&&cached?.origin){
        try{if(await reusableAsync(cached,key,cwd,gate))entry=await boundEntry(cached,gate,key,auditVerifier);}catch{entry=null;}
      }
      let observation,mode='executed';
      if(entry){
        mode='reused';const logPath=join(directory,gate.id.replaceAll(':','-')+'.log');copyFileSync(entry.logPath,logPath);
        observation={...entry.observation,log:{...entry.observation.log,path:logPath.slice(directory.length+1)}};
        if(!await verifiedLog({observation,logPath})||!await boundEntry(entry,gate,key,auditVerifier))throw Error('Originating evidence changed during reuse');
        console.log(`${gate.id}: reused verified ${entry.logPath}`);
      }else{
        console.log(`Starting ${gate.id}`);observation=await gateExecutor(gate,directory,env,cwd,controller.signal);
        console.log(`${gate.id}: ${observation.outcome} (${Math.round(observation.elapsedMs)}ms)`);
      }
      const reuseReason=entry?'Verified matching inputs and retained evidence':options.fresh?'Fresh execution requested':!cached?'No prior prerequisite receipt':cached.key!==key?'Prerequisite inputs or environment changed':'Retained evidence or output did not verify';
      const current={key,mode,reuseReason,observation,logPath:join(directory,observation.log.path),elapsedMs:performance.now()-gateStart,...(entry?{reusedFrom:entry.logPath}:{})};
      if(observation.outcome==='PASS'&&!gate.files&&!gate.fixtureBuild)current.outputs=await outputIdentityAsync(cwd,gate);
      receipt.gates.push(current);save();
      if(observation.outcome!=='PASS')throw Object.assign(Error(`${gate.id} ${observation.outcome}; later gates were not started`),{outcome:observation.outcome});
      if(gate.id==='preflight'&&plan.requiredBrowsers.length){const playwright=await import('@playwright/test');for(const browser of plan.requiredBrowsers)if(!existsSync(playwright[browser].executablePath()))throw Error(`Install pinned ${browser} before browser validation`);}
      if(!gate.files&&!gate.fixtureBuild)pending.push([gate.id,current]);
    }
    if(plan.browserPlan){
      const {prepareCompletionIssuersChild}=await import('./completion-issuers/prepare-child.mjs');
      const needsIssuers=plan.browserPlan.steps.some(step=>step.config&&!['consumer','editor-display-image','text','projection','history','raster'].includes(step.family));
      let issuers={env:{}};
      if(needsIssuers){
        try{issuers=await prepareCompletionIssuersChild(join(directory,'browser-issuers'),cwd,{env,abortSignal:controller.signal,timeoutMs:300000});}
        catch(error){if(error.issuerPreparation)receipt.browserCompletionPreparation=error.issuerPreparation;throw error;}
        receipt.browserCompletionPreparation=issuers.preparation;save();
      }
      for(const step of plan.browserPlan.steps){
        const logPath=join(directory,step.id+'.log'),log=createGateLog(logPath,controller.signal),started=performance.now();let observed;
        try{observed=await boundedChild(step.executable,step.args,{cwd,env:{...env,...step.env,...issuers.env},timeoutMs:step.timeoutMs,abortSignal:log.signal,onStdout:b=>log.append(b),onStderr:b=>log.append(b)});}
        finally{log.close();}
        if(log.error)throw log.error;
        const outcome=step.browser?await retainBrowserEvidence(step,directory):null;
        receipt.browsers.push({id:step.id,...observed,...outcome,elapsedMs:performance.now()-started,log:logPath});save();
        if(observed.code!==0||observed.timedOut||observed.interrupted||outcome&&outcome.outcome!=='PASS')throw Error(`${step.id} failed; browser evidence retained`);
      }
    }
    receipt.outcome='PASS';
  }catch(error){receipt.outcome=['FAIL','INCONCLUSIVE'].includes(error.outcome)?error.outcome:'FAIL';receipt.error=String(error);}
  finally{
    try{
      // Each final identity check gets its own attempt, and none can skip monitor shutdown.
      receipt.finalizationErrors=[];
      try{if(sourceStarted)receipt.after=await sourceProvider(cwd);}catch(error){receipt.finalizationErrors.push({stage:'source-after',error:String(error)});}
      let dependenciesAfter;
      try{dependenciesAfter=dependencyStarted?await dependencyProvider():null;}catch(error){receipt.finalizationErrors.push({stage:'dependencies-after',error:String(error)});}
      receipt.dependenciesUnchanged=!!dependenciesBefore&&dependenciesBefore.digest===dependenciesAfter?.digest;
      receipt.sourceStable=!!before&&before.digest===receipt.after?.digest;
      if(!receipt.sourceStable||!receipt.dependenciesUnchanged||receipt.finalizationErrors.length)receipt.outcome=combinedOutcome(receipt.outcome,'INCONCLUSIVE');
      if(controller.signal.aborted){receipt.outcome='FAIL';receipt.interrupted=String(controller.signal.reason);}
      receipt.endedAt=new Date().toISOString();receipt.elapsedMs=performance.now()-start;
      receipt.pending=plan.gates.slice(receipt.gates.length).map(gate=>gate.id);
      receipt.pendingBrowsers=(plan.browserPlan?.steps??[]).slice(receipt.browsers.length).map(step=>step.id);
      try{save();retainedReceiptPath=receiptPath;}catch(error){lifecycleFailure('receipt-save',error);}
    }finally{
      // From here on the raw receipt is immutable: finish binds those exact bytes.
      try{
        if(monitor){
          try{audit=await monitor.finish({receiptPath:retainedReceiptPath,outcome:receipt.outcome??'INCONCLUSIVE'});finishSucceeded=true;}
          catch(error){lifecycleFailure('audit-finish',error);}
          finally{
            try{await auditRetainer(monitor.reference,directory);auditRetained=true;}
            catch(error){lifecycleFailure('audit-retain',error);}
          }
          if(auditRetained&&retainedReceiptPath){
            try{verifiedAudit=await auditVerifier(monitor.reference,retainedReceiptPath);}
            catch(error){lifecycleFailure('audit-verify',error);}
          }
        }
        // Audit PASS is necessary even for a source-stable failed run's passing prefix.
        if(['PASS','FAIL'].includes(receipt.outcome)&&finishSucceeded&&audit?.status==='PASS'&&auditRetained&&verifiedAudit?.status==='PASS'&&!lifecycleErrors.length&&receipt.sourceStable&&receipt.dependenciesUnchanged&&!receipt.finalizationErrors?.length){
          try{
            const sealed=await auditedReceipt(receiptPath,auditVerifier);
            const origin={receiptPath,receiptIdentity:sealed.identity};
            for(const [gateId,entry]of pending)cache.entries[gateId]={...entry,origin};
            saveAtomic(cachePath,cache);
          }catch(error){lifecycleFailure('cache-publish',error);}
        }
      }finally{
        try{await hostLease?.release();}catch(error){lifecycleFailure('host-release',error);}
        finally{
          process.off('SIGINT',interrupt);process.off('SIGTERM',terminate);
          try{closeSync(lock);}catch(error){lifecycleFailure('checkout-close',error);}
          try{const current=lstatSync(lockPath,{throwIfNoEntry:false});if(current?.ino===lockIdentity.ino&&current.dev===lockIdentity.dev)unlinkSync(lockPath);else if(current)throw Error('Checkout lock identity changed');}catch(error){lifecycleFailure('checkout-release',error);}
        }
      }
    }
  }
  const effectiveOutcome=combinedOutcome(receipt.outcome,audit?.status,verifiedAudit?.status,finishSucceeded&&auditRetained?'PASS':'INCONCLUSIVE',lifecycleErrors.length?'FAIL':'PASS');
  console.log(`${effectiveOutcome}: ${receiptPath} (raw ${receipt.outcome})`);
  return {...receipt,rawOutcome:receipt.outcome,outcome:effectiveOutcome,effectiveOutcome,receiptPath,evidenceAudit:{finished:audit,retained:auditRetained,verified:verifiedAudit},lifecycleErrors};
}
export async function main(args){
  const options=argumentsFor([...args]);
  if(options.command==='plan'){console.log(JSON.stringify(developmentPlan(root,{...options,output:options.output??join(root,'artifacts/validation-plan-only')}),null,2));return;}
  if(process.versions.node!==versions.node)throw Error(`Use Node ${versions.node}`);
  if(execFileSync('npm',['--version'],{encoding:'utf8'}).trim()!==versions.npm)throw Error(`Use npm ${versions.npm}`);
  const result=await executeDevelopment({options});if(result.effectiveOutcome!=='PASS')process.exitCode=result.effectiveOutcome==='FAIL'?1:2;
}
if(import.meta.main)main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
