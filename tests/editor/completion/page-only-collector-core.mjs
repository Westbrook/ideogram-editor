import assert from 'node:assert/strict';
import {CASES,PAYLOAD,sha,workerSource,matchOwnedWorker,assessOrdinary} from './inspector-capability-core.mjs';
import {headers,pageIdentity,PageCollector} from './terminal-collector-core.mjs';
import {PendingGrouping,observeGrouping} from './grouped-collector-core.mjs';
export {PageCollector,PendingGrouping,observeGrouping};
export {POLICY,disableCollection,PublicWorkerLedger,rpcError,decodeBody,unavailable,UNAVAILABLE_MESSAGES} from './terminal-collector-core.mjs';
export const INPUTS=['page-only-collector-core.mjs','page-only-collector-controls.mjs','page-only-collector-series.mjs','terminal-collector-core.mjs','grouped-collector-core.mjs','inspector-capability-core.mjs','terminal-collector-fixture.mjs','inspector-capability-fixture.mjs','completion-contrast-flow.mjs','completion-contrast-flow-controls.mjs','completion-contrast-core.mjs','completion-contrast-fixture.mjs','completion-contrast-series.mjs','exclusive-controller-flow.mjs'];
function one(rows,label){assert(rows.length<=1,'Duplicate '+label);if(!rows.length)throw new PendingGrouping('Missing '+label);return rows[0];}
function subset(actual,expected){for(const [k,v]of Object.entries(headers(actual)))assert.equal(expected[k],v,'Observed header '+k);}
function checkRequest(p,url,expectedHeaders){assert.equal(p.request.url,url);assert.equal(p.request.method,'GET');assert.equal(p.redirectResponse,undefined);subset(p.request.headers??{},expectedHeaders);}
function checkResponse(p,url,expectedHeaders){assert.equal(p.response.url,url);assert.equal(p.response.status,200);assert.deepEqual(headers(p.response.headers),expectedHeaders);for(const key of ['fromDiskCache','fromServiceWorker'])if(p.response[key]!==undefined)assert.equal(p.response[key],false);}

function scriptMetadata(x){
  const {c,target,page,pageNetwork,scriptServer,scriptPWRequests,scriptPWResponses,servedScripts}=x;const s={targetId:target.targetId,targetInfo:target};
  pageIdentity(page);matchOwnedWorker(s.targetInfo,c,{targetId:page.targetId,contextId:page.contextId});assert.equal(s.targetInfo.parentFrameId,page.frameId);assert.equal(s.targetId,s.targetInfo.targetId);
  const scriptId=s.targetId;
  const starts=pageNetwork.filter(e=>e.name==='Network.requestWillBeSent'&&(e.params.requestId===scriptId||e.params.request?.url===c.workerURL));assert(starts.length<=1,'Duplicate owning Script start');const start=starts[0];
  if(start){assert.equal(start.params.requestId,scriptId);assert.equal(start.params.type,'Script');assert.equal(start.params.frameId,page.frameId);}
  const pageScript=pageNetwork.filter(e=>e.params.requestId===scriptId);
  const reqExtra=one(pageScript.filter(e=>e.name==='Network.requestWillBeSentExtraInfo'),'script request ExtraInfo');
  const resExtra=one(pageScript.filter(e=>e.name==='Network.responseReceivedExtraInfo'),'script response ExtraInfo');
  const reqHeaders=headers(reqExtra.params.headers),resHeaders=headers(resExtra.params.headers);
  assert.equal(resExtra.params.statusCode,200);assert.equal(reqHeaders.referer,page.origin+'/');assert.equal(reqHeaders['sec-fetch-dest'],'worker');
  if(start)checkRequest(start.params,c.workerURL,reqHeaders);
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
  return {scriptId,requestId:pwRequest.id,serverId:serverRequest.requestId,requestStartObserved:!!start,responseObserved:pageResponses.length===1,servedBytes:served.bytes,servedSHA256:served.sha256,receivedBodyProof:false};
}
export function assertNoWorkerCommands(commands){
 for(const row of commands){assert(!['Target.setAutoAttach','Target.attachToTarget','Target.attachToBrowserTarget','Target.sendMessageToTarget','Target.detachFromTarget'].includes(row.method),'No added worker protocol session or command');assert(['owned-page-CDPSession-1','owned-root-CDPSession-1'].includes(row.controllerSessionLabel),'Only retained page/root receiver');}
}
export class PageOnlyFlow {
 constructor(){this.row={mode:'page-only-fixed-fixture',discoveryAcknowledged:false,startedCases:[],bindings:[],active:null,workerProtocolCommands:'not applicable: no added session',jsExecutionContext:'not observed',workerProtocolTerminal:'not observed',workerObserverDetach:'not applicable'};}
 armDiscovery(ack,discovery){assert.equal(this.row.discoveryAcknowledged,false);assert(!discovery.some(e=>e.params?.targetInfo?.type==='worker'),'Discovery armed before any worker');this.row.discoveryAcknowledged=true;this.row.discoveryAcknowledgment=ack;}
 begin(c,collector,workers){assert(this.row.discoveryAcknowledged,'Discovery ACK before creation');assert.equal(this.row.active,null);assert.equal(c.id,CASES[this.row.startedCases.length]?.id);assert(workers.every(w=>w.closed),'One active designated worker');assert.equal(collector.row.installed,true);const creation=collector.create(c);this.row.startedCases.push(c);this.row.active=c.id;return {...creation,discoveryAcknowledged:true,pageCollectorAcknowledged:true};}
 finish(binding){assert.equal(binding.caseId,this.row.active);assert(!this.row.bindings.some(b=>[b.requestId,b.scriptId].includes(binding.requestId)||[b.requestId,b.scriptId].includes(binding.scriptId)),'No identity borrowed across cases');this.row.bindings.push({caseId:binding.caseId,requestId:binding.requestId,scriptId:binding.scriptId});this.row.active=null;}
}
function ownedTarget(x){
 const {c,page,discovery,startedCases}=x;const created=discovery.filter(e=>e.name==='Target.targetCreated'&&e.params.targetInfo.type==='worker');assert(created.length<=startedCases.length,'Duplicate discovered worker');if(created.length<startedCases.length)throw new PendingGrouping('Public worker discovery');
 const found=[];for(const event of created){const id=event.params.targetInfo.targetId,infos=discovery.filter(e=>['Target.targetCreated','Target.targetInfoChanged'].includes(e.name)&&e.params.targetInfo.targetId===id).map(e=>e.params.targetInfo);assert.equal(created.filter(e=>e.params.targetInfo.targetId===id).length,1);const urls=[...new Set(infos.map(t=>t.url).filter(Boolean))];assert(urls.length<=1,'Contradictory TargetInfo URLs');if(!urls.length)throw new PendingGrouping('Worker script URL from public TargetInfo');const designated=startedCases.filter(v=>v.workerURL===urls[0]);assert.equal(designated.length,1,'Every discovered worker belongs to one fixed case');for(const t of infos){assert.equal(t.type,'worker');assert.equal(t.parentId,page.targetId);assert.equal(t.parentFrameId,page.frameId);assert.equal(t.browserContextId,page.contextId);assert.equal(t.targetId,id);if(t.url)assert.equal(t.url,designated[0].workerURL);}const ends=discovery.filter(e=>e.name==='Target.targetDestroyed'&&e.params.targetId===id);one(ends,'actual worker target destruction');if(designated[0].id===c.id)found.push(infos.find(t=>t.url));}
 return one(found,'designated public worker TargetInfo');
}
export function auditRequests({page,startedCases,allPWRequests,allPWResponses,allPWTerminals,allServer,setupCount=1}){
 assert.deepEqual(startedCases.map(c=>c.id),CASES.slice(0,startedCases.length).map(c=>c.id));assert(startedCases.length>0&&startedCases.length<=3);
 const routes=new Map([[page.origin+'/',setupCount]]);for(const c of startedCases){assert.equal(c.url,page.origin+'/binary/192-fixed/'+c.id);assert.equal(c.workerURL,page.origin+'/worker/192-fixed/'+c.id+'.js');assert.equal(c.sent,CASES.find(v=>v.id===c.id).sent);assert.equal(c.advertised,CASES.find(v=>v.id===c.id).advertised);routes.set(c.url,1);routes.set(c.workerURL,1);}
 assert.equal(new Set(allPWRequests.map(q=>q.id)).size,allPWRequests.length,'Original PW Request IDs unique');const serverRequests=allServer.filter(e=>e.event==='request');assert.equal(new Set(serverRequests.map(q=>q.requestId)).size,serverRequests.length);
 for(const q of [...allPWRequests,...serverRequests]){assert(routes.has(q.url),'Unaccounted original request');assert.equal(q.method,'GET');if('redirectedFrom' in q)assert.equal(q.redirectedFrom,null);}
 for(const [url,n]of routes){for(const [label,rows]of [['PW',allPWRequests],['server',serverRequests]]){const count=rows.filter(q=>q.url===url).length;assert(count<=n,label+' duplicate request '+url);if(count<n)throw new PendingGrouping(label+' original request '+url);}}
 for(const p of allPWResponses){const q=one(allPWRequests.filter(q=>q.id===p.requestId),'PW response original request');assert.equal(p.url,q.url);assert.equal(p.originalRequestObject,true);assert.equal(p.fromServiceWorker,false);assert.equal(allPWResponses.filter(v=>v.requestId===q.id).length,1);}
 for(const t of allPWTerminals){const q=one(allPWRequests.filter(q=>q.id===t.requestId),'PW terminal original request');assert.equal(t.url,q.url);assert.equal(allPWTerminals.filter(v=>v.requestId===q.id).length,1,'Duplicate original Request terminal');}
 assert(!allServer.some(e=>['unexpected-route','duplicate-request','hold-deadline-reached'].includes(e.event)));
 return {routes:[...routes],originalRequests:allPWRequests.length,serverRequests:serverRequests.length};
}
export function associateMetadata(x){
 const {c,page,collector,pageNetwork,allPWRequests,allPWResponses,allPWTerminals,allServer,workerRows,consumer,startedCases}=x;
 pageIdentity(page);assert.equal(collector.installed,true);assert.deepEqual(collector.owner,page);assert(collector.creations.includes(c.id));const accounting=auditRequests(x);const target=ownedTarget(x);
 assert(workerRows.length<=startedCases.length);if(workerRows.length<startedCases.length)throw new PendingGrouping('Original public Worker object');assert.equal(new Set(workerRows.map(w=>w.id)).size,workerRows.length);for(const w of workerRows){assert.equal(startedCases.filter(c=>c.workerURL===w.url).length,1);assert.equal(workerRows.filter(v=>v.url===w.url).length,1);assert(w.originalObject);if(!w.closed)throw new PendingGrouping('Original public Worker closure');assert(w.closeSameObject);}
 const publicWorker=one(workerRows.filter(w=>w.url===c.workerURL),'original public Worker object');
 const scriptPWRequests=allPWRequests.filter(q=>q.url===c.workerURL),scriptPWResponses=allPWResponses.filter(q=>q.url===c.workerURL),scriptServer=allServer.filter(q=>q.scriptCase===c.id);
 const script=scriptMetadata({...x,target,scriptPWRequests,scriptPWResponses,scriptServer,servedScripts:x.servedScripts.filter(s=>s.caseId===c.id)});
 for(const t of allPWTerminals.filter(t=>t.requestId===script.requestId))assert.equal(t.kind,'finished','Script terminal failure retained');
 const q=one(allPWRequests.filter(q=>q.url===c.url),'binary PW Request'),p=one(allPWResponses.filter(p=>p.requestId===q.id),'binary PW Response'),terminal=one(allPWTerminals.filter(t=>t.requestId===q.id),'original binary PW Request terminal');
 assert.equal(q.frameExposure?.ownerPage,true);assert.equal(q.resourceType,'fetch');assert.equal(p.status,200);assert.equal(p.url,c.url);assert.equal(terminal.url,c.url);
 const request=one(allServer.filter(e=>e.event==='request'&&e.caseId===c.id),'binary server request'),head=one(allServer.filter(e=>e.event==='response-headers'&&e.caseId===c.id),'binary server headers');assert.equal(head.requestId,request.requestId);assert.equal(head.status,200);assert.equal(head.declaredBytes,c.advertised);one(allServer.filter(e=>e.event==='response-close'&&e.caseId===c.id),'binary server close');
 const reqHeaders=headers(request.headers),resHeaders=headers(p.headers);assert.deepEqual(headers(q.actualHeaders),reqHeaders);assert.equal(reqHeaders.referer,c.workerURL);assert.equal(resHeaders['content-length'],String(c.advertised));assert.equal(resHeaders['cache-control'],'no-store');subset(head.headers,resHeaders);
 const reqCandidates=pageNetwork.filter(e=>e.name==='Network.requestWillBeSentExtraInfo'&&headers(e.params.headers).referer===c.workerURL);const req=one(reqCandidates,'unique binary page ExtraInfo candidate');assert.deepEqual(headers(req.params.headers),reqHeaders);const requestId=req.params.requestId;assert(typeof requestId==='string'&&requestId);assert.notEqual(requestId,script.scriptId);
 const allowedIDs=new Set(x.discovery.filter(e=>e.params.targetInfo?.type==='worker').map(e=>e.params.targetInfo.targetId));for(const prior of startedCases){const pair=one(pageNetwork.filter(e=>e.name==='Network.requestWillBeSentExtraInfo'&&headers(e.params.headers).referer===prior.workerURL),'one binary ID per started case');assert(!allowedIDs.has(pair.params.requestId),'Binary ID distinct from all script IDs');allowedIDs.add(pair.params.requestId);}for(const e of pageNetwork)if((e.name==='Network.requestWillBeSent'&&e.params.request?.url===page.origin+'/')||(e.name==='Network.responseReceived'&&e.params.response?.url===page.origin+'/'))allowedIDs.add(e.params.requestId);for(const e of pageNetwork){if(e.params.requestId!==undefined)assert(allowedIDs.has(e.params.requestId),'Unaccounted page network request ID');if(e.name==='Network.requestWillBeSent')assert(accounting.routes.some(([url])=>url===e.params.request.url),'Unaccounted page request URL');}

 const extra=pageNetwork.filter(e=>e.params.requestId===requestId);assert.equal(extra.filter(e=>e.name==='Network.requestWillBeSentExtraInfo').length,1);const response=one(extra.filter(e=>e.name==='Network.responseReceivedExtraInfo'),'binary same-ID response ExtraInfo');assert.equal(response.params.statusCode,200);assert.deepEqual(headers(response.params.headers),resHeaders);
 for(const e of extra){if(e.name==='Network.requestWillBeSent')checkRequest(e.params,c.url,reqHeaders);if(e.name==='Network.responseReceived')checkResponse(e.params,c.url,resHeaders);if(e.name==='Network.loadingFinished')assert.equal(terminal.kind,'finished');if(e.name==='Network.loadingFailed'){assert.equal(terminal.kind,'failed');assert.equal(e.params.errorText,terminal.failure?.errorText);}}
 for(const name of ['Network.requestWillBeSent','Network.responseReceived','Network.loadingFinished','Network.loadingFailed'])assert(extra.filter(e=>e.name===name).length<=1,'Duplicate optional page event');assert(extra.filter(e=>['Network.loadingFinished','Network.loadingFailed'].includes(e.name)).length<=1);
 assert.equal(consumer.sameWorkerEvent,true);assert.equal(consumer.terminationCalled,true);assert.equal(consumer.result.caseId,c.id);assert.equal(consumer.result.url,c.url);assessOrdinary(c,consumer.result);
 if(c.id==='complete')assert.equal(terminal.kind,'finished');else{assert.equal(terminal.kind,'failed');assert.equal(terminal.failure?.errorText,c.id==='short'?'net::ERR_CONTENT_LENGTH_MISMATCH':'net::ERR_ABORTED');}
 return {caseId:c.id,requestId,scriptId:script.scriptId,owningPage:page,publicTarget:target,publicWorker,script,terminal:{...terminal,evidenceKind:'original public Playwright Request terminal; not worker CDP'},consumerOutcome:consumer.result.error??{eof:consumer.result.eof,bytes:consumer.result.bytes},accounting,requestExtra:req,responseExtra:response,metadataOnly:true,jsExecutionContext:'not observed',workerCDPTerminal:'not observed',workerObserverDetach:'not applicable'};
}
export function associatePage(x){
 const b=associateMetadata(x);assert.notEqual(x.collector.disabled,true);assert.equal(b.terminal.originalRequestObject,true,'Retained terminal object receipt');assert.equal(x.terminalObjectProof,true,'Actual original Request terminal object');assert.equal(x.pwObjectProof,true,'Actual Request.response original object');assert.equal(x.creation.discoveryAcknowledged,true);assert.equal(x.creation.pageCollectorAcknowledged,true);assert.equal(x.creation.caseId,x.c.id);assert.equal(x.flow.discoveryAcknowledged,true);assert.equal(x.flow.active,x.c.id);assert.deepEqual(x.flow.startedCases,x.startedCases);assertNoWorkerCommands(x.commands);
 for(const prior of x.flow.bindings)assert(![prior.requestId,prior.scriptId].some(id=>[b.requestId,b.scriptId].includes(id)),'Cross-case identity borrowing');return {...b,metadataOnly:false,passed:true,scope:'New page-only fixed one-worker/one-fetch fixture contract; no JS-realm/general application attribution'};
}
