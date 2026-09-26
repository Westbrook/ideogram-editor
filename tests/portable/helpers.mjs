import assert from 'node:assert/strict';
import {request} from 'node:http';
import {randomUUID} from 'node:crypto';
import {setup,call,cookieFrom,readHeaders,mutationHeaders} from '../protocol/helpers.mjs';
import {terminal,eventFor,digest} from '../raster/helpers.mjs';
export {setup,terminal,eventFor,digest};
export const doc=async(f,id='document_1')=>(await f.read('/api/v1/documents/'+id)).json.projection.value;
export async function edit(f,body,id='document_1'){const d=await doc(f,id),c=f.command({documentId:id,expectedDocumentRevision:d.revision,body}),r=await terminal(f,c);assert.equal(r.json.receipt.status,'accepted',r.text);return {command:c,receipt:r.json.receipt,document:await doc(f,id),event:await eventFor(f,r.json.receipt)};}
export async function workspace(f,body){const c=f.command({documentId:null,expectedDocumentRevision:null,body}),r=await terminal(f,c);assert.equal(r.json.receipt.status,'accepted',r.text);return {command:c,receipt:r.json.receipt,event:await eventFor(f,r.json.receipt)};}
export async function binary(f,path,headers={}){return new Promise((resolve,reject)=>{const req=request(new URL(path,f.server.origin),{headers:{...readHeaders(cookieFrom(f.paired)),...headers}},res=>{const parts=[];res.on('data',b=>parts.push(b));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,bytes:Buffer.concat(parts)}));res.on('error',reject);});req.on('error',reject);req.end();});}
export async function upload(f,bytes,purpose='bundle',mediaType='application/x-ideogram-project'){
 const s={protocolVersion:1,stagingId:randomUUID(),purpose,expectedBytes:String(bytes.length),sha256:digest(bytes),mediaType};const created=await f.post('/api/v1/assets/staging',s);assert.equal(created.status,201,created.text);
 for(let at=0;at<bytes.length;at+=1048576){const r=await call(f.server.origin,'/api/v1/assets/staging/'+s.stagingId,{method:'PUT',raw:bytes.subarray(at,at+1048576),headers:{...mutationHeaders(f.server,f.paired),'Content-Type':'application/octet-stream','Upload-Offset':String(at)}});assert.equal(r.status,200,r.text);}return s;
}
export async function copy(f,id='document_1'){const result=await edit(f,{type:'SaveCopy'},id),bundle=result.event.payload.bundle;assert.equal(bundle.status,'copy-ready');const download=await binary(f,'/api/v1/bundles/'+bundle.bundleId+'/content');assert.equal(download.status,200,download.bytes.toString());assert.equal(digest(download.bytes),bundle.blob.hash);return {...result,bundle,bytes:download.bytes};}
export async function preview(f,bytes){const stage=await upload(f,bytes);const result=await workspace(f,{type:'PreviewBundleImport',stagingId:stage.stagingId,expectedSha256:stage.sha256});const review=(await f.read('/api/v1/bundle-reviews/'+result.event.payload.reviewId)).json;return {stage,review,result};}
