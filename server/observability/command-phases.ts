import type {Command,Receipt} from '../../src/protocol/store.js';
import {PhaseRecorder,sanitizePhaseContext,type PhaseContext,type PhaseSpan} from '../../src/observability/phases.js';
import {diagnosticMemory,type DiagnosticLease} from '../../src/observability/diagnostic-memory.js';

export function commandContext(command:Command):PhaseContext {
 return sanitizePhaseContext({commandId:command.commandId,documentId:command.documentId??undefined,
  revision:command.expectedDocumentRevision??undefined,transactionId:command.transactionId,correlationId:command.correlationId});
}
/** Opaque scalar tokens never keep retired command contexts reachable. */
export type CommandAcceptance=number;
type Acceptance={span:PhaseSpan;validation:PhaseSpan;validated:boolean;commandId?:string;hash?:string};
export class CommandAcceptancePhases {
 private active=new Map<CommandAcceptance,Acceptance>();private serial=0;private lease:DiagnosticLease|undefined;
 constructor(private recorder:PhaseRecorder,private capacity=128){if(!Number.isSafeInteger(capacity)||capacity<1||capacity>1024)throw Error('PHASE_PENDING_CAPACITY');}
 begin(command:Command|undefined,hash?:string,startTime?:number):CommandAcceptance {
  if(this.serial>=Number.MAX_SAFE_INTEGER)throw Error('PHASE_PENDING_TOKEN');
  this.lease??=diagnosticMemory.reserve('diagnostic-command-contexts',(this.capacity+1)*8192);
  const context=command?commandContext(command):{};
  const span=this.recorder.start('command.accept',context,startTime);let validation:PhaseSpan;
  try{validation=this.recorder.start('command.validate',context,startTime);}catch(error){span.end('incomplete');throw error;}
  const handle=++this.serial,value:Acceptance={span,validation,validated:false,commandId:context.commandId,
   ...(typeof hash==='string'&&/^sha256:[a-f0-9]{64}$/.test(hash)?{hash}:{})};
  if(this.active.size===this.capacity)this.finish(this.active.keys().next().value!,'incomplete');
  this.active.set(handle,value);return handle;
 }
 private finish(token:CommandAcceptance,outcome:'ok'|'rejected'|'error'|'incomplete',receipt?:Receipt){
  const handle=this.active.get(token);if(!handle)return;this.active.delete(token);
  if(!handle.validated)handle.validation.end(outcome,receipt?{boundary:'authority-durable',replay:true}:{});
  handle.span.end(outcome,receipt?{boundary:'authority-durable',resultingRevision:receipt.status==='accepted'?receipt.documentRevision??undefined:receipt.currentRevision??undefined}:{});
 }
 complete(token:CommandAcceptance|undefined,result:unknown){
  const handle=token===undefined?undefined:this.active.get(token);if(!handle?.commandId||!result||typeof result!=='object')return;
  const receipt=result as Receipt;if(receipt.commandId===handle.commandId&&(receipt.status==='accepted'||receipt.status==='rejected'))this.finish(token!,receipt.status==='accepted'?'ok':'rejected',receipt);
 }
 durable(commandId:string,hash:string,receipt:Receipt){for(const [token,handle]of this.active)if(handle.commandId===commandId&&handle.hash===hash)this.complete(token,receipt);}
 validated(commandId:string,hash:string,receipt:Receipt){
  if(receipt.commandId!==commandId||(receipt.status!=='accepted'&&receipt.status!=='rejected'))return;
  for(const handle of this.active.values())if(handle.commandId===commandId&&handle.hash===hash&&!handle.validated){handle.validated=true;handle.validation.end(receipt.status==='accepted'?'ok':'rejected',{boundary:'observed'});}
 }
 fail(handle:CommandAcceptance|undefined){if(handle!==undefined)this.finish(handle,'error');}
 close(){try{for(const handle of this.active.keys())this.finish(handle,'incomplete');}finally{this.active.clear();this.lease?.release();this.lease=undefined;}}
 get pending(){return this.active.size;}
}

/** Current-process elapsed queue residence; replay cannot reconstruct a start. */
export class LocalQueuePhases {
 private active=new Map<string,PhaseSpan>();private lease:DiagnosticLease|undefined;
 constructor(private recorder:PhaseRecorder,private capacity=128){if(!Number.isSafeInteger(capacity)||capacity<1||capacity>1024)throw Error('PHASE_PENDING_CAPACITY');}
 begin(jobId:string,context:PhaseContext={}){
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(jobId))throw Error('PHASE_QUEUE_ID');
  this.lease??=diagnosticMemory.reserve('diagnostic-queue-contexts',(this.capacity+1)*8192);
  this.finish(jobId,'incomplete');if(this.active.size===this.capacity)this.finish(this.active.keys().next().value!,'incomplete');
  this.active.set(jobId,this.recorder.start('job.local_queue',{...sanitizePhaseContext(context),jobId}));
 }
 private finish(jobId:string,outcome:'ok'|'cancelled'|'incomplete',context:PhaseContext={}){const span=this.active.get(jobId);if(!span)return;this.active.delete(jobId);span.end(outcome,context);}
 eligible(jobId:string,documentId:string,attemptId:string){this.finish(jobId,'ok',{documentId,attemptId,boundary:'dispatch'});}
 cancel(jobId:string){this.finish(jobId,'cancelled',{boundary:'authority-durable'});}
 close(){try{for(const jobId of this.active.keys())this.finish(jobId,'incomplete');}finally{this.active.clear();this.lease?.release();this.lease=undefined;}}
 get pending(){return this.active.size;}
}
