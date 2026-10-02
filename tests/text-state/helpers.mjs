import {fork} from 'node:child_process';
import {resolve} from 'node:path';
import {rootFor,command} from '../store/helpers.mjs';
import {call,cookieFrom,readHeaders,mutationHeaders} from '../session/helpers.mjs';
import {EMPTY_EXPECTED_VERSIONS} from '../../dist/local/src/protocol/store.js';
export async function isolated(t,options={}){
 // Ordinary API fixtures need no app. The native/browser lane supplies its
 // separately produced and sealed TEXT_STATE_APP, never a historical default.
 const fixtureDirectory=resolve(options.fixtureDirectory??'.'),fixture=resolve(fixtureDirectory,'tests/text-state/process-fixture.mjs');
 const app=options.staticDirectory===undefined?(process.env.TEXT_STATE_APP===undefined?'':resolve(process.env.TEXT_STATE_APP)):resolve(options.staticDirectory);
 // The parent chooses the already-verified historical fixture and its cwd. The
 // absolute current no-egress preload stays in force in that separate process.
 const root=options.root??await rootFor(t),p=fork(fixture,[root,app,options.phase??''],{cwd:fixtureDirectory,execArgv:['--import',resolve('tests/session/no-egress.mjs')],stdio:['ignore','ignore','pipe','ipc'],env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR}});
 let errors='',terminal;
 const queue=[],waiting=new Map();
 p.stderr.on('data',b=>errors+=b);
 const failure=type=>Object.assign(Error('Text-state child '+type+': '+(terminal?.kind==='error'?terminal.error.message:terminal?'exited code='+terminal.code+' signal='+terminal.signal:'timed out')+'\n'+errors),{
  code:terminal?.kind==='error'?'TEXT_STATE_CHILD_ERROR':terminal?'TEXT_STATE_CHILD_EXIT':'TEXT_STATE_CHILD_TIMEOUT',exitCode:terminal?.code??null,signal:terminal?.signal??null,...terminal?.error?{cause:terminal.error}:{}
 });
 const ended=state=>{terminal??=state;for(const [type,item] of waiting){clearTimeout(item.timer);item.reject(failure(type));}waiting.clear();};
 p.on('error',error=>ended({kind:'error',error}));
 p.once('exit',(code,signal)=>ended({kind:'exit',code,signal}));
 // An error is a refusal, not proof that a spawned child or its pipes drained.
 const closed=new Promise(resolve=>p.once('close',(code,signal)=>{ended({kind:'exit',code,signal});resolve({code,signal});}));
 const drain=async()=>{let timer;try{return await Promise.race([closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Text-state child close was not observed\n'+errors)),20000);})]);}finally{clearTimeout(timer);}};
 const kill=async()=>{if(p.exitCode===null&&p.signalCode===null&&p.pid!==undefined)p.kill('SIGKILL');await drain();};
 t.after(kill);
 p.on('message',m=>{if(terminal)return;const item=waiting.get(m.type);if(item){waiting.delete(m.type);clearTimeout(item.timer);item.resolve(m);}else queue.push(m);});
 const wait=type=>{
  if(terminal)return Promise.reject(failure(type));
  const at=queue.findIndex(m=>m.type===type);if(at>=0)return Promise.resolve(queue.splice(at,1)[0]);
  if(waiting.has(type))return Promise.reject(Error('A text-state child wait is already pending for '+type));
  return new Promise((resolve,reject)=>{const item={resolve,reject,timer:setTimeout(()=>{waiting.delete(type);reject(failure(type));},20000)};waiting.set(type,item);});
 };
 let ready;
 try{ready=await wait('ready');}catch(error){
  if(!terminal)throw error;
  // Refuse waiters immediately, then report startup with all stderr drained.
  try{await kill();}catch(cleanup){throw new AggregateError([failure('ready'),cleanup],'Text-state startup failed and child cleanup was incomplete');}
  throw failure('ready');
 }
 const {origin,url}=ready;
 const paired=await call(origin,'/api/v1/session/bootstrap',{method:'POST',headers:{Origin:origin,...options.cookie?{Cookie:options.cookie}:{}},body:{protocolVersion:1,pairingToken:new URL(url).hash.slice(9)}});
 const server={origin,close:async()=>{if(p.connected)p.send('close');const result=await drain();if(terminal?.kind==='error'||result.code!==0||result.signal)throw failure('close');}};
 return {root,paired,server,process:Object.freeze({pid:p.pid,executable:process.execPath,fixture,cwd:fixtureDirectory}),wait,memory:()=>{if(terminal||waiting.has('memory'))return wait('memory');const pending=wait('memory');p.send('memory');return pending;},kill,read:path=>call(origin,path,{headers:readHeaders(cookieFrom(paired))}),post:(path,body)=>call(origin,path,{method:'POST',body,headers:mutationHeaders(server,paired)}),command:(patch={},body={})=>command(EMPTY_EXPECTED_VERSIONS,{clientId:paired.json.clientId,...patch},body)};
}
