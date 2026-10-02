import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,unlink,cp} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setup} from '../protocol/helpers.mjs';
import {importRaster,terminal} from '../raster/helpers.mjs';
import {openWriter} from '../../dist/local/server/storage/writer.js';
import {childFor,encode,command,rootFor} from '../store/helpers.mjs';
const auth={clientId:'client_1',sessionHash:'c'.repeat(64),now:Date.now(),expires:Date.now()+1800000};
const objectPath=(root,ref)=>join(root,'objects','sha256',ref.hash.slice(7,9),ref.hash.slice(7));
const release=gate=>{Atomics.store(new Int32Array(gate),0,1);Atomics.notify(new Int32Array(gate),0);};
async function done(w,id){for(let i=0;i<1500;i++){const x=await w.commandState(id);if(x.record)return x.record;await new Promise(r=>setTimeout(r,5));}const diagnosticRead=await w.readDiagnostics();try{throw Error('No terminal receipt '+JSON.stringify(diagnosticRead.value));}finally{diagnosticRead.release();}}
async function seed(t){const f=await setup(t);await terminal(f,f.command({}, {width:3,height:2}));const a=await importRaster(f,'hidden-alpha.png');const imported=f.command({expectedDocumentRevision:'1',body:{type:'ImportAsset',assetId:a.asset.id,layerId:'picture',name:'Picture',draft:null}});assert.equal((await terminal(f,imported)).json.receipt.status,'accepted');const d=(await f.read('/api/v1/documents/document_1')).json.projection.value;await f.server.close();return {...f,...a,document:d};}
for(const corruption of ['missing','changed','same-byte-replacement'])test('history rejects '+corruption+' authoritative dependency after proof, preserves old pixels and receipt',async t=>{
 const f=await seed(t),gate=new SharedArrayBuffer(4);let hit;const barrier=new Promise(r=>hit=r);const w=await openWriter({root:f.root},{phase:'history-after-proofs',gate,onBarrier:hit});t.after(()=>w.close());
 const c=command(f.ref,{expectedDocumentRevision:'2',body:{type:'SetLayerProperties',layerId:'picture',layerVersion:'1',properties:{name:'Changed'},draft:null}});
 const path=objectPath(f.root,f.asset.raster.pixels),original=await readFile(path);await w.historyCommand(encode(c),auth);await barrier;
 if(corruption==='missing')await unlink(path);else if(corruption==='changed')await writeFile(path,Buffer.alloc(original.length));else{await unlink(path);await writeFile(path,original,{mode:0o600});}
 release(gate);const result=await done(w,c.command.commandId);assert.equal(result.receipt.status,'rejected');assert.equal(result.receipt.code,'MISSING_ASSET');assert.deepEqual(await w.document('document_1'),f.document);
 await writeFile(path,original,{mode:0o600});assert.deepEqual(await w.historyCommand(encode(c),auth),result.receipt);
 const fresh=command(f.ref,{expectedDocumentRevision:'2',body:c.command.body});await w.historyCommand(encode(fresh),auth);assert.equal((await done(w,fresh.command.commandId)).receipt.status,'accepted');
});
test('missing hidden/deleted and historical pixels are explicit recovery, never a re-decode on restart',async t=>{
 const f=await seed(t),w=await openWriter({root:f.root});const c=command(f.ref,{expectedDocumentRevision:'2',body:{type:'DeleteLayer',layerId:'picture',layerVersion:'1',draft:null}});await w.historyCommand(encode(c),auth);assert.equal((await done(w,c.command.commandId)).receipt.status,'accepted');const d=await w.document('document_1');await w.close();
 await unlink(objectPath(f.root,f.asset.raster.pixels));const next=await openWriter({root:f.root});t.after(()=>next.close());assert.equal((await next.health()).missingCount>0,true);assert.deepEqual(await next.document('document_1'),d);assert.equal((await next.imageState('document_1')).layers.length,0);
});
test('actual SQLite FULL at acceptance never publishes image revision and same durable identity retries after restart',async t=>{
 const f=await seed(t),setup=await childFor(t,f.root);const pages=await setup.call('diagnosticScalar','settings.page_count');await setup.close();
 const full=await childFor(t,f.root,{maxPageCount:pages});assert.equal(full.startup.type,'ready');
 // The exact long checkpoint name is required user metadata, not truncated.
 const c=command(f.ref,{expectedDocumentRevision:'2',body:{type:'SaveCheckpoint',name:'Disk failure checkpoint '.repeat(1000)}});
 let result;try{result=await full.call('historyCommand',encode(c),auth);}catch(e){assert.equal(e.code,'STORAGE_FULL');}
 await new Promise(r=>setTimeout(r,150));const record=await full.call('lookup',c.command.commandId);assert.equal(record,null);assert.deepEqual(await full.call('document','document_1'),f.document);
 const pending=await full.call('commandState',c.command.commandId);await full.assertNoEffects();await full.close();
 const restored=await openWriter({root:f.root});t.after(()=>restored.close());await restored.historyCommand(encode(c),auth);const final=await done(restored,c.command.commandId);
 // The command exceeds the event ceiling and is honestly rejected after the
 // journal can write again; the original metadata and prior document survive.
 assert.equal(final.receipt.status,'rejected');assert.equal(final.receipt.code,'CAPACITY');assert.equal(final.command.body.name,c.command.body.name);assert.deepEqual(await restored.document('document_1'),f.document);
 if(pending.pending)assert.equal(final.hash,pending.pending.hash);
});
test('frozen export and a separate UI intent retain independent revisions',async t=>{
 const f=await seed(t),gate=new SharedArrayBuffer(4);let hit;const barrier=new Promise(r=>hit=r);const w=await openWriter({root:f.root},{phase:'history-after-proofs',gate,onBarrier:hit});t.after(()=>w.close());
 const c=command(f.ref,{expectedDocumentRevision:'2',body:{type:'ExportDocument',historyHead:f.document.historyHead}});await w.historyCommand(encode(c),auth);await barrier;
 // A queued, separate UI change cannot change the frozen image export. The
 // public domain queue itself is deliberately serialized by the sole owner.
 const ui=w.uiPersist(encode({protocolVersion:1,requestId:'focus_request',sessionId:'ui',expectedUISeq:'0',body:{type:'FocusRequested',target:'canvas',generation:'1'}}),auth);release(gate);await ui;
 const exported=await done(w,c.command.commandId);assert.equal(exported.receipt.status,'accepted');assert.equal(exported.receipt.documentRevision,'2');assert.deepEqual(await w.document('document_1'),f.document);
});
test('UI checkpoint SQLite FULL leaves prior preferences and receipt absent, exact retry succeeds',async t=>{
 const f=await seed(t),setup=await childFor(t,f.root),pages=await setup.call('diagnosticScalar','settings.page_count');await setup.close();
 const full=await childFor(t,f.root,{maxPageCount:pages});const request={protocolVersion:1,requestId:'preferences_full',sessionId:'ui',expectedUISeq:'0',body:{type:'SetPreferences',preferences:{documentId:'document_1',tool:'select',viewport:{x:0,y:0,zoom:1},panels:{left:280,right:280,active:'layers'},selectedLayerIds:Array.from({length:100},(_,i)=>String(i).padStart(128,'x'))}}};
 await assert.rejects(full.call('uiPersist',encode(request),auth),{code:'STORAGE_FULL'});assert.equal((await full.call('uiRead','ui',auth)).uiSeq,'0');assert.deepEqual(await full.call('document','document_1'),f.document);await full.close();
 const w=await openWriter({root:f.root});t.after(()=>w.close());const result=await w.uiPersist(encode(request),auth);assert.equal(result.status,'accepted');assert.equal(result.uiSeq,'1');assert.deepEqual(await w.uiPersist(encode(request),auth),result);assert.equal((await w.uiRead('ui',auth)).reconciledLayerIds.length,100);
});
