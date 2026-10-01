// Fast negative workflows use public controls and public read-only witnesses.
// A frontend rejection is never relabeled as a timed backend validation call.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { monotonic, intervalWait, PrerequisiteError } from './common.mjs';
import { acceptedCommand, numeric, publicRead } from './browser-driver.mjs';

const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const HASH = /^sha256:[a-f0-9]{64}$/;
const cases = Object.freeze({
  WF07: ['reject-source', 'source', 'INACTIVE_INPUT'],
  WF08: ['reject-mask', 'mask', 'INACTIVE_INPUT'],
  WF09: ['reject-lora', 'adapters', 'INACTIVE_INPUT'],
  WF10: ['reject-acceleration', 'acceleration', 'INACTIVE_INPUT'],
  WF11: ['reject-large', 'expansion', 'EXPANSION'],
  WF12: ['reject-invalid-size', 'size', 'SIZE'],
});
const click = (scope, name) => scope.getByRole('button', { name, exact: true }).first().click();
const select = (page, name, value) => page.getByRole('combobox', { name, exact: true }).selectOption(value);
const reason = ({ field, code }) => code === 'INACTIVE_INPUT' ? `Keep ${field} in the saved draft explicitly, or choose a compatible operation.` : code === 'EXPANSION' ? 'Choose a supported expansion; no downgrade is automatic.' : 'Custom dimensions violate metadata eligibility 512–2048, multiples of 16. No rounding.';

export function fastRejectionCase(cell) {
  const caseId = cell?.parameters?.caseId, descriptor = Object.hasOwn(cases, caseId) ? cases[caseId] : null;
  if (cell?.operation !== 'fast.workflow' || !descriptor || cell.parameters.scenario !== undefined && cell.parameters.scenario !== descriptor[0]) throw new PrerequisiteError('An exact WF07–WF12 Fast rejection case is required');
  return { caseId, scenario: descriptor[0], field: descriptor[1], code: descriptor[2] };
}

/** Reject generic errors, wrong fields, and a second unrelated invalid input.
 * Raw UI text is compared privately, then projected to codes and hashes only. */
export function summarizeFastIssues(items, descriptor) {
  const valid = Array.isArray(items) && items.length === 1 && items[0]?.target === 'request-' + descriptor.field && items[0]?.message === descriptor.code + ': ' + reason(descriptor);
  return { valid, count: Array.isArray(items) ? items.length : null, issues: valid ? [{ field: descriptor.field, code: descriptor.code, messageHash: hash(items[0].message) }] : [] };
}

export function verifyNoFastSubmission({ beforeJobs, afterJobs, beforeEffects, afterEffects, enqueueCommands }) {
  const identity = jobs => {
    assert(Array.isArray(jobs), 'Public queue metadata is required');
    const ids = new Set();
    return jobs.map(job => {
      assert(opaque(job.id) && !ids.has(job.id), 'Queue identities must be unique'); ids.add(job.id);
      assert(Array.isArray(job.attempts) && job.attempts.every(attempt => opaque(attempt.id)), 'Attempt identities are required');
      const attempts = job.attempts.map(attempt => attempt.id).sort(); assert.equal(new Set(attempts).size, attempts.length);
      return { id: job.id, attempts };
    }).sort((a, b) => a.id.localeCompare(b.id));
  };
  for (const effects of [beforeEffects, afterEffects]) assert(Number.isSafeInteger(effects?.counts?.submissions) && effects.counts.submissions >= 0 && Array.isArray(effects.failures), 'Actual emulator submission counters are required');
  assert(Number.isSafeInteger(enqueueCommands) && enqueueCommands === 0, 'Rejected request sent QueueInference');
  assert.deepEqual(identity(afterJobs), identity(beforeJobs), 'Rejected request created a durable job or attempt');
  assert.equal(afterEffects.counts.submissions, beforeEffects.counts.submissions, 'Rejected request reached the emulator');
  assert.deepEqual(afterEffects.failures, beforeEffects.failures, 'Unexpected emulator failure during rejection');
  return { queuedJobsAdded: 0, attemptsAdded: 0, enqueueCommands: 0, submissions: 0, retainedJobs: beforeJobs.length };
}

async function allJobs(page, signal) {
  const jobs = [], seen = new Set(); let after = '';
  do {
    signal?.throwIfAborted();
    const value = await publicRead(page, '/api/v1/queue' + (after ? '?after=' + encodeURIComponent(after) : ''));
    if (!Array.isArray(value.jobs)) throw new PrerequisiteError('Public retained queue metadata is unavailable');
    jobs.push(...value.jobs); after = value.nextCursor ?? '';
    if (jobs.length > 10000 || after && seen.has(after)) throw new PrerequisiteError('Public queue exceeds the fixed fixture envelope');
    seen.add(after);
  } while (after);
  return jobs;
}

async function acknowledge(page, field) {
  const button = page.getByRole('button', { name: `Keep ${field} inactive in this draft`, exact: true }).first();
  if (await button.count() && await button.isVisible()) await button.click();
}
async function isAcknowledged(page, field) { return page.getByText(`${field} is confirmed inactive for this operation.`, { exact: true }).first().isVisible(); }
async function textField(page, name, value) { const field = page.getByRole('textbox', { name, exact: true }); await field.fill(value); await field.press('Tab'); }
async function pickSource(page, fixture, mask) {
  const image = await publicRead(page, '/api/v1/documents/' + fixture.documentId + '/image');
  const layer = image.layers?.find(item => item.kind === 'image' && item.visible && (!mask || item.mask));
  if (!layer || !opaque(layer.id) || !opaque(layer.assetId) || mask && !opaque(layer.mask.assetId)) throw new PrerequisiteError(mask ? 'WF08 needs an actual visible image layer with retained mask coverage' : 'WF07 needs an actual visible retained image layer');
  const asset = (await publicRead(page, '/api/v1/assets/' + layer.assetId)).projection?.value;
  if (!asset?.raster || asset.qualification !== 'canonical-raster' || asset.raster.role === 'mask' || !HASH.test(asset.raster.pixels?.hash ?? '')) throw new PrerequisiteError('The source fixture must retain canonical raster pixels');
  const tree = page.locator('#layer-tree'), keys = await tree.evaluate(host => host.items.map(item => item.key));
  const index = keys.indexOf(layer.id);
  if (index < 0) throw new PrerequisiteError('Actual source identity is missing from the public layer tree');
  await tree.getByRole('treeitem').nth(index).click();
  return { layer, sourcePixelHash: asset.raster.pixels.hash };
}
async function attachEligible(page, fixture) {
  const library = fixture.adapterLibrary ?? fixture.adapters?.library ?? fixture.adapters;
  const item = library?.eligibleEntries?.find(entry => opaque(entry.versionId) && HASH.test(entry.weights?.hash ?? ''));
  if (!item) throw new PrerequisiteError('WF09 requires an actual locally eligible immutable adapter fixture');
  const actual = await publicRead(page, '/api/v1/adapters/' + item.versionId);
  if (actual.versionId !== item.versionId || actual.available !== true || actual.locallyEligible !== true || actual.weights?.hash !== item.weights.hash) throw new PrerequisiteError('WF09 eligible adapter identity is unavailable or changed');
  const region = page.getByRole('region', { name: 'Local adapter library', exact: true });
  if (!await region.isVisible()) await click(page, 'Adapter library');
  await region.waitFor({ state: 'visible' });
  const remove = region.getByRole('button', { name: /^Remove adapter [123]$/ });
  while (await remove.count()) await remove.last().click();
  await textField(region, 'Search adapter names', actual.name);
  for (const label of ['Filter by declared family', 'Filter by naming format']) await textField(region, label, '');
  for (const label of ['Filter by origin', 'Filter by validation status']) await select(region, label, '');
  await click(region, 'Search local library');
  const card = region.locator('en-card').filter({ hasText: item.versionId });
  for (let pageIndex = 0; await card.count() !== 1; pageIndex++) {
    const next = region.getByRole('button', { name: 'Next adapter page', exact: true });
    if (pageIndex >= 100 || !await next.isEnabled()) throw new PrerequisiteError('Exact eligible adapter is missing from public library pages');
    await next.click();
    await region.getByText(new RegExp('^Adapter library page ' + (pageIndex + 2) + ' ·')).waitFor({ state: 'visible' });
  }
  const attach = card.getByRole('button', { name: 'Attach exact version ' + actual.version, exact: true });
  if (!await attach.isEnabled()) throw new PrerequisiteError('The exact fixture adapter cannot attach through public controls');
  await attach.click(); await numeric(region, 'Scale for adapter 1', 0.5);
  // Replace any old acknowledgement with a different valid selection hash.
  await acknowledge(page, 'adapters'); await numeric(region, 'Scale for adapter 1', 1);
  return { versionId: actual.versionId, weightsHash: actual.weights.hash, scale: 1 };
}

export async function runFastRejection({ page, cell, fixture, controls, signal }) {
  const descriptor = fastRejectionCase(cell);
  if (!opaque(fixture?.documentId) || typeof controls?.read !== 'function') throw new PrerequisiteError('Fast rejection requires a retained document and actual independent emulator counters');
  if (descriptor.field === 'adapters' && !(fixture.adapterLibrary ?? fixture.adapters?.library ?? fixture.adapters)?.eligibleEntries?.length) throw new PrerequisiteError('WF09 requires its real eligible adapter fixture; an unavailable adapter is a different rejection');
  const phases = [], assertions = [], observations = { ...descriptor, inputBoundary: 'runner invocation before public Playwright input', presentationEvidence: 'outer-driver-required', physicalProviderCalls: 0 }, measurements = {};
  const timed = async (name, work) => { signal?.throwIfAborted(); const phase = { name, startMs: monotonic(), outcome: 'running' }; phases.push(phase); try { const value = await work(); phase.outcome = 'completed'; return value; } catch (error) { phase.outcome = 'failed'; throw error; } finally { phase.endMs = monotonic(); phase.durationMs = phase.endMs - phase.startMs; } };
  const beforeJobs = await allJobs(page, signal), beforeEffects = await controls.read(), beforeDocument = (await publicRead(page, '/api/v1/documents/' + fixture.documentId)).projection.value;
  let enqueueCommands = 0;
  const request = value => { if (value.method() === 'POST' && new URL(value.url()).pathname === '/api/v1/commands') { try { if (value.postDataJSON()?.command?.body?.type === 'QueueInference') enqueueCommands++; } catch {} } };
  page.on('request', request);
  try {
    await timed('browser.fast-negative-public-input-setup', async () => {
      await select(page, 'Operation', 'Generate with Fast'); await select(page, 'Request prompt type', 'plain');
      await textField(page, 'Prompt', 'Sealed local Fast rejection request');
      if (['source', 'mask'].includes(descriptor.field)) {
        const source = await pickSource(page, fixture, descriptor.field === 'mask');
        observations.source = { layerId: source.layer.id, pixelHash: source.sourcePixelHash };
        observations.source.receipt = await acceptedCommand(page, 'PrepareRequestSource', () => click(page, 'Capture selected layer contribution'), signal);
        await page.locator('section.request-edits[aria-busy="false"]').waitFor({ state: 'visible' });
        await page.locator('#request-source-status').filter({ hasText: 'Immutable rendered contribution retained.' }).waitFor({ state: 'visible' });
        if (descriptor.field === 'mask') {
          const convert = page.getByRole('button', { name: 'Copy selected layer mask into request mask', exact: true });
          if (!await convert.isVisible()) await click(page, 'Convert an explicit mask source');
          observations.mask = { retainedAssetId: source.layer.mask.assetId, receipt: await acceptedCommand(page, 'PrepareRequestMask', () => convert.click(), signal) };
          await page.locator('section.request-edits[aria-busy="false"]').waitFor({ state: 'visible' });
          await page.getByText('Independent request mask saved. White edits; black keeps. Preview its crop and mapping before approval.', { exact: true }).waitFor({ state: 'visible' });
        }
      }
      if (descriptor.field === 'adapters') observations.adapter = await attachEligible(page, fixture);
      for (const [name, value] of [['Rendering speed', 'BALANCED'], ['Expansion', 'None'], ['Output format', 'png'], ['Request size', 'custom'], ['Acceleration', 'none']]) await select(page, name, value);
      for (const [name, value] of [['Output width', 512], ['Output height', 512], ['Output count', 1]]) await numeric(page, name, value);
      await textField(page, 'Exact seed (empty means Random)', '31');
      await click(page, 'Acknowledge prompt guidance and possible rewriting');
      for (const field of ['source', 'mask', 'adapters', 'strength', 'acceleration']) if (field !== descriptor.field || field === 'acceleration') await acknowledge(page, field);
      if (descriptor.field === 'acceleration') await select(page, 'Acceleration', 'high');
      if (descriptor.field === 'expansion') await select(page, 'Expansion', 'Large');
      if (descriptor.field === 'size') { await numeric(page, 'Output width', 1600); await numeric(page, 'Output height', 900); }
      if (['source', 'mask', 'adapters', 'acceleration'].includes(descriptor.field) && await isAcknowledged(page, descriptor.field)) throw new PrerequisiteError('The actual target input remains explicitly inactive; its rejection cannot be measured');
      await click(page, 'Review current request document');
    });
    await timed('browser.fast-review-input-to-validation-dom', async () => {
      observations.inputMs = monotonic(); await click(page, 'Review exact request');
      await page.waitForFunction(() => !!document.querySelector('#request-errors') || !!document.querySelector('#request-review'));
      observations.validationDomMs = monotonic(); observations.presentedMs = null;
      const items = await page.locator('#request-errors').count() ? await page.locator('#request-errors').evaluate(host => host.items.map(item => ({ target: item.target, message: item.message }))) : [];
      observations.rejection = summarizeFastIssues(items, descriptor);
      assert(observations.rejection.valid, 'The exact Fast field did not receive its sole prescribed rejection');
      await page.locator('#request-errors').getByText(descriptor.code + ': ' + reason(descriptor), { exact: true }).waitFor({ state: 'visible' });
      assert.equal(await page.locator('#request-review').count(), 0, 'Invalid Fast request acquired an immutable review');
      if (descriptor.field === 'acceleration') { assert.equal(await page.getByRole('combobox', { name: 'Acceleration', exact: true }).inputValue(), 'high'); observations.retainedValue = 'high'; }
      if (descriptor.field === 'expansion') { assert.equal(await page.getByRole('combobox', { name: 'Expansion', exact: true }).inputValue(), 'Large'); observations.retainedValue = 'Large'; }
      if (descriptor.field === 'size') {
        const width = await page.getByRole('spinbutton', { name: 'Output width', exact: true }).inputValue(), height = await page.getByRole('spinbutton', { name: 'Output height', exact: true }).inputValue();
        assert.equal(width, '1600'); assert.equal(height, '900'); observations.retainedValue = { width: 1600, height: 900 };
      }
    });
    // This is an explicitly bounded no-effect observation, not a fabricated
    // backend duration or proof that no future unrelated work can submit.
    await timed('browser.fast-rejection-no-effect-observation', () => intervalWait(200, signal));
    observations.effects = verifyNoFastSubmission({ beforeJobs, afterJobs: await allJobs(page, signal), beforeEffects, afterEffects: await controls.read(), enqueueCommands });
    const afterDocument = (await publicRead(page, '/api/v1/documents/' + fixture.documentId)).projection.value;
    assert.equal(afterDocument.revision, beforeDocument.revision); assert.deepEqual(afterDocument.image, beforeDocument.image);
    observations.document = { id: fixture.documentId, revision: afterDocument.revision, unchanged: true };
    Object.assign(measurements, { FastValidationDomMs: observations.validationDomMs - observations.inputMs, FastRejectedFieldCount: 1, FastEnqueueCount: 0, FastSubmissionCount: 0 });
    assertions.push({ name: 'exact independently invalid field has an actionable visible rejection', passed: true }, { name: 'no review, durable queue attempt, emulator submission, or image edit', passed: true });
    return { status: 'PASS', phases, measurements, observations, assertions, missing: [] };
  } catch (error) {
    if (error instanceof PrerequisiteError || signal?.aborted) throw error;
    return { status: 'FAIL', phases, measurements, observations, assertions, missing: [], error: { code: 'FAST_REJECTION_WORKFLOW_FAILED' } };
  } finally { page.off('request', request); }
}
