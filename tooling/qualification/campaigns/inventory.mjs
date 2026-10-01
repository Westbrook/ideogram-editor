/**
 * Executable specimen inventory for PERF-8+A3 §2/§6 and TEST-1+A3 §11.
 * A declared cell is an execution requirement, never evidence that it passed.
 * Counts are per revision. The executor owns fresh base/candidate scheduling.
 */
import { declareByteAuditCohorts } from './byte-audits.mjs';

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

export const CAMPAIGN_SPEC = Object.freeze({
  performance: 'PERF-8+A3', testing: 'TEST-1+A3',
  sources: ['docs/spec/performance.md', 'docs/spec/testing.md'],
});

export const QUEUE_SCENARIOS = Object.freeze([
  'lost-ack', 'duplicate-status', 'out-of-order-status', 'cancel-late-result',
  'expiry', 'browser-restart', 'backend-restart', 'offline-completion', 'disk-full-admission',
]);
export const STARTUP_SCENARIOS = Object.freeze(['blocked-js', 'failed-chunk', 'missing-key']);
export const TEXT_RECOVERY_SCENARIOS = Object.freeze([
  'missing-font', 'corrupt-font', 'restricted-font', 'mismatched-font-hash',
  'missing-glyph', 'cancelled-over-limit-composition',
]);
export const CAPTION_CASES = Object.freeze([
  'valid-multilingual-profile', 'max-256-elements', 'control-quote-backslash-escaping',
  'plain-string', 'malformed-json', 'root-array', 'root-null', 'double-encoding',
  'wrong-nested-types', 'exact-duplicate-key', 'escape-equivalent-duplicate-key',
  'depth-16', 'depth-17', 'tokens-50000', 'tokens-50001', 'bytes-256kib',
  'bytes-plus-one', 'elements-257', 'string-16kib', 'string-plus-one',
  'unknown-key', 'unknown-version', 'bbox-frame-invalidity', 'late-partial-caption',
  'layer-byte-plus-one', 'document-byte-plus-one', 'line-plus-one', 'invalid-surrogate',
  'exact-native-boundaries', 'valid-1mib-75-layers',
].map((scenario, index) => Object.freeze({ caseId: `WJ${String(index + 1).padStart(2, '0')}`, scenario })));
export const FAST_CASES = Object.freeze([
  'turbo-none', 'turbo-medium', 'balanced-none', 'balanced-medium', 'quality-none',
  'quality-medium', 'reject-source', 'reject-mask', 'reject-lora', 'reject-acceleration',
  'reject-large', 'reject-invalid-size', 'lost-ack', 'reconnect', 'cancel', 'late-result',
].map((scenario, index) => Object.freeze({ caseId: `WF${String(index + 1).padStart(2, '0')}`, scenario })));
export const CP_CASES = Object.freeze([
  'quantization', 'passthrough-placement', 'alpha', 'transformed-edge', 'radius-0',
  'radius-1', 'radius-2', 'radius-64', 'empty', 'full', 'edge', 'corner',
  'fractional-crop', 'approved-expansion', 'approved-clipping', 'output-grid-mismatch',
].map((scenario, index) => Object.freeze({ caseId: `CP${String(index + 1).padStart(2, '0')}`, scenario })));

const P_C = ['C0', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C9', 'C10', 'C8'];
const P_H = ['H0', 'H1', 'H2', 'H3', 'H4', 'H5', 'H7', 'H8', 'H9', 'H10', 'H6'];
const P_A = ['AC0', 'AC1', 'AC2', 'AC3', 'AH0', 'AH1', 'AH2', 'AH3'];
const Q_C = ['I1', 'I2', 'I6C', 'I7N', 'I7A', 'I8C', 'I10C', 'I12C'];
const Q_H = ['I3', 'I4', 'I5a', 'I5b', 'I6H', 'I8H', 'I10H', 'I11H', 'I12H', 'I13H'];

export function requiredCampaignJobs(campaign, features = 'adapters') {
  validateProfile(campaign, features);
  if (campaign === 'P') return [...P_C, ...P_H, ...(features === 'adapters' ? P_A : [])];
  return ['I0', ...Q_C.filter((id) => !['I7A', 'I8C'].includes(id) || features === 'adapters'),
    ...Q_H.filter((id) => id !== 'I8H' || features === 'adapters')];
}

function validateProfile(campaign, features) {
  if (!['P', 'Q3'].includes(campaign)) throw new Error('CAMPAIGN_UNSUPPORTED: use P or Q3');
  if (features === 'training') throw new Error('TRAINING_CAMPAIGN_UNIMPLEMENTED: training is a deferred capability');
  if (!['core', 'adapters'].includes(features)) throw new Error('CAMPAIGN_FEATURES_INVALID: use core or adapters');
}

const phase = (id, name, targetMs, ceilingMs) => ({ id, phase: name, targetMs, ceilingMs });
const feedback = { ...phase('R04', 'ui.feedback', 50, 100), aggregation: 'maximum', scope: 'every-input-or-detected-state-acknowledgement' };
const durable = { ...phase('R20', 'event.append', 20, 50), aggregation: 'maximum', scope: 'each-durable-append' };
const queuePhases = [phase('R24', 'command.validate', 20, 50),
  phase('R24', 'command.accept', 50, 150), phase('R24', 'job.submit.eligible-dispatch', 100, 250)];
const textActions = { edits: 40, preeditUpdates: 20, commitCancel: 10, caretSelection: 10,
  semanticSelections: 10, fontWrapTransformGuide: 10, presentationRequests: 6, total: 106 };
const commonRequirements = {
  sealedFixture: true, retainEveryOutcome: true, retainPrimesAndResets: true,
  providerCalls: 0, noCompetingTimedWork: true,
};

const metric = (budgetId, name, unit, target, ceiling, statistic = 'maximum') =>
  ({ budgetId, name, unit, target, ceiling, statistic });
const invariant = (budgetId, name) => metric(budgetId, name, 'violations', 0, 0);

/** Names read from handler result.measurements. Absence is missing evidence. */
export const REQUIRED_MEASUREMENT_REGISTRY = Object.freeze({
  D11: [
    { ...metric('D11', 'D11StartupJsGzipBytes', 'bytes', 300 * 1024, 500 * 1024), scope: 'startup', source: 'separate-byte-audit' },
    { ...metric('D11', 'D11StartupEvaluatedJsBytes', 'bytes', MiB, 1.5 * MiB), scope: 'startup', source: 'separate-byte-audit' },
    { ...metric('D11', 'D11StartupUiCssAndFontsGzipBytes', 'bytes', 100 * 1024, 200 * 1024), scope: 'startup', source: 'separate-byte-audit' },
    { ...metric('D11', 'D11TextEngineRawBytes', 'bytes', 6 * MiB, 12 * MiB), scope: 'text-engine', source: 'separate-byte-audit' },
    { ...metric('D11', 'D11TextEngineGzipBytes', 'bytes', 2 * MiB, 4 * MiB), scope: 'text-engine', source: 'separate-byte-audit' },
    { ...metric('D11', 'D11BuildStartupJsGzipBytes', 'bytes', 300 * 1024, 500 * 1024), scope: 'artifact-build', source: 'artifact-build' },
    { ...metric('D11', 'D11BuildLazyFeatureGzipBytes', 'bytes', 150 * 1024, 300 * 1024), scope: 'artifact-build', source: 'artifact-build' },
    { ...metric('D11', 'D11BuildTextEngineRawBytes', 'bytes', 6 * MiB, 12 * MiB), scope: 'artifact-build', source: 'artifact-build' },
    { ...metric('D11', 'D11BuildTextEngineGzipBytes', 'bytes', 2 * MiB, 4 * MiB), scope: 'artifact-build', source: 'artifact-build' },
    { ...metric('D11', 'D11BuildUiCssFontGzipBytes', 'bytes', 100 * 1024, 200 * 1024), scope: 'artifact-build', source: 'artifact-build' },
  ],
  R01: [metric('R01', 'R01LcpMs', 'ms', 1500, 2500, 'per-visit-lab')],
  R02: [metric('R02', 'R02InpMs', 'ms', 100, 200, 'per-visit-lab')],
  R03: [metric('R03', 'R03Cls', 'ratio', 0.05, 0.10, 'per-visit-lab')],
  R04: [invariant('R04', 'R04FalsePendingOrCompletionCount')],
  R06: [metric('R06', 'R06DefinitionAndUpdateMs', 'ms', 100, 250), metric('R06', 'R06LazyReadyMs', 'ms', 250, 750)],
  R07: [metric('R07', 'R07FrameWorkP95Ms', 'ms', 8, 10, 'worst-session-p95'),
    metric('R07', 'R07FrameWorkMaxMs', 'ms', 8, 10), metric('R07', 'R07PointerPaintP95Ms', 'ms', 16.7, 33.4, 'worst-session-p95'),
    metric('R07', 'R07DroppedSlotShare', 'ratio', 0.01, 0.05, 'worst-session')],
  R08: [metric('R08', 'R08ActiveSliceMs', 'ms', 4, 6), metric('R08', 'R08IdleSliceMs', 'ms', 8, 16),
    invariant('R08', 'R08LostEditOrFidelityViolationCount')],
  R17: [metric('R17', 'R17BackendRssBytes', 'bytes', 256 * MiB, 512 * MiB)],
  R18: [metric('R18', 'R18CpuAllocationBytes', 'bytes', 384 * MiB, 512 * MiB),
    metric('R18', 'R18GpuAllocationBytes', 'bytes', 256 * MiB, 384 * MiB),
    metric('R18', 'R18PreviewCacheBytes', 'bytes', 64 * MiB, 128 * MiB),
    invariant('R18', 'R18TextureDeviceOr2048BoundViolations')],
  R20: [invariant('R20', 'R20PrematureDurableAcknowledgements')],
  R21: [metric('R21', 'R21EventUtf8Bytes', 'bytes', 4 * 1024, 16 * 1024),
    metric('R21', 'R21CommandUtf8Bytes', 'bytes', 16 * 1024, 64 * 1024),
    metric('R21', 'R21InlineBinaryOrDataUris', 'count', 0, 0)],
  R22: [metric('R22', 'R22ReplayRemoteEffects', 'count', 0, 0), invariant('R22', 'R22ProjectionMismatchCount')],
  R23: [metric('R23', 'R23SnapshotTailEvents', 'count', 250, 500), invariant('R23', 'R23AtomicHighWaterViolations')],
  R24: [invariant('R24', 'R24FrozenCommandOrQueueReceiptViolations')],
  R25: [metric('R25', 'R25ActiveRequests', 'count', 1, 1), metric('R25', 'R25PendingEntries', 'count', 100, 1000),
    invariant('R25', 'R25RejectedDraftLossCount')],
  R26: [metric('R26', 'R26StatusMessageBytes', 'bytes', 1024, 4 * 1024),
    metric('R26', 'R26ObserverBytesPerMinute', 'bytes/minute', 64 * 1024, 128 * 1024),
    invariant('R26', 'R26LostTerminalStateCount')],
  R28: [metric('R28', 'R28TransferBufferBytes', 'bytes', 8 * MiB, 16 * MiB),
    invariant('R28', 'R28ActualByteOrDurabilityMismatchCount')],
  R29: [metric('R29', 'R29ForegroundHealthyPollGapMs', 'ms', 2000, 5000),
    metric('R29', 'R29BackgroundHealthyPollGapMs', 'ms', 15000, 30000),
    metric('R29', 'R29RecoveredPageEntries', 'count', 20, 20),
    invariant('R29', 'R29UnexpectedResubmissionCount')],
  R30: [invariant('R30', 'R30StoppedOrRefundedWithoutEvidenceCount'),
    metric('R30', 'R30CancelEligibleDispatchMs', 'ms', 100, 250)],
  R31: [metric('R31', 'R31WarningAtUsedShare', 'ratio', 0.80, 0.85),
    invariant('R31', 'R31AdmittedAt90PercentOrWithoutReservationCount'),
    invariant('R31', 'R31Missing1GiBMarginOrRecoveryReserveCount'),
    invariant('R31', 'R31ReservationOutsidePredicted25To100PercentOverheadCount'),
    metric('R31', 'R31TransferCapacityRecheckGapMs', 'ms', 30000, 30000)],
  R32: [metric('R32', 'R32UnchangedOwnedAssetFetches', 'count', 0, 0), invariant('R32', 'R32CacheIdentityMismatchCount')],
  R33: [metric('R33', 'R33AcceptedLayerUtf8Bytes', 'bytes', 8 * 1024, 16 * 1024),
    metric('R33', 'R33AcceptedLayerLogicalLines', 'count', 128, 256),
    metric('R33', 'R33AcceptedDocumentUtf8Bytes', 'bytes', 512 * 1024, MiB),
    metric('R33', 'R33AcceptedMixedLayers', 'count', 100, 100), invariant('R33', 'R33SilentTextChangeOrInvalidAcceptanceCount')],
  R34: [invariant('R34', 'R34IncorrectPixelsOrExcludedParentWorkCount')],
  R35: [metric('R35', 'R35CurrentFontFaces', 'count', 8, 16), metric('R35', 'R35SingleFontBytes', 'bytes', 8 * MiB, 16 * MiB),
    metric('R35', 'R35CurrentFontSetBytes', 'bytes', 32 * MiB, 64 * MiB),
    metric('R35', 'R35FontShapingCpuBytes', 'bytes', 64 * MiB, 128 * MiB),
    metric('R35', 'R35GlyphGpuBytes', 'bytes', 16 * MiB, 32 * MiB), invariant('R35', 'R35SilentFontSubstitutionCount')],
  R36: [metric('R36', 'R36AdmittedParseBytes', 'bytes', 128 * 1024, 256 * 1024),
    metric('R36', 'R36AdmittedStringBytes', 'bytes', 8 * 1024, 16 * 1024),
    metric('R36', 'R36AdmittedElements', 'count', 128, 256), metric('R36', 'R36AdmittedDepth', 'count', 8, 16),
    metric('R36', 'R36AdmittedTokens', 'count', 25000, 50000), invariant('R36', 'R36DuplicateCollapseOrCoercionCount')],
  R37: [metric('R37', 'R37EscapedPromptBytes', 'bytes', 0.75 * MiB, 1.5 * MiB),
    metric('R37', 'R37OtherRequestBytes', 'bytes', 32 * 1024, 64 * 1024),
    metric('R37', 'R37WireBodyBytes', 'bytes', 0.78125 * MiB, 1.5625 * MiB),
    invariant('R37', 'R37SerializationOrApprovalMismatchCount')],
  R38: [metric('R38', 'R38DerivedSnapshotBytes', 'bytes', 256 * 1024, 512 * 1024),
    metric('R38', 'R38IssueBytes', 'bytes', 32 * 1024, 64 * 1024), metric('R38', 'R38RawPageBytes', 'bytes', 16 * 1024, 32 * 1024),
    metric('R38', 'R38MaterializedRawInspectionBytes', 'bytes', 8 * MiB, 16 * MiB),
    metric('R38', 'R38TextCaptionWorkspaceBytes', 'bytes', 32 * MiB, 64 * MiB),
    invariant('R38', 'R38RawTruncationOrFalseCompletenessCount')],
  R39: [metric('R39', 'R39StreamingWorkspaceBytes', 'bytes', 32 * MiB, 64 * MiB),
    metric('R39', 'R39ManifestBytes', 'bytes', 64 * MiB, 128 * MiB),
    invariant('R39', 'R39MissingClosureOrHashOrHistoryCount'), metric('R39', 'R39ReplayRemoteEffects', 'count', 0, 0)],
  R40: [metric('R40', 'R40NewFeatherRadiusPixels', 'pixels', 32, 64),
    invariant('R40', 'R40CanonicalOrContainmentOrPlacementMismatchCount')],
  R41: [invariant('R41', 'R41OriginalLossOrAnimationAdmissionCount'), invariant('R41', 'R41NormalizationMismatchCount')],
  R42: [metric('R42', 'R42ActiveRequests', 'count', 1, 1), metric('R42', 'R42BatchOutputs', 'count', 1, 4),
    invariant('R42', 'R42RouteOrDroppedFieldOrUnexpectedRetryCount')],
  T05: [invariant('T05', 'T05IncompleteOrUnverifiedIdentityAcceptanceCount'), metric('T05', 'T05BrowserTensorBytes', 'bytes', 0, 0)],
  T06: [metric('T06', 'T06UnchangedOwnedAssetFetches', 'count', 0, 0),
    invariant('T06', 'T06ArtifactHashOrDurabilityMismatchCount')],
});

function measurementRequirements(budgets, workload, parameters, kind, host, operation) {
  if (kind === 'setup' || kind === 'audit') return [];
  const rules = budgets.flatMap((id) => REQUIRED_MEASUREMENT_REGISTRY[id] ?? []).filter((rule) => {
    if (rule.budgetId === 'D11') return host === 'H'
      ? operation === 'navigation.ready' && ['W0', 'W1'].includes(workload) && rule.scope === 'startup' || operation === 'text.mixed-ready' && rule.scope === 'text-engine'
      : host === 'C' && rule.scope === 'artifact-build' &&
        (operation === 'developer.command' && parameters.command === 'production-build' || operation === 'developer.command-group');
    if (rule.name === 'R25RejectedDraftLossCount') return operation === 'queue.fault' && parameters.scenario === 'disk-full-admission' ||
      operation === 'fast.workflow' && /^WF(?:0[7-9]|1[0-2])$/.test(parameters.caseId ?? '');
    // These observations belong to different specimens in the fixed inventory:
    // lost acknowledgement has no response, and only the healthy ten-second
    // trace provides a complete observer-rate window.
    if (rule.name === 'R26StatusMessageBytes') return ['queue.proxy-pair', 'queue.healthy-polling'].includes(operation) ||
      operation === 'queue.fault' && !['lost-ack', 'disk-full-admission'].includes(parameters.scenario);
    if (rule.name === 'R26ObserverBytesPerMinute') return operation === 'queue.healthy-polling';
    if (rule.name === 'R26LostTerminalStateCount') return operation === 'queue.fault' &&
      ['cancel-late-result', 'expiry', 'offline-completion'].includes(parameters.scenario);
    if (rule.name === 'R29ForegroundHealthyPollGapMs') return operation === 'queue.healthy-polling';
    // The prescribed specimen is a real ten-second foreground interval. A
    // 15–30 second background gap needs an independently selected trace.
    if (rule.name === 'R29BackgroundHealthyPollGapMs') return false;
    if (rule.name === 'R29RecoveredPageEntries') return ['browser-restart', 'backend-restart', 'offline-completion'].includes(parameters.scenario);
    // A rejected admission has no transfer interval. Keep its reservation and
    // admission proofs, while requiring actual capacity-check gaps only from
    // the already scheduled byte-transfer specimens.
    if (rule.budgetId === 'R31') return ['transfer.asset', 'adapter.transfer'].includes(operation)
      ? rule.name === 'R31TransferCapacityRecheckGapMs'
      : rule.name !== 'R31TransferCapacityRecheckGapMs';
    return true;
  });
  const normal = ['W0', 'W1', 'WXn', 'WA'].includes(workload);
  if (budgets.includes('R05')) {
    rules.push({ ...metric('R05', 'R05UsableCanvasColdMs', 'ms', normal ? 2500 : 4000, normal ? 4000 : 8000), cache: 'cold' });
    if (normal) rules.push({ ...metric('R05', 'R05UsableCanvasWarmMs', 'ms', 1000, 2000), cache: 'warm' });
  }
  if (budgets.includes('R16')) rules.push(metric('R16', 'R16CompletedViewMs', 'ms', normal ? 50 : 100, normal ? 100 : 250),
    metric('R16', 'R16MountedRows', 'count', 60, 100));
  if (budgets.includes('R17') && host === 'H') rules.push(metric('R17', 'R17BrowserProcessTreeRssBytes', 'bytes', normal ? GiB : 1.5 * GiB, normal ? 1.5 * GiB : 2 * GiB));
  if (budgets.includes('R19')) rules.push(metric('R19', 'R19FinalSettledGrowthBytes', 'bytes',
    (parameters.cycles === 100 ? 16 : 4) * MiB, (parameters.cycles === 100 ? 32 : 8) * MiB),
  metric('R19', 'R19WorstSettledGrowthBytes', 'bytes', (parameters.cycles === 100 ? 16 : 4) * MiB,
    (parameters.cycles === 100 ? 32 : 8) * MiB));
  return rules;
}

function add(job, key, operation, workload, options = {}) {
  const { handler = job.host === 'H' ? 'browser' : 'backend', kind = 'operation',
    cold = 0, warm = 0, primes = 0, parameters = {}, requirements = {}, budgets = [], phaseBudgets = [] } = options;
  const ownedBudgets = [...new Set([...budgets, ...phaseBudgets.map((entry) => entry.id)])];
  job.cells.push({ id: `${job.id}/${key}`, operation, workload, host: job.host,
    handler, kind, cold, warm, primes, parameters,
    requirements: { ...commonRequirements, ...requirements }, budgets: ownedBudgets, phaseBudgets,
    requiredMeasurements: measurementRequirements(ownedBudgets, workload, parameters, kind, job.host, operation) });
}

function operation(job, key, op, workload, profile, parameters = {}, budgets = [], extra = {}) {
  add(job, key, op, workload, { cold: profile === 'P' ? 3 : 10, warm: profile === 'P' ? 3 : 10,
    primes: profile === 'P' ? 1 : 3, parameters, budgets,
    requirements: { resetBeforeEveryStart: true, resetBeforeEachCold: true, warmPrimeBeforeScored: true, statistic: 'maximum',
      ...(job.host === 'H' ? { presentationTrace: true } : {}) }, ...extra });
}
function cases(job, key, op, workload, profile, parameters, budgets, extra = {}) {
  add(job, key, op, workload, { kind: 'case', cold: profile === 'P' ? 3 : 10,
    warm: profile === 'P' ? 3 : 10, parameters, budgets,
    requirements: { resetBeforeEveryStart: true, statistic: 'maximum',
      ...(job.host === 'H' ? { independentBrowserBackend: true, presentationTrace: true } : {}) }, ...extra });
}
function dev(job, key, op, parameters, budgets = [], options = {}) {
  add(job, key, op, 'WD', { handler: 'developer', cold: 1, parameters, budgets, ...options });
}
function lifecycle(job, workload, cycles, adapter = false) {
  const mixed = workload === 'WXn' || workload === 'WXs';
  add(job, `${workload}-lifecycle`, adapter ? 'adapter.lifecycle' : 'lifecycle.editor', workload, {
    handler: adapter && job.host !== 'H' ? 'adapters' : 'browser', kind: 'lifecycle', cold: 1,
    budgets: adapter ? ['R17', 'R18', 'T05', 'T06', 'R32'] : ['R17', 'R18', 'R19', 'R21', 'R25', ...(mixed ? ['R35', 'R38'] : [])],
    parameters: { cycles, baselineIdleMs: 30000, idleMs: 30000, cycleBudgetMs: 90000,
      windowCycles: cycles === 100 ? 20 : null, windows: cycles === 100 ? 5 : null,
      windowMs: cycles === 100 ? 1800000 : null,
      restarts: adapter ? [] : cycles === 100 ? [20, 40, 60, 80] : [1],
      restartTarget: adapter ? null : 'raster-worker', mixed,
      processResetBetweenCycles: false, forcedGc: false,
      steps: adapter ? ['import', 'select', 'unselect', 'close', 'release', 'idle', 'observe'] :
        ['open', 'mask-stroke-120-samples', 'adopt-fixed-candidate', ...(mixed ? ['text-edit-undo', 'font-select-restore'] : []),
          'undo-adoption', 'undo-stroke', 'close', 'release', 'idle', 'observe'],
      ...(adapter ? { bytes: 256 * MiB, configBytesMax: MiB } : {}),
    }, requirements: { freshIsolatedProcess: true, baselineCount: 1, observationCount: cycles,
      fixedIdleMs: (cycles + 1) * 30000, retainSameDurableFixture: true,
      noFixtureDeletion: true, resourceProcessTree: true, cpuGpuAllocationLedger: true,
      ...(adapter ? { noHundredCycleGrowthClaim: true } : {
        finalAndWorstIntermediateGrowth: true, growthTargetBytes: (cycles === 100 ? 16 : 4) * MiB,
        growthCeilingBytes: (cycles === 100 ? 32 : 8) * MiB, releaseTargetMs: 1000, releaseCeilingMs: 5000,
      }),
    }, phaseBudgets: adapter ? [] : [phase('R19', 'resource.last-consumer-release', 1000, 5000)],
  });
}

function queue(job, profile) {
  for (const scenario of QUEUE_SCENARIOS) {
    const admissionRejected = scenario === 'disk-full-admission';
    const reconnect = ['browser-restart', 'backend-restart', 'offline-completion'].includes(scenario);
    const retrieval = ['cancel-late-result', 'expiry', 'offline-completion'].includes(scenario);
    cases(job, scenario, 'queue.fault', 'WQ', profile, { scenario, fakeClock: 'scheduler-history-only',
      ...(scenario === 'cancel-late-result' && job.host === 'H' ? { publications: 4, paints: 6,
        milestones: ['submit-pending', 'seeded-state', 'cancel-pending', 'cancel-requested',
          'late-availability-pending', 'owned-candidate'] } : {}) },
    ['R21', 'R24', 'R25', ...(admissionRejected ? ['R31'] : ['R20', ...(scenario === 'lost-ack' ? [] : ['R26']), 'R32']),
      ...(reconnect ? ['R23'] : []), ...(reconnect || retrieval ? ['R29'] : []),
      ...(scenario === 'cancel-late-result' ? ['R30'] : []), ...(job.host === 'H' ? ['R04'] : [])],
    { phaseBudgets: [...(admissionRejected ? [queuePhases[0]] : [...queuePhases, durable]), ...(job.host === 'H' ? [feedback] : []),
      ...(reconnect ? [phase('R29', 'job.reconnect-start', 1000, 2000)] : []),
      ...(retrieval ? [phase('R29', 'result.retrieval-start', 1000, 3000)] : [])] });
  }
  if (job.host === 'H') {
    for (const scenario of STARTUP_SCENARIOS) cases(job, scenario, 'startup.failure', 'W0', profile,
      { scenario, injectedDetectionWindowMs: 4000 }, ['R04'], { phaseBudgets: [feedback] });
  } else {
    add(job, 'direct-proxy-pairs', 'queue.proxy-pair', 'WQ', { kind: 'case', cold: 3, warm: 3,
      parameters: { pairedDirectAndProxy: true, networkProfile: 'N' }, budgets: ['R26'],
      requirements: { statistic: 'maximum', sameEmulatorRoute: true },
      phaseBudgets: [{ ...phase('R26', 'control.proxy-added-hop', 10, 30), measurement: 'R26ProxyAddedHopMs' }] });
  }
  if (profile === 'P' || job.host === 'C') add(job, 'healthy-polling', 'queue.healthy-polling', 'WQ', {
    kind: 'case', warm: 3, parameters: { durationMs: 10000 }, budgets: ['R26', 'R29'],
    requirements: { realWallClock: true, syntheticClock: false },
  });
  if (profile === 'P' && job.host === 'H') for (const direction of ['upload', 'download']) {
    add(job, `8mib-${direction}`, 'transfer.asset', 'W1', { warm: 3,
      parameters: { direction, bytes: 8 * MiB, networkProfile: 'N', freshTransferKey: true },
      requirements: { actualBytesTransferred: true, cacheCohort: 'declared-miss',
        presentationTrace: true, transferBuffersCeilingBytes: 16 * MiB }, budgets: ['R04', 'R28', 'R31'],
      phaseBudgets: [feedback, phase('R28', 'asset.transfer-durable', direction === 'upload' ? 4000 : 1000,
        direction === 'upload' ? 6000 : 2000)],
    });
  }
}

function captionFast(job, profile) {
  for (const descriptor of CAPTION_CASES) cases(job, descriptor.caseId,
    Number(descriptor.caseId.slice(2)) > 24 ? 'native.boundary' : 'caption.case',
    Number(descriptor.caseId.slice(2)) > 24 ? 'WXs' : 'WJ', profile, descriptor,
    Number(descriptor.caseId.slice(2)) > 24 ? ['R33', 'R21'] : ['R36', 'R37', 'R38', 'R21'],
    { phaseBudgets: Number(descriptor.caseId.slice(2)) > 24 ? [phase('R33', 'text.admission', 10, 25)] :
      [phase('R36', 'composition.parse', 20, 50),
        ...(['WJ01', 'WJ02', 'WJ03', 'WJ16', 'WJ19'].includes(descriptor.caseId) ?
          [phase('R37', 'composition.project-serialize', 20, 50)] : [])] });
  for (const descriptor of FAST_CASES) cases(job, descriptor.caseId, 'fast.workflow', 'WF', profile,
    { ...descriptor, manifestIdentityRequired: true, fakeClock: 'scheduler-history-only' }, ['R21', 'R24', 'R25', 'R42'],
    { phaseBudgets: Number(descriptor.caseId.slice(2)) >= 7 && Number(descriptor.caseId.slice(2)) <= 12 ? [queuePhases[0]] : queuePhases });
  for (const bytes of [16 * MiB, 16 * MiB + 1]) operation(job, `raw-${bytes}`, 'caption.raw-ingest', 'WJ', profile,
    { bytes, envelope: true, splitUtf8AndEscapes: true, preserveOpaqueAboveParseLimit: true }, ['R38'],
    { phaseBudgets: [phase('R38', 'result.prompt-ingest-durable', 200, 500)] });
  for (const descriptor of CP_CASES) add(job, descriptor.caseId, 'capture.cp-fixture', 'W1', {
    kind: 'case', cold: 1, parameters: { ...descriptor, harnessAllowanceMs: 500,
      ...(descriptor.caseId === 'CP02' ? { includes: ['same-slot-passthrough', 'unsafe-regroup-108-vs-109',
        'multi-layer-new-document', 'merged-root-no-overlay', 'stale-source-stack'] } : {}) },
    budgets: ['R40'], requirements: { exactCanonicalEquality: true, noLatencyDistributionClaim: true },
  });
}

function textOperations(job, workloads, profile) {
  for (const workload of workloads) for (const op of ['font-set', 'mixed-ready', 'active-layout', 'apply']) {
    const normal = workload === 'WXn';
    const limits = op === 'font-set' ? [normal ? 1000 : 4000, normal ? 3000 : 10000] :
      op === 'mixed-ready' ? [normal ? 2000 : 8000, normal ? 5000 : 15000] :
        op === 'active-layout' ? [normal ? 50 : 100, normal ? 100 : 250] :
          [normal ? 3000 : 10000, normal ? 6000 : 20000];
    operation(job, `${workload}-${op}`, `text.${op}`, workload, profile,
      { fontCache: 'exact-hash', coldFontLayoutReset: true,
        ...(op === 'apply' ? { warmTargetMs: normal ? 500 : 2000, warmCeilingMs: normal ? 2000 : 6000 } : {}),
        ...(op === 'mixed-ready' ? { warmTargetMs: normal ? 1000 : 2000, warmCeilingMs: normal ? 2000 : 4000,
          ...(normal ? {} : { coldTextLayers: 75, allTextLayoutTargetMs: 1000, allTextLayoutCeilingMs: 3000 }) } : {}),
      }, ['R04', 'R34', 'R35', ...(op === 'mixed-ready' ? ['D11'] : [])],
      { phaseBudgets: [feedback, { ...phase(op === 'font-set' ? 'R35' : 'R34', `text.${op}`, ...limits),
        ...(['apply', 'mixed-ready'].includes(op) ? { cohorts: {
          cold: { targetMs: limits[0], ceilingMs: limits[1] },
          warm: op === 'apply' ? { targetMs: normal ? 500 : 2000, ceilingMs: normal ? 2000 : 6000 } :
            { targetMs: normal ? 1000 : 2000, ceilingMs: normal ? 2000 : 4000 },
        } } : {}),
      }] });
  }
  for (const scenario of TEXT_RECOVERY_SCENARIOS) cases(job, scenario, 'text.recovery', 'WXn', profile,
    { scenario }, ['R04', 'R33', 'R34', 'R35'], { phaseBudgets: [feedback] });
  for (const workload of workloads) add(job, `${workload}-IText`, 'text.interaction', workload, {
    kind: 'interaction', cold: profile === 'P' ? 0 : 1, warm: profile === 'P' ? 1 : 5,
    parameters: { durationMs: 60000, actions: textActions, feedbackReserveMs: 600,
      compositionEvents: 'synthetic', sameConnectedTextarea: true },
    requirements: { presentationTrace: true, nativeImeCertification: false, retainAll106Actions: true,
      firstUseCacheResetOncePerSession: true, warmPrimingRecordedSeparately: true,
      statistic: 'worst-session-p95', inpStatistic: 'lab-p75-per-warm-visit' },
    budgets: ['R04', 'R07', 'R08', 'R33', 'R34'], phaseBudgets: [feedback],
  });
}

function cpWebp(job, profile) {
  const workloads = profile === 'P' ? ['W1'] : ['W1', 'W2'];
  for (const workload of workloads) for (const codec of ['lossy', 'lossless']) for (const action of ['decode', 'import']) {
    const normal = workload === 'W1';
    operation(job, `${workload}-webp-${codec}-${action}`, action === 'decode' ? 'raster.decode' : 'raster.import', workload, profile,
      { format: 'webp', codec, static: true, originalRetained: true, alpha: true }, ['R41'],
      { phaseBudgets: [phase('R41', `raster.webp-${action}`, action === 'decode' ? (normal ? 100 : 400) : (normal ? 250 : 1000),
        action === 'decode' ? (normal ? 250 : 1000) : (normal ? 750 : 2000))] });
  }
  for (const workload of profile === 'P' ? ['WXn'] : ['WXn', 'WXs']) {
    const normal = workload === 'WXn';
    operation(job, `${workload}-capture`, 'capture.source', workload, profile,
      { canonicalProfile: 'CP-1', nativeText: true }, ['R40'],
      { phaseBudgets: [feedback, phase('R40', 'source.capture', normal ? 1000 : 4000, normal ? 2000 : 10000)] });
    for (const disposition of profile === 'P' ? ['expand'] : ['expand', 'clip']) operation(job,
      `${workload}-feather-${disposition}`, 'mask.feather-preview', workload, profile,
      { disposition, radius: 64, includesContainmentApproval: true }, ['R40'],
      { phaseBudgets: [feedback, phase('R40', 'mask.plan', normal ? 150 : 1000, normal ? 400 : 3000)] });
    if (profile === 'P') {
      operation(job, `${workload}-masked-prepare`, 'raster.masked-prepare', workload, profile,
        { canonicalProfile: 'CP-1', readiness: 'encoded-original-candidate-mask' }, ['R10', 'R12', 'R13', 'R15', 'R27'],
        { phaseBudgets: [phase('R15', 'result.prepare', 1000, 2500), ...preparationChildren(true)] });
      operation(job, `${workload}-masked-adopt-C`, 'raster.adopt', workload, profile,
        adoption('C'), ['R15', 'R20', 'R40'], { phaseBudgets: [feedback, phase('R15', 'result.adopt', 1500, 3000)] });
    }
    for (const format of ['png', 'jpeg']) operation(job, `${workload}-${format}-export`, 'raster.export', workload, profile,
      { format, quality: format === 'jpeg' ? 0.9 : null, nativeText: true, fullResolution: true }, ['R14', 'R40'],
      { phaseBudgets: [feedback, phase('R14', 'document.export', normal ? 1000 : 4000, normal ? 2000 : 8000)] });
  }
  if (profile === 'Q3') cases(job, 'actual-output-grid-mismatch', 'mask.output-mismatch', 'WXn', profile,
    { requireNewReview: true, preservePriorMaskBytes: true }, ['R04', 'R40'], { phaseBudgets: [feedback] });
}

function adoption(readiness) {
  return { readiness, originalCandidateMaskRetained: true,
    precondition: readiness === 'A' ? 'durable-prepared-composite-and-decoded-viewport-resident' :
      readiness === 'B' ? 'durable-prepared-composite-no-usable-decoded-viewport' : 'encoded-only-no-prepared-or-decoded-cache',
    retainPreClickPreparationReceipt: readiness !== 'C',
    resetRecomputableCachesBeforeEachAttempt: readiness === 'C',
    clock: 'accept-input-to-both-durable-receipt-and-correct-presented-pixels',
    allPostClickWorkInsideParent: true,
  };
}

function preparationChildren(normal) {
  return [phase('R10', 'raster.composite', normal ? 150 : 1000, normal ? 400 : 2500),
    phase('R12', 'raster.decode', normal ? 100 : 400, normal ? 250 : 1000),
    phase('R13', 'raster.encode', normal ? 250 : 2000, normal ? 750 : 5000),
    phase('R27', 'asset.persist-hash', normal ? 100 : 500, normal ? 200 : 1000)]
    .map((entry) => ({ ...entry, aggregation: 'maximum', scope: 'each-image-or-composite-child' }));
}

function rasterOperations(job, workload, profile) {
  const normal = workload === 'W1';
  const definitions = [
    ['O1', 'raster.stroke-finalize', { samples: 120 }, ['R09'], phase('R09', 'mask.stroke-finalize', normal ? 50 : 150, normal ? 150 : 400)],
    ['O2', 'raster.composite', { decodedInputReady: true }, ['R10'], phase('R10', 'raster.composite', normal ? 150 : 1000, normal ? 400 : 2500)],
    ['O3', 'raster.resize-preview', { longestPreviewSideMax: 1024, explicitApproval: true }, ['R04', 'R11'], phase('R11', 'raster.resize-preview', 100, 250)],
    ...['png', 'jpeg'].map((format, i) => [`O${4 + i}`, 'raster.decode', { format, encodedBytesReady: true }, ['R12'], phase('R12', 'raster.decode', normal ? 100 : 400, normal ? 250 : 1000)]),
    ...['png', 'jpeg'].map((format, i) => [`O${6 + i}`, 'raster.encode', { format, quality: format === 'jpeg' ? 0.9 : null }, ['R13'], phase('R13', 'raster.encode', normal ? 250 : 2000, normal ? 750 : 5000)]),
    ...['png', 'jpeg'].map((format, i) => [`O${8 + i}`, 'raster.export', { format, quality: format === 'jpeg' ? 0.9 : null, fullResolution: true }, ['R04', 'R14'], phase('R14', 'document.export', normal ? 1000 : 4000, normal ? 2000 : 8000)]),
    ['O10', 'raster.masked-prepare', { readiness: 'encoded-original-candidate-mask' }, ['R10', 'R12', 'R13', 'R15', 'R27'], phase('R15', 'result.prepare', normal ? 1000 : 5000, normal ? 2500 : 12000)],
    ...['A', 'B', 'C'].map((ready, i) => [`O${11 + i}`, 'raster.adopt', adoption(ready), ['R04', 'R15', 'R20'],
      phase('R15', 'result.adopt', (normal ? [100, 300, 1500] : [250, 750, 6000])[i], (normal ? [250, 750, 3000] : [750, 2000, 13000])[i])]),
    ['O14', 'state.snapshot-create', { snapshotTailMaximum: 500 }, ['R23'], phase('R23', 'document.snapshot-create', normal ? 100 : 500, normal ? 300 : 1000)],
    ['O15', 'state.snapshot-read', {}, ['R23'], phase('R23', 'document.snapshot-read', normal ? 100 : 500, normal ? 250 : 1000)],
    ['O16', 'state.replay', { mode: 'snapshot-tail', tailEvents: 500 }, ['R22'], phase('R22', 'document.replay', normal ? 250 : 1000, normal ? 750 : 2000)],
    ['O17', 'state.command-accept-dispatch', { independentCommandPerStart: true }, ['R20', 'R24'], null],
    ['O18', 'asset.persist', { bytes: normal ? 8 * MiB : 32 * MiB, incompressible: true }, ['R27'], phase('R27', 'asset.persist-hash', normal ? 100 : 500, normal ? 200 : 1000)],
    ['O19', 'asset.cache-lookup', { coldBranch: 'metadata-open-after-process-restart', warmBranch: 'identity-cache-lookup', unchangedAssetFetches: 0 }, ['R32'], phase('R32', 'asset.cache-lookup', 5, 20)],
  ];
  for (const [key, op, parameters, budgets, metric] of definitions) operation(job, `${workload}-${key}`, op, workload, profile,
    { ...parameters, retainedCandidates: normal ? 1 : 4, canonicalProfile: 'CP-1' }, budgets,
    { phaseBudgets: [...(budgets.includes('R04') ? [feedback] : []), ...(metric ? [metric] : [durable, ...queuePhases]),
      ...(key === 'O10' ? preparationChildren(normal) : []), ...(op === 'raster.adopt' ? [durable] : [])] });
}

function portableOperations(job, profile, sizes) {
  for (const closureBytes of sizes) for (const action of ['copy', 'import']) {
    // I12C deliberately retains the P-sized 3+3+1 cohort, not Q3-O 10+10+3.
    operation(job, `${closureBytes}-${action}`, `portable.${action}`, 'WC', 'P',
      { closureBytes, sourceArchivePresealed: action === 'import', events: closureBytes === 512 * MiB ? 10000 : 100000,
        assets: closureBytes === 512 * MiB ? 1000 : 10000, manifestBytesMax: 128 * MiB,
        repeatedCaptionVersions: closureBytes === 4 * GiB ? 4096 : null }, ['R38', 'R39'],
      { phaseBudgets: [phase('R39', `project.${action}`, closureBytes === 512 * MiB ? 8000 : 60000,
        closureBytes === 512 * MiB ? 15000 : 120000)],
        requirements: { fullClosureHashVerification: true, independentImportAndExportStarts: true,
          resetBeforeEveryStart: true, noHistoryTruncation: true, statistic: 'maximum' } });
  }
  if (profile === 'Q3') for (const direction of ['export', 'import']) for (const scenario of [
    'missing-closure', 'font-restriction', 'hash-mismatch', 'disk-pressure', 'interruption']) add(job,
    `${direction}-${scenario}`, 'portable.failure', 'WC', { kind: 'case', cold: 1,
      parameters: { direction, scenario, injection: 'early', harnessStopMs: 30000 }, budgets: ['R31', 'R38', 'R39'],
      requirements: { failurePreservesOriginal: true, neverPublishIncompleteAsComplete: true } });
}

function fastBrowser(job, profile, sizes) {
  for (const closureBytes of sizes) add(job, `reopen-${closureBytes}`, 'portable.reopen', 'WC', {
    kind: 'navigation', cold: profile === 'P' ? 1 : 3, warm: profile === 'P' ? 1 : 3, primes: 1,
    parameters: { closureBytes, independentLocalClosure: true }, budgets: ['R04', 'R34', 'R35', 'R38', 'R39'],
    requirements: { presentationTrace: true, exactFontsTextHistory: true, zeroReplayEffects: true,
      resetBeforeEveryStart: true, statistic: 'maximum' },
    phaseBudgets: [phase('R39', 'project.reopen', closureBytes === 512 * MiB ? 2000 : 8000,
      closureBytes === 512 * MiB ? 5000 : 15000)],
  });
  for (const descriptor of FAST_CASES.filter((_, i) => i < 6 || i > 11)) cases(job, descriptor.caseId,
    'fast.workflow', 'WF', profile, { ...descriptor, seedInsideEveryStart: true,
      sourceSessionJournalNeverReused: true, fakeClock: 'scheduler-history-only',
      validManifestSealed: true, faultResultBytes: 8 * MiB,
      publications: Number(descriptor.caseId.slice(2)) <= 6 ? 1 : 2,
      paints: Number(descriptor.caseId.slice(2)) <= 6 ? 2 : 4,
      completion: 'expected-authoritative-job-state-paint-and-immutable-receipt',
    }, ['R04', 'R24', 'R38', 'R42'], { phaseBudgets: [feedback, ...queuePhases] });
}

function pJobs(features, cache) {
  const limits = {
    C0: [30, 60], C1: cache === 'cold' ? [120, 240] : [60, 120], C2: [40, 80], C3: [15, 45],
    C4: [17, 35], C5: [35, 70], C6: cache === 'cold' ? [180, 315] : [100, 210], C7: [90, 240],
    C8: [15, 30], C9: [180, 300], C10: [150, 300], H0: cache === 'cold' ? [180, 420] : [30, 60],
    H1: [45, 90], H2: [75, 120], H3: [180, 480], H4: [180, 480], H5: [160, 240], H6: [30, 60],
    H7: [180, 300], H8: [90, 180], H9: [120, 240], H10: [160, 240],
    AC0: [20, 30], AC1: [60, 120], AC2: [150, 240], AC3: [10, 20],
    AH0: [20, 30], AH1: [20, 30], AH2: [150, 240], AH3: [10, 20],
  };
  const jobs = requiredCampaignJobs('P', features).map((id) => ({ id, host: id.startsWith('H') || id.startsWith('AH') ? 'H' : 'C',
    dependsOn: [], targetMs: limits[id][0] * 1000, ceilingMs: limits[id][1] * 1000, cells: [] }));
  const find = (id) => jobs.find((job) => job.id === id);
  chain(jobs, P_C); chain(jobs, P_H); find('H0').dependsOn = ['C2'];
  dev(find('C0'), 'setup', 'developer.setup', { revisionNative: true, verifyVendor: true }, [], { kind: 'setup' });
  dev(find('C1'), 'clean-install', 'developer.command', { commandId: 'D01', command: 'clean-install', cache,
    nodeModulesAbsent: true }, ['D01'], { cold: cache === 'cold' ? 1 : 0, warm: cache === 'normal' ? 1 : 0 });
  dev(find('C2'), 'full-types', 'developer.command', { commandId: 'D04', command: 'full-types', freshBuildInfo: true }, ['D04']);
  dev(find('C2'), 'production-build', 'developer.command', { commandId: 'D03', command: 'production-build', freshOutputs: true,
    emitArtifactAndByteManifest: true }, ['D03', 'D11']);
  for (const editScope of ['public-leaf', 'domain-type']) dev(find('C3'), editScope, 'developer.command',
    { commandId: 'D04', command: 'incremental-edit-scope', editScope,
      commands: ['incremental-types', 'incremental-build'], primePrerequisite: true,
      restoreAndRebuildBeforeNextScope: true }, ['D04'], { cold: 0, warm: 1 });
  for (const [id, area, focusedCases, fullEnvelope] of [['C4', 'unit', 100, 2000], ['C5', 'integration', 10, 100], ['C6', 'browser', 5, 30]]) {
    if (id === 'C6') dev(find(id), 'browser-cache', 'developer.command', { commandId: 'D02',
      command: cache === 'cold' ? 'browser-provision' : 'browser-verify', browsers: ['chromium'], cache }, ['D02'],
    { cold: cache === 'cold' ? 1 : 0, warm: cache === 'normal' ? 1 : 0 });
    for (const focused of [true, false]) dev(find(id), `${focused ? 'focused' : 'full'}-${area}`, 'developer.command',
      { commandId: focused ? 'D06' : 'D07', command: `${focused ? 'focused' : 'full'}-${area}`,
        exactSelectionManifestRequired: true, ...(focused ? { expectedCases: focusedCases } : { declaredSizingEnvelope: fullEnvelope,
          neverPruneToEnvelope: true }), ...(area === 'browser' ? { browsers: ['chromium'] } : {}) }, [focused ? 'D06' : 'D07']);
  }
  queue(find('C7'), 'P'); captionFast(find('C9'), 'P'); portableOperations(find('C10'), 'P', [512 * MiB]);
  dev(find('C8'), 'audit', 'developer.audit', { verifyCounts: true, uploadReceipts: true, cacheRatioClaim: false }, ['D10'], { kind: 'audit' });
  dev(find('H0'), 'setup', 'developer.setup', { revisionNative: true, cache, ownNativeDependencies: true,
    artifactFrom: 'C2', startLocalBackend: true }, [], { kind: 'setup' });
  navigation(find('H1'), 'W0', 3, 3, 1); navigation(find('H1'), 'W1', 3, 3, 1);
  brush(find('H2'), 'W1', 'native', 0, 1);
  add(find('H2'), 'first-use', 'interaction.first-use', 'W1', { kind: 'interaction', cold: 10,
    parameters: { windowMs: 1000, gesturesPerStart: 1, resetFeatureCacheBeforeEachStart: true },
    requirements: { presentationTrace: true }, budgets: ['R04', 'R06'], phaseBudgets: [feedback] });
  add(find('H2'), 'hot-update', 'developer.hot-update', 'W1', { warm: 3, parameters: { fixedEdit: 'shell-component', developerWorkload: 'WD',
    devServerWarm: true, documentPreserved: true }, requirements: { presentationTrace: true }, budgets: ['D05'],
    phaseBudgets: [phase('D05', 'developer.hot-update-visible', 200, 500)] });
  rasterOperations(find('H3'), 'W1', 'P'); queue(find('H4'), 'P'); lifecycle(find('H5'), 'W1', 2);
  textOperations(find('H7'), ['WXn'], 'P'); cpWebp(find('H8'), 'P'); fastBrowser(find('H9'), 'P', [512 * MiB]);
  lifecycle(find('H10'), 'WXn', 2);
  dev(find('H6'), 'audit', 'developer.audit', { verifyCounts: true, tracesAndProvenance: true, uploadReceipts: true }, [], { kind: 'audit' });
  if (features === 'adapters') {
    chain(jobs, ['AC0', 'AC1', 'AC2', 'AC3']); chain(jobs, ['AH0', 'AH1', 'AH2', 'AH3']);
    for (const id of ['AC0', 'AH0']) {
      find(id).dependsOn = ['C8', 'H6'];
      add(find(id), 'setup', 'adapter.setup', 'WA', { kind: 'setup', handler: 'adapters', cold: 1,
        parameters: { revisionNative: true, sealedHashes: true }, budgets: ['T05'] });
    }
    adapterImport(find('AC1'), 'P', 256 * MiB); adapterSelect(find('AH1'), 'P');
    lifecycle(find('AC2'), 'WA', 2, true); lifecycle(find('AH2'), 'WA', 2, true);
    for (const id of ['AC3', 'AH3']) add(find(id), 'audit', 'adapter.audit', 'WA', { kind: 'audit', handler: 'adapters', cold: 1,
      parameters: { verifyCounts: true, retainReceipts: true }, budgets: ['T05', 'T06'] });
  }
  return jobs;
}

function navigation(job, workload, cold, warm, primes, browser = 'chromium') {
  add(job, `${browser}-${workload}-ready`, 'navigation.ready', workload, { kind: 'navigation', cold, warm, primes,
    parameters: { browser, freshProfileProcessForCold: true, coldHttpServiceWorkerCodeCachesEmpty: true,
      warmShellCache: true, originalsAlreadyOnDurableDisk: true },
    requirements: { presentationTrace: true, actualAcceptedTestEdit: true, osCacheRecorded: true,
      webVitalsPerVisit: true, statistic: cold === 30 ? 'lab-p75-per-cache-and-maximum' : 'maximum',
      ...(browser === 'chromium' ? {} : { claim: 'compatibility-smoke-only' }) },
    budgets: ['R01', 'R03', 'R04', 'R05', ...(['W0', 'W1'].includes(workload) ? ['D11'] : [])], phaseBudgets: [phase('R04', 'ui.native-shell', 300, 750)],
  });
}
function brush(job, workload, mode, cold, warm, browser = 'chromium') {
  add(job, `${browser}-${workload}-${mode}-I`, 'interaction.brush', workload, { kind: 'interaction', cold, warm,
    parameters: { browser, mode, durationMs: 60000, gestures: 100, strokes: 20,
      strokeSamples: 120, strokeHz: 60, brushPixels: 64, discreteGestures: 80 },
    requirements: { presentationTrace: true, frameAttribution: true, firstUseCacheResetOncePerSession: true,
      warmPrimingRecordedSeparately: true, statistic: 'worst-session-p95', inpStatistic: 'lab-p75-per-warm-visit',
      ...(browser === 'chromium' ? {} : { claim: 'compatibility-smoke-only' }) },
    budgets: ['R02', 'R04', 'R06', 'R07', 'R16', ...(mode === 'native' ? [] : ['R08'])],
    phaseBudgets: [feedback, phase('R07', 'frame.app-work', 8, 10)],
  });
}

function adapterImport(job, profile, bytes) {
  operation(job, `${bytes}-import`, 'adapter.import', 'WA', profile, { bytes, configBytesMax: MiB,
    streamWeights: true, browserLoadsTensors: false }, ['T05', 'T06', 'R17', 'R18'], { handler: 'adapters',
    phaseBudgets: [phase('T05', 'adapter.import-durable', bytes === 256 * MiB ? 4000 : 16000, bytes === 256 * MiB ? 8000 : 30000)] });
}
function adapterSelect(job, profile) {
  operation(job, 'library-select', 'adapter.select', 'WA', profile,
    { entries: 100, selectedMaximum: 3, unchangedAssetFetches: 0 }, ['R04', 'R32', 'T05', 'T06'], { handler: job.host === 'H' ? 'browser' : 'adapters',
      phaseBudgets: [feedback, phase('T05', 'adapter.selection-paint', 50, 150)] });
}

function qJobs(features) {
  const limits = { I0: [55, 105], I1: [120, 200], I2: [120, 200], I3: [40, 60], I4: [75, 120],
    I5a: [155, 165], I5b: [155, 165], I6C: [25, 40], I6H: [25, 40], I7N: [20, 30],
    I7A: [100, 140], I8C: [15, 20], I8H: [15, 20], I10C: [20, 30], I10H: [35, 55],
    I11H: [25, 45], I12C: [30, 45], I12H: [15, 25], I13H: [155, 165] };
  const jobs = requiredCampaignJobs('Q3', features).map((id) => ({ id,
    host: id === 'I0' ? 'C+H' : id.startsWith('I7') ? 'C+N' : Q_H.includes(id) ? 'H' : 'C',
    dependsOn: [], targetMs: limits[id][0] * 60000, ceilingMs: limits[id][1] * 60000, cells: [] }));
  const find = (id) => jobs.find((job) => job.id === id);
  chain(jobs, ['I0', 'I1', 'I2', 'I6C', 'I7N', ...(features === 'adapters' ? ['I7A', 'I8C'] : []), 'I10C', 'I12C']);
  chain(jobs, ['I0', 'I3', 'I4', 'I5a', 'I5b', 'I6H', ...(features === 'adapters' ? ['I8H'] : []), 'I10H', 'I11H', 'I12H', 'I13H']);
  for (const cache of ['normal', 'cold']) dev(find('I0'), `core-${cache}`, 'developer.core-pipeline',
    { campaign: 'P', features: 'core', cache, recursiveQualification: false, participatingHosts: ['C', 'H'] }, ['D08'],
    { cold: cache === 'cold' ? 1 : 0, warm: cache === 'normal' ? 1 : 0,
      requirements: { independentPipelines: true, completeCoreGraphIncludingPN: true, multiHostRouterRequired: true } });
  dev(find('I1'), 'command-groups', 'developer.command-group', {
    commands: ['clean-install', 'full-types', 'production-build', 'incremental-public-leaf', 'incremental-domain-type',
      'focused-unit', 'full-unit', 'focused-integration', 'full-integration', 'browser-provision-or-verify',
      'focused-browser', 'full-browser', 'artifact-audit'], browsers: ['chromium', 'firefox', 'webkit'],
    testBrowser: 'chromium', independentFromI0: true, restoreBetweenEditScopes: true,
    freshSetupEachGroup: true, commandGroupCeilingMs: 1200000,
  }, ['D01', 'D02', 'D03', 'D04', 'D06', 'D07', 'D10', 'D11'], { cold: 5, warm: 5,
    requirements: { pairedOrder: 'alternate-base-candidate', statistic: 'median-target-maximum-ceiling',
      exactCaseSelectionRequired: true, noNestedWholePipeline: true } });
  dev(find('I2'), 'archive-update', 'developer.archive-update', { sourceNpmCiEveryStart: true,
    producerNestedInConsumerUpdate: true, producerCeilingMs: 600000, updateCeilingMs: 900000,
    sourceInstallCeilingMs: 240000, resetReceiptAllowanceMs: 60000 }, ['D09'], { cold: 5, warm: 5,
    requirements: { statistic: 'median-target-maximum-ceiling',
      reuseOnlyIdenticalPriorQualifiedArchiveReceipt: true, firstArchiveMayNotSkip: true } });
  for (const workload of ['W0', 'W1']) navigation(find('I3'), workload, 30, 30, 1);
  navigation(find('I3'), 'W2', 30, 0, 0);
  brush(find('I3'), 'W1', 'native', 1, 5); brush(find('I3'), 'W2', 'native', 1, 5);
  brush(find('I3'), 'W2', 'worker-offscreen-disabled', 1, 5); brush(find('I3'), 'W2', 'context-loss', 1, 5);
  operation(find('I3'), 'hot-update', 'developer.hot-update', 'W1', 'Q3',
    { fixedEdit: 'shell-component', developerWorkload: 'WD', devServerWarm: true, documentPreserved: true }, ['D05'],
    { phaseBudgets: [phase('D05', 'developer.hot-update-visible', 200, 500)] });
  for (const browser of ['firefox', 'webkit']) {
    navigation(find('I3'), 'W1', 3, 3, 1, browser); brush(find('I3'), 'W1', 'native', 0, 1, browser);
    add(find('I3'), `${browser}-first-use`, 'interaction.first-use', 'W1', { kind: 'interaction', cold: 10,
      parameters: { browser, windowMs: 1000, gesturesPerStart: 1, resetFeatureCacheBeforeEachStart: true },
      requirements: { presentationTrace: true, claim: 'compatibility-smoke-only' }, budgets: ['R04', 'R06'] });
    add(find('I3'), `${browser}-hot-update`, 'developer.hot-update', 'W1', { warm: 3,
      parameters: { browser, fixedEdit: 'shell-component', developerWorkload: 'WD', devServerWarm: true, documentPreserved: true },
      requirements: { presentationTrace: true, claim: 'compatibility-smoke-only' }, budgets: ['D05'],
      phaseBudgets: [phase('D05', 'developer.hot-update-visible', 200, 500)] });
  }
  rasterOperations(find('I4'), 'W1', 'Q3'); rasterOperations(find('I4'), 'W2', 'Q3');
  operation(find('I4'), 'W2-approved-full-resample', 'raster.resample', 'W2', 'Q3',
    { width: 2048, height: 2048, sourceAndMaskAligned: true, explicitlyApproved: true }, ['R04', 'R11'],
    { phaseBudgets: [feedback, phase('R11', 'raster.approved-resample', 1000, 2000)] });
  operation(find('I4'), 'W2-full-replay', 'state.replay', 'W2', 'Q3',
    { mode: 'full', events: 100000, snapshot: false, zeroReplayEffects: true }, ['R22'],
    { phaseBudgets: [phase('R22', 'document.full-replay', 5000, 10000)] });
  for (const action of ['select', 'scroll', 'reorder']) operation(find('I4'), `large-list-${action}`, 'layers.large-list', 'W2', 'Q3',
    { action, metadataRows: 1000, mountedRowsTarget: 60, mountedRowsCeiling: 100 }, ['R04', 'R16'],
    { phaseBudgets: [feedback, phase('R16', 'ui.completed-list-paint', 100, 250)] });
  for (const format of ['png', 'jpeg']) operation(find('I4'), `narrow-${format}-decode`, 'raster.decode', 'WNarrow', 'Q3',
    { format, width: 8192, height: 3000, fixtureVariant: 'narrow', encodedBytesReady: true }, ['R12'],
    { phaseBudgets: [phase('R12', 'raster.decode', 400, 1000)] });
  lifecycle(find('I5a'), 'W1', 100); lifecycle(find('I5b'), 'W2', 100);
  // PERF states 310/330 minutes for the combined pair, not independent gates.
  for (const id of ['I5a', 'I5b']) { find(id).combinedBudget = { jobs: ['I5a', 'I5b'], targetMs: 310 * 60000, ceilingMs: 330 * 60000 };
    delete find(id).targetMs; delete find(id).ceilingMs; }
  queue(find('I6C'), 'Q3'); queue(find('I6H'), 'Q3');
  for (const bytes of [8 * MiB, 32 * MiB]) for (const direction of ['upload', 'download']) operation(find('I7N'),
    `${bytes}-${direction}`, 'transfer.asset', bytes === 8 * MiB ? 'W1' : 'W2', 'Q3',
    { bytes, direction, networkProfile: 'N', freshTransferKey: true, cacheMeaning: 'process-connection-file-state' }, ['R28', 'R31'],
    { requirements: { actualBytesTransferred: true, warmOwnedZeroFetchIsNotThroughput: true,
      transferBuffersCeilingBytes: 16 * MiB, networkShapeRequired: true },
      phaseBudgets: [phase('R28', 'asset.transfer-durable', direction === 'upload' ? (bytes === 8 * MiB ? 4000 : 15000) :
        (bytes === 8 * MiB ? 1000 : 3500), direction === 'upload' ? (bytes === 8 * MiB ? 6000 : 20000) : (bytes === 8 * MiB ? 2000 : 5000))] });
  if (features === 'adapters') {
    for (const [bytes, direction, targetMs, ceilingMs] of [[256 * MiB, 'upload', 120000, 150000],
      [256 * MiB, 'download', 25000, 35000], [GiB, 'download', 95000, 130000]]) operation(find('I7A'),
      `${bytes}-${direction}`, 'adapter.transfer', 'WA', 'Q3', { bytes, direction, configBytesMax: MiB,
        networkProfile: 'N', freshTransferKey: true, cacheMeaning: 'process-connection-file-state' }, ['T06', 'R31'],
      { handler: 'adapters', requirements: { actualBytesTransferred: true, networkShapeRequired: true,
        warmOwnedZeroFetchIsNotThroughput: true }, phaseBudgets: [phase('T06', 'adapter.transfer-durable', targetMs, ceilingMs)] });
    adapterImport(find('I8C'), 'Q3', 256 * MiB); adapterImport(find('I8C'), 'Q3', GiB);
    adapterSelect(find('I8H'), 'Q3'); lifecycle(find('I8C'), 'WA', 2, true); lifecycle(find('I8H'), 'WA', 2, true);
  }
  captionFast(find('I10C'), 'Q3'); textOperations(find('I10H'), ['WXn', 'WXs'], 'Q3');
  for (const [workload, inputSource] of [['WXn', 'japanese'], ['WXs', 'simplified-chinese']]) add(find('I10H'), inputSource,
    'text.native-ime', workload, { kind: 'manual', cold: 1, parameters: { inputSource, durationMs: 60000,
      compositionSequences: 10, commits: 8, cancels: 2, presentationRequests: 6,
      presentations: ['forward-range', 'backward-range', 'collapsed-range', 'superseded-deferred-switch', 'latest-deferred-switch', 'deferred-cancel'],
      staleSessionRejectionAssertions: true, staleAssertionsAddNoPresentationRequest: true },
      requirements: { realOsIme: true, syntheticEventsMayNotSubstitute: true, nativeEventOrdering: true,
        retainOsInputSourceBuildDictionarySettings: true, presentationTrace: true,
        operatorThinkTimeExcludedFromInputLatency: true, languageDistributionClaim: false }, budgets: ['R04', 'R34'],
      phaseBudgets: [feedback] });
  cpWebp(find('I11H'), 'Q3'); portableOperations(find('I12C'), 'Q3', [512 * MiB, 4 * GiB]);
  fastBrowser(find('I12H'), 'Q3', [512 * MiB, 4 * GiB]); lifecycle(find('I13H'), 'WXs', 100);
  return jobs;
}

function chain(jobs, ids) {
  for (let i = 1; i < ids.length; i++) jobs.find((job) => job.id === ids[i]).dependsOn.push(ids[i - 1]);
}

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Make a finite per-revision plan. Selecting jobs never implies omitted jobs passed. */
export function makeCampaignPlan({ campaign, features = 'adapters', jobs: selection, cache = 'normal' } = {}) {
  validateProfile(campaign, features);
  if (!['normal', 'cold'].includes(cache)) throw new Error('CAMPAIGN_CACHE_INVALID');
  const requiredJobIds = requiredCampaignJobs(campaign, features);
  if (selection !== undefined && (!Array.isArray(selection) || !selection.length || selection.some((id) => typeof id !== 'string'))) {
    throw new Error('CAMPAIGN_SELECTION_INVALID');
  }
  const chosen = selection ?? requiredJobIds;
  if (new Set(chosen).size !== chosen.length) throw new Error('CAMPAIGN_DUPLICATE_JOB');
  for (const id of chosen) if (!requiredJobIds.includes(id)) throw new Error(`CAMPAIGN_JOB_UNSUPPORTED: ${id}`);
  const all = campaign === 'P' ? pJobs(features, cache) : qJobs(features);
  if (all.length !== requiredJobIds.length || new Set(all.map((job) => job.id)).size !== requiredJobIds.length ||
      all.some((job) => !requiredJobIds.includes(job.id))) throw new Error('CAMPAIGN_INVENTORY_MISMATCH');
  const jobs = all.filter((job) => chosen.includes(job.id));
  const cells = jobs.flatMap((job) => job.cells.map((cell) => ({ ...cell, jobId: job.id })));
  if (new Set(cells.map((cell) => cell.id)).size !== cells.length) throw new Error('CAMPAIGN_DUPLICATE_CELL');
  for (const cell of cells) for (const field of ['cold', 'warm', 'primes']) {
    if (!Number.isSafeInteger(cell[field]) || cell[field] < 0) throw new Error('CAMPAIGN_BAD_SAMPLE_COUNT');
  }
  return freeze({ version: 1, spec: CAMPAIGN_SPEC, campaign, features, cache,
    support: 'declared-execution-requirements', qualification: 'unmeasured',
    revisionScope: 'one-revision', requiredJobIds, selectedJobIds: jobs.map((job) => job.id),
    omittedJobIds: requiredJobIds.filter((id) => !chosen.includes(id)),
    scheduling: { physicalHosts: ['C', 'H'], maximumActiveTimedJobsPerHost: 1,
      networkShape: { id: 'N', downMbps: 100, upMbps: 20, rttMs: 40, lossPercent: 0 },
      baseBeforeCandidate: true, firstBaseline: 'candidate-only',
      featureBranchesAfterBothCoreRevisions: campaign === 'P',
      i0HasExactlyTwoCorePipelines: campaign === 'Q3', noRecursiveD08: true },
    jobs, cells, extraAuditCohorts: declareByteAuditCohorts(jobs),
  });
}
