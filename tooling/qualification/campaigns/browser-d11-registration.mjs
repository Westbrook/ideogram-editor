import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { isAbsolute, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const SOURCE = '37341d7a644cdfb37e6ba06d5c051e560306417d61a80705558bd78bd0c02cc4';
const DIRECTORY = 'vendor/en-reve/' + SOURCE;
const MAX_ARCHIVE = 2 * 1024 * 1024, MAX_EXPANDED = 16 * 1024 * 1024, MAX_MEMBERS = 4096;
const MAX_METADATA = 128 * 1024, MAX_LOCK = 16 * 1024 * 1024, MAX_MEMBER = 64 * 1024;
const HASH = /^sha256:[a-f0-9]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const integrity = bytes => 'sha512-' + createHash('sha512').update(bytes).digest('base64');
const equal = (actual, expected, label) => { if (!isDeepStrictEqual(actual, expected)) throw Error('D11 registration ' + label + ' differs'); };
const decoder = new TextDecoder('utf-8', { fatal: true });

// Reviewed public implementation, not a class-name exemption. The two exact
// forwarding implementations are checked inside their lock-bound npm archives.
const PACKAGES = Object.freeze([
  Object.freeze({ package: '@en-reve/elements', version: '0.1.0', filename: 'en-reve-elements-0.1.0.tgz', archiveBytes: 1246938,
    archiveSha256: 'sha256:01baeb4da2f42cf7ae14e2e0bf91b5199c7a10c23a8f899b289fed57827db11b',
    memberPath: 'package/dist/element-scope.js', installedPath: 'node_modules/@en-reve/elements/dist/element-scope.js',
    memberBytes: 9608, memberSha256: 'sha256:bc7510996503e1caf3341542ae1f7d794b778544f0a859ad7a0922b0c969e569' }),
  Object.freeze({ package: '@en-reve/primitives', version: '0.1.0', filename: 'en-reve-primitives-0.1.0.tgz', archiveBytes: 161443,
    archiveSha256: 'sha256:769baf6ac5652966e1a791688291d0ef87596ea1ed270ebe10735f4d51cf65c2',
    memberPath: 'package/dist/interactions/registration.js', installedPath: 'node_modules/@en-reve/primitives/dist/interactions/registration.js',
    memberBytes: 2690, memberSha256: 'sha256:b74dbf86160ae153fe4604bd09fc2c25477c70e0af0806b30b5884aaa7611cb5' }),
]);

export const D11_ROLE_CONTEXT = Object.freeze({ kind: 'd11-role-context-1', viewport: Object.freeze({ width: 1440, height: 900 }), deviceScaleFactor: 2,
  boundary: 'document-ready-via-Open', workloads: Object.freeze(['W0', 'W1']), counting: 'union' });

function pathName(path) {
  if (typeof path !== 'string' || !path || path.length > 4096 || path.startsWith('/') || /^[A-Za-z]:/.test(path) || /[\\\x00-\x20\x7f?#]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) throw Error('D11 registration requires canonical archive/input paths');
  return path;
}
function fields(value, expected, label) {
  if (!object(value)) throw Error('Invalid D11 registration ' + label);
  equal(Object.keys(value).sort(), [...expected].sort(), label + ' fields');
}
function fixedText(bytes) { try { return decoder.decode(bytes); } catch { throw Error('D11 registration input is not UTF-8'); } }
function bytesOf(value, maximum, label) {
  if (!Buffer.isBuffer(value) || value.length > maximum) throw Error('D11 registration ' + label + ' exceeds its byte bound');
  return value;
}
function json(bytes, label) { try { return JSON.parse(fixedText(bytes)); } catch { throw Error('Invalid D11 registration ' + label + ' JSON'); } }
function identity(path, bytes) { return { path, rawBytes: bytes.length, sha256: sha(bytes) }; }

function tarString(bytes, label) {
  const nul = bytes.indexOf(0), end = nul < 0 ? bytes.length : nul;
  if (nul >= 0 && bytes.subarray(nul).some(byte => byte !== 0)) throw Error('D11 archive has malformed ' + label);
  return fixedText(bytes.subarray(0, end));
}
function octal(bytes, label) {
  // Reject GNU base-256 extensions and overflow rather than guessing values.
  if (bytes.some(byte => byte !== 0 && byte !== 32 && (byte < 48 || byte > 55))) throw Error('D11 archive has invalid ' + label);
  const text = bytes.toString('ascii').replace(/\0/g, ' ').trim();
  if (!/^[0-7]+$/.test(text)) throw Error('D11 archive has invalid ' + label);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw Error('D11 archive has oversized ' + label);
  return value;
}

/** Decode one ordinary member without extracting or executing any file. Every
 * header is validated, including unselected members; metadata/link extensions
 * are intentionally unsupported for this exact reviewed npm package profile. */
export function readD11RegistrationArchiveMember(archiveBytes, memberPath) {
  bytesOf(archiveBytes, MAX_ARCHIVE, 'archive'); pathName(memberPath);
  if (!memberPath.startsWith('package/')) throw Error('D11 selected archive member must be inside package/');
  let tar;
  try { tar = gunzipSync(archiveBytes, { maxOutputLength: MAX_EXPANDED }); }
  catch { throw Error('D11 registration gzip is invalid or exceeds the expanded byte bound'); }
  if (tar.length < 1024 || tar.length % 512 !== 0) throw Error('D11 registration tar is truncated or unaligned');
  let offset = 0, entryCount = 0, selected; const names = new Set();
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (offset + 1024 > tar.length || tar.subarray(offset).some(byte => byte !== 0)) throw Error('D11 archive has incomplete terminators or nonzero trailing data');
      if (!selected) throw Error('D11 selected registration member is absent');
      return { bytes: Buffer.from(selected), entryCount };
    }
    if (++entryCount > MAX_MEMBERS) throw Error('D11 registration tar exceeds its member bound');
    let checksum = 0;
    for (let index = 0; index < 512; index++) checksum += index >= 148 && index < 156 ? 32 : header[index];
    if (checksum !== octal(header.subarray(148, 156), 'checksum')) throw Error('D11 archive checksum mismatch');
    if (header[156] !== 0 && header[156] !== 48) throw Error('D11 archive contains a link or special member');
    if (tarString(header.subarray(157, 257), 'link name') !== '') throw Error('D11 regular archive member carries a link target');
    const magic = header.subarray(257, 263);
    if (!magic.equals(Buffer.from('ustar\0')) && !magic.equals(Buffer.from('ustar ')) && !magic.every(byte => byte === 0)) throw Error('D11 archive has unsupported header magic');
    const name = tarString(header.subarray(0, 100), 'name'), prefix = tarString(header.subarray(345, 500), 'prefix');
    const path = pathName(prefix ? prefix + '/' + name : name);
    if (!path.startsWith('package/') || names.has(path)) throw Error('D11 archive has an escaped or duplicate member');
    names.add(path);
    const size = octal(header.subarray(124, 136), 'size'), end = offset + 512 + size;
    if (size > MAX_EXPANDED || !Number.isSafeInteger(end) || end > tar.length) throw Error('D11 archive member is truncated or oversized');
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    if (next > tar.length || tar.subarray(end, next).some(byte => byte !== 0)) throw Error('D11 archive has malformed member padding');
    if (path === memberPath) {
      if (size > MAX_MEMBER) throw Error('D11 selected registration member exceeds its byte bound');
      selected = tar.subarray(offset + 512, end);
    }
    offset = next;
  }
  throw Error('D11 registration tar has no complete terminators');
}

function bindLock(lock) {
  if (!object(lock) || lock.lockfileVersion !== 3 || !object(lock.packages)) throw Error('D11 registration requires the retained npm lock');
  for (const item of PACKAGES) {
    const key = 'node_modules/' + item.package, entry = lock.packages[key], path = DIRECTORY + '/' + item.filename;
    const matches = Object.keys(lock.packages).filter(path => path === key || path.endsWith('/' + key));
    if (matches.length !== 1 || !object(entry) || entry.version !== item.version || entry.resolved !== 'file:' + path || entry.link === true || typeof entry.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity)) throw Error('D11 registration package differs from the reviewed lock profile');
    if (lock.packages['']?.dependencies?.[item.package] !== 'file:' + path) throw Error('D11 registration root dependency differs from its archive identity');
  }
}

/** Revalidate the retained contract on every replay. Returned effects describe
 * the exact native forwarding boundary; they never exempt an arbitrary class,
 * assert registration is inert, or assert all class methods are deferred. */
export function verifyD11RegistrationContract(contract, { lock } = {}) {
  fields(contract, ['kind', 'sourceIdentity', 'packagesMetadata', 'archives', 'members'], 'contract');
  if (contract.kind !== 'perf-d11-registration-contract-1' || contract.sourceIdentity !== SOURCE) throw Error('D11 registration source profile is unsupported');
  bindLock(lock);
  const metadata = contract.packagesMetadata;
  fields(metadata, ['path', 'rawBytes', 'sha256', 'text'], 'packages metadata');
  if (metadata.path !== DIRECTORY + '/packages.json' || typeof metadata.text !== 'string' || !HASH.test(metadata.sha256 ?? '')) throw Error('Invalid D11 registration packages metadata');
  const metadataBytes = bytesOf(Buffer.from(metadata.text), MAX_METADATA, 'packages metadata');
  equal(identity(metadata.path, metadataBytes), { path: metadata.path, rawBytes: metadata.rawBytes, sha256: metadata.sha256 }, 'packages metadata identity');
  const packages = json(metadataBytes, 'packages metadata');
  if (packages.schema !== 1 || packages.sourceIdentity !== SOURCE || !Array.isArray(packages.packages) || packages.packages.length !== 4 || new Set(packages.packages.map(item => item?.name)).size !== 4) throw Error('D11 registration packages metadata is not the reviewed snapshot');
  if (!Array.isArray(contract.archives) || contract.archives.length !== PACKAGES.length || !Array.isArray(contract.members) || contract.members.length !== PACKAGES.length) throw Error('D11 registration requires the two exact archive/member pairs');
  const inputs = [identity(metadata.path, metadataBytes)];
  for (const [index, item] of PACKAGES.entries()) {
    const archive = contract.archives[index], member = contract.members[index], path = DIRECTORY + '/' + item.filename, packed = packages.packages.find(entry => entry?.name === item.package), locked = lock.packages['node_modules/' + item.package];
    fields(archive, ['package', 'path', 'rawBytes', 'sha256', 'integrity', 'encoding', 'data'], 'archive');
    fields(member, ['package', 'archivePath', 'memberPath', 'installedPath', 'rawBytes', 'sha256', 'text'], 'member');
    if (archive.package !== item.package || archive.path !== path || archive.encoding !== 'base64' || typeof archive.data !== 'string' || archive.data.length > Math.ceil(MAX_ARCHIVE / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(archive.data)) throw Error('Invalid D11 registration retained archive encoding/path');
    const bytes = bytesOf(Buffer.from(archive.data, 'base64'), MAX_ARCHIVE, 'archive');
    if (bytes.toString('base64') !== archive.data || bytes.length !== item.archiveBytes || sha(bytes) !== item.archiveSha256) throw Error('D11 registration archive differs from the reviewed bytes');
    equal({ rawBytes: archive.rawBytes, sha256: archive.sha256, integrity: archive.integrity }, { rawBytes: bytes.length, sha256: sha(bytes), integrity: integrity(bytes) }, 'archive identity');
    if (archive.integrity !== locked.integrity || !object(packed) || packed.version !== item.version || packed.filename !== item.filename || packed.bytes !== bytes.length || 'sha256:' + packed.sha256 !== archive.sha256 || packed.integrity !== archive.integrity) throw Error('D11 registration archive differs from package metadata or lock integrity');
    const selected = readD11RegistrationArchiveMember(bytes, item.memberPath).bytes;
    if (selected.length !== item.memberBytes || sha(selected) !== item.memberSha256) throw Error('D11 registration public member differs from the reviewed implementation');
    equal(member, { package: item.package, archivePath: path, memberPath: item.memberPath, installedPath: item.installedPath, rawBytes: selected.length, sha256: sha(selected), text: fixedText(selected) }, 'public member provenance');
    inputs.push(identity(path, bytes));
  }
  return {
    kind: 'verified-d11-registration-contract-1', sourceIdentity: SOURCE, inputs,
    publicExports: { scope: { module: '@en-reve/elements/element-scope.js', export: 'createElementScope' }, registration: { module: '@en-reve/primitives/interactions/registration.js', export: 'registerDefinitions' } },
    nativeEffects: { register: 'synchronous dependency-first registry.define; may read static metadata and upgrade existing candidates', createElement: 'native document.createElement with the owned scoped/global registry; invokes construction and instance initializers', append: 'native DOM connection boundary; connected lifecycle may run', updateComplete: 'not proved by this contract; Lit lifecycle semantics require their own proof', deferredMethods: 'no class or callback exemption; prove invocation paths from retained application AST' },
  };
}

/** The caller supplies its canonical bounded/stable reader. No product module,
 * browser API, package script, or retained JavaScript is executed here. */
export async function prepareD11RegistrationContract({ repo, read } = {}) {
  if (!isAbsolute(repo ?? '') || resolve(repo) !== repo || typeof read !== 'function') throw Error('D11 registration preparation requires its canonical repo reader');
  const obtain = async (path, maximum) => bytesOf((await read(path, maximum)).bytes, maximum, path);
  const lock = json(await obtain('package-lock.json', MAX_LOCK), 'lock'); bindLock(lock);
  const metadataPath = DIRECTORY + '/packages.json', metadataBytes = await obtain(metadataPath, MAX_METADATA);
  const contract = { kind: 'perf-d11-registration-contract-1', sourceIdentity: SOURCE, packagesMetadata: { ...identity(metadataPath, metadataBytes), text: fixedText(metadataBytes) }, archives: [], members: [] };
  for (const item of PACKAGES) {
    const path = DIRECTORY + '/' + item.filename, bytes = await obtain(path, MAX_ARCHIVE);
    // Verify archive identities before bounded decompression or member reads.
    if (bytes.length !== item.archiveBytes || sha(bytes) !== item.archiveSha256 || integrity(bytes) !== lock.packages['node_modules/' + item.package].integrity) throw Error('D11 registration archive differs before preparation');
    const selected = readD11RegistrationArchiveMember(bytes, item.memberPath).bytes, installed = await obtain(item.installedPath, MAX_MEMBER);
    if (!selected.equals(installed)) throw Error('D11 installed registration member differs from its archive');
    contract.archives.push({ package: item.package, ...identity(path, bytes), integrity: integrity(bytes), encoding: 'base64', data: bytes.toString('base64') });
    contract.members.push({ package: item.package, archivePath: path, memberPath: item.memberPath, installedPath: item.installedPath, rawBytes: selected.length, sha256: sha(selected), text: fixedText(selected) });
  }
  verifyD11RegistrationContract(contract, { lock });
  return contract;
}
