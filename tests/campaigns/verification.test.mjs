import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { digestJSON } from '../../tooling/qualification/core.mjs';
import { digest, fileIdentity } from '../../tooling/qualification/campaigns/common.mjs';
import { verifySealedEvidence, verifyPreparedSourceInventory } from '../../tooling/qualification/campaigns/verification.mjs';

async function packet(t, { configuration = null, trace = true } = {}) {
  const output = await realpath(await mkdtemp(join(tmpdir(), 'campaign-verification-')));
  t.after(() => rm(output, { recursive: true, force: true }));
  const folder = 'C9_sample_cold_1', root = join(output, folder);
  await mkdir(root);
  const writeJSON = async (path, value) => { await mkdir(dirname(join(output, path)), { recursive: true }); await writeFile(join(output, path), JSON.stringify(value, null, 2) + '\n'); };
  const source = { head: 'a'.repeat(40), files: [], digest: digestJSON([]) }, build = { files: [], missing: [], digest: digest([]) };
  const cell = { id: 'C9/sample', operation: 'test.sample', host: 'C', kind: 'operation' };
  const planned = { ordinal: 1, prime: false }, processIdentity = { pid: 12345, startedAt: '2026-09-30T00:00:00Z', node: 'v26.10.0' };
  const initial = { id: 'C9/sample/cold/scored/1', cache: 'cold', ...planned, status: 'INCONCLUSIVE', reset: null, result: null };
  const result = { status: 'PASS', elapsedMs: 4, phases: [] };
  if (trace) {
    const bytes = Buffer.from('{"events":[]}\n'), path = join(root, 'browser-trace-1.json'); await writeFile(path, bytes);
    result.artifacts = [path]; result.trace = { artifact: { path, bytes: bytes.length, sha256: digest(bytes).slice(7) } };
  }
  const attempt = { ...initial, status: 'PASS', reset: { cache: 'cold', fresh: true }, startMs: 100, endMs: 104, resetElapsedMs: 2, elapsedMs: 4, result };
  const worker = { kind: 'perf-campaign-process-1', schemaVersion: 1, cell, cache: 'cold', processIdentity, startedAt: processIdentity.startedAt, status: 'PASS', preparation: null, attempts: [attempt], cleanup: null, finishedAt: '2026-09-30T00:00:01Z' };
  const input = { id: 'C9/sample/cold/1', cell, cache: 'cold', attempts: [planned], output: root, repo: '/subject/repo', fixture: null, configuration: configuration ?? {} };
  const group = { ...input, ...worker, process: { exitCode: 0, signal: null, timedOut: false, interrupted: false }, output: root, timedOut: false };
  delete group.repo; delete group.fixture; delete group.configuration;
  const events = [
    { event: 'process-start', cellId: cell.id, processIdentity },
    { event: 'cell-prepared', preparation: null },
    { event: 'attempt-start', attempt: initial },
    { event: 'attempt-action-start', id: attempt.id, startMs: attempt.startMs, reset: attempt.reset, resetElapsedMs: attempt.resetElapsedMs },
    { event: 'attempt-end', attempt },
    { event: 'process-cleanup', cleanup: null },
    { event: 'process-end', status: 'PASS' },
  ];
  const receipt = { kind: 'perf-runtime-campaign-1', subjectRepo: input.repo, plan: { campaign: 'P', selectedJobIds: ['C9'], jobs: [] }, groups: [group], host: { observed: { platform: 'darwin' }, attestation: null, hostChecks: [] }, identity: { before: source, after: structuredClone(source), controlBefore: structuredClone(source), controlAfter: structuredClone(source), buildsBefore: build, buildsAfter: structuredClone(build), buildProvenance: null }, inputIdentities: { hostAttestation: null, fixtureManifest: null, configuration: null, buildProvenance: null }, evidence: [] };
  receipt.planDigest = digest(receipt.plan);
  async function writeJournal(values = events) {
    let previous = null;
    const lines = values.map((value, index) => {
      const body = { sequence: index + 1, previous, utc: '2026-09-30T00:00:00Z', monotonicMs: index, ...value };
      previous = digest(body); return JSON.stringify({ ...body, hash: previous });
    });
    await writeFile(join(root, 'events.jsonl'), lines.join('\n') + '\n');
    return previous;
  }
  async function seal() {
    const files = [];
    async function walk(directory, prefix = '') {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = prefix + entry.name;
        if (entry.isDirectory()) await walk(join(directory, entry.name), path + '/');
        else if (entry.isFile() && path !== 'receipt.json') files.push({ path, ...await fileIdentity(join(output, path)) });
      }
    }
    await walk(output); receipt.evidence = files.sort((a, b) => a.path.localeCompare(b.path));
  }
  if (configuration !== null) {
    const retainedPath = 'input-manifests/configuration.json'; await writeJSON(retainedPath, configuration);
    receipt.inputIdentities.configuration = { path: '/source/configuration.json', retainedPath, ...await fileIdentity(join(output, retainedPath)) };
  }
  await writeJSON('plan.json', receipt.plan); await writeJSON('host.json', receipt.host);
  await writeJSON('source-before.json', receipt.identity.before); await writeJSON('source-after.json', receipt.identity.after);
  await writeJSON(`${folder}/input.json`, input); await writeJSON(`${folder}/receipt.json`, worker); await writeJSON(`${folder}/controller.json`, group);
  await writeFile(join(root, 'process.log'), 'worker log\n'); await writeJournal(); await seal();
  return { receipt, output, folder, root, group, input, worker, attempt, initial, events, writeJSON, writeJournal, seal, verify: () => verifySealedEvidence(receipt, output) };
}

async function partialPacket(t, { timedOut = true, interrupted = false, actionStarted = true } = {}) {
  const p = await packet(t, { trace: false });
  const recovered = { ...p.initial, ...(actionStarted ? { startMs: p.attempt.startMs, reset: p.attempt.reset, resetElapsedMs: p.attempt.resetElapsedMs } : {}) };
  p.group.attempts = [{ ...recovered, status: 'FAIL', elapsedMs: 0, timedOut,
    censor: { lowerMs: 0, upperMs: null, reason: timedOut ? 'process-timeout' : 'interrupted', timedBoundary: actionStarted ? 'action' : 'reset-or-preparation', durationUnavailable: true } }];
  p.group.status = 'FAIL'; p.group.partial = true; p.group.timedOut = timedOut;
  p.group.process.timedOut = timedOut; p.group.process.interrupted = interrupted;
  p.group.journalHead = await p.writeJournal(p.events.slice(0, actionStarted ? 4 : 3));
  await p.writeJSON(`${p.folder}/controller.json`, p.group); await rm(join(p.root, 'receipt.json')); await p.seal();
  return p;
}

test('verifier joins sealed input, host, controller, worker, journal and trace evidence', async t => {
  const p = await packet(t, { configuration: { browser: { headless: true } } });
  const result = await p.verify();
  assert.equal(result.groups, 1); assert.equal(result.attempts, 1); assert.equal(result.evidenceFiles, p.receipt.evidence.length);
  assert.deepEqual(result.consumedInputs.configuration, { browser: { headless: true } });
});

test('empty or omitted metadata seals cannot bypass raw evidence', async t => {
  const p = await packet(t); p.receipt.evidence = [];
  await assert.rejects(p.verify(), /metadata inventory/);
  await p.seal(); p.receipt.evidence = p.receipt.evidence.filter(file => !file.path.endsWith('browser-trace-1.json'));
  await assert.rejects(p.verify(), /metadata inventory/);
});

test('host and source claims must equal retained metadata and self-consistent manifests', async t => {
  const p = await packet(t); p.receipt.host = { ...p.receipt.host, observed: { platform: 'linux' } };
  await assert.rejects(p.verify(), /host observations/);
  p.receipt.host = JSON.parse(await readFile(join(p.output, 'host.json'), 'utf8'));
  p.receipt.identity.after.files.push({ path: 'src/new.ts', sha256: 'b'.repeat(64), bytes: 1 });
  await p.writeJSON('source-after.json', p.receipt.identity.after); await p.seal();
  await assert.rejects(p.verify(), /source manifest digest/);
});

test('rewritten passing aggregate cannot override original controller bytes', async t => {
  const p = await packet(t); p.group.attempts[0].result.elapsedMs = 0;
  await assert.rejects(p.verify(), /sealed controller/);
});

test('an empty hash-valid journal cannot support a passing controller', async t => {
  const p = await packet(t); await p.writeJournal([p.events[0], p.events.at(-1)]); await p.seal();
  await assert.rejects(p.verify(), /attempt inventory/);
});

test('duplicate starts and orphan endings cannot be collapsed during journal recovery', async t => {
  const p = await packet(t); await p.writeJournal([...p.events.slice(0, 3), p.events[2], ...p.events.slice(3)]); await p.seal();
  await assert.rejects(p.verify(), /Duplicate or overlapping/);
  await p.writeJournal([p.events[0], p.events[4], p.events.at(-1)]); await p.seal();
  await assert.rejects(p.verify(), /Orphan or repeated attempt end/);
});

test('worker receipt cannot be omitted or differ from its journal', async t => {
  const p = await packet(t); p.worker.attempts = [{ ...p.attempt, elapsedMs: 0 }];
  await p.writeJSON(`${p.folder}/receipt.json`, p.worker); await p.seal();
  await assert.rejects(p.verify(), /Worker receipt differs/);
  await rm(join(p.root, 'receipt.json')); await p.seal();
  await assert.rejects(p.verify(), /complete worker receipt/);
});

test('partial timeout preserves journal facts and only marks its final unfinished start', async t => {
  const p = await partialPacket(t);
  assert.equal((await p.verify()).attempts, 1);
  p.group.attempts[0].elapsedMs = 20; await p.writeJSON(`${p.folder}/controller.json`, p.group); await p.seal();
  await assert.rejects(p.verify(), /deterministic journal override/);
});

test('killed-attempt censor fields and flags must exactly match the controller transform', async t => {
  const p = await partialPacket(t), original = structuredClone(p.group.attempts[0]);
  const mutations = [
    attempt => { attempt.censor.lowerMs = 12; },
    attempt => { attempt.censor.upperMs = 12; },
    attempt => { attempt.censor.reason = 'interrupted'; },
    attempt => { attempt.censor.timedBoundary = 'reset-or-preparation'; },
    attempt => { attempt.censor.durationUnavailable = false; },
    attempt => { attempt.timedOut = false; },
    attempt => { delete attempt.censor; },
    attempt => { delete attempt.timedOut; },
    attempt => { attempt.status = 'INCONCLUSIVE'; delete attempt.elapsedMs; delete attempt.timedOut; delete attempt.censor; },
  ];
  for (const mutate of mutations) {
    p.group.attempts[0] = structuredClone(original); mutate(p.group.attempts[0]);
    await p.writeJSON(`${p.folder}/controller.json`, p.group); await p.seal();
    await assert.rejects(p.verify(), /deterministic journal override/);
  }
});

test('interruption during reset retains its distinct unavailable action boundary', async t => {
  const p = await partialPacket(t, { timedOut: false, interrupted: true, actionStarted: false });
  assert.equal((await p.verify()).attempts, 1);
  p.group.attempts[0].censor.reason = 'process-timeout';
  await p.writeJSON(`${p.folder}/controller.json`, p.group); await p.seal();
  await assert.rejects(p.verify(), /deterministic journal override/);
});

test('terminal timeout preserves an already journaled failure duration', async t => {
  const p = await packet(t, { trace: false });
  p.attempt.status = 'FAIL'; p.attempt.result.status = 'FAIL'; p.worker.status = 'FAIL'; p.events.at(-1).status = 'FAIL';
  p.group.status = 'FAIL'; p.group.timedOut = true; p.group.process.timedOut = true;
  p.group.attempts = [{ ...p.attempt, timedOut: true,
    censor: { lowerMs: 4, upperMs: null, reason: 'process-timeout', timedBoundary: 'action', durationUnavailable: false } }];
  await p.writeJSON(`${p.folder}/controller.json`, p.group); await p.writeJSON(`${p.folder}/receipt.json`, p.worker);
  await p.writeJournal(); await p.seal(); assert.equal((await p.verify()).attempts, 1);
  p.group.attempts[0].elapsedMs = 0; p.group.attempts[0].censor.lowerMs = 0; p.group.attempts[0].censor.durationUnavailable = true;
  await p.writeJSON(`${p.folder}/controller.json`, p.group); await p.seal();
  await assert.rejects(p.verify(), /deterministic journal override/);
});

test('partial controller journal head must match its retained chain', async t => {
  const p = await partialPacket(t);
  for (const head of ['sha256:' + '0'.repeat(64), null, undefined]) {
    if (head === undefined) delete p.group.journalHead; else p.group.journalHead = head;
    await p.writeJSON(`${p.folder}/controller.json`, p.group); await p.seal();
    await assert.rejects(p.verify(), /Partial controller journal head/);
  }
});

test('a partial controller without a journal records an explicit null head', async t => {
  const p = await partialPacket(t);
  p.group.attempts = []; p.group.journalHead = null;
  await rm(join(p.root, 'events.jsonl')); await p.writeJSON(`${p.folder}/controller.json`, p.group); await p.seal();
  assert.equal((await p.verify()).attempts, 0);
  for (const head of ['sha256:' + '0'.repeat(64), undefined]) {
    if (head === undefined) delete p.group.journalHead; else p.group.journalHead = head;
    await p.writeJSON(`${p.folder}/controller.json`, p.group); await p.seal();
    await assert.rejects(p.verify(), /Partial controller journal head/);
  }
});

test('retained consumed configuration must match the bytes actually passed to the worker', async t => {
  const p = await packet(t, { configuration: { mode: 'original' } });
  p.input.configuration = { mode: 'changed' }; await p.writeJSON(`${p.folder}/input.json`, p.input); await p.seal();
  await assert.rejects(p.verify(), /configuration differs/);
});

test('consumed input identities cannot point at unsealed or different bytes', async t => {
  const p = await packet(t, { configuration: { mode: 'original' } });
  p.receipt.inputIdentities.configuration.sha256 = 'sha256:' + '0'.repeat(64);
  await assert.rejects(p.verify(), /Consumed input differs/);
});

test('preparation failures retain consumed but unapplied build provenance without authorizing a group', async t => {
  const p = await packet(t), retainedPath = 'input-manifests/build-provenance.json';
  const rejected = { kind: 'perf-build-provenance-1', sourceDigest: 'wrong-subject', commands: [] };
  await p.writeJSON(retainedPath, rejected);
  p.receipt.inputIdentities.buildProvenance = { path: '/original-build/provenance.json', retainedPath, ...await fileIdentity(join(p.output, retainedPath)) };
  p.receipt.groups = []; p.receipt.runError = { name: 'Error', code: null, message: 'Build provenance belongs to another source or product' };
  await p.seal(); assert.deepEqual((await p.verify()).consumedInputs.buildProvenance, rejected);
  p.receipt.runError = null; await assert.rejects(p.verify(), /Build provenance differs/);
  p.receipt.runError = { name: 'Error', code: null, message: 'Preparation failed' }; p.receipt.groups = [p.group];
  await assert.rejects(p.verify(), /Build provenance differs/);
  p.receipt.groups = []; await p.writeJSON(retainedPath, { ...rejected, sourceDigest: 'changed-after-seal' });
  await assert.rejects(p.verify(), /Evidence changed/);
});

test('prepared product and enriched build logs retain the original subject and consumed provenance', async t => {
  const p = await packet(t), commands = [], retainedLogs = [];
  for (const kind of ['app', 'server']) {
    const command = { id: 'C2.build-' + kind, exitCode: 0, outcome: 'PASS' };
    for (const lane of ['stdout', 'stderr']) {
      const bytes = Buffer.from(kind + ':' + lane + '\n'), retainedPath = `build-logs/${kind}-${lane}.log`;
      await mkdir(join(p.output, 'build-logs'), { recursive: true }); await writeFile(join(p.output, retainedPath), bytes);
      command[lane] = { path: `/original-build/${kind}-${lane}.log`, bytes: bytes.length, sha256: digest(bytes).slice(7) };
      retainedLogs.push({ ...command[lane], sha256: digest(bytes), retainedPath });
    }
    commands.push(command);
  }
  const original = { kind: 'perf-build-provenance-1', productRepo: '/prepared/source', commands }, retainedPath = 'input-manifests/build-provenance.json';
  await p.writeJSON(retainedPath, original);
  p.receipt.inputIdentities.buildProvenance = { path: '/original-build/provenance.json', retainedPath, ...await fileIdentity(join(p.output, retainedPath)) };
  p.receipt.inputIdentities.developerState = null; p.receipt.inputIdentities.ciHandoff = null;
  p.receipt.identity.buildProvenance = { ...original, retainedLogs }; p.receipt.identity.runtimeOnly = true; p.receipt.productRepo = original.productRepo;
  p.input.repo = original.productRepo; p.input.subjectRepo = p.receipt.subjectRepo;
  await p.writeJSON(`${p.folder}/input.json`, p.input); await p.seal(); assert.equal((await p.verify()).groups, 1);
  p.receipt.identity.buildProvenance.retainedLogs[0].sha256 = 'sha256:' + '0'.repeat(64);
  await assert.rejects(p.verify(), /Build log differs/);
});

test('artifact references must agree with retained trace bytes after all envelopes are resealed', async t => {
  const p = await packet(t); p.attempt.result.trace.artifact.sha256 = '0'.repeat(64);
  await p.writeJSON(`${p.folder}/controller.json`, p.group); await p.writeJSON(`${p.folder}/receipt.json`, p.worker); await p.writeJournal(); await p.seal();
  await assert.rejects(p.verify(), /Artifact hash differs/);
});

test('host attestation evidence is retained locally and bound to original input identities', async t => {
  const p = await packet(t), retainedPath = 'input-manifests/host-evidence-0.txt', evidenceBytes = Buffer.from('physical runner observation\n');
  await mkdir(join(p.output, 'input-manifests')); await writeFile(join(p.output, retainedPath), evidenceBytes);
  const original = { path: '/operator/runner-observation.txt', sha256: digest(evidenceBytes) };
  const raw = { kind: 'perf-host-attestation-1', profile: 'H', operator: 'operator', evidence: [original] };
  const attestationPath = 'input-manifests/host-attestation.json'; await p.writeJSON(attestationPath, raw);
  const identity = await fileIdentity(join(p.output, attestationPath));
  p.receipt.inputIdentities.hostAttestation = { path: '/operator/host.json', retainedPath: attestationPath, ...identity };
  p.receipt.host.attestation = { ...raw, identity, evidence: [{ ...original, bytes: evidenceBytes.length, retainedPath }] };
  await p.writeJSON('host.json', p.receipt.host); await p.seal(); assert.equal((await p.verify()).groups, 1);
  p.receipt.host.attestation.evidence[0].sha256 = 'sha256:' + '0'.repeat(64);
  await p.writeJSON('host.json', p.receipt.host); await p.seal();
  await assert.rejects(p.verify(), /Host evidence bytes/);
});

test('parent symlinks and traversal evidence paths are rejected', async t => {
  const p = await packet(t); p.receipt.evidence[0].path = '../outside.json';
  await assert.rejects(p.verify(), /Unsafe receipt evidence path/);
  await p.seal(); await rename(p.root, p.root + '-moved'); await symlink(p.root + '-moved', p.root);
  await assert.rejects(p.verify(), /ordinary directories|Symlink/);
});

test('copied evidence packets retain verifiable group-local artifact references', async t => {
  const p = await packet(t), relocated = p.output + '-retained';
  await rename(p.output, relocated); t.after(() => rm(relocated, { recursive: true, force: true }));
  assert.equal((await verifySealedEvidence(p.receipt, relocated)).attempts, 1);
});

test('mixed fixture catalogs bind each group to its exact retained selected manifest', async t => {
  const p = await packet(t), selectedPath = `${p.folder}/selected-fixture-manifest.json`;
  const raw = { kind: 'sealed-performance-fixture', workload: 'WJ', root: '/fixture/WJ/store' };
  await p.writeJSON(selectedPath, raw);
  const selectedIdentity = await fileIdentity(join(p.output, selectedPath));
  const descriptor = { manifestPath: '/fixture/WJ/fixture.json', seal: { path: '/fixture/WJ/fixture.json', sha256: selectedIdentity.sha256 } };
  const catalog = { kind: 'perf-fixture-catalog-1', fixtures: { WJ: descriptor, WF: { manifestPath: '/different/fixture.json', seal: { path: '/different/fixture.json', sha256: 'sha256:' + '0'.repeat(64) } } } };
  p.group.cell.workload = 'WJ'; p.group.cell.handler = 'backend'; p.input.fixture = { ...raw, ...descriptor };
  p.input.fixtureIdentity = { path: descriptor.manifestPath, ...selectedIdentity, retainedPath: 'selected-fixture-manifest.json' };
  const retainedPath = 'input-manifests/fixture-manifest.json'; await p.writeJSON(retainedPath, catalog);
  p.receipt.inputIdentities.fixtureManifest = { path: '/fixture/catalog.json', retainedPath, ...await fileIdentity(join(p.output, retainedPath)) };
  await p.writeJSON(`${p.folder}/input.json`, p.input); await p.writeJSON(`${p.folder}/controller.json`, p.group); await p.writeJSON(`${p.folder}/receipt.json`, p.worker); await p.seal();
  assert.equal((await p.verify()).groups, 1);
  p.input.fixture.root = '/substituted/store'; await p.writeJSON(`${p.folder}/input.json`, p.input); await p.seal();
  await assert.rejects(p.verify(), /Selected fixture differs/);
});

test('fixture preparation failures preserve descriptor evidence without invented worker execution', async t => {
  const p = await packet(t), catalog = { kind: 'perf-fixture-catalog-1', fixtures: {} }, retainedPath = 'input-manifests/fixture-manifest.json';
  await p.writeJSON(retainedPath, catalog);
  p.receipt.inputIdentities.fixtureManifest = { path: '/fixture/catalog.json', retainedPath, ...await fileIdentity(join(p.output, retainedPath)) };
  p.group.status = 'INCONCLUSIVE'; p.group.attempts = []; p.group.fixturePreparationFailed = true; p.group.error = { code: 'CAMPAIGN_PREREQUISITE', message: 'Missing selected fixture' };
  delete p.input.fixture; delete p.input.configuration; p.input.fixtureDescriptor = catalog;
  await p.writeJSON(`${p.folder}/input.json`, p.input); await p.writeJSON(`${p.folder}/controller.json`, p.group);
  await rm(join(p.root, 'events.jsonl')); await rm(join(p.root, 'receipt.json')); await p.seal();
  assert.equal((await p.verify()).attempts, 0);
  p.group.status = 'PASS'; await p.writeJSON(`${p.folder}/controller.json`, p.group); await p.seal();
  await assert.rejects(p.verify(), /cannot contain executed work/);
});

test('prepared source stability is reproduced from before and after manifests', async t => {
  const p = await packet(t), before = [{ path: 'src/app.ts', bytes: 1, sha256: 'sha256:' + 'a'.repeat(64) }], after = [{ ...before[0], sha256: 'sha256:' + 'b'.repeat(64) }];
  p.receipt.identity.preparedSource = { files: before, digest: digest(before) };
  p.receipt.identity.preparedSourceAfter = { files: after, digest: digest(after) };
  p.receipt.identity.preparedSourceStable = false; await assert.rejects(p.verify(), /sealed source manifest/);
  p.receipt.identity.preparedSourceStable = true;
  await assert.rejects(p.verify(), /stability claim/);
});

test('retained prepared source requires the complete applicable subject inventory, even after resealing', () => {
  const subject = [
    { path: 'src/app.ts', bytes: 1, sha256: 'a'.repeat(64) },
    { path: 'docs/spec/performance.md', bytes: 2, sha256: 'b'.repeat(64) },
    { path: '.github/workflows/qualification.yml', bytes: 3, sha256: 'c'.repeat(64) },
    { path: 'AGENTS.md', bytes: 4, sha256: 'd'.repeat(64) },
    { path: 'notes.txt', bytes: 5, sha256: 'e'.repeat(64) },
  ];
  const files = subject.slice(0, 4), prepared = files.map(file => ({ ...file, sha256: 'sha256:' + file.sha256 }));
  const identity = { before: { files: subject }, buildProvenance: { subjectSourceManifest: subject, sourceManifest: { files, sha256: digest(JSON.stringify(files, null, 2) + '\n') } }, preparedSource: { files: prepared } };
  assert.doesNotThrow(() => verifyPreparedSourceInventory(identity));
  const reduced = structuredClone(identity); reduced.buildProvenance.sourceManifest.files.pop(); reduced.preparedSource.files.pop();
  reduced.buildProvenance.sourceManifest.sha256 = digest(JSON.stringify(reduced.buildProvenance.sourceManifest.files, null, 2) + '\n');
  assert.throws(() => verifyPreparedSourceInventory(reduced), /omits applicable/);
  const substituted = structuredClone(identity); substituted.buildProvenance.subjectSourceManifest = subject.slice(0, 1);
  assert.throws(() => verifyPreparedSourceInventory(substituted), /subject manifest differs/);
});

test('a retained source-recovery failure can downgrade the completed worker without rewriting its journal', async t => {
  const p = await packet(t); p.group.status = 'FAIL'; p.group.process.sourceRecoveryError = { name: 'Error', message: 'Required source restoration failed' };
  await p.writeJSON(`${p.folder}/controller.json`, p.group); await p.seal();
  assert.equal((await p.verify()).attempts, 1);
});
