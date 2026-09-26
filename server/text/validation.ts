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
const retainedProfiles=[{id:profile.id,manifest:profileRef},{id:prior.id,manifest:{hash:hashBytes(priorBytes),byteLength:String(priorBytes.length),mediaType:'application/json'}}];
export const retainedProfile=(p:any)=>retainedProfiles.some(known=>p.schemaVersion===1&&p.id===known.id&&canonical(p.manifest)===canonical(known.manifest));
export function identity(value:object){return hashBytes(canonical(value));}
export function assertIdentity(value:{id:string}){const {id,...body}=value;ok(id===identity(body),'Immutable text identity mismatch');}
export function validateSource(value:unknown):TextSource{
 textSource(value);const s=value;assertIdentity(s.text);assertIdentity(s.render);s.text.fonts.forEach(f=>{assertIdentity(f);bundledFont(f);});
 return s;
}
export function dependencies(s:TextSource){return textRefs(s);}
export function validateLayout(s:TextSource,bytes:Uint8Array,textBytes:Uint8Array){
 const text=new TextDecoder('utf-8',{fatal:true}).decode(textBytes);ok(!text.includes('\r')&&text.split('\n').length<=256&&new TextEncoder().encode(text).length<=16384);
 const layout:any=parseControlJSON(bytes,8388608);
 keys(layout,['version','policy','frame','indexConvention','utf16ToUtf8','utf8ToUtf16','lineHeightPolicy','fontMetrics','intrinsicHeight','requestedLineHeight','logicalLines','paragraphs','height','overflow']);
 ok(layout.version==='layout-1'&&layout.policy==='text-layout-1'&&canonical(layout.frame)===canonical(s.text.frame)&&layout.overflow===s.render.overflow&&layout.logicalLines===text.split('\n').length);
 const u16=Array(text.length+1).fill(-1),u8=Array(textBytes.length+1).fill(-1);let off=0;
 for(let i=0;i<text.length;){const cp=text.codePointAt(i)!;ok(cp<0xd800||cp>0xdfff);u16[i]=off;u8[off]=i;off+=cp<128?1:cp<2048?2:cp<65536?3:4;i+=cp>65535?2:1;}
 u16[text.length]=off;u8[off]=text.length;ok(canonical(u16)===canonical(layout.utf16ToUtf8)&&canonical(u8)===canonical(layout.utf8ToUtf16));
 let scalars=0;for(const _ of text)scalars++;const max=Math.max(64,8*scalars);let runs=0,glyphs=0,lines=0,rects=0,start=0;
 ok(Array.isArray(layout.paragraphs)&&layout.paragraphs.length===layout.logicalLines&&Array.isArray(layout.fontMetrics)&&layout.fontMetrics.length===s.text.fonts.length);
 const nums=(v:any)=>Array.isArray(v)&&v.every(Number.isFinite),rect=(v:any)=>nums(v)&&v.length===4&&v[2]>=v[0]&&v[3]>=v[1];
 ok([layout.intrinsicHeight,layout.requestedLineHeight,layout.height].every(Number.isFinite)&&layout.height>=0);
 for(let i=0;i<layout.fontMetrics.length;i++){const f=layout.fontMetrics[i];keys(f,['hash','ascent','descent','leading']);ok(f.hash===s.text.fonts[i].bytes.hash&&[f.ascent,f.descent,f.leading].every(Number.isFinite));}
 const finite=(v:any):void=>{if(typeof v==='number')ok(Number.isFinite(v));else if(v&&typeof v==='object')Object.values(v).forEach(finite);};finite(layout);
 for(const p of layout.paragraphs){
  keys(p,['startUtf16','endUtf16','startUtf8','endUtf8','top','height','direction','lines','runs','clusters']);
  const end=text.indexOf('\n',start)<0?text.length:text.indexOf('\n',start);ok(p.startUtf16===start&&p.endUtf16===end&&p.startUtf8===u16[start]&&p.endUtf8===u16[end]&&['ltr','rtl'].includes(p.direction)&&Array.isArray(p.lines)&&Array.isArray(p.runs)&&Array.isArray(p.clusters));lines+=p.lines.length;ok([p.top,p.height].every(Number.isFinite)&&p.height>=0);
  for(const l of p.lines){keys(l,['baseline','ascent','descent','height','width','left','lineNumber','isHardBreak','startUtf8','endUtf8','startUtf16','endUtf16','endExcludingWhitespacesUtf16','endIncludingNewlineUtf16','endExcludingWhitespacesUtf8','endIncludingNewlineUtf8']);ok([l.baseline,l.ascent,l.descent,l.height,l.width,l.left].every(Number.isFinite)&&Number.isSafeInteger(l.lineNumber)&&l.lineNumber>=0&&typeof l.isHardBreak==='boolean');for(const key of ['start','end','endExcludingWhitespaces','endIncludingNewline'])ok(Number.isInteger(l[key+'Utf16'])&&l[key+'Utf16']>=start&&l[key+'Utf16']<=end&&u16[l[key+'Utf16']]===l[key+'Utf8']);}
  for(const r of p.runs){keys(r,['fontHash','size','flags','glyphs','offsetsUtf8','offsetsUtf16','positions','inkBounds','top','bottom','baseline']);runs++;ok(s.text.fonts.some(f=>f.bytes.hash===r.fontHash)&&Array.isArray(r.glyphs)&&r.glyphs.every((g:number)=>Number.isInteger(g)&&g>0)&&r.offsetsUtf8.length===r.glyphs.length+1&&r.offsetsUtf16.length===r.glyphs.length+1&&r.positions.length===2*(r.glyphs.length+1)&&r.inkBounds.length===r.glyphs.length);ok(nums(r.positions)&&Array.isArray(r.inkBounds)&&r.inkBounds.every(rect)&&[r.top,r.bottom,r.baseline,r.size,r.flags].every(Number.isFinite)&&r.size===s.text.style.sizePx);glyphs+=r.glyphs.length;for(let i=0;i<=r.glyphs.length;i++)ok(r.offsetsUtf16[i]>=start&&r.offsetsUtf16[i]<=end&&u16[r.offsetsUtf16[i]]===r.offsetsUtf8[i]);}
  for(const c of p.clusters){keys(c,['startUtf16','endUtf16','startUtf8','endUtf8','direction','rect','ranges']);ok(rect(c.rect)&&['ltr','rtl'].includes(c.direction));for(const range of c.ranges){keys(range,['rect','direction']);ok(rect(range.rect)&&['ltr','rtl'].includes(range.direction));}ok(Number.isInteger(c.startUtf16)&&Number.isInteger(c.endUtf16)&&c.startUtf16>=start&&c.endUtf16<=end&&c.endUtf16>c.startUtf16&&u16[c.startUtf16]===c.startUtf8&&u16[c.endUtf16]===c.endUtf8&&Array.isArray(c.ranges));rects+=c.ranges.length;}
  // Every retained scalar is covered by accepted native grapheme geometry.
  for(let i=start;i<end;){ok(p.clusters.some((c:any)=>c.startUtf16<=i&&c.endUtf16>i));i+=text.codePointAt(i)!>65535?2:1;}
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
