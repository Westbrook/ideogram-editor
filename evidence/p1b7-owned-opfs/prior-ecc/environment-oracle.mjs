import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {webkit} from '/Users/westbrook/Documents/repos/ideogram-edit-verification/ecc5262-checkout/node_modules/playwright/index.mjs';
import {recordDOMErrors} from '/Users/westbrook/Documents/repos/ideogram-edit-verification/ecc5262-checkout/tests/editor/error-monitor.ts';
import {expectedShutdownConsole,expectedShutdownPageError} from '/Users/westbrook/Documents/repos/ideogram-edit-verification/ecc5262-checkout/tests/editor/shutdown-console.ts';
const out='/Users/westbrook/Documents/repos/ideogram-edit-verification/ecc5262-independent';
const servers=[],profiles=[],result={start:new Date().toISOString(),storage:[],oracle:[]};
async function serve(csp=false){const s=createServer((q,r)=>{if(csp)r.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'");r.end('<!doctype html><title>Independent local control</title>');});await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));servers.push(s);return 'http://127.0.0.1:'+s.address().port;}
async function persistent(){const profile=await mkdtemp(join(tmpdir(),'ecc-independent-control-'));profiles.push(profile);return webkit.launchPersistentContext(profile,{viewport:{width:1440,height:1000}});}
let browser;
try{
 const origin=await serve();browser=await webkit.launch();result.browser=browser.version();
 for(const kind of ['ephemeral','persistent-one','persistent-two']){
  const c=kind==='ephemeral'?await browser.newContext({viewport:{width:1440,height:1000}}):await persistent();
  try{const p=await c.newPage();await p.goto(origin);const value=await p.evaluate(async()=>{let stage='getDirectory';try{const root=await navigator.storage.getDirectory();const initial=[];for await(const entry of root.keys())initial.push(entry);stage='getFileHandle';const f=await root.getFileHandle('independent.bin',{create:true});stage='createWritable';const w=await f.createWritable();stage='write';await w.write(new Uint8Array([0,255,10,13,127,128]));stage='close';await w.close();stage='read';return {ok:true,initial,bytes:Array.from(new Uint8Array(await(await f.getFile()).arrayBuffer()))};}catch(e){return {ok:false,stage,name:e.name,message:e.message};}});result.storage.push({kind,...value});if(kind==='ephemeral'){assert.equal(value.ok,false);assert.equal(value.stage,'getDirectory');assert.equal(value.name,'UnknownError');}else{assert.deepEqual(value.initial,[]);assert.deepEqual(value.bytes,[0,255,10,13,127,128]);}}finally{await c.close();}
 }
 await browser.close();browser=null;
 const c=await persistent();const dom=await recordDOMErrors(c),p=await c.newPage(),pageErrors=[],consoleErrors=[];let disrupting=true;const retiredOrigins=new Set([origin]);
 p.on('pageerror',e=>pageErrors.push({name:e.name,message:e.message,stack:e.stack??'',expected:expectedShutdownPageError({browser:'webkit',name:e.name,message:e.message,stack:e.stack??'',disrupting,retiredOrigins})}));
 p.on('console',m=>{if(m.type()==='error')consoleErrors.push({text:m.text(),url:m.location().url,expected:expectedShutdownConsole({browser:'webkit',text:m.text(),url:m.location().url,disrupting,retiredOrigins})});});
 try{
  const foreign=await serve();await p.goto(foreign);const caught=await p.evaluate(async origin=>{try{await fetch(origin+'/api/v1/events/stream?after=17');return false;}catch(e){return {name:e.name,message:e.message};}},origin);
  assert.equal(caught.name,'TypeError');assert.deepEqual(dom,[]);assert(pageErrors.some(e=>e.expected));result.handledFetch={caught,pageErrors:structuredClone(pageErrors),dom:structuredClone(dom)};
  // Known native diagnostic only passes inside the exact phase/origin/name/stack grammar.
  const sample=pageErrors.find(e=>e.expected);let negatives=0;
  for(const change of [{disrupting:false},{retiredOrigins:new Set()},{name:'Error'},{stack:'app.js:1'},{browser:'chromium'},{message:sample.message.replace('after=17','after=17&after=18')},{message:sample.message.replace('/events/stream','/commands')},{message:sample.message.replace('127.0.0.1','localhost')},{message:sample.message.replace('after=17','after=-1')},{message:sample.message.replace('after=17','after=01')},{message:sample.message+' '},{message:sample.message.replace('http','https')}].filter(x=>!('message'in x)||x.message!==sample.message)) {assert.equal(expectedShutdownPageError({browser:'webkit',...sample,disrupting,retiredOrigins,...change}),false);negatives++;}
  result.independentPageNegatives=negatives;
  await p.evaluate(()=>{console.error('Independent ordinary console failure');setTimeout(()=>{throw Error('Independent before navigation');},0);});
  await p.waitForFunction(()=>true);await p.goto(foreign+'/next');
  await p.evaluate(origin=>{void Promise.reject(Error('Independent rejection after navigation'));setTimeout(()=>{const e=Error(origin.slice('http:/'.length)+'/api/v1/events/stream?after=17 due to access control checks.');e.name='Fetch API cannot load http';e.stack='';throw e;},0);},origin);
  await p.waitForFunction(()=>true);
  // Observe an error as the final synchronous document action, then close without polling the collector.
  await p.evaluate(()=>dispatchEvent(new ErrorEvent('error',{message:'Independent immediate-close marker',error:Error('Independent immediate-close marker')})));
  await p.close();await c.close();
  assert(dom.some(e=>e.message==='Independent before navigation'));assert(dom.some(e=>e.message==='Independent rejection after navigation'));assert(dom.some(e=>e.name==='Fetch API cannot load http'));assert(dom.some(e=>e.message==='Independent immediate-close marker'));assert(consoleErrors.some(e=>e.text==='Independent ordinary console failure'&&!e.expected));
  result.oracle={dom,pageErrors,consoleErrors,closeOrdering:'Final synchronous document error dispatch -> page.close -> context.close -> assertions; no collector-length polling before close. Real timer throw and rejected promise across navigation plus mimic remain detected.'};
 }finally{await c.close();}
 // Deliberate blocked inline stylesheet: this is a control, never an allowed app error.
 const cspOrigin=await serve(true),cspContext=await persistent(),cp=await cspContext.newPage(),cspErrors=[];
 cp.on('console',m=>{if(m.type()==='error')cspErrors.push({text:m.text(),expected:expectedShutdownConsole({browser:'webkit',text:m.text(),url:m.location().url,disrupting:true,retiredOrigins:new Set([cspOrigin])})});});
 try{await cp.goto(cspOrigin);assert.deepEqual(cspErrors,[]);await cp.screenshot({caret:'initial',path:join(out,'webkit-screenshot-control.png')});await cp.title();assert(cspErrors.some(e=>/style|stylesheet/i.test(e.text)&&!e.expected));result.screenshotTooling={before:[],after:structuredClone(cspErrors),source:'Installed pinned coreBundle.js inPagePrepareForScreenshots syncAnimations injects body {} inline style; blank CSP page, no product code.'};await cp.evaluate(()=>{const style=document.createElement('style');style.textContent='body{color:red}';document.head.append(style);});await cp.close();await cspContext.close();assert(cspErrors.some(e=>/style|stylesheet/i.test(e.text)&&!e.expected));result.cspNegative=cspErrors;}finally{await cspContext.close();}
 result.pass=true;
}catch(e){result.pass=false;result.error=String(e.stack);throw e;}
finally{if(browser)await browser.close();for(const s of servers)await new Promise(r=>s.close(r));for(const p of profiles)await rm(p,{recursive:true,force:true});result.end=new Date().toISOString();await writeFile(join(out,'environment-oracle.json'),JSON.stringify(result,null,2));}
