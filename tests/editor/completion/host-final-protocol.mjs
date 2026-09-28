import assert from 'node:assert/strict';

import {normalizedHeaders as normalized,privateFraming} from './host-final-headers.mjs';
const automatic={date:v=>Number.isFinite(Date.parse(v))&&new Date(v).toUTCString()===v,connection:v=>['keep-alive','close'].includes(v),'keep-alive':v=>/^timeout=\d+(?:, max=\d+)?$/.test(v),'transfer-encoding':v=>v==='chunked'};
export function privateHeaders(actual,original,{response=false,status,exposed=[],automaticHeaders={}}={}){
 const a=normalized(actual),o=normalized(original);
 for(const [k,v]of Object.entries(a)){
  if(k in o)assert.equal(v,o[k],'Original private header '+k);
  else {assert(response&&automatic[k]?.(v),'Unattributed private header '+k);if(k in automaticHeaders)assert.equal(v,automaticHeaders[k]);automaticHeaders[k]=v;}
  for(const previous of exposed)if(k in previous)assert.equal(v,previous[k],'Contradictory exposed private header '+k);
 }
 if(response)privateFraming(Object.assign({},o,...exposed,a),status);
 exposed.push(a);return a;
}
export function privateProtocol({events,registration:r,url,method,status,requestHeaders,responseHeaders,pwTerminal,requestExposed,responseExposed,automaticHeaders}){
 const counts=new Map(),allowed=new Set(['Network.requestWillBeSent','Network.requestWillBeSentExtraInfo','Network.responseReceived','Network.responseReceivedExtraInfo','Network.dataReceived','Network.loadingFinished','Network.loadingFailed']);
 let terminal;
 for(const n of events){const p=n.params;assert(allowed.has(n.name),'Unknown/cache private protocol event');
  if(n.name!=='Network.dataReceived'){const count=(counts.get(n.name)??0)+1;counts.set(n.name,count);assert.equal(count,1,'Unique private '+n.name);}
  for(const [key,expected]of [['frameId',r.context.frameId],['targetId',r.context.targetId],['browserContextId',r.context.browserContextId]])if(p[key]!==undefined)assert.equal(p[key],expected,'Original private '+key);
  if(p.type!==undefined)assert((method==='POST'?['Ping','Other']:['Document']).includes(p.type),'Exact private resource type');
  if(n.controllerSessionLabel!==undefined)assert.equal(n.controllerSessionLabel,'owned-page-CDPSession-1');
  assert.equal(p.redirectResponse,undefined);assert(!p.redirectHasExtraInfo);
  if(n.name==='Network.requestWillBeSent'){
   assert.equal(p.request.url,url);assert.equal(p.request.method,method);assert(p.request.urlFragment===undefined||p.request.urlFragment==='');
   privateHeaders(p.request.headers,requestHeaders,{exposed:requestExposed});
  }
  if(n.name==='Network.requestWillBeSentExtraInfo')privateHeaders(p.headers,requestHeaders,{exposed:requestExposed});
  if(n.name==='Network.responseReceived'){
   const v=p.response;assert.equal(v.url,url);assert.equal(v.status,status);for(const k of ['fromDiskCache','fromServiceWorker','fromPrefetchCache'])assert(!v[k],'Private cache/service-worker substitution');
   if(v.requestHeaders)privateHeaders(v.requestHeaders,requestHeaders,{exposed:requestExposed});
   privateHeaders(v.headers,responseHeaders,{response:true,status,exposed:responseExposed,automaticHeaders});
  }
  if(n.name==='Network.responseReceivedExtraInfo'){
   assert.equal(p.statusCode,status,'Private ExtraInfo status');assert.deepEqual(p.blockedCookies??[],[]);
   privateHeaders(p.headers,responseHeaders,{response:true,status,exposed:responseExposed,automaticHeaders});
   if(p.headersText){const lines=p.headersText.trimEnd().split('\r\n');assert(new RegExp('^HTTP/1\\.[01] '+status+'(?: |$)').test(lines.shift()));const raw={};for(const line of lines){const i=line.indexOf(':');assert(i>0);const k=line.slice(0,i).toLowerCase();assert(!(k in raw));raw[k]=line.slice(i+1).trim();}assert.deepEqual(normalized(raw),normalized(p.headers),'Raw private response header agreement');}
  }
  if(n.name==='Network.loadingFinished'||n.name==='Network.loadingFailed'){
   assert(!terminal,'One private terminal');terminal=n.name.endsWith('Finished')?'finished':'failed';
   if(terminal==='failed')assert(typeof p.errorText==='string'&&p.errorText.length);else assert(Number.isFinite(p.encodedDataLength)&&p.encodedDataLength>=0);
  }
  if(n.name==='Network.dataReceived'){for(const k of ['dataLength','encodedDataLength'])assert(Number.isFinite(p[k])&&p[k]>=0);if(status===204)assert.equal(p.dataLength,0,'Bodyless204 data');}
 }
 if(terminal&&pwTerminal){assert.equal(terminal,pwTerminal.kind,'Original PW/protocol terminal agreement');if(terminal==='failed'){const failure=events.find(n=>n.name==='Network.loadingFailed');assert.equal(failure.params.errorText,pwTerminal.failure?.errorText);}}
 return {counts:Object.fromEntries(counts),terminal:terminal??null,automaticResponseHeaders:automaticHeaders};
}
