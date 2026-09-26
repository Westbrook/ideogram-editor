import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {setup} from '../protocol/helpers.mjs';
import {importRaster,terminal} from '../raster/helpers.mjs';
import {rootFor} from '../store/helpers.mjs';
import {openWriter} from '../../dist/local/server/storage/writer.js';
import {canonical} from '../../dist/local/server/storage/canonical.js';
const doc=async f=>(await f.read('/api/v1/documents/document_1')).json.projection.value;
async function edit(f,body){const d=await doc(f);const c=f.command({expectedDocumentRevision:d.revision,body}),r=await terminal(f,c);assert.equal(r.json.receipt.status,'accepted',r.text);return doc(f);}
function applyPatch(state,patch){const result=structuredClone(state);if(patch.dimensions)Object.assign(result,patch.dimensions);for(const change of patch.layers){const index=result.layers.findIndex(l=>l.id===change.id);if(change.value===null){assert(index>=0);result.layers.splice(index,1);}else if(index>=0)result.layers[index]=change.value;else result.layers.push(change.value);}if(patch.order)result.layers=patch.order.map(id=>{const value=result.layers.find(l=>l.id===id);assert(value);return value;});return result;}
test('independent semantic patches and complete retained graph match all branches/checkpoints, pure restart/undo/redo cannot launch raster or network effects',async t=>{
 const f=await setup(t);await terminal(f,f.command({}, {width:3,height:2}));const a=await importRaster(f,'hidden-alpha.png');
 const imported=await edit(f,{type:'ImportAsset',assetId:a.asset.id,layerId:'picture',name:'Picture',draft:null});
 const moved=await edit(f,{type:'ApplyTransform',layerId:'picture',layerVersion:'1',transform:[1,0,0,1,1,0],draft:null});
 await edit(f,{type:'Undo',historyHead:moved.historyHead});const branch=await edit(f,{type:'SetLayerProperties',layerId:'picture',layerVersion:'1',properties:{visible:false},draft:null});
 await edit(f,{type:'DeleteLayer',layerId:'picture',layerVersion:'2',draft:null});await edit(f,{type:'SaveCheckpoint',name:'Deleted but retained'});
 await edit(f,{type:'SwitchBranch',branchId:moved.branchId,historyNode:moved.historyHead});const before=await doc(f);await f.server.close();
 const w=await openWriter({root:f.root});
 const required=new Set(),assetIds=new Set();const read=async ref=>{required.add(ref.hash);return JSON.parse(Buffer.from(await w.readMetadata(ref)));};
 const protect=async id=>{if(assetIds.has(id))return;assetIds.add(id);const a=(await w.assetProjection(id)).asset;assert(a);for(const ref of [a.blob,...a.dependencies])required.add(ref.hash);if(a.raster){const m=await w.rasterManifest(id);for(const ref of m.dependencies)required.add(ref.hash);for(const child of a.raster.sourceAssetIds)await protect(child);}};
 let cursor='';for(;;){const page=await w.historyPage('document_1',cursor,'history');for(const node of page.items){if(node.kind!=='image-edit'){for(const ref of node.roots)required.add(ref.hash);continue;}
  const prior=await read(node.before.state),next=await read(node.after.state),forward=await read(node.forward),inverse=await read(node.inverse);assert.deepEqual(applyPatch(prior,forward),next);assert.deepEqual(applyPatch(next,inverse),prior);
  for(const s of [prior,next])for(const l of s.layers){await protect(l.assetId);if(l.mask)await protect(l.mask.assetId);}for(const v of [node.before,node.after])if(v.compositeAssetId)await protect(v.compositeAssetId);
 }if(!page.next)break;cursor=page.next;}
 const closure=new Set();cursor='';for(;;){const p=await w.historyClosure('document_1',cursor);for(const ref of p.items)closure.add(ref.hash);if(!p.next)break;cursor=p.next;}
 for(const hash of required)assert(closure.has(hash),'Required retained root absent: '+hash);assert(required.size>15);assert(assetIds.has(a.input.id));
 assert.deepEqual(await w.document('document_1'),before);await w.close();
 const dir=await rootFor(t),script=join(dir,'replay.mjs');await writeFile(script,`
 import {openWriter} from ${JSON.stringify(new URL('../../dist/local/server/storage/writer.js',import.meta.url).href)};
 import {command,encode} from ${JSON.stringify(new URL('../store/helpers.mjs',import.meta.url).href)};
 const w=await openWriter({root:process.argv[2]}),ref=JSON.parse(process.argv[3]),auth={clientId:'client_1',sessionHash:'c'.repeat(64),now:Date.now(),expires:Date.now()+1800000};
 async function run(body){const d=await w.document('document_1'),c=command(ref,{expectedDocumentRevision:d.revision,body});await w.historyCommand(encode(c),auth);for(let i=0;i<1000;i++){const r=await w.commandState(c.command.commandId);if(r.record){if(r.record.receipt.status!=='accepted')throw Error(JSON.stringify(r));return w.document('document_1');}await new Promise(r=>setTimeout(r,5));}throw Error('Navigation did not complete');}
 const initial=await w.document('document_1'),undo=await run({type:'Undo',historyHead:initial.historyHead}),redo=await run({type:'Redo',historyNode:initial.historyHead});
 console.log(JSON.stringify({initial,undo,redo,effects:globalThis.__storeNetworkCounters.read()}));await w.close();
 `);
 const result=JSON.parse(execFileSync(process.execPath,['--import',resolve('tests/store/no-network.mjs'),'--import',resolve('tests/history/no-raster.mjs'),script,f.root,JSON.stringify(f.ref)],{encoding:'utf8'}));
 assert.deepEqual(result.initial,before);assert.equal(result.undo.image.compositeAssetId,imported.image.compositeAssetId);assert.equal(result.redo.image.compositeAssetId,moved.image.compositeAssetId);assert(Object.values(result.effects).every(n=>n===0));
 // Removing acceleration only, in an isolated root, must leave pure full-log replay equal.
 const db=new DatabaseSync(join(f.root,'metadata.sqlite'));db.exec('DELETE FROM snapshot_roots; DELETE FROM snapshots');db.close();
 const replay=await openWriter({root:f.root});assert.deepEqual(await replay.document('document_1'),result.redo);await replay.close();
 t.diagnostic(JSON.stringify({requiredRootCount:required.size,retainedAssetCount:assetIds.size,retainedClosureCount:closure.size,originalHash:a.input.blob.hash,branchHead:branch.historyHead,zeroEffects:result.effects}));
});
