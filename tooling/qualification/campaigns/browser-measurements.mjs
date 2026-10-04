import {reopenFontMeasurement} from './browser-reopen-fonts.mjs';
import {recoveryFontMeasurement} from './browser-text-recovery-fonts.mjs';
import {ORDINARY_COMPOSITION_NAMES, ordinaryCompositionMeasurement} from './browser-ordinary-composition.mjs';
import {navigationWindowServerMeasurement} from './windowserver-navigation-verification.mjs';
import {textResourceMeasurement} from './browser-text-resources.mjs';
import {ordinaryTextMeasurement} from './browser-ordinary-text.mjs';
import { CAMPAIGN_VITALS_SOURCE } from './identity.mjs';
import { rejectedDraftMeasurement } from './browser-queue-measurements.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const cohort = value => typeof value === 'string' && /^[A-Za-z0-9._:/-]{1,200}$/.test(value);
const visitIdentity = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:(?:0|[1-9][0-9]{0,2}|1000)$/.test(value);
const metricIdentity = value => typeof value === 'string' && /^v6-\d{1,16}-\d{13}$/.test(value);
const METRICS = ['LCP', 'CLS', 'INP'];
const VITALS = {
  R01LcpMs: { budgetId: 'R01', metric: 'LCP', unit: 'ms' },
  R02InpMs: { budgetId: 'R02', metric: 'INP', unit: 'ms' },
  R03Cls: { budgetId: 'R03', metric: 'CLS', unit: 'ratio' },
};

function visitSnapshot(cell, sample, visits) {
  if (!cohort(cell?.id) || !['cold', 'warm'].includes(sample?.cache) || sample.ordinal !== undefined && !integer(sample.ordinal)) return { reason: 'Exact cell, cache and sample identities are required for a canonical visit' };
  if (!object(visits) || visits.kind !== 'browser-canonical-visits-1') return { reason: 'Finalized canonical web-vitals snapshot is unavailable; raw browser entries are not substitutes' };
  const library = visits.library;
  if (library?.name !== 'web-vitals' || library.version !== CAMPAIGN_VITALS_SOURCE.version || library.bytes !== CAMPAIGN_VITALS_SOURCE.bytes || library.sha256 !== CAMPAIGN_VITALS_SOURCE.sha256.slice(7) || library.packageIntegrity !== CAMPAIGN_VITALS_SOURCE.integrity) return { reason: 'Canonical library version, bundle bytes, SHA256 and package integrity must match the exact pinned official source' };
  if (visits.cache !== sample.cache || visits.cohortKey !== cell.id) return { reason: 'Canonical snapshot belongs to a different cache or cell cohort' };
  if (visits.overflow !== false || visits.rejectedRecords !== 0 || visits.droppedVisits !== 0) return { reason: 'Canonical observation stream is incomplete, rejected records or overflow were retained' };
  // The runner schedules one page visit per sample. Cohort max/p75 computation
  // belongs to evaluateVisits; pooling visits here could hide missing samples.
  if (!Array.isArray(visits.expectedVisits) || visits.expectedVisits.length !== 1 || !visitIdentity(visits.expectedVisits[0])) return { reason: 'Exactly one declared canonical visit is required for each browser timing sample' };
  if (visits.metric !== undefined && !METRICS.includes(visits.metric)) return { reason: 'Canonical snapshot selected an unknown metric' };
  const expectedMetrics = visits.metric ? [visits.metric] : METRICS;
  if (!Array.isArray(visits.reports) || visits.reports.length !== expectedMetrics.length) return { reason: 'Canonical metric report set is incomplete or duplicated' };
  const reports = new Map(), ids = new Set(), visitId = visits.expectedVisits[0];
  let sequence;
  for (const report of visits.reports) {
    if (!object(report) || !expectedMetrics.includes(report.metric) || reports.has(report.metric)) return { reason: 'Canonical metric report set contains duplicate or foreign metric identities' };
    if (report.visitId !== visitId || report.navigationId !== visitId || report.cohortKey !== cell.id || report.cache !== sample.cache || report.libraryVersion !== library.version) return { reason: 'Canonical report visit, navigation, cache, cohort or library identities are mixed' };
    if (!integer(report.sequence) || report.sequence < 2 || report.sequence > 100000 || sequence !== undefined && sequence !== report.sequence) return { reason: 'Canonical reports lack one exact bounded final lifecycle sequence' };
    sequence = report.sequence;
    if (report.finalized !== true || report.lifecycleComplete !== true || report.visibility !== 'visible') return { reason: 'Canonical visit is not finalized through a complete visible-start lifecycle' };
    if (typeof report.observerSupported !== 'boolean' || !integer(report.interactions) || report.value !== null && !finite(report.value)) return { reason: 'Canonical report support, interaction count or numeric value is invalid' };
    if (report.value === null ? report.metricId !== '' : !metricIdentity(report.metricId) || ids.has(report.metricId)) return { reason: 'Canonical reports lack distinct valid metric identities' };
    if (report.metricId) ids.add(report.metricId);
    if (report.outcome !== undefined && report.outcome !== 'expected' || report.correctnessViolation === true || report.capViolation === true) return { reason: 'Canonical report records an unexpected outcome or correctness violation' };
    reports.set(report.metric, report);
  }
  return {
    reports,
    library: { name: library.name, version: library.version, sha256: library.sha256, bytes: library.bytes, packageIntegrity: library.packageIntegrity },
  };
}

function canonicalMeasurement(cell, sample, rule, parsed) {
  const expected = VITALS[rule.name];
  if (rule.unit !== expected.unit || rule.budgetId !== expected.budgetId) return { reason: 'Canonical measurement registry identity or unit does not match its metric' };
  const operationEligible = expected.metric === 'INP' ? ['interaction.brush', 'text.interaction'].includes(cell.operation) : cell.operation === 'navigation.ready';
  if (!operationEligible) return { reason: 'This operation is not the declared navigation or interaction visit specimen for this canonical metric' };
  if (parsed.reason) return parsed;
  const report = parsed.reports.get(expected.metric);
  if (!report || !finite(report.value) || report.observerSupported !== true) return { reason: 'Requested canonical metric was unavailable or unsupported in the finalized visit' };
  if (expected.metric === 'INP' && report.interactions < 1) return { reason: 'Canonical INP requires at least one observed eligible interaction; load-only visits have no INP value' };
  return { measurement: {
    name: rule.name, value: report.value, unit: expected.unit,
    method: 'Exact finalized ' + expected.metric + ' from the pinned official web-vitals bundle for one scripted page visit; cross-visit statistics remain cohort-owned',
    evidence: [{ kind: 'canonical-web-vital-1', visitId: report.visitId, navigationId: report.navigationId, metricId: report.metricId, sequence: report.sequence, metric: report.metric, cache: report.cache, cohortKey: report.cohortKey, library: { ...parsed.library }, interactions: report.interactions, finalized: true, lifecycleComplete: true, visibility: 'visible', sampleOrdinal: sample.ordinal ?? null }],
  } };
}

function unavailableReason(rule) {
  if (rule.source === 'separate-byte-audit' || rule.source === 'artifact-build' || rule.budgetId === 'D11') return 'This row requires its separate complete verified byte-audit or compiled-build receipt';
  if (rule.name === 'R16MountedRows') return 'Complete mounted-row coverage across every view action is unavailable; one pre-action DOM count is insufficient';
  if (['R35CurrentFontFaces', 'R35SingleFontBytes', 'R35CurrentFontSetBytes'].includes(rule.name)) return 'Complete current-document font face/profile union and deduplicated file-byte identities are unavailable; a matched active-layer font list is diagnostic only';
  if (rule.budgetId === 'R21') return 'Complete exact command/event UTF8 envelopes and inline-binary absence witness are unavailable; generic phase byte fields are insufficient';
  if (rule.unit === 'violations') return 'No complete registry-specific correctness witness establishes this violation count; absence of an observed error is not zero';
  if (['R04', 'R05', 'R07', 'R16'].includes(rule.budgetId)) return 'Exact input/navigation-to-physical-presentation and complete application attribution are unavailable; DOM readiness and renderer trace events are not display paint';
  if (['R17', 'R18', 'R19', 'R35', 'R38'].includes(rule.budgetId)) return 'Complete owned process/resource allocation or lifecycle ledger for this exact registry boundary is unavailable';
  return 'No complete browser observation establishes this exact registry measurement boundary';
}

/** Pure translation, with no browser calls or replacement metric algorithms.
 * Raw phases, renderer traces and partial resource ledgers remain diagnostics.
 * Emit only requested rows with their actual narrow source; never fill gaps
 * with elapsed wall time, a fixture declaration or an invented zero. */
export function extractBrowserMeasurements({ cell, sample = {}, visits, result, evidence, trace, resources, ordinaryTextProof, recoveryFontProof, reopenFontProof, ordinaryCompositionProof, navigationProof, navigationObservation, textResourceProof } = {}) {
  sample = object(sample) ? sample : {};
  const measurements = [], unavailable = [], rules = Array.isArray(cell?.requiredMeasurements) ? cell.requiredMeasurements : [];
  const counts = new Map();
  for (const rule of rules) if (object(rule) && typeof rule.name === 'string') counts.set(rule.name, (counts.get(rule.name) ?? 0) + 1);
  let canonical;
  for (const rule of rules) {
    if (!object(rule) || typeof rule.name !== 'string' || typeof rule.unit !== 'string' || typeof rule.budgetId !== 'string') {
      unavailable.push({ name: null, budgetId: null, unit: null, reason: 'Required registry row is malformed' }); continue;
    }
    if (['cold', 'warm'].includes(sample.cache) && ['cold', 'warm'].includes(rule.cache) && rule.cache !== sample.cache) continue;
    let translated;
    if (rule.cache !== undefined && !['cold', 'warm'].includes(rule.cache)) translated = { reason: 'Required registry row has an invalid cache cohort' };
    else if (counts.get(rule.name) !== 1) translated = { reason: 'Duplicate required registry measurement identities are ambiguous' };
    else if (Object.hasOwn(VITALS, rule.name)) {
      canonical ??= visitSnapshot(cell, sample, visits);
      translated = canonicalMeasurement(cell, sample, rule, canonical);
    } else if (cell?.operation === 'navigation.ready' && ['R05UsableCanvasColdMs', 'R05UsableCanvasWarmMs', 'R04FalsePendingOrCompletionCount'].includes(rule.name)) {
      translated = navigationWindowServerMeasurement({cell, sample, rule, observation: navigationObservation, proof: navigationProof});
    } else if (rule.name === 'R25RejectedDraftLossCount') {
      translated = rule.unit === 'violations' && rule.budgetId === 'R25'
        ? rejectedDraftMeasurement({ cell, proof: result?.observations?.rejectedDraftProof })
        : { reason: 'Rejected draft registry identity or unit is invalid' };
    } else if (['R35CurrentFontFaces', 'R35SingleFontBytes', 'R35CurrentFontSetBytes', 'R35SilentFontSubstitutionCount'].includes(rule.name)) {
      translated = cell?.operation === 'portable.reopen' ? reopenFontMeasurement({cell, sample, rule, proof: reopenFontProof})
        : cell?.operation === 'text.recovery' ? recoveryFontMeasurement({cell, sample, rule, proof: recoveryFontProof}) : ordinaryTextMeasurement({cell, sample, rule, proof: ordinaryTextProof});
    } else if (ORDINARY_COMPOSITION_NAMES.includes(rule.name)) {
      translated = ordinaryCompositionMeasurement({cell, sample, rule, proof: ordinaryCompositionProof});
    } else if (['R35FontShapingCpuBytes', 'R35GlyphGpuBytes'].includes(rule.name)) {
      translated = textResourceMeasurement({cell, sample, rule, proof: textResourceProof});
    } else translated = { reason: unavailableReason(rule) };
    if (translated.measurement) measurements.push(translated.measurement);
    else unavailable.push({ name: rule.name, budgetId: rule.budgetId, unit: rule.unit, ...(rule.source ? { source: rule.source } : {}), reason: translated.reason });
  }
  return { measurements, unavailable };
}
