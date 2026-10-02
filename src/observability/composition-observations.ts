import {diagnosticMemory,diagnosticPayloadBytes,DiagnosticReads,type DiagnosticMemory,type DiagnosticLease} from './diagnostic-memory.js';
/** Bounded, numeric R38 producer evidence. Never retains authored strings,
 * parsed graphs, URLs or byte buffers. This observer cannot grant authority. */
export type CompositionOperation='parse'|'serialize'|'ui-issues'|'retained-page'|'blob-read'|'stream-read';
export type CompositionObservationKind='ownership'|'derived-snapshot'|'issues'|'raw-page'|'raw-read'|'raw-inspection';
type Source={hash:string;byteLength:string};
type Parsed={state:string;issues:unknown[];value?:unknown};
export type CompositionObservation={sequence:number;atMs:number;kind:CompositionObservationKind;operation?:CompositionOperation;utf8Bytes?:number;issueCount?:number;receivedBytes?:number;sourceBytes?:number;offset?:number;sourceHash?:string;parseState?:string;derivedPresent?:boolean;violations?:number;retainedIdentity?:boolean;complete:boolean;promptOwnedBytes:number;rawInspectionOwnedBytes:number};
type CompositionBirth=Readonly<{kind:'composition-observer-birth-1';instanceId:string;atMs:number;cursor:0;invalid:0;ownershipStarted:false;promptOwnedBytes:0;rawInspectionOwnedBytes:0}>;
const operations=new Set<CompositionOperation>(['parse','serialize','ui-issues','retained-page','blob-read','stream-read']);
const parsedStates=new Set(['supported','ambiguous','unsupported','malformed','over-limit']);
const rawOwners=new Set(['composition-raw-copy','composition-raw-read','composition-raw-read-operation','composition-raw-page','composition-parse-scratch','composition-parse-model','composition-convert-text','composition-encode','request-prompt-page','request-prompt-read','request-prompt-read-operation']);
const natural=(v:number)=>Number.isSafeInteger(v)&&v>=0;

/** Exact JSON.stringify UTF8 size for plain JSON-shaped producer values, without
 * allocating a second serialized caption. Undefined object fields are omitted;
 * nonfinite numbers and array holes use JSON's null representation. */
export function jsonUtf8Bytes(value:unknown):number {
 const ancestors=new Set<object>();let visited=0;
 const string=(s:string)=>{let n=2;for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);if(c===34||c===92||c===8||c===9||c===10||c===12||c===13)n+=2;else if(c<32)n+=6;else if(c>=0xd800&&c<=0xdbff){const next=s.charCodeAt(i+1);if(next>=0xdc00&&next<=0xdfff){n+=4;i++;}else n+=6;}else if(c>=0xdc00&&c<=0xdfff)n+=6;else n+=c<128?1:c<2048?2:3;}return n;};
 const walk=(v:unknown,depth:number):number=>{
  if(depth>64||++visited>100000)throw Error('COMPOSITION_OBSERVER_SIZE');
  if(v===null)return 4;if(typeof v==='string')return string(v);if(typeof v==='boolean')return v?4:5;
  if(typeof v==='number')return Number.isFinite(v)?JSON.stringify(v).length:4;
  if(!v||typeof v!=='object'||ancestors.has(v))throw Error('COMPOSITION_OBSERVER_VALUE');
  ancestors.add(v);let n=2;
  try{if(Array.isArray(v)){for(let i=0;i<v.length;i++){const d=Object.getOwnPropertyDescriptor(v,String(i));if(d&&!('value'in d))throw Error('COMPOSITION_OBSERVER_ACCESSOR');n+=(i?1:0)+walk(d?.value??null,depth+1);}}
   else{const prototype=Object.getPrototypeOf(v);if(prototype!==Object.prototype&&prototype!==null)throw Error('COMPOSITION_OBSERVER_PROTOTYPE');let fields=0;for(const key in v){const d=Object.getOwnPropertyDescriptor(v,key);if(!d)continue;if(!('value'in d))throw Error('COMPOSITION_OBSERVER_ACCESSOR');if(d.value===undefined)continue;n+=(fields++?1:0)+string(key)+1+walk(d.value,depth+1);}}
  }finally{ancestors.delete(v);}if(!natural(n))throw Error('COMPOSITION_OBSERVER_SIZE');return n;
 };
 return walk(value,0);
}

export class CompositionObservations {
 private rows:CompositionObservation[]=[];private sequence=0;private invalid=0;private last=0;private prompt=0;private raw=0;private ownershipStarted=false;
 private readonly origin:number;private readonly birth:CompositionBirth;private readonly lease:DiagnosticLease;private readonly reads:DiagnosticReads;private disposed=false;
 private readonly capacityBytes:number;
 constructor(private readonly capacity=2048,private readonly now:()=>number=()=>performance.now(),wallNow:()=>number=Date.now,memory:DiagnosticMemory=diagnosticMemory){if(!Number.isInteger(capacity)||capacity<1||capacity>8192)throw Error('COMPOSITION_OBSERVER_CAPACITY');this.capacityBytes=capacity*1024+65536;this.lease=memory.reserve('diagnostic-composition-records',this.capacityBytes);this.reads=new DiagnosticReads('diagnostic-composition-read',4,memory);try{const atMs=now();this.origin=wallNow()-atMs;if(!Number.isFinite(this.origin)||!Number.isFinite(atMs)||atMs<0)throw Error('COMPOSITION_OBSERVER_CLOCK');this.last=atMs;
  // The singleton is constructed before AllocationLedger can issue a prompt
  // lease. This actual birth stays outside the bounded ring; it is not a
  // reconstructed zero, an old capture upgrade, or a physical-memory claim.
  this.birth=Object.freeze({kind:'composition-observer-birth-1',instanceId:crypto.randomUUID(),atMs,cursor:0,invalid:0,ownershipStarted:false,promptOwnedBytes:0,rawInspectionOwnedBytes:0});
 }catch(error){this.lease.release();throw error;}}
 private record(value:Omit<CompositionObservation,'sequence'|'atMs'|'promptOwnedBytes'|'rawInspectionOwnedBytes'>){
  if(this.disposed)return;const at=this.now();if(!Number.isFinite(at)||at<0||at<this.last){this.invalid++;return;}this.last=at;
  const row={...value,sequence:++this.sequence,atMs:at,promptOwnedBytes:this.prompt,rawInspectionOwnedBytes:this.raw};this.rows[(this.sequence-1)%this.capacity]=row;
 }
 // Observer failure never changes the product's accepted allocation/cleanup.
 ownership(owner:string,before:number,after:number,promptTotal:number){if(this.disposed)return;try{
  if(!natural(before)||!natural(after)||!natural(promptTotal)||this.prompt-before+after!==promptTotal)throw Error('COMPOSITION_OBSERVER_OWNER');
  const raw=this.raw+(rawOwners.has(owner)?after-before:0);if(!natural(raw)||raw>promptTotal)throw Error('COMPOSITION_OBSERVER_OWNER');
  this.prompt=promptTotal;this.raw=raw;this.ownershipStarted=true;this.record({kind:'ownership',complete:true});
 }catch{this.invalid++;}}
 value(kind:'derived-snapshot'|'issues',value:unknown,operation:CompositionOperation){if(this.disposed)return;try{
  if(!operations.has(operation)||kind==='issues'&&!Array.isArray(value))throw Error('COMPOSITION_OBSERVER_OPERATION');
  const utf8Bytes=jsonUtf8Bytes(value);this.record({kind,operation,utf8Bytes,...(kind==='issues'?{issueCount:Array.isArray(value)?value.length:0}:{}),complete:true});
 }catch{this.invalid++;}}
 read(operation:'blob-read'|'stream-read',receivedBytes:number,sourceBytes:number){if(this.disposed)return;try{
  if(!natural(receivedBytes)||!natural(sourceBytes)||receivedBytes>sourceBytes)throw Error('COMPOSITION_OBSERVER_READ');
  this.record({kind:'raw-read',operation,receivedBytes,sourceBytes,complete:receivedBytes===sourceBytes});
 }catch{this.invalid++;}}
 page(source:Source,offset:number,receivedBytes:number){if(this.disposed)return;try{
  const sourceBytes=Number(source.byteLength);if(!/^sha256:[a-f0-9]{64}$/.test(source.hash)||!/^(0|[1-9][0-9]*)$/.test(source.byteLength)||!natural(sourceBytes)||!natural(offset)||!natural(receivedBytes))throw Error('COMPOSITION_OBSERVER_PAGE');
  const expected=Math.max(0,Math.min(32768,sourceBytes-offset)),violations=receivedBytes!==expected||offset>sourceBytes?1:0;
  this.record({kind:'raw-page',operation:'retained-page',sourceHash:source.hash,sourceBytes,offset,receivedBytes,violations,retainedIdentity:true,complete:true});
 }catch{this.invalid++;}}
 parsed(rawBytes:number,result:Parsed,source?:Source){if(this.disposed)return;try{
  if(!natural(rawBytes)||!parsedStates.has(result.state)||!Array.isArray(result.issues))throw Error('COMPOSITION_OBSERVER_PARSE');
  this.value('issues',result.issues,'parse');if(result.value!==undefined)this.value('derived-snapshot',result.value,'parse');
  let sourceBytes=rawBytes,sourceHash:string|undefined;
  if(source){sourceBytes=Number(source.byteLength);if(!/^sha256:[a-f0-9]{64}$/.test(source.hash)||!/^(0|[1-9][0-9]*)$/.test(source.byteLength)||!natural(sourceBytes))throw Error('COMPOSITION_OBSERVER_SOURCE');sourceHash=source.hash;}
  // A bounded prefix may only produce an over-limit result. It can never be
  // called a supported parse of the full retained original.
  const violations=rawBytes>sourceBytes||rawBytes<sourceBytes&&result.state!=='over-limit'||sourceBytes>262144&&result.state!=='over-limit'||result.state==='supported'&&result.value===undefined?1:0;
  this.record({kind:'raw-inspection',operation:'parse',receivedBytes:rawBytes,sourceBytes,...(sourceHash?{sourceHash}:{}),parseState:result.state,derivedPresent:result.value!==undefined,violations,retainedIdentity:!!sourceHash,complete:true});
 }catch{this.invalid++;}}
 readSnapshot(){
  if(this.disposed)throw Error('COMPOSITION_OBSERVER_DISPOSED');
  const atMs=this.now();if(!Number.isFinite(atMs)||atMs<0||atMs<this.last){this.invalid++;throw Error('COMPOSITION_OBSERVER_CLOCK');}this.last=atMs;
  const logicalBytes=4096+diagnosticPayloadBytes(this.birth)+diagnosticPayloadBytes(this.rows);
  return this.reads.read(logicalBytes,()=>{
   const records:CompositionObservation[]=[];const oldest=Math.max(1,this.sequence-this.rows.length+1);
   for(let sequence=oldest;sequence<=this.sequence;sequence++)records.push({...this.rows[(sequence-1)%this.capacity]});
   return {kind:'composition-resource-observations-1' as const,schemaVersion:1 as const,lane:'browser-main' as const,instanceId:this.birth.instanceId,atMs,birth:{...this.birth},clockOriginUnixMs:this.origin,cursor:this.sequence,oldestSequence:oldest,dropped:Math.max(0,this.sequence-this.capacity),invalid:this.invalid,ownershipStarted:this.ownershipStarted,promptOwnedBytes:this.prompt,rawInspectionOwnedBytes:this.raw,
    ownershipBasis:'application-logical-payload-reservations' as const,physicalMemoryComplete:false as const,
    observerMetadata:{complete:true as const,ringCapacity:this.capacity,retainedRecords:this.rows.length,snapshotRecords:records.length,capacityBytes:this.capacityBytes,snapshotAllowanceBytes:logicalBytes*3+65536,basis:'admitted-application-diagnostic-payload-allowances' as const},records};
  });
 }
 dispose(){if(this.disposed)return;this.disposed=true;this.rows=[];this.reads.close();this.lease.release();}
}
export const compositionObservations=new CompositionObservations();
