import { randomUUID } from 'node:crypto';

const states = new WeakMap();
function stateFor(page) {
  let state = states.get(page);
  if (!state) { state = { reads: new Set(), handles: new Set(), draining: false }; states.set(page, state); }
  return state;
}
function failure(errors) {
  const error = new AggregateError(errors, 'Scoped product phase snapshot cleanup failed');
  error.code = 'PHASE_SNAPSHOT_RELEASE';
  return error;
}
async function release(state, entry) {
  if (entry.releaseTask) return entry.releaseTask;
  const task = releaseOwned(state, entry);
  entry.releaseTask = task;
  try { return await task; } finally { entry.releaseTask = undefined; }
}
async function releaseOwned(state, entry) {
  // Acquisition may have succeeded in the browser while its response was lost.
  // The known key recovers that same live owner, never an additional snapshot.
  if (!entry.handle) entry.handle = entry.textResources
    ? await entry.page.evaluateHandle(key => globalThis.__IDEOGRAM_PHASES__?.readTextResourceSnapshot?.(key) ?? null, entry.key)
    : await entry.page.evaluateHandle(key => globalThis.__IDEOGRAM_PHASES__?.readSnapshot?.(key) ?? null, entry.key);
  // A transport error is not proof that the product owner released. Keep the
  // actual JSHandle so a later cleanup attempt can retry the idempotent release.
  if (!entry.released) {
    await entry.handle.evaluate(owner => {
      if (owner === null) return;
      if (!owner || typeof owner.release !== 'function') throw Error('PHASE_SNAPSHOT_HANDLE_INVALID');
      owner.release();
    });
    entry.released = true;
  }
  await entry.handle.dispose();
  state.handles.delete(entry);
}

/** The owner remains live through Playwright's extraction and transport, even
 * if the projector or serialization rejects. No snapshot is returned by the
 * initial evaluateHandle call. Missing instrumentation remains a null value. */
export function readPhaseSnapshot(page, project = owner => owner?.value ?? null) { return readScopedSnapshot(page,project,false); }
export function readTextResourceSnapshot(page, project = owner => owner?.value ?? null) { return readScopedSnapshot(page,project,true); }
function readScopedSnapshot(page, project, textResources) {
  const state = stateFor(page);
  if (state.draining) return Promise.reject(Error('PHASE_SNAPSHOT_CLEANUP_ACTIVE'));
  if (state.reads.size >= 4) return Promise.reject(Error('PHASE_SNAPSHOT_READ_LIMIT'));
  const read = (async () => {
    // Retry failed cleanup before acquiring another product slot; do not turn
    // the preceding failed observation into successful measurement evidence.
    for (const entry of state.handles) if (entry.finished) {
      try { await release(state, entry); } catch (error) { throw failure([error]); }
    }
    const entry = { page, textResources, key: randomUUID(), handle: null, released: false, finished: false };
    state.handles.add(entry);
    let value, problem, failed = false;
    try {
      entry.handle = textResources
        ? await page.evaluateHandle(key => globalThis.__IDEOGRAM_PHASES__?.readTextResourceSnapshot?.(key) ?? null, entry.key)
        : await page.evaluateHandle(key => globalThis.__IDEOGRAM_PHASES__?.readSnapshot?.(key) ?? null, entry.key);
      value = await entry.handle.evaluate(project);
    } catch (error) { failed = true; problem = error; }
    finally {
      entry.finished = true;
      try { await release(state, entry); }
      catch (error) { problem = failure(failed ? [problem, error] : [error]); failed = true; }
    }
    if (failed) throw problem;
    return value;
  })();
  state.reads.add(read);
  void read.finally(() => state.reads.delete(read)).catch(() => {});
  return read;
}

/** Run before owned page navigation/destruction. The caller owns any deadline;
 * a deadline never releases a still-running extraction or claims it complete. */
export async function releasePendingPhaseSnapshots(page) {
  const state = stateFor(page);
  if (state.draining) throw Error('PHASE_SNAPSHOT_CLEANUP_ACTIVE');
  state.draining = true;
  const errors = [];
  try {
    await Promise.allSettled([...state.reads]);
    for (const entry of state.handles) {
      try { await release(state, entry); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw failure(errors);
    return { pendingHandles: state.handles.size, complete: state.handles.size === 0 };
  } finally { state.draining = false; }
}
