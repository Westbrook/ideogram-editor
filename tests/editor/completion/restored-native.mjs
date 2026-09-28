import assert from 'node:assert/strict';
import {EXPECTED,headers} from './app-buffer-core.mjs';
export const RESTORED_MODE='RESTORED-NON-NATIVE';
const nativeURL=url=>typeof url==='string'&&[EXPECTED.workerPath,EXPECTED.wasmPath].includes(new URL(url).pathname);
const nativeHeaders=h=>Object.entries(headers(h??{})).some(([k,v])=>k==='sec-fetch-dest'&&v==='worker'||k==='content-type'&&v.split(';')[0]==='application/wasm');
// Node getHeaders snapshots retain numbers and arrays. This derived inspection
// is negative-only; it never rewrites or substitutes browser/wire headers.
export function restoredNodeNativeHeaders(h={}){
 assert(h&&typeof h==='object'&&!Array.isArray(h),'Restored Node header map shape');
 const names=new Set();let native=false;
 for(const [name,value] of Object.entries(h)){
  const key=name.toLowerCase();assert(!names.has(key),'Duplicate normalized Node header');names.add(key);
  const relevant=key==='sec-fetch-dest'||key==='content-type';
  if(typeof value==='number'){assert(Number.isFinite(value),'Restored Node numeric header shape');assert(!relevant,'Restored Node native-relevant numeric header');continue;}
  const values=Array.isArray(value)?Array.from(value):[value];
  assert(values.every(v=>typeof v==='string'),'Restored Node header value shape');
  if(!relevant)continue;
  assert(values.length,'Restored Node native-relevant empty array');
  for(const v of values){
   assert(!/[\x00-\x1f\x7f]/.test(v),'Restored Node native-relevant malformed header');
   const discriminator=(key==='content-type'?v.split(';')[0]:v).trim().toLowerCase();
   assert((key==='content-type'?/^[!#$%&'*+.^_`|~a-z0-9-]+\/[!#$%&'*+.^_`|~a-z0-9-]+$/:/^[a-z][a-z0-9-]*$/).test(discriminator),'Restored Node native-relevant malformed header');
   if(key==='sec-fetch-dest'?discriminator==='worker':discriminator==='application/wasm')native=true;
  }
 }
 return native;
}
export function refuseRestoredNative(e,x){
 assert.equal(e.mode,RESTORED_MODE);assert.equal(e.fixture,'restored-reads');
 for(const name of ['operations','proofs'])assert.equal(e[name].length,0,'Restored mode forbids '+name);
 assert.equal(e.workers.rows.length,0,'Restored mode forbids Worker objects');
 for(const name of ['collector','captures','initial','qualification'])assert.equal(e[name],undefined,'Restored mode forbids '+name);
 assert(e.nativeClosed.rows.every(r=>r.kind==='installed'&&r.workerId===undefined&&r.actionId===null),'Restored mode forbids native observer activity');
 assert(!e.discovery.some(n=>n.params.targetInfo?.type==='worker'),'Restored mode forbids worker targets');
 for(const q of x.requests)assert(!nativeURL(q.url)&&!nativeHeaders(q.actualHeaders),'Restored mode forbids native requests');
 for(const p of x.responses)assert(!nativeURL(p.url)&&!nativeHeaders(p.actualHeaders),'Restored mode forbids native responses');
 for(const s of x.server)assert(!nativeURL(new URL(s.url??'/',e.origin).href)&&!restoredNodeNativeHeaders(s.headers),'Restored mode forbids native server records');
 for(const n of x.network){const p=n.params;assert(!nativeURL(p.request?.url)&&!nativeURL(p.response?.url)&&p.response?.mimeType!=='application/wasm'&&!nativeHeaders(p.headers)&&!nativeHeaders(p.request?.headers)&&!nativeHeaders(p.response?.headers),'Restored mode forbids native protocol records');}
}
// Check original channels after the unchanged private partition, before the
// existing wire helper separates HTTP, local Blob images and storage probes.
export function restoredOriginalChannels({origin,requests,responses,terminals,server,network},e){
 for(const p of responses){const qs=requests.filter(q=>q.id===p.requestId);assert.equal(qs.length,1,'No original orphan Response before wire filtering');assert.equal(p.url,qs[0].url);assert(p.originalRequestObject&&p.originalPairConfirmed);}
 for(const t of terminals){const qs=requests.filter(q=>q.id===t.requestId);assert.equal(qs.length,1,'No original orphan terminal before wire filtering');assert.equal(t.url,qs[0].url);assert(t.originalRequestObject);}
 const own=requests.filter(q=>new URL(q.url).origin===origin),ids=new Set(own.map(q=>q.id));
 assert.equal(ids.size,own.length,'Unique original pre-filter requests');
 const ps=responses.filter(p=>new URL(p.url).origin===origin||ids.has(p.requestId)),ts=terminals.filter(t=>new URL(t.url).origin===origin||ids.has(t.requestId));
 for(const p of ps){const q=own.filter(q=>q.id===p.requestId);assert.equal(q.length,1,'No original orphan Response before wire filtering');assert(p.originalRequestObject&&p.originalPairConfirmed);assert.equal(p.url,q[0].url);}
 for(const t of ts){const q=own.filter(q=>q.id===t.requestId);assert.equal(q.length,1,'No original orphan terminal before wire filtering');assert(t.originalRequestObject);assert.equal(t.url,q[0].url);}
 // Local and probe records remain subject to their existing exact wire rules.
 // Native metadata is forbidden even when it is attached to such a record.
 refuseRestoredNative(e,{requests:own,responses:ps,terminals:ts,server,network});
 return {requests:own.length,responses:ps.length,terminals:ts.length};
}
// This is negative accounting only. Raw channel headers are never substituted,
// equated, or used to qualify a missing terminal or transport error.
export function restoredNative(x,e,routeEvidence){
 refuseRestoredNative(e,x);assert.equal(x.page.origin,e.origin);assert(x.page.live&&x.page.contextId&&x.page.frameId&&x.page.targetId);
 const qs=x.requests,ps=x.responses,ts=x.terminals,ss=x.server.filter(s=>s.kind==='request');
 assert.equal(new Set(qs.map(q=>q.id)).size,qs.length,'Unique original requests');assert.equal(new Set(ss.map(s=>s.id)).size,ss.length,'Unique server requests');
 for(const q of qs){assert(q.originalRequestObject&&q.frameExposure?.ownerPage&&q.frameExposure.ownerFrame&&q.frameExposure.ownerContext,'Original main-page request');assert.equal(new URL(q.url).origin,e.origin);assert.equal(q.redirectedFrom,null);assert.equal(q.redirectedTo,null);const pairs=ps.filter(p=>p.requestId===q.id),ends=ts.filter(t=>t.requestId===q.id);assert(pairs.length<=1&&ends.length<=1,'Unique original response and terminal');for(const p of pairs){assert(p.originalRequestObject&&p.originalPairConfirmed);assert.equal(p.url,q.url);assert.equal(p.fromServiceWorker,false);}for(const t of ends){assert(t.originalRequestObject);assert.equal(t.url,q.url);assert(['finished','failed'].includes(t.kind));}}
 assert(ps.every(p=>qs.some(q=>q.id===p.requestId)),'No orphan Response');assert(ts.every(t=>qs.some(q=>q.id===t.requestId)),'No orphan terminal');
 const key=(method,url)=>method+' '+url,groups=new Map();for(const q of qs){const k=key(q.method,q.url);if(!groups.has(k))groups.set(k,{key:k,requestIds:[],serverIds:[]});groups.get(k).requestIds.push(q.id);}
 for(const s of ss){assert(s.requestObject&&s.responseObject&&s.responseRequestSame);assert.equal(s.pid,e.pid);const g=groups.get(key(s.method,new URL(s.url,e.origin).href));assert(g,'No orphan server request');g.serverIds.push(s.id);}
 for(const g of groups.values())assert.equal(g.requestIds.length,g.serverIds.length,'Exhaustive method/URL multiplicity without header association');
 for(const s of x.server.filter(s=>s.id!==undefined))assert(ss.some(q=>q.id===s.id),'No orphan server record');
 const protocol=[];for(const id of new Set(x.network.map(n=>n.params.requestId))){assert(id,'Original protocol ID');const rows=x.network.filter(n=>n.params.requestId===id);for(const name of ['Network.requestWillBeSent','Network.requestWillBeSentExtraInfo','Network.responseReceived','Network.responseReceivedExtraInfo','Network.loadingFinished','Network.loadingFailed'])assert(rows.filter(n=>n.name===name).length<=1,'Unique protocol event '+name);assert(rows.filter(n=>['Network.loadingFinished','Network.loadingFailed'].includes(n.name)).length<=1,'One raw protocol terminal');const urls=[...new Set(rows.flatMap(n=>[n.params.request?.url,n.params.response?.url].filter(Boolean)))];assert(urls.length<=1,'Conflicting protocol URL');const methods=[...new Set(rows.map(n=>n.params.request?.method).filter(Boolean))];assert(methods.length<=1,'Conflicting protocol method');const reqExtra=rows.find(n=>n.name==='Network.requestWillBeSentExtraInfo');assert(urls.length||reqExtra&&headers(reqExtra.params.headers).host===new URL(e.origin).host,'Protocol ownership metadata required');for(const url of urls)assert.equal(new URL(url).origin,e.origin);const candidates=qs.filter(q=>(!urls.length||q.url===urls[0])&&(!methods.length||q.method===methods[0]));assert(candidates.length,'No orphan protocol group');protocol.push({requestId:id,candidateOriginalIds:candidates.map(q=>q.id),association:'unqualified candidates only',observedEvents:rows.map(n=>n.name)});}
 return {kind:RESTORED_MODE,qualified:false,nativeQualified:false,wasmQualified:false,byteQualified:false,transportQualified:false,observedEOF:false,route:routeEvidence,requests:qs.length,groups:[...groups.values()],protocol,unobservedResponses:qs.filter(q=>!ps.some(p=>p.requestId===q.id)).map(q=>q.id),unobservedTerminals:qs.filter(q=>!ts.some(t=>t.requestId===q.id)).map(q=>q.id),headerScope:'Original PW, CDP and Node headers retained separately; no header matcher or positive association'};
}
