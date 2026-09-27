import {canonical} from '../protocol/json.js';
import type { BlobRef } from '../protocol/store.js';
import {blob,keys,id,requireValue as ok} from '../protocol/validate.js';

// A retained editor draft is not executable semantic authority. Its exact graph
// bytes may contain invalid fields, while this small envelope owns its closure.
export type CompositionDraft={schemaVersion:1;kind:'composition-draft-1';graph:BlobRef;raw:BlobRef[];bindings:Record<string,string>};
export function compositionDraft(v:any):asserts v is CompositionDraft {
 keys(v,['schemaVersion','kind','graph','raw','bindings']);ok(v.schemaVersion===1&&v.kind==='composition-draft-1');blob(v.graph);ok(v.graph.mediaType==='application/json'&&BigInt(v.graph.byteLength)<=8388608n&&Array.isArray(v.raw)&&v.raw.length<=257&&v.bindings&&typeof v.bindings==='object'&&!Array.isArray(v.bindings)&&Object.keys(v.bindings).length<=768&&Object.entries(v.bindings).every(([k,x])=>id(k)&&id(x)));v.raw.forEach(blob);
}
export function compositionDraftRefs(v:CompositionDraft){return [v.graph,...v.raw];}

// Validate structure and the complete byte/link closure without granting semantic
// authority. Invalid editable strings, numbers and palettes remain recoverable.
export function compositionDraftGraph(v:any,envelope:CompositionDraft){
 const object=(x:any)=>x&&typeof x==='object'&&!Array.isArray(x),strings=(x:any)=>object(x)&&Object.values(x).every(v=>typeof v==='string');
 ok(object(v));const allowed=['composition','bindings','selected','numbers','color','view','guides','rawText','rawIndex','rawOffset'];ok(Object.keys(v).every(k=>allowed.includes(k))&&strings(v.bindings)&&(!('numbers'in v)||strings(v.numbers)));
 for(const k of ['selected','color','view','rawText'])if(k in v)ok(typeof v[k]==='string');if('guides'in v)ok(typeof v.guides==='boolean');for(const k of ['rawIndex','rawOffset'])if(k in v)ok(Number.isSafeInteger(v[k])&&v[k]>=0);
 const c=v.composition;keys(c,['schemaVersion','kind','id','profile','scene','background','style','inactiveStyle','elements','frame','raw','request','review']);ok(c.schemaVersion===1&&c.kind==='composition-version-1'&&c.profile==='ideogram-guide-990fe1c-app1'&&id(c.id)&&typeof c.scene==='string'&&typeof c.background==='string');
 const palette=(p:any)=>ok(p===null||Array.isArray(p)&&p.every(x=>typeof x==='string'));
 const style=(s:any)=>{keys(s,['kind','aesthetics','lighting','medium','photo','artStyle','palette']);ok(['photo','art'].includes(s.kind)&&['aesthetics','lighting','medium','photo','artStyle'].every(k=>typeof s[k]==='string'));palette(s.palette);};
 if(c.style!==null)style(c.style);style(c.inactiveStyle);
 const geometry=(g:any)=>{keys(g,['rect','transform']);ok(Array.isArray(g.rect)&&g.rect.length===4&&Array.isArray(g.transform)&&g.transform.length===6&&[...g.rect,...g.transform].every(Number.isFinite));};
 const links=new Set<string>();ok(Array.isArray(c.elements)&&c.elements.length<=256);const ids=new Set<string>();for(const e of c.elements){keys(e,['id','type','desc','text','bounds','boundsPolicy','palette','excluded']);ok(id(e.id)&&!ids.has(e.id)&&['obj','text'].includes(e.type)&&['inside','clip','omit'].includes(e.boundsPolicy)&&typeof e.excluded==='boolean');ids.add(e.id);palette(e.palette);
  for(const field of ['desc','text','bounds']){const b=e[field];if(field==='bounds'&&b===null)continue;let value;if(b?.mode==='literal'){keys(b,['mode','value']);value=b.value;}else{keys(b,['mode','layerId','property','lastReviewedLayerVersion','lastReviewedValue']);ok(b.mode==='layer'&&id(b.layerId)&&typeof b.lastReviewedLayerVersion==='string'&&/^(0|[1-9][0-9]*)$/.test(b.lastReviewedLayerVersion)&&b.property===(field==='desc'?'appearance-description':field==='text'?'text-content':'frame-bounds'));links.add(b.layerId);value=b.lastReviewedValue;}if(field==='bounds')geometry(value);else ok(typeof value==='string');}
 }
 const f=c.frame;keys(f,['revision','width','height','documentWidth','documentHeight','documentToRequest']);ok(id(f.revision)&&[f.documentWidth,f.documentHeight].every(Number.isFinite)&&[f.width,f.height].every(x=>x===null||Number.isFinite(x))&&Array.isArray(f.documentToRequest)&&f.documentToRequest.length===6&&f.documentToRequest.every(Number.isFinite));
 keys(c.request,['operation','expansion','rewriteAcknowledged']);ok(typeof c.request.operation==='string'&&['None','Medium','Large'].includes(c.request.expansion)&&typeof c.request.rewriteAcknowledged==='boolean');
 ok(Array.isArray(c.raw)&&c.raw.length<=256);c.raw.forEach(blob);const refs=[...c.raw];if(c.review!==null){keys(c.review,['serializer','sourceId','frame','request','dependencies','boxes','prompt']);blob(c.review.prompt);refs.push(c.review.prompt);}
 ok(canonical(refs)===canonical(envelope.raw)&&Object.keys(envelope.bindings).length===links.size&&[...links].every(k=>id(envelope.bindings[k]))&&Object.keys(v.bindings).length===links.size&&[...links].every(k=>v.bindings[k]===envelope.bindings[k]));
}
