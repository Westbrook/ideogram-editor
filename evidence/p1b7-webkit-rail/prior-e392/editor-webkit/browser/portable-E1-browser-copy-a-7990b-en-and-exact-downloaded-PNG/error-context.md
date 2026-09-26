# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: portable.spec.ts >> E1 browser copy, actual process restart/new port, reviewed reopen and exact downloaded PNG
- Location: tests/editor/portable.spec.ts:14:1

# Error details

```
TimeoutError: page.waitForEvent: Timeout 10000ms exceeded while waiting for event "download"
=========================== logs ===========================
waiting for event "download"
============================================================
```

# Page snapshot

```yaml
- generic [ref=e3]:
  - generic:
    - link "Go to Request" [ref=e4]:
      - /url: "#request"
    - link "Go to Canvas" [ref=e5]:
      - /url: "#canvas"
    - link "Go to Layers" [ref=e6]:
      - /url: "#inspector"
    - link "Go to History" [ref=e7]:
      - /url: "#results"
  - banner [ref=e8]:
    - generic [ref=e13]:
      - strong [ref=e14]: Ideogram Editor
      - generic [ref=e15]: 3 × 2 · revision 5
    - group "Document actions" [ref=e17]:
      - generic:
        - button "New" [ref=e19] [cursor=pointer]
        - button "Open" [ref=e22] [cursor=pointer]
        - button "Import image" [ref=e25] [cursor=pointer]
        - button "Undo" [ref=e28] [cursor=pointer]
        - button "Redo" [ref=e31] [cursor=pointer]
    - generic [ref=e33]:
      - button "Connected locally" [ref=e35] [cursor=pointer]
      - generic:
        - paragraph: Connected to your local workspace.
        - paragraph: No provider request is available in this workflow.
        - generic:
          - generic:
            - button "Check connection"
          - generic:
            - button "Renew connection"
          - generic:
            - button "Disconnect"
      - button "Save copy" [ref=e38] [cursor=pointer]
      - button "Export image" [ref=e41] [cursor=pointer]
      - button "Help" [ref=e44] [cursor=pointer]
      - generic [ref=e46]: Shortcuts and recovery
  - region "Operation status" [ref=e47]:
    - status [ref=e48]: Action needs attention.
    - paragraph [ref=e49]: Updates interrupted. Recovering complete transactions; the last valid view is retained.
    - button "Reconnect" [ref=e51] [cursor=pointer]
    - region [ref=e53]:
      - heading "Action needs attention" [level=2] [ref=e54]
      - list [ref=e56]:
        - listitem [ref=e57]:
          - link "The operation failed for an unknown transient reason (e.g. out of memory)." [ref=e58]:
            - /url: "#inspector"
  - main "Image editor" [ref=e59]:
    - complementary [ref=e60]:
      - toolbar "Canvas tools" [ref=e62]:
        - generic:
          - button "Move" [disabled] [ref=e64]
          - button "Text" [disabled] [ref=e67]
          - button "Select" [disabled] [ref=e70]
          - button "Mask" [disabled] [ref=e73]
          - button "Crop" [disabled] [ref=e76]
          - button "Pan" [pressed] [ref=e79] [cursor=pointer]
          - button "Zoom" [ref=e82] [cursor=pointer]
    - generic [ref=e84]:
      - region "Request" [ref=e85]:
        - generic [ref=e86]:
          - heading "Request" [level=1] [ref=e87]
          - generic [ref=e88]: Draft
        - generic [ref=e89]:
          - generic [ref=e91]:
            - generic [ref=e92]: Operation
            - combobox "Operation" [ref=e95]:
              - button "Generate image" [ref=e96]
              - option "Generate image" [selected]
              - option "Generate with Instant"
              - option "Generate with Fast"
              - option "Transform image"
              - option "Edit masked region"
              - option "Generate with adapters"
              - option "Transform with adapters"
              - option "Edit with adapters"
          - generic [ref=e99]:
            - generic [ref=e100]: Prompt
            - textbox "Prompt" [ref=e103]:
              - /placeholder: Describe the image you have in mind…
              - text: 日本語 🌿 retained unapplied prompt
            - generic [ref=e104]: Draft autosaves locally; generation remains unavailable.
          - paragraph [ref=e107]: Draft saved locally; not applied to the document
          - heading "Explicit inputs" [level=2] [ref=e108]
          - paragraph [ref=e109]: Selecting a layer does not attach it to a request. Source, mask, adapters and generation are not available in this version.
          - button "Generate" [disabled] [ref=e111]
          - paragraph [ref=e113]: Native text, mask drawing and composition authoring are not available yet.
      - separator "Request panel width" [ref=e114]
      - generic [ref=e117]:
        - region "Canvas" [ref=e118]:
          - generic [ref=e119]:
            - generic [ref=e120]: Pan · retained raster
            - generic [ref=e122]:
              - generic [ref=e123]: Zoom percentage
              - generic [ref=e125]:
                - button "Decrease value" [ref=e126] [cursor=pointer]:
                  - generic [aria-hidden] [ref=e129]: −
                - spinbutton "Zoom percentage" [ref=e130]: "100"
                - button "Increase value" [ref=e131] [cursor=pointer]:
                  - generic [aria-hidden] [ref=e134]: +
            - button "Fit" [ref=e136] [cursor=pointer]
            - button "100%" [ref=e139] [cursor=pointer]
          - generic "Document raster preview" [ref=e142]
          - generic [ref=e143]:
            - generic [ref=e144]: 3 × 2 pixels · 1 selected
            - generic [ref=e145]: Paste an image here to review
          - generic [ref=e146]:
            - generic [ref=e148]:
              - generic [ref=e149]: View X (px)
              - generic [ref=e151]:
                - button "Decrease value" [ref=e152] [cursor=pointer]:
                  - generic [aria-hidden] [ref=e155]: −
                - spinbutton "View X (px)" [ref=e156]: "0"
                - button "Increase value" [ref=e157] [cursor=pointer]:
                  - generic [aria-hidden] [ref=e160]: +
            - generic [ref=e162]:
              - generic [ref=e163]: View Y (px)
              - generic [ref=e165]:
                - button "Decrease value" [ref=e166] [cursor=pointer]:
                  - generic [aria-hidden] [ref=e169]: −
                - spinbutton "View Y (px)" [ref=e170]: "0"
                - button "Increase value" [ref=e171] [cursor=pointer]:
                  - generic [aria-hidden] [ref=e174]: +
            - button "Apply view" [ref=e176] [cursor=pointer]
        - separator "Canvas and inspector width" [ref=e178]
        - complementary "Layers and properties" [ref=e181]:
          - generic [ref=e183]:
            - tablist "Document structure" [ref=e184]:
              - generic:
                - tab "Layers" [selected] [ref=e185] [cursor=pointer]
                - tab "Composition" [ref=e187] [cursor=pointer]
            - tabpanel "Layers" [ref=e190]:
              - generic [ref=e191]:
                - generic:
                  - tree "Image layers" [ref=e194]:
                    - treeitem "hidden-alpha.png · visible" [level=1] [selected] [ref=e195]
                  - generic [ref=e199]:
                    - button "Duplicate" [ref=e201] [cursor=pointer]
                    - button "Delete layer" [ref=e204] [cursor=pointer]
                    - button "Move up" [ref=e207] [cursor=pointer]
                    - button "Move down" [ref=e210] [cursor=pointer]
          - generic [ref=e212]:
            - heading "Image properties" [level=2] [ref=e213]
            - paragraph [ref=e214]: Accepted layer · base revision 5
            - generic [ref=e216]:
              - generic [ref=e217]: Layer name
              - textbox "Layer name" [ref=e220]: hidden-alpha.png
            - generic [ref=e222]:
              - generic [ref=e223]: Opacity (0–1)
              - generic [ref=e225]:
                - button "Decrease value" [ref=e226] [cursor=pointer]:
                  - generic [aria-hidden] [ref=e229]: −
                - spinbutton "Opacity (0–1)" [ref=e230]: "1"
                - button "Increase value" [ref=e231] [cursor=pointer]:
                  - generic [aria-hidden] [ref=e234]: +
            - generic [ref=e236]:
              - generic [ref=e237]: Opacity preview
              - slider "Opacity preview" [ref=e241] [cursor=pointer]: "1"
            - generic [ref=e244] [cursor=pointer]:
              - switch "Visible" [checked] [ref=e245]
              - generic [ref=e246]: Visible
            - generic [ref=e251] [cursor=pointer]:
              - switch "Locked" [ref=e252]
              - generic [ref=e253]: Locked
            - generic [ref=e256]:
              - button "Apply properties" [ref=e258] [cursor=pointer]
              - button "Cancel changes" [ref=e261] [cursor=pointer]
            - heading "Transform" [level=2] [ref=e263]
            - paragraph [ref=e264]: Affine coefficients preserve rotation and shear. X/Y use document pixels.
            - generic [ref=e265]:
              - generic [ref=e267]:
                - generic [ref=e268]: X
                - generic [ref=e270]:
                  - button "Decrease value" [ref=e271] [cursor=pointer]:
                    - generic [aria-hidden] [ref=e274]: −
                  - spinbutton "X" [ref=e275]: "0"
                  - button "Increase value" [ref=e276] [cursor=pointer]:
                    - generic [aria-hidden] [ref=e279]: +
              - generic [ref=e281]:
                - generic [ref=e282]: "Y"
                - generic [ref=e284]:
                  - button "Decrease value" [ref=e285] [cursor=pointer]:
                    - generic [aria-hidden] [ref=e288]: −
                  - spinbutton "Y" [ref=e289]: "0"
                  - button "Increase value" [ref=e290] [cursor=pointer]:
                    - generic [aria-hidden] [ref=e293]: +
              - generic [ref=e295]:
                - generic [ref=e296]: A
                - generic [ref=e298]:
                  - button "Decrease value" [ref=e299] [cursor=pointer]:
                    - generic [aria-hidden] [ref=e302]: −
                  - spinbutton "A" [ref=e303]: "1"
                  - button "Increase value" [ref=e304] [cursor=pointer]:
                    - generic [aria-hidden] [ref=e307]: +
              - generic [ref=e309]:
                - generic [ref=e310]: B
                - generic [ref=e312]:
                  - button "Decrease value" [ref=e313] [cursor=pointer]:
                    - generic [aria-hidden] [ref=e316]: −
                  - spinbutton "B" [ref=e317]: "0"
                  - button "Increase value" [ref=e318] [cursor=pointer]:
                    - generic [aria-hidden] [ref=e321]: +
              - generic [ref=e323]:
                - generic [ref=e324]: C
                - generic [ref=e326]:
                  - button "Decrease value" [ref=e327] [cursor=pointer]:
                    - generic [aria-hidden] [ref=e330]: −
                  - spinbutton "C" [ref=e331]: "0"
                  - button "Increase value" [ref=e332] [cursor=pointer]:
                    - generic [aria-hidden] [ref=e335]: +
              - generic [ref=e337]:
                - generic [ref=e338]: D
                - generic [ref=e340]:
                  - button "Decrease value" [ref=e341] [cursor=pointer]:
                    - generic [aria-hidden] [ref=e344]: −
                  - spinbutton "D" [ref=e345]: "1"
                  - button "Increase value" [ref=e346] [cursor=pointer]:
                    - generic [aria-hidden] [ref=e349]: +
            - button "Apply transform" [ref=e351] [cursor=pointer]
            - button "Resample image…" [ref=e354] [cursor=pointer]
            - generic [ref=e356]:
              - button "Canvas bounds…" [ref=e358] [cursor=pointer]
              - button "Flatten copy…" [ref=e361] [cursor=pointer]
  - region "Activity" [ref=e363]:
    - generic [ref=e364]:
      - heading "Activity" [level=2] [ref=e365]
      - button "Collapse" [ref=e367] [cursor=pointer]
    - generic [ref=e370]:
      - tablist "Activity views" [ref=e371]:
        - generic:
          - tab "Results" [ref=e372] [cursor=pointer]
          - tab "Jobs" [ref=e374] [cursor=pointer]
          - tab "History" [selected] [ref=e376] [cursor=pointer]
      - tabpanel "History" [ref=e379]:
        - generic [ref=e380]:
          - generic:
            - generic [ref=e382]:
              - region "Retained document history" [ref=e383]:
                - list "Retained document history" [ref=e384]:
                  - listitem [ref=e385]:
                    - article "History 0db67aa7-dbc1-4a7f-b79c-0929913552df" [ref=e388]:
                      - generic [ref=e389]:
                        - generic [ref=e390]: SetLayerProperties
                        - generic:
                          - generic:
                            - time
                      - paragraph [ref=e393]: SetLayerProperties · 0db67aa7-dbc1-4a7f-b79c-0929913552df
                      - button "Open this history state" [ref=e395] [cursor=pointer]
                  - listitem [ref=e397]:
                    - article "History 4066d71d-9a9a-4607-bd6d-877ca63b9f73" [ref=e400]:
                      - generic [ref=e401]:
                        - generic [ref=e402]: ImportAsset
                        - generic:
                          - generic:
                            - time
                      - paragraph [ref=e405]: ImportAsset · 4066d71d-9a9a-4607-bd6d-877ca63b9f73 · current
                      - button "Open this history state" [ref=e407] [cursor=pointer]
                  - listitem [ref=e409]:
                    - article "History a7f50951-4be5-447b-a600-e4653a595efe" [ref=e412]:
                      - generic [ref=e413]:
                        - generic [ref=e414]: Document created
                        - generic:
                          - generic:
                            - time
                      - paragraph [ref=e417]: Creation · a7f50951-4be5-447b-a600-e4653a595efe
              - navigation "Retained document history pages" [ref=e418]:
                - button "Newer page" [disabled] [ref=e420]
                - generic [ref=e422]: Page 1 of 1
                - button "Older page" [disabled] [ref=e424]
              - status [ref=e426]
              - button "Load older activity" [disabled] [ref=e428]
            - button "First history page" [ref=e431] [cursor=pointer]
            - generic [ref=e433]:
              - generic [ref=e435]:
                - generic [ref=e436]: Checkpoint name
                - textbox "Checkpoint name" [ref=e439]: Before copy
              - button "Save checkpoint" [ref=e441] [cursor=pointer]
            - paragraph [ref=e443]: Checkpoints retain their full history.
            - 'button "Open checkpoint: Before copy" [ref=e445] [cursor=pointer]'
  - region "Prepared file" [ref=e447]:
    - paragraph [ref=e448]: Full-history copy · 52342 bytes · captured revision 5 · Destination write failed; local bytes retained
    - button "Download prepared file" [ref=e450] [cursor=pointer]
  - contentinfo [ref=e452]:
    - generic [ref=e453]: Accepted edits saved locally · Draft saved locally; not applied to the document
    - generic [ref=e454]: Checkpoint content current · Copy state current · External destination unconfirmed
  - generic:
    - paragraph: Import → review → Apply → edit → Undo → Save copy → reopen → Export image.
    - paragraph: Cmd/Ctrl+S saves a checkpoint; Shift+Cmd/Ctrl+S prepares a full-history copy; Cmd/Ctrl+O opens a local document or portable file. Native fields keep their own undo and clipboard shortcuts.
    - paragraph: "Canvas: H Pan, +/− zoom, 0 Fit. Use numeric view fields without a pointer. Conversion, resample and flatten review require Apply."
    - paragraph: Restart the launcher on the same private root, pair, then open recovered documents. An expired review needs a fresh review. Accepted commands and originals stay retained.
  - generic:
    - generic:
      - button "Cancel"
  - generic:
    - generic:
      - generic:
        - button "Cancel review"
      - generic:
        - button "Apply reviewed result" [disabled]
```

# Test source

```ts
  1  | import {test,expect,type Page} from '@playwright/test';
  2  | import {mkdtemp,realpath,readFile,writeFile} from 'node:fs/promises';
  3  | import {tmpdir} from 'node:os';
  4  | import {join} from 'node:path';
  5  | import sharp from 'sharp';
  6  | import {serverProcess} from './process.js';
  7  | // Test archive reader is independent of the browser adapter; small fixture only.
  8  | // @ts-ignore
  9  | import {unpack,records} from '../portable/archive-fixture.mjs';
  10 | const accepted=(page:Page,type:string)=>expect(page.getByText(type+' accepted and saved locally.',{exact:true})).toBeVisible();
  11 | const click=(page:Page,name:string)=>page.getByRole('button',{name,exact:true}).click();
  12 | const receipt=process.env.EDITOR_RECEIPT??'artifacts/p1b7/current';
> 13 | async function download(page:Page,path:string){const received=page.waitForEvent('download');await click(page,'Download prepared file');await (await received).saveAs(path);await expect(page.getByText(/External destination remains unconfirmed/)).toBeVisible();}
     |                                                                    ^ TimeoutError: page.waitForEvent: Timeout 10000ms exceeded while waiting for event "download"
  14 | test('E1 browser copy, actual process restart/new port, reviewed reopen and exact downloaded PNG',async({page,context})=>{
  15 |  const directory=await mkdtemp(join(await realpath(tmpdir()),'ie-browser-e1-')),root=join(directory,'private');let server=await serverProcess(root);const errors:string[]=[],requests:string[]=[],expectedFailures:string[]=[];let disrupting=false;
  16 |  await context.addInitScript(()=>Object.defineProperty(window,'showSaveFilePicker',{value:undefined,configurable:true}));
  17 |  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'){if(disrupting&&/ERR_INCOMPLETE_CHUNKED_ENCODING|ERR_CONNECTION_REFUSED|ERR_EMPTY_RESPONSE/.test(m.text()))expectedFailures.push(m.text());else errors.push(m.text());}});
  18 |  page.on('request',r=>{const u=new URL(r.url());if(u.protocol!=='blob:'){requests.push(u.pathname);expect(u.hostname).toBe('127.0.0.1');}});
  19 |  try{
  20 |  await page.goto(await server.pair());await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();disrupting=false;
  21 |  await page.locator('en-file-upload input[type=file]').setInputFiles('tests/raster/fixtures/hidden-alpha.png');await expect(page.getByRole('dialog',{name:'Review image conversion'})).toBeVisible();await click(page,'Apply reviewed result');await accepted(page,'ImportAsset');
  22 |  await page.getByRole('treeitem').first().click();await page.getByRole('spinbutton',{name:'Opacity (0–1)',exact:true}).fill('0.5');await click(page,'Apply properties');await accepted(page,'SetLayerProperties');await click(page,'Undo');await accepted(page,'Undo');
  23 |  await page.getByRole('textbox',{name:'Prompt',exact:true}).fill('日本語 🌿 retained unapplied prompt');await page.getByRole('textbox',{name:'Prompt',exact:true}).blur();await expect(page.getByText('Draft saved locally; not applied to the document').first()).toBeVisible();
  24 |  await page.getByRole('textbox',{name:'Checkpoint name',exact:true}).fill('Before copy');await click(page,'Save checkpoint');await accepted(page,'SaveCheckpoint');
  25 |  await click(page,'Save copy');await click(page,'Prepare complete copy');await expect(page.getByRole('region',{name:'Prepared file'})).toBeVisible();
  26 |  const bundlePath=join(directory,'project.ideogram-project');await download(page,bundlePath);const entries=await unpack(directory,await readFile(bundlePath)),all=records(entries).values;
  27 |  const events=records(entries,'events').values.map((x:any)=>x.event);expect(events.some((e:any)=>e.type==='HistoryNavigated')).toBe(true);expect(events.some((e:any)=>e.type==='CheckpointSaved')).toBe(true);
  28 |  const entities=all.filter((x:any)=>x.kind==='entity').map((x:any)=>({kind:x.entityType,value:JSON.parse(entries.get('objects/'+x.payloadRef.hash.slice(7)))}));
  29 |  expect(entities.filter((x:any)=>x.kind==='history').length).toBe(3);expect(entities.filter((x:any)=>x.kind==='checkpoint').length).toBe(1);expect(entities.some((x:any)=>x.kind==='draft')).toBe(true);
  30 |  const originalPixels=await sharp('tests/raster/fixtures/hidden-alpha.png').ensureAlpha().raw().toBuffer();
  31 |  const effects=await server.effects();expect(Object.values(effects).every(v=>v===0)).toBe(true);const oldOrigin=server.origin,oldPid=server.pid;disrupting=true;await server.kill();
  32 |  server=await serverProcess(root);expect(server.pid).not.toBe(oldPid);expect(server.origin).not.toBe(oldOrigin);await page.goto(await server.pair());await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();disrupting=false;
  33 |  expect(await page.evaluate(async()=> (await indexedDB.databases()).filter(d=>d.name?.startsWith('ie-delivery-')).length)).toBe(1);
  34 |  await click(page,'Open');await page.getByRole('button',{name:/^Restore ui_/}).click();await expect(page.getByRole('textbox',{name:'Prompt',exact:true})).toHaveValue('日本語 🌿 retained unapplied prompt');
  35 |  await click(page,'Open');await page.locator('en-file-upload').filter({has:page.getByText('Open portable project',{exact:true})}).locator('input[type=file]').setInputFiles(bundlePath);
  36 |  await expect(page.getByRole('dialog',{name:'Review portable project'})).toBeVisible();await click(page,'Apply reviewed result');await accepted(page,'ImportBundle');
  37 |  await click(page,'Export image');await expect(page.getByRole('region',{name:'Prepared file'})).toContainText('Exact PNG');const pngPath=join(directory,'image.png');await download(page,pngPath);expect(await sharp(pngPath).ensureAlpha().raw().toBuffer()).toEqual(originalPixels);
  38 |  disrupting=true;await server.kill();server=await serverProcess(root);await page.goto(await server.pair());await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();disrupting=false;
  39 |  await click(page,'Open');const mapped=page.getByRole('button',{name:/^Restore p_/});await expect(mapped).not.toHaveCount(0);
  40 |  await mapped.click();await expect(page.getByRole('textbox',{name:'Prompt',exact:true})).toHaveValue('日本語 🌿 retained unapplied prompt');
  41 |  await click(page,'Save copy');await click(page,'Prepare complete copy');const nestedPath=join(directory,'nested.ideogram-project');await download(page,nestedPath);const nested=await readFile(nestedPath);expect(nested.includes(await readFile(bundlePath))).toBe(true);
  42 |  // New drafts on mapped IDs must obey the same bounded ID contract. Existing
  43 |  // mapped saved drafts retain their original identities and exact text.
  44 |  const newDrafts:any[]=[];page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/v1/ui/')&&r.method()==='POST'){const b=JSON.parse(r.postData()!).body;if(b.type==='SaveDraft'&&b.draft.kind==='inspector')newDrafts.push(b.draft);}});
  45 |  await page.getByRole('treeitem').first().click();await page.getByRole('textbox',{name:'Layer name',exact:true}).fill('Editable after portable reopen');await click(page,'Apply properties');await accepted(page,'SetLayerProperties');expect(newDrafts.length).toBeGreaterThan(0);expect(newDrafts.every(d=>d.id.length<=128&&d.documentId.startsWith('p_')&&d.targetLayerId.startsWith('p_'))).toBe(true);await page.reload();await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();await expect(page.getByRole('treeitem',{name:'Editable after portable reopen · visible'})).toBeVisible();
  46 |  await expect(page.getByText(/Updates interrupted/)).toHaveCount(0);expect(errors).toEqual([]);expect(Object.values(await server.effects()).every(v=>v===0)).toBe(true);
  47 |  await writeFile(join(receipt,'e1.json'),JSON.stringify({expectedFailures,oldPid,newPid:server.pid,oldOrigin,newOrigin:server.origin,networkPaths:[...new Set(requests)],providerEffects:effects,downloadedBundleBytes:(await readFile(bundlePath)).length,sourceEvents:events.length,sourceEntities:entities.length,exactPixels:true,externalDestination:'unconfirmed',osPicker:'not exercised; real browser fallback download tested'},null,2));
  48 |  await page.screenshot({path:join(receipt,'e1.png')});
  49 |  }finally{await server.close();}
  50 | });
  51 | 
```