import {expectedResponseCancellation} from './text-zoom-cancellations.mjs';

// Source: editor-client sync/lifecycle aborts its owned stream; recovery-client
// cancels that reader in finally. Pinned PW adapters report these exact literals.
const cancellation={chromium:'net::ERR_ABORTED',firefox:'NS_BINDING_ABORTED',webkit:'cancelled'};
// The raw native zero is an unavailable pre-response timestamp. A complete
// conservative graph can infer an association, never a timestamp/document read.
export function validUntimedOriginalReadBijection(p){
 const b=p?.bijection,positive=n=>Number.isSafeInteger(n)&&n>0,time=n=>Number.isFinite(n)&&n>0,document=x=>typeof x==='string'&&/^[-a-f0-9]{36}$/.test(x),key=o=>JSON.stringify([o.document,o.operation]);
 const same=(a,b)=>Array.isArray(a)&&a.length===b.length&&new Set(a).size===a.length&&a.every(x=>b.includes(x));
 const sameOperations=(a,b)=>Array.isArray(a)&&a.every(o=>o&&document(o.document)&&positive(o.operation))&&same(a.map(key),b.map(key));
 if(p?.association!=='unique-frame-inferred-bijection'||p.exactOccurrence!==true||p.inferredAssociation!==true||!b||b.version!==2||!positive(b.frameId)||b.document!==undefined||typeof b.url!=='string'||b.method!=='GET')return false;
 const ops=b.operations,requests=b.requests,pairs=b.pairs;
 if(!Array.isArray(ops)||ops.length<1||ops.length>32||!Array.isArray(requests)||requests.length!==ops.length||!Array.isArray(pairs)||pairs.length!==ops.length)return false;
 if(p.frameId!==b.frameId||p.requestFrame!==b.frameId||!document(p.document)||p.url!==b.url||p.method!==b.method)return false;
 if(ops.some(o=>!o||!document(o.document)||!positive(o.operation)||!time(o.start)||!time(o.anchor)||!time(o.end)||o.anchor<o.start||o.end<o.anchor||!['response','rejected'].includes(o.anchorKind)||(o.anchorKind==='response'?(!Number.isInteger(o.anchorStatus)||o.anchorStatus<100||o.anchorStatus>599||o.anchorURL!==b.url||o.anchorRedirected!==false):(o.anchorStatus!==null||o.anchorURL!==null||o.anchorRedirected!==null))||!Array.isArray(o.eligibleRequests)||o.eligibleRequests.length<1||o.eligibleRequests.length>32||!Array.isArray(o.concurrentOperations)||o.concurrentOperations.length>31)||new Set(ops.map(key)).size!==ops.length)return false;
 if(requests.some(q=>!q||!positive(q.requestId)||q.frameId!==b.frameId||q.url!==b.url||q.method!==b.method||q.resourceType!=='fetch'||!(q.startTime===0||time(q.startTime))||q.redirected!==false||(q.startTime===0?q.response!==null:q.response!==null&&(!q.response||q.response.url!==b.url||!Number.isInteger(q.response.status)||q.response.status<100||q.response.status>599||q.response.fromServiceWorker!==false)))||new Set(requests.map(q=>q.requestId)).size!==requests.length||!requests.some(q=>q.startTime===0))return false;
 const validAbort=o=>{const a=o.untimedAbort;return !!a&&a.hasSignal===true&&a.aborted===true&&Array.isArray(a.kinds)&&a.kinds.length===3&&a.kinds[0]==='start'&&a.kinds[1]==='abort'&&a.kinds[2]==='rejected'&&a.errorName==='AbortError'&&time(a.abortAt)&&time(a.rejectionAt)&&o.start<=a.abortAt&&a.abortAt<=a.rejectionAt&&o.anchorKind==='rejected'&&o.anchor===a.rejectionAt&&o.end===a.rejectionAt;};
 for(const o of ops){
  if(o.untimedAbort!==null&&!validAbort(o))return false;
  // Zero offers an edge to every operation; outcomes cannot prune alternatives.
  const eligible=requests.filter(q=>q.startTime===0||q.startTime>=o.start-2&&q.startTime<=o.anchor+2).map(q=>q.requestId),concurrent=ops.filter(other=>other!==o&&other.start<=o.end&&other.end>=o.start);
  if(!same(o.eligibleRequests,eligible)||!sameOperations(o.concurrentOperations,concurrent))return false;
 }
 const remainingOps=new Map(ops.map(o=>[key(o),o])),remainingRequests=new Set(requests.map(q=>q.requestId));let selected;
 for(const pair of pairs){
  if(!pair||!document(pair.document)||!positive(pair.operation)||!positive(pair.requestId))return false;
  const o=remainingOps.get(key(pair));if(!o||!remainingRequests.has(pair.requestId))return false;
  const eligible=o.eligibleRequests.filter(id=>remainingRequests.has(id));if(eligible.length!==1||eligible[0]!==pair.requestId)return false;
  const q=requests.find(q=>q.requestId===pair.requestId);if(o.anchorKind==='response'?!q?.response||q.response.url!==o.anchorURL||q.response.status!==o.anchorStatus||q.response.fromServiceWorker!==false:q?.response!==null)return false;
  if(q.startTime===0&&!validAbort(o))return false;
  remainingOps.delete(key(pair));remainingRequests.delete(pair.requestId);if(pair.document===p.document&&pair.operation===p.operation)selected=pair;
 }
 if(remainingOps.size||remainingRequests.size||!selected||selected.requestId!==p.requestId)return false;
 const o=ops.find(o=>o.document===p.document&&o.operation===p.operation),q=requests.find(q=>q.requestId===p.requestId);
 if(!o||!q||p.start!==o.start||p.end!==o.end||p.requestStartRaw!==q.startTime||!same(p.eligibleRequests,o.eligibleRequests)||!sameOperations(p.concurrentOperations,o.concurrentOperations))return false;
 if(q.startTime===0)return p.requestStart===null&&p.requestTiming==='unavailable'&&p.status===undefined&&p.signalAborted===true&&p.bodyCanceled===false&&p.bodyComplete===false&&p.bytes===undefined;
 return p.requestStart===q.startTime&&p.requestTiming==='observed'&&(q.response===null?p.status===undefined:p.status===q.response.status);
}
// A fallback certificate retains every observed bucket vertex and proves a
// unique full assignment by forced edges; request ordering is never evidence.
export function validOriginalReadBijection(p){
 const b=p?.bijection,positive=n=>Number.isSafeInteger(n)&&n>0,time=n=>Number.isFinite(n)&&n>0;
 const same=(a,b)=>Array.isArray(a)&&a.length===b.length&&new Set(a).size===a.length&&a.every(x=>b.includes(x));
 if(p?.inferredAssociation!==undefined||p?.requestTiming!==undefined||p?.requestStartRaw!==undefined)return false;
 if(p?.association!=='unique-frame-time-bijection'||p.exactOccurrence!==true||!b||b.version!==1||!positive(b.frameId)||typeof b.document!=='string'||!/^[-a-f0-9]{36}$/.test(b.document)||typeof b.url!=='string'||!['GET','POST','PUT'].includes(b.method))return false;
 const ops=b.operations,requests=b.requests,pairs=b.pairs;
 if(!Array.isArray(ops)||ops.length<2||ops.length>32||!Array.isArray(requests)||requests.length!==ops.length||!Array.isArray(pairs)||pairs.length!==ops.length)return false;
 if(p.frameId!==b.frameId||p.requestFrame!==b.frameId||p.document!==b.document||p.url!==b.url||p.method!==b.method)return false;
 if(ops.some(o=>!o||o.document!==b.document||!positive(o.operation)||!time(o.start)||!time(o.anchor)||!time(o.end)||o.anchor<o.start||o.end<o.anchor||!['response','rejected'].includes(o.anchorKind)||(o.anchorKind==='response'?(!Number.isInteger(o.anchorStatus)||o.anchorStatus<100||o.anchorStatus>599||o.anchorURL!==b.url||o.anchorRedirected!==false):(o.anchorStatus!==null||o.anchorURL!==null||o.anchorRedirected!==null))||!Array.isArray(o.eligibleRequests)||o.eligibleRequests.length<1||o.eligibleRequests.length>32||!Array.isArray(o.concurrentOperations)||o.concurrentOperations.length>31)||new Set(ops.map(o=>o.operation)).size!==ops.length)return false;
 if(requests.some(q=>!q||!positive(q.requestId)||q.frameId!==b.frameId||q.url!==b.url||q.method!==b.method||q.resourceType!=='fetch'||!time(q.startTime)||q.redirected!==false||q.response!==null&&(!q.response||q.response.url!==b.url||!Number.isInteger(q.response.status)||q.response.status<100||q.response.status>599||q.response.fromServiceWorker!==false))||new Set(requests.map(q=>q.requestId)).size!==requests.length)return false;
 for(const o of ops){
  const eligible=requests.filter(q=>q.startTime>=o.start-2&&q.startTime<=o.anchor+2).map(q=>q.requestId),concurrent=ops.filter(other=>other!==o&&other.start<=o.end&&other.end>=o.start).map(other=>other.operation);
  if(!same(o.eligibleRequests,eligible)||!same(o.concurrentOperations,concurrent))return false;
 }
 const remainingOps=new Map(ops.map(o=>[o.operation,o])),remainingRequests=new Set(requests.map(q=>q.requestId));let selected;
 for(const pair of pairs){
  if(!pair||!positive(pair.operation)||!positive(pair.requestId))return false;
  const o=remainingOps.get(pair.operation);if(!o||!remainingRequests.has(pair.requestId))return false;
  const eligible=o.eligibleRequests.filter(id=>remainingRequests.has(id));if(eligible.length!==1||eligible[0]!==pair.requestId)return false;
  const q=requests.find(q=>q.requestId===pair.requestId);if(o.anchorKind==='response'?!q?.response||q.response.url!==o.anchorURL||q.response.status!==o.anchorStatus||q.response.fromServiceWorker!==false:q?.response!==null)return false;
  remainingOps.delete(pair.operation);remainingRequests.delete(pair.requestId);if(pair.operation===p.operation)selected=pair;
 }
 if(remainingOps.size||remainingRequests.size||!selected||selected.requestId!==p.requestId)return false;
 const o=ops.find(o=>o.operation===p.operation),q=requests.find(q=>q.requestId===p.requestId);
 return !!o&&!!q&&p.start===o.start&&p.end===o.end&&p.requestStart===q.startTime&&same(p.eligibleRequests,o.eligibleRequests)&&same(p.concurrentOperations,o.concurrentOperations)&&(q.response===null?p.status===undefined:p.status===q.response.status);
}
function exactReadAssociation(p){
 return p.association==='unique-frame-time-window'&&Number.isSafeInteger(p.frameId)&&p.frameId>0&&p.requestFrame===p.frameId&&p.eligibleRequests?.length===1&&p.eligibleRequests[0]===p.requestId&&p.concurrentOperations?.length===0||validOriginalReadBijection(p)||validUntimedOriginalReadBijection(p);
}
export function expectedCompositionCancellation(e,origin,engine,downloads=[],displayAborts=[]){
 // New fallback metadata is verified even for existing readonly branches.
 displayAborts=displayAborts.filter(p=>p.association==='unique-frame-time-bijection'||p.association==='unique-frame-inferred-bijection'||p.bijection!==undefined||p.inferredAssociation!==undefined||p.requestTiming!==undefined||p.requestStartRaw!==undefined||p.requestStart===null?(validOriginalReadBijection(p)||validUntimedOriginalReadBijection(p))&&p.method===e.method&&(!e.response||p.status===e.response.status):true);
 if(engine==='chromium'&&expectedResponseCancellation(e,origin))return 'documented-response-cancellation';
 const r=e.response;
 // A complete original JSON response may have a native canceled terminal.
 // This proves transport EOF only; accepted mutations and pending work still
 // require their existing independent domain, durability and outcome checks.
 if(e.channel==='requestfailed'&&e.failure?.errorText===cancellation[engine]&&e.resourceType==='fetch'&&['GET','POST','PUT'].includes(e.method)&&r?.requestId===e.requestId&&r.url===e.url&&r.method===e.method&&[200,201,202].includes(r.status)&&new URL(e.url).origin===origin&&new URL(e.url).pathname.startsWith('/api/v1/')&&r.contentType==='application/json; charset=utf-8'&&/^[1-9][0-9]*$/.test(r.contentLength??'')&&displayAborts.some(p=>p.requestId===e.requestId&&p.url===e.url&&p.method===e.method&&p.status===r.status&&p.exactOccurrence===true&&exactReadAssociation(p)&&p.bodyComplete===true&&Number.isSafeInteger(p.bytes)&&p.bytes>0&&String(p.bytes)===r.contentLength))return 'exact-original-json-response-eof';
 // A matching 204 release response is complete without a body. WebKit's
 // pinned adapter reports its native response disposal as cancelled.
 if(engine==='webkit'&&e.channel==='requestfailed'&&e.failure?.errorText===cancellation.webkit&&e.resourceType==='fetch'&&e.method==='POST'&&r?.requestId===e.requestId&&r.url===e.url&&r.method==='POST'&&r.status===204&&(r.contentLength===undefined||r.contentLength==='0')&&r.contentType===undefined&&new URL(e.url).origin===origin&&/^\/api\/v1\/recovery\/[0-9a-f-]{36}\/release$/.test(new URL(e.url).pathname))return 'exact-bodyless-recovery-release-response';
 if(e.channel==='requestfailed'&&e.failure?.errorText===cancellation[engine]&&e.resourceType==='fetch'&&e.method==='GET'&&!r&&new URL(e.url).origin===origin&&new URL(e.url).pathname==='/api/v1/events/stream'&&displayAborts.some(p=>p.requestId===e.requestId&&p.url===e.url&&p.exactOccurrence===true&&p.signalAborted===true))return 'exact-request-observed-event-stream-abort-before-headers';
 if(e.channel==='requestfailed'&&e.failure?.errorText===cancellation[engine]&&e.resourceType==='fetch'&&e.method==='GET'&&new URL(e.url).origin===origin&&/^\/api\/v1\/assets\/[^/]+\/display-tile$/.test(new URL(e.url).pathname)&&displayAborts.some(p=>p.requestId===e.requestId&&p.url===e.url&&p.exactOccurrence===true&&p.signalAborted===true)&&!r)return 'exact-request-observed-display-abort-before-headers';
 if(e.channel!=='requestfailed'||e.failure?.errorText!==cancellation[engine]||e.resourceType!=='fetch'||e.method!=='GET'||!r||r.requestId!==e.requestId||r.url!==e.url||r.method!==e.method||r.status!==200)return false;
 const u=new URL(e.url);if(u.origin!==origin)return false;
 // The complete document refresh group and accepted UI checkpoint restore
 // may be superseded; only original cancellation or exact EOF qualifies.
 const refreshRead=!u.search&&/^\/api\/v1\/(?:documents\/[^/]+\/(?:image|history|checkpoints)|ui\/[^/]+|queue)$/.test(u.pathname)||/^\/api\/v1\/documents\/[^/]+\/save-status$/.test(u.pathname)&&/^\?sessionId=[A-Za-z0-9_-]{1,128}$/.test(u.search);
 if(refreshRead&&r.contentType==='application/json; charset=utf-8'&&/^[1-9][0-9]*$/.test(r.contentLength??'')&&displayAborts.some(p=>p.requestId===e.requestId&&p.url===e.url&&p.exactOccurrence===true&&exactReadAssociation(p)&&(p.signalAborted===true||p.bodyCanceled===true||p.bodyComplete===true&&p.status===200&&String(p.bytes)===r.contentLength)))return 'exact-request-observed-snapshot-terminal';
 if(/^\/api\/v1\/(?:(?:documents|ui)\/[^/]+\/composition|assets\/[^/]+)$/.test(u.pathname)&&r.contentType?.startsWith('application/json')&&displayAborts.some(p=>p.requestId===e.requestId&&p.url===e.url&&p.exactOccurrence===true&&(p.signalAborted===true||p.bodyCanceled===true||p.bodyComplete===true&&String(p.bytes)===r.contentLength)))return 'exact-request-observed-composition-terminal';
 if(/^\/api\/v1\/assets\/[^/]+\/display-tile$/.test(u.pathname)&&r.contentType==='application/x-ideogram-rgba8'&&/^[1-9][0-9]*$/.test(r.contentLength??'')&&/^"sha256:[a-f0-9]{64}"$/.test(r.etag??'')&&displayAborts.some(p=>p.requestId===e.requestId&&p.url===e.url&&p.exactOccurrence===true&&(p.signalAborted===true||p.bodyCanceled===true||p.bodyComplete===true&&String(p.bytes)===r.contentLength)))return 'exact-request-observed-display-terminal';
 if(/^\/api\/v1\/(?:documents|ui)\/[^/]+\/composition$/.test(u.pathname)&&r.contentType==='application/octet-stream'&&/^"sha256:[a-f0-9]{64}"$/.test(r.etag??'')&&displayAborts.some(p=>p.requestId===e.requestId&&p.url===e.url&&p.exactOccurrence===true&&p.bodyComplete===true&&String(p.bytes)===r.contentLength))return 'exact-request-observed-original-eof';
 if(u.pathname==='/api/v1/events/stream' &&r.contentType?.startsWith('text/event-stream'))return 'owned-event-stream-cancellation';
 if(!/^\/api\/v1\/(documents|ui)\/[^/]+\/composition$/.test(u.pathname)||u.searchParams.get('download')!=='1'||!/^\d+$/.test(u.searchParams.get('raw')??'')||r.contentType!=='application/octet-stream')return false;
 return downloads.some(p=>p.requestId===e.requestId&&p.url===e.url&&p.oneOwnedRequestInExplicitExportWindow===true&&p.destinationComplete===true&&p.downloadName==='caption-original.bin'&&p.downloadURL.startsWith('blob:'+origin+'/')&&r.contentLength===String(p.bytes)&&r.etag==='"sha256:'+p.sha256+'"')?'exact-request-completed-download':false;
}

export function expectedDisplayBusy(e,origin,proofs=[]){
 if(e.status!==429||new URL(e.url).origin!==origin||!/^\/api\/v1\/assets\/[^/]+\/display-tile$/.test(new URL(e.url).pathname))return false;
 let body;try{body=JSON.parse(e.body);}catch{return false;}
 if(body.protocolVersion!==1||body.error?.code!=='LOCAL_BUSY'||body.error?.retry!=='read-or-transfer')return false;
 const p=proofs.find(p=>p.requestId===e.requestId&&p.url===e.url&&p.exactOccurrence===true&&p.bodyComplete===true&&p.bytes===new TextEncoder().encode(e.body).length);
 return !!p&&(p.signalAborted===true||proofs.some(next=>next.url===p.url&&next.requestId>p.requestId&&next.exactOccurrence===true&&next.bodyComplete===true&&next.status===200));
}
