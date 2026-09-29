import {canonical} from '../protocol/json.js';
import {SHA256} from '../protocol/sha256.js';
import {blob,keys,id,seq,requireValue as ok} from '../protocol/validate.js';
import type {BlobRef} from '../protocol/store.js';
import type {ProjectionReview,CompositionRef} from '../composition/core.js';
export const operations=['generate','instant','fast','transform','inpaint','generate-adapters','transform-adapters','inpaint-adapters'] as const;
export type Operation=typeof operations[number];
export const labels=['Generate image','Generate with Instant','Generate with Fast','Transform image','Edit masked region','Generate with adapters','Transform with adapters','Edit with adapters'];
export const presets=['square_hd','square','portrait_4_3','portrait_16_9','landscape_4_3','landscape_16_9'] as const;
export type Size={kind:'custom';width:number;height:number}|{kind:'preset';value:typeof presets[number]};
export type EditSize=Size|{kind:'auto'};
export type Seed={kind:'provider-random'}|{kind:'integer';decimal:string};
export type Source={assetId:string;version:string;blob:BlobRef;pixels:BlobRef;width:number;height:number;scope:'visible-document'|'asset';documentRevision:string};
export type Mask={assetId:string;version:string;blob:BlobRef;pixels:BlobRef;width:number;height:number;sourceHash:string;polarity:'white-edit';fullAcknowledged:boolean;empty:boolean;full:boolean;plan:BlobRef};
export type Adapter={version:string;hash:string;scale:string};
export type Prompt={mode:'plain'|'raw'|'composition';text:BlobRef;projection:ProjectionReview|null;composition:CompositionRef|null};
export type Conversion={from:{width:number;height:number};to:{width:number;height:number};mapping:'stretch';approved:boolean};
export type Fields={expansion:string;speed:string;acceleration:string;count:string;seed:string;format:string;size:string;width:string;height:string;strength:string};
export type Draft={schemaVersion:1;kind:'request-draft-1';operation:Operation;fields:Fields;prompt:Prompt;source:Source|null;mask:Mask|null;adapters:Adapter[];inactive:Partial<Record<'source'|'mask'|'adapters'|'speed'|'acceleration'|'strength',string>>;conversion:Conversion|null;guidanceAcknowledged:boolean;rewriteAcknowledged:boolean;destination:'retained-candidates';privacy:'minimum-retention-unqualified';textTreatment:'preserve-native';};
type Core={prompt:Prompt;syncMode:false;safetyChecker:true;seed:Seed;count:1|2|3|4;format:'png'|'jpeg';expansion:'None'|'Medium'|'Large'};
type Regular=Core&{speed:'TURBO'|'BALANCED'|'QUALITY';acceleration:'none'|'low'|'regular'|'high'};
export type Request=
 |{kind:'generate';settings:Regular;size:Size}
 |{kind:'instant';settings:Core&{expansion:'None'|'Medium'};size:Size}
 |{kind:'fast';settings:Core&{expansion:'None'|'Medium';speed:Regular['speed']};size:Size}
 |{kind:'transform';settings:Regular;size:EditSize;source:Source;strength:number}
 |{kind:'inpaint';settings:Regular;size:EditSize;source:Source;mask:Mask;strength:number}
 |{kind:'generate-adapters';settings:Regular;size:Size;adapters:Adapter[]}
 |{kind:'transform-adapters';settings:Regular;size:EditSize;source:Source;strength:number;adapters:Adapter[]}
 |{kind:'inpaint-adapters';settings:Regular;size:EditSize;source:Source;mask:Mask;strength:number;adapters:Adapter[]};
const schemas=['d83cf73ad6afecb49c2c1c094e8876674d0b844d0c1bda93b8ec804026653806','e8ddffdfef2072067915ae0a257c60439900e978468d7753bc0cf9176c525027','a6db6ca26a594018c8ad9315d46e09e30a42d18b2483a412502c1a1943e5c91e','44262f4376e55aead06f8b56cfbc8d8f32d240484b06c7c9164f6867184e9fa6','a04dd440c2ad322730020cd99b1abe07bd16115ab5db1563f44239dc8d27a149','c5c544d3883e7f3392139adac4c2a41cbeae7fd88a9d7762c4733238ba9848b6','391081e2e09dbf08d8f7db59e9349d23e4d444a8819f8f01213a7929b5e5e193','c7a156d6fa86482abf3add45c55dc6cc9b0e7ba58bb77982884cf9cf0e5b8bdb'];
const suffix=['','/instant','/fast','/image-to-image','/inpaint','/lora','/image-to-image/lora','/inpaint/lora'];
export const routes=Object.fromEntries(operations.map((op,i)=>[op,{endpoint:'ideogram/v4'+suffix[i],schemaHash:'sha256:'+schemas[i]}])) as Record<Operation,{endpoint:string;schemaHash:string}>;
export function hash(text:string){const h=new SHA256();h.update(new TextEncoder().encode(text));return h.digest();}
export type Issue={field:string;code:string;message:string};
export class RequestError extends Error{constructor(readonly issues:Issue[]){super(issues.map(i=>i.code+': '+i.message).join('; '));}}
export const emptyFields=():Fields=>({expansion:'Medium',speed:'BALANCED',acceleration:'none',count:'1',seed:'',format:'png',size:'custom',width:'1024',height:'1024',strength:''});
export function newDraft(text:BlobRef):Draft{return {schemaVersion:1,kind:'request-draft-1',operation:'generate',fields:emptyFields(),prompt:{mode:'plain',text,projection:null,composition:null},source:null,mask:null,adapters:[],inactive:{},conversion:null,guidanceAcknowledged:false,rewriteAcknowledged:false,destination:'retained-candidates',privacy:'minimum-retention-unqualified',textTreatment:'preserve-native'};}
export function draftShape(d:any):asserts d is Draft{
 keys(d,['schemaVersion','kind','operation','fields','prompt','source','mask','adapters','inactive','conversion','guidanceAcknowledged','rewriteAcknowledged','destination','privacy','textTreatment']);ok(d.schemaVersion===1&&d.kind==='request-draft-1'&&operations.includes(d.operation));keys(d.fields,Object.keys(emptyFields()));ok(Object.values(d.fields).every(v=>typeof v==='string'));
 keys(d.prompt,['mode','text','projection','composition']);ok(['plain','raw','composition'].includes(d.prompt.mode));blob(d.prompt.text);ok(d.prompt.text.mediaType==='text/plain'&&BigInt(d.prompt.text.byteLength)<=16777216n);
 if(d.prompt.mode!=='composition')ok(d.prompt.projection===null&&d.prompt.composition===null);
 if(d.prompt.projection!==null){const p=d.prompt.projection;keys(p,['serializer','sourceId','frame','request','dependencies','boxes','prompt']);ok(p.serializer==='caption-json-1');blob(p.prompt);}
 if(d.prompt.composition!==null){keys(d.prompt.composition,['id','value','bindings']);blob(d.prompt.composition.value);ok(id(d.prompt.composition.id));}
 if(d.source!==null){keys(d.source,['assetId','version','blob','pixels','width','height','scope','documentRevision']);ok(id(d.source.assetId)&&seq(d.source.version)&&seq(d.source.documentRevision)&&['visible-document','asset'].includes(d.source.scope));blob(d.source.blob);blob(d.source.pixels);ok([d.source.width,d.source.height].every(n=>Number.isSafeInteger(n)&&n>0));}
 if(d.mask!==null){keys(d.mask,['assetId','version','blob','pixels','width','height','sourceHash','polarity','fullAcknowledged','empty','full','plan']);ok(id(d.mask.assetId)&&seq(d.mask.version)&&d.mask.polarity==='white-edit'&&['fullAcknowledged','empty','full'].every(k=>typeof d.mask[k]==='boolean'));[d.mask.blob,d.mask.pixels,d.mask.plan].forEach(blob);ok([d.mask.width,d.mask.height].every(n=>Number.isSafeInteger(n)&&n>0));ok(/^sha256:[a-f0-9]{64}$/.test(d.mask.sourceHash));}
 ok(Array.isArray(d.adapters)&&d.adapters.length<=16);for(const a of d.adapters){keys(a,['version','hash','scale']);ok(id(a.version)&&/^sha256:[a-f0-9]{64}$/.test(a.hash)&&typeof a.scale==='string');}
 ok(d.inactive&&typeof d.inactive==='object'&&!Array.isArray(d.inactive)&&Object.entries(d.inactive).every(([k,v])=>['source','mask','adapters','speed','acceleration','strength'].includes(k)&&typeof v==='string'));
 if(d.conversion!==null){keys(d.conversion,['from','to','mapping','approved']);for(const v of [d.conversion.from,d.conversion.to]){keys(v,['width','height']);ok([v.width,v.height].every(Number.isSafeInteger));}ok(d.conversion.mapping==='stretch'&&typeof d.conversion.approved==='boolean');}
 ok(typeof d.guidanceAcknowledged==='boolean'&&typeof d.rewriteAcknowledged==='boolean'&&d.destination==='retained-candidates'&&d.privacy==='minimum-retention-unqualified'&&d.textTreatment==='preserve-native');
}
export function refs(d:Draft):BlobRef[]{return [d.prompt.text,...(d.prompt.composition?[d.prompt.composition.value]:[]),...(d.prompt.projection?[d.prompt.projection.prompt]:[]),...(d.source?[d.source.blob,d.source.pixels]:[]),...(d.mask?[d.mask.blob,d.mask.pixels,d.mask.plan]:[])];}
export function inactiveValue(d:Draft,k:keyof Draft['inactive']):unknown{return k in d.fields?d.fields[k as keyof Fields]:d[k as 'source'|'mask'|'adapters'];}
export function resolveInactive(d:Draft,k:keyof Draft['inactive']){d.inactive[k]=hash(canonical({operation:d.operation,value:inactiveValue(d,k)}));}
export function ignored(d:Draft,k:keyof Draft['inactive']){return d.inactive[k]===hash(canonical({operation:d.operation,value:inactiveValue(d,k)}));}
export type Eligibility={adapters:ReadonlyMap<string,{hash:string;available:boolean;profile:'v4-safe-1'}>};
export function resolve(d:Draft,prompt:string,eligible:Eligibility={adapters:new Map()}):Request{
 draftShape(d);const errors:Issue[]=[],bad=(field:string,code:string,message:string)=>errors.push({field,code,message});
 const op=d.operation,f=d.fields,edit=op.startsWith('transform')||op.startsWith('inpaint'),masked=op.startsWith('inpaint'),lora=op.endsWith('adapters'),regular=op!=='instant'&&op!=='fast';
 const inactive=(k:keyof Draft['inactive'],present:boolean)=>{if(present&&!ignored(d,k))bad(k,'INACTIVE_INPUT','Keep '+k+' in the saved draft explicitly, or choose a compatible operation.');};
 if(!edit)inactive('source',d.source!==null);if(!masked)inactive('mask',d.mask!==null);if(!lora)inactive('adapters',d.adapters.length>0);if(!regular)inactive('acceleration',f.acceleration!=='');if(op==='instant')inactive('speed',f.speed!=='');if(!edit)inactive('strength',f.strength!=='');
 if(!['None','Medium',...(regular?['Large']:[])].includes(f.expansion))bad('expansion','EXPANSION','Choose a supported expansion; no downgrade is automatic.');
 if(op!=='instant'&&!['TURBO','BALANCED','QUALITY'].includes(f.speed))bad('speed','SPEED','Choose TURBO, BALANCED or QUALITY.');
 if(regular&&!['none','low','regular','high'].includes(f.acceleration))bad('acceleration','ACCELERATION','Choose a supported acceleration.');
 if(!/^[1-4]$/.test(f.count))bad('count','COUNT','Output count must be an integer from 1 to 4.');
 if(!['png','jpeg'].includes(f.format))bad('format','FORMAT','Choose PNG or JPEG.');
 if(f.seed!==''&&!/^-?(0|[1-9][0-9]*)$/.test(f.seed))bad('seed','SEED','Enter an exact signed integer, or leave Random empty.');
 if(new TextEncoder().encode(prompt).length!==Number(d.prompt.text.byteLength)||hash(prompt)!==d.prompt.text.hash)bad('prompt','PROMPT_BYTES','The exact saved prompt bytes changed.');
 if(!prompt.trim())bad('prompt','EMPTY_PROMPT','Enter a nonempty prompt (editor policy).');
 if(d.prompt.mode==='raw'&&!d.guidanceAcknowledged)bad('prompt','OPAQUE_ACK','Acknowledge that exact raw text is not a validated caption profile.');
 if(d.prompt.mode==='plain'&&f.expansion==='None'&&!d.guidanceAcknowledged)bad('prompt','GUIDANCE_ACK','Acknowledge that the model guide recommends expansion for plain prompts.');
 if(d.prompt.mode!=='plain'&&f.expansion!=='None'&&!d.rewriteAcknowledged)bad('expansion','REWRITE_ACK','Acknowledge that expansion can rewrite lettering, layout and content.');
 if(d.prompt.mode==='composition'&&(!d.prompt.projection||!d.prompt.composition))bad('prompt','PROJECTION_REQUIRED','Approve the current Composition projection first.');
 let size:EditSize={kind:'auto'};
 if(f.size==='custom'){const width=Number(f.width),height=Number(f.height);size={kind:'custom',width,height};const max=op==='fast'||op==='instant'?2048:edit?8192:3840,min=edit?1:512;
  if(![f.width,f.height].every(v=>/^[1-9][0-9]*$/.test(v))||![width,height].every(Number.isSafeInteger)||width<min||height<min||width>max||height>max||width*height>25000000||!edit&&(width%16!==0||height%16!==0))bad('size','SIZE','Custom dimensions violate '+(edit?'the app 25MP / 8192-side envelope.':`metadata eligibility ${min}–${max}, multiples of 16. No rounding.`));
 }else if(presets.includes(f.size as typeof presets[number]))size={kind:'preset',value:f.size as typeof presets[number]};else if(f.size!=='auto'||!edit)bad('size','SIZE','This operation cannot use auto or an unknown preset.');
 if(edit){if(!d.source)bad('source','SOURCE_REQUIRED','Attach one exact source snapshot.');else if(![d.source.width,d.source.height].every(n=>Number.isSafeInteger(n)&&n>0&&n<=8192)||d.source.width*d.source.height>25000000)bad('source','SOURCE_SIZE','Source exceeds the app envelope.');
  if(!f.strength.trim()||!Number.isFinite(Number(f.strength))||Number(f.strength)<0||Number(f.strength)>1)bad('strength','STRENGTH','Strength must be between 0 and 1.');
  if(d.source&&size.kind==='custom'&&(size.width!==d.source.width||size.height!==d.source.height)){const c=d.conversion;if(!c?.approved||canonical(c.from)!==canonical({width:d.source.width,height:d.source.height})||canonical(c.to)!==canonical({width:size.width,height:size.height}))bad('size','CONVERSION_REQUIRED','Preview and confirm the exact request resize and mapping.');}
 }
 if(masked){if(!d.mask)bad('mask','MASK_REQUIRED','Attach a source-bound edit mask.');else {if(!d.source||d.mask.sourceHash!==d.source.pixels.hash||d.mask.width!==d.source.width||d.mask.height!==d.source.height)bad('mask','MASK_ALIGNMENT','The mask must match this exact source and frame.');if(d.mask.empty)bad('mask','EMPTY_MASK','Nothing is selected to edit.');if(d.mask.full&&!d.mask.fullAcknowledged)bad('mask','FULL_MASK','Confirm that the entire source can change.');}}
 if(lora){if(d.adapters.length<1||d.adapters.length>3)bad('adapters','ADAPTER_COUNT','Attach 1–3 eligible versions.');const seen=new Set<string>();for(const a of d.adapters){const e=eligible.adapters.get(a.version);if(seen.has(a.version))bad('adapters','DUPLICATE_ADAPTER','Duplicate adapter versions are not allowed.');seen.add(a.version);if(!e?.available||e.hash!==a.hash||e.profile!=='v4-safe-1')bad('adapters','ADAPTER_UNAVAILABLE','This adapter version has no approved local eligibility.');if(!a.scale.trim()||!Number.isFinite(Number(a.scale))||Number(a.scale)<0||Number(a.scale)>4)bad('adapters','SCALE','Each scale must be between 0 and 4.');}}
 if(errors.length)throw new RequestError(errors);
 const settings:any={prompt:structuredClone(d.prompt),syncMode:false,safetyChecker:true,seed:f.seed===''?{kind:'provider-random'}:{kind:'integer',decimal:f.seed},count:Number(f.count),format:f.format,expansion:f.expansion};if(op!=='instant')settings.speed=f.speed;if(regular)settings.acceleration=f.acceleration;
 return {kind:op,settings,size,...edit?{source:structuredClone(d.source!),strength:Number(f.strength)}:{},...masked?{mask:structuredClone(d.mask!)}:{},...lora?{adapters:structuredClone(d.adapters)}:{}} as Request;
}
// Endpoint-specific outer allowlists remain separate from the editable draft.
export function bodyTemplate(r:Request,prompt:string):string{
 const regular=r.kind!=='fast'&&r.kind!=='instant',edit='source'in r,mask='mask'in r,lora='adapters'in r;
 const input:Record<string,unknown>={prompt,expansion_model:r.settings.expansion,image_size:r.size.kind==='custom'?{width:r.size.width,height:r.size.height}:r.size.kind==='auto'?'auto':r.size.value};
 if(r.kind!=='instant')input.rendering_speed=(r.settings as Regular).speed;if(regular)input.acceleration=(r.settings as Regular).acceleration;
 input.num_images=r.settings.count;input.output_format=r.settings.format;input.sync_mode=r.settings.syncMode;input.enable_safety_checker=r.settings.safetyChecker;
 if(edit){input.image_url='asset:'+r.source.blob.hash;input.strength=r.strength;}if(mask)input.mask_url='asset:'+r.mask.blob.hash;if(lora)input.loras=r.adapters.map(a=>({path:'asset:'+a.hash,scale:Number(a.scale)}));
 // Seed is an integer JSON token, never an unsafe Number or a quoted string.
 const entries=Object.entries(input).map(([k,v])=>JSON.stringify(k)+':'+JSON.stringify(v));if(r.settings.seed.kind==='integer')entries.push('"seed":'+r.settings.seed.decimal);return '{'+entries.join(',')+'}';
}
export function estimate(r:Request){const i=r.kind==='instant'?0:['TURBO','BALANCED','QUALITY'].indexOf((r.settings as Regular).speed);const rate=r.kind.startsWith('inpaint')?(r.kind.endsWith('adapters')?0.015:0.01):r.kind==='instant'?0.0075:(r.kind==='fast'?[0.00525,0.0105,0.0175]:r.kind.endsWith('adapters')?[0.01125,0.0225,0.0375]:[0.0075,0.015,0.025])[i];return {source:'API-1.2 published guide 2026-09-25',endpoint:routes[r.kind].endpoint,currency:'USD',unit:r.kind.startsWith('inpaint')?'image':'megapixel',rate,count:r.settings.count,size:r.size,knownImageSubtotal:r.kind.startsWith('inpaint')?rate*r.settings.count:null,total:null,unknown:['billing-area rounding','expansion fees','batch/cancel charges'],actualSpend:null};}
