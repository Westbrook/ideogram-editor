import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {priorWriter} from './source/tests/text-state/prior-writer.mjs';
import {isolated} from './source/tests/text-state/helpers.mjs';
import {terminal,doc,preview,workspace,copy,binary,edit} from './source/tests/portable/helpers.mjs';
import {unpack} from './source/tests/portable/archive-fixture.mjs';
const out=resolve('../compatibility');await mkdir(out);const callbacks=[],t={after:fn=>callbacks.push(fn)};let current,prior;
const result={base:'dcd5f11dbd57cd7ed00c8ddf410857ce4700440e',target:'648a35abce7c2a91e90c132c38b6868f2790e5a1'};
try{
 const old=await priorWriter(t);prior=await old.setup(t);await old.terminal(prior,prior.command({}, {width:3,height:2}));const image=await old.importRaster(prior,'hidden-alpha.png');await old.edit(prior,{type:'ImportAsset',assetId:image.asset.id,layerId:'legacy_image',name:'Exact legacy image',draft:null});await old.edit(prior,{type:'SaveCheckpoint',name:'Actual schema8/PF2 image'});
 const before=await old.doc(prior),saved=await old.copy(prior);await writeFile(join(out,'actual-pf2.ideogram-project'),saved.bytes);const entries=await unpack(prior.root,saved.bytes);result.oldManifest=JSON.parse(entries.get('manifest.json'));assert.equal(result.oldManifest.formatVersion,2);assert.equal(result.oldManifest.documentSchema,2);
 const oldPixels=(await old.binary(prior,'/api/v1/assets/'+before.image.compositeAssetId+'/content')).bytes;await writeFile(join(out,'old-appearance.png'),oldPixels);await prior.server.close();prior=null;
 const root=join(out,'current-store');await mkdir(root,{mode:0o700});current=await isolated(t,{root});const p=await preview(current,saved.bytes);result.review=p.review;assert.equal(p.review.editable,true);const imported=await workspace(current,{type:'ImportBundle',reviewId:p.review.reviewId,reviewHash:p.review.reviewHash});const id=imported.event.payload.document.id,after=await doc(current,id);const pixels=(await binary(current,'/api/v1/assets/'+after.image.compositeAssetId+'/content')).bytes;assert.deepEqual(pixels,oldPixels);result.appearanceExact=true;result.namespaceChanged=id!==before.id;assert(result.namespaceChanged);
 const exported=await copy(current,id);await writeFile(join(out,'reexport-pf3.ideogram-project'),exported.bytes);result.reexportManifest=JSON.parse((await unpack(current.root,exported.bytes)).get('manifest.json'));assert.equal(result.reexportManifest.formatVersion,3);result.complete=true;
} catch(e){result.fatal={message:e.message,stack:e.stack};throw e;}
finally{if(prior)await prior.server.close();if(current)await current.server.close();for(const cb of callbacks.reverse())await cb();await writeFile(join(out,'result.json'),JSON.stringify(result,null,2));}
console.log(JSON.stringify(result,null,2));
