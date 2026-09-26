import type { BlobRef } from './store.js';
import type { DraftFence } from './history.js';
export type TextStyle={primaryFont:string;explicitFallbacks:readonly string[];sizePx:number;lineHeightMultiplier:number;fill:readonly [number,number,number,number];align:'left'|'center'|'right'|'start'|'end';direction:'auto'|'ltr'|'rtl'};
export type TextToken={documentId:string;documentRevision:string;layerId:string;layerVersion:string;sessionId:string;generation:number};
import { blob, id, keys, seq, requireValue as ok } from './validate.js';

export type FontVersion = { schemaVersion:1; id:string; bytes:BlobRef; faceIndex:0; format:'static-ttf'|'static-otf'; parserProfile:string; fsType:number; licenseRecord:BlobRef; origin:'bundled'|'local-file'; embedding:'permitted' };
export type RendererProfile = { schemaVersion:1; id:string; manifest:BlobRef };
export type TextVersion = { schemaVersion:1; id:string; textUtf8:BlobRef; style:TextStyle; frame:{width:number;height:number}; layoutPolicy:'text-layout-1'; fonts:FontVersion[] };
export type TextRenderVersion = { schemaVersion:1; id:string; textVersion:string; rendererProfile:RendererProfile; dependencyHash:string; layout:BlobRef; pixels:BlobRef; width:number;height:number;overflow:boolean;resolvedFonts:string[] };
export type TextSource = { schemaVersion:1; text:TextVersion; render:TextRenderVersion };
export type TextCandidate = { schemaVersion:1; token:TextToken; source:TextSource };
export type TextBody =
 | {type:'ImportFont'; source:BlobRef; license:BlobRef; origin:'bundled'|'local-file'; embeddingReviewed:true}
 | {type:'CreateTextLayer';layerId:string;name:string;candidate:BlobRef;draft:DraftFence;admissionId:string}
 | {type:'CommitTextEdit'|'ReplaceTextFont';layerId:string;layerVersion:string;candidate:BlobRef;draft:DraftFence;admissionId:string;reviewedDependencyHash:string}
 | {type:'RasterizeTextDerivative';layerId:string;layerVersion:string;newLayerId:string;name:string;hideOriginal:boolean;reviewedRender:string;draft:DraftFence|null};
export const textCommands=['ImportFont','CreateTextLayer','CommitTextEdit','ReplaceTextFont','RasterizeTextDerivative'] as const;
export const isTextCommand=(type:string)=>(textCommands as readonly string[]).includes(type);
export const hash=(v:unknown):v is string=>typeof v==='string'&&/^sha256:[a-f0-9]{64}$/.test(v);
export function textBody(b:any){
 const fields:Record<string,string[]>={ImportFont:['source','license','origin','embeddingReviewed'],CreateTextLayer:['layerId','name','candidate','draft','admissionId'],CommitTextEdit:['layerId','layerVersion','candidate','draft','admissionId','reviewedDependencyHash'],ReplaceTextFont:['layerId','layerVersion','candidate','draft','admissionId','reviewedDependencyHash'],RasterizeTextDerivative:['layerId','layerVersion','newLayerId','name','hideOriginal','reviewedRender','draft']};
 keys(b,['type',...fields[b.type]]);
 if(b.type==='ImportFont'){blob(b.source);blob(b.license);ok(['bundled','local-file'].includes(b.origin)&&b.embeddingReviewed===true);return;}
 ok(id(b.layerId));if('layerVersion'in b)ok(seq(b.layerVersion));if('name'in b)ok(typeof b.name==='string'&&b.name.length>0&&new TextEncoder().encode(b.name).length<=1024);
 if('candidate'in b){blob(b.candidate);ok(b.candidate.mediaType==='application/json'&&BigInt(b.candidate.byteLength)<=65536n&&id(b.admissionId));}
 if('reviewedDependencyHash'in b)ok(hash(b.reviewedDependencyHash));
 if(b.type==='RasterizeTextDerivative')ok(id(b.newLayerId)&&hash(b.reviewedRender)&&typeof b.hideOriginal==='boolean');
 if(b.draft!==null){keys(b.draft,['sessionId','draftId','generation']);ok(id(b.draft.sessionId)&&id(b.draft.draftId)&&seq(b.draft.generation));}else ok(b.type==='RasterizeTextDerivative');
}
export function fontVersion(f:any){keys(f,['schemaVersion','id','bytes','faceIndex','format','parserProfile','fsType','licenseRecord','origin','embedding']);blob(f.bytes);blob(f.licenseRecord);ok(f.schemaVersion===1&&hash(f.id)&&f.faceIndex===0&&['static-ttf','static-otf'].includes(f.format)&&f.parserProfile==='sfnt-static-1-freetype-canvaskit040'&&Number.isInteger(f.fsType)&&f.fsType>=0&&f.fsType<=65535&&!(f.fsType&~0x0108)&&((f.fsType&14)===0||(f.fsType&14)===8)&&['bundled','local-file'].includes(f.origin)&&f.embedding==='permitted'&&BigInt(f.bytes.byteLength)>=12n&&BigInt(f.bytes.byteLength)<=16777216n&&BigInt(f.licenseRecord.byteLength)>0n&&BigInt(f.licenseRecord.byteLength)<=65536n);}
export function textSource(s:any):asserts s is TextSource{
 keys(s,['schemaVersion','text','render']);ok(s.schemaVersion===1);const t=s.text,r=s.render;
 keys(t,['schemaVersion','id','textUtf8','style','frame','layoutPolicy','fonts']);blob(t.textUtf8);ok(t.schemaVersion===1&&hash(t.id)&&t.layoutPolicy==='text-layout-1'&&BigInt(t.textUtf8.byteLength)<=16384n&&Array.isArray(t.fonts)&&t.fonts.length>0&&t.fonts.length<=16);t.fonts.forEach(fontVersion);
 const st=t.style;keys(st,['primaryFont','explicitFallbacks','sizePx','lineHeightMultiplier','fill','align','direction']);ok(hash(st.primaryFont)&&Array.isArray(st.explicitFallbacks)&&st.explicitFallbacks.every(hash)&&st.explicitFallbacks.length<16&&[st.sizePx,st.lineHeightMultiplier].every(x=>Number.isFinite(x)&&x>0)&&st.sizePx<=8192&&st.sizePx*st.lineHeightMultiplier<=8192&&['left','center','right','start','end'].includes(st.align)&&['auto','ltr','rtl'].includes(st.direction)&&Array.isArray(st.fill)&&st.fill.length===4&&st.fill.every((n:number)=>Number.isInteger(n)&&n>=0&&n<=255));
 keys(t.frame,['width','height']);ok([t.frame.width,t.frame.height].every(n=>Number.isFinite(n)&&n>0&&n<=8192)&&Math.ceil(t.frame.width)*Math.ceil(t.frame.height)<=25000000);
 const order=[st.primaryFont,...st.explicitFallbacks];ok(new Set(order).size===order.length&&order.length===t.fonts.length&&t.fonts.every((f:FontVersion,i:number)=>f.bytes.hash===order[i])&&t.fonts.reduce((n:number,f:FontVersion)=>n+Number(f.bytes.byteLength),0)<=67108864);
 keys(r,['schemaVersion','id','textVersion','rendererProfile','dependencyHash','layout','pixels','width','height','overflow','resolvedFonts']);keys(r.rendererProfile,['schemaVersion','id','manifest']);blob(r.rendererProfile.manifest);blob(r.layout);blob(r.pixels);
 ok(r.schemaVersion===1&&hash(r.id)&&r.textVersion===t.id&&r.rendererProfile.schemaVersion===1&&hash(r.rendererProfile.id)&&hash(r.dependencyHash)&&r.width===Math.ceil(t.frame.width)&&r.height===Math.ceil(t.frame.height)&&r.pixels.byteLength===String(r.width*r.height*4)&&r.pixels.mediaType==='application/x-ideogram-rgba8'&&BigInt(r.layout.byteLength)<=8388608n&&BigInt(r.rendererProfile.manifest.byteLength)<=65536n&&typeof r.overflow==='boolean'&&Array.isArray(r.resolvedFonts)&&r.resolvedFonts.length===t.fonts.length&&r.resolvedFonts.every((x:string,i:number)=>x===t.fonts[i].id));
}
export const textRefs=(s:TextSource):BlobRef[]=>[s.text.textUtf8,s.render.layout,s.render.pixels,s.render.rendererProfile.manifest,...s.text.fonts.flatMap(f=>[f.bytes,f.licenseRecord])];

// A current draft is recoverable source, including over-limit text. Apply owns
// text/style limits. This checkpoint never implies an accepted render.
export type TextDraft = {schemaVersion:1;kind:'text-draft-1';textUtf8:BlobRef;style:TextStyle;frame:{width:number;height:number};fonts:FontVersion[]};
export function textDraft(v:any):asserts v is TextDraft{
 keys(v,['schemaVersion','kind','textUtf8','style','frame','fonts']);blob(v.textUtf8);ok(v.schemaVersion===1&&v.kind==='text-draft-1'&&Array.isArray(v.fonts)&&v.fonts.length<=16&&v.style&&typeof v.style==='object'&&v.frame&&typeof v.frame==='object');v.fonts.forEach(fontVersion);
}
export const draftRefs=(v:TextDraft)=>[v.textUtf8,...v.fonts.flatMap(f=>[f.bytes,f.licenseRecord])];
