// Structural requirements for a FUTURE independently accepted wider halo audit.
// This validator never chooses a halo, closes a finding, or creates acceptance.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const HASH = /^sha256:[a-f0-9]{64}$/;
const identity = row => ({bytes:row.bytes,hash:row.hash});
// Version2 pins this exact independently reviewed corpus; subsets require a new
// source-reviewed validator successor, not a resealed smaller matrix.
export const POSITIVE_MATRIX = Object.freeze({bytes:23296,hash:'sha256:95dfd806e608d6a086c805f2967ce6c55272854f4aa28b315cf8d243d967af60'});
export function validateMatrixReference(reference) { assert.deepEqual(identity(reference),POSITIVE_MATRIX); }

export const DEPENDENCY_FINDINGS = Object.freeze(['vp8-reconstruction-filter','chroma-scalar','chroma-selected-SIMD',
  'alpha-prefix-history','lossless-inverse-transform-order','disabled-native-options']);
const text = value => assert(typeof value === 'string' && value.trim().length > 0 && value.length <= 65536);
const positive = n => Number.isSafeInteger(n) && n > 0;
function sameIdentity(ref,expected) { assert.deepEqual(identity(ref),identity(expected)); }
const RULE=Object.freeze({kind:'encoded-grid-expand-align-origin-clamp-trim-v1',pixelProfile:'libwebp-1.6.0-full-rgba8-v1',left:1,top:1,right:1,bottom:1,originAlignment:2});
// Data-only port of the separately reviewed observer contract; this does not
// execute that helper or upgrade an encoder option into an observation.
export function validateFeatureObservation(raw) {
  const keys=(object,expected)=>{assert(object&&typeof object==='object'&&!Array.isArray(object));assert.deepEqual(Object.keys(object).sort(),expected.slice().sort());};
  const integer=(value,low,high)=>assert(Number.isSafeInteger(value)&&value>=low&&value<=high);
  const boolean=value=>assert.equal(typeof value,'boolean');
  const transforms=value=>{assert(Array.isArray(value));assert.equal(new Set(value).size,value.length);value.forEach(v=>integer(v,0,3));};
  keys(raw,['schemaVersion','kind','status','decodedValid','decoderVersion','bytes','dimensions','features']);
  assert.equal(raw.schemaVersion,1);assert.equal(raw.kind,'webp-bitstream-feature-native-v1');assert.equal(raw.status,'observed');
  assert.equal(raw.decodedValid,true);assert.equal(raw.decoderVersion,0x010600);integer(raw.bytes,1,67108864);
  const f=raw.features;assert(f&&typeof f==='object'&&!Array.isArray(f));
  assert(['VP8','VP8L'].includes(f.imageKind));boolean(f.alphaPresent);
  const required=['imageKind','alphaPresent'];
  if(f.imageKind==='VP8L'){
    required.push('vp8lTransforms','vp8lColorCacheBits','vp8lMetaHuffman');
    transforms(f.vp8lTransforms);integer(f.vp8lColorCacheBits,0,11);boolean(f.vp8lMetaHuffman);
  }else{
    required.push('vp8FilterType','vp8SegmentationEnabled');integer(f.vp8FilterType,0,2);boolean(f.vp8SegmentationEnabled);
    if(f.alphaPresent){
      required.push('alphaCompression','alphaFilter','alphaPreprocessing');integer(f.alphaCompression,0,1);integer(f.alphaFilter,0,3);integer(f.alphaPreprocessing,0,1);
      if(f.alphaCompression===1){required.push('alphaUse8BitDecode','alphaColorCacheBits','alphaTransforms');boolean(f.alphaUse8BitDecode);integer(f.alphaColorCacheBits,0,11);transforms(f.alphaTransforms);}
    }
  }
  keys(f,required);assert(Array.isArray(raw.dimensions)&&raw.dimensions.length===2);
  raw.dimensions.forEach(v=>integer(v,1,f.imageKind==='VP8'?16383:16384));assert(raw.dimensions[0]*raw.dimensions[1]<=25000000);
  return raw;
}
function validateMatrix(matrix) {
  assert.equal(matrix.schemaVersion,1); assert.equal(matrix.kind,'webp-halo-positive-matrix-v1');
  assert.equal(matrix.status,'source-only-proposal'); assert.equal(matrix.qualification,false); assert.deepEqual(matrix.rule,RULE);
  assert(Array.isArray(matrix.cases)&&matrix.cases.length>0); const ids=new Set();
  const counts={completedCaseCount:0,completedDecodeCount:0,completedPixelComparisonCount:0,comparedPixelCount:0};
  for(const row of matrix.cases){
    text(row.id); assert(!ids.has(row.id)); ids.add(row.id);
    assert(Array.isArray(row.dimensions)&&row.dimensions.length===2&&row.dimensions.every(n=>positive(n)&&n<=16384));
    const [W,H]=row.dimensions; assert(W*H<=25000000);
    assert(Array.isArray(row.regions)&&row.regions.length>0); const regions=new Set();
    for(const core of row.regions){
      assert(Array.isArray(core)&&core.length===4&&core.every(Number.isSafeInteger));
      const [x,y,w,h]=core; assert(x>=0&&y>=0&&w>0&&h>0&&x+w<=W&&y+h<=H);
      const key=JSON.stringify(core); assert(!regions.has(key));regions.add(key); counts.comparedPixelCount+=w*h;
    }
    const tiles=[];for(let y=0;y<H;y+=2048)for(let x=0;x<W;x+=2048)tiles.push([x,y,Math.min(2048,W-x),Math.min(2048,H-y)]);
    assert(Array.isArray(row.reconstructionIndices)&&row.reconstructionIndices.every(n=>Number.isSafeInteger(n)&&n>=0&&n<row.regions.length));
    assert.deepEqual(row.reconstructionIndices.map(i=>row.regions[i]),tiles);
    assert.deepEqual(Object.keys(row.requiredFeatures).sort(),['contains','equals','minimum']);
    assert(['VP8','VP8L'].includes(row.requiredFeatures.equals.imageKind));
    counts.completedCaseCount++;counts.completedDecodeCount+=row.regions.length;counts.completedPixelComparisonCount+=row.regions.length;
  }
  assert.deepEqual(matrix.expectedPerLoadOrder,counts); assert(Object.values(counts).every(positive));
}

export function validateSourceAudit({audit,auditPath,proof,native,nativeChildren,candidate,candidateHash,recipe,readBound}) {
  assert.equal(typeof readBound,'function');
  const bound = (parent,ref,allowEmpty=false) => {
    assert(ref && typeof ref.path === 'string' && (positive(ref.bytes)||allowEmpty&&ref.bytes===0) && HASH.test(ref.hash));
    const held = readBound(parent,ref); assert.deepEqual(identity(held),identity(ref));
    assert(typeof held.path === 'string' && Buffer.isBuffer(held.data) && held.data.length === ref.bytes);
    assert.equal('sha256:'+createHash('sha256').update(held.data).digest('hex'),ref.hash); return held;
  };
  const json = held => JSON.parse(held.data.toString('utf8'));
  assert.equal(audit.schemaVersion,1); assert.equal(audit.kind,'webp-halo-source-audit-v1'); assert.equal(audit.status,'accepted');
  const expected = {candidateHash,artifactHash:candidate.artifact.hash,sourceHash:candidate.source.hash,
    producerHash:candidate.producerHash,platform:candidate.platform,arch:candidate.arch};
  for (const [key,value] of Object.entries(expected)) assert.equal(audit[key],value,'Audit authority differs: '+key);
  assert.deepEqual(audit.rule,RULE); assert.deepEqual(audit.rule,proof.rule); assert.deepEqual(audit.rule,native.haloRule);
  assert.equal(audit.nativeProbeHash,proof.nativeProbeHash);
  for (const key of ['ruleHash','matrixHash']) { assert.match(audit[key],HASH); assert.equal(audit[key],native[key]); }
  const names = ['upstreamArchive','originalVp8lMember','repairedVp8lMember','repairPatch','sourceProposal',
    'producerRecipe','compilerIdentity','featureLedger','nativeProbe','ruleFile','matrix'];
  assert.deepEqual(Object.keys(audit.primary).sort(),names.slice().sort());
  validateMatrixReference(audit.primary.matrix);
  const files = Object.fromEntries(names.map(name => [name,bound(auditPath,audit.primary[name])]));
  const a = candidate.alphaRepair;
  sameIdentity(audit.primary.upstreamArchive,candidate.source); sameIdentity(audit.primary.originalVp8lMember,a.before);
  sameIdentity(audit.primary.repairedVp8lMember,a.after); sameIdentity(audit.primary.repairPatch,a.patch);
  sameIdentity(audit.primary.producerRecipe,recipe);
  assert.equal(audit.primary.nativeProbe.hash,proof.nativeProbeHash);
  assert.equal(audit.primary.ruleFile.hash,audit.ruleHash); assert.deepEqual(json(files.ruleFile),audit.rule);
  assert.equal(audit.primary.matrix.hash,audit.matrixHash); assert.equal(audit.primary.featureLedger.hash,audit.featureLedgerHash);
  assert.deepEqual(json(files.nativeProbe),native);
  const d = candidate.producerDefinition;
  assert.deepEqual(json(files.compilerIdentity),{toolchain:d.toolchain,compileFlags:d.compileFlags,
    linkFlags:d.linkFlags,selectedDspMembers:d.members.filter(row => row.path.startsWith('src/dsp/'))});

  // The ledger binds the actual probes; it does not claim coverage from a count
  // or an invented fixture. Its exact membership is part of independent review.
  const ledger = json(files.featureLedger);
  assert.equal(ledger.matrixHash,audit.matrixHash); assert.equal(ledger.ruleHash,audit.ruleHash);
  assert.equal(ledger.kind,'webp-halo-feature-ledger-v1'); assert.equal(ledger.candidateHash,candidateHash);
  assert.equal(ledger.artifactHash,candidate.artifact.hash); assert.equal(ledger.nativeProbeHash,proof.nativeProbeHash);
  assert(Array.isArray(ledger.cases) && ledger.cases.length > 0);
  const matrix = json(files.matrix);
  validateMatrix(matrix); assert.deepEqual(matrix.rule,audit.rule);
  assert(Array.isArray(matrix.cases) && matrix.cases.length === ledger.cases.length);
  const paths = new Set(), reviewed = new Set([candidateHash,candidate.artifact.hash,candidate.producerHash,...names.map(name => audit.primary[name].hash)]);
  for (const [index,row] of ledger.cases.entries()) {
    const planned = matrix.cases[index]; assert.equal(row.id,planned.id);
    text(row.path); assert(!paths.has(row.path)); paths.add(row.path); assert.match(row.encodedHash,HASH);
    const observations = {};
    for (const key of ['featureEvidence','generationEvidence']) {
      observations[key] = json(bound(files.featureLedger.path,row[key])); reviewed.add(row[key].hash);
    }
    const observed = observations.featureEvidence, generation = observations.generationEvidence;
    assert.equal(observed.schemaVersion,1); assert.equal(observed.kind,'webp-bitstream-feature-observation-v1'); assert.equal(observed.status,'observed');
    assert.equal(observed.fixtureHash,row.encodedHash); assert.equal(observed.decodedValid,true);
    assert(positive(observed.bytes)&&observed.bytes<=67108864); assert.equal(observed.decoderVersion,0x010600);
    assert.equal(observed.runtimeReleased,true); assert.equal(observed.qualification,false);
    assert.deepEqual(observed.dimensions,planned.dimensions); assert.equal(observed.observerBuildHash,native.observerBuildHash);
    const collect=(parent,rows,emptyStderr=false)=>{
      assert(Array.isArray(rows)&&rows.length>0);const result=new Map();
      for(const ref of rows){text(ref.role);const held=bound(parent,ref,emptyStderr&&ref.role==='observer-stderr');reviewed.add(ref.hash);
        if(!result.has(ref.role))result.set(ref.role,[]);result.get(ref.role).push(held);}
      return result;
    };
    const one=(map,role)=>{assert(map.has(role)&&map.get(role).length===1,'Missing/ambiguous binding '+role);return map.get(role)[0];};
    const observerRefs=collect(bound(files.featureLedger.path,row.featureEvidence).path,observed.bindings,true);
    const fixtureRef=one(observerRefs,'fixture'); assert.equal(fixtureRef.hash,row.encodedHash);assert.equal(fixtureRef.bytes,observed.bytes);
    const observerBuild=one(observerRefs,'observer-build'),observerManifest=one(observerRefs,'observer-source-manifest'),artifact=one(observerRefs,'observer-artifact');
    assert.equal(observerBuild.hash,observed.observerBuildHash);assert.equal(observerManifest.hash,observed.observerSourceManifestHash);
    const build=json(observerBuild),manifest=json(observerManifest);assert.equal(build.kind,'webp-feature-observer-build-v1');assert.equal(build.status,'built-unqualified');
    sameIdentity(artifact,build.artifact);sameIdentity(observerManifest,build.sourceManifest);
    const sourceRoles={'observer.c':'observer-source','record.py':'observer-recorder','contract.py':'observer-contract','process.py':'observer-process',
      'evidence.py':'observer-evidence','build.py':'observer-builder','contract_test.py':'observer-contract-test','README.txt':'observer-readme'};
    assert.deepEqual(manifest.files.map(r=>r.path).sort(),Object.keys(sourceRoles).sort());
    assert.deepEqual(build.sources.map(r=>r.name).sort(),Object.keys(sourceRoles).sort());
    for(const [name,role] of Object.entries(sourceRoles)){sameIdentity(one(observerRefs,role),manifest.files.find(r=>r.path===name));sameIdentity(one(observerRefs,role),build.sources.find(r=>r.name===name));}
    const raw=json(one(observerRefs,'observer-stdout'));validateFeatureObservation(raw);
    for(const key of ['status','bytes','dimensions','decodedValid','features','decoderVersion'])assert.deepEqual(raw[key],observed[key]);
    assert.equal(one(observerRefs,'observer-stderr').bytes,0);
    const command=observed.command;assert.equal(command.status,'completed');assert.equal(command.exitCode,0);
    assert.equal(command.cleanup.status,'drained');assert.equal(command.cleanup.processGroupAbsent,true);assert.equal(command.cleanup.directChildExitCode,0);assert.deepEqual(command.cleanup.errors,[]);
    for(const name of ['stdout','stderr','cli'])sameIdentity(one(observerRefs,'observer-'+name),command[name]);
    const cli=json(one(observerRefs,'observer-cli'));assert.equal(cli.schemaVersion,1);
    assert(Array.isArray(cli.passDescriptors)&&cli.passDescriptors.length===1&&Number.isSafeInteger(cli.passDescriptors[0])&&cli.passDescriptors[0]>=0);
    assert.deepEqual(cli.command,[artifact.path,'--fd',String(cli.passDescriptors[0])]);
    assert.equal(generation.schemaVersion,1);assert.equal(generation.kind,'webp-halo-fixture-generation-proof-v1'); assert.equal(generation.status,'generated-unqualified');
    assert.equal(generation.qualification,false); assert.equal(generation.fixture.id,planned.id);
    assert.equal(generation.fixture.path,row.path); assert.equal(generation.fixture.hash,row.encodedHash);
    assert.equal(generation.fixture.bytes,observed.bytes); assert.deepEqual(generation.fixture.dimensions,planned.dimensions);
    text(generation.recipe.kind);assert(generation.recipe.options&&typeof generation.recipe.options==='object'&&!Array.isArray(generation.recipe.options)&&Object.keys(generation.recipe.options).length>0);
    const genRefs=collect(bound(files.featureLedger.path,row.generationEvidence).path,generation.bindings);
    const eventRef=one(genRefs,'generation-receipt');assert.equal(eventRef.hash,generation.generationReceiptHash);const event=json(eventRef);
    assert.equal(event.schemaVersion,1);assert.equal(event.kind,'webp-halo-fixture-generation-v1');assert.equal(event.status,'generated-unqualified');assert.equal(event.qualification,false);
    assert(Array.isArray(event.fixtures));const generatedRows=event.fixtures.filter(r=>r.path===row.path);assert.equal(generatedRows.length,1);const eventRow=generatedRows[0],g=eventRow.generation;
    assert.equal(eventRow.hash,row.encodedHash);assert.equal(eventRow.bytes,observed.bytes);assert.deepEqual([g.width,g.height],planned.dimensions);
    assert.equal(generation.recipe.kind,g.method??'sharp-webp');assert.deepEqual(generation.recipe.options,g.encoderOptions??{residual:g.residualEncoded.encoderOptions,background:g.backgroundEncoded.encoderOptions});
    sameIdentity(one(genRefs,'generator-source'),event.generator);assert.equal(one(genRefs,'generation-plan').hash,event.planHash);assert.equal(one(genRefs,'encoder-authority').hash,event.encoder.profileHash);
    const rawExpected=g.raw?[{bytes:g.rawBytes,hash:g.rawHash}]:[identity(g.residualRaw),identity(g.backgroundRaw)];
    assert.deepEqual((genRefs.get('raw-source')??[]).map(identity),rawExpected);
    const requires = planned.requiredFeatures;
    assert.deepEqual(Object.keys(requires).sort(),['contains','equals','minimum']);
    for (const [key,value] of Object.entries(requires.equals)) assert.deepEqual(observed.features[key],value,'Missing observed dependency class: '+key);
    for (const [key,values] of Object.entries(requires.contains)) {
      assert(Array.isArray(observed.features[key])); for (const value of values) assert(observed.features[key].some(v=>typeof v===typeof value&&v===value));
    }
    for (const [key,value] of Object.entries(requires.minimum)) assert(Number.isSafeInteger(observed.features[key])&&observed.features[key]>=value);
  }
  assert.equal(native.schemaVersion,2); assert.equal(native.kind,'webp-advanced-native-probe-v2');
  assert.equal(native.status,'passed-probe'); assert.equal(native.phase,'halo');
  assert.equal(native.candidateHash,candidateHash); assert.equal(native.artifactHash,candidate.artifact.hash);
  assert.equal(native.oracleHash,candidate.oracle.hash); assert.equal(native.completedLoadOrderCount,2);
  assert.equal(native.qualificationIssued,false);assert.equal(native.fixtureCount,matrix.cases.length);assert.match(native.fixtureManifestHash,HASH);
  assert.match(native.observerBuildHash,HASH);
  assert(Array.isArray(nativeChildren)&&nativeChildren.length===2);
  assert.deepEqual(native.loadOrders.map(row=>row.order),['oracle-first','advanced-first']);
  let previousPixels;
  for (const [orderIndex,child] of nativeChildren.entries()) {
    const parentRow=native.loadOrders[orderIndex]; assert.equal(parentRow.exitCode,0);
    const held=bound(files.nativeProbe.path,{path:parentRow.receipt,bytes:parentRow.receiptBytes,hash:parentRow.receiptHash});
    assert.deepEqual(json(held),child); reviewed.add(held.hash);
    assert.equal(child.schemaVersion,2);assert.equal(child.kind,'webp-advanced-native-child-v2');assert.equal(child.qualificationIssued,false);
    assert.deepEqual(child.haloRule,audit.rule);assert.equal(child.fixtureManifestHash,native.fixtureManifestHash);
    assert.equal(child.status,'passed-probe'); assert.equal(child.order,parentRow.order); assert.equal(child.phase,'halo');
    assert.equal(child.candidateHash,candidateHash); assert.equal(child.artifactHash,candidate.artifact.hash);
    assert.equal(child.oracleHash,candidate.oracle.hash); assert.equal(child.observerBuildHash,native.observerBuildHash);
    assert.equal(child.ruleHash,audit.ruleHash); assert.equal(child.matrixHash,audit.matrixHash);
    assert.deepEqual(child.cases.map(row => row.path),ledger.cases.map(row => row.path));
    const counts={completedCaseCount:0,completedDecodeCount:0,completedPixelComparisonCount:0,comparedPixelCount:0}, pixels=[];
    for (let i=0;i<child.cases.length;i++) {
      const actual = child.cases[i], row = ledger.cases[i], planned=matrix.cases[i]; assert.equal(actual.encodedHash,row.encodedHash);
      assert.equal(actual.id,planned.id); assert.deepEqual(actual.dimensions,planned.dimensions); assert.equal(actual.status,'passed-case');
      assert.equal(actual.featureEvidenceHash,row.featureEvidence.hash); assert.equal(actual.generationEvidenceHash,row.generationEvidence.hash);
      assert.deepEqual(actual.regions.map(r=>r.core),planned.regions); assert.equal(actual.plannedRegionCount,planned.regions.length);
      assert.equal(actual.completedDecodeCount,planned.regions.length); assert.equal(actual.completedPixelComparisonCount,planned.regions.length);
      assert.match(actual.fullOracleHash,HASH); assert.equal(actual.reconstructedHash,actual.fullOracleHash);
      let pixelCount=0;
      for (const region of actual.regions) {
        const [x,y,w,h]=region.core,[W,H]=planned.dimensions,r=audit.rule;
        assert([x,y,w,h,W,H].every(Number.isSafeInteger)); assert(x>=0&&y>=0&&w>0&&h>0&&x+w<=W&&y+h<=H);
        const left=Math.floor(Math.max(0,x-r.left)/r.originAlignment)*r.originAlignment,top=Math.floor(Math.max(0,y-r.top)/r.originAlignment)*r.originAlignment;
        const roi=[left,top,Math.min(W,x+w+r.right)-left,Math.min(H,y+h+r.bottom)-top]; assert.deepEqual(region.roi,roi);
        assert.equal(region.status,0); assert.equal(region.completedDecode,true); assert.equal(region.completedPixelComparison,true);
        assert.equal(region.comparedPixelCount,w*h); assert.match(region.actualCoreHash,HASH); assert.equal(region.actualCoreHash,region.expectedCoreHash);
        assert(roi[2]<=8192&&roi[3]<=8192&&roi[2]*roi[3]<=25000000);
        const m=region.metrics; assert.equal(m.native_remaining,0); assert.equal(m.output_remaining,0); assert.equal(m.allocation_denied,0);
        assert(Number.isSafeInteger(m.native_peak)&&m.native_peak>=0&&m.native_peak<=134217728);
        assert(positive(m.output_peak)&&m.output_peak<=Math.ceil(roi[2]*roi[3]*4/16384)*16384); assert.equal(m.output_bytes_written,roi[2]*roi[3]*4);
        pixelCount+=w*h;
      }
      assert.equal(actual.comparedPixelCount,pixelCount); counts.completedCaseCount++;
      counts.completedDecodeCount+=planned.regions.length; counts.completedPixelComparisonCount+=planned.regions.length; counts.comparedPixelCount+=pixelCount;
      pixels.push({path:actual.path,full:actual.fullOracleHash,reconstructed:actual.reconstructedHash,
        cores:actual.regions.map(r=>({core:r.core,roi:r.roi,actual:r.actualCoreHash,expected:r.expectedCoreHash}))});
    }
    assert.deepEqual(child.counts,counts); assert.deepEqual(counts,matrix.expectedPerLoadOrder);
    const keys=['kind','schemaVersion','status','phase','order','candidateHash','artifactHash','oracleHash','haloRule','fixtureManifestHash','counts'];
    const summary=Object.fromEntries(keys.map(key=>[key,child[key]]));summary.cases=child.cases.map(r=>Object.fromEntries(['path','encodedHash','dimensions','status','plannedRegionCount','completedDecodeCount','completedPixelComparisonCount','comparedPixelCount'].map(key=>[key,r[key]])));
    assert.deepEqual(summary,parentRow.summary);
    if(previousPixels)assert.deepEqual(pixels,previousPixels); else previousPixels=pixels;
  }
  assert.deepEqual(native.counts,Object.fromEntries(Object.entries(matrix.expectedPerLoadOrder).map(([key,value])=>[key,2*value])));
  assert(Array.isArray(audit.dependencyFindings)); assert.deepEqual(audit.dependencyFindings.map(row => row.id).sort(),DEPENDENCY_FINDINGS.slice().sort());
  for (const finding of audit.dependencyFindings) {
    assert.equal(finding.disposition,'closed'); text(finding.argument); assert(Array.isArray(finding.sources) && finding.sources.length > 0);
    for (const source of finding.sources) {
      assert(['pristine','repaired','producer'].includes(source.tree)); text(source.member);
      const inventory = source.tree === 'producer' ? candidate.inputs : d.sourceTrees[source.tree];
      const expectedMember = inventory.find(row => row.path === source.member); assert(expectedMember,'Unbound dependency source member');
      sameIdentity(source.reference,expectedMember); const held = bound(auditPath,source.reference); reviewed.add(source.reference.hash);
      const lines = held.data.toString('utf8').split('\n');
      assert(positive(source.startLine) && positive(source.endLine) && source.startLine <= source.endLine && source.endLine <= lines.length);
      assert(source.endLine-source.startLine < 512,'A finding needs a focused source excerpt');
      assert.equal(source.excerpt,lines.slice(source.startLine-1,source.endLine).join('\n'));
    }
  }
  const review = audit.independentReview; text(review.reviewer); assert.equal(review.disposition,'accepted');
  assert.deepEqual(review.unresolvedBlocking,[]); assert(Array.isArray(review.limits)); review.limits.forEach(text);
  assert(Array.isArray(review.reviewedInputHashes)); review.reviewedInputHashes.forEach(value => assert.match(value,HASH));
  assert.equal(new Set(review.reviewedInputHashes).size,review.reviewedInputHashes.length);
  for (const value of reviewed) assert(review.reviewedInputHashes.includes(value),'Independent review omits an actual primary or source input');
  return {sourceAuditHash:proof.sourceAudit.hash,ruleHash:audit.ruleHash,matrixHash:audit.matrixHash,featureLedgerHash:audit.featureLedgerHash};
}
