import test from 'node:test';
import assert from 'node:assert/strict';
import { extractBrowserMeasurements } from '../../tooling/qualification/campaigns/browser-measurements.mjs';
import { CAMPAIGN_VITALS_SOURCE } from '../../tooling/qualification/campaigns/identity.mjs';

// Pure translator tests. These fixtures model retained canonical reports; they
// do not run a browser, approximate Web Vitals, or qualify a visit cohort.
const documentId = '12345678-1234-4567-8901-123456789abc';
const visitId = `${documentId}:0`;
const otherVisitId = '87654321-4321-4321-8765-cba987654321:0';
const rules = {
  LCP: { name: 'R01LcpMs', budgetId: 'R01', unit: 'ms' },
  CLS: { name: 'R03Cls', budgetId: 'R03', unit: 'ratio' },
  INP: { name: 'R02InpMs', budgetId: 'R02', unit: 'ms' },
};
const names = ['LCP', 'CLS', 'INP'];
const library = () => ({ name: 'web-vitals', version: CAMPAIGN_VITALS_SOURCE.version,
  sha256: CAMPAIGN_VITALS_SOURCE.sha256.slice(7), bytes: CAMPAIGN_VITALS_SOURCE.bytes,
  packageIntegrity: CAMPAIGN_VITALS_SOURCE.integrity });

function input(metric = 'LCP', options = {}) {
  const cache = options.cache ?? 'cold', cohortKey = 'I3/chromium-W1-navigation';
  return {
    cell: { id: cohortKey, operation: options.operation ?? (metric === 'INP' ? 'interaction.brush' : 'navigation.ready'),
      requiredMeasurements: [{ ...rules[metric] }] },
    sample: { cache, ordinal: 1 },
    visits: { kind: 'browser-canonical-visits-1', library: library(), cache, cohortKey,
      expectedVisits: [visitId], overflow: false, rejectedRecords: 0, droppedVisits: 0,
      reports: names.map((name, index) => ({ visitId, navigationId: visitId,
        metricId: `v6-1700000000000-${1000000000000 + index}`, sequence: 5,
        metric: name, finalized: true, observerSupported: true, lifecycleComplete: true,
        visibility: 'visible', interactions: name === 'INP' ? 2 : 0,
        value: { LCP: 1200, CLS: 0.025, INP: 72 }[name],
        libraryVersion: CAMPAIGN_VITALS_SOURCE.version, cache, cohortKey })) },
  };
}

const report = (value, metric = 'LCP') => value.visits.reports.find(item => item.metric === metric);
function missing(value, rule = value.cell.requiredMeasurements[0]) {
  const output = extractBrowserMeasurements(value);
  assert.deepEqual(output.measurements, []);
  assert.equal(output.unavailable.length, 1);
  assert.deepEqual(Object.keys(output.unavailable[0]).sort(), ['budgetId', 'name', 'reason', 'unit']);
  assert.equal(output.unavailable[0].name, rule.name);
  assert.equal(output.unavailable[0].budgetId, rule.budgetId);
  assert.equal(output.unavailable[0].unit, rule.unit);
  assert.equal(typeof output.unavailable[0].reason, 'string');
  assert(output.unavailable[0].reason.length > 0);
  return output;
}
function observed(value, metric = 'LCP') {
  const output = extractBrowserMeasurements(value);
  assert.deepEqual(output.unavailable, []);
  assert.equal(output.measurements.length, 1);
  const row = output.measurements[0];
  assert.equal(row.name, rules[metric].name);
  assert.equal(row.unit, rules[metric].unit);
  assert.equal(row.value, report(value, metric).value);
  assert.equal(typeof row.method, 'string');
  assert(row.method.trim().length > 0);
  return row;
}

test('absent or non-array requirements never infer measurements from observed data', () => {
  for (const requiredMeasurements of [undefined, null, {}, 'R01LcpMs', []]) {
    const value = input(); value.cell.requiredMeasurements = requiredMeasurements;
    assert.deepEqual(extractBrowserMeasurements(value), { measurements: [], unavailable: [] });
  }
});

for (const metric of names) test(`${metric} emits its requested canonical per-visit value and bounded evidence`, () => {
  const value = input(metric), row = observed(value, metric), source = report(value, metric);
  assert.deepEqual(row.evidence, [{ kind: 'canonical-web-vital-1', visitId, navigationId: visitId,
    metricId: source.metricId, sequence: source.sequence, metric, cache: value.sample.cache,
    cohortKey: value.cell.id, library: library(), interactions: source.interactions,
    finalized: true, lifecycleComplete: true, visibility: 'visible', sampleOrdinal: 1 }]);
});

test('observed zero LCP and CLS values stay zero without inventing absent metrics', () => {
  for (const metric of ['LCP', 'CLS']) {
    const value = input(metric); report(value, metric).value = 0;
    assert.equal(observed(value, metric).value, 0);
    report(value, metric).value = null; report(value, metric).metricId = '';
    missing(value);
  }
});

test('INP accepts both supported interaction operations and needs a real interaction witness', () => {
  for (const operation of ['interaction.brush', 'text.interaction']) {
    const value = input('INP', { operation }); observed(value, 'INP');
    report(value, 'INP').interactions = 0; missing(value);
  }
});

test('matching metric-specific snapshots are valid and cannot supply another metric', () => {
  for (const metric of names) {
    const value = input(metric); value.visits.metric = metric;
    value.visits.reports = [report(value, metric)]; observed(value, metric);
    value.visits.metric = names.find(name => name !== metric); missing(value);
  }
});

test('only requested measurements are emitted and rule cache exclusions are not missing evidence', () => {
  const value = input();
  value.cell.requiredMeasurements = [{ ...rules.LCP, cache: 'cold' }, { ...rules.CLS, cache: 'warm' }];
  assert.deepEqual(extractBrowserMeasurements(value).measurements.map(row => row.name), ['R01LcpMs']);
  assert.deepEqual(extractBrowserMeasurements(value).unavailable, []);
  value.cell.requiredMeasurements = [{ ...rules.LCP, cache: 'warm' }];
  assert.deepEqual(extractBrowserMeasurements(value), { measurements: [], unavailable: [] });
});

test('two requested navigation metrics keep distinct units and original per-visit values', () => {
  const value = input(); value.cell.requiredMeasurements = [{ ...rules.LCP }, { ...rules.CLS }];
  const output = extractBrowserMeasurements(value);
  assert.deepEqual(output.unavailable, []);
  assert.deepEqual(output.measurements.map(({ name, value, unit }) => ({ name, value, unit })),
    [{ name: 'R01LcpMs', value: 1200, unit: 'ms' }, { name: 'R03Cls', value: 0.025, unit: 'ratio' }]);
});

test('incompatible registry budget or unit cannot relabel a canonical value', () => {
  for (const metric of names) for (const patch of [{ budgetId: 'R99' }, { unit: 'count' }]) {
    const value = input(metric); Object.assign(value.cell.requiredMeasurements[0], patch); missing(value);
  }
});

test('canonical observations from another operation cannot satisfy a requested metric', () => {
  for (const [metric, operation] of [['LCP', 'portable.reopen'], ['CLS', 'interaction.brush'],
    ['INP', 'navigation.ready'], ['LCP', 'text.mixed-ready'], ['INP', 'interaction.first-use']]) {
    missing(input(metric, { operation }));
  }
});

test('only exact pinned canonical source identity qualifies', () => {
  for (const patch of [{ name: 'custom-vitals' }, { version: '6.2.3' }, { bytes: 8992 },
    { sha256: 'a'.repeat(64) }, { sha256: CAMPAIGN_VITALS_SOURCE.sha256 },
    { packageIntegrity: 'sha512-' + 'a'.repeat(86) + '==' }]) {
    const value = input(); Object.assign(value.visits.library, patch); missing(value);
  }
  for (const field of ['name', 'version', 'sha256', 'bytes', 'packageIntegrity']) {
    const value = input(); delete value.visits.library[field]; missing(value);
  }
});

test('snapshot ownership and complete collection metadata must agree with the sample', () => {
  for (const patch of [{ kind: 'browser-raw-visits-1' }, { cache: 'warm' }, { cohortKey: 'I3/foreign' },
    { overflow: true }, { overflow: undefined }, { droppedVisits: 1 }, { droppedVisits: undefined },
    { rejectedRecords: 1 }, { rejectedRecords: undefined }]) {
    const value = input(); Object.assign(value.visits, patch); missing(value);
  }
});

test('sample identity requires an exact cold or warm cohort and bounded cell identity', () => {
  for (const cache of ['single', 'Cold', '', undefined]) {
    const value = input(); value.sample.cache = cache; missing(value);
  }
  for (const id of ['', 'private content with spaces', 'x'.repeat(201), undefined]) {
    const value = input(); value.cell.id = id; missing(value);
  }
});

test('optional sample ordinal is retained as null while invalid ordinals cannot qualify', () => {
  const without = input(); delete without.sample.ordinal;
  assert.equal(observed(without).evidence[0].sampleOrdinal, null);
  for (const ordinal of [0, 2, Number.MAX_SAFE_INTEGER]) {
    const value = input(); value.sample.ordinal = ordinal;
    assert.equal(observed(value).evidence[0].sampleOrdinal, ordinal);
  }
  for (const ordinal of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '1']) {
    const value = input(); value.sample.ordinal = ordinal; missing(value);
  }
});

test('a sample requires one declared canonical UUID visit and never combines visits into a percentile', () => {
  for (const expectedVisits of [[], [visitId, visitId], [visitId, otherVisitId], [otherVisitId],
    ['private-visit'], [`${documentId}:1001`], [documentId.replace('-4567-', '-5567-') + ':0']]) {
    const value = input(); value.visits.expectedVisits = expectedVisits; missing(value);
  }
  const multiple = input(); multiple.visits.expectedVisits.push(otherVisitId);
  multiple.visits.reports.push(...multiple.visits.reports.map(row => ({ ...row, visitId: otherVisitId,
    navigationId: otherVisitId, metricId: row.metricId.replace('1700000000000', '1700000000001'), value: 0 })));
  missing(multiple);
});

test('snapshot visit index accepts actual BFCache visit identities within its bound', () => {
  for (const index of [1, 1000]) {
    const value = input(), id = `${documentId}:${index}`; value.visits.expectedVisits = [id];
    for (const row of value.visits.reports) row.visitId = row.navigationId = id;
    assert.equal(observed(value).evidence[0].visitId, id);
  }
});

test('snapshot reports reject omissions, duplicate metrics, foreign metrics and undeclared visits', () => {
  for (const change of [value => value.visits.reports.pop(),
    value => value.visits.reports.push({ ...report(value) }),
    value => { value.visits.reports[1] = { ...report(value) }; },
    value => { report(value).metric = 'FCP'; },
    value => { report(value).visitId = otherVisitId; },
    value => { value.visits.metric = 'FCP'; }]) {
    const value = input(); change(value); missing(value);
  }
});

test('every report in the retained snapshot must belong to the exact finalized visit', () => {
  for (const patch of [{ navigationId: otherVisitId }, { cohortKey: 'I3/foreign' }, { cache: 'warm' },
    { libraryVersion: '6.2.3' }, { finalized: false }, { lifecycleComplete: false }, { visibility: 'hidden' },
    { sequence: 1 }, { sequence: 6 }, { sequence: 100001 }, { sequence: 2.5 }, { sequence: NaN }]) {
    const value = input(); Object.assign(report(value, 'CLS'), patch); missing(value);
  }
});

test('nonselected reports still need coherent typed metric fields', () => {
  for (const patch of [{ observerSupported: 'true' }, { interactions: -1 }, { interactions: 0.5 },
    { interactions: Number.MAX_SAFE_INTEGER + 1 }, { value: '0' }, { value: -1 }, { value: Infinity },
    { value: Number.MAX_SAFE_INTEGER + 1 }, { metricId: '' }, { metricId: 'private-selector' }]) {
    const value = input(); Object.assign(report(value, 'CLS'), patch); missing(value);
  }
});

test('reused canonical metric identities and recorded correctness failures cannot qualify', () => {
  for (const change of [value => { report(value, 'CLS').metricId = report(value).metricId; },
    value => { report(value, 'CLS').outcome = 'unexpected-error'; },
    value => { report(value, 'CLS').correctnessViolation = true; },
    value => { report(value, 'CLS').capViolation = true; }]) {
    const value = input(); change(value); missing(value);
  }
});

test('well-formed unavailable nonselected metrics do not erase an observed requested value', () => {
  const value = input(); Object.assign(report(value, 'INP'), { value: null, metricId: '', observerSupported: false, interactions: 0 });
  observed(value);
});

test('selected metric needs support and a finite observed value without coercion', () => {
  for (const metric of names) for (const patch of [{ observerSupported: false }, { value: null, metricId: '' },
    { value: undefined }, { value: NaN }, { value: Infinity }, { value: -1 }, { value: '72' }]) {
    const value = input(metric); Object.assign(report(value, metric), patch); missing(value);
  }
});

test('unsupported registry counts and timings remain explicitly unavailable', () => {
  const value = input();
  value.cell.operation = 'layers.large-list';
  value.cell.requiredMeasurements = [{ name: 'R16MountedRows', budgetId: 'R16', unit: 'count' },
    { name: 'R16CompletedViewMs', budgetId: 'R16', unit: 'ms' },
    { name: 'R04FalsePendingOrCompletionCount', budgetId: 'R04', unit: 'violations' }];
  value.result = { mountedRows: 60, metadataRows: 1000, originalStackRestored: true,
    observations: { mountedRows: 60 }, measurements: { R16MountedRows: 60, R04FalsePendingOrCompletionCount: 0 } };
  const output = extractBrowserMeasurements(value);
  assert.deepEqual(output.measurements, []);
  assert.deepEqual(output.unavailable.map(({ name, budgetId, unit }) => ({ name, budgetId, unit })), value.cell.requiredMeasurements);
  assert(output.unavailable.every(row => typeof row.reason === 'string' && row.reason.length > 0));
});

test('raw timings, trace events, resource numbers and existing scalar claims never replace canonical visits', () => {
  const value = input(); delete value.visits;
  value.result = { elapsedMs: 12, measurements: { R01LcpMs: 0 }, observations: { LCP: 0 } };
  value.evidence = { rawVisits: { LCP: 0 }, productPhases: { durationMs: 0 } };
  value.trace = { paint: 0, largestContentfulPaint: 0, complete: true };
  value.resources = { R01LcpMs: 0 };
  missing(value);
});

test('duplicate and malformed registry rows stay unavailable instead of producing ambiguous measurements', () => {
  const value = input(); value.cell.requiredMeasurements.push({ ...rules.LCP });
  const duplicate = extractBrowserMeasurements(value);
  assert.deepEqual(duplicate.measurements, []);
  assert.equal(duplicate.unavailable.length, 2);
  assert(duplicate.unavailable.every(row => row.name === 'R01LcpMs' && /duplicate/i.test(row.reason)));
  for (const invalid of [null, [], {}, { name: 'R01LcpMs', unit: 'ms' }]) {
    value.cell.requiredMeasurements = [invalid];
    const output = extractBrowserMeasurements(value);
    assert.deepEqual(output.measurements, []);
    assert.equal(output.unavailable.length, 1);
    assert.deepEqual({ ...output.unavailable[0], reason: undefined },
      { name: null, budgetId: null, unit: null, reason: undefined });
    assert.match(output.unavailable[0].reason, /malformed/i);
  }
  assert.deepEqual(extractBrowserMeasurements(), { measurements: [], unavailable: [] });
});

test('separate byte-audit requirements retain their source and cannot borrow timing observations', () => {
  const value = input();
  const rule = { name: 'D11StartupJsGzipBytes', budgetId: 'D11', unit: 'bytes', source: 'separate-byte-audit' };
  value.cell.requiredMeasurements = [rule]; value.result = { measurements: { [rule.name]: 42 } };
  const output = extractBrowserMeasurements(value);
  assert.deepEqual(output.measurements, []);
  assert.deepEqual(output.unavailable.map(({ reason, ...row }) => row), [rule]);
  assert.match(output.unavailable[0].reason, /separate|byte-audit/i);
});

test('emitted evidence excludes arbitrary browser contents and does not retain mutable source objects', () => {
  const value = input(), privateText = 'PRIVATE https://secret.test #private-selector';
  value.visits.definitions = privateText; value.visits.extra = privateText;
  value.visits.library.url = privateText; report(value).entries = [{ target: privateText }];
  report(value).attribution = { selector: privateText };
  value.result = { prompt: privateText }; value.evidence = { raw: privateText };
  const row = observed(value);
  assert(!JSON.stringify(row).includes(privateText));
  assert.deepEqual(Object.keys(row.evidence[0].library).sort(), Object.keys(library()).sort());
  value.visits.library.sha256 = 'a'.repeat(64); report(value).value = 0;
  assert.equal(row.value, 1200); assert.deepEqual(row.evidence[0].library, library());
});

test('translator does not mutate frozen inputs and returns independent measurement receipts', () => {
  const freeze = value => {
    if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
    return value;
  };
  const value = freeze(input()), first = observed(value), second = observed(value);
  assert.deepEqual(first, second);
  first.evidence[0].library.sha256 = 'b'.repeat(64);
  assert.equal(second.evidence[0].library.sha256, CAMPAIGN_VITALS_SOURCE.sha256.slice(7));
});

const fontRules = [
  { name: 'R35CurrentFontFaces', budgetId: 'R35', unit: 'count' },
  { name: 'R35SingleFontBytes', budgetId: 'R35', unit: 'bytes' },
  { name: 'R35CurrentFontSetBytes', budgetId: 'R35', unit: 'bytes' },
];
const sha = character => 'sha256:' + character.repeat(64);
function fontInput() {
  return {
    cell: { id: 'H10/WXn-mixed-ready', operation: 'text.mixed-ready', requiredMeasurements: fontRules.map(row => ({ ...row })) },
    sample: { cache: 'warm', ordinal: 1 },
    result: { status: 'INCONCLUSIVE', observations: { operation: 'text.mixed-ready',
      corpus: { sha256: sha('a'), manifestHash: sha('b'), bytes: 24 },
      fonts: [{ idHash: sha('1'), sha256: sha('2'), bytes: 1024 }, { idHash: sha('3'), sha256: sha('4'), bytes: 2048 }],
      retainedText: { layerVersion: '17', textHash: sha('a'), layoutHash: sha('5'), pixelHash: sha('6'), rendererHash: sha('7'),
        fonts: [{ sha256: sha('2'), bytes: 1024, licenseSha256: sha('8') }, { sha256: sha('4'), bytes: 2048, licenseSha256: sha('9') }] } },
      missing: ['Navigation-scoped all-text layout completion is unobserved'] },
  };
}

test('matching sealed active-layer fonts cannot establish complete document-wide R35 counts or bytes', () => {
  const value = fontInput();
  for (const status of ['PASS', 'INCONCLUSIVE']) {
    value.result.status = status;
    const output = extractBrowserMeasurements(value);
    assert.deepEqual(output.measurements, []);
    assert.deepEqual(output.unavailable.map(({ name, budgetId, unit }) => ({ name, budgetId, unit })), fontRules);
    assert.deepEqual(output.unavailable.map(row => row.reason), fontRules.map(() => 'Current owned ordinary-text observation proof unavailable'));
  }
});
