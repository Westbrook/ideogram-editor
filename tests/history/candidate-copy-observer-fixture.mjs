// The only substitute in candidate-copy-closure.test.mjs is the loopback provider.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import sharp from 'sharp';
import {emulator,fixtureProfile,SENTINEL_KEY,SENTINEL_COOKIE} from '../provider/emulator.mjs';
import {QueueDispatcher} from '../../dist/local/server/provider/dispatcher.js';
import {ResultObserver} from '../../dist/local/server/provider/observer.js';

export const RETURNED_PROMPT='Returned exact Café 東京 🦋\nhttps://authored.invalid/?token=literal\n'.repeat(1200);
export const returnedPrompt=prompt=>RETURNED_PROMPT+'\nExact submitted prompt:\n'+prompt;
export async function setup(store){
  const endpoint='ideogram/v4/inpaint',profile=fixtureProfile({id:'candidate-copy-inpaint',endpoint});
  const effects=[],errors=[],requests=new Map(),uploads=new Map(),sockets=new Set();
  const png=await sharp({create:{width:512,height:512,channels:4,background:'#2468ac'}}).png().toBuffer();
  let origin='',pending,closing=false;
  const write=closed=>{const path=join(store.root,'candidate-copy-effects.json');writeFileSync(path+'.tmp',JSON.stringify({effects,errors,closed}),{mode:0o600});renameSync(path+'.tmp',path);};
  const server=createServer(async(req,res)=>{
    try{
      const bytes=Buffer.concat(await Array.fromAsync(req)),path=new URL(req.url,origin).pathname;
      effects.push({method:req.method,path,bytes:bytes.length});
      res.setHeader('Content-Type','application/json');res.setHeader('Set-Cookie',SENTINEL_COOKIE);
      if(req.method==='POST'&&path==='/upload'){
        const id=String(uploads.size+1);uploads.set(id,bytes);res.end(JSON.stringify({url:origin+'/uploaded/'+id}));
      }else if(req.method==='POST'&&path==='/'+endpoint){
        const value=JSON.parse(bytes),id='result_'+(requests.size+1),base=origin+'/'+endpoint+'/requests/'+id;
        for(const key of ['image_url','mask_url'])assert(uploads.has(new URL(value[key]).pathname.split('/').at(-1)));
        requests.set(id,value);res.end(JSON.stringify({request_id:id,status_url:base+'/status',response_url:base,cancel_url:base+'/cancel'}));
      }else if(req.method==='GET'&&path.startsWith('/image/')){
        assert(requests.has(path.slice('/image/'.length)));res.setHeader('Content-Type','image/png');res.end(png);
      }else{
        assert.equal(req.method,'GET');const match=/^\/ideogram\/v4\/inpaint\/requests\/([^/]+)(\/status)?$/.exec(path);assert(match);assert(requests.has(match[1]));
        res.end(JSON.stringify(match[2]?{request_id:match[1],status:'COMPLETED'}:{images:[{url:origin+'/image/'+match[1]+'?token=fixture-transfer-secret',content_type:'image/png',file_size:png.length,width:512,height:512}],prompt:returnedPrompt(requests.get(match[1]).prompt),seed:31,timings:{inference:0.4},has_nsfw_concepts:[false]}));
      }
      write(false);
    }catch(error){errors.push(String(error));res.statusCode=500;res.end('{}');write(false);}
  });
  server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  server.listen(0,'127.0.0.1');await once(server,'listening');origin='http://127.0.0.1:'+server.address().port;
  const provider=emulator({queueOrigin:origin,mediaOrigin:origin,uploadOrigin:origin,profiles:[profile]});
  const dispatcher=new QueueDispatcher(store.queue,provider,{queueOrigin:origin,mediaOrigin:origin,uploadURL:origin+'/upload',profileId:profile.id});
  const observer=new ResultObserver(store.candidates,provider,dispatcher,profile.id,[SENTINEL_KEY,SENTINEL_COOKIE]);
  const timer=setInterval(()=>{
    if(closing||pending)return;
    pending=(async()=>{for(const job of store.queue.view().jobs)if(job.review.endpoint===endpoint&&job.attempts.at(-1).state==='not-started')await dispatcher.submit(job.id);await observer.tick();})()
      .catch(error=>{errors.push(String(error));closing=true;clearInterval(timer);write(false);}).finally(()=>{pending=undefined;});
  },100);
  write(false);
  return async()=>{
    closing=true;clearInterval(timer);observer.close();await pending;
    const ended=new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));for(const socket of sockets)socket.destroy();await ended;
    write(true);assert.deepEqual(errors,[]);assert.equal(store.objects.reservationInventory().activeTransfers,0);assert.equal(store.rasters.diagnostics().activeWorkers,0);
  };
}
