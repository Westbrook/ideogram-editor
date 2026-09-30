import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,readdir,lstat,readlink,mkdir,rm,writeFile,mkdtemp} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import type {BrowserContext} from '@playwright/test';

export type Failure={phase:string;error:unknown};
export type RunState={failures:Failure[];roots:string[];writerClosed:boolean;contextClosed:boolean;browserClosed:boolean;retention:unknown[];observe?:()=>unknown;finalCheck?:()=>Promise<void>;receipt:string;prefix:string};
export const runs=new WeakMap<BrowserContext,RunState>();
export function errorRecord(error:unknown){return error instanceof Error?{name:error.name,message:error.message,stack:error.stack}: {message:String(error)};}
export async function step(state:RunState,phase:string,work:()=>Promise<unknown>){try{await work();return true;}catch(error){state.failures.push({phase,error});return false;}}
export function throwFailures(failures:Failure[]){if(failures.length===1)throw failures[0].error;if(failures.length)throw new AggregateError(failures.map(f=>f.error),'Required body or cleanup failed');}
async function manifest(root:string):Promise<unknown[]>{
 const rows:unknown[]=[];
 async function walk(dir:string,relative:string){for(const name of (await readdir(dir)).sort()){const path=join(dir,name),key=relative+name,stat=await lstat(path);if(stat.isSymbolicLink())rows.push({path:key,link:await readlink(path)});else if(stat.isDirectory()){rows.push({path:key,directory:true});await walk(path,key+'/');}else if(stat.isFile())rows.push({path:key,bytes:stat.size,sha256:createHash('sha256').update(await readFile(path)).digest('hex')});else throw Error('UNSUPPORTED_FAILED_STATE_ENTRY');}}
 await walk(root,'');return rows;
}
// Extraction is verified byte-for-byte before any source root may be removed.
export async function archiveVerified(root:string,destination:string){
 const before=await manifest(root);await promisify(execFile)('/usr/bin/tar',['-czf',destination,'-C',root,'.']);
 const verify=await mkdtemp(join(dirname(destination),'verify-archive-'));
 try{await promisify(execFile)('/usr/bin/tar',['-xzf',destination,'-C',verify]);const after=await manifest(root),extracted=await manifest(verify);if(JSON.stringify(before)!==JSON.stringify(after)||JSON.stringify(before)!==JSON.stringify(extracted))throw Error('FAILED_STATE_ARCHIVE_MISMATCH');return {archive:destination,sha256:createHash('sha256').update(await readFile(destination)).digest('hex'),entries:before.length,verified:true};}finally{await rm(verify,{recursive:true,force:true});}
}
export async function retainOrRemove(state:RunState,archive=archiveVerified,remove=(root:string)=>rm(root,{recursive:true,force:true})){
 for(const [index,root] of state.roots.entries()){
  if(!state.writerClosed||!state.contextClosed||!state.browserClosed){state.retention.push({root,retained:true,reason:'Owned shutdown not verified'});state.failures.push({phase:'retention',error:Error('FAILED_STATE_WRITER_NOT_CLOSED')});continue;}
  // A verified backup also protects against a partial removal failure itself.
  try{const proof=await archive(root,join(state.receipt,state.prefix+'state-backup-'+index+'.tar.gz'));state.retention.push({root,...proof});}catch(error){state.failures.push({phase:'archive',error});state.retention.push({root,retained:true,reason:'Archive verification failed'});continue;}
  if(await step(state,'remove-private-root',()=>remove(root)))state.retention.push({root,removed:true});
 }
}
export async function finishFixture(context:BrowserContext,browser:{close():Promise<void>}|null|undefined,profile:string|null|undefined,receipt:string,prefix:string,testOutcome?:{status?:string;errors:unknown[]}){
 const state=runs.get(context)??{failures:[],roots:[],writerClosed:true,contextClosed:false,browserClosed:false,retention:[],receipt,prefix};
 if(testOutcome?.status&&testOutcome.status!=='passed'&&!state.failures.length)state.failures.push({phase:'test-outcome',error:new AggregateError(testOutcome.errors,'Required test did not pass: '+testOutcome.status)});
 const previous=state.failures.length;if(profile)state.roots.push(profile);
 state.contextClosed=await step(state,'context-close',()=>context.close());state.browserClosed=await step(state,'browser-close',async()=>{await browser?.close();});
 if(state.finalCheck)await step(state,'final-observations',state.finalCheck);
 await mkdir(receipt,{recursive:true});await retainOrRemove(state);
 const failures=state.failures.map(f=>({phase:f.phase,error:errorRecord(f.error)}));
 await writeFile(join(receipt,prefix+'observations.json'),JSON.stringify({...state.observe?.() as object,failures,retention:state.retention,physicalClosure:{writerClosed:state.writerClosed,contextClosed:state.contextClosed,browserClosed:state.browserClosed}},null,2));
 await writeFile(join(receipt,prefix+'fixture.json'),JSON.stringify({contextClosed:state.contextClosed,browserClosed:state.browserClosed,profileRemoved:profile&&state.retention.some((r:any)=>r.root===profile&&r.removed)?profile:null,retention:state.retention,failures},null,2));
 throwFailures(state.failures.slice(previous));
}
