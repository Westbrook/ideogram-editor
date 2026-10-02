const integer = value => Number.isSafeInteger(value) && value >= 0;
const presentation = value => ['anchored', 'inspector'].includes(value);
const sameRange = (a, b) => a.session === b.session && a.start === b.start && a.end === b.end && a.direction === b.direction;

export function nextPresentationTarget(state) {
  const current = state?.switch?.pending || state?.presentation;
  if (!presentation(current)) throw Error('Actual presentation or pending target is unavailable');
  return current === 'anchored' ? 'inspector' : 'anchored';
}

/** This validates model and token observations, never display presentation.
 * It consumes the six existing actions and native end/cancel boundaries. */
export function inspectTextPresentationWitness(witness) {
  const missing = [], failures = [], requests = Array.isArray(witness?.requests) ? witness.requests : [];
  const expect = (condition, name) => { if (!condition) failures.push(name); };
  const observed = (value, name) => { if (!value || !value.switch || !presentation(value.presentation) || !['', 'anchored', 'inspector'].includes(value.switch.pending) || !['request', 'requestEpoch', 'requestGeneration', 'settled', 'rejected', 'superseded'].every(key => integer(value.switch[key]))) { missing.push(name); return false; } return true; };
  if (witness?.kind !== 'text-presentation-observation-1' || requests.length !== 6) missing.push('exact-six-presentation-request-observations');
  const modes = ['immediate', 'immediate', 'immediate', 'deferred', 'deferred-latest', 'deferred-cancelled'];
  for (const [index, request] of requests.entries()) {
    if (!observed(request.before, 'request-before-state') || !observed(request.after, 'request-after-state')) continue;
    expect(request.mode === modes[index], 'presentation-request-mode-order');
    expect(request.after.switch.request === request.before.switch.request + 1, 'one-sequence-per-request');
    expect(request.target === nextPresentationTarget(request.before), 'target-follows-current-or-pending-presentation');
    if (index) expect(request.before.switch.request === requests[index - 1].after?.switch?.request, 'no-extra-presentation-request');
    if (index < 3) {
      expect(request.after.presentation === request.target && request.after.switch.settled === request.after.switch.request, 'immediate-model-target-settled');
      expect(sameRange(request.before, request.after), 'immediate-native-range-and-session-preserved');
    } else {
      expect(request.after.switch.pending === request.target && request.after.presentation === request.before.presentation && request.after.session === request.before.session && request.after.revision === request.before.revision, 'deferred-request-remains-pending');
      expect(request.after.switch.settled === request.before.switch.settled, 'deferred-model-not-settled-before-native-end');
    }
  }
  let latestDeferredOnlyAfterNativeEnd = null, staleDeferredRequestRejected = null, cancelDropsDeferred = null;
  const first = requests[3], latest = requests[4], cancelled = requests[5], boundary = witness?.latest, cancellation = witness?.cancellation;
  if (first?.after?.switch && latest?.after?.switch && observed(boundary?.beforeEnd, 'latest-native-end-before-state') && observed(boundary?.afterEnd, 'latest-native-end-after-state')) {
    const prior = failures.length;
    expect(first.target !== latest.target, 'distinct-latest-deferred-targets');
    expect(latest.after.switch.superseded === first.after.switch.request && latest.after.switch.rejected === first.after.switch.request && latest.after.switch.reason === 'superseded', 'prior-deferred-token-superseded');
    expect(boundary.beforeEnd.switch.pending === latest.target && boundary.beforeEnd.switch.request === latest.after.switch.request && boundary.beforeEnd.switch.settled === latest.before.switch.settled && boundary.beforeEnd.presentation === latest.before.presentation, 'latest-still-pending-at-native-end');
    expect(boundary.afterEnd.switch.pending === '' && boundary.afterEnd.switch.request === latest.after.switch.request && boundary.afterEnd.switch.settled === latest.after.switch.request && boundary.afterEnd.presentation === latest.target, 'latest-token-settles-only-after-native-end');
    latestDeferredOnlyAfterNativeEnd = failures.length === prior;
  }
  let deferredRequestRejection = null;
  if (cancelled?.after?.switch && observed(cancellation?.beforeCancel, 'cancel-native-end-before-state') && observed(cancellation?.afterCancel, 'cancel-native-end-after-state')) {
    const before = cancellation.beforeCancel, after = cancellation.afterCancel, sequence = cancelled.after.switch.request, value = after.switch;
    cancelDropsDeferred = before.switch.pending === cancelled.target && before.switch.request === sequence && value.request === sequence && value.pending === '' && value.settled !== sequence && after.presentation === before.presentation && after.session === '';
    expect(cancelDropsDeferred, 'cancel-drops-existing-deferred-token');
    const tupleObserved = ['rejectedEpoch', 'rejectedGeneration', 'rejectedCurrentEpoch', 'rejectedCurrentGeneration'].every(key => integer(value[key]));
    const textTupleObserved = ['rejectedTextVersion', 'rejectedCurrentTextVersion', 'rejectedGuards'].every(key => integer(value[key])) &&
      integer(cancelled.after.switch.requestTextVersion) && integer(cancelled.after.textVersion) && integer(before.textVersion) && integer(after.textVersion) &&
      typeof value.rejectedBoundary === 'string';
    if (!tupleObserved) missing.push('actual-stale-rejection-numeric-guard-tuple');
    else if (!textTupleObserved) {
      // Retained generation-only evidence stays explicit; it never gains the
      // newly required text/session retirement observations by default.
      const legacyGeneration = value.rejected === sequence && value.reason === 'stale-generation' && value.rejectedEpoch === cancelled.after.switch.requestEpoch &&
        value.rejectedGeneration === cancelled.after.switch.requestGeneration && value.rejectedCurrentEpoch === value.rejectedEpoch &&
        value.rejectedCurrentGeneration > value.rejectedGeneration && value.settled !== sequence && after.presentation === before.presentation;
      missing.push('actual-cancel-native-end-draft-guard-tuple');
      deferredRequestRejection = {kind: 'deferred-presentation-rejection-1', requestSequence: sequence, reason: value.reason,
        requestEpoch: value.rejectedEpoch, currentEpoch: value.rejectedCurrentEpoch, requestGeneration: value.rejectedGeneration, currentGeneration: value.rejectedCurrentGeneration,
        presentationUnchanged: after.presentation === before.presentation, requestNotSettled: value.settled !== sequence,
        nativeBoundary: 'existing-final-composition-cancel', extraMutationOrRequest: false,
        witnessedGuards: legacyGeneration ? ['stale-generation'] : [], unobservedGuards: legacyGeneration ? ['stale-session', 'stale-version'] : ['stale-session', 'stale-generation', 'stale-version']};
    } else {
      const captured = cancelled.after, request = captured.switch;
      const capturedIdentity = before.session === captured.session && before.revision === captured.revision && before.textVersion === captured.textVersion &&
        request.requestEpoch === value.rejectedEpoch && request.requestGeneration === value.rejectedGeneration && request.requestTextVersion === value.rejectedTextVersion &&
        String(value.rejectedGeneration) === captured.revision && value.rejectedTextVersion === captured.textVersion;
      const currentIdentity = value.rejectedCurrentEpoch > value.rejectedEpoch && value.rejectedCurrentGeneration > value.rejectedGeneration &&
        value.rejectedCurrentTextVersion > value.rejectedTextVersion && String(value.rejectedCurrentGeneration) === after.revision && value.rejectedCurrentTextVersion === after.textVersion;
      staleDeferredRequestRejected = cancelDropsDeferred && capturedIdentity && currentIdentity && value.rejected === sequence && value.reason === 'cancelled' &&
        value.rejectedBoundary === 'cancel-native-end' && value.rejectedGuards === 7;
      expect(staleDeferredRequestRejected, 'existing-cancel-observes-session-generation-text-version-rejection');
      const witnessedGuards = staleDeferredRequestRejected ? ['stale-session', 'stale-generation', 'stale-version'] : [];
      deferredRequestRejection = {kind: 'deferred-presentation-rejection-2', requestSequence: sequence, reason: value.reason,
        nativeBoundary: value.rejectedBoundary, guardMask: value.rejectedGuards, versionMeaning: 'draft-text-version',
        requestEpoch: value.rejectedEpoch, currentEpoch: value.rejectedCurrentEpoch, requestGeneration: value.rejectedGeneration, currentGeneration: value.rejectedCurrentGeneration,
        requestTextVersion: value.rejectedTextVersion, currentTextVersion: value.rejectedCurrentTextVersion,
        capturedState: {epoch: request.requestEpoch, generation: Number(captured.revision), textVersion: captured.textVersion},
        currentState: {epoch: value.rejectedCurrentEpoch, generation: Number(after.revision), textVersion: after.textVersion},
        presentationUnchanged: after.presentation === before.presentation, requestNotSettled: value.settled !== sequence,
        extraMutationOrRequest: false, witnessedGuards, unobservedGuards: staleDeferredRequestRejected ? [] : ['stale-session', 'stale-generation', 'stale-version'],
        acceptedVersion: {scope: 'accepted-document-layer-version', invariantUnchanged: (value.rejectedGuards & 8) === 0, rejectionObserved: false}};
    }
  }
  return { missing: [...new Set(missing)], failures: [...new Set(failures)], latestDeferredOnlyAfterNativeEnd, cancelDropsDeferred, staleDeferredRequestRejected, deferredRequestRejection,
    boundary: 'Observed native editor model and request guard state; physical feedback and presentation require the independent browser/display trace' };
}
