/** V45-A1 staged contract. No transport, persisted V4 reinterpretation or safety authority. */
export const V45_OPERATIONS=['generate-v45','transform-v45','inpaint-v45'] as const;
export const V45_GENERATION_QUALITIES=['low','medium','high'] as const;
export const V45_GENERATION_PRESETS=['square_hd','square','portrait_4_3','portrait_16_9','landscape_4_3','landscape_16_9'] as const;
export const V45_GENERATION_SIZES=[
 [1024,1024],[1024,3072],[1120,896],[1152,2944],[1152,864],[1248,3328],[1248,832],
 [1280,3072],[1280,720],[1280,800],[1296,3168],[1440,2560],[1440,2880],[1440,720],
 [1600,2560],[1664,2496],[1728,2304],[1792,2240],[2048,2048],[2240,1792],[2304,1728],
 [2496,1664],[2560,1440],[2560,1600],[2880,1440],[2944,1152],[3072,1024],[3072,1280],
 [3168,1296],[3328,1248],[720,1280],[720,1440],[800,1280],[832,1248],[864,1152],[896,1120]
] as const;
export const V45_GENERATION_PRESET_DIMENSIONS={square_hd:[1024,1024],square:[1024,1024],portrait_4_3:[864,1152],portrait_16_9:[720,1280],landscape_4_3:[1152,864],landscape_16_9:[1280,720]} as const;
export const V45_GENERATION_SCHEMA='sha256:ac31bdbfdf982da0b49bcaa94aedaaf4d95fa9fe9491ef473c120808843def29';
export const V45_GENERATION_CONTRACT='fal-ideogram-v45-generation-1' as const;
export const V45_GENERATION_PRICE={date:'2026-09-30',source:'https://fal.ai/models/ideogram/v4.5/llms.txt',sourceHash:'sha256:ed3973b02172a7cab5a7ad6dec97d6dc711ed7a884ada7082fa8bdaa9db2fb20',currency:'USD',perImageCents:{low:3,medium:6,high:22}} as const;
export type V45GenerateFields={quality:string;promptExpansion:string;count:string;seed:string;size:string;width:string;height:string};
export type V45Seed={kind:'provider-random'}|{kind:'integer';decimal:string};
export type V45Size={width:number;height:number}|typeof V45_GENERATION_PRESETS[number];
export type V45GenerateBody={prompt:string;image_size:V45Size;quality:typeof V45_GENERATION_QUALITIES[number];enable_prompt_expansion:boolean;num_images:1|2|3|4;sync_mode:false};
export type V45GenerateRequest={kind:'generate-v45';contract:typeof V45_GENERATION_CONTRACT;endpoint:'ideogram/v4.5';schemaHash:typeof V45_GENERATION_SCHEMA;promptMode:'plain'|'raw';requested:{width:number;height:number};seed:V45Seed;body:V45GenerateBody;outputFormat:'provider-controlled';safetyAdmission:'blocked-unavailable-evidence';estimate:{currency:'USD';cents:number;rateDate:'2026-09-30';rateSource:string;rateSourceHash:string;actualCharge:null}};
export class V45ContractError extends Error {readonly code:string;readonly field:string;constructor(field:string,code:string){super(code);this.name='V45ContractError';this.field=field;this.code=code;}}
const fail=(field:string,code:string):never=>{throw new V45ContractError(field,code);};
const exact=(v:unknown,expected:readonly string[],field:string):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join('\0')!==[...expected].sort().join('\0'))return fail(field,'V45_FIELDS');return v as Record<string,unknown>;};
export const newV45GenerateFields=():V45GenerateFields=>({quality:'medium',promptExpansion:'enabled',count:'1',seed:'',size:'square_hd',width:'1024',height:'1024'});
function promptValid(prompt:string){if(typeof prompt!=='string')return fail('prompt','V45_PROMPT_LENGTH');let count=0;for(const scalar of prompt){const code=scalar.codePointAt(0)!;if(code>=0xd800&&code<=0xdfff||++count>10000)return fail('prompt','V45_PROMPT_LENGTH');}if(count<1)return fail('prompt','V45_PROMPT_LENGTH');}
export function v45GenerationDimensions(size:V45Size):{width:number;height:number}{
 if(typeof size==='string'){if(!V45_GENERATION_PRESETS.includes(size))return fail('size','V45_SIZE');const [width,height]=V45_GENERATION_PRESET_DIMENSIONS[size];return {width,height};}
 exact(size,['width','height'],'size');if(!V45_GENERATION_SIZES.some(([w,h])=>w===size.width&&h===size.height))return fail('size','V45_SIZE');return {width:size.width,height:size.height};
}
export function resolveV45Generate(input:{operation:'generate-v45';prompt:string;promptMode:'plain'|'raw'|'composition';fields:V45GenerateFields}):V45GenerateRequest{
 exact(input,['operation','prompt','promptMode','fields'],'request');if(input.operation!=='generate-v45')return fail('operation','V45_OPERATION');
 if(input.promptMode==='composition')return fail('prompt','V45_COMPOSITION_UNQUALIFIED');if(!['plain','raw'].includes(input.promptMode))return fail('prompt','V45_PROMPT_MODE');promptValid(input.prompt);
 const f=input.fields;exact(f,['quality','promptExpansion','count','seed','size','width','height'],'fields');if(!Object.values(f).every(v=>typeof v==='string'))return fail('fields','V45_FIELDS');
 if(!(V45_GENERATION_QUALITIES as readonly string[]).includes(f.quality))return fail('quality','V45_QUALITY');if(!['enabled','disabled'].includes(f.promptExpansion))return fail('promptExpansion','V45_PROMPT_EXPANSION');
 if(!/^[1-4]$/.test(f.count))return fail('count','V45_APP_COUNT');if(f.seed!==''&&!/^-?(0|[1-9][0-9]*)$/.test(f.seed))return fail('seed','V45_SEED');
 let image_size:V45Size;
 if(f.size==='custom'){if(!/^[1-9][0-9]*$/.test(f.width)||!/^[1-9][0-9]*$/.test(f.height))return fail('size','V45_SIZE');image_size={width:Number(f.width),height:Number(f.height)};}
 else {if(!(V45_GENERATION_PRESETS as readonly string[]).includes(f.size))return fail('size','V45_SIZE');image_size=f.size as typeof V45_GENERATION_PRESETS[number];}
 const requested=v45GenerationDimensions(image_size),quality=f.quality as V45GenerateBody['quality'],count=Number(f.count) as V45GenerateBody['num_images'];
 return {kind:'generate-v45',contract:V45_GENERATION_CONTRACT,endpoint:'ideogram/v4.5',schemaHash:V45_GENERATION_SCHEMA,promptMode:input.promptMode,requested,seed:f.seed===''?{kind:'provider-random'}:{kind:'integer',decimal:f.seed},body:{prompt:input.prompt,image_size,quality,enable_prompt_expansion:f.promptExpansion==='enabled',num_images:count,sync_mode:false},outputFormat:'provider-controlled',safetyAdmission:'blocked-unavailable-evidence',estimate:{currency:'USD',cents:V45_GENERATION_PRICE.perImageCents[quality]*count,rateDate:V45_GENERATION_PRICE.date,rateSource:V45_GENERATION_PRICE.source,rateSourceHash:V45_GENERATION_PRICE.sourceHash,actualCharge:null}};
}
/** The seed remains an exact signed decimal token; JSON.stringify(number) would round it. */
export function wireV45Generate(r:V45GenerateRequest):string{
 exact(r,['kind','contract','endpoint','schemaHash','promptMode','requested','seed','body','outputFormat','safetyAdmission','estimate'],'request');
 if(r.kind!=='generate-v45'||r.contract!==V45_GENERATION_CONTRACT||r.endpoint!=='ideogram/v4.5'||r.schemaHash!==V45_GENERATION_SCHEMA||!['plain','raw'].includes(r.promptMode)||r.outputFormat!=='provider-controlled'||r.safetyAdmission!=='blocked-unavailable-evidence')return fail('request','V45_CONTRACT');
 exact(r.body,['prompt','image_size','quality','enable_prompt_expansion','num_images','sync_mode'],'body');promptValid(r.body.prompt);
 if(!V45_GENERATION_QUALITIES.includes(r.body.quality)||typeof r.body.enable_prompt_expansion!=='boolean'||![1,2,3,4].includes(r.body.num_images)||r.body.sync_mode!==false)return fail('body','V45_FIELDS');
 const dimensions=v45GenerationDimensions(r.body.image_size);exact(r.requested,['width','height'],'requested');if(dimensions.width!==r.requested.width||dimensions.height!==r.requested.height)return fail('size','V45_SIZE');
 if(!r.seed||typeof r.seed!=='object')return fail('seed','V45_SEED');exact(r.seed,r.seed.kind==='integer'?['kind','decimal']:['kind'],'seed');if(r.seed.kind!=='provider-random'&&(r.seed.kind!=='integer'||typeof r.seed.decimal!=='string'||!/^-?(0|[1-9][0-9]*)$/.test(r.seed.decimal)))return fail('seed','V45_SEED');
 exact(r.estimate,['currency','cents','rateDate','rateSource','rateSourceHash','actualCharge'],'estimate');
 if(r.estimate.currency!=='USD'||r.estimate.cents!==V45_GENERATION_PRICE.perImageCents[r.body.quality]*r.body.num_images||r.estimate.rateDate!==V45_GENERATION_PRICE.date||r.estimate.rateSource!==V45_GENERATION_PRICE.source||r.estimate.rateSourceHash!==V45_GENERATION_PRICE.sourceHash||r.estimate.actualCharge!==null)return fail('estimate','V45_ESTIMATE');
 const values=new Map(Object.entries(r.body).map(([key,value])=>[key,JSON.stringify(value)]));if(r.seed.kind==='integer')values.set('seed',r.seed.decimal);
 return '{'+[...values].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,value])=>JSON.stringify(key)+':'+value).join(',')+'}';
}
