import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {BOUNDED_WEBP} from '../../../server/raster/webp-identity.ts';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const hash = b => 'sha256:' + createHash('sha256').update(b).digest('hex');
export function verifyBoundedWebPSeal() {
  assert.equal(BOUNDED_WEBP.platform, process.platform, 'Bounded WebP platform');
  assert.equal(BOUNDED_WEBP.arch, process.arch, 'Bounded WebP architecture');
  const vendor = join(root,'vendor/raster/bounded-webp',BOUNDED_WEBP.version);
  const check = (path, identity) => {
    const bytes = readFileSync(path);
    assert.equal(bytes.length,identity.bytes,path);
    assert.equal(hash(bytes),identity.hash,path);
  };
  const manifestBytes = readFileSync(join(vendor,'manifest.json'));
  assert.equal(hash(manifestBytes),BOUNDED_WEBP.manifestHash,'Bounded WebP manifest');
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.schemaVersion,1);
  assert.equal(manifest.abiVersion,BOUNDED_WEBP.abiVersion);
  assert.equal(manifest.version,BOUNDED_WEBP.version);
  assert.equal(manifest.source.file,'libwebp-1.6.0.tar.gz');
  assert.equal(manifest.source.hash,BOUNDED_WEBP.sourceHash);
  check(join(vendor,manifest.source.file),manifest.source);
  assert.equal(manifest.artifact.path,'darwin-arm64/libideogram-webp.1.dylib');
  assert.equal(BOUNDED_WEBP.path,`vendor/raster/bounded-webp/${BOUNDED_WEBP.version}/${manifest.artifact.path}`);
  check(join(root,BOUNDED_WEBP.path),BOUNDED_WEBP);
  assert.equal(manifest.artifact.hash,BOUNDED_WEBP.hash);
  assert.equal(manifest.artifact.bytes,BOUNDED_WEBP.bytes);
  assert.equal(hash(JSON.stringify(manifest.producerInputs)),BOUNDED_WEBP.producerHash);
  for (const input of manifest.producerInputs) {
    assert.match(input.path,/^[A-Za-z0-9_.-]+$/);
    check(join(root,'tooling/raster/bounded-webp',input.path),input);
  }
  for (const notice of manifest.notices) {
    assert(['COPYING','PATENTS','AUTHORS'].includes(notice.path));
    check(join(vendor,notice.path),notice);
  }
  assert.equal(manifest.reproduction.byteIdentical,true);
  assert.equal(manifest.allocatorSelfTest.status,'passed');
  assert.equal(manifest.colorSelfTest.status,'passed');
  return {status:'passed',boundedWebP:BOUNDED_WEBP.hash,source:BOUNDED_WEBP.sourceHash,
    producerInputs:manifest.producerInputs.length,abiVersion:BOUNDED_WEBP.abiVersion};
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(verifyBoundedWebPSeal()));
}
