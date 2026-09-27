# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: authoring.spec.ts >> P1c3 selection, exact mask review, draft undo, attachment, sample, transforms and responsive En Reve controls
- Location: tests/editor/authoring.spec.ts:12:1

# Error details

```
TimeoutError: locator.check: Timeout 10000ms exceeded.
Call log:
  - waiting for getByRole('radio', { name: 'hard', exact: true })
    - locator resolved to <input type="radio" value="hard" name="choice" tabindex="-1" part="control" aria-describedby="description" class="en-segmented-input en-sr-only"/>
  - attempting click action
    2 × waiting for element to be visible, enabled and stable
      - element is visible, enabled and stable
      - scrolling into view if needed
      - done scrolling
      - <span part="option-label" class="en-segmented-label">…</span> intercepts pointer events
    - retrying click action
    - waiting 20ms
    2 × waiting for element to be visible, enabled and stable
      - element is visible, enabled and stable
      - scrolling into view if needed
      - done scrolling
      - <span part="option-label" class="en-segmented-label">…</span> intercepts pointer events
    - retrying click action
      - waiting 100ms
    19 × waiting for element to be visible, enabled and stable
       - element is visible, enabled and stable
       - scrolling into view if needed
       - done scrolling
       - <span part="option-label" class="en-segmented-label">…</span> intercepts pointer events
     - retrying click action
       - waiting 500ms

```

# Test source

```ts
  1  | import {test,expect,type Page} from '@playwright/test';
  2  | import {mkdtemp,realpath,mkdir,writeFile} from 'node:fs/promises';
  3  | import {tmpdir} from 'node:os';
  4  | import {join} from 'node:path';
  5  | import {serverProcess} from './process.js';
  6  | import {ownedOPFS} from './owned-opfs.js';
  7  | import {recordDOMErrors} from './error-monitor.js';
  8  | const receipt=process.env.EDITOR_RECEIPT??'artifacts/p1c3/browser';
  9  | const click=(p:Page,name:string)=>p.getByRole('button',{name,exact:true}).click();
  10 | async function field(p:Page,name:string,value:string){const f=p.getByRole('spinbutton',{name,exact:true});await f.fill(value);await f.press('Tab');}
  11 | async function importImage(p:Page){await p.locator('.canvas-empty en-file-upload input[type=file]').setInputFiles('tests/raster/fixtures/hidden-alpha.png');await click(p,'Apply reviewed result');await expect(p.getByText('ImportAsset accepted and saved locally.',{exact:true})).toBeVisible();await p.getByRole('treeitem').first().click();}
  12 | test('P1c3 selection, exact mask review, draft undo, attachment, sample, transforms and responsive En Reve controls',async({page,context},info)=>{
  13 |  const guard=await ownedOPFS(context,'p1c3-'+info.project.name),errors=await recordDOMErrors(context),consoleErrors:string[]=[],commands:string[]=[];
  14 |  page.on('pageerror',e=>consoleErrors.push(e.message));page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text());});
  15 |  page.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname==='/api/v1/commands')commands.push(JSON.parse(r.postData()!).command.body.type);});
  16 |  const dir=await mkdtemp(join(await realpath(tmpdir()),'ie-p1c3-')),server=await serverProcess(join(dir,'private'));
  17 |  await mkdir(receipt,{recursive:true});
  18 |  try{
  19 |   await guard.admit(page,server.origin);await page.goto(await server.pair());await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();await importImage(page);
  20 |   await click(page,'Select');await field(page,'Selection X','1');await field(page,'Selection Y','0');await field(page,'Selection width','1');await field(page,'Selection height','2');
  21 |   const revision=await page.locator('.document-name').textContent();await click(page,'Apply selection');expect(await page.locator('.document-name').textContent()).toBe(revision);
  22 |   await click(page,'Use selection as mask');await field(page,'Feather radius (document px)','2');await click(page,'Preview mask');await expect(page.getByRole('button',{name:'Apply layer mask',exact:true})).toBeEnabled();
  23 |   await expect(page.getByText(/Hard support: 2 pixels. Effective support: 6 pixels/)).toBeVisible();
> 24 |   await page.getByRole('radio',{name:'hard',exact:true}).check();await expect(page.getByAltText('hard mask view')).toBeVisible();await page.getByRole('radio',{name:'effective',exact:true}).check();await page.getByRole('radio',{name:'result',exact:true}).check();
     |                                                          ^ TimeoutError: locator.check: Timeout 10000ms exceeded.
  25 |   const before=commands.filter(c=>c==='SetLayerProperties').length;await click(page,'Apply layer mask');await expect(page.getByText('SetLayerProperties accepted and saved locally.',{exact:true})).toBeVisible();expect(commands.filter(c=>c==='SetLayerProperties').length).toBe(before+1);
  26 |   await click(page,'Sample');await field(page,'Sample X','1');await field(page,'Sample Y','0');await click(page,'Sample color');await expect(page.getByText(/sRGB RGBA \(255, 0, 0, 48\)/)).toBeVisible();
  27 |   await click(page,'Undo');await expect(page.getByText('Undo accepted and saved locally.',{exact:true})).toBeVisible();
  28 |   await click(page,'Mask');await click(page,'Fill all');await click(page,'Clear mask');await click(page,'Undo mask stroke');await click(page,'Preview mask');await expect(page.getByText(/Hard support: 6 pixels/)).toBeVisible();await click(page,'Cancel mask draft');
  29 |   await click(page,'Lock layer');await expect(page.getByRole('button',{name:'Unlock layer',exact:true})).toBeVisible();await click(page,'Unlock layer');await expect(page.getByRole('button',{name:'Lock layer',exact:true})).toBeVisible();
  30 |   await click(page,'Move');await click(page,'100%');const canvas=page.locator('canvas'),box=(await canvas.boundingBox())!,cx=box.x+box.width/2,cy=box.y+box.height/2;
  31 |   const transformCount=commands.filter(c=>c==='ApplyTransform').length;await page.mouse.move(cx,cy);await page.mouse.down();await page.mouse.move(cx+10,cy+5);await page.mouse.up();await expect(page.getByText('ApplyTransform accepted and saved locally.',{exact:true})).toBeVisible();expect(commands.filter(c=>c==='ApplyTransform').length).toBe(transformCount+1);
  32 |   await page.mouse.move(cx,cy);await page.mouse.down();await page.mouse.move(cx+5,cy+5);await page.locator('#canvas').focus();await page.keyboard.press('Escape');await page.mouse.up();expect(commands.filter(c=>c==='ApplyTransform').length).toBe(transformCount+1);
  33 |   await page.screenshot({path:join(receipt,'authoring-desktop.png'),caret:'initial'});
  34 |   for(const width of [720,320]){await page.setViewportSize({width,height:950});for(const dir of ['ltr','rtl']){await page.evaluate(d=>document.documentElement.dir=d,dir);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await expect(page.getByRole('button',{name:'Preview mask',exact:true})).toBeVisible();}}
  35 |   await page.screenshot({path:join(receipt,'authoring-320.png'),caret:'initial'});
  36 |   expect(errors).toEqual([]);expect(consoleErrors).toEqual([]);expect(Object.values(await server.effects()).every(v=>v===0)).toBe(true);
  37 |  }finally{await server.close();try{await guard.cleanup();guard.verify();}finally{await writeFile(join(receipt,'ownership.json'),JSON.stringify(guard.ledger,null,2));await writeFile(join(receipt,'commands.json'),JSON.stringify(commands,null,2));await writeFile(join(receipt,'errors.json'),JSON.stringify({errors,consoleErrors},null,2));}}
  38 | });
  39 | 
```