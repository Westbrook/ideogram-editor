// A separate repaired-candidate contract. Every imported module is trusted
// correction source; issuer/driver/product/native bytes remain inert evidence.
import assert from 'node:assert/strict';
import {basename,dirname,isAbsolute,join,resolve} from 'node:path';
import {canonical} from './pinned-canonical.mjs';
import {digest,hash,readJSON} from './files.mjs';
import {ALPHA_SELECTED,ALPHA_HOST_DRIVER_SOURCE,ALPHA_SOURCE} from './webp-alpha-authority.mjs';
import {validateAlphaProducer} from './webp-alpha-producer.mjs';
import {validateAlphaIssuerBundle} from './webp-alpha-bundle.mjs';
import {createWebPAlphaProofReader} from './webp-alpha-proof.mjs';
import {validateAllocatorGate,validateNativeGate} from './webp-gate-contract.mjs';
import {validateAlphaNativeChildren} from './webp-alpha-native-children.mjs';
import {validateSourceAudit} from './webp-alpha-source-audit.mjs';
import {ALPHA_HOST_ROLES,extractStrictAlphaFixtures,validateAlphaHostReceipts} from './webp-alpha-host-contract.mjs';
import {validateAlphaLoader} from './webp-alpha-loader-contract.mjs';

const id=row=>({bytes:row.bytes,hash:row.hash});
const ref=row=>({path:row.path,...id(row)});
const positive=n=>Number.isSafeInteger(n)&&n>0;
const absolute=path=>{assert(typeof path==='string'&&isAbsolute(path)&&resolve(path)===path&&!path.includes('\0'));return path;};
const zeros=value=>assert(value&&Object.keys(value).length>0&&Object.values(value).every(n=>n===0),'Actual zero network counters required');
const roles=Object.freeze(['allocator','native-smoke','halo-parity',...ALPHA_HOST_ROLES]);

function sameReference(proof,parentHash,parentPath,reference,expected){
 const read=proof.get(parentHash,reference,{parentPath});assert.equal(read.path,expected.path);assert.deepEqual(id(read),id(expected));return read;
}
function validateDriverRecord(value,parentHash,parentPath,proof,driverFiles){
 const read=proof.readJSON(parentHash,value.driverManifest,{parentPath}),driver=read.value;
 assert.equal(driver.schemaVersion,1);assert.equal(driver.kind,'webp-host-driver-source-v1');
 assert.equal(driver.sourceHash,hash(canonical(driverFiles)));assert.equal(value.driverSourceHash,driver.sourceHash);
 assert.deepEqual(driver.retainedFiles.map(({repositoryPath,bytes,hash})=>({repositoryPath,bytes,hash})),driverFiles);
 for(const row of driver.retainedFiles){const held=proof.get(read.hash,row,{parentPath:read.path});assert.deepEqual(id(held),id(row));}
}
function validateStorageLinks(value,parentHash,parentPath,proof){
 const observation=proof.readJSON(parentHash,value.executionObservation,{parentPath});
 assert.equal(observation.path,value.evidenceReceiptPath);assert.equal(observation.path,join(dirname(parentPath),'execution-observation.json'));
 const {storageProof,executionObservation,evidenceReceiptPath,networkCounters,...observed}=value;
 assert.deepEqual(observation.value,observed,'Storage observation must describe this exact campaign');zeros(networkCounters);
 const storage=proof.readJSON(parentHash,storageProof,{parentPath});
 assert.equal(storage.value.schemaVersion,1);assert.equal(storage.value.kind,'webp-campaign-storage-proof-v1');assert.equal(storage.value.status,'PASS');
 assert(Array.isArray(storage.value.retainedFiles)&&storage.value.retainedFiles.length>0);
 for(const row of storage.value.retainedFiles)proof.get(storage.hash,row,{parentPath:storage.path});
 // This is a retained-link check. Source acceptance still requires the exact
 // separately pinned issuer's complete allocation-audit verification.
 assert(value.evidenceStorage&&typeof value.evidenceStorage==='object');
}
function validateBuildRecord(build,closure,campaign){
 const p=build.value;
 assert.equal(p.schemaVersion,1);assert(['webp-host-build-proof-v1','jpeg-host-build-proof-v1'].includes(p.kind),'Unreviewed host compiler proof kind');assert.equal(p.status,'passed');
 assert.equal(p.node,'26.10.0');assert.equal(p.repo,campaign.repo);
 assert.equal(p.sourceHash,closure.sourceHash);assert.equal(p.compiledHash,closure.compiledHash);
 assert.deepEqual(p.sourceFiles,closure.sourceFiles);assert.deepEqual(p.compiledFiles,closure.compiledFiles);
 assert.equal(p.runtimeDependenciesIdentityHash,closure.runtimeDependencies.identityHash);
 assert.equal(p.commands.length,1);const command=p.commands[0];
 assert.equal(command.id,'fresh-server-compile');assert.equal(command.command,campaign.node.executablePath);
 assert.equal(command.cwd,campaign.repo);assert.equal(command.exitCode,0);assert.equal(command.signal,null);assert.equal(command.error,null);
 assert(Number.isFinite(command.elapsedMs)&&command.elapsedMs>0);assert(Number.isFinite(Date.parse(command.startedAt)));
 assert.deepEqual(command.args,['--import',join(campaign.repo,'tests/store/no-network.mjs'),join(campaign.repo,'node_modules/typescript/bin/tsc'),
  '--project',join(campaign.repo,'tsconfig.server.json'),'--outDir',join(dirname(build.path),'compiled'),'--incremental','false']);
 assert.equal(p.compiler.identityHash,hash(canonical(p.compiler.files)));assert(typeof p.compiler.version==='string');
 assert.deepEqual(p.dependencies,['package.json','package-lock.json'].map(name=>{const row=closure.dependencyFiles.find(r=>r.repositoryPath===name);assert(row);return row;}));
 assert.deepEqual(p.emitted.filter(row=>row.repositoryPath.endsWith('.js')),closure.compiledFiles.filter(row=>row.repositoryPath.endsWith('.js')));
 assert(p.emitted.length>0);assert(Array.isArray(p.logs)&&p.logs.length===1);
}
function validateRoleRequests({campaign,campaignHash,campaignPath,qualification,candidateHash,receiptRefs,receipts,halo,hostClosure,build,proof}){
 assert.deepEqual(campaign.commands.map(row=>row.id),ALPHA_HOST_ROLES);
 for(const role of ALPHA_HOST_ROLES){
  const receipt=receipts.get(role),parent=receiptRefs.get(role),request=proof.readJSON(parent.hash,receipt.request,{parentPath:parent.path}),r=request.value;
  const expected={role,repo:campaign.repo,candidatePath:campaign.candidatePath,candidateHash,producerPacket:campaign.producerPacket,
   sourceHash:ALPHA_SOURCE.hash,evidenceRoot:campaign.evidenceRoot,haloProofPath:halo.proof.path,haloNativePath:halo.nativeProbe.path,
   fixturesPath:campaign.fixtureManifest.path,fixtureManifestHash:campaign.fixtureManifest.hash,hostClosurePath:hostClosure.path};
  for(const [key,value]of Object.entries(expected))assert.equal(r[key],value,'Role request differs: '+key);
  assert.equal(r.output,dirname(parent.path));assert.deepEqual(r.haloAuthorization,halo);assert.deepEqual(r.hostBuildProof,ref(build));
  for(const [key,value]of Object.entries(campaign.loader))assert.deepEqual(r[key],value,'Role loader differs: '+key);
  const command=campaign.commands.find(row=>row.id===role);
  assert.equal(command.exitCode,0);assert.equal(command.signal,null);assert.equal(command.error,null);assert.equal(command.cwd,campaign.repo);
  assert.equal(command.command,campaign.node.executablePath);assert(Number.isFinite(command.elapsedMs)&&command.elapsedMs>0);assert(Number.isFinite(Date.parse(command.startedAt)));
  assert.deepEqual(command.args,['--import',join(campaign.repo,'tests/store/no-network.mjs'),...campaign.loader.candidateLoaderExecArgv,
   join(campaign.producerPacket,ALPHA_HOST_DRIVER_SOURCE.directory,'role-child.mjs'),request.path,request.hash,parent.path]);
 }
}

/** This branch cannot accept while any reviewed source/compiled authority is
 * pending. Source-only seals never imply a qualified artifact or active profile. */
export function validateAlphaNativeCapsule({directory,manifest,files,profile,qualification:q,qualificationHash,receipts,proof:originalProof,authority}){
 const bundle=validateAlphaIssuerBundle({directory,manifest,files});
 const cFile=readJSON(join(directory,'build-candidate.json')),c=cFile.value;
 assert.equal(cFile.hash,ALPHA_SELECTED.candidate.hash);
 const producer=validateAlphaProducer({directory,manifest,files,candidate:c,candidateHash:cFile.hash,authority});
 const seal=readJSON(join(directory,'identity.json')).value;
 assert.equal(profile.producer.transport,'webp-advanced-file-v1');assert.equal(profile.producer.mediaType,'image/webp');
 assert.equal(profile.platform,c.platform);assert.equal(profile.arch,c.arch);assert.equal(profile.baseCodec,authority.codecId);
 assert.equal(profile.producer.sourceHash,ALPHA_SOURCE.hash);assert.equal(profile.producer.artifactHash,c.artifact.hash);assert.equal(profile.producer.abiVersion,1);
 assert.equal(profile.qualificationHash,qualificationHash);assert.equal(manifest.qualificationHash,qualificationHash);
 assert.equal(manifest.vendorPath,`vendor/raster/advanced-webp/${c.version}/darwin-arm64/${qualificationHash.slice(7)}`);
 assert.deepEqual(seal,{status:'qualified',kind:'webp-advanced-file-v1',abiVersion:1,decoderVersion:0x010600,platform:c.platform,arch:c.arch,
  artifact:{path:manifest.vendorPath+'/'+c.artifact.path,...id(c.artifact)},sourceHash:ALPHA_SOURCE.hash,producerHash:c.producerHash,
  qualificationHash,residentCodeBytes:c.residentCodeBytes,loader:'held-descriptor-v1',halo:{...q.halo,proofHash:q.haloProof.hash}});
 assert.equal(q.schemaVersion,1);assert.equal(q.kind,'webp-advanced-cp1-qualification-v1');assert.equal(q.status,'accepted');assert.equal(q.qualificationIssued,false);
 assert.equal(q.candidateHash,cFile.hash);assert.equal(q.artifactHash,c.artifact.hash);assert.equal(q.platform,c.platform);assert.equal(q.arch,c.arch);assert.equal(q.baseCodec,authority.codecId);
 assert.equal(q.adapterHash,c.inputs.find(row=>row.path==='adapter.ts').hash);assert.equal(q.tilePlanHash,c.inputs.find(row=>row.path==='tile-plan.ts').hash);
 assert.equal(manifest.adapterHash,q.adapterHash);assert.equal(manifest.tilePlanHash,q.tilePlanHash);
 assert.equal(q.regularIssuedPathIntegration,'required-after-real-issuance-and-adoption');
 assert.deepEqual([...receipts.keys()],roles);assert.deepEqual(q.evidence.map(row=>row.role),roles);
 assert.equal(new Set(q.evidence.map(row=>row.hash)).size,roles.length);
 // The reviewed prepare command and issuer require qualification beside the
 // exact campaign. This establishes reference arithmetic, not an FS lookup.
 assert.equal(q.campaign.path,'qualification-inputs.json');
 const initialCampaign=originalProof.read(qualificationHash,q.campaign);assert(initialCampaign);
 absolute(initialCampaign.evidenceReceiptPath);assert.equal(basename(initialCampaign.evidenceReceiptPath),'execution-observation.json');
 const qualificationPath=join(dirname(initialCampaign.evidenceReceiptPath),'qualification.json');
 const proof=createWebPAlphaProofReader({directory,manifest,qualificationHash,proofReader:originalProof,qualificationPath});
 const campaignRead=proof.readJSON(qualificationHash,q.campaign),campaign=campaignRead.value,campaignPath=campaignRead.path,campaignHash=campaignRead.hash;
 assert.deepEqual(campaign,initialCampaign);assert.equal(q.reviewedCampaignHash,campaignHash);
 assert.equal(campaign.schemaVersion,1);assert.equal(campaign.kind,'webp-host-campaign-v1');assert.equal(campaign.status,'candidate-gates-passed');assert.equal(campaign.mode,'run');assert.equal(campaign.qualificationIssued,false);
 assert.equal(campaign.candidateHash,cFile.hash);assert.equal(campaign.artifactHash,c.artifact.hash);assert.equal(campaign.node.version,'26.10.0');
 for(const path of [campaign.repo,campaign.candidatePath,campaign.producerPacket,campaign.evidenceRoot,campaign.node.executablePath])absolute(path);
 digest(campaign.node.hash);assert(positive(campaign.node.bytes));zeros(campaign.networkCounters);
 assert.deepEqual(campaign.evidence.map(row=>row.role),roles);
 const recipe=proof.readJSON(qualificationHash,q.producerManifest);assert.deepEqual(id(recipe),id(producer.recipe));
 assert.equal(recipe.path,join(campaign.producerPacket,c.producerDirectory,'source-manifest.json'));
 sameReference(proof,campaignHash,campaignPath,campaign.producerManifest,recipe);
 const freeze=proof.readJSON(campaignHash,campaign.sourceFreeze,{parentPath:campaignPath});assert.deepEqual(id(freeze),id(producer.sourceFreeze));
 validateDriverRecord(campaign,campaignHash,campaignPath,proof,bundle.driverFiles);
 validateStorageLinks(campaign,campaignHash,campaignPath,proof);
 const closureRead=proof.readJSON(campaignHash,campaign.hostClosure,{parentPath:campaignPath}),closure=closureRead.value;
 assert.equal(closure.repo,campaign.repo);assert.equal(closure.kind,'webp-host-closure-v1');assert.equal(closure.schemaVersion,1);
 const hostFiles=closure.sourceFiles.filter(row=>row.repositoryPath!=='server/raster/import-inventory.ts').sort((a,b)=>a.repositoryPath<b.repositoryPath?-1:a.repositoryPath>b.repositoryPath?1:0);
 for(const record of [q,campaign]){assert.deepEqual(record.hostSourceFiles,hostFiles);assert.equal(record.hostSourceHash,hash(canonical(hostFiles)));}
 const expectedDependencies=['package.json','package-lock.json',...producer.hostDependencies.map(row=>row.path)].sort();
 assert.deepEqual(closure.dependencyFiles.map(row=>row.repositoryPath),expectedDependencies);
 for(const row of producer.hostDependencies)assert.deepEqual(id(closure.dependencyFiles.find(item=>item.repositoryPath===row.path)),id(row));
 const build=proof.readJSON(campaignHash,campaign.hostBuildProof,{parentPath:campaignPath});validateBuildRecord(build,closure,campaign);
 const receiptRefs=new Map();
 for(const row of q.evidence){const read=proof.readJSON(qualificationHash,row);assert.deepEqual(read.value,receipts.get(row.role));
  assert.equal(read.value.candidateHash,cFile.hash);assert.equal(read.value.artifactHash,c.artifact.hash);receiptRefs.set(row.role,{role:row.role,...ref(read)});
  sameReference(proof,campaignHash,campaignPath,campaign.evidence.find(item=>item.role===row.role),read);}
 validateAllocatorGate(receipts.get('allocator'),c);
 let haloChildren;
 for(const [role,phase]of [['native-smoke','smoke'],['halo-parity','halo']]){const r=receipts.get(role),reference=receiptRefs.get(role);validateNativeGate(r,phase,cFile.hash,c);
  const children=validateAlphaNativeChildren(r,reference.hash,reference.path,proof);if(phase==='halo')haloChildren=children;}
 const haloRead=proof.readJSON(qualificationHash,q.haloProof),haloProof=haloRead.value;
 sameReference(proof,campaignHash,campaignPath,campaign.haloProof,haloRead);
 assert.equal(haloProof.schemaVersion,1);assert.equal(haloProof.kind,'webp-full-decode-roi-proof-v1');assert.equal(haloProof.status,'accepted');
 assert.equal(haloProof.artifactHash,c.artifact.hash);assert.equal(haloProof.sourceHash,ALPHA_SOURCE.hash);
 assert.equal(haloProof.nativeProbeHash,receiptRefs.get('halo-parity').hash);assert.deepEqual(haloProof.rule,q.halo);assert.deepEqual(campaign.halo,q.halo);
 const audit=proof.readJSON(haloRead.hash,haloProof.sourceAudit,{parentPath:haloRead.path});
 validateSourceAudit({audit:audit.value,auditPath:audit.path,proof:haloProof,native:receipts.get('halo-parity'),nativeChildren:haloChildren,
  candidate:c,candidateHash:cFile.hash,recipe:producer.recipe,readBound:proof.readBound});
 const haloAuthorization={schemaVersion:1,kind:'webp-halo-authorization-v1',candidateHash:cFile.hash,artifactHash:c.artifact.hash,sourceHash:ALPHA_SOURCE.hash,
  proof:ref(haloRead),rule:q.halo,sourceAudit:ref(audit),nativeProbe:ref(receiptRefs.get('halo-parity')),evidenceRoot:campaign.evidenceRoot};
 assert.deepEqual(campaign.loader.haloAuthorization,haloAuthorization);
 validateAlphaLoader({loader:campaign.loader,candidate:c,candidateHash:cFile.hash,hostClosure:closure,campaign,campaignHash,campaignPath,
  haloAuthorization,buildProofRef:ref(build),proof,driverFiles:bundle.driverFiles,readDriver:bundle.readDriver});
 const fixtureRead=proof.readJSON(campaignHash,campaign.fixtureManifest,{parentPath:campaignPath});
 const fixtures=extractStrictAlphaFixtures(fixtureRead.value,fixtureRead,proof,{candidate:c,hostClosure:closure,driverFiles:bundle.driverFiles});
 const production=proof.readJSON(campaignHash,campaign.fixtureProduction,{parentPath:campaignPath}),fv=production.value;
 assert.equal(fv.kind,'webp-host-campaign-v1');assert.equal(fv.status,'fixtures-produced');assert.equal(fv.mode,'fixtures');assert.equal(fv.qualificationIssued,false);
 assert.equal(fv.repo,campaign.repo);assert.equal(fv.candidateHash,cFile.hash);assert.equal(fv.artifactHash,c.artifact.hash);assert.equal(fv.node.version,'26.10.0');zeros(fv.networkCounters);
 sameReference(proof,production.hash,production.path,fv.fixtures,fixtureRead);validateDriverRecord(fv,production.hash,production.path,proof,bundle.driverFiles);validateStorageLinks(fv,production.hash,production.path,proof);
 validateAlphaHostReceipts({candidate:c,candidateHash:cFile.hash,qualification:q,receipts,receiptRefs,campaign,campaignHash,
  fixtures,authorizationHash:campaign.loader.candidateAuthorization.authorizationHash,proof});
 validateRoleRequests({campaign,campaignHash,campaignPath,qualification:q,candidateHash:cFile.hash,receiptRefs,receipts,halo:haloAuthorization,hostClosure:closureRead,build,proof});
 return seal;
}
