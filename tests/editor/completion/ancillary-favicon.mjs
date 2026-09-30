import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {normalizedHeaders} from './host-final-headers.mjs';

const digest=b=>createHash('sha256').update(b).digest('hex');
const CORE_SHA='549070af3acabb3efcc4f55bfe6210f9f7c2fcf633cf7eaa59bfe60719969171';
const one=(xs,label)=>{assert.equal(xs.length,1,'Ancillary '+label);return xs[0];};
const same=(a,b,label)=>assert.deepEqual(normalizedHeaders(a),normalizedHeaders(b),'Ancillary '+label);
const flags=()=>({qualified:false,pwQualified:false,byteQualified:false,nativeQualified:false,wasmQualified:false,hostFinalQualified:false,transportQualified:false,errorWaiver:false,consumerEOF:false});

export function faviconSourceProof(){
 const core=readFileSync('node_modules/playwright-core/lib/coreBundle.js'),pkg=JSON.parse(readFileSync('node_modules/playwright-core/package.json')),html=readFileSync('dist/app/index.html','utf8');
 assert.equal(pkg.version,'1.63.0');assert.equal(digest(core),CORE_SHA,'Pinned Playwright favicon suppression source');
 const noStaticIcon=!readdirSync('dist/app').includes('favicon.ico');
 const noIconLinkSource=![...html.matchAll(/<link\b[^>]*>/gi)].some(m=>/\brel\s*=\s*["'][^"']*\bicon\b/i.test(m[0]));
 assert(noStaticIcon&&noIconLinkSource,'No product favicon source');
 return {version:pkg.version,coreSHA256:CORE_SHA,indexSHA256:digest(html),noStaticIcon,noIconLinkSource};
}

function rawHeaders(values){
 assert(Array.isArray(values)&&values.length%2===0,'Ancillary raw headers');const out={};
 for(let i=0;i<values.length;i+=2){assert.equal(typeof values[i],'string');assert.equal(typeof values[i+1],'string');const k=values[i].toLowerCase();assert(!(k in out),'Ancillary duplicate raw header');out[k]=values[i+1];}return out;
}

function nodeResponse(rows,request){
 const allowed=new Set(['request','header-call','header-return','response','response-close']);let sequence=-1;
 for(const row of rows){assert(allowed.has(row.kind),'Ancillary unexplained server row');assert(Number.isSafeInteger(row.sequence)&&row.sequence>sequence,'Ancillary server sequence');sequence=row.sequence;
  for(const k of ['id','pid','serverId','method','url','path'])assert.equal(row[k],request[k],'Ancillary server owner '+k);
  assert(row.requestObject&&row.responseObject&&row.responseRequestSame,'Ancillary original server objects');}
 assert.equal(rows[0],request);const finish=one(rows.filter(r=>r.kind==='response'),'Node finish'),close=one(rows.filter(r=>r.kind==='response-close'),'Node close');
 assert.equal(rows.at(-2),finish);assert.equal(rows.at(-1),close);const calls=rows.slice(1,-2),stack=[];let declared={},wrote=false,writeSeen=false,writeHeaders;
 assert(calls.length>0,'Ancillary header calls');
 for(const row of calls){
  assert(row.sameResponseObject,'Ancillary original header call');
  if(row.kind==='header-call'){
   assert(!wrote,'Ancillary header after writeHead');
   if(row.name==='writeHead'){
    assert(!writeSeen&&stack.length===0,'Ancillary unique outer writeHead');writeSeen=true;
    assert.equal(row.statusBefore,200);assert.equal(row.args.length,2);assert.equal(row.args[0],404);
    writeHeaders=normalizedHeaders(row.args[1]);assert.deepEqual(writeHeaders,{'content-type':'application/json; charset=utf-8'},'Ancillary original writeHead headers');
    stack.push({name:row.name,nested:false});
   }else{
    assert.equal(row.name,'setHeader','Ancillary fixed header API');assert.equal(row.args.length,2);
    const next=normalizedHeaders({[row.args[0]]:row.args[1]}),nested=stack.length>0;
    assert(!Object.keys(next).some(k=>k in declared),'Ancillary repeated declared header');
    if(nested){assert.equal(stack.length,1);assert.equal(stack[0].name,'writeHead');assert.deepEqual(next,writeHeaders,'Ancillary nested declaration');assert.equal(row.statusBefore,404);}
    else {assert(!writeSeen);assert.equal(row.statusBefore,200);}
    Object.assign(declared,next);stack.push({name:row.name,nested});
   }
  }else{
   assert.equal(row.kind,'header-return','Ancillary header nesting');const call=stack.pop();assert(call&&call.name===row.name,'Ancillary matching header return');
   assert(row.returnIsResponse&&row.returnType==='object','Ancillary original header return');same(row.headers,declared,'header return snapshot');
   if(row.name==='writeHead'){assert.equal(stack.length,0);assert.equal(row.status,404);assert.equal(row.headersSent,true);for(const [k,v]of Object.entries(writeHeaders))assert.equal(declared[k],v,'Ancillary effective writeHead declaration');wrote=true;}
   else {assert.equal(row.headersSent,false);assert.equal(row.status,call.nested?404:200);}
  }
 }
 assert.equal(stack.length,0,'Ancillary incomplete header call');
 assert(wrote,'Ancillary writeHead required');
 for(const row of [finish,close]){assert.equal(row.status,404);assert(row.originalObjects&&row.writableFinished,'Ancillary completed Node response');same(row.headers,declared,'Node drain headers');}
 assert(finish.headersSent&&close.destroyed,'Ancillary original Node finish/close');
 assert.equal(declared['content-type'],'application/json; charset=utf-8');
 for(const [k,v]of Object.entries({'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff','cross-origin-resource-policy':'same-origin','x-frame-options':'DENY','connection':'close'}))assert.equal(declared[k],v,'Ancillary security '+k);
 assert.equal(declared['content-length'],undefined);assert.equal(declared['transfer-encoding'],undefined);
 return declared;
}

// A distinct negative observation, never a transport or consumption proof.
function canceledFavicon(x,a,w,starts,related){
 const {origin,epoch,owner,frame,serverOwner,source}=a,url=origin+'/favicon.ico';
 assert(w&&w.kind==='ORIGINAL-RESTORED-ROUTE-WINDOW','Canceled ancillary original route window required');
 assert.equal(w.mode,'RESTORED-NON-NATIVE','Canceled ancillary restored mode only');assert.equal(w.fixture,'restored-reads');assert.equal(w.epochIndex,2,'Canceled ancillary second epoch only');assert.equal(w.epoch,epoch);assert.deepEqual(w.owner,owner,'Canceled ancillary route owner');assert.deepEqual(w.serverOwner,serverOwner,'Canceled ancillary route server');
 assert(/^\/api\/v1\/assets\/[^/]+\/content$/.test(w.path));assert.equal(w.pattern,'**'+w.path);
 const receipts=[w.registration,w.begin,w.removing,w.removed],kinds=['route-registration-completed','restoration-window-start','route-removal-start','route-removal-completed'];
 for(let i=0;i<receipts.length;i++){const r=receipts[i];assert(r&&r.kind===kinds[i],'Canceled ancillary route receipt kind');assert(Number.isSafeInteger(r.sequence)&&r.sequence>0&&(!i||r.sequence>receipts[i-1].sequence),'Canceled ancillary route receipt order');assert.equal(r.epochIndex,i===0?1:2);if(i!==1){assert.equal(r.registration,0);assert.equal(r.pattern,w.pattern);assert.equal(r.path,w.path);}else for(const k of ['origin','pid','instance'])assert.equal(r[k],serverOwner[k]);}
 assert.equal(related.length,0,'Canceled ancillary no retained server witness');assert(!x.server.some(r=>{try{return new URL(r.url??r.path??'/',origin).pathname==='/favicon.ico'||r.path==='/favicon.ico';}catch{return false;}}),'Canceled ancillary no foreign server witness');
 assert(![...x.requests,...x.responses,...x.terminals].some(q=>{try{return new URL(q.url).pathname==='/favicon.ico';}catch{return false;}}),'Canceled ancillary no original PW witness');
 const start=one(starts,'canceled unique protocol start'),id=start.params.requestId;assert(typeof id==='string'&&id,'Canceled ancillary original protocol ID');const rows=x.network.filter(n=>n.params.requestId===id);
 assert.equal(rows.length,2,'Canceled ancillary exactly original start and terminal');assert(!x.network.some(n=>!rows.includes(n)&&[n.params.request?.url,n.params.response?.url].some(value=>{try{return new URL(value).pathname==='/favicon.ico';}catch{return false;}})),'Canceled ancillary no other favicon protocol witness');assert.equal(rows[0],start,'Canceled ancillary original start order');const terminal=rows[1];assert.equal(terminal.name,'Network.loadingFailed','Canceled ancillary original failed terminal');
 for(const n of rows){assert.equal(n.controllerSessionLabel,owner.sessionId,'Canceled ancillary controller');assert(Number.isSafeInteger(n.sequence)&&n.sequence>w.begin.sequence&&n.sequence>w.registration.sequence&&n.sequence<w.removing.sequence,'Canceled ancillary strictly inside observed route window');}
 assert(start.sequence<terminal.sequence,'Canceled ancillary original terminal order');
 const p=start.params,q=p.request,t=terminal.params;
 assert.equal(q.url,url,'Canceled ancillary exact URL');assert.equal(q.method,'GET','Canceled ancillary GET');assert.equal(p.type,'Other','Canceled ancillary type');assert.equal(t.type,'Other','Canceled ancillary terminal type');assert.deepEqual(p.initiator,{type:'other'},'Canceled ancillary initiator');assert.equal(p.frameId,frame.id,'Canceled ancillary frame');assert.equal(p.loaderId,frame.loaderId,'Canceled ancillary loader');assert.equal(p.documentURL,frame.url,'Canceled ancillary document');
 assert.equal(p.redirectResponse,undefined,'Canceled ancillary no redirect');assert.equal(p.redirectHasExtraInfo,false);for(const k of ['hasPostData','postData','postDataEntries'])assert.equal(q[k],undefined,'Canceled ancillary no request body');assert.equal(q.referrerPolicy,'no-referrer','Canceled ancillary referrer policy');
 const h=normalizedHeaders(q.headers);assert(h.referer===undefined||h.referer==='','Canceled ancillary no referrer');assert.equal(h['content-length'],undefined,'Canceled ancillary no content length');assert.equal(h['transfer-encoding'],undefined,'Canceled ancillary no framing');assert(!Object.entries(h).some(([k,v])=>k==='sec-fetch-dest'&&v==='worker'||k==='content-type'&&v.split(';')[0]==='application/wasm'),'Canceled ancillary native headers forbidden');
 assert.equal(t.errorText,'net::ERR_ABORTED','Canceled ancillary abort text');assert.equal(t.canceled,true,'Canceled ancillary canceled flag');assert.equal(t.blockedReason,undefined,'Canceled ancillary no other blocked reason');assert.equal(t.corsErrorStatus,undefined,'Canceled ancillary no CORS error');
 return {record:structuredClone({kind:'OBSERVED-CANCELED-FAVICON-NO-SERVER-WITNESS',outcome:'observed ancillary cancellation; no server witness in retained owned recorder',epoch,owner,frame,defaultContext:a.defaultContext,serverOwner,source,protocolId:id,url,routeWindow:structuredClone(w),cancellationCause:'unobserved',preNetworkDispatch:'unproved',serverWitness:false,pwExposure:false,responseObserved:false,bodyObserved:false,bodyHash:null,protocolRows:rows,observedEOF:false,transportSuccessClaim:false,...flags()}),rows};
}

// This accounts only for metadata which public Playwright deliberately omits.
// Original arrays and every positive proof core are left untouched.
export function accountFavicon(x,admission,{previous,cancellation}={}){
 const {origin,epoch,owner,frame,serverOwner,source,noPublicIconLink,defaultContext}=admission;
 assert.equal(x.page.origin,origin);assert.deepEqual(x.page,owner,'Ancillary owner');assert.equal(epoch,x.epoch);assert.equal(x.currentEpoch,epoch);assert(epoch&&frame&&defaultContext,'Ancillary admitted identity');
 assert.equal(frame.id,owner.frameId);assert.equal(frame.url,origin+'/');assert(typeof frame.loaderId==='string'&&frame.loaderId,'Ancillary original document loader');
 assert.equal(defaultContext.epoch,epoch);assert.equal(defaultContext.frameId,owner.frameId);assert.equal(defaultContext.origin,origin);assert(Number.isSafeInteger(defaultContext.id)&&defaultContext.id>0&&typeof defaultContext.uniqueId==='string'&&defaultContext.uniqueId,'Ancillary original default-context binding');
 assert.equal(noPublicIconLink,true,'Ancillary public icon link');assert.equal(source.version,'1.63.0');assert.equal(source.coreSHA256,CORE_SHA);assert(source.noStaticIcon&&source.noIconLinkSource,'Ancillary source admission');assert(/^[a-f0-9]{64}$/.test(source.indexSHA256));
 assert.equal(x.recorder.pid,serverOwner.pid);assert.equal(x.recorder.instance,serverOwner.instance);assert(serverOwner.instance);assert.equal(serverOwner.origin,origin);assert.equal(x.recorder.originalInstallation,true);assert.deepEqual(x.recorder.failures,[],'Ancillary recorder errors');assert.equal(x.recorder.servers,1);
 const url=origin+'/favicon.ico',node=x.server.filter(r=>r.kind==='request'&&(r.path==='/favicon.ico'||r.url===url)),starts=x.network.filter(n=>n.name==='Network.requestWillBeSent'&&n.params.request.url===url),regular=x.network.filter(n=>n.name==='Network.responseReceived'&&n.params.response.url===url);
 const related=x.server.filter(r=>r.path==='/favicon.ico'||r.url==='/favicon.ico'||r.url===url),records=[],removedServer=new Set(),removedNetwork=new Set();
 const canceledStarts=x.network.filter(n=>n.name==='Network.requestWillBeSent'&&(()=>{try{return new URL(n.params.request.url).pathname==='/favicon.ico';}catch{return false;}})());
 const failedCandidate=canceledStarts.some(n=>x.network.some(t=>t.params.requestId===n.params.requestId&&t.name==='Network.loadingFailed'));
 if(failedCandidate&&!node.length){
  const result=canceledFavicon(x,admission,cancellation,canceledStarts,related);records.push(result.record);for(const row of result.rows)removedNetwork.add(row);
 }else if(related.length||node.length||starts.length||regular.length){
  assert(![...x.requests,...x.responses,...x.terminals].some(q=>q.url===url),'Ancillary unexpected public PW exposure');
  const request=one(node,'unique server request'),start=one(starts,'unique protocol start'),response=one(regular,'unique protocol response');
  assert.equal(request.url,'/favicon.ico','Ancillary exact path');assert.equal(request.path,'/favicon.ico');assert.equal(request.method,'GET');assert.equal(request.pid,serverOwner.pid);assert.equal(request.serverId,1);assert(Number.isSafeInteger(request.id)&&request.id>0);assert.equal(request.localPort,Number(new URL(origin).port));assert(['127.0.0.1','::ffff:127.0.0.1'].includes(request.localAddress));
  const id=start.params.requestId;assert(typeof id==='string'&&id);assert.equal(response.params.requestId,id);const rows=x.network.filter(n=>n.params.requestId===id),serverRows=x.server.filter(r=>r.id===request.id||r.path==='/favicon.ico'||r.url==='/favicon.ico'||r.url===url);
  assert(serverRows.every(r=>r.id===request.id),'Ancillary orphan server row');
  const allowed=new Set(['Network.requestWillBeSent','Network.requestWillBeSentExtraInfo','Network.responseReceived','Network.responseReceivedExtraInfo','Network.dataReceived','Network.loadingFinished']);let sequence=-1;
  for(const n of rows){assert(allowed.has(n.name),'Ancillary failed/cache/unexplained protocol row');assert.equal(n.controllerSessionLabel,owner.sessionId,'Ancillary controller');assert(Number.isSafeInteger(n.sequence)&&n.sequence>sequence,'Ancillary protocol sequence');sequence=n.sequence;}
  const reqExtra=one(rows.filter(n=>n.name==='Network.requestWillBeSentExtraInfo'),'request ExtraInfo'),resExtra=one(rows.filter(n=>n.name==='Network.responseReceivedExtraInfo'),'response ExtraInfo'),terminal=one(rows.filter(n=>n.name==='Network.loadingFinished'),'finished terminal');
  assert.equal(rows.filter(n=>n.name==='Network.requestWillBeSent').length,1);assert.equal(rows.filter(n=>n.name==='Network.responseReceived').length,1);
  for(const n of [start,response]){assert.equal(n.params.frameId,frame.id,'Ancillary frame');assert.equal(n.params.loaderId,frame.loaderId,'Ancillary loader');assert.equal(n.params.type,'Other');}
  assert.equal(start.params.documentURL,frame.url);assert.equal(start.params.request.method,'GET');assert.equal(start.params.redirectResponse,undefined);assert.equal(start.params.redirectHasExtraInfo,false);assert.equal(start.params.request.hasPostData,undefined);assert.equal(start.params.request.postData,undefined);assert.equal(start.params.request.referrerPolicy,'no-referrer');assert.deepEqual(start.params.initiator,{type:'other'});
  const incoming=rawHeaders(request.rawHeaders);same(incoming,request.headers,'raw incoming snapshot');same(reqExtra.params.headers,incoming,'full incoming ExtraInfo');assert.equal(incoming.host,new URL(origin).host);assert.equal(incoming['sec-fetch-dest'],'image');assert.equal(incoming['sec-fetch-mode'],'no-cors');assert.equal(incoming['sec-fetch-site'],'same-origin');assert.equal(incoming.referer,undefined);assert.equal(incoming['content-length'],undefined);
  const partial=normalizedHeaders(start.params.request.headers),hint=partial.referer;delete partial.referer;assert(hint===undefined||hint==='','Ancillary no-referrer hint');for(const [k,v]of Object.entries(partial))assert.equal(incoming[k],v,'Ancillary regular request header '+k);
  const outgoing=nodeResponse(serverRows,request),wire=normalizedHeaders(resExtra.params.headers),rsp=response.params.response;
  assert.equal(resExtra.params.statusCode,404);assert.equal(rsp.status,404);assert.equal(rsp.statusText,'Not Found');assert.equal(rsp.mimeType,'application/json');assert.equal(rsp.charset,'utf-8');assert.equal(response.params.hasExtraInfo,true);
  for(const k of ['fromDiskCache','fromServiceWorker','fromPrefetchCache'])assert.equal(rsp[k],false,'Ancillary substituted response '+k);
  same(rsp.headers,wire,'regular response versus ExtraInfo');for(const [k,v]of Object.entries(outgoing))assert.equal(wire[k],v,'Ancillary outgoing header '+k);
  const automatic=Object.fromEntries(Object.entries(wire).filter(([k])=>!(k in outgoing)));assert.deepEqual(Object.keys(automatic).sort(),['date','transfer-encoding']);assert.equal(automatic['transfer-encoding'],'chunked');assert(Number.isFinite(Date.parse(automatic.date)),'Ancillary wire date');
  const lines=resExtra.params.headersText?.split('\r\n');assert(lines&&lines[0]==='HTTP/1.1 404 Not Found'&&lines.at(-1)===''&&lines.at(-2)==='','Ancillary raw response headers');const raw=[];for(const line of lines.slice(1,-2)){const at=line.indexOf(':');assert(at>0);raw.push(line.slice(0,at),line.slice(at+1).trim());}same(rawHeaders(raw),wire,'raw response ExtraInfo');
  const data=rows.filter(n=>n.name==='Network.dataReceived');assert(data.length>0);for(const n of data)for(const k of ['dataLength','encodedDataLength'])assert(Number.isSafeInteger(n.params[k])&&n.params[k]>=0,'Ancillary data counter');assert(Number.isSafeInteger(terminal.params.encodedDataLength)&&terminal.params.encodedDataLength>0,'Ancillary terminal counter');assert(terminal.sequence>response.sequence&&data.every(n=>n.sequence<terminal.sequence),'Ancillary terminal order');
  const csp=outgoing['content-security-policy'];for(const clause of ["default-src 'self'",'connect-src '+origin,"worker-src 'self'","object-src 'none'","frame-ancestors 'none'","base-uri 'none'","form-action 'none'"])assert(csp?.split(';').map(s=>s.trim()).includes(clause),'Ancillary CSP '+clause);
  records.push({kind:'BROWSER-FAVICON-METADATA',epoch,owner,frame,serverOwner,source,serverId:request.id,protocolId:id,url,status:404,pwExposure:false,bodyObserved:false,bodyHash:null,regularRefererHint:hint??null,automaticWireHeaders:automatic,counters:{data:data.reduce((n,r)=>n+r.params.dataLength,0),encodedData:data.reduce((n,r)=>n+r.params.encodedDataLength,0),terminalEncoded:terminal.params.encodedDataLength},serverRows:structuredClone(serverRows),protocolRows:structuredClone(rows),...flags()});
  for(const row of serverRows)removedServer.add(row);for(const row of rows)removedNetwork.add(row);
 }
 const account={kind:'ANCILLARY-METADATA-ONLY',epoch,records,...flags()};if(previous)assert.deepEqual(account,previous,'Ancillary late identity/cardinality contradiction');
 return {server:x.server.filter(r=>!removedServer.has(r)),network:x.network.filter(r=>!removedNetwork.has(r)),account};
}
