// Read official package/runtime inputs and measure an isolated writer. No provider
// transport, live root, report, browser session or source archive is touched.
import { readFile, writeFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { arch, release, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWriter } from '../dist/local/server/storage/writer.js';
import { canonical } from '../dist/local/server/storage/canonical.js';

if (process.versions.node !== '26.10.0') throw new Error('Use the pinned toolchain.');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const lock = JSON.parse(await readFile('package-lock.json'));
const sources = [];
for (const name of ['fs-ext', 'nan']) {
  const entry = lock.packages[`node_modules/${name}`];
  const url = `https://registry.npmjs.org/${name}/${entry.version}`;
  const response = await fetch(url); if (!response.ok) throw new Error(`Cannot read ${name} provenance`);
  const metadataBytes = Buffer.from(await response.arrayBuffer()); const metadata = JSON.parse(metadataBytes);
  if (metadata.dist.integrity !== entry.integrity || metadata.dist.tarball !== entry.resolved) throw new Error('Registry/lock mismatch');
  const archiveResponse = await fetch(entry.resolved); if (!archiveResponse.ok) throw new Error('Archive unavailable');
  const archive = Buffer.from(await archiveResponse.arrayBuffer());
  const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
  if (integrity !== entry.integrity) throw new Error('Archive integrity mismatch');
  sources.push({ name, version: entry.version, metadataURL: url, metadataSHA256: sha256(metadataBytes),
    archiveURL: entry.resolved, archiveSHA256: sha256(archive), archiveIntegrity: integrity, gitHead: metadata.gitHead ?? null,
    sourceRepository: metadata.repository, retrievedAt: new Date().toISOString() });
}
const docs = [];
for (const [purpose, url] of [
  ['Node SQLite API stability', 'https://nodejs.org/download/release/v26.10.0/docs/api/sqlite.html'],
  ['SQLite WAL local-filesystem and sync behavior', 'https://www.sqlite.org/wal.html'],
  ['SQLite settings and FULL/fullfsync semantics', 'https://www.sqlite.org/pragma.html'],
  ['SQLite device and power-failure assumptions', 'https://www.sqlite.org/atomiccommit.html'],
  ['Apple flock descriptor lifetime and process death', 'https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/flock.2.html'],
]) {
  const response = await fetch(url); if (!response.ok) throw new Error(`Official source unavailable: ${purpose}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (purpose.startsWith('Node') && !/Stability: 1\.2/.test(bytes.toString())) throw new Error('Node stability evidence changed; review it.');
  docs.push({ purpose, url, sha256: sha256(bytes), bytes: bytes.length, retrievedAt: new Date().toISOString() });
}
const root = await mkdtemp(join(await realpath(tmpdir()), 'ideogram-qualify-writer-'));
let writer,liveDiagnostics,restartedDiagnostics;
try {
  writer = await openWriter({ root });
  const bytes = Buffer.from(canonical({ schemaVersion: 1, entities: [] }));
  const ref = await writer.putObject([bytes], { byteLength: String(bytes.length), mediaType: 'application/json' }, writer.epoch);
  const command = { protocolVersion: 1, command: { schemaVersion: 1, commandId: 'qualification_create', clientId: 'qualification_client',
    sessionId: 'qualification_session', correlationId: 'qualification_correlation', causationId: null, transactionId: 'qualification_transaction',
    documentId: 'qualification_document', expectedDocumentRevision: null, expectedEntityVersions: ref, issuedAt: '2026-09-26T00:00:00.000Z',
    body: { type: 'NewDocument', width: 1200, height: 800, color: 'sRGB', depth: 8 } } };
  const commandBytes = Buffer.from(canonical(command)); const submitStart = performance.now();
  const receipt = await writer.submit(commandBytes, writer.epoch);
  const publicSubmitRoundTripMs = performance.now() - submitStart;
  const eventBytes = (await writer.events()).events.map(event => Buffer.byteLength(canonical(event)));
  liveDiagnostics = await writer.readDiagnostics(); const live = liveDiagnostics.value; await writer.close();
  writer = await openWriter({ root }); restartedDiagnostics = await writer.readDiagnostics(); const restarted = restartedDiagnostics.value;
  if (live.projectionDigest !== restarted.projectionDigest) throw new Error('Reopen mismatch');
  const metadata = JSON.parse(await readFile('.toolchain/npm-12.1.0/package/node_modules/node-gyp/package.json'));
  const result = { recordedAt: new Date().toISOString(), node: process.versions, platform: { platform: platform(), arch: arch(), release: release() },
    nodeArchive: JSON.parse(await readFile('tooling/toolchain.json')).nodeArchives[`${platform()}-${arch()}`],
    nodeBinarySHA256: sha256(await readFile(process.execPath)), nativeBuild: { nodeGyp: metadata.version,
      compiler: execFileSync(platform() === 'darwin' ? '/usr/bin/clang' : 'c++', ['--version'], { encoding: 'utf8' }).trim(),
      addonSHA256: sha256(await readFile('node_modules/fs-ext/build/Release/fs_ext.node')),
      fsExtSourceSHA256: sha256(await readFile('node_modules/fs-ext/fs-ext.cc')),
      fsExtLicenseSHA256: sha256(await readFile('node_modules/fs-ext/LICENSE.txt')) }, sources, docs,
    stability: { nodeSQLite: '1.2 release candidate, not stable 2', qualification: 'This exact runtime only; API upgrades require requalification.' },
    receipt, live, restarted, observations: { publicSubmitRoundTripMs, canonicalCommandBytes: commandBytes.length, canonicalEventBytes: eventBytes,
      scope: 'One command, tiny replay; worker append excludes caller transport. These are observations, not R20-R23 campaign results.' },
    limits: ['Process-kill tests are not power-loss proof.', 'macOS arm64/APFS exercised; isolated HFS+ ENOSPC is separate failure evidence.',
      'Linux and other OS/filesystem/device combinations, Windows ACLs, backup/restore/migration and full PERF campaigns remain unqualified.',
      'Single-command R20/R21 and short-replay R22 observations only; R23 snapshots are deferred with a 500-event admission ceiling.',
      '64MiB metadata headroom is admission accounting, not a physically preallocated emergency reserve.'] };
  await mkdir('artifacts', { recursive: true }); await writeFile('artifacts/store-qualification.json', JSON.stringify(result, null, 2) + '\n');
  console.log('Isolated writer qualification recorded in artifacts/store-qualification.json');
} finally {
  try { await writer?.close(); await rm(root, { recursive: true, force: true }); }
  finally { restartedDiagnostics?.release(); liveDiagnostics?.release(); }
}
