// Fabricated serialization specimens only. These are not observed product
// allocations, an approved renderer review, or performance qualification.
const kinds = ['copy', 'staging', 'scratch', 'blob', 'font', 'text', 'canvas', 'bitmap', 'prompt', 'control'];
const amounts = (cpuBytes = 0, gpuBytes = 0, previewCacheBytes = 0) => ({ cpuBytes, gpuBytes, previewCacheBytes, handles: 0 });
const live = (cpu = 0, gpu = 0, cache = 0, records = 0) => ({ records, ...amounts(cpu, gpu, cache) });

export function appOwnershipSpecimen(combinedCpu, { initialCpuBytes = 10, initialTextBytes = 4, textBytes = 4,
  transitionCount = 0, gpuBytes = 8, previewCacheBytes = 4, gpuPeak = gpuBytes, previewPeak = previewCacheBytes,
  ledgerStartSequence = 100, atMs = null } = {}) {
  const cpu = combinedCpu.window, initialCentral = initialCpuBytes - initialTextBytes, central = combinedCpu.currentBytes - textBytes;
  const added = cpu ? Math.max(0, cpu.ledgerBytesAtPeak - initialCentral, central - initialCentral) : 0;
  const removed = cpu ? initialCentral + added - central : 0;
  const gpuTransitions = gpuPeak > gpuBytes || previewPeak > previewCacheBytes ? 2 : 0;
  const transitionSequence = cpu ? ledgerStartSequence + transitionCount + gpuTransitions : ledgerStartSequence - 1;
  const currentRows = kinds.map(kind => ({ kind, ...(kind === 'prompt' ? live(central, 0, 0, 1) : kind === 'canvas' ? live(0, gpuBytes, previewCacheBytes, 1) : live()) }));
  const point = { kind: 'app-ownership-point-1', schemaVersion: 1, ledgerInstanceId: combinedCpu.ledgerInstanceId,
    transitionSequence, cpuSequence: combinedCpu.sequence, clock: 'browser-performance', clockOriginMs: cpu?.clockOriginMs ?? 1234567890,
    atMs: atMs ?? cpu?.endMs ?? cpu?.peakAtMs ?? 0, totals: amounts(combinedCpu.currentBytes, gpuBytes, previewCacheBytes),
    centralCpuBytes: central, textBytes, textSequence: cpu?.textEndSequence ?? cpu?.textStartSequence ?? 19,
    kinds: currentRows, observationComplete: true, globalCoverageComplete: false };
  const window = cpu ? { kind: 'app-ownership-window-1', schemaVersion: 1, scope: 'application-owned-conservative-reservations',
    ledgerInstanceId: cpu.ledgerInstanceId, id: cpu.id, ordinal: cpu.ordinal, clock: cpu.clock, clockOriginMs: cpu.clockOriginMs,
    startMs: cpu.startMs, endMs: cpu.endMs, cpuStartSequence: cpu.startSequence, cpuEndSequence: cpu.endSequence,
    ledgerStartSequence, ledgerEndSequence: cpu.sealed ? transitionSequence : null, lastTransitionSequence: transitionSequence,
    sealed: cpu.sealed, budgetRefusals: 0,
    kinds: kinds.map(kind => ({ kind,
      initial: kind === 'prompt' ? live(initialCentral, 0, 0, 1) : kind === 'canvas' ? live(0, gpuBytes, previewCacheBytes, 1) : live(),
      current: (({ kind: _kind, ...value }) => value)(currentRows.find(row => row.kind === kind)),
      transitions: { reserved: 0, resized: kind === 'canvas' ? gpuTransitions : 0, released: 0, observed: kind === 'prompt' ? transitionCount : 0 },
      added: kind === 'prompt' ? amounts(added) : kind === 'canvas' ? amounts(0, gpuPeak - gpuBytes, previewPeak - previewCacheBytes) : amounts(),
      removed: kind === 'prompt' ? amounts(removed) : kind === 'canvas' ? amounts(0, gpuPeak - gpuBytes, previewPeak - previewCacheBytes) : amounts() })),
    text: { initialBytes: initialTextBytes, currentBytes: textBytes, startSequence: cpu.textStartSequence, endSequence: cpu.textEndSequence, observationComplete: true },
    peaks: { gpuBytes: gpuPeak, previewCacheBytes: previewPeak, handles: 0 }, observationComplete: true, reconciled: true,
    failures: [], globalCoverageComplete: false } : null;
  return { kind: 'app-ownership-observation-1', schemaVersion: 1, ledgerInstanceId: combinedCpu.ledgerInstanceId, transitionSequence, point, window };
}
