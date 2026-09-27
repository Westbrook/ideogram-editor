import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import sharp from './source/node_modules/sharp/dist/index.mjs';
import {openWriter} from './source/dist/local/server/storage/writer.js';
import {startLocalServer} from './source/dist/local/server/http.js';
import {pair,call,cookieFrom,readHeaders,mutationHeaders} from './source/tests/session/helpers.mjs';
import {command,expectedBytes,refFor} from './source/tests/store/helpers.mjs';
import {terminal,operate} from './source/tests/raster/helpers.mjs';
import {upload,workspace,doc,edit,copy,preview,binary} from './source/tests/portable/helpers.mjs';
export {assert,sharp,terminal,operate,upload,workspace,doc,edit,copy,preview,binary,readFile,writeFile,join,randomUUID};
export const objectPath=(root,ref)=>join(root,'objects','sha256',ref.hash.slice(7,9),ref.hash.slice(7));
export async function fixture(root){await mkdir(root,{mode:0o700});const w=await openWriter({root});const ref=await w.putObject([expectedBytes],refFor(expectedBytes),w.epoch);await w.close();const server=await startLocalServer({root}),paired=await pair(server);return {root,server,paired,read:p=>call(server.origin,p,{headers:readHeaders(cookieFrom(paired))}),post:(p,b)=>call(server.origin,p,{method:'POST',body:b,headers:mutationHeaders(server,paired)}),command:(patch={},body={})=>command(ref,{clientId:paired.json.clientId,...patch},body)};}
export async function importPNG(f,rgba,width,height){const bytes=await sharp(Buffer.from(rgba),{raw:{width,height,channels:4}}).png().toBuffer();const st=await upload(f,bytes,'image','image/png'),original=(await operate(f,{type:'FinalizeStaging',stagingId:st.stagingId,expectedSha256:st.sha256})).event.payload.asset;const p=(await operate(f,{type:'PrepareRaster',assetId:original.id})).event.payload.asset,q=await operate(f,{type:'ReviewRaster',assetId:p.id}),rv=(await f.read('/api/v1/assets/raster-reviews/'+q.event.payload.reviewId)).json,a=(await operate(f,{type:'ApproveRaster',assetId:p.id,reviewId:rv.reviewId,reviewHash:rv.reviewHash})).event.payload.asset;return {original,asset:a,bytes};}
export const state=async(f,id='document_1')=>(await f.read('/api/v1/documents/'+id+'/image')).json;
export const pixels=async(f,id)=>[...await sharp((await binary(f,'/api/v1/assets/'+id+'/content')).bytes).ensureAlpha().raw().toBuffer()];
export async function saveDraft(f,value,{kind='mask',id='review-draft',documentId='document_1',layerId='picture',session='review-mask'}={}){const raw=Buffer.from(JSON.stringify(value)),st=await upload(f,raw,'caption','text/plain'),caption=(await workspace(f,{type:'FinalizeStaging',stagingId:st.stagingId,expectedSha256:st.sha256})).event.payload.asset,d=await doc(f,documentId),ui=(await f.read('/api/v1/ui/'+session)).json;const draft={id,generation:'1',kind,documentId,targetLayerId:layerId,expectedDocumentRevision:d.revision,assetId:caption.id,composing:false};const result=await f.post('/api/v1/ui/'+session,{protocolVersion:1,requestId:randomUUID(),sessionId:session,expectedUISeq:ui.uiSeq,body:{type:'SaveDraft',draft}});return {raw,caption,draft,result,session,fence:{sessionId:session,draftId:id,generation:'1'}};}
