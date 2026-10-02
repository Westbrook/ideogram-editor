import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {entity,event} from '../../dist/local/src/protocol/validate.js';

const ref=text=>({hash:'sha256:'+createHash('sha256').update(text).digest('hex'),byteLength:String(Buffer.byteLength(text)),mediaType:'application/json'});
function fixture(){
 const before={state:ref('before'),semanticDigest:ref('before-digest').hash,compositeAssetId:null},after={state:ref('after'),semanticDigest:ref('after-digest').hash,compositeAssetId:'native_composite'},forward=ref('forward'),inverse=ref('inverse');
 const history={id:'native_history',documentId:'document',branchId:'branch',parent:'created_history',revision:'2',kind:'image-edit',operation:'CreateTextFromReturnedDescription',before,after,forward,inverse,roots:[before.state,after.state,forward,inverse]};
 const document={id:'document',revision:'2',branchId:'branch',width:64,height:32,color:'sRGB',depth:8,orderedLayerIds:['returned_text'],historyHead:history.id,checkpoint:null,compositionVersion:null,image:after,redo:null};
 return {schemaVersion:1,payloadVersion:1,eventId:'native_event',workspaceSeq:'7',streamId:'document',streamSeq:'2',documentId:'document',resultingDocumentRevision:'2',commandId:'native_command',correlationId:'correlation',causationId:null,transactionId:'native_transaction',writerEpoch:'1',recordedAt:'2026-09-30T00:00:00.000Z',type:'ImageEdited',payload:{document,history}};
}
test('reviewed returned-description creation is a valid durable history entity and ImageEdited event',()=>{
 const value=fixture();assert.equal(entity('history',value.payload.history),'2');assert.doesNotThrow(()=>event(value));
});
test('returned-description history keeps exact operation, root and event correspondence checks',()=>{
 for(const operation of ['CreateTextFromReturnedDescriptionV2','CreateTextFromDescription','ApproveReturnedDescription']){const value=fixture();value.payload.history.operation=operation;assert.throws(()=>entity('history',value.payload.history));assert.throws(()=>event(value));}
 for(const mutate of [value=>value.payload.history.roots.pop(),value=>value.payload.history.descriptionAuthority=true,value=>value.payload.history.adoptedLineage=ref('unauthorized-lineage'),value=>value.payload.history.after={...value.payload.history.after,state:ref('different-after')},value=>value.payload.history.documentId='other_document']){const value=fixture();mutate(value);assert.throws(()=>event(value));}
});
