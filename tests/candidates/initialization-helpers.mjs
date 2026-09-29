import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture,prepare,enqueue,envelope} from '../queue/helpers.mjs';
import {startLocalServer} from '../../dist/local/server/http.js';
import {pair,call,cookieFrom,readHeaders,mutationHeaders} from '../session/helpers.mjs';
export async function initialized(t,{restart=true,recover=true,other=false}={}){
 const clean=[],closures=[],f=await fixture({name:t.name,after:cb=>clean.push(cb)});let server,paired;
 t.after(async()=>{for(const close of closures)await close();await server?.close();for(const cb of clean)await cb();});
 const p=await prepare(f.writer),q=await enqueue(f.writer,p.body);let q2;if(other){const next=await prepare(f.writer,()=>{},'2');q2=await enqueue(f.writer,next.body);}await f.close();
 const open=async()=>{server=await startLocalServer({root:f.root},{writer:{setupModule:new URL('./initialization-fixture.mjs',import.meta.url).href}});paired=await pair(server);assert.equal(paired.status,200);};
 await open();if(restart){await server.close();await open();}
 const read=path=>call(server.origin,path,{headers:readHeaders(cookieFrom(paired))});
 const command=async body=>{const c=envelope(body);c.command.clientId=paired.json.clientId;const r=await call(server.origin,'/api/v1/commands',{method:'POST',body:c,headers:mutationHeaders(server,paired)});assert.equal(r.json.receipt?.status,'accepted',JSON.stringify(r.json));return r;};
 const current=async()=>(await read('/api/v1/queue')).json.jobs.find(j=>j.id===q.job.id);
 if(recover){const j=await current();await command({type:'RecoverJob',jobId:j.id,attemptId:j.attempts[0].id,expectedVersion:j.version});}
 const info=JSON.parse(await readFile(join(f.root,'initialization-fixture.json'),'utf8'));
 return {f,q,q2,closures,read,command,current,close:()=>server.close(),async audit(){return (await call(info.origin,'/__audit')).json;},async step(){const r=await call(info.origin,'/__step',{method:'POST'});assert.equal(r.status,200,JSON.stringify(r.json));return r.json;},path:'/api/v1/jobs/'+q.job.id+'/candidates?attempt='+q.job.attempts[0].id};
}
export function pending(response,job){assert.equal(response.status,200,JSON.stringify(response.json));const v=response.json;assert.equal(v.jobId,job.id);assert.equal(v.documentId,job.documentId);assert.equal(v.observation,null);assert.equal(v.actualCount,null);assert.equal(v.provenance,null);assert.deepEqual(v.items,[]);assert.equal(v.inert,false);assert.equal(v.nextCursor,null);assert.equal(v.requestedCount,job.review.request.settings.count);assert.deepEqual(v.request.prompt,job.review.prompt);}
