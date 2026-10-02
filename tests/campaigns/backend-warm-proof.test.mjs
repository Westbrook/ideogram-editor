// Source-authored contract fixtures only. Synthetic proofs exercise refusal
// rules; they are never evidence of an executed or qualified warm campaign.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sanitize} from '../../tooling/qualification/campaigns/common.mjs';
import {
  WARM_PROOF_LIMIT, warmDigest, warmCell, createWarmOwner,
  observeWarmObject, captureWarmInputRefs, observeWarmInputs,
  inspectWarmProof, verifyWarmAttempt,
} from '../../tooling/qualification/campaigns/backend-warm-proof.mjs';

const clone = value => structuredClone(value);
const input = {sha256:warmDigest('fixed WJ input'),byteLength:'14'};
const counts = () => ({commands:1,events_v2:1,assets:1,roots:1,queue_jobs:0,
  portable_bundles:0,portable_reviews:0,portable_namespaces:0,staged_assets:0,rootedBytes:'32'});
const originalInputs = () => ({count:1,byteLength:'32',sha256:warmDigest('original immutable input closure')});
const cache = () => ({kind:'retained-writer-connection-and-module-loader-1',
  decodedResultCache:'not-used-by-selected-operation',derivedResultCache:'per-operation-or-not-used',operatingSystemPageCache:'unobserved'});
const network = () => ({submit:0,upload:0,poll:0,cancel:0,fetch:0,socket:0,dns:0,datagram:0});
function captionProof() {
  const cell={id:'C9/WJ01',operation:'caption.case',workload:'WJ',parameters:{caseId:'WJ01'}};
  const sample={cache:'warm',ordinal:1,prime:false};
  const owner={ownerId:'fixture-only-owner-identity-0001',root:'/fixture-only/owned-root',pid:process.pid,epoch:'7',descriptor:{epoch:'7',threadId:42}};
  const baseline={imageHash:warmDigest('baseline image'),historyHead:'head-0',revision:'1',activeJobs:0,inputs:originalInputs(),inventory:counts()};
  const before=clone(baseline),after={...clone(baseline),imageHash:warmDigest('new composition'),historyHead:'head-1',revision:'2',inventory:{...counts(),commands:2,events_v2:2,roots:3,rootedBytes:'160'}};
  const reset={owner:clone(owner),baseline:clone(baseline),input:clone(input),before:clone(before),after:clone(before),undo:null};
  const operation={status:'pass',observations:{sealedCorpus:true,originalHash:input.sha256,originalBytes:Number(input.byteLength),guardedNetworkEffects:network()},evidence:[]};
  const packet={kind:'backend-warm-input-proof-1',family:'WJ',cell:warmCell(cell),sample:clone(sample),serial:1,previous:null,owner,baseline,input:clone(input),before,after,cache:cache()};
  const fixture={corpus:{files:[{id:'WJ01',path:'fixture-only-WJ01.raw',...clone(input)}]}};
  return {packet,options:{cell,sample,reset,operation,fixture}};
}
function nextCaption(previous) {
  const value=captionProof();
  value.packet.serial=previous.serial+1; value.packet.previous=warmDigest(previous);
  value.packet.sample.ordinal=2;value.options.sample.ordinal=2;
  value.options.previous=previous;value.options.reset.before=clone(previous.after);
  value.packet.before.revision='3';value.packet.before.inventory=clone(previous.after.inventory);
  value.options.reset.after=clone(value.packet.before);
  value.packet.after.revision='4';value.packet.after.historyHead='head-2';
  value.options.reset.undo={action:'Undo',previousHead:previous.after.historyHead,commandId:'undo-1',transactionId:'undo-transaction-1',documentId:'document-1',expectedDocumentRevision:'2',receipt:{status:'accepted',commandId:'undo-1'}};
  return value;
}
function portableProof(direction='copy') {
  const value=captionProof(),cell={id:'C10/536870912-'+direction,operation:'portable.'+direction,workload:'WC',parameters:{closureBytes:536870912,events:10000,assets:1000}};
  const fixedCounts={events:10000,assets:1000,closureBytes:'536870912',captionVersions:1};
  const baseline={sourceHash:warmDigest('fixed source document'),closureIdentity:warmDigest('complete ordered WC closure'),counts:fixedCounts};
  const before={sourceHash:baseline.sourceHash,importedDocuments:0,inventory:counts()};
  const after={...clone(before),importedDocuments:direction==='import'?1:0,inventory:{...counts(),portable_bundles:direction==='copy'?1:0,portable_namespaces:direction==='import'?1:0}};
  Object.assign(value.packet,{family:'WC',cell:warmCell(cell),baseline,before,after,networkEffects:network()});
  Object.assign(value.options,{cell,fixture:{portableSeal:{sha256:input.sha256,byteLength:input.byteLength}}});Object.assign(value.options.reset,{baseline:clone(baseline),before:clone(before),after:clone(before),cleanupPending:0});
  value.options.operation={status:'pass',observations:{},evidence:[{kind:'portable-operation',closure:{fullHashesVerified:true,semanticClosureVerified:true,typedFeaturesVerified:true,ownedClosureHashesVerified:direction==='import',inputIdentity:baseline.closureIdentity,...fixedCounts}}]};
  return value;
}
const inspect = value => inspectWarmProof(value.packet,value.options);

test('operation input equality permits disclosed retained output growth', () => {
  const first=captionProof();assert.equal(inspect(first).complete,true);
  assert.notDeepEqual(first.packet.after.inventory,first.packet.baseline.inventory);
  const next=nextCaption(first.packet);assert.equal(inspect(next).serial,2);
  assert.notEqual(next.packet.before.revision,next.packet.baseline.revision);
  for(const direction of ['copy','import'])assert.equal(inspect(portableProof(direction)).family,'WC');
});

test('proof chain follows the supplied zero, one or three prime schedule without inventing starts', () => {
  for(const primes of [0,1,3]) {
    const schedule=[...Array.from({length:primes},(_,i)=>({cache:'warm',prime:true,ordinal:i+1})),{cache:'warm',prime:false,ordinal:1}];
    let previous=null;
    for(const sample of schedule) {
      const value=previous?nextCaption(previous):captionProof();
      value.packet.sample=clone(sample);value.options.sample=clone(sample);
      assert.equal(inspect(value).serial,(previous?.serial??0)+1);previous=value.packet;
    }
    assert.equal(previous.serial,primes+1);
  }
});

test('unopened WC reset is permitted only for its first actual operation', () => {
  const first=portableProof();first.options.reset={kind:'unopened-first-operation'};assert.equal(inspect(first).serial,1);
  const later=portableProof();later.packet.serial=2;later.packet.previous=warmDigest(first.packet);later.options.previous=first.packet;later.options.reset={kind:'unopened-first-operation'};
  assert.throws(()=>inspect(later),'An unopened token cannot substitute for a later public cleanup observation');
});

test('WJ rejects changed corpus, baseline bytes, state, owner and omitted evidence', () => {
  const mutations=[
    ['consumed same-length corpus',v=>v.options.operation.observations.originalHash=warmDigest('other WJ input')],
    ['consumed length',v=>v.options.operation.observations.originalBytes++],
    ['unsealed corpus',v=>v.options.operation.observations.sealedCorpus=false],
    ['selected corpus unavailable',v=>delete v.options.fixture],
    ['selected corpus ambiguous',v=>v.options.fixture.corpus.files.push(clone(v.options.fixture.corpus.files[0]))],
    ['self-consistent substituted corpus',v=>{v.packet.input.sha256=warmDigest('substituted corpus');v.options.reset.input=clone(v.packet.input);v.options.operation.observations.originalHash=v.packet.input.sha256;}],
    ['changed current image',v=>{v.packet.before.imageHash=warmDigest('wrong image');v.options.reset.after=clone(v.packet.before);}],
    ['changed history head',v=>{v.packet.before.historyHead='other-head';v.options.reset.after=clone(v.packet.before);}],
    ['changed original bytes',v=>v.packet.after.inputs.sha256=warmDigest('corrupted original')],
    ['missing original-input observations',v=>{delete v.packet.baseline.inputs;delete v.options.reset.baseline.inputs;delete v.packet.before.inputs;delete v.options.reset.after.inputs;delete v.packet.after.inputs;}],
    ['empty retained inventory',v=>{v.packet.before.inventory={};v.options.reset.after.inventory={};}],
    ['active hold retained',v=>v.packet.after.activeJobs=1],
    ['operation owner replaced',v=>v.packet.owner.ownerId='fixture-only-other-owner-0002'],
    ['decoded-hit label fabricated',v=>v.packet.cache.decodedResultCache='warm-hit'],
    ['derived-hit label fabricated',v=>v.packet.cache.derivedResultCache='cached'],
    ['OS cache inferred',v=>v.packet.cache.operatingSystemPageCache='warm'],
    ['network attempt',v=>v.options.operation.observations.guardedNetworkEffects.fetch=1],
    ['missing network evidence',v=>delete v.options.operation.observations.guardedNetworkEffects],
    ['empty network counter set',v=>v.options.operation.observations.guardedNetworkEffects={}],
  ];
  for(const [reason,change] of mutations){const value=captionProof();change(value);assert.throws(()=>inspect(value),undefined,reason);}
});

test('chain rejects borrowed owners, changed baseline/input, skipped order and false Undo', () => {
  const previous=captionProof().packet;
  const mutations=[
    ['reordered serial',v=>v.packet.serial++],
    ['missing previous hash',v=>v.packet.previous=null],
    ['borrowed previous proof',v=>v.packet.previous=warmDigest({...previous,owner:{...previous.owner,root:'/other-root'}})],
    ['owner changed consistently within current sample',v=>{v.packet.owner.root='/other-root';v.options.reset.owner=clone(v.packet.owner);}],
    ['baseline changed consistently within current sample',v=>{v.packet.baseline.imageHash=warmDigest('other baseline');v.options.reset.baseline=clone(v.packet.baseline);}],
    ['input changed consistently within current sample',v=>{v.packet.input.sha256=warmDigest('other input');v.options.reset.input=clone(v.packet.input);v.options.operation.observations.originalHash=v.packet.input.sha256;}],
    ['reset not from prior actual outcome',v=>v.options.reset.before.historyHead='unrelated-head'],
    ['Undo absent',v=>v.options.reset.undo=null],
    ['Undo rejected',v=>v.options.reset.undo.receipt.status='rejected'],
    ['Undo wrong previous head',v=>v.options.reset.undo.previousHead='unrelated-head'],
    ['receipt borrowed from another Undo',v=>v.options.reset.undo.receipt.commandId='unrelated-undo'],
  ];
  for(const [reason,change] of mutations){const value=nextCaption(previous);change(value);assert.throws(()=>inspect(value),undefined,reason);}
});

test('WC rejects incomplete hashes, changed full ancestry/counts and pending import cleanup', () => {
  const mutations=[
    ['full hashes skipped',v=>v.options.operation.evidence[0].closure.fullHashesVerified=false],
    ['semantic ancestry skipped',v=>v.options.operation.evidence[0].closure.semanticClosureVerified=false],
    ['typed features skipped',v=>v.options.operation.evidence[0].closure.typedFeaturesVerified=false],
    ['ancestry changed with same source document',v=>v.options.operation.evidence[0].closure.inputIdentity=warmDigest('other retained branch')],
    ['event omitted',v=>v.options.operation.evidence[0].closure.events--],
    ['asset omitted',v=>v.options.operation.evidence[0].closure.assets--],
    ['closure byte count changed',v=>v.options.operation.evidence[0].closure.closureBytes='536870911'],
    ['source changed',v=>v.packet.after.sourceHash=warmDigest('different source')],
    ['selected WC seal unavailable',v=>delete v.options.fixture],
    ['selected WC seal differs',v=>v.options.fixture.portableSeal.sha256=warmDigest('different sealed archive')],
    ['self-consistent reduced workload',v=>{v.packet.baseline.counts.events=1;v.options.reset.baseline=clone(v.packet.baseline);v.options.operation.evidence[0].closure.events=1;}],
    ['prior imported document live',v=>{v.packet.before.importedDocuments=1;v.options.reset.after=clone(v.packet.before);}],
    ['cleanup pending',v=>v.options.reset.cleanupPending=1],
    ['owned imported bytes not verified',v=>v.options.operation.evidence[0].closure.ownedClosureHashesVerified=false],
    ['import output absent',v=>v.packet.after.importedDocuments=0],
  ];
  for(const [reason,change] of mutations){const value=portableProof('import');change(value);assert.throws(()=>inspect(value),undefined,reason);}
});

function retainedAttempt(value) {
  const bytes=Buffer.from(JSON.stringify(value.packet));
  const rawArtifact={path:'proof.json',bytes:bytes.length,sha256:warmDigest(bytes)};
  const attempt=sanitize({...clone(value.options.sample),status:'PASS',reset:{warmReset:clone(value.options.reset)},result:{...clone(value.options.operation),warmInput:{artifact:rawArtifact}}});
  const artifact=attempt.result.warmInput.artifact;
  return {bytes,artifact,attempt,args:{cell:value.options.cell,attempt,previous:value.options.previous,fixture:value.options.fixture,workerProcessIdentity:{pid:process.pid},readRetained:async(path,limits)=>{assert.equal(path,'proof.json');assert.deepEqual(limits,{maximum:WARM_PROOF_LIMIT});return bytes;}}};
}

test('replay requires exact retained proof bytes and actual worker/sample identity', async () => {
  const good=retainedAttempt(captionProof());assert.deepEqual(await verifyWarmAttempt(good.args),captionProof().packet);
  const changes=[
    ['missing proof',v=>delete v.attempt.result.warmInput],
    ['wrong sealed byte length',v=>v.artifact.bytes++],
    ['wrong retained digest',v=>v.artifact.sha256=warmDigest('unrelated proof')],
    ['proof exceeds bounded reader',v=>v.artifact.bytes=WARM_PROOF_LIMIT+1],
    ['different worker',v=>v.args.workerProcessIdentity.pid++],
    ['ordinal substituted',v=>v.attempt.ordinal++],
    ['scored attempt relabeled prime',v=>v.attempt.prime=true],
    ['cold attempt relabeled warm',v=>v.attempt.cache='cold'],
    ['different logical cell',v=>v.args.cell={...v.args.cell,id:'C9/WJ02'}],
    ['truncated retained bytes',v=>v.args.readRetained=async()=>v.bytes.subarray(0,-1)],
  ];
  for(const [reason,change] of changes){const value=retainedAttempt(captionProof());change(value);await assert.rejects(()=>verifyWarmAttempt(value.args),undefined,reason);}
  const failure=retainedAttempt(captionProof());failure.attempt.status='INCONCLUSIVE';delete failure.attempt.result.warmInput;assert.equal(await verifyWarmAttempt(failure.args),null);
  const unrelated=retainedAttempt(captionProof());unrelated.args.cell.operation='queue.fault';assert.equal(await verifyWarmAttempt(unrelated.args),null,'WQ is outside this proof family');
});

test('actual journal sanitization preserves the replayed owner and public Undo evidence', async () => {
  const first=captionProof(),second=nextCaption(first.packet),retained=retainedAttempt(second);
  assert.deepEqual(retained.attempt.reset.warmReset,second.options.reset);
  assert.deepEqual(await verifyWarmAttempt(retained.args),second.packet);
});

test('owner observer rejects an identical-looking replacement capability and epoch loss', () => {
  const writer={available:true,epoch:'7'},descriptor={epoch:'7',threadId:42},observe=createWarmOwner(writer,'/fixture-only/owned-root',descriptor);
  const first=observe(writer);assert.deepEqual(observe(writer),first);
  assert.throws(()=>observe({...writer}));writer.available=false;assert.throws(()=>observe(writer));writer.available=true;
  writer.epoch='8';assert.throws(()=>observe(writer));writer.epoch='7';
  descriptor.threadId++;assert.throws(()=>observe(writer));
  assert.throws(()=>createWarmOwner({available:false,epoch:'7'},'/fixture-only/owned-root'));
});

async function objectFixture(t,bytes) {
  const root=await mkdtemp(join(tmpdir(),'warm-input-contract-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const hash=warmDigest(bytes),ref={hash,byteLength:String(bytes.length),mediaType:'application/octet-stream'},dir=join(root,'objects/sha256',hash.slice(7,9));
  await mkdir(dir,{recursive:true});const path=join(dir,hash.slice(7));await writeFile(path,bytes);return {root,path,ref};
}

test('actual object reads reject same-length corruption, length changes and symlinks', async t => {
  const bytes=Buffer.from('actual original bytes'),f=await objectFixture(t,bytes);
  assert.deepEqual(await observeWarmObject(f.root,f.ref),{sha256:f.ref.hash,byteLength:f.ref.byteLength});
  const corrupt=Buffer.from(bytes);corrupt[0]^=1;await writeFile(f.path,corrupt);await assert.rejects(observeWarmObject(f.root,f.ref),/bytes changed/);
  await writeFile(f.path,bytes.subarray(1));await assert.rejects(observeWarmObject(f.root,f.ref),/length changed/);
  await writeFile(f.path,Buffer.concat([bytes,Buffer.from('x')]));await assert.rejects(observeWarmObject(f.root,f.ref),/length changed/);
  const target=f.path+'.target';await writeFile(target,bytes);await rm(f.path);await symlink(target,f.path);await assert.rejects(observeWarmObject(f.root,f.ref));
});

test('streamed object verification uses bounded scratch and survives aborted reads', async t => {
  const bytes=Buffer.alloc(2*1024*1024+17,0x5a),f=await objectFixture(t,bytes),originalAlloc=Buffer.alloc;
  const allocations=[];t.mock.method(Buffer,'alloc',function(size,...args){allocations.push(size);assert(size<=1048576,'Observer must not copy the whole original input');return originalAlloc(size,...args);});
  assert.equal((await observeWarmObject(f.root,f.ref)).sha256,f.ref.hash);assert(allocations.length>0);
  const controller=new AbortController();controller.abort(new Error('intentional fixture cancellation'));
  await assert.rejects(observeWarmObject(f.root,f.ref,controller.signal),/intentional fixture cancellation/);
  assert.equal((await observeWarmObject(f.root,f.ref)).byteLength,String(bytes.length));
  await assert.rejects(observeWarmObject(f.root,{...f.ref,byteLength:'9007199254740992'}),/Invalid warm input reference/);
  await assert.rejects(observeWarmObject(f.root,{...f.ref,byteLength:'01'}),/Invalid warm input reference/);
  await assert.rejects(observeWarmObject(f.root,{...f.ref,hash:'sha256:invalid'}),/Invalid warm input reference/);
});

test('initial closure pagination rejects loops/conflicts and binds original bytes', async t => {
  const f=await objectFixture(t,Buffer.from('original closure object'));
  const refs=await captureWarmInputRefs({historyClosure:async()=>({items:[f.ref,f.ref],next:''})},'document-1');assert.deepEqual(refs,[f.ref]);
  const observed=await observeWarmInputs(f.root,refs);assert.equal(observed.count,1);assert.equal(observed.byteLength,f.ref.byteLength);
  let page=0;await assert.rejects(captureWarmInputRefs({historyClosure:async()=>({items:[f.ref],next:page++===0?'repeat':'repeat'})},'document-1'),/cursor repeated/);
  await assert.rejects(captureWarmInputRefs({historyClosure:async()=>({items:[f.ref,{...f.ref,byteLength:'999'}],next:''})},'document-1'),/Conflicting/);
  await writeFile(f.path,Buffer.alloc(Number(f.ref.byteLength),0));await assert.rejects(observeWarmInputs(f.root,refs),/bytes changed/);
});
