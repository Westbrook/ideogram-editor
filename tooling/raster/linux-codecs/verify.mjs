import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {captureInstalled,fileIdentity,generatedPathFor,hash,identitySource,producerInputs,targetFor,validateLock} from './capture.mjs';

export function verifyLinuxCodecsSeal({arch=process.arch,installed=process.platform==='linux'&&process.arch===arch}={}){
  const target=targetFor(arch),generatedPath=generatedPathFor(arch);
  const codecs=JSON.parse(readFileSync(join(target,'codecs.json'))),receipt=JSON.parse(readFileSync(join(target,'receipt.json')));
  assert.equal(hash(JSON.stringify(codecs)),receipt.codecIdentity);assert.equal(readFileSync(generatedPath,'utf8'),identitySource(codecs));
  assert.deepEqual(receipt.producerInputs,producerInputs(),'Linux codec producer inputs changed');validateLock(arch);
  for(const name of ['package.json','package-lock.json']){const recorded=receipt.sourceInputs.find(item=>item.path===name),bytes=readFileSync(join(target,name));assert.equal(bytes.length,recorded.bytes);assert.equal(hash(bytes),recorded.hash);}
  // Project package scripts may grow without changing codec inputs. The archived
  // install package/lock is sealed above, while current codec lock entries must
  // still match expected-packages.json exactly.
  for(const item of receipt.sourceInputs.filter(item=>!['package.json','package-lock.json'].includes(item.path)))assert.deepEqual(fileIdentity(item.path),item,`Linux codec source input changed: ${item.path}`);
  assert.equal(receipt.installation.packageLockHash,receipt.sourceInputs.find(item=>item.path==='package-lock.json').hash);
  assert.equal(receipt.installation.packageHash,receipt.sourceInputs.find(item=>item.path==='package.json').hash);
  if(installed)assert.deepEqual(captureInstalled(),codecs,'Installed Linux codec bytes/profile do not match the adopted seal');
  return {status:'passed',codecIdentity:receipt.codecIdentity,codecFiles:codecs.files.length,installed};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const args=process.argv.slice(2);assert(args.length===0||args.length===2&&args[0]==='--arch','Usage: node tooling/raster/linux-codecs/verify.mjs [--arch arm64|x64]');console.log(JSON.stringify(verifyLinuxCodecsSeal(args.length?{arch:args[1]}:{})));}
