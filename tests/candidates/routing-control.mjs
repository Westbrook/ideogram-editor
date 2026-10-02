import {isMainThread} from 'node:worker_threads';
import {fileURLToPath} from 'node:url';
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {resolveInactive} from '../../dist/local/src/request/core.js';
import {fixtureProfile} from '../provider/emulator.mjs';
import {setup as observerSetup} from './observer-fixture.mjs';

// Test-only alternate setup module for one deliberately mismatched profile.
export function setup(store){return observerSetup(store,{profileEndpointOverrides:{'ideogram/v4/fast':'ideogram/v4'}});}
const errorRecord=e=>({name:e.name,message:e.message,stack:e.stack,code:e.code});
async function run(){
 const mode=process.argv[2],output=process.argv[3],record={mode,commands:[],jobs:[],declaredOriginalProfiles:['ideogram/v4','ideogram/v4/fast','ideogram/v4/instant'].map(endpoint=>fixtureProfile({endpoint})),writerClosed:false,errors:[]};let writer;
 try{
  // This module is also a worker setup entry. Only its main-process runner may
  // import the writer/central ledger; worker diagnostics are already adopted.
  const [{fixture,prepare,enqueue},{openWriter}]=await Promise.all([import('../queue/helpers.mjs'),import('../../dist/local/server/storage/writer.js')]);
  const f=await fixture({name:'routing-'+mode,after:()=>{}},{width:512,height:512});record.root=f.root;process.send?.({type:'root',root:f.root});await f.close();
  writer=await openWriter({root:f.root},{setupModule:mode==='mismatch'?import.meta.url:new URL('./observer-fixture.mjs',import.meta.url).href});
  for(const [index,operation]of ['generate','fast','instant'].entries()){
   const p=await prepare(writer,d=>{d.fields.width='512';d.fields.height='512';d.operation=operation;if(operation!=='generate')resolveInactive(d,'acceleration');if(operation==='instant')resolveInactive(d,'speed');},String(index+1));
   const q=await enqueue(writer,p.body);record.commands.push(q.request);const row={jobId:q.job.id,attemptId:q.job.attempts[0].id,endpoint:q.job.review.endpoint,request:q.request,accepted:q.receipt};record.jobs.push(row);
   for(let i=0;i<100;i++){
    row.queue=(await writer.queueView()).jobs.find(j=>j.id===q.job.id);
    const observed=JSON.parse(await readFile(join(f.root,'candidate-fixture.json'),'utf8'));
    if(observed.errors.length){record.fixture=observed;break;}
    try{row.candidate=await writer.candidateView(q.job.id,q.job.attempts[0].id);}catch(e){if(e.code!=='NOT_FOUND')throw e;}
    if(row.candidate?.items[0]?.state==='prepared')break;
    await new Promise(r=>setTimeout(r,50));
   }
   if(row.candidate?.items[0]?.state!=='prepared')break;
  }
 }catch(e){record.errors.push(errorRecord(e));}
 finally{
  if(writer)try{await writer.close();record.writerClosed=true;}catch(e){record.closeError=errorRecord(e);}
  if(record.root)try{record.fixture=JSON.parse(await readFile(join(record.root,'candidate-fixture.json'),'utf8'));}catch(e){record.errors.push(errorRecord(e));}
  await writeFile(output,JSON.stringify(record,null,2),{mode:0o600});
  process.exitCode=record.errors.length===0&&record.writerClosed&&record.jobs.length===3&&record.jobs.every(j=>j.candidate?.items[0]?.state==='prepared')?0:1;
  process.disconnect?.();
 }
}
if(isMainThread&&process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await run();
