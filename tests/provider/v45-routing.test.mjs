import test from 'node:test';
import assert from 'node:assert/strict';
import {queuePath,validateQueueURL,resolvePrivacy} from '../../dist/local/server/provider/policy.js';
import {fixtureProfile} from './emulator.mjs';

test('V45 generation queue identity is exact and does not change V4 management paths',()=>{
 for(const endpoint of ['ideogram/v4','ideogram/v4.5']){
  assert.equal(queuePath({endpoint},'submit'),'/'+endpoint);
  const identity={endpoint,requestId:'owned_request'};
  for(const action of ['status','result','cancel']){
   const expected='/'+endpoint+'/requests/owned_request'+(action==='result'?'':'/'+action);
   assert.equal(queuePath(identity,action),expected);assert.equal(validateQueueURL('https://queue.fal.run'+expected,identity,action).pathname,expected);
  }
 }
});

test('V45 edit tolerates only the exact schema and official-client returned management identities',()=>{
 const identity={endpoint:'ideogram/v4.5/edit',requestId:'owned_request'};
 assert.equal(queuePath({endpoint:identity.endpoint},'submit'),'/ideogram/v4.5/edit');
 for(const action of ['status','result','cancel'])for(const prefix of ['/ideogram/v4.5/edit','/ideogram/v4.5']){
  const path=prefix+'/requests/owned_request'+(action==='result'?'':'/'+action);
  assert.equal(validateQueueURL('https://queue.fal.run'+path,identity,action).pathname,path);
  if(action==='result'){
   assert.throws(()=>validateQueueURL('https://queue.fal.run'+path+'/response',identity,action));
   assert.equal(validateQueueURL('https://queue.fal.run'+path+'/response',identity,action,undefined,true).pathname,path+'/response');
  }
 }
 for(const path of ['/ideogram/v4/requests/owned_request','/ideogram/v4.5/requests/other_request','/ideogram/v4.5/other/requests/owned_request','/ideogram/v4.5/requests/owned_request?token=secret'])assert.throws(()=>validateQueueURL('https://queue.fal.run'+path,identity,'result'));
 assert.throws(()=>validateQueueURL('https://elsewhere.invalid/ideogram/v4.5/requests/owned_request',identity,'result'));
});

test('V45 endpoint recognition enables fixtures but cannot construct a production privacy policy',()=>{
 for(const endpoint of ['ideogram/v4.5','ideogram/v4.5/edit']){
  const fixture=fixtureProfile({endpoint});assert.equal(resolvePrivacy(fixture,endpoint,'attempt_1').applied.profileId,fixture.id);
  assert.throws(()=>resolvePrivacy({...fixture,mode:'production'},endpoint,'attempt_1'),{code:'POLICY'});
 }
});
