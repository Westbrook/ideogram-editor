import test from 'node:test';
import assert from 'node:assert/strict';
import { planCompositionFixture } from '../../tooling/qualification/campaigns/backend-composition-fixture.mjs';

const digest = 'sha256:' + 'a'.repeat(64);
const corpus = () => ({ files: [
  { role: 'font', id: 'font-NotoSans', path: '/sealed/NotoSans.ttf', sha256: digest, byteLength: '556216', faceIndex: 0, licensePath: '/sealed/OFL.txt', licenseHash: digest },
  { role: 'font-manifest', id: 'text-font-manifest', path: '/sealed/manifest.json', sha256: digest, byteLength: '1024' },
  ...Array.from({ length: 30 }, (_, index) => 'WJ' + String(index + 1).padStart(2, '0')).map(id => ({ id, role: 'case', path: '/sealed/' + id + '.bin', sha256: digest, byteLength: '1049000' })),
] });

test('WJ native preparation is its own exact boundary workload', () => {
  const plan = planCompositionFixture({ definition: 'WJ', corpus: corpus() });
  assert.equal(plan.definition.id, 'WJ'); assert.equal(plan.textLayers, 75); assert.equal(plan.textBytes, 1048576);
  assert.deepEqual(plan.document, { width: 512, height: 512 }); assert.deepEqual(plan.frame, { width: 360, height: 180 });
  assert.equal(plan.preparationOnly, true); assert.match(plan.qualification, /not the full WXs/);
});

test('WJ rejects a mislabeled workload and missing native boundary specimens before opening storage', () => {
  assert.throws(() => planCompositionFixture({ definition: 'WXs', corpus: corpus() }));
  for (const id of ['WJ01', 'WJ24', 'WJ26', 'WJ29', 'WJ30']) {
    const value = corpus(); value.files = value.files.filter(file => file.id !== id);
    assert.throws(() => planCompositionFixture({ definition: 'WJ', corpus: value }), new RegExp('Missing or duplicate sealed ' + id));
  }
});

test('WJ cannot prepare unsealed or ambiguous font dependencies', () => {
  for (const mutate of [
    value => { value.files[0].sha256 = 'unsealed'; },
    value => { delete value.files[0].licenseHash; },
    value => { value.files[0].faceIndex = 1; },
    value => { value.files.push({ ...value.files[0] }); },
    value => { value.files = value.files.filter(file => file.role !== 'font-manifest'); },
    value => { value.files.push({ ...value.files.find(file => file.id === 'WJ30') }); },
  ]) {
    const value = corpus(); mutate(value); assert.throws(() => planCompositionFixture({ definition: 'WJ', corpus: value }));
  }
});
