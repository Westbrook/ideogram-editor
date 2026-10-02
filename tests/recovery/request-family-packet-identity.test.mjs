// Identity arithmetic only: this synthetic descriptor is not a qualified or
// accepted rollback packet. Real packet qualification belongs to the producer.
import test from 'node:test';
import assert from 'node:assert/strict';
import {schema17PacketIdentity} from '../../dist/local/server/storage/schema.js';
const digest='sha256:'+'a'.repeat(64);
const descriptor=()=>({kind:'schema17-executable-packet-1',storageVersion:17,packetId:'fixture_packet',sourceArchive:{path:'/producer/source',hash:digest,byteLength:'12'},sourceManifest:{path:'/producer/source-manifest',hash:digest,byteLength:'12'},compiler:{name:'typescript',version:'fixture',identity:digest},toolchain:{node:'26.10.0',npm:'12.1.0',identity:digest},dependencies:{lockfileHash:digest,vendorManifestHash:digest,identity:digest},native:{profileHash:digest,artifactManifestHash:digest},platform:{os:'darwin',arch:'arm64',identity:digest},compiledClosures:[{name:'local',archive:{path:'/producer/local',hash:digest,byteLength:'12'},manifest:{path:'/producer/local-manifest',hash:digest,byteLength:'12'}}],verifiedFreshRestore:{receipt:{path:'/producer/receipt',hash:digest,byteLength:'12'},sourceArchiveHash:digest,compiledClosureHash:digest,result:'verified'}});
test('installed packet path relocation preserves content identity only for exact sealed-file objects',()=>{
 const source=descriptor(),relocated=structuredClone(source);
 const visit=value=>{if(!value||typeof value!=='object')return;if(Object.keys(value).sort().join(',')==='byteLength,hash,path')value.path=value.path.replace('/producer/','/owned/rollback-executables/fixture_packet/');else for(const child of Object.values(value))visit(child);};visit(relocated);
 assert.equal(schema17PacketIdentity(source),schema17PacketIdentity(relocated));
 relocated.sourceArchive.byteLength='13';assert.notEqual(schema17PacketIdentity(source),schema17PacketIdentity(relocated));
 const changed=descriptor();changed.compiledClosures[0].archive.hash='sha256:'+'b'.repeat(64);assert.notEqual(schema17PacketIdentity(source),schema17PacketIdentity(changed));
});
test('native platform and semantic identity fields remain part of installed packet identity',()=>{
 const source=descriptor();for(const change of [v=>{v.platform.arch='x64';},v=>{v.native.profileHash='sha256:'+'c'.repeat(64);},v=>{v.verifiedFreshRestore.result='unverified';},v=>{v.toolchain.node='0.0.0';}]){const value=structuredClone(source);change(value);assert.notEqual(schema17PacketIdentity(source),schema17PacketIdentity(value));}
 const a={...source,nonFile:{path:'/first',meaning:'not a sealed file'}},b={...source,nonFile:{path:'/second',meaning:'not a sealed file'}};assert.notEqual(schema17PacketIdentity(a),schema17PacketIdentity(b));
});
