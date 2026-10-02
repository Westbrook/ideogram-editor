import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {
  V45_PROFILE, V45_DISCLOSURE, V45_PROFILE_EVIDENCE, V45_PROFILE_BLOCKERS,
  V45_PROFILE_ID, V45_DISCLOSURE_DIGEST, V45_EVIDENCE_DIGEST
} from '../../dist/local/server/provider/v45-profile.js';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy=value=>JSON.parse(JSON.stringify(value));

test('V45 has separate endpoint, operation, result, admission and review identities',()=>{
  assert.equal(V45_PROFILE.id,V45_PROFILE_ID);
  assert.equal(V45_PROFILE_ID,'fal-v45-documented-blocked-20260930');
  assert.equal(V45_PROFILE.version,1);
  assert.equal(V45_PROFILE.operation,'generate-v45');
  assert.equal(V45_PROFILE.endpoint,'ideogram/v4.5');
  assert.equal(V45_PROFILE.operationContract,'fal-ideogram-v45-generation-1');
  assert.equal(V45_PROFILE.resultContract,'ideogram-v45-result-1');
  assert.equal(V45_PROFILE.admissionPolicy,'unknown-withheld-1');
  assert.notEqual(V45_PROFILE.id,'fal-v4-public-hour-20260930');
  assert.notEqual(V45_PROFILE.endpoint,'ideogram/v4');
  assert.notEqual(V45_PROFILE.resultContract,'ideogram-v4-result-1');
});

test('documented capability never grants dispatch or ordinary candidate use',()=>{
  assert.equal(V45_PROFILE.kind,'documented-provider-contract');
  assert.equal(V45_PROFILE.evidenceStatus,'documented-only');
  assert.equal(V45_PROFILE.dispatchEligible,false);
  assert.equal(V45_PROFILE.admission.state,'blocked');
  assert.equal(V45_PROFILE.admission.reason,'provider-safety-evidence-unavailable');
  assert.equal(V45_PROFILE.admission.safety,'unknown');
  for(const action of ['ordinaryDisplay','adoption','export','decodePreparation']){
    assert.equal(V45_PROFILE.admission[action],false,action);
  }
  assert.equal(V45_PROFILE.admission.protectedEncodedRetention,'unchanged-existing-policy');
});

test('privacy and CDN evidence select no production lifetime, ACL or media host',()=>{
  const {privacy,media}=V45_PROFILE;
  for(const key of ['selectedLifetimeSeconds','selectedACL','minimumCompatibleLifetimeSeconds','upstreamRetentionSeconds']){
    assert.equal(privacy[key],null,key);
  }
  for(const key of ['privateDeliveryQualified','headerEnforcementQualified','recoveryQualified']){
    assert.equal(privacy[key],false,key);
  }
  assert.deepEqual(privacy.documentedStoreIO,{name:'X-Fal-Store-IO',value:'0',scope:'fal-json-history'});
  assert.equal(privacy.partner.pageBadge,'Partner');
  assert.equal(privacy.partner.websiteEnterpriseStatus,'ready');
  assert.equal(privacy.partner.qualification,'unobserved');
  assert.equal(media.selectedPolicy,null);
  assert.deepEqual(media.productionHosts,[]);
  assert.equal(media.uploadsQualified,false);
  assert.equal(media.actualOutputHostsObserved,false);
  assert.deepEqual(media.documentedOutputExampleHosts,['v3.fal.media']);
  assert.deepEqual(media.documentedACLHosts,['v3b.fal.media']);
});

test('safety, partner retention and CDN scope remain independent unresolved blockers',()=>{
  const blockers=new Map(V45_PROFILE_BLOCKERS.map(item=>[item.code,item]));
  assert.equal(blockers.size,V45_PROFILE_BLOCKERS.length);
  for(const [code,area] of [
    ['provider-safety-evidence-unavailable','admission'],
    ['partner-retention-unqualified','privacy'],
    ['media-policy-scope-unqualified','cdn']
  ]){
    const blocker=blockers.get(code);
    assert(blocker,code);
    assert.equal(blocker.area,area);
    assert.equal(blocker.state,'unresolved');
    assert(blocker.explanation.length>40);
  }
  assert.match(blockers.get('provider-safety-evidence-unavailable').explanation,/does not declare per-image safety metadata/);
  assert.match(blockers.get('partner-retention-unqualified').explanation,/partner copies remain unqualified/);
  assert.match(blockers.get('media-policy-scope-unqualified').explanation,/v3\.fal\.media.*v3b\.fal\.media/);
  assert.deepEqual(V45_PROFILE.blockers,V45_PROFILE_BLOCKERS);
});

test('evidence identities bind every retained official source snapshot',async()=>{
  const files={
    'generation-schema':'openapi.json',
    'generation-guide':'llms.txt',
    'generation-page':'api.html',
    'model-errors':'errors.md',
    'fal-retention':'privacy/fal-retention.md',
    'fal-platform-headers':'privacy/fal-headers.md',
    'fal-file-acl':'privacy/fal-acl.md',
    'fal-cdn':'privacy/fal-cdn.md',
    'fal-result-expiry':'privacy/fal-webhooks.md',
    'fal-api-services':'privacy/fal-api-services.html',
    'ideogram-direct-api-terms':'privacy/ideogram-current-api-terms.html',
    'ideogram-privacy':'privacy/ideogram-current-privacy.html'
  };
  assert.deepEqual(V45_PROFILE_EVIDENCE.map(item=>item.id).sort(),Object.keys(files).sort());
  for(const source of V45_PROFILE_EVIDENCE){
    const url=new URL(source.url);
    assert.equal(url.protocol,'https:');
    assert(['fal.ai','ideogram.ai'].includes(url.hostname));
    assert.match(source.sha256,/^[a-f0-9]{64}$/);
    assert(source.observation.length>40);
    const bytes=await readFile(new URL('../../tooling/provider/research/v45/'+files[source.id],import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),source.sha256,source.id);
  }
  const schema=V45_PROFILE_EVIDENCE.find(item=>item.id==='generation-schema');
  assert.equal(new URL(schema.url).searchParams.get('endpoint_id'),'ideogram/v4.5');
  assert(V45_PROFILE_EVIDENCE.some(item=>item.url==='https://fal.ai/legal/api-services'));
});

test('digests bind source identities, observations, and every disclosure line',()=>{
  assert.equal(V45_EVIDENCE_DIGEST,digest(V45_PROFILE_EVIDENCE));
  assert.equal(V45_DISCLOSURE_DIGEST,digest(V45_DISCLOSURE));
  assert.equal(V45_PROFILE.evidenceDigest,V45_EVIDENCE_DIGEST);
  assert.equal(V45_PROFILE.disclosureDigest,V45_DISCLOSURE_DIGEST);
  assert.equal(digest(V45_PROFILE.evidence),V45_EVIDENCE_DIGEST);
  assert.equal(digest(V45_PROFILE.disclosure),V45_DISCLOSURE_DIGEST);
  for(const field of ['id','url','sha256','observation']){
    const changed=copy(V45_PROFILE_EVIDENCE);
    changed[0][field]+='-altered';
    assert.notEqual(digest(changed),V45_EVIDENCE_DIGEST,field);
  }
  for(let i=0;i<V45_DISCLOSURE.length;i++){
    const changed=[...V45_DISCLOSURE];
    changed[i]+=' Altered meaning.';
    assert.notEqual(digest(changed),V45_DISCLOSURE_DIGEST,'disclosure '+i);
  }
  assert.notEqual(digest(V45_PROFILE_EVIDENCE.slice(1)),V45_EVIDENCE_DIGEST);
  assert.notEqual(digest(V45_DISCLOSURE.slice(1)),V45_DISCLOSURE_DIGEST);
});

test('disclosure keeps withholding, partner transfer and privacy limits visible',()=>{
  const disclosure=V45_DISCLOSURE.join('\n');
  assert(V45_DISCLOSURE.every(line=>typeof line==='string'&&line.length>0));
  assert.match(disclosure,/does not authorize a provider request/);
  assert.match(disclosure,/unknown and withheld from ordinary viewing, adoption and export/);
  assert.match(disclosure,/reviewed prompt to Fal and its model partner/);
  assert.match(disclosure,/No evidence establishes that this header controls copies held by Ideogram/);
  assert.match(disclosure,/No production media host, ACL or lifetime is selected/);
  assert.match(disclosure,/Existing v4 approvals and privacy acknowledgements do not transfer/);
});

test('a prospective milestone is an estimate without format or dispatch guarantees',()=>{
  const milestone=V45_PROFILE.prospectiveMilestone;
  assert.equal(milestone.images,1);
  assert.equal(milestone.quality,'medium');
  assert.equal(milestone.size,'square_hd');
  assert.equal(milestone.width,1024);
  assert.equal(milestone.height,1024);
  assert.equal(milestone.promptExpansion,'explicit-reviewed-choice');
  assert.equal(milestone.outputFormat,'provider-controlled');
  assert.equal(milestone.estimate.currency,'USD');
  assert.equal(milestone.estimate.cents,6);
  assert.equal(milestone.estimate.actualCharge,null);
  assert.equal(milestone.estimate.requiresPriceRecheck,true);
  assert.equal(V45_PROFILE.dispatchEligible,false);
});

test('all exported profile data is deeply immutable, including nested evidence and limits',()=>{
  const visited=new Set();
  const frozen=(value,path)=>{
    if(value===null||typeof value!=='object'||visited.has(value))return;
    visited.add(value);
    assert(Object.isFrozen(value),path);
    for(const [key,child] of Object.entries(value))frozen(child,path+'.'+key);
  };
  for(const [name,value] of Object.entries({V45_PROFILE,V45_PROFILE_EVIDENCE,V45_PROFILE_BLOCKERS,V45_DISCLOSURE}))frozen(value,name);
  const before=JSON.stringify(V45_PROFILE);
  for(const mutate of [
    ()=>{V45_PROFILE.dispatchEligible=true;},
    ()=>{V45_PROFILE.admission.ordinaryDisplay=true;},
    ()=>{V45_PROFILE.admission.safety='safe';},
    ()=>{V45_PROFILE.privacy.selectedLifetimeSeconds=3600;},
    ()=>{V45_PROFILE.privacy.partner.qualification='observed';},
    ()=>{V45_PROFILE.media.productionHosts.push('v3.fal.media');},
    ()=>{V45_PROFILE.media.documentedACLHosts[0]='v3.fal.media';},
    ()=>{V45_PROFILE.prospectiveMilestone.estimate.actualCharge=6;},
    ()=>{V45_PROFILE_BLOCKERS[0].state='resolved';},
    ()=>{V45_PROFILE_BLOCKERS.pop();},
    ()=>{V45_PROFILE_EVIDENCE[0].sha256='0'.repeat(64);},
    ()=>{V45_PROFILE_EVIDENCE.push({id:'forged'});},
    ()=>{V45_DISCLOSURE[0]='Dispatch approved';},
    ()=>{V45_DISCLOSURE.pop();}
  ])assert.throws(mutate,TypeError);
  assert.equal(JSON.stringify(V45_PROFILE),before);
  assert.equal(V45_EVIDENCE_DIGEST,digest(V45_PROFILE_EVIDENCE));
  assert.equal(V45_DISCLOSURE_DIGEST,digest(V45_DISCLOSURE));
});
