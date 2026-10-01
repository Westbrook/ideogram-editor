import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';

// PERF-8 CP fixtures are finite arithmetic/identity/route bundles. They are not
// full-canvas capture timings, writer durability tests, or native-text shaping.
export const supportedCells=Object.freeze(Array.from({length:16},(_,i)=>`CP${String(i+1).padStart(2,'0')}`));
const labels=Object.freeze(['quantization','passthrough-and-placement','alpha','transformed-edge','radius-0','radius-1','radius-2','radius-64','empty','full','edge','corner','fractional-crop','approved-expansion','approved-clipping','output-grid-mismatch']);
const bytes=a=>Uint8Array.from(a);
const rect=(width,height=1,x=0,y=0)=>({x,y,width,height});
const pixels=(width,height,rgba)=>({width,height,get(x,y,out){out.fill(0);if(x>=0&&y>=0&&x<width&&y<height)out.set(rgba.slice((y*width+x)*4,(y*width+x+1)*4));}});
const coverage=rows=>({width:rows[0].length,height:rows.length,get:(x,y)=>rows[y]?.[x]??0});
const row=(m,y=0)=>Array.from({length:m.width},(_,x)=>m.get(x,y));
const hash=n=>'sha256:'+String(n).repeat(64);
const ref=(n,w,h,b)=>({hash:hash(n),byteLength:String(w*h*b),mediaType:b===4?'application/x-ideogram-rgba8':'application/x-ideogram-r16le'});
const input=(w=12,h=5,domain=rect(4,h,4))=>({document:{width:w,height:h},domain,sourcePixels:ref(1,w,h,4),authoredMask:ref(2,w,h,2),effectiveMask:ref(3,w,h,2),dependenciesHash:hash(4),resolution:'already-contained',approvalId:'cp_approval_1'});
const featherLiteral=Object.freeze([0,0,0,16384,49151,65535,65535,49151,16384,0,0,0]);
const strips=(h=5)=>coverage(Array.from({length:h},()=>featherLiteral));
const expectedCode=code=>error=>error?.code===code;
const rejection=(code,reason)=>error=>error?.code===code&&error?.reason===reason;

async function loadProduction(repo,cp02){
 const load=path=>import(pathToFileURL(resolve(repo,'dist/local',path)).href);
 const [core,mask,plan]=await Promise.all([load('src/raster/core.js'),load('src/raster/mask.js'),load('src/request/raster-plan.js')]);
 if(!cp02)return {core,mask,plan};
 const [history,composition,creation,json]=await Promise.all([load('server/storage/history.js'),load('server/storage/composition.js'),load('server/storage/candidate-document.js'),load('src/protocol/json.js')]);
 if(typeof history.Histories?.prototype.prepareCandidatePreview!=='function')throw Object.assign(new Error('Production candidate placement method is unavailable'),{code:'CP_ROUTE_API_UNAVAILABLE'});
 return {core,mask,plan,history,composition,creation,json};
}

// Only persistence, candidate preparation, and lineage acquisition are fixture
// boundaries. The placement algorithm, state validation, semantic fingerprint,
// document creation, patch construction, contribution and composition all run
// their actual built production implementations. No copy of the route policy
// appears here. Retained native K is a literal, not a claim of shaping a font.
async function placementFixture(api){
 const {core,history,composition,creation,json}=api, content=new Map(), assetPixels=new Map();
 let serial=0,activeCapture;
 const put=value=>{const data=Buffer.from(json.canonical(value)),r={hash:'sha256:'+createHash('sha256').update(data).digest('hex'),byteLength:String(data.length),mediaType:'application/json'};content.set(r.hash,data);return r;};
 const verify=r=>{const data=content.get(r.hash);assert(data,'fixture metadata must exist');assert.equal(String(data.length),r.byteLength);return data;};
 const asset=(id,rgba)=>{assetPixels.set(id,bytes(rgba));return {id,raster:{width:1,height:1}};};
 asset('black',[0,0,0,255]);asset('white',[255,255,255,26]);asset('native',[255,255,255,14]);
 const layer=(id,kind='image')=>({id,version:'1',kind,name:id,assetId:id,layerToDocument:[...core.IDENTITY],opacity:1,visible:true,locked:false,blend:'normal',mask:null,...(kind==='text'?{source:put({fixture:'retained-native-text-identity'})}:{})});
 const before={schemaVersion:2,width:1,height:1,layers:[layer('black'),layer('white'),layer('native','text')]};
 const stateVersion=state=>({state:put(state),semanticDigest:history.semanticDigest(state),compositeAssetId:'original_composite'});
 const source=stateVersion(before);
 const document={id:'cp_document',revision:'7',branchId:'cp_branch',width:1,height:1,color:'sRGB',depth:8,orderedLayerIds:before.layers.map(l=>l.id),historyHead:'cp_head',checkpoint:null,compositionVersion:null,image:source,redo:null};
 const render=state=>core.composite(state.layers.filter(l=>l.visible).map(l=>core.contribution(pixels(1,1,assetPixels.get(l.assetId)),rect(1),l.layerToDocument,l.opacity)),4);
 const h=new history.Histories({prepare:()=>({get:()=>undefined,iterate:function*(){}})},{verify,prove:async()=> 'cp_fixture_proof'},{asset:()=>null},{
  async retainCandidate(prepared){return {asset:asset('retained_'+(++serial),assetPixels.get(prepared.id)),proofs:[]};},
  async prepareDocument(body){const value=core.composite(body.layers.map(l=>core.contribution(pixels(1,1,assetPixels.get(l.assetId)),rect(1),l.transform,l.opacity)),4);return {asset:asset('composite_'+(++serial),value),proofs:[]};}
 },null,{limits:()=>{}},{async prepareAdoption(){const selected=activeCapture.layerIds.map(id=>assetPixels.get(id));return {asset:asset('prepared_'+(++serial),core.composite(selected,4)),proofs:[],identity:{documentId:document.id},plan:null,outputMapping:null,coverage:null,sourceCapture:structuredClone(activeCapture),check:()=>{}};}},()=>{},()=>{},()=>{},id=>id===document.id?document:null,()=>{});
 h.adoptedLineage=()=>({fixture:'lineage-outside-finite-placement-bundle'});
 const capture=(scope,ids)=>({schemaVersion:1,documentId:document.id,documentRevision:document.revision,image:structuredClone(source),scope,layerIds:ids});
 const preview=async(captured,placement='current-document',state=before,currentSource=source)=>{
  activeCapture=structuredClone(captured);
  const body={type:'PrepareCandidateAdoption',candidateId:'cp_candidate',mode:'safe-region',placement,newDocumentId:placement==='new-document'?'cp_new_document':null,actualOutput:null,newLayerId:'replacement',name:'CP replacement'};
  const result=await h.prepareCandidatePreview({body},document,state,currentSource,'cp_preview','cp_slot',()=>{},async value=>put(value),[]);
  return {preview:result.preview,state:JSON.parse(verify(result.preview.after.state))};
 };
 return {before,source,document,render,capture,preview,stateVersion,h,composition,creation,verify};
}

async function execute(id,api,check,observations,counters){
 const {core:c,mask:m,plan:p}=api;
 const ok=(name,fn)=>{fn();check(name);};
 const mapped=(extra={})=>{const {domain,...common}=input();return p.createRequestRasterPlan({...common,crop:domain,padding:{left:0,top:0,right:0,bottom:0},requestGrid:{width:2,height:5},...extra});};
 switch(id){
 case 'CP01': {
  const black=bytes([0,0,0,255]),k=c.contribution(pixels(1,1,[255,255,255,255]),rect(1),c.IDENTITY,.1),replacement=c.contribution(pixels(1,1,k),rect(1),c.IDENTITY,1);
  ok('F01 opacity quantizes once to alpha 26',()=>assert.deepEqual(k,bytes([255,255,255,26])));
  ok('F01 canonical before, same-slot replacement and retained undo are exactly 90',()=>{for(const contribution of [k,replacement,k])assert.deepEqual(c.composite([black,contribution],4),bytes([90,90,90,255]));});
  ok('transform then layer mask then opacity',()=>assert.deepEqual(c.contribution(pixels(1,1,[255,255,255,255]),rect(1),c.IDENTITY,.1,{width:1,height:1,get:()=>32768}),bytes([255,255,255,13])));break;
 }
 case 'CP02': {
  const hidden=bytes([17,99,231,0,255,0,0,128]);
  ok('empty, singleton, identity and M=0 preserve hidden RGB exactly',()=>{assert.deepEqual(c.composite([],8),new Uint8Array(8));assert.deepEqual(c.composite([hidden],8),hidden);assert.deepEqual(c.contribution(pixels(2,1,hidden),rect(2),c.IDENTITY,1),hidden);assert.deepEqual(c.preserve(hidden,new Uint8Array(8),new Uint16Array(2)),hidden);});
  const f=await placementFixture(api),original=structuredClone(f.before);
  ok('F04 original three contributions are 108; unsafe grouping is 109',()=>{assert.deepEqual(f.render(f.before),bytes([108,108,108,255]));assert.deepEqual(c.composite([bytes([90,90,90,255]),bytes([255,255,255,14])],4),bytes([109,109,109,255]));});
  await assert.rejects(()=>f.preview(f.capture('selected-layers',['black','white'])),rejection('INCOMPATIBLE','NEW_DOCUMENT_REQUIRED'));check('production placement rejects contiguous multilayer capture');
  const single=await f.preview(f.capture('single-layer',['white']));
  ok('production placement inserts at exact rendered slot and retains all other K/order',()=>{assert.deepEqual(single.state.layers.map(l=>[l.id,l.visible]),[['black',true],['white',false],['replacement',true],['native',true]]);assert.deepEqual(single.state.layers[0],original.layers[0]);assert.deepEqual(single.state.layers[3],original.layers[2]);assert.deepEqual(single.state.layers[2].layerToDocument,c.IDENTITY);assert.equal(single.state.layers[2].opacity,1);assert.equal(single.state.layers[2].mask,null);assert.deepEqual(f.render(single.state),bytes([108,108,108,255]));});
  ok('retained undo and redo versions remain 108 with native editability and exact inverse patch',()=>{const undo=f.h.versionState(f.source),redo=f.h.versionState(single.preview.after);assert.deepEqual(undo,original);assert.deepEqual(f.render(undo),bytes([108,108,108,255]));assert.deepEqual(f.render(redo),bytes([108,108,108,255]));const inverse=f.composition.imagePatch(single.state,undo,'AdoptCandidate');assert.deepEqual(inverse.order,original.layers.map(l=>l.id));assert.deepEqual(inverse.layers.find(l=>l.id==='white').value,original.layers[1]);assert.equal(inverse.layers.find(l=>l.id==='replacement').value,null);assert.equal(undo.layers[2].kind,'text');assert.deepEqual(undo.layers[2].source,original.layers[2].source);});
  const newdoc=await f.preview(f.capture('selected-layers',['black','white']),'new-document');
  ok('production new-document route preserves original 108 and native source',()=>{const created=f.creation.candidateDocument(newdoc.preview,newdoc.state,'cp_new_document','cp_new_history','cp_new_branch');assert.deepEqual(created.document.orderedLayerIds,['replacement']);assert.equal(created.history.parent,null);assert.deepEqual(f.before,original);assert.deepEqual(f.render(f.before),bytes([108,108,108,255]));assert.deepEqual(f.render(newdoc.state),bytes([90,90,90,255]));});
  const root=await f.preview(f.capture('visible-document',['black','white','native']));
  ok('complete visible ROOT yields singleton 108 and no retained visible overlay',()=>{assert.deepEqual(root.state.layers.filter(l=>l.visible).map(l=>l.id),['replacement']);assert.deepEqual(f.render(root.state),bytes([108,108,108,255]));assert.equal(root.state.layers.find(l=>l.id==='native').kind,'text');});
  await assert.rejects(()=>f.preview(f.capture('visible-document',['black','white'])),rejection('STALE_REVISION','REQUEST_SOURCE_CHANGED'));check('production ROOT route rejects an extra retained visible overlay');
  const stale=f.capture('single-layer',['white']);stale.documentRevision='6';
  await assert.rejects(()=>f.preview(stale),rejection('STALE_REVISION','REQUEST_SOURCE_CHANGED'));check('production placement rejects stale source revision');
  const reordered=structuredClone(f.before);reordered.layers.reverse();
  await assert.rejects(()=>f.preview(f.capture('single-layer',['white']),'current-document',reordered,f.stateVersion(reordered)),rejection('STALE_REVISION','REQUEST_SOURCE_CHANGED'));check('production placement rejects changed stack fingerprint');
  const changedNative=structuredClone(f.before);changedNative.layers[2].source={...changedNative.layers[2].source,hash:hash(8)};
  await assert.rejects(()=>f.preview(f.capture('single-layer',['white']),'current-document',changedNative,f.stateVersion(changedNative)),rejection('STALE_REVISION','REQUEST_SOURCE_CHANGED'));check('production placement rejects changed native render/source identity');
  observations.push({scope:'finite-production-route-harness',productionMethods:['Histories.prepareCandidatePreview','Histories.versionState','semanticDigest','imagePatch','candidateDocument','contribution','composite'],substitutedBoundaries:['in-memory metadata and absent-ID lookups','candidate preparation and lineage','retained raster materialization using production arithmetic','text limit accounting'],notClaimed:['durable Undo/Redo commit','native font shaping','full-canvas equality']});
  counters.routeChecks=8;break;
 }
 case 'CP03': {
  const source=bytes([17,99,231,0,255,0,0,128,255,255,255,255]),candidate=bytes([255,255,255,255,0,0,255,128,0,0,0,0]);
  ok('M=0 hidden RGB, fractional premultiplied color and full candidate alpha',()=>assert.deepEqual(c.preserve(source,candidate,new Uint16Array([0,32768,65535])),bytes([17,99,231,0,188,0,188,128,0,0,0,0])));
  ok('alpha-zero nonidentity contribution has no hidden color fringe',()=>assert.deepEqual(c.contribution(pixels(2,1,[255,0,0,0,0,0,255,255]),rect(1,1,1),[1,0,0,1,.5,0],1),bytes([0,0,255,128])));break;
 }
 case 'CP04': {
  const source=pixels(2,1,[255,0,0,255,0,0,255,255]);
  ok('half-pixel transformed edges use linear premultiplied color and zero padding',()=>assert.deepEqual(c.contribution(source,rect(3),[1,0,0,1,.5,0],1),bytes([255,0,0,128,188,0,188,255,0,0,255,128])));
  ok('minification uses independent rational coefficients without edge normalization',()=>{assert.equal(c.coefficient(1,0,2),7/16);assert.equal(c.coefficient(1,2,2),1/16);assert.deepEqual(c.contribution(source,rect(1),[.5,0,0,1,0,0],1),bytes([188,0,188,223]));});
  const long=pixels(520,1,Array.from({length:520},(_,x)=>x%2?[0,0,255,255]:[255,0,0,255]).flat());
  ok('transformed 128 and 512 tile edges share identical coefficients',()=>{for(const x of [127,128,129,511,512,513])assert.deepEqual(c.contribution(long,rect(1,1,x),[1,0,0,1,.5,0],1),bytes([188,0,188,255]));});break;
 }
 case 'CP05':case 'CP06':case 'CP07':case 'CP08': {
  const radius={CP05:0,CP06:1,CP07:2,CP08:64}[id];
  const strip={width:12,height:5,get:x=>x>=4&&x<8?65535:0};
  if(radius<=1)ok(`radius ${radius} is exact identity`,()=>assert.deepEqual([...c.feather(strip,rect(12),radius)],[0,0,0,0,65535,65535,65535,65535,0,0,0,0]));
  else if(radius===2)ok('F02 radius 2 literal support is 3 through 8 with edge 16384',()=>assert.deepEqual([...c.feather(strip,rect(12),radius)],featherLiteral));
  else ok('radius 64 globally normalized 2D impulse quantizes once to 16',()=>assert.deepEqual([...c.feather({width:1,height:1,get:(x,y)=>x===0&&y===0?65535:0},rect(1),radius)],[16]));
  const bounded={width:12,height:5,get:(x,y)=>x>=4&&x<8&&y>=0&&y<5?65535:0};
  ok(`radius ${radius} row implementation equals complete 2D production filter`,()=>{const rows=m.featherRows(bounded,radius),expected=c.feather(bounded,rect(12,5),radius);for(let y=0;y<5;y++)assert.deepEqual([...rows(y)],[...expected.slice(y*12,(y+1)*12)]);});
  counters.radius=radius;break;
 }
 case 'CP09': {
  const plan=p.createIdentityRequestPlan(input(4,1,rect(4))),empty=coverage([[0,0,0,0]]);
  ok('empty authored and feathered mask retain zeros',()=>{const hard=m.authoredCoverage({width:4,height:1,feather:2,operations:[]});assert.deepEqual([...m.featherRows(hard,2)(0)],[0,0,0,0]);});
  ok('empty final coverage and expansion are rejected',()=>{assert.throws(()=>p.requireRequestCoverage(plan,empty),expectedCode('EMPTY_MASK'));assert.throws(()=>p.proposeRequestExpansion(plan,empty),expectedCode('EMPTY_MASK'));});break;
 }
 case 'CP10': {
  const plan=p.createIdentityRequestPlan(input(4,1,rect(4))),full=coverage([[65535,65535,65535,65535]]);
  ok('full domain is reported as full and provider mask is opaque white',()=>{assert.deepEqual(p.requireRequestCoverage(plan,full),{effectivePixels:4,lostPixels:0,fullDocument:true,fullDomain:true,contained:true});assert.deepEqual([...p.providerMaskRow(plan,full,0)],Array(16).fill(255));});
  ok('full M selects candidate including hidden RGB',()=>{const candidate=bytes([17,99,231,0]);assert.deepEqual(c.preserve(bytes([0,0,0,255]),candidate,new Uint16Array([65535])),candidate);});break;
 }
 case 'CP11': {
  const full=m.authoredCoverage({width:5,height:5,feather:2,operations:[{kind:'fill'}]}),filtered=m.featherRows(full,2);
  ok('document edge has zero extension, not renormalization',()=>{assert.equal(filtered(2)[0],49151);assert.equal(filtered(2)[2],65535);});
  const strip={width:520,height:5,get:(x,y)=>x>=510&&x<514&&y>=0&&y<5?65535:0},whole=c.feather(strip,rect(520,5),2),stitched=new Uint16Array(whole.length);
  for(let y=0;y<5;y++){stitched.set(c.feather(strip,rect(512,1,0,y),2),y*520);stitched.set(c.feather(strip,rect(8,1,512,y),2),y*520+512);}
  ok('512 tile halo preserves whole-grid exact R16 at seam',()=>assert.deepEqual(stitched,whole));break;
 }
 case 'CP12': {
  const full=m.authoredCoverage({width:5,height:5,feather:2,operations:[{kind:'fill'}]});
  ok('corner globally normalized product is one final R16 value 36863',()=>assert.equal(m.featherRows(full,2)(0)[0],36863));
  ok('isolated corner impulse radius 2 is 16384',()=>assert.deepEqual([...c.feather({width:1,height:1,get:(x,y)=>x===0&&y===0?65535:0},rect(1),2)],[16384]));break;
 }
 case 'CP13': {
  ok('fractional crop requires explicit outward integer proposal',()=>assert.deepEqual(p.proposeIntegerRequestCrop({x:3.2,y:1.8,width:4.1,height:2.1}),{x:3,y:1,width:5,height:3}));
  const plan=mapped();ok('fractional crop cannot borrow an existing mapping approval',()=>assert.throws(()=>p.validateRequestRasterPlan({...plan,crop:{x:4.5,y:0,width:4,height:5}}),expectedCode('MASK_MAPPING_REVIEW_REQUIRED')));break;
 }
 case 'CP14': {
  const mask=strips(),identity=p.createIdentityRequestPlan(input());
  ok('F02 identity crop blocks nonzero feather outside [4,8)',()=>assert.throws(()=>p.requireRequestCoverage(identity,mask),expectedCode('MASK_DOMAIN_REVIEW_REQUIRED')));
  const expanded=p.createIdentityRequestPlan({...input(),domain:rect(6,5,3),resolution:'expanded-and-approved',approvalId:'cp_expanded_identity'});
  ok('explicit identity expansion [3,9) preserves all 30 support pixels',()=>assert.equal(p.requireRequestCoverage(expanded,mask).effectivePixels,30));
  const plan=mapped(),before=structuredClone(plan),proposal=p.proposeRequestExpansion(plan,mask);
  ok('4 to 2 safe interior is independently [5,7)',()=>assert.deepEqual(p.requestSafeInterior(plan),rect(2,5,5)));
  ok('F02 resized expansion is [2,10) to 4 output pixels',()=>assert.deepEqual(proposal,{crop:rect(8,5,2),padding:{left:0,top:0,right:0,bottom:0},domain:rect(8,5,2),requestGrid:{width:4,height:5},expectedOutput:{width:4,height:5}}));
  const accepted=mapped({...proposal,resolution:'expanded-and-approved',approvalId:'cp_expanded_scaled'});
  ok('approved expanded mapping covers full support without rewriting prior plan',()=>{assert.equal(p.requireRequestCoverage(accepted,mask).effectivePixels,30);assert.deepEqual(plan,before);assert.deepEqual(row(mask,2),featherLiteral);});break;
 }
 case 'CP15': {
  const mask=strips(),identity=p.createIdentityRequestPlan({...input(),resolution:'clipped-and-approved'}),clipped=p.clipRequestCoverage(identity,mask);
  ok('explicit identity clipping retains original samples and does not reblur',()=>{assert.deepEqual(row(clipped,2),[0,0,0,0,49151,65535,65535,49151,0,0,0,0]);assert.equal(p.requireRequestCoverage(identity,clipped).effectivePixels,20);assert.deepEqual(row(mask,2),featherLiteral);});
  const plan=mapped({resolution:'clipped-and-approved'}),scaled=p.clipRequestCoverage(plan,mask);
  ok('resized clipping keeps only independently safe [5,7)',()=>{assert.deepEqual(row(scaled,2),[0,0,0,0,0,65535,65535,0,0,0,0,0]);assert.equal(p.requireRequestCoverage(plan,scaled).effectivePixels,10);});break;
 }
 case 'CP16': {
  const plan=mapped(),before=structuredClone(plan),mask=p.clipRequestCoverage(plan,strips());
  ok('unexpected width 1 is not accepted under prior expected mapping',()=>assert.throws(()=>p.requireActualOutput(plan,1,5),expectedCode('OUTPUT_MAPPING_REVIEW_REQUIRED')));
  const successor=p.createActualOutputMapping(plan,{actualOutput:{width:1,height:5},effectiveMask:plan.effectiveMask,resolution:'already-contained',approvalId:'cp_actual_1'});
  ok('width 1 cannot reconstruct prior safe pixels or invent missing samples',()=>{assert.deepEqual(p.requestSafeInterior(plan,successor),rect(0,5,6));assert.throws(()=>p.requireRequestCoverage(plan,mask,successor),expectedCode('MASK_DOMAIN_REVIEW_REQUIRED'));assert.throws(()=>p.requireRequestCoverage(plan,p.clipRequestCoverage(plan,mask,successor),successor),expectedCode('EMPTY_MASK'));assert.deepEqual(plan,before);});
  ok('successor needs its own approval and exact actual grid',()=>{assert.throws(()=>p.createActualOutputMapping(plan,{actualOutput:{width:1,height:5},effectiveMask:plan.effectiveMask,resolution:'already-contained',approvalId:plan.approvalId}),expectedCode('REQUEST_RASTER_APPROVAL_REQUIRED'));assert.throws(()=>p.requireOutputMapping(plan,{...successor,actualOutput:{width:2,height:5}},1,5),expectedCode('MASK_MAPPING_REVIEW_REQUIRED'));});break;
 }
 default:throw new Error('Unreachable CP fixture');
 }
}

export async function runCell(context,cell){
 const cellId=cell?.operation??cell?.id,phases=[],assertions=[],observations=[],evidence=[],missing=[],counters={};
 const result=status=>({cellId,status,phases,assertions,observations,evidence,missing,counters});
 if(!supportedCells.includes(cellId)){missing.push({code:'UNSUPPORTED_CP_CELL',cellId:cellId??null});return result('inconclusive');}
 const phase=async(name,run)=>{const startMs=performance.now();try{return await run();}finally{const endMs=performance.now();phases.push({name,startMs,endMs,durationMs:endMs-startMs});}};
 const abort=()=>{if(context?.signal?.aborted)throw Object.assign(new Error('Campaign interrupted'),{code:'ABORT_ERR'});};
 try{
  abort();if(typeof context?.repo!=='string')throw Object.assign(new Error('A repository path is required'),{code:'CP_REPO_REQUIRED'});
  const api=await phase('load-production-modules',()=>loadProduction(context.repo,cellId==='CP02'));
  const check=name=>{abort();assertions.push({name,passed:true});};
  observations.push({fixture:cellId,identity:labels[supportedCells.indexOf(cellId)],specification:'docs/spec/performance.md CP01–CP16; docs/spec/testing.md F01/F02/F04',timing:'finite-assertion-bundle',ceilingMs:500});
  await phase('finite-assertion-bundle',()=>execute(cellId,api,check,observations,counters));
  const duration=phases.reduce((sum,phase)=>sum+phase.durationMs,0);
  assert(duration<=500,`CP finite assertion bundle including production-module setup ${duration.toFixed(3)}ms exceeds 500ms`);
  check('finite arithmetic/identity/route bundle including production-module setup completes within 500ms');
  counters.assertions=assertions.length;
  return result('pass');
 }catch(error){
  const unavailable=['ERR_MODULE_NOT_FOUND','MODULE_NOT_FOUND','CP_ROUTE_API_UNAVAILABLE','CP_REPO_REQUIRED','ABORT_ERR'].includes(error?.code);
  if(unavailable)missing.push({code:error.code,message:String(error.message)});
  else assertions.push({name:'CP bundle correctness and timing',passed:false,error:{code:error?.code??null,message:String(error?.message??error)}});
  return result(unavailable?'inconclusive':'fail');
 }
}
