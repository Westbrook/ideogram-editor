import {readFileSync,existsSync,mkdirSync,openSync,closeSync,unlinkSync,writeFileSync,copyFileSync,fstatSync,lstatSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {platform,arch,release} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createGateLog} from './container/gate-log.mjs';
import {developmentPlan} from './development-plan.mjs';
import {executeGate} from './run.mjs';
import {sourceIdentity,executionEnvironment,sha256,digestJSON,gateOutcome,tapCounts} from './core.mjs';
import {treeIdentity,gateInputKey,outputIdentity,reusable,saveAtomic} from './development-cache.mjs';
import {versions} from './manifest.mjs';
import {boundedChild} from './container/bounded-child.mjs';
import {retainBrowserEvidence} from './container/browser-evidence.mjs';

import {acquireTimingLock,timingLockDirectory} from './campaigns/host.mjs';

const root=resolve(fileURLToPath(new URL('../../',import.meta.url)));
export function argumentsFor(args){
  const options={command:args.shift()??'plan',groups:'base',browsers:'none',workers:1,fresh:false};
  if(!['plan','run'].includes(options.command))throw Error('Choose validation plan or run');
  while(args.length){const flag=args.shift();if(flag==='--batch-browser'){options.batchEditor=true;continue;}if(flag==='--serial-browser'){options.batchEditor=false;continue;}if(flag==='--fresh'){options.fresh=true;continue;}
    const field={'--groups':'groups','--node-files':'nodeFiles','--browsers':'browsers','--browser-groups':'browserGroups','--browser-grep':'browserGrep','--workers':'workers','--resume':'resume'}[flag];
    if(!field||!args.length||args[0].startsWith('--'))throw Error(`Unknown or incomplete option: ${flag}`);
    options[field]=args.shift();
  }
  options.workers=Number(options.workers);
  return options;
}
function verifiedLog(entry){
  if(!entry?.logPath||!existsSync(entry.logPath))return false;
  const bytes=readFileSync(entry.logPath),o=entry.observation;
  return bytes.length===o.log.bytes&&sha256(bytes)===o.log.sha256&&digestJSON(tapCounts(bytes.toString()))===digestJSON(o.counts)&&gateOutcome(o,o.id.startsWith('node:'))==='PASS';
}
export async function executeDevelopment({cwd=root,options,gateExecutor=executeGate,sourceProvider=sourceIdentity,dependencyProvider=()=>treeIdentity(join(cwd,'node_modules')),environment=process.env,hostLeaseProvider=async id=>acquireTimingLock(await timingLockDirectory(),{receiptId:id})}={}){
  const id=new Date().toISOString().replaceAll(':','-')+'-'+randomUUID();
  const directory=join(cwd,'artifacts/validation',id),plan=developmentPlan(cwd,{...options,output:join(directory,'browser')});
  const lockPath=join(cwd,'artifacts/qualification/active.lock');mkdirSync(dirname(lockPath),{recursive:true});
  const lock=openSync(lockPath,'wx'),lockIdentity=fstatSync(lock);
  const controller=new AbortController(),interrupt=()=>controller.abort('SIGINT'),terminate=()=>controller.abort('SIGTERM');
  process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);
  const receipt={kind:'development-validation-run-1',id,directory,plan,startedAt:new Date().toISOString(),gates:[],browsers:[],qualification:false};
  let dependenciesBefore,hostLease;
  const start=performance.now(),cachePath=join(cwd,'artifacts/validation/cache.json');let before,cache={entries:{}},pending=[];
  const save=()=>saveAtomic(join(directory,'receipt.json'),receipt);
  try{
    writeFileSync(lock,JSON.stringify({pid:process.pid,id,directory,kind:'development-validation'}));
    mkdirSync(directory,{recursive:true});
    hostLease=await hostLeaseProvider(id);receipt.hostExclusion={path:hostLease.path,identity:hostLease.identity};
    before=sourceProvider(cwd);receipt.before=before;
    const hashStart=performance.now(),dependencies=await dependencyProvider();
    dependenciesBefore=dependencies;
    if(!dependencies)throw Error('Missing dependency installation; verify vendor then npm ci with the pinned toolchain');
    const envIdentity={node:process.versions.node,platform:platform(),arch:arch(),release:release(),cwd,dependencies:dependencies.digest,execution:executionEnvironment(environment,join(cwd,'.toolchain/bin'),'<run-evidence>')};
    receipt.identityCostMs=performance.now()-hashStart;receipt.environment=envIdentity;
    const env=executionEnvironment(environment,join(cwd,'.toolchain/bin'),directory);
    if(!options.fresh)env.IE_VALIDATION_LEGACY_CACHE=join(cwd,'artifacts/validation/legacy');
    if(!options.fresh&&existsSync(cachePath))cache=JSON.parse(readFileSync(cachePath));
    const resume=options.resume?JSON.parse(readFileSync(resolve(options.resume))):null;
    if(resume&&(resume.kind!==receipt.kind||resume.before.digest!==resume.after?.digest))throw Error('Resume needs a source-stable development receipt; qualification samples cannot be reused');
    for(const gate of plan.gates){
      if(controller.signal.aborted)throw Error(`Interrupted: ${controller.signal.reason}`);
      const gateStart=performance.now(),key=gateInputKey(gate,before,envIdentity);
      const prior=resume?.gates.find(entry=>entry.key===key&&entry.observation.id===gate.id&&gate.files&&!gate.browserPrerequisites&&!gate.fixtureBuild&&!gate.completionPrerequisites&&!entry.observation.fixturePreparations&&!entry.observation.adapterFixture);
      const cached=cache.entries?.[gate.id];
      const entry=!options.fresh&&prior&&verifiedLog(prior)?prior:!options.fresh&&reusable(cached,key,cwd,gate)&&verifiedLog(cached)?cached:null;
      let observation,mode='executed';
      if(entry){
        mode='reused';const logPath=join(directory,gate.id.replaceAll(':','-')+'.log');copyFileSync(entry.logPath,logPath);
        observation={...entry.observation,log:{...entry.observation.log,path:logPath.slice(directory.length+1)}};
        console.log(`${gate.id}: reused verified ${entry.logPath}`);
      }else{
        console.log(`Starting ${gate.id}`);observation=await gateExecutor(gate,directory,env,cwd,controller.signal);
        console.log(`${gate.id}: ${observation.outcome} (${Math.round(observation.elapsedMs)}ms)`);
      }
      const reuseReason=entry?'Verified matching inputs and retained evidence':options.fresh?'Fresh execution requested':!cached?'No prior prerequisite receipt':cached.key!==key?'Prerequisite inputs or environment changed':'Retained evidence or output did not verify';
      const current={key,mode,reuseReason,observation,logPath:join(directory,observation.log.path),elapsedMs:performance.now()-gateStart,...(entry?{reusedFrom:entry.logPath}:{})};
      receipt.gates.push(current);save();
      if(observation.outcome!=='PASS')throw Error(`${gate.id} ${observation.outcome}; later gates were not started`);
      if(gate.id==='preflight'&&plan.requiredBrowsers.length){const playwright=await import('@playwright/test');for(const browser of plan.requiredBrowsers)if(!existsSync(playwright[browser].executablePath()))throw Error(`Install pinned ${browser} before browser validation`);}
      if(!gate.files&&!gate.fixtureBuild)pending.push([gate.id,{...current,outputs:outputIdentity(cwd,gate)}]);
    }
    if(plan.browserPlan){
      const {prepareCompletionIssuers}=await import('./completion-issuers/index.mjs');
      const needsIssuers=plan.browserPlan.steps.some(step=>step.config&&!['consumer','display-image','text','projection','history','raster'].includes(step.family));
      const issuers=needsIssuers?await prepareCompletionIssuers(join(directory,'browser-issuers'),cwd):{env:{}};
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
  }catch(error){receipt.outcome='FAIL';receipt.error=String(error);}
  finally{
    try{
      receipt.after=sourceProvider(cwd);receipt.endedAt=new Date().toISOString();receipt.elapsedMs=performance.now()-start;
      const dependenciesAfter=dependenciesBefore?await dependencyProvider():null;
      receipt.dependenciesUnchanged=dependenciesBefore?.digest===dependenciesAfter?.digest;
      if(before&&(before.digest!==receipt.after.digest||!receipt.dependenciesUnchanged)){receipt.outcome='INCONCLUSIVE';receipt.error='Source changed during validation; successful results are not reusable';}
      receipt.pending=plan.gates.slice(receipt.gates.length).map(gate=>gate.id);
      receipt.pendingBrowsers=(plan.browserPlan?.steps??[]).slice(receipt.browsers.length).map(step=>step.id);
      if(before?.digest===receipt.after.digest&&receipt.dependenciesUnchanged){for(const [id,entry]of pending)cache.entries[id]=entry;saveAtomic(cachePath,cache);}
      save();console.log(`${receipt.outcome}: ${join(directory,'receipt.json')}`);
    }finally{try{await hostLease?.release();}finally{process.off('SIGINT',interrupt);process.off('SIGTERM',terminate);closeSync(lock);const current=lstatSync(lockPath,{throwIfNoEntry:false});if(current?.ino===lockIdentity.ino&&current.dev===lockIdentity.dev)unlinkSync(lockPath);}}
  }
  return receipt;
}
export async function main(args){
  const options=argumentsFor([...args]);
  if(options.command==='plan'){console.log(JSON.stringify(developmentPlan(root,{...options,output:join(root,'artifacts/validation-plan-only')}),null,2));return;}
  if(process.versions.node!==versions.node)throw Error(`Use Node ${versions.node}`);
  if(execFileSync('npm',['--version'],{encoding:'utf8'}).trim()!==versions.npm)throw Error(`Use npm ${versions.npm}`);
  const result=await executeDevelopment({options});if(result.outcome!=='PASS')process.exitCode=1;
}
if(import.meta.main)main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
