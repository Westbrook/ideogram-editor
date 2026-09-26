import {startLocalServer} from '../../dist/local/server/http.js';
import {openWriter} from '../../dist/local/server/storage/writer.js';
import {EMPTY_EXPECTED_VERSIONS as ref} from '../../dist/local/src/protocol/store.js';
import {command} from '../../tests/store/helpers.mjs';
import {call,pair,mutationHeaders,readHeaders,cookieFrom} from '../../tests/session/helpers.mjs';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const output=resolve(process.argv[2]??'artifacts/p1b3-contention');await mkdir(output,{recursive:true});const root=await mkdtemp(join(output,'root-'));const server=await startLocalServer({root});const paired=await pair(server);const headers=mutationHeaders(server,paired);const samples=[];
const send=async c=>{const start=performance.now();const r=await call(server.origin,'/api/v1/commands',{method:'POST',body:c,headers});const ms=performance.now()-start;if(r.status!==200&&r.status!==202)throw Error(r.text);return {r,ms};};
try{
  const bytes=Buffer.alloc(32*1048576,120);const s={protocolVersion:1,stagingId:'contention_original',purpose:'caption',expectedBytes:String(bytes.length),sha256:'sha256:'+createHash('sha256').update(bytes).digest('hex'),mediaType:'text/plain'};
  const created=await call(server.origin,'/api/v1/assets/staging',{method:'POST',body:s,headers});if(created.status!==201)throw Error(created.text);
  for(let at=0;at<bytes.length;at+=1048576){const r=await call(server.origin,'/api/v1/assets/staging/'+s.stagingId,{method:'PUT',raw:bytes.subarray(at,at+1048576),headers:{...headers,'Content-Type':'application/octet-stream','Upload-Offset':String(at)}});if(r.status!==200)throw Error(r.text);}
  await send(command(ref,{clientId:paired.json.clientId}));for(let i=1;i<249;i++)await send(command(ref,{clientId:paired.json.clientId,expectedDocumentRevision:String(i),body:{type:'SaveCheckpoint',name:'n'.repeat(8000)}}));
  const c=command(ref,{clientId:paired.json.clientId,documentId:null,body:{type:'FinalizeStaging',stagingId:s.stagingId,expectedSha256:s.sha256}});const finalize=await send(c);
  for(let i=249;i<329;i++){const {r,ms}=await send(command(ref,{clientId:paired.json.clientId,expectedDocumentRevision:String(i),body:{type:'SaveCheckpoint',name:'n'.repeat(8000)}}));if(r.json.receipt?.status!=='accepted')throw Error(r.text);samples.push({revision:i+1,seq:r.json.receipt.toSeq,ms});}
  const receipt=await call(server.origin,'/api/v1/commands/'+c.command.commandId,{headers:readHeaders(cookieFrom(paired))});if(receipt.json.receipt?.status!=='accepted')throw Error(receipt.text);await server.close();
  const w=await openWriter({root});const diagnostics=await w.diagnostics();await w.close();const result={at:new Date().toISOString(),qualification:false,root,fixture:'32MiB UTF-8 original finalization overlaps serial8k-name checkpoint receipts and snapshot250; HTTP whole responses measured. No provider.',finalizeAdmissionMs:finalize.ms,samples,maxMs:Math.max(...samples.map(x=>x.ms)),over50:samples.filter(x=>x.ms>50),receipt:receipt.json,diagnostics};await writeFile(join(output,'contention.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({maxMs:result.maxMs,over50:result.over50,finalizeAdmissionMs:finalize.ms}));
}finally{await server.close();}
