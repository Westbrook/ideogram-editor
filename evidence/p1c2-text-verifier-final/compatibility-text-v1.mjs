import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {isolated} from './source/tests/text-state/helpers.mjs';
import {doc,preview,workspace,copy,upload,terminal,binary} from './source/tests/portable/helpers.mjs';
import {canonical} from './source/dist/local/server/storage/canonical.js';
const out=resolve('../compatibility-text-v1');await mkdir(out);const callbacks=[],t={after:fn=>callbacks.push(fn)};
const result={historicalTarget:'648a35abce7c2a91e90c132c38b6868f2790e5a1',currentProfile:JSON.parse(await readFile('src/text/profile.json')).id};let f;
try{
 f=await isolated(t);const archive=await readFile('../legacy-text-v1/controls-chromium/all-history.ideogram-project');const p=await preview(f,archive);assert(p.review.editable);result.validHistoricalReview=p.review;
 const imported=await workspace(f,{type:'ImportBundle',reviewId:p.review.reviewId,reviewHash:p.review.reviewHash}),id=imported.event.payload.document.id,before=await doc(f,id),state=(await f.read('/api/v1/documents/'+id+'/image')).json;
 const object=ref=>join(f.root,'objects','sha256',ref.hash.slice(7,9),ref.hash.slice(7));
 const source=JSON.parse(await readFile(object(state.layers[0].source))),expected=JSON.parse(await readFile('../legacy-text-v1/controls-chromium/plain-candidate.json')).source;assert.equal(canonical(source),canonical(expected));assert.equal(source.render.rendererProfile.id,'sha256:b89503d3870ea8397f005457f74df91335041d71cb3698df3eb400c96b6176ee');result.exactRetainedSource=source;result.importedNamespace=id;
 const pixels=await readFile(object(source.render.pixels)),exported=await copy(f,id);await writeFile(join(out,'b895-reexport.ideogram-project'),exported.bytes);assert((await preview(f,exported.bytes)).review.editable);result.reexportEditable=true;
 await f.server.close();f=await isolated(t,{root:f.root});assert.deepEqual(await doc(f,id),before);assert.deepEqual(await readFile(object(source.render.pixels)),pixels);result.reopenRetainedBytes=true;
 const malformed=await readFile('/Users/westbrook/Documents/repos/ideogram-edit-p1c2-review-648a35a-20260926T222408Z/controls-chromium/all-history.ideogram-project'),stage=await upload(f,malformed);
 const response=await terminal(f,f.command({documentId:null,expectedDocumentRevision:null,body:{type:'PreviewBundleImport',stagingId:stage.stagingId,expectedSha256:stage.sha256}}));result.malformedHistoricalResponse=response.json;assert.equal(response.json.receipt.status,'rejected');assert.deepEqual(await doc(f,id),before);result.malformedHistoricalEditableRefused=true;result.complete=true;
}catch(e){result.failure={message:e.message,stack:e.stack};throw e;}finally{if(f)await f.server.close();for(const cb of callbacks.reverse())await cb();await writeFile(join(out,'result.json'),JSON.stringify(result,null,2));}
console.log(JSON.stringify(result,null,2));
