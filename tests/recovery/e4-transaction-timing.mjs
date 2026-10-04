/** Test-only observations of original IDB transactions. No stored keys/values,
 * requests, transaction result, callback, abort, commit or promise are replaced. */
export function installE4TransactionTiming() {
  if (Object.hasOwn(window, '__p25TransactionTiming')) return;
  const MAX_ROWS = 4096, MAX_ACTIVE = 256, MAX_PHASES = 256, MAX_ERRORS = 16, MAX_OUTPUT = 1024 * 1024;
  const now = performance.now.bind(performance), wall = Date.now.bind(Date), apply = Reflect.apply;
  const rows = [], errors = [], active = new Map();
  let serial = 0, dropped = 0, ignored = 0, disposed = false;
  const fault = code => { if (!errors.includes(code) && errors.length < MAX_ERRORS) errors.push(code); };
  const increment = value => Math.min(Number.MAX_SAFE_INTEGER, value + 1);
  const proto = globalThis.IDBDatabase?.prototype;
  const descriptor = proto && Object.getOwnPropertyDescriptor(proto, 'transaction');
  const original = descriptor?.value;
  const observe = (db, tx, startedWallMs, startedMs, returnedMs) => {
    const name = db.name;
    const scope = typeof name === 'string' && name.startsWith('ie-delivery-') ? 'journal'
      : typeof name === 'string' && name.startsWith('ie-projection-') ? 'recovery' : null;
    if (!scope) { ignored = increment(ignored); return; }
    if (rows.length >= MAX_ROWS || active.size >= MAX_ACTIVE) { dropped = increment(dropped); fault('E4_IDB_TIMING_CAPACITY'); return; }
    const names = tx.objectStoreNames, stores = [];
    if (!names || names.length > 2) { fault('E4_IDB_TIMING_STORES'); return; }
    for (let i = 0; i < names.length; i++) {
      const name = names.item(i);
      if (!['entries', 'meta', 'rows'].includes(name)) { fault('E4_IDB_TIMING_STORES'); return; }
      stores.push(name);
    }
    if (!['readonly', 'readwrite', 'versionchange'].includes(tx.mode)) { fault('E4_IDB_TIMING_MODE'); return; }
    const row = {id: ++serial, scope, mode: tx.mode, stores, startedWallMs, startedMs, returnedMs,
      terminalMs: null, terminalWallMs: null, outcome: 'pending', errorEvents: 0};
    const detach = () => {
      tx.removeEventListener('complete', complete); tx.removeEventListener('abort', abort); tx.removeEventListener('error', error);
      active.delete(tx);
    };
    const finish = outcome => {
      // Event listeners report the genuine terminal event, never infer completion
      // from an error, timeout, snapshot, wrapper return or diagnostic disposal.
      if (row.outcome !== 'pending') return;
      try { row.terminalMs = now(); row.terminalWallMs = wall(); row.outcome = outcome; }
      catch { fault('E4_IDB_TIMING_CLOCK'); }
      finally { detach(); }
    };
    const complete = () => finish('complete'), abort = () => finish('abort');
    const error = () => { row.errorEvents = increment(row.errorEvents); };
    rows.push(row); active.set(tx, detach);
    try { tx.addEventListener('complete', complete); tx.addEventListener('abort', abort); tx.addEventListener('error', error); }
    catch { detach(); fault('E4_IDB_TIMING_LISTENER'); }
  };
  const wrapped = function (...args) {
    // Return the exact native transaction or throw the exact native exception.
    // No async function, promise continuation, timer or additional IDB call.
    let startedWallMs, startedMs;
    try { startedWallMs = wall(); startedMs = now(); } catch { fault('E4_IDB_TIMING_CLOCK'); }
    const result = apply(original, this, args);
    if (!disposed) try { observe(this, result, startedWallMs, startedMs, now()); } catch { fault('E4_IDB_TIMING_OBSERVATION'); }
    return result;
  };
  if (typeof original !== 'function') fault('E4_IDB_TIMING_UNAVAILABLE');
  else try { Object.defineProperty(proto, 'transaction', {...descriptor, value: wrapped}); }
  catch { fault('E4_IDB_TIMING_INSTALL'); }
  const phases = () => {
    let owner;
    const result = {records: [], dropped: null, invalid: null, clockOriginUnixMs: null, errors: []};
    try {
      owner = window.__IDEOGRAM_PHASES__?.readSnapshot('e4-transaction-timing');
      if (!owner) throw Error('unavailable');
      const trace = owner.value.trace;
      if (!trace || !Array.isArray(trace.records) || trace.records.length > 16384) throw Error('shape');
      result.dropped = trace.dropped; result.invalid = trace.invalid; result.clockOriginUnixMs = trace.clockOriginUnixMs;
      for (const row of trace.records) {
        if (row.phase !== 'command.accept' && row.phase !== 'reconnect') continue;
        if (result.records.length === MAX_PHASES) { result.errors.push('E4_PHASE_TIMING_CAPACITY'); break; }
        const context = {};
        for (const key of ['commandId', 'transactionId', 'documentId']) {
          const value = row.context?.[key];
          if (typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)) context[key] = value;
        }
        result.records.push({sequence: row.sequence, phase: row.phase, startedMs: row.startedMs,
          endedMs: row.endedMs, durationMs: row.durationMs, outcome: row.outcome, context});
      }
    } catch { result.errors.push('E4_PHASE_TIMING_UNAVAILABLE'); }
    finally { if (owner) try { owner.release(); } catch { result.errors.push('E4_PHASE_TIMING_RELEASE'); } }
    return result;
  };
  const snapshot = () => {
    const result = {kind: 'e4-original-idb-transaction-timing-1', clock: 'browser-monotonic-and-wall-ms', timeOrigin: performance.timeOrigin,
      records: rows.map(row => ({...row, stores: [...row.stores]})), observed: serial, pending: active.size,
      dropped, ignored, disposed, errors: [...errors], phases: phases(),
      limits: {rows: MAX_ROWS, active: MAX_ACTIVE, phases: MAX_PHASES, outputBytes: MAX_OUTPUT},
      scope: 'Native transaction return and complete/abort events only; no logical phase attribution, native storage closure or hardware timing claim.'};
    try {
      if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_OUTPUT) {
        result.records = []; result.phases.records = []; result.errors.push('E4_IDB_TIMING_OUTPUT');
      }
    } catch { result.records = []; result.phases.records = []; result.errors.push('E4_IDB_TIMING_SERIALIZE'); }
    return result;
  };
  const dispose = () => {
    if (disposed) return; disposed = true;
    if (proto && proto.transaction === wrapped) Object.defineProperty(proto, 'transaction', descriptor);
    for (const detach of [...active.values()]) detach();
    // Pending row outcomes stay pending. Detaching is not transaction retirement.
  };
  Object.defineProperty(window, '__p25TransactionTiming', {value: Object.freeze({snapshot, dispose}), configurable: true});
}

/** Measures only the existing fixture write call. Completion is retained by the
 * next natural fixture write; no extra write or authority timestamp is added. */
export function observeE4AuthorityWrite(record, write, now = () => performance.now()) {
  const timing = {startedMs: null, endedMs: null, outcome: 'threw', clockError: false};
  try { timing.startedMs = now(); } catch { timing.clockError = true; }
  try { const result = write(); timing.outcome = 'returned'; return result; }
  finally {
    try { timing.endedMs = now(); } catch { timing.clockError = true; }
    record.diagnosticWrite = timing;
  }
}
