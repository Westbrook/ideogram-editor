import{test,expect}from'@playwright/test';
import{mkdtemp,realpath,rm,readFile}from'node:fs/promises';
import{tmpdir}from'node:os';
import{join,resolve}from'node:path';
import{pathToFileURL}from'node:url';
const{startLocalServer}=await import(pathToFileURL(resolve('dist/local/server/http.js')).href);
test('actual decoded conversion preview, explicit en-reve approval, canonical recovery projection and PNG content',async({page,context})=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'raster-browser-'));const server=await startLocalServer({root,staticDirectory:resolve(process.env.IE_RASTER_APP??resolve(process.env.IE_RASTER_OUTPUT??'artifacts/p1b4','browser-app'))});
 try{await context.route('**/*',route=>{if(new URL(route.request().url()).hostname!=='127.0.0.1')throw Error('Nonlocal request denied');return route.continue();});await page.goto(server.issuePairingURL());await expect(page.locator('#state')).toHaveText('Raster consumer ready');
  const bytes=[...await readFile('tests/raster/fixtures/p3-color.png')];const preview=await page.evaluate(async bytes=>{const h=(window as any).harness;const a=await h.upload(bytes,'image/png');return h.review(a.id);},bytes);
  expect(preview.asset.qualification).toBe('raster-preview');expect(preview.review.conversion.colorChanged).toBe(true);await expect(page.locator('#state')).toHaveText('Conversion ready for review');
  expect(await page.locator('#preview').evaluate((img:HTMLImageElement)=>({width:img.naturalWidth,height:img.naturalHeight,complete:img.complete}))).toEqual({width:4,height:1,complete:true});expect(await page.evaluate(()=>(window as any).harness.approved)).toBeNull();
  await page.screenshot({path:resolve(process.env.IE_RASTER_OUTPUT??'evidence/p1b4','conversion-review.png')});await page.getByRole('button',{name:'Approve converted raster'}).click();await expect(page.locator('#state')).toHaveText('Canonical raster approved');
  const accepted=await page.evaluate(async()=>{const h=(window as any).harness;return{asset:h.approved,cached:await h.cache.read('asset',h.approved.id)};});expect(accepted.asset.blob).toEqual(preview.asset.blob);expect(accepted.asset.raster.pixelIdentity).toEqual(preview.asset.raster.pixelIdentity);expect(accepted.cached).toEqual(accepted.asset);
  await page.screenshot({path:resolve(process.env.IE_RASTER_OUTPUT??'evidence/p1b4','conversion-approved.png')});
 }finally{await server.close();await rm(root,{recursive:true,force:true});}
});
