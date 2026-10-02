import {parseControlJSON} from '../../src/protocol/json.js';
import { readFileSync } from 'node:fs';
import { canonical, hashBytes } from '../storage/canonical.js';
import { textSource, textRefs } from '../../src/protocol/text.js';
import type { TextSource, FontVersion } from '../../src/protocol/text.js';
import type { BlobRef } from '../../src/protocol/store.js';
import { keys, requireValue as ok } from '../../src/protocol/validate.js';

// Trusted app-distributed metadata only. Never import project-supplied code.
export const profileBytes=readFileSync(new URL('../../../../src/text/profile.json',import.meta.url));
export const profile=JSON.parse(profileBytes.toString());
export const profileRef:BlobRef={hash:hashBytes(profileBytes),byteLength:String(profileBytes.length),mediaType:'application/json'};
const priorBytes=readFileSync(new URL('../../../../src/text/retained-profiles/c19791ae.json',import.meta.url));
const prior=JSON.parse(priorBytes.toString());
const rejectedBytes=readFileSync(new URL('../../../../src/text/retained-profiles/b89503d3.json',import.meta.url));
const rejected=JSON.parse(rejectedBytes.toString());
const maskPriorBytes=readFileSync(new URL('../../../../src/text/retained-profiles/6e8a481e.json',import.meta.url));
const maskPrior=JSON.parse(maskPriorBytes.toString());
const gridPriorBytes=readFileSync(new URL('../../../../src/text/retained-profiles/d047f5be.json',import.meta.url));
const gridPrior=JSON.parse(gridPriorBytes.toString());
const placementPriorBytes=readFileSync(new URL('../../../../src/text/retained-profiles/304528c9.json',import.meta.url));
const placementPrior=JSON.parse(placementPriorBytes.toString());
const compositionPriorBytes=readFileSync(new URL('../../../../src/text/retained-profiles/ff24a513.json',import.meta.url));
const compositionPrior=JSON.parse(compositionPriorBytes.toString());
const streamedPriorBytes=readFileSync(new URL('../../../../src/text/retained-profiles/f5e8bd34.json',import.meta.url));
const streamedPrior=JSON.parse(streamedPriorBytes.toString());
const frameOrderPriorBytes=readFileSync(new URL('../../../../src/text/retained-profiles/7a4dbc6c.json',import.meta.url));
const frameOrderPrior=JSON.parse(frameOrderPriorBytes.toString());
const ownershipPriorBytes=readFileSync(new URL('../../../../src/text/retained-profiles/4fd6f6a1.json',import.meta.url));
const ownershipPrior=JSON.parse(ownershipPriorBytes.toString());
const integrationPriorBytes=readFileSync(new URL('../../../../src/text/retained-profiles/68efa85f.json',import.meta.url));
const integrationPrior=JSON.parse(integrationPriorBytes.toString());
const combinedCPUPriorBytes=readFileSync(new URL('../../../../src/text/retained-profiles/6d77f925.json',import.meta.url));
const combinedCPUPrior=JSON.parse(combinedCPUPriorBytes.toString());
const adapterOwnershipPriorBytes=readFileSync(new URL('../../../../src/text/retained-profiles/c6ca02c2.json',import.meta.url));
const adapterOwnershipPrior=JSON.parse(adapterOwnershipPriorBytes.toString());
const httpFramingPriorBytes=readFileSync(new URL('../../../../src/text/retained-profiles/1c399d52.json',import.meta.url));
const httpFramingPrior=JSON.parse(httpFramingPriorBytes.toString());
const deferredManifestPriorBytes=readFileSync(new URL('../../../../src/text/retained-profiles/e648eede.json',import.meta.url));
const deferredManifestPrior=JSON.parse(deferredManifestPriorBytes.toString());
const startupProfilePriorBytes=readFileSync(new URL('../../../../src/text/retained-profiles/891a4688.json',import.meta.url));
const startupProfilePrior=JSON.parse(startupProfilePriorBytes.toString());
const textResourcesPriorBytes=readFileSync(new URL('../../../../src/text/retained-profiles/b96236b0.json',import.meta.url));
const textResourcesPrior=JSON.parse(textResourcesPriorBytes.toString());
const admissionSplitPriorBytes=readFileSync(new URL('../../../../src/text/retained-profiles/2e9362c1.json',import.meta.url));
const admissionSplitPrior=JSON.parse(admissionSplitPriorBytes.toString());
const paragraphBudgetPriorBytes=readFileSync(new URL('../../../../src/text/retained-profiles/6f7be5be.json',import.meta.url));
const paragraphBudgetPrior=JSON.parse(paragraphBudgetPriorBytes.toString());
const retainedProfiles=[{id:frameOrderPrior.id,manifest:{hash:hashBytes(frameOrderPriorBytes),byteLength:String(frameOrderPriorBytes.length),mediaType:'application/json'}},{id:streamedPrior.id,manifest:{hash:hashBytes(streamedPriorBytes),byteLength:String(streamedPriorBytes.length),mediaType:'application/json'}},{id:compositionPrior.id,manifest:{hash:hashBytes(compositionPriorBytes),byteLength:String(compositionPriorBytes.length),mediaType:'application/json'}},{id:placementPrior.id,manifest:{hash:hashBytes(placementPriorBytes),byteLength:String(placementPriorBytes.length),mediaType:'application/json'}},{id:gridPrior.id,manifest:{hash:hashBytes(gridPriorBytes),byteLength:String(gridPriorBytes.length),mediaType:'application/json'}},{id:maskPrior.id,manifest:{hash:hashBytes(maskPriorBytes),byteLength:String(maskPriorBytes.length),mediaType:'application/json'}},{id:rejected.id,manifest:{hash:hashBytes(rejectedBytes),byteLength:String(rejectedBytes.length),mediaType:'application/json'}},{id:profile.id,manifest:profileRef},{id:prior.id,manifest:{hash:hashBytes(priorBytes),byteLength:String(priorBytes.length),mediaType:'application/json'}}];
retainedProfiles.unshift({id:admissionSplitPrior.id,manifest:{hash:hashBytes(admissionSplitPriorBytes),byteLength:String(admissionSplitPriorBytes.length),mediaType:'application/json'}},{id:textResourcesPrior.id,manifest:{hash:hashBytes(textResourcesPriorBytes),byteLength:String(textResourcesPriorBytes.length),mediaType:'application/json'}},{id:startupProfilePrior.id,manifest:{hash:hashBytes(startupProfilePriorBytes),byteLength:String(startupProfilePriorBytes.length),mediaType:'application/json'}},{id:deferredManifestPrior.id,manifest:{hash:hashBytes(deferredManifestPriorBytes),byteLength:String(deferredManifestPriorBytes.length),mediaType:'application/json'}},{id:httpFramingPrior.id,manifest:{hash:hashBytes(httpFramingPriorBytes),byteLength:String(httpFramingPriorBytes.length),mediaType:'application/json'}},{id:adapterOwnershipPrior.id,manifest:{hash:hashBytes(adapterOwnershipPriorBytes),byteLength:String(adapterOwnershipPriorBytes.length),mediaType:'application/json'}},{id:combinedCPUPrior.id,manifest:{hash:hashBytes(combinedCPUPriorBytes),byteLength:String(combinedCPUPriorBytes.length),mediaType:'application/json'}},{id:ownershipPrior.id,manifest:{hash:hashBytes(ownershipPriorBytes),byteLength:String(ownershipPriorBytes.length),mediaType:'application/json'}},{id:integrationPrior.id,manifest:{hash:hashBytes(integrationPriorBytes),byteLength:String(integrationPriorBytes.length),mediaType:'application/json'}});
retainedProfiles.unshift({id:paragraphBudgetPrior.id,manifest:{hash:hashBytes(paragraphBudgetPriorBytes),byteLength:String(paragraphBudgetPriorBytes.length),mediaType:'application/json'}});
export const retainedProfile=(p:any)=>retainedProfiles.some(known=>p.schemaVersion===1&&p.id===known.id&&canonical(p.manifest)===canonical(known.manifest));
export const usesStreamingLayout=(id:string)=>id===profile.id||id===frameOrderPrior.id||id===ownershipPrior.id||id===integrationPrior.id||id===combinedCPUPrior.id||id===adapterOwnershipPrior.id||id===httpFramingPrior.id||id===deferredManifestPrior.id||id===startupProfilePrior.id||id===textResourcesPrior.id||id===admissionSplitPrior.id||id===paragraphBudgetPrior.id;
export function identity(value:object){return hashBytes(canonical(value));}
export function assertIdentity(value:{id:string}){const {id,...body}=value;ok(id===identity(body),'Immutable text identity mismatch');}
export function validateSource(value:unknown):TextSource{
 textSource(value);const s=value;assertIdentity(s.text);assertIdentity(s.render);s.text.fonts.forEach(f=>{assertIdentity(f);bundledFont(f);});
 return s;
}
export function dependencies(s:TextSource){return textRefs(s);}
// Bound the strict token pass and the eventual native JSON graph before either
// is allocated. This scans bytes only; JSON validity still belongs to the shared
// duplicate-key/UTF-8/number validator. Container/slot/string allowances include
// both passes without relying on collection of temporary token strings.
export function layoutValidationBytes(bytes:Uint8Array){
 ok(bytes.length<=8388608);let allocation=3*bytes.length+16777216,depth=0;
 const containers=new Uint8Array(65);
 const delimiter=(value:number)=>value===9||value===10||value===13||value===32||value===44||value===93||value===125;
 for(let at=0;at<bytes.length;at++){
  const token=bytes[at];
  if(token===34){const start=at;for(at++;at<bytes.length&&bytes[at]!==34;at++)if(bytes[at]===92)at++;allocation+=96+4*(at-start+1);}
  else if(token===123||token===91){ok(++depth<=64);containers[depth]=token;allocation+=64+(token===91?16:0);}
  else if(token===125||token===93){ok(depth>0);depth--;}
  else if(token===58)allocation+=64;
  else if(token===44&&containers[depth]===91)allocation+=16;
  else if(token===45||token>=48&&token<=57||token===116||token===102||token===110){
   allocation+=16;while(at+1<bytes.length&&!delimiter(bytes[at+1]))at++;
  }
 }
 return allocation;
}
export function validateLayout(s:TextSource,bytes:Uint8Array,textBytes:Uint8Array,options:{portable?:boolean}={}){
 ok(textBytes.length<=16384);const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(textBytes);ok(!text.includes('\r'));
 ok(layoutValidationBytes(bytes)<=134217728);
 const layout:any=parseControlJSON(bytes,8388608);
 if(options.portable&&(layout.version!=='layout-1'||layout.policy!=='text-layout-1'))throw new UnsupportedText('UNSUPPORTED_TEXT_LAYOUT');
 keys(layout,['version','policy','frame','indexConvention','utf16ToUtf8','utf8ToUtf16','lineHeightPolicy','fontMetrics','intrinsicHeight','requestedLineHeight','logicalLines','paragraphs','height','overflow']);
 keys(layout.frame,['width','height']);ok(layout.version==='layout-1'&&layout.policy==='text-layout-1'&&layout.frame.width===s.text.frame.width&&layout.frame.height===s.text.frame.height&&layout.overflow===s.render.overflow);
 ok(layout.indexConvention==='half-open; UTF-16 native; UTF-8 shaped offsets; -1 scalar interiors; downstream at start/upstream at end'&&layout.lineHeightPolicy==='max-supplied-font-metrics-times-multiplier; symmetric-leading; native-rounded-baselines');
 const u16=new Int32Array(text.length+1).fill(-1),u8=new Int32Array(textBytes.length+1).fill(-1);let off=0,scalars=0,logicalLines=1;
 for(let i=0;i<text.length;){const cp=text.codePointAt(i)!;ok(cp<0xd800||cp>0xdfff);u16[i]=off;u8[off]=i;off+=cp<128?1:cp<2048?2:cp<65536?3:4;i+=cp>65535?2:1;scalars++;if(cp===10)logicalLines++;}
 u16[text.length]=off;u8[off]=text.length;ok(logicalLines<=256&&layout.logicalLines===logicalLines);
 const sameIndices=(expected:Int32Array,actual:any)=>Array.isArray(actual)&&actual.length===expected.length&&expected.every((value,index)=>actual[index]===value);
 ok(sameIndices(u16,layout.utf16ToUtf8)&&sameIndices(u8,layout.utf8ToUtf16));
 const max=Math.max(64,8*scalars);let runs=0,glyphs=0,lines=0,rects=0,clusters=0,start=0;
 // Maximal end for each scalar-boundary start preserves union coverage even
 // when native clusters overlap, repeat, or arrive in visual (RTL) order.
 // UTF-8 input is<=16KiB, so every UTF-16 end fits in this<=32KiB table.
 const coverageEnds=new Uint16Array(text.length+1);
 ok(Array.isArray(layout.paragraphs)&&layout.paragraphs.length===layout.logicalLines&&Array.isArray(layout.fontMetrics)&&layout.fontMetrics.length===s.text.fonts.length);
 const nums=(v:any)=>Array.isArray(v)&&v.every(Number.isFinite),rect=(v:any)=>nums(v)&&v.length===4&&v[2]>=v[0]&&v[3]>=v[1];
 ok([layout.intrinsicHeight,layout.requestedLineHeight,layout.height].every(Number.isFinite)&&layout.height>=0);
 for(let i=0;i<layout.fontMetrics.length;i++){const f=layout.fontMetrics[i];keys(f,['hash','ascent','descent','leading']);ok(f.hash===s.text.fonts[i].bytes.hash&&[f.ascent,f.descent,f.leading].every(Number.isFinite));}
 for(const p of layout.paragraphs){
  keys(p,['startUtf16','endUtf16','startUtf8','endUtf8','top','height','direction','lines','runs','clusters']);
  const newline=text.indexOf('\n',start),end=newline<0?text.length:newline;ok(p.startUtf16===start&&p.endUtf16===end&&p.startUtf8===u16[start]&&p.endUtf8===u16[end]&&['ltr','rtl'].includes(p.direction)&&Array.isArray(p.lines)&&Array.isArray(p.runs)&&Array.isArray(p.clusters));ok(end===start||p.lines.length>0&&p.runs.length>0);lines+=p.lines.length;runs+=p.runs.length;clusters+=p.clusters.length;ok(lines<=Math.max(logicalLines,max)&&runs<=max&&clusters<=scalars&&[p.top,p.height].every(Number.isFinite)&&p.height>=0);
  for(const l of p.lines){keys(l,['baseline','ascent','descent','height','width','left','lineNumber','isHardBreak','startUtf8','endUtf8','startUtf16','endUtf16','endExcludingWhitespacesUtf16','endIncludingNewlineUtf16','endExcludingWhitespacesUtf8','endIncludingNewlineUtf8']);ok([l.baseline,l.ascent,l.descent,l.height,l.width,l.left].every(Number.isFinite)&&Number.isSafeInteger(l.lineNumber)&&l.lineNumber>=0&&typeof l.isHardBreak==='boolean');for(const key of ['start','end','endExcludingWhitespaces','endIncludingNewline'])ok(Number.isInteger(l[key+'Utf16'])&&l[key+'Utf16']>=start&&l[key+'Utf16']<=end&&u16[l[key+'Utf16']]>=0&&u16[l[key+'Utf16']]===l[key+'Utf8']);}
  for(const l of p.lines)ok(l.startUtf16<=l.endExcludingWhitespacesUtf16&&l.endExcludingWhitespacesUtf16<=l.endUtf16&&l.endUtf16<=l.endIncludingNewlineUtf16);
  for(const r of p.runs){keys(r,['fontHash','size','flags','glyphs','offsetsUtf8','offsetsUtf16','positions','inkBounds','top','bottom','baseline']);ok(s.text.fonts.some(f=>f.bytes.hash===r.fontHash)&&Array.isArray(r.glyphs)&&Array.isArray(r.offsetsUtf8)&&Array.isArray(r.offsetsUtf16)&&Array.isArray(r.positions)&&Array.isArray(r.inkBounds));glyphs+=r.glyphs.length;ok(glyphs<=max&&r.glyphs.every((g:number)=>Number.isInteger(g)&&g>0)&&r.offsetsUtf8.length===r.glyphs.length+1&&r.offsetsUtf16.length===r.glyphs.length+1&&r.positions.length===2*(r.glyphs.length+1)&&r.inkBounds.length===r.glyphs.length);ok(nums(r.positions)&&r.inkBounds.every(rect)&&[r.top,r.bottom,r.baseline,r.size,r.flags].every(Number.isFinite)&&r.size===s.text.style.sizePx);for(let i=0;i<=r.glyphs.length;i++)ok(Number.isInteger(r.offsetsUtf16[i])&&r.offsetsUtf16[i]>=start&&r.offsetsUtf16[i]<=end&&u16[r.offsetsUtf16[i]]>=0&&u16[r.offsetsUtf16[i]]===r.offsetsUtf8[i]);}
  for(const c of p.clusters){keys(c,['startUtf16','endUtf16','startUtf8','endUtf8','direction','rect','ranges']);ok(rect(c.rect)&&['ltr','rtl'].includes(c.direction)&&Array.isArray(c.ranges));rects+=c.ranges.length;ok(rects<=max*2);for(const range of c.ranges){keys(range,['rect','direction']);ok(rect(range.rect)&&['ltr','rtl'].includes(range.direction));}ok(Number.isInteger(c.startUtf16)&&Number.isInteger(c.endUtf16)&&c.startUtf16>=start&&c.endUtf16<=end&&c.endUtf16>c.startUtf16&&u16[c.startUtf16]>=0&&u16[c.endUtf16]>=0&&u16[c.startUtf16]===c.startUtf8&&u16[c.endUtf16]===c.endUtf8);coverageEnds[c.startUtf16]=Math.max(coverageEnds[c.startUtf16],c.endUtf16);}
  // Every retained scalar is covered by accepted native grapheme geometry.
  let coveredUntil=start;for(let i=start;i<end;){coveredUntil=Math.max(coveredUntil,coverageEnds[i]);ok(coveredUntil>i);i+=text.codePointAt(i)!>65535?2:1;}
  start=end+1;
 }
 ok(runs<=max&&glyphs<=max&&lines<=Math.max(layout.logicalLines,max)&&rects<=max*2);
 return text;
}
export function dependencyIdentity(s:TextSource){const t=s.text,st=t.style;return hashBytes(JSON.stringify({rendererProfile:s.render.rendererProfile.id,textHash:t.textUtf8.hash,style:{primaryFont:st.primaryFont,explicitFallbacks:st.explicitFallbacks,sizePx:st.sizePx,lineHeightMultiplier:st.lineHeightMultiplier,fill:st.fill,align:st.align,direction:st.direction},frame:{width:t.frame.width,height:t.frame.height},fonts:t.fonts.map(f=>({hash:f.bytes.hash,licenseHash:f.licenseRecord.hash,faceIndex:0,format:f.format,parserProfile:f.parserProfile,fsType:f.fsType}))}));}
export function bundledFont(f:FontVersion){const bundled=profile.fonts.find((x:any)=>'sha256:'+x.sha256===f.bytes.hash);ok(f.origin!=='bundled'||bundled&&bundled.bytes===Number(f.bytes.byteLength)&&bundled.licenseHash===f.licenseRecord.hash);}

// Portable forward compatibility preserves unknown source as a read-only archive.
// Live commands still use strict validators and cannot accept this state.
export class UnsupportedText extends Error {}
export function portableTextSupport(v:any):void{
 if(!v||typeof v!=='object')return;
 if(v.text&&v.render&&(v.schemaVersion!==1||v.text.schemaVersion!==1||v.render.schemaVersion!==1||v.text.layoutPolicy!=='text-layout-1'))throw new UnsupportedText('UNSUPPORTED_TEXT_VERSION');
 if(v.parserProfile&&v.licenseRecord&&(v.schemaVersion!==1||v.parserProfile!=='sfnt-static-1-freetype-canvaskit040'))throw new UnsupportedText('UNSUPPORTED_FONT_VERSION');
 if(v.rendererProfile&&(!retainedProfile(v.rendererProfile)))throw new UnsupportedText('UNSUPPORTED_TEXT_PROFILE');
 if(v.kind==='text-draft-1'&&v.schemaVersion!==1)throw new UnsupportedText('UNSUPPORTED_TEXT_DRAFT');
 for(const x of Object.values(v))if(x&&typeof x==='object')portableTextSupport(x);
}
