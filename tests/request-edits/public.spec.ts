import {test as base,expect,type Page,type Locator} from '@playwright/test';
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

const receipt=process.env.EDITOR_RECEIPT??'artifacts/p26-request-edits';
const test=base.extend({context:async({playwright,browserName,contextOptions,viewport},use,info)=>{
  const profile=browserName==='webkit'?await mkdtemp(join(await realpath(tmpdir()),'p26-webkit-')):undefined;
  const browser=profile?undefined:await playwright[browserName].launch();
  const context=profile?await playwright.webkit.launchPersistentContext(profile,{...contextOptions,viewport}):await browser!.newContext({...contextOptions,viewport});
  await Promise.all(context.pages().map(page=>page.close()));
  try{await use(context);}finally{await finishFixture(context,browser,profile,receipt,'e3-',info);}
}});
const click=(page:Page,name:string)=>page.getByRole('button',{name,exact:true}).click();
const button=(page:Page,id:string)=>page.locator('#'+id).getByRole('button');
async function keyboard(control:Locator){await expect(control).toBeEnabled();await control.focus();await expect(control).toBeFocused();await control.press('Enter');}
async function number(page:Page,name:string,value:string){const input=page.getByRole('spinbutton',{name,exact:true});await input.fill(value);await input.press('Tab');}
async function numeric(page:Page,id:string,value:string){const input=page.locator('#'+id).getByRole('spinbutton');await input.fill(value);await input.press('Tab');}
const digest=(bytes:Uint8Array)=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const objectPath=(root:string,ref:{hash:string})=>join(root,'objects','sha256',ref.hash.slice(7,9),ref.hash.slice(7));

// This is a public UI assembly test. Only the provider boundary is a local
// fixture; capture, authoring, staging, preparation, acceptance and history use
// the same commands and retained objects as the editor.
test('E3 keyboard mask and native overlay survive safe adoption history and stale-target recovery',async({page,context,browserName})=>{
  const guard=await ownedOPFS(context,'p26-e3'),errors=await recordDOMErrors(context);
  const csp:unknown[]=[],external:string[]=[],consoleErrors:string[]=[],commands:any[]=[],uiRequests:any[]=[],replies:any[]=[],pending:Promise<void>[]=[];
  const dir=await mkdtemp(join(await realpath(tmpdir()),'p26-e3-')),root=join(dir,'private');
  let server:Awaited<ReturnType<typeof serverProcess>>|undefined,effects:any,closed:any;
  const evidence:Record<string,unknown>={};
  const state:RunState={failures:[],roots:[dir],writerClosed:false,contextClosed:false,browserClosed:false,retention:[],receipt,prefix:'e3-'};
  runs.set(context,state);
  state.observe=()=>({errors,csp,external,consoleErrors,commands,uiRequests,replies,effects,closed,evidence,process:server?.lifecycle,requestLifecycle:guard.requests,cleanup:guard.ledger});
  state.finalCheck=async()=>{
    guard.verify();expect(guard.ledger.filter(entry=>entry.phase==='refused')).toEqual([]);
    expect(errors).toEqual([]);expect(csp).toEqual([]);expect(external).toEqual([]);expect(consoleErrors).toEqual([]);
    expect(closed?.closed).toBe(true);expect(closed?.resources.objects).toEqual({reservedBytes:'0',activeTransfers:0});
    expect(closed?.resources.raster.activeWorkers).toBe(0);
  };
  await context.exposeBinding('requestEditsCSP',(_source,value)=>csp.push(value));
  await context.addInitScript(()=>addEventListener('securitypolicyviolation',event=>(window as any).requestEditsCSP({directive:event.effectiveDirective,blocked:event.blockedURI})));
  page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
  page.on('request',request=>{
    if(request.method()!=='POST')return;const path=new URL(request.url()).pathname;
    if(path==='/api/v1/commands')commands.push(JSON.parse(request.postData()!).command);
    if(path.startsWith('/api/v1/ui/'))uiRequests.push(JSON.parse(request.postData()!));
  });
  page.on('response',response=>{
    const path=new URL(response.url()).pathname;
    if(response.request().method()==='POST'&&(path==='/api/v1/commands'||path.startsWith('/api/v1/ui/')))
      pending.push(response.json().then(value=>{replies.push({path,request:JSON.parse(response.request().postData()!),value});}).catch(error=>{state.failures.push({phase:'response-observation',error});}));
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
    const created=commands.find(command=>command.body.type==='NewDocument');expect(created).toBeTruthy();const documentId=created.documentId;
    const inputPixels=Buffer.alloc(512*512*4);
    for(let y=0;y<512;y++)for(let x=0;x<512;x++){const at=(y*512+x)*4;inputPixels[at]=64+x%128;inputPixels[at+1]=96+y%128;inputPixels[at+2]=32+(x+y)%64;inputPixels[at+3]=255;}
    const sourceFile=join(dir,'E3 source.png');await writeFile(sourceFile,await sharp(inputPixels,{raw:{width:512,height:512,channels:4}}).png().toBuffer());
    await click(page,'Import image');await page.getByLabel('Image file',{exact:true}).setInputFiles(sourceFile);await click(page,'Apply reviewed result');
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
    await page.getByRole('combobox',{name:'Request size',exact:true}).selectOption('auto');await click(page,'Use operation strength default');
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
    const preparedReviews=uiRequests.filter(request=>request.body?.type==='PrepareRequestReview').length;
    await keyboard(button(page,'prepare-request'));
    await expect(page.locator('#request-errors')).toContainText('MASK');
    expect(uiRequests.filter(request=>request.body?.type==='PrepareRequestReview')).toHaveLength(preparedReviews);
    expect(commands.filter(command=>command.body.type==='QueueInference')).toHaveLength(0);
    effects=await server.effects();expect(effects.effects).toEqual([]);
    await keyboard(button(page,'request-mapping-preview'));
    await keyboard(button(page,'request-mask-confirm'));
    await keyboard(button(page,'request-document'));
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
    // This first adoption has no full preserved replacement preview. Review
    // only frozen inputs/placement, then explicitly accept real preparation.
    // The canonical source/R16 inputs remain authoritative; this is not a claim
    // that the PERF encoded-only three-decode C profile has been qualified.
    expect(commands.filter(command=>command.body.type==='PrepareCandidateAdoption')).toHaveLength(0);
    await keyboard(button(page,'request-candidate-review-new-'+candidate.id));
    await expect(button(page,'request-candidate-accept-prepare-'+candidate.id)).toBeEnabled();
    const deferredPlacement=commands.filter(command=>command.body.type==='ReviewCandidatePlacement').at(-1);
    expect(deferredPlacement.body.placement).toBe('new-document');expect(deferredPlacement.body.mode).toBe('safe-region');
    expect(commands.filter(command=>command.body.type==='PrepareCandidateAdoption')).toHaveLength(0);
    expect(commands.filter(command=>command.body.type==='AdoptReviewedCandidate')).toHaveLength(0);
    expect(await document(documentId)).toEqual(originalDocument);expect(await imageState(documentId)).toEqual(originalState);
    await expect(page.locator('#request-candidate-deferred-review-'+candidate.id)).toContainText('The final result will be prepared after acceptance.');
    await keyboard(button(page,'request-candidate-accept-prepare-'+candidate.id));
    await expect.poll(async()=>document(deferredPlacement.body.newDocumentId).then(value=>value.id,()=>null)).toBe(deferredPlacement.body.newDocumentId);
    await expect(page.getByRole('treeitem')).toHaveCount(1);
    const deferredDocument=await document(deferredPlacement.body.newDocumentId),deferredState=await imageState(deferredDocument.id),deferredPixels=await pixels(deferredState.layers[0].assetId);
    expect(commands.filter(command=>command.body.type==='AdoptReviewedCandidate')).toHaveLength(1);
    let deferredExterior=0,deferredMismatch:number|null=null;
    for(let index=0;index<512*512;index++)if(effective.readUInt16LE(index*2)===0){deferredExterior++;if(!deferredPixels.subarray(index*4,index*4+4).equals(sourcePixels.subarray(index*4,index*4+4)))deferredMismatch??=index;}
    expect(deferredExterior).toBeGreaterThan(0);expect(deferredMismatch).toBeNull();expect(await document(documentId)).toEqual(originalDocument);
    evidence.deferredPreparation={reviewCommandId:deferredPlacement.commandId,documentId:deferredDocument.id,fullPreviewRequestedBeforeAcceptance:false,exteriorPixels:deferredExterior,resultDigest:digest(deferredPixels),representation:'authoritative-canonical-inputs'};
    await click(page,'Open');
    await page.getByRole('dialog',{name:'Open document',exact:true}).getByRole('button',{name:new RegExp('^'+documentId+' · ')}).click();
    await expect(page.getByRole('dialog',{name:'Open document',exact:true})).toBeHidden();
    await expect(page.getByRole('treeitem')).toHaveCount(2);await click(page,'Refresh durable queue');
    await jobCard.getByRole('button',{name:'Inspect retained results',exact:true}).click();
    await keyboard(button(page,'request-candidate-prepare-'+candidate.id));
    await keyboard(button(page,'request-candidate-place-'+candidate.id));
    await expect(button(page,'request-candidate-adopt-'+candidate.id)).toBeEnabled();
    const placement=commands.filter(command=>command.body.type==='PrepareCandidateAdoption').at(-1);expect(placement).toBeTruthy();
    const comparisons=[];
    for(const pair of ['source','document']){
      const prefix='candidate-comparison-'+candidate.id+'-'+pair;
      const mode=page.locator('#'+prefix+'-mode').getByRole('combobox');
      await mode.focus();await expect(mode).toBeFocused();await mode.press('ArrowDown');await mode.press('Enter');
      await expect(mode).toHaveValue('b');await expect(page.locator('#'+prefix+'-status')).toContainText('B:');
      const reveal=page.locator('#'+prefix+'-reveal').getByRole('spinbutton');
      await reveal.focus();await reveal.press('ControlOrMeta+A');await reveal.pressSequentially('24');await reveal.press('Tab');
      await keyboard(page.locator('#'+prefix+'-reveal').getByRole('button',{name:'Increase value',exact:true}));
      await expect(reveal).toHaveValue('25');await expect(mode).toHaveValue('reveal');
      await expect(page.locator('#'+prefix+'-status')).toContainText('Reveal: 25%');
      const comparison=page.locator('.candidate-comparison-pair').filter({has:page.locator('#'+prefix+'-mode')});
      const geometry=await comparison.locator('svg').evaluate(svg=>({
        viewBox:svg.getAttribute('viewBox'),
        images:[...svg.querySelectorAll('image')].map(image=>({x:image.getAttribute('x'),y:image.getAttribute('y'),width:image.getAttribute('width'),height:image.getAttribute('height'),clip:image.getAttribute('clip-path')})),
        clips:[...svg.querySelectorAll('clipPath rect')].map(rect=>({x:rect.getAttribute('x'),width:rect.getAttribute('width')})),
      }));
      expect(geometry.viewBox).toBe('0 0 512 512');expect(geometry.images).toHaveLength(2);
      expect(geometry.images.every(image=>image.x==='0'&&image.y==='0'&&image.width==='512'&&image.height==='512'&&image.clip)).toBe(true);
      expect(geometry.clips).toEqual([{x:'0',width:'128'},{x:'128',width:'384'}]);
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
    expect(adoptedPixels).toEqual(deferredPixels);
    let exterior=0,interior=0,feather=0,firstMismatch:number|null=null;
    for(let index=0;index<512*512;index++){
      const coverage=effective.readUInt16LE(index*2),at=index*4;
      if(coverage===0){exterior++;if(!adoptedPixels.subarray(at,at+4).equals(sourcePixels.subarray(at,at+4))||!adoptedComposite.subarray(at,at+4).equals(originalComposite.subarray(at,at+4)))firstMismatch??=index;}
      else if(coverage===65535){interior++;if(!adoptedPixels.subarray(at,at+4).equals(Buffer.from([36,104,172,255])))firstMismatch??=index;}
      else feather++;
    }
    expect(exterior).toBeGreaterThan(0);expect(interior).toBeGreaterThan(0);expect(feather).toBeGreaterThan(0);expect(firstMismatch).toBeNull();
    const acceptedHistory=adoptedDocument.historyHead;
    await keyboard(page.getByRole('button',{name:'Undo',exact:true}));
    await expect.poll(async()=>(await document(documentId)).image).toEqual(originalDocument.image);
    expect(await imageState(documentId)).toEqual(originalState);
    await keyboard(page.getByRole('button',{name:'Redo',exact:true}));
    await expect.poll(async()=>(await document(documentId)).historyHead).toBe(acceptedHistory);
    expect(await imageState(documentId)).toEqual(adoptedState);
    expect(await pixels(source.assetId)).toEqual(sourcePixels);expect(digest(await readFile(objectPath(root,maskPlan.effectiveMask)))).toBe(maskDigest);
    await page.getByRole('treeitem').filter({hasText:'Text'}).click();await click(page,'Edit text');
    await expect(page.locator('#native-text-content')).toHaveValue('Editable overlay');await click(page,'Cancel text edit');
    // The retained candidate still belongs to the original source revision.
    // Replacing that target again cannot reuse its old same-document promise.
    const staleTarget=await document(documentId),adoptionsBeforeRecovery=commands.filter(command=>command.body.type==='AdoptCandidate').length;
    await keyboard(button(page,'request-candidate-prepare-'+candidate.id));
    await keyboard(button(page,'request-candidate-place-'+candidate.id));
    await expect(page.locator('#request-errors')).toContainText('REQUEST_SOURCE_CHANGED');
    await expect(button(page,'request-candidate-adopt-'+candidate.id)).toHaveCount(0);
    expect(await document(documentId)).toEqual(staleTarget);
    expect(commands.filter(command=>command.body.type==='AdoptCandidate')).toHaveLength(adoptionsBeforeRecovery);
    await keyboard(button(page,'request-candidate-new-document-'+candidate.id));
    await expect(button(page,'request-candidate-adopt-'+candidate.id)).toBeEnabled();
    const newPlacement=commands.filter(command=>command.body.type==='PrepareCandidateAdoption').at(-1);
    expect(newPlacement.body.placement).toBe('new-document');expect(newPlacement.body.mode).toBe('safe-region');expect(newPlacement.body.newDocumentId).toBeTruthy();
    await keyboard(button(page,'request-candidate-adopt-'+candidate.id));
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
    evidence.staleRecovery={sourceDocumentId:documentId,sourceRevision:staleTarget.revision,newDocumentId:recoveredDocument.id,sourceUnchanged:true};
    evidence.review=job.review;evidence.candidate=candidate;
    if(browserName!=='webkit')await page.screenshot({path:join(receipt,'e3-adopted.png'),caret:'initial'});
  }catch(error){state.failures.push({phase:'body',error});}finally{
    await step(state,'response-observations',()=>Promise.all(pending));
    if(!state.failures.length)await step(state,'logical-cleanup',async()=>{for(const current of context.pages())await current.goto('about:blank');await guard.cleanup();guard.verify();});
    await step(state,'quiesced-response-observations',()=>Promise.all(pending));
    if(server)state.writerClosed=await step(state,'writer-close',()=>server!.close());
    if(state.writerClosed)await step(state,'native-close-receipt',async()=>{closed=JSON.parse(await readFile(join(root,'request-edits-fixture.json'),'utf8'));expect(closed.closed).toBe(true);expect(closed.errors).toEqual([]);});
    throwFailures(state.failures);
  }
});
