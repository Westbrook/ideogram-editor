import {expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {test,out} from './spectrum-fixture.js';
import {captureFrame} from './spectrum-frame.js';
import {alignment} from './spectrum-alignment.js';
const tokens=JSON.parse(await readFile('vendor/themes/spectrum/compiled.json','utf8'));
const color=(mode:string,id:string)=>tokens.branches[mode].tokens[id].value.replace(/rgb\((\d+) (\d+) (\d+) \/ 1\)/,'rgb($1, $2, $3)');
test('Spectrum Select labels, native values, focus and responsive appearance',async({smoke:{page,step,record}})=>{
 await step('original-compact-density',()=>page.getByRole('combobox',{name:'Density',exact:true}).selectOption('compact'));
 const appearance=page.getByRole('combobox',{name:'Appearance',exact:true});
 const root=page.locator('html');
 await step('default-system',()=>expect(appearance).toHaveValue('auto'));
 await step('system-dark',()=>page.emulateMedia({colorScheme:'dark'}));
 await step('system-follows',()=>expect(root).toHaveCSS('background-color',color('dark','color.canvas')));
 for(const width of [1440,390]){
  await step('viewport-'+width,()=>page.setViewportSize({width,height:1000}));
  for(const mode of ['light','dark']){
   const prefix=mode+'-'+width;
   await step(prefix+'-choose',()=>appearance.selectOption(mode));
   await step(prefix+'-mode',()=>expect(root).toHaveAttribute('data-en-appearance',mode));
   await step(prefix+'-opposite-system',()=>page.emulateMedia({colorScheme:mode==='light'?'dark':'light'}));
   await step(prefix+'-canvas',()=>expect(root).toHaveCSS('background-color',color(mode,'color.canvas')));
   await step(prefix+'-pan-alignment',async()=>record({phase:'alignment',mode,width,...await alignment(page)}));
   for(const name of ['Appearance','Operation']){
    const control=page.getByRole('combobox',{name,exact:true});const host=page.locator('en-select').filter({has:control});
    const label=prefix+'-'+name.toLowerCase();
    await step(label+'-selection',async()=>{
     await expect(control).toHaveCount(1);await expect(control).toBeEnabled();
     if(name==='Operation'){
      await control.selectOption('Generate with Instant');await expect(control).toHaveValue('Generate with Instant');
      await control.selectOption('Generate image');
     }
     await expect(control).toHaveValue(name==='Appearance'?mode:'Generate image');
    });
    await step(label+'-keyboard',async()=>{
     await page.evaluate(()=>window.scrollTo(0,0));await control.scrollIntoViewIfNeeded();await control.focus();
     await control.press('Tab');await page.keyboard.press('Shift+Tab');await expect(control).toBeFocused();
     await control.press('Escape');await expect(control).toHaveValue(name==='Appearance'?mode:'Generate image');
    });
    await step(label+'-paint',async()=>{
     await expect(control).toHaveCSS('background-color',color(mode,'color.surface'));
     await expect(control).toHaveCSS('color',color(mode,'color.text'));
     await expect(control).toHaveCSS('appearance','none');
    });
    await step(label+'-geometry',async()=>{
     await page.evaluate(async()=>{await document.fonts.ready;});
     const native=await control.evaluate(node=>{
      const input=node as HTMLSelectElement,s=getComputedStyle(input),r=input.getBoundingClientRect();
      const text=input.selectedOptions[0]?.textContent??'';const canvas=document.createElement('canvas');const ctx=canvas.getContext('2d')!;ctx.font=s.font;
      return {tag:input.tagName,value:input.value,text,font:s.font,textWidth:ctx.measureText(text).width,
       rect:{x:r.x,y:r.y,width:r.width,height:r.height},paddingStart:parseFloat(s.paddingInlineStart),paddingEnd:parseFloat(s.paddingInlineEnd),border:parseFloat(s.borderInlineStartWidth),
       appearance:s.appearance,color:s.color,background:s.backgroundColor,focused:input.matches(':focus'),focusVisible:input.matches(':focus-visible'),outline:s.outline,viewport:innerWidth};
     });
     const caret=await host.locator('[part~="focus-frame"]').evaluate(node=>{const s=getComputedStyle(node,'::before');return {content:s.content,width:parseFloat(s.width),end:parseFloat(s.insetInlineEnd),color:s.color,border:parseFloat(s.borderBlockEndWidth),pointerEvents:s.pointerEvents,mask:s.maskImage,background:s.backgroundImage};});
     await record({phase:'select-control',mode,width,name,native,caret});
     expect(native.tag).toBe('SELECT');expect(native.text).toBe(name==='Appearance'?(mode==='light'?'Light':'Dark'):'Generate image');
     expect(native.rect.height).toBeGreaterThanOrEqual(24);expect(native.rect.width).toBeGreaterThanOrEqual(24);
     expect(native.rect.x).toBeGreaterThanOrEqual(0);expect(native.rect.x+native.rect.width).toBeLessThanOrEqual(width+1);
     expect(native.textWidth).toBeLessThanOrEqual(native.rect.width-native.paddingStart-native.paddingEnd-2*native.border);
     expect(native.focused).toBe(true);expect(native.focusVisible).toBe(true);
     expect(caret.content).toBe('""');expect(caret.width).toBeGreaterThan(0);expect(caret.border).toBeGreaterThan(0);
     expect(caret.pointerEvents).toBe('none');expect(caret.mask).toBe('none');expect(caret.background).toBe('none');
     expect(native.paddingEnd).toBeGreaterThanOrEqual(caret.end+caret.width);
    });
    await step(label+'-capture',async()=>{if(process.env.SPECTRUM_BROWSER==='webkit')await captureFrame(page,join(out,label+'.jpg'),record);else await page.screenshot({path:join(out,label+'.png'),fullPage:true,animations:'allow',caret:'initial'});});
   }
  }
 }
 await step('return-system',()=>appearance.selectOption('auto'));
 await step('system-light',()=>page.emulateMedia({colorScheme:'light'}));
 await step('system-light-paint',()=>expect(root).toHaveCSS('background-color',color('light','color.canvas')));
 await step('reload',()=>page.reload());
 await step('reload-recovery-ready',()=>expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible());
 await step('system-saved',()=>expect(appearance).toHaveValue('auto'));
});
