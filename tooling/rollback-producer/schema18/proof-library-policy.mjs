/** Linux-only native-library boundary for the independently restored proof.
 * The caller seals this module with the proof, and authenticates the host file
 * by its externally supplied digest. Product and Node bytes remain owned by
 * the existing restored runtime-closure/toolchain checks. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, realpath} from 'node:fs/promises';
import {isAbsolute, normalize, sep} from 'node:path';

const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const isHash = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isPath = value => typeof value === 'string' && isAbsolute(value) && value !== '/'
  && !value.includes('\0') && normalize(value) === value;

export async function createLinuxNativeLibraryPolicy({product, executable, linuxHostPath,
  linuxHostSha256, platform = process.platform, arch = process.arch,
  io = {readFile, realpath}}) {
  assert.equal(platform, 'linux', 'This proof requires Linux');
  assert(['x64', 'arm64'].includes(arch), 'Unsupported Linux architecture');
  assert(isPath(product) && isPath(executable) && isPath(linuxHostPath), 'Absolute normalized proof paths are required');
  assert(isHash(linuxHostSha256), 'A sealed Linux host hash is required');
  const hostBytes = await io.readFile(linuxHostPath);
  assert.equal(digest(hostBytes), linuxHostSha256, 'Linux host bytes changed');
  const host = JSON.parse(Buffer.from(hostBytes).toString('utf8'));
  assert(isRecord(host) && host.kind === 'linux-native-host-observation-1' && host.schemaVersion === 1,
    'Invalid Linux host observation');
  assert(isRecord(host.platform) && host.platform.os === 'linux' && host.platform.arch === arch,
    'Linux host platform does not match the proof');
  assert.equal(host.platform.machine, arch === 'x64' ? 'x86_64' : 'aarch64', 'Linux host machine does not match the proof');
  assert(isHash(host.selectionHash), 'Invalid Linux host selection hash');
  assert(Array.isArray(host.systemLibraries) && host.systemLibraries.length <= 256,
    'Linux host library selection exceeds the finite boundary');

  const rootPath = await io.realpath(product), executablePath = await io.realpath(executable);
  assert(isPath(rootPath) && isPath(executablePath), 'Invalid restored runtime canonical path');
  const aliases = new Map(), requestedPaths = new Set();
  async function verify(entry, observedPath) {
    assert.equal(await io.realpath(observedPath), entry.path, 'Linux library canonical path changed: ' + observedPath);
    const bytes = await io.readFile(entry.path);
    assert.equal(String(bytes.length), entry.byteLength, 'Linux library byte length changed: ' + entry.path);
    assert.equal(digest(bytes), entry.sha256, 'Linux library bytes changed: ' + entry.path);
  }
  for (const entry of host.systemLibraries) {
    assert(isRecord(entry) && typeof entry.soname === 'string' && entry.soname.length > 0
      && !/[\/\0]/.test(entry.soname), 'Invalid Linux library soname');
    assert(isPath(entry.requestedPath) && isPath(entry.path), 'Invalid Linux library path');
    assert(isHash(entry.sha256) && typeof entry.byteLength === 'string' && /^[1-9][0-9]*$/.test(entry.byteLength),
      'Invalid Linux library byte identity');
    assert(!requestedPaths.has(entry.requestedPath), 'Duplicate Linux library requested path');
    requestedPaths.add(entry.requestedPath);
    assert.equal(await io.realpath(entry.path), entry.path, 'Linux library path is not canonical: ' + entry.path);
    await verify(entry, entry.requestedPath);
    for (const path of new Set([entry.requestedPath, entry.path])) {
      const previous = aliases.get(path);
      assert(!previous || previous.path === entry.path && previous.sha256 === entry.sha256
        && previous.byteLength === entry.byteLength, 'Conflicting Linux library identities');
      aliases.set(path, entry);
    }
  }

  return {
    hostIdentity: {path: linuxHostPath, sha256: linuxHostSha256, selectionHash: host.selectionHash,
      systemLibraryCount: host.systemLibraries.length},
    async assertLibrary(observedPath) {
      assert(isPath(observedPath), 'Native library path must be absolute and normalized');
      const entry = aliases.get(observedPath);
      if (entry) { await verify(entry, observedPath); return; }
      const actual = await io.realpath(observedPath);
      // Preserve the original exact-executable and restored-product alternatives.
      // All other paths need a literal selected alias as well as exact bytes;
      // canonicalizing first and then looking up would admit unlisted aliases.
      if (actual === executablePath || actual.startsWith(rootPath + sep)) return;
      assert.fail('Native library escaped restored closure and Linux host selection: ' + observedPath);
    },
  };
}
