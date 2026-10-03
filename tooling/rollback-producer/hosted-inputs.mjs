// Admission and path rebinding only. This module never builds, fetches or issues
// an executable authority. The controller owns monitoring and bounded execution.
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, realpath, readdir, open, mkdir} from 'node:fs/promises';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const INPUT_PIN = Object.freeze({byteLength: '12726', hash: 'sha256:5b71db1fd6c60980c8297b9fe48922a75c0a4dcaac6f73d6c4c0925a3e921e45'});
const SEALS = Object.freeze({
  16: 'b074c7a19c6167a44b4dac1b370a6411dedaf3c9406538313838df919625dc3a',
  17: '403083498d96297da60fc33fe17835df00abe286c3e26a981ce5e01f14dd8e3f',
  18: '4b61813dc558928169c36c1883268ac8e55dc3e2b9867b33c22cf1981f27a3e9',
});
const VERSIONS = Object.freeze([16, 17, 18]);
const ADMISSIONS = new WeakMap();
const assert = (value, message) => {if (!value) throw Error(message);};
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const freeze = value => {if (value && typeof value === 'object') {for (const child of Object.values(value)) freeze(child); Object.freeze(value);} return value;};
const stamp = value => ['dev','ino','mode','nlink','uid','gid','size','mtimeNs','ctimeNs'].map(key => String(value[key])).join(':');
const abort = signal => signal?.throwIfAborted();
const canonical = path => typeof path === 'string' && isAbsolute(path) && resolve(path) === path && !/[\x00-\x1f\x7f]/.test(path);
const under = (root, path) => {const member = relative(root, path); return member && !isAbsolute(member) && member !== '..' && !member.startsWith('..' + sep);};
const safe = path => typeof path === 'string' && path.length > 0 && path.length <= 500 && !isAbsolute(path) && !/[\\\x00-\x1f\x7f]/.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..');

export function validateHostedManifest(value) {
  assert(exact(value, ['kind','status','files','fileCount','totalBytes','sourceArchiveBytesUnchanged','producerAuthorityIssued']), 'Unexpected source manifest fields');
  assert(value.kind === 'linux-executable-prerequisite-source-inputs-1' && value.status === 'source-inputs-only-no-executable-authority' && value.sourceArchiveBytesUnchanged === true && value.producerAuthorityIssued === false, 'Source inputs cannot issue authority');
  assert(Array.isArray(value.files) && value.files.length > 0 && value.files.length <= 128 && value.fileCount === value.files.length, 'Invalid source member count');
  const names = new Set(); let total = 0;
  for (const row of value.files) {
    assert(exact(row, ['path','bytes','sha256']) && safe(row.path) && /^(producers\/schema(?:16|17|18)\/|origins\/schema(?:16|17|18)\/|provenance\/source-phase\/)/.test(row.path), 'Invalid source member path or fields');
    assert(!names.has(row.path) && Number.isSafeInteger(row.bytes) && row.bytes > 0 && row.bytes < 100 * 1024 ** 2 && /^[a-f0-9]{64}$/.test(row.sha256), 'Duplicate, oversized or invalid source member');
    names.add(row.path); total += row.bytes;
  }
  assert(Number.isSafeInteger(total) && total <= 256 * 1024 ** 2 && total === value.totalBytes, 'Invalid aggregate input bytes');
  for (const name of names) for (const other of names) assert(name === other || !other.startsWith(name + '/'), 'File/directory membership conflict');
  return freeze(structuredClone(value));
}

async function directory(path, privateMode = false) {
  assert(canonical(path), 'Canonical absolute directory required');
  const value = await lstat(path, {bigint: true});
  assert(value.isDirectory() && !value.isSymbolicLink() && await realpath(path) === path, 'Directory alias or type refused');
  if (privateMode) assert(value.uid === BigInt(process.getuid()) && (value.mode & 0o077n) === 0n, 'Input/output directory must be private and owned');
  return value;
}

async function ancestors(path) {
  for (let parent = dirname(path);; parent = dirname(parent)) {await directory(parent); if (dirname(parent) === parent) break;}
}

async function held(path, expected, {privateMode = false, collect = false, signal} = {}) {
  assert(canonical(path), 'Canonical absolute file required'); await ancestors(path); abort(signal);
  const before = await lstat(path, {bigint: true});
  assert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size === BigInt(expected.byteLength), 'Input file shape or length differs');
  if (privateMode) assert(before.uid === BigInt(process.getuid()) && (before.mode & 0o077n) === 0n, 'Input file must be private and owned');
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const digest = createHash('sha256'), chunks = [], block = Buffer.alloc(1024 * 1024); let count = 0;
  try {
    assert(stamp(before) === stamp(await fd.stat({bigint: true})), 'Input changed before opening');
    for (;;) {
      abort(signal); const {bytesRead} = await fd.read(block, 0, block.length, null); if (!bytesRead) break;
      count += bytesRead; assert(count <= Number(before.size), 'Input grew'); digest.update(block.subarray(0, bytesRead));
      if (collect) {assert(count <= 4 * 1024 ** 2, 'Metadata byte bound'); chunks.push(Buffer.from(block.subarray(0, bytesRead)));}
    }
    assert(stamp(before) === stamp(await fd.stat({bigint: true})) && stamp(before) === stamp(await lstat(path, {bigint: true})), 'Input changed while reading');
  } finally {await fd.close();}
  assert(count === Number(before.size) && 'sha256:' + digest.digest('hex') === expected.hash, 'Input content differs');
  return {ref: freeze({path, hash: expected.hash, byteLength: String(count)}), bytes: collect ? Buffer.concat(chunks) : null, stamp: stamp(before)};
}

async function exactMembers(root, expected, privateMode) {
  await directory(root, privateMode); const files = [], dirs = new Set();
  for (const name of expected) for (let parent = dirname(name); parent !== '.'; parent = dirname(parent)) dirs.add(parent);
  async function walk(path, prefix = '') {
    const names = await readdir(path); assert(names.length <= 128, 'Directory member bound');
    for (const name of names) {
      const member = prefix ? prefix + '/' + name : name, absolute = join(path, name), value = await lstat(absolute, {bigint: true});
      assert(!value.isSymbolicLink(), 'Input aliases refused');
      if (value.isDirectory()) {assert(dirs.has(member), 'Unexpected input directory'); await directory(absolute, privateMode); await walk(absolute, member);}
      else {assert(value.isFile() && value.nlink === 1n, 'Input special or linked file refused'); files.push(member);}
      assert(files.length <= 128, 'Input member bound');
    }
  }
  await walk(root); assert(files.sort().join('\n') === [...expected].sort().join('\n'), 'Input membership differs');
}

async function producer(version, signal) {
  const root = join(HERE, 'schema' + version), path = join(root, 'producer-seal.json');
  const size = String((await lstat(path)).size);
  assert(Number(size) > 0 && Number(size) <= 1048576, 'Producer seal byte bound');
  const seal = await held(path, {hash: 'sha256:' + SEALS[version], byteLength: size}, {collect: true, signal});
  const data = JSON.parse(seal.bytes);
  assert(exact(data, ['kind','storageVersion','status','files']) && data.kind === 'linux-rollback-producer-source-seal-1' && data.storageVersion === version && data.status === 'source-only-unexecuted', 'Producer seal family differs');
  assert(data.files && Object.keys(data.files).length > 0 && Object.keys(data.files).length <= 32, 'Producer closure bound');
  await exactMembers(root, [...Object.keys(data.files), 'producer-seal.json'], false);
  for (const [name, ref] of Object.entries(data.files)) {
    assert(safe(name) && exact(ref, ['hash','byteLength']) && /^sha256:[a-f0-9]{64}$/.test(ref.hash) && /^(0|[1-9][0-9]*)$/.test(ref.byteLength) && Number(ref.byteLength) <= 2 * 1024 ** 2, 'Producer member reference differs');
    await held(join(root, name), ref, {signal});
  }
  assert(data.files['run.py'], 'Missing sealed launcher');
  return freeze({launcher: {path: join(root, 'run.py'), ...data.files['run.py']}, seal: seal.ref});
}

export async function getHostedInputContract({signal} = {}) {
  const input = await held(join(HERE, 'hosted-inputs.json'), INPUT_PIN, {collect: true, signal});
  const manifest = validateHostedManifest(JSON.parse(input.bytes));
  const producers = [];
  for (const storageVersion of VERSIONS) producers.push({storageVersion, producer: await producer(storageVersion, signal)});
  return freeze({manifest: INPUT_PIN, files: manifest.files, fileCount: manifest.fileCount, totalBytes: manifest.totalBytes, producers});
}

export async function admitHostedInputs({inputRoot, manifestPath = join(inputRoot, 'INPUTS.json'), signal}) {
  assert(manifestPath === join(inputRoot, 'INPUTS.json'), 'Manifest must be the fixed input-root member');
  const contract = await getHostedInputContract({signal});
  const manifest = await held(manifestPath, INPUT_PIN, {privateMode: true, collect: true, signal});
  validateHostedManifest(JSON.parse(manifest.bytes));
  const expected = ['INPUTS.json', ...contract.files.map(row => row.path)];
  await exactMembers(inputRoot, expected, true);
  const observed = [manifest];
  for (const row of contract.files) observed.push(await held(join(inputRoot, row.path), {hash: 'sha256:' + row.sha256, byteLength: String(row.bytes)}, {privateMode: true, signal}));
  await exactMembers(inputRoot, expected, true);
  for (const item of observed) {abort(signal); assert(stamp(await lstat(item.ref.path, {bigint: true})) === item.stamp, 'Input changed during complete admission');}
  await getHostedInputContract({signal});
  const token = freeze({kind: 'hosted-source-input-admission-1', inputRoot, manifest: manifest.ref, files: contract.fileCount, bytes: contract.totalBytes, qualification: false});
  ADMISSIONS.set(token, {inputRoot, manifestPath, contract}); return token;
}

export async function recheckHostedInputs(admission, {signal} = {}) {
  const state = ADMISSIONS.get(admission); assert(state, 'Live input admission required');
  return admitHostedInputs({...state, signal});
}

// Pure structural operation; production calls it only for a freshly authenticated
// original wrapper. It never rewrites the archive, original manifest or lineage.
export function rebindSourceWrapper(original, version, references) {
  const fields = ['kind','storageVersion','originArchive','originManifest','sourceBytesModesIdentity','lineage'];
  if (version === 16) fields.push('compatibilityContract','historicalBase','maintenancePatchHash');
  if (version === 18) fields.push('capabilityHash');
  assert(VERSIONS.includes(version) && exact(original, fields) && original.kind === 'linux-rollback-source-input-1' && original.storageVersion === version, 'Source wrapper family differs');
  assert(exact(references, ['originArchive','originManifest','lineage']), 'Unexpected rebind fields');
  const result = structuredClone(original);
  for (const name of ['originArchive','originManifest','lineage']) {
    const a = original[name], b = references[name];
    assert(exact(a, ['path','hash','byteLength']) && exact(b, ['path','hash','byteLength']) && canonical(a.path) && canonical(b.path) && /^sha256:[a-f0-9]{64}$/.test(a.hash) && /^(0|[1-9][0-9]*)$/.test(a.byteLength), 'Invalid source reference');
    assert(a.hash === b.hash && a.byteLength === b.byteLength, 'Rebinding cannot change content identity'); result[name] = structuredClone(b);
  }
  return freeze(result);
}

async function exclusive(path, bytes) {
  await ancestors(path); const fd = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {await fd.writeFile(bytes); await fd.sync();} finally {await fd.close();}
  return freeze({path, hash: hash(bytes), byteLength: String(Buffer.byteLength(bytes))});
}

async function wrappers(state, signal) {
  const sources = [];
  for (const version of VERSIONS) {
    const prefix = 'origins/schema' + version + '/', row = state.contract.files.find(item => item.path === prefix + 'source-input.original.json');
    assert(row, 'Missing original source wrapper');
    const original = await held(join(state.inputRoot, row.path), {hash: 'sha256:' + row.sha256, byteLength: String(row.bytes)}, {privateMode: true, collect: true, signal});
    const refs = {};
    for (const [key, name] of [['originArchive','source.tar.gz'],['originManifest','source-manifest.json'],['lineage','lineage.json']]) {
      const item = state.contract.files.find(entry => entry.path === prefix + name); assert(item, 'Incomplete source closure');
      refs[key] = {path: join(state.inputRoot, item.path), hash: 'sha256:' + item.sha256, byteLength: String(item.bytes)};
    }
    sources.push({storageVersion: version, original: original.ref, value: rebindSourceWrapper(JSON.parse(original.bytes), version, refs), producer: state.contract.producers.find(item => item.storageVersion === version).producer});
  }
  return sources;
}

export async function prepareHostedSourceInputs({admission, outputRoot, signal}) {
  const state = ADMISSIONS.get(admission); assert(state, 'Live input admission required');
  assert(canonical(outputRoot) && outputRoot !== state.inputRoot && !under(state.inputRoot, outputRoot) && !under(outputRoot, state.inputRoot), 'Prepared output overlaps inputs');
  await directory(dirname(outputRoot), true); await ancestors(outputRoot); await recheckHostedInputs(admission, {signal});
  await mkdir(outputRoot, {mode: 0o700}); const sources = [];
  for (const item of await wrappers(state, signal)) {
    abort(signal); const root = join(outputRoot, 'schema' + item.storageVersion); await mkdir(root, {mode: 0o700});
    sources.push({storageVersion: item.storageVersion, original: item.original, sourceInput: await exclusive(join(root, 'source-input.json'), json(item.value)), producer: item.producer});
  }
  await recheckHostedInputs(admission, {signal});
  const value = {kind: 'hosted-source-input-preparation-1', inputRoot: state.inputRoot, manifest: admission.manifest, sources, qualification: false};
  const receipt = await exclusive(join(outputRoot, 'prepared.json'), json(value));
  return freeze({receipt, sources, qualification: false});
}

export async function recheckHostedPreparation({receiptPath, receiptSha256, signal}) {
  assert(/^[a-f0-9]{64}$/.test(receiptSha256), 'Explicit preparation receipt SHA-256 required');
  const size = (await lstat(receiptPath)).size; assert(size > 0 && size <= 65536, 'Preparation receipt byte bound');
  const record = await held(receiptPath, {hash: 'sha256:' + receiptSha256, byteLength: String(size)}, {privateMode: true, collect: true, signal});
  const value = JSON.parse(record.bytes);
  assert(exact(value, ['kind','inputRoot','manifest','sources','qualification']) && value.kind === 'hosted-source-input-preparation-1' && value.qualification === false, 'Unsupported preparation receipt');
  assert(canonical(value.inputRoot) && exact(value.manifest, ['path','hash','byteLength']) && value.manifest.path === join(value.inputRoot, 'INPUTS.json') && value.manifest.hash === INPUT_PIN.hash && value.manifest.byteLength === INPUT_PIN.byteLength, 'Preparation manifest differs');
  assert(receiptPath === join(dirname(receiptPath), 'prepared.json') && !under(value.inputRoot, receiptPath), 'Preparation receipt location differs');
  const admission = await admitHostedInputs({inputRoot: value.inputRoot, manifestPath: value.manifest.path, signal}), state = ADMISSIONS.get(admission);
  const expected = await wrappers(state, signal), paths = ['prepared.json'];
  assert(Array.isArray(value.sources) && value.sources.length === 3, 'Preparation family count differs');
  for (let index = 0; index < expected.length; index++) {
    const item = expected[index], row = value.sources[index], member = 'schema' + item.storageVersion + '/source-input.json', path = join(dirname(receiptPath), member);
    const identity = {path, hash: hash(json(item.value)), byteLength: String(Buffer.byteLength(json(item.value)))};
    assert(exact(row, ['storageVersion','original','sourceInput','producer']) && row.storageVersion === item.storageVersion && json(row.original) === json(item.original) && json(row.sourceInput) === json(identity) && json(row.producer) === json(item.producer), 'Prepared source or active producer changed');
    await held(path, identity, {privateMode: true, signal}); paths.push(member);
  }
  await exactMembers(dirname(receiptPath), paths, true);
  return freeze({receipt: record.ref, sources: value.sources, qualification: false});
}

export function validateHostedCliIdentity(identity) {
  assert(exact(identity, ['uid','gid','euid','egid']) && Object.values(identity).every(value => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff) && identity.uid === identity.euid && identity.gid === identity.egid,
    'Hosted input CLI requires matching nonzero real/effective UID and GID');
  return freeze({...identity});
}

export async function hostedInputsMain(args) {
  const mode = args[0], names = mode === 'prepare' ? ['--input-root','--manifest','--output'] : mode === 'recheck' ? ['--receipt','--receipt-sha256'] : [];
  assert(names.length && args.length === 1 + names.length * 2 && names.every((name, index) => args[1 + index * 2] === name), 'Use fixed prepare or recheck arguments');
  validateHostedCliIdentity({uid: process.getuid?.(), gid: process.getgid?.(), euid: process.geteuid?.(), egid: process.getegid?.()});
  if (mode === 'prepare') {
    const admission = await admitHostedInputs({inputRoot: args[2], manifestPath: args[4]});
    return prepareHostedSourceInputs({admission, outputRoot: args[6]});
  }
  return recheckHostedPreparation({receiptPath: args[2], receiptSha256: args[4]});
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  assert(process.versions.node === '26.10.0', 'Use pinned Node26.10.0');
  hostedInputsMain(process.argv.slice(2)).then(result => {const output = JSON.stringify(result) + '\n'; assert(Buffer.byteLength(output) <= 32768, 'CLI result byte bound'); process.stdout.write(output);}, error => {process.stderr.write(String(error.message).slice(0, 1024) + '\n'); process.exitCode = 1;});
}
