import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {setup,copy,preview,upload,terminal,doc,edit} from './helpers.mjs';
import {importRaster} from '../raster/helpers.mjs';
import {unpack,pack,records,putRecords,changeEntity,encoded,hash} from './archive-fixture.mjs';
const mutations={
 'duplicate-json-key':e=>{const {path}=records(e);e.set(path,Buffer.from(e.get(path).toString().replace('"schemaVersion":1','"schemaVersion":1,"schemaVersion":1')));},
 'noncanonical-json':e=>{const {path}=records(e);e.set(path,Buffer.from(e.get(path).toString().replace('{','{ ')));},
 'missing-final-LF':e=>{const {path}=records(e);e.set(path,e.get(path).subarray(0,-1));},
 'unknown-entity-field':e=>changeEntity(e,'document',v=>v.outbox={execute:true}),
 'wrong-projection':e=>changeEntity(e,'document',v=>v.width=2),
 'missing-required-history':e=>{const r=records(e);putRecords(e,r.path,r.values.filter(x=>!(x.kind==='entity'&&x.entityType==='history')));},
 'duplicate-entity':e=>{const r=records(e);r.values.push(r.values.find(x=>x.kind==='entity'));putRecords(e,r.path,r.values);},
 'duplicate-object':e=>{const r=records(e);r.values.push(r.values.find(x=>x.kind==='object'));putRecords(e,r.path,r.values);},
 'event-sequence-duplicate':e=>{const r=records(e,'events');r.values.push(r.values[0]);putRecords(e,r.path,r.values);},
 'source-event-mutation':e=>{const r=records(e,'events');r.values[0].event.payload.document.width=2;putRecords(e,r.path,r.values);},
 'event-beyond-highwater':e=>{const r=records(e,'events');r.values[0].event.workspaceSeq='999999';putRecords(e,r.path,r.values);},
 'root-hash-mismatch':e=>{const m=JSON.parse(e.get('manifest.json'));m.rootRefs[0].recordHash='sha256:'+'f'.repeat(64);e.set('manifest.json',encoded(m));},
 'unknown-root-field':e=>{const m=JSON.parse(e.get('manifest.json'));m.destinationPath='/tmp/escape';e.set('manifest.json',encoded(m));},
 'descriptor-hash-mismatch':e=>{const m=JSON.parse(e.get('manifest.json'));m.segments[0].sha256='a'.repeat(64);e.set('manifest.json',encoded(m));},
 'oversized-record':e=>{const {path}=records(e);e.set(path,Buffer.from('{"padding":"'+'x'.repeat(17000)+'"}\n'));},
 'index-cycle':e=>{const m=JSON.parse(e.get('manifest.json')),path='records/100.jsonl',s={path,sha256:'0'.repeat(64),bytes:'1',kind:'index',recordCount:'1'};const b=encoded({schemaVersion:1,kind:'index',segments:[s]});e.set(path,Buffer.concat([b,Buffer.from('\n')]));s.sha256=hash(e.get(path));s.bytes=String(e.get(path).length);m.segments.push(s);e.set('manifest.json',encoded(m));},
};
for(const [label,mutate]of Object.entries(mutations))test('public preview rejects '+label+' and preserves source and namespace',async t=>{
 const f=await setup(t);await terminal(f,f.command({}, {width:1,height:1}));const before=await doc(f),saved=await copy(f),entries=await unpack(f.root,saved.bytes);mutate(entries);const archive=await pack(f.root,entries,label!=='descriptor-hash-mismatch'),s=await upload(f,archive),c=f.command({documentId:null,expectedDocumentRevision:null,body:{type:'PreviewBundleImport',stagingId:s.stagingId,expectedSha256:s.sha256}}),r=await terminal(f,c);assert.equal(r.json.receipt.status,'rejected',label+' '+r.text);assert.deepEqual(await doc(f),before);assert.deepEqual((await terminal(f,c)).json.receipt,r.json.receipt);
 const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});assert.equal(db.prepare('SELECT count(*) n FROM portable_namespaces').get().n,0);const name=db.prepare('SELECT filename FROM staged_assets WHERE id=?').get(s.stagingId).filename;db.close();assert.deepEqual(await readFile(join(f.root,'uploads',name)),archive);
});
for(const version of ['format','format-extra','document','payload','record','entity'])test('unknown '+version+' remains inspection-only with original source retained',async t=>{
 const f=await setup(t);await terminal(f,f.command({}, {width:1,height:1}));const saved=await copy(f),entries=await unpack(f.root,saved.bytes);
 if(version==='format'||version==='format-extra'||version==='document'){const m=JSON.parse(entries.get('manifest.json'));m[version.startsWith('format')?'formatVersion':'documentSchema']=99;if(version==='format-extra')m.futureMetadata={revision:'opaque-observation'};entries.set('manifest.json',encoded(m));}
 else{const r=records(entries);if(version==='record')r.values[0].schemaVersion=99;else if(version==='payload')r.values.find(x=>x.kind==='entity').payloadVersion=99;else r.values.find(x=>x.kind==='entity').entityType='job';putRecords(entries,r.path,r.values);const m=JSON.parse(entries.get('manifest.json'));m.rootRefs=[];entries.set('manifest.json',encoded(m));}
 const p=await preview(f,await pack(f.root,entries));assert.equal(p.review.editable,false);assert.match(p.review.reason,/UNSUPPORTED/);const c=f.command({documentId:null,expectedDocumentRevision:null,body:{type:'ImportBundle',reviewId:p.review.reviewId,reviewHash:p.review.reviewHash}});assert.equal((await terminal(f,c)).json.receipt.status,'rejected');assert.equal((await f.read('/api/v1/documents/'+p.review.documentId)).status,404);
});
test('changed history patch cannot publish a fresh editable namespace',async t=>{
 const f=await setup(t);await terminal(f,f.command({}, {width:3,height:2}));const {asset}=await importRaster(f,'hidden-alpha.png');await edit(f,{type:'ImportAsset',assetId:asset.id,layerId:'picture',name:'Picture',draft:null});const saved=await copy(f),entries=await unpack(f.root,saved.bytes);changeEntity(entries,'history',v=>{if(v.kind==='image-edit')v.parent=v.id;else v.forward.after.historyHead='invalid';});const s=await upload(f,await pack(f.root,entries)),c=f.command({documentId:null,expectedDocumentRevision:null,body:{type:'PreviewBundleImport',stagingId:s.stagingId,expectedSha256:s.sha256}});assert.equal((await terminal(f,c)).json.receipt.status,'rejected');
});

test('shared acyclic index pages are accepted without duplicating their records',async t=>{
 const f=await setup(t);await terminal(f,f.command({}, {width:1,height:1}));const saved=await copy(f),entries=await unpack(f.root,saved.bytes),m=JSON.parse(entries.get('manifest.json')),shared=m.segments.find(x=>x.kind==='records');m.segments=m.segments.filter(x=>x!==shared);
 for(const path of ['records/50.jsonl','records/51.jsonl']){const bytes=Buffer.concat([encoded({schemaVersion:1,kind:'index',segments:[shared]}),Buffer.from('\n')]);entries.set(path,bytes);m.segments.push({path,sha256:hash(bytes),bytes:String(bytes.length),kind:'index',recordCount:'1'});}entries.set('manifest.json',encoded(m));const p=await preview(f,await pack(f.root,entries));assert.equal(p.review.editable,true);
});
