import {chromium} from './source/node_modules/playwright/index.mjs';
import {readFile,mkdir,writeFile,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {ownedOPFS} from './source/tests/editor/owned-opfs.ts';
import {recordDOMErrors} from './source/tests/editor/error-monitor.ts';
const service='/Users/westbrook/Documents/repos/ideogram-edit-p1c3-preview-1888c6a0',report='http://127.0.0.1:4381/',out=new URL('./author-preview-v1/',import.meta.url);await mkdir(out);
const source=JSON.parse(await readFile(service+'/source.json')),runtime=JSON.parse(await readFile(service+'/runtime.json'));
const hash=b=>createHash('sha256').update(b).digest('hex');const checks={};
for(const group of ['build','extraRuntimeFiles']){for(const [p,h] of Object.entries(source[group]))assert.equal(hash(await readFile(service+'/'+p)),h,p);checks[group]=Object.keys(source[group]).length;}
for(const [p,h] of Object.entries(source.runtimeSource))assert.equal(hash(await readFile(new URL('./source/'+p,import.meta.url))),h,p);
assert.equal(hash(JSON.stringify(Object.fromEntries(Object.entries(source.runtimeSource).sort(([a],[b])=>a<b?-1:a>b?1:0)))),source.runtimeSourceSHA256);
checks.runtimeSource=Object.keys(source.runtimeSource).length;
const frozen=JSON.parse(await readFile(new URL('./card.json',import.meta.url)));const state=await(await fetch(report+'api/state')).json();const card=state.cards.find(c=>c.itemId===frozen.itemId&&c.current);
const identity=Object.fromEntries(['itemId','title','version','contentRevision','reviewed'].map(k=>[k,card[k]]));identity.reportRevision=state.revision;assert.equal(identity.version,frozen.version);assert.equal(identity.contentRevision,frozen.contentRevision);assert.equal(identity.title,frozen.title);assert.equal(identity.reviewed,false);
await writeFile(new URL('card-before.json',out),JSON.stringify(identity,null,2)+'\n');
const priorPair=await readFile(service+'/pairing.json','utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e;});const control=await open(service+'/control','w');await control.write('pair-file\n');await control.close();let pair;
for(let i=0;i<100;i++){const raw=await readFile(service+'/pairing.json','utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e;});if(raw!==priorPair){pair=JSON.parse(raw);break;}await new Promise(r=>setTimeout(r,20));}assert(pair,'New private pairing was not issued');
const {loadStatic}=await import(service+'/dist/local/server/static.js'),expected=await loadStatic(service+'/dist/app');
const browser=await chromium.launch(),context=await browser.newContext({viewport:{width:1440,height:1000}}),guard=await ownedOPFS(context,'author-p1c3-authority-preview'),domErrors=await recordDOMErrors(context),page=await context.newPage();const requests=[],served=[],pending=[],errors=[],responseErrors=[];let passed=false,error=null,cleanupError=null;
page.on('request',r=>{const u=new URL(r.url());requests.push({origin:u.origin,path:u.pathname,method:r.method()});});page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
page.on('response',r=>{const u=new URL(r.url());if(u.origin===runtime.origin&&expected.has(u.pathname))pending.push(r.body().then(b=>{assert.equal(hash(b),hash(expected.get(u.pathname).bytes),u.pathname);served.push({path:u.pathname,sha256:hash(b),bytes:b.length,status:r.status()});}).catch(e=>responseErrors.push({path:u.pathname,message:e.message})));});
const start=new Date().toISOString();
try{
 await guard.admit(page,runtime.origin);await guard.admit(page,new URL(report).origin);await page.goto(pair.url);await page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true}).waitFor();assert.equal(new URL(page.url()).hash,'');
 await page.getByRole('button',{name:'New',exact:true}).click();await page.getByRole('dialog',{name:'New document',exact:true}).waitFor();await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await page.getByRole('link',{name:'Progress Report ↗',exact:true}).click();await page.waitForURL(report);const rendered=page.locator('article.card').filter({has:page.getByRole('heading',{name:identity.title,exact:true})});await rendered.waitFor();assert.equal(await page.getByRole('link',{name:'Open editor preview ↗',exact:true}).getAttribute('href'),runtime.reviewURL);
 identity.displayedVersion=await rendered.locator('.version').innerText();assert.equal(identity.displayedVersion,identity.version+' · review revision '+identity.contentRevision);assert.equal(await rendered.getByRole('button',{name:'Mark reviewed',exact:true}).isEnabled(),true);assert.equal(await rendered.locator('a').first().getAttribute('href'),runtime.reviewURL);await rendered.screenshot({path:new URL('current-card.png',out).pathname});await rendered.locator('a').first().click();await page.waitForURL(runtime.reviewURL);await page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true}).waitFor();await page.screenshot({path:new URL('returned-preview.png',out).pathname});
 await page.goto(runtime.origin);await page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true}).waitFor();assert.equal(await page.getByRole('link',{name:'Progress Report ↗',exact:true}).count(),0);await page.goto(runtime.reviewURL);await page.getByRole('link',{name:'Progress Report ↗',exact:true}).click();await page.waitForURL(report);await rendered.waitFor();
 await Promise.all(pending);assert.deepEqual(responseErrors,[]);assert(served.length>=4);assert.deepEqual(errors,[]);assert.deepEqual(domErrors,[]);assert(requests.every(r=>[runtime.origin,new URL(report).origin].includes(r.origin)));assert(requests.filter(r=>r.origin===new URL(report).origin).every(r=>r.method==='GET'));
 const after=await(await fetch(report+'api/state')).json(),current=after.cards.find(c=>c.itemId===identity.itemId&&c.current);assert.equal(current.version,identity.version);assert.equal(current.contentRevision,identity.contentRevision);assert.equal(current.reviewed,identity.reviewed);identity.endReportRevision=after.revision;passed=true;
}catch(e){error={message:e.message,stack:e.stack};throw e;}finally{
 try{if(!page.isClosed())await page.goto('about:blank');await guard.cleanup();guard.verify();}catch(e){cleanupError={message:e.message,stack:e.stack};throw e;}finally{await writeFile(new URL('result.json',out),JSON.stringify({start,end:new Date().toISOString(),passed,error,cleanupError,responseErrors,browser:browser.version(),checks,runtime,identity,served,errors,domErrors,requests,scope:'AUTHOR stock Chromium native-click exact frozen current-card navigation; report GET only. No human review or later-version transfer.'},null,2)+'\n');await writeFile(new URL('ownership.json',out),JSON.stringify(guard.ledger,null,2)+'\n');await context.close();await browser.close();}
}
console.log(JSON.stringify({passed,checks,identity,servedResponses:served.length}));
