// Pure qualification validation. It neither runs image work nor creates evidence.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

export const PNG_ROLES=Object.freeze(['pixels','color-orientation-cp1','resources','durability']);
export const PNG_HOST_SOURCE_PATHS=Object.freeze([
 'server/raster/derive-original.ts','server/raster/import-producers.ts','server/raster/import-file-transform.ts','server/raster/import-color.ts','server/raster/png.ts','server/raster/inspect-original.ts','server/raster/engine.ts','server/raster/worker.ts','server/raster/worker-owner.ts','server/raster/worker-protocol.ts','server/storage/raster.ts','server/storage/writer.ts','server/storage/worker.ts','server/storage/database.ts'
].sort());
// Fixed integrated runtime source graph; native binaries are separately bound by baseCodec.
const RETAINED_PNG_SOURCE_PATHS=Object.freeze([
 "server/raster/active-compute.ts",
 "server/raster/bounded-webp.ts",
 "server/raster/codec-platform.ts",
 "server/raster/identities/linux-arm64-v1.ts",
 "server/raster/identities/linux-x64-v1.ts",
 "server/raster/identity.ts",
 "server/raster/import-file-transform.ts",
 "server/raster/linux-color-arm64-identity.ts",
 "server/raster/linux-color-platform.ts",
 "server/raster/linux-color-x64-identity.ts",
 "server/raster/linux-color.ts",
 "server/raster/png-import.ts",
 "server/raster/png-input.ts",
 "server/raster/png.ts",
 "server/raster/webp-color.ts",
 "server/raster/webp-identity.ts",
 "server/raster/webp-linux-arm64-identity.ts",
 "server/raster/webp-linux-x64-identity.ts",
 "server/raster/webp-metadata.ts",
 "server/raster/webp-output-darwin-arm64-identity.ts",
 "server/raster/webp-output-linux-arm64-identity.ts",
 "server/raster/webp-output-linux-x64-identity.ts",
 "server/raster/webp-output-platform.ts",
 "server/raster/webp-output.ts",
 "server/raster/webp-platform.ts",
 "server/raster/webp.ts",
 "server/storage/errors.ts",
 "server/storage/files.ts",
 "src/adapters/profile.ts",
 "src/composition/core.ts",
 "src/observability/diagnostic-memory.ts",
 "src/observability/phases.ts",
 "src/protocol/adapters.ts",
 "src/protocol/document-creation.ts",
 "src/protocol/export.ts",
 "src/protocol/json.ts",
 "src/protocol/portable.ts",
 "src/protocol/queue-events.ts",
 "src/protocol/raster-import.ts",
 "src/protocol/request-edits.ts",
 "src/protocol/sha256.ts",
 "src/protocol/text.ts",
 "src/protocol/v45-inputs.ts",
 "src/protocol/validate.ts",
 "src/raster/core.ts",
 "src/raster/mapping.ts",
 "src/raster/mask.ts",
 "src/request/core.ts",
 "src/request/raster-plan.ts",
 "src/request/text-treatment.ts",
 "src/text/returned-description.ts"
]);
// Preserve only these reviewed retained definitions' exact old source shape.
// Canonical digests and separately retained issuer authority remain required;
// this compatibility cannot qualify changed current bytes or another issuer.
const RETAINED_PNG_SOURCE_HASHES=new Set([
 'sha256:89b46e2028d98fffc81c1129f169cfa5df0931ec7960e4f96cc9a67b32007016',
 'sha256:9b63256e6c50861fee5cf1339541ff6cc5eef5b9248c5e0a15b3be359515aaab',
 'sha256:2a1ee24eceaa18b99045378bdfe5c3a42068649fc490d2059a8e52875e05f62b',
]);
export const PNG_SOURCE_PATHS=Object.freeze([...RETAINED_PNG_SOURCE_PATHS,'server/raster/resource-plan.ts'].sort());
export const PNG_CASES=Object.freeze({
 pixels:Object.freeze(['filter-0','filter-1','filter-2','filter-3','filter-4','adam7-all-seven-passes','gray-1','gray-2','gray-4','gray-8','rgb-8','indexed-1','indexed-2','indexed-4','indexed-8','gray-alpha-8','rgba-8','trns-gray','trns-rgb','trns-indexed','hidden-rgb']),
 'color-orientation-cp1':Object.freeze(['untagged-srgb','tagged-srgb','display-p3',...Array.from({length:8},(_,i)=>'orientation-'+(i+1)),'crop-exact','resize-minify','resize-magnify','oversized-resize','oversized-crop']),
 resources:Object.freeze(['oversized-noninterlaced','oversized-adam7','repeated-resize','contended-crop']),
 durability:Object.freeze(['original-retention','expired-plan-rejection','exact-preview-approval','cancel-before-commit','commit-wins-cancel','same-command-retry','copy-import-recopy','restart-recovery','deletion-cleanup','source-replacement','output-replacement','parent-fsync-retry','reservation-retained-on-failure']),
});
export const PNG_REFUSALS=Object.freeze(['gray-16','rgb-16','gray-alpha-16','rgba-16']);
const LEGACY_PNG_ISSUER_PATHS=Object.freeze(['tooling/raster/import-issuance/issue-png-profile.mjs','tooling/raster/import-issuance/png-contract.mjs','tooling/raster/import-issuance/png-evidence.mjs','tooling/raster/import-seals/authority.mjs','tooling/raster/import-seals/files.mjs']);
const LEGACY_PNG_ISSUER_SOURCE='sha256:f7beb911eb486875ffbd9d7e9132c6c90bb4536e2d874932db7b5bda35c0d3ab';
export const PNG_ISSUER_PATHS=Object.freeze([...LEGACY_PNG_ISSUER_PATHS,'tooling/raster/import-seals/pinned-canonical-source.mjs']);
const HASH=/^sha256:[a-f0-9]{64}$/;
const hash=x=>{assert.equal(typeof x,'string');assert.match(x,HASH);};
const object=x=>assert(x&&typeof x==='object'&&!Array.isArray(x));
const integer=(x,min=0,max=Number.MAX_SAFE_INTEGER)=>assert(Number.isSafeInteger(x)&&x>=min&&x<=max);
const text=x=>assert(typeof x==='string'&&x.trim().length>0&&x.length<=4096);
const exact=(value,names)=>{object(value);assert.deepEqual(Object.keys(value).sort(),[...names].sort());};
export const pngDigest=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
export function pngRelativePath(value){text(value);assert(!value.includes('\\')&&!value.startsWith('/')&&!/^[a-zA-Z]:/.test(value));assert(value.split('/').every(p=>p&&p!=='.'&&p!=='..'));return value;}
export function pngFileReference(ref){exact(ref,['path','bytes','hash']);pngRelativePath(ref.path);integer(ref.bytes,1,2**40);hash(ref.hash);return ref;}
const sortedUnique=(values,expected)=>{assert(Array.isArray(values));assert.equal(new Set(values).size,values.length);assert.deepEqual([...values].sort(),[...expected].sort());};

export function validatePNGSource(source,canonicalStringify){
 exact(source,['schemaVersion','kind','sourceHash','producerSourceHash','definition']);assert.equal(source.schemaVersion,1);assert.equal(source.kind,'png-import-source-v1');hash(source.sourceHash);hash(source.producerSourceHash);
 const d=source.definition;exact(d,['schemaVersion','kind','transport','mediaType','pixelPipeline','kernel','color','files']);assert.equal(d.schemaVersion,1);assert.equal(d.kind,'png-import-source-definition-v1');
 assert.equal(d.transport,'png-scanline-file-cp1-v1');assert.equal(d.mediaType,'image/png');assert.equal(d.pixelPipeline,'cp1-f64-triangle-area-v1');assert.equal(d.kernel,'triangle-area-source-axis-row-norm-v1');assert.equal(d.color,'fixed-srgb-p3-orientation-v1');
 assert(Array.isArray(d.files)&&d.files.length>0&&d.files.length<=256);d.files.forEach(pngFileReference);assert.deepEqual(d.files.map(f=>f.path),[...new Set(d.files.map(f=>f.path))].sort());assert.deepEqual(d.files.map(f=>f.path),RETAINED_PNG_SOURCE_HASHES.has(source.sourceHash)?RETAINED_PNG_SOURCE_PATHS:PNG_SOURCE_PATHS);
 for(const required of ['server/raster/png-import.ts','server/raster/png-input.ts','server/raster/png.ts','server/raster/import-file-transform.ts','server/raster/webp-color.ts','src/raster/core.ts','src/protocol/json.ts'])assert(d.files.some(f=>f.path===required));
 for(const f of d.files)assert(!/(?:^|\/)(?:import-profile|profile-registry|import-producers)\.ts$/.test(f.path),'Generated issued inventories cannot enter the producer source identity');
 assert.equal(source.sourceHash,pngDigest(canonicalStringify(d)));return source;
}
/** The caller hashes and reads the same retained manifest bytes, then checks
 * every manifest file against both producer-inputs/<path> and the trusted root. */
export function validatePNGProducerSource(source,manifest,manifestHash){
 hash(manifestHash);assert.equal(source.producerSourceHash,manifestHash);exact(manifest,['schemaVersion','kind','sourceHash','files']);assert.equal(manifest.schemaVersion,1);assert.equal(manifest.kind,'png-import-issuer-source-v1');assert.equal(manifest.sourceHash,source.sourceHash);
 assert(Array.isArray(manifest.files));manifest.files.forEach(pngFileReference);assert.deepEqual(manifest.files.map(f=>f.path),manifestHash===LEGACY_PNG_ISSUER_SOURCE?LEGACY_PNG_ISSUER_PATHS:PNG_ISSUER_PATHS);return manifest;
}
function environment(q,r){
 exact(r.environment,['node','platform','arch','execution','os']);assert.equal(r.environment.node,'26.10.0');assert.equal(r.environment.platform,q.platform);assert.equal(r.environment.arch,q.arch);assert(['native','virtualized','emulated'].includes(r.environment.execution));text(r.environment.os);
 assert(Array.isArray(r.logs)&&r.logs.length>0&&r.logs.length<=32);r.logs.forEach(pngFileReference);assert.equal(new Set(r.logs.map(f=>f.path)).size,r.logs.length);for(const f of r.logs)assert(f.bytes<=8*1024*1024);
}
function baseRow(row){assert.equal(row.status,'passed-case');integer(row.completedChecks,1);assert(Number.isFinite(row.elapsedMs)&&row.elapsedMs>=0);}
function pixelRow(row){
 exact(row,['id','status','completedChecks','elapsedMs','originalWidth','originalHeight','width','height','fixture','actual','expected','oracle']);baseRow(row);
 integer(row.originalWidth,1,0x7fffffff);integer(row.originalHeight,1,0x7fffffff);integer(row.width,1,8192);integer(row.height,1,8192);assert(row.width*row.height<=25000000);
 for(const ref of [row.fixture,row.actual,row.expected])pngFileReference(ref);
 assert.notEqual(row.actual.path,row.expected.path,'Keep independently expected bytes distinct from observed output');assert.equal(row.actual.bytes,row.width*row.height*4);assert.equal(row.expected.bytes,row.actual.bytes);assert.equal(row.actual.hash,row.expected.hash);
 exact(row.oracle,['kind','source']);assert(['independent-fixture','pinned-decoder'].includes(row.oracle.kind));pngFileReference(row.oracle.source);
 if(row.id.startsWith('oversized-'))assert(row.originalWidth*row.originalHeight>25000000||row.originalWidth>8192||row.originalHeight>8192);
}
function receipt(q,role,r){
 const common=['schemaVersion','kind','status','sourceHash','sourceManifestHash','producerSourceHash','baseCodec','platform','arch','hostSourceHash','environment','logs'];
 exact(r,[...common,...(role==='resources'?['measurement','capBytes','maxRSSBytes','completedJobs','completedOperations','residualAllocations','residualScratchBytes','jobs']:['completedCases','completedChecks','cases']),...(role==='pixels'?['refusals','completedRefusals']:[])]);
 assert.equal(r.schemaVersion,1);assert.equal(r.kind,'png-import-'+role+'-v1');assert.equal(r.status,'passed');for(const field of ['sourceHash','sourceManifestHash','producerSourceHash','baseCodec','platform','arch','hostSourceHash'])assert.equal(r[field],q[field]);environment(q,r);
 if(role==='resources'){
  assert.equal(r.measurement,'whole-process-rss');assert.equal(r.capBytes,512*1024*1024);integer(r.maxRSSBytes,1,r.capBytes);assert.equal(r.residualAllocations,0);assert.equal(r.residualScratchBytes,0);assert(Array.isArray(r.jobs));sortedUnique(r.jobs.map(j=>j.case),PNG_CASES.resources);
  let peak=0,operations=0;const ids=new Set();for(const j of r.jobs){
   exact(j,['id','case','status','originalWidth','originalHeight','width','height','operation','fixture','actual','expected','maxRSSBytes','admittedBytes','completedOperations','maxConcurrentJobs','contentionObserved','remainingAllocations','remainingScratchBytes']);text(j.id);assert(!ids.has(j.id));ids.add(j.id);assert.equal(j.status,'completed');
   integer(j.originalWidth,1,0x7fffffff);integer(j.originalHeight,1,0x7fffffff);assert(j.originalWidth*j.originalHeight>25000000);integer(j.width,1,8192);integer(j.height,1,8192);assert(j.width*j.height<=25000000);assert(['resize','crop'].includes(j.operation));
   for(const ref of [j.fixture,j.actual,j.expected])pngFileReference(ref);assert.notEqual(j.actual.path,j.expected.path);assert.equal(j.actual.hash,j.expected.hash);assert.equal(j.actual.bytes,j.width*j.height*4);assert.equal(j.expected.bytes,j.actual.bytes);
   integer(j.maxRSSBytes,1,r.capBytes);integer(j.admittedBytes,1,r.capBytes);integer(j.completedOperations,1);integer(j.maxConcurrentJobs,1);assert.equal(typeof j.contentionObserved,'boolean');assert.equal(j.remainingAllocations,0);assert.equal(j.remainingScratchBytes,0);
   if(j.case==='repeated-resize'){assert.equal(j.operation,'resize');assert(j.completedOperations>=3);}if(j.case==='contended-crop'){assert.equal(j.operation,'crop');assert(j.maxConcurrentJobs>=2&&j.contentionObserved);}
   peak=Math.max(peak,j.maxRSSBytes);operations+=j.completedOperations;
  }
  assert.equal(r.completedJobs,r.jobs.length);assert.equal(r.completedOperations,operations);assert.equal(r.maxRSSBytes,peak);return;
 }
 assert(Array.isArray(r.cases));sortedUnique(r.cases.map(c=>c.id),PNG_CASES[role]);let checks=0;
 for(const row of r.cases){if(role==='durability'){exact(row,['id','status','completedChecks','elapsedMs','observations']);baseRow(row);assert(Array.isArray(row.observations)&&row.observations.length>0&&row.observations.length<=32);row.observations.forEach(pngFileReference);}else pixelRow(row);checks+=row.completedChecks;}
 assert.equal(r.completedCases,r.cases.length);assert.equal(r.completedChecks,checks);
 if(role==='pixels'){
  assert(Array.isArray(r.refusals));sortedUnique(r.refusals.map(c=>c.id),PNG_REFUSALS);assert.equal(r.completedRefusals,r.refusals.length);
  for(const row of r.refusals){exact(row,['id','status','code','completedChecks','elapsedMs','fixture','originalAfter','outputAbsent']);assert.equal(row.status,'rejected-as-unsupported');assert.equal(row.code,'RASTER_DEPTH');integer(row.completedChecks,1);assert(Number.isFinite(row.elapsedMs)&&row.elapsedMs>=0);pngFileReference(row.fixture);pngFileReference(row.originalAfter);assert.equal(row.fixture.hash,row.originalAfter.hash);assert.equal(row.fixture.bytes,row.originalAfter.bytes);assert.notEqual(row.fixture.path,row.originalAfter.path);assert.equal(row.outputAbsent,true);}
 }
}

/** Binds host admission, commit, cancellation and worker lifetime separately
 * from the fixed pixel source identity. Generated inventory is excluded to
 * avoid an issuance cycle; a host change needs a new actual qualification. */
export function validatePNGHostSources(q,canonicalStringify){
 assert.equal(typeof canonicalStringify,'function');hash(q.hostSourceHash);assert(Array.isArray(q.hostSourceFiles)&&q.hostSourceFiles.length>=PNG_HOST_SOURCE_PATHS.length&&q.hostSourceFiles.length<=8192);
 const paths=[];for(const file of q.hostSourceFiles){exact(file,['repositoryPath','bytes','hash']);pngRelativePath(file.repositoryPath);integer(file.bytes,1,2**31);hash(file.hash);assert.notEqual(file.repositoryPath,'server/raster/import-inventory.ts','Generated inventory cannot enter qualification host identity');paths.push(file.repositoryPath);}
 assert.deepEqual(paths,[...new Set(paths)].sort(),'Host sources must be sorted and unique');for(const required of PNG_HOST_SOURCE_PATHS)assert(paths.includes(required),'Missing qualified PNG host source: '+required);
 assert.equal(q.hostSourceHash,pngDigest(canonicalStringify(q.hostSourceFiles)));return q.hostSourceFiles;
}

/** File readers must additionally verify every receipt/log/fixture/output ref.
 * A structurally valid test fixture is never evidence that these jobs ran. */
export function validatePNGQualification({source,sourceManifestHash,qualification:q,receipts,baseCodecAuthority,canonicalStringify}){
 exact(q,['schemaVersion','kind','status','sourceHash','sourceManifestHash','producerSourceHash','baseCodec','platform','arch','artifactHash','abiVersion','hostSourceFiles','hostSourceHash','evidence']);assert.equal(q.schemaVersion,1);assert.equal(q.kind,'png-import-cp1-qualification-v1');assert.equal(q.status,'accepted');validatePNGHostSources(q,canonicalStringify);
 assert.equal(q.sourceHash,source.sourceHash);assert.equal(q.producerSourceHash,source.producerSourceHash);hash(sourceManifestHash);assert.equal(q.sourceManifestHash,sourceManifestHash);hash(q.baseCodec);assert.equal(q.artifactHash,null);assert.equal(q.abiVersion,null);
 assert(baseCodecAuthority&&baseCodecAuthority.platform===q.platform&&baseCodecAuthority.arch===q.arch&&baseCodecAuthority.codecId===q.baseCodec,'Exact target base codec authority required');assert([['darwin','arm64'],['linux','arm64'],['linux','x64']].some(([p,a])=>p===q.platform&&a===q.arch));
 assert(Array.isArray(q.evidence));sortedUnique(q.evidence.map(e=>e.role),PNG_ROLES);assert.equal(new Set(q.evidence.map(e=>e.hash)).size,PNG_ROLES.length,'Distinct role receipts required');assert(receipts instanceof Map);sortedUnique([...receipts.keys()],PNG_ROLES);
 for(const ref of q.evidence){exact(ref,['role','path','bytes','hash']);pngFileReference({path:ref.path,bytes:ref.bytes,hash:ref.hash});assert(ref.bytes<=8*1024*1024);receipt(q,ref.role,receipts.get(ref.role));}
 return q;
}

export function pngReceiptReferences(role,r){
 const refs=[...r.logs];if(role==='resources')for(const j of r.jobs)refs.push(j.fixture,j.actual,j.expected);
 else if(role==='durability')for(const row of r.cases)refs.push(...row.observations);
 else {for(const row of r.cases)refs.push(row.fixture,row.actual,row.expected,row.oracle.source);if(role==='pixels')for(const row of r.refusals)refs.push(row.fixture,row.originalAfter);}
 return refs;
}
