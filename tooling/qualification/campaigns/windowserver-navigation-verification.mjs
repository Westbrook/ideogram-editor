import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, open, readdir, realpath} from 'node:fs/promises';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {fileURLToPath} from 'node:url';
import {startWindowServerCapture} from './windowserver-process.mjs';
import {validateWindowServerReady, verifyWindowServerCapture} from './windowserver-presentation.mjs';
import {verifyWindowServerBuildEvidence} from '../native/windowserver-build.mjs';
import {navigationEnvironmentBinding, nativeNavigationConfiguration, navigationAttemptBinding,
  validateNavigationOracle, validateNavigationWitness, joinNavigationWindowServerPixels} from './windowserver-navigation-contract.mjs';
import {normalizeResult} from './worker.mjs';
import {sanitize} from './common.mjs';
import {verifyNavigationStatus} from './navigation-status.mjs';

const proofs = new WeakMap(), ownedCaptures = new WeakMap();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const demand = (condition, message) => {if (!condition) throw Error(message);};
const same = (a, b, message) => demand(isDeepStrictEqual(a, b), message);
const bare = value => typeof value === 'string' ? value.replace(/^sha256:/, '') : value;
const pin = value => typeof bare(value) === 'string' && /^[a-f0-9]{64}$/.test(bare(value));
const integer = value => Number.isSafeInteger(value) && value >= 0;
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const json = bytes => JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
const buildMembers = ['manifest.json', 'build-receipt.json', 'collector.swift', 'sdk-manifest.json', 'version.stdout.log', 'version.stderr.log', 'build.stdout.log', 'build.stderr.log', 'windowserver-capture'];
const unavailable = message => {throw Object.assign(Error(message), {code: 'NAVIGATION_REPLAY_UNAVAILABLE'});};
const snapshotStopped = value => ({manifest: value.manifest, process: value.process});

/** Only this actual-supervisor wrapper can create live ownership authority.
 * A pure capture parser, injected fake, copied result or serialized receipt
 * cannot enter ownedCaptures. Input identity is captured before any await. */
export async function startNavigationWindowServerCapture(options) {
  demand(options && typeof options === 'object' && !Array.isArray(options), 'Navigation supervisor options are required');
  demand(process.versions.node === '26.10.0', 'Navigation live ownership requires the pinned Node runtime');
  const {navigationBinding, abortSignal, ...supplied} = options;
  const binding = structuredClone(navigationBinding), actual = structuredClone(supplied);
  demand(binding && ['anchor', 'shell', 'canvas'].includes(binding.stage) && typeof binding.navigationNonce === 'string' &&
    /^[a-f0-9]{48}$/.test(binding.navigationNonce) && binding.invocation?.workerProcessIdentity?.pid === process.pid,
  'Navigation capture needs its exact current worker and navigation binding');
  const source = await ordinaryBytes(fileURLToPath(new URL('../native/windowserver-capture.swift', import.meta.url)), 1024 ** 2);
  demand(bare(actual.build?.sourceSha256) === hash(source), 'Navigation live binary is not built from this control collector source');
  const ownerPid = process.pid, clocks = [];
  const capture = await startWindowServerCapture({...actual, abortSignal});
  const ready = structuredClone(capture.ready), processIdentity = structuredClone(capture.processIdentity);
  demand(processIdentity?.ownerPid === ownerPid, 'Navigation native supervisor belongs to another worker');
  let stopped;
  const handle = Object.freeze({ready: structuredClone(ready), processIdentity: structuredClone(processIdentity),
    captureClock: async id => {const value = await capture.captureClock(id); clocks.push(structuredClone(value)); return value;},
    waitForPixelHash: (...args) => capture.waitForPixelHash(...args),
    stop() {
      stopped ??= (async () => {
        const value = await capture.stop();
        ownedCaptures.set(value, {handle, ownerPid, binding, actual, ready, processIdentity,
          clocks: structuredClone(clocks), stopped: structuredClone(snapshotStopped(value)), used: false});
        return value;
      })();
      return stopped;
    },
  });
  return handle;
}

async function ordinaryBytes(absolute, maximum) {
  demand(isAbsolute(absolute) && resolve(absolute) === absolute && await realpath(absolute) === absolute, 'Navigation ordinary file is not canonical');
  const named = await lstat(absolute), handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat(), fields = ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'];
    demand(before.isFile() && !named.isSymbolicLink() && before.size <= maximum && fields.every(key => before[key] === named[key]), 'Navigation ordinary file changed before read');
    const value = Buffer.alloc(before.size); let offset = 0;
    while (offset < value.length) {const {bytesRead} = await handle.read(value, offset, value.length - offset, offset); demand(bytesRead > 0, 'Navigation ordinary file shortened'); offset += bytesRead;}
    const after = await handle.stat(), current = await lstat(absolute);
    demand(current.isFile() && !current.isSymbolicLink() && fields.every(key => before[key] === after[key] && after[key] === current[key]), 'Navigation ordinary file changed during read');
    return value;
  } finally {await handle.close();}
}

function navigationScope(cell, sample) {
  return cell?.id === `H1/chromium-${cell.workload}-ready` && cell.operation === 'navigation.ready' && cell.host === 'H' &&
    cell.kind === 'navigation' && ['W0', 'W1'].includes(cell.workload) && (cell.parameters?.browser ?? 'chromium') === 'chromium' &&
    ['cold', 'warm'].includes(sample?.cache) && integer(sample.ordinal) && sample.ordinal > 0 && typeof sample.prime === 'boolean';
}

export function readVerifiedNavigationBounds(proof, observation, {cell, sample} = {}) {
  const entry = proofs.get(proof);
  if (!entry || !navigationScope(cell, sample) || !isDeepStrictEqual(entry.cell, cell) ||
    !isDeepStrictEqual(entry.sample, {cache: sample.cache, ordinal: sample.ordinal, prime: sample.prime}) ||
    !isDeepStrictEqual(entry.observation, observation)) return null;
  return structuredClone(entry.value);
}

function mint(observation, cell, sample, value) {
  const proof = Object.freeze({kind: 'verified-navigation-windowserver-bounds-1', qualification: false});
  proofs.set(proof, {observation: structuredClone(observation), cell: structuredClone(cell),
    sample: {cache: sample.cache, ordinal: sample.ordinal, prime: sample.prime}, value: structuredClone(value)});
  return proof;
}

/** Add only this native route's bounded raw closure to the existing evidence
 * inventory. JSON and ordinary logs remain covered by the shared inventory. */
export function isNavigationNativeEvidencePath(path) {
  return /(?:^|\/)native-nav-[a-f0-9]{48}-(?:anchor|shell|canvas)\/(?:stdout\.ndjson|capture\/(?:frames\.ndjson|frame-[1-9][0-9]*\.bgra)|build-evidence\/(?:collector\.swift|windowserver-capture))$/.test(path) ||
    /(?:^|\/)oracle-nav-[a-f0-9]{48}-(?:shell|canvas)\/(?:before|after)\.bgra$/.test(path);
}

function relativeMember(path) {
  demand(typeof path === 'string' && path && !isAbsolute(path) && !path.includes('\\') &&
    path.split('/').every(part => part && part !== '.' && part !== '..'), 'Unsafe navigation retained member');
  return path;
}
function reader({groupOutput, retainedPaths, readRetained, resolveRetained}) {
  demand(isAbsolute(groupOutput ?? '') && resolve(groupOutput) === groupOutput && Array.isArray(retainedPaths) &&
    typeof readRetained === 'function' && typeof resolveRetained === 'function', 'Navigation retained boundary unavailable');
  const paths = new Set(retainedPaths.map(relativeMember));
  demand(paths.size === retainedPaths.length, 'Duplicate navigation retained member');
  const local = path => {
    demand(typeof path === 'string' && isAbsolute(path) && resolve(path) === path && path.startsWith(groupOutput + sep), 'Navigation artifact leaves its original group');
    return relativeMember(relative(groupOutput, path).split(sep).join('/'));
  };
  const bytes = async (path, identity, maximum) => {
    relativeMember(path); if (!paths.has(path)) unavailable('Navigation original member is not retained: ' + path);
    if (identity) demand(integer(identity.bytes) && identity.bytes <= maximum && pin(identity.sha256), 'Malformed navigation member pin');
    const value = await readRetained(path, {maximum});
    demand(Buffer.isBuffer(value) && value.length <= maximum, 'Navigation member exceeds its bounded reader');
    if (identity) demand(value.length === identity.bytes && hash(value) === bare(identity.sha256), 'Navigation member differs from original pin');
    return value;
  };
  return {paths, local, bytes, resolveRetained};
}

async function liveReaders(output, nonce) {
  demand(isAbsolute(output ?? '') && resolve(output) === output && await realpath(output) === output, 'Navigation live output is not canonical');
  const resolveRetained = async path => {
    let current = output;
    for (const [index, part] of relativeMember(path).split('/').entries()) {
      current = join(current, part); const stat = await lstat(current);
      demand(!stat.isSymbolicLink() && (index === path.split('/').length - 1 ? stat.isFile() : stat.isDirectory()), 'Navigation live member is not an ordinary path');
    }
    demand(await realpath(current) === current, 'Navigation live member traverses a symlink'); return current;
  };
  const retainedPaths = [];
  const visit = async (path, depth = 0) => {
    demand(depth < 5 && retainedPaths.length < 20_000, 'Navigation live inventory exceeds its finite boundary');
    const absolute = join(output, path), info = await lstat(absolute);
    demand(!info.isSymbolicLink(), 'Symlink in navigation live inventory');
    if (info.isFile()) {retainedPaths.push(path); return;}
    demand(info.isDirectory(), 'Nonordinary navigation live inventory member');
    for (const name of await readdir(absolute)) await visit(path + '/' + name, depth + 1);
  };
  for (const name of await readdir(output)) {
    if (['input.json', 'browser-runtime.json', 'navigation-nav-' + nonce + '.json'].includes(name) ||
      /^owned-process-[1-9][0-9]*-[a-f0-9-]{36}\.json$/.test(name) ||
      ['anchor', 'shell', 'canvas'].some(stage => name === 'native-nav-' + nonce + '-' + stage) ||
      ['shell', 'canvas'].some(stage => name === 'oracle-nav-' + nonce + '-' + stage)) await visit(name);
  }
  const readRetained = async (path, {maximum} = {}) => {
    demand(integer(maximum) && maximum <= 256 * 1024 ** 2, 'Navigation live read bound is absent');
    const absolute = await resolveRetained(path), named = await lstat(absolute), handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      const fields = ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'];
      demand(before.isFile() && before.size <= maximum && fields.every(key => before[key] === named[key]), 'Navigation live input changed before read');
      const value = Buffer.alloc(before.size); let offset = 0;
      while (offset < value.length) {const {bytesRead} = await handle.read(value, offset, value.length - offset, offset); demand(bytesRead > 0, 'Navigation live input shortened'); offset += bytesRead;}
      const after = await handle.stat(), current = await lstat(absolute);
      demand(current.isFile() && !current.isSymbolicLink() && fields.every(key => before[key] === after[key] && after[key] === current[key]), 'Navigation live input changed during replay');
      return value;
    } finally {await handle.close();}
  };
  return {groupOutput: output, retainedPaths, readRetained, resolveRetained};
}

function ndjson(value, maximum) {
  const text = new TextDecoder('utf-8', {fatal: true}).decode(value);
  demand(text.endsWith('\n'), 'Navigation native record stream is incomplete');
  const lines = text.slice(0, -1).split('\n'); demand(lines.length <= maximum, 'Navigation native record count exceeds its bound');
  return lines.map(line => {demand(line && Buffer.byteLength(line) <= 16384, 'Navigation native record exceeds its bound'); return JSON.parse(line);});
}

async function replayCapture({stage, observation, expectedConfig, selection, binding, groupOutput, workerPid, io}) {
  const {bytes, local, paths, resolveRetained} = io, value = observation.captures?.[stage];
  if (!value?.process?.receipt || !value.evidence?.manifest) unavailable('Navigation capture segment is incomplete: ' + stage);
  const directory = 'native-nav-' + observation.navigationNonce + '-' + stage, captureDirectory = directory + '/capture';
  const processPin = value.process.receipt;
  demand(processPin.path === join(groupOutput, directory, 'process.json'), 'Navigation segment process path differs');
  const processRecord = json(await bytes(directory + '/process.json', processPin, 1024 ** 2));
  const {receipt: ignored, ...reportedProcess} = value.process;
  same(sanitize(processRecord), reportedProcess, 'Navigation process observation differs from original process receipt');
  if (processRecord.outcome !== 'CAPTURE_REPLAYED' || processRecord.failure || processRecord.cleanupErrors?.length || processRecord.requestedSignals?.length ||
    processRecord.exit?.code !== 0 || processRecord.exit.signal !== null || processRecord.close?.code !== 0 || processRecord.close.signal !== null) unavailable('Navigation process did not complete its original capture');
  demand(processRecord.kind === 'windowserver-owned-process-1' && processRecord.schemaVersion === 1, 'Navigation process protocol differs');
  const owner = processRecord.processIdentity;
  demand(owner?.kind === 'windowserver' && owner.ownerPid === workerPid && owner.pid > 1 && owner.pgid === owner.pid &&
    typeof owner.startedAtIdentity === 'string' && owner.startedAtIdentity, 'Navigation collector ownership differs');
  same(json(await bytes(local(processRecord.registration?.path), processRecord.registration, 65536)),
    {kind: 'perf-owned-processes-1', ownerPid: workerPid, processes: [{kind: 'windowserver', pid: owner.pid, pgid: owner.pgid, startedAtIdentity: owner.startedAtIdentity, executable: owner.executable}]}, 'Navigation collector registration differs');
  demand(processRecord.config?.path === 'config.json', 'Navigation config member differs');
  same(json(await bytes(directory + '/config.json', processRecord.config, 8192)), expectedConfig, 'Navigation original capture config differs');
  same(processRecord.build, {...selection.build, sourceSha256: bare(binding.collectorSource.sha256)}, 'Navigation native build invocation differs');
  const buildEvidence = processRecord.buildEvidence;
  demand(buildEvidence?.path === 'build-evidence/manifest.json' && buildEvidence.sourceSha256 === bare(binding.collectorSource.sha256) && buildEvidence.receiptSha256 === selection.build.receiptSha256, 'Navigation native retained build identity differs');
  for (const name of buildMembers) if (!paths.has(directory + '/build-evidence/' + name)) unavailable('Navigation native build closure is incomplete');
  await bytes(directory + '/' + buildEvidence.path, buildEvidence, 128 * 1024 ** 2);
  const build = await verifyWindowServerBuildEvidence({directory: dirname(await resolveRetained(directory + '/build-evidence/manifest.json')), manifestSha256: bare(buildEvidence.sha256), sourceSha256: buildEvidence.sourceSha256});
  demand(build.receiptSha256 === selection.build.receiptSha256 && build.binarySha256 === buildEvidence.binarySha256 && processRecord.executable?.sha256 === buildEvidence.binarySha256, 'Navigation executed native binary differs');
  await bytes(directory + '/build-evidence/windowserver-capture', processRecord.executable, 64 * 1024 ** 2);
  same(processRecord.command, [owner.executable, join(groupOutput, directory, 'config.json'), join(groupOutput, captureDirectory)], 'Navigation native command differs');
  demand(processRecord.executable.path === owner.executable && owner.executable === join(dirname(processRecord.build.receiptPath), 'windowserver-capture') && processRecord.outputDirectory === join(groupOutput, captureDirectory), 'Navigation native output or executable differs');
  demand(processRecord.stdout?.path === 'stdout.ndjson' && processRecord.stderr?.path === 'stderr.log' && processRecord.manifest?.path === 'capture/manifest.json', 'Navigation native member paths differ');
  const stdout = await bytes(directory + '/stdout.ndjson', processRecord.stdout, 8 * 1024 ** 2 + 65536), stderr = await bytes(directory + '/stderr.log', processRecord.stderr, 1024 ** 2);
  same(processRecord.streamBytesObserved, {stdout: stdout.length, stderr: stderr.length}, 'Navigation original stream sizes differ');
  const manifestBytes = await bytes(captureDirectory + '/manifest.json', processRecord.manifest, 2 * 1024 ** 2), manifest = json(manifestBytes);
  same(manifest.config, expectedConfig, 'Navigation native manifest config differs');
  same(value.evidence.manifest, {path: join(groupOutput, captureDirectory, 'manifest.json'), bytes: manifestBytes.length, sha256: hash(manifestBytes)}, 'Navigation manifest pin differs');
  const framesBytes = await bytes(captureDirectory + '/frames.ndjson', manifest.frames, 8 * 1024 ** 2);
  const records = ndjson(framesBytes, expectedConfig.maxFrames + 256), controlRows = ndjson(stdout, expectedConfig.maxFrames + 258);
  const ready = controlRows.filter(row => row.event === 'ready'), stopped = controlRows.filter(row => row.event === 'stopped');
  demand(ready.length === 1 && stopped.length === 1 && controlRows.at(-1) === stopped[0], 'Navigation native protocol has no unique closed ready/stop sequence');
  same(ready[0], value.ready, 'Navigation native ready alias differs'); validateWindowServerReady(ready[0], {config: expectedConfig, outputDirectory: join(groupOutput, captureDirectory)});
  for (const key of ['config', 'display', 'captureGeometry', 'windowAdmission', 'timebase', 'startedMach']) same(ready[0][key], manifest[key], 'Navigation native ready/manifest identity differs: ' + key);
  same(stopped[0], {schemaVersion: 1, event: 'stopped', terminalReason: manifest.terminalReason, endedMach: manifest.endedMach, manifest: 'manifest.json'}, 'Navigation native stop differs');
  same(controlRows.filter(row => !['ready', 'stopped'].includes(row.event)), records.filter(row => row.event === 'clock' || row.event === 'sample' && row.retained === true), 'Navigation native stdout and record stream differ');
  const pixels = new Map(); demand(Array.isArray(manifest.pixelFiles) && manifest.pixelFiles.length <= expectedConfig.maxFrames, 'Navigation native pixel inventory unavailable');
  let total = 0;
  for (const member of manifest.pixelFiles) {
    demand(/^frame-[1-9][0-9]*\.bgra$/.test(member.path) && !pixels.has(member.path) && member.bytes === expectedConfig.roi.width * expectedConfig.roi.height * 4, 'Navigation native pixel identity differs');
    total += member.bytes; demand(total <= expectedConfig.maxBytes, 'Navigation native pixel budget exceeded');
    pixels.set(member.path, await bytes(captureDirectory + '/' + member.path, member, expectedConfig.maxBytes));
  }
  same([...paths].filter(path => path.startsWith(captureDirectory + '/')).sort(), [captureDirectory + '/manifest.json', captureDirectory + '/frames.ndjson', ...manifest.pixelFiles.map(member => captureDirectory + '/' + member.path)].sort(), 'Navigation original capture membership differs');
  verifyWindowServerCapture({manifestBytes, framesBytes, pixels}, {manifestSha256: hash(manifestBytes)});
  return {raw: {manifestBytes, framesBytes, pixels}, manifest, records, controlRows, processRecord, ready: ready[0], clocks: controlRows.filter(row => row.event === 'clock')};
}

async function replayOwnedRuntime({io, runtime, fixture, workerPid, sourceRoot, browserCache, tools, developerState, developerStateIdentity, environment, live}) {
  const actual = json(await io.bytes('browser-runtime.json', null, 1024 ** 2)); same(runtime, actual, 'Navigation browser runtime differs from original launch');
  demand(runtime.headless === false && runtime.engine === 'chromium' && runtime.browserPid > 1 && runtime.backendPid > 1 &&
    runtime.ownedLaunch?.context?.createdBy === 'browser.newContext' && isAbsolute(sourceRoot ?? '') &&
    runtime.playwrightModule?.startsWith(join(sourceRoot, 'node_modules') + sep) && pin(runtime.executableIdentity?.sha256), 'Navigation requires the actual owned headed Chromium runtime');
  same(runtime.fixtureSeal, fixture?.seal, 'Navigation browser fixture differs');
  for (const kind of ['browser', 'backend']) {
    const pid = runtime[kind + 'Pid'], matches = [...io.paths].filter(path => new RegExp('^owned-process-' + pid + '-[a-f0-9-]{36}\\.json$').test(path));
    demand(matches.length === 1, 'Navigation process ownership is absent or ambiguous');
    const registration = json(await io.bytes(matches[0], null, 65536)), processRecord = registration.processes?.[0];
    demand(registration.kind === 'perf-owned-processes-1' && registration.ownerPid === workerPid && registration.processes?.length === 1 &&
      processRecord.kind === kind && processRecord.pid === pid && processRecord.pgid > 1 && typeof processRecord.startedAtIdentity === 'string' && processRecord.startedAtIdentity.length > 0, 'Navigation browser/backend ownership differs');
    if (kind === 'browser') demand(processRecord.executable === runtime.executable &&
      runtime.ownedLaunch.process?.registration?.path === join(io.groupOutput ?? '', matches[0]) && runtime.ownedLaunch.process?.startedAtIdentity === processRecord.startedAtIdentity, 'Navigation browser executable/birth differs');
  }
  // The live worker already consumed immutable input.json and owns its native
  // supervisor results. Offline replay additionally reestablishes preparation
  // and browser-tool authority from the outer campaign's original receipts.
  if (live) return;
  demand(developerState?.kind === 'developer-runtime-state-1' && pin(developerStateIdentity?.sha256) &&
    hash(Buffer.from(JSON.stringify(developerState.state, null, 2) + '\n')) === bare(developerState.sha256), 'Navigation consumed developer state is unavailable');
  const state = developerState.state, workspace = state.h?.source === sourceRoot ? state.h : state.p;
  const complete = workspace === state.h ? workspace?.completed === true : workspace?.completed?.includes('production-build') && workspace.completed.includes('browser-cache');
  demand(complete && !workspace.failure && !workspace.active && workspace.source === sourceRoot && state.productRepo === sourceRoot &&
    bare(state.sourceDigest) === bare(environment.sourceDigest), 'Navigation prepared source differs');
  const expectedCache = state.playwrightBrowsersPath ?? workspace.browserCache;
  demand(isAbsolute(expectedCache ?? '') && browserCache === expectedCache && runtime.executable?.startsWith(expectedCache + sep), 'Navigation prepared browser cache differs');
  const prepared = workspace.browserIdentity?.engines?.filter(value => value.engine === 'chromium');
  demand(prepared?.length === 1 && prepared[0].executable === runtime.executable && prepared[0].version === runtime.version && prepared[0].revision === runtime.revision &&
    prepared[0].bytes === runtime.executableIdentity.bytes && bare(prepared[0].sha256) === bare(runtime.executableIdentity.sha256), 'Navigation actual browser differs from prepared executable');
  const pinned = tools?.browserPins?.browsers?.filter(value => value.name === 'chromium');
  demand(pinned?.length === 1 && pinned[0].revision === runtime.revision && pinned[0].browserVersion === runtime.version, 'Navigation actual browser differs from pinned tool revision');
}

async function replayNavigation(context) {
  const {cell, sample, serial, fixture, invocation, runtime, configuration, groupOutput, workerProcessIdentity,
    environment, controlFiles, sourceFiles, sourceRoot, result, actionCompleted, live} = context;
  if (!navigationScope(cell, sample) || actionCompleted !== true) return null;
  const reported = context.observation;
  if (!reported?.artifact || reported.missing?.length || reported.failures?.length) return null;
  const io = {...reader(context), groupOutput}, nonce = reported.navigationNonce;
  demand(/^[a-f0-9]{48}$/.test(nonce ?? '') && reported.nativeId === 'nv-' + nonce && reported.kind === 'navigation-windowserver-observation-1' && reported.qualification === false, 'Navigation observation identity differs');
  demand(reported.artifact.path === join(groupOutput, 'navigation-nav-' + nonce + '.json'), 'Navigation raw authority path differs');
  const observation = json(await io.bytes('navigation-nav-' + nonce + '.json', reported.artifact, 8 * 1024 ** 2));
  demand(!Object.hasOwn(observation, 'artifact'), 'Navigation raw authority cannot contain its own pin');
  const completeObservation = {...observation, artifact: reported.artifact};
  same(live ? completeObservation : sanitize(completeObservation), reported, 'Navigation observation differs from original raw authority');
  const binding = observation.binding;
  demand(binding?.kind === 'navigation-windowserver-input-binding-1' && binding.navigationNonce === nonce, 'Navigation input binding identity differs');
  const selected = nativeNavigationConfiguration(configuration, runtime, {cell, sample}); if (!selected) return null;
  const attempt = navigationAttemptBinding({cell, sample, serial, fixture, invocation});
  same(binding.attempt, attempt, 'Navigation original attempt binding differs'); same(binding.invocation, invocation, 'Navigation invocation differs');
  same(binding.browser, runtime, 'Navigation browser binding differs'); same(binding.environment, navigationEnvironmentBinding(runtime, invocation), 'Navigation environment binding differs');
  same(binding.selection, selected.selection, 'Navigation selected native configuration differs'); same(binding.capturePlan, selected.capturePlan, 'Navigation capture reservation differs');
  same(invocation.workerProcessIdentity, workerProcessIdentity, 'Navigation worker birth differs'); same(invocation.environment, environment, 'Navigation source/build/host environment differs');
  demand(invocation.sourceRoot === sourceRoot && workerProcessIdentity?.node === 'v26.10.0', 'Navigation source/runtime root differs');
  const input = json(await io.bytes('input.json', null, 4 * 1024 ** 2));
  same(input.cell, cell, 'Navigation input cell differs'); same(input.navigationEnvironment, environment, 'Navigation immutable input environment differs');
  same(input.fixture, fixture, 'Navigation immutable input fixture differs'); same(input.configuration?.browser?.windowServerNavigation, configuration, 'Navigation immutable selection differs');
  demand(input.repo === sourceRoot && input.cache === sample.cache && input.attempts?.some(value => value.ordinal === sample.ordinal && value.prime === sample.prime), 'Navigation attempt is absent from immutable schedule');
  if (!live) {
    const collector = controlFiles?.filter(file => file.path === 'tooling/qualification/native/windowserver-capture.swift');
    demand(collector?.length === 1 && collector[0].bytes === binding.collectorSource?.bytes && bare(collector[0].sha256) === bare(binding.collectorSource.sha256), 'Navigation collector is not bound to campaign control source');
    for (const name of ['browser.mjs','browser-driver.mjs','browser-measurements.mjs','windowserver-navigation.mjs','windowserver-navigation-contract.mjs','windowserver-navigation-verification.mjs','navigation-status.mjs','worker.mjs','run.mjs','verification.mjs']) demand(controlFiles?.some(file => file.path === 'tooling/qualification/campaigns/' + name && pin(file.sha256)), 'Navigation control source closure is incomplete');
    for (const path of ['src/ui/shell.ts','src/state/editor-client.ts','src/observability/browser.ts','src/observability/navigation-observations.ts']) demand(sourceFiles?.some(file => file.path === path && pin(file.sha256)), 'Navigation application source closure is incomplete');
  }
  await replayOwnedRuntime({...context, io, workerPid: workerProcessIdentity.pid});
  const oracles = {};
  for (const endpoint of ['shell', 'canvas']) {
    const directory = 'oracle-nav-' + nonce + '-' + endpoint, identity = binding.oracles?.[endpoint];
    demand(identity?.path === join(groupOutput, directory, 'oracle.json') && bare(identity.sha256) === selected.profile[endpoint].sha256, 'Navigation semantic oracle selection differs');
    const oracleBytes = await io.bytes(directory + '/oracle.json', identity, 65536), oracle = json(oracleBytes), oraclePixels = new Map();
    demand(Array.isArray(identity.pixels) && identity.pixels.length === 2, 'Navigation semantic pixel inventory differs');
    for (const name of ['before.bgra', 'after.bgra']) {
      const pins = identity.pixels.filter(row => row.path === name); demand(pins.length === 1, 'Navigation semantic pixel pin is absent or ambiguous');
      oraclePixels.set(name, await io.bytes(directory + '/' + name, pins[0], 256 * 1024 ** 2));
    }
    same([...io.paths].filter(path => path.startsWith(directory + '/')).sort(), ['oracle.json','before.bgra','after.bgra'].map(name => directory + '/' + name).sort(), 'Navigation semantic oracle directory differs');
    validateNavigationOracle(oracle, oraclePixels, {endpoint, selection: selected, environment: binding.environment, attempt});
    oracles[endpoint] = {oracleBytes, oraclePixels, oracle};
  }
  const captures = {};
  for (const stage of ['anchor', 'shell', 'canvas']) captures[stage] = await replayCapture({stage, observation, expectedConfig: stage === 'anchor' ? selected.configs.anchor : {...selected.configs[stage], roi: oracles[stage].oracle.roi}, selection: selected.selection, binding, groupOutput, workerPid: workerProcessIdentity.pid, io});
  same(captures.anchor.clocks, [observation.anchor?.before], 'Navigation anchor clock stream differs');
  demand(observation.anchor?.after === null, 'Navigation stopped lower-anchor capture cannot claim an after-navigation ACK');
  same(captures.shell.clocks, [observation.readiness?.shell?.ack], 'Navigation shell clock stream differs');
  same(captures.canvas.clocks, [observation.readiness?.canvas?.ack], 'Navigation canvas clock stream differs');
  demand(new Set(Object.values(captures).map(value => value.processRecord.processIdentity.pid)).size === 3, 'Navigation capture stages reused a native process');
  demand(BigInt(captures.anchor.manifest.endedMach) <= BigInt(captures.shell.manifest.startedMach) &&
    BigInt(captures.shell.manifest.endedMach) <= BigInt(captures.canvas.manifest.startedMach),
  'Navigation native capture stages overlap or run out of order');
  demand(finite(observation.readiness?.shell?.receivedRunnerMs) && finite(observation.readiness?.canvas?.witness?.readyMs) &&
    observation.readiness.shell.receivedRunnerMs <= observation.readiness.canvas.witness.readyMs,
  'Navigation canvas witness precedes completion of the shell readiness ACK');
  const driver = result?.observations ?? result;
  demand(driver?.documentId === fixture.documentId && driver.acceptedTestEdit === true && driver.startupBoundary === 'document-ready-via-Open' && driver.publicOpenCompleted === true, 'Navigation actual public action did not complete');
  same(driver.nativeReadiness, {shell: observation.readiness.shell.witness, canvas: observation.readiness.canvas.witness}, 'Navigation original producer witnesses differ');
  same(driver.navigation, observation.readiness.shell.witness.navigation, 'Navigation original realm witness differs');
  same(observation.readiness.shell.witness.navigation, observation.readiness.canvas.witness.navigation, 'Navigation endpoints belong to different document realms');
  same(driver.navigationSemantic ?? null, observation.semanticWitness ?? null, 'Navigation semantic ledger differs from original driver');
  if (driver.navigationSemantic?.status) same(driver.navigationSemantic.status.timeOriginMs,
    observation.readiness.shell.witness.navigation.timeOrigin, 'Navigation semantic ledger belongs to a different document realm');
  const semantic = verifyNavigationStatus(driver.navigationSemantic, {navigationNonce: nonce, documentId: fixture.documentId,
    acceptedEdit: observation.readiness.canvas.witness.acceptedEdit, phaseSnapshot: driver.productPhases});
  const value = {exactLatency: false, semantic};
  for (const endpoint of ['shell', 'canvas']) {
    const readiness = observation.readiness[endpoint], {oracleBytes, oraclePixels, oracle} = oracles[endpoint];
    validateNavigationWitness(endpoint, readiness.witness, {navigationNonce: nonce, runtime, attempt, oracle});
    const joined = joinNavigationWindowServerPixels({anchor: captures.anchor.raw, target: captures[endpoint].raw},
      {endpoint, oracleBytes, oraclePixels, oracleSha256: selected.profile[endpoint].sha256, anchor: observation.anchor, readiness, binding});
    same(joined, observation.joins[endpoint], 'Navigation native semantic pixel join differs');
    if (joined.status !== 'observed' || !finite(joined.upperBoundMs)) return null;
    value[endpoint] = {upperBoundMs: joined.upperBoundMs, ceilingMs: endpoint === 'shell' ? 750 : sample.cache === 'cold' ? 4000 : 2000,
      endpoint: 'WindowServer-presented-semantic-pixels', exactLatencyMs: null, observationId: attempt.attemptId, navigationNonce: nonce, artifact: reported.artifact};
  }
  return {value, observation: completeObservation, captures, binding};
}

/** Live authority requires all three original results issued by the actual
 * owned supervisor above. There is deliberately no injectable live reader,
 * parser token, boolean, or public mint path. */
export async function verifyLiveNavigationWindowServerEvidence(context) {
  const {captures, ...supplied} = context ?? {}, frozen = structuredClone(supplied);
  if (!navigationScope(frozen.cell, frozen.sample) || frozen.actionCompleted !== true) return null;
  const claims = [];
  for (const stage of ['anchor', 'shell', 'canvas']) {
    const stopped = captures?.[stage], owner = ownedCaptures.get(stopped);
    if (!owner || owner.used || owner.ownerPid !== process.pid) return null;
    same(owner.binding, {invocation: frozen.invocation, navigationNonce: frozen.observation?.navigationNonce, stage}, 'Navigation live owner scope differs');
    same(snapshotStopped(stopped), owner.stopped, 'Navigation live stop result changed');
    same(frozen.observation?.captures?.[stage]?.process, owner.stopped.process, 'Navigation live process alias differs');
    same(frozen.observation?.captures?.[stage]?.evidence?.manifest, owner.stopped.manifest, 'Navigation live manifest alias differs');
    same(frozen.observation?.captures?.[stage]?.ready, owner.ready, 'Navigation live ready alias differs');
    demand(owner.actual.directory === join(frozen.output, 'native-nav-' + frozen.observation.navigationNonce + '-' + stage), 'Navigation live capture output differs');
    claims.push({stage, stopped, owner});
  }
  if (new Set(claims.map(value => value.stopped)).size !== 3 || new Set(claims.map(value => value.owner.handle)).size !== 3) return null;
  // Consume the entire transaction synchronously before any replay await. A
  // failed/incomplete replay cannot later be repurposed into another proof.
  for (const {owner} of claims) owner.used = true;
  try {
    const readers = await liveReaders(frozen.output, frozen.observation.navigationNonce);
    const replayed = await replayNavigation({...frozen, ...readers, groupOutput: frozen.output, live: true,
      environment: frozen.invocation.environment, sourceRoot: frozen.invocation.sourceRoot, workerProcessIdentity: frozen.invocation.workerProcessIdentity});
    if (!replayed) return null;
    for (const {stage, stopped, owner} of claims) {
      same(snapshotStopped(stopped), owner.stopped, 'Navigation live stop result changed during replay');
      same(replayed.captures[stage].processRecord, (() => {const {receipt, ...value} = owner.stopped.process; return value;})(), 'Navigation live original process bytes differ from owned supervisor');
      same(replayed.captures[stage].clocks, owner.clocks, 'Navigation live native clocks differ from owned requests');
      same(replayed.captures[stage].manifest.config, owner.actual.config, 'Navigation live configuration differs from owned supervisor');
    }
    return mint(frozen.observation, frozen.cell, frozen.sample, replayed.value);
  } catch (error) {if (error?.code === 'NAVIGATION_REPLAY_UNAVAILABLE' || error?.code === 'ENOENT') return null; throw error;}
}

/** Offline authority is independently reminted from the outer sealed packet,
 * including the original browser producer and every native raw member. */
export async function verifyNavigationWindowServerEvidence(context) {
  const {readRetained, resolveRetained, ...supplied} = context ?? {};
  const frozen = structuredClone(supplied), {attempt, cell, serial, groupOutput} = frozen;
  const sample = {cache: attempt?.cache, ordinal: attempt?.ordinal, prime: attempt?.prime};
  if (!navigationScope(cell, sample) || !attempt?.result?.nativeNavigation) return null;
  try {
    const io = reader({...frozen, readRetained, resolveRetained}), name = 'browser-cell-' + serial + '.json';
    const producer = json(await io.bytes(name, null, 8 * 1024 ** 2));
    demand(producer.cellId === cell.id && producer.operation === 'navigation.ready' && producer.timingSamplesReusable === true, 'Navigation original producer scope differs');
    const artifacts = [join(groupOutput, name), ...(producer.trace?.segments ?? [producer.trace]).map(value => value?.artifact?.path)].filter(Boolean);
    same(sanitize(normalizeResult({...producer, artifacts}, attempt.startMs, attempt.endMs)), attempt.result, 'Navigation normalized attempt differs from original producer');
    same(producer.observations?.productPhases, producer.evidence?.productPhases,
      'Navigation driver phase snapshot differs from the original browser evidence');
    const observation = producer.nativeNavigation;
    // A complete semantic ledger may establish a real violation. Preserve its
    // proof/count even when that finding makes the original attempt fail.
    if (!observation?.artifact || observation.missing?.length || observation.failures?.length) return null;
    const authority = json(await io.bytes(io.local(observation.artifact.path), observation.artifact, 8 * 1024 ** 2));
    const invocation = authority.binding?.invocation, runtime = authority.binding?.browser;
    demand(attempt.id === `${cell.id}/${sample.cache}/${sample.prime ? 'prime' : 'scored'}/${sample.ordinal}` &&
      integer(serial) && serial > 0 && finite(attempt.startMs) && finite(attempt.endMs) && attempt.endMs >= attempt.startMs &&
      authority.anchor?.startedRunnerMs >= attempt.startMs && authority.readiness?.canvas?.receivedRunnerMs <= attempt.endMs,
    'Navigation original attempt/runner window differs');
    const replayed = await replayNavigation({...frozen, readRetained, resolveRetained, cell, sample, serial, observation, invocation, runtime,
      configuration: frozen.configuration?.browser?.windowServerNavigation, result: producer.observations, actionCompleted: true, live: false});
    if (!replayed) return null;
    const proof = mint(attempt.result.nativeNavigation, cell, sample, replayed.value);
    const names = new Set(['R05UsableCanvasColdMs', 'R05UsableCanvasWarmMs', 'R04FalsePendingOrCompletionCount']);
    const derived = (cell.requiredMeasurements ?? []).filter(rule => names.has(rule.name) && (!rule.cache || rule.cache === sample.cache))
      .map(rule => navigationWindowServerMeasurement({cell, sample, rule, observation: attempt.result.nativeNavigation, proof})).filter(value => value.measurement).map(value => value.measurement);
    same((attempt.result.measurements ?? []).filter(value => names.has(value.name)), derived, 'Navigation published measurements differ from fresh native proof');
    return proof;
  } catch (error) {if (error?.code === 'NAVIGATION_REPLAY_UNAVAILABLE' || error?.code === 'ENOENT') return null; throw error;}
}

/** Upper bounds are never published as exact timing values. An over-cap bound
 * cannot establish either success or a latency breach. */
export function navigationWindowServerMeasurement({cell, sample, rule, observation, proof} = {}) {
  const bounds = readVerifiedNavigationBounds(proof, observation, {cell, sample});
  if (!bounds) return {reason: 'Actual owned navigation native evidence has not been independently replayed'};
  if (rule?.name === 'R04FalsePendingOrCompletionCount' && rule.budgetId === 'R04' && rule.unit === 'violations' &&
    rule.ceiling === 0 && (!rule.cache || rule.cache === sample.cache)) {
    const semantic = bounds.semantic, count = semantic?.falsePendingOrCompletionCount;
    if (semantic?.complete !== true || !Number.isSafeInteger(count) || count < 0)
      return {reason: 'Original synchronous navigation status ledger is incomplete: ' + (semantic?.missing ?? []).join('; ')};
    return {measurement: {name: rule.name, value: count, unit: 'violations',
      method: 'Replayed original synchronous navigation status ledger and accepted command authority',
      evidence: {kind: 'navigation-semantic-ledger-1', artifact: observation.artifact, navigationNonce: observation.navigationNonce,
        observationId: bounds.canvas.observationId, timeOriginMs: observation.semanticWitness.status.timeOriginMs}}};
  }
  const name = sample.cache === 'cold' ? 'R05UsableCanvasColdMs' : 'R05UsableCanvasWarmMs';
  if (rule?.name !== name || rule.budgetId !== 'R05' || rule.unit !== 'ms' || rule.cache !== sample.cache || rule.ceiling !== (sample.cache === 'cold' ? 4000 : 2000)) return {reason: 'Navigation native proof does not establish this registry row'};
  const bound = bounds.canvas;
  if (!finite(bound?.upperBoundMs) || bound.upperBoundMs > bound.ceilingMs) return {reason: 'Native navigation upper bound exceeds the cap; exact latency remains unavailable'};
  return {measurement: {name, value: null, upperBoundMs: bound.upperBoundMs, bound: 'upper', unit: 'ms',
    method: 'Owned WindowServer semantic pixels and public-ready ACK, from pre-navigation native anchor; exact latency unavailable',
    evidence: {kind: 'navigation-windowserver-bound-1', artifact: observation.artifact, navigationNonce: observation.navigationNonce, endpoint: 'canvas', exactLatencyMs: null}}};
}
