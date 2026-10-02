import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setup,call,mutationHeaders} from '../protocol/helpers.mjs';
import {digest,operate,envelope,terminal,binary,importRaster} from '../raster/helpers.mjs';
import {encode} from '../store/helpers.mjs';
import {openWriter} from '../../dist/local/server/storage/writer.js';
import {chunk,PNG_SIGNATURE} from '../../dist/local/server/raster/png.js';
import {rasterImportCancellation} from '../../dist/local/src/protocol/raster-import.js';
const pathFor=(root,ref)=>join(root,'objects','sha256',ref.hash.slice(7,9),ref.hash.slice(7));
function owner(t){const work=[];t.after(async()=>{const errors=[];for(const close of work.reverse())try{await close();}catch(e){errors.push(e);}if(errors.length)throw new AggregateError(errors,'Import fixture cleanup');});return {after:close=>work.push(close)};}
function oversized(){const header=Buffer.alloc(13);header.writeUInt32BE(8193);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;return Buffer.concat([PNG_SIGNATURE,chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc(8193*4+1))),chunk('IEND',Buffer.alloc(0))]);}
async function original(f){const bytes=oversized(),stagingId=randomUUID();assert.equal((await f.post('/api/v1/assets/staging',{protocolVersion:1,stagingId,purpose:'image',expectedBytes:String(bytes.length),sha256:digest(bytes),mediaType:'image/png'})).status,201);const upload=await call(f.server.origin,'/api/v1/assets/staging/'+stagingId,{method:'PUT',raw:bytes,headers:{...mutationHeaders(f.server,f.paired),'Content-Type':'application/octet-stream','Upload-Offset':'0'}});assert.equal(upload.status,200,upload.text);const result=await operate(f,{type:'FinalizeStaging',stagingId,expectedSha256:digest(bytes)});return {bytes,asset:result.event.payload.asset};}
test('oversized inspection preserves original and only an available explicitly approved derivation may prepare',async t=>{
 const own=owner(t),f=await setup(own),input=await original(f),inspected=await operate(f,{type:'InspectRasterOriginal',assetId:input.asset.id});assert.equal(inspected.event.type,'RasterImportInspectionPrepared');const got=await f.read('/api/v1/assets/raster-import-inspections/'+inspected.event.payload.inspectionId);assert.equal(got.status,200,got.text);const view=got.json;assert.deepEqual(view.encoded,{width:8193,height:1});assert.equal(view.samplesValidated,false);assert.deepEqual(view.original,input.asset.blob);assert.equal(view.inspectionHash,inspected.event.payload.inspectionHash);
 const plan={inspectionId:view.inspectionId,inspectionHash:'sha256:'+'f'.repeat(64),operation:{kind:'crop',x:8191,y:0,width:2,height:1}},bad=envelope(f,{type:'PrepareRaster',assetId:input.asset.id,importPlan:plan});const rejected=await terminal(f,bad);assert.equal(rejected.json.receipt.status,'rejected');assert.equal(rejected.json.receipt.code,'STALE_REVISION');assert.deepEqual((await terminal(f,bad)).json.receipt,rejected.json.receipt);
 const absent=envelope(f,{type:'PrepareRaster',assetId:input.asset.id,importPlan:{...plan,inspectionId:'missing-inspection',inspectionHash:view.inspectionHash}});assert.equal((await terminal(f,absent)).json.receipt.status,'rejected');
 assert.equal(input.asset.qualification,'pending-decoder');assert.equal(input.asset.safety,'unknown');const withheld=await binary(f,input.asset.id);assert.equal(withheld.status,403);assert.equal(JSON.parse(withheld.bytes.toString('utf8')).error.code,'CONTENT_WITHHELD');assert.deepEqual(await readFile(pathFor(f.root,input.asset.blob)),input.bytes);
 const canceled=await f.post('/api/v1/commands/'+inspected.command.command.commandId+'/cancel-raster-import',{protocolVersion:1});assert.equal(canceled.status,200,canceled.text);rasterImportCancellation(canceled.json,inspected.command.command.commandId);assert.equal(canceled.json.status,'completed');assert.deepEqual(canceled.json.receipt,inspected.receipt);
 assert.equal((await f.post('/api/v1/commands/missing/cancel-raster-import',{protocolVersion:1})).status,404);assert.equal((await f.post('/api/v1/commands/'+bad.command.commandId+'/cancel-raster-import',{protocolVersion:1,extra:true})).status,400);
});
test('exact queued import cancellation works with both real IO readers held, survives restart, and does not alter retained source',async t=>{
 const own=owner(t),f=await setup(own),input=await original(f),readable=await importRaster(f,'hidden-alpha.png');await f.server.close();let w=await openWriter({root:f.root});own.after(async()=>{if(w.available)await w.close();});await w.protocolDefaults();
 const auth={clientId:f.paired.json.clientId,sessionHash:'c'.repeat(64),now:Date.now(),expires:Date.now()+1800000},handles=[await w.assetVerify(readable.asset.id),await w.assetVerify(readable.asset.id)];own.after(async()=>{if(w.available)for(const h of handles.splice(0))await w.assetRelease(h.handle);});
 await w.rememberClient(auth.sessionHash,auth.clientId,auth.expires);const c=envelope(f,{type:'InspectRasterOriginal',assetId:input.asset.id});assert.equal(await w.rasterCommand(encode(c),auth),null);await assert.rejects(w.cancelRasterImport(c.command.commandId,{...auth,clientId:'other'}),{code:'OWNER_REQUIRED'});
 await assert.rejects(w.cancelRasterImport(c.command.commandId,{...auth,sessionHash:'d'.repeat(64)}),{code:'OWNER_REQUIRED'});const result=await w.cancelRasterImport(c.command.commandId,auth);rasterImportCancellation(result,c.command.commandId);assert.equal(result.status,'canceled');assert.deepEqual(await w.rasterCommand(encode(c),auth),result.receipt);for(const h of handles.splice(0))await w.assetRelease(h.handle);
 assert.deepEqual(await readFile(pathFor(f.root,input.asset.blob)),input.bytes);await w.close();w=await openWriter({root:f.root});await w.protocolDefaults();assert.deepEqual(await w.cancelRasterImport(c.command.commandId,auth),result);assert.equal((await w.commandState(c.command.commandId)).pending,null);
});
