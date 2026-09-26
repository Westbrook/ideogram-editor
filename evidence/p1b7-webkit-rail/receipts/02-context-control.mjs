import {webkit} from '/Users/westbrook/Documents/repos/ideogram-edit/node_modules/playwright/index.mjs';
import {createServer} from 'node:http';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
const server=createServer((_,res)=>res.end('<!doctype html><title>Storage capability control</title>'));await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url='http://127.0.0.1:'+server.address().port, results=[];
async function exercise(context,kind){const page=await context.newPage();await page.goto(url);results.push({kind,...await page.evaluate(async()=>{let stage='getDirectory';try{const root=await navigator.storage.getDirectory();stage='getFileHandle';const handle=await root.getFileHandle('control',{create:true});stage='createWritable';const stream=await handle.createWritable();stage='write';await stream.write(new Uint8Array([0,1,2,255]));stage='close';await stream.close();stage='read';const bytes=[...new Uint8Array(await (await handle.getFile()).arrayBuffer())];return{ok:true,bytes};}catch(e){return{ok:false,stage,name:e.name,message:e.message};}})});}
try{const browser=await webkit.launch();try{const context=await browser.newContext();await exercise(context,'ephemeral');await context.close();}finally{await browser.close();}
const profile=await mkdtemp(tmpdir()+'/ie-webkit-profile-'),context=await webkit.launchPersistentContext(profile);try{await exercise(context,'fresh persistent');}finally{await context.close();}
await writeFile(new URL('./02-context-control.json',import.meta.url),JSON.stringify(results,null,2));console.log(JSON.stringify(results));}finally{server.close();}
