import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,lstat,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {monotonic} from '../../tooling/qualification/campaigns/common.mjs';

const sourceURL=new URL('../../tooling/qualification/campaigns/windowserver-navigation.mjs',import.meta.url);
const boundary="import {startNavigationWindowServerCapture,verifyLiveNavigationWindowServerEvidence} from './windowserver-navigation-verification.mjs';";
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};

// Test-only source projection: replace exactly the supervisor-start import.
// All collector bodies and the real live verifier remain unchanged. Fake stop
// objects never enter that verifier's private supervisor map, so these tests
// establish orchestration only, never native capture or display authority.
async function projectedCollector(t,start){
  const key='navigation-lifecycle-'+randomUUID();globalThis[key]=start;
  t.after(()=>{delete globalThis[key];});
  let source=await readFile(sourceURL,'utf8');assert.equal(source.split(boundary).length,2,'exact supervisor import changed');
  source=source.replace(boundary,`const startNavigationWindowServerCapture=globalThis[${JSON.stringify(key)}];\nimport {verifyLiveNavigationWindowServerEvidence} from ${JSON.stringify(new URL('./windowserver-navigation-verification.mjs',sourceURL).href)};`);
  source=source.replace(/from '(\.\/[^']+)'/g,(_all,path)=>'from '+JSON.stringify(new URL(path,sourceURL).href));
  return import('data:text/javascript;base64,'+Buffer.from(source+'\n// '+key).toString('base64'));
}

async function specimen(t,options={}){
  const output=await realpath(await mkdtemp(join(tmpdir(),'navigation-lifecycle-')));t.after(()=>rm(output,{recursive:true,force:true}));
  const stat=await lstat(output),events=[],nonce='a'.repeat(48),display={id:1},viewport={width:2,height:1},controller=new AbortController();
  let tick=10;
  const handles={},stops={},starts={};
  const start=async request=>{
    const stage=request.navigationBinding.stage;events.push(stage+':start');starts[stage]=(starts[stage]??0)+1;
    if(options.start)await options.start(stage,request);
    if(options.fail===stage+':start')throw Error('fixture start unavailable');
    const handle={ready:{display},
      async waitForPixelHash(){events.push(stage+':pixels');if(options.fail===stage+':pixels')throw Error('fixture pixel unavailable');return{ordinal:1};},
      async captureClock(id){events.push(stage+':clock');if(options.clock)await options.clock(stage,id,controller);if(options.fail===stage+':clock')throw Error('fixture clock unavailable');return{schemaVersion:1,event:'clock',id,mach:String(++tick)};},
      async stop(){events.push(stage+':stop');stops[stage]=(stops[stage]??0)+1;if(options.fail===stage+':stop')throw Error('fixture stop unavailable');
        return{manifest:{path:join(output,stage+'-no-native-manifest.json'),bytes:1,sha256:'0'.repeat(64)},process:{fixture:true}};},
    };handles[stage]=handle;return handle;
  };
  const {createNavigationWindowServerTransaction}=await projectedCollector(t,start);
  const browser={viewport,deviceScaleFactor:1},canonical={documentId:'document-fixture',width:1,height:1,layerCount:0,assetId:null,assetHash:null};
  const config={schemaVersion:1,displayID:1,expectedBrowserPid:123,roi:{x:0,y:0,width:2,height:1},durationMs:1000,maxFrames:10,maxBytes:1024};
  const selected={selection:{build:{receiptPath:join(output,'unused-build.json'),receiptSha256:'1'.repeat(64)}},configs:{anchor:config,shell:config,canvas:config}};
  const invocation={workerProcessIdentity:{pid:process.pid}},binding={navigationNonce:nonce,attempt:{documentId:canonical.documentId},invocation,browser,
    collectorSource:{sha256:'2'.repeat(64)},capturePlan:{reservedPixelBytes:4096}};
  const oracleInputs={shell:{oracle:{display,roi:config.roi,before:{sha256:'3'.repeat(64)},after:{sha256:'4'.repeat(64)}}},
    canvas:{oracle:{display,roi:{x:0,y:0,width:1,height:1},canonical,coverage:{cssRectangle:{x:0,y:0,width:1,height:1}},after:{sha256:'5'.repeat(64)}}}};
  const transaction=createNavigationWindowServerTransaction({navigationNonce:nonce,nativeId:'nv-'+nonce,binding,selected,signal:controller.signal,output,
    outputIdentity:{dev:stat.dev,ino:stat.ino},oracleInputs,handles:{},stopped:{},captures:{},missing:[],failures:[],invocation,runtime:browser});
  const navigation={nonce,previousTimeOrigin:1,timeOrigin:2,entry:{startTime:0,type:'navigate',name:'http://127.0.0.1:1234/'},visibility:'visible',topLevel:true};
  const controls=names=>names.map(name=>({name,visible:true,enabled:true}));
  const shell=()=>({navigation,readyMs:monotonic(),recoveryText:'Local recovery complete. Accepted edits are saved locally.',controls:controls(['New','Open']),viewport:{...viewport,deviceScaleFactor:1}});
  const canvas=()=>({navigation,readyMs:monotonic(),canonical:{...canonical,revision:'1'},viewport:{asset:null,visible:true,x:0,y:0,width:1,height:1},
    toolbar:controls(['New','Open','Import image','Close document','Export image']),acceptedEdit:{commandId:'checkpoint',documentId:canonical.documentId,status:'accepted',documentRevision:'1',transactionId:'transaction'},stableRevision:true});
  const result=(shellWitness,canvasWitness)=>({documentId:canonical.documentId,acceptedTestEdit:true,publicOpenCompleted:true,startupBoundary:'document-ready-via-Open',navigation,
    nativeReadiness:{shell:shellWitness,canvas:canvasWitness}});
  return{transaction,events,handles,starts,stops,controller,shell,canvas,result,output};
}

test('native prerequisite failures preserve exactly one original navigation',async t=>{
  for(const fail of ['anchor:start','anchor:pixels','anchor:clock'])await t.test(fail,async t=>{
    const fixture=await specimen(t,{fail});let calls=0;
    assert.equal(await fixture.transaction.navigationStart({run:async()=>{calls++;return'original-goto';}}),'original-goto');
    const final=await fixture.transaction.finish({actionCompleted:false});assert.equal(calls,1);assert.equal(final.proof,null);
    assert(final.observation.missing.includes('native-navigation-lower-anchor-unavailable'));
    assert.equal(fixture.stops.anchor??0,fail==='anchor:start'?0:1);
  });
});

test('original navigation rejection is preserved after native anchor cleanup',async t=>{
  const fixture=await specimen(t),failure=Error('original goto failed');let calls=0;
  await assert.rejects(fixture.transaction.navigationStart({run:async()=>{calls++;throw failure;}}),error=>error===failure);
  const final=await fixture.transaction.finish({actionCompleted:false});assert.equal(calls,1);assert.equal(fixture.stops.anchor,1);assert.equal(final.proof,null);
});

test('abort before dispatch prevents navigation and closes an admitted native handle',async t=>{
  const fixture=await specimen(t,{clock:async(stage,_id,controller)=>{if(stage==='anchor')controller.abort(Error('fixture abort'));}});let calls=0;
  await assert.rejects(fixture.transaction.navigationStart({run:async()=>{calls++;}}),/fixture abort/);
  const final=await fixture.transaction.finish({actionCompleted:false});assert.equal(calls,0);assert.equal(fixture.stops.anchor,1);assert.equal(final.proof,null);
  const early=await specimen(t);early.controller.abort(Error('already aborted'));
  assert.throws(()=>early.transaction.navigationStart({run:()=>{calls++;}}),/already aborted/);assert.equal(early.starts.anchor,undefined);
});

test('finish drains a previously admitted asynchronous start before stopping handles',async t=>{
  const gate=deferred(),started=deferred(),fixture=await specimen(t,{start:async stage=>{if(stage==='anchor'){started.resolve();await gate.promise;}}});let calls=0,closed=false;
  const run=fixture.transaction.navigationStart({run:async()=>{calls++;return'loaded';}});await started.promise;
  const finish=fixture.transaction.finish({actionCompleted:false});finish.then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);
  gate.resolve();assert.equal(await run,'loaded');const final=await finish;
  assert.equal(calls,1);assert.equal(fixture.stops.anchor,1);assert.equal(final.proof,null);assert.equal(closed,true);
});

test('canvas admission waits for the entire shell hook to finish',async t=>{
  const gate=deferred(),started=deferred(),fixture=await specimen(t,{start:async stage=>{if(stage==='shell'){started.resolve();await gate.promise;}}});
  await fixture.transaction.navigationStart({run:async()=>{}});
  const shell=fixture.transaction.shellReady(fixture.shell());await started.promise;
  await assert.rejects(fixture.transaction.canvasReady(fixture.canvas()),/readiness hook order/);assert.equal(fixture.starts.canvas,undefined);
  gate.resolve();await shell;await fixture.transaction.canvasReady(fixture.canvas());
  await fixture.transaction.finish({actionCompleted:false});assert.equal(fixture.stops.shell,1);assert.equal(fixture.stops.canvas,1);
});

test('navigation is single-use and finish is one stable idempotent closure',async t=>{
  const fixture=await specimen(t);let calls=0;await fixture.transaction.navigationStart({run:async()=>{calls++;}});
  assert.throws(()=>fixture.transaction.navigationStart({run:async()=>{calls++;}}),/single-use/);
  const first=fixture.transaction.finish({actionCompleted:false}),second=fixture.transaction.finish({actionCompleted:true});assert.equal(first,second);
  await first;await assert.rejects(fixture.transaction.shellReady(fixture.shell()),/readiness hook order/);assert.equal(calls,1);assert.equal(fixture.stops.anchor,1);
});

test('native stop failure remains unavailable without skipping the public navigation',async t=>{
  const fixture=await specimen(t,{fail:'anchor:stop'});let calls=0;
  await fixture.transaction.navigationStart({run:async()=>{calls++;}});const final=await fixture.transaction.finish({actionCompleted:false});
  assert.equal(calls,1);assert.equal(final.proof,null);assert(final.observation.missing.includes('native-navigation-anchor-closure-unavailable'));
  assert(final.observation.failures.some(error=>error.message==='fixture stop unavailable'));
});

test('serial hook order preserves the original action and fake captures cannot qualify',async t=>{
  const fixture=await specimen(t);
  await fixture.transaction.navigationStart({run:async()=>{fixture.events.push('original:goto');}});
  const shell=fixture.shell();await fixture.transaction.shellReady(shell);const canvas=fixture.canvas();await fixture.transaction.canvasReady(canvas);
  const final=await fixture.transaction.finish({result:fixture.result(shell,canvas),actionCompleted:true});
  assert.deepEqual(fixture.events,['anchor:start','anchor:pixels','anchor:clock','anchor:stop','original:goto','shell:start','shell:clock','shell:pixels','shell:stop','canvas:start','canvas:clock','canvas:pixels','canvas:stop']);
  assert.equal(final.proof,null);assert(final.observation.missing.includes('native-navigation-original-byte-replay-unavailable'));
  assert.deepEqual(final.observation.readiness.shell.witness,shell);assert.deepEqual(final.observation.readiness.canvas.witness,canvas);
});
