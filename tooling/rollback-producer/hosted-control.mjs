// Fixed native-host phases. Root execution is limited to the reviewed controller
// closure; every payload and inode-observer child drops privileges before work.
import {createHash} from 'node:crypto';
import {constants, writeSync, openSync, closeSync, fsyncSync} from 'node:fs';
import {open, lstat, realpath, mkdir, readlink, statfs} from 'node:fs/promises';
import {dirname, join, resolve, relative, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {boundedChild} from '../qualification/container/bounded-child.mjs';
import {acquireTimingLock, timingLockDirectory} from '../qualification/campaigns/host.mjs';
import {loadAllocation, startEvidenceMonitor, retainEvidenceAudit, verifyEvidenceAudit} from '../qualification/evidence-volume.mjs';
import {createAccounting, coverage, volumeSize, workerCanonical} from './hosted-accounting.mjs';

export const PHASES = Object.freeze(['inputs','toolchain','build16','build17','build18','verify16','verify17','verify18']);
export const REQUIRED_SOURCE_PATHS = Object.freeze(['tooling/rollback-producer/hosted-control.mjs','tooling/rollback-producer/hosted-worker.py','tooling/rollback-producer/hosted-host.py','tooling/rollback-producer/hosted-export.py','tooling/rollback-producer/hosted-offline.py','tooling/rollback-producer/hosted-accounting.mjs','tooling/rollback-producer/volume_observer.py','tooling/rollback-producer/hosted-inputs.mjs','tooling/rollback-producer/hosted-inputs.json','tooling/qualification/container/bounded-child.mjs','tooling/qualification/campaigns/host.mjs','tooling/qualification/campaigns/common.mjs','tooling/qualification/evidence-volume.mjs','tooling/qualification/evidence-trends.mjs','tooling/bootstrap-toolchain.py','tooling/toolchain.json','tests/store/no-network.mjs']);
export const TIMEOUTS = Object.freeze({initialize:120000, inputs:600000, prepare:600000, recheck:600000, toolchain:600000, build16:14400000, build17:14400000, build18:14400000, verify16:7200000, verify17:7200000, verify18:7200000, collect:1800000, observe:2000, 'host-check':120000});
const require = (value, message) => {if (!value) throw Error(message);};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
const canonical = path => typeof path === 'string' && isAbsolute(path) && resolve(path) === path && !/[\x00-\x1f\x7f]/.test(path);
const stamp = s => ['dev','ino','mode','nlink','uid','gid','size','mtimeNs','ctimeNs'].map(k => String(s[k])).join(':');
const errorRecord = error => ({name:String(error?.name ?? 'Error'), message:String(error?.message ?? error).slice(0,2048)});
export function sealedMemberPath(root,name){require(typeof name==='string'&&name.length>0&&!name.startsWith('/')&&!name.includes('\\')&&!/[\x00-\x1f\x7f]/.test(name)&&name.split('/').every(part=>part!==''&&part!=='.'&&part!=='..'),'Unsafe sealed member path');return join(root,name);}
export const successfulChild = result => result?.code === 0 && result.signal === null && result.timedOut === false && result.interrupted === false && !result.error;
export const childClosureUncertain = (action,result) => !result || !!result.error || result.timedOut === true || result.interrupted === true || !successfulChild(result) && ['inputs','toolchain','host-check',...PHASES.slice(2)].includes(action);

async function held(path, expected = null, {immutable = false, maximum = 4*1024**2, collect = true} = {}) {
  require(canonical(path) && await realpath(path) === path, 'Canonical non-aliased file required');
  for (let parent = dirname(path);; parent = dirname(parent)) {
    const s = await lstat(parent); require(s.isDirectory() && !s.isSymbolicLink(), 'Linked file ancestor refused');
    if (immutable) require(s.uid === 0 && !(s.mode & 0o022), 'Writable/unowned control ancestor');
    if (parent === dirname(parent)) break;
  }
  const before = await lstat(path,{bigint:true}); require(before.isFile() && before.nlink === 1n && before.size <= BigInt(maximum), 'Bounded ordinary single-link file required');
  if (immutable) require(before.uid === 0n && !(before.mode & 0o022n), 'Control source/config must be immutable root-owned');
  const handle = await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK), chunks=[], digest=createHash('sha256'); let bytes=0;
  try {
    require(stamp(before) === stamp(await handle.stat({bigint:true})), 'Input changed before read');
    const buffer=Buffer.alloc(65536);
    for (;;) {const result=await handle.read(buffer,0,buffer.length,null); if (!result.bytesRead) break; bytes+=result.bytesRead; require(bytes<=maximum,'Input grew'); digest.update(buffer.subarray(0,result.bytesRead)); if(collect)chunks.push(Buffer.from(buffer.subarray(0,result.bytesRead)));}
    require(BigInt(bytes) === before.size && stamp(before) === stamp(await handle.stat({bigint:true})) && stamp(before) === stamp(await lstat(path,{bigint:true})), 'Input changed while read');
  } finally {await handle.close();}
  const ref={path,bytes,sha256:digest.digest('hex')}; require(!expected || isDeepStrictEqual(ref,expected),'Exact file pin differs');
  return {ref,bytes:collect?Buffer.concat(chunks):null};
}
async function save(path,value) {const handle=await open(path,'wx',0o600);try{await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync();}finally{await handle.close();}return (await held(path)).ref;}
const data = async ref => JSON.parse((await held(ref.path,ref)).bytes);
async function absent(path) {try{await lstat(path);throw Error('Existing output refuses execution: '+path);}catch(e){if(e.code!=='ENOENT')throw e;}}
export function validateConfig(value) {
  require(exact(value,['kind','runId','controlRoot','sources','tools','owner','evidenceAllocation','dataAllocation','dataRootIdentity','onlineNetns','setup','hostSelection','hostObservation','hostEnvironment','input','producers','job','exportRoot']), 'Configuration fields differ');
  require(value.kind==='hosted-native-controller-config-1' && /^ie-native-[a-f0-9]{32}$/.test(value.runId) && canonical(value.controlRoot),'Explicit native run/source root required');
  require(exact(value.owner,['uid','gid','groups']) && [value.owner.uid,value.owner.gid].every(n=>Number.isSafeInteger(n)&&n>0) && Array.isArray(value.owner.groups) && value.owner.groups.length===0 && value.owner.groups.every(n=>Number.isSafeInteger(n)&&n>0) && isDeepStrictEqual(value.owner.groups,[...new Set(value.owner.groups)].sort((a,b)=>a-b)), 'Exact nonroot ownership/groups required');
  const ref = row => exact(row,['path','bytes','sha256']) && canonical(row.path) && Number.isSafeInteger(row.bytes) && row.bytes>=0 && row.bytes<=256*1024**2 && /^[a-f0-9]{64}$/.test(row.sha256);
  require(Array.isArray(value.sources)&&value.sources.length>0&&value.sources.length<=256&&value.sources.every(ref)&&new Set(value.sources.map(r=>r.path)).size===value.sources.length,'Exact finite control-source closure required');
  require(exact(value.tools,['node','python','git','unshare','setpriv'])&&Object.values(value.tools).every(ref),'Exact control binaries required');
  require([value.evidenceAllocation,value.dataAllocation,value.setup,value.hostSelection,value.hostObservation].every(ref),'Issued allocation/setup/host references required');
  require(exact(value.dataRootIdentity,['dev','ino']) && Number.isSafeInteger(value.dataRootIdentity.dev)&&value.dataRootIdentity.dev>=0&&Number.isSafeInteger(value.dataRootIdentity.ino)&&value.dataRootIdentity.ino>0,'Actual native data-root identity required');
  require(/^net:\[[0-9]+\]$/.test(value.onlineNetns),'Actual online network namespace required');
  require(exact(value.hostEnvironment,['PATH','HOME','TMPDIR']) && Object.values(value.hostEnvironment).every(x=>typeof x==='string'&&x.length>0),'Frozen host observation environment required');
  require(exact(value.input,['remote','commit','tree','manifest'])&&value.input.remote==='https://github.com/Westbrook/ideogram-editor.git'&&value.input.commit==='850b10cfa4853a14290c7220538f4d6f49ba124d'&&value.input.tree==='769d56f65b15b7c5a420c22ec9160da38b0401ab'&&exact(value.input.manifest,['bytes','sha256'])&&value.input.manifest.bytes===12726&&value.input.manifest.sha256==='5b71db1fd6c60980c8297b9fe48922a75c0a4dcaac6f73d6c4c0925a3e921e45','Exact input authority remains unissued or differs');
  require(exact(value.producers,['16','17','18'])&&Object.values(value.producers).every(x=>exact(x,['seal'])&&ref(x.seal)),'Exact active producer seals required');
  const under = path => {const part=relative(value.controlRoot,path);return part&&!isAbsolute(part)&&part!=='..'&&!part.startsWith('../');};
  require(value.sources.every(r=>under(r.path)) && Object.values(value.producers).every(p=>under(p.seal.path)),'Source escaped immutable controller closure');
  require(canonical(value.exportRoot)&&value.exportRoot.endsWith('/'+value.runId),'Fixed fresh export root required');
  require(REQUIRED_SOURCE_PATHS.every(path=>value.sources.some(row=>row.path===join(value.controlRoot,path))),'Executed control dependency omitted from source closure');
  require(exact(value.job,['startedEpochMs','deadlineEpochMs'])&&Number.isSafeInteger(value.job.startedEpochMs)&&Number.isSafeInteger(value.job.deadlineEpochMs)&&value.job.startedEpochMs>0&&value.job.deadlineEpochMs>value.job.startedEpochMs&&value.job.deadlineEpochMs-value.job.startedEpochMs<=21600000,'Actual bounded hosted job deadline required');
  return value;
}

export const EXPORT_RESERVE_MS = 1800000;
export function phaseBudgetMs(phase) {
  require(PHASES.includes(phase),'Unknown phase budget');
  // Two fixed host checks, actual selected phase, input preparation/recheck,
  // bounded output inventory for build/verify, and their existing child grace.
  const actions=['host-check',phase,phase==='inputs'?'prepare':'recheck','host-check'];
  if(phase==='inputs')actions.push('initialize');
  if(/^(build|verify)/.test(phase))actions.push('collect');
  return actions.reduce((sum,action)=>sum+TIMEOUTS[action]+10000,0)+300000;
}
export function admitJobPhase(config,phase,now) {
  require(Number.isSafeInteger(now)&&now>=config.job.startedEpochMs,'Job clock precedes recorded start');
  const remainingMs=config.job.deadlineEpochMs-now;
  require(remainingMs>=phaseBudgetMs(phase)+EXPORT_RESERVE_MS,'Unchanged phase maximum does not fit remaining hosted job budget');
  return {remainingMs,phaseBudgetMs:phaseBudgetMs(phase),exportReserveMs:EXPORT_RESERVE_MS};
}
export function payloadArgv(config,configPath,grant,action,{draftSha256=null,phase=null}={}) {
  require(['initialize','observe','inputs','prepare','recheck','toolchain','collect','host-check',...PHASES.slice(2)].includes(action),'Unsupported fixed child action');
  const owner=config.owner, args=[`--reuid=${owner.uid}`,`--regid=${owner.gid}`, owner.groups.length?`--groups=${owner.groups.join(',')}`:'--clear-groups','--inh-caps=-all','--ambient-caps=-all','--bounding-set=-all','--no-new-privs','--',config.tools.python.path,'-I','-S','-B',join(config.controlRoot,'tooling/rollback-producer/hosted-worker.py'),'--config',configPath,'--grant',grant,'--action',action];
  if(action.startsWith('verify')) {require(/^[a-f0-9]{64}$/.test(draftSha256??''),'Exact predecessor draft required');args.push('--draft-sha256',draftSha256);}
  else require(draftSha256===null,'Unexpected draft argument');
  if(action==='collect'){require(/^((build|verify)(16|17|18))$/.test(phase??''),'Fixed output family required');args.push('--phase',phase);}else require(phase===null,'Unexpected phase argument');
  return action.startsWith('verify') ? {binary:config.tools.unshare.path,args:['--net','--',config.tools.setpriv.path,...args]} : {binary:config.tools.setpriv.path,args};
}
export function nativeSummary(summary) {
  // Original accounting objects remain internal compatibility data. No Docker
  // metrics or qualification are asserted for this native inode observation.
  return {kind:'hosted-native-data-observation-1',status:summary.status,scopes:summary.scopes,records:summary.records,journalHead:summary.journalHead,intervalMs:summary.intervalMs,maxSuccessfulStartGapMs:summary.maxSuccessfulStartGapMs,physicalQualification:false};
}
export function replayDataRecords(lines,request,capacityBytes,expected) {
  let previous=null,sequence=0,command=null;const records=[],watchdog=[];
  for(const row of lines){
    if(row.kind==='hosted-native-observation-command-1'){require(command===null,'Orphan observation command');command=row;continue;}
    const {hash,...body}=row;require(row.sequence===sequence++&&row.previous===previous&&hash===sha(JSON.stringify(body)),'Data observation journal chain differs');previous=hash;
    if(row.key==='producer-data'){
      require(command&&Number.isFinite(command.startedMs)&&command.startedMs>=row.startedMs&&Number.isFinite(command.endedMs)&&command.endedMs>=command.startedMs&&command.endedMs<=row.endedMs,'Observer command interval missing');
      require(command.root===request.root&&isDeepStrictEqual(command.rootIdentity,request.rootIdentity),'Observer root binding differs');
      if(row.error===null){
        require(successfulChild(command.result)&&command.failure===null,'Failed observer cannot be successful accounting');
        const raw=Buffer.from(command.stdoutBase64,'base64');require(raw.length<=65536&&Buffer.from(command.stderrBase64,'base64').length<=16384,'Observer stream bound');
        const value=JSON.parse(raw);require(raw.toString()===workerCanonical(value)+'\n','Observer canonical output differs');
        const result=volumeSize(value,request.worker);require(result.bytes===row.bytes&&isDeepStrictEqual(result,row.observation),'Observer replay differs');
      }
      command=null;records.push(row);
    }else{require(row.key==='host-journal-watchdog'&&command===null,'Unknown accounting scope');if(row.error===null)require(row.bytes===0&&isDeepStrictEqual(row.observation,{bytes:0,meaning:'Journal watchdog only; actual host audit owns accounting'}),'Watchdog observation differs');watchdog.push(row);}
  }
  require(command===null&&sequence===expected.records&&previous===expected.journalHead,'Incomplete accounting journal');
  require(expected.scopes.length===2&&new Set(expected.scopes.map(x=>x.key)).size===2,'Exact two replay scopes required');
  const scopes=[['host-journal-watchdog',coverage(watchdog,1)],['producer-data',coverage(records,capacityBytes)]].map(([key,actual])=>{const declared=expected.scopes.find(x=>x.key===key);require(declared&&Object.entries(actual).every(([k,v])=>isDeepStrictEqual(declared[k],v)),'Native coverage replay differs: '+key);return {key,...actual};});
  const status=scopes.every(x=>x.status==='PASS')?'PASS':'FAIL';require(expected.status!=='PASS'||status==='PASS','Declared PASS contradicts journal');return {status:expected.status==='PASS'&&status==='PASS'?'PASS':'FAIL',scopes,records:sequence,journalHead:previous};
}
export async function monitoredBody({startHost,startData,body,finishData,finishHost,release,onFailure=()=>{}}) {
  // Small injectable lifecycle seam. Actual CLI implements these with existing
  // monitor/accounting/lease APIs, not an alternate receipt or retry framework.
  let host=false,data=false,raw='FAIL',failure=null;const closure={data:null,host:null,released:false};
  try {host=true;await startHost();data=true;await startData();await body();raw='PASS';}
  catch(error){failure=errorRecord(error);onFailure(error);}
  finally{
    try{if(data)closure.data=await finishData(raw);}catch(error){failure??=errorRecord(error);}
    try{if(host)closure.host=await finishHost(raw,closure.data,failure);}catch(error){failure??=errorRecord(error);}
    try{closure.released=await release();}catch(error){failure??=errorRecord(error);}
  }
  return {rawOutcome:raw,effectiveOutcome:!failure&&closure.data?.status==='PASS'&&closure.host?.status==='PASS'&&closure.released?'PASS':'FAIL',failure,...closure};
}

async function main(){
  const argv=process.argv.slice(2);require(argv.length===6&&argv[0]==='--config'&&argv[2]==='--grant'&&['--phase','--replay','--export'].includes(argv[4])&&PHASES.includes(argv[5]),'Fixed --config ABS --grant SHA256 --phase PHASE required');
  const [configPath,grant,phase]=[argv[1],argv[3],argv[5]], replayOnly=argv[4]==='--replay', exportOnly=argv[4]==='--export';
  require(process.platform==='linux'&&process.arch==='x64'&&process.getuid()===0&&process.geteuid()===0&&process.versions.node==='26.10.0'&&globalThis.__storeNetworkCounters,'Root Linux x64 pinned Node/no-network control required');
  const input=await held(configPath,null,{immutable:true});require(input.ref.sha256===grant,'Configuration grant differs');const config=validateConfig(JSON.parse(input.bytes));
  const guard=async()=>{await held(configPath,input.ref,{immutable:true});for(const row of [...config.sources,...Object.values(config.tools),config.setup,config.hostSelection,config.hostObservation,config.evidenceAllocation,config.dataAllocation])await held(row.path,row,{immutable:true,maximum:256*1024**2,collect:false});};
  await guard();
  const setup=await data(config.setup);require(setup.kind==='hosted-native-unmeasured-setup-1'&&setup.setupMeasured===false&&setup.producerAccountDedicated===true&&Number.isSafeInteger(setup.runnerUid)&&setup.runnerUid>0&&setup.runnerUid!==config.owner.uid&&isDeepStrictEqual(setup.owner,config.owner),'Explicit separate producer account/setup identity required');
  require(Object.values(globalThis.__storeNetworkCounters.read()).every(value=>value===0),'Controller network effect detected');
  for(const [version,producer] of Object.entries(config.producers)){const seal=JSON.parse((await held(producer.seal.path,producer.seal,{immutable:true})).bytes);for(const [name,pin] of Object.entries(seal.files)){const path=sealedMemberPath(join(config.controlRoot,'tooling/rollback-producer/schema'+version),name);require(config.sources.some(row=>row.path===path&&pin.hash==='sha256:'+row.sha256&&pin.byteLength===String(row.bytes)),'Sealed producer dependency omitted from source closure');}}
  require(config.sources.some(x=>x.path===fileURLToPath(import.meta.url)),'Controller is outside selected source closure');
  require(await realpath(process.execPath)===config.tools.node.path&&await readlink('/proc/self/ns/net')===config.onlineNetns,'Actual controller runtime/network namespace differs');
  const evidence=await loadAllocation(config.evidenceAllocation.path),producerAllocation=await loadAllocation(config.dataAllocation.path);
  require(evidence.capacityBytes===4*1024**3&&producerAllocation.capacityBytes===32*1024**3&&producerAllocation.kind==='evidence-volume-allocation-1','Original explicit native capacities required');
  const dataRoot=producerAllocation.root;require(isDeepStrictEqual(config.hostEnvironment,{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:join(dataRoot,'home'),TMPDIR:join(dataRoot,'tmp')}),'Measured host observation environment must stay in producer allocation');require(canonical(dataRoot)&&await realpath(dataRoot)===dataRoot,'Data root alias');
  const a=relative(evidence.root,dataRoot),b=relative(dataRoot,evidence.root);require(a.startsWith('../')&&b.startsWith('../'),'Allocations must be disjoint');
  const es=await lstat(evidence.root),ds=await lstat(dataRoot);require(es.uid===0&&!(es.mode&0o077)&&ds.uid===config.owner.uid&&ds.gid===config.owner.gid&&(ds.mode&0o777)===0o700&&ds.dev===config.dataRootIdentity.dev&&ds.ino===config.dataRootIdentity.ino,'Actual allocation ownership/identity differs');
  const runRoot=join(evidence.root,config.runId),out=join(runRoot,phase),index=PHASES.indexOf(phase);
  if(exportOnly){
    const final=JSON.parse((await held(join(out,'finalization.json'))).bytes), acquired=JSON.parse((await held(join(out,'timing-acquired.json'))).bytes);
    require(final.timingLockReleased===true&&final.config.sha256===grant,'Export requires actual closed phase/lease');
    for(const path of [acquired.path,acquired.path+'.borrow',acquired.path+'.closing'])await absent(path);
    const remaining=config.job.deadlineEpochMs-Date.now()-60000;require(remaining>0,'No bounded export time remains');
    const chunks=[];let count=0,overflow=false;const aborter=new AbortController(),stop=()=>aborter.abort('Export interrupted');process.on('SIGINT',stop);process.on('SIGTERM',stop);
    let result;try{result=await boundedChild(config.tools.python.path,['-I','-S','-B',join(config.controlRoot,'tooling/rollback-producer/hosted-export.py'),'--config',configPath,'--grant',grant,'--through',phase],{cwd:config.controlRoot,env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',TZ:'UTC'},timeoutMs:Math.min(1200000,remaining),graceMs:10000,abortSignal:aborter.signal,onStdout:chunk=>{count+=chunk.length;if(count>65536){overflow=true;aborter.abort('Export stream bound');}else chunks.push(Buffer.from(chunk));},onStderr:chunk=>{count+=chunk.length;if(count>65536){overflow=true;aborter.abort('Export stream bound');}else process.stderr.write(chunk);}});}finally{process.off('SIGINT',stop);process.off('SIGTERM',stop);}
    require(successfulChild(result)&&!overflow&&!aborter.signal.aborted,'Post-drain export incomplete; originals retained');console.log(Buffer.concat(chunks).toString('utf8').trim());return;
  }
  if(replayOnly){const item=JSON.parse((await held(join(out,'data-replay-input.json'))).bytes);require(item.request.root===dataRoot&&isDeepStrictEqual(item.request.rootIdentity,config.dataRootIdentity)&&item.capacityBytes===producerAllocation.capacityBytes&&item.journal.path===join(out,'data-observations.jsonl'),'Replay binding differs');const raw=await held(item.journal.path,item.journal,{maximum:512*1024**2});const rows=raw.bytes.toString().trimEnd().split('\n').map(line=>JSON.parse(line));console.log(JSON.stringify(replayDataRecords(rows,item.request,item.capacityBytes,item.summary)));return;}
  const jobAdmission=admitJobPhase(config,phase,Date.now());
  const free=await statfs(dataRoot,{bigint:true}), availableBytes=free.bavail*free.bsize;
  require(availableBytes>=0n&&free.bsize>0n,'Physical availability observation invalid');
  let carried={prepared:null,drafts:{},packets:{}};
  if(index===0){await absent(runRoot);await mkdir(runRoot,{mode:0o700});}
  else{
    const priorPath=join(runRoot,PHASES[index-1],'finalization.json'),prior=JSON.parse((await held(priorPath)).bytes);
    require(prior.kind==='hosted-native-phase-finalization-1'&&prior.effectiveOutcome==='PASS'&&prior.timingLockReleased===true&&prior.config.sha256===grant&&prior.phase===PHASES[index-1],'Exact successful closed predecessor required');
    const receipt=await data(prior.receipt);require(receipt.runId===config.runId&&receipt.phase===PHASES[index-1]&&receipt.outcome==='PASS'&&prior.dataReplay.status==='PASS'&&prior.hostReplay.status==='PASS','Predecessor outcomes differ');carried=receipt.carried;
  }
  await absent(out);await mkdir(out,{mode:0o700});
  const aborter=new AbortController(),interrupt=signal=>aborter.abort(signal),sigint=()=>interrupt('SIGINT'),sigterm=()=>interrupt('SIGTERM');process.on('SIGINT',sigint);process.on('SIGTERM',sigterm);
  const jobTimer=setTimeout(()=>aborter.abort('Hosted job cleanup/export reserve reached'),config.job.deadlineEpochMs-EXPORT_RESERVE_MS-Date.now());
  let uncertain=false,lease=null,host=null,accounting=null,log=null,logBytes=0,ordinal=0,receiptRef=null,dataFinal=null,dataReplay=null,hostFinal=null,hostReplay=null,watchFailure=null;
  const state={kind:'hosted-native-phase-1',phase,runId:config.runId,config:input.ref,startedAt:new Date().toISOString(),outcome:'FAIL',commands:[],carried,physicalQualification:false,setupMeasured:false,controllerNetworkEffects:globalThis.__storeNetworkCounters.read(),jobAdmission,physicalAvailability:{availableBytes:String(availableBytes),observedAt:new Date().toISOString(),reservation:false},failure:null};
  const latch=error=>{watchFailure??=errorRecord(error);aborter.abort('Evidence observation/journal or capacity unavailable');};
  const safeEnv={PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:join(dataRoot,'home'),TMPDIR:join(dataRoot,'tmp'),LANG:'C',LC_ALL:'C',TZ:'UTC',PYTHONDONTWRITEBYTECODE:'1',PYTHONNOUSERSITE:'1',PYTHONSAFEPATH:'1'};
  async function run(action,options={},observation=false){
    const selection=payloadArgv(config,configPath,grant,action,options),buffers=[[],[]],counts=[0,0],limits=observation?[65536,16384]:[16*1024**2,16*1024**2];let failure=null,result=null;
    const local=new AbortController(),cancel=()=>local.abort(aborter.signal.reason);if(!observation){aborter.signal.addEventListener('abort',cancel,{once:true});if(aborter.signal.aborted)cancel();}
    const collect=i=>chunk=>{const n=Math.min(chunk.length,limits[i]-counts[i]);if(n){buffers[i].push(Buffer.from(chunk.subarray(0,n)));counts[i]+=n;}if(n!==chunk.length){failure={message:'Command stream cap exceeded'};local.abort('Command stream cap');}};
    const startedMs=performance.now();
    try{result=await boundedChild(selection.binary,selection.args,{cwd:config.controlRoot,env:safeEnv,timeoutMs:TIMEOUTS[action],graceMs:observation?1000:10000,abortSignal:local.signal,onStdout:collect(0),onStderr:collect(1)});}catch(error){result={code:null,signal:null,error:errorRecord(error)};uncertain=true;}
    finally{aborter.signal.removeEventListener('abort',cancel);}
    if(childClosureUncertain(action,result))uncertain=true;
    const stdout=Buffer.concat(buffers[0]),stderr=Buffer.concat(buffers[1]),entry={kind:observation?'hosted-native-observation-command-1':'hosted-native-command-1',action,binary:selection.binary,argv:selection.args,startedMs,endedMs:performance.now(),result,failure,stdoutBase64:stdout.toString('base64'),stderrBase64:stderr.toString('base64')};
    if(observation){Object.assign(entry,{root:dataRoot,rootIdentity:config.dataRootIdentity});await append(entry);}else{const path=join(out,String(++ordinal).padStart(3,'0')+'-'+action+'.json');state.commands.push(await save(path,entry));}
    require(successfulChild(result)&&failure===null,'Unsuccessful fixed child: '+action);return stdout.toString('utf8').trim();
  }
  async function replayChild(){
    // Parsing/replaying a retained journal is bounded fixed work in a child;
    // the parent remains available to its unchanged host evidence monitor.
    const chunks=[],errors=[];let bytes=0,overflow=false;const local=new AbortController(),startedMs=performance.now();
    let result;try{result=await boundedChild(config.tools.node.path,['--import',join(config.controlRoot,'tests/store/no-network.mjs'),fileURLToPath(import.meta.url),'--config',configPath,'--grant',grant,'--replay',phase],{cwd:config.controlRoot,env:safeEnv,timeoutMs:120000,graceMs:10000,abortSignal:local.signal,onStdout:chunk=>{bytes+=chunk.length;if(bytes>65536){overflow=true;local.abort('Replay output bound');}else chunks.push(Buffer.from(chunk));},onStderr:chunk=>{bytes+=chunk.length;if(bytes>65536){overflow=true;local.abort('Replay output bound');}else errors.push(Buffer.from(chunk));}});}catch(error){uncertain=true;throw error;}
    if(result.timedOut||result.interrupted)uncertain=true;
    const raw=Buffer.concat(chunks);await save(join(out,'data-replay-command.json'),{startedMs,endedMs:performance.now(),result,overflow,stdoutBase64:raw.toString('base64'),stderrBase64:Buffer.concat(errors).toString('base64')});
    require(successfulChild(result)&&!overflow,'Data journal replay child failed');return JSON.parse(raw);
  }
  async function append(value){const bytes=Buffer.from(JSON.stringify(value)+'\n');require(bytes.length<=256*1024&&logBytes+bytes.length<=512*1024**2,'Data journal bound');let offset=0;while(offset<bytes.length){const n=writeSync(log.fd,bytes,offset,bytes.length-offset);require(n>0,'Journal short write');offset+=n;}logBytes+=bytes.length;await log.sync();}
  const request={root:dataRoot,rootIdentity:config.dataRootIdentity,worker:{kind:'capsule-volume-request-1',mode:'sample',ownerUid:config.owner.uid,ownerGid:config.owner.gid,rootIdentity:config.dataRootIdentity,policyId:'capsule-allocated-inodes-1'}};
  try{
    lease=await acquireTimingLock(await timingLockDirectory(),{receiptId:config.runId+'-'+phase});await save(join(out,'timing-acquired.json'),{path:lease.path,identity:lease.identity});
    const lifecycle=await monitoredBody({
      startHost:async()=>{host=await startEvidenceMonitor({allocationPath:config.evidenceAllocation.path,output:out,campaignId:config.runId+'-'+phase,intervalMs:2000,onAlarm:alarm=>{if(alarm.status!=='PASS')latch(alarm);}});require(!aborter.signal.aborted,'Initial controller evidence unknown');state.evidenceStorage=host.reference;},
      startData:async()=>{log=await open(join(out,'data-observations.jsonl'),'wx',0o600);accounting=createAccounting({observe:async target=>{if(target.key==='host-journal-watchdog'){await host.checkpoint();return {bytes:0,meaning:'Journal watchdog only; actual host audit owns accounting'};}const raw=await run('observe',{},true);const value=JSON.parse(raw);require(raw===workerCanonical(value),'Noncanonical worker result');return volumeSize(value,request.worker);},retain:append,onFailure:latch});await accounting.add({key:'host-journal-watchdog',capacityBytes:1,meaning:'Observer journal liveness only'});const initial=await accounting.add({key:'producer-data',capacityBytes:producerAllocation.capacityBytes,meaning:'All unique file/directory/symlink inode blocks, no symlink target traversal'});if(phase==='inputs'){const value=initial.observation.result;require(value.attempts[value.selectedAttempt].counts.entries===1,'New producer-data allocation is not initially empty');}require(!aborter.signal.aborted,'Initial producer evidence unavailable');},
      body:async()=>{await guard();require(!aborter.signal.aborted,'Observation already failed');if(phase==='inputs')await run('initialize');await run('host-check');
        if(phase==='inputs'){await run('inputs');state.carried.prepared=JSON.parse(await run('prepare')).receipt;}
        else{const prepared=JSON.parse(await run('recheck'));require(prepared.receipt.hash===state.carried.prepared.hash&&prepared.receipt.byteLength===state.carried.prepared.byteLength,'Prepared closure differs');
          if(phase==='toolchain')await run('toolchain');
          else{const version=phase.slice(-2),draft=state.carried.drafts[version];const stdout=await run(phase,phase.startsWith('verify')?{draftSha256:draft?.sha256}:{});const output=JSON.parse(stdout.split('\n').at(-1));const closure=JSON.parse(await run('collect',{phase}));
            if(phase.startsWith('build')){const ref=closure.required.find(x=>x.path.endsWith('/draft.json'));require(ref&&output.draft?.hash==='sha256:'+ref.sha256&&output.draft.byteLength===String(ref.bytes),'Actual draft output differs');state.carried.drafts[version]=ref;}
            else{require(output.pin&&output.identity?.hash&&closure.required.some(x=>x.path.endsWith('/packet.json')&&output.identity.hash==='sha256:'+x.sha256),'Actual packet/pin missing');state.carried.packets[version]={identity:output.identity,pin:output.pin,inventory:closure.inventory};}
          }
        }
        await run('host-check');await guard();require(Object.values(globalThis.__storeNetworkCounters.read()).every(value=>value===0),'Controller network effect detected');require(!aborter.signal.aborted,'Observation/source interrupted phase');state.outcome='PASS';},
      finishData:async()=>{if(!accounting)return {status:'FAIL'};dataFinal=nativeSummary(await accounting.finish());await log.sync();await log.close();log=null;const journal=(await held(join(out,'data-observations.jsonl'),null,{maximum:512*1024**2,collect:false})).ref;await save(join(out,'data-replay-input.json'),{request,capacityBytes:producerAllocation.capacityBytes,summary:dataFinal,journal});dataReplay=await replayChild();state.dataStorage={summary:dataFinal,journal,replay:dataReplay};return {status:dataFinal.status==='PASS'&&dataReplay.status==='PASS'?'PASS':'FAIL'};},
      finishHost:async(raw,closed,failure)=>{if(!host)return {status:'FAIL'};state.outcome=raw;state.failure=failure??watchFailure;state.endedAt=new Date().toISOString();receiptRef=await save(join(out,'receipt.json'),state);hostFinal=await host.finish({receiptPath:receiptRef.path,outcome:state.outcome});await retainEvidenceAudit(host.reference,out);hostReplay=await verifyEvidenceAudit(host.reference,receiptRef.path);return {status:hostFinal.status==='PASS'&&hostReplay.status==='PASS'?'PASS':'FAIL'};},
      release:async()=>{if(uncertain||accounting&&!dataFinal||host&&!hostFinal)return false;await lease.release();return true;},onFailure:error=>{state.failure??=errorRecord(error);},
    });
    require(!aborter.signal.aborted&&lifecycle.effectiveOutcome==='PASS','Phase did not close successfully');
    state.finalOutcome='PASS';
  }catch(error){state.finalOutcome='FAIL';state.failure??=errorRecord(error);}
  finally{
    // Partial-start failure must still drain any actually created observers.
    if(accounting&&!dataFinal){try{dataFinal=nativeSummary(await accounting.finish());}catch(error){state.failure??=errorRecord(error);}}
    if(log){try{await log.sync();await log.close();}catch(error){state.failure??=errorRecord(error);}}
    if(host&&!hostFinal){try{receiptRef??=await save(join(out,'receipt.json'),state);hostFinal=await host.finish({receiptPath:receiptRef.path,outcome:'FAIL'});await retainEvidenceAudit(host.reference,out);hostReplay=await verifyEvidenceAudit(host.reference,receiptRef.path);}catch(error){state.failure??=errorRecord(error);}}
  }
  // A still-held or uncertain lease is retained for explicit operator recovery.
  const lockReleased=lease?await lstat(lease.path).then(()=>false,error=>{if(error.code==='ENOENT')return true;throw error;}):false;
  const final={kind:'hosted-native-phase-finalization-1',phase,config:input.ref,receipt:receiptRef,effectiveOutcome:state.finalOutcome==='PASS'&&!aborter.signal.aborted&&lockReleased?'PASS':'FAIL',failure:state.failure,dataSummary:dataFinal,dataReplay,hostAudit:hostFinal,hostReplay,timingLockReleased:lockReleased,physicalQualification:false};
  const terminalBytes=Buffer.from(JSON.stringify(final,null,2)+'\n'),terminalPath=join(out,'finalization.json');clearTimeout(jobTimer);process.off('SIGINT',sigint);process.off('SIGTERM',sigterm);const terminal=openSync(terminalPath,'wx',0o600);try{let offset=0;while(offset<terminalBytes.length){const n=writeSync(terminal,terminalBytes,offset,terminalBytes.length-offset);require(n>0,'Terminal short write');offset+=n;}fsyncSync(terminal);}finally{closeSync(terminal);}const finalRef={path:terminalPath,bytes:terminalBytes.length,sha256:sha(terminalBytes)};console.log(JSON.stringify({outcome:final.effectiveOutcome,receipt:receiptRef,finalization:finalRef}));process.exitCode=final.effectiveOutcome==='PASS'?0:1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
