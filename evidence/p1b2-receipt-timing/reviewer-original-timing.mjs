import {startLocalServer} from './source/dist/local/server/http.js';
import {openWriter} from './source/dist/local/server/storage/writer.js';
import {command,checkpoint,encode} from './source/tests/store/helpers.mjs';
import {EMPTY_EXPECTED_VERSIONS} from './source/dist/local/src/protocol/store.js';
import {call,pair,mutationHeaders} from './source/tests/session/helpers.mjs';
import {mkdtemp,chmod,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {DatabaseSync} from 'node:sqlite';
import os from 'node:os';
const base=new URL('.',import.meta.url).pathname;const runs=[];
for(const [label,nameLength]of [['small',20],['bounded-large',8000]]){
 const root=await mkdtemp(join(base,'roots/timing-'));await chmod(root,0o700);const s=await startLocalServer({root});const p=await pair(s);const samples=[];
 const submit=async c=>{const before=performance.now();const response=await call(s.origin,'/api/v1/commands',{method:'POST',headers:mutationHeaders(s,p),body:c});const ms=performance.now()-before;if(response.json.receipt?.status!=='accepted')throw Error(JSON.stringify(response.json));return {seq:response.json.receipt.toSeq,ms};};
 try {samples.push(await submit(command(EMPTY_EXPECTED_VERSIONS,{clientId:p.json.clientId})));for(let i=1;i<260;i++)samples.push(await submit(command(EMPTY_EXPECTED_VERSIONS,{clientId:p.json.clientId,expectedDocumentRevision:String(i),body:{type:'SaveCheckpoint',name:'n'.repeat(nameLength)}})));}finally{await s.close();}
 const db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});const snapshot=JSON.parse(db.prepare('SELECT descriptor FROM snapshots').get().descriptor);const maxEventBytes=db.prepare('SELECT max(length(cast(json AS BLOB))) n FROM events_v2').get().n;db.close();
 runs.push({label,root,nameLength,maxEventBytes,snapshot,samples,over50:samples.filter(x=>x.ms>50),aroundSnapshot:samples.filter(x=>Number(x.seq)>=248)});
 console.log(label,JSON.stringify(runs.at(-1).aroundSnapshot));
}
const root=await mkdtemp(join(base,'roots/writer-timing-'));await chmod(root,0o700);const w=await openWriter({root});await w.protocolDefaults();
await w.submit(encode(command(EMPTY_EXPECTED_VERSIONS)),w.epoch);for(let i=1;i<260;i++)await w.submit(encode(checkpoint(EMPTY_EXPECTED_VERSIONS,String(i),'n'.repeat(8000))),w.epoch);
const d=await w.diagnostics();await w.close();
const evidence={target:'446ed20a366d26f5b9d0612b1cba468d023b2742',at:new Date().toISOString(),node:process.version,platform:process.platform,arch:process.arch,os:os.release(),cpu:os.cpus()[0].model,qualification:false,measurement:'Serial local HTTP send through full client receipt; includes transport. Separate exact worker appendMs excludes HTTP and includes postcommit snapshot work. Synthetic fixtures are not W1/WQ or H/C qualification.',runs,writer:{root,appendMs:d.observations.appendMs,settings:d.settings,snapshot:d.observations.snapshot,maxMs:Math.max(...d.observations.appendMs)}};
await writeFile(join(base,'timing.json'),JSON.stringify(evidence,null,2)+'\n');console.log('worker maximum',evidence.writer.maxMs);
