import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createThemePair, emitThemePairCSS} from '@en-reve/tokens';
import {spectrumSource} from '../../tooling/theme/spectrum-source.mjs';
import {verifyDensityOutputs} from '../../tooling/theme/density.mjs';
import {currentDensity, isDensity, restoreDensity, setDensity} from '../../src/theme/density.ts';

test('Density defaults and storage failures retain complete named themes and independent appearance', () => {
  const priorDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const priorStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const dataset = {enAppearance: 'dark'}; let saved = null;
  try {
    Object.defineProperty(globalThis, 'document', {configurable: true, value: {documentElement: {dataset}}});
    Object.defineProperty(globalThis, 'localStorage', {configurable: true, value: {
      getItem: key => {assert.equal(key, 'ideogram.density'); return saved;},
      setItem: (key, value) => {assert.equal(key, 'ideogram.density'); saved = value;},
    }});
    for (const value of [null, undefined, '', 'dense', 'toString', {}, 1]) {
      assert.equal(isDensity(value), false); saved = value; restoreDensity();
      assert.equal(currentDensity(), 'comfortable');
      assert.equal(dataset.enTheme, 'spectrum-inspired-comfortable');
    }
    for (const [value, theme] of [['comfortable', 'spectrum-inspired-comfortable'], ['compact', 'spectrum-inspired'], ['spacious', 'spectrum-inspired-spacious']]) {
      assert.equal(isDensity(value), true); setDensity(value);
      assert.equal(saved, value); assert.equal(currentDensity(), value); assert.equal(dataset.enTheme, theme);
      dataset.enTheme = 'unrecognized'; restoreDensity(); assert.equal(dataset.enTheme, theme);
      assert.equal(dataset.enAppearance, 'dark'); assert.equal(Object.hasOwn(dataset, 'enDensity'), false);
    }
    Object.defineProperty(globalThis, 'localStorage', {configurable: true, get() {throw Error('Unavailable');}});
    restoreDensity(); assert.equal(currentDensity(), 'comfortable');
    setDensity('spacious'); assert.equal(currentDensity(), 'spacious');
    assert.equal(dataset.enAppearance, 'dark');
  } finally {
    if (priorDocument) Object.defineProperty(globalThis, 'document', priorDocument); else delete globalThis.document;
    if (priorStorage) Object.defineProperty(globalThis, 'localStorage', priorStorage); else delete globalThis.localStorage;
  }
});

test('Density variants resolve the complete graph while preserving approved Spectrum paints and typography', async () => {
  const source = await spectrumSource();
  const original = {};
  for (const mode of ['light', 'dark']) {
    const compact = original[mode] = source.branch(mode);
    const baselineKeys = Object.keys(compact.tokens).sort();
    for (const [density, control, panel] of [['comfortable', 2.5, 1.5], ['spacious', 3, 2]]) {
      const theme = source.branch(mode, density);
      assert.deepEqual(Object.keys(theme.tokens).sort(), baselineKeys);
      assert.deepEqual(theme.diagnostics, []);
      assert.equal(theme.tokens['size.control-min'].value.value, control);
      assert.equal(theme.tokens['component.control.min-size'].value.value, control);
      assert.equal(theme.tokens['component.surface.padding'].value.value, panel);
      assert.equal(theme.tokens['size.control-medium'].value.value, control);
      assert.ok(theme.tokens['space.rows'].value.value > compact.tokens['space.rows'].value.value);
      for (const [id, token] of Object.entries(compact.tokens)) {
        if (token.type === 'color' || id.startsWith('font.')) assert.equal(theme.tokens[id].cssValue, token.cssValue, `${density} ${mode} ${id}`);
      }
    }
  }
  assert.equal(emitThemePairCSS(createThemePair({name: source.definition.id, ...original})), await readFile('src/theme/spectrum.css', 'utf8'), 'Original compact baseline is byte-identical');
});

test('Generated density assets reproduce exactly from sealed inputs', async () => {
  assert.equal(Object.keys(await verifyDensityOutputs()).length, 3);
});
