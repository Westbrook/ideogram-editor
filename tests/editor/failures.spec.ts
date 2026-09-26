import {test,expect} from '@playwright/test';
import {mkdtemp,realpath,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {startLocalServer}=await import(pathToFileURL(resolve('dist/local/server/http.js')).href);
const click=(p:any,name:string)=>p.getByRole('button',{name,exact:true}).click();
test('malformed portable file is rejected visibly without document acceptance; lost command delivery reuses its exact body',async({page})=>{
 const directory=await mkdtemp(join(await realpath(tmpdir()),'ie-fault-')),server=await startLocalServer({root:join(directory,'private'),staticDirectory:resolve('dist/app')});
 try{
 await page.goto(server.issuePairingURL());await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();await click(page,'Open');await page.locator('en-file-upload[label="Open portable project"] input[type=file]').setInputFiles({name:'bad.ideogram-project',mimeType:'application/octet-stream',buffer:Buffer.from('not a ZIP64 project')});await expect(page.getByRole('heading',{name:'Action needs attention',exact:true})).toBeVisible();await expect(page.getByText('No document open',{exact:true})).toBeVisible();await click(page,'Cancel');
 // Drop only the receipt after the real writer sees and accepts this exact envelope.
 let first='';const bodies:string[]=[];await page.route('**/api/v1/commands',async route=>{const text=route.request().postData()!,body=JSON.parse(text);if(body.command.body.type==='NewDocument'){bodies.push(text);if(!first){first=text;await route.fetch();await route.abort('failed');return;}}await route.continue();});
 await click(page,'New');await click(page,'Create');await expect(page.getByRole('heading',{name:'Action needs attention',exact:true})).toBeVisible();await click(page,'Cancel');await expect(page.getByRole('button',{name:'Check and retry original',exact:true})).toBeVisible();await click(page,'Check and retry original');await expect(page.getByText('NewDocument accepted and saved locally.',{exact:true})).toBeVisible();expect(bodies).toEqual([first]);await page.unroute('**/api/v1/commands');
 await click(page,'Open');await expect(page.getByRole('button',{name:/ · 1024 × 1024 · revision 1$/})).toHaveCount(1);
 }finally{await server.close();}
});

test('renewal expires unaccepted review and preserves original bytes without creating a document',async({page})=>{
 const directory=await mkdtemp(join(await realpath(tmpdir()),'ie-expiry-'));let now=Date.now();const server=await startLocalServer({root:join(directory,'private'),staticDirectory:resolve('dist/app'),now:()=>now});
 try{await page.goto(server.issuePairingURL());await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();await page.locator('en-file-upload input[type=file]').setInputFiles('tests/raster/fixtures/hidden-alpha.png');await expect(page.getByRole('dialog',{name:'Review image conversion'})).toBeVisible();now+=31*60*1000;await click(page,'Apply reviewed result');await expect(page.getByRole('heading',{name:'Action needs attention',exact:true})).toBeVisible();await expect(page.getByText('No document open',{exact:true})).toBeVisible();
 await click(page,'Cancel review');await click(page,'Connected locally');await click(page,'Check connection');await expect(page.getByText(/Connection expired or unavailable/).first()).toBeVisible();await page.goto(server.issuePairingURL());await click(page,'Close');await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();await expect(page.getByRole('dialog',{name:'Review image conversion'})).toHaveCount(0);
 }finally{await server.close();}
});

test('native composition drafts do not dispatch document actions and a late veto cancels Apply',async({page})=>{
 const directory=await mkdtemp(join(await realpath(tmpdir()),'ie-composition-')),server=await startLocalServer({root:join(directory,'private'),staticDirectory:resolve('dist/app')});const edits:string[]=[];
 try{page.on('request',r=>{if(new URL(r.url()).pathname==='/api/v1/commands'&&r.method()==='POST')edits.push(JSON.parse(r.postData()!).command.body.type);});await page.goto(server.issuePairingURL());await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();await page.locator('en-file-upload input[type=file]').setInputFiles('tests/raster/fixtures/hidden-alpha.png');await click(page,'Apply reviewed result');await expect(page.getByText('ImportAsset accepted and saved locally.',{exact:true})).toBeVisible();await page.getByRole('treeitem').click();const name=page.getByRole('textbox',{name:'Layer name',exact:true});await name.focus();await name.evaluate((input:any)=>{input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,composed:true}));input.value='日本語 draft';input.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,inputType:'insertCompositionText',data:'日本語 draft',isComposing:true}));});await expect(page.getByRole('button',{name:'Apply properties',exact:true})).toBeDisabled();await name.press('Meta+z');expect(edits).not.toContain('Undo');await name.evaluate(input=>input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,composed:true})));await name.fill('fresh Unicode 🌿');
 await page.locator('en-button').filter({hasText:'Apply properties'}).evaluate(host=>host.addEventListener('click',e=>e.preventDefault(),{once:true}));await click(page,'Apply properties');await page.waitForTimeout(100);expect(edits).not.toContain('SetLayerProperties');await expect(name).toHaveValue('fresh Unicode 🌿');
 }finally{await server.close();}
});
