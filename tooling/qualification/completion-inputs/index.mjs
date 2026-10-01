import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {boundedChild} from '../container/bounded-child.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const transforms=['PW_DISABLE_TS_ESM','PLAYWRIGHT_FORCE_ASYNC_LOADER','PW_TEST_SOURCE_TRANSFORM','PW_TEST_SOURCE_TRANSFORM_SCOPE'];
const completionIdentityNames=['COMPLETION_APPLICATION_IDENTITY','COMPLETION_ISSUER_MANIFEST'];
const save=(path,value)=>writeFile(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});
async function identify(path,expected){
  const bytes=await readFile(path),identity={path,bytes:bytes.length,sha256:sha(bytes)};
  if(expected){assert.equal(identity.bytes,expected.bytes,'Retained input byte length: '+path);assert.equal(identity.sha256,expected.sha256,'Retained input hash: '+path);}
  return {bytes,identity};
}

// No Git or external evidence directory is required. The caller supplies a
// source snapshot with pinned npm dependencies and a fresh receipt directory.
// The copied historical monitor is consumed as data by the equivalence test;
// only the current host installer is evaluated by the preserved producer.
export async function prepareCompletionInputs(output,root=process.cwd(),{abortSignal,timeoutMs=60000,env:parentEnvironment=process.env}={}){
  root=resolve(root);output=resolve(output);
  await mkdir(dirname(output),{recursive:true});await mkdir(output,{mode:0o700});
  const started=performance.now(),receipt={schemaVersion:1,kind:'completion-helper-preparation-1',status:'running',root,output,startedAt:new Date().toISOString(),node:process.version,inputs:[],outputs:[],scope:'Non-browser historical equivalence input and fresh pinned ESM/VM callback capture. No live event, trusted event, or native-method claim.'};
  const receiptPath=join(output,'preparation.json');await save(receiptPath,receipt);
  try{
    const directory=join(root,'tooling/qualification/completion-inputs');
    const provenanceFile=await identify(join(directory,'provenance.json')),provenance=JSON.parse(provenanceFile.bytes);
    receipt.inputs.push(provenanceFile.identity);
    assert.equal(provenance.schemaVersion,1);assert.equal(process.versions.node,provenance.runtime.node,'Use the repository-pinned Node runtime');
    for(const name of transforms)assert.equal(parentEnvironment[name],undefined,'Unexpected Playwright source transform: '+name);
    const monitor=await identify(join(directory,provenance.files.protocolOldMonitor.path),provenance.files.protocolOldMonitor);
    const producer=await identify(join(directory,provenance.files.captureProducer.path),provenance.files.captureProducer);
    const source=await identify(join(root,'tests/editor/completion/host-final-page.mjs'));
    const artifact=await identify(join(root,provenance.immutableHandlerArtifact.path),provenance.immutableHandlerArtifact);
    const common=await identify(join(root,'node_modules/playwright/lib/common/index.js'));
    const bundle=await identify(join(root,'node_modules/playwright-core/lib/coreBundle.js'));
    const dependency=JSON.parse(await readFile(join(root,'node_modules/playwright/package.json'),'utf8'));
    assert.equal(dependency.version,provenance.runtime.playwright,'Use the repository-pinned Playwright dependency');
    assert.equal(common.identity.sha256,provenance.runtime.commonSHA256,'Pinned Playwright ESM transform');
    assert.equal(bundle.identity.sha256,provenance.runtime.bundleSHA256,'Pinned Playwright evaluation runtime');
    receipt.inputs.push(monitor.identity,producer.identity,source.identity,artifact.identity,common.identity,bundle.identity);
    const monitorPath=join(output,'PROTOCOL_OLD_MONITOR.mjs');
    await writeFile(monitorPath,monitor.bytes,{flag:'wx',mode:0o600});
    const capture=join(output,'handler-capture');
    // Explicit NODE_OPTIONS propagation carries the existing preloads and this
    // network guard through the producer's two spawned Node capture processes.
    const env={};
    for(const name of ['PATH','TMPDIR','TMP','TEMP','SystemRoot','WINDIR','LANG','LC_ALL','LC_CTYPE'])if(parentEnvironment[name]!==undefined)env[name]=parentEnvironment[name];
    if(completionIdentityNames.some(name=>Object.hasOwn(parentEnvironment,name))){
      const identities={};
      receipt.completionIdentityInputs={};
      for(const name of completionIdentityNames){
        const path=parentEnvironment[name];
        assert(typeof path==='string'&&path.length>0&&isAbsolute(path),name+' must be an explicit absolute file path; provide both completion identity inputs');
        const input=await identify(path);
        identities[name]=JSON.parse(input.bytes);
        receipt.inputs.push(input.identity);receipt.completionIdentityInputs[name]=input.identity;
        env[name]=path;
      }
      const application=identities.COMPLETION_APPLICATION_IDENTITY,issuers=identities.COMPLETION_ISSUER_MANIFEST;
      assert.equal(application.schema,1);assert.equal(application.kind,'REVIEWED-COMPLETION-APPLICATION-IDENTITY');
      assert.equal(issuers.kind,'SOURCE-BOUND-APPLICATION-ISSUERS-1');
      assert.equal(issuers.applicationIdentitySHA256,sha(JSON.stringify(application)),'Capture issuer manifest belongs to the supplied application identity');
    }
    const preload=join(root,'tests/store/no-network.mjs');
    env.NODE_OPTIONS=[parentEnvironment.NODE_OPTIONS??'','--import='+JSON.stringify(preload)].filter(Boolean).join(' ');
    env.EDITOR_RECEIPT=capture;
    const args=[producer.identity.path,'--verify'];
    receipt.command={executable:process.execPath,args,cwd:root,networkGuard:preload,mode:'--verify'};
    const localAbort=new AbortController(),signal=abortSignal??localAbort.signal;
    const interrupt=()=>localAbort.abort('SIGINT'),terminate=()=>localAbort.abort('SIGTERM');
    if(!abortSignal){process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);}
    const log=createWriteStream(join(output,'capture.log'),{flags:'wx',mode:0o600});
    let logError;log.on('error',error=>{logError=error;localAbort.abort('Capture log write failed');});
    try{
      const remainingMs=Math.min(60000,Math.floor(timeoutMs-(performance.now()-started)));
      if(remainingMs<1)throw Object.assign(Error('Completion preparation exceeded its deadline'),{timedOut:true});
      const child=await boundedChild(process.execPath,args,{cwd:root,env,timeoutMs:remainingMs,abortSignal:AbortSignal.any([signal,localAbort.signal]),onStdout:bytes=>log.write(bytes),onStderr:bytes=>log.write(bytes)});
      receipt.child=child;
      if(child.code!==0||child.signal||child.timedOut||child.interrupted)throw Object.assign(Error('Completion capture did not complete successfully'),child);
    }finally{
      if(!abortSignal){process.off('SIGINT',interrupt);process.off('SIGTERM',terminate);}
      await new Promise(done=>{if(log.closed)return done();log.once('close',done);log.end();});
    }
    if(logError)throw logError;
    const summaryPath=join(capture,'result.json'),firstPath=join(capture,'first/result.json'),secondPath=join(capture,'independent/result.json');
    const summaryFile=await identify(summaryPath),firstFile=await identify(firstPath),secondFile=await identify(secondPath);
    const summary=JSON.parse(summaryFile.bytes),first=JSON.parse(firstFile.bytes),second=JSON.parse(secondFile.bytes);
    assert.equal(summary.passed,true,'Independent capture comparison passed');
    assert.equal(summary.children.length,2);assert(summary.children.every(child=>child.exit===0&&child.signal===null));
    assert.notEqual(first.pid,second.pid,'Independent capture processes');
    for(const current of [first,second]){
      assert.equal(current.nonBrowser,true);assert.equal(current.nativeMethodIsSimulated,true);assert.equal(current.trustedEventClaim,false);
      assert.equal(current.node,process.version);assert.equal(current.logical,source.identity.path);
      assert.equal(current.inputSHA256,source.identity.sha256);assert.equal(current.bundleSHA256,bundle.identity.sha256);assert.equal(current.commonSHA256,common.identity.sha256);
      for(const [content,digest]of [['installer','installerSHA256'],['expression','expressionSHA256'],['handler','handlerSHA256']])assert.equal(sha(current[content]),current[digest]);
      assert.equal(sha(JSON.stringify(current.envelope)),current.injectionSHA256);
      for(const name of ['handlerSHA256','installerSHA256','expressionSHA256','injectionSHA256'])assert.equal(current[name],provenance.referenceCapture[name],'Immutable independent host callback identity: '+name);
    }
    for(const name of ['installer','expression','handler','installerSHA256','expressionSHA256','handlerSHA256','injectionSHA256'])assert.equal(first[name],second[name]);
    assert.deepEqual(first.registrations,second.registrations);
    // Detect changes during preparation, even when callers also seal the whole
    // source snapshot before and after their larger qualification run.
    for(const input of receipt.inputs)await identify(input.path,input);
    for(const expected of [{...monitor.identity,path:monitorPath},firstFile.identity,secondFile.identity,summaryFile.identity])receipt.outputs.push((await identify(expected.path,expected)).identity);
    receipt.status='complete';receipt.environment={PROTOCOL_OLD_MONITOR:monitorPath,HOST_HANDLER_CAPTURE:firstPath};
    return Object.freeze({...receipt.environment});
  }catch(error){receipt.status='failed';receipt.error={name:error.name??'Error',message:String(error.message??error),...(error.code!==undefined?{code:error.code}:{})};throw error;}
  finally{receipt.endedAt=new Date().toISOString();receipt.durationMilliseconds=performance.now()-started;await save(receiptPath,receipt);}
}
