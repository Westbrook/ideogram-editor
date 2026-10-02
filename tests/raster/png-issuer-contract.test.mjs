// Test construction is not qualification. No decoder/native worker is invoked.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PNG_CASES,PNG_ROLES,PNG_REFUSALS,PNG_SOURCE_PATHS,PNG_ISSUER_PATHS,PNG_HOST_SOURCE_PATHS,pngDigest,validatePNGSource,validatePNGProducerSource,validatePNGQualification} from '../../tooling/raster/import-issuance/png-contract.mjs';
import {canonicalStringify,makePNGFixture} from './png-issuer-fixtures.mjs';

const validate=fixture=>{validatePNGSource(fixture.source,canonicalStringify);validatePNGProducerSource(fixture.source,fixture.producerManifest,fixture.producerManifestHash);return validatePNGQualification({...fixture,canonicalStringify});};
const rejects=(label,mutate)=>test(label,()=>{const f=makePNGFixture();mutate(f);assert.throws(()=>validate(f));});

test('fabricated contract fixtures satisfy the schema on each supported target, without claiming execution',()=>{
  for(const [platform,arch]of [['darwin','arm64'],['linux','arm64'],['linux','x64']]){
    const f=makePNGFixture({platform,arch});assert.equal(validate(f),f.qualification);assert.deepEqual([...f.receipts.keys()],PNG_ROLES);
    for(const receipt of f.receipts.values())assert.match(receipt.environment.os,/CONTRACT TEST ONLY/);
  }
});
rejects('source definition byte identity cannot change beneath a retained sourceHash',f=>{f.source.definition.files[0].hash=pngDigest('mutated source');});
rejects('source manifests must include every required algorithm and canonicalization input',f=>{
  f.source.definition.files=f.source.definition.files.filter(ref=>ref.path!=='src/protocol/json.ts');f.source.sourceHash=pngDigest(canonicalStringify(f.source.definition));
});
rejects('generated inventory cannot enter the producer identity',f=>{
  f.source.definition.files.push({path:'server/raster/import-profile.ts',bytes:1,hash:pngDigest('x')});f.source.definition.files.sort((a,b)=>a.path.localeCompare(b.path));f.source.sourceHash=pngDigest(canonicalStringify(f.source.definition));
});
rejects('duplicate source paths reject even after recomputing the definition hash',f=>{
  f.source.definition.files.push({...f.source.definition.files[0]});f.source.definition.files.sort((a,b)=>a.path.localeCompare(b.path));f.source.sourceHash=pngDigest(canonicalStringify(f.source.definition));
});
rejects('source manifests reject unknown fields rather than silently ignoring scope',f=>{f.source.definition.fallback='unqualified';});
rejects('source path traversal never becomes a source identity',f=>{f.source.definition.files[0].path='../outside.ts';f.source.sourceHash=pngDigest(canonicalStringify(f.source.definition));});
rejects('producer source must bind the exact issuer manifest serialization',f=>{f.producerManifestHash=pngDigest('another issuer manifest');});
rejects('producer source cannot use an issuer manifest from another runtime snapshot',f=>{f.producerManifest.sourceHash=pngDigest('another runtime snapshot');});
rejects('producer source cannot omit any frozen issuer input',f=>{f.producerManifest.files.pop();});
rejects('producer source cannot substitute an unrelated issuer filename',f=>{f.producerManifest.files[0].path='tooling/raster/import-issuance/unreviewed.mjs';});
test('the fixture retains every frozen runtime and issuer source path',()=>{const f=makePNGFixture();assert.deepEqual(f.source.definition.files.map(ref=>ref.path),PNG_SOURCE_PATHS);assert.deepEqual(f.producerManifest.files.map(ref=>ref.path),PNG_ISSUER_PATHS);for(const ref of [...f.source.definition.files,...f.producerManifest.files])assert.equal(pngDigest(f.files.get(ref.path)),ref.hash);});
rejects('qualification is bound to exact source manifest bytes, not just logical sourceHash',f=>{f.sourceManifestHash=pngDigest('different source manifest serialization');});
rejects('qualification cannot substitute another producer source authority',f=>{f.qualification.producerSourceHash=pngDigest('another producer');});
rejects('qualification cannot substitute a binary artifact for the JS-only transport',f=>{f.qualification.artifactHash=pngDigest('native');});
rejects('qualification refuses an ABI marker on the JS-only transport',f=>{f.qualification.abiVersion=1;});
rejects('qualification refuses unsupported targets',f=>{f.qualification.platform='win32';f.baseCodecAuthority.platform='win32';});
rejects('qualification refuses cross-platform base codec authority',f=>{f.baseCodecAuthority={...f.baseCodecAuthority,platform:'linux',arch:'x64'};});
rejects('qualification refuses a same-platform but different codec identity',f=>{f.baseCodecAuthority.codecId=pngDigest('wrong exact platform build');});
rejects('all role receipts are required',f=>{f.qualification.evidence=[];f.receipts.clear();});
rejects('a missing durability receipt cannot be masked by successful pixel work',f=>{f.qualification.evidence=f.qualification.evidence.filter(ref=>ref.role!=='durability');f.receipts.delete('durability');});
rejects('one receipt hash cannot impersonate two roles',f=>{f.qualification.evidence[1].hash=f.qualification.evidence[0].hash;});
rejects('receipt role names cannot be duplicated',f=>{f.qualification.evidence[1].role=f.qualification.evidence[0].role;});
rejects('extra receipts are not accepted as an unspecified qualification role',f=>{f.receipts.set('other',structuredClone(f.receipts.get('pixels')));});
rejects('a receipt from another source snapshot is refused',f=>{f.receipts.get('pixels').sourceManifestHash=pngDigest('other source manifest');});
rejects('a receipt from another execution architecture is refused',f=>{f.receipts.get('pixels').environment.arch='x64';});
rejects('an unpinned Node runtime is refused',f=>{f.receipts.get('pixels').environment.node='26.10.1';});
rejects('empty or duplicated logs cannot support a role',f=>{f.receipts.get('pixels').logs=[];});
rejects('duplicate log references cannot impersonate distinct retained logs',f=>{const r=f.receipts.get('pixels');r.logs.push({...r.logs[0]});});
rejects('a log one byte above the retained log bound is refused',f=>{f.receipts.get('pixels').logs[0].bytes=8*1048576+1;});
rejects('a receipt one byte above the receipt bound is refused',f=>{f.qualification.evidence[0].bytes=8*1048576+1;});
for(const role of ['pixels','color-orientation-cp1','durability']){
  rejects(role+': empty case tables cannot pass',f=>{const r=f.receipts.get(role);r.cases=[];r.completedCases=0;r.completedChecks=0;});
  rejects(role+': omitted required case refuses even with internally consistent counts',f=>{const r=f.receipts.get(role);r.cases.pop();r.completedCases=r.cases.length;r.completedChecks=r.cases.reduce((n,c)=>n+c.completedChecks,0);});
  rejects(role+': duplicate case ID refuses even with the expected table length',f=>{const r=f.receipts.get(role);r.cases[1].id=r.cases[0].id;});
  rejects(role+': completed case counts are checked against actual rows',f=>{f.receipts.get(role).completedCases++;});
  rejects(role+': completed check counts are checked against actual rows',f=>{f.receipts.get(role).completedChecks++;});
  rejects(role+': a failed individual case cannot be covered by top-level passed',f=>{f.receipts.get(role).cases[0].status='failed-case';});
}
rejects('pixel evidence must retain independent expected output at a different path',f=>{const c=f.receipts.get('pixels').cases[0];c.expected.path=c.actual.path;});
rejects('pixel output mismatch refuses the role',f=>{f.receipts.get('pixels').cases[0].actual.hash=pngDigest('wrong decoded pixels');});
rejects('pixel output byte count must equal exact RGBA extent',f=>{f.receipts.get('pixels').cases[0].actual.bytes++;});
rejects('an oversized case cannot relabel an ordinary input',f=>{const c=f.receipts.get('color-orientation-cp1').cases.find(c=>c.id==='oversized-crop');c.originalWidth=8192;c.originalHeight=1;});
rejects('a target one pixel over the per-axis limit refuses',f=>{const c=f.receipts.get('pixels').cases[0];c.width=8193;c.actual.bytes=c.expected.bytes=c.width*4;});
rejects('a target beyond the aggregate25MP output limit refuses',f=>{const c=f.receipts.get('pixels').cases[0];c.width=5000;c.height=5001;c.actual.bytes=c.expected.bytes=c.width*c.height*4;});
rejects('resources cannot use empty jobs with zero residuals as success',f=>{const r=f.receipts.get('resources');r.jobs=[];r.completedJobs=0;r.completedOperations=0;r.maxRSSBytes=1;});
rejects('resource peak one byte over the cap refuses',f=>{const r=f.receipts.get('resources');r.jobs[0].maxRSSBytes=r.capBytes+1;r.maxRSSBytes=r.capBytes+1;});
rejects('resource admission one byte over the cap refuses',f=>{const r=f.receipts.get('resources');r.jobs[0].admittedBytes=r.capBytes+1;});
rejects('resource summary peak must equal the maximum observed job peak',f=>{f.receipts.get('resources').maxRSSBytes++;});
rejects('resource completed job counts must equal the job table',f=>{f.receipts.get('resources').completedJobs++;});
rejects('resource operation totals must equal completed job totals',f=>{f.receipts.get('resources').completedOperations++;});
rejects('resource jobs must bind distinct operation IDs',f=>{const r=f.receipts.get('resources');r.jobs[1].id=r.jobs[0].id;});
rejects('resource cases cannot be duplicated',f=>{const r=f.receipts.get('resources');r.jobs[1].case=r.jobs[0].case;});
rejects('repeated resize requires at least three completed operations',f=>{const r=f.receipts.get('resources'),j=r.jobs.find(j=>j.case==='repeated-resize');j.completedOperations=2;r.completedOperations--;});
rejects('contended crop requires observed overlapping work',f=>{f.receipts.get('resources').jobs.find(j=>j.case==='contended-crop').contentionObserved=false;});
rejects('contended crop requires at least two concurrent jobs',f=>{f.receipts.get('resources').jobs.find(j=>j.case==='contended-crop').maxConcurrentJobs=1;});
for(const field of ['residualAllocations','residualScratchBytes'])rejects('resource summary rejects one remaining '+field,f=>{f.receipts.get('resources')[field]=1;});
for(const field of ['remainingAllocations','remainingScratchBytes'])rejects('resource job rejects one remaining '+field,f=>{f.receipts.get('resources').jobs[0][field]=1;});
rejects('durability rows require retained observations',f=>{f.receipts.get('durability').cases[0].observations=[];});
rejects('16-bit refusal coverage cannot be empty',f=>{const r=f.receipts.get('pixels');r.refusals=[];r.completedRefusals=0;});
rejects('16-bit refusals cannot omit one unsupported color family',f=>{const r=f.receipts.get('pixels');r.refusals.pop();r.completedRefusals--;});
rejects('16-bit refusal counts must match the retained table',f=>{f.receipts.get('pixels').completedRefusals++;});
rejects('16-bit refusal rows cannot claim successful decoding',f=>{f.receipts.get('pixels').refusals[0].status='passed-case';});
rejects('16-bit refusal must identify unsupported depth, not an unrelated error',f=>{f.receipts.get('pixels').refusals[0].code='RASTER_RESOURCES';});
rejects('16-bit refusal must prove the original remained exact',f=>{f.receipts.get('pixels').refusals[0].originalAfter.hash=pngDigest('modified original');});
rejects('16-bit refusal must retain before and after separately',f=>{const row=f.receipts.get('pixels').refusals[0];row.originalAfter.path=row.fixture.path;});
rejects('16-bit refusal cannot leave an output behind',f=>{f.receipts.get('pixels').refusals[0].outputAbsent=false;});
test('16-bit layouts are refusals and never positive decode coverage',()=>{assert.deepEqual(PNG_REFUSALS,['gray-16','rgb-16','gray-alpha-16','rgba-16']);for(const id of PNG_REFUSALS)assert.equal(PNG_CASES.pixels.includes(id),false);});
test('the exact512MiB resource ceiling is accepted while cap+1 is refused',()=>{
  const f=makePNGFixture(),r=f.receipts.get('resources');for(const j of r.jobs){j.maxRSSBytes=r.capBytes;j.admittedBytes=r.capBytes;}r.maxRSSBytes=r.capBytes;assert.doesNotThrow(()=>validate(f));
  r.jobs[0].maxRSSBytes++;r.maxRSSBytes++;assert.throws(()=>validate(f));
});
test('physical process RSS and logical operation reservation remain distinct quantities',()=>{
  // These scopes differ: whole-process RSS includes runtime/baseline/lifetime
  // effects outside an operation reservation. The contract bounds each by the
  // process ceiling without inventing an unsupported RSS<=reservation relation.
  const f=makePNGFixture(),r=f.receipts.get('resources');for(const j of r.jobs){j.maxRSSBytes=300*1048576;j.admittedBytes=200*1048576;}r.maxRSSBytes=300*1048576;assert.doesNotThrow(()=>validate(f));
});
test('the contract case map has all four disjoint roles',()=>{
  assert.deepEqual(Object.keys(PNG_CASES),PNG_ROLES);for(const role of PNG_ROLES)assert.equal(new Set(PNG_CASES[role]).size,PNG_CASES[role].length);
});

// Host bindings describe the implementation that ran the campaign. Rehashing
// deliberately changed metadata cannot replace a required host file or permit
// receipts from a different execution host to qualify the same source snapshot.
function bindHost(f){
  f.qualification.hostSourceHash=pngDigest(canonicalStringify(f.qualification.hostSourceFiles));
  for(const receipt of f.receipts.values())receipt.hostSourceHash=f.qualification.hostSourceHash;
}
test('the minimum PNG host closure retains all fourteen current host source identities',()=>{
  const f=makePNGFixture();assert.equal(PNG_HOST_SOURCE_PATHS.length,14);
  assert.deepEqual(f.qualification.hostSourceFiles.map(row=>row.repositoryPath),PNG_HOST_SOURCE_PATHS);
  for(const row of f.qualification.hostSourceFiles){const bytes=f.files.get(row.repositoryPath);assert.equal(bytes.length,row.bytes);assert.equal(pngDigest(bytes),row.hash);}
  assert.equal(f.qualification.hostSourceHash,pngDigest(canonicalStringify(f.qualification.hostSourceFiles)));
  for(const role of PNG_ROLES)assert.equal(f.receipts.get(role).hostSourceHash,f.qualification.hostSourceHash);
  assert.doesNotThrow(()=>validate(f));
});
test('a reviewed sorted host closure may explicitly retain additional source inputs',()=>{
  const f=makePNGFixture(),path='src/protocol/json.ts',bytes=f.files.get(path);
  f.qualification.hostSourceFiles.push({repositoryPath:path,bytes:bytes.length,hash:pngDigest(bytes)});
  f.qualification.hostSourceFiles.sort((a,b)=>a.repositoryPath<b.repositoryPath?-1:a.repositoryPath>b.repositoryPath?1:0);bindHost(f);
  assert.doesNotThrow(()=>validate(f));
});
test('host binding requires the caller supplied frozen canonical serializer',()=>{
  const f=makePNGFixture();assert.throws(()=>validatePNGQualification(f));
});
for(const path of PNG_HOST_SOURCE_PATHS)rejects('host closure cannot omit '+path+' even with consistent hashes',f=>{
  const row=f.qualification.hostSourceFiles.find(row=>row.repositoryPath===path);row.repositoryPath='zz-test-only/unrelated.ts';
  f.qualification.hostSourceFiles.sort((a,b)=>a.repositoryPath<b.repositoryPath?-1:a.repositoryPath>b.repositoryPath?1:0);bindHost(f);
});
rejects('qualification cannot omit its host source file table',f=>{delete f.qualification.hostSourceFiles;});
rejects('an empty host source table cannot qualify a complete producer graph',f=>{f.qualification.hostSourceFiles=[];bindHost(f);});
rejects('qualification cannot omit its host source hash',f=>{delete f.qualification.hostSourceHash;});
rejects('host source hash must be a canonical digest',f=>{f.qualification.hostSourceHash='89b46e20';});
rejects('changing host byte metadata beneath the old host hash refuses',f=>{f.qualification.hostSourceFiles[0].bytes++;});
rejects('a duplicate host path refuses after the table and receipt hashes are refreshed',f=>{f.qualification.hostSourceFiles.splice(1,0,{...f.qualification.hostSourceFiles[0]});bindHost(f);});
rejects('host paths must remain sorted even with an internally consistent hash',f=>{f.qualification.hostSourceFiles.reverse();bindHost(f);});
rejects('host paths cannot escape the repository root',f=>{f.qualification.hostSourceFiles.push({repositoryPath:'../outside.ts',bytes:1,hash:pngDigest('x')});bindHost(f);});
rejects('generated import inventory cannot enter a qualification host identity',f=>{
  f.qualification.hostSourceFiles.push({repositoryPath:'server/raster/import-inventory.ts',bytes:1,hash:pngDigest('x')});
  f.qualification.hostSourceFiles.sort((a,b)=>a.repositoryPath<b.repositoryPath?-1:a.repositoryPath>b.repositoryPath?1:0);bindHost(f);
});
rejects('host file rows cannot add unreviewed identity fields',f=>{f.qualification.hostSourceFiles[0].accepted=true;bindHost(f);});
rejects('host file rows require positive retained byte counts',f=>{f.qualification.hostSourceFiles[0].bytes=0;bindHost(f);});
rejects('host file byte counts cannot be fractional',f=>{f.qualification.hostSourceFiles[0].bytes=1.5;bindHost(f);});
rejects('host file byte counts cannot exceed the retained file bound',f=>{f.qualification.hostSourceFiles[0].bytes=2**31+1;bindHost(f);});
rejects('host file identities require well formed content hashes',f=>{f.qualification.hostSourceFiles[0].hash='not-a-digest';bindHost(f);});
rejects('host closure cannot exceed the maximum retained file count',f=>{
  while(f.qualification.hostSourceFiles.length<=8192){const n=f.qualification.hostSourceFiles.length;f.qualification.hostSourceFiles.push({repositoryPath:'zz-test-only/'+String(n).padStart(5,'0')+'.ts',bytes:1,hash:pngDigest('x')});}bindHost(f);
});
for(const role of PNG_ROLES){
  rejects(role+': receipt cannot omit the qualified host source hash',f=>{delete f.receipts.get(role).hostSourceHash;});
  rejects(role+': receipt from another host source closure refuses',f=>{f.receipts.get(role).hostSourceHash=pngDigest('different host implementation');});
}


test('current PNG graph requires shared resource planner and exact retained graph stays readable',async()=>{
 const {readFile}=await import('node:fs/promises');
 const retained=JSON.parse(await readFile(new URL('./fixtures/png-source-before-ready-plan.json',import.meta.url),'utf8'));
 assert.equal(retained.sourceHash,'sha256:2a1ee24eceaa18b99045378bdfe5c3a42068649fc490d2059a8e52875e05f62b');
 assert.equal(validatePNGSource(retained,canonicalStringify),retained);
 assert(PNG_SOURCE_PATHS.includes('server/raster/resource-plan.ts'));
 const current=makePNGFixture();assert.equal(validatePNGSource(current.source,canonicalStringify),current.source);
 const missing=structuredClone(current.source);missing.definition.files=missing.definition.files.filter(row=>row.path!=='server/raster/resource-plan.ts');missing.sourceHash=pngDigest(canonicalStringify(missing.definition));assert.throws(()=>validatePNGSource(missing,canonicalStringify));
 const forged=structuredClone(current.source);forged.definition.files=forged.definition.files.filter(row=>row.path!=='server/raster/resource-plan.ts');forged.sourceHash=retained.sourceHash;assert.throws(()=>validatePNGSource(forged,canonicalStringify));
 const tampered=structuredClone(retained);tampered.definition.files[0].hash=pngDigest('changed retained bytes');assert.throws(()=>validatePNGSource(tampered,canonicalStringify));
});


test('all four reviewed retained PNG source and issuer pairs remain bound to exact prior authority',async()=>{
 const {readFile}=await import('node:fs/promises');
 const expected=[
  ['v2','sha256:89b46e2028d98fffc81c1129f169cfa5df0931ec7960e4f96cc9a67b32007016',5],
  ['node26','sha256:89b46e2028d98fffc81c1129f169cfa5df0931ec7960e4f96cc9a67b32007016',6],
  ['cleanup','sha256:9b63256e6c50861fee5cf1339541ff6cc5eef5b9248c5e0a15b3be359515aaab',6],
  ['v45','sha256:2a1ee24eceaa18b99045378bdfe5c3a42068649fc490d2059a8e52875e05f62b',6],
 ];
 for(const [name,sourceHash,count]of expected){
  const source=JSON.parse(await readFile(new URL('./fixtures/png-retained-ready-plan/'+name+'/png-source.json',import.meta.url),'utf8'));
  const manifestBytes=await readFile(new URL('./fixtures/png-retained-ready-plan/'+name+'/png-source-manifest.json',import.meta.url)),manifest=JSON.parse(manifestBytes);
  assert.equal(source.sourceHash,sourceHash);assert.equal(source.definition.files.length,51);assert.equal(manifest.files.length,count);
  assert.equal(validatePNGSource(source,canonicalStringify),source);assert.equal(validatePNGProducerSource(source,manifest,pngDigest(manifestBytes)),manifest);
  const forged=structuredClone(source);forged.definition.files[0].hash=pngDigest('changed retained source');assert.throws(()=>validatePNGSource(forged,canonicalStringify));
  const wrongManifest=structuredClone(manifest);wrongManifest.files[0].hash=pngDigest('changed issuer');const wrongHash=pngDigest(JSON.stringify(wrongManifest));assert.throws(()=>validatePNGProducerSource(source,wrongManifest,wrongHash));
  if(count===5){const unreviewedHash=pngDigest('different five-file issuer'),unreviewed={...source,producerSourceHash:unreviewedHash};assert.throws(()=>validatePNGProducerSource(unreviewed,manifest,unreviewedHash));}
 }
});
