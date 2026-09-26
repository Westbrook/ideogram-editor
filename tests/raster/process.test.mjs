import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setup,command} from '../protocol/helpers.mjs';
import {EMPTY_EXPECTED_VERSIONS} from '../../dist/local/src/protocol/store.js';
import {call,exchange,cookieFrom,readHeaders,mutationHeaders} from '../session/helpers.mjs';
import {zeroEffects} from '../store/helpers.mjs';
import {original,importRaster,terminal,eventFor,digest,binary} from './helpers.mjs';
import {canonical} from '../../dist/local/server/storage/canonical.js';
async function child(t,root,phase=''){
 const p=fork(fileURLToPath(new URL('../protocol/process-fixture.mjs',import.meta.url)),[root,phase],{execArgv:['--import',fileURLToPath(new URL('../protocol/no-effects.mjs',import.meta.url))],env:{PATH:process.env.PATH},stdio:['ignore','ignore','pipe','ipc']});
 const waiting=new Map(),queued=new Map();let errors='';p.stderr.on('data',b=>errors+=b);p.on('message',m=>{const w=waiting.get(m.type);if(w){waiting.delete(m.type);w(m);}else queued.set(m.type,m);});
 const wait=type=>{if(queued.has(type)){const v=queued.get(type);queued.delete(type);return Promise.resolve(v);}return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(errors||'Timeout '+type)),10000);waiting.set(type,m=>{clearTimeout(timer);resolve(m);});});};
 const exited=once(p,'exit');t.after(async()=>{if(p.exitCode===null&&p.signalCode===null){p.kill('SIGKILL');await exited;}});const{origin}=await wait('ready');
 const c={p,origin,wait,server:{origin},paired:null,read:path=>call(origin,path,{headers:readHeaders(cookieFrom(c.paired))}),post:(path,body)=>call(origin,path,{method:'POST',body,headers:mutationHeaders(c.server,c.paired)}),async kill(){p.kill('SIGKILL');await exited;},async pair(cookie){p.send('pair');const{url}=await wait('pair');c.paired=await call(origin,'/api/v1/session/bootstrap',{method:'POST',headers:{Origin:origin,...cookie?{Cookie:cookie}:{}},body:{protocolVersion:1,pairingToken:new URL(url).hash.slice(9)}});return c.paired;},async effects(){p.send('effects');assert.deepEqual((await wait('effects')).value,zeroEffects);}};
 return c;
}
const phases=['raster-preparation-before-commit','raster-preparation-after-commit','raster-after-worker','raster-before-flush','raster-after-flush','raster-before-rename','raster-after-rename','raster-after-directory-sync','raster-before-register','asset-before-commit','asset-after-commit','raster-after-register'];
for(const phase of phases)test('SIGKILL '+phase+' keeps original raster command, operation and encoded source',async t=>{
 const f=await setup(t),asset=await original(f,'hidden-alpha.png'),cookie=cookieFrom(f.paired);await f.server.close();
 const first=await child(t,f.root,phase);await first.pair(cookie);const oldCookie=cookieFrom(first.paired);
 const c=command(EMPTY_EXPECTED_VERSIONS,{clientId:first.paired.json.clientId,documentId:null,body:{type:'PrepareRaster',assetId:asset.id}}),wire=exchange(first.origin,'/api/v1/commands',{method:'POST',body:c,headers:mutationHeaders(first.server,first.paired)});const delivered=wire.response.catch(()=>null);
 await first.wait('barrier');await first.effects();await first.kill();await delivered;
 const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});const pending=db.prepare('SELECT * FROM raster_preparations WHERE id=?').get(c.command.commandId),saved=db.prepare('SELECT * FROM commands WHERE id=?').get(c.command.commandId);
 if(phase==='raster-preparation-before-commit'){assert.equal(pending,undefined);assert.equal(saved,undefined);}else{assert.ok(pending||saved);const value=pending??saved;assert.equal(value.original,JSON.stringify(c));assert.equal(value.hash,digest(canonical(c)));}db.close();
 const next=await child(t,f.root);await next.pair(oldCookie);assert.equal((await call(next.origin,'/api/v1/session',{headers:readHeaders(oldCookie)})).status,401);
 if(phase==='raster-preparation-before-commit')assert.equal((await next.read('/api/v1/commands/'+c.command.commandId)).status,404);
 const done=await terminal(next,c);assert.equal(done.json.receipt.status,'accepted',done.text);const event=await eventFor(next,done.json.receipt);if(pending)assert.equal(event.payload.asset.id,pending.operation_id);
 assert.deepEqual((await next.post('/api/v1/commands',c)).json,done.json);assert.equal((await next.post('/api/v1/commands',{...c,command:{...c.command,sessionId:'changed'}})).status,409);
 assert.equal((await next.read('/api/v1/assets/'+asset.id+'/content')).status,403);assert.equal((await binary(next,event.payload.asset.id)).status,200);await next.effects();
});
for(const phase of ['raster-before-register','raster-after-register'])test('SIGKILL frozen PNG export '+phase+' reopens exact existing canonical bytes',async t=>{
 const f=await setup(t),image=await importRaster(f,'hidden-alpha.png'),expected=(await binary(f,image.asset.id)).bytes,cookie=cookieFrom(f.paired);await f.server.close();
 const first=await child(t,f.root,phase);await first.pair(cookie);const oldCookie=cookieFrom(first.paired),c=command(EMPTY_EXPECTED_VERSIONS,{clientId:first.paired.json.clientId,documentId:null,body:{type:'ExportRaster',assetId:image.asset.id}});
 const response=first.post('/api/v1/commands',c).catch(()=>null);await first.wait('barrier');await first.kill();await response;
 const next=await child(t,f.root);await next.pair(oldCookie);const done=await terminal(next,c);assert.equal(done.json.receipt.status,'accepted');const event=await eventFor(next,done.json.receipt);assert.deepEqual((await binary(next,event.payload.asset.id)).bytes,expected);await next.effects();
});
