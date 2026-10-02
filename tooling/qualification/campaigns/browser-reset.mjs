import assert from 'node:assert/strict';
import { acceptedCommand, numeric, openDocument, publicRead } from './browser-driver.mjs';
import { intervalWait, monotonic, PrerequisiteError } from './common.mjs';

const navigation = new Set(['navigation.ready', 'portable.reopen', 'startup.failure']);
const queue = new Set(['fast.workflow', 'queue.fault', 'queue.healthy-polling']);
const undoKinds = new Map([
  ['raster.import', ['ImportAsset']], ['raster.resample', ['ResampleImage']],
  ['raster.adopt', ['AdoptCandidate', 'AdoptReviewedCandidate']],
  ['text.apply', ['CreateTextLayer', 'CommitTextEdit', 'ReplaceTextFont']],
]);
const draftKinds = new Set(['interaction.brush', 'raster.stroke-finalize', 'raster.resize-preview', 'text.active-layout', 'text.interaction', 'text.font-set', 'text.recovery']);
const maskDraftKinds = new Set(['interaction.brush', 'raster.stroke-finalize']);
const repeatable = new Set(['raster.export', 'state.snapshot-create', 'text.mixed-ready', 'layers.large-list']);
const viewFields = ['Zoom percentage', 'View X (px)', 'View Y (px)'];
const selects = ['Appearance', 'Density'];
const splitters = ['Request panel width', 'Canvas and inspector width'];
const button = (page, name) => page.getByRole('button', { name, exact: true });
const maskCancel = page => page.getByRole('button', { name: 'Cancel mask draft', exact: true, includeHidden: true });
const issue = message => { throw new PrerequisiteError(message); };
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const sequence = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,39})$/.test(value);

async function acceptedUI(page, type, action, signal) {
  signal?.throwIfAborted();
  const pending = page.waitForResponse(response => {
    const request = response.request();
    if (request.method() !== 'POST' || !/^\/api\/v1\/ui\/[A-Za-z0-9_-]{1,128}$/.test(new URL(response.url()).pathname)) return false;
    try { return request.postDataJSON()?.body?.type === type; } catch { return false; }
  }, { timeout: 120000 });
  pending.catch(() => {}); await action();
  const response = await pending, request = response.request().postDataJSON(), receipt = await response.json();
  if (request?.protocolVersion !== 1 || !opaque(request.requestId) || !opaque(request.sessionId) || !sequence(request.expectedUISeq) || new URL(response.url()).pathname !== '/api/v1/ui/' + request.sessionId || receipt?.protocolVersion !== 1 || receipt.requestId !== request.requestId || receipt.status !== 'accepted' || !sequence(receipt.uiSeq) || BigInt(receipt.uiSeq) <= BigInt(request.expectedUISeq)) issue('Reset requires a fresh accepted typed UI receipt for its exact owner');
  signal?.throwIfAborted();
  return { request, receipt };
}

async function readOwnedUI(page, sessionId, fixture, minimumSequence) {
  const checkpoint = await publicRead(page, '/api/v1/ui/' + sessionId);
  if (checkpoint?.sessionId !== sessionId || !sequence(checkpoint.uiSeq) || BigInt(checkpoint.uiSeq) < BigInt(minimumSequence) || checkpoint.preferences?.documentId !== fixture.documentId || !Array.isArray(checkpoint.drafts)) issue('Reset UI checkpoint does not match its current owner, document and accepted sequence');
  const masks = checkpoint.drafts.filter(draft => draft.kind === 'mask' && draft.documentId === fixture.documentId && draft.status === 'saved-unapplied');
  if (masks.some(draft => !opaque(draft.id) || !opaque(draft.targetLayerId) || !sequence(draft.generation)) || new Set(masks.map(draft => draft.id)).size !== masks.length) issue('Reset mask draft identities are malformed or duplicated');
  return { checkpoint, masks };
}

async function bindCurrentUI(page, fixture, signal) {
  // Applying the already displayed numeric view is an unscored public action.
  // Its original request identifies the actual owner without private state.
  const accepted = await acceptedUI(page, 'SetPreferences', () => button(page, 'Apply view').click(), signal);
  const { sessionId } = accepted.request;
  const observed = await readOwnedUI(page, sessionId, fixture, accepted.receipt.uiSeq);
  return { sessionId, uiSeq: observed.checkpoint.uiSeq, ...observed };
}

/** Deliberately excludes revision, checkpoint and redo. Public Undo advances the
 * revision and retains its redo branch; a reset must never erase that history. */
export function documentResetIdentity(document) {
  if (!document || typeof document.id !== 'string' || typeof document.historyHead !== 'string' || !Array.isArray(document.orderedLayerIds)) issue('Public document identity is incomplete');
  return {
    id: document.id, historyHead: document.historyHead, width: document.width, height: document.height,
    color: document.color, depth: document.depth, orderedLayerIds: [...document.orderedLayerIds],
    compositionVersion: document.compositionVersion ?? null, image: structuredClone(document.image ?? null),
  };
}

async function documentView(page, fixture) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(fixture?.documentId ?? '')) issue('Reset requires the sealed document identity');
  const view = await publicRead(page, '/api/v1/documents/' + fixture.documentId);
  if (view?.projection?.kind !== 'inline' || view.projection.value?.id !== fixture.documentId) issue('Reset requires an inline public projection for the exact sealed document');
  return view.projection.value;
}

async function viewState(page) {
  const values = {};
  for (const label of viewFields) {
    const value = await page.getByRole('spinbutton', { name: label, exact: true }).inputValue();
    if (typeof value !== 'string' || value.trim() === '' || value.length > 64 || !Number.isFinite(Number(value))) issue('Reset baseline contains an invalid numeric view control');
    values[label] = value;
  }
  for (const label of selects) {
    const value = await page.getByRole('combobox', { name: label, exact: true }).inputValue();
    if (!(label === 'Appearance' ? ['auto', 'light', 'dark'] : ['comfortable', 'compact', 'spacious']).includes(value)) issue('Reset baseline contains an unknown appearance or density');
    values[label] = value;
  }
  const separators = {};
  for (const label of splitters) {
    const raw = await page.getByRole('separator', { name: label, exact: true }).getAttribute('aria-valuenow');
    if (raw === null || !Number.isFinite(Number(raw))) issue('Public splitter value unavailable: ' + label);
    separators[label] = Number(raw);
  }
  const tool = await page.locator('en-button.tool[aria-pressed="true"]').innerText();
  if (!['Move', 'Select', 'Mask', 'Pan', 'Zoom', 'Sample'].includes(tool.trim())) issue('Reset requires a nonmodal baseline canvas tool');
  const selected = await page.locator('#layer-tree').getByRole('treeitem').evaluateAll(nodes => nodes.map((node, index) => ({ index, selected: node.getAttribute('aria-selected') === 'true' })).filter(row => row.selected).map(row => row.index));
  const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
  if (!Number.isFinite(scroll.x) || !Number.isFinite(scroll.y)) issue('Public browser scroll position unavailable');
  return { values, separators, tool: tool.trim(), selected, scroll };
}

export async function captureBrowserBaseline({ page, cell, fixture, signal }) {
  signal?.throwIfAborted();
  if (navigation.has(cell.operation)) return { kind: 'browser-reset-baseline-1', operation: cell.operation, document: null, view: null };
  if (maskDraftKinds.has(cell.operation)) await page.waitForFunction(() => document.querySelector('.operation-status')?.getAttribute('aria-busy') === 'false', null, { timeout: 10000 });
  for (const label of ['Cancel mask draft', 'Cancel text edit', 'Cancel review']) {
    const target = label === 'Cancel mask draft' ? maskCancel(page) : button(page, label);
    if (await target.count() && await target.isEnabled() && (label === 'Cancel mask draft' || await target.isVisible())) issue('Sealed reset baseline contains an existing unapplied draft or review');
  }
  const document = await documentView(page, fixture);
  let ui;
  if (maskDraftKinds.has(cell.operation)) {
    const owner = await bindCurrentUI(page, fixture, signal);
    if (owner.masks.length) issue('Sealed mask reset baseline contains a saved unapplied mask draft');
    ui = { sessionId: owner.sessionId, uiSeq: owner.uiSeq, noSavedMaskDrafts: true };
  }
  const view = await viewState(page);
  if (view.selected.length) issue('Capture the reset baseline immediately after opening the sealed document, before selecting layers');
  return { kind: 'browser-reset-baseline-1', operation: cell.operation, document: documentResetIdentity(document), observedRevision: document.revision, view, ...(ui ? { ui } : {}) };
}

/** Prove that exactly the campaign's one child edit is being undone. Never walk
 * arbitrary ancestors or silently restore a different branch. */
export function verifyUndoChild(operation, baseline, current, node) {
  const expected = undoKinds.get(operation);
  if (!expected || current.id !== baseline.id || node?.id !== current.historyHead || node.documentId !== current.id || node.parent !== baseline.historyHead || node.kind !== 'image-edit' || !expected.includes(node.operation)) issue('Reset cannot identify exactly one expected campaign edit above the sealed history head');
  assert.deepEqual(node.before, baseline.image, 'Undo child does not retain the exact original pixels and image state');
  return { historyHead: node.id, parent: node.parent, operation: node.operation };
}

export function undoCommandMatches(command, expected) {
  return command?.body?.type === 'Undo' && command.documentId === expected.id && command.expectedDocumentRevision === expected.revision && command.body.historyHead === expected.historyHead;
}

/** The public control builds from live UI state. Fence its original outgoing
 * command before transmission so a late document advance cannot undo another
 * edit. Bytes are never rewritten; the writer still checks the same revision. */
export async function undoVerifiedChild(page, expected, signal, networkGuard) {
  if (typeof networkGuard?.withUndoFence === 'function') return networkGuard.withUndoFence(expected, () => acceptedCommand(page, 'Undo', () => button(page, 'Undo').click(), signal));
  let admitted = 0, rejectBlocked;
  const blocked = new Promise((_, reject) => { rejectBlocked = reject; }); blocked.catch(() => {});
  const pattern = '**/api/v1/commands';
  const handler = async route => {
    const request = route.request(); let command;
    try { command = request.postDataJSON()?.command; } catch { return route.fallback(); }
    if (request.method() !== 'POST' || command?.body?.type !== 'Undo') return route.fallback();
    if (!undoCommandMatches(command, expected) || admitted !== 0) {
      try { await route.abort('blockedbyclient'); }
      finally { rejectBlocked(new PrerequisiteError('Public Undo changed target or revision before dispatch; no replacement edit was undone')); }
      return;
    }
    admitted++; return route.fallback();
  };
  await page.route(pattern, handler);
  try {
    const receipt = acceptedCommand(page, 'Undo', () => button(page, 'Undo').click(), signal); receipt.catch(() => {});
    const result = await Promise.race([receipt, blocked]);
    assert.equal(admitted, 1, 'Exactly one unchanged public Undo command must cross the reset fence'); return result;
  } finally { await page.unroute(pattern, handler); }
}

async function currentHistoryNode(page, fixture, head) {
  let after = ''; const seen = new Set();
  for (let index = 0; index < 501; index++) {
    const value = await publicRead(page, '/api/v1/documents/' + fixture.documentId + '/history' + (after ? '?after=' + encodeURIComponent(after) : ''));
    if (!Array.isArray(value.items)) issue('Public retained history page unavailable');
    const node = value.items.find(item => item.id === head); if (node) return node;
    if (!value.next || seen.has(value.next)) break;
    seen.add(value.next); after = value.next;
  }
  issue('Exact current history head was not found in bounded public pagination');
}

/** Public cancellation owns the complete flush/ClearDraft/restore lifecycle.
 * It runs only during reset, never among the scored interaction gestures. */
export async function cancelCampaignMaskDraft({ page, fixture, baseline, previousResult, signal }) {
  if (baseline?.ui?.noSavedMaskDrafts !== true || !opaque(baseline.ui.sessionId)) issue('Mask reset needs the original empty owned UI checkpoint baseline');
  const owner = await bindCurrentUI(page, fixture, signal);
  if (owner.sessionId !== baseline.ui.sessionId) issue('Mask reset cannot switch UI draft owners across samples');
  // A busy authoring operation temporarily disables Cancel even when a local
  // draft exists. Never interpret that disabled state as an empty baseline.
  await page.waitForFunction(() => document.querySelector('.operation-status')?.getAttribute('aria-busy') === 'false', null, { timeout: 10000 });
  const previous = previousResult?.observations ?? previousResult;
  if (previous?.actions !== undefined && !Array.isArray(previous.actions)) issue('Mask reset requires the prior campaign action observations');
  const ids = [...new Set([previous?.productCompletion?.draftId, ...(previous?.actions ?? []).map(action => action?.productCompletion?.draftId)].filter(value => value !== undefined))];
  if (ids.length > 1 || ids.some(id => !opaque(id)) || owner.masks.length > 1) issue('Mask reset cannot identify one exact campaign draft');
  const saved = owner.masks[0];
  if (ids.length && saved && saved.id !== ids[0]) issue('Saved mask draft differs from the completed campaign stroke owner');
  const cancel = maskCancel(page), enabled = await cancel.count() && await cancel.isEnabled();
  if (!saved && !enabled) {
    if (ids.length) issue('The completed campaign mask draft disappeared before reset');
    return { actions: [], evidence: { sessionId: owner.sessionId, uiSeq: owner.uiSeq, noSavedMaskDrafts: true, cancelled: false } };
  }
  if (!(await cancel.isVisible())) await button(page, 'Mask').click();
  await page.waitForFunction(() => {
    const element = [...document.querySelectorAll('en-button')].find(node => node.textContent?.trim() === 'Cancel mask draft');
    return !!element && element.disabled === false && document.querySelector('.operation-status')?.getAttribute('aria-busy') === 'false';
  }, null, { timeout: 10000 });
  const accepted = await acceptedUI(page, 'ClearDraft', () => cancel.click(), signal);
  const request = accepted.request, expectedDraftId = ids[0] ?? saved?.id;
  if (request.sessionId !== owner.sessionId || !opaque(request.body?.draftId) || !sequence(request.body?.generation) ||
    (expectedDraftId && request.body.draftId !== expectedDraftId) || (saved && BigInt(request.body.generation) < BigInt(saved.generation))) issue('Mask cancellation receipt does not belong to the exact campaign draft generation');
  await page.waitForFunction(() => {
    const element = [...document.querySelectorAll('en-button')].find(node => node.textContent?.trim() === 'Cancel mask draft');
    const badges = [...document.querySelectorAll('en-badge')].map(node => node.textContent?.trim());
    return !!element && element.disabled === true && !badges.includes('Unapplied mask draft') && !badges.includes('Stale mask draft') && document.querySelector('.operation-status')?.getAttribute('aria-busy') === 'false';
  }, null, { timeout: 10000 });
  const restored = await readOwnedUI(page, owner.sessionId, fixture, accepted.receipt.uiSeq);
  if (restored.masks.length || restored.checkpoint.drafts.some(draft => draft.id === request.body.draftId)) issue('Cancelled mask draft remains in the settled owned UI checkpoint');
  return { actions: ['Cancel mask draft'], evidence: { sessionId: owner.sessionId, requestId: request.requestId, draftId: request.body.draftId, generation: request.body.generation, uiSeq: restored.checkpoint.uiSeq, noSavedMaskDrafts: true, cancelled: true, settledPublicControls: true } };
}

async function cancelDrafts(page) {
  const actions = [];
  for (const [label, witness] of [
    ['Cancel text edit', () => page.locator('#native-text-editor').waitFor({ state: 'hidden' })],
    ['Cancel review', () => page.getByRole('dialog', { name: /Review (image conversion|prepared image edit|portable project)/ }).waitFor({ state: 'hidden' })],
  ]) {
    const target = button(page, label);
    if (await target.count() && await target.isVisible() && await target.isEnabled()) { await target.click(); await witness(); actions.push(label); }
  }
  const editorDialog = page.locator('#editor-dialog');
  if (await editorDialog.count() && await editorDialog.isVisible()) {
    await editorDialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await editorDialog.waitFor({ state: 'hidden' }); actions.push('Cancel open editor dialog');
  }
  return actions;
}

async function restoreView(page, fixture, baseline, signal) {
  // Reopen through the public document picker, preserving the page, feature
  // modules, workers and browser/backend process. This clears layer selection.
  await openDocument(page, fixture);
  for (const label of selects) {
    const control = page.getByRole('combobox', { name: label, exact: true });
    if (await control.inputValue() !== baseline.values[label]) await control.selectOption(baseline.values[label]);
  }
  for (const label of viewFields) if (await page.getByRole('spinbutton', { name: label, exact: true }).inputValue() !== baseline.values[label]) await numeric(page, label, baseline.values[label]);
  await button(page, 'Apply view').click();
  for (const label of splitters) {
    const control = page.getByRole('separator', { name: label, exact: true }), target = baseline.separators[label];
    for (let i = 0; i < 201; i++) {
      signal?.throwIfAborted(); const raw = await control.getAttribute('aria-valuenow'), current = raw === null ? NaN : Number(raw);
      if (!Number.isFinite(current)) issue('Public splitter reset lost its numeric witness');
      if (current === target) break;
      if (i === 200) issue('Baseline splitter value is not reachable using public arrow keys');
      await control.focus(); await control.press(current < target ? 'ArrowRight' : 'ArrowLeft');
      const next = Number(await control.getAttribute('aria-valuenow'));
      if (next === current || (current < target && next > target) || (current > target && next < target)) issue('Public splitter reset cannot reach the exact baseline');
    }
  }
  await button(page, baseline.tool).click(); await page.getByRole('tab', { name: 'History', exact: true }).click();
  // Window scrolling is a public browser presentation API, not an editor or
  // worker mutation. Retain the exact starting viewport after locator scrolling.
  await page.evaluate(({ x, y }) => window.scrollTo({ left: x, top: y, behavior: 'instant' }), baseline.scroll);
  const started = monotonic();
  for (;;) {
    signal?.throwIfAborted(); const actual = await viewState(page);
    if (JSON.stringify(actual) === JSON.stringify(baseline)) break;
    if (monotonic() - started > 10000) assert.deepEqual(actual, baseline, 'Public view controls did not restore the baseline');
    await intervalWait(25, signal);
  }
}

async function queuePages(page) {
  const jobs = [], seen = new Set(); let after = '', first;
  do {
    const value = await publicRead(page, '/api/v1/queue' + (after ? '?after=' + encodeURIComponent(after) : '')); first ??= value;
    if (!Array.isArray(value.jobs)) issue('Public queue reset witness unavailable'); jobs.push(...value.jobs);
    if (jobs.length > 10000 || value.nextCursor && seen.has(value.nextCursor)) issue('Queue reset exceeds bounded public pagination');
    after = value.nextCursor ?? ''; seen.add(after);
  } while (after);
  return { jobs, counts: first.counts, session: first.session };
}

async function queueReady(page, controls, freshJobRequired = true) {
  if (!controls?.set || !controls?.read) issue('Queue reset requires its isolated owned emulator controller');
  const effects = await controls.set({ paused: true, holdMedia: false });
  if (effects.failures?.length || effects.heldMedia !== 0) issue('Owned emulator retained a failed or held transfer after reset');
  if (effects.quiescent !== true || effects.pendingTick !== false) issue('Emulator pause lacks an acknowledged drain of the previous observer tick and result transfers');
  const snapshot = await queuePages(page);
  if (snapshot.counts?.active !== 0 || snapshot.jobs.some(job => job.attempts.some(attempt => attempt.hold))) issue('Another retained queue hold prevents an independent fresh attempt');
  if (freshJobRequired && snapshot.counts.remaining !== null && (!Number.isSafeInteger(snapshot.counts.remaining) || snapshot.counts.remaining < 1)) issue('The retained request cap has no capacity for another fresh emulator attempt');
  return { retainedJobIds: snapshot.jobs.map(job => job.id), effectsBaseline: effects.counts, historyRetained: true, freshJobRequired };
}

async function resetQueue({ page, previousResult, controls, signal, rejection }) {
  const previous = previousResult?.observations ?? previousResult;
  if (rejection) {
    if (rejection.kind === 'capacity-admission') {
      if (previous?.scenario !== 'disk-full-admission' || previous.rejection?.valid !== true || previous.rejection?.code !== 'CAPACITY' || previous.document?.unchanged !== true || previous.storagePressure?.active !== false || previous.storagePressure?.actualAdmissionRecovered !== true || previous.effects?.enqueueCommands !== 1 || ['queuedJobsAdded', 'attemptsAdded', 'submissions'].some(key => previous.effects?.[key] !== 0)) issue('Capacity rejection reset requires exact preserved draft/job evidence and released real storage reservation');
      return { rejectionCase: 'disk-full-admission', expectedNoSubmission: true, ...await queueReady(page, controls, false) };
    }
    if (previous?.caseId !== rejection.caseId || previous.scenario !== rejection.scenario || previous.rejection?.valid !== true || previous.document?.unchanged !== true || ['queuedJobsAdded', 'attemptsAdded', 'enqueueCommands', 'submissions'].some(key => previous.effects?.[key] !== 0)) issue('Fast negative reset lacks its exact prior rejection and zero-job, zero-attempt, zero-submission evidence');
    return { rejectionCase: rejection.caseId, expectedNoSubmission: true, ...await queueReady(page, controls, false) };
  }
  if (!controls?.set || !controls?.read || !previous?.jobId || !previous?.attemptId) issue('Warm queue reset requires the exact prior owned emulator job and attempt');
  const owner = await controls.read();
  if (!owner.jobs?.some(job => job.id === previous.jobId && job.attempts?.some(attempt => attempt.id === previous.attemptId))) issue('Previous queue attempt is not owned by this isolated emulator');
  await controls.set({ paused: false, holdMedia: false, offline: false, status: 'COMPLETED', mediaStatus: 200, dropAcknowledgement: false });
  const started = monotonic(); let snapshot;
  for (;;) {
    signal?.throwIfAborted(); snapshot = await queuePages(page);
    const job = snapshot.jobs.find(job => job.id === previous.jobId), attempt = job?.attempts.find(attempt => attempt.id === previous.attemptId);
    if (!attempt) issue('The prior immutable queue attempt disappeared during reset');
    if (attempt.state === 'submission-uncertain' && attempt.hold) {
      const { showQueueJob } = await import('./browser-queue.mjs'); const card = await showQueueJob(page, previous.jobId);
      await card.getByRole('button', { name: 'Review possible overlapping work', exact: true }).click();
      await acceptedCommand(page, 'OverrideUncertainHold', () => button(page, 'Acknowledge risk and release this local hold').click(), signal);
    } else if (!attempt.hold) break;
    if (monotonic() - started > 30000) issue('Prior owned queue hold did not settle through the public workflow');
    await intervalWait(25, signal);
  }
  return { priorJobId: previous.jobId, priorAttemptId: previous.attemptId, ...await queueReady(page, controls) };
}

/** Only public controls mutate product state. A PASS proves the accepted image
 * and visible controls were restored; it never means historical bytes, request
 * counts, caches or durable revision numbers were erased. */
export async function resetBrowserCell({ page, cell, fixture, sample = {}, previousResult, baseline, controls, server: _server, networkGuard, signal }) {
  try {
    signal?.throwIfAborted(); const p = cell.parameters ?? cell.options ?? cell;
    const rejection = cell.operation === 'queue.fault' && p.scenario === 'disk-full-admission' ? { kind: 'capacity-admission' } : cell.operation === 'fast.workflow' && /^WF(?:0[789]|1[012])$/.test(p.caseId ?? '') ? (await import('./browser-fast-rejections.mjs')).fastRejectionCase(cell) : null;
    if (p.readiness || p.decodedCache || p.mode && p.mode !== 'native') issue('Exact encoded, decoded or fallback readiness needs its separate verified product controller; restoring history does not prove readiness A/B/C');
    if (previousResult && sample.cache === 'cold') issue('A cold sample requires fresh browser and backend processes');
    if (navigation.has(cell.operation)) return { status: 'PASS', cache: sample.cache, navigationInsideAction: true, checkpointsRetained: true, missing: [] };
    if (previousResult && !baseline) issue('A warm reset requires the baseline captured before the previous sample; current state cannot become its replacement');
    baseline ??= await captureBrowserBaseline({ page, cell, fixture, signal });
    if (baseline.kind !== 'browser-reset-baseline-1' || baseline.operation !== cell.operation || baseline.document?.id !== fixture.documentId || !baseline.view) issue('Reset baseline does not belong to this cell and sealed document');
    const actions = [], evidence = {};
    if (!previousResult && queue.has(cell.operation)) evidence.queue = await queueReady(page, controls, !rejection);
    if (previousResult) {
      if (!draftKinds.has(cell.operation) && !undoKinds.has(cell.operation) && !repeatable.has(cell.operation) && !queue.has(cell.operation)) issue('No verified public warm reset is available for ' + cell.operation);
      actions.push(...await cancelDrafts(page));
      if (maskDraftKinds.has(cell.operation)) {
        const cancelled = await cancelCampaignMaskDraft({ page, fixture, baseline, previousResult, signal });
        actions.push(...cancelled.actions); evidence.maskDraft = cancelled.evidence;
      }
      if (queue.has(cell.operation)) evidence.queue = await resetQueue({ page, previousResult, controls, signal, rejection });
      if (undoKinds.has(cell.operation)) {
        const current = await documentView(page, fixture);
        if (current.historyHead !== baseline.document.historyHead) {
          const previous = previousResult.observations ?? previousResult, id = previous.receipt?.commandId;
          if (!/^[A-Za-z0-9_-]{1,128}$/.test(id ?? '')) issue('Undo reset requires the previous sample’s exact durable command receipt');
          const accepted = await publicRead(page, '/api/v1/commands/' + id);
          if (accepted.kind !== 'receipt' || accepted.receipt?.status !== 'accepted' || accepted.receipt.commandId !== id || accepted.receipt.documentRevision !== current.revision) issue('Previous sample receipt does not own the current document revision');
          const node = await currentHistoryNode(page, fixture, current.historyHead);
          evidence.undo = verifyUndoChild(cell.operation, baseline.document, current, node);
          await openDocument(page, fixture);
          evidence.undo.receipt = await undoVerifiedChild(page, current, signal, networkGuard);
          evidence.undo.fence = typeof networkGuard?.withUndoFence === 'function' ? 'exact-original-command-through-owned-proxy' : 'playwright-route';
          evidence.undo.cacheInvalidated = evidence.undo.fence === 'playwright-route';
          actions.push('Undo exact campaign child');
        }
      }
      await restoreView(page, fixture, baseline.view, signal); actions.push('Restore public view without navigation');
    }
    const current = await documentView(page, fixture);
    assert.deepEqual(documentResetIdentity(current), baseline.document, 'Reset changed the baseline history, accepted source closure or pixels');
    const asset = baseline.document.image?.compositeAssetId ?? '';
    await page.waitForFunction(asset => document.querySelector('canvas[aria-label="Document raster preview"]')?.getAttribute('data-asset') === asset, asset);
    return { status: 'PASS', cache: sample.cache, baseline, actions, evidence, observedRevision: current.revision, historyRetained: true, pageReloaded: false, cacheInvalidated: evidence.undo?.cacheInvalidated ?? false, missing: evidence.undo?.cacheInvalidated ? ['Public Undo was fenced by Playwright routing, which invalidates browser resource cache; this reset cannot qualify a warm-cache sample'] : [] };
  } catch (error) {
    if (error instanceof PrerequisiteError) return { status: 'INCONCLUSIVE', missing: [error.message], baseline: baseline ?? null };
    throw error;
  }
}
