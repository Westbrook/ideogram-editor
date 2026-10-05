import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {PHASES,roleNames,containerLabels,containerLabelArgs,expectedContainerLabels,initializerCommand,activeCommand,checkContainer,checkMounts,projectedMounts,validateLocalConfig,validateCapabilityEvidence,bootstrapPayloadArgs,bootstrapLaunch,BOOTSTRAP_MARKER,BOOTSTRAP_READY_MS,successfulChild,childClosureUncertain,settleChild,closeLogHandles,drainOwnedContainer,linkCancellation} from '../../tooling/rollback-producer/local-control.mjs';

const runId='ie-linux-'+'a'.repeat(32),attemptId='attempt-'+'b'.repeat(32),id='c'.repeat(64),image='sha256:'+'d'.repeat(64),names=roleNames(runId,attemptId);
const volume={Type:'volume',Source:names.volume,Destination:'/capsule',RW:true,Subpath:attemptId};
const mountRequest=mount=>({Type:mount.Type,Source:mount.Source,Target:mount.Destination,ReadOnly:!mount.RW,...(mount.Type==='volume'?{VolumeOptions:{NoCopy:true,...(mount.Subpath?{Subpath:mount.Subpath}:{})}}:{})});
function fixture(role='build'){
  const mounts=role==='kernel'?[{Type:'bind',Source:'/bound/kernel.py',Destination:'/inputs/local-cgroup-observer.py',RW:false}]:[{...volume,...(role==='observer'?{RW:false,Subpath:''}:{})}];
  const imageLabels={'desktop.docker.io/ports.scheme':'v2','org.opencontainers.image.version':'24.04'};
  const command=activeCommand(role,501,20),expected={runId,attemptId,name:names[role],imageLabels,labels:expectedContainerLabels(imageLabels,runId,attemptId),image,imageId:image,user:role==='kernel'?'502:20':'501:20',id,mounts,writerId:'e'.repeat(64)};
  return {expected,value:{Id:id,Name:'/'+names[role],Labels:{...expected.labels},Privileged:false,ConfigImage:image,Image:image,User:expected.user,Network:role==='build'?'bridge':'none',Readonly:true,CapDrop:['ALL'],SecurityOpt:['no-new-privileges'],PidMode:role==='kernel'?'container:'+expected.writerId:'',CgroupnsMode:role==='kernel'?'host':'private',ConfigEntrypoint:command.entrypoint,ConfigCmd:command.cmd,Path:command.path,Args:command.args,Mounts:mounts.map(m=>({...m,...(m.Type==='volume'?{Name:m.Source,Source:'/engine/volume'}:{})})),HostConfigMounts:mounts.map(mountRequest)}};
}
test('create labels explicitly preserve Docker Desktop metadata and replace only current run and attempt identities',()=>{
  const original={'desktop.docker.io/ports.scheme':'v2','org.opencontainers.image.version':'24.04','org.ideogram.rollback-run':'ie-linux-'+'f'.repeat(32),'org.ideogram.rollback-attempt':'attempt-'+'e'.repeat(32)};
  const before=structuredClone(original),args=containerLabelArgs(original,runId,attemptId),labels={};
  for(let i=0;i<args.length;i+=2){assert.equal(args[i],'--label');const split=args[i+1].indexOf('=');const key=args[i+1].slice(0,split);assert.equal(Object.hasOwn(labels,key),false);labels[key]=args[i+1].slice(split+1);}
  assert.deepEqual(labels,{'desktop.docker.io/ports.scheme':'v2','org.ideogram.rollback-attempt':attemptId,'org.ideogram.rollback-run':runId,'org.opencontainers.image.version':'24.04'});
  assert.deepEqual(original,before);
  for(const value of [[],{'bad=key':'x'},{key:1},{key:'\0'}])assert.throws(()=>containerLabelArgs(value,runId,attemptId));
  assert.deepEqual(containerLabels(null,runId,attemptId),{'org.ideogram.rollback-run':runId,'org.ideogram.rollback-attempt':attemptId});
});
test('actual Desktop inspect representation accepts only known v2 metadata omission',()=>{
  const {value,expected}=fixture('observer');
  assert.equal(Object.hasOwn(value.Labels,'desktop.docker.io/ports.scheme'),false);
  assert.equal(containerLabels({'desktop.docker.io/ports.scheme':'v2'},runId,attemptId)['desktop.docker.io/ports.scheme'],'v2');
  assert.equal(checkContainer(value,'observer',expected),value);
  const visible={...value,Labels:{...value.Labels,'desktop.docker.io/ports.scheme':'v2'}};assert.equal(checkContainer(visible,'observer',expected),visible);
  for(const key of ['org.ideogram.rollback-run','org.ideogram.rollback-attempt','org.opencontainers.image.version']){
    const missing={...value.Labels};delete missing[key];
    const message=key==='org.ideogram.rollback-run'?'Container ownership identity differs':'Exact selected image/run/attempt labels differ';
    assert.throws(()=>checkContainer({...value,Labels:missing},'observer',expected),{message});
  }
  assert.throws(()=>checkContainer({...value,Labels:{...value.Labels,other:'x'}},'observer',expected),/labels differ/);
  assert.throws(()=>checkContainer({...value,Labels:{...value.Labels,'desktop.docker.io/ports.scheme':'v3'}},'observer',expected),/labels differ/);
  assert.throws(()=>expectedContainerLabels({'desktop.docker.io/ports.scheme':'v3'},runId,attemptId));
  const unknown=expectedContainerLabels({'another.desktop/key':'v2'},runId,attemptId);assert.equal(unknown['another.desktop/key'],'v2');
});
test('successor keeps original volume while naming every new process for the fresh attempt',()=>{
  assert.equal(names.volume,runId+'-capsule');assert.equal(names.build,runId+'-'+attemptId+'-build');
  assert.deepEqual(PHASES,['bootstrap','observe','tests','build16','build17','build18','verify16','verify17','verify18']);
  for(const attempt of ['', '../old','attempt-'+'b'.repeat(31),attemptId+'\n'])assert.throws(()=>roleNames(runId,attempt));
});
test('fresh initializer cannot target an old tree, reuse a directory or recursively change owners',()=>{
  const value=initializerCommand(attemptId,501,20);assert.deepEqual(value.args.slice(-3),[attemptId,'501','20']);
  assert.match(value.args[2],/mkdir --/);assert.doesNotMatch(value.args[2],/mkdir -p|chown -R|chmod|rm /);
  for(const values of [['toolchain',501,20],[attemptId,0,20],[attemptId,501,0]])assert.throws(()=>initializerCommand(...values));
});
test('source-bound explicit entrypoints avoid the retained inherited shell-command defect',()=>{
  for(const role of ['build','verify','observer','kernel']){const {value,expected}=fixture(role);assert.equal(checkContainer(value,role,expected),value);assert.throws(()=>checkContainer({...value,ConfigEntrypoint:['/bin/sh']},role,expected));}
});
test('whole-volume writable substitution and hidden additional mounts refuse',()=>{
  const {value,expected}=fixture();assert.equal(checkMounts(value.Mounts,value.HostConfigMounts,expected.mounts),value.Mounts);
  const request=structuredClone(value.HostConfigMounts);delete request[0].VolumeOptions.Subpath;
  assert.throws(()=>checkMounts(value.Mounts,request,expected.mounts));
  assert.throws(()=>checkContainer({...value,Mounts:[...value.Mounts,{Type:'bind',Source:'/docker.sock',Destination:'/socket',RW:true}]},'build',expected));
  assert.deepEqual(projectedMounts([volume]),[{type:'volume',source:names.volume,destination:'/capsule',rw:true,subpath:attemptId}]);
});
test('Desktop mapping admits only exact host path or its fixed VM prefix in both arrays',()=>{
  const wanted=[{Type:'bind',Source:'/bound/input',Destination:'/inputs/input',RW:false}],requested=wanted.map(mountRequest),actual=[{...wanted[0],Source:'/host_mnt/bound/input'}];
  requested[0].Source='/host_mnt/bound/input';assert.equal(checkMounts(actual,requested,wanted),actual);
  for(const source of ['/host_mnt/other','/host_mnt/host_mnt/bound/input'])assert.throws(()=>checkMounts([{...actual[0],Source:source}],requested,wanted));
});
test('kernel observer must share only the exact writer PID namespace; ordinary observer stays private',()=>{
  const {value,expected}=fixture('kernel');
  for(const extra of [{PidMode:'host'},{PidMode:'container:'+'f'.repeat(64)},{CgroupnsMode:'private'},{User:'0:0'},{Privileged:true},{CapDrop:[]}])assert.throws(()=>checkContainer({...value,...extra},'kernel',expected));
  const ordinary=fixture('observer');assert.throws(()=>checkContainer({...ordinary.value,PidMode:value.PidMode},'observer',ordinary.expected));
});
test('configuration binds fresh host allocation leaf and distinct nonroot kernel identity',()=>{
  const config={kind:'local-linux-controller-config-1',runId,attemptId,ownerUid:501,ownerGid:20,kernelObserverUid:502,kernelObserverGid:20,allocation:{root:'/evidence'},runRoot:'/evidence/'+attemptId,dockerDesktopMountMapping:{context:'desktop-linux',bindSourcePrefix:'/host_mnt'}};
  assert.equal(validateLocalConfig(config),config);
  for(const change of [{runRoot:'/evidence/run-02'},{kernelObserverUid:501},{kernelObserverUid:0},{dockerDesktopMountMapping:{context:'other',bindSourcePrefix:'/host_mnt'}}])assert.throws(()=>validateLocalConfig({...config,...change}));
});
test('bootstrap wrapper accepts no arbitrary executable or root identity',()=>{
  const args=bootstrapPayloadArgs(id,501,20);assert.equal(args[5],id);assert.equal(args.at(-1),"printf '%s\\n' IDEOGRAM_LOCAL_BOOTSTRAP_READY_1; exec /usr/bin/python3 -I -S -B /capsule/toolchain/tooling/bootstrap-toolchain.py");
  assert.throws(()=>bootstrapPayloadArgs('name',501,20));assert.throws(()=>bootstrapPayloadArgs(id,0,20));
});
test('ready handshake releases admission while the original child completion remains pending',async()=>{
  let deliver,finish;const cleared=[];
  const launch=bootstrapLaunch({start:callback=>{deliver=callback;return new Promise(resolve=>{finish=resolve;});},abort:()=>assert.fail(),schedule:(_cb,ms)=>{assert.equal(ms,BOOTSTRAP_READY_MS);return 7;},cancel:id=>cleared.push(id)});
  await Promise.resolve();deliver(BOOTSTRAP_MARKER);await launch.ready;assert.deepEqual(cleared,[7]);
  let done=false;launch.completion.then(()=>{done=true;});await Promise.resolve();assert.equal(done,false);finish('closed');assert.equal(await launch.completion,'closed');
});
test('wrong or missing new-command marker cannot admit a launch',async()=>{
  for(const line of [null,'prior logs '+BOOTSTRAP_MARKER]){
    const launch=bootstrapLaunch({start:async callback=>{if(line!==null)callback(line);},abort:()=>assert.fail(),schedule:()=>1,cancel:()=>{}});
    await assert.rejects(launch.ready,/handshake/);await launch.completion.catch(()=>{});
  }
});
test('delayed readiness aborts but does not pretend child drainage has completed',async()=>{
  let expire,finish;const aborted=[];
  const launch=bootstrapLaunch({start:()=>new Promise(resolve=>{finish=resolve;}),abort:value=>aborted.push(value),schedule:callback=>{expire=callback;return 1;},cancel:()=>{}});
  await Promise.resolve();expire();await assert.rejects(launch.ready,/two seconds/);assert.equal(aborted.length,1);
  let closed=false;launch.completion.then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);finish();await launch.completion;
});
test('cleanup signals only authenticated full CID and retains stop failures',async()=>{
  const calls=[];let inspections=0;
  const value=await drainOwnedContainer('build',{inspect:async()=>({Id:id,State:{Running:inspections++===0,Restarting:false,ExitCode:137,Error:''}}),docker:async(label,args)=>{calls.push(args);if(label.startsWith('stop'))throw Error('stop timeout');return label.startsWith('wait')?'137':id;}});
  assert.equal(value.stopFailure.message,'stop timeout');assert.deepEqual(calls,[['stop','--time','10',id],['kill','--signal','KILL',id],['wait',id]]);
});
test('interrupted zero exit remains unsuccessful and cleanup cancellation stays separate',()=>{
  assert.equal(successfulChild({code:0,signal:null,interrupted:true,exitObserved:true}),false);
  const parent=new AbortController();parent.abort('signal');const work=new AbortController(),cleanup=new AbortController();linkCancellation(parent.signal,work);linkCancellation(parent.signal,cleanup,true);assert.equal(work.signal.aborted,true);assert.equal(cleanup.signal.aborted,false);
});
test('maintained local scanner exactly preserves the failed local scanner policy bytes',async()=>{
  const raw=await readFile(new URL('../../tooling/rollback-producer/local-volume-observer.py',import.meta.url));
  assert.equal(createHash('sha256').update(raw).digest('hex'),'11fc540c7e0151c534d23d94962677c5bf63a0ebc79260aad57b9c865e55d5bc');
});
test('bootstrap admission requires actually audited capability for the exact candidate and source',()=>{
  const flags={qualification:false,producerExecuted:false,nativeAllocationsTouched:false},ref={path:'/bound/source',bytes:1,sha256:'a'.repeat(64)};
  const final={...flags,kind:'local-capability-probe-finalization-1',status:'CAPABILITY_AVAILABLE',hostAudit:{status:'PASS'},hostVerification:{status:'PASS'},timingLockReleased:true};
  const probeRunId='ie-linux-'+'e'.repeat(32);
  const receipt={...flags,runId:probeRunId,kind:'local-capability-probe-receipt-1',status:'CAPABILITY_OBSERVED',cleanupComplete:true,engineAccounting:{status:'PASS'},containers:{writer:{id},observer:{id:'f'.repeat(64)}},cleanup:[{role:'writer',id,complete:true,exitCode:143},{role:'observer',id:'f'.repeat(64),complete:true,exitCode:143}],sources:[ref]};
  const expected={runId,image,writerUser:'501:20',observerUser:'65534:65534',sources:[ref]},config={kind:'local-capability-probe-config-1',...expected,runId:probeRunId};
  assert.equal(validateCapabilityEvidence(final,receipt,config,expected),receipt);
  assert.throws(()=>validateCapabilityEvidence({...final,timingLockReleased:false},receipt,config,expected));
  assert.throws(()=>validateCapabilityEvidence(final,{...receipt,sources:[]},config,expected));
  assert.throws(()=>validateCapabilityEvidence(final,receipt,{...config,observerUser:'501:20'},expected));
  assert.throws(()=>validateCapabilityEvidence(final,{...receipt,cleanupComplete:false},config,expected));
  assert.throws(()=>validateCapabilityEvidence(final,{...receipt,runId},config,expected));
  assert.throws(()=>validateCapabilityEvidence(final,receipt,{...config,runId:'name'},expected));
});
test('unknown process closure latches before a failing log finalizer can mask the child result',async()=>{
  const calls=[];
  await assert.rejects(settleChild(async()=>({code:0,timedOut:true,exitObserved:false}),()=>calls.push('uncertain'),async()=>{calls.push('finalize');throw Error('disk full');}),/disk full/);
  assert.deepEqual(calls,['uncertain','finalize']);
  assert.equal(childClosureUncertain({code:0,interrupted:true,exitObserved:true}),false);
  await assert.rejects(settleChild(async()=>{throw Error('spawn unknown');},()=>{},async()=>{throw Error('secondary write error');}),/spawn unknown/);
});
test('every owned log handle closes despite failed synchronization or an earlier close error',async()=>{
  const calls=[];
  await assert.rejects(closeLogHandles([
    {sync:async()=>{calls.push('sync1');throw Error('primary');},close:async()=>{calls.push('close1');throw Error('close');}},
    {sync:async()=>calls.push('sync2'),close:async()=>calls.push('close2')},
  ]),/primary/);
  assert.deepEqual(calls,['sync1','close1','sync2','close2']);
});
