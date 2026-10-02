// Public browser controls against the built editor and isolated real writer.
import {expect,type Page} from '@playwright/test';
import {test} from './document-creation-fixture.js';
import {axeEvidence} from '../qualification/axe.js';
const search=(page:Page)=>page.getByRole('dialog',{name:'Command search',exact:true});
// The native dialog owns modal semantics; slotted controls remain host descendants.
const searchContent=(page:Page)=>page.locator('en-dialog#command-search-dialog');
const editorContent=(page:Page)=>page.locator('en-dialog#editor-dialog');
const helpContent=(page:Page)=>page.locator('en-drawer#help-drawer');
// Visible feedback and the dedicated live region are separate public surfaces.
async function requestFeedback(page:Page,text:string,announcement=text){
 const region=page.getByRole('region',{name:'Typed request draft',exact:true}),group=region.getByRole('group',{name:'Request draft keyboard actions',exact:true}),feedback=group.locator(':scope > en-alert[announcement="none"]'),status=group.getByRole('status',{name:'Request status',exact:true});
 await expect(feedback).toHaveText(text);await expect(feedback).toBeVisible();await expect(status).toHaveText(announcement);await expect(status).toHaveAttribute('aria-live','polite');await expect(status).toHaveAttribute('aria-atomic','true');
}
// The toolbar role is inside the shadow root; its public buttons are slotted.
async function canvasTools(page:Page){const host=page.locator('en-toolbar[label="Canvas tools"]');await expect(host.getByRole('toolbar',{name:'Canvas tools',exact:true})).toBeVisible();return host;}
async function openSearch(page:Page){const trigger=page.getByRole('button',{name:'Command search',exact:true});await trigger.focus();await page.keyboard.press('Enter');const dialog=search(page);await expect(dialog).toBeVisible();await expect(searchContent(page).getByRole('textbox',{name:'Search commands',exact:true})).toBeFocused();return dialog;}

test('Command search exposes actual availability and keyboard routes to New and Help',async({local},info)=>{
  const {page,commands,record}=local,dialog=await openSearch(page),query=searchContent(page).getByRole('textbox',{name:'Search commands',exact:true});
  const evidence=await axeEvidence(page,info,local.output,['command-search-populated','command-search-unavailable','new-document-solid-fields','new-document-name-validation'],['Automated public-control and whole-document scan evidence only; native AT, native IME and incomplete axe findings require separate manual adjudication.']);await evidence.scan('command-search-populated');
  await query.fill('export image');await page.keyboard.press('ArrowDown');const unavailable=searchContent(page).getByRole('button',{name:'Export image',exact:true});await expect(unavailable).toBeFocused();await expect(unavailable).toHaveAttribute('aria-disabled','true');await expect(searchContent(page).getByText('Open or create a document first.',{exact:true})).toBeVisible();await evidence.scan('command-search-unavailable');
  await page.keyboard.press('Enter');await expect(dialog).toBeVisible();expect(commands).toEqual([]);await page.keyboard.press('ArrowUp');await expect(query).toBeFocused();
  await query.fill('not-a-real-editor-command');await expect(searchContent(page).getByText('No matching commands. Change the search text.',{exact:true})).toBeVisible();await page.keyboard.press('Enter');expect(commands).toEqual([]);
  await query.fill('new document');await page.keyboard.press('Enter');await expect(dialog).toBeHidden();const creation=page.getByRole('dialog',{name:'New document',exact:true});await expect(creation).toBeVisible();await expect(editorContent(page).getByRole('textbox',{name:'Document name',exact:true})).toBeFocused();expect(commands).toEqual([]);
  await editorContent(page).getByRole('combobox',{name:'Background',exact:true}).selectOption('solid');await expect(editorContent(page).getByRole('textbox',{name:'Background color (opaque sRGB hex)',exact:true})).toBeVisible();await evidence.scan('new-document-solid-fields');await editorContent(page).getByRole('textbox',{name:'Document name',exact:true}).fill('');await editorContent(page).getByRole('button',{name:'Create',exact:true}).click();await expect(editorContent(page).getByRole('textbox',{name:'Document name',exact:true})).toBeFocused();await evidence.scan('new-document-name-validation');
  await editorContent(page).getByRole('button',{name:'Cancel',exact:true}).click();await expect(creation).toBeHidden();
  await openSearch(page);await query.fill('editor help');await page.keyboard.press('ArrowDown');await expect(searchContent(page).getByRole('button',{name:'Editor help',exact:true})).toBeFocused();await page.keyboard.press('Enter');await expect(dialog).toBeHidden();await expect(page.getByRole('dialog',{name:'Editor help',exact:true})).toBeVisible();await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:'Command search',exact:true})).toBeFocused();expect(commands).toEqual([]);
  await evidence.finish();await record('command-search-keyboard',{unavailable:'Export image: no open document',emptyResults:true,newDialogOpened:true,helpOpened:true,focusRestored:true,commands});
});

test('Command search opens Storage library by keyboard without an open document',async({local})=>{
  const {page,commands,record}=local;await expect(page.getByText('No document open',{exact:true})).toBeVisible();
  const dialog=await openSearch(page),query=searchContent(page).getByRole('textbox',{name:'Search commands',exact:true});
  await query.fill('storage library');await expect(searchContent(page).getByRole('button',{name:'Storage library',exact:true})).toHaveAttribute('aria-disabled','false');
  await query.press('Enter');await expect(dialog).toBeHidden();const library=page.getByRole('dialog',{name:'Storage library',exact:true});await expect(library).toBeVisible();
  await expect(editorContent(page).getByRole('table',{name:'Known content by category',exact:true})).toBeVisible();await expect(editorContent(page)).toContainText('Categories can overlap');expect(commands).toEqual([]);
  await editorContent(page).getByRole('button',{name:'Close',exact:true}).click();await expect(library).toBeHidden();await expect(page.getByText('No document open',{exact:true})).toBeVisible();expect(commands).toEqual([]);
  await record('command-search-storage',{documentless:true,keyboardRoute:'Enter',inventory:'Known content by category',closed:true,commands});
});

test('Command search bounds its native query and honors a later click veto',async({local})=>{
  const {page,commands,record}=local,dialog=await openSearch(page),query=searchContent(page).getByRole('textbox',{name:'Search commands',exact:true});
  await expect(query).toHaveAttribute('maxlength','256');await query.fill('x'.repeat(300));expect((await query.inputValue()).length).toBeLessThanOrEqual(256);await expect(searchContent(page).getByText('No matching commands. Change the search text.',{exact:true})).toBeVisible();
  await query.fill('new document');const newCommand=searchContent(page).getByRole('button',{name:'New document',exact:true});
  // A documented DOM event veto is installed after the component's handlers.
  // It does not replace protocol responses or application state.
  await newCommand.evaluate(control=>control.addEventListener('click',event=>event.preventDefault(),{once:true}));await newCommand.click();await query.fill('editor help');await expect(query).toHaveValue('editor help');await expect(dialog).toBeVisible();await expect(page.getByRole('dialog',{name:'New document',exact:true})).toHaveCount(0);expect(commands).toEqual([]);
  await query.fill('new document');await query.focus();await page.evaluate(()=>document.addEventListener('keydown',event=>{if(event.key==='Enter')event.preventDefault();},{once:true}));await query.press('Enter');await query.fill('editor help');await expect(query).toHaveValue('editor help');expect(commands).toEqual([]);
  await page.keyboard.press('Escape');await expect(dialog).toBeHidden();await expect(page.getByRole('button',{name:'Command search',exact:true})).toBeFocused();
  await openSearch(page);await expect(query).toHaveValue('');expect(commands).toEqual([]);await searchContent(page).getByRole('button',{name:'Close command search',exact:true}).click();await expect(page.getByRole('button',{name:'Command search',exact:true})).toBeFocused();
  await record('command-search-bounds-veto',{queryMaxLength:256,clickVetoHonored:true,lateKeyVetoHonored:true,reopenedQuery:'',commands});
});

test('Command search cannot undo initial solid creation and typing stays in the query',async({local})=>{
  const {page,commands,record}=local,name='Search '+ 'A'.repeat(249);await page.getByRole('button',{name:'New',exact:true}).click();const creation=page.getByRole('dialog',{name:'New document',exact:true});await expect(creation).toBeVisible();await editorContent(page).getByRole('textbox',{name:'Document name',exact:true}).fill(name);
  for(const name of ['Width (px)','Height (px)']){const field=editorContent(page).getByRole('spinbutton',{name,exact:true});await field.fill('2');await field.press('Tab');}await editorContent(page).getByRole('combobox',{name:'Background',exact:true}).selectOption('solid');await editorContent(page).getByRole('button',{name:'Create',exact:true}).click();await expect(creation).toBeHidden();
  const accepted=commands.filter(command=>command.body.type==='CreateDocument');expect(accepted).toHaveLength(1);const zoom=page.getByRole('spinbutton',{name:'Zoom percentage',exact:true}),beforeZoom=await zoom.inputValue(),before=commands.length;
  const dialog=await openSearch(page),query=searchContent(page).getByRole('textbox',{name:'Search commands',exact:true});await query.fill('undo');const undo=searchContent(page).getByRole('button',{name:'Undo',exact:true});await expect(undo).toHaveAttribute('aria-disabled','true');await query.press('ArrowDown');await page.keyboard.press('Enter');await expect(dialog).toBeVisible();expect(commands).toHaveLength(before);
  await query.focus();await query.fill('');await query.pressSequentially('h+-0?');await expect(query).toHaveValue('h+-0?');await page.keyboard.press('Escape');await expect(dialog).toBeHidden();await expect(zoom).toHaveValue(beforeZoom);expect(commands).toHaveLength(before);
  const current=(await local.read('/api/v1/documents/'+accepted[0].documentId)).projection.value;expect(current.revision).toBe('1');expect(current.metadata.name).toBe(name);await page.setViewportSize({width:320,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1)).toBe(true);await openSearch(page);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1)).toBe(true);await page.keyboard.press('Escape');
  await record('command-search-current-state',{rootUndoDisabled:true,longNameBytes:256,reflowCSSPixels:320,query:'h+-0?',beforeZoom,revision:current.revision,commands});
});

test('Command search Undo and Redo execute the actual accepted background history',async({local})=>{
  const {page,commands,read,record}=local;await page.getByRole('button',{name:'New',exact:true}).click();const creation=page.getByRole('dialog',{name:'New document',exact:true});await expect(creation).toBeVisible();await editorContent(page).getByRole('textbox',{name:'Document name',exact:true}).fill('Search history');
  for(const name of ['Width (px)','Height (px)']){const field=editorContent(page).getByRole('spinbutton',{name,exact:true});await field.fill('2');await field.press('Tab');}await editorContent(page).getByRole('combobox',{name:'Background',exact:true}).selectOption('solid');await editorContent(page).getByRole('button',{name:'Create',exact:true}).click();await expect(creation).toBeHidden();
  const background=page.getByRole('treeitem',{name:'Image · Background · visible',exact:true});await background.click();await page.getByRole('button',{name:'Delete layer',exact:true}).click();await expect(page.getByText('DeleteLayer accepted and saved locally.',{exact:true})).toBeVisible();await expect(page.getByRole('treeitem')).toHaveCount(0);
  const dialog=await openSearch(page),query=searchContent(page).getByRole('textbox',{name:'Search commands',exact:true});await query.fill('undo');const undo=searchContent(page).getByRole('button',{name:'Undo',exact:true});await expect(undo).toHaveAttribute('aria-disabled','false');await undo.focus();await page.keyboard.press('Enter');await expect(dialog).toBeHidden();await expect(background).toBeVisible();await expect(page.getByText('Undo accepted and saved locally.',{exact:true})).toBeVisible();
  await openSearch(page);await query.fill('redo');const redo=searchContent(page).getByRole('button',{name:'Redo',exact:true});await expect(redo).toHaveAttribute('aria-disabled','false');await redo.focus();await page.keyboard.press('Enter');await expect(dialog).toBeHidden();await expect(page.getByRole('treeitem')).toHaveCount(0);await expect(page.getByText('Redo accepted and saved locally.',{exact:true})).toBeVisible();
  const creationCommand=commands.find(command=>command.body.type==='CreateDocument'),document=(await read('/api/v1/documents/'+creationCommand.documentId)).projection.value;
  expect(commands.filter(command=>['DeleteLayer','Undo','Redo'].includes(command.body.type)).map(command=>command.body.type)).toEqual(['DeleteLayer','Undo','Redo']);expect(document.revision).toBe('4');expect(document.metadata.name).toBe('Search history');expect(document.orderedLayerIds).toEqual([]);
  await record('command-search-history',{document,commands:commands.filter(command=>['CreateDocument','DeleteLayer','Undo','Redo'].includes(command.body.type))});
});

async function shortcutDocument(page:Page){
 await page.getByRole('button',{name:'New',exact:true}).click();const dialog=page.getByRole('dialog',{name:'New document',exact:true});await expect(dialog).toBeVisible();
 await editorContent(page).getByRole('textbox',{name:'Document name',exact:true}).fill('Keyboard ownership');
 for(const label of ['Width (px)','Height (px)']){const input=editorContent(page).getByRole('spinbutton',{name:label,exact:true});await input.fill('32');await input.press('Tab');}
 await editorContent(page).getByRole('combobox',{name:'Background',exact:true}).selectOption('solid');await editorContent(page).getByRole('button',{name:'Create',exact:true}).click();await expect(dialog).toBeHidden();
 await expect(page.getByRole('treeitem',{name:'Image · Background · visible',exact:true})).toBeVisible();
}

test('Scoped tool shortcuts preserve editable fields, modal focus, preference and a later veto',async({local})=>{
 const {page,commands,record}=local;await shortcutDocument(page);const canvas=page.locator('#canvas'),tools=await canvasTools(page);
 for(const [key,name]of Object.entries({v:'Move',m:'Select',b:'Mask',h:'Pan',i:'Sample'})){await canvas.focus();await page.keyboard.press(key);await expect(tools.getByRole('button',{name,exact:true})).toHaveAttribute('aria-pressed','true');}
 await canvas.focus();await page.evaluate(()=>document.addEventListener('keydown',event=>{if(event.key==='b')event.preventDefault();},{once:true}));await page.keyboard.press('b');await expect(tools.getByRole('button',{name:'Sample',exact:true})).toHaveAttribute('aria-pressed','true');
 await canvas.focus();await page.keyboard.press('c');const bounds=page.getByRole('dialog',{name:'Canvas bounds',exact:true});await expect(bounds).toBeVisible();await editorContent(page).getByRole('button',{name:'Cancel',exact:true}).focus();await page.keyboard.press('h');await expect(tools.getByRole('button',{name:'Crop',exact:true})).toHaveAttribute('aria-pressed','true');await page.keyboard.press('Escape');await expect(bounds).toBeHidden();
 await page.getByRole('button',{name:'Help',exact:true}).click();const help=page.getByRole('dialog',{name:'Editor help',exact:true});await expect(help).toBeVisible();await helpContent(page).getByRole('switch',{name:'Enable single-key shortcuts',exact:true}).uncheck();await page.keyboard.press('Escape');await canvas.focus();await page.keyboard.press('b');await expect(tools.getByRole('button',{name:'Crop',exact:true})).toHaveAttribute('aria-pressed','true');
 await page.getByRole('button',{name:'Help',exact:true}).click();await expect(help).toBeVisible();await helpContent(page).getByRole('switch',{name:'Enable single-key shortcuts',exact:true}).check();await page.keyboard.press('Escape');
 const zoom=page.getByRole('spinbutton',{name:'Zoom percentage',exact:true});await zoom.focus();await page.keyboard.press('h');await expect(tools.getByRole('button',{name:'Crop',exact:true})).toHaveAttribute('aria-pressed','true');
 expect(commands.filter(command=>command.body.type!=='CreateDocument')).toEqual([]);await record('tool-shortcuts',{keys:['v','m','b','h','i','c'],lateVeto:true,modal:true,disabledPreference:true,editableFocus:true,commands});
});

test('Held Space pans actual canvas pixels and key release cancels the held gesture without changing tools',async({local})=>{
 const {page,commands,record}=local;await shortcutDocument(page);const region=page.locator('#canvas'),canvas=region.locator('canvas'),selection=(await canvasTools(page)).getByRole('button',{name:'Select',exact:true});
 await region.focus();await page.keyboard.press('m');await expect(selection).toHaveAttribute('aria-pressed','true');await expect(canvas).toHaveAttribute('data-asset',/.+/);const before=await canvas.screenshot(),box=(await canvas.boundingBox())!;
 await page.keyboard.down('Space');await expect(region.getByText(/Temporary pan \(Space\)/)).toBeVisible();const held=await canvas.screenshot();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+31,box.y+box.height/2+19,{steps:3});
 expect((await canvas.screenshot()).equals(held)).toBe(false);await page.keyboard.up('Space');await expect(region.getByText(/Temporary pan \(Space\)/)).toHaveCount(0);expect((await canvas.screenshot()).equals(before)).toBe(true);await page.mouse.up();await expect(selection).toHaveAttribute('aria-pressed','true');
 expect(commands.filter(command=>command.body.type!=='CreateDocument')).toEqual([]);await record('temporary-pan',{actualPixelsMoved:true,heldGestureRestored:true,selectedTool:'Select',commands});
});

test('Scoped Delete preserves typing and deletes only current selected layer with actual Undo restoration',async({local})=>{
 const {page,commands,read,record}=local;await shortcutDocument(page);const layer=page.getByRole('treeitem',{name:'Image · Background · visible',exact:true});await layer.click();
 const name=page.getByRole('textbox',{name:'Layer name',exact:true});await expect(name).toHaveValue('Background');await name.fill('Typing stays local');await name.focus();await page.keyboard.press('Delete');expect(commands.filter(command=>command.body.type==='DeleteLayer')).toEqual([]);
 await page.getByRole('button',{name:'Cancel changes',exact:true}).click();await expect(name).toHaveValue('Background');await page.locator('#canvas').focus();await page.keyboard.press('Delete');await expect(page.getByText('DeleteLayer accepted and saved locally.',{exact:true})).toBeVisible();await expect(page.getByRole('treeitem')).toHaveCount(0);
 await page.getByRole('button',{name:'Undo',exact:true}).click();await expect(layer).toBeVisible();await expect(page.getByText('Undo accepted and saved locally.',{exact:true})).toBeVisible();
 expect(commands.filter(command=>['DeleteLayer','Undo'].includes(command.body.type)).map(command=>command.body.type)).toEqual(['DeleteLayer','Undo']);const creation=commands.find(command=>command.body.type==='CreateDocument'),document=(await read('/api/v1/documents/'+creation.documentId)).projection.value;expect(document.orderedLayerIds).toHaveLength(1);await record('scoped-delete',{typingProtected:true,document,commands});
});


test('Request modifier Enter uses focused draft and explicit acceptance without submitting from unrelated controls',async({local})=>{
 const {page,commands,record}=local;await shortcutDocument(page);const prompt=page.getByRole('textbox',{name:'Prompt',exact:true}),region=page.getByRole('group',{name:'Request draft keyboard actions',exact:true}),review=page.locator('#request-review'),requests:any[]=[];
 page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname.startsWith('/api/v1/ui/'))requests.push(request.postDataJSON());});
 await prompt.fill('Keyboard review stays local.');await prompt.press('Tab');await expect(page.locator('footer')).toContainText('Draft saved locally');
 await prompt.focus();await page.keyboard.press('Control+Enter');await page.locator('#canvas').focus();await page.keyboard.press('Control+Enter');
 await region.focus();await expect(region).toHaveAttribute('aria-keyshortcuts','Control+Enter Meta+Enter');await region.evaluate(control=>{const veto=(event:KeyboardEvent)=>{if(event.key!=='Enter')return;event.preventDefault();control.setAttribute('data-shortcut-enter-veto','true');document.removeEventListener('keydown',veto);};document.addEventListener('keydown',veto);});await page.keyboard.press('Control+Enter');await expect(region).toHaveAttribute('data-shortcut-enter-veto','true');
 // Advance the same dispatch-task boundary used by ControlAdapter.action; the
 // observed Enter veto must settle before any permitted shortcut is sent.
 await page.evaluate(()=>new Promise<void>(resolve=>setTimeout(resolve,0)));expect(requests.filter(request=>request.body.type==='PrepareRequestReview')).toHaveLength(0);expect(requests.filter(request=>request.body.type==='AcceptRequestReview')).toHaveLength(0);expect(commands.filter(command=>command.body.type==='QueueInference')).toHaveLength(0);await expect(review).toHaveCount(0);
 await region.focus();await page.keyboard.press('Control+Enter');await expect(review).toBeVisible();await expect(review).toBeFocused();expect(requests.filter(request=>request.body.type==='PrepareRequestReview')).toHaveLength(1);expect(requests.filter(request=>request.body.type==='AcceptRequestReview')).toHaveLength(0);expect(commands.filter(command=>command.body.type==='QueueInference')).toHaveLength(0);
 await page.keyboard.press('Control+Enter');await page.getByRole('button',{name:'Accept this exact review locally',exact:true}).click();await requestFeedback(page,'Request review accepted locally. No job was queued and no provider call was made.');expect(requests.filter(request=>request.body.type==='PrepareRequestReview')).toHaveLength(1);expect(requests.filter(request=>request.body.type==='AcceptRequestReview')).toHaveLength(1);expect(commands.filter(command=>command.body.type==='QueueInference')).toHaveLength(0);
 await review.focus();await page.keyboard.press('Control+Enter');await expect.poll(()=>commands.filter(command=>command.body.type==='QueueInference').length).toBe(1);await requestFeedback(page,'Queue change saved locally. Live dispatch requires a configured provider and explicit per-attempt authorization; actual charge is unavailable.','Request accepted and saved in the local queue.');
 await record('request-keyboard-scope',{nativePromptPreserved:true,unrelatedCanvasPreserved:true,lateVeto:true,preparedReviews:1,explicitLocalAcceptances:1,queuedRequests:1,commands,requests});
});
