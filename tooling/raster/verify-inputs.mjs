import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {currentRasterCodecProfile,verifyCurrentRasterCodecSeals} from './platform-seals.mjs';
import {verifyImportInventory} from './import-seals/verify.mjs';
const hash=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
const {codecs,codecId}=currentRasterCodecProfile();
assert.equal(process.versions.node,codecs.node);assert.equal(process.versions.zlib,codecs.zlib);assert.equal(process.platform,codecs.platform);assert.equal(process.arch,codecs.arch);assert.deepEqual(sharp.versions,codecs.versions);
for(const f of codecs.files){const b=readFileSync(f.path);assert.equal(b.length,f.bytes,f.path);assert.equal(hash(b),f.hash,f.path);}
for(const [name,f]of Object.entries(codecs.profiles)){const b=readFileSync('tooling/raster/'+name+'.icc');assert.equal(b.length,f.bytes);assert.equal(hash(b),f.hash);}
for(const f of JSON.parse(readFileSync('tests/raster/fixtures/manifest.json')).fixtures){const b=readFileSync('tests/raster/fixtures/'+f.name);assert.equal(b.length,f.bytes,f.name);assert.equal(hash(b),'sha256:'+f.sha256,f.name);}
for(const f of JSON.parse(readFileSync('tests/raster/fixtures/resource-inputs.json')).fixtures){const b=readFileSync(f.file);assert.equal(b.length,f.bytes,f.file);assert.equal(hash(b),'sha256:'+f.sha256,f.file);}
assert.equal(hash(JSON.stringify(codecs)),codecId);
const seals=verifyCurrentRasterCodecSeals();
const imports=verifyImportInventory(process.cwd());
console.log(JSON.stringify({status:'passed',codecIdentity:codecId,codecFiles:codecs.files.length,...seals,imports,fixtureManifests:['manifest.json','resource-inputs.json'],node:process.versions.node}));
