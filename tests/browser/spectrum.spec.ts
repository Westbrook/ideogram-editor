import {expect,type Locator} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {test,out} from './spectrum-fixture.js';
import {captureFrame} from './spectrum-frame.js';
import {alignment} from './spectrum-alignment.js';
const tokens=JSON.parse(await readFile('vendor/themes/spectrum/compiled.json','utf8'));
const color=(mode:string,id:string)=>tokens.branches[mode].tokens[id].value.replace(/rgb\((\d+) (\d+) (\d+) \/ 1\)/,'rgb($1, $2, $3)');
const paint=(locator:Locator)=>locator.evaluate(node=>{const s=getComputedStyle(node);return {background:s.backgroundColor,color:s.color,radius:s.borderRadius,font:s.fontFamily,outline:s.outlineColor,outlineWidth:s.outlineWidth};});
test('Spectrum full appearance and public control smoke',async({smoke:{page,step,record}})=>{
  // Retained Spectrum captures compare the approved original compact theme.
  await step('original-compact-density',()=>page.getByRole('combobox',{name:'Density',exact:true}).selectOption('compact'));
  const appearance=page.getByRole('combobox',{name:'Appearance',exact:true});
  const root=page.locator('html');
  const capture=(name:string)=>step('capture-'+name,async()=>{if(process.env.SPECTRUM_BROWSER==='webkit')await captureFrame(page,join(out,name+'.jpg'),record);else await page.screenshot({path:join(out,name+'.png'),fullPage:true,animations:'allow',caret:'initial'});});
  await step('system-default',()=>expect(appearance).toHaveValue('auto'));
  await step('system-light-paint',()=>expect(root).toHaveCSS('background-color',color('light','color.canvas')));
  await step('system-dark-change',()=>page.emulateMedia({colorScheme:'dark'}));
  await step('system-dark-paint',()=>expect(root).toHaveCSS('background-color',color('dark','color.canvas')));
  for(const width of [1440,390]){
    await step('viewport-'+width,()=>page.setViewportSize({width,height:1000}));
    for(const mode of ['light','dark']){
      const prefix=mode+'-'+width+'-';
      const act=<T>(name:string,work:()=>Promise<T>)=>step(prefix+name,work);
      await act('choose',()=>appearance.selectOption(mode));
      await act('attribute',()=>expect(root).toHaveAttribute('data-en-appearance',mode));
      await act('canvas',()=>expect(root).toHaveCSS('background-color',color(mode,'color.canvas')));
      await act('surface',()=>expect(page.locator('.document-bar')).toHaveCSS('background-color',color(mode,'color.surface')));
      await act('no-overflow',async()=>expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true));
      await act('opposite-system',()=>page.emulateMedia({colorScheme:mode==='light'?'dark':'light'}));
      await act('explicit-stays',()=>expect(root).toHaveCSS('background-color',color(mode,'color.canvas')));
      await act('pan-alignment',async()=>record({phase:'alignment',mode,width,...await alignment(page)}));
      await capture(prefix+'shell');
      if(width===390&&process.env.SPECTRUM_BROWSER==='webkit'){
        const scroll=await page.evaluate(()=>({x:scrollX,y:scrollY}));
        let captureError:unknown;
        try{
          await act('pan-scroll',()=>page.locator('.pan-fields').scrollIntoViewIfNeeded());
          await capture(prefix+'pan');
        }catch(error){captureError=error;}
        try{await act('pan-scroll-restore',async()=>{await page.evaluate(({x,y})=>window.scrollTo(x,y),scroll);await expect.poll(()=>page.evaluate(()=>({x:scrollX,y:scrollY}))).toEqual(scroll);});}
        catch(error){throw captureError?new AggregateError([captureError,error],'Pan capture and restoration failed'):error;}
        if(captureError)throw captureError;
      }
      await act('new-click',()=>page.getByRole('button',{name:'New',exact:true}).click());
      const dialog=page.getByRole('dialog',{name:'New document',exact:true});
      await act('named-dialog',()=>expect(dialog).toBeVisible());
      const field=page.locator('#editor-dialog').getByRole('spinbutton',{name:'Width (px)',exact:true});
      await act('field-fill',()=>field.fill('512'));
      await act('field-tab',()=>field.press('Tab'));
      await act('field-value',()=>expect(field).toHaveValue('512'));
      const create=page.locator('#editor-dialog').getByRole('button',{name:'Create',exact:true});
      await act('primary-rest',()=>expect(create).toHaveCSS('background-color',color(mode,'theme.button.primary.rest-background')));
      await act('primary-radius',()=>expect(create).toHaveCSS('border-radius','9999px'));
      await act('primary-hover',()=>create.hover());
      await act('primary-hover-paint',()=>expect(create).toHaveCSS('background-color',color(mode,'theme.button.primary.hover-background')));
      await act('primary-focus',()=>create.focus());
      await act('tab',()=>page.keyboard.press('Tab'));
      await act('shift-tab',()=>page.keyboard.press('Shift+Tab'));
      await act('keyboard-focus',()=>expect(create).toBeFocused());
      await act('record-paints',async()=>record({phase:'paints',mode,width,root:await paint(root),primary:await paint(create),field:await paint(field),overlay:await paint(dialog)}));
      await capture(prefix+'dialog');
      await act('dialog-escape',()=>page.keyboard.press('Escape'));
      await act('dialog-hidden',()=>expect(dialog).toBeHidden());
      const help=page.getByRole('button',{name:'Help',exact:true});
      await act('help-click',()=>help.click());
      const drawer=page.getByRole('dialog',{name:'Editor help',exact:true});
      await act('help-dialog',()=>expect(drawer).toBeVisible());
      await capture(prefix+'help');
      await act('help-escape',()=>page.keyboard.press('Escape'));
      await act('help-hidden',()=>expect(drawer).toBeHidden());
      await act('help-focus-return',()=>expect(help).toBeFocused());
      await act('connection-click',()=>page.getByRole('button',{name:'Connected locally',exact:true}).click());
      const renew=page.getByRole('button',{name:'Renew connection',exact:true});
      await act('popover-visible',()=>expect(renew).toBeVisible());
      await act('secondary-rest',()=>expect(renew).toHaveCSS('background-color',color(mode,'theme.button.secondary.rest-background')));
      await act('record-secondary',async()=>record({phase:'secondary',mode,width,paint:await paint(renew)}));
      await act('popover-escape',()=>page.keyboard.press('Escape'));
      await act('popover-hidden',()=>expect(renew).toBeHidden());
    }
  }
  await step('reload-explicit',()=>page.reload());
  await step('reload-explicit-recovery-ready',()=>expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible());
  await step('reload-dark-choice',()=>expect(appearance).toHaveValue('dark'));
  await step('reload-dark-paint',()=>expect(root).toHaveCSS('background-color',color('dark','color.canvas')));
  await step('choose-system',()=>appearance.selectOption('auto'));
  await step('system-light-change',()=>page.emulateMedia({colorScheme:'light'}));
  await step('system-light-follow',()=>expect(root).toHaveCSS('background-color',color('light','color.canvas')));
  await step('reload-system',()=>page.reload());
  await step('reload-system-recovery-ready',()=>expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible());
  await step('reload-system-choice',()=>expect(appearance).toHaveValue('auto'));
  await step('no-report-return',async()=>expect(await page.locator('.report-return').count()).toBe(0));
  await step('invalid-saved-choice',()=>page.evaluate(()=>localStorage.setItem('ideogram.appearance','invalid')));
  await step('reload-invalid',()=>page.reload());
  await step('reload-invalid-recovery-ready',()=>expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible());
  await step('invalid-default-system',()=>expect(appearance).toHaveValue('auto'));
  await step('invalid-system-paint',()=>expect(root).toHaveCSS('background-color',color('light','color.canvas')));
  await step('unavailable-storage-fixture',()=>page.context().addInitScript(()=>{
    if(location.pathname!=='/')return;
    const get=Storage.prototype.getItem,set=Storage.prototype.setItem;
    Storage.prototype.getItem=function(key){if(key==='ideogram.appearance')throw new DOMException('Test storage unavailable','SecurityError');return get.call(this,key);};
    Storage.prototype.setItem=function(key,value){if(key==='ideogram.appearance')throw new DOMException('Test storage unavailable','SecurityError');return set.call(this,key,value);};
  }));
  await step('reload-unavailable',()=>page.reload());
  await step('reload-unavailable-recovery-ready',()=>expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible());
  await step('unavailable-default-system',()=>expect(appearance).toHaveValue('auto'));
  await step('unavailable-select-dark',()=>appearance.selectOption('dark'));
  await step('unavailable-current-view',()=>expect(root).toHaveCSS('background-color',color('dark','color.canvas')));
  await step('unavailable-reload',()=>page.reload());
  await step('unavailable-reload-recovery-ready',()=>expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible());
  await step('unavailable-default-again',()=>expect(appearance).toHaveValue('auto'));
});
