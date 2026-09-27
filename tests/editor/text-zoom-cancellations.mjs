export function expectedResponseCancellation(e,origin,fontProofs=[]){
 if(e.channel!=='requestfailed'||e.failure?.errorText!=='net::ERR_ABORTED'||e.resourceType!=='fetch'||!e.response||e.response.requestId!==e.requestId||e.response.url!==e.url||e.response.method!==e.method)return false;
 const u=new URL(e.url);if(u.origin!==origin)return false;const r=e.response,p=u.pathname;
 if(e.method==='POST'&&/^\/api\/v1\/recovery\/[0-9a-f-]{36}\/release$/.test(p))return r.status===204;
 if(e.method==='HEAD'&&/^\/api\/v1\/documents\/[0-9a-f-]{36}$/.test(p))return r.status===200&&/^(0|[1-9][0-9]*)$/.test(r.entityVersion??'');
 // server/assets.ts ends a verified font HEAD without a body.
 if(e.method==='HEAD'&&/^\/api\/v1\/assets\/[0-9a-f-]{36}\/content$/.test(p))return r.status===200&&r.contentType==='application/octet-stream'&&/^\"sha256:[a-f0-9]{64}\"$/.test(r.etag??'');
 if(e.method==='GET'&&p==='/api/v1/events/stream')return r.status===200&&r.contentType?.startsWith('text/event-stream');
 if(e.method==='GET'&&p==='/api/v1/events')return r.status===200&&r.contentType?.startsWith('application/json');
 // readSealedAsset finishes and cancels/releases its stream reader. Require a
 // fresh byte-for-byte HTTP proof for this exact owned pinned static font.
 if(e.method==='GET'&&r.status===200&&['font/ttf','font/otf'].includes(r.contentType))return fontProofs.some(f=>origin+f.path===e.url&&f.bytes===Number(r.contentLength)&&f.sha256&&f.method.startsWith('Independent APIRequestContext'));
 return false;
}
