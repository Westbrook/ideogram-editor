import {fork} from 'node:child_process';
import {once} from 'node:events';
import {resolve} from 'node:path';
export async function textBarrier(root:string){
 const child=fork(resolve('tests/editor/text-barrier-fixture.mjs'),[root,resolve('dist/app')],{execArgv:['--import',resolve('tests/protocol/no-effects.mjs')],env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR},stdio:['ignore','ignore','pipe','ipc']});
 const messages=new Map<string,any>(),waiting=new Map<string,(value:any)=>void>();let errors='';child.stderr!.on('data',b=>errors+=b);const exited=once(child,'exit');
 child.on('message',(m:any)=>{const cb=waiting.get(m.type);if(cb){waiting.delete(m.type);cb(m);}else messages.set(m.type,m);});
 const wait=(type:string):Promise<any>=>{if(messages.has(type)){const value=messages.get(type);messages.delete(type);return Promise.resolve(value);}return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Text barrier timeout: '+type+' '+errors)),20000);waiting.set(type,m=>{clearTimeout(timer);resolve(m);});});};
 const {origin}=await wait('ready');return {origin,wait:()=>wait('barrier'),release(){child.send('release');},async pair(){child.send('pair');return (await wait('pair')).url;},async effects(){child.send('effects');return (await wait('effects')).value;},async close(){if(child.connected){child.send('release');child.send('close');await exited;}}};
}
