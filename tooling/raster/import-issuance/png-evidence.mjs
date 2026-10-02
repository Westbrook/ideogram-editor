import assert from 'node:assert/strict';
import {dirname} from 'node:path';
import {identity,inside,readJSON,MAX_CAPSULE_BYTES,MAX_FILES} from '../import-seals/files.mjs';
import {validatePNGQualification,pngReceiptReferences} from './png-contract.mjs';

/** Validates real retained bytes; source and receipt objects alone are insufficient.
 * The returned records keep the originally checked identities for later copying. */
export function readPNGQualification({sourceRoot,source,sourceManifestHash,qualificationPath,baseCodecAuthority,canonicalStringify}){
 const sourceFiles=source.definition.files.map(ref=>{const sourcePath=inside(sourceRoot,ref.path);assert.deepEqual(identity(sourcePath),{bytes:ref.bytes,hash:ref.hash},'PNG source changed: '+ref.path);return {sourcePath,ref};});
 const accepted=readJSON(qualificationPath),q=accepted.value,receipts=new Map(),proofs=[];
 assert(Array.isArray(q.evidence)&&q.evidence.length===4);
 for(const ref of q.evidence){assert(!receipts.has(ref.role),'Duplicate PNG evidence role');const sourcePath=inside(dirname(qualificationPath),ref.path),actual=readJSON(sourcePath);assert.equal(actual.bytes.length,ref.bytes);assert.equal(actual.hash,ref.hash,'PNG receipt changed');receipts.set(ref.role,actual.value);proofs.push({sourcePath,ref,receipt:actual.value});}
 validatePNGQualification({source,sourceManifestHash,qualification:q,receipts,baseCodecAuthority,canonicalStringify});
 const hostSourceFiles=q.hostSourceFiles.map(file=>{const ref={path:file.repositoryPath,bytes:file.bytes,hash:file.hash},sourcePath=inside(sourceRoot,ref.path);assert.deepEqual(identity(sourcePath),{bytes:ref.bytes,hash:ref.hash},'PNG qualified host changed: '+ref.path);return {sourcePath,ref};});
 const records=[],seen=new Map();let retainedBytes=0;
 const record=(parentHash,ref,sourcePath)=>{
  const key=parentHash+'\n'+ref.path,prior=seen.get(key);if(prior){assert.deepEqual(prior.ref,{path:ref.path,bytes:ref.bytes,hash:ref.hash});assert.equal(prior.sourcePath,sourcePath);return;}
  assert.deepEqual(identity(sourcePath),{bytes:ref.bytes,hash:ref.hash},'PNG evidence bytes changed: '+ref.path);retainedBytes+=ref.bytes;assert(retainedBytes<=MAX_CAPSULE_BYTES&&records.length<MAX_FILES,'PNG evidence closure exceeds capsule bounds');
  const item={parentHash,originalReference:ref.path,sourcePath,ref:{path:ref.path,bytes:ref.bytes,hash:ref.hash}};seen.set(key,item);records.push(item);
 };
 for(const proof of proofs){record(accepted.hash,proof.ref,proof.sourcePath);for(const ref of pngReceiptReferences(proof.ref.role,proof.receipt))record(proof.ref.hash,ref,inside(dirname(proof.sourcePath),ref.path));}
 return {sourceFiles,hostSourceFiles,qualification:{sourcePath:qualificationPath,ref:{bytes:accepted.bytes.length,hash:accepted.hash},value:q},receipts,records};
}
