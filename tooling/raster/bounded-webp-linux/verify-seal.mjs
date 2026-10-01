import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const hash = value => 'sha256:'+createHash('sha256').update(value).digest('hex');
// The caller supplies an identity from the reviewed runtime platform catalog.
// A manifest's own hashes alone never grant runtime platform qualification.
export function verifyLinuxBoundedWebPSeal(identity) {
  assert.equal(identity.platform,'linux');
  assert(['arm64','x64'].includes(identity.arch));
  assert.equal(identity.version,'1.6.0-ideogram.2-linux');
  const prefix=`vendor/raster/bounded-webp/${identity.version}/linux-${identity.arch}`;
  assert.equal(identity.path,`${prefix}/libideogram-webp.so.1`);
  const check=(path,expected)=> {
    const bytes=readFileSync(join(root,path));
    assert.equal(bytes.length,expected.bytes,path); assert.equal(hash(bytes),expected.hash,path);
  };
  const manifestBytes=readFileSync(join(root,prefix,'manifest.json'));
  assert.equal(hash(manifestBytes),identity.manifestHash);
  const manifest=JSON.parse(manifestBytes);
  for(const key of ['version','platform','arch','abiVersion']) assert.equal(manifest[key],identity[key]);
  assert.equal(manifest.schemaVersion,1);
  assert.equal(manifest.source.hash,identity.sourceHash);
  assert.equal(manifest.source.file,'libwebp-1.6.0.tar.gz');
  check(`${prefix}/${manifest.source.file}`,manifest.source);
  assert.equal(manifest.artifact.path,'libideogram-webp.so.1');
  assert.equal(manifest.artifact.hash,identity.hash); assert.equal(manifest.artifact.bytes,identity.bytes);
  check(identity.path,identity);
  assert.equal(hash(JSON.stringify(manifest.producerInputs)),identity.producerHash);
  for(const input of manifest.producerInputs) {
    assert.match(input.path,/^(tooling\/raster\/bounded-webp(-linux)?\/[A-Za-z0-9_.-]+|vendor\/raster\/bounded-webp\/1\.6\.0-ideogram\.1\/manifest\.json)$/);
    check(input.path,input);
  }
  for(const notice of manifest.notices) {
    assert(['COPYING','PATENTS','AUTHORS'].includes(notice.path)); check(`${prefix}/${notice.path}`,notice);
  }
  assert.equal(manifest.reproduction.byteIdentical,true);
  assert.equal(manifest.allocatorSelfTest.status,'passed'); assert.equal(manifest.colorSelfTest.status,'passed');
  assert.equal(manifest.nativeVerification.status,'passed');
  return {status:'passed',platform:identity.platform,arch:identity.arch,boundedWebP:identity.hash,source:identity.sourceHash,producerInputs:manifest.producerInputs.length};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  assert(process.argv[2],'Supply the produced identity.json path; this verifies bytes and does not activate a runtime platform');
  console.log(JSON.stringify(verifyLinuxBoundedWebPSeal(JSON.parse(readFileSync(process.argv[2],'utf8')))));
}
