import {expect} from '@playwright/test';
import {test} from './spectrum-fixture.js';

test('Density changes real geometry, preserves focus and draft selection, and survives reload', async ({smoke: {page, step, record}}) => {
  const density = page.getByRole('combobox', {name: 'Density', exact: true});
  const appearance = page.getByRole('combobox', {name: 'Appearance', exact: true});
  const prompt = page.getByRole('textbox', {name: 'Prompt', exact: true});
  const root = page.locator('html');
  const draft = 'Density keeps this unapplied draft: 日本語 שלום\nsecond line';
  await step('comfortable-default', () => expect(density).toHaveValue('comfortable'));
  await step('full-theme-default', () => expect(root).toHaveAttribute('data-en-theme', 'spectrum-inspired-comfortable'));
  await step('document-for-draft', async () => {
    await page.getByRole('button', {name: 'New', exact: true}).click();
    const dialog = page.getByRole('dialog', {name: 'New document', exact: true});
    await expect(dialog).toBeVisible();
    // Slotted form controls belong to the public host, outside its native dialog.
    const controls = page.locator('en-dialog#editor-dialog');
    for (const [name, value] of [['Width (px)', '128'], ['Height (px)', '96']]) {
      const field = controls.getByRole('spinbutton', {name, exact: true});
      await field.fill(value); await field.press('Tab');
    }
    await controls.getByRole('button', {name: 'Create', exact: true}).click();
    await expect(dialog).toBeHidden(); await expect(prompt).toBeEditable();
  });
  await step('draft', () => prompt.fill(draft));
  await step('draft-selection', () => prompt.evaluate(node => (node as HTMLTextAreaElement).setSelectionRange(2, 11, 'backward')));
  const originalPrompt = await prompt.elementHandle();
  if (!originalPrompt) throw Error('Prompt control is missing');
  const heights: Record<string, number> = {};
  for (const mode of ['light', 'dark']) {
    await step(mode + '-appearance', () => appearance.selectOption(mode));
    const paint = await root.evaluate(node => {const style = getComputedStyle(node); return [style.backgroundColor, style.color, style.fontFamily];});
    for (const [value, theme] of [['compact', 'spectrum-inspired'], ['comfortable', 'spectrum-inspired-comfortable'], ['spacious', 'spectrum-inspired-spacious']]) {
      const prefix = mode + '-' + value;
      await step(prefix + '-focus', () => density.focus());
      await step(prefix + '-choose', () => density.selectOption(value));
      await step(prefix + '-theme', () => expect(root).toHaveAttribute('data-en-theme', theme));
      await step(prefix + '-focus-preserved', () => expect(density).toBeFocused());
      await step(prefix + '-draft-preserved', () => expect(prompt).toHaveValue(draft));
      await step(prefix + '-control-identity', async () => expect(await prompt.evaluate((node, original) => node === original, originalPrompt)).toBe(true));
      await step(prefix + '-selection-preserved', async () => expect(await prompt.evaluate(node => {const input = node as HTMLTextAreaElement; return [input.selectionStart, input.selectionEnd, input.selectionDirection];})).toEqual([2, 11, 'backward']));
      await step(prefix + '-paints-preserved', async () => expect(await root.evaluate(node => {const style = getComputedStyle(node); return [style.backgroundColor, style.color, style.fontFamily];})).toEqual(paint));
      await step(prefix + '-geometry', async () => {
        const box = await density.boundingBox(); if (!box) throw Error('Density control is not laid out');
        heights[prefix] = box.height;
        await record({phase: 'density-geometry', mode, density: value, box});
      });
      await step(prefix + '-no-overflow', async () => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true));
    }
    expect(heights[mode + '-comfortable']).toBeGreaterThan(heights[mode + '-compact']);
    expect(heights[mode + '-spacious']).toBeGreaterThan(heights[mode + '-comfortable']);
  }
  await originalPrompt.dispose();
  await step('reload', () => page.reload());
  await step('reload-ready', () => expect(page.getByText('Local recovery complete. Accepted edits are saved locally.', {exact: true})).toBeVisible());
  await step('reload-density', () => expect(density).toHaveValue('spacious'));
  await step('reload-theme', () => expect(root).toHaveAttribute('data-en-theme', 'spectrum-inspired-spacious'));
  await step('reload-appearance', () => expect(appearance).toHaveValue('dark'));
  await step('narrow-viewport', () => page.setViewportSize({width: 390, height: 1000}));
  await step('narrow-no-overflow', async () => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true));
  await step('invalid-storage', () => page.evaluate(() => localStorage.setItem('ideogram.density', 'unknown')));
  await step('reload-invalid', () => page.reload());
  await step('invalid-fallback', () => expect(density).toHaveValue('comfortable'));
  await step('storage-unavailable', () => page.context().addInitScript(() => {
    const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
    Storage.prototype.getItem = function(key) {if (key === 'ideogram.density') throw new DOMException('Storage unavailable', 'SecurityError'); return get.call(this, key);};
    Storage.prototype.setItem = function(key, value) {if (key === 'ideogram.density') throw new DOMException('Storage unavailable', 'SecurityError'); return set.call(this, key, value);};
  }));
  await step('reload-unavailable', () => page.reload());
  await step('unavailable-default', () => expect(density).toHaveValue('comfortable'));
  await step('unavailable-live-choice', () => density.selectOption('compact'));
  await step('unavailable-live-theme', () => expect(root).toHaveAttribute('data-en-theme', 'spectrum-inspired'));
});
