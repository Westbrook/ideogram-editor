import {confirmImageImports} from '../editor/image-import-flow.js';
import {test as base,expect,type Page,type Locator,type JSHandle,type Request,type Response} from '@playwright/test';
import {mkdtemp,realpath,readFile,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {serverProcess} from './process.js';
import {ownedOPFS} from '../editor/owned-opfs.js';
import {recordDOMErrors} from '../editor/error-monitor.js';
import {runs,step,throwFailures,finishFixture,type RunState} from '../editor/harness-lifecycle.js';
import {publicReadRequest} from '../request/persistence-witness.js';

// Incidental protocol diagnostics use native metadata; actual public reads below own their JSON bodies.
function postResponseMetadata(page:Page,state:RunState,apiOrigin?:()=>string|undefined,limit:1024|2048=1024){
  type Row={id:number;method:string;origin:string;path:string;query?:Record<string,string[]>|null;unknownQueryKeys?:number;queryIncomplete?:boolean;postKind:'command'|'ui'|null;postId:string|null;postType:string|null;startedAt:string;startedMs:number;responseMs:number|null;status:number|null;terminal:'pending'|'finished'|'failed';terminalMs:number|null;failureText:string|null};
  type ConsoleRow={errorIndex:number;atMs:number;origin:string|null;path:string|null;line:number|null;column:number|null;locationAvailable:boolean};
  const consoleLimit=128,rows:Row[]=[],consoleRows:ConsoleRow[]=[],identities=new WeakMap<Request,Row>(),omitted=new WeakSet<Request>();let dropped=0,truncated=0,consoleDropped=0,consoleErrors=0,stopped=false;
  const bounded=(value:unknown,cap:number)=>{if(typeof value!=='string')return null;if(value.length>cap)truncated++;return value.slice(0,cap);};
  const retain=(request:Request)=>{
    const previous=identities.get(request);if(previous)return previous;if(stopped||omitted.has(request))return;
    if(rows.length===limit){if(!dropped)state.failures.push({phase:'response-metadata',error:Error('E3_RESPONSE_METADATA_LIMIT')});dropped++;omitted.add(request);return;}
    const url=new URL(request.url()),query:Record<string,string[]>|null=apiOrigin&&/^\/api\/v1\/assets\/[^/]+\/(display|display-tile)$/.test(url.pathname)?{}:null;
    let unknownQueryKeys=0,queryIncomplete=false;
    if(query){let entries=0;for(const [key,value]of url.searchParams){if(++entries>32){queryIncomplete=true;truncated++;break;}if(!['identity','basis','edge','lod','x','y'].includes(key)){unknownQueryKeys++;continue;}(query[key]??=[]).push(bounded(value,256)!);}}
    const row:Row={id:rows.length+1,method:request.method(),origin:bounded(url.origin,256)!,path:bounded(url.pathname,1024)!,...(apiOrigin?{query,unknownQueryKeys,queryIncomplete}:{}),postKind:null,postId:null,postType:null,startedAt:new Date().toISOString(),startedMs:performance.now(),responseMs:null,status:null,terminal:'pending',terminalMs:null,failureText:null};rows.push(row);identities.set(request,row);return row;
  };
  const request=(value:Request)=>{const url=new URL(value.url());if(url.origin===apiOrigin?.()&&url.pathname.startsWith('/api/v1/'))retain(value);};
  const response=(value:Response)=>{const row=identities.get(value.request());if(row){row.status=value.status();row.responseMs=performance.now();}};
  const terminal=(request:Request,outcome:'finished'|'failed')=>{const row=identities.get(request);if(row){row.terminal=outcome;row.terminalMs=performance.now();row.failureText=bounded(request.failure()?.errorText,256);}};
  const finished=(request:Request)=>terminal(request,'finished'),failed=(request:Request)=>terminal(request,'failed');
  const consoleError=(message:import('@playwright/test').ConsoleMessage)=>{
    if(message.type()!=='error')return;const errorIndex=++consoleErrors;
    if(consoleRows.length===consoleLimit){if(!consoleDropped)state.failures.push({phase:'console-metadata',error:Error('E3_CONSOLE_METADATA_LIMIT')});consoleDropped++;return;}
    const location=message.location();let url:URL|undefined;try{if(location.url){const parsed=new URL(location.url);if(['http:','https:'].includes(parsed.protocol))url=parsed;}}catch{}
    consoleRows.push({errorIndex,atMs:performance.now(),origin:url?bounded(url.origin,256):null,path:url?bounded(url.pathname,1024):null,line:Number.isFinite(location.lineNumber)?location.lineNumber:null,column:Number.isFinite(location.columnNumber)?location.columnNumber:null,locationAvailable:!!url});
  };
  if(apiOrigin){page.on('request',request);page.on('console',consoleError);}
  page.on('response',response);page.on('requestfinished',finished);page.on('requestfailed',failed);
  return {
    admit(request:Request,postKind:'command'|'ui',value:any){const row=retain(request);if(row){row.postKind=postKind;row.postId=bounded(postKind==='command'?value.commandId:value.requestId,128);row.postType=bounded(value.body?.type,128);}},
    snapshot(){return apiOrigin?{schemaVersion:2,kind:'e3-api-response-metadata',responseBodiesRead:false,limit,dropped,truncated,rows,consoleLimit,consoleDropped,consoleRows}:{schemaVersion:1,kind:'e3-post-response-metadata',responseBodiesRead:false,limit,dropped,truncated,rows};},
    stop(){stopped=true;if(apiOrigin){page.off('request',request);page.off('console',consoleError);}page.off('response',response);page.off('requestfinished',finished);page.off('requestfailed',failed);}
  };
}

// Diagnostic-only DOM chronology. It observes the existing reveal actions without
// reading application internals, input text, request bodies, or changing focus/events.
async function observeRevealChronology(page:Page,state:RunState,prefix:string,record:unknown[],work:()=>Promise<void>){
  const probe=await page.evaluateHandle(({prefix})=>{
    const limit=256,rows:Record<string,unknown>[]=[],candidateId=prefix.replace(/^candidate-comparison-/,'').replace(/-lettering-(alone-off|off-on)$/,''),deferredId='request-candidate-deferred-review-'+candidateId;
    let dropped=0,stopped=false,last='';
    const identity=(element:Element)=>({tag:element.localName,id:element.id.slice(0,160),role:element.getAttribute('role')?.slice(0,64)??null});
    const active=()=>{const result:ReturnType<typeof identity>[]= [];let element=document.activeElement;for(let i=0;element&&i<6;i++){result.push(identity(element));element=element.shadowRoot?.activeElement??null;}return result;};
    const snapshot=()=>{
      const deferred=document.getElementById(deferredId),reveal=document.getElementById(prefix+'-reveal') as (HTMLElement&{value?:unknown})|null,treatment=document.getElementById('candidate-text-treatment-'+candidateId);
      const editor=(performance.getEntriesByName('ie.editor.updated').at(-1) as PerformanceMark|undefined)?.detail;
      return {deferredPresent:!!deferred,reviewId:deferred?.getAttribute('data-review-id')?.slice(0,160)??null,reviewHash:deferred?.getAttribute('data-review-hash')?.slice(0,160)??null,revealPresent:!!reveal,revealValue:typeof reveal?.value==='string'?reveal.value.slice(0,32):null,staleProvenance:!!treatment?.textContent?.includes('The candidate or document changed. Reload its retained provenance and review the placement again.'),active:active(),documentId:typeof editor?.documentId==='string'?editor.documentId.slice(0,160):null,revision:typeof editor?.revision==='string'?editor.revision.slice(0,64):null};
    };
    const retain=(kind:string,detail:Record<string,unknown>={})=>{if(stopped)return;if(rows.length===limit){dropped++;return;}rows.push({sequence:rows.length+1,kind,epochMs:performance.timeOrigin+performance.now(),...detail,dom:snapshot()});};
    const events=['compositionstart','compositionupdate','compositionend','focusin','focusout','beforeinput','input','change','en-input','en-change'];
    const observe=(event:Event)=>{
      const elements=event.composedPath().filter((value):value is Element=>value instanceof Element);
      if(!elements.some(element=>element.classList.contains('typed-request')))return;
      retain('event',{type:event.type,eventTimeStamp:event.timeStamp,phase:event.eventPhase,defaultPrevented:event.defaultPrevented,isComposing:'isComposing'in event?(event as InputEvent).isComposing:null,inputType:'inputType'in event&&typeof(event as InputEvent).inputType==='string'?(event as InputEvent).inputType.slice(0,64):null,path:elements.slice(0,6).map(identity)});
    };
    for(const event of events)document.addEventListener(event,observe,true);
    const mutations=new MutationObserver(()=>{const current=JSON.stringify(snapshot());if(current!==last){last=current;retain('dom-change');}});
    mutations.observe(document,{subtree:true,childList:true,attributes:true,attributeFilter:['data-review-id','data-review-hash','disabled']});
    retain('start');last=JSON.stringify(snapshot());
    return {stop(){retain('finish');stopped=true;mutations.disconnect();for(const event of events)document.removeEventListener(event,observe,true);return {kind:'e3-reveal-dom-chronology-1',prefix,limit,dropped,rows,responseBodiesRead:false,applicationInternalsRead:false};}};
  },{prefix});
  try{await work();}finally{
    try{const result=await probe.evaluate(value=>value.stop());record.push(result);if(result.dropped)state.failures.push({phase:'reveal-chronology',error:Error('E3_REVEAL_CHRONOLOGY_LIMIT')});}
    catch(error){state.failures.push({phase:'reveal-chronology',error});}
    finally{try{await probe.dispose();}catch(error){state.failures.push({phase:'reveal-chronology-dispose',error});}}
  }
}

const receipt=process.env.EDITOR_RECEIPT??'artifacts/p26-request-edits';
const maskReReviewTitle='E3 actual-output placement re-review retains the decoded mask element without another native load';
const nativeDeferredAdoptionTitle='E3 native deferred adoption preserves the overlay and recovers frozen native copies through encoded rebuild';
const deferredAdoptionTitle='E3 encoded candidate deferred acceptance preserves the source exterior in a new document';
const test=base.extend({context:async({playwright,browserName,contextOptions,viewport},use,info)=>{
  const prefix=info.title===maskReReviewTitle?'e3-mask-rereview-':info.title===deferredAdoptionTitle?'e3-deferred-':info.title===nativeDeferredAdoptionTitle?'e3-native-deferred-':'e3-';
  const profile=browserName==='webkit'?await mkdtemp(join(await realpath(tmpdir()),'p26-webkit-')):undefined;
  const browser=profile?undefined:await playwright[browserName].launch();
  const context=profile?await playwright.webkit.launchPersistentContext(profile,{...contextOptions,viewport}):await browser!.newContext({...contextOptions,viewport});
  await Promise.all(context.pages().map(page=>page.close()));
  try{await use(context);}finally{await finishFixture(context,browser,profile,receipt,prefix,info);}
}});
const click=(page:Page,name:string)=>page.getByRole('button',{name,exact:true}).click();
const button=(page:Page,id:string)=>page.locator('#'+id).getByRole('button');
async function keyboard(control:Locator){await expect(control).toBeEnabled();await control.focus();await expect(control).toBeFocused();await control.press('Enter');}
async function currentDocument(page:Page,id:string,revision?:string){await expect.poll(()=>page.evaluate(expectedRevision=>{const view=(performance.getEntriesByName('ie.editor.updated').at(-1) as PerformanceMark|undefined)?.detail;return view?.ready===true&&view.busy===false&&(expectedRevision===undefined||view.revision===expectedRevision)?view.documentId:null;},revision)).toBe(id);}
async function number(page:Page,name:string,value:string){const input=page.getByRole('spinbutton',{name,exact:true});await input.fill(value);await input.press('Tab');}
async function numeric(page:Page,id:string,value:string){const input=page.locator('#'+id).getByRole('spinbutton');await input.fill(value);await input.press('Tab');}
const digest=(bytes:Uint8Array)=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const objectPath=(root:string,ref:{hash:string})=>join(root,'objects','sha256',ref.hash.slice(7,9),ref.hash.slice(7));

// This is a public UI assembly test. Only the provider boundary is a local
// fixture; capture, authoring, staging, preparation, acceptance and history use
// the same commands and retained objects as the editor.
test('E3 keyboard mask and native overlay survive safe adoption history and stale-target recovery',async({page,context,browserName})=>{
  const guard=await ownedOPFS(context,'p26-e3'),errors=await recordDOMErrors(context);
  const csp:unknown[]=[],external:string[]=[],consoleErrors:string[]=[],commands:any[]=[],uiRequests:any[]=[];
  const dir=await mkdtemp(join(await realpath(tmpdir()),'p26-e3-')),root=join(dir,'private');
  let server:Awaited<ReturnType<typeof serverProcess>>|undefined,effects:any,closed:any;
  const evidence:Record<string,unknown>={};
  const state:RunState={failures:[],roots:[dir],writerClosed:false,contextClosed:false,browserClosed:false,retention:[],receipt,prefix:'e3-'};
  runs.set(context,state);
  const responseMetadata=postResponseMetadata(page,state,()=>server?.origin);
  state.observe=()=>({errors,csp,external,consoleErrors,commands,uiRequests,responseMetadata:responseMetadata.snapshot(),effects,closed,evidence,process:server?.lifecycle,requestLifecycle:guard.requests,cleanup:guard.ledger});
  state.finalCheck=async()=>{try{
    guard.verify();expect(guard.ledger.filter(entry=>entry.phase==='refused')).toEqual([]);
    expect(errors).toEqual([]);expect(csp).toEqual([]);expect(external).toEqual([]);expect(consoleErrors).toEqual([]);
    expect(closed?.closed).toBe(true);expect(closed?.resources.objects).toEqual({reservedBytes:'0',activeTransfers:0});
    expect(closed?.resources.raster.activeWorkers).toBe(0);
  }finally{responseMetadata.stop();}};
  await context.exposeBinding('requestEditsCSP',(_source,value)=>csp.push(value));
  await context.addInitScript(()=>addEventListener('securitypolicyviolation',event=>(window as any).requestEditsCSP({directive:event.effectiveDirective,blocked:event.blockedURI})));
  page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
  page.on('request',request=>{
    if(request.method()!=='POST')return;const path=new URL(request.url()).pathname;
    if(path==='/api/v1/commands'){const value=JSON.parse(request.postData()!).command;commands.push(value);responseMetadata.admit(request,'command',value);}
    if(path.startsWith('/api/v1/ui/')){const value=JSON.parse(request.postData()!);uiRequests.push(value);responseMetadata.admit(request,'ui',value);}
  });
  async function read(path:string){return page.evaluate(async spec=>{const response=await fetch(spec.path,spec.init);if(!response.ok)throw Error('Public read '+response.status);return response.json();},publicReadRequest(path));}
  async function document(id:string){return (await read('/api/v1/documents/'+id)).projection.value;}
  async function imageState(id:string){return read('/api/v1/documents/'+id+'/image');}
  async function asset(id:string){return (await read('/api/v1/assets/'+id)).projection.value;}
  async function pixels(id:string){const value=await asset(id),bytes=await readFile(objectPath(root,value.raster.pixels));expect(digest(bytes)).toBe(value.raster.pixels.hash);return bytes;}

  try{
    server=await serverProcess(root);
    await context.route('**/*',route=>{
      const url=new URL(route.request().url());
      if(['http:','https:'].includes(url.protocol)&&url.origin!==server!.origin){external.push(url.origin);return route.abort();}
      return route.continue();
    });
    await mkdir(receipt,{recursive:true});await guard.admit(page,server.origin);await page.goto(await server.pair());
    evidence.runtime={version:context.browser()?.version()??null,userAgent:await page.evaluate(()=>navigator.userAgent),pin:JSON.parse(await readFile('node_modules/playwright-core/browsers.json','utf8')).browsers.find((browser:any)=>browser.name===browserName)};
    await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();
    await click(page,'New');await number(page,'Width (px)','512');await number(page,'Height (px)','512');await click(page,'Create');
    await expect(page.getByRole('dialog',{name:'New document',exact:true})).toBeHidden();
    const created=commands.find(command=>command.body.type==='CreateDocument');expect(created).toBeTruthy();const documentId=created.documentId;
    const inputPixels=Buffer.alloc(512*512*4);
    for(let y=0;y<512;y++)for(let x=0;x<512;x++){const at=(y*512+x)*4;inputPixels[at]=64+x%128;inputPixels[at+1]=96+y%128;inputPixels[at+2]=32+(x+y)%64;inputPixels[at+3]=255;}
    const sourceFile=join(dir,'E3 source.png');await writeFile(sourceFile,await sharp(inputPixels,{raw:{width:512,height:512,channels:4}}).png().toBuffer());
    await click(page,'Import image');await expect(page.getByRole('dialog',{name:'Import image',exact:true})).toBeVisible();await page.locator('en-dialog#editor-dialog').locator('en-file-upload input[type=file]').setInputFiles(sourceFile);await confirmImageImports(page,{names:['E3 source.png'],destination:'current'});
    await expect(page.getByText('ImportAsset accepted and saved locally.',{exact:true})).toBeVisible();
    const imported=commands.find(command=>command.body.type==='ImportAsset');expect(imported).toBeTruthy();const sourceLayerId=imported.body.layerId;
    await page.getByRole('treeitem').first().click();await number(page,'Opacity (0–1)','0.5');await click(page,'Apply properties');
    await expect(page.getByText('SetLayerProperties accepted and saved locally.',{exact:true})).toBeVisible();
    await click(page,'Text');await page.locator('#native-text-content').fill('Editable overlay');
    await number(page,'New text X (document px)','24');await number(page,'New text Y (document px)','420');await number(page,'Text size (document px)','28');
    await click(page,'Preview text');await expect(page.getByText('Text preview ready. Accepted appearance is unchanged.',{exact:true})).toBeVisible();await click(page,'Apply text');
    await expect(page.locator('#native-text-editor')).toBeHidden();await expect(page.getByRole('treeitem')).toHaveCount(2);
    const originalDocument=await document(documentId),originalState=await imageState(documentId),originalComposite=await pixels(originalDocument.image.compositeAssetId);
    const originalLayer=originalState.layers.find((layer:any)=>layer.id===sourceLayerId),nativeLayer=originalState.layers.find((layer:any)=>layer.kind==='text');
    expect(originalLayer.opacity).toBe(0.5);expect(nativeLayer).toBeTruthy();
    await page.getByRole('treeitem').filter({hasText:imported.body.name}).click();
    await page.getByRole('combobox',{name:'Operation',exact:true}).selectOption('Edit masked region');
    await page.getByRole('textbox',{name:'Prompt',exact:true}).fill('E3 recolor the reviewed region while retaining editable overlay');
    const captureObserver=await page.evaluateHandle(()=>{
      const document=window.document;
      const limit=32,events:Record<string,unknown>[]=[],snapshots:Record<string,unknown>[]=[],eventRows=new WeakMap<Event,Record<string,unknown>>();let dropped=0,truncated=0;
      const bounded=(value:string,cap:number)=>{if(value.length>cap)truncated++;return value.slice(0,cap);};
      const control=()=>document.querySelector('#request-capture-single')?.shadowRoot?.querySelector<HTMLButtonElement>('button')??null,initialControl=control();
      function snapshot(){const native=control(),host=document.querySelector('#request-capture-single');let active=document.activeElement;while(active?.shadowRoot?.activeElement)active=active.shadowRoot.activeElement;const mark=performance.getEntriesByName('ie.editor.updated').at(-1) as PerformanceMark|undefined,detail=mark?.detail,footer=document.querySelector('footer')?.textContent??'',source=document.querySelector('#request-source-status')?.textContent?.trim();return {at:performance.now(),nativePresent:!!native,sameNative:native===initialControl,connected:native?.isConnected??false,disabled:native?.disabled??null,hostDisabled:host?.hasAttribute('disabled')??null,ariaDisabled:native?.getAttribute('aria-disabled')??null,focused:active===native,activeTag:bounded(active?.tagName??'',32),activeId:bounded(active?.id??'',80),strength:bounded(document.querySelector('#request-strength')?.shadowRoot?.querySelector<HTMLInputElement>('input')?.value??'',32),editBusy:document.querySelector('.request-edits')?.getAttribute('aria-busy')??null,operationBusy:document.querySelector('.operation-status')?.getAttribute('aria-busy')??null,requestErrors:bounded(document.querySelector('#request-errors')?.shadowRoot?.querySelector('[part="base"]')?.textContent??'',512),requestStatus:bounded(document.querySelector('#request-announcements')?.textContent??'',512),source:source==='No source captured.'?'none':source?.includes('source ·')?'captured':'other',footer:footer.includes('Accepted edits saved locally · Draft saved locally; not applied to the document')?'saved':footer.includes('Draft saving')?'saving':footer.includes('Unsaved UI draft')?'unsaved':'other',editor:{ready:typeof detail?.ready==='boolean'?detail.ready:null,busy:typeof detail?.busy==='boolean'?detail.busy:null,documentPresent:typeof detail?.documentId==='string',revision:typeof detail?.revision==='string'?bounded(detail.revision,32):null}};}
      const capture=(event:Event)=>{if(events.length===limit){dropped++;return;}const target=event.composedPath()[0],native=control(),key=event instanceof KeyboardEvent?event:null,row:Record<string,unknown>={type:event.type,eventTime:event.timeStamp,trusted:event.isTrusted,key:key?bounded(key.key,24):null,alt:key?.altKey??null,ctrl:key?.ctrlKey??null,meta:key?.metaKey??null,shift:key?.shiftKey??null,targetIsCapture:target===native,targetTag:target instanceof Element?bounded(target.tagName,32):'',targetId:target instanceof Element?bounded(target.id,80):'',defaultPreventedAtCapture:event.defaultPrevented,defaultPreventedAtDocumentBubble:null,...snapshot()};events.push(row);eventRows.set(event,row);};
      const bubble=(event:Event)=>{const row=eventRows.get(event);if(row)row.defaultPreventedAtDocumentBubble=event.defaultPrevented;};
      for(const type of ['keydown','keyup','click']){document.addEventListener(type,capture,{capture:true,passive:true});document.addEventListener(type,bubble,{passive:true});}
      const mark=(phase:string)=>{if(snapshots.length===limit){dropped++;return;}snapshots.push({phase,...snapshot()});};mark('before-input-settings');
      return {mark,stop(){for(const type of ['keydown','keyup','click']){document.removeEventListener(type,capture,true);document.removeEventListener(type,bubble);}mark('stopped');return {limit,dropped,truncated,events,snapshots};}};
    });
    try{
      await page.getByRole('combobox',{name:'Request size',exact:true}).selectOption('auto');await click(page,'Use operation strength default');await expect(page.locator('#request-strength').getByRole('spinbutton')).toHaveValue('1');
      await captureObserver.evaluate(observer=>observer.mark('before-keyboard'));
      await keyboard(button(page,'request-capture-single'));
      await captureObserver.evaluate(observer=>observer.mark('after-keyboard'));
      await expect.poll(()=>commands.filter(command=>command.body.type==='PrepareRequestSource').length).toBe(1);
    }finally{
      await step(state,'capture-observation',async()=>{evidence.captureAdmission=await captureObserver.evaluate(observer=>observer.stop());});
      await step(state,'capture-observation-dispose',()=>captureObserver.dispose());
    }
    await expect(page.locator('.typed-request')).toContainText('single-layer');
    await page.locator('#request-mask-shape').getByRole('combobox').selectOption('rectangle');
    for(const [id,value]of [['x','192'],['y','192'],['width','127'],['height','128'],['feather','7']])await numeric(page,'request-mask-'+id,value);
    // En Reve steppers commit en-change without en-input. The accepted visible
    // value must be the value the numeric mask command actually uses.
    for(const id of ['width','feather'])await keyboard(page.locator('#request-mask-'+id).getByRole('button',{name:'Increase value',exact:true}));
    await expect(page.locator('#request-mask-width').getByRole('spinbutton')).toHaveValue('128');
    await expect(page.locator('#request-mask-feather').getByRole('spinbutton')).toHaveValue('8');
    await keyboard(button(page,'request-mask-build'));
    await expect(page.locator('.typed-request')).toContainText('partial coverage');
    const authoredMask=commands.filter(command=>command.body.type==='PrepareRequestMask').at(-1);
    expect(authoredMask.body.plan.feather).toBe(8);
    expect(authoredMask.body.plan.operations.at(-1)).toEqual({kind:'shape',mode:'replace',shape:{kind:'rectangle',x:192,y:192,width:128,height:128}});
    await keyboard(button(page,'request-document'));
    await expect(page.locator('.typed-request').getByText('Request document revision confirmed.',{exact:true})).toBeVisible();
    await page.locator('#text-treatment-kind').getByRole('combobox').selectOption('native-overlay');
    await page.locator('#text-treatment-retain-'+nativeLayer.id).getByRole('checkbox').check();
    await page.locator('#text-treatment-placement').getByRole('combobox').selectOption('current-document');
    async function reviewTextSource(){
      await keyboard(button(page,'text-treatment-prepare'));
      const individual=page.locator('#text-treatment-review details');
      await expect(individual).toBeVisible();if(await individual.getAttribute('open')===null)await individual.locator('summary').click();
      await expect(button(page,'text-treatment-confirm')).toBeEnabled();
      expect(await page.locator('#text-treatment-review img').evaluateAll((images:HTMLImageElement[])=>images.length===3&&images.every(image=>image.complete&&image.naturalWidth===512&&image.naturalHeight===512))).toBe(true);
      await keyboard(button(page,'text-treatment-confirm'));
    }
    await reviewTextSource();
    const preparedReviews=uiRequests.filter(request=>request.body?.type==='PrepareRequestReview').length;
    await keyboard(button(page,'prepare-request'));
    await expect(page.locator('#request-errors')).toContainText('MASK');
    expect(uiRequests.filter(request=>request.body?.type==='PrepareRequestReview')).toHaveLength(preparedReviews);
    expect(commands.filter(command=>command.body.type==='QueueInference')).toHaveLength(0);
    effects=await server.effects();expect(effects.effects).toEqual([]);
    await keyboard(button(page,'request-mapping-preview'));
    await keyboard(button(page,'request-mask-confirm'));
    await expect(page.locator('#request-mask-status')).toContainText('Request mask plan confirmed.');
    await keyboard(button(page,'request-document'));
    await reviewTextSource();
    await keyboard(button(page,'prepare-request'));await expect(page.locator('#request-review')).toBeFocused();
    await keyboard(button(page,'accept-request'));await expect(button(page,'enqueue-request')).toBeEnabled();
    expect(await imageState(documentId)).toEqual(originalState);
    await keyboard(button(page,'enqueue-request'));
    let job:any,view:any;
    await expect.poll(async()=>{job=(await read('/api/v1/queue')).jobs[0];return job?.attempts[0]?.state;}).toBe('provider-terminal');
    await expect.poll(async()=>{view=await read('/api/v1/jobs/'+job.id+'/candidates?attempt='+job.attempts[0].id);return view.items[0]?.state;}).toBe('prepared');
    const candidate=view.items[0],source=job.review.request.source,maskPlan=job.review.request.mask.requestPlan;
    expect(source.scope).toBe('single-layer');expect(source.capture).toBeTruthy();expect(maskPlan).toBeTruthy();
    expect(job.stagePlan).toHaveLength(2);expect(job.review.request.mask.frame).toBeUndefined();
    expect(job.review.request.mask.binding.kind).toBe('request-mask-source-1');
    expect((await document(documentId)).image).toEqual(originalDocument.image);
    expect(commands.filter(command=>command.body.type==='SetLayerProperties')).toHaveLength(1);
    const sourcePixels=await pixels(source.assetId),effective=await readFile(objectPath(root,maskPlan.effectiveMask));
    expect(sourcePixels[3]).toBe(128);expect(effective.length).toBe(512*512*2);expect(digest(effective)).toBe(maskPlan.effectiveMask.hash);
    const sourceDigest=digest(sourcePixels),maskDigest=digest(effective);
    await click(page,'Refresh durable queue');
    const jobCard=page.locator('#durable-queue > en-card').filter({hasText:'Job '+job.id+':'});
    await jobCard.getByRole('button',{name:'Inspect retained results',exact:true}).click();
    await keyboard(button(page,'request-candidate-prepare-'+candidate.id));
    await click(page,'Review lettering choices for this output');
    await keyboard(button(page,'candidate-text-load-'+candidate.id));
    await page.locator('#candidate-text-action-'+candidate.id).getByRole('combobox').selectOption('keep-native-overlay');
    await keyboard(button(page,'candidate-text-confirm-'+candidate.id));
    await keyboard(button(page,'request-candidate-place-'+candidate.id));
    await expect(button(page,'request-candidate-adopt-'+candidate.id)).toBeEnabled();
    const placement=commands.filter(command=>command.body.type==='PrepareCandidateAdoption').at(-1);expect(placement).toBeTruthy();
    expect(placement.body.textTreatment.plan).toEqual(job.review.textTreatment);expect(placement.body.textTreatment.choice.action).toBe('keep-native-overlay');
    for(const name of ['Prepared placement with reviewed native text off','Prepared placement with reviewed native text on']){const image=page.getByRole('img',{name,exact:true});await expect(image).toBeVisible();expect(await image.evaluate((value:HTMLImageElement)=>({complete:value.complete,width:value.naturalWidth,height:value.naturalHeight}))).toEqual({complete:true,width:512,height:512});}
    const comparisons=[];
    for(const pair of ['source','document']){
      const prefix='candidate-comparison-'+candidate.id+'-'+pair;
      const mode=page.locator('#'+prefix+'-mode').getByRole('combobox');
      const comparison=page.locator('.candidate-comparison-pair').filter({has:page.locator('#'+prefix+'-mode')});
      await keyboard(comparison.getByRole('button',{name:/^Show B:/}));
      await expect(mode).toHaveValue('b');await expect(page.locator('#'+prefix+'-status')).toContainText('B:');
      const reveal=page.locator('#'+prefix+'-reveal').getByRole('spinbutton');
      await reveal.focus();await reveal.press('ControlOrMeta+A');await reveal.pressSequentially('24');await reveal.press('Tab');
      await keyboard(page.locator('#'+prefix+'-reveal').getByRole('button',{name:'Increase value',exact:true}));
      await expect(reveal).toHaveValue('25');await expect(mode).toHaveValue('reveal');
      await expect(page.locator('#'+prefix+'-status')).toContainText('Reveal 25% B on the left and A on the right');
      const geometry=await comparison.locator('svg').evaluate(svg=>({
        viewBox:svg.getAttribute('viewBox'),
        images:[...svg.querySelectorAll('image')].map(image=>({x:image.getAttribute('x'),y:image.getAttribute('y'),width:image.getAttribute('width'),height:image.getAttribute('height'),clip:image.getAttribute('clip-path')})),
        clips:[...svg.querySelectorAll('clipPath')].map(clip=>{const rect=clip.querySelector('rect')!;return {id:clip.id,x:rect.getAttribute('x'),width:rect.getAttribute('width')};}),
      }));
      expect(geometry.viewBox).toBe('0 0 512 512');expect(geometry.images).toHaveLength(2);
      expect(geometry.images.every(image=>image.x==='0'&&image.y==='0'&&image.width==='512'&&image.height==='512'&&image.clip)).toBe(true);
      expect(geometry.clips.map(({x,width})=>({x,width}))).toEqual([{x:'128',width:'384'},{x:'0',width:'128'}]);
      expect(geometry.images.map(image=>image.clip)).toEqual(geometry.clips.map(clip=>'url(#'+clip.id+')'));
      expect(geometry.images[0].clip).not.toBe(geometry.images[1].clip);
      comparisons.push({pair,geometry,reveal:25});
    }
    expect(await document(documentId)).toEqual(originalDocument);expect(await imageState(documentId)).toEqual(originalState);
    evidence.comparisons=comparisons;
    const beforeAdopt=commands.filter(command=>command.body.type==='AdoptCandidate').length;
    await keyboard(button(page,'request-candidate-adopt-'+candidate.id));
    await expect.poll(async()=>(await document(documentId)).historyHead).not.toBe(originalDocument.historyHead);
    expect(commands.filter(command=>command.body.type==='AdoptCandidate')).toHaveLength(beforeAdopt+1);
    const adoptedDocument=await document(documentId),adoptedState=await imageState(documentId),adoptedLayer=adoptedState.layers.find((layer:any)=>layer.id===placement.body.newLayerId);
    const originalIndex=originalState.layers.findIndex((layer:any)=>layer.id===sourceLayerId);
    const retainedOriginal=adoptedState.layers.find((layer:any)=>layer.id===sourceLayerId);
    expect(retainedOriginal).toMatchObject({...originalLayer,version:String(BigInt(originalLayer.version)+1n),visible:false});
    expect(Math.abs(adoptedState.layers.indexOf(adoptedLayer)-adoptedState.layers.indexOf(retainedOriginal))).toBe(1);
    expect(adoptedState.layers.filter((layer:any)=>layer.visible).map((layer:any)=>layer.id)).toEqual(originalState.layers.filter((layer:any)=>layer.visible).map((layer:any)=>layer.id===sourceLayerId?placement.body.newLayerId:layer.id));
    expect(adoptedState.layers.find((layer:any)=>layer.id===nativeLayer.id)).toEqual(nativeLayer);
    expect(adoptedLayer.opacity).toBe(1);expect(adoptedLayer.mask).toBeNull();expect(adoptedLayer.layerToDocument).toEqual([1,0,0,1,0,0]);
    const adoptedPixels=await pixels(adoptedLayer.assetId),adoptedComposite=await pixels(adoptedDocument.image.compositeAssetId);
    let exterior=0,interior=0,feather=0,firstMismatch:number|null=null;
    for(let index=0;index<512*512;index++){
      const coverage=effective.readUInt16LE(index*2),at=index*4;
      if(coverage===0){exterior++;if(!adoptedPixels.subarray(at,at+4).equals(sourcePixels.subarray(at,at+4))||!adoptedComposite.subarray(at,at+4).equals(originalComposite.subarray(at,at+4)))firstMismatch??=index;}
      else if(coverage===65535){interior++;if(!adoptedPixels.subarray(at,at+4).equals(Buffer.from([36,104,172,255])))firstMismatch??=index;}
      else feather++;
    }
    expect(exterior).toBeGreaterThan(0);expect(interior).toBeGreaterThan(0);expect(feather).toBeGreaterThan(0);expect(firstMismatch).toBeNull();
    const acceptedHistory=adoptedDocument.historyHead;
    await currentDocument(page,documentId,adoptedDocument.revision);
    await keyboard(page.getByRole('button',{name:'Undo',exact:true}));
    let undoneRevision=adoptedDocument.revision;
    await expect.poll(async()=>{const value=await document(documentId);undoneRevision=value.revision;return value.image;}).toEqual(originalDocument.image);
    expect(await imageState(documentId)).toEqual(originalState);
    await currentDocument(page,documentId,undoneRevision);
    await keyboard(page.getByRole('button',{name:'Redo',exact:true}));
    let redoneRevision=undoneRevision;
    await expect.poll(async()=>{const value=await document(documentId);redoneRevision=value.revision;return value.historyHead;}).toBe(acceptedHistory);
    expect(await imageState(documentId)).toEqual(adoptedState);
    await currentDocument(page,documentId,redoneRevision);
    expect(await pixels(source.assetId)).toEqual(sourcePixels);expect(digest(await readFile(objectPath(root,maskPlan.effectiveMask)))).toBe(maskDigest);
    await page.getByRole('treeitem').filter({hasText:'Text'}).click();await click(page,'Edit text');
    await expect(page.locator('#native-text-content')).toHaveValue('Editable overlay');await click(page,'Cancel text edit');
    // The retained candidate still belongs to the original source revision.
    // Replacing that target again cannot reuse its old same-document promise.
    const staleTarget=await document(documentId),adoptionsBeforeRecovery=commands.filter(command=>command.body.type==='AdoptCandidate').length;
    await keyboard(button(page,'request-candidate-prepare-'+candidate.id));
    await click(page,'Review lettering choices for this output');
    await keyboard(button(page,'candidate-text-load-'+candidate.id));
    const lettering=page.locator('#candidate-text-treatment-'+candidate.id);
    await expect(lettering).toContainText('Only a fresh new-document placement can use these retained request versions');
    await expect(page.locator('#candidate-text-action-'+candidate.id+' en-select-option[value="keep-native-overlay"]')).toHaveAttribute('disabled','');
    await expect(button(page,'request-candidate-adopt-'+candidate.id)).toHaveCount(0);
    expect(await document(documentId)).toEqual(staleTarget);
    expect(commands.filter(command=>command.body.type==='AdoptCandidate')).toHaveLength(adoptionsBeforeRecovery);
    await page.locator('#candidate-text-action-'+candidate.id).getByRole('combobox').selectOption('new-document');
    await keyboard(button(page,'candidate-text-confirm-'+candidate.id));
    await keyboard(button(page,'request-candidate-new-document-'+candidate.id));
    await expect(button(page,'request-candidate-adopt-'+candidate.id)).toBeEnabled();
    const newPlacement=commands.filter(command=>command.body.type==='PrepareCandidateAdoption').at(-1);
    expect(newPlacement.body.placement).toBe('new-document');expect(newPlacement.body.mode).toBe('safe-region');expect(newPlacement.body.newDocumentId).toBeTruthy();
    expect(newPlacement.expectedDocumentRevision).toBe(staleTarget.revision);expect(newPlacement.body.textTreatment.plan).toEqual(placement.body.textTreatment.plan);expect(newPlacement.body.textTreatment.choice.nativeCopies).toEqual([]);expect(newPlacement.body.textTreatment.choice.approvalId).not.toBe(placement.body.textTreatment.choice.approvalId);
    await keyboard(button(page,'request-candidate-adopt-'+candidate.id));
    await currentDocument(page,newPlacement.body.newDocumentId);
    await expect.poll(async()=>document(newPlacement.body.newDocumentId).then(value=>value.id,()=>null)).toBe(newPlacement.body.newDocumentId);
    await expect(page.getByRole('treeitem')).toHaveCount(1);
    const recoveredDocument=await document(newPlacement.body.newDocumentId),recoveredState=await imageState(recoveredDocument.id);
    expect(recoveredState.layers).toHaveLength(1);expect(await pixels(recoveredState.layers[0].assetId)).toEqual(adoptedPixels);
    expect(await document(documentId)).toEqual(staleTarget);expect(await imageState(documentId)).toEqual(adoptedState);
    expect(commands.filter(command=>command.body.type==='AdoptCandidate')).toHaveLength(adoptionsBeforeRecovery+1);
    effects=await server.effects();expect(effects.errors).toEqual([]);
    expect(effects.egressAttempts).toEqual([]);expect(effects.submissions).toHaveLength(1);expect(effects.uploads).toHaveLength(2);
    const uploadedMask=effects.uploads.find((upload:any)=>upload.id===effects.submissions[0].maskUploadId);
    expect(uploadedMask).toMatchObject({width:512,height:512,binaryOpaque:true,blackPixels:exterior,whitePixels:interior+feather});
    for(const stage of job.stagePlan){
      const uploaded=effects.uploads.find((upload:any)=>upload.id===effects.submissions[0][stage.role==='source'?'sourceUploadId':'maskUploadId']);
      expect(uploaded.sha256).toBe(stage.transport.hash);expect(String(uploaded.bytes)).toBe(stage.transport.byteLength);
      expect(digest(await readFile(objectPath(root,stage.transport)))).toBe(uploaded.sha256);
    }
    expect(commands.filter(command=>command.body.type==='QueueInference')).toHaveLength(1);
    evidence.pixels={sourceDigest,maskDigest,adoptedDigest:digest(adoptedPixels),originalComposite:digest(originalComposite),adoptedComposite:digest(adoptedComposite),exterior,interior,feather,firstMismatch};
    evidence.history={before:originalDocument.historyHead,adopted:acceptedHistory,sourceLayerId,nativeLayerId:nativeLayer.id,sourceEffectiveSlot:originalIndex};
    evidence.staleRecovery={sourceDocumentId:documentId,sourceRevision:staleTarget.revision,newDocumentId:recoveredDocument.id,sourceUnchanged:true,frozenTextTreatment:newPlacement.body.textTreatment.plan,freshPlacementApproval:newPlacement.body.textTreatment.choice.approvalId};
    evidence.review=job.review;evidence.candidate=candidate;
    if(browserName!=='webkit')await page.screenshot({path:join(receipt,'e3-adopted.png'),caret:'initial'});
  }catch(error){state.failures.push({phase:'body',error});}finally{
    if(!state.failures.length)await step(state,'logical-cleanup',async()=>{for(const current of context.pages())await current.goto('about:blank');await guard.cleanup();guard.verify();});
    if(server)state.writerClosed=await step(state,'writer-close',()=>server!.close());
    if(state.writerClosed)await step(state,'native-close-receipt',async()=>{closed=JSON.parse(await readFile(join(root,'request-edits-fixture.json'),'utf8'));expect(closed.closed).toBe(true);expect(closed.errors).toEqual([]);});
    throwFailures(state.failures);
  }
});


// The provider returns a real 256-grid PNG for this isolated case only. Source
// capture, mask mapping, review commands, Lit bindings and image decoding stay
// on the production path. No image events or readiness state are fabricated.
test(maskReReviewTitle,async({page,context,browserName})=>{
  const guard=await ownedOPFS(context,'p26-mask-rereview'),errors=await recordDOMErrors(context);
  const csp:unknown[]=[],external:string[]=[],consoleErrors:string[]=[],commands:any[]=[];
  const dir=await mkdtemp(join(await realpath(tmpdir()),'p26-mask-rereview-')),root=join(dir,'private');
  let server:Awaited<ReturnType<typeof serverProcess>>|undefined,effects:any,closed:any;
  let maskLoads:JSHandle<{image:HTMLImageElement|null;src:string;loads:number;allTrusted:boolean;stop():void}>|undefined;
  const evidence:Record<string,unknown>={};
  const state:RunState={failures:[],roots:[dir],writerClosed:false,contextClosed:false,browserClosed:false,retention:[],receipt,prefix:'e3-mask-rereview-'};
  runs.set(context,state);
  state.observe=()=>({errors,csp,external,consoleErrors,commands,effects,closed,evidence,process:server?.lifecycle,requestLifecycle:guard.requests,cleanup:guard.ledger});
  state.finalCheck=async()=>{
    guard.verify();expect(guard.ledger.filter(entry=>entry.phase==='refused')).toEqual([]);
    expect(errors).toEqual([]);expect(csp).toEqual([]);expect(external).toEqual([]);expect(consoleErrors).toEqual([]);
    expect(closed?.closed).toBe(true);expect(closed?.resources.objects).toEqual({reservedBytes:'0',activeTransfers:0});expect(closed?.resources.raster.activeWorkers).toBe(0);
  };
  await context.exposeBinding('maskReReviewCSP',(_source,value)=>csp.push(value));
  await context.addInitScript(()=>addEventListener('securitypolicyviolation',event=>(window as any).maskReReviewCSP({directive:event.effectiveDirective,blocked:event.blockedURI})));
  page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
  page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/v1/commands')commands.push(JSON.parse(request.postData()!).command);});
  async function read(path:string){return page.evaluate(async spec=>{const response=await fetch(spec.path,spec.init);if(!response.ok)throw Error('Public read '+response.status);return response.json();},publicReadRequest(path));}
  try{
    server=await serverProcess(root,256);
    await context.route('**/*',route=>{const url=new URL(route.request().url());if(['http:','https:'].includes(url.protocol)&&url.origin!==server!.origin){external.push(url.origin);return route.abort();}return route.continue();});
    await mkdir(receipt,{recursive:true});await guard.admit(page,server.origin);await page.goto(await server.pair());
    evidence.runtime={version:context.browser()?.version()??null,userAgent:await page.evaluate(()=>navigator.userAgent),pin:JSON.parse(await readFile('node_modules/playwright-core/browsers.json','utf8')).browsers.find((browser:any)=>browser.name===browserName)};
    await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();
    await click(page,'New');await number(page,'Width (px)','512');await number(page,'Height (px)','512');await click(page,'Create');await expect(page.getByRole('dialog',{name:'New document',exact:true})).toBeHidden();
    const documentId=commands.find(command=>command.body.type==='CreateDocument')?.documentId;expect(documentId).toBeTruthy();
    const sourceFile=join(dir,'Mask re-review source.png');await writeFile(sourceFile,await sharp({create:{width:512,height:512,channels:4,background:'#708090'}}).png().toBuffer());
    await click(page,'Import image');await expect(page.getByRole('dialog',{name:'Import image',exact:true})).toBeVisible();await page.locator('en-dialog#editor-dialog').locator('en-file-upload input[type=file]').setInputFiles(sourceFile);await confirmImageImports(page,{names:['Mask re-review source.png'],destination:'current'});
    await expect(page.getByText('ImportAsset accepted and saved locally.',{exact:true})).toBeVisible();await page.getByRole('treeitem').first().click();
    const originalDocument=(await read('/api/v1/documents/'+documentId)).projection.value;
    await page.getByRole('combobox',{name:'Operation',exact:true}).selectOption('Edit masked region');await page.getByRole('textbox',{name:'Prompt',exact:true}).fill('Review the same retained mask with actual returned dimensions');await page.getByRole('combobox',{name:'Request size',exact:true}).selectOption('auto');await click(page,'Use operation strength default');await expect(page.locator('#request-strength').getByRole('spinbutton')).toHaveValue('1');
    await keyboard(button(page,'request-capture-single'));await expect.poll(()=>commands.filter(command=>command.body.type==='PrepareRequestSource').length).toBe(1);
    await page.locator('#request-mask-shape').getByRole('combobox').selectOption('rectangle');for(const [id,value]of [['x','192'],['y','192'],['width','128'],['height','128'],['feather','0']])await numeric(page,'request-mask-'+id,value);
    await keyboard(button(page,'request-mask-build'));await expect(page.locator('.typed-request')).toContainText('partial coverage');await keyboard(button(page,'request-mapping-preview'));await keyboard(button(page,'request-mask-confirm'));await expect(page.locator('#request-mask-status')).toContainText('Request mask plan confirmed.');await keyboard(button(page,'request-document'));await expect(page.locator('.typed-request').getByText('Request document revision confirmed.',{exact:true})).toBeVisible();await keyboard(button(page,'prepare-request'));await expect(page.locator('#request-review')).toBeFocused();await keyboard(button(page,'accept-request'));await keyboard(button(page,'enqueue-request'));
    let job:any,view:any;
    await expect.poll(async()=>{job=(await read('/api/v1/queue')).jobs[0];return job?.attempts[0]?.state;}).toBe('provider-terminal');
    await expect.poll(async()=>{view=await read('/api/v1/jobs/'+job.id+'/candidates?attempt='+job.attempts[0].id);return view.items[0]?.state;}).toBe('prepared');
    const candidate=view.items[0],acceptedPlan=structuredClone(job.review.request.mask.requestPlan),returned=(await read('/api/v1/assets/'+candidate.preparedAssetId)).projection.value;
    expect(acceptedPlan.expectedOutput).toEqual({width:512,height:512});expect(returned.raster).toMatchObject({width:256,height:256});
    await click(page,'Refresh durable queue');const jobCard=page.locator('#durable-queue > en-card').filter({hasText:'Job '+job.id+':'});await jobCard.getByRole('button',{name:'Inspect retained results',exact:true}).click();await keyboard(button(page,'request-candidate-prepare-'+candidate.id));await expect(button(page,'request-candidate-place-'+candidate.id)).toBeDisabled();await keyboard(button(page,'request-candidate-actual-'+candidate.id));
    const candidateCard=page.locator('.request-candidate-review[data-candidate-id="'+candidate.id+'"]');
    maskLoads=await candidateCard.evaluateHandle(card=>{
      const witness={image:null as HTMLImageElement|null,src:'',loads:0,allTrusted:true,stop(){card.removeEventListener('load',onLoad,true);}};
      const onLoad=(event:Event)=>{const image=event.target;if(!(image instanceof HTMLImageElement)||image.alt!=='Original retained coverage')return;witness.loads++;witness.allTrusted=witness.allTrusted&&event.isTrusted;if(!witness.image){witness.image=image;witness.src=image.currentSrc;}};
      card.addEventListener('load',onLoad,true);return witness;
    });
    await keyboard(button(page,'request-candidate-place-'+candidate.id));
    const placement=page.locator('#request-candidate-placement-'+candidate.id),mask=placement.locator('img[alt="Original retained coverage"]');
    await expect(placement).toContainText('Actual-output mapping 256 × 256');await expect(button(page,'request-candidate-adopt-'+candidate.id)).toBeEnabled();
    const first=await maskLoads.evaluate(witness=>({src:witness.src,loads:witness.loads,allTrusted:witness.allTrusted,connected:witness.image?.isConnected}));expect(first.loads).toBeGreaterThan(0);expect(first.allTrusted).toBe(true);expect(first.connected).toBe(true);
    expect(await mask.evaluate(async image=>{if(!(image instanceof HTMLImageElement))throw Error('Expected a native mask image');await image.decode();return {src:image.currentSrc,width:image.naturalWidth,height:image.naturalHeight};})).toEqual({src:first.src,width:512,height:512});
    expect(await mask.evaluate((image,witness)=>image===witness.image,maskLoads)).toBe(true);
    const resultImages=()=>placement.locator('img').evaluateAll((images:HTMLImageElement[])=>images.filter(image=>image.alt!=='Original retained coverage').map(image=>({alt:image.alt,src:image.currentSrc,complete:image.complete,width:image.naturalWidth,height:image.naturalHeight})));
    const firstResults=await resultImages();expect(firstResults.map(image=>image.alt)).toEqual(['Current document before adoption','Prepared full-grid replacement','Document after proposed placement']);expect(firstResults.every(image=>image.complete&&image.width===512&&image.height===512)).toBe(true);
    // Reuse the same inspected candidate and mask branch. Only real browser
    // events are observed; no load is dispatched and no src is rewritten here.
    const visibility:unknown[]=[];evidence.placementVisibility=visibility;
    const snapshotVisibility=(phase:string)=>step(state,'placement-visibility-'+phase,async()=>{visibility.push(await page.evaluate(({id,phase})=>{
      const placements=window.document.querySelectorAll('#'+CSS.escape(id)),placement=placements[0],headings=placement?.querySelectorAll('h4');let stringsTruncated=0,chainsTruncated=0;
      const bounded=(value:string|null)=>{if(value!==null&&value.length>160)stringsTruncated++;return value?.slice(0,160)??null;};
      const identity=(element:Element|null)=>element?{tag:element.tagName,id:bounded(element.id),slot:bounded(element.getAttribute('slot'))}:null;
      const box=(rect:DOMRect)=>({x:rect.x,y:rect.y,width:rect.width,height:rect.height});
      const chain=(start:Element)=>{const rows:unknown[]=[],seen=new Set<Element>();let element:Element|null=start;
        while(element&&rows.length<24&&!seen.has(element)){seen.add(element);const style=getComputedStyle(element),root=element.getRootNode(),slot:HTMLSlotElement|null=element.assignedSlot,rects=element.getClientRects();
          rows.push({identity:identity(element),connected:element.isConnected,hidden:element.hasAttribute('hidden'),inert:element.hasAttribute('inert'),ariaHidden:bounded(element.getAttribute('aria-hidden')),assignedSlot:identity(slot),shadowHost:root instanceof ShadowRoot?identity(root.host):null,checkVisibility:typeof element.checkVisibility==='function'?element.checkVisibility():null,rect:box(element.getBoundingClientRect()),clientRectCount:rects.length,clientRects:Array.from({length:Math.min(rects.length,4)},(_,index)=>box(rects[index])),style:{display:style.display,visibility:style.visibility,opacity:style.opacity,contentVisibility:style.contentVisibility,overflowX:style.overflowX,overflowY:style.overflowY,position:style.position,contain:style.contain,width:style.width,height:style.height,minWidth:style.minWidth,minHeight:style.minHeight,fontSize:style.fontSize,lineHeight:style.lineHeight}});
          element=slot??element.parentElement??(root instanceof ShadowRoot?root.host:null);
        }
        const cycle=element!==null&&seen.has(element);if(element&&!cycle)chainsTruncated++;return {rows,truncated:element!==null&&!cycle,cycle};
      };
      const headingRows=Array.from({length:Math.min(headings?.length??0,4)},(_,index)=>{const heading=headings![index];return {text:bounded(heading.textContent),exactName:heading.textContent?.trim()==='New-document adoption review',ancestors:chain(heading)};});
      return {phase,atMs:performance.now(),viewport:{width:innerWidth,height:innerHeight,scrollX,scrollY},placementCount:placements.length,placement:placement?chain(placement):null,headingCount:headings?.length??0,headings:headingRows,headingsTruncated:(headings?.length??0)>4,stringsTruncated,chainsTruncated};
    },{id:'request-candidate-placement-'+candidate.id,phase}));});
    await keyboard(button(page,'request-candidate-new-document-'+candidate.id));
    await snapshotVisibility('before');
    try{await expect(placement.getByRole('heading',{name:'New-document adoption review',exact:true})).toBeVisible();}finally{await snapshotVisibility('after');}
    await expect.poll(async()=>{const images=await resultImages();return images.length===3&&images.every((image,index)=>image.src!==firstResults[index].src&&image.complete&&image.width===512&&image.height===512);}).toBe(true);
    await expect(button(page,'request-candidate-adopt-'+candidate.id)).toBeEnabled();
    await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
    expect(await mask.evaluate((image,witness)=>image===witness.image,maskLoads)).toBe(true);await expect(mask).toHaveAttribute('src',first.src);
    const second=await maskLoads.evaluate(witness=>({src:witness.image?.currentSrc,loads:witness.loads,allTrusted:witness.allTrusted,connected:witness.image?.isConnected,complete:witness.image?.complete,width:witness.image?.naturalWidth,height:witness.image?.naturalHeight}));expect(second).toEqual({src:first.src,loads:first.loads,allTrusted:true,connected:true,complete:true,width:512,height:512});
    const secondResults=await resultImages(),retainedMask=maskLoads,originalViewport=page.viewportSize();if(!originalViewport)throw Error('The placement layout fixture requires its configured viewport.');
    const heading=placement.getByRole('heading',{name:'New-document adoption review',exact:true}),adopt=button(page,'request-candidate-adopt-'+candidate.id);
    const retainedPlacement=async()=>{expect(await resultImages()).toEqual(secondResults);expect(await mask.evaluate((image,witness)=>image===witness.image,retainedMask)).toBe(true);await expect(mask).toHaveAttribute('src',first.src);expect(await retainedMask.evaluate(witness=>({src:witness.image?.currentSrc,loads:witness.loads,allTrusted:witness.allTrusted,connected:witness.image?.isConnected,complete:witness.image?.complete,width:witness.image?.naturalWidth,height:witness.image?.naturalHeight}))).toEqual(second);};
    const layoutEvidence:unknown[]=[];evidence.placementLayouts=layoutEvidence;
    try{
      for(const width of [1440,390,320]){
        await page.setViewportSize({width,height:originalViewport.height});
        if(width<1440){const requestLink=page.getByRole('link',{name:'Go to Request',exact:true});await requestLink.focus();await expect(requestLink).toBeFocused();await requestLink.press('Enter');await expect(page.locator('#request')).toBeFocused();}
        await expect(page.locator('#request')).toBeVisible();await expect(heading).toBeVisible();await heading.scrollIntoViewIfNeeded();await expect(adopt).toBeVisible();await expect(adopt).toBeEnabled();await adopt.scrollIntoViewIfNeeded();await adopt.focus();await expect(adopt).toBeFocused();
        const geometry=await placement.evaluate(element=>{const measure=(node:Element)=>{const box=node.getBoundingClientRect();return {left:box.left,right:box.right,width:box.width,clientWidth:node.clientWidth,scrollWidth:node.scrollWidth};};return {viewport:innerWidth,panel:measure(element.closest('#request')!),request:measure(element.closest('.typed-request')!),queue:measure(element.closest('#durable-queue')!),review:measure(element),heading:measure(element.querySelector('h4')!),images:[...element.querySelectorAll('img')].map(measure)};}),control=await adopt.evaluate(element=>{const box=element.getBoundingClientRect();return {left:box.left,right:box.right,width:box.width};});
        const layout={width,geometry,control,overflow:null as unknown};layoutEvidence.push(layout);
        await step(state,'placement-overflow-'+width,async()=>{layout.overflow=await page.evaluate(id=>{
          const placement:Element|null=window.document.getElementById(id);if(!placement)return {missing:true};
          const limit=256,depthLimit=24,nodes:unknown[]=[];let omittedSubtreeRoots=0,depthLimited=0,stringsTruncated=0;
          const bounded=(value:string|null):string|null=>{if(value!==null&&value.length>160)stringsTruncated++;return value?.slice(0,160)??null;};
          const identity=(element:Element|null)=>element?{tag:element.tagName,id:bounded(element.id),class:bounded(element.getAttribute('class')),part:bounded(element.getAttribute('part')),slot:bounded(element.getAttribute('slot'))}:null;
          const fields=['display','visibility','position','box-sizing','overflow-x','overflow-y','width','height','min-width','max-width','padding-inline-start','padding-inline-end','border-inline-start-width','border-inline-end-width','margin-inline-start','margin-inline-end','grid-template-columns','gap','flex-wrap','flex-shrink','outline-width','outline-offset','outline-style','box-shadow','transform','scroll-margin-inline-start','scroll-margin-inline-end'];
          const pseudoFields=['content','display','position','width','height','left','right','top','bottom','inset-inline-start','inset-inline-end','transform','outline-width','outline-offset','box-shadow'];
          const styles=(element:Element,pseudo?:string)=>{const style:CSSStyleDeclaration=getComputedStyle(element,pseudo);return Object.fromEntries((pseudo?pseudoFields:fields).map(key=>[key,bounded(style.getPropertyValue(key))]));};
          const bounds=placement.getBoundingClientRect();
          const measure=(element:Element)=>{const box:DOMRect=element.getBoundingClientRect(),slot:HTMLSlotElement|null=element.assignedSlot;return {identity:identity(element),assignedSlot:identity(slot),connected:element.isConnected,focused:element.matches(':focus'),focusVisible:element.matches(':focus-visible'),rect:{left:box.left,right:box.right,top:box.top,bottom:box.bottom,width:box.width,height:box.height},clientWidth:element.clientWidth,scrollWidth:element.scrollWidth,scrollLeft:element.scrollLeft,extendsReview:box.width>0&&(box.left<bounds.left-1||box.right>bounds.right+1),style:styles(element),before:styles(element,'::before'),after:styles(element,'::after')};};
          const visit=(element:Element,parent:number|null,depth:number,shadow:boolean):void=>{if(nodes.length>=limit){omittedSubtreeRoots++;return;}if(depth>=depthLimit){depthLimited++;return;}const index=nodes.length;nodes.push({index,parent,depth,shadow,...measure(element)});const root:ShadowRoot|null=element.shadowRoot;
            for(const children of [element.children,root?.children]){if(!children)continue;for(let childIndex=0;childIndex<children.length;childIndex++){if(nodes.length>=limit){omittedSubtreeRoots+=children.length-childIndex;break;}visit(children[childIndex],index,depth+1,children===root?.children);}}
          };
          visit(placement,null,0,false);let focused:Element|null=window.document.activeElement;for(let depth=0;depth<depthLimit&&focused?.shadowRoot?.activeElement;depth++)focused=focused.shadowRoot.activeElement;
          const containers=Object.fromEntries([['panel',placement.closest('#request')],['request',placement.closest('.typed-request')],['queue',placement.closest('#durable-queue')],['review',placement]].map(([name,element])=>[name,element instanceof Element?measure(element):null]));
          const focusedRoot:Node|undefined=focused?.getRootNode();
          return {atMs:performance.now(),containers,focused:focused?measure(focused):null,focusedHost:focusedRoot instanceof ShadowRoot?measure(focusedRoot.host):null,focusTruncated:!!focused?.shadowRoot?.activeElement,nodeLimit:limit,depthLimit,nodes,omittedSubtreeRoots,depthLimited,stringsTruncated};
        },'request-candidate-placement-'+candidate.id);});
        expect(geometry.images).toHaveLength(secondResults.length+1);expect(geometry.panel.left).toBeGreaterThanOrEqual(-1);expect(geometry.panel.right).toBeLessThanOrEqual(geometry.viewport+1);
        for(const [name,container] of [['panel',geometry.panel],['request',geometry.request],['queue',geometry.queue],['review',geometry.review]] as const){expect(container.width,name+' width').toBeGreaterThan(0);expect(container.scrollWidth,name+' horizontal overflow').toBeLessThanOrEqual(container.clientWidth+1);}
        for(const box of [geometry.request,geometry.queue,geometry.review,geometry.heading,control,...geometry.images]){expect(box.width).toBeGreaterThan(0);expect(box.left).toBeGreaterThanOrEqual(Math.max(0,geometry.panel.left)-1);expect(box.right).toBeLessThanOrEqual(Math.min(geometry.viewport,geometry.panel.right)+1);}
        for(const box of [geometry.heading,control,...geometry.images]){expect(box.left).toBeGreaterThanOrEqual(geometry.review.left-1);expect(box.right).toBeLessThanOrEqual(geometry.review.right+1);}
        await retainedPlacement();
      }
    }finally{await step(state,'placement-viewport-restore',()=>page.setViewportSize(originalViewport));}
    await expect(heading).toBeVisible();await expect(adopt).toBeEnabled();await retainedPlacement();
    expect(commands.filter(command=>command.body.type==='PrepareCandidateAdoption').map(command=>({placement:command.body.placement,actualOutput:command.body.actualOutput}))).toEqual([{placement:'current-document',actualOutput:{width:256,height:256,clipMask:false}},{placement:'new-document',actualOutput:{width:256,height:256,clipMask:false}}]);expect(commands.filter(command=>command.body.type==='AdoptCandidate')).toEqual([]);expect(commands.filter(command=>command.body.type==='QueueInference')).toHaveLength(1);
    expect((await read('/api/v1/documents/'+documentId)).projection.value).toEqual(originalDocument);expect((await read('/api/v1/jobs/'+job.id+'/candidates?attempt='+job.attempts[0].id)).request.raster.plan).toEqual(acceptedPlan);
    effects=await server.effects();expect(effects.errors).toEqual([]);expect(effects.egressAttempts).toEqual([]);expect(effects.submissions).toHaveLength(1);expect(effects.uploads).toHaveLength(2);expect(effects.result).toMatchObject({width:256,height:256});
    evidence.mask={first,second,sameElement:true,repeatedNativeLoads:second.loads-first.loads};evidence.results={first:firstResults,second:await resultImages()};evidence.review={candidateId:candidate.id,expected:acceptedPlan.expectedOutput,actual:{width:returned.raster.width,height:returned.raster.height},adoptionEnabled:true,adoptionSubmitted:false,documentUnchanged:true,acceptedPlanUnchanged:true};
  }catch(error){state.failures.push({phase:'body',error});}finally{
    if(maskLoads)await step(state,'mask-load-observer-release',async()=>{const held=maskLoads!;try{await held.evaluate(witness=>witness.stop());}finally{await held.dispose();maskLoads=undefined;}});
    if(!state.failures.length)await step(state,'logical-cleanup',async()=>{for(const current of context.pages())await current.goto('about:blank');await guard.cleanup();guard.verify();});
    if(server)state.writerClosed=await step(state,'writer-close',()=>server!.close());
    if(state.writerClosed)await step(state,'native-close-receipt',async()=>{closed=JSON.parse(await readFile(join(root,'request-edits-fixture.json'),'utf8'));expect(closed.closed).toBe(true);expect(closed.errors).toEqual([]);});
    throwFailures(state.failures);
  }
});

// Separate from lettering review: this exercises real deferred preparation on
// acceptance. Inspecting source previews is not PERF's cold encoded-only C reset.
test(deferredAdoptionTitle,async({page,context,browserName})=>{
  const guard=await ownedOPFS(context,'p26-deferred'),errors=await recordDOMErrors(context);
  const csp:unknown[]=[],external:string[]=[],consoleErrors:string[]=[],commands:any[]=[];
  const dir=await mkdtemp(join(await realpath(tmpdir()),'p26-deferred-')),root=join(dir,'private');
  let server:Awaited<ReturnType<typeof serverProcess>>|undefined,effects:any,closed:any;
  const evidence:Record<string,unknown>={};
  const state:RunState={failures:[],roots:[dir],writerClosed:false,contextClosed:false,browserClosed:false,retention:[],receipt,prefix:'e3-deferred-'};
  runs.set(context,state);
  state.observe=()=>({errors,csp,external,consoleErrors,commands,effects,closed,evidence,process:server?.lifecycle,requestLifecycle:guard.requests,cleanup:guard.ledger});
  state.finalCheck=async()=>{
    guard.verify();expect(guard.ledger.filter(entry=>entry.phase==='refused')).toEqual([]);
    expect(errors).toEqual([]);expect(csp).toEqual([]);expect(external).toEqual([]);expect(consoleErrors).toEqual([]);
    expect(closed?.closed).toBe(true);expect(closed?.resources.objects).toEqual({reservedBytes:'0',activeTransfers:0});expect(closed?.resources.raster.activeWorkers).toBe(0);
  };
  await context.exposeBinding('deferredAdoptionCSP',(_source,value)=>csp.push(value));
  await context.addInitScript(()=>addEventListener('securitypolicyviolation',event=>(window as any).deferredAdoptionCSP({directive:event.effectiveDirective,blocked:event.blockedURI})));
  page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
  page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/v1/commands')commands.push(JSON.parse(request.postData()!).command);});
  async function read(path:string){return page.evaluate(async spec=>{const response=await fetch(spec.path,spec.init);if(!response.ok)throw Error('Public read '+response.status);return response.json();},publicReadRequest(path));}
  async function document(id:string){return (await read('/api/v1/documents/'+id)).projection.value;}
  async function imageState(id:string){return read('/api/v1/documents/'+id+'/image');}
  async function pixels(id:string){const asset=(await read('/api/v1/assets/'+id)).projection.value,bytes=await readFile(objectPath(root,asset.raster.pixels));expect(digest(bytes)).toBe(asset.raster.pixels.hash);return bytes;}
  try{
    server=await serverProcess(root);
    await context.route('**/*',route=>{const url=new URL(route.request().url());if(['http:','https:'].includes(url.protocol)&&url.origin!==server!.origin){external.push(url.origin);return route.abort();}return route.continue();});
    await mkdir(receipt,{recursive:true});await guard.admit(page,server.origin);await page.goto(await server.pair());
    evidence.runtime={version:context.browser()?.version()??null,userAgent:await page.evaluate(()=>navigator.userAgent),pin:JSON.parse(await readFile('node_modules/playwright-core/browsers.json','utf8')).browsers.find((browser:any)=>browser.name===browserName)};
    await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();
    await click(page,'New');await number(page,'Width (px)','512');await number(page,'Height (px)','512');await click(page,'Create');await expect(page.getByRole('dialog',{name:'New document',exact:true})).toBeHidden();
    const documentId=commands.find(command=>command.body.type==='CreateDocument')?.documentId;expect(documentId).toBeTruthy();
    const sourceFile=join(dir,'Deferred source.png');await writeFile(sourceFile,await sharp({create:{width:512,height:512,channels:4,background:{r:112,g:128,b:144,alpha:0.5}}}).png().toBuffer());
    await click(page,'Import image');await expect(page.getByRole('dialog',{name:'Import image',exact:true})).toBeVisible();await page.locator('en-dialog#editor-dialog').locator('en-file-upload input[type=file]').setInputFiles(sourceFile);await confirmImageImports(page,{names:['Deferred source.png'],destination:'current'});
    await expect(page.getByText('ImportAsset accepted and saved locally.',{exact:true})).toBeVisible();await page.getByRole('treeitem').first().click();
    const originalDocument=await document(documentId),originalState=await imageState(documentId);
    await page.getByRole('combobox',{name:'Operation',exact:true}).selectOption('Edit masked region');await page.getByRole('textbox',{name:'Prompt',exact:true}).fill('Prepare the reviewed masked result only when I accept its new document');await page.getByRole('combobox',{name:'Request size',exact:true}).selectOption('auto');await click(page,'Use operation strength default');await expect(page.locator('#request-strength').getByRole('spinbutton')).toHaveValue('1');
    await keyboard(button(page,'request-capture-single'));await expect.poll(()=>commands.filter(command=>command.body.type==='PrepareRequestSource').length).toBe(1);
    await page.locator('#request-mask-shape').getByRole('combobox').selectOption('rectangle');for(const [id,value]of [['x','192'],['y','192'],['width','128'],['height','128'],['feather','8']])await numeric(page,'request-mask-'+id,value);
    await keyboard(button(page,'request-mask-build'));await expect(page.locator('.typed-request')).toContainText('partial coverage');await keyboard(button(page,'request-mapping-preview'));await keyboard(button(page,'request-mask-confirm'));await expect(page.locator('#request-mask-status')).toContainText('Request mask plan confirmed.');await keyboard(button(page,'request-document'));await expect(page.locator('.typed-request').getByText('Request document revision confirmed.',{exact:true})).toBeVisible();await keyboard(button(page,'prepare-request'));await expect(page.locator('#request-review')).toBeFocused();await keyboard(button(page,'accept-request'));await keyboard(button(page,'enqueue-request'));
    let job:any,view:any;
    await expect.poll(async()=>{job=(await read('/api/v1/queue')).jobs[0];return job?.attempts[0]?.state;}).toBe('provider-terminal');
    await expect.poll(async()=>{view=await read('/api/v1/jobs/'+job.id+'/candidates?attempt='+job.attempts[0].id);return view.items[0]?.state;}).toBe('prepared');
    const candidate=view.items[0],source=job.review.request.source,maskPlan=job.review.request.mask.requestPlan;
    expect(job.review.textTreatment).toBeUndefined();expect(source.scope).toBe('single-layer');
    const sourcePixels=await pixels(source.assetId),effective=await readFile(objectPath(root,maskPlan.effectiveMask));expect(sourcePixels[3]).toBe(128);expect(digest(effective)).toBe(maskPlan.effectiveMask.hash);
    await click(page,'Refresh durable queue');const jobCard=page.locator('#durable-queue > en-card').filter({hasText:'Job '+job.id+':'});await jobCard.getByRole('button',{name:'Inspect retained results',exact:true}).click();await keyboard(button(page,'request-candidate-prepare-'+candidate.id));
    expect(commands.filter(command=>command.body.type==='PrepareCandidateAdoption')).toEqual([]);
    await keyboard(button(page,'request-candidate-review-new-'+candidate.id));await expect(button(page,'request-candidate-accept-prepare-'+candidate.id)).toBeEnabled();
    const placement=commands.filter(command=>command.body.type==='ReviewCandidatePlacement').at(-1);expect(placement.body.placement).toBe('new-document');expect(placement.body.mode).toBe('safe-region');
    await expect(page.locator('#request-candidate-deferred-review-'+candidate.id)).toContainText('The final result will be prepared after acceptance.');
    expect(commands.filter(command=>command.body.type==='PrepareCandidateAdoption'||command.body.type==='AdoptReviewedCandidate')).toEqual([]);expect(await document(documentId)).toEqual(originalDocument);expect(await imageState(documentId)).toEqual(originalState);
    await keyboard(button(page,'request-candidate-accept-prepare-'+candidate.id));
    await currentDocument(page,placement.body.newDocumentId);
    await expect.poll(async()=>document(placement.body.newDocumentId).then(value=>value.id,()=>null)).toBe(placement.body.newDocumentId);await expect(page.getByRole('treeitem')).toHaveCount(1);
    const adoptedDocument=await document(placement.body.newDocumentId),adoptedState=await imageState(adoptedDocument.id),result=await pixels(adoptedState.layers[0].assetId);
    expect(adoptedState.layers).toHaveLength(1);expect(adoptedState.layers[0].opacity).toBe(1);expect(adoptedState.layers[0].mask).toBeNull();expect(adoptedState.layers[0].layerToDocument).toEqual([1,0,0,1,0,0]);
    let exterior=0,interior=0,feather=0,firstMismatch:number|null=null;
    for(let index=0;index<512*512;index++){const coverage=effective.readUInt16LE(index*2),at=index*4;if(coverage===0){exterior++;if(!result.subarray(at,at+4).equals(sourcePixels.subarray(at,at+4)))firstMismatch??=index;}else if(coverage===65535){interior++;if(!result.subarray(at,at+4).equals(Buffer.from([36,104,172,255])))firstMismatch??=index;}else feather++;}
    expect(exterior).toBeGreaterThan(0);expect(interior).toBeGreaterThan(0);expect(feather).toBeGreaterThan(0);expect(firstMismatch).toBeNull();expect(await document(documentId)).toEqual(originalDocument);expect(await imageState(documentId)).toEqual(originalState);expect(await pixels(source.assetId)).toEqual(sourcePixels);expect(digest(await readFile(objectPath(root,maskPlan.effectiveMask)))).toBe(maskPlan.effectiveMask.hash);
    expect(commands.filter(command=>command.body.type==='AdoptReviewedCandidate')).toHaveLength(1);expect(commands.filter(command=>command.body.type==='PrepareCandidateAdoption'||command.body.type==='AdoptCandidate')).toEqual([]);expect(commands.filter(command=>command.body.type==='QueueInference')).toHaveLength(1);
    effects=await server.effects();expect(effects.errors).toEqual([]);expect(effects.egressAttempts).toEqual([]);expect(effects.submissions).toHaveLength(1);expect(effects.uploads).toHaveLength(2);
    evidence.deferredPreparation={reviewCommandId:placement.commandId,documentId:adoptedDocument.id,fullPreviewRequestedBeforeAcceptance:false,exterior,interior,feather,firstMismatch,sourceDigest:digest(sourcePixels),maskDigest:digest(effective),resultDigest:digest(result),representation:'authoritative-canonical-inputs',timedCQualification:false};
  }catch(error){state.failures.push({phase:'body',error});}finally{
    if(!state.failures.length)await step(state,'logical-cleanup',async()=>{for(const current of context.pages())await current.goto('about:blank');await guard.cleanup();guard.verify();});
    if(server)state.writerClosed=await step(state,'writer-close',()=>server!.close());
    if(state.writerClosed)await step(state,'native-close-receipt',async()=>{closed=JSON.parse(await readFile(join(root,'request-edits-fixture.json'),'utf8'));expect(closed.closed).toBe(true);expect(closed.errors).toEqual([]);});
    throwFailures(state.failures);
  }
});


// Native deferred inspection uses real bounded lettering rasters, then closes
// those consumers through its public confirmation before the actual Accept.
// This functional case makes no all-cache encoded-only performance claim.
test(nativeDeferredAdoptionTitle,async({page,context,browserName})=>{
  const guard=await ownedOPFS(context,'p26-native-deferred'),errors=await recordDOMErrors(context);
  const csp:unknown[]=[],external:string[]=[],consoleErrors:string[]=[],commands:any[]=[],uiRequests:any[]=[];
  const dir=await mkdtemp(join(await realpath(tmpdir()),'p26-native-deferred-')),root=join(dir,'private');
  let server:Awaited<ReturnType<typeof serverProcess>>|undefined,effects:any,closed:any;
  const evidence:Record<string,unknown>={};
  const state:RunState={failures:[],roots:[dir],writerClosed:false,contextClosed:false,browserClosed:false,retention:[],receipt,prefix:'e3-native-deferred-'};
  runs.set(context,state);
  const responseMetadata=postResponseMetadata(page,state,()=>server?.origin,2048);
  state.observe=()=>({errors,csp,external,consoleErrors,commands,uiRequests,responseMetadata:responseMetadata.snapshot(),effects,closed,evidence,process:server?.lifecycle,requestLifecycle:guard.requests,cleanup:guard.ledger});
  state.finalCheck=async()=>{try{
    guard.verify();expect(guard.ledger.filter(entry=>entry.phase==='refused')).toEqual([]);
    expect(errors).toEqual([]);expect(csp).toEqual([]);expect(external).toEqual([]);expect(consoleErrors).toEqual([]);
    expect(closed?.closed).toBe(true);expect(closed?.resources.objects).toEqual({reservedBytes:'0',activeTransfers:0});
    expect(closed?.resources.raster.activeWorkers).toBe(0);
  }finally{responseMetadata.stop();}};
  await context.exposeBinding('nativeDeferredCSP',(_source,value)=>csp.push(value));
  await context.addInitScript(()=>addEventListener('securitypolicyviolation',event=>(window as any).nativeDeferredCSP({directive:event.effectiveDirective,blocked:event.blockedURI})));
  page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
  page.on('request',request=>{
    if(request.method()!=='POST')return;const path=new URL(request.url()).pathname;
    if(path==='/api/v1/commands'){const value=JSON.parse(request.postData()!).command;commands.push(value);responseMetadata.admit(request,'command',value);}
    if(path.startsWith('/api/v1/ui/')){const value=JSON.parse(request.postData()!);uiRequests.push(value);responseMetadata.admit(request,'ui',value);}
  });
  async function read(path:string){return page.evaluate(async spec=>{const response=await fetch(spec.path,spec.init);if(!response.ok)throw Error('Public read '+response.status);return response.json();},publicReadRequest(path));}
  async function document(id:string){return (await read('/api/v1/documents/'+id)).projection.value;}
  async function imageState(id:string){return read('/api/v1/documents/'+id+'/image');}
  async function asset(id:string){return (await read('/api/v1/assets/'+id)).projection.value;}
  async function pixels(id:string){const value=await asset(id),bytes=await readFile(objectPath(root,value.raster.pixels));expect(digest(bytes)).toBe(value.raster.pixels.hash);return bytes;}

  try{
    server=await serverProcess(root);
    await context.route('**/*',route=>{
      const url=new URL(route.request().url());
      if(['http:','https:'].includes(url.protocol)&&url.origin!==server!.origin){external.push(url.origin);return route.abort();}
      return route.continue();
    });
    await mkdir(receipt,{recursive:true});await guard.admit(page,server.origin);await page.goto(await server.pair());
    evidence.runtime={version:context.browser()?.version()??null,userAgent:await page.evaluate(()=>navigator.userAgent),pin:JSON.parse(await readFile('node_modules/playwright-core/browsers.json','utf8')).browsers.find((browser:any)=>browser.name===browserName)};
    await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();
    await click(page,'New');await number(page,'Width (px)','512');await number(page,'Height (px)','512');await click(page,'Create');
    await expect(page.getByRole('dialog',{name:'New document',exact:true})).toBeHidden();
    const created=commands.find(command=>command.body.type==='CreateDocument');expect(created).toBeTruthy();const documentId=created.documentId;
    const inputPixels=Buffer.alloc(512*512*4);
    for(let y=0;y<512;y++)for(let x=0;x<512;x++){const at=(y*512+x)*4;inputPixels[at]=64+x%128;inputPixels[at+1]=96+y%128;inputPixels[at+2]=32+(x+y)%64;inputPixels[at+3]=255;}
    const sourceFile=join(dir,'E3 source.png');await writeFile(sourceFile,await sharp(inputPixels,{raw:{width:512,height:512,channels:4}}).png().toBuffer());
    await click(page,'Import image');await expect(page.getByRole('dialog',{name:'Import image',exact:true})).toBeVisible();await page.locator('en-dialog#editor-dialog').locator('en-file-upload input[type=file]').setInputFiles(sourceFile);await confirmImageImports(page,{names:['E3 source.png'],destination:'current'});
    await expect(page.getByText('ImportAsset accepted and saved locally.',{exact:true})).toBeVisible();
    const imported=commands.find(command=>command.body.type==='ImportAsset');expect(imported).toBeTruthy();const sourceLayerId=imported.body.layerId;
    await page.getByRole('treeitem').first().click();await number(page,'Opacity (0–1)','0.5');await click(page,'Apply properties');
    await expect(page.getByText('SetLayerProperties accepted and saved locally.',{exact:true})).toBeVisible();
    await click(page,'Text');await page.locator('#native-text-content').fill('Editable overlay');
    await number(page,'New text X (document px)','24');await number(page,'New text Y (document px)','420');await number(page,'Text size (document px)','28');
    await click(page,'Preview text');await expect(page.getByText('Text preview ready. Accepted appearance is unchanged.',{exact:true})).toBeVisible();await click(page,'Apply text');
    await expect(page.locator('#native-text-editor')).toBeHidden();await expect(page.getByRole('treeitem')).toHaveCount(2);
    const originalDocument=await document(documentId),originalState=await imageState(documentId),originalComposite=await pixels(originalDocument.image.compositeAssetId);
    const originalLayer=originalState.layers.find((layer:any)=>layer.id===sourceLayerId),nativeLayer=originalState.layers.find((layer:any)=>layer.kind==='text');
    expect(originalLayer.opacity).toBe(0.5);expect(nativeLayer).toBeTruthy();
    await page.getByRole('treeitem').filter({hasText:imported.body.name}).click();
    await page.getByRole('combobox',{name:'Operation',exact:true}).selectOption('Edit masked region');
    await page.getByRole('textbox',{name:'Prompt',exact:true}).fill('E3 recolor the reviewed region while retaining editable overlay');
    await page.getByRole('combobox',{name:'Request size',exact:true}).selectOption('auto');await click(page,'Use operation strength default');await expect(page.locator('#request-strength').getByRole('spinbutton')).toHaveValue('1');
    await keyboard(button(page,'request-capture-single'));
    await expect.poll(()=>commands.filter(command=>command.body.type==='PrepareRequestSource').length).toBe(1);
    await expect(page.locator('.typed-request')).toContainText('single-layer');
    await page.locator('#request-mask-shape').getByRole('combobox').selectOption('rectangle');
    for(const [id,value]of [['x','192'],['y','192'],['width','127'],['height','128'],['feather','7']])await numeric(page,'request-mask-'+id,value);
    // En Reve steppers commit en-change without en-input. The accepted visible
    // value must be the value the numeric mask command actually uses.
    for(const id of ['width','feather'])await keyboard(page.locator('#request-mask-'+id).getByRole('button',{name:'Increase value',exact:true}));
    await expect(page.locator('#request-mask-width').getByRole('spinbutton')).toHaveValue('128');
    await expect(page.locator('#request-mask-feather').getByRole('spinbutton')).toHaveValue('8');
    await keyboard(button(page,'request-mask-build'));
    await expect(page.locator('.typed-request')).toContainText('partial coverage');
    const authoredMask=commands.filter(command=>command.body.type==='PrepareRequestMask').at(-1);
    expect(authoredMask.body.plan.feather).toBe(8);
    expect(authoredMask.body.plan.operations.at(-1)).toEqual({kind:'shape',mode:'replace',shape:{kind:'rectangle',x:192,y:192,width:128,height:128}});
    await keyboard(button(page,'request-document'));
    await expect(page.locator('.typed-request').getByText('Request document revision confirmed.',{exact:true})).toBeVisible();
    await page.locator('#text-treatment-kind').getByRole('combobox').selectOption('native-overlay');
    await page.locator('#text-treatment-retain-'+nativeLayer.id).getByRole('checkbox').check();
    await page.locator('#text-treatment-placement').getByRole('combobox').selectOption('current-document');
    async function reviewTextSource(){
      await keyboard(button(page,'text-treatment-prepare'));
      await expect(page.locator('#text-treatment-review').getByRole('heading',{name:'Review text inputs',exact:true})).toBeVisible();
      const individual=page.locator('#text-treatment-review details');
      await expect(individual).toBeVisible();if(await individual.getAttribute('open')===null)await individual.locator('summary').click();
      await expect(button(page,'text-treatment-confirm')).toBeEnabled();
      expect(await page.locator('#text-treatment-review img').evaluateAll((images:HTMLImageElement[])=>images.length===3&&images.every(image=>image.complete&&image.naturalWidth===512&&image.naturalHeight===512))).toBe(true);
      await keyboard(button(page,'text-treatment-confirm'));
      await expect(page.locator('#text-treatment-review').getByRole('heading',{name:'Confirmed text treatment',exact:true})).toBeVisible();
    }
    await reviewTextSource();
    const preparedReviews=uiRequests.filter(request=>request.body?.type==='PrepareRequestReview').length;
    await keyboard(button(page,'prepare-request'));
    await expect(page.locator('#request-errors')).toContainText('MASK');
    expect(uiRequests.filter(request=>request.body?.type==='PrepareRequestReview')).toHaveLength(preparedReviews);
    expect(commands.filter(command=>command.body.type==='QueueInference')).toHaveLength(0);
    effects=await server.effects();expect(effects.effects).toEqual([]);
    await keyboard(button(page,'request-mapping-preview'));
    await keyboard(button(page,'request-mask-confirm'));
    await expect(page.locator('#request-mask-status')).toContainText('Request mask plan confirmed.');
    await keyboard(button(page,'request-document'));
    await reviewTextSource();
    await keyboard(button(page,'prepare-request'));await expect(page.locator('#request-review')).toBeFocused();
    await keyboard(button(page,'accept-request'));await expect(button(page,'enqueue-request')).toBeEnabled();
    expect(await imageState(documentId)).toEqual(originalState);
    await keyboard(button(page,'enqueue-request'));
    let job:any,view:any;
    await expect.poll(async()=>{job=(await read('/api/v1/queue')).jobs[0];return job?.attempts[0]?.state;}).toBe('provider-terminal');
    await expect.poll(async()=>{view=await read('/api/v1/jobs/'+job.id+'/candidates?attempt='+job.attempts[0].id);return view.items[0]?.state;}).toBe('prepared');
    const candidate=view.items[0],source=job.review.request.source,maskPlan=job.review.request.mask.requestPlan;
    expect(source.scope).toBe('single-layer');expect(source.capture).toBeTruthy();expect(maskPlan).toBeTruthy();
    expect(job.stagePlan).toHaveLength(2);expect(job.review.request.mask.frame).toBeUndefined();
    expect(job.review.request.mask.binding.kind).toBe('request-mask-source-1');
    expect((await document(documentId)).image).toEqual(originalDocument.image);
    expect(commands.filter(command=>command.body.type==='SetLayerProperties')).toHaveLength(1);
    const sourcePixels=await pixels(source.assetId),effective=await readFile(objectPath(root,maskPlan.effectiveMask));
    expect(sourcePixels[3]).toBe(128);expect(effective.length).toBe(512*512*2);expect(digest(effective)).toBe(maskPlan.effectiveMask.hash);
    const sourceDigest=digest(sourcePixels),maskDigest=digest(effective);
    await click(page,'Refresh durable queue');
    const jobCard=page.locator('#durable-queue > en-card').filter({hasText:'Job '+job.id+':'});
    await jobCard.getByRole('button',{name:'Inspect retained results',exact:true}).click();
    await keyboard(button(page,'request-candidate-prepare-'+candidate.id));
    await click(page,'Review lettering choices for this output');
    await keyboard(button(page,'candidate-text-load-'+candidate.id));
    await page.locator('#candidate-text-action-'+candidate.id).getByRole('combobox').selectOption('keep-native-overlay');
    await expect(page.locator('#candidate-text-treatment-'+candidate.id).getByText('No lettering adoption choices are confirmed.',{exact:true})).toBeVisible();
    await keyboard(button(page,'candidate-text-confirm-'+candidate.id));
    await expect(page.locator('#candidate-text-treatment-'+candidate.id).getByText('Lettering choices confirmed. Review the actual placement or its lettering comparisons before adopting.',{exact:true})).toBeVisible();
    const revealChronology:unknown[]=[];evidence.revealChronology=revealChronology;
    const candidateCard=page.locator('.request-candidate-review[data-candidate-id="'+candidate.id+'"]');
    async function confirmActualLettering(){
      const deferred=page.locator('#request-candidate-deferred-review-'+candidate.id);
      await expect(button(page,'request-candidate-confirm-lettering-'+candidate.id)).toBeEnabled();
      await expect(button(page,'request-candidate-accept-prepare-'+candidate.id)).toBeDisabled();
      const images=deferred.locator('img[alt^="Retained "]');await expect(images).toHaveCount(3);
      const displayed=await images.evaluateAll((values:HTMLImageElement[])=>values.map(image=>({alt:image.alt,src:image.currentSrc,complete:image.complete,width:image.naturalWidth,height:image.naturalHeight})));
      expect(displayed.every(image=>image.complete&&image.width===512&&image.height===512)).toBe(true);
      const reviewId=await deferred.getAttribute('data-review-id'),reviewHash=await deferred.getAttribute('data-review-hash');expect(reviewId).toBeTruthy();expect(reviewHash).toBeTruthy();
      const reviewed=await read('/api/v1/image-edit-reviews/'+reviewId);
      expect(reviewed.lettering.kind).toBe('candidate-lettering-comparison-1');expect(reviewed.lettering.intentHash).toBe(reviewed.lettering.intent.hash);expect(reviewed.lettering.grid).toEqual({width:512,height:512});
      expect(reviewed.lettering.plan).toEqual(job.review.textTreatment);expect(reviewed.lettering.choice).toEqual(commands.filter(command=>command.body.type==='ReviewCandidatePlacement').at(-1).body.textTreatment.choice);
      const retained=[];
      for(const id of [reviewed.lettering.candidateAloneAssetId,reviewed.lettering.nativeOffAssetId,reviewed.lettering.nativeOnAssetId]){const value=await asset(id),encoded=await readFile(objectPath(root,value.blob));expect(digest(encoded)).toBe(value.blob.hash);const decoded=await sharp(encoded).ensureAlpha().raw().toBuffer({resolveWithObject:true});expect(decoded.info).toMatchObject({width:512,height:512,channels:4});retained.push(digest(decoded.data));}
      expect(retained[1]).not.toBe(retained[2]);
      const comparisons=[];
      for(const pair of ['lettering-alone-off','lettering-off-on']){
        const prefix='candidate-comparison-'+candidate.id+'-'+pair,comparison=deferred.locator('.candidate-comparison-pair').filter({has:page.locator('#'+prefix+'-mode')});
        await keyboard(comparison.getByRole('button',{name:/^Show B:/}));await expect(page.locator('#'+prefix+'-mode').getByRole('combobox')).toHaveValue('b');
        await observeRevealChronology(page,state,prefix,revealChronology,async()=>{
          const reveal=page.locator('#'+prefix+'-reveal').getByRole('spinbutton');await reveal.fill('25');await reveal.press('Tab');await expect(page.locator('#'+prefix+'-status')).toContainText('Reveal 25% B on the left and A on the right');
        });
        const geometry=await comparison.locator('svg').evaluate(svg=>({viewBox:svg.getAttribute('viewBox'),clips:[...svg.querySelectorAll('clipPath rect')].map(rect=>({x:rect.getAttribute('x'),width:rect.getAttribute('width')})),images:[...svg.querySelectorAll('image')].map(image=>({href:image.getAttribute('href'),clip:image.getAttribute('clip-path')}))}));
        expect(geometry.viewBox).toBe('0 0 512 512');expect(geometry.clips).toEqual([{x:'128',width:'384'},{x:'0',width:'128'}]);expect(geometry.images).toHaveLength(2);expect(geometry.images.every(image=>displayed.some(actual=>actual.src===image.href)&&!!image.clip)).toBe(true);comparisons.push({pair,geometry});
      }
      await expect(deferred).toContainText('They do not show the final preserved placement');
      const before=commands.filter(command=>command.body.type==='AdoptReviewedCandidate').length;
      await keyboard(button(page,'request-candidate-confirm-lettering-'+candidate.id));await expect(button(page,'request-candidate-accept-prepare-'+candidate.id)).toBeEnabled();
      await expect(candidateCard.locator('img')).toHaveCount(0);await expect(candidateCard.locator('.candidate-comparison')).toHaveCount(0);await expect(deferred).toHaveAttribute('data-review-id',reviewId!);await expect(deferred).toHaveAttribute('data-review-hash',reviewHash!);
      expect(commands.filter(command=>command.body.type==='AdoptReviewedCandidate')).toHaveLength(before);expect(commands.filter(command=>command.body.type==='PrepareCandidateAdoption'||command.body.type==='AdoptCandidate')).toEqual([]);
      return {reviewId,reviewHash,displayed,retained,comparisons,lettering:reviewed.lettering,displayConsumersClosedBeforeAccept:true,timedCQualification:false};
    }
    const deferredCard=page.locator('#request-candidate-deferred-review-'+candidate.id),priorCurrentReviewId=await deferredCard.evaluateAll(nodes=>nodes[0]?.getAttribute('data-review-id')??null);
    await keyboard(button(page,'request-candidate-review-current-'+candidate.id));
    await expect(deferredCard).toHaveAttribute('data-review-id',/\S+/);if(priorCurrentReviewId!==null)await expect(deferredCard).not.toHaveAttribute('data-review-id',priorCurrentReviewId);
    await expect(deferredCard.getByRole('heading',{name:'Current-document placement review',exact:true})).toBeVisible();await expect(button(page,'request-candidate-confirm-lettering-'+candidate.id)).toBeEnabled();
    const placement=commands.filter(command=>command.body.type==='ReviewCandidatePlacement').at(-1);expect(placement.body.placement).toBe('current-document');expect(placement.body.preparation).toBeUndefined();
    expect(placement.body.textTreatment.plan).toEqual(job.review.textTreatment);expect(placement.body.textTreatment.choice.action).toBe('keep-native-overlay');
    const currentComparison=await confirmActualLettering();
    expect(await document(documentId)).toEqual(originalDocument);expect(await imageState(documentId)).toEqual(originalState);
    evidence.currentComparison=currentComparison;
    const beforeAdopt=commands.filter(command=>command.body.type==='AdoptReviewedCandidate').length;
    await keyboard(button(page,'request-candidate-accept-prepare-'+candidate.id));
    await expect.poll(async()=>(await document(documentId)).historyHead).not.toBe(originalDocument.historyHead);
    expect(commands.filter(command=>command.body.type==='AdoptReviewedCandidate')).toHaveLength(beforeAdopt+1);
    const adoptedDocument=await document(documentId),adoptedState=await imageState(documentId),adoptedLayer=adoptedState.layers.find((layer:any)=>layer.id===placement.body.newLayerId);
    const originalIndex=originalState.layers.findIndex((layer:any)=>layer.id===sourceLayerId);
    const retainedOriginal=adoptedState.layers.find((layer:any)=>layer.id===sourceLayerId);
    expect(retainedOriginal).toMatchObject({...originalLayer,version:String(BigInt(originalLayer.version)+1n),visible:false});
    expect(Math.abs(adoptedState.layers.indexOf(adoptedLayer)-adoptedState.layers.indexOf(retainedOriginal))).toBe(1);
    expect(adoptedState.layers.filter((layer:any)=>layer.visible).map((layer:any)=>layer.id)).toEqual(originalState.layers.filter((layer:any)=>layer.visible).map((layer:any)=>layer.id===sourceLayerId?placement.body.newLayerId:layer.id));
    expect(adoptedState.layers.find((layer:any)=>layer.id===nativeLayer.id)).toEqual(nativeLayer);
    expect(adoptedLayer.opacity).toBe(1);expect(adoptedLayer.mask).toBeNull();expect(adoptedLayer.layerToDocument).toEqual([1,0,0,1,0,0]);
    const adoptedPixels=await pixels(adoptedLayer.assetId),adoptedComposite=await pixels(adoptedDocument.image.compositeAssetId);
    let exterior=0,interior=0,feather=0,firstMismatch:number|null=null;
    for(let index=0;index<512*512;index++){
      const coverage=effective.readUInt16LE(index*2),at=index*4;
      if(coverage===0){exterior++;if(!adoptedPixels.subarray(at,at+4).equals(sourcePixels.subarray(at,at+4))||!adoptedComposite.subarray(at,at+4).equals(originalComposite.subarray(at,at+4)))firstMismatch??=index;}
      else if(coverage===65535){interior++;if(!adoptedPixels.subarray(at,at+4).equals(Buffer.from([36,104,172,255])))firstMismatch??=index;}
      else feather++;
    }
    expect(exterior).toBeGreaterThan(0);expect(interior).toBeGreaterThan(0);expect(feather).toBeGreaterThan(0);expect(firstMismatch).toBeNull();
    const acceptedHistory=adoptedDocument.historyHead;
    await currentDocument(page,documentId,adoptedDocument.revision);
    await keyboard(page.getByRole('button',{name:'Undo',exact:true}));
    let undoneRevision=adoptedDocument.revision;
    await expect.poll(async()=>{const value=await document(documentId);undoneRevision=value.revision;return value.image;}).toEqual(originalDocument.image);
    expect(await imageState(documentId)).toEqual(originalState);
    await currentDocument(page,documentId,undoneRevision);
    await keyboard(page.getByRole('button',{name:'Redo',exact:true}));
    let redoneRevision=undoneRevision;
    await expect.poll(async()=>{const value=await document(documentId);redoneRevision=value.revision;return value.historyHead;}).toBe(acceptedHistory);
    expect(await imageState(documentId)).toEqual(adoptedState);
    await currentDocument(page,documentId,redoneRevision);
    expect(await pixels(source.assetId)).toEqual(sourcePixels);expect(digest(await readFile(objectPath(root,maskPlan.effectiveMask)))).toBe(maskDigest);
    await page.getByRole('treeitem').filter({hasText:'Text'}).click();await click(page,'Edit text');
    await expect(page.locator('#native-text-content')).toHaveValue('Editable overlay');await click(page,'Cancel text edit');
    // The retained candidate still belongs to the original source revision.
    // Replacing that target again cannot reuse its old same-document promise.
    const staleTarget=await document(documentId),adoptionsBeforeRecovery=commands.filter(command=>command.body.type==='AdoptReviewedCandidate').length;
    await keyboard(button(page,'request-candidate-prepare-'+candidate.id));
    await click(page,'Review lettering choices for this output');
    await keyboard(button(page,'candidate-text-load-'+candidate.id));
    const lettering=page.locator('#candidate-text-treatment-'+candidate.id);
    await expect(lettering).toContainText('Only a fresh new-document placement can use these retained request versions');
    await expect(page.locator('#candidate-text-action-'+candidate.id+' en-select-option[value="keep-native-overlay"]')).toHaveAttribute('disabled','');
    await expect(button(page,'request-candidate-accept-prepare-'+candidate.id)).toHaveCount(0);
    expect(await document(documentId)).toEqual(staleTarget);
    expect(commands.filter(command=>command.body.type==='AdoptReviewedCandidate')).toHaveLength(adoptionsBeforeRecovery);
    await page.locator('#candidate-text-action-'+candidate.id).getByRole('combobox').selectOption('new-document');
    await page.locator('#candidate-text-copy-'+nativeLayer.id).getByRole('checkbox').check();
    await expect(lettering.getByText('No lettering adoption choices are confirmed.',{exact:true})).toBeVisible();
    await keyboard(button(page,'candidate-text-confirm-'+candidate.id));
    await expect(lettering.getByText('Lettering choices confirmed. Review the actual placement or its lettering comparisons before adopting.',{exact:true})).toBeVisible();
    const priorEncodedReviewId=await deferredCard.evaluateAll(nodes=>nodes[0]?.getAttribute('data-review-id')??null);
    await keyboard(button(page,'request-candidate-review-encoded-new-'+candidate.id));
    await expect(deferredCard).toHaveAttribute('data-review-id',/\S+/);if(priorEncodedReviewId!==null)await expect(deferredCard).not.toHaveAttribute('data-review-id',priorEncodedReviewId);
    await expect(deferredCard).toHaveAttribute('data-preparation','encoded-rebuild');await expect(deferredCard.getByRole('heading',{name:'New-document placement review',exact:true})).toBeVisible();await expect(button(page,'request-candidate-confirm-lettering-'+candidate.id)).toBeEnabled();
    const newPlacement=commands.filter(command=>command.body.type==='ReviewCandidatePlacement').at(-1);
    expect(newPlacement.body.placement).toBe('new-document');expect(newPlacement.body.mode).toBe('safe-region');expect(newPlacement.body.preparation).toBe('encoded-rebuild');expect(newPlacement.body.newDocumentId).toBeTruthy();
    expect(newPlacement.expectedDocumentRevision).toBe(staleTarget.revision);expect(newPlacement.body.textTreatment.plan).toEqual(placement.body.textTreatment.plan);expect(newPlacement.body.textTreatment.choice.approvalId).not.toBe(placement.body.textTreatment.choice.approvalId);
    const copy=newPlacement.body.textTreatment.choice.nativeCopies[0];expect(newPlacement.body.textTreatment.choice.nativeCopies).toHaveLength(1);expect(copy.sourceLayerId).toBe(nativeLayer.id);expect(copy.newLayerId).not.toBe(nativeLayer.id);expect(copy.newLayerId).not.toBe(newPlacement.body.newLayerId);expect(copy.transform).toEqual(nativeLayer.layerToDocument);
    const newComparison=await confirmActualLettering();
    await keyboard(button(page,'request-candidate-accept-prepare-'+candidate.id));
    await currentDocument(page,newPlacement.body.newDocumentId);
    await expect.poll(async()=>document(newPlacement.body.newDocumentId).then(value=>value.id,()=>null)).toBe(newPlacement.body.newDocumentId);await expect(page.getByRole('treeitem')).toHaveCount(2);
    const recoveredDocument=await document(newPlacement.body.newDocumentId),recoveredState=await imageState(recoveredDocument.id),recoveredLayer=recoveredState.layers.find((layer:any)=>layer.id===newPlacement.body.newLayerId),copiedNative=recoveredState.layers.find((layer:any)=>layer.id===copy.newLayerId);
    expect(recoveredState.layers).toHaveLength(2);expect(await pixels(recoveredLayer.assetId)).toEqual(adoptedPixels);expect(copiedNative).toEqual({...nativeLayer,id:copy.newLayerId,version:'1',layerToDocument:copy.transform});
    expect(await document(documentId)).toEqual(staleTarget);expect(await imageState(documentId)).toEqual(adoptedState);
    expect(commands.filter(command=>command.body.type==='AdoptReviewedCandidate')).toHaveLength(adoptionsBeforeRecovery+1);expect(commands.filter(command=>command.body.type==='PrepareCandidateAdoption'||command.body.type==='AdoptCandidate')).toEqual([]);
    await page.getByRole('treeitem').filter({hasText:'Text'}).click();await click(page,'Edit text');await expect(page.locator('#native-text-content')).toHaveValue('Editable overlay');await click(page,'Cancel text edit');
    evidence.newComparison=newComparison;evidence.nativeCopy={source:nativeLayer,copied:copiedNative,choice:copy,exactRetainedTextAndFontResources:true};
    effects=await server.effects();expect(effects.errors).toEqual([]);
    expect(effects.egressAttempts).toEqual([]);expect(effects.submissions).toHaveLength(1);expect(effects.uploads).toHaveLength(2);
    const uploadedMask=effects.uploads.find((upload:any)=>upload.id===effects.submissions[0].maskUploadId);
    expect(uploadedMask).toMatchObject({width:512,height:512,binaryOpaque:true,blackPixels:exterior,whitePixels:interior+feather});
    for(const stage of job.stagePlan){
      const uploaded=effects.uploads.find((upload:any)=>upload.id===effects.submissions[0][stage.role==='source'?'sourceUploadId':'maskUploadId']);
      expect(uploaded.sha256).toBe(stage.transport.hash);expect(String(uploaded.bytes)).toBe(stage.transport.byteLength);
      expect(digest(await readFile(objectPath(root,stage.transport)))).toBe(uploaded.sha256);
    }
    expect(commands.filter(command=>command.body.type==='QueueInference')).toHaveLength(1);
    evidence.pixels={sourceDigest,maskDigest,adoptedDigest:digest(adoptedPixels),originalComposite:digest(originalComposite),adoptedComposite:digest(adoptedComposite),exterior,interior,feather,firstMismatch};
    evidence.history={before:originalDocument.historyHead,adopted:acceptedHistory,sourceLayerId,nativeLayerId:nativeLayer.id,sourceEffectiveSlot:originalIndex};
    evidence.staleRecovery={sourceDocumentId:documentId,sourceRevision:staleTarget.revision,newDocumentId:recoveredDocument.id,sourceUnchanged:true,frozenTextTreatment:newPlacement.body.textTreatment.plan,freshPlacementApproval:newPlacement.body.textTreatment.choice.approvalId};
    evidence.review=job.review;evidence.candidate=candidate;
    if(browserName!=='webkit')await page.screenshot({path:join(receipt,'e3-native-deferred-adopted.png'),caret:'initial'});
  }catch(error){state.failures.push({phase:'body',error});}finally{
    if(!state.failures.length)await step(state,'logical-cleanup',async()=>{for(const current of context.pages())await current.goto('about:blank');await guard.cleanup();guard.verify();});
    if(server)state.writerClosed=await step(state,'writer-close',()=>server!.close());
    if(state.writerClosed)await step(state,'native-close-receipt',async()=>{closed=JSON.parse(await readFile(join(root,'request-edits-fixture.json'),'utf8'));expect(closed.closed).toBe(true);expect(closed.errors).toEqual([]);});
    throwFailures(state.failures);
  }
});
