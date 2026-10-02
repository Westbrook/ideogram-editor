// Authored source-only controls. These fixtures never invoke Swift or capture
// a display. Their synthetic Mach-O headers are not runnable native evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,realpath,rm,symlink,chmod,lstat,readdir,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildWindowServerCollector,verifyWindowServerBuild,retainWindowServerBuildEvidence,verifyWindowServerBuildEvidence,inspectWindowServerSdk} from '../../tooling/qualification/native/windowserver-build.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const sdkBytes=Buffer.from('sdk-fixture\n');
const ordered=rows=>[...rows].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
const sdkDigest=rows=>sha(JSON.stringify({kind:'windowserver-sdk-tree-1',entries:ordered(rows)}));
const verificationPins=({receiptPath,receiptSha256,sourceSha256})=>({receiptPath,receiptSha256,sourceSha256});
const evidencePins=({directory,manifestSha256,sourceSha256})=>({directory,manifestSha256,sourceSha256});
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
async function fixture(t,{mode='success',timeoutMs=10_000}={}){
  const root=await mkdtemp(join(await realpath(tmpdir()),'windowserver-build-control-'));await chmod(root,0o700);
  t.after(()=>rm(root,{recursive:true,force:true}));
  const sourcePath=join(root,'capture.swift'),compilerPath=join(root,'compiler'),helper=join(root,'compiler-fixture.mjs'),sdkPath=join(root,'sdk');
  const source=Buffer.from('// synthetic pinned collector source\n');await writeFile(sourcePath,source,{mode:0o600});
  await mkdir(sdkPath,{mode:0o700});await mkdir(join(sdkPath,'stdlib'),{mode:0o700});await writeFile(join(sdkPath,'stdlib/fixture.tbd'),sdkBytes,{mode:0o600});
  // The script itself is the explicitly pinned fixture compiler. Its helper is
  // test scaffolding, not a claim of a hermetically sealed compiler toolchain.
  await writeFile(helper,`import {writeFileSync,appendFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
const args=process.argv.slice(2),mode=${JSON.stringify(mode)};
if(args[0]!=='--driver-mode=swiftc')throw Error('missing fixed driver mode');
if(args.includes('--version')){
 if(mode==='flood')process.stdout.write('x'.repeat(2*1024**2));
 else console.log('Synthetic Swift compiler fixture; never native evidence');
}else if(mode==='hang'){
 writeFileSync(join(process.cwd(),'fixture-started'),'started');setInterval(()=>{},1000);
}else if(mode==='exit'){
 console.error('synthetic build refusal');process.exitCode=7;
}else{
 if(args.includes('-parse-as-library')||!args.includes('-sdk')||!args.includes('-target'))throw Error('missing exact build flags');
 const binary=args[args.indexOf('-o')+1],target=args[args.indexOf('-target')+1],header=Buffer.alloc(64);
 header.writeUInt32LE(0xfeedfacf,0);header.writeUInt32LE(target.startsWith('arm64-')?0x0100000c:0x01000007,4);header.writeUInt32LE(2,12);
 writeFileSync(binary,mode==='not-mach-o'?Buffer.from('not a native executable'):header,{mode:0o700});
 if(mode==='sdk-drift')appendFileSync(join(process.env.SDKROOT,'stdlib/fixture.tbd'),'changed');
 if(mode==='source-drift')appendFileSync(${JSON.stringify(sourcePath)},'changed');
 if(mode==='compiler-drift')appendFileSync(${JSON.stringify(compilerPath)},'\\n# changed');
 if(mode==='retained-source-drift')appendFileSync(args.at(-1),'changed');
 console.log(JSON.stringify({args,source:readFileSync(args.at(-1),'utf8'),injected:process.env.NODE_OPTIONS??null}));
}
`,{mode:0o600});
  const compiler=Buffer.from('#!/bin/sh\nexec '+quote(process.execPath)+' '+quote(helper)+' "$@"\n');await writeFile(compilerPath,compiler,{mode:0o700});
  const rows=[{path:'.',type:'directory',mode:0o700},{path:'stdlib',type:'directory',mode:0o700},{path:'stdlib/fixture.tbd',type:'file',bytes:sdkBytes.length,sha256:sha(sdkBytes),mode:0o600}];
  const options={sourcePath,sourceSha256:sha(source),compilerPath,compilerSha256:sha(compiler),sdkPath,sdkTreeDigest:sdkDigest(rows),outputDirectory:join(root,'build'),timeoutMs};
  return {root,rows,options,async link(path,target){const linkPath=join(sdkPath,path);await symlink(target,linkPath);rows.push({path,type:'link',mode:(await lstat(linkPath)).mode&0o777,target});options.sdkTreeDigest=sdkDigest(rows);}};
}
async function retainedFailure(operation){
  let failure;try{await operation();}catch(error){failure=error;}assert.ok(failure,'operation must fail');
  assert.ok(failure.receiptPath,'failure retains its owned receipt');assert.match(failure.receiptSha256,/^[a-f0-9]{64}$/);
  const bytes=await readFile(failure.receiptPath);assert.equal(sha(bytes),failure.receiptSha256);const receipt=JSON.parse(bytes);assert.equal(receipt.status,'FAIL');assert.equal(receipt.qualification,false);
  return {failure,receipt};
}
async function rewriteReceipt(result,change){
  const receipt=JSON.parse(await readFile(result.receiptPath));change(receipt);const bytes=Buffer.from(JSON.stringify(receipt,null,2)+'\n');await writeFile(result.receiptPath,bytes);
  return {...result,receiptSha256:sha(bytes)};
}

test('explicit fixture build binds fixed invocation and verifies without running the collector',async t=>{
  const f=await fixture(t),built=await buildWindowServerCollector(f.options),receipt=JSON.parse(await readFile(built.receiptPath));
  assert.equal(built.sourceSha256,f.options.sourceSha256);assert.equal(built.qualification,false);assert.equal(receipt.scope,'pinned source/compiler executable/SDK observed build');
  assert.equal((await lstat(f.options.outputDirectory)).mode&0o777,0o700);assert.equal((await lstat(built.binaryPath)).mode&0o777,0o700);
  assert.deepEqual(receipt.commands.map(command=>command.stage),['version','build']);assert.equal(receipt.commands[1].executable,f.options.compilerPath);
  assert.deepEqual(receipt.commands[0].args,['--driver-mode=swiftc','--version']);assert.equal(receipt.commands[1].args.includes('-parse-as-library'),false);
  assert.equal(receipt.commands[1].environment.SDKROOT,f.options.sdkPath);assert.equal(receipt.commands[1].environment.NODE_OPTIONS,undefined);
  assert.equal(receipt.sdk.beforeDigest,f.options.sdkTreeDigest);assert.equal(receipt.sdk.afterDigest,f.options.sdkTreeDigest);
  assert.deepEqual(await verifyWindowServerBuild(verificationPins(built)),built);
  assert.equal((await readdir(f.options.outputDirectory)).includes('frames.ndjson'),false);
});

test('SDK directory and file aliases are bound to the complete physical tree',async t=>{
  const f=await fixture(t);await f.link('!Alias','stdlib');await f.link('Alias','stdlib');await f.link('Header','Alias/fixture.tbd');
  const built=await buildWindowServerCollector(f.options);assert.deepEqual(await verifyWindowServerBuild(verificationPins(built)),built);
});

for(const [name,target]of [['external','/private/outside-sdk'],['leave-and-reenter','../sdk/stdlib'],['dangling','missing'],['cycle','Alias'],['expanding-cycle',Array(64).fill('Alias').join('/')]]){
  test('SDK '+name+' link cannot reach compiler execution',async t=>{
    const f=await fixture(t);await f.link('Alias',target);const {receipt}=await retainedFailure(()=>buildWindowServerCollector(f.options));
    assert.deepEqual(receipt.commands,[]);assert.match(receipt.error,/SDK link/i);
  });
}

test('missing, mismatched and aliased inputs fail before compiler execution',async t=>{
  const f=await fixture(t);const {receipt}=await retainedFailure(()=>buildWindowServerCollector({...f.options,sourceSha256:'0'.repeat(64)}));assert.deepEqual(receipt.commands,[]);
  const g=await fixture(t);await symlink(g.options.compilerPath,join(g.root,'compiler-alias'));
  const alias=await retainedFailure(()=>buildWindowServerCollector({...g.options,compilerPath:join(g.root,'compiler-alias')}));assert.deepEqual(alias.receipt.commands,[]);
  await assert.rejects(buildWindowServerCollector({...g.options,outputDirectory:'relative'}),/canonical absolute/);
  await assert.rejects(buildWindowServerCollector({...g.options,compilerPath:'/usr/bin/swiftc'}),/shims/);
  await assert.rejects(buildWindowServerCollector({...g.options,qualification:true}),/fields/);
});

test('an existing output directory is retained and never reused',async t=>{
  const f=await fixture(t);await mkdir(f.options.outputDirectory,{mode:0o700});const marker=join(f.options.outputDirectory,'original');await writeFile(marker,'keep');
  await assert.rejects(buildWindowServerCollector(f.options),/EEXIST/);assert.equal(await readFile(marker,'utf8'),'keep');
});

for(const mode of ['sdk-drift','source-drift','compiler-drift','retained-source-drift','not-mach-o','exit']){
  test('compiler control '+mode+' retains a nonadmissible failure receipt',async t=>{
    const f=await fixture(t,{mode}),{failure,receipt}=await retainedFailure(()=>buildWindowServerCollector(f.options));assert.ok(receipt.commands.length>=1);
    await assert.rejects(verifyWindowServerBuild(verificationPins({...failure,sourceSha256:f.options.sourceSha256})),/not an admitted successful/);
  });
}

test('bounded compiler output fails with retained capped logs',async t=>{
  const f=await fixture(t,{mode:'flood'}),{receipt}=await retainedFailure(()=>buildWindowServerCollector(f.options));
  assert.equal(receipt.commands.length,1);const version=receipt.commands[0];assert.match(version.result.error,/log byte limit/);
  assert.ok(version.logs.stdout.bytes+version.logs.stderr.bytes<=1024**2);
});

test('compiler timeout retains failure evidence after owned process termination',async t=>{
  const f=await fixture(t,{mode:'hang',timeoutMs:2000}),{receipt}=await retainedFailure(()=>buildWindowServerCollector(f.options));
  assert.equal(receipt.commands.at(-1).stage,'build');assert.ok(receipt.commands.at(-1).result.interrupted||receipt.commands.at(-1).result.timedOut);
});

test('an already aborted preparation never creates output or starts a compiler',async t=>{
  const f=await fixture(t),controller=new AbortController();controller.abort('synthetic cancellation');
  await assert.rejects(buildWindowServerCollector({...f.options,abortSignal:controller.signal}),/synthetic cancellation/);
  await assert.rejects(lstat(f.options.outputDirectory),{code:'ENOENT'});
});

test('verifier rejects an incorrect external receipt or source pin',async t=>{
  const f=await fixture(t),built=await buildWindowServerCollector(f.options);
  await assert.rejects(verifyWindowServerBuild({...verificationPins(built),receiptSha256:'0'.repeat(64)}),/receipt hash mismatch/);
  await assert.rejects(verifyWindowServerBuild({...verificationPins(built),sourceSha256:'0'.repeat(64)}),/source pin mismatch/);
});

for(const [name,change]of [
  ['qualification',receipt=>receipt.qualification=true],
  ['extra approval',receipt=>receipt.oracleApproved=true],
  ['argv',receipt=>receipt.commands[1].args.push('-unreviewed')],
  ['library parse mode',receipt=>receipt.commands[1].args.push('-parse-as-library')],
  ['environment',receipt=>receipt.commands[1].environment.NODE_OPTIONS='injected'],
  ['escaped log',receipt=>receipt.commands[0].logs.stdout.path='../outside'],
  ['failed invocation',receipt=>receipt.commands[1].result.code=7],
  ['retained source alias',receipt=>receipt.source.retainedPath='../capture.swift'],
])test('a resealed receipt cannot change '+name+' admission requirements',async t=>{
  const f=await fixture(t),built=await buildWindowServerCollector(f.options),changed=await rewriteReceipt(built,change);
  await assert.rejects(verifyWindowServerBuild(verificationPins(changed)));
});

test('verifier rechecks the binary and logs while build-only inputs can change or disappear',async t=>{
  const f=await fixture(t),built=await buildWindowServerCollector(f.options),binary=await readFile(built.binaryPath);
  await writeFile(built.binaryPath,Buffer.concat([binary,Buffer.from('tampered')]));await assert.rejects(verifyWindowServerBuild(verificationPins(built)),/binary identity mismatch/);await writeFile(built.binaryPath,binary);
  const log=join(f.options.outputDirectory,'build.stdout.log'),original=await readFile(log);await writeFile(log,'tampered');await assert.rejects(verifyWindowServerBuild(verificationPins(built)),/log mismatch/);await writeFile(log,original);
  await rm(f.options.sdkPath,{recursive:true});await rm(f.options.compilerPath);assert.deepEqual(await verifyWindowServerBuild(verificationPins(built)),built);
  await writeFile(f.options.sourcePath,'changed source');await assert.rejects(verifyWindowServerBuild(verificationPins(built)),/source bytes mismatch/);
});

test('verifier authenticates retained SDK bytes and refuses a resealed escape or missing parent',async t=>{
  const f=await fixture(t),built=await buildWindowServerCollector(f.options),path=join(f.options.outputDirectory,'sdk-manifest.json'),original=await readFile(path);
  await writeFile(path,'{}');await assert.rejects(verifyWindowServerBuild(verificationPins(built)),/SDK manifest identity mismatch/);await writeFile(path,original);
  for(const mode of ['escape','missing-parent']){
    const manifest=JSON.parse(original);
    if(mode==='escape')manifest.entries.push({path:'Escape',type:'link',mode:0o777,target:'../sdk/stdlib'});
    else manifest.entries=manifest.entries.filter(row=>row.path!=='stdlib');
    manifest.entries=ordered(manifest.entries);const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');await writeFile(path,bytes);
    const changed=await rewriteReceipt(built,receipt=>{
      receipt.sdk.manifest={bytes:bytes.length,sha256:sha(bytes)};receipt.sdk.entryCount=manifest.entries.length;
      receipt.pins.sdkTreeDigest=receipt.sdk.beforeDigest=receipt.sdk.afterDigest=sdkDigest(manifest.entries);
    });
    await assert.rejects(verifyWindowServerBuild(verificationPins(changed)),mode==='escape'?/SDK link escapes root/:/no physical parent/);
  }
});

test('campaign verification has its own explicit cancellation and deadline bounds',async t=>{
  const f=await fixture(t),built=await buildWindowServerCollector(f.options),controller=new AbortController();controller.abort('verification cancelled');
  await assert.rejects(verifyWindowServerBuild(verificationPins(built),{abortSignal:controller.signal,timeoutMs:1000}),/verification cancelled/);
  await assert.rejects(verifyWindowServerBuild(verificationPins(built),{timeoutMs:60_001}),/verification timeout/);
  await assert.rejects(verifyWindowServerBuild(verificationPins(built),{qualification:true}),/verification options/);
  await assert.rejects(verifyWindowServerBuild({...verificationPins(built),qualification:true}),/verification inputs/);
  await assert.rejects(verifyWindowServerBuild(built),/verification inputs/);
  assert.deepEqual(await verifyWindowServerBuild(verificationPins(built),{timeoutMs:5000}),built);
});

test('verifier rejects a linked or nonexecutable collector even with original receipt pins',async t=>{
  const f=await fixture(t),built=await buildWindowServerCollector(f.options);await chmod(built.binaryPath,0o600);await assert.rejects(verifyWindowServerBuild(verificationPins(built)),/private executable/);
  await chmod(built.binaryPath,0o700);const copy=join(f.root,'binary-copy');await writeFile(copy,await readFile(built.binaryPath),{mode:0o700});await rm(built.binaryPath);await symlink(copy,built.binaryPath);
  await assert.rejects(verifyWindowServerBuild(verificationPins(built)),/physical file/);
});


test('retained build evidence verifies after relocation and deletion of all original paths',async t=>{
  const f=await fixture(t),built=await buildWindowServerCollector(f.options);
  const retained=await retainWindowServerBuildEvidence(verificationPins(built),{directory:join(f.root,'evidence')});
  const manifest=JSON.parse(await readFile(retained.manifestPath));
  assert.deepEqual(manifest.members.map(member=>member.path),['build-receipt.json','collector.swift','sdk-manifest.json','version.stdout.log','version.stderr.log','build.stdout.log','build.stderr.log','windowserver-capture']);
  assert.equal(retained.manifestBytes,(await readFile(retained.manifestPath)).length);assert.equal(retained.receiptSha256,built.receiptSha256);assert.equal(retained.binarySha256,built.binarySha256);assert.equal(retained.qualification,false);
  assert.deepEqual(await verifyWindowServerBuildEvidence(evidencePins(retained)),retained);
  const destination=await mkdtemp(join(await realpath(tmpdir()),'windowserver-offline-control-'));await chmod(destination,0o700);t.after(()=>rm(destination,{recursive:true,force:true}));
  const relocated=join(destination,'evidence');await rename(retained.directory,relocated);await rm(f.root,{recursive:true});
  const result=await verifyWindowServerBuildEvidence({...evidencePins(retained),directory:relocated});
  assert.equal(result.binaryPath,join(relocated,'windowserver-capture'));assert.equal(result.manifestPath,join(relocated,'manifest.json'));assert.equal(result.binarySha256,built.binarySha256);
  const receipt=JSON.parse(await readFile(join(relocated,'build-receipt.json')));assert.equal(receipt.commands[0].cwd,f.options.outputDirectory);assert.equal(receipt.commands[1].args.at(-1),join(f.options.outputDirectory,'collector.swift'));
});

test('offline evidence rejects changed fixed members, unexpected members and linked members',async t=>{
  const f=await fixture(t),built=await buildWindowServerCollector(f.options),retained=await retainWindowServerBuildEvidence(verificationPins(built),{directory:join(f.root,'evidence')});
  const manifest=JSON.parse(await readFile(retained.manifestPath));
  for(const member of manifest.members){
    const path=join(retained.directory,member.path),original=await readFile(path);await writeFile(path,Buffer.concat([original,Buffer.from('changed')]));
    await assert.rejects(verifyWindowServerBuildEvidence(evidencePins(retained)),/member mismatch/);await writeFile(path,original);
  }
  const extra=join(retained.directory,'unlisted');await writeFile(extra,'extra');await assert.rejects(verifyWindowServerBuildEvidence(evidencePins(retained)),/inventory/);await rm(extra);
  const source=join(retained.directory,'collector.swift'),bytes=await readFile(source);await rm(source);await symlink(f.options.sourcePath,source);
  await assert.rejects(verifyWindowServerBuildEvidence(evidencePins(retained)),/physical file/);await rm(source);await writeFile(source,bytes,{mode:0o600});
  assert.deepEqual(await verifyWindowServerBuildEvidence(evidencePins(retained)),retained);
});

test('a resealed evidence manifest cannot widen member paths or qualification scope',async t=>{
  const f=await fixture(t),built=await buildWindowServerCollector(f.options),retained=await retainWindowServerBuildEvidence(verificationPins(built),{directory:join(f.root,'evidence')}),original=await readFile(retained.manifestPath);
  for(const change of [manifest=>manifest.qualification=true,manifest=>manifest.members[0].path='../build-receipt.json',manifest=>manifest.members.pop(),manifest=>manifest.members[1]=manifest.members[0]]){
    const manifest=JSON.parse(original);change(manifest);const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');await writeFile(retained.manifestPath,bytes);
    await assert.rejects(verifyWindowServerBuildEvidence({...evidencePins(retained),manifestSha256:sha(bytes)}));
  }
});

test('resealed source or receipt copies must still satisfy the original observed build contract',async t=>{
  const f=await fixture(t),built=await buildWindowServerCollector(f.options),retained=await retainWindowServerBuildEvidence(verificationPins(built),{directory:join(f.root,'evidence')}),originalManifest=await readFile(retained.manifestPath);
  for(const mode of ['source','receipt']){
    const manifest=JSON.parse(originalManifest),name=mode==='source'?'collector.swift':'build-receipt.json',path=join(retained.directory,name),original=await readFile(path);
    let bytes;if(mode==='source')bytes=Buffer.from('altered retained source');else{const receipt=JSON.parse(original);receipt.commands[1].args.push('-unreviewed');bytes=Buffer.from(JSON.stringify(receipt,null,2)+'\n');manifest.receiptSha256=sha(bytes);}
    await writeFile(path,bytes);const member=manifest.members.find(row=>row.path===name);member.bytes=bytes.length;member.sha256=sha(bytes);
    const manifestBytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');await writeFile(retained.manifestPath,manifestBytes);
    await assert.rejects(verifyWindowServerBuildEvidence({...evidencePins(retained),manifestSha256:sha(manifestBytes)}),mode==='source'?/source bytes mismatch/:/argv mismatch/);
    await writeFile(path,original);await writeFile(retained.manifestPath,originalManifest);
  }
});

test('retention preserves existing directories and applies independent abort and option guards',async t=>{
  const f=await fixture(t),built=await buildWindowServerCollector(f.options),directory=join(f.root,'evidence');await mkdir(directory,{mode:0o700});const marker=join(directory,'marker');await writeFile(marker,'keep');
  await assert.rejects(retainWindowServerBuildEvidence(verificationPins(built),{directory}),/EEXIST/);assert.equal(await readFile(marker,'utf8'),'keep');
  const fresh=join(f.root,'cancelled'),controller=new AbortController();controller.abort('retention cancelled');
  await assert.rejects(retainWindowServerBuildEvidence(verificationPins(built),{directory:fresh,abortSignal:controller.signal}),/retention cancelled/);await assert.rejects(lstat(fresh),{code:'ENOENT'});
  await assert.rejects(retainWindowServerBuildEvidence({...verificationPins(built),qualification:true},{directory:fresh}),/retention inputs/);
  await assert.rejects(retainWindowServerBuildEvidence(verificationPins(built),{directory:fresh,qualification:true}),/retention options/);
  await assert.rejects(verifyWindowServerBuildEvidence({directory,manifestSha256:'0'.repeat(64),sourceSha256:built.sourceSha256,qualification:true}),/build evidence inputs/);
  await assert.rejects(verifyWindowServerBuildEvidence({directory,manifestSha256:'0'.repeat(64),sourceSha256:built.sourceSha256},{timeoutMs:60_001}),/verification timeout/);
});


test('explicit SDK inspection uses the same complete tree pin without creating output or invoking compiler',async t=>{
  const f=await fixture(t,{mode:'exit'});await f.link('!Alias','stdlib');const before=(await readdir(f.root)).sort();
  const observed=await inspectWindowServerSdk({sdkPath:f.options.sdkPath,timeoutMs:5000});
  const manifestBytes=Buffer.from(JSON.stringify({kind:'windowserver-sdk-tree-1',entries:ordered(f.rows)},null,2)+'\n');
  assert.deepEqual(observed,{sdkPath:f.options.sdkPath,sdkTreeDigest:f.options.sdkTreeDigest,entryCount:f.rows.length,manifestBytes:manifestBytes.length,manifestSha256:sha(manifestBytes),qualification:false});
  assert.deepEqual((await readdir(f.root)).sort(),before);await assert.rejects(lstat(f.options.outputDirectory),{code:'ENOENT'});
});

test('SDK inspection requires an explicit finite deadline and rejects cancellation, links and extra flags',async t=>{
  const f=await fixture(t),inputs={sdkPath:f.options.sdkPath,timeoutMs:5000},controller=new AbortController();controller.abort('SDK inspection cancelled');
  await assert.rejects(inspectWindowServerSdk({...inputs,abortSignal:controller.signal}),/SDK inspection cancelled/);
  await assert.rejects(inspectWindowServerSdk({sdkPath:f.options.sdkPath}),/SDK inspection options/);
  await assert.rejects(inspectWindowServerSdk({...inputs,timeoutMs:30*60_000+1}),/build timeout/);
  await assert.rejects(inspectWindowServerSdk({...inputs,qualification:true}),/SDK inspection options/);
  await symlink(f.options.sdkPath,join(f.root,'SDK-alias'));await assert.rejects(inspectWindowServerSdk({...inputs,sdkPath:join(f.root,'SDK-alias')}),/physical directory/);
  await f.link('Escape','../sdk/stdlib');await assert.rejects(inspectWindowServerSdk(inputs),/SDK link escapes root/);
});
