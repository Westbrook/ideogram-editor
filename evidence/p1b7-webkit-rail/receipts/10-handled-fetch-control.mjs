import {webkit} from '/Users/westbrook/Documents/repos/ideogram-edit/node_modules/playwright/index.mjs';
import {createServer} from 'node:http';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
const server=createServer((_,res)=>res.end('<!doctype html><title>Handled fetch control</title>'));await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
const context=await webkit.launchPersistentContext(await mkdtemp(tmpdir()+'/ie-handled-fetch-')),page=await context.newPage(),events=[];
page.on('pageerror',e=>events.push({channel:'pageerror',name:e.name,message:e.message,stack:e.stack}));page.on('console',m=>{if(m.type()==='error')events.push({channel:'console',message:m.text(),location:m.location()});});
try{await page.goto(origin);await page.evaluate(()=>{window.domErrors=[];window.addEventListener('error',e=>window.domErrors.push({kind:'error',message:e.message}));window.addEventListener('unhandledrejection',e=>window.domErrors.push({kind:'unhandledrejection',message:String(e.reason)}));});
server.closeAllConnections();await new Promise(r=>server.close(r));
const result=await page.evaluate(async()=>{try{await fetch('/api/v1/events/stream?after=17');return{unexpected:'resolved'};}catch(error){return{caught:true,name:error.name,message:error.message};}});
const domErrors=await page.evaluate(()=>window.domErrors);const output={origin,result,domErrors,events};await writeFile(new URL('./10-handled-fetch-control.json',import.meta.url),JSON.stringify(output,null,2));console.log(JSON.stringify(output));}finally{await context.close();server.close();}
