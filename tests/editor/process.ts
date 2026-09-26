import {fork} from 'node:child_process';
import {once} from 'node:events';
import {resolve} from 'node:path';
export async function serverProcess(root:string,maxPageCount?:number){
 const process=fork(resolve('tests/editor/process-fixture.mjs'),[root,resolve('dist/app'),maxPageCount?String(maxPageCount):''],{execArgv:['--import',resolve('tests/protocol/no-effects.mjs')],env:{PATH:globalThis.process.env.PATH},stdio:['ignore','ignore','pipe','ipc']});
 const messages=new Map<string,any>(),waiting=new Map<string,(value:any)=>void>();let error='';process.stderr!.on('data',b=>error+=b);
 process.on('message',(m:any)=>{const done=waiting.get(m.type);if(done){waiting.delete(m.type);done(m);}else messages.set(m.type,m);});
 const wait=(kind:string):Promise<any>=>{if(messages.has(kind)){const value=messages.get(kind);messages.delete(kind);return Promise.resolve(value);}return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(error||'Server did not respond: '+kind)),15000);waiting.set(kind,value=>{clearTimeout(timer);resolve(value);});});};
 const exited=once(process,'exit');const {origin}=await wait('ready');
 return {origin,pid:process.pid,async pair(){process.send('pair');return (await wait('pair')).url as string;},async resources(){process.send('resources');return (await wait('resources')).value;},async effects(){process.send('effects');return (await wait('effects')).value;},async close(){if(process.exitCode===null&&process.signalCode===null){process.send('close');await exited;}},async kill(){process.kill('SIGKILL');await exited;}};
}
