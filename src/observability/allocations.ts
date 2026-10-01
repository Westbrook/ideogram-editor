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
type Entry=Amounts&{owner:string;kind:AllocationKind;unused:boolean};
const keys=['cpuBytes','gpuBytes','previewCacheBytes','handles'] as const;
const kinds=new Set<AllocationKind>(['copy','staging','scratch','blob','font','text','canvas','bitmap','prompt','control']);
const empty=():Amounts=>({cpuBytes:0,gpuBytes:0,previewCacheBytes:0,handles:0});
function amounts(value:AllocationAmounts,previous=empty()):Amounts{
  const result={...previous};
  for(const key of keys)if(value[key]!==undefined){const count=value[key]!;if(!Number.isSafeInteger(count)||count<0)throw Error('ALLOCATION_INVALID');result[key]=count;}
  // Cache bytes are a subset of charged storage, never an extra allowance.
  if(result.previewCacheBytes>result.cpuBytes+result.gpuBytes)throw Error('ALLOCATION_INVALID');
  return result;
}
export class AllocationLedger {
  private entries=new Map<number,Entry>();private serial=0;private totals=empty();private peaks=empty();private refusals=0;private promptBytes=0;private promptPeakBytes=0;
  private readText:()=>number=()=>0;private textObservedPeakBytes=0;
  // Text's sealed MemoryPool already enforces 128 MiB for every text booking.
  // Reserve that admission capacity independently of current use. Its 384 MiB
  // backend mirror is NOT a browser allocation and must never be charged here.
  observeTextReservations(read:()=>number){this.readText=read;this.textBytes();}
  private textBytes(){const bytes=this.readText();if(!Number.isSafeInteger(bytes)||bytes<0||bytes>ALLOCATION_LIMITS.textPartitionBytes)throw Error('ALLOCATION_TEXT_OBSERVER');this.textObservedPeakBytes=Math.max(this.textObservedPeakBytes,bytes);return bytes;}
  private check(next:Amounts){
    if(keys.some(key=>!Number.isSafeInteger(next[key])||next[key]>ALLOCATION_LIMITS[key]-(key==='cpuBytes'?ALLOCATION_LIMITS.textPartitionBytes:0))){this.refusals++;throw Error('ALLOCATION_BUDGET');}
  }
  checkAdditional(value:AllocationAmounts){const add=amounts(value),next=empty();for(const key of keys)next[key]=this.totals[key]+add[key];this.check(next);}
  private checkPrompt(next:number){if(next>ALLOCATION_LIMITS.promptBytes){this.refusals++;throw Error('PROMPT_MEMORY_BUDGET');}}
  reserve(value:AllocationAmounts&{owner:string;kind:AllocationKind}):AllocationLease{
    if(!/^[a-z][a-z0-9-]{0,63}$/.test(value.owner)||!kinds.has(value.kind))throw Error('ALLOCATION_INVALID');
    if(this.entries.size>=ALLOCATION_LIMITS.records){this.refusals++;throw Error('ALLOCATION_BUDGET');}
    const booked=amounts(value);this.checkAdditional(booked);if(value.kind==='prompt')this.checkPrompt(this.promptBytes+booked.cpuBytes);const id=++this.serial;
    const entry:Entry={...booked,owner:value.owner,kind:value.kind,unused:false};this.entries.set(id,entry);this.add(booked);
    if(entry.kind==='prompt'){this.promptBytes+=entry.cpuBytes;this.promptPeakBytes=Math.max(this.promptPeakBytes,this.promptBytes);}
    let live=true;
    return Object.freeze({
      resize:(patch:AllocationAmounts)=>{if(!live)throw Error('ALLOCATION_RELEASED');const next=amounts(patch,entry),totals=empty();for(const key of keys)totals[key]=this.totals[key]-entry[key]+next[key];this.check(totals);if(entry.kind==='prompt'){const prompt=this.promptBytes-entry.cpuBytes+next.cpuBytes;this.checkPrompt(prompt);this.promptBytes=prompt;this.promptPeakBytes=Math.max(this.promptPeakBytes,prompt);}for(const key of keys)entry[key]=next[key];this.totals=totals;this.peak();},
      markUnused:()=>{if(live)entry.unused=true;},
      release:()=>{if(!live)return;live=false;this.entries.delete(id);for(const key of keys)this.totals[key]-=entry[key];if(entry.kind==='prompt')this.promptBytes-=entry.cpuBytes;},
    });
  }
  private add(value:Amounts){for(const key of keys)this.totals[key]+=value[key];this.peak();}
  private peak(){for(const key of keys)this.peaks[key]=Math.max(this.peaks[key],this.totals[key]);}
  snapshot(){
    const textBytes=this.textBytes();
    const byKind=Object.fromEntries([...kinds].map(kind=>[kind,empty()])) as Record<AllocationKind,Amounts>;
    let unusedHandles=0;for(const entry of this.entries.values()){for(const key of keys)byKind[entry.kind][key]+=entry[key];if(entry.unused)unusedHandles+=entry.handles;}
    byKind.text.cpuBytes+=textBytes;
    return Object.freeze({schemaVersion:1 as const,...this.totals,cpuBytes:this.totals.cpuBytes+textBytes,unusedHandles,activeRecords:this.entries.size,peaks:Object.freeze({...this.peaks}),byKind,promptBytes:this.promptBytes,promptPeakBytes:this.promptPeakBytes,refusals:this.refusals,limits:ALLOCATION_LIMITS,
      peakScope:'lease-owners-only-text-observed-separately' as const,
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
export const allocationLedger=new AllocationLedger();

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
