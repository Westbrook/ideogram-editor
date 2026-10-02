// STAGED ONLY. Promote to tests/history/document-creation.test.mjs together
// with CreateDocument, Document.metadata and portable-format-10 support.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import sharp from 'sharp';
import {setup} from '../protocol/helpers.mjs';
import {terminal,binary,digest} from '../raster/helpers.mjs';
import {copy,preview,workspace,doc,edit,upload} from '../portable/helpers.mjs';
import {unpack} from '../portable/archive-fixture.mjs';
import {command,encode,childFor,rootFor,expectedBytes} from '../store/helpers.mjs';
import {openWriter} from '../../dist/local/server/storage/writer.js';
import {EMPTY_EXPECTED_VERSIONS} from '../../dist/local/src/protocol/store.js';
import {imageState} from '../../dist/local/src/protocol/history-validation.js';
import {mismatchedSolidColor,assertValidMetadataClosure} from './document-creation-archive.mjs';

const color=[17,83,201,255],name='Café e\u0301 東京 — document';
const body=(background,extra={})=>({type:'CreateDocument',name,width:3,height:2,background,...extra});
const solid=()=>({kind:'solid',color:[...color]});
const auth=()=>({clientId:'client_1',sessionHash:'c'.repeat(64),now:Date.now(),expires:Date.now()+1800000});
const pixels=(value=color,width=3,height=2)=>Buffer.from(Array.from({length:width*height},()=>value).flat());
const pathFor=(root,hash)=>join(root,'objects','sha256',hash.slice(7,9),hash.slice(7));
async function events(f,receipt){const response=await f.read('/api/v1/events?after='+String(BigInt(receipt.fromSeq)-1n));assert.equal(response.status,200,response.text);const batch=response.json.batches[0];if(batch.kind==='inline')return batch.events;const content=await f.read(batch.content.url);assert.equal(content.status,200);assert.equal(digest(content.text),batch.content.blob.hash);return content.text.trim().split('\n').map(line=>JSON.parse(line));}
async function create(f,background,patch={},extra={}){const request=f.command({expectedDocumentRevision:null,body:body(background,extra),...patch}),result=await terminal(f,request);assert.equal(result.json.receipt.status,'accepted',result.text);return {request,receipt:result.json.receipt,document:await doc(f,request.command.documentId),events:await events(f,result.json.receipt)};}
async function image(f,document){const response=await f.read('/api/v1/documents/'+document.id+'/image');assert.equal(response.status,200,response.text);const state=response.json;assert.equal(Object.hasOwn(state,'metadata'),false,'Creation provenance belongs on Document, never ImageState');if(document.image)assert.equal(Object.hasOwn(document.image,'metadata'),false,'Creation provenance never enters ImageVersion');else assert.deepEqual(document.orderedLayerIds,[]);return state;}
async function exported(f,id='document_1'){const document=await doc(f,id),request=f.command({documentId:id,expectedDocumentRevision:document.revision,body:{type:'ExportDocument',historyHead:document.historyHead,options:{format:'png',resize:null,matte:null,quality:null,scope:{kind:'visible-document'}}}}),result=await terminal(f,request);assert.equal(result.json.receipt.status,'accepted',result.text);const asset=(await events(f,result.json.receipt)).findLast(event=>event.type==='AssetRegistered')?.payload.asset;assert(asset);const content=await binary(f,asset.id);assert.equal(content.status,200);const decoded=await sharp(content.bytes,{ignoreIcc:true}).ensureAlpha().raw().toBuffer({resolveWithObject:true});return {asset,content,decoded};}
function inspect(root,id='document_1'){const db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});try{return {document:db.prepare('SELECT json FROM documents WHERE id=?').get(id)?.json??null,documents:db.prepare('SELECT count(*) n FROM documents').get().n,assets:db.prepare('SELECT count(*) n FROM assets').get().n,events:db.prepare('SELECT count(*) n FROM events_v2').get().n,history:db.prepare('SELECT count(*) n FROM history').get().n};}finally{db.close();}}
async function settled(writer,id){for(let n=0;n<1500;n++){const state=await writer.commandState(id);if(state.record)return state.record;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('CreateDocument did not settle: '+id);}
async function initialRoot(t){const root=await rootFor(t),writer=await openWriter({root});await writer.putObject([expectedBytes],EMPTY_EXPECTED_VERSIONS,writer.epoch);await writer.close();return root;}

test('J1 transparent creation retains exact name, empty editable graph and one durable creation',async t=>{
  const f=await setup(t),created=await create(f,{kind:'transparent'}),d=created.document;
  assert.equal(d.revision,'1');assert.equal(d.width,3);assert.equal(d.height,2);
  assert.deepEqual(d.metadata,{schemaVersion:1,name,creationBackground:{kind:'transparent'}});
  assert.deepEqual((await image(f,d)).layers,[]);assert.equal(created.events.filter(event=>event.type==='DocumentCreated').length,1);
  assert.equal(created.events.filter(event=>event.type==='AssetRegistered').length,0,'Transparent creation has no background raster');
  const png=await exported(f);assert.deepEqual([png.decoded.info.width,png.decoded.info.height,png.decoded.info.channels],[3,2,4]);assert.deepEqual(png.decoded.data,pixels([0,0,0,0]));
  const before=inspect(f.root),retry=await terminal(f,created.request);assert.deepEqual(retry.json.receipt,created.receipt);assert.deepEqual(inspect(f.root),before);
});

test('J1 solid background is exact retained RGBA, one editable layer, and ordinary reversible history',async t=>{
  const f=await setup(t),created=await create(f,solid()),d=created.document,state=await image(f,d);
  assert.equal(d.revision,'1');assert.equal(state.layers.length,1);const layer=state.layers[0];
  assert.deepEqual(d.metadata,{schemaVersion:1,name,creationBackground:{kind:'solid',color,layerId:layer.id}});
  assert.equal(layer.kind,'image');assert.equal(layer.name,'Background');assert.equal(layer.visible,true);assert.equal(layer.locked,false);assert.equal(layer.opacity,1);assert.deepEqual(layer.layerToDocument,[1,0,0,1,0,0]);assert.equal(layer.mask,null);
  assert.deepEqual((await exported(f)).decoded.data,pixels());
  const renamed=await edit(f,{type:'SetLayerProperties',layerId:layer.id,layerVersion:layer.version,properties:{name:'Editable background',visible:false},draft:null});
  assert.deepEqual(renamed.document.metadata,d.metadata);assert.equal((await image(f,renamed.document)).layers[0].name,'Editable background');assert.deepEqual((await exported(f)).decoded.data,pixels([0,0,0,0]));
  const undone=await edit(f,{type:'Undo',historyHead:renamed.document.historyHead});assert.deepEqual(undone.document.metadata,d.metadata);assert.deepEqual((await image(f,undone.document)).layers,state.layers);assert.deepEqual((await exported(f)).decoded.data,pixels());
  assert.equal(created.events.filter(event=>event.type==='DocumentCreated').length,1);assert.equal(created.events.at(-1).type,'DocumentCreated','No document may be published before all raster facts');
  const before=inspect(f.root),retry=await terminal(f,created.request);assert.deepEqual(retry.json.receipt,created.receipt);assert.deepEqual(inspect(f.root),before,'Retry cannot create another layer, asset, history node or event');
});

test('J1 name normalization and UTF-8 boundaries persist without changing image schemas',async t=>{
  const f=await setup(t);
  for(const [index,authored,stored] of [[0,'a'.repeat(256),'a'.repeat(256)],[1,'é'.repeat(128),'é'.repeat(128)],[2,'  Café e\u0301 東京  ','Café e\u0301 東京']]){
    const created=await create(f,{kind:'transparent'},{documentId:'name_'+index},{name:authored});assert.equal(created.document.metadata.name,stored);assert.deepEqual((await image(f,created.document)).layers,[]);
    assert.deepEqual((await terminal(f,created.request)).json.receipt,created.receipt);
  }
  const metadata={schemaVersion:1,name:'Document only',creationBackground:{kind:'transparent'}};
  assert.throws(()=>imageState({schemaVersion:1,width:1,height:1,layers:[],metadata}),'ImageState must reject extra document metadata');
});

for(const background of [{kind:'transparent'},solid()])test('J1 '+background.kind+' metadata and pixels survive format10 import, re-copy and zero-work restart',async t=>{
  const f=await setup(t),created=await create(f,background),saved=await copy(f),manifest=JSON.parse((await unpack(f.root,saved.bytes)).get('manifest.json'));
  assert.equal(manifest.formatVersion,10);assert.equal(manifest.documentSchema,10);
  const reviewed=await preview(f,saved.bytes);assert.equal(reviewed.review.editable,true);await workspace(f,{type:'ImportBundle',reviewId:reviewed.review.reviewId,reviewHash:reviewed.review.reviewHash});
  const imported=await doc(f,reviewed.review.documentId);assert.notEqual(imported.id,created.document.id);assert.equal(imported.metadata.name,name);assert.equal(imported.metadata.schemaVersion,1);
  const importedState=await image(f,imported);
  if(background.kind==='solid'){assert.equal(importedState.layers.length,1);assert.notEqual(importedState.layers[0].id,created.document.metadata.creationBackground.layerId);assert.deepEqual(imported.metadata.creationBackground,{kind:'solid',color,layerId:importedState.layers[0].id});}
  else{assert.deepEqual(imported.metadata.creationBackground,{kind:'transparent'});assert.deepEqual(importedState.layers,[]);}
  assert.deepEqual((await exported(f,imported.id)).decoded.data,pixels(background.kind==='solid'?color:[0,0,0,0]));
  const nested=await copy(f,imported.id);assert.equal(JSON.parse((await unpack(f.root,nested.bytes)).get('manifest.json')).formatVersion,10);
  const original=await doc(f),before=inspect(f.root);await f.server.close();
  const result=JSON.parse(execFileSync(process.execPath,['--import',resolve('tests/store/no-network.mjs'),'--import',resolve('tests/history/no-raster.mjs'),resolve('tests/history/document-creation-replay.mjs'),f.root,JSON.stringify(created.request),imported.id],{encoding:'utf8'}));
  assert.deepEqual(result.original,original);assert.deepEqual(result.imported,imported);assert.deepEqual(result.receipt,created.receipt);assert(Object.values(result.effects).every(count=>count===0));assert.deepEqual(inspect(f.root),before);
});

test('J1 deleting a solid creation layer retains remapped provenance and recoverable history in a copy',async t=>{
  const f=await setup(t),created=await create(f,solid()),initial=(await image(f,created.document)).layers[0];
  const removed=await edit(f,{type:'DeleteLayer',layerId:initial.id,layerVersion:initial.version,draft:null});assert.deepEqual((await image(f,removed.document)).layers,[]);assert.deepEqual(removed.document.metadata,created.document.metadata);
  const saved=await copy(f),reviewed=await preview(f,saved.bytes);assert.equal(reviewed.review.editable,true);await workspace(f,{type:'ImportBundle',reviewId:reviewed.review.reviewId,reviewHash:reviewed.review.reviewHash});
  const imported=await doc(f,reviewed.review.documentId),background=imported.metadata.creationBackground;assert.equal(imported.metadata.name,name);assert.equal(background.kind,'solid');assert.deepEqual(background.color,color);assert.notEqual(background.layerId,initial.id);assert.deepEqual((await image(f,imported)).layers,[]);assert.deepEqual((await exported(f,imported.id)).decoded.data,pixels([0,0,0,0]));
  const restored=await edit(f,{type:'Undo',historyHead:imported.historyHead},imported.id),layer=(await image(f,restored.document)).layers[0];assert.equal(layer.id,background.layerId);assert.equal(layer.name,'Background');assert.deepEqual(restored.document.metadata,imported.metadata);assert.deepEqual((await exported(f,imported.id)).decoded.data,pixels());
  const recopied=await copy(f,imported.id);assert.equal(JSON.parse((await unpack(f.root,recopied.bytes)).get('manifest.json')).formatVersion,10);
});

test('J1 portable import rejects a coherent declared solid color that disagrees with actual pixels',async t=>{
  const f=await setup(t);await create(f,solid());const original=await doc(f),saved=await copy(f);assert.equal((await preview(f,saved.bytes)).review.editable,true);
  const claimed=[201,83,17,255],tampered=await mismatchedSolidColor(f.root,saved.bytes,claimed),declared=await assertValidMetadataClosure(f.root,tampered);assert.deepEqual(declared.metadata.creationBackground.color,claimed);
  const staged=await upload(f,tampered),request=f.command({documentId:null,expectedDocumentRevision:null,body:{type:'PreviewBundleImport',stagingId:staged.stagingId,expectedSha256:staged.sha256}}),result=await terminal(f,request);
  assert.equal(result.json.receipt.status,'rejected',result.text);assert.deepEqual(await doc(f),original);assert.deepEqual((await terminal(f,request)).json.receipt,result.json.receipt);
  const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});try{assert.equal(db.prepare('SELECT count(*) n FROM portable_namespaces').get().n,0);}finally{db.close();}
});

test('J1 legacy NewDocument copy remains its existing format without invented metadata',async t=>{
  const f=await setup(t);const accepted=await terminal(f,f.command({}, {width:3,height:2}));assert.equal(accepted.json.receipt.status,'accepted');assert.equal((await doc(f)).metadata,undefined);
  const saved=await copy(f),manifest=JSON.parse((await unpack(f.root,saved.bytes)).get('manifest.json'));
  assert.equal(manifest.formatVersion,7);assert.equal(manifest.documentSchema,7);
  const reviewed=await preview(f,saved.bytes);assert.equal(reviewed.review.editable,true);await workspace(f,{type:'ImportBundle',reviewId:reviewed.review.reviewId,reviewHash:reviewed.review.reviewHash});assert.equal((await doc(f,reviewed.review.documentId)).metadata,undefined);
});

test('J1 malformed creation shapes fail before admission and preserve the current document',async t=>{
  const f=await setup(t);await create(f,{kind:'transparent'});const before=inspect(f.root);
  const malformed=[{...body(solid()),name:7},{...body(solid()),width:1.5},{...body(solid()),background:{kind:'solid',color:[1,2,3,128]}},{...body(solid()),background:{kind:'solid',color:[1,2,3]}},{...body(solid()),background:{kind:'solid',color:[1,-1,3,255]}},{...body(solid()),background:{kind:'transparent',color:[1,2,3,255]}},{...body(solid()),unexpected:true}];
  for(const value of malformed){const request=f.command({documentId:'bad_'+malformed.indexOf(value),expectedDocumentRevision:null,body:value}),response=await f.post('/api/v1/commands',request);assert.equal(response.status,400,response.text);assert.equal((await f.read('/api/v1/commands/'+request.command.commandId)).status,404);assert.deepEqual(inspect(f.root),before);}
});

test('J1 well-shaped invalid names and dimensions retain rejected identity without replacing accepted work',async t=>{
  const f=await setup(t);await create(f,{kind:'transparent'});const before=inspect(f.root);
  for(const [index,extra,code] of [[0,{name:''},'INVALID_INPUT'],[1,{name:'Invalid\nname'},'INVALID_INPUT'],[2,{width:0},'INVALID_INPUT'],[3,{height:8193},'CAPACITY'],[4,{width:8192,height:8192},'CAPACITY'],[5,{name:'a'.repeat(257)},'INVALID_INPUT'],[6,{name:'é'.repeat(129)},'INVALID_INPUT'],[7,{name:'   '},'INVALID_INPUT']]){
    const request=f.command({documentId:'rejected_'+index,expectedDocumentRevision:null,body:body({kind:'transparent'},extra)}),result=await terminal(f,request);
    assert.equal(result.json.receipt.status,'rejected');assert.equal(result.json.receipt.code,code);assert.deepEqual(inspect(f.root),before);
    assert.deepEqual((await terminal(f,request)).json.receipt,result.json.receipt,'Same invalid command cannot become a new attempt');
  }
});

test('J1 a SIGKILL after solid preparation publishes no partial document; exact retry creates once',async t=>{
  const root=await initialRoot(t),before=inspect(root,'created_after_crash'),first=await childFor(t,root,{phase:'document-creation-after-proofs'}),a=auth(),request=command(EMPTY_EXPECTED_VERSIONS,{documentId:'created_after_crash',body:body(solid())});
  assert.equal(first.startup.type,'ready');const admitted=first.call('historyCommand',encode(request),a).catch(()=>null);await first.wait('barrier');
  assert.deepEqual(inspect(root,'created_after_crash'),before,'No registered asset/history/document/event before atomic commit');
  await first.assertNoEffects();await first.kill();await admitted;
  const writer=await openWriter({root});t.after(()=>writer.close());await writer.historyCommand(encode(request),a);const accepted=await settled(writer,request.command.commandId);assert.equal(accepted.receipt.status,'accepted');
  const document=await writer.document('created_after_crash'),state=await writer.imageState(document.id);assert.equal(document.revision,'1');assert.equal(state.layers.length,1);assert.deepEqual(document.metadata.creationBackground,{kind:'solid',color,layerId:state.layers[0].id});
  const after=inspect(root,'created_after_crash');assert.deepEqual(await writer.historyCommand(encode(request),a),accepted.receipt);assert.deepEqual(inspect(root,'created_after_crash'),after);
  const eventPage=await writer.events('0');assert.equal(eventPage.events.filter(event=>event.type==='DocumentCreated').length,1);
});

test('J1 a prepared-pixel proof failure leaves old document intact and never creates a false saved receipt',async t=>{
  const f=await setup(t);await create(f,{kind:'transparent'});const stable=await doc(f);await f.server.close();
  const gate=new SharedArrayBuffer(4);let signal;const reached=new Promise(resolve=>signal=resolve),writer=await openWriter({root:f.root},{phase:'document-creation-after-proofs',gate,onBarrier:signal});
  const release=()=>{Atomics.store(new Int32Array(gate),0,1);Atomics.notify(new Int32Array(gate),0);};t.after(async()=>{release();await writer.close();});
  const request=command(EMPTY_EXPECTED_VERSIONS,{documentId:'failed_creation',body:body(solid())}),a=auth();await writer.historyCommand(encode(request),a);await reached;
  const filename=pathFor(f.root,digest(pixels())),original=await readFile(filename);assert.deepEqual(original,pixels());
  try{const damaged=Buffer.from(original);damaged[0]^=1;await writeFile(filename,damaged);release();const result=await settled(writer,request.command.commandId);assert.equal(result.receipt.status,'rejected');assert.equal(result.receipt.code,'MISSING_ASSET');assert.equal(await writer.document('failed_creation'),null);assert.deepEqual(await writer.document(stable.id),stable);assert.deepEqual(await writer.historyCommand(encode(request),a),result.receipt);}
  finally{release();await writeFile(filename,original,{mode:0o600});}
});
