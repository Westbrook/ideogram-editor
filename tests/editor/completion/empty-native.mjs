import assert from 'node:assert/strict';
import {EXPECTED} from './app-buffer-core.mjs';
const one=(xs,label)=>{assert.equal(xs.length,1,label);return xs[0];};
const nativeURL=url=>typeof url==='string'&&[EXPECTED.workerPath,EXPECTED.wasmPath].includes(new URL(url).pathname);
// This branch deliberately makes no PW/wire header association or native proof.
export function emptyNative(x,e,routes) {
 assert.equal(e.mode,'EMPTY-NATIVE');assert.equal(e.fixture,'busy-actions');
 assert.equal(e.operations.length,0);assert.equal(e.proofs.length,0);assert.equal(e.workers.rows.length,0);assert.equal(e.captures,undefined);assert.equal(e.initial,undefined);assert.equal(e.qualification,undefined);
 assert(!e.nativeClosed.rows.some(r=>r.workerId!==undefined||['created','post','message','terminate'].includes(r.kind)),'No native metadata in busy epoch');
 assert(!e.discovery.some(r=>r.params.targetInfo?.type==='worker'),'No worker target in busy epoch');
 assert(!x.requests.some(q=>nativeURL(q.url)||q.actualHeaders?.['sec-fetch-dest']==='worker'),'No native original request');
 assert(!x.responses.some(p=>nativeURL(p.url)||p.actualHeaders?.['content-type']==='application/wasm'),'No native response');
 assert(!x.server.some(s=>nativeURL(new URL(s.url??'/',x.page.origin).href)||Object.values(s.headers??{}).includes('application/wasm')),'No native server traffic');
 assert(!x.network.some(n=>nativeURL(n.params.request?.url)||nativeURL(n.params.response?.url)||n.params.response?.mimeType==='application/wasm'||Object.values(n.params.headers??{}).includes('application/wasm')||n.params.headers?.['sec-fetch-dest']==='worker'),'No native protocol traffic');
 assert.equal(new Set(x.requests.map(q=>q.id)).size,x.requests.length);
 for(const q of x.requests){assert(q.originalRequestObject&&q.frameExposure?.ownerPage&&q.frameExposure.ownerContext);assert.equal(q.redirectedFrom,null);assert.equal(q.redirectedTo,null);const ps=x.responses.filter(p=>p.requestId===q.id),ts=x.terminals.filter(t=>t.requestId===q.id);assert(ps.length<=1&&ts.length<=1);for(const p of ps){assert(p.originalRequestObject&&p.originalPairConfirmed);assert.equal(p.url,q.url);assert.equal(p.fromServiceWorker,false);}for(const t of ts){assert(t.originalRequestObject);assert.equal(t.url,q.url);}}
 assert(x.responses.every(p=>x.requests.some(q=>q.id===p.requestId)));assert(x.terminals.every(t=>x.requests.some(q=>q.id===t.requestId)));
 const route=one(routes.filter(r=>r.epoch===e.epoch),'One held checkpoint route');assert(route.originalRouteRequest&&route.hold&&route.release&&route.continueStarted&&route.continueFulfilled&&!route.error);assert(route.hold<=route.release&&route.release<=route.continueStarted&&route.continueStarted<=route.continueFulfilled);
 const q=one(x.requests.filter(q=>q.id===route.requestId),'Held original Request');assert.equal(q.url,x.page.origin+'/api/v1/commands');assert.equal(q.method,'POST');assert.equal(route.command.body.type,'SaveCheckpoint');one(x.responses.filter(p=>p.requestId===q.id),'Held original Response');one(x.terminals.filter(t=>t.requestId===q.id),'Held original terminal');
 const before=route.publicBefore,after=route.publicAfter;assert(before&&after);assert.equal(before.previewDisabled,true);assert.equal(before.applyDisabled,true);assert.equal(before.cancelDisabled,false);assert.equal(before.text,'Keep this draft during checkpoint');assert.equal(after.editorHidden,true);assert.equal(after.stillHeld,true);assert.deepEqual(after.acceptedNative,before.acceptedNative);assert(!after.commands.some(c=>['CreateTextLayer','CommitTextEdit'].includes(c.body.type)));
 return {kind:'EMPTY-NATIVE',qualified:false,nativeQualified:false,wasmQualified:false,byteQualified:false,requests:x.requests.length,heldRequestId:q.id,unobservedResponses:x.requests.filter(q=>!x.responses.some(p=>p.requestId===q.id)).map(q=>q.id),unobservedTerminals:x.requests.filter(q=>!x.terminals.some(t=>t.requestId===q.id)).map(q=>q.id),headerScope:'PW headers are provisional; Node/CDP wire headers retained separately without a matcher; absent events remain absent and confer no error qualification'};
}
