// Explicit isolated-service review probe; never used by ordinary test collection.
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const origin=process.env.EDITOR_REVIEW_ORIGIN;
const output=process.env.EDITOR_REVIEW_RECEIPT;
assert(origin && /^http:\/\/127\.0\.0\.1:\d+$/.test(origin)); assert(output);
await mkdir(output,{recursive:true});
const browser=await chromium.launch();
const context=await browser.newContext({viewport:{width:1440,height:1000}});
context.setDefaultTimeout(10000);
const page=await context.newPage();
const report='http://127.0.0.1:4381/';
const requests=[];
context.on('request',request=>requests.push({origin:new URL(request.url()).origin,method:request.method()}));
const result={started:new Date().toISOString(),browser:browser.version(),origin,report,roundTrip:false,paired:false};
try {
 await page.goto(origin+'/?progress-report');
 assert.equal(await page.getByRole('link',{name:'Progress Report ↗',exact:true}).getAttribute('href'),report);
 const returnLink=page.getByRole('link',{name:'Progress Report ↗',exact:true});
 let reportPage;
 if(await returnLink.getAttribute('target')==='_blank'){const popup=context.waitForEvent('page');await returnLink.click();reportPage=await popup;await reportPage.waitForLoadState();}else{await returnLink.click();reportPage=page;await reportPage.waitForURL(report);}
 assert.equal(reportPage.url(),report);
 const target=reportPage.locator(`a[href="${origin}/?progress-report"]`).first();
 await target.waitFor({state:'visible',timeout:10000});
 const targetAttr=await target.getAttribute('target');
 let back;
 if(targetAttr==='_blank'){const next=context.waitForEvent('page');await target.click();back=await next;await back.waitForLoadState();}else{await target.click();back=reportPage;await back.waitForURL(origin+'/?progress-report');}
 assert.equal(new URL(back.url()).origin,origin);assert.equal(new URL(back.url()).search,'?progress-report');
 await back.getByRole('link',{name:'Progress Report ↗',exact:true}).waitFor();result.roundTrip=true;
 await back.screenshot({path:output+'/return-preview.png'});
 // Optional credential is only read into the local browser. Never log or trace it.
 if(process.env.EDITOR_REVIEW_PAIR_FILE){const pair=JSON.parse(await readFile(process.env.EDITOR_REVIEW_PAIR_FILE,'utf8'));assert.equal(new URL(pair.url).origin,origin);await back.goto(pair.url);await back.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true}).waitFor({timeout:10000});assert.equal(new URL(back.url()).hash,'');result.paired=true;await back.screenshot({path:output+'/paired-preview.png'});}
 result.requests=requests;assert(requests.every(r=>[origin,new URL(report).origin,'null'].includes(r.origin)));result.ended=new Date().toISOString();
} catch(error) { result.error=String(error.message).replace(/#.*?(?=\s|$)/g,'#REDACTED'); throw error; }
finally{await writeFile(output+'/roundtrip.json',JSON.stringify(result,null,2)+'\n');await browser.close();}
