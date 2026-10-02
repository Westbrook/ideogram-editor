import test from 'node:test';
import assert from 'node:assert/strict';
import {providerRecord} from '../../dist/local/server/portable/provenance.js';

const hash='sha256:'+'a'.repeat(64);
const policy={hash,byteLength:'2',mediaType:'application/json'};
const record=endpoint=>({class:'portable-provider',attemptId:'past_attempt',endpoint,requestId:null,status:'completed',assetHashes:[],requestedPromptRef:null,submittedPromptRef:null,returnedPromptRef:null,seedText:null,safeTimingsRef:null,privacyPolicyRef:policy,derivation:{profile:'TP-1',sourceBodyHash:hash,complete:false}});

test('portable provider validator retains legacy routes and accepts whole dotted numeric version segments',()=>{
  for(const endpoint of ['fal/ideogram-v3','fal-ai/ideogram/v3','ideogram/v4','ideogram/v4/edit','fixture_engine/model-2','model','123/route_1','ideogram/v4.5','ideogram/v4.5/edit','provider/v12.3.40/model','v4.5','a'.repeat(256)]){
    const value=record(endpoint),before=structuredClone(value);assert.doesNotThrow(()=>providerRecord(value),endpoint);assert.deepEqual(value,before);
  }
});

test('dotted version support never admits URLs, query/header material, traversal or arbitrary dotted names',()=>{
  for(const endpoint of [
    '',null,45,'a'.repeat(257),'/ideogram/v4.5','ideogram/v4.5/','ideogram//v4.5',
    'https://ideogram/v4.5','http://127.0.0.1/ideogram/v4.5','//provider.invalid/v4.5',
    'ideogram/v4.5?token=secret','ideogram/v4.5#fragment','user:password@ideogram/v4.5',
    'ideogram/v4.5\n','ideogram/v4.5\r','ideogram/v4.5\r\nAuthorization: secret','ideogram/v4.5\u2028',
    'ideogram/v4.5\u0000','ideogram/v4.5\t','ideogram/v4.5/edit extra','ideogram\\v4.5',
    'ideogram/../v4.5','ideogram/./v4.5','ideogram/%2e%2e/v4.5','ideogram/v4%2e5','ideogram/v4.5%2fedit',
    'ideogram/model.json','provider.invalid/v4.5','ideogram/model.5','ideogram/4.5','ideogram/V4.5',
    'ideogram/v4.','ideogram/v.5','ideogram/v4..5','ideogram/v4.5beta','ideogram/v4.5-beta','ideogram/v4.5_edit',
    'ideogram/v4.5/..','ideogram/v4.5/.','ideogram/v4.5/edit.json',
  ])assert.throws(()=>providerRecord(record(endpoint)),String(endpoint));
});

test('versioned endpoint acceptance preserves the closed observation-only provider record',()=>{
  for(const endpoint of ['ideogram/v4.5','ideogram/v4.5/edit']){
    for(const [key,value]of [['headers',{Authorization:'secret'}],['transportURL','https://provider.invalid'],['command',{type:'dispatch'}],['outbox',{}]])assert.throws(()=>providerRecord({...record(endpoint),[key]:value}));
    assert.throws(()=>providerRecord({...record(endpoint),class:'backend-transport'}));
    assert.throws(()=>providerRecord({...record(endpoint),privacyPolicyRef:null}));
    assert.throws(()=>providerRecord({...record(endpoint),safeTimingsRef:{...policy,mediaType:'text/plain'}}));
  }
});
