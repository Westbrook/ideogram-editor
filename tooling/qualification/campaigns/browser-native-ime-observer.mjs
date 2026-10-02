import {randomUUID} from 'node:crypto';

/** Passive browser evidence only. Trusted DOM events do not establish the OS
 * input source; the independent, same-attempt review supplies that authority. */
export async function observeNativeIme(page, {nonce, plan, signal, armTimeoutMs = 30000, onArmed}) {
  if (typeof nonce !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(nonce)) throw Error('NATIVE_IME_NONCE');
  if (plan?.kind !== 'native-ime-plan-1' || plan.durationMs !== 60000) throw Error('NATIVE_IME_PLAN');
  if (!Number.isSafeInteger(armTimeoutMs) || armTimeoutMs < 1 || armTimeoutMs > 30000) throw Error('NATIVE_IME_ARM_TIMEOUT');
  if (onArmed !== undefined && typeof onArmed !== 'function') throw Error('NATIVE_IME_ARM_CALLBACK');
  if (signal?.aborted) throw signal.reason ?? Error('NATIVE_IME_ABORTED');
  const key = '__IDEOGRAM_NATIVE_IME_OBSERVER__' + nonce;
  const owner = randomUUID();
  let reason = null, timer, wake, installed = false;
  const interrupt = value => { reason ??= value; wake?.(); };
  const aborted = () => interrupt('aborted');
  const navigated = frame => { if (frame === page.mainFrame()) interrupt('navigation'); };
  const closed = () => interrupt('page-closed'), crashed = () => interrupt('page-crashed');
  const records = [];
  let raw = {kind: 'native-ime-raw-1', nonce, clock: 'browser-performance', timeOrigin: null,
    armedMs: null, startMs: null, endMs: null, captureStoppedMs: null, durationMs: 60000,
    initial: null, final: null, records, overflow: false, interruptions: [], cleanup: {removed: false}};
  const accept = chunk => {
    if (!chunk) return false;
    const {rows, done, ...state} = chunk;
    records.push(...rows);
    raw = {...state, records};
    return done;
  };
  // Every remote wait is bounded, including a renderer which never responds.
  // A lost renderer cannot certify cleanup; retain the last real checkpoint.
  const remote = async operation => {
    let deadline;
    try { return await Promise.race([operation(), new Promise((_, reject) => {
      deadline = setTimeout(() => reject(Error('NATIVE_IME_RENDERER_TIMEOUT')), 5000);
    })]); } finally { clearTimeout(deadline); }
  };
  signal?.addEventListener('abort', aborted, {once: true});
  page.on('framenavigated', navigated); page.on('close', closed); page.on('crash', crashed);
  try {
    installed = true;
    accept(await remote(() => page.evaluate(({key, owner, nonce, armTimeoutMs}) => {
      if (globalThis[key]) throw Error('NATIVE_IME_OBSERVER_ALREADY_INSTALLED');
      const MAX_RECORDS = 4096, MAX_BYTES = 8 * 1024 * 1024, MAX_TEXT = 16384, MAX_HASH_JOBS = 64;
      const types = ['compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input',
        'keydown', 'pointerdown', 'click', 'select', 'focusin', 'focusout'];
      const encoder = new TextEncoder(), nodes = new WeakMap(), parents = new WeakMap();
      const original = document.querySelector('#native-text-content'), originalParent = original?.parentNode ?? null;
      let nextNode = 1, nextParent = 1, captureOrdinal = 0, composing = false, stopped = false, stoppedHashing = false;
      let armTimer, endTimer, hashTimer, observer, bytes = 4096, readIndex = 0, pending = 0, pumpRunning = false;
      const rows = [], jobs = [], pendingAfter = new Set(), completed = new WeakSet();
      const value = {kind: 'native-ime-raw-1', nonce, clock: 'browser-performance', timeOrigin: performance.timeOrigin,
        armedMs: performance.now(), startMs: null, endMs: null, captureStoppedMs: null, durationMs: 60000,
        initial: null, final: null, overflow: false, interruptions: [], cleanup: {removed: false}};
      const note = reason => { if (!value.interruptions.includes(reason)) value.interruptions.push(reason); };
      const overflow = reason => { value.overflow = true; note(reason); if (!stopped) queueMicrotask(() => stop('overflow')); };
      const boundedString = (text, limit = 128) => {
        if (typeof text !== 'string') return null;
        if (text.length > limit) { overflow('public-string-overflow'); return null; }
        return text;
      };
      const textBytes = text => {
        if (typeof text !== 'string') return null;
        if (text.length > MAX_TEXT) { overflow('text-overflow'); return null; }
        const data = encoder.encode(text);
        if (data.length > MAX_TEXT) { overflow('text-overflow'); return null; }
        return data;
      };
      const identity = (map, node, next) => {
        if (!node) return null;
        if (!map.has(node)) map.set(node, next());
        return map.get(node);
      };
      if (original) identity(nodes, original, () => nextNode++);
      if (originalParent) identity(parents, originalParent, () => nextParent++);
      const visible = node => {
        if (!node?.isConnected || !node.getClientRects().length) return false;
        for (let item = node; item; item = item.parentElement) {
          const style = getComputedStyle(item);
          if (item.hidden || item.hasAttribute('inert') || item.getAttribute('aria-hidden') === 'true' ||
            style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
        }
        return true;
      };
      const capture = () => {
        const node = document.querySelector('#native-text-content'), editor = document.querySelector('#native-text-editor');
        const attribute = name => boundedString(editor?.getAttribute(name) ?? null);
        const counter = name => {
          const text = attribute('data-presentation-' + name);
          return /^(0|[1-9][0-9]*)$/.test(text ?? '') && Number.isSafeInteger(Number(text)) ? Number(text) : null;
        };
        const revision = attribute('data-text-version');
        const state = {connected: node?.isConnected ?? false, parentUnchanged: !!node && node.parentNode === originalParent,
          nodeId: identity(nodes, node, () => nextNode++), parentId: identity(parents, node?.parentNode, () => nextParent++),
          visible: visible(node), focused: !!node && document.activeElement === node,
          start: node?.selectionStart ?? null, end: node?.selectionEnd ?? null, direction: node?.selectionDirection ?? null,
          scrollTop: node?.scrollTop ?? null, scrollLeft: node?.scrollLeft ?? null, units: node?.value?.length ?? null, textHash: null,
          presentation: attribute('data-presentation'), session: attribute('data-session'), revision: attribute('data-revision'),
          textVersion: /^(0|[1-9][0-9]*)$/.test(revision ?? '') && Number.isSafeInteger(Number(revision)) ? Number(revision) : null,
          switch: {pending: attribute('data-presentation-pending'), request: counter('request'), requestEpoch: counter('request-epoch'),
            requestGeneration: counter('request-generation'), requestTextVersion: counter('request-text-version'), settled: counter('settled'),
            rejected: counter('rejected'), rejectedEpoch: counter('rejected-epoch'), rejectedGeneration: counter('rejected-generation'),
            rejectedCurrentEpoch: counter('rejected-current-epoch'), rejectedCurrentGeneration: counter('rejected-current-generation'),
            rejectedTextVersion: counter('rejected-text-version'), rejectedCurrentTextVersion: counter('rejected-current-text-version'),
            rejectedGuards: counter('rejected-guards'), rejectedBoundary: attribute('data-presentation-rejected-boundary'),
            reason: attribute('data-presentation-reason'), superseded: counter('superseded')}};
        return {state, data: textBytes(node?.value)};
      };
      // Capture ordering is established before hashing. Cryptographic completion
      // never changes row order or either snapshot's browser timestamp.
      const pump = async () => {
        if (pumpRunning) return;
        pumpRunning = true;
        try {
          while (jobs.length && !stoppedHashing) {
            const job = jobs.shift();
            try {
              const digest = await crypto.subtle.digest('SHA-256', job.data);
              if (!stoppedHashing) job.target[job.field] = 'sha256:' + [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
            } catch { note('hash-failed'); } finally { job.data = null; pending--; }
          }
        } finally { pumpRunning = false; }
      };
      const hash = (data, target, field) => {
        if (!data) return;
        if (pending >= MAX_HASH_JOBS || stoppedHashing) { overflow('hash-queue-overflow'); return; }
        pending++; jobs.push({data, target, field}); void pump();
      };
      const snapshot = () => {
        const ordinal = captureOrdinal++;
        try {
          const captured = capture(); hash(captured.data, captured.state, 'textHash'); return {state: captured.state, ordinal};
        } catch {
          note('snapshot-failed'); if (!stopped) queueMicrotask(() => stop('snapshot-failed'));
          return {state: null, ordinal};
        }
      };
      const finishRow = row => {
        const size = encoder.encode(JSON.stringify(row)).length + 2;
        // Hashes are still pending here; reserve their maximum serialized growth.
        bytes += size + 256;
        if (bytes > MAX_BYTES - 8192) overflow('serialized-overflow');
        completed.add(row);
      };
      const append = row => {
        if (rows.length >= MAX_RECORDS || bytes > MAX_BYTES - 16384) { overflow('record-overflow'); return false; }
        row.ordinal = rows.length; rows.push(row); return true;
      };
      const inside = now => value.startMs !== null && now <= value.endMs;
      const stateRow = () => {
        if (stopped) return;
        const now = performance.now();
        if (!inside(now)) return;
        const captured = snapshot(), state = captured.state;
        const row = {ordinal: null, type: 'state', timeStampMs: null, observedMs: now, afterObservedMs: now,
          beforeCaptureOrdinal: captured.ordinal, afterCaptureOrdinal: captured.ordinal,
          isTrusted: null, composing, control: 'text', eventDataHash: null, inputType: null, before: state, after: state};
        if (append(row)) finishRow(row);
      };
      const classify = event => {
        const path = event.composedPath(), node = document.querySelector('#native-text-content');
        if (node && path.includes(node)) return 'text';
        const editor = document.querySelector('#native-text-editor');
        if (!editor || !path.includes(editor)) return 'other';
        // En Reve's shadow button may contain only an empty slot; its public
        // host retains the label. Prefer that host before a native fallback.
        const button = path.find(item => item?.localName === 'en-button') ?? path.find(item => item?.localName === 'button');
        const label = button?.textContent?.trim();
        if (label === 'Continue in inspector' || label === 'Return to card' || label === 'Cancel switch') return 'presentation';
        return label === 'Cancel text edit' ? 'cancel' : 'other';
      };
      const listener = event => {
        if (stopped) return;
        const now = performance.now(), control = classify(event);
        if (control === 'other') {
          if (event.isTrusted && /^(keydown|pointerdown|composition)/.test(event.type)) note('unrelated-activity');
          return;
        }
        if (value.startMs === null) {
          if (event.isTrusted !== true || !/^(keydown|pointerdown|composition)/.test(event.type)) return;
          value.startMs = event.timeStamp; value.endMs = event.timeStamp + value.durationMs;
          clearTimeout(armTimer); endTimer = setTimeout(() => stop(), Math.max(0, value.endMs - now));
        }
        if (!inside(now)) return;
        // This is the observed composition lifetime, not an inferred OS source
        // or a default for an event whose isComposing property is absent.
        if (event.type === 'compositionstart') composing = true;
        else if (event.type === 'compositionend') composing = false;
        const before = snapshot();
        const row = {ordinal: null, type: event.type, timeStampMs: event.timeStamp, observedMs: now, afterObservedMs: null,
          beforeCaptureOrdinal: before.ordinal, afterCaptureOrdinal: null,
          isTrusted: event.isTrusted === true, composing, control, eventDataHash: null,
          inputType: boundedString(event.inputType, 128), before: before.state, after: null};
        if (!append(row)) return;
        hash(textBytes(event.data), row, 'eventDataHash');
        pendingAfter.add(row);
        queueMicrotask(() => {
          row.afterObservedMs = performance.now(); const after = snapshot(); row.after = after.state;
          row.afterCaptureOrdinal = after.ordinal; pendingAfter.delete(row); finishRow(row);
        });
      };
      const pagehide = () => stop('navigation'), visibility = () => {
        if (document.visibilityState !== 'visible') { note('document-hidden'); stop('document-hidden'); }
      };
      const stop = reason => {
        if (stopped) return;
        stopped = true; if (reason) note(reason);
        value.captureStoppedMs = performance.now();
        try {
          for (const type of types) document.removeEventListener(type, listener, true);
          document.removeEventListener('visibilitychange', visibility, true);
          globalThis.removeEventListener('pagehide', pagehide, true);
          observer?.disconnect(); clearTimeout(armTimer); clearTimeout(endTimer);
          value.cleanup.removed = true;
        } catch { note('cleanup-failed'); }
        value.final = snapshot().state;
        hashTimer = setTimeout(() => {
          if (pending || pendingAfter.size) note('hash-drain-timeout');
          stoppedHashing = true;
          for (const job of jobs.splice(0)) { job.data = null; pending--; }
        }, 5000);
      };
      const drain = () => {
        // A row is not exposed before both snapshots and all earlier hashes.
        // Polling reads recorder state only, and never touches product inputs.
        const output = [];
        if (pending === 0 || stoppedHashing) {
          while (readIndex < rows.length && completed.has(rows[readIndex])) output.push(rows[readIndex++]);
        }
        const done = stopped && (pending === 0 || stoppedHashing) && pendingAfter.size === 0;
        if (done) clearTimeout(hashTimer);
        return {...value, rows: output, done};
      };
      globalThis[key] = {owner, stop, drain, dispose: () => {
        stop('observer-disposed');
        if (pending || pendingAfter.size) note('hash-drain-incomplete');
        stoppedHashing = true;
        for (const job of jobs.splice(0)) { job.data = null; pending--; }
        clearTimeout(hashTimer); delete globalThis[key];
      }};
      try {
        value.initial = snapshot().state;
        for (const type of types) document.addEventListener(type, listener, {capture: true, passive: true});
        document.addEventListener('visibilitychange', visibility, {capture: true, passive: true});
        globalThis.addEventListener('pagehide', pagehide, {capture: true, passive: true});
        observer = new MutationObserver(mutations => {
          const node = document.querySelector('#native-text-content'), editor = document.querySelector('#native-text-editor');
          if (mutations.some(mutation => mutation.target === node || mutation.target === editor ||
            editor?.contains(mutation.target) || mutation.target?.contains?.(editor) ||
            [...(mutation.removedNodes ?? [])].some(removed => removed === original || removed.contains?.(original)))) stateRow();
        });
        observer.observe(document, {subtree: true, childList: true, attributes: true,
          attributeFilter: ['hidden', 'aria-hidden', 'inert', 'style', 'class', 'data-presentation', 'data-session', 'data-revision',
            'data-text-version', ...['pending', 'request', 'request-epoch', 'request-generation', 'request-text-version', 'settled',
              'rejected', 'rejected-epoch', 'rejected-generation', 'rejected-current-epoch', 'rejected-current-generation',
              'rejected-text-version', 'rejected-current-text-version', 'rejected-guards', 'rejected-boundary', 'reason', 'superseded']
              .map(name => 'data-presentation-' + name)]});
        armTimer = setTimeout(() => stop('arm-timeout'), armTimeoutMs);
        if (!original) stop('text-node-unavailable');
        else if (document.visibilityState !== 'visible') stop('document-hidden');
      } catch { stop('observer-setup-failed'); }
      return drain();
    }, {key, owner, nonce, armTimeoutMs})));
    if (onArmed && !raw.cleanup.removed) {
      try { await remote(() => onArmed({nonce, armedMs: raw.armedMs, timeOrigin: raw.timeOrigin})); }
      catch { reason = 'arming-notification-failed'; }
    }
    const deadline = performance.now() + armTimeoutMs + 60000 + 12000;
    while (true) {
      if (reason) await remote(() => page.evaluate(({key, owner, reason}) => {
        if (globalThis[key]?.owner === owner) globalThis[key].stop(reason);
      }, {key, owner, reason}));
      const chunk = await remote(() => page.evaluate(({key, owner}) => globalThis[key]?.owner === owner ? globalThis[key].drain() : null, {key, owner}));
      if (!chunk) { reason ??= 'recorder-unavailable'; break; }
      const done = accept(chunk);
      if (done) break;
      if (performance.now() > deadline) { reason = 'observer-deadline'; break; }
      await new Promise(resolve => { wake = resolve; timer = setTimeout(resolve, 100); });
      clearTimeout(timer); wake = null;
    }
  } catch { reason ??= 'renderer-unavailable'; }
  finally {
    clearTimeout(timer); signal?.removeEventListener('abort', aborted);
    page.off('framenavigated', navigated); page.off('close', closed); page.off('crash', crashed);
    if (installed) {
      try {
        // A final drain can retain pagehide/abort cleanup if that realm survives.
        const chunk = await remote(() => page.evaluate(({key, owner, reason}) => {
          const recorder = globalThis[key]; if (!recorder || recorder.owner !== owner) return null;
          recorder.stop(reason); const result = recorder.drain(); recorder.dispose(); return result;
        }, {key, owner, reason}));
        accept(chunk);
      } catch { raw.cleanup = {removed: false}; }
    }
  }
  if (reason && !raw.interruptions.includes(reason)) raw.interruptions.push(reason);
  return raw;
}
