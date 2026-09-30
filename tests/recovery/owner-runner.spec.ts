import {test as base,type TestInfo} from '@playwright/test';import {writeFile} from 'node:fs/promises';import {join} from 'node:path';
// @ts-ignore The exact E4 owner; no browser fixtures or native resources.
import {FixtureOwner,ownedFixture} from './fixture-owner.mjs';
const test=base.extend<{owned:any}>({owned:[async({},use:(value:any)=>Promise<void>,info:TestInfo)=>{
 const state:any={failures:[]},owner=new FixtureOwner(state),events:string[]=[];let late:()=>void=()=>{};let body:Promise<unknown>|undefined;
 const held=new Promise<void>(resolve=>late=resolve);
 owner.add('release-pending-after-stop',100,()=>true,async()=>{late();if(body)await body.catch(()=>{});});
 owner.add('native',10,()=>Boolean(owner.resources.guard),async(scope:any)=>{events.push('native');if(info.title==='cleanup-expiry')await scope(()=>new Promise(()=>{}));if(info.title==='cleanup-rejection')throw Error('native rejection');});
 for(const name of ['context','browser'])owner.add(name,100,()=>Boolean(owner.resources[name]),async()=>{events.push(name);owner.resources[name].closed++;});
 owner.add('archive-outcome',100,()=>true,()=>{state.retention={incomplete:state.failures.length>0,reason:'Synthetic resources only; no native archive proof',browserClosed:owner.resources.browser?.closed===1,contextClosed:owner.resources.context?.closed===1};});
 owner.add('final-receipt',1000,()=>true,async()=>{await writeFile(join(process.env.OWNER_RUNNER_ROOT!,info.title+'.json'),JSON.stringify({events,retention:state.retention,ownerEvents:owner.events,cleanup:state.timingCleanup,failures:state.failures.map((f:any)=>({phase:f.phase,error:String(f.error)})),resources:owner.resources}));});
 await ownedFixture(owner,async()=>{await owner.acquire('browser',async()=>({closed:0}));if(info.title==='context-failure')throw Error('context setup');await owner.acquire('context',async()=>({closed:0}));if(info.title==='initial-page-failure')throw Error('initial page close');await owner.active(async()=>{if(info.title==='guard-failure')throw Error('guard setup');owner.resources.guard={};});},()=>use({owner,events,held,setBody:(p:Promise<unknown>)=>body=p}));
 if(state.failures.length)throw Error('Synthetic expected failure: '+state.failures.map((f:any)=>f.phase).join(','));
},{scope:'test',timeout:2000}]});
for(const name of ['context-failure','initial-page-failure','guard-failure','body-timeout','late-failure','cleanup-rejection','cleanup-expiry'])test(name,async({owned})=>{
 const {owner,events,held}=owned;if(name==='body-timeout'||name==='late-failure')test.setTimeout(30);
 const body=owner.body(async()=>{if(name==='body-timeout'){await owner.active(()=>held);events.push('ILLEGAL_RESUMED_ACTION');}else if(name==='late-failure'){await held;throw Error('late assertion after timeout');}});owned.setBody(body);await body;
});
