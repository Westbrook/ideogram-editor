import {chromium} from '../../node_modules/playwright/index.mjs';
import {mkdir,writeFile,access} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {serverProcess} from '../../tests/editor/process.ts';
import {ownedOPFS} from '../../tests/editor/owned-opfs.ts';
import {recordDOMErrors} from '../../tests/editor/error-monitor.ts';
const out=new URL('../../artifacts/p1c3-correction/independent-browser-v2/',import.meta.url);await mkdir(out,{mode:0o700});
const server=await serverProcess(new URL('private',out).pathname),browser=await chromium.launch({headless:false,args:['--window-size=1440,1100']}),context=await browser.newContext({viewport:null}),guard=await ownedOPFS(context,'independent-p1c3-real-zoom'),domErrors=await recordDOMErrors(context),page=await context.newPage();
const errors=[],commands=[],checks=[];let passed=false,error,before,after;
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});page.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname==='/api/v1/commands')commands.push(JSON.parse(r.postData()).command.body);});
const button=n=>page.getByRole('button',{name:n,exact:true});
const field=async(n,v)=>{const f=page.getByRole('spinbutton',{name:n,exact:true});await f.fill(v);await f.press('Tab');};
const metrics=()=>page.evaluate(()=>({innerWidth,innerHeight,dpr:devicePixelRatio,visualScale:visualViewport.scale,scrollWidth:document.documentElement.scrollWidth,cssZoom:getComputedStyle(document.documentElement).zoom}));
const start=new Date().toISOString();
try{
 await guard.admit(page,server.origin);await page.goto(await server.pair());await page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true}).waitFor();await page.locator('.canvas-empty en-file-upload input[type=file]').setInputFiles('tests/raster/fixtures/hidden-alpha.png');await button('Apply reviewed result').click();await page.getByText('ImportAsset accepted and saved locally.',{exact:true}).waitFor();await page.getByRole('treeitem').first().click();
 await field('Opacity (0–1)','0.5');await button('Apply properties').click();await page.getByText('SetLayerProperties accepted and saved locally.',{exact:true}).waitFor();await field('X','1');await button('Apply transform').click();await page.getByText('ApplyTransform accepted and saved locally.',{exact:true}).waitFor();
 const visible=page.getByRole('switch',{name:'Visible',exact:true});await visible.focus();await page.keyboard.press('Space');await button('Apply properties').click();await page.getByRole('treeitem').filter({hasText:'hidden'}).waitFor();
 await button('Sample').click();await field('Sample X','2');await field('Sample Y','0');await button('Sample color').click();await page.getByText(/sRGB RGBA \(0, 0, 0, 0\)/).waitFor();checks.push('Hidden layer omitted from canonical merged sample');
 await page.getByRole('radio',{name:'active',exact:true}).focus();await page.keyboard.press('Space');await button('Sample color').click();await page.getByText(/sRGB RGBA \(255, 0, 0, 64\)/).waitFor();checks.push('Explicit hidden active layer includes translation and opacity in canonical sample');
 assert.equal(await page.locator('en-alert').filter({hasText:'sRGB RGBA (255, 0, 0, 64)'}).getAttribute('announcement'),'polite');
 await page.getByRole('spinbutton',{name:'Sample X',exact:true}).focus();await page.getByRole('spinbutton',{name:'Sample X',exact:true}).evaluate(el=>{window.__reviewField=el;window.__reviewParent=el.parentNode;});
 await page.evaluate(()=>document.title='P1c correction zoom verification');before=await metrics();await writeFile(new URL('zoom-ready.json',out),JSON.stringify({before,title:'P1c correction zoom verification',executable:chromium.executablePath()},null,2));console.log('READY_FOR_NATIVE_BROWSER_200_PERCENT_ZOOM');
 let resumed=false;for(let i=0;i<600;i++){try{await access(new URL('zoom-resume',out));resumed=true;break;}catch{}await new Promise(r=>setTimeout(r,200));}assert(resumed,'Native zoom review did not resume before bounded timeout');
 after=await metrics();assert.equal(after.dpr/before.dpr,2,'Actual browser page zoom must double devicePixelRatio');assert(Math.abs(after.innerWidth*2-before.innerWidth)<=2,'Actual browser page zoom must halve CSS layout width');assert.equal(after.visualScale,1);assert.equal(after.cssZoom,before.cssZoom);
 assert.equal(await page.getByRole('spinbutton',{name:'Sample X',exact:true}).evaluate(el=>el===window.__reviewField&&el.parentNode===window.__reviewParent),true,'Focused control and parent remain stable');checks.push('Native browser page zoom 200%, separate from canvas zoom/CSS scaling, preserves native field and parent');
 assert.equal(await page.getByRole('spinbutton',{name:'Sample X',exact:true}).evaluate(el=>el===el.getRootNode().activeElement),true,'Native field focus remains on the same input after real page zoom');
 for(const dir of ['ltr','rtl']){await page.evaluate(d=>document.documentElement.dir=d,dir);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await button('Sample color').scrollIntoViewIfNeeded();await button('Sample color').focus();assert(await button('Sample color').evaluate(el=>el===el.getRootNode().activeElement));}
 await page.screenshot({path:new URL('real-200-percent-rtl.png',out).pathname});assert.deepEqual(errors,[]);assert.deepEqual(domErrors,[]);assert(Object.values(await server.effects()).every(x=>x===0));passed=true;
}catch(e){error={message:e.message,stack:e.stack};throw e;}finally{
 try{await guard.cleanup();guard.verify();}finally{await writeFile(new URL('result.json',out),JSON.stringify({start,end:new Date().toISOString(),passed,error,browser:browser.version(),before,after,checks,commands,errors,domErrors,scope:'Fresh stock Chromium controlled origin, native browser zoom via CUA; no physical IME/AT or performance claim'},null,2)+'\n');await writeFile(new URL('ownership.json',out),JSON.stringify(guard.ledger,null,2)+'\n');await context.close();await browser.close();await server.close();}
}
console.log(JSON.stringify({passed,before,after,checks}));
