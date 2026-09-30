import {test} from 'node:test';
import assert from 'node:assert/strict';
import {freshFrame} from './spectrum-frame.ts';
const frame={data:Buffer.from('frame'),timestamp:100,viewportWidth:1440,viewportHeight:1000};
function cast(run,stop=async()=>{}){let closes=0;return {start:async options=>run(options),stop:async()=>{closes++;await stop();},get closes(){return closes;}};}
test('stale frames are discarded; only a fresh matching frame is returned and capture stops',async()=>{
 const c=cast(({onFrame,size,quality})=>{assert.deepEqual(size,{width:1440,height:1000});assert.equal(quality,100);onFrame({...frame,timestamp:99});onFrame(frame);});
 const r=await freshFrame(c,{width:1440,height:1000},100,50,50);assert.equal(r.frame,frame);assert.equal(r.discarded[0].reason,'stale');assert.equal(c.closes,1);
});
test('wrong viewport fails and still stops',async()=>{const c=cast(({onFrame})=>onFrame({...frame,viewportWidth:390}));await assert.rejects(freshFrame(c,{width:1440,height:1000},100,50,50),/viewport mismatch/);assert.equal(c.closes,1);});
test('no fresh frame reaches its finite deadline and still stops',async()=>{const c=cast(({onFrame})=>onFrame({...frame,timestamp:99}));await assert.rejects(freshFrame(c,{width:1440,height:1000},100,20,50),/Fresh frame deadline/);assert.equal(c.closes,1);});
test('start and stop errors remain separate in aggregate',async()=>{const c=cast(()=>{throw Error('start error');},async()=>{throw Error('stop error');});await assert.rejects(freshFrame(c,{width:1440,height:1000},100,50,50),e=>e instanceof AggregateError&&e.errors[0].message==='start error'&&e.errors[1].message==='stop error');assert.equal(c.closes,1);});
test('stop is independently bounded',async()=>{const c=cast(({onFrame})=>onFrame(frame),()=>new Promise(()=>{}));await assert.rejects(freshFrame(c,{width:1440,height:1000},100,50,20),/stop deadline/);assert.equal(c.closes,1);});
test('changed checkpoint state fails before saving a frame',async()=>{
 const {captureFrame}=await import('./spectrum-frame.ts');let reads=0;
 const c=cast(({onFrame})=>onFrame({...frame,timestamp:Date.now()}));
 const p={screencast:c,evaluate:async()=>{reads++;return reads===1?undefined:{appearance:reads===2?'light':'dark',width:1440,height:1000};},getByRole:()=>({evaluateAll:async()=>[]})};
 await assert.rejects(captureFrame(p,'must-not-be-written.jpg',async()=>{}),/checkpoint state changed/);assert.equal(c.closes,1);
});
