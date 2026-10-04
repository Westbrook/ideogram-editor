import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join,resolve} from 'node:path';
import {unlink,writeFile,readFile,cp,readdir,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
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
import {unpack,records} from './archive-fixture.mjs';
import {EMPTY_EXPECTED_VERSIONS} from '../../dist/local/src/protocol/store.js';
import {CompositionMemory} from '../../dist/local/server/storage/composition-memory.js';
import {validateTransactions} from '../../dist/local/server/portable/transactions.js';
import {productFor} from '../../tooling/qualification/campaigns/backend-portable.mjs';
import {preparePortableFontFault,validateFontFaultDescriptor} from '../../tooling/qualification/campaigns/portable-font-fault.mjs';
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

// Actual small writer controls for the negative fixture mechanism. These use
// the owner's existing literal-loopback session guard; they neither measure
// zero loopback attempts nor stand in for WC sizes, I12C timing or qualification.
const faultRepo=resolve(fileURLToPath(new URL('../../',import.meta.url)));
const objectPath=(root,ref)=>join(root,'objects','sha256',ref.hash.slice(7,9),ref.hash.slice(7));
async function sealedTree(root,prefix=''){
 const rows=[];
 for(const entry of await readdir(join(root,prefix),{withFileTypes:true})){
  const path=prefix?prefix+'/'+entry.name:entry.name;assert(!entry.isSymbolicLink());
  if(entry.isDirectory())rows.push(...await sealedTree(root,path));
  else{assert(entry.isFile());const bytes=await readFile(join(root,path));rows.push({path,bytes:bytes.length,sha256:hashBytes(bytes)});}
 }
 return rows.sort((a,b)=>a.path.localeCompare(b.path));
}
async function inspectFaultArchive(product,path,output){
 const index=product.spool(join(output,'test-archive-'+randomUUID()+'.sqlite')),check=()=>{};let zip,memory;
 try{
  zip=new product.ZipIndex(path,index);memory=new CompositionMemory(()=>memory.bytes);
  await zip.headers(check);await zip.hashes(check);const manifest=await product.decodeRecords(zip,index,check);
  assert.equal(manifest.unsupported,undefined);assert.equal(manifest.complete,true);
  const read=async ref=>{assert(BigInt(ref.byteLength)<=16777216n);const chunks=[];for await(const bytes of zip.chunks(zip.entry('objects/'+ref.hash.slice(7)),check))chunks.push(bytes);return Buffer.concat(chunks);};
  const document=await product.validateClosure(index,read,check,memory,manifest.formatVersion>=4,manifest.formatVersion>=5,manifest.formatVersion>=6,manifest.formatVersion>=7,manifest.formatVersion>=9,manifest.formatVersion>=10,manifest.formatVersion>=10,manifest.formatVersion>=12,manifest.formatVersion>=13);
  await validateTransactions(index,manifest.capturedHighWater,check);
  const entities=index.prepare('SELECT kind,id,json,record_hash FROM entities ORDER BY kind,id').all();
  const events=index.prepare('SELECT seq,tx,json FROM events ORDER BY length(seq),seq').all();
  const transactions=index.prepare('SELECT archive,id,command_id,first_seq,last_seq,json FROM transactions ORDER BY archive,id').all();
  const refs=index.prepare('SELECT hash,bytes,media FROM refs ORDER BY hash').all();
  return {document,manifest,entities,events,transactions,refs,counts:{events:events.length,assets:entities.filter(row=>row.kind==='asset').length,closureBytes:String(refs.reduce((total,row)=>total+BigInt(row.bytes),0n)),captionVersions:0}};
 }finally{try{if(memory)assert.equal(memory.bytes,0);}finally{try{zip?.close();}finally{index.close();}}}
}
async function smallFontFaultBaseline(t){
 const f=await setup(t);await terminal(f,f.command({}, {width:1,height:1}));const document=await doc(f),saved=await copy(f);await f.server.close();
 const owner=await rootFor(t),output=join(owner,'preparation');await mkdir(output,{mode:0o700});const path=join(output,'genuine-small-baseline.ieproject');await writeFile(path,saved.bytes,{mode:0o600,flag:'wx'});
 const product=await productFor(faultRepo),archive={path,sha256:hashBytes(saved.bytes).slice(7),byteLength:String(saved.bytes.length)},decoded=await inspectFaultArchive(product,path,output);
 assert.deepEqual(decoded.document,document);assert.equal(decoded.counts.captionVersions,0);
 const seal={kind:'small-portable-font-test-baseline-1',qualification:false,documentId:document.id,archive:{sha256:archive.sha256,byteLength:archive.byteLength},counts:decoded.counts};
 const sealBytes=Buffer.from(canonical(seal)),sealPath=join(output,'small-baseline-seal.json');await writeFile(sealPath,sealBytes,{mode:0o600,flag:'wx'});
 const baseline={sealSha256:hashBytes(sealBytes).slice(7),documentId:document.id,archive:seal.archive,counts:seal.counts};
 const original=await sealedTree(f.root);
 return {f,output,product,archive,baseline,decoded,document,bytes:saved.bytes,async unchanged(){assert.deepEqual(await sealedTree(f.root),original);assert.deepEqual(await readFile(path),saved.bytes);assert.deepEqual(await readFile(sealPath),sealBytes);}};
}
async function assertFaultPreparation(prepared){
 const evidence=prepared.evidence.find(row=>row.kind==='portable-font-negative-fixture-1');assert(evidence);assert.equal(evidence.qualification,false);assert.equal(evidence.negativeOnly,true);assert.equal(evidence.runtimeOutcome,'not-executed');
 const bytes=await readFile(evidence.descriptor.path);assert.equal(hashBytes(bytes).slice(7),evidence.descriptor.sha256);assert.equal(String(bytes.length),evidence.descriptor.byteLength);assert.deepEqual(JSON.parse(bytes).descriptor,prepared.descriptor);
}
function faultCommand(auth,body,document=null){return command(EMPTY_EXPECTED_VERSIONS,{clientId:auth.clientId,documentId:document?.id??null,expectedDocumentRevision:document?.revision??null,body});}
async function writerReceipt(writer,value,auth,method='portableCommand'){
 let receipt=await writer[method](encode(value),auth);const deadline=performance.now()+30000;
 while(!receipt&&performance.now()<deadline){await pause();receipt=(await writer.commandState(value.command.commandId)).record?.receipt;}
 assert(receipt,'Actual writer command reached a terminal receipt');return receipt;
}
async function writerEvent(writer,receipt){
 assert.equal(receipt.status,'accepted',JSON.stringify(receipt));
 const event=(await writer.events(String(BigInt(receipt.fromSeq)-1n))).events.find(value=>value.commandId===receipt.commandId);assert(event);return event;
}
async function stageWriterBytes(writer,auth,bytes){
 const stagingId=randomUUID(),expectedSha256=hashBytes(bytes);
 await writer.assetCreate({protocolVersion:1,stagingId,purpose:'bundle',expectedBytes:String(bytes.length),sha256:expectedSha256,mediaType:'application/x-ideogram-project'},auth);
 for(let at=0;at<bytes.length;at+=1048576){const part=bytes.subarray(at,at+1048576),token=await writer.assetBeginChunk(stagingId,String(at),part.length,auth);try{await writer.assetChunk(token,part,auth);}catch(error){await writer.assetAbortChunk(token);throw error;}}
 return {stagingId,expectedSha256};
}
async function sourceState(writer,id){return {document:await writer.document(id),queue:await writer.queueView(),provider:await writer.providerView()};}
function faultPublications(root){
 const db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});
 try{return {bundles:db.prepare('SELECT count(*) n FROM portable_bundles').get().n,namespaces:db.prepare('SELECT count(*) n FROM portable_namespaces').get().n};}finally{db.close();}
}
async function exactFontRefusal(writer,receipt){
 assert.equal(receipt.status,'rejected',JSON.stringify(receipt));assert(receipt.details);
 const detail=JSON.parse(Buffer.from(await writer.readMetadata(receipt.details)).toString('utf8'));
 assert.deepEqual(detail.issues.map(issue=>issue.code),['FONT_EMBEDDING_RESTRICTED'],'Malformed archives, stale hashes and checksums do not satisfy this negative case');
}
async function assertFaultDrained(writer,root){
 const read=await writer.readDiagnostics();
 try{
  assert.equal(read.value.text.reservedCPU,0);assert.equal(read.value.text.externalBytes,0);
  assert.deepEqual(read.value.observer.worker.ledger.ownedWorkerThreads.filter(worker=>worker.kind==='text-font'||worker.kind==='text-verification'),[]);
 }finally{read.release();}
 const db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});
 try{assert.equal(db.prepare('SELECT count(*) n FROM portable_pins').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM portable_preparations').get().n,0);}finally{db.close();}
}
function assertActualRestrictedFont(bytes){
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let observed=false;
 for(let i=0;i<view.getUint16(4);i++){
  const at=12+i*16;if(bytes.toString('ascii',at,at+4)!=='OS/2')continue;
  const start=view.getUint32(at+8),length=view.getUint32(at+12);assert.equal(view.getUint16(start+8),2);let checksum=0;
  for(let j=0;j<length;j+=4){let word=0;for(let k=0;k<4;k++)word=word*256+(j+k<length?bytes[start+j+k]:0);checksum=(checksum+word)>>>0;}
  assert.equal(view.getUint32(at+4),checksum);observed=true;
 }
 assert(observed,'Actual retained SFNT has a checksum-correct restricted OS/2 table');
 let wholeFontChecksum=0;
 for(let at=0;at<bytes.length;at+=4){let word=0;for(let i=0;i<4;i++)word=word*256+(at+i<bytes.length?bytes[at+i]:0);wholeFontChecksum=(wholeFontChecksum+word)>>>0;}
 assert.equal(wholeFontChecksum,0xB1B0AFBA,'Restricted fixture also preserves the padded whole-font checksum via head.checkSumAdjustment');
}
async function openFaultWriter(t,root){
 const writer=await openWriter({root}),auth={clientId:'font_fault_client',sessionHash:'d'.repeat(64),now:Date.now(),expires:Date.now()+1800000};
 t.after(()=>writer.close());await writer.protocolDefaults();await writer.rememberClient(auth.sessionHash,auth.clientId,auth.expires);return {writer,auth};
}

test('full SaveCopy refuses the staged restricted-font draft through the actual inspector without changing the genuine baseline', {timeout:60000},async t=>{
 const b=await smallFontFaultBaseline(t),root=join(await rootFor(t),'negative-copy-root');await cp(b.f.root,root,{recursive:true,force:false,errorOnExist:true});
 let {writer,auth}=await openFaultWriter(t,root);t.after(()=>writer.close());
 const before=await sourceState(writer,b.document.id),publications=faultPublications(root);
 const prepared=await preparePortableFontFault({direction:'copy',repo:faultRepo,output:b.output,baseline:b.baseline,root,archive:b.archive,writer,auth,product:b.product});writer=prepared.writer;
 await assertFaultPreparation(prepared);
 assert.equal(writer.epoch,String(BigInt(before.provider.epoch)+1n),'Negative copy preparation performs exactly one real writer reopen');
 const reopened={...before,provider:{...before.provider,epoch:writer.epoch}};
 const descriptor=prepared.descriptor;assert.equal(descriptor.kind,'portable-font-negative-fixture-1');assert.equal(descriptor.schemaVersion,1);assert.equal(descriptor.negativeOnly,true);assert.equal(descriptor.qualification,false);
 const trusted={direction:'copy',baseline:b.baseline,root,repo:faultRepo};assert.equal(validateFontFaultDescriptor(descriptor,trusted),descriptor);
 for(const [label,mutate] of [
  ['positive fixture claim',value=>{value.negativeOnly=false;}],
  ['qualification claim',value=>{value.qualification=true;}],
  ['restricted metadata admission',value=>{value.alias.font.fsType=2;const {id,...body}=value.alias.font;value.alias.font.id=hashBytes(canonical(body));}],
  ['foreign owned root',value=>{value.root=join(root,'different-owned-root');}],
  ['different sealed baseline',value=>{value.baseline.sealSha256=hashBytes('another actual baseline').slice(7);}],
  ['caller-selected setup module',value=>{value.setupModule='file:///tmp/caller-selected-setup.mjs';}],
 ]){const changed=structuredClone(descriptor);mutate(changed);assert.throws(()=>validateFontFaultDescriptor(changed,trusted),{code:'FIXTURE_REQUIRED'},label);}
 assert.deepEqual(await sourceState(writer,b.document.id),reopened);
 const restricted=await readFile(objectPath(root,descriptor.objects.font));assert.equal(hashBytes(restricted),descriptor.objects.font.hash);assert.equal(String(restricted.length),descriptor.objects.font.byteLength);assertActualRestrictedFont(restricted);
 assert.equal(descriptor.alias.font.fsType,0);assert.equal(descriptor.alias.font.embedding,'permitted');assert.deepEqual(descriptor.alias.font.bytes,descriptor.objects.font);assert.deepEqual(descriptor.alias.blob,descriptor.objects.font);
 const draft=JSON.parse(await readFile(objectPath(root,descriptor.objects.draft),'utf8'));assert.deepEqual(draft.fonts,[descriptor.alias.font]);assert.deepEqual(draft.textUtf8,descriptor.objects.text);
 const ui=await writer.uiRead(descriptor.sessionId,auth);assert.equal(ui.drafts.length,1);assert.equal(ui.drafts[0].assetId,descriptor.ui.drafts[0].assetId);assert.equal(ui.drafts[0].status,'saved-unapplied');
 const value=faultCommand(auth,{type:'SaveCopy'},before.document),receipt=await writerReceipt(writer,value,auth);await exactFontRefusal(writer,receipt);
 assert.deepEqual(await writerReceipt(writer,value,auth),receipt);assert.deepEqual(faultPublications(root),publications);assert.deepEqual(await sourceState(writer,b.document.id),reopened);
 assert.deepEqual(await readFile(objectPath(root,descriptor.objects.font)),restricted);await assertFaultDrained(writer,root);
 // The negative setup is not new permission for normal ImportFont admission.
 const ordinary=faultCommand(auth,{type:'ImportFont',source:descriptor.objects.font,license:descriptor.objects.license,origin:'local-file',embeddingReviewed:true},before.document);
 await exactFontRefusal(writer,await writerReceipt(writer,ordinary,auth,'historyCommand'));assert.deepEqual(await sourceState(writer,b.document.id),reopened);assert.deepEqual(faultPublications(root),publications);
 await assertFaultDrained(writer,root);await writer.close();assert.equal(writer.available,false);const owner=await acquireRoot(root);owner.close();await b.unchanged();
 t.diagnostic(JSON.stringify({mechanism:'real writer SaveCopy and ImportFont',refusal:'FONT_EMBEDDING_RESTRICTED',negativeOnly:true,qualification:false,baseline:'small genuine SaveCopy; not WC',guard:'existing literal-loopback session guard',networkAttemptCount:null}));
});

test('hash-complete restricted-font PF-1 variant reaches real import refusal while the original archive remains importable', {timeout:60000},async t=>{
 const b=await smallFontFaultBaseline(t),root=await rootFor(t);let {writer,auth}=await openFaultWriter(t,root);t.after(()=>writer.close());
 const before=await sourceState(writer,b.document.id),publications=faultPublications(root);
 const prepared=await preparePortableFontFault({direction:'import',repo:faultRepo,output:b.output,baseline:b.baseline,root,archive:b.archive,writer,auth,product:b.product});writer=prepared.writer;
 await assertFaultPreparation(prepared);
 assert.equal(prepared.descriptor.negativeOnly,true);assert.equal(prepared.descriptor.qualification,false);assert(prepared.archive);
 const bytes=await readFile(prepared.archive.path);assert.equal(hashBytes(bytes).slice(7),prepared.archive.sha256.replace(/^sha256:/,''));assert.equal(String(bytes.length),prepared.archive.byteLength);
 const variant=await inspectFaultArchive(b.product,prepared.archive.path,b.output);assert.deepEqual(variant.document,b.decoded.document);assert.deepEqual(variant.events,b.decoded.events);assert.deepEqual(variant.transactions,b.decoded.transactions);
 for(const original of b.decoded.entities)assert.deepEqual(variant.entities.find(row=>row.kind===original.kind&&row.id===original.id),original);
 for(const original of b.decoded.refs)assert.deepEqual(variant.refs.find(row=>row.hash===original.hash),original);
 const entries=await unpack(b.output,bytes),restricted=entries.get('objects/'+prepared.descriptor.objects.font.hash.slice(7));assert(restricted);assert.equal(hashBytes(restricted),prepared.descriptor.objects.font.hash);assertActualRestrictedFont(restricted);
 const stage=await stageWriterBytes(writer,auth,bytes),value=faultCommand(auth,{type:'PreviewBundleImport',...stage}),receipt=await writerReceipt(writer,value,auth);await exactFontRefusal(writer,receipt);
 assert.deepEqual(await writerReceipt(writer,value,auth),receipt);assert.deepEqual(faultPublications(root),publications);assert.deepEqual(await sourceState(writer,b.document.id),before);await assertFaultDrained(writer,root);
 const intact=await stageWriterBytes(writer,auth,b.bytes),reviewed=await writerReceipt(writer,faultCommand(auth,{type:'PreviewBundleImport',...intact}),auth),event=await writerEvent(writer,reviewed),review=await writer.bundleReview(event.payload.reviewId,auth);
 assert.equal(review.editable,true);const imported=await writerReceipt(writer,faultCommand(auth,{type:'ImportBundle',reviewId:review.reviewId,reviewHash:review.reviewHash}),auth);assert.equal(imported.status,'accepted');assert(await writer.document(review.documentId));assert.equal(faultPublications(root).namespaces,publications.namespaces+1);
 await assertFaultDrained(writer,root);await writer.close();assert.equal(writer.available,false);const owner=await acquireRoot(root);owner.close();await b.unchanged();
});

test('font fixture cancellation preserves caller ownership and actual archive mismatch closes the acquired writer', {timeout:60000},async t=>{
 const b=await smallFontFaultBaseline(t),root=await rootFor(t),{writer,auth}=await openFaultWriter(t,root),before=await sourceState(writer,b.document.id),publications=faultPublications(root),outputBefore=await sealedTree(b.output);
 const options={direction:'import',repo:faultRepo,output:b.output,baseline:b.baseline,root,archive:b.archive,writer,auth,product:b.product},aborter=new AbortController(),reason=Error('cancel before preparation');aborter.abort(reason);
 await assert.rejects(preparePortableFontFault({...options,signal:aborter.signal}),error=>error===reason);
 assert.equal(writer.available,true);assert.deepEqual(await sourceState(writer,b.document.id),before);assert.deepEqual(await sealedTree(b.output),outputBefore);
 // Both declarations agree, so bounded preflight succeeds. Hashing the real
 // unchanged archive then discovers the false identity during owned work.
 const declaredHash=hashBytes('not the genuine baseline archive').slice(7),baseline={...b.baseline,archive:{...b.baseline.archive,sha256:declaredHash}},archive={...b.archive,sha256:declaredHash};
 await assert.rejects(preparePortableFontFault({...options,baseline,archive}),{code:'ERR_ASSERTION'});
 assert.equal(writer.available,false);const owner=await acquireRoot(root);owner.close();assert.deepEqual(faultPublications(root),publications);
 const db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});try{assert.equal(db.prepare('SELECT count(*) n FROM documents').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM commands').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM queue_jobs').get().n,0);}finally{db.close();}
 await b.unchanged();
});

test('the same unapplied alias shape without AssetRegistered copies and imports when its actual font permits embedding', {timeout:60000},async t=>{
 const f=await setup(t);await terminal(f,f.command({}, {width:1,height:1}));const original=await fontBytes();
 const stage=async(bytes,purpose='caption',mediaType='text/plain')=>{const staged=await upload(f,bytes,purpose,mediaType);return (await workspace(f,{type:'FinalizeStaging',stagingId:staged.stagingId,expectedSha256:staged.sha256})).event.payload.asset;};
 const fontInput=await stage(original.bytes,'font','application/octet-stream'),license=await stage(await readFile(join(faultRepo,'vendor/text',original.font.licenseFile))),text=await stage(Buffer.from('Qualification restricted-font negative draft'));
 const value={schemaVersion:1,bytes:fontInput.blob,faceIndex:0,format:'static-ttf',parserProfile:'sfnt-static-1-freetype-canvaskit040',fsType:0,licenseRecord:license.blob,origin:'local-file',embedding:'permitted'},font={...value,id:hashBytes(canonical(value))};
 const alias={id:'permitted_alias_'+randomUUID(),version:'1',purpose:'font',blob:fontInput.blob,dependencies:[license.blob],safety:'safe',availability:'available',qualification:'font',measuredMediaType:'application/octet-stream',font};
 const draftBytes=Buffer.from(canonical({schemaVersion:1,kind:'text-draft-1',textUtf8:text.blob,style:{},frame:{},fonts:[font]})),draft=await stage(draftBytes),before=await doc(f),db=await ownedFontStore(t,f);
 const auth={clientId:f.paired.json.clientId,sessionHash:'e'.repeat(64),now:Date.now(),expires:Date.now()+1800000};db.rememberClient(auth.sessionHash,auth.clientId,auth.expires);
 const originalEvents=db.db.prepare('SELECT seq,json FROM events_v2 ORDER BY length(seq),seq').all(),beforeQueue=db.queue.view();
 assert.equal(db.assets.asset(alias.id),null);entity('asset',alias);
 // The test-only projection adds the identical alias/dependency shape after
 // rebuild, with genuine permitted bytes. It creates no accepted font event
 // and replaces no method, inspector result, existing asset or source object.
 db.db.exec('BEGIN IMMEDIATE');
 try{db.db.prepare('INSERT INTO assets VALUES (?,?)').run(alias.id,canonical(alias));for(const ref of [alias.blob,...alias.dependencies]){db.objects.verify(ref);db.db.prepare('INSERT INTO asset_dependencies VALUES (?,?)').run(alias.id,ref.hash);}db.db.exec('COMMIT');}catch(error){if(db.db.isTransaction)db.db.exec('ROLLBACK');throw error;}
 assert.deepEqual(db.db.prepare('SELECT seq,json FROM events_v2 ORDER BY length(seq),seq').all(),originalEvents);
 assert.equal(db.db.prepare("SELECT count(*) n FROM events_v2 WHERE json_extract(json,'$.type')='AssetRegistered' AND json_extract(json,'$.payload.asset.id')=?").get(alias.id).n,0);
 const sessionId='permitted_alias_control',ui=db.ui.read(sessionId,auth),saved=await db.ui.persist(encode({protocolVersion:1,requestId:randomUUID(),sessionId,expectedUISeq:ui.uiSeq,body:{type:'SaveDraft',draft:{id:'permitted_alias_draft',generation:'1',kind:'text',documentId:before.id,targetLayerId:null,expectedDocumentRevision:before.revision,assetId:draft.id,composing:false}}}),auth);assert.equal(saved.status,'accepted');
 const execute=async body=>{const c=faultCommand(auth,body,body.type==='SaveCopy'?before:null);let receipt=db.portables.command(encode(c),auth);const deadline=performance.now()+30000;while(!receipt&&performance.now()<deadline){await pause();receipt=db.lookup(c.command.commandId)?.receipt;}assert(receipt);assert.equal(receipt.status,'accepted',JSON.stringify(receipt));const event=db.events(String(BigInt(receipt.fromSeq)-1n),100).events.find(event=>event.commandId===c.command.commandId);assert(event);return {receipt,event};};
 const copied=await execute({type:'SaveCopy'}),bundle=copied.event.payload.bundle;assert.equal(bundle.complete,true);assert.equal(bundle.status,'copy-ready');
 const archive=await readFile(db.objects.path(bundle.blob)),entries=await unpack(f.root,archive),archived=records(entries).values.find(row=>row.kind==='entity'&&row.entityType==='asset'&&row.logicalId===alias.id);assert(archived);assert.deepEqual(JSON.parse(entries.get('objects/'+archived.payloadRef.hash.slice(7))),alias);
 assert.deepEqual(entries.get('objects/'+font.bytes.hash.slice(7)),original.bytes);assert.deepEqual(entries.get('objects/'+draft.blob.hash.slice(7)),draftBytes);
 const stagingId=randomUUID(),expectedSha256=hashBytes(archive);db.assets.create({protocolVersion:1,stagingId,purpose:'bundle',expectedBytes:String(archive.length),sha256:expectedSha256,mediaType:'application/x-ideogram-project'},auth);
 for(let at=0;at<archive.length;at+=1048576){const part=archive.subarray(at,at+1048576),token=db.assets.beginChunk(stagingId,String(at),part.length,auth);await db.assets.chunk(token,part,auth);}
 const reviewed=await execute({type:'PreviewBundleImport',stagingId,expectedSha256}),review=db.portables.review(reviewed.event.payload.reviewId,auth);assert.equal(review.editable,true);
 await execute({type:'ImportBundle',reviewId:review.reviewId,reviewHash:review.reviewHash});assert(db.document(review.documentId));assert.deepEqual(db.document(before.id),before);assert.deepEqual(db.queue.view(),beforeQueue);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(db.texts.reservedCPU,0);assert.deepEqual(db.objects.reservationInventory(),{reservedBytes:'0',activeTransfers:0});assert.equal(db.db.prepare('SELECT count(*) n FROM portable_pins').get().n,0);
 assert.deepEqual(await readFile(db.objects.path(font.bytes)),original.bytes);
});
