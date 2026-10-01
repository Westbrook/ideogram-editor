import {specReceipt} from './receipt-path.js';
import {test,expect,type Page} from '@playwright/test';
import {mkdtemp,realpath,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {serverProcess} from './process.js';
import {publicReadRequest} from '../request/persistence-witness.js';
import {prepareNativePNG} from './export-workflow.js';

const click=(page:Page,name:string)=>page.getByRole('button',{name,exact:true}).click();
const field=async(page:Page,name:string,value:string)=>{const control=page.getByRole('spinbutton',{name,exact:true});await control.fill(value);await control.press('Tab');};

test('J6 actual selected JPEG preview, deliberate resize, immutable confirmation and cancel',async({page,browserName})=>{
 const directory=await mkdtemp(join(await realpath(tmpdir()),'ie-export-')),server=await serverProcess(join(directory,'private'));
 const commands:any[]=[],errors:string[]=[],external:string[]=[];
 page.on('pageerror',error=>errors.push(error.message));
 page.on('request',request=>{const url=new URL(request.url());if(['http:','https:'].includes(url.protocol)&&url.origin!==server.origin)external.push(url.origin);if(url.pathname==='/api/v1/commands'&&request.method()==='POST')commands.push(request.postDataJSON().command);});
 try{
  await page.goto(await server.pair());await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();
  await click(page,'Import image');await page.locator('en-file-upload[label="Image file"] input[type=file]').setInputFiles('tests/raster/fixtures/hidden-alpha.png');await click(page,'Apply reviewed result');await expect(page.getByText('ImportAsset accepted and saved locally.',{exact:true})).toBeVisible();
  await page.getByRole('treeitem').first().click();await prepareNativePNG(page);
  const prior=await page.getByRole('region',{name:'Prepared file'}).textContent();
  await click(page,'Export image');const dialog=page.getByRole('dialog',{name:'Export image',exact:true});
  await dialog.getByRole('combobox',{name:'Export scope',exact:true}).selectOption('selected-layers');
  await dialog.getByRole('combobox',{name:'Export format',exact:true}).selectOption('jpeg');
  await expect(dialog.getByRole('spinbutton',{name:'JPEG quality (0.01–1)',exact:true})).toHaveValue('0.9');
  const matte=dialog.getByRole('textbox',{name:'Opaque sRGB matte (#RRGGBB)',exact:true});await matte.fill('#123456');await matte.press('Tab');
  await dialog.getByRole('combobox',{name:'Export dimensions',exact:true}).selectOption('resize');await field(page,'Export width (px)','6');await field(page,'Export height (px)','4');
  const start=commands.length;await click(page,'Prepare export preview');await expect(page.locator('#export-preview')).toBeVisible();await expect(page.getByRole('button',{name:'Confirm reviewed export',exact:true})).toBeEnabled();
  expect(commands.slice(start).map(command=>command.body.type)).toEqual(['ExportDocument']);
  const command=commands.at(-1);expect(command.body.options).toEqual({format:'jpeg',matte:'#123456',quality:0.9,resize:{width:6,height:4},scope:{kind:'selected-layers',layerIds:expect.any(Array),includeHidden:false}});expect(command.body.options.scope.layerIds).toHaveLength(1);
  const jpeg=Buffer.from(await page.locator('#export-preview').evaluate(async node=>[...new Uint8Array(await(await fetch((node as HTMLImageElement).src)).arrayBuffer())]));
  const decoded=await sharp(jpeg).ensureAlpha().raw().toBuffer({resolveWithObject:true});expect(decoded.info.width).toBe(6);expect(decoded.info.height).toBe(4);expect(decoded.data.filter((_value,index)=>index%4===3).every(alpha=>alpha===255)).toBe(true);expect((await sharp(jpeg).metadata()).format).toBe('jpeg');
  await expect(page.locator('#export-review')).toContainText('Opaque matte #123456; quality 0.9');
  const prepared=commands.length;await click(page,'Confirm reviewed export');await expect(dialog).toBeHidden();expect(commands.length).toBe(prepared);
  const ready=page.getByRole('region',{name:'Prepared file'});await expect(ready).toContainText('JPEG');await expect(ready).toContainText('Ready');expect(await ready.textContent()).not.toEqual(prior);
  const retained=await ready.textContent();await click(page,'Export image');await click(page,'Prepare export preview');await expect(page.getByRole('button',{name:'Confirm reviewed export',exact:true})).toBeEnabled();await dialog.getByRole('button',{name:'Cancel',exact:true}).click();await expect(dialog).toBeHidden();expect(await ready.textContent()).toBe(retained);
  const document:any=await page.evaluate(async request=>(await fetch(request.path,request.init)).json(),publicReadRequest('/api/v1/documents/'+command.documentId));
  expect(document.projection.value.revision).toBe(command.expectedDocumentRevision);expect(document.projection.value.historyHead).toBe(command.body.historyHead);
  expect(Object.values(await server.effects())).toEqual(Array(8).fill(0));expect(errors).toEqual([]);expect(external).toEqual([]);
  const receipt=specReceipt(import.meta.url,'artifacts/p1b7/current');await mkdir(receipt,{recursive:true});await writeFile(join(receipt,'export-jpeg-'+browserName+'.jpg'),jpeg);await writeFile(join(receipt,'export-j6-'+browserName+'.json'),JSON.stringify({browserName,commands:commands.filter(command=>command.body.type==='ExportDocument'),actualJPEG:{width:decoded.info.width,height:decoded.info.height,opaque:true,bytes:jpeg.length},noReencodeOnConfirm:true,priorPreparedFileSurvivesCancel:true,documentRevisionUnchanged:true,providerEffects:await server.effects()},null,2));
 }finally{await page.close();await server.close();}
});
