import {fork, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {cp, lstat, mkdir, open, readFile, realpath, rename, unlink} from 'node:fs/promises';
import {isAbsolute, join, resolve, sep} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createBrowserTrace} from './browser-trace.mjs';
import {bracketTraceAction} from './browser-presentation.mjs';
import {prepareHmrWindowServer, hmrWindowServerCeilingObserved} from './windowserver-hmr.mjs';
import {openDocument, publicRead, ready} from './browser-driver.mjs';
import {exclusiveJSON, fileIdentity, intervalWait, monotonic, PrerequisiteError, sanitize} from './common.mjs';
import {browserCacheIdentity} from '../developer-campaigns/verify-browsers.mjs';

const executeFile = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const sourcePath = 'src/ui/shell-wordmark.ts';
const originalLine = "export const SHELL_WORDMARK = 'Editor';";
const changedLine = "export const SHELL_WORDMARK = 'Editor updated';";
const missingPresentation = 'No validated physical-display presentation and save-clock join; visible DOM updates and renderer Paint/DrawFrame are diagnostic only';

export function fixedHmrEdit(bytes) {
  const text = bytes.toString('utf8');
  if (text.split(originalLine).length !== 2 || text.includes(changedLine) || !Buffer.from(text).equals(bytes)) throw Error('The fixed shell component edit needs one exact UTF-8 source anchor');
  return Buffer.from(text.replace(originalLine, changedLine));
}

async function ordinary(path, maximum = 4 * 1024 * 1024) {
  if (await realpath(path) !== path) throw Error('HMR input must have a canonical nonsymlink path');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maximum) throw Error('HMR input is not a bounded ordinary file');
    const bytes = await handle.readFile(), after = await handle.stat(), named = await lstat(path);
    if (!named.isFile() || named.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length !== before.size || named.dev !== after.dev || named.ino !== after.ino || named.mode !== after.mode || named.size !== after.size || named.mtimeMs !== after.mtimeMs || named.ctimeMs !== after.ctimeMs) throw Error('HMR input changed while being read');
    return {bytes, mode: before.mode & 0o777, sha256: hash(bytes), stat: {dev: named.dev, ino: named.ino, mode: named.mode, size: named.size, mtimeMs: named.mtimeMs, ctimeMs: named.ctimeMs}};
  } finally { await handle.close(); }
}

async function ownershipPaths({repo, subjectRepo, output, configuration = {}}) {
  const directory = configuration.developerStateDirectory;
  if (!isAbsolute(directory ?? '') || resolve(directory) !== directory || await realpath(directory) !== directory) throw new PrerequisiteError('HMR requires the canonical owned developer state directory');
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || process.getuid && info.uid !== process.getuid()) throw Error('HMR developer state must be an owner-only directory');
  if (!isAbsolute(repo) || await realpath(repo) !== repo || !isAbsolute(output) || await realpath(output) !== output) throw Error('HMR source and output must be canonical absolute paths');
  if (!isAbsolute(subjectRepo ?? '') || await realpath(subjectRepo) !== subjectRepo || subjectRepo === repo || repo.startsWith(subjectRepo + sep)) throw new PrerequisiteError('HMR requires a separate canonical subject checkout and owned prepared product');
  return directory;
}

async function ownedWorkspace(directory, repo) {
  const sealed = await ordinary(join(directory, 'bridge-state.json'), 128 * 1024 * 1024);
  const envelope = JSON.parse(sealed.bytes), state = envelope.state;
  if (envelope.kind !== 'developer-runtime-state-1' || envelope.sha256 !== hash(json(state))) throw Error('HMR developer state seal mismatch');
  const workspace = state.h?.source === repo ? state.h : state.p;
  const completed = workspace === state.h ? workspace?.completed === true && !workspace.failure && !workspace.active : workspace?.completed?.includes('production-build') && !workspace.failure && !workspace.active;
  if (!completed || workspace.source !== repo || !isAbsolute(workspace.workspace ?? '') || join(workspace.workspace, 'source') !== repo || state.productRepo !== repo || !state.sourceDigest || !state.buildProvenancePath) throw new PrerequisiteError('HMR needs a completed prepared product source, not a live checkout or failed preparation');
  const owned = await lstat(workspace.workspace);
  if (!owned.isDirectory() || owned.isSymbolicLink() || await realpath(workspace.workspace) !== workspace.workspace || (owned.mode & 0o077) !== 0 || process.getuid && owned.uid !== process.getuid()) throw Error('HMR workspace must be a canonical owner-only directory');
  return {sealed, state, workspace};
}

async function replaceSource(path, bytes, mode, suffix, expected) {
  const temporary = path + '.hmr-' + suffix;
  const handle = await open(temporary, 'wx', mode);
  try {
    try { await handle.writeFile(bytes); await handle.chmod(mode); await handle.sync(); }
    finally { await handle.close(); }
    const current = await lstat(path);
    if (!expected || !current.isFile() || current.isSymbolicLink() || Object.keys(expected).some(key => current[key] !== expected[key])) throw Error('HMR source pathname changed while staging the atomic edit');
    await rename(temporary, path);
  }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

/** Edits only the completed, sealed developer workspace, never the subject
 * checkout. A killed attempt retains its lock and original bytes for recovery. */
export async function ownHmrSource(options) {
  const {repo, subjectRepo, output} = options, directory = await ownershipPaths(options);
  // Share the developer adapter's ownership lock so HMR cannot overlap C/H
  // preparation or another runtime editor using this same prepared source.
  const lockPath = join(directory, 'bridge.lock');
  const lock = await open(lockPath, 'wx', 0o600);
  let original, changed, lockDigest, edited = false, closed = false, poisoned = false;
  const path = join(repo, sourcePath), attempt = randomUUID();
  async function current() { return ordinary(path); }
  async function replace(bytes, before) { return replaceSource(path, bytes, original.mode, attempt, before.stat); }
  async function restore() {
    if (!original) return;
    const before = await current();
    if (before.mode !== original.mode || before.sha256 !== original.sha256 && before.sha256 !== hash(changed)) { poisoned = true; throw Error('Unexpected concurrent source edit; HMR original retained without overwriting another edit'); }
    if (before.sha256 !== original.sha256 || before.mode !== original.mode) await replace(original.bytes, before);
    const after = await current();
    if (!after.bytes.equals(original.bytes) || after.mode !== original.mode) { poisoned = true; throw Error('HMR source restoration failed'); }
    edited = false;
    return {path: sourcePath, bytes: original.bytes.length, sha256: 'sha256:' + after.sha256, mode: after.mode, restored: true};
  }
  try {
    const {sealed, state, workspace} = await ownedWorkspace(directory, repo);
    original = await current(); changed = fixedHmrEdit(original.bytes);
    const expected = state.source?.files?.filter(file => file.path === sourcePath);
    if (expected?.length !== 1 || expected[0].sha256 !== original.sha256 || expected[0].bytes !== original.bytes.length || expected[0].mode !== original.mode) throw Error('HMR component does not match the sealed product source');
    const backup = join(output, 'hmr-original-' + attempt + '.ts');
    const saved = await open(backup, 'wx', 0o600);
    try { await saved.writeFile(original.bytes); await saved.sync(); } finally { await saved.close(); }
    const lockBytes = json({kind: 'owned-hmr-edit-1', ownerPid: process.pid, attempt, repo, subjectRepo, output, sourcePath, backup, originalSha256: original.sha256, originalMode: original.mode, originalBytes: original.bytes.length, changedSha256: hash(changed), stateSha256: sealed.sha256});
    lockDigest = hash(lockBytes); await lock.writeFile(lockBytes); await lock.sync();
    return {
      identity: {sourcePath, original: {bytes: original.bytes.length, sha256: 'sha256:' + original.sha256, mode: original.mode}, changed: {bytes: changed.length, sha256: 'sha256:' + hash(changed)}, developerState: {path: join(directory, 'bridge-state.json'), sha256: 'sha256:' + sealed.sha256}, browserCache: {path: workspace.browserCache, sha256: workspace.browserIdentity?.cache?.sha256 ?? null, engines: workspace.browserIdentity?.engines ?? []}},
      async save(signal) {
        if (closed || poisoned || edited) throw Error('HMR source edit owner is not ready'); signal?.throwIfAborted();
        const before = await current();
        if (!before.bytes.equals(original.bytes) || before.mode !== original.mode) throw Error('HMR source changed before the fixed edit');
        const startMs = monotonic(); edited = true;
        await replace(changed, before);
        const savedMs = monotonic(); signal?.throwIfAborted();
        return {startMs, savedMs, clock: 'runner-monotonic', definition: 'atomic rename of fsynced exact fixed component edit'};
      },
      restore,
      async close() { if (closed) return; closed = true; try { await restore(); } catch (error) { poisoned = true; throw error; } finally { await lock.close(); if (!poisoned) { if ((await ordinary(lockPath)).sha256 !== lockDigest) throw Error('HMR ownership lock changed before close'); await unlink(lockPath); } } },
    };
  } catch (error) { await lock.close(); await unlink(lockPath); throw error; }
}

/** Parent-only recovery after the exact worker has exited and all its owned
 * children are closed. No directory scan, stale-lock stealing or arbitrary
 * backup restore: both paths and bytes must match this worker's sealed edit. */
export async function recoverHmrSource(options) {
  const {repo, subjectRepo, output, workerPid} = options, directory = await ownershipPaths(options);
  if (!Number.isSafeInteger(workerPid) || workerPid <= 0) throw Error('HMR recovery requires the exact exited worker PID');
  const lockPath = join(directory, 'bridge.lock');
  let locked;
  try { locked = await ordinary(lockPath); } catch (error) { if (error.code === 'ENOENT') return {kind: 'hmr-source-recovery-1', needed: false}; throw error; }
  const lock = JSON.parse(locked.bytes);
  if (locked.mode !== 0o600 || lock.kind !== 'owned-hmr-edit-1' || lock.ownerPid !== workerPid || lock.repo !== repo || lock.subjectRepo !== subjectRepo || lock.output !== output || lock.sourcePath !== sourcePath || !/^[a-f0-9-]{36}$/.test(lock.attempt ?? '') || lock.backup !== join(output, 'hmr-original-' + lock.attempt + '.ts')) throw Error('HMR recovery lock does not belong to this exact worker and output');
  try { process.kill(workerPid, 0); throw Error('HMR recovery refuses a live owner'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  const recoveryPath = join(directory, 'bridge-recovery.lock'), recovery = await open(recoveryPath, 'wx', 0o600);
  try {
    const {sealed, state} = await ownedWorkspace(directory, repo);
    if (sealed.sha256 !== lock.stateSha256 || (await ordinary(lockPath)).sha256 !== locked.sha256) throw Error('HMR recovery ownership changed');
    const backup = await ordinary(lock.backup), changed = fixedHmrEdit(backup.bytes), expected = state.source.files.filter(file => file.path === sourcePath);
    if (backup.mode !== 0o600 || expected.length !== 1 || expected[0].sha256 !== backup.sha256 || expected[0].sha256 !== lock.originalSha256 || expected[0].bytes !== backup.bytes.length || expected[0].bytes !== lock.originalBytes || expected[0].mode !== lock.originalMode || hash(changed) !== lock.changedSha256) throw Error('HMR recovery original does not match the sealed source');
    const path = join(repo, sourcePath), before = await ordinary(path);
    if (before.mode !== lock.originalMode || before.sha256 !== backup.sha256 && before.sha256 !== lock.changedSha256) throw Error('HMR recovery refuses an unexpected source edit');
    // A kill before rename can retain only this exact attempt's staging file.
    // Its bytes must be a prefix of one of the two authorized source versions.
    const temporaryPath = path + '.hmr-' + lock.attempt;
    let temporary;
    try { temporary = await ordinary(temporaryPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (temporary) {
      if (temporary.mode !== lock.originalMode || ![backup.bytes, changed].some(bytes => temporary.bytes.length <= bytes.length && bytes.subarray(0, temporary.bytes.length).equals(temporary.bytes))) throw Error('HMR recovery refuses unexpected atomic staging bytes');
      await unlink(temporaryPath);
    }
    if (before.sha256 !== backup.sha256) await replaceSource(path, backup.bytes, lock.originalMode, 'recovery-' + randomUUID(), before.stat);
    const after = await ordinary(path);
    if (after.sha256 !== backup.sha256 || after.mode !== lock.originalMode || (await ordinary(lockPath)).sha256 !== locked.sha256 || (await ordinary(join(directory, 'bridge-state.json'), 128 * 1024 * 1024)).sha256 !== sealed.sha256) throw Error('HMR recovery verification failed');
    const receipt = {kind: 'hmr-source-recovery-1', needed: true, workerPid, output, sourcePath, originalSha256: 'sha256:' + backup.sha256, beforeSha256: 'sha256:' + before.sha256, restored: true, mode: after.mode, stateSha256: 'sha256:' + sealed.sha256,
      staging: temporary ? {path: sourcePath + '.hmr-' + lock.attempt, bytes: temporary.bytes.length, sha256: 'sha256:' + temporary.sha256, mode: temporary.mode, removed: true} : null, recoveredAt: new Date().toISOString()};
    const pathReceipt = join(output, 'hmr-source-recovery-' + randomUUID() + '.json'); await exclusiveJSON(pathReceipt, receipt);
    if ((await ordinary(lockPath)).sha256 !== locked.sha256) throw Error('HMR recovery ownership changed before lock release');
    await unlink(lockPath);
    return {...receipt, receipt: {path: pathReceipt, ...await fileIdentity(pathReceipt)}};
  } finally { await recovery.close(); await unlink(recoveryPath); }
}

function abortable(action, signal) {
  if (!signal) return Promise.resolve().then(action);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancelled = () => { cleanup(); reject(signal.reason ?? Error('HMR interrupted')); };
    const cleanup = () => signal.removeEventListener('abort', cancelled);
    signal.addEventListener('abort', cancelled, {once: true});
    Promise.resolve().then(() => { signal.throwIfAborted(); return action(); }).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

/** Validation is deliberately independent of the presentation clock. */
export function hotUpdateWitness(before, after, {restored = false} = {}) {
  for (const value of [before, after]) {
    if (!value || !Number.isFinite(value.timeOrigin) || value.timeOrigin <= 0 || !Number.isSafeInteger(value.navigationCount) || value.navigationCount < 1 || !Number.isSafeInteger(value.mainFrameNavigations) || value.mainFrameNavigations < 1 ||
      typeof value.documentId !== 'string' || !value.documentId || !(typeof value.revision === 'string' && value.revision || typeof value.revision === 'number' && Number.isFinite(value.revision) && value.revision >= 0) ||
      !['documentSha256', 'visibleDocumentSha256', 'uiSha256'].every(key => /^sha256:[a-f0-9]{64}$/.test(value[key] ?? '')) ||
      typeof value.shellConnected !== 'boolean' || typeof value.canvasConnected !== 'boolean' || typeof value.wordmark !== 'string') throw Error('Incomplete public HMR preservation witness');
  }
  if (!before.shellConnected || !before.canvasConnected || before.wordmark !== 'Editor') throw Error('Incomplete public HMR baseline');
  const reload = before.timeOrigin !== after.timeOrigin || before.navigationCount !== after.navigationCount || after.mainFrameNavigations !== before.mainFrameNavigations;
  const documentPreserved = after.shellConnected === true && after.canvasConnected === true && before.documentSha256 === after.documentSha256 && before.documentId === after.documentId && before.revision === after.revision && before.visibleDocumentSha256 === after.visibleDocumentSha256 && before.uiSha256 === after.uiSha256;
  if (reload || !documentPreserved || after.wordmark !== (restored ? 'Editor' : 'Editor updated')) {
    const error = Error(reload ? 'Hot update reloaded the document' : !documentPreserved ? 'Hot update replaced the shell or changed the open document' : 'Fixed source edit was not visibly applied');
    error.hmrWitness = {reload, documentPreserved, shellPreserved: after.shellConnected, canvasPreserved: after.canvasConnected, correctVisibleUpdate: !restored && after.wordmark === 'Editor updated', before, after};
    throw error;
  }
  return {reload, documentPreserved, shellPreserved: true, canvasPreserved: true, correctVisibleUpdate: !restored};
}

export async function withHmrEdit(owner, action, signal) {
  let saved, value, failure, restoration;
  const errorObject = error => error instanceof Error ? error : new Error(String(error), {cause: error});
  // Always drain the small atomic save itself. Browser observation waits can be
  // abandoned immediately, which enters restoration before the parent's kill
  // deadline even if a Playwright response is stalled.
  try { saved = await owner.save(signal); value = await abortable(() => action(saved), signal); signal?.throwIfAborted(); }
  catch (error) { failure = errorObject(error); }
  finally { try { restoration = await owner.restore(); } catch (error) { failure = failure ? new AggregateError([failure, errorObject(error)], 'HMR action and restoration failed') : errorObject(error); } }
  if (failure) { failure.hmr = {saved, value: value ?? failure.hmrWitness, restoration}; throw failure; }
  return {saved, value, restoration};
}

async function boundedClose(work) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('HMR owned close deadline')), 15000); })]); }
  finally { clearTimeout(timer); }
}

/** D05 uses a real Vite server attached to the real paired local backend. The
 * first actual update is retained separately; every scored edit restores source
 * before returning to the runner's source-after identity check. */
export async function createBrowserHmrCampaign(context = {}) {
  const repo = resolve(context.repo ?? process.cwd()), output = resolve(context.output ?? join(repo, 'artifacts/hmr-' + randomUUID()));
  const signal = context.signal, configuration = context.configuration ?? {}, browserOptions = configuration.browser ?? {};
  await mkdir(output, {recursive: true, mode: 0o700});
  let source, server, browserServer, browser, browserContext, page, shell, canvas, root, runtime, preparedCell, prepared = false, closed = false, failed = false, serial = 0, active, nativePresentation;
  let mainFrameNavigations = 0;
  const errors = [], external = [], firstUpdate = [];
  function assertCell(cell) {
    if (cell.operation !== 'developer.hot-update' || cell.workload !== 'W1' || cell.parameters?.fixedEdit !== 'shell-component' || cell.parameters?.devServerWarm !== true) throw new PrerequisiteError('D05 requires the fixed W1 shell component edit and warm development server');
    if (closed || failed) throw Error('HMR campaign is closed or failed'); signal?.throwIfAborted();
  }
  async function registerProcess(kind, pid, executable) {
    const row = (await executeFile('/bin/ps', ['-p', String(pid), '-o', 'pgid=,lstart='], {timeout: 5000})).stdout.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if (!row) throw Error('HMR process birth identity unavailable');
    const started = (await executeFile('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {timeout: 5000})).stdout.trim();
    await exclusiveJSON(join(output, 'owned-process-' + pid + '-' + randomUUID() + '.json'), {kind: 'perf-owned-processes-1', ownerPid: process.pid, processes: [{kind, pid, pgid: Number(row[1]), startedAtIdentity: started, executable}]});
  }
  async function wordmark(text) { await page.locator('.wordmark-secondary').filter({hasText: new RegExp('^' + text + '$')}).waitFor({state: 'visible'}); }
  async function witness() {
    const document = (await publicRead(page, '/api/v1/documents/' + context.fixture.documentId)).projection.value;
    if (document.id !== context.fixture.documentId) throw Error('Public HMR document witness differs from the sealed fixture');
    const view = await page.evaluate(() => ({timeOrigin: performance.timeOrigin, navigationCount: performance.getEntriesByType('navigation').length}));
    // Public DOM/control values are hashed immediately; prompts and document
    // labels never enter metadata receipts. This catches a view/draft reset even
    // when the immutable backend document itself has not changed.
    const ui = {canvas: await canvas.evaluate(node => ({asset: node.getAttribute('data-asset'), width: node.width, height: node.height, transform: node.style.transform})),
      selected: await page.getByRole('treeitem', {selected: true}).evaluateAll(nodes => nodes.map(node => ({id: node.id, text: node.textContent}))),
      tools: await page.getByRole('toolbar', {name: 'Canvas tools', exact: true}).getByRole('button', {pressed: true}).allTextContents(),
      fields: await page.locator('input, textarea, [role="spinbutton"]').evaluateAll(nodes => nodes.map(node => ({id: node.id, label: node.getAttribute('aria-label'), value: node.value ?? node.getAttribute('aria-valuenow')})))};
    if (ui.tools.length !== 1) throw Error('HMR public active canvas tool is unavailable');
    return {...view, mainFrameNavigations, documentId: context.fixture.documentId, revision: document.revision, documentSha256: 'sha256:' + hash(JSON.stringify(document)), uiSha256: 'sha256:' + hash(JSON.stringify(ui)),
      visibleDocumentSha256: 'sha256:' + hash(await page.locator('.document-name').innerText()), wordmark: await page.locator('.wordmark-secondary').innerText(),
      shellConnected: await shell.evaluate(node => node.isConnected), canvasConnected: await canvas.evaluate(node => node.isConnected)};
  }
  async function transaction(sample, first = false) {
    const index = ++serial, before = await witness(), startMs = monotonic(), errorStart = errors.length, externalStart = external.length;
    const tracer = createBrowserTrace(page, {artifactDirectory: output, artifactName: 'hmr-trace-' + index + '.json'});
    await tracer.start(); let observed, failure, traced, nativeCapture, nativeObservation;
    try {
      if (nativePresentation) nativeCapture = await nativePresentation.begin('hmr-' + index);
      await page.evaluate(id => performance.mark('ie.perf.v1:intent:' + id), index);
      const clockedSource = {...source, async save(signal) {
        const clockPage = {evaluate: (...args) => abortable(() => page.evaluate(...args), signal)};
        const {value, bracket} = await bracketTraceAction({page: clockPage, id: index, run: () => nativeCapture ? nativeCapture.save(() => source.save(signal)) : source.save(signal)});
        return {...value, presentationBracket: bracket};
      }};
      observed = await withHmrEdit(clockedSource, async saved => {
        await wordmark('Editor updated'); const domObservedMs = monotonic();
        await page.evaluate(id => performance.mark('ie.perf.v1:complete:' + id), index);
        const after = await witness();
        // Native pixels must be observed before withHmrEdit restores the edit.
        // Instrument loss stays separate from the product preservation witness.
        if (nativeCapture) await nativeCapture.observeUpdated(saved);
        return {savedMs: saved.savedMs, domObservedMs, ...hotUpdateWitness(before, after), before, after};
      }, signal);
      await wordmark('Editor');
      const restored = await witness();
      hotUpdateWitness(before, restored, {restored: true});
      observed.value.restoredAfter = restored;
      if (errors.length !== errorStart || external.length !== externalStart) throw Error('HMR attempted external traffic or raised a browser error');
      signal?.throwIfAborted();
    } catch (error) { failure = error; failed = true; observed ??= error.hmr; if (error.hmrWitness) observed = {...observed, value: {...observed?.value, ...error.hmrWitness}}; }
    finally {
      try { if (nativeCapture) nativeObservation = await nativeCapture.finish(); }
      finally { traced = await tracer.stop({presentation: {requests: observed?.saved?.presentationBracket ? [{id: index, start: {kind: 'bracketed-save', bracket: observed.saved.presentationBracket}}] : [], runtime}}); }
    }
    const endMs = monotonic();
    const boundedPresentation = !failure && !runtime.headless && hmrWindowServerCeilingObserved(nativeObservation);
    const operationalStatus = failure ? 'FAIL' : boundedPresentation ? 'PASS' : 'INCONCLUSIVE';
    const result = {status: operationalStatus, operation: 'developer.hot-update', phases: [{name: 'developer.hot-update-transaction', startMs, endMs, durationMs: endMs - startMs, clock: 'runner-monotonic', scope: 'actual fixed edit, diagnostic DOM observation, preservation verification and source restoration; not D05 presentation latency'}],
      observations: {kind: 'actual-vite-hmr-1', id: 'hmr-' + index, cache: sample.cache, ordinal: sample.ordinal, prime: Boolean(sample.prime), firstUpdate: first, scored: !first && !sample.prime,
        ...observed?.value, saved: observed?.saved, restoration: observed?.restoration, windowServerPresentation: nativeObservation ?? null, presentedMs: null, outcome: operationalStatus,
        trace: {kind: 'browser-metadata-trace', ...traced.artifact, attributionComplete: false}, failure: failure ? {name: failure.name, message: String(failure.message).slice(0, 2048)} : null},
      assertions: failure ? [{id: 'real-hmr-preserves-document-without-reload', passed: false}] : [{id: 'real-hmr-preserves-document-without-reload', passed: true}],
      missing: [...(boundedPresentation ? [] : [missingPresentation]), ...(runtime.headless ? ['Headless browser cannot establish the H display environment'] : [])], evidence: {source: source.identity, runtime, trace: traced, firstUpdate: firstUpdate[0] ?? null}, qualification: false};
    result.hotEdit = {id: 'hmr-' + index, savedMs: observed?.saved?.savedMs ?? null, presentedMs: null,
      documentPreserved: observed?.value?.documentPreserved ?? null, reload: observed?.value?.reload ?? null,
      trace: result.observations.trace, windowServerPresentation: nativeObservation ?? null, outcome: failure ? 'unexpected' : 'expected'};
    const receiptPath = join(output, 'hmr-update-' + index + '.json'); await exclusiveJSON(receiptPath, sanitize(result));
    result.evidence.receipt = {path: receiptPath, ...await fileIdentity(receiptPath)};
    signal?.throwIfAborted(); return result;
  }
  async function prepareCell(cell) {
    assertCell(cell);
    if (prepared) { if (preparedCell.id !== cell.id) throw Error('HMR owner cannot switch cells'); return {reused: true, runtime}; }
    source = await ownHmrSource({repo, subjectRepo: context.subjectRepo, output, configuration});
    try {
      const fixture = context.fixture;
      if (!fixture?.root || !fixture.seal || !fixture.documentId) throw new PrerequisiteError('HMR needs the sealed W1 durable document fixture');
      const {verifyFixtureManifest} = await import('./fixtures.mjs'); await verifyFixtureManifest(fixture);
      root = join(output, 'hmr-private-' + randomUUID()); await cp(fixture.root, root, {recursive: true, errorOnExist: true, force: false, preserveTimestamps: true});
      const {ownServerProcess} = await import(pathToFileURL(join(repo, 'tests/editor/completion/owned-process.mjs')).href);
      const child = fork(new URL('./browser-hmr-process.mjs', import.meta.url), [root, repo], {cwd: repo, execPath: process.execPath,
        execArgv: ['--import', join(repo, 'tests/session/no-egress.mjs')], env: {PATH: process.env.PATH, TMPDIR: process.env.TMPDIR}, stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
      const owned = ownServerProcess(child); owned.catch(() => {});
      try { await registerProcess('backend', child.pid, process.execPath); } catch (error) { child.kill('SIGTERM'); await owned.catch(() => {}); throw error; }
      server = await owned;
      const development = server.lifecycle.messages.find(message => message.type === 'ready');
      if (development.kind !== 'vite-development-server-1' || development.sourceRoot !== repo || !development.viteVersion) throw Error('HMR child did not establish an actual Vite source server');
      const cache = source.identity.browserCache;
      if (!context.browserCache || context.browserCache !== cache.path || process.env.PLAYWRIGHT_BROWSERS_PATH !== cache.path || !cache.sha256 || await realpath(cache.path) !== cache.path) throw new PrerequisiteError('HMR requires the explicit sealed prepared browser cache in its worker environment');
      const cacheBefore = await browserCacheIdentity(cache.path);
      if (cacheBefore.sha256 !== cache.sha256) throw Error('HMR browser distribution differs from prepared cache');
      const require = createRequire(join(repo, 'package.json')), playwright = await import(pathToFileURL(require.resolve('playwright')).href);
      const name = cell.parameters.browser ?? browserOptions.engine ?? 'chromium';
      if (!['chromium', 'firefox', 'webkit'].includes(name)) throw Error('Unsupported HMR browser');
      const headless = context.headless ?? browserOptions.headless ?? false;
      const executableIdentity = await fileIdentity(playwright[name].executablePath());
      if (!cache.engines.some(engine => engine.engine === name && 'sha256:' + engine.sha256 === executableIdentity.sha256)) throw Error('HMR executable differs from the prepared browser identity');
      browserServer = await playwright[name].launchServer({headless, executablePath: playwright[name].executablePath(), timeout: 30000});
      await registerProcess('browser', browserServer.process().pid, playwright[name].executablePath());
      browser = await playwright[name].connect(browserServer.wsEndpoint());
      const pin = JSON.parse(await readFile(join(repo, 'node_modules/playwright-core/browsers.json'), 'utf8')).browsers.find(entry => entry.name === name);
      if (!pin || browser.version() !== pin.browserVersion) throw new PrerequisiteError('HMR browser differs from the sealed Playwright pin');
      browserContext = await browser.newContext({viewport: {width: 1440, height: 900}, deviceScaleFactor: 2, colorScheme: 'light', reducedMotion: 'no-preference'});
      browserContext.setDefaultTimeout(10000); browserContext.setDefaultNavigationTimeout(15000);
      await browserContext.route('**/*', route => { const target = new URL(route.request().url()); if (['http:', 'https:'].includes(target.protocol) && target.origin !== server.origin) { external.push({ordinal: external.length + 1, kind: 'http'}); return route.abort('blockedbyclient'); } return route.continue(); });
      await browserContext.routeWebSocket('**/*', socket => { const target = new URL(socket.url()), allowed = new URL(server.origin); allowed.protocol = 'ws:'; if (target.origin !== allowed.origin || target.pathname !== '/__ideogram_hmr') { external.push({ordinal: external.length + 1, kind: 'websocket'}); socket.close(); } else socket.connectToServer(); });
      page = await browserContext.newPage(); page.on('pageerror', () => errors.push({ordinal: errors.length + 1}));
      page.on('framenavigated', frame => { if (frame === page.mainFrame()) mainFrameNavigations++; });
      await page.goto(await server.pair()); await ready(page); await openDocument(page, fixture); await wordmark('Editor');
      shell = await page.locator('ie-shell').elementHandle(); canvas = await page.locator('canvas[aria-label="Document raster preview"]').elementHandle();
      if (!shell || !canvas || errors.length || external.length) throw Error('HMR baseline failed to open its real document');
      const document = (await publicRead(page, '/api/v1/documents/' + fixture.documentId)).projection.value;
      if (document.image?.compositeAssetId) await page.waitForFunction(([node, asset]) => node.getAttribute('data-asset') === asset, [canvas, document.image.compositeAssetId]);
      // This is a baseline stability check, never a claimed presentation clock.
      let previous, stable = 0; const settleStart = monotonic();
      while (stable < 2) {
        signal?.throwIfAborted(); const value = await witness();
        stable = previous === value.uiSha256 ? stable + 1 : 0; previous = value.uiSha256;
        if (monotonic() - settleStart > 10000) throw Error('HMR public document view did not settle');
        if (stable < 2) await intervalWait(50, signal);
      }
      runtime = {kind: 'vite-development-server-1', viteVersion: development.viteVersion, sourceRoot: repo, viteCacheDirectory: development.cacheDirectory, engine: name, version: browser.version(), revision: pin.revision, executable: playwright[name].executablePath(), executableIdentity, browserCache: {path: cache.path, sha256: 'sha256:' + cacheBefore.sha256}, backendPid: child.pid, browserPid: browserServer.process().pid, headless, viewport: {width: 1440, height: 900}, deviceScaleFactor: 2, fixtureSeal: fixture.seal, root};
      await exclusiveJSON(join(output, 'hmr-runtime.json'), runtime);
      try { nativePresentation = await prepareHmrWindowServer({configuration, runtime, sourceIdentity: source.identity, output, signal}); }
      catch (error) { throw new PrerequisiteError('Native HMR inputs are unavailable: ' + String(error.message).slice(0, 1024)); }
      prepared = true; preparedCell = cell;
      const first = await transaction({cache: 'first-update', ordinal: 1, prime: true}, true); firstUpdate.push(first.evidence.receipt);
      if (first.status === 'FAIL') throw Error('First actual Vite HMR update failed');
      return {runtime, firstUpdate: firstUpdate[0], warmDevelopmentServer: true};
    } catch (error) { failed = true; try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'HMR preparation and cleanup failed'); } throw error; }
  }
  async function resetCell(cell, sample = {}) {
    assertCell(cell); if (!prepared) await prepareCell(cell);
    if (sample.cache === 'cold' && serial > 1) throw new PrerequisiteError('A cold HMR start requires its own browser/server worker; changing cache labels is not a reset');
    await source.restore(); await wordmark('Editor');
    return {status: 'PASS', warmDevelopmentServer: true, cache: sample.cache, firstUpdate: firstUpdate[0], sourceRestored: true, document: await witness()};
  }
  async function execute(cell, sample = {}) {
    assertCell(cell); if (!prepared) throw Error('Prepare the actual development server before measuring HMR');
    if (active) throw Error('Only one HMR edit may run at a time');
    active = transaction(sample); try { return await active; } finally { active = null; }
  }
  async function close() {
    if (closed) return; closed = true;
    if (active) await active.catch(() => {});
    const failures = []; let sourceRestored = !source;
    // Restore even if the page or child crashed. No browser acknowledgement is
    // needed to establish the exact source-after byte identity.
    try { if (source) sourceRestored = (await source.restore()).restored === true; } catch (error) { failures.push(error); }
    for (const work of [() => browserContext?.close(), () => browser?.close(), () => browserServer?.close(), () => server?.close()]) try { await boundedClose(work); } catch (error) { failures.push(error); }
    if (failures.length && browserServer) try { await boundedClose(() => browserServer.kill()); } catch (error) { failures.push(error); }
    if (runtime) try { if ((await browserCacheIdentity(source.identity.browserCache.path)).sha256 !== source.identity.browserCache.sha256) throw Error('HMR browser distribution changed during execution'); } catch (error) { failures.push(error); }
    try { await source?.close(); } catch (error) { failures.push(error); }
    await exclusiveJSON(join(output, 'hmr-close.json'), {closed: failures.length === 0, sourceRestored, pageErrors: errors.length, externalRequests: external.length, retainedRoot: root ?? null, failureCount: failures.length});
    if (failures.length) throw new AggregateError(failures, 'Owned HMR close failed');
  }
  return {prepareCell, resetCell, execute, close, get fixtureIdentity() { return context.fixture?.seal?.sha256 ?? null; }};
}
