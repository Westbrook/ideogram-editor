import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  newV45EditFields,
  resolveV45Edit,
  wireV45Edit,
  v45EditDimensions,
  v45EditMaskTransport,
  validateV45EditReferences,
} from '../../dist/local/src/request/v45-edit.js';

// Staged source only: these tests do not authorize upload, inference, or admission.
const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const blob = (label, mediaType, byteLength = '32') => ({hash: hash(label), byteLength, mediaType});
const source = (label = 'source', width = 801, height = 603) => ({
  blob: blob(label + '-encoded', 'image/png'),
  pixels: blob(label + '-pixels', 'application/x-ideogram-rgba8', String(width * height * 4)),
  manifest: blob(label + '-manifest', 'application/json'),
  pixelIdentity: hash(label + '-pixel-identity'),
  width,
  height,
});
const mask = input => ({
  blob: blob('mask-black-edit-transport', 'image/png'),
  pixels: blob('mask-black-edit-pixels', 'application/x-ideogram-rgba8', String(input.width * input.height * 4)),
  manifest: blob('mask-black-edit-manifest', 'application/json'),
  pixelIdentity: hash('mask-black-edit-pixel-identity'),
  width: input.width,
  height: input.height,
  sourcePixels: structuredClone(input.pixels),
  polarity: 'black-edit',
  editPixels: 1,
  keepPixels: input.width * input.height - 1,
});
function fixture(operation = 'transform-v45', fields = {}) {
  const input = source();
  return {
    operation,
    prompt: 'Change the blue sign to read "OPEN", preserving the frame.',
    promptMode: 'plain',
    fields: {...newV45EditFields(operation), ...fields},
    source: input,
    mask: operation === 'inpaint-v45' ? mask(input) : null,
    references: [],
  };
}
const resolve = (operation = 'transform-v45', fields = {}) => resolveV45Edit(fixture(operation, fields));
const error = (run, code, message) => assert.throws(run, {code}, message);

test('edit defaults select the operation-specific precision and explicit staged defaults', () => {
  for (const [operation, precision] of [['transform-v45', 'regular'], ['inpaint-v45', 'high']]) {
    const first = newV45EditFields(operation);
    assert.deepEqual(first, {precision, quality: 'medium', count: '1', seed: '', size: 'auto', width: '1024', height: '1024'});
    first.count = '4';
    assert.equal(newV45EditFields(operation).count, '1');
  }
});

for (const operation of ['transform-v45', 'inpaint-v45']) {
  test(operation + ' uses the V4.5 edit endpoint and exact retained transport identities', () => {
    const input = fixture(operation), before = structuredClone(input);
    const request = resolveV45Edit(input), body = JSON.parse(wireV45Edit(request));
    const expected = {
      prompt: input.prompt,
      image_url: 'asset:' + input.source.blob.hash,
      image_size: 'auto',
      edit_precision: operation === 'inpaint-v45' ? 'high' : 'regular',
      quality: 'medium',
      num_images: 1,
      sync_mode: false,
      ...(input.mask ? {mask_url: 'asset:' + input.mask.blob.hash} : {}),
    };
    assert.deepEqual(request.body, expected);
    assert.deepEqual(body, expected);
    assert.equal(request.kind, operation);
    assert.equal(request.endpoint, 'ideogram/v4.5/edit');
    assert.deepEqual(request.requested, {width: 801, height: 603});
    assert.equal(request.outputFormat, 'provider-controlled');
    assert.equal(request.outputSafety, 'unknown');
    assert.equal(request.candidateAdmission, 'withheld');
    assert.equal(request.safetyAdmission, 'blocked-unavailable-evidence');
    assert.equal(request.production, 'blocked-unqualified-upload');
    assert.equal(request.estimate.cents, 6);
    assert.equal(request.estimate.actualCharge, null);
    assert.deepEqual(input, before);
  });
}

test('resolution clones prepared source and mask identities without retaining caller-owned objects', () => {
  const input = fixture('inpaint-v45');
  const before = structuredClone(input), request = resolveV45Edit(input);
  assert.deepEqual(request.source, before.source);
  assert.deepEqual(request.mask, before.mask);
  assert.notStrictEqual(request.source, input.source);
  for (const key of ['blob', 'pixels', 'manifest']) assert.notStrictEqual(request.source[key], input.source[key]);
  assert.notStrictEqual(request.mask, input.mask);
  for (const key of ['blob', 'pixels', 'manifest', 'sourcePixels']) assert.notStrictEqual(request.mask[key], input.mask[key]);
  input.source.blob.hash = hash('changed-encoded');
  input.source.pixels.hash = hash('changed-pixels');
  input.source.manifest.hash = hash('changed-source-manifest');
  input.mask.manifest.hash = hash('changed-mask-manifest');
  input.mask.blob.hash = hash('changed-mask-transport');
  assert.deepEqual(request.source, before.source);
  assert.deepEqual(request.mask, before.mask);
});

test('legacy and provider-shaped controls cannot enter the strict V4.5 edit field set', () => {
  for (const key of [
    'expansion', 'expansion_model', 'promptExpansion', 'enable_prompt_expansion',
    'speed', 'rendering_speed', 'acceleration', 'strength', 'format', 'output_format',
    'enable_safety_checker', 'image_url', 'mask_url', 'reference_image_urls', 'adapters',
  ]) {
    error(() => resolve('transform-v45', {[key]: 'legacy'}), 'V45_EDIT_FIELDS', key);
  }
  for (const key of Object.keys(newV45EditFields('transform-v45'))) {
    const input = fixture();
    delete input.fields[key];
    error(() => resolveV45Edit(input), 'V45_EDIT_FIELDS', 'missing ' + key);
  }
  const input = fixture();
  input.fields.count = 1;
  error(() => resolveV45Edit(input), 'V45_EDIT_FIELDS');
});

test('legacy routes and incompatible operation/precision pairs are rejected without fallback', () => {
  for (const operation of ['transform', 'inpaint', 'generate-v45', 'transform-adapters', 'inpaint-adapters']) {
    const input = fixture();
    input.operation = operation;
    error(() => resolveV45Edit(input), 'V45_EDIT_OPERATION', operation);
  }
  for (const [operation, precision] of [['transform-v45', 'high'], ['inpaint-v45', 'regular'], ['transform-v45', 'precise']]) {
    error(() => resolve(operation, {precision}), 'V45_EDIT_OPERATION', operation + ':' + precision);
  }
});

test('only the reviewed medium edit quality is admitted', () => {
  for (const operation of ['transform-v45', 'inpaint-v45']) {
    for (const quality of ['very_low', 'low', 'high', 'very_high', 'MEDIUM', '']) {
      error(() => resolve(operation, {quality}), 'V45_EDIT_QUALITY', operation + ':' + quality);
    }
  }
});

test('plain and raw prompts retain exact text and count Unicode scalar values', () => {
  for (const promptMode of ['plain', 'raw']) {
    for (const prompt of ['x', '  Exact "text"\n🦋  ', '🦋'.repeat(10000)]) {
      const input = fixture();
      Object.assign(input, {promptMode, prompt});
      assert.equal(resolveV45Edit(input).body.prompt, prompt);
    }
  }
  for (const prompt of ['', 'x'.repeat(10001), '🦋'.repeat(10001), '\ud800', 'x\udc00y']) {
    const input = fixture();
    input.prompt = prompt;
    error(() => resolveV45Edit(input), 'V45_PROMPT_LENGTH');
  }
  const input = fixture();
  input.promptMode = 'composition';
  error(() => resolveV45Edit(input), 'V45_COMPOSITION_UNQUALIFIED');
});

test('application counts remain one through four and medium estimates retain unknown actual charge', () => {
  for (const operation of ['transform-v45', 'inpaint-v45']) {
    for (const count of ['1', '2', '3', '4']) {
      const request = resolve(operation, {count});
      assert.equal(request.body.num_images, Number(count));
      assert.equal(request.estimate.cents, 6 * Number(count));
      assert.equal(request.estimate.actualCharge, null);
    }
    for (const count of ['0', '5', '8', '-1', '01', '1.0', '1e0', ' 1', '']) {
      error(() => resolve(operation, {count}), 'V45_APP_COUNT', operation + ':' + count);
    }
  }
});

test('seed serialization preserves giant signed integer tokens without quoting or rounding', () => {
  for (const seed of ['0', '-1', '184467440737095516151234567890', '-184467440737095516151234567890']) {
    const request = resolve('transform-v45', {seed}), wire = wireV45Edit(request);
    assert.match(wire, new RegExp('"seed":' + seed + '(?:,|})'));
    assert.equal(wire.includes('"seed":"'), false);
  }
  assert.equal(Object.hasOwn(JSON.parse(wireV45Edit(resolve())), 'seed'), false);
  for (const seed of ['1.0', '+1', '01', '-01', '1e3', 'NaN', 'Infinity', ' 1', '1 ', '--1']) {
    error(() => resolve('transform-v45', {seed}), 'V45_SEED', seed);
  }
});

test('edit presets use standard fal dimensions, including square 512 and 4:3 768x1024', () => {
  const presets = {
    square: [512, 512],
    square_hd: [1024, 1024],
    portrait_4_3: [768, 1024],
    landscape_4_3: [1024, 768],
    portrait_16_9: [576, 1024],
    landscape_16_9: [1024, 576],
  };
  for (const [size, [width, height]] of Object.entries(presets)) {
    const request = resolve('transform-v45', {size});
    assert.equal(request.body.image_size, size);
    assert.deepEqual(request.requested, {width, height});
  }
  for (const size of ['source', '2K', 'square_2k', '1024x1024', '']) {
    error(() => resolve('transform-v45', {size}), 'V45_EDIT_SIZE', size);
  }
});

test('unmasked regular custom sizes follow the edit grid rather than the generation size whitelist', () => {
  for (const [width, height] of [[256, 256], [1024, 768], [2048, 2048], [1536, 256], [256, 1536]]) {
    const request = resolve('transform-v45', {size: 'custom', width: String(width), height: String(height)});
    assert.deepEqual(request.body.image_size, {width, height});
    assert.deepEqual(request.requested, {width, height});
  }
  for (const [width, height] of [[224, 256], [256, 224], [272, 256], [256, 272], [2048, 2080], [2080, 2048], [1568, 256], [256, 1568]]) {
    error(() => resolve('transform-v45', {size: 'custom', width: String(width), height: String(height)}), 'V45_EDIT_SIZE', width + 'x' + height);
  }
  for (const token of ['0', '-256', '0256', '+256', '256.0', '2.56e2', 'NaN', 'Infinity', '9007199254740993', ' 256', '']) {
    for (const dimension of ['width', 'height']) {
      error(() => resolve('transform-v45', {size: 'custom', width: '256', height: '256', [dimension]: token}), 'V45_EDIT_SIZE', dimension + ':' + token);
    }
  }
});

test('masked high precision requires auto even when an explicit size equals the source', () => {
  for (const size of ['square', 'square_hd', 'portrait_4_3', 'landscape_4_3', 'portrait_16_9', 'landscape_16_9', 'custom']) {
    const input = fixture('inpaint-v45', {size, width: '1024', height: '1024'});
    input.source = source('square-source', 1024, 1024);
    input.mask = mask(input.source);
    error(() => resolveV45Edit(input), 'V45_EDIT_AUTO_REQUIRED', size);
  }
});

test('geometry validation requires auto for either high precision or a mask independently', () => {
  const attached = {width: 801, height: 603};
  for (const [precision, masked] of [['high', false], ['regular', true], ['high', true]]) {
    assert.deepEqual(v45EditDimensions('auto', precision, masked, attached), attached);
    for (const size of ['square_hd', {width: 1024, height: 1024}]) {
      error(() => v45EditDimensions(size, precision, masked, attached), 'V45_EDIT_AUTO_REQUIRED');
    }
  }
});

test('source-bound masks are mandatory only for inpaint and must match retained source pixels', () => {
  const missing = fixture('inpaint-v45');
  missing.mask = null;
  error(() => resolveV45Edit(missing), 'V45_EDIT_MASK_REQUIRED');
  const unexpected = fixture();
  unexpected.mask = mask(unexpected.source);
  error(() => resolveV45Edit(unexpected), 'V45_EDIT_MASK_UNEXPECTED');
  for (const change of [
    input => input.mask.width++,
    input => input.mask.height++,
    input => input.mask.sourcePixels = structuredClone(input.source.blob),
    input => input.mask.sourcePixels.hash = hash('different-source-pixels'),
    input => input.mask.sourcePixels.byteLength = '4',
    input => input.mask.sourcePixels.mediaType = 'application/octet-stream',
  ]) {
    const input = fixture('inpaint-v45');
    change(input);
    error(() => resolveV45Edit(input), 'V45_EDIT_MASK_ALIGNMENT');
  }
  for (const field of ['editPixels', 'keepPixels']) {
    const input = fixture('inpaint-v45');
    input.mask[field] = 0;
    error(() => resolveV45Edit(input), 'V45_EDIT_MASK_HOMOGENEOUS', field);
  }
  const reusedDisplay = fixture('inpaint-v45');reusedDisplay.mask.polarity='white-edit';
  error(() => resolveV45Edit(reusedDisplay), 'V45_EDIT_MASK_TRANSPORT');
  for(const [editPixels,keepPixels] of [[1,1],[-1,484004],[1.5,484001.5],[NaN,484002],[Infinity,1]]){
    const input=fixture('inpaint-v45');Object.assign(input.mask,{editPixels,keepPixels});
    error(()=>resolveV45Edit(input),'V45_EDIT_MASK_HOMOGENEOUS');
  }
});

test('white-edit binary coverage is inverted byte-for-byte into a separate transport buffer', () => {
  const backing = Uint8Array.of(19, 0, 255, 255, 0, 0, 255, 0, 255, 23);
  const coverage = {width: 4, height: 2, polarity: 'white-edit', samples: backing.subarray(1, 9)};
  const before = new Uint8Array(backing);
  const output = v45EditMaskTransport({width: 4, height: 2}, coverage);
  assert(output instanceof Uint8Array);
  assert.deepEqual([...output], [255, 0, 0, 255, 255, 0, 255, 0]);
  assert.deepEqual(backing, before);
  assert.notStrictEqual(output.buffer, backing.buffer);
  output[0] = 0;
  assert.deepEqual(backing, before);
});

test('mask transport rejects homogeneous, fractional and mismatched coverage without repairing bytes', () => {
  for (const samples of [Uint8Array.of(0, 0, 0, 0), Uint8Array.of(255, 255, 255, 255)]) {
    error(() => v45EditMaskTransport({width: 2, height: 2}, {width: 2, height: 2, polarity: 'white-edit', samples}), 'V45_EDIT_MASK_HOMOGENEOUS');
  }
  for (const value of [1, 127, 128, 254]) {
    const samples = Uint8Array.of(0, value, 255, 0), before = new Uint8Array(samples);
    error(() => v45EditMaskTransport({width: 2, height: 2}, {width: 2, height: 2, polarity: 'white-edit', samples}), 'V45_EDIT_MASK_BINARY');
    assert.deepEqual(samples, before);
  }
  for (const coverage of [
    {width: 1, height: 4, samples: Uint8Array.of(0, 255, 0, 255)},
    {width: 4, height: 1, samples: Uint8Array.of(0, 255, 0, 255)},
  ]) {
    error(() => v45EditMaskTransport({width: 2, height: 2}, {polarity: 'white-edit', ...coverage}), 'V45_EDIT_MASK_ALIGNMENT');
  }
  for (const samples of [Uint8Array.of(0, 255, 0), Uint8Array.of(0, 255, 0, 255, 0)]) {
    error(() => v45EditMaskTransport({width: 2, height: 2}, {width: 2, height: 2, polarity: 'white-edit', samples}), 'V45_EDIT_MASK_BINARY');
  }
  for (const coverage of [
    {width: 2, height: 2, polarity: 'black-edit', samples: Uint8Array.of(0, 255, 0, 255)},
    {width: 2, height: 2, polarity: 'white-edit', samples: [0, 255, 0, 255]},
  ]) {
    error(() => v45EditMaskTransport({width: 2, height: 2}, coverage), 'V45_EDIT_MASK_BINARY');
  }
});

test('reference validation preserves order and deeply clones each retained source descriptor', () => {
  for (const masked of [false, true]) {
    const references = Array.from({length: masked ? 3 : 4}, (_, i) => source('reference-' + i, 512 + i, 512));
    const before = structuredClone(references), result = validateV45EditReferences(references, masked);
    assert.deepEqual(result, before);
    assert.notStrictEqual(result, references);
    for (let i = 0; i < references.length; i++) {
      assert.notStrictEqual(result[i], references[i]);
      assert.notStrictEqual(result[i].blob, references[i].blob);
      assert.notStrictEqual(result[i].pixels, references[i].pixels);
    }
    assert.notStrictEqual(result[0].manifest, references[0].manifest);
    result[0].blob.hash = hash('changed-reference-blob');
    result[1].pixels.hash = hash('changed-reference-pixels');
    result[0].manifest.hash = hash('changed-reference-manifest');
    result.reverse();
    assert.deepEqual(references, before);
    assert.deepEqual(validateV45EditReferences([], masked), []);
  }
});

test('reference requests preserve order and enforce the masked and unmasked caps', () => {
  error(() => validateV45EditReferences(Array.from({length: 5}, (_, i) => source('reference-' + i)), false), 'V45_EDIT_REFERENCE_COUNT');
  error(() => validateV45EditReferences(Array.from({length: 4}, (_, i) => source('reference-' + i)), true), 'V45_EDIT_REFERENCE_COUNT');
  for (const operation of ['transform-v45', 'inpaint-v45']) {
    const input = fixture(operation);
    input.references = Array.from({length:operation==='inpaint-v45'?3:4},(_,index)=>source('reference-'+index));
    const before = structuredClone(input);
    const request=resolveV45Edit(input),wire=JSON.parse(wireV45Edit(request));
    assert.deepEqual(request.references,before.references);
    assert.deepEqual(wire.reference_image_urls,before.references.map(value=>'asset:'+value.blob.hash));
    input.references.reverse();assert.deepEqual(request.references,before.references);
    input.references.reverse();
    assert.deepEqual(input, before);
  }
});

test('serializer rejects forged route, contract, body, policy and retained source identities', () => {
  const mutations = [
    ['endpoint', request => request.endpoint = 'ideogram/v4/image-to-image'],
    ['contract', request => request.contract = 'forged-contract'],
    ['schema identity', request => request.schemaHash = hash('forged-schema')],
    ['kind', request => request.kind = 'transform'],
    ['legacy body', request => request.body.strength = 1],
    ['safety claim', request => request.body.enable_safety_checker = true],
    ['output format claim', request => request.body.output_format = 'png'],
    ['sync mode', request => request.body.sync_mode = true],
    ['empty prompt', request => request.body.prompt = ''],
    ['unreviewed quality', request => request.body.quality = 'high'],
    ['provider count', request => request.body.num_images = 8],
    ['source URL', request => request.body.image_url = 'asset:' + hash('forged-source')],
    ['source blob', request => request.source.blob.hash = hash('forged-source-blob')],
    ['source shape', request => request.source.legacyVersion = 'v4'],
    ['source geometry', request => request.source.width++],
    ['requested geometry', request => request.requested.width++],
    ['production gate', request => request.production = 'ready'],
    ['safety admission', request => request.safetyAdmission = 'safe'],
    ['output safety', request => request.outputSafety = 'safe'],
    ['candidate admission', request => request.candidateAdmission = 'admitted'],
    ['output format', request => request.outputFormat = 'png'],
    ['undeclared reference field', request => request.references = [source('forged-reference')]],
    ['estimated charge', request => request.estimate.cents = 0],
    ['actual charge claim', request => request.estimate.actualCharge = 6],
    ['rounded seed', request => request.seed = {kind: 'integer', decimal: '1e30'}],
    ['unexpected mask', request => request.body.mask_url = 'asset:' + hash('unexpected-mask')],
  ];
  for (const [label, mutate] of mutations) {
    const request = resolve();
    mutate(request);
    assert.throws(() => wireV45Edit(request), undefined, label);
  }
});

test('serializer rejects masks whose transport, alignment or nonhomogeneous coverage claims changed', () => {
  for (const [label, mutate] of [
    ['display mask URL', request => request.body.mask_url = 'asset:' + hash('original-white-display')],
    ['changed transport', request => request.mask.blob.hash = hash('forged-mask-transport')],
    ['changed source binding', request => request.mask.sourcePixels.hash = hash('forged-mask-source')],
    ['changed mask dimensions', request => request.mask.width++],
    ['changed polarity', request => request.mask.polarity = 'white-edit'],
    ['empty mask', request => request.mask.editPixels = 0],
    ['full mask', request => request.mask.keepPixels = 0],
    ['missing mask URL', request => delete request.body.mask_url],
    ['missing mask descriptor', request => request.mask = null],
    ['explicit masked size', request => request.body.image_size = 'square_hd'],
  ]) {
    const request = resolve('inpaint-v45');
    mutate(request);
    assert.throws(() => wireV45Edit(request), undefined, label);
  }
});

test('serializer validates original custom-size types without coercing forged fields', () => {
  for (const size of [
    {width: '1024', height: 768},
    {width: 1024, height: '768'},
    {width: 1024.5, height: 768},
    {width: 1024, height: NaN},
    {width: 1024, height: 768, extra: true},
    null,
  ]) {
    const request = resolve('transform-v45', {size: 'custom', width: '1024', height: '768'});
    request.body.image_size = size;
    assert.throws(() => wireV45Edit(request));
  }
});

test('pure edit inputs accept only prepared provider-grid descriptors, never relabeled source records',()=>{
 const input=fixture('inpaint-v45');input.source=source('mapped-source',4,1);input.mask=mask(input.source);
 const request=resolveV45Edit(input);assert.deepEqual(request.requested,{width:4,height:1});
 for(const key of ['assetId','version','scope','documentRevision','capture']){
  const changed=fixture();changed.source[key]=key==='capture'?blob('capture','application/json'):'original-identity';
  error(()=>resolveV45Edit(changed),'V45_EDIT_FIELDS',key);
 }
 for(const mutate of [s=>s.pixels.byteLength='4',s=>s.pixels.mediaType='image/png',s=>s.manifest.mediaType='text/plain',s=>s.blob.mediaType='image/jpeg',s=>s.pixelIdentity='unsealed']){
  const changed=fixture();mutate(changed.source);error(()=>resolveV45Edit(changed),'V45_EDIT_PREPARED_RASTER');
 }
});

test('wire reference identities reject reordering, deletion and changed URLs without changing source or mask',()=>{
 const input=fixture('inpaint-v45');input.references=[source('reference-a'),source('reference-b')];
 const request=resolveV45Edit(input),before=structuredClone(request);
 for(const mutate of [r=>r.references.reverse(),r=>r.body.reference_image_urls.reverse(),r=>r.body.reference_image_urls.pop(),r=>delete r.body.reference_image_urls,r=>r.body.reference_image_urls.push('asset:'+hash('extra')),r=>r.references[0].blob.hash=hash('substituted')]){
  const changed=structuredClone(request);mutate(changed);assert.throws(()=>wireV45Edit(changed));
 }
 assert.deepEqual(request,before);
});

test('repeated reference bytes remain explicitly ordered roles without deduplication',()=>{
 const input=fixture();input.references=[source('same-reference'),source('same-reference')];
 const request=resolveV45Edit(input),wire=JSON.parse(wireV45Edit(request));
 assert.equal(request.references.length,2);assert.deepEqual(wire.reference_image_urls,Array(2).fill('asset:'+input.references[0].blob.hash));
});
