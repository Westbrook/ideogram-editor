# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: authoring.spec.ts >> P1c3 inherited layer operations and reviewed geometry remain usable through public controls
- Location: tests/editor/authoring.spec.ts:63:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByText('SetLayerProperties accepted and saved locally.', { exact: true })
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" getByText('SetLayerProperties accepted and saved locally.', { exact: true }) with timeout 5000ms
  - waiting for getByText('SetLayerProperties accepted and saved locally.', { exact: true })

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
  - text: 3 × 2 · revision 6
  - group "Document actions":
    - button "New"
    - button "Open"
    - button "Import image"
    - button "Undo"
    - button "Redo" [disabled]
  - button "Connected locally"
  - button "Save copy"
  - button "Export image"
  - button "Help"
  - text: Shortcuts and recovery
- region "Operation status":
  - status: Action needs attention.
- main "Image editor":
  - complementary:
    - toolbar "Canvas tools":
      - button "Move"
      - button "Text" [disabled]
      - button "Select"
      - button "Mask"
      - button "Crop"
      - button "Sample"
      - button "Pan" [pressed]
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
    - paragraph: Draft saved locally; not applied to the document
    - heading "Explicit inputs" [level=2]
    - paragraph: Selecting a layer does not attach it to a request. Provider source, mask, adapters and generation remain unavailable; local layer masks are separate.
    - button "Generate" [disabled]
    - paragraph: Local selection, masks and layer edits are available in the inspector. Native text editing and composition authoring follow separately.
  - separator "Request panel width"
  - region "Canvas":
    - group "View controls":
      - text: Pan · retained raster Zoom percentage
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
        - treeitem "Renamed original copy · visible" [level=1] [selected]
        - treeitem "Renamed original · visible" [level=1]
      - button "Duplicate"
      - button "Delete layer"
      - button "Move up"
      - button "Move down"
    - heading "Layer properties" [level=2]
    - paragraph: Unapplied inspector draft · base revision 5
    - text: Layer name
    - textbox "Layer name": Renamed original copy
    - text: Opacity (0–1)
    - button "Decrease value"
    - spinbutton "Opacity (0–1)": "0.75"
    - button "Increase value"
    - text: Opacity preview
    - slider "Opacity preview": "0.75"
    - switch "Visible"
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
      - button "Selection, masks and color"
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
          - article "History 0142fa53-f275-4f43-9f6e-e54a13ae2cbf":
            - text: ImportAsset
            - time
            - paragraph: ImportAsset · 0142fa53-f275-4f43-9f6e-e54a13ae2cbf
            - button "Open this history state"
        - listitem:
          - article "History ab317055-9327-4b52-8355-23778a470497":
            - text: MoveLayers
            - time
            - paragraph: MoveLayers · ab317055-9327-4b52-8355-23778a470497
            - button "Open this history state"
        - listitem:
          - article "History b6a93b9a-c33e-4a25-8062-b4432773801d":
            - text: SetLayerProperties
            - time
            - paragraph: SetLayerProperties · b6a93b9a-c33e-4a25-8062-b4432773801d
            - button "Open this history state"
        - listitem:
          - article "History df63abac-eeca-48ce-af14-b7d05fd72d52":
            - text: MoveLayers
            - time
            - paragraph: MoveLayers · df63abac-eeca-48ce-af14-b7d05fd72d52 · current
            - button "Open this history state"
        - listitem:
          - article "History e4a60804-77a6-4f08-9f33-5e8d372d1a88":
            - text: DuplicateLayer
            - time
            - paragraph: DuplicateLayer · e4a60804-77a6-4f08-9f33-5e8d372d1a88
            - button "Open this history state"
        - listitem:
          - article "History f4ec0ea1-204c-4504-a83c-150f0b1a23bc":
            - text: Document created
            - time
            - paragraph: Creation · f4ec0ea1-204c-4504-a83c-150f0b1a23bc
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
- contentinfo: Accepted edits saved locally · Draft saved locally; not applied to the document Checkpoint outdated · Portable copy outdated · External destination unconfirmed
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
  40 |   const pointerPlan=plans.at(-2);for(const [label,key] of [['Selection X','x'],['Selection Y','y'],['Selection width','width'],['Selection height','height']])expect(Number(await page.getByRole('spinbutton',{name:label,exact:true}).inputValue())).toBe(pointerPlan.operations[0].shape[key]);await click(page,'Cancel mask draft');
  41 |   await click(page,'Apply selection');await click(page,'Use selection as mask');await click(page,'Preview mask');await expect(page.getByRole('button',{name:'Apply layer mask',exact:true})).toBeEnabled();expect(plans.at(-2).operations).toEqual(pointerPlan.operations);await click(page,'Cancel mask draft');
  42 |   await click(page,'Mask');await click(page,'Fill all');await expect(page.getByText(/1 draft operations/)).toBeVisible();await field(page,'Feather radius (document px)','65');await click(page,'Preview mask');await expect(page.getByText('Feather radius must be between 0 and 64 document pixels.',{exact:true}).first()).toBeVisible();await field(page,'Feather radius (document px)','2');const count=commands.filter(c=>c==='PrepareMask').length;
  43 |   await page.getByRole('button',{name:'Preview mask',exact:true}).evaluate(button=>(button.getRootNode() as ShadowRoot).host.addEventListener('click',e=>e.preventDefault(),{once:true}));await click(page,'Preview mask');await expect(page.getByRole('button',{name:'Preview mask',exact:true})).toBeEnabled();expect(commands.filter(c=>c==='PrepareMask').length).toBe(count);
  44 |   await field(page,'Brush diameter (document px)','1');const brushBox=(await page.locator('canvas').boundingBox())!,bx=brushBox.x+brushBox.width/2,by=brushBox.y+brushBox.height/2;
  45 |   await page.getByRole('radio',{name:'subtract',exact:true}).last().focus();await page.keyboard.press('Space');
  46 |   await page.mouse.move(bx,by);await page.mouse.down();await page.mouse.move(bx+1,by);await page.mouse.up();await expect(page.getByText(/2 draft operations/)).toBeVisible();await click(page,'Undo mask stroke');await expect(page.getByText(/1 draft operations/)).toBeVisible();
  47 |   await expect(page.getByText('Draft saved locally; not applied to the document',{exact:true}).first()).toBeVisible();await page.reload();await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();await page.getByRole('treeitem').first().click();await click(page,'Mask');await expect(page.getByText(/1 draft operations/)).toBeVisible();
  48 |   const second=await context.newPage();await second.goto(server.origin);await expect(second.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();await second.getByRole('treeitem').first().click();await field(second,'Opacity (0–1)','0.75');await click(second,'Apply properties');await expect(second.getByText('SetLayerProperties accepted and saved locally.',{exact:true})).toBeVisible();await expect(page.getByText('Stale mask draft',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Preview mask',exact:true})).toBeDisabled();await second.close();await click(page,'Cancel mask draft');
  49 |   await expect(page.getByRole('button',{name:'Import PNG mask',exact:true})).toBeEnabled();await page.locator('en-file-upload').filter({hasText:'Import PNG mask'}).locator('input[type=file]').setInputFiles('tests/raster/fixtures/hidden-alpha.png');await expect(page.getByRole('button',{name:'Review aligned mask',exact:true})).toBeVisible();const approvals=commands.filter(c=>c==='ApproveRaster').length;await field(page,'Imported mask X','0.5');await click(page,'Review aligned mask');await expect(page.getByText('Mask alignment must use whole document pixels at the imported native size.',{exact:true}).first()).toBeVisible();expect(commands.filter(c=>c==='ApproveRaster').length).toBe(approvals);await field(page,'Imported mask X','0');await click(page,'Review aligned mask');await expect(page.getByRole('button',{name:'Apply layer mask',exact:true})).toBeEnabled();await click(page,'Cancel mask draft');
  50 |   await click(page,'Lock layer');await expect(page.getByRole('button',{name:'Unlock layer',exact:true})).toBeVisible();await click(page,'Unlock layer');await expect(page.getByRole('button',{name:'Lock layer',exact:true})).toBeVisible();
  51 |   await click(page,'Move');await click(page,'100%');const canvas=page.locator('canvas'),box=(await canvas.boundingBox())!,cx=box.x+box.width/2,cy=box.y+box.height/2;
  52 |   const transformCount=commands.filter(c=>c==='ApplyTransform').length;await page.mouse.move(cx,cy);await page.mouse.down();await page.mouse.move(cx+10,cy+5);await page.mouse.up();await expect(page.getByText('ApplyTransform accepted and saved locally.',{exact:true})).toBeVisible();expect(commands.filter(c=>c==='ApplyTransform').length).toBe(transformCount+1);
  53 |   await page.mouse.move(cx,cy);await page.mouse.down();await page.mouse.move(cx+5,cy+5);await page.locator('#canvas').focus();await page.keyboard.press('Escape');await page.mouse.up();expect(commands.filter(c=>c==='ApplyTransform').length).toBe(transformCount+1);
  54 |   const colors:string[]=[];for(const appearance of ['light','dark']){await page.evaluate(v=>document.documentElement.setAttribute('data-en-appearance',v),appearance);colors.push(await page.locator('body').evaluate(el=>getComputedStyle(el).color));await page.getByRole('button',{name:'Sample color',exact:true}).focus();await expect(page.getByRole('button',{name:'Sample color',exact:true})).toBeFocused();}expect(colors[0]).not.toBe(colors[1]);
  55 |   await field(page,'Zoom percentage','200');await expect(page.getByRole('spinbutton',{name:'Zoom percentage',exact:true})).toHaveValue('200');await click(page,'100%');
  56 |   if(browserName!=='webkit')await page.screenshot({path:join(receipt,'authoring-desktop.png'),caret:'initial'});
  57 |   for(const width of [720,320]){await page.setViewportSize({width,height:950});for(const dir of ['ltr','rtl']){await page.evaluate(d=>document.documentElement.dir=d,dir);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await expect(page.getByRole('button',{name:'Preview mask',exact:true})).toBeVisible();}}
  58 |   if(browserName!=='webkit')await page.screenshot({path:join(receipt,'authoring-320.png'),caret:'initial'});
  59 |   await page.getByRole('button',{name:'Preview mask',exact:true}).scrollIntoViewIfNeeded();if(browserName!=='webkit')await page.screenshot({path:join(receipt,'mask-controls-320.png'),caret:'initial'});
  60 |   expect(errors).toEqual([]);expect(consoleErrors).toEqual([]);expect(Object.values(await server.effects()).every(v=>v===0)).toBe(true);
  61 |  }finally{try{await guard.cleanup();guard.verify();}finally{await writeFile(join(receipt,'ownership.json'),JSON.stringify(guard.ledger,null,2));await writeFile(join(receipt,'commands.json'),JSON.stringify(commands,null,2));await writeFile(join(receipt,'errors.json'),JSON.stringify({errors,consoleErrors,failedResponses},null,2));await server.close();}}
  62 | });
  63 | test('P1c3 inherited layer operations and reviewed geometry remain usable through public controls',async({page,context,browserName})=>{
  64 |  const guard=await ownedOPFS(context,'p1c3-inherited-'+browserName),errors=await recordDOMErrors(context),commands:any[]=[];
  65 |  const dir=await mkdtemp(join(await realpath(tmpdir()),'ie-p1c3-inherited-')),server=await serverProcess(join(dir,'private'));
  66 |  page.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname==='/api/v1/commands')commands.push(JSON.parse(r.postData()!).command.body);});
> 67 |  const accepted=(type:string)=>expect(page.getByText(type+' accepted and saved locally.',{exact:true})).toBeVisible();
     |                                                                                                         ^ Error: expect(locator).toBeVisible() failed
  68 |  try{
  69 |   await guard.admit(page,server.origin);await page.goto(await server.pair());await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();await importImage(page);
  70 |   await page.getByRole('textbox',{name:'Layer name',exact:true}).fill('Renamed original');await field(page,'Opacity (0–1)','0.75');await click(page,'Apply properties');await accepted('SetLayerProperties');await expect(page.getByRole('treeitem')).toContainText('Renamed original');
  71 |   await click(page,'Duplicate');await accepted('DuplicateLayer');await expect(page.getByRole('treeitem')).toHaveCount(2);await page.getByRole('treeitem').first().click();await click(page,'Move down');await accepted('MoveLayers');await click(page,'Move up');await accepted('MoveLayers');
  72 |   const visible=page.getByRole('switch',{name:'Visible',exact:true});await visible.focus();await page.keyboard.press('Space');await click(page,'Apply properties');await accepted('SetLayerProperties');expect(commands.filter(c=>c.type==='SetLayerProperties').at(-1).properties.visible).toBe(false);
  73 |   await visible.focus();await page.keyboard.press('Space');await click(page,'Apply properties');await accepted('SetLayerProperties');
  74 |   const before=commands.filter(c=>c.type==='ApplyTransform').length;for(const [name,value] of [['X','1'],['Y','1'],['A','0.5'],['D','0.5']])await field(page,name,value);await click(page,'Apply transform');await accepted('ApplyTransform');expect(commands.filter(c=>c.type==='ApplyTransform').length).toBe(before+1);expect(commands.filter(c=>c.type==='ApplyTransform').at(-1).transform).toEqual([0.5,0,0,0.5,1,1]);
  75 |   await click(page,'Delete layer');await accepted('DeleteLayer');await expect(page.getByRole('treeitem')).toHaveCount(1);await click(page,'Undo');await accepted('Undo');await expect(page.getByRole('treeitem')).toHaveCount(2);await page.getByRole('treeitem').first().click();
  76 |   await click(page,'Resample image…');await field(page,'Intrinsic width (px)','6');await field(page,'Intrinsic height (px)','4');await click(page,'Prepare preview');await expect(page.getByRole('dialog',{name:'Review prepared image edit'})).toBeVisible();await click(page,'Apply reviewed result');await accepted('ResampleImage');
  77 |   await click(page,'Canvas bounds…');await page.getByRole('combobox',{name:'Bounds action',exact:true}).selectOption('resize');await field(page,'Width (px)','4');await field(page,'Height (px)','3');await click(page,'Apply bounds');await expect(page.locator('.document-name')).toContainText('4 × 3');
  78 |   await click(page,'Canvas bounds…');await page.getByRole('combobox',{name:'Bounds action',exact:true}).selectOption('crop');await field(page,'Width (px)','2');await field(page,'Height (px)','2');await click(page,'Apply bounds');await expect(page.locator('.document-name')).toContainText('2 × 2');
  79 |   await click(page,'Flatten copy…');await click(page,'Prepare preview');await expect(page.getByRole('dialog',{name:'Review prepared image edit'})).toBeVisible();const flattened=commands.filter(c=>c.type==='CreateFlattenedCopy').length;await click(page,'Apply reviewed result');await accepted('CreateFlattenedCopy');expect(commands.filter(c=>c.type==='CreateFlattenedCopy').length).toBe(flattened+1);await expect(page.getByRole('treeitem')).toHaveCount(3);
  80 |   const handle=page.getByRole('separator',{name:'Request panel width',exact:true});await handle.focus();const width=await page.locator('#left-divider').evaluate((h:any)=>h.value);await page.keyboard.press('ArrowRight');expect(await page.locator('#left-divider').evaluate((h:any)=>h.value)).toBeGreaterThan(width);
  81 |   const splitter=await page.locator('#left-divider').evaluate(h=>({track:getComputedStyle(h.parentElement!).gridTemplateColumns.split(' ')[1],margin:getComputedStyle(h).marginInlineStart,width:h.getBoundingClientRect().width,z:getComputedStyle(h).zIndex}));expect(splitter.track).toBe('1px');expect(parseFloat(splitter.margin)).toBe(-(splitter.width-1)/2);expect(splitter.z).toBe('1');
  82 |   expect(errors).toEqual([]);expect(Object.values(await server.effects()).every(v=>v===0)).toBe(true);
  83 |  }finally{try{await guard.cleanup();guard.verify();}finally{await mkdir(receipt,{recursive:true});await writeFile(join(receipt,'inherited-ownership.json'),JSON.stringify(guard.ledger,null,2));await writeFile(join(receipt,'inherited-commands.json'),JSON.stringify(commands,null,2));await writeFile(join(receipt,'inherited-errors.json'),JSON.stringify(errors,null,2));await server.close();}}
  84 | });
  85 | 
```