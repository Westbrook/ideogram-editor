import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {CODECS as MAC_CODECS,CODEC_ID as MAC_CODEC_ID} from '../../server/raster/identity.ts';
import {CODECS as LINUX_ARM64_CODECS,CODEC_ID as LINUX_ARM64_CODEC_ID} from '../../server/raster/identities/linux-arm64-v1.ts';
import {CODECS as LINUX_X64_CODECS,CODEC_ID as LINUX_X64_CODEC_ID} from '../../server/raster/identities/linux-x64-v1.ts';
import {BOUNDED_WEBP as MAC_BOUNDED_WEBP} from '../../server/raster/webp-identity.ts';
import {BOUNDED_WEBP_LINUX_ARM64} from '../../server/raster/webp-linux-arm64-identity.ts';
import {BOUNDED_WEBP_LINUX_X64} from '../../server/raster/webp-linux-x64-identity.ts';
import {LINUX_COLOR_ARM64} from '../../server/raster/linux-color-arm64-identity.ts';
import {LINUX_COLOR_X64} from '../../server/raster/linux-color-x64-identity.ts';
import {verifyLinuxBoundedWebPSeal} from './bounded-webp-linux/verify-seal.mjs';
import {verifyLinuxColorSeal} from './linux-color/verify-seal.mjs';
import {WEBP_OUTPUT_DARWIN_ARM64} from '../../server/raster/webp-output-darwin-arm64-identity.ts';
import {WEBP_OUTPUT_LINUX_ARM64} from '../../server/raster/webp-output-linux-arm64-identity.ts';
import {WEBP_OUTPUT_LINUX_X64} from '../../server/raster/webp-output-linux-x64-identity.ts';
import {verifyWebPOutputPlatformSeal} from './webp-output-linux/verify-seal.mjs';

const root = resolve(import.meta.dirname,'../..');
const hash = bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');

// The original macOS verifier is part of its immutable producer seal and
// deliberately requires a matching host. Foreign portable profiles still need
// the same file proof; verify their bytes here without loading native code or
// weakening the original verifier's host requirement.
function verifyMacBoundedFiles() {
  const identity = MAC_BOUNDED_WEBP;
  const vendor = join(root,'vendor/raster/bounded-webp',identity.version);
  const check = (path,expected)=> {
    const bytes = readFileSync(path);
    assert.equal(bytes.length,expected.bytes,path); assert.equal(hash(bytes),expected.hash,path);
  };
  const bytes = readFileSync(join(vendor,'manifest.json'));
  assert.equal(hash(bytes),identity.manifestHash,'Foreign macOS WebP manifest');
  const manifest = JSON.parse(bytes);
  assert.equal(manifest.schemaVersion,1);
  for (const key of ['version','platform','arch','abiVersion']) assert.equal(manifest[key],identity[key]);
  assert.equal(manifest.source.file,'libwebp-1.6.0.tar.gz');
  assert.equal(manifest.source.hash,identity.sourceHash);
  check(join(vendor,manifest.source.file),manifest.source);
  assert.equal(manifest.artifact.path,'darwin-arm64/libideogram-webp.1.dylib');
  assert.equal(identity.path,`vendor/raster/bounded-webp/${identity.version}/${manifest.artifact.path}`);
  assert.equal(manifest.artifact.hash,identity.hash); assert.equal(manifest.artifact.bytes,identity.bytes);
  check(join(root,identity.path),identity);
  assert.equal(hash(JSON.stringify(manifest.producerInputs)),identity.producerHash);
  for (const input of manifest.producerInputs) {
    assert.match(input.path,/^[A-Za-z0-9_.-]+$/);
    check(join(root,'tooling/raster/bounded-webp',input.path),input);
  }
  for (const notice of manifest.notices) {
    assert(['COPYING','PATENTS','AUTHORS'].includes(notice.path)); check(join(vendor,notice.path),notice);
  }
  assert.equal(manifest.reproduction.byteIdentical,true);
  assert.equal(manifest.allocatorSelfTest.status,'passed'); assert.equal(manifest.colorSelfTest.status,'passed');
  return {status:'passed',boundedWebP:identity.hash,source:identity.sourceHash,
    producerInputs:manifest.producerInputs.length,abiVersion:identity.abiVersion};
}

// Source-only verification must run before the first server build. These pure
// generated identity modules can be loaded by Node's pinned TypeScript support.
const profiles = [
  {codecs:MAC_CODECS,codecId:MAC_CODEC_ID,boundedWebP:MAC_BOUNDED_WEBP,webpOutput:WEBP_OUTPUT_DARWIN_ARM64},
  {codecs:LINUX_ARM64_CODECS,codecId:LINUX_ARM64_CODEC_ID,boundedWebP:BOUNDED_WEBP_LINUX_ARM64,color:LINUX_COLOR_ARM64,webpOutput:WEBP_OUTPUT_LINUX_ARM64},
  {codecs:LINUX_X64_CODECS,codecId:LINUX_X64_CODEC_ID,boundedWebP:BOUNDED_WEBP_LINUX_X64,color:LINUX_COLOR_X64,webpOutput:WEBP_OUTPUT_LINUX_X64},
];
export function currentRasterCodecProfile() {
  const selected = profiles.find(profile=>profile.codecs.platform===process.platform&&profile.codecs.arch===process.arch);
  assert(selected,'RASTER_CODEC_UNQUALIFIED: no adopted platform profile');
  return selected;
}
export function verifyCurrentRasterCodecSeals() {
  const selected = currentRasterCodecProfile();
  const verifiedProfiles = profiles.map(profile=> {
    const current = profile === selected;
    assert.equal(profile.webpOutput.decoderHash,profile.boundedWebP.hash,'Output transport and decoder identity differ');
    assert.equal(profile.webpOutput.converterHash,profile.color?.hash??profile.boundedWebP.hash,'Output transport and color identity differ');
    const output=verifyWebPOutputPlatformSeal(profile.webpOutput);
    if (profile.codecs.platform === 'darwin') {
      const original = JSON.parse(readFileSync(join(root,'tooling/raster/codecs.json')));
      assert.deepEqual(original,profile.codecs,'Original macOS CODECS identity changed');
      assert.equal(hash(JSON.stringify(original)),profile.codecId,'Original macOS codec hash changed');
      return {platform:profile.codecs.platform,arch:profile.codecs.arch,codecIdentity:profile.codecId,current,
        bounded:verifyMacBoundedFiles(),output};
    }
    // File-only foreign verification still checks generated CODECS identity,
    // source/lock/ICC/producer seals and color/WebP artifacts. Only the current
    // platform resolves and checks its installed native dependency bytes.
    const color = verifyLinuxColorSeal({arch:profile.codecs.arch,installed:current});
    assert.equal(color.identity.hash,profile.color.hash,'Runtime and producer color identities differ');
    assert.equal(color.identity.codecIdentity,profile.codecId,'Runtime and producer CODECS identities differ');
    return {platform:profile.codecs.platform,arch:profile.codecs.arch,codecIdentity:profile.codecId,current,
      color,bounded:verifyLinuxBoundedWebPSeal(profile.boundedWebP),output};
  });
  const current = verifiedProfiles.find(profile=>profile.current);
  return {...(current.color?{color:current.color}:{}),bounded:current.bounded,output:current.output,verifiedProfiles};
}
