import test from 'node:test';
import assert from 'node:assert/strict';
import {authoredCoverage,featherRows,validateMaskPlan} from '../../dist/local/src/raster/mask.js';
import {feather} from '../../dist/local/src/raster/core.js';
const shape=(kind,x,y,width,height,mode='replace')=>({kind:'shape',shape:{kind,x,y,width,height},mode});
const plan=operations=>({width:12,height:5,feather:2,operations});
test('mask pixel-center rectangle/ellipse/polygon, explicit combinations and stroke hardness',()=>{
 const rect=authoredCoverage(plan([shape('rectangle',4,0,4,5)]));assert.deepEqual(Array.from({length:12},(_,x)=>rect.get(x,2)),[0,0,0,0,65535,65535,65535,65535,0,0,0,0]);
 const poly=authoredCoverage(plan([{kind:'shape',shape:{kind:'polygon',points:[[4,0],[8,0],[8,5],[4,5]]},mode:'replace'}]));for(let y=0;y<5;y++)for(let x=0;x<12;x++)assert.equal(poly.get(x,y),rect.get(x,y));
 const ell=authoredCoverage(plan([shape('ellipse',4,0,4,4)]));assert.equal(ell.get(4,0),0);assert.equal(ell.get(5,1),65535);
 const sub=authoredCoverage(plan([shape('rectangle',4,0,4,5),shape('rectangle',5,0,1,5,'subtract')]));assert.equal(sub.get(5,2),0);assert.equal(sub.get(6,2),65535);
 const intersection=authoredCoverage(plan([shape('rectangle',4,0,4,5),shape('rectangle',5,0,1,5,'intersect')]));assert.equal(intersection.get(5,2),65535);assert.equal(intersection.get(6,2),0);
 const brush=authoredCoverage(plan([{kind:'stroke',points:[[2.5,2.5],[5.5,2.5]],size:4,hardness:0,mode:'add'}]));assert.equal(brush.get(3,2),65535);assert.equal(brush.get(3,1),32768);assert.equal(brush.get(3,0),0);
 const inverted=authoredCoverage(plan([{kind:'fill'},{kind:'invert'}]));assert.equal(inverted.get(0,0),0);assert.equal(inverted.get(-1,0),0);
});
test('finite feather exact support, R16 edge16384, no document-edge renormalization or extra quantization',()=>{
 const p=plan([shape('rectangle',4,0,4,5)]),source=authoredCoverage(p),rows=featherRows(source,2);assert.deepEqual([...rows(2)],[0,0,0,16384,49151,65535,65535,49151,16384,0,0,0]);
 for(const radius of [0,.5,1,1.5,2,3,4,64]){const row=featherRows(source,radius),expected=feather(source,{x:0,y:0,width:12,height:5},radius);for(let y=0;y<5;y++)assert.deepEqual([...row(y)],[...expected.slice(y*12,(y+1)*12)],'radius '+radius+' row '+y);}
 const full=authoredCoverage(plan([{kind:'fill'}]));assert.equal(featherRows(full,2)(0)[0],36863);
});
test('invalid geometry and radius are refused without truncating drafts',()=>{
 for(const feather of [-1,65,NaN])assert.throws(()=>validateMaskPlan({...plan([]),feather}));
 assert.throws(()=>validateMaskPlan(plan([{kind:'shape',shape:{kind:'polygon',points:[[0,0],[1,1]]},mode:'replace'}])));
});
