// @ts-ignore Test-only coherent public/native draft boundary.
import {adoptNativeInput,readNativeState,nativeDescriptor,selectNativeFont,cancelAndReopenNativeFont,readDraftOccurrences} from './completion/font-state.mjs';
import {test as base,expect,type Page,type BrowserContext} from '@playwright/test';
import {mkdtemp,realpath,mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {execFileSync} from 'node:child_process';
import {serverProcess} from './process.js';
import {ownedOPFS} from './owned-opfs.js';
import {recordDOMErrors} from './error-monitor.js';
import {integrationCancellation} from './integration-network.mjs';
import {originalFontReader,sealedBrowserFonts} from './original-font-reader.js';
import {originalRecoveryReader} from './original-recovery-reader.js';
// @ts-ignore Test-owned pinned Chromium completion observer.
import {completionMonitor} from './completion/monitor.mjs';
// @ts-ignore Independent test-owned teardown steps.
import {independentSteps} from './completion/boundary.mjs';
// @ts-ignore Test-owned partial-acquisition cleanup shared with controls.
import {acquireOwnedSetup} from './completion/setup-owned.mjs';

// Fresh native origin storage is verified independently of profile isolation.
// All stores and profiles remain under the caller's explicit TMPDIR.
export const test=base.extend({context:async({playwright,browserName,contextOptions,viewport},use)=>{
 const profile=await mkdtemp(join(await realpath(tmpdir()),'p1c6-'+browserName+'-'));
 const executable=process.env.EDITOR_BROWSER_EXECUTABLE??playwright[browserName].executablePath();
 const context=await playwright[browserName].launchPersistentContext(profile,{...contextOptions,viewport,executablePath:executable,env:{...process.env,TMPDIR:process.env.TMPDIR!}});
 const ownedProcesses=execFileSync('/bin/ps',['-axww','-o','pid=','-o','command='],{encoding:'utf8'}).split('\n').map(line=>line.match(/^\s*(\d+)\s+(.*)$/)).filter(Boolean).map(m=>({pid:Number(m![1]),command:m![2]})).filter(p=>p.command.includes(executable)&&p.command.includes(profile));
 expect(ownedProcesses.length,'Running process must identify the selected executable and fresh profile').toBeGreaterThan(0);
 const identity={engine:browserName,version:context.browser()?.version(),executable,executableSHA256:sha(await readFile(executable)),ownedProcesses,profile,temporaryDirectory:process.env.TMPDIR};
 await mkdir(process.env.EDITOR_RECEIPT!,{recursive:true});await writeFile(join(process.env.EDITOR_RECEIPT!,'browser-'+profile.split('/').at(-1)+'.json'),JSON.stringify(identity,null,2));
 await Promise.all(context.pages().map(p=>p.close()));
 try{await use(context);}finally{await context.close();}
}});
export {expect};
export const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
export const click=(p:Page,name:string)=>p.getByRole('button',{name,exact:true}).click();
export async function field(p:Page,name:string,value:string){const f=p.getByRole('spinbutton',{name,exact:true});await f.fill(value);await f.press('Tab');}
export const objectPath=(root:string,ref:any)=>join(root,'objects','sha256',ref.hash.slice(7,9),ref.hash.slice(7));
export const object=(root:string,ref:any)=>readFile(objectPath(root,ref));
export function rows(root:string,table:'documents'|'assets'|'history'|'ui_checkpoints'){
 const db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});
 try{return db.prepare('SELECT json FROM '+table).all().map(r=>JSON.parse(String(r.json)));}finally{db.close();}
}
export async function state(root:string,id?:string){const document=rows(root,'documents').find(d=>!id||d.id===id);return {document,image:JSON.parse((await object(root,document.image.state)).toString())};}
export async function fixture(page:Page,context:BrowserContext,engine:string,name:string){
 const out=join(process.env.EDITOR_RECEIPT!,name);await mkdir(out,{recursive:true});const fonts=await sealedBrowserFonts();
 const directory=await mkdtemp(join(await realpath(tmpdir()),'p1c6-'+name+'-')),root=join(directory,'private');
 let serverIndex=1;const completionLedger=()=>join(out,'completion-server-'+serverIndex+'.jsonl');
 const buildFixture=async(ownedServer:Awaited<ReturnType<typeof serverProcess>>)=>{
 let server=ownedServer,sequence=0,phase='workflow',exportWindow=false;
 const ancillaryOrigins=new Set<string>(),noStaticIcon=!(await readdir('dist/app')).includes('favicon.ico');
 const origins=new Set<string>(),events:any[]=[],commands:any[]=[],downloads:any[]=[],effects:any[]=[],pending:Promise<unknown>[]=[],responses=new WeakMap<any,any>(),ids=new WeakMap<any,number>(),workers=new Set<any>();
 const activeRequests=new Set<any>();
 const importedHeads:any[]=[],wasmReads:any[]=[],fontTransitions:any[]=[];const faultResponses=new Set<number>(),faults:{url:string;status:number;reason:string}[]=[],exportRequests:any[]=[];
 const id=(r:any)=>{if(!ids.has(r))ids.set(r,++sequence);return ids.get(r)!;};
 const fontObserver=await originalFontReader(context,out,fonts,id);
 const recoveryObserver=await originalRecoveryReader(context,out,id);
 const guard=await ownedOPFS(context,'p1c6-'+name+'-'+engine),dom=await recordDOMErrors(context);
 const completion=engine==='chromium'?await completionMonitor({page,context,root,out,id,expect,storageProbePath:'/__e1_storage_'+guard.run,fixture:name,mode:name==='busy-actions'?'EMPTY-NATIVE':name==='restored-reads'?'RESTORED-NON-NATIVE':'NATIVE-COMPLETION'}):undefined;
 const instrument=(p:Page)=>{p.on('worker',w=>{workers.add(w);w.once('close',()=>workers.delete(w));});p.on('pageerror',e=>events.push({channel:'pageerror',phase,message:e.message}));p.on('console',m=>{if(m.type()==='error')events.push({channel:'console',phase,message:m.text(),url:m.location().url,page:p.url().replace(/#.*$/,'')});});};
 context.on('page',instrument);for(const p of context.pages())instrument(p);
 await context.exposeBinding('integrationCSP',(_source,value)=>events.push({channel:'csp',phase,...value}));
 await context.addInitScript(()=>{Object.defineProperty(window,'showSaveFilePicker',{value:undefined,configurable:true});addEventListener('securitypolicyviolation',e=>(window as any).integrationCSP({directive:e.effectiveDirective,blocked:e.blockedURI}));});
 context.on('request',r=>{const u=new URL(r.url());if(/^https?:$/.test(u.protocol)&&u.pathname!=='/api/v1/events/stream')activeRequests.add(r);events.push({channel:'request',phase,requestId:id(r),url:r.url(),method:r.method(),resourceType:r.resourceType()});if(exportWindow&&r.method()==='GET'&&u.origin===server.origin&&u.pathname.endsWith('/content'))exportRequests.push(r);if(r.method()==='POST'&&u.pathname==='/api/v1/commands')commands.push(r.postDataJSON().command);});
 context.on('response',r=>{
  const e={channel:'response',phase,requestId:id(r.request()),url:r.url(),method:r.request().method(),status:r.status(),contentType:r.headers()['content-type'],contentLength:r.headers()['content-length'],etag:r.headers()['etag'],entityVersion:r.headers()['x-app-entity-version']};responses.set(r.request(),e);events.push(e);
  if(r.request().method()==='HEAD'&&/^\/api\/v1\/documents\/p_[a-f0-9]{64}$/.test(new URL(r.url()).pathname)){const documentId=new URL(r.url()).pathname.split('/').at(-1)!;const db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});try{const row=db.prepare("SELECT m.namespace,m.source_id,m.local_id,n.document_id,d.json FROM portable_maps m JOIN portable_namespaces n ON n.id=m.namespace JOIN documents d ON d.id=m.local_id WHERE m.kind='document' AND m.local_id=? AND n.document_id=m.local_id").get(documentId);if(row){const document=JSON.parse(String(row.json));importedHeads.push({requestId:e.requestId,url:e.url,origin:server.origin,root,namespace:row.namespace,sourceId:row.source_id,localId:row.local_id,documentId:row.document_id,revision:document.revision,computedId:'p_'+sha(Buffer.from(JSON.stringify([row.namespace,'document',row.source_id]))),redirectedFrom:r.request().redirectedFrom()?.url()??null,fromServiceWorker:r.fromServiceWorker(),ownerPage:r.request().frame().page()===page});}}finally{db.close();}}
  if(r.status()>=400)pending.push((async()=>{const body=await r.text().catch(()=>'<unavailable>');events.push({...e,channel:'http-error',body});if(faults.some(f=>f.url===r.url()&&f.status===r.status()))faultResponses.add(e.requestId);})());
 });
 context.on('requestfinished',r=>{activeRequests.delete(r);events.push({channel:'requestfinished',phase,requestId:id(r),url:r.url(),method:r.method()});});
 context.on('requestfailed',r=>{activeRequests.delete(r);events.push({channel:'requestfailed',phase,requestId:id(r),url:r.url(),method:r.method(),resourceType:r.resourceType(),failure:r.failure(),response:responses.get(r)??null});});
 async function admit(){completion?.begin(server,completionLedger());origins.add(server.origin);await guard.admit(page,server.origin);await page.goto(await server.pair());await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();await completion?.activate();expect(noStaticIcon).toBe(true);expect(await page.locator('link[rel~=icon]').count()).toBe(0);ancillaryOrigins.add(server.origin);}
 async function quiesce(departure:'restart'|'terminal'|'cleanup'){const awaitingResponse=()=>[...activeRequests].filter(r=>!responses.has(r)).map(r=>({requestId:id(r),url:r.url()}));events.push({channel:'await-own-response-headers',active:[...activeRequests].map(r=>({requestId:id(r),url:r.url(),response:responses.get(r)??null}))});try{await expect.poll(awaitingResponse,{message:'Deliver this workflow’s outstanding response headers before explicit restart/navigation; completed-body and error checks remain separate',timeout:15000}).toEqual([]);events.push({channel:'own-response-headers-delivered',stillOpen:[...activeRequests].map(r=>({requestId:id(r),url:r.url()}))});await completion?.closeEpoch();}finally{await fontObserver.flush();await recoveryObserver.flush();try{await completion?.beforeNavigate();}finally{if(completion){await completion.depart(departure);await completion.beforeServerStop();}else for(const p of context.pages())await p.goto('about:blank');await expect.poll(()=>workers.size).toBe(0);}}}
 async function zeroEffects(label:string){const value=await server.effects();effects.push({label,pid:server.pid,origin:server.origin,value});expect(Object.keys(value)).toHaveLength(8);expect(Object.values(value)).toEqual(Array(8).fill(0));}
 async function saveDownload(label:string){
  exportRequests.length=0;exportWindow=true;const promise=page.waitForEvent('download');await click(page,'Download prepared file');const download=await promise,path=join(out,label);await download.saveAs(path);exportWindow=false;
  expect(await download.failure()).toBeNull();expect(exportRequests).toHaveLength(1);
  const request=exportRequests[0],response=await request.response(),r=responses.get(request),bytes=await readFile(path);expect(response!.request()).toBe(request);expect(r.status).toBe(200);expect(r.contentLength).toBe(String(bytes.length));expect(r.etag).toBe('"sha256:'+sha(bytes)+'"');expect(download.url().startsWith('blob:'+server.origin+'/')).toBe(true);
  downloads.push({requestId:id(request),url:request.url(),bytes:bytes.length,sha256:sha(bytes),path,downloadURL:download.url(),downloadName:download.suggestedFilename(),oneOwnedRequestInExplicitExportWindow:true,destinationComplete:true});
  await expect(page.getByText(/External destination remains unconfirmed/)).toBeVisible();return {path,bytes};
 }
 return {root,out,events,commands,downloads,admit,get server(){return server;},fault(url:string,status:number,reason:string){faults.push({url,status,reason});},
  restoredRoute(pattern:string,path:string){return completion?.restoredRoute(pattern,path);}, heldRoute(route:any){return completion?.heldRoute(route);},
  selectFont:(intent:any,document:any,acceptedText:string)=>selectNativeFont({page,expect,read:(id:string)=>readNativeState(root,id),intent,document,acceptedText,priorOwner:undefined,commands:()=>commands,record:(row:any)=>fontTransitions.push(row)}),
  reopenFont:(previous:any,intent:any,document:any,acceptedText:string)=>cancelAndReopenNativeFont({page,expect,read:(id:string)=>readNativeState(root,id),occurrences:(id:string)=>readDraftOccurrences(root,id),previous,intent,document,acceptedText,commands:()=>commands,record:(row:any)=>fontTransitions.push(row)}),
  async native(kind:'Preview'|'Apply',work:()=>Promise<unknown>,intent?:any){if(completion)await completion.operation(kind,work,intent);else if(intent){const node=await page.locator('#native-text-content').elementHandle();if(!node)throw Error('Native textarea missing');try{await adoptNativeInput({expect,observe:()=>node.evaluate(nativeDescriptor),read:(id:string)=>readNativeState(root,id),intent});await work();}finally{await node.dispose();}}else await work();},
  async copy(label:string){await click(page,'Save copy');await expect(page.locator('#editor-dialog')).toContainText('substituting a current font does not repair older history');await click(page,'Prepare complete copy');await expect(page.getByRole('region',{name:'Prepared file'})).toBeVisible();return saveDownload(label);},
  async png(label:string){await click(page,'Export image');await expect(page.getByRole('region',{name:'Prepared file'})).toContainText('Exact PNG');return saveDownload(label);},
  async restart(){await quiesce('restart');await zeroEffects('before-restart');const old={pid:server.pid,origin:server.origin};await server.kill();serverIndex++;server=await serverProcess(root,undefined,engine==='chromium'?completionLedger():undefined);expect(server.pid).not.toBe(old.pid);expect(server.origin).not.toBe(old.origin);events.push({channel:'process-restart',old,current:{pid:server.pid,origin:server.origin}});await admit();},
  async finish(primaryError?:unknown){
   let cleanupError:unknown;const cleanupFailures:any[]=[],cleanup={contextClosed:false,serverClosed:false};const attempt=async(name:string,work:()=>Promise<unknown>)=>{try{await work();}catch(error){cleanupFailures.push({phase:name,message:String(error)});}};if(primaryError){await writeFile(join(out,'failure-page.txt'),await page.locator('body').ariaSnapshot().catch(e=>'Snapshot unavailable: '+String(e)));await writeFile(join(out,'failure-validation.json'),JSON.stringify(await page.locator('en-validation-summary').evaluateAll(elements=>elements.map(e=>({items:(e as any).items,heading:e.getAttribute('heading'),connected:e.isConnected}))).catch(e=>String(e)),null,2));} 
   let fontProofs:any[]=[],recoveryProofs:any={proofs:[],sse:[],errors:[]};
   phase='shutdown';await attempt('quiesce',()=>quiesce(primaryError?'cleanup':'terminal'));await attempt('effects',()=>zeroEffects('shutdown'));await independentSteps([['completion-detach',async()=>{await completion?.detach();}],['owned-storage',async()=>{completion?.beforeStorageReset();await guard.cleanup();guard.verify();}]],cleanupFailures);
   await attempt('font-proof',async()=>{const db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});try{fontProofs=await fontObserver.seal(id=>{const row=db.prepare('SELECT receipt FROM commands WHERE id=?').get(id);return row?JSON.parse(String(row.receipt)):null;});}finally{db.close();}});
   await attempt('recovery-proof',async()=>{const store=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});try{recoveryProofs=await recoveryObserver.seal(id=>{const row=store.prepare('SELECT original,receipt FROM commands WHERE id=?').get(id);if(!row)return null;const command=JSON.parse(String(row.original)).command;return {clientId:command.clientId,sessionId:command.sessionId,receipt:JSON.parse(String(row.receipt)),events:store.prepare('SELECT json FROM events_v2 WHERE command_id=? ORDER BY length(seq),seq').all(id).map(r=>JSON.parse(String(r.json)))};});}finally{store.close();}});
   await attempt('context-close',async()=>{await context.close();cleanup.contextClosed=true;});await attempt('server-close',async()=>{await server.close({cleanupOnly:!!primaryError||cleanupFailures.length>0});cleanup.serverClosed=true;});await attempt('observations',()=>Promise.all(pending));await attempt('completion-proof',async()=>{await completion?.finish(!primaryError&&cleanupFailures.length===0&&cleanup.contextClosed&&cleanup.serverClosed);});if(cleanupFailures.length)cleanupError=cleanupFailures;
   
   const unmatched=events.filter(e=>{
    if(['pageerror','csp'].includes(e.channel))return true;
    if(e.channel==='request'&&/^https?:/.test(e.url))return !origins.has(new URL(e.url).origin);
    const optionalIcon=[...ancillaryOrigins].some(origin=>e.url===origin+'/favicon.ico'&&((e.channel==='console'&&e.page===origin+'/'&&e.message==='Failed to load resource: the server responded with a status of 404 (Not Found)')||(e.channel==='http-error'&&e.method==='GET'&&e.status===404)));if(optionalIcon)return false;
    if(e.channel==='http-error')return !faultResponses.has(e.requestId);
    if(e.channel==='console')return !events.some(r=>r.channel==='http-error'&&r.url===e.url&&faultResponses.has(r.requestId)&&e.message===`Failed to load resource: the server responded with a status of ${r.status} (${r.status===404?'Not Found':'Internal Server Error'})`);
    if(e.channel!=='requestfailed')return false;
    if(completion?.privateEvent(e))return false;
    return !(engine==='chromium'&&completion?.qualifies(e))&&![...origins].some(o=>integrationCancellation(e,o,engine,downloads,faults,fontProofs,importedHeads,recoveryProofs));
   });
   await writeFile(join(out,'observations.json'),JSON.stringify({engine,root,ancillaryIconProof:{noStaticIcon,origins:[...ancillaryOrigins]},phase,events,commands,downloads,effects,dom,faults,fontProofs,importedHeads,recoveryProofs,wasmReads,fontTransitions,unmatched,cleanupError,primaryError:primaryError instanceof Error?{message:primaryError.message,stack:primaryError.stack}:primaryError},null,2));await writeFile(join(out,'ownership.json'),JSON.stringify({run:guard.run,ledger:guard.ledger,workers:workers.size,...cleanup},null,2));
   const problems=[primaryError,cleanupError,recoveryProofs.errors.length?Error('Recovery observation errors: '+JSON.stringify(recoveryProofs.errors)):null,wasmReads.some(r=>!r.matchesSealed)?Error('Incomplete same-response WASM proof: '+JSON.stringify(wasmReads)):null,dom.length?Error('DOM errors: '+JSON.stringify(dom)):null,unmatched.length?Error('Unmatched observations: '+JSON.stringify(unmatched)):null].filter(Boolean);if(problems.length)throw new AggregateError(problems,'Integrated workflow and shutdown failures (all preserved)');
  }
 };
 };
 const setup=await acquireOwnedSetup([
  ['context',async()=>context,async(c:BrowserContext)=>c.close()],
  ['server',async()=>serverProcess(root,undefined,engine==='chromium'?completionLedger():undefined),async(s:Awaited<ReturnType<typeof serverProcess>>)=>s.close({cleanupOnly:true})],
  ['fixture',async(owned:{server:Awaited<ReturnType<typeof serverProcess>>})=>buildFixture(owned.server)],
 ]);
 return (setup as {fixture:Awaited<ReturnType<typeof buildFixture>>}).fixture;
}
