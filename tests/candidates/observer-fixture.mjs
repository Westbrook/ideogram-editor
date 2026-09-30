// Test-only loopback policy and scheduler. No application entry point imports this module.
import {createServer} from 'node:http';import {once} from 'node:events';import {writeFileSync}from'node:fs';import{join}from'node:path';import assert from'node:assert/strict';import sharp from'sharp';
import{emulator,fixtureProfile,SENTINEL_KEY,SENTINEL_COOKIE}from'../provider/emulator.mjs';import{QueueDispatcher}from'../../dist/local/server/provider/dispatcher.js';import{ResultObserver}from'../../dist/local/server/provider/observer.js';
export async function setup(store,{profileEndpointOverrides={}}={}){
 const effects=[],requests=new Map(),errors=[],diagnostics=[],failures=[];let origin='',pending,closing=false,context=null,profiles=[];
 const mark=(phase,jobId,attemptId,endpoint,profileId)=>{context={phase,jobId,attemptId,endpoint,profileId};diagnostics.push({...context});if(diagnostics.length>256)diagnostics.shift();};
 const failure=(e,where=context)=>{errors.push(String(e));failures.push({...where,error:{name:e.name,message:e.message,stack:e.stack}});};
 const png=await sharp({create:{width:512,height:512,channels:4,background:'#2468ac'}}).png().toBuffer();
 const write=extra=>writeFileSync(join(store.root,'candidate-fixture.json'),JSON.stringify({effects,errors,profiles:profiles.map(({id,endpoint,version})=>({id,endpoint,version})),diagnostics,failures,...extra},null,2),{mode:0o600});
 const server=createServer(async(req,res)=>{try{const parts=[];for await(const b of req)parts.push(b);const body=Buffer.concat(parts);effects.push({method:req.method,path:req.url,bytes:body.length});res.setHeader('Content-Type','application/json');res.setHeader('Set-Cookie',SENTINEL_COOKIE);if(req.method==='POST'){
  assert(['/ideogram/v4','/ideogram/v4/fast','/ideogram/v4/instant'].includes(req.url));const id='fixture_'+(requests.size+1),value=JSON.parse(body.toString());requests.set(id,{endpoint:req.url,value});const base=origin+req.url+'/requests/'+id;res.end(JSON.stringify({request_id:id,status_url:base+'/status',response_url:base,cancel_url:base+'/cancel'}));
 }else if(req.url.startsWith('/image/')){res.setHeader('Content-Type','image/png');res.end(png);}else{const id=/\/requests\/([^/?]+)/.exec(req.url)?.[1],r=requests.get(id);assert(r);if(req.url.endsWith('/status'))res.end(JSON.stringify({request_id:id,status:'COMPLETED'}));else res.end(JSON.stringify({images:[{url:origin+'/image/'+id+'?token=fixture-transfer-secret',content_type:'image/png',file_size:png.length,width:512,height:512}],prompt:r.value.prompt,seed:31,timings:{inference:0.4},has_nsfw_concepts:[false]}));}write({closed:false});}catch(e){failure(e,{phase:'emulator',jobId:null,attemptId:null,endpoint:null,profileId:null});res.statusCode=500;res.end('{}');write({closed:false});}});
 server.listen(0,'127.0.0.1');await once(server,'listening');origin='http://127.0.0.1:'+server.address().port;
 const endpoints=['ideogram/v4','ideogram/v4/fast','ideogram/v4/instant'];
 profiles=endpoints.map((endpoint,index)=>fixtureProfile({id:'local-fixture-'+['base','fast','instant'][index]+'-v1',endpoint:profileEndpointOverrides[endpoint]??endpoint}));
 const provider=emulator({queueOrigin:origin,mediaOrigin:origin,profiles});
 const routes=endpoints.map((endpoint,index)=>{
  const profileId=profiles[index].id,dispatcher=new QueueDispatcher(store.queue,provider,{queueOrigin:origin,profileId});
  // Selection only: every mutation and ownership check still runs on the real store.
  const candidates=new Proxy(store.candidates,{get(target,key){
   if(key==='due')return now=>target.due(now).filter(f=>store.queue.recovery(f.jobId,f.attemptId).endpoint===endpoint);
   if(key==='retries')return ()=>target.retries().filter(c=>store.queue.recovery(c.jobId,c.attemptId).endpoint===endpoint);
   const value=target[key];if(typeof value!=='function')return value;
   if(key==='transfer')return (...args)=>{const f=args[0];mark('transfer',f.jobId,f.attemptId,endpoint,profileId);return value.apply(target,args);};
   return value.bind(target);
  }});
  const reads={readKnown(jobId,attemptId,kind){mark(kind,jobId,attemptId,endpoint,profileId);return dispatcher.readKnown(jobId,attemptId,kind);}};
  return {endpoint,profileId,dispatcher,observer:new ResultObserver(candidates,provider,reads,profileId,[SENTINEL_KEY,SENTINEL_COOKIE])};
 });
 const timer=setInterval(()=>{if(closing||pending)return;pending=(async()=>{
  for(const route of routes){
   for(const job of store.queue.view().jobs)if(job.review.endpoint===route.endpoint&&job.attempts.at(-1).state==='not-started'){mark('submit',job.id,job.attempts.at(-1).id,route.endpoint,route.profileId);await route.dispatcher.submit(job.id);}
   await route.observer.tick();
  }
 })().catch(e=>{failure(e);closing=true;clearInterval(timer);write({closed:false});}).finally(()=>{pending=undefined;});},100);
 write({closed:false});
 return async()=>{closing=true;clearInterval(timer);for(const route of routes)route.observer.close();await pending;await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));const resources={objects:store.objects.reservationInventory(),raster:store.rasters.diagnostics(),text:{reservedCPU:store.texts.reservedCPU,externalBytes:store.texts.externalBytes()}};write({closed:true,resources});assert.deepEqual(errors,[]);assert.equal(resources.objects.activeTransfers,0);assert.equal(resources.objects.reservedBytes,'0');assert.equal(resources.raster.activeWorkers,0);assert.equal(resources.raster.reservedCPU,0);};
}
