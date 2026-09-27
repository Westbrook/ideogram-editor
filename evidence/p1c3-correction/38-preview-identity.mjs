import {chromium} from 'playwright';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {ownedOPFS} from '../../tests/editor/owned-opfs.ts';
import {recordDOMErrors} from '../../tests/editor/error-monitor.ts';
const root='/Users/westbrook/Documents/repos/ideogram-edit-p1c3-preview-7ba3a7cc';
const out=new URL('38-preview-identity/',import.meta.url);await mkdir(out);
const source=JSON.parse(await readFile(root+'/source.json')),runtime=JSON.parse(await readFile(root+'/runtime.json'));
const pairing=JSON.parse(await readFile(root+'/pairing.json'));
const {loadStatic}=await import(root+'/dist/local/server/static.js');const expected=await loadStatic(root+'/dist/app');
const browser=await chromium.launch(),context=await browser.newContext({viewport:{width:1440,height:1000}});
const guard=await ownedOPFS(context,'p1c3-correction-frozen-preview-identity'),domErrors=await recordDOMErrors(context),errors=[],rows=[],pending=[];
const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
page.on('response',response=>{const u=new URL(response.url());if(u.origin===runtime.origin&&expected.has(u.pathname))pending.push(response.body().then(b=>{
 const hash=createHash('sha256').update(b).digest('hex');assert.equal(hash,createHash('sha256').update(expected.get(u.pathname).bytes).digest('hex'),u.pathname);rows.push({path:u.pathname,sha256:hash,bytes:b.length,status:response.status()});
}));});
const started=new Date().toISOString();let passed=false;
try{
 await guard.admit(page,runtime.origin);await page.goto(pairing.url);
 await page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true}).waitFor();assert.equal(new URL(page.url()).hash,'');
 assert.equal(await page.getByRole('link',{name:'Progress Report ↗',exact:true}).getAttribute('href'),'http://127.0.0.1:4381/');
 await page.getByRole('button',{name:'New',exact:true}).click();await page.getByRole('dialog',{name:'New document',exact:true}).waitFor();await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await Promise.all(pending);assert(rows.length>=4);assert.equal(errors.length,0);assert.deepEqual(domErrors,[]);
 await page.screenshot({path:new URL('paired-preview.png',out).pathname,caret:'initial'});
 await page.goto(runtime.origin);await page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true}).waitFor();assert.equal(await page.getByRole('link',{name:'Progress Report ↗',exact:true}).count(),0);
 await Promise.all(pending);passed=true;
}finally{
 try{await guard.cleanup();guard.verify();}finally{
 await writeFile(new URL('identity.json',out),JSON.stringify({started,ended:new Date().toISOString(),passed,browser:browser.version(),runtime,sourceCommit:source.sourceCommit,served:rows,errors,domErrors,unflaggedReturnAbsent:passed,scope:'Stock controlled-origin Chromium served bytes and paired frozen shell; no independent approval, OS/AT/resource qualification.'},null,2)+'\n');
 await writeFile(new URL('ownership.json',out),JSON.stringify(guard.ledger,null,2)+'\n');await context.close();await browser.close();
 }
}
console.log(JSON.stringify({passed,served:rows.length,sourceCommit:source.sourceCommit,origin:runtime.origin}));
