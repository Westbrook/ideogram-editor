import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {mkdir,writeFile} from 'node:fs/promises';import {join} from 'node:path';
import {throwFailures,errorRecord} from '../editor/harness-lifecycle.js';
// @ts-ignore Shared public browser lifecycle path, exercised by synthetic runner controls.
import {registerBrowserClosure} from './browser-lifetime.mjs';
// Registered before acquisition. Body steps sort before physical closure; every
// operation belongs to this one owner, including failure retention and archives.
export function registerFinish(owner:any,receipt:string,outcome:{status?:string;errors:unknown[]}){
 const state=owner.state;
 for(const [phase,ms] of [['raw-failure-retention',20000],['renderer-trace-close',5000],['logical-cleanup',30000],['writer-close',15000],['writer-expiry-termination',1000],['native-close-receipt',1000]] as const)owner.add(phase,ms,()=>false,()=>{});
 owner.add('test-outcome',1000,()=>true,()=>{if(outcome.status!=='passed'&&!state.failures.length)state.failures.push({phase:'test-outcome',error:Error('Required workflow did not pass')});},-1);
 registerBrowserClosure(owner);
 owner.add('final-observations',10000,()=>Boolean(state.finalCheck),()=>state.finalCheck(),100);
 owner.add('archive',20000,()=>true,async(scope:any)=>{
  await scope(()=>mkdir(receipt,{recursive:true}));
  for(const root of [owner.resources.profile,owner.resources.privateDir])if(root&&!state.roots.includes(root))state.roots.push(root);
  for(const [index,root] of state.roots.entries()){
   state.retention.push({root,retained:true,reason:'Qualification originals are retained'});
   if(!state.writerClosed||!state.contextClosed||!state.browserClosed||owner.pending.size){state.failures.push({phase:'archive-precondition',error:Error('Physical closure not verified; original retained without stable archive claim')});continue;}
   const proof=JSON.parse((await scope(()=>promisify(execFile)('/usr/bin/python3',['tests/recovery/archive.py',root,join(receipt,'e4-state-backup-'+index+'.tar.gz')],{timeout:20000}))).stdout);state.retention.push({root,...proof,retained:true});
  }
 },100);
 owner.add('final-receipt',1000,()=>true,async(scope:any)=>{await scope(()=>mkdir(receipt,{recursive:true}));await scope(()=>writeFile(join(receipt,'e4-observations.json'),JSON.stringify({...state.observe?.() as object,ownerEvents:owner.events,pendingFunctional:owner.pending.size,timingCleanup:state.timingCleanup,browserLifetime:owner.resources.browserLifetime?.evidence,receiptBoundary:'This JSON is serialized inside final-receipt; its own completion and teardown-settled are proved only by the external runner/wrapper outcome.',failures:state.failures.map((f:any)=>({phase:f.phase,error:errorRecord(f.error)})),retention:state.retention,physicalClosure:{writerClosed:state.writerClosed,contextClosed:state.contextClosed,browserClosed:state.browserClosed}},null,2)));},200);
}
export function assertFinished(owner:any){throwFailures(owner.state.failures);}
