import test from 'node:test';import assert from 'node:assert/strict';import {FixtureOwner,ownedFixture} from './fixture-owner.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(){const state={failures:[]},owner=new FixtureOwner(state),events=[];owner.add('native',100,()=>!!owner.resources.guard,async()=>events.push('native'));owner.add('context',100,()=>!!owner.resources.context,async()=>{events.push('context');await owner.resources.context.close();});owner.add('browser',100,()=>!!owner.resources.browser,async()=>{events.push('browser');await owner.resources.browser.close();});return {state,owner,events};}
const resource=()=>({closed:0,async close(){this.closed++;}});
for(const failed of ['context','initial-page','guard'])test('actual fixture owner retains acquired resources on '+failed+' setup failure',async()=>{const f=fixture(),browser=resource(),context=resource();let body=false;await assert.rejects(ownedFixture(f.owner,async()=>{await f.owner.acquire('browser',async()=>browser);if(failed==='context')throw Error(failed);await f.owner.acquire('context',async()=>context);if(failed==='initial-page')await f.owner.active(async()=>{throw Error(failed);});await f.owner.active(async()=>{throw Error('guard');});},async()=>{body=true;}));assert.equal(body,false);assert.equal(browser.closed,1);assert.equal(context.closed,failed==='context'?0:1);assert.equal(f.state.failures.filter(x=>x.phase==='fixture-setup').length,1);assert.equal(f.state.timingCleanup.find(x=>x.phase==='native').unavailable,true);assert.equal(f.state.timingCleanup.find(x=>x.phase==='native').passed,undefined);await f.owner.teardown();assert.equal(browser.closed,1);});
test('runner timeout hands off to fixture owner and late body resolution cannot resume functional actions',async()=>{const f=fixture(),held=deferred(),entered=deferred(),browser=resource(),context=resource();let functional=0,body;await assert.rejects(ownedFixture(f.owner,async()=>{await f.owner.acquire('browser',async()=>browser);await f.owner.acquire('context',async()=>context);},async()=>{body=f.owner.body(async()=>{entered.resolve();await f.owner.active(()=>held.promise);await f.owner.active(async()=>functional++);});await entered.promise;await Promise.race([body,new Promise((_,reject)=>setTimeout(()=>reject(Error('runner body budget')),5))]);}),/runner body budget/);assert.equal(browser.closed,1);assert.equal(context.closed,1);assert.equal(f.owner.pending.size,1);const again=f.owner.teardown();assert.equal(again,f.owner.teardown());held.resolve();await assert.rejects(body,/WORK_EXPIRED/);await again;assert.equal(functional,0);assert.equal(f.state.failures.at(-1).phase,'late-body');assert.equal(f.events.filter(x=>x==='browser').length,1);});
test('late assertion failure is retained separately after runner timeout',async()=>{const f=fixture(),held=deferred();let body;await assert.rejects(ownedFixture(f.owner,async()=>{await f.owner.acquire('browser',async()=>resource());},async()=>{body=f.owner.body(async()=>{await f.owner.active(()=>held.promise);});await Promise.race([body,new Promise((_,reject)=>setTimeout(()=>reject(Error('runner timeout')),5))]);}));held.reject(Error('late original assertion'));await assert.rejects(body,/late original assertion/);assert.equal(f.state.failures.at(-1).phase,'late-body');assert.match(String(f.state.failures.at(-1).error),/late original assertion/);});
test('cleanup rejection and expiry preserve later closure without resuming expired phase',async()=>{const f=fixture(),held=deferred();let resumed=0;f.owner.steps=[];f.owner.add('native',5,()=>true,async scope=>{await scope(()=>held.promise);resumed++;});f.owner.add('writer',100,()=>true,async()=>{throw Error('writer close rejected');});f.owner.add('browser',100,()=>true,async()=>{f.events.push('browser');});await ownedFixture(f.owner,async()=>{},async()=>{});assert.deepEqual(f.state.failures.map(x=>x.phase),['native','writer']);assert.deepEqual(f.events,['browser']);held.resolve();await new Promise(r=>setTimeout(r,0));assert.equal(resumed,0);await f.owner.teardown();assert.deepEqual(f.events,['browser']);});
test('global teardown budget labels unstarted phase and still retains final receipt',async()=>{const f=fixture(),held=deferred();f.owner.steps=[];f.owner.teardownBudgetMs=0;f.owner.add('native',100,()=>true,()=>held.promise);f.owner.add('archive',100,()=>true,async()=>{throw Error('must not run');});let receipt=false;f.owner.add('final-receipt',1000,()=>true,async()=>{receipt=true;});await ownedFixture(f.owner,async()=>{},async()=>{});assert.equal(receipt,true);assert.equal(f.state.timingCleanup.find(x=>x.phase==='archive').expiredBeforeStart,true);held.resolve();});

test('predeclared unavailable phases remain explicit until body provides owned handles',async()=>{const state={failures:[]},owner=new FixtureOwner(state);owner.add('native',100,()=>false,()=>assert.fail('unavailable work'));owner.add('writer',100,()=>false,()=>assert.fail('unavailable work'));let calls=0;owner.provide('writer',100,()=>true,async()=>calls++);owner.bodyPhase='body-setup';await assert.rejects(owner.body(async()=>{throw Error('guard initialization');}));await owner.teardown();assert.equal(calls,1);assert.equal(state.failures[0].phase,'body-setup');assert.equal(state.timingCleanup.find(x=>x.phase==='native').unavailable,true);assert.equal(state.timingCleanup.find(x=>x.phase==='writer').passed,true);});

import {EventEmitter} from 'node:events';
import {acquireBrowserContext,registerBrowserClosure,profilerDiagnosticObservation} from './browser-lifetime.mjs';

// Public Playwright lifecycle doubles only: no browser launch, profiler, FIFO,
// native process, or physical timing/memory qualification is performed here.
function publicBrowserFixture({onBrowserClose=async()=>{},onContextClose=async()=>{},engine='firefox',limitMs}={}){
 const state={failures:[]},owner=new FixtureOwner(state),events=[],launches=[],persistentLaunches=[],contexts=[];
 const browser=new EventEmitter(),context=new EventEmitter();let connected=true;
 browser.isConnected=()=>connected;
 browser.close=async()=>{events.push('browser-close');await onBrowserClose();connected=false;browser.emit('disconnected');events.push('browser-disconnected');};
 browser.newContext=async options=>{contexts.push(options);return context;};
 context.browser=()=>browser;
 context.close=async()=>{events.push('context-close');await onContextClose();context.emit('close');events.push('context-closed');};
 const type={name:()=>engine,async launch(...args){launches.push(args);return browser;},async launchPersistentContext(...args){persistentLaunches.push(args);return context;}};
 registerBrowserClosure(owner,limitMs);
 return {state,owner,events,launches,persistentLaunches,contexts,browser,context,type};
}

test('public browser ownership keeps default launch argument-free and preserves existing closure budgets',async()=>{
 const f=publicBrowserFixture(),options={viewport:{width:800,height:600}};
 assert.equal(await acquireBrowserContext(f.owner,f.type,undefined,options),f.context);
 assert.deepEqual(f.launches,[[]]);assert.deepEqual(f.persistentLaunches,[]);assert.deepEqual(f.contexts,[options]);
 assert.equal(f.owner.resources.browser,f.browser);assert.equal(f.owner.resources.context,f.context);
 assert.equal(f.owner.teardownBudgetMs,130000);assert.deepEqual(f.owner.steps.map(({phase,ms})=>({phase,ms})),[{phase:'context-close',ms:15000},{phase:'browser-close',ms:15000}]);
 const closed=f.owner.teardown();assert.equal(f.owner.teardown(),closed);await closed;
 assert.deepEqual(f.events,['context-close','context-closed','browser-close','browser-disconnected']);assert.deepEqual(f.state.failures,[]);
 assert.equal(f.state.contextClosed,true);assert.equal(f.state.browserClosed,true);assert.equal(f.browser.isConnected(),false);
 await f.owner.teardown();assert.equal(f.events.filter(event=>event==='browser-close').length,1);
});

test('public persistent context ownership retains its original launch and browser closure path',async()=>{
 const f=publicBrowserFixture(),options={locale:'en-US'},profile='/fixture/profile';
 assert.equal(await acquireBrowserContext(f.owner,f.type,profile,options),f.context);
 assert.deepEqual(f.launches,[]);assert.deepEqual(f.persistentLaunches,[[profile,options]]);assert.deepEqual(f.contexts,[]);
 assert.equal(f.owner.resources.browserLifetime.evidence.persistent,true);await f.owner.teardown();
 assert.deepEqual(f.state.failures,[]);assert.equal(f.state.contextClosed,true);assert.equal(f.state.browserClosed,true);
});

const profilerSummary=()=>({diagnosticOnly:true,qualification:false,status:'complete',retainedRawProfile:false});

test('only explicit Firefox launch options pass the profiler environment to browser launch',async()=>{
 const f=publicBrowserFixture(),options={locale:'en-US'},issued=Object.freeze({MOZ_PROFILER_STARTUP:'1',MOZ_PROFILER_STARTUP_FEATURES:'nostacksampling'}),launchOptions={env:issued};
 f.owner.resources.profilerIPC={ownsLaunchEnvironment:env=>env===issued,async finish({closeBrowser}){await closeBrowser();},snapshot:profilerSummary,cancel(){assert.fail('Browser was acquired');}};
 await acquireBrowserContext(f.owner,f.type,undefined,options,launchOptions);
 assert.deepEqual(f.launches,[[launchOptions]]);assert.equal(f.launches[0][0],launchOptions);assert.equal(f.contexts[0],options);assert.equal('env'in options,false);
 await f.owner.teardown();assert.deepEqual(f.state.failures,[]);
 const inheritedEnv=Object.assign(Object.create({env:issued}),{args:['--fixture-option']}),hiddenOption=Object.defineProperty({env:issued},'args',{value:['--fixture-option']}),symbolOption={env:issued,[Symbol('fixture-option')]:true};
 const accessorEnv=Object.defineProperty({},'env',{enumerable:true,get(){assert.fail('Launch validation must not evaluate an environment getter');}});
 for(const [engine,profile,value]of [['firefox','/fixture/profile',launchOptions],['chromium',undefined,launchOptions],['firefox',undefined,{}],['firefox',undefined,{env:{}}],['firefox',undefined,{env:[]}],['firefox',undefined,{env:{...issued}}],['firefox',undefined,{env:issued,extra:true}],...([inheritedEnv,hiddenOption,symbolOption,accessorEnv].map(value=>['firefox',undefined,value]))]){
  const denied=publicBrowserFixture({engine});denied.owner.resources.profilerIPC={ownsLaunchEnvironment:env=>env===issued,async cancel(){},snapshot:profilerSummary};
  await assert.rejects(acquireBrowserContext(denied.owner,denied.type,profile,options,value),/E4_PROFILER_LAUNCH_OPTIONS/);
  assert.deepEqual(denied.launches,[]);assert.deepEqual(denied.persistentLaunches,[]);assert.equal(denied.owner.resources.browser,undefined);assert.equal(denied.owner.resources.context,undefined);
  await denied.owner.teardown();
 }
 for(const helper of [undefined,{async cancel(){},snapshot:profilerSummary}]){
  const unprepared=publicBrowserFixture();unprepared.owner.resources.profilerIPC=helper;
  await assert.rejects(acquireBrowserContext(unprepared.owner,unprepared.type,undefined,options,launchOptions),/E4_PROFILER_LAUNCH_OPTIONS/);assert.deepEqual(unprepared.launches,[]);await unprepared.owner.teardown();
 }
});

test('profiler receiver begins before browser close and retains only its final safe snapshot',async()=>{
 const receiverEntered=deferred(),receiverReady=deferred(),closeEntered=deferred(),closeReady=deferred();
 const f=publicBrowserFixture({onBrowserClose:async()=>{closeEntered.resolve();await closeReady.promise;}}),binding={attempt:'controlled-public-context'},summary=profilerSummary();let finishes=0,snapshots=0;
 f.state.receipt='/fixture/receipt';f.state.roots=['/fixture/root'];f.owner.resources.profile='/fixture/profile';f.owner.resources.privateDir='/fixture/private';f.owner.resources.profilerBinding={context:binding};
 f.owner.resources.profilerIPC={async finish(options){finishes++;f.events.push('receiver-start');receiverEntered.resolve(options);await receiverReady.promise;try{await options.closeBrowser();}finally{f.events.push('receiver-cleanup');}},snapshot(){snapshots++;assert.equal(f.events.at(-1),'receiver-cleanup');return summary;},cancel(){assert.fail('Acquired browser must use finish');}};
 await acquireBrowserContext(f.owner,f.type,undefined,{});const work=f.owner.teardown(),options=await receiverEntered.promise;
 assert.equal(f.owner.teardown(),work);assert.equal(options.context,binding);assert.deepEqual(options.excludedRoots,['/fixture/receipt','/fixture/root','/fixture/profile','/fixture/private']);
 assert.equal(typeof options.remainingMs,'function');const initialRemaining=options.remainingMs();assert(initialRemaining>0&&initialRemaining<=15000,'Receiver receives the actual still-live browser-close phase budget');
 assert.equal(f.state.contextClosed,true);assert.equal(f.events.includes('browser-close'),false);assert.equal(f.owner.resources.profilerSummary,undefined);
 receiverReady.resolve();await closeEntered.promise;assert.equal(f.state.browserClosed,undefined);assert.equal(f.owner.resources.profilerSummary,undefined);
 closeReady.resolve();await work;assert.equal(finishes,1);assert.equal(snapshots,1);assert.equal(f.owner.resources.profilerSummary,summary);assert.equal(f.state.browserClosed,true);assert.deepEqual(f.state.failures,[]);
 assert.equal(options.remainingMs(),0,'The same receiver budget capability expires with the phase');
 assert.deepEqual(f.events,['context-close','context-closed','receiver-start','browser-close','browser-disconnected','receiver-cleanup']);
 await f.owner.teardown();assert.equal(finishes,1);assert.equal(f.events.filter(event=>event==='browser-close').length,1);
});

for(const snapshotThrows of [false,true])test('profiler teardown preserves original browser-close error with snapshot failure '+snapshotThrows,async()=>{
 const closeError=Error('original browser close error'),snapshotError=Error('diagnostic snapshot error'),f=publicBrowserFixture({onBrowserClose:async()=>{throw closeError;}}),summary=profilerSummary();let finishes=0,cleanups=0,snapshots=0;
 f.owner.resources.profilerIPC={async finish({context,closeBrowser}){finishes++;assert.equal(context,null);try{await closeBrowser();}finally{cleanups++;}},snapshot(){snapshots++;assert.equal(cleanups,1);if(snapshotThrows)throw snapshotError;return summary;},cancel(){assert.fail('Browser was acquired');}};
 await acquireBrowserContext(f.owner,f.type,undefined,{});await f.owner.teardown();
 assert.equal(finishes,1);assert.equal(cleanups,1);assert.equal(snapshots,1);assert.equal(f.state.failures.length,1);assert.equal(f.state.failures[0].phase,'browser-close');assert.equal(f.state.failures[0].error,closeError);
 assert.equal(f.state.browserClosed,undefined);assert.equal(f.state.contextClosed,true);assert.equal(f.browser.isConnected(),true);
 assert.deepEqual(f.owner.resources.profilerSummary,snapshotThrows?{diagnosticOnly:true,qualification:false,status:'unknown',code:'SNAPSHOT_UNAVAILABLE'}:summary);
 await f.owner.teardown();assert.equal(finishes,1);assert.equal(f.events.filter(event=>event==='browser-close').length,1);
});

test('already disconnected public browser still finalizes the profiler without a second close',async()=>{
 const f=publicBrowserFixture(),summary=profilerSummary();let finishes=0;
 f.owner.resources.profilerIPC={async finish({closeBrowser}){finishes++;assert.equal(f.browser.isConnected(),false);await closeBrowser();},snapshot:()=>summary,cancel(){assert.fail('Browser lifetime was acquired');}};
 await acquireBrowserContext(f.owner,f.type,undefined,{});await f.browser.close();await f.owner.teardown();
 assert.equal(finishes,1);assert.equal(f.events.filter(event=>event==='browser-close').length,1);assert.equal(f.state.browserClosed,true);assert.equal(f.owner.resources.profilerSummary,summary);assert.deepEqual(f.state.failures,[]);
});

test('context-close failure does not prevent profiler and browser cleanup',async()=>{
 const contextError=Error('original context close error'),f=publicBrowserFixture({onContextClose:async()=>{throw contextError;}}),summary=profilerSummary();let finishes=0;
 f.owner.resources.profilerIPC={async finish({closeBrowser}){finishes++;await closeBrowser();},snapshot:()=>summary,cancel(){assert.fail('Browser was acquired');}};
 await acquireBrowserContext(f.owner,f.type,undefined,{});await f.owner.teardown();
 assert.equal(finishes,1);assert.equal(f.state.browserClosed,true);assert.equal(f.state.contextClosed,undefined);assert.equal(f.state.failures.length,1);assert.equal(f.state.failures[0].phase,'context-close');assert.equal(f.state.failures[0].error,contextError);assert.equal(f.owner.resources.profilerSummary,summary);
});

test('failed browser acquisition waits for profiler cancellation and retains both original setup and closure failure',async()=>{
 const cancelEntered=deferred(),cancelReady=deferred(),setupError=Error('original launch error'),f=publicBrowserFixture(),summary=profilerSummary();let cancellations=0,snapshots=0,cancelRemainingMs;
 f.type.launch=async()=>{throw setupError;};
 f.owner.resources.profilerIPC={async cancel({remainingMs}){cancellations++;cancelRemainingMs=remainingMs;cancelEntered.resolve();await cancelReady.promise;},finish(){assert.fail('No acquired browser can finish');},snapshot(){snapshots++;return summary;}};
 const work=ownedFixture(f.owner,()=>acquireBrowserContext(f.owner,f.type,undefined,{}),()=>assert.fail('Setup failed'));work.catch(()=>{});
 await cancelEntered.promise;assert.equal(cancellations,1);assert.equal(snapshots,0);assert.equal(f.events.includes('browser-close'),false);assert.equal(f.state.failures.find(row=>row.phase==='fixture-setup').error,setupError);
 assert.equal(typeof cancelRemainingMs,'function');const cancellationBudget=cancelRemainingMs();assert(cancellationBudget>0&&cancellationBudget<=15000,'Acquisition-failure cancellation uses the existing browser-close phase budget');
 cancelReady.resolve();await assert.rejects(work,error=>error===setupError);
 const failure=f.state.failures.find(row=>row.phase==='browser-close');assert(failure);assert.match(failure.error.message,/Browser lifetime unavailable/);assert.equal(f.state.browserClosed,undefined);
 assert.equal(f.state.timingCleanup.find(row=>row.phase==='browser-close').unavailable,undefined);assert.equal(f.state.timingCleanup.find(row=>row.phase==='browser-close').passed,undefined);
 assert.equal(snapshots,1);assert.equal(f.owner.resources.profilerSummary,summary);assert.equal(cancelRemainingMs(),0);await f.owner.teardown();assert.equal(cancellations,1);
});

test('expired profiler phase cannot resume browser close or retry after receiver readiness arrives',async()=>{
 const receiverEntered=deferred(),receiverReady=deferred(),lateCleanup=deferred(),snapshotTaken=deferred(),f=publicBrowserFixture({limitMs:5}),summary=profilerSummary();let finishes=0,lateError,remainingMs;
 f.owner.resources.profilerIPC={async finish({closeBrowser,remainingMs:readRemaining}){finishes++;remainingMs=readRemaining;receiverEntered.resolve();await receiverReady.promise;try{await closeBrowser();}catch(error){lateError=error;throw error;}finally{lateCleanup.resolve();}},snapshot(){snapshotTaken.resolve();return summary;},cancel(){assert.fail('Browser was acquired');}};
 await acquireBrowserContext(f.owner,f.type,undefined,{});const work=f.owner.teardown();await receiverEntered.promise;await work;
 const failure=f.state.failures.find(row=>row.phase==='browser-close');assert(failure);assert.match(failure.error.message,/browser-close deadline/);assert.equal(f.state.browserClosed,undefined);assert.equal(f.events.includes('browser-close'),false);
 assert.equal(typeof remainingMs,'function');assert.equal(remainingMs(),0,'A timed-out phase has no remaining receiver budget');
 receiverReady.resolve();await lateCleanup.promise;await snapshotTaken.promise;assert.match(lateError.message,/CLEANUP_PHASE_EXPIRED/);
 assert.equal(f.browser.isConnected(),true);assert.equal(f.events.includes('browser-close'),false);assert.equal(f.state.browserClosed,undefined);assert.equal(f.state.failures.filter(row=>row.phase==='browser-close').length,1);
 await f.owner.teardown();assert.equal(finishes,1);assert.equal(f.owner.resources.profilerSummary,summary);
});

test('profiler finalization failure remains a teardown failure after verified public browser closure',async()=>{
 const profilerError=Error('original receiver finalization error'),f=publicBrowserFixture(),summary={...profilerSummary(),status:'unknown'};let cleanups=0;
 f.owner.resources.profilerIPC={async finish({closeBrowser}){try{await closeBrowser();throw profilerError;}finally{cleanups++;}},snapshot(){assert.equal(cleanups,1);return summary;},cancel(){assert.fail('Browser was acquired');}};
 await acquireBrowserContext(f.owner,f.type,undefined,{});await f.owner.teardown();
 assert.equal(f.state.browserClosed,true);assert.equal(f.browser.isConnected(),false);assert.equal(f.state.failures.length,1);assert.equal(f.state.failures[0].error,profilerError);assert.equal(f.state.failures[0].phase,'browser-close');assert.equal(f.state.timingCleanup.find(row=>row.phase==='browser-close').passed,undefined);assert.equal(f.owner.resources.profilerSummary,summary);
 await f.owner.teardown();assert.equal(cleanups,1);assert.equal(f.events.filter(event=>event==='browser-close').length,1);
});

test('live profiler diagnostics survive skipped closure without serializing private absolute clock bindings',async()=>{
 const f=publicBrowserFixture(),privateContext={pageUrl:'https://private.invalid/capture',timeOriginUnixMs:1791123456789,absoluteStartMs:1791123456790};
 const publicBinding={status:'bound',reason:'SAME_RUN_ORIGINAL_READ',collection:2,candidateOperation:31,queueOperation:30,deliveryIntervalMs:294,clockToleranceMs:5,wallClockUnitMs:1,clockUncertaintyMs:null,f5ClockResidualMs:0,f6ClockResidualMs:1};
 f.owner.resources.profilerBinding={...publicBinding,context:privateContext,absoluteClockProbe:privateContext.timeOriginUnixMs};f.owner.resources.profilerSummary={stale:true};
 let current={diagnosticOnly:true,qualification:false,status:'receiving'},snapshots=0,finishes=0;
 f.owner.resources.profilerIPC={async finish(){finishes++;assert.fail('Global teardown budget is exhausted');},async cancel(){assert.fail('Global teardown budget is exhausted');},snapshot(){snapshots++;return current;}};
 await acquireBrowserContext(f.owner,f.type,undefined,{});f.owner.teardownBudgetMs=0;await f.owner.teardown();
 assert.equal(f.state.timingCleanup.find(row=>row.phase==='browser-close').expiredBeforeStart,true);assert.equal(finishes,0);assert.equal(f.state.browserClosed,undefined);assert.equal(snapshots,0);
 const first=profilerDiagnosticObservation(f.owner);assert.deepEqual(first,{diagnosticOnly:true,qualification:false,binding:publicBinding,result:current});assert.equal(snapshots,1);
 const serialized=JSON.stringify(first);for(const privateValue of ['pageUrl','private.invalid','timeOriginUnixMs','absoluteStartMs','absoluteClockProbe','1791123456789','1791123456790'])assert.equal(serialized.includes(privateValue),false);
 current={diagnosticOnly:true,qualification:false,status:'unknown',code:'RECEIVER_CLOSED'};
 assert.deepEqual(profilerDiagnosticObservation(f.owner).result,current);assert.equal(snapshots,2);assert.deepEqual(f.owner.resources.profilerSummary,{stale:true},'Live observation must not rely on an earlier close-finally snapshot');
 assert.equal(finishes,0);assert.equal(f.events.includes('browser-close'),false);
});

for(const [name,helper]of [['missing helper',undefined],['missing snapshot',{}],['throwing snapshot',{snapshot(){throw Error('private receiver path /secret/profile');}}],['empty snapshot',{snapshot(){return undefined;}}]])test('profiler diagnostic '+name+' returns fixed unknown evidence',()=>{
 const owner=new FixtureOwner({failures:[]});if(helper)owner.resources.profilerIPC=helper;
 assert.deepEqual(profilerDiagnosticObservation(owner),{diagnosticOnly:true,qualification:false,binding:{status:'unknown',reason:'BINDING_UNAVAILABLE'},result:{diagnosticOnly:true,qualification:false,status:'unknown',code:'SNAPSHOT_UNAVAILABLE'}});
});

test('profiler diagnostic wrapper accepts its exact byte limit and refuses one extra byte without truncation',()=>{
 const limit=262144,owner=new FixtureOwner({failures:[]}),summary={diagnosticOnly:true,qualification:false,status:'complete',numericCounts:[]};
 const expected={diagnosticOnly:true,qualification:false,binding:{status:'unknown',reason:'BINDING_UNAVAILABLE'},result:summary};
 const bytes=value=>Buffer.byteLength(JSON.stringify(value),'utf8'),emptyBytes=bytes(expected);
 // Safe numeric fixture data isolates the final wrapper budget. The synthetic
 // array is not profiler evidence and does not establish parser/runtime limits.
 summary.numericCounts=Array(Math.floor((limit-emptyBytes+1)/2)).fill(0);
 if(bytes(expected)===limit-1)summary.numericCounts[0]=10;
 assert.equal(bytes(expected),limit);assert(bytes(summary)<limit,'Parent snapshot alone fits while the wrapper consumes the remaining allowance');
 owner.resources.profilerIPC={snapshot:()=>summary};
 const accepted=profilerDiagnosticObservation(owner);assert.deepEqual(accepted,expected);assert.equal(bytes(accepted),limit);assert.equal(accepted.result.numericCounts.length,summary.numericCounts.length);
 assert.equal(summary.numericCounts.at(-1),0);summary.numericCounts[summary.numericCounts.length-1]=10;
 assert.equal(bytes(expected),limit+1);assert(bytes(summary)<limit,'Overflow is introduced by the wrapper, not an oversized parent snapshot');
 assert.deepEqual(profilerDiagnosticObservation(owner),{diagnosticOnly:true,qualification:false,binding:{status:'unknown',reason:'OUTPUT_LIMIT'},result:{diagnosticOnly:true,qualification:false,status:'unknown',code:'OUTPUT_LIMIT'}});
 assert.equal(summary.numericCounts.at(-1),10,'Refusal does not truncate or mutate diagnostic inputs');
});

test('profiler diagnostic serialization failure returns fixed output-limit evidence',()=>{
 const owner=new FixtureOwner({failures:[]}),circular={diagnosticOnly:true,qualification:false,status:'unknown'};circular.cycle=circular;
 owner.resources.profilerIPC={snapshot:()=>circular};
 assert.deepEqual(profilerDiagnosticObservation(owner),{diagnosticOnly:true,qualification:false,binding:{status:'unknown',reason:'OUTPUT_LIMIT'},result:{diagnosticOnly:true,qualification:false,status:'unknown',code:'OUTPUT_LIMIT'}});
});

test('fixture phase remaining budget uses its monotonic global deadline and cannot be replaced',async t=>{
 let now=1000;const clock=t.mock.method(performance,'now',()=>now),state={failures:[]},owner=new FixtureOwner(state),readers=[];let closes=0;
 owner.teardownBudgetMs=90;
 owner.add('preparation',15000,()=>true,async scope=>{
  readers.push(scope.remainingMs);assert.equal(scope.remainingMs(),90);now+=60;assert.equal(scope.remainingMs(),30);
 });
 owner.add('browser-close',15000,()=>true,async scope=>{
  const descriptor=Object.getOwnPropertyDescriptor(scope,'remainingMs');assert.equal(descriptor.writable,false);assert.equal(descriptor.configurable,false);assert.equal(typeof descriptor.value,'function');
  readers.push(scope.remainingMs);assert.equal(scope.remainingMs(),30,'Earlier teardown time reduces this phase below its nominal15s');
  assert.throws(()=>{scope.remainingMs=()=>Infinity;},TypeError);assert.equal(Reflect.deleteProperty(scope,'remainingMs'),false);assert.throws(()=>Object.defineProperty(scope,'remainingMs',{value:()=>Infinity}),TypeError);
  now+=7;assert.equal(scope.remainingMs(),23);now+=3;assert.equal(scope.remainingMs(),20);
  const value=await scope(async()=>{closes++;return 'closed';});assert.equal(value,'closed');assert.equal(scope.remainingMs(),20,'Reading the budget neither adds time nor changes scoped work');
 });
 try{await owner.teardown();assert.equal(closes,1);assert.deepEqual(state.failures,[]);assert.equal(state.timingCleanup.find(row=>row.phase==='browser-close').passed,true);for(const read of readers)assert.equal(read(),0);now+=1000;for(const read of readers)assert.equal(read(),0);}
 finally{clock.mock.restore();}
});

test('profiler diagnostic rejects hostile or nonfinite binder fields without copying their values',()=>{
 const valid={status:'bound',reason:'SAME_RUN_ORIGINAL_READ',collection:2,candidateOperation:31,queueOperation:30,deliveryIntervalMs:294,clockToleranceMs:5,wallClockUnitMs:1,clockUncertaintyMs:null,f5ClockResidualMs:0,f6ClockResidualMs:1},summary=profilerSummary();
 const hostile='PRIVATE_BINDER_VALUE https://private.invalid/absolute/1791123456789';
 for(const mutation of [{candidateOperation:hostile},{deliveryIntervalMs:hostile},{reason:hostile},{status:'unknown',reason:hostile},{clockToleranceMs:Infinity},{f5ClockResidualMs:NaN}]){
  const owner=new FixtureOwner({failures:[]});owner.resources.profilerIPC={snapshot:()=>summary};owner.resources.profilerBinding={...valid,...mutation,context:{url:hostile,timeOriginUnixMs:1791123456789}};
  const observed=profilerDiagnosticObservation(owner);
  assert.deepEqual(observed,{diagnosticOnly:true,qualification:false,binding:{status:'unknown',reason:'BINDING_UNAVAILABLE'},result:summary});
  assert.equal(JSON.stringify(observed).includes('PRIVATE_BINDER_VALUE'),false);assert.equal(JSON.stringify(observed).includes('1791123456789'),false);
 }
 const owner=new FixtureOwner({failures:[]});owner.resources.profilerIPC={snapshot:()=>summary};owner.resources.profilerBinding=Object.defineProperty({...valid},'candidateOperation',{get(){throw Error(hostile);}});
 assert.deepEqual(profilerDiagnosticObservation(owner),{diagnosticOnly:true,qualification:false,binding:{status:'unknown',reason:'BINDING_UNAVAILABLE'},result:summary});
 owner.resources.profilerBinding={status:'unknown',reason:'CLOCK_MISMATCH',context:{url:hostile},candidateOperation:hostile};
 assert.deepEqual(profilerDiagnosticObservation(owner),{diagnosticOnly:true,qualification:false,binding:{status:'unknown',reason:'CLOCK_MISMATCH'},result:summary},'An allowlisted unavailable-binding reason remains useful without retaining private fields');
});

test('remaining budget accounts for elapsed global time without changing the existing phase timer',async t=>{
 let now=1000,reads=0,closed=0,reader;const delays=[],state={failures:[]},owner=new FixtureOwner(state),setTimer=globalThis.setTimeout;
 const clock=t.mock.method(performance,'now',()=>{if(++reads===3)now+=10;return now;});
 const timer=t.mock.method(globalThis,'setTimeout',(callback,delay,...args)=>{delays.push(delay);return Reflect.apply(setTimer,globalThis,[callback,delay,...args]);});
 owner.teardownBudgetMs=90;
 owner.add('browser-close',15000,()=>true,async scope=>{reader=scope.remainingMs;assert.equal(reader(),80);await scope(async()=>{closed++;});});
 try{await owner.teardown();assert.equal(reads>=3,true);assert.deepEqual(delays,[90],'Existing timer and continuation behavior remains unchanged; the helper receives the conservative80ms remainder');assert.equal(closed,1);assert.equal(reader(),0);assert.deepEqual(state.failures,[]);}
 finally{timer.mock.restore();clock.mock.restore();}
});

test('profiler binding projection rejects changing accessors without invoking them',()=>{
 const hostile='PRIVATE_CHANGING_BINDER https://private.invalid/clock/1791123456789',summary=profilerSummary();
 for(const kind of ['unknown-status','unknown-reason','bound-status','bound-reason','bound-interval','bound-ordinal']){
  const owner=new FixtureOwner({failures:[]});let reads=0;owner.resources.profilerIPC={snapshot:()=>summary};
  const unknown=kind.startsWith('unknown-'),binding=unknown?{status:'unknown',reason:'CLOCK_MISMATCH'}:{status:'bound',reason:'SAME_RUN_ORIGINAL_READ',collection:2,candidateOperation:31,queueOperation:30,deliveryIntervalMs:294,clockToleranceMs:5,wallClockUnitMs:1,clockUncertaintyMs:null,f5ClockResidualMs:0,f6ClockResidualMs:1};
  const key=kind.endsWith('-status')?'status':kind.endsWith('-reason')?'reason':kind.endsWith('-ordinal')?'candidateOperation':'deliveryIntervalMs',original=binding[key];
  Object.defineProperty(binding,key,{enumerable:true,get(){reads++;return reads===1?original:hostile;}});
  owner.resources.profilerBinding=binding;const observed=profilerDiagnosticObservation(owner),serialized=JSON.stringify(observed);
  assert.equal(serialized.includes('PRIVATE_CHANGING_BINDER'),false);assert.equal(serialized.includes('1791123456789'),false);
  assert.equal(reads,0,'Retained binder fields must be captured from own data descriptors without invoking accessors');
  assert.deepEqual(observed.binding,{status:'unknown',reason:'BINDING_UNAVAILABLE'});assert.equal(observed.result,summary);
 }
});

// Synthetic POSIX FIFO writers below model only the diagnostic transport. They
// do not launch Firefox, attest native profiler output or qualify E4 timing.
import {constants as profileFS} from 'node:fs';
import {open as profileOpen,lstat as profileLstat,mkdtemp as profileMkdtemp,realpath as profileRealpath,writeFile as profileWriteFile,unlink as profileUnlink,rmdir as profileRmdir,rm as profileRm} from 'node:fs/promises';
import {tmpdir as profileTmpdir} from 'node:os';
import {dirname as profileDirname,join as profileJoin} from 'node:path';
import {prepareFirefoxProfileDiagnostic,FIREFOX_PROFILE_IPC_LIMITS} from './firefox-profile-ipc.mjs';
const profileTurn=()=>new Promise(resolve=>setImmediate(resolve));
async function profileFixture(){
 const archive=await profileMkdtemp(profileJoin(await profileRealpath(profileTmpdir()),'profile-fifo-test-archive-'));
 const roots=[archive],handle=await prepareFirefoxProfileDiagnostic({excludedRoots:roots});
 const fifo=handle.launchEnvironment({}).MOZ_PROFILER_SHUTDOWN;
 return {archive,roots,handle,fifo,leaf:profileDirname(fifo),async cleanup(){
  await handle.cancel();
  // A test has no native browser. Its synthetic writers are explicitly closed
  // by their try/finally before this cleanup; production never makes this claim.
  try{await handle.finish({remainingMs:()=>15000,context:null,excludedRoots:roots,closeBrowser:async()=>{}});}catch{}
  const state=handle.snapshot();
  if(state.helperClosed){try{const st=await profileLstat(fifo);if(st.isFIFO())await profileUnlink(fifo);}catch(error){if(error.code!=='ENOENT')throw error;}try{await profileRmdir(profileDirname(fifo));}catch(error){if(error.code!=='ENOENT')throw error;}}
  await profileRm(archive,{recursive:true});
 }};
}
async function profileWriteAll(fd,bytes){
 let offset=0,stalls=0;
 while(offset<bytes.length){try{const {bytesWritten}=await fd.write(bytes,offset,Math.min(16384,bytes.length-offset),null);offset+=bytesWritten;stalls=0;}catch(error){if(error.code!=='EAGAIN'||++stalls>10000)throw error;await profileTurn();}}
}
async function profileWriteOnce(f,bytes){const fd=await profileOpen(f.fifo,profileFS.O_WRONLY|profileFS.O_NONBLOCK|profileFS.O_NOFOLLOW);try{await profileWriteAll(fd,bytes);}finally{await fd.close();}}

test('profiler FIFO owns private metadata and fixed env without inherited logging or profiler knobs',async()=>{
 const f=await profileFixture();try{
  const dir=await profileLstat(f.leaf),fifo=await profileLstat(f.fifo);
  assert.equal(dir.isDirectory(),true);assert.equal(dir.mode&0o777,0o700);assert.equal(fifo.isFIFO(),true);assert.equal(fifo.mode&0o777,0o600);
  const env=f.handle.launchEnvironment({KEEP:'original',MOZ_LOG:'secret',MOZ_LOG_FILE:'secret',MOZ_USE_PERFORMANCE_MARKER_FILE:'secret',MOZ_PROFILER_SYMBOLICATE:'1',MOZ_PROFILER_STARTUP_FEATURES_BITFIELD:'65535',MOZ_PROFILER_SHUTDOWN:'other',MOZ_PROFILER_UNKNOWN:'unsafe',MOZ_PROFILER_STARTUP_DURATION:'5',MOZ_PROFILER_STARTUP_ACTIVE_TAB_ID:'123'});
  assert.equal(Object.isFrozen(env),true);assert.equal(f.handle.ownsLaunchEnvironment(env),true);assert.equal(f.handle.ownsLaunchEnvironment({...env}),false);assert.equal(f.handle.ownsLaunchEnvironment(null),false);assert.equal(env.KEEP,'original');assert.equal(env.MOZ_PROFILER_STARTUP_NO_BASE,'1');assert.equal(env.MOZ_PROFILER_STARTUP_ENTRIES,'16777216');assert.equal(env.MOZ_PROFILER_STARTUP_INTERVAL,'1');assert.equal(env.MOZ_PROFILER_STARTUP_FEATURES,'js,stackwalk,nomarkerstacks');assert.equal(env.MOZ_PROFILER_STARTUP_FILTERS,'GeckoMain');assert.equal(env.MOZ_PROFILER_SHUTDOWN,f.fifo);
  for(const key of ['MOZ_LOG','MOZ_LOG_FILE','MOZ_USE_PERFORMANCE_MARKER_FILE','MOZ_PROFILER_SYMBOLICATE','MOZ_PROFILER_STARTUP_FEATURES_BITFIELD','MOZ_PROFILER_UNKNOWN','MOZ_PROFILER_STARTUP_DURATION','MOZ_PROFILER_STARTUP_ACTIVE_TAB_ID'])assert.equal(Object.hasOwn(env,key),false);
  assert.equal(f.handle.snapshot().helperClosed,false);assert.equal(f.handle.snapshot().browserClosed,false);
 }finally{await f.cleanup();}
});

test('profiler FIFO rejects an archive ancestor before returning a launch path',async()=>{
 await assert.rejects(prepareFirefoxProfileDiagnostic({excludedRoots:[await profileRealpath(profileTmpdir())]}),error=>error.code==='PROFILE_ARCHIVE_OVERLAP');
});

test('profiler FIFO drains concurrent synthetic close and keeps unsupported JSON diagnostic unavailable',async()=>{
 const f=await profileFixture();try{
  let calls=0;
  const result=await f.handle.finish({remainingMs:()=>15000,context:null,excludedRoots:f.roots,closeBrowser:async()=>{calls++;await profileWriteOnce(f,Buffer.from('{}'));}});
  assert.equal(calls,1);assert.equal(result.helperClosed,true);assert.equal(result.helperExitCode,0);assert.equal(result.browserClosed,true);assert.equal(result.ipcRemoved,true);assert.equal(result.qualification,false);assert.notEqual(result.status,'projected');
  assert.equal(JSON.stringify(result).includes(f.fifo),false);await assert.rejects(profileLstat(f.leaf),{code:'ENOENT'});
  assert.deepEqual(await f.handle.finish({remainingMs:()=>15000,context:null,excludedRoots:f.roots,closeBrowser:async()=>assert.fail('second close')}),result);
 }finally{await f.cleanup();}
});

test('profiler FIFO requires complete single JSON and actual EOF rather than accepting a partial stream',async()=>{
 const f=await profileFixture();try{
  const result=await f.handle.finish({remainingMs:()=>15000,context:null,excludedRoots:f.roots,closeBrowser:()=>profileWriteOnce(f,Buffer.from('{"private":"incomplete'))});
  assert.notEqual(result.status,'projected');assert.equal(result.summary,null);assert.equal(result.helperClosed,true);assert.equal(result.browserClosed,true);assert.equal(result.ipcRemoved,true);assert.equal(JSON.stringify(result).includes('private'),false);
 }finally{await f.cleanup();}
});

test('profiler FIFO cancellation before native open preserves path and does not claim browser closure',async()=>{
 const f=await profileFixture();try{
  const result=await f.handle.cancel();assert.equal(result.helperClosed,true);assert.equal(result.browserClosed,false);assert.equal(result.writerMayOpen,true);assert.equal(result.ipcRemoved,false);assert.equal(result.code,'PROFILE_CANCELLED');
  assert.equal((await profileLstat(f.fifo)).isFIFO(),true);
  // A later BLOCKING native open could wait; this nonblocking synthetic open
  // demonstrates absent readers and deliberately does not make a browser claim.
  await assert.rejects(profileOpen(f.fifo,profileFS.O_WRONLY|profileFS.O_NONBLOCK),{code:'ENXIO'});
  assert.throws(()=>f.handle.launchEnvironment({}),error=>error.code==='PROFILE_LAUNCH_UNAVAILABLE');
 }finally{await f.cleanup();}
});

test('profiler FIFO mid-stream cancellation closes reader but leaves writer lifetime independent',async()=>{
 const f=await profileFixture();let writer;
 try{
  writer=await profileOpen(f.fifo,profileFS.O_WRONLY|profileFS.O_NONBLOCK);await profileWriteAll(writer,Buffer.from('{'));
  const result=await f.handle.cancel();assert.equal(result.helperClosed,true);assert.equal(result.browserClosed,false);assert.equal(result.ipcRemoved,false);
  await assert.rejects(writer.write(Buffer.from('}')),{code:'EPIPE'});assert.equal((await profileLstat(f.fifo)).isFIFO(),true);
 }finally{await writer?.close();await f.cleanup();}
});

test('profiler FIFO preserves original browser-close rejection identity after owned helper cancellation',async()=>{
 const f=await profileFixture();const original=Error('synthetic original browser failure');
 try{
  await f.handle.cancel();
  await assert.rejects(f.handle.finish({remainingMs:()=>15000,context:null,excludedRoots:f.roots,closeBrowser:async()=>{throw original;}}),error=>error===original);
  assert.equal(f.handle.snapshot().helperClosed,true);assert.equal(f.handle.snapshot().browserClosed,false);assert.equal(f.handle.snapshot().ipcRemoved,false);
 }finally{await f.cleanup();}
});

test('profiler FIFO will not remove an unexpected regular file after owned receiver close',async()=>{
 const f=await profileFixture();const secret='synthetic sentinel, never a real profile';
 try{
  await f.handle.cancel();await profileUnlink(f.fifo);await profileWriteFile(f.fifo,secret,{mode:0o600,flag:'wx'});
  const result=await f.handle.finish({remainingMs:()=>15000,context:null,excludedRoots:f.roots,closeBrowser:async()=>{}});
  assert.equal(result.status,'unavailable');assert.equal(result.regularFileObserved,true);assert.equal(result.ipcRemoved,false);assert.equal(result.summary,null);assert.equal((await profileLstat(f.fifo)).isFile(),true);assert.equal(JSON.stringify(result).includes(secret),false);
 }finally{
  // This test created the sentinel; the production helper explicitly refused
  // deletion. Remove that known synthetic input only after its assertions.
  await profileUnlink(f.fifo);await f.cleanup();
 }
});

test('profiler FIFO rechecks final archive roots without transporting raw bytes',async()=>{
 const f=await profileFixture();try{
  await f.handle.cancel();const result=await f.handle.finish({remainingMs:()=>15000,context:null,excludedRoots:[...f.roots,f.leaf],closeBrowser:async()=>{}});
  assert.equal(result.status,'unavailable');assert.equal(result.summary,null);assert.equal(result.helperClosed,true);assert.equal(result.browserClosed,true);
 }finally{await f.cleanup();}
});

test('profiler FIFO independent lifetime cancellation survives a globally skipped fixture teardown phase',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const f=await profileFixture();try{
  const owner=new FixtureOwner({failures:[]});owner.teardownBudgetMs=0;
  owner.add('browser-close',15000,()=>true,async()=>assert.fail('expired phase must not start'));
  await owner.teardown();assert.equal(owner.state.timingCleanup[0].expiredBeforeStart,true);
  t.mock.timers.tick(FIREFOX_PROFILE_IPC_LIMITS.lifetimeMs);
  await f.handle.cancel();const result=f.handle.snapshot();
  assert.equal(result.code,'PROFILE_LIFETIME_EXPIRED');assert.equal(result.helperClosed,true);assert.equal(result.browserClosed,false);assert.equal(result.ipcRemoved,false);assert.equal(result.writerMayOpen,true);
 }finally{t.mock.timers.reset();await f.cleanup();}
});

test('profiler FIFO close deadline cancels helper without upgrading an unresolved browser close',async t=>{
 const f=await profileFixture();const held=deferred(),entered=deferred();
 try{
  t.mock.timers.enable({apis:['setTimeout']});
  const closing=f.handle.finish({remainingMs:()=>15000,context:null,excludedRoots:f.roots,closeBrowser:()=>{entered.resolve();return held.promise;}});
  const outcome=closing.then(value=>({value}),error=>({error}));
  await entered.promise;
  t.mock.timers.tick(FIREFOX_PROFILE_IPC_LIMITS.closeWorkMs);
  await f.handle.cancel();
  assert.equal((await outcome).error.code,'PROFILE_BROWSER_CLOSURE_UNKNOWN');
  const result=f.handle.snapshot();assert.equal(result.helperClosed,true);assert.equal(result.browserClosed,false);assert.equal(result.ipcRemoved,false);
 }finally{held.resolve();t.mock.timers.reset();await f.cleanup();}
});


test('profiler FIFO rejects raw stream overflow without growing a retained raw payload',async()=>{
 const f=await profileFixture();try{
  const result=await f.handle.finish({remainingMs:()=>15000,context:null,excludedRoots:f.roots,closeBrowser:async()=>{
   const fd=await profileOpen(f.fifo,profileFS.O_WRONLY|profileFS.O_NONBLOCK);
   try{
    const block=Buffer.alloc(FIREFOX_PROFILE_IPC_LIMITS.chunkBytes,0x20);
    for(let count=0;count<FIREFOX_PROFILE_IPC_LIMITS.rawBytes/block.length;count++)await profileWriteAll(fd,block);
    await profileWriteAll(fd,Buffer.from(' '));
   }catch(error){if(error.code!=='EPIPE')throw error;}finally{await fd.close();}
  }});
  assert.equal(result.helperClosed,true);assert.equal(result.browserClosed,true);assert.equal(result.ipcRemoved,true);assert.equal(result.status,'unavailable');assert.equal(result.summary,null);assert.equal(result.rawBytes,FIREFOX_PROFILE_IPC_LIMITS.rawBytes);
  assert.ok(Buffer.byteLength(JSON.stringify(result))<1024);
 }finally{await f.cleanup();}
});


test('profiler FIFO expired actual phase never starts browser close or grants added grace',async()=>{
 const f=await profileFixture();let calls=0;
 try{
  await assert.rejects(f.handle.finish({remainingMs:()=>0,context:null,excludedRoots:f.roots,closeBrowser:async()=>{calls++;}}),error=>error.code==='PROFILE_PHASE_EXPIRED');
  assert.equal(calls,0);assert.equal(f.handle.snapshot().browserClosed,false);assert.equal(f.handle.snapshot().ipcRemoved,false);assert.equal(f.handle.snapshot().summary,null);
  // SIGKILL has been requested, not retrospectively called a synchronous exit.
  for(let i=0;i<10000&&!f.handle.snapshot().helperClosed;i++)await profileTurn();
  assert.equal(f.handle.snapshot().helperClosed,true);assert.equal((await profileLstat(f.fifo)).isFIFO(),true);
 }finally{await f.cleanup();}
});

test('profiler FIFO shortened actual phase shares its work and cancellation reserve',async t=>{
 const f=await profileFixture(),entered=deferred(),held=deferred();let expired=false;
 try{
  t.mock.timers.enable({apis:['setTimeout']});
  const result=f.handle.finish({remainingMs:()=>expired?0:400,context:null,excludedRoots:f.roots,closeBrowser:()=>{entered.resolve();return held.promise;}}).then(value=>({value}),error=>({error}));
  await entered.promise;t.mock.timers.tick(300);expired=true;t.mock.timers.tick(100);
  assert.equal((await result).error.code,'PROFILE_BROWSER_CLOSURE_UNKNOWN');
  assert.equal(f.handle.snapshot().browserClosed,false);assert.equal(f.handle.snapshot().ipcRemoved,false);
  for(let i=0;i<10000&&!f.handle.snapshot().helperClosed;i++)await profileTurn();
  assert.equal(f.handle.snapshot().helperClosed,true);
 }finally{held.resolve();t.mock.timers.reset();await f.cleanup();}
});

// Exact synthetic raw36 fixture/context from the independently authored parser controls.
const profileSyntheticValue={"meta":{"version":36,"startTime":1699999900000,"profilingStartTime":0,"contentEarliestTime":0,"profilingEndTime":200000,"shutdownTime":200000,"categories":[{"name":"Idle","subcategories":["Other"]},{"name":"Other","subcategories":["Other","Preference Read","Profiling"]},{"name":"Test","subcategories":["Test"]},{"name":"Layout","subcategories":["Other","Frame construction","Reflow","CSS parsing","Selector query","Style computation","Layout cleanup","Printing"]},{"name":"JavaScript","subcategories":["Other","Parsing","JIT Compile (baseline)","JIT Compile (ion)","Interpreter","JIT (baseline-interpreter)","JIT (baseline)","JIT (ion)","Builtin API","Wasm (ion)","Wasm (baseline)","Wasm (other)"]},{"name":"GC / CC","subcategories":["Other","Minor GC","Major GC (Other)","Major GC (Mark)","Major GC (Sweep)","Major GC (Compact)","Unmark Gray","Barrier","CC (Free Snow White)","CC (Build Graph)","CC (Scan Roots)","CC (Collect White)","CC (Finalize)"]},{"name":"Network","subcategories":["Other"]},{"name":"Graphics","subcategories":["Other","DisplayList building","DisplayList merging","Layer building","Tile allocation","WebRender display list","Rasterization","Flushing async paints","Image decoding","WebGPU","VSync triggered animation"]},{"name":"DOM","subcategories":["Other"]},{"name":"Android","subcategories":["Other"]},{"name":"AndroidX","subcategories":["Other"]},{"name":"Java","subcategories":["Other"]},{"name":"Mozilla","subcategories":["Other"]},{"name":"Kotlin","subcategories":["Other"]},{"name":"Blocked","subcategories":["Other"]},{"name":"Mailnews","subcategories":["Other"]},{"name":"IPC","subcategories":["Other"]},{"name":"Media","subcategories":["Other","Cubeb","Playback","Real-time rendering"]},{"name":"Accessibility","subcategories":["Other"]},{"name":"Profiler","subcategories":["Other"]},{"name":"Timer","subcategories":["Other"]},{"name":"Remote-Protocol","subcategories":["Other"]},{"name":"Sandbox","subcategories":["Other"]},{"name":"Telemetry","subcategories":["Other"]},{"name":"ML","subcategories":["Other","Inference","Setup"]},{"name":"Logs","subcategories":["Other"]}],"configuration":{"capacity":16777216,"interval":1,"features":["js","stackwalk","nomarkerstacks"],"threads":["GeckoMain"],"activeTabID":0}},"threads":[],"processes":[{"meta":{"version":36,"startTime":1699999995000,"profilingStartTime":0,"contentEarliestTime":0,"profilingEndTime":200000,"shutdownTime":200000,"categories":[{"name":"Idle","subcategories":["Other"]},{"name":"Other","subcategories":["Other","Preference Read","Profiling"]},{"name":"Test","subcategories":["Test"]},{"name":"Layout","subcategories":["Other","Frame construction","Reflow","CSS parsing","Selector query","Style computation","Layout cleanup","Printing"]},{"name":"JavaScript","subcategories":["Other","Parsing","JIT Compile (baseline)","JIT Compile (ion)","Interpreter","JIT (baseline-interpreter)","JIT (baseline)","JIT (ion)","Builtin API","Wasm (ion)","Wasm (baseline)","Wasm (other)"]},{"name":"GC / CC","subcategories":["Other","Minor GC","Major GC (Other)","Major GC (Mark)","Major GC (Sweep)","Major GC (Compact)","Unmark Gray","Barrier","CC (Free Snow White)","CC (Build Graph)","CC (Scan Roots)","CC (Collect White)","CC (Finalize)"]},{"name":"Network","subcategories":["Other"]},{"name":"Graphics","subcategories":["Other","DisplayList building","DisplayList merging","Layer building","Tile allocation","WebRender display list","Rasterization","Flushing async paints","Image decoding","WebGPU","VSync triggered animation"]},{"name":"DOM","subcategories":["Other"]},{"name":"Android","subcategories":["Other"]},{"name":"AndroidX","subcategories":["Other"]},{"name":"Java","subcategories":["Other"]},{"name":"Mozilla","subcategories":["Other"]},{"name":"Kotlin","subcategories":["Other"]},{"name":"Blocked","subcategories":["Other"]},{"name":"Mailnews","subcategories":["Other"]},{"name":"IPC","subcategories":["Other"]},{"name":"Media","subcategories":["Other","Cubeb","Playback","Real-time rendering"]},{"name":"Accessibility","subcategories":["Other"]},{"name":"Profiler","subcategories":["Other"]},{"name":"Timer","subcategories":["Other"]},{"name":"Remote-Protocol","subcategories":["Other"]},{"name":"Sandbox","subcategories":["Other"]},{"name":"Telemetry","subcategories":["Other"]},{"name":"ML","subcategories":["Other","Inference","Setup"]},{"name":"Logs","subcategories":["Other"]}],"configuration":{"capacity":16777216,"interval":1,"features":["js","stackwalk","nomarkerstacks"],"threads":["GeckoMain"],"activeTabID":0}},"threads":[{"name":"GeckoMain","processType":"tab","stringTable":["UserTiming","synthetic function"],"samples":{"schema":{"stack":0,"time":1,"eventDelay":2,"argumentValues":3,"threadCPUDelta":4},"data":[[0,6100],[0,6250],[0,6400]]},"stackTable":{"schema":{"prefix":0,"frame":1},"data":[[null,0]]},"frameTable":{"schema":{"location":0,"relevantForJS":1,"innerWindowID":2,"implementation":3,"line":4,"column":5,"category":6,"subcategory":7},"data":[[1,true,77,null,null,null,4,0]]},"markers":{"schema":{"name":0,"startTime":1,"endTime":2,"phase":3,"category":4,"data":5},"data":[[0,6000,0,0,8,{"type":"UserTiming","name":"p25.F5","entryType":"mark","innerWindowID":77}],[0,6400,0,0,8,{"type":"UserTiming","name":"p25.F6","entryType":"mark","innerWindowID":77}]]}}],"processes":[]}]};
const profileSyntheticContext={"p4WallMs":1700000001100,"realmTimeOriginMs":1700000000000,"f5WallMs":1700000001000,"f5MonotonicMs":1000,"f6WallMs":1700000001400,"f6MonotonicMs":1400,"queueReadEntryMonotonicMs":1125,"queueReadCallbackMonotonicMs":1375};

test('profiler FIFO accepts only sanitized projection after real EOF, helper exit and synthetic browser close',async()=>{
 const f=await profileFixture();try{
  const result=await f.handle.finish({remainingMs:()=>15000,context:profileSyntheticContext,excludedRoots:f.roots,closeBrowser:()=>profileWriteOnce(f,Buffer.from(JSON.stringify(profileSyntheticValue)))});
  assert.equal(result.status,'projected');assert.equal(result.code,'NONE');assert.equal(result.helperClosed,true);assert.equal(result.helperExitCode,0);assert.equal(result.browserClosed,true);assert.equal(result.ipcRemoved,true);assert.equal(result.writerMayOpen,false);
  assert.deepEqual(result.summary.samples,[[0,[3]],[150,[3]],[300,[3]]]);assert.deepEqual(result.summary.categoryCounts,[0,0,0,3,0,0]);assert.equal(result.summary.coverage,'NOT_CERTIFIED');assert.equal(result.summary.attribution,'UNATTRIBUTED');assert.equal(result.summary.timingQualified,false);assert.equal(result.qualification,false);
  const serialized=JSON.stringify(result);for(const forbidden of ['synthetic function','p25.F5','p25.F6','GeckoMain',f.fifo])assert.equal(serialized.includes(forbidden),false);
  assert.ok(Buffer.byteLength(serialized)<=FIREFOX_PROFILE_IPC_LIMITS.summaryBytes);
 }finally{await f.cleanup();}
});
