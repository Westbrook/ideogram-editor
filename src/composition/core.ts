import type { BlobRef } from '../protocol/store.js';
import type { Affine } from '../raster/core.js';

export const PROFILE = 'ideogram-guide-990fe1c-app1' as const;
export const LIMITS = Object.freeze({bytes:262144,stringBytes:16384,elements:256,depth:16,tokens:50000});
export type Issue = {path:string;code:string;message:string};
export type Box = [number,number,number,number];
export type Geometry = {rect:Box;transform:Affine};
export type Binding<T> = {mode:'literal';value:T}|{mode:'layer';layerId:string;property:'text-content'|'appearance-description'|'frame-bounds';lastReviewedLayerVersion:string;lastReviewedValue:T};
export type Style = {kind:'photo'|'art';aesthetics:string;lighting:string;medium:string;photo:string;artStyle:string;palette:string[]|null};
export type Element = {id:string;type:'obj'|'text';desc:Binding<string>;text:Binding<string>;bounds:Binding<Geometry>|null;boundsPolicy:'inside'|'clip'|'omit';palette:string[]|null;excluded:boolean};
export type Frame = {revision:string;width:number|null;height:number|null;documentWidth:number;documentHeight:number;documentToRequest:Affine};
export type Composition = {schemaVersion:1;kind:'composition-version-1';id:string;profile:typeof PROFILE;scene:string;background:string;style:Style|null;inactiveStyle:Style;elements:Element[];frame:Frame;raw:BlobRef[];request:{operation:string;expansion:'None'|'Medium'|'Large';rewriteAcknowledged:boolean};review:ProjectionReview|null};
export type CompositionRef = {id:string;value:BlobRef;bindings:Record<string,string>};
export type LayerValue = {id:string;version:string;kind:'image'|'text';text?:string;appearance:string;bounds:Geometry};
export type ProjectedBox = {corners:[number,number][];unclipped:Box;clipped:Box;normalized:Box;quantized:Box;approximation:boolean;policy:Element['boundsPolicy']};
export type ProjectionReview = {serializer:'caption-json-1';sourceId:string;frame:Frame;request:Composition['request'];dependencies:{elementId:string;field:string;layerId:string;version:string}[];boxes:{elementId:string;projection:ProjectedBox|null}[];prompt:BlobRef};
export type Caption = {high_level_description:string;style_description?:Record<string,unknown>;compositional_deconstruction:{background:string;elements:Record<string,unknown>[]}};
export type ParseResult = {state:'supported'|'ambiguous'|'unsupported'|'malformed'|'over-limit';issues:Issue[];value?:Caption};
export class CompositionError extends Error {constructor(readonly issues:Issue[]){super(issues.map(x=>x.code+': '+x.path).join('; '));}}
const fail=(path:string,code:string,message=code):never=>{throw new CompositionError([{path,code,message}]);};
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
// Count UTF-8 bytes without allocating an encoded copy. TextEncoder replaces
// each unpaired surrogate with U+FFFD (three bytes); authored text rejects it.
function utf8ByteLength(s:string,rejectUnpaired=false):number {
 let total=0;
 for(let i=0;i<s.length;i++){
  const code=s.charCodeAt(i);
  if(code<0x80){total++;continue;}
  if(code<0x800){total+=2;continue;}
  if(code>=0xd800&&code<=0xdfff){
   const next=s.charCodeAt(i+1);
   if(code<=0xdbff&&next>=0xdc00&&next<=0xdfff){total+=4;i++;continue;}
   if(rejectUnpaired)return -1;
  }
  total+=3;
 }
 return total;
}
export const bytes=(s:string)=>utf8ByteLength(s);
export function validString(v:unknown){if(typeof v!=='string')return false;const length=utf8ByteLength(v,true);return length>=0&&length<=LIMITS.stringBytes;}

// Exact UTF-8 length of JSON.stringify(s), including quotes, short control
// escapes, and well-formed JSON's six-byte escapes for unpaired surrogates.
function quotedStringBytes(s:string):number {
 let total=2;
 for(let i=0;i<s.length;i++){
  const code=s.charCodeAt(i);
  if(code===0x22||code===0x5c){total+=2;continue;}
  if(code<0x20){total+=code===8||code===9||code===10||code===12||code===13?2:6;continue;}
  if(code<0x80){total++;continue;}
  if(code<0x800){total+=2;continue;}
  if(code>=0xd800&&code<=0xdfff){
   const next=s.charCodeAt(i+1);
   if(code<=0xdbff&&next>=0xdc00&&next<=0xdfff){total+=4;i++;continue;}
   total+=6;continue;
  }
  total+=3;
 }
 return total;
}

// Pair-preserving, bounded scanner. Never recursively decode a JSON string and
// never materialize over-limit input as a tree. Original bytes live elsewhere.
export function parseCaption(raw:Uint8Array):ParseResult {
 let source:string;
 if(raw.length>LIMITS.bytes)return {state:'over-limit',issues:[{path:'$',code:'BYTE_LIMIT',message:'Raw retained. Parsing is limited to 256 KiB.'}]};
 try{source=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw);}catch{return {state:'malformed',issues:[{path:'$',code:'INVALID_UTF8',message:'The original bytes are not valid UTF-8.'}]};}
 let at=0,tokens=0;
 const token=()=>{if(++tokens>LIMITS.tokens)fail('$','TOKEN_LIMIT');};
 const ws=()=>{while(at<source.length&&/[\x20\t\r\n]/.test(source[at]))at++;};
 const punctuation=(s:string)=>{if(source[at++]!==s)fail('$','MALFORMED_JSON');token();ws();};
 function string(path:string){const start=at++;while(at<source.length){if(source[at]==='\\'){at+=2;continue;}if(source[at++]==='"'){let v:string;try{v=JSON.parse(source.slice(start,at));}catch{return fail(path,'MALFORMED_JSON');}token();if(!validString(v))fail(path,bytes(v)>LIMITS.stringBytes?'STRING_LIMIT':'INVALID_UNICODE');ws();return v;}}return fail(path,'MALFORMED_JSON');}
 function value(path:string,depth:number):unknown {
  ws();const c=source[at];
  if(c==='"')return string(path);
  if(c==='{'||c==='['){if(depth+1>LIMITS.depth)fail(path,'DEPTH_LIMIT');const obj=c==='{',out:any=obj?Object.create(null):[],seen=new Set<string>();punctuation(c);const end=obj?'}':']';if(source[at]===end){punctuation(end);return out;}let i=0;
   for(;;){let key=String(i++);if(obj){if(source[at]!=='"')fail(path,'MALFORMED_JSON');key=string(path);if(seen.has(key))fail(path+'.'+key,'DUPLICATE_KEY','Duplicate decoded key. The original is ambiguous and remains opaque.');seen.add(key);punctuation(':');}const p=obj?path+'.'+key:path+'['+key+']';out[key]=value(p,depth+1);ws();if(source[at]===end){punctuation(end);return out;}punctuation(',');}
  }
  const match=/^(true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(source.slice(at));if(!match)fail(path,'MALFORMED_JSON');at+=match![0].length;token();ws();const v=JSON.parse(match![0]);if(typeof v==='number'&&!Number.isFinite(v))fail(path,'NONFINITE_NUMBER');return v;
 }
 try{const parsed=value('$',0);ws();if(at!==source.length)fail('$','MALFORMED_JSON');if(!object(parsed))fail('$',typeof parsed==='string'?'ENCODED_STRING_ROOT':'UNSUPPORTED_ROOT','A caption must be one object; no second parse is performed.');const issues=validateCaption(parsed);return issues.length?{state:'unsupported',issues}:{state:'supported',issues:[],value:parsed as Caption};}
 catch(error){if(!(error instanceof CompositionError))throw error;const code=error.issues[0].code;return {state:code.endsWith('_LIMIT')?'over-limit':code==='DUPLICATE_KEY'?'ambiguous':['ENCODED_STRING_ROOT','UNSUPPORTED_ROOT'].includes(code)?'unsupported':'malformed',issues:error.issues};}
}

export function validateCaption(v:unknown):Issue[] {
 const issues:Issue[]=[];
 const issue=(path:string,code:string,message=code)=>{if(issues.length<256)issues.push({path,code,message});};
 const shape=(o:any,path:string,allowed:string[],required:string[])=>{if(!object(o)){issue(path,'OBJECT_REQUIRED');return false;}for(const k of Object.keys(o))if(!allowed.includes(k))issue(path+'.'+k,'UNKNOWN_FIELD');for(const k of required)if(!Object.hasOwn(o,k))issue(path+'.'+k,k==='high_level_description'?'MISSING_SCENE':'MISSING_FIELD');const known=Object.keys(o).filter(k=>allowed.includes(k));if(!same(known,allowed.filter(k=>Object.hasOwn(o,k))))issue(path,'KEY_ORDER');return true;};
 const str=(o:any,k:string,path:string)=>{if(Object.hasOwn(o,k)&&!validString(o[k]))issue(path+'.'+k,typeof o[k]==='string'?'STRING_LIMIT':'STRING_REQUIRED');};
 const palette=(o:any,path:string,max:number)=>{if(!Object.hasOwn(o,'color_palette'))return;const p=o.color_palette;if(!Array.isArray(p)||p.length>max||p.some(x=>typeof x!=='string'||!/^#[0-9A-F]{6}$/.test(x)))issue(path+'.color_palette','PALETTE_FORMAT',`Use at most ${max} uppercase opaque #RRGGBB colors.`);};
 if(!shape(v,'$',['high_level_description','style_description','compositional_deconstruction'],['high_level_description','compositional_deconstruction']))return issues;
 const c=v as Record<string,any>;str(c,'high_level_description','$');
 if(Object.hasOwn(c,'style_description')){const s=c.style_description,p='$.style_description',photo=object(s)&&Object.hasOwn(s,'photo'),art=object(s)&&Object.hasOwn(s,'art_style');if(photo===art)issue(p,'STYLE_UNION','Choose exactly one of photo or art_style.');const order=photo?['aesthetics','lighting','photo','medium','color_palette']:['aesthetics','lighting','medium','art_style','color_palette'];if(shape(s,p,order,order.filter(k=>k!=='color_palette'))){for(const k of order.filter(k=>k!=='color_palette'))str(s,k,p);palette(s,p,16);}}
 const d=c.compositional_deconstruction,p='$.compositional_deconstruction';if(shape(d,p,['background','elements'],['background','elements'])){str(d,'background',p);if(!Array.isArray(d.elements))issue(p+'.elements','ARRAY_REQUIRED');else if(d.elements.length>LIMITS.elements)issue(p+'.elements','ELEMENT_LIMIT');else d.elements.forEach((e:any,i:number)=>{const ep=p+`.elements[${i}]`,order=e?.type==='text'?['type','bbox','text','desc','color_palette']:['type','bbox','desc','color_palette'];if(!shape(e,ep,order,order.filter(k=>!['bbox','color_palette'].includes(k))))return;if(!['obj','text'].includes(e.type))issue(ep+'.type','ELEMENT_TYPE');str(e,'desc',ep);if(e.type==='text')str(e,'text',ep);palette(e,ep,5);if(Object.hasOwn(e,'bbox')){const b=e.bbox;if(!Array.isArray(b)||b.length!==4||b.some(x=>typeof x!=='number'||!Number.isInteger(x)||x<0||x>1000))issue(ep+'.bbox','BBOX_FORMAT');else if(b[0]>=b[2]||b[1]>=b[3])issue(ep+'.bbox','BBOX_AREA');}});}
 return issues;
}

export function projectBounds(g:Geometry,frame:Frame,policy:Element['boundsPolicy']):ProjectedBox|null {
 if(policy==='omit')return null;
 if(frame.width===null||frame.height===null)fail('frame','UNRESOLVED_AUTO','Choose explicit request dimensions or explicitly omit bounds.');
 const [x,y,w,h]=g.rect;if(![x,y,w,h,...g.transform,...frame.documentToRequest].every(Number.isFinite)||w<=0||h<=0||frame.width!<=0||frame.height!<=0)fail('bounds','INVALID_GEOMETRY');
 const map=(p:[number,number],m:Affine):[number,number]=>[m[0]*p[0]+m[2]*p[1]+m[4],m[1]*p[0]+m[3]*p[1]+m[5]];
 const corners=([[x,y],[x+w,y],[x+w,y+h],[x,y+h]] as [number,number][]).map(p=>map(map(p,g.transform),frame.documentToRequest));
 const xs=corners.map(p=>p[0]),ys=corners.map(p=>p[1]),unclipped:Box=[Math.min(...ys),Math.min(...xs),Math.max(...ys),Math.max(...xs)];
 if(unclipped.some(n=>!Number.isFinite(n)))fail('bounds','INVALID_GEOMETRY');
 const outside=unclipped[0]<0||unclipped[1]<0||unclipped[2]>frame.height!||unclipped[3]>frame.width!;
 if(outside&&policy!=='clip')fail('bounds','OUT_OF_FRAME','Review clipping, move the box, or omit bounds.');
 const clipped:Box=policy==='clip'?[Math.max(0,unclipped[0]),Math.max(0,unclipped[1]),Math.min(frame.height!,unclipped[2]),Math.min(frame.width!,unclipped[3])]:[...unclipped];
 const normalized:Box=[clipped[0]/frame.height!*1000,clipped[1]/frame.width!*1000,clipped[2]/frame.height!*1000,clipped[3]/frame.width!*1000];
 const quantized=normalized.map(n=>Math.floor(n+0.5)) as Box;
 if(quantized.some(n=>n<0||n>1000)||quantized[0]>=quantized[2]||quantized[1]>=quantized[3])fail('bounds','COLLAPSED_BBOX','The projected box collapses after rounding. Enlarge it or omit bounds.');
 const m=g.transform,r=frame.documentToRequest,offDiagonal=[r[0]*m[2]+r[2]*m[3],r[1]*m[0]+r[3]*m[1]];
 return {corners,unclipped,clipped,normalized,quantized,approximation:offDiagonal.some(x=>x!==0),policy};
}
export function bindingValue<T>(b:Binding<T>):T{return b.mode==='literal'?b.value:b.lastReviewedValue;}
export function bindingIds(c:Composition){return [...new Set(c.elements.flatMap(e=>[e.desc,e.text,e.bounds].flatMap(b=>b?.mode==='layer'?[b.layerId]:[])))];}
export function bindingMap(c:Composition,map:Record<string,string>){const ids=bindingIds(c);if(!object(map)||Object.keys(map).length!==ids.length||ids.some(k=>!identifier(k)||!identifier(map[k])))fail('bindings','BINDING_MAP');return map;}
export function fieldStatus(b:Binding<unknown>,layers:LayerValue[],map:Record<string,string>):'literal'|'reviewed'|'stale'|'missing'{if(b.mode==='literal')return 'literal';const l=layers.find(l=>l.id===map[b.layerId]);return !l?'missing':l.version!==b.lastReviewedLayerVersion?'stale':'reviewed';}
export function linkField<T>(property:'text-content'|'appearance-description'|'frame-bounds',layer:LayerValue):Binding<T>{if(property==='text-content'&&layer.kind!=='text')fail('link','TEXT_LAYER_REQUIRED');return {mode:'layer',property,layerId:layer.id,lastReviewedLayerVersion:layer.version,lastReviewedValue:structuredClone(property==='text-content'?layer.text:property==='frame-bounds'?layer.bounds:layer.appearance) as T};}
export function detach<T>(b:Binding<T>):Binding<T>{return {mode:'literal',value:structuredClone(bindingValue(b))};}
export function validateRequestDraft(c:Composition){if(c.request.expansion==='Large'&&/Fast|Instant/.test(c.request.operation))fail('request','EXPANSION_ROUTE_CONFLICT','Large is unavailable for Fast and Instant. The draft is retained; choose None or Medium explicitly.');if(c.request.expansion!=='None'&&!c.request.rewriteAcknowledged)fail('request','REWRITE_ACK_REQUIRED','Acknowledge that expansion may rewrite structure or placement.');}
export function serialize(c:Composition,layers:LayerValue[],map:Record<string,string>,allowStale=false){
 validateRequestDraft(c);
 const issues:Issue[]=[],dependencies:ProjectionReview['dependencies']=[],boxes:ProjectionReview['boxes']=[];
 const resolve=<T>(b:Binding<T>,e:Element,field:string):T=>{const status=fieldStatus(b,layers,map);if(!allowStale&&['stale','missing'].includes(status))issues.push({path:`elements.${e.id}.${field}`,code:status.toUpperCase()+'_LINK',message:'Review the source, relink, detach the last reviewed value, or exclude this element.'});if(b.mode==='layer')dependencies.push({elementId:e.id,field,layerId:b.layerId,version:b.lastReviewedLayerVersion});return bindingValue(b);};
 const elements=c.elements.filter(e=>!e.excluded).map(e=>{const o:Record<string,unknown>={type:e.type};let p:ProjectedBox|null=null;if(e.bounds){try{p=projectBounds(resolve(e.bounds,e,'bounds'),c.frame,e.boundsPolicy);if(p)o.bbox=p.quantized;}catch(error){if(!(error instanceof CompositionError))throw error;issues.push(...error.issues.map(i=>({...i,path:`elements.${e.id}.bounds` })));}}boxes.push({elementId:e.id,projection:p});if(e.type==='text')o.text=resolve(e.text,e,'text');o.desc=resolve(e.desc,e,'desc');if(e.palette!==null)o.color_palette=e.palette;return o;});
 const caption={high_level_description:c.scene} as Caption;
 if(c.style){const s=c.style;caption.style_description=s.kind==='photo'?{aesthetics:s.aesthetics,lighting:s.lighting,photo:s.photo,medium:s.medium}:{aesthetics:s.aesthetics,lighting:s.lighting,medium:s.medium,art_style:s.artStyle};if(s.palette!==null)caption.style_description.color_palette=s.palette;}
 caption.compositional_deconstruction={background:c.background,elements};issues.push(...validateCaption(caption));
 const prompt=JSON.stringify(caption);if(bytes(prompt)>LIMITS.bytes)issues.push({path:'$',code:'BYTE_LIMIT',message:'The authored caption exceeds 256 KiB; the draft is retained.'});if(issues.length)throw new CompositionError(issues);
 return {caption,prompt,dependencies,boxes,wirePromptBytes:quotedStringBytes(prompt)};
}

const identifier=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const sequence=(v:unknown)=>typeof v==='string'&&/^(0|[1-9][0-9]*)$/.test(v);
const exact=(v:any,keys:string[],path:string)=>{if(!object(v)||!same(Object.keys(v).sort(),keys.sort()))fail(path,'UNKNOWN_OR_MISSING_FIELD');};
const ref=(v:any)=>{exact(v,['hash','byteLength','mediaType'],'ref');if(!/^sha256:[a-f0-9]{64}$/.test(v.hash)||!sequence(v.byteLength)||typeof v.mediaType!=='string')fail('ref','INVALID_REF');};
const geometry=(v:any)=>{exact(v,['rect','transform'],'bounds');if(!Array.isArray(v.rect)||v.rect.length!==4||!Array.isArray(v.transform)||v.transform.length!==6||![...v.rect,...v.transform].every(Number.isFinite)||v.rect[2]<=0||v.rect[3]<=0||v.transform[0]*v.transform[3]-v.transform[1]*v.transform[2]===0)fail('bounds','INVALID_GEOMETRY');};
export function validateComposition(c:any):asserts c is Composition {
 exact(c,['schemaVersion','kind','id','profile','scene','background','style','inactiveStyle','elements','frame','raw','request','review'],'composition');
 if(c.schemaVersion!==1||c.kind!=='composition-version-1'||c.profile!==PROFILE||!identifier(c.id))fail('composition','UNSUPPORTED_COMPOSITION_VERSION');
 for(const k of ['scene','background'])if(!validString(c[k]))fail(k,'STRING_LIMIT');
 const style=(s:any)=>{exact(s,['kind','aesthetics','lighting','medium','photo','artStyle','palette'],'style');if(!['photo','art'].includes(s.kind)||!['aesthetics','lighting','medium','photo','artStyle'].every(k=>validString(s[k])))fail('style','INVALID_STYLE');pal(s.palette,16);};
 const pal=(p:any,n:number)=>{if(p!==null&&(!Array.isArray(p)||p.length>n||p.some(v=>typeof v!=='string'||!/^#[0-9A-F]{6}$/.test(v))))fail('palette','PALETTE_FORMAT');};
 if(c.style!==null)style(c.style);style(c.inactiveStyle);
 if(!Array.isArray(c.elements)||c.elements.length>256)fail('elements','ELEMENT_LIMIT');const ids=new Set();
 for(const e of c.elements){exact(e,['id','type','desc','text','bounds','boundsPolicy','palette','excluded'],'element');if(!identifier(e.id)||ids.has(e.id)||!['obj','text'].includes(e.type)||!['inside','clip','omit'].includes(e.boundsPolicy)||typeof e.excluded!=='boolean')fail('element','INVALID_ELEMENT');ids.add(e.id);pal(e.palette,5);
  for(const [k,b]of [['desc',e.desc],['text',e.text],['bounds',e.bounds]] as const){if(k==='bounds'&&b===null)continue;try{if(b?.mode==='literal'){exact(b,['mode','value'],k);}else{exact(b,['mode','layerId','property','lastReviewedLayerVersion','lastReviewedValue'],k);if(b.mode!=='layer'||!identifier(b.layerId)||!sequence(b.lastReviewedLayerVersion)||b.property!==(k==='text'?'text-content':k==='desc'?'appearance-description':'frame-bounds'))fail(k,'BINDING_TYPE');}const v=bindingValue(b);if(k==='bounds')geometry(v);else if(!validString(v))fail(k,'STRING_LIMIT');}catch(error){if(!(error instanceof CompositionError))throw error;throw new CompositionError(error.issues.map(i=>({...i,path:`elements.${e.id}.${k}`})));}}
 }
 exact(c.frame,['revision','width','height','documentWidth','documentHeight','documentToRequest'],'frame');const f=c.frame;if(!identifier(f.revision)||!Array.isArray(f.documentToRequest)||f.documentToRequest.length!==6||!f.documentToRequest.every(Number.isFinite)||f.documentToRequest[0]*f.documentToRequest[3]-f.documentToRequest[1]*f.documentToRequest[2]===0||!Number.isSafeInteger(f.documentWidth)||!Number.isSafeInteger(f.documentHeight)||f.documentWidth<=0||f.documentHeight<=0||(f.width===null)!==(f.height===null)||f.width!==null&&(!Number.isSafeInteger(f.width)||!Number.isSafeInteger(f.height)||f.width<=0||f.height<=0||f.width>8192||f.height>8192||f.width*f.height>25000000))fail('frame','INVALID_FRAME');
 if(!Array.isArray(c.raw)||c.raw.length>256)fail('raw','RAW_COUNT');c.raw.forEach(ref);
 exact(c.request,['operation','expansion','rewriteAcknowledged'],'request');if(!validString(c.request.operation)||!['None','Medium','Large'].includes(c.request.expansion)||typeof c.request.rewriteAcknowledged!=='boolean')fail('request','INVALID_REQUEST_DRAFT');
 if(c.review!==null){exact(c.review,['serializer','sourceId','frame','request','dependencies','boxes','prompt'],'review');if(c.review.serializer!=='caption-json-1'||c.review.sourceId!==c.id||!same(c.review.frame,c.frame)||!same(c.review.request,c.request)||!Array.isArray(c.review.dependencies)||!Array.isArray(c.review.boxes))fail('review','INVALID_REVIEW');ref(c.review.prompt);}
 if(bytes(JSON.stringify(c))>1048576)fail('composition','COMPOSITION_WORKSPACE_LIMIT');
}
export function validateCompositionRef(v:any){exact(v,['id','value','bindings'],'compositionRef');if(!identifier(v.id))fail('compositionRef','INVALID_ID');ref(v.value);if(v.value.mediaType!=='application/json'||BigInt(v.value.byteLength)>1048576n||!object(v.bindings)||Object.keys(v.bindings).length>768||Object.entries(v.bindings).some(([k,x])=>!identifier(k)||!identifier(x)))fail('compositionRef','INVALID_REF');}
export function compositionRefs(c:Composition):BlobRef[]{return [...c.raw,...(c.review?[c.review.prompt]:[])];}
export const emptyStyle=():Style=>({kind:'photo',aesthetics:'',lighting:'',medium:'',photo:'',artStyle:'',palette:null});
export function emptyComposition(width:number,height:number,id:string):Composition{return {schemaVersion:1,kind:'composition-version-1',id,profile:PROFILE,scene:'',background:'',style:null,inactiveStyle:emptyStyle(),elements:[],frame:{revision:id,width,height,documentWidth:width,documentHeight:height,documentToRequest:[1,0,0,1,0,0]},raw:[],request:{operation:'Generate image',expansion:'None',rewriteAcknowledged:false},review:null};}
export function emptyElement(type:Element['type'],id:string):Element{return {id,type,desc:{mode:'literal',value:''},text:{mode:'literal',value:''},bounds:null,boundsPolicy:'inside',palette:null,excluded:false};}
export function inverseAffine(m:Affine):Affine {const [a,b,c,d,x,y]=m,det=a*d-b*c;return [d/det,-b/det,-c/det,a/det,(c*y-d*x)/det,(b*x-a*y)/det];}
export function fromCaption(v:Caption,frame:Frame,id:string,newId:()=>string):Composition {const c=emptyComposition(frame.documentWidth,frame.documentHeight,id);c.frame=structuredClone(frame);c.scene=v.high_level_description;c.background=v.compositional_deconstruction.background;if(v.style_description){const s=v.style_description;c.style={...emptyStyle(),kind:'photo'in s?'photo':'art',aesthetics:s.aesthetics as string,lighting:s.lighting as string,medium:s.medium as string,photo:(s.photo??'') as string,artStyle:(s.art_style??'') as string,palette:(s.color_palette??null) as string[]|null};c.inactiveStyle=structuredClone(c.style);}c.elements=v.compositional_deconstruction.elements.map(e=>{const out=emptyElement(e.type as Element['type'],newId());out.desc={mode:'literal',value:e.desc as string};if(e.type==='text')out.text={mode:'literal',value:e.text as string};out.palette=(e.color_palette??null) as string[]|null;if(e.bbox){if(frame.width===null||frame.height===null)fail('frame','UNRESOLVED_AUTO');const b=e.bbox as Box;out.bounds={mode:'literal',value:{rect:[b[1]/1000*frame.width!,b[0]/1000*frame.height!,(b[3]-b[1])/1000*frame.width!,(b[2]-b[0])/1000*frame.height!],transform:inverseAffine(frame.documentToRequest)}};}return out;});return c;}
