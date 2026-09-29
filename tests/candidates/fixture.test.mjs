import test from'node:test';import assert from'node:assert/strict';import{fork}from'node:child_process';import{resolve,join}from'node:path';import{readFile}from'node:fs/promises';import{fixture,prepare,enqueue}from'../queue/helpers.mjs';import{ownServerProcess}from'../editor/completion/owned-process.mjs';import{pair,call,cookieFrom,readHeaders}from'../session/helpers.mjs';
test('browser process fixture owns emulator scheduler and reports drained native resources on close',async t=>{
 const cleanup=[],f=await fixture({name:t.name,after:fn=>cleanup.push(fn)}),q=await enqueue(f.writer,(await prepare(f.writer,d=>{d.fields.width='512';d.fields.height='512';})).body);await f.close();let server;
 t.after(async()=>{if(server&&!server.shutdown)await server.close();for(const fn of cleanup)await fn();});
 const child=fork(resolve('tests/candidates/process-fixture.mjs'),[f.root],{execArgv:['--import',resolve('tests/provider/no-egress.mjs')],env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR},stdio:['ignore','ignore','pipe','ipc']});server=await ownServerProcess(child,{});const url=await server.pair(),paired=await call(server.origin,'/api/v1/session/bootstrap',{method:'POST',headers:{Origin:server.origin},body:{protocolVersion:1,pairingToken:new URL(url).hash.slice(9)}}),headers=readHeaders(cookieFrom(paired));let view;
 for(let i=0;i<100;i++){const history=await call(server.origin,'/api/v1/documents/document_1/candidates',{headers});if(history.json?.items.length){view=(await call(server.origin,'/api/v1/jobs/'+q.job.id+'/candidates?attempt='+q.job.attempts[0].id,{headers})).json;if(view?.items[0]?.state==='prepared')break;}await new Promise(r=>setTimeout(r,50));}
 assert.equal(view?.items[0]?.state,'prepared');const effects=await server.effects();assert.deepEqual(effects.errors,[]);assert.equal(effects.effects.filter(e=>e.method==='POST').length,1);await server.close();const closed=JSON.parse(await readFile(join(f.root,'candidate-fixture.json'),'utf8'));assert.equal(closed.closed,true);assert.deepEqual(closed.resources.objects,{reservedBytes:'0',activeTransfers:0});assert.equal(closed.resources.raster.activeWorkers,0);
});

async function routingCase(mode){
 const {mkdir,writeFile}=await import('node:fs/promises'),{randomUUID}=await import('node:crypto');
 const receipt=resolve('artifacts/p24-routing',mode+'-'+randomUUID());await mkdir(receipt,{recursive:true});const output=join(receipt,'result.json');
 const child=fork(resolve('tests/candidates/routing-control.mjs'),[mode,output],{execArgv:['--import',resolve('tests/provider/no-egress.mjs')],env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR},stdio:['ignore','pipe','pipe','ipc']});
 let stdout='',stderr='';const lifecycle={pid:child.pid,messages:[],exit:null};child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('message',m=>lifecycle.messages.push(m));
 await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>{lifecycle.exit={code,signal,at:new Date().toISOString()};done();});});
 await writeFile(join(receipt,'stdout.txt'),stdout);await writeFile(join(receipt,'stderr.txt'),stderr);await writeFile(join(receipt,'lifecycle.json'),JSON.stringify(lifecycle,null,2));
 return {receipt,lifecycle,result:JSON.parse(await readFile(output,'utf8'))};
}
test('actual scheduler retains Base Fast Instant with independent identities and successful owned closure',async t=>{
 const x=await routingCase('sequence');t.diagnostic(JSON.stringify({receipt:x.receipt,lifecycle:x.lifecycle,root:x.result.root}));
 assert.deepEqual(x.result.jobs.map(j=>j.candidate?.items[0]?.state),['prepared','prepared','prepared'],JSON.stringify({jobs:x.result.jobs.map(j=>({endpoint:j.endpoint,state:j.queue?.attempts[0]?.state,count:j.queue?.attempts[0]?.count})),fixture:x.result.fixture,closeError:x.result.closeError}));
 assert.deepEqual(x.lifecycle.exit.code,0);assert.equal(x.lifecycle.exit.signal,null);assert.equal(x.result.writerClosed,true);assert.deepEqual(x.result.errors,[]);assert.deepEqual(x.result.fixture.errors,[]);
 assert.deepEqual(x.result.fixture.effects.filter(e=>e.method==='POST').map(e=>e.path),['/ideogram/v4','/ideogram/v4/fast','/ideogram/v4/instant']);
 for(const suffix of ['/status','/image/'])assert.equal(x.result.fixture.effects.filter(e=>suffix==='/status'?e.path.endsWith(suffix):e.path.startsWith(suffix)).length,3);
 assert.equal(x.result.fixture.effects.filter(e=>e.method==='GET'&&!e.path.endsWith('/status')&&!e.path.startsWith('/image/')).length,3);assert.equal(x.result.fixture.effects.length,12);
 assert.equal(new Set(x.result.jobs.map(j=>j.jobId)).size,3);assert.equal(new Set(x.result.jobs.map(j=>j.attemptId)).size,3);
 assert.equal(new Set(x.result.fixture.profiles.map(p=>p.id)).size,3);assert.deepEqual(x.result.fixture.failures,[]);
 for(const j of x.result.jobs){const profile=x.result.fixture.profiles.find(p=>p.endpoint===j.endpoint);assert(profile);for(const phase of ['submit','status','result','transfer'])assert(x.result.fixture.diagnostics.some(d=>d.phase===phase&&d.jobId===j.jobId&&d.attemptId===j.attemptId&&d.endpoint===j.endpoint&&d.profileId===profile.id));}
 for(const j of x.result.jobs){assert.equal(j.candidate.jobId,j.jobId);assert.equal(j.candidate.items[0].attemptId,j.attemptId);assert.equal(j.queue.attempts[0].state,'provider-terminal');assert.equal(j.queue.attempts[0].count,'dispatched');assert.equal(j.queue.attempts[0].hold,false);}
 assert.deepEqual(x.result.fixture.resources.objects,{reservedBytes:'0',activeTransfers:0});assert.equal(x.result.fixture.resources.raster.activeWorkers,0);assert.equal(x.result.fixture.resources.raster.reservedCPU,0);assert.equal(x.result.fixture.closed,true);
});

test('actual mismatched fixture profile refuses before reservation and retains structured failure and unsuccessful close',async t=>{
 const x=await routingCase('mismatch');t.diagnostic(JSON.stringify({receipt:x.receipt,lifecycle:x.lifecycle,root:x.result.root}));
 assert.equal(x.lifecycle.exit.code,1);assert.equal(x.lifecycle.exit.signal,null);assert.equal(x.result.writerClosed,false);assert.equal(x.result.closeError.code,'STORAGE_FAILURE');assert.deepEqual(x.result.errors,[]);
 assert.equal(x.result.jobs.length,2);const [base,fast]=x.result.jobs;assert.equal(base.candidate.items[0].state,'prepared');assert.equal(fast.endpoint,'ideogram/v4/fast');assert.equal(fast.queue.id,fast.jobId);assert.equal(fast.queue.attempts[0].id,fast.attemptId);assert.equal(fast.queue.attempts[0].state,'not-started');assert.equal(fast.queue.attempts[0].count,'none');assert.equal(fast.queue.attempts[0].hold,false);assert.equal(fast.queue.attempts[0].requestId,null);
 assert.equal(x.result.fixture.effects.length,4);assert.deepEqual(x.result.fixture.effects.filter(e=>e.method==='POST').map(e=>e.path),['/ideogram/v4']);assert.deepEqual(x.result.fixture.errors,['ProviderError: POLICY']);assert.equal(x.result.fixture.failures.length,1);
 const failure=x.result.fixture.failures[0];assert.equal(failure.phase,'submit');assert.equal(failure.jobId,fast.jobId);assert.equal(failure.attemptId,fast.attemptId);assert.equal(failure.endpoint,fast.endpoint);assert.equal(failure.profileId,'local-fixture-fast-v1');assert.equal(failure.error.name,'ProviderError');assert.equal(failure.error.message,'POLICY');assert.match(failure.error.stack,/resolvePrivacy/);assert.match(failure.error.stack,/QueueDispatcher.submit/);
 const selected=x.result.fixture.profiles.find(p=>p.id===failure.profileId);assert.equal(selected.endpoint,'ideogram/v4');assert.notEqual(selected.endpoint,fast.endpoint);const diagnostic=JSON.stringify({failures:x.result.fixture.failures,diagnostics:x.result.fixture.diagnostics});for(const secret of ['fixture-key-never-production-P21','fixture-cookie-never-production-P21','fixture-transfer-secret','Authorization','Set-Cookie'])assert(!diagnostic.includes(secret));
 assert.equal(x.result.fixture.closed,true);assert.deepEqual(x.result.fixture.resources.objects,{reservedBytes:'0',activeTransfers:0});assert.equal(x.result.fixture.resources.raster.activeWorkers,0);
});
