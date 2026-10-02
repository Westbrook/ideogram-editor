import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
async function module(path,replacements={}){let code=(await transformWithOxc(await readFile(path,'utf8'),path)).code;for(const [name,url]of Object.entries(replacements))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));return data(code);}
const budgetURL=await module('src/protocol/text-budget.ts'),contractsURL=await module('src/text/contracts.ts');
const admissionURL=await module('src/text/admission.ts',{'./contracts':contractsURL});
const profile=JSON.parse(await readFile('src/text/profile.json','utf8'));
const diagnosticMemoryURL=await module('src/observability/diagnostic-memory.ts');
const memoryURL=await module('src/text/memory.ts',{'./admission':admissionURL,'./contracts':contractsURL,'./profile.json':data('const profile='+JSON.stringify(profile)+';export default profile;export const engine=profile.engine;'),'../protocol/text-budget':budgetURL,'../observability/diagnostic-memory.js':diagnosticMemoryURL});
const {verificationBudget,textWorkspaceBudget}=await import(budgetURL),{planText,textMemory,registerFontBacking,engineResidentBytes}=await import(memoryURL);
const CAP=128*1024**2,WASM=4979358,FONTS=11445884;
const maxLines=Array.from({length:256},(_,i)=>'A'.repeat(i===255?64:63)).join('\n');
function request(text,bytes){const hash='sha256:'+'a'.repeat(64);return {text,frame:{width:360,height:180},token:{documentId:'document',documentRevision:'1',layerId:'layer',layerVersion:'1',sessionId:'session',generation:1},style:{primaryFont:hash,explicitFallbacks:[],sizePx:32,lineHeightMultiplier:1.2,fill:[40,90,190,255],align:'start',direction:'auto'},fonts:[{hash,bytes,faceIndex:0,origin:'local-file',license:{hash:'sha256:'+'b'.repeat(64),embedding:'permitted'}}]};}
test('16KiB with 256 logical lines gets a bounded workspace, not a 272MiB presumed layout',()=>{assert.equal(Buffer.byteLength(maxLines),16384);const budget=verificationBudget(maxLines,360,180,569208,WASM);assert(budget.layout<=8*1024**2);assert(budget.workspace>0);assert(budget.bytes+569208+65536<=CAP);assert.throws(()=>verificationBudget(maxLines,360,180,569208,WASM,{legacy:true}),/TEXT_VERIFICATION_CAPACITY/);});
for(const length of [13981,13982,16384])test('all 16 corpus font backings remain charged for '+length+' ASCII bytes',()=>{const text='A'.repeat(length),budget=verificationBudget(text,360,180,FONTS,WASM);assert(budget.bytes+FONTS+65536<=CAP);assert(budget.layout>6*1024**2&&budget.layout<=8*1024**2);assert.equal(budget.scratch,2*1024**2);});
test('browser and verifier share the exact output/workspace quotas and loader ownership does not mint capacity',()=>{const bytes=new Blob([new Uint8Array(FONTS)]),q=request(maxLines,bytes),plain=planText(q),budget=verificationBudget(q.text,360,180,FONTS,WASM);assert.equal(plain.layout,budget.layout);assert.equal(plain.workspace,budget.workspace);assert(plain.bytes+engineResidentBytes<=CAP);registerFontBacking(bytes);const input=textMemory.reserve(FONTS);try{const owned=planText(q);assert.equal(owned.layout,plain.layout);assert.equal(owned.bytes+FONTS,plain.bytes);const running=textMemory.reserve(owned.bytes+engineResidentBytes);running.release();}finally{input.release();}assert.equal(textMemory.snapshot.textBytes,0);});
test('expansion and native export quotas fit the separately reserved workspace',()=>{const s=16384,plan=textWorkspaceBudget(s,{scalars:s,bytes:s,lines:256},360,180,FONTS,WASM);assert.equal(plan.glyphs,8*s);assert(plan.runs>=1024&&plan.lines>=1024);assert.equal(plan.workspace,30*plan.glyphs+1024*plan.runs+512*plan.lines+262144);assert(plan.layout<8*1024**2,'Font-heavy max input lowers output capacity instead of overbooking');});
test('small CJK keeps existing font headroom',()=>{const budget=verificationBudget('中文',120,70,16437364,WASM);assert(budget.bytes+16472991<=CAP);});
for(const [label,args]of [
 ['text byte cap',['A'.repeat(16385),360,180,569208,WASM]],['line cap',['\n'.repeat(256),360,180,569208,WASM]],
 ['unpaired surrogate',['\ud800',360,180,569208,WASM]],['negative font bytes',['A',360,180,-1,WASM]],
 ['oversized raster',['A'.repeat(16384),8192,8192,67108864,WASM]],['nonfinite dimensions',['A',NaN,180,569208,WASM]],
])test('refuses '+label+' before allocation',()=>assert.throws(()=>verificationBudget(...args),/TEXT_VERIFICATION_CAPACITY/));
test('legacy comparison books actual retained bytes before its canonical fallback',()=>{const small=verificationBudget('A',360,180,569208,WASM,{legacy:true}),large=verificationBudget('A',360,180,569208,WASM,{legacy:true,layoutBytes:4*1024**2});assert(large.bytes>small.bytes);assert.equal(large.layout,4*1024**2);assert.throws(()=>verificationBudget('A',360,180,569208,WASM,{legacy:true,layoutBytes:8*1024**2+1}),/TEXT_VERIFICATION_CAPACITY/);});
test('retained renderer profiles retain their original native fragmentation quotas',()=>{const q=request('A'.repeat(480),new Blob([new Uint8Array(569208)])),current=planText(q),legacy=planText(q,{legacy:true});assert.equal(legacy.glyphs,3840);assert.equal(legacy.runs,legacy.glyphs);assert.equal(legacy.lines,legacy.glyphs);assert.equal(legacy.workspace,0);assert(current.runs<legacy.runs);assert(legacy.layout<=8*1024**2);});

const {scanDraftText,planTextSplit}=await import(await module('src/text/split.ts'));
function splitRanges(text,maxParts){
 const ranges=planTextSplit(text,maxParts),encoded=Buffer.from(text),pieces=[];let start16=0,startByte=0;assert(ranges.length>0&&ranges.length<=100);
 for(const range of ranges){const part=text.slice(range.start16,range.end16),bytes=Buffer.from(part);assert.deepEqual(range,{startByte,endByte:startByte+bytes.length,start16,end16:start16+part.length,bytes:bytes.length,lines:part.split('\n').length});assert(range.end16>range.start16);assert(range.bytes<=16384);assert(range.lines<=256);assert.equal(scanDraftText(part).validUnicode,true);assert.deepEqual(encoded.subarray(range.startByte,range.endByte),bytes);pieces.push(bytes);start16=range.end16;startByte=range.endByte;}
 assert.equal(start16,text.length);assert.equal(startByte,encoded.length);assert.deepEqual(Buffer.concat(pieces),encoded);assert.equal(ranges.map(r=>text.slice(r.start16,r.end16)).join(''),text);
 const cuts=new Set(ranges.slice(0,-1).map(r=>r.end16));for(const part of new Intl.Segmenter('und',{granularity:'grapheme'}).segment(text))cuts.delete(part.index);assert.equal(cuts.size,0,'Every interior cut is an extended-grapheme boundary');return ranges;
}
test('draft usage counts the complete native string without normalizing or replacing Unicode',()=>{
 assert.deepEqual(scanDraftText(''),{bytes:0,lines:1,scalars:0,validUnicode:true,requiresLFConversion:false});
 assert.deepEqual(scanDraftText('Aé中😀é\n'),{bytes:14,lines:2,scalars:7,validUnicode:true,requiresLFConversion:false});
 assert.deepEqual(scanDraftText('a\r\nb\rc'),{bytes:6,lines:2,scalars:6,validUnicode:true,requiresLFConversion:true});
 assert.deepEqual(scanDraftText('\ud800A\udc00'),{bytes:7,lines:1,scalars:3,validUnicode:false,requiresLFConversion:false});
 assert.deepEqual(scanDraftText('\ufeff'+('x'.repeat(70000))),{bytes:70003,lines:1,scalars:70001,validUnicode:true,requiresLFConversion:false});
});
test('text split preserves exact 16KiB admission and multibyte overflow without normalization',()=>{
 assert.equal(splitRanges('é'.repeat(8192)).length,1);const ranges=splitRanges('é'.repeat(8193));assert.deepEqual(ranges.map(r=>[r.bytes,r.end16]),[[16384,8192],[2,8193]]);
 assert.equal(splitRanges('x'.repeat(16384)).length,1);assert.deepEqual(splitRanges('x'.repeat(16385)).map(r=>r.bytes),[16384,1]);
});
test('text split distinguishes 256 and 257 logical lines and retains the trailing LF',()=>{
 const at='x\n'.repeat(255),over=at+'x\n';assert.equal(scanDraftText(at).lines,256);assert.equal(splitRanges(at).length,1);assert.equal(scanDraftText(over).lines,257);assert.deepEqual(splitRanges(over).map(r=>[r.bytes,r.lines]),[[510,256],[2,2]]);
});
test('text split prefers the last complete LF then cuts a long tail losslessly',()=>{
 const text='header\n'+'x'.repeat(32769),ranges=splitRanges(text);assert.deepEqual(ranges.map(r=>[r.bytes,r.lines]),[[7,2],[16384,1],[16384,1],[1,1]]);assert.equal(text.slice(0,ranges[0].end16),'header\n');
});
for(const [label,cluster]of [['combining','é'],['ZWJ','👩‍👩‍👧‍👦'],['regional indicators','🇯🇵']])test('text split keeps '+label+' clusters whole at the byte boundary',()=>{
 const prefix='x'.repeat(16383),text=prefix+cluster+'z',ranges=splitRanges(text);assert.equal(ranges.length,2);assert.equal(ranges[0].end16,prefix.length);assert.equal(text.slice(ranges[1].start16),cluster+'z');
});
test('text split accepts exactly the 1MiB document text budget',()=>{const text=('é'+'́'.repeat(8191)).repeat(64);assert.equal(Buffer.byteLength(text),1048576);const ranges=splitRanges(text);assert.equal(ranges.length,64);assert(ranges.every(r=>r.bytes===16384));});
test('text split accepts 100 parts and refuses a 101st even below the aggregate byte cap',()=>{assert.equal(splitRanges('\n'.repeat(25500)).length,100);assert.throws(()=>planTextSplit('\n'.repeat(25501)),/TEXT_SPLIT_LAYER_LIMIT/);});
for(const [label,text,code]of [
 ['empty draft','','TEXT_SPLIT_EMPTY'],['unpaired high surrogate','A\ud800','TEXT_SURROGATE'],['unpaired low surrogate','\udc00A','TEXT_SURROGATE'],['CRLF draft','A\r\nB','TEXT_REQUIRES_REVIEWED_LF_CONVERSION'],['bare CR draft','A\rB','TEXT_REQUIRES_REVIEWED_LF_CONVERSION'],['over 1MiB','x'.repeat(1048577),'TEXT_DOCUMENT_BYTES'],['indivisible combining cluster','A'+'́'.repeat(8192),'TEXT_SPLIT_GRAPHEME_LIMIT'],
])test('text split refuses '+label+' without a partial plan',()=>assert.throws(()=>planTextSplit(text),error=>error.message===code));

test('LF-preferred split retries tight grapheme packing instead of falsely refusing 101 half-full layers',()=>{const text=Array.from({length:101},()=> 'x'.repeat(8192)).join('\n'),ranges=splitRanges(text);assert.equal(Buffer.byteLength(text),827492);assert.equal(ranges.length,51);assert(ranges.slice(0,-1).every(range=>range.bytes===16384));});
test('split planning respects available combined-layer slots while preserving every byte',()=>{const text='header\n'+'x'.repeat(32769);assert.equal(splitRanges(text).length,4);assert.equal(splitRanges(text,3).length,3);assert.throws(()=>planTextSplit(text,2),/TEXT_SPLIT_LAYER_LIMIT/);for(const slots of [0,101,1.5])assert.throws(()=>planTextSplit('x',slots),/TEXT_SPLIT_LAYER_LIMIT/);});


for(const [label,text,paragraphs,nonempty,runs]of [
 ['65 nonempty paragraphs',Array(65).fill('A').join('\n'),65,65,128],
 ['256 nonempty paragraphs',Array(256).fill('A').join('\n'),256,256,319],
 ['a trailing LF at the logical-line limit','A\n'.repeat(255),256,255,319],
 ['256 blank paragraphs','\n'.repeat(255),256,0,319],
 ['mixed blank and nonempty paragraphs',Array.from({length:256},(_,index)=>index%2?'':'A').join('\n'),256,128,319],
])test('native run admission books '+label+' in browser and verifier plans',()=>{
 const fontBytes=569208,q=request(text,new Blob([new Uint8Array(fontBytes)])),plan=planText(q),budget=verificationBudget(text,360,180,fontBytes,WASM),logical=text.split('\n');assert.equal(logical.length,paragraphs);assert.equal(logical.filter(part=>part.length>0).length,nonempty);assert(plan.runs>=nonempty,'Every nonempty hard paragraph needs at least one native run');assert.equal(plan.runs,runs);assert(plan.runs<=plan.glyphs);assert(plan.lines>=paragraphs);assert.equal(plan.workspace,budget.workspace);assert.equal(plan.layout,budget.layout);assert.equal(plan.bytes-fontBytes,budget.request,'Verifier and browser book the same work while the caller retains its one font backing');assert(plan.layout>=16384&&plan.layout<=8*1024**2);assert(budget.bytes+fontBytes+65536<=CAP);
 const lease=textMemory.reserve(plan.bytes+engineResidentBytes);try{assert.equal(textMemory.snapshot.textBytes,plan.bytes+engineResidentBytes);assert(textMemory.snapshot.textBytes<=CAP);}finally{lease.release();}assert.equal(textMemory.snapshot.textBytes,0);
});
test('retained streamed profiles keep their exact pre-paragraph run and workspace quotas',()=>{
 const text='A\n'.repeat(255),fontBytes=569208,q=request(text,new Blob([new Uint8Array(fontBytes)])),current=planText(q),retained=planText(q,{retainedRunQuota:true}),backend=verificationBudget(text,360,180,fontBytes,WASM,{retainedRunQuota:true}),direct=textWorkspaceBudget(510,{scalars:510,bytes:510,lines:256},360,180,fontBytes,WASM,{retainedRunQuota:true});
 assert.deepEqual({glyphs:retained.glyphs,runs:retained.runs,lines:retained.lines,workspace:retained.workspace,layout:retained.layout},{glyphs:4080,runs:64,lines:256,workspace:581152,layout:8388608});assert.equal(current.runs,319);assert.equal(current.workspace,842272);assert.equal(current.workspace-retained.workspace,255*1024);assert.equal(current.layout,retained.layout);assert.equal(retained.workspace,backend.workspace);assert.equal(retained.layout,backend.layout);assert.equal(retained.bytes-fontBytes,backend.request);assert.equal(direct.runs,64);assert.equal(direct.workspace,581152);assert.equal(direct.layout,8388608);assert(backend.bytes+fontBytes+65536<=CAP);
});
test('one-paragraph current and retained budgets remain identical at empty, ordinary and 16KiB input sizes',()=>{
 for(const length of [0,480,16384]){const text='A'.repeat(length),q=request(text,new Blob([new Uint8Array(569208)]));assert.deepEqual(planText(q),planText(q,{retainedRunQuota:true}));assert.deepEqual(verificationBudget(text,360,180,569208,WASM),verificationBudget(text,360,180,569208,WASM,{retainedRunQuota:true}));}
});
test('full text and font inputs pay for every additional paragraph run without raising layout or memory caps',()=>{
 const q=request(maxLines,new Blob([new Uint8Array(FONTS)])),current=planText(q),retained=planText(q,{retainedRunQuota:true}),budget=verificationBudget(maxLines,360,180,FONTS,WASM),oldBudget=verificationBudget(maxLines,360,180,FONTS,WASM,{retainedRunQuota:true});assert.equal(retained.runs,2048);assert.equal(current.runs,2303);assert.equal(retained.workspace,8388608);assert.equal(current.workspace,8649728);assert.equal(current.workspace-retained.workspace,255*1024);assert.equal(retained.layout-current.layout,87040,'The extra workspace reduces the three-copy layout allowance');assert(current.layout>=16384&&current.layout<=8*1024**2);assert.equal(current.bytes,retained.bytes);assert.equal(budget.bytes,oldBudget.bytes);assert.equal(budget.workspace,current.workspace);assert.equal(budget.layout,current.layout);assert.equal(current.bytes-FONTS,budget.request);assert(budget.bytes+FONTS+65536<=CAP);assert(current.bytes+engineResidentBytes<=CAP);
});
