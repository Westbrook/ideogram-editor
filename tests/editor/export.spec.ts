import {specReceipt} from './receipt-path.js';
import {confirmImageImports} from './image-import-flow.js';
import {test,expect,type Page,type Response} from '@playwright/test';
import {mkdtemp,realpath,mkdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {createHash} from 'node:crypto';
import {serverProcess} from './process.js';
import {publicReadRequest} from '../request/persistence-witness.js';
import {prepareNativePNG} from './export-workflow.js';

const click=(page:Page,name:string)=>page.getByRole('button',{name,exact:true}).click();
const field=async(page:Page,name:string,value:string)=>{const control=page.getByRole('spinbutton',{name,exact:true});await control.fill(value);await control.press('Tab');};

test('J6 actual selected JPEG preview, deliberate resize, immutable confirmation and cancel',async({page,browserName})=>{
 const directory=await mkdtemp(join(await realpath(tmpdir()),'ie-export-')),server=await serverProcess(join(directory,'private'));
 const commands:any[]=[],errors:string[]=[],external:string[]=[],previews:Response[]=[];
 page.on('pageerror',error=>errors.push(error.message));
 page.on('response',response=>{const url=new URL(response.url());if(url.origin===server.origin&&/^\/api\/v1\/assets\/[^/]+\/display$/.test(url.pathname)&&url.searchParams.get('basis')==='encoded')previews.push(response);});
 page.on('request',request=>{const url=new URL(request.url());if(['http:','https:'].includes(url.protocol)&&url.origin!==server.origin)external.push(url.origin);if(url.pathname==='/api/v1/commands'&&request.method()==='POST')commands.push(request.postDataJSON().command);});
 try{
  await page.goto(await server.pair());await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();
  await click(page,'Import image');await expect(page.getByRole('dialog',{name:'Import image',exact:true})).toBeVisible();await page.locator('en-dialog#editor-dialog').locator('en-file-upload input[type=file]').setInputFiles('tests/raster/fixtures/hidden-alpha.png');await confirmImageImports(page,{names:['hidden-alpha.png'],destination:'new',close:false});await expect(page.getByText('ImportAsset accepted and saved locally.',{exact:true})).toBeVisible();await page.locator('en-dialog#editor-dialog').getByRole('button',{name:'Open imported document',exact:true}).click();await expect(page.locator('canvas[data-asset]')).not.toHaveAttribute('data-asset','');await page.locator('en-dialog#editor-dialog').getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.getByRole('dialog',{name:'Import image',exact:true})).toBeHidden();
  await page.getByRole('treeitem').first().click();await prepareNativePNG(page);
  const prior=await page.getByRole('region',{name:'Prepared file'}).textContent();
  await click(page,'Export image');const dialog=page.getByRole('dialog',{name:'Export image',exact:true}),dialogHost=page.locator('en-dialog#editor-dialog');await expect(dialog).toBeVisible();
  await dialogHost.getByRole('combobox',{name:'Export scope',exact:true}).selectOption('selected-layers');
  await dialogHost.getByRole('combobox',{name:'Export format',exact:true}).selectOption('jpeg');
  await expect(dialogHost.getByRole('spinbutton',{name:'JPEG quality (0.01–1)',exact:true})).toHaveValue('0.9');
  const matte=dialogHost.getByRole('textbox',{name:'Opaque sRGB matte (#RRGGBB)',exact:true});await matte.fill('#123456');await matte.press('Tab');
  await dialogHost.getByRole('combobox',{name:'Export dimensions',exact:true}).selectOption('resize');await field(page,'Export width (px)','6');await field(page,'Export height (px)','4');
  const start=commands.length,previewStart=previews.length;await click(page,'Prepare export preview');await expect(page.locator('#export-preview')).toBeVisible();await expect(page.getByRole('button',{name:'Confirm reviewed export',exact:true})).toBeEnabled();
  expect(commands.slice(start).map(command=>command.body.type)).toEqual(['ExportDocument']);
  const command=commands.at(-1);expect(command.body.options).toEqual({format:'jpeg',matte:'#123456',quality:0.9,resize:{width:6,height:4},scope:{kind:'selected-layers',layerIds:expect.any(Array),includeHidden:false}});expect(command.body.options.scope.layerIds).toHaveLength(1);
  const previewResponses=previews.slice(previewStart);expect(previewResponses).toHaveLength(1);
  const previewResponse=previewResponses[0],previewURL=new URL(previewResponse.url()),match=/^\/api\/v1\/assets\/([A-Za-z0-9_-]{1,128})\/display$/.exec(previewURL.pathname);
  expect(previewResponse.status()).toBe(200);expect(previewURL.origin).toBe(server.origin);expect(match).not.toBeNull();
  const identity=previewURL.searchParams.get('identity');expect(identity).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect([...previewURL.searchParams].sort()).toEqual([['basis','encoded'],['edge','1024'],['identity',identity]]);
  expect(previewResponse.headers()).toMatchObject({'content-type':'image/png','x-display-profile':'cp1-display-v1','x-display-source':identity,'x-display-basis':'encoded','x-display-width':'6','x-display-height':'4','x-display-source-width':'6','x-display-source-height':'4','x-display-lod':'0'});
  const assetPath='/api/v1/assets/'+match![1]+'/content';
  const original=await page.evaluate(async request=>{
   const response=await fetch(request.path,request.init),length=Number(response.headers.get('content-length'));
   if(response.status!==200||!Number.isSafeInteger(length)||length<1||length>65536)throw Error('BOUNDED_PREPARED_EXPORT_REQUIRED');
   const body=[...new Uint8Array(await response.arrayBuffer())];if(body.length!==length)throw Error('PREPARED_EXPORT_LENGTH');
   return {status:response.status,etag:response.headers.get('etag'),bytes:response.headers.get('content-length'),mediaType:response.headers.get('content-type'),body};
  },publicReadRequest(assetPath));
  const jpeg=Buffer.from(original.body),hash='sha256:'+createHash('sha256').update(jpeg).digest('hex');expect(hash).toBe(identity);
  expect(original).toMatchObject({status:200,etag:'"'+hash+'"',bytes:String(jpeg.length),mediaType:'image/jpeg'});
  const decoded=await sharp(jpeg).ensureAlpha().raw().toBuffer({resolveWithObject:true});expect(decoded.info.width).toBe(6);expect(decoded.info.height).toBe(4);expect(decoded.data.filter((_value,index)=>index%4===3).every(alpha=>alpha===255)).toBe(true);expect((await sharp(jpeg).metadata()).format).toBe('jpeg');
  // Decode the original authenticated bytes independently through the browser's
  // image API. Both images then use identical canvas alpha/color semantics;
  // hidden RGB under alpha zero is not compared to unpremultiplied file bytes.
  const previewPixels=await page.locator('#export-preview').evaluate(async(node,input)=>{
   const displayed=node as HTMLImageElement,source=displayed.currentSrc;
   if(!source.startsWith('blob:')||input.bytes.length>65536)throw Error('BOUNDED_EXPORT_PREVIEW_REQUIRED');
   await displayed.decode();
   const reference=new Image(),url=URL.createObjectURL(new Blob([Uint8Array.from(input.bytes)],{type:input.mediaType}));
   const pixels=(image:HTMLImageElement)=>{
    if(!image.complete||image.naturalWidth!==input.width||image.naturalHeight!==input.height)throw Error('EXPORT_PREVIEW_DIMENSIONS');
    const canvas=document.createElement('canvas');canvas.width=input.width;canvas.height=input.height;
    try{const context=canvas.getContext('2d',{colorSpace:'srgb',willReadFrequently:true});if(!context)throw Error('CANVAS_UNAVAILABLE');context.drawImage(image,0,0);return [...context.getImageData(0,0,input.width,input.height).data];}
    finally{canvas.width=0;canvas.height=0;canvas.remove();}
   };
   try{reference.src=url;await reference.decode();if(displayed.currentSrc!==source)throw Error('EXPORT_PREVIEW_CHANGED');return {width:input.width,height:input.height,displayed:pixels(displayed),original:pixels(reference)};}
   finally{reference.removeAttribute('src');reference.remove();URL.revokeObjectURL(url);}
  },{bytes:[...jpeg],mediaType:'image/jpeg',width:6,height:4});
  expect(previewPixels.displayed).toEqual(previewPixels.original);
  await expect(page.locator('#export-review')).toContainText('Opaque matte #123456; quality 0.9');
  const prepared=commands.length;await click(page,'Confirm reviewed export');await expect(dialog).toBeHidden();expect(commands.length).toBe(prepared);
  const ready=page.getByRole('region',{name:'Prepared file'});await expect(ready).toContainText('JPEG');await expect(ready).toContainText('Ready');expect(await ready.textContent()).not.toEqual(prior);
  const retained=await ready.textContent();await click(page,'Export image');await expect(dialog).toBeVisible();await click(page,'Prepare export preview');await expect(page.getByRole('button',{name:'Confirm reviewed export',exact:true})).toBeEnabled();await dialogHost.getByRole('button',{name:'Cancel',exact:true}).click();await expect(dialog).toBeHidden();expect(await ready.textContent()).toBe(retained);
  const document:any=await page.evaluate(async request=>(await fetch(request.path,request.init)).json(),publicReadRequest('/api/v1/documents/'+command.documentId));
  expect(document.projection.value.revision).toBe(command.expectedDocumentRevision);expect(document.projection.value.historyHead).toBe(command.body.historyHead);
  expect(Object.values(await server.effects())).toEqual(Array(8).fill(0));expect(errors).toEqual([]);expect(external).toEqual([]);
  const receipt=specReceipt(import.meta.url,'artifacts/p1b7/current');await mkdir(receipt,{recursive:true});await writeFile(join(receipt,'export-jpeg-'+browserName+'.jpg'),jpeg);await writeFile(join(receipt,'export-j6-'+browserName+'.json'),JSON.stringify({browserName,commands:commands.filter(command=>command.body.type==='ExportDocument'),actualJPEG:{width:decoded.info.width,height:decoded.info.height,opaque:true,bytes:jpeg.length,assetPath,hash},preview:{path:previewURL.pathname+previewURL.search,width:previewPixels.width,height:previewPixels.height,displayedMatchesNativeOriginal:true},noReencodeOnConfirm:true,priorPreparedFileSurvivesCancel:true,documentRevisionUnchanged:true,providerEffects:await server.effects()},null,2));
 }finally{await page.close();await server.close();}
});

// Observe the actual production module selected by the owned build. These tests
// neither replace ExportControls nor choose a guessed hashed chunk filename.
type LazyExportFixture={moduleURL:string;requests:()=>number;hold():void;release():void;fail():void;pass():void};
async function withLazyExport(page:Page,work:(fixture:LazyExportFixture)=>Promise<void>){
 const evidence=JSON.parse(await readFile('dist/app/build-evidence.json','utf8')) as {outputs:{file:string;entry:boolean;modules:string[]}[]};
 const outputs=evidence.outputs.filter(output=>output.modules.includes('src/ui/export.ts'));
 expect(outputs).toHaveLength(1);expect(outputs[0].entry).toBe(false);expect(outputs[0].modules).not.toContain('src/ui/shell.ts');
 const directory=await mkdtemp(join(await realpath(tmpdir()),'ie-export-lazy-')),server=await serverProcess(join(directory,'private'));
 const moduleURL=new URL(outputs[0].file,server.origin+'/').href,failures:unknown[]=[],errors:string[]=[],external:string[]=[];
 let mode:'pass'|'hold'|'fail'='pass',requests=0,release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 page.on('pageerror',error=>errors.push(error.message));
 page.on('request',request=>{const url=new URL(request.url());if(['http:','https:'].includes(url.protocol)&&url.origin!==server.origin)external.push(url.origin);});
 try{
  await page.route(moduleURL,async route=>{
   requests++;const selected=mode;
   if(selected==='hold')await gate;
   if(selected==='fail')await route.fulfill({status:503,contentType:'text/javascript',body:'Export module temporarily unavailable.'});
   else await route.continue();
  });
  await page.goto(await server.pair());await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();
  expect(requests).toBe(0);
  await click(page,'Import image');const host=page.locator('en-dialog#editor-dialog');
  await expect(page.getByRole('dialog',{name:'Import image',exact:true})).toBeVisible();
  await host.locator('en-file-upload input[type=file]').setInputFiles('tests/raster/fixtures/hidden-alpha.png');
  await confirmImageImports(page,{names:['hidden-alpha.png'],destination:'new',close:false});
  await expect(page.getByText('ImportAsset accepted and saved locally.',{exact:true})).toBeVisible();
  await host.getByRole('button',{name:'Open imported document',exact:true}).click();
  await expect(page.locator('canvas[data-asset]')).not.toHaveAttribute('data-asset','');
  await host.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Import image',exact:true})).toBeHidden();
  expect(requests).toBe(0);await expectNoExportResources(page);
  await work({moduleURL,requests:()=>requests,hold:()=>{mode='hold';},release:()=>{mode='pass';release();},fail:()=>{mode='fail';},pass:()=>{mode='pass';}});
  expect(Object.values(await server.effects())).toEqual(Array(8).fill(0));expect(errors).toEqual([]);expect(external).toEqual([]);
 }catch(error){failures.push(error);}
 finally{
  release();
  // Drain every owned route/page/process even when an earlier assertion fails.
  for(const close of [()=>page.unrouteAll({behavior:'wait'}),()=>page.close(),()=>server.close()])try{await close();}catch(error){failures.push(error);}
 }
 if(failures.length===1)throw failures[0];
 if(failures.length)throw new AggregateError(failures,'Export lazy-load fixture did not complete cleanly.');
}
async function expectNoExportResources(page:Page){
 const counters=await page.locator('ie-shell').evaluate(element=>{
  const shell=element as HTMLElement&{documentLifecycle:{consumers:Record<string,Record<string,number|boolean>>}};
  const consumer=shell.documentLifecycle.consumers['editor-shell'];if(!consumer)throw Error('Editor shell resource inspection is unavailable.');
  return Object.fromEntries(Object.entries(consumer).filter(([name])=>name.startsWith('export')));
 });
 expect(Object.keys(counters).sort()).toEqual(['exportActionRecords','exportCallbacks','exportCancellations','exportCleanupFailures','exportModels','exportOperationRecords','exportOwnerRecords','exportPreparations','exportPreviewURLs','exportReads','exportRetiredModels','exportRetirementFailures','exportRetirementPending','exportTimers']);
 expect(Object.values(counters)).toEqual(Array(14).fill(0));
}

test('J6 Export controls load only after explicit activation and remain cancelable while loading',async({page})=>{
 await withLazyExport(page,async fixture=>{
  fixture.hold();await click(page,'Export image');
  const dialog=page.getByRole('dialog',{name:'Export image',exact:true}),host=page.locator('en-dialog#editor-dialog');
  await expect(dialog).toBeVisible();await expect(host.getByText('Loading export controls…',{exact:true})).toBeVisible();
  await expect(host.getByRole('button',{name:'Cancel',exact:true})).toBeEnabled();
  await expect(page.getByRole('button',{name:'Export image',exact:true})).toBeDisabled();
  await expect(host.getByRole('combobox',{name:'Export format',exact:true})).toHaveCount(0);
  await expect.poll(fixture.requests).toBe(1);await expectNoExportResources(page);
  fixture.release();
  await expect(host.getByRole('combobox',{name:'Export format',exact:true})).toBeVisible();
  await expect(host.getByRole('button',{name:'Prepare export preview',exact:true})).toBeEnabled();
  await expect(host.getByText('Loading export controls…',{exact:true})).toHaveCount(0);
  await host.getByRole('button',{name:'Cancel',exact:true}).click();await expect(dialog).toBeHidden();
  await click(page,'Export image');await expect(host.getByRole('combobox',{name:'Export format',exact:true})).toBeVisible();
  expect(fixture.requests()).toBe(1);
  await host.getByRole('button',{name:'Cancel',exact:true}).click();await expect(dialog).toBeHidden();
 });
});

test('J6 canceling a held Export import permits navigation and its late module cannot replace the current dialog',async({page})=>{
 await withLazyExport(page,async fixture=>{
  fixture.hold();await click(page,'Export image');
  const host=page.locator('en-dialog#editor-dialog'),exportDialog=page.getByRole('dialog',{name:'Export image',exact:true});
  await expect(host.getByText('Loading export controls…',{exact:true})).toBeVisible();await expect.poll(fixture.requests).toBe(1);
  await host.getByRole('button',{name:'Cancel',exact:true}).click();await expect(exportDialog).toBeHidden();
  // The response is still held: this enabled public action proves cancellation
  // releases the UI operation before native import has finished.
  await expect(page.getByRole('button',{name:'Open',exact:true})).toBeEnabled();await click(page,'Open');
  const openDialog=page.getByRole('dialog',{name:'Open document',exact:true});await expect(openDialog).toBeVisible();
  await expectNoExportResources(page);fixture.release();
  // Join the already-requested exact native module only to observe settlement;
  // it neither activates the feature nor constructs an Export controller.
  await page.evaluate(async url=>{await import(url);},fixture.moduleURL);
  await expect(openDialog).toBeVisible();await expect(exportDialog).toBeHidden();
  await expect(host.getByText('Loading export controls…',{exact:true})).toHaveCount(0);await expectNoExportResources(page);
  await host.getByRole('button',{name:'Cancel',exact:true}).click();await expect(openDialog).toBeHidden();
  await click(page,'Export image');await expect(host.getByRole('combobox',{name:'Export format',exact:true})).toBeVisible();
  expect(fixture.requests()).toBe(1);
  await host.getByRole('button',{name:'Cancel',exact:true}).click();await expect(exportDialog).toBeHidden();
 });
});

test('J6 an Export module failure leaves a closable message and explicit retry succeeds after reload',async({page})=>{
 await withLazyExport(page,async fixture=>{
  fixture.fail();await click(page,'Export image');
  const host=page.locator('en-dialog#editor-dialog'),dialog=page.getByRole('dialog',{name:'Export image',exact:true});
  await expect(host.getByText('Export controls are unavailable. Close this dialog and reload the editor to retry.',{exact:true})).toBeVisible();
  await expect(host.getByText('Export controls could not be loaded. Close this dialog and reload the editor to retry.',{exact:true})).toBeVisible();
  await expect(host.getByRole('button',{name:'Cancel',exact:true})).toBeEnabled();
  await expect(host.getByRole('combobox',{name:'Export format',exact:true})).toHaveCount(0);await expectNoExportResources(page);
  expect(fixture.requests()).toBe(1);
  await host.getByRole('button',{name:'Cancel',exact:true}).click();await expect(dialog).toBeHidden();
  fixture.pass();await page.reload();await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();
  await expect(page.locator('canvas[data-asset]')).not.toHaveAttribute('data-asset','');
  expect(fixture.requests()).toBe(1);await expectNoExportResources(page);
  await click(page,'Export image');await expect(host.getByRole('combobox',{name:'Export format',exact:true})).toBeVisible();
  await expect(host.getByRole('button',{name:'Prepare export preview',exact:true})).toBeEnabled();
  await expect(host.getByText('Export controls are unavailable. Close this dialog and reload the editor to retry.',{exact:true})).toHaveCount(0);
  expect(fixture.requests()).toBe(2);
  await host.getByRole('button',{name:'Cancel',exact:true}).click();await expect(dialog).toBeHidden();
 });
});
