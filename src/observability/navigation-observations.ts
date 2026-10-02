import {diagnosticMemory,type DiagnosticLease} from './diagnostic-memory.js';
import {sanitizePhaseContext} from './phases.js';

export type NavigationTarget={sessionId:string;generation:number;documentId:string;revision:string;assetId:string;assetHash:string};
type NavigationIdentity=NavigationTarget&{snapshotId:string|null};
type RenderMeaning='canonical-canvas-render-submitted'|'canonical-resident-submission-observed';
type Observation={renderMeaning:RenderMeaning|null;identity:NavigationIdentity;modelReadyMs:number|null;renderSubmittedMs:number|null;editAvailableMs:number|null;viewportCurrent:boolean;editAvailable:boolean};
// One current observation, one render-time gate, and bounded validation/copy
// overlap. This is a logical payload allowance, never physical engine memory.
export const NAVIGATION_OBSERVATION_BYTES=32768;
const fields=['sessionId','generation','documentId','revision','assetId','assetHash'] as const;
function target(input:NavigationTarget):NavigationTarget|null {
 const safe=sanitizePhaseContext(input);
 if(fields.some(key=>safe[key]===undefined))return null;
 return {sessionId:safe.sessionId!,generation:safe.generation!,documentId:safe.documentId!,revision:safe.revision!,assetId:safe.assetId!,assetHash:safe.assetHash!};
}
function matches(a:NavigationTarget,b:NavigationTarget){return fields.every(key=>a[key]===b[key]);}

/** Current-document observations only: stored authoritative models, canonical
 * canvas submission, and the shell's committed document-control gate. These
 * endpoints do not assert fresh text shaping, native focus, or physical paint. */
export class NavigationObservations {
 private row:Observation|null=null;
 private rendered:{target:NavigationTarget;enabled:boolean}|null=null;
 private readonly lease:DiagnosticLease;
 private disposed=false;
 constructor(private readonly now:()=>number,private readonly navigationTimeOriginMs:number){
  if(!Number.isFinite(navigationTimeOriginMs)||navigationTimeOriginMs<0)throw Error('NAVIGATION_CLOCK_ORIGIN');
  this.lease=diagnosticMemory.reserve('diagnostic-navigation-state',NAVIGATION_OBSERVATION_BYTES);
 }
 private check(){if(this.disposed)throw Error('NAVIGATION_OBSERVATIONS_DISPOSED');}
 private create(value:NavigationTarget):Observation{return {renderMeaning:null,identity:{...value,snapshotId:null},modelReadyMs:null,renderSubmittedMs:null,editAvailableMs:null,viewportCurrent:false,editAvailable:false};}
 modelReady(input:NavigationTarget&{snapshotId:string}){
  this.check();const value=target(input),snapshotId=sanitizePhaseContext(input).snapshotId;if(!value||!snapshotId)return;
  if(!this.row||!matches(this.row.identity,value)||this.row.identity.snapshotId!==null&&this.row.identity.snapshotId!==snapshotId)this.row=this.create(value);
  this.row.identity.snapshotId=snapshotId;this.row.modelReadyMs??=this.now();
 }
 renderSubmitted(input:NavigationTarget){
  this.check();const value=target(input);if(!value)return;
  // A late viewport callback cannot replace an authoritative successor root.
  if(this.row&&!matches(this.row.identity,value))return;
  this.row??=this.create(value);if(this.row.renderSubmittedMs===null){this.row.renderSubmittedMs=this.now();this.row.renderMeaning='canonical-canvas-render-submitted';}this.row.viewportCurrent=true;
 }
 controlsRendered(input:NavigationTarget|null,enabled:boolean){
  this.check();const value=input&&target(input);this.rendered=value?{target:value,enabled:enabled===true}:null;
 }
 controlsCommitted(input:NavigationTarget|null,viewportCurrent:boolean,enabled:boolean){
  this.check();const value=input&&target(input),row=this.row,rendered=this.rendered;this.rendered=null;
  if(!row||!value||!matches(row.identity,value))return;
  if(!viewportCurrent){this.viewportUnavailable();return;}
  // decodedAssetId proves that the exact canonical asset was drawn. A
  // recovered metadata root may reuse it without requesting another draw;
  // report the current residency observation, never a fresh decode or draw.
  if(row.modelReadyMs!==null&&!row.viewportCurrent){row.viewportCurrent=true;row.renderSubmittedMs=this.now();row.renderMeaning='canonical-resident-submission-observed';}
  row.editAvailable=!!rendered&&matches(rendered.target,value)&&rendered.enabled&&enabled===true&&row.viewportCurrent&&row.modelReadyMs!==null&&row.renderSubmittedMs!==null;
  if(row.editAvailable)row.editAvailableMs??=this.now();else row.editAvailableMs=null;
 }
 viewportUnavailable(){this.check();if(this.row){this.row.viewportCurrent=false;this.row.renderSubmittedMs=null;this.row.renderMeaning=null;this.row.editAvailable=false;this.row.editAvailableMs=null;}}
 reset(){this.check();this.row=null;this.rendered=null;}
 copy(){this.check();return this.row?{schemaVersion:1 as const,navigationTimeOriginMs:this.navigationTimeOriginMs,...structuredClone(this.row),milestonePolicy:'current-availability-episode' as const,modelMeaning:'stored-authoritative-model' as const,editMeaning:'shell-committed-document-controls' as const,presentationEvidence:'external-trace-required' as const}:null;}
 dispose(){if(this.disposed)return;this.reset();this.disposed=true;this.lease.release();}
}
