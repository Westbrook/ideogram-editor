# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: portable.spec.ts >> E1 browser copy, actual process restart/new port, reviewed reopen and exact downloaded PNG
- Location: ../ideogram-edit-verification/webkit-rail-author/04-restart-diagnostic-source/portable.spec.ts:15:1

# Error details

```
Error: expect(received).toEqual(expected) // deep equality

- Expected  - 1
+ Received  + 6

- Array []
+ Array [
+   "Failed to load resource: The network connection was lost.",
+   "Failed to load resource: The network connection was lost.",
+   "Failed to load resource: Could not connect to the server.",
+   "Failed to load resource: Could not connect to the server.",
+ ]
```

# Test source

```ts
  1  | import {test as base,webkit,expect,type Page} from '@playwright/test';
  2  | import {mkdtemp,realpath,readFile,writeFile} from 'node:fs/promises';
  3  | import {tmpdir} from 'node:os';
  4  | import {join} from 'node:path';
  5  | import sharp from 'sharp';
  6  | import {serverProcess} from '/Users/westbrook/Documents/repos/ideogram-edit/tests/editor/process.js';
  7  | // Test archive reader is independent of the browser adapter; small fixture only.
  8  | // @ts-ignore
  9  | import {unpack,records} from '/Users/westbrook/Documents/repos/ideogram-edit/tests/portable/archive-fixture.mjs';
  10 | const test=base.extend({context:async({contextOptions},use)=>{const profile=await mkdtemp(join(await realpath(tmpdir()),'ie-persistent-e1-'));const context=await webkit.launchPersistentContext(profile,{...contextOptions,viewport:{width:1440,height:1000}});try{await use(context);}finally{await context.close();}}});
  11 | const accepted=(page:Page,type:string)=>expect(page.getByText(type+' accepted and saved locally.',{exact:true})).toBeVisible();
  12 | const click=(page:Page,name:string)=>page.getByRole('button',{name,exact:true}).click();
  13 | const receipt=process.env.EDITOR_RECEIPT??'artifacts/p1b7/current';
  14 | async function download(page:Page,path:string){const received=page.waitForEvent('download');await click(page,'Download prepared file');await (await received).saveAs(path);await expect(page.getByText(/External destination remains unconfirmed/)).toBeVisible();}
  15 | test('E1 browser copy, actual process restart/new port, reviewed reopen and exact downloaded PNG',async({page,context})=>{
  16 |  const directory=await mkdtemp(join(await realpath(tmpdir()),'ie-browser-e1-')),root=join(directory,'private');let server=await serverProcess(root);const errors:string[]=[],requests:string[]=[],expectedFailures:string[]=[];let disrupting=false;const consoleEvidence:any[]=[];test.info().annotations.push({type:'runtime',description:'unchanged e392 build; rail source edits unbuilt'});
  17 |  await context.addInitScript(()=>Object.defineProperty(window,'showSaveFilePicker',{value:undefined,configurable:true}));
  18 |  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'){const location=m.location();consoleEvidence.push({text:m.text(),disrupting,origin:server.origin,location:{url:location.url?new URL(location.url).origin+new URL(location.url).pathname:'',lineNumber:location.lineNumber,columnNumber:location.columnNumber}});if(disrupting&&/ERR_INCOMPLETE_CHUNKED_ENCODING|ERR_CONNECTION_REFUSED|ERR_EMPTY_RESPONSE/.test(m.text()))expectedFailures.push(m.text());else errors.push(m.text());}});
  19 |  page.on('request',r=>{const u=new URL(r.url());if(u.protocol!=='blob:'){requests.push(u.pathname);expect(u.hostname).toBe('127.0.0.1');}});
  20 |  try{
  21 |  await page.goto(await server.pair());await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();disrupting=false;
  22 |  await page.locator('en-file-upload input[type=file]').setInputFiles('tests/raster/fixtures/hidden-alpha.png');await expect(page.getByRole('dialog',{name:'Review image conversion'})).toBeVisible();await click(page,'Apply reviewed result');await accepted(page,'ImportAsset');
  23 |  await page.getByRole('treeitem').first().click();await page.getByRole('spinbutton',{name:'Opacity (0–1)',exact:true}).fill('0.5');await click(page,'Apply properties');await accepted(page,'SetLayerProperties');await click(page,'Undo');await accepted(page,'Undo');
  24 |  await page.getByRole('textbox',{name:'Prompt',exact:true}).fill('日本語 🌿 retained unapplied prompt');await page.getByRole('textbox',{name:'Prompt',exact:true}).blur();await expect(page.getByText('Draft saved locally; not applied to the document').first()).toBeVisible();
  25 |  await page.getByRole('textbox',{name:'Checkpoint name',exact:true}).fill('Before copy');await click(page,'Save checkpoint');await accepted(page,'SaveCheckpoint');
  26 |  await click(page,'Save copy');await click(page,'Prepare complete copy');await expect(page.getByRole('region',{name:'Prepared file'})).toBeVisible();
  27 |  const bundlePath=join(directory,'project.ideogram-project');await download(page,bundlePath);const entries=await unpack(directory,await readFile(bundlePath)),all=records(entries).values;
  28 |  const events=records(entries,'events').values.map((x:any)=>x.event);expect(events.some((e:any)=>e.type==='HistoryNavigated')).toBe(true);expect(events.some((e:any)=>e.type==='CheckpointSaved')).toBe(true);
  29 |  const entities=all.filter((x:any)=>x.kind==='entity').map((x:any)=>({kind:x.entityType,value:JSON.parse(entries.get('objects/'+x.payloadRef.hash.slice(7)))}));
  30 |  expect(entities.filter((x:any)=>x.kind==='history').length).toBe(3);expect(entities.filter((x:any)=>x.kind==='checkpoint').length).toBe(1);expect(entities.some((x:any)=>x.kind==='draft')).toBe(true);
  31 |  const originalPixels=await sharp('tests/raster/fixtures/hidden-alpha.png').ensureAlpha().raw().toBuffer();
  32 |  const effects=await server.effects();expect(Object.values(effects).every(v=>v===0)).toBe(true);const oldOrigin=server.origin,oldPid=server.pid;disrupting=true;await server.kill();
  33 |  server=await serverProcess(root);expect(server.pid).not.toBe(oldPid);expect(server.origin).not.toBe(oldOrigin);await page.goto(await server.pair());await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();disrupting=false;
  34 |  expect(await page.evaluate(async()=> (await indexedDB.databases()).filter(d=>d.name?.startsWith('ie-delivery-')).length)).toBe(1);
  35 |  await click(page,'Open');await page.getByRole('button',{name:/^Restore ui_/}).click();await expect(page.getByRole('textbox',{name:'Prompt',exact:true})).toHaveValue('日本語 🌿 retained unapplied prompt');
  36 |  await click(page,'Open');await page.locator('en-file-upload').filter({has:page.getByText('Open portable project',{exact:true})}).locator('input[type=file]').setInputFiles(bundlePath);
  37 |  await expect(page.getByRole('dialog',{name:'Review portable project'})).toBeVisible();await click(page,'Apply reviewed result');await accepted(page,'ImportBundle');
  38 |  await click(page,'Export image');await expect(page.getByRole('region',{name:'Prepared file'})).toContainText('Exact PNG');const pngPath=join(directory,'image.png');await download(page,pngPath);expect(await sharp(pngPath).ensureAlpha().raw().toBuffer()).toEqual(originalPixels);
  39 |  disrupting=true;await server.kill();server=await serverProcess(root);await page.goto(await server.pair());await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();disrupting=false;
  40 |  await click(page,'Open');const mapped=page.getByRole('button',{name:/^Restore p_/});await expect(mapped).not.toHaveCount(0);
  41 |  await mapped.click();await expect(page.getByRole('textbox',{name:'Prompt',exact:true})).toHaveValue('日本語 🌿 retained unapplied prompt');
  42 |  await click(page,'Save copy');await click(page,'Prepare complete copy');const nestedPath=join(directory,'nested.ideogram-project');await download(page,nestedPath);const nested=await readFile(nestedPath);expect(nested.includes(await readFile(bundlePath))).toBe(true);
  43 |  // New drafts on mapped IDs must obey the same bounded ID contract. Existing
  44 |  // mapped saved drafts retain their original identities and exact text.
  45 |  const newDrafts:any[]=[];page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/v1/ui/')&&r.method()==='POST'){const b=JSON.parse(r.postData()!).body;if(b.type==='SaveDraft'&&b.draft.kind==='inspector')newDrafts.push(b.draft);}});
  46 |  await page.getByRole('treeitem').first().click();await page.getByRole('textbox',{name:'Layer name',exact:true}).fill('Editable after portable reopen');await click(page,'Apply properties');await accepted(page,'SetLayerProperties');expect(newDrafts.length).toBeGreaterThan(0);expect(newDrafts.every(d=>d.id.length<=128&&d.documentId.startsWith('p_')&&d.targetLayerId.startsWith('p_'))).toBe(true);await page.reload();await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();await expect(page.getByRole('treeitem',{name:'Editable after portable reopen · visible'})).toBeVisible();
> 47 |  await expect(page.getByText(/Updates interrupted/)).toHaveCount(0);expect(errors).toEqual([]);expect(Object.values(await server.effects()).every(v=>v===0)).toBe(true);
     |                                                                                    ^ Error: expect(received).toEqual(expected) // deep equality
  48 |  await writeFile(join(receipt,'e1.json'),JSON.stringify({expectedFailures,oldPid,newPid:server.pid,oldOrigin,newOrigin:server.origin,networkPaths:[...new Set(requests)],providerEffects:effects,downloadedBundleBytes:(await readFile(bundlePath)).length,sourceEvents:events.length,sourceEntities:entities.length,exactPixels:true,externalDestination:'unconfirmed',osPicker:'not exercised; real browser fallback download tested'},null,2));
  49 |  await page.screenshot({path:join(receipt,'e1.png')});
  50 |  }finally{await writeFile(join(receipt,'console-evidence.json'),JSON.stringify(consoleEvidence,null,2));await server.close();}
  51 | });
  52 | 
```