import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,mkdir,symlink} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {chromium} from '@playwright/test';
import {priorWriter} from '../text-state/prior-writer.mjs';
import {isolated} from '../text-state/helpers.mjs';
import {copy,preview,workspace,doc,edit,binary} from '../portable/helpers.mjs';
import {ownedOPFS} from '../editor/owned-opfs.ts';
import {canonical} from '../../dist/local/server/storage/canonical.js';
const oldCommit='d3c6046a44d29d89ccdcb219cc37d40f02bad84f';
const file=(root,ref)=>join(root,'objects','sha256',ref.hash.slice(7,9),ref.hash.slice(7));
test('actual d3c profile304 PF5 text retains exact source fonts pixels and legacy origin through PF6',async t=>{
 const old=await priorWriter(t,oldCommit),app=join(old.directory,'placement-compat-app');
 await mkdir(join(old.directory,'vendor/text'),{recursive:true});await symlink(resolve('vendor/text/fonts'),join(old.directory,'vendor/text/fonts'));
 for(const args of [['build','--config','tooling/text/verifier.vite.config.ts'],['build','--config','tests/text-state/vite.config.ts','--outDir',app]])execFileSync(process.execPath,[resolve('node_modules/vite/bin/vite.js'),...args],{cwd:old.directory,stdio:'pipe'});
 const legacy=await isolated(t,{fixtureDirectory:old.directory,staticDirectory:app}),profile=JSON.parse(await readFile('src/text/retained-profiles/304528c9.json'));
 await old.terminal(legacy,legacy.command({}, {width:120,height:70}));
 const stage=async(bytes,media='application/octet-stream',purpose='text')=>{const s=await old.upload(legacy,bytes,purpose,purpose==='caption'?'text/plain':'application/octet-stream'),asset=(await old.workspace(legacy,{type:'FinalizeStaging',stagingId:s.stagingId,expectedSha256:s.sha256})).event.payload.asset;return {...asset.blob,mediaType:media};};
 const font=profile.fonts.find(f=>f.id==='NotoSans'),source=await stage(await readFile('vendor/text/'+font.file),'application/octet-stream','font'),license=await stage(await readFile('vendor/text/'+font.licenseFile),'text/plain','caption');
 const fonts=[(await old.edit(legacy,{type:'ImportFont',source,license,origin:'bundled',embeddingReviewed:true})).event.payload.asset.font];
 const text='Retained text',textUtf8=await stage(Buffer.from(text),'text/plain','caption'),style={primaryFont:fonts[0].bytes.hash,explicitFallbacks:[],sizePx:32,lineHeightMultiplier:1.2,fill:[40,90,190,255],align:'start',direction:'auto'},frame={width:120,height:70};
 const draftBytes=Buffer.from(canonical({schemaVersion:1,kind:'text-draft-1',textUtf8,style,frame,fonts})),s=await old.upload(legacy,draftBytes,'caption','text/plain'),caption=(await old.workspace(legacy,{type:'FinalizeStaging',stagingId:s.stagingId,expectedSha256:s.sha256})).event.payload.asset;
 const d=await old.doc(legacy);assert.equal((await legacy.post('/api/v1/ui/session_1',{protocolVersion:1,requestId:randomUUID(),sessionId:'session_1',expectedUISeq:'0',body:{type:'SaveDraft',draft:{id:'legacy_text',generation:'1',kind:'text',documentId:d.id,targetLayerId:null,expectedDocumentRevision:d.revision,assetId:caption.id,composing:false}}})).json.status,'accepted');
 const browser=await chromium.launch(),context=await browser.newContext(),page=await context.newPage(),closed=[],errors=[];page.on('worker',worker=>closed.push(new Promise(r=>worker.once('close',r))));page.on('pageerror',e=>errors.push(e.message));let result;const guard=await ownedOPFS(context,'p1c4-retained-profile');
 try{await guard.admit(page,legacy.server.origin);await page.exposeFunction('stage',(bytes,media)=>stage(Buffer.from(bytes,'base64'),media));await page.exposeFunction('admit',async id=>assert.equal((await legacy.post('/api/v1/text-admission/'+id,{protocolVersion:1})).status,200));
  await page.goto(legacy.server.origin);await page.waitForFunction(()=>!!window.DurableTextPreparation);
  result=await page.evaluate(async({text,revision,fonts,frame})=>{window.preparation=new window.DurableTextPreparation({admit:id=>window.admit(id),releaseAdmission:async()=>{},stage:async(blob,media)=>{const b=new Uint8Array(await blob.arrayBuffer());let raw='';for(let at=0;at<b.length;at+=32768)raw+=String.fromCharCode(...b.subarray(at,at+32768));return window.stage(btoa(raw),media);}});const request=await window.textFixture.request(text,['NotoSans'],{frame,token:{documentId:'document_1',documentRevision:revision,layerId:'native_text',layerVersion:'0',sessionId:'session_1',generation:1}});return window.preparation.prepare(request,fonts);},{text,revision:d.revision,fonts,frame});
  t.diagnostic(JSON.stringify({phase:'historical-before-create-text-layer',server:legacy.process,fixtureSHA256:createHash('sha256').update(await readFile(legacy.process.fixture)).digest('hex'),serverMemory:(await legacy.memory()).usage,driverMemory:process.memoryUsage(),scope:'Point-in-time diagnostic; not a resource qualification'}));
  await old.edit(legacy,{type:'CreateTextLayer',layerId:'native_text',name:'Legacy text',candidate:result.candidate,draft:{sessionId:'session_1',draftId:'legacy_text',generation:'1'},admissionId:result.admissionId});
  await page.evaluate(()=>{window.preparation.dispose();window.textFixture.renderer.dispose();});await Promise.race([Promise.all(closed),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Old native worker close not observed')),10000);timer.unref();})]);assert.deepEqual(errors,[]);
 }finally{try{await page.goto('about:blank');await guard.cleanup();guard.verify();}finally{await context.close();await browser.close();}}
 // The exact admission remains live through CreateTextLayer and real worker/
 // context shutdown. Only that observed shutdown permits its explicit release.
 const released=await legacy.post('/api/v1/text-admission/'+result.admissionId+'/release',{protocolVersion:1});assert.equal(released.status,200,released.text);
 const state=(await legacy.read('/api/v1/documents/document_1/image')).json,legacySource=JSON.parse(await readFile(file(legacy.root,state.layers[0].source)));assert.equal(legacySource.render.rendererProfile.id,profile.id);
 const archive=await old.copy(legacy);await legacy.server.close();
 // Keep the current product server in its own process, as for the historical
 // server above. The Playwright/legacy-build driver is not product RSS.
 const f=await isolated(t);assert.notEqual(f.process.pid,process.pid);
 t.diagnostic(JSON.stringify({phase:'current-before-bundle-import',server:f.process,fixtureSHA256:createHash('sha256').update(await readFile(f.process.fixture)).digest('hex'),serverMemory:(await f.memory()).usage,driverMemory:process.memoryUsage(),scope:'Point-in-time diagnostic; not a resource qualification'}));
 const review=(await preview(f,archive.bytes)).review;assert.equal(review.formatVersion,5);assert.equal(review.editable,true,JSON.stringify(review));await workspace(f,{type:'ImportBundle',reviewId:review.reviewId,reviewHash:review.reviewHash});
 const imported=(await f.read('/api/v1/documents/'+review.documentId+'/image')).json;assert.equal(imported.layers[0].source.hash,state.layers[0].source.hash);
 const layer=imported.layers[0];assert.deepEqual(layer.layerToDocument,[1,0,0,1,0,0]);
 const moved=await edit(f,{type:'ApplyTransform',layerId:layer.id,layerVersion:layer.version,transform:[1,0,0,1,-2.5,8.25],draft:null},review.documentId);await edit(f,{type:'Undo',historyHead:moved.document.historyHead},review.documentId);await edit(f,{type:'Redo',historyNode:moved.document.historyHead},review.documentId);
 const current=await copy(f,review.documentId),roundtrip=(await preview(f,current.bytes)).review;assert.equal(roundtrip.formatVersion,9);assert.equal(roundtrip.editable,true);await workspace(f,{type:'ImportBundle',reviewId:roundtrip.reviewId,reviewHash:roundtrip.reviewHash});
 const restored=(await f.read('/api/v1/documents/'+roundtrip.documentId+'/image')).json;assert.equal(restored.schemaVersion,2);assert.deepEqual(restored.layers[0].layerToDocument,[1,0,0,1,-2.5,8.25]);assert.equal(restored.layers[0].source.hash,state.layers[0].source.hash);assert.deepEqual((await binary(f,'/api/v1/assets/'+(await doc(f,roundtrip.documentId)).image.compositeAssetId+'/content')).bytes,(await binary(f,'/api/v1/assets/'+(await doc(f,review.documentId)).image.compositeAssetId+'/content')).bytes);
 t.diagnostic(JSON.stringify({priorExecutable:oldCommit,priorProfile:profile.id,legacyArchive:archive.bundle.blob,currentArchive:current.bundle.blob,retainedSource:state.layers[0].source,actualWorkerCloseSignals:closed.length,ownedStorage:guard.ledger,oldFixtureFiles:await Promise.all((await readdir(join(app,'assets'))).map(async name=>({name,sha256:createHash('sha256').update(await readFile(join(app,'assets',name))).digest('hex')})))}));
 await f.server.close();
});
