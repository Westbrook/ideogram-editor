import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openWriter} from '../../dist/local/server/storage/writer.js';
import {startLocalServer} from '../../dist/local/server/http.js';
import {pair,call,cookieFrom,readHeaders,mutationHeaders} from '../../tests/session/helpers.mjs';
import {command,expectedBytes,refFor} from '../../tests/store/helpers.mjs';
import {terminal,importRaster,operate,binary} from '../../tests/raster/helpers.mjs';
import {upload,workspace,doc,edit,copy,preview} from '../../tests/portable/helpers.mjs';
const root=fileURLToPath(new URL('../../artifacts/p1c3-correction/independent-mask-authority-v3/',import.meta.url));
await mkdir(root,{mode:0o700});
async function fixture(name){const dir=join(root,name);await mkdir(dir,{mode:0o700});const w=await openWriter({root:dir});const ref=await w.putObject([expectedBytes],refFor(expectedBytes),w.epoch);await w.close();const server=await startLocalServer({root:dir});const paired=await pair(server);return {root:dir,server,paired,read:p=>call(server.origin,p,{headers:readHeaders(cookieFrom(paired))}),post:(p,b)=>call(server.origin,p,{method:'POST',body:b,headers:mutationHeaders(server,paired)}),command:(patch={},body={})=>command(ref,{clientId:paired.json.clientId,...patch},body)};}
const results=[];
for(const name of ['matching','opposite-mask','wrong-caption-layer-version','stale-generation','missing-effective','corrupt-hard']){
 const f=await fixture(name);const record={name,start:new Date().toISOString()};
 try{
  await terminal(f,f.command({}, {width:3,height:2}));const {asset,input}=await importRaster(f,'hidden-alpha.png');await edit(f,{type:'ImportAsset',assetId:asset.id,layerId:'picture',name:'Original',draft:null});
  const before=await doc(f),plan={width:3,height:2,feather:0,operations:[{kind:'clear'}]},value={schema:'local-mask-1',layerVersion:name==='wrong-caption-layer-version'?'999':'1',radius:'0',plan};
  const raw=Buffer.from(JSON.stringify(value)),stage=await upload(f,raw,'caption','text/plain'),caption=(await workspace(f,{type:'FinalizeStaging',stagingId:stage.stagingId,expectedSha256:stage.sha256})).event.payload.asset;
  const draft={id:'mask-draft',generation:'1',kind:'mask',documentId:before.id,targetLayerId:'picture',expectedDocumentRevision:before.revision,assetId:caption.id,composing:false};
  const saved=await f.post('/api/v1/ui/mask-session',{protocolVersion:1,requestId:randomUUID(),sessionId:'mask-session',expectedUISeq:'0',body:{type:'SaveDraft',draft}});assert.equal(saved.json.status,'accepted',saved.text);
  const preparedPlan=name==='opposite-mask'?{...plan,operations:[{kind:'fill'}]}:plan;
  const mask=(await operate(f,{type:'PrepareMask',plan:preparedPlan})).event.payload.asset;
  if(name==='missing-effective'||name==='corrupt-hard'){
   const manifest=(await f.read('/api/v1/assets/'+mask.id+'/raster')).json;const ref=manifest.plan[name==='missing-effective'?'effective':'hard'];const path=join(f.root,'objects','sha256',ref.hash.slice(7,9),ref.hash.slice(7));record.changedDependency={ref,mode:name};
   if(name==='missing-effective')await unlink(path);else {const bytes=await readFile(path);bytes[0]^=1;await writeFile(path,bytes);}
  }
  const request=f.command({expectedDocumentRevision:before.revision,body:{type:'SetLayerProperties',layerId:'picture',layerVersion:'1',properties:{mask:{assetId:mask.id,mapping:'document-r16-v1',inverted:false}},draft:{sessionId:'mask-session',draftId:draft.id,generation:name==='stale-generation'?'0':'1'}}});
  const result=await terminal(f,request),after=await doc(f),ui=(await f.read('/api/v1/ui/mask-session')).json;
  Object.assign(record,{expectedStatus:name==='matching'?'accepted':'rejected',actualStatus:result.json.receipt.status,receipt:result.json.receipt,request,savedDraft:draft,savedCaption:value,preparedPlan,mask,before,after,ui,original:input.blob});
  record.pass=record.actualStatus===record.expectedStatus;
  if(name==='opposite-mask'&&record.actualStatus==='accepted'){
   const bundle=await copy(f);await writeFile(join(root,'opposite-mask-accepted.pf4'),bundle.bytes,{mode:0o600});const reviewed=(await preview(f,bundle.bytes)).review;record.acceptedCopy={blob:bundle.bundle.blob,editable:reviewed.editable,format:reviewed.formatVersion};
  }
 }catch(error){record.error={message:error.message,stack:error.stack};record.pass=false;}
 finally{await f.server.close();record.end=new Date().toISOString();await writeFile(join(root,name+'.json'),JSON.stringify(record,null,2)+'\n');results.push(record);console.log(JSON.stringify({name,expected:record.expectedStatus,actual:record.actualStatus,pass:record.pass,error:record.error?.message,revision:[record.before?.revision,record.after?.revision],draftStatus:record.ui?.drafts?.[0]?.status}));}
}
await writeFile(join(root,'results.json'),JSON.stringify(results,null,2)+'\n');
process.exitCode=results.every(r=>r.pass)?0:1;
