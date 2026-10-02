// File evidence binding tests only. All receipts are visibly fabricated contract
// data in isolated temp roots. Issuer API and guarded CLI tests write only
// fabricated isolated capsules; no actual image qualification, adoption or
// production inventory change occurs.
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {copyFileSync,existsSync,linkSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,symlinkSync,unlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {PNG_ROLES,PNG_SOURCE_PATHS,PNG_HOST_SOURCE_PATHS,pngDigest,pngReceiptReferences,validatePNGSource,validatePNGProducerSource} from '../../tooling/raster/import-issuance/png-contract.mjs';
import {canonicalStringify,makePNGFixture,syncPNGFixture,writePNGFixture} from './png-issuer-fixtures.mjs';

const bytes=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
function corrupt(path){const original=readFileSync(path),changed=Buffer.from(original);assert(changed.length>0);changed[0]^=1;writeFileSync(path,changed);return original;}
async function setup(t,mutate=()=>{}){
  const root=mkdtempSync(join(realpathSync(tmpdir()),'png-issuer-contract-only-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const readerRoot=join(root,'reader');
  // Assemble actual repository reader and issuer modules unchanged so their
  // source-relative imports resolve inside this disposable test root.
  const modules=[
    ['import-issuance/png-contract.mjs',new URL('../../tooling/raster/import-issuance/png-contract.mjs',import.meta.url)],
    ['import-issuance/png-evidence.mjs',new URL('../../tooling/raster/import-issuance/png-evidence.mjs',import.meta.url)],
    ['import-issuance/issue-png-profile.mjs',new URL('../../tooling/raster/import-issuance/issue-png-profile.mjs',import.meta.url)],
    ['import-seals/authority.mjs',new URL('../../tooling/raster/import-seals/authority.mjs',import.meta.url)],
    ['import-seals/files.mjs',new URL('../../tooling/raster/import-seals/files.mjs',import.meta.url)],
    ['import-seals/pinned-canonical-source.mjs',new URL('../../tooling/raster/import-seals/pinned-canonical-source.mjs',import.meta.url)],
  ];
  for(const [path,url]of modules){const target=join(readerRoot,'tooling/raster',path);mkdirSync(dirname(target),{recursive:true,mode:0o700});copyFileSync(fileURLToPath(url),target);}
  const {readPNGQualification}=await import(pathToFileURL(join(readerRoot,'tooling/raster/import-issuance/png-evidence.mjs')).href);
  const fixture=makePNGFixture();mutate(fixture);syncPNGFixture(fixture);
  const sourceRoot=join(root,'source');mkdirSync(sourceRoot,{mode:0o700});const args=writePNGFixture(sourceRoot,fixture);
  const read=(overrides={})=>{validatePNGSource(fixture.source,canonicalStringify);validatePNGProducerSource(fixture.source,fixture.producerManifest,fixture.producerManifestHash);return readPNGQualification({...args,...overrides});};
  const receiptPath=role=>join(dirname(args.qualificationPath),fixture.qualification.evidence.find(ref=>ref.role===role).path);
  const leafPath=(role,ref)=>join(dirname(receiptPath(role)),ref.path);
  return{root,readerRoot,fixture,args,read,receiptPath,leafPath};
}

test('reader binds every real file and returns the checked immutable byte identities',async t=>{
  const f=await setup(t),result=f.read();assert.equal(result.sourceFiles.length,PNG_SOURCE_PATHS.length);assert.deepEqual([...result.receipts.keys()],PNG_ROLES);
  assert.deepEqual(result.hostSourceFiles.map(item=>item.ref.path),PNG_HOST_SOURCE_PATHS);
  for(const item of result.hostSourceFiles){const actual=readFileSync(item.sourcePath);assert.equal(item.ref.bytes,actual.length);assert.equal(item.ref.hash,pngDigest(actual));}
  const expected=new Set();
  for(const role of PNG_ROLES){const receiptRef=f.fixture.qualification.evidence.find(ref=>ref.role===role);expected.add(result.qualification.ref.hash+'\n'+receiptRef.path);for(const ref of pngReceiptReferences(role,f.fixture.receipts.get(role)))expected.add(receiptRef.hash+'\n'+ref.path);}
  assert.equal(result.records.length,expected.size);assert.deepEqual(new Set(result.records.map(row=>row.parentHash+'\n'+row.originalReference)),expected);
  for(const record of result.records){const actual=readFileSync(record.sourcePath);assert.equal(record.ref.bytes,actual.length);assert.equal(record.ref.hash,pngDigest(actual));}
  assert.match(f.fixture.receipts.get('pixels').environment.os,/CONTRACT TEST ONLY/);
});
test('same-length mutation of any retained runtime source is refused',async t=>{
  const f=await setup(t);for(const path of PNG_SOURCE_PATHS){const target=join(f.args.sourceRoot,path),original=corrupt(target);assert.throws(()=>f.read(),/source changed|deep-equal/i);writeFileSync(target,original);}
  assert.doesNotThrow(()=>f.read());
});
test('source disappearance refuses before evidence can qualify another snapshot',async t=>{const f=await setup(t);unlinkSync(join(f.args.sourceRoot,PNG_SOURCE_PATHS[0]));assert.throws(()=>f.read());});
test('source symlinks are refused even when target bytes are identical',async t=>{
  const f=await setup(t),target=join(f.args.sourceRoot,PNG_SOURCE_PATHS[0]),retained=join(f.root,'same-source.txt');writeFileSync(retained,readFileSync(target));unlinkSync(target);symlinkSync(retained,target);assert.throws(()=>f.read(),/singly linked|regular|link/i);
});
test('hardlinked source aliases are refused even with exact bytes',async t=>{const f=await setup(t),target=join(f.args.sourceRoot,PNG_SOURCE_PATHS[0]);linkSync(target,join(f.root,'source-alias'));assert.throws(()=>f.read(),/singly linked|regular|link/i);});
test('a changed receipt file cannot retain the old qualification reference',async t=>{
  const f=await setup(t),path=f.receiptPath('pixels'),original=readFileSync(path),receipt=JSON.parse(original);receipt.environment.os+=' changed';writeFileSync(path,bytes(receipt));assert.throws(()=>f.read());assert.notDeepEqual(readFileSync(path),original);
});
test('a receipt with only different whitespace still requires its new exact file hash',async t=>{const f=await setup(t),path=f.receiptPath('pixels');writeFileSync(path,Buffer.concat([readFileSync(path),Buffer.from('\n')]));assert.throws(()=>f.read());});
test('a removed receipt does not become an empty successful role',async t=>{const f=await setup(t);unlinkSync(f.receiptPath('durability'));assert.throws(()=>f.read());});
test('a changed retained log is refused even when all numeric summaries pass',async t=>{const f=await setup(t);corrupt(f.leafPath('resources',f.fixture.receipts.get('resources').logs[0]));assert.throws(()=>f.read(),/evidence bytes changed|deep-equal/i);});
for(const role of ['pixels','color-orientation-cp1','resources']){
  for(const field of ['fixture','actual','expected'])test(role+': changed '+field+' bytes refuse a matching metadata summary',async t=>{
    const f=await setup(t),r=f.fixture.receipts.get(role),row=role==='resources'?r.jobs[0]:r.cases[0];corrupt(f.leafPath(role,row[field]));assert.throws(()=>f.read(),/evidence bytes changed|deep-equal/i);
  });
}
test('changed oracle source bytes are bound, not just actual and expected pixels',async t=>{const f=await setup(t);corrupt(f.leafPath('pixels',f.fixture.receipts.get('pixels').cases[0].oracle.source));assert.throws(()=>f.read());});
test('changed durability observations cannot support an unchanged passed case',async t=>{const f=await setup(t);corrupt(f.leafPath('durability',f.fixture.receipts.get('durability').cases[0].observations[0]));assert.throws(()=>f.read());});
test('unsupported-depth before and after originals are both bound',async t=>{
  const f=await setup(t),row=f.fixture.receipts.get('pixels').refusals[0];for(const ref of [row.fixture,row.originalAfter]){const path=f.leafPath('pixels',ref),original=corrupt(path);assert.throws(()=>f.read());writeFileSync(path,original);}assert.doesNotThrow(()=>f.read());
});
test('symlinked evidence is refused even if the linked file has the advertised hash',async t=>{
  const f=await setup(t),ref=f.fixture.receipts.get('pixels').cases[0].actual,path=f.leafPath('pixels',ref),copy=join(f.root,'actual-copy');writeFileSync(copy,readFileSync(path));unlinkSync(path);symlinkSync(copy,path);assert.throws(()=>f.read(),/singly linked|regular|link/i);
});
test('a symlinked evidence parent directory is refused',async t=>{
  const f=await setup(t),ref=f.fixture.receipts.get('pixels').logs[0],path=f.leafPath('pixels',ref),logs=dirname(path),replacement=join(f.root,'log-copy');mkdirSync(replacement);for(const role of PNG_ROLES)copyFileSync(join(logs,role+'.log'),join(replacement,role+'.log'));rmSync(logs,{recursive:true});symlinkSync(replacement,logs);assert.throws(()=>f.read(),/parent|directory|link/i);
});
test('source manifest identity is independently bound across every receipt',async t=>{const f=await setup(t);assert.throws(()=>f.read({sourceManifestHash:pngDigest('unreviewed source manifest bytes')}));});
test('real file evidence still refuses cross-platform authority',async t=>{const f=await setup(t);assert.throws(()=>f.read({baseCodecAuthority:{...f.args.baseCodecAuthority,platform:'linux',arch:'x64'}}),/authority/);});
test('correctly rehashed receipt files still refuse incorrect operation counts',async t=>{const f=await setup(t,fixture=>{fixture.receipts.get('resources').completedOperations++;});assert.throws(()=>f.read());});
test('correctly rehashed receipt files still refuse empty cases',async t=>{const f=await setup(t,fixture=>{const r=fixture.receipts.get('durability');r.cases=[];r.completedCases=0;r.completedChecks=0;});assert.throws(()=>f.read());});
test('correctly rehashed receipt files still refuse a one-byte resource overage',async t=>{const f=await setup(t,fixture=>{const r=fixture.receipts.get('resources');r.jobs[0].maxRSSBytes=r.capBytes+1;r.maxRSSBytes=r.capBytes+1;});assert.throws(()=>f.read());});
test('a correctly hashed log one byte beyond the8MiB retained bound is refused',async t=>{
  const f=await setup(t,fixture=>{const r=fixture.receipts.get('resources'),ref=r.logs[0],body=Buffer.alloc(8*1048576+1,33);ref.bytes=body.length;ref.hash=pngDigest(body);fixture.files.set('contract-test-only/receipts/'+ref.path,body);});assert.throws(()=>f.read());
});
test('a forged relative ref cannot leave the receipt parent',async t=>{const f=await setup(t,fixture=>{fixture.receipts.get('pixels').logs[0].path='../../outside.log';});assert.throws(()=>f.read());});
test('a ref cannot silently redirect to a different retained file with different bytes',async t=>{
  const f=await setup(t,fixture=>{const r=fixture.receipts.get('pixels');r.cases[0].actual.path=r.cases[0].fixture.path;});assert.throws(()=>f.read());
});
test('returned records preserve the originally checked hash after later file mutation',async t=>{
  const f=await setup(t),result=f.read(),ref=f.fixture.receipts.get('pixels').logs[0],path=f.leafPath('pixels',ref),record=result.records.find(row=>row.sourcePath===path),before={...record.ref};corrupt(path);assert.deepEqual(record.ref,before);assert.notEqual(pngDigest(readFileSync(path)),record.ref.hash);assert.throws(()=>f.read());
});

const hostOnlyPaths=PNG_HOST_SOURCE_PATHS.filter(path=>!PNG_SOURCE_PATHS.includes(path));
test('same-length changes to each host-only implementation refuse the current qualification',async t=>{
  const f=await setup(t);assert.equal(hostOnlyPaths.length,12);
  for(const path of hostOnlyPaths){const target=join(f.args.sourceRoot,path),original=corrupt(target);assert.throws(()=>f.read(),/qualified host changed|deep-equal/i);writeFileSync(target,original);}
  assert.doesNotThrow(()=>f.read());
});
test('missing host-only implementation bytes cannot reuse unchanged producer source qualification',async t=>{
  const f=await setup(t);unlinkSync(join(f.args.sourceRoot,hostOnlyPaths[0]));assert.throws(()=>f.read());
});
test('host source symlinks refuse even when bytes match the qualified identity',async t=>{
  const f=await setup(t),path=join(f.args.sourceRoot,hostOnlyPaths[0]),copy=join(f.root,'host-copy');writeFileSync(copy,readFileSync(path));unlinkSync(path);symlinkSync(copy,path);assert.throws(()=>f.read(),/singly linked|regular|link/i);
});
test('host source hardlinks refuse even when bytes match the qualified identity',async t=>{
  const f=await setup(t),path=join(f.args.sourceRoot,hostOnlyPaths[0]);linkSync(path,join(f.root,'host-alias'));assert.throws(()=>f.read(),/singly linked|regular|link/i);
});
test('rehashing a false host file byte identity does not bypass the current source check',async t=>{
  const f=await setup(t,fixture=>{
    fixture.qualification.hostSourceFiles.find(row=>row.repositoryPath===hostOnlyPaths[0]).hash=pngDigest('fabricated replacement host bytes');
    fixture.qualification.hostSourceHash=pngDigest(canonicalStringify(fixture.qualification.hostSourceFiles));
    for(const receipt of fixture.receipts.values())receipt.hostSourceHash=fixture.qualification.hostSourceHash;
  });assert.throws(()=>f.read(),/qualified host changed|deep-equal/i);
});
test('retained host identities remain the checked values after later current source mutation',async t=>{
  const f=await setup(t),result=f.read(),item=result.hostSourceFiles.find(item=>item.ref.path===hostOnlyPaths[0]),before={...item.ref};corrupt(item.sourcePath);assert.deepEqual(item.ref,before);assert.notEqual(pngDigest(readFileSync(item.sourcePath)),item.ref.hash);assert.throws(()=>f.read());
});
for(const role of PNG_ROLES)test(role+': correctly rehashed receipt bytes cannot hide a different host source hash',async t=>{
  const f=await setup(t,fixture=>{fixture.receipts.get(role).hostSourceHash=pngDigest('another host campaign');});assert.throws(()=>f.read());
});

// The API packages only visibly fabricated evidence in a disposable test root.
// No CLI, generated inventory, native binary, or repository vendor tree is used.
async function setupIssuer(t,mutate=()=>{}){
  const f=await setup(t,mutate),producerRoot=join(f.root,'producer'),evidenceRoot=join(f.root,'evidence');
  mkdirSync(producerRoot,{mode:0o700});mkdirSync(evidenceRoot,{mode:0o700});
  writeFileSync(join(producerRoot,'png-source.json'),f.fixture.files.get(f.fixture.sourceManifestPath),{mode:0o600,flag:'wx'});
  writeFileSync(join(producerRoot,'png-source-manifest.json'),f.fixture.files.get(f.fixture.producerManifestPath),{mode:0o600,flag:'wx'});
  for(const [path,body]of f.fixture.files){
    if(!path.startsWith('contract-test-only/'))continue;
    const target=join(evidenceRoot,path.slice('contract-test-only/'.length));mkdirSync(dirname(target),{recursive:true,mode:0o700});writeFileSync(target,body,{mode:0o600,flag:'wx'});
  }
  const {issuePNGProfile}=await import(pathToFileURL(join(f.readerRoot,'tooling/raster/import-issuance/issue-png-profile.mjs')).href);
  const issuerArgs={sourceRoot:f.args.sourceRoot,producerRoot,qualificationPath:join(evidenceRoot,'qualification.json'),output:join(f.root,'capsule'),canonicalStringify};
  const issue=(overrides={})=>issuePNGProfile({...issuerArgs,...overrides});
  const fingerprintInputs=()=>({
    sourceFiles:[...f.fixture.files.keys()].map(path=>[path,pngDigest(readFileSync(join(f.args.sourceRoot,path)))]),
    producerFiles:readdirSync(producerRoot).sort().map(path=>[path,pngDigest(readFileSync(join(producerRoot,path)))]),
    evidenceFiles:[...f.fixture.files.keys()].filter(path=>path.startsWith('contract-test-only/')).map(path=>[path,pngDigest(readFileSync(join(evidenceRoot,path.slice('contract-test-only/'.length))))]),
    directories:[f.args.sourceRoot,producerRoot,evidenceRoot].map(path=>readdirSync(path,{recursive:true}).sort()),
  });
  return{...f,producerRoot,evidenceRoot,issuerArgs,issue,fingerprintInputs};
}
test('issuer captures exact current host bytes and qualification-specific vendor identity',async t=>{
  const f=await setupIssuer(t),before=f.fingerprintInputs(),result=f.issue();
  const qHash=pngDigest(readFileSync(f.issuerArgs.qualificationPath)),q=f.fixture.qualification;
  assert.equal(result.qualificationHash,qHash);
  assert.equal(result.vendorPath,'vendor/raster/png-import/'+q.sourceHash.slice(7)+'/'+q.platform+'-'+q.arch+'/'+qHash.slice(7));
  const adoption=JSON.parse(readFileSync(join(result.output,'adoption.json'),'utf8'));
  for(const row of q.hostSourceFiles){
    const path='host-source-inputs/'+row.repositoryPath,captured=readFileSync(join(result.output,path)),ref=adoption.files.find(ref=>ref.path===path);
    assert.deepEqual(ref,{path,bytes:row.bytes,hash:row.hash});assert.equal(captured.length,row.bytes);assert.equal(pngDigest(captured),row.hash);assert.deepEqual(captured,readFileSync(join(f.args.sourceRoot,row.repositoryPath)));
  }
  assert.deepEqual(f.fingerprintInputs(),before);
});
test('issuer refuses changed current host-only bytes before creating any output directory',async t=>{
  const f=await setupIssuer(t);corrupt(join(f.args.sourceRoot,hostOnlyPaths[0]));assert.throws(()=>f.issue(),/qualified host changed|deep-equal/i);assert.equal(existsSync(f.issuerArgs.output),false);
});
test('issuer refuses changed producer code before creating any output directory',async t=>{
  const f=await setupIssuer(t);corrupt(join(f.args.sourceRoot,'tooling/raster/import-issuance/issue-png-profile.mjs'));assert.throws(()=>f.issue(),/Issuer dependency changed|deep-equal/i);assert.equal(existsSync(f.issuerArgs.output),false);
});
for(const input of ['sourceRoot','producerRoot','evidenceRoot'])test('issuer refuses output nested inside '+input+' before mkdir',async t=>{
  const f=await setupIssuer(t),root=input==='sourceRoot'?f.args.sourceRoot:f[input],output=join(root,'must-not-be-created'),before=f.fingerprintInputs();
  assert.equal(existsSync(output),false);assert.throws(()=>f.issue({output}),/input and output trees must not overlap/);assert.equal(existsSync(output),false);assert.deepEqual(f.fingerprintInputs(),before);
});
for(const input of ['sourceRoot','producerRoot','evidenceRoot'])test('issuer refuses replacing the existing '+input,async t=>{
  const f=await setupIssuer(t),output=input==='sourceRoot'?f.args.sourceRoot:f[input],before=f.fingerprintInputs();assert.throws(()=>f.issue({output}),/output must be fresh/);assert.deepEqual(f.fingerprintInputs(),before);
});
test('issuer refuses an output ancestor of all input trees without changing them',async t=>{
  const f=await setupIssuer(t),before=f.fingerprintInputs();assert.throws(()=>f.issue({output:f.root}),/output must be fresh|must not overlap/);assert.deepEqual(f.fingerprintInputs(),before);
});
test('issuer resolves dot segments before refusing output within a reviewed source tree',async t=>{
  const f=await setupIssuer(t),output=f.args.sourceRoot+'/server/../must-not-be-created',before=f.fingerprintInputs();assert.throws(()=>f.issue({output}),/must not overlap/);assert.equal(existsSync(join(f.args.sourceRoot,'must-not-be-created')),false);assert.deepEqual(f.fingerprintInputs(),before);
});
test('issuer refuses a symlink parent that aliases reviewed source bytes before mkdir',async t=>{
  const f=await setupIssuer(t),alias=join(f.root,'source-alias'),before=f.fingerprintInputs();symlinkSync(f.args.sourceRoot,alias);assert.throws(()=>f.issue({output:join(alias,'must-not-be-created')}),/parent|directory|link/i);assert.equal(existsSync(join(f.args.sourceRoot,'must-not-be-created')),false);assert.deepEqual(f.fingerprintInputs(),before);
});
test('issuer permits a disjoint sibling whose name shares the source directory prefix',async t=>{
  const f=await setupIssuer(t),output=f.args.sourceRoot+'-capsule',before=f.fingerprintInputs(),result=f.issue({output});assert.equal(result.output,output);assert.equal(existsSync(join(output,'adoption.json')),true);assert.deepEqual(f.fingerprintInputs(),before);
});
test('different exact accepted qualification bytes produce disjoint vendor paths for the same source and platform',async t=>{
  const first=await setupIssuer(t),second=await setupIssuer(t,fixture=>{fixture.receipts.get('pixels').environment.os+=' Second contract-only receipt serialization.';}),a=first.issue(),b=second.issue();
  assert.equal(first.fixture.source.sourceHash,second.fixture.source.sourceHash);assert.equal(first.fixture.qualification.hostSourceHash,second.fixture.qualification.hostSourceHash);assert.notEqual(a.qualificationHash,b.qualificationHash);assert.notEqual(a.vendorPath,b.vendorPath);
  assert.equal(a.vendorPath.split('/').slice(0,-1).join('/'),b.vendorPath.split('/').slice(0,-1).join('/'));
});


test('PNG issuer CLI loads the exact bound TypeScript source under pinned Node26',async t=>{
 const f=await setupIssuer(t);
 for(const name of ['png-source.json','png-source-manifest.json'])copyFileSync(join(f.producerRoot,name),join(f.readerRoot,'tooling/raster/import-issuance',name));
 const before=f.fingerprintInputs();
 const result=spawnSync(process.execPath,['--import',fileURLToPath(new URL('../session/no-egress.mjs',import.meta.url)),join(f.readerRoot,'tooling/raster/import-issuance/issue-png-profile.mjs'),f.args.sourceRoot,f.issuerArgs.qualificationPath,f.issuerArgs.output],{cwd:f.root,encoding:'utf8',timeout:30000});
 assert.equal(result.error,undefined);assert.equal(result.signal,null);assert.equal(result.status,0,result.stderr);
 const observed=JSON.parse(result.stdout.trim());assert.equal(observed.output,f.issuerArgs.output);assert.equal(observed.qualificationHash,pngDigest(readFileSync(f.issuerArgs.qualificationPath)));
 assert.equal(existsSync(join(observed.output,'adoption.json')),true);assert.deepEqual(f.fingerprintInputs(),before);
});
