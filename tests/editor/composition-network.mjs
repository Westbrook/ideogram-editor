import {expectedResponseCancellation} from './text-zoom-cancellations.mjs';

// Source: editor-client sync/lifecycle aborts its owned stream; recovery-client
// cancels that reader in finally. Pinned PW adapters report these exact literals.
const cancellation={chromium:'net::ERR_ABORTED',firefox:'NS_BINDING_ABORTED',webkit:'cancelled'};
export function expectedCompositionCancellation(e,origin,engine,downloads=[]){
 if(engine==='chromium'&&expectedResponseCancellation(e,origin))return 'documented-response-cancellation';
 const r=e.response;
 if(e.channel!=='requestfailed'||e.failure?.errorText!==cancellation[engine]||e.resourceType!=='fetch'||e.method!=='GET'||!r||r.requestId!==e.requestId||r.url!==e.url||r.method!==e.method||r.status!==200)return false;
 const u=new URL(e.url);if(u.origin!==origin)return false;
 if(u.pathname==='/api/v1/events/stream'&&r.contentType?.startsWith('text/event-stream'))return 'owned-event-stream-cancellation';
 if(!/^\/api\/v1\/(documents|ui)\/[^/]+\/composition$/.test(u.pathname)||u.searchParams.get('download')!=='1'||!/^\d+$/.test(u.searchParams.get('raw')??'')||r.contentType!=='application/octet-stream')return false;
 return downloads.some(p=>p.requestId===e.requestId&&p.url===e.url&&p.oneOwnedRequestInExplicitExportWindow===true&&p.destinationComplete===true&&p.downloadName==='caption-original.bin'&&p.downloadURL.startsWith('blob:'+origin+'/')&&r.contentLength===String(p.bytes)&&r.etag==='"sha256:'+p.sha256+'"')?'exact-request-completed-download':false;
}
