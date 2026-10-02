import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCiPlan,sha256} from '../../tooling/qualification/ci/plan.mjs';
import {immutableSource,immutableDiff} from '../../tooling/qualification/ci/run.mjs';
import {fetchImmutableInputs} from '../../tooling/qualification/ci/source-fetch.mjs';

function git(repository,args,input) {
  return execFileSync('git',args,{cwd:repository,input,encoding:'utf8',env:{PATH:process.env.PATH,
    GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',
    GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid',GIT_AUTHOR_DATE:'2026-01-01T00:00:00Z',GIT_COMMITTER_DATE:'2026-01-01T00:00:00Z'}}).trim();
}
const seal=path=>({path,bytes:2,sha256:'d'.repeat(64)});
const inputs=()=>Object.fromEntries(['C','H'].map((side,index)=>[side,{physicalHostId:'sha256:'+String(index+1).repeat(64),
  ...Object.fromEntries(['hostAttestation','fixtureManifest','configuration'].map(key=>[key,seal(`/original/${side}-${key}.json`)]))}]));
// The fixture packet contains the canonical source-selection structure only.
// It deliberately supplies no passing runtime evidence and cannot qualify a run.
function packetFor(plan) {
  const originals=Object.values(plan.spec.inputs).flatMap(side=>['hostAttestation','fixtureManifest','configuration'].map(key=>side[key]));
  const mappings=originals.map((file,index)=>({...seal(`inputs/${index}.json`),originalPath:file.path}));
  return {kind:'ci-approved-main-baseline-1',plan,received:'received',disposition:'disposition.json',inputs:mappings,
    files:[seal('disposition.json'),...mappings.map(({originalPath,...file})=>file),...plan.stages.map(stage=>seal(`received/stage-${stage.key}/stage.json`))]};
}
async function fixture(t) {
  const directory=await realpath(await mkdtemp(join(tmpdir(),'ci-source-fetch-')));t.after(()=>rm(directory,{recursive:true,force:true}));
  const producer=join(directory,'producer'),repository=join(directory,'fresh');git(directory,['init','--quiet',producer]);git(directory,['init','--quiet',repository]);
  const sources=[];
  // Five independent advertised commits: fetching the current subject cannot
  // accidentally supply historical base/control through its parent ancestry.
  for(let index=0;index<5;index++) {
    const blob=git(producer,['hash-object','-w','--stdin'],JSON.stringify({name:'source-'+index,private:true})+'\n');
    const tree=git(producer,['mktree'],`100644 blob ${blob}\tpackage.json\n`),commit=git(producer,['commit-tree',tree],`fixture ${index}\n`);
    git(producer,['update-ref',`refs/heads/source-${index}`,commit]);sources.push(immutableSource(producer,commit));
  }
  git(repository,['remote','add','origin',producer]);
  const makeComparison=(base,candidate,control,approvedMain=null)=>createCiPlan({base,candidate,control,approvedMain,
    diff:immutableDiff(producer,base.commit,candidate.commit),inputs:inputs(),features:'core',outputRoot:'artifacts/source-fixture'});
  let historical=makeComparison(sources[1],sources[2],sources[0]);
  const path=join(directory,'packet.json');
  const writePacket=async(plan=historical)=>{historical=plan;const bytes=JSON.stringify(packetFor(plan));await writeFile(path,bytes);return {packet:{path,sha256:sha256(bytes)},source:plan.spec.candidate};};
  const descriptor=await writePacket(),plan=makeComparison(sources[3],sources[4],sources[4],descriptor),fetched=[];
  const fetchRevision=async revision=>{fetched.push(revision);git(repository,['-c','protocol.file.allow=always','fetch','--quiet','--no-tags','origin',revision]);};
  return {directory,repository,producer,sources,historical,path,descriptor,plan,makeComparison,writePacket,fetched,fetchRevision};
}

test('fresh clone fetches authenticated historical base and control as well as its candidate',async t=>{
  const f=await fixture(t),result=await fetchImmutableInputs(f.plan,{repository:f.repository,fetchRevision:f.fetchRevision});
  assert.deepEqual(f.fetched,[f.sources[4],f.sources[3],f.sources[0],f.sources[1],f.sources[2]].map(source=>source.commit));
  for(const source of f.sources)assert.deepEqual(immutableSource(f.repository,source.commit),source);
  assert.deepEqual(result.commits,f.fetched);assert.equal(result.historicalPlanDigest,f.historical.digest);assert.equal(result.qualification,false);
});

test('initial baseline fetches only its actual candidate and controller without fabricated history',async t=>{
  const f=await fixture(t),plan=createCiPlan({purpose:'initial-baseline',candidate:f.sources[4],control:f.sources[0],inputs:inputs(),features:'core',outputRoot:'artifacts/first'});
  const result=await fetchImmutableInputs(plan,{repository:f.repository,fetchRevision:f.fetchRevision});
  assert.deepEqual(f.fetched,[f.sources[0].commit,f.sources[4].commit]);assert.equal(result.historicalPlanDigest,null);assert.equal(result.qualification,false);
});

test('altered packet and protected source mismatch reject before any Git fetch',async t=>{
  const f=await fixture(t);await writeFile(f.path,(await readFile(f.path,'utf8'))+' ');
  await assert.rejects(fetchImmutableInputs(f.plan,{repository:f.repository,fetchRevision:f.fetchRevision}),/packet hash differs/);assert.deepEqual(f.fetched,[]);
  const descriptor=await f.writePacket(),plan=f.makeComparison(f.sources[3],f.sources[4],f.sources[4],{...descriptor,source:f.sources[1]});
  await assert.rejects(fetchImmutableInputs(plan,{repository:f.repository,fetchRevision:f.fetchRevision}),/source differs/);assert.deepEqual(f.fetched,[]);
});

test('canonical historical source conflicts reject before fetch even with a matching packet hash',async t=>{
  const f=await fixture(t),historical=createCiPlan({...f.historical.spec,control:{...f.sources[4],digest:'0'.repeat(64)}}),descriptor=await f.writePacket(historical);
  const plan=f.makeComparison(f.sources[3],f.sources[4],f.sources[4],descriptor);
  await assert.rejects(fetchImmutableInputs(plan,{repository:f.repository,fetchRevision:f.fetchRevision}),/Conflicting sealed Git identity/);assert.deepEqual(f.fetched,[]);
});

test('a successful fetch callback cannot replace missing historical objects or wrong immutable bytes',async t=>{
  const f=await fixture(t);
  await assert.rejects(fetchImmutableInputs(f.plan,{repository:f.repository,fetchRevision:revision=>revision===f.sources[0].commit?undefined:f.fetchRevision(revision)}),/immutable Git inputs/);
  const historical=createCiPlan({...f.historical.spec,base:{...f.sources[1],tree:'0'.repeat(40)}}),descriptor=await f.writePacket(historical);
  const plan=f.makeComparison(f.sources[3],f.sources[4],f.sources[4],descriptor);
  await assert.rejects(fetchImmutableInputs(plan,{repository:f.repository,fetchRevision:f.fetchRevision}),/Immutable source differs/);
});

test('historical diff is reproduced rather than trusting an internally consistent plan digest',async t=>{
  const f=await fixture(t),diff={...f.historical.spec.diff,rawSha256:'0'.repeat(64)},historical=createCiPlan({...f.historical.spec,diff}),descriptor=await f.writePacket(historical);
  const plan=f.makeComparison(f.sources[3],f.sources[4],f.sources[4],descriptor);
  await assert.rejects(fetchImmutableInputs(plan,{repository:f.repository,fetchRevision:f.fetchRevision}),/Immutable diff differs/);
});

test('packet changing after authorization cannot produce a prepared result',async t=>{
  const f=await fixture(t);let changed=false;
  await assert.rejects(fetchImmutableInputs(f.plan,{repository:f.repository,fetchRevision:async revision=>{
    await f.fetchRevision(revision);if(!changed){changed=true;await writeFile(f.path,(await readFile(f.path,'utf8'))+' ');}
  }}),/packet changed during source fetch/);
});

test('cancellation before or between exact fetches stops the owned sequence',async t=>{
  const f=await fixture(t),before=new AbortController();before.abort(Error('fixture cancelled before'));
  await assert.rejects(fetchImmutableInputs(f.plan,{repository:f.repository,fetchRevision:f.fetchRevision,signal:before.signal}),/cancelled before/);assert.deepEqual(f.fetched,[]);
  const during=new AbortController();await assert.rejects(fetchImmutableInputs(f.plan,{repository:f.repository,signal:during.signal,fetchRevision:async revision=>{
    await f.fetchRevision(revision);during.abort(Error('fixture cancelled during'));
  }}),/cancelled during/);assert.equal(f.fetched.length,1);
});

test('historical initial baseline has no base and nested approval descriptors do not expand fetch authority',async t=>{
  const f=await fixture(t),initial=createCiPlan({purpose:'initial-baseline',candidate:f.sources[2],control:f.sources[0],inputs:inputs(),features:'core',outputRoot:'artifacts/older-first'});
  let descriptor=await f.writePacket(initial),plan=f.makeComparison(f.sources[3],f.sources[4],f.sources[4],descriptor);
  await fetchImmutableInputs(plan,{repository:f.repository,fetchRevision:f.fetchRevision});
  assert.deepEqual(f.fetched,[f.sources[4],f.sources[3],f.sources[0],f.sources[2]].map(source=>source.commit));
  f.fetched.length=0;
  const historical=createCiPlan({...f.historical.spec,purpose:'comparison',base:f.sources[1],diff:immutableDiff(f.producer,f.sources[1].commit,f.sources[2].commit),
    approvedMain:{packet:{path:'/unselected/packet.json',sha256:'0'.repeat(64)},source:{commit:'f'.repeat(40),tree:'e'.repeat(40),digest:'d'.repeat(64)}}});
  descriptor=await f.writePacket(historical);plan=f.makeComparison(f.sources[3],f.sources[4],f.sources[4],descriptor);
  await fetchImmutableInputs(plan,{repository:f.repository,fetchRevision:f.fetchRevision});
  assert.equal(f.fetched.includes('f'.repeat(40)),false);assert.equal(f.fetched.length,5);
});
