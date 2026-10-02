// STAGED ONLY. Promote with document-creation.spec.ts and the J1 implementation.
import {test as base,expect,type Browser,type BrowserContext,type Page} from '@playwright/test';
import {mkdir,mkdtemp,readFile,realpath,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {serverProcess} from './process.js';
import {ownedOPFS} from './owned-opfs.js';
import {recordDOMErrors} from './error-monitor.js';
import {runs,step,throwFailures,finishFixture,type RunState} from './harness-lifecycle.js';
import {publicReadRequest} from '../request/persistence-witness.js';
import {canonical,parseControlJSON} from '../../dist/local/src/protocol/json.js';
import {projectionEvent} from '../../dist/local/src/protocol/projection-schema.js';
const engine=process.env.EDITOR_BROWSER??'chromium';
if(!['chromium','firefox','webkit'].includes(engine))throw Error('Unsupported editor browser');
export const output=resolve(process.env.J1_OUTPUT??'artifacts/j1-browser',engine);
type Local={page:Page;root:string;output:string;commands:any[];read:(path:string)=>Promise<any>;receiptStatus:(id:string)=>Promise<{status:number;body:any}>;restart:()=>Promise<void>;download:(name:string)=>Promise<{path:string;bytes:Buffer}>;importedEvent:(receipt:any)=>Promise<any>;rejectNextCreation:()=>Promise<()=>Promise<void>>;record:(name:string,value:unknown)=>Promise<void>};
export const test=base.extend<{local:Local}>({local:[async({playwright},use,info)=>{
  const caseOutput=join(output,info.title.replace(/[^a-z0-9]+/gi,'-').toLowerCase());await mkdir(caseOutput,{recursive:true});
  const state:RunState={failures:[],roots:[],writerClosed:false,contextClosed:false,browserClosed:false,retention:[],receipt:caseOutput,prefix:'j1-'};
  let root='',profile:string|undefined,browser:Browser|undefined,context:BrowserContext|undefined,page:Page|undefined,server:Awaited<ReturnType<typeof serverProcess>>|undefined,guard:Awaited<ReturnType<typeof ownedOPFS>>|undefined;
  const commands:any[]=[],consoleErrors:{message:string;url:string}[]=[],external:string[]=[],lifecycles:unknown[]=[],effects:unknown[]=[],faults:{url:string;commandId:string;status:503;reason:string}[]=[],csp:unknown[]=[];let errors:unknown[]=[];
  const record=(name:string,value:unknown)=>writeFile(join(caseOutput,name+'.json'),JSON.stringify(value,null,2));
  const close=async()=>{if(!server)return;const owned=server,failures:unknown[]=[];try{const counts=await owned.effects();effects.push(counts);expect(Object.values(counts)).toEqual(Array(8).fill(0));}catch(error){failures.push(error);}try{await owned.close();state.writerClosed=true;server=undefined;}catch(error){failures.push(error);}if(failures.length)throw new AggregateError(failures,'Effects and writer closure');};
  const open=async()=>{server=await serverProcess(root);lifecycles.push(server.lifecycle);state.writerClosed=false;await guard!.admit(page!,server.origin);await page!.goto(await server.pair());await expect(page!.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();};
  try{
    const directory=await mkdtemp(join(await realpath(tmpdir()),'j1-browser-'));state.roots.push(directory);root=join(directory,'private');
    if(engine==='webkit'){profile=await mkdtemp(join(await realpath(tmpdir()),'j1-browser-profile-'));context=await playwright.webkit.launchPersistentContext(profile,{viewport:{width:1440,height:1000},reducedMotion:'reduce'});browser=context.browser()??undefined;}
    else{browser=await playwright[engine as 'chromium'|'firefox'].launch();context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});}
    runs.set(context,state);await Promise.all(context.pages().map(page=>page.close()));context.setDefaultTimeout(15000);page=await context.newPage();guard=await ownedOPFS(context,'j1-document-creation');errors=await recordDOMErrors(context);
    // Exercise the explicit browser-download fallback, as the integration fixture
    // does. Native OS picker interaction/confirmation is outside this J1 gate.
    await context.exposeBinding('j1CSP',(_source,value)=>csp.push(value));await context.addInitScript(()=>{Object.defineProperty(window,'showSaveFilePicker',{value:undefined,configurable:true});addEventListener('securitypolicyviolation',event=>(window as any).j1CSP({directive:event.effectiveDirective,blocked:event.blockedURI}));});
    page.on('console',message=>{if(message.type()==='error')consoleErrors.push({message:message.text(),url:message.location().url});});
    page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/v1/commands')commands.push(request.postDataJSON().command);});
    await context.route('**/*',route=>{const url=new URL(route.request().url());if(['http:','https:'].includes(url.protocol)&&url.origin!==server?.origin){external.push(url.origin);return route.abort();}return route.continue();});
    await open();await record('runtime',{engine,destination:{mode:'browser-download-fallback',nativePicker:'Explicitly unavailable in this fixture; no OS picker qualification',externalConfirmation:false},version:browser?.version(),userAgent:await page.evaluate(()=>navigator.userAgent),pin:JSON.parse(await readFile('node_modules/playwright-core/browsers.json','utf8')).browsers.find((item:any)=>item.name===engine)});
    await use({page,root,output:caseOutput,commands,record,read:path=>page!.evaluate(async spec=>{const response=await fetch(spec.path,spec.init);if(!response.ok)throw Error('Public read '+response.status);return response.json();},publicReadRequest(path)),
      receiptStatus:async id=>{if(!/^[A-Za-z0-9_-]{1,128}$/.test(id))throw Error('Invalid test command identity');const response=await context!.request.get(server!.origin+'/api/v1/commands/'+id,{headers:{'Sec-Fetch-Site':'same-origin','X-App-Client':'LP-1'},failOnStatusCode:false});return {status:response.status(),body:await response.json()};},
      restart:async()=>{await page!.goto('about:blank');await close();await open();},
      download:async name=>{
        const prepared=page!.getByRole('region',{name:'Prepared file',exact:true}),button=prepared.getByRole('button',{name:'Download prepared file',exact:true});
        await expect(button).toBeVisible();
        const [download]=await Promise.all([page!.waitForEvent('download'),button.click()]),path=join(caseOutput,name);
        await download.saveAs(path);expect(await download.failure()).toBeNull();await expect(prepared).toContainText('Download initiated — destination unconfirmed');
        return {path,bytes:await readFile(path)};
      },
      importedEvent:async receipt=>{
        // One small J1 import, not an unbounded general recovery consumer. LP9
        // deliberately references imported transactions even below inline size.
        const result=await page!.evaluate(async({receipt,init})=>{
          const check=(value:unknown,reason:string)=>{if(!value)throw Error('J1 import proof: '+reason);};
          const id=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
          const sequence=(value:unknown)=>typeof value==='string'&&/^(0|[1-9][0-9]*)$/.test(value)&&value.length<=128;
          check(receipt?.status==='accepted'&&id(receipt.commandId)&&id(receipt.transactionId)&&sequence(receipt.fromSeq)&&sequence(receipt.toSeq),'accepted receipt');
          const read=async(path:string,maximum:number,extra:RequestInit={})=>{
            check(path.startsWith('/api/v1/')&&!path.includes('#'),'public path');
            const response=await fetch(path,{...init,...extra});let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,failed=false,failure:unknown,bytes:Uint8Array<ArrayBuffer>|undefined;
            try{
              check(response.ok,'HTTP status');const raw=response.headers.get('content-length'),length=response.status===204?0:raw!==null&&/^(0|[1-9][0-9]*)$/.test(raw)?Number(raw):NaN;
              check(Number.isSafeInteger(length)&&length>=0&&length<=maximum,'bounded content length');bytes=new Uint8Array(length);
              if(response.body){reader=response.body.getReader();let offset=0;for(;;){const part=await reader.read();if(part.done)break;check(offset+part.value.byteLength<=length,'received bytes');bytes.set(part.value,offset);offset+=part.value.byteLength;}check(offset===length,'complete body');}
              else check(length===0,'response body');
            }catch(error){failed=true;failure=error;}
            const cleanup:unknown[]=[];try{if(reader)await reader.cancel();else await response.body?.cancel();}catch(error){cleanup.push(error);}try{reader?.releaseLock();}catch(error){cleanup.push(error);}
            if(cleanup.length)throw new AggregateError([...(failed?[failure]:[]),...cleanup],'J1 import response cleanup');if(failed)throw failure;
            return {response,bytes:bytes!};
          };
          const json=async(path:string)=>{const body=await read(path,65536);return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body.bytes));};
          let recoveryId:string|undefined,failed=false,failure:unknown,retained:{text:string;projectionSchema:number;recordCount:string}|undefined;
          try{
            const page=await json('/api/v1/commands/'+receipt.commandId+'/result'),context=page.recovery;
            if(id(context?.recoveryId))recoveryId=context.recoveryId;
            check(page.protocolVersion===1&&page.kind==='batches'&&recoveryId&&context.highWater===receipt.toSeq&&sequence(context.writerEpoch)&&Number.isSafeInteger(context.projectionSchema)&&Number.isFinite(Date.parse(context.expiresAt)),'command read context');
            check(page.more===false&&page.nextCursor===receipt.toSeq&&Array.isArray(page.batches)&&page.batches.length===1,'complete command page');
            const batch=page.batches[0];check(batch.kind==='transaction-ref'&&batch.transactionId===receipt.transactionId&&batch.fromSeq===receipt.fromSeq&&batch.toSeq===receipt.toSeq,'exact imported transaction reference');
            const same=(other:any)=>{for(const key of ['recoveryId','writerEpoch','projectionSchema','highWater'])check(other?.[key]===context[key],'matching recovery '+key);};same(batch.recovery);
            const ref=batch.content;check(ref&&id(ref.contentId)&&ref.url==='/api/v1/protocol-content/'+ref.contentId+'?recoveryId='+recoveryId&&ref.encoding==='lp1-events-jsonl'&&ref.blob?.mediaType==='application/x-ndjson'&&/^sha256:[a-f0-9]{64}$/.test(ref.blob.hash)&&sequence(ref.blob.byteLength)&&Number(ref.blob.byteLength)<=1024*1024&&sequence(ref.recordCount)&&batch.eventCount===ref.recordCount,'content identity');
            check(Number(ref.recordCount)>=1&&Number(ref.recordCount)<=64&&BigInt(ref.recordCount)===BigInt(receipt.toSeq)-BigInt(receipt.fromSeq)+1n,'bounded exact event count');
            const body=await read(ref.url,1024*1024);check(body.response.headers.get('content-length')===ref.blob.byteLength&&body.response.headers.get('content-type')===ref.blob.mediaType&&body.response.headers.get('etag')==='"'+ref.blob.hash+'"','content headers');
            const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',body.bytes))).map(value=>value.toString(16).padStart(2,'0')).join('');check('sha256:'+digest===ref.blob.hash,'exact content hash');
            let lineBytes=0,records=0;for(const value of body.bytes){if(value===10){check(lineBytes>0&&lineBytes<=16384,'bounded event record');records++;check(records<=64,'bounded record count');lineBytes=0;}else{lineBytes++;check(lineBytes<=16384,'bounded event record');}}check(lineBytes===0&&String(records)===ref.recordCount,'complete JSONL records');
            const proof=await json('/api/v1/events?after='+receipt.toSeq+'&recoveryId='+recoveryId);same(proof.recovery);check(proof.protocolVersion===1&&proof.kind==='batches'&&proof.more===false&&proof.nextCursor===receipt.toSeq&&Array.isArray(proof.batches)&&proof.batches.length===0,'terminal command proof');
            retained={text:new TextDecoder('utf-8',{fatal:true}).decode(body.bytes),projectionSchema:context.projectionSchema,recordCount:ref.recordCount};
          }catch(error){failed=true;failure=error;}
          finally{
            if(recoveryId)try{
              // CSRF remains page-local and is neither returned nor recorded.
              const session=await json('/api/v1/session');check(session.protocolVersion===1&&typeof session.csrfToken==='string'&&session.csrfToken.length>0&&session.csrfToken.length<=256,'release authority');
              const released=await read('/api/v1/recovery/'+recoveryId+'/release',0,{method:'POST',headers:{...init.headers,'Content-Type':'application/json','X-App-CSRF':session.csrfToken},body:'{"protocolVersion":1}'});check(released.response.status===204,'released read context');
            }catch(error){throw new AggregateError([...(failed?[failure]:[]),error],'J1 import read release failed');}
          }
          if(failed)throw failure;return retained!;
        },{receipt,init:publicReadRequest('/api/v1/commands/'+receipt.commandId+'/result').init});
        expect(result.text.endsWith('\n')).toBe(true);const lines=result.text.slice(0,-1).split('\n');expect(String(lines.length)).toBe(result.recordCount);
        const events=lines.map((line,index)=>{const bytes=Buffer.from(line);expect(bytes.length).toBeLessThanOrEqual(16384);const event=parseControlJSON(bytes);expect(canonical(event)).toBe(line);projectionEvent(result.projectionSchema,event);expect(event.commandId).toBe(receipt.commandId);expect(event.transactionId).toBe(receipt.transactionId);expect(event.workspaceSeq).toBe(String(BigInt(receipt.fromSeq)+BigInt(index)));return event;});
        const imported=events.filter(event=>event.type==='BundleImported');expect(imported).toHaveLength(1);return imported[0];
      },
      rejectNextCreation:async()=>{
        let refused=false;const pattern='**/api/v1/commands';
        const handler=async(route:import('@playwright/test').Route)=>{const request=route.request().postDataJSON();if(!refused&&request.command.body.type==='CreateDocument'){
          refused=true;faults.push({url:route.request().url(),commandId:request.command.commandId,status:503,reason:'Explicit test-only service-unavailable response before any writer dispatch; this is not a disk-full qualification.'});
          await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({protocolVersion:1,error:{code:'STORAGE_FULL',message:'Controlled service unavailability before creation',retryable:true}})});
        }else await route.continue();};
        await page!.route(pattern,handler);return async()=>{await page!.unroute(pattern,handler);expect(refused).toBe(true);};
      },
    });
  }catch(error){state.failures.push({phase:'body',error});}
  finally{
    if(info.errors.length)state.failures.push({phase:'playwright-errors',error:new AggregateError(info.errors.map(error=>Error(error.message??JSON.stringify(error))),'Playwright errors retained')});
    if(page&&!page.isClosed())await step(state,'closing-aria',async()=>writeFile(join(caseOutput,'closing.aria.txt'),await page!.locator('body').ariaSnapshot({timeout:5000})));
    if(guard)await step(state,'owned-opfs-cleanup',async()=>{if(page&&!page.isClosed())await page.goto('about:blank');await guard!.cleanup();guard!.verify();});
    await step(state,'writer-close',close);
    const expectedConsole=(item:{message:string;url:string})=>faults.some(fault=>fault.url===item.url&&item.message==='Failed to load resource: the server responded with a status of 503 (Service Unavailable)');
    state.observe=()=>({commands,faults,consoleErrors,unmatchedConsole:consoleErrors.filter(item=>!expectedConsole(item)),external,csp,errors,effects,lifecycles:JSON.parse(JSON.stringify(lifecycles,(_key,value)=>typeof value==='string'?value.replace(/#pairing=[^\s"'<>]+/g,'#pairing=<redacted>'):value)),storage:guard?.ledger,requests:guard?.requests});
    state.finalCheck=async()=>{expect(external).toEqual([]);expect(csp).toEqual([]);expect(errors).toEqual([]);expect(consoleErrors.filter(item=>!expectedConsole(item))).toEqual([]);guard?.verify();};
    if(context)await finishFixture(context,browser,profile,caseOutput,'j1-',info);
    else{state.contextClosed=true;state.browserClosed=await step(state,'browser-close-after-setup-failure',async()=>{await browser?.close();});if(profile)state.roots.push(profile);await step(state,'setup-failure-receipt',()=>record('setup-failure',{roots:state.roots,errors:state.failures.map(item=>({phase:item.phase,error:String(item.error)}))}));}
    throwFailures(state.failures);
  }
},{timeout:300000}]});
