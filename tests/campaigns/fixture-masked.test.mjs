import test from 'node:test';
import assert from 'node:assert/strict';
import { maskedFixturePlan, seedMaskedProductCandidates } from '../../tooling/qualification/campaigns/fixture-masked.mjs';

function corpus(width, height, count = 1) {
  return { files: Array.from({ length: count }, (_, index) => ({ id: 'candidate_' + index, role: 'candidate', format: 'png', width, height, path: '/sealed/candidate-' + index + '.png', byteLength: '100', sha256: 'sha256:' + String(index + 1).repeat(64) })) };
}
const normal = { id: 'W1', width: 2048, height: 2048, candidates: 1 };
const maximum = { id: 'W2', width: 5000, height: 5000, candidates: 4 };

test('masked producer requires revision-preserving integration before invocation', () => {
  assert.equal(seedMaskedProductCandidates.requiresStableSourceRevision, true);
});

test('masked fixture seals actual normal and maximum candidate grids without a scaled substitute', () => {
  for (const specification of [normal, maximum]) {
    const inputs = corpus(specification.width, specification.height, specification.candidates), plan = maskedFixturePlan(specification, inputs);
    assert.equal(plan.endpoint, 'ideogram/v4/inpaint'); assert.equal(plan.scope, 'visible-document');
    assert.equal(plan.width, specification.width); assert.equal(plan.height, specification.height); assert.equal(plan.count, specification.candidates);
    assert.deepEqual(plan.candidates, inputs.files);
  }
  assert.throws(() => maskedFixturePlan(maximum, corpus(2048, 2048, 4)));
  assert.throws(() => maskedFixturePlan(maximum, corpus(5000, 5000, 1)));
});

test('independent request mask has a genuinely feathered interior and preserved exterior', () => {
  for (const specification of [normal, maximum]) {
    const plan = maskedFixturePlan(specification, corpus(specification.width, specification.height, specification.candidates));
    assert.equal(plan.maskPlan.feather, 64); assert.equal(plan.maskPlan.operations.length, 1);
    const operation = plan.maskPlan.operations[0], shape = operation.shape;
    assert.equal(operation.mode, 'replace'); assert.equal(shape.kind, 'rectangle');
    assert(shape.x > 64 && shape.y > 64); assert(shape.x + shape.width + 64 < specification.width); assert(shape.y + shape.height + 64 < specification.height);
    assert(shape.width * shape.height > 0 && shape.width * shape.height < specification.width * specification.height);
  }
});

test('encoded-only C is never claimed for retained authoritative canonical inputs', () => {
  const plan = maskedFixturePlan(normal, corpus(2048, 2048));
  assert.equal(plan.representation.strictEncodedOnlyC, false);
  assert.match(plan.representation.original, /canonical CP-1/); assert.match(plan.representation.mask, /R16/);
  assert.match(plan.representation.candidate, /normalized canonical/);
  assert.equal(plan.representation.preservedComposite, 'absent until explicit preparation or acceptance');
});

test('masked producer refuses wrong formats, malformed identities and unnamed workloads', () => {
  const jpeg = corpus(2048, 2048); jpeg.files[0].format = 'jpeg'; assert.throws(() => maskedFixturePlan(normal, jpeg));
  const malformed = corpus(2048, 2048); malformed.files[0].sha256 = 'unverified'; assert.throws(() => maskedFixturePlan(normal, malformed));
  assert.throws(() => maskedFixturePlan({ ...normal, id: 'W0' }, corpus(2048, 2048)));
  assert.throws(() => maskedFixturePlan({ ...normal, width: 9000 }, corpus(9000, 2048)));
});

test('native mixed and adapter workloads preserve their own source grid and full candidate count', () => {
  for (const id of ['WXn', 'WXs', 'WA']) {
    const specification = id === 'WXs' ? { ...maximum, id } : { ...normal, id };
    const plan = maskedFixturePlan(specification, corpus(specification.width, specification.height, specification.candidates));
    assert.equal(plan.scope, 'visible-document'); assert.equal(plan.count, specification.candidates);
  }
});
