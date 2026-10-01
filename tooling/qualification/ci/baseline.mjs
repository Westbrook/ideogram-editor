import {readFile, readdir} from 'node:fs/promises';
import {dirname, join, resolve, basename} from 'node:path';
import {validateCiPlan, digest, sha256} from './plan.mjs';
import {verifyImmutablePlan} from './run.mjs';
import {fileManifest, hashFile, verifyManifest, safeRelative} from '../developer-campaigns/common.mjs';

const assert=(value,message)=>{if(!value)throw Error(message);};
const same=(left,right)=>digest(left)===digest(right);
function identity(file) {
  assert(file&&Number.isSafeInteger(file.bytes)&&file.bytes>=0&&/^[a-f0-9]{64}$/.test(file.sha256??''),'Malformed approved baseline file identity');
  safeRelative(file.path);return file;
}

/** A protected controller selects these exact packet bytes and source. Neither
 * packet approval flags nor a prior outer PASS establish that selection. */
export function validateBaselinePacket(packet,descriptor) {
  assert(packet?.kind==='ci-approved-main-baseline-1','Unsupported approved baseline packet');
  const plan=validateCiPlan(packet.plan);
  assert(same(plan.spec.candidate,descriptor.source),'Approved baseline source differs from protected selection');
  assert(Array.isArray(packet.files)&&packet.files.length>0,'Approved baseline packet needs an exact file closure');
  const files=new Map(packet.files.map(file=>{identity(file);return [file.path,file];}));
  assert(files.size===packet.files.length,'Duplicate approved baseline file');
  const member=path=>{safeRelative(path);assert(files.has(path),'Unsealed approved baseline reference: '+path);return files.get(path);};
  safeRelative(packet.received);member(packet.disposition);
  assert(Array.isArray(packet.inputs),'Missing original baseline input bytes');
  const expected=Object.values(plan.spec.inputs).flatMap(side=>['hostAttestation','fixtureManifest','configuration'].map(key=>side[key]));
  const unique=[...new Map(expected.map(value=>[value.path,value])).values()];
  assert(packet.inputs.length===unique.length&&new Set(packet.inputs.map(value=>value.originalPath)).size===unique.length,'Baseline input mapping is incomplete or duplicated');
  for(const original of unique) {
    const input=packet.inputs.find(value=>value.originalPath===original.path),file=input&&member(input.path);
    assert(file&&file.sha256===original.sha256&&input.sha256===file.sha256&&input.bytes===file.bytes,'Original baseline input seal differs');
  }
  for(const stage of plan.stages)member(`${packet.received}/stage-${stage.key}/stage.json`);
  return plan;
}

export function validateBaselineDisposition(plan,disposition,result,boundaries,pipelineSamples) {
  assert(disposition?.kind==='ci-qualification-state-1'&&disposition.planDigest===plan.digest,'Wrong original baseline disposition');
  assert(disposition.boundaryAcknowledgement?.physicalHostId===plan.spec.inputs.C.physicalHostId,'Baseline final callback has no matching C identity');
  assert(result.state.outcome==='COMMANDS_COMPLETE'&&result.failures.length===0,'Approved baseline has incomplete or failed absolute child/controller gates');
  assert(Object.keys(result.childReceiptsByNodeId).length===plan.nodes.length,'Approved baseline raw child inventory is incomplete');
  assert(boundaries.length===plan.boundaries.length&&boundaries.every(row=>row.status==='PASS'),'Approved baseline absolute pipeline boundaries are incomplete or failed');
  assert(same(disposition.boundaries,boundaries),'Original baseline boundaries cannot be reproduced');
  assert(Array.isArray(pipelineSamples)&&pipelineSamples.length>0&&pipelineSamples.every(sample=>sample.status==='PASS')&&same(disposition.pipelineSamples,pipelineSamples),'Original per-revision pipeline samples cannot be reproduced');
  return true;
}

export async function loadApprovedMain(descriptor,{repository,verifyStages,pipelineBoundaries,pipelineComparisonSamples}) {
  if(!descriptor)return null;
  const path=resolve(descriptor.packet.path),sealed=await hashFile(path),bytes=await readFile(path);
  assert(sealed.sha256===descriptor.packet.sha256&&sha256(bytes)===descriptor.packet.sha256,'Protected approved-main packet hash differs');
  const packet=JSON.parse(bytes),directory=dirname(path),plan=validateBaselinePacket(packet,descriptor);
  verifyImmutablePlan(repository,plan);
  // The complete packet is relocatable. Historical absolute paths are labels;
  // no baseline config/receipt is read from an old machine or private root.
  const actual=await fileManifest(directory,{exclude:[basename(path)]});
  const sorted=rows=>[...rows].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  assert(same(sorted(actual),sorted(packet.files)),'Approved baseline on-disk file closure differs');
  await verifyManifest(directory,packet.files);
  const configurations=new Map();
  for(const input of packet.inputs)configurations.set(input.originalPath,await readFile(join(directory,input.path)));
  const received=join(directory,packet.received);
  const expectedFolders=plan.stages.map(stage=>'stage-'+stage.key).sort();
  assert(same((await readdir(received)).sort(),expectedFolders),'Approved baseline stage directory inventory differs');
  const result=await verifyStages(plan,received,{configurations}),disposition=JSON.parse(await readFile(join(directory,packet.disposition),'utf8'));
  const boundaries=pipelineBoundaries(plan,result.records,disposition.boundaryAcknowledgement?.clock),pipelineSamples=pipelineComparisonSamples(plan,result.records,disposition.boundaryAcknowledgement?.clock);
  validateBaselineDisposition(plan,disposition,result,boundaries,pipelineSamples);
  await verifyManifest(directory,packet.files);
  assert((await hashFile(path)).sha256===descriptor.packet.sha256,'Approved baseline packet changed during verification');
  return {packetSha256:descriptor.packet.sha256,plan,pipelineSamples,childReceiptsByNodeId:result.childReceiptsByNodeId,
    absoluteEvidence:{source:plan.spec.candidate,boundaries,children:plan.nodes.length,approvalAuthority:'Protected controller pinned packet hash and source; no packet approval flag is used'}};
}

/** Packages observed absolute evidence for later human review. Creating a
 * packet never selects it as the approved/latest baseline. */
export async function createBaselinePacket({plan,received,dispositionPath,output,repository,verifyStages,pipelineBoundaries,pipelineComparisonSamples}) {
  const {mkdir,copyFile,writeFile}=await import('node:fs/promises');
  const disposition=JSON.parse(await readFile(dispositionPath,'utf8')),result=await verifyStages(plan,received);
  validateBaselineDisposition(plan,disposition,result,pipelineBoundaries(plan,result.records,disposition.boundaryAcknowledgement?.clock),pipelineComparisonSamples(plan,result.records,disposition.boundaryAcknowledgement?.clock));
  await mkdir(output,{recursive:false,mode:0o700});
  const copy=async(from,path,expected)=>{
    const observed=await hashFile(from);assert(same(observed,{bytes:expected.bytes,sha256:expected.sha256}),'Baseline input changed before packaging');
    const target=join(output,path);await mkdir(dirname(target),{recursive:true,mode:0o700});await copyFile(from,target);
    assert(same(await hashFile(target),observed),'Baseline copied bytes differ');
  };
  for(const stage of plan.stages) {
    const folder='stage-'+stage.key,directory=join(received,folder);
    for(const file of await fileManifest(directory))await copy(join(directory,file.path),`received/${folder}/${file.path}`,file);
  }
  await copy(dispositionPath,'disposition.json',await hashFile(dispositionPath));
  const inputs=[];
  for(const [side,values] of Object.entries(plan.spec.inputs))for(const key of ['hostAttestation','fixtureManifest','configuration']) {
    const original=values[key];if(inputs.some(input=>input.originalPath===original.path))continue;
    const observed=await hashFile(original.path);assert(observed.sha256===original.sha256,'Original baseline input changed before packaging');
    const path=`inputs/${side}-${key}.json`;await copy(original.path,path,observed);inputs.push({originalPath:original.path,path,...observed});
  }
  const packet={kind:'ci-approved-main-baseline-1',plan,received:'received',disposition:'disposition.json',inputs,files:await fileManifest(output)};
  const path=join(output,'packet.json');await writeFile(path,JSON.stringify(packet,null,2)+'\n',{flag:'wx',mode:0o600});
  const descriptor={packet:{path,sha256:(await hashFile(path)).sha256},source:plan.spec.candidate};
  await loadApprovedMain(descriptor,{repository,verifyStages,pipelineBoundaries,pipelineComparisonSamples});
  return {descriptor,approval:'Not selected or approved. A protected external controller must explicitly pin this packet and revision after review.'};
}
