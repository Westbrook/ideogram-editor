import {expect} from '@playwright/test';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {test,out} from './spectrum-fixture.js';
import {alignment} from './spectrum-alignment.js';
const tokens=JSON.parse(await readFile('vendor/themes/spectrum/compiled.json','utf8'));
const color=(mode:string)=>tokens.branches[mode].tokens['color.canvas'].value.replace(/rgb\((\d+) (\d+) (\d+) \/ 1\)/,'rgb($1, $2, $3)');
test('Spectrum responsive pan-button alignment and appearance',async({smoke:{page,step,record}})=>{
 await step('original-compact-density',()=>page.getByRole('combobox',{name:'Density',exact:true}).selectOption('compact'));
 for(const width of [1440,390]){
  await step('viewport-'+width,()=>page.setViewportSize({width,height:1000}));
  for(const mode of ['light','dark']){
   const prefix=mode+'-'+width;
   await step(prefix+'-choose',()=>page.getByRole('combobox',{name:'Appearance',exact:true}).selectOption(mode));
   await step(prefix+'-paint',()=>expect(page.locator('html')).toHaveCSS('background-color',color(mode)));
   await step(prefix+'-alignment',async()=>record({phase:'alignment',mode,width,...await alignment(page)}));
   await step(prefix+'-capture',()=>page.screenshot({path:join(out,prefix+'-alignment.png'),fullPage:true,animations:'allow',caret:'initial'}));
  }
 }
});
