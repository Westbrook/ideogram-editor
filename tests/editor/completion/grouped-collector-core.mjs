import assert from 'node:assert/strict';
import {CASES,sha,workerSource,matchOwnedWorker} from './inspector-capability-core.mjs';
import {associate as associateBinary,INPUTS as PRIOR_INPUTS,headers,pageIdentity} from './terminal-collector-core.mjs';
export {PageCollector,POLICY,disableCollection,PublicWorkerLedger,rpcError,decodeBody,unavailable,UNAVAILABLE_MESSAGES} from './terminal-collector-core.mjs';
export const INPUTS=[...PRIOR_INPUTS.map(n=>['core','router','controls','series'].some(k=>n===`terminal-collector-${k}.mjs`)?n.replace('terminal-','grouped-'):n),'terminal-collector-core.mjs'];
export class PendingGrouping extends Error {}
function one(rows,label){assert(rows.length<=1,'Duplicate '+label);if(!rows.length)throw new PendingGrouping('Missing '+label);return rows[0];}
function subset(actual,expected){for(const [k,v]of Object.entries(headers(actual)))assert.equal(expected[k],v,'Observed header '+k);}
function checkRequest(p,url,expectedHeaders){assert.equal(p.request.url,url);assert.equal(p.request.method,'GET');assert.equal(p.redirectResponse,undefined);subset(p.request.headers??{},expectedHeaders);}
function checkResponse(p,url,expectedHeaders){assert.equal(p.response.url,url);assert.equal(p.response.status,200);assert.deepEqual(headers(p.response.headers),expectedHeaders);for(const key of ['fromDiskCache','fromServiceWorker'])if(p.response[key]!==undefined)assert.equal(p.response[key],false);}

export function groupNetwork(x){
  const {c,s,page,pageNetwork,scriptServer,scriptPWRequests,scriptPWResponses,servedScripts}=x;
  pageIdentity(page);matchOwnedWorker(s.targetInfo,c,{targetId:page.targetId,contextId:page.contextId});assert.equal(s.targetInfo.parentFrameId,page.frameId);assert.equal(s.targetId,s.targetInfo.targetId);
  const scriptId=s.targetId;
  const start=one(pageNetwork.filter(e=>e.name==='Network.requestWillBeSent'&&(e.params.requestId===scriptId||e.params.request?.url===c.workerURL)),'owning page Script start');
  assert.equal(start.params.requestId,scriptId);assert.equal(start.params.type,'Script');assert.equal(start.params.frameId,page.frameId);
  const pageScript=pageNetwork.filter(e=>e.params.requestId===scriptId);
  const reqExtra=one(pageScript.filter(e=>e.name==='Network.requestWillBeSentExtraInfo'),'script request ExtraInfo');
  const resExtra=one(pageScript.filter(e=>e.name==='Network.responseReceivedExtraInfo'),'script response ExtraInfo');
  const reqHeaders=headers(reqExtra.params.headers),resHeaders=headers(resExtra.params.headers);
  assert.equal(resExtra.params.statusCode,200);assert.equal(reqHeaders.referer,page.origin+'/');assert.equal(reqHeaders['sec-fetch-dest'],'worker');
  checkRequest(start.params,c.workerURL,reqHeaders);
  const served=one(servedScripts,'served worker script');const source=workerSource(CASES.find(v=>v.id===c.id),c.url);
  assert.equal(served.caseId,c.id);assert.equal(served.url,c.workerURL);assert.equal(served.source,source);assert.equal(served.sha256,sha(source));assert.equal(served.bytes,Buffer.byteLength(source));
  assert.equal(resHeaders['content-length'],String(served.bytes));assert.equal(resHeaders['content-type'],'text/javascript');assert.equal(resHeaders['cache-control'],'no-store');
  const serverRequest=one(scriptServer.filter(e=>e.event==='request'),'script server request');
  const serverFinish=one(scriptServer.filter(e=>e.event==='response-finish'),'script server finish');
  const serverClose=one(scriptServer.filter(e=>e.event==='response-close'),'script server close');
  for(const e of [serverRequest,serverFinish,serverClose]){assert.equal(e.scriptCase,c.id);assert.equal(e.url,c.workerURL);assert.equal(e.method,'GET');assert.equal(e.requestId,serverRequest.requestId);}
  assert.equal(serverFinish.status,200);assert.equal(serverFinish.writableFinished,true);assert.equal(serverClose.writableFinished,true);
  assert.deepEqual(headers(serverRequest.headers),reqHeaders);
  const pwRequest=one(scriptPWRequests,'original script PW Request'),pwResponse=one(scriptPWResponses,'original script PW Response');
  assert.equal(pwRequest.url,c.workerURL);assert.equal(pwRequest.method,'GET');assert.equal(pwRequest.resourceType,'script');assert.equal(pwRequest.redirectedFrom,null);assert.equal(pwRequest.frameExposure?.ownerPage,true);
  assert.equal(pwResponse.requestId,pwRequest.id);assert.equal(pwResponse.url,c.workerURL);assert.equal(pwResponse.status,200);assert.equal(pwResponse.originalRequestObject,true);assert.equal(pwResponse.fromServiceWorker,false);assert.deepEqual(headers(pwResponse.headers),resHeaders);
  if(pwRequest.actualHeaders!==undefined)assert.deepEqual(headers(pwRequest.actualHeaders),reqHeaders);
  const pageResponses=pageScript.filter(e=>e.name==='Network.responseReceived');assert(pageResponses.length<=1);
  for(const e of pageResponses)checkResponse(e.params,c.workerURL,resHeaders);
  const pageTerminals=pageScript.filter(e=>['Network.loadingFinished','Network.loadingFailed'].includes(e.name));assert(pageTerminals.length<=1);for(const e of pageTerminals)assert.equal(e.name,'Network.loadingFinished','Script page failure cannot be excluded');
  assert(Array.isArray(s.rawNetwork),'Original worker network ledger required');
  let priorOrder=-1;for(const e of s.rawNetwork){assert(Number.isInteger(e.order)&&e.order>priorOrder,'Raw worker order retained');priorOrder=e.order;assert(e.method.startsWith('Network.'));assert(typeof e.params.requestId==='string'&&e.params.requestId,'Every network packet requires accounted request identity');}
  const script=s.rawNetwork.filter(e=>e.params.requestId===scriptId),binary=s.rawNetwork.filter(e=>e.params.requestId!==scriptId);
  const binaryIds=[...new Set(binary.map(e=>e.params.requestId))];assert(binaryIds.length<=1,'Additional unaccounted worker request ID');if(!binaryIds.length)throw new PendingGrouping('Missing binary request identity');
  const requestId=binaryIds[0];assert.notEqual(requestId,scriptId);
  const scriptStarts=script.filter(e=>e.method==='Network.requestWillBeSent'),scriptResponses=script.filter(e=>e.method==='Network.responseReceived'),scriptTerminals=script.filter(e=>['Network.loadingFinished','Network.loadingFailed'].includes(e.method));
  assert(scriptStarts.length<=1);assert(scriptResponses.length<=1);assert(scriptTerminals.length<=1,'Duplicate script terminal');
  for(const e of scriptStarts){assert.equal(e.params.type,'Script');checkRequest(e.params,c.workerURL,reqHeaders);}
  for(const e of scriptResponses)checkResponse(e.params,c.workerURL,resHeaders);
  for(const e of script){if(e.method==='Network.requestWillBeSentExtraInfo')assert.deepEqual(headers(e.params.headers),reqHeaders);if(e.method==='Network.responseReceivedExtraInfo'){assert.equal(e.params.statusCode,200);assert.deepEqual(headers(e.params.headers),resHeaders);}if(e.method==='Network.dataReceived')assert(Number.isFinite(e.params.dataLength)&&e.params.dataLength>=0);}
  for(const e of scriptTerminals){assert.equal(e.method,'Network.loadingFinished','Script failure cannot be excluded');if(s.detached)assert(e.order<s.detached);if(s.destroyed)assert(e.order<s.destroyed);}
  const terminals=binary.filter(e=>['Network.loadingFinished','Network.loadingFailed'].includes(e.method));const terminal=one(terminals,'binary terminal');
  const requests=binary.filter(e=>e.method==='Network.requestWillBeSent').map(e=>e.params),responses=binary.filter(e=>e.method==='Network.responseReceived');assert(requests.length<=1);assert(responses.length<=1);
  for(const e of s.contextEvents??[]){if(e.method==='Runtime.executionContextDestroyed')assert.equal(e.params.executionContextId,s.contexts[0]?.id,'Unknown context destruction');assert(e.order>terminal.order,'Context lost before binary terminal');}
  const grouped={...s,requests,responses,network:binary,terminals,contextLostBeforeTerminal:s.contextLostBeforeTerminal};
  return {session:grouped,receipt:{scriptId,requestId,script,binary,scriptTerminalObserved:scriptTerminals.length===1,workerScriptStartObserved:scriptStarts.length===1,workerScriptResponseObserved:scriptResponses.length===1,pageScriptResponseObserved:pageResponses.length===1,scriptPWRequestHeadersRecorded:pwRequest.actualHeaders!==undefined,scriptPWRequestId:pwRequest.id,scriptServerRequestId:serverRequest.requestId,serverScriptBytes:served.bytes,serverScriptSHA256:served.sha256,scriptBodyProof:false,rawNetworkCount:s.rawNetwork.length,scope:'Exact fixed-fixture ownership grouping; raw ledger retained, server script metadata is not received-body proof'}};
}

export function associate(x){
  const {session,receipt}=groupNetwork(x);
  const reqExtra=x.pageNetwork.filter(e=>e.name==='Network.requestWillBeSentExtraInfo'&&e.params.requestId===receipt.requestId);
  const resExtra=x.pageNetwork.filter(e=>e.name==='Network.responseReceivedExtraInfo'&&e.params.requestId===receipt.requestId);
  if(reqExtra.length===1)for(const q of session.requests)subset(q.request.headers??{},headers(reqExtra[0].params.headers));
  for(const e of session.network){
    if(e.method==='Network.requestWillBeSentExtraInfo'&&reqExtra.length===1)assert.deepEqual(headers(e.params.headers),headers(reqExtra[0].params.headers));
    if(e.method==='Network.responseReceivedExtraInfo'&&resExtra.length===1){assert.equal(e.params.statusCode,resExtra[0].params.statusCode);assert.deepEqual(headers(e.params.headers),headers(resExtra[0].params.headers));}
  }
  assert.equal(session.commands.length,2);assert.deepEqual(session.commands.map(c=>c.method).sort(),['Network.enable','Runtime.enable']);
  for(const c of session.commands){assert.equal(c.deadlineFailure,undefined);assert.equal(c.state,'fulfilled');}
  if(session.installResults!==undefined){assert.equal(session.installResults.length,2);assert(session.installResults.every(r=>r.status==='fulfilled'));}
  const binding=associateBinary({...x,s:session});return {...binding,grouping:receipt};
}

export async function observeGrouping({label,predicate,limit=6000,pause=ms=>new Promise(r=>setTimeout(r,ms)),now=()=>Date.now()}){
  const started=now();let timer,lastPending,expired=false;
  const work=(async()=>{for(;;){if(expired)throw Error(label+' retained observation deadline');try{const value=await predicate();if(expired||now()-started>limit)throw Error(label+' retained observation deadline');if(value)return {label,limitMs:limit,startedHostMs:started,completedHostMs:now(),value};}catch(error){if(!(error instanceof PendingGrouping))throw error;lastPending=String(error);}if(now()-started>=limit)throw Error(label+' unresolved at unchanged deadline: '+lastPending);await pause(20);}})();
  try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(Error(label+' unresolved at '+limit+'ms bound: '+lastPending));},limit);})]);}
  finally{clearTimeout(timer);if(expired)work.catch(()=>{});}
}
