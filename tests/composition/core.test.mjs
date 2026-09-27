import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyComposition,emptyElement,emptyStyle,parseCaption,validateCaption,serialize,projectBounds,linkField,detach,fieldStatus,fromCaption} from '../../dist/local/src/composition/core.js';
import {compositionDraft,compositionDraftGraph} from '../../dist/local/src/composition/draft.js';
const utf8=s=>new TextEncoder().encode(s);
const caption=()=>({high_level_description:'',compositional_deconstruction:{background:'',elements:[]}});
const c=()=>emptyComposition(1600,900,'version1');
test('exact Unicode, newline, key order, photo/art and one serialization',()=>{
 const v=c(),e=emptyElement('text','semantic1');v.scene='Café 東京';v.style={...emptyStyle(),palette:['#AABBCC']};e.text.value='عربي\n👩🏾‍🔬\r\nCafe\u0301';e.desc.value='Blue';e.palette=[];v.elements=[e];
 const s=serialize(v,[],{});assert.equal(s.prompt,'{"high_level_description":"Café 東京","style_description":{"aesthetics":"","lighting":"","photo":"","medium":"","color_palette":["#AABBCC"]},"compositional_deconstruction":{"background":"","elements":[{"type":"text","text":"عربي\\n👩🏾‍🔬\\r\\nCafé","desc":"Blue","color_palette":[]}]}}');
 const body=JSON.stringify({prompt:s.prompt});assert.deepEqual(JSON.parse(JSON.parse(body).prompt),s.caption);assert(!s.prompt.includes('semantic1'));assert.equal(parseCaption(utf8(s.prompt)).state,'supported');
 v.style.kind='art';assert.deepEqual(Object.keys(serialize(v,[],{}).caption.style_description),['aesthetics','lighting','medium','art_style','color_palette']);
 v.elements[0].type='obj';assert(!('text'in serialize(v,[],{}).caption.compositional_deconstruction.elements[0]));assert.equal(v.elements[0].text.value,e.text.value);
});
test('missing scene is distinct from explicit empty; every nested field rejects aliases and wrong types',()=>{
 const missing=caption();delete missing.high_level_description;assert(validateCaption(missing).some(i=>i.code==='MISSING_SCENE'));assert.deepEqual(validateCaption(caption()),[]);
 const variants=[{...caption(),extra:1},{...caption(),high_level_description:null},{...caption(),style_description:null},{...caption(),style_description:{aesthetics:'',lighting:'',photo:'',medium:'',art_style:''}},{...caption(),compositional_deconstruction:{background:'',elements:[{type:'obj',text:'not permitted',desc:''}]}},{...caption(),compositional_deconstruction:{background:'',elements:[{type:'text',text:'',desc:null}]}},{...caption(),compositional_deconstruction:{background:'',elements:[{type:'obj',bbox:[0,0,1.5,2],desc:''}]}},{...caption(),compositional_deconstruction:{background:'',elements:[{type:'obj',bbox:[0,0,0,2],desc:''}]}},{...caption(),compositional_deconstruction:{background:'',elements:[{type:'obj',desc:'',color_palette:['#aabbcc']}]}},{...caption(),compositional_deconstruction:{background:'',elements:[{type:'obj',desc:'',color_palette:[{rgb:{r:0,g:0,b:0},color_weight:0.5}]}]}}];
 for(const v of variants)assert(validateCaption(v).length,JSON.stringify(v));
});
test('raw parser preserves duplicate-decoded-key, encoding, type and bounded-resource distinctions',()=>{
 for(const [raw,state,code]of [['{"text":1,"te\\u0078t":2}','ambiguous','DUPLICATE_KEY'],['null','unsupported','UNSUPPORTED_ROOT'],['[]','unsupported','UNSUPPORTED_ROOT'],[JSON.stringify(JSON.stringify(caption())),'unsupported','ENCODED_STRING_ROOT'],['```json\n{}\n```','malformed','MALFORMED_JSON'],['{"a":1,}','malformed','MALFORMED_JSON'],['{"a":1e999}','malformed','NONFINITE_NUMBER'],['{"a":"\\ud800"}','malformed','INVALID_UNICODE'],['['.repeat(17)+']'.repeat(17),'over-limit','DEPTH_LIMIT'],['"'+'a'.repeat(16385)+'"','over-limit','STRING_LIMIT'],[' '.repeat(262145),'over-limit','BYTE_LIMIT'],['['+Array(25001).fill(0).join(',')+']','over-limit','TOKEN_LIMIT']]){const before=utf8(raw),saved=before.slice(),r=parseCaption(before);assert.equal(r.state,state,raw.slice(0,80));assert.equal(r.issues[0].code,code);assert.deepEqual(before,saved);}
 assert.equal(parseCaption(Uint8Array.of(0xff)).issues[0].code,'INVALID_UTF8');
});
test('all corners, row-first normalization, explicit clipping, collapse and unresolved auto',()=>{
 const f=c().frame,g={rect:[160,90,1280,180],transform:[1,0,0,1,0,0]},p=projectBounds(g,f,'inside');assert.deepEqual(p.quantized,[100,100,300,900]);assert.deepEqual(g.rect,[160,90,1280,180]);
 const shear=projectBounds({rect:[0,0,100,100],transform:[1,.5,.3,1,100,100]},f,'inside');assert.equal(shear.corners.length,4);assert.equal(shear.approximation,true);assert.deepEqual(shear.unclipped,[100,100,250,230]);
 assert.throws(()=>projectBounds({rect:[-1,0,100,100],transform:g.transform},f,'inside'),/OUT_OF_FRAME/);assert.deepEqual(projectBounds({rect:[-1,0,100,100],transform:g.transform},f,'clip').clipped,[0,0,100,99]);assert.throws(()=>projectBounds({rect:[0,0,.0001,1],transform:g.transform},f,'inside'),/COLLAPSED/);
 assert.throws(()=>projectBounds(g,{...f,width:null,height:null},'inside'),/UNRESOLVED_AUTO/);assert.equal(projectBounds(g,{...f,width:null,height:null},'omit'),null);
});
test('typed explicit links, last-reviewed detach, missing source and literal independence',()=>{
 const layer={id:'native',version:'1',kind:'text',text:'First\n東京',appearance:'Blue heading',bounds:{rect:[0,0,100,100],transform:[1,0,0,1,0,0]}},b=linkField('text-content',layer),map={native:'native'};
 assert.equal(fieldStatus(b,[layer],map),'reviewed');assert.equal(fieldStatus(b,[{...layer,version:'2',text:'New'}],map),'stale');assert.equal(fieldStatus(b,[],map),'missing');assert.deepEqual(detach(b),{mode:'literal',value:'First\n東京'});assert.throws(()=>linkField('text-content',{...layer,kind:'image'}),/TEXT_LAYER_REQUIRED/);
 const v=c(),e=emptyElement('text','semantic');e.text=b;v.elements=[e];assert.throws(()=>serialize(v,[],map),/MISSING_LINK/);e.excluded=true;assert.deepEqual(serialize(v,[],map).caption.compositional_deconstruction.elements,[]);
});
test('reviewed conversion creates independent identities without rewriting the raw source',()=>{
 const raw='{"high_level_description":"","compositional_deconstruction":{"background":"","elements":[{"type":"text","bbox":[100,100,300,900],"text":"東京\\nA","desc":""}]}}',before=raw;const result=parseCaption(utf8(raw)),converted=fromCaption(result.value,c().frame,'new',()=> 'fresh-element');assert.equal(converted.elements[0].id,'fresh-element');assert.equal(JSON.stringify(serialize(converted,[],{}).caption),JSON.stringify(result.value));assert.equal(raw,before);
});

test('inverse request transform preserves imported caption boxes; expansion conflicts remain explicit',()=>{
 const v=caption();v.compositional_deconstruction.elements=[{type:'obj',bbox:[100,100,300,900],desc:''}];const f={...c().frame,documentToRequest:[.5,0,0,.75,10,20]};const next=fromCaption(v,f,'converted',()=> 'id');assert.equal(JSON.stringify(serialize(next,[],{}).caption),JSON.stringify(v));next.request.expansion='Large';next.request.operation='Generate with Fast';assert.throws(()=>serialize(next,[],{}),/EXPANSION_ROUTE_CONFLICT/);next.request.expansion='Medium';assert.throws(()=>serialize(next,[],{}),/REWRITE_ACK_REQUIRED/);next.request.rewriteAcknowledged=true;assert.doesNotThrow(()=>serialize(next,[],{}));
});

test('independent exact resource boundaries and palette limits preserve originals',()=>{
 const raw=JSON.stringify(caption());assert.equal(parseCaption(utf8(raw+' '.repeat(262144-utf8(raw).length))).state,'supported');assert.equal(parseCaption(utf8(raw+' '.repeat(262145-utf8(raw).length))).issues[0].code,'BYTE_LIMIT');
 const v=caption();v.high_level_description='a'.repeat(16384);assert.equal(parseCaption(utf8(JSON.stringify(v))).state,'supported');v.high_level_description+='a';assert.equal(parseCaption(utf8(JSON.stringify(v))).issues[0].code,'STRING_LIMIT');
 v.high_level_description='';v.compositional_deconstruction.elements=Array.from({length:256},()=>({type:'obj',desc:''}));assert.deepEqual(validateCaption(v),[]);v.compositional_deconstruction.elements.push({type:'obj',desc:''});assert(validateCaption(v).some(i=>i.code==='ELEMENT_LIMIT'));
 assert.equal(parseCaption(utf8('['.repeat(16)+']'.repeat(16))).issues[0].code,'UNSUPPORTED_ROOT');const exact='[[],'+Array(24998).fill(0).join(',')+']';assert.equal(parseCaption(utf8(exact)).issues[0].code,'UNSUPPORTED_ROOT');assert.equal(parseCaption(utf8(exact.slice(0,-1)+',0]')).issues[0].code,'TOKEN_LIMIT');
 for(const [max,scope]of [[5,'element'],[16,'style']]){const graph=c();if(scope==='style')graph.style={...emptyStyle(),palette:Array(max).fill('#AABBCC')};else{const e=emptyElement('obj','id');e.palette=Array(max).fill('#AABBCC');graph.elements=[e];}assert.doesNotThrow(()=>serialize(graph,[],{}));(scope==='style'?graph.style.palette:graph.elements[0].palette).push('#AABBCC');assert.throws(()=>serialize(graph,[],{}),/PALETTE_FORMAT/);}
});


test('draft closure validates structure while preserving invalid editable fields without authority',()=>{
 const ref={hash:'sha256:'+'a'.repeat(64),byteLength:'1',mediaType:'application/json'},graph={composition:c(),bindings:{},numbers:{width:'invalid'}},envelope={schemaVersion:1,kind:'composition-draft-1',graph:ref,raw:[],bindings:{}};
 graph.composition.scene='x'.repeat(16385);graph.composition.elements=[emptyElement('obj','e')];graph.composition.elements[0].bounds={mode:'literal',value:{rect:[0,0,-1,1],transform:[1,0,0,1,0,0]}};
 assert.doesNotThrow(()=>compositionDraftGraph(graph,envelope));assert.throws(()=>serialize(graph.composition,[],{}));
 const missing=structuredClone(graph);missing.composition.raw=[ref];assert.throws(()=>compositionDraftGraph(missing,envelope));
 const broken=structuredClone(graph);broken.composition.elements[0].desc=null;assert.throws(()=>compositionDraftGraph(broken,envelope));
 const unknown=structuredClone(graph);unknown.unrecognized={};assert.throws(()=>compositionDraftGraph(unknown,envelope));
 assert.throws(()=>compositionDraft({...envelope,graph:{...ref,byteLength:'8388609'}}));
});
