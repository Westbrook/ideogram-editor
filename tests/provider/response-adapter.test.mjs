import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptResponse } from '../../dist/local/server/provider/response-adapter.js';

const v4 = { profile: 'ideogram-v4-result-1', endpoint: 'ideogram/v4' };
const v45 = { profile: 'ideogram-v45-result-1', endpoint: 'ideogram/v4.5' };
const image = { url: 'https://v3b.fal.media/files/fixture.png', content_type: 'image/png', file_size: 42, width: 1024, height: 1024 };
const scan = (patch = {}) => ({ foundPrompt: true, seed: '900719925474099312345', timings: { inference: 0.5 }, images: [image], safety: [false], imagesArray: true, safetyArray: true, timingsObject: true, timingsValid: true, ...patch });
const minimal45 = (patch = {}) => scan({ foundPrompt: false, timings: {}, images: [{ url: image.url }], safety: [], safetyArray: false, timingsObject: false, ...patch });
const adapt = (profile, envelope, patch = {}) => adaptResponse(profile, { requestedCount: 1, sourceComplete: true, envelope, ...patch });

test('V4 qualified false correspondence retains existing candidate eligibility', () => {
  const value = adapt(v4, scan());
  assert.equal(value.envelope.schemaValid, true);
  assert.equal(value.observationPhase, 'completed');
  assert.equal(value.returnedSeed, '900719925474099312345');
  assert.equal(value.outputs[0].safety, 'safe');
  assert.equal(value.outputs[0].media, 'fetch-validate-prepare');
  assert.equal(value.outputs[0].decodeAllowed, true);
  assert.equal(value.outputs[0].publicationAfterValidatedPreparation, true);
  assert.equal(value.outputs[0].displayAllowed, false);
  assert.equal(value.metadata.provenance.status, 'requires-prompt-derivation');
});

test('V4 missing prompt preserves safe independent raster eligibility and partial provenance', () => {
  const value = adapt(v4, scan({ foundPrompt: false }));
  assert.equal(value.envelope.schemaValid, false);
  assert.equal(value.envelope.candidateBasisValid, true);
  assert.equal(value.observationPhase, 'completed');
  assert.equal(value.outputs[0].safety, 'safe');
  assert.equal(value.metadata.returnedPrompt.status, 'missing-required');
  assert.deepEqual(value.metadata.provenance, { status: 'partial', reason: 'returned-prompt-missing-required' });
});

test('V4 missing or invalid timings keeps existing quarantine and unknown safety', () => {
  for (const patch of [{ timingsObject: false }, { timingsValid: false }]) {
    const value = adapt(v4, scan(patch));
    assert.equal(value.observationPhase, 'quarantined');
    assert.equal(value.outputs[0].safety, 'unknown');
    assert.equal(value.outputs[0].media, 'retain-protected-encoded');
    assert.equal(value.outputs[0].decodeAllowed, false);
  }
});

test('V4 flagged, missing and misaligned safety retains protected originals without publication', () => {
  for (const [patch, expected] of [[{ safety: [true] }, 'withheld'], [{ safetyArray: false, safety: [] }, 'unknown'], [{ safety: [false, false] }, 'unknown']]) {
    const value = adapt(v4, scan(patch));
    assert.equal(value.outputs[0].safety, expected);
    assert.equal(value.outputs[0].state, 'withheld');
    assert.equal(value.outputs[0].media, 'retain-protected-encoded');
    assert.equal(value.outputs[0].publicationAfterValidatedPreparation, false);
  }
});

test('V4 invalid declared dimensions remain a separate preparation validator concern', () => {
  const value = adapt(v4, scan({ images: [{ ...image, width: '1024' }] }));
  assert.equal(value.envelope.schemaValid, false);
  assert.equal(value.envelope.candidateBasisValid, true);
  assert.equal(value.outputs[0].safety, 'safe');
  assert(value.envelope.issues.includes('IMAGE_FILE_INVALID'));
});

test('minimal v4.5 response is well formed while all image publication remains withheld', () => {
  const value = adapt(v45, minimal45());
  assert.equal(value.envelope.schemaValid, true);
  assert.equal(value.observationPhase, 'completed');
  assert.equal(value.returnedSeed, '900719925474099312345');
  assert.equal(value.actualCount, 1);
  assert.equal(value.metadata.returnedPrompt.status, 'unavailable-by-contract');
  assert.equal(value.metadata.returnedPrompt.deriveDecodedPrompt, false);
  assert.deepEqual(value.metadata.timings, { status: 'unavailable-by-contract', values: null, units: null });
  assert.deepEqual(value.metadata.provenance, { status: 'partial', reason: 'returned-prompt-unavailable-by-contract' });
  const output = value.outputs[0];
  assert.equal(output.safety, 'unknown');
  assert.equal(output.state, 'withheld');
  assert.equal(output.media, 'retain-protected-encoded');
  assert.equal(output.decodeAllowed, false);
  assert.equal(output.displayAllowed, false);
  assert.equal(output.adoptionAllowed, false);
  assert.equal(output.exportAllowed, false);
  assert.equal(output.publicationAfterValidatedPreparation, false);
  assert.deepEqual(output.declared, { contentType: null, byteLength: null, width: null, height: null });
});

test('undeclared v4.5 extras cannot borrow V4 safety or prompt/dimension authority', () => {
  const value = adapt(v45, scan());
  assert.equal(value.envelope.schemaValid, true);
  assert.equal(value.outputs[0].safety, 'unknown');
  assert.equal(value.outputs[0].decodeAllowed, false);
  assert.equal(value.outputs[0].declared.width, null);
  assert.equal(value.metadata.returnedPrompt.deriveDecodedPrompt, false);
  assert.equal(value.metadata.timings.values, null);
  assert.equal(value.metadata.safety.authority, null);
});

test('v4.5 exact integer seed rejects numeric coercion, exponent strings and absence', () => {
  for (const seed of [9007199254740992, '9e16', '1.0', null]) {
    const value = adapt(v45, minimal45({ seed }));
    assert.equal(value.envelope.schemaValid, false);
    assert.equal(value.observationPhase, 'quarantined');
    assert.equal(value.returnedSeed, null);
    assert.equal(value.outputs[0].decodeAllowed, false);
  }
});

test('v4.5 malformed declared File metadata stays invalid, protected and nonpublishable', () => {
  for (const file of [{}, { url: 42 }, { url: image.url, content_type: 42 }, { url: image.url, file_name: [] }, { url: image.url, file_size: '42' }, { url: image.url, file_size: -1 }]) {
    const value = adapt(v45, minimal45({ images: [file] }));
    assert.equal(value.envelope.schemaValid, false);
    assert.equal(value.observationPhase, 'quarantined');
    assert.equal(value.outputs[0].safety, 'unknown');
    assert.equal(value.outputs[0].publicationAfterValidatedPreparation, false);
  }
});

test('empty, fewer and extra arrays preserve exact counts and missing output slots', () => {
  const empty = adapt(v45, minimal45({ images: [] }), { requestedCount: 2 });
  assert.equal(empty.envelope.schemaValid, true);
  assert.equal(empty.actualCount, 0);
  assert.deepEqual(empty.outputs.map(item => [item.state, item.media]), [['missing', 'none'], ['missing', 'none']]);
  const extra = adapt(v45, minimal45({ images: [{ url: image.url }, { url: image.url + '?second' }] }));
  assert.equal(extra.actualCount, 2);
  assert.equal(extra.outputs.length, 2);
  assert(extra.outputs.every(item => item.safety === 'unknown'));
});

test('partial or unparseable source cannot invent image ownership', () => {
  for (const input of [{ sourceComplete: false, envelope: minimal45() }, { sourceComplete: true, envelope: null }]) {
    const value = adaptResponse(v45, { requestedCount: 1, ...input });
    assert.equal(value.observationPhase, 'quarantined');
    assert.equal(value.actualCount, null);
    assert.equal(value.outputs[0].present, false);
    assert.equal(value.outputs[0].media, 'none');
    assert.equal(value.metadata.provenance.reason, 'source-incomplete-or-unparseable');
  }
});

test('profile selection is exact, including separately named edit profile route', () => {
  assert.throws(() => adapt({ ...v4, endpoint: v45.endpoint }, minimal45()), /RESPONSE_PROFILE_ENDPOINT_MISMATCH/);
  assert.throws(() => adapt({ ...v45, endpoint: v4.endpoint }, scan()), /RESPONSE_PROFILE_ENDPOINT_MISMATCH/);
  assert.throws(() => adapt({ profile: 'unknown', endpoint: v45.endpoint }, minimal45()), /RESPONSE_PROFILE_ENDPOINT_MISMATCH/);
  assert.equal(adapt({ ...v45, endpoint: 'ideogram/v4.5/edit' }, minimal45()).outputs[0].safety, 'unknown');
  for (const count of [0, 5, 1.5]) assert.throws(() => adapt(v45, minimal45(), { requestedCount: count }), /REQUESTED_COUNT/);
});

test('decisions are immutable snapshots with no alias to caller timing objects', () => {
  const source = scan(), value = adapt(v4, source);
  source.timings.inference = 123;
  assert.equal(value.metadata.timings.values.inference, 0.5);
  assert.throws(() => { value.outputs[0].safety = 'unknown'; }, TypeError);
  assert.throws(() => { value.metadata.timings.values.inference = 999; }, TypeError);
});
