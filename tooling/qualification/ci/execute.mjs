#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {openSync,writeSync,closeSync} from 'node:fs';
import {readFile, writeFile, mkdir, readdir, lstat, realpath, copyFile} from 'node:fs/promises';
import {resolve, join, dirname, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateCiPlan, workflowExport, executionState, digest, sha256} from './plan.mjs';
import {verifyInputs, verifyImmutablePlan} from './run.mjs';
import {evaluatePaired} from './regression.mjs';
import {loadApprovedMain,createBaselinePacket} from './baseline.mjs';
import {sanitize} from '../campaigns/common.mjs';
import {sourceIdentity, executionEnvironment} from '../core.mjs';
import {verifyCampaignReceipt} from '../campaigns/run.mjs';
import {observeHost} from '../campaigns/host.mjs';
import {boundedChild} from '../container/bounded-child.mjs';
import {fileManifest, hashFile, verifyManifest} from '../developer-campaigns/common.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const json = value => JSON.stringify(value, null, 2) + '\n';
const assert = (value, message) => {if (!value) throw Error(message);};
const safePath = path => typeof path === 'string' && path && !isAbsolute(path) && !path.includes('\\') && path.split('/').every(part => part && part !== '.' && part !== '..');
async function readJSON(path) {return JSON.parse(await readFile(path, 'utf8'));}
async function clockPoint(side) {
  if(side!=='C')return null;
  return {kind:'same-host-monotonic-1',nanoseconds:String(process.hrtime.bigint()),boot:sha256(await readFile('/proc/sys/kernel/random/boot_id')),at:new Date().toISOString()};
}
async function save(path, value) {await mkdir(dirname(path), {recursive:true,mode:0o700}); await writeFile(path, json(value), {flag:'wx',mode:0o600});}
const receivedStage = (received,key) => join(received,`stage-${key}`);
async function loggedChild(executable,args,options,directory,name) {
  await mkdir(directory,{recursive:true,mode:0o700});
  const out=join(directory,`${name}.stdout.log`),err=join(directory,`${name}.stderr.log`),controller=new AbortController();
  const external=options.abortSignal,relay=()=>controller.abort(external.reason);
  let stdout,stderr,result,writeError;
  const append=fd=>chunk=>{
    if(writeError)return;
    try {const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);let offset=0;while(offset<bytes.length){const count=writeSync(fd,bytes,offset,bytes.length-offset);if(count<=0)throw Error('Controller log write made no progress');offset+=count;}}
    catch(error){writeError=error;controller.abort('Controller log write failed: '+String(error));}
  };
  external?.addEventListener('abort',relay,{once:true});if(external?.aborted)relay();
  try {
    // Synchronous bounded-chunk writes apply disk backpressure without an
    // unhandled stream error or an unbounded in-memory log queue.
    stdout=openSync(out,'wx',0o600);stderr=openSync(err,'wx',0o600);
    result=await boundedChild(executable,args,{...options,abortSignal:controller.signal,onStdout:append(stdout),onStderr:append(stderr)});
  }finally {
    external?.removeEventListener('abort',relay);
    for(const fd of [stdout,stderr])if(fd!==undefined)try{closeSync(fd);}catch(error){writeError??=error;}
  }
  if(writeError)throw Error('Controller log failed after owned child cleanup: '+String(writeError));
  return {...result,stdout:{path:out,...await hashFile(out)},stderr:{path:err,...await hashFile(err)}};
}
async function copySealed(source, target, identity) {
  const observed = await hashFile(source);
  assert(observed.sha256 === identity.sha256 && observed.bytes === identity.bytes, 'Changed transferred bytes: ' + source);
  await mkdir(dirname(target), {recursive:true,mode:0o700}); await copyFile(source,target);
  const copied = await hashFile(target); assert(digest(copied) === digest(observed),'Transferred bytes changed');
}
export function sessionFor(plan, node) {
  const explicit = node.stage.match(/^(q3-(?:base|candidate)-i0-(?:normal|cold))-/);
  if (explicit) return explicit[1];
  if (node.campaign === 'Q3' && plan.affectedQ3.jobs.includes('I0')) return `q3-${node.role}-i0-cold`;
  return `p-${node.role}`;
}
export function derivedConfiguration(plan, node, base, handoff = null, auditReceipts = null) {
  assert(typeof base.developerStateRoot === 'string' && isAbsolute(base.developerStateRoot) && resolve(base.developerStateRoot) === base.developerStateRoot, 'CI base configuration needs canonical developerStateRoot');
  assert(!Object.hasOwn(base,'auditReceipts'),'CI audit receipts are derived only from verified predecessors');
  assert(!Object.hasOwn(base,'ciHandoff'), 'CI handoff is derived only from the matching predecessor');
  const result = {...base, developerStateDirectory:join(base.developerStateRoot, plan.digest, `${node.side}-${sessionFor(plan,node)}`)};
  if (handoff) result.ciHandoff = handoff;
  if(auditReceipts){assert(expectedAuditJobs(node).length>0,'Unexpected audit receipts for node');result.auditReceipts=auditReceipts;}
  return result;
}
export function expectedAuditJobs(node) {return node.job==='AC3'?['AC1','AC2']:node.job==='AH3'?['AH1','AH2']:[];}
async function auditInputs(plan,node,receipts,received,currentOutput) {
  const inputs=[];
  for(const job of expectedAuditJobs(node)) {
    const prior=plan.nodes.find(value=>value.stage===node.stage&&value.job===job);
    assert(prior&&receipts[prior.id],'Missing verified adapter audit predecessor');
    const folder=prior.stage===node.stage?currentOutput:receivedStage(received,prior.stage),path=join(folder,'nodes',prior.id,'receipt.json');
    inputs.push({nodeId:prior.id,job,path,sha256:(await hashFile(path)).sha256});
  }
  return inputs.length?inputs:null;
}
async function verifyAuditInputs(plan,node,entry,receipts,received,artifactRoot) {
  const expected=await auditInputs(plan,node,receipts,received,artifactRoot),actual=entry.auditReceipts??null;
  assert((expected===null)===(actual===null),'Missing or unexpected audit predecessor inputs');
  if(expected)assert(Array.isArray(actual)&&actual.length===expected.length&&actual.every((value,index)=>isAbsolute(value.path)&&value.nodeId===expected[index].nodeId&&value.job===expected[index].job&&value.sha256===expected[index].sha256),'Adapter audit input differs from retained verified predecessor');
}
export function executedCommand(node, subject, configuration) {
  assert(isAbsolute(subject) && isAbsolute(configuration), 'Execution paths must be absolute');
  const command = [...node.command], index = command.indexOf('--configuration');
  assert(index > 0, 'Planned configuration argument missing'); command[index+1] = configuration;
  command.push('--repo', subject); return command;
}
export function c2Observation(receipt) {
  const attempts=(receipt?.groups??[]).filter(group=>group.cell?.id==='C2/production-build').flatMap(group=>group.attempts??[]).filter(attempt=>!attempt.prime);
  assert(attempts.length===1&&attempts[0].status==='PASS'&&attempts[0].result?.observations?.status==='completed','Missing unique verified completed C2 observation');
  return attempts[0].result.observations;
}
export function validateC2Transfer(packet,stage,expectedNode,actualReceipt) {
  assert(packet.kind==='ci-c2-transfer-1'&&packet.nodeId===expectedNode.id&&digest(packet.source)===digest(expectedNode.source),'Wrong C2 predecessor');
  assert(stage.stage==='production-build'&&stage.status==='completed'&&stage.source?.head===expectedNode.source.commit&&stage.source?.digest===expectedNode.source.digest,'C2 stage source/outcome mismatch');
  assert(digest(sanitize(stage))===digest(c2Observation(actualReceipt)),'Transferred C2 differs from verified runtime observation');
  assert(Array.isArray(packet.files)&&packet.files.every(file=>safePath(file.path))&&new Set(packet.files.map(file=>file.path)).size===packet.files.length,'Unsafe or duplicate C2 transfer paths');
  const member=path=>{assert(safePath(path),'Unsafe C2 metadata path');const file=packet.files.find(file=>file.path===path);assert(file,'C2 metadata not sealed in packet');return file;};
  member(packet.c2Path);
  const provenance=member(packet.buildProvenancePath);
  assert(provenance.sha256===stage.buildProvenance.sha256&&provenance.bytes===stage.buildProvenance.bytes,'C2 provenance differs from observed build');
  const files=stage.artifacts.files.map(file=>({...file,path:'dist/'+file.path}));
  assert(digest(files)===digest(packet.artifacts.files)&&packet.artifacts.sha256===sha256(json(files)),'C2 file set mismatch');
  for(const file of files)assert(digest(member(file.path))===digest(file),'C2 artifact differs from observed build');
  const logs=stage.commands.flatMap(command=>['stdout','stderr'].map(stream=>command[stream]));
  assert(Array.isArray(packet.receiptLogs)&&packet.receiptLogs.length===logs.length,'Incomplete C2 command logs');
  for(const [index,log] of logs.entries()) {
    const mapped=packet.receiptLogs[index],file=member(mapped.path);
    assert(mapped.originalPath===log.path&&mapped.bytes===log.bytes&&mapped.sha256===log.sha256&&file.bytes===log.bytes&&file.sha256===log.sha256,'C2 command log differs from observed build');
  }
  assert(packet.files.length===files.length+logs.length+2,'Unexpected unbound C2 transfer file');
  return packet;
}
async function verifyCopiedHandoff(path,expectedNode,actualReceipt) {
  const packet=await readJSON(path),directory=dirname(path);
  assert(safePath(packet.c2Path),'Unsafe C2 receipt path');
  assert(Array.isArray(packet.files)&&packet.files.every(file=>safePath(file.path)),'Unsafe C2 transfer paths');
  await verifyManifest(directory,packet.files);
  return validateC2Transfer(packet,await readJSON(join(directory,packet.c2Path)),expectedNode,actualReceipt);
}
async function makeHandoff(plan,stage,received,directory,receipts) {
  if(!stage.artifactFrom)return null;
  const prior=plan.nodes.find(node=>node.id===stage.artifactFrom),transfer=join(receivedStage(received,prior.stage),'handoff','transfer.json');
  const packet=await verifyCopiedHandoff(transfer,prior,receipts[prior.id]),folder=dirname(transfer);
  const manifest={kind:'ci-c2-artifact-1',source:{commit:prior.source.commit,digest:prior.source.digest},root:folder,
    c2:{receiptPath:join(folder,packet.c2Path),...await hashFile(join(folder,packet.c2Path))},artifacts:packet.artifacts,
    buildProvenance:{path:join(folder,packet.buildProvenancePath),...await hashFile(join(folder,packet.buildProvenancePath))},
    receiptLogs:packet.receiptLogs.map(entry=>({...entry,path:join(folder,entry.path)}))};
  const path=join(directory,'ci-handoff.json');await save(path,manifest);
  return {manifestPath:path,sha256:(await hashFile(path)).sha256};
}
async function packC2(plan,node,configuration,output,actualReceipt) {
  const envelope=await readJSON(join(configuration.developerStateDirectory,'bridge-state.json'));
  assert(envelope.kind==='developer-runtime-state-1'&&sha256(json(envelope.state))===envelope.sha256,'Invalid bridge state');
  const state=envelope.state;
  assert(state.p&&!state.p.failure&&!state.p.active&&state.p.completed.includes('production-build'),'C2 developer state is incomplete or interrupted');
  let c2;
  for(const record of state.p.receipts) {
    const value=await readJSON(record.path);
    if(value.stage==='production-build'){assert(!c2,'Duplicate C2 stage');c2={record,value};}
  }
  assert(c2?.value.status==='completed'&&digest(sanitize(c2.value))===digest(c2Observation(actualReceipt)),'Mutable C2 state differs from verified runtime observation');
  const folder=join(output,'handoff');await mkdir(folder,{mode:0o700});
  await copySealed(c2.record.path,join(folder,'c2-stage.json'),c2.record);
  const provenance=c2.value.buildProvenance;await copySealed(provenance.path,join(folder,'build-provenance.json'),provenance);
  const files=c2.value.artifacts.files.map(file=>({...file,path:'dist/'+file.path}));
  for(const file of files){assert(safePath(file.path)&&file.path.startsWith('dist/'),'Unsafe product path');await copySealed(join(state.p.source,file.path),join(folder,file.path),file);}
  const receiptLogs=[];
  for(const [index,command] of c2.value.commands.entries())for(const stream of ['stdout','stderr']) {
    const log=command[stream],path=`build-logs/${index}-${stream}.log`;
    await copySealed(log.path,join(folder,path),log);receiptLogs.push({originalPath:log.path,path,bytes:log.bytes,sha256:log.sha256});
  }
  const packet={kind:'ci-c2-transfer-1',nodeId:node.id,source:node.source,c2Path:'c2-stage.json',buildProvenancePath:'build-provenance.json',
    artifacts:{files,sha256:sha256(json(files))},receiptLogs,files:await fileManifest(folder)};
  validateC2Transfer(packet,c2.value,node,actualReceipt);await save(join(folder,'transfer.json'),packet);
}
async function subjectCheckout(plan,node,workspace) {
  const path=join(workspace,`subject-${node.role}`);
  if (!await lstat(path).then(()=>true,()=>false)) {
    const result=spawnSync('git',['worktree','add','--detach',path,node.source.commit],{cwd:root,encoding:'utf8',env:{PATH:process.env.PATH,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}});
    assert(result.status===0,'Cannot create exact subject worktree: '+result.stderr);
  }
  const current=sourceIdentity(path); assert(current.head===node.source.commit&&current.digest===node.source.digest,'Subject checkout differs from immutable plan');
  return realpath(path);
}
export function controllerOutcome(entry) {
  return ['provisioning','execution'].every(key=>entry[key]?.code===0&&!entry[key].signal&&!entry[key].timedOut&&!entry[key].interrupted)?'PASS':'FAIL';
}
async function verifyControllerLogs(entry,artifactRoot) {
  for(const [key,name] of [['provisioning','provision'],['execution','execute']])for(const stream of ['stdout','stderr']) {
    const identity=entry[key]?.[stream];assert(identity,'Missing controller log identity');
    const observed=await hashFile(join(artifactRoot,'controller-logs',`${entry.nodeId}-${name}.${stream}.log`));
    assert(observed.bytes===identity.bytes&&observed.sha256===identity.sha256,'Changed controller log');
  }
}
async function retainedNode(plan,node,entry,artifactRoot,received=dirname(artifactRoot),receipts={},configurations=null) {
  assert(entry.nodeId===node.id&&entry.planDigest===plan.digest,'Wrong CI node entry');
  await verifyControllerLogs(entry,artifactRoot);
  assert(safePath(entry.configurationFile)&&safePath(entry.receiptFile),'Unsafe retained node path');
  const baseBytes=configurations?configurations.get(node.inputs.configuration.path):await readFile(node.inputs.configuration.path);
  assert(baseBytes&&sha256(baseBytes)===node.inputs.configuration.sha256,'Original configuration bytes differ');
  const base=JSON.parse(baseBytes),config=await readJSON(join(artifactRoot,entry.configurationFile));
  assert(digest(config)===digest(derivedConfiguration(plan,node,base,entry.handoff,entry.auditReceipts??null)),'Unexpected effective configuration override');
  await verifyAuditInputs(plan,node,entry,receipts,received,artifactRoot);
  if(entry.handoff) {
    const stage=plan.stages.find(value=>value.key===node.stage), prior=plan.nodes.find(value=>value.id===stage.artifactFrom);
    assert(prior,'Unexpected handoff outside H preparation stage');
    const transferPath=join(receivedStage(received,prior.stage),'handoff','transfer.json');
    const transfer=await verifyCopiedHandoff(transferPath,prior,receipts[prior.id]),packet=await readJSON(join(artifactRoot,'ci-handoff.json'));
    assert(sha256(await readFile(join(artifactRoot,'ci-handoff.json')))===entry.handoff.sha256,'Changed local handoff manifest');
    assert(packet.source.commit===prior.source.commit&&packet.source.digest===prior.source.digest&&digest(packet.artifacts)===digest(transfer.artifacts),'Handoff differs from predecessor product');
    for(const [field,path] of [['c2',transfer.c2Path],['buildProvenance',transfer.buildProvenancePath]]) {
      const identity=await hashFile(join(dirname(transferPath),path));assert(packet[field].sha256===identity.sha256&&packet[field].bytes===identity.bytes,'Handoff receipt identity differs');
    }
  }
  assert(entry.command && digest(entry.command)===digest(executedCommand(node,entry.subject,entry.configurationPath)),'CI execution argv differs from allowed derivation');
  const receiptPath=join(artifactRoot,entry.receiptFile), receipt=await readJSON(receiptPath);
  assert(digest(receipt.argv.slice(2))===digest(entry.command.slice(2)),'Child runtime argv mismatch');
  assert(receipt.subjectRepo===entry.subject,'Child subject path differs');
  for(const point of ['before','after']) assert(receipt.identity[point].head===node.source.commit&&receipt.identity[point].digest===node.source.digest&&digest(receipt.identity[point].files)===node.source.digest,'Executed source drift');
  for(const point of ['controlBefore','controlAfter']) assert(receipt.identity[point].head===plan.spec.control.commit&&receipt.identity[point].digest===plan.spec.control.digest,'Control harness drift');
  assert(receipt.plan.campaign===node.campaign&&receipt.plan.features===plan.spec.features&&receipt.plan.cache===node.cache&&digest(receipt.plan.selectedJobIds)===digest(node.jobs),'Child job selection differs');
  for(const key of ['hostAttestation','fixtureManifest']) assert(receipt.inputIdentities?.[key]?.sha256==='sha256:'+node.inputs[key].sha256,'Consumed input differs');
  assert(receipt.inputIdentities?.configuration?.sha256==='sha256:'+sha256(await readFile(join(artifactRoot,entry.configurationFile))),'Effective configuration bytes differ');
  assert(receipt.host.observed.hostnameHash===node.physicalHostId,'Executed on wrong physical host');
  const status=await verifyCampaignReceipt(receiptPath);receipts[node.id]=receipt;
  return {kind:'ci-qualification-node-observation-1',planDigest:plan.digest,nodeId:node.id,source:node.source,side:node.side,physicalHostId:node.physicalHostId,
    inputs:node.inputs,command:node.command,output:node.output,receiptSha256:(await hashFile(receiptPath)).sha256,
    startedAt:receipt.startedAt,finishedAt:receipt.finishedAt,outcome:controllerOutcome(entry)==='FAIL'?'FAIL':status.status};
}
export async function verifyStages(plan,received,{configurations=null}={}) {
  const observations=[],records=[],failures=[],childReceiptsByNodeId={};
  let outerFailed=false,outerIncomplete=false;
  for(const stage of plan.stages) {
    const folder=receivedStage(received,stage.key),path=join(folder,'stage.json');
    if(!await lstat(path).then(()=>true,()=>false))continue;
    try {
      const record=await readJSON(path);assert(record.planDigest===plan.digest&&record.stage===stage.key,'Wrong stage artifact');records.push(record);
      assert(['PASS','FAIL','INTERRUPTED','running'].includes(record.status),'Unknown outer stage status');
      if(record.status==='FAIL'||record.status==='INTERRUPTED')outerFailed=true;
      else if(record.status!=='PASS')outerIncomplete=true;
      assert(Array.isArray(record.nodes)&&record.nodes.length<=stage.nodeIds.length&&record.nodes.every((entry,index)=>entry.nodeId===stage.nodeIds[index]),'Stage node membership/order differs');
      if(record.status==='PASS')assert(record.nodes.length===stage.nodeIds.length&&!record.failure&&!record.interruption,'Passing stage is incomplete or failed');
      for(const entry of record.nodes)observations.push(await retainedNode(plan,plan.nodes.find(node=>node.id===entry.nodeId),entry,folder,received,childReceiptsByNodeId,configurations));
    }catch(error){outerFailed=true;failures.push({stage:stage.key,reason:String(error)});}
  }
  let state;
  try{state=executionState(plan,observations);}catch(error){outerFailed=true;failures.push({reason:String(error)});state={kind:'ci-qualification-state-1',planDigest:plan.digest,qualification:false,outcome:'FAIL'};}
  if(outerFailed)state.outcome='FAIL';else if(outerIncomplete)state.outcome='INCONCLUSIVE';
  return {observations,records,childReceiptsByNodeId,failures,state};
}
// Completion callbacks execute on the same physical C host after both C/H
// predecessors. Their overhead remains inside the observed pipeline bound; no
// H clock is subtracted from a C clock and no child durations are summed.
export function pipelineBoundaries(plan,records,finalClock) {
  const validClock=value=>value?.kind==='same-host-monotonic-1'&&typeof value.boot==='string'&&/^[a-f0-9]{64}$/.test(value.boot)&&typeof value.nanoseconds==='string'&&/^(?:0|[1-9][0-9]*)$/.test(value.nanoseconds)&&typeof value.at==='string'&&Number.isFinite(Date.parse(value.at));
  const ancestors=key=>{const out=new Set();const visit=value=>{for(const dependency of plan.stages.find(stage=>stage.key===value).dependencies){if(out.has(dependency))continue;out.add(dependency);visit(dependency);}};visit(key);return out;};
  return plan.boundaries.map(boundary=>{
    const samples=boundary.starts.map(start=>{
      const first=plan.nodes.find(node=>node.id===start.nodeIds[0]),record=records.find(value=>value.stage===first.stage),begin=record?.nodes.find(value=>value.nodeId===first.id)?.pipelineStart;
      const callbacks=records.filter(value=>plan.stages.find(stage=>stage.key===value.stage)?.side==='C'&&validClock(value.clock)&&start.terminalStages.every(terminal=>ancestors(value.stage).has(terminal))).map(value=>value.clock);
      const end=callbacks.sort((a,b)=>BigInt(a.nanoseconds)<BigInt(b.nanoseconds)?-1:1)[0]??finalClock;
      if(first?.side!=='C'||!validClock(begin)||!validClock(end)||begin.boot!==end.boot)return {cache:start.cache,status:'INCONCLUSIVE',reason:'Missing valid same-boot C pipeline boundary'};
      const elapsedMs=Number(BigInt(end.nanoseconds)-BigInt(begin.nanoseconds))/1e6;
      return {cache:start.cache,status:elapsedMs>=0?'PASS':'INCONCLUSIVE',elapsedMs,begin,end,method:'C monotonic start through first acknowledged C/H completion callback, including callback/receipt overhead'};
    });
    const elapsedMs=samples.every(sample=>sample.status==='PASS')?samples.reduce((sum,sample)=>sum+sample.elapsedMs,0):null;
    return {id:boundary.id,samples,elapsedMs,targetMs:boundary.targetMs,ceilingMs:boundary.ceilingMs,status:elapsedMs===null?'INCONCLUSIVE':elapsedMs>boundary.ceilingMs?'FAIL':'PASS',targetMiss:elapsedMs!==null&&elapsedMs>boundary.targetMs};
  });
}
/** Per-revision D08 samples retain real C-host boundaries. Pair ceilings are
 * checked separately; neither child sums nor half a pair are measurements. */
export function pipelineComparisonSamples(plan,records,finalClock) {
  const definitions=[];
  for(const role of ['base','candidate']) {
    for(const [prefix,scope,job] of [['p-','P-core','C0'],['a-','P-adapters','AC0']]) {
      const stage=`${prefix}${role}-prepareC`,node=plan.nodes.find(node=>node.stage===stage&&node.job===job);
      if(node)definitions.push({role,scope,cache:node.cache,nodeIds:[node.id],terminalStages:[`${prefix}${role}-${scope==='P-core'?'restC':'C'}`,`${prefix}${role}-H`]});
    }
    const i0=plan.boundaries.find(row=>row.id===`q3-${role}-I0`);
    if(i0)for(const start of i0.starts)definitions.push({...start,role,scope:'Q3-I0'});
  }
  return definitions.map((definition,index)=>{
    const boundary={id:`relative-${index}`,starts:[definition],targetMs:Number.MAX_SAFE_INTEGER,ceilingMs:Number.MAX_SAFE_INTEGER};
    const sample=pipelineBoundaries({...plan,boundaries:[boundary]},records,finalClock)[0].samples[0];
    return {scope:definition.scope,role:definition.role,cache:definition.cache,status:sample.status,elapsedMs:sample.elapsedMs??null,
      begin:sample.begin??null,end:sample.end??null,physicalHostId:plan.spec.inputs.C.physicalHostId,source:plan.spec[definition.role]};
  });
}
async function runStage(plan,stageKey,received,workspace,output,signal) {
  const stage=workflowExport(plan).stages[stageKey]; assert(stage,'Unknown stage');
  await verifyInputs(plan.spec.inputs);
  const prior=await verifyStages(plan,received), observed=await observeHost();
  assert(prior.state.outcome!=='FAIL','Retained predecessor stage/controller verification failed');
  assert(observed.hostnameHash===stage.physicalHostId,'Stage is not on its assigned physical runner');
  for(const id of plan.nodes.find(node=>node.id===stage.nodeIds[0]).dependencies) assert(prior.observations.some(value=>value.nodeId===id&&value.outcome==='PASS'),'Missing successful stage predecessor');
  await mkdir(output,{recursive:false,mode:0o700}); await mkdir(workspace,{recursive:true,mode:0o700});
  const record={kind:'ci-qualification-stage-1',planDigest:plan.digest,stage:stageKey,clock:await clockPoint(stage.side),startedAt:new Date().toISOString(),status:'running',nodes:[]};
  const persist=()=>writeFile(join(output,'stage.json'),json(record));
  await persist();
  try {
    const handoff=await makeHandoff(plan,stage,received,output,prior.childReceiptsByNodeId);
    for(const id of stage.nodeIds) {
      signal?.throwIfAborted();
      const node=plan.nodes.find(value=>value.id===id), subject=await subjectCheckout(plan,node,workspace);
      const auditReceipts=await auditInputs(plan,node,prior.childReceiptsByNodeId,received,output);
      const configuration=derivedConfiguration(plan,node,await readJSON(node.inputs.configuration.path),handoff,auditReceipts);
      await mkdir(dirname(configuration.developerStateDirectory),{recursive:true,mode:0o700});
      const configurationFile=`configurations/${id}.json`, configurationPath=join(output,configurationFile); await save(configurationPath,configuration);
      const command=executedCommand(node,subject,configurationPath), entry={nodeId:id,planDigest:plan.digest,subject,configurationFile,configurationPath,command,handoff,auditReceipts,receiptFile:`nodes/${id}/receipt.json`};
      record.nodes.push(entry); await persist();
      // Toolchain provisioning is explicit V work. Application installs/builds
      // remain inside C/H developer phases, never copied between hosts.
      const provision=await loggedChild('python3',[join(subject,'tooling/bootstrap-toolchain.py')],{cwd:subject,env:executionEnvironment(process.env,join(root,'.toolchain/bin'),output),timeoutMs:600000,abortSignal:signal},join(output,'controller-logs'),`${id}-provision`);
      entry.provisioning={...provision}; await persist(); assert(provision.code===0,'Pinned subject toolchain provisioning failed');
      if(node.job==='C0'||node.job==='AC0')entry.pipelineStart=await clockPoint(node.side);
      await persist();
      const execution=await loggedChild(process.execPath,[join(root,command[1]),...command.slice(2)],{cwd:subject,env:executionEnvironment(process.env,join(subject,'.toolchain/bin'),output),timeoutMs:24*60*60*1000,abortSignal:signal},join(output,'controller-logs'),`${id}-execute`);
      entry.execution=execution;
      const actualOutput=resolve(subject,node.output), receipt=await readJSON(join(actualOutput,'receipt.json'));
      const retained=join(output,'nodes',id); await mkdir(retained,{recursive:true,mode:0o700});
      for(const file of receipt.evidence) {assert(safePath(file.path),'Unsafe evidence path'); await copySealed(join(actualOutput,file.path),join(retained,file.path),{bytes:file.bytes,sha256:file.sha256.replace(/^sha256:/,'')});}
      await copySealed(join(actualOutput,'receipt.json'),join(retained,'receipt.json'),await hashFile(join(actualOutput,'receipt.json')));
      entry.outcome=(await retainedNode(plan,node,entry,output,received,prior.childReceiptsByNodeId)).outcome; await persist();
      assert(execution.code===0&&entry.outcome==='PASS','Required node failed or is inconclusive: '+id);
      if(node.job==='C2') await packC2(plan,node,configuration,output,prior.childReceiptsByNodeId[node.id]);
    }
    signal?.throwIfAborted();record.status='PASS';
  } catch(error) {record.status=signal?.aborted?'INTERRUPTED':'FAIL';record.failure=String(error);if(signal?.aborted)record.interruption=String(signal.reason);throw error;}
  finally {record.finishedAt=new Date().toISOString();await persist();}
}
export async function runCiExecution(args,signal) {
  args=[...args];
  const mode=args.shift(), options={}; assert(['stage','verify','outputs','fetch-inputs','pack-baseline'].includes(mode),'Use stage, verify, outputs, fetch-inputs or pack-baseline');
  const allowed=new Set(['plan','stage','received','workspace','output','disposition']);
  for(let i=0;i<args.length;i+=2) {assert(/^--[a-z-]+$/.test(args[i])&&allowed.has(args[i].slice(2))&&args[i+1]&&!Object.hasOwn(options,args[i].slice(2)),'Invalid CI execution options');options[args[i].slice(2)]=args[i+1];}
  const plan=validateCiPlan(await readJSON(resolve(options.plan)));
  const control=sourceIdentity(root);assert(control.head===plan.spec.control.commit&&control.digest===plan.spec.control.digest,'Executing control harness differs from protected immutable plan');
  if(mode==='fetch-inputs') {
    const revisions=[plan.spec.control.commit,plan.spec.candidate.commit,plan.spec.base?.commit,plan.spec.approvedMain?.source.commit].filter(Boolean);
    for(const revision of new Set(revisions)){signal?.throwIfAborted();const result=await loggedChild('git',['fetch','--no-tags','origin',revision],{cwd:root,env:{PATH:process.env.PATH,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},timeoutMs:600000,abortSignal:signal},join(dirname(resolve(options.plan)),'source-fetch'),revision);assert(result.code===0&&!result.timedOut&&!result.interrupted&&!result.signal,'Cannot fetch selected immutable revision: '+revision);}
    verifyImmutablePlan(root,plan);return;
  }
  verifyImmutablePlan(root,plan);
  if(mode==='pack-baseline'){console.log(json(await createBaselinePacket({plan,received:resolve(options.received),dispositionPath:resolve(options.disposition),output:resolve(options.output),repository:root,verifyStages,pipelineBoundaries,pipelineComparisonSamples})));return;}
  if(mode==='outputs') {
    const workflow=workflowExport(plan); assert(workflow.layers.length<=24,'CI workflow layer capacity must be amended');
    const lines=['candidate='+plan.spec.candidate.commit,'control='+plan.spec.control.commit];
    for(let i=0;i<24;i++) lines.push(`layer${String(i).padStart(2,'0')}=`+JSON.stringify({include:(workflow.layers[i]??[]).map(key=>({stage:key,runnerLabels:workflow.stages[key].runnerLabels}))}));
    await writeFile(process.env.GITHUB_OUTPUT,lines.join('\n')+'\n',{flag:'a'}); return;
  }
  if(mode==='stage') return runStage(plan,options.stage,resolve(options.received),resolve(options.workspace),resolve(options.output),signal);
  await verifyInputs(plan.spec.inputs);
  const result=await verifyStages(plan,resolve(options.received)), host=await observeHost();
  assert(host.hostnameHash===plan.spec.inputs.C.physicalHostId,'Final boundary acknowledgement requires the same C host');
  const boundaryAcknowledgement={physicalHostId:host.hostnameHash,clock:await clockPoint('C')};
  const boundaries=pipelineBoundaries(plan,result.records,boundaryAcknowledgement.clock),pipelineSamples=pipelineComparisonSamples(plan,result.records,boundaryAcknowledgement.clock);
  let approvedMain=null,approvedMainError=null;
  try{approvedMain=await loadApprovedMain(plan.spec.approvedMain,{repository:root,verifyStages,pipelineBoundaries,pipelineComparisonSamples});}catch(error){approvedMainError=String(error);}
  const relative=evaluatePaired(plan,result.childReceiptsByNodeId,{approvedMain,pipelineSamples});
  if(approvedMainError){relative.latestApprovedMain={outcome:'FAIL',reason:approvedMainError};relative.outcome='FAIL';}
  const relativeComplete=relative.outcome==='PASS'||plan.spec.purpose==='initial-baseline'&&relative.outcome==='NOT_APPLICABLE';
  const state={...result.state,boundaries,pipelineSamples,boundaryAcknowledgement,relative,controllerFailures:result.failures,automatedOutcome:result.state.outcome==='FAIL'||relative.outcome==='FAIL'||boundaries.some(value=>value.status==='FAIL')?'FAIL':(relative.outcome==='BLOCKED'||relative.freshBaseOutcome==='BLOCKED'||relative.latestApprovedMain?.outcome==='BLOCKED')?'BLOCKED':result.state.outcome==='COMMANDS_COMPLETE'&&relativeComplete&&boundaries.every(value=>value.status==='PASS')?'PASS':'INCONCLUSIVE',
    scope:plan.spec.purpose==='initial-baseline'?'Executed candidate-only initial Q3 jobs and absolute pipeline bounds. No invented historical relative comparison. Queue/provisioning totals, target-miss disposition, manual/native/live and release acceptance remain separate.':'Executed selected automated jobs, fresh-base and protected-controller-selected approved-main relative checks, and conservative pipeline bounds. Queue/provisioning totals, target-miss disposition, manual/native/live and release acceptance remain separate.'};
  console.log(json(state));if(options.output)await save(resolve(options.output),state);
  process.exitCode=state.automatedOutcome==='PASS'?0:state.automatedOutcome==='FAIL'?1:2;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const controller=new AbortController(),interrupt=()=>controller.abort('SIGINT'),terminate=()=>controller.abort('SIGTERM');
  process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);
  try {await runCiExecution(process.argv.slice(2),controller.signal);}
  catch(error){console.error(error.message);process.exitCode=controller.signal.aborted?(controller.signal.reason==='SIGINT'?130:143):1;}
  finally {process.off('SIGINT',interrupt);process.off('SIGTERM',terminate);}
}
