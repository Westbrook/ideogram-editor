import {sanitizePhaseContext,type PhaseContext,type PhaseSnapshot} from '../../src/observability/phases.js';

export const ACTIVE_COMPUTE_RESERVATION_BYTES=65536;
export const ACTIVE_COMPUTE_INTERVAL_CAPACITY=128;
const kernels=['accumulator','contribution','fold','finish','preserve','resample','matte','coverage-scan'] as const;
export type RasterKernel=typeof kernels[number];
export type ActiveComputeSnapshot={
  schemaVersion:1;kind:'raster-active-compute-1';lane:'raster-worker';
  clockOriginUnixMs:number;clockUncertaintyMs:null;context:PhaseContext;
  boundary:'synchronous-kernel-elapsed-excluding-io';outcome:'completed'|'failed'|'incomplete';complete:boolean;
  startedMs:number|null;endedMs:number|null;unionMs:number;totalMs:number;intervalCount:number;
  intervals:{startMs:number;endMs:number}[];omittedIntervals:number;invalid:number;
  operations:Record<RasterKernel,number>;
};
export type RasterWorkerSnapshot=PhaseSnapshot&{activeCompute?:ActiveComputeSnapshot};

/** Single worker's streaming union. Samples are bounded; every interval still
 * contributes to the scalar total. This is elapsed kernel time, not CPU time:
 * GC and OS descheduling remain included. No cross-lane subtraction occurs. */
export class ActiveCompute {
  private readonly now:()=>number;private readonly capacity:number;private readonly origin:number;private readonly context:PhaseContext;
  private depth=0;private suspended=0;private activeStart:number|null=null;private first:number|null=null;private lastEnd:number|null=null;
  private lastClock=0;private invalid=0;private total=0;private compensation=0;private count=0;private failed=false;
  private readonly intervals:{startMs:number;endMs:number}[]=[];
  private readonly operations=Object.fromEntries(kernels.map(kind=>[kind,0])) as Record<RasterKernel,number>;
  private outcome:'completed'|'failed'|'incomplete'|undefined;
  constructor(options:{now?:()=>number;wallNow?:()=>number;capacity?:number;context?:PhaseContext}={}){
    this.now=options.now??(()=>performance.now());this.capacity=options.capacity??ACTIVE_COMPUTE_INTERVAL_CAPACITY;
    if(!Number.isSafeInteger(this.capacity)||this.capacity<1||this.capacity>ACTIVE_COMPUTE_INTERVAL_CAPACITY)throw Error('ACTIVE_COMPUTE_CAPACITY');
    this.context=sanitizePhaseContext(options.context??{});const at=this.clock(),origin=(options.wallNow??Date.now)()-at;
    if(!Number.isFinite(origin)){this.invalid++;this.origin=0;}else this.origin=origin;
  }
  private clock(){const value=this.now();if(!Number.isFinite(value)||value<0||value<this.lastClock){this.invalid++;return this.lastClock;}this.lastClock=value;return value;}
  private resume(){if(this.outcome===undefined&&this.depth&&this.suspended===0&&this.activeStart===null){this.activeStart=this.clock();this.first??=this.activeStart;}}
  private pause(){if(this.activeStart===null)return;const end=this.clock(),start=this.activeStart;this.activeStart=null;this.lastEnd=end;
    const increment=end-start-this.compensation,sum=this.total+increment;this.compensation=(sum-this.total)-increment;this.total=sum;this.count++;
    if(this.intervals.length<this.capacity)this.intervals.push({startMs:start,endMs:end});
    if(!Number.isSafeInteger(this.count)||!Number.isFinite(this.total))this.invalid++;
  }
  private synchronous<T>(work:()=>T):T {const value=work();if(value!==null&&(typeof value==='object'||typeof value==='function')&&'then' in value)throw Error('ACTIVE_COMPUTE_ASYNC');return value;}
  run<T>(kind:RasterKernel,work:()=>T):T {
    if(this.outcome!==undefined)throw Error('ACTIVE_COMPUTE_FINISHED');if(!kernels.includes(kind))throw Error('ACTIVE_COMPUTE_KERNEL');
    this.operations[kind]++;this.depth++;this.resume();
    try{return this.synchronous(work);}catch(error){this.failed=true;throw error;}
    finally{if(--this.depth===0)this.pause();}
  }
  /** Used only around the actual synchronous read syscall on a lazy row miss. */
  exclude<T>(work:()=>T):T {
    if(this.outcome!==undefined)throw Error('ACTIVE_COMPUTE_FINISHED');this.pause();this.suspended++;
    try{return this.synchronous(work);}catch(error){if(this.depth)this.failed=true;throw error;}
    finally{this.suspended--;this.resume();}
  }
  finish(outcome:'completed'|'failed'|'incomplete'='completed'){
    if(this.outcome===undefined){if(!['completed','failed','incomplete'].includes(outcome)){this.invalid++;outcome='incomplete';}if(this.depth||this.suspended){this.invalid++;this.pause();}this.outcome=this.failed||outcome==='failed'?'failed':outcome;}
    return this.snapshot();
  }
  snapshot():ActiveComputeSnapshot{return {schemaVersion:1,kind:'raster-active-compute-1',lane:'raster-worker',clockOriginUnixMs:this.origin,clockUncertaintyMs:null,context:{...this.context},boundary:'synchronous-kernel-elapsed-excluding-io',outcome:this.outcome??(this.failed?'failed':'incomplete'),complete:this.outcome==='completed'&&!this.failed&&!this.invalid&&!this.depth&&!this.suspended,
    startedMs:this.first,endedMs:this.lastEnd,unionMs:this.total,totalMs:this.total,intervalCount:this.count,intervals:this.intervals.map(interval=>({...interval})),omittedIntervals:this.count-this.intervals.length,invalid:this.invalid,operations:{...this.operations}};}
}
