import {test as base,expect,type Page,type Browser,type BrowserContext,type Locator} from '@playwright/test';
import {mkdir,mkdtemp,open,writeFile,readFile,rm,access,realpath} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {serverProcess} from '../editor/process.js';
import {sanitizedLocation,sanitizedText} from './spectrum-observation.js';
import {captureFrame} from './spectrum-frame.js';
import {ownedOPFS} from '../editor/owned-opfs.js';

const engine=process.env.SPECTRUM_BROWSER??'chromium';
if(!['chromium','firefox','webkit'].includes(engine))throw Error('Unsupported engine');
// Explicit qualification specimen; ordinary Spectrum runs retain their
// desktop pointer. Playwright owns the real context input capability.
const coarsePointer=process.env.QUALIFICATION_COARSE_POINTER==='1';
export const out=resolve(process.env.SPECTRUM_OUTPUT??'artifacts/spectrum-controls',process.env.SPECTRUM_CONTROLS==='1'?'focused':'full',engine);
const safeJSON=(value:unknown)=>JSON.stringify(value,(_key,item)=>typeof item==='string'?item.replace(/#pairing=[^\s"'<>]+/g,'#pairing=<redacted>'):item);
const errorRecord=(error:unknown)=>error instanceof Error?{name:error.name,message:error.message,stack:error.stack}:{message:String(error)};
type Smoke={page:Page;step:<T>(name:string,work:()=>Promise<T>,ms?:number)=>Promise<T>;record:(value:unknown)=>Promise<void>};
export const test=base.extend<{smoke:Smoke}>({
  smoke:[async({playwright},use,info)=>{
    await mkdir(out,{recursive:true});
    const record=async(value:unknown)=>{const f=await open(join(out,'steps.jsonl'),'a');try{await f.write(safeJSON({at:new Date().toISOString(),...value as object})+'\n');await f.sync();}finally{await f.close();}};
    let currentStep='setup';
    const step=async<T>(name:string,work:()=>Promise<T>,ms=7_000)=>{
      currentStep=name;await record({step:name,phase:'before',deadlineMs:ms});let timer:ReturnType<typeof setTimeout>|undefined;
      try{const value=await Promise.race([work(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('SMOKE_STEP_DEADLINE: '+name)),ms);})]);await record({step:name,phase:'after'});return value;}
      catch(error){await record({step:name,phase:'failed',error:errorRecord(error)});throw error;}
      finally{if(timer)clearTimeout(timer);}
    };
    const cleanupErrors:unknown[]=[],events:unknown[]=[],network:unknown[]=[];
    let browser:Browser|undefined,context:BrowserContext|undefined,page:Page|undefined;
    let server:Awaited<ReturnType<typeof serverProcess>>|undefined,guard:Awaited<ReturnType<typeof ownedOPFS>>|undefined;
    let browserClosed=false,contextClosed=false,serverClosed=false,setupCompleted=false;
    let setupError:unknown;
    let profile:string|undefined;
    const root=await mkdtemp(join(await realpath(tmpdir()),'spectrum-controls-private-'));
    await record({phase:'setup',root,bodyTimeout:90_000,teardownIsSeparateFixture:true});
    try{
      await record({step:'browser-launch',phase:'before',timeoutMs:15000,deadlineOwner:'Public launch API'});
      if(engine==='webkit'){
        profile=await mkdtemp(join(await realpath(tmpdir()),'spectrum-controls-profile-'));
        await record({phase:'owned-profile',profile});
        context=await playwright.webkit.launchPersistentContext(profile,{timeout:15000,viewport:{width:1440,height:1000},colorScheme:'light',reducedMotion:'reduce',hasTouch:coarsePointer});
        browser=context.browser()??undefined;
        if(!browser)throw Error('Persistent context browser handle unavailable');
        await record({step:'browser-launch',phase:'after'});
        await step('close-initial-pages',()=>Promise.all(context!.pages().map(p=>p.close())));
      }else{
        browser=await playwright[engine as 'chromium'|'firefox'].launch({timeout:15000});
        await record({step:'browser-launch',phase:'after'});
        context=await step('fresh-context',()=>browser!.newContext({viewport:{width:1440,height:1000},colorScheme:'light',reducedMotion:'reduce',hasTouch:coarsePointer}));
      }
      context.setDefaultTimeout(5_000);context.setDefaultNavigationTimeout(5_000);
      page=await step('page',()=>context!.newPage());
      guard=await step('storage-guard',()=>ownedOPFS(context!,'spectrum-final'));
      await context.exposeBinding('spectrumSmokeCSP',(_source,value)=>{events.push({kind:'csp',...value});});
      await context.addInitScript(()=>addEventListener('securitypolicyviolation',e=>(window as any).spectrumSmokeCSP({directive:e.effectiveDirective,blocked:e.blockedURI})));
      const requestIds=new WeakMap<object,number>();let nextRequest=0;
      const observation=(request:import('@playwright/test').Request)=>({at:new Date().toISOString(),step:currentStep,requestId:requestIds.get(request),method:request.method(),...sanitizedLocation(request.url()),resourceType:request.resourceType()});
      page.on('request',request=>{requestIds.set(request,++nextRequest);network.push({kind:'request',...observation(request)});});
      page.on('response',response=>network.push({kind:'response',...observation(response.request()),status:response.status()}));
      page.on('requestfailed',request=>network.push({kind:'failed',...observation(request),failure:sanitizedText(request.failure()?.errorText??'unavailable')}));
      page.on('pageerror',e=>events.push({kind:'pageerror',at:new Date().toISOString(),step:currentStep,name:sanitizedText(e.name),message:sanitizedText(e.message),stack:sanitizedText(e.stack??'')}));
      page.on('console',m=>{if(m.type()==='error')events.push({kind:'console',at:new Date().toISOString(),step:currentStep,message:sanitizedText(m.text()),location:{...m.location(),url:sanitizedText(m.location().url)}});});
      server=await step('local-server',()=>serverProcess(root),20_000);
      await record({phase:'identities',browserVersion:browser.version(),browserExecutable:playwright[engine as 'chromium'|'firefox'|'webkit'].executablePath(),serverPid:server.pid,coarsePointer});
      await step('admit-origin',()=>guard!.admit(page!,server!.origin));
      const pairing=await step('issue-pairing',()=>server!.pair());
      if(typeof pairing!=='string')throw Error('Pairing URL unavailable');
      await step('paired-navigation',()=>page!.goto(pairing));
      await step('recovery-ready',()=>expect(page!.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible());
      setupCompleted=true;
      await use({page,step,record});
    }catch(error){setupError=errorRecord(error);await record({phase:'setup-or-fixture-error',setupCompleted,error:setupError});throw error;}finally{
      await record({phase:'body-outcome',status:setupCompleted?info.status:'not-started',setupError:setupError??null,errors:info.errors});
      const cleanup=async(name:string,work:()=>Promise<unknown>,ms=10_000)=>{try{await step(name,work,ms);}catch(error){cleanupErrors.push({step:name,error:errorRecord(error)});}};
      if(page&&!page.isClosed())await cleanup('closing-page-snapshot',async()=>{await writeFile(join(out,'closing-aria.txt'),await page!.locator('body').ariaSnapshot({timeout:5_000}));});
      if(page&&!page.isClosed())await cleanup('closing-page-capture',()=>engine==='webkit'?captureFrame(page!,join(out,'closing.jpg'),record):page!.screenshot({path:join(out,'closing.png'),caret:'initial',animations:'allow',timeout:5_000}));
      if(server)await cleanup('no-provider-effects',async()=>{const effects=await server!.effects();await record({phase:'effects',effects});expect(Object.values(effects)).toEqual(Array(8).fill(0));});
      if(guard)await cleanup('native-reset-and-absence',async()=>{await guard!.cleanup();guard!.verify();});
      if(server)await cleanup('server-close',async()=>{await server!.close();serverClosed=true;},45_000);
      if(context)await cleanup('context-close',async()=>{await context!.close();contextClosed=true;});
      if(browser)await cleanup('browser-close',async()=>{await browser!.close();browserClosed=true;});
      if(setupCompleted&&!setupError&&info.status==='passed'&&!cleanupErrors.length&&!events.length&&serverClosed&&contextClosed&&browserClosed){
        if(profile)await cleanup('physical-profile-removal',async()=>{await rm(profile!,{recursive:true});await expect(access(profile!)).rejects.toMatchObject({code:'ENOENT'});});
        if(!cleanupErrors.length)await cleanup('physical-private-root-removal',async()=>{await rm(root,{recursive:true});await expect(access(root)).rejects.toMatchObject({code:'ENOENT'});});
      }
      const outcome=setupError||info.status!=='passed'||cleanupErrors.length||events.length?'failed':'passed';
      await record({phase:'final',outcome,profile:profile??null,setupCompleted,setupError:setupError??null,serverClosed,contextClosed,browserClosed,cleanupErrors,events,shutdown:server?.shutdown,storage:guard?.ledger,requests:guard?.requests,network});
      await writeFile(join(out,'closure.json'),safeJSON({outcome,profile:profile??null,setupCompleted,setupError:setupError??null,bodyStatus:setupCompleted?info.status:'not-started',bodyErrors:info.errors,cleanupErrors,serverClosed,contextClosed,browserClosed,root,events,shutdown:server?.shutdown,storage:guard?.ledger,requests:guard?.requests,network}));
      expect(cleanupErrors,'Independent cleanup failures').toEqual([]);
      expect(events,'Unsuppressed console, page and CSP errors').toEqual([]);
    }
  },{timeout:90_000}],
});
