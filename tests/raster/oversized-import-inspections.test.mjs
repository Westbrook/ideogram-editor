import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {RasterImportInspections} from '../../dist/local/server/storage/raster-import-inspections.js';
import {canonical,hashBytes} from '../../dist/local/server/storage/canonical.js';
const sha='sha256:'+'a'.repeat(64);
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE raster_import_inspections(id TEXT PRIMARY KEY,json TEXT NOT NULL,session_hash TEXT NOT NULL,epoch TEXT NOT NULL) STRICT');
 const auth={clientId:'clientA',sessionHash:'sessionA',now:1000,expires:100000};
 let original={id:'assetA',version:'1',purpose:'image',blob:{hash:sha,byteLength:'100',mediaType:'image/png'},dependencies:[],safety:'unknown',availability:'available',qualification:'pending-decoder',measuredMediaType:'image/png'};
 const metadata={encoded:{width:8193,height:1},orientation:1,profile:'untagged-srgb',profileHash:null,capabilities:{resize:'png-scanline-file-cp1-v1',crop:'png-scanline-file-cp1-v1',unavailableReason:null}};
 const inspections=new RasterImportInspections(db,'epochA',id=>id===original.id?original:null,(_id,client)=>{if(client!=='clientA')throw Error('OWNER_REQUIRED');},()=>{});
 const commit=(prepared,current=auth)=>{db.exec('BEGIN IMMEDIATE');try{const fact=prepared.commit(current);db.exec('COMMIT');return fact;}catch(e){db.exec('ROLLBACK');throw e;}};
 const make=()=>{const prepared=inspections.prepare('inspectionA','assetA',metadata,auth);commit(prepared);return prepared.inspection;};
 return {db,auth,metadata,inspections,commit,make,replace:value=>{original=value;},original:()=>original};
}
test('canonical inspection records retain exact original and explicit approved crop',t=>{
 const f=fixture(t),inspection=f.make(),plan={inspectionId:inspection.inspectionId,inspectionHash:inspection.inspectionHash,operation:{kind:'crop',x:8191,y:0,width:2,height:1}};
 assert.deepEqual(f.inspections.authorize('assetA',plan,f.auth),inspection);assert.deepEqual(inspection.original,f.original().blob);assert.equal(inspection.samplesValidated,false);
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM raster_import_inspections').get().n,1);
});
test('owner, session, epoch and expiry cannot be borrowed from another inspection',t=>{
 const f=fixture(t);f.make();for(const auth of [{...f.auth,clientId:'other'},{...f.auth,sessionHash:'other'},{...f.auth,now:f.auth.expires}])assert.throws(()=>f.inspections.read('inspectionA',auth));
 const restarted=new RasterImportInspections(f.db,'epochB',()=>f.original(),()=>{},()=>{});assert.throws(()=>restarted.read('inspectionA',f.auth),/REVIEW_EXPIRED/);
});
test('inspection publication rechecks source and durable transaction and snapshots returned metadata',t=>{
 const f=fixture(t),p=f.inspections.prepare('inspectionA','assetA',f.metadata,f.auth),expected=structuredClone(p.inspection);
 assert.throws(()=>p.commit(f.auth),/CORRUPT_STORE/);p.inspection.encoded.width=1;p.inspection.inspectionHash=sha;p.inspection.expiresAt='2099-01-01';f.commit(p);
 assert.deepEqual(f.inspections.read('inspectionA',f.auth),expected);
 const next=f.inspections.prepare('inspectionB','assetA',f.metadata,f.auth);f.replace({...f.original(),version:'2'});assert.throws(()=>f.commit(next),/RASTER_ORIGINAL_CHANGED/);
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM raster_import_inspections').get().n,1);
});
test('changed source, altered hash, out-of-bounds crop and unavailable transport cannot authorize',t=>{
 const f=fixture(t),i=f.make(),plan={inspectionId:i.inspectionId,inspectionHash:i.inspectionHash,operation:{kind:'crop',x:8191,y:0,width:2,height:1}};
 assert.throws(()=>f.inspections.authorize('assetA',{...plan,inspectionHash:'sha256:'+'b'.repeat(64)},f.auth));
 assert.throws(()=>f.inspections.authorize('assetA',{...plan,operation:{...plan.operation,x:8192}},f.auth),/RASTER_IMPORT_PLAN_INVALID/);
 f.replace({...f.original(),version:'2'});assert.throws(()=>f.inspections.authorize('assetA',plan,f.auth),/RASTER_ORIGINAL_CHANGED/);
 const blocked={...i,capabilities:{resize:null,crop:null,unavailableReason:'BOUNDED_DECODER_UNAVAILABLE'},assetVersion:'2'};delete blocked.inspectionHash;blocked.inspectionHash=hashBytes(canonical(blocked));f.db.prepare('UPDATE raster_import_inspections SET json=?').run(canonical(blocked));
 assert.throws(()=>f.inspections.authorize('assetA',{...plan,inspectionHash:blocked.inspectionHash},f.auth),/BOUNDED_DECODER_UNAVAILABLE/);
});
test('stored inspection hash, canonical JSON and bounded record size are checked on every read',t=>{
 const f=fixture(t),i=f.make();for(const value of [JSON.stringify(i),canonical({...i,encoded:{width:9000,height:1}}),' '.repeat(65537)]){f.db.prepare('UPDATE raster_import_inspections SET json=?').run(value);assert.throws(()=>f.inspections.read('inspectionA',f.auth),/CORRUPT_STORE/);}
});
