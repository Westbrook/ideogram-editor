import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {request} from 'node:http';
import {call,mutationHeaders,readHeaders,cookieFrom} from '../session/helpers.mjs';
export const fixtureBytes=name=>readFile(new URL('./fixtures/'+name,import.meta.url));
export const digest=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
export const envelope=(f,body)=>f.command({documentId:null,expectedDocumentRevision:null,body});
export async function terminal(f,c){let r=await f.post('/api/v1/commands',c);if(r.status===202)assert.equal(r.headers.location,r.json.receiptUrl);
 for(let i=0;r.status===202&&i<1000;i++){await new Promise(resolve=>setTimeout(resolve,5));r=await f.read('/api/v1/commands/'+c.command.commandId);if(r.status===202)assert.equal(r.headers.location,r.json.receiptUrl);}assert.equal(r.status,200,r.text);return r;}
export async function eventFor(f,receipt){const r=await f.read('/api/v1/events?after='+String(BigInt(receipt.fromSeq)-1n));assert.equal(r.status,200,r.text);return r.json.batches[0].events[0];}
export async function operate(f,body){const c=envelope(f,body),r=await terminal(f,c);assert.equal(r.json.receipt.status,'accepted',r.text);return {command:c,receipt:r.json.receipt,event:await eventFor(f,r.json.receipt)};}
export async function original(f,name){const bytes=await fixtureBytes(name),mediaType=name.endsWith('.jpg')?'image/jpeg':name.endsWith('.webp')?'image/webp':'image/png';
 const s={protocolVersion:1,stagingId:randomUUID(),purpose:'image',expectedBytes:String(bytes.length),sha256:digest(bytes),mediaType};assert.equal((await f.post('/api/v1/assets/staging',s)).status,201);
 for(let at=0;at<bytes.length;at+=1048576){const r=await call(f.server.origin,'/api/v1/assets/staging/'+s.stagingId,{method:'PUT',raw:bytes.subarray(at,at+1048576),headers:{...mutationHeaders(f.server,f.paired),'Content-Type':'application/octet-stream','Upload-Offset':String(at)}});assert.equal(r.status,200,r.text);}
 const done=await operate(f,{type:'FinalizeStaging',stagingId:s.stagingId,expectedSha256:s.sha256});return done.event.payload.asset;}
export async function importRaster(f,name){const input=await original(f,name),prepared=await operate(f,{type:'PrepareRaster',assetId:input.id}),preview=prepared.event.payload.asset;
 const reviewed=await operate(f,{type:'ReviewRaster',assetId:preview.id}),review=(await f.read('/api/v1/assets/raster-reviews/'+reviewed.event.payload.reviewId)).json;
 const approved=await operate(f,{type:'ApproveRaster',assetId:preview.id,reviewId:review.reviewId,reviewHash:review.reviewHash});return {input,preview,review,asset:approved.event.payload.asset,prepared,approved};}
export async function binary(f,id,headers={}){return new Promise((resolve,reject)=>{const url=new URL(f.server.origin);const req=request({hostname:'127.0.0.1',port:url.port,path:'/api/v1/assets/'+id+'/content',headers:{...readHeaders(cookieFrom(f.paired)),...headers}},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,bytes:Buffer.concat(chunks)}));res.on('error',reject);});req.on('error',reject);req.end();});}
export const layer=(assetId,extra={})=>({assetId,transform:[1,0,0,1,0,0],opacity:1,mask:null,...extra});
