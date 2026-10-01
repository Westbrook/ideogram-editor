import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonical} from '../../dist/local/src/protocol/json.js';
import {emptyComposition} from '../../dist/local/src/composition/core.js';
import {retainedMetadataReferences,validateRetainedRequestMetadata,remapRasterRetention,retainedRasterMetadata,validateRetainedRasterMetadata} from '../../dist/local/server/portable/retained.js';
import {createIdentityRequestPlan} from '../../dist/local/src/request/raster-plan.js';
import {rasterManifest,asset as validateAsset} from '../../dist/local/src/protocol/validate.js';

const hash=value=>'sha256:'+createHash('sha256').update(value).digest('hex');
const identified=value=>({id:hash(canonical(value)),...value});
const pipeline='cp1-f64-triangle-area-v1/sha256:'+'1'.repeat(64),identity=[1,0,0,1,0,0];
function graph(){
 const objects=new Map();
 const put=(bytes,mediaType)=>{bytes=Buffer.from(bytes);const ref={hash:hash(bytes),byteLength:String(bytes.length),mediaType};objects.set(ref.hash,bytes);return ref;};
 const json=value=>put(canonical(value),'application/json');
 const walk=root=>{const pending=[{ref:root,inspect:true}],retained=new Set(),inspected=new Set();while(pending.length){const {ref,inspect}=pending.shift();assert.ok(objects.has(ref.hash),'reachable bytes '+ref.hash);retained.add(ref.hash);if(!inspect||inspected.has(ref.hash))continue;inspected.add(ref.hash);pending.push(...retainedMetadataReferences(JSON.parse(objects.get(ref.hash))));}return {retained,inspected};};
 return {objects,put,json,walk};
}
function retainedRasterFixture(){
 const g=graph(),pixels=g.put([17,28,39,255],'application/x-ideogram-rgba8'),encoded=g.put('exact encoded candidate','image/png');
 const conversion={encodedWidth:1,encodedHeight:1,orientation:1,profile:'untagged-srgb',profileHash:null,colorChanged:false,orientationChanged:false,resized:false};
 const make=sourceAssetId=>({schemaVersion:1,pipeline,width:1,height:1,format:'straight-srgb-rgba8',layout:'row-major-tile-views-v1',tileSize:512,pixels,tiles:[{x:0,y:0,width:1,height:1,hash:pixels.hash}],dependencies:[encoded],plan:{kind:'decoded-native',sourceAssetId,conversion,codec:pipeline.split('/')[1]}});
 const original=make('original_encoded'),manifest=g.json(original),pixelIdentity=hash(canonical({pipeline,width:1,height:1,tiles:original.tiles}));
 const asset={id:'original_candidate',version:'1',purpose:'image',blob:encoded,dependencies:[manifest,pixels],safety:'safe',availability:'available',qualification:'canonical-raster',measuredMediaType:'image/png',raster:{schemaVersion:1,pipeline,width:1,height:1,manifest,pixels,pixelIdentity,role:'native',sourceAssetIds:['original_encoded'],conversion}};
 const read=async ref=>JSON.parse(g.objects.get(ref.hash));return {g,pixels,encoded,make,asset,read};
}

test('twenty namespace remaps keep every original manifest with one bounded asset provenance root',async()=>{
 const {g,make,read,asset:original}=retainedRasterFixture(),originals=[];let asset=original;
 for(let i=1;i<=20;i++){
  originals.push(asset.raster.manifest);const next=g.json(make('namespace_'+i)),retention=remapRasterRetention(asset,next,g.json);
  asset={...asset,...retention,id:'candidate_'+i,raster:{...asset.raster,manifest:next,sourceAssetIds:['namespace_'+i]}};
  validateAsset(asset);assert.equal(asset.dependencies.length,3);assert(asset.dependencies.some(ref=>ref.hash===asset.retainedMetadata.hash));
  await validateRetainedRasterMetadata(asset.retainedMetadata,asset.raster,read);
  const reachable=g.walk(asset.retainedMetadata).retained;for(const ref of originals)assert(reachable.has(ref.hash),'Lost original manifest '+ref.hash);
 }
 const unchanged=remapRasterRetention(asset,asset.raster.manifest,()=>assert.fail('Unchanged manifest must not extend the chain'));
 assert.deepEqual(unchanged,{dependencies:asset.dependencies,retainedMetadata:asset.retainedMetadata});
});

test('retained raster metadata rejects cycles and caps linked traversal at 4096 nodes',async()=>{
 const {g,asset,make}=retainedRasterFixture(),ref=i=>({hash:hash('retention-'+i),byteLength:'100',mediaType:'application/json'});
 await assert.rejects(validateRetainedRasterMetadata(ref(0),asset.raster,async r=>r.hash===asset.raster.manifest.hash?make('original_encoded'):{schemaVersion:1,kind:'retained-raster-metadata-1',manifest:asset.raster.manifest,previous:ref(0)}));
 let records=0;await assert.rejects(validateRetainedRasterMetadata(ref(0),asset.raster,async r=>{if(r.hash===asset.raster.manifest.hash)return make('original_encoded');records++;return {schemaVersion:1,kind:'retained-raster-metadata-1',manifest:asset.raster.manifest,previous:ref(records)};}));
 assert.equal(records,4096);assert(g.objects.has(asset.raster.manifest.hash));
});

test('maximum preexisting raster dependencies gain only one retained root across repeated imports',()=>{
 const {g,make,asset:original}=retainedRasterFixture();let asset={...original,dependencies:[...original.dependencies,...Array.from({length:6},(_,i)=>g.put('declared-'+i,'application/octet-stream'))]};
 validateAsset(asset);
 for(let i=0;i<12;i++){const manifest=g.json(make('bounded_'+i));asset={...asset,...remapRasterRetention(asset,manifest,g.json),raster:{...asset.raster,manifest}};validateAsset(asset);assert.equal(asset.dependencies.length,9);}
});

test('retained raster metadata binds prior manifests to the unchanged pixels and dimensions',async()=>{
 const {g,asset,make,read}=retainedRasterFixture(),root=g.json({schemaVersion:1,kind:'retained-raster-metadata-1',manifest:asset.raster.manifest,previous:null});
 await validateRetainedRasterMetadata(root,asset.raster,read);
 for(const raster of [{...asset.raster,width:2},{...asset.raster,pixels:{...asset.raster.pixels,hash:hash('different pixels')}},{...asset.raster,pixelIdentity:hash('different tiles')},{...asset.raster,pipeline:'cp1-f64-triangle-area-v1/'+hash('different pipeline')}])await assert.rejects(validateRetainedRasterMetadata(root,raster,read));
 const wrong=g.json({...make('old'),plan:{kind:'retained-text',source:asset.raster.manifest}});
 await assert.rejects(validateRetainedRasterMetadata(wrong,asset.raster,read));
});

test('retained metadata refs are bounded JSON and explicit raster asset dependencies',()=>{
 const {g,asset}=retainedRasterFixture(),value={schemaVersion:1,kind:'retained-raster-metadata-1',manifest:asset.raster.manifest,previous:null},root=g.json(value);
 retainedRasterMetadata(value);assert.deepEqual(retainedMetadataReferences(value),[{ref:asset.raster.manifest,inspect:true}]);
 for(const ref of [{...root,mediaType:'application/octet-stream'},{...root,byteLength:'65537'}]){
  assert.throws(()=>retainedRasterMetadata({...value,manifest:ref}));assert.throws(()=>retainedRasterMetadata({...value,previous:ref}));
  assert.throws(()=>validateAsset({...asset,retainedMetadata:ref,dependencies:[...asset.dependencies,ref]}));
 }
 assert.throws(()=>validateAsset({...asset,retainedMetadata:root}));
 validateAsset({...asset,retainedMetadata:root,dependencies:[...asset.dependencies,root]});
});
function textSource(g){
 const textUtf8=g.put('old editable text','text/plain'),pixels=g.put([10,20,30,255],'application/x-ideogram-rgba8');
 // These valid JSON leaf bytes deliberately resemble a malformed app manifest.
 const opaque=g.json({format:'straight-srgb-rgba8',plan:{kind:'authored-raw-json'},dependencies:[]});
 const font=identified({schemaVersion:1,bytes:g.put(Buffer.alloc(12,1),'application/octet-stream'),faceIndex:0,format:'static-ttf',parserProfile:'sfnt-static-1-freetype-canvaskit040',fsType:0,licenseRecord:opaque,origin:'local-file',embedding:'permitted'});
 const text=identified({schemaVersion:1,textUtf8,style:{primaryFont:font.bytes.hash,explicitFallbacks:[],sizePx:1,lineHeightMultiplier:1,fill:[255,255,255,255],align:'left',direction:'auto'},frame:{width:1,height:1},layoutPolicy:'text-layout-1',fonts:[font]});
 const render=identified({schemaVersion:1,textVersion:text.id,rendererProfile:{schemaVersion:1,id:hash('original-profile'),manifest:opaque},dependencyHash:hash('original-dependencies'),layout:opaque,pixels,width:1,height:1,overflow:false,resolvedFonts:[font.id]});
 return {value:{schemaVersion:1,text,render},opaque,textUtf8,pixels,font};
}
const imageLayer=(assetId='old_asset')=>({id:'old_layer',version:'1',kind:'image',name:'Original',assetId,layerToDocument:identity,opacity:1,visible:true,locked:false,blend:'normal',mask:null});

test('authored Composition JSON remains an opaque leaf even when it resembles app metadata',()=>{
 const g=graph(),raw=g.json({format:'straight-srgb-rgba8',plan:{kind:'not-a-renderer'},dependencies:[{hash:hash('unowned'),byteLength:'7',mediaType:'application/json'}]}),value=emptyComposition(1,1,'old_composition');value.raw=[raw];
 const root=g.json(value),result=g.walk(root);assert.deepEqual(result.retained,new Set([root.hash,raw.hash]));assert.deepEqual(result.inspected,new Set([root.hash]));
});

test('original text sources retain exact text/font/layout/profile bytes without interpreting JSON leaves',()=>{
 const g=graph(),source=textSource(g),root=g.json(source.value),result=g.walk(root);
 assert.deepEqual(result.retained,new Set([root.hash,source.textUtf8.hash,source.pixels.hash,source.font.bytes.hash,source.opaque.hash]));
 assert.deepEqual(result.inspected,new Set([root.hash]));assert.equal(retainedMetadataReferences(source.value).every(edge=>edge.inspect===false),true);
});

test('original image state follows typed Composition and text roots without resolving old asset IDs',()=>{
 const g=graph(),source=textSource(g),text=g.json(source.value),composition=g.json(emptyComposition(1,1,'old_composition'));
 const state={schemaVersion:5,width:1,height:1,layers:[{...imageLayer('deleted_old_namespace_asset'),kind:'text',source:text}],composition:{id:'old_composition',value:composition,bindings:{}}},root=g.json(state),result=g.walk(root);
 assert.equal(result.inspected.has(text.hash),true);assert.equal(result.inspected.has(composition.hash),true);assert.equal(result.inspected.has(source.opaque.hash),false);assert.equal(result.retained.has(source.pixels.hash),true);
 assert.deepEqual(retainedMetadataReferences(state),[{ref:composition,inspect:true},{ref:text,inspect:true}]);
});

test('original capture traverses retained K stack, child pixels and native manifest dependencies',()=>{
 const g=graph(),pixels=g.put([17,28,39,255],'application/x-ideogram-rgba8'),encoded=g.put('original encoded image','image/png'),state=g.json({schemaVersion:1,width:1,height:1,layers:[imageLayer()]}),base={schemaVersion:1,pipeline,width:1,height:1,format:'straight-srgb-rgba8',layout:'row-major-tile-views-v1',tileSize:512,pixels,tiles:[{x:0,y:0,width:1,height:1,hash:pixels.hash}]};
 const native=g.json({...base,dependencies:[encoded],plan:{kind:'decoded-native',sourceAssetId:'unmapped_original',conversion:{encodedWidth:1,encodedHeight:1,orientation:1,profile:'untagged-srgb',profileHash:null,colorChanged:false,orientationChanged:false,resized:false},codec:pipeline.split('/')[1]}});
 const layer={assetId:'unmapped_native',transform:identity,opacity:1,mask:null},sampling={maskMapping:'document-luminance-alpha-v1',precision:'binary64',kernel:'triangle-area-source-axis-row-norm-v1',edge:'transparent-zero-no-renormalization'},footprint={x:-1,y:-1,width:3,height:3};
 const child=g.json({...base,dependencies:[native],plan:{kind:'cp1-layer-contribution-v1',layer,source:native,mask:null,...sampling,footprint}}),stack=g.json({schemaVersion:1,kind:'cp1-contribution-stack-v1',pipeline,width:1,height:1,contributions:[{manifest:child,pixels,pixelIdentity:hash(canonical({pipeline,width:1,height:1,tiles:base.tiles}))}]});
 const parent=g.json({...base,dependencies:[stack,state],plan:{kind:'request-source-capture-v1',capture:{schemaVersion:1,documentId:'old_document',documentRevision:'1',image:{state,semanticDigest:hash('old-state'),compositeAssetId:'old_composite'},scope:'single-layer',layerIds:['old_layer']},layers:[layer],...sampling,footprints:[footprint],contributions:stack}}),result=g.walk(parent);
 assert.deepEqual(result.retained,new Set([parent.hash,stack.hash,state.hash,child.hash,pixels.hash,native.hash,encoded.hash]));
 assert.deepEqual(result.inspected,new Set([parent.hash,stack.hash,state.hash,child.hash,native.hash]));
});

test('shared K stack validator rejects inconsistent dimensions, raw length and descriptors',()=>{
 const g=graph(),pixels=g.put([1,2,3,4],'application/x-ideogram-rgba8'),manifest=g.json({retained:'K'}),stack={schemaVersion:1,kind:'cp1-contribution-stack-v1',pipeline,width:1,height:1,contributions:[{manifest,pixels,pixelIdentity:hash('pixels')}]};
 assert.deepEqual(retainedMetadataReferences(stack),[{ref:manifest,inspect:true},{ref:pixels,inspect:false}]);
 for(const altered of [{...stack,width:-1},{...stack,pipeline:'unsealed'},{...stack,width:2},{...stack,contributions:[{...stack.contributions[0],manifest:{...manifest,mediaType:'text/plain'}}]}])assert.throws(()=>retainedMetadataReferences(altered));
});

test('conflicting lengths cannot be concealed by repeated hashes or media aliases',()=>{
 const g=graph(),raw=g.json({authored:'raw'}),value=emptyComposition(1,1,'old_composition');
 for(const mediaType of ['application/json','text/plain']){value.raw=[raw,{...raw,mediaType,byteLength:String(Number(raw.byteLength)+1)}];assert.throws(()=>retainedMetadataReferences(value));}
 value.raw=[raw,raw];assert.deepEqual(retainedMetadataReferences(value),[{ref:raw,inspect:false}]);
});

function retainedRequest(){
 const g=graph(),pixels=g.put([17,28,39,255],'application/x-ideogram-rgba8'),maskPixels=g.put([255,255,255,255],'application/x-ideogram-rgba8'),state=g.json({schemaVersion:1,width:1,height:1,layers:[imageLayer()]}),hard=g.put([255,255],'application/x-ideogram-r16le'),effective=g.put([128,255],'application/x-ideogram-r16le');
 const base=pixels=>({schemaVersion:1,pipeline,width:1,height:1,format:'straight-srgb-rgba8',layout:'row-major-tile-views-v1',tileSize:512,pixels,tiles:[{x:0,y:0,width:1,height:1,hash:pixels.hash}]});
 const capture={...base(pixels),dependencies:[state],plan:{kind:'request-source-capture-v1',capture:{schemaVersion:1,documentId:'old_document',documentRevision:'7',image:{state,semanticDigest:hash('old-state'),compositeAssetId:'old_composite'},scope:'single-layer',layerIds:['old_layer']},layers:[{assetId:'old_native',transform:identity,opacity:1,mask:null}],maskMapping:'document-luminance-alpha-v1',precision:'binary64',kernel:'triangle-area-source-axis-row-norm-v1',edge:'transparent-zero-no-renormalization',footprints:[{x:-1,y:-1,width:3,height:3}]}};
 const source={assetId:'mapped_source',version:'1',blob:g.put('captured PNG','image/png'),pixels,width:1,height:1,scope:'single-layer',documentRevision:'7',capture:g.json(capture)};
 const maskManifest={...base(maskPixels),schemaVersion:2,dependencies:[source.capture,pixels,hard,effective],plan:{kind:'authored-request-mask-v1',authoring:{width:1,height:1,feather:1,operations:[{kind:'fill'}]},hard,effective,statistics:{hardPixels:1,effectivePixels:1,support:{x:0,y:0,width:1,height:1}},sourceAssetId:'old_source',source:source.capture,sourcePixels:pixels,clip:null,lostEffectivePixels:0}};
 const requestPlan=createIdentityRequestPlan({document:{width:1,height:1},domain:{x:0,y:0,width:1,height:1},sourcePixels:pixels,authoredMask:hard,effectiveMask:effective,dependenciesHash:hash('original-frozen-request'),resolution:'already-contained',approvalId:'old_approval'});
 const mask={assetId:'mapped_mask',version:'1',blob:g.put('mask PNG','image/png'),pixels:maskPixels,width:1,height:1,sourceHash:pixels.hash,polarity:'white-edit',fullAcknowledged:true,empty:false,full:true,plan:g.json(maskManifest),requestPlan};
 const value={source,mask},read=async ref=>JSON.parse(g.objects.get(ref.hash));
 return {...g,value,capture,maskManifest,read,hard,effective};
}

test('retained frozen request metadata binds original observations across changed namespace IDs',async()=>{
 const f=retainedRequest();await validateRetainedRequestMetadata(f.value,f.read,true);
 f.value.source.assetId='another_current_namespace';f.value.mask.assetId='another_mask_namespace';
 const originalDocument=structuredClone(f.capture);originalDocument.plan.capture.documentId='different_old_namespace';const capture=f.json(originalDocument),mask=structuredClone(f.maskManifest);mask.plan.source=capture;mask.dependencies=mask.dependencies.map(ref=>ref.hash===f.value.source.capture.hash?capture:ref);f.value.source.capture=capture;f.value.mask.plan=f.json(mask);
 await validateRetainedRequestMetadata(f.value,f.read,true);
});

for(const fault of ['pixels','dimensions','scope','revision'])test('retained source rejects a well-shaped '+fault+' mismatch',async()=>{
 const f=retainedRequest(),manifest=structuredClone(f.capture);
 if(fault==='pixels'){manifest.pixels=f.put([99,88,77,255],'application/x-ideogram-rgba8');manifest.tiles[0].hash=manifest.pixels.hash;}
 if(fault==='dimensions'){manifest.width=2;manifest.pixels=f.put([17,28,39,255,17,28,39,255],'application/x-ideogram-rgba8');manifest.tiles[0].width=2;manifest.tiles[0].hash=manifest.pixels.hash;}
 if(fault==='scope')manifest.plan.capture.scope='visible-document';if(fault==='revision')manifest.plan.capture.documentRevision='8';
 rasterManifest(manifest);f.value.source.capture=f.json(manifest);
 await assert.rejects(validateRetainedRequestMetadata(f.value,f.read,true));await assert.rejects(validateRetainedRequestMetadata(f.value,f.read,false));
});

for(const field of ['authoredMask','effectiveMask'])test('frozen mask rejects '+field+' mismatch while a stale imported draft remains recoverable',async()=>{
 const f=retainedRequest();f.value.mask.requestPlan[field]=f.put([1,2],'application/x-ideogram-r16le');
 await assert.rejects(validateRetainedRequestMetadata(f.value,f.read,true));await validateRetainedRequestMetadata(f.value,f.read,false);
});

for(const fault of ['pixels','dimensions','kind','sourcePixels','sourceManifest'])test('retained mask rejects a well-shaped '+fault+' mismatch',async()=>{
 const f=retainedRequest(),manifest=structuredClone(f.maskManifest);
 if(fault==='pixels'){manifest.pixels=f.put([0,0,0,255],'application/x-ideogram-rgba8');manifest.tiles[0].hash=manifest.pixels.hash;}
 if(fault==='dimensions')f.value.mask.width=2;
 if(fault==='kind'){Object.assign(manifest,structuredClone(f.capture));f.value.mask.pixels=manifest.pixels;}
 if(fault==='sourcePixels'){const pixels=f.put([99,88,77,255],'application/x-ideogram-rgba8');manifest.dependencies=manifest.dependencies.map(ref=>ref.hash===manifest.plan.sourcePixels.hash?pixels:ref);manifest.plan.sourcePixels=pixels;}
 if(fault==='sourceManifest'){const changed=structuredClone(f.capture);changed.plan.capture.documentId='other_original_document';const source=f.json(changed);manifest.dependencies=manifest.dependencies.map(ref=>ref.hash===manifest.plan.source.hash?source:ref);manifest.plan.source=source;}
 rasterManifest(manifest);f.value.mask.plan=f.json(manifest);await assert.rejects(validateRetainedRequestMetadata(f.value,f.read,true));
 if(['sourcePixels','sourceManifest'].includes(fault))await validateRetainedRequestMetadata(f.value,f.read,false);else await assert.rejects(validateRetainedRequestMetadata(f.value,f.read,false));
});

test('retained metadata accepts absent optional captures and historical authored mask plans',async()=>{
 const f=retainedRequest();delete f.value.source.capture;
 const legacy=structuredClone(f.maskManifest);legacy.plan={kind:'authored-mask-v1',authoring:legacy.plan.authoring,hard:legacy.plan.hard,effective:legacy.plan.effective,statistics:legacy.plan.statistics};legacy.dependencies=[f.hard,f.effective];f.value.mask.plan=f.json(legacy);
 await validateRetainedRequestMetadata(f.value,f.read,true);await validateRetainedRequestMetadata({source:null,mask:null},()=>assert.fail('no optional metadata'),true);
});
