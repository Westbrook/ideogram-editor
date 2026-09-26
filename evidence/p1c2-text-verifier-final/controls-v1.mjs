import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {isolated} from './source/tests/text-state/helpers.mjs';
import {terminal,workspace,edit,doc,upload,copy,preview,binary} from './source/tests/portable/helpers.mjs';
import {canonical} from './source/dist/local/server/storage/canonical.js';
import {dependencyIdentity,validateLayout} from './source/dist/local/server/text/validation.js';
const require=createRequire(new URL('./source/package.json',import.meta.url));
const {chromium,webkit,firefox}=require('@playwright/test');const sharp=require('sharp');
const engine=process.argv[2]??'chromium';const out=resolve('../controls-'+engine);await mkdir(out);const root=join(out,'store');await mkdir(root,{mode:0o700});
const callbacks=[],t={after:fn=>callbacks.push(fn)};const summary={engine,target:'648a35abce7c2a91e90c132c38b6868f2790e5a1',cases:[],resetCalls:0,workers:0,closed:0};
const save=()=>writeFile(join(out,'results.json'),JSON.stringify(summary,null,2));
const hash=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
const identify=value=>{const {id,...v}=value;return {...v,id:hash(canonical(v))};};
const object=ref=>join(root,'objects','sha256',ref.hash.slice(7,9),ref.hash.slice(7));
let browser,context,f;const closes=[];
try{
 f=await isolated(t,{root});await terminal(f,f.command({}, {width:120,height:70}));
 const profile=JSON.parse(await readFile('src/text/profile.json'));
 const stageAsset=async(bytes,purpose='text')=>{const s=await upload(f,bytes,purpose,purpose==='caption'?'text/plain':'application/octet-stream');return (await workspace(f,{type:'FinalizeStaging',stagingId:s.stagingId,expectedSha256:s.sha256})).event.payload.asset;};
 const stage=async(bytes,media='application/octet-stream',purpose='text')=>({...((await stageAsset(bytes,purpose)).blob),mediaType:media});
 const pfont=profile.fonts.find(x=>x.id==='NotoSans');const source=await stage(await readFile('vendor/text/'+pfont.file),'application/octet-stream','font'),license=await stage(await readFile('vendor/text/'+pfont.licenseFile),'text/plain','caption');const fonts=[(await edit(f,{type:'ImportFont',source,license,origin:'bundled',embeddingReviewed:true})).event.payload.asset.font];
 browser=await ({chromium,webkit,firefox}[engine]).launch();context=await browser.newContext();const page=await context.newPage();page.on('worker',w=>{summary.workers++;closes.push(new Promise(r=>w.once('close',()=>{summary.closed++;r();})));});
 await page.exposeFunction('stage',async(b,m)=>stage(Buffer.from(b,'base64'),m));await page.exposeFunction('admit',async id=>{const r=await f.post('/api/v1/text-admission/'+id,{protocolVersion:1});assert.equal(r.status,200,r.text);});
 await page.goto(f.server.origin);await page.waitForFunction(()=>!!window.DurableTextPreparation);
 await page.evaluate(()=>{window.prep=new window.DurableTextPreparation({admit:id=>window.admit(id),releaseAdmission:async()=>{},stage:async(blob,media)=>{const bytes=new Uint8Array(await blob.arrayBuffer());let b='';for(let at=0;at<bytes.length;at+=32768)b+=String.fromCharCode(...bytes.subarray(at,at+32768));return window.stage(btoa(b),media);}});});
 let generation=0,lastAdmission;
 for(const name of ['plain','nfd','leading-bom','reversed-line-range','missing-runs','mismatched-pixels','wrong-direction']){
  const before=await doc(f),state=(await f.read('/api/v1/documents/document_1/image')).json,layer=state.layers.find(l=>l.id==='native_text');generation++;
  const text=name==='nfd'?'e\u0301':name==='leading-bom'?'\ufeffAB':'AB';
  const style={primaryFont:fonts[0].bytes.hash,explicitFallbacks:[],sizePx:32,lineHeightMultiplier:1.2,fill:[40,90,190,255],align:'start',direction:'auto'},frame={width:120,height:70};
  const textUtf8=await stage(Buffer.from(text),'text/plain','caption');const draft={schemaVersion:1,kind:'text-draft-1',textUtf8,style,frame,fonts};const asset=await stageAsset(Buffer.from(canonical(draft)),'caption');const ui=(await f.read('/api/v1/ui/session_1')).json;
  const checkpoint=await f.post('/api/v1/ui/session_1',{protocolVersion:1,requestId:randomUUID(),sessionId:'session_1',expectedUISeq:ui.uiSeq,body:{type:'SaveDraft',draft:{id:'independent_draft',generation:String(generation),kind:'text',documentId:before.id,targetLayerId:layer?'native_text':null,expectedDocumentRevision:before.revision,assetId:asset.id,composing:false}}});assert.equal(checkpoint.json.status,'accepted',checkpoint.text);
  const item={name,textUtf8:Buffer.from(text).toString('hex'),expected:['plain','nfd','leading-bom'].includes(name)?'accepted':'rejected',beforeRevision:before.revision};
  const result=await page.evaluate(async args=>{try{const request=await window.textFixture.request(args.text,['NotoSans'],{token:{documentId:'document_1',documentRevision:args.revision,layerId:'native_text',layerVersion:args.layerVersion,sessionId:'session_1',generation:args.generation},frame:{width:120,height:70}});return await window.prep.prepare(request,args.fonts);}catch(e){return {nativeError:{message:e.message,code:e.code,details:e.details}};}},{text,revision:before.revision,layerVersion:layer?.version??'0',generation,fonts});
  if(result.nativeError){item.nativeError=result.nativeError;summary.cases.push(item);await save();continue;}
  lastAdmission=result.admissionId;const candidate=JSON.parse(await readFile(object(result.candidate)));const layout=JSON.parse(await readFile(object(candidate.source.render.layout)));item.nativePrepared=true;item.originalPixels=candidate.source.render.pixels;item.originalLayout=candidate.source.render.layout;
  if(name==='reversed-line-range'){const l=layout.paragraphs[0].lines[0];l.startUtf16=2;l.startUtf8=2;l.endUtf16=0;l.endUtf8=0;}
  if(name==='missing-runs')layout.paragraphs[0].runs=[];
  if(name==='wrong-direction')layout.paragraphs[0].direction='rtl';
  if(['reversed-line-range','missing-runs','wrong-direction'].includes(name))candidate.source.render.layout=await stage(Buffer.from(canonical(layout)),'application/json');
  if(name==='mismatched-pixels'){const bytes=Buffer.alloc(120*70*4);for(let i=0;i<bytes.length;i+=4){bytes[i]=255;bytes[i+2]=255;bytes[i+3]=255;}candidate.source.render.pixels=await stage(bytes,'application/x-ideogram-rgba8');}
  candidate.source.render=identify(candidate.source.render);
  const ref=await stage(Buffer.from(canonical(candidate)),'application/json');
  const body={type:layer?'CommitTextEdit':'CreateTextLayer',layerId:'native_text',...(layer?{layerVersion:layer.version,reviewedDependencyHash:candidate.source.render.dependencyHash}:{name:'Independent text'}),candidate:ref,draft:{sessionId:'session_1',draftId:'independent_draft',generation:String(generation)},admissionId:result.admissionId};
  const command=f.command({expectedDocumentRevision:before.revision,body});const response=await terminal(f,command);item.actual=response.json.receipt.status;item.receipt=response.json;item.afterRevision=(await doc(f)).revision;item.pass=item.expected===item.actual;
  item.draft=(await f.read('/api/v1/ui/session_1')).json.drafts.find(d=>d.id==='independent_draft');
  await writeFile(join(out,name+'-candidate.json'),canonical(candidate));await writeFile(join(out,name+'-layout.json'),canonical(layout));await writeFile(join(out,name+'-command.json'),JSON.stringify(command));
  if(item.actual==='accepted'){
   const acceptedState=(await f.read('/api/v1/documents/document_1/image')).json,accepted=JSON.parse(await readFile(object(acceptedState.layers[0].source)));item.savedTextExact=(await readFile(object(accepted.text.textUtf8))).equals(Buffer.from(text));assert(item.savedTextExact);
   const current=await doc(f),exported=await edit(f,{type:'ExportDocument',historyHead:current.historyHead});const png=await binary(f,'/api/v1/assets/'+exported.event.payload.asset.id+'/content');const decoded=await sharp(png.bytes).ensureAlpha().raw().toBuffer();const dbmod=await import('node:sqlite');const db=new dbmod.DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});const composite=JSON.parse(db.prepare('SELECT json FROM assets WHERE id=?').get(current.image.compositeAssetId).json);db.close();item.exportMatchesSavedComposite=decoded.equals(await readFile(object(composite.raster.pixels)));assert(item.exportMatchesSavedComposite);
   if(name!=='plain'){await edit(f,{type:'Undo',historyHead:(await doc(f)).historyHead});item.undoExact=canonical((await doc(f)).image)===canonical(before.image);assert(item.undoExact);}
  }else assert.deepEqual(await doc(f),before);
  summary.cases.push(item);await save();
  // Keep the first valid layer active; all later controls use its exact source.
  if(name==='plain'){
   const d=await doc(f);if(!d.orderedLayerIds.length){await edit(f,{type:'Redo',historyNode:d.redo});}
  }
 }
 summary.ownedBeforeDispose=await page.evaluate(()=>window.textMemory.snapshot);summary.earlyRelease=await page.evaluate(async()=>{try{await window.releaseTextRealm({releaseAdmission:async()=>{throw Error('Unexpected release callback');}});return 'released';}catch(e){return e.message;}});assert.equal(summary.earlyRelease,'TEXT_REALM_STILL_OWNED');await page.evaluate(()=>{window.prep.dispose();window.textFixture.renderer.dispose();});summary.ownedAfterDispose=await page.evaluate(()=>window.textMemory.snapshot);await Promise.race([Promise.all(closes),new Promise((_,j)=>setTimeout(()=>j(Error('No actual close observation')),10000).unref())]);await context.close();context=null;
 if(lastAdmission){const {DatabaseSync}=await import('node:sqlite');const count=()=>{const db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});try{return Number(db.prepare('SELECT count(*) n FROM text_admissions').get().n);}finally{db.close();}};assert.equal(count(),1);for(let i=0;i<3;i++)assert.equal((await f.post('/api/v1/text-admission/'+lastAdmission,{protocolVersion:1})).status,200);assert.equal(count(),1);for(let i=0;i<2;i++)assert.equal((await f.post('/api/v1/text-admission/'+lastAdmission+'/release',{protocolVersion:1})).status,200);assert.equal(count(),0);summary.duplicateRenewalOneRow=true;summary.releaseAfterObservedCloseExactlyOnce=true;}
 const copied=await copy(f);await writeFile(join(out,'all-history.ideogram-project'),copied.bytes);const reviewed=await preview(f,copied.bytes);summary.fullHistoryReview={editable:reviewed.review.editable,reason:reviewed.review.reason,source:reviewed.review.source};summary.complete=true;summary.failures=summary.cases.filter(c=>c.pass===false||c.nativeError);await save();
} catch(e){summary.fatal={message:e.message,stack:e.stack};await save();throw e;}
finally{if(context)await context.close();if(browser)await browser.close();if(f)await f.server.close();for(const fn of callbacks.reverse())await fn();await save();}
console.log(JSON.stringify(summary,null,2));if(summary.failures?.length)process.exitCode=1;
