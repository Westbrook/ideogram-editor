import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {unlink,writeFile,readFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {setup,copy,preview,workspace,terminal,edit,doc,upload} from './helpers.mjs';
import {importRaster} from '../raster/helpers.mjs';
import {openWriter} from '../../dist/local/server/storage/writer.js';
import {command,encode,childFor,rootFor} from '../store/helpers.mjs';
import {Objects} from '../../dist/local/server/storage/objects.js';
import {Texts} from '../../dist/local/server/storage/text.js';
import {Portables} from '../../dist/local/server/storage/portable.js';
import {StoreDatabase} from '../../dist/local/server/storage/database.js';
import {acquireRoot} from '../../dist/local/server/storage/ownership.js';
import {canonical,hashBytes} from '../../dist/local/server/storage/canonical.js';
import {entity} from '../../dist/local/src/protocol/validate.js';
import {unpack} from './archive-fixture.mjs';
import {EMPTY_EXPECTED_VERSIONS} from '../../dist/local/src/protocol/store.js';
const pause=()=>new Promise(r=>setTimeout(r,5));
async function wait(w,c,a){let receipt=await w.portableCommand(encode(c),a);for(let n=0;!receipt&&n<1000;n++){receipt=(await w.commandState(c.command.commandId)).record?.receipt;await pause();}return receipt;}
for(const failure of ['deleted-layer-pixels','hidden-branch-pixels'])test('missing '+failure+' refuses copy and preserves all other current roots',async t=>{
 const f=await setup(t);await terminal(f,f.command({}, {width:3,height:2}));const {asset}=await importRaster(f,'hidden-alpha.png');const first=await edit(f,{type:'ImportAsset',assetId:asset.id,layerId:'picture',name:'Picture',draft:null});
 if(failure==='deleted-layer-pixels')await edit(f,{type:'DeleteLayer',layerId:'picture',layerVersion:'1',draft:null});else{const h=await edit(f,{type:'SetLayerProperties',layerId:'picture',layerVersion:'1',properties:{visible:false},draft:null});await edit(f,{type:'Undo',historyHead:h.document.historyHead});await edit(f,{type:'SetLayerProperties',layerId:'picture',layerVersion:'1',properties:{name:'Other branch'},draft:null});}
 const path=join(f.root,'objects','sha256',asset.raster.pixels.hash.slice(7,9),asset.raster.pixels.hash.slice(7)),bytes=await readFile(path),before=await doc(f),db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true}),roots=db.prepare('SELECT * FROM roots ORDER BY owner,hash').all();db.close();await unlink(path);
 const c=f.command({expectedDocumentRevision:before.revision,body:{type:'SaveCopy'}}),r=await terminal(f,c);assert.equal(r.json.receipt.status,'rejected');assert.equal(r.json.receipt.code,'MISSING_ASSET');assert.deepEqual(await doc(f),before);const after=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});for(const x of roots)assert(after.prepare('SELECT 1 FROM roots WHERE owner=? AND hash=?').get(x.owner,x.hash));assert.equal(after.prepare('SELECT count(*) n FROM portable_bundles').get().n,0);after.close();await writeFile(path,bytes,{mode:0o600});await copy(f);assert.deepEqual((await terminal(f,c)).json.receipt,r.json.receipt);
});
test('durable preparation remains pinned and cancellation releases only its owned pins after terminal rejection',async t=>{
 const f=await setup(t);await terminal(f,f.command({}, {width:1,height:1}));await f.server.close();const gate=new SharedArrayBuffer(4);let hit;const reached=new Promise(r=>hit=r),a={clientId:f.paired.json.clientId,sessionHash:'b'.repeat(64),now:Date.now(),expires:Date.now()+1800000};let w=await openWriter({root:f.root},{phase:'portable-preparation-after-commit',gate,onBarrier:hit});const c=command(EMPTY_EXPECTED_VERSIONS,{clientId:a.clientId,expectedDocumentRevision:'1',body:{type:'SaveCopy'}}),sent=w.portableCommand(encode(c),a);await reached;const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true}),pins=db.prepare('SELECT * FROM portable_pins').all(),operation=db.prepare('SELECT operation_id FROM portable_preparations').get().operation_id;db.close();assert(pins.length>0);Atomics.store(new Int32Array(gate),0,1);Atomics.notify(new Int32Array(gate),0);await sent;
 // The writer may already be working; cancellation fences its next yielded step.
 const cancelled=command(EMPTY_EXPECTED_VERSIONS,{clientId:a.clientId,documentId:null,expectedDocumentRevision:null,body:{type:'CancelPortable',operationId:operation}});const result=await wait(w,cancelled,a);assert.equal(result.status,'accepted');let final;for(let n=0;n<1000;n++){final=(await w.commandState(c.command.commandId)).record;if(final)break;await pause();}assert.equal(final.receipt.status,'rejected');assert.deepEqual(await w.portableCommand(encode(cancelled),a),result);const end=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});assert.equal(end.prepare('SELECT count(*) n FROM portable_pins WHERE operation_id=?').get(operation).n,0);assert.equal(end.prepare('SELECT count(*) n FROM portable_bundles').get().n,0);assert(end.prepare('SELECT count(*) n FROM roots').get().n>0);end.close();await w.close();
});
test('review UI mappings page every imported checkpoint without a session count cap',async t=>{
 const f=await setup(t);await terminal(f,f.command({}, {width:1,height:1}));for(let i=0;i<105;i++){const sessionId='editor_'+String(i).padStart(3,'0'),r=await f.post('/api/v1/ui/'+sessionId,{protocolVersion:1,requestId:randomUUID(),sessionId,expectedUISeq:'0',body:{type:'SetPreferences',preferences:{documentId:'document_1',tool:'select',viewport:{x:0,y:0,zoom:1},panels:{left:280,right:280,active:'layers'},selectedLayerIds:[]}}});assert.equal(r.json.status,'accepted');}t.diagnostic('UI checkpoints persisted');const saved=await copy(f);t.diagnostic('Archive copied');const p=await preview(f,saved.bytes);t.diagnostic('Archive reviewed');assert.equal(p.review.uiSessionCount,'105');assert.equal(p.review.uiSessionIds.length,64);const first=(await f.read('/api/v1/bundle-reviews/'+p.review.reviewId+'/mapping?kind=ui')).json,second=(await f.read('/api/v1/bundle-reviews/'+p.review.reviewId+'/mapping?kind=ui&after='+first.next)).json;t.diagnostic('Mapping pages read');assert.equal(first.items.length,100);assert.equal(second.items.length,5);assert.equal(second.next,null);assert.equal(new Set([...first.items,...second.items].map(x=>x.localId)).size,105);await workspace(f,{type:'ImportBundle',reviewId:p.review.reviewId,reviewHash:p.review.reviewHash});t.diagnostic('Fresh namespace accepted');for(const x of [...first.items,...second.items])assert.equal((await f.read('/api/v1/ui/'+x.localId)).json.preferences.documentId,p.review.documentId);
});
for(const recovery of ['same-authority-retry','restart-expired-review'])test('actual SQLite FULL preserves identity and source through '+recovery,async t=>{
 const f=await setup(t);await terminal(f,f.command({}, {width:1,height:1}));
 for(let i=0;i<180;i++){
  const sessionId='session_'+i;assert.equal((await f.post('/api/v1/ui/'+sessionId,{protocolVersion:1,requestId:randomUUID(),sessionId,expectedUISeq:'0',body:{type:'SetPreferences',preferences:{documentId:'document_1',tool:'select',viewport:{x:0,y:0,zoom:1},panels:{left:280,right:280,active:'layers'},selectedLayerIds:[]}}})).json.status,'accepted');
 }
 const saved=await copy(f),s=await upload(f,saved.bytes),a={clientId:f.paired.json.clientId,sessionHash:'b'.repeat(64),now:Date.now(),expires:Date.now()+1800000};await f.server.close();
 let w=await openWriter({root:f.root});await w.rememberClient(a.sessionHash,a.clientId,a.expires);let pages;{const diagnosticRead=await w.readDiagnostics();try{pages=diagnosticRead.value.settings.page_count;}finally{diagnosticRead.release();}}await w.close();
 const limit=pages+512,full=await childFor(t,f.root,{maxPageCount:limit,phase:'portable-import-after-proofs'}),adapter={portableCommand:(...args)=>full.call('portableCommand',...args),commandState:(...args)=>full.call('commandState',...args)};
 assert.equal(await full.call('diagnosticScalar','settings.max_page_count'),limit);
 const c=body=>command(EMPTY_EXPECTED_VERSIONS,{clientId:a.clientId,documentId:null,expectedDocumentRevision:null,body});
 const reviewReceipt=await wait(adapter,c({type:'PreviewBundleImport',stagingId:s.stagingId,expectedSha256:s.sha256}),a);assert.equal(reviewReceipt?.status,'accepted');
 const e=(await full.call('events',String(BigInt(reviewReceipt.fromSeq)-1n))).events[0],review=await full.call('bundleReview',e.payload.reviewId,a),accepted=c({type:'ImportBundle',reviewId:review.reviewId,reviewHash:review.reviewHash});
 assert.equal(await adapter.portableCommand(encode(accepted),a),null);await full.wait('barrier');
 const inspect=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true}),pendingBefore=inspect.prepare('SELECT * FROM portable_preparations WHERE id=?').get(accepted.command.commandId);
 assert.equal(pendingBefore.original,JSON.stringify(accepted));assert.equal(pendingBefore.hash,'sha256:'+createHash('sha256').update(pendingBefore.canonical).digest('hex'));
 const sourceTables=['documents','history','checkpoints','objects','roots','commands','events_v2','assets','asset_dependencies','ui_checkpoints','ui_events','ui_receipts','staged_assets','portable_reviews','portable_review_sources','portable_review_maps','portable_pins'];
 const originalRows=Object.fromEntries(sourceTables.map(table=>[table,inspect.prepare('SELECT * FROM '+table+' ORDER BY 1,2').all()]));inspect.close();
 // Deliberate fault injection in this disposable SQLite file only. Consume its
 // free pages after the real preparation is durable and before final acceptance.
 // No production setter or fabricated error code is used.
 const fill=new DatabaseSync(join(f.root,'metadata.sqlite'));fill.exec('PRAGMA max_page_count='+limit);fill.exec('CREATE TABLE portable_fault_filler(id INTEGER PRIMARY KEY,bytes BLOB NOT NULL) STRICT');
 let fillerRows=0,nativeCode;try{for(;;){fill.prepare('INSERT INTO portable_fault_filler(bytes) VALUES (zeroblob(4096))').run();fillerRows++;}}catch(e){nativeCode=e.errcode;assert.equal(nativeCode,13);}finally{fill.close();}
 await full.call('release');let waiting;
 for(let n=0;n<2000;n++){waiting=await full.call('portableInventory','',a);if(waiting.items.find(x=>x.commandId===accepted.command.commandId)?.reason||await full.call('lookup',accepted.command.commandId))break;await pause();}
 assert.equal(waiting.items.find(x=>x.commandId===accepted.command.commandId)?.reason,'STORAGE_FULL',JSON.stringify({waiting,terminal:await full.call('lookup',accepted.command.commandId),diagnostics:await full.call('diagnosticJSON','all')}));assert.equal(await full.call('lookup',accepted.command.commandId),null);assert.equal(await full.call('document',review.documentId),null);
 const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});assert.equal(db.prepare('SELECT count(*) n FROM portable_namespaces').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM portable_rows').get().n,0);
 const pendingAfter=db.prepare('SELECT * FROM portable_preparations WHERE id=?').get(accepted.command.commandId);for(const key of ['id','hash','original','canonical','operation_id','frozen','confirmed_at'])assert.equal(pendingAfter[key],pendingBefore[key],key);
 assert.equal(waiting.items.find(x=>x.commandId===accepted.command.commandId).operationId,pendingBefore.operation_id);assert.equal(waiting.items.find(x=>x.commandId===accepted.command.commandId).phase,'waiting-for-resources');
 for(const table of sourceTables)assert.deepEqual(db.prepare('SELECT * FROM '+table+' ORDER BY 1,2').all(),originalRows[table],table);
 const name=db.prepare('SELECT filename FROM staged_assets WHERE id=?').get(s.stagingId).filename;db.close();assert.deepEqual(await readFile(join(f.root,'uploads',name)),saved.bytes);await full.assertNoEffects();
 if(recovery==='restart-expired-review')await full.close();
 const restore=new DatabaseSync(join(f.root,'metadata.sqlite'));restore.exec('DROP TABLE portable_fault_filler');const restoredFreePages=restore.prepare('PRAGMA freelist_count').get().freelist_count;assert(restoredFreePages>128);restore.close();
 let acceptedReceipt,acceptedCommand=accepted,freshReview=review;
 if(recovery==='same-authority-retry'){
  acceptedReceipt=await wait(adapter,accepted,a);assert.equal(acceptedReceipt?.status,'accepted',JSON.stringify({waiting:await full.call('portableInventory','',a),diagnostics:await full.call('diagnosticJSON','all')}));assert.deepEqual(await wait(adapter,accepted,a),acceptedReceipt);await full.assertNoEffects();await full.close();
  w=await openWriter({root:f.root});t.after(()=>w.close());assert.deepEqual(await wait(w,accepted,a),acceptedReceipt);assert(await w.document(review.documentId));
 }else{
  w=await openWriter({root:f.root});t.after(()=>w.close());const retry=await wait(w,accepted,a);assert.equal(retry.status,'rejected');assert.equal(await w.document(review.documentId),null);assert.deepEqual(await wait(w,accepted,a),retry);
  const detail=JSON.parse(await readFile(join(f.root,'objects','sha256',retry.details.hash.slice(7,9),retry.details.hash.slice(7)),'utf8'));assert.equal(detail.issues[0].code,'BUNDLE_REVIEW_EXPIRED');
  const next=await wait(w,c({type:'PreviewBundleImport',stagingId:s.stagingId,expectedSha256:s.sha256}),a);assert.equal(next.status,'accepted');const event=(await w.events(String(BigInt(next.fromSeq)-1n))).events[0];freshReview=await w.bundleReview(event.payload.reviewId,a);
  acceptedCommand=c({type:'ImportBundle',reviewId:freshReview.reviewId,reviewHash:freshReview.reviewHash});assert.notEqual(acceptedCommand.command.commandId,accepted.command.commandId);assert.notEqual(freshReview.reviewId,review.reviewId);
  acceptedReceipt=await wait(w,acceptedCommand,a);assert.equal(acceptedReceipt?.status,'accepted');assert.deepEqual(await wait(w,acceptedCommand,a),acceptedReceipt);assert.deepEqual(await wait(w,accepted,a),retry);assert(await w.document(freshReview.documentId));
 }
 const end=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});assert.equal(end.prepare('SELECT count(*) n FROM portable_namespaces').get().n,1);assert.equal(end.prepare('SELECT count(*) n FROM events_v2 WHERE command_id=?').get(acceptedCommand.command.commandId).n,1);assert.equal(end.prepare('SELECT count(*) n FROM portable_preparations WHERE id=?').get(accepted.command.commandId).n,0);assert.equal(end.prepare('SELECT count(*) n FROM portable_pins WHERE operation_id=?').get(pendingBefore.operation_id).n,0);end.close();
 t.diagnostic(JSON.stringify({recovery,sqlitePageLimit:limit,restoredFreePages,fillerRows,nativeSQLiteCode:nativeCode,actualNamespaceRowsAfterFailure:0,observedFailure:waiting.items.find(x=>x.commandId===accepted.command.commandId).reason,sourceTablesPreserved:sourceTables,originalSourcePreserved:true,originalCommandId:accepted.command.commandId,originalCommandHash:pendingBefore.hash,originalOperationId:pendingBefore.operation_id,originalReviewId:review.reviewId,acceptedCommandId:acceptedCommand.command.commandId,acceptedReviewId:freshReview.reviewId,sameOriginalIdentityPreserved:true,singleNamespace:true,singleAcceptedEvent:true,restartRequiresFreshReview:recovery==='restart-expired-review'}));
});


// These private index fixtures are adversarial integrity inputs, not accepted
// restricted-font history or qualified WC specimens. Every byte inspection is
// performed by the unchanged production Texts worker and Objects verifier.
async function fontBytes(fsType=0){
 const profile=JSON.parse(await readFile('src/text/profile.json','utf8')),font=profile.fonts.find(f=>f.id==='NotoSans');
 const bytes=Buffer.from(await readFile('vendor/text/'+font.file)),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 let found=false;
 for(let i=0;i<view.getUint16(4);i++){
  const at=12+i*16;if(bytes.toString('ascii',at,at+4)!=='OS/2')continue;
  const start=view.getUint32(at+8),length=view.getUint32(at+12);view.setUint16(start+8,fsType);let sum=0;
  for(let j=0;j<length;j+=4){let word=0;for(let k=0;k<4;k++)word=word*256+(j+k<length?bytes[start+j+k]:0);sum=(sum+word)>>>0;}
  view.setUint32(at+4,sum);found=true;
 }
 assert(found,'Real SFNT has the OS/2 table');return {bytes,font};
}
async function fontIndex(t){
 const root=await rootFor(t),index=new DatabaseSync(join(root,'font-index.sqlite'));
 index.exec('CREATE TABLE entities(kind TEXT,id TEXT,json TEXT,PRIMARY KEY(kind,id));CREATE TABLE text_admissions(id TEXT PRIMARY KEY,client_id TEXT,session_hash TEXT,epoch TEXT)');
 const objects=new Objects(root,()=>{},()=>{}),texts=new Texts(index,objects,{},'font-export-test'),calls=[],snapshots=[];
 let active=0,peak=0;
 const inspect=texts.inspect.bind(texts);
 texts.inspect=async(...args)=>{calls.push(args[0]);active++;peak=Math.max(peak,active);try{const pending=inspect(...args);assert.equal(texts.reservedCPU,67108864);return await pending;}finally{active--;assert.equal(texts.reservedCPU,0);}};
 t.after(()=>{assert.equal(active,0);assert.equal(texts.reservedCPU,0);texts.closeObservations();objects.close();index.close();});
 const put=(bytes,mediaType)=>{const id=objects.begin(String(bytes.length),mediaType);try{for(let at=0;at<bytes.length;at+=1048576)objects.chunk(id,bytes.subarray(at,at+1048576));return objects.finish(id);}finally{objects.abort(id);}};
 const license=put(Buffer.from('Test fixture uses the retained font license'),'text/plain');
 const add=(id,bytes,fsType=0)=>{
  const blob=put(bytes,'application/octet-stream'),value={schemaVersion:1,bytes:blob,faceIndex:0,format:'static-ttf',parserProfile:'sfnt-static-1-freetype-canvaskit040',fsType,licenseRecord:license,origin:'local-file',embedding:'permitted'},font={...value,id:hashBytes(canonical(value))},asset={id,version:'1',purpose:'font',blob,dependencies:[license],safety:'safe',availability:'available',qualification:'font',measuredMediaType:'application/octet-stream',font};
  entity('asset',asset);index.prepare('INSERT INTO entities VALUES (?,?,?)').run('asset',id,canonical(asset));snapshots.push({blob,bytes:Buffer.from(bytes)});return asset;
 };
 const replace=asset=>{entity('asset',asset);index.prepare("UPDATE entities SET json=? WHERE kind='asset' AND id=?").run(canonical(asset),asset.id);};
 const run=(check=()=>{})=>Portables.prototype.inspectExportFonts.call({objects,texts},index,check);
 const unchanged=async()=>{for(const {blob,bytes}of snapshots)assert.deepEqual(await readFile(objects.path(blob)),bytes);assert.equal(texts.reservedCPU,0);assert.deepEqual(objects.reservationInventory(),{reservedBytes:'0',activeTransfers:0});};
 return {root,index,objects,texts,calls,add,replace,run,unchanged,get peak(){return peak;}};
}
test('export font scan inspects exact shared bytes once, serially, and validates every captured alias',async t=>{
 const f=await fontIndex(t),regular=(await fontBytes()).bytes,editable=(await fontBytes(8)).bytes;
 f.add('z_first',regular);f.add('a_alias',regular);f.add('m_editable',editable,8);
 await f.run();assert.equal(f.calls.length,2);assert.equal(new Set(f.calls.map(ref=>ref.hash)).size,2);assert.equal(f.peak,1);await f.unchanged();
});
test('export font scan with no captured fonts starts no inspector',async t=>{const f=await fontIndex(t);await f.run();assert.deepEqual(f.calls,[]);assert.equal(f.peak,0);await f.unchanged();});
for(const [fault,expected]of [['restricted','FONT_EMBEDDING_RESTRICTED'],['checksum','FONT_TABLE_CHECKSUM']])test('export font scan observes actual '+fault+' SFNT refusal with coherent object hashes',async t=>{
 const f=await fontIndex(t),bytes=(await fontBytes(fault==='restricted'?2:0)).bytes;
 if(fault==='checksum')bytes[bytes.length-12]^=1;
 const a=f.add('adversarial_font',bytes);assert.equal(a.blob.hash,hashBytes(bytes));
 await assert.rejects(f.run(),error=>error.code==='INCOMPATIBLE'&&error.reason===expected);assert.equal(f.calls.length,1);await f.unchanged();
});
test('export font scan rejects a false fsType on a shared-byte alias after the real inspection',async t=>{
 const f=await fontIndex(t),bytes=(await fontBytes()).bytes;f.add('a_truthful',bytes);f.add('z_false_alias',bytes,8);
 await assert.rejects(f.run(),{code:'MALFORMED_REQUEST'});assert.equal(f.calls.length,1);await f.unchanged();
});
test('export font scan checks bundled identity on a shared-byte alias',async t=>{
 const f=await fontIndex(t),bytes=(await fontBytes()).bytes;f.add('a_local',bytes);const a=f.add('z_false_bundled',bytes);
 a.font={...a.font,origin:'bundled'};const {id,...value}=a.font;a.font.id=hashBytes(canonical(value));f.replace(a);
 await assert.rejects(f.run(),{message:'Invalid recovery data'});assert.equal(f.calls.length,1);await f.unchanged();
});
test('export font scan does not reuse inspection for a conflicting length alias',async t=>{
 const f=await fontIndex(t),bytes=(await fontBytes()).bytes;f.add('a_truthful',bytes);const a=f.add('z_wrong_length',bytes);
 a.blob={...a.blob,byteLength:String(bytes.length+1)};a.font={...a.font,bytes:a.blob};const {id,...value}=a.font;a.font.id=hashBytes(canonical(value));f.replace(a);
 await assert.rejects(f.run(),{code:'CORRUPT_OBJECT'});assert.equal(f.calls.length,1);await f.unchanged();
});
for(const fault of ['missing','corrupt'])test('export font scan preserves '+fault+' object refusal before launching a worker',async t=>{
 const f=await fontIndex(t),bytes=(await fontBytes()).bytes,a=f.add('damaged_font',bytes),path=f.objects.path(a.blob);
 if(fault==='missing')await unlink(path);else{const changed=Buffer.from(bytes);changed[0]^=1;await writeFile(path,changed,{mode:0o600});}
 try{await assert.rejects(f.run(),fault==='missing'?{code:'MISSING_ASSET',reason:'PORTABLE_REQUIRED_OBJECT_MISSING',field:'objects/'+a.blob.hash.slice(7)}:{code:'CORRUPT_OBJECT'});assert.deepEqual(f.calls,[]);}
 finally{await writeFile(path,bytes,{mode:0o600});}await f.unchanged();
});
test('export font scan fences cancellation before work and after the actual inspector drains',async t=>{
 const f=await fontIndex(t),bytes=(await fontBytes()).bytes;f.add('a_font',bytes);f.add('z_alias',bytes);
 const cancelled=Error('caller cancelled');await assert.rejects(f.run(()=>{throw cancelled;}),error=>error===cancelled);assert.deepEqual(f.calls,[]);
 const inspect=f.texts.inspect.bind(f.texts);let finished=false;
 f.texts.inspect=async(...args)=>{try{return await inspect(...args);}finally{finished=true;}};
 await assert.rejects(f.run(()=>{if(finished)throw cancelled;}),error=>error===cancelled);assert.equal(f.calls.length,1);await f.unchanged();
});

async function ownedFontStore(t,f){
 await f.server.close();const owner=await acquireRoot(f.root);let db;
 try{db=new StoreDatabase(f.root,()=>{});}catch(error){owner.close();throw error;}
 t.after(async()=>{try{await db.storageRepairs.close();db.storageLibrary.close();db.storageMemory.close();await db.displays.close();await db.candidates.close();await db.queue.close();await db.portables.close();await db.histories.close();await db.rasters.close();await db.assets.close();await db.recovery.settle();db.close();}finally{owner.close();}});
 return db;
}
test('real SaveCopy inspects retained font drafts and preserves cancellation, missing and corrupt refusals',async t=>{
 const f=await setup(t);await terminal(f,f.command({}, {width:1,height:1}));
 const original=await fontBytes(),fontStage=await upload(f,original.bytes,'font','application/octet-stream'),licenseStage=await upload(f,await readFile('vendor/text/'+original.font.licenseFile),'caption','text/plain');
 const fontInput=(await workspace(f,{type:'FinalizeStaging',stagingId:fontStage.stagingId,expectedSha256:fontStage.sha256})).event.payload.asset,license=(await workspace(f,{type:'FinalizeStaging',stagingId:licenseStage.stagingId,expectedSha256:licenseStage.sha256})).event.payload.asset;
 const font=(await edit(f,{type:'ImportFont',source:fontInput.blob,license:license.blob,origin:'local-file',embeddingReviewed:true})).event.payload.asset.font;
 const textStage=await upload(f,Buffer.from('Exact saved draft'),'caption','text/plain'),text=(await workspace(f,{type:'FinalizeStaging',stagingId:textStage.stagingId,expectedSha256:textStage.sha256})).event.payload.asset;
 const draftBytes=Buffer.from(canonical({schemaVersion:1,kind:'text-draft-1',textUtf8:text.blob,style:{},frame:{},fonts:[font]})),draftStage=await upload(f,draftBytes,'caption','text/plain'),draft=(await workspace(f,{type:'FinalizeStaging',stagingId:draftStage.stagingId,expectedSha256:draftStage.sha256})).event.payload.asset;
 const sessionId='font_copy',ui=(await f.read('/api/v1/ui/'+sessionId)).json;
 const saved=await f.post('/api/v1/ui/'+sessionId,{protocolVersion:1,requestId:randomUUID(),sessionId,expectedUISeq:ui.uiSeq,body:{type:'SaveDraft',draft:{id:'text_draft',generation:'1',kind:'text',documentId:'document_1',targetLayerId:null,expectedDocumentRevision:'1',assetId:draft.id,composing:false}}});assert.equal(saved.json.status,'accepted',saved.text);
 const before=await doc(f),db=await ownedFontStore(t,f),auth={clientId:f.paired.json.clientId,sessionHash:'c'.repeat(64),now:Date.now(),expires:Date.now()+1800000};db.rememberClient(auth.sessionHash,auth.clientId,auth.expires);
 const originalInspect=db.texts.inspect.bind(db.texts);let calls=0,cancelTarget;
 db.texts.inspect=async(...args)=>{calls++;const result=await originalInspect(...args);assert.equal(db.texts.reservedCPU,0);if(cancelTarget){const operationId=db.portables.pending(cancelTarget).operationId,c=f.command({documentId:null,expectedDocumentRevision:null,body:{type:'CancelPortable',operationId}});assert.equal(db.portables.command(encode(c),auth).status,'accepted');}return result;};
 async function save(cancel=false){
  const c=f.command({expectedDocumentRevision:before.revision,body:{type:'SaveCopy'}});cancelTarget=cancel?c.command.commandId:undefined;assert.equal(db.portables.command(encode(c),auth),null);let record;
  for(let n=0;n<1000;n++){record=db.lookup(c.command.commandId);if(record)break;await pause();}
  assert(record,'Actual SaveCopy reached its terminal receipt');return {c,record};
 }
 const first=await save();assert.equal(first.record.receipt.status,'accepted');assert.equal(calls,1,'SaveCopy actually called the real font inspector');
 const event=db.events(String(BigInt(first.record.receipt.fromSeq)-1n),100).events.find(e=>e.commandId===first.c.command.commandId),bundle=event.payload.bundle;assert.equal(bundle.complete,true);
 const archive=await unpack(f.root,await readFile(db.objects.path(bundle.blob)));assert.deepEqual(archive.get('objects/'+font.bytes.hash.slice(7)),original.bytes);assert.deepEqual(archive.get('objects/'+draft.blob.hash.slice(7)),draftBytes);
 const second=await save(true);assert.equal(second.record.receipt.status,'rejected');assert.equal(calls,2);const details=JSON.parse(Buffer.from(db.objects.verify(second.record.receipt.details,true)).toString());assert(details.issues.some(issue=>issue.code==='PORTABLE_CANCELLED'));
 const fontPath=db.objects.path(font.bytes);
 for(const fault of ['missing','corrupt']){
  if(fault==='missing')await unlink(fontPath);else{const bytes=Buffer.from(original.bytes);bytes[0]^=1;await writeFile(fontPath,bytes,{mode:0o600});}
  try{
   const failed=await save(),receipt=failed.record.receipt;assert.equal(receipt.status,'rejected');assert.equal(receipt.code,fault==='missing'?'MISSING_ASSET':'INVALID_INPUT');
   const issues=JSON.parse(Buffer.from(db.objects.verify(receipt.details,true)).toString()).issues;
   const expected=fault==='missing'?'PORTABLE_REQUIRED_OBJECT_MISSING':'PORTABLE_CORRUPT_OBJECT';assert(issues.some(issue=>issue.code===expected));
   if(fault==='missing')assert(issues.some(issue=>issue.code===expected&&issue.path==='objects/'+font.bytes.hash.slice(7)));
   assert.equal(calls,2,'Known missing/corrupt bytes never reach the worker');assert.deepEqual(db.document('document_1'),before);
  }finally{await writeFile(fontPath,original.bytes,{mode:0o600});}
 }
 assert.deepEqual(db.document('document_1'),before);assert.equal(db.texts.reservedCPU,0);assert.deepEqual(await readFile(fontPath),original.bytes);
 const state=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});try{assert.equal(state.prepare('SELECT count(*) n FROM portable_bundles').get().n,1);assert.equal(state.prepare('SELECT count(*) n FROM portable_pins').get().n,0);}finally{state.close();}
});
