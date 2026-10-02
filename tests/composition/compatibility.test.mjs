import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {priorWriter,reopen} from '../text-state/prior-writer.mjs';
import {setup,copy,preview,workspace,upload,terminal,doc,edit,binary} from '../portable/helpers.mjs';
import {unpack,pack,encoded,records,putRecords} from '../portable/archive-fixture.mjs';
import {emptyComposition} from '../../dist/local/src/composition/core.js';
import {canonical} from '../../dist/local/src/protocol/json.js';
import {cookieFrom} from '../session/helpers.mjs';
const oldCommit='d3b8e5f5ec4568547f21a2826792450367144a17';
test('actual accepted PF6 imports intact; current PF9 copy refuses editing in actual d3b8; new raw authority survives restart',async t=>{
 const old=await priorWriter(t,oldCommit),legacy=await old.setup(t);await old.terminal(legacy,legacy.command({}, {width:3,height:2}));const {asset}=await old.importRaster(legacy,'hidden-alpha.png');await old.edit(legacy,{type:'ImportAsset',assetId:asset.id,layerId:'original',name:'Original',draft:null});const baseline=await old.copy(legacy);
 const f=await setup(t),r=(await preview(f,baseline.bytes)).review;assert.equal(r.editable,true);assert.equal(r.formatVersion,6);await workspace(f,{type:'ImportBundle',reviewId:r.reviewId,reviewHash:r.reviewHash});let d=await doc(f,r.documentId);const pixels=(await binary(f,'/api/v1/assets/'+d.image.compositeAssetId+'/content')).bytes;
 const rawBytes=Buffer.from([0xff,0,10,34]),stage=await upload(f,rawBytes,'text','application/octet-stream'),raw=(await workspace(f,{type:'FinalizeStaging',stagingId:stage.stagingId,expectedSha256:stage.sha256})).event.payload.asset.blob,c=emptyComposition(d.width,d.height,randomUUID());c.raw=[raw];c.scene='Exact new semantics';const graph=await upload(f,Buffer.from(canonical(c)),'text','application/octet-stream'),value=(await workspace(f,{type:'FinalizeStaging',stagingId:graph.stagingId,expectedSha256:graph.sha256})).event.payload.asset.blob;await edit(f,{type:'CommitCompositionVersion',composition:{id:c.id,value:{...value,mediaType:'application/json'},bindings:{}},draft:null},d.id);
 // Imported raster manifests retain original metadata after namespace remapping,
 // so this current copy uses PF9; the actual prior producer remains PF6.
 const bundle=await copy(f,d.id),older=(await old.preview(legacy,bundle.bytes)).review;assert.equal(older.formatVersion,9);assert.equal(older.documentSchema,9);assert.equal(older.editable,false);assert.equal(older.reason,'UNSUPPORTED_FORMAT_VERSION');assert.equal((await old.terminal(legacy,legacy.command({documentId:null,expectedDocumentRevision:null,body:{type:'ImportBundle',reviewId:older.reviewId,reviewHash:older.reviewHash}}))).json.receipt.status,'rejected');
 const entries=await unpack(f.root,bundle.bytes),manifest=JSON.parse(entries.get('manifest.json'));entries.set('manifest.json',encoded({...manifest,formatVersion:6,documentSchema:6}));const malicious=await upload(f,await pack(f.root,entries));assert.equal((await terminal(f,f.command({documentId:null,expectedDocumentRevision:null,body:{type:'PreviewBundleImport',stagingId:malicious.stagingId,expectedSha256:malicious.sha256}}))).json.receipt.status,'rejected');
 await f.server.close();const restarted=await reopen(t,f.root,cookieFrom(f.paired));d=await doc(restarted,d.id);const rawAfter=await binary(restarted,'/api/v1/documents/'+d.id+'/composition?revision='+d.revision+'&raw=0&download=1');assert.deepEqual(rawAfter.bytes,rawBytes);assert.deepEqual((await binary(restarted,'/api/v1/assets/'+d.image.compositeAssetId+'/content')).bytes,pixels);assert.equal((await restarted.read('/api/v1/documents/'+d.id+'/composition?revision='+d.revision)).json.composition.scene,c.scene);
 t.diagnostic(JSON.stringify({oldCommit,legacyArchive:baseline.bundle.blob,newArchive:bundle.bundle.blob,oldReader:older.reason,restartRaw:raw,unchangedPixels:true}));
});
