import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {createContext, runInContext} from 'node:vm';
import {observeNativeIme} from '../../tooling/qualification/campaigns/browser-native-ime-observer.mjs';

// Synthetic unit coverage of the installed, actual observer source. This fake
// DOM/clock cannot supply native IME, trusted OS input, or qualification proof.
const plan = {kind: 'native-ime-plan-1', durationMs: 60000};
const digest = text => 'sha256:' + createHash('sha256').update(text).digest('hex');
const flush = async () => { for (let i = 0; i < 400; i++) await Promise.resolve(); };
function fixture({hashPaused = false, missing = false} = {}) {
  let now = 10, timerId = 0, rawText = 'sealed initial', realmLost = false, hashCalls = 0;
  const timers = new Map(), observers = new Set(), windowListeners = new Map(), documentListeners = new Map(), pageListeners = new Map();
  const delayedHashes = [], setters = [];
  const listen = (map, type, listener) => { const set = map.get(type) ?? new Set(); set.add(listener); map.set(type, set); };
  const unlisten = (map, type, listener) => map.get(type)?.delete(listener);
  const count = map => [...map.values()].reduce((sum, set) => sum + set.size, 0);
  const element = (localName, parentElement = null) => ({localName, parentElement, parentNode: parentElement, isConnected: true,
    hidden: false, attrs: new Map(), textContent: '', getAttribute(name) { return this.attrs.get(name) ?? null; },
    hasAttribute(name) { return this.attrs.has(name); }, getClientRects() { return this.hidden ? [] : [{}]; },
    contains(other) { for (let current = other; current; current = current.parentElement) if (current === this) return true; return false; }});
  const editor = element('section'), parent = element('div', editor);
  for (const [key, value] of Object.entries({'data-presentation': 'anchored', 'data-session': 'fixture-session', 'data-revision': '7',
    'data-text-version': '3', 'data-presentation-pending': '', 'data-presentation-rejected-boundary': '', 'data-presentation-reason': ''})) editor.attrs.set(key, value);
  for (const key of ['request', 'request-epoch', 'request-generation', 'request-text-version', 'settled', 'rejected', 'rejected-epoch',
    'rejected-generation', 'rejected-current-epoch', 'rejected-current-generation', 'rejected-text-version',
    'rejected-current-text-version', 'rejected-guards', 'superseded']) editor.attrs.set('data-presentation-' + key, '0');
  const newNode = (container = parent) => {
    const node = Object.assign(element('textarea', container), {selectionStart: 2, selectionEnd: 5, selectionDirection: 'backward', scrollTop: 12, scrollLeft: 3});
    Object.defineProperty(node, 'value', {get: () => rawText, set: () => { setters.push('value'); throw Error('Observer mutated input'); }});
    node.focus = () => { setters.push('focus'); throw Error('Observer moved focus'); };
    node.setSelectionRange = () => { setters.push('range'); throw Error('Observer changed range'); };
    node.dispatchEvent = () => { setters.push('dispatch'); throw Error('Observer dispatched input'); };
    return node;
  };
  let node = missing ? null : newNode();
  const button = label => Object.assign(element('en-button', editor), {textContent: label});
  const presentation = button('Continue in inspector'), cancel = button('Cancel text edit');
  const document = {activeElement: node, visibilityState: 'visible',
    querySelector: selector => selector === '#native-text-content' ? node : selector === '#native-text-editor' ? editor : null,
    addEventListener: (type, listener, options) => { assert.equal(options.capture, true); assert.equal(options.passive, true); listen(documentListeners, type, listener); },
    removeEventListener: (type, listener) => unlisten(documentListeners, type, listener)};
  const sandbox = {document, TextEncoder, Uint8Array, WeakMap, WeakSet, Map, Set, performance: {timeOrigin: 1700000000000, now: () => now},
    queueMicrotask, getComputedStyle: item => ({display: item.hidden ? 'none' : 'block', visibility: 'visible'}),
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, {callback, at: now + delay}); return id; },
    clearTimeout: id => timers.delete(id), addEventListener: (type, listener) => listen(windowListeners, type, listener),
    removeEventListener: (type, listener) => unlisten(windowListeners, type, listener),
    crypto: {subtle: {digest: async (_algorithm, bytes) => {
      hashCalls++;
      if (hashPaused) await new Promise(resolve => delayedHashes.push(resolve));
      return createHash('sha256').update(bytes).digest();
    }}},
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe() { observers.add(this); }
      disconnect() { observers.delete(this); }
    }};
  const context = createContext(sandbox), frame = {};
  let armed;
  const installed = new Promise(resolve => { armed = resolve; });
  const page = {
    on: (type, listener) => listen(pageListeners, type, listener), off: (type, listener) => unlisten(pageListeners, type, listener), mainFrame: () => frame,
    evaluate: async (fn, arg) => {
      if (realmLost) throw Error('Execution context destroyed');
      context.__argument = structuredClone(arg);
      try {
        const result = await runInContext('(' + fn.toString() + ')(__argument)', context);
        if (Object.keys(context).some(key => key.startsWith('__IDEOGRAM_NATIVE_IME_OBSERVER__'))) armed();
        return structuredClone(result);
      } finally { delete context.__argument; }
    }};
  const emit = (type, {target = node, trusted = true, data, inputType, timeStamp = now, handler} = {}) => {
    const path = []; for (let current = target; current; current = current.parentElement) path.push(current); path.push(document);
    const event = {type, timeStamp, isTrusted: trusted, data, inputType, composedPath: () => path};
    for (const listener of [...(documentListeners.get(type) ?? [])]) listener(event);
    handler?.();
  };
  const mutate = target => { for (const observer of [...observers]) observer.callback([{target, removedNodes: []}]); };
  const advance = value => {
    now = value;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
  };
  const cleanup = () => {
    assert.equal(count(documentListeners), 0); assert.equal(count(windowListeners), 0);
    assert.equal(observers.size, 0); assert.equal(count(pageListeners), 0); assert.equal(timers.size, 0);
    assert.deepEqual(setters, []);
    assert.equal(Object.keys(context).filter(key => key.startsWith('__IDEOGRAM_NATIVE_IME_OBSERVER__')).length, 0);
  };
  return {page, installed, emit, mutate, advance, cleanup, document, editor, parent, presentation, cancel,
    get node() { return node; }, get hashCalls() { return hashCalls; }, get observerCount() { return observers.size; },
    setText: value => { rawText = value; },
    replace: () => { node.isConnected = false; node = newNode(element('div', editor)); document.activeElement = node; mutate(editor); },
    releaseHashes: () => { hashPaused = false; for (const resolve of delayedHashes.splice(0)) resolve(); },
    pagehide: () => { for (const listener of [...(windowListeners.get('pagehide') ?? [])]) listener(); },
    loseRealm: () => { realmLost = true; for (const listener of [...(pageListeners.get('framenavigated') ?? [])]) listener(frame); }};
}
async function arm(f, extra = {}) {
  const result = observeNativeIme(f.page, {nonce: 'synthetic-unit', plan, ...extra});
  await f.installed; await flush();
  return {result};
}
async function stopAtEnd(f, start = 10, lateness = 0) { f.advance(start + 60000 + lateness); await flush(); }

test('installed passive observer retains actual event clocks, before/after values and capture order', async () => {
  const f = fixture(), {result} = await arm(f);
  f.advance(12);
  f.emit('compositionstart', {timeStamp: 11.25, data: ''});
  await flush();
  f.advance(20);
  f.emit('beforeinput', {data: '日本語', inputType: 'insertCompositionText', handler: () => f.setText('se日本語initial')});
  await flush();
  f.advance(25); f.emit('input', {data: '日本語', inputType: 'insertCompositionText'}); await flush();
  f.advance(30); f.emit('compositionend', {data: '日本語'}); await flush();
  await stopAtEnd(f, 11.25, 17);
  const raw = await result;
  assert.equal(raw.startMs, 11.25); assert.equal(raw.endMs, 60011.25); assert.equal(raw.captureStoppedMs, 60028.25);
  assert.equal(raw.timeOrigin, 1700000000000); assert.equal(raw.armedMs, 10); assert.equal(raw.durationMs, 60000);
  assert.deepEqual(raw.records.map(row => row.ordinal), [0, 1, 2, 3]);
  assert.equal(raw.records[0].timeStampMs, 11.25); assert.equal(raw.records[0].observedMs, 12);
  const row = raw.records[1];
  assert.equal(row.before.textHash, digest('sealed initial')); assert.equal(row.after.textHash, digest('se日本語initial'));
  assert.equal(row.eventDataHash, digest('日本語')); assert.equal(row.afterObservedMs, 20);
  assert.ok(row.beforeCaptureOrdinal < row.afterCaptureOrdinal);
  assert.equal(row.before.start, 2); assert.equal(row.before.end, 5); assert.equal(row.before.direction, 'backward');
  assert.equal(row.before.scrollTop, 12); assert.equal(row.before.scrollLeft, 3);
  assert.equal(raw.records[0].composing, true); assert.equal(raw.records.at(-1).composing, false);
  assert.equal(raw.records.every(row => row.isTrusted && row.before.nodeId === 1 && row.before.parentId === 1), true);
  assert.deepEqual(raw.interruptions, []); assert.equal(raw.overflow, false); assert.equal(raw.cleanup.removed, true);
  assert.equal(JSON.stringify(raw).includes('日本語'), false); assert.equal(JSON.stringify(raw).includes('sealed initial'), false);
  f.cleanup();
});

test('synthetic input cannot start the native interval; arm expiry retains null interval anchors', async () => {
  const f = fixture(), {result} = await arm(f, {armTimeoutMs: 50});
  f.emit('compositionstart', {trusted: false, data: 'private text'}); await flush();
  f.advance(60); await flush();
  const raw = await result;
  assert.equal(raw.startMs, null); assert.equal(raw.endMs, null); assert.deepEqual(raw.records, []);
  assert.deepEqual(raw.interruptions, ['arm-timeout']); assert.equal(raw.captureStoppedMs, 60);
  f.cleanup();
});

test('arm acknowledgement follows listener installation and pending hashes cannot reorder raw snapshots', async () => {
  const f = fixture({hashPaused: true});
  const {result} = await arm(f, {onArmed: async ack => {
    assert.equal(ack.armedMs, 10); assert.equal(ack.timeOrigin, 1700000000000); assert.equal(f.observerCount, 1);
    f.emit('keydown');
  }});
  f.advance(20); f.emit('input', {trusted: false, data: 'first', handler: () => f.setText('first')}); await flush();
  f.advance(30); f.emit('input', {data: 'second', handler: () => f.setText('second')}); await flush();
  f.releaseHashes(); await flush(); await stopAtEnd(f);
  const raw = await result;
  assert.equal(raw.startMs, 10); assert.deepEqual(raw.records.map(row => row.observedMs), [10, 20, 30]);
  assert.equal(raw.records[1].isTrusted, false); assert.equal(raw.records[1].before.textHash, digest('sealed initial'));
  assert.equal(raw.records[1].after.textHash, digest('first')); assert.equal(raw.records[2].before.textHash, digest('first'));
  assert.equal(raw.records[2].after.textHash, digest('second')); f.cleanup();
});

test('presentation, cancel and same-node hidden cleanup remain observations without input mutation', async () => {
  const f = fixture(), {result} = await arm(f);
  f.emit('pointerdown', {target: f.presentation}); await flush();
  f.advance(15);
  f.emit('click', {target: f.presentation, handler: () => {
    f.editor.attrs.set('data-presentation-request', '1'); f.editor.attrs.set('data-presentation', 'inspector');
  }}); await flush();
  f.advance(20); f.emit('compositionstart'); await flush();
  f.advance(25); f.emit('click', {target: f.cancel}); await flush();
  f.advance(30); f.emit('compositionend', {data: '', handler: () => {
    f.editor.hidden = true; f.editor.attrs.set('data-session', ''); f.setText('');
    f.editor.attrs.set('data-presentation-rejected-guards', '7'); f.editor.attrs.set('data-presentation-rejected-boundary', 'cancel-native-end');
  }}); await flush(); f.mutate(f.editor); await flush();
  await stopAtEnd(f); const raw = await result;
  assert.equal(raw.records[0].control, 'presentation'); assert.equal(raw.records[1].after.switch.request, 1);
  assert.equal(raw.records[3].control, 'cancel');
  const end = raw.records.find(row => row.type === 'compositionend');
  assert.equal(end.before.textHash, digest('sealed initial')); assert.equal(end.after.textHash, digest(''));
  assert.equal(end.after.visible, false); assert.equal(end.after.session, ''); assert.equal(end.after.nodeId, 1);
  assert.equal(end.after.switch.rejectedGuards, 7); assert.equal(end.after.switch.rejectedBoundary, 'cancel-native-end');
  const state = raw.records.at(-1); assert.equal(state.type, 'state'); assert.deepEqual(state.before, state.after);
  assert.equal(state.observedMs, state.afterObservedMs); assert.equal(state.isTrusted, null);
  assert.equal(state.beforeCaptureOrdinal, state.afterCaptureOrdinal); assert.equal(state.timeStampMs, null);
  f.cleanup();
});

test('equal browser times preserve nested event snapshot order and En Reve shadow controls use their public host', async () => {
  const f = fixture(), {result} = await arm(f);
  const shadowButton = {localName: 'button', textContent: '', parentElement: f.presentation};
  f.emit('pointerdown', {target: shadowButton}); await flush();
  f.emit('click', {target: shadowButton, handler: () => {
    f.emit('compositionstart', {handler: () => f.setText('nested native update')});
  }}); await flush(); await stopAtEnd(f);
  const raw = await result, click = raw.records[1], nested = raw.records[2];
  assert.equal(click.control, 'presentation'); assert.equal(click.observedMs, nested.observedMs);
  assert.equal(click.afterObservedMs, nested.afterObservedMs);
  assert.ok(click.beforeCaptureOrdinal < nested.beforeCaptureOrdinal);
  assert.ok(nested.beforeCaptureOrdinal < click.afterCaptureOrdinal);
  assert.ok(click.afterCaptureOrdinal < nested.afterCaptureOrdinal);
  assert.equal(nested.before.textHash, digest('sealed initial')); assert.equal(click.after.textHash, digest('nested native update'));
  f.cleanup();
});

test('replacement node and parent receive new identities; unrelated content is never captured', async () => {
  const f = fixture(), {result} = await arm(f);
  f.emit('keydown'); await flush(); f.advance(20); f.replace(); await flush();
  f.emit('keydown', {target: {parentElement: null}, data: 'secret outside selected editor'});
  await stopAtEnd(f); const raw = await result;
  assert.equal(raw.records.at(-1).after.nodeId, 2); assert.equal(raw.records.at(-1).after.parentId, 2);
  assert.equal(raw.records.at(-1).after.parentUnchanged, false); assert.ok(raw.interruptions.includes('unrelated-activity'));
  assert.equal(JSON.stringify(raw).includes('secret outside'), false); f.cleanup();
});

test('posthandler state after deadline is timestamped outside it and later events are excluded', async () => {
  const f = fixture(), {result} = await arm(f);
  f.emit('keydown'); await flush(); f.advance(60009);
  f.emit('compositionend', {handler: () => { f.advance(60020); f.setText('late cleanup'); }});
  await flush(); f.emit('input', {data: 'late cleanup'});
  const raw = await result;
  assert.equal(raw.endMs, 60010); assert.equal(raw.records.at(-1).observedMs, 60009);
  assert.equal(raw.records.at(-1).afterObservedMs, 60020); assert.equal(raw.captureStoppedMs, 60020);
  assert.equal(raw.records.some(row => row.type === 'input'), false); f.cleanup();
});

test('abort removes browser listeners, observer, timers and page listeners', async () => {
  const f = fixture(), controller = new AbortController(), {result} = await arm(f, {signal: controller.signal});
  f.emit('compositionstart'); await flush(); f.advance(21); controller.abort();
  const raw = await result;
  assert.ok(raw.interruptions.includes('aborted')); assert.equal(raw.captureStoppedMs, 21);
  assert.equal(raw.cleanup.removed, true); f.cleanup();
});

test('a failing asynchronous snapshot stops capture and retains missing state without leaking observers', async () => {
  const f = fixture(), {result} = await arm(f);
  f.emit('keydown', {handler: () => { f.node.getClientRects = () => { throw Error('Synthetic layout read failure'); }; }});
  await flush(); const raw = await result;
  assert.ok(raw.interruptions.includes('snapshot-failed')); assert.equal(raw.records[0].after, null);
  assert.equal(raw.final, null); assert.equal(raw.cleanup.removed, true); f.cleanup();
});

test('a duplicate invocation cannot remove the recorder owned by the original attempt', async () => {
  const f = fixture(), first = await arm(f);
  const duplicate = await observeNativeIme(f.page, {nonce: 'synthetic-unit', plan});
  assert.ok(duplicate.interruptions.includes('renderer-unavailable'));
  assert.equal(duplicate.cleanup.removed, false); assert.equal(f.observerCount, 1);
  f.emit('keydown'); await flush(); await stopAtEnd(f);
  const raw = await first.result;
  assert.equal(raw.startMs, 10); assert.equal(raw.records.length, 1); assert.equal(raw.cleanup.removed, true); f.cleanup();
});

test('pagehide cleans up in its original realm; destroyed realm retains an honest incomplete checkpoint', async () => {
  const f = fixture(), {result} = await arm(f);
  f.emit('keydown'); await flush(); f.advance(30); f.pagehide(); await flush();
  const raw = await result; assert.ok(raw.interruptions.includes('navigation')); assert.equal(raw.cleanup.removed, true); f.cleanup();
  const lost = fixture(), attempt = await arm(lost);
  lost.loseRealm(); const incomplete = await attempt.result;
  assert.ok(incomplete.interruptions.includes('navigation')); assert.equal(incomplete.cleanup.removed, false);
  assert.equal(incomplete.captureStoppedMs, null);
});

test('UTF8 text and bounded hash queue overflow are explicit and cannot become native evidence', async () => {
  const f = fixture(), {result} = await arm(f);
  f.emit('keydown'); await flush(); f.setText('語'.repeat(6000)); f.emit('input', {data: '語'.repeat(6000)}); await flush();
  const raw = await result;
  assert.equal(raw.overflow, true); assert.ok(raw.interruptions.includes('text-overflow'));
  assert.equal(raw.final.textHash, null); assert.ok(Buffer.byteLength(JSON.stringify(raw)) < 8 * 1024 * 1024); f.cleanup();
  const queued = fixture({hashPaused: true}), attempt = await arm(queued);
  queued.emit('keydown');
  for (let i = 0; i < 100; i++) queued.emit('input', {data: 'bounded'});
  await flush(); queued.releaseHashes(); await flush();
  const overflow = await attempt.result;
  assert.equal(overflow.overflow, true); assert.ok(overflow.interruptions.includes('hash-queue-overflow'));
  assert.ok(queued.hashCalls <= 64); assert.ok(overflow.records.length <= 4096); queued.cleanup();
});

test('missing target fails closed and pending hash timeout is retained without keeping listeners alive', async () => {
  const f = fixture({missing: true}), {result} = await arm(f);
  const absent = await result; assert.ok(absent.interruptions.includes('text-node-unavailable')); assert.equal(absent.initial.nodeId, null); f.cleanup();
  const blocked = fixture({hashPaused: true}), attempt = await arm(blocked, {armTimeoutMs: 50});
  blocked.advance(60); await flush(); blocked.advance(5060); await flush();
  const raw = await attempt.result;
  assert.ok(raw.interruptions.includes('hash-drain-timeout')); assert.equal(raw.initial.textHash, null);
  assert.equal(raw.cleanup.removed, true); blocked.cleanup(); blocked.releaseHashes(); await flush();
});

test('sustained source observations stop within both the record and serialized receipt bounds', async () => {
  const f = fixture(), {result} = await arm(f);
  for (let i = 0; i < 4100; i++) { f.emit('keydown'); await flush(); }
  const raw = await result;
  assert.equal(raw.overflow, true); assert.ok(raw.records.length <= 4096);
  assert.ok(raw.interruptions.some(reason => reason === 'record-overflow' || reason === 'serialized-overflow'));
  assert.ok(Buffer.byteLength(JSON.stringify(raw)) <= 8 * 1024 * 1024);
  assert.equal(raw.cleanup.removed, true); f.cleanup();
});

test('invalid setup is rejected before a browser observer can be installed', async () => {
  const page = {evaluate() { throw Error('Unexpected browser access'); }};
  await assert.rejects(observeNativeIme(page, {nonce: 'bad nonce', plan}), /NATIVE_IME_NONCE/);
  await assert.rejects(observeNativeIme(page, {nonce: 'test', plan: {...plan, durationMs: 1}}), /NATIVE_IME_PLAN/);
  await assert.rejects(observeNativeIme(page, {nonce: 'test', plan, armTimeoutMs: 30001}), /NATIVE_IME_ARM_TIMEOUT/);
  const controller = new AbortController(); controller.abort(Error('already-aborted'));
  await assert.rejects(observeNativeIme(page, {nonce: 'test', plan, signal: controller.signal}), /already-aborted/);
});
