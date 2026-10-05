import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHeartbeat,heartbeatMembers,validateContainer,validateProbeConfig,needsQuiescenceClosure,runCapabilityInterval,boundedLoggedCommand,probeCreateArguments,observeProbeImageSize} from '../../tooling/rollback-producer/local-capability-probe.mjs';
import {requestedImageLabels,projectedContainerLabels,containerImageLabelsMatch,imageLabelArgs} from '../../tooling/rollback-producer/local-image-labels.mjs';
import {createAccounting,ENGINE_IMAGE_FIELDS} from '../../tooling/rollback-producer/local-accounting.mjs';

const image='sha256:2d4f521035336480bf68d7790f242d0abeba90f8116c4443262269ec0d7e8910',runId='ie-linux-'+'a'.repeat(32),id='b'.repeat(64);
const registrations=[{type:'ready',role:'writer',pid:1,parent:0,session:1,startTime:'123'},{type:'ready',role:'descendant',pid:7,parent:1,session:7,startTime:'124'}];
const rows=(count=1)=>[...registrations,...Array.from({length:count},(_,i)=>['writer','descendant'].map(role=>({type:'tick',role,count:i+1}))).flat()];
const encode=value=>value.map(x=>JSON.stringify(x)).join('\n')+'\n';
test('bounded heartbeat registers actual parent and setsid descendant with ordered progress',()=>{
  const heartbeat=parseHeartbeat(encode(rows(3)));assert.deepEqual(heartbeat.ticks,{writer:3,descendant:3});assert.equal(heartbeat.ready.descendant.session,7);
  heartbeatMembers(heartbeat,{members:[{pid:1,parent:0,startTime:'123'},{pid:7,parent:1,startTime:'124'}]});
});
test('heartbeat refuses missing, duplicated, out-of-order, partial and excessive output',()=>{
  for(const invalid of [rows().slice(1),[...rows(),registrations[0]],registrations,[{type:'tick',role:'writer',count:1},...rows()],[...rows(),{type:'tick',role:'writer',count:3}],rows().map(x=>x.role==='descendant'&&x.type==='ready'?{...x,session:1}:x),rows().map(x=>x.type==='ready'?{...x,extra:true}:x)])assert.throws(()=>parseHeartbeat(encode(invalid)));
  assert.throws(()=>parseHeartbeat(encode(rows()).trimEnd()));assert.throws(()=>parseHeartbeat('x'.repeat(512*1024)+'\n'));
});
test('kernel join refuses PID reuse, hidden descendant, foreign member and wrong parent',()=>{
  const heartbeat=parseHeartbeat(encode(rows())),members=[{pid:1,parent:0,startTime:'123'},{pid:7,parent:1,startTime:'124'}];
  for(const bad of [members.slice(0,1),[...members,{pid:8,startTime:'125',parent:1}],members.map(x=>x.pid===7?{...x,startTime:'999'}:x),members.map(x=>x.pid===7?{...x,parent:2}:x)])assert.throws(()=>heartbeatMembers(heartbeat,{members:bad}));
});
function containerFixture(observer=false){
  const expected={id,name:runId+(observer?'-observer':'-writer'),runId,imageLabels:{'org.opencontainers.image.version':'24.04'},user:observer?'65534:65534':'501:20',pidMode:observer?'container:'+'c'.repeat(64):'',cgroupns:observer?'host':'private',source:'/bound/source.py',target:'/inputs/source.py',args:['-I','-S','-B','/inputs/source.py']};
  const value={Id:id,Name:'/'+expected.name,Image:image,Config:{Image:image,Labels:{...expected.imageLabels,'org.ideogram.rollback-run':runId},User:expected.user,Entrypoint:['/usr/bin/python3'],Cmd:expected.args},Path:'/usr/bin/python3',Args:expected.args,HostConfig:{NetworkMode:'none',Privileged:false,ReadonlyRootfs:true,CapDrop:['ALL'],CapAdd:null,SecurityOpt:['no-new-privileges'],PidMode:expected.pidMode,CgroupnsMode:expected.cgroupns,LogConfig:{Type:'json-file',Config:{'max-size':'1m','max-file':'1'}},PidsLimit:16,RestartPolicy:{Name:'no',MaximumRetryCount:0},Devices:[],Binds:null,Tmpfs:null,Mounts:[{Type:'bind',Source:expected.source,Target:expected.target,ReadOnly:true}]},Mounts:[{Type:'bind',Source:'/host_mnt'+expected.source,Destination:expected.target,RW:false}]};
  return {value,expected};
}
test('exact nonroot container admission preserves inherited labels and fixed Desktop mapping',()=>{
  for(const observer of [false,true]){const {value,expected}=containerFixture(observer);assert.equal(validateContainer(value,expected),value);value.HostConfig.Mounts[0].Source='/host_mnt'+expected.source;assert.equal(validateContainer(value,expected),value);}
});
test('creation explicitly binds Desktop image labels and one fresh run override without relying on inheritance',()=>{
  for(const role of ['writer','observer']) {
    const {value,expected}=containerFixture(role==='observer');
    Object.assign(expected.imageLabels,{'desktop.docker.io/ports.scheme':'v2','org.ideogram.rollback-run':'old-owned-run'});
    const original=structuredClone(expected.imageLabels),argv=probeCreateArguments(role,expected),labels=[];
    for(let i=0;i<argv.length;i++)if(argv[i]==='--label'){const raw=argv[++i],split=raw.indexOf('=');labels.push([raw.slice(0,split),raw.slice(split+1)]);}
    assert.equal(labels.length,3);assert.equal(new Set(labels.map(([key])=>key)).size,3);
    assert.deepEqual(Object.fromEntries(labels),{...original,'org.ideogram.rollback-run':runId});assert.deepEqual(expected.imageLabels,original);
    value.Config.Labels=Object.fromEntries(labels);assert.equal(validateContainer(value,expected),value);
    delete value.Config.Labels['desktop.docker.io/ports.scheme'];assert.equal(validateContainer(value,expected),value);
    value.Config.Labels=Object.fromEntries(labels);value.Config.Labels.foreign='unexpected';assert.throws(()=>validateContainer(value,expected));
    value.Config.Labels=Object.fromEntries(labels);value.Config.Labels['desktop.docker.io/ports.scheme']='v3';assert.throws(()=>validateContainer(value,expected));
  }
});
test('only declared Desktop v2 may be omitted or retained; full selected and requested maps stay intact',()=>{
  const imageLabels={'desktop.docker.io/ports.scheme':'v2','org.opencontainers.image.version':'24.04','org.ideogram.rollback-run':'old-run'},overrides={'org.ideogram.rollback-run':runId,'org.ideogram.rollback-attempt':'fresh-attempt'},original=structuredClone(imageLabels);
  const requested=requestedImageLabels(imageLabels,overrides),projected=projectedContainerLabels(imageLabels,overrides);
  assert.equal(requested['desktop.docker.io/ports.scheme'],'v2');assert.equal(Object.hasOwn(projected,'desktop.docker.io/ports.scheme'),false);
  assert.ok(imageLabelArgs(requested).includes('desktop.docker.io/ports.scheme=v2'));
  assert.equal(containerImageLabelsMatch(requested,imageLabels,overrides),true);assert.equal(containerImageLabelsMatch(projected,imageLabels,overrides),true);
  assert.deepEqual(imageLabels,original);assert.equal(requested['desktop.docker.io/ports.scheme'],'v2');
});
test('Desktop normalization refuses changed values, undeclared metadata, unknown keys and omitted ownership/version',()=>{
  const imageLabels={'desktop.docker.io/ports.scheme':'v2','org.opencontainers.image.version':'24.04'},overrides={'org.ideogram.rollback-run':runId,'org.ideogram.rollback-attempt':'fresh-attempt'},actual=requestedImageLabels(imageLabels,overrides);
  assert.equal(containerImageLabelsMatch({...actual,'desktop.docker.io/ports.scheme':'v3'},imageLabels,overrides),false);
  assert.throws(()=>containerImageLabelsMatch(actual,{...imageLabels,'desktop.docker.io/ports.scheme':'v3'},overrides));
  const absent={...imageLabels};delete absent['desktop.docker.io/ports.scheme'];assert.equal(containerImageLabelsMatch(actual,absent,overrides),false);
  for(const key of ['org.ideogram.rollback-run','org.ideogram.rollback-attempt','org.opencontainers.image.version']){const missing={...actual};delete missing[key];assert.equal(containerImageLabelsMatch(missing,imageLabels,overrides),false);}
  for(const key of ['desktop.docker.io/other','desktop.docker.io/ports.scheme.extra','unknown'])assert.equal(containerImageLabelsMatch({...actual,[key]:'v2'},imageLabels,overrides),false);
  assert.throws(()=>requestedImageLabels(imageLabels,{'desktop.docker.io/ports.scheme':'v2'}));
});
test('creation refuses malformed label maps and unbounded command values',()=>{
  const {expected}=containerFixture();
  for(const imageLabels of [[],{'label':42},{'bad=key':'value'},{'label':'x\0y'},{'label':'x'.repeat(4097)},Object.fromEntries(Array.from({length:65},(_,i)=>['label'+i,'value'])),Object.fromEntries(Array.from({length:17},(_,i)=>['label'+i,'x'.repeat(4096)]))])assert.throws(()=>probeCreateArguments('writer',{...expected,imageLabels}));
  assert.throws(()=>probeCreateArguments('foreign',expected));
});
test('container admission refuses changed image, CID, credentials, command and writable authority',()=>{
  const mutations=[v=>v.Id='d'.repeat(64),v=>v.Image='sha256:'+'d'.repeat(64),v=>v.Config.User='0:0',v=>v.Config.Entrypoint=['/bin/sh'],v=>v.HostConfig.NetworkMode='bridge',v=>v.HostConfig.Privileged=true,v=>v.HostConfig.ReadonlyRootfs=false,v=>v.HostConfig.CapAdd=['SYS_PTRACE'],v=>v.HostConfig.PidMode='host',v=>v.HostConfig.CgroupnsMode='private',v=>v.HostConfig.Mounts[0].ReadOnly=false,v=>v.Mounts[0].RW=true,v=>v.Mounts.push({Type:'bind',Source:'/docker.sock'}),v=>v.HostConfig.LogConfig.Config['max-file']='9',v=>v.HostConfig.Binds=['/sys/fs/cgroup:/sys/fs/cgroup:rw'],v=>v.HostConfig.RestartPolicy.Name='always'];
  for(const change of mutations){const {value,expected}=containerFixture(true);change(value);assert.throws(()=>validateContainer(value,expected));}
});
test('configuration admits explicit distinct UID and independent GID under the local scheduler namespace',()=>{
  const config={kind:'local-capability-probe-config-1',runId,writerUser:'501:20',observerUser:'65534:65534',image,docker:{path:'/Applications/Docker.app/Contents/Resources/bin/docker'},dockerHome:'/private/owned-home',node:{path:'/bound/node'}};
  assert.equal(validateProbeConfig(config),config);
  for(const change of [{runId:runId.replace('ie-linux','ie-native')},{writerUser:'0:20'},{observerUser:'501:999'},{writerUser:'501:0'},{writerUser:'501:9007199254740993'},{image:'latest'},{node:{path:'relative'}},{docker:{path:'/usr/local/bin/docker'}}])assert.throws(()=>validateProbeConfig({...config,...change}));
});
test('only never-admitted and never-paused state skips an unnecessary kernel close',()=>{
  assert.equal(needsQuiescenceClosure({admitted:false,needsThaw:false,observations:0}),false);
  for(const summary of [{admitted:true,needsThaw:false,observations:0},{admitted:false,needsThaw:true,observations:0},{admitted:false,needsThaw:false,observations:1}])assert.equal(needsQuiescenceClosure(summary),true);
  assert.throws(()=>needsQuiescenceClosure({}));
});
function intervalFixture({quietAdvance=false,resumeBoth=true,elapsedAfterThaw=50,quietDuration=100,reused=false}={}){
  let now=10;const trace=[],initial=parseHeartbeat(encode(rows())),frozen=parseHeartbeat(encode(rows(2))),quiet=structuredClone(frozen),resumed=parseHeartbeat(encode(rows(3)));
  if(quietAdvance)quiet.ticks.writer++;if(!resumeBoth)resumed.ticks.descendant=2;if(reused)quiet.ready.descendant.startTime='999';
  return {trace,args:{initial,clock:()=>now,wait:async ms=>{assert.equal(ms,100);now+=quietDuration;},quiescence:{observe:async scan=>{trace.push('pause/frozen');now+=100;await scan();trace.push('recheck/thaw');now+=elapsedAfterThaw;}},heartbeat:async(label,deadline)=>{assert.equal(deadline,1010);trace.push(label);return {'frozen-settled':frozen,'frozen-quiet':quiet,resumed}[label];}}};
}
test('frozen baseline absorbs earlier buffered ticks but quiet and both resumed counters share original clock',async()=>{
  const fixture=intervalFixture(),result=await runCapabilityInterval(fixture.args);assert.deepEqual(fixture.trace,['pause/frozen','frozen-settled','frozen-quiet','recheck/thaw','resumed']);assert.equal(result.endedMs-result.startedMs,250);
});
test('quiet advancement, PID replacement, short quiet hold, missing resume or late thaw remain refusal',async()=>{
  for(const options of [{quietAdvance:true},{reused:true},{quietDuration:99},{resumeBoth:false},{elapsedAfterThaw:850}])await assert.rejects(runCapabilityInterval(intervalFixture(options).args));
});
test('kernel or pause failure cannot be transformed into a successful heartbeat-only experiment',async()=>{
  const fixture=intervalFixture();fixture.args.quiescence.observe=async()=>{throw Error('KERNEL_UNAVAILABLE');};await assert.rejects(runCapabilityInterval(fixture.args),/KERNEL_UNAVAILABLE/);assert.deepEqual(fixture.trace,[]);
});
test('unknown child ownership is latched before failed log synchronization and every handle closes',async()=>{
  for(const result of [{timedOut:true,exitObserved:false},{interrupted:true,exitObserved:false}]){
    const trace=[],failure=Error('sync failed');let uncertain=false;
    await assert.rejects(boundedLoggedCommand({openLog:channel=>channel,before:()=>{},execute:async()=>result,onUncertain:()=>{uncertain=true;trace.push('uncertain');},syncLog:handle=>{assert.equal(uncertain,true);trace.push('sync '+handle);if(handle==='out')throw failure;},closeLog:handle=>trace.push('close '+handle)}),error=>error===failure);
    assert.deepEqual(trace,['uncertain','sync out','close out','sync err','close err']);
  }
});
test('partial open or initial receipt failure closes all acquired logs without claiming a child ran',async()=>{
  for(const failedStage of ['open','before']){
    const failure=Error(failedStage),trace=[];
    await assert.rejects(boundedLoggedCommand({openLog:channel=>{if(failedStage==='open'&&channel==='err')throw failure;trace.push('open '+channel);return channel;},before:()=>{throw failure;},execute:()=>assert.fail('child must not launch'),onUncertain:()=>assert.fail('no child launched'),syncLog:handle=>{trace.push('sync '+handle);throw Error('later sync error');},closeLog:handle=>{trace.push('close '+handle);if(handle==='out')throw Error('later close error');}}),error=>error===failure);
    assert.deepEqual(trace,failedStage==='open'?['open out','sync out','close out']:['open out','open err','sync out','close out','sync err','close err']);
  }
});
test('child exception stays primary through close failures and observed exits do not invent uncertainty',async()=>{
  const primary=Error('child failed'),trace=[];
  await assert.rejects(boundedLoggedCommand({openLog:channel=>channel,before:()=>{},execute:async()=>{throw primary;},onUncertain:()=>trace.push('uncertain'),syncLog:()=>{},closeLog:handle=>{trace.push('close '+handle);throw Error('secondary close error');}}),error=>error===primary);
  assert.deepEqual(trace,['uncertain','close out','close err']);
  const result={timedOut:true,exitObserved:true};assert.equal(await boundedLoggedCommand({openLog:channel=>channel,before:()=>{},execute:async()=>result,onUncertain:()=>assert.fail('actual exit observed'),syncLog:()=>{},closeLog:()=>{}}),result);
});
test('fixed image accounting still observes after abort without clearing the original failed campaign',async()=>{
  const aborter=new AbortController(),primary=Error('original coordination failure'),records=[],calls=[];let time=0;
  const accounting=createAccounting({observe:()=>observeProbeImageSize(async(label,argv,options)=>{
    if(aborter.signal.aborted&&!options.cleanup)throw Error('ordinary command refused after abort');
    assert.equal(label,'image-size');assert.deepEqual(argv,['image','inspect','--format',ENGINE_IMAGE_FIELDS,image]);assert.deepEqual(options,{cleanup:true});calls.push({aborted:aborter.signal.aborted});
    return JSON.stringify({Id:image,Os:'linux',Architecture:'arm64',Size:154383912});
  }),retain:record=>records.push(record),onFailure:error=>aborter.abort(error),clock:()=>++time,schedule:()=>1,cancel:()=>{}});
  await accounting.add({key:'image',capacityBytes:4*1024**3,meaning:'nonexclusive image bytes'});
  await assert.rejects(accounting.coordinate(async()=>{throw primary;}),error=>error===primary);
  const result=await accounting.finish();
  assert.deepEqual(calls,[{aborted:false},{aborted:true}]);assert.equal(aborter.signal.reason,primary);assert.equal(result.status,'FAIL');assert.equal(result.scopes[0].unknownSamples,0);assert.equal(records.at(-1).boundary,'final');
});
test('cleanup-authorized image reads still refuse changed identity and propagate observation failure',async()=>{
  await assert.rejects(observeProbeImageSize(async()=>JSON.stringify({Id:'sha256:'+'f'.repeat(64),Os:'linux',Architecture:'arm64',Size:154383912})),/identity/);
  const failure=Error('bounded image observation expired');await assert.rejects(observeProbeImageSize(async()=>{throw failure;}),error=>error===failure);
});
