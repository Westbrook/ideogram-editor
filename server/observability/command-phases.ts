import type {Command,Receipt} from '../../src/protocol/store.js';
import {PhaseRecorder,sanitizePhaseContext,type PhaseContext,type PhaseSpan} from '../../src/observability/phases.js';

export function commandContext(command:Command):PhaseContext {
  return {commandId:command.commandId,documentId:command.documentId??undefined,
    revision:command.expectedDocumentRevision??undefined,transactionId:command.transactionId,
    correlationId:command.correlationId};
}
export type CommandAcceptance={span:PhaseSpan;validation:PhaseSpan;validated:boolean;commandId?:string;hash?:string;context:PhaseContext};
/** Pending preparation is not durable acceptance. Keep its original local start
 * until a matching receipt commits. IDs and a digest are the only retained input. */
export class CommandAcceptancePhases {
  private active=new Set<CommandAcceptance>();
  constructor(private recorder:PhaseRecorder,private capacity=128){
    if(!Number.isSafeInteger(capacity)||capacity<1||capacity>1024)throw Error('PHASE_PENDING_CAPACITY');
  }
  begin(command:Command|undefined,hash?:string,startTime?:number):CommandAcceptance {
    const context=command?commandContext(command):{},handle:CommandAcceptance={
      span:this.recorder.start('command.accept',context,startTime),validation:this.recorder.start('command.validate',context,startTime),validated:false,context,
      ...(command?{commandId:command.commandId,hash}:{}),
    };
    if(this.active.size===this.capacity){const oldest=this.active.values().next().value!;this.finish(oldest,'incomplete');}
    this.active.add(handle);return handle;
  }
  private finish(handle:CommandAcceptance,outcome:'ok'|'rejected'|'error'|'incomplete',receipt?:Receipt){
    if(!this.active.delete(handle))return;
    if(!handle.validated)handle.validation.end(outcome,receipt?{boundary:'authority-durable',replay:true}:{});
    handle.span.end(outcome,receipt?{boundary:'authority-durable',resultingRevision:receipt.status==='accepted'?receipt.documentRevision??undefined:receipt.currentRevision??undefined}:{});
  }
  complete(handle:CommandAcceptance|undefined,result:unknown){
    if(!handle?.commandId||!result||typeof result!=='object')return;
    const receipt=result as Receipt;
    if(receipt.commandId===handle.commandId&&(receipt.status==='accepted'||receipt.status==='rejected'))this.finish(handle,receipt.status==='accepted'?'ok':'rejected',receipt);
  }
  durable(commandId:string,hash:string,receipt:Receipt){
    for(const handle of this.active)if(handle.commandId===commandId&&handle.hash===hash)this.complete(handle,receipt);
  }
  validated(commandId:string,hash:string,receipt:Receipt){
    if(receipt.commandId!==commandId||(receipt.status!=='accepted'&&receipt.status!=='rejected'))return;
    for(const handle of this.active)if(handle.commandId===commandId&&handle.hash===hash&&!handle.validated){
      handle.validated=true;
      handle.validation.end(receipt.status==='accepted'?'ok':'rejected',{boundary:'observed'});
    }
  }
  fail(handle:CommandAcceptance|undefined){if(handle)this.finish(handle,'error');}
  close(){for(const handle of this.active)this.finish(handle,'incomplete');}
  get pending(){return this.active.size;}
}

/** Current-process elapsed queue residence; replay cannot reconstruct a start. */
export class LocalQueuePhases {
  private active=new Map<string,PhaseSpan>();
  constructor(private recorder:PhaseRecorder,private capacity=128){
    if(!Number.isSafeInteger(capacity)||capacity<1||capacity>1024)throw Error('PHASE_PENDING_CAPACITY');
  }
  begin(jobId:string,context:PhaseContext={}){
    this.finish(jobId,'incomplete');
    if(this.active.size===this.capacity)this.finish(this.active.keys().next().value!,'incomplete');
    this.active.set(jobId,this.recorder.start('job.local_queue',{...sanitizePhaseContext(context),jobId}));
  }
  private finish(jobId:string,outcome:'ok'|'cancelled'|'incomplete',context:PhaseContext={}){
    const span=this.active.get(jobId);if(!span)return;
    this.active.delete(jobId);span.end(outcome,context);
  }
  eligible(jobId:string,documentId:string,attemptId:string){this.finish(jobId,'ok',{documentId,attemptId,boundary:'dispatch'});}
  cancel(jobId:string){this.finish(jobId,'cancelled',{boundary:'authority-durable'});}
  close(){for(const jobId of this.active.keys())this.finish(jobId,'incomplete');}
  get pending(){return this.active.size;}
}
