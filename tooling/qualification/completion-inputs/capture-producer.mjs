import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import vm from 'node:vm';
const sha=b=>createHash('sha256').update(b).digest('hex'),require=createRequire(resolve('package.json'));
const common=resolve('node_modules/playwright/lib/common/index.js'),bundle=resolve('node_modules/playwright-core/lib/coreBundle.js');
function evaluationPath(){
 const source=readFileSync(bundle,'utf8'),start=source.indexOf('function normalizeEvaluationExpression('),end=source.indexOf('\nfunction isJavaScriptErrorInEvaluate',start);assert(start>0&&end>start);
 const normalizer=source.slice(start,end),assignment=source.split('\n').find(l=>l.startsWith('    source3 = '));assert(assignment);
 const utility=vm.runInNewContext(assignment.slice(assignment.indexOf('=')+1).trim().replace(/;$/,''));assert(utility.includes('class')&&utility.includes('UtilityScript'));
 return {normalizer,utility,normalize:vm.runInNewContext('('+normalizer+')')};
}
function registered(installer,expression,path){
 const arg={key:'observer',binding:'boundary',hostKey:'host',registration:{epoch:'epoch',namespace:'own:',context:{id:3},nonce:'nonce',path:'/private/final'}};
 const context=vm.createContext({TextEncoder,URL,module:{exports:{}},setTimeout,clearTimeout});
 vm.runInContext(`globalThis.window=globalThis;globalThis.location={protocol:'http:',href:'http://127.0.0.1:34567/',origin:'http://127.0.0.1:34567'};globalThis.registrations=[];globalThis.addEventListener=(type,callback,options)=>registrations.push({type,callback,options,target:window});globalThis.Navigator=class Navigator {sendBeacon(){return true;}};globalThis.navigator=new Navigator();globalThis.host={pageshows:[],errors:[]};globalThis.observation={epoch:'epoch',rows:[],errors:[]};globalThis.observer={snapshot:()=>observation};globalThis.boundary=()=>{};globalThis.sessionStorage={setItem(){}};`,context);
 vm.runInContext(path.utility,context);context.controlArg=arg;context.expression=expression;
 const envelope=vm.runInContext(`({isFunction:true,returnByValue:true,expression,argCount:1,argsAndHandles:[serializeAsCallArgument(controlArg,value=>({fallThrough:value}))]})`,context);
 context.envelope=envelope;
 vm.runInContext(`globalThis.utility=new (module.exports.UtilityScript())(globalThis,false);globalThis.installed=utility.evaluate(envelope.isFunction,envelope.returnByValue,envelope.expression,envelope.argCount,...envelope.argsAndHandles);`,context);
 const registrations=context.registrations.map(r=>({type:r.type,once:r.options?.once,ownWindow:r.target===context.window,name:r.callback.name,source:Function.prototype.toString.call(r.callback)}));
 assert.equal(registrations.length,1);const row=registrations[0];assert.equal(row.type,'pagehide');assert.equal(row.once,true);assert(row.ownWindow);assert.equal(row.name,'genuineIntegrationHostFinal');
 return {installer,expression,envelope:JSON.parse(JSON.stringify(envelope)),registrations,handler:row.source,nonBrowser:true,nativeMethodIsSimulated:true,trustedEventClaim:false};
}
if(process.argv[2]==='--capture'){
 const [logical,out]=process.argv.slice(3),moduleUrl=pathToFileURL(logical).href;mkdirSync(out,{recursive:true});
 for(const k of ['PW_DISABLE_TS_ESM','PLAYWRIGHT_FORCE_ASYNC_LOADER','PW_TEST_SOURCE_TRANSFORM','PW_TEST_SOURCE_TRANSFORM_SCOPE'])assert.equal(process.env[k],undefined);
 const {transform,cc}=require(common),mod=await transform.requireOrImport(logical);assert.equal(Object.prototype.toString.call(mod),'[object Module]');
 const cache=cc.serializeCompilationCache(),rows=cache.memoryCache.filter(([f])=>f===logical);assert.equal(rows.length,1);const entry=rows[0][1];assert.equal(entry.moduleUrl,moduleUrl);
 const input=readFileSync(logical,'utf8'),code=transform.transformHook(input,logical,moduleUrl).code,map=readFileSync(entry.sourceMapPath,'utf8');assert.deepEqual(JSON.parse(map).sourcesContent,[input]);
 const path=evaluationPath(),installer=Function.prototype.toString.call(mod.installHostFinal),expression=path.normalize(installer,true),capture=registered(installer,expression,path);
 const result={...capture,pid:process.pid,node:process.version,logical,moduleUrl,inputSHA256:sha(input),bundleSHA256:sha(readFileSync(bundle)),commonSHA256:sha(readFileSync(common)),normalizerSHA256:sha(path.normalizer),utilitySHA256:sha(path.utility),installerSHA256:sha(installer),expressionSHA256:sha(expression),injectionSHA256:sha(JSON.stringify(capture.envelope)),handlerSHA256:sha(capture.handler),entry};
 for(const [name,text]of [['result.json',JSON.stringify(result,null,2)],['input.mjs',input],['transformed.mjs',code],['source.map',map],['normalizer.js',path.normalizer],['utility-script.js',path.utility],['installer.js',installer],['expression.js',expression],['handler.js',capture.handler]])writeFileSync(join(out,name),text);
 process.exit(0);
}
const out=resolve(process.env.EDITOR_RECEIPT);mkdirSync(out,{recursive:true});const result={started:new Date().toISOString(),passed:false,children:[],scope:'NON-BROWSER pinned Playwright ESM evaluation/VM callback generation; no live event or native method claim'};
try{
 const logical=resolve(process.argv[2]==='--generate'?'../evidence/318-pre-edit/source/tests/editor/completion/host-final-page.mjs':'tests/editor/completion/host-final-page.mjs');
 for(const name of ['first','independent']){const dest=join(out,name);const child=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--capture',logical,dest],{encoding:'utf8',env:{...process.env,PWTEST_CACHE_DIR:join(dest,'cache')}});writeFileSync(join(out,name+'.log'),child.stdout+child.stderr);result.children.push({name,pid:child.pid,exit:child.status,signal:child.signal});assert.equal(child.status,0,child.stderr);}
 const a=JSON.parse(readFileSync(join(out,'first/result.json'))),b=JSON.parse(readFileSync(join(out,'independent/result.json')));assert.notEqual(a.pid,b.pid);for(const k of ['installer','expression','handler','installerSHA256','expressionSHA256','injectionSHA256','handlerSHA256'])assert.equal(a[k],b[k]);assert.deepEqual(a.registrations,b.registrations);
 if(process.argv[2]==='--generate'){
  const artifact={installerSource:a.installer,installerSHA256:a.installerSHA256,evaluationExpression:a.expression,expressionSHA256:a.expressionSHA256,referenceInjection:a.envelope,referenceInjectionSHA256:a.injectionSHA256,handlerSHA256:a.handlerSHA256,normalizerSHA256:a.normalizerSHA256,utilitySHA256:a.utilitySHA256,bundleSHA256:a.bundleSHA256,commonSHA256:a.commonSHA256};
  writeFileSync(join(out,'host-handler-artifact.mjs'),'// Generated from independently captured pinned Playwright ESM/VM registration; no browser proof.\nexport const HOST_HANDLER_SOURCE='+JSON.stringify(a.handler)+';\nexport const HOST_HANDLER_ARTIFACT=Object.freeze('+JSON.stringify(artifact,null,2)+');\n');
 }else{
  const artifact=await import(pathToFileURL(resolve('tests/editor/completion/host-handler-artifact.mjs')));assert.equal(a.handler,artifact.HOST_HANDLER_SOURCE);for(const [field,key]of [['installer','installerSource'],['expression','evaluationExpression'],['installerSHA256','installerSHA256'],['handlerSHA256','handlerSHA256'],['expressionSHA256','expressionSHA256'],['injectionSHA256','referenceInjectionSHA256'],['normalizerSHA256','normalizerSHA256'],['utilitySHA256','utilitySHA256'],['bundleSHA256','bundleSHA256'],['commonSHA256','commonSHA256']])assert.equal(a[field],artifact.HOST_HANDLER_ARTIFACT[key]);
 }
 result.identity={handlerBytes:a.handler.length,handlerSHA256:a.handlerSHA256,installerSHA256:a.installerSHA256,expressionSHA256:a.expressionSHA256,injectionSHA256:a.injectionSHA256};result.passed=true;
}catch(e){result.error={message:String(e),stack:e.stack};}
result.ended=new Date().toISOString();writeFileSync(join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));process.exitCode=result.passed?0:1;
