import test from 'node:test';
import assert from 'node:assert/strict';
import {validateLayout,layoutValidationBytes,UnsupportedText} from '../../dist/local/server/text/validation.js';

const font='sha256:'+'1'.repeat(64),frame={width:120,height:70};
const source={text:{frame,fonts:[{bytes:{hash:font}}],style:{sizePx:16}},render:{overflow:false}};
const encode=value=>Buffer.from(JSON.stringify(value));
function fixture(text,ranges){
 const bytes=Buffer.from(text),utf16ToUtf8=Array(text.length+1).fill(-1),utf8ToUtf16=Array(bytes.length+1).fill(-1);
 let at=0,offset=0;for(const character of text){utf16ToUtf8[at]=offset;utf8ToUtf16[offset]=at;at+=character.length;offset+=Buffer.byteLength(character);}utf16ToUtf8[at]=offset;utf8ToUtf16[offset]=at;
 const layout={version:'layout-1',policy:'text-layout-1',frame,
  indexConvention:'half-open; UTF-16 native; UTF-8 shaped offsets; -1 scalar interiors; downstream at start/upstream at end',utf16ToUtf8,utf8ToUtf16,
  lineHeightPolicy:'max-supplied-font-metrics-times-multiplier; symmetric-leading; native-rounded-baselines',fontMetrics:[{hash:font,ascent:-12,descent:4,leading:0}],intrinsicHeight:16,requestedLineHeight:16,logicalLines:1,
  paragraphs:[{startUtf16:0,endUtf16:text.length,startUtf8:0,endUtf8:bytes.length,top:0,height:16,direction:'ltr',
   lines:[{baseline:12,ascent:12,descent:4,height:16,width:20,left:0,lineNumber:0,isHardBreak:false,startUtf8:0,endUtf8:bytes.length,startUtf16:0,endUtf16:text.length,endExcludingWhitespacesUtf16:text.length,endIncludingNewlineUtf16:text.length,endExcludingWhitespacesUtf8:bytes.length,endIncludingNewlineUtf8:bytes.length}],
   runs:[{fontHash:font,size:16,flags:0,glyphs:[1],offsetsUtf8:[0,bytes.length],offsetsUtf16:[0,text.length],positions:[0,0,20,0],inkBounds:[[0,0,20,16]],top:0,bottom:16,baseline:12}],
   clusters:ranges.map(([start,end])=>({startUtf16:start,endUtf16:end,startUtf8:utf16ToUtf8[start],endUtf8:utf16ToUtf8[end],direction:'ltr',rect:[0,0,20,16],ranges:[{rect:[0,0,20,16],direction:'ltr'}]}))}],height:16,overflow:false};
 return {layout,bytes,validate:()=>validateLayout(source,encode(layout),bytes)};
}

test('layout scalar coverage accepts unordered overlapping and repeated native ranges',()=>{
 for(const ranges of [[[2,4],[0,3]],[[0,2],[0,2],[2,4]],[[3,4],[1,3],[0,1]]])assert.equal(fixture('abcd',ranges).validate(),'abcd');
 assert.equal(fixture('A😀ב',[[3,4],[0,3]]).validate(),'A😀ב');
 for(const ranges of [[[0,1],[2,4]],[[1,4]],[[0,3]]])assert.throws(()=>fixture('abcd',ranges).validate());
});

test('layout proof keeps exact schema, native geometry, glyph and index requirements',()=>{
 const mutations=[
  f=>{f.layout.extra=true;},
  f=>{f.layout.paragraphs[0].clusters[0].ranges={length:0};},
  f=>{f.layout.paragraphs[0].runs[0].glyphs[0]=0;},
  f=>{f.layout.paragraphs[0].runs[0].offsetsUtf16[0]='0';},
  f=>{f.layout.paragraphs[0].clusters[0].startUtf16=2;f.layout.paragraphs[0].clusters[0].startUtf8=-1;},
  f=>{f.layout.paragraphs[0].runs[0].positions[0]=null;},
  f=>{f.layout.utf16ToUtf8[2]=2;},
  f=>{f.layout.paragraphs[0].clusters[0].rect=[2,0,1,16];},
  f=>{f.layout.indexConvention='other';},
  f=>{f.layout.lineHeightPolicy={value:'other'};},
 ];
 for(const mutate of mutations){const f=fixture('A😀ב',[[0,4]]);mutate(f);assert.throws(f.validate);}
 const f=fixture('a',[[0,1]]),serialized=JSON.stringify(f.layout);
 assert.throws(()=>validateLayout(source,Buffer.from(serialized.replace('"version":','"version":"layout-1","version":')),f.bytes));
});

test('layout validation scans complete16KiB text with linear scalar coverage',()=>{
 const text='a'.repeat(16384),ranges=Array.from({length:text.length},(_,i)=>[text.length-i-1,text.length-i]);
 const f=fixture(text,ranges);assert.equal(f.validate(),text);
 assert.throws(()=>validateLayout(source,encode(f.layout),Buffer.from(text+'a')));
});

test('object-dense layout is refused before either JSON token strings or graph are parsed',()=>{
 const hostile=Buffer.from('{"paragraphs":['+'{},'.repeat(1600000)+'{}]}');
 assert(hostile.length<8388608);assert(layoutValidationBytes(hostile)>134217728);
 const original=JSON.parse;let called=false;
 try{JSON.parse=()=>{called=true;throw Error('unexpected JSON parse');};assert.throws(()=>validateLayout(source,hostile,Buffer.from('a')),/Invalid recovery data/);assert.equal(called,false);}
 finally{JSON.parse=original;}
});

test('portable unknown layout remains inspection-only while live schema stays strict',()=>{
 const f=fixture('a',[[0,1]]);f.layout.version='layout-2';const bytes=encode(f.layout);
 assert.throws(()=>validateLayout(source,bytes,f.bytes,{portable:true}),error=>error instanceof UnsupportedText&&error.message==='UNSUPPORTED_TEXT_LAYOUT');
 assert.throws(()=>validateLayout(source,bytes,f.bytes),error=>!(error instanceof UnsupportedText));
 const malformed=Buffer.from('{"version":"layout-2","version":"layout-1"}');
 assert.throws(()=>validateLayout(source,malformed,f.bytes,{portable:true}),error=>!(error instanceof UnsupportedText));
});
