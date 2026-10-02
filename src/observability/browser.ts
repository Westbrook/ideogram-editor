import {diagnosticMemory,diagnosticPayloadBytes,DiagnosticReads,type DiagnosticLease,type DiagnosticRead} from './diagnostic-memory.js';
import {PhaseRecorder,PHASE_ROW_BYTES,sanitizePhaseContext,type PhaseContext,type PhaseOutcome,type PhaseSpan} from './phases.js';
import {readWorkerPhases} from './browser-worker-observations.js';
import {allocationLedger,TEXT_RESOURCE_OBSERVER_BYTES} from './allocations.js';
import {NavigationObservations,NAVIGATION_OBSERVATION_BYTES,type NavigationTarget} from './navigation-observations.js';
import {compositionObservations} from './composition-observations.js';
import {readAdapterUploads} from './adapter-upload-hook.js';

export type NavigationStatusCommon={sourceId:string;lifecycle:number;documentGeneration:number;sessionId:string;documentId:string|null;revision:string|null;cursor:string};
export type NavigationStatusInput=NavigationStatusCommon&{message:string;ready:boolean;busy:boolean;hasError:boolean;hasRecovery:boolean};
export type NavigationAuthorityInput=NavigationStatusCommon&({kind:'recovered'|'opened'}|{kind:'checkpoint';commandId:string;transactionId:string;fromSeq:string;toSeq:string});
type NavigationStatus='connect'|'recovering'|'recovered'|'opening'|'opened'|'saving'|'saved'|'other';
type NavigationStatusRow=NavigationStatusCommon&{sequence:number;atMs:number}&({kind:'state';status:NavigationStatus;ready:boolean;busy:boolean;hasError:boolean;hasRecovery:boolean}|{kind:'recovered'|'opened'}|{kind:'checkpoint';commandId:string;transactionId:string;fromSeq:string;toSeq:string});
const NAVIGATION_STATUS_CAPACITY=128;
// A maximum checkpoint row holds one UUID and four ASCII identities (128 chars each), four
// decimal identities (128 chars each), fixed keys/scalars and bounded copy work.
// 16 KiB covers the diagnostic escaped/UTF16 payload estimate per row. The
// extra four slots cover the header and synchronous validation/copy overlap.
// This is logical diagnostic ownership, never native backing or RSS.
export const NAVIGATION_STATUS_BYTES=(NAVIGATION_STATUS_CAPACITY+4)*16384;
const navigationCommonKeys=['sourceId','lifecycle','documentGeneration','sessionId','documentId','revision','cursor'] as const;
const navigationStateKeys=['status','ready','busy','hasError','hasRecovery'] as const;
function navigationStatus(message:string):NavigationStatus {
  switch(message){
    case 'Connect locally to open your work.':return 'connect';
    case 'Recovering complete local transactions…':return 'recovering';
    case 'Local recovery complete. Accepted edits are saved locally.':return 'recovered';
    case 'Open local document…':return 'opening';
    case 'Local document opened.':return 'opened';
    case 'Save checkpoint…':return 'saving';
    case 'SaveCheckpoint accepted and saved locally.':return 'saved';
    default:return 'other';
  }
}
/** Page-lifetime publication order. This records actual synchronous calls, not
 * an inferred success from the latest status. Invalid/overflow histories close
 * permanently; neither document resets nor later good data repair that proof. */
class NavigationStatusHistory {
  private readonly lease:DiagnosticLease;
  private rows:NavigationStatusRow[]=[];private rowBytes=0;private dropped=0;private invalid=0;private closed=false;private disposed=false;private lastMs=0;private recording=false;
  constructor(private readonly now:()=>number,private readonly timeOriginMs:number){
    this.lease=diagnosticMemory.reserve('diagnostic-navigation-status',NAVIGATION_STATUS_BYTES);
    if(!Number.isFinite(timeOriginMs)||timeOriginMs<0){this.invalid=1;this.closed=true;}
  }
  private own(input:unknown,key:string):unknown {if(!input||typeof input!=='object')throw Error('NAVIGATION_STATUS_INPUT');const field=Object.getOwnPropertyDescriptor(input,key);if(!field||!('value'in field))throw Error('NAVIGATION_STATUS_INPUT');return field.value;}
  private id(value:unknown):string {if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,128}(?![\s\S])/.test(value))throw Error('NAVIGATION_STATUS_ID');return value;}
  private decimal(value:unknown):string {if(typeof value!=='string'||!/^(0|[1-9][0-9]{0,127})(?![\s\S])/.test(value))throw Error('NAVIGATION_STATUS_DECIMAL');return value;}
  private ordinal(value:unknown):number {if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw Error('NAVIGATION_STATUS_ORDINAL');return value;}
  private boolean(value:unknown):boolean {if(typeof value!=='boolean')throw Error('NAVIGATION_STATUS_BOOLEAN');return value;}
  private common(input:unknown):NavigationStatusCommon {
    const session=this.own(input,'sessionId'),document=this.own(input,'documentId'),revision=this.own(input,'revision');
    if((document===null)!==(revision===null))throw Error('NAVIGATION_STATUS_DOCUMENT');
    const sourceId=this.own(input,'sourceId');if(typeof sourceId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/i.test(sourceId))throw Error('NAVIGATION_STATUS_SOURCE');
    return {sourceId,lifecycle:this.ordinal(this.own(input,'lifecycle')),documentGeneration:this.ordinal(this.own(input,'documentGeneration')),
      sessionId:this.id(session),documentId:document===null?null:this.id(document),revision:revision===null?null:this.decimal(revision),cursor:this.decimal(this.own(input,'cursor'))};
  }
  private record(make:(atMs:number,sequence:number)=>NavigationStatusRow){
    if(this.closed||this.disposed)return;
    if(this.recording){this.invalidate();return;}this.recording=true;
    try{
      const atMs=this.now();if(this.closed||this.disposed)return;if(!Number.isFinite(atMs)||atMs<0||atMs<this.lastMs)throw Error('NAVIGATION_STATUS_CLOCK');
      const row=make(atMs,this.rows.length+1);if(this.closed||this.disposed)return;this.lastMs=atMs;const prior=this.rows.at(-1);
      if(row.kind==='state'&&prior?.kind==='state'&&navigationCommonKeys.every(key=>row[key]===prior[key])&&navigationStateKeys.every(key=>row[key]===prior[key]))return;
      if(this.rows.length===NAVIGATION_STATUS_CAPACITY){this.dropped++;this.closed=true;return;}
      const bytes=diagnosticPayloadBytes(row)+2;if(bytes>16384)throw Error('NAVIGATION_STATUS_ROW_BOUND');
      this.rows.push(row);this.rowBytes+=bytes;
    }catch{if(!this.closed&&!this.disposed){this.invalid++;this.closed=true;}}finally{this.recording=false;if(this.disposed)this.lease.release();}
  }
  state(input:NavigationStatusInput){this.record((atMs,sequence)=>{
    const common=this.common(input),message=this.own(input,'message');if(typeof message!=='string')throw Error('NAVIGATION_STATUS_MESSAGE');
    return {...common,sequence,atMs,kind:'state',status:navigationStatus(message),ready:this.boolean(this.own(input,'ready')),busy:this.boolean(this.own(input,'busy')),hasError:this.boolean(this.own(input,'hasError')),hasRecovery:this.boolean(this.own(input,'hasRecovery'))};
  });}
  authority(input:NavigationAuthorityInput){this.record((atMs,sequence)=>{
    const common=this.common(input),kind=this.own(input,'kind');
    if(kind==='recovered'||kind==='opened')return {...common,sequence,atMs,kind};
    if(kind!=='checkpoint')throw Error('NAVIGATION_STATUS_AUTHORITY');
    const commandId=this.id(this.own(input,'commandId')),transactionId=this.id(this.own(input,'transactionId')),fromSeq=this.decimal(this.own(input,'fromSeq')),toSeq=this.decimal(this.own(input,'toSeq'));
    if(BigInt(toSeq)<BigInt(fromSeq))throw Error('NAVIGATION_STATUS_RECEIPT');
    return {...common,sequence,atMs,kind,commandId,transactionId,fromSeq,toSeq};
  });}
  invalidate(){if(this.closed||this.disposed)return;this.invalid++;this.closed=true;}
  copyBytes(){return 4096+this.rowBytes;}
  copy(){return {kind:'navigation-status-1' as const,timeOriginMs:this.timeOriginMs,capacity:NAVIGATION_STATUS_CAPACITY,dropped:this.dropped,invalid:this.invalid,closed:this.closed,rows:this.rows.map(row=>({...row}))};}
  dispose(){if(this.disposed)return;this.closed=true;this.rows=[];this.rowBytes=0;this.disposed=true;if(!this.recording)this.lease.release();}
}

type Target={documentId:string;revision:string;assetId:string};
type Adoption={context:PhaseContext;intentMs:number;durableMs:number|null;renderSubmittedMs:number|null;target:Target|null;outcome:'pending'|'awaiting-presentation'|'rejected'|'error'|'cancelled';span:PhaseSpan;ended:boolean};
/** Browser-local endpoints only. A canvas draw is never called a presented frame. */
export class BrowserPhases {
  readonly recorder:PhaseRecorder;private readonly ownsRecorder:boolean;private readonly lease:DiagnosticLease;private readonly reads=new DiagnosticReads('diagnostic-browser-read');private readonly textResourceReads=new DiagnosticReads('diagnostic-text-resource-read',1);private readonly textResourceOwners=new Map<string,DiagnosticRead<unknown>>();private disposed=false;private readSerial=0;private readonly readOwners=new Map<string,DiagnosticRead<unknown>>();
  private adoptions=new Map<string,Adoption>();private droppedAdoptions=0;
  private viewport:(Target&{submittedMs:number})|null=null;
  private viewportProbe:()=>string|null=()=>null;
  private feedback:PhaseSpan|undefined;
  private readonly navigation:NavigationObservations;
  private readonly navigationStatus:NavigationStatusHistory;
  constructor(private readonly now:()=>number=()=>performance.now(),recorder?:PhaseRecorder,navigationTimeOriginMs=performance.timeOrigin){
    this.ownsRecorder=!recorder;this.lease=diagnosticMemory.reserve('diagnostic-browser-state',68*PHASE_ROW_BYTES+65536);
    let history:NavigationStatusHistory|undefined,navigation:NavigationObservations|undefined;
    try{this.navigationStatus=history=new NavigationStatusHistory(now,navigationTimeOriginMs);this.navigation=navigation=new NavigationObservations(()=>this.recorder.timestamp(),navigationTimeOriginMs);this.recorder=recorder??new PhaseRecorder({lane:'browser-main',openSpans:512,now});}
    catch(error){navigation?.dispose();history?.dispose();this.lease.release();throw error;}
  }
  recordNavigationStatus(input:NavigationStatusInput){this.navigationStatus.state(input);}
  recordNavigationAuthority(input:NavigationAuthorityInput){this.navigationStatus.authority(input);}
  invalidateNavigationStatus(){this.navigationStatus.invalidate();}
  recordNavigationModelReady(target:NavigationTarget&{snapshotId:string}){this.navigation.modelReady(target);}
  recordNavigationRenderSubmitted(target:NavigationTarget){this.navigation.renderSubmitted(target);}
  recordNavigationControlsRendered(target:NavigationTarget|null,enabled:boolean){this.navigation.controlsRendered(target,enabled);}
  recordNavigationControlsCommitted(target:NavigationTarget|null,viewportCurrent:boolean,enabled:boolean){this.navigation.controlsCommitted(target,viewportCurrent,enabled);}
  recordNavigationViewportUnavailable(){this.navigation.viewportUnavailable();}
  resetNavigation(){this.navigation.reset();}
  private safe(details:PhaseContext){if(this.disposed)throw Error('BROWSER_PHASES_DISPOSED');return sanitizePhaseContext(details);}
  setViewportProbe(probe:()=>string|null){this.viewportProbe=probe;}
  beginIntent(details:PhaseContext={},intentTime=this.recorder.timestamp()){
    this.feedback?.end('incomplete');const safe=this.safe(details),intent=this.recorder.start('ui.intent',{...safe,boundary:'intent'},intentTime).end()!;
    this.feedback=this.recorder.start('ui.feedback',safe,intent);
  }
  feedbackSubmitted(){this.feedback?.end('incomplete',{boundary:'render-submitted'});this.feedback=undefined;}
  beginAdoption(details:PhaseContext,preparedDurable:boolean,intentTime=this.recorder.timestamp()){
    const known=this.safe(details),previewId=known.previewId;if(!previewId)return;
    const old=this.adoptions.get(previewId);if(old&&!old.ended){old.span.end('cancelled');old.ended=true;}
    let resident:string|null=null;try{resident=this.viewportProbe();}catch{/* A failed observation cannot imply a resident decoded viewport. */}
    const readiness=preparedDurable?(known.assetId&&resident===known.assetId?'A':'B'):'C';
    const captured={...known,readiness} as PhaseContext;
    const intent=this.recorder.start('ui.intent',{...captured,boundary:'intent'},intentTime).end()!;
    const adoption:Adoption={context:captured,intentMs:intent,durableMs:null,renderSubmittedMs:null,target:null,outcome:'pending',span:this.recorder.start('result.adopt',captured,intent),ended:false};
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
  reset(outcome:PhaseOutcome='cancelled'){this.navigation.reset();this.feedback?.end(outcome);this.feedback=undefined;for(const row of this.adoptions.values())if(!row.ended){row.span.end(outcome,row.context);row.outcome='cancelled';row.ended=true;}this.viewport=null;}
  readSnapshot(readKey='internal-'+ ++this.readSerial):DiagnosticRead<unknown>{
    if(!/^[A-Za-z0-9_-]{1,64}$/.test(readKey))throw Error('DIAGNOSTIC_READ_KEY');
    const existing=this.readOwners.get(readKey);if(existing)return existing;
    if(this.disposed)throw Error('BROWSER_PHASES_DISPOSED');
    // Child owners remain charged through extraction of the aggregate. The
    // aggregate owns only its additional adoption/allocation/shape copy.
    const borrowed:DiagnosticRead<unknown>[]=[];
    let handle:DiagnosticRead<ReturnType<BrowserPhases['copyAdditional']>&{trace:unknown;workerObservations:unknown;compositionObservations:unknown;adapterUploads:unknown}>;
    try{handle=this.reads.read(32768+NAVIGATION_OBSERVATION_BYTES+this.navigationStatus.copyBytes()+this.adoptionBytes(),()=>{
      const trace=this.recorder.readSnapshot();borrowed.push(trace);
      const workers=readWorkerPhases();borrowed.push(workers);
      const composition=compositionObservations.readSnapshot();borrowed.push(composition);
      const uploads=readAdapterUploads();if(uploads)borrowed.push(uploads);
      return {...this.copyAdditional(),trace:trace.value,workerObservations:workers.value,compositionObservations:composition.value,adapterUploads:uploads?.value??null};
    });}catch(error){for(const owner of borrowed)owner.release();throw error;}
    let live=true;const owner=Object.freeze({get value(){if(!live)throw Error('DIAGNOSTIC_READ_RELEASED');return handle.value;},release:()=>{
      if(!live)return;const failures:unknown[]=[];for(const owner of borrowed)try{owner.release();}catch(error){failures.push(error);}
      try{handle.release();}catch(error){failures.push(error);}if(failures.length)throw new AggregateError(failures,'DIAGNOSTIC_RELEASE_FAILED');live=false;this.readOwners.delete(readKey);
    }});this.readOwners.set(readKey,owner);return owner;
  }
  private adoptionBytes(){let bytes=0;for(const row of this.adoptions.values())bytes+=diagnosticPayloadBytes(row.context)+diagnosticPayloadBytes(row.target)+1024;return bytes;}
  private copyAdditional(){return {schemaVersion:1 as const,navigation:this.navigation.copy(),navigationStatus:this.navigationStatus.copy(),adoptions:[...this.adoptions.values()].map(({span:_,ended:__,...row})=>structuredClone(row)),droppedAdoptions:this.droppedAdoptions,allocations:allocationLedger.snapshot(),presentationEvidence:'external-trace-required' as const};}
  textResourceStartupIdentity(){if(this.disposed)throw Error('BROWSER_PHASES_DISPOSED');return allocationLedger.textResourceStartupIdentity();}
  sealTextResourceStartupWindow(){if(this.disposed)throw Error('BROWSER_PHASES_DISPOSED');return allocationLedger.sealTextResourceStartupWindow();}
  beginTextResourceObservationWindow(id:string){if(this.disposed)throw Error('BROWSER_PHASES_DISPOSED');return allocationLedger.beginTextResourceObservationWindow(id);}
  endTextResourceObservationWindow(id:string){if(this.disposed)throw Error('BROWSER_PHASES_DISPOSED');return allocationLedger.endTextResourceObservationWindow(id);}
  readTextResourceSnapshot(readKey:string):DiagnosticRead<unknown>{
    if(!/^[A-Za-z0-9_-]{1,64}$/.test(readKey))throw Error('DIAGNOSTIC_READ_KEY');const existing=this.textResourceOwners.get(readKey);if(existing)return existing;if(this.disposed)throw Error('BROWSER_PHASES_DISPOSED');
    const handle=this.textResourceReads.read(TEXT_RESOURCE_OBSERVER_BYTES,()=>allocationLedger.copyTextResourceObservation());let live=true;
    const owner=Object.freeze({get value(){if(!live)throw Error('DIAGNOSTIC_READ_RELEASED');return handle.value;},release:()=>{if(!live)return;handle.release();live=false;this.textResourceOwners.delete(readKey);}});this.textResourceOwners.set(readKey,owner);return owner;
  }
  beginCpuObservationWindow(id:string){if(this.disposed)throw Error('BROWSER_PHASES_DISPOSED');return allocationLedger.beginCpuObservationWindow(id);}
  endCpuObservationWindow(id:string){if(this.disposed)throw Error('BROWSER_PHASES_DISPOSED');return allocationLedger.endCpuObservationWindow(id);}
  async ensureAdapterUploads(){if(this.disposed)throw Error('BROWSER_PHASES_DISPOSED');const module=await import('./adapter-upload.js');if(this.disposed)throw Error('BROWSER_PHASES_DISPOSED');module.ensureAdapterUploads();}
  dispose(){if(this.disposed)return;this.reset();this.disposed=true;this.adoptions.clear();this.viewport=null;this.viewportProbe=()=>null;this.reads.close();this.textResourceReads.close();this.navigation.dispose();this.navigationStatus.dispose();if(this.ownsRecorder)this.recorder.dispose();this.lease.release();}
}
export const browserPhases=new BrowserPhases();
// Only scoped observation is exposed. Window boundaries change diagnostic
// counters only; release closes a diagnostic read, never a product owner.
if(typeof window!=='undefined')Object.defineProperty(window,'__IDEOGRAM_PHASES__',{value:Object.freeze({readSnapshot:(readKey:string)=>{if(typeof readKey!=='string')throw Error('DIAGNOSTIC_READ_KEY');return browserPhases.readSnapshot(readKey);},textResourceStartupIdentity:()=>browserPhases.textResourceStartupIdentity(),sealTextResourceStartupWindow:()=>browserPhases.sealTextResourceStartupWindow(),beginTextResourceObservationWindow:(id:string)=>browserPhases.beginTextResourceObservationWindow(id),endTextResourceObservationWindow:(id:string)=>browserPhases.endTextResourceObservationWindow(id),readTextResourceSnapshot:(readKey:string)=>browserPhases.readTextResourceSnapshot(readKey),beginCpuObservationWindow:(id:string)=>browserPhases.beginCpuObservationWindow(id),endCpuObservationWindow:(id:string)=>browserPhases.endCpuObservationWindow(id),ensureAdapterUploads:()=>browserPhases.ensureAdapterUploads()}),configurable:true});
