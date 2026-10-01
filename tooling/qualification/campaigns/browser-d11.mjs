// D11 byte audits are deliberately separate from scored latency. V8 precise
// coverage disables optimization; parsed scripts alone never prove evaluation.
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { loadD11Build } from './browser-d11-build.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/;
const MAX_RECORDS = 20000, MAX_BODY = 32 * 1048576, MAX_SOURCE = 16 * 1048576;
const METHOD = 'chromium-precise-coverage+resource-timing+verified-build-v1';
const integer = value => Number.isSafeInteger(value) && value >= 0;
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const unique = values => [...new Set(values)];
const bounded = (promise, timeoutMs = 10000) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('D11 observation deadline')), timeoutMs); })]).finally(() => clearTimeout(timer));
};

// Runs in a page or worker. Only resource metadata and hashed font descriptions
// leave the realm; no request bodies, DOM content, text source or source code.
function observeRealm() {
  if (globalThis.__IDEOGRAM_D11_RESOURCES__) return;
  const rows = [], maximum = 20000;
  const state = { rows, overflow: false, unsupported: false, timeOrigin: performance.timeOrigin };
  globalThis.__IDEOGRAM_D11_RESOURCES__ = state;
  const collect = entries => {
    for (const item of entries) {
      if (rows.length >= maximum) { state.overflow = true; break; }
      rows.push({ name: item.name, initiatorType: item.initiatorType, startTime: item.startTime,
        duration: item.duration, transferSize: item.transferSize, encodedBodySize: item.encodedBodySize,
        decodedBodySize: item.decodedBodySize, responseStatus: item.responseStatus ?? null,
        deliveryType: item.deliveryType ?? '', nextHopProtocol: item.nextHopProtocol ?? '' });
    }
  };
  try {
    performance.setResourceTimingBufferSize(maximum);
    performance.addEventListener('resourcetimingbufferfull', () => { state.overflow = true; });
    const observer = new PerformanceObserver(list => collect(list.getEntries()));
    observer.observe({ type: 'resource', buffered: true }); state.observer = observer;
  } catch { state.unsupported = true; }
}
const OBSERVE = '(' + observeRealm.toString() + ')()';
const READ_REALM = `(() => { const s=globalThis.__IDEOGRAM_D11_RESOURCES__; if(!s)return null;
  for(const x of s.observer?.takeRecords?.()??[]){if(s.rows.length>=20000){s.overflow=true;break;}s.rows.push({name:x.name,initiatorType:x.initiatorType,startTime:x.startTime,duration:x.duration,transferSize:x.transferSize,encodedBodySize:x.encodedBodySize,decodedBodySize:x.decodedBodySize,responseStatus:x.responseStatus??null,deliveryType:x.deliveryType??'',nextHopProtocol:x.nextHopProtocol??''});}
  const fonts=typeof document==='object'&&document.fonts?{status:document.fonts.status,faces:[...document.fonts].map(f=>({family:f.family,style:f.style,weight:f.weight,stretch:f.stretch,status:f.status}))}:null;
  const navigation=typeof document==='object'?performance.getEntriesByType('navigation').map(x=>({name:x.name,initiatorType:'navigation',startTime:x.startTime,duration:x.duration,transferSize:x.transferSize,encodedBodySize:x.encodedBodySize,decodedBodySize:x.decodedBodySize,responseStatus:x.responseStatus??null,deliveryType:x.deliveryType??''})):[];
  const browserProfile=typeof document==='object'?{observed:true,viewport:{width:innerWidth,height:innerHeight},deviceScaleFactor:devicePixelRatio}:null;
  return {rows:s.rows,navigation,overflow:s.overflow,unsupported:s.unsupported,timeOrigin:s.timeOrigin,fonts,browserProfile}; })()`;

/** Only exact same-origin artifact/known-font paths are admitted. Queries and
 * fragments are never retained, and a queried asset is not silently equated
 * with an immutable build file. */
export function identifyD11Resource(url, { origin, build, fontAssets = {} }) {
  let value; try { value = new URL(url); } catch { return null; }
  if (value.origin !== origin || value.search) return null;
  if (value.pathname === '/' && build.document) return { id: 'document:' + build.document.sha256,
    sha256: build.document.sha256, rawBytes: build.document.rawBytes, gzipBytes: build.document.gzipBytes,
    kind: 'other', role: 'document' };
  if (value.hash) return null;
  const file = value.pathname.slice(1), artifact = build.files.find(item => item.file === file);
  if (artifact) return { id: artifact.sha256 + ':' + file, file, sha256: artifact.sha256,
    rawBytes: artifact.rawBytes, gzipBytes: artifact.computedGzipBytes ?? artifact.gzipBytes,
    kind: artifact.kind, role: artifact.kind === 'font' ? artifact.authoringFont ? 'authoring-font' : 'ui-font' : artifact.kind };
  const asset = /^\/api\/v1\/assets\/([A-Za-z0-9_-]+)\/content$/.exec(value.pathname);
  const font = asset && fontAssets[asset[1]];
  if (font && HASH.test(font.sha256) && integer(font.rawBytes) && font.rawBytes <= MAX_BODY) return {
    id: 'authoring-font:' + font.sha256, sha256: font.sha256, rawBytes: font.rawBytes, kind: 'font', role: 'authoring-font',
  };
  return null;
}

export function d11FontAssets(fixture = {}) {
  const ids = fixture.native?.fontAssetIds ?? [], fonts = fixture.native?.fonts ?? [];
  const result = Object.create(null);
  for (let index = 0; index < ids.length; index++) {
    const bytes = fonts[index]?.bytes, sha256 = bytes?.hash ?? fonts[index]?.sha256;
    const rawBytes = Number(bytes?.byteLength ?? fonts[index]?.byteLength);
    if (/^[A-Za-z0-9_-]+$/.test(ids[index]) && HASH.test(sha256 ?? '') && integer(rawBytes)) result[ids[index]] = { sha256, rawBytes };
  }
  return result;
}

/** Pure reduction of actual collection evidence. Build inventory alone cannot
 * create an evaluated module, a fetched font, a cache hit or a zero-byte pass. */
export function analyzeD11Observation(observation, build) {
  const missing = [...(observation.missing ?? [])], failures = [], measurements = [];
  const files = new Map(build.files.map(file => [file.file, file]));
  const evaluated = observation.evaluated ?? [], resources = observation.resources ?? [];
  if (observation.buildSha256 !== build.sha256) missing.push('Byte observation does not bind this exact verified build');
  if (observation.collection?.complete !== true) missing.push('Complete page and worker collection is unavailable');
  if (!['startup', 'text-engine', 'lazy-feature'].includes(observation.scope)) missing.push('Unknown D11 runtime scope');
  if (!['cold', 'warm'].includes(observation.cache)) missing.push('Declared independent cold/warm visit is absent');
  if (observation.cache === 'warm' && observation.cachePolicy?.httpCacheDisabledByRouting !== false) missing.push('Warm browser HTTP cache policy is disabled or unverified');
  if (observation.instrumentation !== 'precise-coverage-byte-audit' || observation.timingSamplesReusable !== false) missing.push('Byte-audit instrumentation scope is absent');
  if (build.roleContext && (observation.browserProfile?.observed !== true || observation.browserProfile.viewport?.width !== build.roleContext.viewport?.width ||
    observation.browserProfile.viewport?.height !== build.roleContext.viewport?.height || observation.browserProfile.deviceScaleFactor !== build.roleContext.deviceScaleFactor)) missing.push('Observed browser viewport or device scale differs from the retained role context');
  if (evaluated.some(row => !files.has(row.file) || row.sha256 !== files.get(row.file).sha256 || row.rawBytes !== files.get(row.file).rawBytes || !integer(row.executedFunctions) || row.executedFunctions < 1)) missing.push('Executed module identity or execution witness differs from the build');
  if (resources.some(row => row.kind !== 'other' && row.verified !== true)) missing.push('A delivered budgeted resource lacks exact response-byte verification');
  if (resources.some(row => {
    if (row.file) {
      const file = files.get(row.file), role = file?.kind === 'font' ? file.authoringFont ? 'authoring-font' : 'ui-font' : file?.kind;
      return !file || row.sha256 !== file.sha256 || row.rawBytes !== file.rawBytes || row.gzipBytes !== (file.computedGzipBytes ?? file.gzipBytes) || row.kind !== file.kind || row.role !== role;
    }
    if (row.role === 'document') return !build.document || row.sha256 !== build.document.sha256 || row.rawBytes !== build.document.rawBytes || row.gzipBytes !== build.document.gzipBytes || row.kind !== 'other';
    return row.role !== 'authoring-font' || row.kind !== 'font' || !(observation.authoringFontIdentities ?? []).some(font => font.sha256 === row.sha256 && font.rawBytes === row.rawBytes);
  })) missing.push('Resource accounting differs from its verified emitted artifact or sealed font identity');
  if (resources.some(row => !integer(row.networkTransferBytes) || !row.timing || !['transferSize', 'encodedBodySize', 'decodedBodySize'].every(key => integer(row.timing[key])))) missing.push('Complete actual network and Resource Timing byte observations are required');
  const add = (name, selected, field, target, ceiling) => {
    const dedup = new Map(selected.map(row => [row.file ?? row.id, row]));
    const values = [...dedup.values()].map(row => row[field]);
    if (values.some(value => !integer(value))) { missing.push('Byte identity unavailable for ' + name); return; }
    const value = values.reduce((sum, n) => sum + n, 0);
    measurements.push({ name, value, unit: 'bytes', method: METHOD, target, ceiling,
      evidence: { buildSha256: build.sha256, files: [...dedup.keys()].sort(), observationId: observation.id },
      counting: 'whole artifact once per scope; duplicate emitted files remain explicit' });
    if (value > ceiling) failures.push(name + ' exceeds its byte ceiling');
  };
  const evaluatedFiles = unique(evaluated.map(row => row.file)).map(file => files.get(file)).filter(Boolean);
  if (observation.scope === 'startup') {
    if (!observation.startedBeforeNavigation) missing.push('Startup audit began after document execution');
    if (!evaluatedFiles.length) missing.push('No actual startup module execution was observed');
    if (build.bootstrap && !evaluatedFiles.some(file => file.file === build.bootstrap.file)) missing.push('Fixed inline bootstrap execution was not observed');
    if (build.document && !resources.some(row => row.role === 'document' && row.verified)) missing.push('Exact transformed application document delivery was not observed');
    const fetchedJs = resources.filter(row => row.kind === 'js');
    if (!fetchedJs.length) missing.push('Startup JavaScript resource delivery was not observed');
    if (build.roles?.complete === true) {
      const allowed = new Set(build.roles.startupFiles ?? []), engine = new Set(build.roles.textEngineFiles ?? []);
      const observed = [...fetchedJs, ...evaluatedFiles];
      if (observed.some(file => !allowed.has(file.file))) failures.push('Actual startup JavaScript escaped the verified W0/W1 startup allowlist');
      if (observed.some(file => engine.has(file.file))) failures.push('A separately budgeted text-engine script executed or arrived during startup');
    }
    add('D11StartupJsGzipBytes', [...fetchedJs, ...evaluatedFiles.filter(file => file.file === build.bootstrap?.file)], 'gzipBytes', 300 * 1024, 500 * 1024);
    add('D11StartupEvaluatedJsBytes', evaluatedFiles, 'rawBytes', 1048576, 1.5 * 1048576);
    add('D11StartupUiCssAndFontsGzipBytes', resources.filter(row => row.kind === 'css' || row.role === 'ui-font'), 'gzipBytes', 100 * 1024, 200 * 1024);
    if (!observation.fonts?.observed || observation.fonts.status !== 'loaded') missing.push('Completed startup FontFaceSet observation is unavailable');
    if (resources.some(row => row.role === 'authoring-font' || row.sha256 === build.textWasmHash)) failures.push('Authoring font or text engine was eagerly loaded in startup');
  } else if (observation.scope === 'text-engine') {
    const wasm = resources.filter(row => row.sha256 === build.textWasmHash && row.kind === 'wasm');
    const owners = new Set(wasm.map(row => row.owner));
    const engineScripts = evaluated.filter(row => owners.has(row.owner) && row.owner !== 'page').map(row => files.get(row.file)).filter(Boolean);
    if (!wasm.length || !engineScripts.length) missing.push('Exact text WASM and its executing worker module were not observed together');
    const engine = [...wasm, ...engineScripts];
    add('D11TextEngineRawBytes', engine, 'rawBytes', 6 * 1048576, 12 * 1048576);
    add('D11TextEngineGzipBytes', engine, 'gzipBytes', 2 * 1048576, 4 * 1048576);
    if (!resources.some(row => row.role === 'authoring-font')) missing.push('Actual authoring font resource initialization was not observed');
  } else if (observation.scope === 'lazy-feature') {
    const feature = build.dynamicFeatures.find(row => row.id === observation.featureId);
    const lazyRole = build.roles?.lazyFeatures?.find(row => row.id === observation.featureId);
    if (build.roles?.complete !== true || !lazyRole) missing.push('Complete static classification of this deferred feature is unavailable');
    if (!feature || !observation.baselineComplete) missing.push('Exact dynamic feature and earlier observed startup baseline are required');
    if (feature && !evaluated.some(row => row.file === feature.entryFile && row.newlyEvaluated)) missing.push('Dynamic feature entry did not newly evaluate at this boundary');
    const engineOwners = new Set(resources.filter(row => row.sha256 === build.textWasmHash).map(row => row.owner));
    const lazy = evaluated.filter(row => row.newlyEvaluated && !engineOwners.has(row.owner)).map(row => files.get(row.file)).filter(Boolean);
    if (feature) add('D11LazyFeatureGzipBytes:' + feature.id, lazy, 'gzipBytes', 150 * 1024, 300 * 1024);
  }
  const complete = !missing.length;
  return { kind: 'd11-byte-observation-1', scope: observation.scope, featureIds: observation.featureId ? [observation.featureId] : [],
    cache: observation.cache, status: failures.length ? 'FAIL' : complete ? 'PASS' : 'INCONCLUSIVE', measurements,
    missing: unique(missing), failures, instrumentation: observation.instrumentation, timingSamplesReusable: false,
    buildSha256: build.sha256, duplicateVersions: build.duplicateVersions,
    roleClassification: { complete: build.roles?.complete === true, missing: build.roles?.missing ?? ['Static role classification is unavailable'],
      scope: 'Build role analysis is independent of the actual startup and text-engine execution observations' },
    roleContext: build.roleContext ?? null, browserProfile: observation.browserProfile ?? null,
    ...(observation.scope === 'startup' ? { deferredFeatureIds: build.dynamicFeatures.filter(feature => !evaluatedFiles.some(file => file.file === feature.entryFile)).map(feature => feature.id).sort() } : {}),
    transferred: { networkBytes: resources.reduce((sum, row) => sum + (integer(row.networkTransferBytes) ? row.networkTransferBytes : 0), 0),
      resourceTimingBytes: resources.reduce((sum, row) => sum + (integer(row.timing?.transferSize) ? row.timing.transferSize : 0), 0),
      complete: resources.every(row => integer(row.networkTransferBytes) && row.timing) && complete,
      scope: 'budgeted resource GET responses; control API traffic and HEAD availability probes are outside this byte budget',
      note: 'Actual transfer includes protocol overhead where exposed. Independently computed gzip is the byte budget, never a claim about wire compression.' },
    authoringFonts: resources.filter(row => row.role === 'authoring-font').map(row => ({ sha256: row.sha256, rawBytes: row.rawBytes, transferredBytes: row.networkTransferBytes, owner: row.owner })),
  };
}

/** Constructor installs only read-only Resource Timing observation. begin()
 * requires explicit byteAudit:true before enabling precise coverage. Never call
 * it during an ordinary scored S/R34 visit. All supported CDP calls are from the
 * pinned Playwright protocol; unsupported engines return missing evidence. */
export async function createBrowserD11Collector({ context, page, repo, output, origin, fixture, engine = 'chromium', cachePolicy = {} }) {
  if (!isAbsolute(output ?? '') || new URL(origin).origin !== origin) throw Error('D11 needs an absolute evidence directory and exact origin');
  const build = await loadD11Build({ repo }), fontAssets = d11FontAssets(fixture), identify = url => identifyD11Resource(url, { origin, build, fontAssets });
  await context.addInitScript(observeRealm);
  const lanes = new Map(), requests = new Map(), pending = new Set(), missing = new Set(), seenFiles = new Set();
  let session, active, ordinal = 0, laneSerial = 0, closed = false, profiling = false, baselineComplete = false, totalRecords = 0;
  const remember = reason => missing.add(reason);
  const track = work => { const promise = Promise.resolve(work); pending.add(promise); promise.catch(() => {}).finally(() => pending.delete(promise)); return promise; };
  const bump = () => { if (++totalRecords > MAX_RECORDS) { remember('D11 record limit reached'); return false; } return true; };
  const headers = (object = {}) => Object.fromEntries(Object.entries(object).map(([key, value]) => [key.toLowerCase(), value]));
  function wire(lane) {
    lane.on('Page.frameNavigated', value => {
      if (lane.id === 'page' && active && !value.frame?.parentId) active.startedBeforeNavigation = true;
    });
    lane.on('Debugger.scriptParsed', value => {
      if (!bump()) return; let identity = identify(value.url);
      if (build.bootstrap) try {
        const inline = new URL(value.url);
        if (inline.origin === origin && inline.pathname === '/' && !inline.search && value.hasSourceURL !== true) identity = build.bootstrap;
      } catch { /* Instrumentation/anonymous scripts have no application URL. */ }
      if (identity?.kind === 'js') lane.scripts.set(value.scriptId, identity);
      else if (value.url && /^(?:https?:|blob:)/.test(value.url) && value.scriptLanguage !== 'WebAssembly') remember('Unmapped executable script observed');
    });
    lane.on('Network.requestWillBeSent', value => {
      if (!bump()) return;
      const identity = identify(value.request?.url);
      if (!identity || value.request.method !== 'GET') return;
      const id = lane.id + ':' + value.requestId;
      if (requests.has(id)) remember('Redirected budgeted resource cannot be silently reassigned');
      requests.set(id, { id, requestId: value.requestId, lane, owner: lane.id, ...identity, ordinal, complete: false, decodedBytes: 0 });
    });
    lane.on('Network.responseReceived', value => {
      const row = requests.get(lane.id + ':' + value.requestId), identity = identify(value.response?.url);
      if (!row) {
        if (['Script', 'Stylesheet', 'Font'].includes(value.type)) remember('Unmapped script, stylesheet or font delivery');
        return;
      }
      if (!identity || row.id !== identity.id && row.sha256 !== identity.sha256) remember('Budgeted response identity changed');
      const h = headers(value.response.headers);
      Object.assign(row, { status: value.response.status, fromDiskCache: value.response.fromDiskCache === true,
        fromServiceWorker: value.response.fromServiceWorker === true, cacheControl: typeof h['cache-control'] === 'string' ? h['cache-control'].slice(0, 256) : '',
        contentEncoding: ['gzip', 'br', 'deflate', 'identity'].includes(h['content-encoding']) ? h['content-encoding'] : h['content-encoding'] ? 'other' : 'identity' });
      if (row.fromServiceWorker) remember('Service worker response is outside the owned static audit');
    });
    lane.on('Network.requestServedFromCache', value => { const row = requests.get(lane.id + ':' + value.requestId); if (row) row.servedFromCache = true; });
    lane.on('Network.dataReceived', value => { const row = requests.get(lane.id + ':' + value.requestId); if (row) row.decodedBytes += value.dataLength; });
    lane.on('Network.loadingFinished', value => { const row = requests.get(lane.id + ':' + value.requestId); if (row) Object.assign(row, { complete: true, networkTransferBytes: value.encodedDataLength }); });
    lane.on('Network.loadingFailed', value => { const row = requests.get(lane.id + ':' + value.requestId); if (row) { row.failed = true; remember('Budgeted resource request failed'); } });
  }
  function makeChild(parent, event) {
    const id = 'worker-' + (++laneSerial), callbacks = new Map(), listeners = new Map(); let commandId = 0;
    const onMessage = event_ => {
      if (event_.sessionId !== event.sessionId) return;
      let message; try { message = JSON.parse(event_.message); } catch { remember('Malformed worker protocol response'); return; }
      if (message.id) { const callback = callbacks.get(message.id); callbacks.delete(message.id); if (callback) message.error ? callback.reject(Error('Worker protocol command failed')) : callback.resolve(message.result); }
      else for (const fn of listeners.get(message.method) ?? []) fn(message.params);
    };
    parent.on('Target.receivedMessageFromTarget', onMessage);
    const lane = { id, scripts: new Map(), detached: false,
      on(method, fn) { const list = listeners.get(method) ?? []; list.push(fn); listeners.set(method, list); },
      off(method, fn) { const list = listeners.get(method) ?? []; listeners.set(method, list.filter(item => item !== fn)); },
      send(method, params = {}) {
        const messageId = ++commandId;
        return bounded(new Promise((resolve, reject) => { callbacks.set(messageId, { resolve, reject }); parent.send('Target.sendMessageToTarget', { sessionId: event.sessionId, message: JSON.stringify({ id: messageId, method, params }) }).catch(reject); })).finally(() => callbacks.delete(messageId));
      },
    };
    const onDetached = detached => {
      if (detached.sessionId !== event.sessionId) return;
      lane.detached = true; for (const callback of callbacks.values()) callback.reject(Error('Worker detached')); callbacks.clear();
      parent.off('Target.receivedMessageFromTarget', onMessage); parent.off('Target.detachedFromTarget', onDetached);
      if (active) remember('Worker terminated before byte audit snapshot');
    };
    parent.on('Target.detachedFromTarget', onDetached);
    return lane;
  }
  async function configure(lane, waiting = false) {
    lanes.set(lane.id, lane); wire(lane);
    lane.on('Target.attachedToTarget', event => {
      if (event.targetInfo?.type !== 'worker') {
        remember('Unexpected attached execution target');
        track(lane.send('Target.sendMessageToTarget', { sessionId: event.sessionId, message: JSON.stringify({ id: 1, method: 'Runtime.runIfWaitingForDebugger' }) }).catch(() => remember('Could not resume unsupported execution target'))); return;
      }
      const child = makeChild(lane, event);
      if (!event.waitingForDebugger) remember('Worker attachment occurred after execution could begin');
      track(configure(child, true).catch(() => remember('Worker byte instrumentation failed')));
    });
    try {
      await lane.send('Network.enable', { maxTotalBufferSize: 128 * 1048576, maxResourceBufferSize: MAX_BODY });
      await lane.send('Debugger.enable'); await lane.send('Profiler.enable');
      await lane.send('Profiler.startPreciseCoverage', { callCount: true, detailed: false, allowTriggeredUpdates: false });
      await lane.send('Runtime.enable'); await lane.send('Runtime.evaluate', { expression: OBSERVE, returnByValue: true });
      if (lane.id === 'page') await lane.send('Page.enable');
      await lane.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: false });
    } finally { if (waiting) await lane.send('Runtime.runIfWaitingForDebugger'); }
  }
  async function start() {
    if (profiling || engine !== 'chromium') return;
    session = await context.newCDPSession(page);
    const ownedSession = session;
    const lane = { id: 'page', scripts: new Map(), on: (method, fn) => ownedSession.on(method, fn), off: (method, fn) => ownedSession.off(method, fn), send: (method, params) => bounded(ownedSession.send(method, params)) };
    try { await configure(lane); profiling = true; }
    catch (error) { await releaseInstrumentation(); throw error; }
  }
  async function begin({ id, cache, scope = 'startup', featureId, byteAudit = false } = {}) {
    if (closed || active) throw Error('D11 byte audit is already active or closed');
    if (byteAudit !== true) throw Error('D11 precise coverage requires explicit byteAudit:true and cannot share scored latency');
    if (!['cold', 'warm'].includes(cache) || !['startup', 'text-engine', 'lazy-feature'].includes(scope) || typeof id !== 'string' || !/^[A-Za-z0-9:._/-]{1,256}$/.test(id)) throw Error('Invalid byte audit identity/scope/cache');
    if (scope === 'lazy-feature' && !build.dynamicFeatures.some(row => row.id === featureId)) throw Error('Unknown exact lazy feature');
    missing.clear(); requests.clear();
    for (const [id, lane] of lanes) if (lane.detached) lanes.delete(id);
    ordinal++; totalRecords = 0;
    const startedBeforeNavigation = ['about:blank', ''].includes(page.url());
    active = { id, cache, scope, featureId, ordinal, startedBeforeNavigation, baselineComplete, instrumentation: 'precise-coverage-byte-audit', timingSamplesReusable: false, cachePolicy };
    if (engine !== 'chromium') remember('Actual evaluated-module coverage unavailable in this browser engine');
    else try { await start(); } catch { remember('Could not start complete Chromium byte coverage'); }
    await Promise.allSettled([...pending]);
    for (const lane of lanes.values()) if (!lane.detached) {
      try {
        // A feature boundary excludes earlier resource entries in the same
        // realm, while a new navigation resets its independent time origin.
        const previous = (await lane.send('Runtime.evaluate', { expression: READ_REALM, returnByValue: true })).result?.value;
        lane.timingBaseline = previous ? { timeOrigin: previous.timeOrigin, rows: previous.rows.length } : null;
        await lane.send('Profiler.takePreciseCoverage');
      } catch { remember('Could not establish the beginning of the byte-audit interval'); }
    }
    return { kind: 'd11-byte-audit-start-1', id, cache, scope, instrumentation: active.instrumentation, timingSamplesReusable: false };
  }
  async function collectLane(lane, evaluated, timings, fonts, browserProfile) {
    if (lane.detached) return;
    try {
      const coverage = await lane.send('Profiler.takePreciseCoverage');
      for (const script of coverage.result ?? []) {
        const identity = lane.scripts.get(script.scriptId), functions = script.functions ?? [];
        const executedFunctions = functions.filter(fn => fn.ranges?.some(range => range.count > 0)).length;
        if (!identity || !executedFunctions) continue;
        const source = await lane.send('Debugger.getScriptSource', { scriptId: script.scriptId });
        if (typeof source.scriptSource !== 'string' || Buffer.byteLength(source.scriptSource) > MAX_SOURCE || hash(source.scriptSource) !== identity.sha256) { remember('Executed source differs from exact emitted bytes'); continue; }
        evaluated.push({ file: identity.file, sha256: identity.sha256, rawBytes: Buffer.byteLength(source.scriptSource), owner: lane.id,
          executedFunctions, newlyEvaluated: !seenFiles.has(lane.id + ':' + identity.file) });
      }
      const realm = (await lane.send('Runtime.evaluate', { expression: READ_REALM, returnByValue: true })).result?.value;
      if (!realm || realm.unsupported || realm.overflow || !Array.isArray(realm.rows)) remember('Complete realm Resource Timing unavailable');
      else for (const value of [...realm.rows.slice(lane.timingBaseline?.timeOrigin === realm.timeOrigin ? lane.timingBaseline.rows : 0),
        ...(lane.timingBaseline?.timeOrigin === realm.timeOrigin ? [] : realm.navigation ?? [])]) {
        const identity = identify(value.name); if (!identity) continue;
        timings.push({ owner: lane.id, resourceId: identity.id, startTime: value.startTime, duration: value.duration,
          transferSize: value.transferSize, encodedBodySize: value.encodedBodySize, decodedBodySize: value.decodedBodySize,
          responseStatus: value.responseStatus, deliveryType: ['cache', 'navigational-prefetch', ''].includes(value.deliveryType) ? value.deliveryType : 'other' });
      }
      if (lane.id === 'page' && realm?.fonts) Object.assign(fonts, { observed: true, status: realm.fonts.status,
        faces: realm.fonts.faces.map(face => ({ identity: hash(JSON.stringify({ family: face.family, style: face.style, weight: face.weight, stretch: face.stretch })), status: face.status })) });
      if (lane.id === 'page' && realm?.browserProfile) Object.assign(browserProfile, realm.browserProfile);
    } catch { remember('Could not complete an executing realm byte snapshot'); }
  }
  async function snapshot() {
    if (!active) throw Error('D11 byte audit has not begun');
    for (let round = 0; pending.size && round < 8; round++) await Promise.allSettled([...pending]);
    if (pending.size) remember('Worker instrumentation did not settle before byte snapshot');
    const stamp = () => JSON.stringify({ lanes: [...lanes.values()].map(lane => [lane.id, lane.detached === true, [...lane.scripts.keys()]]),
      requests: [...requests.values()].map(row => [row.owner, row.requestId, row.complete, row.failed === true, row.decodedBytes]), pending: pending.size });
    const beforeSnapshot = stamp();
    const evaluated = [], timings = [], fonts = { observed: false }, browserProfile = { observed: false };
    for (const lane of lanes.values()) await collectLane(lane, evaluated, timings, fonts, browserProfile);
    const resources = [], timingOffsets = new Map();
    for (const row of requests.values()) {
      if (row.ordinal !== ordinal) continue;
      // Exact font availability HEAD probes share the same URL but have no
      // body; do not join their timing to a later actual font GET response.
      const candidates = timings.filter(item => item.owner === row.owner && item.resourceId === row.id && item.decodedBodySize === row.rawBytes);
      const offsetKey = row.owner + ':' + row.id, offset = timingOffsets.get(offsetKey) ?? 0;
      const timing = candidates[offset] ?? null; timingOffsets.set(offsetKey, offset + 1);
      let verified = false, gzipBytes = row.gzipBytes;
    if (!row.complete || row.failed) remember('Resource did not complete before the declared byte boundary');
      if (![200, 304].includes(row.status)) remember('Budgeted resource did not have a complete successful response');
      if (!timing) remember('Network resource lacks its matching Resource Timing entry');
      if (row.complete && !row.failed && row.rawBytes <= MAX_BODY) try {
        const body = await row.lane.send('Network.getResponseBody', { requestId: row.requestId });
        if (typeof body.body !== 'string' || body.body.length > Math.ceil(MAX_BODY * 4 / 3) + 4) throw Error('Response exceeds byte-audit memory bound');
        const bytes = Buffer.from(body.body, body.base64Encoded ? 'base64' : 'utf8');
        verified = bytes.length === row.rawBytes && hash(bytes) === row.sha256;
        if (!verified) remember('Delivered resource bytes differ from their immutable identity');
        if (gzipBytes === undefined) gzipBytes = gzipSync(bytes).length;
      } catch { remember('Exact resource response bytes unavailable'); }
      resources.push({ id: row.id, file: row.file, owner: row.owner, kind: row.kind, role: row.role, sha256: row.sha256,
        rawBytes: row.rawBytes, gzipBytes, verified, networkTransferBytes: row.networkTransferBytes,
        status: row.status, cacheControl: row.cacheControl, contentEncoding: row.contentEncoding,
        fromDiskCache: row.fromDiskCache, servedFromCache: row.servedFromCache === true, fromServiceWorker: row.fromServiceWorker, timing });
    }
    // Reading inspector sources/resources is asynchronous. Reject a boundary
    // which admitted a new module, target or request while its snapshot was
    // being gathered, including a previously parsed module executing late.
    for (const lane of lanes.values()) if (!lane.detached) {
      try {
        const late = await lane.send('Profiler.takePreciseCoverage');
        for (const script of late.result ?? []) {
          const identity = lane.scripts.get(script.scriptId);
          if (identity && script.functions?.some(fn => fn.ranges?.some(range => range.count > 0)) && !evaluated.some(row => row.owner === lane.id && row.file === identity.file)) remember('An additional module executed during byte snapshot');
        }
      } catch { remember('Could not verify the closing execution boundary'); }
    }
    if (stamp() !== beforeSnapshot) remember('Execution or resource inventory changed during byte snapshot');
    const observation = { ...active, buildSha256: build.sha256, authoringFontIdentities: Object.values(fontAssets), fixtureSeal: fixture?.seal?.sha256 ?? null, evaluated, resources, fonts, browserProfile, missing: [...missing],
      collection: { complete: !missing.size && engine === 'chromium' && lanes.size > 0, realms: [...lanes.keys()], recordLimit: MAX_RECORDS } };
    const result = analyzeD11Observation(observation, build);
    const path = join(output, 'd11-byte-audit-' + randomUUID() + '.json'), bytes = Buffer.from(JSON.stringify({ observation, result, build }, null, 2) + '\n');
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    const artifact = { path, sha256: hash(bytes), byteLength: String(bytes.length) };
    for (const row of evaluated) seenFiles.add(row.owner + ':' + row.file);
    if (active.scope === 'startup') baselineComplete = result.missing.length === 0;
    active = null;
    return { ...result, artifact, evaluatedModuleCount: evaluated.length, resourceCount: resources.length };
  }
  async function releaseInstrumentation() {
    // Stop every enabled facility independently: a Target-domain failure must
    // not skip restoring normal optimized execution in another facility.
    await Promise.allSettled([...lanes.values()].filter(lane => !lane.detached).map(async lane => {
      for (const [method, params] of [['Profiler.stopPreciseCoverage', {}], ['Profiler.disable', {}], ['Debugger.disable', {}],
        ['Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: false }]]) {
        try { await lane.send(method, params); } catch { /* Target may already be gone. */ }
      }
    }));
    await session?.detach().catch(() => {}); session = undefined; profiling = false; lanes.clear();
  }
  async function close() {
    if (closed) return; closed = true;
    await releaseInstrumentation();
  }
  return { begin, snapshot, close, buildIdentity: build.sha256, instrumentation: 'precise-coverage-byte-audit', timingSamplesReusable: false };
}
