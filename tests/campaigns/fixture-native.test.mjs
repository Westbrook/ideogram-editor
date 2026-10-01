import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { planNativeFixture, restrictedFontBytes } from '../../tooling/qualification/campaigns/fixture-native.mjs';
import { workloadDefinition } from '../../tooling/qualification/campaigns/fixtures.mjs';
const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const corpus = id => {
  const d = workloadDefinition(id), files = []; let left = d.textBytes;
  for (let i = 0; i < d.textLayers; i++) { const n = Math.floor(left / (d.textLayers - i)); files.push({ role: 'text', path: '/retained/text-' + i, index: i, byteLength: String(n), sha256: hash('text-' + i) }); left -= n; }
  for (let i = 0; i < d.fontFaces; i++) files.push({ role: 'font', path: '/retained/font-' + i, index: i, byteLength: '1024', sha256: hash('font-' + i), faceIndex: 0, licensePath: '/retained/license', licenseHash: hash('license') });
  files.push({ role: 'font-manifest', path: '/retained/fonts.json', byteLength: '100', sha256: hash('manifest') }); return { files };
};
test('WX native plans preserve exact text/font/layer totals and do no runtime work', () => {
  for (const id of ['WXn', 'WXs']) { const p = planNativeFixture({ definition: id, corpus: corpus(id) }); assert.equal(p.texts.length, p.definition.textLayers); assert.equal(p.fonts.length, p.definition.fontFaces); assert.equal(p.preparationOnly, true); assert.equal(p.runtimeRequired, true); }
});
test('native plans reject scale-downs, relabelled image workloads and bad byte/face cohorts', () => {
  assert.throws(() => planNativeFixture({ definition: 'W1', corpus: corpus('WXn') }), /NATIVE_WORKLOAD_REQUIRED/);
  assert.throws(() => planNativeFixture({ definition: { ...workloadDefinition('WXn'), textLayers: 1 }, corpus: corpus('WXn') }), /SCALING/);
  const c = corpus('WXs'); c.files.find(f => f.role === 'text').byteLength = '1'; assert.throws(() => planNativeFixture({ definition: 'WXs', corpus: c }), /BYTE_COUNTS/);
  const f = corpus('WXn'), fonts = f.files.filter(x => x.role === 'font'); fonts[1].sha256 = fonts[0].sha256; assert.throws(() => planNativeFixture({ definition: 'WXn', corpus: f }), /DISTINCT/);
});
test('restricted recovery face is an owned copy with a valid OS/2 checksum and unchanged source', async () => {
  const original = await readFile(new URL('../../vendor/text/fonts/NotoSans-Regular.ttf', import.meta.url)), before = hash(original), restricted = restrictedFontBytes(original);
  assert.equal(hash(original), before); assert.notEqual(hash(restricted), before); assert.equal(restricted.length, original.length);
  let entry;
  for (let i = 0; i < restricted.readUInt16BE(4); i++) { const at = 12 + i * 16; if (restricted.toString('ascii', at, at + 4) === 'OS/2') entry = { at, offset: restricted.readUInt32BE(at + 8), length: restricted.readUInt32BE(at + 12) }; }
  assert(entry); assert.equal(restricted.readUInt16BE(entry.offset + 8), 2); let sum = 0;
  for (let i = 0; i < entry.length; i += 4) { let word = 0; for (let j = 0; j < 4; j++) word = word * 256 + (i + j < entry.length ? restricted[entry.offset + i + j] : 0); sum = (sum + word) >>> 0; }
  assert.equal(restricted.readUInt32BE(entry.at + 4), sum);
});
