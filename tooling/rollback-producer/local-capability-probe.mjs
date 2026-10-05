// Operational, finite Desktop capability experiment. Root executes only after review.
import {createHash} from 'node:crypto';
import {constants, closeSync, fsyncSync, fstatSync, lstatSync, openSync, readFileSync, writeSync} from 'node:fs';
import {mkdir, realpath} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual as same} from 'node:util';
import {boundedChild} from '../qualification/container/bounded-child.mjs';
import {acquireTimingLock, timingLockDirectory} from '../qualification/campaigns/host.mjs';
import {loadAllocation, startEvidenceMonitor, retainEvidenceAudit, verifyEvidenceAudit} from '../qualification/evidence-volume.mjs';
import {createToolchainQuiescence} from './local-toolchain-quiescence.mjs';
import {createAccounting, containerSize, imageSize, ENGINE_CONTAINER_FIELDS, ENGINE_IMAGE_FIELDS} from './local-accounting.mjs';
import {requestedImageLabels,containerImageLabelsMatch,imageLabelArgs} from './local-image-labels.mjs';

const check = (yes, code) => {if (!yes) throw Error(code);};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const err = error => ({name:String(error?.name ?? 'Error'), message:String(error?.message ?? error).slice(0, 1024)});
const IMAGE = 'sha256:2d4f521035336480bf68d7790f242d0abeba90f8116c4443262269ec0d7e8910';
const MAX_LOG = 512 * 1024;
const stamp = stat => [stat.dev,stat.ino,stat.mode,stat.nlink,stat.size,stat.mtimeNs,stat.ctimeNs].map(String);
function held(path, expected) {
  check(resolve(path) === path, 'ABSOLUTE_INPUT_REQUIRED');
  const before = lstatSync(path, {bigint:true});
  check(before.isFile() && before.nlink === 1n && before.size <= 256n * 1024n * 1024n, 'BOUNDED_ORDINARY_INPUT_REQUIRED');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {check(same(stamp(before),stamp(fstatSync(fd,{bigint:true}))), 'INPUT_OPEN_DRIFT'); bytes = readFileSync(fd); check(same(stamp(before),stamp(fstatSync(fd,{bigint:true}))) && same(stamp(before),stamp(lstatSync(path,{bigint:true}))), 'INPUT_READ_DRIFT');}
  finally {closeSync(fd);}
  const ref = {path,bytes:bytes.length,sha256:sha(bytes)};
  check(!expected || same(expected,ref), 'INPUT_PIN_DIFFERS'); return {ref,bytes};
}
function save(path, value) {
  const bytes = Buffer.from(JSON.stringify(value,null,2)+'\n'), fd = openSync(path,'wx',0o600);
  try {let at=0; while(at<bytes.length) at+=writeSync(fd,bytes,at,bytes.length-at); fsyncSync(fd);} finally {closeSync(fd);}
  return {path,bytes:bytes.length,sha256:sha(bytes)};
}
export function parseHeartbeat(raw) {
  check(typeof raw === 'string' && Buffer.byteLength(raw) <= MAX_LOG && raw.endsWith('\n'), 'HEARTBEAT_BOUND_OR_PARTIAL');
  const ready={}, ticks={writer:0,descendant:0};
  for (const line of raw.trimEnd().split('\n')) {
    check(Buffer.byteLength(line)<=512,'HEARTBEAT_LINE_BOUND'); const row=JSON.parse(line);
    check(['writer','descendant'].includes(row.role),'HEARTBEAT_ROLE');
    if(row.type==='ready') {
      check(same(Object.keys(row).sort(),['parent','pid','role','session','startTime','type']) && !ready[row.role] && Number.isSafeInteger(row.pid) && row.pid>0 && Number.isSafeInteger(row.parent) && row.parent>=0 && Number.isSafeInteger(row.session) && row.session>0 && /^[0-9]+$/.test(row.startTime),'HEARTBEAT_REGISTRATION'); ready[row.role]=row;
    } else {
      check(same(Object.keys(row).sort(),['count','role','type']) && row.type==='tick' && ready[row.role] && row.count===ticks[row.role]+1 && row.count<=3000,'HEARTBEAT_SEQUENCE'); ticks[row.role]=row.count;
    }
  }
  check(ready.writer?.pid===1 && ready.descendant?.parent===1 && ready.descendant.pid>1 && ready.descendant.session===ready.descendant.pid && ready.writer.session!==ready.descendant.session && ticks.writer>0 && ticks.descendant>0,'HEARTBEAT_BOTH_READY');
  return {ready,ticks,bytes:Buffer.byteLength(raw),sha256:sha(raw)};
}
export function validateContainer(value, expected) {
  const h=value?.HostConfig,c=value?.Config;
  check(value?.Id===expected.id && value.Name==='/'+expected.name && value.Image===IMAGE && c?.Image===IMAGE && containerImageLabelsMatch(c.Labels,expected.imageLabels,{'org.ideogram.rollback-run':expected.runId}) && c.User===expected.user,'CONTAINER_IDENTITY');
  check(h?.NetworkMode==='none' && h.Privileged===false && h.ReadonlyRootfs===true && same(h.CapDrop,['ALL']) && (h.CapAdd===null || same(h.CapAdd,[])) && same(h.SecurityOpt,['no-new-privileges']) && h.PidMode===expected.pidMode && h.CgroupnsMode===expected.cgroupns,'CONTAINER_BOUNDARY');
  check(same(c.Entrypoint,['/usr/bin/python3']) && same(c.Cmd,expected.args) && value.Path==='/usr/bin/python3' && same(value.Args,expected.args),'CONTAINER_COMMAND');
  check(same(h.LogConfig,{Type:'json-file',Config:{'max-size':'1m','max-file':'1'}}) && h.PidsLimit===16 && same(h.RestartPolicy,{Name:'no',MaximumRetryCount:0}) && (!h.Devices || h.Devices.length===0) && (!h.Binds || h.Binds.length===0) && (!h.Tmpfs || Object.keys(h.Tmpfs).length===0),'CONTAINER_EXTRAS');
  check(h.Mounts?.length===1 && value.Mounts?.length===1,'CONTAINER_MOUNTS');
  const requested=h.Mounts[0],actual=value.Mounts[0];
  const bound=path=>path===expected.source||path==='/host_mnt'+expected.source;
  check(requested.Type==='bind' && bound(requested.Source) && requested.Target===expected.target && requested.ReadOnly===true && actual.Type==='bind' && bound(actual.Source) && actual.Destination===expected.target && actual.RW===false,'CONTAINER_READONLY_SOURCE');
  return value;
}
export function probeCreateArguments(role,expected) {
  check(['writer','observer'].includes(role),'CREATE_ROLE');
  const labels=requestedImageLabels(expected.imageLabels,{'org.ideogram.rollback-run':expected.runId});
  return ['create','--pull','never','--name',expected.name,...imageLabelArgs(labels),'--network','none','--cap-drop','ALL','--security-opt','no-new-privileges','--user',expected.user,'--read-only','--pids-limit','16','--restart','no','--log-driver','json-file','--log-opt','max-size=1m','--log-opt','max-file=1','--cgroupns',expected.cgroupns,...(role==='observer'?['--pid',expected.pidMode]:[]),'--mount','type=bind,src='+expected.source+',dst='+expected.target+',readonly','--entrypoint','/usr/bin/python3',IMAGE,...expected.args];
}
export function heartbeatMembers(heartbeat,kernel) {
  check(kernel.members.length===2 && Object.values(heartbeat.ready).every(row=>kernel.members.some(member=>member.pid===row.pid && member.startTime===row.startTime && member.parent===row.parent)), 'HEARTBEAT_KERNEL_JOIN');
}
export async function observeProbeImageSize(run) {
  // This fixed immutable-image read remains available during failure cleanup.
  // The caller retains its original abort/failure and unchanged command bounds.
  const value=JSON.parse(await run('image-size',['image','inspect','--format',ENGINE_IMAGE_FIELDS,IMAGE],{cleanup:true}));
  return {bytes:imageSize(value,IMAGE).reportedBytes};
}
export function validateProbeConfig(config) {
  const user=value=>typeof value==='string' && /^[1-9][0-9]*:[1-9][0-9]*$/.test(value) && value.split(':').every(x=>Number.isSafeInteger(Number(x))&&Number(x)<=2147483647);
  check(config?.kind==='local-capability-probe-config-1' && /^ie-linux-[a-f0-9]{32}$/.test(config.runId) && user(config.writerUser) && user(config.observerUser) && config.writerUser.split(':')[0]!==config.observerUser.split(':')[0] && config.image===IMAGE && config.docker?.path==='/Applications/Docker.app/Contents/Resources/bin/docker','FIXED_PROBE_CONFIGURATION');
  check(typeof config.dockerHome==='string' && resolve(config.dockerHome)===config.dockerHome && typeof config.node?.path==='string' && resolve(config.node.path)===config.node.path,'PINNED_EXECUTION_ENVIRONMENT');
  return config;
}
export function needsQuiescenceClosure(summary) {
  check(summary && typeof summary.admitted==='boolean' && typeof summary.needsThaw==='boolean' && Number.isSafeInteger(summary.observations)&&summary.observations>=0,'QUIESCENCE_SUMMARY');
  return summary.admitted || summary.needsThaw || summary.observations!==0;
}
export async function runCapabilityInterval({quiescence,heartbeat,initial,clock=()=>performance.now(),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}) {
  const startedMs=clock();let frozen;
  await quiescence.observe(async()=>{
    frozen=await heartbeat('frozen-settled',startedMs+1000);check(same(initial.ready,frozen.ready),'HEARTBEAT_IDENTITY_DRIFT');
    const quietStartedMs=clock();await wait(100);
    const quiet=await heartbeat('frozen-quiet',startedMs+1000);const quietMs=clock()-quietStartedMs;
    check(quietMs>=100 && same(frozen.ready,quiet.ready)&&same(frozen.ticks,quiet.ticks),'FROZEN_HEARTBEAT_ADVANCED');
    return {quietMs,volumeScan:false};
  });
  const resumed=await heartbeat('resumed',startedMs+1000);
  check(same(frozen.ready,resumed.ready)&&resumed.ticks.writer>frozen.ticks.writer&&resumed.ticks.descendant>frozen.ticks.descendant,'HEARTBEAT_DID_NOT_RESUME');
  const endedMs=clock();check(endedMs-startedMs<=1000,'TOTAL_SYNCHRONIZATION_WINDOW');
  return {startedMs,endedMs,windowMs:1000};
}
export async function boundedLoggedCommand({openLog,syncLog,closeLog,before,execute,onUncertain,onSettled=()=>{}}) {
  const handles=[];let result,primary=null;
  try {
    for(const channel of ['out','err'])handles.push(await openLog(channel));
    await before(handles);
    try {
      result=await execute(handles);
      // Child ownership is latched at settlement, before any fallible receipt
      // write, log flush or handle close can interrupt finalization.
      if((result.timedOut||result.interrupted)&&result.exitObserved!==true)onUncertain();
    } catch(error) {onUncertain();throw error;}
    onSettled(result);
  } catch(error) {primary=error;}
  finally {
    for(const handle of handles) {
      try {await syncLog(handle);}catch(error){primary??=error;}
      try {await closeLog(handle);}catch(error){primary??=error;}
    }
  }
  if(primary)throw primary;
  return result;
}

async function main() {
  const args=process.argv.slice(2); check(args.length===4 && args[0]==='--config' && args[2]==='--grant','CONFIG_ARGUMENTS');
  const configInput=held(args[1]), config=JSON.parse(configInput.bytes);
  check(configInput.ref.sha256===args[3] && config.kind==='local-capability-probe-config-1','CONFIG_GRANT');
  check(process.platform==='darwin' && process.arch==='arm64' && process.versions.node==='26.10.0' && globalThis.__storeNetworkCounters,'PINNED_HOST_PRELOAD');
  validateProbeConfig(config);
  check(await realpath('/usr/local/bin/docker')===config.docker.path,'FIXED_DOCKER_PATH');
  check(await realpath(process.execPath)===config.node.path,'FIXED_NODE_PATH');
  const packet=dirname(fileURLToPath(import.meta.url)),repo=resolve(packet,'../..');
  check(config.repo===repo && config.allocation.path===join(repo,'artifacts/evidence-linux-source-01/allocation.json') && config.dockerAllocation.path===join(repo,'artifacts/evidence-linux-source-01/docker-allocation-03.json'),'ORIGINAL_ALLOCATION_REQUIRED');
  const allocation=await loadAllocation(config.allocation.path); held(config.allocation.path,config.allocation);
  check(allocation.capacityBytes===4294967296 && allocation.root===join(repo,'artifacts/evidence-linux-source-01') && dirname(config.output)===allocation.root && /^capability-probe-[a-f0-9]{32}$/.test(config.output.slice(allocation.root.length+1)),'FRESH_ORIGINAL_ALLOCATION_LEAF');
  check(await realpath(allocation.root)===allocation.root,'ALLOCATION_ALIAS');
  const expectedSources=['local-capability-probe.mjs','local-capability-heartbeat.py','local-image-labels.mjs'].map(x=>join(packet,x)).concat(['tooling/rollback-producer/local-cgroup-observer.py','tooling/rollback-producer/local-toolchain-quiescence.mjs','tooling/rollback-producer/local-accounting.mjs','tooling/qualification/container/bounded-child.mjs','tooling/qualification/campaigns/host.mjs','tooling/qualification/campaigns/common.mjs','tooling/qualification/evidence-volume.mjs','tooling/qualification/evidence-trends.mjs','tests/store/no-network.mjs'].map(x=>join(repo,x)));
  check(Array.isArray(config.sources) && same(config.sources.map(x=>x.path).sort(),expectedSources.sort()),'COMPLETE_SOURCE_PINS');
  const refs=[configInput.ref,config.allocation,config.dockerAllocation,config.docker,config.node,...config.sources];
  const guard=()=>{for(const ref of refs) held(ref.path,ref);}; guard();
  const engineGrant=JSON.parse(held(config.dockerAllocation.path,config.dockerAllocation).bytes);
  check(engineGrant.kind==='linux-docker-accounting-allocation-1' && engineGrant.context==='desktop-linux' && engineGrant.engine?.meaning==='per-object-engine-reported-nonexclusive-bytes' && [engineGrant.engine.containerWritableCapacityBytes,engineGrant.engine.imageReportedCapacityBytes].every(x=>Number.isSafeInteger(x)&&x>0),'EXISTING_ENGINE_ALLOCATION');
  await mkdir(config.output,{mode:0o700});
  const state={kind:'local-capability-probe-receipt-1',runId:config.runId,startedAt:new Date().toISOString(),config:configInput.ref,sources:refs,status:'UNAVAILABLE',qualification:false,producerExecuted:false,nativeAllocationsTouched:false,commands:[],containers:{},trace:[],heartbeat:[],cleanup:[],limitations:['No producer or whole-volume scan executed.','Docker daemon logs/metadata and VM backing-file physical allocation are not observable; engine sizes are nonexclusive.','Stopped containers and all failed evidence retained.']};
  let owner=null,monitor=null,accounting=null,quiescence=null,uncertain=false,ordinal=0,journal=null;
  const aborter=new AbortController(),onSignal=()=>aborter.abort('PROBE_INTERRUPTED');
  process.on('SIGINT',onSignal);process.on('SIGTERM',onSignal);
  const totalTimer=setTimeout(()=>aborter.abort('PROBE_45_SECOND_DEADLINE'),45000);
  const run=async(label,argv,{deadlineMs=performance.now()+2000,cleanup=false}={})=>{
    held(config.docker.path,config.docker);
    if(label.startsWith('toolchain-kernel-')){const worker=config.sources.find(x=>x.path.endsWith('/local-cgroup-observer.py'));held(worker.path,worker);}
    if(!cleanup)check(!aborter.signal.aborted,'PROBE_INTERRUPTED');
    const allowance=Math.min(2000,Math.floor(deadlineMs-performance.now()));check(allowance>0,'COMMAND_DEADLINE');
    const stem=join(config.output,String(++ordinal).padStart(3,'0')+'-'+label),chunks=[[],[]],counts=[0,0],local=new AbortController();
    let outputError=null,result; const cancel=()=>local.abort(aborter.signal.reason);if(!cleanup){aborter.signal.addEventListener('abort',cancel,{once:true});if(aborter.signal.aborted)cancel();}
    const record={label,argv,startedMs:performance.now(),deadlineMs,cleanup};state.commands.push(record);
    try {result=await boundedLoggedCommand({openLog:channel=>openSync(stem+'.'+channel,'wx',0o600),syncLog:fsyncSync,closeLog:closeSync,before:()=>save(stem+'.started.json',record),onUncertain:()=>{uncertain=true;},onSettled:value=>Object.assign(record,{result:value,endedMs:performance.now()}),execute:async fds=>{
      const append=i=>bytes=>{try{check(counts[i]+bytes.length<=MAX_LOG,'CHILD_OUTPUT_BOUND');let at=0;while(at<bytes.length){const count=writeSync(fds[i],bytes,at,bytes.length-at);check(count>0,'CHILD_LOG_SHORT_WRITE');at+=count;}counts[i]+=bytes.length;chunks[i].push(Buffer.from(bytes));}catch(error){outputError=err(error);local.abort('CHILD_OUTPUT_BOUND');}};
      return boundedChild(config.docker.path,['--context','desktop-linux',...argv],{cwd:repo,env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:config.dockerHome,LANG:'C',TZ:'UTC'},timeoutMs:allowance,graceMs:1000,abortSignal:local.signal,onStdout:append(0),onStderr:append(1)});
    }});}
    finally {aborter.signal.removeEventListener('abort',cancel);}
    Object.assign(record,{endedMs:performance.now(),result,outputError,stdout:held(stem+'.out').ref,stderr:held(stem+'.err').ref});save(stem+'.finished.json',record);
    check(result.code===0&&result.signal===null&&!result.timedOut&&!result.interrupted&&!result.error&&!outputError,'COMMAND_FAILED_'+label.toUpperCase().replaceAll('-','_'));
    check(record.endedMs<=deadlineMs,'COMMAND_DEADLINE');const raw=Buffer.concat(chunks[0]).toString('utf8');
    if(label==='toolchain-kernel-1')heartbeatMembers(state.heartbeat[0],JSON.parse(raw));
    return raw;
  };
  const expected=role=>({id:state.containers[role]?.id,name:config.runId+'-'+role,runId:config.runId,imageLabels:state.imageLabels,user:role==='writer'?config.writerUser:config.observerUser,pidMode:role==='writer'?'':'container:'+state.containers.writer.id,cgroupns:role==='writer'?'private':'host',source:role==='writer'?join(packet,'local-capability-heartbeat.py'):join(repo,'tooling/rollback-producer/local-cgroup-observer.py'),target:role==='writer'?'/inputs/heartbeat.py':'/inputs/local-cgroup-observer.py',args:role==='writer'?['-I','-S','-B','/inputs/heartbeat.py']:['-I','-S','-B','-c','import time; time.sleep(60)']});
  const inspect=async(role,cleanup=false)=>{const e=expected(role),value=JSON.parse(await run('inspect-'+role,['inspect','--type','container',e.id??e.name],{cleanup}))[0];if(!e.id){check(/^[a-f0-9]{64}$/.test(value.Id),'RECOVERED_CID');e.id=value.Id;validateContainer(value,e);state.containers[role]={id:e.id,intent:state.containers[role].intent};save(join(config.output,'owned-'+role+'.json'),{...e,recovered:true});}return validateContainer(value,e);};
  const create=async role=>{const e=expected(role);check((await run('absent-'+role,['container','ls','--all','--filter','name=^/'+e.name+'$','--format','{{.ID}}'])).trim()==='','NAME_COLLISION');const argv=probeCreateArguments(role,e);state.containers[role]={intent:save(join(config.output,'intent-'+role+'.json'),{...e,argv})};const id=(await run('create-'+role,argv)).trim();check(/^[a-f0-9]{64}$/.test(id),'CREATE_CID');state.containers[role].id=id;save(join(config.output,'owned-'+role+'.json'),{...expected(role),recovered:false});await inspect(role);await accounting.add({key:'container:'+id,role,capacityBytes:engineGrant.engine.containerWritableCapacityBytes,meaning:'engine-reported-nonexclusive-writable-bytes'});await run('start-'+role,['start',id]);check((await inspect(role)).State.Running,'START_FAILED');};
  const heartbeat=async(label,deadlineMs=performance.now()+2000)=>{const value=parseHeartbeat(await run('logs-'+label,['logs',state.containers.writer.id],{deadlineMs}));state.heartbeat.push({label,atMs:performance.now(),...value});return value;};
  try {
    owner=await acquireTimingLock(await timingLockDirectory(),{receiptId:config.runId});
    monitor=await startEvidenceMonitor({allocationPath:config.allocation.path,output:config.output,campaignId:config.runId,intervalMs:2000,onAlarm:alarm=>{if(alarm.status!=='PASS')aborter.abort('HOST_STORAGE_UNAVAILABLE');}});
    journal=openSync(join(config.output,'engine-observations.jsonl'),'wx',0o600);
    accounting=createAccounting({observe:async target=>{if(target.key==='image')return observeProbeImageSize(run);await inspect(target.role,true);const e=expected(target.role),value=JSON.parse(await run('container-size',['container','inspect','--size','--format',ENGINE_CONTAINER_FIELDS,e.id],{cleanup:true}));return {bytes:containerSize(value,{id:e.id,name:e.name,runId:config.runId,image:IMAGE}).writableBytes};},retain:record=>{const raw=Buffer.from(JSON.stringify(record)+'\n');writeSync(journal,raw);fsyncSync(journal);},onFailure:error=>aborter.abort('ENGINE_ACCOUNTING_UNAVAILABLE: '+String(error.message))});
    const image=JSON.parse(await run('image-admission',['image','inspect','--format',ENGINE_IMAGE_FIELDS,IMAGE]));check(imageSize(image,IMAGE).reportedBytes===154383912,'IMAGE_SIZE_DIFFERS');
    state.imageLabels=JSON.parse(await run('image-labels',['image','inspect','--format','{{json .Config.Labels}}',IMAGE]));
    await accounting.add({key:'image',capacityBytes:engineGrant.engine.imageReportedCapacityBytes,meaning:'engine-reported-nonexclusive-image-bytes'});
    await create('writer');await create('observer');const initial=await heartbeat('initial');
    quiescence=createToolchainQuiescence({writer:{id:state.containers.writer.id,runId:config.runId,image:IMAGE,user:config.writerUser},kernelObserver:{id:state.containers.observer.id,user:config.observerUser},command:run,retain:trace=>{state.trace.push(trace);save(join(config.output,'coordination-'+state.trace.length+'.json'),trace);},onUncertain:()=>{uncertain=true;}});
    heartbeatMembers(initial,await quiescence.admit());
    await accounting.coordinate(async()=>{state.synchronization=await runCapabilityInterval({quiescence,heartbeat,initial});});
    check(Object.values(globalThis.__storeNetworkCounters.read()).every(n=>n===0),'PARENT_NETWORK_EFFECT');guard();state.status='CAPABILITY_OBSERVED_PENDING_CLEANUP';
  } catch(error) {state.failure=err(error);}
  finally {
    clearTimeout(totalTimer);
    if(quiescence)try{const summary=quiescence.summary();state.quiescenceClosure=needsQuiescenceClosure(summary)?await quiescence.close():{notAdmitted:true,pauseNeverAttempted:true,summary};}catch(error){uncertain=true;state.cleanup.push({operation:'thaw',error:err(error)});}
    // Read thaw while PID1 lives, then close the independent observer first.
    // Host exact-CID wait/inspect proves each container exit; no invented post-init snapshot.
    for(const role of ['observer','writer'])if(state.containers[role])try{
      const value=await inspect(role,true),id=value.Id;
      if(value.State.Paused) {check(role==='writer','UNEXPECTED_OBSERVER_PAUSE');await run('cleanup-unpause-'+role,['unpause',id],{cleanup:true});check(!(await inspect(role,true)).State.Paused,'CLEANUP_STILL_PAUSED');}
      if(value.State.Running)await run('cleanup-kill-'+role,['kill','--signal','KILL',id],{cleanup:true});
      if(value.State.Status!=='created') {const code=(await run('cleanup-wait-'+role,['wait',id],{cleanup:true})).trim(),after=await inspect(role,true);check(/^\d+$/.test(code)&&!after.State.Running&&!after.State.Restarting&&!after.State.Paused&&!after.State.Error&&Number(code)===after.State.ExitCode,'CONTAINER_DRAIN_UNPROVEN');state.cleanup.push({role,id,exitCode:after.State.ExitCode,complete:true});}
      else state.cleanup.push({role,id,neverStarted:true,complete:true});
    }catch(error){uncertain=true;state.cleanup.push({role,error:err(error),complete:false});}
    if(accounting)try{state.engineAccounting=await accounting.finish();}catch(error){state.engineAccounting={status:'FAIL',error:err(error)};}
    if(journal!==null){fsyncSync(journal);closeSync(journal);}
  }
  state.cleanupComplete=!uncertain;state.finishedAt=new Date().toISOString();state.timingLock=owner?{path:owner.path,identity:owner.identity,heldAtReceiptSeal:true}:null;
  if(aborter.signal.aborted)state.failure??={message:String(aborter.signal.reason)};
  const rawPass=state.status==='CAPABILITY_OBSERVED_PENDING_CLEANUP'&&!state.failure&&!uncertain&&state.engineAccounting?.status==='PASS';state.status=rawPass?'CAPABILITY_OBSERVED':'UNAVAILABLE';
  const receipt=save(join(config.output,'receipt.json'),state),final={kind:'local-capability-probe-finalization-1',receipt,status:'UNAVAILABLE',qualification:false,producerExecuted:false,nativeAllocationsTouched:false,timingLockReleased:false};
  try{check(monitor,'HOST_MONITOR_UNAVAILABLE');final.hostAudit=await monitor.finish({receiptPath:receipt.path,outcome:state.status});await retainEvidenceAudit(monitor.reference,config.output);final.hostVerification=await verifyEvidenceAudit(monitor.reference,receipt.path);guard();check(final.hostAudit.status==='PASS'&&final.hostVerification.status==='PASS','HOST_STORAGE_AUDIT_FAILED');if(rawPass)final.status='CAPABILITY_AVAILABLE';}catch(error){final.failure=err(error);}
  if(owner&&!uncertain)try{await owner.release();final.timingLockReleased=true;}catch(error){final.failure??=err(error);}
  if(!final.timingLockReleased||aborter.signal.aborted||final.failure)final.status='UNAVAILABLE';
  process.off('SIGINT',onSignal);process.off('SIGTERM',onSignal);
  const finalization=save(join(config.output,'finalization.json'),final);console.log(JSON.stringify({status:final.status,receipt,finalization,timingLockReleased:final.timingLockReleased}));process.exitCode=final.status==='CAPABILITY_AVAILABLE'?0:1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
