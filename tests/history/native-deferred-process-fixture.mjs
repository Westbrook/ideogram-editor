// Test-only backend entry. The driver owns the renderer; this process owns the
// unchanged HTTP/writer/raster/text backend and inherits the loopback preload.
import {openSync,fstatSync,readFileSync,closeSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {startLocalServer} from '../../dist/local/server/http.js';
import {observeNativeRequestMain} from './native-request-memory-observation.mjs';

const root=process.argv[2];
function readControl(name,limit){
 const fd=openSync(join(root,name),'r');
 try{
  const stat=fstatSync(fd);if(!stat.isFile()||stat.size<1||stat.size>limit)throw Error('NATIVE_FIXTURE_CONTROL_BOUND');
  return JSON.parse(readFileSync(fd,'utf8'));
 }finally{closeSync(fd);}
}
const config=readControl('native-fixture-config.json',128);
if(!config||Array.isArray(config)||Object.keys(config).sort().join(',')!=='bounds,clock,encoded,version'||config.version!==1||['encoded','bounds','clock'].some(key=>typeof config[key]!=='boolean'))throw Error('NATIVE_FIXTURE_CONFIG');
function now(){
 const value=readControl('native-fixture-clock.json',64);
 if(!value||Array.isArray(value)||Object.keys(value).join(',')!=='now'||!Number.isSafeInteger(value.now)||value.now<0)throw Error('NATIVE_FIXTURE_CLOCK');
 return value.now;
}
function boundsSetupModule(encoded){
 // Observe completion after the existing setup's real prepare/finally path.
 // No authority, admission, proof, worker, return value or error is replaced.
 const setupURL=new URL(encoded?'./encoded-rebuild-guard-fixture.mjs':'./text-treatment-diagnostic-fixture.mjs',import.meta.url).href;
 const source=`
  import {setup as baseSetup} from ${JSON.stringify(setupURL)};
  import {writeFileSync,renameSync} from 'node:fs';
  import {join} from 'node:path';
  export async function setup(store){
   const close=await baseSetup(store),prepare=store.histories.prepare;
   store.histories.prepare=async function(id,...args){
    try{return await prepare.call(this,id,...args);}finally{
     const row=store.db.prepare('SELECT receipt FROM commands WHERE id=?').get(id);
     if(row){
      const read=store.rasters.readDiagnostics();
      try{const path=join(store.root,'native-bounds-'+id+'.json');writeFileSync(path+'.tmp',JSON.stringify({commandId:id,receipt:JSON.parse(row.receipt),proofs:store.objects.proofInventory(),leases:store.histories.encodedReviewProofInventory(),composition:store.rasters.compositionMemory.resourceOwnership(),ioSlots:store.objects.leaseIdentity().slots,stages:store.objects.resourceOwnership().stages,raster:read.value}),{mode:0o600});renameSync(path+'.tmp',path);}finally{read.release();}
     }
    }
   };
   return Object.assign(async()=>{store.histories.prepare=prepare;await close();},{afterStoreDrain:()=>close.afterStoreDrain()});
  }
 `;
 return 'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
}

function observeFailureRequestMemory(memory){
 // The driver writes context first, then the existing unchanged failure-only
 // trigger. This observer creates no output during successful normal actions.
 let last='';
 const timer=setInterval(()=>{
  let uuid;
  try{
   const trigger=readControl('j19-diagnostic-request.json',128);
   if(!trigger||Array.isArray(trigger)||Object.keys(trigger).join(',')!=='commandId'||typeof trigger.commandId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(trigger.commandId)||trigger.commandId===last)return;
   uuid=trigger.commandId;last=uuid;
   const context=readControl('native-request-memory-context-'+uuid+'.json',1024);
   if(!context||Array.isArray(context)||Object.keys(context).sort().join(',')!=='documentId,jobId,queueCommandId'||Object.values(context).some(value=>typeof value!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(value)))return;
   const bytes=Buffer.from(JSON.stringify(memory.snapshotForFailure(uuid,context)));if(bytes.length>6144)return;
   const path=join(root,'native-request-memory-main-'+uuid+'.json');writeFileSync(path+'.tmp',bytes,{mode:0o600,flag:'wx'});renameSync(path+'.tmp',path);
  }catch{/* Missing/invalid observation evidence never changes the fixture. */}
 },25);
 return ()=>clearInterval(timer);
}

// Install before startLocalServer creates the actual writer, only for this
// existing native bounds fixture. The encoded and ordinary fixtures are unchanged.
const requestMemory=config.bounds&&!config.encoded?observeNativeRequestMain():undefined;
let server,stopRequestMemory=()=>{};
try{
 server=await startLocalServer({root,...(config.clock?{now}:{})},{writer:{setupModule:config.bounds?boundsSetupModule(config.encoded):new URL(config.encoded?'./encoded-rebuild-guard-fixture.mjs':'./text-treatment-diagnostic-fixture.mjs',import.meta.url).href}});
 if(requestMemory)stopRequestMemory=observeFailureRequestMemory(requestMemory);
}catch(error){stopRequestMemory();requestMemory?.close();throw error;}
let closing,lastPairing=0;
function close(){
 return closing??=(async()=>{
  stopRequestMemory();
  try{
   await server.close();
   if(process.connected)process.send({type:'closed'},()=>process.disconnect());
  }catch(error){
   process.exitCode=1;
   if(process.connected)process.send({type:'failure',message:String(error).slice(0,4096)},()=>process.disconnect());
   else console.error(error);
  }finally{requestMemory?.close();}
 })();
}
process.on('message',message=>{
 if(message==='close')void close();
 else if(!closing&&message&&Object.keys(message).sort().join(',')==='serial,type'&&message.type==='pair'&&Number.isSafeInteger(message.serial)&&message.serial===lastPairing+1){
  lastPairing=message.serial;
  process.send({type:'paired',serial:lastPairing,pairingURL:server.issuePairingURL()});
 }else throw Error('Unexpected native-deferred child control message');
});
process.once('disconnect',()=>{void close();});
process.send({type:'ready',origin:server.origin,pairingURL:server.issuePairingURL()});
