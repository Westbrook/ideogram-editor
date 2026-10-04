import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {PHASES, TIMEOUTS, sealedMemberPath, REQUIRED_SOURCE_PATHS, EXPORT_RESERVE_MS, validateConfig, payloadArgv, phaseBudgetMs, admitJobPhase, successfulChild, childClosureUncertain, nativeSummary, replayDataRecords, monitoredBody} from '../../tooling/rollback-producer/hosted-control.mjs';
import {coverage, workerCanonical, volumeSize} from '../../tooling/rollback-producer/hosted-accounting.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const fixedHash = 'a'.repeat(64);
const ref = path => ({path,bytes:1,sha256:fixedHash});
function config(){
  const root='/opt/ideogram/control', runId='ie-native-'+'a'.repeat(32);
  return {kind:'hosted-native-controller-config-1',runId,controlRoot:root,sources:REQUIRED_SOURCE_PATHS.map(path=>ref(root+'/'+path)),tools:Object.fromEntries(['node','python','git','unshare','setpriv'].map(name=>[name,ref('/opt/tools/'+name)])),owner:{uid:1001,gid:1001,groups:[]},evidenceAllocation:ref(root+'/evidence.json'),dataAllocation:ref(root+'/data.json'),dataRootIdentity:{dev:7,ino:11},onlineNetns:'net:[1234]',setup:ref(root+'/setup.json'),hostSelection:ref(root+'/selection.json'),hostObservation:ref(root+'/observation.json'),hostEnvironment:{PATH:'/usr/bin:/bin',HOME:'/var/lib/setup/home',TMPDIR:'/var/lib/setup/tmp'},input:{remote:'https://github.com/Westbrook/ideogram-editor.git',commit:'850b10cfa4853a14290c7220538f4d6f49ba124d',tree:'769d56f65b15b7c5a420c22ec9160da38b0401ab',manifest:{bytes:12726,sha256:'5b71db1fd6c60980c8297b9fe48922a75c0a4dcaac6f73d6c4c0925a3e921e45'}},producers:Object.fromEntries([16,17,18].map(version=>[version,{seal:ref(root+'/tooling/rollback-producer/schema'+version+'/producer-seal.json')}])),job:{startedEpochMs:1000,deadlineEpochMs:21601000},exportRoot:'/var/lib/exports/'+runId};
}
const goodChild=()=>({code:0,signal:null,timedOut:false,interrupted:false});

test('fixed authority refuses missing runtime closure, unissued inputs and privileged owners',()=>{
  assert.equal(validateConfig(config()).input.commit,'850b10cfa4853a14290c7220538f4d6f49ba124d');
  for(const change of [c=>c.sources.pop(),c=>c.input.commit=null,c=>c.input.remote='https://example.invalid/repo.git',c=>c.owner.uid=0,c=>c.owner.groups=[2,1],c=>c.sources[0].path='/tmp/elsewhere.mjs',c=>c.job.deadlineEpochMs+=1]){
    const value=config();change(value);assert.throws(()=>validateConfig(value));
  }
});
test('fixed offline argv enters a new namespace before exact privilege drop and producer action',()=>{
  const c=config(),normal=payloadArgv(c,'/opt/ideogram/config.json',fixedHash,'build18');
  assert.equal(normal.binary,c.tools.setpriv.path);
  assert.deepEqual(normal.args.slice(0,7),['--reuid=1001','--regid=1001','--clear-groups','--inh-caps=-all','--ambient-caps=-all','--bounding-set=-all','--no-new-privs']);
  const offline=payloadArgv(c,'/opt/ideogram/config.json',fixedHash,'verify18',{draftSha256:fixedHash});
  assert.equal(offline.binary,c.tools.unshare.path);assert.deepEqual(offline.args.slice(0,3),['--net','--',c.tools.setpriv.path]);
  assert.deepEqual(offline.args.slice(-4),['--action','verify18','--draft-sha256',fixedHash]);
  assert.throws(()=>payloadArgv(c,'/config',fixedHash,'verify18'));
  assert.throws(()=>payloadArgv(c,'/config',fixedHash,'bash'));
  assert.throws(()=>payloadArgv(c,'/config',fixedHash,'inputs',{draftSha256:fixedHash}));
  assert.throws(()=>payloadArgv(c,'/config',fixedHash,'collect',{phase:'../../workspaces'}));
  c.owner.groups=[];assert.ok(payloadArgv(c,'/config',fixedHash,'observe').args.includes('--clear-groups'));
});
test('six-hour admission preserves four-hour builds, two-hour restores and export reserve',()=>{
  assert.equal(TIMEOUTS.build18,4*60*60*1000);assert.equal(TIMEOUTS.verify18,2*60*60*1000);assert.equal(EXPORT_RESERVE_MS,30*60*1000);
  for(const phase of PHASES){const c=config(),last=c.job.deadlineEpochMs-phaseBudgetMs(phase)-EXPORT_RESERVE_MS;assert.equal(admitJobPhase(c,phase,last).remainingMs,phaseBudgetMs(phase)+EXPORT_RESERVE_MS);assert.throws(()=>admitJobPhase(c,phase,last+1));}
});
test('root exit alone never changes interrupted, timed-out or unsuccessful child into success',()=>{
  assert.equal(successfulChild(goodChild()),true);
  for(const delta of [{code:1},{signal:'SIGTERM'},{timedOut:true,exitObserved:true},{interrupted:true,exitObserved:true},{error:{message:'spawn failure'}}])assert.equal(successfulChild({...goodChild(),...delta}),false);
});
test('failed spawning actions retain uncertainty without treating helper root exit as descendant proof',()=>{
  for(const action of ['inputs','toolchain','host-check','build16','build17','build18','verify16','verify17','verify18']){
    assert.equal(childClosureUncertain(action,goodChild()),false);
    assert.equal(childClosureUncertain(action,{...goodChild(),code:1}),true);
  }
  for(const action of ['initialize','observe','prepare','recheck','collect','replay']){
    assert.equal(childClosureUncertain(action,{...goodChild(),code:1}),false);
    for(const delta of [{timedOut:true},{interrupted:true},{error:{message:'exceptional closure'}}])assert.equal(childClosureUncertain(action,{...goodChild(),...delta}),true);
  }
});
function lifecycle(overrides={}){const events=[];return {events,args:{startHost:async()=>events.push('host-start'),startData:async()=>events.push('data-start'),body:async()=>events.push('body'),finishData:async()=>{events.push('data-finish');return {status:'PASS'};},finishHost:async()=>{events.push('host-finish');return {status:'PASS'};},release:async()=>{events.push('release');return true;},...overrides}};}
test('ordinary completion closes both monitors before releasing the lease',async()=>{
  const {events,args}=lifecycle();assert.equal((await monitoredBody(args)).effectiveOutcome,'PASS');assert.deepEqual(events,['host-start','data-start','body','data-finish','host-finish','release']);
});
test('partial monitor startup, payload failure and unknown final coverage cannot yield PASS',async()=>{
  for(const key of ['startHost','startData','body']){const {events,args}=lifecycle({[key]:async()=>{throw Error(key);}});const result=await monitoredBody(args);assert.equal(result.effectiveOutcome,'FAIL');assert.equal(result.rawOutcome,'FAIL');assert.ok(events.includes('host-finish'));if(key!=='startHost')assert.ok(events.includes('data-finish'));}
  for(const key of ['finishData','finishHost']){const {args}=lifecycle({[key]:async()=>({status:'INCONCLUSIVE'})});assert.equal((await monitoredBody(args)).effectiveOutcome,'FAIL');}
  const {args}=lifecycle({release:async()=>false});assert.equal((await monitoredBody(args)).effectiveOutcome,'FAIL');
});
test('journal/finalizer failure still attempts the remaining closure and retains failure',async()=>{
  const {events,args}=lifecycle({finishData:async()=>{throw Error('journal fsync failed');}});const result=await monitoredBody(args);assert.equal(result.effectiveOutcome,'FAIL');assert.ok(events.includes('host-finish'));assert.ok(events.includes('release'));assert.match(result.failure.message,/journal/);
});

const workerHash=value=>'sha256:'+hash(workerCanonical(value));
function observation(request){
  const root={dev:7,ino:11,mode:16832,uid:1001,gid:1001,nlink:2,size:4096,blocks:8,mtimeNs:'1',ctimeNs:'1'};
  const body={sequence:0,previous:null,status:'complete',drained:true,startMonotonicUs:10,endMonotonicUs:20,rootBefore:root,rootAfter:root,counts:{entries:1,uniqueInodes:1,directories:1,regularFiles:0,symlinks:0,allocatedBytes:4096,regularLogicalBytes:0,symlinkAllocatedBytes:0},errors:[]};
  return {kind:'capsule-volume-observation-1',policyId:request.policyId,request,requestHash:workerHash(request),bounds:{maxEntries:1000000,maxDepth:128,maxAttempts:3,maxWindowUs:1000000},status:'complete',drained:true,windowStartMonotonicUs:10,windowEndMonotonicUs:20,attempts:[{...body,hash:workerHash(body)}],selectedAttempt:0};
}
function journal({watchdogError=false,watchdogGap=false,backwards=false}={}){
  const worker={kind:'capsule-volume-request-1',mode:'sample',ownerUid:1001,ownerGid:1001,rootIdentity:{dev:7,ino:11},policyId:'capsule-allocated-inodes-1'},request={root:'/data',rootIdentity:worker.rootIdentity,worker},value=observation(worker),lines=[],records=[];let previous=null;
  function add(key,boundary,start){let obs=key==='producer-data'?{bytes:4096,rootIdentity:worker.rootIdentity,result:value,pointInTime:true}:{bytes:0,meaning:'Journal watchdog only; actual host audit owns accounting'};const error=key==='host-journal-watchdog'&&watchdogError?{name:'Error',message:'unknown journal checkpoint'}:null;if(error)obs=null;
    if(key==='producer-data')lines.push({kind:'hosted-native-observation-command-1',root:request.root,rootIdentity:request.rootIdentity,startedMs:start+1,endedMs:backwards?start:start+2,result:goodChild(),failure:null,stdoutBase64:Buffer.from(workerCanonical(value)+'\n').toString('base64'),stderrBase64:''});
    const row={sequence:records.length,previous,key,boundary,startedMs:start,endedMs:start+3,bytes:obs?.bytes??null,observation:obs,error};row.hash=hash(JSON.stringify(row));previous=row.hash;records.push(row);lines.push(row);
  }
  add('host-journal-watchdog','initial',0);add('producer-data','initial',10);add('host-journal-watchdog','final',watchdogGap?5000:100);add('producer-data','final',110);
  const scopes=['host-journal-watchdog','producer-data'].map(key=>({key,...coverage(records.filter(r=>r.key===key),key==='producer-data'?100000:1)}));
  return {lines,request,summary:{status:'PASS',records:records.length,journalHead:previous,scopes}};
}
test('both journal scopes and raw observer intervals are replayed instead of trusting summary PASS',()=>{
  const valid=journal();assert.equal(replayDataRecords(valid.lines,valid.request,100000,valid.summary).status,'PASS');
  for(const options of [{watchdogError:true},{watchdogGap:true},{backwards:true}]){const value=journal(options);assert.throws(()=>replayDataRecords(value.lines,value.request,100000,value.summary));}
  valid.lines[1].stdoutBase64=Buffer.from('{}\n').toString('base64');assert.throws(()=>replayDataRecords(valid.lines,valid.request,100000,valid.summary));
});
test('native accounting summary makes no Docker or physical qualification claim',()=>{
  const value=nativeSummary({status:'PASS',scopes:[],records:2,journalHead:fixedHash,intervalMs:2000,maxSuccessfulStartGapMs:4000,physicalDockerUsageStatus:'UNOBSERVABLE',unobserved:['x']});
  assert.deepEqual(Object.keys(value),['kind','status','scopes','records','journalHead','intervalMs','maxSuccessfulStartGapMs','physicalQualification']);assert.equal(value.physicalQualification,false);
});

test('real schema16 nested maintenance members are admitted while alias/traversal names refuse',async()=>{
  const seal=JSON.parse(await readFile(new URL('../../tooling/rollback-producer/schema16/producer-seal.json',import.meta.url),'utf8'));
  const nested=Object.keys(seal.files).filter(name=>name.startsWith('maintenance-files/server/raster/'));assert.ok(nested.length>0);
  for(const name of Object.keys(seal.files))assert.equal(sealedMemberPath('/opt/control/schema16',name),'/opt/control/schema16/'+name);
  for(const name of ['/absolute','../escape','a/../escape','a/./b','a//b','a/','a\\b','a\u0000b'])assert.throws(()=>sealedMemberPath('/opt/control/schema16',name));
});

// Evaluate the actual authored cBPF instructions over synthetic syscall data;
// this test neither installs a filter nor opens a network/socket connection.
function interpret(rows,{arch=0xc000003e,nr,args=[]}){
  const words=new Map([[0,nr>>>0],[4,arch>>>0]]);args.forEach((value,index)=>{value=BigInt(value);words.set(16+8*index,Number(value&0xffffffffn));words.set(20+8*index,Number((value>>32n)&0xffffffffn));});
  let a=0,pc=0;for(let steps=0;steps<200;steps++){
    assert.ok(pc>=0&&pc<rows.length);const [op,jt,jf,k]=rows[pc++];
    if(op===0x20)a=words.get(k)??0;
    else if(op===0x15)pc+=a===k?jt:jf;
    else if(op===0x35)pc+=a>=k?jt:jf;
    else if(op===0x54)a=(a&k)>>>0;
    else if(op===0x06)return k;
    else assert.fail('Unexpected offline filter opcode');
  }assert.fail('Filter did not terminate');
}
test('actual offline BPF denies sockets/connect/io_uring/x32 and permits only anonymous Unix stream IPC',async()=>{
  const {stdout}=await promisify(execFile)('python3',['-I','-S','-B',fileURLToPath(new URL('../../tooling/rollback-producer/hosted-offline.py',import.meta.url)),'--describe'],{maxBuffer:65536,timeout:10000});
  const value=JSON.parse(stdout),rows=value.instructions;assert.equal(value.policy,'hosted-native-offline-stream-ipc-1');
  const denied=0x50001,allowed=0x7fff0000,killed=0x80000000;
  for(const nr of [41,42,425,426,427])assert.equal(interpret(rows,{nr}),denied);
  for(const nr of [0,1,3,9,39,59,60,231])assert.equal(interpret(rows,{nr}),allowed);
  for(const arch of [0x40000003,0xc00000b7])assert.equal(interpret(rows,{nr:1,arch}),killed);
  for(const nr of [0x40000000,0x40000029,0x40000200])assert.equal(interpret(rows,{nr}),killed);
  for(const type of [1,1|0x800,1|0x80000,1|0x800|0x80000])assert.equal(interpret(rows,{nr:53,args:[1,type,0]}),allowed);
  for(const args of [[1,2,0],[1,5,0],[2,1,0],[40,1,0],[1,1,1],[1,1|0x100,0],[0x100000001n,1,0],[1,0x100000001n,0],[1,1,0x100000000n]])assert.equal(interpret(rows,{nr:53,args}),denied);
});

test('trusted logging endpoints, exact draft closure and fixed failed-build diagnostics remain distinguishable',async()=>{
  const {stdout}=await promisify(execFile)('python3',['-I','-S','-B',fileURLToPath(new URL('./fixtures/hosted-native-controls.py',import.meta.url)),'--controls'],{maxBuffer:65536,timeout:10000});
  assert.deepEqual(JSON.parse(stdout),{descriptorControls:true,draftBeforeVerifySelected:true,failedBuildDiagnosticsSelected:true,workspaceExcluded:true,setupAggregateBinding:true});
});
test('unprivileged Linux kernel installs the exact offline filter and preserves it across fixed exec',{skip:process.platform!=='linux'||process.arch!=='x64'},async()=>{
  const {stdout}=await promisify(execFile)('python3',['-I','-S','-B',fileURLToPath(new URL('./fixtures/hosted-native-controls.py',import.meta.url)),'--smoke'],{maxBuffer:65536,timeout:20000});
  assert.deepEqual(JSON.parse(stdout),{kernelFilterInstalled:true,inheritedExecVerified:false,socketDenials:true,anonymousStreamIPC:true,externalDestinationsUsed:0});
});

// Exercise the real materializer directory helper without Git, network or payload execution.
test('input materialization creates private intermediate parents under ordinary umask and refuses drift',async()=>{
  const {stdout}=await promisify(execFile)('python3',['-I','-S','-B',fileURLToPath(new URL('./fixtures/hosted-native-controls.py',import.meta.url)),'--input-directories'],{maxBuffer:65536,timeout:10000});
  assert.deepEqual(JSON.parse(stdout),{publishedMembers:73,umasks:[18,0,63],privateIntermediates:true,existingMismatchRefusedWithoutRepair:true,aliasesAndSpecialPathsRefused:true,actualMetadataDiagnostic:true});
});

// The Python fixture drives the real scanner with injected time and filesystem
// observations; it never sleeps on wall time or starts a producer.
test('native mutation retries are separated inside the original bounded window and retain refusals',async()=>{
  const {stdout}=await promisify(execFile)('python3',['-I','-S','-B',fileURLToPath(new URL('./fixtures/volume-observer-unit.py',import.meta.url)),fileURLToPath(new URL('../../tooling/rollback-producer/volume_observer.py',import.meta.url))],{maxBuffer:65536,timeout:10000});
  const {delayedObservation,...result}=JSON.parse(stdout);
  assert.deepEqual(result,{tests:24,failures:0,errors:0});
  assert.equal(TIMEOUTS.observe,2000);
  assert.equal(volumeSize(delayedObservation,delayedObservation.request).bytes,4608);
  assert.equal(delayedObservation.selectedAttempt,1);
  assert.equal(delayedObservation.attempts[1].startMonotonicUs-delayedObservation.attempts[0].endMonotonicUs,100000);
  const records=[{boundary:'initial',startedMs:0,endedMs:1,bytes:4608,error:null},{boundary:'periodic',startedMs:1000,endedMs:1100,bytes:null,error:{code:'EVIDENCE_MUTATION'}},{boundary:'final',startedMs:2000,endedMs:2001,bytes:4608,error:null}];
  const retained=coverage(records,100000);assert.equal(retained.status,'INCONCLUSIVE');assert.equal(retained.unknownSamples,1);assert.equal(retained.coverageComplete,false);
});


import {TOOLCHAIN_SCHEDULING, coordinateObservation, admissionGate, verifyCoordination, cgroupHierarchy, authenticateHierarchy, cgroupLocation, eventValues, memberValues, processFields, validateMemberIdentities} from '../../tooling/rollback-producer/hosted-toolchain-freezer.mjs';
function frozenFixture(overrides={}) {
  let now=10,frozen=0;const events=[],ids=[{pid:11,start:'100'}],identity={dev:3,ino:7};
  const scope={identity,ready:async deadline=>{events.push(['ready',deadline]);},write:async(name,value)=>{events.push([name,value]);frozen=Number(value);now+=2;},events:async()=>({populated:1,frozen}),identities:async()=>ids,...overrides};
  return {scope,events,identity,clock:()=>now,advance:n=>now+=n,sleep:async n=>{now+=n;},observe:async({outerDeadlineMs})=>{events.push(['scan',outerDeadlineMs]);now+=20;return {code:0};}};
}
test('toolchain observation charges freeze scan and thaw without changing the scanner or child allowance',async()=>{
  const f=frozenFixture(),value=await coordinateObservation(f.scope,f.observe,f);
  assert.equal(value.error,null);assert.deepEqual(value.value,{code:0});assert.equal(value.trace.policy,TOOLCHAIN_SCHEDULING);
  assert.deepEqual(f.events,[['ready',1010],['cgroup.freeze','1'],['scan',2010],['cgroup.freeze','0']]);
  assert.equal(value.trace.startedMs,10);assert.equal(value.trace.frozenMs,12);assert.equal(value.trace.scanEndedMs,32);assert.equal(value.trace.thawedMs,34);assert.equal(value.trace.endedMs,34);
  const command={startedMs:12,endedMs:32},record={startedMs:9,endedMs:35};assert.equal(verifyCoordination(value.trace,command,record,f.identity),true);
  assert.throws(()=>verifyCoordination(value.trace,command,{...record,endedMs:1011},f.identity),/WINDOW/);
  assert.throws(()=>verifyCoordination(value.trace,command,record,{dev:3,ino:8}),/GROUP/);
});
test('toolchain mutation failure retains original cause and always attempts thaw without another scan',async()=>{
  const f=frozenFixture(),cause=Error('EVIDENCE_MUTATION');let scans=0;
  const value=await coordinateObservation(f.scope,async()=>{scans++;throw cause;},f);
  assert.equal(value.error,cause);assert.equal(scans,1);assert.equal(value.trace.failure.code,'EVIDENCE_MUTATION');assert.deepEqual(f.events.at(-1),['cgroup.freeze','0']);assert.equal(value.trace.cleanupFailure,null);
});
test('toolchain synchronization never accepts oversleep or late complete scan and still requests thaw',async()=>{
  const f=frozenFixture();let scans=0;
  const value=await coordinateObservation(f.scope,async()=>{scans++;f.advance(1001);return {code:0};},f);
  assert.match(value.error.message,/WINDOW/);assert.equal(scans,1);assert.ok(value.trace.endedMs-value.trace.startedMs>1000);assert.deepEqual(f.events.at(-1),['cgroup.freeze','0']);
  const noFreeze=frozenFixture({ready:async()=>{throw Error('FREEZER_WRITER_READY_DEADLINE');}});
  const refused=await coordinateObservation(noFreeze.scope,async()=>{assert.fail('scan must not start');},noFreeze);assert.equal(refused.trace.freezeRequestedMs,null);assert.deepEqual(noFreeze.events,[]);
});
test('toolchain thaw failure is distinct from the original failed scan and has no successful replay',async()=>{
  const f=frozenFixture(),write=f.scope.write,cause=Error('EVIDENCE_MUTATION');f.scope.write=async(name,value)=>{if(value==='0')throw Error('FREEZER_THAW_FAILED');return write(name,value);};
  const value=await coordinateObservation(f.scope,async()=>{throw cause;},f);
  assert.equal(value.error,cause);assert.equal(value.trace.failure.code,'EVIDENCE_MUTATION');assert.equal(value.trace.cleanupFailure.code,'FREEZER_THAW_FAILED');assert.equal(value.trace.thawedMs,null);
  assert.throws(()=>verifyCoordination(value.trace,{},{},f.identity),/FAILURE/);
  const leaked=frozenFixture();const hidden=await coordinateObservation(leaked.scope,async()=>{throw Error('secret /private/path or grant');},leaked);assert.equal(hidden.trace.failure.code,'FREEZER_SYSTEM_ERROR');assert(!JSON.stringify(hidden.trace).includes('/private'));
});
test('toolchain observation refuses membership change and does not substitute empty counts',async()=>{
  const f=frozenFixture();let reads=0;f.scope.identities=async()=>++reads===1?[{pid:11,start:'100'}]:[];
  const value=await coordinateObservation(f.scope,f.observe,f);assert.match(value.error.message,/MEMBERSHIP/);assert.deepEqual(value.trace.members,[{pid:11,start:'100'}]);assert.equal(reads,2);assert.deepEqual(f.events.at(-1),['cgroup.freeze','0']);
});
test('private cgroup discovery and census retain finite fail-closed parsing',()=>{
  const mount='1 0 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n';
  assert.equal(cgroupLocation('0::/job/sub\n',mount),'/sys/fs/cgroup/job/sub');
  for(const [membership,mounts] of [['1:cpu:/job',mount],['0::/job/sub\n',mount+mount],['0::/job/sub\n',mount.replaceAll(' rw',' ro')],['0::/job/../other\n',mount]])assert.throws(()=>cgroupLocation(membership,mounts));
  assert.deepEqual(eventValues('populated 1\nfrozen 0\n'),{populated:1,frozen:0});assert.throws(()=>eventValues('populated 1\nfrozen 0\nfrozen 1\n'));
  assert.deepEqual(memberValues('9\n4\n'),[4,9]);assert.throws(()=>memberValues('9\n9\n'));assert.throws(()=>memberValues(Array.from({length:4097},(_,i)=>i+1).join('\n')));
});
test('actual credential parser distinguishes empty groups, selected children and only the bound trusted stub',()=>{
  const status='Name:\tworker\nUid:\t20000 20000 20000 20000\nGid:\t20000 20000 20000 20000\nGroups:\t\nNStgid:\t11\nCapInh:\t0\nCapPrm:\t0\nCapEff:\t0\nCapBnd:\t0\nCapAmb:\t0\nNoNewPrivs:\t1\n';
  const raw='11 (name with ) chars) S '+process.pid+' 0 11 '+Array(15).fill('0').join(' ')+' 100';
  const row=processFields(11,status,raw),owner={uid:20000,gid:20000,groups:[]},ready={pid:11,start:'100'};
  assert.deepEqual(row.groups,[]);assert.deepEqual(validateMemberIdentities([row],owner,ready),[{pid:11,start:'100'}]);
  for(const change of [x=>x.groups=[1],x=>x.capabilities[0]='1',x=>x.start='101',x=>x.noNewPrivs='0']){const bad=structuredClone(row);change(bad);assert.throws(()=>validateMemberIdentities([bad],owner,ready));}
  const stub={...row,uids:[0,0,0,0],parent:process.pid};assert.deepEqual(validateMemberIdentities([stub],owner,ready),[{pid:11,start:'100'}]);assert.throws(()=>validateMemberIdentities([stub],owner,null));assert.throws(()=>validateMemberIdentities([{...stub,uids:[]}],owner,ready));
});
test('new scheduling records cannot replay through the old-policy path or an unbound group',()=>{
  const value=journal();value.request.scheduling='unreviewed-policy';assert.throws(()=>replayDataRecords(value.lines,value.request,100000,value.summary),/scheduling/);
  const missing=journal();missing.request.scheduling=TOOLCHAIN_SCHEDULING;missing.request.synchronizationGroup={dev:3,ino:7};assert.throws(()=>replayDataRecords(missing.lines,missing.request,100000,missing.summary));
  const old=journal();old.lines.find(x=>x.kind==='hosted-native-observation-command-1').synchronization={policy:TOOLCHAIN_SCHEDULING};assert.throws(()=>replayDataRecords(old.lines,old.request,100000,old.summary),/scheduling/);
});
test('fixed toolchain launch admission and attach-before-exec controls are exercised without a native payload',async t=>{
  const {stdout,stderr}=await promisify(execFile)('python3',['-I','-S','-B',fileURLToPath(new URL('./fixtures/hosted-toolchain-launch-unit.py',import.meta.url)),fileURLToPath(new URL('../../tooling/rollback-producer/hosted-toolchain-launch.py',import.meta.url))],{maxBuffer:65536,timeout:10000});
  assert.deepEqual(JSON.parse(stdout),{tests:10,failures:0,errors:0});t.diagnostic(stderr.trim());
});

test('toolchain admission and observation exclude each other without pausing caller clocks',async()=>{
  let now=0;const wake=[],gate=admissionGate({clock:()=>now,sleep:ms=>{now+=ms;return new Promise(resolve=>wake.push(resolve));}});
  await gate.acquire(100);let admitted=false;const writer=gate.begin(100).then(()=>{admitted=true;});
  await Promise.resolve();assert.equal(admitted,false);assert.equal(now,5);gate.release();wake.shift()();await writer;assert.equal(admitted,true);
  let observing=false;const observation=gate.acquire(100).then(()=>{observing=true;});await Promise.resolve();assert.equal(observing,false);assert.equal(now,10);
  gate.ready();wake.shift()();await observation;assert.equal(observing,true);gate.release();
  await assert.rejects(gate.begin(100,()=>true),/DEADLINE/);
  const late=admissionGate({clock:()=>now,sleep:async ms=>{now+=ms;}});await late.acquire(100);await assert.rejects(late.begin(now+4),/DEADLINE/);assert.equal(now,15);late.release();
});
test('a failed synchronization releases admission exclusion and retains its original budget cost',async()=>{
  const f=frozenFixture();let released=false;f.scope.acquire=async()=>f.advance(1001);f.scope.release=()=>{released=true;};
  const value=await coordinateObservation(f.scope,async()=>{assert.fail('late acquisition cannot scan');},f);
  assert.match(value.error.message,/WINDOW/);assert.equal(released,true);assert.equal(value.trace.freezeRequestedMs,null);assert.equal(value.trace.endedMs-value.trace.startedMs,1001);
});


test('toolchain policy replays exact successful synchronization while retaining sticky failed samples',()=>{
  const value=journal();value.request.scheduling=TOOLCHAIN_SCHEDULING;value.request.synchronizationGroup={dev:3,ino:7};
  for(const command of value.lines.filter(x=>x.kind==='hosted-native-observation-command-1')){
    const start=command.startedMs;
    command.synchronization={policy:TOOLCHAIN_SCHEDULING,groupIdentity:{dev:3,ino:7},startedMs:start-0.9,freezeRequestedMs:start-0.8,frozenMs:start-0.7,scanStartedMs:start-0.6,scanEndedMs:command.endedMs+0.1,thawRequestedMs:command.endedMs+0.2,thawedMs:command.endedMs+0.3,endedMs:command.endedMs+0.4,members:[],frozenEvents:{populated:0,frozen:1},afterScanEvents:{populated:0,frozen:1},thawedEvents:{populated:0,frozen:0},failure:null,cleanupFailure:null};
  }
  assert.equal(replayDataRecords(value.lines,value.request,100000,value.summary).status,'PASS');
  const changed=structuredClone(value);changed.lines[1].synchronization.thawedEvents.frozen=1;assert.throws(()=>replayDataRecords(changed.lines,changed.request,100000,changed.summary),/EVENTS/);
  const failed=journal({watchdogError:true});failed.request=value.request;
  for(const command of failed.lines.filter(x=>x.kind==='hosted-native-observation-command-1'))command.synchronization=structuredClone(value.lines.find(x=>x.kind==='hosted-native-observation-command-1'&&x.startedMs===command.startedMs).synchronization);
  assert.throws(()=>replayDataRecords(failed.lines,failed.request,100000,failed.summary));
});


test('visible cgroup hierarchy refuses hidden roots and all alternate mounts, including nonmatching roots',()=>{
  const mount='1 0 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n';
  assert.deepEqual(cgroupHierarchy('0::/job/sub\n',mount),{parent:'/sys/fs/cgroup/job/sub',mount:'/sys/fs/cgroup',ancestors:['/sys/fs/cgroup/job/sub','/sys/fs/cgroup/job','/sys/fs/cgroup']});
  assert.throws(()=>cgroupHierarchy('0::/job/sub\n',mount.replace('0:1 / ','0:1 /job ')),/HIDDEN/);
  assert.throws(()=>cgroupHierarchy('0::/job/sub\n',mount+'2 0 0:1 /other /else rw - cgroup2 cgroup rw\n'),/AMBIGUOUS/);
  assert.throws(()=>cgroupHierarchy('0::/'+Array(129).fill('nested').join('/')+'\n',mount),/BOUND/);
});
test('nested cgroup admission checks the higher common-ancestor control without repairing permissions',async()=>{
  const layout=cgroupHierarchy('0::/job/sub\n','1 0 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n'),visited=[];
  let permissive=null;
  const inspect=async path=>{visited.push(path);const file=path.endsWith('/cgroup.procs');return {uid:0,mode:(file?0o100600:0o40700)|(path===permissive?0o022:0),dev:3,ino:visited.length,isFile:()=>file,isDirectory:()=>!file};};
  const rows=await authenticateHierarchy(layout,{inspect});assert.equal(rows.length,3);assert.deepEqual(visited,['/sys/fs/cgroup/job/sub','/sys/fs/cgroup/job/sub/cgroup.procs','/sys/fs/cgroup/job','/sys/fs/cgroup/job/cgroup.procs','/sys/fs/cgroup','/sys/fs/cgroup/cgroup.procs']);
  permissive='/sys/fs/cgroup/cgroup.procs';visited.length=0;await assert.rejects(authenticateHierarchy(layout,{inspect}),/ANCESTOR_CONTROL/);assert.equal(visited.at(-1),permissive);
});
