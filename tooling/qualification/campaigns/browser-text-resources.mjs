import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {readTextResourceSnapshot} from './browser-phase-snapshot.mjs';
import {isTextResourceOwnershipProof,TEXT_RESOURCE_OWNERSHIP_CONTRACT} from './renderer-ownership.mjs';
export const TEXT_RESOURCE_OPERATIONS=Object.freeze(['text.font-set','text.mixed-ready','text.active-layout','text.apply','text.recovery','portable.reopen']);
const proofs=new WeakMap();
const hash=value=>'sha256:'+createHash('sha256').update(value).digest('hex');
const natural=value=>Number.isSafeInteger(value)&&value>=0;
const time=value=>Number.isFinite(value)&&value>=0;
const ledgerIdentity=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const exact=(value,keys)=>!!value&&typeof value==='object'&&!Array.isArray(value)&&isDeepStrictEqual(Object.keys(value).sort(),[...keys].sort());
const check=(value,message)=>assert(value,'TEXT_RESOURCE_EVIDENCE: '+message);
const keys=['atMs','ledgerSequence','textSequence','cpu','poolTextBytes','glyphGpuBytes','sequence'];
const failures=new Set(['invalid-point','clock-regression','same-sequence-changed-amounts','transition-gap','counter-overflow','row-limit','text-observer-unavailable','text-observer-rebound','text-observer-disconnected','text-sequence-discontinuity','text-observer-fault','text-observation-invalid','clock-invalid','observer-reentrant']);
const reopenFailures=new Set(['checkpoint-unavailable','checkpoint-missing','checkpoint-repeated']);
const total=point=>point.cpu.reduce((sum,bytes)=>sum+bytes,point.poolTextBytes);
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
function point(value){check(exact(value,keys),'point keys');for(const key of ['ledgerSequence','textSequence','poolTextBytes','glyphGpuBytes','sequence'])check(natural(value[key]),'point '+key);check(time(value.atMs)&&Array.isArray(value.cpu)&&value.cpu.length===7&&value.cpu.every(natural)&&natural(total(value)),'point amount or clock');}
function ack(value,boundary,window){check(exact(value,['kind','schemaVersion','ledgerInstanceId','id','ordinal','boundary','atMs','clockOriginMs','ledgerSequence','textSequence','sealed']),'ack keys');const p=boundary==='begin'?window.initial:window.final;check(value.kind==='text-resource-window-ack-1'&&value.schemaVersion===1&&value.boundary===boundary&&value.sealed===(boundary==='end')&&value.ledgerInstanceId===window.ledgerInstanceId&&value.id===window.id&&value.ordinal===window.ordinal&&value.clockOriginMs===window.clockOriginMs&&value.atMs===p.atMs&&value.ledgerSequence===p.ledgerSequence&&value.textSequence===p.textSequence,'window acknowledgment binding');}
/** Structural replay only. This grants no source, realm, metric or host authority. */
export function replayTextResourceWindow(window){
 const w=window;check(exact(w,['kind','schemaVersion','scope','ledgerInstanceId','id','ordinal','clock','clockOriginMs','cpuKinds','initial','final','rows','peakCpu','peakGlyphGpu','sealed','observationComplete','failures','dropped','transitionCount']),'window keys');
 check(w.kind==='text-resource-window-1'&&w.schemaVersion===1&&w.scope===TEXT_RESOURCE_OWNERSHIP_CONTRACT.scope&&ledgerIdentity(w.ledgerInstanceId)&&/^[A-Za-z0-9_-]{1,64}$/.test(w.id)&&natural(w.ordinal)&&w.ordinal>0&&w.clock==='browser-performance'&&time(w.clockOriginMs),'window identity');
 check(isDeepStrictEqual(w.cpuKinds,TEXT_RESOURCE_OWNERSHIP_CONTRACT.cpuKinds),'CPU attribution scope');
 check(w.sealed===true&&typeof w.observationComplete==='boolean'&&Array.isArray(w.failures)&&w.failures.length<=failures.size&&new Set(w.failures).size===w.failures.length&&w.failures.every(v=>failures.has(v))&&natural(w.dropped)&&natural(w.transitionCount),'window status');
 check(Array.isArray(w.rows)&&w.rows.length<=4096&&w.rows.length+w.dropped===w.transitionCount,'bounded complete transition inventory');
 point(w.initial);point(w.final);check(w.initial.sequence===0&&w.final.sequence===w.transitionCount&&w.final.atMs>=w.initial.atMs,'window endpoints');
 let previous=w.initial,peakCpu={bytes:total(previous),sequence:0},peakGlyphGpu={bytes:previous.glyphGpuBytes,sequence:0};
 for(const [index,value] of w.rows.entries()){
  point(value);check(value.sequence===index+1&&value.atMs>=previous.atMs&&value.atMs<=w.final.atMs,'transition order');
  const ld=value.ledgerSequence-previous.ledgerSequence,td=value.textSequence-previous.textSequence;
  if(w.observationComplete)check([0,1].includes(ld)&&[0,1].includes(td)&&ld+td===1,'missing or duplicated allocation transition');
  if(total(value)>peakCpu.bytes)peakCpu={bytes:total(value),sequence:value.sequence};
  if(value.glyphGpuBytes>peakGlyphGpu.bytes)peakGlyphGpu={bytes:value.glyphGpuBytes,sequence:value.sequence};previous=value;
 }
 // A final endpoint survives even when the bounded transition journal lost
 // its tail. It remains an observed lower bound, never gap completeness.
 const finalDiffers=!isDeepStrictEqual(w.final,{...previous,atMs:w.final.atMs});
 if(total(w.final)>peakCpu.bytes)peakCpu={bytes:total(w.final),sequence:w.final.sequence};
 if(w.final.glyphGpuBytes>peakGlyphGpu.bytes)peakGlyphGpu={bytes:w.final.glyphGpuBytes,sequence:w.final.sequence};
 for(const p of [w.peakCpu,w.peakGlyphGpu])check(exact(p,['bytes','sequence'])&&natural(p.bytes)&&natural(p.sequence)&&p.sequence<=w.transitionCount,'peak shape');
 const complete=w.observationComplete&&w.failures.length===0&&w.dropped===0;
 if(complete){check(isDeepStrictEqual(w.final,{...previous,atMs:w.final.atMs}),'final owner amounts or sequences differ');check(isDeepStrictEqual(w.peakCpu,peakCpu)&&isDeepStrictEqual(w.peakGlyphGpu,peakGlyphGpu),'peak replay mismatch');}
 else{check(w.peakCpu.bytes>=peakCpu.bytes&&w.peakGlyphGpu.bytes>=peakGlyphGpu.bytes,'partial peak below retained observation');}
 check(!w.observationComplete||complete,'contradictory complete flag');
 return {complete,points:[w.initial,...w.rows,...(finalDiffers?[w.final]:[])],peakCpu,peakGlyphGpu};
}
/** Recompute simultaneous peaks from every retained producer transition. Neither
 * endpoint maxima nor a caller's complete flag can qualify this metric. */
export function replayTextResourceEvidence(evidence,{binding,rendererOwnershipProof}={}){
 check(exact(evidence,['kind','schemaVersion','binding','begin','end','window','failed','rendererOwnershipProof','timing','realm']),'evidence keys');
 check(evidence.kind==='text-resource-evidence-1'&&evidence.schemaVersion===1&&typeof evidence.failed==='boolean','evidence schema');
 if(binding)check(isDeepStrictEqual(evidence.binding,binding),'cell/cycle/fixture/process/source binding');
 const b=evidence.binding;check(b&&typeof b.cellId==='string'&&b.cellId.length>0&&typeof b.fixtureIdentity==='string'&&/^sha256:[a-f0-9]{64}$/.test(b.fixtureIdentity)&&typeof b.processIdentity==='string'&&b.processIdentity.length>0&&b.processIdentity.length<=16384&&((natural(b.cycleOrdinal)&&b.cycleOrdinal>0)||(natural(b.serial)&&b.serial>0)),'binding fields');
 const timing=evidence.timing;check(exact(timing,['clock','originMs','startedMs','endedMs'])&&timing.clock==='runner-monotonic'&&time(timing.originMs)&&time(timing.startedMs)&&time(timing.endedMs)&&timing.endedMs>=timing.startedMs,'runner interval');
 const w=evidence.window,{complete}=replayTextResourceWindow(w);
 ack(evidence.begin,'begin',w);ack(evidence.end,'end',w);
 const realm=evidence.realm,reopen=realm?.mode==='portable-reopen-startup';let realmComplete=true;
 check(exact(realm,reopen?['mode','prior','navigations','checkpoint','failures']:['mode','prior','navigations']),'realm keys');
 if(realm.mode==='new-realm-startup'){
  check(b.operation==='text.mixed-ready'&&exact(realm.prior,['ledgerInstanceId','clockOriginMs'])&&ledgerIdentity(realm.prior.ledgerInstanceId)&&time(realm.prior.clockOriginMs)&&realm.prior.ledgerInstanceId!==w.ledgerInstanceId&&realm.prior.clockOriginMs<w.clockOriginMs&&w.id==='startup-'+w.ledgerInstanceId,'fresh native font authority realm');
  check(Array.isArray(realm.navigations)&&realm.navigations.length===1&&time(realm.navigations[0])&&realm.navigations[0]>=timing.startedMs&&realm.navigations[0]<=timing.endedMs,'actual single main-frame navigation');
  }else if(reopen){
  // Cold starts begin blank; a warm child keeps its actual previous document.
  // The loaded prior is identity evidence only: its allocations, teardown and
  // clock are never combined with the new startup window.
  const prior=realm.prior;
  const blank=prior?.documentKind==='about:blank',priorKeys=['documentKind','topLevel','phaseOwnerPresent','clockOriginMs','atMs'];
  check(b.operation==='portable.reopen'&&exact(prior,blank?priorKeys:[...priorKeys,'ledgerInstanceId','windowId','windowOrdinal','ended'])&&
   prior.topLevel===true&&time(prior.clockOriginMs)&&prior.clockOriginMs>0&&time(prior.atMs)&&prior.clockOriginMs<w.clockOriginMs&&
   (blank?prior.phaseOwnerPresent===false:prior.documentKind==='application'&&prior.phaseOwnerPresent===true&&ledgerIdentity(prior.ledgerInstanceId)&&
    prior.ledgerInstanceId!==w.ledgerInstanceId&&prior.windowId==='startup-'+prior.ledgerInstanceId&&natural(prior.windowOrdinal)&&prior.windowOrdinal>0&&typeof prior.ended==='boolean')&&
   w.id==='startup-'+w.ledgerInstanceId,'fresh portable prior-to-application realm');
  check(Array.isArray(realm.navigations)&&realm.navigations.length===1&&time(realm.navigations[0])&&realm.navigations[0]>=timing.startedMs&&realm.navigations[0]<=timing.endedMs,'actual single portable main-frame navigation');
  check(Array.isArray(realm.failures)&&realm.failures.length<=reopenFailures.size&&new Set(realm.failures).size===realm.failures.length&&realm.failures.every(code=>reopenFailures.has(code)),'portable observation failures');
  const checkpoint=realm.checkpoint;
  if(checkpoint!==null){
   check(exact(checkpoint,['startedMs','endedMs','clockOriginMs','atMs','ledgerInstanceId','windowId','windowOrdinal','ended'])&&
    time(checkpoint.startedMs)&&time(checkpoint.endedMs)&&checkpoint.startedMs>=realm.navigations[0]&&checkpoint.endedMs>=checkpoint.startedMs&&checkpoint.endedMs<=timing.endedMs&&
    checkpoint.clockOriginMs===w.clockOriginMs&&time(checkpoint.atMs)&&checkpoint.atMs>=w.initial.atMs&&checkpoint.atMs<=w.final.atMs&&
    checkpoint.ledgerInstanceId===w.ledgerInstanceId&&checkpoint.windowId===w.id&&checkpoint.windowOrdinal===w.ordinal&&checkpoint.ended===false,
    'portable original action endpoint or startup window differs');
  }else check(realm.failures.some(code=>code==='checkpoint-missing'||code==='checkpoint-unavailable'),'portable missing checkpoint reason');
  realmComplete=checkpoint!==null&&realm.failures.length===0;
 }else check(realm.mode==='explicit-window'&&!['text.mixed-ready','portable.reopen'].includes(b.operation)&&realm.prior===null&&Array.isArray(realm.navigations)&&realm.navigations.length===0,'explicit stable-realm window');
 check(/^text-[a-f0-9-]{36}$/.test(b.observerId??'')&&(realm.mode==='new-realm-startup'||reopen||w.id===b.observerId),'attempt observer/window identity');
 if(rendererOwnershipProof!==undefined)check(isDeepStrictEqual(evidence.rendererOwnershipProof,rendererOwnershipProof),'renderer proof substitution');
 const proof=evidence.rendererOwnershipProof,approved=isTextResourceOwnershipProof(proof);
 // Exact full executable identity comes from the parent, never the producer.
 if(proof)check(isDeepStrictEqual(proof.executableIdentity,b.executableIdentity),'renderer proof executable identity');
 const cpuBoundSufficient=w.peakCpu.bytes<=128*1048576;
 const cpuComplete=complete&&realmComplete&&!evidence.failed&&approved&&cpuBoundSufficient;
 const glyphComplete=complete&&realmComplete&&!evidence.failed&&approved&&w.peakGlyphGpu.bytes===0;
 const scope='Simultaneous conservative reservations: text pool (including parser/worker/bounded WASM) plus shared font/text/control/prompt/staging/scratch/copy owners; no physical RSS claim';
 const measurements=[...(cpuBoundSufficient?[{name:'R35FontShapingCpuBytes',value:w.peakCpu.bytes,unit:'bytes',method:scope,complete:cpuComplete}]:[]),{name:'R35GlyphGpuBytes',value:w.peakGlyphGpu.bytes,unit:'bytes',method:'Exact reviewed software renderer application-owned glyph bookings; excludes physical/native GPU memory and display RGBA backing',complete:glyphComplete}];
 const missing=[];if(!cpuBoundSufficient)missing.push('conservative-shared-owner-upper-bound-exceeds-r35-ceiling-attribution-required');if(!complete)missing.push('text-resource-transition-window-incomplete');if(evidence.failed)missing.push('text-resource-action-failed');if(!approved)missing.push('exact-text-resource-source-native-runtime-review-unavailable');if(w.peakGlyphGpu.bytes!==0)missing.push('glyph-bookings-conflict-with-reviewed-software-renderer');
 if(!realmComplete)missing.push('portable-text-resource-original-action-endpoint-unavailable');
 return {measurements,missing,complete:cpuComplete&&glyphComplete,scope:TEXT_RESOURCE_OWNERSHIP_CONTRACT};
}
export async function verifyTextResourceArtifact({artifact,binding,rendererOwnershipProof,readRetained,journalEvents}){
 check(artifact&&isAbsolute(artifact.path)&&natural(artifact.bytes)&&artifact.bytes>0&&artifact.bytes<=8*1048576&&/^sha256:[a-f0-9]{64}$/.test(artifact.sha256)&&typeof readRetained==='function','artifact identity');
 const bytes=await readRetained(artifact.path,{maximum:8*1048576});check(bytes.byteLength===artifact.bytes&&hash(bytes)===artifact.sha256,'retained artifact hash/length');
 const evidence=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),replay=replayTextResourceEvidence(evidence,{binding,rendererOwnershipProof});
 check(Array.isArray(journalEvents),'actual producer journal required');
 const intents=journalEvents.filter(event=>event.event==='text-resources-intent'&&event.observerId===evidence.binding.observerId);
 check(intents.length===1&&isDeepStrictEqual(intents[0].binding,evidence.binding)&&intents[0].startedMs===evidence.timing.startedMs,'single actual intent journal binding');
 const begins=journalEvents.filter(event=>event.event==='text-resources-begin'&&event.windowId===evidence.begin.id),ends=journalEvents.filter(event=>event.event==='text-resources-observed'&&event.windowId===evidence.begin.id);
 check(begins.length===1&&ends.length===1,'single actual producer journal bracket');
 check(isDeepStrictEqual(begins[0].binding,evidence.binding)&&isDeepStrictEqual(begins[0].begin,evidence.begin)&&begins[0].startedMs===evidence.timing.startedMs,'begin journal binding');
 check(isDeepStrictEqual(ends[0].binding,evidence.binding)&&isDeepStrictEqual(ends[0].artifact,artifact)&&ends[0].endedMs===evidence.timing.endedMs,'final journal binding');
 if(evidence.realm.mode==='portable-reopen-startup'){
  const checkpoints=journalEvents.filter(event=>event.event==='text-resources-checkpoint'&&event.observerId===evidence.binding.observerId);
  check(evidence.realm.checkpoint===null?checkpoints.length===0:checkpoints.length===1&&isDeepStrictEqual(checkpoints[0].binding,evidence.binding)&&isDeepStrictEqual(checkpoints[0].checkpoint,evidence.realm.checkpoint),'single actual portable checkpoint journal binding');
 }
 return issueResult(replay,evidence,artifact);
}
export function textResourceBinding({cell,sample,serial,cycleOrdinal,fixtureIdentity,processIdentity,executableIdentity,observerId}){return {cellId:cell.id,operation:cell.operation,...(cycleOrdinal?{cycleOrdinal}:{serial,sample:{cache:sample?.cache??null,ordinal:sample?.ordinal??null,prime:sample?.prime??null}}),fixtureIdentity,processIdentity:typeof processIdentity==='string'?processIdentity:canonical(processIdentity),executableIdentity,...(observerId?{observerId}:{})};}
export function createTextResourceObserver({page,cell,sample,serial,cycleOrdinal,fixtureIdentity,processIdentity,rendererOwnershipProof=null,executableIdentity,output,journal}){
 const id='text-'+randomUUID(),binding=textResourceBinding({cell,sample,serial,cycleOrdinal,fixtureIdentity,processIdentity,executableIdentity,observerId:id});
 const reopen=cell.operation==='portable.reopen',startup=cell.operation==='text.mixed-ready'||reopen;
 const realm={mode:reopen?'portable-reopen-startup':startup?'new-realm-startup':'explicit-window',prior:null,navigations:[],...(reopen?{checkpoint:null,failures:[]}: {})};
 let started=null,done=null,startedMs=null,navigationCount=0,checkpointCalled=false,closed=false;
 const navigation=frame=>{if(frame!==page.mainFrame())return;navigationCount++;if(realm.navigations.length<2)realm.navigations.push(performance.now());};
 return {
  async begin(){
   if(started)return started;startedMs=performance.now();
   if(reopen){
    realm.prior=await page.evaluate(()=>{
     if(window.top!==window)throw Error('PORTABLE_TEXT_RESOURCE_PRIOR_REALM');
     const owner=globalThis.__IDEOGRAM_PHASES__;
     if(location.href==='about:blank'){
      if(owner!==undefined)throw Error('PORTABLE_TEXT_RESOURCE_PRIOR_REALM');
      return {documentKind:'about:blank',topLevel:true,phaseOwnerPresent:false,clockOriginMs:performance.timeOrigin,atMs:performance.now()};
     }
     const identity=owner?.textResourceStartupIdentity?.();
     if(!identity||identity.clockOriginMs!==performance.timeOrigin)throw Error('PORTABLE_TEXT_RESOURCE_PRIOR_IDENTITY');
     return {documentKind:'application',topLevel:true,phaseOwnerPresent:true,clockOriginMs:performance.timeOrigin,atMs:performance.now(),
      ledgerInstanceId:identity.ledgerInstanceId,windowId:identity.begin?.id,windowOrdinal:identity.begin?.ordinal,ended:identity.ended};
    });
    const prior=realm.prior,blank=prior?.documentKind==='about:blank',priorKeys=['documentKind','topLevel','phaseOwnerPresent','clockOriginMs','atMs'];
    check(exact(prior,blank?priorKeys:[...priorKeys,'ledgerInstanceId','windowId','windowOrdinal','ended'])&&prior.topLevel===true&&time(prior.clockOriginMs)&&prior.clockOriginMs>0&&time(prior.atMs)&&
     (blank?prior.phaseOwnerPresent===false:prior.documentKind==='application'&&prior.phaseOwnerPresent===true&&ledgerIdentity(prior.ledgerInstanceId)&&
      prior.windowId==='startup-'+prior.ledgerInstanceId&&natural(prior.windowOrdinal)&&prior.windowOrdinal>0&&typeof prior.ended==='boolean'),'observed portable prior realm unavailable');
    page.on('framenavigated',navigation);started={navigationPending:true};
   }else if(startup){const prior=await page.evaluate(()=>globalThis.__IDEOGRAM_PHASES__?.textResourceStartupIdentity?.()??null);check(prior,'prior realm identity unavailable');realm.prior={ledgerInstanceId:prior.ledgerInstanceId,clockOriginMs:prior.clockOriginMs};page.on('framenavigated',navigation);started={navigationPending:true};}
   else{started=await page.evaluate(id=>globalThis.__IDEOGRAM_PHASES__?.beginTextResourceObservationWindow?.(id)??null,id);check(started,'product window unavailable');}
   await journal?.({event:'text-resources-intent',observerId:id,binding,startedMs});
   if(!startup)await journal?.({event:'text-resources-begin',windowId:started.id,binding,begin:started,startedMs});return started;
  },
  /** Called inside the original portable action after its real public Open and
   * accepted checkpoint, before Composition closes the shared startup window.
   * No navigation, product input, preparation or memory reset is introduced. */
  async checkpoint(){
   check(reopen&&started&&!done&&!closed,'portable checkpoint requires its active observer');
   if(checkpointCalled){if(!realm.failures.includes('checkpoint-repeated'))realm.failures.push('checkpoint-repeated');throw Error('TEXT_RESOURCE_EVIDENCE: portable checkpoint repeated');}
   checkpointCalled=true;const checkpointStartedMs=performance.now();
   let value;
   try{value=await page.evaluate(()=>{
    if(location.href==='about:blank'||window.top!==window)throw Error('PORTABLE_TEXT_RESOURCE_CURRENT_REALM');
    const identity=globalThis.__IDEOGRAM_PHASES__?.textResourceStartupIdentity?.();
    if(!identity||identity.clockOriginMs!==performance.timeOrigin)throw Error('PORTABLE_TEXT_RESOURCE_STARTUP_IDENTITY');
    return {clockOriginMs:performance.timeOrigin,atMs:performance.now(),ledgerInstanceId:identity.ledgerInstanceId,windowId:identity.begin?.id,windowOrdinal:identity.begin?.ordinal,ended:identity.ended};
   });}catch{realm.failures.push('checkpoint-unavailable');return null;}
   realm.checkpoint={startedMs:checkpointStartedMs,endedMs:performance.now(),...value};
   await journal?.({event:'text-resources-checkpoint',observerId:id,binding,checkpoint:realm.checkpoint});
   return structuredClone(realm.checkpoint);
  },
  async finish({failed=false}={}){
   if(done)return done;check(started,'resource window did not begin');
   if(reopen){check(!closed,'portable resource observer already closed');closed=true;}
   if(reopen&&!checkpointCalled)realm.failures.push('checkpoint-missing');
   let end,window;
   try{
    if(startup){if(!reopen){page.off('framenavigated',navigation);check(navigationCount===1,'one actual navigation required');}const boundaries=await page.evaluate(()=>globalThis.__IDEOGRAM_PHASES__?.sealTextResourceStartupWindow?.()??null);check(boundaries,'new realm startup window unavailable');started=boundaries.begin;end=boundaries.end;await journal?.({event:'text-resources-begin',windowId:started.id,binding,begin:started,startedMs});}
    else end=await page.evaluate(id=>globalThis.__IDEOGRAM_PHASES__?.endTextResourceObservationWindow?.(id)??null,id);
    window=await readTextResourceSnapshot(page);
   }finally{if(reopen)page.off('framenavigated',navigation);}
   const timing={clock:'runner-monotonic',originMs:performance.timeOrigin,startedMs,endedMs:performance.now()};
   const evidence={kind:'text-resource-evidence-1',schemaVersion:1,binding,begin:started,end,window,failed,rendererOwnershipProof,timing,realm};
   const directory=join(output,'text-resources');await mkdir(directory,{recursive:true,mode:0o700});const path=join(directory,id+'.json');
   const bytes=Buffer.from(JSON.stringify(evidence,null,2)+'\n');check(bytes.length<=8*1048576,'artifact byte cap');await writeFile(path,bytes,{flag:'wx',mode:0o600});
   const artifact={path,bytes:bytes.length,sha256:hash(bytes)};
   await journal?.({event:'text-resources-observed',windowId:started.id,binding,artifact,endedMs:timing.endedMs});
   let value;try{value=replayTextResourceEvidence(evidence,{binding,rendererOwnershipProof});}catch(error){error.textResourceArtifact=artifact;throw error;}
   done=issueResult(value,evidence,artifact);return done;
  }
 };
}

function issueResult(value,evidence,artifact){
 const result={...value,artifact,evidence,measurements:value.measurements.map(row=>({...row,evidence:{kind:'text-resource-measurement-evidence-1',binding:evidence.binding,artifact}}))};
 const proof=Object.freeze({});proofs.set(proof,structuredClone(result));return {...result,proof};
}
export function textResourceMeasurement({cell,sample,rule,proof}){
 const result=proofs.get(proof),binding=result?.evidence.binding;
 if(!binding||binding.cellId!==cell?.id||binding.operation!==cell?.operation||!TEXT_RESOURCE_OPERATIONS.includes(cell?.operation)||!isDeepStrictEqual(binding.sample,{cache:sample?.cache??null,ordinal:sample?.ordinal??null,prime:sample?.prime??null}))return {reason:'Current ordinary text resource issuer is unavailable or differs from the scheduled sample'};
 if(rule?.budgetId!=='R35'||rule.unit!=='bytes'||!['R35FontShapingCpuBytes','R35GlyphGpuBytes'].includes(rule.name))return {reason:'Invalid R35 resource registry identity'};
 const row=result.measurements.find(value=>value.name===rule.name);if(!row?.complete)return {reason:result.missing.join('; ')||'Exact metric ownership proof is incomplete'};
 return {measurement:structuredClone(row)};
}
