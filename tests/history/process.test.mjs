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
import {original,importRaster,terminal,eventFor,digest,binary} from '../raster/helpers.mjs';
import {canonical} from '../../dist/local/server/storage/canonical.js';
async function child(t,root,phase=''){
 const p=fork(fileURLToPath(new URL('../protocol/process-fixture.mjs',import.meta.url)),[root,phase],{execArgv:['--import',fileURLToPath(new URL('../protocol/no-effects.mjs',import.meta.url))],env:{PATH:process.env.PATH},stdio:['ignore','ignore','pipe','ipc']});
 const waiting=new Map(),queued=new Map();let errors='';p.stderr.on('data',b=>errors+=b);p.on('message',m=>{const w=waiting.get(m.type);if(w){waiting.delete(m.type);w(m);}else queued.set(m.type,m);});
 const wait=type=>{if(queued.has(type)){const v=queued.get(type);queued.delete(type);return Promise.resolve(v);}return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(errors||'Timeout '+type)),10000);waiting.set(type,m=>{clearTimeout(timer);resolve(m);});});};
 const exited=once(p,'exit');t.after(async()=>{if(p.exitCode===null&&p.signalCode===null){p.kill('SIGKILL');await exited;}});const{origin}=await wait('ready');
 const c={p,origin,wait,server:{origin},paired:null,read:path=>call(origin,path,{headers:readHeaders(cookieFrom(c.paired))}),post:(path,body)=>call(origin,path,{method:'POST',body,headers:mutationHeaders(c.server,c.paired)}),async kill(){p.kill('SIGKILL');await exited;},async pair(cookie){p.send('pair');const{url}=await wait('pair');c.paired=await call(origin,'/api/v1/session/bootstrap',{method:'POST',headers:{Origin:origin,...cookie?{Cookie:cookie}:{}},body:{protocolVersion:1,pairingToken:new URL(url).hash.slice(9)}});return c.paired;},async effects(){p.send('effects');assert.deepEqual((await wait('effects')).value,zeroEffects);}};
 return c;
}

const phases=['history-preparation-before-commit','history-preparation-after-commit','history-after-proofs','history-before-register','history-before-event','history-before-commit','history-after-commit'];
for(const phase of phases)test('SIGKILL '+phase+' retains image command identity, complete transaction and exact restart pixels',async t=>{
 const f=await setup(t);const created=await terminal(f,f.command({}, {width:3,height:2}));assert.equal(created.json.receipt.status,'accepted');
 const image=await importRaster(f,'hidden-alpha.png'),expected=(await binary(f,image.asset.id)).bytes,cookie=cookieFrom(f.paired);await f.server.close();
 const first=await child(t,f.root,phase);await first.pair(cookie);const oldCookie=cookieFrom(first.paired);
 const c=command(EMPTY_EXPECTED_VERSIONS,{clientId:first.paired.json.clientId,expectedDocumentRevision:'1',body:{type:'ImportAsset',assetId:image.asset.id,layerId:'picture',name:'Picture',draft:null}});
 const delivered=first.post('/api/v1/commands',c).catch(()=>null);await first.wait('barrier');await first.effects();await first.kill();await delivered;
 const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true}),pending=db.prepare('SELECT * FROM history_preparations WHERE id=?').get(c.command.commandId),saved=db.prepare('SELECT * FROM commands WHERE id=?').get(c.command.commandId),events=db.prepare('SELECT * FROM events_v2 WHERE command_id=?').all(c.command.commandId);
 if(phase==='history-preparation-before-commit'){assert.equal(pending,undefined);assert.equal(saved,undefined);}else{assert.ok(pending||saved);assert.equal((pending??saved).original,JSON.stringify(c));assert.equal((pending??saved).hash,digest(canonical(c)));}
 assert.equal(events.length,phase==='history-after-commit'?2:0);db.close();
 const next=await child(t,f.root);await next.pair(oldCookie);const done=await terminal(next,c);assert.equal(done.json.receipt.status,'accepted',done.text);assert.equal(BigInt(done.json.receipt.toSeq)-BigInt(done.json.receipt.fromSeq),1n);
 const d=(await next.read('/api/v1/documents/document_1')).json.projection.value;assert.equal(d.revision,'2');if(pending)assert.equal(d.historyHead,pending.operation_id);
 assert.deepEqual((await binary(next,d.image.compositeAssetId)).bytes,expected);assert.deepEqual((await next.post('/api/v1/commands',c)).json,done.json);
 assert.equal((await next.post('/api/v1/commands',{...c,command:{...c.command,sessionId:'changed'}})).status,409);await next.effects();
});

for(const phase of ['image-edit-preparation-after-commit','history-after-proofs','image-edit-before-commit','image-edit-after-commit'])test('SIGKILL approved resampling '+phase+' retains the exact command and expires uncommitted review authority',async t=>{
 const f=await setup(t);await terminal(f,f.command({}, {width:2,height:2}));const image=await importRaster(f,'white.png');
 await terminal(f,f.command({expectedDocumentRevision:'1',body:{type:'ImportAsset',assetId:image.asset.id,layerId:'picture',name:'Picture',draft:null}}));
 const pc=f.command({expectedDocumentRevision:'2',body:{type:'PrepareImageResample',layerId:'picture',layerVersion:'1',width:2,height:2}}),pr=await terminal(f,pc);
 const preview=(await f.read('/api/v1/events?after='+String(BigInt(pr.json.receipt.fromSeq)-1n))).json.batches[0].events.at(-1).payload.preview;
 const cookie=cookieFrom(f.paired);await f.server.close();const first=await child(t,f.root,phase);await first.pair(cookie);
 const rc=command(EMPTY_EXPECTED_VERSIONS,{clientId:first.paired.json.clientId,expectedDocumentRevision:'2',body:{type:'ReviewImageEdit',previewId:preview.previewId}}),rr=await terminal(first,rc);
 const re=(await first.read('/api/v1/events?after='+String(BigInt(rr.json.receipt.fromSeq)-1n))).json.batches[0].events.at(-1).payload,review=(await first.read('/api/v1/image-edit-reviews/'+re.reviewId)).json;
 const c=command(EMPTY_EXPECTED_VERSIONS,{clientId:first.paired.json.clientId,expectedDocumentRevision:'2',body:{type:'ResampleImage',previewId:preview.previewId,reviewId:review.reviewId,reviewHash:review.reviewHash,draft:null}}),oldCookie=cookieFrom(first.paired);
 const sent=first.post('/api/v1/commands',c).catch(()=>null);await first.wait('barrier');await first.effects();await first.kill();await sent;
 const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true}),pending=db.prepare('SELECT * FROM history_preparations WHERE id=?').get(c.command.commandId),saved=db.prepare('SELECT * FROM commands WHERE id=?').get(c.command.commandId);assert(pending||saved);assert.equal((pending??saved).original,JSON.stringify(c));assert.equal((pending??saved).hash,digest(canonical(c)));db.close();
 const next=await child(t,f.root);await next.pair(oldCookie);const done=await terminal(next,c);
 if(phase==='image-edit-after-commit'){assert.equal(done.json.receipt.status,'accepted');assert.equal((await next.read('/api/v1/documents/document_1')).json.projection.value.image.compositeAssetId,preview.after.compositeAssetId);}
 else{assert.equal(done.json.receipt.status,'rejected');assert.equal(done.json.rejectionDetails.value.issues[0].code,'IMAGE_REVIEW_EXPIRED');assert.equal((await next.read('/api/v1/documents/document_1')).json.projection.value.revision,'2');}
 assert.deepEqual((await next.post('/api/v1/commands',c)).json,done.json);await next.effects();
});
