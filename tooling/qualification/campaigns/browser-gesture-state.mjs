import { PrerequisiteError } from './common.mjs';
import { createHash } from 'node:crypto';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const positive = value => finite(value) && value > 0;
const requireValue = (condition, message) => { if (!condition) throw new PrerequisiteError(message); };

/** Reads public DOM geometry/controls and existing product performance marks.
 * It never reads an editor instance, private component field, or shadow tree. */
export async function readGestureState(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas[aria-label="Document raster preview"]');
    const rect = canvas?.getBoundingClientRect();
    const editor = performance.getEntriesByName('ie.editor.updated').at(-1);
    const viewport = performance.getEntriesByName('ie.viewport.drawn').at(-1);
    const tool = document.querySelector('en-button.tool[aria-pressed="true"]');
    const diameter = document.querySelector('en-number-field[label="Brush diameter (document px)"]');
    return {
      clock: 'browser-performance', observedMs: performance.now(), timeOrigin: performance.timeOrigin,
      box: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
      viewport: viewport ? { ...viewport.detail, observedMs: viewport.startTime } : null,
      editor: editor ? { ...editor.detail, observedMs: editor.startTime } : null,
      tool: tool?.querySelector('[slot="label"]')?.textContent?.trim() ?? null,
      brushDiameter: diameter ? Number(diameter.value) : null,
      visibility: document.visibilityState,
    };
  });
}

export function eligibleGestureLayers(image) {
  requireValue(Array.isArray(image?.layers), 'Public image layer inventory is absent');
  return [...image.layers].reverse().map((layer, rowIndex) => ({ ...layer, rowIndex }))
    .filter(layer => layer.kind === 'image' && layer.visible === true && layer.locked === false);
}

function geometry(state, document) {
  const box = state?.box, viewport = state?.viewport;
  requireValue(positive(document?.width) && positive(document?.height), 'The gesture document has no finite extent');
  requireValue(box && [box.x, box.y].every(finite) && positive(box.width) && positive(box.height), 'The canvas has no visible pointer rectangle');
  requireValue(viewport && positive(viewport.zoom) && [viewport.x, viewport.y].every(finite), 'Exact public viewport transform is absent');
  requireValue(state.clock === 'browser-performance' && positive(state.timeOrigin) && finite(state.observedMs) &&
    finite(viewport.observedMs) && viewport.observedMs <= state.observedMs, 'Viewport observation has no browser clock identity');
  return { box, viewport };
}

/** Two visible dyadic zoom changes inside the fitted envelope, computed once
 * during setup. Integer document points and dyadic CSS layout offsets retain
 * their exact geometry through native float32 positions, avoiding artificial
 * decimal expansion in the bounded mask draft. No authored point is rounded.
 * Later layout changes must still pass the actual per-stroke bounds/hash. */
export function chooseInteractionZoomPercentages(state, document) {
  const { box } = geometry(state, document);
  const fit = Math.min((box.width - 80) / document.width, (box.height - 80) / document.height);
  const upper = 2 ** Math.floor(Math.log2(fit * 0.8));
  const values = [upper / 2 * 100, upper * 100];
  requireValue(values.every(positive) && values[0] >= 0.01 && values[1] > values[0], 'Canvas cannot provide two distinct visible interaction zoom settings');
  return values;
}

/** Fixed document points become CSS positions through the currently observed
 * transform. A pan, split, density, or zoom never triggers a hidden Fit action. */
export function planStrokeCoordinates(specimen, state, { document, eligibleLayerIds } = {}) {
  const { box, viewport } = geometry(state, document);
  requireValue(state.visibility === 'visible' && state.tool === 'Mask' && state.brushDiameter === 64,
    'The scored stroke requires the already selected Mask tool and 64px brush');
  requireValue(state.editor?.ready === true && state.editor.busy === false && state.editor.documentId === document.id &&
    state.editor.revision === document.revision && Array.isArray(state.editor.selected) && state.editor.selected.length === 1,
  'The public editor witness differs from the prepared document or selection');
  requireValue(Array.isArray(eligibleLayerIds) && eligibleLayerIds.includes(state.editor.selected[0]), 'The selected layer is not an eligible visible unlocked image');
  requireValue(specimen?.brushDiameter === 64 && specimen.sampleHz === 60 && Array.isArray(specimen.samples) && specimen.samples.length === 120,
    'Scored stroke requires the sealed 120-sample 64px specimen');
  const points = specimen.samples.map((sample, index) => {
    requireValue(finite(sample.x) && finite(sample.y) && sample.x >= 0 && sample.y >= 0 && sample.x <= document.width && sample.y <= document.height &&
      finite(sample.timeMs) && Math.abs(sample.timeMs - index * 1000 / 60) < 1e-9, 'Sealed stroke geometry or target schedule differs');
    const x = box.x + box.width / 2 + viewport.x + (sample.x - document.width / 2) * viewport.zoom;
    const y = box.y + box.height / 2 + viewport.y + (sample.y - document.height / 2) * viewport.zoom;
    requireValue(x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height,
      'Sealed stroke leaves the current visible canvas; no hidden viewport reset is allowed');
    return { index, x, y, documentX: sample.x, documentY: sample.y, plannedOffsetMs: sample.timeMs };
  });
  requireValue(points[118].x === points[119].x && points[118].y === points[119].y,
    'Native pointer release must use the final move position');
  return { specimenId: specimen.id, document: { id: document.id, revision: document.revision, width: document.width, height: document.height }, documentId: document.id, revision: document.revision,
    selectedLayerId: state.editor.selected[0], state, points,
    scheduleClock: 'relative-target-only', actualInputClock: 'native-events-required' };
}

/** Validate actual native delivery independently of the intended dispatches.
 * Coalesced entries are not expanded: Authoring consumes delivered events only.
 * Physical presentation and successful product append are separate evidence. */
export function validateNativeStroke(observation, plan) {
  const events = Array.isArray(observation?.events) ? observation.events : [], missing = [], failures = [], coordinateDeviations = [];
  if (observation?.clock !== 'browser-performance' || observation.timeOrigin !== plan?.state?.timeOrigin ||
    !finite(observation.armedMs) || !finite(observation.stoppedMs) || observation.armedMs < 0 || observation.stoppedMs < observation.armedMs) missing.push('same-browser-input-clock');
  if (observation?.overflow) failures.push('native-event-overflow');
  if (observation?.cancelled) failures.push('native-pointer-cancelled');
  if (observation?.canvasStillConnected !== true) failures.push('native-canvas-replaced');
  if (events.length !== 120) failures.push('native-stroke-event-count');
  if (observation?.firstInputMs !== events[0]?.inputMs) missing.push('actual-trusted-stroke-input');
  const pointer = events[0]?.pointerId;
  for (const [index, event] of events.entries()) {
    const expectedType = index === 0 ? 'pointerdown' : index === 119 ? 'pointerup' : 'pointermove';
    if (event.type !== expectedType || event.trusted !== true || event.primary !== true || event.pointerType !== 'mouse' ||
      !Number.isSafeInteger(event.pointerId) || event.pointerId !== pointer || event.buttons !== (index === 119 ? 0 : 1)) failures.push('native-stroke-event-sequence');
    if (!finite(event.inputMs) || !finite(event.observedMs) || event.inputMs < observation.armedMs || event.inputMs > event.observedMs || event.observedMs > observation.stoppedMs ||
      index && event.inputMs < events[index - 1].inputMs) missing.push('ordered-native-input-timestamps');
    const point = plan?.points?.[index];
    // Chromium's native event path uses gfx::PointF before the public fractional
    // PointerEvent coordinates. Allow two float32 relative epsilons, never an
    // integer-pixel rewrite. Preserve the delivered values and every residual.
    // https://chromium.googlesource.com/chromium/src/+/HEAD/third_party/blink/renderer/core/events/mouse_event.cc
    if (!point || !finite(event.clientX) || !finite(event.clientY)) failures.push('native-stroke-coordinate-mismatch');
    else {
      const x = event.clientX - point.x, y = event.clientY - point.y;
      coordinateDeviations.push({ index, cssX: x, cssY: y, documentX: x / plan.state.viewport.zoom, documentY: y / plan.state.viewport.zoom });
      if (Math.abs(x) > Math.max(1, Math.abs(point.x)) * 2 ** -22 || Math.abs(y) > Math.max(1, Math.abs(point.y)) * 2 ** -22) failures.push('native-stroke-coordinate-mismatch');
    }
  }
  return { status: failures.length ? 'FAIL' : missing.length ? 'INCONCLUSIVE' : 'PASS',
    scope: 'trusted-delivered-pointer-input-only', clock: 'browser-performance', timeOrigin: observation?.timeOrigin ?? null,
    sampleCount: events.length, failures: [...new Set(failures)], missing: [...new Set(missing)],
    samples: events.map((event, index) => ({ index, ...event, presentedMs: null })),
    coordinatePrecision: { policy: 'two-float32-relative-epsilons-in-css-coordinates', deviations: coordinateDeviations },
    physicalPresentationQualified: false, productAppendQualified: false };
}

export function validateNativeDiscrete(observation, { timeOrigin } = {}) {
  const missing = [], failures = [], events = Array.isArray(observation?.events) ? observation.events : [];
  if (observation?.clock !== 'browser-performance' || observation.timeOrigin !== timeOrigin || !finite(observation.armedMs) || !finite(observation.stoppedMs) || observation.stoppedMs < observation.armedMs) missing.push('same-browser-input-clock');
  if (observation?.overflow || events.length > 64) failures.push('native-event-overflow');
  if (observation?.cancelled || observation?.canvasStillConnected !== true) failures.push('native-input-context-changed');
  if (!events.length || events.some(event => !['pointerdown', 'keydown', 'input', 'change'].includes(event.type))) missing.push('bounded-discrete-input-events');
  const first = events.find(event => event.trusted === true);
  if (!first || first.inputMs !== observation?.firstInputMs) missing.push('actual-trusted-discrete-input');
  for (const [index, event] of events.entries()) if (!finite(event.inputMs) || !finite(event.observedMs) ||
    event.inputMs < observation.armedMs || event.inputMs > event.observedMs || event.observedMs > observation.stoppedMs ||
    index && event.inputMs < events[index - 1].inputMs) missing.push('ordered-native-input-timestamps');
  return { status: failures.length ? 'FAIL' : missing.length ? 'INCONCLUSIVE' : 'PASS', scope: 'native-discrete-input-only',
    clock: 'browser-performance', timeOrigin: observation?.timeOrigin ?? null, inputMs: first?.inputMs ?? null,
    events, failures: [...new Set(failures)], missing: [...new Set(missing)], physicalPresentationQualified: false };
}

/** Bind successful product append to the same native stroke, not a stale badge.
 * Draft ownership remains independent from the prescribed selection gestures. */
export function validateRecordedStroke({ observation, plan, completion, priorCompletion = null, priorUndo = null, requireEmptyDraft = false } = {}) {
  const native = validateNativeStroke(observation, plan), missing = [...native.missing], failures = [...native.failures];
  const value = completion?.detail, previous = priorCompletion?.detail;
  const down = observation?.events?.[0], up = observation?.events?.at(-1);
  if (!value || value.schemaVersion !== 1 || !finite(completion.startMs) || !down || !up ||
    !Number.isSafeInteger(value.gestureOrdinal) || value.gestureOrdinal <= 0 || value.pointerId !== down.pointerId ||
    value.inputDownMs !== down.inputMs || value.inputUpMs !== up.inputMs || completion.startMs < up.inputMs || value.trusted !== true) missing.push('matching-successful-product-stroke-witness');
  if (value) {
    if (value.sampleCount !== 120 || value.brushDiameter !== 64) failures.push('product-consumed-stroke-shape');
    if (value.documentId !== plan.documentId || value.revision !== plan.revision || value.selectedLayerId !== plan.selectedLayerId) failures.push('product-stroke-document-or-selection-mismatch');
    if (typeof value.draftId !== 'string' || !value.draftId || typeof value.targetLayerId !== 'string' || !value.targetLayerId ||
      typeof value.targetLayerVersion !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value.targetLayerVersion) || !Number.isSafeInteger(value.operationCount) || value.operationCount < 1) missing.push('actual-bound-mask-draft-identity');
    if (requireEmptyDraft && value.operationCount !== 1) failures.push('prepared-empty-mask-draft');
    if (previous) {
      let previousCount = requireEmptyDraft ? null : previous.operationCount;
      if (priorUndo) {
        const undoInput = validateNativeDiscrete(priorUndo.native, { timeOrigin: plan.state.timeOrigin });
        if (undoInput.status !== 'PASS' || priorUndo.draftId !== previous.draftId || priorUndo.gestureOrdinal !== previous.gestureOrdinal ||
          priorUndo.beforeOperationCount !== previous.operationCount || priorUndo.beforeOperationCount !== 1 || priorUndo.afterOperationCount !== 0 || priorUndo.buttonDisabled !== true ||
          !finite(priorUndo.observedMs) || !finite(undoInput.inputMs) || !finite(down?.inputMs) || undoInput.inputMs < priorCompletion.startMs ||
          priorUndo.observedMs < undoInput.inputMs || priorUndo.observedMs > down.inputMs || priorUndo.native.stoppedMs > down.inputMs) {
          if (undoInput.status === 'FAIL') failures.push('failed-counted-mask-undo');
          else missing.push('observed-counted-mask-undo');
        }
        else previousCount = priorUndo.afterOperationCount;
      } else if (requireEmptyDraft) missing.push('preceding-counted-mask-undo');
      if (value.gestureOrdinal <= previous.gestureOrdinal || previousCount !== null && value.operationCount !== previousCount + 1 ||
        value.draftId !== previous.draftId || value.targetLayerId !== previous.targetLayerId || value.targetLayerVersion !== previous.targetLayerVersion) failures.push('mask-draft-continuity');
    } else if (value.targetLayerId !== plan.selectedLayerId) failures.push('initial-mask-draft-target');
    if (Array.isArray(observation?.events) && observation.events.length === 120) {
      const { box, viewport } = plan.state;
      const actualPoints = observation.events.map(event => [
        (event.clientX - box.x - box.width / 2 - viewport.x) / viewport.zoom + plan.document.width / 2,
        (event.clientY - box.y - box.height / 2 - viewport.y) / viewport.zoom + plan.document.height / 2,
      ]);
      const geometrySha256 = 'sha256:' + createHash('sha256').update(JSON.stringify(actualPoints)).digest('hex');
      if (value.geometrySha256 !== geometrySha256) failures.push('product-consumed-coordinate-hash');
    } else missing.push('product-coordinate-evidence');
  }
  return { ...native, status: failures.length ? 'FAIL' : missing.length ? 'INCONCLUSIVE' : 'PASS',
    scope: 'native-input-and-successful-local-mask-draft-append', completion,
    failures: [...new Set(failures)], missing: [...new Set(missing)],
    productAppendQualified: !failures.length && !missing.length, physicalPresentationQualified: false };
}

/** One bounded passive canvas observer. Arming/reading changes only harness
 * bookkeeping; all input still travels through Playwright's native APIs. */
export async function installGestureObserver(page) {
  const key = '__IDEOGRAM_CAMPAIGN_NATIVE_STROKES__';
  await page.evaluate(key => {
    if (Object.hasOwn(globalThis, key)) throw Error('Native gesture observer is already installed');
    const canvas = document.querySelector('canvas[aria-label="Document raster preview"]');
    if (!canvas) throw Error('Native gesture observer requires the public document canvas');
    let current = null;
    const listener = event => {
      if (!current) return;
      const stroke = current.kind === 'stroke';
      if (stroke && !event.composedPath().includes(canvas)) return;
      if (stroke && !['pointerdown', 'pointermove', 'pointerup', 'pointercancel'].includes(event.type)) return;
      if (!stroke && !['pointerdown', 'keydown', 'input', 'change'].includes(event.type)) return;
      if (event.type === 'pointercancel') current.cancelled = true;
      if (stroke && event.type === 'pointermove' && current.events.length === 0 && event.buttons === 0) return;
      if (current.events.length >= (stroke ? 121 : 64)) { current.overflow = true; return; }
      if (event.isTrusted && current.firstInputMs === null) current.firstInputMs = event.timeStamp;
      const row = { type: event.type, inputMs: event.timeStamp, observedMs: performance.now(), trusted: event.isTrusted };
      if (event instanceof PointerEvent) Object.assign(row, { primary: event.isPrimary, pointerType: event.pointerType,
        pointerId: event.pointerId, buttons: event.buttons, clientX: event.clientX, clientY: event.clientY });
      if (event instanceof KeyboardEvent) row.key = ['Tab', 'Enter', 'Escape', 'Home', 'End', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ', '+', '-', '0'].includes(event.key) ? event.key : 'other';
      current.events.push(row);
    };
    const types = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'keydown', 'input', 'change'];
    for (const type of types) document.addEventListener(type, listener, { passive: true, capture: true });
    Object.defineProperty(globalThis, key, { configurable: true, value: {
      begin(id, kind) { if (current) throw Error('Native gesture observation is already active'); current = { id, kind, events: [], overflow: false, cancelled: false, firstInputMs: null, clock: 'browser-performance', timeOrigin: performance.timeOrigin, armedMs: performance.now() }; return { id, kind, clock: current.clock, timeOrigin: current.timeOrigin, armedMs: current.armedMs }; },
      end() { if (!current) throw Error('Native stroke observation is not active'); const value = { ...current, stoppedMs: performance.now(), canvasStillConnected: canvas.isConnected }; current = null; return value; },
      close() { for (const type of types) document.removeEventListener(type, listener, { capture: true }); current = null; delete globalThis[key]; },
    } });
  }, key);
  return {
    now: () => page.evaluate(() => ({ clock: 'browser-performance', timeOrigin: performance.timeOrigin, nowMs: performance.now() })),
    begin: (id, { kind = 'stroke' } = {}) => page.evaluate(({ key, id, kind }) => { if (typeof id !== 'string' || !id || id.length > 128 || !['stroke', 'discrete'].includes(kind)) throw Error('Invalid gesture observation identity'); return globalThis[key].begin(id, kind); }, { key, id, kind }),
    end: () => page.evaluate(key => globalThis[key].end(), key),
    close: () => page.evaluate(key => globalThis[key]?.close(), key),
  };
}
