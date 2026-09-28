import assert from 'node:assert/strict';
const one=(a,label)=>{assert.equal(a.length,1,label);return a[0];};
// A local Blob image has no Node HTTP request. Preserve its independent original
// records; it cannot enter the HTTP/WASM graph or qualify any transport error.
export function wireEpoch({origin,requests,responses,terminals,network,server=[],storageProbePath}){
 const own=requests.filter(q=>new URL(q.url).origin===origin),http=[],localImages=[],storageProbes=[];
 for(const q of own){
  if(storageProbePath&&q.url===origin+storageProbePath){
   assert.equal(q.method,'GET');assert.equal(q.resourceType,'document');assert(q.originalRequestObject&&q.frameExposure?.ownerPage===false&&q.frameExposure.ownerContext===true&&q.frameExposure.pageId);assert.equal(q.redirectedFrom,null);assert.equal(q.redirectedTo,null);
   const p=one(responses.filter(p=>p.requestId===q.id),'Owned storage probe Response'),t=one(terminals.filter(t=>t.requestId===q.id),'Owned storage probe terminal');assert.equal(p.url,q.url);assert.equal(t.url,q.url);assert(p.originalRequestObject&&p.originalPairConfirmed&&t.originalRequestObject);assert.equal(p.fromServiceWorker,false);assert.equal(p.status,200);assert.equal(p.actualHeaders['content-type'],'text/html');assert.equal(t.kind,'finished');
   assert(!server.some(e=>e.kind==='request'&&new URL(e.url,origin).href===q.url),'Probe must be browser fulfilled');assert(!network.some(e=>e.params.request?.url===q.url||e.params.response?.url===q.url),'Probe cannot be the application page');
   storageProbes.push({request:q,response:p,terminal:t,scope:'Exact owned storage-control page; browser fulfilled, no application or byte qualification'});continue;
  }
  if(/^https?:$/.test(new URL(q.url).protocol)){http.push(q);continue;}
  assert.equal(new URL(q.url).protocol,'blob:');assert(q.url.startsWith('blob:'+origin+'/'));assert.equal(q.method,'GET');assert.equal(q.resourceType,'image');assert(q.originalRequestObject&&q.frameExposure?.ownerPage);assert.equal(q.redirectedFrom,null);assert.equal(q.redirectedTo,null);
  const p=one(responses.filter(p=>p.requestId===q.id),'Original local image Response'),t=one(terminals.filter(t=>t.requestId===q.id),'Original local image terminal');assert.equal(p.url,q.url);assert.equal(t.url,q.url);assert(p.originalRequestObject&&p.originalPairConfirmed&&t.originalRequestObject);assert.equal(p.fromServiceWorker,false);assert.equal(p.status,200);assert.equal(p.actualHeaders['content-type'],'image/png');assert.equal(t.kind,'finished');localImages.push({request:q,response:p,terminal:t,scope:'Original local Blob image; not HTTP server traffic, no WASM or error qualification'});
 }
 const nonWireIDs=new Set();for(const e of network){const urls=[e.params.request?.url,e.params.response?.url].filter(Boolean);if(urls.some(u=>u.startsWith('blob:')&&new URL(u).origin===origin)){for(const url of urls)one(localImages.filter(v=>v.request.url===url),'Every protocol Blob URL has an original local image');nonWireIDs.add(e.params.requestId);}}
 for(const id of nonWireIDs){const rows=network.filter(e=>e.params.requestId===id);assert(!rows.some(e=>e.name==='Network.loadingFailed'),'Local image errors are never excepted');for(const e of rows){const p=e.params;if(p.request?.url)one(localImages.filter(v=>v.request.url===p.request.url),'Local request URL');if(p.response?.url){const v=one(localImages.filter(v=>v.request.url===p.response.url),'Local response URL');assert.equal(p.response.status,v.response.status);if(p.response.mimeType)assert.equal(p.response.mimeType,'image/png');}assert(!p.headers||!Object.values(p.headers).includes('application/wasm'),'Blob metadata cannot hide a WASM candidate');}}
 const ids=new Set(http.map(q=>q.id));return {requests:http,responses:responses.filter(p=>ids.has(p.requestId)),terminals:terminals.filter(t=>ids.has(t.requestId)),network:network.filter(e=>!nonWireIDs.has(e.params.requestId)),localImages,storageProbes};
}
