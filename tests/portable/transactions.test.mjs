import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {setup,copy,preview,workspace,terminal,edit,doc,upload,digest,binary} from './helpers.mjs';
import {importRaster} from '../raster/helpers.mjs';
import {unpack,records,putRecords,pack,encoded,hash} from './archive-fixture.mjs';
const retained=root=>{const db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});try{return {namespaces:db.prepare('SELECT * FROM portable_namespaces').all(),rows:db.prepare('SELECT * FROM portable_rows').all(),roots:db.prepare("SELECT * FROM roots WHERE owner NOT LIKE 'receipt:%' ORDER BY owner,hash").all()};}finally{db.close();}};
async function fixture(t){const f=await setup(t);await terminal(f,f.command({}, {width:3,height:2}));const {asset}=await importRaster(f,'hidden-alpha.png');const imported=await edit(f,{type:'ImportAsset',assetId:asset.id,layerId:'picture',name:'Exact original',draft:null});await edit(f,{type:'SaveCheckpoint',name:'Whole history'});const saved=await copy(f);return {f,imported,saved};}
test('format5 public roundtrip retains exact original receipt bounds and canonical event bytes',async t=>{
 const {f,imported,saved}=await fixture(t),entries=await unpack(f.root,saved.bytes),manifest=JSON.parse(entries.get('manifest.json'));assert.equal(manifest.formatVersion,5);assert.equal(manifest.documentSchema,5);
 const tx=records(entries).values.find(r=>r.kind==='transaction'&&r.receipt.transactionId===imported.receipt.transactionId),events=records(entries,'events').values.filter(r=>r.event.transactionId===tx.receipt.transactionId);
 assert.deepEqual(tx.receipt,imported.receipt);assert.equal(tx.eventCount,'2');assert.equal(tx.sourceArchive,null);assert.equal(tx.eventsHash,'sha256:'+hash(Buffer.from(events.map(r=>encoded(r.event).toString()+'\n').join(''))));
 const wire=(await f.read('/api/v1/events?after='+String(BigInt(imported.receipt.fromSeq)-1n))).json.batches[0];assert.deepEqual(events.map(x=>x.event),wire.events);
 const p=await preview(f,saved.bytes);assert.equal(p.review.editable,true);assert.equal(p.review.formatVersion,5);await workspace(f,{type:'ImportBundle',reviewId:p.review.reviewId,reviewHash:p.review.reviewHash});
 const second=await copy(f,p.review.documentId),g=await setup(t),review=await preview(g,second.bytes);assert.equal(review.review.editable,true);await workspace(g,{type:'ImportBundle',reviewId:review.review.reviewId,reviewHash:review.review.reviewHash});assert.deepEqual((await binary(g,'/api/v1/assets/'+(await doc(g,review.review.documentId)).image.compositeAssetId+'/content')).bytes,(await binary(f,'/api/v1/assets/'+(await doc(f,p.review.documentId)).image.compositeAssetId+'/content')).bytes);
 const nested=records(await unpack(f.root,second.bytes)).values.filter(r=>r.kind==='transaction'&&r.sourceArchive===saved.bundle.blob.hash);assert(nested.some(r=>r.receipt.transactionId===tx.receipt.transactionId));assert.equal(second.bytes.includes(saved.bytes),true);
 t.diagnostic(JSON.stringify({finding:'I-PF01',formatVersion:5,originalReceipt:tx.receipt,eventsHash:tx.eventsHash,sourceArchive:saved.bundle.blob.hash,newArchive:second.bundle.blob.hash,freshWorkspaceImport:review.review.documentId}));
});
const mutations={
 prefix:(e,r,tx)=>e.values.splice(e.values.findIndex(x=>x.event.workspaceSeq===tx.receipt.fromSeq),1),
 tail:(e,r,tx)=>e.values.splice(e.values.findIndex(x=>x.event.workspaceSeq===tx.receipt.toSeq),1),
 'wrong-count':(e,r,tx)=>tx.eventCount='1',
 'wrong-first':(e,r,tx)=>{tx.receipt.fromSeq=String(BigInt(tx.receipt.fromSeq)+1n);tx.eventCount='1';},
 'wrong-last':(e,r,tx)=>{tx.receipt.toSeq=String(BigInt(tx.receipt.toSeq)+1n);tx.eventCount='3';},
 'wrong-hash':(e,r,tx)=>tx.eventsHash='sha256:'+'0'.repeat(64),
 'wrong-command':(e,r,tx)=>tx.receipt.commandId='different_command',
 'wrong-revision':(e,r,tx)=>tx.receipt.documentRevision='999',
 'missing-descriptor':(e,r,tx)=>r.values.splice(r.values.indexOf(tx),1),
 'duplicate-descriptor':(e,r,tx)=>r.values.push(structuredClone(tx)),
 'duplicate-event-id':(e,r,tx)=>{const es=e.values.filter(x=>x.event.transactionId===tx.receipt.transactionId);es[1].event.eventId=es[0].event.eventId;tx.eventsHash='sha256:'+hash(Buffer.from(es.map(r=>encoded(r.event).toString()+'\n').join('')));},
 'split-one-command':(e,r,tx)=>{const es=e.values.filter(x=>x.event.transactionId===tx.receipt.transactionId),tail=structuredClone(tx);tail.receipt.transactionId='split_transaction';tail.receipt.fromSeq=tx.receipt.toSeq;tail.eventCount='1';es[1].event.transactionId=tail.receipt.transactionId;tail.eventsHash='sha256:'+hash(Buffer.from(encoded(es[1].event).toString()+'\n'));tx.receipt.toSeq=tx.receipt.fromSeq;tx.receipt.documentRevision=null;tx.eventCount='1';tx.eventsHash='sha256:'+hash(Buffer.from(encoded(es[0].event).toString()+'\n'));r.values.push(tail);},
};
for(const [name,mutate] of Object.entries(mutations))test('public preview rejects '+name+' transaction with no namespace or source change',async t=>{
 const {f,imported,saved}=await fixture(t),entries=await unpack(f.root,saved.bytes),r=records(entries),e=records(entries,'events'),tx=r.values.find(r=>r.kind==='transaction'&&r.receipt.transactionId===imported.receipt.transactionId);mutate(e,r,tx);putRecords(entries,r.path,r.values);putRecords(entries,e.path,e.values);const bytes=await pack(f.root,entries),stage=await upload(f,bytes),before=retained(f.root),original=await doc(f);
 const command=f.command({documentId:null,expectedDocumentRevision:null,body:{type:'PreviewBundleImport',stagingId:stage.stagingId,expectedSha256:stage.sha256}}),result=await terminal(f,command);assert.equal(result.json.receipt.status,'rejected',result.text);assert.deepEqual((await terminal(f,command)).json.receipt,result.json.receipt);assert.deepEqual(await doc(f),original);assert.deepEqual(retained(f.root),before);
 assert.equal(digest(saved.bytes),saved.bundle.blob.hash);t.diagnostic(JSON.stringify({finding:'I-PF01',mutation:name,originalBounds:imported.receipt,commandId:command.command.commandId,receipt:result.json.receipt,archiveHash:digest(bytes),noNamespace:true}));
});
test('legacy format1 retains inspection and explicitly refuses editable publication',async t=>{
 const {f,saved}=await fixture(t),entries=await unpack(f.root,saved.bytes),r=records(entries),m=JSON.parse(entries.get('manifest.json'));m.formatVersion=1;m.documentSchema=2;entries.set('manifest.json',encoded(m));putRecords(entries,r.path,r.values.filter(x=>x.kind!=='transaction'));const bytes=await pack(f.root,entries),before=await doc(f),p=await preview(f,bytes);assert.equal(p.review.editable,false);assert.equal(p.review.reason,'LEGACY_TRANSACTION_BOUNDS_UNAVAILABLE');
 const c=f.command({documentId:null,expectedDocumentRevision:null,body:{type:'ImportBundle',reviewId:p.review.reviewId,reviewHash:p.review.reviewHash}}),r0=retained(f.root),result=await terminal(f,c);assert.equal(result.json.receipt.status,'rejected');assert.deepEqual(await doc(f),before);assert.deepEqual(retained(f.root),r0);assert.equal(p.review.source.hash,digest(bytes));
});

test('unchanged independent d4 hostile archives never become editable or publish a namespace',async t=>{
 const {readFile}=await import('node:fs/promises');
 for(const name of ['drop-transaction-prefix.zip','hostile-duplicate-event-id.zip','hostile-split-one-command.zip']){
  const f=await setup(t),bytes=await readFile(new URL('../../evidence/p1b6-correction/original-review/'+name,import.meta.url)),s=await upload(f,bytes),c=f.command({documentId:null,expectedDocumentRevision:null,body:{type:'PreviewBundleImport',stagingId:s.stagingId,expectedSha256:s.sha256}}),r=await terminal(f,c);
  if(name==='drop-transaction-prefix.zip'){
   assert.equal(r.json.receipt.status,'accepted');const e=(await f.read('/api/v1/events?after='+String(BigInt(r.json.receipt.fromSeq)-1n))).json.batches[0].events[0],review=(await f.read('/api/v1/bundle-reviews/'+e.payload.reviewId)).json;assert.equal(review.editable,false);assert.equal(review.reason,'LEGACY_TRANSACTION_BOUNDS_UNAVAILABLE');const imported=await terminal(f,f.command({documentId:null,expectedDocumentRevision:null,body:{type:'ImportBundle',reviewId:review.reviewId,reviewHash:review.reviewHash}}));assert.equal(imported.json.receipt.status,'rejected');
  }else assert.equal(r.json.receipt.status,'rejected');assert.deepEqual(retained(f.root).namespaces,[]);t.diagnostic(JSON.stringify({finding:'I-PF01',unchangedReviewerArtifact:name,sha256:digest(bytes),receipt:r.json.receipt,noEditableNamespace:true}));
 }
});
