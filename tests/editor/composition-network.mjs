import {expectedResponseCancellation} from './text-zoom-cancellations.mjs';

// Source: editor-client sync/lifecycle aborts its owned stream; recovery-client
// cancels that reader in finally. Pinned PW adapters report these exact literals.
const cancellation={chromium:'net::ERR_ABORTED',firefox:'NS_BINDING_ABORTED',webkit:'cancelled'};
export function expectedCompositionCancellation(e,origin,engine,downloads=[],displayAborts=[]){
 if(engine==='chromium'&&expectedResponseCancellation(e,origin))return 'documented-response-cancellation';
 const r=e.response;
 // A matching 204 release response is complete without a body. WebKit's
 // pinned adapter reports its native response disposal as cancelled.
 if(engine==='webkit'&&e.channel==='requestfailed'&&e.failure?.errorText===cancellation.webkit&&e.resourceType==='fetch'&&e.method==='POST'&&r?.requestId===e.requestId&&r.url===e.url&&r.method==='POST'&&r.status===204&&(r.contentLength===undefined||r.contentLength==='0')&&r.contentType===undefined&&new URL(e.url).origin===origin&&/^\/api\/v1\/recovery\/[0-9a-f-]{36}\/release$/.test(new URL(e.url).pathname))return 'exact-bodyless-recovery-release-response';
 if(e.channel==='requestfailed'&&e.failure?.errorText===cancellation[engine]&&e.resourceType==='fetch'&&e.method==='GET'&&!r&&new URL(e.url).origin===origin&&new URL(e.url).pathname==='/api/v1/events/stream'&&displayAborts.some(p=>p.requestId===e.requestId&&p.url===e.url&&p.exactOccurrence===true&&p.signalAborted===true))return 'exact-request-observed-event-stream-abort-before-headers';
 if(e.channel==='requestfailed'&&e.failure?.errorText===cancellation[engine]&&e.resourceType==='fetch'&&e.method==='GET'&&new URL(e.url).origin===origin&&/^\/api\/v1\/assets\/[^/]+\/display-tile$/.test(new URL(e.url).pathname)&&displayAborts.some(p=>p.requestId===e.requestId&&p.url===e.url&&p.exactOccurrence===true&&p.signalAborted===true)&&!r)return 'exact-request-observed-display-abort-before-headers';
 if(e.channel!=='requestfailed'||e.failure?.errorText!==cancellation[engine]||e.resourceType!=='fetch'||e.method!=='GET'||!r||r.requestId!==e.requestId||r.url!==e.url||r.method!==e.method||r.status!==200)return false;
 const u=new URL(e.url);if(u.origin!==origin)return false;
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
