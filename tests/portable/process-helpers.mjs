import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {call,cookieFrom,readHeaders,mutationHeaders} from '../session/helpers.mjs';
import {zeroEffects} from '../store/helpers.mjs';
export async function child(t,root,phase=''){
 const p=fork(fileURLToPath(new URL('../protocol/process-fixture.mjs',import.meta.url)),[root,phase],{execArgv:['--import',fileURLToPath(new URL('../protocol/no-effects.mjs',import.meta.url))],env:{PATH:process.env.PATH},stdio:['ignore','ignore','pipe','ipc']});
 const waiting=new Map(),queued=new Map();let errors='',writerFailures=0;p.stderr.on('data',b=>errors+=b);p.on('message',m=>{
  if(m.type==='writer-failure'){
   if(writerFailures>=17)return;writerFailures++;
   t.diagnostic('Guarded writer failure '+JSON.stringify(m.truncated===true?{truncated:true}:{occurrence:m.occurrence,code:m.failure?.code??null,sqliteCode:m.failure?.sqliteCode??null}));
   return;
  }
  const w=waiting.get(m.type);if(w){waiting.delete(m.type);w(m);}else queued.set(m.type,m);});
 const wait=type=>{if(queued.has(type)){const v=queued.get(type);queued.delete(type);return Promise.resolve(v);}return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(errors||'Timeout '+type)),10000);waiting.set(type,m=>{clearTimeout(timer);resolve(m);});});};
 const exited=once(p,'exit');t.after(async()=>{if(p.exitCode===null&&p.signalCode===null){p.kill('SIGKILL');await exited;}});const{origin}=await wait('ready');
 const c={p,origin,wait,server:{origin},paired:null,read:path=>call(origin,path,{headers:readHeaders(cookieFrom(c.paired))}),post:(path,body)=>call(origin,path,{method:'POST',body,headers:mutationHeaders(c.server,c.paired)}),async kill(){p.kill('SIGKILL');await exited;},async pair(cookie){p.send('pair');const{url}=await wait('pair');c.paired=await call(origin,'/api/v1/session/bootstrap',{method:'POST',headers:{Origin:origin,...cookie?{Cookie:cookie}:{}},body:{protocolVersion:1,pairingToken:new URL(url).hash.slice(9)}});return c.paired;},async effects(){p.send('effects');assert.deepEqual((await wait('effects')).value,zeroEffects);}};
 return c;
}
