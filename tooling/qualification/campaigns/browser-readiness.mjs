import assert from 'node:assert/strict';
import { openDocument, publicRead, runBrowserAction, prepareEncodedAdoptionReview } from './browser-driver.mjs';
import { intervalWait, monotonic, PrerequisiteError } from './common.mjs';
import { verifyEncodedReview, verifyRetainedEncodedExecution, encodedInterpretationMissing } from './browser-encoded.mjs';

const button = (page, id) => page.locator('#' + id).getByRole('button');
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export const supportedRasterModes = Object.freeze(['native', 'worker-offscreen-disabled', 'context-loss']);

/** The forced cohort changes browser capabilities before product code runs.
 * It does not change product ready flags or install a pretend raster worker. */
export async function installRasterCapabilities(context, mode = 'native') {
  if (!supportedRasterModes.includes(mode)) throw new PrerequisiteError('Unknown browser raster capability cohort');
  if (mode !== 'worker-offscreen-disabled') return { mode, injected: false };
  await context.addInitScript(() => {
    for (const key of ['Worker', 'OffscreenCanvas']) Object.defineProperty(globalThis, key, { value: undefined, writable: false, configurable: false });
  });
  return { mode, injected: true, boundary: 'browser realm before product evaluation', disabled: ['Worker', 'OffscreenCanvas'] };
}

export async function readRenderReadiness(page) {
  const value = await page.locator('ie-shell').evaluate(shell => shell.renderReadiness ?? null);
  if (value?.schemaVersion !== 1 || value.clock !== 'browser-performance' || !Number.isFinite(value.timeOrigin) || !Number.isFinite(value.observedMs) || value.viewport?.schemaVersion !== 1) throw new PrerequisiteError('The actual canvas ownership snapshot is unavailable');
  return value;
}

/** A bitmap serial is diagnostic evidence of the current implementation. The
 * readiness decision binds the exact retained asset and actual owner state. */
export function verifyReadinessSnapshot(value, prepared, readiness) {
  if (!['A', 'B'].includes(readiness) || !opaque(prepared?.assetId) || !opaque(prepared?.reviewId)) throw new PrerequisiteError('Exact prepared review identity is required');
  const owner = value?.viewport;
  if (value?.schemaVersion !== 1 || !owner || owner.contextLost || owner.contextRestoring || owner.recoveryError || owner.pendingReads !== 0 || owner.pendingCleanup > 0 || !Number.isSafeInteger(owner.generation)) throw new PrerequisiteError('Canvas decode/recovery has not settled');
  if (readiness === 'A') {
    const resident = owner.representation === 'viewport-tiles'
      ? owner.visibleComplete === true && Number.isSafeInteger(owner.requiredTiles) && owner.requiredTiles > 0 && owner.residentRequiredTiles === owner.requiredTiles && Number.isSafeInteger(owner.decodedBitmaps) && owner.decodedBitmaps >= owner.requiredTiles && owner.pendingCleanup === 0
      : (owner.representation === undefined || owner.representation === 'single-bitmap') && owner.decodedBitmaps === 1;
    if (owner.decodedAssetId !== prepared.assetId || !resident || !Number.isSafeInteger(owner.bitmapSerial) || owner.bitmapSerial <= 0 || value.review?.reviewId !== prepared.reviewId || value.review?.previewId !== prepared.previewId || value.review?.assetId !== prepared.assetId) throw new PrerequisiteError('Prepared reviewed composite is not resident in the actual decoded viewport owner');
  } else {
    if (owner.decodedAssetId === prepared.assetId || value.review !== null) throw new PrerequisiteError('Prepared viewport remains usable; readiness B was not established');
    const evicted = prepared.resident?.viewport;
    if (!evicted || evicted.decodedAssetId !== prepared.assetId || !Number.isSafeInteger(evicted.decodedBitmaps) || evicted.decodedBitmaps < 1 || !Number.isSafeInteger(evicted.releasedBitmaps) || !Number.isSafeInteger(owner.releasedBitmaps) || owner.releasedBitmaps - evicted.releasedBitmaps < evicted.decodedBitmaps || owner.generation <= evicted.generation || owner.bitmapSerial === evicted.bitmapSerial) throw new PrerequisiteError('Readiness B requires an observed real release of the previously resident prepared viewport');
  }
  return { readiness, assetId: prepared.assetId, reviewId: prepared.reviewId, previewId: prepared.previewId, ownerGeneration: owner.generation, bitmapSerial: owner.bitmapSerial, decodedAssetId: owner.decodedAssetId, observedMs: value.observedMs, timeOrigin: value.timeOrigin, releasedBitmaps: owner.releasedBitmaps, decodeStarts: owner.decodeStarts, representation: owner.representation ?? 'single-bitmap', requiredTiles: owner.requiredTiles ?? null, residentRequiredTiles: owner.residentRequiredTiles ?? null, visibleComplete: owner.visibleComplete ?? null, presentationClaim: false };
}

export function verifyPreparedReview(review, snapshot, candidate, document) {
  const preview = review?.preview;
  if (!opaque(review?.reviewId) || typeof review.reviewHash !== 'string' || !opaque(preview?.previewId) || preview.documentId !== document.id || preview.documentRevision !== document.revision || preview.candidate?.candidateId !== candidate.id || snapshot.review?.reviewId !== review.reviewId || snapshot.review?.previewId !== preview.previewId || snapshot.review?.assetId !== preview.after?.compositeAssetId) throw new PrerequisiteError('Public prepared review differs from the exact document, candidate or decoded owner');
  return { reviewId: review.reviewId, reviewHash: review.reviewHash, previewId: preview.previewId, assetId: preview.after.compositeAssetId, documentId: document.id, revision: document.revision, placement: preview.candidate.placement, candidateId: candidate.id };
}

export function contextRecoveryOutcome(before, after, gpu) {
  const a = before?.viewport, b = after?.viewport, missing = [];
  if (!gpu?.commandAccepted) missing.push('Owned CDP GPU crash command was unavailable');
  if (!a || !b || b.contextLosses <= a.contextLosses || b.lastLossMs === null) missing.push('The actual canvas did not report a trusted context loss');
  if (!a || !b || b.contextRestorations <= a.contextRestorations || b.lastRestorationMs === null || b.contextLost || b.contextRestoring || b.recoveryError) missing.push('Trusted native context restoration and product replay were not observed');
  if (a && b && a.decodedAssetId !== b.decodedAssetId) missing.push('The restored canvas does not own the same accepted retained asset');
  if (a && b && (b.releasedBitmaps <= a.releasedBitmaps || b.decodeStarts <= a.decodeStarts)) missing.push('The actual lost bitmap release and retained-asset decode were not observed');
  return { status: missing.length ? 'INCONCLUSIVE' : 'PASS', actionAllowed: true, missing, before, after, gpu, recoveryScope: 'trusted native canvas events and actual retained asset replay; no physical presentation claim' };
}

export function createBrowserReadinessController({ page, browser, engine, fixture, signal, diagnosticOutput, readEncodedEvidence }) {
  let prepared = null, encodedPrepared = null;
  async function prepareEncodedAdoption(cell) {
    const p = cell.parameters ?? cell.options ?? {}, item = p.candidate ?? fixture.candidate;
    if (!item) throw new PrerequisiteError('The sealed retained candidate is unavailable');
    const document = (await publicRead(page, '/api/v1/documents/' + fixture.documentId)).projection.value;
    const value = await prepareEncodedAdoptionReview({ page, cell, fixture, signal });
    encodedPrepared = verifyEncodedReview(value.review, document, item, value.placement);
    await page.waitForFunction(() => document.querySelector('ie-shell')?.renderReadiness?.viewport?.pendingReads === 0);
    const owner = await readRenderReadiness(page);
    return { status: 'PASS', qualification: 'INCONCLUSIVE', actionAllowed: true, missing: [encodedInterpretationMissing], kind: 'public-encoded-rebuild-precondition-1', preparationOutsideAcceptance: true, preparation: value.receipt, prepared: encodedPrepared, owner, durableDeletion: false, decodedInputEvictionClaim: false };
  }
  async function verifyEncodedReadiness(item) {
    if (!encodedPrepared || encodedPrepared.candidateId !== item.id) throw new PrerequisiteError('No matching public encoded review exists');
    const document = (await publicRead(page, '/api/v1/documents/' + encodedPrepared.documentId)).projection.value;
    const review = await publicRead(page, '/api/v1/image-edit-reviews/' + encodedPrepared.reviewId);
    const verified = verifyEncodedReview(review, document, item, encodedPrepared.placement);
    if (verified.reviewHash !== encodedPrepared.reviewHash || verified.revision !== encodedPrepared.revision) throw new PrerequisiteError('The frozen encoded review changed before acceptance');
    const owner = await readRenderReadiness(page);
    if (owner.review || owner.viewport.pendingReads !== 0 || owner.viewport.contextLost || owner.viewport.contextRestoring) throw new PrerequisiteError('Canvas review or recovery remains active before encoded acceptance');
    return { ...verified, owner, inputRepresentation: 'encoded capabilities; canonical history remains retained' };
  }
  async function observeEncodedAdoption(item, receipt, preClick) {
    if (!encodedPrepared || item.id !== encodedPrepared.candidateId || receipt.documentId !== encodedPrepared.targetDocumentId) throw new PrerequisiteError('Encoded adoption differs from its frozen target document');
    const document = (await publicRead(page, '/api/v1/documents/' + receipt.documentId)).projection.value;
    const assetId = document.image?.compositeAssetId;
    if (!opaque(assetId)) throw new PrerequisiteError('Encoded acceptance produced no retained composite');
    await page.waitForFunction(asset => {
      const state = document.querySelector('ie-shell')?.renderReadiness;
      return state?.review === null && state.viewport?.pendingReads === 0 && state.viewport.decodedAssetId === asset;
    }, assetId);
    if (!readEncodedEvidence) throw new PrerequisiteError('Owned writer encoded execution evidence is unavailable');
    const execution = await verifyRetainedEncodedExecution(await readEncodedEvidence(), preClick, receipt.commandId, assetId, diagnosticOutput);
    return { after: await readRenderReadiness(page), execution, exactRetainedComposite: true, missing: execution.missing };
  }
  async function prepareAdoption(cell) {
    const p = cell.parameters ?? cell.options ?? {}, item = p.candidate ?? fixture.candidate;
    if (!item) throw new PrerequisiteError('The sealed retained candidate is unavailable');
    const document = (await publicRead(page, '/api/v1/documents/' + fixture.documentId)).projection.value;
    const preparation = await runBrowserAction({ page, cell: { ...cell, operation: 'raster.masked-prepare', parameters: { ...p, readiness: undefined } }, fixture, signal });
    await button(page, 'request-candidate-canvas-preview-' + item.id).click();
    await page.waitForFunction(() => {
      const value = document.querySelector('ie-shell')?.renderReadiness;
      return value?.review && value.viewport?.pendingReads === 0 && value.viewport.decodedAssetId === value.review.assetId;
    });
    const resident = await readRenderReadiness(page);
    const review = await publicRead(page, '/api/v1/image-edit-reviews/' + resident.review.reviewId);
    prepared = { ...verifyPreparedReview(review, resident, item, document), resident, preparation };
    verifyReadinessSnapshot(resident, prepared, 'A');
    if (p.readiness === 'B') {
      await button(page, 'request-candidate-canvas-return-' + item.id).click();
      await page.waitForFunction(assetId => {
        const value = document.querySelector('ie-shell')?.renderReadiness;
        return value?.review === null && value.viewport?.pendingReads === 0 && value.viewport.decodedAssetId !== assetId;
      }, prepared.assetId);
    }
    const witness = await verifyDecodedReadiness(item, p.readiness);
    return { status: 'PASS', actionAllowed: true, missing: [], kind: 'public-prepared-review-cache-state-1', preparationOutsideAcceptance: true, prepared: { ...prepared, resident: undefined }, resident, witness, durableDeletion: false };
  }
  async function verifyDecodedReadiness(item, readiness) {
    if (!prepared || prepared.candidateId !== item.id) throw new PrerequisiteError('No matching public pre-click preparation exists');
    const document = (await publicRead(page, '/api/v1/documents/' + prepared.documentId)).projection.value;
    if (document.revision !== prepared.revision) throw new PrerequisiteError('Accepted document changed after preparation');
    const review = await publicRead(page, '/api/v1/image-edit-reviews/' + prepared.reviewId);
    if (review.reviewHash !== prepared.reviewHash || review.preview?.after?.compositeAssetId !== prepared.assetId) throw new PrerequisiteError('Durable reviewed preparation changed before acceptance');
    return verifyReadinessSnapshot(await readRenderReadiness(page), prepared, readiness);
  }
  async function observeAdoption(item, receipt, preClick) {
    if (!prepared || item.id !== prepared.candidateId || !opaque(receipt.documentId)) throw new PrerequisiteError('Adoption does not belong to the prepared review');
    const document = (await publicRead(page, '/api/v1/documents/' + receipt.documentId)).projection.value;
    assert.equal(document.image?.compositeAssetId, prepared.assetId, 'Accepted composite must be the exact reviewed retained asset');
    await page.locator('.document-name').filter({ hasText: `${document.width} × ${document.height} · revision ${document.revision}` }).waitFor({ state: 'visible' });
    await page.waitForFunction(assetId => {
      const value = document.querySelector('ie-shell')?.renderReadiness;
      return value?.review === null && value.viewport?.pendingReads === 0 && value.viewport.decodedAssetId === assetId;
    }, prepared.assetId);
    const after = await readRenderReadiness(page), sameDecodedOwner = after.viewport.bitmapSerial === preClick.bitmapSerial && after.viewport.decodeStarts === preClick.decodeStarts;
    return { after, sameDecodedOwner, exactRetainedComposite: true, missing: preClick.readiness === 'A' && !sameDecodedOwner ? ['The prepared owner was resident at input but product acceptance did not reuse that decoded owner'] : [] };
  }
  async function recoverContext() {
    const before = await readRenderReadiness(page), document = (await publicRead(page, '/api/v1/documents/' + fixture.documentId)).projection.value;
    const gpu = { method: 'Browser.crashGpuProcess', commandAccepted: false, before: [], after: [] };
    if (engine !== 'chromium') return contextRecoveryOutcome(before, await readRenderReadiness(page), gpu);
    const cdp = await browser.newBrowserCDPSession();
    try {
      const processes = async () => (await cdp.send('SystemInfo.getProcessInfo')).processInfo.filter(item => item.type === 'GPU').map(item => ({ id: item.id, type: item.type }));
      gpu.before = await processes();
      try { await cdp.send('Browser.crashGpuProcess'); gpu.commandAccepted = true; } catch { gpu.unavailable = true; }
      const start = monotonic();
      for (;;) {
        signal?.throwIfAborted(); const value = await readRenderReadiness(page), owner = value.viewport;
        if (owner.contextRestorations > before.viewport.contextRestorations && !owner.contextLost && !owner.contextRestoring && owner.pendingReads === 0) break;
        if (!gpu.commandAccepted || monotonic() - start >= 10000) break;
        await intervalWait(25, signal);
      }
      gpu.after = await processes();
      assert.deepEqual((await publicRead(page, '/api/v1/documents/' + fixture.documentId)).projection.value, document, 'GPU loss/recovery must retain the accepted document exactly');
      return contextRecoveryOutcome(before, await readRenderReadiness(page), gpu);
    } finally { await cdp.detach(); }
  }
  async function resetProductState(cell) {
    const p = cell.parameters ?? cell.options ?? {}, mode = p.mode ?? 'native';
    if (cell.operation === 'raster.adopt' && ['A', 'B'].includes(p.readiness)) return prepareAdoption(cell);
    if (cell.operation === 'raster.adopt' && p.readiness === 'C') return prepareEncodedAdoption(cell);
    if (p.readiness || p.decodedCache) return { status: 'INCONCLUSIVE', actionAllowed: true, missing: ['The public deferred/prepare workflow retains canonical source inputs; strict encoded-only readiness and absence of reusable durable preparation are not established'] };
    if (mode === 'worker-offscreen-disabled') {
      const capabilities = await page.evaluate(() => ({ Worker: typeof Worker, OffscreenCanvas: typeof OffscreenCanvas }));
      if (capabilities.Worker !== 'undefined' || capabilities.OffscreenCanvas !== 'undefined') throw new PrerequisiteError('The forced browser capability absence was not established before navigation');
      const owner = await readRenderReadiness(page);
      return { status: 'PASS', actionAllowed: true, mode, capabilities, owner, missing: [], renderer: owner.viewport.renderer, usesBrowserRasterWorker: owner.viewport.usesBrowserRasterWorker, usesOffscreenCanvas: owner.viewport.usesOffscreenCanvas, scope: 'actual raster workflow with browser capabilities absent; the shipped raster renderer already uses main-thread Canvas2D' };
    }
    if (mode === 'context-loss') return recoverContext();
    if (mode !== 'native') throw new PrerequisiteError('Unsupported browser raster mode');
    return { status: 'PASS', actionAllowed: true, missing: [] };
  }
  return { resetProductState, verifyDecodedReadiness, observeAdoption, prepareAdoption, verifyEncodedReadiness, observeEncodedAdoption, async returnToAccepted() {
    const state = await readRenderReadiness(page);
    if (state.review && prepared) await button(page, 'request-candidate-canvas-return-' + prepared.candidateId).click();
    await openDocument(page, fixture);
    prepared = null; encodedPrepared = null;
  } };
}
