import test from 'node:test';
import assert from 'node:assert/strict';
import {setup,copy,preview,workspace,upload,terminal,doc,edit,binary} from '../portable/helpers.mjs';
import {importRaster,operate} from '../raster/helpers.mjs';
import {priorWriter} from '../text-state/prior-writer.mjs';
import {unpack,pack,encoded,records} from '../portable/archive-fixture.mjs';
let old;test.before(async t=>old=await priorWriter(t,'4b2c82ccc41dd72c3f83480f23481b7b62135d23'));
test('actual4b2 PF3 opens unchanged; actual4b2 inspects PF9 without editable import; false PF3 mask claims reject',async t=>{
 const legacy=await old.setup(t);await old.terminal(legacy,legacy.command({}, {width:3,height:2}));const {asset}=await old.importRaster(legacy,'hidden-alpha.png');await old.edit(legacy,{type:'ImportAsset',assetId:asset.id,layerId:'picture',name:'Original',draft:null});const oldCopy=await old.copy(legacy);
 const f=await setup(t),review=(await preview(f,oldCopy.bytes)).review;assert.equal(review.formatVersion,3);assert.equal(review.editable,true);await workspace(f,{type:'ImportBundle',reviewId:review.reviewId,reviewHash:review.reviewHash});
 const d=await doc(f,review.documentId),before=await binary(f,'/api/v1/assets/'+d.image.compositeAssetId+'/content');const original=await old.binary(legacy,'/api/v1/assets/'+(await old.doc(legacy)).image.compositeAssetId+'/content');assert.deepEqual(before.bytes,original.bytes);
 const image=(await f.read('/api/v1/documents/'+d.id+'/image')).json,layer=image.layers[0];const mask=(await operate(f,{type:'PrepareMask',plan:{width:3,height:2,feather:2,operations:[{kind:'fill'}]}})).event.payload.asset;
 assert.equal(mask.raster.schemaVersion,2);const manifest=(await f.read('/api/v1/assets/'+mask.id+'/raster')).json;assert.equal(manifest.schemaVersion,2);
 await edit(f,{type:'SetLayerProperties',layerId:layer.id,layerVersion:layer.version,properties:{mask:{assetId:mask.id,mapping:'document-r16-v1',inverted:false}},draft:null},d.id);assert.equal((await f.read('/api/v1/documents/'+d.id+'/image')).json.schemaVersion,3);
 const current=await copy(f,d.id),entries=await unpack(f.root,current.bytes),m=JSON.parse(entries.get('manifest.json'));
 // Namespace remapping now retains each original raster manifest. That typed
 // provenance requires PF9 even though this actual prior document stays PF3.
 assert.equal(m.formatVersion,9);assert.equal(m.documentSchema,9);
 const assets=records(entries).values.filter(r=>r.kind==='entity'&&r.entityType==='asset').map(r=>JSON.parse(entries.get('objects/'+r.payloadRef.hash.slice(7))));
 assert(assets.some(a=>a.retainedMetadata&&JSON.parse(entries.get('objects/'+a.retainedMetadata.hash.slice(7))).manifest?.hash===asset.raster.manifest.hash),'PF9 retains the actual PF3 raster manifest');
 assert(entries.has('objects/'+asset.raster.manifest.hash.slice(7)));
 const prior=(await old.preview(legacy,current.bytes)).review;assert.equal(prior.formatVersion,9);assert.equal(prior.documentSchema,9);assert.equal(prior.editable,false);assert.equal(prior.reason,'UNSUPPORTED_FORMAT_VERSION');const blocked=await old.terminal(legacy,legacy.command({documentId:null,expectedDocumentRevision:null,body:{type:'ImportBundle',reviewId:prior.reviewId,reviewHash:prior.reviewHash}}));assert.equal(blocked.json.receipt.status,'rejected');
 entries.set('manifest.json',encoded({...m,formatVersion:3,documentSchema:3}));const bytes=await pack(f.root,entries),staged=await upload(f,bytes),rejected=await terminal(f,f.command({documentId:null,expectedDocumentRevision:null,body:{type:'PreviewBundleImport',stagingId:staged.stagingId,expectedSha256:staged.sha256}}));assert.equal(rejected.json.receipt.status,'rejected');
 const fresh=await setup(t),accepted=(await preview(fresh,current.bytes)).review;assert.equal(accepted.editable,true);await workspace(fresh,{type:'ImportBundle',reviewId:accepted.reviewId,reviewHash:accepted.reviewHash});assert.deepEqual((await binary(fresh,'/api/v1/assets/'+(await doc(fresh,accepted.documentId)).image.compositeAssetId+'/content')).bytes,(await binary(f,'/api/v1/assets/'+(await doc(f,d.id)).image.compositeAssetId+'/content')).bytes);
 t.diagnostic(JSON.stringify({priorExecutable:'4b2c82ccc41dd72c3f83480f23481b7b62135d23',legacyArchive:oldCopy.bundle.blob,currentArchive:current.bundle.blob,priorRefusal:prior.reason,imageState:3,maskRaster:2,maskManifest:2}));
});
