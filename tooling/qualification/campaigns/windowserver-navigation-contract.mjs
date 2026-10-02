import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {firstUseEnvironmentBinding} from './windowserver-first-use.mjs';
import {validateWindowServerConfig} from './windowserver-process.mjs';
import {verifyWindowServerCapture} from './windowserver-presentation.mjs';

export const NAVIGATION_PIXEL_LIMIT = 256 * 1024 ** 2;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const bare = value => typeof value === 'string' ? value.replace(/^sha256:/, '') : value;
const sha = value => typeof bare(value) === 'string' && /^[a-f0-9]{64}$/.test(bare(value));
const demand = (value, message) => {if (!value) throw Error('Navigation native: ' + message);};
const same = (a, b, message) => demand(isDeepStrictEqual(a, b), message);
const copy = value => structuredClone(value);
function keys(value, names, label) {demand(object(value), 'invalid ' + label); same(Object.keys(value).sort(), [...names].sort(), 'unsupported ' + label + ' fields');}
function rect(value) {keys(value, ['x', 'y', 'width', 'height'], 'pixel rectangle'); demand(Object.values(value).every(integer) && value.width > 0 && value.height > 0, 'invalid pixel rectangle'); return value;}
function ticks(value) {demand(typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n, 'invalid native tick'); return BigInt(value);}
function decode(bytes, max) {demand(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= max, 'bounded JSON unavailable'); return JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes));}
function clock(value, id) {demand(value?.schemaVersion === 1 && value.event === 'clock' && value.id === id, 'native ACK identity differs'); return ticks(value.mach);}
function controls(rows, names) {demand(Array.isArray(rows) && rows.length === names.length, 'public controls inventory differs'); rows.forEach((row, index) => same(row, {name:names[index], visible:true, enabled:true}, 'public control is unavailable'));}

export function navigationAttemptBinding({cell, sample, serial, fixture, invocation}) {
  demand(cell?.operation === 'navigation.ready' && ['W0','W1'].includes(cell.workload) && cell.id === `H1/chromium-${cell.workload}-ready` && cell.host === 'H' && cell.kind === 'navigation' && (cell.parameters?.browser ?? 'chromium') === 'chromium', 'unsupported navigation cell');
  demand(['cold','warm'].includes(sample?.cache) && integer(sample.ordinal) && sample.ordinal > 0 && typeof sample.prime === 'boolean' && integer(serial) && serial > 0, 'scheduled navigation attempt unavailable');
  demand(typeof fixture?.documentId === 'string' && fixture.documentId.length > 0 && sha(fixture.seal?.sha256), 'sealed document fixture required');
  const attempt = {cellId:cell.id, workload:cell.workload, cache:sample.cache, ordinal:sample.ordinal, prime:sample.prime, serial,
    attemptId:`${cell.id}/${sample.cache}/${sample.prime ? 'prime' : 'scored'}/${sample.ordinal}`, documentId:fixture.documentId, fixtureSeal:copy(fixture.seal)};
  demand(invocation?.kind === 'windowserver-navigation-invocation-1' && isAbsolute(invocation.sourceRoot ?? '') && integer(invocation.workerProcessIdentity?.pid) && invocation.workerProcessIdentity.pid > 1 && invocation.workerProcessIdentity.node === 'v26.10.0', 'owned navigation invocation missing');
  for (const key of ['cellId','workload','cache','ordinal','prime','serial','attemptId']) same(invocation[key], attempt[key], 'invocation attempt differs: ' + key);
  demand(typeof invocation.workerProcessIdentity.startedAt === 'string' && Number.isFinite(Date.parse(invocation.workerProcessIdentity.startedAt)), 'worker birth identity unavailable');
  return attempt;
}

export function navigationEnvironmentBinding(runtime, invocation) {
  demand(runtime?.engine === 'chromium', 'H1 navigation requires the selected Chromium runtime');
  const environment = firstUseEnvironmentBinding(runtime);
  demand(object(invocation?.environment) && object(invocation.environment.host), 'source/build/host environment unavailable');
  for (const key of ['sourceDigest','buildDigest','toolsDigest','controlDigest']) demand(sha(invocation.environment[key]), 'source/build identity missing: ' + key);
  return {...environment, sourceDigest:bare(invocation.environment.sourceDigest), buildDigest:bare(invocation.environment.buildDigest)};
}

export function nativeNavigationConfiguration(value, runtime, {cell, sample} = {}) {
  if (value === undefined) return null;
  keys(value, ['kind','build','displayID','profiles','capture','maxTotalBytes'], 'configuration');
  demand(value.kind === 'windowserver-navigation-configuration-1', 'unsupported configuration');
  keys(value.build, ['receiptPath','receiptSha256'], 'build pin');
  demand(isAbsolute(value.build.receiptPath ?? '') && /^[a-f0-9]{64}$/.test(value.build.receiptSha256 ?? ''), 'build pin unavailable');
  demand(Array.isArray(value.profiles) && value.profiles.length > 0 && value.profiles.length <= 4, 'profile inventory invalid');
  const seen = new Set();
  for (const profile of value.profiles) {
    keys(profile, ['workload','cache','roi','shell','canvas'], 'profile');
    demand(['W0','W1'].includes(profile.workload) && ['cold','warm'].includes(profile.cache) && !seen.has(profile.workload + '/' + profile.cache), 'duplicate or invalid profile'); seen.add(profile.workload + '/' + profile.cache); rect(profile.roi);
    for (const endpoint of ['shell','canvas']) {keys(profile[endpoint], ['path','sha256'], 'oracle pin'); demand(isAbsolute(profile[endpoint].path ?? '') && /^[a-f0-9]{64}$/.test(profile[endpoint].sha256 ?? ''), 'oracle pin unavailable');}
  }
  const profiles = value.profiles.filter(profile => profile.workload === cell?.workload && profile.cache === sample?.cache);
  demand(profiles.length === 1, 'exact workload/cache oracle profile unavailable'); const profile = profiles[0];
  demand(profile.roi.width === runtime?.viewport?.width * runtime?.deviceScaleFactor && profile.roi.height === runtime?.viewport?.height * runtime?.deviceScaleFactor, 'anchor ROI must contain the entire browser viewport at native resolution');
  keys(value.capture, ['anchor','shell','canvas'], 'capture stages'); let maximum = 0;
  const configs = {};
  for (const stage of ['anchor','shell','canvas']) {
    keys(value.capture[stage], ['durationMs','maxFrames','maxBytes'], 'capture limits');
    // Canvas dimensions belong to its sealed oracle. Validate numeric limits
    // now, then admit its real ROI before a capture can start; a small canvas
    // need not reserve enough bytes for an unrelated full viewport frame.
    const validated = validateWindowServerConfig({schemaVersion:1, displayID:value.displayID, expectedBrowserPid:runtime.browserPid,
      roi:stage==='canvas'?{x:profile.roi.x,y:profile.roi.y,width:1,height:1}:profile.roi, ...value.capture[stage]});
    if(stage==='canvas'){const {roi,...limits}=validated;configs[stage]=limits;}else configs[stage]=validated;
    maximum += configs[stage].maxBytes;
  }
  demand(integer(value.maxTotalBytes) && value.maxTotalBytes > 0 && value.maxTotalBytes <= NAVIGATION_PIXEL_LIMIT && maximum <= value.maxTotalBytes, 'three-capture pixel reservation exceeds the existing bounded allocation');
  return {selection:copy(value), profile:copy(profile), configs, capturePlan:{stages:3, maxFrames:Object.values(configs).reduce((sum, config) => sum + config.maxFrames, 0), maxPixelBytes:maximum, reservedPixelBytes:value.maxTotalBytes}};
}

export function navigationOracleBinding(environment, attempt) {
  return {fixtureSha256:environment.fixtureSha256, browserEnvironmentSha256:environment.browserEnvironmentSha256,
    sourceDigest:environment.sourceDigest, buildDigest:environment.buildDigest, workload:attempt.workload, cache:attempt.cache, documentId:attempt.documentId};
}

export function validateNavigationOracle(oracle, pixels, {endpoint, selection, environment, attempt}) {
  demand(['shell','canvas'].includes(endpoint), 'unsupported endpoint');
  keys(oracle, ['kind','schemaVersion','endpoint','subject','binding','display','roi','pixelFormat','coverage','canonical','before','after'], 'semantic oracle');
  demand(oracle.kind === 'navigation-pixel-oracle-1' && oracle.schemaVersion === 1 && oracle.endpoint === endpoint && oracle.pixelFormat === 'BGRA8', 'oracle endpoint differs');
  demand(oracle.subject === (endpoint === 'shell' ? 'whole-application-shell' : 'canonical-document-viewport'), 'marker pixels cannot identify this endpoint');
  same(oracle.binding, navigationOracleBinding(environment, attempt), 'oracle fixture/browser/subject/build binding differs');
  rect(oracle.roi); demand(oracle.display?.id === selection.selection.displayID, 'oracle display differs');
  validateWindowServerConfig({...selection.configs[endpoint],roi:oracle.roi});
  const outer = selection.profile.roi, roi = oracle.roi;
  demand(roi.x >= outer.x && roi.y >= outer.y && roi.x + roi.width <= outer.x + outer.width && roi.y + roi.height <= outer.y + outer.height, 'oracle lies outside full browser viewport');
  keys(oracle.coverage, ['kind','viewport','cssRectangle'], 'semantic coverage');
  const viewport = {...environment.environment.viewport, deviceScaleFactor:environment.environment.deviceScaleFactor};
  same(oracle.coverage.viewport, viewport, 'oracle browser viewport differs');
  const css = oracle.coverage.cssRectangle;
  keys(css, ['x','y','width','height'], 'CSS semantic rectangle');
  demand(Object.values(css).every(finite) && css.width > 0 && css.height > 0, 'semantic CSS rectangle invalid');
  same(roi, {x:outer.x + css.x * viewport.deviceScaleFactor, y:outer.y + css.y * viewport.deviceScaleFactor, width:css.width * viewport.deviceScaleFactor, height:css.height * viewport.deviceScaleFactor}, 'semantic/native rectangle mapping differs');
  if (endpoint === 'shell') {
    demand(oracle.coverage.kind === 'whole-browser-viewport' && oracle.canonical === null, 'whole shell semantic coverage unavailable');
    same(css, {x:0,y:0,width:viewport.width,height:viewport.height}, 'shell oracle excludes meaningful shell pixels');
  } else {
    demand(oracle.coverage.kind === 'whole-canonical-canvas', 'complete canonical viewport coverage unavailable');
    keys(oracle.canonical, ['documentId','width','height','layerCount','assetId','assetHash'], 'canonical oracle root');
    const canonical = oracle.canonical;
    demand(canonical.documentId === attempt.documentId && integer(canonical.width) && canonical.width > 0 && integer(canonical.height) && canonical.height > 0 && integer(canonical.layerCount), 'canonical document oracle invalid');
    demand(canonical.assetId === null ? canonical.layerCount === 0 && canonical.assetHash === null : typeof canonical.assetId === 'string' && canonical.assetId.length > 0 && sha(canonical.assetHash), 'canonical empty/composite distinction missing');
  }
  demand(pixels instanceof Map && pixels.size === 2, 'oracle pixel inventory differs');
  for (const name of ['before','after']) {
    const row = oracle[name], path = name + '.bgra', bytes = pixels.get(path);
    keys(row, ['state','path','bytes','sha256'], 'oracle pixels');
    demand(row.path === path && row.state === (name === 'before' ? 'pre-navigation-blank' : endpoint === 'shell' ? 'native-shell-ready' : 'canonical-canvas-ready') && row.bytes === roi.width * roi.height * 4 && row.bytes <= NAVIGATION_PIXEL_LIMIT && /^[a-f0-9]{64}$/.test(row.sha256 ?? '') && Buffer.isBuffer(bytes) && bytes.length === row.bytes && hash(bytes) === row.sha256, 'oracle pixels differ from sealed state');
  }
  demand(oracle.before.sha256 !== oracle.after.sha256 || endpoint === 'canvas' && oracle.canonical.layerCount === 0, 'oracle does not establish a visible endpoint change');
  return true;
}

export function validateNavigationWitness(endpoint, witness, {navigationNonce, runtime, attempt, oracle}) {
  demand(['shell','canvas'].includes(endpoint), 'unsupported readiness endpoint');
  demand(object(witness) && finite(witness.readyMs), 'public readiness witness unavailable');
  const navigation = witness.navigation;
  keys(navigation, ['nonce','previousTimeOrigin','timeOrigin','entry','visibility','topLevel'], 'fresh navigation witness');
  demand(navigation.nonce === navigationNonce && finite(navigation.previousTimeOrigin) && finite(navigation.timeOrigin) && navigation.timeOrigin > 0 && navigation.previousTimeOrigin !== navigation.timeOrigin && navigation.visibility === 'visible' && navigation.topLevel === true, 'new visible top-level realm unavailable');
  keys(navigation.entry, ['startTime','type','name'], 'navigation entry');
  demand(navigation.entry.startTime === 0 && navigation.entry.type === 'navigate', 'original navigation entry differs');
  const url = new URL(navigation.entry.name);
  demand(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password, 'navigation identity is not the token-free local entry');
  if (endpoint === 'shell') {
    keys(witness, ['navigation','readyMs','recoveryText','controls','viewport'], 'shell witness');
    demand(witness.recoveryText === 'Local recovery complete. Accepted edits are saved locally.', 'shell public recovery state unavailable');
    controls(witness.controls, ['New','Open']); same(witness.viewport, {...runtime.viewport,deviceScaleFactor:runtime.deviceScaleFactor}, 'shell viewport differs');
  } else {
    keys(witness, ['navigation','readyMs','canonical','viewport','toolbar','acceptedEdit','stableRevision'], 'canvas witness');
    const canonical = witness.canonical;
    keys(canonical, ['documentId','revision','width','height','layerCount','assetId','assetHash'], 'current canonical root');
    demand(typeof canonical.revision === 'string' && /^(0|[1-9][0-9]*)$/.test(canonical.revision) && canonical.revision.length <= 20 && witness.stableRevision === true, 'current canonical revision unavailable');
    const {revision, ...root} = canonical; same(root, oracle.canonical, 'current canonical pixels differ from oracle');
    controls(witness.toolbar, ['New','Open','Import image','Close document','Export image']);
    keys(witness.viewport, ['asset','visible','x','y','width','height'], 'public canonical viewport');
    const {asset, visible, ...rectangle} = witness.viewport; same(rectangle, oracle.coverage.cssRectangle, 'full canonical canvas bounds differ');
    demand(visible === true && asset === canonical.assetId, 'public canonical viewport asset differs');
    keys(witness.acceptedEdit, ['commandId','documentId','status','documentRevision','transactionId'], 'accepted edit');
    const edit = witness.acceptedEdit;
    demand(typeof edit.commandId === 'string' && edit.commandId.length > 0 && typeof edit.transactionId === 'string' && edit.transactionId.length > 0 && edit.documentId === attempt.documentId && edit.status === 'accepted' && edit.documentRevision === revision, 'accepted durable test edit does not bind the current document');
  }
  return copy(witness);
}

function parsedCapture(raw) {
  const pin = hash(raw.manifestBytes); verifyWindowServerCapture(raw, {manifestSha256:pin});
  const manifest = decode(raw.manifestBytes, 8 * 1024 ** 2), records = new TextDecoder('utf-8',{fatal:true}).decode(raw.framesBytes).trimEnd().split('\n').map(line => JSON.parse(line));
  return {manifest, pin, clocks:new Map(records.filter(row => row.event === 'clock').map(row => [row.id,row])), samples:records.filter(row => row.event === 'sample'), pixels:raw.pixels};
}
function pixelHash(capture, row, roi) {
  const outer = capture.manifest.config.roi, bytes = capture.pixels.get(row.file);
  demand(bytes && roi.x >= outer.x && roi.y >= outer.y && roi.x + roi.width <= outer.x + outer.width && roi.y + roi.height <= outer.y + outer.height, 'pixel crop is outside admitted viewport');
  const digest = createHash('sha256');
  for (let y=0;y<roi.height;y++) {const start=((roi.y-outer.y+y)*outer.width+roi.x-outer.x)*4; digest.update(bytes.subarray(start,start+roi.width*4));}
  return digest.digest('hex');
}
export function navigationNativeUpper(start, end, timebase) {
  const delta = ticks(end)-ticks(start); demand(delta >= 0n && integer(timebase?.numer) && timebase.numer > 0 && integer(timebase?.denom) && timebase.denom > 0, 'native clock/timebase invalid');
  const denominator=BigInt(timebase.denom)*1_000_000n, micros=(delta*BigInt(timebase.numer)*1000n+denominator-1n)/denominator;
  demand(micros <= BigInt(Number.MAX_SAFE_INTEGER), 'native upper bound exceeds exact arithmetic'); return Number(micros)/1000;
}

/** Whole semantic pixels and native ACKs establish only an upper bound. This
 * pure byte replay does not mint process/invocation/evaluator authority. */
export function joinNavigationWindowServerPixels(raw, {endpoint,oracleBytes,oraclePixels,oracleSha256,anchor,readiness,binding}) {
  const baseline = parsedCapture(raw.anchor), target = parsedCapture(raw.target), oracle = decode(oracleBytes,65536);
  demand(hash(oracleBytes) === oracleSha256, 'oracle manifest hash differs');
  const selected = nativeNavigationConfiguration(binding.selection,binding.browser,{cell:{workload:binding.attempt.workload},sample:{cache:binding.attempt.cache}});
  validateNavigationOracle(oracle,oraclePixels,{endpoint,selection:selected,environment:binding.environment,attempt:binding.attempt});
  validateNavigationWitness(endpoint,readiness?.witness,{navigationNonce:binding.navigationNonce,runtime:binding.browser,attempt:binding.attempt,oracle});
  for (const field of ['display','timebase','captureGeometry']) same(target.manifest[field],baseline.manifest[field],'native captures differ: '+field);
  for (const field of ['ownerPID','windowNumber','bounds','layer']) same(target.manifest.windowAdmission[field],baseline.manifest.windowAdmission[field],'owned browser window differs: '+field);
  same(baseline.manifest.config,selected.configs.anchor,'anchor capture configuration differs');
  same(target.manifest.config,{...selected.configs[endpoint],roi:oracle.roi},'endpoint capture configuration differs');
  demand(baseline.manifest.terminalReason==='requested-stop'&&target.manifest.terminalReason==='requested-stop','native capture exhausted or did not close by the owned request');
  same(target.manifest.display,oracle.display,'oracle display geometry differs');
  const id='nv-'+binding.navigationNonce;
  demand(anchor?.kind === 'navigation-native-bracket-1' && anchor.status === 'complete' && anchor.dispatchCompleted === true && finite(anchor.startedRunnerMs) && finite(anchor.completedRunnerMs) && anchor.completedRunnerMs >= anchor.startedRunnerMs, 'original navigation bracket unavailable');
  const before=clock(anchor.before,id+'-before'); demand(anchor.after === null,'unsupported navigation completion clock');
  same(baseline.clocks.get(anchor.before.id),anchor.before,'navigation lower anchor not retained');
  demand(readiness.kind === 'navigation-native-readiness-1' && readiness.endpoint === endpoint && readiness.status === 'complete' && finite(readiness.requestRunnerMs) && finite(readiness.receivedRunnerMs) && readiness.requestRunnerMs >= readiness.witness.readyMs && readiness.receivedRunnerMs >= readiness.requestRunnerMs && readiness.witness.readyMs >= anchor.completedRunnerMs,'readiness ACK does not follow the actual witness');
  const acknowledged=clock(readiness.ack,id+(endpoint==='shell'?'-s-ready':'-c-ready')); demand(acknowledged >= before && ticks(target.manifest.startedMach) >= before,'readiness native capture precedes navigation anchor');
  demand(ticks(target.manifest.startedMach)>=ticks(baseline.manifest.endedMach),'endpoint capture precedes closure of the lower-anchor capture');
  same(target.clocks.get(readiness.ack.id),readiness.ack,'readiness ACK not retained');
  const prior=baseline.samples.filter(row=>row.file!==null && ticks(row.callbackMach)<=before).at(-1);
  const matched=target.samples.find(row=>row.file!==null && ticks(row.displayTimeMach)>=before && pixelHash(target,row,oracle.roi)===oracle.after.sha256);
  const ceilingMs=endpoint==='shell'?750:binding.attempt.cache==='cold'?4000:2000;
  const base={kind:'navigation-windowserver-pixel-join-1',endpoint,subject:oracle.subject,source:'ScreenCaptureKit-full-display',qualification:false,
    oracleSha256,anchorCaptureSha256:baseline.pin,captureSha256:target.pin,budget:endpoint==='shell'?'R04':'R05',ceilingMs,
    upperBoundMs:null,exactLatencyMs:null,physicalScanout:'unavailable',displaySlotCoverage:'unavailable',firstPresentedFrameCoverage:'unavailable',
    browserToNativeClockCorrelation:'unavailable',semanticReviewRequired:true,collectorSourceAndInvocationAdmissionRequired:true};
  if (!prior || pixelHash(baseline,prior,oracle.roi)!==oracle.before.sha256 || !matched) return {...base,status:'unavailable',reason:!prior?'pre-navigation-baseline-unavailable':!matched?'semantic-endpoint-pixels-unavailable':'pre-navigation-baseline-mismatch'};
  const observed=ticks(matched.displayTimeMach), end=observed>acknowledged?observed:acknowledged;
  const upperBoundMs=navigationNativeUpper(anchor.before.mach,end.toString(),target.manifest.timebase);
  return {...base,status:'observed',upperBoundMs,baselineOrdinal:prior.ordinal,matchedOrdinal:matched.ordinal,observedDisplayTimeMach:matched.displayTimeMach,readinessMach:readiness.ack.mach,
    nativeLowerAnchor:anchor.before.mach,nativeUpperEndpoint:end.toString(),ceilingAssessment:upperBoundMs<=ceilingMs?'upper-bound-within-ceiling':'unavailable-earliest-endpoint-not-proven'};
}
