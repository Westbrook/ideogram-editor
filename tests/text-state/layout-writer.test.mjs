import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';

const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
async function source(path,replacements={}){
 let code=(await transformWithOxc(await readFile(path,'utf8'),path)).code;
 for(const [name,url]of Object.entries(replacements))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));
 return data(code);
}
const contracts=await source('src/text/contracts.ts');
const {LIMITS,TextFailure,hashBytes}=await import(contracts);
const writerURL=await source('src/text/layout-writer.ts',{'./contracts':contracts});
const {LayoutWriter,LAYOUT_CHUNK_BYTES}=await import(writerURL);
const admission=await source('src/text/admission.ts',{'./contracts':contracts});
const {textIndices}=await import(admission);

test('streamed JSON preserves property order, number spelling, sparse arrays and Unicode escaping',async()=>{
 const unicode=Array.from({length:65536},(_,i)=>String.fromCharCode(i)).join('');
 const value={z:-0,2:'second',1:'first',tiny:5e-324,large:1e21,decimal:1.0000000000000002,
  controls:'\b\t\n\f\r\u0000\u001f"\\/',unicode,
  boundary:'a'.repeat(8191)+'🙂'+'é'.repeat(32767)+'\ud800x\udfff',
  nested:[true,false,null,undefined,,{omitted:undefined,kept:'yes'}]};
 const writer=new LayoutWriter().value(value),expected=JSON.stringify(value),blob=writer.finishBlob();
 assert.equal(await blob.text(),expected);assert.equal(blob.size,Buffer.byteLength(expected));
 assert.equal(writer.byteLength,blob.size);assert.equal(blob.type,'application/json');
});

test('array projections stream native typed exports with trailing positions and offsets intact',async()=>{
 const offsets=new Uint32Array([3,0,7]),positions=new Float32Array([1.125,-0,2.5,3.75,5,8]);
 const writer=new LayoutWriter();
 writer.raw('{"offsets":').array(offsets,value=>writer.value(value+11))
  .raw(',"positions":').array(positions,(value,i)=>writer.value(value+(i%2?12.25:0))).raw('}');
 assert.equal(await writer.finishBlob().text(),JSON.stringify({offsets:Array.from(offsets,x=>x+11),positions:Array.from(positions,(x,i)=>x+(i%2?12.25:0))}));
});

test('UTF-8 output uses chunks of at most 64 KiB, including multibyte scalars at chunk boundaries',async()=>{
 const NativeBlob=globalThis.Blob,parts=[];
 globalThis.Blob=class extends NativeBlob {constructor(values,options){parts.push(...values.map(value=>({bytes:value.byteLength,isBytes:value instanceof Uint8Array})));super(values,options);}};
 try {
  const value='a'.repeat(65533)+'🙂é漢'.repeat(30000),writer=new LayoutWriter().value(value),blob=writer.finishBlob();
  assert.equal(await blob.text(),JSON.stringify(value));assert(parts.length>2);
  assert(parts.every(part=>part.isBytes&&part.bytes>0&&part.bytes<=LAYOUT_CHUNK_BYTES));
  assert.equal(parts.reduce((n,part)=>n+part.bytes,0),blob.size);
 } finally {globalThis.Blob=NativeBlob;}
});

test('the exact 8 MiB ceiling accepts its final byte and refuses excess before mutating output',async()=>{
 const writer=new LayoutWriter().raw('"').raw('a'.repeat(LIMITS.layoutBytes-2)).raw('"');
 assert.equal(writer.byteLength,LIMITS.layoutBytes);
 assert.throws(()=>writer.raw(' '),error=>error instanceof TextFailure&&error.code==='TEXT_LAYOUT_SIZE');
 assert.equal(writer.byteLength,LIMITS.layoutBytes);const blob=writer.finishBlob();assert.equal(blob.size,LIMITS.layoutBytes);
 assert.throws(()=>writer.raw(''),/TEXT_LAYOUT_FINISHED/);assert.throws(()=>writer.finishBlob(),/TEXT_LAYOUT_FINISHED/);
});

test('a smaller admitted capacity is enforced in bytes before append, including surrogate pairs',async()=>{
 const writer=new LayoutWriter(5).raw('é');
 assert.throws(()=>writer.raw('🙂'),{code:'TEXT_LAYOUT_SIZE'});assert.equal(writer.byteLength,2);
 assert.equal(await writer.raw('xyz').finishBlob().text(),'éxyz');
 assert.throws(()=>new LayoutWriter(LIMITS.layoutBytes+1),{code:'TEXT_LAYOUT_SIZE'});
 for(const value of [Infinity,-Infinity,NaN,{nested:[1,Infinity]}])assert.throws(()=>new LayoutWriter().value(value),{code:'TEXT_NONFINITE_LAYOUT'});
});

const profile=data('export default {id:"test-layout-profile"};');
const bidi=await source('src/text/bidi.ts',{'./bidi-data.json':data('export default '+await readFile('src/text/bidi-data.json','utf8'))});
const coreURL=await source('src/text/core.ts',{
 './profile.json':profile,'./retained-profiles/7a4dbc6c.json':data('export default {id:"retained-streamed-profile"};'),'./retained-profiles/4fd6f6a1.json':data('export default {id:"retained-stable-stream-profile"};'),'./admission':admission,'./contracts':contracts,'./layout-writer':writerURL,'./bidi':bidi,
 './font':data('export function inspectFont(){return {format:"static-ttf",parserProfile:"fixture-parser",fsType:0};}'),
 './memory':data('export function planText(request,options){globalThis.__layoutTestPlans?.push(options);return {glyphs:64,runs:64,lines:64,rectangles:128,layout:globalThis.__layoutTestLimit??8388608};}'),
});
const {prepareText}=await import(coreURL);
const fontBytes=new Blob(['isolated serializer font']),fontHash=await hashBytes(fontBytes);
function fixture({inkOverflow=false,lineOverflow=false,nonfinite=false}={}){
 const events={draws:[],paragraphs:0,builders:0,faces:0,fonts:0,freeRects:0,surfaces:0,raster:0,collections:0,purges:0};
 const metrics={ascent:-8.5,descent:2.25,leading:1.5},face={};
 const request={token:{documentId:'doc',documentRevision:'1',layerId:'layer',layerVersion:'1',sessionId:'session',generation:1},text:'Aé\nאב',
  frame:{width:10,height:24.5},style:{primaryFont:fontHash,explicitFallbacks:[],sizePx:12,lineHeightMultiplier:1,fill:[20,30,40,255],align:'start',direction:'auto'},
  fonts:[{hash:fontHash,bytes:fontBytes,faceIndex:0,origin:'bundled',license:{hash:fontHash,embedding:'permitted'}}]};
 const run=(glyphs,offsets,positions)=>({glyphs:new Uint16Array(glyphs),offsets:new Uint32Array(offsets),positions:new Float32Array(positions),size:12,flags:2,
  typeface:{isAliasOf:value=>value===face,delete(){events.faces++;}}});
 const getRuns=text=>text==='Aé'?[run([11],[0,1],[0,8,1.5,8]),run([12],[1,3],[1.5,8,4,8])]:[run([13,14],[2,0,4],[2,8,0,8,4,8])];
 const lineMetric=text=>({baseline:8,ascent:8.5,descent:2.25,height:12.25,width:4,left:lineOverflow?-0.25:0,lineNumber:0,isHardBreak:true,
  startIndex:0,endIndex:text.length,endExcludingWhitespaces:text.length,endIncludingNewline:text.length});
 const bounds=glyphs=>Float32Array.from(Array.from(glyphs,()=>[inkOverflow?-2:0,-8,nonfinite?Infinity:1.5,2]).flat());
 const cluster=(text,index)=>({isEllipsis:false,graphemeClusterTextRange:{start:index,end:index+1},dir:{value:text==='Aé'?1:0},graphemeLayoutBounds:new Float32Array([index*1.5,0,(index+1)*1.5,10])});
 const ck={HEAPU8:new Uint8Array(1024),TRANSPARENT:[0,0,0,0],FontWeight:{Normal:400},FontWidth:{Normal:5},FontSlant:{Upright:0},FontHinting:{None:0},
  TextAlign:{Left:0,Center:1,Right:2,Start:3,End:4},TextDirection:{RTL:{value:0},LTR:{value:1}},RectHeightStyle:{Tight:0},RectWidthStyle:{Tight:0},
  ColorType:{RGBA_8888:0},AlphaType:{Unpremul:0},ColorSpace:{SRGB:0},ClipOp:{Intersect:0},Color:(...values)=>values,LTRBRect:(...values)=>values,
  TypefaceFontProvider:{Make:()=>({registerFont(){},matchFamilyStyle:()=>face,countFamilies:()=>1})},
  FontCollection:{Make:()=>({setDefaultFontManager(){},delete(){events.collections++;}})},
  Font:class {setHinting(){}setSubpixel(){}getMetrics(){return metrics;}getGlyphBounds(glyphs){return bounds(glyphs);}delete(){events.fonts++;}},
  ParagraphStyle:class {constructor(value){Object.assign(this,value);}},
  ParagraphBuilder:{MakeFromFontCollection:()=>{let text;return {addText(value){text=value;},build(){return {
   layout(){},getHeight:()=>12.25,getNumberOfLines:()=>1,unresolvedCodepoints:()=>[],getLineMetrics:()=>[lineMetric(text)],
   getShapedLinesBounded:()=>[{top:-0.5,bottom:10.25,baseline:8,runs:getRuns(text)}],getGlyphInfoAt:index=>cluster(text,index),
   getRectsForRangeBounded:(start,end)=>new Float32Array([start*1.5,0,end*1.5,10,text==='Aé'?1:0]),delete(){events.paragraphs++;},
  };},delete(){events.builders++;}};}},
  Malloc:(type,length)=>{const pixels=new type(length);pixels.set([8,9,10,0,1,2,3,255]);return {byteOffset:16,toTypedArray:()=>pixels};},
  MakeRasterDirectSurface:()=>({getCanvas:()=>({clear(){},clipRect(){},drawParagraph:(paragraph,x,y)=>events.draws.push([x,y])}),flush(){},delete(){events.surfaces++;}}),
  Free(){events.raster++;},_free(){events.freeRects++;},purgeOwnedTextCaches(){events.purges++;},
 };
 function expected(){
  const global=textIndices(request.text);let top=0,start16=0;
  const paragraphs=request.text.split('\n').map(text=>{
   const local=textIndices(text),start8=global.utf16ToUtf8[start16],utf8=i=>start8+local.utf16ToUtf8[i],utf16=b=>start16+local.utf8ToUtf16[b],m=lineMetric(text);
   const lines=[{baseline:m.baseline+top,ascent:m.ascent,descent:m.descent,height:m.height,width:m.width,left:m.left,lineNumber:m.lineNumber,isHardBreak:m.isHardBreak,
    startUtf8:utf8(m.startIndex),endUtf8:utf8(m.endIndex),startUtf16:start16+m.startIndex,endUtf16:start16+m.endIndex,endExcludingWhitespacesUtf16:start16+m.endExcludingWhitespaces,
    endIncludingNewlineUtf16:start16+m.endIncludingNewline,endExcludingWhitespacesUtf8:utf8(m.endExcludingWhitespaces),endIncludingNewlineUtf8:utf8(m.endIncludingNewline)}];
   const runs=getRuns(text).map(run=>{const b=bounds(run.glyphs);return {fontHash,size:12,flags:2,glyphs:Array.from(run.glyphs),offsetsUtf8:Array.from(run.offsets,x=>x+start8),offsetsUtf16:Array.from(run.offsets,utf16),
    positions:Array.from(run.positions,(v,i)=>v+(i%2?top:0)),inkBounds:Array.from(run.glyphs,(_,i)=>[b[i*4]+run.positions[i*2],b[i*4+1]+run.positions[i*2+1]+top,b[i*4+2]+run.positions[i*2],b[i*4+3]+run.positions[i*2+1]+top]),top:-0.5+top,bottom:10.25+top,baseline:8+top};});
   const clusters=local.scalars.map(s=>{const i=s.utf16,rect=[i*1.5,top,(i+1)*1.5,10+top],direction=text==='Aé'?'ltr':'rtl';return {startUtf16:start16+i,endUtf16:start16+i+1,startUtf8:utf8(i),endUtf8:utf8(i+1),direction,rect,ranges:[{rect,direction}]};});
   const result={startUtf16:start16,endUtf16:start16+text.length,startUtf8:start8,endUtf8:start8+local.bytes,top,height:12.25,direction:text==='Aé'?'ltr':'rtl',lines,runs,clusters};top+=12.25;start16+=text.length+1;return result;
  });
  return {version:'layout-1',policy:'text-layout-1',frame:request.frame,indexConvention:'half-open; UTF-16 native; UTF-8 shaped offsets; -1 scalar interiors; downstream at start/upstream at end',
   utf16ToUtf8:global.utf16ToUtf8,utf8ToUtf16:global.utf8ToUtf16,lineHeightPolicy:'max-supplied-font-metrics-times-multiplier; symmetric-leading; native-rounded-baselines',
   fontMetrics:[{hash:fontHash,...metrics}],intrinsicHeight:12.25,requestedLineHeight:12.25,logicalLines:2,paragraphs,height:24.5,overflow:inkOverflow||lineOverflow};
 }
 return {request,ck,events,expected};
}

for(const mode of [{},{inkOverflow:true},{lineOverflow:true}])test('actual core preserves legacy layout bytes, translated ink and overflow '+JSON.stringify(mode),async()=>{
 const f=fixture(mode),result=await prepareText(f.request,f.ck),expected=JSON.stringify(f.expected());
 assert.equal(await result.layout.text(),expected);assert.equal(result.layoutHash,await hashBytes(new Blob([expected])));
 assert.equal(result.allocation.layoutBytes,Buffer.byteLength(expected));assert.equal(result.overflow,Boolean(mode.inkOverflow||mode.lineOverflow));
 assert.deepEqual(f.events.draws,[[0,0],[0,12.25]]);assert.deepEqual(Array.from(new Uint8Array(await result.rgba.arrayBuffer()).slice(0,8)),[0,0,0,0,1,2,3,255]);
 assert.deepEqual({...f.events,draws:undefined},{draws:undefined,paragraphs:2,builders:2,faces:3,fonts:4,freeRects:4,surfaces:1,raster:1,collections:1,purges:1});
});

test('actual core refuses nonfinite native ink and releases the active native owners',async()=>{
 const f=fixture({nonfinite:true});await assert.rejects(prepareText(f.request,f.ck),{code:'TEXT_NONFINITE_LAYOUT'});
 assert.equal(f.events.faces,2);assert.equal(f.events.paragraphs,1);assert.equal(f.events.builders,1);assert.equal(f.events.fonts,2);
 assert.equal(f.events.surfaces,1);assert.equal(f.events.raster,1);assert.equal(f.events.collections,1);assert.equal(f.events.purges,1);
});

test('actual core uses the admitted output capacity rather than the global ceiling',async()=>{
 const f=fixture();globalThis.__layoutTestLimit=256;
 try {await assert.rejects(prepareText(f.request,f.ck),{code:'TEXT_LAYOUT_SIZE'});}
 finally {delete globalThis.__layoutTestLimit;}
 assert.equal(f.events.surfaces,1);assert.equal(f.events.raster,1);assert.equal(f.events.collections,1);assert.equal(f.events.purges,1);
});

test('actual core fixes frame field order across browser and canonical server requests',async()=>{
 const browser=fixture(),server=fixture();server.request.frame={height:browser.request.frame.height,width:browser.request.frame.width};
 assert.notDeepEqual(Object.keys(browser.request.frame),Object.keys(server.request.frame));
 const a=await prepareText(browser.request,browser.ck),b=await prepareText(server.request,server.ck);
 assert.equal(await b.layout.text(),await a.layout.text());assert.equal(b.layoutHash,a.layoutHash);assert.equal(b.rasterHash,a.rasterHash);assert.equal(b.dependencyHash,a.dependencyHash);
 assert((await a.layout.text()).startsWith('{"version":"layout-1","policy":"text-layout-1","frame":{"width":10,"height":24.5}'));
});
test('retained streamed profile can reproduce either original frame key order',async()=>{
 const a=fixture(),b=fixture();b.request.frame={height:a.request.frame.height,width:a.request.frame.width};
 const left=await prepareText(a.request,a.ck,'retained-streamed-profile'),right=await prepareText(b.request,b.ck,'retained-streamed-profile');
 assert.notEqual(left.layoutHash,right.layoutHash);assert.equal(left.rasterHash,right.rasterHash);assert.deepEqual(JSON.parse(await left.layout.text()),JSON.parse(await right.layout.text()));
});

test('retained stable streamed profile preserves normalized frame bytes and streaming plan',async()=>{
 const browser=fixture(),server=fixture();server.request.frame={height:browser.request.frame.height,width:browser.request.frame.width};
 const plans=[];globalThis.__layoutTestPlans=plans;
 try{
  const a=await prepareText(browser.request,browser.ck,'retained-stable-stream-profile'),b=await prepareText(server.request,server.ck,'retained-stable-stream-profile');
  assert.deepEqual(plans,[{legacy:false},{legacy:false}]);assert.equal(await a.layout.text(),await b.layout.text());assert.equal(a.layoutHash,b.layoutHash);assert.equal(a.rasterHash,b.rasterHash);assert.equal(a.dependencyHash,b.dependencyHash);
  assert((await a.layout.text()).startsWith('{"version":"layout-1","policy":"text-layout-1","frame":{"width":10,"height":24.5}'));
 }finally{delete globalThis.__layoutTestPlans;}
});
