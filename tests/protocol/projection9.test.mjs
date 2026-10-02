import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {RecoveryStore} from '../../dist/local/server/storage/recovery.js';
import {canonical} from '../../dist/local/src/protocol/json.js';
import {projectionEntity,projectionEvent,supportsProjectionSchema} from '../../dist/local/src/protocol/projection-schema.js';
import {fixture,snapshot,previewEvent,derivedAsset} from './projection9-fixtures.mjs';

for(const schema of [2,3,4,5,6,7,8])test('LP'+schema+' accepts exact old shapes and rejects directly visible LP9 additions',()=>{
 const old=fixture(),current=fixture(true);assert.equal(projectionEntity(schema,'document',old.document),'1');assert.equal(projectionEntity(schema,'history',old.history),'1');assert.doesNotThrow(()=>projectionEvent(schema,old.created));assert.doesNotThrow(()=>projectionEvent(schema,previewEvent()));
 assert.throws(()=>projectionEntity(schema,'document',current.document));assert.throws(()=>projectionEntity(schema,'history',current.history));assert.throws(()=>projectionEvent(schema,current.created));assert.throws(()=>projectionEvent(schema,previewEvent(true)));assert.throws(()=>projectionEntity(schema,'asset',derivedAsset()));
 // Semantic text is not a typed marker and never implies a schema upgrade.
 const named=structuredClone(old.checkpoint);named.payload.checkpoint.name='Document.metadata derived request-text-treatment-1';assert.doesNotThrow(()=>projectionEvent(schema,named));
});
test('LP9 admits current typed metadata, text treatment and derived raster roles; future/invalid versions fail',()=>{
 const current=fixture(true);assert.equal(projectionEntity(9,'document',current.document),'1');assert.equal(projectionEntity(9,'history',current.history),'1');assert.doesNotThrow(()=>projectionEvent(9,current.created));assert.doesNotThrow(()=>projectionEvent(9,previewEvent(true)));assert.equal(projectionEntity(9,'asset',derivedAsset()),'1');
 for(const schema of [undefined,null,'9',1,10,99,NaN,Infinity]){assert.equal(supportsProjectionSchema(schema),false);assert.throws(()=>projectionEntity(schema,'document',fixture().document));assert.throws(()=>projectionEvent(schema,fixture().created));}
 const malformed=structuredClone(current.document);malformed.metadata.name=42;assert.throws(()=>projectionEntity(9,'document',malformed));
});

// Invoke the actual persisted JSONL decoder with independently sealed fixture rows.
// The fake DB supplies only the descriptor's external integrity authorities.
function decodeSnapshot(s){
 const projectionHash=createHash('sha256');for(const row of s.rows.slice(1)){const text=Buffer.from(row.utf8Base64,'base64').toString();projectionHash.update(canonical({type:row.entityType,id:row.entityId,version:row.entityVersion,text})+'\n');}
 const hash=projectionHash.digest('hex'),applied=[],receiver={rootsHash:()=> 'roots',db:{prepare:sql=>({get:()=>sql.includes('roots_hash')?{roots_hash:'roots'}:{projection_hash:hash}})},*lines(){yield* s.rows;}};
 RecoveryStore.prototype.validateSnapshot.call(receiver,{id:'snapshot',seq:'1',content:s.descriptor.content},(type,id,text)=>applied.push({type,id,value:JSON.parse(text)}));return applied;
}
for(const schema of [2,3,4,5,6,7,8,9])test('persisted snapshot decoder retains exact LP'+schema+' document/history values',()=>{
 const s=snapshot(schema,schema===9),rows=decodeSnapshot(s);assert.deepEqual(rows.map(r=>r.value),[s.document,s.history]);
 if(schema<9)assert.throws(()=>decodeSnapshot(snapshot(schema,true)),error=>error.code==='CORRUPT_STORE');
});
test('persisted decoder rejects unknown future header and LP8 metadata hidden in foundation history',()=>{
 assert.throws(()=>decodeSnapshot(snapshot(10,false)),error=>error.code==='CORRUPT_STORE');
 const s=snapshot(8,false),current=fixture(true);s.rows[2].utf8Base64=Buffer.from(canonical(current.history)).toString('base64');assert.throws(()=>decodeSnapshot(s),error=>error.code==='CORRUPT_STORE');
});
