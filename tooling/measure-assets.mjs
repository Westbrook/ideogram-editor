import { startLocalServer } from '../dist/local/server/http.js';
import { openWriter } from '../dist/local/server/storage/writer.js';
import { EMPTY_EXPECTED_VERSIONS } from '../dist/local/src/protocol/store.js';
import { command } from '../tests/store/helpers.mjs';
import { pair,call,exchange,cookieFrom,readHeaders,mutationHeaders } from '../tests/session/helpers.mjs';
import { createHash,randomUUID,randomFillSync } from 'node:crypto';
import { mkdir,mkdtemp,writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import os from 'node:os';
const output=resolve(process.argv[2]??'artifacts/p1b3-measure');await mkdir(output,{recursive:true});
const samples=[];let peakRSS=0,peakHeap=0;const timer=setInterval(()=>{const m=process.memoryUsage();peakRSS=Math.max(peakRSS,m.rss);peakHeap=Math.max(peakHeap,m.heapUsed);},10);
try {for(const size of [8*1048576,32*1048576]){
  const root=await mkdtemp(join(output,'root-'));const server=await startLocalServer({root});const paired=await pair(server);const bytes=Buffer.alloc(size);randomFillSync(bytes);for(let i=0;i<size;i++)bytes[i]=33+bytes[i]%90;
  const sha256='sha256:'+createHash('sha256').update(bytes).digest('hex');const stage={protocolVersion:1,stagingId:randomUUID(),purpose:'caption',expectedBytes:String(size),sha256,mediaType:'text/plain'};const began=performance.now();
  let response=await call(server.origin,'/api/v1/assets/staging',{method:'POST',body:stage,headers:mutationHeaders(server,paired)});if(response.status!==201)throw Error(response.text);
  const chunks=[];let lastByteAt=began;
  for(let at=0;at<size;at+=1048576){const start=performance.now();const wire=exchange(server.origin,'/api/v1/assets/staging/'+stage.stagingId,{method:'PUT',raw:bytes.subarray(at,at+1048576),headers:{...mutationHeaders(server,paired),'Content-Type':'application/octet-stream','Upload-Offset':String(at)}});if(at+1048576===size)wire.request.once('finish',()=>lastByteAt=performance.now());response=await wire.response;if(response.status!==200)throw Error(response.text);chunks.push(performance.now()-start);}
  const c=command(EMPTY_EXPECTED_VERSIONS,{clientId:paired.json.clientId,documentId:null,body:{type:'FinalizeStaging',stagingId:stage.stagingId,expectedSha256:sha256}});const submitStart=performance.now();response=await call(server.origin,'/api/v1/commands',{method:'POST',body:c,headers:mutationHeaders(server,paired)});const pendingReceiptMs=performance.now()-submitStart;
  const pollMs=[];while(response.status===202){const start=performance.now();response=await call(server.origin,'/api/v1/commands/'+c.command.commandId,{headers:readHeaders(cookieFrom(paired))});pollMs.push(performance.now()-start);}
  if(response.json.receipt?.status!=='accepted')throw Error(response.text);const acceptedAt=performance.now();const events=await call(server.origin,'/api/v1/events?after=0',{headers:readHeaders(cookieFrom(paired))});const asset=events.json.batches[0].events[0].payload.asset;
  const downloadStart=performance.now();const downloaded=await call(server.origin,'/api/v1/assets/'+asset.id+'/content',{headers:readHeaders(cookieFrom(paired))});const downloadMs=performance.now()-downloadStart;if(downloaded.status!==200||createHash('sha256').update(downloaded.text).digest('hex')!==sha256.slice(7))throw Error('Download mismatch');
  await server.close();const w=await openWriter({root});const diagnostics=await w.diagnostics();await w.close();
  samples.push({bytes:size,sha256,root,chunkReceiptMs:chunks,maxChunkReceiptMs:Math.max(...chunks),pendingReceiptMs,maxPollReceiptMs:Math.max(...pollMs),lastClientByteToObservedAcceptanceMs:acceptedAt-lastByteAt,uploadToObservedAcceptanceMs:acceptedAt-began,downloadVerifiedClientMs:downloadMs,diagnostics});
}}finally{clearInterval(timer);}
const result={at:new Date().toISOString(),runtime:process.version,platform:process.platform,arch:process.arch,os:os.release(),cpu:os.cpus()[0].model,qualification:false,fixture:'Random ASCII UTF-8 opaque captions; original bytes retained, no image qualification. Cold new private roots; one sample each.',measurement:'Real loopback HTTP. Last-byte clock starts on the last PUT client request finish event and includes its flush acknowledgement, finalize admission and complete final lookup. Polling overhead remains included. Download uses a fixture client that materializes its body; production server uses32KiB pieces. RSS includes fixtures/client/server and worker.',peakRSS,peakHeap,samples};await writeFile(join(output,'observations.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({peakRSS,peakHeap,samples:samples.map(({bytes,pendingReceiptMs,lastClientByteToObservedAcceptanceMs,uploadToObservedAcceptanceMs,downloadVerifiedClientMs,maxChunkReceiptMs})=>({bytes,pendingReceiptMs,lastClientByteToObservedAcceptanceMs,uploadToObservedAcceptanceMs,downloadVerifiedClientMs,maxChunkReceiptMs}))},null,2));
