import type {RasterJob,RasterResult,ResourcePlan} from './engine.js';
import type {RasterWorkerSnapshot} from './active-compute.js';
export const RASTER_WORKER_PROTOCOL=1 as const;
export type RasterWorkerKey={generation:number;jobId:number};
export type RasterWorkerRequest=
 |({type:'run';job:RasterJob}&RasterWorkerKey)
 |({type:'admit'}&RasterWorkerKey);
export type RasterWorkerReply=
 |{type:'ready';protocolVersion:1;generation:number;threadId:number;startedMs:number;clockOriginUnixMs:number}
 |({type:'plan';plan:ResourcePlan}&RasterWorkerKey)
 |({type:'result';result:RasterResult}&RasterWorkerKey)
 |({type:'failure';code:string;resourceFailure?:{outputPeak:number;outputRemaining:number};telemetry?:RasterWorkerSnapshot}&RasterWorkerKey)
 |({type:'idle';completed:true;retainedJobReferences:0}&RasterWorkerKey);
export type RasterWorkerIdentity={generation:number;threadId:number;startedMs:number;clockOriginUnixMs:number};
export type RasterWorkerRestart={kind:'raster-worker-restart-1';clock:'owner-performance';startedMs:number;terminatedMs:number;readyMs:number;before:RasterWorkerIdentity;after:RasterWorkerIdentity;activeJobs:0;retainedJobReferences:0;forcedGC:false;nativeAllocatorReleaseClaim:false};
