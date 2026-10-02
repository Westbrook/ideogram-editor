import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, open, realpath} from 'node:fs/promises';
import {isAbsolute, resolve} from 'node:path';
import {Readable, Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {constants as zlibConstants, createInflateRaw} from 'node:zlib';
import {isDeepStrictEqual} from 'node:util';

const CHUNK = 65536, MAX_INDEX = 4 * 1024 ** 2, MAX_PIXELS = 5000;
const demand = (ok, message) => {if (!ok) throw Error(message);};
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const keys = (value, names, label) => {demand(object(value) && isDeepStrictEqual(Object.keys(value).sort(), [...names].sort()), 'Invalid ' + label + ' fields');};
const sameIdentity = (a, b) => demand(['dev', 'ino', 'size', 'mode', 'mtimeMs', 'ctimeMs', 'nlink'].every(key => a[key] === b[key]), 'Packed oracle container identity changed');

/** A separately pinned index describes only independently supplied expected
 * pixels. It never derives an expectation from this campaign's output. Review
 * reference/hash are retained provenance, not a self-authorizing review flag. */
export function validatePackedGenericOracle({indexBytes, indexSha256, oracleSha256, pixelIdentities, containerPin, reviewPin}) {
  demand(Buffer.isBuffer(indexBytes) && indexBytes.length > 0 && indexBytes.length <= MAX_INDEX && sha(indexSha256) && hash(indexBytes) === indexSha256,
    'Packed oracle index pin differs');
  const index = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(indexBytes));
  keys(index, ['kind', 'schemaVersion', 'oracleSha256', 'reviewSha256', 'reviewReference', 'pixels'], 'packed oracle index');
  demand(index.kind === 'rfc1951-oracle-pixels-1' && index.schemaVersion === 1 && sha(oracleSha256) && index.oracleSha256 === oracleSha256 &&
    sha(reviewPin?.sha256) && integer(reviewPin.bytes) && reviewPin.bytes > 0 && reviewPin.bytes <= 65536 && index.reviewSha256 === reviewPin.sha256 &&
    typeof index.reviewReference === 'string' && index.reviewReference.trim().length > 0 && index.reviewReference.length <= 1024,
    'Packed oracle source/review binding differs');
  demand(integer(containerPin?.bytes) && sha(containerPin.sha256) && Array.isArray(index.pixels) && index.pixels.length <= MAX_PIXELS &&
    Array.isArray(pixelIdentities) && pixelIdentities.length === index.pixels.length, 'Packed oracle pixel/container inventory differs');
  const expected = new Map();
  for (const file of pixelIdentities) {
    demand(typeof file.path === 'string' && !expected.has(file.path) && integer(file.bytes) && file.bytes > 0 && file.bytes <= 256 * 1024 ** 2 && sha(file.sha256),
      'Invalid logical oracle identity'); expected.set(file.path, {path: file.path, bytes: file.bytes, sha256: file.sha256});
  }
  const seen = new Map(); let offset = 0;
  for (const row of index.pixels) {
    keys(row, ['path', 'bytes', 'sha256', 'pixelStorage'], 'packed oracle pixel');
    const identity = {path: row.path, bytes: row.bytes, sha256: row.sha256};
    demand(!seen.has(row.path) && isDeepStrictEqual(expected.get(row.path), identity), 'Packed oracle logical identity differs');
    const storage = row.pixelStorage;
    if (storage?.kind === 'reference') {
      keys(storage, ['kind', 'path'], 'packed oracle reference');
      const previous = seen.get(storage.path);
      demand(previous && previous.bytes === row.bytes && previous.sha256 === row.sha256, 'Packed oracle reference is not an identical earlier pixel');
    } else {
      keys(storage, ['kind', 'offset', 'encodedBytes', 'encodedSha256'], 'packed oracle member');
      demand(storage.kind === 'deflate-raw' && storage.offset === offset && integer(storage.encodedBytes) && storage.encodedBytes > 0 &&
        sha(storage.encodedSha256) && Number.isSafeInteger(offset + storage.encodedBytes) && offset + storage.encodedBytes <= containerPin.bytes,
        'Packed oracle member does not partition its container'); offset += storage.encodedBytes;
    }
    seen.set(row.path, identity);
  }
  demand(seen.size === expected.size && offset === containerPin.bytes, 'Packed oracle container has missing or trailing ranges');
  return structuredClone(index);
}

/** Reconstruct hashes, never whole pixel buffers. Every member has a bounded
 * output length and strict end-of-stream checks on the pinned Node toolchain.
 * The returned ordinary identities are diagnostics; no evaluator token is
 * minted here and actual independent semantic review remains required. */
export async function replayPackedGenericOracle({containerPath, containerPin, indexBytes, indexSha256, oracleSha256, pixelIdentities, reviewPin,
  signal, timeoutMs = 120000}) {
  // Admission and every asynchronous use refer to the same detached pins.
  // A caller changing its selection while bytes are read cannot replace them.
  containerPin = structuredClone(containerPin); reviewPin = structuredClone(reviewPin);
  demand(process.versions.node === '26.10.0', 'Packed oracle replay requires pinned Node 26.10.0 strict raw-inflate semantics');
  demand(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300000, 'Invalid packed oracle replay deadline');
  const index = validatePackedGenericOracle({indexBytes, indexSha256, oracleSha256, pixelIdentities, containerPin, reviewPin});
  const replaySignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const guard = () => replaySignal.throwIfAborted(); guard();
  demand(isAbsolute(containerPath ?? '') && resolve(containerPath) === containerPath && await realpath(containerPath) === containerPath,
    'Packed oracle container must be canonical');
  const before = await lstat(containerPath);
  demand(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size === containerPin.bytes, 'Packed oracle container is not the pinned ordinary file');
  const handle = await open(containerPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    sameIdentity(await handle.stat(), before); const containerHash = createHash('sha256'), verified = new Map(); let containerBytes = 0;
    for (const row of index.pixels) {
      guard(); const identity = {path: row.path, bytes: row.bytes, sha256: row.sha256}, storage = row.pixelStorage;
      if (storage.kind === 'reference') {
        const previous = verified.get(storage.path);
        demand(previous && previous.bytes === row.bytes && previous.sha256 === row.sha256, 'Packed oracle reference did not follow verified bytes');
        verified.set(row.path, identity); continue;
      }
      const encodedHash = createHash('sha256'), rawHash = createHash('sha256'); let encodedBytes = 0, rawBytes = 0;
      demand(storage.offset === containerBytes, 'Packed oracle offset changed during replay');
      async function* source() {
        while (encodedBytes < storage.encodedBytes) {
          guard(); const chunk = Buffer.allocUnsafe(Math.min(CHUNK, storage.encodedBytes - encodedBytes));
          const read = await handle.read(chunk, 0, chunk.length, storage.offset + encodedBytes); guard();
          demand(read.bytesRead > 0, 'Packed oracle member truncated'); const part = chunk.subarray(0, read.bytesRead);
          encodedHash.update(part); containerHash.update(part); encodedBytes += read.bytesRead; containerBytes += read.bytesRead; yield part;
        }
      }
      // Documented strict trailing-data option on Node >=26.5, pinned above.
      // https://nodejs.org/api/zlib.html#class-options
      const decoder = createInflateRaw({windowBits: 15, rejectGarbageAfterEnd: true, finishFlush: zlibConstants.Z_FINISH,
        chunkSize: CHUNK, readableHighWaterMark: CHUNK, writableHighWaterMark: CHUNK});
      const sink = new Writable({highWaterMark: CHUNK, write(chunk, _encoding, callback) {
        try {guard(); rawBytes += chunk.length; demand(rawBytes <= row.bytes, 'Packed oracle expands beyond exact raw length'); rawHash.update(chunk); callback();}
        catch (error) {callback(error);}
      }});
      await pipeline(Readable.from(source(), {objectMode: false, highWaterMark: CHUNK}), decoder, sink, {signal: replaySignal}); guard();
      demand(encodedBytes === storage.encodedBytes && decoder.bytesWritten === storage.encodedBytes && encodedHash.digest('hex') === storage.encodedSha256,
        'Packed oracle encoded member, trailing input or length differs');
      demand(rawBytes === row.bytes && rawHash.digest('hex') === row.sha256, 'Packed oracle reconstructed pixels differ'); verified.set(row.path, identity);
    }
    demand(containerBytes === containerPin.bytes && containerHash.digest('hex') === containerPin.sha256, 'Packed oracle whole container pin differs');
    demand((await handle.read(Buffer.allocUnsafe(1), 0, 1, containerBytes)).bytesRead === 0, 'Packed oracle container grew');
    sameIdentity(await handle.stat(), before); sameIdentity(await lstat(containerPath), before);
    demand(await realpath(containerPath) === containerPath, 'Packed oracle path changed'); guard();
    return {kind: 'verified-independent-oracle-pixel-identities-1', storageFormat: index.kind, pixelIdentities: [...verified.values()],
      container: structuredClone(containerPin), indexSha256, oracleSha256,
      semanticReview: {reference: index.reviewReference, sha256: reviewPin.sha256, bytes: reviewPin.bytes, requiresRetainedExternalRecord: true, authorityFromFlags: false},
      qualification: false};
  } finally {await handle.close();}
}
