import {isDeepStrictEqual} from 'node:util';
import {validateCiPlan, digest} from './plan.mjs';
import {makeCampaignPlan} from '../campaigns/inventory.mjs';
import {digest as campaignDigest} from '../campaigns/common.mjs';
import {summarize} from '../campaigns/run.mjs';
import {deriveLifecycleMeasurements, evaluateSession, evaluateVisits} from '../campaigns/metrics.mjs';
import {observeD11Build} from '../developer-campaigns/commands.mjs';
import {evaluateRegression, nearestRank} from '../statistics.mjs';

const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const same = isDeepStrictEqual;
const metric = (result, name) => Array.isArray(result?.measurements)
  ? result.measurements.filter(value => value.name === name).length === 1 ? result.measurements.find(value => value.name === name) : null
  : result?.measurements?.[name];
const successful = attempt => attempt.status === 'PASS' && attempt.result?.status !== 'FAIL' && !attempt.timedOut && !attempt.censor;
const visitMetrics = {R01LcpMs: 'LCP', R02InpMs: 'INP', R03Cls: 'CLS'};
const sessionMetrics = {
  R07FrameWorkP95Ms: session => session.frameSegments.length ? Math.max(...session.frameSegments.map(segment => segment.work.p95)) : null,
  R07FrameWorkMaxMs: session => session.frameWork.max,
  R07PointerPaintP95Ms: session => session.pointer.p95,
  R07DroppedSlotShare: session => session.droppedShare60SecondSession,
};
const kindFor = rule => rule.name === 'R03Cls' ? 'cls' : rule.name === 'R07DroppedSlotShare' ? 'dropped-frame-share'
  : rule.unit === 'ms' ? 'timing' : ['bytes', 'bytes/minute'].includes(rule.unit) ? /Rss|Allocation|Cache|Workspace|Buffer|Cpu|Gpu|SettledGrowth/.test(rule.name) ? 'peak-memory' : 'bytes' : null;
const phaseBudget = name => {
  const key = name.replace(/^developer\.command\./, '');
  if (/^install-/.test(key)) return 'D01';
  if (/^browser-(?:cold|warm)$/.test(key)) return 'D02';
  if (key === 'cold-build') return 'D03';
  if (key === 'full-types' || /^(?:public-leaf|domain-type)-(?:types|build)$/.test(key)) return 'D04';
  if (/^focused-/.test(key)) return 'D06';
  if (/^full-/.test(key)) return 'D07';
  if (/^developer\.archive\./.test(name)) return 'D09';
  return null;
};
function developerPhases(cell, cache) {
  if (cell.operation === 'developer.archive-update') return ['sourceInstall','producer','upgrade','resetAndReceipt','wholeRun'].map(name => `developer.archive.${name}`);
  const command = cell.parameters?.command;
  const names = cell.operation === 'developer.command-group' && Array.isArray(cell.parameters?.commands)
    ? [`install-${cache}`, `browser-${cache}`, 'full-types', 'cold-build', 'public-leaf-types', 'public-leaf-build', 'domain-type-types', 'domain-type-build',
      'focused-unit', 'full-unit', 'focused-integration', 'full-integration', 'focused-browser', 'full-browser']
    : command === 'clean-install' ? [`install-${cache}`]
      : command === 'production-build' ? ['cold-build']
        : command === 'incremental-edit-scope' ? [`${cell.parameters.editScope}-types`, `${cell.parameters.editScope}-build`]
          : ['browser-provision', 'browser-verify'].includes(command) ? [`browser-${cache}`]
            : command && phaseBudget(`developer.command.${command}`) ? [command] : [];
  return names.map(name => `developer.command.${name}`);
}

/** Exported for focused arithmetic tests. Inputs are actual raw starts and the
 * canonical cell, not a caller-provided percentile or a success-only summary.
 * Filesystem/journal authenticity belongs to verifyCampaignReceipt upstream. */
export function collectCellRows(cell, cache, attempts, campaign, {byteAuditAttempts = null} = {}) {
  const missing = [], failures = [], rows = [];
  const required = cache === 'single' ? 1 : cell[cache];
  const samples = attempts.filter(attempt => !attempt.prime && attempt.cache === cache);
  const primes = attempts.filter(attempt => attempt.prime && attempt.cache === cache);
  const expectedPrimes = cache === 'warm' ? cell.primes : 0;
  if (!Number.isSafeInteger(required) || required < 1 || samples.length !== required ||
      new Set(samples.map(attempt => attempt.id)).size !== required ||
      samples.some(attempt => !Number.isSafeInteger(attempt.ordinal) || attempt.ordinal < 1 || attempt.ordinal > required) ||
      new Set(samples.map(attempt => attempt.ordinal)).size !== required || primes.length !== expectedPrimes ||
      new Set(primes.map(attempt => attempt.ordinal)).size !== expectedPrimes ||
      primes.some(attempt => attempt.ordinal < 1 || attempt.ordinal > expectedPrimes)) missing.push('Exact scored/prime cache inventory unavailable');
  if (attempts.some(attempt => attempt.status === 'FAIL' || attempt.result?.status === 'FAIL' || attempt.timedOut || attempt.censor?.reason === 'interrupted')) failures.push('App failure, timeout or interruption retained');
  if (attempts.some(attempt => !successful(attempt))) missing.push('Every required start must have its expected completed outcome');
  const firstScored = attempts.findIndex(attempt => !attempt.prime);
  if (firstScored >= 0 && attempts.slice(firstScored).some(attempt => attempt.prime)) missing.push('Warm prime occurred after scored work');
  const fullD = campaign === 'Q3' && ['I1/command-groups', 'I2/archive-update'].includes(cell.id);
  function row(name, budgetId, kind, values, {statistic = fullD && budgetId?.startsWith('D') ? 'p50' : 'max', methods = [], issue = null, starts = samples} = {}) {
    if (new Set(methods).size > 1) issue ??= 'Measurement method changed inside the cache cohort';
    const complete = !missing.length && !failures.length && !issue && values.length === required && values.every(finite);
    const value = complete ? nearestRank(values, statistic === 'p50' ? .5 : statistic === 'p75' ? .75 : 1) : null;
    rows.push({cellId: cell.id, operation: cell.operation, workload: cell.workload, cache, name, budgetId, kind, statistic,
      value, complete, raw: starts.map((attempt, index) => ({attemptId: attempt.id, ...(attempt.auditGroupId ? {auditGroupId: attempt.auditGroupId} : {}), ordinal: attempt.ordinal, value: values[index] ?? null})),
      methods: [...new Set(methods)].sort(), missing: [...missing, ...(issue ? [issue] : [])], failures: [...failures]});
  }
  for (const rule of cell.phaseBudgets ?? cell.requirements?.phaseBudgets ?? []) {
    let issue = null;
    const values = samples.map(attempt => {
      const phases = attempt.result?.phases?.filter(phase => phase.name === rule.phase) ?? [];
      if (!phases.length || phases.length !== 1 && rule.aggregation !== 'maximum' || phases.some(phase => !finite(phase.durationMs ?? phase.elapsedMs))) {
        issue = 'Required phase boundary missing or ambiguous'; return null;
      }
      return Math.max(...phases.map(phase => phase.durationMs ?? phase.elapsedMs));
    });
    row(`phase:${rule.phase}`, rule.id, 'timing', values, {issue});
  }
  // D command cells own several independent row clocks inside one start. Their
  // setup, restores and primes are retained overhead, never scored D rows.
  if (cell.handler === 'developer') {
    const names = [...new Set(samples.flatMap(attempt => attempt.result?.phases ?? []).filter(phase => phase.scored !== false && phaseBudget(phase.name)).map(phase => phase.name))].sort();
    for (const name of developerPhases(cell, cache)) if (!names.includes(name)) missing.push(`Required developer phase unavailable: ${name}`);
    for (const name of names) {
      let issue = null;
      const values = samples.map(attempt => {
        const phases = attempt.result?.phases?.filter(phase => phase.name === name && phase.scored !== false) ?? [];
        if (phases.length !== 1 || !finite(phases[0].durationMs ?? phases[0].elapsedMs)) { issue = 'Declared developer phase missing or ambiguous'; return null; }
        return phases[0].durationMs ?? phases[0].elapsedMs;
      });
      row(`phase:${name}`, phaseBudget(name), 'timing', values, {issue});
    }
    if (['developer.command', 'developer.command-group', 'developer.archive-update'].includes(cell.operation) && !names.length) missing.push('Measured developer row phases unavailable');
  }
  // Derive lifecycle rows from the verified planned cell and actual retained
  // trace, just as the controller does. Top-level aliases cannot fill gaps.
  const lifecycleRows = new Map();
  if (cell.kind === 'lifecycle') for (const attempt of samples) {
    const raw = attempt.result?.lifecycle ?? (attempt.result?.kind === 'lifecycle-observation-1' ? attempt.result : null);
    lifecycleRows.set(attempt, raw ? deriveLifecycleMeasurements(raw, {cell}) : {measurements: []});
  }
  for (const rule of cell.requiredMeasurements ?? []) {
    if (rule.cache && rule.cache !== cache) continue;
    if (rule.budgetId === 'D11' || rule.name?.startsWith('D11')) continue; // Independent instrumented byte cohorts only.
    const kind = kindFor(rule);
    if (!kind) continue; // Counts/other ratios retain their absolute invariant gates.
    let issue = null, values, methods = [];
    if (visitMetrics[rule.name]) {
      const visits = samples.map(attempt => attempt.result?.visits ?? attempt.result?.observations?.visits);
      if (visits.some(value => !value) || !visits.length || visits.some(value => !same(value.library, visits[0].library) || value.cohortKey !== visits[0].cohortKey)) issue = 'Complete unmixed finalized visit evidence unavailable';
      if (!issue) {
        const profile = cell.requirements?.compatibilitySmoke || cell.parameters?.compatibilitySmoke || ['firefox', 'webkit'].includes(cell.parameters?.browser) && campaign === 'Q3' ? 'P' : campaign;
        const result = evaluateVisits({profile, metric: visitMetrics[rule.name], cache, cohortKey: visits[0].cohortKey, library: visits[0].library,
          expectedVisits: visits.flatMap(visit => visit.expectedVisits ?? (visit.visitId ? [visit.visitId] : [])), reports: visits.flatMap(visit => visit.reports ?? [])});
        if (result.outcome !== 'PASS') issue = 'Finalized visit protocol is not complete and passing';
        const entry = {cellId: cell.id, operation: cell.operation, workload: cell.workload, cache, name: rule.name, budgetId: rule.budgetId, kind,
          statistic: result.statistic, value: issue || missing.length || failures.length ? null : result.value,
          complete: !issue && !missing.length && !failures.length, raw: result.finalized, methods: [digest(visits[0].library)], missing: [...missing, ...(issue ? [issue] : [])], failures: [...failures]};
        rows.push(entry); continue;
      }
      values = samples.map(() => null);
    } else if (sessionMetrics[rule.name]) {
      values = samples.map(attempt => {
        const raw = attempt.result?.session ?? attempt.result?.observations?.session;
        if (!raw) { issue = 'Physical session trace unavailable'; return null; }
        const result = evaluateSession(raw, cell.operation === 'text.interaction' ? 'IText' : 'I');
        if (result.outcome !== 'PASS') issue = 'Physical session protocol is not complete and passing';
        return sessionMetrics[rule.name](result);
      });
    } else {
      values = samples.map(attempt => {
        const derived = lifecycleRows.get(attempt), value = metric(derived ?? attempt.result, rule.name);
        if (!value || !finite(value.value) || value.unit !== rule.unit || typeof value.method !== 'string' || !value.method || value.evidence === undefined) { issue = 'Required value/unit/method/evidence unavailable'; return null; }
        if (value.complete === false || derived && value.complete !== true || Object.hasOwn(value, 'lowerBound') || Object.hasOwn(value, 'upperBound')) {
          issue = 'Incomplete or censored measurement cannot establish an exact regression value'; return null;
        }
        methods.push(value.method); return value.value;
      });
    }
    row(rule.name, rule.budgetId, kind, values, {methods, issue});
  }
  if (cell.budgets?.includes('D11')) {
    const build = cell.handler === 'developer' && ['developer.command', 'developer.command-group'].includes(cell.operation);
    if (!build) {
      const auditInventory = collectCellRows({...cell, handler: 'byte-audit', operation: 'byte-audit', phaseBudgets: [], requirements: {}, requiredMeasurements: [], budgets: []}, cache, byteAuditAttempts ?? [], campaign);
      missing.push(...auditInventory.missing.map(reason => 'Independent D11 audit: ' + reason));
      failures.push(...auditInventory.failures.map(reason => 'Independent D11 audit: ' + reason));
      if ((byteAuditAttempts ?? []).some(attempt => typeof attempt.auditGroupId !== 'string' || !attempt.auditGroupId.startsWith('byte-audit/') || attempt.auditGroupKind !== 'perf-byte-audit-group-1' || attempt.auditTimingSamplesReusable !== false || attempt.result?.timingSamplesReusable !== false)) missing.push('Independent D11 audit group and non-reusable timing identity unavailable');
    }
    const auditSamples = build ? samples : (byteAuditAttempts ?? []).filter(attempt => !attempt.prime && attempt.cache === cache);
    const scope = build ? 'artifact-build' : cell.operation === 'navigation.ready' ? 'startup' : cell.operation === 'text.mixed-ready' ? 'text-engine' : null;
    const names = build ? ['D11BuildStartupJsGzipBytes', 'D11BuildLazyFeatureGzipBytes', 'D11BuildTextEngineRawBytes', 'D11BuildTextEngineGzipBytes', 'D11BuildUiCssFontGzipBytes']
      : scope === 'startup' ? ['D11StartupJsGzipBytes', 'D11StartupEvaluatedJsBytes', 'D11StartupUiCssAndFontsGzipBytes']
      : scope === 'text-engine' ? ['D11TextEngineRawBytes', 'D11TextEngineGzipBytes'] : [];
    const observations = auditSamples.map(attempt => attempt.result?.d11 ?? attempt.result?.observations?.d11);
    let issue = null;
    if (!scope) issue = 'D11 declared byte contract unavailable for this operation';
    else if (observations.length !== required || observations.some(value => value?.kind !== (build ? 'd11-build-observation-1' : 'd11-byte-observation-1') || value.scope !== scope || !build && (value.cache !== cache || value.timingSamplesReusable !== false || !value.instrumentation) || value.status !== 'PASS' || !Array.isArray(value.missing) || value.missing.length ||
        !Array.isArray(value.featureIds) || value.featureIds.some(id => typeof id !== 'string' || !id) || new Set(value.featureIds).size !== value.featureIds.length ||
        !Array.isArray(value.measurements))) issue = `D11 complete ${scope} byte observations unavailable`;
    if (!issue && build) for (const value of observations) {
      try {
        if (!value.artifact?.path) throw Error('Retained build inventory artifact unavailable');
        const derived = observeD11Build(value.inventory, {artifact: value.artifact});
        if (derived.status === 'FAIL') failures.push('D11 build byte ceiling failed');
        if (!same(value, derived)) throw Error('Supplied build byte totals differ from the sealed inventory');
      } catch { issue = 'D11 complete sealed build inventory and individual feature closures unavailable'; }
    }
    if (observations.some(value => value?.status === 'FAIL')) failures.push('D11 byte observation failed');
    if (!issue && observations.some(value => !same([...value.featureIds].sort(), [...observations[0].featureIds].sort()) || !same(value.instrumentation, observations[0].instrumentation))) issue = 'D11 feature/instrumentation identity changed inside the cohort';
    for (const name of names) {
      let metricIssue = issue;
      const methods = [], values = observations.map(value => {
        if (issue) return null;
        const matches = Array.isArray(value?.measurements) ? value.measurements.filter(measurement => measurement.name === name) : [];
        const measured = matches[0];
        if (matches.length !== 1 || !finite(measured.value) || measured.unit !== 'bytes' || typeof measured.method !== 'string' || !measured.method || !measured.evidence || typeof measured.evidence !== 'object') {
          metricIssue = 'D11 named byte value/unit/method/evidence unavailable'; return null;
        }
        if (build && name === 'D11BuildLazyFeatureGzipBytes' && measured.value !== Math.max(0, ...value.features.map(feature => feature.gzipBytes))) { metricIssue = 'D11 lazy maximum differs from retained individual feature bytes'; return null; }
        methods.push(digest({method: measured.method, scope: value.scope, featureIds: [...value.featureIds].sort(), instrumentation: value.instrumentation}));
        return measured.value;
      });
      row(name, 'D11', 'bytes', values, {methods, issue: metricIssue, starts: auditSamples});
    }
    if (build && !issue) for (const id of observations[0].featureIds) {
      const features = observations.map(value => value.features.find(feature => feature.id === id));
      row(`D11BuildLazyFeatureGzipBytes:${id}`, 'D11', 'bytes', features.map(feature => feature.gzipBytes), {
        methods: features.map(feature => feature.method), starts: auditSamples});
    }
    if (issue) missing.push(issue);
  }
  return {rows, missing, failures};
}

/** A trigger is deliberately unresolved. A single later green run cannot erase
 * it: PERF §7 requires a declared matched Q3/E diagnostic, original retention,
 * and an explicit row-owner disposition even when it does not reproduce. */
export function compareCellRows(base, candidate, {matched = true} = {}) {
  const left = new Map(base.map(row => [row.name, row])), right = new Map(candidate.map(row => [row.name, row]));
  return [...new Set([...left.keys(), ...right.keys()])].sort().map(name => {
    const a = left.get(name), b = right.get(name);
    const exact = !!a && !!b && Array.isArray(a.methods) && a.methods.length <= 1 && Array.isArray(b.methods) && b.methods.length <= 1 && same(['cellId','operation','workload','cache','name','budgetId','kind','statistic','methods'].map(key => a[key]), ['cellId','operation','workload','cache','name','budgetId','kind','statistic','methods'].map(key => b[key]));
    const compared = evaluateRegression({kind: a?.kind ?? b?.kind, base: a?.value, candidate: b?.value,
      matched: matched && exact && left.size === base.length && right.size === candidate.length, complete: a?.complete === true && b?.complete === true});
    return {name, budgetId: a?.budgetId ?? b?.budgetId, cache: a?.cache ?? b?.cache, statistic: a?.statistic ?? b?.statistic,
      baseRow: a ?? null, candidateRow: b ?? null, ...compared,
      disposition: compared.triggered ? {status: 'unresolved', repeatability: 'not-established', originalMustBeRetained: true,
        required: compared.action === 'review' ? 'Explicit row-owner review and evidence' : 'One declared matched affected Q3/E diagnostic on the same idle qualified host, alternating base/candidate order; explicit row-owner evidence and disposition even if not reproduced', maximumDiagnosticCohorts: 1} : null};
  });
}

function identityProblems(plan, node, receipt) {
  const problems = [];
  if (receipt?.kind !== 'perf-runtime-campaign-1' || typeof receipt.receiptId !== 'string' || !receipt.receiptId) return ['Missing identified runtime receipt'];
  const expected = makeCampaignPlan({campaign: node.campaign, features: plan.spec.features, cache: node.cache, jobs: node.jobs ?? [node.job]});
  if (!same(receipt.plan, expected)) problems.push('Campaign selection/cell contract differs');
  for (const point of ['before', 'after']) if (receipt.identity?.[point]?.head !== node.source.commit || receipt.identity?.[point]?.digest !== node.source.digest) problems.push('Fresh subject source differs');
  if (receipt.host?.observed?.hostnameHash !== node.physicalHostId) problems.push('Physical host differs');
  for (const key of ['hostAttestation', 'fixtureManifest']) if (receipt.inputIdentities?.[key]?.sha256 !== 'sha256:' + node.inputs[key].sha256) problems.push(`Consumed ${key} differs`);
  if (!receipt.identity?.tools || !receipt.host?.observed) problems.push('Observed environment/tool identity unavailable');
  if (!finite(Date.parse(receipt.startedAt)) || !finite(Date.parse(receipt.finishedAt)) || Date.parse(receipt.finishedAt) < Date.parse(receipt.startedAt)) problems.push('Fresh receipt interval unavailable');
  return problems;
}
function matchedEnvironment(receipt) {
  const {observedAt, ...host} = receipt.host.observed;
  // Subject checkout paths legitimately differ. Version and binary hashes do
  // not: stripping paths must never discard measured executable identities.
  const normalize = value => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'path').map(([key, item]) => [key, normalize(item)])) : value;
  return {host, tools: normalize(receipt.identity.tools)};
}
function cellRowsForReceipt(receipt, cell, cache, campaign) {
  const attempts = receipt.groups.filter(group => group.cell.id === cell.id && group.cache === cache).flatMap(group => group.attempts);
  const byteAuditAttempts = (receipt.byteAuditGroups ?? []).filter(group => group.cell.id === cell.id && group.cache === cache).flatMap(group => group.attempts.map(attempt => ({...attempt,
    auditGroupId: group.id, auditGroupKind: group.kind, auditTimingSamplesReusable: group.byteAudit?.timingSamplesReusable})));
  return collectCellRows(cell, cache, attempts, campaign, {byteAuditAttempts});
}
function reproducedSummary(receipt) {
  return summarize(receipt.plan, receipt.groups, {hostEligible: receipt.summary?.hostEligible === true, sourceStable: true, runError: receipt.runError,
    byteAuditGroups: receipt.byteAuditGroups ?? [], jobExecutions: receipt.jobExecutions ?? [], controllerTiming: receipt.controllerTiming ?? null,
    executableIdentity: {sourceDigest: receipt.identity.before.digest, buildDigest: receipt.identity.buildsBefore?.digest, toolsDigest: campaignDigest(receipt.identity.tools)}});
}

function pipelineInventory(plan) {
  const expected = [];
  for (const role of ['base', 'candidate']) {
    if (plan.nodes.some(node => node.role === role && node.stage.startsWith('p-'))) expected.push({scope: 'P-core', role, cache: plan.spec.cache});
    if (plan.nodes.some(node => node.role === role && node.stage.startsWith('a-'))) expected.push({scope: 'P-adapters', role, cache: plan.spec.cache});
    for (const boundary of plan.boundaries.filter(value => value.role === role && value.kind === 'two-host-core-normal-and-cold')) {
      for (const start of boundary.starts) expected.push({scope: 'Q3-I0', role, cache: start.cache});
    }
  }
  return expected;
}
const pipelineKey = value => `${value.scope}/${value.cache}/${value.role}`;
function readPipelineSamples(plan, samples) {
  const expected = pipelineInventory(plan), records = new Map(), missing = [];
  if (!Array.isArray(samples)) samples = [];
  for (const sample of samples) {
    if (!sample || typeof sample !== 'object') { missing.push('Malformed pipeline sample'); continue; }
    const key = pipelineKey(sample), slot = expected.find(value => pipelineKey(value) === key);
    if (!slot || records.has(key)) { missing.push('Unknown or duplicate pipeline sample: ' + key); continue; }
    const record = {...sample, valid: false}; records.set(key, record);
    try {
      const begin = sample.begin, end = sample.end;
      if (sample.status !== 'PASS' || sample.physicalHostId !== plan.spec.inputs.C.physicalHostId || !same(sample.source, plan.spec[slot.role]) ||
          !finite(sample.elapsedMs) || begin?.kind !== 'same-host-monotonic-1' || end?.kind !== 'same-host-monotonic-1' ||
          !/^[a-f0-9]{64}$/.test(begin.boot ?? '') || begin.boot !== end.boot ||
          !/^\d+$/.test(begin.nanoseconds ?? '') || !/^\d+$/.test(end.nanoseconds ?? '') ||
          !finite(Date.parse(begin.at)) || !finite(Date.parse(end.at)) || Date.parse(end.at) < Date.parse(begin.at)) throw Error('identity or completed clock points unavailable');
      const elapsedMs = Number(BigInt(end.nanoseconds) - BigInt(begin.nanoseconds)) / 1e6;
      if (!finite(elapsedMs) || elapsedMs !== sample.elapsedMs) throw Error('elapsed value differs from actual same-boot monotonic span');
      record.valid = true;
    } catch (error) { missing.push(`${key}: ${error.message}`); }
  }
  for (const slot of expected) if (!records.has(pipelineKey(slot))) missing.push('Missing actual pipeline sample: ' + pipelineKey(slot));
  return {expected, records, missing};
}
function pipelineRow(sample, slot) {
  const value = {...slot, ...(sample ?? {})};
  return {cellId: `pipeline/${value.scope ?? 'missing'}`, operation: 'coordinator.actual-pipeline-span', workload: 'WD', cache: value.cache,
    name: `pipeline:${value.scope ?? 'missing'}`, budgetId: value.scope === 'P-adapters' ? 'P-A-envelope' : 'D08', kind: 'timing', statistic: 'max',
    value: value.valid ? value.elapsedMs : null, complete: value.valid === true, methods: ['independent-C-monotonic-start-through-C/H-completion-callback'],
    raw: value.valid ? [{begin: value.begin, end: value.end, physicalHostId: value.physicalHostId, source: value.source, value: value.elapsedMs}] : [],
    missing: value.valid ? [] : ['Actual complete matched pipeline span unavailable'], failures: []};
}
/** Pipeline durations are observed whole spans on C, never sums of child work.
 * This is relative arithmetic; the coordinator retains the separate absolute
 * core-pair, feature and feedback limits and queue/provisioning accounting. */
export function comparePipelineSamples(plan, samples, {historical = null} = {}) {
  const current = readPipelineSamples(plan, samples), prior = historical ? readPipelineSamples(historical.plan, historical.samples) : current;
  const missing = [...current.missing, ...(historical ? prior.missing : [])], rows = [];
  if (!current.expected.some(value => value.role === 'candidate')) missing.push('Canonical candidate pipeline inventory unavailable');
  for (const slot of current.expected.filter(value => value.role === 'candidate')) {
    const candidate = current.records.get(pipelineKey(slot));
    const base = prior.records.get(pipelineKey({...slot, role: historical ? 'candidate' : 'base'}));
    const ordered = base?.valid && candidate?.valid && (base.end.boot === candidate.begin.boot
      ? BigInt(base.end.nanoseconds) <= BigInt(candidate.begin.nanoseconds) : Date.parse(base.end.at) <= Date.parse(candidate.begin.at));
    if (base?.valid && candidate?.valid && !ordered) missing.push('Candidate pipeline preceded its matched base: ' + pipelineKey(slot));
    const result = compareCellRows([pipelineRow(base, slot)], [pipelineRow(candidate, slot)], {matched: !!base && !!candidate && ordered && base.physicalHostId === candidate.physicalHostId});
    rows.push(...result.map(row => ({scope: slot.scope, cache: slot.cache, ...row})));
  }
  if (rows.some(row => row.outcome === 'INCONCLUSIVE')) missing.push('Missing or unmatched actual pipeline comparison');
  const triggers = rows.filter(row => row.triggered).length;
  return {outcome: missing.length ? 'INCONCLUSIVE' : triggers ? 'BLOCKED' : 'PASS', qualification: false, missing: [...new Set(missing)], rows, triggers,
    scope: 'Independent actual normal/cold pipeline spans; no child-duration sum, cache pooling, synthesized prior baseline or automatic disposition.'};
}

/** The controller pins approved packet bytes and source in the canonical plan.
 * The filesystem coordinator authenticates that packet, every child and the
 * original absolute/pipeline closure before passing this in-memory view. An
 * approval boolean, a PASS summary or this function cannot establish trust. */
function compareApprovedMain(plan, receipts, approved, pipelineSamples) {
  const missing = [], failures = [], pairs = [], trust = plan.spec.approvedMain;
  const unavailable = reason => ({outcome: 'INCONCLUSIVE', missing: [reason], failures, pairs,
    qualification: false, scope: 'No authenticated latest-approved-main comparison is available.'});
  if (!trust) return unavailable('Protected controller input has not pinned a latest-approved-main packet hash and source; fresh base is not a substitute.');
  if (!approved || approved.packetSha256 !== trust.packet.sha256) return unavailable('Verified approved-main packet bytes do not match the controller-pinned hash.');
  try { validateCiPlan(approved.plan); } catch (error) { return unavailable('Approved-main canonical plan is unavailable: ' + error.message); }
  const baseline = approved.plan;
  if (!same(baseline.spec.candidate, trust.source) || baseline.spec.features !== plan.spec.features) return unavailable('Approved-main source or implemented-feature profile differs from protected selection.');
  if (baseline.spec.candidate.commit === plan.spec.candidate.commit) return unavailable('A fresh candidate cannot serve as its own historical approved-main baseline.');
  const history = approved.childReceiptsByNodeId instanceof Map ? approved.childReceiptsByNodeId : new Map(Object.entries(approved.childReceiptsByNodeId ?? {}));
  for (const key of history.keys()) if (!baseline.nodes.some(node => node.id === key)) missing.push(`Unknown approved-main child ${key}`);
  const receiptIds = new Set();
  for (const node of baseline.nodes) {
    const receipt = history.get(node.id);
    if (!receipt) { missing.push(`Missing approved-main child ${node.id}`); continue; }
    const identity = identityProblems(baseline, node, receipt);
    missing.push(...identity.map(reason => `${node.id}: ${reason}`));
    if (receiptIds.has(receipt.receiptId)) missing.push('Reused approved-main child receipt identity');
    receiptIds.add(receipt.receiptId);
    if (identity.length) continue;
    try {
      const summary = reproducedSummary(receipt);
      if (!same(summary, receipt.summary)) missing.push(`${node.id}: approved-main raw summary cannot be reproduced`);
      if (summary.status === 'FAIL') failures.push(`${node.id}: approved-main absolute failure`);
      else if (summary.status !== 'PASS') missing.push(`${node.id}: approved-main required cohort incomplete`);
    } catch (error) { missing.push(`${node.id}: malformed approved-main raw cohort: ${error.message}`); }
  }
  const slot = node => node.id.replace(/-(?:base|candidate)-/, '-revision-');
  for (const node of plan.nodes.filter(value => value.role === 'candidate')) {
    const choices = baseline.nodes.filter(value => value.role === 'candidate' && slot(value) === slot(node));
    const prior = choices[0], candidate = receipts.get(node.id), base = prior && history.get(prior.id), problems = [], rows = [];
    if (choices.length !== 1 || !base) problems.push('Exact approved stage/job/cache cohort unavailable; no P/Q3 or pipeline-context substitution');
    if (!candidate) problems.push('Fresh candidate receipt unavailable');
    if (!problems.length) try {
      problems.push(...identityProblems(plan, node, candidate));
      problems.push(...identityProblems(baseline, prior, base));
      if (node.campaign !== prior.campaign || node.job !== prior.job || !same(node.jobs, prior.jobs) || node.cache !== prior.cache || !same(candidate.plan, base.plan)) problems.push('Approved campaign profile, sample counts or cell contract differs');
      if (!problems.length && (node.physicalHostId !== prior.physicalHostId || !same(matchedEnvironment(base), matchedEnvironment(candidate)) ||
          ['fixtureManifest','configuration'].some(key => node.inputs[key].sha256 !== prior.inputs[key].sha256))) problems.push('Approved environment, tool, fixture or settings cohort differs');
      if (base.receiptId === candidate.receiptId || Date.parse(base.finishedAt) > Date.parse(candidate.startedAt)) problems.push('Historical approved receipt must precede a distinct fresh candidate start');
      if (!problems.length) try {
        for (const cell of candidate.plan.jobs.flatMap(job => job.cells)) for (const cache of ['cold','warm','single']) {
          if (!(cache === 'single' ? cell.kind === 'lifecycle' : cell.kind !== 'lifecycle' && cell[cache] > 0)) continue;
          const read = receipt => cellRowsForReceipt(receipt, cell, cache, node.campaign);
          const a = read(base), b = read(candidate);
          problems.push(...a.missing, ...b.missing); failures.push(...a.failures, ...b.failures);
          rows.push(...compareCellRows(a.rows, b.rows, {matched: !problems.length}));
        }
      } catch (error) { problems.push('Malformed approved comparison evidence: ' + error.message); }
    } catch (error) { problems.push('Malformed approved comparison identity: ' + error.message); }
    missing.push(...problems); pairs.push({approvedNodeId: prior?.id ?? null, candidateNodeId: node.id, problems: [...new Set(problems)], rows});
  }
  const rows = pairs.flatMap(pair => pair.rows), triggers = rows.filter(row => row.triggered).length;
  if (rows.some(row => row.outcome === 'INCONCLUSIVE')) missing.push('Missing or unmatched approved-main row statistics');
  const pipelines = comparePipelineSamples(plan, pipelineSamples, {historical: {plan: baseline, samples: approved.pipelineSamples}});
  missing.push(...pipelines.missing);
  return {outcome: failures.length ? 'FAIL' : missing.length ? 'INCONCLUSIVE' : triggers || pipelines.triggers ? 'BLOCKED' : 'PASS', qualification: false,
    packetSha256: approved.packetSha256, source: trust.source, missing: [...new Set(missing)], failures: [...new Set(failures)], pairs, pipelines, triggers: triggers + pipelines.triggers,
    scope: 'Only exact controller-selected historical and fresh candidate cohorts; approval/latestness authority is the protected external selection, not packet claims.'};
}

/** Pure comparison of raw child receipts ALREADY authenticated with
 * verifyCampaignReceipt by the filesystem orchestrator. No boolean field in a
 * receipt authenticates its bytes. This function never reads mutable files.
 * Full TEST §315 plan validation preserves P+A and every affected Q3 node.
 */
export function evaluatePaired(plan, childReceiptsByNodeId, {approvedMain = null, pipelineSamples = []} = {}) {
  const missing = [], failures = [], pairs = [], knownIds = new Set(), receipts = childReceiptsByNodeId instanceof Map ? childReceiptsByNodeId : new Map(Object.entries(childReceiptsByNodeId ?? {}));
  try { validateCiPlan(plan); } catch (error) { return {kind: 'ci-relative-regressions-1', outcome: 'INCONCLUSIVE', qualification: false, missing: ['Canonical full paired CI plan required: ' + error.message], failures, pairs}; }
  if (plan.spec.purpose === 'initial-baseline') return {kind: 'ci-relative-regressions-1', planDigest: plan.digest,
    freshBaseOutcome: 'NOT_APPLICABLE', outcome: 'NOT_APPLICABLE', qualification: false, missing, failures, pairs, triggers: 0,
    scope: 'A canonical first baseline has no historical or fresh base. This relative check is not a pass; the coordinator must independently verify every required candidate-only Q3 absolute gate, pipeline boundary and manual/native acceptance.',
    latestApprovedMain: {outcome: 'NOT_APPLICABLE', reason: 'Initial baseline establishes candidate evidence without inventing an approved historical baseline.'}};
  for (const key of receipts.keys()) if (!plan.nodes.some(node => node.id === key)) missing.push(`Unknown child receipt: ${key}`);
  for (const node of plan.nodes.filter(node => node.role === 'base')) {
    const candidateNode = plan.nodes.find(value => value.id === node.id.replace('-base-', '-candidate-'));
    const base = receipts.get(node.id), candidate = candidateNode && receipts.get(candidateNode.id);
    const problems = [], rows = [];
    for (const [subject, receipt] of [[node, base], [candidateNode, candidate]]) {
      if (!subject) { problems.push('Required candidate node missing'); continue; }
      if (!receipt) { problems.push(`Missing child ${subject.id}`); continue; }
      problems.push(...identityProblems(plan, subject, receipt).map(problem => `${subject.id}: ${problem}`));
      if (knownIds.has(receipt.receiptId)) problems.push('Reused immutable receipt identity');
      knownIds.add(receipt.receiptId);
      if (receipt.summary?.status === 'FAIL') failures.push(`${subject.id}: absolute gate failure`);
    }
    if (!problems.length) {
      if (!same(node.inputs, candidateNode.inputs) || !same(matchedEnvironment(base), matchedEnvironment(candidate))) problems.push('Unmatched environment, tool, fixture or settings identity');
      if (Date.parse(base.finishedAt) > Date.parse(candidate.startedAt)) problems.push('Fresh base must finish before its candidate');
      try {
        for (const [subject, receipt] of [[node, base], [candidateNode, candidate]]) {
          const summary = reproducedSummary(receipt);
          if (!same(summary, receipt.summary)) problems.push(`${subject.id}: raw evidence does not reproduce its summary`);
          if (summary.status === 'FAIL') failures.push(`${subject.id}: raw absolute gate failure`);
          else if (summary.status !== 'PASS') problems.push(`${subject.id}: incomplete required raw cohort`);
        }
        const cells = base.plan.jobs.flatMap(job => job.cells);
        for (const cell of cells) for (const cache of ['cold','warm','single']) {
          if (!(cache === 'single' ? cell.kind === 'lifecycle' : cell.kind !== 'lifecycle' && cell[cache] > 0)) continue;
          const read = receipt => cellRowsForReceipt(receipt, cell, cache, node.campaign);
          const a = read(base), b = read(candidate);
          problems.push(...a.missing, ...b.missing); failures.push(...a.failures, ...b.failures);
          rows.push(...compareCellRows(a.rows, b.rows, {matched: !problems.length}));
        }
      } catch (error) { problems.push('Malformed raw comparison evidence: ' + error.message); }
    }
    missing.push(...problems); pairs.push({baseNodeId: node.id, candidateNodeId: candidateNode?.id ?? null, problems: [...new Set(problems)], rows});
  }
  const rows = pairs.flatMap(pair => pair.rows), triggered = rows.filter(row => row.triggered), incomplete = rows.filter(row => row.outcome === 'INCONCLUSIVE');
  if (incomplete.length) missing.push(`${incomplete.length} missing or unmatched row statistics`);
  const pipelines = comparePipelineSamples(plan, pipelineSamples); missing.push(...pipelines.missing);
  const freshBaseOutcome = failures.length ? 'FAIL' : missing.length ? 'INCONCLUSIVE' : triggered.length || pipelines.triggers ? 'BLOCKED' : 'PASS';
  const latestApprovedMain = compareApprovedMain(plan, receipts, approvedMain, pipelineSamples);
  const outcomes = [freshBaseOutcome, latestApprovedMain.outcome];
  return {kind: 'ci-relative-regressions-1', planDigest: plan.digest, freshBaseOutcome,
    outcome: outcomes.includes('FAIL') ? 'FAIL' : outcomes.includes('INCONCLUSIVE') ? 'INCONCLUSIVE' : outcomes.includes('BLOCKED') ? 'BLOCKED' : 'PASS', qualification: false,
    scope: 'Authenticated fresh and protected-controller-selected approved-main comparisons only. Whole-pipeline clocks, manual/native evidence and release acceptance remain separate required checks.',
    latestApprovedMain,
    missing: [...new Set(missing)], failures: [...new Set(failures)], pairs, pipelines, triggers: triggered.length + pipelines.triggers,
    diagnosticPolicy: {automaticRetry: false, maximumMatchedAffectedCohorts: 1, requiredProfile: ['Q3','E'], originalReceiptRetained: true, nonreproducedBreachNeedsOwnerDisposition: true}};
}
