import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';
const path=process.env.CANDIDATE_COMPARISON_ROOT?process.env.CANDIDATE_COMPARISON_ROOT+'/src/ui/comparison-viewport.ts':new URL('../../src/ui/comparison-viewport.ts',import.meta.url);
const compiled=(await transformWithOxc(await readFile(path,'utf8'),'comparison-viewport.ts')).code;
const {comparisonRect,comparisonViewBox,parseComparisonView,comparisonPan}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));

test('shared viewport zoom crops exact original coordinates equally for both images',()=>{
 const frame={width:5000,height:4000},fit={zoom:100,x:0,y:0};
 assert.deepEqual(comparisonRect(frame,fit),{x:0,y:0,width:5000,height:4000});
 const zoom={...fit,zoom:200};assert.equal(comparisonViewBox(frame,zoom),'1250 1000 2500 2000');
 assert.deepEqual(comparisonPan(frame,zoom,'right'),{zoom:200,x:250,y:0});
 assert.equal(comparisonViewBox(frame,{zoom:200,x:250,y:-200}),'1500 800 2500 2000');
 assert.deepEqual(frame,{width:5000,height:4000});
});

test('invalid visible values cannot silently clamp or replace the accepted viewport',()=>{
 const frame={width:5000,height:4000};
 for(const fields of [{zoom:'',x:'0',y:'0'},{zoom:'NaN',x:'0',y:'0'},{zoom:'1601',x:'0',y:'0'},{zoom:'24',x:'0',y:'0'},{zoom:'100',x:'5001',y:'0'},{zoom:'100',x:'0',y:'-4001'},{zoom:'100',x:'1'.repeat(33),y:'0'}])assert.throws(()=>parseComparisonView(frame,fields));
 assert.deepEqual(parseComparisonView(frame,{zoom:'125',x:'0.25',y:'-1.5'}),{zoom:125,x:.25,y:-1.5});
 assert.throws(()=>comparisonRect({width:8193,height:3000},{zoom:100,x:0,y:0}));
});
