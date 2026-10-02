import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {canonical,JSONError,parseControlJSON,CONTROL_BYTES} from '../../tooling/raster/import-seals/pinned-canonical.mjs';
import {lowerPinnedCanonicalSource} from '../../tooling/raster/import-seals/pinned-canonical-source.mjs';

test('pinned same-realm canonical loader preserves error properties and parser/canonical rejection',()=>{
 const error=new JSONError('MALFORMED_REQUEST');
 assert(error instanceof Error);assert.equal(error.message,'MALFORMED_REQUEST');
 assert.deepEqual(Object.getOwnPropertyDescriptor(error,'code'),{value:'MALFORMED_REQUEST',writable:true,enumerable:true,configurable:true});
 assert.equal(canonical({z:1,a:'\n'}),'{"a":"\\u000a","z":1}');
 assert.deepEqual(parseControlJSON(Buffer.from('{"value":1}')),{value:1});
 for(const action of [()=>canonical(NaN),()=>canonical('\ud800'),()=>parseControlJSON(Buffer.from('{"a":1,"a":2}'))])assert.throws(action,error=>error instanceof JSONError&&error.code==='MALFORMED_REQUEST');
 assert.throws(()=>parseControlJSON(Buffer.alloc(CONTROL_BYTES+1)),error=>error instanceof JSONError&&error.code==='PAYLOAD_TOO_LARGE');
});

test('loader refuses constructor or canonical-body drift before stripping or evaluation',()=>{
 const original=readFileSync(new URL('../../src/protocol/json.ts',import.meta.url));
 assert.throws(()=>lowerPinnedCanonicalSource(original.toString('utf8')),/exact captured bytes/);
 for(const [from,to] of [['super(code)','super(null)'],['cp < 32','cp < 33']]){
  const changed=Buffer.from(original.toString('utf8').replace(from,to));
  assert.notDeepEqual(changed,original);assert.throws(()=>lowerPinnedCanonicalSource(changed),/Changed canonical source/);
 }
 assert.throws(()=>lowerPinnedCanonicalSource(Buffer.concat([original,Buffer.from('\n')])),/Changed canonical source length/);
});


// Retained legacy issuer metadata remains data: no captured source is executed.
import {createHash} from 'node:crypto';
import {PNG_ISSUER_PATHS,validatePNGProducerSource} from '../../tooling/raster/import-issuance/png-contract.mjs';
import {jpegProducerAuthority} from '../../tooling/raster/import-seals/native-contract.mjs';
const digest=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
test('retained five-input PNG issuer remains verifiable by its exact manifest identity',()=>{
 const bytes=readFileSync(new URL('./fixtures/png-issuer-source-v2.json',import.meta.url)),manifest=JSON.parse(bytes),manifestHash=digest(bytes);
 assert.equal(manifestHash,'sha256:f7beb911eb486875ffbd9d7e9132c6c90bb4536e2d874932db7b5bda35c0d3ab');
 const source={producerSourceHash:manifestHash,sourceHash:manifest.sourceHash};
 assert.equal(validatePNGProducerSource(source,manifest,manifestHash),manifest);
 const otherHash=digest(Buffer.concat([bytes,Buffer.from('\n')]));
 assert.throws(()=>validatePNGProducerSource({...source,producerSourceHash:otherHash},manifest,otherHash));
});
test('current six-input PNG issuer includes the actual pinned canonical source helper',()=>{
 const bytes=readFileSync(new URL('../../tooling/raster/import-issuance/png-source-manifest.json',import.meta.url)),manifest=JSON.parse(bytes),source=JSON.parse(readFileSync(new URL('../../tooling/raster/import-issuance/png-source.json',import.meta.url)));
 assert.equal(validatePNGProducerSource(source,manifest,digest(bytes)),manifest);assert.equal(PNG_ISSUER_PATHS.length,6);
 const helper=manifest.files.find(row=>row.path==='tooling/raster/import-seals/pinned-canonical-source.mjs');assert(helper);
 const actual=readFileSync(new URL('../../'+helper.path,import.meta.url));assert.equal(actual.length,helper.bytes);assert.equal(digest(actual),helper.hash);
});
test('JPEG v5 authority is exact while retained v3 and v4 remain separate',()=>{
 assert.deepEqual(jpegProducerAuthority('sha256:7267ad6b8347876d4dfe0498d93239ccb424c03d441a2f730abb58c56d0aa1ec'),{directory:'producer-v5',kind:'jpeg-scanline-producer-source-v5'});
 assert.deepEqual(jpegProducerAuthority('sha256:053ad79aa0e1256efcc5dd103e04ae4f086cf2b23a24a01ffe889c556db4a318'),{directory:'producer-v3',kind:'jpeg-scanline-producer-source-v3'});
 assert.deepEqual(jpegProducerAuthority('sha256:f8ba056eeba5d7ac6e77797d62684bd285c4d569fec8e3101683b49ac5bf1e64'),{directory:'producer-v4',kind:'jpeg-scanline-producer-source-v4'});
 assert.throws(()=>jpegProducerAuthority(digest('unreviewed v5-like source')),/Unreviewed JPEG producer authority/);
});
