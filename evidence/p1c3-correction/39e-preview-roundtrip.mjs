import {chromium} from 'playwright';
import {readFile,mkdir,writeFile,open} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {ownedOPFS} from '../../tests/editor/owned-opfs.ts';
import {recordDOMErrors} from '../../tests/editor/error-monitor.ts';
const root='/Users/westbrook/Documents/repos/ideogram-edit-p1c3-preview-7ba3a7cc',report='http://127.0.0.1:4381/';
const runtime=JSON.parse(await readFile(root+'/runtime.json')),review=JSON.parse(await readFile(new URL('39e-card.json',import.meta.url)));
const out=new URL('39e-preview-roundtrip/',import.meta.url);await mkdir(out);
const control=await open(root+'/control','w');await control.write('pair-file\n');await control.close();
const browser=await chromium.launch(),context=await browser.newContext({viewport:{width:1440,height:1000}}),guard=await ownedOPFS(context,'p1c3-correction-final-card-roundtrip-e');
const domErrors=await recordDOMErrors(context),page=await context.newPage(),requests=[],errors=[];
page.on('request',r=>{const u=new URL(r.url());requests.push({origin:u.origin,path:u.pathname,method:r.method()});});
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
const started=new Date().toISOString();let passed=false,displayedVersion='',primaryError=null,cleanupError=null;
try{
 await guard.admit(page,runtime.origin);await guard.admit(page,new URL(report).origin);
 const pairing=JSON.parse(await readFile(root+'/pairing.json'));await page.goto(pairing.url);
 await page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true}).waitFor();assert.equal(new URL(page.url()).hash,'');
 await page.getByRole('link',{name:'Progress Report ↗',exact:true}).click();await page.waitForURL(report);
 const card=page.locator('article.card').filter({has:page.getByRole('heading',{name:review.title,exact:true})});await card.waitFor();
 assert.equal(await page.getByRole('link',{name:'Open editor preview ↗',exact:true}).getAttribute('href'),runtime.reviewURL);
 const anchor=card.locator('a').first();assert.equal(await anchor.getAttribute('href'),runtime.reviewURL);displayedVersion=await card.locator('.version').innerText();assert.equal(displayedVersion,review.version+' · review revision '+review.contentRevision);assert.equal(await card.getByRole('button',{name:'Mark reviewed',exact:true}).isEnabled(),true);
 await card.screenshot({path:new URL('focused-card.png',out).pathname});await anchor.click();await page.waitForURL(runtime.reviewURL);
 await page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true}).waitFor();
 await page.screenshot({path:new URL('returned-preview.png',out).pathname,caret:'initial'});
 await page.getByRole('link',{name:'Progress Report ↗',exact:true}).click();await page.waitForURL(report);await card.waitFor();
 assert.equal(await card.locator('.version').innerText(),displayedVersion);assert.equal(errors.length,0);assert.deepEqual(domErrors,[]);
 assert(requests.every(r=>[runtime.origin,new URL(report).origin].includes(r.origin)));
 assert(requests.filter(r=>r.origin===new URL(report).origin).every(r=>r.method==='GET'));
 passed=true;
}catch(error){primaryError={name:error.name,message:error.message,stack:error.stack};throw error;}finally{
 try{if(!page.isClosed())await page.goto('about:blank');await guard.cleanup();guard.verify();}catch(error){cleanupError={name:error.name,message:error.message,stack:error.stack};throw error;}finally{
 await writeFile(new URL('roundtrip.json',out),JSON.stringify({started,ended:new Date().toISOString(),passed,browser:browser.version(),runtime,review,displayedVersion,paired:true,errors,domErrors,requests,primaryError,cleanupError,scope:'Author stock controlled-origin Chromium native clicks through exact rendered product card. Report requests GET only; no reviewed/approval/checkpoint action. No independent acceptance or OS/AT/resource qualification.'},null,2)+'\n');
 await writeFile(new URL('ownership.json',out),JSON.stringify(guard.ledger,null,2)+'\n');await context.close();await browser.close();
 }
}
console.log(JSON.stringify({passed,title:review.title,displayedVersion,origin:runtime.origin}));
