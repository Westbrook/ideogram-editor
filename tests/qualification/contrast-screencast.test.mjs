import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {captureWebKitContrast} from './contrast-screencast.mjs';

// Synthetic JPEG header/EOI contract fixture, deliberately not a decoded image
// or browser evidence. Actual visual usability remains a whole-browser check.
function jpeg(width=1440,height=1000){
  const data=Buffer.from([255,216,255,192,0,17,8,0,0,0,0,3,1,17,0,2,17,0,3,17,0,255,217]);
  data.writeUInt16BE(height,7);data.writeUInt16BE(width,9);return data;
}
function frame(data=jpeg(),extra={}){return {data,timestamp:Date.now(),viewportWidth:1440,viewportHeight:1000,...extra};}
function fixture(start,stop=async()=>{}){
  const calls={starts:0,stops:0,options:null};
  const page={screencast:{async start(options){calls.starts++;calls.options=options;await start(options);},async stop(){calls.stops++;await stop();}}};
  return {page,calls};
}
const capture=page=>captureWebKitContrast(page,{width:1440,height:1000,maximumWaitMs:100});

test('WebKit supplement rejects a cached frame and binds exact fresh JPEG bytes, dimensions and local ordinal',async()=>{
  const data=jpeg(),old=jpeg(2,2),f=fixture(async({onFrame})=>{onFrame(frame(old,{timestamp:Date.now()-10000}));onFrame(frame(data));});
  const r=await capture(f.page);assert.equal(r.metadata.status,'captured');assert.equal(r.data,data);
  assert.equal(r.metadata.frames.length,2);assert.equal(r.metadata.frames[0].reason,'cached-frame');
  assert.deepEqual(r.metadata.selected.encodedSize,{width:1440,height:1000});assert.equal(r.metadata.selected.ordinal,2);
  assert.equal(r.metadata.selected.sha256,createHash('sha256').update(data).digest('hex'));
  assert.deepEqual(r.metadata.selected.encodedPixelsPerCSSPixel,{x:1,y:1});assert.equal(r.metadata.stop,'fulfilled');
  assert.deepEqual(f.calls.options.size,{width:1440,height:1000});assert.equal(f.calls.options.quality,100);assert.equal(f.calls.stops,1);
  assert.equal(JSON.stringify(r.metadata).includes('"data"'),false);
  const snapshot=JSON.stringify(r.metadata);f.calls.options.onFrame(frame(jpeg()));assert.equal(JSON.stringify(r.metadata),snapshot);
});

test('Frame association refuses invalid/future clocks, viewport mismatch and encoded dimensions without retaining rejected buffers',async()=>{
  const cases=[['invalid-timestamp',frame(jpeg(),{timestamp:NaN})],['future-timestamp',frame(jpeg(),{timestamp:Date.now()+100000})],
    ['viewport-mismatch',frame(jpeg(),{viewportWidth:800})],['encoded-size-mismatch',frame(jpeg(800,600))],
    ['invalid-jpeg-header',frame(Buffer.from([255,216,1,2,255,217]))],['invalid-buffer',frame(new Uint8Array(16))]];
  for(const [reason,rejected]of cases){
    const f=fixture(async({onFrame})=>{onFrame({...rejected,...(!['invalid-timestamp','future-timestamp'].includes(reason)?{timestamp:Date.now()}:{})});onFrame(frame());});
    const r=await capture(f.page);assert.equal(r.metadata.frames[0].reason,reason);assert.equal(r.metadata.status,'captured');
    assert.equal(r.metadata.selected.ordinal,2);assert.equal(r.metadata.frames.some(row=>'data'in row),false);assert.equal(f.calls.stops,1);
  }
});

test('Image byte cap, frame count and even-size admission are hard capture bounds',async()=>{
  const large=fixture(async({onFrame})=>onFrame(frame(Buffer.alloc(65))));
  const capped=await captureWebKitContrast(large.page,{width:1440,height:1000,maximumBytes:64,maximumWaitMs:100});
  assert.equal(capped.metadata.status,'unknown-image-byte-cap');assert.equal(capped.data,null);assert.equal(capped.metadata.frames.length,1);assert.equal(large.calls.stops,1);
  const stale=fixture(async({onFrame})=>{for(let i=0;i<40;i++)onFrame(frame(jpeg(),{timestamp:1}));});
  const bounded=await capture(stale.page);assert.equal(bounded.metadata.status,'unknown-frame-cap');assert.equal(bounded.metadata.frames.length,32);assert.equal(bounded.data,null);
  for(const change of [{width:1439},{height:999},{maximumBytes:4*1024*1024+1},{maximumWaitMs:5001}]){
    const f=fixture(async()=>assert.fail('Invalid bounds must not start a public client'));
    const r=await captureWebKitContrast(f.page,{width:1440,height:1000,...change});
    assert.equal(r.metadata.status,'unknown-capture-bounds');assert.equal(f.calls.starts,0);assert.equal(f.calls.stops,0);
  }
});

test('Frame deadline awaits owned stop and does not retain late callbacks; a drained owner can be reused',async()=>{
  const f=fixture(async()=>{}),r=await captureWebKitContrast(f.page,{width:1440,height:1000,maximumWaitMs:5});
  assert.equal(r.metadata.status,'unknown-frame-deadline');assert.equal(r.data,null);assert.equal(r.metadata.stop,'fulfilled');assert.equal(f.calls.stops,1);
  const snapshot=JSON.stringify(r.metadata);f.calls.options.onFrame(frame());assert.equal(JSON.stringify(r.metadata),snapshot);
  f.page.screencast.start=async options=>options.onFrame(frame());
  assert.equal((await capture(f.page)).metadata.status,'captured');assert.equal(f.calls.stops,2);
});

test('Partial start failure is cleaned; an overlapping capture cannot stop the existing owner',async()=>{
  const f=fixture(async({onFrame})=>{onFrame(frame());throw Error('synthetic start failure');});
  const r=await capture(f.page);assert.equal(r.metadata.status,'unknown-start-failed');assert.equal(r.data,null);assert.equal(r.metadata.stop,'fulfilled');assert.equal(f.calls.stops,1);
  let nested;
  const shared=fixture(async({onFrame})=>{nested=await capture(shared.page);onFrame(frame());});
  const outer=await capture(shared.page);assert.equal(nested.metadata.status,'unknown-existing-capture-owner');
  assert.equal(outer.metadata.status,'captured');assert.equal(shared.calls.starts,1);assert.equal(shared.calls.stops,1);
});

test('Failed stop invalidates an otherwise admitted frame and retains the failed ownership fence',async()=>{
  const f=fixture(async({onFrame})=>onFrame(frame()),async()=>{throw Error('synthetic stop failure');});
  const r=await capture(f.page);assert.equal(r.stopFailed,true);assert.equal(r.data,null);assert.equal(r.metadata.status,'unknown-stop-failed');
  assert.equal(r.metadata.stop,'rejected');assert.deepEqual(r.metadata.errors,['stop-failed']);assert.ok(r.metadata.selected.sha256);
  assert.equal((await capture(f.page)).metadata.status,'unknown-existing-capture-owner');assert.equal(f.calls.starts,1);assert.equal(f.calls.stops,1);
});
