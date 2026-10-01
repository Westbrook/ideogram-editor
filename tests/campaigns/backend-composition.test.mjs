import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { compositionCaseIds, supportedCells, makeCompositionFixture, rawPromptChunks, rawEnvelopeChunks, runCell } from '../../tooling/qualification/campaigns/backend-composition.mjs';

test('WJ corpus has exact isolated byte/string/elements/depth/token boundaries', () => {
  assert.equal(new Set(compositionCaseIds).size, 30); assert.equal(new Set(supportedCells).size, 48);
  assert.equal(makeCompositionFixture('WJ16').bytes.length, 262144); assert.equal(makeCompositionFixture('WJ17').bytes.length, 262145);
  for (const [id, length] of [['WJ19', 16384], ['WJ20', 16385]]) assert.equal(Buffer.byteLength(JSON.parse(makeCompositionFixture(id).bytes).high_level_description), length);
  for (const [id, length] of [['WJ02', 256], ['WJ18', 257]]) assert.equal(JSON.parse(makeCompositionFixture(id).bytes).compositional_deconstruction.elements.length, length);
  assert.equal(makeCompositionFixture('WJ12').bytes.toString(), '['.repeat(16) + ']'.repeat(16));
  // This corpus grammar contains only brackets, commas and one-digit numbers;
  // counting its characters independently counts every lexical token exactly.
  assert.equal(makeCompositionFixture('WJ14').bytes.length, 50000); assert.equal(makeCompositionFixture('WJ15').bytes.length, 50001);
  assert.notEqual(makeCompositionFixture('WJ04').sha256, makeCompositionFixture('WJ08').sha256);
  assert.throws(() => makeCompositionFixture('WJ31'), /Unknown/);
});

test('built production parser recognizes each sealed WJ01–23 distinction', async () => {
  const { parseCaption } = await import('../../dist/local/src/composition/core.js');
  for (const id of compositionCaseIds.slice(0, 23)) {
    const fixture = makeCompositionFixture(id), before = Buffer.from(fixture.bytes), result = parseCaption(fixture.bytes);
    assert.equal(result.state, fixture.expected.state, id);
    if (fixture.expected.code) assert(result.issues.some(issue => issue.code === fixture.expected.code), id + ': ' + JSON.stringify(result.issues));
    assert.deepEqual(fixture.bytes, before, id + ' retains exact raw');
  }
});

test('native boundary specimens isolate document bytes and preserve invalid Unicode in recovery JSON', () => {
  const texts = id => JSON.parse(makeCompositionFixture(id).bytes).texts;
  assert.equal(Buffer.byteLength(texts('WJ25')[0]), 16385);
  assert.equal(texts('WJ26').reduce((n, value) => n + Buffer.byteLength(value), 0), 1048577);
  assert(texts('WJ26').every(value => Buffer.byteLength(value) <= 16384));
  assert.equal(texts('WJ27')[0].split('\n').length, 257);
  assert.equal(texts('WJ28')[0].charCodeAt(0), 0xd800);
  assert(makeCompositionFixture('WJ28').bytes.toString().includes('\\ud800'));
  assert.equal(texts('WJ29')[1].split('\n').length, 256);
  assert.equal(texts('WJ30').length, 75); assert.equal(texts('WJ30').reduce((n, value) => n + Buffer.byteLength(value), 0), 1048576);
});

test('raw envelope generators preserve exact sizes through the product incremental scanner', async () => {
  const { scanEnvelope } = await import('../../dist/local/server/provider/provenance.js');
  for (const length of [16777216, 16777217]) {
    let bytes = 0, maximum = 0; const expected = createHash('sha256');
    for (const chunk of rawPromptChunks(length)) { bytes += chunk.length; maximum = Math.max(maximum, chunk.length); expected.update(chunk); }
    assert.equal(bytes, length); assert(maximum <= 32768);
    const observed = createHash('sha256'); let decoded = 0;
    const scanned = scanEnvelope(rawEnvelopeChunks(length), chunk => { assert(chunk.length <= 32768); decoded += chunk.length; observed.update(chunk); });
    assert.equal(decoded, length); assert.equal(observed.digest('hex'), expected.digest('hex'));
    assert.equal(scanned.images.length, 1); assert.equal(scanned.images[0].width, 512); assert.deepEqual(scanned.safety, [false]);
  }
});

test('campaign source never substitutes fake durations or unbounded raw materialization', async () => {
  const source = await readFile(new URL('../../tooling/qualification/campaigns/backend-composition.mjs', import.meta.url), 'utf8');
  assert(!source.includes('Buffer.concat(')); assert(!source.includes('JSON.parse(raw'));
  await assert.rejects(runCell({}, { operation: 'WJ31' }), /Unsupported/);
});
