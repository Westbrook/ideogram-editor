import {mkdir,unlink} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {openWriter} from './source/dist/local/server/storage/writer.js';
import {encode} from './source/tests/store/helpers.mjs';
import {fixture,assert,importPNG,terminal,operate,doc,edit,state,saveDraft,writeFile,join,readFile,objectPath} from './review-fixture-v2.mjs';
const out=new URL('./independent-late-baseline-v1/',import.meta.url);await mkdir(out,{mode:0o700});const results=[];
for(const mode of ['history-baseline-record','raster-baseline-record','raster-baseline-hard-replacement']){
 const f=await fixture(new URL(mode+'/',out).pathname),row={mode,start:new Date().toISOString()};let w,gate;
 try{
  await terminal(f,f.command({}, {width:3,height:2}));const image=await importPNG(f,Array.from({length:6},()=>[255,0,0,255]).flat(),3,2);await edit(f,{type:'ImportAsset',assetId:image.asset.id,layerId:'picture',name:'Review',draft:null});
  const a=(await operate(f,{type:'PrepareMask',plan:{width:3,height:2,feather:2,operations:[{kind:'fill'}]}})).event.payload.asset,b=(await operate(f,{type:'PrepareMask',plan:{width:3,height:2,feather:2,operations:[{kind:'clear'}]}})).event.payload.asset,m=(await f.read('/api/v1/assets/'+a.id+'/raster')).json;
  await edit(f,{type:'SetLayerProperties',layerId:'picture',layerVersion:'1',properties:{mask:{assetId:a.id,mapping:'document-r16-v1',inverted:false}},draft:null});await edit(f,{type:'CropDocument',x:1,y:0,width:2,height:2,draft:null});
  const layer=(await state(f)).layers[0],plan={schemaVersion:2,width:2,height:2,feather:0,operations:[{kind:'retained-hard-v1',mask:layer.mask,hard:m.plan.hard}]},value={schema:'local-mask-2',layerVersion:layer.version,radius:'0',plan},saved=await saveDraft(f,value),before=await doc(f),ui=(await f.read('/api/v1/ui/'+saved.session)).json;assert.equal(saved.result.json.status,'accepted');
  const isHistory=mode.startsWith('history'),prepared=isHistory?(await operate(f,{type:'PrepareMask',plan})).event.payload.asset:null;
  await f.server.close();gate=new SharedArrayBuffer(4);let hit;const reached=new Promise(r=>hit=r),phase=isHistory?'history-after-proofs':'raster-before-register';
  w=await openWriter({root:f.root},{phase,gate,onBarrier:hit});const auth={clientId:f.paired.json.clientId,sessionHash:'e'.repeat(64),now:Date.now(),expires:Date.now()+1800000};
  const c=isHistory?f.command({expectedDocumentRevision:before.revision,body:{type:'SetLayerProperties',layerId:'picture',layerVersion:layer.version,properties:{mask:{assetId:prepared.id,mapping:'document-r16-v1',inverted:false}},draft:saved.fence}}):f.command({documentId:null,expectedDocumentRevision:null,body:{type:'PrepareMask',plan}});
  await w[isHistory?'historyCommand':'rasterCommand'](encode(c),auth);
  const timer=setTimeout(()=>{throw Error('late baseline barrier did not arrive')},15000);await reached;clearTimeout(timer);row.barrier=phase;row.barrierAt=new Date().toISOString();
  if(mode.endsWith('hard-replacement')){const p=objectPath(f.root,m.plan.hard),bytes=await readFile(p);await unlink(p);await writeFile(p,bytes,{mode:0o600});}
  else{const replacement={...b,id:a.id};const db=new DatabaseSync(join(f.root,'metadata.sqlite'));db.prepare('UPDATE assets SET json=? WHERE id=?').run(JSON.stringify(replacement),a.id);db.close();row.replacedAsset={original:a,replacement};}
  Atomics.store(new Int32Array(gate),0,1);Atomics.notify(new Int32Array(gate),0);gate=null;
  let result;for(let i=0;i<1500;i++){result=await w.commandState(c.command.commandId);if(result.record)break;await new Promise(r=>setTimeout(r,5));}
  row.command=c;row.record=result?.record??null;row.diagnostics=await w.diagnostics();row.before=before;row.after=await w.document('document_1');row.rawUIBefore=ui;row.rawUIAfter=await w.uiRead(saved.session,auth);
  row.refused=result?.record?.receipt.status==='rejected'||!result?.record;assert.deepEqual(row.after,before);assert.deepEqual(row.rawUIAfter,ui);assert(row.refused,'Final preparation accepted after exact baseline dependency replacement');
  row.pass=true;
 }catch(e){row.pass=false;row.error={message:e.message,stack:e.stack};}finally{if(gate){Atomics.store(new Int32Array(gate),0,1);Atomics.notify(new Int32Array(gate),0);}if(w)await w.close();else await f.server.close();row.end=new Date().toISOString();results.push(row);await writeFile(new URL(mode+'.json',out),JSON.stringify(row,null,2)+'\n');console.log(JSON.stringify({mode,pass:row.pass,status:row.record?.receipt?.status,error:row.error?.message}));}
}
await writeFile(new URL('results.json',out),JSON.stringify(results,null,2)+'\n');process.exitCode=results.every(x=>x.pass)?0:1;
