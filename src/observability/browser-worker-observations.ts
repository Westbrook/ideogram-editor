import {PHASES,sanitizePhaseContext,type PhaseContext,type PhaseRecord,type PhaseSnapshot} from './phases.js';

const retained:PhaseSnapshot[]=[];
let dropped=0,invalid=0;
const names=new Set<string>(PHASES),outcomes=new Set(['ok','rejected','error','cancelled','incomplete','uncertain']);
const own=(value:unknown,key:string):unknown=>value&&typeof value==='object'?Object.getOwnPropertyDescriptor(value,key)?.value:undefined;
const integer=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const clock=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;

/** Diagnostic snapshots retain their worker clock; they never become authority or main-thread durations. */
export function retainWorkerPhases(value:unknown):void {
  try {
    const rows=own(value,'records'),origin=own(value,'clockOriginUnixMs'),lost=own(value,'dropped'),bad=own(value,'invalid');
    if(own(value,'schemaVersion')!==1||own(value,'lane')!=='text-worker'||own(value,'clockUncertaintyMs')!==null||!clock(origin)||!integer(lost)||!integer(bad)||!Array.isArray(rows)||rows.length>128)throw Error('WORKER_PHASE_SNAPSHOT');
    let sequence=0,ended=0;const records:PhaseRecord[]=[];
    for(let index=0;index<rows.length;index++){
      const row=own(rows,String(index)),next=own(row,'sequence'),phase=own(row,'phase'),start=own(row,'startedMs'),stop=own(row,'endedMs'),duration=own(row,'durationMs'),outcome=own(row,'outcome');
      if(!integer(next)||next<=sequence||typeof phase!=='string'||!names.has(phase)||!clock(start)||!clock(stop)||stop<start||stop<ended||duration!==stop-start||typeof outcome!=='string'||!outcomes.has(outcome))throw Error('WORKER_PHASE_RECORD');
      records.push({sequence:next,phase:phase as PhaseRecord['phase'],startedMs:start,endedMs:stop,durationMs:stop-start,outcome:outcome as PhaseRecord['outcome'],context:sanitizePhaseContext(own(row,'context') as PhaseContext)});
      sequence=next;ended=stop;
    }
    if(retained.length===32){retained.shift();dropped++;}
    retained.push({schemaVersion:1,lane:'text-worker',clockOriginUnixMs:origin,clockUncertaintyMs:null,records,dropped:lost,invalid:bad});
  }catch{invalid++;}
}
export function workerPhaseSnapshot(){return {schemaVersion:1 as const,traces:structuredClone(retained),dropped,invalid,clockJoin:'external-calibration-required' as const};}
