import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {setup,terminal,copy,preview,workspace,upload,edit,doc,digest} from './helpers.mjs';
import {importRaster} from '../raster/helpers.mjs';
import {unpack,records,putRecords,pack,encoded,hash} from './archive-fixture.mjs';

for(const [name,accepted] of [['revision-tail-control-2.zip',true],['format2-domain-revision-hidden-by-tail.zip',false],['revision-tail-control-null.zip',false]])test('public trailing workspace event preserves domain revision evidence: '+name,async t=>{
 const f=await setup(t),bytes=await readFile(new URL('../../evidence/p1b6-linkage-correction/original-review/'+name,import.meta.url));
 await terminal(f,f.command({}, {width:3,height:2}));const before=await doc(f),stage=await upload(f,bytes),command=f.command({documentId:null,expectedDocumentRevision:null,body:{type:'PreviewBundleImport',stagingId:stage.stagingId,expectedSha256:stage.sha256}}),result=await terminal(f,command);
 assert.equal(result.json.receipt.status,accepted?'accepted':'rejected',result.text);
 assert.deepEqual((await terminal(f,command)).json.receipt,result.json.receipt);
 let receipt=null;
 if(accepted){const events=(await f.read('/api/v1/events?after='+String(BigInt(result.json.receipt.fromSeq)-1n))).json.batches[0].events,review=(await f.read('/api/v1/bundle-reviews/'+events[0].payload.reviewId)).json;assert.equal(review.editable,true);receipt=(await workspace(f,{type:'ImportBundle',reviewId:review.reviewId,reviewHash:review.reviewHash})).receipt;assert.equal(receipt.status,'accepted');}
 const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});try{assert.equal(db.prepare('SELECT count(*) n FROM portable_namespaces').get().n,accepted?1:0);const row=db.prepare('SELECT filename FROM staged_assets WHERE id=?').get(stage.stagingId);assert.deepEqual(await readFile(join(f.root,'uploads',row.filename)),bytes);}finally{db.close();}
 assert.deepEqual(await doc(f),before);t.diagnostic(JSON.stringify({finding:'I-PF01',originalReviewerArchive:name,archiveHash:digest(bytes),previewReceipt:result.json.receipt,importReceipt:receipt,sourcePreserved:true}));
});

test('actual nonmutating document receipt retains revision with no domain event in a complete copy',async t=>{
 const f=await setup(t);await terminal(f,f.command({}, {width:3,height:2}));const {asset}=await importRaster(f,'hidden-alpha.png');await edit(f,{type:'ImportAsset',assetId:asset.id,layerId:'picture',name:'Original',draft:null});
 const d=await doc(f),exported=await edit(f,{type:'ExportDocument',historyHead:d.historyHead}),saved=await copy(f),entries=await unpack(f.root,saved.bytes),tx=records(entries).values.find(r=>r.kind==='transaction'&&r.receipt.commandId===exported.receipt.commandId),events=records(entries,'events').values.filter(r=>r.event.commandId===exported.receipt.commandId);
 assert(tx);assert.deepEqual(tx.receipt,exported.receipt);assert.equal(tx.receipt.documentRevision,d.revision);assert(events.length>0);assert(events.every(r=>r.event.documentId===null&&r.event.resultingDocumentRevision===null));
 const fresh=await setup(t),p=await preview(fresh,saved.bytes);assert.equal(p.review.editable,true);const imported=await workspace(fresh,{type:'ImportBundle',reviewId:p.review.reviewId,reviewHash:p.review.reviewHash});assert.equal(imported.receipt.status,'accepted');
 t.diagnostic(JSON.stringify({finding:'I-PF01',noDomainEvents:true,sourceReceipt:exported.receipt,importReceipt:imported.receipt}));
});

test('public preview rejects conflicting domain revisions inside one otherwise contiguous transaction',async t=>{
 const f=await setup(t);await terminal(f,f.command({}, {width:3,height:2}));const {asset}=await importRaster(f,'hidden-alpha.png');const editResult=await edit(f,{type:'ImportAsset',assetId:asset.id,layerId:'picture',name:'Original',draft:null}),checkpoint=await edit(f,{type:'SaveCheckpoint',name:'Retained'}),saved=await copy(f),entries=await unpack(f.root,saved.bytes),r=records(entries),e=records(entries,'events');
 const tx=r.values.find(x=>x.kind==='transaction'&&x.receipt.commandId===editResult.receipt.commandId),cp=r.values.find(x=>x.kind==='transaction'&&x.receipt.commandId===checkpoint.receipt.commandId),event=e.values.find(x=>x.event.commandId===checkpoint.receipt.commandId).event;
 event.commandId=tx.receipt.commandId;event.transactionId=tx.receipt.transactionId;tx.receipt.toSeq=cp.receipt.toSeq;tx.receipt.documentRevision=cp.receipt.documentRevision;tx.eventCount=String(BigInt(tx.receipt.toSeq)-BigInt(tx.receipt.fromSeq)+1n);r.values.splice(r.values.indexOf(cp),1);tx.eventsHash='sha256:'+hash(Buffer.from(e.values.filter(x=>x.event.transactionId===tx.receipt.transactionId).map(x=>encoded(x.event).toString()+'\n').join('')));
 putRecords(entries,r.path,r.values);putRecords(entries,e.path,e.values);const bytes=await pack(f.root,entries),stage=await upload(f,bytes),before=await doc(f),result=await terminal(f,f.command({documentId:null,expectedDocumentRevision:null,body:{type:'PreviewBundleImport',stagingId:stage.stagingId,expectedSha256:stage.sha256}}));assert.equal(result.json.receipt.status,'rejected');assert.deepEqual(await doc(f),before);t.diagnostic(JSON.stringify({finding:'I-PF01',conflictingDomainRevisions:['2','3'],receipt:result.json.receipt}));
});
