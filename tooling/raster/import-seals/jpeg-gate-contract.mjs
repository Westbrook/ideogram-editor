// Pure receipt validation; successful subprocess exit alone never proves pixels.
import assert from 'node:assert/strict';
const hash=value=>assert.match(value,/^sha256:[a-f0-9]{64}$/);
const natural=value=>assert(Number.isSafeInteger(value)&&value>=0);
const nativeRuntime=(candidate,receipt,key)=>{const runtime=receipt.runtime;assert(runtime&&typeof runtime==='object');assert.equal(runtime.platform,candidate.platform);assert.equal(runtime.arch,candidate.arch);assert.equal(runtime.execution,candidate.execution.mode);assert.equal(typeof runtime.os,'string');assert(runtime.os.length>0);assert.equal(typeof runtime[key],'string');assert(runtime[key].length>0);if(key==='node')assert.equal(runtime.node,'26.10.0');};
const bind=(candidate,candidateHash,receipt)=>{
 assert.equal(receipt.schemaVersion,1);assert(['passed','passed-probe'].includes(receipt.status));
 assert.equal(receipt.candidateHash,candidateHash);assert.equal(receipt.artifactHash,candidate.artifact.hash);
};
export function validateAllocator(candidate,candidateHash,receipt){
 bind(candidate,candidateHash,receipt);nativeRuntime(candidate,receipt,'node');assert.equal(receipt.kind,'jpeg-scanline-allocator-probe-v1');
 assert.equal(receipt.completedHarnessCount,1);assert.equal(receipt.exitCode,0);assert.equal(receipt.signal,null);assert.equal(receipt.error,'');
 assert.equal(receipt.harnessHash,candidate.allocatorHarness.hash);hash(receipt.fixtureHash);
}
function parity(candidate,candidateHash,receipt,order){
 bind(candidate,candidateHash,receipt);nativeRuntime(candidate,receipt,'python');assert.equal(receipt.kind,'jpeg-scanline-native-parity-v1');assert.equal(receipt.loadOrder,order);hash(receipt.fixtureManifestHash);
 assert(Array.isArray(receipt.cases)&&receipt.cases.length>=8);let oversized=0,progressive=0,white=0;const fixtures=new Set();
 for(const row of receipt.cases){
  hash(row.fixtureHash);assert(!fixtures.has(row.fixtureHash),'Each positive case must be a distinct retained encoded fixture');fixtures.add(row.fixtureHash);
  assert.equal(row.status,'passed');assert.equal(row.nativeStatus,0);assert.equal(row.nativeRemaining,0);assert.equal(row.nativeDenied,0);
  assert(Number.isSafeInteger(row.nativePeak)&&row.nativePeak>0&&row.nativePeak<=128*1048576);
  assert(Number.isSafeInteger(row.width)&&row.width>0&&Number.isSafeInteger(row.height)&&row.height>0&&row.width*row.height<=25000000);
  assert.equal(row.comparedBytes,row.width*row.height*4);assert.equal(row.oracleDecodes,2);assert.equal(typeof row.progressive,'boolean');assert.equal(typeof row.independentWhiteMatch,'boolean');
  assert(Array.isArray(row.pixelHashes)&&row.pixelHashes.length===3);row.pixelHashes.forEach(hash);assert(row.pixelHashes.every(value=>value===row.pixelHashes[0]));
  oversized+=Number(row.width>8192||row.height>8192);progressive+=Number(row.progressive);white+=Number(row.independentWhiteMatch);
 }
 assert.equal(receipt.positiveDecodes,receipt.cases.length);assert.equal(receipt.positiveOracleDecodes,2*receipt.cases.length);
 assert.equal(receipt.oversizedPositiveDecodes,oversized);assert(oversized>=4);assert.equal(receipt.progressivePositiveDecodes,progressive);assert(progressive>=4);
 assert.equal(receipt.independentWhiteMatches,white);assert(white>=2);natural(receipt.negativeChecks);assert(receipt.negativeChecks>=2*receipt.cases.length+1);
}
export function validateParityPair(candidate,candidateHash,first,second){
 parity(candidate,candidateHash,first,'bounded-first');parity(candidate,candidateHash,second,'oracle-first');
 assert.equal(first.fixtureManifestHash,second.fixtureManifestHash);
 const observations=receipt=>receipt.cases.map(({nativePeak,...row})=>row);
 assert.deepEqual(observations(first),observations(second),'Both load orders must complete the same actual comparisons');
}
export const HOST_CASES=Object.freeze({
 'host-ffi':['abi-version','argument-layout','atomic-cancellation','held-descriptor','two-load-orders'],
 'host-cleanup':['source-mutation','source-replacement','output-rename','output-replacement','parent-fsync-retry','controlled-p3-normalization','active-cancellation','reservation-retained-on-failure'],
 'color-orientation-cp1':['srgb','display-p3','all-eight-orientations','cp1-crop','cp1-resize','pinned-overlap-parity','oversized-baseline','oversized-progressive'],
 'durability':['original-retention','expired-plan-rejection','exact-preview-approval','cancel-before-commit','commit-wins-cancel','same-command-retry','copy-import-recopy','restart-recovery','deletion-cleanup'],
});
function observedEnvironment(candidate,receipt){
 const env=receipt.environment;assert(env&&typeof env==='object');assert.equal(env.platform,candidate.platform);assert.equal(env.arch,candidate.arch);assert.equal(env.node,'26.10.0');assert.equal(env.execution,candidate.execution.mode);assert.equal(typeof env.os,'string');assert(env.os.trim().length>0);
 assert(Array.isArray(receipt.logs)&&receipt.logs.length>0&&receipt.logs.length<=16,'Actual retained execution logs required');
 for(const log of receipt.logs){hash(log.hash);assert.equal(typeof log.path,'string');assert(log.path.length>0);assert(Number.isSafeInteger(log.bytes)&&log.bytes>0&&log.bytes<=8388608);}
}
export function validateHost(candidate,candidateHash,receipt,role){
 bind(candidate,candidateHash,receipt);assert(Object.hasOwn(HOST_CASES,role));assert.equal(receipt.kind,'jpeg-scanline-'+role+'-v1');observedEnvironment(candidate,receipt);
 assert(Array.isArray(receipt.cases));assert.deepEqual(receipt.cases.map(row=>row.id).sort(),[...HOST_CASES[role]].sort());let total=0;
 for(const row of receipt.cases){assert.equal(row.status,'passed-case');assert(Number.isSafeInteger(row.completedChecks)&&row.completedChecks>0);assert(Number.isFinite(row.elapsedMs)&&row.elapsedMs>=0);total+=row.completedChecks;}
 assert.equal(receipt.completedCases,receipt.cases.length);assert.equal(receipt.completedChecks,total);assert(total>0);
}
export function validateResource(candidate,candidateHash,receipt,role){
 bind(candidate,candidateHash,receipt);assert.equal(receipt.measurement,'whole-process-rss');assert.equal(receipt.capBytes,512*1048576);
 assert(['native-resources','writer-resources'].includes(role));assert.equal(receipt.kind,'jpeg-scanline-'+role+'-v1');observedEnvironment(candidate,receipt);
 assert(Number.isSafeInteger(receipt.maxRSSBytes)&&receipt.maxRSSBytes>0&&receipt.maxRSSBytes<=receipt.capBytes);assert.equal(receipt.residualAllocations,0);
 assert(Array.isArray(receipt.jobs)&&receipt.jobs.length>=4);assert.deepEqual(receipt.jobs.map(row=>row.case).sort(),['baseline-oversized','contended-baseline','progressive-oversized','repeated-baseline']);const ids=new Set();let peak=0;
 for(const row of receipt.jobs){assert.equal(typeof row.id,'string');assert(row.id.length>0&&!ids.has(row.id));ids.add(row.id);assert(Number.isSafeInteger(row.originalWidth)&&row.originalWidth>0&&Number.isSafeInteger(row.originalHeight)&&row.originalHeight>0&&row.originalWidth*row.originalHeight>25000000);assert.equal(row.status,'completed');assert.equal(row.role,role);assert.equal(row.nativeRemaining,0);assert(Number.isSafeInteger(row.maxRSSBytes)&&row.maxRSSBytes>0&&row.maxRSSBytes<=receipt.capBytes);peak=Math.max(peak,row.maxRSSBytes);}
 assert.equal(receipt.completedJobs,receipt.jobs.length);assert.equal(receipt.maxRSSBytes,peak);
}
