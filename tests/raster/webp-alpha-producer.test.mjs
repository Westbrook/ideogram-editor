// Source-authored refusal/serialization checks. These do not supply accepted
// qualification evidence or claim a complete retained capsule was exercised.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {linkSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {
  ALPHA_SELECTED,
} from '../../tooling/raster/import-seals/webp-alpha-authority.mjs';
import {alphaProducerJSON, heldAlphaSource, validateAlphaProducer} from '../../tooling/raster/import-seals/webp-alpha-producer.mjs';

test('alpha producer preserves the historical sorted JSON.stringify dialect', () => {
  const value = {z: [2, {z: '\u000b', a: '\u0000'}], a: 'é\n\u2028'};
  const expected = '{"a":' + JSON.stringify(value.a) + ',"z":[2,{"a":' +
    JSON.stringify('\u0000') + ',"z":' + JSON.stringify('\u000b') + '}]}';
  assert.equal(alphaProducerJSON(value), expected);
  assert.deepEqual(JSON.parse(alphaProducerJSON(value)), value);
});

test('selected alpha authority is deeply immutable', () => {
  assert(Object.isFrozen(ALPHA_SELECTED)); assert(Object.isFrozen(ALPHA_SELECTED.candidate));
  assert(Object.isFrozen(ALPHA_SELECTED.artifact)); assert(Object.isFrozen(ALPHA_SELECTED.recipe));
  assert.throws(() => { ALPHA_SELECTED.candidate.hash = 'sha256:' + '0'.repeat(64); }, TypeError);
  assert.throws(() => { ALPHA_SELECTED.platform = 'linux'; }, TypeError);
});

test('a matching alpha version or artifact cannot select a changed candidate receipt', () => {
  assert.throws(() => validateAlphaProducer({files: new Set(), candidateHash: 'sha256:' + '3'.repeat(64),
    candidate: {version: ALPHA_SELECTED.version, artifact: ALPHA_SELECTED.artifact}}),
  /Unreviewed alpha candidate receipt/);
});

test('an asserted selected hash cannot substitute forged retained candidate bytes', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ie-alpha-producer-refusal-')));
  try {
    const candidate = {status: 'built-unqualified', version: ALPHA_SELECTED.version, artifact: ALPHA_SELECTED.artifact};
    writeFileSync(join(directory, 'build-candidate.json'), JSON.stringify(candidate), {flag: 'wx', mode: 0o600});
    assert.throws(() => validateAlphaProducer({directory, files: new Set(['build-candidate.json']),
      candidate, candidateHash: ALPHA_SELECTED.candidate.hash}), /Retained alpha input changed/);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

test('held alpha source reads sealed bytes without executing source and refuses links', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ie-alpha-source-')));
  try {
    const data = Buffer.from('throw new Error("retained source must never execute");\n');
    const expected = {bytes: data.length, hash: 'sha256:' + createHash('sha256').update(data).digest('hex')};
    writeFileSync(join(directory, 'source.mjs'), data, {flag: 'wx', mode: 0o600});
    const captured = heldAlphaSource(directory, new Set(['source.mjs']), 'source.mjs', expected);
    assert.deepEqual(captured, {data, ...expected});
    assert.throws(() => heldAlphaSource(directory, new Set(), 'source.mjs', expected), /Missing retained alpha input/);
    assert.throws(() => heldAlphaSource(directory, new Set(['source.mjs']), 'source.mjs',
      {...expected, hash: 'sha256:' + '4'.repeat(64)}), /Retained alpha input changed/);
    symlinkSync('source.mjs', join(directory, 'linked.mjs'));
    assert.throws(() => heldAlphaSource(directory, new Set(['linked.mjs']), 'linked.mjs', expected), /singly linked/);
    linkSync(join(directory, 'source.mjs'), join(directory, 'hard.mjs'));
    assert.throws(() => heldAlphaSource(directory, new Set(['source.mjs']), 'source.mjs', expected), /singly linked/);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});
