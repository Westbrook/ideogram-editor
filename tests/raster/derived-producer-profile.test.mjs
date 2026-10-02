import test from 'node:test';
import assert from 'node:assert/strict';
import {CODEC_PROFILES} from '../../dist/local/server/raster/codec-platform.js';
import {ISSUED_IMPORT_PROFILES,importProfileIdentity,matchImportProfile,resolveImportProfile} from '../../dist/local/server/raster/import-profile.js';
import {RASTER_PROFILES,findRasterProfile,resolveRasterProfile} from '../../dist/local/server/raster/profile-registry.js';

// Producer-binding fixtures only. They do not bypass independent strict raster
// manifest validation or claim that an unissued decoder has been qualified.
function unissued(){
  const base=CODEC_PROFILES[0];
  const definition={baseCodec:base.codecId,platform:base.codecs.platform,arch:base.codecs.arch,
    producer:{transport:'png-scanline-file-cp1-v1',mediaType:'image/png',sourceHash:'sha256:'+'1'.repeat(64),artifactHash:null,abiVersion:null},
    kernel:'triangle-area-source-axis-row-norm-v1',color:'fixed-srgb-p3-orientation-v1',qualificationHash:'sha256:'+'2'.repeat(64)};
  const profile={...definition,...importProfileIdentity(definition)};
  assert.equal(ISSUED_IMPORT_PROFILES.some(value=>value.pipeline===profile.pipeline),false);
  const plan={kind:'decoded-derived-v1',codec:profile.codec,kernel:profile.kernel,decodeTransport:profile.producer.transport,
    original:{mediaType:'image/png'},decoderSource:profile.producer.sourceHash};
  return {profile,plan};
}

test('a self-consistent unissued import identity cannot grant retained raster or export admission',()=>{
  const {profile,plan}=unissued();
  assert.equal(matchImportProfile(profile,profile.pipeline,plan),true);
  assert.equal(resolveImportProfile(profile.pipeline,plan),undefined);
  assert.equal(findRasterProfile(profile.pipeline),undefined);
  assert.equal(resolveRasterProfile(profile.pipeline,plan),undefined);
  assert.equal(resolveRasterProfile(profile.pipeline,{kind:'frozen-png-export',encoder:profile.baseCodec}),undefined);
  assert.equal(resolveRasterProfile(profile.pipeline,{kind:'decoded-native',codec:profile.codec}),undefined);
});

test('ordinary issued pipelines never acquire derived semantics by relabeling a native producer',()=>{
  const {plan}=unissued();
  for(const profile of RASTER_PROFILES){
    assert.equal(findRasterProfile(profile.pipeline),profile);
    assert.equal(resolveRasterProfile(profile.pipeline,{...plan,codec:profile.rasterCodecId}),undefined);
    assert.equal(resolveRasterProfile(profile.pipeline,{...plan,kind:'decoded-derived-v2',codec:profile.rasterCodecId}),undefined);
  }
});
