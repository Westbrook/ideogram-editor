import {createHash} from 'node:crypto';
import {canonical} from '../../../dist/local/src/protocol/json.js';
import {event as validateEvent} from '../../../dist/local/src/protocol/validate.js';
export function recoveryFixture(){
 const doc={id:'fixture_document',revision:'1',branchId:'branch',width:360,height:200,color:'sRGB',depth:8,orderedLayerIds:[],historyHead:'history',checkpoint:null,compositionVersion:null};
 const history={id:'history',documentId:doc.id,branchId:'branch',parent:null,forward:{before:null,after:doc},inverse:{before:doc,after:null},roots:[]};
 const base={schemaVersion:1,payloadVersion:1,streamId:doc.id,documentId:doc.id,commandId:'command',correlationId:'correlation',causationId:null,transactionId:'transaction',writerEpoch:'1',recordedAt:'2026-09-28T00:00:00.000Z'};
 const first={...base,eventId:'event_1',workspaceSeq:'1',streamSeq:'1',resultingDocumentRevision:'1',type:'DocumentCreated',payload:{document:doc,history}};
 const second={...base,eventId:'event_2',workspaceSeq:'2',streamSeq:'2',resultingDocumentRevision:'2',type:'CheckpointSaved',payload:{checkpoint:{id:'checkpoint',name:'Split UTF-8 é 🧭',documentId:doc.id,documentRevision:'1',historyHead:'history',highWater:'2'}}};
 const values=[first,second];for(const e of values)validateEvent(e);const bytes=Buffer.from(values.map(canonical).join('\n')+'\n'),hash='sha256:'+createHash('sha256').update(bytes).digest('hex');
 const recovery={recoveryId:'recovery_fixture',writerEpoch:'1',highWater:'3',projectionSchema:8,expiresAt:'2027-01-01T00:00:00.000Z'};
 const content={contentId:'content_fixture',url:'/api/v1/protocol-content/content_fixture?recoveryId=recovery_fixture',blob:{hash,byteLength:String(bytes.length),mediaType:'application/x-ndjson'},encoding:'lp1-events-jsonl',recordCount:'2',expiresAt:recovery.expiresAt};
 const reference={kind:'transaction-ref',transactionId:'transaction',fromSeq:'1',toSeq:'2',eventCount:'2',recovery,content},body={protocolVersion:1,kind:'transaction-ref',reference};
 const later={...second,eventId:'event_3',workspaceSeq:'3',streamSeq:'3',resultingDocumentRevision:'3',commandId:'later_command',transactionId:'later_transaction',payload:{checkpoint:{...second.payload.checkpoint,id:'later_checkpoint',documentRevision:'2',highWater:'3'}}};validateEvent(later);
 const final={protocolVersion:1,kind:'batches',recovery,batches:[{kind:'inline',transactionId:later.transactionId,fromSeq:'3',toSeq:'3',events:[later]}],nextCursor:'3',more:false};
 return {doc,values,bytes,reference,body,frame:Buffer.from('id: 2\ndata: '+canonical(body)+'\n\n'),final,finalDocument:{...doc,revision:'2',checkpoint:'checkpoint'}};
}
