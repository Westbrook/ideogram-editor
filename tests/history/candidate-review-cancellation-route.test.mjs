import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, call, mutationHeaders, cookieFrom } from '../protocol/helpers.mjs';
import { AssetRoutes } from '../../dist/local/server/assets.js';

const commandId='unknown_candidate_review';
const route=id=>'/api/v1/commands/'+id+'/cancel-candidate-review';
const body=id=>({protocolVersion:1,commandId:id});

test('candidate-review cancellation requires mutation authentication and permits POST only',async t=>{
 // The production monotonic clock can include a fractional millisecond.
 let now=Date.now()+0.75;const f=await setup(t,{now:()=>now});
 for(const headers of [
  {Origin:f.server.origin,Cookie:cookieFrom(f.paired)},
  {...mutationHeaders(f.server,f.paired),Origin:'http://evil.invalid'},
  {...mutationHeaders(f.server,f.paired),'X-App-CSRF':'invalid'}
 ]){
  const result=await call(f.server.origin,route(commandId),{method:'POST',headers,body:body(commandId)});
  assert.equal(result.status,403,result.text);
 }
 const wrongMethod=await f.read(route(commandId));
 assert.equal(wrongMethod.status,405,wrongMethod.text);
 assert.equal(wrongMethod.headers.allow,'POST');
 const unknown=await f.post(route(commandId),body(commandId));
 assert.equal(unknown.status,404,unknown.text);
 assert.equal(unknown.json.error.code,'NOT_FOUND');
 now+=30*60*1000;
 const expired=await f.post(route(commandId),body(commandId));
 assert.equal(expired.status,401,expired.text);
 assert.equal(expired.json.error.code,'SESSION_REQUIRED');
});

test('candidate-review cancellation accepts only an exact versioned command identity',async t=>{
 const f=await setup(t);
 for(const invalid of [
  null,[],{},
  {protocolVersion:1},
  {commandId},
  {protocolVersion:2,commandId},
  {protocolVersion:1,commandId:'another_command'},
  {protocolVersion:1,commandId:null},
  {protocolVersion:1,commandId,extra:true}
 ]){
  const result=await f.post(route(commandId),invalid);
  assert.equal(result.status,400,result.text);
  assert.equal(result.json.error.code,'MALFORMED_REQUEST');
 }
 const duplicate=await call(f.server.origin,route(commandId),{method:'POST',headers:mutationHeaders(f.server,f.paired),raw:Buffer.from('{"protocolVersion":1,"commandId":"'+commandId+'","commandId":"'+commandId+'"}')});
 assert.equal(duplicate.status,400,duplicate.text);
 assert.equal(duplicate.json.error.code,'MALFORMED_REQUEST');
 for(const url of [route(commandId)+'?extra=1',route('x'.repeat(129))]){
  const result=await f.post(url,body(commandId));
  assert.equal(result.status,400,result.text);
  assert.equal(result.json.error.code,'MALFORMED_REQUEST');
 }
});


test('authenticated asset authority preserves identity and never extends either fractional session limit',()=>{
 for(const limit of [{expires:1000.75,idle:2000.5},{expires:2000.5,idle:1000.75}]){
  let now=999.75;
  const routes=new AssetRoutes(null,()=>now);
  const session=Object.freeze({clientId:'client_1',cookieHash:'a'.repeat(64),csrf:'unused',...limit});
  assert.deepEqual(routes.auth(session),{clientId:'client_1',sessionHash:'a'.repeat(64),expires:1000,now:999});
  // At the retained whole-millisecond deadline, the authority is already expired.
  now=1000.25;
  const expired=routes.auth(session);
  assert.equal(expired.now,1000);assert.equal(expired.expires,1000);
  assert.ok(expired.now>=expired.expires);
  assert.deepEqual(session,{clientId:'client_1',cookieHash:'a'.repeat(64),csrf:'unused',...limit});
 }
});
