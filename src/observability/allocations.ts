/** Bounded synchronous observation of owned reservation transitions. This is
 * conservative storage ownership, never RSS, physical GPU or allocator usage.
 * Shared control/prompt/upload/parse bookkeeping is deliberately included. */
export const TEXT_RESOURCE_CPU_KINDS=Object.freeze(['font','text','control','prompt','staging','scratch','copy'] as const);
export const TEXT_RESOURCE_ROW_LIMIT=4096;
export const TEXT_RESOURCE_OBSERVER_BYTES=65536+TEXT_RESOURCE_ROW_LIMIT*512;
export type TextResourcePoint=Readonly<{atMs:number;ledgerSequence:number;textSequence:number;cpu:readonly number[];poolTextBytes:number;glyphGpuBytes:number}>;
type Row=TextResourcePoint&Readonly<{sequence:number}>;
type Ack=Readonly<{kind:'text-resource-window-ack-1';schemaVersion:1;ledgerInstanceId:string;id:string;ordinal:number;boundary:'begin'|'end';atMs:number;clockOriginMs:number;ledgerSequence:number;textSequence:number;sealed:boolean}>;
type Window={kind:'text-resource-window-1';schemaVersion:1;scope:'font-shaping-conservative-owned-reservations';ledgerInstanceId:string;id:string;ordinal:number;clock:'browser-performance';clockOriginMs:number;cpuKinds:typeof TEXT_RESOURCE_CPU_KINDS;initial:Row;final:Row|null;rows:Row[];peakCpu:Readonly<{bytes:number;sequence:number}>;peakGlyphGpu:Readonly<{bytes:number;sequence:number}>;sealed:boolean;observationComplete:boolean;failures:string[];dropped:number;transitionCount:number};
const natural=(value:number)=>Number.isSafeInteger(value)&&value>=0;
const valid=(point:TextResourcePoint)=>Number.isFinite(point.atMs)&&point.atMs>=0&&natural(point.ledgerSequence)&&natural(point.textSequence)&&point.cpu.length===TEXT_RESOURCE_CPU_KINDS.length&&point.cpu.every(natural)&&natural(point.poolTextBytes)&&natural(point.glyphGpuBytes)&&natural(point.cpu.reduce((sum,value)=>sum+value,point.poolTextBytes));
const cpu=(point:TextResourcePoint)=>point.cpu.reduce((sum,value)=>sum+value,point.poolTextBytes);
const row=(point:TextResourcePoint,sequence:number):Row=>Object.freeze({...point,cpu:Object.freeze([...point.cpu]),sequence});
export class TextResourceObservations {
 private window:Window|null=null;private last:Row|null=null;private ordinal=0;private beginAck:Ack|null=null;private endAck:Ack|null=null;
 constructor(private readonly ledgerInstanceId:string,private readonly clockOriginMs:number){}
 fail(reason:string){const w=this.window;if(!w||w.sealed)return;w.observationComplete=false;if(!w.failures.includes(reason))w.failures.push(reason);}
 observe(point:TextResourcePoint){
  const w=this.window;if(!w||w.sealed)return;
  if(!valid(point)){this.fail('invalid-point');return;}
  const previous=this.last!;
  const ledgerDelta=point.ledgerSequence-previous.ledgerSequence,textDelta=point.textSequence-previous.textSequence;
  if(point.atMs<previous.atMs){this.fail('clock-regression');return;}
  if(ledgerDelta===0&&textDelta===0){if(cpu(point)!==cpu(previous)||point.poolTextBytes!==previous.poolTextBytes||point.glyphGpuBytes!==previous.glyphGpuBytes||point.cpu.some((value,index)=>value!==previous.cpu[index]))this.fail('same-sequence-changed-amounts');return;}
  if(![0,1].includes(ledgerDelta)||![0,1].includes(textDelta)||ledgerDelta+textDelta!==1)this.fail('transition-gap');
  w.transitionCount++;if(!natural(w.transitionCount)){this.fail('counter-overflow');return;}
  const next=row(point,w.transitionCount);this.last=next;
  if(w.rows.length<TEXT_RESOURCE_ROW_LIMIT)w.rows.push(next);else{w.dropped++;this.fail('row-limit');}
  if(cpu(next)>w.peakCpu.bytes)w.peakCpu=Object.freeze({bytes:cpu(next),sequence:next.sequence});
  if(next.glyphGpuBytes>w.peakGlyphGpu.bytes)w.peakGlyphGpu=Object.freeze({bytes:next.glyphGpuBytes,sequence:next.sequence});
 }
 begin(id:string,point:TextResourcePoint):Ack{
  if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(id))throw Error('TEXT_RESOURCE_WINDOW_ID');
  if(this.window?.id===id)return this.beginAck!;
  if(this.window&&!this.window.sealed)throw Error('TEXT_RESOURCE_WINDOW_ACTIVE');
  if(!valid(point)||!Number.isFinite(this.clockOriginMs)||this.clockOriginMs<0)throw Error('TEXT_RESOURCE_WINDOW_POINT');
  const initial=row(point,0);this.last=initial;this.endAck=null;
  this.window={kind:'text-resource-window-1',schemaVersion:1,scope:'font-shaping-conservative-owned-reservations',ledgerInstanceId:this.ledgerInstanceId,id,ordinal:++this.ordinal,clock:'browser-performance',clockOriginMs:this.clockOriginMs,cpuKinds:TEXT_RESOURCE_CPU_KINDS,initial,final:null,rows:[],peakCpu:Object.freeze({bytes:cpu(initial),sequence:0}),peakGlyphGpu:Object.freeze({bytes:initial.glyphGpuBytes,sequence:0}),sealed:false,observationComplete:true,failures:[],dropped:0,transitionCount:0};
  return this.beginAck=this.ack('begin',point,false);
 }
 end(id:string,point:TextResourcePoint):Ack{
  if(!this.window||id!==this.window.id)throw Error('TEXT_RESOURCE_WINDOW_ID');
  if(this.endAck)return this.endAck;
  this.observe(point);this.window.final=row(point,this.window.transitionCount);this.window.sealed=true;
  return this.endAck=this.ack('end',point,true);
 }
 private ack(boundary:'begin'|'end',point:TextResourcePoint,sealed:boolean):Ack{const w=this.window!;return Object.freeze({kind:'text-resource-window-ack-1',schemaVersion:1,ledgerInstanceId:this.ledgerInstanceId,id:w.id,ordinal:w.ordinal,boundary,atMs:point.atMs,clockOriginMs:this.clockOriginMs,ledgerSequence:point.ledgerSequence,textSequence:point.textSequence,sealed});}
 copy(){const w=this.window;return w?Object.freeze({...w,rows:Object.freeze([...w.rows]),failures:Object.freeze([...w.failures])}):null;}
}

import {diagnosticMemory,observeTextReservationSource} from './diagnostic-memory.js';
import {compositionObservations,type CompositionObservations} from './composition-observations.js';
/** Reservations for storage whose lifetime is controlled by application code.
 * These are conservative byte allowances, not JS heap, process RSS or physical
 * GPU measurements. Display surfaces have bounded RGBA backing estimates;
 * native implementation overhead remains observable only through independent RSS.
 */
export const ALLOCATION_LIMITS = Object.freeze({cpuBytes:512*1024**2,gpuBytes:384*1024**2,previewCacheBytes:128*1024**2,promptBytes:64*1024**2,textPartitionBytes:128*1024**2,handles:16384,records:4096});
export type AllocationKind='copy'|'staging'|'scratch'|'blob'|'font'|'text'|'canvas'|'bitmap'|'prompt'|'control';
export type AllocationAmounts={cpuBytes?:number;gpuBytes?:number;previewCacheBytes?:number;handles?:number};
type Amounts=Required<AllocationAmounts>;
export type AllocationLease=Readonly<{resize(amounts:AllocationAmounts):void;markUnused():void;release():void}>;
export type ObservedPromptLease=AllocationLease&Readonly<{observeCPUBytes(bytes:number):void;reconcileCPUBytes(bytes:number):void}>;
type Entry=Amounts&{owner:string;kind:AllocationKind;unused:boolean};
const keys=['cpuBytes','gpuBytes','previewCacheBytes','handles'] as const;
const kinds=new Set<AllocationKind>(['copy','staging','scratch','blob','font','text','canvas','bitmap','prompt','control']);
const empty=():Amounts=>({cpuBytes:0,gpuBytes:0,previewCacheBytes:0,handles:0});
export const COMBINED_CPU_OBSERVER_BYTES=65536;
const combinedMissing=Object.freeze(['app-payload-ownership-incomplete','native-image-and-canvas-implementation-overhead','native-blob-residency','engine-and-dom-allocations','renderer-ownership-proof-required']);
type TextObservation=Readonly<{textBytes:number;sequence:number;observerFaults:number;observing:boolean}>;
type TextReservationSource={observeReservations?:(observer:(bytes:number,sequence:number,faults:number)=>void)=>()=>void;readonly reservationObservation?:TextObservation};
type ObservationFailure='text-observer-unavailable'|'text-observer-rebound'|'text-observer-disconnected'|'text-sequence-discontinuity'|'text-observer-fault'|'text-observation-invalid'|'clock-invalid'|'observer-reentrant';
type CpuWindowAck=Readonly<{kind:'combined-cpu-window-ack-1';schemaVersion:1;ledgerInstanceId:string;id:string;ordinal:number;boundary:'begin'|'end';sequence:number;atMs:number;clock:'browser-performance';clockOriginMs:number;sealed:boolean}>;
type CpuWindow={kind:'combined-cpu-window-1';schemaVersion:1;ledgerInstanceId:string;id:string;ordinal:number;clock:'browser-performance';clockOriginMs:number;startMs:number;endMs:number|null;peakAtMs:number;startSequence:number;endSequence:number|null;peakSequence:number;currentBytes:number;peakBytes:number;ledgerBytesAtPeak:number;textBytesAtPeak:number;textStartSequence:number;textEndSequence:number|null;sealed:boolean;observationComplete:boolean;ownerCoverageComplete:false;failures:ObservationFailure[];missing:readonly string[]};
type OwnershipFailure='counter-overflow'|'kind-reconciliation'|'sequence-reconciliation'|'cpu-window-binding'|'observer-incomplete';
type OwnershipLive=Amounts&{records:number};
type OwnershipTransitions={reserved:number;resized:number;released:number;observed:number};
type OwnershipTally={transitions:OwnershipTransitions;added:Amounts;removed:Amounts};
type OwnershipKind=Readonly<{kind:AllocationKind;initial:Readonly<OwnershipLive>;current:Readonly<OwnershipLive>;transitions:Readonly<OwnershipTransitions>;added:Readonly<Amounts>;removed:Readonly<Amounts>}>;
type OwnershipWindow=Readonly<{kind:'app-ownership-window-1';schemaVersion:1;scope:'application-owned-conservative-reservations';ledgerInstanceId:string;id:string;ordinal:number;clock:'browser-performance';clockOriginMs:number;startMs:number;endMs:number|null;cpuStartSequence:number;cpuEndSequence:number|null;ledgerStartSequence:number;ledgerEndSequence:number|null;lastTransitionSequence:number;sealed:boolean;budgetRefusals:number;kinds:readonly OwnershipKind[];text:Readonly<{initialBytes:number|null;currentBytes:number|null;startSequence:number;endSequence:number|null;observationComplete:boolean}>;peaks:Readonly<{gpuBytes:number;previewCacheBytes:number;handles:number}>;observationComplete:boolean;reconciled:boolean;failures:readonly OwnershipFailure[];globalCoverageComplete:false}>;
const freshTally=():OwnershipTally=>({transitions:{reserved:0,resized:0,released:0,observed:0},added:empty(),removed:empty()});
const ownershipTallies=()=>Object.fromEntries([...kinds].map(kind=>[kind,freshTally()])) as Record<AllocationKind,OwnershipTally>;
function amounts(value:AllocationAmounts,previous=empty()):Amounts{
  const result={...previous};
  for(const key of keys)if(value[key]!==undefined){const count=value[key]!;if(!Number.isSafeInteger(count)||count<0)throw Error('ALLOCATION_INVALID');result[key]=count;}
  // Cache bytes are a subset of charged storage, never an extra allowance.
  if(result.previewCacheBytes>result.cpuBytes+result.gpuBytes)throw Error('ALLOCATION_INVALID');
  return result;
}
export class AllocationLedger {
  constructor(private readonly compositionObserver?:CompositionObservations,private readonly now:()=>number=()=>performance.now()){}
  private entries=new Map<number,Entry>();private serial=0;private totals=empty();private peaks=empty();private refusals=0;private promptBytes=0;private promptPeakBytes=0;
  private readText:()=>number=()=>0;private textObservedPeakBytes=0;
  private readonly ledgerInstanceId=crypto.randomUUID();private readonly clockOriginMs=performance.timeOrigin;
  private textSource:TextReservationSource|undefined;private detachText:(()=>void)|undefined;private textSequence=-1;private textFaults=0;private observingCombined=false;private observationFaultSerial=0;private lastObservationFailure:ObservationFailure='text-observer-unavailable';
  private combinedSequence=0;private combinedCurrentBytes=0;private combinedObservedPeakBytes=0;private combinedLastAtMs:number|null=null;private windowOrdinal=0;private cpuWindow:CpuWindow|null=null;private beginAck:CpuWindowAck|null=null;private endAck:CpuWindowAck|null=null;
  private verifiedTextSequence:number|null=null;private lastAppPoint:Readonly<{atMs:number;cpuSequence:number;transitionSequence:number;centralCpuBytes:number;textBytes:number;textSequence:number;gpuBytes:number;previewCacheBytes:number;handles:number}>|null=null;
  private readonly textResources=new TextResourceObservations(this.ledgerInstanceId,this.clockOriginMs);
  private textStartupBegin:ReturnType<TextResourceObservations['begin']>|null=null;private textStartupEnd:ReturnType<TextResourceObservations['end']>|null=null;private textStartupReplaced=false;
  private readonly textResourceCpu=TEXT_RESOURCE_CPU_KINDS.map(()=>0);private textResourceGlyphGpu=0;
  private ownershipSequence=0;private ownershipCounters=ownershipTallies();private ownershipOverflow=false;
  private ownershipInitial:{sequence:number;refusals:number;live:Record<AllocationKind,OwnershipLive>;counters:Record<AllocationKind,OwnershipTally>;textBytes:number|null}|null=null;
  private ownershipFinal:OwnershipWindow|null=null;private ownershipPeaks={gpuBytes:0,previewCacheBytes:0,handles:0};private ownershipFailures:OwnershipFailure[]=[];
  // Text's sealed MemoryPool already enforces 128 MiB for every text booking.
  // Reserve that admission capacity independently of current use. Its 384 MiB
  // backend mirror is NOT a browser allocation and must never be charged here.
  observeTextReservations(read:()=>number,source?:TextReservationSource){
    // Several controllers share the same pool. Re-registration must not open a
    // notification gap, reset a peak, or mint a second subscription.
    if(source&&source===this.textSource&&this.detachText){this.readText=read;this.textBytes();return;}
    this.observationFailure('text-observer-rebound');
    try{this.detachText?.();}catch{this.observationFailure('text-observer-fault');}
    this.detachText=undefined;this.textSource=source;this.textSequence=-1;this.textFaults=0;this.readText=read;this.textBytes();
    if(typeof source?.observeReservations==='function'){
      try{this.detachText=source.observeReservations((bytes,sequence,faults)=>this.textChanged(bytes,sequence,faults));}
      catch{this.observationFailure('text-observer-fault');}
    }
    this.observeCombined();
    if(!this.textStartupBegin&&this.lastAppPoint&&this.detachText){this.textStartupBegin=this.textResources.begin('startup-'+this.ledgerInstanceId,this.textResourcePoint());}
  }
  private textBytes(updateSampledPeak=true){const bytes=this.readText();if(!Number.isSafeInteger(bytes)||bytes<0||bytes>ALLOCATION_LIMITS.textPartitionBytes)throw Error('ALLOCATION_TEXT_OBSERVER');if(updateSampledPeak)this.textObservedPeakBytes=Math.max(this.textObservedPeakBytes,bytes);return bytes;}
  private observationFailure(reason:ObservationFailure){this.textResources.fail(reason);this.observationFaultSerial++;this.lastObservationFailure=reason;const window=this.cpuWindow;if(window&&!window.sealed){window.observationComplete=false;if(!window.failures.includes(reason))window.failures.push(reason);}}
  private sourceObservation(){
    const state=this.textSource?.reservationObservation;
    if(!state||!Number.isSafeInteger(state.sequence)||state.sequence<0||!Number.isSafeInteger(state.observerFaults)||state.observerFaults<0||!Number.isSafeInteger(state.textBytes)||state.textBytes<0||state.textBytes>ALLOCATION_LIMITS.textPartitionBytes||typeof state.observing!=='boolean')throw Error('ALLOCATION_TEXT_OBSERVATION');
    return state;
  }
  private verifyTextSource(bytes:number){
    if(!this.detachText)this.observationFailure('text-observer-unavailable');
    if(!this.textSource)return true; // Legacy sampled getter, explicitly incomplete.
    try{const state=this.sourceObservation();
      if(!state.observing)this.observationFailure('text-observer-disconnected');
      if(state.sequence!==this.textSequence)this.observationFailure('text-sequence-discontinuity');
      if(state.observerFaults!==this.textFaults)this.observationFailure('text-observer-fault');
      if(state.textBytes!==bytes){this.observationFailure('text-observation-invalid');return false;}
      if(this.detachText&&state.observing&&state.sequence===this.textSequence&&state.observerFaults===this.textFaults)this.verifiedTextSequence=state.sequence;
      return true;
    }catch{this.observationFailure('text-observation-invalid');return false;}
  }
  private textChanged(bytes:number,sequence:number,faults:number){
    if(this.observingCombined){this.observationFailure('observer-reentrant');return;}
    if(!Number.isSafeInteger(sequence)||sequence<0||!Number.isSafeInteger(faults)||faults<0){this.observationFailure('text-observation-invalid');return;}
    if(this.textSequence>=0&&sequence!==this.textSequence+1)this.observationFailure('text-sequence-discontinuity');
    if(faults!==this.textFaults)this.observationFailure('text-observer-fault');
    this.textSequence=sequence;this.textFaults=faults;
    // Read the real current value as well: a stale callback must never combine
    // a released text reservation with a later central allocation.
    this.observeCombined(bytes);
  }
  private observeCombined(notifiedBytes?:number){
    if(this.observingCombined){this.lastAppPoint=null;this.observationFailure('observer-reentrant');return null;}
    this.observingCombined=true;this.lastAppPoint=null;this.verifiedTextSequence=null;const faultSerial=this.observationFaultSerial;
    try{const text=this.textBytes(false);if(notifiedBytes!==undefined&&notifiedBytes!==text){this.observationFailure('text-observation-invalid');return null;}if(!this.verifyTextSource(text))return null;
      const total=this.totals.cpuBytes+text;let atMs:number;
      try{atMs=this.now();}catch{this.observationFailure('clock-invalid');return null;}
      if(!Number.isFinite(atMs)||atMs<0||!Number.isFinite(this.clockOriginMs)||this.combinedLastAtMs!==null&&atMs<this.combinedLastAtMs){this.observationFailure('clock-invalid');return null;}
      this.combinedLastAtMs=atMs;this.combinedSequence++;this.combinedCurrentBytes=total;this.combinedObservedPeakBytes=Math.max(this.combinedObservedPeakBytes,total);
      const window=this.cpuWindow;if(window&&!window.sealed){window.currentBytes=total;
        if(total>window.peakBytes){window.peakBytes=total;window.peakAtMs=atMs;window.peakSequence=this.combinedSequence;window.ledgerBytesAtPeak=this.totals.cpuBytes;window.textBytesAtPeak=text;}}
      if(this.verifiedTextSequence!==null&&faultSerial===this.observationFaultSerial)this.lastAppPoint={atMs,cpuSequence:this.combinedSequence,transitionSequence:this.ownershipSequence,centralCpuBytes:this.totals.cpuBytes,textBytes:text,textSequence:this.verifiedTextSequence,gpuBytes:this.totals.gpuBytes,previewCacheBytes:this.totals.previewCacheBytes,handles:this.totals.handles};
      if(this.lastAppPoint)this.textResources.observe(this.textResourcePoint());
      return {atMs,sequence:this.combinedSequence,totalBytes:total,ledgerBytes:this.totals.cpuBytes,textBytes:text};
    }catch{this.observationFailure('text-observation-invalid');return null;}finally{this.observingCombined=false;}
  }
  private textResourcePoint():TextResourcePoint{const p=this.lastAppPoint;if(!p)throw Error('TEXT_RESOURCE_POINT_UNAVAILABLE');return {atMs:p.atMs,ledgerSequence:p.transitionSequence,textSequence:p.textSequence,cpu:this.textResourceCpu,poolTextBytes:p.textBytes,glyphGpuBytes:this.textResourceGlyphGpu};}
  beginTextResourceObservationWindow(id:string){this.assertMutation();this.observeCombined();if(this.textStartupBegin&&!this.textStartupEnd)this.textStartupEnd=this.textResources.end(this.textStartupBegin.id,this.textResourcePoint());this.textStartupReplaced=true;return this.textResources.begin(id,this.textResourcePoint());}
  endTextResourceObservationWindow(id:string){this.assertMutation();this.observeCombined();return this.textResources.end(id,this.textResourcePoint());}
  textResourceStartupIdentity(){return this.textStartupBegin?Object.freeze({ledgerInstanceId:this.ledgerInstanceId,clockOriginMs:this.clockOriginMs,begin:this.textStartupBegin,ended:this.textStartupEnd!==null}):null;}
  sealTextResourceStartupWindow(){this.assertMutation();if(!this.textStartupBegin||this.textStartupReplaced)throw Error('TEXT_RESOURCE_STARTUP_UNAVAILABLE');if(this.textStartupEnd)return Object.freeze({begin:this.textStartupBegin,end:this.textStartupEnd});this.observeCombined();this.textStartupEnd=this.textResources.end(this.textStartupBegin.id,this.textResourcePoint());return Object.freeze({begin:this.textStartupBegin,end:this.textStartupEnd});}
  copyTextResourceObservation(){return this.textResources.copy();}
  beginCpuObservationWindow(id:string):CpuWindowAck{
    this.assertMutation();
    if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(id))throw Error('ALLOCATION_WINDOW_ID');
    if(this.cpuWindow?.id===id)return this.beginAck!;
    if(this.cpuWindow&&!this.cpuWindow.sealed)throw Error('ALLOCATION_WINDOW_ACTIVE');
    // Rebaseline from actual current state only. Earlier unobserved history
    // cannot become a lifetime maximum or poison a later clean scoped window.
    const text=this.textBytes(false);let ready=false;
    try{const state=this.sourceObservation();ready=!!this.detachText&&state.observing&&state.textBytes===text;this.textSequence=state.sequence;this.textFaults=state.observerFaults;}catch{/* No synchronous source is explicitly incomplete. */}
    const faultSerial=this.observationFaultSerial,point=this.observeCombined();if(!point)throw Error('ALLOCATION_WINDOW_OBSERVATION');const ordinal=++this.windowOrdinal,failures:ObservationFailure[]=ready?[]:['text-observer-unavailable'];
    if(faultSerial!==this.observationFaultSerial&&!failures.includes(this.lastObservationFailure))failures.push(this.lastObservationFailure);
    this.cpuWindow={kind:'combined-cpu-window-1',schemaVersion:1,ledgerInstanceId:this.ledgerInstanceId,id,ordinal,clock:'browser-performance',clockOriginMs:this.clockOriginMs,startMs:point.atMs,endMs:null,peakAtMs:point.atMs,startSequence:point.sequence,endSequence:null,peakSequence:point.sequence,currentBytes:point.totalBytes,peakBytes:point.totalBytes,ledgerBytesAtPeak:point.ledgerBytes,textBytesAtPeak:point.textBytes,textStartSequence:Math.max(0,this.textSequence),textEndSequence:null,sealed:false,observationComplete:ready&&failures.length===0,ownerCoverageComplete:false,failures,missing:combinedMissing};
    this.ownershipInitial={sequence:this.ownershipSequence,refusals:this.refusals,live:this.ownershipLive(),counters:structuredClone(this.ownershipCounters),textBytes:ready?point.textBytes:null};
    this.ownershipPeaks={gpuBytes:this.totals.gpuBytes,previewCacheBytes:this.totals.previewCacheBytes,handles:this.totals.handles};this.ownershipFinal=null;this.ownershipFailures=[];
    this.endAck=null;return this.beginAck=this.windowAck('begin',point.atMs,false);
  }
  endCpuObservationWindow(id:string):CpuWindowAck{
    this.assertMutation();
    if(typeof id!=='string'||!this.cpuWindow||this.cpuWindow.id!==id)throw Error('ALLOCATION_WINDOW_ID');
    if(this.endAck)return this.endAck;
    const point=this.observeCombined();if(!point)throw Error('ALLOCATION_WINDOW_OBSERVATION');const window=this.cpuWindow;
    window.endMs=point.atMs;window.endSequence=point.sequence;window.textEndSequence=Math.max(0,this.textSequence);window.sealed=true;
    this.ownershipFinal=this.ownershipWindow();
    return this.endAck=this.windowAck('end',point.atMs,true);
  }
  private windowAck(boundary:'begin'|'end',atMs:number,sealed:boolean):CpuWindowAck{const window=this.cpuWindow!;return Object.freeze({kind:'combined-cpu-window-ack-1',schemaVersion:1,ledgerInstanceId:this.ledgerInstanceId,id:window.id,ordinal:window.ordinal,boundary,sequence:this.combinedSequence,atMs,clock:'browser-performance',clockOriginMs:this.clockOriginMs,sealed});}
  private combinedSnapshot(){const window=this.cpuWindow;return Object.freeze({kind:'combined-cpu-observation-1' as const,schemaVersion:1 as const,scope:'browser-ledger-plus-text-reservations' as const,ledgerInstanceId:this.ledgerInstanceId,sequence:this.combinedSequence,currentBytes:this.combinedCurrentBytes,observedPeakBytes:this.combinedObservedPeakBytes,observationComplete:false,ownerCoverageComplete:false,missing:combinedMissing,window:window?Object.freeze({...window,failures:Object.freeze([...window.failures])}):null});}
  private check(next:Amounts){
    if(keys.some(key=>!Number.isSafeInteger(next[key])||next[key]>ALLOCATION_LIMITS[key]-(key==='cpuBytes'?ALLOCATION_LIMITS.textPartitionBytes:0))){this.refusals++;throw Error('ALLOCATION_BUDGET');}
  }
  checkAdditional(value:AllocationAmounts){const add=amounts(value),next=empty();for(const key of keys)next[key]=this.totals[key]+add[key];this.check(next);}
  private checkPrompt(next:number){if(next>ALLOCATION_LIMITS.promptBytes){this.refusals++;throw Error('PROMPT_MEMORY_BUDGET');}}
  private assertMutation(){if(this.observingCombined){this.observationFailure('observer-reentrant');throw Error('ALLOCATION_OBSERVER_REENTRANCY');}}
  reserve(value:AllocationAmounts&{owner:string;kind:AllocationKind}):AllocationLease{
    return this.reserveEntry(value,false);
  }
  reserveObservedPrompt(value:{owner:string;cpuBytes:number;handles:number}):ObservedPromptLease{
    return this.reserveEntry({...value,kind:'prompt'},true) as ObservedPromptLease;
  }
  private reserveEntry(value:AllocationAmounts&{owner:string;kind:AllocationKind},observedPrompt:boolean):AllocationLease|ObservedPromptLease{
    this.assertMutation();
    if(!/^[a-z][a-z0-9-]{0,63}$/.test(value.owner)||!kinds.has(value.kind))throw Error('ALLOCATION_INVALID');
    if(this.entries.size>=ALLOCATION_LIMITS.records){this.refusals++;throw Error('ALLOCATION_BUDGET');}
    const booked=amounts(value);this.checkAdditional(booked);if(value.kind==='prompt')this.checkPrompt(this.promptBytes+booked.cpuBytes);const id=++this.serial;
    let admitted=booked,observedCPU=0;
    const entry:Entry={...booked,owner:value.owner,kind:value.kind,unused:false};this.entries.set(id,entry);
    if(entry.kind==='prompt'){this.promptBytes+=entry.cpuBytes;this.promptPeakBytes=Math.max(this.promptPeakBytes,this.promptBytes);}this.add(booked,entry.kind);
    if(entry.kind==='prompt')this.compositionObserver?.ownership(entry.owner,0,entry.cpuBytes,this.promptBytes);
    else if(entry.kind==='control')this.compositionObserver?.controlOwnership(entry.owner,0,entry.cpuBytes);
    let live=true;
    const lease={
      resize:(patch:AllocationAmounts)=>{if(!live)throw Error('ALLOCATION_RELEASED');this.assertMutation();const nextAdmitted=amounts(patch,admitted),next={...nextAdmitted,cpuBytes:Math.max(nextAdmitted.cpuBytes,observedCPU)},totals=empty();for(const key of keys)totals[key]=this.totals[key]-entry[key]+next[key];this.check(totals);const previous={...entry};if(entry.kind==='prompt'){const prompt=this.promptBytes-entry.cpuBytes+next.cpuBytes;this.checkPrompt(prompt);this.promptBytes=prompt;this.promptPeakBytes=Math.max(this.promptPeakBytes,prompt);}admitted=nextAdmitted;for(const key of keys)entry[key]=next[key];this.totals=totals;this.recordOwnership(entry.kind,'resized',previous,next);this.peak();if(entry.kind==='prompt')this.compositionObserver?.ownership(entry.owner,previous.cpuBytes,entry.cpuBytes,this.promptBytes);else if(entry.kind==='control')this.compositionObserver?.controlOwnership(entry.owner,previous.cpuBytes,entry.cpuBytes);},
      markUnused:()=>{if(live)entry.unused=true;},
      release:()=>{if(!live)return;this.assertMutation();live=false;this.entries.delete(id);for(const key of keys)this.totals[key]-=entry[key];if(entry.kind==='prompt')this.promptBytes-=entry.cpuBytes;this.recordOwnership(entry.kind,'released',entry,empty());this.observeCombined();if(entry.kind==='prompt')this.compositionObserver?.ownership(entry.owner,entry.cpuBytes,0,this.promptBytes);else if(entry.kind==='control')this.compositionObserver?.controlOwnership(entry.owner,entry.cpuBytes,0);},
    };
    if(!observedPrompt)return Object.freeze(lease);
    const observed=(bytes:number,replace:boolean)=>{
      if(!live)throw Error('ALLOCATION_RELEASED');this.assertMutation();if(!Number.isSafeInteger(bytes)||bytes<0)throw Error('ALLOCATION_INVALID');
      const floor=replace?bytes:Math.max(observedCPU,bytes);if(floor===observedCPU)return;
      const effective=Math.max(admitted.cpuBytes,floor),delta=effective-entry.cpuBytes;
      if(!Number.isSafeInteger(this.totals.cpuBytes+delta)||!Number.isSafeInteger(this.promptBytes+delta))throw Error('ALLOCATION_INVALID');
      const previous={...entry};observedCPU=floor;entry.cpuBytes=effective;this.totals.cpuBytes+=delta;this.promptBytes+=delta;this.promptPeakBytes=Math.max(this.promptPeakBytes,this.promptBytes);
      // The native value already exists. Recording it cannot grant admission,
      // clip its bytes or erase it because the ordinary partition is exceeded.
      this.recordOwnership(entry.kind,'observed',previous,entry);this.peak();this.compositionObserver?.ownership(entry.owner,previous.cpuBytes,entry.cpuBytes,this.promptBytes);
    };
    return Object.freeze({...lease,observeCPUBytes:(bytes:number)=>observed(bytes,false),reconcileCPUBytes:(bytes:number)=>observed(bytes,true)});
  }
  private add(value:Amounts,kind:AllocationKind){for(const key of keys)this.totals[key]+=value[key];this.recordOwnership(kind,'reserved',empty(),value);this.peak();}
  private peak(){for(const key of keys)this.peaks[key]=Math.max(this.peaks[key],this.totals[key]);this.observeCombined();}
  private recordOwnership(kind:AllocationKind,operation:keyof OwnershipTransitions,previous:Amounts,next:Amounts){
    const textKind=TEXT_RESOURCE_CPU_KINDS.indexOf(kind as typeof TEXT_RESOURCE_CPU_KINDS[number]);if(textKind>=0)this.textResourceCpu[textKind]+=next.cpuBytes-previous.cpuBytes;
    if(kind==='font'||kind==='text')this.textResourceGlyphGpu+=next.gpuBytes-previous.gpuBytes;
    // Fixed counters only: no owner labels or payloads are retained.
    const sequence=this.ownershipSequence+1;if(!Number.isSafeInteger(sequence)){this.ownershipOverflow=true;return;}this.ownershipSequence=sequence;
    if(this.cpuWindow&&!this.cpuWindow.sealed)for(const key of ['gpuBytes','previewCacheBytes','handles'] as const)this.ownershipPeaks[key]=Math.max(this.ownershipPeaks[key],this.totals[key]);
    if(this.ownershipOverflow)return;
    const counter=this.ownershipCounters[kind],added=empty(),removed=empty();
    for(const key of keys){added[key]=counter.added[key]+Math.max(0,next[key]-previous[key]);removed[key]=counter.removed[key]+Math.max(0,previous[key]-next[key]);}
    if(!Number.isSafeInteger(counter.transitions[operation]+1)||keys.some(key=>!Number.isSafeInteger(added[key])||!Number.isSafeInteger(removed[key]))){this.ownershipOverflow=true;return;}
    counter.transitions[operation]++;counter.added=added;counter.removed=removed;
  }
  private ownershipLive(){
    const live=Object.fromEntries([...kinds].map(kind=>[kind,{records:0,...empty()}])) as Record<AllocationKind,OwnershipLive>;
    for(const entry of this.entries.values()){live[entry.kind].records++;for(const key of keys)live[entry.kind][key]+=entry[key];}
    return live;
  }
  private ownershipPoint(){
    // Consume only the current successful guarded observation. Reading a source
    // getter here could reenter ownership after the live-kind census was taken.
    const live=this.ownershipLive(),point=this.lastAppPoint;
    const complete=!!point&&point.cpuSequence===this.combinedSequence&&point.transitionSequence===this.ownershipSequence&&point.centralCpuBytes===this.totals.cpuBytes&&point.centralCpuBytes+point.textBytes===this.combinedCurrentBytes&&point.gpuBytes===this.totals.gpuBytes&&point.previewCacheBytes===this.totals.previewCacheBytes&&point.handles===this.totals.handles;
    const text=complete?point!.textBytes:null,textSequence=complete?point!.textSequence:null;
    const rows=Object.freeze([...kinds].map(kind=>Object.freeze({kind,...live[kind]})));
    return Object.freeze({kind:'app-ownership-point-1' as const,schemaVersion:1 as const,ledgerInstanceId:this.ledgerInstanceId,transitionSequence:this.ownershipSequence,cpuSequence:this.combinedSequence,clock:'browser-performance' as const,clockOriginMs:this.clockOriginMs,atMs:complete?point!.atMs:null,
      totals:Object.freeze({...this.totals,cpuBytes:text===null?null:this.totals.cpuBytes+text}),centralCpuBytes:this.totals.cpuBytes,textBytes:text,textSequence,kinds:rows,observationComplete:complete&&!this.ownershipOverflow,globalCoverageComplete:false as const});
  }
  private ownershipWindow():OwnershipWindow|null{
    const window=this.cpuWindow,initial=this.ownershipInitial;if(!window||!initial)return null;
    const failures:OwnershipFailure[]=[...this.ownershipFailures],live=this.ownershipLive(),safe=(value:number)=>Number.isSafeInteger(value)&&value>=0,fail=(reason:OwnershipFailure)=>{if(!failures.includes(reason))failures.push(reason);};
    if(this.ownershipOverflow)fail('counter-overflow');
    let count=0n,kindValid=true;
    const balanced=(initial:number,added:number,removed:number,current:number)=>[initial,added,removed,current].every(safe)&&BigInt(initial)+BigInt(added)-BigInt(removed)===BigInt(current);
    const rows=[...kinds].map(kind=>{
      const before=initial.counters[kind],after=this.ownershipCounters[kind],transitions={reserved:0,resized:0,released:0,observed:0},added=empty(),removed=empty();
      for(const operation of ['reserved','resized','released','observed'] as const){transitions[operation]=after.transitions[operation]-before.transitions[operation];if(safe(transitions[operation]))count+=BigInt(transitions[operation]);else kindValid=false;}
      for(const key of keys){added[key]=after.added[key]-before.added[key];removed[key]=after.removed[key]-before.removed[key];if(!balanced(initial.live[kind][key],added[key],removed[key],live[kind][key]))kindValid=false;}
      if(!balanced(initial.live[kind].records,transitions.reserved,transitions.released,live[kind].records))kindValid=false;
      return Object.freeze({kind,initial:Object.freeze({...initial.live[kind]}),current:Object.freeze({...live[kind]}),transitions:Object.freeze(transitions),added:Object.freeze(added),removed:Object.freeze(removed)});
    });
    if(!kindValid)fail('kind-reconciliation');
    const sequenceValid=count===BigInt(this.ownershipSequence)-BigInt(initial.sequence);if(!sequenceValid)fail('sequence-reconciliation');
    const point=this.ownershipPoint(),cpuBound=point.observationComplete&&point.totals.cpuBytes===window.currentBytes&&point.cpuSequence>=window.startSequence;
    if(!cpuBound)fail('cpu-window-binding');
    if(!window.observationComplete||!point.observationComplete)fail('observer-incomplete');
    this.ownershipFailures=failures;
    return Object.freeze({kind:'app-ownership-window-1',schemaVersion:1,scope:'application-owned-conservative-reservations',ledgerInstanceId:this.ledgerInstanceId,id:window.id,ordinal:window.ordinal,clock:'browser-performance',clockOriginMs:window.clockOriginMs,startMs:window.startMs,endMs:window.endMs,cpuStartSequence:window.startSequence,cpuEndSequence:window.endSequence,
      ledgerStartSequence:initial.sequence,ledgerEndSequence:window.sealed?this.ownershipSequence:null,lastTransitionSequence:this.ownershipSequence,sealed:window.sealed,budgetRefusals:this.refusals-initial.refusals,kinds:Object.freeze(rows),
      text:Object.freeze({initialBytes:initial.textBytes,currentBytes:point.textBytes,startSequence:window.textStartSequence,endSequence:window.textEndSequence,observationComplete:window.observationComplete&&point.observationComplete}),peaks:Object.freeze({...this.ownershipPeaks}),observationComplete:failures.length===0,reconciled:!failures.some(reason=>reason==='counter-overflow'||reason==='kind-reconciliation'||reason==='sequence-reconciliation'),failures:Object.freeze(failures),globalCoverageComplete:false});
  }
  private ownershipSnapshot(){return Object.freeze({kind:'app-ownership-observation-1' as const,schemaVersion:1 as const,ledgerInstanceId:this.ledgerInstanceId,transitionSequence:this.ownershipSequence,point:this.ownershipPoint(),window:this.ownershipFinal??this.ownershipWindow()});}
  snapshot(){
    const textBytes=this.textBytes();this.observeCombined();
    const byKind=Object.fromEntries([...kinds].map(kind=>[kind,empty()])) as Record<AllocationKind,Amounts>;
    let unusedHandles=0;for(const entry of this.entries.values()){for(const key of keys)byKind[entry.kind][key]+=entry[key];if(entry.unused)unusedHandles+=entry.handles;}
    byKind.text.cpuBytes+=textBytes;
    return Object.freeze({schemaVersion:1 as const,...this.totals,cpuBytes:this.totals.cpuBytes+textBytes,unusedHandles,activeRecords:this.entries.size,peaks:Object.freeze({...this.peaks}),byKind,promptBytes:this.promptBytes,promptPeakBytes:this.promptPeakBytes,refusals:this.refusals,limits:ALLOCATION_LIMITS,
      peakScope:'lease-owners-only-text-observed-separately' as const,
      combinedCpu:this.combinedSnapshot(),
      appOwnership:this.ownershipSnapshot(),
      text:Object.freeze({ownedReservationBytes:textBytes,reservedAdmissionCapacityBytes:ALLOCATION_LIMITS.textPartitionBytes,observedPeakBytes:this.textObservedPeakBytes,peakBasis:'observed-at-ledger-snapshots' as const}),
      // No undocumented Canvas2D texture limit or physical allocation is inferred
      // from a canvas dimension. The independent RSS observer remains required.
      textureSide:null,deviceTextureLimit:null,complete:false,
      rendererOwnership:Object.freeze({contract:'canvas2d-owned-rgba-v1' as const,backend:'main-thread-canvas-2d' as const,appOwnedTextureAPIs:Object.freeze([] as string[]),appOwnedTextureCount:0,textureLimitApplicability:'not-applicable' as const,rgbaBackingEstimateBytes:this.totals.gpuBytes}),
      coverage:Object.freeze({cpu:false,gpu:false,previewCache:false,handles:false,textureLimits:false}),
      basis:'app-owned-conservative-reservations' as const,
      missing:Object.freeze(['app-payload-ownership-incomplete','native-image-and-canvas-implementation-overhead','native-blob-residency','engine-and-dom-allocations','renderer-ownership-proof-required']),
    });
  }
}
export const allocationLedger=new AllocationLedger(compositionObservations);
// All import-time diagnostic owners become actual central control leases before
// this module exposes the singleton to product allocation callers.
diagnosticMemory.adopt(value=>allocationLedger.reserve(value));
// Fixed retained numeric state, ten counter kinds, one current/last window and
// two acknowledgements. Snapshot-copy allowance belongs to its scoped read.
allocationLedger.reserve({owner:'combined-cpu-observer',kind:'control',cpuBytes:COMBINED_CPU_OBSERVER_BYTES});
// This observer is charged once to the same central control kind included in its peak.
allocationLedger.reserve({owner:'text-resource-observer',kind:'control',cpuBytes:TEXT_RESOURCE_OBSERVER_BYTES});
observeTextReservationSource(source=>allocationLedger.observeTextReservations(()=>source.reservationObservation.textBytes,source));

/** A native stream which has already errored rejects cancel() with its stored
 * error even though it is terminal. Capture its original closed promise while
 * the reader is owned: a genuine underlying-source cancel rejection instead
 * leaves that promise resolved. Never await a still-pending closed promise.
 * This observer does not release a reader lock or swallow a read failure. */
export class StreamReaderCompletion {
  private closedState:'pending'|'closed'|'errored'='pending';private closedReason:unknown;
  constructor(private readonly reader:ReadableStreamDefaultReader<Uint8Array>){
    // Native readers expose closed. Missing metadata in a boundary double is
    // no evidence of completed cleanup and remains conservative.
    const closed=reader.closed;if(closed)void closed.then(()=>{this.closedState='closed';},reason=>{this.closedState='errored';this.closedReason=reason;});
  }
  read(){return this.reader.read();}
  async cancel(){
    try{await this.reader.cancel();}catch(reason){
      await Promise.resolve();if(this.closedState!=='errored'||!Object.is(this.closedReason,reason))throw reason;
    }
  }
}
