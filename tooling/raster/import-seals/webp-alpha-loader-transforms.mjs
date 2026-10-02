// Trusted finite source derivation, never captured-module execution.
import assert from 'node:assert/strict';
import {HASH,hash,canonical,replaceExact,repositoryPath} from './webp-alpha-loader-policy.mjs';

const MODULES=Object.freeze([
 ['transform','server/raster/webp-import/tile-plan.ts','dist/local/server/raster/webp-import/tile-plan.js'],
 ['transform','server/raster/webp-import/adapter.ts','dist/local/server/raster/webp-import/adapter.js'],
 ['transform','server/raster/import-profile.ts','dist/local/server/raster/import-profile.js'],
 ['transform','server/raster/import-producers.ts','dist/local/server/raster/import-producers.js'],
 ['transform','server/raster/profile-registry.ts','dist/local/server/raster/profile-registry.js'],
 ['transform','server/raster/inspect-original.ts','dist/local/server/raster/inspect-original.js'],
 ['transform','server/storage/raster.ts','dist/local/server/storage/raster.js'],
 ['guard-only','server/raster/import-inventory.ts','dist/local/server/raster/import-inventory.js'],
]);
function keys(value,expected){
 assert(value&&typeof value==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(value)));
 assert.deepEqual(Reflect.ownKeys(value).sort(),[...expected].sort(),'Compiled review fields differ');
}
function pin(row){
 keys(row,['repositoryPath','bytes','hash']);repositoryPath('/original-review',row.repositoryPath);
 assert(Number.isSafeInteger(row.bytes)&&row.bytes>0);assert.match(row.hash,HASH);
}

const freeze='const __candidateFreeze = value => { if (value && typeof value === "object") { for (const item of Object.values(value)) __candidateFreeze(item); Object.freeze(value); } return value; };';

/** A source review cannot establish actual compiler emission or approve an
 * execution. Only a separately reviewed, retained fresh capture can do that. */
export function assertAlphaCompiledReview(baseline){
 keys(baseline,['kind','status','commonOverlay','commonSourceTargets','compiledCapture','modules',
  'canonicalCorrection','requiredSharedTargets','sourceAuthorityHash']);
 assert.equal(baseline.kind,'webp-candidate-loader-reviewed-inputs-v1');
 assert.equal(baseline.status,'compiled-reviewed-unexecuted','Candidate loader is pending genuine compiled capture and exact-anchor review');
 const capture=baseline.compiledCapture;
 assert(capture&&capture.kind==='webp-candidate-compiled-review-v1'&&capture.reviewed===true,'Reviewed fresh compiler evidence is required');
 keys(capture,['kind','reviewed','node','commonOverlayHash','sourceHash','compiledHash','canonicalCorrectionHash',
  'commonSourceAuthorityHash','runtimeDependenciesHash','buildProof','retainedModules']);
 assert(Array.isArray(baseline.modules)&&baseline.modules.length===MODULES.length);
 assert.deepEqual(baseline.modules.map(row=>{keys(row,['role','source','compiled']);pin(row.source);pin(row.compiled);
  return [row.role,row.source.repositoryPath,row.compiled.repositoryPath];}),MODULES,'The finite reviewed loader seam differs');
 assert(Array.isArray(baseline.commonSourceTargets)&&Number.isSafeInteger(baseline.requiredSharedTargets)&&
  baseline.requiredSharedTargets>0&&baseline.requiredSharedTargets<=8192);
 for(const row of baseline.commonSourceTargets)pin(row);
 assert.equal(new Set(baseline.commonSourceTargets.map(row=>row.repositoryPath)).size,baseline.commonSourceTargets.length);
 assert.equal(capture.node,'26.10.0');assert.equal(capture.commonOverlayHash,baseline.commonOverlay.manifestHash);
 assert.equal(baseline.canonicalCorrection.dependsOnCommonManifestHash,baseline.commonOverlay.manifestHash);
 assert.equal(capture.canonicalCorrectionHash,baseline.canonicalCorrection.manifestHash);
 assert.equal(baseline.sourceAuthorityHash,hash(canonical({commonOverlay:baseline.commonOverlay,canonicalCorrection:baseline.canonicalCorrection,commonSourceTargets:baseline.commonSourceTargets})));
 assert.equal(capture.commonSourceAuthorityHash,baseline.sourceAuthorityHash);
 assert.equal(baseline.commonSourceTargets.length,baseline.requiredSharedTargets);

 for(const key of ['sourceHash','compiledHash','runtimeDependenciesHash'])assert.match(capture[key],HASH);
 keys(capture.buildProof,['path','bytes','hash']);
 assert(capture.buildProof&&typeof capture.buildProof.path==='string');assert.match(capture.buildProof.hash,HASH);
 assert(Number.isSafeInteger(capture.buildProof.bytes)&&capture.buildProof.bytes>0);
 assert.equal(baseline.modules.filter(row=>row.role==='transform').length,7);assert.equal(baseline.modules.filter(row=>row.role==='guard-only').length,1);
 assert.equal(new Set(baseline.modules.map(row=>row.compiled.repositoryPath)).size,8);
 for(const row of baseline.modules){assert(Number.isSafeInteger(row.compiled.bytes)&&row.compiled.bytes>0);assert.match(row.compiled.hash,HASH);}
 assert(Array.isArray(capture.retainedModules)&&capture.retainedModules.length===8);
 assert.deepEqual(capture.retainedModules.map(({path,...row})=>{assert(typeof path==='string');return row;}),baseline.modules.map(row=>row.compiled));
 return capture;
}

/** Exact original module hashes, literal anchors, and finite replacement counts
 * constrain the seam. These literals remain unapproved until genuine capture. */
export function transformAlphaCompiled(baseline,repositoryPath,source,binding){
 assertAlphaCompiledReview(baseline);
 const pin=baseline.modules.find(row=>row.role==='transform'&&row.compiled.repositoryPath===repositoryPath)?.compiled;
 assert(pin,'Module is outside the reviewed candidate seam');
 assert.equal(Buffer.byteLength(source),pin.bytes,'Reviewed compiled module length changed');
 assert.equal(hash(source),pin.hash,'Reviewed compiled module hash changed');
 const {adapterSeal,candidateAuthorization,profile}=binding,auth=candidateAuthorization.authorizationHash;
 const substitutions=[],add=(id,from,to,count=1)=>substitutions.push({id,from,to,count});
 if(repositoryPath.endsWith('/webp-import/tile-plan.js')){
  add('candidate-seal-equality-import','export const WEBP_NATIVE_BYTES',"import { isDeepStrictEqual as __candidateSealEqual } from 'node:util';\nexport const WEBP_NATIVE_BYTES");
  add('candidate-seal-exact-authorization','export function validateWebPIdentity(seal) {',
   'export function validateWebPIdentity(seal) {\n    if (!__candidateSealEqual(seal, '+JSON.stringify(adapterSeal)+")) throw Error('RASTER_CODEC_UNQUALIFIED');");
  add('candidate-seal-status',"seal.status !== 'qualified'","seal.status !== 'built-unqualified'");
  add('candidate-seal-hash-namespace','seal.qualificationHash','seal.authorizationHash');
 }else if(repositoryPath.endsWith('/webp-import/adapter.js')){
  // Observation is synchronous after an actual native return and before all
  // existing checks. A thrown FFI call produces no invented return or metrics.
  const declaration='let activePreparation = false;';
  add('native-observation-drain-export',declaration,
   freeze+'\nlet __candidateNativeObservations = [], __candidatePreparationIndex = 0;\n'+
   'export function takeCandidateWebPNativeTelemetry() { const rows = Object.freeze(__candidateNativeObservations); __candidateNativeObservations = []; return rows; }\n'+declaration);
  const initialization='let nativePeak = 0, outputPeak = 0, copiedBytes = 0, tileCount = 0;';
  add('native-preparation-observation-inventory',initialization,initialization+'\n        const __candidateNativeTiles = [], __candidatePreparation = __candidatePreparationIndex++;');
  const request='const request = encodeWebPRequest(original, reservation, region, requestBuffer);';
  add('native-request-before-call-snapshot',request,request+'\n            const __candidateRequestBase64 = request.toString("base64"), __candidateRequestHash = "sha256:" + createHash("sha256").update(request).digest("hex");');
  const metrics='const m = metricsFrom(nativeMetrics);';
  add('native-return-buffer-observation',metrics,metrics+'\n            try {\n            const __candidateObservation = __candidateFreeze({ candidateHash: '+JSON.stringify(adapterSeal.candidateHash)+', authorizationHash: '+JSON.stringify(auth)+
   ', preparationIndex: __candidatePreparation, tileIndex: __candidateNativeTiles.length, region: { ...region }, requestBase64: __candidateRequestBase64, requestHash: __candidateRequestHash, metricsBase64: nativeMetrics.toString("base64"), metricsHash: "sha256:" + createHash("sha256").update(nativeMetrics).digest("hex"), nativeStatus: result, nativePeak: m.nativePeak, nativeRemaining: m.nativeRemaining, allocationDenied: Number(m.allocationDenied), outputPeak: m.outputPeak, outputRemaining: m.outputRemaining, outputBytesWritten: m.outputBytesWritten, outputBudget: reservation.outputMappingBytes });\n            __candidateNativeTiles.push(__candidateObservation); __candidateNativeObservations.push(__candidateObservation);\n            } finally {');
  const cap='if (nativePeak > reservation.nativeBytes || outputPeak > reservation.outputMappingBytes)';
  add('native-observation-leak-guard-finally',cap,'}\n            '+cap);
  const returned="profile: 'encoded-rgba8', inspectionHash: original.inspectionHash, nativePeak, outputPeak, reservation, dispose";
  add('native-success-observation-result',returned,returned+', nativeStatus: __candidateNativeTiles.at(-1)?.nativeStatus, nativeRemaining: __candidateNativeTiles.reduce((n, row) => n + row.nativeRemaining, 0), allocationDenied: __candidateNativeTiles.reduce((n, row) => n + row.allocationDenied, 0), outputRemaining: __candidateNativeTiles.reduce((n, row) => n + row.outputRemaining, 0), outputBytesWritten: __candidateNativeTiles.reduce((n, row) => n + row.outputBytesWritten, 0), outputBudget: reservation.outputMappingBytes, tileCount: __candidateNativeTiles.length, nativeTiles: Object.freeze(__candidateNativeTiles)');
 }else if(repositoryPath.endsWith('/import-profile.js')){
  const issued='export const ISSUED_IMPORT_PROFILES = Object.freeze(IMPORT_INVENTORY.profiles);';
  const empty="if (IMPORT_INVENTORY.schemaVersion !== 1 || Object.keys(IMPORT_INVENTORY).sort().join(',') !== 'activeProfiles,capsules,jpeg,profiles,schemaVersion,webp' || !['capsules','profiles','activeProfiles','jpeg','webp'].every(key => Array.isArray(IMPORT_INVENTORY[key]) && IMPORT_INVENTORY[key].length === 0)) throw Error('CANDIDATE_REQUIRES_EMPTY_IMPORT_INVENTORY');";
  add('separate-candidate-profile-inventory',issued,issued+'\n'+empty+'\n'+freeze+'\nexport const CANDIDATE_IMPORT_PROFILES = __candidateFreeze(['+JSON.stringify(profile)+']);\n'+
   'export const ACTIVE_CANDIDATE_IMPORT_PROFILES = __candidateFreeze(CANDIDATE_IMPORT_PROFILES.filter(profile => profile.pipeline === '+JSON.stringify(profile.pipeline)+' && profile.baseCodec === CODEC_ID));');
  add('candidate-profile-authority','!hash(profile.qualificationHash)',
   '(!hash(profile.candidateAuthorizationHash) || profile.candidateAuthorizationHash !== '+JSON.stringify(auth)+' || profile.candidateHash !== '+JSON.stringify(adapterSeal.candidateHash)+
   " || profile.namespace !== 'webp-candidate-host-v1' || profile.kind !== 'webp-candidate-import-profile-v1' || profile.status !== 'built-unqualified' || profile.qualified !== false || Object.hasOwn(profile, 'qualificationHash'))");
  add('candidate-profile-resolution','(execution ? ACTIVE_IMPORT_PROFILES : ISSUED_IMPORT_PROFILES)','(execution ? ACTIVE_CANDIDATE_IMPORT_PROFILES : CANDIDATE_IMPORT_PROFILES)');
 }else if(repositoryPath.endsWith('/import-producers.js')){
  add('candidate-active-profile-routing','ACTIVE_IMPORT_PROFILES','ACTIVE_CANDIDATE_IMPORT_PROFILES',2);
  const issued='export const ISSUED_WEBP_IMPORT_SEALS = Object.freeze(IMPORT_INVENTORY.webp);';
  add('separate-candidate-seal-inventory',issued,issued+'\n'+freeze+'\nexport const CANDIDATE_WEBP_IMPORT_SEALS = __candidateFreeze(['+JSON.stringify(adapterSeal)+']);\n'+
   'const __candidateArtifactPath = path => { if (path !== '+JSON.stringify(adapterSeal.artifact.path)+") throw Error('RASTER_CODEC_UNQUALIFIED'); return path; };");
  add('candidate-webp-seal-routing','? ISSUED_JPEG_IMPORT_SEALS : ISSUED_WEBP_IMPORT_SEALS','? ISSUED_JPEG_IMPORT_SEALS : CANDIDATE_WEBP_IMPORT_SEALS');
  add('candidate-seal-profile-binding','s.qualificationHash === profile.qualificationHash','s.authorizationHash === profile.candidateAuthorizationHash && s.candidateHash === profile.candidateHash');
  add('candidate-exact-artifact-locator','path: resolveImportArtifactPath(seal.artifact.path)','path: __candidateArtifactPath(seal.artifact.path)');
  add('native-observation-import',"import { prepareOversizedWebP } from './webp-import/adapter.js';","import { prepareOversizedWebP, takeCandidateWebPNativeTelemetry } from './webp-import/adapter.js';");
  const awaitWebP='source = await prepareOversizedWebP({ original: { path: job.path, descriptor: inspected.webpMetadata, effectiveAlpha: metadata.hasAlpha, inspectionHash: job.plan.inspectionHash }, output: sourcePath, seal, admit: admission, check, cancellation, journal: { record(path) { child(path); }, remove(path) { child(path); } }, quarantine() { Atomics.store(new Uint32Array(cancellation), 0, 1); } });';
  add('native-return-existing-worker-telemetry',awaitWebP,
   'if (takeCandidateWebPNativeTelemetry().length) throw Error("CANDIDATE_UNCLAIMED_NATIVE_OBSERVATIONS");\n            try { '+awaitWebP+' } finally {\n                const nativeTiles = takeCandidateWebPNativeTelemetry();\n                if (telemetry && nativeTiles.length) Object.assign(telemetry.metrics, { nativeTiles, nativeStatus: nativeTiles.at(-1).nativeStatus, nativePeak: Math.max(...nativeTiles.map(row => row.nativePeak)), nativeRemaining: nativeTiles.reduce((n, row) => n + row.nativeRemaining, 0), allocationDenied: nativeTiles.reduce((n, row) => n + row.allocationDenied, 0), outputPeak: Math.max(...nativeTiles.map(row => row.outputPeak)), outputRemaining: nativeTiles.reduce((n, row) => n + row.outputRemaining, 0), outputBytesWritten: nativeTiles.reduce((n, row) => n + row.outputBytesWritten, 0), outputBudget: nativeTiles[0].outputBudget, tileCount: nativeTiles.length });\n            }');
 }else{
  const consumers={
   'dist/local/server/raster/profile-registry.js':['ISSUED_IMPORT_PROFILES','CANDIDATE_IMPORT_PROFILES',3],
   'dist/local/server/raster/inspect-original.js':['ISSUED_IMPORT_PROFILES','ACTIVE_CANDIDATE_IMPORT_PROFILES',2],
   'dist/local/server/storage/raster.js':['ACTIVE_IMPORT_PROFILES','ACTIVE_CANDIDATE_IMPORT_PROFILES',2],
  };
  assert(Object.hasOwn(consumers,repositoryPath));const [from,to,count]=consumers[repositoryPath];add('candidate-inventory-consumer-routing',from,to,count);
 }
 const result=replaceExact(source,substitutions);
 return {...result,repositoryPath,original:{bytes:pin.bytes,hash:pin.hash},transformed:{bytes:Buffer.byteLength(result.source),hash:hash(result.source)}};
}
