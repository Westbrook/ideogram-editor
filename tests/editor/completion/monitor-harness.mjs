// Non-browser injected objects for exercising the real monitor control flow.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {completionMonitor} from './monitor.mjs';
import {EXPECTED} from './app-buffer-core.mjs';
import {injectedHostFinal} from './host-final-fixtures.mjs';
export async function monitorHarness({hostFactory=injectedHostFinal,fixture='combined',mode='NATIVE-COMPLETION'}={}){
 let origin='http://127.0.0.1:34567',epochIndex=1;const out=mkdtempSync(join(tmpdir(),'completion-wiring-')),calls=[],requests=[],bound={},initScripts=[],bindingNames=[],ui={sameTextarea:true,connected:true,editable:true,draftId:'draft',revision:'7',value:'Current literal',ready:false};let serverRows=[],listeners={},failDisable=false,withheldWasmResponse=false,captureHook,disableHook,workerCount=0,stateHook;
 const db=new DatabaseSync(join(out,'metadata.sqlite'));db.exec('CREATE TABLE commands (id TEXT PRIMARY KEY)');db.close();
 let ledger=join(out,'ledger.jsonl');const saveLedger=()=>writeFileSync(ledger,serverRows.map(x=>JSON.stringify(x)).join('\n'));saveLedger();
 // Explicit text-element fixtures, not a browser DOM or a blanket successful assertion stub.
 const publicText={contentinfo:['Accepted edits saved locally · Draft saved locally; not applied to the document'],elsewhere:[]},textQueries=[];
 const textLocator=(scope,text,options={})=>{
  assert.equal(typeof text,'string');const query={scope,text,exact:options.exact===true};textQueries.push(query);
  return {count:async()=>{const values=scope==='contentinfo'?publicText.contentinfo:[...publicText.contentinfo,...publicText.elsewhere,...(ui.ready?['Text preview ready. Accepted appearance is unchanged.']:[])];return values.filter(value=>query.exact?value===text:value.includes(text)).length;}};
 };
 const page=new EventEmitter(),context=new EventEmitter(),frame={page:()=>page};
 const owner={type:'page',targetId:'page',browserContextId:'context'},target=id=>({type:'worker',targetId:id,parentId:'page',parentFrameId:'page',browserContextId:'context',url:origin+EXPECTED.workerPath});
 const session=()=>Object.assign(new EventEmitter(),{send:async(method,params)=>{calls.push({method,params});if(method==='Runtime.enable')pageSession.emit('Runtime.executionContextCreated',{context:{id:epochIndex,uniqueId:'default-context-'+epochIndex,origin,auxData:{isDefault:true,frameId:'page'}}});if(method==='Runtime.addBinding'){bindingNames.push(params.name);bindRealm(params.name);}if(method==='Network.configureDurableMessages'&&Object.keys(params).length===0){disableHook?.();if(failDisable)throw Error('Injected disable failure');}if(method==='Target.getTargetInfo')return {targetInfo:owner};if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'page',loaderId:'document-loader-'+epochIndex,url:origin+'/'}}};if(method==='Network.getResponseBody'){const override=captureHook?.();return override??{base64Encoded:true,body:readFileSync('dist/app'+EXPECTED.wasmPath).toString('base64')};}return {};},detach:async()=>calls.push({method:'detach'})});
 const pageSession=session(),rootSession=session();
 const originalRequest=(path,{type='fetch',contentType='application/json',bytes=2,failed=false,requestId,pwResponseHeaders,nodeRequestHeaders,protocolResponseHeaders,headersReady,deferCallbacks=false}={})=>{
  const id=requests.length+1,url=origin+path,headers={host:new URL(origin).host,'sec-fetch-dest':type==='script'?'worker':'empty',accept:'*/*'},responseHeaders={'content-type':contentType,'content-length':String(bytes),'cache-control':'no-store','referrer-policy':'no-referrer'};
  const q={testId:id,url:()=>url,method:()=> 'GET',resourceType:()=>type,redirectedFrom:()=>null,redirectedTo:()=>null,frame:()=>frame,allHeaders:async()=>{if(headersReady)await headersReady;return {...headers};},failure:()=>failed?{errorText:'net::ERR_ABORTED'}:null,response:async()=>p};
  const p={request:()=>q,url:()=>url,status:()=>200,fromServiceWorker:()=>false,allHeaders:async()=>{if(headersReady)await headersReady;return {...responseHeaders,...pwResponseHeaders};}};let delivered=false;q.deliver=()=>{assert(!delivered);delivered=true;if(!(withheldWasmResponse&&path===EXPECTED.wasmPath))context.emit('response',p);context.emit(failed?'requestfailed':'requestfinished',q);};requests.push(q);context.emit('request',q);if(!deferCallbacks)q.deliver();
  const common={id,serverId:1,pid:server.pid},nodeResponseHeaders={...responseHeaders,'content-length':bytes};serverRows.push({kind:'request',...common,method:'GET',url:path,headers:{...headers,...nodeRequestHeaders},rawHeaders:Object.entries(headers).flat(),requestObject:true,responseObject:true,responseRequestSame:true},{kind:'header-return',...common,name:'writeHead',sameResponseObject:true,headersSent:true,status:200,headers:{...nodeResponseHeaders}},...['response','response-close'].map(kind=>({kind,...common,status:200,headers:{...nodeResponseHeaders},writableFinished:true,originalObjects:true})));saveLedger();
  const cdp=requestId??'request.'+id;pageSession.emit('Network.requestWillBeSentExtraInfo',{requestId:cdp,headers:{...headers}});pageSession.emit('Network.responseReceivedExtraInfo',{requestId:cdp,statusCode:200,headers:{...responseHeaders,...protocolResponseHeaders}});return q;
 };
 class NativeWorker extends EventEmitter {
  constructor(url){super();this.workerURL=String(url);this.targetId='worker-'+(++workerCount);page.emit('worker',this);rootSession.emit('Target.targetCreated',{targetInfo:target(this.targetId)});originalRequest(EXPECTED.workerPath,{type:'script',contentType:'text/javascript',bytes:EXPECTED.workerBytes,requestId:this.targetId});originalRequest(EXPECTED.wasmPath,{contentType:'application/wasm',bytes:EXPECTED.wasmBytes,failed:true});}
  url(){return this.workerURL;}addEventListener(name,fn){this.on(name,fn);}postMessage(){}terminate(){this.emit('close',this);rootSession.emit('Target.targetDestroyed',{targetId:this.targetId});}
 }
 let realm;const makeRealm=()=>vm.createContext({Worker:NativeWorker,crypto:webcrypto,location:{protocol:'http:',origin},document:{addEventListener:(name,fn)=>listeners['document-'+name]=fn},addEventListener:(name,fn)=>listeners[name]=fn});
 function bindRealm(name){realm[name]=payload=>pageSession.emit('Runtime.bindingCalled',{name,payload,executionContextId:epochIndex});}
 realm=makeRealm();
 Object.assign(page,{isClosed:()=>false,url:()=>origin+'/',context:()=>context,mainFrame:()=>frame,exposeBinding:async(name,fn)=>{bound[name]=fn;realm[name]=value=>Promise.resolve(fn({page,frame},structuredClone(value)));},evaluate:async(fn,arg)=>{realm.arg=arg;return structuredClone(await vm.runInContext('('+fn.toString()+')(arg)',realm));},locator:()=>({count:async()=>0,elementHandle:async()=>({evaluate:async()=>structuredClone(ui),dispose:async()=>{}})}),getByText:(text,options)=>textLocator('page',text,options),getByRole:role=>{assert.equal(role,'contentinfo');return {getByText:(text,options)=>textLocator('contentinfo',text,options)};}});
 Object.assign(context,{addInitScript:async(fn,arg)=>{initScripts.push([fn,arg]);realm.arg=arg;vm.runInContext('('+fn.toString()+')(arg)',realm);},newCDPSession:async p=>{assert.equal(p,page);return pageSession;},browser:()=>({newBrowserCDPSession:async()=>rootSession})});
 const expect=locator=>({toBeVisible:async()=>assert.equal(await locator.count(),1,'Exactly one matching visible text fixture'),toHaveCount:async count=>assert.equal(await locator.count(),count,'Matching text fixture count')});expect.poll=fn=>({toBe:async value=>assert.equal(await fn(),value)});
 const readState=()=>{stateHook?.();return {savedText:ui.value,document:{id:'document',revision:'2'},draft:{ui:{sessionId:'ui-session'},draft:{id:'draft',documentId:'document',expectedDocumentRevision:'2',generation:'3',status:'saved-unapplied'}},accepted:{document:{id:'document',revision:'2'}}};};
 const monitor=await completionMonitor({page,context,root:out,out,id:q=>q.testId,expect,readState,fixture,mode,hostFactory});
 const recorderFailures=[];let shutdownHook,shutdownReceiptHook;
 const servers=[];
 function makeServer(){const rows=serverRows,path=ledger,pid=122+epochIndex,instance=epochIndex===1?'instance':'instance-'+epochIndex;
  const save=()=>writeFileSync(path,rows.map(x=>JSON.stringify(x)).join('\n'));
  const sample=()=>({installed:true,originalInstallation:true,dispatchOwned:true,active:true,uninstalled:false,phase:'live',failures:structuredClone(recorderFailures),servers:1,requests:rows.filter(r=>r.kind==='request').length,rowCount:rows.length,lastSequence:rows.at(-1)?.sequence??0,pid,instance});
  const server={origin,pid,instance,recorder:async()=>sample(),shutdown:null,lifecycle:{pid,attempts:[],errors:[],messages:[],exit:null}};
  const close=()=>{if(server.shutdown)return;const before=sample();shutdownHook?.();rows.push({kind:'recorder-uninstall',restoredOriginal:true,sequence:rows.length+1,pid});save();server.shutdown={mode:'close',errors:[],exit:{code:0,signal:null},reply:{type:'completion-closed',cleanupOnly:false,serverClosed:true,failures:[],recorder:{kind:'graceful',before,after:{...sample(),phase:'closed',installed:false,active:false,dispatchOwned:false,uninstalled:true}}}};if(server.shutdown){server.lifecycle.exit=structuredClone(server.shutdown.exit);server.lifecycle.messages.push({type:'close-injected-control',value:structuredClone(server.shutdown.reply)});}shutdownReceiptHook?.(server,rows);save();};servers.push({server,close});return server;
 }
 let server=makeServer();const finish=monitor.finish;monitor.finish=async cleanup=>{for(const s of servers)s.close();return finish(cleanup);};monitor.begin(server,ledger);await monitor.activate();
 const nextEpoch=async({activate=true}={})=>{servers.at(-1).close();pageSession.emit('Runtime.executionContextDestroyed',{executionContextId:epochIndex});epochIndex++;origin='http://127.0.0.1:'+String(34566+epochIndex);serverRows=[];listeners={};ledger=join(out,'ledger-'+epochIndex+'.jsonl');saveLedger();realm=makeRealm();for(const name of bindingNames)bindRealm(name);for(const [fn,arg]of initScripts){realm.arg=arg;vm.runInContext('('+fn.toString()+')(arg)',realm);}pageSession.emit('Runtime.executionContextCreated',{context:{id:epochIndex,uniqueId:'default-context-'+epochIndex,origin,auxData:{isDefault:true,frameId:'page'}}});server=makeServer();monitor.begin(server,ledger);if(activate)await monitor.activate();};
 const nativeInput=()=>listeners['document-input']({isTrusted:true,target:{id:'native-text-content',value:'Late input',isConnected:true,readOnly:false,disabled:false,closest:()=>({getAttribute:k=>k==='data-session'?'draft':'8'})}});
 const nativeSuccess=async()=>{realm.workerURL=origin+EXPECTED.workerPath;vm.runInContext("globalThis.lastWorker=new Worker(workerURL,{type:'module',name:'ideogram-text-1'});lastWorker.emit('message',{data:{ready:true}});const token={documentId:'document',documentRevision:'2',sessionId:'ui-session',generation:3,layerId:'layer',layerVersion:'1'};lastWorker.postMessage({token,text:'Current literal'});lastWorker.emit('message',{data:{ok:true,value:{token,rasterHash:'sha256:'+'a'.repeat(64),rgba:{size:400},width:10,height:10}}});lastWorker.terminate();",realm);ui.ready=true;};const preview=async()=>monitor.operation('Preview',nativeSuccess);
 return {ui,publicText,textQueries,nativeSuccess,onReadState:fn=>stateHook=fn,withholdWasmResponse:()=>withheldWasmResponse=true,monitor,calls,out,page,get server(){return server;},get serverRows(){return serverRows;},get realm(){return realm;},nextEpoch,saveLedger,recorderFailures,onShutdown:fn=>shutdownHook=fn,onShutdownReceipt:fn=>shutdownReceiptHook=fn,context,pageSession,rootSession,target,originalRequest,nativeInput,preview,
  pagehide:async()=>{await monitor.depart('terminal');await realm.__integrationNativeCompletion.boundaryFlush();},
  setSnapshot:v=>{realm.__integrationNativeCompletion.snapshot=()=>v;},failDisable:()=>failDisable=true,onCapture:fn=>captureHook=fn,onDisable:fn=>disableHook=fn,
  record:()=>JSON.parse(readFileSync(join(out,'wasm-completion.json'))),
 };
}
