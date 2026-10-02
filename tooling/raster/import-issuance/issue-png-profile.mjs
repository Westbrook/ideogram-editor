// Packages already accepted, byte-bound qualification; never runs image work,
// writes passing receipts, installs a capsule, or mutates generated inventories.
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadPinnedCanonical} from '../import-seals/pinned-canonical-source.mjs';
import {authoritativeCodec} from '../import-seals/authority.mjs';
import {copyHeld,identity,inside,readJSON,writeJSON,MAX_CAPSULE_BYTES,MAX_FILES,MAX_JSON_BYTES,checkParents} from '../import-seals/files.mjs';
import {validatePNGSource,validatePNGProducerSource,pngDigest} from './png-contract.mjs';
import {readPNGQualification} from './png-evidence.mjs';

export function issuePNGProfile({sourceRoot,producerRoot,qualificationPath,output,canonicalStringify}){
 sourceRoot=resolve(sourceRoot);producerRoot=resolve(producerRoot);qualificationPath=resolve(qualificationPath);output=resolve(output);
 assert(!existsSync(output),'PNG issuance output must be fresh');
 // Keep every reviewed input tree unchanged while retaining its bytes. Source
 // roots may be ancestors of the issuer/evidence roots, but output must be a
 // disjoint fresh tree; no mkdir runs until all overlap checks pass.
 for(const input of [sourceRoot,producerRoot,dirname(qualificationPath)])assert(output!==input&&!output.startsWith(input+'/')&&!input.startsWith(output+'/'),'PNG input and output trees must not overlap');
 checkParents(output);
 const frozen=readJSON(join(producerRoot,'png-source.json')),source=validatePNGSource(frozen.value,canonicalStringify),producer=readJSON(join(producerRoot,'png-source-manifest.json'));
 validatePNGProducerSource(source,producer.value,producer.hash);
 for(const ref of producer.value.files)assert.deepEqual(identity(inside(sourceRoot,ref.path)),{bytes:ref.bytes,hash:ref.hash},'Issuer dependency changed: '+ref.path);
 const target=readJSON(qualificationPath).value,baseCodecAuthority=authoritativeCodec(sourceRoot,target.platform,target.arch);
 const checked=readPNGQualification({sourceRoot,source,sourceManifestHash:frozen.hash,qualificationPath,baseCodecAuthority,canonicalStringify});
 const q=checked.qualification.value;
 const definition={baseCodec:q.baseCodec,platform:q.platform,arch:q.arch,producer:{transport:'png-scanline-file-cp1-v1',mediaType:'image/png',sourceHash:source.sourceHash,artifactHash:null,abiVersion:null},kernel:source.definition.kernel,color:source.definition.color,qualificationHash:checked.qualification.ref.hash};
 const codec=pngDigest(canonicalStringify(definition)),profile={...definition,codec,pipeline:source.definition.pixelPipeline+'/'+codec};
 const vendorPath='vendor/raster/png-import/'+source.sourceHash.slice(7)+'/'+q.platform+'-'+q.arch+'/'+checked.qualification.ref.hash.slice(7);
 mkdirSync(output,{mode:0o700});const files=[],references=[];let total=3*MAX_JSON_BYTES;
 const retain=(sourcePath,path,expected)=>{total+=expected.bytes;assert(total<=MAX_CAPSULE_BYTES&&files.length<MAX_FILES-3);copyHeld(sourcePath,inside(output,path),expected);files.push({path,bytes:expected.bytes,hash:expected.hash});};
 retain(join(producerRoot,'png-source.json'),'source.json',{bytes:frozen.bytes.length,hash:frozen.hash});
 retain(join(producerRoot,'png-source-manifest.json'),'producer-source-manifest.json',{bytes:producer.bytes.length,hash:producer.hash});
 retain(qualificationPath,'qualification.json',checked.qualification.ref);
 for(const item of checked.sourceFiles)retain(item.sourcePath,'source-inputs/'+item.ref.path,item.ref);
 for(const item of checked.hostSourceFiles)retain(item.sourcePath,'host-source-inputs/'+item.ref.path,item.ref);
 for(const ref of producer.value.files)retain(inside(sourceRoot,ref.path),'producer-inputs/'+ref.path,ref);
 for(const [index,item] of checked.records.entries()){
  const capturedPath='evidence/'+String(index).padStart(4,'0')+'-'+item.ref.hash.slice(7)+'.bin';retain(item.sourcePath,capturedPath,item.ref);
  references.push({parentHash:item.parentHash,originalReference:item.originalReference,capturedPath,bytes:item.ref.bytes,hash:item.ref.hash});
 }
 for(const [path,value] of [['import-profile.json',profile],['proof-capsule.json',{schemaVersion:2,qualificationHash:checked.qualification.ref.hash,references}]]){const ref=writeJSON(inside(output,path),value);files.push({path,...ref});}
 const adoption={schemaVersion:1,status:'ready-for-verified-adoption',vendorPath,files,qualificationHash:checked.qualification.ref.hash,sourceHash:source.sourceHash,producerSourceHash:source.producerSourceHash,baseCodecAuthority,registryInstruction:'Verify this complete capsule and current source closure; adopt its PNG derived profile for the exact base/platform through the common data-only inventory overlay. There is no new native artifact or ABI.'};
 // This is deliberately last: a partial capture has no completed adoption seal.
 writeJSON(inside(output,'adoption.json'),adoption);return {output,vendorPath,codec,pipeline:profile.pipeline,qualificationHash:adoption.qualificationHash};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 assert.equal(process.versions.node,'26.10.0');assert.equal(process.argv.length,5,'issue-png-profile.mjs TRUSTED_SOURCE_ROOT ACCEPTED_QUALIFICATION NEW_OUTPUT');
 const sourceRoot=resolve(process.argv[2]),producerRoot=dirname(fileURLToPath(import.meta.url)),frozen=readJSON(join(producerRoot,'png-source.json'));
 // Verify the full fixed source closure before loading its trusted serializer.
 for(const ref of frozen.value.definition.files)assert.deepEqual(identity(inside(sourceRoot,ref.path)),{bytes:ref.bytes,hash:ref.hash});
 const {canonical}=await loadPinnedCanonical(readFileSync(join(sourceRoot,'src/protocol/json.ts')));
 console.log(JSON.stringify(issuePNGProfile({sourceRoot,producerRoot,qualificationPath:process.argv[3],output:process.argv[4],canonicalStringify:canonical})));
}
