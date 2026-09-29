import test from 'node:test';import assert from 'node:assert/strict';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {mkdtemp,readFile,access} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
test('actual runner owns persistent public lifetimes, gates archive on positive closure and retains failed profiles',async()=>{
 const root=await mkdtemp(join(tmpdir(),'p25-persistent-runner-'));let result;
 try{await promisify(execFile)(process.execPath,['node_modules/@playwright/test/cli.js','test','--config','tests/recovery/persistent-runner.config.ts'],{env:{...process.env,PERSISTENT_RUNNER_ROOT:root},timeout:30000});assert.fail('Expected four synthetic failures');}catch(error){result=error;}
 assert.equal(result.code,1);const report=JSON.parse(await readFile(join(root,'runner.json'),'utf8'));assert.equal(report.stats.expected,1);assert.equal(report.stats.unexpected,4);assert.equal(report.stats.skipped,0);assert.deepEqual(report.errors,[]);
 for(const name of ['persistent-success','missing-handle','context-rejection','missing-disconnection','late-close']){
  const dir=join(root,name),r=JSON.parse(await readFile(join(dir,'outside-receipt.json'),'utf8')),saved=JSON.parse(await readFile(join(dir,'e4-observations.json'),'utf8'));
  await access(join(dir,'profile','retained'));assert.equal(r.contextCalls,1);assert.equal(r.ownerEvents.filter(e=>e.event==='functional-stop').length,1);assert.equal(r.ownerEvents.filter(e=>e.event==='teardown-settled').length,1);assert.equal(r.events.indexOf('native-reset')<r.events.indexOf('context-close'),true);assert.equal(saved.timingCleanup.find(s=>s.phase==='final-receipt').passed,undefined);assert.equal(r.cleanup.find(s=>s.phase==='final-receipt').passed,true);
  if(name==='persistent-success'){assert.deepEqual(r.physicalClosure,{contextClosed:true,browserClosed:true});assert.equal(r.retention.some(x=>x.verified===true),true);assert.equal(r.failures.length,0);assert.equal(saved.browserLifetime.persistent,true);assert.equal(saved.browserLifetime.browserDisconnectedObserved,true);}
  else{assert.equal(r.retention.some(x=>x.verified===true),false);assert.equal(r.failures.some(x=>x.phase==='archive-precondition'),true);assert.equal(r.physicalClosure.contextClosed&&r.physicalClosure.browserClosed,false);}
  if(name==='missing-handle')assert.equal(r.cleanup.find(x=>x.phase==='browser-close').unavailable,true);
  if(name==='missing-disconnection')assert.match(r.cleanup.find(x=>x.phase==='browser-close').error,/deadline/);
  if(name==='late-close'){assert.equal(saved.browserLifetime.contextCloseObserved,true);assert.equal(r.physicalClosure.contextClosed,false);assert.match(r.cleanup.find(x=>x.phase==='context-close').error,/deadline/);}
 }
 console.log(JSON.stringify({syntheticRunnerRoot:root,expectedPasses:1,expectedFailures:4,nativeLaunches:0}));
});
