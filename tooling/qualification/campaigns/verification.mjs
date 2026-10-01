import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { digestJSON } from '../core.mjs';
import { isBuildSource } from '../dev.mjs';
import { digest, fileIdentity, readJournal } from './common.mjs';
import { selectFixtureDescriptor } from './fixture-catalog.mjs';
import { byteAuditConfiguration, jobExecutionPath } from './byte-audits.mjs';

const excludedDirectories = new Set(['store', 'root', 'fixtures', 'browser-profile', 'profile']);
const metadata = /\.(?:json|jsonl|log|txt)$/;
const safeCell = value => value.replace(/[^A-Za-z0-9_.-]/g, '_');
const sha = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const equal = (a, b, message) => { if (!isDeepStrictEqual(a, b)) throw Error(message); };
function safeRelative(path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..') || /^[A-Za-z]:/.test(path)) throw Error('Unsafe receipt evidence path');
  return path;
}

/** A startup byte snapshot is useful only at the selected public ready
 * boundary. Failed actions can retain their partial snapshot without claiming
 * that the document was opened or that this boundary was reached. */
export function verifyByteAuditStartupBoundary({ cell, attempt, fixture }) {
  if (attempt?.result?.d11?.scope !== 'startup') return { applicable: false };
  if (cell?.operation !== 'navigation.ready') throw Error('Startup byte audit does not belong to a navigation-ready cell');
  const observation = attempt.result.observations;
  const hasBoundary = observation && (Object.hasOwn(observation, 'startupBoundary') || Object.hasOwn(observation, 'publicOpenCompleted'));
  if (!hasBoundary) {
    if (attempt.status === 'PASS' || attempt.result.status === 'PASS') throw Error('Passing startup byte audit lacks its public ready boundary');
    return { applicable: true, verified: false };
  }
  const documentId = fixture?.documentId ?? null;
  if (documentId !== null && (typeof documentId !== 'string' || !documentId)) throw Error('Startup byte audit fixture document identity is malformed');
  const boundary = documentId === null ? 'shell-ready-no-document' : 'document-ready-via-Open';
  if (observation.documentId !== documentId || observation.startupBoundary !== boundary || observation.publicOpenCompleted !== (documentId !== null)) throw Error('Startup byte audit ready boundary differs from the selected fixture');
  // C's role context accounts for a union of startup scenarios. H records this
  // actual selected visit, including workloads outside that static union.
  return { applicable: true, verified: true, boundary, documentId };
}

/** A serialized N/A proof is shared by every observation in one continuous
 * lifecycle. Its raw reviewed bytes are verified separately below; arbitrary
 * runtime declarations and mixed executable identities cannot authorize N/A. */
export function lifecycleRendererProof(result, rawSamples = []) {
  const observations = [result?.B0?.resources, ...(result?.cycles ?? []).flatMap(cycle => [cycle.resources, cycle.resourceObservation?.resources, ...(cycle.resourceSamples ?? []), ...(cycle.action?.resourceSamples ?? [])]), ...rawSamples];
  const proofs = [result?.sampling?.rendererOwnershipProof, ...observations.map(value => value?.rendererOwnershipProof)].filter(value => value != null);
  if (!proofs.length) return null;
  for (const proof of proofs) equal(proof, proofs[0], 'Lifecycle observations contain mixed renderer ownership proofs');
  return proofs[0];
}

/** Prove completeness from retained identities as well as their self-hashes.
 * Re-sealing an arbitrary subset must not authorize a prepared product copy. */
export function verifyPreparedSourceInventory(identity, supplemental = []) {
  if (identity.preparedSource == null) return;
  const provenance = identity.buildProvenance, manifest = provenance?.sourceManifest;
  const prefixed = value => value?.startsWith('sha256:') ? value : 'sha256:' + value;
  if (!manifest || !Array.isArray(manifest.files) || !manifest.files.length || digest(JSON.stringify(manifest.files, null, 2) + '\n') !== prefixed(manifest.sha256)) throw Error('Prepared source lacks its sealed source manifest');
  const subject = identity.before.files;
  if (provenance.subjectSourceManifest !== undefined) equal(provenance.subjectSourceManifest, subject, 'Prepared source subject manifest differs from retained subject');
  const applicable = path => isBuildSource(path) || path.startsWith('docs/spec/') || path.startsWith('.github/workflows/') || path === 'AGENTS.md';
  const required = subject.filter(file => !file.deleted && applicable(file.path));
  equal(manifest.files.map(file => safeRelative(file.path)).sort(), required.map(file => file.path).sort(), 'Prepared source omits applicable retained subject paths');
  const files = manifest.files.map(file => {
    const expected = required.find(value => value.path === file.path);
    if (file.bytes !== expected.bytes || prefixed(file.sha256) !== prefixed(expected.sha256)) throw Error('Prepared source differs from retained subject bytes');
    return { path: file.path, bytes: file.bytes, sha256: prefixed(file.sha256) };
  });
  for (const item of supplemental) {
    const path = safeRelative(item.path);
    if (files.some(file => file.path === path) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || !sha(prefixed(item.sha256))) throw Error('Invalid retained supplemental source identity');
    files.push({ path, bytes: item.bytes, sha256: prefixed(item.sha256), supplemental: true });
  }
  equal(identity.preparedSource.files, files, 'Prepared source inventory differs from complete retained inputs');
  if (identity.preparedSourceAfter) equal(identity.preparedSourceAfter.files.map(file => [file.path, file.supplemental === true]), files.map(file => [file.path, file.supplemental === true]), 'Prepared source after-inventory changed');
}

async function ordinaryPath(root, path) {
  let current = root;
  const parts = safeRelative(path).split('/');
  for (const [index, part] of parts.entries()) {
    current = join(current, part); const info = await lstat(current);
    if (info.isSymbolicLink() || (index === parts.length - 1 ? !info.isFile() : !info.isDirectory())) throw Error('Evidence path must contain only ordinary directories and files');
  }
  return current;
}

async function metadataInventory(root) {
  const paths = [];
  async function walk(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (entry.isSymbolicLink()) throw Error('Symlink in receipt evidence tree');
      if (entry.isDirectory() && !excludedDirectories.has(entry.name)) await walk(join(directory, entry.name), path + '/');
      else if (entry.isFile() && metadata.test(entry.name) && path !== 'receipt.json') paths.push(path);
    }
  }
  await walk(root); return paths.sort();
}

/** Verify the exact retained packet, without reopening mutable source inputs or
 * treating a claimed summary/eligibility boolean as an authority. The caller
 * owns plan reproduction, host eligibility and metric verdict computation. */
export async function verifySealedEvidence(receipt, output) {
  if (!receipt || !Array.isArray(receipt.evidence) || !Array.isArray(receipt.groups) || !receipt.inputIdentities || !receipt.identity) throw Error('Missing campaign evidence structure');
  if (receipt.byteAuditGroups !== undefined && !Array.isArray(receipt.byteAuditGroups) || receipt.jobExecutions !== undefined && !Array.isArray(receipt.jobExecutions)) throw Error('Malformed byte audit or job execution evidence');
  const root = await realpath(output), records = new Map();
  for (const record of receipt.evidence) {
    const path = safeRelative(record.path);
    if (records.has(path) || path === 'receipt.json' || !Number.isSafeInteger(record.bytes) || record.bytes < 0 || !sha(record.sha256)) throw Error('Invalid or duplicate evidence identity');
    const actual = await fileIdentity(await ordinaryPath(root, path));
    equal(actual, { bytes: record.bytes, sha256: record.sha256 }, `Evidence changed: ${path}`);
    records.set(path, record);
  }
  equal([...records.keys()].sort(), await metadataInventory(root), 'Retained metadata inventory differs from its seal');
  const cache = new Map();
  async function bytes(path) {
    const record = records.get(safeRelative(path));
    if (!record) throw Error(`Required sealed evidence is absent: ${path}`);
    if (cache.has(path)) return cache.get(path);
    if (record.bytes > 256 * 1024 * 1024) throw Error('Structured evidence exceeds the 256 MiB verification bound');
    const handle = await open(await ordinaryPath(root, path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat(), value = await handle.readFile(), after = await handle.stat();
      if (!before.isFile() || before.size !== value.length || before.size !== after.size || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || value.length !== record.bytes || digest(value) !== record.sha256) throw Error(`Evidence changed while reading: ${path}`);
      cache.set(path, value); return value;
    } finally { await handle.close(); }
  }
  const json = async path => JSON.parse((await bytes(path)).toString('utf8'));
  equal(await json('plan.json'), receipt.plan, 'Sealed plan differs from receipt');
  if (digest(receipt.plan) !== receipt.planDigest) throw Error('Plan digest mismatch');
  equal(await json('host.json'), receipt.host, 'Sealed host observations differ from receipt');
  for (const side of ['before', 'after']) {
    const identity = receipt.identity[side];
    if (!Array.isArray(identity?.files) || digestJSON(identity.files) !== identity.digest) throw Error('Subject source manifest digest mismatch');
    equal(await json(`source-${side}.json`), identity, 'Sealed source identity differs from receipt');
  }
  for (const side of ['controlBefore', 'controlAfter']) {
    const identity = receipt.identity[side];
    if (!Array.isArray(identity?.files) || digestJSON(identity.files) !== identity.digest) throw Error('Control source manifest digest mismatch');
  }
  for (const side of ['buildsBefore', 'buildsAfter']) {
    const identity = receipt.identity[side];
    if (!Array.isArray(identity?.files) || digest(identity.files) !== identity.digest) throw Error('Build manifest digest mismatch');
  }
  for (const side of ['preparedSource', 'preparedSourceAfter']) {
    const identity = receipt.identity[side];
    if (identity != null && (!Array.isArray(identity.files) || digest(identity.files) !== identity.digest)) throw Error('Prepared source manifest digest mismatch');
  }
  if (Object.hasOwn(receipt.identity, 'preparedSourceStable')) {
    const before = receipt.identity.preparedSource, after = receipt.identity.preparedSourceAfter;
    if (!before && after) throw Error('Prepared source after-manifest lacks its before-manifest');
    equal(receipt.identity.preparedSourceStable, !before || Boolean(after && before.digest === after.digest), 'Prepared source stability claim differs from its manifests');
  }

  const consumedInputs = {};
  for (const [name, identity] of Object.entries(receipt.inputIdentities)) {
    if (identity === null) { consumedInputs[name] = null; continue; }
    if (!identity || !isAbsolute(identity.path ?? '') || !sha(identity.sha256) || !Number.isSafeInteger(identity.bytes)) throw Error('Invalid consumed input identity');
    const record = records.get(safeRelative(identity.retainedPath));
    if (!record || record.bytes !== identity.bytes || record.sha256 !== identity.sha256) throw Error('Consumed input differs from retained bytes');
    consumedInputs[name] = await json(identity.retainedPath);
  }
  for (const key of ['hostAttestation', 'fixtureManifest', 'configuration', 'buildProvenance']) if (!Object.hasOwn(consumedInputs, key)) throw Error(`Missing consumed input disposition: ${key}`);
  const provenance = receipt.identity.buildProvenance ?? null;
  verifyPreparedSourceInventory(receipt.identity, consumedInputs.testInputPacket?.fixtures ?? []);
  if (provenance === null) {
    // resolveProduct can consume a provenance file before rejecting its source
    // or retained logs. Preserve those sealed failure inputs without treating
    // them as applied provenance for any executed group.
    if (!receipt.runError || receipt.groups.length) equal(consumedInputs.buildProvenance, null, 'Build provenance differs from consumed input');
  }
  else {
    const { retainedLogs, ...original } = provenance;
    equal(consumedInputs.buildProvenance, original, 'Build provenance differs from consumed input');
    if (!Array.isArray(original.commands) || !Array.isArray(retainedLogs)) throw Error('Build provenance lacks retained command logs');
    const logInputs = original.commands.flatMap(command => [command.stdout, command.stderr]);
    if (logInputs.length !== retainedLogs.length) throw Error('Build log inventory differs');
    for (const [index, file] of retainedLogs.entries()) {
      const source = logInputs[index], record = records.get(safeRelative(file.retainedPath));
      const expectedHash = typeof source?.sha256 === 'string' && (source.sha256.startsWith('sha256:') ? source.sha256 : 'sha256:' + source.sha256);
      if (!record || source?.path !== file.path || source?.bytes !== file.bytes || expectedHash !== file.sha256 || record.bytes !== file.bytes || record.sha256 !== file.sha256) throw Error('Build log differs from consumed provenance');
    }
  }
  const attestation = receipt.host.attestation, rawAttestation = consumedInputs.hostAttestation;
  if (rawAttestation === null) equal(attestation, null, 'Host attestation lacks consumed input evidence');
  else {
    if (!attestation || !Array.isArray(rawAttestation.evidence) || !rawAttestation.evidence.length || !Array.isArray(attestation.evidence)) throw Error('Incomplete host attestation evidence');
    const { identity, evidence, ...fields } = attestation;
    const { evidence: rawEvidence, ...rawFields } = rawAttestation;
    equal(fields, rawFields, 'Host attestation differs from consumed input');
    equal(identity, { bytes: receipt.inputIdentities.hostAttestation.bytes, sha256: receipt.inputIdentities.hostAttestation.sha256 }, 'Host attestation identity differs');
    if (evidence.length !== rawEvidence.length) throw Error('Host evidence inventory differs');
    for (const [index, file] of evidence.entries()) {
      const original = rawEvidence[index], record = records.get(safeRelative(file.retainedPath));
      if (original.path !== file.path || original.sha256 !== file.sha256 || !record || record.bytes !== file.bytes || record.sha256 !== file.sha256) throw Error('Host evidence bytes are not retained and sealed');
      if (original.bytes !== undefined && original.bytes !== file.bytes) throw Error('Host evidence byte length differs');
    }
  }

  if (receipt.controllerTiming !== undefined) equal(await json('controller-timing.json'), receipt.controllerTiming, 'Outer controller interval differs from retained evidence');
  for (const record of receipt.jobExecutions ?? []) equal(await json(jobExecutionPath(record.jobId)), record, 'Whole-job interval differs from retained controller evidence');
  let attemptsVerified = 0;
  const folders = new Set();
  const auditGroups = receipt.byteAuditGroups ?? [];
  for (const group of [...receipt.groups, ...auditGroups]) {
    const byteAudit = auditGroups.includes(group);
    if (typeof group.id !== 'string' || !Array.isArray(group.attempts)) throw Error('Malformed campaign group');
    if (byteAudit && group.kind !== 'perf-byte-audit-group-1' || !byteAudit && group.kind === 'perf-byte-audit-group-1') throw Error('Scored and byte audit groups cannot exchange roles');
    const folder = safeCell(group.id);
    if (folders.has(folder)) throw Error('Duplicate or colliding group evidence directory');
    folders.add(folder);
    equal(await json(`${folder}/controller.json`), group, 'Raw group differs from sealed controller');
    if (!records.has(`${folder}/process.log`)) throw Error('Group process log is missing');
    const input = await json(`${folder}/input.json`);
    equal(input.cell, group.cell, 'Group cell differs from consumed input');
    if (byteAudit) {
      equal(input.kind, group.kind, 'Byte audit worker kind differs from sealed specification');
      equal(input.byteAudit, group.byteAudit, 'Byte audit executable identity differs from sealed specification');
    }
    if (input.id !== group.id || input.cache !== group.cache || input.output !== group.output || !isAbsolute(group.output ?? '') || !Array.isArray(input.attempts)) throw Error('Group identity differs from consumed input');
    const executionRepo = receipt.identity.runtimeOnly === true ? receipt.productRepo ?? receipt.subjectRepo : receipt.subjectRepo;
    if (input.repo !== executionRepo || input.subjectRepo !== undefined && input.subjectRepo !== receipt.subjectRepo) throw Error('Group subject/product differs from receipt');
    if (input.rendererIdentity != null) {
      if (group.cell.handler !== 'browser' || group.cell.kind !== 'lifecycle') throw Error('Renderer ownership inputs belong only to browser lifecycle observations');
      equal(input.rendererIdentity, { sourceFiles: receipt.identity.before.files, buildFiles: receipt.identity.buildsBefore.files, sourceDigest: receipt.identity.before.digest, buildDigest: receipt.identity.buildsBefore.digest, toolsDigest: digest(receipt.identity.tools) }, 'Renderer ownership source/build identity differs from the campaign');
    }
    if (group.fixturePreparationFailed === true) {
      if (!['FAIL', 'INCONCLUSIVE'].includes(group.status) || group.attempts.length || !group.error || records.has(`${folder}/events.jsonl`) || records.has(`${folder}/receipt.json`)) throw Error('Fixture preparation failure cannot contain executed work');
      equal(input.fixtureDescriptor, consumedInputs.fixtureManifest, 'Failed fixture selection differs from consumed descriptor');
      continue;
    }
    const baseConfiguration = consumedInputs.configuration ?? {};
    if (baseConfiguration.browser?.byteAudit === true) throw Error('Consumed configuration enables coverage on scored work');
    equal(input.configuration, byteAudit ? byteAuditConfiguration(baseConfiguration) : baseConfiguration, 'Group configuration differs from consumed input');
    if (group.cell.handler === 'developer') equal(input.fixture, consumedInputs.fixtureManifest, 'Developer fixture input differs from consumed input');
    else {
      const descriptor = selectFixtureDescriptor(consumedInputs.fixtureManifest, group.cell);
      if (descriptor == null) {
        equal(input.fixture, null, 'Group fixture differs from consumed input');
        if (input.fixtureIdentity != null) throw Error('Absent fixture has a claimed selected identity');
      }
      else {
        const selectedPath = `${folder}/selected-fixture-manifest.json`, retained = records.get(selectedPath);
        if (!descriptor.seal || descriptor.seal.path !== descriptor.manifestPath || !sha(descriptor.seal.sha256) || !retained || retained.sha256 !== descriptor.seal.sha256) throw Error('Selected fixture lacks its consumed descriptor seal');
        equal(input.fixtureIdentity, { path: descriptor.manifestPath, bytes: retained.bytes, sha256: retained.sha256, retainedPath: 'selected-fixture-manifest.json' }, 'Selected fixture identity differs from retained bytes');
        const selected = await json(selectedPath);
        equal(input.fixture, { ...selected, manifestPath: descriptor.manifestPath, seal: descriptor.seal }, 'Selected fixture differs from retained manifest');
      }
    }
    if (group.attempts.length > input.attempts.length || group.status === 'PASS' && group.attempts.length !== input.attempts.length) throw Error('Executed attempt count differs from input');
    for (const [index, attempt] of group.attempts.entries()) {
      const planned = input.attempts[index];
      if (attempt.ordinal !== planned.ordinal || attempt.prime !== planned.prime || attempt.cache !== input.cache || attempt.id !== `${group.cell.id}/${group.cache}/${attempt.prime ? 'prime' : 'scored'}/${attempt.ordinal}`) throw Error('Attempt differs from consumed schedule');
    }
    const journalPath = `${folder}/events.jsonl`;
    if (!records.has(journalPath)) {
      if (group.status === 'PASS' || group.attempts.length) throw Error('Attempt inventory lacks its journal');
      if (group.partial) equal(group.journalHead, null, 'Partial controller journal head differs from retained journal');
      continue;
    }
    const journal = readJournal((await bytes(journalPath)).toString('utf8'));
    if (group.partial) equal(group.journalHead, journal.head, 'Partial controller journal head differs from retained journal');
    if (group.status === 'PASS' && journal.incompleteTail) throw Error('Passing group has an incomplete journal');
    const recovered = recoverJournal(journal.events, group);
    equal(recovered.map(value => value.id), group.attempts.map(value => value.id), 'Journal attempt inventory differs from controller');
    for (const [index, attempt] of recovered.entries()) {
      const actual = group.attempts[index];
      const terminalOverride = index === recovered.length - 1 && attempt.status !== 'PASS' && (group.timedOut === true || group.process?.interrupted === true);
      if (terminalOverride) {
        const elapsedMs = attempt.elapsedMs ?? 0, timedOut = group.timedOut === true;
        const expected = { ...attempt, status: 'FAIL', timedOut, elapsedMs,
          censor: { lowerMs: elapsedMs, upperMs: null, reason: timedOut ? 'process-timeout' : 'interrupted', timedBoundary: attempt.startMs === undefined ? 'reset-or-preparation' : 'action', durationUnavailable: elapsedMs === 0 } };
        equal(actual, expected, 'Killed attempt differs from its deterministic journal override');
      } else equal(actual, attempt, 'Attempt differs from its journal');
      verifyArtifactReferences(actual.result, root, records, { originalGroupOutput: group.output, folder });
      if (group.cell.handler === 'browser' && group.cell.kind === 'lifecycle') {
        const samplingArtifact = actual.result?.sampling?.artifact;
        let rawSamples = [];
        if (samplingArtifact?.path && sha(samplingArtifact.sha256) && Number.isSafeInteger(samplingArtifact.bytes)) {
          if (!isAbsolute(samplingArtifact.path) || !samplingArtifact.path.startsWith(group.output + sep)) throw Error('Resource samples must be retained inside their lifecycle group');
          const samplePath = `${folder}/${relative(group.output, resolve(samplingArtifact.path)).split(sep).join('/')}`;
          const raw = await json(samplePath);
          if (raw.schema !== 'browser-resource-samples-1' || !Array.isArray(raw.samples)) throw Error('Unsupported raw lifecycle resource observations');
          rawSamples = raw.samples;
          if (actual.result.sampling.complete === true && (raw.summary?.dataComplete !== true || rawSamples.some(sample => sample.allocationCoverage?.complete !== true))) throw Error('Complete lifecycle sampling differs from its raw allocation coverage');
        }
        const proof = lifecycleRendererProof(actual.result, rawSamples);
        if (proof) {
          if (!input.rendererIdentity) throw Error('Renderer ownership proof lacks independently bound executable inputs');
          const { verifyRendererOwnershipProof } = await import('./renderer-ownership.mjs');
          await verifyRendererOwnershipProof(proof, { output: group.output, sourceFiles: receipt.identity.before.files, buildFiles: receipt.identity.buildsBefore.files,
            executableIdentity: { sourceDigest: receipt.identity.before.digest, buildDigest: receipt.identity.buildsBefore.digest, toolsDigest: digest(receipt.identity.tools) },
            readRetained: path => bytes(`${folder}/${safeRelative(path)}`) });
        }
        if (rawSamples.length) {
          const { isRendererTextureNotApplicable } = await import('./renderer-ownership.mjs');
          for (const sample of rawSamples) if (sample.allocationCoverage?.complete === true && (sample.textureSide === null || sample.deviceTextureLimit === null)) {
            if (sample.textureSide !== null || sample.deviceTextureLimit !== null || !isRendererTextureNotApplicable(sample.rendererOwnership, sample.rendererOwnershipProof, { gpuBytes: sample.gpuBytes })) throw Error('Raw resource ledger claims complete texture coverage without a validated ownership proof');
          }
        }
      }
      if (byteAudit && actual.result?.d11) {
        const artifact = actual.result.d11.artifact, original = group.output;
        if (!artifact || typeof artifact.path !== 'string' || !isAbsolute(artifact.path) || !artifact.path.startsWith(original + sep)) throw Error('Byte audit raw observation must be retained inside its own group');
        const artifactPath = `${folder}/${relative(original, resolve(artifact.path)).split(sep).join('/')}`;
        const { verifyD11RetainedObservation } = await import('./browser-d11-verification.mjs');
        const payload = await json(artifactPath);
        verifyD11RetainedObservation(payload, actual.result.d11, { buildFiles: receipt.identity.buildsBefore.files, sourceFiles: receipt.identity.before.files, fixtureSeal: input.fixture?.seal?.sha256 ?? null });
        verifyByteAuditStartupBoundary({ cell: group.cell, attempt: actual, fixture: input.fixture });
      }
      if (group.cell.handler === 'developer' && ['C2/production-build', 'I1/command-groups'].includes(group.cell.id)) {
        const { verifyDeveloperBuildObservation } = await import('./developer-byte-verification.mjs');
        await verifyDeveloperBuildObservation({ cell: group.cell, attempt: actual, source: receipt.identity.before, output: group.output, readBytes: path => bytes(`${folder}/${safeRelative(path)}`) });
      }
      attemptsVerified++;
    }
    const workerPath = `${folder}/receipt.json`;
    if (records.has(workerPath) && !group.partial) {
      const worker = await json(workerPath);
      if (worker.kind !== (byteAudit ? 'perf-byte-audit-group-1' : 'perf-campaign-process-1')) throw Error('Unexpected worker receipt');
      equal(worker.attempts, recovered, 'Worker receipt differs from journal');
      for (const [name, value] of Object.entries(worker)) if (!['status', 'attempts'].includes(name)) equal(group[name], value, 'Controller differs from worker receipt');
      if (journal.events.at(-1)?.event !== 'process-end' || journal.events.at(-1).status !== worker.status) throw Error('Worker outcome differs from terminal journal evidence');
      if (group.status !== worker.status && !(group.status === 'FAIL' && (group.timedOut || group.process?.interrupted || group.process?.exitCode !== 0 || group.process?.ownedCleanupError || group.process?.sourceRecoveryError))) throw Error('Controller changed worker outcome without terminal failure evidence');
    } else if (group.status === 'PASS') throw Error('Passing group lacks a complete worker receipt');
  }
  return { evidenceFiles: records.size, groups: receipt.groups.length, byteAuditGroups: auditGroups.length, attempts: attemptsVerified, consumedInputs };
}

function recoverJournal(events, group) {
  const attempts = [], ids = new Set(); let active = null, ended = false;
  if (!events.length || events[0].event !== 'process-start' || events[0].cellId !== group.cell.id) throw Error('Journal lacks its process/cell start');
  if (group.processIdentity) equal(events[0].processIdentity, group.processIdentity, 'Journal process identity differs');
  for (const [index, event] of events.entries()) {
    if (ended) throw Error('Journal continues after process end');
    if (event.event === 'process-start' && index !== 0) throw Error('Repeated process start');
    if (event.event === 'attempt-start') {
      if (active || !event.attempt?.id || ids.has(event.attempt.id)) throw Error('Duplicate or overlapping journal attempt');
      ids.add(event.attempt.id); active = { ...event.attempt, status: 'INCONCLUSIVE' }; attempts.push(active);
    } else if (event.event === 'attempt-action-start') {
      if (!active || active.id !== event.id || active.startMs !== undefined) throw Error('Orphan or repeated action start');
      Object.assign(active, { startMs: event.startMs, reset: event.reset, resetElapsedMs: event.resetElapsedMs });
    } else if (event.event === 'attempt-end') {
      if (!active || event.attempt?.id !== active.id) throw Error('Orphan or repeated attempt end');
      for (const key of ['id', 'cache', 'ordinal', 'prime']) equal(event.attempt[key], active[key], 'Journal attempt identity changed');
      if (active.startMs !== undefined) for (const key of ['startMs', 'reset', 'resetElapsedMs']) equal(event.attempt[key], active[key], 'Journal action boundary changed');
      else if (event.attempt.status === 'PASS') throw Error('Passing attempt lacks its action start');
      attempts[attempts.length - 1] = event.attempt; active = null;
    } else if (event.event === 'process-end') {
      if (active) throw Error('Process ended with an unfinished attempt');
      if (group.status === 'PASS' && event.status !== 'PASS') throw Error('Passing controller differs from journal outcome');
      ended = true;
    }
  }
  if (group.status === 'PASS' && (!ended || attempts.some(attempt => attempt.status !== 'PASS'))) throw Error('Passing group lacks complete successful journal attempts');
  return attempts;
}

function verifyArtifactReferences(value, root, records, location) {
  if (!value || typeof value !== 'object') return;
  function reference(path, identity = null) {
    if (typeof path !== 'string') throw Error('Invalid artifact reference');
    const original = location.originalGroupOutput;
    // Receipts remain verifiable after an evidence packet is copied to a new
    // directory. Only paths inside the sealed original group are remapped.
    const local = isAbsolute(path) && path.startsWith(original + sep)
      ? location.folder + '/' + relative(original, resolve(path)).split(sep).join('/')
      : isAbsolute(path) ? relative(root, resolve(path)).split(sep).join('/') : path;
    const record = records.get(safeRelative(local));
    if (!record) throw Error('Referenced artifact lacks sealed retained bytes');
    if (identity?.bytes !== undefined && identity.bytes !== record.bytes) throw Error('Artifact byte length differs');
    if (identity?.byteLength !== undefined && String(identity.byteLength) !== String(record.bytes)) throw Error('Artifact byte length differs');
    if (identity?.sha256 !== undefined && (identity.sha256.startsWith('sha256:') ? identity.sha256 : 'sha256:' + identity.sha256) !== record.sha256) throw Error('Artifact hash differs');
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'artifacts' && Array.isArray(child)) for (const item of child) { if (typeof item === 'string') reference(item); else if (item?.path) reference(item.path, item); }
    if (key === 'artifact' && child?.path) reference(child.path, child);
    if (Array.isArray(child)) for (const item of child) verifyArtifactReferences(item, root, records, location);
    else if (child && typeof child === 'object') verifyArtifactReferences(child, root, records, location);
  }
}
