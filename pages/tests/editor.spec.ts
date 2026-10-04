import { test, expect } from './fixture';
import type { Page, TestInfo } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import axe from 'axe-core';
import { capturePagesContrast } from './contrast-evidence';

const tokens = JSON.parse(await readFile(new URL('../../vendor/themes/spectrum/compiled.json', import.meta.url), 'utf8'));
const color = (mode: string, id: string) => tokens.branches[mode].tokens[id].value.replace(/rgb\((\d+) (\d+) (\d+) \/ 1\)/, 'rgb($1, $2, $3)');
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const appearance = (page: Page) => page.getByRole('combobox', { name: 'Appearance', exact: true });
const density = (page: Page) => page.getByRole('combobox', { name: 'Density', exact: true });
async function shell(page: Page) {
  await expect(page.locator('ie-shell')).toHaveCount(1);
  await expect(page.locator('ie-shell')).toBeVisible();
  await expect(page.getByTestId('editor-preview-notice')).toBeVisible();
  await expect(page.locator('.document-name')).toHaveText('No document open');
  await expect(page.locator('.status-bar')).toContainText('Local authority unavailable');
  await expect(page.locator('.status-bar')).toContainText('No document checkpoint');
  await expect(page.locator('.status-bar')).toContainText('No portable copy');
  await expect(page.getByText('Connected locally', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Accepted edits saved locally', { exact: false })).toHaveCount(0);
}
async function scan(page: Page, info: TestInfo, state: string) {
  await page.evaluate(axe.source);
  const result = await page.evaluate(async () => (window as unknown as { axe: typeof axe }).axe.run(document, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] },
  }));
  const reportPath = info.outputPath(`editor-axe-${state}.json`);
  await writeFile(reportPath, JSON.stringify({
    scope: 'Automated disconnected editor UI only; incomplete findings and manual accessibility remain unapproved', result,
  }), { flag: 'wx', mode: 0o600 });
  await info.attach(`editor-axe-${state}`, { contentType: 'application/json', path: reportPath });
  expect(result.violations).toEqual([]);
  await capturePagesContrast(page, info, state, result, reportPath, 'editor');
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  const bytes = await page.screenshot({ path: info.outputPath(name + '.png'), fullPage: true,
    animations: 'allow', caret: 'initial', scale: 'css', timeout: 10_000 });
  expect(bytes.byteLength).toBeLessThanOrEqual(8 * 1024 * 1024);
  await info.attach(name, { contentType: 'image/png', path: info.outputPath(name + '.png') });
}

test('public root mounts the real disconnected editor and cannot create backend authority', async ({ page, guard }) => {
  await page.addInitScript(() => {
    const target = window as unknown as { __pagesPairingReads: number };
    target.__pagesPairingReads = 0;
    Object.defineProperty(window, '__IE_PAIRING__', { configurable: true, get() {
      target.__pagesPairingReads++; throw Error('The public editor must not inspect pairing credentials');
    } });
  });
  await page.goto('./'); await shell(page);
  await expect(page.getByRole('main', { name: 'Image editor', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Document actions', exact: true })).toBeVisible();
  await expect(page.getByRole('toolbar', { name: 'Canvas tools', exact: true })).toBeVisible();
  for (const id of ['request', 'canvas', 'inspector', 'results']) await expect(page.locator('#' + id)).toBeVisible();
  await expect(page.getByTestId('preview-canvas')).toHaveCount(0);
  for (const name of ['New', 'Open', 'Storage library', 'Close document', 'Import image', 'Undo', 'Redo', 'Save copy', 'Export image', 'Save checkpoint'])
    await expect(button(page, name)).toBeDisabled();
  const tools = page.locator('en-toolbar[label="Canvas tools"]');
  for (const name of ['Move', 'Text', 'Select', 'Mask', 'Crop', 'Sample']) await expect(tools.getByRole('button', { name, exact: true })).toBeDisabled();
  for (const name of ['Pan', 'Zoom']) await expect(tools.getByRole('button', { name, exact: true })).toBeEnabled();
  const connection = page.locator('.connection-panel');
  for (let index = 0; index < 2; index++) {
    await connection.getByRole('button', { name: 'Check connection', exact: true }).click(); await shell(page);
    await page.evaluate(() => window.dispatchEvent(new Event('ie-pairing')));
    expect(await page.evaluate(() => (window as unknown as { __pagesPairingReads: number }).__pagesPairingReads)).toBe(0);
  }
  await page.locator('#session-trigger').getByRole('button').click();
  const popover = page.locator('en-popover[for="session-trigger"]');
  await expect(popover.getByRole('button', { name: 'Renew connection', exact: true })).toBeDisabled();
  await expect(popover.getByRole('button', { name: 'Disconnect', exact: true })).toBeDisabled();
  await popover.getByRole('button', { name: 'Check connection', exact: true }).click(); await shell(page);
  await page.keyboard.press('Escape');
  // A visible UI field remains a temporary control value, not a saved checkpoint.
  await page.getByRole('textbox', { name: 'Checkpoint name', exact: true }).fill('Not a saved document');
  await page.goto('./?progress-report#canvas'); await shell(page);
  expect(new URL(page.url()).searchParams.has('progress-report')).toBe(false);
  expect(new URL(page.url()).hash).toBe('#canvas');
  await expect(page.getByRole('link', { name: /Progress Report/i })).toHaveCount(0);
  await expect(page.locator('[href=""]')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Checkpoint name', exact: true })).toHaveValue('My checkpoint');
  await page.reload(); await shell(page);
  await page.evaluate(() => window.dispatchEvent(new Event('ie-pairing')));
  expect(await page.evaluate(() => (window as unknown as { __pagesPairingReads: number }).__pagesPairingReads)).toBe(0);
  expect(await page.context().cookies()).toEqual([]);
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
  expect(guard.requests.some(url => /\.(?:wasm|ttf|otf)(?:\?|$)/.test(url))).toBe(false);
  expect(guard.createdWorkers()).toBe(0);
});

test('full editor uses the shared light dark and density themes without saved document state', async ({ page, browserName }, info) => {
  await page.emulateMedia({ colorScheme: 'light' }); await page.goto('./'); await shell(page);
  await expect(appearance(page)).toHaveValue('auto');
  await expect(page.locator('html')).toHaveCSS('background-color', color('light', 'color.canvas'));
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveCSS('background-color', color('dark', 'color.canvas'));
  const heights: Record<string, number> = {};
  for (const mode of ['auto', 'light', 'dark']) {
    await appearance(page).selectOption(mode);
    for (const value of ['compact', 'comfortable', 'spacious']) {
      await density(page).focus(); await density(page).selectOption(value);
      await expect(density(page)).toBeFocused();
      await expect(page.locator('html')).toHaveAttribute('data-en-appearance', mode);
      await expect(page.locator('html')).toHaveAttribute('data-en-theme', value === 'compact' ? 'spectrum-inspired' : `spectrum-inspired-${value}`);
      await expect(page.locator('html')).toHaveCSS('background-color', color(mode === 'auto' ? 'dark' : mode, 'color.canvas'));
      await expect(page.locator('.document-bar')).toHaveCSS('background-color', color(mode === 'auto' ? 'dark' : mode, 'color.surface'));
      // The native select's accessible picker target can clamp smaller densities.
      const selectBox = await density(page).boundingBox(); expect(selectBox).not.toBeNull();
      expect(selectBox!.width).toBeGreaterThanOrEqual(24); expect(selectBox!.height).toBeGreaterThanOrEqual(24);
      // An ordinary themed action still proves that density changes real geometry.
      const actionBox = await button(page, 'Command search').boundingBox(); expect(actionBox).not.toBeNull();
      heights[mode + '-' + value] = actionBox!.height;
      if (value === 'comfortable' && mode !== 'auto') {
        await scan(page, info, mode);
        if (browserName === 'chromium') await screenshot(page, info, `full-editor-desktop-${mode}`);
      }
    }
    expect(heights[mode + '-comfortable']).toBeGreaterThan(heights[mode + '-compact']);
    expect(heights[mode + '-spacious']).toBeGreaterThan(heights[mode + '-comfortable']);
  }
  await page.reload(); await shell(page); await expect(appearance(page)).toHaveValue('dark'); await expect(density(page)).toHaveValue('spacious');
  expect(await page.evaluate(() => Object.keys(localStorage).sort())).toEqual(['ideogram.appearance', 'ideogram.density']);
  await page.context().addInitScript(() => {
    const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
    Storage.prototype.getItem = function(key) { if (['ideogram.appearance', 'ideogram.density'].includes(key)) throw new DOMException('Storage unavailable', 'SecurityError'); return get.call(this, key); };
    Storage.prototype.setItem = function(key, value) { if (['ideogram.appearance', 'ideogram.density'].includes(key)) throw new DOMException('Storage unavailable', 'SecurityError'); return set.call(this, key, value); };
  });
  await page.reload(); await shell(page); await expect(appearance(page)).toHaveValue('auto'); await expect(density(page)).toHaveValue('comfortable');
  await appearance(page).selectOption('light'); await density(page).selectOption('compact');
  await expect(page.locator('html')).toHaveAttribute('data-en-theme', 'spectrum-inspired');
  await expect(page.locator('html')).toHaveCSS('background-color', color('light', 'color.canvas'));
});

test('desktop drawer and narrow editor layouts keep the actual panels reachable', async ({ page, browserName }, info) => {
  await page.goto('./'); await shell(page);
  for (const width of [1440, 900, 320]) {
    await page.setViewportSize({ width, height: 1000 }); await shell(page);
    if (width === 1440) {
      await expect(page.locator('#request')).toBeVisible(); await expect(page.locator('#inspector')).toBeVisible();
      await expect(page.locator('.mobile-openers')).toBeHidden();
    } else {
      for (const [opener, panel, label] of [['request', 'request', 'Request panel'], ['inspector', 'inspector', 'Layers and properties panel']]) {
        await page.locator('#' + opener + '-opener').getByRole('button').focus(); await page.keyboard.press('Enter');
        await expect(page.locator('#' + panel)).toBeVisible();
        if (width === 900) {
          await expect(page.getByRole('dialog', { name: label, exact: true })).toBeVisible();
          await page.keyboard.press('Escape'); await expect(page.getByRole('dialog', { name: label, exact: true })).toBeHidden();
        }
      }
    }
    await expect(page.getByRole('toolbar', { name: 'Canvas tools', exact: true })).toBeVisible();
    const canvas = await page.locator('#canvas').boundingBox(); expect(canvas).not.toBeNull();
    expect(canvas!.x).toBeGreaterThanOrEqual(0); expect(canvas!.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    if (width === 320) {
      await scan(page, info, 'narrow-panels');
      if (browserName === 'chromium') await screenshot(page, info, 'full-editor-narrow');
    }
  }
});

test('keyboard navigation and command search expose unavailable actions without dispatch', async ({ page, guard }, info) => {
  await page.goto('./'); await shell(page);
  for (const [label, id] of [['Request', 'request'], ['Canvas', 'canvas'], ['Layers', 'inspector'], ['History', 'results']]) {
    await page.getByRole('link', { name: 'Go to ' + label, exact: true }).focus(); await page.keyboard.press('Enter');
    await expect(page.locator('#' + id)).toBeFocused(); expect(new URL(page.url()).hash).toBe('#' + id);
  }
  const trigger = button(page, 'Command search'); await trigger.focus(); await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Command search', exact: true }), content = page.locator('en-dialog#command-search-dialog');
  await expect(dialog).toBeVisible();
  const query = content.getByRole('textbox', { name: 'Search commands', exact: true }); await expect(query).toBeFocused();
  await query.fill('new document'); await page.keyboard.press('ArrowDown');
  const unavailable = content.getByRole('button', { name: 'New document', exact: true });
  await expect(unavailable).toBeFocused(); await expect(unavailable).toHaveAttribute('aria-disabled', 'true');
  await expect(content.getByText('Connect to the local editor first.', { exact: true })).toBeVisible();
  await page.keyboard.press('Enter'); await expect(dialog).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'New document', exact: true })).toBeHidden();
  await scan(page, info, 'unavailable-command');
  await page.keyboard.press('ArrowUp'); await expect(query).toBeFocused();
  await query.fill('show request panel'); await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden(); await expect(page.locator('#request')).toBeFocused();
  await button(page, 'Help').focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Editor help', exact: true })).toBeVisible();
  await scan(page, info, 'help');
  await page.keyboard.press('Escape'); await expect(button(page, 'Help')).toBeFocused();
  await page.locator('#canvas').focus();
  for (const shortcut of ['ControlOrMeta+o', 'ControlOrMeta+s', 'ControlOrMeta+Shift+s']) await page.keyboard.press(shortcut);
  await expect(page.getByRole('dialog', { name: 'Open document', exact: true })).toBeHidden();
  await shell(page); expect(guard.createdWorkers()).toBe(0);
});

test('secondary text demo renders and downloads before returning to the disconnected full editor', async ({ page, guard }, info) => {
  await page.goto('./'); await shell(page);
  await expect(page.getByTestId('preview-text-demo')).toHaveAttribute('href', /\?view=text-demo$/);
  await expect(page.getByTestId('preview-local-setup')).toHaveAttribute('href', /^https:\/\/github\.com\/Westbrook\/ideogram-editor\/blob\/[0-9a-f]{40}\/docs\/PAGES\.md#run-the-local-editor$/);
  const source = await page.getByTestId('preview-source-commit').getAttribute('href'); expect(source).toMatch(/\/commit\/[0-9a-f]{40}$/);
  await page.getByTestId('preview-text-demo').click();
  expect(new URL(page.url()).searchParams.get('view')).toBe('text-demo');
  await expect(page.locator('ie-shell')).toHaveCount(0);
  await page.getByTestId('preview-text').getByRole('textbox').fill('From the full editor to real native text');
  await page.getByTestId('render-text').getByRole('button').click();
  const downloadButton = page.getByTestId('download-png').getByRole('button'); await expect(downloadButton).toBeEnabled();
  const canvas = page.getByTestId('preview-canvas'); await expect(canvas).toBeVisible();
  expect(await canvas.evaluate(node => {
    const canvas = node as HTMLCanvasElement, data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    return { width: canvas.width, height: canvas.height, painted: data.some((value, index) => index % 4 === 3 && value > 0) };
  })).toEqual({ width: 960, height: 540, painted: true });
  await expect.poll(() => guard.workers.size).toBe(0); expect(guard.createdWorkers()).toBe(1);
  const waiting = page.waitForEvent('download'); await downloadButton.click(); const download = await waiting;
  expect(await download.failure()).toBeNull(); const output = info.outputPath('editor-linked-text-demo.png'); await download.saveAs(output);
  const png = await readFile(output); expect(png.byteLength).toBeLessThanOrEqual(16 * 1024 * 1024);
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  await page.getByTestId('preview-full-editor').click(); await shell(page);
  expect(new URL(page.url()).searchParams.has('view')).toBe(false);
  await expect(page.getByTestId('preview-canvas')).toHaveCount(0); expect(guard.workers.size).toBe(0);
  await page.getByTestId('preview-text-demo').click();
  await expect(page.getByTestId('preview-text').getByRole('textbox')).toHaveValue('A little room\nto create.');
  await expect(page.getByTestId('preview-canvas')).toBeHidden();
});
