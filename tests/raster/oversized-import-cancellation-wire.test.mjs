import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonical} from '../../dist/local/src/protocol/json.js';
import {rasterImportCancellation,RASTER_IMPORT_CANCELLATION_REF as details} from '../../dist/local/src/protocol/raster-import.js';
const id='import_operation_1',wrap=(receipt,status='completed')=>({protocolVersion:1,commandId:id,status,receipt});
const canceled=()=>wrap({status:'rejected',commandId:id,code:'INVALID_INPUT',currentRevision:null,details:{...details}},'canceled');
const accepted=()=>wrap({status:'accepted',commandId:id,fromSeq:'4',toSeq:'5',documentRevision:null,transactionId:'transaction_1'});
const rejected=()=>wrap({status:'rejected',commandId:id,code:'CAPACITY',currentRevision:null,details:{hash:'sha256:'+'1'.repeat(64),byteLength:'3',mediaType:'application/json'}});
test('exact cancellation detail reference binds canonical public default; all three terminal outcomes validate',()=>{
 const bytes=Buffer.from(canonical({kind:'fields',issues:[{path:'command.body',code:'RASTER_IMPORT_CANCELED'}]}));
 assert.deepEqual(details,{hash:'sha256:'+createHash('sha256').update(bytes).digest('hex'),byteLength:String(bytes.length),mediaType:'application/json'});
 for(const result of [canceled(),accepted(),rejected()])assert.doesNotThrow(()=>rasterImportCancellation(result,id));
});
const cases=[
 ['wrong envelope target',r=>r.commandId='another'],['wrong receipt target',r=>r.receipt.commandId='another'],
 ['partial receipt',r=>delete r.receipt.currentRevision],['extra receipt field',r=>r.receipt.extra=true],['extra envelope field',r=>r.extra=true],
 ['wrong protocol',r=>r.protocolVersion=2],['wrong detail hash',r=>r.receipt.details.hash='sha256:'+'2'.repeat(64)],
 ['wrong detail size',r=>r.receipt.details.byteLength='85'],['wrong detail media',r=>r.receipt.details.mediaType='text/plain'],
 ['malformed hash',r=>r.receipt.details.hash='unknown'],['partial details',r=>delete r.receipt.details.byteLength],
 ['extra details field',r=>r.receipt.details.extra=1],['unknown rejection code',r=>r.receipt.code='OTHER'],
 ['wrong cancellation code',r=>r.receipt.code='CAPACITY'],['document-owned receipt',r=>r.receipt.currentRevision='0'],
 ['canceled called completed',r=>r.status='completed'],['pending called canceled',r=>r.receipt.status='pending'],
];
for(const [name,mutate]of cases)test('malformed cancellation stays unconfirmed: '+name,()=>{const r=canceled();mutate(r);assert.throws(()=>rasterImportCancellation(r,id));});
test('completed replies also need a complete typed receipt and consistent terminal status',()=>{
 for(const mutate of [r=>delete r.receipt.transactionId,r=>r.receipt.transactionId='',r=>r.receipt.fromSeq='04',r=>r.receipt.fromSeq='0',r=>r.receipt.toSeq='3',r=>r.receipt.toSeq=5,r=>r.receipt.documentRevision='5',r=>r.status='canceled']){const r=accepted();mutate(r);assert.throws(()=>rasterImportCancellation(r,id));}
 for(const mutate of [r=>r.receipt.details.byteLength='0',r=>r.receipt.details.byteLength='65537',r=>r.receipt.details.byteLength='-1',r=>r.receipt.details.mediaType='image/png',r=>r.status='canceled']){const r=rejected();mutate(r);assert.throws(()=>rasterImportCancellation(r,id));}
 const r=canceled();r.status='completed';r.receipt.details.byteLength='83';assert.throws(()=>rasterImportCancellation(r,id));
});
