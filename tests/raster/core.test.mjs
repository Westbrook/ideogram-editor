import test from 'node:test';
import assert from 'node:assert/strict';
import {contribution,composite,preserve,feather,inverse,coefficient,footprint,maskCoverage,IDENTITY,extent} from '../../dist/local/src/raster/core.js';
const U=a=>Uint8Array.from(a);
const source=(width,height,rgba)=>({width,height,get(x,y,p){p.fill(0);if(x>=0&&y>=0&&x<width&&y<height)p.set(rgba.slice((y*width+x)*4,(y*width+x)*4+4));}});
const rect=(width,height=1,x=0,y=0)=>({x,y,width,height});
test('F01 independent literal: stage2 alpha26, exact shared composite90 and F04 108 versus109',()=>{
 const white=source(1,1,[255,255,255,255]),black=U([0,0,0,255]);
 const k=contribution(white,rect(1),IDENTITY,.1);assert.deepEqual(k,U([255,255,255,26]));
 assert.deepEqual(composite([black,k],4),U([90,90,90,255]));
 const replacement=contribution(source(1,1,k),rect(1),IDENTITY,1);assert.deepEqual(replacement,k);
 assert.deepEqual(composite([black,replacement],4),U([90,90,90,255]));
 const overlay=U([255,255,255,14]);assert.deepEqual(composite([black,k,overlay],4),U([108,108,108,255]));
 assert.deepEqual(composite([U([90,90,90,255]),overlay],4),U([109,109,109,255]));
});
test('empty, hidden RGB, singleton, integer translation, M0 and nonidentity alpha-zero arithmetic',()=>{
 const hidden=U([17,99,231,0,255,0,0,128]);const s=source(2,1,hidden);
 assert.deepEqual(preserve(new Uint8Array(8),hidden,new Uint16Array([65535,65535])),hidden);
 assert.deepEqual(composite([],8),new Uint8Array(8));assert.deepEqual(composite([hidden],8),hidden);
 assert.deepEqual(contribution(s,rect(2),IDENTITY,1),hidden);
 assert.deepEqual(contribution(s,rect(3),[1,0,0,1,1,0],1),U([0,0,0,0,...hidden]));
 assert.deepEqual(contribution(s,rect(2),IDENTITY,0),new Uint8Array(8));
 assert.deepEqual(contribution(s,rect(1),IDENTITY,.5),new Uint8Array(4));
 assert.deepEqual(preserve(hidden,U([255,255,255,255,0,0,255,128]),new Uint16Array([0,65535])),U([17,99,231,0,0,0,255,128]));
});
test('independent half-pixel bilinear, linear light, transparent padding and premultiplied edge goldens',()=>{
 const s=source(2,1,[255,0,0,255,0,0,255,255]);
 assert.deepEqual(contribution(s,rect(3),[1,0,0,1,.5,0],1),U([255,0,0,128,188,0,188,255,0,0,255,128]));
 const hidden=source(2,1,[255,0,0,0,0,0,255,255]);
 assert.deepEqual(contribution(hidden,rect(1,1,1),[1,0,0,1,.5,0],1),U([0,0,255,128]));
 assert.deepEqual(contribution(s,rect(2),[-1,0,0,1,2,0],1),U([0,0,255,255,255,0,0,255]));
});
test('area-integrated triangle coefficients are independently derived rational constants; no boundary renormalization',()=>{
 assert.equal(coefficient(1,0,2),7/16);assert.equal(coefficient(1,1,2),7/16);assert.equal(coefficient(1,2,2),1/16);assert.equal(coefficient(1,-1,2),1/16);
 assert.deepEqual(contribution(source(2,1,[255,0,0,255,0,0,255,255]),rect(1),[.5,0,0,1,0,0],1),U([188,0,188,223]));
 assert.deepEqual(contribution(source(4,1,Array(4).fill([255,255,255,255]).flat()),rect(2),[.5,0,0,1,0,0],1),U([255,255,255,239,255,255,255,239]));
 assert.ok(footprint(rect(1),[.5,0,0,1,0,0]).width>=4);
});
test('transform-mask-opacity ordering and R16 luminance-alpha are explicit',()=>{
 const s=source(1,1,[255,255,255,255]);const m={width:1,height:1,get:()=>32768};
 assert.deepEqual(contribution(s,rect(1),IDENTITY,.1,m),U([255,255,255,13]));
 assert.equal(maskCoverage([255,255,255,128]),32896);assert.equal(maskCoverage([255,0,0,255]),13933);
});
test('F02 core triangle feather: exact R16 edges, no tile renormalization, radii0/1/2/64',()=>{
 const coverage={width:12,height:1,get:(x,y)=>y===0&&x>=4&&x<8?65535:0};
 // Use a vertically infinite strip to isolate the independently specified 1D row.
 const strip={...coverage,get:x=>x>=4&&x<8?65535:0};
 assert.deepEqual([...feather(strip,rect(12),2)],[0,0,0,16384,49151,65535,65535,49151,16384,0,0,0]);
 for(const radius of [0,1])assert.deepEqual([...feather(strip,rect(12),radius)],[0,0,0,0,65535,65535,65535,65535,0,0,0,0]);
 const impulse={width:1,height:1,get:(x,y)=>x===0&&y===0?65535:0};assert.deepEqual([...feather(impulse,rect(1),2)],[16384]);
 // radius64 normalized triangular sum64: center2D weight1/4096.
 assert.deepEqual([...feather(impulse,rect(1),64)],[16]);
 const full=feather(coverage,rect(12),2),split=new Uint16Array(12);split.set(feather(coverage,rect(5),2));split.set(feather(coverage,rect(7,1,5),2),5);assert.deepEqual(split,full);
});
test('affine coordinates, bounded envelope and independent seam output at128/512',()=>{
 for(const m of [[0,0,0,0,0,0],[NaN,0,0,1,0,0],[1,0,0,Infinity,0,0]])assert.throws(()=>inverse(m));
 for(const dims of [[8193,1],[5001,5000],[0,1]])assert.throws(()=>extent(...dims));extent(8192,3051);extent(5000,5000);
 const m=[2,.5,-.25,3,7,-9],inv=inverse(m),x=20.5,y=40.5,dx=m[0]*x+m[2]*y+m[4],dy=m[1]*x+m[3]*y+m[5];assert.ok(Math.abs(inv[0]*dx+inv[2]*dy+inv[4]-x)<1e-9);assert.ok(Math.abs(inv[1]*dx+inv[3]*dy+inv[5]-y)<1e-9);
 const s=source(520,1,Array.from({length:520},(_,i)=>i%2?[0,0,255,255]:[255,0,0,255]).flat());
 for(const x of [127,128,129,511,512,513])assert.deepEqual(contribution(s,rect(1,1,x),[1,0,0,1,.5,0],1),U([188,0,188,255]));
});
