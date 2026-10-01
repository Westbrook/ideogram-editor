import assert from 'node:assert/strict';
import test from 'node:test';
import { makeCampaignPlan, requiredCampaignJobs } from '../../tooling/qualification/campaigns/inventory.mjs';

const P = makeCampaignPlan({ campaign: 'P', features: 'adapters' });
const Q = makeCampaignPlan({ campaign: 'Q3', features: 'adapters' });
const job = (plan, id) => plan.jobs.find((entry) => entry.id === id);
const cells = (plan, id, predicate = () => true) => job(plan, id).cells.filter(predicate);
const operation = (name) => (cell) => cell.operation === name;
const counts = (entries) => entries.reduce((sum, cell) => ({
  cold: sum.cold + cell.cold, warm: sum.warm + cell.warm, primes: sum.primes + cell.primes,
}), { cold: 0, warm: 0, primes: 0 });
const total = (entries) => entries.reduce((sum, cell) => sum + cell.cold + cell.warm + cell.primes, 0);

test('the finite P and Q3 inventory includes adapter capability independently of training', () => {
  assert.equal(P.jobs.length, 30);
  assert.equal(Q.jobs.length, 19);
  assert.equal(makeCampaignPlan({ campaign: 'P', features: 'core' }).jobs.length, 22);
  assert.equal(makeCampaignPlan({ campaign: 'Q3', features: 'core' }).jobs.length, 16);
  assert.throws(() => makeCampaignPlan({ campaign: 'P', features: 'training' }), /TRAINING_CAMPAIGN_UNIMPLEMENTED/);
  assert.throws(() => makeCampaignPlan({ campaign: 'Q3', features: 'training' }), /TRAINING_CAMPAIGN_UNIMPLEMENTED/);
  assert.equal(P.qualification, 'unmeasured');
  assert.equal(Q.qualification, 'unmeasured');
});

test('selected jobs retain omitted required work and reject undefined/duplicate input', () => {
  const selected = makeCampaignPlan({ campaign: 'Q3', features: 'adapters', jobs: ['I10H', 'I11H'] });
  assert.deepEqual(selected.selectedJobIds, ['I10H', 'I11H']);
  assert.equal(selected.omittedJobIds.length, 17);
  assert.equal(selected.requiredJobIds.length, 19);
  assert.throws(() => makeCampaignPlan({ campaign: 'P', jobs: ['C9', 'C9'] }), /DUPLICATE_JOB/);
  assert.throws(() => makeCampaignPlan({ campaign: 'P', jobs: ['I10H'] }), /JOB_UNSUPPORTED/);
  assert.throws(() => makeCampaignPlan({ campaign: 'Q3', features: 'core', jobs: ['I7A'] }), /JOB_UNSUPPORTED/);
  assert.throws(() => makeCampaignPlan({ campaign: 'Q3', jobs: [] }), /SELECTION_INVALID/);
  assert.throws(() => makeCampaignPlan({ campaign: 'E' }), /CAMPAIGN_UNSUPPORTED/);
});

test('all cells have finite immutable independent identities and known executable handler contracts', () => {
  for (const plan of [P, Q]) {
    assert.equal(new Set(plan.cells.map((cell) => cell.id)).size, plan.cells.length);
    assert.deepEqual(new Set(plan.jobs.map((entry) => entry.id)), new Set(requiredCampaignJobs(plan.campaign)));
    for (const cell of plan.cells) {
      assert.ok(['C', 'H', 'C+N', 'C+H'].includes(cell.host));
      assert.ok(['backend', 'browser', 'adapters', 'developer'].includes(cell.handler));
      assert.ok(cell.operation.includes('.'));
      assert.ok(cell.cold + cell.warm > 0);
      assert.ok([cell.cold, cell.warm, cell.primes].every(Number.isSafeInteger));
      assert.equal(cell.requirements.providerCalls, 0);
      assert.equal(cell.requirements.retainEveryOutcome, true);
      assert.ok(Object.isFrozen(cell.parameters));
      for (const phase of cell.phaseBudgets) {
        assert.ok(phase.targetMs <= phase.ceilingMs);
        assert.ok(cell.budgets.includes(phase.id), `${cell.id} phase ${phase.id} must have an owning budget`);
        if (phase.phase === 'ui.feedback') assert.equal(phase.aggregation, 'maximum');
      }
      if (!['setup', 'audit'].includes(cell.kind)) for (const id of cell.budgets) {
        assert.ok(id.startsWith('D') || cell.phaseBudgets.some((entry) => entry.id === id) ||
          cell.requiredMeasurements.some((entry) => entry.budgetId === id), `${cell.id}: ${id} must require a measurement`);
      }
    }
  }
});

test('P-S and P-I preserve navigations, warm primes, strokes, first-use windows and hot edits', () => {
  assert.deepEqual(counts(cells(P, 'H1')), { cold: 6, warm: 6, primes: 2 });
  const brush = cells(P, 'H2', operation('interaction.brush'))[0];
  assert.equal(total([brush]), 1);
  assert.equal(brush.parameters.durationMs, 60000);
  assert.equal(brush.parameters.strokes, 20);
  assert.equal(brush.parameters.strokeSamples, 120);
  assert.equal(brush.parameters.discreteGestures, 80);
  const firstUse = cells(P, 'H2', operation('interaction.first-use'))[0];
  assert.equal(firstUse.cold, 10);
  assert.equal(firstUse.parameters.windowMs, 1000);
  assert.equal(total(cells(P, 'H2', operation('developer.hot-update'))), 3);
});

test('P-O is exactly nineteen independent operation cells; A/B/C clocks stay distinct', () => {
  const raster = cells(P, 'H3');
  assert.equal(raster.length, 19);
  assert.deepEqual(counts(raster), { cold: 57, warm: 57, primes: 19 });
  const adopt = raster.filter(operation('raster.adopt'));
  assert.deepEqual(adopt.map((cell) => cell.parameters.readiness), ['A', 'B', 'C']);
  assert.equal(new Set(adopt.map((cell) => cell.parameters.precondition)).size, 3);
  for (const cell of adopt) {
    assert.equal(cell.parameters.clock, 'accept-input-to-both-durable-receipt-and-correct-presented-pixels');
    assert.equal(cell.parameters.allPostClickWorkInsideParent, true);
  }
  const command = raster.find(operation('state.command-accept-dispatch'));
  assert.equal(total([command]), 7);
  assert.deepEqual(command.phaseBudgets.map((entry) => entry.id), ['R20', 'R24', 'R24', 'R24']);
});

test('P-Q and Q3-Q keep independently seeded backend/browser families and the exact compound trace', () => {
  for (const [plan, backend, browser, each] of [[P, 'C7', 'H4', 6], [Q, 'I6C', 'I6H', 20]]) {
    for (const id of [backend, browser]) {
      const faults = cells(plan, id, operation('queue.fault'));
      assert.equal(faults.length, 9);
      assert.equal(total(faults), each * 9);
      assert.equal(faults.reduce((sum, cell) => sum + cell.primes, 0), 0);
    }
    assert.equal(total(cells(plan, browser, operation('startup.failure'))), 3 * each);
    assert.equal(total(cells(plan, backend, operation('queue.proxy-pair'))), 6);
    assert.equal(total(cells(plan, backend, operation('queue.healthy-polling'))), 3);
    const compound = cells(plan, browser).find((cell) => cell.parameters.scenario === 'cancel-late-result');
    assert.equal(compound.parameters.publications, 4);
    assert.equal(compound.parameters.paints, 6);
    assert.equal(compound.parameters.milestones.length, 6);
  }
  assert.equal(total(cells(P, 'H4', operation('transfer.asset'))), 6);
  assert.equal(total(cells(P, 'H4', operation('queue.healthy-polling'))), 3);
  assert.equal(cells(Q, 'I6H', operation('transfer.asset')).length, 0);
  assert.equal(cells(Q, 'I6H', operation('queue.healthy-polling')).length, 0);
});

test('a rejected request never requires a successful dispatch and fault phases remain scenario-specific', () => {
  const faults = cells(Q, 'I6C', operation('queue.fault'));
  const phases = (scenario) => faults.find((cell) => cell.parameters.scenario === scenario).phaseBudgets.map((rule) => rule.phase);
  assert.deepEqual(phases('disk-full-admission'), ['command.validate']);
  assert.equal(phases('lost-ack').includes('job.reconnect-start'), false);
  assert.equal(phases('lost-ack').includes('result.retrieval-start'), false);
  assert.ok(phases('browser-restart').includes('job.reconnect-start'));
  assert.equal(phases('browser-restart').includes('result.retrieval-start'), false);
  assert.ok(phases('expiry').includes('result.retrieval-start'));
  for (let i = 7; i <= 12; i++) {
    const cell = cells(Q, 'I10C').find((entry) => entry.parameters.caseId === `WF${String(i).padStart(2, '0')}`);
    assert.deepEqual(cell.phaseBudgets.map((rule) => rule.phase), ['command.validate']);
  }
  for (const id of ['WJ04', 'WJ12', 'WJ14']) {
    const cell = cells(Q, 'I10C').find((entry) => entry.parameters.caseId === id);
    assert.deepEqual(cell.phaseBudgets.map((rule) => rule.phase), ['composition.parse']);
  }
});

test('R26 measurements belong to existing status, observer and terminal specimens', () => {
  const terminalScenarios = new Set(['cancel-late-result', 'expiry', 'offline-completion']);
  const names = cell => cell.requiredMeasurements.filter(rule => rule.budgetId === 'R26').map(rule => rule.name).sort();
  for (const [plan, ids] of [[P, ['C7', 'H4']], [Q, ['I6C', 'I6H']]]) {
    for (const id of ids) {
      for (const cell of cells(plan, id, operation('queue.fault'))) {
        const scenario = cell.parameters.scenario;
        const expected = ['lost-ack', 'disk-full-admission'].includes(scenario) ? [] : ['R26StatusMessageBytes'];
        if (terminalScenarios.has(scenario)) expected.push('R26LostTerminalStateCount');
        assert.deepEqual(names(cell), expected.sort(), cell.id);
        assert.equal(cell.budgets.includes('R26'), expected.length > 0, cell.id);
      }
      for (const cell of cells(plan, id, operation('queue.proxy-pair'))) assert.deepEqual(names(cell), ['R26StatusMessageBytes']);
      for (const cell of cells(plan, id, operation('queue.healthy-polling'))) {
        assert.deepEqual(names(cell), ['R26ObserverBytesPerMinute', 'R26StatusMessageBytes']);
        assert.equal(cell.parameters.durationMs, 10000);
      }
    }
    const owned = new Set(ids.flatMap(id => cells(plan, id).flatMap(names)));
    assert.deepEqual([...owned].sort(), ['R26LostTerminalStateCount', 'R26ObserverBytesPerMinute', 'R26StatusMessageBytes']);
  }
});

test('rejected-draft proof stays owned by actual WQ and Fast admission rejection', () => {
  const required = cell => cell.requiredMeasurements.some(rule => rule.name === 'R25RejectedDraftLossCount');
  for (const [plan, queueIds, fastId] of [[P, ['C7', 'H4'], 'C9'], [Q, ['I6C', 'I6H'], 'I10C']]) {
    for (const id of queueIds) {
      const owners = cells(plan, id).filter(required);
      assert.equal(owners.length, 1); assert.equal(owners[0].parameters.scenario, 'disk-full-admission');
    }
    const fast = cells(plan, fastId, operation('fast.workflow'));
    assert.deepEqual(fast.filter(required).map(cell => cell.parameters.caseId), ['WF07', 'WF08', 'WF09', 'WF10', 'WF11', 'WF12']);
    assert.equal(fast.length, 16);
  }
});

test('R31 capacity recheck gaps belong to scheduled transfers and keep admission proof separate', () => {
  const name = 'R31TransferCapacityRecheckGapMs';
  const capacityRules = cell => cell.requiredMeasurements.filter(rule => rule.budgetId === 'R31');
  for (const plan of [P, Q]) {
    const all = plan.jobs.flatMap(job => job.cells);
    const transfers = all.filter(cell => ['transfer.asset', 'adapter.transfer'].includes(cell.operation));
    assert.ok(transfers.length > 0);
    for (const cell of transfers) {
      assert.ok(cell.budgets.includes('R31'), cell.id);
      assert.deepEqual(capacityRules(cell).map(rule => rule.name), [name], cell.id);
      assert.equal(capacityRules(cell)[0].ceiling, 30000);
    }
    assert.deepEqual(all.filter(cell => capacityRules(cell).some(rule => rule.name === name)).map(cell => cell.id), transfers.map(cell => cell.id));
    for (const cell of all.filter(cell => cell.operation === 'queue.fault' && cell.parameters.scenario === 'disk-full-admission')) {
      assert.deepEqual(capacityRules(cell).map(rule => rule.name), [
        'R31WarningAtUsedShare', 'R31AdmittedAt90PercentOrWithoutReservationCount',
        'R31Missing1GiBMarginOrRecoveryReserveCount', 'R31ReservationOutsidePredicted25To100PercentOverheadCount',
      ], cell.id);
    }
  }
  assert.equal(total(cells(P, 'H4', operation('transfer.asset'))), 6);
  assert.equal(total(cells(Q, 'I7N', operation('transfer.asset'))), 92);
  assert.equal(total(cells(Q, 'I7A', operation('adapter.transfer'))), 69);
});

test('P-N C9 and I10C retain the complete raw/case/CP phase inventory', () => {
  for (const [plan, id, caseCount, rawCount] of [[P, 'C9', 276, 14], [Q, 'I10C', 920, 46]]) {
    assert.equal(total(cells(plan, id, (cell) => ['caption.case', 'native.boundary', 'fast.workflow'].includes(cell.operation))), caseCount);
    assert.equal(total(cells(plan, id, operation('caption.raw-ingest'))), rawCount);
    assert.equal(total(cells(plan, id, operation('capture.cp-fixture'))), 16);
    assert.equal(cells(plan, id, operation('native.boundary')).length, 6);
    assert.equal(cells(plan, id, operation('caption.case')).length, 24);
    assert.equal(cells(plan, id, operation('fast.workflow')).length, 16);
    const cp02 = cells(plan, id).find((cell) => cell.parameters.caseId === 'CP02');
    assert.ok(cp02.parameters.includes.includes('unsafe-regroup-108-vs-109'));
  }
});

test('P native extension has 28 text operations, 36 recoveries, 70 raster operations and 60 H workflows', () => {
  assert.equal(total(cells(P, 'H7', (cell) => cell.kind === 'operation')), 28);
  assert.equal(total(cells(P, 'H7', operation('text.recovery'))), 36);
  assert.equal(total(cells(P, 'H7', operation('text.interaction'))), 1);
  assert.equal(total(cells(P, 'H8')), 70);
  assert.equal(total(cells(P, 'H9', operation('portable.reopen'))), 3);
  assert.equal(total(cells(P, 'H9', operation('fast.workflow'))), 60);
  assert.equal(total(cells(P, 'C10')), 14);
});

test('I3 uses full S/I only on Chromium and separately labelled other-engine compatibility smoke', () => {
  const nav = cells(Q, 'I3', (cell) => cell.operation === 'navigation.ready' && cell.parameters.browser === 'chromium');
  assert.deepEqual(counts(nav), { cold: 90, warm: 60, primes: 2 });
  const interact = cells(Q, 'I3', (cell) => cell.operation === 'interaction.brush' && cell.parameters.browser === 'chromium');
  assert.equal(interact.length, 4);
  assert.deepEqual(counts(interact), { cold: 4, warm: 20, primes: 0 });
  assert.deepEqual(new Set(interact.map((cell) => cell.parameters.mode)), new Set(['native', 'worker-offscreen-disabled', 'context-loss']));
  for (const browser of ['firefox', 'webkit']) {
    const smoke = cells(Q, 'I3', (cell) => cell.parameters.browser === browser);
    assert.equal(smoke.length, 4);
    assert.ok(smoke.every((cell) => cell.requirements.claim === 'compatibility-smoke-only'));
    assert.equal(total(smoke.filter(operation('navigation.ready'))), 7);
    assert.equal(total(smoke.filter(operation('interaction.brush'))), 1);
    assert.equal(total(smoke.filter(operation('interaction.first-use'))), 10);
    assert.equal(total(smoke.filter(operation('developer.hot-update'))), 3);
  }
});

test('I4 covers all 45 cells without merging three separate large-list actions', () => {
  const all = cells(Q, 'I4');
  assert.equal(all.length, 45);
  assert.deepEqual(counts(all), { cold: 450, warm: 450, primes: 135 });
  assert.deepEqual(cells(Q, 'I4', operation('layers.large-list')).map((cell) => cell.parameters.action), ['select', 'scroll', 'reorder']);
  assert.equal(all.filter((cell) => cell.parameters.fixtureVariant === 'narrow').length, 2);
  assert.equal(all.filter((cell) => cell.parameters.mode === 'full').length, 1);
  assert.equal(cells(Q, 'I4', operation('raster.resample')).length, 1);
});

test('I10H preserves 184 operation starts, 120 recovery cases, twelve IText minutes and two real IME sessions', () => {
  assert.equal(total(cells(Q, 'I10H', (cell) => cell.kind === 'operation')), 184);
  assert.equal(total(cells(Q, 'I10H', operation('text.recovery'))), 120);
  const interactions = cells(Q, 'I10H', operation('text.interaction'));
  assert.equal(total(interactions), 12);
  for (const cell of interactions) {
    assert.equal(cell.parameters.durationMs, 60000);
    assert.equal(cell.parameters.actions.total, 106);
    assert.equal(cell.parameters.actions.presentationRequests, 6);
    assert.equal(cell.parameters.compositionEvents, 'synthetic');
  }
  const native = cells(Q, 'I10H', operation('text.native-ime'));
  assert.equal(total(native), 2);
  assert.deepEqual(native.map((cell) => [cell.workload, cell.parameters.inputSource]), [['WXn', 'japanese'], ['WXs', 'simplified-chinese']]);
  for (const cell of native) {
    assert.equal(cell.kind, 'manual');
    assert.equal(cell.parameters.compositionSequences, 10);
    assert.equal(cell.parameters.commits, 8);
    assert.equal(cell.parameters.cancels, 2);
    assert.equal(cell.parameters.presentationRequests, 6);
    assert.equal(cell.requirements.syntheticEventsMayNotSubstitute, true);
  }
});

test('warm text completion and navigation ceilings remain separate from cold cohorts', () => {
  const apply = cells(Q, 'I10H', (cell) => cell.operation === 'text.apply' && cell.workload === 'WXs')[0];
  const rule = apply.phaseBudgets.find((entry) => entry.id === 'R34');
  assert.deepEqual(rule.cohorts, { cold: { targetMs: 10000, ceilingMs: 20000 }, warm: { targetMs: 2000, ceilingMs: 6000 } });
  const normalNav = cells(P, 'H1', (cell) => cell.workload === 'W1')[0];
  assert.deepEqual(normalNav.requiredMeasurements.filter((entry) => entry.budgetId === 'R05').map((entry) => [entry.cache, entry.ceiling]),
    [['cold', 4000], ['warm', 2000]]);
});

test('I11H retains 414 distinct WebP/CP/export starts and twenty output-grid responses', () => {
  const operations = cells(Q, 'I11H', (cell) => cell.kind === 'operation');
  assert.equal(operations.length, 18);
  assert.equal(total(operations), 414);
  assert.equal(total(cells(Q, 'I11H', operation('mask.output-mismatch'))), 20);
  assert.equal(operations.filter((cell) => cell.parameters.format === 'webp').length, 8);
  assert.equal(operations.filter(operation('capture.source')).length, 2);
  assert.equal(operations.filter(operation('mask.feather-preview')).length, 4);
  assert.equal(operations.filter(operation('raster.export')).length, 4);
});

test('I12 retains the smaller copy cohorts, ten failures and independent H reopen/Fast workflows', () => {
  assert.equal(total(cells(Q, 'I12C', (cell) => cell.kind === 'operation')), 28);
  assert.equal(total(cells(Q, 'I12C', operation('portable.failure'))), 10);
  assert.equal(total(cells(Q, 'I12H', operation('portable.reopen'))), 14);
  assert.equal(total(cells(Q, 'I12H', operation('fast.workflow'))), 200);
  const failures = cells(Q, 'I12C', operation('portable.failure'));
  assert.equal(new Set(failures.map((cell) => `${cell.parameters.direction}:${cell.parameters.scenario}`)).size, 10);
});

test('every editor lifecycle starts its own B0 and keeps real cycles, idle and worker restarts', () => {
  for (const [plan, id, cycleCount, workload] of [[P, 'H5', 2, 'W1'], [P, 'H10', 2, 'WXn'],
    [Q, 'I5a', 100, 'W1'], [Q, 'I5b', 100, 'W2'], [Q, 'I13H', 100, 'WXs']]) {
    const cell = cells(plan, id)[0];
    assert.equal(cell.workload, workload);
    assert.equal(cell.parameters.cycles, cycleCount);
    assert.equal(cell.parameters.baselineIdleMs, 30000);
    assert.equal(cell.parameters.idleMs, 30000);
    assert.equal(cell.parameters.cycleBudgetMs, 90000);
    assert.equal(cell.requirements.fixedIdleMs, (cycleCount + 1) * 30000);
    assert.equal(cell.parameters.processResetBetweenCycles, false);
    assert.equal(cell.parameters.forcedGc, false);
    assert.deepEqual(cell.parameters.restarts, cycleCount === 100 ? [20, 40, 60, 80] : [1]);
    assert.equal(cell.requirements.observationCount, cycleCount);
    assert.equal(cell.requirements.freshIsolatedProcess, true);
    if (cycleCount === 100) {
      assert.equal(cell.parameters.windows, 5);
      assert.equal(cell.parameters.windowCycles, 20);
      assert.equal(cell.parameters.windowMs, 30 * 60 * 1000);
    }
  }
  assert.equal(job(Q, 'I5a').ceilingMs, undefined);
  assert.equal(job(Q, 'I5a').combinedBudget.ceilingMs, 330 * 60000);
});

test('adapter timings never replace independent actual import/select/close lifecycle cohorts', () => {
  assert.equal(total(cells(P, 'AC1')), 7);
  assert.equal(total(cells(P, 'AH1')), 7);
  assert.equal(total(cells(Q, 'I8C', operation('adapter.import'))), 46);
  assert.equal(total(cells(Q, 'I8H', operation('adapter.select'))), 23);
  for (const [plan, id] of [[P, 'AC2'], [P, 'AH2'], [Q, 'I8C'], [Q, 'I8H']]) {
    const cell = cells(plan, id, operation('adapter.lifecycle'))[0];
    assert.equal(cell.parameters.cycles, 2);
    assert.equal(cell.requirements.freshIsolatedProcess, true);
    assert.equal(cell.requirements.fixedIdleMs, 90000);
    assert.deepEqual(cell.parameters.restarts, []);
    assert.ok(cell.parameters.steps.includes('import'));
    assert.equal(cell.requirements.noHundredCycleGrowthClaim, true);
    assert.equal(cell.handler, cell.host === 'H' ? 'browser' : 'adapters');
  }
  for (const [plan, id] of [[P, 'AH1'], [Q, 'I8H']]) {
    assert.equal(cells(plan, id, operation('adapter.select'))[0].handler, 'browser');
  }
  const stressImport = cells(Q, 'I8C', operation('adapter.import')).find((cell) => cell.parameters.bytes === 1024 ** 3);
  assert.deepEqual(stressImport.phaseBudgets[0], { id: 'T05', phase: 'adapter.import-durable', targetMs: 16000, ceilingMs: 30000 });
});

test('I7 transfer primes actually move fresh bytes, including one-GiB adapter download', () => {
  assert.equal(total(cells(Q, 'I7N')), 92);
  assert.equal(total(cells(Q, 'I7A')), 69);
  for (const cell of [...cells(Q, 'I7N'), ...cells(Q, 'I7A')]) {
    assert.equal(cell.host, 'C+N');
    assert.equal(cell.cold, 10);
    assert.equal(cell.warm, 10);
    assert.equal(cell.primes, 3);
    assert.equal(cell.parameters.freshTransferKey, true);
    assert.equal(cell.requirements.actualBytesTransferred, true);
    assert.equal(cell.requirements.warmOwnedZeroFetchIsNotThroughput, true);
  }
});

test('developer Q3 groups remain independent and I0 never recursively expands into ten pipelines', () => {
  assert.equal(total(cells(Q, 'I0')), 2);
  assert.equal(total(cells(Q, 'I1')), 10);
  assert.equal(total(cells(Q, 'I2')), 10);
  assert.deepEqual(cells(Q, 'I0').map((cell) => cell.parameters.cache), ['normal', 'cold']);
  assert.ok(cells(Q, 'I0').every((cell) => cell.parameters.features === 'core' && cell.requirements.multiHostRouterRequired));
  const commands = cells(Q, 'I1')[0];
  assert.equal(commands.cold, 5);
  assert.equal(commands.warm, 5);
  assert.equal(commands.parameters.independentFromI0, true);
  assert.deepEqual(commands.parameters.browsers, ['chromium', 'firefox', 'webkit']);
  assert.equal(commands.parameters.testBrowser, 'chromium');
  assert.equal(cells(Q, 'I2')[0].parameters.producerNestedInConsumerUpdate, true);
});

test('schedule dependencies preserve one timed job per host and H artifact dependencies', () => {
  assert.deepEqual(job(P, 'H0').dependsOn, ['C2']);
  assert.deepEqual(job(P, 'C8').dependsOn, ['C10']);
  assert.deepEqual(job(P, 'H6').dependsOn, ['H10']);
  assert.deepEqual(job(P, 'AC0').dependsOn, ['C8', 'H6']);
  assert.deepEqual(job(Q, 'I7A').dependsOn, ['I7N']);
  assert.deepEqual(job(Q, 'I8C').dependsOn, ['I7A']);
  assert.deepEqual(job(Q, 'I3').dependsOn, ['I0']);
  assert.equal(P.scheduling.maximumActiveTimedJobsPerHost, 1);
  assert.equal(Q.scheduling.baseBeforeCandidate, true);
  const cold = makeCampaignPlan({ campaign: 'P', cache: 'cold' });
  assert.equal(job(cold, 'C1').ceilingMs, 240000);
  assert.equal(job(cold, 'H0').ceilingMs, 420000);
  assert.deepEqual(counts(cells(cold, 'C1')), { cold: 1, warm: 0, primes: 0 });
});
