import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { SAFETENSORS_HEADER_MAX, inspectSafetensorsHeader, parseSafetensorsHeaderLength } from '../../dist/local/src/adapters/structure.js';
import { adapterProfileAvailability, inspectAdapterProfile, isSupportedAdapterProfile, matchesSealedAdapterProfile, retainedAdapterProfile } from '../../dist/local/src/adapters/profile.js';
import { canonical } from '../../dist/local/src/protocol/json.js';

const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const code = expected => error => error.code === expected;
const tensor = (dtype = 'F16', shape = [2, 2], data_offsets = [0, 8]) => ({ dtype, shape, data_offsets });
const header = object => Buffer.from(typeof object === 'string' ? object : JSON.stringify(object));
const inspect = (object, dataBytes = 8) => { const bytes = header(object); return inspectSafetensorsHeader(bytes, bytes.length + 8 + dataBytes); };
const prefix = length => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(length)); return bytes; };

test('bounded header inspection produces immutable metadata and deterministic tensor identity without reading tensors', () => {
  const data = { z: tensor('U8', [2], [8, 10]), '__metadata__': { family: 'ideogram-v4', note: '1.0 and -4 are harmless text' }, a: tensor() };
  const structure = inspect(data, 10);
  assert.equal(structure.kind, 'safetensors-inspection-1');
  assert.equal(structure.tensorCount, 2);
  assert.equal(structure.dataBytes, 10);
  assert.deepEqual(structure.dtypes, ['F16', 'U8']);
  assert.deepEqual(structure.tensors.map(t => t.name), ['a', 'z']);
  assert.equal(structure.tensorSignature, hash(canonical(structure.tensors)));
  assert.equal(Object.isFrozen(structure), true);
  assert.equal(Object.isFrozen(structure.tensors[0].shape), true);
  assert.equal(Object.isFrozen(structure.metadata), true);
  const reordered = { a: data.a, z: data.z, '__metadata__': data.__metadata__ };
  assert.equal(inspect(reordered, 10).tensorSignature, structure.tensorSignature);
});

test('prefix parser checks unsigned little endian length before allocating the header', () => {
  assert.equal(parseSafetensorsHeaderLength(prefix(64), 80), 64);
  assert.equal(parseSafetensorsHeaderLength(prefix(SAFETENSORS_HEADER_MAX), SAFETENSORS_HEADER_MAX + 16), SAFETENSORS_HEADER_MAX);
  assert.throws(() => parseSafetensorsHeaderLength(prefix(SAFETENSORS_HEADER_MAX + 1), 20_000_000), code('ADAPTER_HEADER_LIMIT'));
  assert.throws(() => parseSafetensorsHeaderLength(prefix(2n ** 63n), Number.MAX_SAFE_INTEGER), code('ADAPTER_HEADER_LIMIT'));
  for (const [bytes, total] of [[Buffer.alloc(7), 80], [prefix(0), 80], [prefix(80), 80], [prefix(8), NaN], [prefix(8), 1.5]])
    assert.throws(() => parseSafetensorsHeaderLength(bytes, total), code('ADAPTER_INVALID_LENGTH'));
});

test('file size is independent of WA256MiB/1GiB fixtures and weights stay outside parser memory', () => {
  const bytes = 2 ** 32;
  const structure = inspect({ big: tensor('U8', [bytes], [0, bytes]) }, bytes);
  assert.equal(structure.dataBytes, bytes);
  assert.deepEqual(structure.tensors[0].shape, [bytes]);
});

test('scalar and zero-dimensional tensors preserve safetensors meanings', () => {
  const structure = inspect({ scalar: tensor('F64', [], [0, 8]), empty: tensor('F32', [0, 3], [0, 0]) });
  assert.deepEqual(structure.tensors.map(t => t.dataOffsets), [[0, 0], [0, 8]]);
});

test('sub-byte types require exact byte alignment and their declared bit length', () => {
  assert.equal(inspect({ weight: tensor('F4', [2], [0, 1]) }, 1).dataBytes, 1);
  assert.equal(inspect({ weight: tensor('F6_E2M3', [4], [0, 3]) }, 3).dataBytes, 3);
  assert.throws(() => inspect({ weight: tensor('F4', [1], [0, 1]) }, 1), code('ADAPTER_INVALID_TENSOR'));
});

for (const [name, raw] of Object.entries({
  duplicate: '{"w":{"dtype":"F16","shape":[4],"data_offsets":[0,8]},"w":{"dtype":"F16","shape":[4],"data_offsets":[0,8]}}',
  escapedDuplicate: '{"w":{"dtype":"F16","shape":[4],"data_offsets":[0,8]},"\\u0077":{"dtype":"F16","shape":[4],"data_offsets":[0,8]}}',
  nestedDuplicate: '{"w":{"dtype":"F16","dtype":"U8","shape":[8],"data_offsets":[0,8]}}',
  leadingSpace: ' {"w":{"dtype":"F16","shape":[4],"data_offsets":[0,8]}}',
  trailingNewline: '{"w":{"dtype":"F16","shape":[4],"data_offsets":[0,8]}}\n',
  metadataObject: '{"__metadata__":{"family":{"name":"ideogram-v4"}},"w":{"dtype":"F16","shape":[4],"data_offsets":[0,8]}}',
  loneSurrogate: '{"__metadata__":{"value":"\\ud800"},"w":{"dtype":"F16","shape":[4],"data_offsets":[0,8]}}',
  arrayRoot: '[{"dtype":"F16","shape":[4],"data_offsets":[0,8]}]',
})) test('untrusted header rejects ' + name, () => assert.throws(() => inspect(raw), code('ADAPTER_INVALID_HEADER')));

test('space padding is allowed; invalid UTF8 and a BOM are refused', () => {
  const bytes = header({ w: tensor() });
  const padded = Buffer.concat([bytes, Buffer.from('    ')]);
  assert.equal(inspectSafetensorsHeader(padded, padded.length + 16).tensorCount, 1);
  for (const bad of [Buffer.from([0x7b, 0xff, 0x7d]), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes])])
    assert.throws(() => inspectSafetensorsHeader(bad, bad.length + 16), code('ADAPTER_INVALID_HEADER'));
});

test('prototype-shaped keys are inert metadata/tensor labels', () => {
  const structure = inspect('{"__metadata__":{"__proto__":"literal"},"__proto__":{"dtype":"F16","shape":[4],"data_offsets":[0,8]}}');
  assert.equal(structure.metadata.__proto__, 'literal');
  assert.equal(structure.tensors[0].name, '__proto__');
  assert.equal(Object.getPrototypeOf(structure.metadata), null);
});

for (const [name, data] of Object.entries({ gap: { w: tensor('U8', [7], [1, 8]) },
  overlap: { a: tensor(), b: tensor() }, reversed: { w: tensor('F16', [4], [8, 0]) },
  outOfFile: { w: tensor('U8', [9], [0, 9]) }, trailer: { w: tensor('U8', [7], [0, 7]) },
})) test('range validation refuses ' + name, () => assert.throws(() => inspect(data), code('ADAPTER_INVALID_OFFSETS')));

for (const [name, data] of Object.entries({ sizeMismatch: { w: tensor('F32') },
  overflow: { w: tensor('F16', [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]) },
  negativeShape: { w: tensor('F16', [-1]) }, fractionalShape: { w: tensor('F16', [0.5]) },
  negativeOffsets: { w: tensor('F16', [4], [-1, 7]) },
  unknownField: { w: { ...tensor(), code: 'run me' } }, missingField: { w: { dtype: 'F16', shape: [4] } },
})) test('tensor validation refuses ' + name, () => assert.throws(() => inspect(data), code('ADAPTER_INVALID_TENSOR')));

for (const token of ['1e0', '1.0', '-0']) test('shape lexical integer validation refuses ' + token, () => {
  assert.throws(() => inspect('{"w":{"dtype":"U8","shape":[' + token + '],"data_offsets":[0,1]}}', 1), code('ADAPTER_INVALID_TENSOR'));
});

test('unsupported dtype, excessive rank/header and empty weights have explicit dispositions', () => {
  assert.throws(() => inspect({ w: tensor('PICKLE') }), code('ADAPTER_UNSUPPORTED_DTYPE'));
  assert.throws(() => inspect({ w: tensor('F16', Array(65).fill(1)) }), code('ADAPTER_TENSOR_LIMIT'));
  assert.throws(() => inspectSafetensorsHeader(Buffer.alloc(SAFETENSORS_HEADER_MAX + 1), 2_000_000), code('ADAPTER_HEADER_LIMIT'));
  assert.throws(() => inspect({}, 0), code('ADAPTER_EMPTY_WEIGHTS'));
  assert.throws(() => inspect({ empty: tensor('F16', [0], [0, 0]) }, 0), code('ADAPTER_EMPTY_WEIGHTS'));
});

const input = () => ({ structure: inspect({ w: tensor(), __metadata__: { family: 'ideogram-v4' } }),
  weightsHash: hash('synthetic unit fixture only'), declaredFamily: 'ideogram-v4', declaredFormat: 'fal',
  configHash: null, origin: 'import' });
test('generic readable weights and declared V4 family cannot create local eligibility', () => {
  const report = inspectAdapterProfile(input());
  assert.equal(adapterProfileAvailability.supportedProfiles, 1);
  assert.equal(report.status, 'structurally-valid');
  assert.equal(report.locallyEligible, false);
  assert.equal(report.runtimeVerified, false);
  assert.equal(report.profileId, null);
  assert.match(report.reason, /Config not supplied/);
  assert.equal(inspectAdapterProfile({ ...input(), configHash: hash('config') }).locallyEligible, false);
});
test('known other families/formats are blocked without conversion or false runtime evidence', () => {
  for (const change of [{ declaredFamily: 'flux' }, { declaredFamily: 'sdxl' }, { declaredFamily: 'ideogram-v3' }, { declaredFormat: 'comfy' }]) {
    const report = inspectAdapterProfile({ ...input(), ...change });
    assert.equal(report.status, 'incompatible');
    assert.equal(report.locallyEligible, false);
    assert.equal(report.runtimeVerified, false);
  }
});
test('training weights alone remain partial even when their declaration says V4', () => {
  const report = inspectAdapterProfile({ ...input(), origin: 'training' });
  assert.equal(report.locallyEligible, false);
  assert.match(report.reason, /training configuration is still required/);
});
test('exact evidence comparison binds all immutable identities but cannot install a production profile', () => {
  const fixture = input();
  const profile = { kind: 'ideogram-v4-artifact-profile-1', id: 'unit-fixture-no-provider-qualification',
    family: 'ideogram-v4', format: 'fal', weightsHash: fixture.weightsHash, configHash: null,
    tensorSignature: fixture.structure.tensorSignature, evidenceHash: hash('synthetic comparison only') };
  assert.equal(matchesSealedAdapterProfile(fixture, profile), true);
  for (const change of [{ weightsHash: hash('replacement') }, { configHash: hash('replacement') },
    { declaredFamily: 'flux' }, { declaredFormat: 'comfy' }, { origin: 'training' },
    { structure: { ...fixture.structure, tensorSignature: hash('replacement') } }])
    assert.equal(matchesSealedAdapterProfile({ ...fixture, ...change }, profile), false);
  assert.equal(matchesSealedAdapterProfile(fixture, { ...profile, evidenceHash: 'user-says-trusted' }), false);
  assert.equal(inspectAdapterProfile(fixture, profile).locallyEligible, false);
});

test('the exact provider-published artifact has a sealed local profile with absent config and no runtime claim', async () => {
  const retainedHeader = await readFile(new URL('./fixtures/v4-fal-public-example-1.header.json', import.meta.url));
  const retainedEvidence = await readFile(new URL('./fixtures/v4-fal-public-example-1.evidence.json', import.meta.url));
  assert.equal(hash(retainedHeader), 'sha256:891fac6bb33a682f6a2530133899d9695894a9e525a6e06c68816033bb2592fe');
  assert.equal(hash(retainedEvidence), 'sha256:82f0300bf1d374171a250237a8c18017288f28f80dad5b916557c8e241bb9dbd');
  const evidence = JSON.parse(retainedEvidence);
  assert.equal(evidence.sourceURL, 'https://fal.ai/models/ideogram/v4/lora/examples');
  assert.equal(evidence.providerCalled, false);
  assert.equal(evidence.observations.providerPublishedTerminalOutput, null);
  const structure = inspectSafetensorsHeader(retainedHeader, evidence.observations.fullObjectBytes);
  assert.equal(structure.tensorCount, 510);
  assert.equal(structure.headerBytes, 69640);
  assert.equal(structure.dataBytes, 85_230_248);
  assert.deepEqual(structure.dtypes, ['BF16', 'F32']);
  assert.equal(structure.tensorSignature, 'sha256:7df49bdf7165de3986b1360a4f9510340fa7b96927405d339d751c83f937d9c6');
  const known = { structure, weightsHash: 'sha256:' + evidence.observations.fullObjectSHA256, configHash: null,
    declaredFamily: 'ideogram-v4', declaredFormat: 'fal', origin: 'import' };
  const expected = { status: 'structurally-valid', locallyEligible: true, profileId: 'v4-fal-public-example-1',
    runtimeVerified: false, reason: 'Locally eligible; not runtime verified. Explicit request acknowledgement is required.' };
  assert.deepEqual(inspectAdapterProfile(known), expected);
  assert.deepEqual(retainedAdapterProfile({ ...known, tensorSignature: structure.tensorSignature }), expected);
  assert.equal(isSupportedAdapterProfile(expected.profileId), true);
  assert.equal(isSupportedAdapterProfile('v4-safe-1'), false);
  assert.equal(isSupportedAdapterProfile('imported-profile'), false);
  for (const change of [{ weightsHash: hash('other valid weights with identical tensor structure') },
    { configHash: hash('unqualified config') }, { declaredFamily: 'flux' }, { declaredFormat: 'comfy' },
    { origin: 'training' }, { structure: { ...structure, tensorSignature: hash('different tensor structure') } }])
    assert.equal(inspectAdapterProfile({ ...known, ...change }).locallyEligible, false);
  assert.equal(retainedAdapterProfile({ ...known, tensorSignature: hash('forged structure') }).locallyEligible, false);
});
