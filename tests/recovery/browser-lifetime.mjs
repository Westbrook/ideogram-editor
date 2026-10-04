// Own public Playwright handles as soon as acquisition returns. Never infer a
// browser/process lifetime has ended from an absent persistent-context handle.
function ownBrowser(owner,browser,persistent){
 if(!browser)throw Error('Persistent context has no public browser lifetime handle');
 owner.resources.browser=browser;
 const evidence={persistent,connectedAtAcquisition:browser.isConnected(),contextCloseObserved:false,browserDisconnectedObserved:false,closureEvidence:'Public context close event and Browser disconnected event with isConnected false; no OS PID claim'};
 let disconnected;const ended=new Promise(resolve=>disconnected=resolve);
 owner.resources.browserLifetime={evidence,ended};
 browser.once('disconnected',()=>{evidence.browserDisconnectedObserved=true;evidence.browserDisconnectedAt=Date.now();disconnected();});
 if(!evidence.connectedAtAcquisition)throw Error('Browser lifetime already disconnected at acquisition');
}
function ownContext(owner,context){
 owner.resources.context=context;
 const evidence=owner.resources.browserLifetime?.evidence;
 context.once('close',()=>{if(evidence){evidence.contextCloseObserved=true;evidence.contextClosedAt=Date.now();}});
}
export async function acquireBrowserContext(owner,type,profile,options,launchOptions){
 if(launchOptions!==undefined&&(profile!==undefined||type.name()!=='firefox'||!launchOptions||Object.getPrototypeOf(launchOptions)!==Object.prototype||Reflect.ownKeys(launchOptions).length!==1||!Object.hasOwn(launchOptions,'env')||!Object.hasOwn(Object.getOwnPropertyDescriptor(launchOptions,'env'),'value')||!owner.resources.profilerIPC||typeof owner.resources.profilerIPC.ownsLaunchEnvironment!=='function'||owner.resources.profilerIPC.ownsLaunchEnvironment(launchOptions.env)!==true))throw Error('E4_PROFILER_LAUNCH_OPTIONS');
 if(profile!==undefined)return owner.acquire('context',async()=>{
  const context=await type.launchPersistentContext(profile,options);
  owner.resources.context=context;
  ownBrowser(owner,context.browser(),true);ownContext(owner,context);return context;
 });
 await owner.acquire('browser',async()=>{const browser=await (launchOptions===undefined?type.launch():type.launch(launchOptions));ownBrowser(owner,browser,false);return browser;});
 return owner.acquire('context',async()=>{const context=await owner.resources.browser.newContext(options);ownContext(owner,context);return context;});
}
export function registerBrowserClosure(owner,limitMs=15000){
 owner.add('context-close',limitMs,()=>Boolean(owner.resources.context),async scope=>{
  await scope(()=>owner.resources.context.close());
  if(!owner.resources.browserLifetime?.evidence.contextCloseObserved)throw Error('Public context close event unavailable');
  owner.state.contextClosed=true;
 },100);
 owner.add('browser-close',limitMs,()=>Boolean(owner.resources.browser&&owner.resources.browserLifetime||owner.resources.profilerIPC),async scope=>{
  const browser=owner.resources.browser,life=owner.resources.browserLifetime,profiler=owner.resources.profilerIPC;
  const closeBrowser=async()=>{
   if(!browser||!life)throw Error('Browser lifetime unavailable');
   if(browser.isConnected())await scope(()=>browser.close());
   await scope(()=>life.ended);
   if(!life.evidence.browserDisconnectedObserved||browser.isConnected())throw Error('Browser lifetime closure not verified');
   owner.state.browserClosed=true;
  };
  if(!profiler){await closeBrowser();return;}
  try{
   if(!browser||!life){await profiler.cancel({remainingMs:scope.remainingMs});throw Error('Browser lifetime unavailable');}
   await profiler.finish({context:owner.resources.profilerBinding?.context??null,closeBrowser,remainingMs:scope.remainingMs,excludedRoots:[owner.state.receipt,...(owner.state.roots??[]),owner.resources.profile,owner.resources.privateDir].filter(value=>value!==undefined)});
  }finally{
   // Do not replace an original close error with diagnostic serialization errors.
   try{owner.resources.profilerSummary=profiler.snapshot();}catch{owner.resources.profilerSummary={diagnosticOnly:true,qualification:false,status:'unknown',code:'SNAPSHOT_UNAVAILABLE'};}
  }
 },100);
}

// The parser receives absolute clocks privately. Persist only fixed binder
// outcomes/relative numbers, and observe the helper even after skipped teardown.
const bindingReasons=new Set(['INPUT_UNAVAILABLE','AUTHORITY_UNAVAILABLE','CANDIDATE_UNAVAILABLE','REALM_UNAVAILABLE','ORIGINAL_READ_UNAVAILABLE','SEMANTIC_ANCHOR_UNAVAILABLE','CLOCK_MISMATCH']);
function safeBinding(binding){
 const unavailable=()=>({status:'unknown',reason:'BINDING_UNAVAILABLE'});
 if(!binding||Object.getPrototypeOf(binding)!==Object.prototype)return unavailable();
 const read=key=>{const descriptor=Object.getOwnPropertyDescriptor(binding,key);return descriptor&&Object.hasOwn(descriptor,'value')?descriptor.value:undefined;};
 // Read own data properties once. Accessors cannot change a validated enum or
 // number into a private value between the check and retained serialization.
 const status=read('status'),reason=read('reason');
 if(status==='unknown'&&bindingReasons.has(reason))return {status:'unknown',reason};
 const fields=['collection','candidateOperation','queueOperation','deliveryIntervalMs','clockToleranceMs','wallClockUnitMs','f5ClockResidualMs','f6ClockResidualMs'];
 const values=Object.fromEntries(fields.map(key=>[key,read(key)]));
 if(status!=='bound'||reason!=='SAME_RUN_ORIGINAL_READ'||read('clockUncertaintyMs')!==null||fields.some(key=>typeof values[key]!=='number'||!Number.isFinite(values[key]))||['collection','candidateOperation','queueOperation'].some(key=>!Number.isSafeInteger(values[key])||values[key]<1)||values.candidateOperation!==values.queueOperation+1||values.deliveryIntervalMs<0||values.clockToleranceMs!==5||values.wallClockUnitMs!==1||Math.abs(values.f5ClockResidualMs)>5||Math.abs(values.f6ClockResidualMs)>5)return unavailable();
 return {status:'bound',reason:'SAME_RUN_ORIGINAL_READ',clockUncertaintyMs:null,...values};
}
export function profilerDiagnosticObservation(owner){
 let result;try{result=owner.resources.profilerIPC?.snapshot();}catch{}
 if(!result)result={diagnosticOnly:true,qualification:false,status:'unknown',code:'SNAPSHOT_UNAVAILABLE'};
 let binding;try{binding=safeBinding(owner.resources.profilerBinding);}catch{binding={status:'unknown',reason:'BINDING_UNAVAILABLE'};}
 const value={diagnosticOnly:true,qualification:false,binding,result};
 // Parent snapshot and binder are already bounded fixed-schema projections;
 // this final check also accounts for the wrapper before existing retention.
 try{if(Buffer.byteLength(JSON.stringify(value),'utf8')<=262144)return value;}catch{}
 return {diagnosticOnly:true,qualification:false,binding:{status:'unknown',reason:'OUTPUT_LIMIT'},result:{diagnosticOnly:true,qualification:false,status:'unknown',code:'OUTPUT_LIMIT'}};
}
