/** V45-A1 staged edit contract. Pure validation/serialization only: no upload,
 * safety admission, provider access, or replacement for owned raster-plan proof.
 * The family adapter retains the complete original Source/Mask authoring plan. */
export const V45_EDIT_CONTRACT='fal-ideogram-v45-edit-1' as const;
export const V45_EDIT_SCHEMA='sha256:4d3d1d59dcb17e2606e16276808056936a2b1b50b24fd06423f56d5406c5a8ea' as const;
export const V45_EDIT_ENDPOINT='ideogram/v4.5/edit' as const;
export const V45_EDIT_PRESETS=['square','square_hd','portrait_4_3','landscape_4_3','portrait_16_9','landscape_16_9'] as const;
export const V45_EDIT_PRESET_DIMENSIONS={square:[512,512],square_hd:[1024,1024],portrait_4_3:[768,1024],landscape_4_3:[1024,768],portrait_16_9:[576,1024],landscape_16_9:[1024,576]} as const;
export const V45_EDIT_PRICE={date:'2026-09-30',source:'https://fal.ai/models/ideogram/v4.5/edit/llms.txt',sourceHash:'sha256:9a553edd11f3ee7e11f2e7007a22f526103a06206755423de1c63e384a540c00',currency:'USD',mediumPerImageCents:6} as const;
export type V45EditOperation='transform-v45'|'inpaint-v45';
export type V45EditFields={precision:string;quality:string;count:string;seed:string;size:string;width:string;height:string};
export type V45EditBlob={hash:string;byteLength:string;mediaType:string};
/** Provider-grid descriptors only. Original asset/scope/capture/authoring
 * identities remain in the family envelope and are never relabeled here. */
export type V45EditSource={blob:V45EditBlob;pixels:V45EditBlob;manifest:V45EditBlob;pixelIdentity:string;width:number;height:number};
export type V45EditMask=V45EditSource&{polarity:'black-edit';editPixels:number;keepPixels:number;sourcePixels:V45EditBlob};
export type V45EditBinaryCoverage={width:number;height:number;polarity:'white-edit';samples:Uint8Array};
export type V45EditSize='auto'|typeof V45_EDIT_PRESETS[number]|{width:number;height:number};
export type V45EditSeed={kind:'provider-random'}|{kind:'integer';decimal:string};
export type V45EditBody={prompt:string;image_url:string;mask_url?:string;reference_image_urls?:string[];image_size:V45EditSize;edit_precision:'regular'|'high';quality:'medium';num_images:1|2|3|4;sync_mode:false};
export type V45EditRequest={
 kind:V45EditOperation;contract:typeof V45_EDIT_CONTRACT;endpoint:typeof V45_EDIT_ENDPOINT;schemaHash:typeof V45_EDIT_SCHEMA;
 source:V45EditSource;mask:V45EditMask|null;references:V45EditSource[];requested:{width:number;height:number};seed:V45EditSeed;body:V45EditBody;
 outputFormat:'provider-controlled';outputSafety:'unknown';candidateAdmission:'withheld';safetyAdmission:'blocked-unavailable-evidence';production:'blocked-unqualified-upload';
 estimate:{currency:'USD';cents:number;rateDate:'2026-09-30';rateSource:string;rateSourceHash:string;actualCharge:null};
};
export type V45EditInput={operation:V45EditOperation;prompt:string;promptMode:'plain'|'raw'|'composition';fields:V45EditFields;source:V45EditSource;mask:V45EditMask|null;references:V45EditSource[]};
export class V45EditContractError extends Error {
 readonly code:string;readonly field:string;
 constructor(field:string,code:string){super(code);this.name='V45EditContractError';this.field=field;this.code=code;}
}
const fail=(field:string,code:string):never=>{throw new V45EditContractError(field,code);};
const exact=(value:unknown,keys:readonly string[],field:string):Record<string,unknown>=>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Reflect.ownKeys(value).some(key=>typeof key!=='string')||Object.keys(value).sort().join('\0')!==[...keys].sort().join('\0'))return fail(field,'V45_EDIT_FIELDS');
 return value as Record<string,unknown>;
};
const decimal=(value:unknown):value is string=>typeof value==='string'&&/^(0|[1-9][0-9]*)$/.test(value);
const hash=(value:unknown):value is string=>typeof value==='string'&&/^sha256:[a-f0-9]{64}$/.test(value);
const seedToken=(value:unknown):value is string=>typeof value==='string'&&/^-?(0|[1-9][0-9]*)$/.test(value);
const dimensions=(value:{width:number;height:number},field:string)=>{
 if(!value||typeof value!=='object'||!Number.isSafeInteger(value.width)||!Number.isSafeInteger(value.height)||value.width<1||value.height<1||!Number.isSafeInteger(value.width*value.height))return fail(field,'V45_EDIT_SIZE');
};
function blob(value:V45EditBlob,field:string){
 exact(value,['hash','byteLength','mediaType'],field);
 if(!hash(value.hash)||!decimal(value.byteLength)||typeof value.mediaType!=='string'||!value.mediaType)return fail(field,'V45_EDIT_FIELDS');
 // No endpoint source MIME allowlist or encoded byte limit has been confirmed.
}
function source(value:V45EditSource,field='source'){
 exact(value,['blob','pixels','manifest','pixelIdentity','width','height'],field);preparedRaster(value,field);
}
function preparedRaster(value:V45EditSource,field:string){
 dimensions(value,field);
 for(const key of ['blob','pixels','manifest'] as const)blob(value[key],field+'.'+key);
 if(value.width>8192||value.height>8192||value.width*value.height>25000000||!hash(value.pixelIdentity)||value.blob.mediaType!=='image/png'||value.pixels.mediaType!=='application/x-ideogram-rgba8'||value.pixels.byteLength!==String(value.width*value.height*4)||value.manifest.mediaType!=='application/json')return fail(field,'V45_EDIT_PREPARED_RASTER');
}
function prompt(value:unknown):asserts value is string{
 if(typeof value!=='string')return fail('prompt','V45_PROMPT_LENGTH');
 let count=0;
 for(const scalar of value){const code=scalar.codePointAt(0)!;if(code>=0xd800&&code<=0xdfff||++count>10000)return fail('prompt','V45_PROMPT_LENGTH');}
 if(count<1)return fail('prompt','V45_PROMPT_LENGTH');
}
function mask(value:V45EditMask,attached:V45EditSource){
 exact(value,['blob','pixels','manifest','pixelIdentity','width','height','polarity','editPixels','keepPixels','sourcePixels'],'mask');
 if(value.polarity!=='black-edit')return fail('mask','V45_EDIT_MASK_TRANSPORT');
 if(value.width!==attached.width||value.height!==attached.height)return fail('mask','V45_EDIT_MASK_ALIGNMENT');
 preparedRaster(value,'mask');blob(value.sourcePixels,'mask.sourcePixels');
 if(value.sourcePixels.hash!==attached.pixels.hash||value.sourcePixels.byteLength!==attached.pixels.byteLength||value.sourcePixels.mediaType!==attached.pixels.mediaType)return fail('mask','V45_EDIT_MASK_ALIGNMENT');
 if(!Number.isSafeInteger(value.editPixels)||!Number.isSafeInteger(value.keepPixels)||value.editPixels<=0||value.keepPixels<=0||value.editPixels+value.keepPixels!==value.width*value.height)return fail('mask','V45_EDIT_MASK_HOMOGENEOUS');
}
export function newV45EditFields(operation:V45EditOperation):V45EditFields{
 if(operation!=='transform-v45'&&operation!=='inpaint-v45')return fail('operation','V45_EDIT_OPERATION');
 return {precision:operation==='transform-v45'?'regular':'high',quality:'medium',count:'1',seed:'',size:'auto',width:'1024',height:'1024'};
}
/** Order is semantically retained; no sorting, deduplication or implicit canvas
 * attachments. Owned preparation proves each descriptor before review. */
export function validateV45EditReferences(value:V45EditSource[],masked:boolean):V45EditSource[]{
 if(!Array.isArray(value)||typeof masked!=='boolean')return fail('references','V45_EDIT_FIELDS');
 if(value.length>(masked?3:4))return fail('references','V45_EDIT_REFERENCE_COUNT');
 for(const item of value)source(item,'references');
 return structuredClone(value);
}
/** Explicit endpoint cross-field rules are stricter than shared ImageSize. */
export function v45EditDimensions(size:V45EditSize,precision:'regular'|'high',masked:boolean,attached:{width:number;height:number}):{width:number;height:number}{
 dimensions(attached,'source');
 if(!['regular','high'].includes(precision)||typeof masked!=='boolean')return fail('size','V45_EDIT_FIELDS');
 if(size==='auto')return {width:attached.width,height:attached.height};
 if(masked||precision==='high')return fail('size','V45_EDIT_AUTO_REQUIRED');
 if(typeof size==='string'){
  if(!(V45_EDIT_PRESETS as readonly string[]).includes(size))return fail('size','V45_EDIT_SIZE');
  const [width,height]=V45_EDIT_PRESET_DIMENSIONS[size as typeof V45_EDIT_PRESETS[number]];return {width,height};
 }
 exact(size,['width','height'],'size');
 const {width,height}=size;
 if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<256||height<256||width%32!==0||height%32!==0||width*height>4194304||Math.max(width,height)>6*Math.min(width,height))return fail('size','V45_EDIT_SIZE');
 return {width,height};
}
/** Invert an already reviewed, binary canonical coverage grid. This does not
 * choose a threshold for R16/soft masks or claim the provider's rounding rule.
 * Encoding/hash/owned plan proof and exterior restoration remain caller-owned. */
export function v45EditMaskTransport(attached:{width:number;height:number},coverage:V45EditBinaryCoverage):Uint8Array{
 dimensions(attached,'source');
 exact(coverage,['width','height','polarity','samples'],'mask');
 if(coverage.width!==attached.width||coverage.height!==attached.height)return fail('mask','V45_EDIT_MASK_ALIGNMENT');
 if(coverage.polarity!=='white-edit'||!(coverage.samples instanceof Uint8Array)||coverage.samples.length!==attached.width*attached.height)return fail('mask','V45_EDIT_MASK_BINARY');
 let edit=0,preserve=0;
 for(const sample of coverage.samples){if(sample===255)edit++;else if(sample===0)preserve++;else return fail('mask','V45_EDIT_MASK_BINARY');}
 if(!edit||!preserve)return fail('mask','V45_EDIT_MASK_HOMOGENEOUS');
 // Allocate only after validation; the caller's canonical mask stays untouched.
 const transport=new Uint8Array(coverage.samples.length);
 for(let i=0;i<transport.length;i++)transport[i]=255-coverage.samples[i]!;
 return transport;
}
export function resolveV45Edit(input:V45EditInput):V45EditRequest{
 exact(input,['operation','prompt','promptMode','fields','source','mask','references'],'request');
 if(input.operation!=='transform-v45'&&input.operation!=='inpaint-v45')return fail('operation','V45_EDIT_OPERATION');
 if(input.promptMode==='composition')return fail('prompt','V45_COMPOSITION_UNQUALIFIED');
 if(input.promptMode!=='plain'&&input.promptMode!=='raw')return fail('prompt','V45_PROMPT_MODE');
 prompt(input.prompt);source(input.source);
 const f=input.fields;exact(f,['precision','quality','count','seed','size','width','height'],'fields');
 if(!Object.values(f).every(value=>typeof value==='string'))return fail('fields','V45_EDIT_FIELDS');
 const masked=input.operation==='inpaint-v45',precision=masked?'high':'regular';
 if(f.precision!==precision)return fail('precision','V45_EDIT_OPERATION');
 // medium lies in both published prose ranges, enum and price table. Other
 // combinations remain gated while the very_high/very_low conflict persists.
 if(f.quality!=='medium')return fail('quality','V45_EDIT_QUALITY');
 if(!/^[1-4]$/.test(f.count))return fail('count','V45_APP_COUNT');
 if(f.seed!==''&&!seedToken(f.seed))return fail('seed','V45_SEED');
 if(masked){if(input.mask===null)return fail('mask','V45_EDIT_MASK_REQUIRED');mask(input.mask,input.source);}
 else if(input.mask!==null)return fail('mask','V45_EDIT_MASK_UNEXPECTED');
 const references=validateV45EditReferences(input.references,masked);
 let image_size:V45EditSize;
 if(f.size==='custom'){
  if(!decimal(f.width)||!decimal(f.height))return fail('size','V45_EDIT_SIZE');
  image_size={width:Number(f.width),height:Number(f.height)};
 }else image_size=f.size as V45EditSize;
 const requested=v45EditDimensions(image_size,precision,masked,input.source),count=Number(f.count) as V45EditBody['num_images'];
 const attached=structuredClone(input.source),reviewedMask=input.mask===null?null:structuredClone(input.mask);
 return {kind:input.operation,contract:V45_EDIT_CONTRACT,endpoint:V45_EDIT_ENDPOINT,schemaHash:V45_EDIT_SCHEMA,source:attached,mask:reviewedMask,references,requested,seed:f.seed===''?{kind:'provider-random'}:{kind:'integer',decimal:f.seed},
  body:{prompt:input.prompt,image_url:'asset:'+attached.blob.hash,...(reviewedMask?{mask_url:'asset:'+reviewedMask.blob.hash}:{}),...(references.length?{reference_image_urls:references.map(reference=>'asset:'+reference.blob.hash)}:{}),image_size,edit_precision:precision,quality:'medium',num_images:count,sync_mode:false},
  outputFormat:'provider-controlled',outputSafety:'unknown',candidateAdmission:'withheld',safetyAdmission:'blocked-unavailable-evidence',production:'blocked-unqualified-upload',
  estimate:{currency:'USD',cents:V45_EDIT_PRICE.mediumPerImageCents*count,rateDate:V45_EDIT_PRICE.date,rateSource:V45_EDIT_PRICE.source,rateSourceHash:V45_EDIT_PRICE.sourceHash,actualCharge:null}};
}
/** Canonical local template only. Approved endpoint-specific transport later
 * replaces frozen attachment placeholders; this function grants no dispatch. */
export function wireV45Edit(request:V45EditRequest):string{
 exact(request,['kind','contract','endpoint','schemaHash','source','mask','references','requested','seed','body','outputFormat','outputSafety','candidateAdmission','safetyAdmission','production','estimate'],'request');
 if(request.contract!==V45_EDIT_CONTRACT||request.endpoint!==V45_EDIT_ENDPOINT||request.schemaHash!==V45_EDIT_SCHEMA||request.outputFormat!=='provider-controlled'||request.outputSafety!=='unknown'||request.candidateAdmission!=='withheld'||request.safetyAdmission!=='blocked-unavailable-evidence'||request.production!=='blocked-unqualified-upload')return fail('request','V45_EDIT_CONTRACT');
 const b=request.body,masked=request.kind==='inpaint-v45';
 exact(b,['prompt','image_url','image_size','edit_precision','quality','num_images','sync_mode',...(masked?['mask_url']:[]),...(request.references?.length?['reference_image_urls']:[])],'body');
 if(b.sync_mode!==false||![1,2,3,4].includes(b.num_images))return fail('body','V45_EDIT_FIELDS');
 source(request.source);v45EditDimensions(b.image_size,b.edit_precision,masked,request.source);
 exact(request.seed,request.seed?.kind==='integer'?['kind','decimal']:['kind'],'seed');
 if(request.seed.kind!=='provider-random'&&(request.seed.kind!=='integer'||!seedToken(request.seed.decimal)))return fail('seed','V45_SEED');
 const resolved=resolveV45Edit({operation:request.kind,prompt:b.prompt,promptMode:'raw',source:request.source,mask:request.mask,references:request.references,
  fields:{precision:b.edit_precision,quality:b.quality,count:String(b.num_images),seed:request.seed.kind==='integer'?request.seed.decimal:'',size:typeof b.image_size==='string'?b.image_size:'custom',width:typeof b.image_size==='object'?String(b.image_size.width):'',height:typeof b.image_size==='object'?String(b.image_size.height):''}});
 if(b.image_url!==resolved.body.image_url||b.mask_url!==resolved.body.mask_url||JSON.stringify(b.reference_image_urls)!==JSON.stringify(resolved.body.reference_image_urls))return fail('body','V45_EDIT_ATTACHMENT');
 exact(request.requested,['width','height'],'requested');
 if(request.requested.width!==resolved.requested.width||request.requested.height!==resolved.requested.height)return fail('size','V45_EDIT_SIZE');
 exact(request.estimate,['currency','cents','rateDate','rateSource','rateSourceHash','actualCharge'],'estimate');
 for(const key of ['currency','cents','rateDate','rateSource','rateSourceHash','actualCharge'] as const)if(request.estimate[key]!==resolved.estimate[key])return fail('estimate','V45_EDIT_CONTRACT');
 const values=new Map(Object.entries(resolved.body).map(([key,value])=>[key,JSON.stringify(value)]));
 if(request.seed.kind==='integer')values.set('seed',request.seed.decimal);
 return '{'+[...values].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,value])=>JSON.stringify(key)+':'+value).join(',')+'}';
}
