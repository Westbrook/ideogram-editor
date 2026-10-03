import {integerIdentity, preserve, contribution, coefficient, sampling, footprint, PIXEL_PIPELINE, type Affine, type Coverage, type Pixels, type Rect} from '../raster/core.js';
import type {BlobRef} from '../protocol/store.js';
import {canonical} from '../protocol/json.js';

type Grid = {width:number;height:number};
export type RequestPadding = {left:number;top:number;right:number;bottom:number};
type CommonPlan = {
  document: Grid;
  domain: Rect;
  expectedOutput: Grid;
  sourcePixels: BlobRef;
  authoredMask: BlobRef;
  effectiveMask: BlobRef;
  dependenciesHash: string;
  resolution: 'already-contained'|'expanded-and-approved'|'clipped-and-approved';
  approvalId: string;
  sourceToRequest: Affine;
};
// The original profile remains readable, byte-for-byte. It never acquires a
// different kernel, extent or nonzero halo through a migration/default.
export type IdentityRequestRasterPlan = CommonPlan & {
  kind:'request-raster-plan-1';kernel:'cp1-identity-grid-v1';reconstructionHalo:0;
};
export type MappedRequestRasterPlan = CommonPlan & {
  kind:'request-raster-plan-2';
  crop:Rect;
  padding:RequestPadding;
  paddingPolicy:'transparent';
  requestGrid:Grid;
  outputToDocument:Affine;
  kernel:typeof PIXEL_PIPELINE;
  footprint:'cp1-request-footprint-v1';
  reconstructionHalo:number;
};
export type RequestRasterPlan = IdentityRequestRasterPlan|MappedRequestRasterPlan;
export type RequestRasterDependencies = Pick<CommonPlan,'document'|'sourcePixels'|'authoredMask'|'effectiveMask'|'dependenciesHash'>;
export type IdentityRequestPlanInput = Omit<IdentityRequestRasterPlan,'kind'|'kernel'|'sourceToRequest'|'expectedOutput'|'reconstructionHalo'>;
export type RequestRasterPlanInput = Omit<CommonPlan,'domain'|'sourceToRequest'|'expectedOutput'> & {
  crop:Rect;padding:RequestPadding;requestGrid:Grid;expectedOutput?:Grid;
};
// This is a preparation successor, never a rewrite of accepted job provenance.
// The entire original plan is retained and matched, including its domain. A
// returned candidate cannot gain missing pixels by enlarging that domain.
export type RequestOutputMapping = {
  kind:'request-output-mapping-1';
  requestPlan:RequestRasterPlan;
  actualOutput:Grid;
  effectiveMask:BlobRef;
  resolution:'already-contained'|'clipped-and-approved';
  approvalId:string;
  outputToDocument:Affine;
  kernel:typeof PIXEL_PIPELINE;
  reconstructionHalo:number;
};
export type ActualOutputMappingInput = Pick<RequestOutputMapping,'actualOutput'|'effectiveMask'|'resolution'|'approvalId'>;
export class RequestRasterError extends Error {
  constructor(readonly code:string){super(code);}
}
const fail=(code:string):never=>{throw new RequestRasterError(code);};
const exact=(value:any,fields:string[])=>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==fields.length||fields.some(k=>!Object.hasOwn(value,k)))fail('REQUEST_RASTER_PLAN_INVALID');
};
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0;
const digest=(v:unknown):v is string=>typeof v==='string'&&/^sha256:[a-f0-9]{64}$/.test(v);
const approval=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
function grid(v:any){
  exact(v,['width','height']);
  if(!positive(v.width)||!positive(v.height)||v.width>8192||v.height>8192||v.width*v.height>25000000)fail('REQUEST_RASTER_EXTENT');
}
function rect(v:any){
  exact(v,['x','y','width','height']);
  if(![v.x,v.y,v.width,v.height].every(Number.isSafeInteger)||!positive(v.width)||!positive(v.height))fail('MASK_MAPPING_REVIEW_REQUIRED');
}
function pixels(ref:any,width:number,height:number,bytes:number,mediaType:string){
  exact(ref,['hash','byteLength','mediaType']);
  if(!digest(ref.hash)||ref.byteLength!==String(width*height*bytes)||ref.mediaType!==mediaType)fail('REQUEST_RASTER_IDENTITY');
}
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const translation=(n:number)=>n===0?0:-n;
function sourceTransform(domain:Rect,request:Grid):Affine {
  const sx=request.width/domain.width,sy=request.height/domain.height;
  return [sx,0,0,sy,domain.x===0?0:-domain.x*sx,domain.y===0?0:-domain.y*sy];
}
function outputTransform(domain:Rect,output:Grid):Affine {
  return [domain.width/output.width,0,0,domain.height/output.height,domain.x,domain.y];
}
function affine(value:any,expected:Affine){
  if(!Array.isArray(value)||value.length!==6||!value.every(Number.isFinite)||!same(value,expected))fail('MASK_MAPPING_REVIEW_REQUIRED');
}
function rawRequestGrid(plan:RequestRasterPlan):Grid{return plan.kind==='request-raster-plan-2'?plan.requestGrid:plan.expectedOutput;}
function rawCrop(plan:RequestRasterPlan):Rect{return plan.kind==='request-raster-plan-2'?plan.crop:plan.domain;}

// Containment has two independent finite tests: an edited source cell must
// influence no hypothetical request sample outside the request grid, and every
// output sample used to reconstruct that cell must exist. Composing the entire
// source inverse footprint through output footprints would over-erode F02:
// [4,8)->2 has safe [5,7), and [2,10)->4 safely reconstructs [3,9).
// Input reconstruction itself uses explicit transparent extension outside A.
// The nearest unavailable samples (-1 and N) suffice for these nonnegative,
// separable triangle kernels. Binary searches keep validation O(log extent).
function axisInterior(start:number,length:number,requestSize:number,outputSize:number,inputInverse:number,inputTranslate:number,resultInverse:number,resultTranslate:number){
  const inputSpan=Math.max(1,inputInverse);
  const resultSpan=Math.max(1,resultInverse);
  const before=(offset:number)=>{
    const p=start+offset,q=resultInverse*(p+.5)+resultTranslate;
    return coefficient(inputInverse*(-.5)+inputTranslate,p,inputSpan)===0&&coefficient(q,-1,resultSpan)===0;
  };
  const after=(offset:number)=>{
    const p=start+offset,q=resultInverse*(p+.5)+resultTranslate;
    return coefficient(inputInverse*(requestSize+.5)+inputTranslate,p,inputSpan)===0&&coefficient(q,outputSize,resultSpan)===0;
  };
  let lo=0,hi=length;
  while(lo<hi){const mid=Math.floor((lo+hi)/2);if(before(mid))hi=mid;else lo=mid+1;}
  const left=lo;
  lo=0;hi=length;
  while(lo<hi){const mid=Math.floor((lo+hi)/2);if(after(mid))lo=mid+1;else hi=mid;}
  return {start:start+left,end:start+lo,left,right:length-lo};
}
function mappingInteriors(d:Rect,r:Grid,output:Grid){
  // Use core's exact determinant/inverse arithmetic, including its rounding;
  // algebraically equivalent divisions can disagree at a zero-weight edge.
  const input=sampling(sourceTransform(d,r)).inverse,result=sampling(outputTransform(d,output)).inverse;
  const x=axisInterior(d.x,d.width,r.width,output.width,input[0],input[4],result[0],result[4]);
  const y=axisInterior(d.y,d.height,r.height,output.height,input[3],input[5],result[3],result[5]);
  return {x,y,halo:Math.max(x.left,x.right,y.left,y.right)};
}
function rawInterior(plan:RequestRasterPlan,output=plan.expectedOutput){
  const d=plan.domain,r=rawRequestGrid(plan);
  return mappingInteriors(d,r,output);
}
function validCommon(value:any){
  grid(value.document);grid(value.expectedOutput);rect(value.domain);
  if(!['already-contained','expanded-and-approved','clipped-and-approved'].includes(value.resolution)||!approval(value.approvalId)||!digest(value.dependenciesHash))fail('REQUEST_RASTER_APPROVAL_REQUIRED');
  const {width,height}=value.document;
  pixels(value.sourcePixels,width,height,4,'application/x-ideogram-rgba8');
  pixels(value.authoredMask,width,height,2,'application/x-ideogram-r16le');
  pixels(value.effectiveMask,width,height,2,'application/x-ideogram-r16le');
}
export function validateRequestRasterPlan(value:any):asserts value is RequestRasterPlan {
  const common=['kind','document','domain','expectedOutput','sourcePixels','authoredMask','effectiveMask','dependenciesHash','resolution','approvalId','kernel','sourceToRequest','reconstructionHalo'];
  if(value?.kind==='request-raster-plan-1'){
    exact(value,common);validCommon(value);
    const d=value.domain,m=value.sourceToRequest;
    if(d.x<0||d.y<0||d.x+d.width>value.document.width||d.y+d.height>value.document.height)fail('MASK_MAPPING_REVIEW_REQUIRED');
    if(value.kernel!=='cp1-identity-grid-v1'||value.reconstructionHalo!==0||!Array.isArray(m)||m.length!==6||!m.every(Number.isFinite)||!integerIdentity(m as unknown as Affine)||m[4]!==-d.x||m[5]!==-d.y||value.expectedOutput.width!==d.width||value.expectedOutput.height!==d.height)fail('MASK_MAPPING_REVIEW_REQUIRED');
    return;
  }
  exact(value,[...common,'crop','padding','paddingPolicy','requestGrid','outputToDocument','footprint']);
  if(value.kind!=='request-raster-plan-2')fail('REQUEST_RASTER_PLAN_INVALID');
  validCommon(value);rect(value.crop);grid(value.requestGrid);grid({width:value.domain.width,height:value.domain.height});
  const c=value.crop,p=value.padding;
  if(c.x<0||c.y<0||c.x+c.width>value.document.width||c.y+c.height>value.document.height)fail('MASK_MAPPING_REVIEW_REQUIRED');
  exact(p,['left','top','right','bottom']);
  if(!Object.values(p).every(v=>Number.isSafeInteger(v)&&Number(v)>=0))fail('MASK_MAPPING_REVIEW_REQUIRED');
  const d={x:c.x-p.left,y:c.y-p.top,width:c.width+p.left+p.right,height:c.height+p.top+p.bottom};
  if(!same(d,value.domain)||value.paddingPolicy!=='transparent'||value.kernel!==PIXEL_PIPELINE||value.footprint!=='cp1-request-footprint-v1')fail('MASK_MAPPING_REVIEW_REQUIRED');
  // Added context inside D is captured source, not transparent padding. Only
  // the portion of the approved domain beyond D may carry padding samples.
  const intersection={x:Math.max(0,d.x),y:Math.max(0,d.y),width:Math.min(value.document.width,d.x+d.width)-Math.max(0,d.x),height:Math.min(value.document.height,d.y+d.height)-Math.max(0,d.y)};
  if(!same(c,intersection))fail('MASK_MAPPING_REVIEW_REQUIRED');
  affine(value.sourceToRequest,sourceTransform(d,value.requestGrid));
  affine(value.outputToDocument,outputTransform(d,value.expectedOutput));
  if(value.reconstructionHalo!==rawInterior(value).halo)fail('MASK_MAPPING_REVIEW_REQUIRED');
}
export function createIdentityRequestPlan(input:IdentityRequestPlanInput):IdentityRequestRasterPlan {
  const plan:IdentityRequestRasterPlan={...structuredClone(input),kind:'request-raster-plan-1',kernel:'cp1-identity-grid-v1',sourceToRequest:[1,0,0,1,translation(input.domain.x),translation(input.domain.y)],expectedOutput:{width:input.domain.width,height:input.domain.height},reconstructionHalo:0};
  validateRequestRasterPlan(plan);return plan;
}
export function createRequestRasterPlan(input:RequestRasterPlanInput):MappedRequestRasterPlan {
  const copy=structuredClone(input),{crop:c,padding:p}=copy;
  const domain={x:c.x-p.left,y:c.y-p.top,width:c.width+p.left+p.right,height:c.height+p.top+p.bottom};
  const expectedOutput=copy.expectedOutput??{...copy.requestGrid};
  const plan:MappedRequestRasterPlan={...copy,domain,expectedOutput,kind:'request-raster-plan-2',paddingPolicy:'transparent',kernel:PIXEL_PIPELINE,footprint:'cp1-request-footprint-v1',sourceToRequest:sourceTransform(domain,copy.requestGrid),outputToDocument:outputTransform(domain,expectedOutput),reconstructionHalo:0};
  // Validate the inexpensive structural fields before doing footprint searches.
  grid(copy.document);rect(c);grid(copy.requestGrid);grid(expectedOutput);grid({width:domain.width,height:domain.height});
  plan.reconstructionHalo=rawInterior(plan).halo;
  validateRequestRasterPlan(plan);return plan;
}
export function requirePlanDependencies(plan:RequestRasterPlan,expected:RequestRasterDependencies):void {
  validateRequestRasterPlan(plan);
  for(const key of ['document','sourcePixels','authoredMask','effectiveMask','dependenciesHash'] as const)if(!same(plan[key],expected[key]))fail('REQUEST_RASTER_DEPENDENCIES_CHANGED');
}
export function requestRasterGrid(plan:RequestRasterPlan):Grid {validateRequestRasterPlan(plan);return {...rawRequestGrid(plan)};}
export function requestSafeInterior(plan:RequestRasterPlan,mapping?:RequestOutputMapping):Rect {
  validateRequestRasterPlan(plan);if(mapping)requireOutputMapping(plan,mapping,mapping.actualOutput.width,mapping.actualOutput.height);
  const {x,y}=rawInterior(plan,mapping?.actualOutput);
  const left=Math.max(0,x.start),top=Math.max(0,y.start),right=Math.min(plan.document.width,x.end),bottom=Math.min(plan.document.height,y.end);
  return {x:left,y:top,width:Math.max(0,right-left),height:Math.max(0,bottom-top)};
}
function coverageGrid(plan:RequestRasterPlan,coverage:Coverage){
  if(coverage.width!==plan.document.width||coverage.height!==plan.document.height)fail('REQUEST_MASK_GRID_MISMATCH');
}
function sample(coverage:Coverage,x:number,y:number):number {
  const value=coverage.get(x,y);
  if(!Number.isSafeInteger(value)||value<0||value>65535)fail('REQUEST_MASK_COVERAGE_INVALID');
  return value;
}
function inside(d:Rect,x:number,y:number){return x>=d.x&&x<d.x+d.width&&y>=d.y&&y<d.y+d.height;}
export type RequestCoverageInspection = {effectivePixels:number;lostPixels:number;fullDocument:boolean;fullDomain:boolean;contained:boolean};
// Scan retained R16 samples, never a grayscale PNG or client-supplied counts.
// Abort/resource owners may check once at the start of each bounded source row.
export function* inspectRequestCoverageRows(plan:RequestRasterPlan,coverage:Coverage,mapping?:RequestOutputMapping,check?:()=>void):Generator<void,RequestCoverageInspection,void> {
  const safe=requestSafeInterior(plan,mapping);coverageGrid(plan,coverage);
  const crop=rawCrop(plan);let effectivePixels=0,lostPixels=0,cropPixels=0;
  for(let y=0;y<coverage.height;y++){
    check?.();for(let x=0;x<coverage.width;x++)if(sample(coverage,x,y)>0){effectivePixels++;if(!inside(safe,x,y))lostPixels++;if(inside(crop,x,y))cropPixels++;}
    yield;
  }
  return {effectivePixels,lostPixels,fullDocument:effectivePixels===coverage.width*coverage.height,fullDomain:cropPixels===crop.width*crop.height,contained:lostPixels===0};
}
export function* requireRequestCoverageRows(plan:RequestRasterPlan,coverage:Coverage,mapping?:RequestOutputMapping,check?:()=>void):Generator<void,RequestCoverageInspection,void> {
  const result=yield* inspectRequestCoverageRows(plan,coverage,mapping,check);
  if(!result.contained)fail('MASK_DOMAIN_REVIEW_REQUIRED');
  if(result.effectivePixels===0)fail('EMPTY_MASK');
  return result;
}
function completeCoverage(rows:Generator<void,RequestCoverageInspection,void>):RequestCoverageInspection {
  for(;;){const row=rows.next();if(row.done)return row.value;}
}
// Synchronous callers retain immediate validation and the same complete result.
// Storage callers can yield after each row without duplicating coverage math.
export function inspectRequestCoverage(plan:RequestRasterPlan,coverage:Coverage,mapping?:RequestOutputMapping,check?:()=>void):RequestCoverageInspection {
  return completeCoverage(inspectRequestCoverageRows(plan,coverage,mapping,check));
}
export function requireRequestCoverage(plan:RequestRasterPlan,coverage:Coverage,mapping?:RequestOutputMapping,check?:()=>void):RequestCoverageInspection {
  return completeCoverage(requireRequestCoverageRows(plan,coverage,mapping,check));
}
// A proposal only: retain/hash these samples and explicitly approve clipping.
// No reblur after clipping: it would recreate discarded support.
export function clipRequestCoverage(plan:RequestRasterPlan,feathered:Coverage,mapping?:RequestOutputMapping):Coverage {
  const safe=requestSafeInterior(plan,mapping);coverageGrid(plan,feathered);
  return {width:feathered.width,height:feathered.height,get(x,y){return inside(safe,x,y)?sample(feathered,x,y):0;}};
}

function sourceSampling(plan:RequestRasterPlan){
  const s=sampling(plan.sourceToRequest);
  return {sx:s.inverse[0],sy:s.inverse[3],tx:s.inverse[4],ty:s.inverse[5],spanX:s.spanX,spanY:s.spanY,supportX:s.supportX,supportY:s.supportY};
}
// Conservative binary support uses the exact inverse *source* footprint,
// never a resized grayscale mask. Pure padding footprints stay black. A mixed
// footprint is white if ANY positive coefficient reaches nonzero R16 M, even
// when its center is outside D; a center-only test can erase a thin edit.
// Call requireRequestCoverage before streaming rows to a provider PNG.
export function providerMaskRow(plan:RequestRasterPlan,coverage:Coverage,y:number):Uint8Array {
  validateRequestRasterPlan(plan);coverageGrid(plan,coverage);
  const request=rawRequestGrid(plan),d=plan.domain;
  if(!Number.isSafeInteger(y)||y<0||y>=request.height)fail('REQUEST_MASK_ROW');
  const out=new Uint8Array(request.width*4),s=sourceSampling(plan),cy=s.sy*(y+.5)+s.ty;
  for(let x=0;x<request.width;x++){
    const at=x*4,cx=s.sx*(x+.5)+s.tx;let edited=false;
    for(let iy=Math.max(0,d.y,Math.ceil(cy-s.supportY-.5));iy<=Math.min(coverage.height-1,d.y+d.height-1,Math.floor(cy+s.supportY-.5))&&!edited;iy++){
      if(coefficient(cy,iy,s.spanY)===0)continue;
      for(let ix=Math.max(0,d.x,Math.ceil(cx-s.supportX-.5));ix<=Math.min(coverage.width-1,d.x+d.width-1,Math.floor(cx+s.supportX-.5));ix++)if(coefficient(cx,ix,s.spanX)>0&&sample(coverage,ix,iy)>0){edited=true;break;}
    }
    const value=edited?255:0;out[at]=value;out[at+1]=value;out[at+2]=value;out[at+3]=255;
  }
  return out;
}
function transparentPixels(source:Pixels,domain?:Rect):Pixels {
  return {width:source.width,height:source.height,get(x,y,into){
    if(x<0||y<0||x>=source.width||y>=source.height||(domain&&!inside(domain,x,y)))into.fill(0);else source.get(x,y,into);
  }};
}
// Native/captured pixels are never resized for preservation. This is a
// separate provider-input view; omitted crop context is transparent, not read.
export function providerSourceRow(plan:RequestRasterPlan,source:Pixels,y:number):Uint8Array {
  validateRequestRasterPlan(plan);
  const request=rawRequestGrid(plan);
  if(source.width!==plan.document.width||source.height!==plan.document.height)fail('REQUEST_RASTER_SOURCE_GRID_MISMATCH');
  if(!Number.isSafeInteger(y)||y<0||y>=request.height)fail('REQUEST_RASTER_ROW');
  return contribution(transparentPixels(source,plan.domain),{x:0,y,width:request.width,height:1},plan.sourceToRequest,1);
}
export function sourceRequestFootprint(plan:RequestRasterPlan,request:Rect):Rect {
  validateRequestRasterPlan(plan);rect(request);const size=rawRequestGrid(plan);
  if(request.x<0||request.y<0||request.x+request.width>size.width||request.y+request.height>size.height)fail('REQUEST_RASTER_ROW');
  const needed=footprint(request,plan.sourceToRequest),d=plan.domain;
  const x=Math.max(0,d.x,needed.x),y=Math.max(0,d.y,needed.y);
  const right=Math.min(plan.document.width,d.x+d.width,needed.x+needed.width),bottom=Math.min(plan.document.height,d.y+d.height,needed.y+needed.height);
  return {x,y,width:Math.max(0,right-x),height:Math.max(0,bottom-y)};
}
export function requireActualOutput(plan:RequestRasterPlan,width:number,height:number):void {
  validateRequestRasterPlan(plan);
  if(width!==plan.expectedOutput.width||height!==plan.expectedOutput.height)fail('OUTPUT_MAPPING_REVIEW_REQUIRED');
}
export function createActualOutputMapping(plan:RequestRasterPlan,input:ActualOutputMappingInput):RequestOutputMapping {
  validateRequestRasterPlan(plan);grid(input.actualOutput);
  const mapping:RequestOutputMapping={...structuredClone(input),kind:'request-output-mapping-1',requestPlan:structuredClone(plan),outputToDocument:outputTransform(plan.domain,input.actualOutput),kernel:PIXEL_PIPELINE,reconstructionHalo:rawInterior(plan,input.actualOutput).halo};
  requireOutputMapping(plan,mapping,input.actualOutput.width,input.actualOutput.height);return mapping;
}
export function requireOutputMapping(plan:RequestRasterPlan,mapping:RequestOutputMapping,width:number,height:number):void {
  validateRequestRasterPlan(plan);
  exact(mapping,['kind','requestPlan','actualOutput','effectiveMask','resolution','approvalId','outputToDocument','kernel','reconstructionHalo']);
  if(mapping.kind!=='request-output-mapping-1'||mapping.kernel!==PIXEL_PIPELINE)fail('OUTPUT_MAPPING_REVIEW_REQUIRED');
  grid(mapping.actualOutput);
  if(!same(mapping.requestPlan,plan)||!approval(mapping.approvalId)||mapping.approvalId===plan.approvalId||!['already-contained','clipped-and-approved'].includes(mapping.resolution))fail('REQUEST_RASTER_APPROVAL_REQUIRED');
  if(mapping.resolution==='already-contained'&&!same(mapping.effectiveMask,plan.effectiveMask))fail('REQUEST_RASTER_DEPENDENCIES_CHANGED');
  pixels(mapping.effectiveMask,plan.document.width,plan.document.height,2,'application/x-ideogram-r16le');
  affine(mapping.outputToDocument,outputTransform(plan.domain,mapping.actualOutput));
  if(mapping.actualOutput.width!==width||mapping.actualOutput.height!==height||mapping.reconstructionHalo!==rawInterior(plan,mapping.actualOutput).halo)fail('OUTPUT_MAPPING_REVIEW_REQUIRED');
}
// General mapped preparation keeps S full-sized. Only G is reconstructed;
// exact M=0 copies include hidden RGB and pixels outside the request crop.
export function preserveMappedRequestRow(plan:RequestRasterPlan,source:Uint8Array,candidate:Pixels,coverage:Coverage,y:number,mapping?:RequestOutputMapping):Uint8Array {
  validateRequestRasterPlan(plan);coverageGrid(plan,coverage);
  if(mapping)requireOutputMapping(plan,mapping,candidate.width,candidate.height);else requireActualOutput(plan,candidate.width,candidate.height);
  if(!Number.isSafeInteger(y)||y<0||y>=plan.document.height||source.length!==plan.document.width*4)fail('REQUEST_RASTER_ROW');
  const safe=requestSafeInterior(plan,mapping),mask=new Uint16Array(plan.document.width);
  for(let x=0;x<mask.length;x++){const value=sample(coverage,x,y);if(value&&!inside(safe,x,y))fail('MASK_DOMAIN_REVIEW_REQUIRED');mask[x]=value;}
  const transform=mapping?.outputToDocument??outputTransform(plan.domain,plan.expectedOutput);
  const mapped=contribution(transparentPixels(candidate),{x:0,y,width:plan.document.width,height:1},transform,1);
  return preserve(source,mapped,mask);
}
// Compatibility row API has no vertical context for a resampling kernel and
// therefore remains intentionally identity-only. General callers use Pixels.
export function preserveRequestRow(plan:RequestRasterPlan,source:Uint8Array,candidate:Uint8Array|null,coverage:Coverage,y:number):Uint8Array {
  validateRequestRasterPlan(plan);coverageGrid(plan,coverage);
  if(plan.kind!=='request-raster-plan-1')fail('OUTPUT_MAPPING_REVIEW_REQUIRED');
  if(!Number.isSafeInteger(y)||y<0||y>=plan.document.height||source.length!==plan.document.width*4)fail('REQUEST_RASTER_ROW');
  const inRow=y>=plan.domain.y&&y<plan.domain.y+plan.domain.height;
  if(inRow?candidate?.length!==plan.expectedOutput.width*4:candidate!==null)fail('OUTPUT_MAPPING_REVIEW_REQUIRED');
  const mapped=new Uint8Array(source.length),mask=new Uint16Array(plan.document.width);
  if(candidate)mapped.set(candidate,plan.domain.x*4);
  for(let x=0;x<mask.length;x++){
    const value=sample(coverage,x,y);
    if(value&&!inside(plan.domain,x,y))fail('MASK_DOMAIN_REVIEW_REQUIRED');
    mask[x]=value;
  }
  return preserve(source,mapped,mask);
}

export type RequestExpansionProposal = {crop:Rect;padding:RequestPadding;domain:Rect;requestGrid:Grid;expectedOutput:Grid};
// Fractional UI bounds are a proposal, never a silent change to a frozen plan.
// Caller shows/approves the integer expansion and any document-edge clipping.
export function proposeIntegerRequestCrop(bounds:Rect):Rect {
  if(![bounds.x,bounds.y,bounds.width,bounds.height].every(Number.isFinite)||bounds.width<=0||bounds.height<=0)fail('MASK_MAPPING_REVIEW_REQUIRED');
  const x=Math.floor(bounds.x),y=Math.floor(bounds.y),right=Math.ceil(bounds.x+bounds.width),bottom=Math.ceil(bounds.y+bounds.height);
  const proposed={x,y,width:right-x,height:bottom-y};rect(proposed);return proposed;
}
// Proposal only. Preserve each approved scale when its new extent is integral;
// otherwise show the explicit ceil-sized grid and recompute its exact footprint.
// No accepted plan/mask/approval is mutated and no provider call is authorized.
export function proposeRequestExpansionBounds(plan:RequestRasterPlan,support:Rect):RequestExpansionProposal {
  validateRequestRasterPlan(plan);rect(support);
  if(support.x<0||support.y<0||support.x+support.width>plan.document.width||support.y+support.height>plan.document.height)fail('REQUEST_MASK_GRID_MISMATCH');
  const original=plan.domain,request=rawRequestGrid(plan);
  let d={...original};
  for(let step=0;step<64;step++){
    const requestGrid={width:Math.ceil(d.width*request.width/original.width),height:Math.ceil(d.height*request.height/original.height)};
    const expectedOutput={width:Math.ceil(d.width*plan.expectedOutput.width/original.width),height:Math.ceil(d.height*plan.expectedOutput.height/original.height)};
    grid({width:d.width,height:d.height});grid(requestGrid);grid(expectedOutput);
    const {x,y}=mappingInteriors(d,requestGrid,expectedOutput);
    // Expansion is monotone: ceil-sized grids can change the exact halo. A
    // later smaller halo must not shrink an earlier proposal and oscillate.
    const left=Math.min(d.x,support.x-x.left),top=Math.min(d.y,support.y-y.left),right=Math.max(d.x+d.width,support.x+support.width+x.right),bottom=Math.max(d.y+d.height,support.y+support.height+y.right);
    const next={x:left,y:top,width:right-left,height:bottom-top};
    if(same(d,next)){
      const cx=Math.max(0,d.x),cy=Math.max(0,d.y),cr=Math.min(plan.document.width,d.x+d.width),cb=Math.min(plan.document.height,d.y+d.height);
      const crop={x:cx,y:cy,width:cr-cx,height:cb-cy},padding={left:cx-d.x,top:cy-d.y,right:d.x+d.width-cr,bottom:d.y+d.height-cb};
      return {crop,padding,domain:d,requestGrid,expectedOutput};
    }
    d=next;
  }
  return fail('MASK_MAPPING_REVIEW_REQUIRED');
}
export function proposeRequestExpansion(plan:RequestRasterPlan,coverage:Coverage,check?:()=>void):RequestExpansionProposal {
  validateRequestRasterPlan(plan);coverageGrid(plan,coverage);
  let left=coverage.width,top=coverage.height,right=0,bottom=0;
  for(let y=0;y<coverage.height;y++){check?.();for(let x=0;x<coverage.width;x++)if(sample(coverage,x,y)>0){left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x+1);bottom=Math.max(bottom,y+1);}}
  if(right===0||bottom===0)fail('EMPTY_MASK');
  return proposeRequestExpansionBounds(plan,{x:left,y:top,width:right-left,height:bottom-top});
}
