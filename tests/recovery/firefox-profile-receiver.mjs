// Fixed child. Raw FIFO bytes stay in this process and are never sent over IPC.
import {constants} from 'node:fs';
import {open,lstat,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {projectFirefoxProfile,isFirefoxProfileProjection} from './firefox-profile-projection.mjs';
const RAW_LIMIT=16777216,CHUNK=16384;
let keeper,reader,started=false,contextDone=false,resolveContext,cancelled=false,completed=false,rawBytes=0,eof=false,receiverFailure=null;
const context=new Promise(resolve=>resolveContext=resolve);
const identity=s=>({dev:String(s.dev),ino:String(s.ino),uid:String(s.uid),gid:String(s.gid),mode:Number(s.mode)&0o777});
const same=(a,b)=>a&&b&&Object.keys(a).every(k=>a[k]===b[k]);
const pause=()=>new Promise(resolve=>setTimeout(resolve,2));
async function closeFDs(){const a=reader,b=keeper;reader=keeper=undefined;await Promise.allSettled([a?.close(),b?.close()]);}
function settleContext(value){if(!contextDone){contextDone=true;resolveContext(value);}}
async function* chunks(){
 try{
 const buffer=Buffer.alloc(CHUNK);
 while(!cancelled){
  let read;
  try{read=await reader.read(buffer,0,rawBytes===RAW_LIMIT?1:Math.min(CHUNK,RAW_LIMIT-rawBytes),null);}catch(error){if(error.code==='EAGAIN'){await pause();continue;}receiverFailure??='PROFILE_READ_FAILED';throw Error('PROFILE_READ_FAILED');}
  if(read.bytesRead===0){eof=true;return;}
  if(keeper){const fd=keeper;keeper=undefined;await fd.close();}
  // A one-byte over-limit probe can only refuse; it is never yielded or kept.
  if(rawBytes+read.bytesRead>RAW_LIMIT){receiverFailure??='PROFILE_RAW_LIMIT';throw Error('PROFILE_RAW_LIMIT');}
  rawBytes+=read.bytesRead;
  // The projector consumes this view before requesting the next chunk. It must
  // not retain raw views; its numeric/string-token growth limits are separate.
  yield buffer.subarray(0,read.bytesRead);
 }
 receiverFailure??='PROFILE_CANCELLED';throw Error('PROFILE_CANCELLED');
 }catch{receiverFailure??='PROFILE_RECEIVER_FAILED';throw Error('PROFILE_RECEIVER_FAILED');}
}
async function run(message){
 let summary=null,failure=null;
 try{
  const {fifo,leaf,leafIdentity,fifoIdentity}=message;
  if(typeof leaf!=='string'||typeof fifo!=='string'||fifo!==join(leaf,'profile.fifo')||fifo.includes('%p')||await realpath(leaf)!==leaf)throw Error('PROFILE_PATH');
  const ds=await lstat(leaf,{bigint:true}),fs=await lstat(fifo,{bigint:true});
  if(!ds.isDirectory()||!fs.isFIFO()||!same(identity(ds),leafIdentity)||!same(identity(fs),fifoIdentity)||ds.uid!==BigInt(process.getuid())||fs.uid!==BigInt(process.getuid())||(Number(ds.mode)&0o777)!==0o700||(Number(fs.mode)&0o777)!==0o600)throw Error('PROFILE_PATH');
  keeper=await open(fifo,constants.O_RDWR|constants.O_NONBLOCK|constants.O_NOFOLLOW);
  reader=await open(fifo,constants.O_RDONLY|constants.O_NONBLOCK|constants.O_NOFOLLOW);
  if(!same(identity(await reader.stat({bigint:true})),fifoIdentity)||!same(identity(await keeper.stat({bigint:true})),fifoIdentity))throw Error('PROFILE_PATH');
  if(!globalThis.__storeNetworkCounters||Object.values(globalThis.__storeNetworkCounters.read()).some(value=>value!==0))throw Error('PROFILE_NETWORK_GUARD');
  process.send({type:'ready',noNetworkGuard:true});
  summary=await projectFirefoxProfile(chunks(),context);
  // Only explicit receiver branches supply receiver provenance. In particular,
  // the projector's INPUT_FAILURE after an iterator failure is not a schema refusal.
  if(!isFirefoxProfileProjection(summary)||Object.values(globalThis.__storeNetworkCounters.read()).some(value=>value!==0)){summary=null;failure='PROFILE_RECEIVER_FAILED';}
  else if(receiverFailure){summary=null;failure=receiverFailure;}
  else if(cancelled||(!eof&&summary.status!=='refused')){summary=null;failure='PROFILE_RECEIVER_FAILED';}
 }catch{summary=null;failure=receiverFailure??'PROFILE_RECEIVER_FAILED';}
 finally{await closeFDs();}
 // Only a fixed code or admitted bounded projection crosses the control channel.
 const result={type:'result',eof,rawBytes,summary,failure};
 if(Buffer.byteLength(JSON.stringify(result))>264192)process.exit(2);
 if(process.connected)process.send(result,()=>{completed=true;process.disconnect();process.exit(0);});else process.exit(2);
}
process.on('message',message=>{
 if(message?.type==='prepare'&&!started){started=true;void run(message);}
 else if(message?.type==='context')settleContext(message.value??null);
 else if(message?.type==='cancel'){receiverFailure??='PROFILE_CANCELLED';cancelled=true;settleContext(null);void closeFDs();}
});
process.on('disconnect',()=>{if(completed)return;cancelled=true;settleContext(null);void closeFDs().finally(()=>process.exit(2));});
process.on('uncaughtException',()=>process.exit(2));
process.on('unhandledRejection',()=>process.exit(2));
