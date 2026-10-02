import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {deflateSync,inflateSync} from 'node:zlib';
import { transformWithOxc } from 'vite';
import {planTextTreatment,textTreatmentPlanRef,bindTextTreatmentEnvelope} from '../../dist/local/src/request/text-treatment.js';
import {canonical} from '../../dist/local/src/protocol/json.js';

// Compile actual controller, selection, retirement and allocation owners. Only
// Lit/native display and transport results are fixture boundaries; the liveness
// clock remains deterministic. Owned responses use the shared real model graph.
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ownFixtureCommands} from '../owned-command-fixture.mjs';
import {modelMemoryURL,uiModelOwnerURL,promptMemoryURL,ownFixtureJSON} from '../ui-model-module.mjs';
import {allocationsURL,ownedPreviewURL} from '../owned-preview-module.mjs';
import {displayPreviewURL,displayProtocolURL} from '../display-module.mjs';
const data = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
const lit=data('export const nothing=null;export function html(strings,...values){return {strings,values};}export const svg=html;');
const adapter=data((await transformWithOxc(await readFile('src/ui/adapters.ts','utf8'),'adapters.ts')).code);
const imports={'lit':lit,'./adapters.js':adapter,'./display-image.js':data('export const displayImage=value=>value;'),'../observability/model-memory.js':modelMemoryURL,'../observability/prompt-memory.js':promptMemoryURL,'./model-owner.js':uiModelOwnerURL,'../observability/allocations.js':allocationsURL,'../observability/owned-preview.js':ownedPreviewURL,'../observability/display-preview.js':displayPreviewURL,
 ...Object.fromEntries(['protocol/asset-projection','protocol/json','protocol/sha256','request/text-treatment','request/core','request/raster-plan','raster/mask','raster/mapping'].map(name=>['../'+name+'.js',pathToFileURL(resolve('dist/local/src/'+name+'.js')).href]))};
async function source(name,extra={}){let code=(await transformWithOxc(await readFile('src/ui/'+name+'.ts','utf8'),name+'.ts')).code;code=code.replace(/import\s+["']\.\/(?:request-edits|candidate-comparison)\.css["'];?/g,'');for(const [key,value]of Object.entries({...imports,...extra}))code=code.replaceAll(JSON.stringify(key),JSON.stringify(value)).replaceAll("'"+key+"'",JSON.stringify(value));return code;}
const viewport=data(await source('comparison-viewport')),comparisonView=data(await source('comparison-view',{'./comparison-viewport.js':viewport})),comparison=data(await source('candidate-comparison',{'./comparison-viewport.js':viewport,'./comparison-view.js':comparisonView}));
const controllerSource=await source('request-edits',{'./candidate-comparison.js':comparison,'./candidate-selection.js':data(await source('candidate-selection')),'./candidate-text-treatment.js':data(await source('candidate-text-treatment')),'./request-mask-memory.js':data(await source('request-mask-memory')),'./request-edit-models.js':data(await source('request-edit-models'))});
const previousDocument=Object.getOwnPropertyDescriptor(globalThis,'document');
const { RequestEdits, lifecycleClock, lifecycleVisibility } = await import(data(`
export const lifecycleClock={now:0,nextId:0,timers:new Map(),advance(ms){
 const end=this.now+ms;
 for(;;){let next;for(const [id,timer]of this.timers)if(timer.at<=end&&(!next||timer.at<next.timer.at))next={id,timer};
  if(!next)break;this.now=next.timer.at;if(next.timer.interval)next.timer.at+=next.timer.interval;else this.timers.delete(next.id);next.timer.callback();
 }this.now=end;
}};
const setInterval=(callback,interval)=>{const id=++lifecycleClock.nextId;lifecycleClock.timers.set(id,{callback,interval,at:lifecycleClock.now+interval});return id;};
const clearInterval=id=>lifecycleClock.timers.delete(id);
const setTimeout=(callback,delay)=>{const id=++lifecycleClock.nextId;lifecycleClock.timers.set(id,{callback,at:lifecycleClock.now+delay});return id;};
const clearTimeout=id=>lifecycleClock.timers.delete(id);
const epoch=globalThis.Date.now(),Date=class extends globalThis.Date{static now(){return epoch+lifecycleClock.now;}};
const performance={now:()=>lifecycleClock.now};
export const lifecycleVisibility={visibilityState:'visible'};
Object.defineProperty(globalThis,'document',{value:lifecycleVisibility,configurable:true});
`+controllerSource));
test.after(()=>{if(previousDocument)Object.defineProperty(globalThis,'document',previousDocument);else delete globalThis.document;});
const {cloneOwnedModel}=await import(modelMemoryURL),{allocationLedger}=await import(allocationsURL);
const {createDisplayPreviewURL,displayPreviewInfo,displayPreviewOwnership}=await import(displayPreviewURL);
const {displayPath,DISPLAY_HEADERS,DISPLAY_PROFILE}=await import(displayProtocolURL);
const totals=()=>{const value=allocationLedger.snapshot();return {cpu:value.cpuBytes,handles:value.handles,records:value.activeRecords};};
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 64; i++) await Promise.resolve();lifecycleClock.advance(0);for(let i=0;i<32;i++)await Promise.resolve(); };
const turn = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await flush(); };
const digest = 'sha256:' + '1'.repeat(64);
const currentId = 'request-candidate-review-encoded-current-candidate';
const newId = 'request-candidate-review-encoded-new-candidate';
const ordinaryId = 'request-candidate-review-new-candidate';
const dismissId = 'request-candidate-dismiss-encoded-candidate';
const cardId = 'request-candidate-deferred-review-candidate';
function render(template) {
  const slots = [], expand = value => value === null || value === undefined ? '' : Array.isArray(value) ? value.map(expand).join('') : value?.strings ? value.strings.reduce((all, text, i) => all + text + (i < value.values.length ? expand(value.values[i]) : ''), '') : '__slot' + (slots.push(value) - 1) + '__';
  const markup = expand(template), text = value => value.replace(/__slot(\d+)__/g, (_, i) => String(slots[Number(i)]));
  const attr = (attrs, name) => { const match = new RegExp('(?:^|\\s)' + name + '=(?:"([^"]*)"|([^ >]+))').exec(attrs); return match ? text(match[1] ?? match[2]) : null; };
  const binding = (attrs, name) => { const match = new RegExp(name + '=__slot(\\d+)__').exec(attrs); return match ? slots[Number(match[1])] : undefined; };
  return {
    buttons: [...markup.matchAll(/<en-button\b([^>]*)>([\s\S]*?)<\/en-button>/g)].map(([, attrs,label]) => ({ id: attr(attrs, 'id'), label:text(label), disabled: !!binding(attrs, '\\?disabled'), click: binding(attrs, '@click') })),
    choices: [...markup.matchAll(/<en-(?:select|checkbox)\b([^>]*)>/g)].map(([, attrs]) => ({id:attr(attrs,'id'),disabled:!!binding(attrs,'\\?disabled'),change:binding(attrs,'@en-change')})),
    cards: [...markup.matchAll(/<en-card\b([^>]*)>/g)].map(([, attrs]) => ({ id: attr(attrs, 'id'), reviewId: attr(attrs, 'data-review-id'), reviewHash: attr(attrs, 'data-review-hash'), commandId: attr(attrs, 'data-review-command-id'), preparation: attr(attrs, 'data-preparation') })),
    images: [...markup.matchAll(/<img\b([^>]*)>/g)].map(([, attrs]) => ({src:attr(attrs,'src'),alt:attr(attrs,'alt'),load:binding(attrs,'@load')})),
  };
}
// Exercise the shared production display admission and URL registry with real
// PNG bytes. The native decoder is the same bounded fixture boundary used by
// deferred-controller; this is not evidence of a browser decode.
const bytesHash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
function pngChunk(type,bytes){const name=Buffer.from(type),chunk=Buffer.alloc(bytes.length+12);chunk.writeUInt32BE(bytes.length);name.copy(chunk,4);bytes.copy(chunk,8);chunk.writeUInt32BE(crc32(Buffer.concat([name,bytes])),chunk.length-4);return chunk;}
function pngPixels(){const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(4);ihdr.writeUInt32BE(4,4);ihdr[8]=8;ihdr[9]=6;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',ihdr),pngChunk('IDAT',deflateSync(Buffer.alloc(68))),pngChunk('IEND',Buffer.alloc(0))]);}
async function fixtureDisplayURL(role){
  const bytes=pngPixels(),source={assetId:'encoded-fixture-'+role,basis:'pixels',identity:bytesHash(Buffer.alloc(64)),width:4,height:4};
  const expected=displayPath(source.assetId,{basis:source.basis,identity:source.identity,kind:'preview',edge:1024});
  const url=await createDisplayPreviewURL(async path=>{
    assert.equal(path,expected,'Only the exact bounded display rendition is read');
    return new Response(bytes,{headers:{'content-type':'image/png','content-length':String(bytes.length),etag:'"'+bytesHash(bytes)+'"',[DISPLAY_HEADERS.profile]:DISPLAY_PROFILE,[DISPLAY_HEADERS.source]:source.identity,[DISPLAY_HEADERS.basis]:source.basis,[DISPLAY_HEADERS.width]:'4',[DISPLAY_HEADERS.height]:'4',[DISPLAY_HEADERS.sourceWidth]:'4',[DISPLAY_HEADERS.sourceHeight]:'4',[DISPLAY_HEADERS.lod]:'0'}});
  },source,{owner:'encoded-review-display-'+role,edge:1024});
  assert(displayPreviewInfo(url),'Published URL has an admitted display owner');return url;
}
function installPNGDecoder(t){
  const previous=Object.getOwnPropertyDescriptor(globalThis,'createImageBitmap');
  Object.defineProperty(globalThis,'createImageBitmap',{configurable:true,writable:true,value:async blob=>{
    const bytes=Buffer.from(await blob.arrayBuffer());assert.deepEqual([...bytes.subarray(0,8)],[137,80,78,71,13,10,26,10]);
    const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20),compressed=[];
    for(let at=8;at<bytes.length;){const length=bytes.readUInt32BE(at),type=bytes.subarray(at+4,at+8).toString('ascii');assert.equal(bytes.readUInt32BE(at+8+length),crc32(bytes.subarray(at+4,at+8+length)),'Valid PNG chunk CRC');if(type==='IDAT')compressed.push(bytes.subarray(at+8,at+8+length));at+=length+12;}
    assert.equal(inflateSync(Buffer.concat(compressed)).length,(width*4+1)*height);return {width,height,close(){}};
  }});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'createImageBitmap',previous);else delete globalThis.createImageBitmap;});
}
const fixtureRef=(label,mediaType='application/json',byteLength=String(Buffer.byteLength(label)))=>({hash:bytesHash(Buffer.from(label)),mediaType,byteLength});
function nativeTreatment(){
  const ref=fixtureRef,hash=label=>bytesHash(Buffer.from(label)),layers=[{id:'native',version:'1',kind:'text',visible:true,locked:false,stateHash:hash('layer'),contribution:{manifest:ref('K'),pixels:ref('Kpixels','application/x-ideogram-rgba8','64'),pixelIdentity:hash('Kidentity')},native:{source:ref('native-source'),literal:ref('Local letters','text/plain'),textVersion:hash('text-version'),renderVersion:hash('render-version'),dependencyHash:hash('native-dependencies')}}];
  const plan=planTextTreatment({id:'text-plan',inventory:{schemaVersion:1,kind:'text-treatment-inventory-1',documentId:'document',documentRevision:'7',grid:{width:4,height:4},imageState:ref('image-state'),layers,composition:null,semanticText:[]},choice:{kind:'baked-lettering',allowedHideNativeIds:['native'],duplicationAcknowledgement:'duplicates-reviewed',excludedSemanticIds:[],approvalId:'treatment-approved'},beforeSource:null,afterSource:null,prompt:{mode:'plain',bytes:ref('Exact prompt','text/plain'),projection:null},edit:null});
  return {plan,envelope:bindTextTreatmentEnvelope(plan,textTreatmentPlanRef(plan)),bytes:Buffer.from(canonical(plan))};
}
function displayAsset(id){
  const bytes=pngPixels(),pixels={hash:bytesHash(Buffer.alloc(64)),byteLength:'64',mediaType:'application/x-ideogram-rgba8'},manifest=fixtureRef(id+'-manifest');
  return {id,version:'1',purpose:'image',availability:'available',safety:'safe',qualification:'canonical-raster',measuredMediaType:'image/png',blob:{hash:bytesHash(bytes),byteLength:String(bytes.length),mediaType:'image/png'},dependencies:[manifest,pixels],raster:{schemaVersion:1,pipeline:'cp1-f64-triangle-area-v1/'+bytesHash(Buffer.from('pipeline')),width:4,height:4,pixels,pixelIdentity:pixels.hash,manifest,role:'composite',sourceAssetIds:[],conversion:null}};
}
const assetProjection=id=>({protocolVersion:1,entityVersion:'1',projectionSchema:2,highWater:'7',projection:{kind:'inline',value:displayAsset(id)}});
function displayResponse(path){
  const request=new URL(path,'http://127.0.0.1'),match=/^\/api\/v1\/assets\/(before|prepared|source|mask|lettering-alone|lettering-off|lettering-on)(\/display)?$/.exec(request.pathname);assert(match,'Only the bounded fixture display route is available: '+path);
  if(!match[2]){assert.equal(request.search,'');const body=JSON.stringify(assetProjection(match[1]));return new Response(body,{headers:{'content-type':'application/json','content-length':String(Buffer.byteLength(body))}});}
  const asset=displayAsset(match[1]),bytes=pngPixels();assert.equal(path,displayPath(asset.id,{basis:'pixels',identity:asset.raster.pixelIdentity,kind:'preview',edge:1024}));
  return new Response(bytes,{headers:{'content-type':'image/png','content-length':String(bytes.length),etag:'"'+bytesHash(bytes)+'"',[DISPLAY_HEADERS.profile]:DISPLAY_PROFILE,[DISPLAY_HEADERS.source]:asset.raster.pixelIdentity,[DISPLAY_HEADERS.basis]:'pixels',[DISPLAY_HEADERS.width]:'4',[DISPLAY_HEADERS.height]:'4',[DISPLAY_HEADERS.sourceWidth]:'4',[DISPLAY_HEADERS.sourceHeight]:'4',[DISPLAY_HEADERS.lod]:'0'}});
}
async function fixture(t,{nativeLettering=false}={}) {
  const baseline=totals(),displayBaseline=displayPreviewOwnership(),viewOwners=[];
  installPNGDecoder(t);
  lifecycleVisibility.visibilityState='visible';
  const commands = [], cancellations = [], errors = [], reads = [], signals = [], reviews = new Map(),displayReads=[],starts=[],treatment=nativeLettering?nativeTreatment():null; let current = true, holdJournal = false, holdResult = false, cancelGate, cancelStatus = 'canceled', cancelFailures = [], renewalError, renewalGate, commandReceipt;
  const candidate = { id: 'candidate', version: '2',documentId:'document',jobId:'job',attemptId:'attempt',requestId:'request',outputIdentity:'output', outputIndex: 0, encodedAssetId: 'encoded', preparedAssetId: 'prepared', safety: 'safe', state: 'prepared', hidden: false };
  const documentOwner=cloneOwnedModel('encoded-fixture-document',{id:'document',revision:'7',width:4,height:4,image:treatment?{state:treatment.plan.inventory.imageState,semanticDigest:bytesHash(Buffer.from('native-document')),compositeAssetId:'before'}:{compositeAssetId:null}});viewOwners.push(documentOwner);const document=documentOwner.value;
  const plan = { document: { width: 4, height: 4 }, expectedOutput: { width: 4, height: 4 } };
  const session = { identity: () => 'original-client',transport:async path=>{assert(nativeLettering,'Ordinary liveness fixtures make no extra display reads');displayReads.push(path);return displayResponse(path);} };
  const nativeOwner=treatment?cloneOwnedModel('encoded-fixture-native-view',{schemaVersion:5,width:4,height:4,layers:[{id:'native',version:'1',kind:'text',visible:true,locked:false,layerToDocument:[1,0,0,1,0,0],opacity:1,mask:null,assetId:'native-asset',source:fixtureRef('native-source')}],composition:null}):null;if(nativeOwner)viewOwners.push(nativeOwner);
  const editor = {
    view: {ready:true,document,...(nativeOwner?{image:nativeOwner.value}:{}), selected: [] }, session, sessionId: 'session', draftOwner: {}, beginFeedback() {}, beginAdoption(...args) {starts.push(args);}, adoptionFailed() {},
    pinViewModels(...values){const releases=[];try{for(const value of values){if(!value)continue;const owner=viewOwners.find(owner=>owner.value===value);assert(owner,'Fixture view must be independently owned');releases.push(owner.pin());}}catch(error){for(const release of releases)release();throw error;}let live=true;return ()=>{if(live){live=false;for(const release of releases)release();}};},
    async command(body, target, newDocumentId, onJournaled) {
      const result = deferred(), commandId = 'review-command-' + (commands.length + 1);
      const record = { body: structuredClone(body), commandId, result, journaled: false,
        journal() { if (!this.journaled) { this.journaled = true; onJournaled?.(commandId); } },
        complete() {
          if(body.type==='AdoptReviewedCandidate'){result.resolve([{type:'ImageEdited'}]);return;}
          const { type, preparation, ...placement } = body, reviewId = 'review-' + commandId;
          const review = { kind: 'candidate-placement-review-1', preparation: 'deferred', reviewId, reviewHash: digest, documentId: document.id, documentRevision: document.revision, expiresAt: new Date(Date.now() + lifecycleClock.now + 60000).toISOString(), source: structuredClone(document.image), placement,
            inputs: { identity: { candidateId: candidate.id, candidateVersion: candidate.version }, sourceCapture: { scope: 'visible-document' }, plan, outputMapping: null, ...(preparation === 'encoded-rebuild' ? { encodedRebuild: { kind: 'encoded-adoption-inputs-1' } } : {}) }, width: 4, height: 4 };
          if(treatment){assert(body.textTreatment,'Actual lettering selection supplies the command adjunct');const intent=fixtureRef('lettering-intent');review.lettering={kind:'candidate-lettering-comparison-1',plan:body.textTreatment.plan,choice:body.textTreatment.choice,intent,intentHash:intent.hash,manifest:fixtureRef('lettering-manifest'),grid:{width:4,height:4},candidateAloneAssetId:'lettering-alone',nativeOffAssetId:'lettering-off',nativeOnAssetId:'lettering-on'};}
          reviews.set(reviewId, review); result.resolve([{ type: 'CandidatePlacementReviewPrepared', payload: { reviewId, reviewHash: digest } }]);
        },
      };
      commands.push(record); if (!holdJournal) record.journal(); if (!holdResult) record.complete(); return result.promise;
    },
    async json(path,init) { reads.push(path);signals.push(init?.signal);
      if(treatment&&path.startsWith('/api/v1/jobs/')){const query=new URL(path,'http://127.0.0.1').searchParams;if(query.get('prompt')==='text-treatment'){const offset=Number(query.get('offset')),bytes=treatment.bytes.subarray(offset,offset+32768);return {bytes:bytes.toString('base64'),byteLength:String(treatment.bytes.length),offset:String(offset),nextOffset:offset+bytes.length<treatment.bytes.length?String(offset+bytes.length):null};}return {items:[candidate],request:{raster:{plan,source:{scope:'visible-document',assetId:'source'},mask:{assetId:'mask'}},textTreatment:treatment.envelope},inert:false};}
      if(treatment&&path.startsWith('/api/v1/assets/'))return assetProjection(path.split('/').at(-1));
      if(path.startsWith('/api/v1/commands/'))return structuredClone(commandReceipt??{kind:'pending',phase:'working'});if(renewalGate)await renewalGate.promise;if(renewalError)throw renewalError;const value = reviews.get(path.split('/').at(-1)); assert(value, path); return structuredClone(value); },
    async cancelCandidateReview(commandId, owner) { cancellations.push({ commandId, owner, at: lifecycleClock.now }); if (cancelGate) await cancelGate.promise; const failure = cancelFailures.shift(); if (failure) throw failure; return { protocolVersion: 1, commandId, status: cancelStatus }; },
  };
  ownFixtureCommands(editor);ownFixtureJSON(editor);
  let panelVisible=true,updates=0,mounted=new Map(),publish=()=>{},scheduled=false;
  // Simulate the existing Lit publication boundary, not DOM visibility: a
  // query reads only the last complete template's actual control inventory.
  // Rendering calls liveness, so querySelector must never trigger a render.
  const host = { isConnected:true, requestUpdate() {updates++;if(scheduled)return;scheduled=true;this.updateComplete=Promise.resolve().then(()=>{scheduled=false;publish();});void this.updateComplete.catch(error=>errors.push(error));}, updateComplete: Promise.resolve(),querySelector(selector){assert.equal(selector,'#'+newId);return mounted.has(newId)?{isConnected:host.isConnected,checkVisibility:()=>panelVisible}:null;} };
  const controller = new RequestEdits(host, editor, { draft: () => undefined,entryKey:()=>undefined,hold(expected){assert.equal(expected,undefined);return documentOwner.pin();},mutate(){assert.fail('Unexpected authoring mutation');}, changed() {}, owns: () => () => current, error: error => errors.push(error) });
  controller.retainCandidates([candidate]);
  const inspection={ candidate, asset: { raster: { width: 4, height: 4 } }, raster: { plan, source: { scope: 'visible-document' } },...(treatment?{textTreatment:treatment.envelope}:{}), sourceURL: '', candidateURL: '', maskURL: '', decoded: { source: false, candidate: false, mask: false }, actualApproved: false, clipActual: false };controller.inspections.set(candidate.id,inspection);
  controller.candidateMode.set(candidate.id, 'safe-region');
  const rendered = () => {const tree=render(controller.renderCandidate(candidate,false,treatment?.envelope));mounted=new Map(tree.buttons.filter(row=>row.id).map(row=>[row.id,row]));return tree;};publish=rendered;
  t.after(async()=>{
    // Release transport barriers before awaiting the actual controller drain;
    // otherwise the cleanup would wait on the fixture's own suspended response.
    cancelGate?.resolve();renewalGate?.resolve();cancelFailures=[];
    const release=controller.dispose();void release.catch(()=>{});
    for(const command of commands){command.journal();command.result.reject(Error('Fixture closed'));}
    try{await flush();await release;}finally{for(const owner of viewOwners)owner.release();}
    assert.equal(lifecycleClock.timers.size,0);assert.deepEqual(displayPreviewOwnership(),displayBaseline);assert.deepEqual(totals(),baseline);
  });
  // Admit each real display URL before publishing the retained inspection.
  // The controller already owns the partial inspection if admission fails.
  for(const key of ['source','candidate','mask'])inspection[key+'URL']=await fixtureDisplayURL(key);
  controller.retain('inspection:'+candidate.id,inspection);
  rendered(); // Mount before the first encoded review captures its owner.
  return { controller, editor, host, candidate, commands, cancellations, errors, reads, signals, rendered,displayReads,starts,treatment,mounted:id=>mounted.get(id),updates:()=>updates,
    hold({ journal = false, result = false, cancel = false } = {}) { holdJournal = journal; holdResult = result; if (cancel) cancelGate = deferred(); },
    releaseCancel() { cancelGate?.resolve(); }, failCancels(...errors) { cancelFailures = errors; }, cancelStatus(value) { cancelStatus = value; }, loseOwner() { current = false; },
    hidden(){lifecycleVisibility.visibilityState='hidden';}, visible(){lifecycleVisibility.visibilityState='visible';}, hidePanel(){panelVisible=false;}, disconnect(){host.isConnected=false;}, changeDocument(){const owner=cloneOwnedModel('encoded-fixture-document',{...document,id:'replacement-document'});viewOwners.push(owner);editor.view.document=owner.value;}, changeSession(){editor.session={identity:()=> 'replacement-client'};},
    failRenewal(){renewalError=Error('Review no longer live');}, restoreRenewal(){renewalError=undefined;}, holdRenewal(){renewalGate=deferred();}, releaseRenewal(){renewalGate?.resolve();}, receipt(value){commandReceipt=value;},
    loadCandidate(){
      // Only the deferred review figures grant placement readiness; inspection
      // figures remain separate and no ready marker is seeded during setup.
      for(const alt of ['Frozen source for deferred preparation','Returned candidate for deferred preparation','Frozen coverage for deferred preparation']){
        const image=rendered().images.find(row=>row.alt===alt);assert(image,'Rendered '+alt);
        const info=displayPreviewInfo(image.src);assert(info,'Still-owned display '+alt);
        image.load({currentTarget:{src:image.src,currentSrc:image.src,naturalWidth:info.width,naturalHeight:info.height}});
      }
    },
    async settleAction(){await Promise.all([...controller.nativeWork]);await host.updateComplete;await flush();},
    async choose(id,value='',checked=false){const control=rendered().choices.find(row=>row.id===id);assert(control,'Rendered '+id);assert.equal(control.disabled,false);const target={isConnected:true,value,checked};control.change({currentTarget:target,composedPath:()=>[target],defaultPrevented:false});await flush();},
    async click(id) { const button = rendered().buttons.find(value => value.id === id||value.label===id); assert(button, 'Rendered ' + id); assert.equal(button.disabled, false); const target = { isConnected: true }; button.click({ currentTarget: target, composedPath: () => [target], defaultPrevented: false, timeStamp: 123 }); await turn(); },
  };
}

test('explicit encoded review exposes the original public command identity and dismiss cancels only it', async t => {
  const f = await fixture(t); await f.click(currentId);
  assert.equal(f.commands[0].body.preparation, 'encoded-rebuild');
  const card = f.rendered().cards.find(value => value.id === cardId);
  assert.deepEqual(card, { id: cardId, reviewId: 'review-review-command-1', reviewHash: digest, commandId: 'review-command-1', preparation: 'encoded-rebuild' });
  await f.click(dismissId);
  assert.deepEqual(f.cancellations.map(value => value.commandId), ['review-command-1']);
  assert.equal(f.cancellations[0].owner.session, f.editor.session); assert.equal(f.cancellations[0].owner.identity, 'original-client');
  assert.equal(f.rendered().cards.some(value => value.id === cardId), false); assert.deepEqual(f.errors, []);
});

test('replacement releases the preceding encoded review and dispose releases the last visible review', async t => {
  const f = await fixture(t); await f.click(currentId); await f.click(newId);
  assert.deepEqual(f.cancellations.map(value => value.commandId), ['review-command-1']);
  assert.equal(f.rendered().cards.find(value => value.id === cardId).commandId, 'review-command-2');
  f.controller.dispose(); await flush();
  assert.deepEqual(f.cancellations.map(value => value.commandId), ['review-command-1', 'review-command-2']);
  assert.equal(lifecycleClock.timers.size, 0); assert.deepEqual(f.errors, []);
});

test('owner loss dispatches cancellation on the one-second sweep even without another render or sync', async t => {
  const f = await fixture(t); await f.click(currentId); const abandonedAt = lifecycleClock.now;
  f.loseOwner(); lifecycleClock.advance(999); await flush(); assert.equal(f.cancellations.length, 0);
  lifecycleClock.advance(1); await flush();
  assert.equal(f.cancellations[0].at - abandonedAt, 1000);
  assert.equal(f.cancellations[0].commandId, 'review-command-1');
  assert.equal(f.rendered().cards.some(value => value.id === cardId), false); assert.equal(lifecycleClock.timers.size, 0);
});

test('dispose before journaling cancels a late original ID and cancels again after a stale result arrives', async t => {
  const f = await fixture(t); f.hold({ journal: true, result: true }); await f.click(currentId);
  f.controller.dispose(); await flush(); assert.equal(f.cancellations.length, 0);
  f.commands[0].journal(); await flush(); assert.deepEqual(f.cancellations.map(value => value.commandId), ['review-command-1']);
  f.commands[0].complete(); await flush();
  assert.deepEqual(f.cancellations.map(value => value.commandId), ['review-command-1', 'review-command-1']);
  assert.equal(f.commands.length, 1); assert.equal(f.rendered().cards.some(value => value.id === cardId), false);
});

test('stale completion during cancellation coalesces into one follow-up for the same admitted original', async t => {
  const f = await fixture(t); f.hold({ result: true, cancel: true }); await f.click(currentId);
  f.loseOwner(); lifecycleClock.advance(1000); await flush(); assert.equal(f.cancellations.length, 1);
  f.commands[0].complete(); await flush(); assert.equal(f.cancellations.length, 1, 'The in-flight cancel is not duplicated');
  f.releaseCancel(); await flush();
  assert.deepEqual(f.cancellations.map(value => value.commandId), ['review-command-1', 'review-command-1']);
  assert.equal(f.commands.length, 1); assert.equal(lifecycleClock.timers.size, 0); assert.deepEqual(f.errors, []);
});

test('ordinary review replacement and disposal never invoke encoded-review cancellation', async t => {
  const f = await fixture(t); await f.click(ordinaryId); await f.click(ordinaryId);
  assert(f.commands.every(value => !Object.hasOwn(value.body, 'preparation')));
  assert.equal(f.rendered().buttons.some(value => value.id === dismissId), false);
  f.controller.dispose(); lifecycleClock.advance(2000); await flush();
  assert.deepEqual(f.cancellations, []); assert.equal(lifecycleClock.timers.size, 0); assert.deepEqual(f.errors, []);
});

test('a completed cancellation response after lease consumption is harmless to UI release', async t => {
  const f = await fixture(t); f.cancelStatus('completed'); await f.click(currentId); await f.click(dismissId);
  assert.equal(f.cancellations.length, 1); assert.deepEqual(f.errors, []);
  assert.equal(f.rendered().cards.some(value => value.id === cardId), false);
});

test('transient cancellation failures retry the same owner and original without retaining a sweep timer', async t => {
  const f = await fixture(t); await f.click(currentId); f.failCancels(Error('temporarily offline'), Error('server unavailable'));
  await f.click(dismissId); assert.equal(f.cancellations.length, 1);
  lifecycleClock.advance(249); await flush(); assert.equal(f.cancellations.length, 1);
  lifecycleClock.advance(1); await flush(); assert.equal(f.cancellations.length, 2);
  lifecycleClock.advance(500); await flush(); assert.equal(f.cancellations.length, 3);
  assert(f.cancellations.every(row => row.commandId === 'review-command-1' && row.owner === f.cancellations[0].owner));
  assert.deepEqual(f.errors, []); assert.equal(lifecycleClock.timers.size, 0); assert.equal(f.commands.length, 1);
});

test('persistent cancellation failure stops after three retries and reports unconfirmed release', async t => {
  const f = await fixture(t); await f.click(currentId); f.failCancels(...Array.from({length:4}, () => Error('offline')));
  await f.click(dismissId);
  for (const delay of [250, 500, 1000]) { lifecycleClock.advance(delay); await flush(); }
  assert.equal(f.cancellations.length, 4); assert.equal(f.errors.length, 1); assert.match(f.errors[0].message, /offline/);
  lifecycleClock.advance(5000); await flush(); assert.equal(f.cancellations.length, 4); assert.equal(lifecycleClock.timers.size, 0);
});

test('changed cancellation authority is terminal and never retried by the UI', async t => {
  const f = await fixture(t); await f.click(currentId); f.failCancels(Error('CANDIDATE_REVIEW_CANCELLATION_OWNER_CHANGED'));
  await f.click(dismissId); lifecycleClock.advance(5000); await flush();
  assert.equal(f.cancellations.length, 1); assert.deepEqual(f.errors, []); assert.equal(lifecycleClock.timers.size, 0);
});

test('only a visible owned review renews each second without changing its frozen metadata', async t => {
  const f=await fixture(t);await f.click(currentId);f.loadCandidate();const before=structuredClone(f.controller.placementReviews.get('candidate').review);
  const accept=()=>f.rendered().buttons.find(row=>row.id==='request-candidate-accept-prepare-candidate');
  assert.equal(accept().disabled,false);lifecycleClock.advance(1000);await flush();
  assert.equal(f.reads.length,2);assert.equal(f.reads[0],f.reads[1]);assert.deepEqual(f.controller.placementReviews.get('candidate').review,before);
  f.hidden();assert.equal(accept().disabled,true);lifecycleClock.advance(1000);await flush();
  assert.equal(f.reads.length,2);assert.equal(f.cancellations.length,1);assert.equal(lifecycleClock.timers.size,0);
  f.visible();lifecycleClock.advance(5000);await flush();assert.equal(f.reads.length,2);assert.equal(f.rendered().cards.some(row=>row.id===cardId),false);
});

for(const loss of ['hidePanel','disconnect','changeDocument','changeSession'])test(loss+' stops renewal before another public read',async t=>{
  const f=await fixture(t);await f.click(currentId);f[loss]();lifecycleClock.advance(1000);await flush();
  assert.equal(f.reads.length,1);assert.equal(f.cancellations.length,1);assert.equal(lifecycleClock.timers.size,0);
});

test('failed renewal disables acceptance and requires an explicit fresh review',async t=>{
  const f=await fixture(t);await f.click(currentId);f.loadCandidate();f.failRenewal();lifecycleClock.advance(1000);await flush();
  assert.equal(f.rendered().buttons.find(row=>row.id==='request-candidate-accept-prepare-candidate').disabled,true);
  assert.equal(f.rendered().cards.find(row=>row.id===cardId).commandId,'review-command-1');
  assert.equal(f.cancellations.length,1);assert.equal(lifecycleClock.timers.size,0);lifecycleClock.advance(5000);await flush();assert.equal(f.reads.length,2);
  f.restoreRenewal();await f.click(currentId);f.loadCandidate();assert.equal(f.commands.length,2);
  assert.equal(f.rendered().buttons.find(row=>row.id==='request-candidate-accept-prepare-candidate').disabled,false);
});

test('a hanging renewal actively rerenders disabled acceptance, stops its timer, and cannot revive a disposed owner',async t=>{
  const f=await fixture(t);await f.click(currentId);f.loadCandidate();f.holdRenewal();lifecycleClock.advance(1000);await flush();
  const before=f.updates();lifecycleClock.advance(2000);await flush();assert.equal(f.reads.length,2);assert(f.updates()>before,'Expiry requests a real rerender even while the read never settles');assert.equal(f.controller.placementReviews.get('candidate').encodedOwner.renewalFailed,true);assert.equal(lifecycleClock.timers.size,0);assert.equal(f.cancellations.length,1);assert.equal(f.rendered().buttons.find(row=>row.id==='request-candidate-accept-prepare-candidate').disabled,true);
  assert.equal(f.signals[1].aborted,true);
  f.controller.dispose();f.releaseRenewal();await flush();assert.equal(lifecycleClock.timers.size,0);assert.equal(f.rendered().cards.some(row=>row.id===cardId),false);
});

test('hanging renewal retires only review ownership while the submitted adoption can still complete',async t=>{
  const f=await fixture(t);await f.click(currentId);f.loadCandidate();f.hold({result:true});await f.click('request-candidate-accept-prepare-candidate');
  f.holdRenewal();lifecycleClock.advance(1000);await flush();lifecycleClock.advance(2000);await flush();
  assert.equal(f.commands.length,2);assert.equal(f.commands[1].body.type,'AdoptReviewedCandidate');assert.equal(f.controller.placementReviews.get('candidate').encodedOwner.renewalFailed,true);
  assert(f.cancellations.every(row=>row.commandId==='review-command-1'));assert.equal(lifecycleClock.timers.size,0);
  f.commands[1].complete();f.releaseRenewal();await flush();assert.equal(f.rendered().cards.some(row=>row.id===cardId),false);assert.deepEqual(f.errors,[]);
});

for(const release of ['dismiss','dispose'])test(release+' aborts its owned renewal and clears references only after settlement',async t=>{
  const f=await fixture(t);await f.click(currentId);f.holdRenewal();lifecycleClock.advance(1000);await flush();
  const owner=f.controller.placementReviews.get('candidate').encodedOwner,pending=owner.renewing;
  assert(pending);assert.equal(f.signals[1].aborted,false);
  if(release==='dismiss')await f.click(dismissId);else{f.controller.dispose();await flush();}
  assert.equal(f.signals[1].aborted,true);assert.equal(lifecycleClock.timers.size,0);
  assert.equal(owner.renewing,pending,'Aborting is not equivalent to a settled request');
  f.releaseRenewal();await pending;assert.equal(owner.renewing,undefined);assert.equal(owner.renewAbort,undefined);
  assert.equal(f.rendered().cards.some(row=>row.id===cardId),false);assert.deepEqual(f.errors,[]);
});

test('a delayed renewal response fails closed instead of extending freshness from its arrival',async t=>{
  const f=await fixture(t);await f.click(currentId);f.loadCandidate();f.holdRenewal();lifecycleClock.advance(1000);await flush();
  lifecycleClock.advance(3000);f.releaseRenewal();await flush();
  assert.equal(f.rendered().buttons.find(row=>row.id==='request-candidate-accept-prepare-candidate').disabled,true);assert.equal(f.cancellations.length,1);assert.equal(lifecycleClock.timers.size,0);
});

test('queued adoption continues public liveness and an exact accepted receipt resolves terminal cleanup race',async t=>{
  const f=await fixture(t);await f.click(currentId);f.loadCandidate();f.hold({result:true});await f.click('request-candidate-accept-prepare-candidate');
  assert.equal(f.commands[1].body.type,'AdoptReviewedCandidate');lifecycleClock.advance(1000);await flush();assert.equal(f.reads.length,2);
  f.failRenewal();f.receipt({kind:'receipt',receipt:{commandId:f.commands[1].commandId,status:'accepted'}});lifecycleClock.advance(1000);await flush();
  assert.equal(f.reads.at(-1),'/api/v1/commands/'+f.commands[1].commandId);assert.equal(f.controller.placementReviews.get('candidate').encodedOwner.renewalFailed,undefined);
  assert.equal(lifecycleClock.timers.size,0);f.commands[1].complete();await flush();assert.equal(f.rendered().cards.some(row=>row.id===cardId),false);
});

for(const terminal of ['pending','rejected','different-command'])test('failed liveness plus '+terminal+' acceptance cannot preserve a usable review',async t=>{
  const f=await fixture(t);await f.click(currentId);f.loadCandidate();f.hold({result:true});await f.click('request-candidate-accept-prepare-candidate');f.failRenewal();
  f.receipt(terminal==='pending'?{kind:'pending',phase:'working'}:{kind:'receipt',receipt:{commandId:terminal==='different-command'?'other':f.commands[1].commandId,status:terminal==='rejected'?'rejected':'accepted'}});
  lifecycleClock.advance(1000);await flush();assert.equal(f.controller.placementReviews.get('candidate').encodedOwner.renewalFailed,true);assert.equal(lifecycleClock.timers.size,0);
});

const confirmLetteringId='request-candidate-confirm-lettering-candidate',acceptId='request-candidate-accept-prepare-candidate';
async function confirmNativeEncodedReview(f){
  await f.click('Review lettering choices for this output');await f.settleAction();
  await f.click('candidate-text-load-candidate');await f.controller.candidateTreatment.task;await flush();
  await f.choose('candidate-text-action-candidate','hide-native-originals');await f.choose('candidate-text-hide-native','',true);
  await f.click('candidate-text-confirm-candidate');await f.controller.candidateTreatment.task;await flush();
  await f.click(currentId);await f.settleAction();
  const preview=f.controller.placementReviews.get('candidate');assert(preview,'Real owned encoded review was published');
  assert.deepEqual(preview.review.lettering.plan,f.treatment.envelope);assert.equal(preview.review.lettering.choice.action,'hide-native-originals');assert.deepEqual(preview.review.lettering.choice.hideNativeIds,['native']);assert.equal(preview.review.lettering.choice.preservation,'full-visible-root');
  assert.equal(f.rendered().buttons.find(row=>row.id===confirmLetteringId).disabled,true);f.loadCandidate();
  const before=f.rendered().images.find(row=>row.alt==='Reviewed target before preparation');assert(before);const beforeInfo=displayPreviewInfo(before.src);assert(beforeInfo);before.load({currentTarget:{src:before.src,currentSrc:before.src,naturalWidth:beforeInfo.width,naturalHeight:beforeInfo.height}});
  const alts=['Retained candidate lettering intent alone','Retained lettering intent with native text off','Retained lettering intent with native text on'];
  for(const [index,alt]of alts.entries()){
    const image=f.rendered().images.find(row=>row.alt===alt);assert(image,'Actual comparison figure '+alt);const info=displayPreviewInfo(image.src);assert(info);
    image.load({currentTarget:{src:image.src,currentSrc:image.src,naturalWidth:info.width,naturalHeight:info.height}});
    assert.equal(f.rendered().buttons.find(row=>row.id===confirmLetteringId).disabled,index<alts.length-1);
  }
  const inspection=f.controller.inspections.get('candidate'),urls=[inspection.sourceURL,inspection.candidateURL,inspection.maskURL,preview.originalURL,preview.letteringAloneURL,preview.letteringOffURL,preview.letteringOnURL];assert.equal(new Set(urls).size,7);assert(urls.every(url=>displayPreviewInfo(url)));
  assert.equal(f.rendered().buttons.find(row=>row.id===acceptId).disabled,true);assert.equal(f.starts.length,0);
  await f.click(confirmLetteringId);await f.settleAction();
  assert.equal(preview.letteringPhase,'confirmed');assert.equal(f.rendered().images.length,0);assert(urls.every(url=>!displayPreviewInfo(url)),'Real confirmation retires all seven admitted display URLs');
  assert.deepEqual([inspection.sourceURL,inspection.candidateURL,inspection.maskURL],['','','']);assert.equal(f.controller.comparison.lifecycle.retired,0);assert.equal(f.starts.length,0);assert.deepEqual(f.errors,[]);
  return {preview,owner:preview.encodedOwner,urls};
}

test('confirmed native encoded review keeps its actual mounted anchor, renews the same owner and accepts on the original event clock',async t=>{
  const f=await fixture(t,{nativeLettering:true}),{preview,owner}=await confirmNativeEncodedReview(f),frozen=structuredClone(preview.review);
  // The old early-return branch removes this control once confirmation closes
  // input URLs. The cached actual inventory must expose that loss, not replace
  // it with an always-visible synthetic query result.
  for(const id of [currentId,newId]){assert(f.mounted(id),'Closed inputs retain the real rendered encoded anchor');assert.equal(f.mounted(id).disabled,true);}
  assert(f.host.querySelector('#'+newId));assert.equal(f.rendered().buttons.find(row=>row.id===acceptId).disabled,false);assert.equal(f.commands.length,1);
  const renewals=()=>f.reads.filter(path=>path==='/api/v1/image-edit-reviews/'+preview.review.reviewId).length;
  for(let index=0;index<2;index++){
    const before=renewals(),confirmedAt=owner.lastConfirmedAt;lifecycleClock.advance(1000);await f.settleAction();
    assert.equal(renewals(),before+1);assert(owner.lastConfirmedAt>confirmedAt);assert.equal(f.controller.placementReviews.get('candidate'),preview);assert.equal(preview.encodedOwner,owner);assert.equal(f.rendered().buttons.find(row=>row.id===acceptId).disabled,false);assert.deepEqual(preview.review,frozen);assert.deepEqual(f.cancellations,[]);
  }
  const reads=f.displayReads.length;f.hold({result:true});await f.click(acceptId);
  assert.deepEqual(f.commands.map(row=>row.body.type),['ReviewCandidatePlacement','AdoptReviewedCandidate']);assert.deepEqual(f.commands[1].body,{type:'AdoptReviewedCandidate',reviewId:preview.review.reviewId,reviewHash:preview.review.reviewHash,draft:null});
  assert.equal(f.starts.length,1);assert.equal(f.starts[0][1],false);assert.equal(f.starts[0][2],123,'Only the actual Accept event starts adoption');assert.equal(f.displayReads.length,reads,'Acceptance cannot reacquire the closed comparisons');
  f.commands[1].complete();await f.settleAction();assert.equal(f.controller.placementReviews.has('candidate'),false);assert.deepEqual(f.errors,[]);
});

test('confirmed native encoded review blocks fresh reviews until public inspection reacquires its owned displays',async t=>{
  const f=await fixture(t,{nativeLettering:true}),{preview,owner}=await confirmNativeEncodedReview(f),before=f.commands.length;
  for(const id of [currentId,newId,'request-candidate-review-current-candidate',ordinaryId,'request-candidate-place-candidate','request-candidate-new-document-candidate'])assert.equal(f.rendered().buttons.find(row=>row.id===id).disabled,true,id);
  for(const placement of ['current-document','new-document'])await assert.rejects(f.controller.reviewPlacement(f.candidate,placement,()=>true,false,true),/Inspect the frozen source and candidate again/);
  assert.equal(f.commands.length,before);assert.equal(f.rendered().buttons.find(row=>row.id===acceptId).disabled,false);assert.deepEqual(f.cancellations,[]);
  await f.click('request-candidate-prepare-candidate');await f.settleAction();
  const inspection=f.controller.inspections.get('candidate');for(const key of ['sourceURL','candidateURL','maskURL'])assert(displayPreviewInfo(inspection[key]),'Public inspection readmits '+key);
  assert.equal(f.rendered().buttons.find(row=>row.id===currentId).disabled,false);assert.equal(f.rendered().buttons.find(row=>row.id===newId).disabled,false);
  await f.click(currentId);await f.settleAction();const successor=f.controller.placementReviews.get('candidate');assert.notEqual(successor,preview);assert.notEqual(successor.encodedOwner,owner);assert.equal(f.commands.length,before+1);assert.equal(successor.letteringPhase,'inspection');assert.equal(f.rendered().buttons.find(row=>row.id===acceptId).disabled,true);assert.deepEqual(f.cancellations.map(row=>row.commandId),[owner.commandId]);assert.equal(f.starts.length,0);assert.deepEqual(f.errors,[]);
});

for(const loss of ['hidePanel','disconnect'])test('confirmed native encoded '+loss+' still cancels its exact owner and stops renewal',async t=>{
  const f=await fixture(t,{nativeLettering:true}),{preview,owner}=await confirmNativeEncodedReview(f),reads=f.reads.length;
  assert(f.mounted(newId));assert.equal(f.mounted(newId).disabled,true);f[loss]();lifecycleClock.advance(1000);await f.settleAction();
  assert.equal(f.reads.length,reads);assert.equal(f.controller.placementReviews.has('candidate'),false);assert.equal(lifecycleClock.timers.size,0);assert.equal(f.cancellations.length,1);assert.equal(f.cancellations[0].commandId,owner.commandId);assert.equal(f.cancellations[0].owner,owner.sessionOwner);assert.equal(f.commands.length,1);assert.equal(f.starts.length,0);assert.equal(preview.letteringPhase,'confirmed');assert.deepEqual(f.errors,[]);
});
