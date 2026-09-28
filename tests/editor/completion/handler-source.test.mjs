import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {inspectHostHandler} from './host-final-page.mjs';
import {HOST_HANDLER_SOURCE,HOST_HANDLER_ARTIFACT as artifact} from './host-handler-artifact.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex'),capture=JSON.parse(readFileSync(process.env.HOST_HANDLER_CAPTURE));
function exact(record,expected=artifact){assert.equal(record.registrations.length,1);const r=record.registrations[0];assert.equal(r.type,'pagehide');assert.equal(r.once,true);assert.equal(r.ownWindow,true);assert.equal(r.name,'genuineIntegrationHostFinal');assert.equal(r.source,record.handler);assert.equal(record.handler,HOST_HANDLER_SOURCE);assert.equal(sha(record.handler),expected.handlerSHA256);assert.equal(record.installer,expected.installerSource);assert.equal(sha(record.installer),expected.installerSHA256);assert.equal(record.expression,expected.evaluationExpression);assert.equal(sha(record.expression),expected.expressionSHA256);assert.equal(sha(JSON.stringify(record.envelope)),expected.referenceInjectionSHA256);}
test('independently registered pinned ESM callback and complete installer match the immutable artifact',()=>exact(capture));
for(const [name,mutate]of Object.entries({missing:x=>x.registrations=[],extra:x=>x.registrations.push(structuredClone(x.registrations[0])),foreignWindow:x=>x.registrations[0].ownWindow=false,foreignType:x=>x.registrations[0].type='unload',foreignName:x=>x.registrations[0].name='foreign',persistent:x=>x.registrations[0].once=false,tail:x=>x.handler+=' tail',source:x=>x.registrations[0].source+='x',code:x=>x.handler=x.handler.replace("write('entered')","write('changed')"),installer:x=>x.installer+=';',expression:x=>x.expression+=';',arguments:x=>x.envelope.argsAndHandles=[]}))test('actual capture identity refuses '+name,()=>{const x=structuredClone(capture);mutate(x);assert.throws(()=>exact(x));});
test('wrong expected artifact is rejected by an independently captured callback',()=>assert.throws(()=>exact(capture,{...artifact,handlerSHA256:'0'.repeat(64)})));
for(const [name,mutate]of Object.entries({exact:()=>{},missing:x=>x.listeners=[],extra:x=>x.listeners.push(structuredClone(x.listeners[0])),foreign:x=>x.listeners[0].handler.description='foreign',once:x=>x.listeners[0].once=false,source:x=>x.source+=' tail',context:x=>x.context.id++,pageshow:x=>x.pageshows[0].isTrusted=false,release:x=>x.release=false}))test('actual inspect path with separately captured callback '+name,async()=>{
 const origin='http://127.0.0.1:34567',registration={nonce:'nonce',context:{id:3},url:origin+'/',origin};
 const x={context:{id:3},source:capture.registrations[0].source,listeners:[{type:'pagehide',once:true,handler:{objectId:'captured-handler',description:capture.registrations[0].name},scriptId:'captured-script',lineNumber:1,columnNumber:1}],pageshows:[{type:'pageshow',isTrusted:true,persisted:false,url:origin+'/',origin}],release:true};mutate(x);
 const send=async(method,args)=>{if(method==='Runtime.evaluate'){assert.equal(args.contextId,x.context.id);return {result:{objectId:'window',className:'Window'}};}if(method==='DOMDebugger.getEventListeners')return {listeners:x.listeners};if(method==='Runtime.callFunctionOn')return {result:{value:x.source}};if(method==='Runtime.releaseObjectGroup'){assert(x.release);return {};}throw Error(method);};
 const work=()=>inspectHostHandler({page:{evaluate:async()=>x.pageshows},send,hostKey:'host',registration});if(name==='exact')await work();else await assert.rejects(work);
});
test('separate plain-Node receiver accepts exact independent source and retains strict refusals',()=>{
 const out=resolve(process.env.EDITOR_RECEIPT,'handler-source');mkdirSync(out,{recursive:true});const path=join(out,'receiver.json'),p=spawnSync(process.execPath,['tests/editor/completion/handler-receiver-control.mjs',process.env.HOST_HANDLER_CAPTURE,path],{encoding:'utf8'});writeFileSync(join(out,'receiver.log'),p.stdout+p.stderr);assert.equal(p.status,0,p.stderr);const result=JSON.parse(readFileSync(path));assert.notEqual(result.pid,capture.pid);assert.equal(result.handler,capture.handler);assert.equal(result.results.length,13);
});
