// Test-only manual observer boundary: never scheduled by an application entry.
import {createServer} from 'node:http';
import {once} from 'node:events';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {emulator,fixtureProfile} from '../provider/emulator.mjs';
import {QueueDispatcher} from '../../dist/local/server/provider/dispatcher.js';
import {ResultObserver} from '../../dist/local/server/provider/observer.js';
export async function setup(store){
 const path=join(store.root,'initialization-fixture.json'),prior=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{effects:[],steps:0};
 const effects=prior.effects;let steps=prior.steps,origin,observer,dispatcher;
 const audit=()=>({effects,steps,epoch:store.epoch,queue:store.queue.view(),candidateJobs:store.db.prepare('SELECT count(*) n FROM candidate_jobs').get().n,candidateJournal:store.db.prepare('SELECT count(*) n FROM candidate_journal').get().n,queueJournal:store.db.prepare('SELECT count(*) n FROM queue_journal').get().n});
 const write=()=>writeFileSync(path,JSON.stringify({...audit(),origin}),{mode:0o600});
 const server=createServer(async(req,res)=>{try{
  res.setHeader('Content-Type','application/json');
  if(req.url==='/__audit'){assert.equal(req.method,'GET');res.end(JSON.stringify(audit()));return;}
  if(req.url==='/__step'){assert.equal(req.method,'POST');steps++;await observer.tick();write();res.end(JSON.stringify(audit()));return;}
  const body=Buffer.concat(await Array.fromAsync(req));effects.push({method:req.method,path:req.url,bytes:body.length});
  if(req.method==='POST'){const base=origin+req.url+'/requests/initialization_known';res.end(JSON.stringify({request_id:'initialization_known',status_url:base+'/status',response_url:base,cancel_url:base+'/cancel'}));}
  else if(req.url.endsWith('/status'))res.end(JSON.stringify({request_id:'initialization_known',status:'IN_PROGRESS'}));
  else if(req.url.endsWith('/cancel')){res.statusCode=202;res.end('{}');}
  else{res.statusCode=404;res.end('{}');}
  write();
 }catch(error){res.statusCode=500;res.end(JSON.stringify({error:error.message}));}});
 server.listen(prior.origin?Number(new URL(prior.origin).port):0,'127.0.0.1');await once(server,'listening');origin='http://127.0.0.1:'+server.address().port;
 const provider=emulator({queueOrigin:origin,mediaOrigin:origin,profiles:[fixtureProfile({endpoint:'ideogram/v4'})]});
 dispatcher=new QueueDispatcher(store.queue,provider,{queueOrigin:origin,profileId:'local-fixture-v1'});observer=new ResultObserver(store.candidates,provider,dispatcher,'local-fixture-v1');
 for(const job of store.queue.view().jobs)if(job.attempts.at(-1).state==='not-started'&&!store.queue.view().counts.active)await dispatcher.submit(job.id);
 write();return async()=>{observer.close();await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));write();};
}
