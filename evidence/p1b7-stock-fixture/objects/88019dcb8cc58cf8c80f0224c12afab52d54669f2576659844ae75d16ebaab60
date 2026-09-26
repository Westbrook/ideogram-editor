import {test,expect} from '@playwright/test';
import {writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {recordDOMErrors} from './error-monitor.js';
import {expectedShutdownConsole,expectedShutdownPageError} from './shutdown-console.js';

test('real console errors, throws and rejected promises survive the network exception across navigation and teardown',async({page,context,browserName})=>{
 const server=createServer((_,response)=>response.end('<!doctype html><title>Error oracle negative control</title>'));
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+(server.address() as {port:number}).port,retiredOrigins=new Set([origin]),dom=await recordDOMErrors(context),pageErrors:{expected:boolean;message:string}[]=[],consoleErrors:boolean[]=[];
 page.on('console',m=>{if(m.type()==='error')consoleErrors.push(expectedShutdownConsole({browser:browserName,text:m.text(),url:m.location().url,disrupting:true,retiredOrigins}));});
 page.on('pageerror',e=>pageErrors.push({message:e.message,expected:expectedShutdownPageError({browser:browserName,name:e.name,message:e.message,stack:e.stack??'',disrupting:true,retiredOrigins})}));
 try{
 await page.goto(origin);await page.evaluate(()=>console.error('Application console failure'));expect(consoleErrors).toContain(false);
 await page.evaluate(()=>{setTimeout(()=>{throw Error('Ordinary application throw');},0);});await expect.poll(()=>dom.length).toBe(1);
 await page.goto(origin+'/second');await page.evaluate(()=>{void Promise.reject(Error('Ordinary rejected promise'));});await expect.poll(()=>dom.length).toBe(2);
 // A mimic-shaped app error must remain visible to the independent DOM channel,
 // even if a browser happens to forward it without a JavaScript stack.
 await page.evaluate(origin=>{setTimeout(()=>{const error=Error(origin.slice('http:/'.length)+'/api/v1/events/stream?after=17 due to access control checks.');error.name='Fetch API cannot load http';error.stack='';throw error;},0);},origin);await expect.poll(()=>dom.length).toBe(3);
 await context.close();expect(dom).toHaveLength(3);expect(pageErrors.filter(e=>!e.expected).length).toBeGreaterThanOrEqual(2);expect(consoleErrors).toContain(false);
 const receipt=process.env.EDITOR_RECEIPT??'artifacts/p1b7/current';await mkdir(receipt,{recursive:true});await writeFile(join(receipt,'error-oracle-negatives.json'),JSON.stringify({browserName,dom,pageErrors,consoleErrors},null,2));
 }finally{await context.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
