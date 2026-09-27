# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: authoring.spec.ts >> P1c3 selection, exact mask review, draft undo, attachment, sample, transforms and responsive En Reve controls
- Location: tests/editor/authoring.spec.ts:19:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByText(/1 draft operations/)
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" getByText(/1 draft operations/) with timeout 5000ms
  - waiting for getByText(/1 draft operations/)

```

```yaml
- link "Go to Request":
  - /url: "#request"
- link "Go to Canvas":
  - /url: "#canvas"
- link "Go to Layers":
  - /url: "#inspector"
- link "Go to History":
  - /url: "#results"
- banner:
  - strong: Ideogram Editor
  - text: 3 × 2 · revision 4
  - group "Document actions":
    - button "New"
    - button "Open"
    - button "Import image"
    - button "Undo"
    - button "Redo"
  - button "Connected locally"
  - button "Save copy"
  - button "Export image"
  - button "Help"
  - text: Shortcuts and recovery
- region "Operation status":
  - status: Local recovery complete. Accepted edits are saved locally.
- main "Image editor":
  - complementary:
    - toolbar "Canvas tools":
      - button "Move"
      - button "Text" [disabled]
      - button "Select"
      - button "Mask" [pressed]
      - button "Crop"
      - button "Sample"
      - button "Pan"
      - button "Zoom"
  - region "Request":
    - heading "Request" [level=1]
    - text: Draft Operation
    - combobox "Operation":
      - option "Generate image" [selected]
      - option "Generate with Instant"
      - option "Generate with Fast"
      - option "Transform image"
      - option "Edit masked region"
      - option "Generate with adapters"
      - option "Transform with adapters"
      - option "Edit with adapters"
    - text: Prompt
    - textbox "Prompt":
      - /placeholder: Describe the image you have in mind…
    - text: Draft autosaves locally; generation remains unavailable.
    - paragraph: Draft has not been applied.
    - heading "Explicit inputs" [level=2]
    - paragraph: Selecting a layer does not attach it to a request. Provider source, mask, adapters and generation remain unavailable; local layer masks are separate.
    - button "Generate" [disabled]
    - paragraph: Local selection, masks and layer edits are available in the inspector. Native text editing and composition authoring follow separately.
  - separator "Request panel width"
  - region "Canvas":
    - group "View controls":
      - text: Mask · retained raster Zoom percentage
      - button "Decrease value"
      - spinbutton "Zoom percentage": "100"
      - button "Increase value"
      - button "Fit"
      - button "100%"
    - text: 3 × 2 pixels · 1 selected Paste an image here to review
    - group "Numeric view controls":
      - text: View X (px)
      - button "Decrease value"
      - spinbutton "View X (px)": "0"
      - button "Increase value"
      - text: View Y (px)
      - button "Decrease value"
      - spinbutton "View Y (px)": "0"
      - button "Increase value"
      - button "Apply view"
  - separator "Canvas and inspector width"
  - complementary "Layers and properties":
    - tablist "Document structure":
      - tab "Layers" [selected]
      - tab "Composition"
    - tabpanel "Layers":
      - tree "Image layers":
        - treeitem "hidden-alpha.png · visible" [level=1] [selected]
      - button "Duplicate"
      - button "Delete layer"
      - button "Move up"
      - button "Move down"
    - heading "Layer properties" [level=2]
    - paragraph: Accepted layer · base revision 4
    - text: Layer name
    - textbox "Layer name": hidden-alpha.png
    - text: Opacity (0–1)
    - button "Decrease value"
    - spinbutton "Opacity (0–1)": "1"
    - button "Increase value"
    - text: Opacity preview
    - slider "Opacity preview": "1"
    - switch "Visible" [checked]
    - text: Visible
    - switch "Locked"
    - text: Locked
    - button "Lock layer"
    - button "Apply properties"
    - button "Cancel changes"
    - heading "Transform" [level=2]
    - paragraph: Affine coefficients preserve rotation and shear. X/Y use document pixels. Scaling a text layer does not reflow its frame.
    - text: X
    - button "Decrease value"
    - spinbutton "X": "0"
    - button "Increase value"
    - text: "Y"
    - button "Decrease value"
    - spinbutton "Y": "0"
    - button "Increase value"
    - text: A
    - button "Decrease value"
    - spinbutton "A": "1"
    - button "Increase value"
    - text: B
    - button "Decrease value"
    - spinbutton "B": "0"
    - button "Increase value"
    - text: C
    - button "Decrease value"
    - spinbutton "C": "0"
    - button "Increase value"
    - text: D
    - button "Decrease value"
    - spinbutton "D": "1"
    - button "Increase value"
    - button "Apply transform"
    - button "Resample image…"
    - heading "Selection, masks and color" [level=3]:
      - button "Selection, masks and color" [expanded]
    - paragraph: Pointer Move previews the canonical layer result as local computation completes; release makes one history edit. Escape restores the accepted view.
    - text: Local authoring
    - group "Selection shape":
      - text: Selection shape
      - radio "rectangle" [checked]
      - text: rectangle
      - radio "ellipse"
      - text: ellipse
      - radio "polygon"
      - text: polygon
    - group "Selection combination":
      - text: Selection combination
      - radio "replace" [checked]
      - text: replace
      - radio "add"
      - text: add
      - radio "subtract"
      - text: subtract
      - radio "intersect"
      - text: intersect
    - text: Selection X
    - button "Decrease value"
    - spinbutton "Selection X": "0"
    - button "Increase value"
    - text: Selection Y
    - button "Decrease value"
    - spinbutton "Selection Y": "0"
    - button "Increase value"
    - text: Selection width
    - button "Decrease value"
    - spinbutton "Selection width": "100"
    - button "Increase value"
    - text: Selection height
    - button "Decrease value"
    - spinbutton "Selection height": "100"
    - button "Increase value"
    - group "Selection actions":
      - button "Apply selection"
      - button "Use selection as mask" [disabled]
      - button "Clear selection"
    - paragraph: Selection uses document pixels and does not select layers or attach provider inputs. Polygon clicks add points; Apply selection closes the polygon.
    - group "Brush action":
      - text: Brush action
      - radio "add" [checked]
      - text: add
      - radio "subtract"
      - text: subtract
    - text: Brush diameter (document px)
    - button "Decrease value"
    - spinbutton "Brush diameter (document px)": "20"
    - button "Increase value"
    - text: Brush hardness (0–1)
    - button "Decrease value"
    - spinbutton "Brush hardness (0–1)": "1"
    - button "Increase value"
    - text: Feather radius (document px)
    - button "Decrease value"
    - spinbutton "Feather radius (document px)": "0"
    - button "Increase value"
    - group "Mask draft actions":
      - button "Fill all"
      - button "Clear mask"
      - button "Invert mask"
      - button "Undo mask stroke" [disabled]
      - button "Start fresh mask"
    - text: Hard coverage is retained separately from effective feather. Radius ≤1 is identity; the finite triangle fades at document edges. White keeps a layer visible; black hides it. For a future edit mask, white means regenerate. No provider input is attached. Import PNG mask
    - button "Import PNG mask"
    - group "Mask review actions":
      - button "Preview mask" [disabled]
      - button "Cancel mask draft" [disabled]
      - button "Detach layer mask"
    - heading "Color sample" [level=2]
    - group "Sample source":
      - text: Sample source
      - radio "merged" [checked]
      - text: merged
      - radio "active"
      - text: active
    - paragraph: Active includes the selected layer even when hidden; its transform, mask and opacity are included.
    - text: Sample X
    - button "Decrease value"
    - spinbutton "Sample X": "0"
    - button "Increase value"
    - text: Sample Y
    - button "Decrease value"
    - spinbutton "Sample Y": "0"
    - button "Increase value"
    - button "Sample color"
    - status: No color sampled.
    - text: Selection display color (sRGB)
    - textbox "Selection display color (sRGB)": "#c778ee"
    - button "Canvas bounds…"
    - button "Flatten copy…"
- region "Activity":
  - heading "Activity" [level=3]:
    - button "Activity" [expanded]
  - tablist "Activity views":
    - tab "Results"
    - tab "Jobs"
    - tab "History" [selected]
  - tabpanel "History":
    - region "Retained document history":
      - list "Retained document history":
        - listitem:
          - article "History 6cc29d8e-1819-4689-aa5f-e57614ae6926":
            - text: ImportAsset
            - time
            - paragraph: ImportAsset · 6cc29d8e-1819-4689-aa5f-e57614ae6926 · current
            - button "Open this history state"
        - listitem:
          - article "History af0493b1-b03f-4362-bb34-498765540c10":
            - text: Document created
            - time
            - paragraph: Creation · af0493b1-b03f-4362-bb34-498765540c10
        - listitem:
          - article "History e1beadda-d4b9-468b-8620-93c88477f9f4":
            - text: SetLayerProperties
            - time
            - paragraph: SetLayerProperties · e1beadda-d4b9-468b-8620-93c88477f9f4
            - button "Open this history state"
    - navigation "Retained document history pages":
      - button "Newer page" [disabled]
      - text: Page 1 of 1
      - button "Older page" [disabled]
    - status
    - button "Load older activity" [disabled]
    - button "First history page"
    - text: Checkpoint name
    - textbox "Checkpoint name": My checkpoint
    - button "Save checkpoint"
    - paragraph: Checkpoints retain their full history.
- contentinfo: Accepted edits saved locally · No local draft change Checkpoint outdated · Portable copy outdated · External destination unconfirmed
```

# Test source

```ts
  1  | import {test as base,expect,type Page} from '@playwright/test';
  2  | import {mkdtemp,realpath,mkdir,writeFile,rm} from 'node:fs/promises';
  3  | import {tmpdir} from 'node:os';
  4  | import {join} from 'node:path';
  5  | import {serverProcess} from './process.js';
  6  | import {ownedOPFS} from './owned-opfs.js';
  7  | import {recordDOMErrors} from './error-monitor.js';
  8  | const test=base.extend({context:async({playwright,browserName,contextOptions,viewport},use)=>{
  9  |  const profile=browserName==='webkit'?await mkdtemp(join(await realpath(tmpdir()),'ie-p1c3-webkit-')):undefined;
  10 |  const browser=profile?undefined:await playwright[browserName].launch();
  11 |  const context=profile?await playwright.webkit.launchPersistentContext(profile,{...contextOptions,viewport}):await browser!.newContext({...contextOptions,viewport});
  12 |  await Promise.all(context.pages().map(page=>page.close()));
  13 |  try{await use(context);}finally{await context.close();await browser?.close();if(profile)await rm(profile,{recursive:true,force:true});}
  14 | }});
  15 | const receipt=process.env.EDITOR_RECEIPT??'artifacts/p1c3/browser';
  16 | const click=(p:Page,name:string)=>p.getByRole('button',{name,exact:true}).click();
  17 | async function field(p:Page,name:string,value:string){const f=p.getByRole('spinbutton',{name,exact:true});await f.fill(value);await f.press('Tab');}
  18 | async function importImage(p:Page){await p.locator('.canvas-empty en-file-upload input[type=file]').setInputFiles('tests/raster/fixtures/hidden-alpha.png');await click(p,'Apply reviewed result');await expect(p.getByText('ImportAsset accepted and saved locally.',{exact:true})).toBeVisible();await p.getByRole('treeitem').first().click();}
  19 | test('P1c3 selection, exact mask review, draft undo, attachment, sample, transforms and responsive En Reve controls',async({page,context,browserName},info)=>{
  20 |  const guard=await ownedOPFS(context,'p1c3-'+info.project.name),errors=await recordDOMErrors(context),consoleErrors:string[]=[],failedResponses:unknown[]=[],commands:string[]=[],plans:any[]=[];
  21 |  page.on('response',async r=>{if(r.status()>=400)failedResponses.push({url:r.url(),status:r.status(),body:await r.text().catch(()=>'<unavailable>')});});
  22 |   page.on('pageerror',e=>consoleErrors.push(e.message));page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text());});
  23 |  page.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname==='/api/v1/commands'){const body=JSON.parse(r.postData()!).command.body;commands.push(body.type);if(body.type==='PrepareMask')plans.push(body.plan);}});
  24 |  const dir=await mkdtemp(join(await realpath(tmpdir()),'ie-p1c3-')),server=await serverProcess(join(dir,'private'));
  25 |  await mkdir(receipt,{recursive:true});
  26 |  try{
  27 |   await guard.admit(page,server.origin);await page.goto(await server.pair());await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();await importImage(page);
  28 |   await click(page,'Select');await field(page,'Selection X','1');await field(page,'Selection Y','0');await field(page,'Selection width','1');await field(page,'Selection height','2');
  29 |   const revision=await page.locator('.document-name').textContent();await click(page,'Apply selection');expect(await page.locator('.document-name').textContent()).toBe(revision);
  30 |   await click(page,'Use selection as mask');await field(page,'Feather radius (document px)','2');await click(page,'Preview mask');await expect(page.getByRole('button',{name:'Apply layer mask',exact:true})).toBeEnabled();
  31 |   await expect(page.getByText(/Hard support: 2 pixels. Effective support: 6 pixels/)).toBeVisible();
  32 |   await page.getByRole('radio',{name:'hard',exact:true}).focus();await page.keyboard.press('Space');await expect(page.getByAltText('hard mask view')).toBeVisible();await page.getByRole('radio',{name:'effective',exact:true}).focus();await page.keyboard.press('Space');await page.getByRole('radio',{name:'result',exact:true}).focus();await page.keyboard.press('Space');
  33 |   const before=commands.filter(c=>c==='SetLayerProperties').length;await click(page,'Apply layer mask');await expect(page.getByText('SetLayerProperties accepted and saved locally.',{exact:true})).toBeVisible();expect(commands.filter(c=>c==='SetLayerProperties').length).toBe(before+1);
  34 |   await click(page,'Sample');await field(page,'Sample X','1');await field(page,'Sample Y','0');await click(page,'Sample color');await expect(page.getByText(/sRGB RGBA \(255, 0, 0, 48\)/)).toBeVisible();
  35 |   await click(page,'Undo');await expect(page.getByText('Undo accepted and saved locally.',{exact:true})).toBeVisible();
  36 |   await click(page,'Mask');await click(page,'Fill all');await click(page,'Clear mask');await click(page,'Undo mask stroke');await click(page,'Preview mask');await expect(page.getByText(/Hard support: 6 pixels/)).toBeVisible();await click(page,'Cancel mask draft');
  37 |   await click(page,'Select');await click(page,'100%');
  38 |   const selectionBox=(await page.locator('canvas').boundingBox())!,sx=selectionBox.x+selectionBox.width/2-1.5,sy=selectionBox.y+selectionBox.height/2-1;
  39 |   await page.mouse.move(sx+1,sy);await page.mouse.down();await page.mouse.move(sx+2,sy+2);await page.mouse.up();await click(page,'Use selection as mask');await click(page,'Preview mask');await expect(page.getByRole('button',{name:'Apply layer mask',exact:true})).toBeEnabled();
  40 |   expect(plans.at(-2).operations).toEqual(plans[0].operations);await click(page,'Cancel mask draft');
  41 |   await click(page,'Mask');await click(page,'Fill all');const count=commands.filter(c=>c==='PrepareMask').length;
  42 |   await page.getByRole('button',{name:'Preview mask',exact:true}).evaluate(button=>(button.getRootNode() as ShadowRoot).host.addEventListener('click',e=>e.preventDefault(),{once:true}));await click(page,'Preview mask');await expect(page.getByRole('button',{name:'Preview mask',exact:true})).toBeEnabled();expect(commands.filter(c=>c==='PrepareMask').length).toBe(count);
  43 |   await field(page,'Brush diameter (document px)','1');const brushBox=(await page.locator('canvas').boundingBox())!,bx=brushBox.x+brushBox.width/2,by=brushBox.y+brushBox.height/2;
  44 |   await page.getByRole('radio',{name:'subtract',exact:true}).last().focus();await page.keyboard.press('Space');
  45 |   await page.mouse.move(bx,by);await page.mouse.down();await page.mouse.move(bx+1,by);await page.mouse.up();await expect(page.getByText(/2 draft operations/)).toBeVisible();await click(page,'Undo mask stroke');await expect(page.getByText(/1 draft operations/)).toBeVisible();
> 46 |   await page.reload();await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();await page.getByRole('treeitem').first().click();await click(page,'Mask');await expect(page.getByText(/1 draft operations/)).toBeVisible();
     |                                                                                                                                                                                                                                                                          ^ Error: expect(locator).toBeVisible() failed
  47 |   const second=await context.newPage();await second.goto(server.origin);await expect(second.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();await second.getByRole('treeitem').first().click();await field(second,'Opacity (0–1)','0.75');await click(second,'Apply properties');await expect(second.getByText('SetLayerProperties accepted and saved locally.',{exact:true})).toBeVisible();await expect(page.getByText('Stale mask draft',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Preview mask',exact:true})).toBeDisabled();await second.close();await click(page,'Cancel mask draft');
  48 |   await page.locator('en-file-upload').filter({hasText:'Import PNG mask'}).locator('input[type=file]').setInputFiles('tests/raster/fixtures/hidden-alpha.png');await expect(page.getByRole('button',{name:'Review aligned mask',exact:true})).toBeVisible();await field(page,'Imported mask X','0');await click(page,'Review aligned mask');await expect(page.getByRole('button',{name:'Apply layer mask',exact:true})).toBeEnabled();await click(page,'Cancel mask draft');
  49 |   await click(page,'Lock layer');await expect(page.getByRole('button',{name:'Unlock layer',exact:true})).toBeVisible();await click(page,'Unlock layer');await expect(page.getByRole('button',{name:'Lock layer',exact:true})).toBeVisible();
  50 |   await click(page,'Move');await click(page,'100%');const canvas=page.locator('canvas'),box=(await canvas.boundingBox())!,cx=box.x+box.width/2,cy=box.y+box.height/2;
  51 |   const transformCount=commands.filter(c=>c==='ApplyTransform').length;await page.mouse.move(cx,cy);await page.mouse.down();await page.mouse.move(cx+10,cy+5);await page.mouse.up();await expect(page.getByText('ApplyTransform accepted and saved locally.',{exact:true})).toBeVisible();expect(commands.filter(c=>c==='ApplyTransform').length).toBe(transformCount+1);
  52 |   await page.mouse.move(cx,cy);await page.mouse.down();await page.mouse.move(cx+5,cy+5);await page.locator('#canvas').focus();await page.keyboard.press('Escape');await page.mouse.up();expect(commands.filter(c=>c==='ApplyTransform').length).toBe(transformCount+1);
  53 |   if(browserName!=='webkit')await page.screenshot({path:join(receipt,'authoring-desktop.png'),caret:'initial'});
  54 |   for(const width of [720,320]){await page.setViewportSize({width,height:950});for(const dir of ['ltr','rtl']){await page.evaluate(d=>document.documentElement.dir=d,dir);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await expect(page.getByRole('button',{name:'Preview mask',exact:true})).toBeVisible();}}
  55 |   if(browserName!=='webkit')await page.screenshot({path:join(receipt,'authoring-320.png'),caret:'initial'});
  56 |   await page.getByRole('button',{name:'Preview mask',exact:true}).scrollIntoViewIfNeeded();if(browserName!=='webkit')await page.screenshot({path:join(receipt,'mask-controls-320.png'),caret:'initial'});
  57 |   expect(errors).toEqual([]);expect(consoleErrors).toEqual([]);expect(Object.values(await server.effects()).every(v=>v===0)).toBe(true);
  58 |  }finally{try{await guard.cleanup();guard.verify();}finally{await writeFile(join(receipt,'ownership.json'),JSON.stringify(guard.ledger,null,2));await writeFile(join(receipt,'commands.json'),JSON.stringify(commands,null,2));await writeFile(join(receipt,'errors.json'),JSON.stringify({errors,consoleErrors,failedResponses},null,2));await server.close();}}
  59 | });
  60 | 
```