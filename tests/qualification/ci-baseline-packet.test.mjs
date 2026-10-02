import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCiPlan} from '../../tooling/qualification/ci/plan.mjs';
import {validateBaselinePacket,validateBaselineDisposition,loadApprovedMain} from '../../tooling/qualification/ci/baseline.mjs';
const source={commit:'a'.repeat(40),tree:'b'.repeat(40),digest:'c'.repeat(64)};
const seal=(path,sha256='d'.repeat(64))=>({path,sha256,bytes:2});
function fixture(){
  const inputs=Object.fromEntries(['C','H'].map((side,index)=>[side,{physicalHostId:'sha256:'+String(index+1).repeat(64),...Object.fromEntries(['hostAttestation','fixtureManifest','configuration'].map(key=>[key,seal(`/original/${side}-${key}.json`)]))}]));
  const plan=createCiPlan({purpose:'initial-baseline',candidate:source,inputs,outputRoot:'artifacts/baseline',features:'adapters'});
  const original=Object.values(inputs).flatMap(side=>['hostAttestation','fixtureManifest','configuration'].map(key=>side[key]));
  const mappings=original.map((file,index)=>({...seal(`inputs/${index}.json`),originalPath:file.path}));
  const packet={kind:'ci-approved-main-baseline-1',plan,received:'received',disposition:'disposition.json',inputs:mappings,
    files:[seal('disposition.json'),...mappings.map(({originalPath,...file})=>file),...plan.stages.map(stage=>seal(`received/stage-${stage.key}/stage.json`))]};
  return {plan,packet,descriptor:{packet:{path:'/sealed/packet.json',sha256:'e'.repeat(64)},source}};
}
test('approved baseline packet preserves every historical stage and original input seal',()=>{
  const {plan,packet,descriptor}=fixture();assert.equal(validateBaselinePacket(packet,descriptor).digest,plan.digest);
  for(const mutate of [p=>p.files.pop(),p=>p.files.push(p.files[0]),p=>p.inputs.pop(),p=>p.inputs[0].sha256='0'.repeat(64),p=>p.inputs[0].path='../escape',p=>p.disposition='/outside',p=>p.received='../received']) {
    const altered=structuredClone(packet);mutate(altered);assert.throws(()=>validateBaselinePacket(altered,descriptor));
  }
  assert.throws(()=>validateBaselinePacket(packet,{...descriptor,source:{...source,commit:'f'.repeat(40)}}),/source differs/);
});
test('initial baseline cannot claim approved history and controller source is explicit',()=>{
  const {plan,descriptor}=fixture();
  assert.throws(()=>createCiPlan({...plan.spec,approvedMain:descriptor}),/cannot claim approved history/);
  const control={...source,commit:'f'.repeat(40)};
  assert.deepEqual(createCiPlan({...plan.spec,control}).spec.control,control);
});
test('an outer PASS or approval flag cannot replace absolute child and pipeline closure',()=>{
  const {plan}=fixture(),boundaries=plan.boundaries.map(row=>({id:row.id,status:'PASS'})),pipelineSamples=[{scope:'Q3-I0',status:'PASS'}];
  const disposition={kind:'ci-qualification-state-1',planDigest:plan.digest,approved:true,automatedOutcome:'PASS',boundaryAcknowledgement:{physicalHostId:plan.spec.inputs.C.physicalHostId},boundaries,pipelineSamples};
  const result={state:{outcome:'COMMANDS_COMPLETE'},failures:[],childReceiptsByNodeId:Object.fromEntries(plan.nodes.map(node=>[node.id,{}]))};
  assert.equal(validateBaselineDisposition(plan,disposition,result,boundaries,pipelineSamples),true);
  assert.throws(()=>validateBaselineDisposition(plan,disposition,{...result,state:{outcome:'FAIL'}},boundaries,pipelineSamples),/absolute child/);
  assert.throws(()=>validateBaselineDisposition(plan,disposition,{...result,childReceiptsByNodeId:{}},boundaries,pipelineSamples),/inventory/);
  assert.throws(()=>validateBaselineDisposition(plan,disposition,result,boundaries.map(row=>({...row,status:'INCONCLUSIVE'})),pipelineSamples),/pipeline/);
  assert.throws(()=>validateBaselineDisposition(plan,{...disposition,boundaries:[]},result,boundaries,pipelineSamples),/reproduced/);
});
test('filesystem loader rejects altered externally pinned packet before trusting its contents',async()=>{
  const directory=await realpath(await mkdtemp(join(tmpdir(),'ci-baseline-packet-')));
  try{
    const path=join(directory,'packet.json');await writeFile(path,JSON.stringify({approved:true,automatedOutcome:'PASS'}));
    let invoked=false;
    await assert.rejects(loadApprovedMain({packet:{path,sha256:'0'.repeat(64)},source},{repository:directory,verifyStages:()=>{invoked=true;},pipelineBoundaries:()=>{invoked=true;}}),/packet hash differs/);
    assert.equal(invoked,false);
  }finally{await rm(directory,{recursive:true,force:true});}
});
