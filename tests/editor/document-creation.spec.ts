// STAGED ONLY. Public J1 flows; no application-state hooks or mocked success.
import {expect,type Page} from '@playwright/test';
import sharp from 'sharp';
import {test} from './document-creation-fixture.js';
import {prepareNativePNG} from './export-workflow.js';
const click=(page:Page,name:string)=>page.getByRole('button',{name,exact:true}).click();
// Keep native named-dialog assertions separate from the public slotted-content hosts.
const searchContent=(page:Page)=>page.locator('en-dialog#command-search-dialog');
const editorContent=(page:Page)=>page.locator('en-dialog#editor-dialog');
async function field(page:Page,name:string,value:string){const input=page.getByRole('spinbutton',{name,exact:true});await input.fill(value);await input.press('Tab');}
const color=[17,83,201,255],rgba=(pixel:number[])=>Buffer.from(Array.from({length:6},()=>pixel).flat());

test('J1 named transparent and solid documents retain exact pixels through copy and writer restart',async({local})=>{
  const {page,read,commands,record}=local;
  await click(page,'Command search');const search=page.getByRole('dialog',{name:'Command search',exact:true});await expect(search).toBeVisible();const query=searchContent(page).getByRole('textbox',{name:'Search commands',exact:true});
  await expect(query).toBeFocused();await query.fill('New document');await query.press('ArrowDown');const result=searchContent(page).getByRole('button',{name:'New document',exact:true});await expect(result).toBeFocused();await result.press('Enter');await expect(search).toBeHidden();
  const dialog=page.getByRole('dialog',{name:'New document',exact:true});await expect(dialog).toBeVisible();
  const title=editorContent(page).getByRole('textbox',{name:'Document name',exact:true}),background=editorContent(page).getByRole('combobox',{name:'Background',exact:true});
  await expect(title).toBeFocused();await expect(title).toHaveValue('Untitled document');await title.fill('Transparent Café e\u0301');await field(page,'Width (px)','3');await field(page,'Height (px)','2');await background.selectOption('transparent');
  await editorContent(page).getByRole('button',{name:'Create',exact:true}).focus();await page.keyboard.press('Enter');await expect(dialog).toBeHidden();
  const transparentCommand=commands.find(command=>command.body.type==='CreateDocument');expect(transparentCommand).toBeTruthy();
  const transparent=(await read('/api/v1/documents/'+transparentCommand.documentId)).projection.value;expect(transparent.metadata).toEqual({schemaVersion:1,name:'Transparent Café e\u0301',creationBackground:{kind:'transparent'}});expect(transparent.orderedLayerIds).toEqual([]);await expect(page.getByRole('treeitem')).toHaveCount(0);
  await expect(page.getByRole('region',{name:'Canvas · image import drop target',exact:true})).toHaveAccessibleDescription(/Transparent Café e\u0301/);await expect(page.getByLabel('Document raster preview',{exact:true})).toHaveAccessibleDescription(/Transparent Café e\u0301/);
  await prepareNativePNG(page);const clearPNG=await local.download('transparent.png');expect(await sharp(clearPNG.bytes).ensureAlpha().raw().toBuffer()).toEqual(rgba([0,0,0,0]));

  await click(page,'New');await expect(dialog).toBeVisible();await title.fill('Solid 東京');await field(page,'Width (px)','3');await field(page,'Height (px)','2');await background.selectOption('solid');
  await editorContent(page).getByRole('textbox',{name:'Background color (opaque sRGB hex)',exact:true}).fill('#1153C9');await editorContent(page).getByRole('button',{name:'Create',exact:true}).click();await expect(dialog).toBeHidden();
  const creation=commands.filter(command=>command.body.type==='CreateDocument').at(-1);expect(creation.body).toEqual({type:'CreateDocument',name:'Solid 東京',width:3,height:2,background:{kind:'solid',color}});
  const document=(await read('/api/v1/documents/'+creation.documentId)).projection.value,image=await read('/api/v1/documents/'+document.id+'/image');
  expect(image.layers).toHaveLength(1);const layer=image.layers[0];expect(document.metadata).toEqual({schemaVersion:1,name:'Solid 東京',creationBackground:{kind:'solid',color,layerId:layer.id}});expect(layer.locked).toBe(false);await expect(page.getByRole('region',{name:'Canvas · image import drop target',exact:true})).toHaveAccessibleDescription(/Solid 東京/);
  await expect(page.getByRole('treeitem',{name:'Image · Background · visible',exact:true})).toBeVisible();await prepareNativePNG(page);const solidPNG=await local.download('solid.png'),decoded=await sharp(solidPNG.bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});expect([decoded.info.width,decoded.info.height]).toEqual([3,2]);expect(decoded.data).toEqual(rgba(color));
  await click(page,'Save copy');await expect(page.getByRole('dialog',{name:'Save project copy',exact:true})).toBeVisible();await click(page,'Prepare complete copy');await expect(page.getByRole('region',{name:'Prepared file',exact:true})).toBeVisible();const saved=await local.download('named-background.ideogram-project');
  await local.restart();await click(page,'Open');await page.getByRole('button',{name:new RegExp('^Restore '+creation.sessionId+' · document '+document.id+' · sequence ')}).click();await expect(page.getByRole('dialog',{name:'Open document',exact:true})).toBeHidden();
  expect((await read('/api/v1/documents/'+document.id)).projection.value.metadata).toEqual(document.metadata);await expect(page.getByRole('treeitem',{name:'Image · Background · visible',exact:true})).toBeVisible();await prepareNativePNG(page);expect(await sharp((await local.download('restarted.png')).bytes).ensureAlpha().raw().toBuffer()).toEqual(rgba(color));
  await click(page,'Open');await page.getByLabel('Open portable project',{exact:true}).setInputFiles(saved.path);await expect(page.getByRole('dialog',{name:'Review portable project',exact:true})).toBeVisible();await click(page,'Apply reviewed result');await expect(page.getByText('ImportBundle accepted and saved locally.',{exact:true})).toBeVisible();
  const importCommand=commands.filter(command=>command.body.type==='ImportBundle').at(-1),receipt=(await read('/api/v1/commands/'+importCommand.commandId)).receipt;expect(receipt.status).toBe('accepted');expect(receipt.commandId).toBe(importCommand.commandId);const imported=(await local.importedEvent(receipt)).payload.document;
  expect(imported.id).not.toBe(document.id);const importedImage=await read('/api/v1/documents/'+imported.id+'/image');expect(imported.metadata).toEqual({schemaVersion:1,name:'Solid 東京',creationBackground:{kind:'solid',color,layerId:importedImage.layers[0].id}});expect(importedImage.layers[0].id).not.toBe(layer.id);
  await prepareNativePNG(page);expect(await sharp((await local.download('imported.png')).bytes).ensureAlpha().raw().toBuffer()).toEqual(rgba(color));expect(commands.filter(command=>command.body.type==='CreateDocument')).toHaveLength(2);
  await record('j1-round-trip',{transparent,document,imported,sourceLayer:layer.id,importedLayer:importedImage.layers[0].id,exactRGBA:color,createdCommands:commands.filter(command=>command.body.type==='CreateDocument').map(command=>command.commandId),providerEffects:'Verified by fixture zero-effects guard'});
});

test('J1 validation and unavailable durable creation preserve the exact dialog draft',async({local})=>{
  const {page,commands,record}=local;await click(page,'New');const dialog=page.getByRole('dialog',{name:'New document',exact:true});await expect(dialog).toBeVisible();const title=editorContent(page).getByRole('textbox',{name:'Document name',exact:true});
  await title.fill('Retain this draft 東京');await field(page,'Width (px)','0');await field(page,'Height (px)','2');await editorContent(page).getByRole('combobox',{name:'Background',exact:true}).selectOption('solid');const colorInput=editorContent(page).getByRole('textbox',{name:'Background color (opaque sRGB hex)',exact:true});await colorInput.fill('#1153C9');
  await editorContent(page).getByRole('button',{name:'Create',exact:true}).click();const summary=editorContent(page).getByRole('region',{name:'New document needs attention',exact:true});await expect(summary).toBeVisible();await expect(editorContent(page).getByRole('spinbutton',{name:'Width (px)',exact:true})).toBeFocused();expect(commands.filter(command=>command.body.type==='CreateDocument')).toHaveLength(0);
  await summary.getByRole('link',{name:/width/i}).click();await expect(editorContent(page).getByRole('spinbutton',{name:'Width (px)',exact:true})).toBeFocused();await field(page,'Width (px)','3');
  await expect(title).toHaveValue('Retain this draft 東京');await expect(colorInput).toHaveValue('#1153C9');
  const restore=await local.rejectNextCreation();try{
    await editorContent(page).getByRole('button',{name:'Create',exact:true}).click();await expect(dialog).toBeVisible();await expect(summary).toBeVisible();await expect(summary).toContainText('Your dialog draft is retained.');await expect(summary).toBeFocused();
    await expect(title).toHaveValue('Retain this draft 東京');await expect(editorContent(page).getByRole('spinbutton',{name:'Width (px)',exact:true})).toHaveValue('3');await expect(editorContent(page).getByRole('spinbutton',{name:'Height (px)',exact:true})).toHaveValue('2');await expect(editorContent(page).getByRole('combobox',{name:'Background',exact:true})).toHaveValue('solid');await expect(colorInput).toHaveValue('#1153C9');
    const failed=commands.find(command=>command.body.type==='CreateDocument');expect(failed).toBeTruthy();
    const lookup=await local.receiptStatus(failed.commandId);expect(lookup.status).toBe(404);await expect(editorContent(page).getByRole('button',{name:'Create',exact:true})).toBeDisabled();
    await record('j1-failed-dialog',{request:failed,lookup,draftRetained:true,limitation:'One explicit test-owned HTTP503 before writer dispatch; actual preparation corruption/crash behavior is covered by document-creation.test.mjs. No disk-full qualification claimed.'});
  }finally{await restore();}
});
