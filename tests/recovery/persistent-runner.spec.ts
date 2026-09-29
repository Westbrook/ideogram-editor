import {test as base,type TestInfo} from '@playwright/test';import {EventEmitter} from 'node:events';import {mkdir,writeFile} from 'node:fs/promises';import {join} from 'node:path';
// @ts-ignore Exact E4 fixture owner and public lifecycle adapter; synthetic handles only.
import {FixtureOwner,ownedFixture} from './fixture-owner.mjs';
// @ts-ignore Same acquisition and closure methods used by E4.
import {acquireBrowserContext} from './browser-lifetime.mjs';
import {registerFinish,assertFinished} from './lifecycle.js';
const test=base.extend<{owned:any}>({owned:[async({},use:(value:any)=>Promise<void>,info:TestInfo)=>{
 const receipt=join(process.env.PERSISTENT_RUNNER_ROOT!,info.title),profile=join(receipt,'profile');await mkdir(profile,{recursive:true});await writeFile(join(profile,'retained'),'synthetic profile');
 const state:any={failures:[],roots:[],writerClosed:false,contextClosed:false,browserClosed:false,retention:[]};const owner=new FixtureOwner(state),events:string[]=[];let late:()=>void=()=>{};const held=new Promise<void>(resolve=>late=resolve);
 registerFinish(owner,receipt,info);
 // Finite synthetic deadlines exercise the actual phase scope, never native work.
 for(const phase of ['context-close','browser-close'])owner.steps.find((s:any)=>s.phase===phase).ms=15;
 state.observe=()=>({synthetic:true,nativeLaunches:0,events});state.finalCheck=()=>{};
 for(const phase of ['raw-failure-retention','renderer-trace-close','logical-cleanup','writer-close','writer-expiry-termination','native-close-receipt'])owner.provide(phase,100,()=>true,()=>{if(phase==='logical-cleanup')events.push('native-reset');if(phase==='writer-close')state.writerClosed=true;});
 // Resolve late close only after its phase expires; no stale continuation may claim closure.
 owner.add('release-late-close',100,()=>true,async()=>{late();await new Promise(resolve=>setImmediate(resolve));},101);
 class Browser extends EventEmitter{connected=true;calls=0;isConnected(){return this.connected;}async close(){this.calls++;events.push('browser-close');if(info.title==='missing-disconnection')return;this.connected=false;this.emit('disconnected');}}
 const browser=new Browser();class Context extends EventEmitter{calls=0;browser(){return info.title==='missing-handle'?null:browser;}async close(){this.calls++;events.push('context-close');if(info.title==='context-rejection')throw Error('context close rejected');if(info.title==='late-close')await held;this.emit('close');if(info.title!=='missing-disconnection'){browser.connected=false;browser.emit('disconnected');}}}
 const context=new Context(),type={launchPersistentContext:async(received:string)=>{if(received!==profile)throw Error('Wrong owned profile');events.push('launch-persistent');return context;}};
 try{await ownedFixture(owner,async()=>{await owner.acquire('profile',async()=>profile);await acquireBrowserContext(owner,type,profile,{});},()=>use(owner));}
 finally{await writeFile(join(receipt,'outside-receipt.json'),JSON.stringify({contextCalls:context.calls,browserCalls:browser.calls,ownerEvents:owner.events,cleanup:state.timingCleanup,physicalClosure:{contextClosed:state.contextClosed,browserClosed:state.browserClosed},failures:state.failures.map((f:any)=>({phase:f.phase,error:String(f.error)})),retention:state.retention,events}));}
 assertFinished(owner);
},{scope:'test',timeout:5000}]});
for(const name of ['persistent-success','missing-handle','context-rejection','missing-disconnection','late-close'])test(name,async({owned})=>{await owned.body(async()=>{});});
