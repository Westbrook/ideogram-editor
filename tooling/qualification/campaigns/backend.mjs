import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { createProductFixture, phase, result } from './backend-common.mjs';
import { normalizeBackendMeasurements } from './backend-measurements.mjs';

export const supportedOperations = Object.freeze([
  'queue.fault', 'queue.proxy-pair', 'queue.healthy-polling', 'fast.workflow',
  'caption.case', 'native.boundary', 'caption.raw-ingest', 'capture.cp-fixture',
  'portable.copy', 'portable.import', 'portable.failure', 'transfer.asset',
  'raster.composite', 'raster.decode', 'raster.encode', 'state.snapshot-read',
  'state.replay', 'state.command-accept-dispatch', 'asset.persist', 'asset.cache-lookup',
]);
export const supportedCells = supportedOperations;
const rasterStateOperations = new Set(['raster.composite', 'raster.decode', 'raster.encode', 'state.snapshot-read', 'state.replay', 'state.command-accept-dispatch', 'asset.persist', 'asset.cache-lookup']);

export function routeCell(cell) {
  if (!cell || !supportedOperations.includes(cell.operation)) throw Object.assign(Error('No executable backend adapter for ' + cell?.operation), { code: 'CELL_UNSUPPORTED' });
  if (['queue.fault', 'queue.proxy-pair', 'queue.healthy-polling', 'fast.workflow'].includes(cell.operation)) return { module: './backend-queue.mjs', cell };
  if (cell.operation === 'transfer.asset') return { module: './backend-transfer.mjs', cell };
  if (rasterStateOperations.has(cell.operation)) return { module: './backend-raster-state.mjs', cell };
  if (cell.operation.startsWith('portable.')) return { module: './backend-portable.mjs', cell };
  if (cell.operation === 'caption.raw-ingest') {
    const bytes = cell.parameters?.bytes;
    if (![16777216, 16777217].includes(bytes)) throw Error('Raw ingestion requires the exact 16MiB or plus-one cell');
    return { module: './backend-composition.mjs', cell: { ...cell, parameters: { ...cell.parameters, caseId: bytes === 16777216 ? 'RAW16M' : 'RAW16M_PLUS1' } } };
  }
  return { module: './backend-composition.mjs', cell };
}

/** A group owns one adapter; the controller owns cold-process and warm-prime
 * policy. Each reset is retained independently from the measured operation. */
export function createBackendAdapter(context) {
  let active = null, stopped = false, resetReceipt = null, hasExecuted = false, activeCellKey = null;
  async function closeActive() { if (active) { const previous = active; active = null; await previous.close(); } }
  const adapter = {
    supportedCells,
    async prepareCell(cell) {
      context.signal?.throwIfAborted(); routeCell(cell);
      await access(join(context.repo, 'dist/local/server/storage/writer.js'));
      return { status: 'pass', phases: [], assertions: [{ name: 'Selected product build and explicit operation adapter exist', passed: true }], observations: { productRepository: context.repo, harnessPid: process.pid }, evidence: [], missing: [] };
    },
    async resetCell(cell, sample = {}) {
      if (stopped) throw Error('Backend adapter is closed');
      context.signal?.throwIfAborted(); routeCell(cell); const phases = [];
      const cellKey = JSON.stringify([cell.operation, cell.workload, cell.parameters ?? {}]);
      if (activeCellKey !== null && activeCellKey !== cellKey) throw Error('A backend adapter owns one logical cell; different fixture families need separate adapters');
      activeCellKey = cellKey;
      if (cell.operation.startsWith('portable.')) {
        if (!active) {
          const { createPortableFixture } = await import('./backend-portable.mjs');
          active = await createPortableFixture(context, cell);
        }
        resetReceipt = await active.resetCell(cell, sample);
        return resetReceipt;
      }
      if (['caption.case', 'caption.raw-ingest', 'native.boundary'].includes(cell.operation)) {
        if (!active) {
          const { createCompositionFixture } = await import('./backend-composition.mjs');
          active = await createCompositionFixture(context, cell);
        }
        resetReceipt = await active.resetCell(cell, sample);
        return resetReceipt;
      }
      if (cell.operation === 'transfer.asset') {
        if (!active) {
          const { createTransferFixture } = await import('./backend-transfer.mjs');
          active = await createTransferFixture(context, cell);
        }
        resetReceipt = await active.resetCell(cell, sample);
        return resetReceipt;
      }
      if (rasterStateOperations.has(cell.operation)) {
        if (!active) {
          const { createRasterStateFixture } = await import('./backend-raster-state.mjs');
          active = await createRasterStateFixture(context, cell);
        }
        resetReceipt = await active.resetCell(cell, sample);
        return resetReceipt;
      }
      if (active?.queueWorker && hasExecuted && sample.cache === 'warm') {
        const { resetWarmProductFixture } = await import('./backend-reset.mjs');
        resetReceipt = await resetWarmProductFixture(active, context, cell, sample);
        return resetReceipt;
      }
      await phase(phases, 'previous-owned-writer-close', closeActive);
      // Queue cells need an independently reset journal before the submit clock.
      // Pure CP checks own no writer. Portable cells have stronger sealed-copy
      // verification and preserve their complete reset phases in their result.
      if (['queue.fault', 'queue.proxy-pair', 'queue.healthy-polling', 'fast.workflow'].includes(cell.operation)) {
        const restartRequired = cell.operation === 'queue.fault' && ['backend-restart', 'disk-full-admission'].includes(cell.parameters?.scenario);
        active = await phase(phases, 'new-private-journal-and-writer', () => createProductFixture({ ...context, queueFixture: !restartRequired, queueFixtureCell: cell }));
      }
      resetReceipt = result(cell, phases, { ...sample, root: active?.root ?? null, reset: 'Fresh private journal namespace; previous root retained', harnessPid: process.pid, writerWorkerRestarted: !!active, operatingSystemPageCache: 'not purged or inferred', providerAttemptsReused: false });
      return resetReceipt;
    },
    async execute(cell, sample = {}) {
      if (stopped) throw Error('Backend adapter is closed');
      context.signal?.throwIfAborted(); const route = routeCell(cell), module = await import(route.module);
      try {
        const runContext = { ...context, ...(active ? { productFixture: active } : {}), sample };
        const outcome = await (active?.portable ? active.runCell(runContext, route.cell) : module.runCell(runContext, route.cell));
        hasExecuted = true;
        outcome.observations = { ...outcome.observations, resetReceipt, sample, productRepository: context.repo };
        if (resetReceipt?.qualification?.status === 'inconclusive') {
          outcome.status = outcome.status === 'fail' ? 'fail' : 'inconclusive';
          outcome.missing.push(...(resetReceipt.qualification.missing ?? resetReceipt.qualification.reasons ?? ['Warm reset qualification is incomplete']));
        }
        if (sample.cache === 'warm' && active && !active.rasterState && !active.queueWorker && !active.transfer && !active.portable && !active.compositionState) {
          outcome.status = outcome.status === 'fail' ? 'fail' : 'inconclusive';
          outcome.missing.push('Warm harness process is retained, but this reset restarts the product writer worker; a qualified retained-writer warm reset is required');
        }
        return normalizeBackendMeasurements(cell, outcome);
      } catch (error) {
        if (!['FIXTURE_REQUIRED', 'CELL_UNSUPPORTED'].includes(error.code)) throw error;
        return result(cell, [], { resetReceipt, sample, error: { code: error.code, message: error.message } }, [], [error.message]);
      }
    },
    async close() { if (stopped) return; stopped = true; await closeActive(); },
  };
  adapter.runCell = adapter.execute;
  return adapter;
}
