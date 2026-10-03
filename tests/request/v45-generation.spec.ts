import {test as base,expect,type Page,type Browser,type BrowserContext} from '@playwright/test';
import {mkdtemp,realpath,mkdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {serverProcess} from '../editor/process.js';
import {ownedOPFS} from '../editor/owned-opfs.js';
import {recordDOMErrors} from '../editor/error-monitor.js';
import {runs,step,throwFailures,finishFixture,errorRecord,type RunState} from '../editor/harness-lifecycle.js';
import {installE4DeliveryObserver,matchV45Deliveries} from '../recovery/e4-delivery-observer.mjs';

const receipt=process.env.EDITOR_RECEIPT??'artifacts/v45-generation-browser';
const prefix='generation-';
const test=base.extend({context:async({playwright,browserName,contextOptions,viewport},use,testInfo)=>{
 let profile:string|undefined,browser:Browser|undefined,context:BrowserContext|undefined,acquisitionError:unknown;
 try{
  profile=browserName==='webkit'?await mkdtemp(join(await realpath(tmpdir()),'ie-v45-generation-webkit-')):undefined;
  browser=profile?undefined:await playwright[browserName].launch();
  context=profile?await playwright.webkit.launchPersistentContext(profile,{...contextOptions,viewport}):await browser!.newContext({...contextOptions,viewport});
  await Promise.all(context.pages().map(page=>page.close()));
  await use(context);
 }catch(error){
  acquisitionError=error;
  if(context&&!runs.has(context))runs.set(context,{failures:[{phase:'context-acquisition',error}],roots:[],writerClosed:true,contextClosed:false,browserClosed:false,retention:[],receipt,prefix});
  throw error;
 }finally{
  if(context)await finishFixture(context,browser,profile,receipt,prefix,testInfo);
  else{
   const state:RunState={failures:[{phase:'context-acquisition',error:acquisitionError??Error('Browser context was not returned.')}],roots:profile?[profile]:[],writerClosed:true,contextClosed:false,browserClosed:false,retention:profile?[{root:profile,retained:true,reason:'Persistent context never returned; writer closure is unverified.'}]:[],receipt,prefix};
   if(browser)state.browserClosed=await step(state,'browser-close-after-acquisition-failure',()=>browser!.close());
   // A rejected persistent-context launch gives no context to prove closed.
   // Keep its private profile and disclose that uncertainty instead of deleting it.
   await step(state,'acquisition-receipt',async()=>{await mkdir(receipt,{recursive:true});await writeFile(join(receipt,prefix+'acquisition.json'),JSON.stringify({contextReturned:false,browserClosed:state.browserClosed,retention:state.retention,failures:state.failures.map(failure=>({phase:failure.phase,error:errorRecord(failure.error)}))},null,2));});
   throwFailures(state.failures);
  }
 }
}});
const button=(page:Page,name:string)=>page.getByRole('button',{name,exact:true});
const choice=(page:Page,name:string)=>page.getByRole('combobox',{name,exact:true});
const field=(page:Page,name:string)=>page.getByRole('textbox',{name,exact:true});
async function number(page:Page,name:string,value:string){const input=page.getByRole('spinbutton',{name,exact:true});await input.fill(value);await input.press('Tab');}
async function closeReview(page:Page){await button(page,'Close request review').click();await expect(button(page,'Review exact request')).toBeFocused();}
async function prepare(page:Page,delivered:(request:any)=>Promise<any>){
 const received=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.startsWith('/api/v1/ui/')&&response.request().postDataJSON()?.body?.type==='PrepareRequestReview');
 await button(page,'Review exact request').focus();
 await page.keyboard.press('Enter');
 const response=await received;expect(response.ok()).toBe(true);
 const body=await delivered(response.request().postDataJSON());expect(body.review).toBeTruthy();
 await expect(page.getByRole('heading',{name:'Immutable request review',exact:true})).toBeVisible();
 await expect(page.locator('#request-review')).toBeFocused();
 await expect(button(page,'Enqueue accepted request')).toBeDisabled();
 return body.review;
}
async function expectV45Controls(page:Page,configured:boolean){
 await expect(choice(page,'Operation')).toHaveValue('Generate with Ideogram v4.5');
 await expect(page.getByRole('region',{name:'Ideogram v4.5 generation settings',exact:true})).toBeVisible();
 await expect(choice(page,'Quality')).toHaveValue(configured?'high':'medium');
 await expect(choice(page,'Prompt expansion')).toHaveValue(configured?'disabled':'enabled');
 await expect(page.getByRole('spinbutton',{name:'Output count',exact:true})).toHaveValue(configured?'3':'1');
 await expect(field(page,'Exact seed (empty means Random)')).toHaveValue(configured?'900719925474099312345':'');
 await expect(choice(page,'Request size')).toHaveValue(configured?'custom':'square_hd');
 if(configured){
  await expect(choice(page,'Supported output dimensions')).toHaveValue('1248x832');
  await expect(choice(page,'Supported output dimensions').locator('option:not([hidden])')).toHaveCount(36);
 }else await expect(choice(page,'Supported output dimensions')).toHaveCount(0);
 for(const label of ['Expansion','Rendering speed','Acceleration','Output format'])await expect(choice(page,label)).toHaveCount(0);
 for(const label of ['Output width','Output height','Transformation strength'])await expect(page.getByRole('spinbutton',{name:label,exact:true})).toHaveCount(0);
 await expect(button(page,'Attach selected image asset')).toHaveCount(0);
 await expect(page.locator('#request-v45-safety')).toContainText('Returned images remain withheld from ordinary display, adoption and export.');
}
function expectV45Review(review:any,configured:boolean){
 expect(review).toMatchObject({kind:'request-review-v45-1',endpoint:'ideogram/v4.5',dispatch:false});
 expect(review.request.kind).toBe('generate-v45');
 const model=review.request.modelRequest;
 expect(model).toMatchObject({
  kind:'generate-v45',contract:'fal-ideogram-v45-generation-1',endpoint:'ideogram/v4.5',
  schemaHash:'sha256:ac31bdbfdf982da0b49bcaa94aedaaf4d95fa9fe9491ef473c120808843def29',
  promptMode:'plain',requested:configured?{width:1248,height:832}:{width:1024,height:1024},
  outputFormat:'provider-controlled',safetyAdmission:'blocked-unavailable-evidence',
  estimate:{currency:'USD',cents:configured?66:6,rateDate:'2026-09-30',actualCharge:null}
 });
 // Exact keys exclude inherited V4 fields and a rounded Number seed in the model body.
 expect(model.body).toEqual({image_size:configured?{width:1248,height:832}:'square_hd',quality:configured?'high':'medium',enable_prompt_expansion:!configured,num_images:configured?3:1,sync_mode:false});
 expect(review.request.settings.count).toBe(configured?3:1);
 expect(review.request.settings.seed).toEqual(configured?{kind:'integer',decimal:'900719925474099312345'}:{kind:'provider-random'});
 expect(review.request.settings.prompt.mode).toBe('plain');
}
async function expectV4Draft(page:Page,prompt:string){
 await expect(choice(page,'Operation')).toHaveValue('Generate image');
 await expect(field(page,'Prompt')).toHaveValue(prompt);
 await expect(choice(page,'Expansion')).toHaveValue('Large');
 await expect(choice(page,'Rendering speed')).toHaveValue('QUALITY');
 await expect(choice(page,'Acceleration')).toHaveValue('low');
 await expect(choice(page,'Output format')).toHaveValue('jpeg');
 await expect(choice(page,'Request size')).toHaveValue('custom');
 await expect(page.getByRole('spinbutton',{name:'Output width',exact:true})).toHaveValue('1536');
 await expect(page.getByRole('spinbutton',{name:'Output height',exact:true})).toHaveValue('896');
 await expect(page.getByRole('spinbutton',{name:'Output count',exact:true})).toHaveValue('2');
 await expect(field(page,'Exact seed (empty means Random)')).toHaveValue('41');
 await expect(choice(page,'Quality')).toHaveCount(0);
 await expect(choice(page,'Prompt expansion')).toHaveCount(0);
}

test('public v4.5 generation reviews exact fields and restores separate V4 drafts without dispatch',async({page,context,browserName})=>{
 const guard=await ownedOPFS(context,'v45-generation'),errors=await recordDOMErrors(context);
 const csp:unknown[]=[],external:string[]=[],consoleErrors:string[]=[],requests:any[]=[],responses:any[]=[],posts:any[]=[],deliveries:any[]=[],deliveryErrors:unknown[]=[],deliverySnapshots:unknown[]=[];
 let deliveryEpoch=0,deliveryOpen=false,deliverySealed=false;
 await context.addInitScript(installE4DeliveryObserver,{profile:'v45-post'});
 await context.exposeBinding('generationCSP',(_source,value)=>csp.push(value));
 await context.addInitScript(()=>addEventListener('securitypolicyviolation',event=>(window as any).generationCSP({directive:event.effectiveDirective,blocked:event.blockedURI})));
 page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
 page.on('request',request=>{const path=new URL(request.url()).pathname;if(request.method()==='POST'&&(path.startsWith('/api/v1/ui/')||path==='/api/v1/commands')){const value=request.postDataJSON();requests.push(value);posts.push({epoch:deliveryEpoch,path,request:value});}});
 const dir=await mkdtemp(join(await realpath(tmpdir()),'ie-v45-generation-'));
 let server:Awaited<ReturnType<typeof serverProcess>>|undefined,effects:unknown,runtime:unknown;
 const state:RunState={failures:[],roots:[dir],writerClosed:false,contextClosed:false,browserClosed:false,retention:[],receipt,prefix};runs.set(context,state);
 async function collectResponses(){
  const observed=await page.evaluate(()=>{
   const observer=(window as any).__p25DeliveryObserver,rows=(window as any).__p25Deliveries,errors=(window as any).__p25DeliveryErrors;
   if(!observer||!Array.isArray(rows)||!Array.isArray(errors))throw Error('V45_DELIVERY_OBSERVER_MISSING');
   return {rows:rows.splice(0),errors:errors.splice(0),snapshot:observer.snapshot()};
  });
  deliveries.push(...observed.rows.map((row:any)=>({...row,epoch:deliveryEpoch})));deliveryErrors.push(...observed.errors);
  expect(deliveryErrors).toEqual([]);expect(observed.snapshot.disabled).toBe(false);expect(observed.snapshot.droppedErrors).toBe(0);
  const joined=matchV45Deliveries(posts,deliveries);responses.splice(0,responses.length,...joined.map((row:any)=>row.delivery.value));
  return {joined,snapshot:observed.snapshot};
 }
 async function delivered(request:any){
  let found:any;
  await expect.poll(async()=>{const {joined}=await collectResponses();found=joined.find((row:any)=>row.post.request.requestId===request.requestId&&row.post.path==='/api/v1/ui/'+request.sessionId);return !!found;}).toBe(true);
  expect(found.delivery.status).toBe(200);return found.delivery.value;
 }
 async function sealResponses(){
  if(!deliveryOpen)return;
  await expect.poll(async()=>{const {joined,snapshot}=await collectResponses();return joined.length===posts.length&&snapshot.pending===0;}).toBe(true);
  matchV45Deliveries(posts,deliveries,true);
  const snapshot=await page.evaluate(()=>{const observer=(window as any).__p25DeliveryObserver;if(observer.snapshot().pending||(window as any).__p25Deliveries.length||(window as any).__p25DeliveryErrors.length)throw Error('V45_DELIVERY_CHANGED_DURING_SEAL');observer.dispose();return observer.snapshot();});
  deliverySnapshots.push({epoch:deliveryEpoch,...snapshot});expect(snapshot.errors).toBe(0);expect(snapshot.droppedErrors).toBe(0);expect(snapshot.pending).toBe(0);expect(snapshot.ownedMethods).toBe(0);expect(snapshot.retainedBytes).toBe(0);
  deliveryOpen=false;deliverySealed=true;
 }
 state.observe=()=>({runtime,errors,csp,external,consoleErrors,requests,responses,deliveryObservation:{scope:'completed-original-consumer-parse-return; not model adoption or paint',posts,deliveries,errors:deliveryErrors,snapshots:deliverySnapshots,sealed:deliverySealed},requestLifecycle:guard.requests,effects,cleanup:{opfs:guard.ledger,serverClosed:state.writerClosed,privateRootRemoved:state.retention.some((entry:any)=>entry.root===dir&&entry.removed)?dir:null}});
 state.finalCheck=async()=>{expect(deliverySealed).toBe(true);matchV45Deliveries(posts,deliveries,true);expect(deliveryErrors).toEqual([]);guard.verify();expect(guard.ledger.filter(entry=>entry.phase==='refused')).toEqual([]);expect(errors).toEqual([]);expect(csp).toEqual([]);expect(external).toEqual([]);expect(consoleErrors).toEqual([]);};
 try{
  server=await serverProcess(join(dir,'private'));
  await page.route('**/*',route=>{const url=new URL(route.request().url());if(['http:','https:'].includes(url.protocol)&&url.origin!==server!.origin){external.push(url.origin);return route.abort();}return route.continue();});
  await mkdir(receipt,{recursive:true});
  await guard.admit(page,server.origin);await page.goto(await server.pair());deliveryOpen=true;
  runtime={version:context.browser()?.version(),pin:JSON.parse(await readFile('node_modules/playwright-core/browsers.json','utf8')).browsers.find((browser:any)=>browser.name===browserName)};
  await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();
  await button(page,'New').click();await number(page,'Width (px)','1024');await number(page,'Height (px)','1024');await button(page,'Create').click();
  await expect(page.getByRole('dialog',{name:'New document',exact:true})).toBeHidden();
  const v4Prompt='V4 compatibility draft — Café\n東京',v45Prompt='V4.5 separate generation — blue ceramic teapot\n東京';
  await expect(field(page,'Prompt')).toBeVisible();await field(page,'Prompt').fill(v4Prompt);
  await choice(page,'Expansion').selectOption('Large');await choice(page,'Rendering speed').selectOption('QUALITY');
  await choice(page,'Acceleration').selectOption('low');await choice(page,'Output format').selectOption('jpeg');
  await number(page,'Output width','1536');await number(page,'Output height','896');await number(page,'Output count','2');
  await field(page,'Exact seed (empty means Random)').fill('41');
  await expectV4Draft(page,v4Prompt);

  await choice(page,'Operation').selectOption('Generate with Ideogram v4.5');
  await expectV45Controls(page,false);
  // A new family can copy plain prompt text, but never translates V4 model settings.
  await expect(field(page,'Prompt')).toHaveValue(v4Prompt);await field(page,'Prompt').fill(v45Prompt);
  const defaults=await prepare(page,delivered);expectV45Review(defaults,false);
  await expect(page.getByRole('region',{name:'Ideogram v4.5 request contract',exact:true})).toContainText('Requested 1024 × 1024 · 1 output(s) · medium quality. Prompt expansion enabled.');
  await expect(page.locator('#request-review')).toContainText('Seed: Random.');
  await closeReview(page);

  await choice(page,'Quality').selectOption('high');await choice(page,'Prompt expansion').selectOption('disabled');
  await choice(page,'Request size').selectOption('custom');await choice(page,'Supported output dimensions').selectOption('1248x832');
  await number(page,'Output count','5');
  const reviewsBeforeInvalidCount=requests.filter(request=>request.body?.type==='PrepareRequestReview').length;
  await button(page,'Review exact request').click();await expect(page.locator('#request-errors')).toContainText('V45_APP_COUNT');
  await expect(page.getByRole('spinbutton',{name:'Output count',exact:true})).toHaveValue('5');
  await expect(page.getByRole('spinbutton',{name:'Output count',exact:true})).toHaveAttribute('aria-invalid','true');await expect(page.locator('#request-errors')).toBeFocused();await page.locator('#request-errors').getByRole('link',{name:/V45_APP_COUNT:/}).click();await expect(page.getByRole('spinbutton',{name:'Output count',exact:true})).toBeFocused();
  expect(requests.filter(request=>request.body?.type==='PrepareRequestReview')).toHaveLength(reviewsBeforeInvalidCount);
  await number(page,'Output count','3');await expect(page.getByRole('spinbutton',{name:'Output count',exact:true})).not.toHaveAttribute('aria-invalid','true');await expect(page.locator('#request-errors')).toBeHidden();
  const seed=field(page,'Exact seed (empty means Random)');await seed.fill('01');await button(page,'Review exact request').click();await expect(seed).toHaveValue('01');await expect(seed).toHaveAttribute('aria-invalid','true');await page.locator('#request-errors').getByRole('link',{name:/V45_SEED:/}).click();await expect(seed).toBeFocused();expect(requests.filter(request=>request.body?.type==='PrepareRequestReview')).toHaveLength(reviewsBeforeInvalidCount);
  await seed.fill('900719925474099312345');await expect(seed).not.toHaveAttribute('aria-invalid','true');
  await expectV45Controls(page,true);
  const configured=await prepare(page,delivered);expectV45Review(configured,true);
  const contract=page.getByRole('region',{name:'Ideogram v4.5 request contract',exact:true});
  await expect(contract).toContainText('Requested 1248 × 832 · 3 output(s) · high quality. Prompt expansion disabled.');
  await expect(contract).toContainText('Seed: 900719925474099312345. Asynchronous delivery (sync_mode false).');
  await expect(contract).toContainText('Output format is provider-controlled. Returned prompt and timings are not provided by this endpoint contract.');
  await expect(contract).toContainText('A completed request does not authorize image display, adoption or export.');
  await expect(contract).toContainText('USD 0.66');await expect(contract).toContainText('Actual charge is unavailable; cancellation does not guarantee a refund.');
  await button(page,'Exact request provenance').click();
  await expect(field(page,'Frozen prompt')).toHaveValue(v45Prompt);
  expect(JSON.parse(await page.locator('#request-review pre').innerText())).toEqual(configured);
  await button(page,'Accept this exact review locally').click();
  await expect(page.getByRole('status',{name:'Request status',exact:true})).toContainText('Request review accepted locally. No job was queued and no provider call was made.');
  await expect(button(page,'Enqueue accepted request')).toBeEnabled();
  await closeReview(page);

  await choice(page,'Operation').selectOption('Generate image');await expectV4Draft(page,v4Prompt);
  await choice(page,'Operation').selectOption('Generate with Ideogram v4.5');await expectV45Controls(page,true);await expect(field(page,'Prompt')).toHaveValue(v45Prompt);
  await expect(page.locator('footer')).toContainText('Draft saved locally');
  await sealResponses();deliveryEpoch++;deliverySealed=false;
  await page.reload();deliveryOpen=true;
  // Reload opens the default operation; both saved families remain independently recoverable.
  await expectV4Draft(page,v4Prompt);await expect(page.getByRole('heading',{name:'Immutable request review',exact:true})).toBeHidden();
  await choice(page,'Operation').selectOption('Generate with Ideogram v4.5');await expectV45Controls(page,true);await expect(field(page,'Prompt')).toHaveValue(v45Prompt);
  await expect(page.getByRole('heading',{name:'Immutable request review',exact:true})).toBeHidden();
  const recovered=await prepare(page,delivered);expectV45Review(recovered,true);
  expect(recovered.request).toEqual(configured.request);expect(recovered.prompt).toEqual(configured.prompt);expect(recovered.template).toEqual(configured.template);
  await button(page,'Exact request provenance').click();await expect(field(page,'Frozen prompt')).toHaveValue(v45Prompt);
  await closeReview(page);
  await choice(page,'Operation').selectOption('Generate image');await expectV4Draft(page,v4Prompt);
  await collectResponses();
  expect(requests.filter(request=>request.body?.type==='PrepareRequestReview')).toHaveLength(3);
  expect(requests.filter(request=>request.body?.type==='AcceptRequestReview')).toHaveLength(1);
  expect(requests.filter(request=>request.command?.body?.type==='QueueInference')).toEqual([]);
  expect(requests.filter(request=>request.command?.body?.type==='AuthorizeProviderJob')).toEqual([]);
  effects=await server.effects();expect(Object.values(effects as object).every(value=>value===0)).toBe(true);
  expect(errors).toEqual([]);expect(csp).toEqual([]);expect(external).toEqual([]);expect(consoleErrors).toEqual([]);
 }catch(error){state.failures.push({phase:'body',error});}finally{
  await step(state,'original-response-observations',sealResponses);
  await step(state,'quiesce-owned-pages',async()=>{const outcomes=await Promise.allSettled(context.pages().map(ownedPage=>ownedPage.goto('about:blank')));const rejected=outcomes.filter((outcome):outcome is PromiseRejectedResult=>outcome.status==='rejected');if(rejected.length)throw new AggregateError(rejected.map(outcome=>outcome.reason),'Owned pages did not all become quiescent.');});
  await step(state,'response-observations',async()=>{matchV45Deliveries(posts,deliveries,true);});
  if(!state.failures.length)await step(state,'logical-cleanup',async()=>{await guard.cleanup();guard.verify();});
  await step(state,'response-observations-after-cleanup',async()=>{matchV45Deliveries(posts,deliveries,true);});
  if(server){
   await step(state,'final-effects',async()=>{effects=await server!.effects();expect(Object.values(effects as object).every(value=>value===0)).toBe(true);});
   state.writerClosed=await step(state,'writer-close',()=>server!.close());
  }
  await step(state,'final-response-observations',async()=>{matchV45Deliveries(posts,deliveries,true);});
  throwFailures(state.failures);
 }
});
