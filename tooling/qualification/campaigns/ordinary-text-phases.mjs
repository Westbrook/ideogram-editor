/** Pure admission of app-owned text diagnostics. The caller must bind these
 * observations to a fresh owned attempt and replay its retained bytes. Plain
 * objects (including a PASS result here) never authorize physical metrics. */
const HASH = /^sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SEQ = /^(0|[1-9][0-9]{0,39})$/;
const id = value => typeof value === 'string' && ID.test(value);
const seq = value => typeof value === 'string' && SEQ.test(value);
const hash = value => typeof value === 'string' && HASH.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const clock = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const check = (condition, code) => { if (!condition) throw Object.assign(Error(code), {code}); };
const unavailable = code => { throw Object.assign(Error(code), {code, unavailable: true}); };
const tokenKeys = ['documentId', 'documentRevision', 'layerId', 'layerVersion', 'sessionId', 'draftId'];
const limits = Object.freeze({mainRows: 2048, workerTraces: 32, workerRows: 128});

function context(value) {
  check(object(value) && Object.keys(value).length <= 48, 'phase-context-bounds');
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    check(descriptor && 'value' in descriptor, 'phase-context-accessor');
    const v = descriptor.value;
    check(typeof v === 'string' && v.length <= 128 || typeof v === 'boolean' || clock(v), 'phase-context-scalar');
    out[key] = v;
  }
  return out;
}

function trace(value, lane, maximum) {
  check(object(value) && value.schemaVersion === 1 && value.lane === lane && clock(value.clockOriginUnixMs) &&
    value.clockUncertaintyMs === null && integer(value.dropped) && integer(value.invalid), 'phase-trace-envelope');
  if (value.dropped || value.invalid) unavailable('phase-trace-overflow-or-invalid');
  check(Array.isArray(value.records) && value.records.length <= maximum, 'phase-record-bounds');
  let sequence = null, ended = 0;
  const records = value.records.map(row => {
    check(object(row) && integer(row.sequence) && row.sequence > 0 && (sequence === null || row.sequence === sequence + 1) &&
      typeof row.phase === 'string' && row.phase.length <= 64 && clock(row.startedMs) && clock(row.endedMs) &&
      row.endedMs >= row.startedMs && row.endedMs >= ended && row.durationMs === row.endedMs - row.startedMs &&
      ['ok','rejected','error','cancelled','incomplete','uncertain'].includes(row.outcome), 'phase-record-shape');
    sequence = row.sequence; ended = row.endedMs;
    return {sequence: row.sequence, phase: row.phase, startedMs: row.startedMs, endedMs: row.endedMs,
      durationMs: row.durationMs, outcome: row.outcome, context: context(row.context)};
  });
  return {clockOriginUnixMs: value.clockOriginUnixMs, records};
}

function snapshot(value) {
  if (!object(value) || !object(value.productPhases)) unavailable('product-phase-snapshot-unavailable');
  check(clock(value.timeOrigin) && clock(value.observedMs), 'phase-observation-clock');
  const product = value.productPhases, workers = product.workerObservations;
  check(product.schemaVersion === 1, 'product-phase-schema');
  if (!object(workers)) unavailable('worker-phase-snapshot-unavailable');
  check(workers.schemaVersion === 1 && workers.clockJoin === 'external-calibration-required' && integer(workers.dropped) &&
    integer(workers.invalid) && Array.isArray(workers.traces) && workers.traces.length <= limits.workerTraces, 'worker-phase-envelope');
  if (workers.dropped || workers.invalid) unavailable('worker-observation-overflow-or-invalid');
  return {main: trace(product.trace, 'browser-main', limits.mainRows), workers: workers.traces.map(value => trace(value, 'text-worker', limits.workerRows))};
}

function bindingShape(binding) {
  check(object(binding) && id(binding.actionId), 'action-binding');
  for (const key of ['documentId','layerId','sessionId','draftId']) check(id(binding[key]), 'binding-' + key);
  for (const key of ['documentRevision','layerVersion']) check(seq(binding[key]), 'binding-' + key);
  check(integer(binding.generation) && binding.generation < Number.MAX_SAFE_INTEGER, 'binding-generation');
  for (const key of ['sourceHash','dependencyHash','rasterHash']) check(hash(binding[key]), 'binding-' + key);
  check(integer(binding.width) && binding.width > 0 && binding.width <= 8192 && integer(binding.height) &&
    binding.height > 0 && binding.height <= 8192 && binding.width * binding.height <= 25_000_000, 'binding-frame');
  check(integer(binding.fontFaces) && binding.fontFaces > 0 && binding.fontFaces <= 16 && integer(binding.fontBytes) &&
    binding.fontBytes > 0 && binding.fontBytes <= 64 * 1024 ** 2, 'binding-font-cohort');
}

function currentState(state, binding) {
  if (!object(state) || state.active !== true) unavailable('active-text-state-unavailable');
  for (const key of tokenKeys) check(state[key] === binding[key], 'text-state-' + key);
  check(state.generation === binding.generation && (state.savedGeneration === null || integer(state.savedGeneration) && state.savedGeneration <= state.generation), 'text-state-generation-mismatch');
  // Preview is a local draft operation. A pending autosave does not invalidate
  // an exact stable source/token/preview join and must not add a benchmark wait.
  check(state.sourceHash === binding.sourceHash, 'text-state-source-hash');
}

function previewState(state, binding) {
  const preview = state?.preview;
  if (!object(preview)) unavailable('owned-text-preview-unavailable');
  check(preview.id === binding.actionId && preview.generation === binding.generation && preview.layerVersion === binding.layerVersion &&
    preview.textHash === binding.sourceHash && preview.dependencyHash === binding.dependencyHash && preview.rasterHash === binding.rasterHash &&
    preview.width === binding.width && preview.height === binding.height, 'preview-identity-mismatch');
  check(state.canvas?.sha256 === binding.rasterHash && state.canvas?.width === binding.width && state.canvas?.height === binding.height,
    'preview-canvas-identity-mismatch');
  return preview;
}

function token(context, binding, generation) {
  return context.documentId === binding.documentId && context.revision === binding.documentRevision &&
    context.layerId === binding.layerId && context.sessionId === binding.sessionId && context.generation === generation;
}

function phase(row, name, lane, origin, scope, actionId) {
  return {name, startMs: row.startedMs, endMs: row.endedMs, durationMs: row.durationMs, outcome: row.outcome,
    boundary: row.context.boundary, clock: lane + '-performance-now', clockOriginUnixMs: origin, clockUncertaintyMs: null,
    scope, actionId, sequence: row.sequence, context: {...row.context}, physicalPresentation: false};
}

/** before/after are sampled through the owned public diagnostic snapshot API;
 * state uses public scalar attributes/native value hash and canvas readback.
 * binding comes from the sealed fixture and public accepted TextSource. */
export function inspectOrdinaryTextObservation({operation, binding, before, after} = {}) {
  const result = {kind: 'ordinary-text-app-observation-1', operation: typeof operation === 'string' && operation.length <= 64 ? operation : null, status: 'INCONCLUSIVE', qualification: false,
    physicalPresentation: false, clockJoin: 'none', phases: [], evidence: null, missing: [], failures: []};
  try {
    check(['text.font-set','text.active-layout','text.apply'].includes(operation), 'ordinary-text-operation');
    bindingShape(binding);
    const old = snapshot(before), next = snapshot(after);
    // Pinned BrowserPhases and the enclosing reader both use this realm's
    // performance.now. Recorder origin is Date.now()-its-first-now, whereas the
    // wrapper retains performance.timeOrigin: quantization/wall-clock movement
    // can make those origins differ. Require each to stay stable, never equate
    // or subtract them and never convert the independent worker clock.
    check(before.timeOrigin === after.timeOrigin && after.observedMs >= before.observedMs &&
      old.main.clockOriginUnixMs === next.main.clockOriginUnixMs, 'text-observation-realm-or-clock-changed');
    check(next.main.records.length >= old.main.records.length &&
      same(old.main.records, next.main.records.slice(0, old.main.records.length)), 'main-phase-prefix-changed');
    check(next.workers.length >= old.workers.length && same(old.workers, next.workers.slice(0, old.workers.length)), 'worker-phase-prefix-changed');
    const freshMain = next.main.records.slice(old.main.records.length), freshWorkers = next.workers.slice(old.workers.length);
    const layouts = freshMain.filter(row => row.phase === 'text.layout');
    if (!layouts.length || !freshWorkers.length) unavailable('fresh-text-layout-and-font-registration-required');
    check(layouts.length === 1 && freshWorkers.length === 1, 'ambiguous-text-preparation');
    const layout = layouts[0], worker = freshWorkers[0], fonts = worker.records.filter(row => row.phase === 'font.ready');
    check(fonts.length === 1 && worker.records.length === 1, 'ambiguous-font-registration');
    const font = fonts[0];
    currentState(before.state, binding);
    let generation = binding.generation, preview;
    if (operation === 'text.apply') {
      preview = previewState(before.state, binding);
      const receipt = after.receipt, accepted = after.accepted;
      if (!object(receipt) || !object(accepted)) unavailable('accepted-text-command-and-source-required');
      for (const key of ['commandId','correlationId','transactionId']) check(id(receipt[key]), 'receipt-' + key);
      check(seq(receipt.resultingRevision) && BigInt(receipt.resultingRevision) > BigInt(binding.documentRevision), 'receipt-resulting-revision');
      // EditorClient.changeDraft preserves identical serialized/composing/
      // revision input. Apply may retain g or save its exact draft once at g+1;
      // the actual accepted command chooses the value, never a guessed delta.
      check(seq(receipt.draft?.generation) && Number.isSafeInteger(Number(receipt.draft.generation)), 'apply-draft-generation');
      generation = Number(receipt.draft.generation);
      check(receipt.draft?.sessionId === binding.sessionId && receipt.draft?.draftId === binding.draftId &&
        (generation === binding.generation || generation === binding.generation + 1), 'apply-draft-generation');
      check(after.state?.active === false, 'apply-text-session-still-active');
      check(accepted.documentId === binding.documentId && accepted.documentRevision === receipt.resultingRevision &&
        accepted.layerId === binding.layerId && seq(accepted.layerVersion) && BigInt(accepted.layerVersion) > BigInt(binding.layerVersion) &&
        accepted.sourceHash === binding.sourceHash && accepted.dependencyHash === binding.dependencyHash && accepted.rasterHash === binding.rasterHash &&
        accepted.width === binding.width && accepted.height === binding.height, 'accepted-text-source-mismatch');
      check(['commandId','correlationId','transactionId','resultingRevision'].every(key => layout.context[key] === receipt[key]), 'layout-receipt-mismatch');
    } else {
      currentState(after.state, binding); preview = previewState(after.state, binding);
      check(before.state.savedGeneration === null || after.state.savedGeneration !== null &&
        after.state.savedGeneration >= before.state.savedGeneration, 'text-saved-generation-regressed');
      check(before.state.preview?.id !== preview.id, 'preview-action-not-fresh');
    }
    check(token(layout.context, binding, generation) && token(font.context, binding, generation), 'text-phase-token-mismatch');
    check(layout.context.snapshotId === binding.draftId && layout.context.previewId === preview.id &&
      layout.context.assetHash === binding.rasterHash && layout.context.evidenceHash === binding.dependencyHash &&
      layout.context.width === binding.width && layout.context.height === binding.height, 'layout-source-identity-mismatch');
    check(layout.startedMs >= before.observedMs && layout.endedMs <= after.observedMs, 'layout-outside-action-window');
    check(layout.outcome === 'incomplete' && layout.context.boundary === (operation === 'text.apply' ? 'authority-durable' : 'render-submitted'), 'layout-boundary-mismatch');
    check(font.outcome === 'ok' && font.context.boundary === 'observed' && font.context.count === binding.fontFaces &&
      font.context.bytes === binding.fontBytes, 'font-registration-cohort-or-outcome');
    // There is no worker/main calibration. Only each row's own duration is used;
    // append-only capture and exact tokens establish association, not clock math.
    result.phases.push(phase(font, 'text.font-ready.worker', 'text-worker', worker.clockOriginUnixMs,
      'Exact font bytes verification, parser, dependency hashing and usable face registration; starts after admission/plan, excludes worker/engine startup.', binding.actionId));
    result.phases.push(phase(layout, operation === 'text.apply' ? 'text.apply.authority-durable' : 'text.preview.render-submitted',
      'browser-main', next.main.clockOriginUnixMs, operation === 'text.apply' ?
      'Apply intent through actual versioned durable acknowledgement; correct presented canonical pixels remain unobserved.' :
      'Preview handler through exact pixel submission, including cleanup/font load/engine/layout/raster work; no first-paint or edit-intent claim.', binding.actionId));
    result.evidence = {actionId: binding.actionId, token: Object.fromEntries(tokenKeys.map(key => [key,binding[key]])), generation,
      sourceHash: binding.sourceHash, dependencyHash: binding.dependencyHash, rasterHash: binding.rasterHash,
      fontFaces: binding.fontFaces, fontBytes: binding.fontBytes, previewId: preview.id,
      fontRegistration: {durationMs: font.durationMs, scope: 'worker-child-only', fullFontSetDurationMs: null},
      registrationUpperBound: operation === 'text.apply' ? null : {upperBoundMs: layout.durationMs, exactMs: null,
        endpoint: 'app-preview-render-submitted', ceilingBreachProvesFailure: false},
      fullR34DurationMs: null, physicalInput: false, firstPaint: false, physicalScanout: false, completeDisplaySlots: false};
    result.status = 'PASS';
  } catch (error) {
    result.phases = []; result.evidence = null;
    if (error?.unavailable) result.missing.push(error.code); else {result.status = 'FAIL'; result.failures.push(error?.code ?? 'ordinary-text-observation-invalid');}
  }
  return result;
}
