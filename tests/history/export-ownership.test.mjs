import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setup,copy,preview,workspace,upload,terminal,doc,edit} from '../portable/helpers.mjs';
import {importRaster,binary} from '../raster/helpers.mjs';
import {unpack,pack,records,putRecords,changeEntity,encoded} from '../portable/archive-fixture.mjs';

async function fixture(t){
 let f;t.after(async()=>{if(f)await f.server.close();});f=await setup(t);
 assert.equal((await terminal(f,f.command({}, {width:1,height:1}))).json.receipt.status,'accepted');
 const {asset}=await importRaster(f,'black.png');await edit(f,{type:'ImportAsset',assetId:asset.id,layerId:'picture',name:'Original',draft:null});
 const source=await doc(f),exported=(await edit(f,{type:'ExportDocument',historyHead:source.historyHead})).event.payload.asset,bytes=(await binary(f,exported.id)).bytes;
 const original=await copy(f),reviewed=await preview(f,original.bytes);assert.equal(reviewed.review.editable,true);
 const mappings=(await f.read('/api/v1/bundle-reviews/'+reviewed.review.reviewId+'/mapping?kind=asset')).json.items,mapped=mappings.find(item=>item.sourceId===exported.id)?.localId;assert.ok(mapped);
 await workspace(f,{type:'ImportBundle',reviewId:reviewed.review.reviewId,reviewHash:reviewed.review.reviewHash});
 const imported=await doc(f,reviewed.review.documentId),saved=await copy(f,imported.id),entries=await unpack(f.root,saved.bytes),relations=records(entries).values.filter(value=>value.kind==='entity'&&value.entityType==='retained-export');
 assert.equal(relations.length,1);assert.deepEqual(JSON.parse(entries.get('objects/'+relations[0].payloadRef.hash.slice(7))),{id:mapped,documentId:imported.id,assetId:mapped});
 assert.equal(JSON.parse(entries.get('manifest.json')).formatVersion,9);assert.equal((await preview(f,saved.bytes)).review.editable,true);
 assert.deepEqual((await binary(f,mapped)).bytes,bytes);
 return {...f,source,exported,imported,mapped,bytes,entries};
}
function changeRelation(entries,change,rename=false){
 const value=changeEntity(entries,'retained-export',change);
 if(rename){const r=records(entries);r.values.find(value=>value.kind==='entity'&&value.entityType==='retained-export').logicalId=value.id;putRecords(entries,r.path,r.values);}
}
function namespaceCount(f){const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});try{return db.prepare('SELECT count(*) n FROM portable_namespaces').get().n;}finally{db.close();}}

test('retained export ownership rejects malformed, cross-document, foreign namespace and orphan archives',async t=>{
 const f=await fixture(t),before=namespaceCount(f);
 const cases={
  'unknown authority field':e=>changeRelation(e,value=>{value.namespaceId='forged_namespace';}),
  'asset identity differs from relation identity':e=>changeRelation(e,value=>{value.assetId=f.imported.image.compositeAssetId;}),
  'logical entity identity differs from payload':e=>{const r=records(e);r.values.find(value=>value.kind==='entity'&&value.entityType==='retained-export').logicalId='forged_export';putRecords(e,r.path,r.values);},
  'another source document':e=>changeRelation(e,value=>{value.documentId=f.source.id;}),
  'unmapped asset from the original namespace':e=>{
   assert.equal(records(e).values.some(value=>value.kind==='entity'&&value.entityType==='asset'&&value.logicalId===f.exported.id),false);
   changeRelation(e,value=>{value.id=value.assetId=f.exported.id;},true);
  },
  'document raster claimed as an export':e=>changeRelation(e,value=>{value.id=value.assetId=f.imported.image.compositeAssetId;},true),
  'export retained without a document ownership edge':e=>{const r=records(e);putRecords(e,r.path,r.values.filter(value=>value.kind!=='entity'||value.entityType!=='retained-export'));},
  'new ownership record downgraded to format seven':e=>{const manifest=JSON.parse(e.get('manifest.json'));manifest.formatVersion=manifest.documentSchema=7;e.set('manifest.json',encoded(manifest));},
 };
 for(const [name,mutate] of Object.entries(cases))await t.test(name,async()=>{
  const entries=new Map(f.entries);mutate(entries);const bytes=await pack(f.root,entries),staged=await upload(f,bytes),command=f.command({documentId:null,expectedDocumentRevision:null,body:{type:'PreviewBundleImport',stagingId:staged.stagingId,expectedSha256:staged.sha256}}),result=await terminal(f,command);
  assert.equal(result.json.receipt.status,'rejected',result.text);assert.equal(result.json.receipt.code,'INVALID_INPUT');assert.deepEqual((await terminal(f,command)).json.receipt,result.json.receipt);
  assert.equal(namespaceCount(f),before);assert.deepEqual(await doc(f),f.source);assert.deepEqual(await doc(f,f.imported.id),f.imported);assert.deepEqual((await binary(f,f.mapped)).bytes,f.bytes);
 });
});
