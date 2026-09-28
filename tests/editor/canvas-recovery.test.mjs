import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';

const source=await readFile('src/ui/canvas-view.ts','utf8');
const code=(await transformWithOxc(source,'canvas-view.ts')).code;
const {CanvasView}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
test('canvas keeps current pixels across late, failed, cleared and disposed reads',async()=>{
 const previousBitmap=globalThis.createImageBitmap,previousRatio=globalThis.devicePixelRatio;
 const bitmaps=[],requests=[],draws=[];let next;
 globalThis.createImageBitmap=async blob=>{const bitmap={id:await blob.text(),closed:0,close(){this.closed++;}};bitmaps.push(bitmap);return bitmap;};globalThis.devicePixelRatio=1;
 const ctx=new Proxy({drawImage:image=>{assert.equal(image.closed,0);draws.push(image.id);}},{get:(target,key)=>target[key]??(()=>{})});
 const canvas={width:20,height:20,dataset:{},getBoundingClientRect:()=>({width:20,height:20}),getContext:()=>ctx};
 const view=new CanvasView(canvas,path=>{requests.push(path);return new Promise((resolve,reject)=>next={resolve,reject});});
 const draw=()=>{draws.length=0;view.draw(1,0,0);return {asset:canvas.dataset.asset,images:[...draws]};};
 try{
  const first=view.show('first',2,2),old=next,current=view.show('current',2,2);next.resolve(new Response('current'));await current;assert.deepEqual(draw(),{asset:'current',images:['current']});
  old.resolve(new Response('late-first'));await first;assert.equal(bitmaps.find(x=>x.id==='late-first').closed,1);assert.deepEqual(draw(),{asset:'current',images:['current']});assert.equal(requests.length,2);
  const refused=view.show('retry',2,2);next.resolve(new Response('unavailable',{status:503}));await assert.rejects(refused,/CANVAS_CONTENT_UNAVAILABLE/);assert.deepEqual(draw(),{asset:'current',images:['current']});
  const retried=view.show('retry',2,2);next.resolve(new Response('retry'));await retried;assert.deepEqual(draw(),{asset:'retry',images:['retry']});assert.equal(bitmaps.find(x=>x.id==='current').closed,1);assert.equal(requests.filter(x=>x.endsWith('/retry/content')).length,2);
  const stale=view.show('cleared',2,2),clear=next;await view.show(null,0,0);clear.resolve(new Response('late-cleared'));await stale;assert.deepEqual(draw(),{asset:'',images:[]});assert.equal(bitmaps.find(x=>x.id==='late-cleared').closed,1);
  const rejected=view.show('network',2,2);next.reject(Error('network failed'));await assert.rejects(rejected,/network failed/);const recovered=view.show('network',2,2);next.resolve(new Response('recovered'));await recovered;assert.deepEqual(draw(),{asset:'network',images:['recovered']});
  const abandoned=view.show('disposed',2,2);view.dispose();next.resolve(new Response('late-disposed'));await abandoned;assert.equal(bitmaps.find(x=>x.id==='late-disposed').closed,1);assert.equal(bitmaps.find(x=>x.id==='recovered').closed,1);
  assert(bitmaps.every(x=>x.closed===1));
 }finally{view.dispose();globalThis.createImageBitmap=previousBitmap;globalThis.devicePixelRatio=previousRatio;}
});
