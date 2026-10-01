import {specReceipt} from './receipt-path.js';
import {test,expect,type Page} from '@playwright/test';
import {mkdtemp,realpath,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {serverProcess} from './process.js';
const receipt=specReceipt(import.meta.url,'artifacts/p1b7/current');
async function setup(page:Page){const dir=await mkdtemp(join(await realpath(tmpdir()),'ie-rail-'));const server=await serverProcess(join(dir,'private'));await page.goto(await server.pair());await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();return server;}
async function geometry(page:Page){return page.locator('.tool').evaluateAll(hosts=>hosts.map(host=>{const control=host.shadowRoot!.querySelector<HTMLElement>('[part~=control]')!,b=control.getBoundingClientRect(),icon=host.querySelector('svg')!.getBoundingClientRect(),label=host.querySelector('[slot=label]')!.getBoundingClientRect(),s=getComputedStyle(control);return {name:host.textContent!.trim(),width:b.width,height:b.height,iconBottom:icon.bottom,labelTop:label.top,centerDifference:Math.abs(icon.x+icon.width/2-label.x-label.width/2),background:s.backgroundColor,border:s.borderColor,fontSize:parseFloat(s.fontSize),weight:s.fontWeight,radius:parseFloat(s.borderRadius),opacity:s.opacity};}));}
test('public rail restores icon-over-label surfaces and native disabled, selected, keyboard and pointer behavior',async({page})=>{
 const server=await setup(page),commands:string[]=[];page.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname==='/api/v1/commands')commands.push(r.postData()!);});
 try{
 await expect(page.getByRole('toolbar',{name:'Canvas tools'})).toBeVisible();
 const rail=page.locator('.tool-rail'),pan=rail.getByRole('button',{name:'Pan',exact:true}),zoom=rail.getByRole('button',{name:'Zoom',exact:true});
 await expect(rail.getByRole('button')).toHaveCount(8);await expect(pan).toHaveAttribute('aria-pressed','true');
 const initial=await geometry(page);expect(initial.map(x=>x.name)).toEqual(['Move','Text','Select','Mask','Crop','Sample','Pan','Zoom']);
 for(const g of initial){expect(g.width).toBeGreaterThanOrEqual(44);expect(g.height).toBeGreaterThanOrEqual(48);expect(g.width).toBeLessThanOrEqual(48);expect(g.iconBottom).toBeLessThan(g.labelTop);expect(g.centerDifference).toBeLessThan(1);expect(g.fontSize).toBe(9);expect(g.weight).toBe('500');}
 for(const name of ['Move','Text','Select','Mask','Crop','Sample']){const disabled=rail.getByRole('button',{name,exact:true});await expect(disabled).toBeDisabled();const b=(await disabled.boundingBox())!;await page.mouse.click(b.x+b.width/2,b.y+b.height/2);await expect(pan).toHaveAttribute('aria-pressed','true');const g=initial.find(x=>x.name===name)!;expect(g.background).toBe('rgba(0, 0, 0, 0)');expect(g.border).toBe('rgba(0, 0, 0, 0)');}
 expect(initial.find(x=>x.name==='Zoom')!.border).toBe('rgba(0, 0, 0, 0)');expect(initial.find(x=>x.name==='Pan')!.background).not.toBe('rgba(0, 0, 0, 0)');expect(initial.find(x=>x.name==='Pan')!.radius).toBeGreaterThan(0);
 await mkdir(receipt,{recursive:true});await page.locator('.tool-rail').screenshot({path:join(receipt,'rail-desktop.png')});
 await pan.focus();await page.keyboard.press('ArrowDown');await expect(zoom).toBeFocused();await page.keyboard.press('Enter');await expect(zoom).toHaveAttribute('aria-pressed','true');await expect(pan).toHaveAttribute('aria-pressed','false');
 await page.keyboard.press('ArrowUp');await expect(pan).toBeFocused();await page.keyboard.press('Space');await expect(pan).toHaveAttribute('aria-pressed','true');
 // Native focus may scroll Pan into view; reveal Zoom before pointer input.
 await zoom.scrollIntoViewIfNeeded();const b=(await zoom.boundingBox())!;
 const point={x:b.x+2,y:b.y+b.height/2};
 expect(await zoom.evaluate((el,p)=>(el.getRootNode() as ShadowRoot).host===document.elementFromPoint(p.x,p.y),point)).toBe(true);
 await page.mouse.click(point.x,point.y);await expect(zoom).toHaveAttribute('aria-pressed','true');await pan.click();await page.keyboard.press('Tab');await expect(rail.locator(':focus')).toHaveCount(0);
 expect(commands).toEqual([]);expect(Object.values(await server.effects()).every(v=>v===0)).toBe(true);
 }finally{await server.close();}
});
test('rail keeps full targets and visible labels at narrow and RTL reflow',async({page})=>{
 const server=await setup(page);try{for(const width of [720,320]){await page.setViewportSize({width,height:850});for(const direction of ['ltr','rtl']){await page.evaluate(dir=>document.documentElement.dir=dir,direction);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);for(const g of await geometry(page)){expect(g.width).toBeGreaterThanOrEqual(44);expect(g.height).toBeGreaterThanOrEqual(48);expect(g.iconBottom).toBeLessThan(g.labelTop);}
 const zoom=page.getByRole('button',{name:'Zoom',exact:true});await zoom.click();await expect(zoom).toHaveAttribute('aria-pressed','true');await page.getByRole('button',{name:'Pan',exact:true}).click();await page.locator('.tool-rail').screenshot({path:join(receipt,`rail-${width}-${direction}.png`)});}}
 }finally{await server.close();}
});
