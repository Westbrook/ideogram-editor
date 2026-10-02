import {test,expect,type Page} from '@playwright/test';
import {mkdtemp,realpath,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {serverProcess} from './process.js';
import {confirmImageImports,importReviewedImage} from './image-import-flow.js';
async function setup(page:Page){const dir=await mkdtemp(join(await realpath(tmpdir()),'ie-batch-import-')),server=await serverProcess(join(dir,'private'));await page.goto(await server.pair());await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();return server;}
async function blankDocument(page:Page){
 await page.getByRole('button',{name:'New',exact:true}).click();
 const named=page.getByRole('dialog',{name:'New document',exact:true});await expect(named).toBeVisible();
 // The public host owns the slotted controls; the native dialog owns its name.
 const controls=page.locator('en-dialog#editor-dialog');
 for(const [name,value] of [['Width (px)','128'],['Height (px)','96']]){const field=controls.getByRole('spinbutton',{name,exact:true});await field.fill(value);await field.press('Tab');}
 await expect(controls.getByRole('combobox',{name:'Background',exact:true})).toHaveValue('transparent');
 await controls.getByRole('button',{name:'Create',exact:true}).click();await expect(named).toBeHidden();
 await expect(page.getByRole('button',{name:'Close document',exact:true})).toBeEnabled();
 await expect(page.getByRole('textbox',{name:'Prompt',exact:true})).toHaveValue('');
}
const dialog=(page:Page)=>page.getByRole('dialog',{name:'Import image',exact:true});
const importControls=(page:Page)=>page.locator('en-dialog#editor-dialog');
const commands=(page:Page)=>{const rows:{id:string;body:{type:string;name?:string;stagingId?:string};documentId?:string}[]=[];page.on('request',request=>{if(new URL(request.url()).pathname==='/api/v1/commands'&&request.method()==='POST')rows.push(JSON.parse(request.postData()!).command);});return rows;};

test('J3 batch shows each failure, confirms only the chosen decoded subset, and adds one Undo unit per accepted image',async({page})=>{
 const server=await setup(page),seen=commands(page);try{
  const bytes=await readFile('tests/raster/fixtures/hidden-alpha.png');await page.getByRole('button',{name:'Import image',exact:true}).click();await expect(dialog(page)).toBeVisible();
  await importControls(page).locator('en-file-upload input[type=file]').setInputFiles([{name:'first.png',mimeType:'image/png',buffer:bytes},{name:'broken.png',mimeType:'image/png',buffer:Buffer.from('not PNG')},{name:'unselected.png',mimeType:'image/png',buffer:bytes}]);
  const bad=importControls(page).getByRole('listitem').filter({has:page.getByRole('heading',{name:'broken.png',exact:true})});await expect(bad.getByRole('button',{name:'Retry image',exact:true})).toBeVisible();await expect(importControls(page).getByRole('switch',{name:'Import unselected.png',exact:true})).toBeEnabled();
  expect(seen.filter(command=>command.body.type==='ApproveRaster')).toHaveLength(0);await confirmImageImports(page,{names:['first.png'],destination:'new',openIndex:0});
  expect(seen.filter(command=>command.body.type==='ImportAsset').map(command=>command.body.name)).toEqual(['first.png']);await expect(page.getByRole('treeitem')).toHaveCount(1);
  await page.getByRole('button',{name:'Undo',exact:true}).click();await expect(page.getByText('Undo accepted and saved locally.',{exact:true})).toBeVisible();await expect(page.getByRole('treeitem')).toHaveCount(0);
 }finally{await server.close();}
});

test('J3 explicit current versus new destinations preserve the current document until Open is chosen',async({page})=>{
 const server=await setup(page),seen=commands(page);try{
  await importReviewedImage(page,'tests/raster/fixtures/hidden-alpha.png');const original=await page.locator('.document-name').textContent();
  await page.getByRole('button',{name:'Import image',exact:true}).click();await expect(dialog(page)).toBeVisible();await importControls(page).locator('en-file-upload input[type=file]').setInputFiles('tests/raster/fixtures/white.png');
  await confirmImageImports(page,{names:['white.png'],destination:'current'});await expect(page.getByRole('treeitem')).toHaveCount(2);expect(seen.filter(command=>command.body.type==='NewDocument')).toHaveLength(1);
  const current=await page.locator('.document-name').textContent();expect(current).not.toBe(original);
  const bytes=await readFile('tests/raster/fixtures/white.png');await page.getByRole('button',{name:'Import image',exact:true}).click();await expect(dialog(page)).toBeVisible();await importControls(page).getByRole('combobox',{name:'Import destination',exact:true}).selectOption('new');await importControls(page).locator('en-file-upload input[type=file]').setInputFiles([{name:'new-one.png',mimeType:'image/png',buffer:bytes},{name:'new-two.png',mimeType:'image/png',buffer:bytes}]);
  await expect(importControls(page).getByRole('combobox',{name:'Import destination',exact:true})).toHaveValue('new');await confirmImageImports(page,{names:['new-one.png','new-two.png'],close:false});expect(seen.filter(command=>command.body.type==='NewDocument')).toHaveLength(3);await expect(page.locator('.document-name')).toHaveText(current??'');await expect(page.getByRole('treeitem')).toHaveCount(2);
  const saved=importControls(page).getByRole('listitem').filter({has:page.getByRole('heading',{name:'new-two.png',exact:true})});await saved.getByRole('button',{name:'Open imported document',exact:true}).click();await importControls(page).getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.getByRole('treeitem')).toHaveCount(1);await expect(page.locator('.document-name')).not.toHaveText(current??'');
 }finally{await server.close();}
});

test('J3 canvas-only paste/drop stays explicit and prompt input never becomes an image attachment',async({page})=>{
 const server=await setup(page),seen=commands(page);try{
  const bytes=[...await readFile('tests/raster/fixtures/hidden-alpha.png')];
  await page.getByRole('region',{name:'Canvas · image import drop target',exact:true}).evaluate((host,bytes)=>{const transfer=new DataTransfer();transfer.items.add(new File([new Uint8Array(bytes)],'canvas-one.png',{type:'image/png'}));transfer.items.add(new File([new Uint8Array(bytes)],'canvas-two.png',{type:'image/png'}));host.dispatchEvent(new DragEvent('drop',{dataTransfer:transfer,bubbles:true,cancelable:true}));},bytes);
  await expect(dialog(page)).toBeVisible();await expect(importControls(page).getByRole('switch',{name:'Import canvas-one.png',exact:true})).toBeEnabled();await expect(importControls(page).getByRole('switch',{name:'Import canvas-two.png',exact:true})).toBeEnabled();await importControls(page).getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.getByText('No document open',{exact:true})).toBeVisible();expect(seen.filter(command=>command.body.type==='ApproveRaster')).toHaveLength(0);
  // Prompt editing requires a document. Keep the empty-root cancel assertion
  // above, then distinguish its legitimate local draft bytes from image imports.
  await blankDocument(page);const prompt=page.getByRole('textbox',{name:'Prompt',exact:true}),stages=new Map<string,string>();
  const finalizedBefore=seen.filter(command=>command.body.type==='FinalizeStaging').length;
  page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/v1/assets/staging'){const body=request.postDataJSON();stages.set(body.stagingId,body.purpose);}});
  const saved=page.waitForResponse(response=>{const request=response.request();if(request.method()!=='POST'||!/^\/api\/v1\/ui\/[A-Za-z0-9_-]+$/.test(new URL(request.url()).pathname))return false;const body=request.postDataJSON();return body?.body?.type==='SaveDraft'&&body.body.draft.kind==='request';});
  await prompt.fill('keep this prompt');await prompt.blur();expect((await saved).status()).toBe(200);
  await prompt.evaluate((node,bytes)=>{const transfer=new DataTransfer();transfer.items.add(new File([new Uint8Array(bytes)],'prompt-drop.png',{type:'image/png'}));node.dispatchEvent(new DragEvent('drop',{dataTransfer:transfer,bubbles:true,cancelable:true}));node.dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));},bytes);
  await expect(prompt).toHaveValue('keep this prompt');await expect(dialog(page)).toBeHidden();
  const promptFinalizations=seen.filter(command=>command.body.type==='FinalizeStaging').slice(finalizedBefore);
  expect(promptFinalizations.length).toBeGreaterThan(0);
  for(const command of promptFinalizations)expect(['text','caption']).toContain(stages.get(command.body.stagingId!));
  expect([...stages.values()].every(purpose=>purpose==='text'||purpose==='caption')).toBe(true);
  expect(seen.filter(command=>command.body.type==='ApproveRaster')).toHaveLength(0);
 }finally{await server.close();}
});
