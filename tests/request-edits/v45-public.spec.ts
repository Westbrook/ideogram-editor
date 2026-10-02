import {test as base,expect,type Page,type Locator,type Browser,type BrowserContext} from '@playwright/test';
import {mkdtemp,realpath,mkdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {serverProcess} from '../editor/process.js';
import {confirmImageImports} from '../editor/image-import-flow.js';
import {ownedOPFS} from '../editor/owned-opfs.js';
import {recordDOMErrors} from '../editor/error-monitor.js';
import {runs,step,throwFailures,finishFixture,errorRecord,type RunState} from '../editor/harness-lifecycle.js';
import {publicReadRequest} from '../request/persistence-witness.js';

const receipt=resolve(process.env.EDITOR_RECEIPT??'artifacts/v45-edit-browser');
const test=base.extend({context:async({playwright,browserName,contextOptions,viewport},use,info)=>{
 const prefix=info.title.includes('unmasked')?'unmasked-':'masked-';let profile:string|undefined,browser:Browser|undefined,context:BrowserContext|undefined,setupError:unknown;
 try{
  profile=browserName==='webkit'?await mkdtemp(join(await realpath(tmpdir()),'v45-edit-webkit-')):undefined;
  if(!profile)browser=await playwright[browserName].launch();
  context=profile?await playwright.webkit.launchPersistentContext(profile,{...contextOptions,viewport}):await browser!.newContext({...contextOptions,viewport});
  await Promise.all(context.pages().map(page=>page.close()));await use(context);
 }catch(error){setupError=error;if(context&&!runs.has(context))runs.set(context,{failures:[{phase:'context-acquisition',error}],roots:[],writerClosed:true,contextClosed:false,browserClosed:false,retention:[],receipt,prefix});throw error;}finally{
  if(context)await finishFixture(context,browser,profile,receipt,prefix,info);
  else{
   const state:RunState={failures:setupError?[{phase:'context-acquisition',error:setupError}]:[],roots:profile?[profile]:[],writerClosed:true,contextClosed:false,browserClosed:false,retention:profile?[{root:profile,retained:true,reason:'Persistent context never returned; closure is unverified.'}]:[],receipt,prefix};
   if(browser)state.browserClosed=await step(state,'browser-close-after-acquisition-failure',()=>browser!.close());
   await step(state,'acquisition-receipt',async()=>{await mkdir(receipt,{recursive:true});await writeFile(join(receipt,prefix+'startup.json'),JSON.stringify({contextReturned:false,browserClosed:state.browserClosed,retention:state.retention,failures:state.failures.map(failure=>({phase:failure.phase,error:errorRecord(failure.error)}))},null,2));});
   throwFailures(state.failures);
  }
 }
}});
const click=(page:Page,name:string)=>page.getByRole('button',{name,exact:true}).click();
async function keyboard(control:Locator){await expect(control).toBeEnabled();await control.focus();await expect(control).toBeFocused();await control.press('Enter');}
async function number(page:Page,name:string,value:string){const control=page.getByRole('spinbutton',{name,exact:true});await control.fill(value);await control.press('Tab');await expect(control).toHaveValue(value);}
const hash=(bytes:Uint8Array)=>'sha256:'+createHash('sha256').update(bytes).digest('hex');

// The provider remains off. All edits, captures, mask previews, preparation,
// review and queue changes are driven by the built application's public UI.
// Public reads and hash-checked retained files are observation-only witnesses.
for(const masked of [false,true])test('V45 '+(masked?'masked transport preserves R16 coverage':'unmasked references retain exact order')+' through public review and local queue',async({page,context,browserName})=>{
 const prefix=masked?'masked-':'unmasked-',operation=masked?'inpaint-v45':'transform-v45';
 const guard=await ownedOPFS(context,'v45-edit-'+operation),errors=await recordDOMErrors(context);
 const csp:unknown[]=[],external:string[]=[],consoleErrors:string[]=[],commands:any[]=[],uiRequests:any[]=[],replies:any[]=[],pending:Promise<void>[]=[];
 const dir=await mkdtemp(join(await realpath(tmpdir()),'v45-edit-')),root=join(dir,'private');
 const state:RunState={failures:[],roots:[dir],writerClosed:false,contextClosed:false,browserClosed:false,retention:[],receipt,prefix};runs.set(context,state);
 const evidence:Record<string,unknown>={};let server:Awaited<ReturnType<typeof serverProcess>>|undefined,effects:any;
 state.observe=()=>({evidence,commands,uiRequests,replies,effects,errors,csp,external,consoleErrors,process:server?.lifecycle,requestLifecycle:guard.requests,cleanup:guard.ledger});
 state.finalCheck=async()=>{await Promise.all(pending);expect(state.failures.filter(failure=>failure.phase==='response-observation')).toEqual([]);guard.verify();expect(guard.ledger.filter(entry=>entry.phase==='refused')).toEqual([]);expect(errors).toEqual([]);expect(csp).toEqual([]);expect(external).toEqual([]);expect(consoleErrors).toEqual([]);};
 await context.exposeBinding('v45EditCSP',(_source,value)=>csp.push(value));
 await context.addInitScript(()=>addEventListener('securitypolicyviolation',event=>(window as any).v45EditCSP({directive:event.effectiveDirective,blocked:event.blockedURI})));
 page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
 page.on('request',request=>{if(request.method()!=='POST')return;const path=new URL(request.url()).pathname;if(path==='/api/v1/commands')commands.push(JSON.parse(request.postData()!).command);if(path.startsWith('/api/v1/ui/'))uiRequests.push(JSON.parse(request.postData()!));});
 page.on('response',response=>{const path=new URL(response.url()).pathname;if(response.request().method()==='POST'&&(path==='/api/v1/commands'||path.startsWith('/api/v1/ui/')))pending.push(response.json().then(value=>{replies.push({path,request:JSON.parse(response.request().postData()!),value});}).catch(error=>{state.failures.push({phase:'response-observation',error});}));});
 async function read(path:string){return page.evaluate(async spec=>{const response=await fetch(spec.path,spec.init);if(!response.ok)throw Error('Public read '+response.status+' '+spec.path);return response.json();},publicReadRequest(path));}
 async function objectBytes(ref:{hash:string;byteLength:string}){const bytes=await readFile(join(root,'objects','sha256',ref.hash.slice(7,9),ref.hash.slice(7)));expect(String(bytes.length)).toBe(ref.byteLength);expect(hash(bytes)).toBe(ref.hash);return bytes;}
 async function savedDraft(predicate:(value:any)=>boolean){
  let found:any;
  await expect.poll(async()=>{
   await Promise.all(pending);if(!await page.getByRole('contentinfo').getByText('Accepted edits saved locally · Draft saved locally; not applied to the document',{exact:true}).isVisible())return false;const request=uiRequests.find(value=>value.body.type==='SaveDraft');if(!request)return false;
   const checkpoint=await read('/api/v1/ui/'+request.sessionId);
   for(const draft of checkpoint.drafts.filter((value:any)=>value.kind==='request')){
    const value=(await read('/api/v1/ui/'+request.sessionId+'/request?draftId='+encodeURIComponent(draft.id)+'&generation='+draft.generation)).value;
    if(value.operation===operation&&value.prompt.mode==='plain'&&predicate(value)){found=value;return true;}
   }return false;
  }).toBe(true);return found;
 }
 async function review(){
  const before=uiRequests.filter(value=>value.body.type==='PrepareRequestReview').length;
  await keyboard(page.getByRole('button',{name:'Review exact request',exact:true}));
  await expect(page.getByRole('heading',{name:'Immutable request review',exact:true})).toBeVisible();await expect(page.locator('#request-review')).toBeFocused();
  await expect.poll(async()=>{await Promise.all(pending);return uiRequests.filter(value=>value.body.type==='PrepareRequestReview').length;}).toBe(before+1);
  const request=uiRequests.filter(value=>value.body.type==='PrepareRequestReview').at(-1);
  await expect.poll(async()=>{await Promise.all(pending);return replies.find(value=>value.value.requestId===request.requestId)?.value.status;}).toBe('accepted');
  const value=replies.find(value=>value.value.requestId===request.requestId).value.review;
  expect(value.kind).toBe('request-review-v45-1');expect(value.endpoint).toBe('ideogram/v4.5/edit');expect(value.dispatch).toBe(false);expect(value.request.kind).toBe(operation);
  return value;
 }
 async function prepareInputs(){
  await keyboard(page.getByRole('button',{name:'Prepare source, mask and ordered references',exact:true}));
  await expect(page.getByRole('heading',{name:'Review prepared input descriptors',exact:true})).toBeVisible();
  const descriptor=JSON.parse(await page.locator('pre[aria-label="Exact prepared input descriptors"]').innerText());
  await keyboard(page.getByRole('button',{name:'Confirm these exact prepared inputs',exact:true}));
  await expect(page.getByRole('heading',{name:'Confirmed prepared input descriptors',exact:true})).toBeVisible();
  const saved=await savedDraft(value=>value.preparedInputs?.assetId===descriptor.assetId&&value.preparedInputs?.version===descriptor.version&&value.preparedInputs?.manifest.hash===descriptor.manifest.hash);
  expect(saved.preparedInputs).toEqual(descriptor);return saved;
 }
 async function captureReference(label:string,count:number){await keyboard(page.getByRole('button',{name:label,exact:true}));await expect(page.locator('#request-v45-inputs')).toContainText(count+' of '+(masked?3:4)+' attached.');}
 try{
  server=await serverProcess(root);
  await context.route('**/*',route=>{const url=new URL(route.request().url());if(['http:','https:'].includes(url.protocol)&&url.origin!==server!.origin){external.push(url.origin);return route.abort();}return route.continue();});
  await mkdir(receipt,{recursive:true});await guard.admit(page,server.origin);await page.goto(await server.pair());
  evidence.runtime={version:context.browser()?.version()??null,userAgent:await page.evaluate(()=>navigator.userAgent),pin:JSON.parse(await readFile('node_modules/playwright-core/browsers.json','utf8')).browsers.find((browser:any)=>browser.name===browserName)};
  await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();
  await click(page,'New');await number(page,'Width (px)','128');await number(page,'Height (px)','128');await click(page,'Create');await expect(page.getByRole('dialog',{name:'New document',exact:true})).toBeHidden();
  const documentId=commands.find(value=>value.body.type==='CreateDocument').documentId;
  await click(page,'Import image');await expect(page.getByRole('dialog',{name:'Import image',exact:true})).toBeVisible();await page.locator('en-dialog#editor-dialog').locator('en-file-upload input[type=file]').setInputFiles('tests/raster/fixtures/hidden-alpha.png');
  await confirmImageImports(page,{names:['hidden-alpha.png'],destination:'current'});await page.getByRole('treeitem').first().click();
  const originalDocument=(await read('/api/v1/documents/'+documentId)).projection.value,originalImage=await read('/api/v1/documents/'+documentId+'/image');
  const originalAsset=await read('/api/v1/assets/'+originalDocument.image.compositeAssetId),originalPixels=await objectBytes(originalAsset.projection.value.raster.pixels);
  await page.getByRole('combobox',{name:'Operation',exact:true}).selectOption(masked?'Edit masked region with Ideogram v4.5':'Transform with Ideogram v4.5');
  await page.getByRole('textbox',{name:'Prompt',exact:true}).fill('V45 '+operation+' Café 東京 exact review');
  await expect(page.getByRole('combobox',{name:'Edit precision',exact:true})).toHaveValue(masked?'high':'regular');await expect(page.getByRole('combobox',{name:'Quality',exact:true})).toHaveValue('medium');
  await expect(page.getByRole('spinbutton',{name:'Transformation strength',exact:true})).toHaveCount(0);
  for(const label of ['Expansion','Prompt expansion','Rendering speed','Acceleration','Output format'])await expect(page.getByRole('combobox',{name:label,exact:true})).toHaveCount(0);
  await expect(page.locator('#request-v45-inputs')).toContainText('0 of '+(masked?3:4)+' attached.');
  await keyboard(page.getByRole('button',{name:'Capture selected layer contribution',exact:true}));await expect(page.locator('#request-source-status')).toContainText('single-layer source · 128 × 128');
  await expect(page.getByRole('img',{name:'Captured source',exact:true})).toBeVisible();
  const captured=await savedDraft(value=>!!value.source);expect(captured.references).toEqual([]);expect(captured.source.documentRevision).toBe(originalDocument.revision);
  const labels=['Capture selected layer as reference','Capture visible document as reference','Capture selected layers as reference','Capture selected layer as reference'];
  for(let index=0;index<(masked?3:4);index++)await captureReference(labels[index],index+1);
  for(const label of labels.slice(0,3))await expect(page.getByRole('button',{name:label,exact:true})).toBeDisabled();
  const attached=await savedDraft(value=>value.references.length===(masked?3:4)),ids=attached.references.map((value:any)=>value.assetId);
  expect(attached.references.map((value:any)=>value.scope)).toEqual(masked?['single-layer','visible-document','selected-layers']:['single-layer','visible-document','selected-layers','single-layer']);
  await keyboard(page.getByRole('button',{name:'Move reference 2 earlier',exact:true}));
  const reordered=await savedDraft(value=>value.references[0]?.assetId===ids[1]&&value.references[1]?.assetId===ids[0]);
  expect(reordered.references).toEqual([attached.references[1],attached.references[0],...attached.references.slice(2)]);
  let retained:any;
  if(!masked){
   // Removing an attachment restores capacity without implicitly attaching the canvas.
   await keyboard(page.getByRole('button',{name:'Remove reference 3',exact:true}));
   const removed=await savedDraft(value=>value.references.length===3);expect(removed.references).toEqual([attached.references[1],attached.references[0],attached.references[3]]);
   await captureReference('Capture selected layers as reference',4);
   await page.getByRole('combobox',{name:'Requested output size',exact:true}).selectOption('custom');await number(page,'Requested output width','257');await number(page,'Requested output height','256');
   retained=await prepareInputs();expect(retained.mask).toBeNull();expect(retained.preparedInputs.mask).toBeNull();
   const before=uiRequests.filter(value=>value.body.type==='PrepareRequestReview').length;
   await keyboard(page.getByRole('button',{name:'Review exact request',exact:true}));await expect(page.locator('#request-errors')).toContainText('V45_EDIT_SIZE');
   expect(uiRequests.filter(value=>value.body.type==='PrepareRequestReview')).toHaveLength(before);await expect(page.getByRole('spinbutton',{name:'Requested output width',exact:true})).toHaveValue('257');
   await number(page,'Requested output width','288');retained=await savedDraft(value=>value.fields.width==='288'&&!!value.preparedInputs);
  }else{
   await expect(page.getByRole('combobox',{name:'Provider output size (Auto required)',exact:true})).toHaveValue('auto');
   await expect(page.getByRole('spinbutton',{name:'Requested output width',exact:true})).toHaveCount(0);
   // Empty coverage cannot become an approved input or reach preparation.
   await keyboard(page.getByRole('button',{name:'Clear request mask',exact:true}));await expect(page.locator('#request-mask-status')).toContainText('empty');
   await keyboard(page.getByRole('button',{name:'Preview request crop and mapping',exact:true}));
   await expect(page.getByRole('button',{name:'Approve this source, mask and mapping',exact:true})).toBeDisabled();
   await expect(page.getByRole('button',{name:'Prepare source, mask and ordered references',exact:true})).toBeDisabled();expect(commands.filter(value=>value.body.type==='PrepareV45EditInputs')).toHaveLength(0);
   await page.getByRole('combobox',{name:'Request mask shape',exact:true}).selectOption('rectangle');
   for(const [label,value]of [['Mask X','32'],['Mask Y','32'],['Mask width','32'],['Mask height','32'],['Feather radius in document pixels','3']])await number(page,label,value);
   await keyboard(page.getByRole('button',{name:'Build request mask shape',exact:true}));await expect(page.locator('#request-mask-status')).toContainText('partial coverage');
   const gridOriginal=await savedDraft(value=>!!value.mask?.binding&&value.fields.width==='128'&&value.fields.height==='128');
   const gridMaskIdentity=(mask:any)=>Object.fromEntries(['assetId','version','blob','pixels','width','height','sourceHash','polarity','plan','binding'].map(key=>[key,mask[key]]));
   const beforeGridCommands=commands.filter(value=>value.body.type==='PrepareV45EditInputs').length,beforeGridReviews=uiRequests.filter(value=>value.body.type==='PrepareRequestReview').length;
   for(const [axis,label,value] of [['width','Prepared transport width',''],['height','Prepared transport height','8193']]){
    const input=page.getByRole('spinbutton',{name:label,exact:true});await number(page,label,value);await keyboard(page.getByRole('button',{name:'Preview request crop and mapping',exact:true}));await expect(page.locator('#request-errors')).toContainText('REQUEST_GRID_SIZE');await expect(page.locator('#request-errors')).toBeFocused();await expect(input).toHaveValue(value);await expect(input).toHaveAttribute('aria-invalid','true');await keyboard(page.locator('#request-errors').getByRole('link',{name:/REQUEST_GRID_SIZE:/}));await expect(input).toBeFocused();
    await expect(page.locator('#request-mapping-review')).toHaveCount(0);await expect(page.getByRole('button',{name:'Prepare source, mask and ordered references',exact:true})).toBeDisabled();
    const invalid=await savedDraft(draft=>draft.fields[axis]===value&&!draft.mask?.requestPlan);expect(invalid.source).toEqual(gridOriginal.source);expect(gridMaskIdentity(invalid.mask)).toEqual(gridMaskIdentity(gridOriginal.mask));expect(invalid.preparedInputs).toBeNull();expect(commands.filter(command=>command.body.type==='PrepareV45EditInputs')).toHaveLength(beforeGridCommands);expect(uiRequests.filter(request=>request.body.type==='PrepareRequestReview')).toHaveLength(beforeGridReviews);
    await number(page,label,'128');await expect(input).not.toHaveAttribute('aria-invalid','true');await expect(page.locator('#request-errors')).toBeHidden();
   }
   await keyboard(page.getByRole('button',{name:'Preview request crop and mapping',exact:true}));await expect(page.locator('#request-mapping-status')).toContainText('Coverage is contained.');
   await keyboard(page.getByRole('button',{name:'Approve this source, mask and mapping',exact:true}));await expect(page.locator('#request-mask-status')).toContainText('Request mask plan confirmed.');
   const before=await savedDraft(value=>!!value.mask?.requestPlan),r16=await objectBytes(before.mask.requestPlan.effectiveMask);
   retained=await prepareInputs();const black=retained.preparedInputs.mask,transport=await objectBytes(black.pixels);
   expect(retained.mask).toEqual(before.mask);expect(retained.mask.polarity).toBe('white-edit');expect(black.polarity).toBe('black-edit');expect(black.sourcePixels).toEqual(retained.preparedInputs.source.pixels);
   expect({width:black.width,height:black.height}).toEqual({width:128,height:128});
   const expectedTransport=Buffer.alloc(128*128*4);let editPixels=0,fractionalPixels=0;
   for(let index=0;index<128*128;index++){const coverage=r16.readUInt16LE(index*2),expected=coverage>0?0:255;if(coverage>0)editPixels++;if(coverage>0&&coverage<65535)fractionalPixels++;expectedTransport.set([expected,expected,expected,255],index*4);}
   expect(fractionalPixels).toBeGreaterThan(0);expect(editPixels).toBeGreaterThan(32*32);expect(black.editPixels).toBe(editPixels);expect(black.keepPixels).toBe(128*128-editPixels);expect(transport).toEqual(expectedTransport);
   expect(await objectBytes(before.mask.requestPlan.effectiveMask)).toEqual(r16);evidence.coverage={canonical:before.mask.requestPlan.effectiveMask,transport:black.pixels,editPixels:black.editPixels,keepPixels:black.keepPixels};
   // A changed transport grid invalidates both approvals; controls require a
   // new mapping preview and explicit input confirmation before another review.
   await number(page,'Prepared transport width','96');await expect(page.getByRole('heading',{name:'Confirmed prepared input descriptors',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Prepare source, mask and ordered references',exact:true})).toBeDisabled();
   await number(page,'Prepared transport width','128');await keyboard(page.getByRole('button',{name:'Preview request crop and mapping',exact:true}));await keyboard(page.getByRole('button',{name:'Approve this source, mask and mapping',exact:true}));retained=await prepareInputs();
  }
  await keyboard(page.getByRole('button',{name:'Review current request document',exact:true}));
  const acceptedReview=await review();expect(acceptedReview.request.source).toEqual(retained.source);expect(acceptedReview.request.references).toEqual(retained.references);expect(acceptedReview.request.preparedInputs).toEqual(retained.preparedInputs);
  expect(acceptedReview.request.modelRequest.requested).toEqual(masked?{width:128,height:128}:{width:288,height:256});
  expect(acceptedReview.request.modelRequest.body).toEqual({image_size:masked?'auto':{width:288,height:256},edit_precision:masked?'high':'regular',quality:'medium',num_images:1,sync_mode:false});
  expect(acceptedReview.providerReview.admission).toMatchObject({policy:'unknown-withheld-1',state:'blocked'});expect(acceptedReview.providerReview.privacyProfile).toBeNull();expect(acceptedReview.providerReview.dispatch).toBe(false);
  await expect(page.locator('#request-review')).toContainText('Safety is unknown; display, adoption, export and production dispatch remain blocked.');
  await keyboard(page.getByRole('button',{name:'Accept this exact review locally',exact:true}));await expect(page.getByRole('status',{name:'Request status',exact:true})).toContainText('Request review accepted locally. No job was queued and no provider call was made.');
  await keyboard(page.getByRole('button',{name:'Enqueue accepted request',exact:true}));
  let queue:any,job:any;await expect.poll(async()=>{queue=await read('/api/v1/queue');job=queue.jobs.find((value:any)=>value.review.id===acceptedReview.id);return job?.attempts[0]?.state;}).toBe('not-started');
  expect(queue.production).toBe('denied');expect(queue.counts).toEqual({reserved:0,dispatched:0,remaining:null,active:0});expect(job.review).toEqual(acceptedReview);expect(job.attempts[0].providerAuthorization).toBeUndefined();
  expect(job.stagePlan.map((value:any)=>value.role)).toEqual(['source',...(masked?['mask']:[]),...retained.references.map((_:unknown,index:number)=>'reference:'+index)]);
  expect(job.stagePlan.map((value:any)=>value.prepared)).toEqual([retained.preparedInputs.source,...(masked?[retained.preparedInputs.mask]:[]),...retained.preparedInputs.references]);
  const template=await objectBytes(acceptedReview.template),wire=JSON.parse(template.toString('utf8'));
  expect(wire).toEqual({prompt:'V45 '+operation+' Café 東京 exact review',image_url:'asset:'+retained.preparedInputs.source.blob.hash,...(masked?{mask_url:'asset:'+retained.preparedInputs.mask.blob.hash}:{}),reference_image_urls:retained.preparedInputs.references.map((value:any)=>'asset:'+value.blob.hash),image_size:masked?'auto':{width:288,height:256},edit_precision:masked?'high':'regular',quality:'medium',num_images:1,sync_mode:false});
  expect((await read('/api/v1/documents/'+documentId)).projection.value).toEqual(originalDocument);expect(await read('/api/v1/documents/'+documentId+'/image')).toEqual(originalImage);expect(await objectBytes(originalAsset.projection.value.raster.pixels)).toEqual(originalPixels);
  evidence.review=acceptedReview;evidence.queued=queue;
  await page.reload();await expect(page.getByRole('textbox',{name:'Prompt',exact:true})).toBeVisible();await page.getByRole('combobox',{name:'Operation',exact:true}).selectOption(masked?'Edit masked region with Ideogram v4.5':'Transform with Ideogram v4.5');
  await expect(page.getByRole('textbox',{name:'Prompt',exact:true})).toHaveValue('V45 '+operation+' Café 東京 exact review');await expect(page.getByRole('heading',{name:'Confirmed prepared input descriptors',exact:true})).toBeVisible();
  const reopened=await savedDraft(value=>!!value.preparedInputs);expect(reopened.source).toEqual(retained.source);expect(reopened.references).toEqual(retained.references);expect(reopened.preparedInputs).toEqual(retained.preparedInputs);
  expect((await read('/api/v1/queue')).jobs.find((value:any)=>value.id===job.id).review).toEqual(acceptedReview);
  await click(page,'Refresh durable queue');await keyboard(page.getByRole('button',{name:'Cancel unstarted job '+job.id,exact:true}));
  await expect.poll(async()=>{const current=(await read('/api/v1/queue')).jobs.find((value:any)=>value.id===job.id);return current.attempts[0].state;}).toBe('locally-cancelled');
  expect(commands.filter(value=>value.body.type==='QueueInference')).toHaveLength(1);expect(commands.filter(value=>value.body.type==='AuthorizeProviderJob')).toHaveLength(0);
  effects=await server.effects();expect(Object.values(effects).every(value=>value===0)).toBe(true);
 }catch(error){state.failures.push({phase:'body',error});}finally{
  await step(state,'quiesce-pages',async()=>{for(const current of context.pages())await current.goto('about:blank');});
  await step(state,'response-observations',()=>Promise.all(pending));
  if(!state.failures.length)await step(state,'logical-cleanup',async()=>{await guard.cleanup();guard.verify();});
  if(server){await step(state,'final-effects',async()=>{effects=await server!.effects();expect(Object.values(effects).every(value=>value===0)).toBe(true);});state.writerClosed=await step(state,'writer-close',()=>server!.close());}
  await step(state,'final-response-observations',()=>Promise.all(pending));
  throwFailures(state.failures);
 }
});
