import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { openWriter } from '../../dist/local/server/storage/writer.js';
import { rootFor,command,expectedBytes,refFor,zeroEffects } from '../store/helpers.mjs';
import { call,exchange,cookieFrom,readHeaders } from '../session/helpers.mjs';
async function child(t,root,phase=''){
  const p=fork(fileURLToPath(new URL('./process-fixture.mjs',import.meta.url)),[root,phase],{execArgv:['--import',fileURLToPath(new URL('./no-effects.mjs',import.meta.url))],env:{PATH:process.env.PATH},stdio:['ignore','ignore','pipe','ipc']});
  const waiting=new Map(),queued=new Map();let errors='';p.stderr.on('data',b=>errors+=b);p.on('message',m=>{const w=waiting.get(m.type);if(w){waiting.delete(m.type);w(m);}else queued.set(m.type,m);});
  const wait=type=>queued.has(type)?Promise.resolve(queued.get(type)):new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(errors||'Process timeout '+type)),10000);waiting.set(type,m=>{clearTimeout(timer);resolve(m);});});
  const exited=once(p,'exit');t.after(async()=>{if(p.exitCode===null&&p.signalCode===null){p.kill('SIGKILL');await exited;}});const {origin}=await wait('ready');
  return {p,origin,wait,async kill(){p.kill('SIGKILL');await exited;},async pair(oldCookie){p.send('pair');const {url}=await wait('pair');queued.delete('pair');return call(origin,'/api/v1/session/bootstrap',{method:'POST',headers:{Origin:origin,...oldCookie?{Cookie:oldCookie}:{}},body:{protocolVersion:1,pairingToken:new URL(url).hash.slice(9)}});}};
}
for(const phase of ['before-commit','after-commit'])test('real HTTP SIGKILL '+phase+' preserves exact retry identity and invalidates old session/context',async t=>{
  const root=await rootFor(t);const w=await openWriter({root});const ref=await w.putObject([expectedBytes],refFor(expectedBytes),w.epoch);await w.close();
  const first=await child(t,root,phase);const paired=await first.pair();const cookie=cookieFrom(paired);const c=command(ref,{clientId:paired.json.clientId});
  const page=await call(first.origin,'/api/v1/events?after=0',{headers:readHeaders(cookie)});const rid=page.json.recovery.recoveryId;
  const post=exchange(first.origin,'/api/v1/commands',{method:'POST',body:c,headers:{Origin:first.origin,Cookie:cookie,'X-App-Csrf':paired.json.csrfToken}});const failed=post.response.catch(()=>null);
  await first.wait('barrier');first.p.send('effects');assert.deepEqual((await first.wait('effects')).value,zeroEffects);await first.kill();assert.equal(await failed,null);
  const next=await child(t,root);assert.equal((await call(next.origin,'/api/v1/session',{headers:readHeaders(cookie)})).status,401);
  const renewed=await next.pair(cookie);assert.equal(renewed.json.clientId,c.command.clientId);const read=path=>call(next.origin,path,{headers:readHeaders(cookieFrom(renewed))});
  const lookup=await read('/api/v1/commands/'+c.command.commandId);assert.equal(lookup.status,phase==='before-commit'?404:200);
  assert.equal((await read('/api/v1/events?after=0&recoveryId='+rid)).status,410);
  const retried=await call(next.origin,'/api/v1/commands',{method:'POST',body:c,headers:{Origin:next.origin,Cookie:cookieFrom(renewed),'X-App-Csrf':renewed.json.csrfToken}});assert.equal(retried.json.receipt.status,'accepted');assert.equal(retried.json.receipt.fromSeq,'1');
  if(phase==='after-commit')assert.deepEqual(retried.json,lookup.json);
  assert.equal((await read('/api/v1/events?after=0')).json.recovery.highWater,'1');next.p.send('effects');assert.deepEqual((await next.wait('effects')).value,zeroEffects);
});
