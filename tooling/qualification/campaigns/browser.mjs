import assert from 'node:assert/strict';
import { fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createBrowserTrace } from './browser-trace.mjs';
import { installBrowserVitals } from './browser-vitals.mjs';
import { installCanonicalWebVitals } from './browser-canonical-vitals.mjs';
import { createBrowserResourceSampler } from './browser-resources.mjs';
import { captureRendererOwnershipProof } from './renderer-ownership.mjs';
import { createCachePreservingEgress } from './browser-network.mjs';
import { extractBrowserMeasurements } from './browser-measurements.mjs';
import { createBrowserReadinessController, installRasterCapabilities } from './browser-readiness.mjs';
import { acceptedCommand, browserOperationCoverage, openDocument, publicRead, ready, runBrowserAction, stroke, prepareBrowserGestures, resolveBrowserCandidate, selectVisibleImageLayer } from './browser-driver.mjs';
import { captureBrowserBaseline, resetBrowserCell } from './browser-reset.mjs';
import { intervalWait, monotonic, PrerequisiteError, sanitize, exclusiveJSON, fileIdentity } from './common.mjs';

export { browserOperationCoverage };
const executeFile = promisify(execFile);
const backendOnly = new Set(['raster.composite', 'raster.decode', 'raster.encode', 'state.snapshot-read', 'state.replay', 'state.command-accept-dispatch', 'asset.persist', 'asset.cache-lookup', 'transfer.asset']);
const navigations = new Set(['navigation.ready', 'portable.reopen', 'startup.failure']);
const queueOperations = new Set(['fast.workflow', 'queue.fault', 'queue.healthy-polling']);
const vitalOperations = new Set(['navigation.ready', 'interaction.brush', 'text.interaction']);

async function boundedClose(work, timeoutMs = 5000) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Owned close deadline')), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

export function processTreeRows(text, roots) {
  const rows = text.trim().split('\n').filter(Boolean).map(line => {
    const [pid, ppid, rssKiB] = line.trim().split(/\s+/).map(Number);
    if (![pid, ppid, rssKiB].every(Number.isSafeInteger) || pid <= 0 || ppid < 0 || rssKiB < 0) throw Error('Invalid process resource row');
    return { pid, ppid, rssBytes: rssKiB * 1024 };
  });
  const included = new Set(roots.filter(Number.isSafeInteger));
  for (let changed = true; changed;) { changed = false; for (const row of rows) if (included.has(row.ppid) && !included.has(row.pid)) { included.add(row.pid); changed = true; } }
  return rows.filter(row => included.has(row.pid));
}

export function assertCell(cell) {
  if (!cell || typeof cell.operation !== 'string' || !/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(cell.operation)) throw Error('Explicit campaign operation required');
  const parameters = cell.parameters ?? cell.options ?? cell;
  if (parameters.fakeClock && parameters.fakeClock !== 'scheduler-history-only' || parameters.syntheticTime) throw Error('Browser wall-time cells cannot use synthetic time');
  return parameters;
}

/** Preserve observed action work even when the display trace cannot qualify.
 * Runner dispatch observations are labelled, never joined to browser clocks by
 * subtraction and never promoted to presented-frame timestamps. */
export function interactionSession(cell, sample, result, trace, visibility) {
  if (!['interaction.brush', 'text.interaction'].includes(cell.operation) || !result) return null;
  const observed = result.observations ?? result, text = cell.operation === 'text.interaction';
  const id = String(cell.id ?? cell.operation) + ':' + String(sample.cache ?? 'unknown') + ':' + String(sample.ordinal ?? 0);
  const segment = observed.segment;
  const actions = (observed.actions ?? []).map((action, index) => ({
    id: id + ':action-' + index,
    kind: text ? action.kind : action.kind === 'stroke' ? 'stroke' : 'discrete',
    ...(!text ? { family: action.kind } : {}),
    inputMs: action.inputMs, presentedMs: null, meaningful: action.meaningful ?? true,
    outcome: action.outcome === undefined || action.outcome === 'completed' ? 'expected' : action.outcome,
    ...(action.samples ? { samples: action.samples.map((point, pointIndex) => ({ id: id + ':action-' + index + ':point-' + pointIndex, index: point.index ?? pointIndex, inputMs: point.inputMs, presentedMs: null, outcome: 'expected' })) } : {}),
    ...(action.pointerSchedule ? { pointerSchedule: action.pointerSchedule } : {}),
  }));
  return { id, cache: sample.cache, ordinal: sample.ordinal, cohortKey: cell.id ?? cell.operation,
    startMs: text ? segment?.startMs ?? null : observed.startMs, endMs: text ? segment?.endMs ?? null : observed.endMs,
    captureStoppedMs: text ? segment?.captureStoppedMs ?? null : observed.captureStoppedMs ?? null,
    visibility, refreshHz: null, requestedRefreshHz: 60, actions, activeSegments: [], fallbackSlices: [],
    ...(text ? { textPresentation: observed.textPresentation, compositionEvents: observed.syntheticComposition ? 'synthetic-app-handling' : 'unverified' } : {}),
    trace: { kind: 'browser-diagnostic-trace', sha256: trace?.artifact?.sha256 ?? null, attributionComplete: false, actualPresentation: false },
    clock: observed.clock === 'browser-performance' ? 'browser-performance' : 'runner-monotonic-dispatch-observations',
    ...(observed.clock === 'browser-performance' ? { timeOrigin: observed.timeOrigin, unscoredPreparation: observed.unscoredPreparation } : {}),
    missing: ['Native input event timestamps joined to actual presentation and complete display-slot attribution remain unavailable'],
  };
}

/** Owns the browser and a separate real product backend process. No provider
 * credential enters either child; external HTTP is aborted before navigation.
 * Main runner owns cold/warm process counts and fixed idle/cycle scheduling. */
export async function createBrowserCampaign(context = {}) {
  const repo = resolve(context.repo ?? process.cwd()), output = resolve(context.output ?? join(repo, 'artifacts/browser-campaign-' + randomUUID()));
  const browserOptions = context.configuration?.browser ?? {};
  await mkdir(output, { recursive: true, mode: 0o700 });
  let fixture = context.fixture, browserServer, browser, browserContext, page, server, serverChild, root, backendAdapter, hmrAdapter, d11Collector, egress, lifecycleOracle;
  let prepared = false, closed = false, serial = 0, preparationCell, controls, adapterLibrary, rawVitals, canonicalVitals, canonicalMissing, resourceSampler, rendererOwnershipCapture, gestures, baseline, previousResult, resetMissing = [], readinessController, readinessEvidence, requiredWorkerRestart;
  const resources = [], errors = [], external = [], commandReceipts = [], pendingReplies = new Set();
  const signal = context.signal;

  async function registerProcess(kind, pid, executable) {
    const identity = await executeFile('/bin/ps', ['-p', String(pid), '-o', 'pgid=,lstart='], { timeout: 5000 });
    const row = identity.stdout.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if (!row) throw Error('Owned process birth identity unavailable');
    const started = await executeFile('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { timeout: 5000 });
    await exclusiveJSON(join(output, 'owned-process-' + pid + '-' + randomUUID() + '.json'), { kind: 'perf-owned-processes-1', ownerPid: process.pid, processes: [{ kind, pid, pgid: Number(row[1]), startedAtIdentity: started.stdout.trim(), executable }] });
  }

  async function launch(cell) {
    signal?.throwIfAborted(); const parameters = assertCell(cell); preparationCell = cell;
    if (!fixture?.root || !fixture.seal) throw new PrerequisiteError('Browser campaigns require a sealed durable workload fixture');
    const { verifyFixtureManifest } = await import('./fixtures.mjs'); await verifyFixtureManifest(fixture);
    if (['interaction.brush', 'raster.stroke-finalize', 'lifecycle.editor'].includes(cell.operation)) gestures = await prepareBrowserGestures(fixture);
    // Copy only durable fixture inputs. No node_modules, build output or browser
    // profile is copied, and the original sealed source is never opened writable.
    root = join(output, 'browser-private-' + randomUUID());
    await cp(fixture.root, root, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    if (cell.operation.startsWith('adapter.') || cell.operation === 'fast.workflow' && parameters.caseId === 'WF09') {
      adapterLibrary = fixture.adapterLibrary ?? fixture.adapters?.library;
      if (!adapterLibrary) {
        const { prepareAdapterFixtures, prepareAdapterLibrary } = await import('./adapters.mjs');
        const inputs = await prepareAdapterFixtures(join(output, 'adapter-inputs'), { sizes: [256 * 1024 * 1024], signal });
        const { openWriter } = await import(pathToFileURL(join(repo, 'dist/local/server/storage/writer.js')).href);
        const writer = await openWriter({ root });
        try { await writer.protocolDefaults(); adapterLibrary = await prepareAdapterLibrary(writer, inputs, { repo, root, output, signal, officialPath: fixture.officialAdapterPath }); }
        finally { await writer.close(); }
      }
      fixture = { ...fixture, adapterLibrary };
    }
    const { ownServerProcess } = await import(pathToFileURL(join(repo, 'tests/editor/completion/owned-process.mjs')).href);
    const isQueue = queueOperations.has(cell.operation);
    if (isQueue) {
      const { selectQueueResultFiles } = await import('./browser-queue.mjs');
      const resultFiles = await selectQueueResultFiles(cell, fixture);
      await writeFile(join(root, 'campaign-provider-config.json'), JSON.stringify({ repo, endpoint: cell.operation === 'fast.workflow' ? 'ideogram/v4/fast' : 'ideogram/v4', fixture: { corpus: fixture.corpus }, resultFiles }), { mode: 0o600 });
      await writeFile(join(root, 'campaign-provider-control.json'), JSON.stringify({ sequence: 0, paused: true }), { mode: 0o600 });
      let sequence = 0, current = { paused: true };
      const read = async () => JSON.parse(await readFile(join(root, 'campaign-provider-observation.json'), 'utf8'));
      controls = { read, async set(change) {
        current = { ...current, ...change }; const update = { ...current, sequence: ++sequence }, file = join(root, 'campaign-provider-control.json');
        await writeFile(file + '.tmp', JSON.stringify(update), { mode: 0o600 }); await rename(file + '.tmp', file);
        const start = monotonic();
        for (;;) { signal?.throwIfAborted(); const view = await read(); if (view.failures.length) throw Error('Campaign provider failed'); if (view.controlSequence === sequence) return view; if (monotonic() - start > 10000) throw Error('Provider control acknowledgement deadline'); await intervalWait(25, signal); }
      } };
    }
    const child = fork(new URL('./browser-server-process.mjs', import.meta.url), [root, join(repo, 'dist/app'), repo, isQueue ? new URL('./browser-queue-worker.mjs', import.meta.url).href : ''], {
      cwd: repo, execPath: process.execPath,
      execArgv: ['--import', join(repo, isQueue ? 'tests/provider/no-egress.mjs' : 'tests/protocol/no-effects.mjs')],
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    serverChild = child; child.stderr?.resume();
    const ownedServer = ownServerProcess(child); ownedServer.catch(() => {});
    await registerProcess('backend', child.pid, process.execPath);
    server = await ownedServer;
    const subjectRequire = createRequire(join(repo, 'package.json'));
    const playwright = await import(pathToFileURL(subjectRequire.resolve('playwright')).href);
    const name = parameters.browser ?? cell.browser ?? context.browserName ?? browserOptions.engine ?? 'chromium';
    if (!['chromium', 'firefox', 'webkit'].includes(name)) throw Error('Unsupported browser engine');
    egress = await createCachePreservingEgress({ engine: name, allowedOrigins: [server.origin], onBlocked: event => external.push(event) });
    browserServer = await playwright[name].launchServer({ ...egress.launchOptions, headless: context.headless ?? browserOptions.headless ?? false, timeout: 30000 });
    await registerProcess('browser', browserServer.process().pid, playwright[name].executablePath());
    browser = await playwright[name].connect(browserServer.wsEndpoint());
    const pin = JSON.parse(await readFile(join(repo, 'node_modules/playwright-core/browsers.json'), 'utf8')).browsers.find(entry => entry.name === name);
    if (browser.version() !== pin.browserVersion) throw new PrerequisiteError('Installed browser differs from the sealed Playwright pin');
    browserContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light', reducedMotion: 'no-preference' });
    browserContext.setDefaultTimeout(10000); browserContext.setDefaultNavigationTimeout(15000);
    const capabilitySetup = await installRasterCapabilities(browserContext, cell.operation === 'interaction.brush' ? parameters.mode ?? 'native' : 'native');
    rawVitals = await installBrowserVitals(browserContext);
    try { canonicalVitals = await installCanonicalWebVitals(browserContext, { repo, allowedOrigins: [server.origin] }); }
    catch (error) { if (error?.code !== 'CAMPAIGN_PREREQUISITE') throw error; canonicalMissing = error.message; }
    if (!egress.supported) await browserContext.route('**/*', route => {
      const target = new URL(route.request().url());
      if (['http:', 'https:'].includes(target.protocol) && target.origin !== server.origin) { external.push({ protocol: target.protocol, ordinal: external.length + 1 }); return route.abort('blockedbyclient'); }
      return route.continue();
    });
    page = await browserContext.newPage();
    // This is an unscored transport challenge, served only by our proxy. A
    // platform loopback bypass reaches the product server and cannot satisfy it.
    const proxyRoute = egress.supported ? await egress.verifyBrowserRoute(page, { signal }) : null;
    if (browserOptions.byteAudit === true) {
      const { createBrowserD11Collector } = await import('./browser-d11.mjs');
      d11Collector = await createBrowserD11Collector({ context: browserContext, page, repo, output, origin: server.origin, fixture, engine: name, cachePolicy: { httpCacheDisabledByRouting: !egress.supported, policy: egress.cachePolicy } });
      if (!navigations.has(cell.operation)) await d11Collector.begin({ id: 'unscored-bootstrap', cache: 'cold', scope: 'startup', byteAudit: true });
    }
    page.on('pageerror', () => errors.push({ type: 'page-error', atMs: monotonic() }));
    page.on('response', response => {
      if (response.request().method() !== 'POST' || new URL(response.url()).pathname !== '/api/v1/commands') return;
      // Response bodies are inspected transiently, but only immutable IDs/status
      // enter a receipt. Requests/prompt/body text are never retained here.
      const promise = response.json().then(value => {
        const receipt = value.receipt ?? value;
        if (receipt.commandId) commandReceipts.push({ commandId: receipt.commandId, status: receipt.status, observedMs: monotonic() });
      }).catch(() => {}).finally(() => pendingReplies.delete(promise));
      pendingReplies.add(promise);
    });
    const executable = playwright[name].executablePath();
    const identity = { engine: name, version: browser.version(), revision: pin.revision, executable, executableIdentity: await fileIdentity(executable), playwrightModule: subjectRequire.resolve('playwright'), backendPid: child.pid, browserPid: browserServer.process().pid, headless: context.headless ?? browserOptions.headless ?? false, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, proxyRoute, capabilitySetup, fixtureSeal: fixture.seal, root };
    await writeFile(join(output, 'browser-runtime.json'), JSON.stringify(identity, null, 2), { mode: 0o600, flag: 'wx' });
    if (!navigations.has(cell.operation)) {
      await page.goto(await server.pair()); await ready(page);
      // A text byte audit first observes an empty shell. Opening the mixed
      // document belongs inside the later text-engine coverage boundary.
      if (fixture.documentId && !(d11Collector && cell.operation.startsWith('text.'))) await openDocument(page, fixture);
      if (d11Collector) await exclusiveJSON(join(output, 'd11-unscored-bootstrap.json'), await d11Collector.snapshot());
      if (cell.operation === 'lifecycle.editor') {
        fixture = { ...fixture, candidate: await resolveBrowserCandidate(page, fixture) };
        lifecycleOracle = await (await import('./browser-lifecycle-oracle.mjs')).createLifecycleOracle({ page, fixture, root, origin: server.origin, repo, signal });
        await exclusiveJSON(join(output, 'lifecycle-initial-oracle.json'), await lifecycleOracle.baseline());
      }
      if (cell.operation === 'lifecycle.editor' || cell.operation === 'adapter.lifecycle') {
        await page.getByRole('button', { name: 'Close document', exact: true }).click();
        await page.getByText('No document open', { exact: true }).waitFor({ state: 'visible' });
      }
    }
    if (cell.operation === 'adapter.select') { const { prepareAdapterBrowserCell } = await import('./browser-adapters.mjs'); await prepareAdapterBrowserCell({ page, fixture, backend: { adapterLibrary } }); }
    if (cell.operation === 'fast.workflow' && ['WF07', 'WF08', 'WF09'].includes(parameters.caseId)) {
      const { prepareFastBrowserFixture } = await import('./browser-fast-setup.mjs');
      const setup = await prepareFastBrowserFixture({ page, cell, fixture, signal });
      await exclusiveJSON(join(output, 'browser-fast-setup.json'), sanitize(setup));
    }
    if (['raster.masked-prepare', 'raster.adopt', 'lifecycle.editor'].includes(cell.operation)) fixture = { ...fixture, candidate: await resolveBrowserCandidate(page, fixture) };
    readinessController = createBrowserReadinessController({ page, browser, engine: name, fixture, signal });
    prepared = true; return identity;
  }

  async function prepareCell(cell) {
    if (closed) throw Error('Browser campaign is closed'); assertCell(cell);
    if (cell.operation === 'developer.hot-update') {
      hmrAdapter ??= await (await import('./browser-hmr.mjs')).createBrowserHmrCampaign(context);
      return hmrAdapter.prepareCell(cell);
    }
    if (backendOnly.has(cell.operation)) {
      if (!backendAdapter) {
        const module = await import('./backend.mjs');
        backendAdapter = await (module.createBackendAdapter ?? module.createBackendCampaign)(context);
      }
      return backendAdapter.prepareCell(cell);
    }
    if (!prepared) return launch(cell);
    if (preparationCell.workload && cell.workload && preparationCell.workload !== cell.workload) throw Error('A browser process cannot silently switch workload cohorts');
    return { reused: true, browserPid: browserServer.process().pid, backendPid: server.pid };
  }

  async function resetCell(cell, sample = {}) {
    const p = assertCell(cell); signal?.throwIfAborted();
    if (cell.operation === 'developer.hot-update') { await prepareCell(cell); return hmrAdapter.resetCell(cell, sample); }
    if (backendOnly.has(cell.operation)) return backendAdapter.resetCell(cell, sample);
    if (!prepared) await prepareCell(cell);
    if (sample.cache === 'cold' && serial > 0) throw new PrerequisiteError('Cold browser samples require a fresh runner child/browser/backend, never a cache-label change');
    resetMissing = []; readinessEvidence = null;
    if (cell.operation === 'adapter.select') { const { resetAdapterBrowserCell } = await import('./browser-adapters.mjs'); await resetAdapterBrowserCell({ page, fixture, backend: { adapterLibrary } }); return { status: 'PASS', cache: sample.cache, reset: 'actual public unselect and immutable library search' }; }
    const controlled = !!(p.readiness || p.decodedCache || p.mode && p.mode !== 'native');
    // Logical history/view restoration is separate from the real renderer
    // preconditions established below; it cannot certify a decoded cache.
    const logicalCell = controlled ? { ...cell, parameters: { ...p, readiness: undefined, decodedCache: undefined, mode: 'native' } } : cell;
    const finishReset = async reset => {
      if (!controlled || String(reset.status).toUpperCase() !== 'PASS') return reset;
      try { readinessEvidence = await readinessController.resetProductState(cell); }
      catch (error) { if (error?.code !== 'CAMPAIGN_PREREQUISITE') throw error; resetMissing = [error.message]; return { ...reset, status: 'INCONCLUSIVE', missing: resetMissing }; }
      if (readinessEvidence.actionAllowed !== true) resetMissing = readinessEvidence.missing ?? ['Renderer precondition is unavailable'];
      return { ...reset, status: readinessEvidence.status, readiness: readinessEvidence, missing: [...(reset.missing ?? []), ...(readinessEvidence.missing ?? [])] };
    };
    if (navigations.has(cell.operation)) return { status: 'PASS', cache: sample.cache, pagePreparation: 'navigation remains inside action timer' };
    if (cell.kind === 'lifecycle' || cell.operation.endsWith('.lifecycle') || cell.operation === 'lifecycle.editor') return { status: 'PASS', cache: sample.cache, independentClosedBaseline: true };
    if (d11Collector && cell.operation.startsWith('text.') && !baseline) return { status: 'PASS', cache: sample.cache, pagePreparation: 'First mixed document opens inside the explicit text-engine byte audit' };
    if (controlled && previousResult && cell.operation === 'raster.adopt') await readinessController.returnToAccepted();
    if (!baseline) baseline = await captureBrowserBaseline({ page, cell: logicalCell, fixture, signal });
    const reset = await resetBrowserCell({ page, cell: logicalCell, fixture, sample, previousResult, baseline, controls, server, signal, networkGuard: egress });
    baseline = reset.baseline ?? baseline;
    resetMissing = reset.missing ?? (String(reset.status).toUpperCase() !== 'PASS' ? ['Actual public reset did not establish the cell preconditions'] : []);
    if (String(reset.status).toUpperCase() === 'PASS' && sample.cache === 'warm' && ['interaction.brush', 'text.interaction'].includes(cell.operation)) {
      const startMs = monotonic(), actions = [];
      const document = (await publicRead(page, '/api/v1/documents/' + fixture.documentId)).projection.value;
      await page.waitForFunction(asset => document.querySelector('canvas[aria-label="Document raster preview"]')?.getAttribute('data-asset') === asset, document.image?.compositeAssetId ?? '');
      let nativePreparation = null;
      if (cell.operation === 'text.interaction') {
        const { runTextBrowserCell } = await import('./browser-text.mjs');
        nativePreparation = await runTextBrowserCell({ page, cell: { ...cell, operation: 'text.active-layout' }, fixture, repo, signal });
        actions.push('public exact-fixture native text preview');
      } else {
        await page.getByRole('button', { name: 'Mask', exact: true }).click();
        await page.getByRole('spinbutton', { name: 'Brush diameter (document px)', exact: true }).waitFor({ state: 'visible' });
        actions.push('public mask feature activation');
      }
      const restored = await resetBrowserCell({ page, cell: logicalCell, fixture, sample, previousResult: nativePreparation ?? { observations: { unscoredFeatureActivation: true } }, baseline, controls, server, signal, networkGuard: egress });
      if (String(restored.status).toUpperCase() !== 'PASS') { resetMissing = restored.missing ?? ['Per-visit public preparation did not restore the sealed state']; return { ...restored, warmPreparation: { startMs, endMs: monotonic(), actions } }; }
      return finishReset({ ...reset, warmPreparation: { kind: 'actual-unscored-per-visit-preparation', startMs, endMs: monotonic(), actions, viewportAssetId: document.image?.compositeAssetId ?? null, nativePreparation, canonicalVisitIncludesPreparation: true, retainedWorkerCacheClaim: false, readiness: 'Public viewport identity and actual feature workflow; independent complete decoded/font cache ledger remains unavailable' } });
    }
    return finishReset(reset);
  }

  async function measureResources() {
    if (!server || !browserServer) throw new PrerequisiteError('Browser resource owner not running');
    if (resourceSampler) { const value = await resourceSampler.measure(); resources.push(value); return value; }
    const sampleAtMs = monotonic();
    let processRows;
    try { processRows = (await executeFile('/bin/ps', ['-e', '-o', 'pid=,ppid=,rss='], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 })).stdout; }
    catch { throw new PrerequisiteError('OS attributable process-tree RSS is unavailable'); }
    const browserProcesses = processTreeRows(processRows, [browserServer.process().pid]);
    const backendProcesses = processTreeRows(processRows, [server.pid]);
    if (!browserProcesses.length || !backendProcesses.length) throw new PrerequisiteError('Owned process disappeared during RSS sample');
    const phases = await page.evaluate(() => globalThis.__IDEOGRAM_PHASES__?.snapshot?.() ?? null);
    const lifecycle = await page.locator('ie-shell').evaluate(shell => shell.documentLifecycle ?? null);
    const sample = { sampleAtMs, browserProcesses, backendProcesses, browserRssBytes: browserProcesses.reduce((sum, p) => sum + p.rssBytes, 0), backendRssBytes: backendProcesses.reduce((sum, p) => sum + p.rssBytes, 0), allocations: phases?.allocations ?? null, allocationCoverage: phases?.allocations ? 'product diagnostic ledger; completeness separately verified' : 'missing CPU/GPU/font/caption ledger', forcedGC: false };
    sample.documentLifecycle = lifecycle; resources.push(sample); return sample;
  }

  async function lifecycleIdentity() {
    if (!resourceSampler) {
      const identity = context.rendererIdentity;
      rendererOwnershipCapture = identity ? await captureRendererOwnershipProof({ repo, output, sourceFiles: identity.sourceFiles, buildFiles: identity.buildFiles,
        executableIdentity: { sourceDigest: identity.sourceDigest, buildDigest: identity.buildDigest, toolsDigest: identity.toolsDigest } }) : { proof: null, artifact: null, missing: ['renderer-source-and-build-identity-unavailable'] };
      resourceSampler = createBrowserResourceSampler({ browserPid: browserServer?.process().pid, backendPid: server?.pid, page, output, signal, rendererOwnershipProof: rendererOwnershipCapture.proof });
      await resourceSampler.start();
    }
    return resourceSampler.identity();
  }

  async function resourceSamplingEvidence() { return resourceSampler ? { ...await resourceSampler.stop(), rendererOwnershipProof: rendererOwnershipCapture?.proof ?? null, rendererOwnershipMissing: rendererOwnershipCapture?.missing ?? [] } : { complete: false, kind: 'attributed-process-tree-and-allocation-ledger', sha256: null, missing: ['Continuous sampling was not started'] }; }

  async function finalizeLifecycle(cell) {
    if (cell.operation !== 'lifecycle.editor') return { status: 'PASS', applicable: false };
    if (!lifecycleOracle) return { status: 'INCONCLUSIVE', missing: ['Lifecycle initial full byte oracle was not prepared before B0'] };
    const value = await lifecycleOracle.completeSeries();
    const file = join(output, 'lifecycle-final-oracle.json'); await exclusiveJSON(file, value);
    return { ...value, status: value.complete ? 'PASS' : 'INCONCLUSIVE', artifacts: [file] };
  }

  async function lifecycleCycle(argument = {}, { cycle = 1, signal: cycleSignal = signal } = {}) {
    const cell = argument.cell ?? argument;
    cycleSignal?.throwIfAborted();
    if (!page) throw new PrerequisiteError('No live editor lifecycle');
    if (cell.operation === 'adapter.lifecycle') {
      const { runAdapterBrowserCell } = await import('./browser-adapters.mjs');
      await openDocument(page, fixture);
      return runAdapterBrowserCell({ page, cell, fixture, signal, backend: { root, server, adapterLibrary, closeDocumentConsumers: closeDocumentConsumers } });
    }
    const close = page.getByRole('button', { name: 'Close document', exact: true });
    if (await close.count() !== 1) throw new PrerequisiteError('Product document-close capability unavailable; navigation is not a lifecycle substitute');
    const candidate = fixture.candidate;
    if (!candidate) throw new PrerequisiteError('Lifecycle requires a fixed sealed prepared candidate');
    const phases = [], receipts = [], readDocument = async () => (await publicRead(page, '/api/v1/documents/' + fixture.documentId)).projection.value;
    const phase = async (name, work) => {
      const entry = { name, startMs: monotonic(), endMs: null, outcome: 'running' }; phases.push(entry);
      try { const value = await work(); entry.outcome = 'expected'; return value; }
      catch (error) { entry.outcome = 'failed'; throw error; }
      finally { entry.endMs = monotonic(); }
    };
    let before, afterStroke, retainedBefore, lifecycle, mixed, strokeResult, adoption, oracleResult;
    const retainedWitness = async () => {
      const frozen = fixture.extensions?.candidates;
      const ids = [...new Set([candidate.encodedAssetId, candidate.preparedAssetId, frozen?.source?.assetId, frozen?.mask?.assetId].filter(Boolean))];
      const assets = [];
      for (const id of ids) {
        const asset = (await publicRead(page, '/api/v1/assets/' + id)).projection.value;
        const disk = await page.evaluate(async id => {
          const response = await fetch('/api/v1/assets/' + id + '/content', { method: 'HEAD', headers: { 'X-App-Client': 'LP-1' }, credentials: 'same-origin', cache: 'no-store' });
          return { status: response.status, etag: response.headers.get('etag'), byteLength: response.headers.get('content-length') };
        }, id);
        assert.equal(disk.status, 200); assert.equal(disk.etag, '"' + asset.blob.hash + '"'); assert.equal(disk.byteLength, asset.blob.byteLength);
        assets.push({ id, blob: asset.blob, pixels: asset.raster?.pixels ?? null });
      }
      return assets;
    };
    await phase('open', async () => { await openDocument(page, fixture); before = await readDocument(); retainedBefore = await retainedWitness(); await lifecycleOracle?.checkpoint('open'); });
    strokeResult = await phase('stroke', async () => {
      const value = await stroke(page, { signal: cycleSignal, commit: true, fixture, gestures, strokeIndex: cycle - 1 });
      afterStroke = await readDocument(); assert.notDeepEqual(afterStroke.image, before.image, 'Lifecycle stroke must change the accepted image'); await lifecycleOracle?.checkpoint('after-stroke', { stroke: value }); return value;
    });
    if (['WXn', 'WXs'].includes(fixture.workload)) mixed = await (await import('./browser-text.mjs')).runNativeLifecycle({ page, fixture, signal: cycleSignal, phase });
    // An explicit full-candidate placement remains reversible after the mask
    // stroke changes the original source. Its treatment is retained in evidence.
    adoption = await phase('adopt', async () => {
      const replacement = await selectVisibleImageLayer(page, fixture, strokeResult.target.id);
      const result = await runBrowserAction({ page, cell: { ...cell, operation: 'raster.adopt', parameters: { candidate, readiness: 'B', placement: 'current-document', treatment: 'full-candidate', replaceSelectedImage: true } }, fixture, signal: cycleSignal, pair: () => server.pair() });
      const changed = await readDocument(), image = await publicRead(page, '/api/v1/documents/' + fixture.documentId + '/image');
      assert.deepEqual(changed.orderedLayerIds, afterStroke.orderedLayerIds, 'Replacement must preserve exact layer identities, slots and count');
      const target = image.layers.find(layer => layer.id === replacement.id); assert(target); assert.equal(target.version, String(BigInt(replacement.version) + 1n));
      await lifecycleOracle?.checkpoint('after-adoption', { replacement, candidate });
      return { ...result, replacement };
    });
    await phase('undo-adoption', async () => {
      assert.equal(adoption.receipt?.documentId, fixture.documentId, 'Lifecycle adoption must create an undoable revision of the fixture document');
      receipts.push(await acceptedCommand(page, 'Undo', () => page.getByRole('button', { name: 'Undo', exact: true }).click(), cycleSignal));
      assert.deepEqual((await readDocument()).image, afterStroke.image, 'Undo of adoption must restore the stroked document');
      await lifecycleOracle?.checkpoint('after-undo-adoption');
    });
    await phase('undo-stroke', async () => {
      await openDocument(page, fixture);
      receipts.push(await acceptedCommand(page, 'Undo', () => page.getByRole('button', { name: 'Undo', exact: true }).click(), cycleSignal));
      const restored = await readDocument(); assert.deepEqual(restored.image, before.image); assert.deepEqual(restored.orderedLayerIds, before.orderedLayerIds);
      await lifecycleOracle?.afterUndo();
    });
    const closeStartMs = monotonic();
    await phase('close', async () => { await close.click(); await page.getByText('No document open', { exact: true }).waitFor({ state: 'visible' }); });
    await phase('release', async () => {
      lifecycle = await page.locator('ie-shell').evaluate(shell => shell.documentLifecycle ?? null);
      if (!lifecycle || lifecycle.releasing) throw new PrerequisiteError('Document resource release witness unavailable');
      for (const counters of Object.values(lifecycle.consumers)) for (const value of Object.values(counters)) assert(value === 0 || value === false, 'A document consumer retained resources after close');
      assert.deepEqual(await retainedWitness(), retainedBefore, 'Frozen source, mask and candidate asset bytes must stay retained after close');
      oracleResult = await lifecycleOracle?.afterClose();
    });
    const rasterWorker = await rasterMaintenance('raster-worker-state');
    if (requiredWorkerRestart) {
      assert.equal(rasterWorker.identity?.generation, requiredWorkerRestart.generation, 'The scheduled replacement worker must execute the next real cycle');
      assert.equal(rasterWorker.lastCompleted?.generation, requiredWorkerRestart.generation, 'A newly started idle service alone is not evidence of resumed raster work');
      assert(rasterWorker.completedJobs > requiredWorkerRestart.completedJobs, 'The next cycle must complete real work on the replacement generation');
      requiredWorkerRestart = null;
    }
    const oracleMissing = [...(oracleResult?.missing ?? ['Complete initial/interim/final retained-input byte proof unavailable'])];
    const oracleComplete = !!oracleResult?.assertions?.lifecycleRaster && oracleResult.assertions.undoRestored === true && oracleResult.assertions.retainedInputs === true;
    if (!oracleComplete && !oracleMissing.length) oracleMissing.push('Required scoped lifecycle oracle assertions are absent');
    return { status: oracleMissing.length ? 'INCONCLUSIVE' : 'PASS', phases, strokeSamples: strokeResult.samples.length, stroke: strokeResult, adoption, receipts, mixed, assertions: oracleResult?.assertions ?? { exactPixels: null, undoRestored: true, retainedInputs: null }, oracle: oracleResult?.evidence ?? null, retainedAssetWitness: retainedBefore, closeStartMs, closeObservedMs: phases.at(-1).endMs, releaseMs: lifecycle.lastReleaseMilliseconds, lifecycle, rasterWorker, browserPid: browserServer.process().pid, backendPid: server.pid, completeCycleActions: true, missing: oracleMissing };
  }

  async function rasterMaintenance(type, expectedGeneration) {
    signal?.throwIfAborted();if (!serverChild?.connected) throw new PrerequisiteError('Owned backend maintenance channel is unavailable');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); serverChild.off('message', reply); serverChild.off('exit', exited); signal?.removeEventListener('abort', aborted); };
      const reply = message => { if (message?.type !== 'raster-maintenance-reply' || message.id !== id) return; cleanup(); if (message.error) reject(Object.assign(Error('Owned raster maintenance failed'), { code: message.error.code })); else resolve(message.value); };
      const exited = () => { cleanup(); reject(Error('Owned backend exited during raster maintenance')); };
      const aborted = () => { cleanup(); reject(signal.reason ?? Error('Aborted')); };
      const timer = setTimeout(() => { cleanup(); reject(Error('Owned raster maintenance deadline')); }, 30000);
      serverChild.on('message', reply); serverChild.once('exit', exited); signal?.addEventListener('abort', aborted, { once: true });
      serverChild.send({ type, id, ...(expectedGeneration === undefined ? {} : { expectedGeneration }) });
    });
  }
  async function restartWorker({ cycle } = {}) {
    await page.getByText('No document open', { exact: true }).waitFor({ state: 'visible' });
    const lifecycle = await page.locator('ie-shell').evaluate(shell => shell.documentLifecycle);
    if (!lifecycle || lifecycle.releasing) throw new PrerequisiteError('Document consumers have not finished releasing');
    const state = await rasterMaintenance('raster-worker-state');
    if (state.activeJobs !== 0 || state.retainedJobReferences !== 0 || state.idleWorkers !== 1 || !state.identity) throw new PrerequisiteError('A real idle raster worker is required for scheduled restart');
    const backendPid = serverChild.pid, browserPid = browserServer.process().pid;
    const receipt = await rasterMaintenance('restart-raster-worker', state.generation);
    assert.equal(receipt.kind, 'raster-worker-restart-1'); assert.deepEqual(receipt.before, state.identity);
    assert.equal(receipt.after.generation, state.generation + 1); assert.equal(receipt.activeJobs, 0); assert.equal(receipt.retainedJobReferences, 0);
    assert.equal(receipt.forcedGC, false); assert.equal(receipt.nativeAllocatorReleaseClaim, false);
    assert.equal(serverChild.pid, backendPid); assert.equal(browserServer.process().pid, browserPid);
    requiredWorkerRestart = { generation: receipt.after.generation, completedJobs: state.completedJobs };
    const identity = value => `${backendPid}:${value.threadId}:${value.generation}`;
    return { status: 'PASS', cycle, before: identity(receipt.before), after: identity(receipt.after), receipt, backendPid, browserPid, mainProcessRestarted: false, requiresNextRealJobEvidence: true };
  }

  async function closeDocumentConsumers() {
    const closeStartMs = monotonic(); await page.getByRole('button', { name: 'Close document', exact: true }).click();
    await page.getByText('No document open', { exact: true }).waitFor({ state: 'visible' });
    const lifecycle = await page.locator('ie-shell').evaluate(shell => shell.documentLifecycle ?? null);
    if (!lifecycle || lifecycle.releasing) throw new PrerequisiteError('Document resource release witness unavailable');
    return { closeStartMs, closeObservedMs: monotonic(), lifecycle };
  }

  async function execute(cell, sample = {}) {
    assertCell(cell); if (closed) throw Error('Browser campaign is closed'); signal?.throwIfAborted();
    if (cell.operation === 'developer.hot-update') { await prepareCell(cell); return hmrAdapter.execute(cell, sample); }
    if (backendOnly.has(cell.operation)) { await prepareCell(cell); return backendAdapter.execute(cell, sample); }
    await prepareCell(cell);
    if (resetMissing.length) return { cellId: cell.id, status: 'INCONCLUSIVE', elapsedMs: 0, phases: [], missing: [...resetMissing], observations: { actionExecuted: false } };
    const visitCohort = { cache: sample.cache === 'warm' ? 'warm' : 'cold', cohortKey: cell.id ?? cell.operation + '-' + (cell.workload ?? fixture.workload) };
    let initialVisitIds = [], currentVisitId, visits;
    if (browserOptions.byteAudit !== true && vitalOperations.has(cell.operation) && canonicalVitals) {
      initialVisitIds = canonicalVitals.visits().map(visit => visit.visitId);
      canonicalVitals.setCohort(visitCohort, { page, includeCurrentVisit: !navigations.has(cell.operation) });
      if (!navigations.has(cell.operation)) currentVisitId = canonicalVitals.visits().at(-1)?.visitId;
    }
    const visibility = await page.evaluate(() => document.visibilityState);
    const index = ++serial, phases = [], startMs = monotonic(), errorStart = errors.length, externalStart = external.length, receiptStart = commandReceipts.length;
    const trace = createBrowserTrace(page, { artifactDirectory: output, artifactName: 'browser-trace-' + index + '.json' });
    await trace.start(); let result, failure, evidence, d11, auditAction, auditActive = false;
    try {
      if (d11Collector) await d11Collector.begin({ id: String(cell.id) + ':' + String(sample.cache) + ':' + String(sample.ordinal), cache: visitCohort.cache, scope: browserOptions.byteAuditScope ?? (navigations.has(cell.operation) ? 'startup' : cell.operation.startsWith('text.') ? 'text-engine' : 'lazy-feature'), featureId: browserOptions.byteAuditFeatureId, byteAudit: true });
      auditActive = !!d11Collector;
      if (d11Collector && cell.operation.startsWith('text.')) {
        await openDocument(page, fixture);
        baseline ??= await captureBrowserBaseline({ page, cell, fixture, signal });
      }
      const module = cell.operation.startsWith('text.') ? await import('./browser-text.mjs') : null;
      if (module) result = await module.runTextBrowserCell({ page, cell, fixture, repo, signal });
      else if (queueOperations.has(cell.operation)) { const { runQueueBrowserCell } = await import('./browser-queue.mjs'); result = await runQueueBrowserCell({ page, cell, fixture, server, controls, signal }); }
      else if (cell.operation.startsWith('adapter.')) {
        const { runAdapterBrowserCell } = await import('./browser-adapters.mjs');
        result = await runAdapterBrowserCell({ page, cell, fixture, signal, backend: { root, server, adapterLibrary, closeDocumentConsumers } });
      } else result = await runBrowserAction({ page, cell, fixture, signal, pair: () => server.pair(), services: { ...context.services, gestures, lifecycleCycle, verifyDecodedReadiness: readinessController.verifyDecodedReadiness, observeAdoption: readinessController.observeAdoption } });
      if (d11Collector && cell.operation === 'text.mixed-ready') {
        const initialization = await module.runTextBrowserCell({ page, cell: { ...cell, operation: 'text.active-layout' }, fixture, repo, signal });
        auditAction = { operation: 'text.active-layout', scope: 'explicit-unscored-text-engine-byte-initialization', originalOperation: cell.operation, observations: initialization.observations, outcome: initialization.status };
        if (String(initialization.status).toUpperCase() === 'FAIL') result.status = 'FAIL';
      }
      await Promise.all([...pendingReplies]);
      const phaseSnapshot = await page.evaluate(() => globalThis.__IDEOGRAM_PHASES__?.snapshot?.() ?? null);
      evidence = { productPhases: phaseSnapshot, observedCommandReceipts: commandReceipts.slice(receiptStart), rawVisits: rawVitals.snapshot(), readiness: readinessEvidence };
      if (d11Collector) { d11 = await d11Collector.snapshot(); auditActive = false; }
    } catch (error) { failure = error; if (error.observations) result = { observations: error.observations }; }
    finally {
      if (auditActive) try { d11 = await d11Collector.snapshot(); } catch (error) { failure ??= error; }
      const endMs = monotonic(); phases.push({ name: 'browser.action', startMs, endMs, durationMs: endMs - startMs, clock: 'runner-monotonic', scope: 'includes Playwright action/witness/trace overhead; never narrower child budget' });
    }
    const traced = await trace.stop();
    if (browserOptions.byteAudit === true && navigations.has(cell.operation)) {
      try { await page.goto('about:blank'); } catch (error) { failure ??= error; }
    }
    if (browserOptions.byteAudit !== true && vitalOperations.has(cell.operation) && canonicalVitals) {
      const expectedVisits = currentVisitId ? [currentVisitId] : canonicalVitals.visits().filter(visit => !initialVisitIds.includes(visit.visitId)).map(visit => visit.visitId);
      try { await page.goto('about:blank'); }
      catch (error) { failure ??= error; }
      visits = canonicalVitals.snapshot({ ...visitCohort, expectedVisits });
      // New INP visits need a new document lifecycle. Reopen after the scored
      // visit has finalized; the next reset still proves its exact warm state.
      if (!navigations.has(cell.operation)) {
        try { await page.goto(await server.pair()); await ready(page); await openDocument(page, fixture); }
        catch (error) { failure ??= error; }
      }
    }
    const prerequisiteFailure = failure instanceof PrerequisiteError || failure?.code === 'CAMPAIGN_PREREQUISITE';
    const byteAudit = browserOptions.byteAudit === true;
    const missing = [...(byteAudit ? d11?.missing ?? ['The explicit byte audit did not reach its actual ready boundary'] : result?.missing ?? []), ...(readinessEvidence?.missing ?? []), ...(prerequisiteFailure ? [failure.message] : [])];
    const measured = byteAudit ? { measurements: [], unavailable: [] } : extractBrowserMeasurements({ cell, sample, visits, result, evidence, trace: traced, resources });
    missing.push(...measured.unavailable.filter(row => row.source !== 'separate-byte-audit').map(row => row.name + ': ' + row.reason));
    if (!byteAudit && !evidence?.productPhases) missing.push('Product phase snapshot unavailable');
    if (!byteAudit && vitalOperations.has(cell.operation) && !canonicalVitals) missing.push(canonicalMissing ?? 'Pinned canonical Web Vitals observer unavailable');
    if (!byteAudit && cell.requirements?.presentationTrace !== false) missing.push('Actual display presentation and complete R07 application attribution are not established by renderer Paint/DrawFrame');
    if (!byteAudit && (context.headless ?? browserOptions.headless)) missing.push('Headless browser cannot establish the required H display environment');
    const network = egress.evidence();
    if (sample.cache === 'warm' && !egress.supported) missing.push('This browser engine retains a route-based egress guard that disables HTTP cache');
    if (egress.supported && !network.counts.accepted) missing.push('No actual product request traversed the configured cache-preserving proxy');
    if (errors.length > errorStart || external.length > externalStart) failure ??= Error('Unexpected browser failure or attempted external request');
    const status = failure && !prerequisiteFailure || String(result?.status).toUpperCase() === 'FAIL' || String(d11?.status).toUpperCase() === 'FAIL' ? 'FAIL' : missing.length || !byteAudit && String(result?.status).toUpperCase() === 'INCONCLUSIVE' ? 'INCONCLUSIVE' : 'PASS';
    const session = byteAudit ? null : interactionSession(cell, sample, result, traced, visibility);
    const firstUse = cell.operation === 'interaction.first-use' && result ? { id: String(cell.id) + ':' + String(sample.ordinal), reset: sample.cache === 'cold' && index === 1, startMs: result.startMs, endMs: result.endMs, captureStoppedMs: result.captureStoppedMs, inputMs: result.inputMs, readyMs: result.readyMs, presentedMs: null, meaningful: result.meaningful, feature: result.feature, trace: { kind: 'browser-diagnostic-trace', sha256: traced.artifact?.sha256 ?? null, attributionComplete: false }, outcome: failure ? 'failed' : 'expected', resetEvidence: { freshBrowserContext: index === 1, fixtureCopiedBeforeLaunch: true, browserPid: browserServer.process().pid, backendPid: server.pid } } : null;
    const receipt = { cellId: cell.id, operation: cell.operation, status, elapsedMs: monotonic() - startMs, phases: [...phases, ...(result?.phases ?? [])], measurements: measured.measurements, measurementUnavailable: measured.unavailable, observations: result?.observations ?? result ?? null, evidence, network, ...(visits ? { visits } : {}), ...(session ? { session } : {}), ...(firstUse && !byteAudit ? { firstUse } : {}), ...(d11 ? { d11 } : {}), ...(auditAction ? { auditAction } : {}), timingSamplesReusable: !byteAudit, trace: traced, missing, error: failure ? { name: failure.name, code: failure.code ?? null, message: prerequisiteFailure ? failure.message : 'Browser action failed; retained structured evidence identifies the phase' } : null, rawConsoleRetained: false, screenshotsRetained: false, clocksJoinedBySubtraction: false };
    const file = join(output, 'browser-cell-' + index + '.json'); await writeFile(file, JSON.stringify(sanitize(receipt), null, 2), { mode: 0o600, flag: 'wx' });
    previousResult = result ?? receipt;
    return { ...receipt, artifacts: [file, traced.artifact?.path].filter(Boolean) };
  }

  async function close() {
    if (closed) return; closed = true; const failures = [];
    if (resourceSampler) try { await boundedClose(() => resourceSampler.stop()); } catch { failures.push('Owned resource sampler did not seal'); }
    if (page && !page.isClosed()) try { await boundedClose(() => page.goto('about:blank')); } catch { failures.push('Final real visit navigation failed'); }
    if (rawVitals) { try { await exclusiveJSON(join(output, 'browser-raw-visits.json'), rawVitals.snapshot()); } catch { failures.push('Raw visit receipt could not be retained'); } rawVitals.close(); }
    if (canonicalVitals) { try { await exclusiveJSON(join(output, 'browser-canonical-visits.json'), canonicalVitals.snapshot()); } catch { failures.push('Canonical visit receipt could not be retained'); } canonicalVitals.close(); }
    for (const work of [() => backendAdapter?.close(), () => hmrAdapter?.close(), () => d11Collector?.close(), () => lifecycleOracle?.close(), () => browserContext?.close(), () => browser?.close(), () => browserServer?.close(), () => server?.close(), () => egress?.close()]) {
      try { await boundedClose(work); } catch { failures.push('Owned resource close failed'); }
    }
    if (failures.length && browserServer) try { await boundedClose(() => browserServer.kill()); } catch { failures.push('Owned browser forced termination failed'); }
    if (serverChild && serverChild.exitCode === null) { serverChild.kill('SIGTERM'); failures.push('Backend remained live after owner close; owned child terminated'); }
    await writeFile(join(output, 'browser-close.json'), JSON.stringify({ closed: !failures.length, failures, resourceSamples: resources.length, unexpectedExternalRequests: external.length, pageErrors: errors.length, fixtureRetained: root ?? null }, null, 2), { mode: 0o600, flag: 'wx' });
    if (failures.length) throw new AggregateError(failures.map(message => Error(message)), 'Browser campaign close incomplete');
  }
  return { prepareCell, resetCell, execute, close, measureResources, lifecycleCycle, finalizeLifecycle, lifecycleIdentity, resourceSamplingEvidence, restartWorker,
    get fixtureIdentity() { return fixture?.seal?.sha256 ?? null; },
    get weightsIdentity() { return adapterLibrary?.fixtureManifest?.weights.find(item => item.bytes === 256 * 1048576)?.hash ?? null; },
    get configIdentity() { return adapterLibrary?.fixtureManifest?.config?.hash ?? null; } };
}
