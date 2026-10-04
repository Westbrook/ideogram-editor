// Test-only transient IPC. No raw profile is persisted, logged or returned.
import {spawn} from 'node:child_process';
import {lstat,mkdtemp,chmod,realpath,readdir,rmdir,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isFirefoxProfileProjection} from './firefox-profile-projection.mjs';

const HERE=dirname(fileURLToPath(import.meta.url));
const WORKER=join(HERE,'firefox-profile-receiver.mjs');
// Preserve all three maintained preload variants and apply the strongest last.
// The fixed receiver performs no network effects; no arbitrary NODE_OPTIONS or
// parent loader/debugger arguments are inherited.
const GUARDS=['../session/no-egress.mjs','../provider/no-egress.mjs','../store/no-network.mjs'].map(path=>resolve(HERE,path));
export const FIREFOX_PROFILE_IPC_LIMITS=Object.freeze({setupMs:5000,closeWorkMs:14000,cancelMs:1000,lifetimeMs:130000,rawBytes:16777216,chunkBytes:16384,summaryBytes:262144});
const SETTINGS=Object.freeze({MOZ_PROFILER_STARTUP:'1',MOZ_PROFILER_STARTUP_NO_BASE:'1',MOZ_PROFILER_STARTUP_ENTRIES:'16777216',MOZ_PROFILER_STARTUP_INTERVAL:'4',MOZ_PROFILER_STARTUP_FEATURES:'js,stackwalk,nomarkerstacks',MOZ_PROFILER_STARTUP_FILTERS:'GeckoMain'});
const CONTEXT_KEYS=['p4WallMs','realmTimeOriginMs','f5WallMs','f5MonotonicMs','f6WallMs','f6MonotonicMs','queueReadEntryMonotonicMs','queueReadCallbackMonotonicMs'];
const RECEIVER_FAILURES=new Set(['PROFILE_READ_FAILED','PROFILE_RAW_LIMIT','PROFILE_CANCELLED','PROFILE_RECEIVER_FAILED']);
const RESULT_KEYS=['type','eof','rawBytes','summary','failure'];
const fail=code=>Object.assign(Error(code),{code});
const within=(root,path)=>{const r=relative(root,path);return r===''||(!r.startsWith('..'+ '/')&&r!=='..'&&!isAbsolute(r));};
const identity=s=>({dev:String(s.dev),ino:String(s.ino),uid:String(s.uid),gid:String(s.gid),mode:Number(s.mode)&0o777});
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.uid===b.uid&&a.gid===b.gid&&a.mode===b.mode;
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
async function bounded(promise,ms){if(ms<=0)return null;let timer;try{return await Promise.race([promise,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),Math.max(1,ms));})]);}finally{clearTimeout(timer);}}
async function canonicalFuture(path){
 if(typeof path!=='string'||!isAbsolute(path))throw fail('PROFILE_ROOT_INVALID');
 const parts=[];let at=resolve(path);
 for(;;){try{return resolve(await realpath(at),...parts);}catch(error){if(error.code!=='ENOENT')throw fail('PROFILE_ROOT_INVALID');const next=dirname(at);if(next===at)throw fail('PROFILE_ROOT_INVALID');parts.unshift(at.slice(next.length+Number(!next.endsWith('/'))));at=next;}}
}
async function exclusions(leaf,roots){
 if(!Array.isArray(roots)||roots.length>64)throw fail('PROFILE_ROOT_INVALID');
 for(const root of roots){const actual=await canonicalFuture(root);if(within(actual,leaf)||within(leaf,actual))throw fail('PROFILE_ARCHIVE_OVERLAP');}
}
function publicContext(value){
 if(value===null||value===undefined)return null;
 if(typeof value!=='object'||Object.keys(value).length!==CONTEXT_KEYS.length||CONTEXT_KEYS.some(k=>!Object.hasOwn(value,k)||!Number.isFinite(value[k])))return null;
 return Object.fromEntries(CONTEXT_KEYS.map(k=>[k,value[k]]));
}
function ownChild(executable,args,options){
 const closed=deferred();let ended=false,exit=null,spawnError=false;
 const child=spawn(executable,args,options);
 child.once('error',()=>{spawnError=true;});
 child.once('close',(code,signal)=>{ended=true;exit={code,signal,spawnError};closed.resolve(exit);});
 return {child,closed:closed.promise,get ended(){return ended;},get exit(){return exit;}};
}
async function stopChild(owned,budgetMs=900){
 if(!owned||owned.ended)return Boolean(owned?.ended);
 const until=performance.now()+Math.max(0,budgetMs);
 if(budgetMs<=0){owned.child.kill('SIGKILL');return owned.ended;}
 owned.child.kill('SIGTERM');
 if(await bounded(owned.closed,Math.min(400,budgetMs/2)))return true;
 owned.child.kill('SIGKILL');
 return Boolean(await bounded(owned.closed,until-performance.now()));
}

export async function prepareFirefoxProfileDiagnostic({excludedRoots}){
 if(!['linux','darwin'].includes(process.platform)||typeof process.getuid!=='function')throw fail('PROFILE_PLATFORM_UNAVAILABLE');
 const started=performance.now(),uid=String(process.getuid()),gid=String(process.getgid());
 const parent=await realpath(tmpdir());let leaf,fifo,leafIdentity,fifoIdentity,maker,receiver,watchdog;
 const state={schema:1,status:'unavailable',code:'PROFILE_PREPARING',summary:null,rawBytes:null,eofObserved:null,parserRefusal:null,receiverFailure:null,helperClosed:false,helperExitCode:null,helperSignal:null,browserClosed:false,ipcRemoved:false,writerMayOpen:true,regularFileObserved:false,qualification:false};
 let finishing,stopping,finished=false,received=null,ready=false,tainted=false;
 const readySignal=deferred(),issuedEnvironments=new WeakSet();
 const snapshot=()=>{if(Buffer.byteLength(JSON.stringify(state))>FIREFOX_PROFILE_IPC_LIMITS.summaryBytes){state.status='unavailable';state.code='PROFILE_OUTPUT_LIMIT';state.summary=null;}return structuredClone(state);};
 async function validateOwned(){
  if(await realpath(leaf)!==leaf)throw fail('PROFILE_PATH_CHANGED');
  const d=await lstat(leaf,{bigint:true}),f=await lstat(fifo,{bigint:true});
  if(!d.isDirectory()||!same(identity(d),leafIdentity)||!f.isFIFO()||!same(identity(f),fifoIdentity)){
   state.regularFileObserved=f.isFile();throw fail('PROFILE_PATH_CHANGED');
  }
  if((await readdir(leaf)).join('\n')!=='profile.fifo')throw fail('PROFILE_PATH_CHANGED');
 }
 async function removeClosedIPC(){
  if(!state.helperClosed||!state.browserClosed)return;
  await validateOwned();await unlink(fifo);await rmdir(leaf);state.ipcRemoved=true;state.writerMayOpen=false;
 }
 async function stop(code,budgetMs=900){
  if(finished)return snapshot();
  if(!tainted)state.code=code;tainted=true;state.status='unavailable';state.summary=null;state.eofObserved=null;state.parserRefusal=null;state.receiverFailure=null;
  const budget=Math.max(0,Math.min(900,Number.isFinite(budgetMs)?budgetMs:0));
  if(budget===0&&!receiver?.ended)receiver?.child.kill('SIGKILL');
  if(!stopping)stopping=(async()=>{if(receiver?.child.connected)receiver.child.send({type:'cancel'},()=>{});await stopChild(receiver,budget);state.helperClosed=Boolean(receiver?.ended);if(receiver?.exit){state.helperExitCode=receiver.exit.code;state.helperSignal=receiver.exit.signal;}})();
  await bounded(stopping,budget);
  if(!state.helperClosed)state.code='PROFILE_HELPER_CLOSURE_UNKNOWN';
  return snapshot();
 }
 try{
  leaf=await mkdtemp(join(parent,'p25-e4-profiler-'));await chmod(leaf,0o700);leaf=await realpath(leaf);fifo=join(leaf,'profile.fifo');
  await exclusions(leaf,excludedRoots);const d=await lstat(leaf,{bigint:true});leafIdentity=identity(d);
  if(!d.isDirectory()||leafIdentity.uid!==uid||leafIdentity.gid!==gid||leafIdentity.mode!==0o700||fifo.includes('%p'))throw fail('PROFILE_PATH_INVALID');
  maker=ownChild('/usr/bin/mkfifo',['-m','600',fifo],{stdio:'ignore',env:{PATH:'/usr/bin:/bin',LANG:'C'}});
  const made=await bounded(maker.closed,Math.max(1,FIREFOX_PROFILE_IPC_LIMITS.setupMs-(performance.now()-started)-1000));
  if(!made||made.code!==0||made.spawnError)throw fail('PROFILE_FIFO_CREATE_FAILED');
  const f=await lstat(fifo,{bigint:true});fifoIdentity=identity(f);
  if(!f.isFIFO()||fifoIdentity.uid!==uid||fifoIdentity.gid!==gid||fifoIdentity.mode!==0o600)throw fail('PROFILE_PATH_INVALID');
  receiver=ownChild(process.execPath,[...GUARDS.flatMap(path=>['--import',path]),WORKER],{stdio:['ignore','ignore','ignore','ipc'],env:{PATH:'/usr/bin:/bin',LANG:'C',TZ:'UTC'}});
  void receiver.closed.then(exit=>{state.helperClosed=true;state.helperExitCode=exit.code;state.helperSignal=exit.signal;if(!finishing&&!tainted){tainted=true;state.code='PROFILE_EARLY_HELPER_CLOSE';}});
  receiver.child.on('message',message=>{
   if(!message||typeof message!=='object')return;
   if(message.type==='ready'&&message.noNetworkGuard===true&&!ready){ready=true;readySignal.resolve(true);return;}
   if(message.type==='result'&&!received){
    const encoded=JSON.stringify(message);
    if(Object.keys(message).length!==RESULT_KEYS.length||RESULT_KEYS.some(key=>!Object.hasOwn(message,key))||Buffer.byteLength(encoded)>FIREFOX_PROFILE_IPC_LIMITS.summaryBytes+2048||typeof message.rawBytes!=='number'||!Number.isInteger(message.rawBytes)||message.rawBytes<0||message.rawBytes>FIREFOX_PROFILE_IPC_LIMITS.rawBytes||typeof message.eof!=='boolean'||(message.failure!==null&&!RECEIVER_FAILURES.has(message.failure))||(message.failure===null&&(!isFirefoxProfileProjection(message.summary)||message.summary.rawBytes!==message.rawBytes||(!message.eof&&message.summary.status!=='refused')))||(message.failure!==null&&message.summary!==null)){tainted=true;state.status='unavailable';state.code='PROFILE_RECEIVER_PROTOCOL';state.summary=null;state.eofObserved=null;state.parserRefusal=null;state.receiverFailure=null;return;}
    received=message;state.rawBytes=message.rawBytes;
    if(!tainted){state.eofObserved=message.eof;state.receiverFailure=message.failure;state.parserRefusal=message.failure===null&&message.summary.status==='refused'?message.summary.reason:null;}
   }
  });
  receiver.child.send({type:'prepare',fifo,leaf,leafIdentity,fifoIdentity},()=>{});
  const available=await bounded(Promise.race([readySignal.promise,receiver.closed.then(()=>false)]),Math.max(1,FIREFOX_PROFILE_IPC_LIMITS.setupMs-(performance.now()-started)-1000));
  if(!available)throw fail('PROFILE_RECEIVER_UNAVAILABLE');
  await validateOwned();state.code='PROFILE_WAITING';
  // Independent of FixtureOwner steps: an exhausted global teardown cannot leave
  // this receiver alive indefinitely. Closed readers do NOT imply browser exit;
  // a later blocking native open can still wait, so retain the FIFO on uncertainty.
  watchdog=setTimeout(()=>{void stop('PROFILE_LIFETIME_EXPIRED');},Math.max(1,FIREFOX_PROFILE_IPC_LIMITS.lifetimeMs-(performance.now()-started)-1000));watchdog.unref();
 }catch(error){
  if(maker&&!maker.ended)await stopChild(maker);
  if(receiver)await stop('PROFILE_SETUP_FAILED');
  // No browser has received the path yet. Remove only verified closed IPC;
  // never remove an unexpected regular file or an uncertain live maker.
  if(leaf&&(!maker||maker.ended)&&(!receiver||state.helperClosed)){
   try{if(fifoIdentity){state.helperClosed=true;state.browserClosed=true;await removeClosedIPC();}else if((await readdir(leaf)).length===0)await rmdir(leaf);}catch{}
  }
  throw fail(error?.code?.startsWith('PROFILE_')?error.code:'PROFILE_SETUP_FAILED');
 }
 return Object.freeze({
  launchEnvironment(baseEnv){
   if(finishing||finished||tainted||receiver.ended)throw fail('PROFILE_LAUNCH_UNAVAILABLE');
   const env={...baseEnv};
   for(const key of Object.keys(env))if(key.startsWith('MOZ_PROFILER_')||key==='MOZ_LOG'||key==='MOZ_LOG_FILE'||key==='MOZ_USE_PERFORMANCE_MARKER_FILE')delete env[key];
   const issued=Object.freeze({...env,...SETTINGS,MOZ_PROFILER_SHUTDOWN:fifo});issuedEnvironments.add(issued);return issued;
  },
  ownsLaunchEnvironment(env){return issuedEnvironments.has(env);},
  snapshot,
  cancel({remainingMs}={}){let budget=900;if(remainingMs!==undefined){try{budget=remainingMs();}catch{budget=0;}}return stop('PROFILE_CANCELLED',budget);},
  finish({context,closeBrowser,excludedRoots:finalRoots,remainingMs}){
   if(finishing)return finishing;
   finishing=(async()=>{
    let closeError,closeSettled=false,validationError;
    const available=()=>{try{const value=remainingMs();return Number.isFinite(value)?Math.max(0,Math.min(15000,value)):0;}catch{return 0;}};
    const admitted=available(),deadline=performance.now()+admitted;
    const remaining=()=>Math.max(0,Math.min(available(),deadline-performance.now()));
    const reserve=Math.min(FIREFOX_PROFILE_IPC_LIMITS.cancelMs,admitted/4);
    const workMs=Math.max(0,Math.min(FIREFOX_PROFILE_IPC_LIMITS.closeWorkMs,admitted-reserve));
    const workDeadline=performance.now()+workMs;
    const finishWatchdog=setTimeout(()=>{void stop('PROFILE_CLOSE_DEADLINE',remaining());},Math.max(1,workMs));
    if(admitted<=0){clearTimeout(finishWatchdog);await stop('PROFILE_PHASE_EXPIRED',0);finished=true;throw fail('PROFILE_PHASE_EXPIRED');}
    try{await exclusions(leaf,finalRoots);await validateOwned();}catch{validationError=true;await stop('PROFILE_PATH_CHANGED',remaining());}
    if(remaining()<=reserve)await stop('PROFILE_PHASE_EXPIRED',remaining());
    if(remaining()<=0){clearTimeout(finishWatchdog);finished=true;throw fail('PROFILE_PHASE_EXPIRED');}
    if(!validationError&&!tainted&&receiver.child.connected)receiver.child.send({type:'context',value:publicContext(context)},()=>{});
    const close=Promise.resolve().then(()=>{if(typeof closeBrowser!=='function')throw fail('PROFILE_BROWSER_CLOSE_UNAVAILABLE');return closeBrowser();}).then(()=>{closeSettled=true;state.browserClosed=true;state.writerMayOpen=false;},error=>{closeSettled=true;closeError=error;});
    const closed=receiver.closed.then(exit=>{state.helperClosed=true;state.helperExitCode=exit.code;state.helperSignal=exit.signal;});
    const complete=await bounded(Promise.all([close,closed]).then(()=>true),Math.max(0,Math.min(workDeadline-performance.now(),remaining()-reserve)));
    clearTimeout(finishWatchdog);
    if(!complete)await stop('PROFILE_CLOSE_DEADLINE',remaining());
    if(state.helperClosed)clearTimeout(watchdog);
    if(!tainted&&received&&received.failure===null&&(received.eof||received.summary.status==='refused')&&receiver.exit?.code===0&&!receiver.exit.spawnError&&state.browserClosed){state.status=received.summary.status;state.code=received.summary.reason;state.summary=received.summary.status==='refused'?null:received.summary;state.rawBytes=received.rawBytes;}
    else if(!tainted){state.status='unavailable';state.code=closeSettled?'PROFILE_FINALIZATION_UNAVAILABLE':'PROFILE_BROWSER_CLOSURE_UNKNOWN';}
    if(state.helperClosed&&state.browserClosed&&remaining()>0){try{await removeClosedIPC();}catch{state.status='unavailable';state.code='PROFILE_IPC_CUSTODY_FAILURE';state.summary=null;}}
    finished=true;
    if(closeError)throw closeError;
    if(!state.browserClosed)throw fail('PROFILE_BROWSER_CLOSURE_UNKNOWN');
    if(!state.helperClosed)throw fail('PROFILE_HELPER_CLOSURE_UNKNOWN');
    return snapshot();
   })();
   return finishing;
  }
 });
}
