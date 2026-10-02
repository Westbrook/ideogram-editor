/** Logical diagnostic payload allowances. These never describe physical engine
 * memory. Import-time owners are transferred into the central ledger before
 * product hooks are enabled; subsequent reservations use that same ledger. */
export type DiagnosticLease=Readonly<{release():void}>;
export type DiagnosticReserve=(value:{owner:string;kind:'control';cpuBytes:number;handles:number})=>DiagnosticLease;
type Booking={owner:string;cpuBytes:number;handles:number;lease?:DiagnosticLease};
const CPU_LIMIT=384*1024**2,HANDLE_LIMIT=16384,RECORD_LIMIT=4096;
export class DiagnosticMemory {
 private bookings=new Set<Booking>();private reserveCentral:DiagnosticReserve|undefined;
 private bytes=0;private handles=0;
 reserve(owner:string,cpuBytes:number,handles=1):DiagnosticLease {
  if(!/^[a-z][a-z0-9-]{0,63}$/.test(owner)||!Number.isSafeInteger(cpuBytes)||cpuBytes<0||!Number.isSafeInteger(handles)||handles<0)throw Error('DIAGNOSTIC_ALLOWANCE');
  if(this.bookings.size>=RECORD_LIMIT||this.bytes+cpuBytes>CPU_LIMIT||this.handles+handles>HANDLE_LIMIT)throw Error('DIAGNOSTIC_BUDGET');
  const lease=this.reserveCentral?.({owner,kind:'control',cpuBytes,handles});
  const booking:Booking={owner,cpuBytes,handles,lease};this.bookings.add(booking);this.bytes+=cpuBytes;this.handles+=handles;let live=true;
  return Object.freeze({release:()=>{if(!live)return;booking.lease?.release();live=false;this.bookings.delete(booking);this.bytes-=cpuBytes;this.handles-=handles;}});
 }
 /** Called once by the central singleton before it accepts product owners. */
 adopt(reserve:DiagnosticReserve){
  if(this.reserveCentral)throw Error('DIAGNOSTIC_ALREADY_ADOPTED');
  const acquired:Booking[]=[];
  try{for(const booking of this.bookings){booking.lease=reserve({owner:booking.owner,kind:'control',cpuBytes:booking.cpuBytes,handles:booking.handles});acquired.push(booking);}}
  catch(error){for(const booking of acquired){booking.lease!.release();booking.lease=undefined;}throw error;}
  this.reserveCentral=reserve;
 }
 get adopted(){return this.reserveCentral!==undefined;}
}
export const diagnosticMemory=new DiagnosticMemory();

/** One synchronous realm-local source link. The worker publishes its pool but
 * does not import a main-thread ledger or replace its borrowed diagnostic owner.
 * The central ledger subscribes before application controllers can book text. */
export type TextReservationBridgeSource={observeReservations(observer:(bytes:number,sequence:number,faults:number)=>void):()=>void;readonly reservationObservation:Readonly<{textBytes:number;sequence:number;observerFaults:number;observing:boolean}>};
let textReservationSource:TextReservationBridgeSource|undefined;
let textReservationConsumer:((source:TextReservationBridgeSource)=>void)|undefined;
diagnosticMemory.reserve('diagnostic-text-source-bridge',4096);
export function publishTextReservationSource(source:TextReservationBridgeSource){
 if(textReservationSource){if(textReservationSource!==source)throw Error('DIAGNOSTIC_TEXT_SOURCE_EXISTS');return;}
 if(!source||typeof source.observeReservations!=='function')throw Error('DIAGNOSTIC_TEXT_SOURCE');
 textReservationSource=source;textReservationConsumer?.(source);
}
export function observeTextReservationSource(consumer:(source:TextReservationBridgeSource)=>void){
 if(textReservationConsumer)throw Error('DIAGNOSTIC_TEXT_CONSUMER_EXISTS');
 textReservationConsumer=consumer;if(textReservationSource)consumer(textReservationSource);
}

/** Main-thread owner reserves this entire delegation before Worker creation.
 * It includes producer capacity, one snapshot/serialization, native ingress,
 * and receiver validation overlap; successful termination ends the delegation.
 * A worker may subdivide it but never increase it or grant itself more bytes. */
export const TEXT_WORKER_DIAGNOSTIC_BYTES=32*1024**2;
export function reserveBorrowedDiagnostics(limit:number):DiagnosticReserve {
 if(!Number.isSafeInteger(limit)||limit<0||limit>CPU_LIMIT)throw Error('DIAGNOSTIC_BORROW_LIMIT');
 let bytes=0,handles=0;
 return value=>{if(!Number.isSafeInteger(value.cpuBytes)||value.cpuBytes<0||!Number.isSafeInteger(value.handles)||value.handles<0)throw Error('DIAGNOSTIC_ALLOWANCE');if(bytes+value.cpuBytes>limit||handles+value.handles>64)throw Error('DIAGNOSTIC_BORROW_LIMIT');bytes+=value.cpuBytes;handles+=value.handles;let live=true;return Object.freeze({release(){if(!live)return;live=false;bytes-=value.cpuBytes;handles-=value.handles;}});};
}

/** Worst-case JSON/UTF16/string and numeric payload allowance, not object headers.
 * Traversal is bounded; descriptors avoid evaluating arbitrary getters. */
export function diagnosticPayloadBytes(value:unknown):number {
 let visited=0;const ancestors=new Set<object>();
 const walk=(item:unknown,depth:number):number=>{
  if(depth>64||++visited>200000)throw Error('DIAGNOSTIC_MODEL_LIMIT');
  if(item===null||item===undefined)return 4;if(typeof item==='string')return item.length*12+4;
  if(typeof item==='number')return 64;if(typeof item==='boolean')return 10;
  if(typeof item!=='object'||ancestors.has(item))throw Error('DIAGNOSTIC_MODEL');
  ancestors.add(item);let bytes=4;
  try{if(Array.isArray(item)){if(item.length>32768)throw Error('DIAGNOSTIC_MODEL_LIMIT');for(let i=0;i<item.length;i++){const field=Object.getOwnPropertyDescriptor(item,String(i));if(field&&!('value'in field))throw Error('DIAGNOSTIC_ACCESSOR');bytes+=2+walk(field?.value,depth+1);}}
   else{const prototype=Object.getPrototypeOf(item);if(prototype!==Object.prototype&&prototype!==null)throw Error('DIAGNOSTIC_MODEL');for(const key in item){const field=Object.getOwnPropertyDescriptor(item,key);if(!field)continue;if(!('value'in field))throw Error('DIAGNOSTIC_ACCESSOR');bytes+=key.length*12+6+walk(field.value,depth+1);}}
  }finally{ancestors.delete(item);}if(!Number.isSafeInteger(bytes))throw Error('DIAGNOSTIC_MODEL_LIMIT');return bytes;
 };
 return walk(value,0);
}

export type DiagnosticRead<T>=Readonly<{readonly value:T;release():void}>;
/** One copy plus two conservative serialization/transport payload allowances.
 * Callers retain the read through native extraction and release in finally. */
export class DiagnosticReads {
 private active=0;private closed=false;
 constructor(private readonly owner:string,private readonly maximum=4,private readonly memory=diagnosticMemory){if(!Number.isInteger(maximum)||maximum<1||maximum>8)throw Error('DIAGNOSTIC_READ_LIMIT');}
 read<T>(logicalBytes:number,copy:()=>T):DiagnosticRead<T>{
  if(!Number.isSafeInteger(logicalBytes)||logicalBytes<0)throw Error('DIAGNOSTIC_ALLOWANCE');
  if(this.closed)throw Error('DIAGNOSTIC_CLOSED');if(this.active>=this.maximum)throw Error('DIAGNOSTIC_READ_LIMIT');
  const lease=this.memory.reserve(this.owner,logicalBytes*3+65536);this.active++;let value:T|undefined;
  try{value=copy();}catch(error){this.active--;lease.release();throw error;}
  let live=true;return Object.freeze({get value(){if(!live)throw Error('DIAGNOSTIC_READ_RELEASED');return value!;},release:()=>{if(!live)return;lease.release();live=false;value=undefined;this.active--;}});
 }
 close(){this.closed=true;}
 get pending(){return this.active;}
}
