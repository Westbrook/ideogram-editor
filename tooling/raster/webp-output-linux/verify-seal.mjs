import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {verifyWebPOutputSeal} from '../webp-output/verify-seal.mjs';
const producer=dirname(fileURLToPath(import.meta.url));
const root=resolve(producer,'../../..');
const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
export function verifyWebPOutputPlatformSeal(profile) {
  const verified=verifyWebPOutputSeal(profile);
  if(profile.platform!=='linux')return verified;
  const manifest=JSON.parse(readFileSync(join(root,'vendor/raster/webp-output',profile.version,`linux-${profile.arch}`,'manifest.json')));
  assert.equal(manifest.priorProducer.manifestHash,'sha256:44468404dc9c2ca6f7dfd6538e6753b3fc3cff2e45196299d0a560ed938abe57');
  assert.equal(hash(readFileSync(join(root,'vendor/raster/webp-output',profile.version,'darwin-arm64/manifest.json'))),manifest.priorProducer.manifestHash);
  assert.equal(hash(JSON.stringify(manifest.platformProducerInputs)),profile.platformProducerHash);
  for(const input of manifest.platformProducerInputs) {
    assert.match(input.path,/^[A-Za-z0-9_.-]+$/);
    const bytes=readFileSync(join(producer,input.path));
    assert.equal(bytes.length,input.bytes);assert.equal(hash(bytes),input.hash);
  }
  return {...verified,platformProducerInputs:manifest.platformProducerInputs.length};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  assert(process.argv[2],'Pass a sealed identity.json path');
  console.log(JSON.stringify(verifyWebPOutputPlatformSeal(JSON.parse(readFileSync(resolve(process.argv[2]))))));
}
