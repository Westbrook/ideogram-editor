import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, open, opendir} from 'node:fs/promises';
import {isAbsolute, join, normalize} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {Readable, Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {constants as zlibConstants, createInflateRaw} from 'node:zlib';

// Independent source-only v4 candidate. Reconstructed pixels establish a captured
// WindowServer observation, never complete display-slot or physical coverage.
// IText capacity is not evidence of 106 actions, 247 substeps, or 496 actual
// clock ACKs; the consumer verifies those. No physical-keyboard or OS-IME claim.
const PROFILE = 'interaction-text-106-247-60s-1';
const KIND = 'windowserver-text-session-capture-4';
const STORAGE_FORMAT = 'rfc1951-previous-roi-1';
const MAX_FRAME_BYTES = 256 * 1024 ** 2;
const MAX_FRAMES = 9012, MAX_CLOCKS = 560, CHUNK_BYTES = 64 * 1024;
const METADATA_BYTES = MAX_FRAMES * 4096 + MAX_CLOCKS * 256;
const MANIFEST_BYTES = MAX_FRAMES * 256 + 32768;
const STATUSES = ['complete', 'idle', 'blank', 'suspended', 'started', 'stopped'];
const verified = new WeakMap();
const integer = value => Number.isSafeInteger(value) && value >= 0;
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const demand = (condition, message) => {if (!condition) throw Error(message);};
const same = (actual, expected, message) => demand(isDeepStrictEqual(actual, expected), message);
const exactKeys = (value, keys, label) => demand(object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(','), `Invalid exact ${label}`);

function ticks(value) {
  demand(typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value), 'Invalid lossless native ticks');
  const result = BigInt(value); demand(result <= 18446744073709551615n, 'Native ticks exceed UInt64'); return result;
}
function signedTicks(value) {
  demand(typeof value === 'string' && /^(0|-?[1-9][0-9]{0,18})$/.test(value), 'Invalid lossless signed native ticks');
  const result = BigInt(value); demand(result >= -9223372036854775808n && result <= 9223372036854775807n, 'Signed native ticks exceed Int64');
}
function decode(bytes, maximum, label) {
  demand(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= maximum, `Invalid bounded ${label}`);
  const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes), value = JSON.parse(text);
  // JSON.parse otherwise silently accepts duplicate object keys. Its grammar
  // validation runs first; this small lexical pass rejects those ambiguities.
  const stack = [], tokens = /"(?:[^"\\]|\\.)*"|[{}\[\],:]|true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/g;
  for (const match of text.matchAll(tokens)) {
    const token = match[0], top = stack.at(-1);
    if (token === '{') stack.push({keys: new Set(), key: true});
    else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else if (token === ',') {if (top) top.key = true;}
    else if (token === ':') {if (top) top.key = false;}
    else if (token.startsWith('"') && top?.key) {
      const key = JSON.parse(token); demand(!top.keys.has(key), `Duplicate ${label} key`); top.keys.add(key);
    }
  }
  return value;
}
function roi(value) {
  exactKeys(value, ['height', 'width', 'x', 'y'], 'pixel ROI');
  demand(Object.values(value).every(integer) && value.width > 0 && value.height > 0 &&
    value.x <= 32768 && value.y <= 32768 && value.width <= 32768 && value.height <= 32768 && value.width * value.height * 4 <= MAX_FRAME_BYTES, 'Invalid bounded pixel ROI');
  return value;
}
function rectangle(value) {
  return object(value) && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(value[key])) && value.width > 0 && value.height > 0;
}
/** Pure capacity arithmetic for a selected native allowance, before genuine
 * allocation/sample admission. Below-minimum allowances are rejected. */
export function windowServerTextSessionLosslessCapacity(pixelRoi, nativeArtifactBytes) {
  roi(pixelRoi); const reservedArtifactBytes = nativeArtifactBytes;
  demand(integer(reservedArtifactBytes), 'Invalid native encoded artifact reservation');
  const rawFrameBytes = pixelRoi.width * pixelRoi.height * 4, maxEncodedFrameBytes = 2 * rawFrameBytes + 65536;
  demand(reservedArtifactBytes >= METADATA_BYTES + MANIFEST_BYTES + maxEncodedFrameBytes, 'Native artifact allowance is below minimum capacity');
  return {durationMs: 75000, measurementDurationMs: 60000, refreshHz: 60, textActions: 106, inputSubsteps: 247, pointerSamples: 0,
    dispatchClockRecords: 494, windowAnchorClockRecords: 2, maxFrames: MAX_FRAMES, maxClockRecords: MAX_CLOCKS,
    rawFrameBytes, maxRawObservedBytes: rawFrameBytes * MAX_FRAMES, maxEncodedFrameBytes,
    maxEncodedPixelBytes: reservedArtifactBytes - METADATA_BYTES - MANIFEST_BYTES,
    metadataByteLimit: METADATA_BYTES, manifestByteLimit: MANIFEST_BYTES,
    minimumArtifactBytes: METADATA_BYTES + MANIFEST_BYTES + maxEncodedFrameBytes, reservedArtifactBytes};
}
function validateConfig(config) {
  exactKeys(config, ['schemaVersion', 'profile', 'storageFormat', 'displayID', 'expectedBrowserPid', 'roi', 'evidenceBudget'], 'session config');
  demand(config.schemaVersion === 4 && config.profile === PROFILE && config.storageFormat === STORAGE_FORMAT && integer(config.displayID) && config.displayID > 0 && config.displayID <= 0xffffffff &&
    integer(config.expectedBrowserPid) && config.expectedBrowserPid > 0 && config.expectedBrowserPid <= 0x7fffffff, 'Invalid native session identity');
  const budget = config.evidenceBudget;
  exactKeys(budget, ['capacityBytes', 'observedAllocatedBytes', 'reservationBytes', 'nativeArtifactBytes', 'allocationSha256'], 'evidence budget');
  const capacity = windowServerTextSessionLosslessCapacity(config.roi, budget.nativeArtifactBytes);
  demand(integer(budget.capacityBytes) && integer(budget.observedAllocatedBytes) && integer(budget.reservationBytes) && sha(budget.allocationSha256) &&
    budget.nativeArtifactBytes <= budget.reservationBytes, 'Native session evidence reservation unavailable');
  const projected = BigInt(budget.observedAllocatedBytes) + BigInt(budget.reservationBytes);
  demand(projected * 10n < BigInt(budget.capacityBytes) * 9n, 'Native session reservation reaches the strict 90-percent evidence ceiling');
  return {config, capacity, budget, projected};
}
/** Shape and arithmetic only: the supervisor resolves allocationSha256 through
 * the retained managed allocation and a completeTraversal volume sample. */
export function validateWindowServerTextSessionLosslessConfig(config) {
  const copy = structuredClone(config); validateConfig(copy); return copy;
}
function validateCaptureGeometry(manifest) {
  demand(manifest?.kind === KIND && manifest.schemaVersion === 4, 'Unsupported native session capture');
  const {config, capacity, budget, projected} = validateConfig(manifest.config);
  same(manifest.capacity, capacity, 'Native session capacity differs from full workload');
  exactKeys(manifest.storageAdmission, ['availableBytesBefore', 'reservedArtifactBytes', 'evidenceBudget', 'targetAlarmAtReservation'], 'storage admission');
  demand(ticks(manifest.storageAdmission.availableBytesBefore) >= BigInt(budget.reservationBytes) && manifest.storageAdmission.reservedArtifactBytes === capacity.reservedArtifactBytes, 'Native session disk admission unavailable');
  same(manifest.storageAdmission.evidenceBudget, budget, 'Native storage budget differs');
  demand(manifest.storageAdmission.targetAlarmAtReservation === (projected * 10n >= BigInt(budget.capacityBytes) * 8n), 'Native session reservation alarm differs');
  const display = manifest.display;
  demand(object(display) && display.id === config.displayID && integer(display.width) && integer(display.height) && display.width > 0 && display.width <= 32768 && display.height > 0 && display.height <= 32768 &&
    display.width * display.height * 4 <= MAX_FRAME_BYTES &&
    config.roi.x + config.roi.width <= display.width && config.roi.y + config.roi.height <= display.height, 'Native ROI or display identity differs');
  // Geometry and owned-window checks deliberately preserve the frozen v1
  // contract. Adjacent window observations do not prove historical occlusion.
  const geometry = manifest.captureGeometry, admission = manifest.windowAdmission;
  demand(object(geometry) && rectangle(geometry.displayBoundsPoints) && geometry.backingScale?.x === display.width / geometry.displayBoundsPoints.width &&
    geometry.backingScale?.y === display.height / geometry.displayBoundsPoints.height && geometry.scalesToFit === false && geometry.showsCursor === true &&
    geometry.capturesAudio === false && geometry.queueDepth === 3 && geometry.pixelFormat === 'BGRA', 'Native capture geometry is unavailable');
  same(geometry.modePixels, {width: display.width, height: display.height}, 'Native display mode dimensions differ');
  same(geometry.displayPoints, geometry.displayBoundsPoints, 'Native display point dimensions differ');
  demand(rectangle(geometry.filterPoints) && Number.isFinite(geometry.pointPixelScale) && geometry.pointPixelScale > 0 &&
    geometry.filterPoints.width * geometry.pointPixelScale === display.width && geometry.filterPoints.height * geometry.pointPixelScale === display.height &&
    geometry.pointPixelScale === geometry.backingScale.x && geometry.pointPixelScale === geometry.backingScale.y, 'Native filter pixel mapping differs');
  demand(object(admission) && admission.ownerPID === config.expectedBrowserPid && integer(admission.windowNumber) && admission.windowNumber > 0 &&
    admission.layer === 0 && Number.isFinite(admission.alpha) && admission.alpha > 0 && admission.alpha <= 1 && admission.onScreen === true && rectangle(admission.bounds) &&
    integer(admission.aboveVisibleWindowCount) && admission.intersectingAboveWindowCount === 0, 'Owned native browser window unavailable');
  const roiPoints = {x: geometry.displayBoundsPoints.x + config.roi.x / geometry.backingScale.x,
    y: geometry.displayBoundsPoints.y + config.roi.y / geometry.backingScale.y,
    width: config.roi.width / geometry.backingScale.x, height: config.roi.height / geometry.backingScale.y};
  same(admission.roiPoints, roiPoints, 'Native ROI point mapping differs');
  demand(roiPoints.x >= admission.bounds.x && roiPoints.y >= admission.bounds.y && roiPoints.x + roiPoints.width <= admission.bounds.x + admission.bounds.width &&
    roiPoints.y + roiPoints.height <= admission.bounds.y + admission.bounds.height, 'Native ROI is outside the owned browser window');
  demand(object(manifest.timebase) && integer(manifest.timebase.numer) && manifest.timebase.numer > 0 && manifest.timebase.numer <= 0xffffffff &&
    integer(manifest.timebase.denom) && manifest.timebase.denom > 0 && manifest.timebase.denom <= 0xffffffff, 'Native clock timebase unavailable');
  ticks(manifest.startedMach);
  return {config, capacity, display, admission};
}

/** Protocol admission only. The owner separately authenticates collector source,
 * executable, launched process, retained invocation, and budget authority. */
export function validateWindowServerTextSessionLosslessReady(ready, {config, outputDirectory} = {}) {
  demand(object(ready) && ready.event === 'ready', 'Native session ready record unavailable');
  const {capacity} = validateCaptureGeometry(ready);
  same(ready.config, config, 'Native ready config differs from invocation');
  demand(typeof outputDirectory === 'string' && isAbsolute(outputDirectory) && normalize(outputDirectory) === outputDirectory && ready.outputDirectory === outputDirectory, 'Native ready output differs from invocation');
  same(ready.roi, config.roi, 'Native ready ROI differs');
  demand(ready.pixelByteLimit === capacity.maxEncodedPixelBytes && ready.metadataByteLimit === capacity.metadataByteLimit && ready.manifestByteLimit === capacity.manifestByteLimit &&
    ready.maxClockRecords === capacity.maxClockRecords && ready.pointPixelScale === ready.captureGeometry.pointPixelScale, 'Native ready limits unavailable');
  return structuredClone(ready);
}

const identityKeys = ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
function sameIdentity(actual, expected, label) {
  demand(identityKeys.every(key => actual[key] === expected[key]), `${label} changed during replay`);
}
function sameDirectory(actual, expected) {
  // Directory atime may change during enumeration; mtime/ctime may not.
  demand(actual.isDirectory(), 'Native capture directory is not ordinary');
  sameIdentity(actual, expected, 'Native capture directory');
}
async function anchorDirectory(directory, guard) {
  demand(typeof directory === 'string' && isAbsolute(directory) && normalize(directory) === directory && directory !== '/' && !directory.includes('\0'), 'Invalid absolute capture directory');
  demand(Number.isInteger(constants.O_NOFOLLOW) && Number.isInteger(constants.O_DIRECTORY), 'Ordinary-file no-follow guards unavailable');
  const ancestors = []; let component = '/';
  for (const name of directory.split('/').filter(Boolean)) {
    guard();
    component = join(component, name);
    const stat = await lstat(component, {bigint: true});
    demand(stat.isDirectory() && !stat.isSymbolicLink(), 'Native capture path contains a non-directory or symlink');
    ancestors.push({path: component, stat});
  }
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat({bigint: true}); sameDirectory(stat, ancestors.at(-1).stat);
    guard(); return {directory, handle, stat, ancestors, guard};
  } catch (error) {await handle.close(); throw error;}
}
async function checkAnchor(anchor) {
  anchor.guard();
  sameDirectory(await anchor.handle.stat({bigint: true}), anchor.stat);
  for (const entry of anchor.ancestors) {
    anchor.guard();
    const current = await lstat(entry.path, {bigint: true});
    demand(current.isDirectory() && !current.isSymbolicLink() && current.dev === entry.stat.dev && current.ino === entry.stat.ino && current.mode === entry.stat.mode, 'Native capture path identity changed');
  }
  sameDirectory(await lstat(anchor.directory, {bigint: true}), anchor.stat);
  anchor.guard();
}
async function inventory(anchor) {
  await checkAnchor(anchor);
  const names = [], iterator = await opendir(anchor.directory);
  for await (const entry of iterator) {
    anchor.guard();
    demand(entry.isFile() && names.length < 3, 'Native artifact inventory contains a nonfile or exceeds capacity'); names.push(entry.name);
  }
  await checkAnchor(anchor); return names.sort();
}
async function readFileBounded(anchor, name, {maximum, bytes, sha256, consume}) {
  demand(name === 'manifest.json' || name === 'frames.ndjson', 'Invalid native metadata path');
  await checkAnchor(anchor);
  const path = join(anchor.directory, name), before = await lstat(path, {bigint: true});
  demand(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size > 0n && before.size <= BigInt(maximum), 'Invalid bounded ordinary native file');
  if (bytes !== undefined) demand(integer(bytes) && before.size === BigInt(bytes), 'Retained native file length differs from seal');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    sameIdentity(await handle.stat({bigint: true}), before, 'Native file');
    const hash = createHash('sha256'), chunk = Buffer.allocUnsafe(CHUNK_BYTES), size = Number(before.size); let position = 0;
    while (position < size) {
      anchor.guard();
      const {bytesRead} = await handle.read(chunk, 0, Math.min(CHUNK_BYTES, size - position), position);
      anchor.guard();
      demand(bytesRead > 0, 'Native file is truncated');
      const part = chunk.subarray(0, bytesRead); hash.update(part); if (consume) consume(part);
      position += bytesRead;
    }
    demand((await handle.read(chunk, 0, 1, position)).bytesRead === 0, 'Native file grew during replay');
    const actualSha256 = hash.digest('hex');
    if (sha256 !== undefined) demand(sha(sha256) && actualSha256 === sha256, 'Retained native file differs from its seal');
    sameIdentity(await handle.stat({bigint: true}), before, 'Native file');
    sameIdentity(await lstat(path, {bigint: true}), before, 'Native file path');
    await checkAnchor(anchor); return {path: name, bytes: position, sha256: actualSha256, identity: before};
  } finally {await handle.close();}
}
function ordinarySeal(entry, path, maximum, allowEmpty = false) {
  exactKeys(entry, ['path', 'bytes', 'sha256'], 'native file seal');
  demand(entry.path === path && integer(entry.bytes) && (allowEmpty || entry.bytes > 0) && entry.bytes <= maximum && sha(entry.sha256), 'Invalid native file seal');
}
function validatePts(value) {
  exactKeys(value, ['value', 'timescale', 'flags', 'epoch'], 'sample PTS');
  signedTicks(value.value); signedTicks(value.epoch);
  demand(Number.isInteger(value.timescale) && value.timescale >= -0x80000000 && value.timescale <= 0x7fffffff && integer(value.flags) && value.flags <= 0xffffffff, 'Invalid native sample PTS');
}
function nullableNumber(value, maximum = Number.MAX_VALUE) {return value === null || (Number.isFinite(value) && value > 0 && value <= maximum);}
function parseRecords(manifest, container, guard) {
  const {config, capacity, display, admission} = validateCaptureGeometry(manifest), started = ticks(manifest.startedMach), ended = ticks(manifest.endedMach);
  const clocks = new Map(), records = [], samples = [];
  let previousCallback = started, previousDisplay = 0n, previousRecord = started, pending = Buffer.alloc(0);
  let previousComplete = null, encodedOffset = 0, completeFrames = 0, duplicateFrames = 0;
  function accept(line) {
    guard();
    demand(line.length > 0 && line.length + 1 <= 4096 && records.length < MAX_FRAMES + MAX_CLOCKS, 'Native metadata record bound exceeded');
    const row = decode(line, 4095, 'native metadata');
    demand(object(row) && row.schemaVersion === 4, 'Malformed native record');
    if (row.event === 'clock') {
      exactKeys(row, ['schemaVersion', 'event', 'id', 'mach'], 'native clock');
      demand(line.length + 1 <= 256 && id(row.id) && !clocks.has(row.id) && clocks.size < MAX_CLOCKS, 'Duplicate or malformed native clock identity');
      const value = ticks(row.mach); demand(value >= previousRecord && value <= ended, 'Native clock record is outside capture or reversed');
      previousRecord = value; clocks.set(row.id, row); records.push(row); return;
    }
    const sampleKeys = ['schemaVersion', 'event', 'ordinal', 'statusRaw', 'status', 'ownerPID', 'windowNumber', 'windowObservationMach', 'aboveVisibleWindowCount',
      'intersectingAboveWindowCount', 'callbackMach', 'displayTimeMach', 'pts', 'pixelFormat', 'width', 'height', 'roi', 'retained', 'file', 'sha256', 'byteLength', 'pixelStorage', 'contentScale', 'scaleFactor'];
    if (Object.hasOwn(row, 'unretainedReason')) sampleKeys.push('unretainedReason');
    exactKeys(row, sampleKeys, 'native sample');
    demand(row.event === 'sample' && row.ordinal === samples.length + 1 && row.ordinal <= MAX_FRAMES && integer(row.statusRaw) && row.statusRaw < STATUSES.length && STATUSES[row.statusRaw] === row.status, 'Native sample ordinal or status differs');
    demand(row.ownerPID === admission.ownerPID && row.windowNumber === admission.windowNumber && integer(row.aboveVisibleWindowCount) && row.intersectingAboveWindowCount === 0, 'Sample browser window ownership or overlap observation differs');
    const callback = ticks(row.callbackMach); demand(callback >= previousCallback && callback >= previousRecord && callback <= ended, 'Native sample callback clock is outside capture');
    previousCallback = callback; previousRecord = callback;
    const observedWindow = ticks(row.windowObservationMach); demand(observedWindow >= callback && observedWindow <= ended, 'Sample window observation clock is outside capture'); previousRecord = observedWindow;
    if (row.displayTimeMach !== null) {
      const displayed = ticks(row.displayTimeMach); demand(displayed <= callback && displayed >= previousDisplay, 'Native display timestamp reversed or exceeds its callback'); previousDisplay = displayed;
    }
    validatePts(row.pts); same(row.roi, config.roi, 'Sample ROI differs from capture');
    demand((row.pixelFormat === null || integer(row.pixelFormat) && row.pixelFormat <= 0xffffffff) && (row.width === null || integer(row.width) && row.width > 0) &&
      (row.height === null || integer(row.height) && row.height > 0) && nullableNumber(row.contentScale) && nullableNumber(row.scaleFactor), 'Malformed native sample dimensions or scale');
    if (row.file !== null) {
      demand(row.retained === true && row.status === 'complete' && row.contentScale === 1 && row.displayTimeMach !== null && ticks(row.displayTimeMach) > 0n && ticks(row.displayTimeMach) >= started && row.pixelFormat === 1111970369 &&
        row.width === display.width && row.height === display.height && !Object.hasOwn(row, 'unretainedReason'), 'Pixel evidence is not a complete native-resolution display sample');
      demand(row.file === 'pixels.bin' && sha(row.sha256) && row.byteLength === capacity.rawFrameBytes && object(row.pixelStorage), 'Sample raw pixel identity differs');
      const storage = row.pixelStorage;
      if (storage.kind === 'deflate-raw') {
        exactKeys(storage, ['kind', 'offset', 'encodedBytes', 'encodedSha256'], 'encoded pixel storage');
        demand(integer(storage.offset) && storage.offset === encodedOffset && integer(storage.encodedBytes) && storage.encodedBytes > 0 &&
          storage.encodedBytes <= capacity.maxEncodedFrameBytes && storage.encodedBytes <= container.bytes - encodedOffset && sha(storage.encodedSha256), 'Encoded pixel segments overlap, have gaps, or exceed bounds');
        encodedOffset += storage.encodedBytes;
      } else {
        exactKeys(storage, ['kind', 'ordinal'], 'reference pixel storage');
        demand(storage.kind === 'reference' && previousComplete !== null && storage.ordinal === previousComplete.ordinal && storage.ordinal < row.ordinal &&
          row.sha256 === previousComplete.sha256 && row.byteLength === previousComplete.byteLength, 'Pixel reference does not bind the previous complete raw identity');
        duplicateFrames++;
      }
      previousComplete = row; completeFrames++;
    } else demand(row.retained === false && row.status !== 'complete' && row.sha256 === null && row.byteLength === null && row.pixelStorage === null && row.unretainedReason === 'non-complete-status', 'Sample claims missing complete pixel evidence');
    samples.push(row); records.push(row);
  }
  return {
    consume(chunk) {
      const bytes = pending.length ? Buffer.concat([pending, chunk]) : chunk; let start = 0, end;
      while ((end = bytes.indexOf(10, start)) !== -1) {accept(bytes.subarray(start, end)); start = end + 1;}
      pending = Buffer.from(bytes.subarray(start)); demand(pending.length < 4096, 'Native metadata line exceeds bound');
    },
    finish() {
      demand(pending.length === 0 && records.length > 0, 'Native metadata has an incomplete or empty tail');
      demand(encodedOffset === container.bytes && (completeFrames > 0 || container.bytes === 0), 'Unreferenced native pixel container bytes');
      same(manifest.counts, {sampleRecords: samples.length, completeFrames, clockRecords: clocks.size, pixelBytes: completeFrames * capacity.rawFrameBytes,
        encodedPixelBytes: container.bytes, duplicateFrames, unretainedSamples: samples.length - completeFrames}, 'Native sample counts differ');
      return {records, clocks: [...clocks.values()], samples};
    }
  };
}

async function replayPixelContainer(anchor, container, samples, signal) {
  await checkAnchor(anchor);
  const path = join(anchor.directory, 'pixels.bin'), before = await lstat(path, {bigint: true});
  demand(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size === BigInt(container.bytes), 'Invalid bounded ordinary pixel container');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    sameIdentity(await handle.stat({bigint: true}), before, 'Native pixel container');
    const containerHash = createHash('sha256'); let containerBytes = 0, previousComplete = null;
    for (const row of samples) {
      anchor.guard(); if (!row.retained) continue;
      if (row.pixelStorage.kind === 'reference') {
        demand(previousComplete !== null && row.pixelStorage.ordinal === previousComplete.ordinal && row.sha256 === previousComplete.sha256 &&
          row.byteLength === previousComplete.byteLength, 'Pixel reference has no preceding verified raw identity');
        previousComplete = row; continue;
      }
      const storage = row.pixelStorage, encodedHash = createHash('sha256'), rawHash = createHash('sha256');
      let encodedBytes = 0, rawBytes = 0;
      demand(storage.offset === containerBytes, 'Native encoded container offset drifted');
      async function* source() {
        while (encodedBytes < storage.encodedBytes) {
          anchor.guard();
          // Fresh bounded chunks are owned by the pipeline until consumed;
          // reusing a mutable read buffer would corrupt inflight decoding.
          const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, storage.encodedBytes - encodedBytes));
          const {bytesRead} = await handle.read(chunk, 0, chunk.length, storage.offset + encodedBytes);
          anchor.guard(); demand(bytesRead > 0, 'Native encoded segment is truncated');
          const part = chunk.subarray(0, bytesRead); encodedHash.update(part); containerHash.update(part);
          encodedBytes += bytesRead; containerBytes += bytesRead; yield part;
        }
      }
      // Node 26.10 documents rejectGarbageAfterEnd (added 26.5), including raw
      // inflate. Strict Z_FINISH rejects truncated streams. bytesWritten is a
      // secondary consumed-input check, not the sole trailing-byte defense.
      // https://nodejs.org/api/zlib.html#class-options
      // https://nodejs.org/api/zlib.html#class-zlibinflateraw
      const decoder = createInflateRaw({windowBits: 15, rejectGarbageAfterEnd: true, finishFlush: zlibConstants.Z_FINISH,
        chunkSize: CHUNK_BYTES, readableHighWaterMark: CHUNK_BYTES, writableHighWaterMark: CHUNK_BYTES});
      const sink = new Writable({highWaterMark: CHUNK_BYTES, write(chunk, _encoding, callback) {
        try {
          anchor.guard(); rawBytes += chunk.length;
          demand(rawBytes <= row.byteLength, 'Native decoded pixels exceed exact raw frame length'); rawHash.update(chunk); callback();
        } catch (error) {callback(error);}
      }});
      await pipeline(Readable.from(source(), {objectMode: false, highWaterMark: CHUNK_BYTES}), decoder, sink, {signal});
      anchor.guard();
      demand(encodedBytes === storage.encodedBytes && decoder.bytesWritten === storage.encodedBytes && encodedHash.digest('hex') === storage.encodedSha256, 'Native encoded segment length, trailing input, or hash differs');
      demand(rawBytes === row.byteLength && rawHash.digest('hex') === row.sha256, 'Native reconstructed raw pixel identity differs');
      previousComplete = row;
    }
    demand(containerBytes === container.bytes && containerHash.digest('hex') === container.sha256, 'Native whole pixel container seal differs');
    demand((await handle.read(Buffer.allocUnsafe(1), 0, 1, container.bytes)).bytesRead === 0, 'Native pixel container grew during replay');
    sameIdentity(await handle.stat({bigint: true}), before, 'Native pixel container');
    sameIdentity(await lstat(path, {bigint: true}), before, 'Native pixel container path');
    await checkAnchor(anchor); return {path: 'pixels.bin', identity: before};
  } finally {await handle.close();}
}

/** Filesystem replay after the collector has stopped. All invocation admission
 * fields are mandatory but supplied by the caller, not independently proven by
 * this module. No imports here launch a collector or inspect a running process.
 *
 * Node has no public openat API: an open directory descriptor plus no-follow
 * component/file checks and repeated identity checks detect observed drift, but
 * are not a kernel-anchored defense against hostile ancestor rename-and-restore.
 * The owner must provide an exclusively owned, quiescent artifact directory.
 * Cancellation/deadlines are cooperative between filesystem awaits and chunks;
 * they cannot interrupt an operating-system read already in progress. An
 * exhausted replay deadline is incomplete evidence, never a smaller workload.
 */
export async function verifyWindowServerTextSessionLosslessCapture(directory, {manifestSha256, expectedConfig, expectedReady, expectedStopped, processExitCode, signal, timeoutMs = 120000} = {}) {
  demand(integer(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300000 && (signal === undefined || signal instanceof AbortSignal), 'Invalid bounded native replay cancellation');
  demand(process.versions.node === '26.10.0', 'Native lossless replay requires pinned Node 26.10.0');
  const deadline = performance.now() + timeoutMs;
  const deadlineSignal = AbortSignal.timeout(timeoutMs), replaySignal = signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal;
  const guard = () => {replaySignal.throwIfAborted(); demand(performance.now() < deadline, 'Native session replay deadline exceeded');};
  guard();
  demand(sha(manifestSha256) && processExitCode === 0, 'Native manifest pin or successful process exit unavailable');
  const ready = validateWindowServerTextSessionLosslessReady(expectedReady, {config: expectedConfig, outputDirectory: directory});
  demand(object(expectedStopped) && expectedStopped.schemaVersion === 4 && expectedStopped.event === 'stopped' && expectedStopped.terminalReason === 'requested-stop' && expectedStopped.manifest === 'manifest.json', 'Native successful stopped record unavailable');
  const stopped = structuredClone(expectedStopped); ticks(stopped.endedMach);
  const anchor = await anchorDirectory(directory, guard);
  try {
    const manifestChunks = [], observedFiles = [];
    observedFiles.push(await readFileBounded(anchor, 'manifest.json', {maximum: MANIFEST_BYTES, sha256: manifestSha256, consume: chunk => manifestChunks.push(Buffer.from(chunk))}));
    const manifest = decode(Buffer.concat(manifestChunks), MANIFEST_BYTES, 'native manifest'); manifestChunks.length = 0;
    const {capacity} = validateCaptureGeometry(manifest);
    same(manifest.config, ready.config, 'Native manifest config differs from invocation');
    for (const key of ['display', 'captureGeometry', 'windowAdmission', 'timebase', 'startedMach', 'capacity', 'storageAdmission']) same(manifest[key], ready[key], `Native ready ${key} differs from retained manifest`);
    demand(ticks(manifest.endedMach) >= ticks(manifest.startedMach) && manifest.endedMach === stopped.endedMach && manifest.terminalReason === 'requested-stop', 'Native capture is incomplete or stopped record differs');
    same(manifest.lossObservations, {nativeDroppedFrames: null, completeDisplaySlotSequence: false, streamError: null}, 'Native loss observations differ or stream failed');
    ordinarySeal(manifest.frames, 'frames.ndjson', METADATA_BYTES);
    demand(!Object.hasOwn(manifest, 'pixelFiles') && Array.isArray(manifest.pixelContainers) && manifest.pixelContainers.length === 1, 'Native pixel container inventory differs');
    const container = manifest.pixelContainers[0]; ordinarySeal(container, 'pixels.bin', capacity.maxEncodedPixelBytes, true);
    const expectedNames = ['manifest.json', 'frames.ndjson', 'pixels.bin'].sort();
    same(await inventory(anchor), expectedNames, 'Native artifact inventory differs');
    const parser = parseRecords(manifest, container, guard);
    observedFiles.push(await readFileBounded(anchor, 'frames.ndjson', {maximum: METADATA_BYTES, ...manifest.frames, consume: chunk => parser.consume(chunk)}));
    const observations = parser.finish();
    // Never trust sample/manifests' repeated hash claims alone. Every listed
    // stream must freshly reconstruct exactly its complete BGRA byte identity.
    observedFiles.push(await replayPixelContainer(anchor, container, observations.samples, replaySignal));
    same(await inventory(anchor), expectedNames, 'Native artifact inventory drifted');
    for (const entry of observedFiles) {guard(); sameIdentity(await lstat(join(directory, entry.path), {bigint: true}), entry.identity, 'Native retained file');}
    await checkAnchor(anchor);
    const result = Object.freeze({kind: 'verified-windowserver-text-session-capture-4', manifestSha256, storageFormat: STORAGE_FORMAT, source: 'ScreenCaptureKit-full-display', clock: 'mach-absolute',
      qualification: false, invocationAdmission: 'caller-supplied', collectorAuthenticity: 'unavailable', physicalScanout: 'unavailable', displaySlotCoverage: 'unavailable', firstPresentedFrameCoverage: 'unavailable'});
    verified.set(result, {manifest, manifestSha256, lossObservations: manifest.lossObservations, ...observations}); return result;
  } finally {await anchor.handle.close();}
}

/** Safe detached observation seam for a separately reviewed generic/R07 join.
 * Only original replay tokens are accepted; copied flags cannot grant access.
 * No frame buffers, mutable private records, metrics, or input-coverage verdict
 * are returned. Hashes have authority only through completed byte replay. */
export function getWindowServerTextSessionLosslessObservations(capture) {
  demand(verified.has(capture), 'Native session capture has not completed byte replay');
  return structuredClone(verified.get(capture));
}
