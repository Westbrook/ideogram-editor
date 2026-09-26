import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {setup,copy,preview,workspace,terminal,edit,doc,upload} from './source/tests/portable/helpers.mjs';
import {importRaster} from './source/tests/raster/helpers.mjs';
import {unpack,pack,replaceEvents,sha} from './reviewer-archive.mjs';
for(const mutation of ['control','drop-transaction-prefix','change-command-identity'])test('independent transaction completeness '+mutation,async t=>{
 const f=await setup(t);await terminal(f,f.command({}, {width:3,height:2}));const {asset}=await importRaster(f,'hidden-alpha.png');const changed=await edit(f,{type:'ImportAsset',assetId:asset.id,layerId:'photo',name:'Literal source',draft:null});const saved=await copy(f),entries=unpack(saved.bytes);
 const all=JSON.parse(entries.get('manifest.json')).segments.filter(s=>s.kind==='events').flatMap(s=>entries.get(s.path).toString().trimEnd().split('\n').map(JSON.parse));const tx=all.filter(r=>r.event.transactionId===changed.receipt.transactionId);assert(tx.length>=2);assert.equal(tx[0].event.workspaceSeq,changed.receipt.fromSeq);assert.equal(tx.at(-1).event.workspaceSeq,changed.receipt.toSeq);
 let removed=[];
 if(mutation==='drop-transaction-prefix')removed=replaceEvents(entries,rows=>rows.filter(r=>r.event.eventId!==tx[0].event.eventId));
 if(mutation==='change-command-identity')replaceEvents(entries,rows=>rows.map(r=>r.event.transactionId===changed.receipt.transactionId?{...r,event:{...r.event,commandId:'invented_command'}}:r));
 const bytes=pack(entries);await writeFile(new URL('./'+mutation+'.zip',import.meta.url),bytes);const stage=await upload(f,bytes),c=f.command({documentId:null,expectedDocumentRevision:null,body:{type:'PreviewBundleImport',stagingId:stage.stagingId,expectedSha256:stage.sha256}}),r=await terminal(f,c);
 let review=null,importReceipt=null;if(r.json.receipt.status==='accepted'){const batch=(await f.read('/api/v1/events?after='+String(BigInt(r.json.receipt.fromSeq)-1n))).json.batches[0];review=(await f.read('/api/v1/bundle-reviews/'+batch.events[0].payload.reviewId)).json;if(review.editable)importReceipt=(await workspace(f,{type:'ImportBundle',reviewId:review.reviewId,reviewHash:review.reviewHash})).receipt;}
 const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});const namespaces=db.prepare('SELECT count(*) n FROM portable_namespaces').get().n;db.close();
 const result={mutation,originalReceipt:changed.receipt,originalTransaction:tx.map(x=>({seq:x.event.workspaceSeq,type:x.event.type,commandId:x.event.commandId})),removed:removed.map(x=>({seq:x.event.workspaceSeq,type:x.event.type})),archiveSHA256:sha(bytes),previewReceipt:r.json.receipt,review,importReceipt,namespaces,sourceDocumentPreserved:JSON.stringify(await doc(f))===JSON.stringify(changed.document)};
 await writeFile(new URL('./'+mutation+'.json',import.meta.url),JSON.stringify(result,null,2));t.diagnostic(JSON.stringify(result));
 if(mutation==='control'){assert.equal(review?.editable,true);assert.equal(importReceipt?.status,'accepted');}else assert.equal(review?.editable??false,false,'Incomplete/altered transaction was advertised editable and imported');
});
