import {fork} from 'node:child_process';
import {once} from 'node:events';
import {resolve} from 'node:path';
import {rootFor,command} from '../store/helpers.mjs';
import {call,cookieFrom,readHeaders,mutationHeaders} from '../session/helpers.mjs';
import {EMPTY_EXPECTED_VERSIONS} from '../../dist/local/src/protocol/store.js';
export async function isolated(t,options={}){
 const root=options.root??await rootFor(t),p=fork(resolve('tests/text-state/process-fixture.mjs'),[root,resolve(process.env.TEXT_STATE_APP??'artifacts/p1c2/app'),options.phase??''],{execArgv:['--import',resolve('tests/session/no-egress.mjs')],stdio:['ignore','ignore','pipe','ipc'],env:{PATH:process.env.PATH}});let errors='';p.stderr.on('data',b=>errors+=b);const exited=once(p,'exit'),queue=[],waiting=new Map();
 p.on('message',m=>{const cb=waiting.get(m.type);if(cb){waiting.delete(m.type);cb(m);}else queue.push(m);});
 const wait=type=>{const at=queue.findIndex(m=>m.type===type);if(at>=0)return Promise.resolve(queue.splice(at,1)[0]);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(type+' '+errors)),20000);waiting.set(type,m=>{clearTimeout(timer);resolve(m);});});};
 t.after(async()=>{if(p.exitCode===null&&p.signalCode===null){p.kill('SIGKILL');await exited;}});
 const {origin,url}=await wait('ready');
 const paired=await call(origin,'/api/v1/session/bootstrap',{method:'POST',headers:{Origin:origin,...options.cookie?{Cookie:options.cookie}:{}},body:{protocolVersion:1,pairingToken:new URL(url).hash.slice(9)}});
 const server={origin,close:async()=>{if(p.connected){p.send('close');await exited;}}};
 return {root,paired,server,wait,memory:()=>{p.send('memory');return wait('memory');},kill:async()=>{p.kill('SIGKILL');await exited;},read:path=>call(origin,path,{headers:readHeaders(cookieFrom(paired))}),post:(path,body)=>call(origin,path,{method:'POST',body,headers:mutationHeaders(server,paired)}),command:(patch={},body={})=>command(EMPTY_EXPECTED_VERSIONS,{clientId:paired.json.clientId,...patch},body)};
}
