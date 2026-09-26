import {webkit} from '/Users/westbrook/Documents/repos/ideogram-edit/node_modules/playwright/index.mjs';
import {createServer} from 'node:http';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
const server=createServer((_,res)=>res.end('<!doctype html><title>Handled fetch control</title>'));await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
const second=createServer((_,res)=>res.end('<!doctype html><title>Second local origin</title>'));await new Promise(r=>second.listen(0,'127.0.0.1',r));const secondOrigin='http://127.0.0.1:'+second.address().port;
const context=await webkit.launchPersistentContext(await mkdtemp(tmpdir()+'/ie-handled-fetch-')),page=await context.newPage(),events=[];
page.on('pageerror',e=>events.push({channel:'pageerror',name:e.name,message:e.message,stack:e.stack}));page.on('console',m=>{if(m.type()==='error')events.push({channel:'console',message:m.text(),location:m.location()});});
try{await page.goto(secondOrigin);await page.evaluate(()=>{window.domErrors=[];window.addEventListener('error',e=>window.domErrors.push({kind:'error',message:e.message}));window.addEventListener('unhandledrejection',e=>window.domErrors.push({kind:'unhandledrejection',message:String(e.reason)}));});
// Keep target alive without Access-Control-Allow-Origin; browser must reject this handled cross-origin fetch.
const result=await page.evaluate(async origin=>{try{await fetch(origin+'/api/v1/events/stream?after=17');return{unexpected:'resolved'};}catch(error){return{caught:true,name:error.name,message:error.message};}},origin);
const domErrors=await page.evaluate(()=>window.domErrors);const output={origin,result,domErrors,events};await writeFile(new URL('./13-handled-cors-control.json',import.meta.url),JSON.stringify(output,null,2));console.log(JSON.stringify(output));}finally{await context.close();server.close();second.close();}
