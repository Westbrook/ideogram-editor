import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
import {EventEmitter,getEventListeners} from 'node:events';
import {exchange} from '../session/helpers.mjs';
import {readFile,writeFile,rename,cp} from 'node:fs/promises';
import {terminalWithDiagnostics} from './native-failure-diagnostics.mjs';
import {createNativeMemoryRecorder,nativeMemoryPhases as memoryPhase} from './native-memory-diagnostics.mjs';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {rootFor,command,pair,call,cookieFrom,readHeaders,mutationHeaders} from '../protocol/helpers.mjs';
import {importRaster,operate,terminal} from '../raster/helpers.mjs';
import {upload,copy,preview as previewCopy} from '../portable/helpers.mjs';
import {unpack,pack,records,encoded} from '../portable/archive-fixture.mjs';
import {providerChild} from './candidate-copy-process-helpers.mjs';
import {nativeDeferredChild} from './native-deferred-process-helpers.mjs';
import {probeMax12Refusal} from '../portable/max12-refusal.mjs';
import {openWriter} from '../../dist/local/server/storage/writer.js';
import {EMPTY_EXPECTED_VERSIONS} from '../../dist/local/src/protocol/store.js';
import {newDraft,bindRequestMask,confirmRequestMask,requestMaskDependencies} from '../../dist/local/src/request/core.js';
import {createRequestRasterPlan} from '../../dist/local/src/request/raster-plan.js';
import {canonical} from '../../dist/local/server/storage/canonical.js';
import {verificationBudget} from '../../dist/local/src/protocol/text-budget.js';
import {emptyComposition} from '../../dist/local/src/composition/core.js';
import {planTextTreatment,bindTextTreatmentEnvelope} from '../../dist/local/src/request/text-treatment.js';
import {candidatePlacementReview} from '../../dist/local/src/protocol/candidate-placement-review.js';
import {ENCODED_COMPOSITION_BYTES,validateEncodedCompositionInputs} from '../../dist/local/src/protocol/encoded-rebuild.js';

// Actual HTTP, queue, native verification worker, CP1 captures, mask preparation,
// previews and history writer. Only the provider boundary is the existing local
// observer fixture. The worker bootstrap below observes the genuine renderer's
// nontransparent RGBA output; the unchanged server verifier then verifies it.
const documentId='document_1',sessionId='native_deferred_adoption';
// One file-owned ring retains the preceding fixture's close alongside the next
// fixture's start. It never retains fixture objects or rendered byte payloads.
const mainMemory=createNativeMemoryRecorder(1);let memoryFixtureSequence=0;
after(()=>mainMemory.close());
function memoryBaseline(f,value){const fixture=f.memoryFixture;return {...value,memoryFixture:fixture,get memoryTransitions(){return mainMemory.snapshot();}};}
const document=async(f,id=documentId)=>(await f.read('/api/v1/documents/'+id)).json.projection.value;
const image=async(f,id=documentId)=>(await f.read('/api/v1/documents/'+id+'/image')).json;
const objectPath=(f,ref)=>join(f.root,'objects','sha256',ref.hash.slice(7,9),ref.hash.slice(7));
const sha=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
async function retained(f,ref){const bytes=await readFile(objectPath(f,ref));assert.equal(sha(bytes),ref.hash);assert.equal(String(bytes.length),ref.byteLength);return bytes;}
async function asset(f,id){const response=await f.read('/api/v1/assets/'+id);assert.equal(response.status,200,response.text);return response.json.projection.value;}
async function pixels(f,id){return retained(f,(await asset(f,id)).raster.pixels);}
async function events(f,receipt){
 // The original accepted transaction remains readable after the live cursor
 // compacts. Use its public receipt-bound lease, preserving every event row.
 const response=await f.read('/api/v1/commands/'+receipt.commandId+'/result');assert.equal(response.status,200,response.text);
 const recovery=response.json.recovery,recoveryId=recovery?.recoveryId;assert.equal(typeof recoveryId,'string');
 try{
  const page=response.json;assert.equal(page.protocolVersion,1);assert.equal(page.kind,'batches');assert.equal(page.batches.length,1);assert.equal(page.more,false);assert.equal(page.nextCursor,receipt.toSeq);assert.equal(recovery.highWater,receipt.toSeq);
  const batch=page.batches[0];assert.equal(batch.transactionId,receipt.transactionId);assert.equal(batch.fromSeq,receipt.fromSeq);assert.equal(batch.toSeq,receipt.toSeq);
  let result;
  if(batch.kind==='inline')result=batch.events;
  else {assert.equal(batch.kind,'transaction-ref');const content=await f.read(batch.content.url);assert.equal(content.status,200,content.text);assert.equal(sha(content.text),batch.content.blob.hash);assert.equal(String(Buffer.byteLength(content.text)),batch.content.blob.byteLength);result=content.text.split('\n').filter(Boolean).map(line=>JSON.parse(line));assert.equal(String(result.length),batch.eventCount);assert.equal(batch.content.recordCount,batch.eventCount);}
  assert.equal(BigInt(result.length),BigInt(receipt.toSeq)-BigInt(receipt.fromSeq)+1n);for(const [index,event] of result.entries()){assert.equal(event.transactionId,receipt.transactionId);assert.equal(event.commandId,receipt.commandId);assert.equal(BigInt(event.workspaceSeq),BigInt(receipt.fromSeq)+BigInt(index));}
  const proof=await f.read('/api/v1/events?after='+receipt.toSeq+'&recoveryId='+recoveryId);assert.equal(proof.status,200,proof.text);assert.equal(proof.json.protocolVersion,1);assert.equal(proof.json.kind,'batches');assert.equal(proof.json.more,false);assert.equal(proof.json.nextCursor,receipt.toSeq);assert.deepEqual(proof.json.batches,[]);
  for(const key of ['recoveryId','writerEpoch','projectionSchema','highWater'])assert.equal(proof.json.recovery[key],recovery[key]);
  return result;
 }finally{const released=await f.post('/api/v1/recovery/'+recoveryId+'/release',{protocolVersion:1});assert.equal(released.status,204,released.text);}
}
async function run(f,body){
 const before=await document(f),request=f.command({documentId,expectedDocumentRevision:before.revision,body}),result=await terminal(f,request);
 assert.equal(result.json.receipt.status,'accepted',result.text);return {request,receipt:result.json.receipt,events:await events(f,result.json.receipt),document:await document(f)};
}
async function properties(f,id,value){const l=(await image(f)).layers.find(l=>l.id===id);return run(f,{type:'SetLayerProperties',layerId:id,layerVersion:l.version,properties:value,draft:null});}
async function stage(f,bytes,purpose='caption',mediaType='text/plain'){
 const staged=await upload(f,bytes,purpose,mediaType);return (await operate(f,{type:'FinalizeStaging',stagingId:staged.stagingId,expectedSha256:staged.sha256})).event.payload.asset;
}
async function stageOwned(f,bytes,purpose='text',mediaType='application/octet-stream'){
 const staged=await upload(f,bytes,purpose,mediaType),request=f.command({documentId:null,expectedDocumentRevision:null,body:{type:'FinalizeStaging',stagingId:staged.stagingId,expectedSha256:staged.sha256}}),result=await terminal(f,request);
 assert.equal(result.json.receipt.status,'accepted',result.text);const facts=await events(f,result.json.receipt);assert.equal(facts.length,1);assert.equal(facts[0].type,'AssetRegistered');return facts[0].payload.asset;
}
async function ui(f,body){
 const current=(await f.read('/api/v1/ui/'+sessionId)).json,request={protocolVersion:1,requestId:randomUUID(),sessionId,expectedUISeq:current.uiSeq,body};
 const result=await f.post('/api/v1/ui/'+sessionId,request);assert.equal(result.json.status,'accepted',result.text);return {request,value:result.json};
}
// Publish the existing frozen test clock before the child's next public request.
// Atomic rename gives every Sessions/ProtocolRoutes read one complete value.
async function syncNativeClock(root,now){
 if(!Number.isSafeInteger(now)||now<0)throw Error('NATIVE_FIXTURE_CLOCK');
 const path=join(root,'native-fixture-clock.json');
 await writeFile(path+'.tmp',JSON.stringify({now}),{flag:'wx',mode:0o600});
 await rename(path+'.tmp',path);
}
async function fixture(t,{encoded=false,failure=false,now,bounds=false,actualSize=512,acceptanceWait}={}){
 const memoryFixture=++memoryFixtureSequence;mainMemory.sample(memoryFixture,memoryPhase.fixtureOpen);
 let close;t.after(async()=>{mainMemory.sample(memoryFixture,memoryPhase.fixtureCloseBefore);try{await close?.();mainMemory.sample(memoryFixture,memoryPhase.fixtureCloseAfter,-1,1);}catch(error){mainMemory.sample(memoryFixture,memoryPhase.fixtureCloseAfter,-1,2);throw error;}});const root=await rootFor(t);
 if(actualSize!==512){assert.equal(actualSize,256);assert(!now&&!bounds);await writeFile(join(root,'text-treatment-result-size'),String(actualSize),{flag:'wx',mode:0o600});}
 await writeFile(join(root,'j19-memory-enabled'),'1',{flag:'wx',mode:0o600});
 let server;
 if(encoded||now||bounds){
  if(encoded)await writeFile(join(root,'encoded-guard-config.json'),JSON.stringify({failure,hold:false}),{flag:'wx',mode:0o600});
  // Keep the browser stand-in renderer in this driver and the real backend in
  // its existing child-process resource domain, as in ordinary fixtures.
  if(now)await syncNativeClock(root,now());
  await writeFile(join(root,'native-fixture-config.json'),JSON.stringify({version:1,encoded,bounds,clock:Boolean(now)}),{flag:'wx',mode:0o600});
  server=await nativeDeferredChild(root,owned=>{close=owned;});
 }else server=await providerChild(root,owned=>{close=owned;},new URL('./text-treatment-process-fixture.mjs',import.meta.url));
 mainMemory.sample(memoryFixture,memoryPhase.serverReady);
 const paired=await pair(server);assert.equal(paired.status,200,paired.text);
 const f={root,server,paired,memoryFixture,...(acceptanceWait?{acceptanceWait}:{}),...(now?{syncClock:()=>syncNativeClock(root,now())}:{}),read:path=>call(server.origin,path,{headers:readHeaders(cookieFrom(paired))}),post:(path,body)=>call(server.origin,path,{method:'POST',body,headers:mutationHeaders(server,paired)}),command:(patch={},body={})=>command(EMPTY_EXPECTED_VERSIONS,{clientId:paired.json.clientId,...patch},body),effects:async()=>{const value=JSON.parse(await readFile(join(root,'request-edits-fixture.json'),'utf8'));assert.deepEqual(value.errors,[]);return value.effects;}};
 f.reopen=async()=>{assert(!encoded&&!now&&!bounds);await close();const reopened=await providerChild(root,owned=>{close=owned;},new URL('./text-treatment-process-fixture.mjs',import.meta.url)),newPair=await pair(reopened);assert.equal(newPair.status,200,newPair.text);return clientFor({...f,server:reopened},newPair);};
 assert.equal((await terminal(f,f.command({},{width:512,height:512}))).json.receipt.status,'accepted');
 const background=(await importRaster(f,'black.png')).asset;
 await run(f,{type:'ImportAsset',assetId:background.id,layerId:'background',name:'Original background',draft:null});
 await run(f,{type:'ApplyTransform',layerId:'background',layerVersion:'1',transform:[512,0,0,512,0,0],draft:null});
 mainMemory.sample(memoryFixture,memoryPhase.baseRasterReady);
 await addNativeText(f);
 await run(f,{type:'ApplyTransform',layerId:'native_text',layerVersion:'1',transform:[1,0,0,1,8,12],draft:null});
 const mask=(await operate(f,{type:'PrepareMask',plan:{width:512,height:512,feather:0,operations:[{kind:'shape',shape:{kind:'rectangle',x:4,y:4,width:64,height:32},mode:'replace'}]}})).event.payload.asset;
 await properties(f,'native_text',{opacity:0.625,mask:{assetId:mask.id,mapping:'document-r16-v1',inverted:false}});
 const native=(await image(f)).layers.find(l=>l.id==='native_text');
 await run(f,{type:'SetLayerAppearance',layerId:native.id,layerVersion:native.version,description:'Authored local font, frame and document mask',draft:null});
 const hidden=(await importRaster(f,'white.png')).asset;
 await run(f,{type:'ImportAsset',assetId:hidden.id,layerId:'hidden_picture',name:'Hidden locked reference',draft:null});
 await properties(f,'hidden_picture',{visible:false,locked:true,opacity:0.375});
 return f;
}

async function nativeLayout(request,fonts,memoryFixture){
  return new Promise((resolve,reject)=>{
    // Preserve the production worker, CanvasKit startup, fonts and prepareText.
    // Only copy the renderer-created RGBA Blob input for fixture staging. The
    // observer supplies no expected hash and changes no bytes or render calls.
    const bootstrap=`
      const {parentPort,workerData,threadId}=require('node:worker_threads');
      const memorySample=()=>{try{const m=process.memoryUsage();return [process.pid,threadId,performance.timeOrigin,performance.now(),m.rss,m.heapTotal,m.heapUsed,m.external,m.arrayBuffers];}catch{return null;}};
      if(workerData.request.frame.width!==16||workerData.request.frame.height!==16)throw Error('FIXTURE_RGBA_BOUND');
      const NativeBlob=globalThis.Blob,send=parentPort.postMessage.bind(parentPort);
      let rgba;
      globalThis.Blob=new Proxy(NativeBlob,{
        construct(target,args,newTarget){
          const value=Reflect.construct(target,args,newTarget),[parts,options]=args;
          if(options?.type==='application/octet-stream'&&value.size===workerData.request.frame.width*workerData.request.frame.height*4){
            if(rgba)throw Error('DUPLICATE_RENDERER_RGBA');
            if(parts.length!==1||!ArrayBuffer.isView(parts[0]))throw Error('RENDERER_RGBA_SHAPE');
            rgba=Buffer.from(new Uint8Array(parts[0].buffer,parts[0].byteOffset,parts[0].byteLength));
          }
          return value;
        }
      });
      parentPort.postMessage=(value,...args)=>send(value?.type==='result'?{...value,rgba,j19Memory:memorySample()}:{...value,j19Memory:memorySample()},...args);
      import(workerData.moduleURL).catch(error=>{send({type:'failure',message:String(error)});parentPort.close();});
    `;
    const worker=new Worker(bootstrap,{eval:true,workerData:{request,fonts,moduleURL:new URL('../../dist/local/server/text/render-worker.mjs',import.meta.url).href},env:{},resourceLimits:{maxOldGenerationSizeMb:32,maxYoungGenerationSizeMb:8}});
    const workerId=worker.threadId;mainMemory.sample(memoryFixture,memoryPhase.rendererCreate,workerId);
    let result,error;const timer=setTimeout(()=>{error=Error('Native treatment fixture render deadline');void worker.terminate();},20000);
    worker.on('message',message=>{
      if(message.type==='ready'||message.type==='result')mainMemory.remote(memoryFixture,message.type==='ready'?memoryPhase.rendererReady:memoryPhase.rendererResult,message.j19Memory,workerId);
      delete message.j19Memory;
      if(message.type==='ready')worker.postMessage({type:'admit'});else if(message.type==='result')result=message;else error=Error(JSON.stringify(message));
    });
    worker.on('error',value=>{error=value;});worker.on('exit',code=>{mainMemory.sample(memoryFixture,memoryPhase.rendererExit,workerId,code);clearTimeout(timer);if(error)reject(error);else if(code||!result)reject(Error('Native treatment fixture did not render'));else resolve(result);});
  });
}
async function addNativeText(f,{textValue='A',layerVersion='0'}={}){
  const profileBytes=await readFile('src/text/profile.json'),profile=JSON.parse(profileBytes),fontProfile=profile.fonts.find(font=>font.id==='NotoSans');
  const source=await stage(f,await readFile('vendor/text/'+fontProfile.file),'font','application/octet-stream'),license=await stage(f,await readFile('vendor/text/'+fontProfile.licenseFile));
  mainMemory.sample(f.memoryFixture,memoryPhase.fontImportBefore);
  const font=(await run(f,{type:'ImportFont',source:source.blob,license:license.blob,origin:'bundled',embeddingReviewed:true})).events[0].payload.asset.font;
  mainMemory.sample(f.memoryFixture,memoryPhase.fontImportAfter);
  const current=await document(f),frame={width:16,height:16},style={primaryFont:font.bytes.hash,explicitFallbacks:[],sizePx:8,lineHeightMultiplier:1.2,fill:[40,90,190,255],align:'start',direction:'auto'},draftId=layerVersion==='0'?'native':'native_edit_'+randomUUID();
  const token={documentId,documentRevision:current.revision,layerId:'native_text',layerVersion,sessionId,generation:1};
  const rendered=await nativeLayout({text:textValue,style,frame,token},[{path:objectPath(f,font.bytes),length:Number(font.bytes.byteLength),hash:font.bytes.hash,origin:font.origin,licenseHash:font.licenseRecord.hash}],f.memoryFixture);
  const put=async bytes=>(await stage(f,bytes,'text','application/octet-stream')).blob,identify=value=>({...value,id:sha(canonical(value))});
  const rgba=Buffer.from(rendered.rgba);assert.equal(rgba.length,frame.width*frame.height*4);assert.equal(sha(rgba),rendered.rasterHash);assert(rgba.some((value,index)=>index%4===3&&value>0),'The actual native renderer must produce visible glyph coverage');
  const textUtf8=(await stage(f,Buffer.from(textValue))).blob,layout={...await put(Buffer.from(rendered.layout)),mediaType:'application/json'},pixels={...await put(rgba),mediaType:'application/x-ideogram-rgba8'};
  assert.equal(rendered.rasterHash,pixels.hash);assert.equal(rendered.layoutHash,layout.hash);assert.equal(rendered.textHash,textUtf8.hash);
  const manifest={...await put(profileBytes),mediaType:'application/json'},text=identify({schemaVersion:1,textUtf8,style,frame,layoutPolicy:'text-layout-1',fonts:[font]});
  const dependencyHash=sha(JSON.stringify({rendererProfile:profile.id,textHash:textUtf8.hash,style,frame,fonts:[{hash:font.bytes.hash,licenseHash:font.licenseRecord.hash,faceIndex:0,format:font.format,parserProfile:font.parserProfile,fsType:font.fsType}]}));
  const render=identify({schemaVersion:1,textVersion:text.id,rendererProfile:{schemaVersion:1,id:profile.id,manifest},dependencyHash,layout,pixels,width:rendered.width,height:rendered.height,overflow:rendered.overflow,resolvedFonts:[font.id]});
  const candidate={...await put(Buffer.from(canonical({schemaVersion:1,token,source:{schemaVersion:1,text,render}}))),mediaType:'application/json'},draft=await stage(f,Buffer.from(canonical({schemaVersion:1,kind:'text-draft-1',textUtf8,style,frame,fonts:[font]})));
  await ui(f,{type:'SaveDraft',draft:{id:draftId,generation:'1',kind:'text',documentId,targetLayerId:layerVersion==='0'?null:'native_text',expectedDocumentRevision:current.revision,assetId:draft.id,composing:false}});
  const budget=verificationBudget(textValue,frame.width,frame.height,Number(font.bytes.byteLength),profile.engine.wasm.bytes),admissionId=randomUUID()+'_1_'+budget.bytes;
  mainMemory.sample(f.memoryFixture,memoryPhase.stagingComplete);mainMemory.sample(f.memoryFixture,memoryPhase.admissionBefore);
  assert.equal((await f.post('/api/v1/text-admission/'+admissionId,{protocolVersion:1})).status,200);
  mainMemory.sample(f.memoryFixture,memoryPhase.admissionAfter);
  try{
   const common={layerId:'native_text',candidate,draft:{sessionId,draftId,generation:'1'},admissionId},body=layerVersion==='0'?{type:'CreateTextLayer',...common,name:'Authored native lettering'}:{type:'CommitTextEdit',...common,layerVersion,reviewedDependencyHash:dependencyHash};
   const request=f.command({sessionId,documentId,expectedDocumentRevision:current.revision,body}),result=await terminalWithDiagnostics(f,request,memoryBaseline(f,{documentId,documentRevision:current.revision,layerId:'native_text',generation:'1',admissionId,admissionBudgetBytes:budget.bytes,rendererProfile:profile.id,frame}));
   assert.equal(result.json.receipt.status,'accepted',result.text);
  }finally{mainMemory.sample(f.memoryFixture,memoryPhase.admissionReleaseBefore);assert.equal((await f.post('/api/v1/text-admission/'+admissionId+'/release',{protocolVersion:1})).status,200);mainMemory.sample(f.memoryFixture,memoryPhase.admissionReleaseAfter);}
  const layer=(await image(f)).layers.find(layer=>layer.id==='native_text');assert.equal(layer.kind,'text');return layer;
}

async function ninetyNineNativeAssets(f){
 await properties(f,'hidden_picture',{locked:false});
 for(const layerId of ['background','hidden_picture']){const layer=(await image(f)).layers.find(row=>row.id===layerId);await run(f,{type:'DeleteLayer',layerId,layerVersion:layer.version,draft:null});}
 const original=(await image(f)).layers[0],source=JSON.parse(await retained(f,original.source)),textValue=(await retained(f,source.text.textUtf8)).toString('utf8'),profile=JSON.parse(await retained(f,source.render.rendererProfile.manifest));
 assert.equal(original.kind,'text');assert.equal(source.render.width,16);assert.equal(source.render.height,16);assert.equal(sha(await retained(f,source.render.pixels)),source.render.pixels.hash);
 const {textUtf8,style,frame,fonts}=source.text,draft=await stage(f,Buffer.from(canonical({schemaVersion:1,kind:'text-draft-1',textUtf8,style,frame,fonts}))),budget=verificationBudget(textValue,frame.width,frame.height,fonts.reduce((n,font)=>n+Number(font.bytes.byteLength),0),profile.engine.wasm.bytes);
 assert.equal(draft.qualification,'opaque-text','SaveDraft requires the same durable opaque draft asset used by ordinary native creation');
 let revision=(await document(f)).revision;const assetIds=new Set([original.assetId]);
 for(let index=1;index<99;index++){
  const layerId=('native_'+String(index).padStart(3,'0')+'_').padEnd(128,'n'),draftId='native_repeated',generation=String(index),token={documentId,documentRevision:revision,layerId,layerVersion:'0',sessionId,generation:index},candidate={...(await stageOwned(f,Buffer.from(canonical({schemaVersion:1,token,source})))).blob,mediaType:'application/json'};
  await ui(f,{type:'SaveDraft',draft:{id:draftId,generation,kind:'text',documentId,targetLayerId:null,expectedDocumentRevision:revision,assetId:draft.id,composing:false}});
  const admissionId=randomUUID()+'_'+generation+'_'+budget.bytes;assert.equal((await f.post('/api/v1/text-admission/'+admissionId,{protocolVersion:1})).status,200);
  try{
   // Reuse the genuine immutable renderer outputs, never a guessed hash or a
   // copied raster asset. Each new token is checked by the real native worker.
   const request=f.command({sessionId,documentId,expectedDocumentRevision:revision,body:{type:'CreateTextLayer',layerId,candidate,draft:{sessionId,draftId,generation},admissionId,name:'A'}}),result=await terminalWithDiagnostics(f,request,memoryBaseline(f,{documentId,documentRevision:revision,layerId,generation,admissionId,admissionBudgetBytes:budget.bytes,rendererProfile:profile.id,frame}));
   assert.equal(result.json.receipt.status,'accepted',result.text);const facts=await events(f,result.json.receipt);assert.equal(facts.at(-1).type,'ImageEdited');
   const state=JSON.parse(await retained(f,facts.at(-1).payload.history.after.state)),layer=state.layers.find(row=>row.id===layerId);assert(layer);assert.equal(layer.kind,'text');assert.deepEqual(layer.source,original.source);assert(!assetIds.has(layer.assetId),'CreateTextLayer must retain a distinct native raster asset for each actual verification');assetIds.add(layer.assetId);
   revision=result.json.receipt.documentRevision;
  }finally{mainMemory.sample(f.memoryFixture,memoryPhase.admissionReleaseBefore);assert.equal((await f.post('/api/v1/text-admission/'+admissionId+'/release',{protocolVersion:1})).status,200);mainMemory.sample(f.memoryFixture,memoryPhase.admissionReleaseAfter);}
 }
 const state=await image(f);assert.equal(state.layers.length,99);assert.equal(assetIds.size,99);assert(state.layers.every(layer=>layer.kind==='text'&&layer.visible));assert.equal((await document(f)).revision,revision);return state;
}


async function capture(f,scope,layerIds=[]){
 const before=await document(f),result=await run(f,{type:'PrepareRequestSource',scope,layerIds}),captured=result.events[0].payload.asset;
 assert.deepEqual(await document(f),before);assert.equal(result.events.length,1);
 const manifest=(await f.read('/api/v1/assets/'+captured.id+'/raster')).json;
 assert.deepEqual(manifest.plan.capture.image,before.image);
 return {asset:captured,manifest,source:{assetId:captured.id,version:captured.version,blob:captured.blob,pixels:captured.raster.pixels,width:512,height:512,scope,documentRevision:before.revision,capture:captured.raster.manifest}};
}
async function candidate(f,{kind='native-overlay',placement='current-document',mapped=false,cropSize=384,maskRect={x:128,y:128,width:8,height:8}}={}){
 const before=await document(f),beforeState=await image(f),nativeIds=beforeState.layers.filter(l=>l.kind==='text'&&l.visible).map(l=>l.id),baseline=await capture(f,'visible-document');
 const selected=kind==='native-overlay'?await capture(f,'single-layer',['background']):baseline,source=selected.source;
 const maskAsset=(await operate(f,{type:'PrepareRequestMask',sourceAssetId:source.assetId,plan:{width:512,height:512,feather:0,operations:[{kind:'shape',shape:{kind:'rectangle',...maskRect},mode:'replace'}]},clip:null})).event.payload.asset;
 const manifest=(await f.read('/api/v1/assets/'+maskAsset.id+'/raster')).json;
 const mask={assetId:maskAsset.id,version:maskAsset.version,blob:maskAsset.blob,pixels:maskAsset.raster.pixels,width:512,height:512,sourceHash:source.pixels.hash,polarity:'white-edit',fullAcknowledged:false,empty:false,full:false,plan:maskAsset.raster.manifest,binding:bindRequestMask(source)};
 mask.requestPlan=confirmRequestMask(source,mask,manifest.plan.hard,manifest.plan.effective,randomUUID());
 if(mapped)mask.requestPlan=createRequestRasterPlan({document:{width:512,height:512},crop:{x:0,y:0,width:cropSize,height:cropSize},padding:{left:0,top:0,right:0,bottom:0},requestGrid:{width:512,height:512},sourcePixels:source.pixels,authoredMask:manifest.plan.hard,effectiveMask:manifest.plan.effective,dependenciesHash:requestMaskDependencies(source,mask),resolution:'already-contained',approvalId:randomUUID()});
 const prompt=await stage(f,Buffer.from('Change the selected background and preserve explicitly reviewed native lettering')),draft=newDraft(prompt.blob);
 draft.operation='inpaint';Object.assign(draft.fields,{size:mapped?'custom':'auto',width:'512',height:'512',strength:'1'});draft.source=source;draft.mask=mask;
 const saved=await stage(f,Buffer.from(JSON.stringify(draft))),choice=kind==='native-overlay'?{kind,retainedNativeIds:nativeIds,placement,excludedSemanticIds:[],approvalId:randomUUID()}:{kind,allowedHideNativeIds:nativeIds,duplicationAcknowledgement:randomUUID(),excludedSemanticIds:[],approvalId:randomUUID()};
 await ui(f,{type:'SaveDraft',draft:{id:'request',generation:'1',kind:'request',documentId,targetLayerId:null,expectedDocumentRevision:before.revision,assetId:saved.id,composing:false}});
 const review=(await ui(f,{type:'PrepareRequestReview',draftId:'request',generation:'1',textTreatment:{kind:'text-treatment-review-intent-1',choice,baseline:baseline.source,beforeSource:baseline.source}})).value.review;
 assert.equal(review.kind,'request-review-text-1');const plan=JSON.parse(await retained(f,review.textTreatment.plan));
 assert.deepEqual(plan.inventory.imageState,before.image.state);assert.deepEqual(plan.beforeSource.source,baseline.source);assert.deepEqual(plan.afterSource.source,source);
 const accepted=await ui(f,{type:'AcceptRequestReview',reviewId:review.id,token:review.token}),queued=await operate(f,{type:'QueueInference',reviewId:review.id,token:review.token,acceptanceId:accepted.request.requestId}),jobId=queued.event.payload.id;
 let value;const deadline=Date.now()+20000;
 do{const response=await f.read('/api/v1/jobs/'+jobId+'/candidates');if(response.status===200)value=response.json.items[0];if(value?.state==='prepared')break;await new Promise(resolve=>setTimeout(resolve,25));}while(Date.now()<deadline);
 assert.equal(value?.state,'prepared',JSON.stringify(value));assert.deepEqual(await document(f),before);
 return {value,draft,review,plan,baseline,selected,before,beforeState,saved,nativeIds};
}

function placement(c,choicePatch={},bodyPatch={}){
 const choice={kind:'text-treatment-adoption-choice-1',action:'keep-native-overlay',approvalId:randomUUID(),duplicationAcknowledgement:null,newLayerId:'generated',hideNativeIds:[],nativeCopies:[],preservation:'single-original-contribution',...choicePatch};
 return {type:'ReviewCandidatePlacement',candidateId:c.value.id,mode:'safe-region',placement:'current-document',newDocumentId:null,actualOutput:null,newLayerId:choice.newLayerId,name:'Deferred native placement',textTreatment:{kind:'candidate-text-treatment-1',plan:c.review.textTreatment,choice},...bodyPatch};
}
const adoption=review=>({type:'AdoptReviewedCandidate',reviewId:review.reviewId,reviewHash:review.reviewHash,draft:null});
// HTTP has no complete asset inventory. A read-only snapshot also detects
// invisible eager Q, wrapper, composite, preview and history registration.
function inventory(f){
 const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});
 try{return Object.fromEntries(['assets','image_previews','history'].map(table=>[table,db.prepare('SELECT id,json FROM '+table+' ORDER BY id').all()]));}finally{db.close();}
}
function eventInventory(f){const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});try{return db.prepare('SELECT json FROM events_v2 ORDER BY seq').all();}finally{db.close();}}
async function reviewed(f,body,{candidateTransform=[1,0,0,1,0,0],rawCandidateEqualsComparison=true}={}){
 const before=await document(f),beforeState=await image(f),cold=inventory(f),prepared=await run(f,body);
 assert.deepEqual(prepared.events.map(event=>event.type),['AssetRegistered','AssetRegistered','AssetRegistered','CandidatePlacementReviewPrepared']);
 for(const event of prepared.events)assert.equal(event.transactionId,prepared.request.command.transactionId);
 assert.deepEqual(await document(f),before);assert.deepEqual(await image(f),beforeState);assert.equal(prepared.receipt.documentRevision,before.revision);
 const identity=prepared.events.at(-1).payload,response=await f.read('/api/v1/image-edit-reviews/'+identity.reviewId);assert.equal(response.status,200,response.text);
 assert(Buffer.byteLength(response.text)<=65536,'The actual public review response must fit the unchanged HTTP control bound');assert.doesNotThrow(()=>candidatePlacementReview(response.json));
 const review=response.json,{type,preparation,...expectedPlacement}=body,{reviewHash,...content}=review;
 assert.equal(review.kind,'candidate-placement-review-1');assert.equal(reviewHash,sha(canonical(content)));assert.deepEqual(identity,{reviewId:review.reviewId,reviewHash});
 assert.deepEqual(review.placement,expectedPlacement);assert.equal(review.targetClientId,f.paired.json.clientId);assert.equal(review.documentId,before.id);assert.equal(review.documentRevision,before.revision);assert.deepEqual(review.source,before.image);
 assert.equal(review.width,512);assert.equal(review.height,512);assert.equal('preview' in review,false);
 if(body.mode==='safe-region')assert.equal(review.preparation,'deferred');
 const lettering=review.lettering;assert.equal(lettering.kind,'candidate-lettering-comparison-1');assert.deepEqual(lettering.plan,body.textTreatment.plan);assert.deepEqual(lettering.choice,body.textTreatment.choice);assert.equal(lettering.intentHash,lettering.intent.hash);assert.deepEqual(lettering.grid,{width:512,height:512});
 const intent=JSON.parse(await retained(f,lettering.intent)),manifest=JSON.parse(await retained(f,lettering.manifest));
 assert.equal(intent.kind,'candidate-lettering-intent-1');assert.equal(intent.documentId,before.id);assert.equal(intent.documentRevision,before.revision);assert.deepEqual(intent.source,before.image);assert.deepEqual(intent.placement,expectedPlacement);assert.deepEqual(intent.identity,review.inputs.identity);assert.deepEqual(intent.requestPlan,review.inputs.plan);
 assert.equal(intent.decision.kind,body.actualOutput?.clipMask?'text-treatment-successor-placement-intent-1':'text-treatment-placement-intent-1');assert.equal(intent.decision.requestedPreservation,body.textTreatment.choice.preservation);assert.equal('preservedExterior' in intent.decision,false);
 assert.deepEqual(Object.keys(intent.decision.candidate).sort(),['candidateId','effectiveMask','grid','preparation','sourcePixels']);
 assert.equal(intent.decision.candidate.candidateId,body.candidateId);assert.deepEqual(intent.decision.candidate.grid,{width:512,height:512});assert.equal(intent.decision.candidate.preparation,body.mode);
 assert.deepEqual(intent.decision.candidate.sourcePixels,body.mode==='safe-region'?review.inputs.plan.sourcePixels:null);assert.deepEqual(intent.decision.candidate.effectiveMask,body.mode==='safe-region'?(review.inputs.outputMapping?.effectiveMask??review.inputs.plan.effectiveMask):null);
 assert.equal(manifest.kind,'candidate-lettering-comparison-manifest-1');assert.deepEqual(manifest.intent,lettering.intent);assert.deepEqual(manifest.grid,lettering.grid);assert.equal(manifest.preservation,'not-applied');
 const ids=[lettering.candidateAloneAssetId,lettering.nativeOffAssetId,lettering.nativeOnAssetId];assert.equal(new Set(ids).size,3);
 assert.deepEqual(prepared.events.slice(0,3).map(event=>event.payload.asset.id),ids);
 const hot=inventory(f),added=hot.assets.filter(row=>!cold.assets.some(before=>before.id===row.id));
 assert.deepEqual(added.map(row=>row.id).sort(),[...ids].sort(),'Review registers only its three bounded comparisons, never a full prepared Q or wrapper');
 assert.deepEqual(hot.assets.filter(row=>cold.assets.some(before=>before.id===row.id)),cold.assets);assert.deepEqual(hot.image_previews,cold.image_previews);assert.deepEqual(hot.history,cold.history);
 const nativeIds=new Set(body.placement==='new-document'?body.textTreatment.choice.nativeCopies.map(copy=>copy.newLayerId):beforeState.layers.filter(layer=>layer.kind==='text'&&layer.visible).map(layer=>layer.id));
 const candidateLayer={assetId:review.inputs.identity.preparedAssetId,transform:candidateTransform,opacity:1,mask:null};
 const variant=visible=>intent.after.layers.filter(layer=>nativeIds.has(layer.id)?visible:layer.visible).map(layer=>({assetId:layer.assetId,transform:layer.id===body.newLayerId?candidateTransform:layer.layerToDocument,opacity:layer.opacity,mask:layer.mask}));
 for(const [index,comparison]of ['candidate-alone','native-off','native-on'].entries()){
  const registered=await asset(f,ids[index]),raster=JSON.parse(await retained(f,registered.raster.manifest)),encoded=await retained(f,registered.blob),rgba=await retained(f,registered.raster.pixels);
  assert.equal(registered.qualification,'canonical-png');assert.equal(registered.raster.role,'export');assert(registered.raster.width<=1024&&registered.raster.height<=1024);assert.equal(rgba.length,registered.raster.width*registered.raster.height*4);assert.deepEqual([...encoded.subarray(0,8)],[137,80,78,71,13,10,26,10]);
  assert.equal(raster.plan.kind,'candidate-lettering-comparison-v1');assert.equal(raster.plan.sourceWidth,512);assert.equal(raster.plan.sourceHeight,512);assert.equal(raster.plan.comparison,comparison);assert.equal(raster.plan.preservation,'not-applied');
  assert.deepEqual(raster.plan.layers,index===0?[candidateLayer]:variant(index===2));
  assert.deepEqual(manifest.images[index],{comparison,assetId:registered.id,blob:registered.blob,raster:registered.raster});
 }
 if(rawCandidateEqualsComparison)assert.deepEqual(await pixels(f,lettering.candidateAloneAssetId),await pixels(f,review.inputs.identity.preparedAssetId));
 return {review,intent,manifest,prepared,body:adoption(review),wireBytes:Buffer.byteLength(response.text)};
}
async function visibleDifference(f,review,{x=8,y=12}={}){
 const off=await pixels(f,review.lettering.nativeOffAssetId),on=await pixels(f,review.lettering.nativeOnAssetId);let changed=0;
 for(let at=0;at<off.length;at+=4)if(!off.subarray(at,at+4).equals(on.subarray(at,at+4))){const px=at/4%512,py=Math.floor(at/4/512);assert(px>=x&&px<x+16&&py>=y&&py<y+16,'Native comparison differences must be confined to the real transformed glyph frame');changed++;}
 assert(changed>0,'Turning real nontransparent native lettering on changes actual comparison pixels');
}
async function nativeIdentity(f,layer){
 const native=JSON.parse(await retained(f,layer.source)),raster=await asset(f,layer.assetId),mask=await asset(f,layer.mask.assetId),refs=[layer.source,native.text.textUtf8,native.render.layout,native.render.pixels,raster.raster.manifest,mask.raster.manifest,mask.raster.pixels,...native.text.fonts.flatMap(font=>[font.bytes,font.licenseRecord])];
 return {native,raster,mask,refs,bytes:await Promise.all(refs.map(ref=>retained(f,ref)))};
}
async function unchangedNative(f,layer,identity){
 assert.deepEqual(await asset(f,layer.assetId),identity.raster);assert.deepEqual(await asset(f,layer.mask.assetId),identity.mask);
 for(let at=0;at<identity.refs.length;at++)assert.deepEqual(await retained(f,identity.refs[at]),identity.bytes[at]);
}

async function preservedCandidate(f,wrapper){
 const retainedManifest=JSON.parse(await retained(f,wrapper.raster.manifest));assert.equal(retainedManifest.plan.kind,'retained-candidate-v1');assert.deepEqual(Object.keys(retainedManifest.plan).sort(),['kind','lineage','source']);assert.deepEqual(retainedManifest.dependencies,[retainedManifest.plan.source,retainedManifest.plan.lineage]);
 assert.equal(wrapper.raster.sourceAssetIds.length,1);const source=await asset(f,wrapper.raster.sourceAssetIds[0]);assert.equal(source.qualification,'canonical-raster');assert.deepEqual(source.raster.manifest,retainedManifest.plan.source);assert.deepEqual(wrapper.blob,source.blob);assert.deepEqual(wrapper.raster.pixels,source.raster.pixels);assert.equal(wrapper.raster.pixelIdentity,source.raster.pixelIdentity);
 const manifest=JSON.parse(await retained(f,retainedManifest.plan.source)),lineage=JSON.parse(await retained(f,retainedManifest.plan.lineage));assert.equal(manifest.plan.kind,'request-preservation-v1');assert.equal(lineage.kind,'adopted-candidate-lineage-1');assert.equal(lineage.inert,true);assert.deepEqual(manifest.pixels,wrapper.raster.pixels);
 for(const key of ['width','height','pipeline']){assert.equal(retainedManifest[key],wrapper.raster[key]);assert.equal(manifest[key],wrapper.raster[key]);assert.equal(source.raster[key],wrapper.raster[key]);}
 return {manifest,lineage};
}

function successorWitness(c,choice,identity,mapping,witness){
 assert.equal(mapping.resolution,'clipped-and-approved');
 assert.deepEqual(witness,{kind:'text-treatment-mask-successor-1',acceptedTreatmentPlan:c.review.textTreatment.plan,originalRequestPlan:c.plan.edit.requestPlan,originalEffectiveMask:c.draft.mask.requestPlan.effectiveMask,finalEffectiveMask:mapping.effectiveMask,candidateIdentityHash:sha(canonical(identity)),outputMappingHash:sha(canonical(mapping)),adoptionChoiceHash:sha(canonical(choice))});
}
async function clippedBoundary(f,c,mapping,coverage){
 assert.deepEqual(mapping.outputToDocument,[2,0,0,2,0,0]);assert.deepEqual(mapping.actualOutput,{width:256,height:256});assert.deepEqual(mapping.requestPlan,c.draft.mask.requestPlan);
 assert.deepEqual(coverage,{originalEffectivePixels:64,effectivePixels:56,lostPixels:8});assert.notEqual(mapping.effectiveMask.hash,c.draft.mask.requestPlan.effectiveMask.hash);
 const original=await retained(f,c.draft.mask.requestPlan.effectiveMask),final=await retained(f,mapping.effectiveMask);
 // Independent exact raster oracle: the original leftmost column is now
 // outside reconstruction support. Every other authored cell is unchanged.
 for(let y=0;y<512;y++)for(let x=0;x<512;x++){const offset=(y*512+x)*2,edited=x<8&&y>=128&&y<136;assert.equal(original.readUInt16LE(offset),edited?65535:0);assert.equal(final.readUInt16LE(offset),edited&&x>0?65535:0);}
 return {original,final};
}

function exterior(actual,original,mask){
 let equal=0,changed=0;
 for(let at=0;at<mask.length;at+=2){const offset=at*2;if(mask.readUInt16LE(at)===0){assert(actual.subarray(offset,offset+4).equals(original.subarray(offset,offset+4)),'exterior pixel '+at/2);equal++;}else if(!actual.subarray(offset,offset+4).equals(original.subarray(offset,offset+4)))changed++;}
 assert(equal>250000);assert(changed>0,'The accepted candidate must actually change edited pixels');
}
// Only the actual-output acceptance cases opt in. Their one existing case
// deadline starts before fixture setup and never resets for an HTTP request.
async function acceptanceHTTP(f,path,options,signal,open=exchange){
 signal.throwIfAborted();const {request,response}=open(f.server.origin,path,options),closeOf=stream=>stream.closed?Promise.resolve():new Promise(resolve=>stream.once('close',resolve)),closed=closeOf(request);
 let incoming;const received=value=>{incoming=value;};request.on('response',received);
 const abort=()=>request.destroy(signal.reason);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
 try{return await response;}catch(error){request.destroy(error);throw error;}
 finally{try{await closed;if(incoming)await closeOf(incoming);}finally{request.removeListener('response',received);signal.removeEventListener('abort',abort);}}
}
async function terminalAcceptance(f,request,owner,runtime={}){
 const now=runtime.now??(()=>performance.now()),sleep=runtime.sleep??((ms,signal)=>pause(ms,undefined,{signal})),send=runtime.send??((path,options,signal)=>acceptanceHTTP(f,path,options,signal)),schedule=runtime.schedule??setTimeout,cancel=runtime.cancel??clearTimeout;
 const started=now(),commandId=request.command.commandId,path='/api/v1/commands/'+commandId,controller=new AbortController();let timer,polls=0;
 assert(Number.isFinite(owner.deadline));assert(owner.signal instanceof AbortSignal);
 const expired=()=>Object.assign(new Error('Native acceptance exceeded its existing whole-case deadline'),{code:'NATIVE_ACCEPTANCE_CASE_DEADLINE'});
 const abort=()=>controller.abort(owner.signal.reason),check=()=>{if(owner.signal.aborted)abort();if(now()>=owner.deadline&&!controller.signal.aborted)controller.abort(expired());controller.signal.throwIfAborted();};
 const observed=(point,response)=>owner.observe?.({kind:'native-acceptance-wait-1',point,commandId,polls,elapsedMs:now()-started,...(response.status===202?{operationId:response.json.operationId,phase:response.json.phase}:{receiptStatus:response.json.receipt?.status})});
 owner.signal.addEventListener('abort',abort,{once:true});
 try{
  check();timer=schedule(()=>controller.abort(expired()),owner.deadline-now());
  let response=await send('/api/v1/commands',{method:'POST',body:request,headers:mutationHeaders(f.server,f.paired)},controller.signal);check();
  while(response.status===202){
   assert.equal(response.headers.location,response.json.receiptUrl);assert.equal(response.json.receiptUrl,path);assert.equal(response.json.commandId,commandId);
   if(polls===1000)observed('original-poll-limit',response);
   await sleep(5,controller.signal);check();response=await send(path,{headers:readHeaders(cookieFrom(f.paired))},controller.signal);polls++;check();
  }
  assert.equal(response.status,200,response.text);assert.equal(response.json.receipt.commandId,commandId);observed('terminal',response);return response;
 }finally{if(timer!==undefined)cancel(timer);owner.signal.removeEventListener('abort',abort);}
}
async function accept(f,approved){
 const creating=approved.review.placement.placement==='new-document',id=creating?approved.review.placement.newDocumentId:documentId;
 const request=f.command({documentId:id,expectedDocumentRevision:creating?null:(await document(f)).revision,body:approved.body}),result=await(f.acceptanceWait?terminalAcceptance(f,request,f.acceptanceWait):terminal(f,request));assert.equal(result.json.receipt.status,'accepted',result.text);
 const committed=await events(f,result.json.receipt);assert(committed.length>=3);assert.equal(committed.at(-1).type,creating?'DocumentCreated':'ImageEdited');
 for(const event of committed)assert.equal(event.transactionId,request.command.transactionId);
 assert(committed.slice(0,-1).every(event=>event.type==='AssetRegistered'&&event.documentId===null));assert.equal(committed.at(-1).documentId,id);
 const after=await image(f,id),generated=after.layers.find(layer=>layer.id===approved.review.placement.newLayerId);assert(generated);assert.notEqual(generated.assetId,approved.review.inputs.identity.preparedAssetId);
 assert.deepEqual(after,{...approved.intent.after,layers:approved.intent.after.layers.map(layer=>layer.id===generated.id?{...layer,assetId:generated.assetId}:layer)});
 const wrapper=await asset(f,generated.assetId);assert.equal(wrapper.qualification,'canonical-raster');assert.equal(wrapper.raster.width,512);assert.equal(wrapper.raster.height,512);
 assert(committed.some(event=>event.type==='AssetRegistered'&&event.payload.asset.id===generated.assetId));
 const current=await document(f,id);assert(committed.some(event=>event.type==='AssetRegistered'&&event.payload.asset.id===current.image.compositeAssetId));
 assert.deepEqual((await terminal(f,request)).json.receipt,result.json.receipt,'Exact acceptance replay cannot run a second preparation');
 return {request,result,receipt:result.json.receipt,events:committed,document:current,after};
}
async function reject(f,body,{code,reason,target=null,client=f,context='rejection'}={}){
 let phase='document-before',request;
 try{
  const before=await document(f);phase='image-before';const beforeState=await image(f);phase='inventory-before';const cold=inventory(f),beforeEvents=eventInventory(f);
  request=client.command({documentId:target??documentId,expectedDocumentRevision:target?null:before.revision,body});phase='terminal';const result=await terminal(client,request);
  phase='receipt';assert.equal(result.json.receipt.status,'rejected',result.text);if(code)assert.equal(result.json.receipt.code,code,result.text);
  if(reason)assert.equal(JSON.parse(await retained(f,result.json.receipt.details)).issues[0].code,reason);
  phase='document-after';assert.deepEqual(await document(f),before);phase='image-after';assert.deepEqual(await image(f),beforeState);phase='inventory-after';assert.deepEqual(inventory(f),cold);assert.deepEqual(eventInventory(f),beforeEvents);if(target){phase='target-absence';assert.equal((await f.read('/api/v1/documents/'+target)).status,404);}
  return {request,result,receipt:result.json.receipt};
 }catch(error){error.message+='\nRejection context: '+JSON.stringify({context,phase,commandId:request?.command.commandId??null,operation:body.type});throw error;}
}

test('deferred native review retains only bounded real comparisons; explicit acceptance prepares Q and commits the original slot atomically',{timeout:180000},async t=>{
 const f=await fixture(t),c=await candidate(f),native=c.beforeState.layers.find(layer=>layer.id==='native_text'),identity=await nativeIdentity(f,native),original=await pixels(f,c.before.image.compositeAssetId),effects=await f.effects();
 const approved=await reviewed(f,placement(c));await visibleDifference(f,approved.review);
 assert.deepEqual(approved.intent.after.layers.map(layer=>[layer.id,layer.visible]),[['background',false],['generated',true],['native_text',true],['hidden_picture',false]]);
 assert.deepEqual(approved.intent.after.layers[0],{...c.beforeState.layers[0],version:String(BigInt(c.beforeState.layers[0].version)+1n),visible:false});assert.deepEqual(approved.intent.after.layers[2],native);assert.deepEqual(approved.intent.after.layers[3],c.beforeState.layers[2]);
 const applied=await accept(f,approved);assert.equal(applied.events.at(-1).payload.history.operation,'AdoptReviewedCandidate');assert.deepEqual(applied.events.at(-1).payload.history.before,c.before.image);
 exterior(await pixels(f,applied.document.image.compositeAssetId),original,await retained(f,c.draft.mask.requestPlan.effectiveMask));await unchangedNative(f,native,identity);
 const undo=await run(f,{type:'Undo',historyHead:applied.document.historyHead});assert.deepEqual(await image(f),c.beforeState);assert.deepEqual(await pixels(f,undo.document.image.compositeAssetId),original);
 await run(f,{type:'Redo',historyNode:applied.document.historyHead});assert.deepEqual(await image(f),applied.after);await unchangedNative(f,native,identity);assert.deepEqual(await f.effects(),effects);
});

test('deferred baked lettering needs explicit original hiding; full-root preservation happens only at acceptance',{timeout:180000},async t=>{
 const f=await fixture(t),c=await candidate(f,{kind:'baked-lettering'}),native=c.beforeState.layers.find(layer=>layer.kind==='text'),identity=await nativeIdentity(f,native),original=await pixels(f,c.before.image.compositeAssetId);
 await reject(f,placement(c,{action:'keep-both',duplicationAcknowledgement:randomUUID(),preservation:'full-visible-root'}),{code:'INVALID_INPUT',reason:'TEXT_TREATMENT_HIDE_NOT_REVIEWED'});
 const approved=await reviewed(f,placement(c,{action:'hide-native-originals',duplicationAcknowledgement:c.plan.choice.duplicationAcknowledgement,hideNativeIds:['native_text'],preservation:'full-visible-root'}));
 // The actual full-root candidate is opaque and stays above the original native
 // slot. Toggling that lower slot cannot change either comparison's pixels.
 const nativePixels=await retained(f,identity.native.render.pixels),candidatePixels=await pixels(f,approved.review.lettering.candidateAloneAssetId);
 assert(nativePixels.some((value,index)=>index%4===3&&value>0),'The retained native source has actual nonzero glyph coverage');
 assert(candidatePixels.every((value,index)=>index%4!==3||value===255),'This observed full-root candidate must be fully opaque for the occlusion oracle');
 assert.deepEqual(await pixels(f,approved.review.lettering.nativeOffAssetId),candidatePixels,'Native-off contains only the real candidate at its reviewed full-root slot');
 assert.deepEqual(await pixels(f,approved.review.lettering.nativeOnAssetId),candidatePixels,'The opaque candidate occludes the original native slot without reordering it');
 assert.deepEqual(approved.intent.after.layers.map(layer=>[layer.id,layer.visible]),[['background',false],['native_text',false],['hidden_picture',false],['generated',true]]);
 const applied=await accept(f,approved);exterior(await pixels(f,applied.document.image.compositeAssetId),original,await retained(f,c.draft.mask.requestPlan.effectiveMask));await unchangedNative(f,native,identity);
 await run(f,{type:'Undo',historyHead:applied.document.historyHead});assert.deepEqual(await image(f),c.beforeState);
});

for(const mutation of ['changed','deleted','locked'])test('fresh deferred new-document recovery copies accepted native bytes after live native '+mutation,{timeout:180000},async t=>{
 const f=await fixture(t),composition=emptyComposition(512,512,randomUUID());composition.scene='Source semantics remain in the source namespace';
 const compositionAsset=await stage(f,Buffer.from(canonical(composition)),'text','application/octet-stream');await run(f,{type:'CommitCompositionVersion',composition:{id:composition.id,value:{...compositionAsset.blob,mediaType:'application/json'},bindings:{}},draft:null});
 const c=await candidate(f),native=c.beforeState.layers.find(layer=>layer.id==='native_text'),identity=await nativeIdentity(f,native),frozenPlan=await retained(f,c.review.textTreatment.plan),effects=await f.effects();
 if(mutation==='changed'){const edited=await addNativeText(f,{textValue:'B',layerVersion:native.version});assert.notDeepEqual(edited.source,native.source);}
 else if(mutation==='deleted')await run(f,{type:'DeleteLayer',layerId:native.id,layerVersion:native.version,draft:null});
 else await properties(f,native.id,{locked:true});
 const current=await document(f),currentState=await image(f);await reject(f,placement(c),{code:'STALE_REVISION'});
 const copy={sourceLayerId:native.id,newLayerId:'recovered_native',transform:[1,0,0,1,24,12]},target='recovered_'+mutation,body=placement(c,{action:'new-document',preservation:'none',nativeCopies:[copy]},{placement:'new-document',newDocumentId:target});
 const approved=await reviewed(f,body);assert.equal(approved.review.documentRevision,current.revision);assert.equal(approved.intent.after.schemaVersion,5);assert.equal(approved.intent.after.composition,null);assert.deepEqual(approved.intent.after.layers.map(layer=>layer.id),['generated',copy.newLayerId]);assert.deepEqual(approved.intent.after.layers[1],{...native,id:copy.newLayerId,version:'1',layerToDocument:copy.transform});await visibleDifference(f,approved.review,{x:24,y:12});
 const applied=await accept(f,approved);assert.equal(applied.document.revision,'1');assert.deepEqual(await document(f),current);assert.deepEqual(await image(f),currentState);await unchangedNative(f,native,identity);assert.deepEqual(await retained(f,c.review.textTreatment.plan),frozenPlan);assert.deepEqual(await f.effects(),effects);
});

for(const clipMask of [false,true])for(const target of [null,'stale_native_document'])test('deferred '+(clipMask?'clipped':'contained')+' native acceptance fences every reviewed origin row for '+(target?'new-document':'current-document'),{timeout:180000},async t=>{
 const f=await fixture(t,{actualSize:256}),c=await candidate(f,{mapped:true,...(clipMask?{cropSize:512,maskRect:{x:0,y:128,width:8,height:8}}:{})}),body=target?placement(c,{action:'new-document',preservation:'none',nativeCopies:[{sourceLayerId:'native_text',newLayerId:'copied_native',transform:[1,0,0,1,8,12]}]},{placement:'new-document',newDocumentId:target,actualOutput:{width:256,height:256,clipMask}}):placement(c,{}, {actualOutput:{width:256,height:256,clipMask}}),approved=await reviewed(f,body,{candidateTransform:clipMask?[2,0,0,2,0,0]:[1.5,0,0,1.5,0,0],rawCandidateEqualsComparison:false});
 await properties(f,'hidden_picture',{locked:false});await reject(f,approved.body,{code:'STALE_REVISION',target});assert.deepEqual((await image(f)).layers.find(layer=>layer.id==='native_text'),c.beforeState.layers.find(layer=>layer.id==='native_text'));
});

test('deferred native review rejects forged treatment authority, changed choice, mapping, candidate and retained input/comparison tampering',{timeout:240000},async t=>{
 const f=await fixture(t,{actualSize:256}),c=await candidate(f,{mapped:true}),body=placement(c,{}, {actualOutput:{width:256,height:256,clipMask:false}}),{textTreatment,...ordinary}=body;
 await reject(f,ordinary,{code:'INVALID_INPUT',reason:'TEXT_TREATMENT_PLACEMENT_REVIEW_REQUIRED'});
 const input=Object.fromEntries(['id','inventory','choice','beforeSource','afterSource','prompt','edit'].map(key=>[key,structuredClone(c.plan[key])]));input.id=randomUUID();
 const forged=planTextTreatment(input),forgedAsset=await stage(f,Buffer.from(canonical(forged)),'text','application/octet-stream'),envelope=bindTextTreatmentEnvelope(forged,{...forgedAsset.blob,mediaType:'application/json'});
 await reject(f,{...body,textTreatment:{...textTreatment,plan:envelope}},{code:'STALE_REVISION',reason:'TEXT_TREATMENT_REQUEST_CHANGED'});
 await reject(f,placement(c,{hideNativeIds:['native_text']},{actualOutput:body.actualOutput}));
 const approved=await reviewed(f,body,{candidateTransform:[1.5,0,0,1.5,0,0],rawCandidateEqualsComparison:false});await reject(f,{...approved.body,reviewHash:'sha256:'+'f'.repeat(64)},{code:'STALE_REVISION'});
 // Hash-validity and owned file proof are checked again at acceptance, not
 // inferred from a client echo or an earlier successful comparison read.
 for(const ref of [approved.review.lettering.intent,approved.review.lettering.manifest,(await asset(f,approved.review.lettering.nativeOnAssetId)).blob,c.draft.mask.requestPlan.effectiveMask]){
  const path=objectPath(f,ref),original=await retained(f,ref),altered=Buffer.from(original);altered[0]^=1;
  try{await writeFile(path,altered);await reject(f,approved.body);}finally{await writeFile(path,original);}
  assert.deepEqual(await retained(f,ref),original);
 }
 await operate(f,{type:'HideCandidate',candidateId:c.value.id,expectedVersion:c.value.version});await reject(f,approved.body,{code:'STALE_REVISION'});
});

for(const placementKind of ['current-document','new-document'])test('deferred 512-to-256 contained output compares the actual mapping and preserves exact native treatment in '+placementKind,{timeout:180000},async t=>{
 const acceptanceWait={deadline:performance.now()+180000,signal:t.signal,observe:value=>t.diagnostic(JSON.stringify(value))};
 const f=await fixture(t,{actualSize:256,acceptanceWait}),c=await candidate(f,{mapped:true,placement:placementKind}),target=placementKind==='new-document'?'mapped_native_document':null,native=c.beforeState.layers.find(layer=>layer.id==='native_text'),identity=await nativeIdentity(f,native),effects=await f.effects();
 assert.deepEqual(c.draft.mask.requestPlan.outputToDocument,[0.75,0,0,0.75,0,0]);assert.equal((await asset(f,c.value.preparedAssetId)).raster.width,256);
 const actualOutput={width:256,height:256,clipMask:false},copy={sourceLayerId:native.id,newLayerId:'copied_native',transform:[1,0,0,1,24,12]};
 const body=target?placement(c,{action:'new-document',preservation:'none',nativeCopies:[copy]},{placement:placementKind,newDocumentId:target,actualOutput}):placement(c,{}, {actualOutput});
 await reject(f,{...body,actualOutput:{...actualOutput,width:512}},{code:'INCOMPATIBLE',reason:'OUTPUT_MAPPING_REVIEW_REQUIRED'});
 const zeroLoss=await reviewed(f,{...body,actualOutput:{...actualOutput,clipMask:true}},{candidateTransform:[1.5,0,0,1.5,0,0],rawCandidateEqualsComparison:false});assert.deepEqual(zeroLoss.review.inputs.coverage,{originalEffectivePixels:64,effectivePixels:64,lostPixels:0});assert.deepEqual(zeroLoss.review.inputs.outputMapping.effectiveMask,c.draft.mask.requestPlan.effectiveMask);successorWitness(c,body.textTreatment.choice,zeroLoss.review.inputs.identity,zeroLoss.review.inputs.outputMapping,zeroLoss.intent.decision.maskSuccessor);
 const approved=await reviewed(f,body,{candidateTransform:[1.5,0,0,1.5,0,0],rawCandidateEqualsComparison:false}),mapping=approved.review.inputs.outputMapping;
 assert.deepEqual(mapping.outputToDocument,[1.5,0,0,1.5,0,0]);assert.deepEqual(mapping.actualOutput,{width:256,height:256});assert.deepEqual(mapping.effectiveMask,c.draft.mask.requestPlan.effectiveMask);assert.equal(mapping.resolution,'already-contained');assert.equal(approved.review.inputs.coverage.lostPixels,0);assert.equal('maskSuccessor' in approved.intent.decision,false);
 // Literal document-space pixels distinguish the actual 384px extent from
 // the obsolete request-grid transform, which would stop at x=192.
 const comparison=await pixels(f,approved.review.lettering.candidateAloneAssetId);assert.equal(comparison.length,512*512*4);assert.deepEqual([...comparison.subarray((100*512+300)*4,(100*512+300)*4+4)],[36,104,172,255]);assert.deepEqual([...comparison.subarray((100*512+450)*4,(100*512+450)*4+4)],[0,0,0,0]);
 await visibleDifference(f,approved.review,target?{x:24,y:12}:{});
 for(const mutate of [value=>{value.placement.actualOutput=null;},value=>{value.placement.actualOutput.width=512;},value=>{value.placement.actualOutput.clipMask=true;},value=>{value.inputs.outputMapping=null;},value=>{value.inputs.outputMapping.resolution='clipped-and-approved';},value=>{value.inputs.outputMapping.effectiveMask.hash='sha256:'+'f'.repeat(64);},value=>{value.inputs.coverage.lostPixels=1;}]){const forged=structuredClone(approved.review);mutate(forged);assert.throws(()=>candidatePlacementReview(forged));}
 await reject(f,{...approved.body,reviewHash:'sha256:'+'f'.repeat(64)},{code:'STALE_REVISION',target});
 const applied=await accept(f,approved),generated=applied.after.layers.find(layer=>layer.id==='generated');exterior(await pixels(f,generated.assetId),await pixels(f,c.selected.asset.id),await retained(f,c.draft.mask.requestPlan.effectiveMask));
 if(target){assert.deepEqual(applied.after.layers[1],{...native,id:copy.newLayerId,version:'1',layerToDocument:copy.transform});assert.deepEqual(await document(f),c.before);assert.deepEqual(await image(f),c.beforeState);}
 else{
  const original=await pixels(f,c.before.image.compositeAssetId);assert.deepEqual(applied.after.layers.find(layer=>layer.id===native.id),native);exterior(await pixels(f,applied.document.image.compositeAssetId),original,await retained(f,c.draft.mask.requestPlan.effectiveMask));const undo=await run(f,{type:'Undo',historyHead:applied.document.historyHead});assert.deepEqual(await image(f),c.beforeState);assert.deepEqual(await pixels(f,undo.document.image.compositeAssetId),original);await run(f,{type:'Redo',historyNode:applied.document.historyHead});assert.deepEqual(await image(f),applied.after);
 }
 await unchangedNative(f,native,identity);assert.deepEqual(await f.effects(),effects);
});


for(const placementKind of ['current-document','new-document'])test('deferred clipped successor binds exact lost coverage, native identity and history in '+placementKind,{timeout:300000},async t=>{
 const acceptanceWait={deadline:performance.now()+300000,signal:t.signal,observe:value=>t.diagnostic(JSON.stringify(value))};
 const f=await fixture(t,{actualSize:256,acceptanceWait}),c=await candidate(f,{mapped:true,cropSize:512,maskRect:{x:0,y:128,width:8,height:8},placement:placementKind}),target=placementKind==='new-document'?'clipped_native_document':null,native=c.beforeState.layers.find(layer=>layer.id==='native_text'),identity=await nativeIdentity(f,native),effects=await f.effects(),frozenPlan=await retained(f,c.review.textTreatment.plan);
 const actualOutput={width:256,height:256,clipMask:true},copy={sourceLayerId:native.id,newLayerId:'copied_native',transform:[1,0,0,1,24,12]},body=target?placement(c,{action:'new-document',preservation:'none',nativeCopies:[copy]},{placement:placementKind,newDocumentId:target,actualOutput}):placement(c,{}, {actualOutput});
 await reject(f,{...body,actualOutput:{...actualOutput,clipMask:false}},{code:'INCOMPATIBLE',reason:'MASK_DOMAIN_REVIEW_REQUIRED'});
 const approved=await reviewed(f,body,{candidateTransform:[2,0,0,2,0,0],rawCandidateEqualsComparison:false}),mapping=approved.review.inputs.outputMapping,coverage=await clippedBoundary(f,c,mapping,approved.review.inputs.coverage);
 successorWitness(c,body.textTreatment.choice,approved.review.inputs.identity,mapping,approved.intent.decision.maskSuccessor);assert.equal(approved.intent.decision.kind,'text-treatment-successor-placement-intent-1');assert.equal(approved.intent.decision.requestedPreservation,target?'none':'single-original-contribution');assert.equal(approved.manifest.preservation,'not-applied');await visibleDifference(f,approved.review,target?{x:24,y:12}:{});
 const comparison=await pixels(f,approved.review.lettering.candidateAloneAssetId);assert.deepEqual([...comparison.subarray((100*512+450)*4,(100*512+450)*4+4)],[36,104,172,255],'Comparison uses the actual 2x mapping, not the old identity transform');
 for(const mutate of [value=>{value.placement.actualOutput.clipMask=false;},value=>{value.inputs.outputMapping.resolution='already-contained';},value=>{value.inputs.coverage.lostPixels=0;},value=>{value.inputs.coverage.effectivePixels=0;}]){const forged=structuredClone(approved.review);mutate(forged);assert.throws(()=>candidatePlacementReview(forged));}
 if(!target){
  // A hash-valid retained intent and recomputed outer review hash still cannot
  // substitute a successor belonging to another candidate/output/choice.
  for(const key of ['candidateIdentityHash','outputMappingHash','adoptionChoiceHash']){
   const changed=structuredClone(approved.intent);changed.decision.maskSuccessor[key]='sha256:'+'f'.repeat(64);const stored=await stageOwned(f,Buffer.from(canonical(changed))),review=structuredClone(approved.review);review.lettering.intent={...stored.blob,mediaType:'application/json'};review.lettering.intentHash=review.lettering.intent.hash;const {reviewHash,...content}=review;review.reviewHash=sha(canonical(content));assert.doesNotThrow(()=>candidatePlacementReview(review));
   const db=new DatabaseSync(join(f.root,'metadata.sqlite'));let original;try{original=db.prepare('SELECT json FROM image_edit_reviews WHERE id=?').get(review.reviewId).json;db.prepare('UPDATE image_edit_reviews SET json=? WHERE id=?').run(canonical(review),review.reviewId);}finally{db.close();}
   try{await reject(f,adoption(review),{code:'STALE_REVISION',reason:'LETTERING_INTENT_CHANGED'});}finally{const restore=new DatabaseSync(join(f.root,'metadata.sqlite'));try{restore.prepare('UPDATE image_edit_reviews SET json=? WHERE id=?').run(original,review.reviewId);}finally{restore.close();}}
  }
  for(const [context,ref]of [['original-mask-corruption',c.draft.mask.requestPlan.effectiveMask],['derived-mask-corruption',mapping.effectiveMask]]){const path=objectPath(f,ref),original=await retained(f,ref),changed=Buffer.from(original);changed[0]^=1;try{await writeFile(path,changed);await reject(f,approved.body,{code:'MISSING_ASSET',reason:'HISTORY_DEPENDENCY_UNAVAILABLE',context});}finally{await writeFile(path,original);}}
 }
 const applied=await accept(f,approved),generated=applied.after.layers.find(layer=>layer.id==='generated'),wrapper=await asset(f,generated.assetId),{manifest,lineage}=await preservedCandidate(f,wrapper);assert.deepEqual(manifest.plan.requestPlan,c.draft.mask.requestPlan);assert.deepEqual(manifest.plan.outputMapping,mapping);assert.deepEqual(lineage.result.request.textTreatment,c.review.textTreatment);for(const ref of [c.draft.mask.requestPlan.effectiveMask,mapping.effectiveMask])assert(manifest.dependencies.some(dependency=>canonical(dependency)===canonical(ref)));
 exterior(await pixels(f,generated.assetId),await pixels(f,c.selected.asset.id),coverage.final);
 if(target){assert.deepEqual(applied.after.layers[1],{...native,id:copy.newLayerId,version:'1',layerToDocument:copy.transform});assert.deepEqual(await document(f),c.before);assert.deepEqual(await image(f),c.beforeState);}
 else{const original=await pixels(f,c.before.image.compositeAssetId);assert.deepEqual(applied.after.layers.find(layer=>layer.id===native.id),native);exterior(await pixels(f,applied.document.image.compositeAssetId),original,coverage.final);const undo=await run(f,{type:'Undo',historyHead:applied.document.historyHead});assert.deepEqual(await image(f),c.beforeState);assert.deepEqual(await pixels(f,undo.document.image.compositeAssetId),original);await run(f,{type:'Redo',historyNode:applied.document.historyHead});assert.deepEqual(await image(f),applied.after);}
 await unchangedNative(f,native,identity);assert.deepEqual(await retained(f,c.review.textTreatment.plan),frozenPlan);assert.deepEqual(await retained(f,c.draft.mask.requestPlan.effectiveMask),coverage.original);assert.deepEqual(await f.effects(),effects);
 if(!target)await clippedPortableRoundTrip(f,c,approved,applied,native,identity,coverage);
});

test('deferred clipped output refuses an empty final mask without registering review products',{timeout:180000},async t=>{
 const f=await fixture(t,{actualSize:256}),c=await candidate(f,{mapped:true,cropSize:512,maskRect:{x:0,y:128,width:1,height:8}}),plan=await retained(f,c.review.textTreatment.plan),mask=await retained(f,c.draft.mask.requestPlan.effectiveMask),effects=await f.effects();
 await reject(f,placement(c,{}, {actualOutput:{width:256,height:256,clipMask:true}}),{code:'INCOMPATIBLE',reason:'EMPTY_MASK'});assert.deepEqual(await retained(f,c.review.textTreatment.plan),plan);assert.deepEqual(await retained(f,c.draft.mask.requestPlan.effectiveMask),mask);assert.deepEqual(await f.effects(),effects);
});

async function clippedPortableRoundTrip(f,c,approved,applied,native,identity,coverage){
 const mapping=approved.review.inputs.outputMapping,refs=[c.review.textTreatment.plan,c.plan.edit.requestPlan,c.draft.mask.requestPlan.effectiveMask,mapping.effectiveMask,native.source,identity.native.text.textUtf8,identity.native.render.layout,identity.native.render.pixels,identity.mask.raster.pixels,...identity.native.text.fonts.flatMap(font=>[font.bytes,font.licenseRecord])],expected=new Map();
 for(const ref of refs)expected.set(ref.hash,await retained(f,ref));
 const lettering=approved.review.lettering,approvalRefs=[lettering.intent,lettering.manifest],approvalBytes=new Map();
 for(const ref of approvalRefs)approvalBytes.set(ref.hash,await retained(f,ref));
 const approvalRoots=owner=>{const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});try{for(const ref of approvalRefs){const root=db.prepare('SELECT o.byte_length,r.media_type FROM roots r JOIN objects o ON o.hash=r.hash WHERE r.owner=? AND r.hash=? AND r.media_type=?').get(owner,ref.hash,ref.mediaType);assert(root,'Accepted successor approval must have durable ownership: '+owner+' '+ref.hash);assert.equal(root.byte_length,ref.byteLength);assert.equal(root.media_type,ref.mediaType);}}finally{db.close();}};
 approvalRoots('history-command:'+applied.receipt.commandId);
 const checkApproval=entries=>{
  for(const ref of approvalRefs){const bytes=entries.get('objects/'+ref.hash.slice(7));assert(bytes,'Portable provenance must retain successor approval '+ref.hash);assert.deepEqual(bytes,approvalBytes.get(ref.hash));}
  const intent=JSON.parse(entries.get('objects/'+lettering.intent.hash.slice(7))),manifest=JSON.parse(entries.get('objects/'+lettering.manifest.hash.slice(7)));
  assert.deepEqual(intent,approved.intent);assert.deepEqual(manifest,approved.manifest);assert.deepEqual(manifest.intent,lettering.intent);
  assert.deepEqual(intent.placement.textTreatment.choice,lettering.choice);assert.deepEqual(intent.decision.choice,lettering.choice);assert.equal(intent.decision.approvalId,lettering.choice.approvalId);
  assert.deepEqual(intent.decision.maskSuccessor,approved.intent.decision.maskSuccessor);successorWitness(c,lettering.choice,approved.review.inputs.identity,mapping,intent.decision.maskSuccessor);
 };
 const checkArchive=async bytes=>{const entries=await unpack(f.root,bytes);for(const [hash,original]of expected){const value=entries.get('objects/'+hash.slice(7));assert(value,'Portable closure must retain '+hash);assert.deepEqual(value,original);}return entries;};
 const saved=await copy(f);checkApproval(await checkArchive(saved.bytes));const original=await document(f),originalState=await image(f);
 f=await f.reopen();assert.deepEqual(await document(f),original);assert.deepEqual(await image(f),originalState);assert.deepEqual(await f.effects(),[]);
 const reviewCount=()=>{const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});try{return db.prepare('SELECT count(*) n FROM image_edit_reviews').get().n;}finally{db.close();}},beforeReviews=reviewCount(),prepared=(await previewCopy(f,saved.bytes)).review;assert.equal(prepared.editable,true,JSON.stringify(prepared));await importBundle(f,prepared);assert.equal(reviewCount(),beforeReviews,'Imported successor provenance grants no live review authority');
 approvalRoots('namespace:'+prepared.namespaceId);for(const ref of approvalRefs)assert.deepEqual(await retained(f,ref),approvalBytes.get(ref.hash));
 const imported=await image(f,prepared.documentId),importedNative=imported.layers.find(layer=>layer.kind==='text'),importedGenerated=imported.layers.find(layer=>layer.kind==='image'&&layer.visible),copiedNative=await nativeIdentity(f,importedNative),copiedWrapper=await asset(f,importedGenerated.assetId),{manifest:copiedManifest,lineage:copiedLineage}=await preservedCandidate(f,copiedWrapper);assert.deepEqual(copiedLineage.result.request.textTreatment,c.review.textTreatment);
 assert.notEqual(importedNative.id,native.id);assert.deepEqual(importedNative.source,native.source);assert.deepEqual(copiedNative.native,identity.native);assert.deepEqual(copiedNative.raster.raster.pixels,identity.raster.raster.pixels);assert.deepEqual(copiedNative.mask.raster.pixels,identity.mask.raster.pixels);assert.deepEqual(importedNative.layerToDocument,native.layerToDocument);assert.equal(importedNative.opacity,native.opacity);assert.equal(importedNative.visible,native.visible);
 assert.deepEqual(copiedManifest.plan.requestPlan,c.draft.mask.requestPlan);assert.deepEqual(copiedManifest.plan.outputMapping,mapping);for(const ref of [c.draft.mask.requestPlan.effectiveMask,mapping.effectiveMask])assert(copiedManifest.dependencies.some(dependency=>canonical(dependency)===canonical(ref)));exterior(await pixels(f,importedGenerated.assetId),await pixels(f,c.selected.asset.id),coverage.final);
 const candidates=(await f.read('/api/v1/documents/'+prepared.documentId+'/candidates')).json.items;assert.equal(candidates.length,1);assert(candidates.every(value=>value.inert===true));assert(!(await f.read('/api/v1/queue')).json.jobs.some(job=>job.documentId===prepared.documentId));
 const importedBefore=await document(f,prepared.documentId),refused=await terminal(f,f.command({documentId:prepared.documentId,expectedDocumentRevision:importedBefore.revision,body:approved.body}));assert.equal(refused.json.receipt.status,'rejected');assert.deepEqual(await document(f,prepared.documentId),importedBefore);assert.deepEqual(await image(f,prepared.documentId),imported);
 const recopied=await copy(f,prepared.documentId),recopiedEntries=await checkArchive(recopied.bytes);
 // The remapped image history need not expose the old review as live authority.
 // Its exact approval remains linked through the immutable imported archive.
 const importedEvent=records(recopiedEntries,'events').values.find(row=>row.kind==='event'&&row.event.type==='BundleImported'&&row.event.payload.namespaceId===prepared.namespaceId)?.event;assert(importedEvent);assert.equal(importedEvent.documentId,prepared.documentId);assert.deepEqual(importedEvent.payload.source,prepared.source);
 const sourceArchive=recopiedEntries.get('objects/'+importedEvent.payload.source.hash.slice(7));assert(sourceArchive);assert.deepEqual(sourceArchive,saved.bytes);checkApproval(await unpack(f.root,sourceArchive));
 for(const ref of approvalRefs){const direct=recopiedEntries.get('objects/'+ref.hash.slice(7));if(direct)assert.deepEqual(direct,approvalBytes.get(ref.hash),'Any directly retained approval must also remain byte-identical');}
 assert.deepEqual(await document(f),original);assert.deepEqual(await image(f),originalState);await unchangedNative(f,native,identity);assert.deepEqual(await f.effects(),[]);
}

async function observation(f,commandId){
 const deadline=Date.now()+5000;
 for(;;){
  let value;try{value=JSON.parse(await readFile(join(f.root,'encoded-guard-observation.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(value?.commands.some(row=>row.commandId===commandId))return value;
  assert(Date.now()<deadline,'The owning writer must report terminal cleanup within the bounded polling window');await new Promise(resolve=>setTimeout(resolve,10));
 }
}
function released(value){
 assert.deepEqual(value.violations,[],'Encoded acceptance cannot read old canonical pixels or fall back to a retained Q');assert(value.guarded.length>0);
 assert.deepEqual(value.leases,{leases:0,proofs:0,metadataBytes:0});assert.deepEqual(value.proofs,{pending:0,retained:0,activeReaders:0,metadataBytes:0});
 assert(value.workRemoved.every(Boolean),'Every encoded worker scratch directory must be removed');assert.equal(value.raster.activeWorkers,0);assert.equal(value.raster.reservedCPU,0);
}

async function encodedComposition(f,review){
 assert.equal('encodedComposition' in review,false);const ref=review.encodedCompositionRef;assert(ref);assert.equal(ref.mediaType,'application/json');assert(BigInt(ref.byteLength)>0n&&BigInt(ref.byteLength)<=BigInt(ENCODED_COMPOSITION_BYTES));
 const bytes=await retained(f,ref),value=JSON.parse(bytes);assert.equal(canonical(value),bytes.toString('utf8'));assert.doesNotThrow(()=>validateEncodedCompositionInputs(value));assert.equal(value.width,review.width);assert.equal(value.height,review.height);assert.equal(value.candidateAssetId,review.inputs.identity.preparedAssetId);return {ref,bytes,value};
}
function encodedRefControls(review,graph){
 assert.doesNotThrow(()=>candidatePlacementReview(review));
 const legacy=structuredClone(review);delete legacy.encodedCompositionRef;legacy.encodedComposition=graph;assert.doesNotThrow(()=>candidatePlacementReview(legacy),'Legacy inline metadata retains its shape contract without granting a fresh live proof lease');
 for(const ref of [{...review.encodedCompositionRef,byteLength:'0'},{...review.encodedCompositionRef,byteLength:String(ENCODED_COMPOSITION_BYTES+1)},{...review.encodedCompositionRef,mediaType:'text/plain'},{...review.encodedCompositionRef,hash:'sha256:'+'z'.repeat(64)}])assert.throws(()=>candidatePlacementReview({...review,encodedCompositionRef:ref}));
 assert.doesNotThrow(()=>candidatePlacementReview({...review,encodedCompositionRef:{...review.encodedCompositionRef,byteLength:String(ENCODED_COMPOSITION_BYTES)}}),'The exact metadata cap is structurally admitted; this check supplies no object bytes or preparation authority');
 assert.throws(()=>candidatePlacementReview({...review,encodedComposition:graph}),'Inline and referenced graphs are mutually exclusive');
 const missing=structuredClone(review);delete missing.encodedCompositionRef;assert.throws(()=>candidatePlacementReview(missing));
}
async function boundsObservation(f,commandId){
 const deadline=Date.now()+5000;
 do{try{const value=JSON.parse(await readFile(join(f.root,'native-bounds-'+commandId+'.json'),'utf8'));assert.equal(value.commandId,commandId);return value;}catch(error){if(error.code!=='ENOENT')throw error;}await new Promise(resolve=>setTimeout(resolve,5));}while(Date.now()<deadline);
 assert.fail('Missing actual writer completion diagnostics for '+commandId);
}
function boundsReleased(value){
 assert.deepEqual(value.leases,{leases:0,proofs:0,metadataBytes:0});assert.deepEqual(value.proofs,{pending:0,retained:0,activeReaders:0,metadataBytes:0});assert.equal(value.composition.borrowers,0);assert.equal(value.composition.borrowedBytes,0);assert.equal(value.raster.activeWorkers,0);assert.equal(value.raster.reservedCPU,0);
 assert.equal(value.stages,0);assert.deepEqual(value.ioSlots,['history:'+value.commandId],'A JSON writer must restore the caller IO slot before the scheduler releases it');
}
function savedReviews(f){const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});try{return db.prepare('SELECT id,json FROM image_edit_reviews ORDER BY id').all();}finally{db.close();}}
function historyRoots(f){const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});try{return db.prepare("SELECT owner,hash,media_type FROM roots WHERE owner LIKE 'history-command:%' ORDER BY owner,hash,media_type").all();}finally{db.close();}}

test('99 genuinely verified distinct native assets retain a large encoded graph behind a bounded public review; acceptance and Undo remain real',{timeout:900000},async t=>{
 const f=await fixture(t,{bounds:true}),nativeState=await ninetyNineNativeAssets(f),c=await candidate(f,{kind:'baked-lettering'}),approved=await reviewed(f,placement(c,{action:'keep-both',duplicationAcknowledgement:randomUUID(),preservation:'none'},{preparation:'encoded-rebuild'})),graph=await encodedComposition(f,approved.review);
 assert.equal(graph.value.layers.length,100);assert.equal(graph.value.images.length,99);assert.equal(new Set(graph.value.images.map(row=>row.assetId)).size,99);assert.deepEqual(new Set(graph.value.images.map(row=>row.assetId)),new Set(nativeState.layers.map(row=>row.assetId)));
 const afterBytes=Buffer.byteLength(canonical(approved.intent.after)),intentBytes=(await retained(f,approved.review.lettering.intent)).length;
 assert(afterBytes<=65536,'The actual accepted ImageState must fit its unchanged metadata bound');assert(graph.bytes.length>65536&&graph.bytes.length<=ENCODED_COMPOSITION_BYTES);assert(intentBytes>65536&&intentBytes<=524288);assert(approved.wireBytes<=65536);
 t.diagnostic(JSON.stringify({nativeAssets:graph.value.images.length,visibleLayers:graph.value.layers.length,afterBytes,intentBytes,encodedGraphBytes:graph.bytes.length,publicReviewBytes:approved.wireBytes}));
 const applied=await accept(f,approved);assert.equal(applied.after.layers.length,100);boundsReleased(await boundsObservation(f,applied.request.command.commandId));
 const undo=await run(f,{type:'Undo',historyHead:applied.document.historyHead});assert.deepEqual(await image(f),nativeState);assert.equal(undo.document.orderedLayerIds.length,99);
 // A fresh valid request keeps the command under 64 KiB while the reviewed
 // native-copy choice appears twice in the public representation. Refuse it
 // before registering its comparisons or granting any accepted review facts.
 await ui(f,{type:'ClearDraft',draftId:'request',generation:'1'});
 const fresh=await candidate(f,{kind:'baked-lettering',placement:'new-document'}),copies=nativeState.layers.map((layer,index)=>({sourceLayerId:layer.id,newLayerId:('copy_'+String(index).padStart(3,'0')+'_').padEnd(128,'c'),transform:[...layer.layerToDocument]})),body=placement(fresh,{action:'new-document',preservation:'none',nativeCopies:copies},{preparation:'encoded-rebuild',placement:'new-document',newDocumentId:'bounded_copy'}),beforeReviews=savedReviews(f),beforeRoots=historyRoots(f);
 assert(Buffer.byteLength(canonical(f.command({documentId,expectedDocumentRevision:(await document(f)).revision,body})))<65536,'The refusal must concern public review capacity, not input command size');
 const refused=await reject(f,body,{code:'CAPACITY',reason:'CANDIDATE_REVIEW_LIMIT'});assert.deepEqual(savedReviews(f),beforeReviews);assert.deepEqual(historyRoots(f),beforeRoots);assert.equal((await f.read('/api/v1/documents/bounded_copy')).status,404);boundsReleased(await boundsObservation(f,refused.request.command.commandId));
});

for(const failure of ['missing','hash-mismatch','malformed-json','graph-mismatch'])test('encoded native review refuses '+failure+' in its retained graph before raster preparation and releases real owned proofs',{timeout:180000},async t=>{
 const f=await fixture(t,{encoded:true,bounds:true}),c=await candidate(f),approved=await reviewed(f,placement(c,{}, {preparation:'encoded-rebuild'})),graph=await encodedComposition(f,approved.review);let restore=async()=>{},body=approved.body;
 if(failure==='missing'){
  const path=objectPath(f,graph.ref),backup=path+'.bounds-missing';await rename(path,backup);restore=()=>rename(backup,path);
 }else if(failure==='hash-mismatch'){
  const changed=Buffer.from(graph.bytes);changed[0]^=1;await writeFile(objectPath(f,graph.ref),changed);restore=()=>writeFile(objectPath(f,graph.ref),graph.bytes);
 }else{
  const changed=structuredClone(graph.value);if(failure==='graph-mismatch'){changed.layers[0].transform[4]+=1;assert.doesNotThrow(()=>validateEncodedCompositionInputs(changed));}
  const bytes=failure==='malformed-json'?Buffer.from('{'):Buffer.from(canonical(changed)),stored=await stageOwned(f,bytes),review=structuredClone(approved.review);review.encodedCompositionRef={...stored.blob,mediaType:'application/json'};
  const {reviewHash,...content}=review;review.reviewHash=sha(canonical(content));assert.doesNotThrow(()=>candidatePlacementReview(review));body=adoption(review);
  // Corrupt only the persisted review under its genuine client/session row.
  // Do not replace its original proof lease. Graph checks must refuse first.
  const db=new DatabaseSync(join(f.root,'metadata.sqlite'));
  try{const original=db.prepare('SELECT json FROM image_edit_reviews WHERE id=?').get(review.reviewId).json;db.prepare('UPDATE image_edit_reviews SET json=? WHERE id=?').run(canonical(review),review.reviewId);restore=async()=>{const db=new DatabaseSync(join(f.root,'metadata.sqlite'));try{db.prepare('UPDATE image_edit_reviews SET json=? WHERE id=?').run(original,review.reviewId);}finally{db.close();}};}finally{db.close();}
 }
 try{
  const mismatch=failure==='graph-mismatch',attempted=await reject(f,body,{code:mismatch?'STALE_REVISION':'MISSING_ASSET',reason:mismatch?'ENCODED_REBUILD_PLACEMENT_CHANGED':'HISTORY_DEPENDENCY_UNAVAILABLE'}),guard=await observation(f,attempted.request.command.commandId);released(guard);assert.deepEqual(guard.workerJobs,[],'Malformed or changed graph metadata must be refused before lease take and raster preparation');boundsReleased(await boundsObservation(f,attempted.request.command.commandId));
 }finally{await restore();}
 assert.deepEqual(await retained(f,graph.ref),graph.bytes);
});


test('encoded deferred clipping joins its successor witness to approved R16 transport without canonical raw rereads',{timeout:180000},async t=>{
 const f=await fixture(t,{encoded:true,actualSize:256}),c=await candidate(f,{mapped:true,cropSize:512,maskRect:{x:0,y:128,width:8,height:8}}),native=c.beforeState.layers.find(layer=>layer.id==='native_text'),identity=await nativeIdentity(f,native),original=await pixels(f,c.before.image.compositeAssetId),frozenPlan=await retained(f,c.review.textTreatment.plan);
 const body=placement(c,{}, {preparation:'encoded-rebuild',actualOutput:{width:256,height:256,clipMask:true}}),approved=await reviewed(f,body,{candidateTransform:[2,0,0,2,0,0],rawCandidateEqualsComparison:false}),mapping=approved.review.inputs.outputMapping,coverage=await clippedBoundary(f,c,mapping,approved.review.inputs.coverage),encodedMask=approved.review.inputs.encodedRebuild.mask;
 successorWitness(c,body.textTreatment.choice,approved.review.inputs.identity,mapping,approved.intent.decision.maskSuccessor);assert.deepEqual(encodedMask.effective.pixels,c.draft.mask.requestPlan.effectiveMask);assert.deepEqual(encodedMask.approved.pixels,mapping.effectiveMask);assert.notEqual(encodedMask.approved.encoded.hash,encodedMask.effective.encoded.hash);await encodedComposition(f,approved.review);await visibleDifference(f,approved.review);
 const applied=await accept(f,approved),observed=await observation(f,applied.request.command.commandId);released(observed);const slot='history:'+applied.request.command.commandId,records=observed.observations.filter(row=>row.slot===slot);assert.deepEqual(records.map(row=>row.operation),['encoded-preserve','encoded-compose']);assert.deepEqual(observed.workerJobs,[{type:'encoded-preserve',slot},{type:'encoded-compose',slot}]);
 assert.equal(records[0].evidence.decodeCount,5);assert(records[0].evidence.inputs.some(input=>input.encoded.hash===encodedMask.approved.encoded.hash));assert(records[0].evidence.inputs.some(input=>input.encoded.hash===encodedMask.effective.encoded.hash));assert(records[1].evidence.inputs.some(input=>input.encoded.hash===identity.raster.blob.hash));
 for(const record of records){assert.equal(record.evidence.canonicalInputPaths,0);assert.equal(record.evidence.reusedPreparedProducts,0);assert.equal(record.evidence.scratchRemoved,true);for(const input of record.evidence.inputs)assert.deepEqual(input.actual,input.expected);}
 assert.deepEqual(applied.after.layers.find(layer=>layer.id===native.id),native);exterior(await pixels(f,applied.document.image.compositeAssetId),original,coverage.final);await unchangedNative(f,native,identity);assert.deepEqual(await retained(f,c.review.textTreatment.plan),frozenPlan);assert.deepEqual(await retained(f,c.draft.mask.requestPlan.effectiveMask),coverage.original);
});

test('encoded deferred native acceptance rebuilds the real native layer and R16 mask, without old raw reads or retained Q',{timeout:180000},async t=>{
 const f=await fixture(t,{encoded:true}),c=await candidate(f),native=c.beforeState.layers.find(layer=>layer.id==='native_text'),identity=await nativeIdentity(f,native),original=await pixels(f,c.before.image.compositeAssetId),coverage=await retained(f,c.draft.mask.requestPlan.effectiveMask);
 const approved=await reviewed(f,placement(c,{}, {preparation:'encoded-rebuild'}));await visibleDifference(f,approved.review);
 const graph=await encodedComposition(f,approved.review);encodedRefControls(approved.review,graph.value);assert.equal(approved.review.inputs.encodedRebuild.kind,'encoded-adoption-inputs-1');assert(graph.value.images.some(value=>value.assetId===native.assetId));assert(graph.value.masks.some(value=>value.assetId===native.mask.assetId));
 const applied=await accept(f,approved),observed=await observation(f,applied.request.command.commandId);released(observed);
 const slot='history:'+applied.request.command.commandId,records=observed.observations.filter(row=>row.slot===slot);assert.deepEqual(records.map(row=>row.operation),['encoded-preserve','encoded-compose']);assert.deepEqual(observed.workerJobs,[{type:'encoded-preserve',slot},{type:'encoded-compose',slot}]);
 assert.equal(records[0].evidence.decodeCount,5);assert(records[1].evidence.decodeCount>=3,'Composition decodes the fresh generated raster, native raster and native R16 coverage');
 assert(records[1].evidence.inputs.some(input=>input.encoded.hash===identity.raster.blob.hash));assert.equal(records[1].outputAssetId,applied.document.image.compositeAssetId);
 for(const record of records){assert.equal(record.evidence.kind,'encoded-input-rebuild-1');assert.equal(record.evidence.canonicalInputPaths,0);assert.equal(record.evidence.reusedPreparedProducts,0);assert.equal(record.evidence.scratchRemoved,true);for(const input of record.evidence.inputs)assert.deepEqual(input.actual,input.expected);}
 exterior(await pixels(f,applied.document.image.compositeAssetId),original,coverage);await unchangedNative(f,native,identity);
});

test('failure after real encoded preservation commits no native edit, asset or event and releases its consumed review proofs',{timeout:180000},async t=>{
 const f=await fixture(t,{encoded:true,failure:true}),c=await candidate(f),native=c.beforeState.layers.find(layer=>layer.id==='native_text'),identity=await nativeIdentity(f,native),approved=await reviewed(f,placement(c,{}, {preparation:'encoded-rebuild'}));
 const attempted=await reject(f,approved.body,{code:'INVALID_INPUT',reason:'ENCODED_GUARD_AFTER_PRESERVE'}),first=await observation(f,attempted.request.command.commandId);released(first);
 assert.deepEqual(first.observations.filter(row=>row.slot==='history:'+attempted.request.command.commandId).map(row=>row.operation),['encoded-preserve']);await unchangedNative(f,native,identity);
 const retried=await reject(f,approved.body,{code:'STALE_REVISION',reason:'ENCODED_REBUILD_REVIEW_REQUIRED'}),second=await observation(f,retried.request.command.commandId);released(second);assert.deepEqual(second.workerJobs,first.workerJobs,'A consumed failed review cannot dispatch another decode or switch to old prepared pixels');
});

test('canceling an accepted encoded native review keeps the immutable review receipt and releases only its live preparation authority',{timeout:180000},async t=>{
 const f=await fixture(t,{encoded:true}),c=await candidate(f),native=c.beforeState.layers.find(layer=>layer.id==='native_text'),identity=await nativeIdentity(f,native),approved=await reviewed(f,placement(c,{}, {preparation:'encoded-rebuild'}));
 const before=await document(f),beforeImage=await image(f),cold=inventory(f),beforeEvents=eventInventory(f),commandId=approved.prepared.request.command.commandId;
 const canceled=await f.post('/api/v1/commands/'+commandId+'/cancel-candidate-review',{protocolVersion:1,commandId});assert.equal(canceled.status,200,canceled.text);assert.deepEqual(canceled.json,{protocolVersion:1,commandId,status:'canceled'});
 const again=await f.post('/api/v1/commands/'+commandId+'/cancel-candidate-review',{protocolVersion:1,commandId});assert.equal(again.status,200,again.text);assert.equal(again.json.status,'completed');
 assert.deepEqual((await terminal(f,approved.prepared.request)).json.receipt,approved.prepared.receipt);assert.deepEqual(await document(f),before);assert.deepEqual(await image(f),beforeImage);assert.deepEqual(inventory(f),cold);assert.deepEqual(eventInventory(f),beforeEvents);await unchangedNative(f,native,identity);
 const attempted=await reject(f,approved.body,{code:'STALE_REVISION',reason:'ENCODED_REBUILD_REVIEW_REQUIRED'}),value=await observation(f,attempted.request.command.commandId);released(value);assert.deepEqual(value.workerJobs,[]);
});

function clientFor(f,paired){
 return {...f,paired,read:path=>call(f.server.origin,path,{headers:readHeaders(cookieFrom(paired))}),post:(path,body)=>call(f.server.origin,path,{method:'POST',body,headers:mutationHeaders(f.server,paired)}),command:(patch={},body={})=>command(EMPTY_EXPECTED_VERSIONS,{clientId:paired.json.clientId,...patch},body)};
}
test('deferred native review is bound to the authenticated client, renewed session and finite review clock',{timeout:180000},async t=>{
 let now=Date.now(),f=await fixture(t,{now:()=>now});const c=await candidate(f),approved=await reviewed(f,placement(c));
 await f.server.refreshPairing();
 const foreignPair=await pair(f.server);assert.equal(foreignPair.status,200,foreignPair.text);const foreign=clientFor(f,foreignPair);assert.notEqual(foreign.paired.json.clientId,f.paired.json.clientId);
 const inaccessible=await foreign.read('/api/v1/image-edit-reviews/'+approved.review.reviewId);assert.equal(inaccessible.status,403,inaccessible.text);
 await reject(f,approved.body,{client:foreign,code:'INVALID_INPUT',reason:'IMAGE_REVIEW_EXPIRED'});
 const renewed=await f.post('/api/v1/session/renew',{protocolVersion:1});assert.equal(renewed.status,200,renewed.text);assert.equal(renewed.json.clientId,f.paired.json.clientId);f=clientFor(f,renewed);
 await reject(f,approved.body,{code:'INVALID_INPUT',reason:'IMAGE_REVIEW_EXPIRED'});
 const expiring=await reviewed(f,placement(c)),deadline=Date.parse(expiring.review.expiresAt);assert(deadline>now);
 now=deadline-1;await f.syncClock();assert.equal((await f.read('/api/v1/session')).status,200,'Keep the authenticated session live immediately before review expiry');assert.equal((await f.read('/api/v1/image-edit-reviews/'+expiring.review.reviewId)).status,200);
 now=deadline;await f.syncClock();await reject(f,expiring.body,{code:'INVALID_INPUT',reason:'IMAGE_REVIEW_EXPIRED'});
});

async function importBundle(f,review){
 const request=f.command({documentId:null,expectedDocumentRevision:null,body:{type:'ImportBundle',reviewId:review.reviewId,reviewHash:review.reviewHash}}),deadline=performance.now()+30000;
 let response=await f.post('/api/v1/commands',request);
 while(response.status===202&&performance.now()<deadline){assert.equal(response.headers.location,response.json.receiptUrl);await new Promise(resolve=>setTimeout(resolve,10));response=await f.read('/api/v1/commands/'+request.command.commandId);}
 assert.equal(response.status,200,response.text);assert.equal(response.json.receipt.status,'accepted',response.text);return response.json.receipt;
}
async function archiveComparisons(f,bytes,expected){
 const entries=await unpack(f.root,bytes),manifest=JSON.parse(entries.get('manifest.json'));assert.equal(manifest.formatVersion,13);assert.equal(manifest.documentSchema,13);
 const comparisons=records(entries).values.filter(record=>record.kind==='entity'&&record.entityType==='asset').map(record=>JSON.parse(entries.get('objects/'+record.payloadRef.hash.slice(7)))).filter(value=>value.raster&&JSON.parse(entries.get('objects/'+value.raster.manifest.hash.slice(7))).plan.kind==='candidate-lettering-comparison-v1');
 assert.equal(comparisons.length,3);
 for(const value of comparisons){
  const raster=JSON.parse(entries.get('objects/'+value.raster.manifest.hash.slice(7))),original=expected.get(raster.plan.comparison);assert(original);assert.equal(value.qualification,'canonical-png');assert.equal(value.raster.role,'export');assert.equal(raster.plan.preservation,'not-applied');assert.deepEqual(value.blob,original.asset.blob);assert.deepEqual(value.raster.pixels,original.asset.raster.pixels);assert.equal(value.raster.pixelIdentity,original.asset.raster.pixelIdentity);assert.deepEqual(entries.get('objects/'+value.blob.hash.slice(7)),original.encoded);assert.deepEqual(entries.get('objects/'+value.raster.pixels.hash.slice(7)),original.pixels);assert.deepEqual(entries.get('objects/'+original.asset.raster.manifest.hash.slice(7)),original.manifest,'Re-copy must retain the original comparison manifest bytes');
 }
 return {entries,comparisons};
}
async function comparisonReplayControls(t,f,sourceId,expected,original,originalState){
 // Reuse the real closed fixture. Faults belong only to independently owned
 // copies; the original journal and retained evidence remain untouched.
 await f.server.close();
 const database=join(f.root,'metadata.sqlite'),databaseHash=sha(await readFile(database));
 const journal=root=>{const db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});try{return db.prepare('SELECT seq,family,id,json FROM candidate_journal ORDER BY seq').all();}finally{db.close();}};
 const originalJournal=journal(f.root),sourceRows=originalJournal.filter(row=>row.family==='asset'&&row.id===sourceId);assert(sourceRows.length>0);
 const source=JSON.parse(sourceRows.at(-1).json);assert.equal(source.qualification,'canonical-raster');assert.equal(source.safety,'safe');assert.equal(source.availability,'available');
 assert([...expected.values()].some(row=>row.asset.raster.sourceAssetIds.includes(sourceId)),'The fault must target an actual retained comparison dependency');
 const db=new DatabaseSync(database,{readOnly:true});try{assert.equal(db.prepare("SELECT count(*) n FROM events_v2 WHERE json_extract(json,'$.type')='AssetRegistered' AND json_extract(json,'$.payload.asset.id')=?").get(sourceId).n,0,'The comparison source must depend on candidate journal replay');}finally{db.close();}
 const rewrite=(root,change)=>{
  const db=new DatabaseSync(join(root,'metadata.sqlite'));
  try{
   const triggers=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN ('candidate_journal_update','candidate_journal_delete') ORDER BY name").all();assert.equal(triggers.length,2);
   db.exec('BEGIN IMMEDIATE');for(const trigger of triggers)db.exec('DROP TRIGGER '+trigger.name);
   change(db);for(const trigger of triggers)db.exec(trigger.sql);db.exec('COMMIT');
   assert.deepEqual(db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN ('candidate_journal_update','candidate_journal_delete') ORDER BY name").all(),triggers);
  }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}finally{db.close();}
 };
 try{for(const failure of ['missing','invalid']){
  const root=await rootFor(t);await cp(f.root,root,{recursive:true});assert.equal(sha(await readFile(join(root,'metadata.sqlite'))),databaseHash);assert.deepEqual(journal(root),originalJournal);
  // Preserve ordinary missing/corrupt object recovery. These faults remove or
  // invalidate replayed dependency metadata, with all retained bytes intact.
  rewrite(root,db=>{if(failure==='missing')db.prepare("DELETE FROM candidate_journal WHERE family='asset' AND id=?").run(sourceId);else db.prepare('UPDATE candidate_journal SET json=? WHERE seq=?').run(canonical({...source,safety:'quarantined'}),sourceRows.at(-1).seq);});
  const failedJournal=journal(root);let unexpected;
  try{await assert.rejects(async()=>{unexpected=await openWriter({root});},{code:'CORRUPT_STORE'},failure+' comparison dependency metadata must refuse startup');}finally{await unexpected?.close();}
  assert.deepEqual(journal(root),failedJournal,'Refused startup retains the exact faulty journal for diagnosis');
  // openWriter joins a rejected worker before returning. Restoring exact rows
  // and opening this same root also proves that the failed writer released it.
  rewrite(root,db=>{db.prepare("DELETE FROM candidate_journal WHERE family='asset' AND id=?").run(sourceId);for(const row of sourceRows)db.prepare('INSERT INTO candidate_journal(seq,family,id,json) VALUES (?,?,?,?)').run(row.seq,row.family,row.id,row.json);});assert.deepEqual(journal(root),originalJournal);
  const repaired=await openWriter({root});
  try{
   assert.deepEqual(await repaired.document(documentId),original);assert.deepEqual(await repaired.imageState(documentId),originalState);assert.deepEqual((await repaired.assetProjection(sourceId)).asset,source);
   for(const row of expected.values()){assert.deepEqual((await repaired.assetProjection(row.asset.id)).asset,row.asset);assert.deepEqual(await repaired.rasterManifest(row.asset.id),JSON.parse(row.manifest));}
  }finally{await repaired.close();}
  assert.deepEqual(journal(root),originalJournal);
 }}finally{assert.equal(sha(await readFile(database)),databaseHash);assert.deepEqual(journal(f.root),originalJournal);}
}
test('real native comparison review and adoption copy as PF13; import and re-copy retain exact pixels without granting preparation authority',{timeout:240000},async t=>{
 let f=await fixture(t);const c=await candidate(f),approved=await reviewed(f,placement(c)),expected=new Map();
 for(const row of approved.manifest.images){const value=await asset(f,row.assetId);expected.set(row.comparison,{asset:value,encoded:await retained(f,value.blob),pixels:await retained(f,value.raster.pixels),manifest:await retained(f,value.raster.manifest)});}
 const reviewedCopy=await copy(f);await archiveComparisons(f,reviewedCopy.bytes,expected);
 await accept(f,approved);const original=await document(f),originalState=await image(f),saved=await copy(f),archive=await archiveComparisons(f,saved.bytes,expected);assert((await f.effects()).length>0);
 await probeMax12Refusal(t,{bytes:saved.bytes,comparisonManifestHashes:[...expected.values()].map(row=>row.asset.raster.manifest.hash),root:f.root});
 f=await f.reopen();assert.deepEqual(await document(f),original);assert.deepEqual(await image(f),originalState);assert.deepEqual(await f.effects(),[],'Reopening a copied native document does not rerun provider work');
 const downgraded=new Map(archive.entries),header=JSON.parse(downgraded.get('manifest.json'));header.formatVersion=12;header.documentSchema=12;downgraded.set('manifest.json',encoded(header));
 const wrong=await upload(f,await pack(f.root,downgraded)),rejected=await terminal(f,f.command({documentId:null,expectedDocumentRevision:null,body:{type:'PreviewBundleImport',stagingId:wrong.stagingId,expectedSha256:wrong.sha256}}));assert.equal(rejected.json.receipt.status,'rejected',rejected.text);assert.deepEqual(await document(f),original);assert.deepEqual(await image(f),originalState);
 const reviewCount=()=>{const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});try{return db.prepare('SELECT count(*) n FROM image_edit_reviews').get().n;}finally{db.close();}},beforeReviews=reviewCount();
 const cold=inventory(f),prepared=(await previewCopy(f,saved.bytes)).review;assert.equal(prepared.editable,true,JSON.stringify(prepared));await importBundle(f,prepared);assert.equal(reviewCount(),beforeReviews,'Portable observations do not recreate live image review authority');
 const imported=(await f.read('/api/v1/documents/'+prepared.documentId+'/candidates')).json;assert.equal(imported.items.length,1);assert(imported.items.every(item=>item.inert===true));assert(!(await f.read('/api/v1/queue')).json.jobs.some(job=>job.documentId===prepared.documentId));
 for(const item of imported.items){const view=(await f.read('/api/v1/jobs/'+item.jobId+'/candidates?attempt='+item.attemptId)).json;assert.equal(view.inert,true);assert.equal(view.items.length,1);assert.deepEqual(view.repair,{});}
 const importedComparisons=[];for(const row of inventory(f).assets.filter(row=>!cold.assets.some(previous=>previous.id===row.id))){const value=JSON.parse(row.json);if(value.raster?.role!=='export')continue;const manifest=JSON.parse(await retained(f,value.raster.manifest));if(manifest.plan.kind==='candidate-lettering-comparison-v1'){
  const original=expected.get(manifest.plan.comparison);assert(original);assert.notEqual(value.id,original.asset.id);assert.equal(value.qualification,'canonical-png');assert.deepEqual(value.blob,original.asset.blob);assert.equal(value.raster.pixelIdentity,original.asset.raster.pixelIdentity);assert.deepEqual(await pixels(f,value.id),original.pixels);
  const ids=[...new Set(manifest.plan.layers.flatMap(layer=>[layer.assetId,...(layer.mask?[layer.mask.assetId]:[])]))];assert.deepEqual(value.raster.sourceAssetIds,ids);assert(ids.every(id=>!original.asset.raster.sourceAssetIds.includes(id)));
  const linked=[];for(const id of ids){const current=await asset(f,id);assert.equal(current.safety,'safe');assert.equal(current.availability,'available');assert.equal(current.qualification,'canonical-raster');linked.push(current.raster.manifest);}
  assert.deepEqual(manifest.dependencies.map(canonical).sort(),linked.map(canonical).sort());importedComparisons.push(value);
 }}
 assert.equal(importedComparisons.length,3);
 const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});try{assert.equal(db.prepare('SELECT count(*) n FROM candidate_adoption_evidence WHERE document_id=?').get(prepared.documentId).n,0);for(const value of importedComparisons)assert.equal(db.prepare('SELECT count(*) n FROM candidate_asset_evidence WHERE asset_id=?').get(value.id).n,0);}finally{db.close();}
 const recopied=await copy(f,prepared.documentId);await archiveComparisons(f,recopied.bytes,expected);assert.deepEqual(await document(f),original);assert.deepEqual(await image(f),originalState);assert.deepEqual(await f.effects(),[]);
 await comparisonReplayControls(t,f,approved.review.inputs.identity.preparedAssetId,expected,original,originalState);
});

function acceptanceContractHarness({deadline=10100}={}){
 const controller=new AbortController(),commandId='acceptance_contract_command',path='/api/v1/commands/'+commandId;
 const f={server:{origin:'http://127.0.0.1:1'},paired:{headers:{'set-cookie':['contract_cookie=value; Path=/']},json:{csrfToken:'contract_csrf'}}},request={command:{commandId}};
 const h={f,request,controller,clock:100,calls:[],sleeps:[],timers:[],canceled:[],observations:[]};
 h.pending=()=>({status:202,headers:{location:path},json:{commandId,receiptUrl:path,operationId:'contract_operation',phase:'preparing'},text:'pending'});
 h.accepted=()=>({status:200,headers:{},json:{receipt:{status:'accepted',commandId}},text:'accepted'});
 h.owner={deadline,signal:controller.signal,observe:value=>h.observations.push(value)};
 h.respond=()=>h.pending();
 h.runtime={
  now:()=>h.clock,
  sleep:async(ms,signal)=>{signal.throwIfAborted();h.sleeps.push({ms,signal});h.clock+=ms;signal.throwIfAborted();},
  send:async(url,options,signal)=>{signal.throwIfAborted();h.calls.push({url,options,signal});return h.respond(url,options,signal);},
  schedule:(callback,delay)=>{const token={};h.timers.push({callback,delay,token});return token;},
  cancel:token=>h.canceled.push(token),
 };
 return h;
}
function acceptanceContractCleanup(h){
 assert.equal(getEventListeners(h.owner.signal,'abort').length,0,'The owner abort listener must be removed');
 assert.deepEqual(h.canceled,h.timers.map(timer=>timer.token),'Each one-shot deadline timer must be canceled exactly once');
 for(const call of h.calls)assert.equal(getEventListeners(call.signal,'abort').length,0,'No completed transport may retain an abort listener');
}

test('native acceptance uses the same fixed deadline for fast and slow pending replies beyond the old poll ceiling',async()=>{
 const outcomes=[];
 for(const [latency,expectedPolls,expectedElapsed] of [[0,1003,5015],[20,200,5020]]){
  const h=acceptanceContractHarness(),finishAt=5115,deadline=h.owner.deadline,requestBefore=structuredClone(h.request);
  h.respond=()=>{h.clock+=latency;return h.clock>=finishAt?h.accepted():h.pending();};
  const result=await terminalAcceptance(h.f,h.request,h.owner,h.runtime);
  assert.deepEqual(result,h.accepted());assert.deepEqual(h.request,requestBefore);assert.equal(h.owner.deadline,deadline);assert(h.clock<deadline);
  assert.equal(h.calls.length,expectedPolls+1);assert.equal(h.calls[0].url,'/api/v1/commands');assert.equal(h.calls[0].options.method,'POST');assert.strictEqual(h.calls[0].options.body,h.request);
  assert.deepEqual(h.calls[0].options.headers,mutationHeaders(h.f.server,h.f.paired));
  for(const call of h.calls.slice(1)){assert.equal(call.url,'/api/v1/commands/'+h.request.command.commandId);assert.equal(call.options.method??'GET','GET');assert.equal(call.options.body,undefined);assert.deepEqual(call.options.headers,readHeaders(cookieFrom(h.f.paired)));assert.strictEqual(call.signal,h.calls[0].signal);}
  assert.equal(h.sleeps.length,expectedPolls);assert(h.sleeps.every(wait=>wait.ms===5&&wait.signal===h.calls[0].signal));
  assert.equal(h.timers.length,1);assert.equal(h.timers[0].delay,10000,'The timer uses the remaining whole-case deadline and is never reset');
  const terminalPoint={kind:'native-acceptance-wait-1',point:'terminal',commandId:h.request.command.commandId,polls:expectedPolls,elapsedMs:expectedElapsed,receiptStatus:'accepted'};
  assert.deepEqual(h.observations,latency===0?[{kind:'native-acceptance-wait-1',point:'original-poll-limit',commandId:h.request.command.commandId,polls:1000,elapsedMs:5000,operationId:'contract_operation',phase:'preparing'},terminalPoint]:[terminalPoint]);
  acceptanceContractCleanup(h);outcomes.push({deadline:h.owner.deadline,finishAt,polls:h.sleeps.length});
 }
 assert.deepEqual(outcomes,[{deadline:10100,finishAt:5115,polls:1003},{deadline:10100,finishAt:5115,polls:200}]);
});

test('native acceptance deadline exhaustion stops before another receipt GET and never reposts',async()=>{
 const h=acceptanceContractHarness({deadline:112});
 await assert.rejects(terminalAcceptance(h.f,h.request,h.owner,h.runtime),{code:'NATIVE_ACCEPTANCE_CASE_DEADLINE'});
 assert.equal(h.clock,115);assert.equal(h.owner.deadline,112);assert.deepEqual(h.calls.map(call=>[call.options.method??'GET',call.url]),[['POST','/api/v1/commands'],['GET','/api/v1/commands/acceptance_contract_command'],['GET','/api/v1/commands/acceptance_contract_command']]);
 assert.deepEqual(h.sleeps.map(wait=>wait.ms),[5,5,5]);assert.equal(h.timers.length,1);assert.equal(h.timers[0].delay,12);assert.deepEqual(h.observations,[]);acceptanceContractCleanup(h);
});

test('native acceptance refuses an already-aborted owner without opening a request or scheduling a timer',async()=>{
 const h=acceptanceContractHarness(),reason=new Error('case already canceled');h.controller.abort(reason);
 await assert.rejects(terminalAcceptance(h.f,h.request,h.owner,h.runtime),error=>error===reason);
 let opened=0;await assert.rejects(acceptanceHTTP(h.f,'/api/v1/commands',{method:'POST'},h.owner.signal,()=>{opened++;throw new Error('must not open');}),error=>error===reason);
 assert.equal(opened,0);assert.deepEqual(h.calls,[]);assert.deepEqual(h.sleeps,[]);assert.deepEqual(h.timers,[]);assert.deepEqual(h.observations,[]);acceptanceContractCleanup(h);
});

test('native acceptance rejects a pending response that changes its receipt location or command identity',async()=>{
 for(const mutate of [response=>{response.headers.location='/api/v1/commands/other';},response=>{response.headers.location=response.json.receiptUrl='/api/v1/commands/other';},response=>{response.json.commandId='other';}]){
  const h=acceptanceContractHarness();h.respond=()=>{const response=h.pending();mutate(response);return response;};
  await assert.rejects(terminalAcceptance(h.f,h.request,h.owner,h.runtime),{code:'ERR_ASSERTION'});
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].options.method,'POST');assert.deepEqual(h.sleeps,[]);assert.deepEqual(h.observations,[]);assert.equal(h.timers.length,1);acceptanceContractCleanup(h);
 }
});

function acceptanceContractExchange(onOpen){
 const requests=[];
 const open=(origin,path,options)=>{
  const request=new EventEmitter();let resolve,reject;const response=new Promise((yes,no)=>{resolve=yes;reject=no;});
  const row={origin,path,options,request,response,resolve,reject,destroyed:[]};
  request.destroy=error=>{row.destroyed.push(error);reject(error);return request;};requests.push(row);onOpen(row);return {request,response};
 };
 return {open,requests};
}

for(const phase of ['POST','GET'])for(const cancellation of ['owner','deadline'])test('native acceptance '+cancellation+' cancellation destroys and drains the active '+phase+' before rejecting',async()=>{
 const h=acceptanceContractHarness();let opened;const activeReady=new Promise(resolve=>{opened=resolve;});
 const transport=acceptanceContractExchange(row=>{
  if(phase==='GET'&&row.options.method==='POST')queueMicrotask(()=>{row.resolve(h.pending());row.request.emit('close');});
  else opened(row);
 });
 h.respond=(path,options,signal)=>acceptanceHTTP(h.f,path,options,signal,transport.open);
 let settled=false;const wait=terminalAcceptance(h.f,h.request,h.owner,h.runtime),monitor=wait.then(()=>{settled=true;},()=>{settled=true;});
 const reason=new Error('whole case canceled'),rejection=assert.rejects(wait,error=>cancellation==='owner'?error===reason:error.code==='NATIVE_ACCEPTANCE_CASE_DEADLINE');
 const active=await activeReady,signal=h.calls.at(-1).signal;assert.equal(active.options.method??'GET',phase);assert.equal(active.request.listenerCount('close'),1);assert.equal(getEventListeners(signal,'abort').length,1,'Only the active exchange may retain an abort listener');assert.equal(h.timers.length,1);
 if(cancellation==='owner')h.controller.abort(reason);else h.timers[0].callback();
 // One event-loop turn drains promise reactions; it is not an elapsed-time test.
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(settled,false,'Aborting the response cannot finish until the request closes');assert(active.destroyed.length>=1);assert(active.destroyed.every(error=>error===signal.reason));assert.equal(active.request.listenerCount('close'),1);assert.deepEqual(h.canceled,[],'The waiter is still draining its active exchange');
 active.request.emit('close');await rejection;await monitor;
 assert.equal(settled,true);assert.equal(h.calls.length,phase==='POST'?1:2);assert.equal(h.sleeps.length,phase==='POST'?0:1);assert(h.sleeps.every(value=>value.ms===5));assert.equal(h.calls.filter(call=>call.options.method==='POST').length,1);assert.deepEqual(h.observations,[]);
 for(const row of transport.requests){assert.equal(row.origin,h.f.server.origin);assert.equal(row.request.listenerCount('close'),0);assert.equal(row.request.listenerCount('response'),0);}acceptanceContractCleanup(h);
});

test('native acceptance HTTP waits for the captured incoming message after request close on abort',async()=>{
 const h=acceptanceContractHarness(),transport=acceptanceContractExchange(()=>{}),reason=new Error('abort after response headers'),incoming=new EventEmitter();incoming.closed=false;
 let settled=false;const wait=acceptanceHTTP(h.f,'/api/v1/commands',{method:'POST'},h.owner.signal,transport.open),monitor=wait.then(()=>{settled=true;},()=>{settled=true;}),rejection=assert.rejects(wait,error=>error===reason),row=transport.requests[0];
 row.request.emit('response',incoming);h.controller.abort(reason);row.request.closed=true;row.request.emit('close');
 try{
  await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false,'Request close alone cannot complete while its incoming message is open');assert(row.destroyed.length>=1);assert(row.destroyed.every(error=>error===reason));assert.equal(row.request.listenerCount('close'),0);assert.equal(incoming.listenerCount('close'),1);assert.equal(row.request.listenerCount('response'),1,'Response capture remains installed while draining');
 }finally{incoming.closed=true;incoming.emit('close');}
 await rejection;await monitor;assert.equal(settled,true);assert.equal(incoming.listenerCount('close'),0);assert.equal(row.request.listenerCount('response'),0);acceptanceContractCleanup(h);
});

test('native acceptance HTTP handles already-closed request and incoming-message close races',async()=>{
 for(const closedFirst of ['request','incoming']){
  const h=acceptanceContractHarness();let incoming;
  const transport=acceptanceContractExchange(row=>{
   if(closedFirst==='request'){row.request.closed=true;row.resolve(h.accepted());}
   else queueMicrotask(()=>{incoming=new EventEmitter();incoming.closed=true;row.request.emit('response',incoming);row.resolve(h.accepted());row.request.closed=true;row.request.emit('close');});
  });
  const wait=acceptanceHTTP(h.f,'/api/v1/commands',{method:'POST'},h.owner.signal,transport.open),pending=Symbol('still waiting for an already closed stream');
  try{
   const result=await Promise.race([wait,new Promise(resolve=>setImmediate(()=>resolve(pending)))]);assert.notStrictEqual(result,pending,'An already closed stream must not require another close event');assert.deepEqual(result,h.accepted());
  }finally{
   // Release a defective waiter as well, so a failed assertion leaves no task.
   for(const row of transport.requests){row.request.closed=true;row.request.emit('close');}if(incoming)incoming.emit('close');await wait;
  }
  for(const row of transport.requests){assert.equal(row.request.listenerCount('close'),0);assert.equal(row.request.listenerCount('response'),0);assert.deepEqual(row.destroyed,[]);}if(incoming)assert.equal(incoming.listenerCount('close'),0);acceptanceContractCleanup(h);
 }
});
