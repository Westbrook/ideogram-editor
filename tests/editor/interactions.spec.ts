import {confirmImageImports} from './image-import-flow.js';
import {prepareNativePNG} from './export-workflow.js';
import {test,expect,type Page} from '@playwright/test';
import {mkdtemp,realpath,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {serverProcess} from './process.js';
const click=(p:Page,name:string)=>p.getByRole('button',{name,exact:true}).click();
async function setup(page:Page){const dir=await mkdtemp(join(await realpath(tmpdir()),'ie-ui-'));const server=await serverProcess(join(dir,'private'));await page.goto(await server.pair());await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();return server;}
async function blankDocument(page:Page){
 await page.getByRole('button',{name:'New',exact:true}).click();
 const named=page.getByRole('dialog',{name:'New document',exact:true});await expect(named).toBeVisible();
 // The public host owns the slotted controls; the native dialog owns its name.
 const controls=page.locator('en-dialog#editor-dialog');
 for(const [name,value] of [['Width (px)','128'],['Height (px)','96']]){const field=controls.getByRole('spinbutton',{name,exact:true});await field.fill(value);await field.press('Tab');}
 await expect(controls.getByRole('combobox',{name:'Background',exact:true})).toHaveValue('transparent');
 await controls.getByRole('button',{name:'Create',exact:true}).click();await expect(named).toBeHidden();
 await expect(page.getByRole('button',{name:'Close document',exact:true})).toBeEnabled();
 await expect(page.getByRole('textbox',{name:'Prompt',exact:true})).toHaveValue('');
}
async function imported(page:Page){await page.locator('en-file-upload input[type=file]').setInputFiles('tests/raster/fixtures/hidden-alpha.png');await confirmImageImports(page,{names:['hidden-alpha.png'],destination:'new',close:false});await expect(page.getByText('ImportAsset accepted and saved locally.',{exact:true})).toBeVisible();const dialog=page.getByRole('dialog',{name:'Import image',exact:true});await page.locator('en-dialog#editor-dialog').getByRole('button',{name:'Open imported document',exact:true}).click();await page.locator('en-dialog#editor-dialog').getByRole('button',{name:'Cancel',exact:true}).click();await expect(dialog).toBeHidden();await page.getByRole('treeitem').first().click();}

test('public adapters, native editing, splitter full target, keyboard and logical direction',async({page})=>{
 const server=await setup(page);try{
 const left=page.locator('#left-divider');const geometry=()=>left.evaluate((host:any)=>{const b=host.getBoundingClientRect(),grip=host.shadowRoot.querySelector('[part~=grip]').getBoundingClientRect();return {host:b.width,grip:grip.width,track:getComputedStyle(host.parentElement).gridTemplateColumns.split(' ')[1],z:getComputedStyle(host).zIndex,margin:getComputedStyle(host).marginInlineStart,value:host.value};});
 let box=await left.boundingBox(),before=await geometry();expect(before.track).toBe('1px');expect(before.grip).toBe(1);expect(before.host).toBeGreaterThanOrEqual(24);expect(before.z).toBe('1');expect(parseFloat(before.margin)).toBe(-(before.host-1)/2);
 await page.mouse.move(box!.x+2,box!.y+70);await page.mouse.down();await page.mouse.move(box!.x+42,box!.y+70);await page.mouse.up();expect((await geometry()).value).toBeGreaterThan(before.value);
 const handle=page.getByRole('separator',{name:'Request panel width',exact:true});await handle.focus();before=await geometry();await page.keyboard.press('ArrowRight');expect((await geometry()).value).toBeGreaterThan(before.value);
 await page.evaluate(()=>document.documentElement.dir='rtl');before=await geometry();await page.keyboard.press('ArrowLeft');expect((await geometry()).value).toBeGreaterThan(before.value);await page.evaluate(()=>document.documentElement.dir='ltr');
 const operationHost=page.locator('en-select[label="Operation"]'),operation=operationHost.getByRole('combobox',{name:'Operation',exact:true});
 await operationHost.evaluate(host=>host.addEventListener('en-change',e=>e.preventDefault(),{once:true}));await operation.selectOption({label:'Generate with Fast'});await expect(operation).toHaveValue('Generate image');
 await imported(page);const prompt=page.getByRole('textbox',{name:'Prompt',exact:true});await prompt.fill('abc 日本語');await prompt.press('Home');await prompt.press('Shift+End');await expect(prompt).toHaveValue('abc 日本語');
 const revision=await page.locator('.document-name').textContent();await prompt.press('Meta+z');expect(await page.locator('.document-name').textContent()).toBe(revision);
 await page.locator('#canvas').focus();await page.keyboard.press('ArrowRight');await click(page,'100%');expect(await page.getByRole('spinbutton',{name:'Zoom percentage',exact:true}).inputValue()).toBe('100');
 }finally{await server.close();}
});

test('canvas paste, explicit cancel, reviewed resample and visible flatten with one command per Apply',async({page})=>{
 const server=await setup(page);const commands:string[]=[];page.on('request',r=>{if(new URL(r.url()).pathname==='/api/v1/commands'&&r.method()==='POST')commands.push(JSON.parse(r.postData()!).command.body.type);});
 try{
 const bytes=[...await readFile('tests/raster/fixtures/hidden-alpha.png')];await page.locator('#canvas').evaluate((host,bytes)=>{const transfer=new DataTransfer();transfer.items.add(new File([new Uint8Array(bytes)],'pasted.png',{type:'image/png'}));const event=new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true});if(event.clipboardData!==transfer)Object.defineProperty(event,'clipboardData',{value:transfer});host.dispatchEvent(event);},bytes);
 const pasteDialog=page.getByRole('dialog',{name:'Import image',exact:true});await expect(pasteDialog).toBeVisible();const pasteChoice=page.locator('en-dialog#editor-dialog').getByRole('switch',{name:'Import pasted.png',exact:true});await expect(pasteChoice).toBeEnabled();await expect(pasteChoice).not.toBeChecked();await page.locator('en-dialog#editor-dialog').getByRole('button',{name:'Cancel',exact:true}).click();await expect(pasteDialog).toBeHidden();await expect(page.getByText('No document open',{exact:true})).toBeVisible();expect(commands).not.toContain('ApproveRaster');await imported(page);
 await click(page,'Resample image…');await page.getByRole('spinbutton',{name:'Intrinsic width (px)',exact:true}).fill('6');await page.getByRole('spinbutton',{name:'Intrinsic height (px)',exact:true}).fill('4');await click(page,'Prepare preview');await expect(page.getByRole('dialog',{name:'Review prepared image edit'})).toBeVisible();const count=commands.filter(x=>x==='ResampleImage').length;await click(page,'Apply reviewed result');await expect(page.getByText('ResampleImage accepted and saved locally.',{exact:true})).toBeVisible();expect(commands.filter(x=>x==='ResampleImage').length).toBe(count+1);
 await click(page,'Flatten copy…');await click(page,'Prepare preview');await click(page,'Apply reviewed result');await expect(page.getByText('CreateFlattenedCopy accepted and saved locally.',{exact:true})).toBeVisible();await expect(page.getByRole('treeitem')).toHaveCount(2);
 }finally{await server.close();}
});

test('multi-tab convergence preserves a stale inspector draft and recovers accepted transactions',async({page,context})=>{
 const server=await setup(page);try{await imported(page);const second=await context.newPage();await second.goto(server.origin);await expect(second.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();await second.getByRole('treeitem').first().click();
 await second.getByRole('textbox',{name:'Layer name',exact:true}).fill('Other tab unapplied');await page.getByRole('spinbutton',{name:'Opacity (0–1)',exact:true}).fill('0.7');await click(page,'Apply properties');await expect(page.getByText('SetLayerProperties accepted and saved locally.',{exact:true})).toBeVisible();await expect(second.locator('.document-name')).toHaveText(await page.locator('.document-name').textContent()??'');await expect(second.getByRole('textbox',{name:'Layer name',exact:true})).toHaveValue('Other tab unapplied');await click(second,'Apply properties');await expect(second.getByText(/Stale conflict/)).toBeVisible();await expect(second.getByRole('textbox',{name:'Layer name',exact:true})).toHaveValue('Other tab unapplied');await second.close();
 }finally{await server.close();}
});

test('320px and 200-percent-equivalent reflow keep controls and native focus reachable',async({page})=>{
 const server=await setup(page);try{await blankDocument(page);for(const width of [720,320]){await page.setViewportSize({width,height:850});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await click(page,'Show request');await expect(page.getByRole('textbox',{name:'Prompt',exact:true})).toBeVisible();await page.getByRole('textbox',{name:'Prompt',exact:true}).fill('reflow draft');await click(page,'Hide request');await click(page,'Show layers');await expect(page.locator('#inspector')).toBeVisible();await expect(page.locator('#layer-tree').getByRole('treeitem')).toHaveCount(0);await click(page,'Hide layers');}
 }finally{await server.close();}
});

test('intermediate drawers preserve native node, value, selection and composition across reflow',async({page})=>{
 const server=await setup(page);try{await blankDocument(page);
 const prompt=page.getByRole('textbox',{name:'Prompt',exact:true});await prompt.fill('Retained selection 日本語');await prompt.evaluate((node:any)=>{(window as any).originalPrompt=node;node.focus();node.setSelectionRange(2,7);node.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,composed:true}));});
 await page.setViewportSize({width:950,height:850});expect(await prompt.evaluate(node=>node===(window as any).originalPrompt)).toBe(true);await expect(page.getByRole('dialog',{name:'Request panel',exact:true})).toHaveCount(0);
 await prompt.evaluate(node=>node.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,composed:true})));await expect(page.getByRole('dialog',{name:'Request panel',exact:true})).toBeVisible();expect(await prompt.evaluate((node:any)=>({same:node===(window as any).originalPrompt,selection:[node.selectionStart,node.selectionEnd],focused:node.getRootNode().activeElement===node}))).toEqual({same:true,selection:[2,7],focused:true});
 await page.keyboard.press('Escape');await expect(page.getByRole('dialog',{name:'Request panel',exact:true})).toHaveCount(0);await click(page,'Show request');await expect(prompt).toHaveValue('Retained selection 日本語');await prompt.focus();await page.setViewportSize({width:320,height:850});await expect(page.getByRole('dialog',{name:'Request panel',exact:true})).toHaveCount(0);await expect(prompt).toBeFocused();expect(await prompt.evaluate(node=>node===(window as any).originalPrompt)).toBe(true);
 await page.setViewportSize({width:950,height:850});await expect(page.getByRole('dialog',{name:'Request panel',exact:true})).toBeVisible();await page.keyboard.press('Escape');await click(page,'Show layers');await expect(page.getByRole('dialog',{name:'Layers and properties panel',exact:true})).toBeVisible();await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:'Show layers',exact:true})).toBeFocused();
 }finally{await server.close();}
});

test('canvas drop, selected flatten, typed transform/crop and retained branch/checkpoint actions',async({page})=>{
 const server=await setup(page);try{await imported(page);
 const bytes=[...await readFile('tests/raster/fixtures/white.png')];await page.locator('#canvas').evaluate((host,bytes)=>{const transfer=new DataTransfer();transfer.items.add(new File([new Uint8Array(bytes)],'drop.png',{type:'image/png'}));host.dispatchEvent(new DragEvent('drop',{dataTransfer:transfer,bubbles:true,cancelable:true}));},bytes);await expect(page.getByRole('dialog',{name:'Import image',exact:true})).toBeVisible();await expect(page.getByRole('treeitem')).toHaveCount(1);await confirmImageImports(page,{names:['drop.png'],destination:'current'});await expect(page.getByText('ImportAsset accepted and saved locally.',{exact:true})).toBeVisible();await expect(page.getByRole('treeitem')).toHaveCount(2);await page.getByRole('treeitem').first().click();
 await page.getByRole('spinbutton',{name:'X (document px)',exact:true}).fill('1');await click(page,'Apply transform');await expect(page.getByText('ApplyTransform accepted and saved locally.',{exact:true})).toBeVisible();await click(page,'Canvas bounds…');await page.getByRole('combobox',{name:'Bounds action',exact:true}).selectOption('crop');await page.getByRole('spinbutton',{name:'Width (px)',exact:true}).fill('2');await page.getByRole('spinbutton',{name:'Height (px)',exact:true}).fill('2');await click(page,'Apply bounds');await expect(page.locator('.document-name')).toContainText('2 × 2');
 await page.getByRole('textbox',{name:'Checkpoint name',exact:true}).fill('Cropped');await click(page,'Save checkpoint');await expect(page.getByText('SaveCheckpoint accepted and saved locally.',{exact:true})).toBeVisible();await click(page,'Flatten copy…');await page.getByRole('combobox',{name:'Flatten scope',exact:true}).selectOption('selected');await click(page,'Prepare preview');await click(page,'Apply reviewed result');await expect(page.getByText('CreateFlattenedCopy accepted and saved locally.',{exact:true})).toBeVisible();await expect(page.getByRole('treeitem')).toHaveCount(3);
 await click(page,'Undo');await expect(page.getByText('Undo accepted and saved locally.',{exact:true})).toBeVisible();await click(page,'Redo');await expect(page.getByText('Redo accepted and saved locally.',{exact:true})).toBeVisible();await click(page,'Open checkpoint: Cropped');await expect(page.getByText('SwitchBranch accepted and saved locally.',{exact:true})).toBeVisible();await expect(page.getByRole('treeitem')).toHaveCount(2);
 await page.getByRole('button',{name:'Open this history state',exact:true}).last().click();await expect(page.getByText('SwitchBranch accepted and saved locally.',{exact:true})).toBeVisible();
 }finally{await server.close();}
});

test('browser writable close acknowledges saved bytes; canceled picker retains prepared bytes and prior destination',async({page})=>{
 const server=await setup(page);try{await imported(page);await prepareNativePNG(page);
 const probe=await page.evaluate(async()=>{let stage='directory';try{const root=await navigator.storage.getDirectory();stage='file';const file=await root.getFileHandle('probe.tmp',{create:true});stage='createWritable';const sink=await file.createWritable();stage='write';await sink.write(new Uint8Array([1]).buffer);stage='close';await sink.close();return {ok:true};}catch(e:any){return {ok:false,stage,name:e.name,message:e.message};}});console.log('standalone OPFS probe',probe);
 // Public destination adapter with a real browser-owned writable file. This
 // tests close acknowledgment, not a native OS picker or external filesystem.
 await page.evaluate(()=>Object.defineProperty(window,'showSaveFilePicker',{configurable:true,value:async()=>{const root=await navigator.storage.getDirectory();return root.getFileHandle('destination-test.png',{create:true});}}));await click(page,'100%');await click(page,'Choose destination and save');if(!probe.ok){await expect(page.getByRole('region',{name:'Prepared file'})).toContainText('Destination write failed; local bytes retained');await expect(page.getByText('Saved to destination: browser write completed.',{exact:true})).toHaveCount(0);console.log('Browser storage unavailable: failure state verified; successful write/export NOT qualified for this engine.',probe);return;}await expect(page.getByText('Saved to destination: browser write completed.',{exact:true})).toBeVisible();const png=await page.evaluate(async()=>[...new Uint8Array(await(await(await navigator.storage.getDirectory()).getFileHandle('destination-test.png')).getFile().then(f=>f.arrayBuffer()))]);expect(Buffer.from(png).subarray(0,8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
 await page.evaluate(()=>Object.defineProperty(window,'showSaveFilePicker',{configurable:true,value:()=>Promise.reject(new DOMException('User canceled destination','AbortError'))}));await click(page,'Choose destination and save');
 const prepared=page.getByRole('region',{name:'Prepared file',exact:true});await expect(page.getByRole('region',{name:'Operation status',exact:true}).getByText('Destination write canceled. Prepared bytes and previous destination files are retained.',{exact:true})).toBeVisible();await expect(prepared).toContainText('Ready — destination unconfirmed');await expect(page.getByText('Saved to destination: browser write completed.',{exact:true})).toHaveCount(0);await expect(prepared.getByRole('button',{name:'Choose destination and save',exact:true})).toBeEnabled();
 const retained=await page.evaluate(async()=>[...new Uint8Array(await(await(await navigator.storage.getDirectory()).getFileHandle('destination-test.png')).getFile().then(f=>f.arrayBuffer()))]);expect(retained).toEqual(png);
 }finally{await server.close();}
});

test('Help uses persistent information and public drawer without component CSP violations',async({page})=>{
 const server=await setup(page),violations:string[]=[],errors:string[]=[];try{await page.exposeFunction('recordHelpCSP',(value:string)=>violations.push(value));await page.evaluate(()=>document.addEventListener('securitypolicyviolation',e=>(window as any).recordHelpCSP(e.effectiveDirective)));page.on('pageerror',e=>errors.push(e.message));
 for(const width of [1440,950,320]){await page.setViewportSize({width,height:850});const help=page.getByRole('button',{name:'Help',exact:true});await expect(page.getByText('Shortcuts and recovery',{exact:true})).toBeVisible();await help.hover();await help.focus();expect(await page.locator('#help-trigger').evaluate((h:any)=>h.ariaDescribedByElements?.map((x:Element)=>x.textContent))).toEqual(['Shortcuts and recovery']);await help.click();await expect(page.getByRole('dialog',{name:'Editor help',exact:true})).toBeVisible();await page.keyboard.press('Escape');await expect(help).toBeFocused();}expect(violations).toEqual([]);expect(errors).toEqual([]);
 }finally{await server.close();}
});
