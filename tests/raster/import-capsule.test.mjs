import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {existsSync,linkSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname,join,relative,resolve} from 'node:path';
import {verifyImportCapsule,completeImportCapsule,stageImportAdoption,readImportInventory,verifyImportInventory} from '../../tooling/raster/import-seals/capsule.mjs';
import {hostSourcePaths,nativeProducerHash,jpegProducerAuthority} from '../../tooling/raster/import-seals/native-contract.mjs';
import {PNG_CASES,PNG_REFUSALS,PNG_SOURCE_PATHS,PNG_ISSUER_PATHS} from '../../tooling/raster/import-issuance/png-contract.mjs';

// These are deliberately synthetic contract-test receipts. Their small byte
// fixtures exercise retention and identity checks; no image work or resource
// observation is performed, no native qualification is fabricated, and the
// fixtures never enter the real application's issued inventory.
const repository=resolve(import.meta.dirname,'../..');
const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const identity=path=>{const bytes=readFileSync(path);return {bytes:bytes.length,hash:hash(bytes)};};
// Independent encoding for this fixture's ASCII-only, finite JSON values.
function canonical(value){
 if(value===null||typeof value==='boolean'||typeof value==='number')return JSON.stringify(value);
 if(typeof value==='string'){assert(!/[\u0000-\u001f\u007f-\uffff]/.test(value));return JSON.stringify(value);}
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 return '{'+Object.keys(value).sort().map(key=>canonical(key)+':'+canonical(value[key])).join(',')+'}';
}
const json=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
function put(directory,path,bytes){const target=join(directory,path);mkdirSync(dirname(target),{recursive:true,mode:0o700});writeFileSync(target,bytes,{flag:'wx',mode:0o600});return {path,...identity(target)};}
function putJSON(directory,path,value){return put(directory,path,json(value));}
function rewriteJSON(directory,path,value){writeFileSync(join(directory,path),json(value),{mode:0o600});return {path,...identity(join(directory,path))};}
const inventoryPath='server/raster/import-inventory.ts';
const inventoryPrefix='// Generated only by the reviewed import-capsule adoption overlay. Empty means\n// unavailable. Historical profiles and capsule manifests are append-only.\nexport const IMPORT_INVENTORY = ';
const emptyInventory={schemaVersion:1,capsules:[],profiles:[],activeProfiles:[],jpeg:[],webp:[]};
const inventoryBytes=(value,indent=2)=>inventoryPrefix+JSON.stringify(value,null,indent)+' as const;\n';
function tree(directory){
 const files=[];
 function visit(path){for(const name of readdirSync(path).sort()){const full=join(path,name),entry=lstatSync(full);if(entry.isDirectory())visit(full);else{assert(entry.isFile()&&!entry.isSymbolicLink());files.push({path:relative(directory,full),...identity(full)});}}}
 visit(directory);return files;
}
function absentOutput(path){assert.equal(existsSync(join(path,'new',inventoryPath)),false,'Refusal must not publish a proposed inventory');assert.equal(existsSync(join(path,'integration-manifest.json')),false,'Refusal must not publish an adoption receipt');}
const requiredSources=[...PNG_SOURCE_PATHS];
const requiredHostSources=hostSourcePaths('png-scanline-file-cp1-v1');

function fixture(t,{previous=null,pixel=[13,27,91,127]}={}){
 const home=previous?.home??mkdtempSync(join(realpathSync(tmpdir()),'import-capsule-contract-'));
 if(!previous)t.after(()=>rmSync(home,{recursive:true,force:true}));
 const root=previous?.root??join(home,'root'),capsule=join(home,previous?'capsule-next':'capsule'),evidenceRoot=join(home,previous?'external-evidence-next':'external-evidence');
 for(const dir of [...(previous?[]:[root]),capsule,evidenceRoot])mkdirSync(dir,{mode:0o700});
 const authorityPaths=['server/raster/codec-platform.ts','server/raster/identity.ts'];
 if(!previous){
  for(const path of new Set([...authorityPaths,...requiredSources,...requiredHostSources,...PNG_ISSUER_PATHS]))put(root,path,readFileSync(join(repository,path)));
  put(root,inventoryPath,inventoryBytes(emptyInventory));
 }
 const authoritySource=readFileSync(join(root,'server/raster/identity.ts'),'utf8');
 const baseCodec=/export const CODEC_ID = ['"](sha256:[a-f0-9]{64})['"]/.exec(authoritySource)[1];
 const baseCodecAuthority={codecId:baseCodec,platform:'darwin',arch:'arm64',inputs:authorityPaths.map(path=>({path,...identity(join(root,path))}))};
 const definition={schemaVersion:1,kind:'png-import-source-definition-v1',transport:'png-scanline-file-cp1-v1',mediaType:'image/png',pixelPipeline:'cp1-f64-triangle-area-v1',kernel:'triangle-area-source-axis-row-norm-v1',color:'fixed-srgb-p3-orientation-v1',files:[...requiredSources].sort().map(path=>({path,...identity(join(root,path))}))};
 const sourceHash=hash(canonical(definition)),producer={schemaVersion:1,kind:'png-import-issuer-source-v1',sourceHash,files:PNG_ISSUER_PATHS.map(path=>({path,...identity(join(root,path))}))};
 const producerBytes=json(producer),source={schemaVersion:1,kind:'png-import-source-v1',sourceHash,producerSourceHash:hash(producerBytes),definition};
 const files=[putJSON(capsule,'source.json',source)],sourceManifestHash=files[0].hash;
 files.push(put(capsule,'producer-source-manifest.json',producerBytes));
 for(const ref of producer.files)files.push(put(capsule,'producer-inputs/'+ref.path,readFileSync(join(root,ref.path))));
 for(const ref of definition.files)files.push(put(capsule,'source-inputs/'+ref.path,readFileSync(join(root,ref.path))));
 const hostSourceFiles=requiredHostSources.map(repositoryPath=>({repositoryPath,...identity(join(root,repositoryPath))})),hostSourceHash=hash(canonical(hostSourceFiles));
 for(const ref of hostSourceFiles)files.push(put(capsule,'host-source-inputs/'+ref.repositoryPath,readFileSync(join(root,ref.repositoryPath))));
 const common={schemaVersion:1,status:'passed',sourceHash:source.sourceHash,sourceManifestHash,producerSourceHash:source.producerSourceHash,baseCodec,platform:'darwin',arch:'arm64',hostSourceHash,environment:{node:'26.10.0',platform:'darwin',arch:'arm64',execution:'native',os:'synthetic contract-test environment; no observation'}};
 const receipts=[],retained=[],leafFiles=[];
 for(const role of ['pixels','color-orientation-cp1','resources','durability']){
  const folder=role,leaf=(name,bytes)=>{const ref=put(evidenceRoot,folder+'/'+name,bytes);leafFiles.push(ref);return {path:name,bytes:ref.bytes,hash:ref.hash};};
  const logs=[leaf('run.log','Synthetic receipt fixture, not a record of execution.\n')];
  const observed=leaf('actual.rgba',Buffer.from(pixel)),expected=leaf('expected.rgba',Buffer.from(pixel));
  const original=leaf('original.data','Synthetic source identity fixture.'),oracle=leaf('oracle-source.txt','Independent authored RGBA fixture: '+pixel.join(',')+'.');
  let receipt;
  if(role==='resources'){
   const jobs=PNG_CASES.resources.map((name,index)=>({id:'synthetic-'+index,case:name,status:'completed',originalWidth:5001,originalHeight:5001,width:1,height:1,operation:name==='contended-crop'?'crop':'resize',fixture:original,actual:observed,expected,maxRSSBytes:16*1048576,admittedBytes:32*1048576,completedOperations:name==='repeated-resize'?3:1,maxConcurrentJobs:name==='contended-crop'?2:1,contentionObserved:name==='contended-crop',remainingAllocations:0,remainingScratchBytes:0}));
   receipt={...common,kind:'png-import-resources-v1',logs,measurement:'whole-process-rss',capBytes:512*1048576,maxRSSBytes:16*1048576,completedJobs:jobs.length,completedOperations:jobs.reduce((n,j)=>n+j.completedOperations,0),residualAllocations:0,residualScratchBytes:0,jobs};
  }else{
   const cases=PNG_CASES[role].map(id=>role==='durability'?{id,status:'passed-case',completedChecks:1,elapsedMs:0,observations:[oracle]}:{id,status:'passed-case',completedChecks:1,elapsedMs:0,originalWidth:id.startsWith('oversized-')?8193:1,originalHeight:1,width:1,height:1,fixture:original,actual:observed,expected,oracle:{kind:'independent-fixture',source:oracle}});
   receipt={...common,kind:'png-import-'+role+'-v1',logs,completedCases:cases.length,completedChecks:cases.length,cases};
   if(role==='pixels'){
    const originalAfter=leaf('original-after.data','Synthetic source identity fixture.');
    receipt.refusals=PNG_REFUSALS.map(id=>({id,status:'rejected-as-unsupported',code:'RASTER_DEPTH',completedChecks:1,elapsedMs:0,fixture:original,originalAfter,outputAbsent:true}));receipt.completedRefusals=receipt.refusals.length;
   }
  }
  // Qualifier paths are relative to qualification.json; leaf paths remain
  // relative to each original receipt. Captured names intentionally differ.
  const ref=putJSON(evidenceRoot,folder+'/receipt.json',receipt);receipts.push({role,ref,value:receipt});
 }
 const qualification={schemaVersion:1,kind:'png-import-cp1-qualification-v1',status:'accepted',sourceHash:source.sourceHash,sourceManifestHash,producerSourceHash:source.producerSourceHash,baseCodec,platform:'darwin',arch:'arm64',artifactHash:null,abiVersion:null,hostSourceFiles,hostSourceHash,evidence:receipts.map(({role,ref})=>({role,...ref}))};
 const qFile=putJSON(evidenceRoot,'qualification.json',qualification),qualificationHash=qFile.hash;
 files.push(put(capsule,'qualification.json',readFileSync(join(evidenceRoot,qFile.path))));
 function capture(parentHash,ref,originalPath){
  if(retained.some(row=>row.parentHash===parentHash&&row.originalReference===ref.path))return;
  const capturedPath='proofs/'+String(retained.length).padStart(4,'0')+(ref.path.endsWith('.json')?'.json':'.data'),bytes=readFileSync(originalPath);
  assert.equal(hash(bytes),ref.hash);files.push(put(capsule,capturedPath,bytes));retained.push({parentHash,originalReference:ref.path,capturedPath,bytes:bytes.length,hash:ref.hash});
 }
 for(const {ref,value,role}of receipts){
  capture(qualificationHash,ref,join(evidenceRoot,ref.path));
  const refs=role==='resources'?[...value.logs,...value.jobs.flatMap(row=>[row.fixture,row.actual,row.expected])]:role==='durability'?[...value.logs,...value.cases.flatMap(row=>row.observations)]:[...value.logs,...value.cases.flatMap(row=>[row.fixture,row.actual,row.expected,row.oracle.source]),...(value.refusals??[]).flatMap(row=>[row.fixture,row.originalAfter])];
  for(const leaf of refs)capture(ref.hash,leaf,join(evidenceRoot,role,leaf.path));
 }
 const profileDefinition={baseCodec,platform:'darwin',arch:'arm64',producer:{transport:'png-scanline-file-cp1-v1',mediaType:'image/png',sourceHash:source.sourceHash,artifactHash:null,abiVersion:null},kernel:definition.kernel,color:definition.color,qualificationHash};
 const codec=hash(canonical(profileDefinition)),profile={...profileDefinition,codec,pipeline:definition.pixelPipeline+'/'+codec};
 files.push(putJSON(capsule,'import-profile.json',profile));
 const proof={schemaVersion:2,qualificationHash,references:retained};files.push(putJSON(capsule,'proof-capsule.json',proof));
 const manifest={schemaVersion:1,status:'ready-for-verified-adoption',vendorPath:'vendor/raster/png-import/'+source.sourceHash.slice(7)+'/darwin-arm64/'+qualificationHash.slice(7),files,qualificationHash,baseCodecAuthority};
 const manifestHash=putJSON(capsule,'adoption.json',manifest).hash;
 return {home,root,capsule,evidenceRoot,source,profile,proof,manifest,manifestHash,qualification,qualificationPath:join(evidenceRoot,qFile.path),leafFiles};
}
const verify=f=>verifyImportCapsule(f.capsule,{root:f.root,manifestHash:f.manifestHash});
function refreshManifest(f){f.manifestHash=rewriteJSON(f.capsule,'adoption.json',f.manifest).hash;}
function replaceJSON(f,path,value){const ref=rewriteJSON(f.capsule,path,value),index=f.manifest.files.findIndex(row=>row.path===path);assert(index>=0);f.manifest.files[index]=ref;refreshManifest(f);}
function refreshProfile(f){const {codec:unused,pipeline:unusedPipeline,...definition}=f.profile;f.profile.codec=hash(canonical(definition));f.profile.pipeline='cp1-f64-triangle-area-v1/'+f.profile.codec;replaceJSON(f,'import-profile.json',f.profile);}
// Apply only to this test's disposable root, checking every staged identity and
// base first. Production adoption remains an unapplied, reviewable overlay.
function installTestOverlay(root,staged){
 for(const row of staged.manifest.targets){
  assert.deepEqual(identity(join(staged.output,'new',row.path)),row.target);
  if(row.base===null)assert.equal(existsSync(join(root,row.path)),false);else assert.deepEqual(identity(join(root,row.path)),row.base);
 }
 for(const row of staged.manifest.targets){const target=join(root,row.path);mkdirSync(dirname(target),{recursive:true,mode:0o700});writeFileSync(target,readFileSync(join(staged.output,'new',row.path)),{flag:row.base===null?'wx':'w',mode:0o600});}
}

test('a self-contained PNG contract capsule verifies without registering production support',async t=>{
 const f=fixture(t),before=tree(f.root),checked=await verify(f);
 assert.deepEqual(checked.profile,f.profile);assert.equal(checked.seal,null);assert.equal(checked.qualificationHash,hash(readFileSync(f.qualificationPath)));assert.deepEqual(tree(f.root),before);
 assert.equal(f.manifest.files.some(row=>row.path==='adoption.json'),false);
 assert.equal(readFileSync(join(f.root,inventoryPath),'utf8'),inventoryPrefix+JSON.stringify(emptyInventory,null,2)+' as const;\n');
 assert.equal(f.qualification.hostSourceFiles.length,14);assert.deepEqual(f.qualification.hostSourceFiles.map(row=>row.repositoryPath),requiredHostSources);
 assert.equal(f.qualification.hostSourceHash,hash(canonical(f.qualification.hostSourceFiles)));
 for(const ref of f.qualification.evidence)assert.equal(JSON.parse(readFileSync(join(f.evidenceRoot,ref.path),'utf8')).hostSourceHash,f.qualification.hostSourceHash);
});

test('JPEG producer authorities preserve each reviewed recipe generation exactly',()=>{
 const old=jpegProducerAuthority('sha256:053ad79aa0e1256efcc5dd103e04ae4f086cf2b23a24a01ffe889c556db4a318');
 const next=jpegProducerAuthority('sha256:f8ba056eeba5d7ac6e77797d62684bd285c4d569fec8e3101683b49ac5bf1e64');
 assert.deepEqual(old,{directory:'producer-v3',kind:'jpeg-scanline-producer-source-v3'});
 assert.deepEqual(next,{directory:'producer-v4',kind:'jpeg-scanline-producer-source-v4'});
 assert(Object.isFrozen(old)&&Object.isFrozen(next));assert.notDeepEqual(old,next);
 assert.throws(()=>jpegProducerAuthority(hash('unreviewed producer successor')),/Unreviewed JPEG producer authority/);
 assert.throws(()=>jpegProducerAuthority('producer-v4'));
});

test('native producer identities retain their different frozen newline encodings',()=>{
 const definition={toolchain:{version:'line1\nline2'}};
 const jpegLiteral='{"toolchain":{"version":"line1\\u000aline2"}}',webpLiteral='{"toolchain":{"version":"line1\\nline2"}}';
 assert.notEqual(jpegLiteral,webpLiteral);
 assert.equal(nativeProducerHash('jpeg-scanline-file-v1',definition),hash(jpegLiteral));
 assert.equal(nativeProducerHash('webp-advanced-file-v1',definition),hash(webpLiteral));
 assert.notEqual(nativeProducerHash('jpeg-scanline-file-v1',definition),nativeProducerHash('webp-advanced-file-v1',definition));
});

for(const path of ['../outside','/absolute','vendor/../outside','a//b','a/./b','a\\b','a/',''])test('capsule inventory rejects noncanonical path '+JSON.stringify(path),async t=>{
 const f=fixture(t);await verify(f);f.manifest.files[0].path=path;refreshManifest(f);await assert.rejects(async()=>verify(f));
});

test('the external manifest digest cannot be replaced by a newly self-consistent file inventory',async t=>{
 const f=fixture(t);await verify(f);const reviewed=f.manifestHash;f.manifest.qualificationHash=hash('different qualification');refreshManifest(f);
 await assert.rejects(async()=>verifyImportCapsule(f.capsule,{root:f.root,manifestHash:reviewed}),/manifest changed/i);
});

for(const kind of ['duplicate','self'])test('capsule inventory rejects '+kind+' references',async t=>{
 const f=fixture(t);await verify(f);f.manifest.files.push(kind==='duplicate'?{...f.manifest.files[0]}:{path:'adoption.json',bytes:1,hash:hash('x')});refreshManifest(f);await assert.rejects(async()=>verify(f),/Duplicate|self-referential/);
});

for(const kind of ['extra','missing','different-bytes','wrong-length'])test('capsule inventory rejects '+kind,async t=>{
 const f=fixture(t);await verify(f);const entry=f.manifest.files.find(row=>row.path.startsWith('source-inputs/'));
 if(kind==='extra')put(f.capsule,'unlisted.txt','extra');
 else if(kind==='missing')rmSync(join(f.capsule,entry.path));
 else if(kind==='different-bytes')writeFileSync(join(f.capsule,entry.path),Buffer.alloc(entry.bytes,120));
 else{entry.bytes++;refreshManifest(f);}
 await assert.rejects(async()=>verify(f));
});

for(const kind of ['symbolic-link','hard-link','directory'])test('declared inputs reject '+kind+' substitution',async t=>{
 const f=fixture(t);await verify(f);const entry=f.manifest.files.find(row=>row.path.startsWith('source-inputs/')),path=join(f.capsule,entry.path),outside=join(f.home,'replacement');
 writeFileSync(outside,readFileSync(path),{flag:'wx',mode:0o600});rmSync(path);
 if(kind==='symbolic-link')symlinkSync(outside,path);else if(kind==='hard-link')linkSync(outside,path);else mkdirSync(path);
 await assert.rejects(async()=>verify(f));
});

test('a linked capsule directory is not an alternate trusted root',async t=>{
 const f=fixture(t);await verify(f);const link=join(f.home,'linked-capsule');symlinkSync(f.capsule,link,'dir');
 await assert.rejects(async()=>verifyImportCapsule(link,{root:f.root,manifestHash:f.manifestHash}));
});

for(const field of ['artifactHash','abiVersion'])test('PNG rejects a native '+field+' even with recomputed profile identity',async t=>{
 const f=fixture(t);await verify(f);f.profile.producer[field]=field==='artifactHash'?hash('native decoder'):1;refreshProfile(f);await assert.rejects(async()=>verify(f));
});

test('a PNG capsule cannot gain a native identity by declaring an extra seal',async t=>{
 const f=fixture(t);await verify(f);f.manifest.files.push(putJSON(f.capsule,'identity.json',{status:'qualified'}));refreshManifest(f);await assert.rejects(async()=>verify(f),/PNG capsule cannot carry a native identity/);
});

for(const [transport,mediaType,prefix]of [['jpeg-scanline-file-v1','image/jpeg','dependency-inputs'],['webp-advanced-file-v1','image/webp','authority-inputs']])test('a recomputed '+transport+' profile cannot substitute for a native seal and qualification',async t=>{
 const f=fixture(t);await verify(f);const before=tree(f.root),output=join(f.home,'adoption');
 // Deliberately incomplete: these are still synthetic PNG receipts, with no
 // native build, artifact, seal, or native qualification evidence whatsoever.
 for(const ref of f.manifest.baseCodecAuthority.inputs)f.manifest.files.push(put(f.capsule,prefix+'/'+ref.path,readFileSync(join(f.root,ref.path))));
 Object.assign(f.profile.producer,{transport,mediaType,artifactHash:hash('absent native artifact'),abiVersion:1});refreshProfile(f);
 await assert.rejects(async()=>verify(f),/identity\.json/);
 await assert.rejects(async()=>stageImportAdoption({root:f.root,capsule:f.capsule,manifestHash:f.manifestHash,output}),/identity\.json/);
 assert.deepEqual(tree(f.root),before);absentOutput(output);
});

test('current source drift invalidates the exact PNG producer while leaving its capsule intact',async t=>{
 const f=fixture(t);await verify(f);const before=tree(f.capsule),path=join(f.root,'server/raster/png-import.ts');writeFileSync(path,Buffer.concat([readFileSync(path),Buffer.from('\n// changed producer\n')]));
 await assert.rejects(async()=>verify(f),/source drift/i);assert.deepEqual((await verifyImportCapsule(f.capsule,{root:f.root,manifestHash:f.manifestHash,current:false})).profile,f.profile);assert.deepEqual(tree(f.capsule),before);
});

test('historical verification retains host proof while current verification requires the qualified host bytes',async t=>{
 const f=fixture(t);await verify(f);const before=tree(f.capsule),hostPath='server/storage/writer.ts';assert(requiredHostSources.includes(hostPath));assert(!requiredSources.includes(hostPath));
 const path=join(f.root,hostPath);writeFileSync(path,Buffer.concat([readFileSync(path),Buffer.from('\n// unqualified host change\n')]));
 await assert.rejects(async()=>verify(f),/host implementation changed/i);
 assert.deepEqual((await verifyImportCapsule(f.capsule,{root:f.root,manifestHash:f.manifestHash,current:false})).profile,f.profile);assert.deepEqual(tree(f.capsule),before);
});

for(const kind of ['missing','duplicate','unreferenced','wrong-parent','wrong-bytes'])test('retained proof mapping rejects '+kind+' links',async t=>{
 const f=fixture(t);await verify(f);
 if(kind==='missing')f.proof.references.pop();
 else if(kind==='duplicate')f.proof.references.push({...f.proof.references[0]});
 else if(kind==='unreferenced')f.proof.references.push({...f.proof.references[0],originalReference:'not-declared.json'});
 else if(kind==='wrong-parent')f.proof.references[0].parentHash=hash('wrong parent');
 else f.proof.references[0].bytes++;
 replaceJSON(f,'proof-capsule.json',f.proof);await assert.rejects(async()=>verify(f));
});

test('completion captures relocated proof bytes without rewriting the accepted qualification or issuer output',async t=>{
 const f=fixture(t),issuerBefore=tree(f.capsule),rootBefore=tree(f.root),output=join(f.home,'completed');
 const completed=await completeImportCapsule({root:f.root,source:f.capsule,qualification:f.qualificationPath,evidenceRoot:f.evidenceRoot,output,manifestHash:f.manifestHash});
 assert.deepEqual(readFileSync(join(output,'qualification.json')),readFileSync(f.qualificationPath));assert.equal(completed.profile.codec,f.profile.codec);assert.deepEqual(tree(f.capsule),issuerBefore);assert.deepEqual(tree(f.root),rootBefore);
 assert.deepEqual(readFileSync(join(output,'issuer-adoption.json')),readFileSync(join(f.capsule,'adoption.json')));assert.equal(completed.manifest.files.some(row=>row.path==='adoption.json'),false);
 // A completed capsule verifies after the original evidence paths disappear.
 rmSync(f.evidenceRoot,{recursive:true});const copied=await verifyImportCapsule(output,{root:f.root,manifestHash:completed.manifestHash});assert.deepEqual(copied.profile,f.profile);
});

test('completion refuses an external evidence root that does not contain the accepted qualification',async t=>{
 const f=fixture(t),output=join(f.home,'completed');await verify(f);
 await assert.rejects(async()=>completeImportCapsule({root:f.root,source:f.capsule,qualification:f.qualificationPath,evidenceRoot:f.capsule,output,manifestHash:f.manifestHash}),/Evidence escaped/);assert.equal(existsSync(output),false);
});

for(const input of ['capsule','evidenceRoot'])test('completion rejects output inside '+input+' before creating it',async t=>{
 const f=fixture(t),output=join(f[input],'nested-output'),sourceBefore=tree(f.capsule),evidenceBefore=tree(f.evidenceRoot),rootBefore=tree(f.root);
 await assert.rejects(async()=>completeImportCapsule({root:f.root,source:f.capsule,qualification:f.qualificationPath,evidenceRoot:f.evidenceRoot,output,manifestHash:f.manifestHash}),/must not overlap/);
 assert.equal(existsSync(output),false);assert.deepEqual(tree(f.capsule),sourceBefore);assert.deepEqual(tree(f.evidenceRoot),evidenceBefore);assert.deepEqual(tree(f.root),rootBefore);
});

test('adoption rejects output inside the reviewed capsule before creating it',async t=>{
 const f=fixture(t),output=join(f.capsule,'nested-output'),before=tree(f.capsule),rootBefore=tree(f.root);
 await assert.rejects(async()=>stageImportAdoption({root:f.root,capsule:f.capsule,manifestHash:f.manifestHash,output}),/must not overlap/);
 assert.equal(existsSync(output),false);assert.deepEqual(tree(f.capsule),before);assert.deepEqual(tree(f.root),rootBefore);
});

test('changed referenced bytes cannot become accepted evidence during completion',async t=>{
 const f=fixture(t);await verify(f);const sourceBefore=tree(f.capsule),rootBefore=tree(f.root),output=join(f.home,'completed'),leaf=f.leafFiles.find(row=>row.path==='pixels/actual.rgba');
 writeFileSync(join(f.evidenceRoot,leaf.path),Buffer.from([13,27,90,127]));
 await assert.rejects(async()=>completeImportCapsule({root:f.root,source:f.capsule,qualification:f.qualificationPath,evidenceRoot:f.evidenceRoot,output,manifestHash:f.manifestHash}));
 assert.deepEqual(tree(f.capsule),sourceBefore);assert.deepEqual(tree(f.root),rootBefore);assert.equal(existsSync(join(output,'adoption.json')),false,'Incomplete captured files must not receive a completed manifest');
});

test('adoption stages the exact capsule and an append-only inventory without modifying the root',async t=>{
 const f=fixture(t),before=tree(f.root),capsuleBefore=tree(f.capsule),output=join(f.home,'adoption');
 const staged=await stageImportAdoption({root:f.root,capsule:f.capsule,manifestHash:f.manifestHash,output});
 assert.equal(staged.manifest.status,'prepared-not-applied');assert.equal(staged.manifest.capsuleManifestHash,f.manifestHash);assert.deepEqual(tree(f.root),before);assert.deepEqual(tree(f.capsule),capsuleBefore);
 const retained=join(output,'new',f.manifest.vendorPath);assert.deepEqual(tree(retained),capsuleBefore);await verifyImportCapsule(retained,{root:f.root,manifestHash:f.manifestHash});
 const nextSource=readFileSync(join(output,'new',inventoryPath),'utf8');assert(nextSource.startsWith(inventoryPrefix));const next=JSON.parse(nextSource.slice(inventoryPrefix.length,-' as const;\n'.length));
 assert.deepEqual(next,{...emptyInventory,capsules:[{path:f.manifest.vendorPath,manifestHash:f.manifestHash}],profiles:[f.profile],activeProfiles:[f.profile.pipeline]});
 const target=staged.manifest.targets.find(row=>row.path===inventoryPath);assert.deepEqual(target.base,identity(join(f.root,inventoryPath)));assert.deepEqual(target.target,identity(join(output,'new',inventoryPath)));
});

for(const change of ['host','source','pixels'])test('adoption appends history and explicitly replaces the active profile after '+change+' change',async t=>{
 const f=fixture(t),first=await stageImportAdoption({root:f.root,capsule:f.capsule,manifestHash:f.manifestHash,output:join(f.home,'first-overlay')});installTestOverlay(f.root,first);
 const originalVendor=join(f.root,f.manifest.vendorPath),originalBytes=tree(originalVendor);
 assert.deepEqual(await verifyImportInventory(f.root),{status:'passed',capsules:1,profiles:1,activeProfiles:1});
 if(change!=='pixels'){
  const path=join(f.root,change==='host'?'server/storage/writer.ts':'server/raster/png-import.ts');writeFileSync(path,Buffer.concat([readFileSync(path),Buffer.from('\n// synthetic '+change+' successor\n')]));
  await assert.rejects(async()=>verifyImportInventory(f.root),/host implementation changed|source drift/i);
 }
 assert.deepEqual(await verifyImportInventory(f.root,{current:false}),{status:'passed',capsules:1,profiles:1,activeProfiles:1});
 assert.deepEqual((await verifyImportCapsule(originalVendor,{root:f.root,manifestHash:f.manifestHash,current:false})).profile,f.profile);
 const next=fixture(t,{previous:f,pixel:change==='pixels'?[241,15,65,201]:[13,27,91,127]});
 assert.notEqual(next.profile.pipeline,f.profile.pipeline);assert.notEqual(next.manifest.vendorPath,f.manifest.vendorPath);
 if(change==='source')assert.notEqual(next.source.sourceHash,f.source.sourceHash);else assert.equal(next.source.sourceHash,f.source.sourceHash);
 if(change==='host')assert.notEqual(next.qualification.hostSourceHash,f.qualification.hostSourceHash);else assert.equal(next.qualification.hostSourceHash,f.qualification.hostSourceHash);
 const rootBefore=tree(f.root),staged=await stageImportAdoption({root:f.root,capsule:next.capsule,manifestHash:next.manifestHash,output:join(f.home,'next-overlay')});
 assert.deepEqual(tree(f.root),rootBefore);assert.deepEqual(tree(originalVendor),originalBytes);
 const inventory=readImportInventory(join(staged.output,'new'));
 assert.deepEqual(inventory.profiles,[f.profile,next.profile]);assert.deepEqual(inventory.activeProfiles,[next.profile.pipeline]);
 assert.deepEqual(inventory.capsules,[{path:f.manifest.vendorPath,manifestHash:f.manifestHash},{path:next.manifest.vendorPath,manifestHash:next.manifestHash}]);
 assert.deepEqual(staged.manifest.deactivatedProfiles.map(row=>row.pipeline),[f.profile.pipeline]);
 assert.equal(staged.manifest.targets.some(row=>row.path.startsWith(f.manifest.vendorPath+'/')),false,'Historical vendor bytes are never rewritten');
 installTestOverlay(f.root,staged);assert.deepEqual(tree(originalVendor),originalBytes);
 assert.deepEqual(await verifyImportInventory(f.root),{status:'passed',capsules:2,profiles:2,activeProfiles:1});
 assert.deepEqual((await verifyImportCapsule(originalVendor,{root:f.root,manifestHash:f.manifestHash,current:false})).profile,f.profile);
 // The only active tuple cannot ambiguously select both retained generations.
 writeFileSync(join(f.root,inventoryPath),inventoryBytes({...inventory,activeProfiles:[f.profile.pipeline,next.profile.pipeline]}));
 await assert.rejects(async()=>verifyImportInventory(f.root,{current:false}),/Ambiguous active import profile tuple/);
});

test('inactive historical profiles remain verifiable after host drift but retained proof corruption still fails',async t=>{
 const f=fixture(t),staged=await stageImportAdoption({root:f.root,capsule:f.capsule,manifestHash:f.manifestHash,output:join(f.home,'adoption')});installTestOverlay(f.root,staged);
 const hostPath='server/storage/writer.ts',currentHost=join(f.root,hostPath);writeFileSync(currentHost,Buffer.concat([readFileSync(currentHost),Buffer.from('\n// later host implementation\n')]));
 const inventory=readImportInventory(f.root);writeFileSync(join(f.root,inventoryPath),inventoryBytes({...inventory,activeProfiles:[]}));
 assert.deepEqual(await verifyImportInventory(f.root),{status:'passed',capsules:1,profiles:1,activeProfiles:0});
 const retainedHost=join(f.root,f.manifest.vendorPath,'host-source-inputs',hostPath),bytes=readFileSync(retainedHost);bytes[bytes.length-1]^=1;writeFileSync(retainedHost,bytes);
 await assert.rejects(async()=>verifyImportInventory(f.root));await assert.rejects(async()=>verifyImportInventory(f.root,{current:false}));
});

for(const active of ['unknown','duplicate'])test('inventory refuses '+active+' active profile references',async t=>{
 const f=fixture(t),staged=await stageImportAdoption({root:f.root,capsule:f.capsule,manifestHash:f.manifestHash,output:join(f.home,'adoption')});installTestOverlay(f.root,staged);
 const inventory=readImportInventory(f.root);inventory.activeProfiles=active==='unknown'?['cp1-f64-triangle-area-v1/'+hash('unknown profile')]:[f.profile.pipeline,f.profile.pipeline];writeFileSync(join(f.root,inventoryPath),inventoryBytes(inventory));
 await assert.rejects(async()=>verifyImportInventory(f.root),/Unknown or duplicate active profile/);
});

test('mutation after successful verification cannot be adopted from a cached result',async t=>{
 const f=fixture(t);await verify(f);const before=tree(f.root),output=join(f.home,'adoption'),entry=f.manifest.files.find(row=>row.path.startsWith('proofs/'));
 writeFileSync(join(f.capsule,entry.path),Buffer.alloc(entry.bytes,120));await assert.rejects(async()=>stageImportAdoption({root:f.root,capsule:f.capsule,manifestHash:f.manifestHash,output}));assert.deepEqual(tree(f.root),before);absentOutput(output);
});

test('mutation while the reviewed source is held for capture cannot publish an adoption overlay',async t=>{
 const f=fixture(t);await verify(f);const before=tree(f.root),output=join(f.home,'adoption'),source=join(f.capsule,'source.json'),destination=join(output,'new',f.manifest.vendorPath,'source.json');
 const originalOpen=fs.openSync;let mutated=false;
 // The public filesystem boundary places the mutation after source verification
 // and source-FD acquisition, immediately before its exclusive destination open.
 // This requires no verifier-specific hook and keeps byte length unchanged.
 const mock=t.mock.method(fs,'openSync',function(path,flags,...args){
  if(String(path)===destination&&!mutated){mutated=true;const changed=Buffer.from(readFileSync(source));changed[changed.length-1]=32;writeFileSync(source,changed);}
  return originalOpen.call(this,path,flags,...args);
 });
 syncBuiltinESMExports();
 try{await assert.rejects(async()=>stageImportAdoption({root:f.root,capsule:f.capsule,manifestHash:f.manifestHash,output}),/Captured bytes|changed|identity/i);}
 finally{mock.mock.restore();syncBuiltinESMExports();}
 assert.equal(mutated,true,'The fixture must reach the real copy boundary');assert.deepEqual(tree(f.root),before);absentOutput(output);
});

test('an inventory update during capsule copying is preserved and prevents overlay publication',async t=>{
 const f=fixture(t);await verify(f);const before=tree(f.root),output=join(f.home,'adoption'),catalog=join(f.root,inventoryPath),destination=join(output,'new',f.manifest.vendorPath,'source.json');
 // This remains a valid, empty inventory; different whitespace represents an
 // external writer's newer bytes, which the overlay must not overwrite.
 const newerInventory=inventoryBytes(emptyInventory,4);assert.notEqual(newerInventory,readFileSync(catalog,'utf8'));
 const originalOpen=fs.openSync;let mutated=false;
 const mock=t.mock.method(fs,'openSync',function(path,flags,...args){
  if(String(path)===destination&&!mutated){mutated=true;writeFileSync(catalog,newerInventory);}
  return originalOpen.call(this,path,flags,...args);
 });
 syncBuiltinESMExports();
 try{await assert.rejects(async()=>stageImportAdoption({root:f.root,capsule:f.capsule,manifestHash:f.manifestHash,output}),/Import inventory changed during capture/);}
 finally{mock.mock.restore();syncBuiltinESMExports();}
 assert.equal(mutated,true,'The fixture must reach the real copy boundary');assert.equal(readFileSync(catalog,'utf8'),newerInventory);assert.deepEqual(readImportInventory(f.root),emptyInventory);
 assert.deepEqual(tree(f.root).filter(row=>row.path!==inventoryPath),before.filter(row=>row.path!==inventoryPath));absentOutput(output);
});

for(const operation of ['complete','stage'])test(operation+' refuses an existing output without changing it',async t=>{
 const f=fixture(t),output=join(f.home,'existing');mkdirSync(output,{mode:0o700});put(output,'sentinel','previous owned output');const before=tree(output),rootBefore=tree(f.root);
 await assert.rejects(async()=>operation==='complete'?completeImportCapsule({root:f.root,source:f.capsule,qualification:f.qualificationPath,evidenceRoot:f.evidenceRoot,output,manifestHash:f.manifestHash}):stageImportAdoption({root:f.root,capsule:f.capsule,manifestHash:f.manifestHash,output}),/Never replace/);
 assert.deepEqual(tree(output),before);assert.deepEqual(tree(f.root),rootBefore);
});

test('adoption refuses an existing vendor target and preserves its original contents',async t=>{
 const f=fixture(t),target=join(f.root,f.manifest.vendorPath),output=join(f.home,'adoption');mkdirSync(target,{recursive:true,mode:0o700});put(target,'sentinel','existing vendor generation');const before=tree(f.root);
 await assert.rejects(async()=>stageImportAdoption({root:f.root,capsule:f.capsule,manifestHash:f.manifestHash,output}),/Never replace an issued vendor directory/);assert.deepEqual(tree(f.root),before);absentOutput(output);
});
