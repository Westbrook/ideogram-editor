import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {rootFor,command,pair,call,cookieFrom,readHeaders,mutationHeaders} from '../protocol/helpers.mjs';
import {importRaster,operate,terminal} from '../raster/helpers.mjs';
import {upload,copy,preview,workspace,edit,doc} from '../portable/helpers.mjs';
import {unpack,records} from '../portable/archive-fixture.mjs';
import {child} from '../portable/process-helpers.mjs';
import {startLocalServer} from '../../dist/local/server/http.js';
import {EMPTY_EXPECTED_VERSIONS} from '../../dist/local/src/protocol/store.js';
import {canonical} from '../../dist/local/server/storage/canonical.js';
import {verificationBudget} from '../../dist/local/src/protocol/text-budget.js';
import {newDraft,bindRequestMask,confirmRequestMask} from '../../dist/local/src/request/core.js';
import {emptyComposition,emptyElement,serialize,compositionRefs} from '../../dist/local/src/composition/core.js';
import {returnedPrompt} from './candidate-copy-observer-fixture.mjs';

const REQUESTED_PROMPT='Requested exact Café / e\u0301 / 🦋\nhttps://authored.invalid/?signature=literal\n';
const NATIVE_TEXT='Native Café\nretained source';
const objectPath=(root,ref)=>join(root,'objects','sha256',ref.hash.slice(7,9),ref.hash.slice(7));
const sha=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const identify=value=>({...value,id:sha(canonical(value))});
const imageState=async(f,id='document_1')=>(await f.read('/api/v1/documents/'+id+'/image')).json;
async function retained(f,ref){const bytes=await readFile(objectPath(f.root,ref));assert.equal(sha(bytes),ref.hash);assert.equal(String(bytes.length),ref.byteLength);return bytes;}
async function jsonObject(f,ref){return JSON.parse(await retained(f,ref));}
async function stage(f,bytes,purpose='caption',mediaType='text/plain'){
  const staged=await upload(f,bytes,purpose,mediaType),result=await workspace(f,{type:'FinalizeStaging',stagingId:staged.stagingId,expectedSha256:staged.sha256});return result.event.payload.asset;
}
async function ui(f,body,sessionId='candidate_copy'){
  const current=(await f.read('/api/v1/ui/'+sessionId)).json,request={protocolVersion:1,requestId:randomUUID(),sessionId,expectedUISeq:current.uiSeq,body};
  const response=await f.post('/api/v1/ui/'+sessionId,request);assert.equal(response.json.status,'accepted',response.text);return {request,value:response.json};
}
async function importBundle(f,review){
  // This multi-generation functional fixture verifies every retained ancestor.
  // Give that import its own finite deadline; poll the original command only.
  const value=f.command({documentId:null,expectedDocumentRevision:null,body:{type:'ImportBundle',reviewId:review.reviewId,reviewHash:review.reviewHash}}),deadline=performance.now()+30000;
  let response=await f.post('/api/v1/commands',value);
  while(response.status===202&&performance.now()<deadline){
    assert.equal(response.headers.location,response.json.receiptUrl);
    await new Promise(resolve=>setTimeout(resolve,10));
    response=await f.read('/api/v1/commands/'+value.command.commandId);
  }
  assert.equal(response.status,200,response.text);assert.equal(response.json.receipt.status,'accepted',response.text);
}
function withLeases(f){
  const read=f.read.bind(f),leases=new Set();f.read=async path=>{const result=await read(path);if(result.json?.recovery?.recoveryId)leases.add(result.json.recovery.recoveryId);return result;};
  f.releaseLeases=async()=>{for(const id of leases)assert.equal((await f.post('/api/v1/recovery/'+id+'/release',{protocolVersion:1})).status,204);leases.clear();};return f;
}
async function fixture(t){
  // Node runs after hooks in registration order. Stop every writer before
  // rootFor's cleanup removes the provider fixture's final diagnostic target.
  const closers=[];t.after(async()=>{for(const close of closers.toReversed())await close();});
  const root=await rootFor(t),server=await startLocalServer({root},{writer:{setupModule:new URL('./candidate-copy-observer-fixture.mjs',import.meta.url).href}});closers.push(()=>server.close());
  const paired=await pair(server);assert.equal(paired.status,200,paired.text);
  return withLeases({root,server,paired,closeBeforeCleanup:close=>closers.push(close),read:path=>call(server.origin,path,{headers:readHeaders(cookieFrom(paired))}),post:(path,body)=>call(server.origin,path,{method:'POST',body,headers:mutationHeaders(server,paired)}),command:(patch={},body={})=>command(EMPTY_EXPECTED_VERSIONS,{clientId:paired.json.clientId,...patch},body)});
}
async function providerRestart(f){
  const server=await startLocalServer({root:f.root},{writer:{setupModule:new URL('./candidate-copy-observer-fixture.mjs',import.meta.url).href}});f.closeBeforeCleanup(()=>server.close());
  const paired=await pair(server);assert.equal(paired.status,200,paired.text);
  return withLeases({root:f.root,server,paired,read:path=>call(server.origin,path,{headers:readHeaders(cookieFrom(paired))}),post:(path,body)=>call(server.origin,path,{method:'POST',body,headers:mutationHeaders(server,paired)}),command:(patch={},body={})=>command(EMPTY_EXPECTED_VERSIONS,{clientId:paired.json.clientId,...patch},body)});
}
async function guardedRestart(t,f,cookie){
  const restarted=await child(t,f.root);f.closeBeforeCleanup(()=>restarted.kill());restarted.root=f.root;await restarted.pair(cookie);restarted.command=(patch={},body={})=>command(EMPTY_EXPECTED_VERSIONS,{clientId:restarted.paired.json.clientId,...patch},body);return withLeases(restarted);
}
async function nativeLayout(request,fonts){
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('../../dist/local/server/text/render-worker.mjs',import.meta.url),{workerData:{request,fonts},env:{},resourceLimits:{maxOldGenerationSizeMb:32,maxYoungGenerationSizeMb:8}});
    let result,error;const timer=setTimeout(()=>{error=Error('Native fixture render deadline');void worker.terminate();},20000);
    worker.on('message',message=>{if(message.type==='ready')worker.postMessage({type:'admit'});else if(message.type==='result')result=message;else error=Error(JSON.stringify(message));});
    worker.on('error',value=>{error=value;});worker.on('exit',code=>{clearTimeout(timer);if(error)reject(error);else if(code||!result)reject(Error('Native fixture did not exit with a result'));else resolve(result);});
  });
}
async function addNativeText(f){
  const profileBytes=await readFile('src/text/profile.json'),profile=JSON.parse(profileBytes),fontProfile=profile.fonts.find(font=>font.id==='NotoSans');
  const source=await stage(f,await readFile('vendor/text/'+fontProfile.file),'font','application/octet-stream'),license=await stage(f,await readFile('vendor/text/'+fontProfile.licenseFile));
  const font=(await edit(f,{type:'ImportFont',source:source.blob,license:license.blob,origin:'bundled',embeddingReviewed:true})).event.payload.asset.font;
  const document=await doc(f),frame={width:240,height:90},style={primaryFont:font.bytes.hash,explicitFallbacks:[],sizePx:24,lineHeightMultiplier:1.2,fill:[40,90,190,0],align:'start',direction:'auto'};
  // Alpha zero gives independently known RGBA while the real native worker
  // produces nonempty glyph/layout data. This tests ownership, not glyph pixels.
  const token={documentId:document.id,documentRevision:document.revision,layerId:'native_text',layerVersion:'0',sessionId:'candidate_copy',generation:1};
  const rendered=await nativeLayout({text:NATIVE_TEXT,style,frame,token},[{path:objectPath(f.root,font.bytes),length:Number(font.bytes.byteLength),hash:font.bytes.hash,origin:font.origin,licenseHash:font.licenseRecord.hash}]);
  const put=async bytes=>(await stage(f,bytes,'text','application/octet-stream')).blob;
  const textUtf8=(await stage(f,Buffer.from(NATIVE_TEXT))).blob,layout={...await put(Buffer.from(rendered.layout)),mediaType:'application/json'},pixels={...await put(Buffer.alloc(frame.width*frame.height*4)),mediaType:'application/x-ideogram-rgba8'};
  assert.equal(rendered.rasterHash,pixels.hash);assert.equal(rendered.layoutHash,layout.hash);assert.equal(rendered.textHash,textUtf8.hash);
  const manifest={...await put(profileBytes),mediaType:'application/json'},text=identify({schemaVersion:1,textUtf8,style,frame,layoutPolicy:'text-layout-1',fonts:[font]});
  const dependencyHash=sha(JSON.stringify({rendererProfile:profile.id,textHash:textUtf8.hash,style,frame,fonts:[{hash:font.bytes.hash,licenseHash:font.licenseRecord.hash,faceIndex:0,format:font.format,parserProfile:font.parserProfile,fsType:font.fsType}]}));
  const render=identify({schemaVersion:1,textVersion:text.id,rendererProfile:{schemaVersion:1,id:profile.id,manifest},dependencyHash,layout,pixels,width:rendered.width,height:rendered.height,overflow:rendered.overflow,resolvedFonts:[font.id]});
  const candidate={...await put(Buffer.from(canonical({schemaVersion:1,token,source:{schemaVersion:1,text,render}}))),mediaType:'application/json'};
  const draft=await stage(f,Buffer.from(canonical({schemaVersion:1,kind:'text-draft-1',textUtf8,style,frame,fonts:[font]})));
  await ui(f,{type:'SaveDraft',draft:{id:'native',generation:'1',kind:'text',documentId:document.id,targetLayerId:null,expectedDocumentRevision:document.revision,assetId:draft.id,composing:false}});
  const budget=verificationBudget(NATIVE_TEXT,frame.width,frame.height,Number(font.bytes.byteLength),profile.engine.wasm.bytes),admissionId=randomUUID()+'_1_'+budget.bytes;
  assert.equal((await f.post('/api/v1/text-admission/'+admissionId,{protocolVersion:1})).status,200);
  const request=f.command({sessionId:'candidate_copy',expectedDocumentRevision:document.revision,body:{type:'CreateTextLayer',layerId:'native_text',name:'Native dependency closure',candidate,draft:{sessionId:'candidate_copy',draftId:'native',generation:'1'},admissionId}});
  const applied=await terminal(f,request);assert.equal(applied.json.receipt.status,'accepted',applied.text);
  assert.equal((await f.post('/api/v1/text-admission/'+admissionId+'/release',{protocolVersion:1})).status,200);
  const layer=(await imageState(f)).layers.find(layer=>layer.kind==='text'),saved=await jsonObject(f,layer.source);
  assert.equal((await retained(f,saved.text.textUtf8)).toString(),NATIVE_TEXT);assert(JSON.parse(rendered.layout).paragraphs.some(paragraph=>paragraph.runs.length>0));
  return [layer.source,saved.text.textUtf8,saved.render.layout,saved.render.pixels,saved.render.rendererProfile.manifest,...saved.text.fonts.flatMap(font=>[font.bytes,font.licenseRecord])];
}
async function capturedContributions(f,capture){
  const manifest=await jsonObject(f,capture.raster.manifest);assert(manifest.plan.contributions,'Fresh source captures must retain their contribution stack');
  const stack=await jsonObject(f,manifest.plan.contributions);assert.equal(stack.kind,'cp1-contribution-stack-v1');assert.equal(stack.pipeline,manifest.pipeline);assert.deepEqual([stack.width,stack.height],[manifest.width,manifest.height]);assert.equal(stack.contributions.length,manifest.plan.layers.length);
  const refs=[manifest.plan.contributions];
  for(const [index,entry] of stack.contributions.entries()){
    const contribution=await jsonObject(f,entry.manifest),pixels=await retained(f,entry.pixels);refs.push(entry.manifest,entry.pixels);
    assert.equal(contribution.plan.kind,'cp1-layer-contribution-v1');assert.deepEqual(contribution.plan.layer,manifest.plan.layers[index]);assert.deepEqual(contribution.pixels,entry.pixels);assert.deepEqual([contribution.width,contribution.height],[stack.width,stack.height]);assert.equal(contribution.pipeline,stack.pipeline);
    assert.equal(entry.pixelIdentity,sha(canonical({pipeline:contribution.pipeline,width:contribution.width,height:contribution.height,tiles:contribution.tiles})));
    for(const tile of contribution.tiles){const rows=[];for(let y=tile.y;y<tile.y+tile.height;y++)rows.push(pixels.subarray((y*stack.width+tile.x)*4,(y*stack.width+tile.x+tile.width)*4));assert.equal(sha(Buffer.concat(rows)),tile.hash);}
    if(manifest.plan.capture.layerIds[index]==='native_text'){assert.equal(pixels.length,512*512*4);assert(pixels.every(byte=>byte===0),'Transparent native text still owns a complete document-grid contribution');}
  }
  return refs;
}
async function importedAssetRefs(f,id){
  const queue=[id],seen=new Set(),refs=[];let retainedVersions=0;
  while(queue.length){
    const id=queue.pop();if(seen.has(id))continue;seen.add(id);assert(seen.size<=512);
    const response=await f.read('/api/v1/assets/'+id);assert.equal(response.status,200,response.text);const asset=response.json.projection.value;
    refs.push(asset.blob,...asset.dependencies);if(!asset.raster)continue;
    refs.push(asset.raster.manifest,asset.raster.pixels);queue.push(...asset.raster.sourceAssetIds);
    const current=await jsonObject(f,asset.raster.manifest);if(current.plan.kind==='request-source-capture-v1')refs.push(...await capturedContributions(f,asset));
    const versions=new Set();let ref=asset.retainedMetadata;
    while(ref){
      assert(!versions.has(ref.hash));versions.add(ref.hash);assert(versions.size<=16);retainedVersions++;
      const value=await jsonObject(f,ref);assert.equal(value.kind,'retained-raster-metadata-1');refs.push(ref,value.manifest);
      const original=await jsonObject(f,value.manifest);assert.deepEqual(original.pixels,asset.raster.pixels);assert.deepEqual([original.width,original.height],[asset.raster.width,asset.raster.height]);
      assert.equal(sha(canonical({pipeline:original.pipeline,width:original.width,height:original.height,tiles:original.tiles})),asset.raster.pixelIdentity);
      ref=value.previous;
    }
  }
  assert(retainedVersions>0,'Imported source must exercise retained original raster metadata');return refs;
}
async function requestCandidate(f,documentId='document_1',layerIds=['picture','native_text']){
  const commitComposition=async(value,type)=>{const staged=await stage(f,Buffer.from(canonical(value)),'text','application/octet-stream'),composition={id:value.id,value:{...staged.blob,mediaType:'application/json'},bindings:{}};await edit(f,{type,composition,draft:null},documentId);return composition;};
  const earlier=emptyComposition(512,512,randomUUID());earlier.scene='C1 captured composition '+documentId;earlier.raw=[(await stage(f,Buffer.from('C1 original raw semantic bytes '+documentId),'text','application/octet-stream')).blob];
  const capturedComposition=await commitComposition(earlier,'CommitCompositionVersion');
  const capture=(await edit(f,{type:'PrepareRequestSource',scope:'selected-layers',layerIds},documentId)).event.payload.asset;
  const source={assetId:capture.id,version:capture.version,blob:capture.blob,pixels:capture.raster.pixels,width:512,height:512,scope:'selected-layers',documentRevision:(await doc(f,documentId)).revision,capture:capture.raster.manifest};
  const mask=(await operate(f,{type:'PrepareRequestMask',sourceAssetId:source.assetId,plan:{width:512,height:512,feather:3,operations:[{kind:'shape',shape:{kind:'rectangle',x:4,y:4,width:12,height:12},mode:'replace'}]},clip:null})).event.payload.asset;
  // C2 is approved after the C1 capture. Its opaque raw input is reachable only
  // through the request's Composition graph once origin document A is deleted.
  const compositionValue=emptyComposition(512,512,randomUUID());compositionValue.scene=REQUESTED_PROMPT+'Origin '+documentId;compositionValue.request.operation='Edit masked region';
  const lettering=emptyElement('text','c2_lettering');lettering.text.value='C2 exact lettering: Café / 東京';lettering.desc.value='C2 description absent from the older source capture';compositionValue.elements=[lettering];
  compositionValue.raw=[(await stage(f,Buffer.from('{"C2":"opaque original '+documentId+'","C2":"東京 / e\u0301"}\n\u0000'),'text','application/octet-stream')).blob];
  const projected=serialize(compositionValue,[],{}),prompt=await stage(f,Buffer.from(projected.prompt));
  compositionValue.review={serializer:'caption-json-1',sourceId:compositionValue.id,frame:compositionValue.frame,request:compositionValue.request,dependencies:projected.dependencies,boxes:projected.boxes,prompt:prompt.blob};
  const composition=await commitComposition(compositionValue,'ApprovePromptProjection'),manifest=(await f.read('/api/v1/assets/'+mask.id+'/raster')).json,draft=newDraft(prompt.blob);
  const bound={assetId:mask.id,version:mask.version,blob:mask.blob,pixels:mask.raster.pixels,width:512,height:512,sourceHash:source.pixels.hash,polarity:'white-edit',fullAcknowledged:false,empty:false,full:false,plan:mask.raster.manifest,binding:bindRequestMask(source)};
  bound.requestPlan=confirmRequestMask(source,bound,manifest.plan.hard,manifest.plan.effective,randomUUID());draft.operation='inpaint';Object.assign(draft.fields,{width:'512',height:'512',size:'auto',strength:'1'});draft.source=source;draft.mask=bound;
  draft.prompt={mode:'composition',text:prompt.blob,projection:compositionValue.review,composition};draft.fields.expansion=compositionValue.request.expansion;draft.rewriteAcknowledged=compositionValue.request.rewriteAcknowledged;
  const saved=await stage(f,Buffer.from(JSON.stringify(draft)));
  const draftId='request_'+documentId;await ui(f,{type:'SaveDraft',draft:{id:draftId,generation:'1',kind:'request',documentId,targetLayerId:null,expectedDocumentRevision:(await doc(f,documentId)).revision,assetId:saved.id,composing:false}});
  const review=(await ui(f,{type:'PrepareRequestReview',draftId,generation:'1'})).value.review,acceptance=await ui(f,{type:'AcceptRequestReview',reviewId:review.id,token:review.token});
  const queued=await operate(f,{type:'QueueInference',reviewId:review.id,token:review.token,acceptanceId:acceptance.request.requestId}),jobId=queued.event.payload.id;
  let view;const deadline=Date.now()+20000;
  do{view=(await f.read('/api/v1/jobs/'+jobId+'/candidates')).json;if(view.items[0]?.state==='prepared')break;await new Promise(resolve=>setTimeout(resolve,25));}while(Date.now()<deadline);
  assert.equal(view.items[0]?.state,'prepared',JSON.stringify(view));assert.equal(view.provenance.inspection,'opaque');assert.notEqual(view.provenance.requestedPrompt.hash,view.provenance.returnedPrompt.hash);
  const outputs=await Promise.all([view.items[0].encodedAssetId,view.items[0].preparedAssetId].map(async id=>(await f.read('/api/v1/assets/'+id)).json.projection.value));
  return {candidate:view.items[0],view,refs:[source.capture,source.blob,source.pixels,...await capturedContributions(f,capture),mask.blob,mask.raster.manifest,bound.requestPlan.authoredMask,bound.requestPlan.effectiveMask,capturedComposition.value,...compositionRefs(earlier),composition.value,...compositionRefs(compositionValue),...outputs.flatMap(asset=>[asset.blob,...asset.raster?[asset.raster.pixels,asset.raster.manifest]:[]]),...['requestedPrompt','submittedPrompt','returnedPrompt'].map(key=>view.provenance[key])],source,prompt:projected.prompt,composition,capturedComposition};
}
async function adopt(f,candidate,id,sourceDocumentId='document_1'){
  const prepared=await edit(f,{type:'PrepareCandidateAdoption',candidateId:candidate.id,mode:'safe-region',placement:'new-document',newDocumentId:id,actualOutput:null,newLayerId:'adopted',name:'Independent candidate'},sourceDocumentId),p=(await receiptEvent(f,prepared.receipt,'ImageEditPreviewPrepared')).payload.preview;
  const reviewed=await edit(f,{type:'ReviewImageEdit',previewId:p.previewId},sourceDocumentId),reviewEvent=await receiptEvent(f,reviewed.receipt,'ImageEditReviewPrepared'),review=(await f.read('/api/v1/image-edit-reviews/'+reviewEvent.payload.reviewId)).json;
  const result=await terminal(f,f.command({documentId:id,expectedDocumentRevision:null,body:{type:'AdoptCandidate',previewId:p.previewId,reviewId:review.reviewId,reviewHash:review.reviewHash,draft:null}}));assert.equal(result.json.receipt.status,'accepted',result.text);
  return doc(f,id);
}
async function receiptEvent(f,receipt,type){
  const response=await f.read('/api/v1/events?after='+String(BigInt(receipt.fromSeq)-1n));assert.equal(response.status,200,response.text);
  const batch=response.json.batches[0];assert.equal(batch.transactionId,receipt.transactionId);assert.equal(batch.fromSeq,receipt.fromSeq);assert.equal(batch.toSeq,receipt.toSeq);
  let events=batch.events;
  if(batch.kind!=='inline'){const content=await f.read(batch.content.url);assert.equal(content.status,200,content.text);assert.equal(sha(content.text),batch.content.blob.hash);events=content.text.trimEnd().split('\n').map(line=>JSON.parse(line));}
  const matches=events.filter(event=>event.type===type);assert.equal(matches.length,1,'Receipt must contain exactly one '+type);return matches[0];
}
async function closure(f,id){
  const hashes=new Set();let after='';do{const page=(await f.read('/api/v1/documents/'+id+'/closure?after='+encodeURIComponent(after))).json;for(const ref of page.items)hashes.add(ref.hash);after=page.next;}while(after);return hashes;
}
async function lineage(f,id){
  const history=(await f.read('/api/v1/documents/'+id+'/history')).json.items,values=[];
  for(const node of history)for(const ref of node.roots){const value=await jsonObject(f,ref).catch(()=>null);if(value?.kind==='adopted-candidate-lineage-1')values.push(value);}
  assert.equal(values.length,1,'Independent root must own one durable candidate lineage');assert.equal(values[0].inert,true);assert.equal(values[0].result.inert,true);return values[0];
}
function verifyLineages(values,originals){
  assert.deepEqual([...new Set(values.map(value=>value.candidate.id))].sort(),originals.map(value=>value.candidate.id).sort(),'Every ancestor must remain reachable');
  for(const value of values){const original=originals.find(item=>item.candidate.id===value.candidate.id);assert.equal(value.inert,true);assert.equal(value.result.inert,true);assert.deepEqual(value.candidate,original.candidate);assert.deepEqual(value.result,original.result);}
}
async function verifyAncestry(f,id,originals){
  const values=[];let after='';do{const page=(await f.read('/api/v1/documents/'+id+'/closure?after='+encodeURIComponent(after))).json;
    for(const ref of page.items)if(ref.mediaType==='application/json'&&BigInt(ref.byteLength)<=65536n){const value=await jsonObject(f,ref).catch(()=>null);if(value?.kind==='adopted-candidate-lineage-1')values.push(value);}
    after=page.next;
  }while(after);verifyLineages(values,originals);
}
async function rawEvidence(f,attemptId){
  const values=[];for(const name of await readdir(join(f.root,'backend-transport'))){if(!name.endsWith('.json'))continue;const path=join(f.root,'backend-transport',name),bytes=await readFile(path),metadata=JSON.parse(bytes);if(metadata.attemptId!==attemptId)continue;const body=await readFile(path.replace(/\.json$/,'.body'));assert.equal(sha(body),'sha256:'+metadata.sha256);values.push({path,bytes,body,metadata});}
  assert(values.length>0);assert(values.some(value=>value.metadata.direction==='request'));assert(values.some(value=>value.body.includes(Buffer.from('fixture-transfer-secret'))));return values;
}
async function verifyRetained(f,id,expected){const hashes=await closure(f,id);for(const [ref,bytes] of expected){assert(hashes.has(ref.hash),'Document '+id+' lost '+ref.hash);assert.deepEqual(await retained(f,ref),bytes);}}
async function deleteDocument(f,id){
  const revision=(await doc(f,id)).revision;await f.releaseLeases();await workspace(f,{type:'PreviewDocumentDeletion',documentId:id,expectedRevision:revision});
  const plan=(await f.read('/api/v1/documents/'+id+'/deletion')).json.plan;
  await workspace(f,{type:'DeleteDocument',documentId:id,planId:plan.id,planHash:plan.planHash,rootGeneration:plan.rootGeneration,expectedRevision:plan.documentRevision,acknowledgeRunningAndUncertain:false});
  await workspace(f,{type:'CollectDocumentGarbage',documentId:id});assert.equal((await f.read('/api/v1/documents/'+id)).status,404);assert.equal((await f.read('/api/v1/documents/'+id+'/deletion')).json.receipt.status,'cleanup-complete');
}
async function verifyArchive(f,bytes,expected,raw,originals){
  const entries=await unpack(f.root,bytes);for(const [ref,value] of expected){
    const path='objects/'+ref.hash.slice(7);let metadata;try{metadata=JSON.parse(value);}catch{}
    assert(entries.has(path),'Portable copy lost '+ref.hash+' '+JSON.stringify({bytes:ref.byteLength,kind:metadata?.kind,format:metadata?.format,plan:metadata?.plan?.kind,role:metadata?.role,width:metadata?.width,height:metadata?.height}));
    assert.deepEqual(entries.get(path),value,'Portable copy changed '+ref.hash);
  }
  const entities=records(entries).values.filter(record=>record.kind==='entity'),lineages=[];
  for(const [path,value] of entries)if(path.startsWith('objects/')){let parsed;try{parsed=JSON.parse(value);}catch{continue;}if(parsed?.kind==='adopted-candidate-lineage-1')lineages.push(parsed);}
  verifyLineages(lineages,originals);
  const domainBytes=new Map(expected.map(([ref,value])=>[ref.hash.slice(7),value]));
  for(const rawRecord of raw){
    // The evidence store also holds derived prompt streams, and image uploads
    // and downloads can equal an independently owned source/candidate PNG.
    // Exact typed domain ownership, proved above, authorizes those bytes; the
    // protected transport record itself never becomes portable authority.
    const image=rawRecord.body.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    if(domainBytes.has(rawRecord.metadata.sha256)){
      assert.deepEqual(rawRecord.body,domainBytes.get(rawRecord.metadata.sha256));
    }else{
      assert.equal(entries.has('objects/'+rawRecord.metadata.sha256),false,'Protected HTTP body must not become a portable object: '+JSON.stringify({direction:rawRecord.metadata.direction,headers:rawRecord.metadata.headers,bytes:rawRecord.body.length,hash:rawRecord.metadata.sha256,png:image}));
      if(rawRecord.body.length)assert.equal(bytes.includes(rawRecord.body),false,'Raw transport body must not be embedded');
    }
    assert.equal(entries.has('backend-transport/'+rawRecord.metadata.recordId+'.json'),false);
    assert.equal(entries.has('backend-transport/'+rawRecord.metadata.recordId+'.body'),false);
  }
  for(const value of entries.values())assert.equal(value.includes(Buffer.from('fixture-transfer-secret')),false,'Provider transfer secret must stay in backend evidence');
  for(const record of entities.filter(record=>record.entityType==='job-result'))assert.equal(JSON.parse(entries.get('objects/'+record.payloadRef.hash.slice(7))).inert,true);
  assert(!entities.some(record=>/outbox|transport/i.test(record.entityType)));return lineages;
}

test('chained safe adoptions and an imported continuation retain native sources and provenances through deletion, restart and repeated portable copy',async t=>{
  const f=await fixture(t);assert.equal((await terminal(f,f.command({}, {width:512,height:512}))).json.receipt.status,'accepted');
  const imported=await importRaster(f,'hidden-alpha.png');await edit(f,{type:'ImportAsset',assetId:imported.asset.id,layerId:'picture',name:'Visible source',draft:null});
  const textRefs=await addNativeText(f),request=await requestCandidate(f),intermediate='independent_candidate';await adopt(f,request.candidate,intermediate);
  const capture=await jsonObject(f,request.source.capture),captured=await jsonObject(f,capture.plan.capture.image.state);assert.equal(captured.layers.find(layer=>layer.id==='native_text').kind,'text');assert.deepEqual(captured.composition,request.capturedComposition);assert.notEqual(captured.composition.value.hash,request.composition.value.hash);
  const original=await lineage(f,intermediate);assert.equal(original.result.documentId,'document_1');assert.equal(original.candidate.id,request.candidate.id);assert.deepEqual(original.result.request.specification.settings.prompt.composition,request.composition);
  const adoptedLayer=(await imageState(f,intermediate)).layers[0],wrapper=(await f.read('/api/v1/assets/'+adoptedLayer.assetId+'/raster')).json;assert.equal(wrapper.plan.kind,'retained-candidate-v1');assert.deepEqual(await jsonObject(f,wrapper.plan.lineage),original);
  // The second request captures B's adopted layer. C must own the original A
  // provenance through that raster even after both A and B are collected.
  const descendant=await requestCandidate(f,intermediate,[adoptedLayer.id]),target='descendant_candidate',created=await adopt(f,descendant.candidate,target,intermediate);
  const descendantCapture=await jsonObject(f,descendant.source.capture),descendantState=await jsonObject(f,descendantCapture.plan.capture.image.state);assert.equal(descendantState.layers[0].assetId,adoptedLayer.assetId);assert.deepEqual(descendantState.composition,descendant.capturedComposition);
  const descendantLineage=await lineage(f,target),originals=[original,descendantLineage];assert.equal(descendantLineage.result.documentId,intermediate);assert.equal(descendantLineage.candidate.id,descendant.candidate.id);assert.deepEqual(descendantLineage.result.request.specification.settings.prompt.composition,descendant.composition);
  const refs=[...textRefs,...request.refs,...descendant.refs,imported.input.blob,imported.asset.blob,imported.asset.raster.pixels,imported.asset.raster.manifest,capture.plan.capture.image.state,descendantCapture.plan.capture.image.state],unique=[...new Map(refs.map(ref=>[ref.hash,ref])).values()],expected=await Promise.all(unique.map(async ref=>[ref,await retained(f,ref)]));
  for(const item of [request,descendant]){assert.equal((await retained(f,item.view.provenance.requestedPrompt)).toString(),item.prompt);assert.equal((await retained(f,item.view.provenance.submittedPrompt)).toString(),item.prompt);assert.equal((await retained(f,item.view.provenance.returnedPrompt)).toString(),returnedPrompt(item.prompt));}
  assert.notEqual(request.view.provenance.requestedPrompt.hash,descendant.view.provenance.requestedPrompt.hash);assert.notEqual(request.view.provenance.returnedPrompt.hash,descendant.view.provenance.returnedPrompt.hash);
  const raw=[...await rawEvidence(f,request.candidate.attemptId),...await rawEvidence(f,descendant.candidate.attemptId)],output=(await f.read('/api/v1/assets/'+created.image.compositeAssetId)).json.projection.value.raster.pixels,outputBytes=await retained(f,output);
  await verifyRetained(f,target,expected);await verifyAncestry(f,target,originals);
  for(const id of ['document_1',intermediate]){await deleteDocument(f,id);await verifyRetained(f,target,expected);await verifyAncestry(f,target,originals);}
  for(const entry of raw){assert.deepEqual(await readFile(entry.path),entry.bytes);assert.deepEqual(await readFile(entry.path.replace(/\.json$/,'.body')),entry.body);}
  assert.deepEqual(await retained(f,output),outputBytes);await f.releaseLeases();const cookie=cookieFrom(f.paired);await f.server.close();
  const effects=JSON.parse(await readFile(join(f.root,'candidate-copy-effects.json')));assert.deepEqual(effects.errors,[]);assert.equal(effects.effects.filter(effect=>effect.method==='POST'&&effect.path==='/ideogram/v4/inpaint').length,2);
  // The fresh writer runs the protocol fixture's network counters: any provider
  // access, including recovery reads, makes effects() fail.
  const restarted=await guardedRestart(t,f,cookie);
  await verifyRetained(restarted,target,expected);assert.deepEqual(await lineage(restarted,target),descendantLineage);await verifyAncestry(restarted,target,originals);await restarted.effects();
  const archive=await copy(restarted,target);await verifyArchive(restarted,archive.bytes,expected,raw,originals);await restarted.effects();
  const reviewed=(await preview(restarted,archive.bytes)).review;assert.equal(reviewed.editable,true,JSON.stringify(reviewed));await importBundle(restarted,reviewed);
  await verifyRetained(restarted,reviewed.documentId,expected);const restored=await lineage(restarted,reviewed.documentId);assert.deepEqual(restored.candidate,descendantLineage.candidate);assert.deepEqual(restored.result,descendantLineage.result);await verifyAncestry(restarted,reviewed.documentId,originals);
  const queueBefore=(await restarted.read('/api/v1/queue')).json;assert(!queueBefore.jobs.some(job=>job.documentId===reviewed.documentId));assert.deepEqual((await restarted.read('/api/v1/documents/'+reviewed.documentId+'/candidates')).json.items,[]);
  const state=await imageState(restarted,reviewed.documentId),layer=state.layers[0],db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});
  try{assert.equal(db.prepare('SELECT count(*) n FROM candidate_adoption_evidence WHERE document_id=?').get(reviewed.documentId).n,0);assert.equal(db.prepare('SELECT count(*) n FROM candidate_asset_evidence WHERE asset_id=?').get(layer.assetId).n,0);}finally{db.close();}
  const changed=await edit(restarted,{type:'SetLayerProperties',layerId:layer.id,layerVersion:layer.version,properties:{opacity:0.5},draft:null},reviewed.documentId);
  await edit(restarted,{type:'Undo',historyHead:changed.document.historyHead},reviewed.documentId);await edit(restarted,{type:'Redo',historyNode:changed.document.historyHead},reviewed.documentId);await edit(restarted,{type:'Undo',historyHead:changed.document.historyHead},reviewed.documentId);
  assert.deepEqual(await imageState(restarted,reviewed.documentId),state);assert.deepEqual((await restarted.read('/api/v1/queue')).json,queueBefore);await restarted.effects();
  const recopied=await copy(restarted,reviewed.documentId);await verifyArchive(restarted,recopied.bytes,expected,raw,originals);await restarted.effects();
  for(const entry of raw){assert.deepEqual(await readFile(entry.path),entry.bytes);assert.deepEqual(await readFile(entry.path.replace(/\.json$/,'.body')),entry.body);}
  assert.deepEqual(JSON.parse(await readFile(join(f.root,'candidate-copy-effects.json'))),effects);

  // C must no longer own any original bytes when the imported C′ becomes a
  // new request source. Snapshot the imported metadata before authoring D.
  const importedRefs=await importedAssetRefs(restarted,layer.assetId),importedExpected=await Promise.all(importedRefs.map(async ref=>[ref,await retained(restarted,ref)]));
  await deleteDocument(restarted,target);await verifyRetained(restarted,reviewed.documentId,expected);await restarted.effects();await restarted.releaseLeases();await restarted.kill();

  // Only this explicit authoring phase has a provider. The new fixture starts
  // with empty counters, so exactly one request must account for every effect.
  const continued=await providerRestart(f),continuedRequest=await requestCandidate(continued,reviewed.documentId,[layer.id]),continuedTarget='continued_imported_candidate';
  await adopt(continued,continuedRequest.candidate,continuedTarget,reviewed.documentId);
  const continuedLineage=await lineage(continued,continuedTarget),continuedOriginals=[...originals,continuedLineage];assert.equal(continuedLineage.result.documentId,reviewed.documentId);assert.equal(continuedLineage.candidate.id,continuedRequest.candidate.id);assert.deepEqual(continuedLineage.result.request.specification.settings.prompt.composition,continuedRequest.composition);
  const continuedCapture=await jsonObject(continued,continuedRequest.source.capture),continuedState=await jsonObject(continued,continuedCapture.plan.capture.image.state);assert.equal(continuedState.layers[0].assetId,layer.assetId);assert.deepEqual(continuedState.composition,continuedRequest.capturedComposition);
  const continuedRefs=[...continuedRequest.refs,continuedCapture.plan.capture.image.state],continuedExpected=[...new Map([...expected,...importedExpected,...await Promise.all(continuedRefs.map(async ref=>[ref,await retained(continued,ref)]))].map(entry=>[entry[0].hash,entry])).values()];
  const continuedRaw=await rawEvidence(continued,continuedRequest.candidate.attemptId),allRaw=[...raw,...continuedRaw];
  for(const key of ['requestedPrompt','submittedPrompt'])assert.equal((await retained(continued,continuedRequest.view.provenance[key])).toString(),continuedRequest.prompt);
  assert.equal((await retained(continued,continuedRequest.view.provenance.returnedPrompt)).toString(),returnedPrompt(continuedRequest.prompt));
  const evidence=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});
  try{assert.deepEqual(evidence.prepare('SELECT attempt_id FROM candidate_adoption_evidence WHERE document_id=? ORDER BY attempt_id').all(continuedTarget).map(row=>row.attempt_id),[continuedRequest.candidate.attemptId],'Imported ancestry must not acquire old backend evidence authority');}finally{evidence.close();}
  await verifyRetained(continued,continuedTarget,continuedExpected);await verifyAncestry(continued,continuedTarget,continuedOriginals);await continued.releaseLeases();const continuedCookie=cookieFrom(continued.paired);await continued.server.close();
  const continuedEffects=JSON.parse(await readFile(join(f.root,'candidate-copy-effects.json')));assert.deepEqual(continuedEffects.errors,[]);assert.equal(continuedEffects.effects.filter(effect=>effect.method==='POST'&&effect.path==='/ideogram/v4/inpaint').length,1);

  // Restart without a provider before deleting C′. D alone must root both
  // original namespaces' metadata plus the new local request and candidate.
  const isolated=await guardedRestart(t,f,continuedCookie);await deleteDocument(isolated,reviewed.documentId);await verifyRetained(isolated,continuedTarget,continuedExpected);await verifyAncestry(isolated,continuedTarget,continuedOriginals);assert.deepEqual(await lineage(isolated,continuedTarget),continuedLineage);await isolated.effects();
  for(const entry of continuedRaw){assert.deepEqual(await readFile(entry.path),entry.bytes);assert.deepEqual(await readFile(entry.path.replace(/\.json$/,'.body')),entry.body);}
  const continuedArchive=await copy(isolated,continuedTarget);await verifyArchive(isolated,continuedArchive.bytes,continuedExpected,allRaw,continuedOriginals);await isolated.effects();
  const finalReview=(await preview(isolated,continuedArchive.bytes)).review;assert.equal(finalReview.editable,true,JSON.stringify(finalReview));await importBundle(isolated,finalReview);
  await verifyRetained(isolated,finalReview.documentId,continuedExpected);await verifyAncestry(isolated,finalReview.documentId,continuedOriginals);const finalLineage=await lineage(isolated,finalReview.documentId);assert.deepEqual(finalLineage.candidate,continuedLineage.candidate);assert.deepEqual(finalLineage.result,continuedLineage.result);
  const finalQueue=(await isolated.read('/api/v1/queue')).json;assert(!finalQueue.jobs.some(job=>job.documentId===finalReview.documentId));assert.deepEqual((await isolated.read('/api/v1/documents/'+finalReview.documentId+'/candidates')).json.items,[]);
  const finalLayer=(await imageState(isolated,finalReview.documentId)).layers[0],finalEvidence=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});
  try{assert.equal(finalEvidence.prepare('SELECT count(*) n FROM candidate_adoption_evidence WHERE document_id=?').get(finalReview.documentId).n,0);assert.equal(finalEvidence.prepare('SELECT count(*) n FROM candidate_asset_evidence WHERE asset_id=?').get(finalLayer.assetId).n,0);}finally{finalEvidence.close();}
  const finalCopy=await copy(isolated,finalReview.documentId);await verifyArchive(isolated,finalCopy.bytes,continuedExpected,allRaw,continuedOriginals);assert.deepEqual((await isolated.read('/api/v1/queue')).json,finalQueue);await isolated.effects();
  for(const entry of continuedRaw){assert.deepEqual(await readFile(entry.path),entry.bytes);assert.deepEqual(await readFile(entry.path.replace(/\.json$/,'.body')),entry.body);}
  assert.deepEqual(JSON.parse(await readFile(join(f.root,'candidate-copy-effects.json'))),continuedEffects);
});
