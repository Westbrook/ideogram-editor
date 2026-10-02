/** Fixture-only observation of an original response's parse delivery. This is
 * not model adoption, UI publication, renderer paint, or presentation evidence.
 * Keep this function self-contained: Playwright serializes it into the page. */
export function installE4DeliveryObserver(options) {
  'use strict';
  if (options === undefined) options = {};
  const realm = window;
  const ceilings = { bodyBytes: 65536, totalBytes: 1048576, pending: 32, rows: 4096, errors: 64 };
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.prototype.toString.call(options) !== '[object Object]' || Object.keys(options).some(key => key !== 'limits')) throw Error('E4_OBSERVER_LIMITS');
  if (options.limits !== undefined && (!options.limits || typeof options.limits !== 'object' || Array.isArray(options.limits) || Object.prototype.toString.call(options.limits) !== '[object Object]')) throw Error('E4_OBSERVER_LIMITS');
  const limits = { ...ceilings, ...(options.limits ?? {}) };
  if (Object.keys(limits).some(key => !Object.hasOwn(ceilings, key)) || Object.entries(limits).some(([key, value]) => !Number.isSafeInteger(value) || value < 1 || value > ceilings[key])) throw Error('E4_OBSERVER_LIMITS');
  if (realm.__p25DeliveryObserver) throw Error('E4_OBSERVER_ALREADY_INSTALLED');
  const nativeFetch = realm.fetch, nativeParse = JSON.parse;
  const nativeStringify = JSON.stringify, nativeNow = Date.now.bind(Date), nativeMonotonic = performance.now.bind(performance);
  const deliveries = [], errors = [], active = new Set(), flights = new Set(), restores = [], wrappedResponses = new WeakSet();
  let retainedBytes = 0, recordBytes = 0, rows = 0, errorCount = 0, droppedErrors = 0, operations = 0, disabled = false, disposed = false;
  realm.__p25OriginalFetch = nativeFetch.bind(realm);
  realm.__p25Deliveries = deliveries;
  realm.__p25DeliveryErrors = errors;

  function discard(record) {
    if (!record.live) return;
    record.live = false; active.delete(record); retainedBytes -= record.held;
    record.held = 0; record.buffer = null; record.text = null;
    const retired = record.restores; record.restores = [];
    for (let index = retired.length - 1; index >= 0; index--) {
      try { retired[index](); } catch { fail('E4_OBSERVER_RESTORE_FAILURE'); }
    }
  }
  function fail(code) {
    errorCount++;
    if (errorCount <= limits.errors) errors.push(Object.freeze({ code, at: nativeNow() }));
    else droppedErrors++;
    disabled = true; flights.clear();
    for (const record of active) discard(record);
  }
  function observe(run) {
    if (disposed || disabled) return;
    try { run(); } catch { fail('E4_OBSERVER_FAILURE'); }
  }
  function tap(promise, fulfilled, rejected = () => {}) {
    // Observe a side branch; always return the ORIGINAL promise to the caller.
    // Both native rejection and observer failure are handled on that branch.
    void promise.then(value => observe(() => fulfilled(value)), error => observe(() => rejected(error))).catch(() => fail('E4_OBSERVER_BRANCH_FAILURE'));
  }
  function selected(raw, method) {
    const url = new URL(raw, location.href);
    if (url.origin !== location.origin || url.username || url.password) return null;
    const reads = /^\/api\/v1\/(?:queue|(?:jobs|documents)\/[A-Za-z0-9_-]{1,128}\/candidates|commands\/[A-Za-z0-9_-]{1,128})$/.test(url.pathname);
    if (!(method === 'GET' && reads || method === 'POST' && url.pathname === '/api/v1/commands')) return null;
    if (url.href.length > 4096) { fail('E4_OBSERVER_URL_LIMIT'); return null; }
    return url;
  }
  function replace(target, key, value, record) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, writable: true, enumerable: descriptor?.enumerable ?? false, value });
    (record ? record.restores : restores).push(() => {
      if (target[key] !== value) return;
      if (descriptor) Object.defineProperty(target, key, descriptor); else delete target[key];
    });
  }
  function scalar(value) {
    if (value === null || value === undefined || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.length <= 256) return value;
    throw Error('E4_OBSERVER_PROJECTION');
  }
  function project(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return Object.freeze({});
    const result = {};
    if (Array.isArray(value.jobs)) {
      if (value.jobs.length > 64) throw Error('E4_OBSERVER_PROJECTION');
      result.jobs = Object.freeze(value.jobs.map(job => Object.freeze({ id: scalar(job.id), version: scalar(job.version) })));
    }
    if (value.receipt && typeof value.receipt === 'object') result.receipt = Object.freeze({ commandId: scalar(value.receipt.commandId), toSeq: scalar(value.receipt.toSeq) });
    if (value.jobId !== undefined) result.jobId = scalar(value.jobId);
    if (Array.isArray(value.items)) {
      if (value.items.length > 64) throw Error('E4_OBSERVER_PROJECTION');
      result.items = Object.freeze(value.items.map(item => Object.freeze({ id: scalar(item.id), version: scalar(item.version), state: scalar(item.state), preparedAssetId: scalar(item.preparedAssetId) })));
    }
    if (value.observation && typeof value.observation === 'object') result.observation = Object.freeze({ digest: scalar(value.observation.digest) });
    return Object.freeze(result);
  }
  function publish(record, value, source) {
    if (!record.live || disposed || disabled) return;
    const at = nativeNow(), monotonic = nativeMonotonic(), projection = project(value);
    const row = Object.freeze({ clock: 'browser-wall-ms', at, monotonic, path: record.path, url: record.url, origin: record.origin, status: record.status, method: record.method, operation: record.operation, source,
      scope: 'original-response-parse-delivery', value: projection });
    const bytes = nativeStringify(row).length * 2;
    if (rows >= limits.rows || recordBytes + retainedBytes + bytes > limits.totalBytes) { fail('E4_OBSERVER_ROW_LIMIT'); return; }
    rows++; recordBytes += bytes; deliveries.push(row); discard(record);
  }
  function complete(record) {
    if (!record.live) return;
    if (record.count !== record.expected) { discard(record); fail('E4_OBSERVER_LENGTH'); return; }
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(record.buffer); }
    catch { discard(record); fail('E4_OBSERVER_UTF8'); return; }
    record.buffer = null;
    retainedBytes += text.length * 2 - record.held; record.held = text.length * 2;
    record.text = text; record.complete = true;
    const duplicates = [...active].filter(other => other.complete && other.text === text);
    if (duplicates.length > 1) fail('E4_OBSERVER_AMBIGUOUS_BODY');
  }
  function wrapResponse(response, requested, method, operation) {
    if (wrappedResponses.has(response)) { fail('E4_OBSERVER_REUSED_RESPONSE'); return; }
    wrappedResponses.add(response);
    const returned = selected(response.url, method);
    if (!returned || returned.href !== requested.href || response.redirected) { fail('E4_OBSERVER_RESPONSE_IDENTITY'); return; }
    // The finite E4 success path uses these JSON status codes. Error responses
    // stay entirely with the original consumer and cannot witness P1–P4.
    if (![200, 201, 202].includes(response.status)) return;
    if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(response.headers.get('content-type') ?? '')) { fail('E4_OBSERVER_MEDIA_TYPE'); return; }
    const length = response.headers.get('content-length'), expected = length !== null && /^(0|[1-9][0-9]*)$/.test(length) ? Number(length) : NaN;
    if (!Number.isSafeInteger(expected) || expected > limits.bodyBytes || !response.body) { fail('E4_OBSERVER_BODY_LIMIT'); return; }
    if (active.size + flights.size >= limits.pending) { fail('E4_OBSERVER_PENDING_LIMIT'); return; }
    const record = { live: true, path: returned.pathname, url: returned.href, origin: returned.origin, status: response.status, method, operation, expected, held: 0, count: 0,
      buffer: null, text: null, complete: false, readers: 0, json: false, unlocked: false, restores: [] };
    active.add(record);
    const body = response.body, getReader = body.getReader, json = response.json;
    replace(response, 'json', function (...args) {
      const owned = this === response;
      if (owned) observe(() => {
        if (!record.live) return;
        if (record.json || record.readers) { discard(record); fail('E4_OBSERVER_MULTIPLE_CONSUMERS'); return; }
        record.json = true;
      });
      let promise;
      try { promise = Reflect.apply(json, this, args); }
      catch (error) { if (owned) observe(() => discard(record)); throw error; }
      if (owned && record.live) tap(promise, value => publish(record, value, 'original-response-json'), () => discard(record));
      return promise;
    }, record);
    for (const [target, key] of [[response, 'clone'], [body, 'tee'], [body, 'cancel']]) {
      const original = target[key];
      if (typeof original !== 'function') continue;
      replace(target, key, function (...args) {
        const result = Reflect.apply(original, this, args);
        if (this === target) observe(() => discard(record));
        return result;
      }, record);
    }
    replace(body, 'getReader', function (...args) {
      let reader;
      try { reader = Reflect.apply(getReader, this, args); }
      catch (error) { if (this === body) observe(() => discard(record)); throw error; }
      if (this !== body) return reader;
      observe(() => {
        // A native Response.json implementation may obtain its reader through
        // this public method; its own original promise is the completion proof.
        if (!record.live || record.json) return;
        if (record.readers++) { discard(record); fail('E4_OBSERVER_MULTIPLE_CONSUMERS'); return; }
        // One fixed copy plus a worst-case UTF-16 decode, independent of the
        // original reader's fragmentation. No original chunk is retained.
        const reservation = expected * 3;
        if (retainedBytes + recordBytes + reservation > limits.totalBytes) { discard(record); fail('E4_OBSERVER_TOTAL_LIMIT'); return; }
        record.buffer = new Uint8Array(expected); record.held = reservation; retainedBytes += reservation;
        const read = reader.read, cancel = reader.cancel, releaseLock = reader.releaseLock;
        replace(reader, 'read', function (...args) {
          let promise;
          try { promise = Reflect.apply(read, this, args); }
          catch (error) { if (this === reader) observe(() => discard(record)); throw error; }
          if (this !== reader) return promise;
          tap(promise, result => {
            if (!record.live || record.complete) return;
            if (result.done) { complete(record); return; }
            if (!(result.value instanceof Uint8Array) || record.count + result.value.byteLength > record.expected) { discard(record); fail('E4_OBSERVER_LENGTH'); return; }
            record.buffer.set(result.value, record.count); record.count += result.value.byteLength;
          }, () => discard(record));
          return promise;
        }, record);
        replace(reader, 'releaseLock', function (...args) {
          let result;
          try { result = Reflect.apply(releaseLock, this, args); }
          catch (error) { if (this === reader) observe(() => discard(record)); throw error; }
          if (this === reader) observe(() => { if (record.live) record.unlocked = true; });
          return result;
        }, record);
        replace(reader, 'cancel', function (...args) {
          let promise;
          try { promise = Reflect.apply(cancel, this, args); }
          catch (error) { if (this === reader) observe(() => discard(record)); throw error; }
          if (this === reader) observe(() => discard(record));
          return promise;
        }, record);
      });
      return reader;
    }, record);
  }
  const parsed = function (...args) {
    let value;
    try { value = Reflect.apply(nativeParse, this, args); }
    catch (error) {
      observe(() => { if (typeof args[0] === 'string') for (const record of active) if (record.complete && record.text === args[0]) discard(record); });
      throw error;
    }
    observe(() => {
      if (typeof args[0] !== 'string') return;
      const matches = [...active].filter(record => record.complete && record.text === args[0]);
      if (args.length !== 1) { for (const record of matches) discard(record); return; }
      if (matches.length > 1) { fail('E4_OBSERVER_AMBIGUOUS_BODY'); return; }
      if (matches.length === 1 && matches[0].unlocked) publish(matches[0], value, 'original-reader-json-parse');
    });
    return value;
  };
  const fetched = function (...args) {
    const promise = Reflect.apply(nativeFetch, this, args);
    observe(() => {
      const input = args[0], raw = typeof input === 'string' ? input : input instanceof Request ? input.url : input instanceof URL ? input.href : null;
      const init = args[1];
      // Native fetch already read the dictionary. Never invoke an accessor or
      // custom input coercion again merely to attribute this observation.
      if (init !== undefined && init !== null && (typeof init !== 'object' || Array.isArray(init) || ![Object.prototype, null].includes(Object.getPrototypeOf(init)))) return;
      const methodDescriptor = init == null ? undefined : Object.getOwnPropertyDescriptor(init, 'method');
      if (methodDescriptor && !('value' in methodDescriptor) || !methodDescriptor && init != null && 'method' in init) return;
      const suppliedMethod = methodDescriptor && methodDescriptor.value !== undefined ? methodDescriptor.value : (input instanceof Request ? Reflect.apply(Object.getOwnPropertyDescriptor(Request.prototype, 'method').get, input, []) : 'GET');
      const method = typeof suppliedMethod === 'string' ? suppliedMethod.toUpperCase() : '';
      const requested = raw === null ? null : selected(raw, method);
      if (!requested || disabled) return;
      if (active.size + flights.size >= limits.pending || operations >= limits.rows + limits.pending) { fail('E4_OBSERVER_PENDING_LIMIT'); return; }
      const flight = { operation: ++operations }; flights.add(flight);
      void promise.then(response => {
        const owned = flights.delete(flight);
        if (owned) observe(() => wrapResponse(response, requested, method, flight.operation));
      }, () => { flights.delete(flight); }).catch(() => fail('E4_OBSERVER_BRANCH_FAILURE'));
    });
    return promise;
  };
  replace(JSON, 'parse', parsed);
  replace(realm, 'fetch', fetched);
  realm.__p25DeliveryObserver = Object.freeze({
    snapshot() { return Object.freeze({ pending: active.size + flights.size, ownedMethods: [...active].reduce((count, record) => count + record.restores.length, 0), retainedBytes, recordBytes, rows, errors: errorCount, droppedErrors, operations, disabled, disposed }); },
    dispose() {
      if (disposed) return;
      disposed = true; flights.clear();
      for (const record of active) discard(record);
      for (let index = restores.length - 1; index >= 0; index--) {
        try { restores[index](); } catch { fail('E4_OBSERVER_RESTORE_FAILURE'); }
      }
      restores.length = 0;
    },
  });
}
