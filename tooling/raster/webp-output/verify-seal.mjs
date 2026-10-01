import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
export function verifyWebPOutputSeal(profile) {
  assert.equal(profile.abiVersion,1);
  assert(['darwin-arm64','linux-arm64','linux-x64'].includes(`${profile.platform}-${profile.arch}`));
  assert.match(profile.version,/^[A-Za-z0-9_.-]+$/);
  const directory=join(root,'vendor/raster/webp-output',profile.version,`${profile.platform}-${profile.arch}`);
  const check=(path,expected)=>{const bytes=readFileSync(path);assert.equal(bytes.length,expected.bytes,path);assert.equal(hash(bytes),expected.hash,path);};
  const manifestBytes=readFileSync(join(directory,'manifest.json'));assert.equal(hash(manifestBytes),profile.manifestHash);
  const manifest=JSON.parse(manifestBytes);
  assert.equal(manifest.schemaVersion,1);assert.equal(manifest.version,profile.version);
  assert.equal(manifest.platform,profile.platform);assert.equal(manifest.arch,profile.arch);assert.equal(manifest.abiVersion,profile.abiVersion);
  const expectedName=profile.platform==='darwin'?'libideogram-webp-output.1.dylib':'libideogram-webp-output.so.1';
  assert.equal(manifest.artifact.path,expectedName);
  assert.equal(profile.path,`vendor/raster/webp-output/${profile.version}/${profile.platform}-${profile.arch}/${expectedName}`);
  check(join(root,profile.path),profile);
  assert.equal(manifest.artifact.hash,profile.hash);assert.equal(manifest.artifact.bytes,profile.bytes);
  assert.equal(manifest.source.hash,profile.sourceHash);
  assert.equal(hash(JSON.stringify(manifest.producerInputs)),profile.producerHash);
  for(const input of manifest.producerInputs){assert.match(input.path,/^[A-Za-z0-9_.-]+$/);check(join(root,'tooling/raster/webp-output',input.path),input);}
  assert.equal(manifest.nativeInputs.decoder.hash,profile.decoderHash);
  assert.equal(manifest.nativeInputs.converter.hash,profile.converterHash);
  for(const input of [manifest.nativeInputs.decoder,manifest.nativeInputs.converter]) {
    assert.match(input.path,/^vendor\/raster\/[A-Za-z0-9_./-]+$/);assert(!input.path.split('/').includes('..'));
    check(join(root,input.path),input);
  }
  assert.equal(manifest.reproduction.byteIdentical,true);assert.equal(manifest.invariants.status,'passed');assert.equal(manifest.nativeVerification.status,'passed');
  return {status:'passed',target:`${profile.platform}-${profile.arch}`,artifact:profile.hash,producerInputs:manifest.producerInputs.length};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  assert(process.argv[2],'Pass the sealed identity.json path');
  console.log(JSON.stringify(verifyWebPOutputSeal(JSON.parse(readFileSync(resolve(process.argv[2]))))));
}
