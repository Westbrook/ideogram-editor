import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {compileLegacy} from '../../tooling/qualification/legacy-compiler.mjs';
import {tableRows} from '../store/sqlite-snapshot.mjs';
import {terminalWithDiagnostics} from './native-failure-diagnostics.mjs';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
import {rootFor,command,pair,call,cookieFrom,readHeaders,mutationHeaders} from '../protocol/helpers.mjs';
import {terminal,importRaster} from '../raster/helpers.mjs';
import {upload,copy,preview} from '../portable/helpers.mjs';
import {unpack} from '../portable/archive-fixture.mjs';
import {providerChild} from './candidate-copy-process-helpers.mjs';
import {EMPTY_EXPECTED_VERSIONS} from '../../dist/local/src/protocol/store.js';
import {newDraft} from '../../dist/local/src/request/core.js';
import {canonical} from '../../dist/local/server/storage/canonical.js';
import {verificationBudget} from '../../dist/local/src/protocol/text-budget.js';
import {inspectReturnedDescription,makeReturnedDescriptionReview} from '../../dist/local/src/text/returned-description.js';
import {validateReturnedTextObservation} from '../../dist/local/server/portable/returned-description.js';
import {planTextSplit} from '../../dist/local/src/text/split.js';
import {emptyComposition,emptyElement,linkField,fieldStatus,serialize} from '../../dist/local/src/composition/core.js';

// Real writer, durable objects, native layout/render verifier, observer and
// portable import. Only the existing literal-loopback provider is a substitute.
const documentId='document_1',sessionId='returned_description_j19';
const returnedLiteral='Returned Cafe\u0301 東京 <b>literal</b>';
const returnedCaption=JSON.stringify({high_level_description:'A poster with a title',compositional_deconstruction:{background:'plain',elements:[{type:'obj',desc:'A poster'},{type:'text',bbox:[100,200,350,850],text:returnedLiteral,desc:'Blue title lettering'}]}});
const sha=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const identify=value=>({...value,id:sha(canonical(value))});
const document=async(f,id=documentId)=>(await f.read('/api/v1/documents/'+id)).json.projection.value;
const image=async(f,id=documentId)=>(await f.read('/api/v1/documents/'+id+'/image')).json;
const objectPath=(f,ref)=>join(f.root,'objects','sha256',ref.hash.slice(7,9),ref.hash.slice(7));
async function retained(f,ref){const bytes=await readFile(objectPath(f,ref));assert.equal(sha(bytes),ref.hash);assert.equal(String(bytes.length),ref.byteLength);return bytes;}
async function object(f,ref){return JSON.parse(await retained(f,ref));}
async function asset(f,id){const response=await f.read('/api/v1/assets/'+id);assert.equal(response.status,200,response.text);return response.json.projection.value;}
async function events(f,receipt){
 const response=await f.read('/api/v1/events?after='+String(BigInt(receipt.fromSeq)-1n)),recoveryId=response.json?.recovery?.recoveryId;let failure;
 try{
  assert.equal(response.status,200,response.text);assert.equal(typeof recoveryId,'string');const batch=response.json.batches[0];
  if(batch.kind==='inline')return batch.events;const content=await f.read(batch.content.url);assert.equal(content.status,200,content.text);assert.equal(sha(content.text),batch.content.blob.hash);return content.text.split('\n').filter(Boolean).map(JSON.parse);
 }catch(error){failure={error};throw error;}finally{
  // A page owns a recovery lease even when its complete transaction is inline.
  if(typeof recoveryId==='string')try{const released=await f.post('/api/v1/recovery/'+recoveryId+'/release',{protocolVersion:1});assert.equal(released.status,204,released.text);}catch(error){if(failure)throw new AggregateError([failure.error,error],'Event read and recovery release failed');throw error;}
 }
}
async function eventFor(f,receipt){return (await events(f,receipt))[0];}
async function operate(f,body){
 const c=f.command({documentId:null,expectedDocumentRevision:null,body}),r=await terminal(f,c);assert.equal(r.json.receipt.status,'accepted',r.text);return {command:c,receipt:r.json.receipt,event:await eventFor(f,r.json.receipt)};
}
async function run(f,body,id=documentId){
 const before=await document(f,id),request=f.command({documentId:id,expectedDocumentRevision:before.revision,body}),result=await terminal(f,request);
 assert.equal(result.json.receipt.status,'accepted',result.text);return {request,receipt:result.json.receipt,events:await events(f,result.json.receipt),document:await document(f,id)};
}
async function stage(f,bytes,purpose='caption',mediaType='text/plain'){
 const staged=await upload(f,bytes,purpose,mediaType);return (await operate(f,{type:'FinalizeStaging',stagingId:staged.stagingId,expectedSha256:staged.sha256})).event.payload.asset;
}
async function ui(f,body){
 const current=(await f.read('/api/v1/ui/'+sessionId)).json,request={protocolVersion:1,requestId:randomUUID(),sessionId,expectedUISeq:current.uiSeq,body},response=await f.post('/api/v1/ui/'+sessionId,request);
 assert.equal(response.json.status,'accepted',response.text);return {request,value:response.json};
}
async function fixture(t){
 // Keep fixture rendering/oracle bytes outside backend RSS admission, and
 // close the owned writer/provider process before rootFor removes diagnostics.
 let close;t.after(()=>close?.());const root=await rootFor(t);
 const server=await providerChild(root,owned=>{close=owned;},new URL('./returned-description-process-fixture.mjs',import.meta.url));
 const paired=await pair(server);assert.equal(paired.status,200,paired.text);
 const f={root,server,paired,generation:0,
  read:path=>call(server.origin,path,{headers:readHeaders(cookieFrom(paired))}),
  post:(path,body)=>call(server.origin,path,{method:'POST',body,headers:mutationHeaders(server,paired)}),
  command:(patch={},body={})=>command(EMPTY_EXPECTED_VERSIONS,{clientId:paired.json.clientId,...patch},body),
  effects:async()=>{const value=JSON.parse(await readFile(join(root,'candidate-fixture.json'),'utf8'));assert.deepEqual(value.errors,[]);return value.effects;},
 };
 assert.equal((await terminal(f,f.command({}, {width:64,height:32}))).json.receipt.status,'accepted');return f;
}
async function observedCaption(f){
 const prompt=await stage(f,Buffer.from(returnedCaption)),draft=newDraft(prompt.blob);draft.prompt.mode='raw';draft.guidanceAcknowledged=true;Object.assign(draft.fields,{width:'512',height:'512',expansion:'None'});
 const saved=await stage(f,Buffer.from(canonical(draft)));await ui(f,{type:'SaveDraft',draft:{id:'caption-request',generation:'1',kind:'request',documentId,targetLayerId:null,expectedDocumentRevision:(await document(f)).revision,assetId:saved.id,composing:false}});
 const review=(await ui(f,{type:'PrepareRequestReview',draftId:'caption-request',generation:'1'})).value.review,accepted=await ui(f,{type:'AcceptRequestReview',reviewId:review.id,token:review.token});
 const queued=await operate(f,{type:'QueueInference',reviewId:review.id,token:review.token,acceptanceId:accepted.request.requestId}),jobId=queued.event.payload.id;
 let value;const deadline=Date.now()+20000;
 do{const response=await f.read('/api/v1/jobs/'+jobId+'/candidates');if(response.status===200)value=response.json;if(value?.items[0]?.state==='prepared'&&value.provenance?.inspection==='supported')break;await new Promise(resolve=>setTimeout(resolve,25));}while(Date.now()<deadline);
 assert.equal(value?.items[0]?.state,'prepared',JSON.stringify(value));assert.equal(value.provenance?.inspection,'supported');assert.equal(value.provenance.complete,true);
 const bytes=await retained(f,value.provenance.returnedPrompt);assert.equal(bytes.toString(),returnedCaption);
 const inspection=inspectReturnedDescription(bytes);assert.equal(inspection.state,'available');assert.equal(inspection.elements.length,1);assert.equal(inspection.elements[0].index,1);assert.equal(inspection.elements[0].literal,returnedLiteral);
 return {view:value,candidate:value.items[0],bytes,selected:inspection.elements[0],prompt:value.provenance.returnedPrompt};
}
async function importLocalFont(f){
 const profileBytes=await readFile('src/text/profile.json'),profile=JSON.parse(profileBytes),fontProfile=profile.fonts.find(font=>font.id==='NotoSans');assert(fontProfile);
 const source=await stage(f,await readFile('vendor/text/'+fontProfile.file),'font','application/octet-stream'),license=await stage(f,await readFile('vendor/text/'+fontProfile.licenseFile));
 const font=(await run(f,{type:'ImportFont',source:source.blob,license:license.blob,origin:'local-file',embeddingReviewed:true})).events[0].payload.asset.font;assert.equal(font.origin,'local-file');return {font,profile,profileBytes};
}
async function nativeLayout(request,fonts){
 return new Promise((resolve,reject)=>{
  const worker=new Worker(new URL('../../dist/local/server/text/render-worker.mjs',import.meta.url),{workerData:{request,fonts},env:{},resourceLimits:{maxOldGenerationSizeMb:32,maxYoungGenerationSizeMb:8}});
  let result,error;const timer=setTimeout(()=>{error=Error('J19 native text fixture render deadline');void worker.terminate();},20000);
  worker.on('message',message=>{if(message.type==='ready')worker.postMessage({type:'admit'});else if(message.type==='result')result=message;else error=Error(JSON.stringify(message));});
  worker.on('error',value=>{error=value;});worker.on('exit',code=>{clearTimeout(timer);if(error)reject(error);else if(code||!result)reject(Error('J19 native fixture did not render'));else resolve(result);});
 });
}
async function prepareNative(f,local,{layerId='returned_text',literal='User confirmed Cafe\u0301',frame={width:48,height:24},placement={x:5,y:3},existing=null}={}){
 const {font,profile,profileBytes}=local,current=await document(f),generation=String(++f.generation),draftId='native-'+generation;
 // Transparent paint keeps the canonical fixture pixels directly reproducible;
 // glyph shaping/layout and final writer re-verification still use real workers.
 const style={primaryFont:font.bytes.hash,explicitFallbacks:[],sizePx:8,lineHeightMultiplier:1.2,fill:[40,90,190,0],align:'start',direction:'auto'};
 const token={documentId,documentRevision:current.revision,layerId,layerVersion:existing?.version??'0',sessionId,generation:Number(generation)};
 const rendered=await nativeLayout({text:literal,style,frame,token},[{path:objectPath(f,font.bytes),length:Number(font.bytes.byteLength),hash:font.bytes.hash,origin:font.origin,licenseHash:font.licenseRecord.hash}]);
 const put=async bytes=>(await stage(f,bytes,'text','application/octet-stream')).blob;
 const textUtf8=(await stage(f,Buffer.from(literal))).blob,layout={...await put(Buffer.from(rendered.layout)),mediaType:'application/json'},pixels={...await put(Buffer.alloc(Math.ceil(frame.width)*Math.ceil(frame.height)*4)),mediaType:'application/x-ideogram-rgba8'};
 assert.equal(rendered.rasterHash,pixels.hash);assert.equal(rendered.layoutHash,layout.hash);assert.equal(rendered.textHash,textUtf8.hash);assert(JSON.parse(rendered.layout).paragraphs.some(p=>p.runs.length>0));
 const manifest={...await put(profileBytes),mediaType:'application/json'},text=identify({schemaVersion:1,textUtf8,style,frame,layoutPolicy:'text-layout-1',fonts:[font]});
 const dependencyHash=sha(JSON.stringify({rendererProfile:profile.id,textHash:textUtf8.hash,style,frame,fonts:[{hash:font.bytes.hash,licenseHash:font.licenseRecord.hash,faceIndex:0,format:font.format,parserProfile:font.parserProfile,fsType:font.fsType}]}));
 const render=identify({schemaVersion:1,textVersion:text.id,rendererProfile:{schemaVersion:1,id:profile.id,manifest},dependencyHash,layout,pixels,width:rendered.width,height:rendered.height,overflow:rendered.overflow,resolvedFonts:[font.id]}),source={schemaVersion:1,text,render};
 const candidate={...await put(Buffer.from(canonical({schemaVersion:1,token,source}))),mediaType:'application/json'};
 const draftValue=existing?{schemaVersion:1,kind:'text-draft-1',textUtf8,style,frame,fonts:[font]}:{schemaVersion:2,kind:'text-draft-2',textUtf8,style,frame,fonts:[font],placement};
 const draft=await stage(f,Buffer.from(canonical(draftValue)));await ui(f,{type:'SaveDraft',draft:{id:draftId,generation,kind:'text',documentId,targetLayerId:existing?.id??null,expectedDocumentRevision:current.revision,assetId:draft.id,composing:false}});
 return {layerId,literal,source,candidate,placement,document:current,generation,draft:{sessionId,draftId,generation},budget:verificationBudget(literal,frame.width,frame.height,Number(font.bytes.byteLength),profile.engine.wasm.bytes)};
}
function descriptionReview(observed,prepared,patch={}){
 return makeReturnedDescriptionReview({id:randomUUID(),jobId:observed.candidate.jobId,attemptId:observed.candidate.attemptId,returnedPrompt:observed.prompt,elementIndex:observed.selected.index,elementHash:observed.selected.elementHash,documentId,documentRevision:prepared.document.revision,literal:prepared.source.text.textUtf8,frame:prepared.source.text.frame,placement:prepared.placement,style:prepared.source.text.style,fonts:prepared.source.text.fonts,placementChoice:'separate-placement',duplicationAcknowledged:true,...patch});
}
async function submitNative(f,prepared,body,{accepted=true,code,reason}={}){
 const admissionId=randomUUID()+'_'+prepared.generation+'_'+prepared.budget.bytes;assert.equal((await f.post('/api/v1/text-admission/'+admissionId,{protocolVersion:1})).status,200);
 try{
  const before=await document(f),beforeImage=await image(f),request=f.command({sessionId,documentId,expectedDocumentRevision:before.revision,body:{layerId:prepared.layerId,candidate:prepared.candidate,draft:prepared.draft,admissionId,...body}}),response=await terminalWithDiagnostics(f,request,{documentId:before.id,documentRevision:before.revision,layerId:prepared.layerId,generation:prepared.generation,admissionId,admissionBudgetBytes:prepared.budget.bytes,rendererProfile:prepared.source.render.rendererProfile.id,frame:prepared.source.text.frame});
  assert.equal(response.json.receipt.status,accepted?'accepted':'rejected',response.text);
  if(accepted)return {receipt:response.json.receipt,events:await events(f,response.json.receipt),document:await document(f),layer:(await image(f)).layers.find(l=>l.id===prepared.layerId)};
  if(code)assert.equal(response.json.receipt.code,code,response.text);if(reason)assert.equal((await object(f,response.json.receipt.details)).issues[0].code,reason);
  assert.deepEqual(await document(f),before);assert.deepEqual(await image(f),beforeImage);return response.json.receipt;
 }finally{assert.equal((await f.post('/api/v1/text-admission/'+admissionId+'/release',{protocolVersion:1})).status,200);}
}
function createBody(prepared,description){return {type:'CreateTextFromReturnedDescription',name:'User-confirmed lettering',placement:prepared.placement,description};}
async function terminalOrigin(f,layer){
 const owned=await asset(f,layer.assetId),seen=new Set();let ref=owned.retainedMetadata;assert(ref,'Native asset retains description origin');
 while(ref){assert(!seen.has(ref.hash));seen.add(ref.hash);assert(seen.size<=16);const value=await object(f,ref);if(value.kind==='created-text-description-1')return {asset:owned,ref,value};assert.equal(value.kind,'retained-raster-metadata-1');ref=value.previous;}
 assert.fail('No terminal returned-description origin');
}
async function assertArchiveRefs(f,bytes,expected){const entries=await unpack(f.root,bytes);for(const [ref,data]of expected){const member=entries.get('objects/'+ref.hash.slice(7));assert(member,'Archive retains '+ref.hash);assert.deepEqual(member,data);}return entries;}
async function previewSplitWithDiagnostics(f,bytes,baseline){
 const stage=await upload(f,bytes),request=f.command({documentId:null,expectedDocumentRevision:null,body:{type:'PreviewBundleImport',stagingId:stage.stagingId,expectedSha256:stage.sha256}});
 const response=await terminalWithDiagnostics(f,request,{...baseline,archiveBytes:String(bytes.length),stagingId:stage.stagingId});assert.equal(response.json.receipt.status,'accepted',response.text);
 const result={command:request,receipt:response.json.receipt,event:await eventFor(f,response.json.receipt)},review=(await f.read('/api/v1/bundle-reviews/'+result.event.payload.reviewId)).json;return {stage,review,result};
}
async function importBundle(f,review){
 const request=f.command({documentId:null,expectedDocumentRevision:null,body:{type:'ImportBundle',reviewId:review.reviewId,reviewHash:review.reviewHash}}),deadline=Date.now()+30000;
 await terminalWithDiagnostics(f,request,{reviewId:review.reviewId,documentId:review.documentId},async()=>{
  let response=await f.post('/api/v1/commands',request);
  while(response.status===202&&Date.now()<deadline){assert.equal(response.headers.location,response.json.receiptUrl);await new Promise(resolve=>setTimeout(resolve,10));response=await f.read('/api/v1/commands/'+request.command.commandId);}
  assert.equal(response.status,200,response.text);assert.equal(response.json.receipt.status,'accepted',response.text);
  return response;
 });
}

test('J19 real writer creates reviewed text, retains immutable caption through edit/Undo/Redo and imports complete inert provenance',{timeout:180000},async t=>{
 const f=await fixture(t),observed=await observedCaption(f),effects=await f.effects(),local=await importLocalFont(f),before=await image(f);
 const prepared=await prepareNative(f,local,{literal:'User confirmed Cafe\u0301\nlocal draft',frame:{width:48,height:24},placement:{x:5,y:3}}),review=descriptionReview(observed,prepared),created=await submitNative(f,prepared,createBody(prepared,review));
 assert.equal(created.layer.kind,'text');assert.deepEqual(created.layer.layerToDocument,[1,0,0,1,5,3]);assert.equal((await image(f)).layers.length,before.layers.length+1);
 const accepted=await object(f,created.layer.source),origin=await terminalOrigin(f,created.layer);
 assert.deepEqual(accepted,prepared.source);assert.equal((await retained(f,accepted.text.textUtf8)).toString(),prepared.literal);assert.notEqual(prepared.literal,observed.selected.literal);
 assert.equal(accepted.text.fonts[0].origin,'local-file');assert.deepEqual(accepted.text.frame,{width:48,height:24});assert.deepEqual(origin.value.review,review);assert.equal(origin.value.createdLayerId,created.layer.id);assert.deepEqual(origin.value.createdSource,created.layer.source);
 assert.deepEqual(await retained(f,observed.prompt),observed.bytes);assert.equal((await image(f)).layers.some(l=>l.kind==='image'),false,'Creating editable text does not adopt or erase generated pixels');
 const createdState=await image(f),later=await prepareNative(f,local,{layerId:created.layer.id,literal:'Later editable revision',frame:{width:52,height:24},existing:created.layer}),edited=await submitNative(f,later,{type:'CommitTextEdit',layerVersion:created.layer.version,reviewedDependencyHash:later.source.render.dependencyHash});
 const editedState=await image(f),editedSource=await object(f,edited.layer.source),editedOrigin=await terminalOrigin(f,edited.layer);
 assert.equal((await retained(f,editedSource.text.textUtf8)).toString(),'Later editable revision');assert.notEqual(edited.layer.source.hash,created.layer.source.hash);assert.deepEqual(editedOrigin.value,origin.value);assert.deepEqual(editedOrigin.ref,origin.ref);
 assert.deepEqual(await retained(f,observed.prompt),observed.bytes);assert.deepEqual(await object(f,origin.value.createdSource),accepted);
 await run(f,{type:'Undo',historyHead:edited.document.historyHead});assert.deepEqual(await image(f),createdState);
 await run(f,{type:'Redo',historyNode:edited.document.historyHead});assert.deepEqual(await image(f),editedState);assert.deepEqual(await f.effects(),effects);

 const retainedRefs=[origin.ref,observed.prompt,created.layer.source,accepted.text.textUtf8,accepted.render.layout,accepted.render.pixels,accepted.render.rendererProfile.manifest,edited.layer.source,editedSource.text.textUtf8,editedSource.render.layout,editedSource.render.pixels,...accepted.text.fonts.flatMap(font=>[font.bytes,font.licenseRecord])];
 const expected=await Promise.all([...new Map(retainedRefs.map(ref=>[ref.hash,ref])).values()].map(async ref=>[ref,await retained(f,ref)]));
 const saved=await copy(f,documentId);await assertArchiveRefs(f,saved.bytes,expected);
 const inspected=(await preview(f,saved.bytes)).review;assert.equal(inspected.editable,true,JSON.stringify(inspected));assert.notEqual(inspected.documentId,documentId);
 await importBundle(f,inspected);
 const importedState=await image(f,inspected.documentId),importedLayer=importedState.layers.find(l=>l.kind==='text');assert(importedLayer);assert.notEqual(importedLayer.id,created.layer.id);
 const importedOrigin=await terminalOrigin(f,importedLayer);assert.deepEqual(importedOrigin.value,origin.value,'Imported observations retain their original namespace and do not become a new review');
 const importedSource=await object(f,importedLayer.source);assert.equal((await retained(f,importedSource.text.textUtf8)).toString(),'Later editable revision');
 const queue=(await f.read('/api/v1/queue')).json;assert(!queue.jobs.some(job=>job.documentId===inspected.documentId));
 const history=(await f.read('/api/v1/documents/'+inspected.documentId+'/candidates')).json.items;assert(history.length>0);assert(history.every(entry=>entry.inert));
 for(const entry of history){const response=await f.read('/api/v1/jobs/'+entry.jobId+'/candidates?attempt='+entry.attemptId);assert.equal(response.status,200,response.text);assert.equal(response.json.inert,true);assert.deepEqual(response.json.provenance.returnedPrompt,observed.prompt);}
 const recopied=await copy(f,inspected.documentId);await assertArchiveRefs(f,recopied.bytes,expected);assert.deepEqual(await f.effects(),effects);assert.deepEqual(await retained(f,observed.prompt),observed.bytes);
});

test('J19 real writer refuses forged caption, selected element, local source and stale review without creating text',{timeout:180000},async t=>{
 const f=await fixture(t),observed=await observedCaption(f),effects=await f.effects(),local=await importLocalFont(f),prepared=await prepareNative(f,local),review=descriptionReview(observed,prepared);
 const reseal=value=>{const {hash,...binding}=value;return {...binding,hash:sha(canonical(binding))};};
 const unrelated=(await stage(f,Buffer.from(returnedCaption.replace('Blue title lettering','A different retained description')))).blob;
 const literal=(await stage(f,Buffer.from('A literal absent from the prepared native source'))).blob;
 const cases=[
  {patch:{returnedPrompt:unrelated},code:'INCOMPATIBLE',reason:'SUPPORTED_RETURNED_DESCRIPTION_REQUIRED'},
  {patch:{elementHash:sha('forged selected text element')},code:'INVALID_INPUT',reason:'RETURNED_DESCRIPTION_REVIEW_CHANGED'},
  {patch:{literal},code:'INVALID_INPUT',reason:'RETURNED_DESCRIPTION_REVIEW_CHANGED'},
  {patch:{styleHash:sha('another local style')},code:'INVALID_INPUT',reason:'RETURNED_DESCRIPTION_REVIEW_CHANGED'},
  {patch:{documentRevision:'0'},code:'STALE_REVISION',reason:'RETURNED_TEXT_TARGET_CHANGED'},
 ];
 for(const {patch,code,reason}of cases){await submitNative(f,prepared,createBody(prepared,reseal({...review,...patch})),{accepted:false,code,reason});assert.equal((await image(f)).layers.length,0);assert.deepEqual(await retained(f,observed.prompt),observed.bytes);}
 // The same genuine prepared source remains usable after rejected reviews.
 const created=await submitNative(f,prepared,createBody(prepared,review));assert.equal(created.layer.kind,'text');assert.deepEqual((await terminalOrigin(f,created.layer)).value.review,review);assert.deepEqual(await f.effects(),effects);
});

// Split fixtures retain one complete saved draft/generation. Each child uses
// the actual native layout/render worker; the writer verifies every candidate
// without a browser admission and accepts the whole change in one transaction.
async function prepareSplit(f,local,{literal='a\n'.repeat(256)+'z',existing=null,description,frame={width:48,height:24},placement={x:5,y:3},layerPrefix='split',offsets,alterCandidate,planningSlots}={}){
 const {font,profile,profileBytes}=local,current=await document(f),before=await image(f),generation=String(++f.generation),draftId='split-draft-'+generation;
 const style={primaryFont:font.bytes.hash,explicitFallbacks:[],sizePx:8,lineHeightMultiplier:1.2,fill:[40,90,190,0],align:'start',direction:'auto'},fonts=[font];
 const originalText=(await stage(f,Buffer.from(literal))).blob,ranges=planTextSplit(literal,planningSlots??100-before.layers.length+(existing?1:0));assert(ranges.length>=2,'Fixture requires an actual multi-layer split');
 const put=async bytes=>({...((await stage(f,bytes,'text','application/octet-stream')).blob)}),manifest={...await put(profileBytes),mediaType:'application/json'},parts=[],candidates=[],sources=[];
 for(const [index,range]of ranges.entries()){
  const text=literal.slice(range.start16,range.end16),layerId=index===0&&existing?existing.id:layerPrefix+'_'+generation+'_'+index,offset=offsets?.[index]??{x:0,y:index*frame.height};
  const token={documentId,documentRevision:current.revision,layerId,layerVersion:index===0&&existing?existing.version:'0',sessionId,generation:Number(generation)};
  const rendered=await nativeLayout({text,style,frame,token},[{path:objectPath(f,font.bytes),length:Number(font.bytes.byteLength),hash:font.bytes.hash,origin:font.origin,licenseHash:font.licenseRecord.hash}]);
  const textUtf8=(await stage(f,Buffer.from(text))).blob,layout={...await put(Buffer.from(rendered.layout)),mediaType:'application/json'},pixels={...await put(Buffer.alloc(Math.ceil(frame.width)*Math.ceil(frame.height)*4)),mediaType:'application/x-ideogram-rgba8'};
  assert.equal(rendered.textHash,textUtf8.hash);assert.equal(rendered.layoutHash,layout.hash);assert.equal(rendered.rasterHash,pixels.hash);
  const version=identify({schemaVersion:1,textUtf8,style,frame,layoutPolicy:'text-layout-1',fonts});
  const dependencyHash=sha(JSON.stringify({rendererProfile:profile.id,textHash:textUtf8.hash,style,frame,fonts:[{hash:font.bytes.hash,licenseHash:font.licenseRecord.hash,faceIndex:0,format:font.format,parserProfile:font.parserProfile,fsType:font.fsType}]}));
  const render=identify({schemaVersion:1,textVersion:version.id,rendererProfile:{schemaVersion:1,id:profile.id,manifest},dependencyHash,layout,pixels,width:rendered.width,height:rendered.height,overflow:rendered.overflow,resolvedFonts:[font.id]}),source={schemaVersion:1,text:version,render};
  const actual={schemaVersion:1,token,source},candidateValue=alterCandidate?alterCandidate(index,structuredClone(actual))??actual:actual,candidate={...await put(Buffer.from(canonical(candidateValue))),mediaType:'application/json'};
  sources.push(source);candidates.push(candidateValue);parts.push({layerId,name:'Split '+(index+1),startByte:range.startByte,endByte:range.endByte,candidate,offset,reviewedDependencyHash:dependencyHash,reviewedRasterHash:pixels.hash});
 }
 const saved=description?{schemaVersion:3,kind:'text-draft-3',textUtf8:originalText,style,frame,fonts,placement,description}:existing?{schemaVersion:1,kind:'text-draft-1',textUtf8:originalText,style,frame,fonts}:{schemaVersion:2,kind:'text-draft-2',textUtf8:originalText,style,frame,fonts,placement};
 const draftAsset=await stage(f,Buffer.from(canonical(saved)));await ui(f,{type:'SaveDraft',draft:{id:draftId,generation,kind:'text',documentId,targetLayerId:existing?.id??null,expectedDocumentRevision:current.revision,assetId:draftAsset.id,composing:false}});
 const planValue={kind:'text-split-plan-1',originalText,parts,...(description?{description}:{})},plan={...await put(Buffer.from(canonical(planValue))),mediaType:'application/json'};
 return {literal,document:current,generation,draft:{sessionId,draftId,generation},draftAsset,saved,originalText,ranges,parts,candidates,sources,planValue,plan,sourceLayer:existing?{layerId:existing.id,layerVersion:existing.version}:null};
}
async function submitSplit(f,prepared,{accepted=true,code,reason,bodyPatch={}}={}){
 const before=await document(f),beforeImage=await image(f),beforeHistory=(await f.read('/api/v1/documents/'+documentId+'/history')).json;
 const request=f.command({sessionId,documentId,expectedDocumentRevision:prepared.document.revision,body:{type:'SplitTextDraft',draft:prepared.draft,sourceLayer:prepared.sourceLayer,plan:prepared.plan,reviewedPlanHash:prepared.plan.hash,...bodyPatch}});
 const response=await terminalWithDiagnostics(f,request,{documentId,documentRevision:prepared.document.revision,generation:prepared.generation,parts:prepared.parts.length,plan:prepared.plan.hash});
 assert.equal(response.json.receipt.status,accepted?'accepted':'rejected',response.text);
 if(accepted){const state=await image(f);return {request,receipt:response.json.receipt,events:await events(f,response.json.receipt),document:await document(f),image:state,layers:prepared.parts.map(part=>state.layers.find(layer=>layer.id===part.layerId))};}
 if(code)assert.equal(response.json.receipt.code,code,response.text);if(reason)assert.equal((await object(f,response.json.receipt.details)).issues[0].code,reason);
 assert.deepEqual(await document(f),before);assert.deepEqual(await image(f),beforeImage);assert.deepEqual((await f.read('/api/v1/documents/'+documentId+'/history')).json,beforeHistory);
 return response.json.receipt;
}

test('R33 real writer splits one saved draft atomically and Undo/Redo covers every child',{timeout:180000},async t=>{
 const f=await fixture(t),local=await importLocalFont(f),prepared=await prepareSplit(f,local),before=await document(f),beforeImage=await image(f),beforeHistory=(await f.read('/api/v1/documents/'+documentId+'/history')).json.items,effects=await f.effects();
 const noncanonical={...(await stage(f,Buffer.from(' '+canonical(prepared.planValue)),'text','application/octet-stream')).blob,mediaType:'application/json'};await submitSplit(f,prepared,{accepted:false,code:'INVALID_INPUT',reason:'TEXT_SPLIT_METADATA_NOT_CANONICAL',bodyPatch:{plan:noncanonical,reviewedPlanHash:noncanonical.hash}});
 const result=await submitSplit(f,prepared),edits=result.events.filter(event=>event.type==='ImageEdited');
 assert.equal(edits.length,1);assert.equal(edits[0].payload.history.operation,'SplitTextDraft');assert.equal(edits[0].payload.history.parent,before.historyHead);assert.equal(result.document.revision,String(BigInt(before.revision)+1n));
 assert.equal((await f.read('/api/v1/documents/'+documentId+'/history')).json.items.length,beforeHistory.length+1);assert.equal(result.layers.length,prepared.parts.length);assert(result.layers.every(Boolean));
 assert(result.events.every(event=>event.commandId===result.request.command.commandId&&event.transactionId===result.receipt.transactionId));
 assert.equal(result.events.filter(event=>event.type==='AssetRegistered').length,prepared.parts.length+1,'All child assets and the combined raster are one receipt');
 const retried=await terminal(f,result.request);assert.deepEqual(retried.json.receipt,result.receipt);assert.deepEqual(await document(f),result.document);assert.deepEqual(await image(f),result.image);assert.equal((await f.read('/api/v1/documents/'+documentId+'/history')).json.items.length,beforeHistory.length+1,'Exact retry cannot create a second split');
 const contents=[];
 for(const [index,layer]of result.layers.entries()){
  assert.equal(layer.kind,'text');assert.equal(layer.version,'1');assert.deepEqual(layer.layerToDocument,[1,0,0,1,prepared.saved.placement.x+prepared.parts[index].offset.x,prepared.saved.placement.y+prepared.parts[index].offset.y]);
  const source=await object(f,layer.source);assert.deepEqual(source,prepared.sources[index]);contents.push(await retained(f,source.text.textUtf8));
 }
 assert.deepEqual(Buffer.concat(contents),Buffer.from(prepared.literal));assert.deepEqual(await retained(f,prepared.originalText),Buffer.from(prepared.literal));
 const checkpoint=(await f.read('/api/v1/ui/'+sessionId)).json,saved=checkpoint.drafts.find(draft=>draft.id===prepared.draft.draftId);
 assert.equal(saved.generation,prepared.generation);assert.equal(saved.status,'applied');assert.equal(checkpoint.drafts.filter(draft=>draft.kind==='text').length,1);
 await run(f,{type:'Undo',historyHead:result.document.historyHead});assert.deepEqual(await image(f),beforeImage);
 await run(f,{type:'Redo',historyNode:result.document.historyHead});assert.deepEqual(await image(f),result.image);assert.deepEqual(await f.effects(),effects);
});

test('R33 real writer rejects an invalid second split candidate without partial layers or history',{timeout:180000},async t=>{
 const f=await fixture(t),local=await importLocalFont(f),prepared=await prepareSplit(f,local,{alterCandidate(index,candidate){if(index===1)candidate.token.generation++;return candidate;}}),effects=await f.effects();
 assert(prepared.parts.length>=2);await submitSplit(f,prepared,{accepted:false,code:'STALE_REVISION',reason:'TEXT_TOKEN_CHANGED'});
 assert.equal((await image(f)).layers.length,0);const checkpoint=(await f.read('/api/v1/ui/'+sessionId)).json,saved=checkpoint.drafts.find(draft=>draft.id===prepared.draft.draftId);
 assert.equal(saved.generation,prepared.generation);assert.equal(saved.status,'saved-unapplied');assert.deepEqual(await retained(f,prepared.originalText),Buffer.from(prepared.literal));assert.deepEqual(await f.effects(),effects);
});

test('R33 existing native split preserves first identity, exact affine properties and immutable origin through Undo/Redo',{timeout:180000},async t=>{
 const f=await fixture(t),observed=await observedCaption(f),local=await importLocalFont(f),native=await prepareNative(f,local),created=await submitNative(f,native,createBody(native,descriptionReview(observed,native))),origin=await terminalOrigin(f,created.layer),effects=await f.effects();
 const affine=[0.75,0.25,-0.5,1.25,11,7];
 await run(f,{type:'ApplyTransform',layerId:created.layer.id,layerVersion:created.layer.version,transform:affine,draft:null});
 const transformed=(await image(f)).layers.find(layer=>layer.id===created.layer.id),mask=(await operate(f,{type:'PrepareMask',plan:{width:64,height:32,feather:0,operations:[{kind:'shape',shape:{kind:'rectangle',x:4,y:2,width:32,height:18},mode:'replace'}]}})).event.payload.asset;
 await run(f,{type:'SetLayerProperties',layerId:transformed.id,layerVersion:transformed.version,properties:{opacity:0.375,visible:false,mask:{assetId:mask.id,mapping:'document-r16-v1',inverted:false}},draft:null});
 const bindingView=(await f.read('/api/v1/documents/'+documentId+'/composition?revision='+(await document(f)).revision)).json,composition=emptyComposition(64,32,randomUUID()),element=emptyElement('text',randomUUID());
 element.text=linkField('text-content',bindingView.layers.find(layer=>layer.id===created.layer.id));composition.elements=[element];const bindings={[created.layer.id]:created.layer.id};assert.equal(fieldStatus(element.text,bindingView.layers,bindings),'reviewed');
 const graph={...(await stage(f,Buffer.from(canonical(composition)),'text','application/octet-stream')).blob,mediaType:'application/json'};await run(f,{type:'CommitCompositionVersion',composition:{id:composition.id,value:graph,bindings},draft:null});
 const beforeImage=await image(f),old=beforeImage.layers.find(layer=>layer.id===created.layer.id),prepared=await prepareSplit(f,local,{existing:old,offsets:[{x:0,y:0},{x:9,y:13}]}),before=await document(f),beforeHistory=(await f.read('/api/v1/documents/'+documentId+'/history')).json.items,result=await submitSplit(f,prepared);
 assert.equal(prepared.saved.kind,'text-draft-1');assert.equal(prepared.planValue.description,undefined);assert.equal(result.layers.length,2);assert.equal(result.layers[0].id,old.id);assert.equal(result.layers[0].version,String(BigInt(old.version)+1n));assert.notEqual(result.layers[1].id,old.id);assert.equal(result.layers[1].version,'1');
 assert.equal(result.document.revision,String(BigInt(before.revision)+1n));assert.equal(result.events.filter(event=>event.type==='ImageEdited').length,1);assert.equal((await f.read('/api/v1/documents/'+documentId+'/history')).json.items.length,beforeHistory.length+1);
 const oldIndex=beforeImage.layers.findIndex(layer=>layer.id===old.id);assert.deepEqual(result.image.layers.map(layer=>layer.id),[...beforeImage.layers.slice(0,oldIndex).map(layer=>layer.id),...prepared.parts.map(part=>part.layerId),...beforeImage.layers.slice(oldIndex+1).map(layer=>layer.id)]);
 const currentComposition=(await f.read('/api/v1/documents/'+documentId+'/composition?revision='+result.document.revision)).json;assert.deepEqual(result.image.composition,beforeImage.composition);assert.deepEqual(currentComposition.composition,composition);assert.deepEqual(currentComposition.bindings,bindings);assert.equal(fieldStatus(currentComposition.composition.elements[0].text,currentComposition.layers,currentComposition.bindings),'stale');assert.throws(()=>serialize(currentComposition.composition,currentComposition.layers,currentComposition.bindings),/STALE_LINK/);
 for(const [index,layer]of result.layers.entries()){
  const offset=prepared.parts[index].offset;assert.deepEqual(layer.layerToDocument,[affine[0],affine[1],affine[2],affine[3],affine[4]+affine[0]*offset.x+affine[2]*offset.y,affine[5]+affine[1]*offset.x+affine[3]*offset.y]);
  for(const property of ['visible','opacity','blend','locked','mask'])assert.deepEqual(layer[property],old[property],property+' is copied without moving document-space masks');
  assert.deepEqual(await object(f,layer.source),prepared.sources[index]);const inherited=await terminalOrigin(f,layer);assert.deepEqual(inherited.ref,origin.ref);assert.deepEqual(inherited.value,origin.value);assert.equal(inherited.value.createdLayerId,created.layer.id);assert.deepEqual(inherited.value.createdSource,created.layer.source);
 }
 assert.deepEqual(await retained(f,observed.prompt),observed.bytes);await run(f,{type:'Undo',historyHead:result.document.historyHead});assert.deepEqual(await image(f),beforeImage);
 await run(f,{type:'Redo',historyNode:result.document.historyHead});assert.deepEqual(await image(f),result.image);assert.deepEqual(await f.effects(),effects);
});

test('R33 late split authority expiry rejects after real preparation without partial durable effects',{timeout:180000},async t=>{
 const [{openWriter},{DatabaseSync},{encode}]=await Promise.all([import('../../dist/local/server/storage/writer.js'),import('node:sqlite'),import('../store/helpers.mjs')]);
 const f=await fixture(t),local=await importLocalFont(f),prepared=await prepareSplit(f,local),before=await document(f),beforeImage=await image(f),beforeCheckpoint=(await f.read('/api/v1/ui/'+sessionId)).json,effects=await f.effects();
 await f.server.close();const gate=new SharedArrayBuffer(4);let hit,writer;const barrier=new Promise(resolve=>hit=resolve),release=()=>{Atomics.store(new Int32Array(gate),0,1);Atomics.notify(new Int32Array(gate),0);};
 t.after(async()=>{release();await writer?.close();});writer=await openWriter({root:f.root},{phase:'history-after-proofs',gate,onBarrier:hit});
 const auth={clientId:f.paired.json.clientId,sessionHash:'d'.repeat(64),now:Date.now(),expires:Date.now()+1800000};await writer.rememberClient(auth.sessionHash,auth.clientId,auth.expires);
 const counts=()=>{const db=new DatabaseSync(join(f.root,'metadata.sqlite'));try{return {documents:Number(db.prepare('SELECT count(*) n FROM documents').get().n),assets:Number(db.prepare('SELECT count(*) n FROM assets').get().n),history:Number(db.prepare('SELECT count(*) n FROM history').get().n),events:Number(db.prepare('SELECT count(*) n FROM events_v2').get().n),accepted:Number(db.prepare("SELECT count(*) n FROM commands WHERE json_extract(receipt,'$.status')='accepted'").get().n)};}finally{db.close();}};
 const beforeCounts=counts(),beforeHistory=await writer.historyPage(documentId,'','history'),request=f.command({sessionId,documentId,expectedDocumentRevision:prepared.document.revision,body:{type:'SplitTextDraft',draft:prepared.draft,sourceLayer:null,plan:prepared.plan,reviewedPlanHash:prepared.plan.hash}});let timer;
 try{
  const reached=await Promise.race([(async()=>{await writer.historyCommand(encode(request),auth);return barrier;})(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Split did not reach history-after-proofs within 60 seconds')),60000);})]);assert.equal(reached,'history-after-proofs');
  const db=new DatabaseSync(join(f.root,'metadata.sqlite'));try{assert.equal(db.prepare('UPDATE client_bindings SET expires=? WHERE cookie_hash=?').run('0',auth.sessionHash).changes,1);}finally{db.close();}
 }finally{clearTimeout(timer);release();}
 let settled;const deadline=Date.now()+15000;do{settled=await writer.commandState(request.command.commandId);if(settled.record)break;await new Promise(resolve=>setTimeout(resolve,10));}while(Date.now()<deadline);
 const diagnostic=await writer.readDiagnostics();try{
  const value=diagnostic.value,ownership=value.observer.worker.owners.objects,afterCounts=counts();t.diagnostic(JSON.stringify({kind:'split-late-authority-1',commandId:request.command.commandId,beforeCounts,afterCounts,receipt:settled.record?.receipt,objects:ownership,text:{reservedCPU:value.text.reservedCPU,externalBytes:value.text.externalBytes},activeWorkers:value.rasters.activeWorkers}));
  assert.equal(settled.record?.receipt.status,'rejected');assert.equal(settled.record.receipt.code,'INVALID_INPUT');assert.equal((await object(f,settled.record.receipt.details)).issues[0].code,'IMAGE_REVIEW_EXPIRED');assert.equal(settled.pending,null);
  assert.deepEqual(afterCounts,beforeCounts);assert.equal(ownership.proofReservations,0);assert.equal(ownership.retainedProofs,0);assert.equal(ownership.proofReaders,0);assert.equal(ownership.proofWaiters,0);assert.equal(value.text.reservedCPU,0);assert.equal(value.text.externalBytes,0);assert.equal(value.rasters.activeWorkers,0);
 }finally{diagnostic.release();}
 assert.deepEqual(await writer.document(documentId),before);assert.deepEqual(await writer.imageState(documentId),beforeImage);assert.deepEqual(await writer.historyPage(documentId,'','history'),beforeHistory);assert.deepEqual(await writer.uiRead(sessionId,auth),beforeCheckpoint);assert.deepEqual(await retained(f,prepared.originalText),Buffer.from(prepared.literal));assert.deepEqual(await f.effects(),effects);
});

test('R33 stale saved split generation cannot replace the current draft or mutate layers and history',{timeout:180000},async t=>{
 const f=await fixture(t),local=await importLocalFont(f),prepared=await prepareSplit(f,local),replacementText=(await stage(f,Buffer.from('Newer saved text draft'))).blob,replacement={...prepared.saved,textUtf8:replacementText},replacementAsset=await stage(f,Buffer.from(canonical(replacement))),generation=String(++f.generation);
 await ui(f,{type:'SaveDraft',draft:{id:prepared.draft.draftId,generation,kind:'text',documentId,targetLayerId:null,expectedDocumentRevision:prepared.document.revision,assetId:replacementAsset.id,composing:false}});
 const checkpoint=(await f.read('/api/v1/ui/'+sessionId)).json,effects=await f.effects();await submitSplit(f,prepared,{accepted:false,code:'STALE_REVISION',reason:'DRAFT_GENERATION_CHANGED'});
 assert.deepEqual((await f.read('/api/v1/ui/'+sessionId)).json,checkpoint);const saved=checkpoint.drafts.find(draft=>draft.id===prepared.draft.draftId);assert.equal(saved.generation,generation);assert.equal(saved.assetId,replacementAsset.id);assert.equal(saved.status,'saved-unapplied');
 assert.equal((await image(f)).layers.length,0);assert.deepEqual(await object(f,replacementAsset.blob),replacement);assert.deepEqual(await retained(f,prepared.originalText),Buffer.from(prepared.literal));assert.deepEqual(await f.effects(),effects);
});

async function splitOrigin(f,layer){
 const owned=await asset(f,layer.assetId),seen=new Set();let ref=owned.retainedMetadata;
 while(ref){assert(!seen.has(ref.hash));seen.add(ref.hash);assert(seen.size<=16);const value=await object(f,ref);if(value.kind==='created-text-split-description-1')return {ref,value};assert.equal(value.kind,'retained-raster-metadata-1');ref=value.previous;}
 assert.fail('No terminal returned-description split origin');
}

test('R33 split counts image and native layers together at the 100-layer boundary',{timeout:300000},async t=>{
 const f=await fixture(t),local=await importLocalFont(f),raster=await importRaster(f,'hidden-alpha.png');
 await run(f,{type:'ImportAsset',assetId:raster.asset.id,layerId:'limit_image',name:'Image',draft:null});
 for(let index=1;index<98;index++)await run(f,{type:'DuplicateLayer',layerId:'limit_image',layerVersion:'1',newLayerId:'limit_image_'+index,name:'Image '+index,draft:null});
 assert.equal((await image(f)).layers.length,98);
 const prepared=await prepareSplit(f,local,{layerPrefix:'limit_text'});assert.equal(prepared.parts.length,2);const accepted=await submitSplit(f,prepared);
 assert.equal(accepted.image.layers.length,100);assert.equal(accepted.image.layers.filter(layer=>layer.kind==='image').length,98);assert.equal(accepted.image.layers.filter(layer=>layer.kind==='text').length,2);
 // An untrusted caller may prepare an otherwise valid plan despite the UI's
 // slot count. The real writer still refuses the complete transaction.
 const excess=await prepareSplit(f,local,{layerPrefix:'limit_excess',planningSlots:100});await submitSplit(f,excess,{accepted:false,code:'CAPACITY',reason:'DOCUMENT_LAYER_LIMIT'});
 assert.equal((await image(f)).layers.length,100);assert.deepEqual(await retained(f,excess.originalText),Buffer.from(excess.literal));
});

test('R33 split refuses aggregate native text above 1MiB while retaining the complete draft',{timeout:180000},async t=>{
 const f=await fixture(t),local=await importLocalFont(f),first=await prepareNative(f,local,{layerId:'aggregate_existing',literal:'x'});
 await submitNative(f,first,{type:'CreateTextLayer',name:'Existing byte',placement:first.placement});
 // One genuine 16KiB layout is reusable for identical source bytes. Candidate
 // envelopes retain distinct exact layer identities under one saved draft.
 const sample=await prepareNative(f,local,{layerId:'aggregate_sample',literal:'x'.repeat(16384)}),current=await document(f),generation=String(++f.generation),draftId='aggregate-'+generation,literal='x'.repeat(1048576),originalText=(await stage(f,Buffer.from(literal))).blob;
 const saved={schemaVersion:2,kind:'text-draft-2',textUtf8:originalText,style:sample.source.text.style,frame:sample.source.text.frame,fonts:sample.source.text.fonts,placement:sample.placement},draftAsset=await stage(f,Buffer.from(canonical(saved)));
 await ui(f,{type:'SaveDraft',draft:{id:draftId,generation,kind:'text',documentId,targetLayerId:null,expectedDocumentRevision:current.revision,assetId:draftAsset.id,composing:false}});
 const parts=[];
 for(let index=0;index<64;index++){
  const layerId='aggregate_'+generation+'_'+index,token={documentId,documentRevision:current.revision,layerId,layerVersion:'0',sessionId,generation:Number(generation)},candidate={...(await stage(f,Buffer.from(canonical({schemaVersion:1,token,source:sample.source})),'text','application/octet-stream')).blob,mediaType:'application/json'};
  parts.push({layerId,name:'Part '+(index+1),startByte:index*16384,endByte:(index+1)*16384,candidate,offset:{x:0,y:0},reviewedDependencyHash:sample.source.render.dependencyHash,reviewedRasterHash:sample.source.render.pixels.hash});
 }
 const planValue={kind:'text-split-plan-1',originalText,parts},plan={...(await stage(f,Buffer.from(canonical(planValue)),'text','application/octet-stream')).blob,mediaType:'application/json'},prepared={document:current,generation,draft:{sessionId,draftId,generation},sourceLayer:null,plan,parts};
 assert.equal(originalText.byteLength,'1048576');assert(BigInt(plan.byteLength)<=65536n);await submitSplit(f,prepared,{accepted:false,code:'CAPACITY',reason:'TEXT_DOCUMENT_LIMIT'});
 const checkpoint=(await f.read('/api/v1/ui/'+sessionId)).json;assert.equal(checkpoint.drafts.find(draft=>draft.id===draftId).status,'saved-unapplied');assert.deepEqual(await retained(f,originalText),Buffer.from(literal));assert.equal((await image(f)).layers.length,1);
});

test('R33 described draft above 16KiB retains exact split origin through Undo/Redo and two portable imports',{timeout:300000},async t=>{
 const f=await fixture(t),observed=await observedCaption(f),local=await importLocalFont(f),effects=await f.effects();
 const description={kind:'returned-description-selection-1',jobId:observed.candidate.jobId,attemptId:observed.candidate.attemptId,returnedPrompt:observed.prompt,elementIndex:observed.selected.index,elementHash:observed.selected.elementHash,placementChoice:'separate-placement',duplicationAcknowledged:true};
 const literal='Cafe\u0301 '.repeat(2400)+'\nFin',prepared=await prepareSplit(f,local,{literal,description,layerPrefix:'described_split'}),before=await image(f);
 assert(Buffer.byteLength(literal)>16384);assert(prepared.parts.length>=2);const result=await submitSplit(f,prepared),origin=await splitOrigin(f,result.layers[0]);
 assert.deepEqual(origin.value,{schemaVersion:1,kind:'created-text-split-description-1',draft:prepared.draftAsset.blob,plan:prepared.plan});
 for(const layer of result.layers)assert.deepEqual(await splitOrigin(f,layer),origin);
 assert.deepEqual(await object(f,origin.value.draft),prepared.saved);assert.deepEqual(await object(f,origin.value.plan),prepared.planValue);assert.deepEqual(await retained(f,prepared.originalText),Buffer.from(literal));
 await run(f,{type:'Undo',historyHead:result.document.historyHead});assert.deepEqual(await image(f),before);assert.deepEqual(await retained(f,prepared.originalText),Buffer.from(literal));
 await run(f,{type:'Redo',historyNode:result.document.historyHead});assert.deepEqual(await image(f),result.image);
 const refs=[origin.ref,origin.value.draft,origin.value.plan,observed.prompt,prepared.originalText,...prepared.parts.map(part=>part.candidate),...prepared.sources.flatMap(source=>[source.text.textUtf8,source.render.layout,source.render.pixels,source.render.rendererProfile.manifest,...source.text.fonts.flatMap(font=>[font.bytes,font.licenseRecord])])];
 const expected=await Promise.all([...new Map(refs.map(ref=>[ref.hash,ref])).values()].map(async ref=>[ref,await retained(f,ref)]));
 let copiedDocument=documentId;
 for(let cycle=0;cycle<2;cycle++){
  const saved=await copy(f,copiedDocument);await assertArchiveRefs(f,saved.bytes,expected);const review=(await previewSplitWithDiagnostics(f,saved.bytes,{documentId:copiedDocument,cycle,originalTextBytes:prepared.originalText.byteLength,layoutBytes:prepared.sources.map(source=>source.render.layout.byteLength)})).review;assert.equal(review.editable,true,JSON.stringify(review));await importBundle(f,review);copiedDocument=review.documentId;
  const imported=await image(f,copiedDocument),importedLayers=imported.layers.filter(layer=>layer.kind==='text');assert.equal(importedLayers.length,prepared.parts.length);
  const texts=[];for(const layer of importedLayers){assert.deepEqual(await splitOrigin(f,layer),origin);texts.push(await retained(f,(await object(f,layer.source)).text.textUtf8));}
  assert.deepEqual(Buffer.concat(texts),Buffer.from(literal));
  // Archival tokens remain original observations. Copy/import neither remaps
  // them nor supplies a fresh saved checkpoint for a second adoption.
  const target=await document(f,copiedDocument),request=f.command({sessionId,documentId:copiedDocument,expectedDocumentRevision:target.revision,body:{type:'SplitTextDraft',draft:prepared.draft,sourceLayer:null,plan:prepared.plan,reviewedPlanHash:prepared.plan.hash}}),refused=await terminal(f,request);
  assert.equal(refused.json.receipt.status,'rejected',refused.text);assert.deepEqual(await document(f,copiedDocument),target);assert.deepEqual(await image(f,copiedDocument),imported);
 }
 assert.deepEqual(await f.effects(),effects);assert.deepEqual(await retained(f,observed.prompt),observed.bytes);
 // The portable validator follows exact immutable objects, with no writer or
 // session authority. Re-sealing tampered metadata must not disguise a change.
 await validateReturnedTextObservation(origin.value,ref=>retained(f,ref));
 for(const change of ['selection','range','candidate']){
  const forgedPlan=structuredClone(prepared.planValue),overrides=new Map();
  const put=value=>{const bytes=Buffer.from(canonical(value)),ref={hash:sha(bytes),byteLength:String(bytes.length),mediaType:'application/json'};overrides.set(ref.hash,bytes);return ref;};
  if(change==='selection')forgedPlan.description.elementHash=sha('another element');
  if(change==='range'){forgedPlan.parts[0].endByte--;forgedPlan.parts[1].startByte--;}
  if(change==='candidate'){const candidate=structuredClone(prepared.candidates[1]);candidate.token.generation++;forgedPlan.parts[1].candidate=put(candidate);}
  const forgedOrigin={...origin.value,plan:put(forgedPlan)};
  await assert.rejects(validateReturnedTextObservation(forgedOrigin,ref=>overrides.has(ref.hash)?Promise.resolve(overrides.get(ref.hash)):retained(f,ref)),undefined,change+' must fail closed');
 }
});

test('R33 genuine prior schema19 reader opens the baseline and refuses split history without changing durable state',{timeout:300000},async t=>{
 const directory=await rootFor(t);
 compileLegacy(directory,'8901d923f309125c5bc19605efe76a871a7ee1df',['server','src','tooling','tsconfig.server.json']);
 const [{openWriter:openPriorWriter},{event:priorEvent}]=await Promise.all([import(pathToFileURL(join(directory,'dist/local/server/storage/writer.js')).href),import(pathToFileURL(join(directory,'dist/local/src/protocol/validate.js')).href)]);
 const inspect=root=>{const db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});try{return {version:db.prepare('PRAGMA user_version').get().user_version,tables:Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(row=>[row.name,tableRows(db,row.name)]))};}finally{db.close();}};
 const files=async root=>{const values={};async function visit(path){for(const entry of await readdir(join(root,path),{withFileTypes:true})){const next=join(path,entry.name);if(entry.isDirectory())await visit(next);else{assert(entry.isFile(),next);values[next]=sha(await readFile(join(root,next)));}}}for(const path of ['objects','staging','uploads','portable'])await visit(path);return values;};
 // Same storage schema and unchanged event vocabulary: the archived executable
 // really opens a current baseline before its unsupported-event refusal counts.
 const baseline=await fixture(t),baselineDocument=await document(baseline);await baseline.server.close();assert.equal(inspect(baseline.root).version,19);
 const prior=await openPriorWriter({root:baseline.root});try{assert.deepEqual(await prior.document(documentId),baselineDocument);}finally{await prior.close();}
 const f=await fixture(t),local=await importLocalFont(f),prepared=await prepareSplit(f,local),accepted=await submitSplit(f,prepared);
 const splitEvent=accepted.events.find(event=>event.type==='ImageEdited'&&event.payload.history.operation==='SplitTextDraft');assert(splitEvent);assert.throws(()=>priorEvent(splitEvent));
 for(const event of accepted.events.filter(event=>event.type==='AssetRegistered'))assert.doesNotThrow(()=>priorEvent(event));
 await f.server.close();const before=inspect(f.root),bytes=await files(f.root);assert.equal(before.version,19);
 // close() also runs on an unexpected success, so a failing refusal oracle
 // cannot leave a historical writer owning the fixture root.
 await assert.rejects(async()=>{const unexpected=await openPriorWriter({root:f.root});try{assert.fail('Prior reader accepted unsupported SplitTextDraft history');}finally{await unexpected.close();}},{code:'CORRUPT_STORE'});
 assert.deepEqual(inspect(f.root),before);assert.deepEqual(await files(f.root),bytes);
 const {openWriter}=await import('../../dist/local/server/storage/writer.js'),current=await openWriter({root:f.root});try{assert.deepEqual(await current.document(documentId),accepted.document);assert.deepEqual(await current.imageState(documentId),accepted.image);assert.equal((await current.commandState(accepted.request.command.commandId)).record.receipt.status,'accepted');}finally{await current.close();}
 t.diagnostic(JSON.stringify({kind:'split-history-prior-reader-1',priorExecutable:'8901d923f309125c5bc19605efe76a871a7ee1df',storageVersion:19,baselineOpened:true,refusal:'CORRUPT_STORE',tablesAndRetainedFilesUnchanged:true}));
});
