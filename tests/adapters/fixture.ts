import {test as base,expect,type Page} from '@playwright/test';
import {mkdir,mkdtemp,readFile,realpath,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {serverProcess} from '../editor/process.js';
import {ownedOPFS} from '../editor/owned-opfs.js';
import {recordDOMErrors} from '../editor/error-monitor.js';
import {runs,step,throwFailures,finishFixture,type RunState} from '../editor/harness-lifecycle.js';
import {publicReadRequest} from '../request/persistence-witness.js';

export const out=resolve(process.env.ADAPTER_OUTPUT??'artifacts/p27-browser','chromium');
type Fixture={page:Page;commands:any[];read:<T>(path:string)=>Promise<T>;record:(name:string,value:unknown)=>Promise<void>};
export const test=base.extend<{adapter:Fixture}>({adapter:[async({playwright},use,info)=>{
 const receipt=join(out,info.title.replace(/[^a-zA-Z0-9]+/g,'-').slice(0,100));
 await mkdir(receipt,{recursive:true});
 const root=await mkdtemp(join(await realpath(tmpdir()),'p27-adapter-browser-'));
 const browser=await playwright.chromium.launch({timeout:15_000});
 const context=await browser.newContext({viewport:{width:1440,height:1000},colorScheme:'light',reducedMotion:'reduce'});
 context.setDefaultTimeout(10_000);context.setDefaultNavigationTimeout(10_000);
 const page=await context.newPage(),guard=await ownedOPFS(context,'p27-adapter-library'),errors=await recordDOMErrors(context);
 const commands:any[]=[],consoleErrors:string[]=[],csp:unknown[]=[],external:string[]=[];
 let server:Awaited<ReturnType<typeof serverProcess>>|undefined,effects:unknown;
 const state:RunState={failures:[],roots:[root],writerClosed:true,contextClosed:false,browserClosed:false,retention:[],receipt,prefix:''};runs.set(context,state);
 const manifest=JSON.parse(await readFile('node_modules/playwright-core/browsers.json','utf8'));
 const pinned=manifest.browsers.find((b:any)=>b.name==='chromium');
 const runtime={engine:'chromium',version:browser.version(),expectedVersion:pinned.browserVersion,revision:pinned.revision,executable:playwright.chromium.executablePath()};
 state.observe=()=>({runtime,commands,errors,consoleErrors,csp,external,effects,requests:guard.requests,storage:guard.ledger,shutdown:server?.shutdown});
 state.finalCheck=async()=>{guard.verify();expect(errors).toEqual([]);expect(consoleErrors).toEqual([]);expect(csp).toEqual([]);expect(external).toEqual([]);};
 const read=async<T>(path:string):Promise<T>=>page.evaluate(async request=>{const response=await fetch(request.path,request.init);if(!response.ok)throw Error('Public adapter witness read failed: '+response.status);return response.json();},publicReadRequest(path));
 const record=(name:string,value:unknown)=>writeFile(join(receipt,name+'.json'),JSON.stringify(value,null,2));
 try{
  expect(runtime.version,'Use the Chromium revision bundled with the pinned Playwright dependency').toBe(runtime.expectedVersion);
  await context.exposeBinding('recordAdapterCSP',(_source,value)=>csp.push(value));
  await context.addInitScript(()=>addEventListener('securitypolicyviolation',event=>(window as any).recordAdapterCSP({directive:event.effectiveDirective,blocked:event.blockedURI})));
  page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
  page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/v1/commands')commands.push(request.postDataJSON().command);});
  server=await serverProcess(join(root,'private'));state.writerClosed=false;
  await context.route('**/*',route=>{const url=new URL(route.request().url());if(['http:','https:'].includes(url.protocol)&&url.origin!==server!.origin){external.push(url.origin);return route.abort();}return route.continue();});
  await guard.admit(page,server.origin);await page.goto(await server.pair());
  await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();
  await use({page,commands,read,record});
 }catch(error){state.failures.push({phase:'body-or-setup',error});}finally{
  await step(state,'closing-accessibility',async()=>writeFile(join(receipt,'closing-aria.txt'),await page.locator('body').ariaSnapshot()));
  if(server){
   await step(state,'no-provider-effects',async()=>{effects=await server!.effects();expect(Object.values(effects as object)).toEqual(Array(8).fill(0));});
   if(!state.failures.length&&info.status==='passed')await step(state,'logical-cleanup',async()=>{await page.goto('about:blank');await guard.cleanup();guard.verify();});
   state.writerClosed=await step(state,'writer-close',()=>server!.close());
  }
  await finishFixture(context,browser,null,receipt,'',info);
  throwFailures(state.failures);
 }
},{timeout:120_000}]});
