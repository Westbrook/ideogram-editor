import test from 'node:test';
import assert from 'node:assert/strict';
import {importProfileIdentity,matchImportProfile,resolveImportProfile,ISSUED_IMPORT_PROFILES} from '../../dist/local/server/raster/import-profile.js';

// Synthetic descriptors test identity mechanics only. They are deliberately
// absent from the issued inventory and confer no runtime qualification.
const sha=n=>'sha256:'+String(n).repeat(64);
function fixture(transport='png-scanline-file-cp1-v1'){
 const native=transport!=='png-scanline-file-cp1-v1',mediaType=transport.startsWith('png')?'image/png':transport.startsWith('jpeg')?'image/jpeg':'image/webp';
 const definition={baseCodec:sha(1),platform:'darwin',arch:'arm64',producer:{transport,mediaType,sourceHash:sha(2),artifactHash:native?sha(3):null,abiVersion:native?1:null},kernel:'triangle-area-source-axis-row-norm-v1',color:'fixed-srgb-p3-orientation-v1',qualificationHash:sha(4)};
 const profile={...definition,...importProfileIdentity(definition)};
 const plan={kind:'decoded-derived-v1',codec:profile.codec,kernel:profile.kernel,decodeTransport:transport,original:{mediaType},decoderSource:sha(2),...(native?{decoderBuild:sha(3),decoderABI:1}:{})};
 return {profile,plan};
}
test('unissued source-derived profiles never resolve to production support',()=>{
 const {profile,plan}=fixture();assert.equal(ISSUED_IMPORT_PROFILES.some(p=>p.pipeline===profile.pipeline),false);assert.equal(resolveImportProfile(profile.pipeline,plan),undefined);
 assert.equal(matchImportProfile(profile,profile.pipeline,plan),true);
});
test('producer identity binds source, qualification, pipeline, platform and color arithmetic',()=>{
 const {profile,plan}=fixture();assert.equal(matchImportProfile(profile,profile.pipeline,plan,{platform:'darwin',arch:'arm64'}),true);
 for(const mutated of [{...profile,qualificationHash:sha(5)},{...profile,baseCodec:sha(5)},{...profile,producer:{...profile.producer,sourceHash:sha(5)}},{...profile,color:'other'}])assert.equal(matchImportProfile(mutated,profile.pipeline,plan),false);
 assert.equal(matchImportProfile(profile,'historical-pipeline',plan),false);assert.equal(matchImportProfile(profile,profile.pipeline,plan,{platform:'linux',arch:'arm64'}),false);
 for(const mutated of [{...plan,codec:sha(5)},{...plan,decoderSource:sha(5)},{...plan,kernel:'native-scale'},{...plan,decodeTransport:'webp-advanced-file-v1'},{...plan,original:{mediaType:'image/jpeg'}},{...plan,decoderBuild:sha(3)},{...plan,decoderABI:1}])assert.equal(matchImportProfile(profile,profile.pipeline,mutated),false);
});
for(const transport of ['jpeg-scanline-file-v1','webp-advanced-file-v1'])test(transport+' requires exact native artifact and ABI without transport substitution',()=>{
 const {profile,plan}=fixture(transport);assert.equal(matchImportProfile(profile,profile.pipeline,plan),true);
 for(const mutated of [{...plan,decoderBuild:undefined},{...plan,decoderBuild:sha(9)},{...plan,decoderABI:2},{...plan,decoderABI:undefined},{...plan,decodeTransport:'png-scanline-file-cp1-v1'}])assert.equal(matchImportProfile(profile,profile.pipeline,mutated),false);
});
