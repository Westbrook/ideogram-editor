# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tool-rail.spec.ts >> public rail restores icon-over-label surfaces and native disabled, selected, keyboard and pointer behavior
- Location: tests/editor/tool-rail.spec.ts:9:1

# Error details

```
Error: expect(locator).toHaveCount(expected) failed

Locator:  getByRole('toolbar', { name: 'Canvas tools' }).getByRole('button')
Expected: 7
Received: 0
Timeout:  5000ms

Call log:
  - Expect "toHaveCount" getByRole('toolbar', { name: 'Canvas tools' }).getByRole('button') with timeout 5000ms
  - waiting for getByRole('toolbar', { name: 'Canvas tools' }).getByRole('button')
    14 × locator resolved to 0 elements
       - unexpected value "0"

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
      - generic [ref=e15]: No document open
    - group "Document actions" [ref=e17]:
      - generic:
        - button "New" [ref=e19] [cursor=pointer]
        - button "Open" [ref=e22] [cursor=pointer]
        - button "Import image" [ref=e25] [cursor=pointer]
        - button "Undo" [disabled] [ref=e28]
        - button "Redo" [disabled] [ref=e31]
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
      - button "Save copy" [disabled] [ref=e38]
      - button "Export image" [disabled] [ref=e41]
      - button "Help" [ref=e44] [cursor=pointer]
      - generic [ref=e46]: Shortcuts and recovery
  - region "Operation status" [ref=e47]:
    - status [ref=e48]: Local recovery complete. Accepted edits are saved locally.
    - paragraph [ref=e49]: Updates interrupted. Recovering complete transactions; the last valid view is retained.
    - button "Reconnect" [ref=e51] [cursor=pointer]
  - main "Image editor" [ref=e53]:
    - complementary [ref=e54]:
      - toolbar "Canvas tools" [ref=e56]:
        - generic:
          - button "Move" [disabled] [ref=e58]
          - button "Text" [disabled] [ref=e65]
          - button "Select" [disabled] [ref=e72]
          - button "Mask" [disabled] [ref=e79]
          - button "Crop" [disabled] [ref=e86]
          - button "Pan" [pressed] [ref=e93] [cursor=pointer]
          - button "Zoom" [ref=e100] [cursor=pointer]
    - generic [ref=e106]:
      - region "Request" [ref=e107]:
        - generic [ref=e108]:
          - heading "Request" [level=1] [ref=e109]
          - generic [ref=e110]: Draft
        - generic [ref=e111]:
          - generic [ref=e113]:
            - generic [ref=e114]: Operation
            - combobox "Operation" [ref=e117]:
              - button "Generate image" [ref=e118]
              - option "Generate image" [selected]
              - option "Generate with Instant"
              - option "Generate with Fast"
              - option "Transform image"
              - option "Edit masked region"
              - option "Generate with adapters"
              - option "Transform with adapters"
              - option "Edit with adapters"
          - generic [ref=e121]:
            - generic [ref=e122]: Prompt
            - textbox "Prompt" [ref=e125]:
              - /placeholder: Describe the image you have in mind…
            - generic [ref=e126]: Open a document to save this draft locally.
          - paragraph [ref=e129]: Draft has not been applied.
          - heading "Explicit inputs" [level=2] [ref=e130]
          - paragraph [ref=e131]: Selecting a layer does not attach it to a request. Source, mask, adapters and generation are not available in this version.
          - button "Generate" [disabled] [ref=e133]
          - paragraph [ref=e135]: Native text, mask drawing and composition authoring are not available yet.
      - separator "Request panel width" [ref=e136]
      - generic [ref=e139]:
        - region "Canvas" [ref=e140]:
          - generic [ref=e141]:
            - generic [ref=e142]: Pan · no document
            - generic [ref=e144]:
              - generic [ref=e145]: Zoom percentage
              - generic [ref=e147]:
                - button "Decrease value" [ref=e148] [cursor=pointer]:
                  - generic [aria-hidden] [ref=e151]: −
                - spinbutton "Zoom percentage" [ref=e152]: "100"
                - button "Increase value" [ref=e153] [cursor=pointer]:
                  - generic [aria-hidden] [ref=e156]: +
            - button "Fit" [disabled] [ref=e158]
            - button "100%" [disabled] [ref=e161]
          - generic [ref=e163]:
            - generic "Document raster preview" [ref=e164]
            - generic [ref=e165]:
              - heading "A little room to create." [level=2] [ref=e166]
              - paragraph [ref=e167]: Choose or drop an image, then review before Apply.
              - generic [ref=e169]:
                - generic [ref=e170]: Import an image
                - generic [ref=e172]:
                  - generic [aria-hidden] [ref=e173]: Choose image
                  - generic [aria-hidden] [ref=e174]: or drop files here
                  - button "Import an image" [ref=e175] [cursor=pointer]
              - paragraph [ref=e176]: PNG, JPEG or static WebP. Original bytes are retained.
          - generic [ref=e177]:
            - generic [ref=e178]: No image accepted
            - generic [ref=e179]: Paste an image here to review
          - generic [ref=e180]:
            - generic [ref=e182]:
              - generic [ref=e183]: View X (px)
              - generic [ref=e185]:
                - button "Decrease value" [ref=e186] [cursor=pointer]:
                  - generic [aria-hidden] [ref=e189]: −
                - spinbutton "View X (px)" [ref=e190]: "0"
                - button "Increase value" [ref=e191] [cursor=pointer]:
                  - generic [aria-hidden] [ref=e194]: +
            - generic [ref=e196]:
              - generic [ref=e197]: View Y (px)
              - generic [ref=e199]:
                - button "Decrease value" [ref=e200] [cursor=pointer]:
                  - generic [aria-hidden] [ref=e203]: −
                - spinbutton "View Y (px)" [ref=e204]: "0"
                - button "Increase value" [ref=e205] [cursor=pointer]:
                  - generic [aria-hidden] [ref=e208]: +
            - button "Apply view" [ref=e210] [cursor=pointer]
        - separator "Canvas and inspector width" [ref=e212]
        - complementary "Layers and properties" [ref=e215]:
          - generic [ref=e217]:
            - tablist "Document structure" [ref=e218]:
              - generic:
                - tab "Layers" [selected] [ref=e219] [cursor=pointer]
                - tab "Composition" [ref=e221] [cursor=pointer]
            - tabpanel "Layers" [ref=e224]:
              - generic [ref=e225]:
                - generic:
                  - generic [ref=e226]:
                    - generic:
                      - tree "Image layers"
                  - paragraph [ref=e227]: No layers yet. Import an image to begin.
                  - generic [ref=e228]:
                    - button "Duplicate" [disabled] [ref=e230]
                    - button "Delete layer" [disabled] [ref=e233]
                    - button "Move up" [disabled] [ref=e236]
                    - button "Move down" [disabled] [ref=e239]
          - generic [ref=e241]:
            - heading "Image properties" [level=2] [ref=e242]
            - paragraph [ref=e243]: Select a layer to inspect it.
            - generic [ref=e244]:
              - button "Canvas bounds…" [disabled] [ref=e246]
              - button "Flatten copy…" [disabled] [ref=e249]
  - region "Activity" [ref=e251]:
    - generic [ref=e252]:
      - heading "Activity" [level=2] [ref=e253]
      - button "Collapse" [ref=e255] [cursor=pointer]
    - generic [ref=e258]:
      - tablist "Activity views" [ref=e259]:
        - generic:
          - tab "Results" [ref=e260] [cursor=pointer]
          - tab "Jobs" [ref=e262] [cursor=pointer]
          - tab "History" [selected] [ref=e264] [cursor=pointer]
      - tabpanel "History" [ref=e267]:
        - generic [ref=e268]:
          - generic:
            - generic [ref=e270]:
              - region "Retained document history":
                - list "Retained document history"
              - navigation "Retained document history pages" [ref=e271]:
                - button "Newer page" [disabled] [ref=e273]
                - generic [ref=e275]: Page 1 of 1
                - button "Older page" [disabled] [ref=e277]
              - generic [ref=e279]: No activity yet.
              - status [ref=e281]
              - button "Load older activity" [disabled] [ref=e283]
            - generic [ref=e285]:
              - generic [ref=e287]:
                - generic [ref=e288]: Checkpoint name
                - textbox "Checkpoint name" [ref=e291]: My checkpoint
              - button "Save checkpoint" [disabled] [ref=e293]
            - paragraph [ref=e295]: Checkpoints retain their full history.
  - contentinfo [ref=e296]:
    - generic [ref=e297]: Accepted edits saved locally · No local draft change
    - generic [ref=e298]: No document checkpoint · No portable copy · External destination unconfirmed
```

# Test source

```ts
  1  | import {test,expect,type Page} from '@playwright/test';
  2  | import {mkdtemp,realpath,mkdir} from 'node:fs/promises';
  3  | import {tmpdir} from 'node:os';
  4  | import {join} from 'node:path';
  5  | import {serverProcess} from './process.js';
  6  | const receipt=process.env.EDITOR_RECEIPT??'artifacts/p1b7/current';
  7  | async function setup(page:Page){const dir=await mkdtemp(join(await realpath(tmpdir()),'ie-rail-'));const server=await serverProcess(join(dir,'private'));await page.goto(await server.pair());await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();return server;}
  8  | async function geometry(page:Page){return page.locator('.tool').evaluateAll(hosts=>hosts.map(host=>{const control=host.shadowRoot!.querySelector<HTMLElement>('[part~=control]')!,b=control.getBoundingClientRect(),icon=host.querySelector('svg')!.getBoundingClientRect(),label=host.querySelector('[slot=label]')!.getBoundingClientRect(),s=getComputedStyle(control);return {name:host.textContent!.trim(),width:b.width,height:b.height,iconBottom:icon.bottom,labelTop:label.top,centerDifference:Math.abs(icon.x+icon.width/2-label.x-label.width/2),background:s.backgroundColor,border:s.borderColor,fontSize:parseFloat(s.fontSize),weight:s.fontWeight,radius:parseFloat(s.borderRadius),opacity:s.opacity};}));}
  9  | test('public rail restores icon-over-label surfaces and native disabled, selected, keyboard and pointer behavior',async({page})=>{
  10 |  const server=await setup(page),commands:string[]=[];page.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname==='/api/v1/commands')commands.push(r.postData()!);});
  11 |  try{
  12 |  const rail=page.getByRole('toolbar',{name:'Canvas tools'}),pan=rail.getByRole('button',{name:'Pan',exact:true}),zoom=rail.getByRole('button',{name:'Zoom',exact:true});
> 13 |  await expect(rail.getByRole('button')).toHaveCount(7);await expect(pan).toHaveAttribute('aria-pressed','true');
     |                                         ^ Error: expect(locator).toHaveCount(expected) failed
  14 |  const initial=await geometry(page);expect(initial.map(x=>x.name)).toEqual(['Move','Text','Select','Mask','Crop','Pan','Zoom']);
  15 |  for(const g of initial){expect(g.width).toBeGreaterThanOrEqual(44);expect(g.height).toBeGreaterThanOrEqual(48);expect(g.width).toBeLessThanOrEqual(48);expect(g.iconBottom).toBeLessThan(g.labelTop);expect(g.centerDifference).toBeLessThan(1);expect(g.fontSize).toBe(9);expect(g.weight).toBe('500');}
  16 |  for(const name of ['Move','Text','Select','Mask','Crop']){const disabled=rail.getByRole('button',{name,exact:true});await expect(disabled).toBeDisabled();const b=(await disabled.boundingBox())!;await page.mouse.click(b.x+b.width/2,b.y+b.height/2);await expect(pan).toHaveAttribute('aria-pressed','true');const g=initial.find(x=>x.name===name)!;expect(g.background).toBe('rgba(0, 0, 0, 0)');expect(g.border).toBe('rgba(0, 0, 0, 0)');}
  17 |  expect(initial.find(x=>x.name==='Zoom')!.border).toBe('rgba(0, 0, 0, 0)');expect(initial.find(x=>x.name==='Pan')!.background).not.toBe('rgba(0, 0, 0, 0)');expect(initial.find(x=>x.name==='Pan')!.radius).toBeGreaterThan(0);
  18 |  await mkdir(receipt,{recursive:true});await page.locator('.tool-rail').screenshot({path:join(receipt,'rail-desktop.png')});
  19 |  await pan.focus();await page.keyboard.press('ArrowDown');await expect(zoom).toBeFocused();await page.keyboard.press('Enter');await expect(zoom).toHaveAttribute('aria-pressed','true');await expect(pan).toHaveAttribute('aria-pressed','false');
  20 |  await page.keyboard.press('ArrowUp');await expect(pan).toBeFocused();await page.keyboard.press('Space');await expect(pan).toHaveAttribute('aria-pressed','true');
  21 |  const b=(await zoom.boundingBox())!;await page.mouse.click(b.x+2,b.y+2);await expect(zoom).toHaveAttribute('aria-pressed','true');await pan.click();await page.keyboard.press('Tab');await expect(rail.locator(':focus')).toHaveCount(0);
  22 |  expect(commands).toEqual([]);expect(Object.values(await server.effects()).every(v=>v===0)).toBe(true);
  23 |  }finally{await server.close();}
  24 | });
  25 | test('rail keeps full targets and visible labels at narrow and RTL reflow',async({page})=>{
  26 |  const server=await setup(page);try{for(const width of [720,320]){await page.setViewportSize({width,height:850});for(const direction of ['ltr','rtl']){await page.evaluate(dir=>document.documentElement.dir=dir,direction);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);for(const g of await geometry(page)){expect(g.width).toBeGreaterThanOrEqual(44);expect(g.height).toBeGreaterThanOrEqual(48);expect(g.iconBottom).toBeLessThan(g.labelTop);}
  27 |  const zoom=page.getByRole('button',{name:'Zoom',exact:true});await zoom.click();await expect(zoom).toHaveAttribute('aria-pressed','true');await page.getByRole('button',{name:'Pan',exact:true}).click();await page.locator('.tool-rail').screenshot({path:join(receipt,`rail-${width}-${direction}.png`)});}}
  28 |  }finally{await server.close();}
  29 | });
  30 | 
```