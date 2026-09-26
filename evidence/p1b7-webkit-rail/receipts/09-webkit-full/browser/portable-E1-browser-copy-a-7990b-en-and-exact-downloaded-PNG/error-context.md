# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: portable.spec.ts >> E1 browser copy, actual process restart/new port, reviewed reopen and exact downloaded PNG
- Location: tests/editor/portable.spec.ts:23:1

# Error details

```
Error: expect(received).toEqual(expected) // deep equality

- Expected  - 1
+ Received  + 3

- Array []
+ Array [
+   "/127.0.0.1:63500/api/v1/events/stream?after=17 due to access control checks.",
+ ]
```

# Test source

```ts
  1  | import {test as base,webkit,expect,type Page} from '@playwright/test';
  2  | import {mkdtemp,realpath,readFile,writeFile} from 'node:fs/promises';
  3  | import {tmpdir} from 'node:os';
  4  | import {join} from 'node:path';
  5  | import sharp from 'sharp';
  6  | import {serverProcess} from './process.js';
  7  | import {expectedShutdownConsole} from './shutdown-console.js';
  8  | // Test archive reader is independent of the browser adapter; small fixture only.
  9  | // @ts-ignore
  10 | import {unpack,records} from '../portable/archive-fixture.mjs';
  11 | // WebKit's ephemeral contexts do not expose OPFS. Only this durable portable
  12 | // journey uses a fresh persistent profile; other tests retain ephemeral failure coverage.
  13 | const test=base.extend({context:async({context,browserName,contextOptions,viewport},use)=>{
  14 |  if(browserName!=='webkit'){await use(context);return;}
  15 |  const profile=await mkdtemp(join(await realpath(tmpdir()),'ie-webkit-e1-'));
  16 |  const persistent=await webkit.launchPersistentContext(profile,{...contextOptions,viewport});
  17 |  try{await use(persistent);}finally{await persistent.close();}
  18 | }});
  19 | const accepted=(page:Page,type:string)=>expect(page.getByText(type+' accepted and saved locally.',{exact:true})).toBeVisible();
  20 | const click=(page:Page,name:string)=>page.getByRole('button',{name,exact:true}).click();
  21 | const receipt=process.env.EDITOR_RECEIPT??'artifacts/p1b7/current';
  22 | async function download(page:Page,path:string){const received=page.waitForEvent('download');await click(page,'Download prepared file');await (await received).saveAs(path);await expect(page.getByText(/External destination remains unconfirmed/)).toBeVisible();}
  23 | test('E1 browser copy, actual process restart/new port, reviewed reopen and exact downloaded PNG',async({page,context,browserName})=>{
  24 |  const directory=await mkdtemp(join(await realpath(tmpdir()),'ie-browser-e1-')),root=join(directory,'private');let server=await serverProcess(root);const errors:string[]=[],requests:string[]=[],expectedFailures:string[]=[];let disrupting=false;const retiredOrigins=new Set<string>();const consoleObservations:{text:string;url:string;disrupting:boolean;retiredOrigin:boolean;expected:boolean}[]=[];
  25 |  await context.addInitScript(()=>Object.defineProperty(window,'showSaveFilePicker',{value:undefined,configurable:true}));
  26 |  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'){const url=m.location().url,expected=expectedShutdownConsole({browser:browserName,text:m.text(),url,disrupting,retiredOrigins});let safeUrl='',retiredOrigin=false;try{const parsed=new URL(url);safeUrl=parsed.origin+parsed.pathname;retiredOrigin=retiredOrigins.has(parsed.origin);}catch{}consoleObservations.push({text:m.text(),url:safeUrl,disrupting,retiredOrigin,expected});if(expected)expectedFailures.push(m.text());else errors.push(m.text());}});
  27 |  page.on('request',r=>{const u=new URL(r.url());if(u.protocol!=='blob:'){requests.push(u.pathname);expect(u.hostname).toBe('127.0.0.1');}});
  28 |  try{
  29 |  await page.goto(await server.pair());await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();disrupting=false;
  30 |  await page.locator('en-file-upload input[type=file]').setInputFiles('tests/raster/fixtures/hidden-alpha.png');await expect(page.getByRole('dialog',{name:'Review image conversion'})).toBeVisible();await click(page,'Apply reviewed result');await accepted(page,'ImportAsset');
  31 |  await page.getByRole('treeitem').first().click();await page.getByRole('spinbutton',{name:'Opacity (0–1)',exact:true}).fill('0.5');await click(page,'Apply properties');await accepted(page,'SetLayerProperties');await click(page,'Undo');await accepted(page,'Undo');
  32 |  await page.getByRole('textbox',{name:'Prompt',exact:true}).fill('日本語 🌿 retained unapplied prompt');await page.getByRole('textbox',{name:'Prompt',exact:true}).blur();await expect(page.getByText('Draft saved locally; not applied to the document').first()).toBeVisible();
  33 |  await page.getByRole('textbox',{name:'Checkpoint name',exact:true}).fill('Before copy');await click(page,'Save checkpoint');await accepted(page,'SaveCheckpoint');
  34 |  await click(page,'Save copy');await click(page,'Prepare complete copy');await expect(page.getByRole('region',{name:'Prepared file'})).toBeVisible();
  35 |  const bundlePath=join(directory,'project.ideogram-project');await download(page,bundlePath);const entries=await unpack(directory,await readFile(bundlePath)),all=records(entries).values;
  36 |  const events=records(entries,'events').values.map((x:any)=>x.event);expect(events.some((e:any)=>e.type==='HistoryNavigated')).toBe(true);expect(events.some((e:any)=>e.type==='CheckpointSaved')).toBe(true);
  37 |  const entities=all.filter((x:any)=>x.kind==='entity').map((x:any)=>({kind:x.entityType,value:JSON.parse(entries.get('objects/'+x.payloadRef.hash.slice(7)))}));
  38 |  expect(entities.filter((x:any)=>x.kind==='history').length).toBe(3);expect(entities.filter((x:any)=>x.kind==='checkpoint').length).toBe(1);expect(entities.some((x:any)=>x.kind==='draft')).toBe(true);
  39 |  const originalPixels=await sharp('tests/raster/fixtures/hidden-alpha.png').ensureAlpha().raw().toBuffer();
  40 |  const effects=await server.effects();expect(Object.values(effects).every(v=>v===0)).toBe(true);const oldOrigin=server.origin,oldPid=server.pid;disrupting=true;retiredOrigins.add(server.origin);await server.kill();
  41 |  server=await serverProcess(root);expect(server.pid).not.toBe(oldPid);expect(server.origin).not.toBe(oldOrigin);await page.goto(await server.pair());await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();disrupting=false;
  42 |  expect(await page.evaluate(async()=> (await indexedDB.databases()).filter(d=>d.name?.startsWith('ie-delivery-')).length)).toBe(1);
  43 |  await click(page,'Open');await page.getByRole('button',{name:/^Restore ui_/}).click();await expect(page.getByRole('textbox',{name:'Prompt',exact:true})).toHaveValue('日本語 🌿 retained unapplied prompt');
  44 |  await click(page,'Open');await page.locator('en-file-upload').filter({has:page.getByText('Open portable project',{exact:true})}).locator('input[type=file]').setInputFiles(bundlePath);
  45 |  await expect(page.getByRole('dialog',{name:'Review portable project'})).toBeVisible();await click(page,'Apply reviewed result');await accepted(page,'ImportBundle');
  46 |  await click(page,'Export image');await expect(page.getByRole('region',{name:'Prepared file'})).toContainText('Exact PNG');const pngPath=join(directory,'image.png');await download(page,pngPath);expect(await sharp(pngPath).ensureAlpha().raw().toBuffer()).toEqual(originalPixels);
  47 |  disrupting=true;retiredOrigins.add(server.origin);await server.kill();server=await serverProcess(root);await page.goto(await server.pair());await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();disrupting=false;
  48 |  await click(page,'Open');const mapped=page.getByRole('button',{name:/^Restore p_/});await expect(mapped).not.toHaveCount(0);
  49 |  await mapped.click();await expect(page.getByRole('textbox',{name:'Prompt',exact:true})).toHaveValue('日本語 🌿 retained unapplied prompt');
  50 |  await click(page,'Save copy');await click(page,'Prepare complete copy');const nestedPath=join(directory,'nested.ideogram-project');await download(page,nestedPath);const nested=await readFile(nestedPath);expect(nested.includes(await readFile(bundlePath))).toBe(true);
  51 |  // New drafts on mapped IDs must obey the same bounded ID contract. Existing
  52 |  // mapped saved drafts retain their original identities and exact text.
  53 |  const newDrafts:any[]=[];page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/v1/ui/')&&r.method()==='POST'){const b=JSON.parse(r.postData()!).body;if(b.type==='SaveDraft'&&b.draft.kind==='inspector')newDrafts.push(b.draft);}});
  54 |  await page.getByRole('treeitem').first().click();await page.getByRole('textbox',{name:'Layer name',exact:true}).fill('Editable after portable reopen');await click(page,'Apply properties');await accepted(page,'SetLayerProperties');expect(newDrafts.length).toBeGreaterThan(0);expect(newDrafts.every(d=>d.id.length<=128&&d.documentId.startsWith('p_')&&d.targetLayerId.startsWith('p_'))).toBe(true);await page.reload();await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();await expect(page.getByRole('treeitem',{name:'Editable after portable reopen · visible'})).toBeVisible();
> 55 |  await expect(page.getByText(/Updates interrupted/)).toHaveCount(0);expect(errors).toEqual([]);expect(Object.values(await server.effects()).every(v=>v===0)).toBe(true);
     |                                                                                    ^ Error: expect(received).toEqual(expected) // deep equality
  56 |  await writeFile(join(receipt,'e1.json'),JSON.stringify({browserContext:browserName==='webkit'?'fresh persistent WebKit profile':'ephemeral',expectedFailures,oldPid,newPid:server.pid,oldOrigin,newOrigin:server.origin,networkPaths:[...new Set(requests)],providerEffects:effects,downloadedBundleBytes:(await readFile(bundlePath)).length,sourceEvents:events.length,sourceEntities:entities.length,exactPixels:true,externalDestination:'unconfirmed',osPicker:'not exercised; real browser fallback download tested'},null,2));
  57 |  await page.screenshot({path:join(receipt,'e1.png')});
  58 |  }finally{await writeFile(join(receipt,'e1-console.json'),JSON.stringify({browser:browserName,observations:consoleObservations},null,2));await server.close();}
  59 | });
  60 | 
```