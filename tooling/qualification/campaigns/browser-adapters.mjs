// Public-control adapter workflows. Browser tracing/resource attribution is
// provided by browser.mjs; DOM observation is never called presented paint.
import assert from 'node:assert/strict';
import { hashAdapterFile } from './adapters.mjs';
import { publicRead } from './browser-driver.mjs';
import { adapterLifecycleResult, measureAdapterAction } from './adapter-lifecycle.mjs';

const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const field = async (scope, name, value) => { const control = scope.getByRole('textbox', { name, exact: true }); await control.fill(value); await control.press('Tab'); };
const libraryFor = (fixture, backend) => backend?.adapterLibrary ?? fixture?.adapterLibrary ?? fixture?.adapters?.library ?? fixture?.adapters;
async function phase(phases, name, action) {
  const span = { name, startMs: performance.now(), outcome: 'incomplete' }; phases.push(span);
  try { const value = await action(span); span.outcome = 'expected'; return value; }
  catch (error) { span.outcome = 'failed'; span.error = { message: error.message, code: error.code ?? null }; throw error; }
  finally { span.endMs = performance.now(); span.durationMs = span.endMs - span.startMs; }
}
async function openLibrary(page) {
  const region = page.getByRole('region', { name: 'Local adapter library', exact: true });
  if (!await region.isVisible()) await button(page, 'Adapter library').click();
  await region.waitFor({ state: 'visible' }); return region;
}
async function unselect(region) {
  const remove = region.getByRole('button', { name: /^Remove adapter [123]$/ });
  while (await remove.count()) await remove.last().click();
}

export async function prepareAdapterBrowserCell({ page, fixture, backend }) {
  const library = libraryFor(fixture, backend), region = await openLibrary(page);
  if (!library?.entries || library.entries.length !== 100) throw Object.assign(Error('WA requires the real immutable 100-entry library fixture'), { code: 'CAMPAIGN_PREREQUISITE' });
  await unselect(region); await field(region, 'Search adapter names', 'WA eligible selection'); await button(region, 'Search local library').click();
  for (const item of library.eligibleEntries ?? []) await region.getByRole('heading', { name: item.name, exact: true }).waitFor({ state: 'visible' });
  return { metadataEntries: library.entries.length, selectionVersions: (library.eligibleEntries ?? []).map(item => item.versionId), browserTensorBytes: 0 };
}

export async function resetAdapterBrowserCell(options) { return prepareAdapterBrowserCell(options); }

export async function runAdapterBrowserCell({ page, cell, fixture, backend, signal }) {
  const phases = [], lifecyclePhases = [], assertions = [], missing = [], library = libraryFor(fixture, backend), op = cell.operation;
  const semantic = { fixedArtifactsImported: null, selectionRestored: null, durableFixturePreserved: null, noBrowserTensorDecode: null, zeroUnexpectedFetches: null };
  let weightsIdentity = null, configIdentity = null, closeWitness = null, releaseMs = null;
  if (!library?.entries || library.entries.length !== 100) throw Object.assign(Error('WA library fixture is missing'), { code: 'CAMPAIGN_PREREQUISITE' });
  if (!['adapter.select', 'adapter.lifecycle'].includes(op)) throw Error('Unsupported browser adapter workflow: ' + op);
  let region = await openLibrary(page); const entries = library.eligibleEntries ?? [];
  if (entries.length !== 3) return { status: 'inconclusive', phases, assertions, observations: { metadataEntries: 100 }, evidence: [], missing: ['Three locally eligible immutable versions are required for real selection. No synthetic eligibility is substituted.'] };
  const operations = [], observations = { metadataEntries: 100, selectedVersions: entries.map(item => item.versionId), operations, tensorBytesReadByHarness: 0, actualPresentation: 'requires independent browser trace correlation' };
  if (op === 'adapter.lifecycle') {
    observations.selectionBefore = await region.getByRole('button', { name: /^Remove adapter [123]$/ }).count();
    assert.equal(observations.selectionBefore, 0, 'This isolated WA cohort starts with no request attachments');
    const weights = library.fixtureManifest?.weights.find(item => item.bytes === 256 * 1048576), config = library.fixtureManifest?.config;
    if (!weights || !config) throw Object.assign(Error('WA lifecycle needs its exact 256 MiB weights and config fixture'), { code: 'CAMPAIGN_PREREQUISITE' });
    signal?.throwIfAborted();
    // Identities are checked before input dispatch, outside the import phase.
    assert.equal((await hashAdapterFile(weights.path, signal)).hash, weights.hash); assert.equal((await hashAdapterFile(config.path, signal)).hash, config.hash);
    weightsIdentity = weights.hash; configIdentity = config.hash;
    await measureAdapterAction(lifecyclePhases, phases, 'import', () => phase(phases, 'adapter-import-public-controls-to-durable-library-entry', async span => {
      await region.locator('en-file-upload[label="Adapter weights"] input[type=file]').setInputFiles(weights.path);
      await region.locator('en-file-upload[label="Optional adapter config"] input[type=file]').setInputFiles(config.path);
      await field(region, 'Adapter name', 'WA lifecycle local import');
      await button(region, 'Review local adapter import').click();
      const review = region.locator('en-card[aria-label="Adapter registration review"]'); await review.waitFor({ state: 'visible' });
      assert((await review.textContent()).includes(weights.hash)); assert((await review.textContent()).includes(config.hash)); span.reviewObservedMs = performance.now();
      await button(review, 'Register these exact local files').click();
      await region.getByRole('status').filter({ hasText: 'Immutable adapter version registered. Inspect its compatibility status before attachment.' }).waitFor({ state: 'visible' });
      const saved = await publicRead(page, '/api/v1/adapters?search=WA%20lifecycle%20local%20import');
      assert(saved.items.some(item => item.weights.hash === weights.hash && item.config?.hash === config.hash && item.locallyEligible === false));
      span.durableVersions = saved.items.map(item => item.versionId); operations.push('import'); semantic.fixedArtifactsImported = true;
    }));
    await field(region, 'Search adapter names', 'WA eligible selection'); await button(region, 'Search local library').click();
    // Explicitly retain this mismatch. Making generated weights eligible merely
    // to obtain a passing lifecycle receipt would change the product boundary.
    missing.push('The synthetic imported 256 MiB identity cannot attach. Selection below uses the separately sealed eligible 85,299,896-byte reference versions, so same-import WA lifecycle remains unqualified.');
  }
  const select = () => phase(phases, 'adapter-selection-input-to-authoritative-dom', async span => {
    for (let index = 0; index < entries.length; index++) {
      signal?.throwIfAborted(); const item = entries[index], card = region.locator('en-card').filter({ has: page.getByRole('heading', { name: item.name, exact: true }) });
      const control = button(card, 'Attach exact version ' + item.version); assert.equal(await control.isEnabled(), true);
      const inputMs = performance.now(); await control.click();
      await button(region, 'Remove adapter ' + (index + 1)).waitFor({ state: 'visible' });
      span.selections ??= []; span.selections.push({ versionId: item.versionId, hash: item.weights.hash, inputMs, authoritativeDOMObservedMs: performance.now(), presentedMs: null });
    }
    assert.equal(await region.getByRole('button', { name: /^Remove adapter [123]$/ }).count(), 3); operations.push('select');
  });
  if (op === 'adapter.lifecycle') await measureAdapterAction(lifecyclePhases, phases, 'select', select);
  else await select();
  assertions.push({ id: 'three-distinct-real-attachments', passed: new Set(entries.map(item => item.versionId)).size === 3, evidence: observations.selectedVersions });
  if (op === 'adapter.lifecycle') {
    await measureAdapterAction(lifecyclePhases, phases, 'unselect', () => phase(phases, 'adapter-unselect-public-controls', async () => { await unselect(region); observations.selectionAfter = await region.getByRole('button', { name: /^Remove adapter [123]$/ }).count(); assert.equal(observations.selectionAfter, observations.selectionBefore); operations.push('unselect'); semantic.selectionRestored = true; }));
    await measureAdapterAction(lifecyclePhases, phases, 'close', () => phase(phases, 'adapter-close-library-and-document-consumers', async span => {
      await button(page, 'Adapter library').click(); await region.waitFor({ state: 'hidden' }); operations.push('close-library');
      if (backend?.closeDocumentConsumers) { closeWitness = await backend.closeDocumentConsumers({ page }); operations.push('close-document'); }
      else missing.push('A verified same-process document-consumer close controller is unavailable.');
      span.documentConsumerRelease = !!closeWitness; span.closeWitness = closeWitness;
    }));
    await measureAdapterAction(lifecyclePhases, phases, 'release', () => phase(phases, 'adapter-release-input-file-consumers', async span => {
      const fileInputs = page.locator('#request-adapters input[type=file]');
      span.domFileReferences = await fileInputs.evaluateAll(inputs => inputs.reduce((total, input) => total + input.files.length, 0));
      assert.equal(span.domFileReferences, 0); operations.push('release');
      span.observation = 'Standard DOM file-list references only; attributable process-tree RSS and worker/resource handles are observed separately by the controller.';
      const lifecycle = closeWitness?.lifecycle;
      if (lifecycle && lifecycle.releasing === false && Number.isFinite(lifecycle.lastReleaseMilliseconds) && lifecycle.lastReleaseMilliseconds >= 0) {
        const consumers = lifecycle.consumers;
        if (consumers && typeof consumers === 'object' && Object.keys(consumers).length > 0) {
          for (const counters of Object.values(consumers)) for (const value of Object.values(counters)) assert(value === 0 || value === false, 'Document consumer retained resources after close');
          releaseMs = lifecycle.lastReleaseMilliseconds;
        }
      }
    }));
    observations.selectedImportedIdentity = false; observations.closeWitness = closeWitness;
    return adapterLifecycleResult({ phases: lifecyclePhases, childPhases: phases, assertions: semantic, selectedEntries: entries, weightsIdentity, configIdentity, observations, releaseMs, missing });
  }
  return { status: missing.length ? 'inconclusive' : 'pass', phases, assertions, observations, evidence: [], missing };
}
