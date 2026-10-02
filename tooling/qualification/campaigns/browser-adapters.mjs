// Public-control adapter workflows. Browser tracing/resource attribution is
// provided by browser.mjs; DOM observation is never called presented paint.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { publicRead } from './browser-driver.mjs';
import { adapterLifecycleResult, measureAdapterAction, observedAdapterRelease } from './adapter-lifecycle.mjs';
import { retainAdapterCycleMeasurements } from './adapter-measurements.mjs';

const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
const draftFact = asset => ({id: asset.id, purpose: asset.purpose, blob: structuredClone(asset.blob), metadataSha256: 'sha256:' + createHash('sha256').update(canonical(asset)).digest('hex')});
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
  return { metadataEntries: library.entries.length, selectionVersions: (library.eligibleEntries ?? []).map(item => item.versionId), browserTensorBytes: null };
}

export async function resetAdapterBrowserCell(options) { return prepareAdapterBrowserCell(options); }

export async function runAdapterBrowserCell({ page, cell, fixture, backend, signal }) {
  assert.equal(cell.operation, 'adapter.select', 'WA lifecycle requires its prepared persistent lifecycle controller');
  const phases = [], library = libraryFor(fixture, backend), entries = library?.eligibleEntries ?? [];
  if (library?.entries?.length !== 100 || entries.length !== 3) return { status: 'inconclusive', phases, assertions: [], observations: {}, evidence: [], missing: ['The sealed 100-entry library and three genuine eligible selection versions are unavailable.'] };
  const region = await openLibrary(page), selections = [];
  await phase(phases, 'adapter-selection-input-to-authoritative-dom', async span => {
    for (const [index, item] of entries.entries()) {
      signal?.throwIfAborted();
      const card = region.locator('en-card').filter({ has: page.getByRole('heading', { name: item.name, exact: true }) });
      const control = button(card, 'Attach exact version ' + item.version); assert.equal(await control.isEnabled(), true);
      const inputMs = performance.now(); await control.click();
      await button(region, 'Remove adapter ' + (index + 1)).waitFor({ state: 'visible' });
      selections.push({ versionId: item.versionId, hash: item.weights.hash, inputMs, authoritativeDOMObservedMs: performance.now(), presentedMs: null });
    }
    span.selections = selections;
    assert.equal(await region.getByRole('button', { name: /^Remove adapter [123]$/ }).count(), 3);
  });
  return { status: 'pass', phases, assertions: [{ id: 'three-distinct-real-attachments', passed: new Set(entries.map(item => item.versionId)).size === 3, evidence: selections }],
    observations: { metadataEntries: 100, selectedVersions: entries.map(item => item.versionId), selections, actualPresentation: 'requires independent browser trace correlation' }, evidence: [], missing: [] };
}

/** Created once per WA process cohort, prepared before the controller observes
 * B0, and retained through both real cycles and their two fixed idle windows. */
export async function createAdapterBrowserLifecycle({ page, fixture, backend, signal }) {
  const { resolveAdapterCorpus, assertImportedAdapterBinding } = await import('./adapter-corpus.mjs');
  const { createAdapterRetainedOracle } = await import('./adapter-retained-oracle.mjs');
  let corpus = null, oracle = null, baseline = null, profileAuthority = null, sequence = 0;
  const library = libraryFor(fixture, backend);
  async function prepare() {
    if (baseline) return baseline;
    if (!fixture?.documentId || library?.entries?.length !== 100) throw Object.assign(Error('WA needs the sealed full document and real 100-entry library'), { code: 'CAMPAIGN_PREREQUISITE' });
    corpus = await resolveAdapterCorpus(fixture, { signal, requiredBytes: 256 * 1048576 });
    if (backend?.repo) profileAuthority = (await import(pathToFileURL(join(backend.repo, 'dist/local/src/adapters/profile.js')).href)).isSupportedAdapterProfile;
    if (!backend?.closeDocumentConsumers) throw Object.assign(Error('WA requires the actual initial document-consumer close controller'), { code: 'CAMPAIGN_PREREQUISITE' });
    await backend.waObservation?.prepare();
    const initialClose = await backend.closeDocumentConsumers({ page });
    const initialRelease = observedAdapterRelease(initialClose);
    if (initialRelease.releaseMs === null) throw Object.assign(Error(initialRelease.missing.join(' ')), { code: 'CAMPAIGN_PREREQUISITE' });
    oracle = await createAdapterRetainedOracle({ repo: backend.repo, root: backend.root, output: backend.output, fixture, signal });
    baseline = await oracle.baseline();
    if (baseline.status === 'FAIL') throw Error('The sealed WA baseline failed its retained metadata/byte proof');
    return { corpus, baseline, initialClose, initialRelease };
  }
  async function run(cell, { cycle = ++sequence } = {}) {
    assert.equal(cell.operation, 'adapter.lifecycle'); assert(baseline, 'Prepare the complete WA oracle before B0');
    const phases = [], lifecyclePhases = [], missing = [...(corpus?.missing ?? [])], resourceSamples = [], selectedEntries = [];
    const semantic = { fixedArtifactsImported: null, selectionRestored: null, durableFixturePreserved: null, noBrowserTensorDecode: null, zeroUnexpectedFetches: null };
    const metadataSearchName = 'WA lifecycle import ' + randomUUID();
    const specimen = corpus?.specimen, processIdentity = backend.lifecycleIdentity ? JSON.stringify(await backend.lifecycleIdentity()) : null;
    const instrument = async (work, label) => {try {return await work();} catch {missing.push(label); return null;}};
    await instrument(() => backend.waObservation?.beginCycle({cell, cycle, processIdentity, fixtureIdentity: fixture.seal?.sha256, documentId: fixture.documentId, metadataSearchName}), 'H-WA cycle observation could not start.');
    let observationFinished = false;
    try {
    const region = await openLibrary(page);
    let imported = null, binding = null, closure = null, closeWitness = null, releaseMs = null;
    const observations = { cycle, metadataEntries: 100, operations: [], selectedImportedIdentity: null, forcedGC: false };
    const observeResources = async action => { if (backend?.measureResources) resourceSamples.push({ ...await backend.measureResources(), observedMs: performance.now(), action }); };
    observations.selectionBefore = await region.getByRole('button', { name: /^Remove adapter [123]$/ }).count();
    assert.equal(observations.selectionBefore, 0, 'This WA cohort starts with no request attachments');
    await observeResources('before-import');
    if (specimen) {
      const { weights, config, provenance } = specimen, name = metadataSearchName;
      await measureAdapterAction(lifecyclePhases, phases, 'import', () => phase(phases, 'adapter-import-public-controls-to-durable-library-entry', async span => {
        // These same sealed files were fully checked before B0. The production
        // upload hashes them again and the retained oracle verifies its result.
        await region.locator('en-file-upload[label="Adapter weights"] input[type=file]').setInputFiles(weights.path);
        await region.locator('en-file-upload[label="Optional adapter config"] input[type=file]').setInputFiles(config.path);
        if (provenance) await region.locator('en-file-upload[label="Optional adapter provenance"] input[type=file]').setInputFiles(provenance.path);
        await field(region, 'Adapter name', name);
        await field(region, 'Declared model family', specimen.declaredFamily);
        await field(region, 'Declared naming format', specimen.declaredFormat);
        await button(region, 'Review local adapter import').click();
        const review = region.locator('en-card[aria-label="Adapter registration review"]'); await review.waitFor({ state: 'visible' });
        const reviewText = await review.textContent(); assert(reviewText.includes(weights.hash)); assert(reviewText.includes(config.hash));
        if (provenance) assert(reviewText.includes(provenance.hash));
        span.reviewObservedMs = performance.now(); await button(review, 'Register these exact local files').click();
        await region.getByRole('status').filter({ hasText: 'Immutable adapter version registered. Inspect its compatibility status before attachment.' }).waitFor({ state: 'visible' });
        const saved = await publicRead(page, '/api/v1/adapters?search=' + encodeURIComponent(name));
        const matches = saved.items.filter(item => item.name === name); assert.equal(matches.length, 1);
        const view = matches[0], asset = await oracle.readImportedAsset(view.versionId);
        binding = assertImportedAdapterBinding({ asset, view, specimen, isSupportedAdapterProfile: profileAuthority });
        imported = { asset, view, binding }; span.durableVersionId = view.versionId; span.binding = binding.binding;
        semantic.fixedArtifactsImported = true; observations.operations.push('import');
      }));
      missing.push(...binding.missing);
      await instrument(() => backend.waObservation?.afterImport(), 'H-WA import upload settlement is unavailable.');
      await observeResources('after-import');
      if (binding.eligible) {
        const entry = imported.view;
        await field(region, 'Search adapter names', name); await button(region, 'Search local library').click();
        await measureAdapterAction(lifecyclePhases, phases, 'select', () => phase(phases, 'adapter-select-exact-newly-imported-version', async span => {
          // A subordinate read of this exact retained version measures owned
          // verification; its actual metadata request and time belong to select.
          const lookupPath = '/api/v1/adapters/' + encodeURIComponent(entry.versionId);
          await instrument(() => backend.waObservation?.beforeLookup({path: lookupPath, expected: entry}), 'H-WA owned lookup baseline unavailable.');
          const reread = await publicRead(page, lookupPath);
          await instrument(() => backend.waObservation?.afterLookup(reread), 'H-WA owned lookup terminal observation unavailable.');
          assert.deepEqual(reread, entry, 'Repeated owned adapter metadata changed its immutable identity');
          const card = region.locator('en-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
          const control = button(card, 'Attach exact version ' + entry.version); assert.equal(await control.isEnabled(), true);
          span.inputMs = performance.now(); await control.click(); await button(region, 'Remove adapter 1').waitFor({ state: 'visible' });
          assert.equal(await region.getByRole('button', { name: /^Remove adapter [123]$/ }).count(), 1);
          // The selected row is product-rendered immutable version metadata.
          const selectedCard = region.locator('en-card').filter({ has: button(page, 'Remove adapter 1') });
          const selectedText = await selectedCard.textContent();
          assert(selectedText.includes(entry.versionId) && selectedText.includes(entry.weights.hash), 'The attachment row does not display the imported version and weights');
          span.authoritativeDOMObservedMs = performance.now(); span.presentedMs = null; span.selected = entry;
          selectedEntries.push(entry); observations.selectedImportedIdentity = true; observations.operations.push('select');
        }));
        await observeResources('after-select');
        await measureAdapterAction(lifecyclePhases, phases, 'unselect', () => phase(phases, 'adapter-unselect-exact-imported-version', async () => {
          await unselect(region); observations.selectionAfter = await region.getByRole('button', { name: /^Remove adapter [123]$/ }).count();
          assert.equal(observations.selectionAfter, observations.selectionBefore); semantic.selectionRestored = true; observations.operations.push('unselect');
        }));
      } else missing.push('The production profile does not permit this sealed fixed-size import to attach. No other library entry was selected.');
    } else missing.push('No sealed fixed-size WA specimen is available. No fixture was regenerated or substituted.');
    await measureAdapterAction(lifecyclePhases, phases, 'close', () => phase(phases, 'adapter-close-library-and-document-consumers', async span => {
      await button(page, 'Adapter library').click(); await region.waitFor({ state: 'hidden' });
      if (backend?.closeDocumentConsumers) closeWitness = await backend.closeDocumentConsumers({ page });
      else missing.push('The actual same-process document-consumer close observer is unavailable.');
      span.closeWitness = closeWitness; observations.operations.push('close');
    }));
    await measureAdapterAction(lifecyclePhases, phases, 'release', () => phase(phases, 'adapter-observe-current-consumer-release', async span => {
      span.domFileReferences = await page.locator('#request-adapters input[type=file]').evaluateAll(inputs => inputs.reduce((total, input) => total + input.files.length, 0));
      assert.equal(span.domFileReferences, 0);
      const release = observedAdapterRelease(closeWitness); releaseMs = release.releaseMs; missing.push(...release.missing); span.releaseObservation = release;
      span.releaseMs = releaseMs; span.globalHandleCoverage = false; observations.operations.push('release');
    }));
    await observeResources('after-release');
    const draftIds = await instrument(() => backend.waObservation?.draftAssetIds(), 'H-WA actual draft asset lineage is unavailable.') ?? [];
    const draftFacts = [], draftReferences = [];
    for (const id of draftIds) {
      const asset = await instrument(() => oracle.readImportedAsset(id), 'H-WA saved draft metadata is unavailable.');
      if (asset) {
        draftFacts.push(draftFact(asset));
        if (asset.purpose === 'caption' && backend.waObservation?.isRequestDraftAsset(id)) {const references = await instrument(() => oracle.readRequestDraftReferences(id), 'H-WA caption prompt reference is unavailable.'); if (references) draftReferences.push(references);}
      }
    }
    closure = await phase(phases, 'complete-retained-fixture-byte-closure', () => oracle.checkpoint({ importedAssetIds: [...new Set([...(imported ? [imported.asset.id] : []), ...draftIds])] }));
    semantic.durableFixturePreserved = closure.assertions?.durableFixturePreserved ?? null;
    missing.push(...(closure.missing ?? []));
    observations.imported = imported; observations.importedBinding = binding?.binding ?? null; observations.closure = closure; observations.closeWitness = closeWitness; observations.draftFacts = draftFacts; observations.draftReferences = draftReferences;
    const browserWA = await instrument(() => backend.waObservation?.endCycle({cell, imported, specimen, phases: lifecyclePhases, draftFacts, draftReferences, closure}), 'H-WA retained observation is unavailable.');
    observationFinished = true; observations.browserWA = browserWA;
    if (browserWA) {Object.assign(semantic, browserWA.analysis.assertions); missing.push(...browserWA.analysis.missing);}
    const measurements = await retainAdapterCycleMeasurements({ output: backend.output, cell, cycle, processIdentity, fixtureIdentity: fixture.seal?.sha256, specimen, imported, closure, browserWA, phases: lifecyclePhases });
    const answer = adapterLifecycleResult({ phases: lifecyclePhases, childPhases: phases, assertions: semantic, selectedEntries,
      weightsIdentity: specimen?.weights.hash ?? null, configIdentity: specimen?.config.hash ?? null, observations, releaseMs, resourceSamples, missing });
    answer.measurements = measurements; return answer;
    } finally {if (!observationFinished) await instrument(() => backend.waObservation?.abandonCycle(), 'H-WA partial observation retention is unavailable.');}
  }
  return { prepare, run, get weightsIdentity() { return corpus?.specimen?.weights.hash ?? null; }, get configIdentity() { return corpus?.specimen?.config.hash ?? null; }, async finalize() { return oracle ? oracle.completeSeries() : { status: 'INCONCLUSIVE', complete: false, missing: ['WA initial closure oracle was never prepared.'] }; }, async close() { await oracle?.close(); } };
}
