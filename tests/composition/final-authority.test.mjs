import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {setup,terminal,upload,workspace,edit,doc} from '../portable/helpers.mjs';
import {importRaster} from '../raster/helpers.mjs';
import {emptyComposition,emptyElement,linkField} from '../../dist/local/src/composition/core.js';
import {canonical} from '../../dist/local/src/protocol/json.js';
import {openWriter} from '../../dist/local/server/storage/writer.js';
async function body(f,c,bindings,type){const s=await upload(f,Buffer.from(canonical(c)),'text','application/octet-stream'),a=(await workspace(f,{type:'FinalizeStaging',stagingId:s.stagingId,expectedSha256:s.sha256})).event.payload.asset;return {type,composition:{id:c.id,value:{...a.blob,mediaType:'application/json'},bindings},draft:null};}
async function done(w,id){for(let i=0;i<2000;i++){const s=await w.commandState(id);if(s.record)return s.record;if(s.pending?.phase==='waiting-for-resources')return {receipt:null,pending:s.pending};await new Promise(r=>setTimeout(r,5));}throw Error('No receipt');}
const release=g=>{Atomics.store(new Int32Array(g),0,1);Atomics.notify(new Int32Array(g),0);};
for(const type of ['AddSemanticElement','ReorderSemanticElement'])test(type+' fences a late coherent same-revision source-document replacement',async t=>{
 const f=await setup(t);await terminal(f,f.command({}, {width:3,height:2}));const {asset}=await importRaster(f,'hidden-alpha.png');for(const layerId of ['first','second'])await edit(f,{type:'ImportAsset',assetId:asset.id,layerId,name:layerId,draft:null});
 const d=await doc(f),v=(await f.read('/api/v1/documents/document_1/composition?revision='+d.revision)).json,c=emptyComposition(3,2,randomUUID());c.elements=[emptyElement('obj','linked'),emptyElement('obj','other')];c.elements[0].desc=linkField('appearance-description',v.layers[0]);await edit(f,await body(f,c,{first:'first'},'CommitCompositionVersion'));
 const alternative=structuredClone(c);alternative.id=randomUUID();const accepted=await edit(f,await body(f,alternative,{first:'second'},'SetSemanticBinding'));await edit(f,{type:'Undo',historyHead:accepted.document.historyHead});const before=await doc(f),next=structuredClone(c);next.id=randomUUID();if(type==='AddSemanticElement')next.elements.push(emptyElement('obj','new'));else next.elements.reverse();const command=f.command({expectedDocumentRevision:before.revision,body:await body(f,next,{first:'first'},type)});
 await f.server.close();const gate=new SharedArrayBuffer(4);let reached;const barrier=new Promise(r=>reached=r),w=await openWriter({root:f.root},{phase:'history-after-proofs',gate,onBarrier:reached});t.after(()=>w.close());const auth={clientId:f.paired.json.clientId,sessionHash:'a'.repeat(64),now:Date.now(),expires:Date.now()+1800000};
 const replacement={...accepted.document,revision:before.revision},replace=d=>{const db=new DatabaseSync(join(f.root,'metadata.sqlite'));try{db.prepare('UPDATE documents SET json=? WHERE id=?').run(canonical(d),d.id);}finally{db.close();}};
 try{await w.historyCommand(Buffer.from(JSON.stringify(command)),auth);await Promise.race([barrier,new Promise((_,rej)=>setTimeout(()=>rej(Error('Barrier timeout')),10000).unref())]);replace(replacement);}finally{release(gate);}
 const result=await done(w,command.command.commandId),after=await w.document('document_1');t.diagnostic(JSON.stringify({type,before,replacement,after,command,receipt:result.receipt,pending:result.pending??null}));assert.equal(result.receipt?.status,'rejected');assert.equal(result.receipt.code,'STALE_REVISION');assert.deepEqual(after,replacement);replace(before);assert.deepEqual(await w.historyCommand(Buffer.from(JSON.stringify(command)),auth),result.receipt);const valid=structuredClone(command);valid.command.commandId=randomUUID();valid.command.transactionId=randomUUID();await w.historyCommand(Buffer.from(JSON.stringify(valid)),auth);assert.equal((await done(w,valid.command.commandId)).receipt.status,'accepted');await w.close();
});
