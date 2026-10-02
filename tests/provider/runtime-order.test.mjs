import test from 'node:test';
import assert from 'node:assert/strict';
import {ProviderExecution} from '../../dist/local/server/provider/runtime-core.js';
import {QueueDispatcher} from '../../dist/local/server/provider/dispatcher.js';
import {PRODUCTION_PROFILE,PRODUCTION_PRIVACY} from '../../dist/local/server/provider/production-profile.js';
import {StoreError} from '../../dist/local/server/storage/errors.js';
import {egressAttempts} from './no-egress.mjs';

test('a reorder during awaited dispatch invalidates the old cursor without skipping reconciliation or poisoning the next tick',async t=>{
 const now=Date.UTC(2026,8,30),manifest={schemaVersion:1,id:'fixture_authorization',approvedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+3600000).toISOString(),endpoint:'ideogram/v4',operation:'generate',maxRequests:3,maxImages:3,output:{width:512,height:512,count:1,format:'png'},expansion:'None',profileId:PRODUCTION_PROFILE.id,profileVersion:PRODUCTION_PROFILE.version,evidenceDigest:PRODUCTION_PROFILE.evidenceDigest,disclosureDigest:PRODUCTION_PRIVACY.disclosureDigest,acknowledgeChargeAndPrivacy:true},configurationHash='a'.repeat(64),attempt={id:'attempt_1',state:'not-started',count:'none',providerAuthorization:{id:'approval_1',configurationId:manifest.id,configurationHash,epoch:'1',jobId:'job_1',attemptId:'attempt_1',reviewToken:'review_1',profileId:manifest.profileId,profileVersion:manifest.profileVersion,disclosureDigest:manifest.disclosureDigest,authorizedAt:new Date(now).toISOString()}},job={id:'job_1',documentId:'document_1',disposition:'eligible',stagePlan:[],review:{token:'review_1',endpoint:manifest.endpoint,request:{kind:'generate',size:{kind:'custom',width:512,height:512},settings:{count:1,format:'png',expansion:'None',safetyChecker:true,syncMode:false}}},attempts:[attempt]};
 const cursor='q1:0:1:job_1',reads=[],observations=[],submissions=[];let reordered=false,staleReads=0,releaseSubmission;
 const released=new Promise(resolve=>{releaseSubmission=resolve;});
 const queue={view(after=''){reads.push(after);if(after===cursor){if(reordered){staleReads++;throw new StoreError('STALE_EPOCH');}return {jobs:[],nextCursor:null};}assert.equal(after,'');return {jobs:[job],nextCursor:reordered?null:cursor};},deleted(){return false;},recoveryWork(){observations.push('recover');return [];},controlWork(){observations.push('control');return [];}};
 const candidates={queue,due(at){observations.push(['due',at]);return [];},retries(){observations.push('retry');return [];}};
 t.mock.method(QueueDispatcher.prototype,'submit',async id=>{submissions.push(id);await released;attempt.state='acknowledged';return null;});
 const provider={policy(){assert.fail('The scheduler seam must not call a provider');}},runtime=new ProviderExecution({queue,candidates,epoch:'1'},{mode:'fal',manifest,manifestHash:configurationHash,key:'fixture-sentinel-no-provider-key'},{provider,automatic:false,now:()=>now});t.after(async()=>{releaseSubmission();await runtime.close();assert.deepEqual(egressAttempts(),[]);});
 const pending=runtime.tick();assert.deepEqual(submissions,['job_1']);assert.deepEqual(observations,[]);reordered=true;releaseSubmission();await pending;
 assert.equal(staleReads,1);assert.deepEqual(submissions,['job_1']);assert.deepEqual(observations,['recover','control',['due',now],'retry']);assert.match(runtime.view().message,/local queue inventory changed/);
 reads.length=0;await runtime.tick();assert.equal(reads[0],'');assert.equal(staleReads,1);assert.deepEqual(submissions,['job_1']);assert.deepEqual(observations,['recover','control',['due',now],'retry','recover','control',['due',now],'retry']);
});
