import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { intervalWait, monotonic, PrerequisiteError, fileIdentity } from './common.mjs';
import { readGestureState, eligibleGestureLayers, chooseInteractionZoomPercentages, planStrokeCoordinates, installGestureObserver, validateNativeDiscrete, validateRecordedStroke } from './browser-gesture-state.mjs';

export const browserOperationCoverage = Object.freeze([
  'navigation.ready', 'interaction.brush', 'interaction.first-use', 'raster.stroke-finalize',
  'raster.resize-preview', 'raster.resample', 'raster.import', 'raster.export', 'raster.masked-prepare', 'raster.adopt',
  'state.snapshot-create', 'capture.source', 'mask.feather-preview', 'portable.reopen',
  'fast.workflow', 'startup.failure', 'layers.large-list', 'lifecycle.editor',
]);

const button = (page, name) => page.getByRole('button', { name, exact: true });
const click = (page, name) => button(page, name).click();
const idButton = (page, id) => page.locator('#' + id).getByRole('button');
const visible = locator => locator.waitFor({ state: 'visible' });
export const ready = page => visible(page.getByText('Local recovery complete. Accepted edits are saved locally.', { exact: true }));
export async function numeric(page, name, value) {
  const field = page.getByRole('spinbutton', { name, exact: true });
  await field.fill(String(value)); await field.press('Tab');
}
async function accepted(page, type) { await visible(page.getByText(type + ' accepted and saved locally.', { exact: true })); }

// Only metadata reads use fetch. Every action below goes through the product's
// public controls; no editor objects, private shadow state or fake clocks.
export async function publicRead(page, path) {
  if (!/^\/api\/v1\/(?:documents|jobs|queue|adapters|assets|commands)(?:\/|\?|$)/.test(path) && !/^\/api\/v1\/ui\/[A-Za-z0-9_-]{1,128}$/.test(path) && !/^\/api\/v1\/image-edit-reviews\/[A-Za-z0-9_-]{1,128}$/.test(path)) throw Error('Unapproved public witness route');
  return page.evaluate(async path => {
    const response = await fetch(path, { headers: { 'X-App-Client': 'LP-1' }, credentials: 'same-origin' });
    if (!response.ok) throw Error('Public performance witness unavailable: ' + response.status);
    return response.json();
  }, path);
}

export async function acceptedCommand(page, type, action, signal) {
  const reply = page.waitForResponse(response => {
    if (response.request().method() !== 'POST' || new URL(response.url()).pathname !== '/api/v1/commands') return false;
    try { return response.request().postDataJSON()?.command?.body?.type === type; } catch { return false; }
  });
  // Avoid an unhandled rejection if an earlier action failure wins the race.
  reply.catch(() => {}); await action();
  const response = await reply, value = await response.json();
  const documentId = response.request?.().postDataJSON?.()?.command?.documentId ?? null;
  const commandId = value.commandId ?? value.receipt?.commandId;
  if (!commandId) throw Error('Command response lacks immutable identity');
  const started = monotonic(); let state = value;
  while (!state.receipt) {
    signal?.throwIfAborted();
    if (monotonic() - started > 120000) throw Error('Durable command deadline exceeded');
    await intervalWait(10, signal); state = await publicRead(page, '/api/v1/commands/' + commandId);
  }
  assert.equal(state.receipt.status, 'accepted', 'Product command was not accepted');
  return { commandId, documentId, status: state.receipt.status, observedDurableReceiptMs: monotonic() };
}

export async function openDocument(page, fixture) {
  if (!fixture?.documentId) throw new PrerequisiteError('A sealed document identity is required');
  await click(page, 'Open');
  const dialog = page.getByRole('dialog', { name: 'Open document', exact: true });
  await dialog.getByRole('button', { name: new RegExp('^' + fixture.documentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' · ') }).click();
  await dialog.waitFor({ state: 'hidden' });
  const document = (await publicRead(page, '/api/v1/documents/' + fixture.documentId)).projection.value;
  await page.locator('.document-name').filter({ hasText: `${document.width} × ${document.height} · revision ${document.revision}` }).waitFor({ state: 'visible' });
}

export function validateBrowserGestures(value) {
  if (!Array.isArray(value) || value.length !== 100) throw new PrerequisiteError('The sealed brush corpus must contain exactly 100 strokes');
  const ids = new Set();
  for (const stroke of value) {
    if (typeof stroke.id !== 'string' || !/^stroke-\d{3}$/.test(stroke.id) || ids.has(stroke.id) || stroke.brushDiameter !== 64 || stroke.sampleHz !== 60 || stroke.samples?.length !== 120) throw new PrerequisiteError('Invalid sealed brush specimen identity or sample envelope');
    ids.add(stroke.id);
    for (let index = 0; index < 120; index++) {
      const sample = stroke.samples[index];
      if (![sample.x, sample.y, sample.timeMs].every(number => typeof number === 'number' && Number.isFinite(number) && number >= 0) || Math.abs(sample.timeMs - index * 1000 / 60) > 1e-9) throw new PrerequisiteError('Brush specimen geometry or real event schedule differs from the sealed protocol');
    }
    if (stroke.samples[119].x !== stroke.samples[118].x || stroke.samples[119].y !== stroke.samples[118].y) throw new PrerequisiteError('Portable mouse release must retain the final move coordinates to produce exactly 120 product samples');
  }
  return value;
}

export async function prepareBrowserGestures(fixture) {
  const path = await verifiedCorpusFile(fixture, 'gestures');
  return validateBrowserGestures(JSON.parse(await readFile(path, 'utf8')));
}

export async function selectVisibleImageLayer(page, fixture, layerId) {
  const image = await publicRead(page, '/api/v1/documents/' + fixture.documentId + '/image');
  const ordered = [...image.layers].reverse();
  const target = ordered.find(layer => layer.kind === 'image' && layer.visible && !layer.locked && (!layerId || layer.id === layerId));
  if (!target) throw new PrerequisiteError('The fixed document has no requested visible unlocked image layer');
  await page.locator('#layer-tree').getByRole('treeitem').nth(ordered.indexOf(target)).click();
  return { id: target.id, version: target.version };
}

async function dispatchStrokePointers(page, points, signal, beforeDown) {
  const observations = [], scheduled = [];
  await page.mouse.move(points[0].x, points[0].y);
  // Hover is preparation, not one of the 120 consumed stroke samples. The
  // optional observer is armed only after it has settled.
  await beforeDown?.();
  const startMs = monotonic();
  const dispatch = async (index, action) => {
    const scheduledMs = startMs + index * 1000 / 60;
    for (let now = monotonic(); now < scheduledMs; now = monotonic()) await intervalWait(scheduledMs - now, signal);
    signal?.throwIfAborted();
    const dispatchStartedMs = monotonic(); await action(); const dispatchCompletedMs = monotonic();
    scheduled.push({ index, scheduledMs, dispatchStartedMs, dispatchCompletedMs });
    observations.push({ index, inputMs: dispatchCompletedMs, presentedMs: null });
  };
  try {
    await dispatch(0, () => page.mouse.down());
    for (let index = 1; index < 119; index++) {
      await dispatch(index, () => page.mouse.move(points[index].x, points[index].y));
    }
    await dispatch(119, () => page.mouse.up());
  } catch (error) {
    error.pointerDispatch = { startMs, observations, pointerSchedule: { clock: 'runner-monotonic', frequencyHz: 60, samples: scheduled } };
    await page.mouse.up().catch(() => {}); throw error;
  }
  return { startMs, observations, pointerSchedule: { clock: 'runner-monotonic', frequencyHz: 60, samples: scheduled } };
}

export async function stroke(page, { signal, commit = false, fixture, gestures, strokeIndex = 0 } = {}) {
  if (!gestures || !Number.isSafeInteger(strokeIndex) || strokeIndex < 0 || strokeIndex >= gestures.length) throw new PrerequisiteError('A verified sealed stroke specimen is required');
  const target = await selectVisibleImageLayer(page, fixture); await click(page, 'Mask');
  await numeric(page, 'Brush diameter (document px)', 64);
  await click(page, 'Fit');
  const document = (await publicRead(page, '/api/v1/documents/' + fixture.documentId)).projection.value;
  const startMs = monotonic(), observer = await installGestureObserver(page);
  let observed;
  try { observed = await scoredStroke(page, { observer, protocol: { document, eligibleLayerIds: [target.id], priorCompletion: null }, specimen: gestures[strokeIndex], signal }); }
  finally { await observer.close(); }
  if (observed.validation.status === 'FAIL') throw Object.assign(Error('Actual native stroke differs from its fixed product specimen'), { observations: observed });
  await visible(page.getByText('Unapplied mask draft', { exact: true }));
  const draftDOMObservedMs = await page.evaluate(() => performance.now());
  let receipt;
  if (commit) { await click(page, 'Preview mask'); receipt = await acceptedCommand(page, 'SetLayerProperties', () => click(page, 'Apply layer mask'), signal); }
  return { ...observed, target, status: observed.validation.status, missing: observed.validation.missing, draftDOMObservedMs,
    accepted: commit, ...(receipt ? { receipt } : {}), elapsedMs: monotonic() - startMs,
    sampleTiming: 'Actual native input event timestamps and consumed geometry; 60 Hz is the scheduled target, with delivered cadence retained separately',
    pressurePolicy: 'Current product consumes geometric points without pressure; no pressure-dependent output claimed' };
}

export function interactionPlan() {
  // Each authored stroke has one explicitly counted public Undo. This retains
  // the corpus's Undo coverage and bounds the unapplied draft without hidden
  // resets. The other six prescribed gesture families each occur ten times.
  const seen = new Map();
  return Array.from({ length: 20 }, (_, index) => [{ kind: 'stroke', index }, ...['undo', ...(index % 2 ? ['zoom', 'theme', 'split'] : ['pan', 'layer', 'density'])].map((kind, offset) => {
    const ordinal = (seen.get(kind) ?? 0) + 1; seen.set(kind, ordinal);
    return { kind, index: index * 4 + offset, ordinal, variant: (ordinal - 1) % 2 };
  })]).flat();
}

async function maskDraftOperationCount(page) {
  return page.evaluate(() => {
    const counts = [...document.querySelectorAll('p')].map(node => node.textContent?.match(/^Bound to .+, revision [0-9]+\. ([0-9]+) draft operations\./)?.[1]).filter(value => value !== undefined);
    if (counts.length !== 1) throw Error('The public mask draft count is unavailable or ambiguous');
    return Number(counts[0]);
  });
}

export async function runDiscreteInteraction(page, action, protocol) {
  const variant = action.variant;
  if (action.kind === 'undo') {
    const completion = protocol.priorCompletion?.detail, undo = button(page, 'Undo mask stroke');
    assert(completion?.operationCount === 1, 'The counted Undo must own the immediately preceding one-stroke draft');
    await page.getByText(/, revision [0-9]+\. 1 draft operations\./).waitFor({ state: 'visible' });
    const beforeOperationCount = await maskDraftOperationCount(page);
    assert.equal(beforeOperationCount, 1); assert(await undo.isEnabled()); await undo.click();
    const started = monotonic(); let afterOperationCount, buttonDisabled;
    do {
      afterOperationCount = await maskDraftOperationCount(page); buttonDisabled = !await undo.isEnabled();
      if (afterOperationCount === 0 && buttonDisabled) break;
      if (monotonic() - started > 5000) throw Error('The counted Undo did not restore the empty mask draft');
      await intervalWait(10);
    } while (true);
    return { kind: 'public-undo-mask-stroke', draftId: completion.draftId, gestureOrdinal: completion.gestureOrdinal,
      beforeOperationCount, afterOperationCount, buttonDisabled, observedMs: await page.evaluate(() => performance.now()),
      clock: 'browser-performance', source: 'public-draft-count-and-disabled-undo' };
  }
  else if (action.kind === 'layer') {
    const state = await readGestureState(page), layers = protocol.eligibleLayers;
    if (layers.length < 2) throw new PrerequisiteError('Layer gestures require multiple visible unlocked image rows');
    const selected = layers.findIndex(layer => layer.id === state.editor?.selected?.[0]);
    if (selected < 0) throw new PrerequisiteError('Layer gesture lost its eligible selected image');
    const target = layers[(selected + 1) % layers.length];
    await page.locator('#layer-tree').getByRole('treeitem').nth(target.rowIndex).click();
    await page.waitForFunction(id => performance.getEntriesByName('ie.editor.updated').at(-1)?.detail?.selected?.[0] === id, target.id);
    return { before: layers[selected].id, after: target.id, source: 'public-layer-selection' };
  }
  else if (action.kind === 'zoom') {
    const value = protocol.zoomPercentages[variant], field = page.getByRole('spinbutton', { name: 'Zoom percentage', exact: true });
    await field.focus(); await field.press('ControlOrMeta+A'); await field.pressSequentially(String(value)); await field.press('Tab');
    await page.waitForFunction(zoom => performance.getEntriesByName('ie.viewport.drawn').at(-1)?.detail?.zoom === zoom, value / 100);
    return { zoom: value / 100, source: 'public-exact-viewport-mark' };
  }
  else if (action.kind === 'split') {
    const handle = page.getByRole('separator', { name: 'Request panel width', exact: true });
    const initial = await handle.getAttribute('aria-valuenow'), before = initial === null ? NaN : Number(initial), direction = variant ? -1 : 1;
    if (!Number.isFinite(before)) throw new PrerequisiteError('The splitter has no public numeric position');
    await handle.focus(); await handle.press(variant ? 'ArrowLeft' : 'ArrowRight');
    const started = monotonic(); let after;
    do {
      const value = await handle.getAttribute('aria-valuenow'); after = value === null ? NaN : Number(value);
      if (Number.isFinite(after) && direction * (after - before) > 0) break;
      if (monotonic() - started > 2000) throw Error('Split gesture did not move the public splitter in the intended direction');
      await intervalWait(10);
    } while (true);
    return { before, after, direction, source: 'public-splitter-value' };
  }
  else if (action.kind === 'pan') {
    const before = await readGestureState(page), targetX = before.viewport.x + (variant ? -10 : 10);
    const canvas = page.locator('#canvas'); await canvas.focus(); await canvas.press(variant ? 'ArrowLeft' : 'ArrowRight');
    await page.waitForFunction(x => performance.getEntriesByName('ie.viewport.drawn').at(-1)?.detail?.x === x, targetX);
    return { before: before.viewport.x, after: targetX, source: 'public-exact-viewport-mark' };
  } else {
    const name = action.kind === 'theme' ? 'Appearance' : 'Density';
    const field = page.getByRole('combobox', { name, exact: true });
    if (await field.count() !== 1) throw new PrerequisiteError('The prescribed ' + action.kind + ' gesture has no product control');
    const before = await field.inputValue();
    // Keyboard events provide the actual native intent timestamp. selectOption
    // would directly dispatch synthetic change events instead.
    const target = action.kind === 'theme' ? (before === 'dark' ? 'light' : 'dark') : (before === 'spacious' ? 'comfortable' : 'spacious');
    await field.focus(); await field.press(target === 'dark' || target === 'spacious' ? 'End' : 'Home');
    if (target === 'light') await field.press('ArrowDown');
    await field.press('Tab');
    assert.equal(await field.inputValue(), target, 'Native keyboard gesture must select the intended appearance/density value');
    assert.notEqual(await field.inputValue(), before, 'Discrete appearance/density gesture must change state');
    return { before, after: target, source: 'public-' + name.toLowerCase() + '-control' };
  }
}

export async function prepareInteraction(page, fixture, signal) {
  signal?.throwIfAborted();
  const started = await page.evaluate(() => ({ nowMs: performance.now(), timeOrigin: performance.timeOrigin }));
  const document = (await publicRead(page, '/api/v1/documents/' + fixture.documentId)).projection.value;
  const image = await publicRead(page, '/api/v1/documents/' + fixture.documentId + '/image');
  const eligibleLayers = eligibleGestureLayers(image);
  if (eligibleLayers.length < 2) throw new PrerequisiteError('The fixed interaction requires multiple visible unlocked image layers');
  await page.locator('#layer-tree').getByRole('treeitem').nth(eligibleLayers[0].rowIndex).click();
  await click(page, 'Mask'); await numeric(page, 'Brush diameter (document px)', 64); await click(page, 'Fit');
  await page.waitForFunction(id => {
    const editor = performance.getEntriesByName('ie.editor.updated').at(-1)?.detail;
    return editor?.selected?.[0] === id && editor?.ready === true && editor?.busy === false &&
      Number(document.querySelector('en-number-field[label="Brush diameter (document px)"]')?.value) === 64;
  }, eligibleLayers[0].id);
  let state = await readGestureState(page);
  const zoomPercentages = chooseInteractionZoomPercentages(state, document);
  await numeric(page, 'Zoom percentage', zoomPercentages[1]);
  await page.waitForFunction(zoom => performance.getEntriesByName('ie.viewport.drawn').at(-1)?.detail?.zoom === zoom, zoomPercentages[1] / 100);
  await click(page, 'Start fresh mask');
  await page.getByText(/, revision [0-9]+\. 0 draft operations\./).waitFor({ state: 'visible' });
  assert.equal(await maskDraftOperationCount(page), 0); assert(!await button(page, 'Undo mask stroke').isEnabled());
  state = await readGestureState(page);
  return { document, eligibleLayers, eligibleLayerIds: eligibleLayers.map(layer => layer.id), zoomPercentages, requireEmptyDraft: true,
    initialState: state, unscoredPreparation: { startMs: started.nowMs, endMs: state.observedMs, timeOrigin: started.timeOrigin,
      clock: 'browser-performance', actions: ['select eligible image', 'Mask', '64px brush', 'Fit', 'upper fitted dyadic zoom', 'Start fresh mask'],
      initialMaskDraftOperationCount: 0,
      initialZoom: state.viewport.zoom, scoredZoomPercentages: zoomPercentages,
      includedInCanonicalVisit: true, excludedFromScoredGestureCount: true } };
}

async function recordedStroke(page) {
  return page.evaluate(() => {
    const entry = performance.getEntriesByName('ie.mask.stroke.recorded').at(-1);
    return entry ? { startMs: entry.startTime, detail: entry.detail } : null;
  });
}

async function scoredStroke(page, { observer, protocol, specimen, signal }) {
  const state = await readGestureState(page), plan = planStrokeCoordinates(specimen, state, protocol);
  const beforeMark = await recordedStroke(page), priorCompletion = protocol.priorCompletion ?? null;
  let native, dispatch, completion, armed = false;
  try {
    try {
      dispatch = await dispatchStrokePointers(page, plan.points, signal, async () => { await observer.begin(specimen.id); armed = true; });
    } finally { if (armed) native = await observer.end(); }
    const up = native.events.findLast(event => event.type === 'pointerup');
    if (up) await page.waitForFunction(({ after, inputUpMs }) => {
      const entry = performance.getEntriesByName('ie.mask.stroke.recorded').at(-1);
      return entry?.detail?.gestureOrdinal > after && entry?.detail?.inputUpMs === inputUpMs;
    }, { after: beforeMark?.detail?.gestureOrdinal ?? 0, inputUpMs: up.inputMs }, { timeout: 5000 });
    completion = await recordedStroke(page);
    const validation = validateRecordedStroke({ observation: native, plan, completion, priorCompletion, priorUndo: protocol.priorUndo, requireEmptyDraft: protocol.requireEmptyDraft === true });
    protocol.priorCompletion = completion; protocol.priorUndo = null;
    return { specimenId: specimen.id, selectedLayerId: plan.selectedLayerId,
      inputMs: native.firstInputMs, pointerUpMs: up?.inputMs ?? null, samples: validation.samples,
      plan, native, validation, completion, productCompletion: completion?.detail ?? null,
      observedMs: completion?.startMs ?? native.stoppedMs, dispatchObservations: dispatch?.observations ?? [], pointerSchedule: dispatch?.pointerSchedule ?? null,
      dispatchClock: 'runner-monotonic', inputClock: 'browser-performance', meaningful: true,
      outcome: validation.status === 'FAIL' ? 'failed' : 'completed',
      setupActions: 0, retainedViewState: state, actualPresentation: 'unavailable' };
  } catch (error) {
    dispatch ??= error.pointerDispatch;
    completion ??= await recordedStroke(page);
    error.actionObservation = { kind: 'stroke', specimenId: specimen.id, selectedLayerId: plan.selectedLayerId,
      inputMs: native?.firstInputMs ?? null, native: native ?? null, completion, productCompletion: completion?.detail ?? null,
      samples: native?.events?.map((event, index) => ({ index, ...event, presentedMs: null })) ?? [],
      dispatchObservations: dispatch?.observations ?? [], pointerSchedule: dispatch?.pointerSchedule ?? null,
      inputClock: 'browser-performance', outcome: 'failed', presentedMs: null };
    throw error;
  }
}

async function interaction(page, cell, fixture, gestures, signal) {
  const parameters = cell.parameters ?? cell.options ?? cell;
  if (parameters.mode && parameters.mode !== 'native') throw new PrerequisiteError('Fallback needs a verified product worker/context-loss recovery controller');
  const protocol = await prepareInteraction(page, fixture, signal), observer = await installGestureObserver(page);
  const boundary = await observer.now(), startMs = boundary.nowMs, actions = [];
  const observations = captureStoppedMs => ({ startMs, endMs: startMs + 60000, captureStoppedMs,
    timeOrigin: boundary.timeOrigin, clock: 'browser-performance', gestures: actions.length,
    strokes: actions.filter(x => x.kind === 'stroke').length, actions,
    unscoredPreparation: protocol.unscoredPreparation, actualPresentation: 'unavailable' });
  try {
    for (const action of interactionPlan()) {
      signal?.throwIfAborted();
      if (action.kind === 'stroke') actions.push({ ...action, ...await scoredStroke(page, { observer, protocol, specimen: gestures[action.index], signal }), presentedMs: null });
      else {
        await observer.begin('discrete-' + action.index, { kind: 'discrete' });
        let native, failure, semantic;
        try { semantic = await runDiscreteInteraction(page, action, protocol); } catch (error) { failure = error; }
        finally { native = await observer.end(); }
        const valid = validateNativeDiscrete(native, { timeOrigin: boundary.timeOrigin });
        if (action.kind === 'undo' && semantic) protocol.priorUndo = { ...semantic, native, inputMs: valid.inputMs, nativeTrusted: valid.status === 'PASS' };
        actions.push({ ...action, inputMs: valid.inputMs, observedMs: native.stoppedMs, native, semantic, validation: valid,
          meaningful: true, outcome: failure || valid.status === 'FAIL' ? 'failed' : 'completed', presentedMs: null });
        if (failure) throw failure;
      }
      const now = await observer.now();
      if (now.nowMs > startMs + 60000) throw Object.assign(Error('The fixed 100-gesture interaction could not finish in 60 seconds'), { code: 'INTERACTION_DEADLINE' });
    }
    let captured = await observer.now();
    while (captured.nowMs < startMs + 60000) { await intervalWait(startMs + 60000 - captured.nowMs, signal); captured = await observer.now(); }
    const failed = actions.some(action => action.validation?.status === 'FAIL');
    const missing = actions.flatMap(action => action.validation?.missing ?? []);
    return { ...observations(captured.nowMs), status: failed ? 'FAIL' : missing.length ? 'INCONCLUSIVE' : 'PASS', missing: [...new Set(missing)] };
  } catch (error) {
    const captured = await observer.now();
    if (error.actionObservation) actions.push(error.actionObservation);
    error.observations = observations(captured.nowMs); throw error;
  } finally { await observer.close(); }
}

function candidate(fixture, parameters) {
  const item = parameters.candidate ?? fixture?.candidate;
  if (!item?.id || !item.jobId || !item.attemptId) throw new PrerequisiteError('A sealed retained candidate with job and attempt identities is required');
  return item;
}
export async function resolveBrowserCandidate(page, fixture) {
  if (fixture?.candidate) return candidate(fixture, {});
  const sealed = fixture?.extensions?.candidates;
  if (!sealed?.completedJobId || !sealed.candidateIds?.length) throw new PrerequisiteError('The sealed product fixture does not identify its retained candidate');
  let after = ''; const seen = new Set();
  do {
    const value = await publicRead(page, '/api/v1/queue' + (after ? '?after=' + encodeURIComponent(after) : ''));
    const job = value.jobs.find(job => job.id === sealed.completedJobId);
    if (job) {
      for (const attempt of job.attempts) {
        if (!attempt.requestId) continue;
        const results = await publicRead(page, '/api/v1/jobs/' + job.id + '/candidates?attempt=' + attempt.id);
        const result = results.items.find(item => item.id === sealed.candidateIds[0]);
        if (result) {
          assert.equal(result.state, 'prepared'); assert(result.preparedAssetId, 'A retained prepared candidate identity is required');
          return { id: result.id, jobId: job.id, attemptId: attempt.id, preparedAssetId: result.preparedAssetId, encodedAssetId: result.encodedAssetId, recommendedPlacement: sealed.recommendedPlacement };
        }
      }
      throw new PrerequisiteError('The sealed retained candidate is absent from its public owning job');
    }
    after = value.nextCursor ?? '';
    if (seen.has(after) || seen.size >= 501) throw new PrerequisiteError('Candidate lookup exceeded bounded public queue pagination');
    seen.add(after);
  } while (after);
  throw new PrerequisiteError('The sealed retained candidate job is absent from public queue metadata');
}
async function inspectCandidate(page, item) {
  const { showQueueJob } = await import('./browser-queue.mjs');
  const card = await showQueueJob(page, item.jobId);
  await card.getByRole('button', { name: 'Inspect retained results', exact: true }).click();
}

export async function runBrowserAction({ page, cell, fixture, signal, pair, services = {} }) {
  const operation = cell.operation, p = cell.parameters ?? cell.options ?? cell;
  signal?.throwIfAborted();
  if (operation === 'navigation.ready' || operation === 'portable.reopen') {
    await page.goto(await pair()); await ready(page);
    if (fixture.documentId) await openDocument(page, fixture);
    await button(page, 'New').waitFor({ state: 'visible' });
    const canvas = page.locator('canvas[aria-label="Document raster preview"]');
    await visible(canvas);
    const document = fixture.documentId ? await publicRead(page, '/api/v1/documents/' + fixture.documentId) : null;
    if (document?.projection?.value?.image?.compositeAssetId) assert.equal(await canvas.getAttribute('data-asset'), document.projection.value.image.compositeAssetId);
    // A toolbar enabled check is not the required accepted test edit. The
    // harness uses an actual durable checkpoint to prove command admission.
    if (fixture.documentId) { await click(page, 'Save checkpoint'); await accepted(page, 'SaveCheckpoint'); }
    return { documentId: fixture.documentId ?? null, acceptedTestEdit: !!fixture.documentId,
      startupBoundary: fixture.documentId ? 'document-ready-via-Open' : 'shell-ready-no-document', publicOpenCompleted: !!fixture.documentId,
      viewportAsset: await canvas.getAttribute('data-asset'), authoritativeDOMReadyMs: monotonic(), presentation: 'awaiting independent trace correlation' };
  }
  if (operation === 'raster.stroke-finalize') return stroke(page, { signal, commit: false, fixture, gestures: services.gestures });
  if (operation === 'interaction.brush') return interaction(page, cell, fixture, services.gestures, signal);
  if (operation === 'interaction.first-use') {
    const name = p.feature === 'adapter' ? 'Adapter library' : 'Mask';
    const startMs = monotonic(), inputMs = monotonic();
    await click(page, name);
    if (name === 'Mask') {
      const control = page.getByRole('spinbutton', { name: 'Brush diameter (document px)', exact: true });
      await control.waitFor({ state: 'visible', timeout: 1000 }); assert(await control.isEnabled(), 'First-use mask controls must be operable');
    } else await page.getByRole('region', { name: 'Local adapter library', exact: true }).waitFor({ state: 'visible', timeout: 1000 });
    const readyMs = monotonic();
    for (let now = monotonic(); now < startMs + 1000; now = monotonic()) await intervalWait(startMs + 1000 - now, signal);
    return { feature: name, startMs, inputMs, readyMs, endMs: startMs + 1000, captureStoppedMs: monotonic(), observationWindowMs: 1000, meaningful: true, presentedMs: null };
  }
  if (operation === 'state.snapshot-create') { await click(page, 'Save checkpoint'); await accepted(page, 'SaveCheckpoint'); return { command: 'SaveCheckpoint', snapshotBytes: 'requires backend snapshot phase evidence' }; }
  if (operation === 'raster.resize-preview' || operation === 'raster.resample') {
    await page.getByRole('treeitem').first().click(); await click(page, 'Resample image…');
    await numeric(page, 'Intrinsic width (px)', p.width ?? 2048); await numeric(page, 'Intrinsic height (px)', p.height ?? 2048);
    await click(page, 'Prepare preview'); await visible(page.getByRole('dialog', { name: 'Review prepared image edit', exact: true }));
    const receipt = operation === 'raster.resample' ? await acceptedCommand(page, 'ResampleImage', () => click(page, 'Apply reviewed result'), signal) : null;
    return { width: p.width ?? 2048, height: p.height ?? 2048, explicitApproval: operation === 'raster.resample', receipt };
  }
  if (operation === 'raster.import') {
    const path = await verifiedCorpusFile(fixture, p.format === 'webp' ? 'raster-codec' : 'raster-original', file => file.format === p.format && (!p.codec || file.codec === p.codec));
    await click(page, 'Import image'); await page.getByLabel('Image file', { exact: true }).setInputFiles(path);
    await visible(page.getByRole('dialog', { name: 'Review image conversion', exact: true }));
    const receipt = await acceptedCommand(page, 'ImportAsset', () => click(page, 'Apply reviewed result'), signal);
    return { format: p.format, codec: p.codec ?? null, receipt, originalRetained: true };
  }
  if (operation === 'raster.export') {
    const format = p.format ?? 'png'; assert(['png', 'jpeg'].includes(format));
    await click(page, 'Export image');
    await page.getByRole('combobox', { name: 'Export scope', exact: true }).selectOption('visible-document');
    await page.getByRole('combobox', { name: 'Export format', exact: true }).selectOption(format);
    await page.getByRole('combobox', { name: 'Export dimensions', exact: true }).selectOption('native');
    if (format === 'jpeg') {
      const matte = page.getByRole('textbox', { name: 'Opaque sRGB matte (#RRGGBB)', exact: true }); await matte.fill('#ffffff'); await matte.press('Tab');
      await numeric(page, 'JPEG quality (0.01–1)', p.quality ?? .9);
    }
    const receipt = await acceptedCommand(page, 'ExportDocument', () => click(page, 'Prepare export preview'), signal);
    await click(page, 'Confirm reviewed export');
    await visible(page.getByRole('region', { name: 'Prepared file' }).getByText(format === 'jpeg' ? /Reviewed JPEG/ : /PNG export/));
    return { format, quality: format === 'jpeg' ? p.quality ?? .9 : null, matte: format === 'jpeg' ? '#ffffff' : null, receipt, durableLocalExport: true, reviewedExactEncodedBytes: true, externalDestination: 'not requested' };
  }
  if (operation === 'capture.source') {
    await page.getByRole('treeitem').first().click();
    const scope = p.scope ?? (p.nativeText ? 'merged-visible' : 'single-layer');
    const id = scope === 'merged-visible' ? 'request-capture-visible' : scope === 'selected-layers' ? 'request-capture-selected' : 'request-capture-single';
    const receipt = await acceptedCommand(page, 'PrepareRequestSource', () => idButton(page, id).click(), signal);
    await visible(page.getByText(/Rendered source captured at revision/)); return { scope, receipt };
  }
  if (operation === 'mask.feather-preview') {
    await page.locator('#request-mask-feather').getByRole('spinbutton').fill(String(p.radius ?? 2));
    await page.locator('#request-mask-feather').getByRole('spinbutton').press('Tab');
    await idButton(page, 'request-mask-refeather').click(); await idButton(page, 'request-mapping-preview').click();
    const resolution = p.disposition ?? p.resolution;
    if (resolution === 'expand') await idButton(page, 'request-mapping-expand').click();
    if (resolution === 'clip') await idButton(page, 'request-mapping-clip').click();
    await visible(page.locator('#request-mapping-review'));
    if (p.includesContainmentApproval) await idButton(page, 'request-mask-confirm').click();
    return { radius: p.radius ?? 2, resolution: resolution ?? 'preview', confirmed: !!p.includesContainmentApproval };
  }
  if (operation === 'raster.masked-prepare' || operation === 'raster.adopt') {
    const item = candidate(fixture, p);
    const placement = p.placement ?? item.recommendedPlacement ?? fixture.extensions?.candidates?.recommendedPlacement ?? 'current-document';
    if (!['current-document', 'new-document'].includes(placement)) throw new PrerequisiteError('Exact reviewed candidate placement is required');
    if (p.replaceSelectedImage && (placement !== 'current-document' || p.treatment !== 'full-candidate')) throw new PrerequisiteError('Image-version replacement requires explicit current-document full-candidate treatment');
    if (operation === 'raster.adopt' && ['A', 'B'].includes(p.readiness) && services.verifyDecodedReadiness) {
      const preClick = await services.verifyDecodedReadiness(item, p.readiness);
      const receipt = await acceptedCommand(page, 'AdoptCandidate', () => idButton(page, 'request-candidate-adopt-' + item.id).click(), signal);
      const adopted = services.observeAdoption ? await services.observeAdoption(item, receipt, preClick) : null;
      if (!adopted) await visible(page.getByText(/candidate adopted (?:in one saved history edit|into a new document)/i));
      return { candidateId: item.id, placement, readiness: p.readiness, receipt, preClick, adopted, missing: adopted?.missing ?? [], preparationOutsideAcceptance: true, durableAndVisibleCompletion: 'requires exact phase and presentation join' };
    }
    await inspectCandidate(page, item);
    const placeId = (p.replaceSelectedImage ? 'request-candidate-replace-' : placement === 'new-document' ? 'request-candidate-new-document-' : 'request-candidate-place-') + item.id;
    if (p.treatment && !['safe-region', 'full-candidate'].includes(p.treatment)) throw new PrerequisiteError('Exact public candidate treatment is required');
    if (operation === 'raster.masked-prepare') {
      await idButton(page, 'request-candidate-prepare-' + item.id).click();
      if (p.treatment) await page.getByRole('combobox', { name: 'Candidate treatment', exact: true }).selectOption(p.treatment);
      const receipt = await acceptedCommand(page, 'PrepareCandidateAdoption', () => idButton(page, placeId).click(), signal);
      await visible(idButton(page, 'request-candidate-adopt-' + item.id)); return { candidateId: item.id, receipt };
    }
    if (p.readiness === 'A' && !services.verifyDecodedReadiness) throw new PrerequisiteError('A adoption needs verified prepared composite and resident decoded viewport');
    if (p.readiness === 'C') {
      await idButton(page, 'request-candidate-prepare-' + item.id).click();
      if (p.treatment) await page.getByRole('combobox', { name: 'Candidate treatment', exact: true }).selectOption(p.treatment);
      const review = await acceptedCommand(page, 'ReviewCandidatePlacement', () => idButton(page, (p.replaceSelectedImage ? 'request-candidate-review-replace-' : placement === 'new-document' ? 'request-candidate-review-new-' : 'request-candidate-review-current-') + item.id).click(), signal);
      await page.locator('#request-candidate-deferred-review-' + item.id).getByText(/The final result will be prepared after acceptance\./).waitFor({ state: 'visible' });
      const receipt = await acceptedCommand(page, 'AdoptReviewedCandidate', () => idButton(page, 'request-candidate-accept-prepare-' + item.id).click(), signal);
      await visible(page.getByText(/candidate adopted (?:in one saved history edit|into a new document)/i));
      return { candidateId: item.id, placement, readiness: 'deferred-preparation-public-workflow', requestedReadiness: 'C', review, receipt, missing: ['Public deferred review retains input previews; exact encoded-only C readiness needs its separately verified contract and cache witness'], durableAndVisibleCompletion: 'requires exact phase and presentation join' };
    }
    await idButton(page, 'request-candidate-prepare-' + item.id).click();
    if (p.treatment) await page.getByRole('combobox', { name: 'Candidate treatment', exact: true }).selectOption(p.treatment);
    await idButton(page, placeId).click();
    const receipt = await acceptedCommand(page, 'AdoptCandidate', () => idButton(page, 'request-candidate-adopt-' + item.id).click(), signal);
    await visible(page.getByText(/candidate adopted (?:in one saved history edit|into a new document)/i));
    return { candidateId: item.id, placement, treatment: p.treatment ?? 'product-default', replacesSelectedImageVersion: !!p.replaceSelectedImage, readiness: p.readiness ?? 'unverified', receipt, missing: ['Pre-click preparation occurred inside runner action; narrower R15 acceptance requires exact product phases'], durableAndVisibleCompletion: 'requires exact phase and presentation join' };
  }
  if (operation === 'fast.workflow') {
    if (!services.emulator) throw new PrerequisiteError('A dedicated local Fast emulator is required; disabled production queue is not a completed Fast workflow');
    await page.getByRole('combobox', { name: 'Operation', exact: true }).selectOption('Generate with Fast');
    await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill(p.fixturePrompt ?? 'Sealed local Fast performance fixture');
    for (const [name, value] of [['Rendering speed', p.speed ?? 'TURBO'], ['Expansion', p.expansion ?? 'None'], ['Output format', p.format ?? 'png'], ['Request size', 'custom']]) await page.getByRole('combobox', { name, exact: true }).selectOption(value);
    for (const [name, value] of [['Output width', p.width ?? 512], ['Output height', p.height ?? 512], ['Output count', p.count ?? 1]]) await numeric(page, name, value);
    await page.getByRole('textbox', { name: 'Exact seed (empty means Random)', exact: true }).fill(String(p.seed ?? 17));
    await click(page, 'Keep acceleration inactive in this draft');
    await idButton(page, 'request-document').click(); await idButton(page, 'prepare-request').click();
    await idButton(page, 'accept-request').click(); await idButton(page, 'enqueue-request').click();
    return services.emulator.completeWorkflow({ page, cell, publicRead });
  }
  if (operation === 'layers.large-list') {
    const rows = page.getByRole('treeitem'), count = await rows.count();
    assert(count <= 100, 'Mounted layer rows exceed R16 ceiling');
    const before = (await publicRead(page, '/api/v1/documents/' + fixture.documentId)).projection.value;
    await rows.first().click(); await rows.last().scrollIntoViewIfNeeded(); await rows.last().click();
    const reorder = await acceptedCommand(page, 'MoveLayers', () => click(page, 'Move up'), signal);
    const changed = (await publicRead(page, '/api/v1/documents/' + fixture.documentId)).projection.value;
    assert.notDeepEqual(changed.orderedLayerIds, before.orderedLayerIds, 'The selected reorder must actually change the layer stack');
    const undo = await acceptedCommand(page, 'Undo', () => click(page, 'Undo'), signal);
    const restored = (await publicRead(page, '/api/v1/documents/' + fixture.documentId)).projection.value;
    assert.deepEqual(restored.image, before.image); assert.deepEqual(restored.orderedLayerIds, before.orderedLayerIds);
    return { mountedRows: count, metadataRows: fixture.observed?.layers ?? null, reorder, undo, originalStackRestored: true };
  }
  if (operation === 'startup.failure') {
    if (p.scenario === 'missing-key') { await page.goto(await pair()); await ready(page); await visible(page.getByText(/provider.*disabled|not configured/i).first()); return { scenario: p.scenario }; }
    const routePattern = p.scenario === 'blocked-js' ? '**/*.js' : p.chunkPattern;
    if (!routePattern) throw new PrerequisiteError('Failed-chunk case requires an exact sealed lazy chunk pattern');
    const abort = route => route.abort('failed'); await page.route(routePattern, abort);
    try { await page.goto(await pair()); await visible(page.getByRole('alert').first()); return { scenario: p.scenario }; }
    finally { await page.unroute(routePattern, abort); }
  }
  if (operation === 'lifecycle.editor') {
    if (!services.lifecycleCycle) throw new PrerequisiteError('A same-process document close and worker lifecycle controller is required');
    return services.lifecycleCycle({ page, cell, fixture, signal });
  }
  throw new PrerequisiteError('No product browser workflow implemented for ' + operation);
}

export async function verifiedCorpusFile(fixture, role, predicate = () => true) {
  const file = fixture?.corpus?.files?.find(file => file.role === role && predicate(file));
  if (!file?.path || !file.sha256) throw new PrerequisiteError('Missing sealed corpus file role ' + role);
  const identity = await fileIdentity(file.path);
  assert.equal(identity.sha256, file.sha256); assert.equal(String(identity.bytes), String(file.byteLength ?? file.bytes));
  return file.path;
}
