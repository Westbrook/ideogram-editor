import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {BOOTSTRAP_PRELUDE, BOOTSTRAP_CSP} from '../../dist/local/server/static.js';

test('Hash-authorized bootstrap restores full themes before activating resources, after removing pairing secret', () => {
  for (const [density, theme] of [[null, 'spectrum-inspired-comfortable'], ['unknown', 'spectrum-inspired-comfortable'], ['compact', 'spectrum-inspired'], ['comfortable', 'spectrum-inspired-comfortable'], ['spacious', 'spectrum-inspired-spacious']]) {
    for (const [appearance, expectedAppearance] of [[null, 'auto'], ['invalid', 'auto'], ['auto', 'auto'], ['light', 'light'], ['dark', 'dark']]) {
      const order = [], dataset = {}, listeners = new Map(), window = {};
      const context = {
        location: {hash: '#pairing=' + 'a'.repeat(43), pathname: '/', search: ''}, window,
        history: {state: null, replaceState() {order.push('fragment-cleaned');}},
        localStorage: {getItem(key) {order.push(key); return key === 'ideogram.density' ? density : appearance;}},
        document: {documentElement: {dataset}, getElementById() {throw Error('Resources activated too early');}},
        addEventListener(type, listener) {listeners.set(type, listener);},
      };
      runInNewContext(BOOTSTRAP_PRELUDE, context);
      assert.equal(dataset.enTheme, theme); assert.equal(dataset.enAppearance, expectedAppearance);
      assert.deepEqual(order, ['fragment-cleaned', 'ideogram.appearance', 'ideogram.density']);
      assert.equal(window.__IE_PAIRING__, 'a'.repeat(43));
      assert.equal(typeof listeners.get('DOMContentLoaded'), 'function');
      assert.equal(Object.hasOwn(dataset, 'enDensity'), false);
    }
  }
  assert.equal(BOOTSTRAP_CSP, `'sha256-${createHash('sha256').update(BOOTSTRAP_PRELUDE).digest('base64')}'`);
});

test('Unavailable preference storage cannot block bootstrap or a separate preference', () => {
  for (const failing of ['ideogram.appearance', 'ideogram.density', 'all']) {
    const dataset = {}, listeners = [];
    runInNewContext(BOOTSTRAP_PRELUDE, {
      location: {hash: '', pathname: '/', search: ''}, window: {}, history: {state: null, replaceState() {}},
      localStorage: {getItem(key) {if (failing === key || failing === 'all') throw Error('Storage unavailable'); return key === 'ideogram.density' ? 'spacious' : 'dark';}},
      document: {documentElement: {dataset}}, addEventListener(type) {listeners.push(type);},
    });
    assert.equal(dataset.enTheme, failing === 'ideogram.appearance' ? 'spectrum-inspired-spacious' : 'spectrum-inspired-comfortable');
    assert.equal(dataset.enAppearance, failing === 'ideogram.density' ? 'dark' : 'auto');
    assert.deepEqual(listeners, ['hashchange', 'DOMContentLoaded']);
  }
});
