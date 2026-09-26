import{startLocalServer}from'../../dist/local/server/http.js';import{openWriter}from'../../dist/local/server/storage/writer.js';
import{EMPTY_EXPECTED_VERSIONS as ref}from'../../dist/local/src/protocol/store.js';
import{command}from'../../tests/store/helpers.mjs';import{call,pair,mutationHeaders,readHeaders,cookieFrom}from'../../tests/session/helpers.mjs';
import{mkdtemp,writeFile,readFile,realpath}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{createHash,randomUUID}from'node:crypto';
const root=await mkdtemp(join(await realpath(tmpdir()),'raster-contention-')),server=await startLocalServer({root}),paired=await pair(server),headers=mutationHeaders(server,paired),samples=[];
const send=async c=>{const at=performance.now(),r=await call(server.origin,'/api/v1/commands',{method:'POST',body:c,headers});if(![200,202].includes(r.status))throw Error(r.text);return {r,ms:performance.now()-at};};
const settled=async id=>{for(let i=0;i<1000;i++){const r=await call(server.origin,'/api/v1/commands/'+id,{headers:readHeaders(cookieFrom(paired))});if(r.json.receipt)return r.json.receipt;await new Promise(r=>setTimeout(r,5));}throw Error('Pending raster');};
try{
 const bytes=await readFile('tests/raster/fixtures/normal-png.png'),hash='sha256:'+createHash('sha256').update(bytes).digest('hex'),stagingId=randomUUID();
 let r=await call(server.origin,'/api/v1/assets/staging',{method:'POST',body:{protocolVersion:1,stagingId,purpose:'image',expectedBytes:String(bytes.length),sha256:hash,mediaType:'image/png'},headers});if(r.status!==201)throw Error(r.text);
 r=await call(server.origin,'/api/v1/assets/staging/'+stagingId,{method:'PUT',raw:bytes,headers:{...headers,'Content-Type':'application/octet-stream','Upload-Offset':'0'}});if(r.status!==200)throw Error(r.text);
 const final=command(ref,{clientId:paired.json.clientId,documentId:null,body:{type:'FinalizeStaging',stagingId,expectedSha256:hash}});await send(final);const receipt=await settled(final.command.commandId);
 r=await call(server.origin,'/api/v1/events?after='+String(BigInt(receipt.fromSeq)-1n),{headers:readHeaders(cookieFrom(paired))});const asset=r.json.batches[0].events[0].payload.asset;
 await send(command(ref,{clientId:paired.json.clientId}));for(let i=1;i<248;i++)await send(command(ref,{clientId:paired.json.clientId,expectedDocumentRevision:String(i),body:{type:'SaveCheckpoint',name:'n'.repeat(8000)}}));
 const prepare=command(ref,{clientId:paired.json.clientId,documentId:null,body:{type:'PrepareRaster',assetId:asset.id}});const admission=await send(prepare);
 for(let i=248;i<328;i++){const {r,ms}=await send(command(ref,{clientId:paired.json.clientId,expectedDocumentRevision:String(i),body:{type:'SaveCheckpoint',name:'n'.repeat(8000)}}));if(r.json.receipt?.status!=='accepted')throw Error(r.text);samples.push({revision:i+1,seq:r.json.receipt.toSeq,ms});}
 const terminal=await settled(prepare.command.commandId);if(terminal.status!=='accepted')throw Error(JSON.stringify(terminal));await server.close();const w=await openWriter({root}),diagnostics=await w.diagnostics();await w.close();
 const facts={at:new Date().toISOString(),qualification:false,root,fixture:'2048x2048 actual PNG decode/encode/durable publication overlapping serial8KiB checkpoint HTTP receipts and snapshot250. HTTP intervals include dispatch and full response; raster parent preparation is separate.',targets:{R20TargetMs:20,R20CeilingMs:50},rasterAdmissionMs:admission.ms,terminal,samples,maxMs:Math.max(...samples.map(s=>s.ms)),over50:samples.filter(s=>s.ms>50),diagnostics,externalEffects:0};
 await writeFile('evidence/p1b4/raster-contention.json',JSON.stringify(facts,null,2)+'\n');console.log(JSON.stringify({maxMs:facts.maxMs,over50:facts.over50,rasterAdmissionMs:admission.ms}));
}finally{await server.close();}
