import {PhaseRecorder,sanitizePhaseContext,type PhaseContext,type PhaseOutcome,type PhaseSpan} from './phases.js';
import {workerPhaseSnapshot} from './browser-worker-observations.js';
import {allocationLedger} from './allocations.js';

type Target={documentId:string;revision:string;assetId:string};
type Adoption={context:PhaseContext;intentMs:number;durableMs:number|null;renderSubmittedMs:number|null;target:Target|null;outcome:'pending'|'awaiting-presentation'|'rejected'|'error'|'cancelled';span:PhaseSpan;ended:boolean};
/** Browser-local endpoints only. A canvas draw is never called a presented frame. */
export class BrowserPhases {
  readonly recorder:PhaseRecorder;
  private adoptions=new Map<string,Adoption>();private droppedAdoptions=0;
  private viewport:(Target&{submittedMs:number})|null=null;
  private viewportProbe:()=>string|null=()=>null;
  private feedback:PhaseSpan|undefined;
  constructor(private readonly now:()=>number=()=>performance.now(),recorder?:PhaseRecorder){this.recorder=recorder??new PhaseRecorder({lane:'browser-main',now});}
  private safe(details:PhaseContext){return sanitizePhaseContext(details);}
  setViewportProbe(probe:()=>string|null){this.viewportProbe=probe;}
  beginIntent(details:PhaseContext={},intentTime=this.recorder.timestamp()){
    this.feedback?.end('incomplete');const safe=this.safe(details),intent=this.recorder.start('ui.intent',{...safe,boundary:'intent'},intentTime).end()!;
    this.feedback=this.recorder.start('ui.feedback',safe,intent.startedMs);
  }
  feedbackSubmitted(){this.feedback?.end('incomplete',{boundary:'render-submitted'});this.feedback=undefined;}
  beginAdoption(details:PhaseContext,preparedDurable:boolean,intentTime=this.recorder.timestamp()){
    const known=this.safe(details),previewId=known.previewId;if(!previewId)return;
    const old=this.adoptions.get(previewId);if(old&&!old.ended){old.span.end('cancelled');old.ended=true;}
    let resident:string|null=null;try{resident=this.viewportProbe();}catch{/* A failed observation cannot imply a resident decoded viewport. */}
    const readiness=preparedDurable?(known.assetId&&resident===known.assetId?'A':'B'):'C';
    const captured={...known,readiness} as PhaseContext;
    const intent=this.recorder.start('ui.intent',{...captured,boundary:'intent'},intentTime).end()!;
    const adoption:Adoption={context:captured,intentMs:intent.startedMs,durableMs:null,renderSubmittedMs:null,target:null,outcome:'pending',span:this.recorder.start('result.adopt',captured,intent.startedMs),ended:false};
    this.adoptions.delete(previewId);this.adoptions.set(previewId,adoption);
    if(this.adoptions.size>64){const key=this.adoptions.keys().next().value!,first=this.adoptions.get(key)!;if(!first.ended)first.span.end('incomplete');this.adoptions.delete(key);this.droppedAdoptions++;}
  }
  bindAdoption(previewId:string,details:PhaseContext){const row=this.adoptions.get(previewId);if(row&&!row.ended)row.context={...this.safe(details),...row.context};}
  adoptionFailed(previewId:string,outcome:'rejected'|'error'|'cancelled'='error'){
    const row=this.adoptions.get(previewId);if(!row||row.ended)return;row.outcome=outcome;row.span.end(outcome,row.context);row.ended=true;
  }
  adoptionDurable(commandId:string,target:Target,receivedAt=this.recorder.timestamp()){
    for(const row of this.adoptions.values())if(row.context.commandId===commandId&&!row.ended){
      const safe=this.safe(target);if(!safe.documentId||!safe.revision||!safe.assetId)return;
      row.target={documentId:safe.documentId,revision:safe.revision,assetId:safe.assetId};const now=this.recorder.timestamp();row.durableMs=Number.isFinite(receivedAt)&&receivedAt>=row.intentMs&&receivedAt<=now?receivedAt:now;
      this.recorder.instant('command.accept',{...row.context,resultingRevision:target.revision,outputAssetId:target.assetId,boundary:'authority-durable'});
      this.join(row);
    }
  }
  viewportDecoded(target:Target,decodeStarted?:number){
    const safe=this.safe(target);if(!safe.documentId||!safe.revision||!safe.assetId)return;
    this.viewport={documentId:safe.documentId,revision:safe.revision,assetId:safe.assetId,submittedMs:this.recorder.timestamp()};
    this.recorder.start('result.viewport_decode',safe,decodeStarted).end('ok',{boundary:'render-submitted'});
    const now=this.recorder.timestamp();for(const row of this.adoptions.values())if(!row.ended&&row.target&&this.matches(row.target,this.viewport)){row.renderSubmittedMs=now;this.join(row);}
  }
  private matches(a:Target,b:Target){return a.documentId===b.documentId&&a.revision===b.revision&&a.assetId===b.assetId;}
  private join(row:Adoption){
    if(!row.target||row.durableMs===null)return;
    if(row.renderSubmittedMs===null&&this.viewport&&this.matches(row.target,this.viewport))row.renderSubmittedMs=Math.max(row.intentMs,this.viewport.submittedMs);
    if(row.renderSubmittedMs===null)return;
    // Completion remains censored until qualification's presentation trace proves
    // the correct pixels. rAF, img.load and canvas.drawImage are not that proof.
    row.outcome='awaiting-presentation';row.span.end('incomplete',{...row.context,resultingRevision:row.target.revision,outputAssetId:row.target.assetId,boundary:'render-submitted'});row.ended=true;
  }
  reset(outcome:PhaseOutcome='cancelled'){this.feedback?.end(outcome);this.feedback=undefined;for(const row of this.adoptions.values())if(!row.ended){row.span.end(outcome,row.context);row.outcome='cancelled';row.ended=true;}this.viewport=null;}
  snapshot(){return {schemaVersion:1 as const,trace:this.recorder.snapshot(),adoptions:[...this.adoptions.values()].map(({span:_,ended:__,...row})=>structuredClone(row)),droppedAdoptions:this.droppedAdoptions,workerObservations:workerPhaseSnapshot(),allocations:allocationLedger.snapshot(),presentationEvidence:'external-trace-required' as const};}
}
export const browserPhases=new BrowserPhases();
// Read-only inspection works in both the development server and the bundled app.
// It carries no auth capability, mutator, raw payload, URL or provider credential.
if(typeof window!=='undefined')Object.defineProperty(window,'__IDEOGRAM_PHASES__',{value:Object.freeze({snapshot:()=>browserPhases.snapshot()}),configurable:true});
