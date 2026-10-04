import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {join} from 'node:path';

// Test-only observation. No product methods, requests, retries or body readers.
export const AUTHORING_DIAGNOSTIC_LIMITS=Object.freeze({wireBytes:65536,rows:512,rowBytes:98304,outputBytes:131072});
const hash=value=>createHash('sha256').update(value).digest('hex');
const id=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const scalar=value=>typeof value==='string'&&value.length<=128?value:null;
const openReadOnly=(path,options)=>new DatabaseSync(path,options);
function selectedWire(wire){
 if(typeof wire!=='string'||Buffer.byteLength(wire)>AUTHORING_DIAGNOSTIC_LIMITS.wireBytes)throw Error('wire-bound');
 const value=JSON.parse(wire),c=value.command;
 if(value.protocolVersion!==1||!c||c.body?.type!=='SetLayerProperties'||!id(c.commandId)||!id(c.transactionId)||!id(c.documentId)||!id(c.clientId))throw Error('command-identity');
 return {wire,bytes:Buffer.byteLength(wire),sha256:hash(wire),commandId:c.commandId,transactionId:c.transactionId,documentId:c.documentId,clientId:c.clientId,expectedDocumentRevision:scalar(c.expectedDocumentRevision),layerId:scalar(c.body.layerId),layerVersion:scalar(c.body.layerVersion),draftGeneration:scalar(c.body.draft?.generation)};
}
function publicSelection(selected){if(!selected)return null;const {wire,clientId,...visible}=selected;return visible;}

// BEGIN is a deferred read transaction: its snapshot is established by the first
// SELECT. WAL commits after that read are not visible here. This is a single
// post-failure committed-state observation, not the state at the poll deadline.
export function readAuthoringCommandSnapshot(root,wire,{open=openReadOnly}={}){
 const startedAt=performance.now(),result={kind:'post-failure-committed-state',startedAt,endedAt:null,status:'unavailable',selected:null,terminal:null,pending:null,readOnlyRequested:true,transactionStarted:false,closed:false};
 let db;
 try{
  const selected=selectedWire(wire);result.selected=publicSelection(selected);
  db=open(join(root,'metadata.sqlite'),{readOnly:true});db.exec('BEGIN');result.transactionStarted=true;
  const terminal=db.prepare('SELECT length(CAST(original AS BLOB)) AS originalBytes, CASE WHEN length(CAST(original AS BLOB))<=65536 THEN original END AS original, length(CAST(receipt AS BLOB)) AS receiptBytes, CASE WHEN length(CAST(receipt AS BLOB))<=65536 THEN receipt END AS receipt FROM commands WHERE id=? LIMIT 2').all(selected.commandId);
  const pending=db.prepare('SELECT length(CAST(original AS BLOB)) AS originalBytes, CASE WHEN length(CAST(original AS BLOB))<=65536 THEN original END AS original, substr(operation_id,1,129) AS operationId, substr(phase,1,129) AS phase FROM history_preparations WHERE id=? LIMIT 2').all(selected.commandId);
  if(terminal.length>1||pending.length>1||terminal.length&&pending.length){result.status='ambiguous';return result;}
  const row=terminal[0]??pending[0];
  if(!row){result.status='absent';return result;}
  if(typeof row.original!=='string'||row.originalBytes!==selected.bytes||hash(row.original)!==selected.sha256){result.status='original-mismatch';return result;}
  if(terminal.length){
   if(typeof row.receipt!=='string'||row.receiptBytes>65536){result.status='receipt-bound';return result;}
   const receipt=JSON.parse(row.receipt);
   if(receipt.commandId!==selected.commandId||!['accepted','rejected'].includes(receipt.status)||receipt.status==='accepted'&&receipt.transactionId!==selected.transactionId){result.status='receipt-mismatch';return result;}
   result.terminal={commandId:receipt.commandId,status:receipt.status,transactionId:scalar(receipt.transactionId),code:scalar(receipt.code),documentRevision:scalar(receipt.documentRevision),currentRevision:scalar(receipt.currentRevision),fromSeq:scalar(receipt.fromSeq),toSeq:scalar(receipt.toSeq)};
   result.status='terminal';
  }else{
   if(!id(row.operationId)||!['preparing','waiting-for-resources'].includes(row.phase)){result.status='pending-mismatch';return result;}
   result.pending={commandId:selected.commandId,operationId:row.operationId,phase:row.phase};result.status='pending';
  }
 }catch{result.status='unavailable';}
 finally{
  // Closing a read transaction releases it; no COMMIT, checkpoint or writes.
  if(db){try{db.close();result.closed=true;}catch{result.status='close-unavailable';}}
  result.endedAt=performance.now();
 }
 return result;
}

export function createAuthoringCommandWitness(origin){
 const base=new URL(origin);if(base.origin!==origin||base.hostname!=='127.0.0.1')throw Error('owned-origin');
 let selected=null,selectedRequest=null,sealed=false,overflow=false,rowBytes=0,submissionRefused=false,report;
 const rows=[],tokens=new WeakMap();
 function record(value){
  if(sealed)return;
  const row={at:performance.now(),...value},bytes=Buffer.byteLength(JSON.stringify(row));
  if(rows.length>=AUTHORING_DIAGNOSTIC_LIMITS.rows||rowBytes+bytes>AUTHORING_DIAGNOSTIC_LIMITS.rowBytes){overflow=true;return;}
  rowBytes+=bytes;rows.push(row);return row;
 }
 function matches(request){
  if(!selected)return false;
  const url=new URL(request.url());if(url.origin!==origin||url.search||url.hash)return false;
  return request===selectedRequest&&request.method()==='POST'&&url.pathname==='/api/v1/commands'||request.method()==='GET'&&url.pathname==='/api/v1/commands/'+selected.commandId;
 }
 return {
  submitted(request,wire){
   if(sealed)return;
   try{
    const url=new URL(request.url());if(url.origin!==origin||url.pathname!=='/api/v1/commands'||url.search||url.hash||request.method()!=='POST')return;
    // The caller supplies the same postData string it already read; no new read.
    const next=selectedWire(wire);selected=next;selectedRequest=request;
    record({kind:'submitted',commandId:next.commandId,bytes:next.bytes,sha256:next.sha256});
   }catch{submissionRefused=true;selected=null;selectedRequest=null;}
  },
  response(request,status){
   if(sealed)return;
   try{if(!matches(request)||!Number.isInteger(status)||status<100||status>599)return;const token={},row=record({kind:'response-callback',commandId:selected.commandId,method:request.method(),status});if(row)tokens.set(token,{commandId:selected.commandId,status});return row?token:undefined;}catch{return;}
  },
  readFailed(token){
   try{const bound=token&&tokens.get(token);if(!sealed&&bound){tokens.delete(token);record({kind:'existing-json-read-failed',commandId:bound.commandId,status:bound.status});}}catch{/* Passive observations never replace an original result. */}
  },
  readResult(token,value){
   try{
    const bound=token&&tokens.get(token);if(sealed||!bound)return;tokens.delete(token);
    const receipt=value?.receipt,resultId=receipt?.commandId??value?.commandId;
    record({kind:'existing-json-read-observed',commandId:bound.commandId,status:bound.status,resultKind:['receipt','pending','unknown'].includes(value?.kind)?value.kind:null,sameCommand:resultId===bound.commandId,receiptStatus:['accepted','rejected'].includes(receipt?.status)?receipt.status:null,phase:['preparing','waiting-for-resources'].includes(value?.phase)?value.phase:null});
   }catch{/* No extra read, getter error or observer exception changes the test. */}
  },
  failureSnapshot(root,options){
   if(report)return report;
   const failureObservedAt=performance.now();sealed=true;
   const snapshot=selected?readAuthoringCommandSnapshot(root,selected.wire,options):{status:'no-selected-original'};
   report={kind:'authoring-properties-failure-diagnostic-1',failureObservedAt,callbackCutoffAt:failureObservedAt,callbackSemantics:'Original request/response/read callbacks observed before cutoff; not network EOF or native progress.',snapshotSemantics:'One later committed SQLite read snapshot; not state at the expired assertion deadline. A later receipt does not repair the assertion.',selected:publicSelection(selected),overflow,submissionRefused,rows:rows.slice(),snapshot,qualification:false};
   if(Buffer.byteLength(JSON.stringify(report))>AUTHORING_DIAGNOSTIC_LIMITS.outputBytes)report={kind:'authoring-properties-failure-diagnostic-1',status:'output-bound',failureObservedAt,overflow:true,qualification:false};
   return report;
  }
 };
}
