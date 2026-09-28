import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {restoredRouteFlow} from './completion/restored-route-flow.mjs';
import {test,expect,fixture,click,rows,state} from './integration-fixture.js';

test('restored canvas and prompt issue one image read and preserve real gesture cancellation',async({page,context,browserName})=>{
 const f=await fixture(page,context,browserName,'restored-reads');let primaryError:unknown;let routeFlow:ReturnType<typeof restoredRouteFlow>|undefined;
 try{
  await f.admit();await page.locator('.canvas-empty en-file-upload input').setInputFiles('tests/raster/fixtures/hidden-alpha.png');await click(page,'Apply reviewed result');await expect(page.getByText('ImportAsset accepted and saved locally.',{exact:true})).toBeVisible();
  const before=await state(f.root),asset=before.document.image.compositeAssetId,canvas=page.locator('canvas');await expect(canvas).toHaveAttribute('data-asset',asset);
  await page.getByRole('textbox',{name:'Prompt',exact:true}).fill('Restore this exact saved prompt');await page.getByRole('textbox',{name:'Prompt',exact:true}).blur();await expect(page.getByText('Draft saved locally; not applied to the document',{exact:true}).first()).toBeVisible();
  const saved=rows(f.root,'ui_checkpoints').find(u=>u.preferences.documentId===before.document.id&&u.drafts.some((d:any)=>d.kind==='prompt'&&d.status==='saved-unapplied'));expect(saved).toBeDefined();
  // Hold only the original canvas requests before forwarding. Prompt recovery
  // and the ordinary UI render complete independently, exposing duplicate reads.
  const held:unknown[]=[],pattern='**/api/v1/assets/'+asset+'/content';
  const routeObserver=f.restoredRoute(pattern,'/api/v1/assets/'+asset+'/content');
  routeFlow=restoredRouteFlow({page,pattern,observer:routeObserver,onHold:(request:any)=>held.push({method:request.method(),url:request.url()})});await routeFlow.install();
  await f.restart();await click(page,'Open');await page.getByRole('button',{name:new RegExp('^Restore '+saved.sessionId+' ·')}).click();await expect(page.getByRole('textbox',{name:'Prompt',exact:true})).toHaveValue('Restore this exact saved prompt');await expect(page.getByRole('region',{name:'Operation status'})).toHaveAttribute('aria-busy','false');
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  await writeFile(join(f.out,'restored-reads.json'),JSON.stringify({document:before.document,session:saved.sessionId,originalHeldReads:held,originalPromptRestored:true},null,2));expect(held).toHaveLength(1);
  await routeFlow.release();await routeFlow.confirmRestored(async()=>{await expect(canvas).toHaveAttribute('data-asset',asset);expect((await state(f.root)).document).toEqual(before.document);});
  // Wait for a real transient Move raster before Escape, then prove the accepted
  // canvas and durable state return and a subsequent gesture still commits.
  await page.locator('#layer-tree').getByRole('treeitem').click();await click(page,'Move');await click(page,'100%');const box=(await canvas.boundingBox())!,x=box.x+box.width/2,y=box.y+box.height/2,transforms=f.commands.filter(c=>c.body.type==='ApplyTransform').length;
  await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+15,y+5);await expect(canvas).not.toHaveAttribute('data-asset',asset);const transient=await canvas.getAttribute('data-asset');await page.locator('#canvas').focus();await page.keyboard.press('Escape');await page.mouse.up();await expect(canvas).toHaveAttribute('data-asset',asset);expect((await state(f.root)).document).toEqual(before.document);expect(f.commands.filter(c=>c.body.type==='ApplyTransform')).toHaveLength(transforms);
  await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+1,y);await page.mouse.up();await expect(page.getByText('ApplyTransform accepted and saved locally.',{exact:true})).toBeVisible();expect(f.commands.filter(c=>c.body.type==='ApplyTransform')).toHaveLength(transforms+1);
  await writeFile(join(f.out,'gesture-cancellation.json'),JSON.stringify({accepted:asset,transient,restored:asset,before:before.document,afterNextGesture:(await state(f.root)).document,noCancelCommand:true},null,2));
 }catch(error){primaryError=error;}finally{if(routeFlow)primaryError=await routeFlow.cleanup(primaryError);await f.finish(primaryError);}
});
