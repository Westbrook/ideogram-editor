import {diagnosticMemory,type DiagnosticLease} from '../../src/observability/diagnostic-memory.js';
import {sanitizePhaseContext,type PhaseContext,type PhaseRecorder,type PhaseSpan} from '../../src/observability/phases.js';
import type {ActiveCompute} from './active-compute.js';
export type ImportPhase='decode'|'resample'|'encode';
/** Observed wall-time spans include phase IO. ActiveCompute separately records
 * only synchronous resampling chunks, excluding lazy reads and async yields. */
export class ImportTelemetry {
 readonly metrics={decodeMs:0,computeMs:0,encodeMs:0};
 private readonly open=new Map<ImportPhase,{started:number;span:PhaseSpan|undefined}>();
 private context:PhaseContext;private readonly lease:DiagnosticLease;private disposed=false;
 constructor(readonly active:ActiveCompute,private recorder?:PhaseRecorder,context:PhaseContext={},private now:()=>number=()=>performance.now()){this.lease=diagnosticMemory.reserve('diagnostic-import-context',65536);try{this.context=sanitizePhaseContext(context);}catch(error){this.lease.release();throw error;}}
 start(name:ImportPhase,details:PhaseContext={}){
  if(this.disposed)throw Error('RASTER_IMPORT_PHASE_DISPOSED');if(!['decode','resample','encode'].includes(name))throw Error('RASTER_IMPORT_PHASE');if(this.open.has(name))throw Error('RASTER_IMPORT_PHASE_DUPLICATE');
  const entry={started:this.now(),span:this.recorder?.start(('raster.'+name) as 'raster.decode'|'raster.resample'|'raster.encode',{...this.context,...sanitizePhaseContext(details)})};this.open.set(name,entry);
  return {end:()=>this.end(name,'ok')};
 }
 dispose(){if(this.disposed)return;this.fail(Error('RASTER_IMPORT_DISPOSED'));this.context={};this.lease.release();this.disposed=true;}
 private end(name:ImportPhase,outcome:'ok'|'error'|'cancelled'){
  const entry=this.open.get(name);if(!entry)return;this.open.delete(name);
  const key=name==='decode'?'decodeMs':name==='resample'?'computeMs':'encodeMs';this.metrics[key]+=Math.max(0,this.now()-entry.started);
  entry.span?.end(outcome,{boundary:name==='decode'&&outcome==='ok'?'decoded':'observed'});
 }
 fail(error:unknown){for(const name of this.open.keys())this.end(name,error instanceof Error&&error.message==='RASTER_CANCELED'?'cancelled':'error');}
 complete(){if(this.open.size)throw Error('RASTER_IMPORT_PHASE_UNFINISHED');}
}
