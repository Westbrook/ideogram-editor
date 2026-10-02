import {createHash,randomBytes} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,mkdir,open,realpath,readdir,writeFile} from 'node:fs/promises';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {monotonic} from './common.mjs';
import {readFirstUseOrdinaryInput} from './windowserver-first-use.mjs';
import {startNavigationWindowServerCapture,verifyLiveNavigationWindowServerEvidence} from './windowserver-navigation-verification.mjs';
import {NAVIGATION_PIXEL_LIMIT,nativeNavigationConfiguration,navigationAttemptBinding,navigationEnvironmentBinding,
  validateNavigationOracle,validateNavigationWitness,joinNavigationWindowServerPixels} from './windowserver-navigation-contract.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const demand=(value,message)=>{if(!value)throw Error('Navigation native: '+message);};
const same=(a,b,message)=>demand(isDeepStrictEqual(a,b),message);
const copy=value=>structuredClone(value);
const json=bytes=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
const info=error=>({name:String(error?.name??'Error').slice(0,64),message:String(error?.message??error).slice(0,1024)});
const nativeClock=(value,id)=>value?.schemaVersion===1&&value.event==='clock'&&value.id===id&&typeof value.mach==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(value.mach)&&BigInt(value.mach)<=18446744073709551615n;

// Reuse the existing ordinary reader for metadata. Larger whole-viewport pixel
// files use the same canonical/O_NOFOLLOW/stable-identity boundary, bounded by
// the native collector's existing 256 MiB cap rather than the small-panel cap.
export async function readNavigationOrdinaryInput(path,maximum,signal) {
  signal?.throwIfAborted();
  demand(Number.isSafeInteger(maximum)&&maximum>0&&maximum<=NAVIGATION_PIXEL_LIMIT,'ordinary read bound invalid');
  if(maximum<=8*1024**2){const result=await readFirstUseOrdinaryInput(path,maximum);signal?.throwIfAborted();return result;}
  demand(isAbsolute(path??'')&&resolve(path)===path&&await realpath(path)===path,'ordinary input must be canonical and nonsymlink');
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const before=await handle.stat();demand(before.isFile()&&before.size>0&&before.size<=maximum,'pixel file exceeds ordinary bound');
    const bytes=Buffer.alloc(before.size);let position=0;
    while(position<bytes.length){signal?.throwIfAborted();const result=await handle.read(bytes,position,Math.min(1024**2,bytes.length-position),position);demand(result.bytesRead>0,'pixel file truncated');position+=result.bytesRead;}
    const after=await handle.stat(),named=await lstat(path);
    demand(named.isFile()&&!named.isSymbolicLink()&&['dev','ino','size','mode','mtimeMs','ctimeMs'].every(key=>before[key]===after[key]&&after[key]===named[key]),'ordinary input changed during read');
    signal?.throwIfAborted();return{bytes,identity:{path,bytes:bytes.length,sha256:hash(bytes)}};
  }finally{await handle.close();}
}
async function outputIdentity(path){
  demand(isAbsolute(path??'')&&resolve(path)===path&&await realpath(path)===path,'output is not canonical');
  const stat=await lstat(path);demand(stat.isDirectory()&&!stat.isSymbolicLink()&&typeof process.getuid==='function'&&stat.uid===process.getuid()&&(stat.mode&0o777)===0o700,'output is not a private owned directory');return stat;
}
async function exclusiveJSON(path,value){const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');await writeFile(path,bytes,{flag:'wx',mode:0o600});return{path,bytes:bytes.length,sha256:hash(bytes)};}

/** Explicit already-built collector and independently reviewed oracle pins.
 * Preparation pins inputs only. Baseline capture and the lower clock anchor
 * belong exclusively to navigationStart around the driver's original goto. */
export async function prepareNavigationWindowServer({configuration,runtime,cell,sample,serial,fixture,invocation,output,signal}) {
  const selected=nativeNavigationConfiguration(configuration,runtime,{cell,sample});if(!selected)return null;
  const attempt=navigationAttemptBinding({cell,sample,serial,fixture,invocation});
  const environment=navigationEnvironmentBinding(runtime,invocation);
  same(runtime.fixtureSeal,fixture.seal,'browser and scheduled fixture differ');
  demand(invocation.workerProcessIdentity.pid===process.pid,'navigation worker is not this producer');
  signal?.throwIfAborted();const outputBefore=await outputIdentity(output),navigationNonce=randomBytes(24).toString('hex'),nativeId='nv-'+navigationNonce;
  const source=await readFirstUseOrdinaryInput(fileURLToPath(new URL('../native/windowserver-capture.swift',import.meta.url)),1024**2);
  const oracles={},oracleInputs={};
  for(const endpoint of ['shell','canvas']){
    const pin=selected.profile[endpoint],manifest=await readFirstUseOrdinaryInput(pin.path,65536);
    demand(manifest.identity.sha256===pin.sha256,'oracle manifest pin differs');
    const oracle=json(manifest.bytes),pixels=new Map(),identities=[];
    for(const name of ['before.bgra','after.bgra']){
      const item=await readNavigationOrdinaryInput(join(dirname(pin.path),name),NAVIGATION_PIXEL_LIMIT,signal);pixels.set(name,item.bytes);identities.push({...item.identity,path:name});
    }
    validateNavigationOracle(oracle,pixels,{endpoint,selection:selected,environment,attempt});
    const retained=join(output,'oracle-nav-'+navigationNonce+'-'+endpoint);await mkdir(retained,{mode:0o700});
    await writeFile(join(retained,'oracle.json'),manifest.bytes,{flag:'wx',mode:0o600});
    for(const[name,bytes]of pixels)await writeFile(join(retained,name),bytes,{flag:'wx',mode:0o600});
    oracles[endpoint]={path:join(retained,'oracle.json'),bytes:manifest.bytes.length,sha256:manifest.identity.sha256,pixels:identities};
    oracleInputs[endpoint]={oracle,oracleBytes:manifest.bytes,oraclePixels:pixels,oracleSha256:manifest.identity.sha256};
  }
  const binding={kind:'navigation-windowserver-input-binding-1',navigationNonce,attempt,invocation:copy(invocation),browser:copy(runtime),environment,
    selection:selected.selection,collectorSource:source.identity,oracles,capturePlan:selected.capturePlan};
  const now=await outputIdentity(output);demand(now.dev===outputBefore.dev&&now.ino===outputBefore.ino,'output directory replaced during retention');
  const context={configuration,runtime,cell,sample,serial,fixture,invocation,output,signal,selected,binding,navigationNonce,nativeId,oracleInputs,
    outputIdentity:{dev:outputBefore.dev,ino:outputBefore.ino},captures:{},stopped:{},handles:{},missing:[],failures:[]};
  return createNavigationWindowServerTransaction(context);
}

async function originalCapture(stopped,signal){
  demand(stopped?.manifest&&stopped?.process,'owned stopped capture unavailable');
  const manifest=await readFirstUseOrdinaryInput(stopped.manifest.path,8*1024**2);
  same(manifest.identity,stopped.manifest,'original capture manifest changed');
  const parsed=json(manifest.bytes),directory=dirname(stopped.manifest.path);
  demand(Array.isArray(parsed.pixelFiles)&&parsed.pixelFiles.length<=5000,'capture member inventory invalid');
  same((await readdir(directory)).sort(),['manifest.json','frames.ndjson',...parsed.pixelFiles.map(row=>row.path)].sort(),'capture membership differs');
  const frames=await readFirstUseOrdinaryInput(join(directory,'frames.ndjson'),8*1024**2),pixels=new Map();let total=0;
  for(const member of parsed.pixelFiles){
    demand(/^frame-[1-9][0-9]{0,4}\.bgra$/.test(member?.path??'')&&!pixels.has(member.path)&&Number.isSafeInteger(member.bytes)&&member.bytes>0,'capture pixel path invalid');
    total+=member.bytes;demand(total<=parsed.config.maxBytes&&total<=NAVIGATION_PIXEL_LIMIT,'capture pixel allocation exceeded');
    const item=await readNavigationOrdinaryInput(join(directory,member.path),member.bytes,signal);
    demand(item.identity.bytes===member.bytes&&item.identity.sha256===member.sha256,'capture pixel changed');pixels.set(member.path,item.bytes);
  }
  return{manifestBytes:manifest.bytes,framesBytes:frames.bytes,pixels};
}

/** Exposed protocol constructor supports lifecycle tests but cannot mint a
 * native proof: verification requires the private original owned-capture seals.
 * Evidence failures preserve the one original public navigation/action. */
export function createNavigationWindowServerTransaction(context){
  const {navigationNonce,nativeId,binding,selected,signal}=context;
  let used=false,gotoCompleted=false,shellUsed=false,shellFinished=false,canvasUsed=false,closed=false,anchor=null,finished;
  const readiness={shell:null,canvas:null},missing=context.missing,failures=context.failures;
  const active=new Set();
  function track(promise){active.add(promise);promise.then(()=>active.delete(promise),()=>active.delete(promise));return promise;}
  function unavailable(reason,error){missing.push(reason);if(error)failures.push(info(error));}
  async function stop(stage){
    if(context.stopped[stage])return context.stopped[stage];
    const handle=context.handles[stage];if(!handle)return null;
    try{const value=await handle.stop();context.stopped[stage]=value;context.captures[stage]??={ready:copy(handle.ready),baseline:null,process:null,evidence:null};
      context.captures[stage].process=copy(value.process);context.captures[stage].evidence={manifest:copy(value.manifest)};return value;
    }catch(error){context.captures[stage]??={ready:copy(handle.ready),baseline:null,process:null,evidence:null};context.captures[stage].process=error?.windowServerProcess??null;unavailable('native-navigation-'+stage+'-closure-unavailable',error);return null;}
  }
  async function ready(endpoint,witness){
    demand(!closed&&gotoCompleted&&(endpoint==='shell'?!shellUsed:shellFinished&&!canvasUsed),'readiness hook order differs');
    if(endpoint==='shell')shellUsed=true;else canvasUsed=true;
    const observed={kind:'navigation-native-readiness-1',endpoint,status:'unavailable',witness:copy(witness),requestRunnerMs:monotonic(),receivedRunnerMs:null,ack:null};
    readiness[endpoint]=observed;
    try{
      signal?.throwIfAborted();validateNavigationWitness(endpoint,witness,{navigationNonce,runtime:binding.browser,attempt:binding.attempt,oracle:context.oracleInputs[endpoint].oracle});
      if(endpoint==='canvas')same(witness.navigation,readiness.shell?.witness.navigation,'readiness witnesses refer to different navigation realms');
      demand(observed.requestRunnerMs>=witness.readyMs&&witness.readyMs>=anchor.completedRunnerMs,'readiness caller clock reversed');
      const config={...selected.configs[endpoint],roi:context.oracleInputs[endpoint].oracle.roi};
      const capture=await startNavigationWindowServerCapture({build:{...selected.selection.build,sourceSha256:binding.collectorSource.sha256},config,
        directory:join(context.output,'native-nav-'+navigationNonce+'-'+endpoint),processRecordDirectory:context.output,abortSignal:signal,readyTimeoutMs:15000,clockTimeoutMs:3000,stopTimeoutMs:7000,
        navigationBinding:{invocation:copy(binding.invocation),navigationNonce,stage:endpoint}});
      context.handles[endpoint]=capture;context.captures[endpoint]={ready:copy(capture.ready),baseline:null,process:null,evidence:null};
      same(capture.ready.display,context.oracleInputs[endpoint].oracle.display,'endpoint display differs from oracle');
      const id=nativeId+(endpoint==='shell'?'-s-ready':'-c-ready'),ack=await capture.captureClock(id);
      demand(nativeClock(ack,id)&&anchor?.before&&BigInt(ack.mach)>=BigInt(anchor.before.mach),'readiness native ACK differs');
      observed.ack=copy(ack);observed.receivedRunnerMs=monotonic();observed.status='complete';
      await capture.waitForPixelHash(context.oracleInputs[endpoint].oracle.after.sha256,{timeoutMs:Math.min(config.durationMs,7000)});
    }catch(error){context.captures[endpoint]??={ready:null,baseline:null,process:error?.windowServerProcess??null,evidence:null};unavailable('native-navigation-'+endpoint+'-ready-unavailable',error);}
    finally{await stop(endpoint);if(endpoint==='shell')shellFinished=true;}
    signal?.throwIfAborted();return copy(observed);
  }
  return Object.freeze({navigationNonce,
    navigationStart({run}){
      demand(!used&&!closed&&typeof run==='function','original navigation hook is single-use');used=true;signal?.throwIfAborted();
      return track((async()=>{
      anchor={kind:'navigation-native-bracket-1',status:'unavailable',before:null,after:null,dispatchCompleted:false,startedRunnerMs:monotonic(),completedRunnerMs:null};
      try{
        const capture=await startNavigationWindowServerCapture({build:{...selected.selection.build,sourceSha256:binding.collectorSource.sha256},config:selected.configs.anchor,
          directory:join(context.output,'native-nav-'+navigationNonce+'-anchor'),processRecordDirectory:context.output,abortSignal:signal,readyTimeoutMs:15000,clockTimeoutMs:3000,stopTimeoutMs:7000,
          navigationBinding:{invocation:copy(binding.invocation),navigationNonce,stage:'anchor'}});
        context.handles.anchor=capture;context.captures.anchor={ready:copy(capture.ready),baseline:null,process:null,evidence:null};
        same(capture.ready.display,context.oracleInputs.shell.oracle.display,'anchor display differs from oracle');
        context.captures.anchor.baseline=copy(await capture.waitForPixelHash(context.oracleInputs.shell.oracle.before.sha256,{timeoutMs:3000}));
        const ack=await capture.captureClock(nativeId+'-before');demand(nativeClock(ack,nativeId+'-before'),'navigation lower ACK differs');anchor.before=copy(ack);
      }catch(error){context.captures.anchor??={ready:null,baseline:null,process:error?.windowServerProcess??null,evidence:null};unavailable('native-navigation-lower-anchor-unavailable',error);}
      // A full viewport stream cannot span an arbitrary navigation within its
      // byte cap. Close the real lower-anchor capture now. This overhead remains
      // inside the conservative bound, and the original goto still runs once.
      await stop('anchor');signal?.throwIfAborted();
      let value;
      try{value=await run();gotoCompleted=true;anchor.dispatchCompleted=true;anchor.completedRunnerMs=monotonic();}
      catch(error){anchor.completedRunnerMs=monotonic();await stop('anchor');throw error;}
      if(anchor.before&&context.stopped.anchor)anchor.status='complete';else unavailable('native-navigation-owned-anchor-closure-unavailable');
      signal?.throwIfAborted();return value;
      })());
    },
    shellReady:witness=>track(ready('shell',witness)),canvasReady:witness=>track(ready('canvas',witness)),
    finish({result,actionCompleted}={}){
      if(finished)return finished;closed=true;
      finished=(async()=>{
        // A close racing an admitted hook must join that hook before closing
        // native handles; otherwise a late supervisor start could escape stop.
        await Promise.allSettled([...active]);
        for(const stage of ['anchor','shell','canvas'])await stop(stage);
        const raw=result?.observations??result,joins={shell:null,canvas:null};
        const complete=actionCompleted===true&&gotoCompleted&&shellUsed&&canvasUsed&&raw?.documentId===binding.attempt.documentId&&raw.acceptedTestEdit===true&&raw.publicOpenCompleted===true&&raw.startupBoundary==='document-ready-via-Open'&&isDeepStrictEqual(raw.nativeReadiness,{shell:readiness.shell?.witness,canvas:readiness.canvas?.witness});
        if(!complete)unavailable('native-navigation-original-public-action-incomplete');
        if(complete&&['anchor','shell','canvas'].every(stage=>context.stopped[stage])){
          try{
            const baseline=await originalCapture(context.stopped.anchor,signal);let total=json(baseline.manifestBytes).counts.pixelBytes;
            for(const endpoint of ['shell','canvas']){
              const target=await originalCapture(context.stopped[endpoint],signal);total+=json(target.manifestBytes).counts.pixelBytes;
              demand(total<=binding.capturePlan.reservedPixelBytes,'retained capture pixels exceed total reservation');
              joins[endpoint]=joinNavigationWindowServerPixels({anchor:baseline,target},{endpoint,...context.oracleInputs[endpoint],anchor,readiness:readiness[endpoint],binding});
              if(joins[endpoint].status!=='observed')unavailable('native-navigation-'+endpoint+'-'+joins[endpoint].reason);
            }
          }catch(error){unavailable('native-navigation-original-byte-replay-unavailable',error);}
        }else unavailable('native-navigation-capture-closure-incomplete');
        const observation={kind:'navigation-windowserver-observation-1',qualification:false,navigationNonce,nativeId,binding:copy(binding),anchor:copy(anchor),readiness:copy(readiness),captures:copy(context.captures),joins,
          semanticWitness:copy(raw?.navigationSemantic??null),missing:[...new Set(missing)],failures:copy(failures)};
        const currentOutput=await outputIdentity(context.output);demand(currentOutput.dev===context.outputIdentity?.dev&&currentOutput.ino===context.outputIdentity?.ino,'output directory replaced before observation retention');
        const artifact=await exclusiveJSON(join(context.output,'navigation-nav-'+navigationNonce+'.json'),observation);observation.artifact=artifact;
        let proof=null;
        if(!observation.missing.length&&!observation.failures.length){
          try{proof=await verifyLiveNavigationWindowServerEvidence({observation,captures:context.stopped,cell:context.cell,sample:context.sample,serial:context.serial,fixture:context.fixture,
            invocation:context.invocation,runtime:context.runtime,configuration:context.configuration,result,actionCompleted,output:context.output});}
          catch{/* Retained upper bounds remain diagnostics; an unminted proof never qualifies. */}
        }
        return{observation,proof};
      })();return finished;
    },
  });
}
