import test from 'node:test';
import assert from 'node:assert/strict';
import zlib, { crc32, inflateSync } from 'node:zlib';
import { syncBuiltinESMExports } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { rootFor } from '../store/helpers.mjs';
import { encodeLegacyPNG } from './png-legacy-fixture.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function inspectPNG(bytes, rgba, width, height) {
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const framing = [], payloads = [], types = [];
  let at = 8;
  while (at < bytes.length) {
    assert.ok(at + 12 <= bytes.length);
    const size = bytes.readUInt32BE(at), type = bytes.toString('ascii', at + 4, at + 8);
    assert.ok(at + size + 12 <= bytes.length);
    const data = bytes.subarray(at + 8, at + 8 + size);
    assert.equal(bytes.readUInt32BE(at + size + 8), crc32(bytes.subarray(at + 4, at + size + 8)));
    types.push(type);
    if (type === 'IHDR') {
      assert.equal(size, 13); assert.equal(data.readUInt32BE(0), width); assert.equal(data.readUInt32BE(4), height);
      assert.deepEqual([...data.subarray(8)], [8, 6, 0, 0, 0]);
    } else if (type === 'sRGB') assert.deepEqual([...data], [0]);
    else if (type === 'IDAT') { assert.ok(size > 0); framing.push(size); payloads.push(data); }
    else { assert.equal(type, 'IEND'); assert.equal(size, 0); assert.equal(at + 12, bytes.length); }
    at += size + 12;
  }
  assert.deepEqual(types, ['IHDR', 'sRGB', ...framing.map(() => 'IDAT'), 'IEND']);
  assert.ok(framing.length > 0);
  const compressed = Buffer.concat(payloads), filtered = inflateSync(compressed);
  assert.equal(filtered.length, (width * 4 + 1) * height);
  for (let row = 0; row < height; row++) {
    const at = row * (width * 4 + 1);
    assert.equal(filtered[at], 0);
    assert.deepEqual(filtered.subarray(at + 1, at + 1 + width * 4), rgba.subarray(row * width * 4, (row + 1) * width * 4));
  }
  return { compressed, framing };
}

// The pinned native zlib implementation decides whether a queued final input
// receives Z_FINISH from writableEnded when that input begins transforming.
// Schedule only the frozen encoder's public write/end calls, never its bytes,
// compression options, native flush calls or returned output pieces.
async function withSchedule(t, mode, expectedInput, run) {
  const nativeCreate = zlib.createDeflate, states = [];
  const replacement = t.mock.method(zlib, 'createDeflate', options => {
    assert.deepEqual(options, { level: 6, chunkSize: 65536 });
    const zip = nativeCreate(options), nativeWrite = zip.write, nativeEnd = zip.end;
    const state = { zip, inputs: [], queued: [], completions: 0, endCalls: 0, endedAfterCompletions: null };
    states.push(state);
    state.closed = new Promise(resolve => zip.once('close', resolve));
    // The complete two-write fixture is smaller than both actual native HWMs.
    // Its bounded queued schedule can return true without hiding backpressure.
    assert.ok(expectedInput.length + 1024 < zip.readableHighWaterMark);
    assert.ok(expectedInput.length < zip.writableHighWaterMark);
    let releaseWrites;
    const writesComplete = new Promise(resolve => { releaseWrites = resolve; });
    zip.once('close', releaseWrites);
    zip.write = function (...args) {
      assert.equal(this, zip);
      assert.ok(Buffer.isBuffer(args[0]));
      assert.ok(state.inputs.length < 2, 'only the one-row filter and RGBA writes are admitted');
      state.inputs.push(Buffer.from(args[0]));
      const index = state.inputs.length - 1;
      assert.equal(args[0].length, index === 0 ? 1 : expectedInput.length - 1);
      const originalCallback = typeof args.at(-1) === 'function' ? args.pop() : undefined;
      args.push(function (error) {
        state.completions++;
        if (error || state.completions === 2) releaseWrites();
        if (originalCallback) Reflect.apply(originalCallback, this, [error]);
      });
      if (mode === 'end-before-final-transform') {
        state.queued.push(args);
        return true;
      }
      return Reflect.apply(nativeWrite, zip, args);
    };
    zip.end = function (...args) {
      assert.equal(this, zip); state.endCalls++;
      assert.equal(state.endCalls, 1); assert.equal(state.inputs.length, 2);
      assert.deepEqual(Buffer.concat(state.inputs), expectedInput);
      if (mode === 'end-before-final-transform') {
        for (const writeArgs of state.queued) assert.equal(Reflect.apply(nativeWrite, zip, writeArgs), true);
        state.queued.length = 0;
        state.endedAfterCompletions = state.completions;
        return Reflect.apply(nativeEnd, zip, args);
      }
      writesComplete.then(() => {
        if (zip.destroyed) return;
        assert.equal(state.completions, 2);
        state.endedAfterCompletions = state.completions;
        Reflect.apply(nativeEnd, zip, args);
      }).catch(error => zip.destroy(error));
      return zip;
    };
    return zip;
  });
  syncBuiltinESMExports();
  const timer = setTimeout(() => { for (const { zip } of states) zip.destroy(Error('PNG_SCHEDULE_DEADLINE')); }, 10000);
  try {
    await run();
    assert.equal(states.length, 1);
    const state = states[0];
    assert.equal(state.endCalls, 1); assert.equal(state.inputs.length, 2);
    assert.deepEqual(Buffer.concat(state.inputs), expectedInput);
    assert.equal(state.completions, 2); assert.equal(state.zip.bytesWritten, expectedInput.length);
    assert.equal(state.endedAfterCompletions, mode === 'end-before-final-transform' ? 0 : 2);
    assert.equal(state.zip.writableFinished, true); assert.equal(state.zip.readableEnded, true);
    return { mode, endCalls: state.endCalls, writeBytes: state.inputs.map(bytes => bytes.length), inputSha256: hash(expectedInput), endedAfterCompletions: state.endedAfterCompletions };
  } finally {
    clearTimeout(timer);
    for (const { zip } of states) if (!zip.destroyed) zip.destroy();
    await Promise.all(states.map(state => state.closed));
    replacement.mock.restore(); syncBuiltinESMExports();
  }
}

test('frozen PNG encoder framing follows native end scheduling while compressed bytes and pixels stay exact', async t => {
  const root = await rootFor(t), width = 8192, height = 1, rgba = Buffer.alloc(width * height * 4);
  let seed = 0x8f31b957;
  for (let i = 0; i < rgba.length; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; rgba[i] = seed & 255; }
  const raw = join(root, 'pixels.rgba'), early = join(root, 'early.png'), late = join(root, 'late.png');
  await writeFile(raw, rgba, { mode: 0o600 });
  const observations = [], input = Buffer.concat([Buffer.from([0]), rgba]);
  observations.push(await withSchedule(t, 'end-before-final-transform', input, () => encodeLegacyPNG(raw, early, width, height, () => {})));
  observations.push(await withSchedule(t, 'end-after-final-write', input, () => encodeLegacyPNG(raw, late, width, height, () => {})));
  const earlyBytes = await readFile(early), lateBytes = await readFile(late);
  const before = inspectPNG(earlyBytes, rgba, width, height), after = inspectPNG(lateBytes, rgba, width, height);
  assert.deepEqual(before.compressed, after.compressed);
  assert.equal(before.framing.length, 2); assert.equal(after.framing.length, 3);
  assert.notDeepEqual(before.framing, after.framing);
  assert.equal(earlyBytes.equals(lateBytes), false);
  assert.deepEqual(await readFile(raw), rgba);
  t.diagnostic(JSON.stringify({ observations, early: { bytes: earlyBytes.length, sha256: hash(earlyBytes), framing: before.framing }, late: { bytes: lateBytes.length, sha256: hash(lateBytes), framing: after.framing }, compressed: { bytes: before.compressed.length, sha256: hash(before.compressed) } }));
});
