import {confirmImageImports} from '../editor/image-import-flow.js';
import {test as base,expect,type Page,type Request} from '@playwright/test';
import {mkdtemp,realpath,mkdir,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {serverProcess} from '../editor/process.js';import {ownedOPFS} from '../editor/owned-opfs.js';import {recordDOMErrors} from '../editor/error-monitor.js';
import {runs,step,throwFailures,finishFixture,type RunState} from '../editor/harness-lifecycle.js';
import {savedDraftWitness,publicReadRequest,CurrentEditBinding,type DraftExpectation} from './persistence-witness.js';
const receipt=process.env.EDITOR_RECEIPT!,probe=process.env.REVIEW_PROBE!;
const test=base.extend({context:async({playwright,browserName,contextOptions,viewport},use,testInfo)=>{
 const profile=browserName==='webkit'?await mkdtemp(join(await realpath(tmpdir()),'p22-alignment-profile-')):null;
 const browser=profile?null:await playwright[browserName].launch();const context=profile?await playwright.webkit.launchPersistentContext(profile,{...contextOptions,viewport}):await browser!.newContext({...contextOptions,viewport});
 await Promise.all(context.pages().map(p=>p.close()));try{await use(context);}finally{await finishFixture(context,browser,profile,receipt,'',testInfo);}
}});
const click=(p:Page,n:string)=>p.getByRole('button',{name:n,exact:true}).click();
// Visible feedback and the dedicated live region are separate public surfaces.
async function requestFeedback(page:Page,text:string){
 const region=page.getByRole('region',{name:'Typed request draft',exact:true}),group=region.getByRole('group',{name:'Request draft keyboard actions',exact:true}),feedback=group.locator(':scope > en-alert[announcement="none"]'),status=group.getByRole('status',{name:'Request status',exact:true});
 await expect(feedback).toHaveText(text);await expect(feedback).toBeVisible();await expect(status).toHaveText(text);await expect(status).toHaveAttribute('aria-live','polite');await expect(status).toHaveAttribute('aria-atomic','true');
}
async function field(p:Page,n:string,v:string){const f=p.getByRole('spinbutton',{name:n,exact:true});await f.fill(v);await f.press('Tab');}
test('independent '+probe+' public boundary',async({page,context,browserName})=>{
 await mkdir(receipt,{recursive:true});const guard=await ownedOPFS(context,'p22-alignment-'+probe),errors=await recordDOMErrors(context),csp:any[]=[],external:string[]=[],consoleErrors:string[]=[],requests:any[]=[],responses:any[]=[],pending:Promise<void>[]=[];
 let editBinding:CurrentEditBinding|undefined;const witnessReads:any[]=[];
 await context.exposeBinding('independentCSP',(_s,v)=>csp.push(v));await context.addInitScript(()=>addEventListener('securitypolicyviolation',e=>(window as any).independentCSP({directive:e.effectiveDirective,blocked:e.blockedURI})));
 page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text());});
 page.on('request',r=>{if(r.method()==='POST'&&r.url().includes('/api/v1/')){const data=r.postData();if(data&&r.headers()['content-type']?.includes('application/json')){const event={sequence:requests.length+1,path:new URL(r.url()).pathname,body:JSON.parse(data)};requests.push(event);editBinding?.observe({sequence:event.sequence,path:event.path,request:event.body});}}});
 const dir=await mkdtemp(join(await realpath(tmpdir()),'p22-alignment-')),server=await serverProcess(join(dir,'private'));let effects:any,colors:any[]=[],geometry:any,savedWitness:any;
 const state:RunState={failures:[],roots:[dir],writerClosed:false,contextClosed:false,browserClosed:false,retention:[],receipt,prefix:''};runs.set(context,state);const runtime=context.browser()?.version();
 const responseObserver={limit:1024,admitted:0,pending:0,completed:0,failed:0,outside:0,refused:0,overflow:false,sealed:false,drained:false};
 const responseFailures:{phase:string;error:unknown}[]=[];let responseDrain:Promise<void>|undefined;
 const responseFailure=(error:unknown)=>{const failure={phase:'response-observation',error};responseFailures.push(failure);state.failures.push(failure);};
 function observeResponse(request:Request){
  if(request.method()!=='POST'||!request.url().includes('/api/v1/ui/'))return;
  if(responseObserver.sealed){responseObserver.outside++;return;}
  if(pending.length>=responseObserver.limit){responseObserver.refused++;if(!responseObserver.overflow){responseObserver.overflow=true;responseFailure(Error('REQUEST_RESPONSE_OBSERVATION_LIMIT'));}return;}
  responseObserver.admitted++;responseObserver.pending++;
  // Request-start admission also owns replies whose headers arrive after sealing.
  const work=Promise.resolve().then(async()=>{const response=await request.response();if(!response)throw Error('REQUEST_OBSERVED_RESPONSE_UNAVAILABLE: '+request.url());responses.push(await response.json());responseObserver.completed++;}).catch(error=>{responseObserver.failed++;responseFailure(error);}).finally(()=>{responseObserver.pending--;});pending.push(work);
 }
 async function flushResponses(){await Promise.all(pending);throwFailures(responseFailures);}
 function sealResponses(){responseObserver.sealed=true;return responseDrain??=(async()=>{await expect.poll(()=>responseObserver.pending).toBe(0);responseObserver.drained=true;throwFailures(responseFailures);})();}
 page.on('request',observeResponse);
 state.observe=()=>({runtime,requests,responses,responseObserver:{...responseObserver},requestLifecycle:guard.requests,errors,csp,external,consoleErrors,effects,colors,geometry,savedWitness,editBinding:editBinding?.snapshot(),witnessReads,cleanup:{opfs:guard.ledger,serverClosed:state.writerClosed,privateRootRemoved:state.retention.some((r:any)=>r.root===dir&&r.removed)?dir:null}});
 state.finalCheck=async()=>{await step(state,'response-observer-final',async()=>{await expect.poll(()=>responseObserver.pending).toBe(0);throwFailures(responseFailures);});if(editBinding?.bound)editBinding.assertCurrent();guard.verify();expect(guard.ledger.filter(e=>e.phase==='refused')).toEqual([]);expect(errors).toEqual([]);expect(csp).toEqual([]);expect(external).toEqual([]);expect(consoleErrors).toEqual([]);};
 await page.route('**/*',route=>{const u=new URL(route.request().url());if(['http:','https:'].includes(u.protocol)&&u.origin!==server.origin){external.push(u.origin);return route.abort();}return route.continue();});
 try{
  await guard.admit(page,server.origin);await page.goto(await server.pair());await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();
  await click(page,'New');await field(page,'Width (px)','3');await field(page,'Height (px)','2');await click(page,'Create');await expect(page.getByRole('dialog',{name:'New document',exact:true})).toBeHidden();
  if(probe==='mapping'){
   await click(page,'Import image');await page.getByLabel('Image file',{exact:true}).setInputFiles('tests/raster/fixtures/hidden-alpha.png');await confirmImageImports(page,{names:['hidden-alpha.png'],destination:'current'});await expect(page.getByText('ImportAsset accepted and saved locally.',{exact:true})).toBeVisible();await page.getByRole('treeitem').first().click();
   await field(page,'X (document px)','1');await click(page,'Apply transform');await expect(page.getByText('ApplyTransform accepted and saved locally.',{exact:true})).toBeVisible();
   await click(page,'Select');await field(page,'Selection X','1');await field(page,'Selection Y','0');await field(page,'Selection width','1');await field(page,'Selection height','2');await click(page,'Apply selection');await click(page,'Use selection as mask');await field(page,'Feather radius (document px)','0');await click(page,'Preview mask');await expect(page.getByRole('button',{name:'Apply layer mask',exact:true})).toBeEnabled();await click(page,'Apply layer mask');await expect(page.getByText('SetLayerProperties accepted and saved locally.',{exact:true})).toBeVisible();
   await page.getByRole('combobox',{name:'Operation',exact:true}).selectOption('Edit masked region');await page.getByRole('textbox',{name:'Prompt',exact:true}).fill('Independent translated-source mask check');await page.getByRole('combobox',{name:'Request size',exact:true}).selectOption('auto');await click(page,'Use operation strength default');const legacy=page.getByRole('button',{name:'Legacy source and layer mask recovery',exact:true});await legacy.click();await expect(legacy).toHaveAttribute('aria-expanded','true');await click(page,'Attach selected image asset');await expect(page.getByText(/Source .*version .*3 × 2/)).toBeVisible();await click(page,'Attach selected layer edit mask');await expect(page.getByText(/Mask .*partial coverage/)).toBeVisible();await click(page,'Review current request document');await expect(page.getByText('Request document revision confirmed.',{exact:true})).toBeVisible();await click(page,'Review exact request');
   await expect.poll(async()=>await page.locator('#request-review').count()+await page.locator('#request-errors').count()).toBeGreaterThan(0);
   if(await page.locator('#request-review').count()){
    await click(page,'Accept this exact review locally');await expect.poll(async()=>{await flushResponses();return responses.filter(x=>x.acceptedReview||x.status==='rejected').length;}).toBeGreaterThan(0);
   }
   await flushResponses();await page.screenshot({path:join(receipt,'mapping-outcome.png'),caret:'initial'});
   const transform=requests.find(r=>r.body.command?.body.type==='ApplyTransform')?.body.command.body.transform;expect(transform).toEqual([1,0,0,1,1,0]);
   const mask=requests.find(r=>r.body.command?.body.type==='SetLayerProperties'&&r.body.command.body.properties.mask)?.body.command.body.properties.mask;expect(mask.mapping).toBe('document-r16-v1');
   await writeFile(join(receipt,'mapping-result.json'),JSON.stringify({transform,layerMask:mask,expected:'Reject until explicit source/mask frame resolution; document X=1 maps to original image X=0 under translation +1.',acceptedReviews:responses.filter(x=>x.acceptedReview),preparedReviews:responses.filter(x=>x.review)},null,2));
   expect(responses.filter(x=>x.acceptedReview),'An original-image source must not silently inherit a translated layer document-grid mask.').toHaveLength(0);
   const summary=page.locator('#request-errors');
   await expect(summary.getByRole('heading',{name:'Request needs attention',exact:true})).toBeVisible();
   await expect(summary.getByRole('link',{name:/^MASK_FRAME_MISMATCH:/})).toBeVisible();
   await expect(page.locator('#request-review')).toHaveCount(0);
   expect(responses.filter(x=>x.review),'Unresolved translated mapping must not prepare a review.').toHaveLength(0);
   const originalMask=mask.assetId;await click(page,'Attach visible document snapshot');const visibleSource=page.locator('.typed-request').getByText(/^Source .+ · version .+ · visible-document$/);await expect(visibleSource).toHaveCount(1);await expect(visibleSource).toBeVisible();await expect(page.getByText('Source snapshot attached. Reattach its mask before confirming alignment.',{exact:true})).toBeVisible();await click(page,'Attach selected layer edit mask');await expect(page.getByText('Mask frame attached to the visible-document source. Confirm its alignment.',{exact:true})).toBeVisible();await click(page,'Confirm source and mask alignment');await expect(page.getByText('Source and mask alignment confirmed without changing pixels.',{exact:true})).toBeVisible();await click(page,'Review exact request');await expect(page.getByRole('heading',{name:'Immutable request review',exact:true})).toBeVisible();await expect(page.locator('#request-review')).toBeFocused();await click(page,'Accept this exact review locally');await requestFeedback(page,'Request review accepted locally. No job was queued and no provider call was made.');await flushResponses();
   const accepted=responses.filter(x=>x.acceptedReview);expect(accepted).toHaveLength(1);const review=responses.find(x=>x.review?.id===accepted[0].acceptedReview).review;expect(review.request.source.scope).toBe('visible-document');expect(review.request.mask.assetId).toBe(originalMask);expect(review.request.mask.frame.layer.transform).toEqual([1,0,0,1,1,0]);expect(review.request.mask.frame.alignment.sourceToDocument).toEqual([1,0,0,1,0,0]);expect(review.request.mask.frame.alignment.maskToDocument).toEqual([1,0,0,1,0,0]);expect(review.request.mask.requestPlan.kind).toBe('request-raster-plan-1');expect(review.request.mask.requestPlan.expectedOutput).toEqual({width:3,height:2});expect(review.request.mask.requestPlan.sourcePixels).toEqual(review.request.source.pixels);expect(review.request.mask.requestPlan.effectiveMask.mediaType).toBe('application/x-ideogram-r16le');expect(review.request.mask.requestPlan.reconstructionHalo).toBe(0);expect(review.conversion).toBeNull();expect(review.dispatch).toBe(false);await writeFile(join(receipt,'compatible-result.json'),JSON.stringify({review,accepted},null,2));await page.screenshot({path:join(receipt,'compatible-outcome.png'),caret:'initial'});

  }else{
   const prompt=page.getByRole('textbox',{name:'Prompt',exact:true});await expect(prompt).toBeVisible();
   const created=requests.find(r=>r.body?.command?.body?.type==='CreateDocument')?.body.command;expect(created).toBeTruthy();
   const read=async(path:string,mode:'json'|'text'|'version'='json')=>page.evaluate(async({request,mode})=>{const r=await fetch(request.path,request.init);if(!r.ok)throw Error('Public witness read failed '+r.status);return mode==='version'?r.headers.get('X-App-Entity-Version'):mode==='text'?await r.text():await r.json();},{request:publicReadRequest(path,mode==='version'?'HEAD':'GET'),mode});
   const uiPath='/api/v1/ui/'+created.sessionId;
   await expect.poll(async()=>(await read(uiPath)).preferences.documentId).toBe(created.documentId);
   const before=await read(uiPath);expect(before.drafts.filter((d:any)=>d.kind==='request'&&d.documentId===created.documentId)).toHaveLength(0);
   const revision=await read('/api/v1/documents/'+created.documentId,'version');expect(revision).toBe('1');
   const intended:Omit<DraftExpectation,'generation'>={sessionId:created.sessionId,documentId:created.documentId,revision:revision!,prompt:'Theme keeps Café 東京',operation:'generate'};
   await expect(prompt).toHaveValue('');await expect(page.getByRole('combobox',{name:'Operation',exact:true})).toHaveValue('Generate image');await expect(page.getByRole('combobox',{name:'Request prompt type',exact:true})).toHaveValue('plain');
   const pendingMutations=()=>guard.requests.filter(x=>x.event==='request'&&!['GET','HEAD'].includes(x.method)&&!guard.requests.some(y=>y.requestId===x.requestId&&['finished','failed'].includes(y.event))).length;
   await expect.poll(pendingMutations,{message:'Pre-action owned mutations must finish before the new edit boundary'}).toBe(0);
   editBinding=new CurrentEditBinding({actionId:'theme-prompt-edit',expected:intended,promptBefore:await prompt.inputValue(),checkpoint:before,requestBoundary:requests.length,priorRequests:requests.map(r=>({sequence:r.sequence,path:r.path,request:r.body})),pendingMutations:pendingMutations()});
   await prompt.fill(intended.prompt);await expect(prompt).toHaveValue(intended.prompt);editBinding.completeAction(await prompt.inputValue());
   for(const appearance of ['light','dark']){await page.evaluate(v=>document.documentElement.setAttribute('data-en-appearance',v),appearance);await prompt.focus();await expect(prompt).toBeFocused();await expect(prompt).toHaveValue('Theme keeps Café 東京');colors.push(await page.locator('.typed-request').evaluate(el=>({color:getComputedStyle(el).color,background:getComputedStyle(document.body).backgroundColor})));if(browserName!=='webkit')await page.screenshot({path:join(receipt,appearance+'.png'),caret:'initial'});}
   expect(colors[0]).not.toEqual(colors[1]);await page.setViewportSize({width:320,height:900});const link=page.getByRole('link',{name:'Go to Request',exact:true});await link.focus();await link.press('Enter');await expect(page.locator('.typed-request')).toBeVisible();geometry=await page.locator('.typed-request').evaluate(el=>({width:el.getBoundingClientRect().width,scroll:el.scrollWidth}));expect(geometry.width).toBeGreaterThan(0);expect(geometry.scroll).toBeLessThanOrEqual(geometry.width+1);
   await expect.poll(()=>Boolean(editBinding!.bind()),{message:'Bind one attributable public save to the intended edit'}).toBe(true);
   const bound=editBinding.bound!,expected=bound.expected;
   await writeFile(join(receipt,'edit-binding.json'),JSON.stringify(editBinding.snapshot(),null,2));
   await expect.poll(async()=>{
    await flushResponses();const ack=editBinding!.receipt(responses);if(!ack)return 'Waiting for the bound receipt';
    const request=bound.request,checkpoint=await read(uiPath),draft=request.body.draft,path=uiPath+'/request?draftId='+encodeURIComponent(draft.id)+'&generation='+draft.generation;
    const value=(await read(path)).value,content=await read(path+'&content=1','text'),currentRevision=await read('/api/v1/documents/'+expected.documentId,'version');
    witnessReads.push({at:new Date().toISOString(),requestId:request.requestId,receipt:ack,checkpoint,value,content,revision:currentRevision});
    editBinding!.assertCurrent();
    try{savedWitness=savedDraftWitness(expected,{request,receipt:ack,checkpoint,value,content,revision:currentRevision!});return 'settled';}catch(error){return String(error);}
   },{message:'The bound current prompt must have its exact accepted receipt, checkpoint and bytes'}).toBe('settled');
   await expect(page.locator('.status-bar')).toContainText('Draft saved locally; not applied to the document');
   await expect(prompt).toHaveValue(expected.prompt);await writeFile(join(receipt,'saved-draft-witness.json'),JSON.stringify(savedWitness,null,2));

  }
  effects=await server.effects();expect(Object.values(effects).every(n=>n===0)).toBe(true);expect(errors).toEqual([]);expect(csp).toEqual([]);expect(external).toEqual([]);expect(consoleErrors).toEqual([]);
 }catch(error){state.failures.push({phase:'body',error});}finally{
  await step(state,'response-observations',sealResponses);page.off('request',observeResponse);
  await step(state,'before-cleanup-observations',()=>writeFile(join(receipt,'before-cleanup.json'),JSON.stringify(state.observe!(),null,2)));
  if(!state.failures.length)await step(state,'logical-cleanup',async()=>{for(const p of context.pages())await p.goto('about:blank');await guard.cleanup();guard.verify();});
  await step(state,'final-effects',async()=>{effects=await server.effects();expect(Object.values(effects).every(n=>n===0)).toBe(true);});
  state.writerClosed=await step(state,'writer-close',()=>server.close());
  throwFailures(state.failures);
 }
});
