import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fixedHmrEdit, hotUpdateWitness, ownHmrSource, recoverHmrSource, withHmrEdit} from '../../tooling/qualification/campaigns/browser-hmr.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const original = Buffer.from("import {html} from 'lit';\nexport const SHELL_WORDMARK = 'Editor';\nexport function renderShellWordmark() { return html`<span>${SHELL_WORDMARK}</span>`; }\n");
async function fixture(t, mutate = () => {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ie-hmr-contract-')));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const workspace = join(directory, 'workspace'), repo = join(workspace, 'source'), subjectRepo = join(directory, 'subject'), stateDirectory = join(directory, 'state'), output = join(directory, 'output');
  await mkdir(workspace, {mode: 0o700}); await mkdir(subjectRepo); await mkdir(join(repo, 'src/ui'), {recursive: true}); await mkdir(stateDirectory, {mode: 0o700}); await mkdir(output, {mode: 0o700});
  const path = join(repo, 'src/ui/shell-wordmark.ts'); await writeFile(path, original, {mode: 0o640}); await chmod(path, 0o640);
  const state = {productRepo: repo, sourceDigest: 'sha256:' + 'a'.repeat(64), buildProvenancePath: join(directory, 'build-provenance.json'),
    p: {source: repo, workspace, completed: ['production-build'], active: null, failure: null}, source: {files: [{path: 'src/ui/shell-wordmark.ts', bytes: original.length, sha256: hash(original), mode: 0o640}]}};
  mutate(state);
  const envelope = {kind: 'developer-runtime-state-1', sha256: hash(json(state)), state};
  await writeFile(join(stateDirectory, 'bridge-state.json'), json(envelope));
  return {repo, subjectRepo, output, path, directory, stateDirectory, configuration: {developerStateDirectory: stateDirectory}};
}
const baseline = () => ({timeOrigin: 1000, navigationCount: 1, mainFrameNavigations: 1, shellConnected: true, canvasConnected: true,
  documentSha256: 'sha256:' + 'b'.repeat(64), documentId: 'sealed-W1', revision: '7', visibleDocumentSha256: 'sha256:' + 'c'.repeat(64), uiSha256: 'sha256:' + 'd'.repeat(64), wordmark: 'Editor'});
async function recoveryFixture(t, workerPid, changed = true) {
  const f = await fixture(t), attempt = randomUUID(), backup = join(f.output, 'hmr-original-' + attempt + '.ts');
  await writeFile(backup, original, {mode: 0o600});
  if (changed) await writeFile(f.path, fixedHmrEdit(original));
  const lock = {kind: 'owned-hmr-edit-1', ownerPid: workerPid, attempt, repo: f.repo, subjectRepo: f.subjectRepo, output: f.output,
    sourcePath: 'src/ui/shell-wordmark.ts', backup, originalSha256: hash(original), originalMode: 0o640, originalBytes: original.length,
    changedSha256: hash(fixedHmrEdit(original)), stateSha256: hash(await readFile(join(f.stateDirectory, 'bridge-state.json')))};
  await writeFile(join(f.stateDirectory, 'bridge.lock'), json(lock), {mode: 0o600});
  return {...f, workerPid, lock};
}
function exitedPid() {
  // An actual finite child exit establishes dead ownership; never guess an
  // arbitrary PID or mock a live process into authorizing source recovery.
  const child = spawnSync(process.execPath, ['-e', ''], {stdio: 'ignore'});
  assert.equal(child.status, 0); assert.ok(child.pid > 0); return child.pid;
}

test('the fixed source change rejects absent, repeated, already edited and invalid UTF-8 anchors', () => {
  const edited = fixedHmrEdit(original);
  assert.match(edited.toString(), /export const SHELL_WORDMARK = 'Editor updated';/);
  assert.equal(edited.toString().replace("'Editor updated'", "'Editor'"), original.toString());
  for (const bytes of [Buffer.from('export const OTHER = 1;'), Buffer.concat([original, original]), edited, Buffer.concat([original, Buffer.from([0xff])])]) assert.throws(() => fixedHmrEdit(bytes), /exact UTF-8 source anchor/);
});

test('actual filesystem save and restore preserve sealed bytes and file mode', async t => {
  const f = await fixture(t), owner = await ownHmrSource(f);
  try {
    const result = await withHmrEdit(owner, async saved => {
      assert.ok(saved.savedMs >= saved.startMs); assert.equal(saved.clock, 'runner-monotonic');
      assert.deepEqual(await readFile(f.path), fixedHmrEdit(original));
      return 'observed';
    });
    assert.equal(result.value, 'observed'); assert.equal(result.restoration.restored, true);
    assert.deepEqual(await readFile(f.path), original); assert.equal((await lstat(f.path)).mode & 0o777, 0o640);
  } finally { await owner.close(); }
  await assert.rejects(readFile(join(f.stateDirectory, 'bridge.lock')), {code: 'ENOENT'});
});

test('an action failure restores source and carries the failed attempt save evidence', async t => {
  const f = await fixture(t), owner = await ownHmrSource(f);
  try {
    await assert.rejects(withHmrEdit(owner, async () => { throw Error('visible wordmark deadline'); }), error => {
      assert.match(error.message, /wordmark deadline/); assert.ok(Number.isFinite(error.hmr.saved.savedMs)); assert.equal(error.hmr.restoration.restored, true); return true;
    });
    assert.deepEqual(await readFile(f.path), original);
  } finally { await owner.close(); }
});

test('cancellation after a successful edit still restores before rejecting', async t => {
  const f = await fixture(t), owner = await ownHmrSource(f);
  try {
    for (const reason of [Error('cancelled'), 'SIGTERM']) {
      const controller = new AbortController();
      await assert.rejects(withHmrEdit(owner, async () => { controller.abort(reason); }, controller.signal), error => {
        assert.match(error.message, /cancelled|SIGTERM/);
        if (typeof reason === 'string') assert.equal(error.cause, reason);
        assert.equal(error.hmr.restoration.restored, true);
        assert.ok(Number.isFinite(error.hmr.saved.savedMs));
        return true;
      });
      assert.deepEqual(await readFile(f.path), original);
    }
  } finally { await owner.close(); }
});

test('cancellation abandons a stalled browser observation and promptly restores source', {timeout: 2000}, async t => {
  const f = await fixture(t), owner = await ownHmrSource(f), controller = new AbortController();
  try {
    await assert.rejects(withHmrEdit(owner, () => { queueMicrotask(() => controller.abort(Error('cancelled stalled browser'))); return new Promise(() => {}); }, controller.signal), /cancelled stalled browser/);
    assert.deepEqual(await readFile(f.path), original);
  } finally { await owner.close(); }
});

test('another edit is never overwritten during restoration and its recovery lock remains', async t => {
  const f = await fixture(t), owner = await ownHmrSource(f), other = Buffer.from('external editor source');
  await assert.rejects(withHmrEdit(owner, async () => { await writeFile(f.path, other); }), /Unexpected concurrent source edit/);
  assert.deepEqual(await readFile(f.path), other);
  await assert.rejects(owner.close(), /Unexpected concurrent source edit/);
  const recovery = JSON.parse(await readFile(join(f.stateDirectory, 'bridge.lock'), 'utf8'));
  assert.deepEqual(await readFile(recovery.backup), original);
});

test('the source owner shares the developer preparation lock and rejects concurrent ownership', async t => {
  const f = await fixture(t), owner = await ownHmrSource(f);
  try { await assert.rejects(ownHmrSource(f), {code: 'EEXIST'}); }
  finally { await owner.close(); }
});

test('failed, active and incomplete product preparation cannot authorize source mutation', async t => {
  for (const mutate of [state => state.p.failure = 'interrupted', state => state.p.active = {stage: 'production-build'}, state => state.p.completed = [], state => state.productRepo = state.productRepo + '-other']) {
    const f = await fixture(t, mutate);
    await assert.rejects(ownHmrSource(f), /completed prepared product/);
    assert.deepEqual(await readFile(f.path), original);
  }
});

test('completed native handoff source is accepted, failed native handoff is rejected', async t => {
  const f = await fixture(t, state => { state.h = {source: state.productRepo, workspace: state.p.workspace, completed: true}; state.p = null; });
  const owner = await ownHmrSource(f); await owner.close();
  const failed = await fixture(t, state => { state.h = {source: state.productRepo, workspace: state.p.workspace, completed: true, failure: 'interrupted'}; state.p = null; });
  await assert.rejects(ownHmrSource(failed), /completed prepared product/);
});

test('live checkout identity and source outside the declared workspace cannot authorize mutation', async t => {
  const f = await fixture(t);
  await assert.rejects(ownHmrSource({...f, subjectRepo: f.repo}), /separate canonical subject/);
  await assert.rejects(ownHmrSource({...f, subjectRepo: f.directory}), /separate canonical subject/);
  await assert.rejects(ownHmrSource({...f, subjectRepo: undefined}), /separate canonical subject/);
  const outside = await fixture(t, state => { state.p.workspace += '-other'; });
  await assert.rejects(ownHmrSource(outside), /completed prepared product/);
});

test('dead exact worker recovery restores bytes and removes known interrupted atomic staging', async t => {
  const workerPid = exitedPid();
  for (const changed of [true, false]) {
    const f = await recoveryFixture(t, workerPid, changed), temporary = f.path + '.hmr-' + f.lock.attempt;
    await writeFile(temporary, fixedHmrEdit(original).subarray(0, 23), {mode: 0o640}); await chmod(temporary, 0o640);
    const result = await recoverHmrSource(f);
    assert.equal(result.restored, true); assert.equal(result.needed, true);
    assert.deepEqual(await readFile(f.path), original); assert.equal((await lstat(f.path)).mode & 0o777, 0o640);
    await assert.rejects(readFile(temporary), {code: 'ENOENT'}); await assert.rejects(readFile(join(f.stateDirectory, 'bridge.lock')), {code: 'ENOENT'});
    assert.equal(JSON.parse(await readFile(result.receipt.path, 'utf8')).restored, true);
    assert.equal((await recoverHmrSource(f)).needed, false);
  }
});

test('recovery refuses live or foreign workers, tampered backup, third-party source and unknown staging bytes', async t => {
  const live = await recoveryFixture(t, process.pid); await assert.rejects(recoverHmrSource(live), /live owner/);
  const workerPid = exitedPid();
  const foreign = await recoveryFixture(t, workerPid); await assert.rejects(recoverHmrSource({...foreign, workerPid: process.pid}), /exact worker and output/);
  const backup = await recoveryFixture(t, workerPid); await writeFile(backup.lock.backup, Buffer.concat([original, Buffer.from('tampered')])); await assert.rejects(recoverHmrSource(backup), /sealed source/);
  const source = await recoveryFixture(t, workerPid); await writeFile(source.path, 'third-party edit'); await assert.rejects(recoverHmrSource(source), /unexpected source edit/); assert.equal(await readFile(source.path, 'utf8'), 'third-party edit');
  const staging = await recoveryFixture(t, workerPid), temporary = staging.path + '.hmr-' + staging.lock.attempt;
  await writeFile(temporary, 'unknown bytes', {mode: 0o640}); await chmod(temporary, 0o640);
  await assert.rejects(recoverHmrSource(staging), /unexpected atomic staging bytes/); assert.equal(await readFile(temporary, 'utf8'), 'unknown bytes');
  for (const f of [live, foreign, backup, source, staging]) assert.equal(JSON.parse(await readFile(join(f.stateDirectory, 'bridge.lock'), 'utf8')).kind, 'owned-hmr-edit-1');
});

test('state tampering, stale source seals and symlinked source inputs are rejected', async t => {
  const stale = await fixture(t); await writeFile(stale.path, original.toString().replace('html', 'other'));
  await assert.rejects(ownHmrSource(stale), /sealed product source/);
  const tampered = await fixture(t), statePath = join(tampered.stateDirectory, 'bridge-state.json');
  const envelope = JSON.parse(await readFile(statePath, 'utf8')); envelope.state.sourceDigest = 'changed'; await writeFile(statePath, json(envelope));
  await assert.rejects(ownHmrSource(tampered), /state seal mismatch/);
  const linked = await fixture(t), outside = join(linked.directory, 'outside.ts'); await writeFile(outside, original); await rm(linked.path); await symlink(outside, linked.path);
  await assert.rejects(ownHmrSource(linked), /canonical nonsymlink/);
  assert.deepEqual(await readFile(outside), original);
});

test('visible HMR requires unchanged public document, same shell and canvas, and no navigation', () => {
  const before = baseline(), after = {...before, wordmark: 'Editor updated'};
  assert.deepEqual(hotUpdateWitness(before, after), {reload: false, documentPreserved: true, shellPreserved: true, canvasPreserved: true, correctVisibleUpdate: true});
  for (const change of [{timeOrigin: 2000}, {navigationCount: 2}, {mainFrameNavigations: 2}, {shellConnected: false}, {canvasConnected: false}, {documentSha256: 'sha256:' + 'e'.repeat(64)}, {documentId: 'other'}, {revision: '8'}, {visibleDocumentSha256: 'sha256:' + 'e'.repeat(64)}, {uiSha256: 'sha256:' + 'e'.repeat(64)}, {wordmark: 'Editor'}]) assert.throws(() => hotUpdateWitness(before, {...after, ...change}), /reloaded|replaced|visibly applied/);
  // A correctness witness deliberately contains no fabricated presentation
  // timestamp or physical trace classification.
  const result = hotUpdateWitness(before, after);
  assert.equal(result.presentedMs, undefined); assert.equal(result.trace, undefined);
  assert.throws(() => hotUpdateWitness(before, {...after, mainFrameNavigations: 2}), error => { assert.equal(error.hmrWitness.reload, true); assert.deepEqual(error.hmrWitness.before, before); return true; });
  assert.throws(() => hotUpdateWitness(before, {...after, shellConnected: false}), error => { assert.equal(error.hmrWitness.documentPreserved, false); assert.equal(error.hmrWitness.shellPreserved, false); return true; });
});

test('missing or malformed public witness fields cannot compare equal into preservation', () => {
  const before = baseline(), after = {...before, wordmark: 'Editor updated'};
  for (const key of Object.keys(before)) {
    const left = {...before}, right = {...after}; delete left[key]; delete right[key];
    assert.throws(() => hotUpdateWitness(left, right), /Incomplete public HMR/);
  }
  for (const change of [{timeOrigin: NaN}, {navigationCount: -1}, {mainFrameNavigations: 1.1}, {documentId: ''}, {revision: ''}, {documentSha256: 'unsealed'}, {shellConnected: 'true'}, {wordmark: null}]) assert.throws(() => hotUpdateWitness(before, {...after, ...change}), /Incomplete public HMR/);
  assert.equal(hotUpdateWitness(before, {...before}, {restored: true}).documentPreserved, true);
});
