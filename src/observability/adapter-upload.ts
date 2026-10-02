import {SHA256} from '../protocol/sha256.js';
import type {StagingCreateRequest,StagingRecord} from '../protocol/assets.js';
import {reserveCommandWire} from '../state/control-memory.js';
import {allocationLedger} from './allocations.js';
import {createOwnedModel,readOwnedJSON,reserveModelBytes,type OwnedModel} from './model-memory.js';
import {diagnosticMemory,DiagnosticReads,type DiagnosticMemory,type DiagnosticLease} from './diagnostic-memory.js';
import {registerAdapterUploadReader,type AdapterOpaqueUpload,type AdapterUploadRole,type OpaqueUploadInput} from './adapter-upload-hook.js';

const HASH_CHUNK=65536,TRANSFER_CHUNK=1048576,CONTROL_BYTES=65536,RUN_LIMIT=8,ROW_BYTES=32768;
const roles=new Set<AdapterUploadRole>(['adapter-weights','adapter-config','adapter-provenance']);
type ReadRun={offset:number;length:number;chunks:number};
type AckRun={from:string;to:string;step:number;count:number};
type Reads={from:number|null;to:number|null;byteLength:number;chunks:number;maxChunk:number;contiguous:boolean;runs:ReadRun[]};
type Owner={sessionHash:string|null;draftSessionHash:string|null;documentHash:string|null;documentEpoch:number|null;editorEpoch:number|null;clientHash:string|null};
type Operation={id:string;sequence:number;role:AdapterUploadRole;purpose:StagingCreateRequest['purpose'];bytes:number;owner:Owner;
 stagingId:string|null;outcome:'active'|'complete'|'error';settled:boolean;missing:string[];liveReads:number;
 hash:Reads&{sha256:string|null};transfer:Reads&{acks:number;ackRuns:AckRun[];initialCommittedOffset:string|null;lastCommittedOffset:string|null;lastState:string|null}};
const natural=(value:number)=>Number.isSafeInteger(value)&&value>=0;
const emptyReads=():Reads=>({from:null,to:null,byteLength:0,chunks:0,maxChunk:0,contiguous:true,runs:[]});
const missing=(row:Operation|null,reason:string)=>{if(row&&!row.missing.includes(reason))row.missing.push(reason);};
const identity=(value:string|null)=>value===null?null:typeof value==='string'&&value.length>0&&value.length<=256?new SHA256().update(new TextEncoder().encode(value)).digest():null;

/** No payloads, File names, raw owner IDs or per-chunk unbounded lists survive.
 * This is a witness of the actual opaque upload implementation below. It is
 * not a global observer of JavaScript tensor decoding or physical allocation. */
export class AdapterUploadObservations {
 private rows:Operation[]=[];private sequence=0;private dropped=0;private invalid=0;private active=0;private overflow=false;private disposed=false;
 private readonly realmId=crypto.randomUUID();private readonly lease:DiagnosticLease;private readonly reads:DiagnosticReads;
 constructor(private readonly capacity=64,memory:DiagnosticMemory=diagnosticMemory){
  if(!Number.isInteger(capacity)||capacity<1||capacity>256)throw Error('ADAPTER_UPLOAD_OBSERVER_CAPACITY');
  this.lease=memory.reserve('diagnostic-adapter-upload-records',capacity*ROW_BYTES+65536);
  this.reads=new DiagnosticReads('diagnostic-adapter-upload-read',4,memory);
 }
 private count(value:number){if(value===Number.MAX_SAFE_INTEGER){this.overflow=true;return value;}return value+1;}
 private begin(input:OpaqueUploadInput,role:AdapterUploadRole):Operation|null {
  this.active=this.count(this.active);this.sequence=this.count(this.sequence);
  if(this.disposed||this.overflow){this.dropped=this.count(this.dropped);return null;}
  if(this.rows.length===this.capacity){const index=this.rows.findIndex(row=>row.settled);this.dropped=this.count(this.dropped);if(index<0)return null;this.rows.splice(index,1);}
  const owner=input.owner,hashed:Owner={sessionHash:identity(owner.sessionId),draftSessionHash:identity(owner.draftSessionId),documentHash:identity(owner.documentId),
   documentEpoch:natural(owner.documentEpoch)?owner.documentEpoch:null,editorEpoch:natural(owner.editorEpoch)?owner.editorEpoch:null,clientHash:identity(owner.clientId)};
  const row:Operation={id:this.realmId+':'+this.sequence,sequence:this.sequence,role,purpose:input.purpose,bytes:input.file.size,owner:hashed,
   stagingId:null,outcome:'active',settled:false,missing:[],liveReads:0,hash:{...emptyReads(),sha256:null},
   transfer:{...emptyReads(),acks:0,ackRuns:[],initialCommittedOffset:null,lastCommittedOffset:null,lastState:null}};
  if(!hashed.sessionHash||!hashed.clientHash||owner.draftSessionId!==null&&!hashed.draftSessionHash||owner.documentId!==null&&!hashed.documentHash||hashed.documentEpoch===null||hashed.editorEpoch===null){missing(row,'owner-identity-unavailable');this.invalid=this.count(this.invalid);}
  if(!natural(row.bytes)){missing(row,'file-size-unavailable');this.invalid=this.count(this.invalid);}
  this.rows.push(row);return row;
 }
 /** Bind the diagnostic producer to the exact File selected by the UI.
  * The returned operation itself reads/hashes/transfers; callers never report
  * successful counts, byte ranges or acknowledgement totals. */
 bind(file:Blob,role:AdapterUploadRole):AdapterOpaqueUpload {
  if(!roles.has(role))throw Error('ADAPTER_UPLOAD_ROLE');
  return input=>{
   if(input.file!==file||input.purpose!==(role==='adapter-weights'?'adapter':'caption'))throw Error('ADAPTER_UPLOAD_LINEAGE');
   return this.upload(input,role);
  };
 }
 private recordRead(row:Operation|null,lane:'hash'|'transfer',offset:number,received:number,expected:number){
  if(!row)return;const value=row[lane];
  if(!natural(offset)||!natural(received)||received!==expected){missing(row,'read-range-unavailable');value.contiguous=false;this.invalid=this.count(this.invalid);return;}
  if(value.from===null)value.from=offset;else if(value.to!==offset){value.contiguous=false;missing(row,'read-range-discontinuity');}
  if(!natural(value.byteLength+received)||!natural(value.chunks+1)){this.overflow=true;missing(row,'counter-overflow');return;}
  value.to=offset+received;value.byteLength+=received;value.chunks++;value.maxChunk=Math.max(value.maxChunk,received);
  const last=value.runs.at(-1);
  if(last&&last.length===received&&last.offset+last.length*last.chunks===offset)last.chunks++;
  else if(value.runs.length<RUN_LIMIT)value.runs.push({offset,length:received,chunks:1});
  else missing(row,'read-run-capacity');
 }
 private ack(row:Operation|null,value:StagingRecord,offset?:number,length?:number){
  if(!row)return;const transfer=row.transfer;
  if(transfer.initialCommittedOffset===null){transfer.initialCommittedOffset=value.committedOffset;if(value.committedOffset!=='0')missing(row,'resumed-transfer');}
  else if(offset!==undefined&&length!==undefined){
   const next=Number(value.committedOffset),from=String(offset),step=next-offset;transfer.acks++;
   if(next!==offset+length||transfer.lastCommittedOffset!==from)missing(row,'acknowledgement-discontinuity');
   const last=transfer.ackRuns.at(-1);
   if(last&&last.to===from&&last.step===step){last.to=value.committedOffset;last.count++;}
   else if(transfer.ackRuns.length<RUN_LIMIT)transfer.ackRuns.push({from,to:value.committedOffset,step,count:1});
   else missing(row,'acknowledgement-run-capacity');
  }
  transfer.lastCommittedOffset=value.committedOffset;
  transfer.lastState=['receiving','complete','finalized','failed'].includes(value.state)?value.state:null;
 }
 private async upload(input:OpaqueUploadInput,role:AdapterUploadRole):Promise<OwnedModel<StagingCreateRequest>> {
  const row=this.begin(input,role);let request:OwnedModel<StagingCreateRequest>|undefined,stage:OwnedModel<StagingRecord>|undefined,returned=false;
  const {file,purpose,mediaType,existing,check,signal,tick,transport}=input;
  const read=<T>(path:string,init:RequestInit={})=>{check();return readOwnedJSON<T>(transport,path,{owner:'upload-control-response',init:{...init,signal},owns:()=>{check();return true;},maxBytes:CONTROL_BYTES});};
  const bytes=async(lane:'hash'|'transfer',offset:number,length:number)=>{
   if(row)row.liveReads++;
   try{const value=await file.slice(offset,offset+length).arrayBuffer();check();this.recordRead(row,lane,offset,value.byteLength,length);if(value.byteLength!==length)throw Error('UPLOAD_READ_CHANGED');return value;}
   finally{if(row)row.liveReads--;}
  };
  try{
   check();if(typeof mediaType!=='string'||mediaType.length>256||existing&&(!/^[A-Za-z0-9_-]{1,128}$/.test(existing.stagingId)||existing.mediaType.length>256))throw Error('UPLOAD_CONTROL_LIMIT');
   if(existing&&existing.purpose!==purpose)throw Error('STAGING_CHANGED');
   const digestOwner=reserveModelBytes('upload-digest-workspace',4096,2);let sha256:string;
   try{const hash=new SHA256();let at=0,started=performance.now();
    while(at<file.size){check();const length=Math.min(HASH_CHUNK,file.size-at),buffer=allocationLedger.reserve({owner:'upload-hash-buffer',kind:'staging',cpuBytes:length,handles:1});
     try{const value=new Uint8Array(await bytes('hash',at,length));hash.update(value);at+=value.length;}finally{buffer.release();}
     if(performance.now()-started>4){await tick();check();started=performance.now();}}
    sha256=hash.digest();if(row)row.hash.sha256=sha256;
   }finally{digestOwner.release();}
   if(existing&&(existing.sha256!==sha256||existing.expectedBytes!==String(file.size)))throw Error('ORIGINAL_FILE_HASH_MISMATCH');
   request=createOwnedModel<StagingCreateRequest>('upload-retained-request',4096,()=>({protocolVersion:1,stagingId:existing?.stagingId??crypto.randomUUID(),purpose:existing?.purpose??purpose,expectedBytes:String(file.size),sha256,mediaType:existing?.mediaType??mediaType}));
   if(row)row.stagingId=request.value.stagingId;
   if(!existing){const wire=reserveCommandWire(request.value);try{const created=await read('/api/v1/assets/staging',{method:'POST',headers:{'Content-Type':'application/json'},body:wire.wire});created.release();}finally{wire.release();}}
   let currentStage:OwnedModel<StagingRecord>=await read<StagingRecord>('/api/v1/assets/staging/'+request.value.stagingId);stage=currentStage;
   const validate=()=>{const value=currentStage.value;if(value.stagingId!==request!.value.stagingId||value.sha256!==sha256||value.expectedBytes!==String(file.size)||value.purpose!==purpose||value.mediaType!==request!.value.mediaType||value.ownerClientId!==input.owner.clientId||!/^(0|[1-9][0-9]*)$/.test(value.committedOffset)||value.committedOffset.length>32||BigInt(value.committedOffset)>BigInt(file.size))throw Error('STAGING_CHANGED');};
   validate();this.ack(row,currentStage.value);
   while(BigInt(currentStage.value.committedOffset)<BigInt(file.size)){
    check();const offset=Number(currentStage.value.committedOffset),length=Math.min(TRANSFER_CHUNK,file.size-offset),transfer=allocationLedger.reserve({owner:'upload-put-body',kind:'staging',cpuBytes:length*2,handles:2});
    try{const value=await bytes('transfer',offset,length),next:OwnedModel<StagingRecord>=await read<StagingRecord>('/api/v1/assets/staging/'+request.value.stagingId,{method:'PUT',headers:{'Content-Type':'application/octet-stream','Upload-Offset':currentStage.value.committedOffset},body:value});
     currentStage.release();stage=currentStage=next;validate();this.ack(row,currentStage.value,offset,length);if(BigInt(currentStage.value.committedOffset)<=BigInt(offset))throw Error('STAGING_NOT_ADVANCING');
    }finally{transfer.release();}
   }
   check();if(row){
    if(row.hash.byteLength!==file.size||row.hash.to!==file.size||row.hash.from!==0||!row.hash.contiguous)missing(row,'hash-coverage-incomplete');
    if(row.transfer.byteLength!==file.size||row.transfer.to!==file.size||row.transfer.from!==0||!row.transfer.contiguous||row.transfer.acks!==row.transfer.chunks||row.transfer.lastCommittedOffset!==String(file.size))missing(row,'transfer-coverage-incomplete');
    if(row.transfer.lastState!=='complete')missing(row,'terminal-stage-state-unavailable');row.outcome='complete';
   }
   returned=true;return request;
  }catch(error){if(row){row.outcome='error';missing(row,signal.aborted?'aborted':'upload-error');}throw error;}
  finally{try{stage?.release();if(!returned)request?.release();}
   catch(error){if(row){row.outcome='error';missing(row,'cleanup-unavailable');}throw error;}
   finally{if(row)row.settled=true;this.active--;}}
 }
 readSnapshot(){
  if(this.disposed)throw Error('ADAPTER_UPLOAD_OBSERVER_DISPOSED');
  return this.reads.read(this.rows.length*ROW_BYTES+65536,()=>({kind:'adapter-upload-observation-1' as const,schemaVersion:1 as const,
   scope:'ownedUpload-opaque-hash-and-transfer' as const,realmId:this.realmId,sequence:this.sequence,dropped:this.dropped,invalid:this.invalid,overflow:this.overflow,active:this.active,
   observerMetadata:{capacity:this.capacity,runCapacity:RUN_LIMIT,producerAllowanceBytes:this.capacity*ROW_BYTES+65536,retainedOperations:this.rows.length,basis:'admitted-application-diagnostic-payload-allowances' as const},
   globalCoverageComplete:false as const,operations:structuredClone(this.rows)}));
 }
 dispose(){if(this.active)throw Error('ADAPTER_UPLOAD_OBSERVER_ACTIVE');if(this.disposed)return;this.disposed=true;this.rows=[];this.reads.close();this.lease.release();}
}
let installed:AdapterUploadObservations|undefined;
const readInstalled=()=>installed!.readSnapshot();
/** Keep admission outside module evaluation: a refused diagnostic allowance
 * must not permanently poison the browser's dynamic-import module cache. */
export function ensureAdapterUploads(){
 if(installed)return installed;
 const next=new AdapterUploadObservations();
 try{registerAdapterUploadReader(readInstalled);}catch(error){next.dispose();throw error;}
 installed=next;return next;
}
export const bindAdapterUpload=(file:Blob,role:AdapterUploadRole)=>ensureAdapterUploads().bind(file,role);
