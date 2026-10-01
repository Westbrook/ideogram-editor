import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { PrerequisiteError } from './common.mjs';

// Verified publisher: https://github.com/GoogleChrome/web-vitals/tree/v6.2.2
// Keep the library, package.json and package-lock.json identities together.
export const canonicalVitalsVersion = '6.2.2';
const metrics = ['LCP', 'CLS', 'INP'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const metricIdentity = /^v6-\d{1,16}-\d{13}$/;
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const integer = value => Number.isSafeInteger(value) && value >= 0;

export async function loadCanonicalVitalsLibrary(repo) {
  let stage = 'subject-manifests';
  try {
    const root = resolve(repo), require = createRequire(join(root, 'package.json'));
    const [subject, lock] = await Promise.all(['package.json', 'package-lock.json'].map(name => readFile(join(root, name), 'utf8').then(JSON.parse)));
    const declared = subject.devDependencies?.['web-vitals'];
    const locked = lock.packages?.['node_modules/web-vitals'];
    if (declared !== canonicalVitalsVersion || locked?.version !== canonicalVitalsVersion || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(locked?.integrity ?? '') || locked?.resolved !== `https://registry.npmjs.org/web-vitals/-/web-vitals-${canonicalVitalsVersion}.tgz`) throw Error('Official exact dependency and lock identities are required');
    stage = 'installed-resolution';
    const entry = require.resolve('web-vitals');
    const packageRoot = dirname(dirname(entry));
    if (await realpath(packageRoot) !== await realpath(join(root, 'node_modules/web-vitals'))) throw Error('Web Vitals must resolve from the subject checkout');
    const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    if (pkg.name !== 'web-vitals' || pkg.version !== canonicalVitalsVersion || pkg.repository?.url !== 'https://github.com/GoogleChrome/web-vitals.git') throw Error('Installed official package identity does not match the pin');
    stage = 'installed-bundle';
    const bytes = await readFile(join(packageRoot, 'dist/web-vitals.iife.js'));
    if (!bytes.length || bytes.length > 1024 * 1024) throw Error('Canonical library size is invalid');
    return { content: bytes.toString('utf8'), library: { name: 'web-vitals', version: pkg.version, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, packageIntegrity: locked.integrity } };
  } catch {
    throw new PrerequisiteError(`Pinned canonical web-vitals ${canonicalVitalsVersion} is unavailable or does not match the subject checkout`, { reason: 'canonical-library-unavailable', stage });
  }
}

// A second whitelist at the process boundary. No entry, attribution, element,
// URL, stack, selector or application text can enter the evidence receipt.
export function safeCanonicalVitalRecord(value) {
  if (!value || !uuid.test(value.documentId ?? '') || !integer(value.visit) || value.visit > 1000 || !integer(value.sequence) || value.sequence > 100000 || !['start', 'metric', 'lifecycle', 'overflow'].includes(value.kind)) return null;
  const result = { kind: value.kind, documentId: value.documentId, visit: value.visit, sequence: value.sequence };
  if (value.kind === 'start') {
    if (!['visible', 'hidden'].includes(value.visibility) || typeof value.restored !== 'boolean') return null;
    return { ...result, visibility: value.visibility, restored: value.restored };
  }
  if (value.kind === 'lifecycle') {
    if (!['hidden', 'visible', 'pagehide'].includes(value.event) || value.trusted !== true || typeof value.persisted !== 'boolean') return null;
    return { ...result, event: value.event, trusted: true, persisted: value.persisted };
  }
  if (value.kind === 'overflow') return result;
  if (!metrics.includes(value.metric) || !metricIdentity.test(value.metricId ?? '') || !finite(value.value) || typeof value.observerSupported !== 'boolean' || !integer(value.interactions)) return null;
  return { ...result, metric: value.metric, metricId: value.metricId, value: value.value, observerSupported: value.observerSupported, interactions: value.interactions };
}

function validateCohort(value, optional = false) {
  if (optional && value == null) return null;
  if (!value || !['cold', 'warm'].includes(value.cache) || typeof value.cohortKey !== 'string' || !/^[A-Za-z0-9._:/-]{1,200}$/.test(value.cohortKey)) throw Error('A bounded cohort key and cold/warm cache identity are required');
  return { cache: value.cache, cohortKey: value.cohortKey };
}

export function createCanonicalVitalsStore({ library, maxVisits = 1000, maxReports = 10000, cohort = null } = {}) {
  if (library?.name !== 'web-vitals' || library.version !== canonicalVitalsVersion || !/^[a-f0-9]{64}$/.test(library.sha256 ?? '')) throw Error('Canonical library identity is required');
  if (!Number.isSafeInteger(maxVisits) || maxVisits < 1 || maxVisits > 1000 || !Number.isSafeInteger(maxReports) || maxReports < 3 || maxReports > 10000) throw Error('Invalid canonical observation limits');
  let currentCohort = validateCohort(cohort, true), rejected = 0, dropped = 0, reports = 0, disabled = false;
  const records = new Map(), currentByPage = new Map();
  const idFor = record => `${record.documentId}:${record.visit}`;
  const api = {
    accept(raw, page) {
      if (disabled) return;
      const record = safeCanonicalVitalRecord(raw);
      if (!record) { rejected++; return; }
      const id = idFor(record); let visit = records.get(id);
      if (!visit && record.kind === 'start') {
        if (records.size >= maxVisits) { dropped++; return; }
        visit = { visitId: id, navigationId: id, visibility: record.visibility, restored: record.restored, lifecycleComplete: false, hiddenObserved: false, overflow: false, sequence: record.sequence, metrics: new Map(), cohort: currentCohort && { ...currentCohort } };
        records.set(id, visit); currentByPage.set(page, id); return;
      }
      if (!visit || record.sequence <= visit.sequence || currentByPage.get(page) !== id) { rejected++; return; }
      visit.sequence = record.sequence;
      if (record.kind === 'overflow') { visit.overflow = true; return; }
      if (record.kind === 'lifecycle') {
        if (record.event === 'hidden') visit.hiddenObserved = true;
        if (record.event === 'visible') visit.hiddenObserved = false;
        // The canonical library drains observers on actual hidden visibility.
        // A pagehide without that boundary cannot prove final metric delivery.
        visit.lifecycleComplete = record.event !== 'visible' && visit.hiddenObserved;
        visit.lastLifecycle = record.event; return;
      }
      if (record.kind !== 'metric') { rejected++; return; }
      if (reports >= maxReports) { visit.overflow = true; return; }
      reports++;
      const previous = visit.metrics.get(record.metric);
      if (previous && previous.metricId !== record.metricId) { visit.overflow = true; rejected++; return; }
      visit.metrics.set(record.metric, record);
    },
    setCohort(value, { page, includeCurrentVisit = false } = {}) {
      const next = validateCohort(value);
      if (includeCurrentVisit) {
        const visit = records.get(currentByPage.get(page));
        if (!visit) throw Error('No observed current visit exists for this page');
        if (visit.cohort && (visit.cohort.cache !== next.cache || visit.cohort.cohortKey !== next.cohortKey)) throw Error('A scored visit cannot be reassigned to another cohort');
        visit.cohort = { ...next };
      }
      currentCohort = next;
      return api.visits();
    },
    visits: () => [...records.values()].map(({ visitId, navigationId, visibility, lifecycleComplete, overflow, restored, cohort: value }) => ({ visitId, navigationId, visibility, lifecycleComplete: lifecycleComplete && !overflow, overflow, restored, ...(value ?? {}) })),
    snapshot({ metric, expectedVisits, cache, cohortKey } = {}) {
      if (metric !== undefined && !metrics.includes(metric)) throw Error('Unknown canonical metric');
      const selectedCohort = validateCohort(cache || cohortKey ? { cache, cohortKey } : currentCohort, true);
      const expected = expectedVisits ?? api.visits().filter(visit => visit.cache === selectedCohort?.cache && visit.cohortKey === selectedCohort?.cohortKey).map(visit => visit.visitId);
      if (!Array.isArray(expected) || expected.length > maxVisits || new Set(expected).size !== expected.length || expected.some(id => typeof id !== 'string' || id.length > 100)) throw Error('Invalid declared visit identities');
      const result = [];
      for (const id of expected) {
        const visit = records.get(id); if (!visit) continue;
        for (const name of metric ? [metric] : metrics) {
          const last = visit.metrics.get(name);
          result.push({ visitId: id, navigationId: visit.navigationId, metricId: last?.metricId ?? '', sequence: visit.sequence, metric: name, finalized: visit.lifecycleComplete && !visit.overflow, observerSupported: last?.observerSupported ?? false, lifecycleComplete: visit.lifecycleComplete && !visit.overflow, visibility: visit.visibility, interactions: last?.interactions ?? 0, value: last?.value ?? null, libraryVersion: library.version, ...(visit.cohort ?? {}) });
        }
      }
      return { kind: 'browser-canonical-visits-1', library: { ...library }, ...(selectedCohort ?? {}), ...(metric ? { metric } : {}), expectedVisits: [...expected], reports: result, rejectedRecords: rejected, droppedVisits: dropped, overflow: dropped > 0 || [...records.values()].some(visit => visit.overflow), definitions: 'Official standard web-vitals bundle; reportAllChanges; hard navigation and BFCache visits; soft navigations disabled; original visibility is retained; unavailable metrics are null.' };
    },
    close() { disabled = true; currentByPage.clear(); },
  };
  return api;
}

// This function is serialized as a Playwright init script, after the unchanged
// official IIFE in the same script. It reports values supplied by that library;
// it does not approximate any LCP, CLS or INP algorithm.
export function canonicalVitalsBrowserCollector({ binding, allowedOrigins, maxReports, maxVisits }) {
  if (globalThis.top !== globalThis || !allowedOrigins.includes(location.origin)) return;
  const library = globalThis.webVitals;
  if (!library || !['onLCP', 'onCLS', 'onINP'].every(name => typeof library[name] === 'function')) return;
  const documentId = crypto.randomUUID();
  let visit = 0, sequence = 0, emitted = 0, stopped = false, interactionBase = Number.isSafeInteger(performance.interactionCount) ? performance.interactionCount : 0;
  const send = record => { void globalThis[binding]({ documentId, visit, sequence: sequence++, ...record }).catch(() => {}); };
  const start = restored => send({ kind: 'start', visibility: document.visibilityState === 'visible' ? 'visible' : 'hidden', restored });
  const supported = type => globalThis.PerformanceObserver?.supportedEntryTypes?.includes(type) === true;
  const observerSupported = { LCP: supported('largest-contentful-paint'), CLS: supported('layout-shift') && supported('paint'), INP: supported('event') && typeof globalThis.PerformanceEventTiming === 'function' && 'interactionId' in globalThis.PerformanceEventTiming.prototype };
  start(false);
  // Register before library callbacks so BFCache values belong to a new visit.
  addEventListener('pageshow', event => {
    if (!event.isTrusted || !event.persisted || stopped) return;
    if (visit + 1 >= maxVisits) { send({ kind: 'overflow' }); stopped = true; return; }
    visit++; sequence = 0; emitted = 0;
    interactionBase = Number.isSafeInteger(performance.interactionCount) ? performance.interactionCount : 0;
    start(true);
  }, true);
  const report = metric => {
    if (stopped || !['LCP', 'CLS', 'INP'].includes(metric.name) || !Number.isFinite(metric.value) || metric.value < 0) return;
    if (emitted >= maxReports) { send({ kind: 'overflow' }); stopped = true; return; }
    emitted++;
    // This count is an eligibility witness, never an alternative INP estimate.
    // Retain only a count, not canonical entries or attribution.
    const count = Number.isSafeInteger(performance.interactionCount) ? Math.max(0, performance.interactionCount - interactionBase) : 0;
    const interactionWitness = metric.name === 'INP' && metric.entries?.some(entry => entry.entryType === 'first-input' || Number.isSafeInteger(entry.interactionId) && entry.interactionId > 0) ? 1 : 0;
    send({ kind: 'metric', metric: metric.name, metricId: metric.id, value: metric.value, observerSupported: observerSupported[metric.name], interactions: Math.max(count, interactionWitness) });
  };
  library.onLCP(report, { reportAllChanges: true, reportSoftNavs: false });
  library.onCLS(report, { reportAllChanges: true, reportSoftNavs: false });
  library.onINP(report, { reportAllChanges: true, reportSoftNavs: false });
  // The library installs its hidden handlers first and drains its own observer
  // records there. Microtasks preserve those callbacks before our lifecycle
  // boundary. Synthetic visibility/pagehide events never finalize a visit.
  addEventListener('visibilitychange', event => {
    if (!event.isTrusted || stopped) return;
    const lifecycle = document.visibilityState === 'hidden' ? 'hidden' : 'visible';
    queueMicrotask(() => { if (!stopped) send({ kind: 'lifecycle', event: lifecycle, trusted: true, persisted: false }); });
  }, true);
  addEventListener('pagehide', event => {
    if (!event.isTrusted || stopped) return;
    queueMicrotask(() => { if (!stopped) send({ kind: 'lifecycle', event: 'pagehide', trusted: true, persisted: event.persisted === true }); });
  }, true);
}

export async function installCanonicalWebVitals(context, { repo, allowedOrigins, cache, cohortKey, maxVisits = 1000, maxReports = 10000 } = {}) {
  if (!Array.isArray(allowedOrigins) || !allowedOrigins.length || allowedOrigins.length > 4 || allowedOrigins.some(origin => { try { return new URL(origin).origin !== origin || !/^https?:$/.test(new URL(origin).protocol); } catch { return true; } })) throw Error('Explicit product origins are required for canonical visits');
  const { content, library } = await loadCanonicalVitalsLibrary(repo);
  const store = createCanonicalVitalsStore({ library, maxVisits, maxReports, cohort: cache || cohortKey ? { cache, cohortKey } : null });
  const binding = '__ieCanonicalWebVitals';
  await context.exposeBinding(binding, (source, record) => { if (!source.frame.parentFrame()) store.accept(record, source.page); });
  const args = { binding, allowedOrigins, maxReports, maxVisits };
  await context.addInitScript({ content: `${content}\n;(${canonicalVitalsBrowserCollector.toString()})(${JSON.stringify(args)});\n` });
  return { ...store, library };
}
