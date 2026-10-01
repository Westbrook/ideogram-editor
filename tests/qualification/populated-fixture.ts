import {test as base,expect,type Page,type Browser,type BrowserContext} from '@playwright/test';
import {fork} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdir,mkdtemp,readFile,realpath,rename,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import sharp from 'sharp';
import {ownedOPFS} from '../editor/owned-opfs.js';
import {recordDOMErrors} from '../editor/error-monitor.js';
import {runs,step,throwFailures,finishFixture,type RunState} from '../editor/harness-lifecycle.js';
import {publicReadRequest} from '../request/persistence-witness.js';
// @ts-ignore Shared test-owned lifecycle retains failures and verifies closure.
import {ownServerProcess} from '../editor/completion/owned-process.mjs';

type Phase='queued'|'running'|'completed'|'failed'|'cancelled';
type RequestState={id:string;prompt:string;phase:Phase};
type Effect={method:string;path:string;requestId:string|null;phase:Phase|null};
const engine=process.env.QUALIFICATION_BROWSER??'chromium';
if(!['chromium','firefox','webkit'].includes(engine))throw Error('Unsupported qualification browser');
export const populatedOutput=resolve(process.env.QUALIFICATION_AXE_OUTPUT??'artifacts/qualification-axe','populated',engine);

/** External fixture service survives an actual writer close/reopen. Its controls
 * change only provider responses, never product projection/store contents. */
async function controlledProvider(){
  const requests=new Map<string,RequestState>(),effects:Effect[]=[],errors:string[]=[],sockets=new Set<import('node:net').Socket>();
  const png=await sharp({create:{width:512,height:512,channels:4,background:'#2468ac'}}).png().toBuffer();
  let origin='';
  const server=createServer(async(req,res)=>{
    try{
      const path=new URL(req.url!,origin).pathname,method=req.method!;
      const match=/^\/ideogram\/v4\/requests\/([^/]+)(?:\/(status|cancel))?$/.exec(path);
      const request=match?requests.get(match[1]):undefined;
      effects.push({method,path,requestId:request?.id??null,phase:request?.phase??null});
      res.setHeader('Content-Type','application/json');
      if(method==='POST'&&path==='/ideogram/v4'){
        const parts:Buffer[]=[];let length=0;for await(const part of req){length+=part.length;if(length>65536)throw Error('Oversize fixture request');parts.push(part);}
        const value=JSON.parse(Buffer.concat(parts).toString()),id='axe_'+(requests.size+1);
        expect(typeof value.prompt).toBe('string');requests.set(id,{id,prompt:value.prompt,phase:'queued'});
        const url=origin+'/ideogram/v4/requests/'+id;
        res.end(JSON.stringify({request_id:id,status_url:url+'/status',response_url:url,cancel_url:url+'/cancel'}));
      }else if(method==='GET'&&path.startsWith('/image/')){
        const id=path.slice('/image/'.length);expect(requests.get(id)?.phase).toBe('completed');
        res.setHeader('Content-Type','image/png');res.end(png);
      }else{
        if(!request)throw Error('Unexpected fixture route: '+method+' '+path);
        if(method==='PUT'&&match![2]==='cancel'){
          request.phase='cancelled';res.end(JSON.stringify({status:'CANCELLED',request_id:request.id}));
        }else if(method==='GET'&&match![2]==='status'){
          const status={queued:'IN_QUEUE',running:'IN_PROGRESS',completed:'COMPLETED',failed:'COMPLETED',cancelled:'CANCELLED'}[request.phase];
          res.end(JSON.stringify({request_id:request.id,status,...request.phase==='failed'?{error:'Controlled provider failure',error_type:'fixture_error'}:{}}));
        }else if(method==='GET'&&!match![2]&&request.phase==='completed'){
          res.end(JSON.stringify({images:[{url:origin+'/image/'+request.id,content_type:'image/png',file_size:png.length,width:512,height:512}],prompt:request.prompt,seed:31,timings:{inference:.4},has_nsfw_concepts:[false]}));
        }else throw Error('Unexpected fixture request state: '+method+' '+path+' '+request.phase);
      }
    }catch(error){errors.push(String(error));res.statusCode=500;res.end('{}');}
  });
  server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw Error('Loopback fixture address');origin='http://127.0.0.1:'+address.port;
  return {origin,effects,errors,requests,phase(id:string,phase:Phase){const request=requests.get(id);if(!request)throw Error('Unknown retained provider request');request.phase=phase;},async close(){
    const closed=new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    for(const socket of sockets)socket.destroy();await closed;expect(server.listening).toBe(false);expect(sockets.size).toBe(0);
  }};
}
function serverProcess(root:string){
  const child=fork(resolve('tests/qualification/populated-process-fixture.mjs'),[root,resolve('dist/app')],{execArgv:['--import',resolve('tests/provider/no-egress.mjs')],env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR},stdio:['ignore','ignore','pipe','ipc']});
  return ownServerProcess(child,{});
}
type Populated={page:Page;read:<T=any>(path:string)=>Promise<T>;allow:(jobId:string)=>Promise<void>;phase:(id:string,phase:Phase)=>void;restart:()=>Promise<void>;effects:Effect[];record:(name:string,value:unknown)=>Promise<void>};
export const test=base.extend<{populated:Populated}>({
  populated:[async({playwright},use,info)=>{
    await mkdir(populatedOutput,{recursive:true});
    let directory='',root='',profile:string|undefined;
    let browser:Browser|undefined,context:BrowserContext|undefined,page:Page|undefined,provider:Awaited<ReturnType<typeof controlledProvider>>|undefined,server:Awaited<ReturnType<typeof serverProcess>>|undefined;
    let guard:Awaited<ReturnType<typeof ownedOPFS>>|undefined;
    const state:RunState={failures:[],roots:[],writerClosed:false,contextClosed:false,browserClosed:false,retention:[],receipt:populatedOutput,prefix:'populated-'};
    const external:string[]=[],consoleErrors:string[]=[],csp:unknown[]=[],lifecycles:unknown[]=[],closures:unknown[]=[];let domErrors:unknown[]=[];
    const dispatchJobs:string[]=[];
    const record=(name:string,value:unknown)=>writeFile(join(populatedOutput,name+'.json'),JSON.stringify(value,null,2));
    const saveControl=async()=>{const file=join(root,'axe-populated-control.json');await writeFile(file+'.tmp',JSON.stringify({origin:provider!.origin,dispatchJobs}),{mode:0o600});await rename(file+'.tmp',file);};
    const open=async()=>{server=await serverProcess(root);state.writerClosed=false;lifecycles.push(server.lifecycle);await guard!.admit(page!,server.origin);await page!.goto(await server.pair());await expect(page!.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();};
    const close=async()=>{if(!server)return;await server.close();state.writerClosed=true;const value=JSON.parse(await readFile(join(root,'axe-populated-observer.json'),'utf8'));closures.push(value);expect(value.closed).toBe(true);expect(value.errors).toEqual([]);expect(value.egressAttempts).toEqual([]);server=undefined;};
    try{
      directory=await mkdtemp(join(await realpath(tmpdir()),'axe-populated-'));state.roots.push(directory);root=join(directory,'private');await mkdir(root,{mode:0o700});
      profile=engine==='webkit'?await mkdtemp(join(await realpath(tmpdir()),'axe-populated-profile-')):undefined;
      provider=await controlledProvider();await saveControl();
      if(profile){context=await playwright.webkit.launchPersistentContext(profile,{viewport:{width:1440,height:1000},reducedMotion:'reduce'});browser=context.browser()??undefined;}
      else {browser=await playwright[engine as 'chromium'|'firefox'].launch();context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});}
      runs.set(context,state);await Promise.all(context.pages().map(page=>page.close()));context.setDefaultTimeout(15000);page=await context.newPage();
      guard=await ownedOPFS(context,'axe-populated');domErrors=await recordDOMErrors(context);
      await context.exposeBinding('populatedCSP',(_source,value)=>csp.push(value));
      await context.addInitScript(()=>addEventListener('securitypolicyviolation',e=>(window as any).populatedCSP({directive:e.effectiveDirective,blocked:e.blockedURI})));
      page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
      await context.route('**/*',route=>{const url=new URL(route.request().url());if(['http:','https:'].includes(url.protocol)&&url.origin!==server?.origin){external.push(url.origin);return route.abort();}return route.continue();});
      await open();
      await record('runtime',{engine,version:browser?.version(),userAgent:await page.evaluate(()=>navigator.userAgent),pin:JSON.parse(await readFile('node_modules/playwright-core/browsers.json','utf8')).browsers.find((b:any)=>b.name===engine)});
      await use({page,read:async<T>(path:string)=>page!.evaluate(async spec=>{const response=await fetch(spec.path,spec.init);if(!response.ok)throw Error('Public protocol read '+response.status);return response.json();},publicReadRequest(path)) as Promise<T>,
        allow:async jobId=>{dispatchJobs.push(jobId);await saveControl();},phase:(id,phase)=>provider!.phase(id,phase),effects:provider.effects,record,
        restart:async()=>{await page!.goto('about:blank');await close();await open();}});
    }catch(error){state.failures.push({phase:'body',error});}
    finally{
      if(info.errors.length)state.failures.push({phase:'playwright-errors',error:new AggregateError(info.errors.map(error=>Error(error.message??JSON.stringify(error))),'Playwright retained hard or soft failures')});
      if(page&&!page.isClosed())await step(state,'closing-aria',async()=>writeFile(join(populatedOutput,'closing.aria.txt'),await page!.locator('body').ariaSnapshot({timeout:5000})));
      if(guard)await step(state,'owned-opfs-cleanup',async()=>{if(page&&!page.isClosed())await page.goto('about:blank');await guard!.cleanup();guard!.verify();});
      await step(state,'writer-close',close);if(provider)await step(state,'provider-close',()=>provider!.close());
      state.observe=()=>({external,consoleErrors,csp,domErrors,lifecycles:JSON.parse(JSON.stringify(lifecycles,(_key,value)=>typeof value==='string'?value.replace(/#pairing=[^\s"'<>]+/g,'#pairing=<redacted>'):value)),closures,effects:provider?.effects,providerErrors:provider?.errors,storage:guard?.ledger,requests:guard?.requests});
      state.finalCheck=async()=>{expect(external).toEqual([]);expect(consoleErrors).toEqual([]);expect(csp).toEqual([]);expect(domErrors).toEqual([]);expect(provider?.errors).toEqual([]);guard?.verify();};
      if(context)await finishFixture(context,browser,profile,populatedOutput,'populated-',info);
      else {
        state.contextClosed=true;state.browserClosed=await step(state,'browser-close-after-setup-failure',async()=>{await browser?.close();});
        if(profile)state.roots.push(profile);
        await step(state,'setup-failure-receipt',()=>record('setup-failure',{failures:state.failures.map(item=>({phase:item.phase,error:String(item.error)})),retainedRoots:state.roots,physicalClosure:{writerClosed:state.writerClosed,contextClosed:state.contextClosed,browserClosed:state.browserClosed}}));
      }
      throwFailures(state.failures);
    }
  },{timeout:300000}],
});
