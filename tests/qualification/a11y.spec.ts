import {expect,type Locator,type Page} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {test,out} from '../browser/spectrum-fixture.js';
import {captureFrame} from '../browser/spectrum-frame.js';

// Deterministic AX regression probes, not whole AX01–AX10 qualification. These use
// public roles, native input/keyboard APIs and rendered geometry. It never
// reads component internals or reaches into a private shadow root.
const limits={
  AX01:'This focused probe does not run axe; see the separately pinned axe.config.ts harness. Every incomplete result requires manual adjudication; a test pass alone does not complete AX01.',
  AX02:'Keyboard shell, numeric rectangle/ellipse/polygon mask authoring, Fill/Invert/feather/mapping, semantic move/delete and native text paths. File selection uses the documented file-input API; OS chooser and the remaining J1–J24 paths require separate receipts.',
  AX03:'Help focus return, failed Composition summary and exact-field links, last semantic element deletion, native text cancel return and later focus during preview. Deterministically held text loads are covered by tests/editor/native-text.spec.ts; native AT announcement quality requires manual evidence.',
  AX04:'Native caret, selection, multiline input and undo; modifier+Enter applies only inside the native text field. Single-key shortcuts can be disabled and the choice survives reload. Clipboard, physical IME, dictation and AT shortcuts require separate receipts.',
  AX05:'320/720 CSS-pixel forms, WCAG text-spacing overrides, actual control boxes and optional context-level coarse-pointer emulation. 720 CSS pixels is not physical browser zoom; browser zoom and visual overlap adjudication remain manual.',
  AX06:'Actual rendered field text/background contrast in Light/Dark, forced-colors focus and selected-tool outline, plus explicit mask/error/lock labels. Image/checkerboard contrast and visual adjudication remain manual.',
  AX07:'RTL chrome with unchanged physical mask geometry, native text direction independent of chrome, and reduced-motion public-control checks. Full reading-order and animated-canvas review remain manual.',
  AX08:'Retained raw bytes are read through every bounded page with native readonly selection and stable paging focus. Real adapter collection paging is covered by tests/adapters/browser.spec.ts; virtualized screen-reader behavior is not certified.',
  AX09:'ARIA snapshots are diagnostic output, not evidence of spoken announcements.',
  AX10:'Native Safari/Chromium plus VoiceOver and Windows NVDA/Firefox require physical manual receipts.',
};

async function targetBox(control:Locator,width:number){
  await control.scrollIntoViewIfNeeded();
  const box=await control.boundingBox();
  expect(box,'Named control has a rendered target').not.toBeNull();
  expect(box!.width,'Target width').toBeGreaterThanOrEqual(24);
  expect(box!.height,'Target height').toBeGreaterThanOrEqual(24);
  expect(box!.x,'Target is not clipped at the inline start').toBeGreaterThanOrEqual(-1);
  expect(box!.x+box!.width,'Target is not clipped at the inline end').toBeLessThanOrEqual(width+1);
  return box;
}

async function activate(control:Locator){
  await expect(control).toBeEnabled();await control.focus();await expect(control).toBeFocused();await control.press('Enter');
}
const action=(page:Page,name:string)=>activate(page.getByRole('button',{name,exact:true}));
async function edit(page:Page,control:Locator,value:string){
  await control.focus();await control.press('ControlOrMeta+A');
  if(value)await page.keyboard.insertText(value);else await control.press('Backspace');
  await control.press('Tab');await expect(control).toHaveValue(value);
}
const numeric=(page:Page,name:string,value:string)=>edit(page,page.getByRole('spinbutton',{name,exact:true}),value);
async function createDocument(page:Page,width='64',height='64'){
  await action(page,'New');
  const dialog=page.getByRole('dialog',{name:'New document',exact:true});await expect(dialog).toBeVisible();
  await numeric(page,'Width (px)',width);await numeric(page,'Height (px)',height);await action(page,'Create');await expect(dialog).toBeHidden();
}
async function composition(page:Page){
  const control=page.getByRole('radio',{name:'Composition',exact:true});await control.focus();await control.press('Space');
  await expect(page.getByRole('textbox',{name:'Scene',exact:true})).toBeVisible();
}
async function evidence(page:Page,name:string,record:(value:unknown)=>Promise<void>){
  await writeFile(join(out,name+'.aria.txt'),await page.locator('body').ariaSnapshot());
  if(process.env.QUALIFICATION_BROWSER==='webkit')await captureFrame(page,join(out,name+'.jpg'),record);
  else await page.screenshot({path:join(out,name+'.png'),fullPage:true,animations:'allow',caret:'initial'});
}

test('focused shell keyboard, reflow, reduced-motion and forced-colors evidence',async({smoke:{page,step,record}},info)=>{
  await record({phase:'qualification-scope',limits});
  await info.attach('qualification-scope',{body:JSON.stringify(limits,null,2),contentType:'application/json'});
  const capture=async(name:string)=>{
    await writeFile(join(out,name+'.aria.txt'),await page.locator('body').ariaSnapshot());
    if(process.env.QUALIFICATION_BROWSER==='webkit')await captureFrame(page,join(out,name+'.jpg'),record);
    else await page.screenshot({path:join(out,name+'.png'),fullPage:true,animations:'allow',caret:'initial'});
  };
  const pan=page.getByRole('button',{name:'Pan',exact:true});
  const zoom=page.getByRole('button',{name:'Zoom',exact:true});
  const prompt=page.getByRole('textbox',{name:'Prompt',exact:true});

  await step('keyboard-skip-landmark',async()=>{
    const skip=page.getByRole('link',{name:'Go to Canvas',exact:true});
    await skip.focus();await expect(skip).toBeVisible();await page.keyboard.press('Enter');
    await expect(page.getByRole('region',{name:'Canvas',exact:true})).toBeFocused();
    expect(new URL(page.url()).hash).toBe('#canvas');
  });
  await step('keyboard-roving-tools',async()=>{
    await pan.focus();await page.keyboard.press('ArrowDown');await expect(zoom).toBeFocused();
    await page.keyboard.press('Enter');await expect(zoom).toHaveAttribute('aria-pressed','true');
    await page.getByRole('region',{name:'Canvas',exact:true}).focus();await page.keyboard.press('h');
    await expect(pan).toHaveAttribute('aria-pressed','true');
  });
  await step('keyboard-native-prompt',async()=>{
    await createDocument(page);
    await prompt.focus();await page.keyboard.type('Keep hz shortcuts inside this native prompt.');
    await page.keyboard.press('Enter');await page.keyboard.type('Second line retained through reflow.');
    await expect(prompt).toHaveValue('Keep hz shortcuts inside this native prompt.\nSecond line retained through reflow.');
    await expect(pan).toHaveAttribute('aria-pressed','true');
  });
  await step('keyboard-activity-tabs',async()=>{
    const results=page.getByRole('tab',{name:'Results',exact:true});
    const jobs=page.getByRole('tab',{name:'Jobs',exact:true});
    await results.focus();await page.keyboard.press('ArrowRight');await expect(jobs).toBeFocused();
    await expect(jobs).toHaveAttribute('aria-selected','true');
    const activity=page.getByRole('region',{name:'Activity',exact:true});
    const toggle=activity.getByRole('button',{name:'Activity',exact:true});
    await toggle.focus();await page.keyboard.press('Enter');await expect(toggle).toHaveAttribute('aria-expanded','false');
    await expect(jobs).toBeHidden();await expect(toggle).toBeFocused();
    await page.keyboard.press('Enter');await expect(toggle).toHaveAttribute('aria-expanded','true');await expect(jobs).toBeVisible();
  });
  await step('keyboard-help-dialog-focus-return',async()=>{
    const help=page.getByRole('button',{name:'Help',exact:true});
    await help.focus();await page.keyboard.press('Enter');
    const dialog=page.getByRole('dialog',{name:'Editor help',exact:true});
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Native fields keep their own undo and clipboard shortcuts.');
    await page.keyboard.press('Escape');await expect(dialog).toBeHidden();await expect(help).toBeFocused();
  });
  await step('desktop-evidence',()=>capture('desktop-keyboard'));

  const retained=await prompt.inputValue();
  for(const width of [720,320]){
    await step('reflow-'+width,async()=>{
      await prompt.focus();await page.setViewportSize({width,height:800});
      await expect(prompt).toBeFocused();await expect(prompt).toHaveValue(retained);
      await expect(page.getByRole('button',{name:'Hide request',exact:true})).toBeVisible();
      const controls=[];
      for(const [role,name] of [['textbox','Prompt'],['combobox','Operation'],['combobox','Appearance']] as const){
        const control=page.getByRole(role,{name,exact:true});
        await expect(control).toBeVisible();controls.push({role,name,box:await targetBox(control,width)});
      }
      const geometry=await page.evaluate(()=>({viewport:innerWidth,rootWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth}));
      expect(geometry.rootWidth).toBeLessThanOrEqual(width);expect(geometry.bodyWidth).toBeLessThanOrEqual(width);
      await record({phase:'reflow',width,geometry,controls});
    });
    await step('reflow-'+width+'-evidence',()=>capture('reflow-'+width));
  }
  await step('keyboard-narrow-panel-routes',async()=>{
    const hideRequest=page.getByRole('button',{name:'Hide request',exact:true});
    await hideRequest.focus();await page.keyboard.press('Enter');await expect(prompt).toBeHidden();
    const showLayers=page.getByRole('button',{name:'Show layers',exact:true});
    await showLayers.focus();await page.keyboard.press('Enter');
    const composition=page.getByRole('tab',{name:'Composition',exact:true});
    await composition.focus();await page.keyboard.press('Enter');
    await expect(page.getByRole('heading',{name:'Semantic element inspector',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Hide layers',exact:true}).focus();await page.keyboard.press('Enter');
    const showRequest=page.getByRole('button',{name:'Show request',exact:true});
    await showRequest.focus();await page.keyboard.press('Enter');await expect(prompt).toBeVisible();await expect(prompt).toHaveValue(retained);
  });
  await step('reduced-motion-public-controls',async()=>{
    await page.setViewportSize({width:1440,height:1000});await page.emulateMedia({reducedMotion:'reduce'});
    expect(await page.evaluate(()=>matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
    const controls=[];
    for(const [name,control] of [['Prompt',prompt],['Appearance',page.getByRole('combobox',{name:'Appearance',exact:true})],['Pan',pan]] as const){
      const style=await control.evaluate(node=>{const s=getComputedStyle(node);return {animationName:s.animationName,animationDuration:s.animationDuration,transitionDuration:s.transitionDuration,scrollBehavior:s.scrollBehavior};});
      expect(style.animationName,name+' decorative animation').toBe('none');
      expect(style.transitionDuration.split(',').every(value=>parseFloat(value)===0),name+' transitions under reduced motion').toBe(true);
      expect(style.scrollBehavior,name+' smooth scrolling under reduced motion').toBe('auto');
      controls.push({name,...style});
    }
    await record({phase:'reduced-motion',controls});
  });
  await step('forced-colors-selected-tool',async()=>{
    await page.emulateMedia({forcedColors:'active'});
    expect(await page.evaluate(()=>matchMedia('(forced-colors: active)').matches),'Browser must implement forced-colors emulation for this gate').toBe(true);
    await pan.focus();await page.keyboard.press('Enter');await expect(pan).toHaveAttribute('aria-pressed','true');
    await page.getByRole('region',{name:'Canvas',exact:true}).focus();
    const selected=await pan.evaluate(node=>{const s=getComputedStyle(node);return {outlineStyle:s.outlineStyle,outlineWidth:s.outlineWidth,outlineColor:s.outlineColor,background:s.backgroundColor,color:s.color};});
    expect(selected.outlineStyle).toBe('solid');expect(parseFloat(selected.outlineWidth)).toBeGreaterThanOrEqual(2);
    await page.getByRole('combobox',{name:'Appearance',exact:true}).focus();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('combobox',{name:'Appearance',exact:true})).toBeFocused();
    await record({phase:'forced-colors',selected});
  });
  await step('forced-colors-evidence',()=>capture('forced-colors'));
});

test('AX02 numeric mask tools and RTL mapping complete without canvas dragging',async({smoke:{page,step,record}})=>{
  const commands:Record<string,any>[]=[];
  page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/v1/commands')commands.push(request.postDataJSON().command.body);});
  const mask=page.getByRole('region',{name:'Request source and separate edit mask',exact:true});
  const build=async(name:string)=>{
    const before=commands.filter(command=>command.type==='PrepareRequestMask').length;
    await action(page,name);
    await expect.poll(()=>commands.filter(command=>command.type==='PrepareRequestMask').length).toBe(before+1);
    await expect(mask).toHaveAttribute('aria-busy','false');
    return commands.filter(command=>command.type==='PrepareRequestMask').at(-1)!;
  };
  await step('mask-create-and-capture',async()=>{
    await createDocument(page);
    await action(page,'Import image');
    await page.getByLabel('Image file',{exact:true}).setInputFiles('tests/raster/fixtures/hidden-alpha.png');
    await action(page,'Apply reviewed result');
    await expect(page.getByText('ImportAsset accepted and saved locally.',{exact:true})).toBeVisible();
    await page.getByRole('combobox',{name:'Operation',exact:true}).selectOption('Edit masked region');
    await action(page,'Capture all visible layers');
    await expect(page.locator('#request-source-status')).toContainText('Immutable rendered contribution retained.');
    await expect(mask).toHaveAttribute('aria-busy','false');
  },20_000);
  await step('mask-rectangle-ellipse-polygon',async()=>{
    for(const [label,value] of [['Mask X','16'],['Mask Y','16'],['Mask width','24'],['Mask height','24'],['Feather radius in document pixels','0']])await numeric(page,label!,value!);
    for(const kind of ['rectangle','ellipse','polygon']){
      await page.getByRole('combobox',{name:'Request mask shape',exact:true}).selectOption(kind);
      if(kind==='polygon')await edit(page,page.getByRole('textbox',{name:'Polygon x,y points, one pair per line',exact:true}),'16,16\n40,16\n28,40');
      const command=await build('Build request mask shape');
      expect(command.plan.operations.at(-1).shape.kind).toBe(kind);
      await expect(page.locator('#request-mask-status')).toContainText('partial coverage');
    }
    await expect(mask.getByText('White means edit and black means keep.',{exact:false})).toBeVisible();
  },20_000);
  await step('mask-fill-invert-feather',async()=>{
    expect((await build('Fill request mask')).plan.operations.at(-1)).toEqual({kind:'fill'});
    await expect(page.locator('#request-mask-status')).toContainText('entire document');
    expect((await build('Invert request mask')).plan.operations.at(-1)).toEqual({kind:'invert'});
    await expect(page.locator('#request-mask-status')).toContainText('empty');
    await build('Build request mask shape');
    await numeric(page,'Feather radius in document pixels','2');
    expect((await build('Rebuild feather preview')).plan.feather).toBe(2);
    await expect(page.locator('#request-mask-status')).toContainText('partial coverage');
  },20_000);
  await step('mask-rtl-physical-geometry',async()=>{
    const sourceText=await page.locator('#request-source-status').innerText();
    await page.evaluate(()=>{document.documentElement.dir='rtl';});
    for(const [label,value] of [['Request crop X','0'],['Request crop Y','0'],['Request crop width','64'],['Request crop height','64'],['Transparent padding left','4'],['Transparent padding top','8'],['Transparent padding right','4'],['Transparent padding bottom','8']])await numeric(page,label!,value!);
    await action(page,'Preview request crop and mapping');
    const review=page.locator('#request-mapping-review');await expect(review).toBeVisible();
    await expect(review).toContainText('Request domain X -4, Y -8, 72 × 80.');
    await expect(page.locator('#request-source-status')).toHaveText(sourceText);
    await expect(page.getByRole('spinbutton',{name:'Mask X',exact:true})).toHaveValue('16');
    await expect(page.getByRole('spinbutton',{name:'Mask Y',exact:true})).toHaveValue('16');
    const mapped=page.getByRole('img',{name:'Captured source, approved request domain and safe reconstruction interior',exact:true});
    await expect(mapped.locator('.request-domain')).toHaveAttribute('x','-4');
    await expect(mapped.locator('.request-domain')).toHaveAttribute('y','-8');
    await action(page,'Approve this source, mask and mapping');
    await expect(page.locator('#request-mask-status')).toContainText('Request mask plan confirmed.');
    const sources=commands.filter(command=>command.type==='PrepareRequestSource');expect(sources).toHaveLength(1);
    expect(commands.filter(command=>['QueueInference','SetLayerProperties'].includes(command.type))).toHaveLength(0);
    await record({phase:'AX02-AX07-mask',scope:'Actual local source capture, three numeric shapes, Fill/Invert, feather and padding approval. RTL changed chrome only; no provider submission.',sourceCaptures:sources.length,maskOperations:commands.filter(command=>command.type==='PrepareRequestMask').map(command=>command.plan),direction:await page.locator('html').getAttribute('dir')});
    await evidence(page,'mask-rtl-mapping',record);
  },20_000);
});

test('AX03 semantic validation links and deletion preserve meaningful keyboard focus',async({smoke:{page,step,record}})=>{
  await step('semantic-keyboard-setup',async()=>{await createDocument(page,'512','512');await composition(page);await action(page,'Add object');await action(page,'Add literal bounds');});
  await step('semantic-validation-summary-and-field',async()=>{
    await numeric(page,'Width in document pixels','');await action(page,'Apply Composition');
    const summary=page.getByRole('region',{name:'Composition needs attention',exact:true});
    await expect(summary).toContainText('NUMBER_REQUIRED');await expect(summary).toBeFocused();
    const link=summary.getByRole('link');await expect(link).toHaveCount(1);await link.focus();await link.press('Enter');
    await expect(page.getByRole('spinbutton',{name:'Width in document pixels',exact:true})).toBeFocused();
    await numeric(page,'Width in document pixels','-1');await action(page,'Apply Composition');
    await expect(summary).toContainText('INVALID_GEOMETRY');await expect(summary).toBeFocused();
    await summary.getByRole('link').focus();await page.keyboard.press('Enter');
    await expect(page.getByRole('spinbutton',{name:'Width in document pixels',exact:true})).toBeFocused();
    await numeric(page,'Width in document pixels','100');
  });
  await step('semantic-arrow-movement-and-order',async()=>{
    const move=page.getByRole('button',{name:'Adjust semantic bounds with arrow keys',exact:true});await move.focus();
    await move.press('ArrowRight');await move.press('Shift+ArrowDown');
    await expect(page.getByRole('spinbutton',{name:'X in document pixels',exact:true})).toHaveValue('1');
    await expect(page.getByRole('spinbutton',{name:'Y in document pixels',exact:true})).toHaveValue('10');
    await edit(page,page.getByRole('textbox',{name:'Appearance description',exact:true}),'First object');
    await action(page,'Add semantic text');await edit(page,page.getByRole('textbox',{name:'Appearance description',exact:true}),'Second element');
    await action(page,'Move element earlier');
    const rows=page.locator('#semantic-tree').getByRole('treeitem');await expect(rows).toHaveCount(2);await expect(rows.first()).toContainText('Second element');
    await action(page,'Move element later');await expect(rows.last()).toContainText('Second element');
  });
  await step('semantic-last-delete-return',async()=>{
    await action(page,'Delete semantic element');await expect(page.locator('#semantic-tree').getByRole('treeitem')).toHaveCount(1);
    await action(page,'Delete semantic element');await expect(page.locator('#semantic-tree').getByRole('treeitem')).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Add object',exact:true})).toBeFocused();
    await record({phase:'AX03-semantic',summaryFocus:true,exactInvalidFieldLinks:true,physicalArrowMove:{x:1,y:10},lastElementFocus:'Add object'});
  });
});

test('AX04 native text caret undo multiline and scoped Apply keep document authority explicit',async({smoke:{page,step,record}})=>{
  const commands:string[]=[];
  page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/v1/commands')commands.push(request.postDataJSON().command.body.type);});
  const input=page.locator('#native-text-content');
  await step('native-keyboard-and-undo',async()=>{
    await createDocument(page,'360','200');await action(page,'Text');await expect(input).toBeFocused();
    await page.keyboard.type('First line');await page.keyboard.press('Enter');await page.keyboard.type('Second hz line');
    await expect(input).toHaveValue('First line\nSecond hz line');
    await page.keyboard.press('ArrowLeft');await page.keyboard.press('ArrowRight');
    await page.keyboard.insertText('!');await expect(input).toHaveValue('First line\nSecond hz line!');
    await page.keyboard.press('ControlOrMeta+Z');await expect(input).toHaveValue('First line\nSecond hz line');
    await page.keyboard.press('Shift+ArrowLeft');
    expect(await input.evaluate(node=>{const field=node as HTMLTextAreaElement;return field.value.slice(field.selectionStart,field.selectionEnd);})).toBe('e');
    expect(commands.filter(type=>['Undo','Redo','DeleteLayer','CreateTextLayer','QueueInference'].includes(type))).toEqual([]);
    await input.press('ArrowRight');
  },20_000);
  await step('native-direction-and-preview-focus',async()=>{
    const nativeDirection=page.getByRole('combobox',{name:'Text direction',exact:true});await nativeDirection.selectOption('ltr');
    await page.evaluate(()=>{document.documentElement.dir='rtl';});await expect(input).toHaveAttribute('dir','ltr');
    await nativeDirection.selectOption('rtl');await expect(input).toHaveAttribute('dir','rtl');
    await page.evaluate(()=>{document.documentElement.dir='ltr';});await expect(input).toHaveAttribute('dir','rtl');
    await nativeDirection.selectOption('ltr');
    await action(page,'Preview text');
    const zoom=page.getByRole('spinbutton',{name:'Zoom percentage',exact:true});await zoom.focus();
    await expect(page.getByText('Text preview ready. Accepted appearance is unchanged.',{exact:true})).toBeVisible();
    await expect(zoom).toBeFocused();
    expect(commands.filter(type=>type==='CreateTextLayer')).toHaveLength(0);
    await input.focus();await input.press('ControlOrMeta+Enter');
    await expect(input).toBeHidden();await expect.poll(()=>commands.filter(type=>type==='CreateTextLayer').length).toBe(1);
  },20_000);
  await step('native-cancel-return-and-request-exclusion',async()=>{
    const editText=page.getByRole('button',{name:'Edit text',exact:true});await activate(editText);
    await expect(input).toBeFocused();await expect(input).toHaveValue('First line\nSecond hz line');
    await input.press('Escape');await expect(input).toBeHidden();await expect(editText).toBeFocused();
    const prompt=page.getByRole('textbox',{name:'Prompt',exact:true});await prompt.focus();await page.keyboard.type('Request scope text');
    await prompt.press('ControlOrMeta+Enter');
    expect(commands.filter(type=>type==='CreateTextLayer')).toHaveLength(1);
    expect(commands.filter(type=>type==='CommitTextEdit')).toHaveLength(0);
    expect(commands.filter(type=>type==='QueueInference')).toHaveLength(0);
    await action(page,'Lock layer');await expect(page.getByRole('button',{name:'Unlock layer',exact:true})).toBeVisible();
    await action(page,'Edit text');await expect(input).toHaveAttribute('readonly','');
    await expect(page.getByRole('button',{name:'Apply text',exact:true})).toBeDisabled();
    await input.focus();await input.press('ControlOrMeta+A');
    expect(await input.evaluate(node=>{const field=node as HTMLTextAreaElement;return field.selectionEnd-field.selectionStart;})).toBe('First line\nSecond hz line'.length);
    await action(page,'Cancel text edit');
    await record({phase:'AX04-native',nativeSelectionAndUndo:true,multilineRetained:true,scopedApplyCount:1,requestQueueCount:0,lockedReadonlySelection:true,limits:'No clipboard access, physical IME, dictation or assistive-technology emulation.'});
  });
});

test('AX08 raw retained content has complete keyboard paging and stable reading focus',async({smoke:{page,step,record}})=>{
  const bytes='A'.repeat(32768)+'B'.repeat(32768)+'C'.repeat(257);
  await step('raw-reading-setup',async()=>{
    await createDocument(page);await composition(page);await action(page,'Raw caption inspection and Convert copy');
    await edit(page,page.getByRole('textbox',{name:'Raw caption to retain',exact:true}),bytes);await action(page,'Retain and inspect raw');
    await expect(page.getByText('Original bytes retained separately. Inspection grants no authoring authority.',{exact:true})).toBeVisible();
  },20_000);
  await step('raw-reading-all-pages',async()=>{
    const field=page.getByRole('textbox',{name:'Immutable raw byte page',exact:true}),next=page.getByRole('button',{name:'Next raw page',exact:true}),previous=page.getByRole('button',{name:'Previous raw page',exact:true});
    await expect(field).toHaveAttribute('readonly','');const pages:string[]=[];
    for(let index=0;index<3;index++){
      const expected=bytes.slice(index*32768,(index+1)*32768);await expect(field).toHaveValue(expected);pages.push(await field.inputValue());
      await field.focus();await field.press('ControlOrMeta+A');
      expect(await field.evaluate(node=>{const input=node as HTMLTextAreaElement;return input.selectionEnd-input.selectionStart;})).toBe(expected.length);
      if(index<2){await activate(next);await expect(field).toHaveValue(bytes.slice((index+1)*32768,(index+2)*32768));await expect(next).toBeFocused();}
    }
    expect(pages.join('')).toBe(bytes);
    await activate(previous);await expect(field).toHaveValue('B'.repeat(32768));await expect(previous).toBeFocused();
    await activate(previous);await expect(field).toHaveValue('A'.repeat(32768));await expect(previous).toBeFocused();
    await field.focus();await field.press('ControlOrMeta+A');
    const appearance=page.getByRole('combobox',{name:'Appearance',exact:true});await appearance.selectOption('dark');await field.focus();await field.press('ControlOrMeta+A');
    await page.setViewportSize({width:320,height:800});await expect(field).toBeFocused();await expect(field).toHaveValue('A'.repeat(32768));
    expect(await field.evaluate(node=>{const input=node as HTMLTextAreaElement;return input.selectionEnd-input.selectionStart;})).toBe(32768);
    await record({phase:'AX08-raw-reading',byteLength:bytes.length,pages:pages.map(page=>page.length),reconstructedExactly:true,previousPageFocusStable:true,readOnlySelectionSurvivesNarrowReflow:true,limits:'This tests the actual full-reading byte-page alternative, not spoken output or a virtual collection.'});
  },20_000);
});

test('AX04 single-key preference persists while explicit keyboard commands remain usable',async({smoke:{page,step,record}})=>{
  const help=page.getByRole('button',{name:'Help',exact:true}),canvas=page.getByRole('region',{name:'Canvas',exact:true});
  const zoom=page.getByRole('button',{name:'Zoom',exact:true}),pan=page.getByRole('button',{name:'Pan',exact:true});
  await step('single-key-disable',async()=>{
    await activate(help);const setting=page.getByRole('switch',{name:'Enable single-key shortcuts',exact:true});
    await expect(setting).toBeChecked();await setting.focus();await setting.press('Space');await expect(setting).not.toBeChecked();
    await page.keyboard.press('Escape');await activate(zoom);await canvas.focus();await canvas.press('h');
    await expect(zoom).toHaveAttribute('aria-pressed','true');
    await canvas.press('?');await expect(page.getByRole('dialog',{name:'Editor help',exact:true})).toBeHidden();
    await activate(pan);await expect(pan).toHaveAttribute('aria-pressed','true');
  });
  await step('single-key-reload-and-enable',async()=>{
    await page.reload();await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();
    await activate(help);const setting=page.getByRole('switch',{name:'Enable single-key shortcuts',exact:true});await expect(setting).not.toBeChecked();
    await setting.focus();await setting.press('Space');await expect(setting).toBeChecked();await page.keyboard.press('Escape');
    await activate(zoom);await canvas.focus();await canvas.press('h');await expect(pan).toHaveAttribute('aria-pressed','true');
    await record({phase:'AX04-single-key-preference',disabledKeysObserved:['h','?'],explicitToolbarRemainedUsable:true,persistedThroughReload:true,reEnabled:true});
  });
});

test('AX05–AX07 actual form surfaces keep contrast focus and text-spacing reflow',async({smoke:{page,step,record}})=>{
  const prompt=page.getByRole('textbox',{name:'Prompt',exact:true}),appearance=page.getByRole('combobox',{name:'Appearance',exact:true});
  await step('form-surfaces-document',()=>createDocument(page));
  await step('actual-pointer-capabilities',async()=>{
    const pointer=await page.evaluate(()=>({coarse:matchMedia('(pointer: coarse)').matches,fine:matchMedia('(pointer: fine)').matches,anyCoarse:matchMedia('(any-pointer: coarse)').matches,hover:matchMedia('(hover: hover)').matches,maxTouchPoints:navigator.maxTouchPoints}));
    if(process.env.QUALIFICATION_COARSE_POINTER==='1'){expect(pointer.coarse).toBe(true);expect(pointer.maxTouchPoints).toBeGreaterThan(0);}
    await record({phase:'AX05-pointer',configuredCoarse:process.env.QUALIFICATION_COARSE_POINTER==='1',actual:pointer,scope:'Context-level touch capability and actual media queries; no physical mobile or touch-editing qualification.'});
  });
  await step('rendered-light-dark-form-contrast',async()=>{
    const samples=[];
    for(const mode of ['light','dark']){
      await appearance.selectOption(mode);
      await expect(page.locator('html')).toHaveAttribute('data-en-appearance',mode);
      const backing=await page.getByRole('region',{name:'Request',exact:true}).evaluate(node=>getComputedStyle(node).backgroundColor);
      for(const [name,control] of [['Prompt',prompt],['Operation',page.getByRole('combobox',{name:'Operation',exact:true})]] as const){
        const style=await control.evaluate(node=>{const s=getComputedStyle(node);return {color:s.color,background:s.backgroundColor,backgroundImage:s.backgroundImage,fontSize:s.fontSize};});
        const rgba=(value:string)=>{const match=/^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/.exec(value);if(!match)throw Error('Unsupported rendered color '+value);return [Number(match[1]),Number(match[2]),Number(match[3]),match[4]===undefined?1:Number(match[4])] as const;};
        const foreground=rgba(style.color),surface=rgba(style.background),base=rgba(backing);
        expect(foreground[3],name+' foreground opacity').toBe(1);expect(base[3],name+' measured panel backing opacity').toBe(1);expect(style.backgroundImage,name+' field has no unmeasured image background').toBe('none');
        const bg=surface.slice(0,3).map((channel,index)=>channel*surface[3]+base[index]!*(1-surface[3]));
        const luminance=(rgb:readonly number[])=>rgb.slice(0,3).map(channel=>channel/255).map(channel=>channel<=.04045?channel/12.92:((channel+.055)/1.055)**2.4).reduce((sum,channel,index)=>sum+channel*[.2126,.7152,.0722][index]!,0);
        const first=luminance(foreground),second=luminance(bg),ratio=(Math.max(first,second)+.05)/(Math.min(first,second)+.05);
        expect(ratio,mode+' '+name+' actual rendered text contrast').toBeGreaterThanOrEqual(4.5);samples.push({mode,name,backing,...style,ratio});
      }
    }
    await record({phase:'AX06-rendered-form-contrast',minimum:4.5,samples,limits:'Only the measured opaque panel and native field surfaces; image/checkerboard, focus-backing and visual anti-aliasing review remain separate.'});
  });
  await step('text-spacing-and-rtl-narrow-reflow',async()=>{
    await prompt.focus();await page.keyboard.type('Readable spacing: labels, errors and actions remain reachable.');
    const value=await prompt.inputValue();await page.setViewportSize({width:320,height:800});
    // Native style setters model a user's text-spacing override without adding
    // inline style elements that would violate the application's CSP.
    await page.locator('html, body, p, label, input, textarea, select, button').evaluateAll(nodes=>{
      for(const node of nodes){const style=(node as HTMLElement).style;style.setProperty('line-height','1.5','important');style.setProperty('letter-spacing','.12em','important');style.setProperty('word-spacing','.16em','important');if(node.tagName==='P')style.setProperty('margin-block-end','2em','important');}
    });
    const controls=[['Prompt',prompt],['Operation',page.getByRole('combobox',{name:'Operation',exact:true})],['Appearance',appearance],['Help',page.getByRole('button',{name:'Help',exact:true})]] as const;
    const geometries=[];
    for(const direction of ['ltr','rtl']){
      await page.evaluate(value=>{document.documentElement.dir=value;},direction);
      for(const [name,control] of controls){await control.focus();await expect(control).toBeFocused();geometries.push({direction,name,box:await targetBox(control,320)});}
      const width=await page.evaluate(()=>({document:document.documentElement.scrollWidth,body:document.body.scrollWidth}));
      expect(width.document).toBeLessThanOrEqual(320);expect(width.body).toBeLessThanOrEqual(320);
      await expect(prompt).toHaveValue(value);
    }
    const spacing=await prompt.evaluate(node=>{const s=getComputedStyle(node);return {font:parseFloat(s.fontSize),line:parseFloat(s.lineHeight),letter:parseFloat(s.letterSpacing),word:parseFloat(s.wordSpacing)};});
    expect(spacing.line/spacing.font).toBeCloseTo(1.5,2);expect(spacing.letter/spacing.font).toBeCloseTo(.12,2);expect(spacing.word/spacing.font).toBeCloseTo(.16,2);
    await record({phase:'AX05-AX07-spacing-reflow',viewport:320,spacing,geometries,retainedPrompt:true,limits:'Actual target bounds and root overflow checked; manual overlap inspection and physical browser zoom remain required.'});
    await evidence(page,'text-spacing-rtl-320',record);
  },15_000);
});
