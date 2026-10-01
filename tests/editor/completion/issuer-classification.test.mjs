import test from 'node:test';
import assert from 'node:assert/strict';
import {syntaxInventory} from './issuer-syntax.mjs';
import {classifyIssuers,NETWORK_BOUNDARIES} from './issuer-classification.mjs';

const entryPath='dist/app/assets/index-reviewed.js',mainPath='dist/app/assets/shell-reviewed.js',workerPath='dist/app/assets/worker-reviewed.js';
const entry='function preload(link){const options={credentials:"same-origin"};fetch(link.href,options);}';
const main=`
function sealed(url,signal){return fetch(url,{credentials:'same-origin',redirect:'error',signal});}
function session(path,body,headers){return fetch('/api/v1/'+path,{method:body?'POST':'GET',headers,...(body?{body:JSON.stringify(body)}:{}),credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000)});}
function transport(path,init,headers){return fetch(path,{...init,headers,credentials:'same-origin',cache:'no-store',redirect:'error'});}
function recovery(path,init){return fetch(path,{...init,credentials:'same-origin',headers:{'X-App-Client':'LP-1',...init?.headers}});}
const renderer=new Worker(new URL('/assets/worker-reviewed.js',''+import.meta.url),{type:'module',name:'ideogram-text-'+1});
`;
const worker=`
function syncText(url){let textRequest=new XMLHttpRequest();textRequest.open('GET',url,false);textRequest.send(null);return textRequest.responseText;}
function syncBinary(url){var binaryRequest=new XMLHttpRequest();binaryRequest.open('GET',url,false);binaryRequest.responseType='arraybuffer';binaryRequest.send(null);return new Uint8Array(binaryRequest.response);}
const asyncBinary=(url,accept,reject)=>{const asyncRequest=new XMLHttpRequest();asyncRequest.open('GET',url,true);asyncRequest.responseType='arraybuffer';asyncRequest.onload=()=>{asyncRequest.status===200?accept(asyncRequest.response):reject();};asyncRequest.onerror=reject;asyncRequest.send(null);};
function streaming(url){return fetch(url,{credentials:'same-origin'});}
function fallback(url){return fetch(url,{credentials:'same-origin'});}
function sealed(url,signal){return fetch(url,{credentials:'same-origin',redirect:'error',signal});}
`;

function fixture(change=()=>{}){
 const sources=new Map([[entryPath,entry],[mainPath,main],[workerPath,worker]]);
 const edit=(path,from,to)=>{const value=sources.get(path);assert(value.includes(from),'Mutation matches original source');sources.set(path,value.replace(from,to));};
 change({sources,edit});
 const modules=[...sources].map(([path,source])=>({path,syntax:syntaxInventory(path,source)}));
 return {modules,options:{read:path=>Buffer.from(sources.get(path)),workerPath,entryPath}};
}
const classify=f=>classifyIssuers(f.modules,f.options);

test('reviewed issuer partitions cover every direct site and distinct XHR send',()=>{
 const value=classify(fixture());
 assert.equal(value.directBrowserNetworking.length,11);
 assert.deepEqual(value.classifiedNetworking.map(row=>row.kind).sort(),['modulepreload','session-json','application-transport','recovery-release','sealed-asset','sealed-asset','canvaskit-fetch','canvaskit-fetch'].sort());
 assert.equal(value.workerFallbacks.length,5);
 assert.equal(new Set(value.workerFallbacks.map(row=>row.path+':'+row.at)).size,5);
 assert(value.workerFallbacks.every(row=>row.path===workerPath&&row.method==='GET'&&row.body===null&&row.keepalive===false));
 assert(value.workerFallbacks.every((row,index,rows)=>index===0||rows[index-1].at<row.at));
});

test('minifier local names and source offsets do not classify fallback meaning',()=>{
 const f=fixture(({sources})=>sources.set(workerPath,'/*'+'.'.repeat(90000)+'*/'+worker.replaceAll('textRequest','minA').replaceAll('binaryRequest','minB').replaceAll('asyncRequest','minC')));
 const value=classify(f);assert.equal(value.workerFallbacks.length,5);assert(value.workerFallbacks.every(row=>row.at>90000));
});

test('direct and Vite-coerced import.meta.url forms bind the actual Worker URL',()=>{
 classify(fixture());classify(fixture(({edit})=>edit(mainPath,"''+import.meta.url",'import.meta.url')));
});

test('computed known XHR method names retain owner pairing',()=>{
 classify(fixture(({sources})=>sources.set(workerPath,worker.replaceAll('.open(',"['open'](").replaceAll('.send(',"[`send`]("))));
});

const failures={
 'additional fetch':({sources})=>sources.set(mainPath,main+'fetch("/unknown",{});'),
 'fallback with a POST body':({edit})=>edit(workerPath,"fetch(url,{credentials:'same-origin'})","fetch(url,{credentials:'same-origin',method:'POST',body:'payload'})"),
 'fallback missing same-origin policy':({edit})=>edit(workerPath,"fetch(url,{credentials:'same-origin'})","fetch(url,{credentials:'omit'})"),
 'unassigned fetch with matching site count':({edit})=>edit(mainPath,"fetch(path,{...init,headers,credentials:'same-origin',cache:'no-store',redirect:'error'})","fetch(path,{headers,credentials:'same-origin'})"),
 'extra fetch argument':({edit})=>edit(entryPath,'fetch(link.href,options)','fetch(link.href,options,more)'),
 'computed direct fetch alias':({edit})=>edit(entryPath,'fetch(link.href,options)',"window['fetch'](link.href,options)"),
 'XHR sends a body':({edit})=>edit(workerPath,'textRequest.send(null)','textRequest.send("payload")'),
 'XHR omits explicit null body':({edit})=>edit(workerPath,'textRequest.send(null)','textRequest.send()'),
 'XHR uses POST':({edit})=>edit(workerPath,"textRequest.open('GET',url,false)","textRequest.open('POST',url,false)"),
 'XHR method is dynamic':({edit})=>edit(workerPath,"textRequest.open('GET',url,false)",'textRequest.open(method,url,false)'),
 'XHR has a second open':({edit})=>edit(workerPath,'textRequest.send(null)',"textRequest.open('GET',url,false);textRequest.send(null)"),
 'XHR has a second send':({edit})=>edit(workerPath,'textRequest.send(null)','textRequest.send(null);textRequest.send(null)'),
 'XHR sends before fixing method':({edit})=>edit(workerPath,"textRequest.open('GET',url,false);textRequest.send(null)","textRequest.send(null);textRequest.open('GET',url,false)"),
 'XHR constructed after open':({edit})=>edit(workerPath,"let textRequest=new XMLHttpRequest();textRequest.open('GET',url,false)","textRequest.open('GET',url,false);let textRequest=new XMLHttpRequest()"),
 'XHR assignment lacks local declaration':({edit})=>edit(workerPath,'let textRequest=new XMLHttpRequest()','textRequest=new XMLHttpRequest()'),
 'XHR declaration is top-level':({edit})=>edit(workerPath,"function syncText(url){let textRequest=new XMLHttpRequest();textRequest.open('GET',url,false);textRequest.send(null);return textRequest.responseText;}","const url='/x';let textRequest=new XMLHttpRequest();textRequest.open('GET',url,false);textRequest.send(null);textRequest.responseText;"),
 'XHR owner is reassigned':({edit})=>edit(workerPath,'textRequest.send(null)','textRequest=other; textRequest.send(null)'),
 'XHR owner is updated':({edit})=>edit(workerPath,'textRequest.send(null)','textRequest++; textRequest.send(null)'),
 'XHR declaration is duplicated':({edit})=>edit(workerPath,'var binaryRequest=new XMLHttpRequest()','var binaryRequest;var binaryRequest=new XMLHttpRequest()'),
 'XHR original send is replaced':({edit})=>edit(workerPath,'textRequest.send(null)','textRequest.send=other; textRequest.send(null)'),
 'XHR original open is replaced':({edit})=>edit(workerPath,"textRequest.open('GET',url,false)","textRequest.open=other;textRequest.open('GET',url,false)"),
 'XHR owner escapes to an unknown callback':({edit})=>edit(workerPath,'textRequest.send(null)','unknown(textRequest);textRequest.send(null)'),
 'XHR uses an unreviewed method':({edit})=>edit(workerPath,'textRequest.send(null)',"textRequest.setRequestHeader('X-Unreviewed','value');textRequest.send(null)"),
 'XHR open belongs to another local':({edit})=>edit(workerPath,"textRequest.open('GET',url,false)","unowned.open('GET',url,false)"),
 'XHR send belongs to another local':({edit})=>edit(workerPath,'textRequest.send(null)','unowned.send(null)'),
 'XHR send is in a different lexical function':({edit})=>edit(workerPath,'textRequest.send(null)','function later(){textRequest.send(null);}'),
 'unknown worker send':({sources})=>sources.set(workerPath,worker+'other.send(null);'),
 'worker URL string only appears in the name':({edit})=>edit(mainPath,"new URL('/assets/worker-reviewed.js',''+import.meta.url),{type:'module',name:'ideogram-text-'+1}","new URL('/foreign.js',''+import.meta.url),{type:'module',name:'/assets/worker-reviewed.js'}"),
 'worker URL uses a foreign base':({edit})=>edit(mainPath,"''+import.meta.url","'https://foreign.example/'"),
 'worker URL is an arbitrary string':({edit})=>edit(mainPath,"new URL('/assets/worker-reviewed.js',''+import.meta.url)","'/assets/worker-reviewed.js'"),
 'worker options select classic':({edit})=>edit(mainPath,"{type:'module',name:'ideogram-text-'+1}","{type:'classic',name:'ideogram-text-'+1}"),
 'Worker is an arbitrary member constructor':({edit})=>edit(mainPath,'new Worker(','new host.Worker('),
 'Worker called without new':({edit})=>edit(mainPath,'new Worker(','Worker('),
 'worker options introduce credentials':({edit})=>edit(mainPath,"{type:'module',name:'ideogram-text-'+1}","{type:'module',name:'ideogram-text-'+1,credentials:'include'}"),
 'production keepalive metadata':({sources})=>sources.set(mainPath,main+'const forbidden={keepalive:true};'),
};
for(const [name,change]of Object.entries(failures))test('issuer classification refuses '+name,()=>assert.throws(()=>classify(fixture(change))));

test('each sealed-asset realm is required rather than matching the total alone',()=>{
 const f=fixture(({sources})=>{const sealed="function sealed(url,signal){return fetch(url,{credentials:'same-origin',redirect:'error',signal});}";sources.set(mainPath,main.replace(sealed,''));sources.set(workerPath,worker+sealed.replace('function sealed','function otherSealed'));});
 assert.throws(()=>classify(f),/One sealed asset read in the worker/);
});

test('ordinary body issuer cannot be relocated into the worker',()=>{
 const f=fixture(({sources})=>{const ordinary="function transport(path,init,headers){return fetch(path,{...init,headers,credentials:'same-origin',cache:'no-store',redirect:'error'});}";sources.set(mainPath,main.replace(ordinary,''));sources.set(workerPath,worker+ordinary);});
 assert.throws(()=>classify(f),/Body issuers confined/);
});

for(const api of ['Request','sendBeacon','importScripts','SharedWorker','WebSocket','EventSource','WebTransport']){
 test('syntax and classification refuse undeclared '+api+' API',()=>{
  const f=fixture(({sources})=>sources.set(mainPath,main+`globalThis[${JSON.stringify(api)}]('/unknown');`));
  assert(f.modules.find(module=>module.path===mainPath).syntax.calls.some(row=>row.name===api));
  assert.throws(()=>classify(f),/No unclassified direct networking API/);
 });
}

test('reviewed network boundary hashes are fixed independently of candidates',()=>{
 assert(Object.isFrozen(NETWORK_BOUNDARIES));
 // Literal identities from the source review, never derived from the candidate.
 assert.deepEqual(NETWORK_BOUNDARIES,{
  'src/observability/recovery-memory.ts':'52c4b1f97ae3ee5e3eec4e88ca0274174aaea1b54f611ec27a948393f052b492',
  'src/state/recovery-client.ts':'43f23b5cfb96db02e99a624ba0fcbe45aef3c1c96bd3db69b18a78aec5eabef4',
  'src/state/session-client.ts':'eed37b101c2f2c5ce9cf948058b918e5dc1995bcee310f0d3384c24884b80f9b',
  'src/text/contracts.ts':'96aa65d78cf834c14def464df88d3b94982193cfeabc8f70b1eaba3d86fae6ec',
  'src/text/engine.ts':'c86d782ccb92de17fb4a01376e16989b13114156abcd6418a011af43efb5c830',
 });
});
