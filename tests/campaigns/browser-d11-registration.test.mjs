import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  prepareD11RegistrationContract,
  readD11RegistrationArchiveMember,
  verifyD11RegistrationContract,
} from '../../tooling/qualification/campaigns/browser-d11-registration.mjs';

const BLOCK = 512, ARCHIVE_LIMIT = 2 * 1048576, EXPANDED_LIMIT = 16 * 1048576;
const selected = 'package/register.js';
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const integrity = bytes => 'sha512-' + createHash('sha512').update(bytes).digest('base64');

// These tiny tar specimens exercise parsing boundaries only. Their text is
// never imported, evaluated, extracted to disk, or used as product evidence.
function octal(header, offset, width, value) {
  header.write(value.toString(8).padStart(width - 1, '0') + '\0', offset, width, 'ascii');
}

function checksum(header) {
  header.fill(32, 148, 156);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
}

function member({ name = selected, text = 'registration fixture', type = '0', prefix = '', link = '', mutateHeader, reseal = true } = {}) {
  const bytes = Buffer.from(text), header = Buffer.alloc(BLOCK);
  assert(Buffer.byteLength(name) < 100); assert(Buffer.byteLength(prefix) < 155);
  header.write(name, 0, 100, 'utf8');
  octal(header, 100, 8, 0o644); octal(header, 108, 8, 0); octal(header, 116, 8, 0);
  octal(header, 124, 12, bytes.length); octal(header, 136, 12, 0);
  header.write(type, 156, 1, 'ascii'); header.write(link, 157, 100, 'utf8');
  header.write('ustar\0', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii');
  header.write(prefix, 345, 155, 'utf8'); checksum(header);
  if (mutateHeader) { mutateHeader(header); if (reseal) checksum(header); }
  return Buffer.concat([header, bytes, Buffer.alloc((BLOCK - bytes.length % BLOCK) % BLOCK)]);
}

function tar(entries = [{}], { terminators = 2, padding = 0 } = {}) {
  return Buffer.concat([...entries.map(member), Buffer.alloc(terminators * BLOCK + padding)]);
}

const archive = (entries, options) => gzipSync(tar(entries, options));
const readMember = bytes => readD11RegistrationArchiveMember(bytes, selected);

test('D11 registration archive reads exact regular-file bytes and counts every member', () => {
  for (const type of ['0', '\0']) {
    const entries = [{ name: 'package/before.js', text: 'before' }, { type, text: 'selected\n\u03bb' }, { name: 'package/after.js', text: 'after' }];
    const result = readMember(archive(entries));
    assert(Buffer.isBuffer(result.bytes)); assert.deepEqual(result.bytes, Buffer.from('selected\n\u03bb'));
    assert.equal(result.entryCount, entries.length);
  }
  assert.deepEqual(readMember(archive([{ text: '' }])).bytes, Buffer.alloc(0));
  assert.deepEqual(readMember(archive([{ name: 'register.js', prefix: 'package' }])).bytes, Buffer.from('registration fixture'));
});

test('D11 registration archive rejects a missing member and every duplicate path', () => {
  assert.throws(() => readMember(archive([{ name: 'package/other.js' }])));
  for (const entries of [
    [{}, {}],
    [{}, { name: 'package/other.js' }, {}],
    [{}, { name: 'package/other.js' }, { name: 'package/other.js' }],
  ]) assert.throws(() => readMember(archive(entries)), 'duplicate members cannot be hidden after selection');
});

test('D11 registration archive rejects unsafe member paths before or after selection', () => {
  for (const name of ['/package/other.js', '../other.js', 'package/../other.js', './package/other.js',
    'package//other.js', 'package/./other.js', 'package\\other.js', 'other.js', 'package/', 'package/other.js?query', 'package/other.js\n']) {
    for (const entries of [[{ name }, {}], [{}, { name }]]) assert.throws(() => readMember(archive(entries)), name);
  }
  assert.throws(() => readMember(archive([{}, { name: 'other.js', prefix: 'package/..' }])));
  for (const path of ['', '../register.js', '/package/register.js', 'package//register.js', 'package/../register.js']) {
    assert.throws(() => readD11RegistrationArchiveMember(archive(), path), path);
  }
  assert.throws(() => readMember(archive([{ mutateHeader: header => { header.write(selected + '\0hidden', 0, 100, 'ascii'); } }])));
});

test('D11 registration archive rejects links and special entries even after a selected file', () => {
  for (const type of ['1', '2', '3', '4', '5', '6', '7', 'x', 'g', 'L', 'K']) {
    assert.throws(() => readMember(archive([{}, { name: 'package/other.js', type, text: '' }])), type);
  }
  assert.throws(() => readMember(archive([{ link: 'package/target.js' }])));
});

test('D11 registration archive rejects corrupt checksums and malformed octal sizes', () => {
  assert.throws(() => readMember(archive([{ mutateHeader: header => { header[106] ^= 1; }, reseal: false }])));
  for (const value of ['00000000024x', '00000000008\0', '-0000000001\0', '000000001x\0 ', '00001\0' + '00002\0']) {
    assert.throws(() => readMember(archive([{ mutateHeader: header => { header.fill(0, 124, 136); header.write(value, 124, 12, 'ascii'); } }])), JSON.stringify(value));
  }
  assert.throws(() => readMember(archive([{ mutateHeader: header => { header[124] = 0x80; } }])));
  assert.throws(() => readMember(archive([{ mutateHeader: header => { header.write('77777777777\0', 124, 12, 'ascii'); } }])));
});

test('D11 registration archive rejects truncated gzip, headers, payloads, and padding', () => {
  const compressed = archive([{ text: 'payload' }]);
  assert.throws(() => readMember(compressed.subarray(0, compressed.length - 1)));
  assert.throws(() => readMember(Buffer.from('not gzip')));
  const complete = tar([{ text: 'payload' }]);
  for (const length of [BLOCK - 1, BLOCK + 1, BLOCK + 7, BLOCK * 2 - 1]) {
    assert.throws(() => readMember(gzipSync(complete.subarray(0, length))), 'truncated tar length ' + length);
  }
  const badPadding = Buffer.from(complete); badPadding[BLOCK + 7] = 1;
  assert.throws(() => readMember(gzipSync(badPadding)), /padding/);
});

test('D11 registration archive requires two zero terminators and only zero padding', () => {
  assert.deepEqual(readMember(archive([{}], { padding: BLOCK * 2 })).bytes, Buffer.from('registration fixture'));
  for (const terminators of [0, 1]) assert.throws(() => readMember(archive([{}], { terminators })));
  const tail = Buffer.alloc(BLOCK); tail[0] = 1;
  const nonzeroPadding = Buffer.concat([tar(), tail]);
  assert.throws(() => readMember(gzipSync(nonzeroPadding)));
  const interruptedEnd = Buffer.concat([member(), Buffer.alloc(BLOCK), member({ name: 'package/after.js' }), Buffer.alloc(BLOCK * 2)]);
  assert.throws(() => readMember(gzipSync(interruptedEnd)));
  assert.throws(() => readMember(Buffer.concat([archive(), archive([{ name: 'package/after.js' }])])));
});

test('D11 registration archive enforces compressed and expanded byte bounds', () => {
  assert.throws(() => readMember(Buffer.alloc(ARCHIVE_LIMIT + 1)), /bound|limit|large|exceed/i);
  const base = tar(), exact = Buffer.concat([base, Buffer.alloc(EXPANDED_LIMIT - base.length)]);
  assert.deepEqual(readMember(gzipSync(exact)).bytes, Buffer.from('registration fixture'));
  assert.throws(() => readMember(gzipSync(Buffer.concat([exact, Buffer.alloc(1)]))), /bound|limit|large|exceed/i);
});

test('D11 registration archive accepts the entry limit and rejects one further member', () => {
  const entries = [{ text: '' }, ...Array.from({ length: 4095 }, (_, index) => ({ name: 'package/empty-' + index, text: '' }))];
  assert.equal(readMember(archive(entries)).entryCount, 4096);
  assert.throws(() => readMember(archive([...entries, { name: 'package/one-too-many', text: '' }])), /bound|limit|large|exceed/i);
});

test('D11 registration archive separately bounds selected registration member bytes', () => {
  const bytes = Buffer.alloc(64 * 1024, 97);
  assert.deepEqual(readMember(archive([{ text: bytes }])).bytes, bytes);
  assert.throws(() => readMember(archive([{ text: Buffer.concat([bytes, Buffer.from('a')]) }])), /member.*bound/i);
});

const repo = resolve(fileURLToPath(new URL('../../', import.meta.url)));
let fixturePromise;
function contractFixture() {
  fixturePromise ??= (async () => {
    const lock = JSON.parse(await readFile(join(repo, 'package-lock.json'), 'utf8'));
    const contract = await prepareD11RegistrationContract({ repo, read: async path => ({ bytes: await readFile(join(repo, path)) }) });
    return { contract, lock };
  })();
  return fixturePromise;
}

test('D11 registration contract binds the exact reviewed package, archive, and member identities', async () => {
  const { contract, lock } = await contractFixture(), verified = verifyD11RegistrationContract(contract, { lock });
  assert.equal(contract.kind, 'perf-d11-registration-contract-1');
  assert.equal(verified.kind, 'verified-d11-registration-contract-1'); assert.equal(verified.sourceIdentity, contract.sourceIdentity);
  assert.deepEqual(verified.publicExports, {
    scope: { module: '@en-reve/elements/element-scope.js', export: 'createElementScope' },
    registration: { module: '@en-reve/primitives/interactions/registration.js', export: 'registerDefinitions' },
  });
  assert.equal(contract.archives.length, 2); assert.equal(contract.members.length, 2);
  const metadataBytes = Buffer.from(contract.packagesMetadata.text);
  assert.equal(contract.packagesMetadata.rawBytes, metadataBytes.length);
  assert.equal(contract.packagesMetadata.sha256, digest(metadataBytes));
  for (const item of contract.archives) {
    const bytes = Buffer.from(item.data, 'base64');
    assert.equal(item.encoding, 'base64'); assert.equal(item.data, bytes.toString('base64'));
    assert.equal(item.rawBytes, bytes.length); assert.equal(item.sha256, digest(bytes));
    assert.equal(item.integrity, integrity(bytes));
    assert.equal(item.integrity, lock.packages['node_modules/' + item.package].integrity);
  }
  for (const item of contract.members) {
    const packed = contract.archives.find(row => row.path === item.archivePath);
    assert(packed); assert.equal(packed.package, item.package);
    const { bytes } = readD11RegistrationArchiveMember(Buffer.from(packed.data, 'base64'), item.memberPath);
    assert.equal(item.text, bytes.toString('utf8')); assert.equal(item.rawBytes, bytes.length); assert.equal(item.sha256, digest(bytes));
  }
  const expectedInputs = [contract.packagesMetadata, ...contract.archives].map(({ path, rawBytes, sha256 }) => ({ path, rawBytes, sha256 }));
  assert.deepEqual([...verified.inputs].sort((a, b) => a.path.localeCompare(b.path)), expectedInputs.sort((a, b) => a.path.localeCompare(b.path)));
  assert.deepEqual(verifyD11RegistrationContract(structuredClone(contract), { lock: structuredClone(lock) }), verified);
});

test('D11 registration contract rejects changed encoding, archive bytes, hashes, sizes, and integrity', async () => {
  const { contract, lock } = await contractFixture();
  for (const mutate of [
    item => { item.encoding = 'utf8'; },
    item => { item.data += '='; },
    item => { const bytes = Buffer.from(item.data, 'base64'); bytes[bytes.length - 1] ^= 1; item.data = bytes.toString('base64'); },
    item => { item.sha256 = 'sha256:' + '0'.repeat(64); },
    item => { item.rawBytes += 1; },
    item => { item.integrity = 'sha512-' + Buffer.alloc(64).toString('base64'); },
  ]) {
    const candidate = structuredClone(contract); mutate(candidate.archives[0]);
    assert.throws(() => verifyD11RegistrationContract(candidate, { lock }));
  }
});

test('D11 registration contract rejects a replacement archive even with recomputed outer identities', async () => {
  const { contract, lock } = await contractFixture(), candidate = structuredClone(contract), changedLock = structuredClone(lock);
  const item = candidate.archives[0], bytes = archive([{ name: candidate.members.find(row => row.archivePath === item.path).memberPath, text: 'replacement' }]);
  Object.assign(item, { data: bytes.toString('base64'), rawBytes: bytes.length, sha256: digest(bytes), integrity: integrity(bytes) });
  changedLock.packages['node_modules/' + item.package].integrity = item.integrity;
  assert.throws(() => verifyD11RegistrationContract(candidate, { lock: changedLock }));
});

test('D11 registration contract rejects member text, identity, or mapping changes', async () => {
  const { contract, lock } = await contractFixture();
  for (const mutate of [
    item => { item.text += '\n'; },
    item => { item.text += '\n'; item.rawBytes = Buffer.byteLength(item.text); item.sha256 = digest(item.text); },
    item => { item.rawBytes += 1; },
    item => { item.sha256 = 'sha256:' + '0'.repeat(64); },
    item => { item.package = '@en-reve/unreviewed'; },
    item => { item.archivePath = 'vendor/unreviewed.tgz'; },
    item => { item.memberPath = 'package/unreviewed.js'; },
    item => { item.installedPath = 'node_modules/@en-reve/unreviewed.js'; },
  ]) {
    const candidate = structuredClone(contract); mutate(candidate.members[0]);
    assert.throws(() => verifyD11RegistrationContract(candidate, { lock }));
  }
});

test('D11 registration contract rejects changed package metadata even after resealing', async () => {
  const { contract, lock } = await contractFixture();
  for (const reseal of [false, true]) {
    const candidate = structuredClone(contract), item = candidate.packagesMetadata, metadata = JSON.parse(item.text);
    metadata.packages.find(row => row.name === candidate.archives[0].package).sha256 = '0'.repeat(64);
    item.text = JSON.stringify(metadata);
    if (reseal) { item.rawBytes = Buffer.byteLength(item.text); item.sha256 = digest(item.text); }
    assert.throws(() => verifyD11RegistrationContract(candidate, { lock }));
  }
});

test('D11 registration contract rejects missing, duplicate, additional, or changed contract identities', async () => {
  const { contract, lock } = await contractFixture();
  for (const mutate of [
    value => { value.kind = 'perf-d11-registration-contract-2'; },
    value => { value.sourceIdentity = null; },
    value => { value.archives.pop(); },
    value => { value.archives.push(structuredClone(value.archives[0])); },
    value => { value.members.pop(); },
    value => { value.members.push(structuredClone(value.members[0])); },
    value => { value.packagesMetadata.path = 'vendor/unreviewed.json'; },
  ]) {
    const candidate = structuredClone(contract); mutate(candidate);
    assert.throws(() => verifyD11RegistrationContract(candidate, { lock }));
  }
});

test('D11 registration contract rejects a lock that no longer binds the reviewed archives', async () => {
  const { contract, lock } = await contractFixture(), packagePath = 'node_modules/' + contract.archives[0].package;
  for (const mutate of [
    value => { delete value.packages[packagePath]; },
    value => { value.packages[packagePath].integrity = 'sha512-' + Buffer.alloc(64).toString('base64'); },
    value => { value.packages[packagePath].resolved = 'file:vendor/unreviewed.tgz'; },
    value => { value.packages[packagePath].version = '0.0.0-unreviewed'; },
    value => { value.packages[packagePath].link = true; },
    value => { value.packages['node_modules/other/' + packagePath] = structuredClone(value.packages[packagePath]); },
    value => { value.packages[''].dependencies[contract.archives[0].package] = 'file:vendor/unreviewed.tgz'; },
  ]) {
    const candidate = structuredClone(lock); mutate(candidate);
    assert.throws(() => verifyD11RegistrationContract(contract, { lock: candidate }));
  }
});

test('D11 registration preparation rejects changed installed members and archive bytes', async () => {
  const { contract } = await contractFixture();
  for (const changedPath of [contract.members[0].installedPath, contract.archives[0].path]) {
    const read = async path => {
      const bytes = await readFile(join(repo, path));
      return { bytes: path === changedPath ? Buffer.concat([bytes, Buffer.from('\n')]) : bytes };
    };
    await assert.rejects(prepareD11RegistrationContract({ repo, read }), /installed registration member differs|archive differs before preparation/);
  }
});
