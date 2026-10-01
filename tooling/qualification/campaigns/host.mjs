import { cpus, platform, arch, release, totalmem, hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readFile, open, unlink, lstat, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { isDeepStrictEqual, promisify } from 'node:util';
import { join } from 'node:path';
import { digest, fileIdentity, readSealedJSON } from './common.mjs';

const exec = promisify(execFile), GiB = 1024 ** 3;
async function command(binary, args) {
  try { const result = await exec(binary, args, { timeout: 5000, maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C' } }); return result.stdout.trim(); }
  catch { return null; }
}
async function read(path) { try { return (await readFile(path, 'utf8')).trim(); } catch { return null; } }

/** Probe facts independently of a supplied qualification declaration. Missing
 * marketing OS, storage, display or occupancy facts never become defaults. */
export async function observeHost() {
  const value = { schemaVersion: 1, platform: platform(), architecture: arch(), kernel: release(), hostnameHash: digest(hostname()), node: process.version, cpuModels: cpus().map(cpu => cpu.model), logicalCPUs: cpus().length, memoryBytes: totalmem(), observedAt: new Date().toISOString() };
  if (value.platform === 'darwin') {
    const [osVersion, osBuild, model, cpu, cores, power] = await Promise.all([
      command('/usr/bin/sw_vers', ['-productVersion']), command('/usr/bin/sw_vers', ['-buildVersion']), command('/usr/sbin/sysctl', ['-n', 'hw.model']), command('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string']), command('/usr/sbin/sysctl', ['-n', 'hw.physicalcpu']), command('/usr/bin/pmset', ['-g', 'custom']),
    ]);
    Object.assign(value, { osVersion, osBuild, machineModel: model, cpuModel: cpu, physicalCPUs: cores === null ? null : Number(cores), powerSettings: power });
  } else if (value.platform === 'linux') {
    const [os, affinity, cpuLayout] = await Promise.all([read('/etc/os-release'), read('/proc/self/status'), command('/usr/bin/lscpu', ['-J', '-e=CPU,CORE,SOCKET,ONLINE,MAXMHZ'])]);
    Object.assign(value, { osRelease: os, affinity: affinity?.match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1] ?? null, cpuLayout: cpuLayout ? JSON.parse(cpuLayout) : null });
  }
  return value;
}

function expandCPUSet(value) {
  if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(value ?? '')) return [];
  const values = [];
  for (const range of value.split(',')) {
    const [a, b = a] = range.split('-').map(Number);
    if (b < a || b - a > 4096) return [];
    for (let i = a; i <= b; i++) values.push(i);
  }
  return [...new Set(values)];
}

/** Attestations cover physical properties not inferable from a VM/process. They
 * must name evidence files whose bytes are retained and hashed in the receipt.
 * An attestation alone cannot override an independently observed mismatch. */
export async function loadHostAttestation(path) {
  if (!path) return null;
  const sealed = await readSealedJSON(path), value = sealed.value;
  if (value.kind !== 'perf-host-attestation-1' || !['C', 'H'].includes(value.profile) || !/^[^\r\n]{1,200}$/.test(value.operator ?? '') || !Array.isArray(value.evidence) || !value.evidence.length || !Number.isFinite(Date.parse(value.observedAt))) throw Error('Invalid host attestation');
  const evidence = [];
  for (const file of value.evidence) {
    if (!file || typeof file.path !== 'string' || typeof file.sha256 !== 'string') throw Error('Invalid host evidence identity');
    const identity = await fileIdentity(file.path);
    if (identity.sha256 !== file.sha256) throw Error('Host evidence changed');
    evidence.push({ ...file, ...identity });
  }
  return { ...value, evidence, identity: sealed.identity, consumedPath: path, consumedBytes: sealed.bytes };
}

export function evaluateHost(observed, required, attestation = null) {
  const profile = required === 'C+N' ? 'C' : required, missing = [], mismatches = [];
  const require = (condition, label) => { if (condition === null || condition === undefined) missing.push(label); else if (!condition) mismatches.push(label); };
  if (!['C', 'H'].includes(profile)) return { eligible: false, profile: required, missing: ['A multi-host job needs independent C and H executions and joined receipts.'], mismatches };
  require(observed.node === 'v26.10.0', 'Node 26.10.0');
  // Installed RAM can have a small firmware reservation; this is not allowance
  // to count an 8/32 GiB machine as the prescribed 16 GiB runner.
  require(observed.memoryBytes >= 15 * GiB && observed.memoryBytes <= 16.25 * GiB, '16 GiB RAM');
  if (profile === 'H') {
    require(observed.platform === 'darwin' && observed.architecture === 'arm64', 'macOS arm64');
    require(observed.osVersion ? /^15\.7(?:\.|$)/.test(observed.osVersion) : null, 'macOS 15.7');
    require(observed.machineModel ? observed.machineModel === 'Macmini9,1' : null, 'Mac mini M1');
    require(observed.cpuModel ? observed.cpuModel === 'Apple M1' : null, 'Apple M1');
    require(observed.physicalCPUs === undefined ? null : observed.physicalCPUs === 8, '8 physical CPU cores');
  } else {
    require(observed.platform === 'linux' && observed.architecture === 'x64', 'Ubuntu x86_64');
    require(observed.osRelease ? /^ID=ubuntu$/m.test(observed.osRelease) && /^VERSION="24\.04\.3 LTS/m.test(observed.osRelease) : null, 'Ubuntu 24.04.3');
    require(observed.cpuModels?.length ? observed.cpuModels.every(model => /\bi7-12700\b/.test(model)) : null, 'Intel Core i7-12700');
    const affinity = expandCPUSet(observed.affinity), rows = observed.cpuLayout?.cpus;
    require(observed.affinity ? affinity.length === 4 : null, 'four pinned logical CPUs');
    if (rows && affinity.length === 4) {
      const pinned = rows.filter(row => affinity.includes(Number(row.cpu))), physical = new Set(pinned.map(row => row.socket + ':' + row.core));
      require(pinned.length === 4 && physical.size === 4, 'four distinct pinned physical cores');
      require(pinned.every(row => Number(row.maxmhz) >= 4500), 'pinned P-cores');
    } else missing.push('CPU affinity physical/P-core evidence');
  }
  if (!attestation || attestation.profile !== profile) missing.push('matching physical host attestation');
  else {
    if (!attestation.exclusive || attestation.competingWork !== false) missing.push('exclusive idle physical runner');
    const start = Date.parse(attestation.observedAt), end = attestation.validUntil === undefined ? start + 24 * 60 * 60 * 1000 : Date.parse(attestation.validUntil), observedTime = Date.parse(observed.observedAt);
    if (!Number.isFinite(end) || end <= start || end - start > 72 * 60 * 60 * 1000 || observedTime < start || observedTime > end) missing.push('host attestation valid for this observation (explicit interval at most 72 hours)');
    if (attestation.hostnameHash !== observed.hostnameHash) mismatches.push('host attestation machine identity');
    if (profile === 'H') {
      require(attestation.gpuCores === 8, '8 GPU cores');
      require(attestation.storage === 'internal-512GB-SSD', 'internal 512 GB SSD');
      require(attestation.acPower === true && attestation.powerMode === 'normal', 'AC/normal power mode');
      require(attestation.refreshHz === 60 && attestation.dpr === 2 && attestation.viewport?.width === 1440 && attestation.viewport?.height === 900, '60 Hz 1440x900 DPR2 display');
      require(attestation.nativeGPU === true && attestation.syntheticThrottle === false, 'native unthrottled GPU');
    } else require(attestation.storage === 'local-NVMe-SSD', 'local NVMe SSD');
  }
  return { eligible: !missing.length && !mismatches.length, profile, networkEvidenceRequired: required === 'C+N', missing, mismatches };
}

export const timingHostIdentity = () => ({ hostnameHash: digest(hostname()) });

/** C/H qualification shares a fixed host directory. Per-run TMPDIR changes
 * isolate workspaces, but must never create an independent timing lock. */
export async function timingLockDirectory() {
  if (!['darwin', 'linux'].includes(platform())) throw Error('Timing qualification requires a supported POSIX host');
  const directory = await realpath('/tmp');
  if (!(await lstat(directory)).isDirectory()) throw Error('Host timing lock directory is unavailable');
  return directory;
}

async function processSnapshot() {
  const { stdout } = await exec('/bin/ps', ['-e', '-o', 'pid=', '-o', 'ppid=', '-o', 'lstart='], { timeout: 5000, maxBuffer: 8 * 1024 * 1024, env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
  const processes = new Map();
  for (const line of stdout.split('\n').filter(line => line.trim())) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) throw Error('Cannot establish timing process ancestry');
    const pid = Number(match[1]), ppid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid) || processes.has(pid)) throw Error('Invalid timing process identity');
    processes.set(pid, { pid, ppid, startedAt: match[3] });
  }
  if (!processes.has(process.pid)) throw Error('Timing process identity is unavailable');
  return processes;
}

function isAncestor(processes, owner) {
  const observed = processes.get(owner.pid);
  if (!observed || observed.startedAt !== owner.processStartedAt) return false;
  const seen = new Set(); let pid = process.pid;
  for (let depth = 0; depth < 128 && pid > 0 && !seen.has(pid); depth++) {
    if (pid === owner.pid) return true;
    seen.add(pid); const entry = processes.get(pid); if (!entry) return false; pid = entry.ppid;
  }
  return false;
}

async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function leaseFor(path, identity) {
  return { kind: 'perf-timing-lease-1', path, host: identity.host, receiptId: identity.receiptId, ownerPid: identity.pid,
    ownerStartedAt: identity.processStartedAt, lockNonce: identity.nonce, identityDigest: digest(identity) };
}
async function readOwnedRecord(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16384 || info.mode & 0o077 || process.getuid && info.uid !== process.getuid()) throw Error('Timing lock must be a private ordinary file');
  const sealed = await readSealedJSON(path);
  return { identity: sealed.value, info };
}
async function writeOwnedRecord(path, identity) {
  const handle = await open(path, 'wx', 0o600);
  const info = await handle.stat();
  try { await handle.writeFile(JSON.stringify(identity) + '\n'); await handle.sync(); }
  catch (error) {
    await handle.close();
    const current = await lstat(path).catch(() => null);
    if (current?.dev === info.dev && current.ino === info.ino) await unlink(path);
    throw error;
  }
  return { handle, info };
}
async function removeOwnedRecord(path, identity, info) {
  const current = await readOwnedRecord(path);
  if (current.info.dev !== info.dev || current.info.ino !== info.ino || !isDeepStrictEqual(current.identity, identity)) throw Error('Timing lock identity changed');
  await unlink(path);
}

/** Runtime and standalone developer campaigns share this one host lock. A
 * descendant may borrow its parent's explicit lease for nested timed work;
 * the separate exclusive borrow slot prevents two siblings using it at once.
 * Existing or stale locks are never stolen by a new runner. */
export async function acquireTimingLock(directory, { host = timingHostIdentity(), receiptId, lease = null } = {}) {
  if (host?.hostnameHash !== timingHostIdentity().hostnameHash || typeof receiptId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(receiptId)) throw Error('Timing lock requires the local host and an explicit receipt identity');
  const root = await realpath(directory), info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Timing lock directory must be canonical');
  const path = join(root, `ideogram-perf-${host.hostnameHash.slice(7, 31)}.lock`), borrowPath = path + '.borrow', closingPath = path + '.closing';
  const processes = await processSnapshot(), self = processes.get(process.pid);
  if (lease !== null) {
    if (await exists(closingPath)) throw Error('Timing owner is releasing its lease');
    const owner = await readOwnedRecord(path), expected = leaseFor(path, owner.identity);
    if (!isDeepStrictEqual(lease, expected) || lease.receiptId !== receiptId || lease.host !== host.hostnameHash || owner.identity.kind !== 'perf-exclusive-runner-lock-1' || !isAncestor(processes, owner.identity)) throw Error('Timing lease does not belong to a live same-host ancestor and receipt');
    const borrowedIdentity = { kind: 'perf-borrowed-runner-lock-1', ownerDigest: expected.identityDigest, host: host.hostnameHash, receiptId,
      pid: process.pid, processStartedAt: self.startedAt, nonce: randomUUID(), createdAt: new Date().toISOString() };
    const borrowed = await writeOwnedRecord(borrowPath, borrowedIdentity);
    try {
      const current = await readOwnedRecord(path);
      if (await exists(closingPath) || current.info.dev !== owner.info.dev || current.info.ino !== owner.info.ino || !isDeepStrictEqual(current.identity, owner.identity) || !isAncestor(await processSnapshot(), owner.identity)) throw Error('Timing owner changed while granting its lease');
    } catch (error) { try { await removeOwnedRecord(borrowPath, borrowedIdentity, borrowed.info); } finally { await borrowed.handle.close(); } throw error; }
    let released = false;
    return { path, identity: owner.identity, lease: expected, borrowed: true, borrowerIdentity: borrowedIdentity,
      async release() {
        if (released) return;
        await removeOwnedRecord(borrowPath, borrowedIdentity, borrowed.info); released = true; await borrowed.handle.close();
      } };
  }
  if (await exists(closingPath) || await exists(borrowPath)) throw Error('An interrupted timing lease requires operator inspection');
  const identity = { kind: 'perf-exclusive-runner-lock-1', pid: process.pid, processStartedAt: self.startedAt, receiptId, host: host.hostnameHash, nonce: randomUUID(), createdAt: new Date().toISOString() };
  const owned = await writeOwnedRecord(path, identity);
  if (await exists(closingPath) || await exists(borrowPath)) {
    try { await removeOwnedRecord(path, identity, owned.info); } finally { await owned.handle.close(); }
    throw Error('A concurrent timing lease is closing');
  }
  let released = false;
  return { path, identity, lease: leaseFor(path, identity), borrowed: false,
    async release() {
      if (released) return;
      const closingIdentity = { kind: 'perf-closing-runner-lock-1', ownerDigest: digest(identity), pid: process.pid, nonce: randomUUID() };
      const closing = await writeOwnedRecord(closingPath, closingIdentity);
      try {
        if (await exists(borrowPath)) {
          const borrowed = await readOwnedRecord(borrowPath), value = borrowed.identity;
          if (value.kind !== 'perf-borrowed-runner-lock-1' || value.ownerDigest !== digest(identity) || value.host !== identity.host || value.receiptId !== identity.receiptId) throw Error('Borrowed timing lease identity changed');
          const live = (await processSnapshot()).get(value.pid);
          if (live?.startedAt === value.processStartedAt) throw Error('Cannot release timing owner while its borrower is active');
          // Only the still-live original owner may clean up its own dead child
          // lease, after the runner has reaped that child's owned processes.
          await removeOwnedRecord(borrowPath, value, borrowed.info);
        }
        await removeOwnedRecord(path, identity, owned.info); released = true; await owned.handle.close();
      } finally {
        try { await removeOwnedRecord(closingPath, closingIdentity, closing.info); } finally { await closing.handle.close(); }
      }
    } };
}
