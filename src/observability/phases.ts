import {diagnosticMemory,diagnosticPayloadBytes,DiagnosticReads,type DiagnosticRead,type DiagnosticLease,type DiagnosticMemory} from './diagnostic-memory.js';
/** Bounded, non-authoritative PERF §8 telemetry. No command contents or remote URLs. */
export const PHASES = [
  'ui.intent','ui.feedback','component.proposal','frame.app_work','raster.fallback_slice',
  'command.validate','command.accept','event.append','raster.prepare','asset.stage','upload',
  'job.local_queue','job.eligible','job.submit','job.provider_queue','job.provider_run','job.observe','reconnect',
  'job.cancel_requested','reconcile','result.fetch','result.verify','result.store',
  'result.candidate_available','result.prepare','result.preserve','result.adopt',
  'text.edit','text.layout','font.ready','composition.parse','composition.project','composition.serialize',
  'source.capture','mask.plan','project.copy','project.import','reopen',
  'dataset.prepare','training.register','document.snapshot','document.replay','document.export',
  'raster.decode','raster.composite','raster.resample','raster.encode','result.viewport_decode',
] as const;
export type PhaseName = typeof PHASES[number];
export type PhaseOutcome = 'ok'|'rejected'|'error'|'cancelled'|'incomplete'|'uncertain';
export type PhaseContext = {
  commandId?:string; documentId?:string; layerId?:string; sessionId?:string; generation?:number; snapshotId?:string; workspaceSeq?:string; revision?:string; resultingRevision?:string; transactionId?:string;
  correlationId?:string; jobId?:string; attemptId?:string; providerRequestId?:string;
  assetId?:string; outputAssetId?:string; assetHash?:string; candidateId?:string; previewId?:string;
  datasetVersion?:string; adapterVersion?:string; requestId?:string;
  bytes?:number; width?:number; height?:number; sourceWidth?:number; sourceHeight?:number;
  requestWidth?:number; requestHeight?:number; count?:number; replay?:boolean;
  readiness?:'A'|'B'|'C'|'unknown';
  eligibility?:'local-order';
  boundary?:'intent'|'local-durable'|'authority-durable'|'encoded-durable'|'prepared-durable'|'decoded'|'render-submitted'|'presented'|'observed'|'dispatch'|'acknowledged'|'replay'|'cancel-intent'|'settings-confirmed'|'review-canceled';
  evidenceHash?:string;
  observationSource?:'local-poll'; timingConfidence?:'observation-only';
  inputSource?:'trusted-event'|'synthetic-event'|'unknown';composing?:boolean;
};
export type PhaseRecord = {sequence:number;phase:PhaseName;startedMs:number;endedMs:number;durationMs:number;outcome:PhaseOutcome;context:PhaseContext};
export type PhaseSnapshot = {schemaVersion:1;lane:string;clockOriginUnixMs:number;clockUncertaintyMs:null;records:PhaseRecord[];dropped:number;invalid:number};
const phases=new Set<string>(PHASES),outcomes=new Set<string>(['ok','rejected','error','cancelled','incomplete','uncertain']);
const ids=new Set(['commandId','documentId','layerId','sessionId','snapshotId','transactionId','correlationId','jobId','attemptId','providerRequestId','assetId','outputAssetId','candidateId','previewId','datasetVersion','adapterVersion','requestId']);
const sizes=new Set(['bytes','width','height','sourceWidth','sourceHeight','requestWidth','requestHeight','count','generation']);
const boundaries=new Set(['intent','local-durable','authority-durable','encoded-durable','prepared-durable','decoded','render-submitted','presented','observed','dispatch','acknowledged','replay','cancel-intent','settings-confirmed','review-canceled']);
export const PHASE_ROW_BYTES=8192,PHASE_OPEN_SPANS=256;
const contextKeys=[...ids,...sizes,'revision','resultingRevision','workspaceSeq','assetHash','evidenceHash','replay','composing','readiness','boundary','eligibility','observationSource','timingConfidence','inputSource'];
// Bounds descriptor/merge traversal independently of any caller's raw object.
const contextWorkspace=diagnosticMemory.reserve('diagnostic-phase-context',65536);
export function sanitizePhaseContext(input:PhaseContext):PhaseContext {
  const result:Record<string,string|number|boolean>={};
  if(!input||typeof input!=='object')return result;
  // Getters and arbitrary nested objects must never be evaluated or serialized.
  for(const key of contextKeys){
    const descriptor=Object.getOwnPropertyDescriptor(input,key);if(!descriptor||!('value' in descriptor))continue;const value:unknown=descriptor.value;
    if(ids.has(key)&&typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value))result[key]=value;
    else if((key==='revision'||key==='resultingRevision'||key==='workspaceSeq')&&typeof value==='string'&&/^(0|[1-9][0-9]{0,39})$/.test(value))result[key]=value;
    else if((key==='assetHash'||key==='evidenceHash')&&typeof value==='string'&&/^sha256:[a-f0-9]{64}$/.test(value))result[key]=value;
    else if(sizes.has(key)&&typeof value==='number'&&Number.isSafeInteger(value)&&value>=0)result[key]=value;
    else if((key==='replay'||key==='composing')&&typeof value==='boolean')result[key]=value;
    else if(key==='readiness'&&typeof value==='string'&&['A','B','C','unknown'].includes(value))result[key]=value;
    else if(key==='boundary'&&typeof value==='string'&&boundaries.has(value))result[key]=value;
    else if(key==='eligibility'&&value==='local-order')result[key]=value;
    else if(key==='observationSource'&&value==='local-poll')result[key]=value;
    else if(key==='timingConfidence'&&value==='observation-only')result[key]=value;
    else if(key==='inputSource'&&typeof value==='string'&&['trusted-event','synthetic-event','unknown'].includes(value))result[key]=value;
  }
  return result as PhaseContext;
}
/** Completion returns only its scalar start time; context remains recorder-owned. */
export type PhaseSpan={end:(outcome?:PhaseOutcome,addition?:PhaseContext)=>number|undefined};
type OpenSpan={phase:PhaseName;started:number;initial:PhaseContext};
export class PhaseRecorder {
  private readonly capacity:number;private readonly openSpans:number;private readonly now:()=>number;private readonly origin:number;
  private rows:PhaseRecord[]=[];private sequence=0;private dropped=0;private invalid=0;private last=0;
  private spans=new Map<number,OpenSpan>();private spanSerial=0;private disposed=false;
  private readonly lease:DiagnosticLease;private readonly reads:DiagnosticReads;
  readonly lane:string;
  constructor(options:{lane:string;capacity?:number;openSpans?:number;now?:()=>number;wallNow?:()=>number;memory?:DiagnosticMemory}){
    if(!/^[a-z][a-z0-9-]{0,47}$/.test(options.lane))throw Error('PHASE_LANE');
    this.lane=options.lane;this.capacity=options.capacity??2048;
    if(!Number.isSafeInteger(this.capacity)||this.capacity<1||this.capacity>16384)throw Error('PHASE_CAPACITY');
    this.openSpans=options.openSpans??Math.max(PHASE_OPEN_SPANS,Math.min(this.capacity*2,4096));
    if(!Number.isSafeInteger(this.openSpans)||this.openSpans<1||this.openSpans>4096)throw Error('PHASE_OPEN_SPANS');
    const memory=options.memory??diagnosticMemory;
    this.lease=memory.reserve('diagnostic-phase-records',(this.capacity+this.openSpans+4)*PHASE_ROW_BYTES);
    this.reads=new DiagnosticReads('diagnostic-phase-read',4,memory);
    this.now=options.now??(()=>performance.now());
    try{const first=this.clock();this.origin=(options.wallNow??Date.now)()-first;if(!Number.isFinite(this.origin))throw Error('PHASE_CLOCK_ORIGIN');}
    catch(error){this.lease.release();throw error;}
  }
  private clock(){const value=this.now();if(!Number.isFinite(value)||value<0||value<this.last){this.invalid++;return this.last;}this.last=value;return value;}
  start(phase:PhaseName,details:PhaseContext={},startTime?:number):PhaseSpan {
    if(this.disposed)throw Error('PHASE_DISPOSED');if(!phases.has(phase))throw Error('PHASE_NAME');
    const observed=this.clock();let started=observed;
    if(startTime!==undefined){if(Number.isFinite(startTime)&&startTime>=0&&startTime<=observed)started=startTime;else this.invalid++;}
    // A forgotten span cannot retain unbounded context. Evicted tokens become
    // inert and invalid evidence is explicit rather than a fabricated endpoint.
    if(this.spans.size===this.openSpans){this.spans.delete(this.spans.keys().next().value!);this.invalid++;}
    const token=++this.spanSerial;this.spans.set(token,{phase,started,initial:sanitizePhaseContext(details)});
    return {end:(outcome='ok',addition={})=>this.end(token,outcome,addition)};
  }
  private end(token:number,outcome:PhaseOutcome,addition:PhaseContext){
    const span=this.spans.get(token);if(!span||this.disposed)return undefined;this.spans.delete(token);
    if(!outcomes.has(outcome)){this.invalid++;outcome='incomplete';}
    const stop=this.clock(),next=sanitizePhaseContext(addition),merged={...span.initial,...next};
    for(const key of contextKeys as (keyof PhaseContext)[])if((ids.has(key)||key==='revision'||key==='assetHash')&&Object.hasOwn(span.initial,key))Object.assign(merged,{[key]:span.initial[key]});
    this.record(span.phase,span.started,stop,outcome,merged);return span.started;
  }
  private record(phase:PhaseName,start:number,stop:number,outcome:PhaseOutcome,details:PhaseContext){const record:PhaseRecord={sequence:++this.sequence,phase,startedMs:start,endedMs:stop,durationMs:stop-start,outcome,context:details};if(this.rows.length===this.capacity){this.rows.shift();this.dropped++;}this.rows.push(record);}
  timestamp(){return this.clock();}
  instant(phase:PhaseName,details:PhaseContext={}){if(this.disposed)throw Error('PHASE_DISPOSED');if(!phases.has(phase))throw Error('PHASE_NAME');const at=this.clock();this.record(phase,at,at,'ok',sanitizePhaseContext(details));return at;}
  readSnapshot():DiagnosticRead<PhaseSnapshot>{if(this.disposed)throw Error('PHASE_DISPOSED');return this.reads.read(1024+diagnosticPayloadBytes(this.rows),()=>({schemaVersion:1 as const,lane:this.lane,clockOriginUnixMs:this.origin,clockUncertaintyMs:null,records:structuredClone(this.rows),dropped:this.dropped,invalid:this.invalid}));}
  drain():DiagnosticRead<PhaseSnapshot>{const result=this.readSnapshot();this.rows=[];this.dropped=0;this.invalid=0;return result;}
  dispose(){if(this.disposed)return;this.disposed=true;this.rows=[];this.spans.clear();this.reads.close();this.lease.release();}
}
