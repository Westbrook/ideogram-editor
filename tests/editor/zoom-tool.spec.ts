// Authored for the real browser fixture; not executed in the source-only staging lane.
import {test as base,expect,type Page} from '@playwright/test';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {serverProcess} from './process.js';
import {ownedOPFS} from './owned-opfs.js';
import {confirmImageImports} from './image-import-flow.js';
const test=base.extend({context:async({playwright,browserName,contextOptions,viewport},use)=>{
 const profile=browserName==='webkit'?await mkdtemp(join(await realpath(tmpdir()),'ie-zoom-webkit-')):undefined;
 const browser=profile?undefined:await playwright[browserName].launch();
 const context=profile?await playwright.webkit.launchPersistentContext(profile,{...contextOptions,viewport}):await browser!.newContext({...contextOptions,viewport});
 await Promise.all(context.pages().map(page=>page.close()));
 try{await use(context);}finally{await context.close();await browser?.close();if(profile)await rm(profile,{recursive:true,force:true});}
}});
const click=(page:Page,name:string)=>page.getByRole('button',{name,exact:true}).click();
const viewport=(page:Page)=>page.evaluate(()=>{
 const mark=performance.getEntriesByName('ie.viewport.drawn').at(-1) as PerformanceMark|undefined;
 if(!mark)throw Error('No actual canvas viewport submission');return mark.detail as {zoom:number;x:number;y:number};
});
test('Zoom pointer clicks keep their exact canvas anchor, Alt reverses the step, and drag never falls through to Pan',async({page,context,browserName})=>{
 const guard=await ownedOPFS(context,'zoom-tool-'+browserName),dir=await mkdtemp(join(await realpath(tmpdir()),'ie-zoom-tool-')),server=await serverProcess(join(dir,'private'));
 try{
  await guard.admit(page,server.origin);await page.goto(await server.pair());await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();
  await page.locator('.canvas-empty en-file-upload input[type=file]').setInputFiles('tests/raster/fixtures/hidden-alpha.png');await confirmImageImports(page,{names:['hidden-alpha.png'],destination:'new',close:false});await expect(page.getByText('ImportAsset accepted and saved locally.',{exact:true})).toBeVisible();const importControls=page.locator('en-dialog#editor-dialog');await importControls.getByRole('button',{name:'Open imported document',exact:true}).click();await expect(page.locator('canvas[data-asset]')).not.toHaveAttribute('data-asset','');await importControls.getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.getByRole('dialog',{name:'Import image',exact:true})).toBeHidden();await click(page,'100%');await click(page,'Zoom');
  const canvas=page.getByLabel('Document raster preview',{exact:true}),box=(await canvas.boundingBox())!,x=box.x+box.width*.62,y=box.y+box.height*.43,before=await viewport(page),revision=await page.locator('.document-name').textContent();
  await page.mouse.click(x,y);await expect(page.getByRole('spinbutton',{name:'Zoom percentage',exact:true})).toHaveValue('110');const after=await viewport(page);
  expect(after.zoom).toBeCloseTo(before.zoom*1.1,12);
  expect((x-box.x-box.width/2-after.x)/after.zoom).toBeCloseTo((x-box.x-box.width/2-before.x)/before.zoom,10);
  expect((y-box.y-box.height/2-after.y)/after.zoom).toBeCloseTo((y-box.y-box.height/2-before.y)/before.zoom,10);
  await page.keyboard.down('Alt');try{await page.mouse.click(x,y);}finally{await page.keyboard.up('Alt');}await expect(page.getByRole('spinbutton',{name:'Zoom percentage',exact:true})).toHaveValue('100');const reversed=await viewport(page);
  expect(reversed.zoom).toBeCloseTo(before.zoom,12);expect(reversed.x).toBeCloseTo(before.x,10);expect(reversed.y).toBeCloseTo(before.y,10);
  await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+15,y+8);await page.mouse.up();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));expect(await viewport(page)).toEqual(reversed);
  await page.mouse.move(x,y);await page.mouse.down();await page.locator('#canvas').focus();await page.keyboard.press('Escape');await page.mouse.up();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));expect(await viewport(page)).toEqual(reversed);
  await click(page,'Pan');await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+12,y+6);await page.mouse.up();const panned=await viewport(page);expect(panned.zoom).toBe(reversed.zoom);expect(panned.x).toBeCloseTo(reversed.x+12,10);expect(panned.y).toBeCloseTo(reversed.y+6,10);
  await page.getByRole('button',{name:'100%',exact:true}).focus();await page.keyboard.press('Enter');await expect(page.getByRole('spinbutton',{name:'Zoom percentage',exact:true})).toHaveValue('100');expect(await page.locator('.document-name').textContent()).toBe(revision);expect(Object.values(await server.effects()).every(value=>value===0)).toBe(true);
 }finally{try{await guard.cleanup();guard.verify();}finally{await server.close();await rm(dir,{recursive:true,force:true});}}
});
