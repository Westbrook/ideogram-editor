import {displayPreviewURL,displayProtocolURL,displaySchedulerURL} from '../display-module.mjs';
import {allocationsURL,ownedPreviewURL} from '../owned-preview-module.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {transformWithOxc} from 'vite';
import {createHash} from 'node:crypto';
import {deflateSync,inflateSync} from 'node:zlib';
import {newDraft,hash,bindRequestMask,confirmRequestMask} from '../../dist/local/src/request/core.js';
import {createActualOutputMapping} from '../../dist/local/src/request/raster-plan.js';

const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const lit=data('export const nothing=null;export function html(strings,...values){return {strings,values};}export const svg=html;');
const controls=data((await transformWithOxc(await readFile('src/ui/adapters.ts','utf8'),'adapters.ts')).code);
// Template controller tests retain URL bindings; native element admission is covered by display-image tests.
const imports={'./display-image.js':data('export const displayImage=value=>value;'),'../observability/display-preview.js':displayPreviewURL,'../observability/owned-preview.js':ownedPreviewURL,'../observability/allocations.js':allocationsURL,'lit':lit,'./adapters.js':controls,...Object.fromEntries(['request/core','request/raster-plan','raster/mask','raster/mapping'].map(name=>['../'+name+'.js',pathToFileURL(resolve('dist/local/src/'+name+'.js')).href]))};
async function moduleURL(name,extra={}){let code=(await transformWithOxc(await readFile('src/ui/'+name+'.ts','utf8'),name+'.ts')).code;code=code.replace(/import\s+["']\.\/(?:request-edits|candidate-comparison)\.css["'];?/g,'');for(const [name,url]of Object.entries({...imports,...extra}))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));return data(code);}
const comparison=await moduleURL('candidate-comparison'),{RequestEdits}=await import(await moduleURL('request-edits',{'./candidate-comparison.js':comparison}));
const {displayReadOwnership}=await import(displaySchedulerURL);
const {displayPreviewInfo}=await import(displayPreviewURL),{displayPath,displayDimensions,DISPLAY_HEADERS,DISPLAY_PROFILE}=await import(displayProtocolURL);
const ref=(label,byteLength='64',mediaType='application/x-ideogram-rgba8')=>({hash:hash(label),byteLength,mediaType});
const metadata=label=>ref(label,'32','application/json');
const turn=async()=>{await new Promise(resolve=>setTimeout(resolve,0));await new Promise(setImmediate);};
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();await new Promise(setImmediate);for(let i=0;i<20;i++)await Promise.resolve();};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function event(){const target={isConnected:true};return {currentTarget:target,composedPath:()=>[target],defaultPrevented:false,timeStamp:123};}
function rendered(template){
 const slots=[];const expand=value=>value===null||value===undefined?'':Array.isArray(value)?value.map(expand).join(''):value?.strings?value.strings.reduce((all,text,i)=>all+text+(i<value.values.length?expand(value.values[i]):''),''):'__slot'+(slots.push(value)-1)+'__';
 const markup=expand(template),text=value=>value.replace(/__slot(\d+)__/g,(_,i)=>String(slots[Number(i)]));
 const binding=(attrs,name)=>{const match=new RegExp(name+'=__slot(\\d+)__').exec(attrs);return match?slots[Number(match[1])]:undefined;};
 const attr=(attrs,name)=>{const match=new RegExp('(?:^|\\s)'+name+'=(?:"([^"]*)"|([^ >]+))').exec(attrs);return match?text(match[1]??match[2]):null;};
 return {markup,text:text(markup.replace(/<[^>]+>/g,'')),buttons:[...markup.matchAll(/<en-button\b([^>]*)>([\s\S]*?)<\/en-button>/g)].map(([,attrs,label])=>({id:attr(attrs,'id'),label:text(label),disabled:!!binding(attrs,'\\?disabled'),click:binding(attrs,'@click')})),images:[...markup.matchAll(/<img\b([^>]*)>/g)].map(([,attrs])=>{const src=attr(attrs,'src'),info=displayPreviewInfo(src);return {src,alt:attr(attrs,'alt'),load:binding(attrs,'@load'),naturalWidth:info?.width,naturalHeight:info?.height};})};
}
async function fixture(t,{actualWidth=4,actualHeight=4,blank=false}={}){
 installPNGDecoder(t);
 const source={assetId:'source',version:'1',blob:ref('source-png','24','image/png'),pixels:ref('source-pixels'),width:4,height:4,scope:'single-layer',documentRevision:'7',capture:metadata('capture')};
 const mask={assetId:'mask',version:'1',blob:ref('mask-png','24','image/png'),pixels:ref('mask-pixels'),width:4,height:4,sourceHash:source.pixels.hash,polarity:'white-edit',fullAcknowledged:false,empty:false,full:false,plan:metadata('mask-manifest'),binding:bindRequestMask(source)};
 mask.requestPlan=confirmRequestMask(source,mask,ref('authored','32','application/x-ideogram-r16le'),ref('effective','32','application/x-ideogram-r16le'),'approved-request');
 const candidate={id:'candidate',version:'2',documentId:'document',jobId:'job',attemptId:'attempt',requestId:'provider-request',outputIndex:0,outputIdentity:'output',safety:'safe',state:'prepared',hidden:false,encodedAssetId:'encoded',preparedAssetId:'returned',warning:null};
 const image={state:metadata('document-image'),semanticDigest:hash('document-state'),compositeAssetId:blank?null:'before'};
 const document={id:'document',revision:'7',width:4,height:4,image};
 const capture={schemaVersion:1,documentId:document.id,documentRevision:document.revision,image,scope:'single-layer',layerIds:['picture']};
 const asset={id:'returned',version:'1',availability:'available',safety:'safe',blob:ref('returned-png','24','image/png'),raster:{width:actualWidth,height:actualHeight,pixelIdentity:hash('returned-canonical-pixel-identity'),pixels:ref('returned-pixels',String(actualWidth*actualHeight*4)),manifest:metadata('returned-manifest')}};
 const view={protocolVersion:1,jobId:'job',documentId:'document',request:{endpoint:'ideogram/v4/inpaint',prompt:ref('prompt','6','text/plain'),seed:null,raster:{source,mask,plan:mask.requestPlan}},items:[candidate],requestedCount:1,actualCount:1,observation:{phase:'completed'},provenance:null,inert:false,nextCursor:null};
 const draft=newDraft(ref('prompt','6','text/plain')),commands=[],reads=[],transfers=[],errors=[],starts=[],failures=[],opened=[];let identity='client',latestReview,commandOverride=null,jsonOverride=null,controller,template;
 const displayAssets=new Map([['returned',asset],['source',{...displayAsset('source'),version:source.version,blob:source.blob,raster:{...displayAsset('source').raster,width:source.width,height:source.height,pixels:source.pixels,manifest:source.capture}}],['mask',{...displayAsset('mask'),version:mask.version,blob:mask.blob,raster:{...displayAsset('mask').raster,width:mask.width,height:mask.height,pixels:mask.pixels,manifest:mask.plan}}]]),descriptor=id=>displayAssets.get(id)??displayAsset(id);
 const editor={view:{ready:true,document,selected:['picture']},draftOwner:{drafts:new Map()},sessionId:'session',session:{identity:()=>identity,async transport(path){transfers.push(path);return displayRoute(path,descriptor);}},
  async json(path){reads.push(path);if(jsonOverride)return jsonOverride(path);if(path==='/api/v1/assets/returned')return {projection:{value:structuredClone(asset)}};if(path.startsWith('/api/v1/jobs/job/candidates'))return structuredClone(view);if(path.startsWith('/api/v1/image-edit-reviews/'))return structuredClone(latestReview);throw Error('Unexpected metadata read '+path);},
  async command(body,target,newDocumentId){commands.push({body:structuredClone(body),target:structuredClone(target),newDocumentId});if(commandOverride)return commandOverride(body,target,newDocumentId);
   if(body.type==='ReviewCandidatePlacement'){
    const {type,...placement}=body,outputMapping=body.actualOutput?createActualOutputMapping(mask.requestPlan,{actualOutput:{width:actualWidth,height:actualHeight},effectiveMask:body.actualOutput.clipMask?ref('clipped-effective','32','application/x-ideogram-r16le'):mask.requestPlan.effectiveMask,resolution:body.actualOutput.clipMask?'clipped-and-approved':'already-contained',approvalId:'actual-grid-review'}):null;
    latestReview={protocolVersion:1,kind:'candidate-placement-review-1',preparation:'deferred',reviewId:'placement-review',reviewHash:hash('placement-review'),targetClientId:'client',expiresAt:new Date(Date.now()+60000).toISOString(),documentId:document.id,documentRevision:document.revision,source:image,placement,inputs:{kind:'candidate-adoption-inputs-1',mode:body.mode,identity:{candidateId:candidate.id,candidateVersion:candidate.version,documentId:document.id,jobId:candidate.jobId,attemptId:candidate.attemptId,requestId:candidate.requestId,outputIdentity:candidate.outputIdentity,preparedAssetId:asset.id,preparedAssetVersion:asset.version,preparedAssetHash:asset.blob.hash,requestHash:hash('request'),jobVersion:'3',writerEpoch:'epoch'},plan:mask.requestPlan,sourceCapture:capture,outputMapping,coverage:{originalEffectivePixels:4,effectivePixels:body.actualOutput?.clipMask?1:4,lostPixels:body.actualOutput?.clipMask?3:0}},width:4,height:4};
    return [{type:'CandidatePlacementReviewPrepared',payload:{reviewId:latestReview.reviewId,reviewHash:latestReview.reviewHash}}];
   }
   if(body.type==='AdoptReviewedCandidate')return latestReview.placement.placement==='new-document'?[{type:'DocumentCreated',payload:{document:{...document,id:latestReview.placement.newDocumentId}}}]:[{type:'ImageEdited',payload:{}}];
   throw Error('Unexpected preparation or mutation '+body.type);
  },beginFeedback(){},beginAdoption(...args){starts.push(args);},adoptionFailed(id){failures.push(id);},async open(id){opened.push(id);}};
 const host={requestUpdate(){this.updateComplete=Promise.resolve().then(()=>{template=controller.renderCandidate(candidate,false);});},updateComplete:Promise.resolve(),querySelector(){return {focus(){}};}};
 const owns=()=>{const owner=editor.draftOwner,session=editor.session,client=session.identity(),sessionId=editor.sessionId,id=editor.view.document.id,revision=editor.view.document.revision;return ()=>owner===editor.draftOwner&&session===editor.session&&client===session.identity()&&sessionId===editor.sessionId&&id===editor.view.document.id&&revision===editor.view.document.revision;};
 controller=new RequestEdits(host,editor,{draft:()=>draft,changed:()=>host.requestUpdate(),owns,error:error=>errors.push(error)});t.after(()=>controller.dispose());await controller.sync();host.requestUpdate();await flush();
 const render=()=>rendered(template),button=id=>{const value=render().buttons.find(button=>button.id===id);assert(value,'Rendered '+id);return value;};
 const click=async(id,{force=false}={})=>{const control=button(id);if(!force)assert.equal(control.disabled,false,'Enabled '+id);const e=event();control.click(e);await flush();await turn();await flush();return e;};
 const load=async image=>{assert.equal(typeof image.load,'function','Image load acknowledgement for '+image.alt);image.load({currentTarget:{src:image.src,currentSrc:image.src,naturalWidth:image.naturalWidth,naturalHeight:image.naturalHeight}});await flush();};
 return {controller,editor,displayAssets,descriptor,source,mask,candidate,view,asset,draft,commands,reads,transfers,errors,starts,failures,opened,render,button,click,load,owns,identity:value=>identity=value,setCommand:fn=>commandOverride=fn,setJSON:fn=>jsonOverride=fn,review:()=>latestReview};
}

const inspectId='request-candidate-prepare-candidate',reviewId='request-candidate-review-current-candidate',newReviewId='request-candidate-review-new-candidate',acceptId='request-candidate-accept-prepare-candidate';
const deferredAlts=['Reviewed target before preparation','Frozen source for deferred preparation','Returned candidate for deferred preparation','Frozen coverage for deferred preparation'];
const deferredImages=f=>f.render().images.filter(image=>deferredAlts.includes(image.alt));
const hasReview=f=>f.render().buttons.some(button=>button.id===acceptId);
async function inspect(f){await f.click(inspectId);assert.deepEqual(f.errors,[]);}
async function review(f,id=reviewId){await f.click(id);assert.deepEqual(f.errors,[]);assert.equal(hasReview(f),true);}
async function loadReview(f){for(const image of deferredImages(f))await f.load(image);}

test('deferred placement reads metadata and exact retained inputs before explicit acceptance prepares and adopts',async t=>{
 const f=await fixture(t),original=structuredClone({document:f.editor.view.document,source:f.source,mask:f.mask});
 await inspect(f);const inspectionImages=f.render().images;assert.equal(inspectionImages.length,3);assert.deepEqual(f.commands,[]);assert.deepEqual(f.starts,[]);
 await review(f);assert.deepEqual(f.commands.map(c=>c.body.type),['ReviewCandidatePlacement']);assert.deepEqual(f.commands[0].target,original.document);assert.equal(f.commands[0].body.actualOutput,null);assert.equal(f.commands[0].body.placement,'current-document');assert.equal(f.commands[0].body.newDocumentId,null);
 assertDisplayReads(f,['returned','source','mask','before']);
 assert.deepEqual(f.starts,[]);assert.match(f.render().text,/final result will be prepared after acceptance/i);assert.equal(f.button(acceptId).disabled,true);
 for(const image of inspectionImages)await f.load(image);assert.equal(f.button(acceptId).disabled,true,'Inspection images do not acknowledge a later placement review');
 const images=deferredImages(f);assert.deepEqual(images.map(i=>i.alt),deferredAlts);assert.equal(images[1].src,inspectionImages[0].src);assert.equal(images[2].src,inspectionImages[1].src);assert.equal(images[3].src,inspectionImages[2].src);
 for(const image of images.slice(0,-1)){await f.load(image);assert.equal(f.button(acceptId).disabled,true,'Every displayed retained input must load');}
 await f.load(images.at(-1));assert.equal(f.button(acceptId).disabled,false);assert.deepEqual({document:f.editor.view.document,source:f.source,mask:f.mask},original);
 const work=deferred();f.setCommand(body=>{assert.equal(body.type,'AdoptReviewedCandidate');return work.promise;});const clicked=await f.click(acceptId);
 assert.deepEqual(f.commands.map(c=>c.body.type),['ReviewCandidatePlacement','AdoptReviewedCandidate']);assert.deepEqual(f.commands[1],{body:{type:'AdoptReviewedCandidate',reviewId:f.review().reviewId,reviewHash:f.review().reviewHash,draft:null},target:original.document,newDocumentId:undefined});
 assert.deepEqual(f.starts,[[{previewId:f.review().reviewId,candidateId:'candidate',jobId:'job',attemptId:'attempt',providerRequestId:'provider-request',documentId:'document',revision:'7'},false,clicked.timeStamp]]);
 assert.equal(hasReview(f),true,'The review stays visible during preparation');assert.equal(f.button(acceptId).disabled,true);assert.deepEqual(f.opened,[]);
 work.resolve([{type:'ImageEdited',payload:{}}]);await flush();assert.equal(hasReview(f),false);assert.deepEqual(f.errors,[]);assert.deepEqual(f.failures,[]);assert.deepEqual({document:f.editor.view.document,source:f.source,mask:f.mask},original);
});

test('blank target review needs only source, candidate and mask loads and adopts the explicit new document identity',async t=>{
 const f=await fixture(t,{blank:true});await inspect(f);await review(f,newReviewId);const placement=f.commands[0].body;
 assert.equal(placement.placement,'new-document');assert.match(placement.newDocumentId,/^[0-9a-f-]{36}$/);assert.equal(f.transfers.some(path=>path.startsWith('/api/v1/assets/before')),false);
 assert.deepEqual(deferredImages(f).map(i=>i.alt),deferredAlts.slice(1));assert.match(f.render().text,/empty transparent document/);assert.equal(f.button(acceptId).disabled,true);
 await loadReview(f);await f.click(acceptId);assert.equal(f.commands.length,2);assert.equal(f.commands[1].target,null);assert.equal(f.commands[1].newDocumentId,placement.newDocumentId);
 assert.equal(f.starts[0][0].documentId,placement.newDocumentId);assert.equal('revision' in f.starts[0][0],false);assert.equal(f.starts[0][1],false);assert.deepEqual(f.opened,[placement.newDocumentId]);assert.deepEqual(f.errors,[]);
});

test('metadata review truthfully reuses an exact prepared result and records warm adoption only on explicit acceptance',async t=>{
 const f=await fixture(t);await inspect(f);f.setJSON(()=>({...structuredClone(f.review()),preparation:'prepared-reuse'}));await review(f);
 assert.match(f.render().text,/exact prepared result is already retained and will be reused/);assert.match(f.render().text,/Placement is composed after acceptance/);assert.doesNotMatch(f.render().text,/final result will be prepared after acceptance/i);assert.deepEqual(f.commands.map(c=>c.body.type),['ReviewCandidatePlacement']);assert.deepEqual(f.starts,[]);assert.equal(f.button(acceptId).disabled,true);
 await loadReview(f);const clicked=await f.click(acceptId);assert.deepEqual(f.commands.map(c=>c.body.type),['ReviewCandidatePlacement','AdoptReviewedCandidate']);assert.equal(f.starts.length,1);assert.equal(f.starts[0][1],true);assert.equal(f.starts[0][2],clicked.timeStamp);assertDisplayReads(f,['returned','source','mask','before']);assert.equal(f.transfers.length,8,'Metadata reuse reads only descriptors and bounded displays; it does not prepare or fetch a full result');assert.deepEqual(f.errors,[]);
});

for(const preparation of [undefined,'unknown'])test('placement receipt requires an explicit supported preparation state: '+String(preparation),async t=>{
 const f=await fixture(t);await inspect(f);f.setJSON(()=>({...structuredClone(f.review()),preparation}));await f.click(reviewId);assert.equal(hasReview(f),false);assert.equal(f.errors.length,1);assert.match(f.errors[0].message,/Placement review changed/);assertDisplayReads(f,['returned','source','mask']);assert.deepEqual(f.starts,[]);
});

test('reviewed target pixels come from the review receipt rather than the mutable document projection',async t=>{
 const f=await fixture(t);await inspect(f);f.setJSON(()=>({...structuredClone(f.review()),source:{...f.review().source,compositeAssetId:'reviewed-before'}}));await review(f);
 assert.equal(f.transfers.at(-1),previewPath(f.descriptor('reviewed-before')));assert.equal(f.transfers.includes('/api/v1/assets/reviewed-before'),true);assert.equal(f.transfers.some(path=>path.startsWith('/api/v1/assets/before')),false);assert.equal(f.button(acceptId).disabled,true);
});

test('old image loads and old acceptance handlers cannot authorize a replacement placement review',async t=>{
 const f=await fixture(t);await inspect(f);await review(f);const oldImages=deferredImages(f);await loadReview(f);const oldAccept=f.button(acceptId).click;
 await review(f);for(const image of oldImages)await f.load(image);assert.equal(f.button(acceptId).disabled,true);oldAccept(event());await turn();await flush();
 assert.deepEqual(f.commands.map(c=>c.body.type),['ReviewCandidatePlacement','ReviewCandidatePlacement']);assert.equal(f.errors.length,1);assert.match(f.errors[0].message,/current, unexpired placement review/);assert.deepEqual(f.starts,[]);
 await loadReview(f);assert.equal(f.button(acceptId).disabled,false);
});

for(const expiry of ['expired','invalid'])test(expiry+' placement review cannot prepare even through a retained click handler',async t=>{
 const f=await fixture(t);await inspect(f);f.setJSON(()=>({...structuredClone(f.review()),expiresAt:expiry==='expired'?new Date(Date.now()-1).toISOString():'invalid-date'}));await review(f);await loadReview(f);
 assert.equal(f.button(acceptId).disabled,true);assert.match(f.render().text,/placement review expired/);await f.click(acceptId,{force:true});assert.equal(f.commands.length,1);assert.equal(f.errors.length,1);assert.deepEqual(f.starts,[]);assert.equal(hasReview(f),true);
});

const replaceOwner={owner:f=>{f.editor.draftOwner={drafts:new Map()};},session:f=>{f.editor.sessionId='replacement-session';},connection:f=>{f.editor.session={...f.editor.session};},identity:f=>f.identity('other-client'),document:f=>{f.editor.view.document={...f.editor.view.document,id:'other-document'};},revision:f=>{f.editor.view.document={...f.editor.view.document,revision:'8'};},disposed:f=>f.controller.dispose()};
for(const [boundary,replace]of Object.entries(replaceOwner))test('deferred acceptance is fenced across '+boundary+' replacement before settled dispatch',async t=>{
 const f=await fixture(t);await inspect(f);await review(f);await loadReview(f);const click=f.button(acceptId).click;click(event());replace(f);await turn();await flush();
 assert.deepEqual(f.commands.map(c=>c.body.type),['ReviewCandidatePlacement']);assert.deepEqual(f.starts,[]);assert.deepEqual(f.errors,[]);assert.deepEqual(f.opened,[]);
});

for(const boundary of ['owner','session','identity','document','revision','disposed'])test('pending placement receipt cannot publish across '+boundary+' replacement',async t=>{
 const f=await fixture(t),receipt=deferred();await inspect(f);f.setJSON(()=>receipt.promise);await f.click(reviewId);assert.equal(f.commands.length,1);assert.equal(hasReview(f),false);
 replaceOwner[boundary](f);receipt.resolve(structuredClone(f.review()));await flush();assert.equal(hasReview(f),false);assertDisplayReads(f,['returned','source','mask']);assert.deepEqual(f.starts,[]);assert.deepEqual(f.errors,[]);
});

for(const [name,change]of Object.entries({kind:r=>{r.kind='image-edit-review-1';},reviewId:r=>{r.reviewId='other-review';},reviewHash:r=>{r.reviewHash=hash('other-review');},document:r=>{r.documentId='other-document';},revision:r=>{r.documentRevision='8';},candidate:r=>{r.inputs.identity.candidateId='other-candidate';},candidateVersion:r=>{r.inputs.identity.candidateVersion='3';},mode:r=>{r.placement.mode='full-candidate';},placement:r=>{r.placement.placement='new-document';},newDocumentId:r=>{r.placement.newDocumentId='unexpected-new-document';}}))test('mismatched '+name+' in placement receipt is rejected before target pixels or acceptance',async t=>{
 const f=await fixture(t);await inspect(f);f.setJSON(()=>{const receipt=structuredClone(f.review());change(receipt);return receipt;});await f.click(reviewId);
 assert.equal(hasReview(f),false);assert.equal(f.errors.length,1);assert.match(f.errors[0].message,/Placement review changed/);assertDisplayReads(f,['returned','source','mask']);assert.deepEqual(f.starts,[]);assert.equal(f.commands.length,1);
});

for(const failure of ['command-rejected','missing-acknowledgement'])test('deferred '+failure+' preserves the candidate, loaded review and frozen request for retry',async t=>{
 const f=await fixture(t);await inspect(f);await review(f);await loadReview(f);const before=structuredClone({document:f.editor.view.document,candidate:f.candidate,source:f.source,mask:f.mask}),urls=deferredImages(f).map(i=>i.src);
 f.setCommand(async()=>{if(failure==='command-rejected')throw Error('Target lock changed');return [];});await f.click(acceptId);
 assert.equal(f.errors.length,1);assert.deepEqual(f.failures,['placement-review']);assert.equal(hasReview(f),true);assert.equal(f.button(acceptId).disabled,false);assert.deepEqual(deferredImages(f).map(i=>i.src),urls);assert.deepEqual({document:f.editor.view.document,candidate:f.candidate,source:f.source,mask:f.mask},before);
 f.setCommand(null);await f.click(acceptId);assert.equal(f.commands.filter(c=>c.body.type==='AdoptReviewedCandidate').length,2);assert.equal(hasReview(f),false);assert.deepEqual(f.opened,[]);
});

for(const boundary of ['owner','session','identity','document','disposed'])test('accepted new-document receipt cannot open a document after '+boundary+' replacement',async t=>{
 const f=await fixture(t),adopted=deferred();await inspect(f);await review(f,newReviewId);await loadReview(f);const newId=f.review().placement.newDocumentId;f.setCommand(()=>adopted.promise);await f.click(acceptId);
 assert.equal(f.commands.length,2);replaceOwner[boundary](f);adopted.resolve([{type:'DocumentCreated',payload:{document:{...f.editor.view.document,id:newId}}}]);await flush();assert.deepEqual(f.opened,[]);assert.deepEqual(f.errors,[]);
});

for(const clip of [false,true])test('mismatched actual output needs explicit '+(clip?'clipped':'contained')+' mapping review and retains the accepted request unchanged',async t=>{
 const f=await fixture(t,{actualWidth:2,actualHeight:2}),original=structuredClone(f.mask.requestPlan);await inspect(f);assert.equal(f.button(reviewId).disabled,true);await f.click(reviewId,{force:true});assert.equal(f.commands.length,0);assert.match(f.errors[0].message,/actual returned dimensions/);f.errors.length=0;
 await f.click('request-candidate-actual'+(clip?'-clip':'')+'-candidate');await review(f);assert.deepEqual(f.commands[0].body.actualOutput,{width:2,height:2,clipMask:clip});assert.deepEqual(f.mask.requestPlan,original);
 assert.deepEqual(f.review().inputs.plan,original);assert.deepEqual(f.review().inputs.outputMapping.actualOutput,{width:2,height:2});assert.equal(f.review().inputs.outputMapping.resolution,clip?'clipped-and-approved':'already-contained');assert.match(f.render().text,/Actual output: 2 × 2/);assert.match(f.render().text,clip?/1 edit pixels remain; 3 nonzero edit pixels are removed/:/4 edit pixels remain; 0 nonzero edit pixels are removed/);
 assert.match(f.render().markup,/aria-label="Final coverage for deferred preparation"/);assert.equal(f.button(acceptId).disabled,true);await loadReview(f);await f.click(acceptId);assert.deepEqual(f.commands.map(c=>c.body.type),['ReviewCandidatePlacement','AdoptReviewedCandidate']);assert.deepEqual(f.mask.requestPlan,original);assert.deepEqual(f.errors,[]);
});

function previewURLLedger(t){const created=[],revoked=[];t.mock.method(URL,'createObjectURL',blob=>{const url='blob:preview-test-'+(created.length+1);created.push({url,blob});return url;});t.mock.method(URL,'revokeObjectURL',url=>revoked.push(url));return {created,revoked,urls:()=>created.map(item=>item.url),assertReleasedOnce(urls){for(const url of urls)assert.equal(revoked.filter(value=>value===url).length,1,'Exactly one release for '+url);},assertRetained(urls){for(const url of urls)assert.equal(revoked.includes(url),false,'Still retained '+url);}};}
function observePromise(promise){let result;const settled=promise.then(value=>result={status:'fulfilled',value},reason=>result={status:'rejected',reason});return {settled,result:()=>result};}
// Real PNG structure, compressed RGBA8 scanlines and hashes exercise descriptor
// admission before the deliberately small decoder witness below.
const bytesHash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
function pngChunk(type,bytes){const name=Buffer.from(type),chunk=Buffer.alloc(bytes.length+12);chunk.writeUInt32BE(bytes.length);name.copy(chunk,4);bytes.copy(chunk,8);chunk.writeUInt32BE(crc32(Buffer.concat([name,bytes])),chunk.length-4);return chunk;}
function pngPixels(width,height){const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=6;const rows=Buffer.alloc((width*4+1)*height);return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',ihdr),pngChunk('IDAT',deflateSync(rows)),pngChunk('IEND',Buffer.alloc(0))]);}
function displayAsset(id,width=4,height=4){return {id,version:'1',availability:'available',safety:'safe',blob:ref(id+'-encoded','24','image/png'),raster:{width,height,pixelIdentity:hash(id+'-canonical-pixel-identity'),pixels:ref(id+'-full-retained-pixels',String(width*height*4)),manifest:metadata(id+'-manifest')}};}
function previewRequest(asset){return {kind:'preview',basis:'pixels',identity:asset.raster.pixelIdentity,edge:1024};}
function previewPath(asset){return displayPath(asset.id,previewRequest(asset));}
function descriptorResponse(asset){const json=JSON.stringify({projection:{value:asset}});return new Response(json,{headers:{'content-type':'application/json','content-length':String(Buffer.byteLength(json))}});}
function responseFor(asset){if(typeof asset==='string')asset=displayAsset(asset);const request=previewRequest(asset),size=displayDimensions(asset.raster.width,asset.raster.height,request),bytes=pngPixels(size.width,size.height);return new Response(bytes,{headers:{'content-type':'image/png','content-length':String(bytes.length),etag:'"'+bytesHash(bytes)+'"',[DISPLAY_HEADERS.profile]:DISPLAY_PROFILE,[DISPLAY_HEADERS.source]:asset.raster.pixelIdentity,[DISPLAY_HEADERS.basis]:'pixels',[DISPLAY_HEADERS.width]:String(size.width),[DISPLAY_HEADERS.height]:String(size.height),[DISPLAY_HEADERS.sourceWidth]:String(asset.raster.width),[DISPLAY_HEADERS.sourceHeight]:String(asset.raster.height),[DISPLAY_HEADERS.lod]:'0'}});}
function displayRoute(path,descriptor=displayAsset){const url=new URL(path,'http://127.0.0.1'),match=/^\/api\/v1\/assets\/([A-Za-z0-9_-]+)(\/display)?$/.exec(url.pathname);assert(match,'Only a bounded descriptor or display route is permitted: '+path);const asset=descriptor(match[1]);if(!match[2]){assert.equal(url.search,'');return descriptorResponse(asset);}assert.equal(path,previewPath(asset),'The rendition is bound to canonical pixel identity and edge 1024');return responseFor(asset);}
function assertDisplayReads(f,ids){assert.equal(f.transfers.length,ids.length*2,'One descriptor and one bounded rendition per retained image');assert.deepEqual(f.transfers.filter(path=>!path.includes('/display?')).sort(),ids.map(id=>'/api/v1/assets/'+id).sort());assert.deepEqual(f.transfers.filter(path=>path.includes('/display?')).sort(),ids.map(id=>previewPath(f.descriptor(id))).sort());for(const id of ids)assert(f.transfers.indexOf('/api/v1/assets/'+id)<f.transfers.indexOf(previewPath(f.descriptor(id))),'Descriptor precedes rendition for '+id);assert(f.transfers.every(path=>!path.includes('/content')),'Original encoded image content is never fetched for display');}
function installPNGDecoder(t){const previous=Object.getOwnPropertyDescriptor(globalThis,'createImageBitmap');Object.defineProperty(globalThis,'createImageBitmap',{configurable:true,writable:true,value:async blob=>{const bytes=Buffer.from(await blob.arrayBuffer());assert.deepEqual([...bytes.subarray(0,8)],[137,80,78,71,13,10,26,10]);const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20),compressed=[];for(let at=8;at<bytes.length;){const length=bytes.readUInt32BE(at),type=bytes.subarray(at+4,at+8).toString('ascii');assert.equal(bytes.readUInt32BE(at+8+length),crc32(bytes.subarray(at+4,at+8+length)),'Valid PNG chunk CRC');if(type==='IDAT')compressed.push(bytes.subarray(at+8,at+8+length));at+=length+12;}assert.equal(inflateSync(Buffer.concat(compressed)).length,(width*4+1)*height);return {width,height,close(){}};}});t.after(()=>{if(previous)Object.defineProperty(globalThis,'createImageBitmap',previous);else delete globalThis.createImageBitmap;});}

function requestMaskManifest(f){return {plan:{authoring:{width:4,height:4,feather:0,operations:[{kind:'fill'}]},hard:f.mask.requestPlan.authoredMask,effective:f.mask.requestPlan.effectiveMask,statistics:{hardPixels:4,effectivePixels:4,support:{x:1,y:1,width:2,height:2}},clip:null,lostEffectivePixels:0}};}
async function previewURLCase(t,kind){
 const ledger=previewURLLedger(t),f=await fixture(t),manifest=requestMaskManifest(f),maskAsset=structuredClone(f.descriptor('mask')),replacement=structuredClone(f.descriptor('replacement-mask'));let old;
 if(kind==='mask-restore'||kind==='mask-create'){
  f.draft.source=f.source;f.setJSON(path=>path.endsWith('/raster')?manifest:{projection:{value:maskAsset}});if(kind==='mask-create')f.draft.mask=f.mask;await f.controller.sync();old=f.controller.built;
 }else{await inspect(f);old=f.controller.inspections.get(f.candidate.id);}
 const retained=ledger.urls(),entries=[],urlEntry=assetId=>{const entry={type:'url',assetId,...deferred(),seen:false,value:responseFor(f.descriptor(assetId))};entries.push(entry);return entry;},metadataEntry=(path,value)=>{const entry={type:'metadata',path,...deferred(),seen:false,value};entries.push(entry);return entry;};let start;
 if(kind==='mask-restore'){
  metadataEntry('/api/v1/assets/mask/raster',manifest);urlEntry('mask');metadataEntry('/api/v1/assets/mask',{projection:{value:maskAsset}});f.draft.mask=f.mask;start=()=>f.controller.sync();
 }else if(kind==='mask-create'){
  metadataEntry('/api/v1/assets/replacement-mask/raster',manifest);urlEntry('replacement-mask');f.setCommand(body=>{assert.equal(body.type,'PrepareRequestMask');return [{type:'AssetRegistered',payload:{asset:replacement}}];});start=()=>f.controller.build(f.owns(),{kind:'fill'});
 }else if(kind==='inspection'){
  for(const id of ['returned','source','mask'])urlEntry(id);start=()=>f.controller.inspectCandidate(f.candidate,f.controller.own());
 }else{
  assert.equal(kind,'eager-placement');for(const id of ['before','replacement','after'])urlEntry(id);const warmReview={protocolVersion:1,reviewId:'warm-review',reviewHash:hash('warm-review'),targetClientId:'client',expiresAt:new Date(Date.now()+60000).toISOString(),preview:{previewId:'warm-preview',kind:'candidate-adoption',documentId:f.editor.view.document.id,documentRevision:f.editor.view.document.revision,source:f.editor.view.document.image,plan:metadata('warm-plan'),preparedAssetId:'replacement',after:{...f.editor.view.document.image,compositeAssetId:'after'},candidate:{candidateId:f.candidate.id,mode:'safe-region',placement:'current-document',newDocumentId:null,coverage:{originalEffectivePixels:4,effectivePixels:4,lostPixels:0},outputMapping:null}}};
  f.setCommand(body=>body.type==='PrepareCandidateAdoption'?[{type:'ImageEditPreviewPrepared',payload:{preview:{previewId:'warm-preview'}}}]:body.type==='ReviewImageEdit'?[{type:'ImageEditReviewPrepared',payload:{reviewId:'warm-review',reviewHash:warmReview.reviewHash}}]:assert.fail('Unexpected command '+body.type));f.setJSON(path=>{assert.equal(path,'/api/v1/image-edit-reviews/warm-review');return warmReview;});start=()=>f.controller.place(f.candidate,'current-document',f.controller.own());
 }
 if(kind.startsWith('mask-'))f.setJSON(path=>{const entry=entries.find(item=>item.type==='metadata'&&item.path===path);assert(entry,'Expected batch metadata '+path);entry.seen=true;return entry.promise;});
 f.editor.session.transport=path=>{const entry=entries.find(item=>item.type==='url'&&(path==='/api/v1/assets/'+item.assetId||path===previewPath(f.descriptor(item.assetId))));assert(entry,'Expected bounded batch image read '+path);if(path==='/api/v1/assets/'+entry.assetId){entry.descriptorSeen=true;return Promise.resolve(descriptorResponse(f.descriptor(entry.assetId)));}assert.equal(entry.descriptorSeen,true,'Descriptor precedes its rendition');entry.seen=true;return entry.promise;};
 const work=observePromise(start());await flush();assert.equal(work.result(),undefined,'The identity-validated preview is waiting on its sibling reads');assert(entries.every(entry=>entry.type==='url'?entry.descriptorSeen:entry.seen),'Every logical sibling starts its bounded descriptor or metadata read');const urlEntries=entries.filter(entry=>entry.type==='url'),admitted=Math.min(2,urlEntries.length);assert.equal(urlEntries.filter(entry=>entry.seen).length,admitted,'Only the scheduler-admitted renditions start fetching');assert.deepEqual(displayReadOwnership(),{active:admitted,queued:urlEntries.length-admitted,limit:2},'Remaining sibling renditions wait in the bounded shared scheduler');
 const unpublished=()=>{if(kind==='mask-restore')assert.equal(f.controller.built,null);else if(kind==='mask-create')assert.equal(f.controller.built,old);else if(kind==='inspection')assert.equal(f.controller.inspections.get(f.candidate.id),old);else assert.equal(f.controller.candidatePreviews.size,0);};
 return {f,ledger,entries,retained,work,unpublished,newURLs:()=>ledger.urls().filter(url=>!retained.includes(url))};
}

for(const kind of ['mask-restore','mask-create','inspection','eager-placement'])for(const order of ['pixels-first','error-first'])test(kind+' releases every acquired preview URL when a sibling fails '+order,async t=>{
 const c=await previewURLCase(t,kind),failed=c.entries[0],pixels=c.entries.find(entry=>entry.type==='url'&&entry!==failed),remaining=c.entries.filter(entry=>entry!==failed&&entry!==pixels);
 if(order==='pixels-first'){pixels.resolve(pixels.value);await flush();assert.equal(c.newURLs().length,1);}
 failed.reject(Error('Sibling preview load failed'));await flush();if(order==='error-first'){assert.equal(c.work.result(),undefined,'Failure waits for its pending siblings to settle');pixels.resolve(pixels.value);}for(const entry of remaining)entry.resolve(entry.value);
 await c.work.settled;await flush();assert.equal(c.work.result().status,'rejected');assert.match(c.work.result().reason.message,/Sibling preview load failed/);c.unpublished();c.ledger.assertReleasedOnce(c.newURLs());c.ledger.assertRetained(c.retained);
 c.f.controller.dispose();c.ledger.assertReleasedOnce(c.ledger.urls());const revoked=[...c.ledger.revoked];c.f.controller.dispose();assert.deepEqual(c.ledger.revoked,revoked,'Disposal does not release failed batch URLs twice');
});

for(const kind of ['mask-restore','mask-create','inspection','eager-placement'])for(const boundary of ['owner','disposed'])test(kind+' cannot publish pending preview URLs after '+boundary+' replacement',async t=>{
 const c=await previewURLCase(t,kind),first=c.entries.find(entry=>entry.type==='url');first.resolve(first.value);await flush();assert.equal(c.newURLs().length,1);
 if(boundary==='owner')c.f.editor.draftOwner={drafts:new Map()};else c.f.controller.dispose();for(const entry of c.entries)if(entry!==first)entry.resolve(entry.value);await c.work.settled;await flush();
 if(boundary==='owner'){c.unpublished();c.ledger.assertRetained(c.retained);}else{assert.equal(c.f.controller.built,null);assert.equal(c.f.controller.inspections.size,0);assert.equal(c.f.controller.candidatePreviews.size,0);}
 c.ledger.assertReleasedOnce(c.newURLs());c.f.controller.dispose();c.ledger.assertReleasedOnce(c.ledger.urls());
});

for(const kind of ['mask-restore','mask-create','inspection','eager-placement'])test(kind+' retains the complete successful URL batch until replacement or disposal',async t=>{
 const c=await previewURLCase(t,kind);for(const entry of c.entries)entry.resolve(entry.value);await c.work.settled;await flush();assert.equal(c.work.result().status,'fulfilled');const fresh=c.newURLs();assert.equal(fresh.length,c.entries.filter(entry=>entry.type==='url').length);c.ledger.assertRetained(fresh);
 if(kind==='mask-restore')assert.equal(c.f.controller.built.url,fresh[0]);else if(kind==='mask-create'){assert.equal(c.f.controller.built.url,fresh[0]);assert.equal(c.f.draft.mask.assetId,'replacement-mask');c.ledger.assertReleasedOnce(c.retained.slice(-1));c.ledger.assertRetained(c.retained.slice(0,-1));}else if(kind==='inspection'){assert.notEqual(c.f.controller.inspections.get(c.f.candidate.id).candidateURL,c.retained[0]);c.ledger.assertReleasedOnce(c.retained);}else{assert.equal(c.f.controller.candidatePreviews.size,1);c.ledger.assertRetained(c.retained);}
 c.f.controller.dispose();c.ledger.assertReleasedOnce(c.ledger.urls());
});

test('a sibling response stream is canceled after inspection failure and cannot create an unowned URL',async t=>{
 const c=await previewURLCase(t,'inspection'),lateBytes=deferred(),[failed,first,late]=c.entries;let canceled=false;
 const stream=new ReadableStream({async pull(controller){await lateBytes.promise;if(!canceled){controller.enqueue(pngPixels(4,4));controller.close();}},cancel(){canceled=true;}});
 late.resolve(new Response(stream,{headers:responseFor(c.f.descriptor(late.assetId)).headers}));first.resolve(first.value);await flush();assert.equal(c.newURLs().length,1);failed.reject(Error('Candidate preview failed'));await c.work.settled;assert.equal(canceled,true);lateBytes.resolve();await flush();assert.equal(c.work.result().status,'rejected');c.unpublished();c.ledger.assertReleasedOnce(c.newURLs());c.ledger.assertRetained(c.retained);c.f.controller.dispose();c.ledger.assertReleasedOnce(c.ledger.urls());
});

async function mappingURLFixture(t){
 const ledger=previewURLLedger(t),f=await fixture(t),originalManifest=requestMaskManifest(f),temporary=new Map();originalManifest.plan.clip={x:1,y:1,width:2,height:2};const maskAsset=structuredClone(f.descriptor('mask'));let prepared=0,onPrepare=null;
 f.draft.source=f.source;f.draft.mask=f.mask;f.draft.fields.size='auto';f.setJSON(path=>path.endsWith('/raster')?originalManifest:{projection:{value:maskAsset}});await f.controller.sync();const retained=ledger.urls(),built=f.controller.built;
 f.setCommand(body=>{assert.equal(body.type,'PrepareRequestMask');const asset=displayAsset('temporary-mask-'+ ++prepared),manifest=structuredClone(originalManifest);manifest.plan.clip=body.clip;temporary.set(asset.id,{asset,manifest});if(onPrepare)onPrepare(prepared);return [{type:'AssetRegistered',payload:{asset}}];});
 f.setJSON(path=>{const id=path.split('/')[4],entry=temporary.get(id);assert(entry,'Temporary mask metadata '+path);return path.endsWith('/raster')?entry.manifest:{projection:{value:entry.asset}};});
 f.editor.session.transport=async path=>displayRoute(path,f.descriptor);
 const unchanged=()=>{assert.equal(f.controller.built,built);assert.equal(f.controller.mapping,null);ledger.assertRetained(retained);};
 return {f,ledger,retained,built,temporary,unchanged,newURLs:()=>ledger.urls().filter(url=>!retained.includes(url)),onPrepare:fn=>onPrepare=fn};
}

test('mapping failure after creating an unclipped baseline releases it and preserves the saved built mask',async t=>{
 const c=await mappingURLFixture(t);c.f.controller.geometry.width='not-a-number';await assert.rejects(c.f.controller.previewMapping(c.f.owns(),false),/whole|finite/i);assert.equal(c.temporary.size,1);assert.equal(c.newURLs().length,1);c.unchanged();c.ledger.assertReleasedOnce(c.newURLs());c.f.controller.dispose();c.ledger.assertReleasedOnce(c.ledger.urls());
});

test('a stale second mask preparation releases the already created mapping baseline',async t=>{
 const c=await mappingURLFixture(t);c.onPrepare(index=>{if(index===2)c.f.editor.draftOwner={drafts:new Map()};});await c.f.controller.previewMapping(c.f.owns(),true);assert.equal(c.temporary.size,2);assert.equal(c.newURLs().length,1,'Only the first completed mask acquired a URL');c.unchanged();c.ledger.assertReleasedOnce(c.newURLs());c.f.controller.dispose();c.ledger.assertReleasedOnce(c.ledger.urls());
});

test('mapping source load failure releases both successful temporary masks without replacing the saved mask',async t=>{
 const c=await mappingURLFixture(t);c.f.editor.session.transport=async path=>path===previewPath(c.f.descriptor('source'))?new Response(null,{status:404}):displayRoute(path,c.f.descriptor);await assert.rejects(c.f.controller.previewMapping(c.f.owns(),true),/DISPLAY_DESCRIPTOR/);assert.equal(c.temporary.size,2);assert.equal(c.newURLs().length,2);c.unchanged();c.ledger.assertReleasedOnce(c.newURLs());c.f.controller.dispose();c.ledger.assertReleasedOnce(c.ledger.urls());
});

for(const boundary of ['owner','disposed'])test('pending mapping source preview releases its temporary masks after '+boundary+' replacement',async t=>{
 const c=await mappingURLFixture(t),source=deferred();let sourceStarted=false;c.f.editor.session.transport=async path=>{if(path===previewPath(c.f.descriptor('source'))){sourceStarted=true;return source.promise;}return displayRoute(path,c.f.descriptor);};const pending=observePromise(c.f.controller.previewMapping(c.f.owns(),true));for(let i=0;i<8&&!sourceStarted;i++)await flush();assert.equal(sourceStarted,true);assert.equal(c.newURLs().length,2);
 if(boundary==='owner')c.f.editor.draftOwner={drafts:new Map()};else c.f.controller.dispose();source.resolve(responseFor(c.f.descriptor('source')));await pending.settled;await flush();assert.equal(c.f.controller.mapping,null);if(boundary==='owner')c.unchanged();else assert.equal(c.f.controller.built,null);c.ledger.assertReleasedOnce(c.newURLs());c.f.controller.dispose();c.ledger.assertReleasedOnce(c.ledger.urls());
});

test('a successful mapping retains its distinct baseline, clipped proposal and source until disposal',async t=>{
 const c=await mappingURLFixture(t);await c.f.controller.previewMapping(c.f.owns(),true);assert.equal(c.temporary.size,2);const mapping=c.f.controller.mapping;assert(mapping);assert.notEqual(mapping.baseline,mapping.mask);assert.notEqual(mapping.mask,c.built);assert.equal(c.f.controller.built,c.built);assert.equal(c.newURLs().length,3);c.ledger.assertRetained(c.ledger.urls());c.f.controller.dispose();c.ledger.assertReleasedOnce(c.ledger.urls());
});

test('disposing a successful mapping shared with its built mask revokes the shared URL exactly once',async t=>{
 const c=await mappingURLFixture(t);c.built.manifest.plan.clip=null;await c.f.controller.previewMapping(c.f.owns(),false);assert.equal(c.temporary.size,0);assert.equal(c.f.controller.mapping.mask,c.built);assert.equal(c.f.controller.mapping.baseline,c.built);assert.equal(c.newURLs().length,1);c.ledger.assertRetained(c.ledger.urls());c.f.controller.dispose();c.ledger.assertReleasedOnce(c.ledger.urls());
});

for(const failure of ['before-transfer','after-transfer'])test('expansion releases its temporary override exactly once when mapping fails '+failure,async t=>{
 const c=await mappingURLFixture(t);if(failure==='before-transfer')c.f.controller.geometry.width='invalid';else c.f.editor.session.transport=async path=>path===previewPath(c.f.descriptor('source'))?new Response(null,{status:404}):displayRoute(path,c.f.descriptor);
 await assert.rejects(c.f.controller.expand(c.f.owns()),failure==='before-transfer'?/whole|finite/i:/DISPLAY_DESCRIPTOR/);assert.equal(c.temporary.size,1);assert.equal(c.newURLs().length,1);c.unchanged();c.ledger.assertReleasedOnce(c.newURLs());c.f.controller.dispose();c.ledger.assertReleasedOnce(c.ledger.urls());
});

for(const replacement of ['source','mask'])test('synchronizing a replacement '+replacement+' releases the old mapping before replacing retained URLs',async t=>{
 const c=await mappingURLFixture(t),oldSource=c.f.controller.sourceURL,oldBuilt=c.built.url;await c.f.controller.previewMapping(c.f.owns(),true);const mapping=c.f.controller.mapping,owned=[mapping.sourceURL,mapping.baseline.url,mapping.mask.url];c.ledger.assertRetained(c.ledger.urls());
 if(replacement==='source')c.f.draft.source={...c.f.source,assetId:'replacement-source'};else{c.f.draft.mask={...c.f.mask,assetId:'replacement-mask'};const manifest=structuredClone(c.built.manifest),asset=structuredClone(c.f.descriptor('replacement-mask'));c.f.setJSON(path=>{assert(path.startsWith('/api/v1/assets/replacement-mask'));return path.endsWith('/raster')?manifest:{projection:{value:asset}};});}
 await c.f.controller.sync();assert.equal(c.f.controller.mapping,null);c.ledger.assertReleasedOnce(owned);
 if(replacement==='source'){assert.equal(c.f.controller.built,c.built);c.ledger.assertRetained([oldBuilt,c.f.controller.sourceURL]);c.ledger.assertReleasedOnce([oldSource]);assert.equal(c.f.controller.sourceKey,'replacement-source');}else{assert.notEqual(c.f.controller.built,c.built);assert.equal(c.f.controller.built.asset.id,'replacement-mask');c.ledger.assertRetained([oldSource,c.f.controller.built.url]);c.ledger.assertReleasedOnce([oldBuilt]);}
 c.f.controller.dispose();c.ledger.assertReleasedOnce(c.ledger.urls());
});

for(const interruption of ['fetch-failure','superseded-generation'])test('the same immutable mask can restore again after '+interruption+' without retaining a failed key',async t=>{
 const c=await previewURLCase(t,'mask-restore'),pixels=c.entries.find(entry=>entry.type==='url'),manifest=c.entries.find(entry=>entry.path?.endsWith('/raster')).value,asset=c.entries.find(entry=>entry.path==='/api/v1/assets/mask').value;
 if(interruption==='fetch-failure')pixels.reject(Error('Mask content fetch failed'));else{pixels.resolve(pixels.value);await flush();assert.equal(c.newURLs().length,1);c.f.controller.invalidateMapping();}
 for(const entry of c.entries)if(entry!==pixels)entry.resolve(entry.value);await c.work.settled;await flush();assert.equal(c.work.result().status,interruption==='fetch-failure'?'rejected':'fulfilled');assert.equal(c.f.controller.built,null);assert.equal(c.f.controller.maskKey,'');c.ledger.assertReleasedOnce(c.newURLs());c.ledger.assertRetained(c.retained);
 c.f.setJSON(path=>{if(path==='/api/v1/assets/mask/raster')return manifest;if(path==='/api/v1/assets/mask')return asset;assert.fail('Unexpected restoration metadata '+path);});const retries=[];c.f.editor.session.transport=async path=>{retries.push(path);return displayRoute(path,c.f.descriptor);};await c.f.controller.sync();await flush();
 assert.deepEqual(retries,['/api/v1/assets/mask',previewPath(c.f.descriptor('mask'))]);assert.equal(c.f.controller.maskKey,'mask');assert.equal(c.f.controller.built.asset.id,'mask');const restored=c.f.controller.built.url;assert.equal(restored,c.newURLs().at(-1));c.ledger.assertRetained([...c.retained,restored]);c.ledger.assertReleasedOnce(c.newURLs().filter(url=>url!==restored));c.f.controller.dispose();c.ledger.assertReleasedOnce(c.ledger.urls());
});


test('bounded candidate display keeps full retained dimensions and identity through explicit actual-output adoption',async t=>{
 const f=await fixture(t,{actualWidth:4096,actualHeight:2048}),retained=structuredClone(f.asset),acceptedPlan=structuredClone(f.mask.requestPlan);await inspect(f);
 const image=f.render().images.find(image=>image.alt==='Returned candidate alone');assert(image);const info=displayPreviewInfo(image.src);assert.equal(info.width,1024);assert.equal(info.height,512);assert.equal(info.sourceWidth,4096);assert.equal(info.sourceHeight,2048);assert.equal(info.source,retained.raster.pixelIdentity);assert.notEqual(info.source,retained.raster.pixels.hash);assertDisplayReads(f,['returned','source','mask']);
 assert.match(f.render().text,/Actual returned image 4096 × 2048/);assert.equal(f.button(reviewId).disabled,true);assert.deepEqual(f.asset,retained);assert.deepEqual(f.commands,[]);
 await f.click('request-candidate-actual-candidate');await review(f);assert.deepEqual(f.commands[0].body.actualOutput,{width:4096,height:2048,clipMask:false});assert.equal(f.review().inputs.identity.preparedAssetId,retained.id);assert.equal(f.review().inputs.identity.preparedAssetHash,retained.blob.hash);assert.deepEqual(f.review().inputs.plan,acceptedPlan);assert.deepEqual(f.review().inputs.outputMapping.actualOutput,{width:4096,height:2048});
 await loadReview(f);await f.click(acceptId);assert.deepEqual(f.commands.map(command=>command.body.type),['ReviewCandidatePlacement','AdoptReviewedCandidate']);assert.deepEqual(f.asset,retained);assert.deepEqual(f.mask.requestPlan,acceptedPlan);assert.deepEqual(f.errors,[]);assertDisplayReads(f,['returned','source','mask','before']);
});
