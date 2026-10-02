import {confirmImageImports} from '../editor/image-import-flow.js';
import {expect,type Page} from '@playwright/test';
import {test,out} from '../browser/spectrum-fixture.js';
import {axeEvidence} from './axe.js';

const planned=[
  'shell-light','shell-dark','help-dialog','new-document-dialog','typed-request',
  'request-conflict','immutable-request-review','adapter-library',
  'native-text-draft','native-text-glyph-error','local-font-relink-controls',
  'composition-validation','image-conversion-review','layer-mask-review',
  'masked-request-review','portable-copy-dialog','empty-jobs','empty-results','request-320css',
] as const;
const limitations=[
  'No scan alone certifies WCAG conformance. Every incomplete entry is retained for explicit manual adjudication.',
  'This no-failure shell fixture is complemented by axe-recovery.spec.ts, which removes an actual exact font dependency, scans the full-history copy failure, and relinks through the real import path.',
  'Populated queued/running/failed/completed/cancelled jobs, retained results and recovery are covered by axe-populated.spec.ts with a loopback provider emulator.',
  'Adapter import/library controls are scanned; training dataset/review/running/terminal states remain in separately deferred P4 scope.',
  'Open shadow DOM is scanned by axe. Closed/inaccessible shadow content and incomplete rules require manual inspection, without a blanket component waiver.',
  'Physical browser zoom, assistive technology, speech, dictation and native IME are outside automated scan claims.',
];
const click=(page:Page,name:string)=>page.getByRole('button',{name,exact:true}).click();
async function number(page:Page,name:string,value:string){const field=page.getByRole('spinbutton',{name,exact:true});await field.fill(value);await field.press('Tab');}
async function promptSource(page:Page,name:'Composition'|'Plain prompt'){const radio=page.getByRole('radio',{name,exact:true});await expect(radio).toBeEnabled();await radio.focus();await expect(radio).toBeFocused();await page.keyboard.press('Space');await expect(radio).toBeChecked();}

test('AX01 pinned whole-document scans of public editor states',async({smoke:{page,step,record}},info)=>{
  const evidence=await axeEvidence(page,info,out,planned,limitations);
  await record({phase:'AX01-scope',planned,limitations});
  const exposedPanStates:readonly string[]=['typed-request','request-conflict','immutable-request-review','adapter-library','native-text-draft','native-text-glyph-error','local-font-relink-controls','composition-validation','layer-mask-review','masked-request-review'];
  const scan=async(state:typeof planned[number])=>{
    await step('axe-'+state,()=>evidence.scan(state),20_000);
    if(exposedPanStates.includes(state))await step('contrast-'+state+'-exposed-pan',()=>evidence.captureExposed(state,'pan'),20_000);
    if(state==='native-text-draft')await step('contrast-'+state+'-exposed-text-size',()=>evidence.captureExposed(state,'text-size'),20_000);
  };
  const appearance=page.getByRole('combobox',{name:'Appearance',exact:true});
  await appearance.selectOption('light');await expect(page.locator('html')).toHaveAttribute('data-en-appearance','light');await scan('shell-light');
  await appearance.selectOption('dark');await expect(page.locator('html')).toHaveAttribute('data-en-appearance','dark');await scan('shell-dark');
  await appearance.selectOption('light');
  await click(page,'Help');await expect(page.getByRole('dialog',{name:'Editor help',exact:true})).toBeVisible();await scan('help-dialog');await page.keyboard.press('Escape');
  await click(page,'New');await expect(page.getByRole('dialog',{name:'New document',exact:true})).toBeVisible();await scan('new-document-dialog');
  await number(page,'Width (px)','3');await number(page,'Height (px)','2');await click(page,'Create');await expect(page.getByRole('dialog',{name:'New document',exact:true})).toBeHidden();
  const prompt=page.getByRole('textbox',{name:'Prompt',exact:true});await expect(prompt).toBeVisible();await prompt.fill('A local accessibility review.');await scan('typed-request');

  await step('open-request-conflict',async()=>{
    await page.getByRole('combobox',{name:'Operation',exact:true}).selectOption('Generate with Fast');
    await click(page,'Review exact request');await expect(page.getByRole('heading',{name:'Request needs attention',exact:true})).toBeVisible();
    await expect(page.getByRole('link',{name:/^INACTIVE_INPUT:.*acceleration/})).toBeVisible();
  });
  await scan('request-conflict');
  await click(page,'Keep acceleration inactive in this draft');await click(page,'Review exact request');await expect(page.getByRole('heading',{name:'Immutable request review',exact:true})).toBeVisible();await scan('immutable-request-review');
  await click(page,'Close request review');
  await click(page,'Adapter library');await expect(page.getByRole('region',{name:'Local adapter library',exact:true})).toBeVisible();await scan('adapter-library');await click(page,'Adapter library');

  await click(page,'Text');
  const text=page.getByRole('textbox',{name:'Edit text — Text',exact:true});await expect(text).toBeVisible();await text.fill('Editable local text');await scan('native-text-draft');
  await text.fill('🧑');await click(page,'Preview text');await expect(page.getByRole('region',{name:'Text editing',exact:true}).getByText(/Missing glyphs in selected fonts/)).toBeVisible();
  await expect(text).toHaveAttribute('aria-invalid','true');await expect(text).toHaveAttribute('aria-errormessage','native-text-error');await expect(text).toHaveAccessibleDescription(/Missing glyphs in selected fonts/);await scan('native-text-glyph-error');
  await click(page,'Local font import and exact relink');await expect(page.getByRole('button',{name:'Relink exact font',exact:true})).toBeVisible();await scan('local-font-relink-controls');await click(page,'Cancel text edit');await expect(text).toBeHidden();

  await step('open-composition-validation',async()=>{
    await promptSource(page,'Composition');await expect(page.getByRole('textbox',{name:'Scene',exact:true})).toBeVisible();
    await click(page,'Add object');await click(page,'Add literal bounds');await number(page,'Width in document pixels','0');await click(page,'Preview request draft');
    const errors=page.locator('#composition-errors').locator('section[part="base"]');
    await expect(errors).toBeVisible();
    const heading=errors.locator('h2[part="heading"]'),issue=errors.locator('a[part="link"]');
    await expect(heading).toBeVisible();await expect(heading).toHaveText('Composition needs attention');
    await expect(issue).toBeVisible();await expect(issue).toHaveText('INVALID_GEOMETRY: INVALID_GEOMETRY');
  });
  await scan('composition-validation');
  await promptSource(page,'Plain prompt');

  await click(page,'Import image');await page.getByLabel('Image file',{exact:true}).setInputFiles('tests/raster/fixtures/hidden-alpha.png');
  const importDialog=page.getByRole('dialog',{name:'Import image',exact:true});await expect(importDialog).toBeVisible();
  const importContent=page.locator('#editor-dialog');
  await expect(importContent.getByRole('img',{name:'Conversion preview: hidden-alpha.png',exact:true})).toBeVisible();
  const importChoice=importContent.getByRole('switch',{name:'Import hidden-alpha.png',exact:true});await expect(importChoice).toBeEnabled();await expect(importChoice).not.toBeChecked();await scan('image-conversion-review');
  await confirmImageImports(page,{names:['hidden-alpha.png'],destination:'current'});await expect(page.getByText('ImportAsset accepted and saved locally.',{exact:true})).toBeVisible();const layers=page.getByRole('tab',{name:'Layers',exact:true});await layers.click();await expect(layers).toHaveAttribute('aria-selected','true');await page.locator('#layer-tree').getByRole('treeitem',{name:'Image · hidden-alpha.png · visible',exact:true}).click();
  await step('open-layer-mask-review',async()=>{
    await click(page,'Select');await number(page,'Selection X','1');await number(page,'Selection Y','0');await number(page,'Selection width','1');await number(page,'Selection height','2');
    await click(page,'Apply selection');await click(page,'Use selection as mask');await number(page,'Feather radius (document px)','0');await click(page,'Preview mask');
    await expect(page.getByRole('button',{name:'Apply layer mask',exact:true})).toBeEnabled();
  });
  await scan('layer-mask-review');await click(page,'Apply layer mask');await expect(page.getByText('SetLayerProperties accepted and saved locally.',{exact:true})).toBeVisible();
  await step('open-masked-request-review',async()=>{
    await page.getByRole('combobox',{name:'Operation',exact:true}).selectOption('Edit masked region');await prompt.fill('Review the retained edit region.');
    await page.getByRole('combobox',{name:'Request size',exact:true}).selectOption('auto');await click(page,'Use operation strength default');await expect(page.getByRole('spinbutton',{name:'Transformation strength',exact:true})).toHaveValue('1');
    await click(page,'Capture all visible layers');
    await expect(page.getByRole('region',{name:'Request source and separate edit mask',exact:true})).toHaveAttribute('aria-busy','false');
    for(const [name,value] of [['Mask X','1'],['Mask Y','0'],['Mask width','1'],['Mask height','2'],['Feather radius in document pixels','0']])await number(page,name!,value!);
    await click(page,'Build request mask shape');await click(page,'Preview request crop and mapping');
    await click(page,'Approve this source, mask and mapping');
    await expect(page.locator('#request-mask-status')).toContainText('Request mask plan confirmed.');
    await click(page,'Review current request document');await expect(page.locator('.typed-request').getByText('Request document revision confirmed.',{exact:true})).toBeVisible();await click(page,'Review exact request');await expect(page.getByRole('heading',{name:'Immutable request review',exact:true})).toBeVisible();
  },20_000);
  await scan('masked-request-review');await click(page,'Close request review');
  await click(page,'Save copy');await expect(page.getByRole('dialog',{name:'Save project copy',exact:true})).toBeVisible();await scan('portable-copy-dialog');await page.keyboard.press('Escape');await expect(page.getByRole('dialog',{name:'Save project copy',exact:true})).toBeHidden();await evidence.captureExposed('portable-copy-dialog','activity');
  await page.getByRole('tab',{name:'Jobs',exact:true}).click();await expect(page.getByRole('tab',{name:'Jobs',exact:true})).toHaveAttribute('aria-selected','true');await scan('empty-jobs');
  await page.getByRole('tab',{name:'Results',exact:true}).click();await expect(page.getByRole('tab',{name:'Results',exact:true})).toHaveAttribute('aria-selected','true');await scan('empty-results');
  await prompt.focus();await page.setViewportSize({width:320,height:900});await expect(prompt).toBeVisible();await scan('request-320css');
  await evidence.finish();
});
