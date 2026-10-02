// Authored for the real browser fixture; not executed in the source-only staging lane.
import {test as base,expect,type Page} from '@playwright/test';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {serverProcess} from './process.js';
import {ownedOPFS} from './owned-opfs.js';
import {confirmImageImports} from './image-import-flow.js';
const test=base.extend({context:async({playwright,browserName,contextOptions,viewport},use)=>{
 const profile=browserName==='webkit'?await mkdtemp(join(await realpath(tmpdir()),'ie-zoom-webkit-')):undefined;
 const browser=profile?undefined:await playwright[browserName].launch();
 const context=profile?await playwright.webkit.launchPersistentContext(profile,{...contextOptions,viewport}):await browser!.newContext({...contextOptions,viewport});
 await Promise.all(context.pages().map(page=>page.close()));
 try{await use(context);}finally{await context.close();await browser?.close();if(profile)await rm(profile,{recursive:true,force:true});}
}});
type PointerObservation={type:string;pointerId:number;trusted:boolean;defaultPreventedAtCapture:boolean;button:number;buttons:number;alt:boolean;x:number;y:number;target:{tag:string;id:string}|null;targetCanvas:boolean;hitCanvas:boolean};
const click=(page:Page,name:string)=>page.getByRole('button',{name,exact:true}).click();
const viewport=(page:Page)=>page.evaluate(()=>{
 const mark=performance.getEntriesByName('ie.viewport.drawn').at(-1) as PerformanceMark|undefined;
 if(!mark)throw Error('No actual canvas viewport submission');return mark.detail as {zoom:number;x:number;y:number};
});
test('Zoom pointer clicks keep their exact canvas anchor, Alt reverses the step, and drag never falls through to Pan',async({page,context,browserName},testInfo)=>{
 const guard=await ownedOPFS(context,'zoom-tool-'+browserName),dir=await mkdtemp(join(await realpath(tmpdir()),'ie-zoom-tool-')),server=await serverProcess(join(dir,'private'));
 const failures:unknown[]=[],cleanup={guardAttempted:false,guardVerified:false,serverCloseReturned:false,tempDirectoryRemoved:false};let anchor:{x:number;y:number}|null=null,diagnostics:import('@playwright/test').JSHandle<{read:()=>{events:PointerObservation[];dropped:number};finish:(point:{x:number;y:number}|null)=>unknown}>|undefined;
 try{
  await guard.admit(page,server.origin);await page.goto(await server.pair());await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();
  await page.locator('.canvas-empty en-file-upload input[type=file]').setInputFiles('tests/raster/fixtures/hidden-alpha.png');await confirmImageImports(page,{names:['hidden-alpha.png'],destination:'new',close:false});await expect(page.getByText('ImportAsset accepted and saved locally.',{exact:true})).toBeVisible();const importControls=page.locator('en-dialog#editor-dialog');await importControls.getByRole('button',{name:'Open imported document',exact:true}).click();await expect(page.locator('canvas[data-asset]')).not.toHaveAttribute('data-asset','');await importControls.getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.getByRole('dialog',{name:'Import image',exact:true})).toBeHidden();
  // Observe native delivery without reading or mutating application controllers.
  diagnostics=await page.evaluateHandle(()=>{
   const canvas=document.querySelector('canvas[aria-label="Document raster preview"]')!,events:PointerObservation[]=[],types=['pointerdown','pointerup','pointercancel','lostpointercapture'];let dropped=0;
   const identity=(node:EventTarget|null)=>node instanceof Element?{tag:node.tagName.slice(0,64),id:node.id.slice(0,128)}:null;
   const record=(event:Event)=>{const e=event as PointerEvent;if(events.length>=32){dropped++;return;}events.push({type:e.type,pointerId:e.pointerId,trusted:e.isTrusted,defaultPreventedAtCapture:e.defaultPrevented,button:e.button,buttons:e.buttons,alt:e.altKey,x:e.clientX,y:e.clientY,target:identity(e.composedPath()[0]??e.target),targetCanvas:(e.composedPath()[0]??e.target)===canvas,hitCanvas:document.elementFromPoint(e.clientX,e.clientY)===canvas});};
   for(const type of types)document.addEventListener(type,record,{capture:true,passive:true});
   return {read(){return {events:events.slice(),dropped};},finish(point:{x:number;y:number}|null){
    for(const type of types)document.removeEventListener(type,record,true);
    const box=canvas.getBoundingClientRect(),drawn=(performance.getEntriesByName('ie.viewport.drawn').at(-1) as PerformanceMark|undefined)?.detail,updated=(performance.getEntriesByName('ie.editor.updated').at(-1) as PerformanceMark|undefined)?.detail;
    const operation=document.querySelector('[aria-label="Operation status"]'),status=operation?.textContent??'',view=document.querySelector('.canvas-toolbar')?.textContent??'';
    return {limit:32,dropped,events,anchor:point,hit:point?identity(document.elementFromPoint(point.x,point.y)):null,hitCanvas:point?document.elementFromPoint(point.x,point.y)===canvas:null,canvas:{x:box.x,y:box.y,width:box.width,height:box.height,connected:canvas.isConnected,hasAsset:!!canvas.getAttribute('data-asset')},viewport:{width:innerWidth,height:innerHeight,scrollX,scrollY},tools:[...document.querySelectorAll('.tool')].slice(0,8).map(tool=>({name:tool.querySelector('[slot="label"]')?.textContent?.trim().slice(0,16),pressed:tool.getAttribute('aria-pressed')})),drawn:drawn?{zoom:drawn.zoom,x:drawn.x,y:drawn.y}:null,editor:updated?{ready:updated.ready===true,busy:updated.busy===true,documentPresent:typeof updated.documentId==='string'&&updated.documentId.length>0}:null,operation:{busy:operation?.getAttribute('aria-busy'),attention:/Action needs attention/.test(status),storage:/Storage paused/.test(status),stale:/[Ss]tale/.test(status),unavailable:/unavailable|missing/.test(status),graphicsRecovery:/graphics recovery|Restoring canvas/.test(view)}};
   }};
  });
  await click(page,'100%');await click(page,'Zoom');
  await expect(page.getByRole('button',{name:'Zoom',exact:true})).toHaveAttribute('aria-pressed','true');await expect(page.getByRole('spinbutton',{name:'Zoom percentage',exact:true})).toHaveValue('100');await expect(page.getByRole('region',{name:'Operation status',exact:true})).toHaveAttribute('aria-busy','false');
  await expect.poll(()=>page.evaluate(()=>{const value=(performance.getEntriesByName('ie.editor.updated').at(-1) as PerformanceMark|undefined)?.detail;return !!(value?.ready&&!value.busy&&value.documentId);})).toBe(true);
  await page.getByLabel('Document raster preview',{exact:true}).scrollIntoViewIfNeeded();
  const canvas=page.getByLabel('Document raster preview',{exact:true}),box=(await canvas.boundingBox())!,x=box.x+box.width*.62,y=box.y+box.height*.43,before=await viewport(page),revision=await page.locator('.document-name').textContent();
  anchor={x,y};expect(before.zoom).toBe(1);expect(await canvas.evaluate((node,point)=>document.elementFromPoint(point.x,point.y)===node,anchor)).toBe(true);
  const delivery=async(cursor:number,alt:boolean)=>{
   const {events,dropped}=await diagnostics!.evaluate(capture=>capture.read());expect(dropped).toBe(0);
   const added=events.slice(cursor);expect(added.some(event=>event.type==='pointercancel')).toBe(false);
   const pair=added.filter(event=>event.type==='pointerdown'||event.type==='pointerup');expect(pair.map(event=>event.type)).toEqual(['pointerdown','pointerup']);
   const down=pair[0]!,up=pair[1]!;
   for(const [event,buttons] of [[down,1],[up,0]] as const){
    expect(event).toMatchObject({trusted:true,button:0,buttons,alt,targetCanvas:true,hitCanvas:true});expect(Number.isFinite(event.x)&&Number.isFinite(event.y)).toBe(true);
    // Subpixel request-to-delivery sanity is separate from the unchanged exact anchor tolerances.
    expect(Math.abs(event.x-x)).toBeLessThan(1);expect(Math.abs(event.y-y)).toBeLessThan(1);
   }
   expect(up.pointerId).toBe(down.pointerId);expect(up.x).toBe(down.x);expect(up.y).toBe(down.y);
   return {x:down.x,y:down.y,cursor:events.length};
  };
  const inputStart=await diagnostics.evaluate(capture=>capture.read().events.length);
  await page.mouse.click(x,y);await expect(page.getByRole('spinbutton',{name:'Zoom percentage',exact:true})).toHaveValue('110');const after=await viewport(page),nativeAnchor=await delivery(inputStart,false);
  expect(after.zoom).toBeCloseTo(before.zoom*1.1,12);
  expect((nativeAnchor.x-box.x-box.width/2-after.x)/after.zoom).toBeCloseTo((nativeAnchor.x-box.x-box.width/2-before.x)/before.zoom,10);
  expect((nativeAnchor.y-box.y-box.height/2-after.y)/after.zoom).toBeCloseTo((nativeAnchor.y-box.y-box.height/2-before.y)/before.zoom,10);
  await page.keyboard.down('Alt');try{await page.mouse.click(x,y);}finally{await page.keyboard.up('Alt');}await expect(page.getByRole('spinbutton',{name:'Zoom percentage',exact:true})).toHaveValue('100');const reversed=await viewport(page),reversedAnchor=await delivery(nativeAnchor.cursor,true);expect({x:reversedAnchor.x,y:reversedAnchor.y}).toEqual({x:nativeAnchor.x,y:nativeAnchor.y});
  expect(reversed.zoom).toBeCloseTo(before.zoom,12);expect(reversed.x).toBeCloseTo(before.x,10);expect(reversed.y).toBeCloseTo(before.y,10);
  await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+15,y+8);await page.mouse.up();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));expect(await viewport(page)).toEqual(reversed);
  await page.mouse.move(x,y);await page.mouse.down();await page.locator('#canvas').focus();await page.keyboard.press('Escape');await page.mouse.up();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));expect(await viewport(page)).toEqual(reversed);
  await click(page,'Pan');await expect(page.getByRole('button',{name:'Pan',exact:true})).toHaveAttribute('aria-pressed','true');await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+12,y+6);await page.mouse.up();const panned=await viewport(page);expect(panned.zoom).toBe(reversed.zoom);expect(panned.x).toBeCloseTo(reversed.x+12,10);expect(panned.y).toBeCloseTo(reversed.y+6,10);
  await page.getByRole('button',{name:'100%',exact:true}).focus();await page.keyboard.press('Enter');await expect(page.getByRole('spinbutton',{name:'Zoom percentage',exact:true})).toHaveValue('100');expect(await page.locator('.document-name').textContent()).toBe(revision);expect(Object.values(await server.effects()).every(value=>value===0)).toBe(true);
 }catch(error){failures.push(error);}finally{
  if(diagnostics){try{const evidence=await diagnostics.evaluate((capture,point)=>capture.finish(point),anchor);await testInfo.attach('zoom-pointer-public-evidence',{body:JSON.stringify(evidence,null,2),contentType:'application/json'});}catch(error){failures.push(error);}finally{try{await diagnostics.dispose();}catch(error){failures.push(error);}}}
  try{cleanup.guardAttempted=true;await guard.cleanup();guard.verify();cleanup.guardVerified=true;}catch(error){failures.push(error);}
  try{await server.close();cleanup.serverCloseReturned=true;await rm(dir,{recursive:true,force:true});cleanup.tempDirectoryRemoved=true;}catch(error){failures.push(error);}
  try{
   // Capture after cleanup so a refusal's actual reason survives; never alter guard admission or reset policy.
   const limits={ledger:256,requests:512,string:512,list:16},dropped={ledger:Math.max(0,guard.ledger.length-limits.ledger),requests:Math.max(0,guard.requests.length-limits.requests),strings:0,listValues:0};
   const text=(value:unknown)=>{if(typeof value!=='string')return undefined;if(value.length>limits.string)dropped.strings++;return value.slice(0,limits.string);};
   const number=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)?value:undefined;
   const strings=(value:unknown)=>{if(!Array.isArray(value))return undefined;dropped.listValues+=Math.max(0,value.length-limits.list);return value.slice(0,limits.list).map(text);};
   const ledger=guard.ledger.slice(0,limits.ledger).map(entry=>({phase:text(entry.phase),reason:text(entry.reason),error:text(entry.error),origin:text(entry.origin),admitted:strings(entry.admitted),visited:strings(entry.visited),reasons:strings(entry.reasons),resetCalls:number(entry.resetCalls),count:number(entry.count),cookieCount:number(entry.cookieCount),entryCount:Array.isArray(entry.entries)?entry.entries.length:undefined,localStorage:number(entry.localStorage),databaseCount:Array.isArray(entry.indexedDB)?entry.indexedDB.length:undefined,serviceWorkers:number(entry.serviceWorkers)}));
   const requests=guard.requests.slice(0,limits.requests).map(entry=>({sequence:number(entry.sequence),at:text(entry.at),monotonicMs:number(entry.monotonicMs),event:text(entry.event),requestId:number(entry.requestId),method:text(entry.method),location:entry.location?{protocol:text(entry.location.protocol),origin:text(entry.location.origin),path:text(entry.location.path),invalid:entry.location.invalid===true}:undefined,resourceType:text(entry.resourceType),pageId:number(entry.pageId),frameId:number(entry.frameId),frameIdentity:text(entry.frameIdentity),guardPhase:text(entry.guardPhase)}));
   const evidence={limits,dropped,counts:{ledger:guard.ledger.length,requests:guard.requests.length},cleanup:{...cleanup,remainingContextPages:context.pages().length,contextClosure:'Owned context fixture runs its existing close after this test body.'},ledger,requests};
   if(Object.values(dropped).some(value=>value!==0))failures.push(Error('ZOOM_OWNERSHIP_DIAGNOSTICS_TRUNCATED'));
   await testInfo.attach('zoom-owned-cleanup-evidence',{body:JSON.stringify(evidence,null,2),contentType:'application/json'});
  }catch(error){failures.push(error);}
 }
 if(failures.length===1)throw failures[0];
 if(failures.length)throw new AggregateError(failures,'Zoom pointer assertions and owned cleanup failed');
});
