import {writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {setup} from '../../tests/protocol/helpers.mjs';
import {importRaster,terminal} from '../../tests/raster/helpers.mjs';
import {openWriter} from '../../dist/local/server/storage/writer.js';
const cleanup=[],f=await setup({after:fn=>cleanup.push(fn)}),http=[],writer=[];
const facts={at:new Date().toISOString(),qualification:false,root:f.root,limits:'Serial tiny 3x2 fixture on this host, without exclusive-host qualification. Full HTTP clocks include preparation and polling. Writer append is a separate subclock. No UI paint, supported-envelope, R20/R21/R22/R23/R31 or memory qualification.',targets:{R20TargetMs:20,R20CeilingMs:50},http,writer};
try{
 await terminal(f,f.command({}, {width:3,height:2}));const asset=await importRaster(f,'hidden-alpha.png');
 await terminal(f,f.command({expectedDocumentRevision:'1',body:{type:'ImportAsset',assetId:asset.asset.id,layerId:'picture',name:'Picture',draft:null}}));
 for(let i=0;i<20;i++){
  const d=(await f.read('/api/v1/documents/document_1')).json.projection.value,s=(await f.read('/api/v1/documents/document_1/image')).json;
  const c=f.command({expectedDocumentRevision:d.revision,body:{type:'SetLayerProperties',layerId:'picture',layerVersion:s.layers[0].version,properties:{name:'HTTP observation '+i},draft:null}});
  const start=performance.now();let r=await f.post('/api/v1/commands',c);const admissionMs=performance.now()-start,admissionStatus=r.status;
  for(let n=0;r.status===202&&n<1000;n++){await new Promise(r=>setTimeout(r,2));r=await f.read('/api/v1/commands/'+c.command.commandId);}
  assert.equal(r.json.receipt.status,'accepted');http.push({commandId:c.command.commandId,admissionStatus,admissionMs,fullReceiptMs:performance.now()-start});
 }
 await f.server.close();const w=await openWriter({root:f.root});
 try{
  const auth={clientId:f.paired.json.clientId,sessionHash:'observation',now:Date.now(),expires:Date.now()+1800000};
  for(let i=0;i<20;i++){
   const d=await w.document('document_1'),s=await w.imageState('document_1'),c=f.command({expectedDocumentRevision:d.revision,body:{type:'SetLayerProperties',layerId:'picture',layerVersion:s.layers[0].version,properties:{name:'Writer observation '+i},draft:null}});
   const start=performance.now();await w.historyCommand(Buffer.from(JSON.stringify(c)),auth);let r;
   for(let n=0;n<1000;n++){r=await w.commandState(c.command.commandId);if(r.record)break;await new Promise(r=>setTimeout(r,2));}
   assert.equal(r.record.receipt.status,'accepted');writer.push({commandId:c.command.commandId,fullReceiptMs:performance.now()-start});
  }
  facts.diagnostics=await w.diagnostics();
 }finally{await w.close();}
 facts.summary={httpAdmissionMaxMs:Math.max(...http.map(x=>x.admissionMs)),httpFullReceiptMaxMs:Math.max(...http.map(x=>x.fullReceiptMs)),httpFullOver50:http.filter(x=>x.fullReceiptMs>50).length,writerFullReceiptMaxMs:Math.max(...writer.map(x=>x.fullReceiptMs)),appendMaxMs:Math.max(...facts.diagnostics.observations.appendMs)};
 facts.status='passed';console.log(JSON.stringify(facts.summary));
}catch(error){facts.status='failed';facts.error=String(error);throw error;}
finally{await writeFile('evidence/p1b5/observations.json',JSON.stringify(facts,null,2)+'\n');for(const close of cleanup.reverse())await close();}
