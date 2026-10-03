import { test, expect } from './fixture';
import type { Page } from '@playwright/test';
import axe from 'axe-core';
import { readFile, stat } from 'node:fs/promises';

const textInput = (page: Page) => page.getByTestId('preview-text').getByRole('textbox');
const select = (page: Page, id: string) => page.getByTestId(id).getByRole('combobox');
const button = (page: Page, id: string) => page.getByTestId(id).getByRole('button');
async function pixels(page: Page) {
  return page.getByTestId('preview-canvas').evaluate(async node => {
    const canvas = node as HTMLCanvasElement, data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(n => n.toString(16).padStart(2, '0')).join('');
    let painted = 0; for (let offset = 3; offset < data.length; offset += 4) if (data[offset]) painted++;
    return { width: canvas.width, height: canvas.height, sha256, painted };
  });
}
async function render(page: Page) {
  await button(page, 'render-text').click();
  await expect(button(page, 'download-png')).toBeEnabled();
  await expect(page.getByTestId('preview-error')).toBeHidden();
  const result = await pixels(page);
  expect(result.width).toBe(960); expect(result.height).toBe(540); expect(result.painted).toBeGreaterThan(0);
  return result;
}

test('project subpath loads and reloads without a backend or eager renderer fetch', async ({ page, guard }) => {
  await page.goto('./');
  await expect(page.getByRole('heading', { name: 'Put your words in the picture.' })).toBeVisible();
  await expect(page.getByText(/edits stay in this tab/i)).toBeVisible();
  await expect(page.getByTestId('preview-canvas')).toBeHidden();
  await expect(button(page, 'download-png')).toBeDisabled();
  expect(guard.requests.some(url => /\.(?:wasm|ttf|otf)(?:\?|$)/.test(url))).toBe(false);
  expect(guard.createdWorkers()).toBe(0);
  const identity = await page.request.get('build-identity.json'); expect(identity.status()).toBe(200);
  const value = await identity.json(); expect(value.commit).toMatch(/^[0-9a-f]{40}$/); expect(value.base).toBe('/ideogram-editor/');
  await expect(page.getByTestId('source-commit')).toHaveAttribute('href', `https://github.com/Westbrook/ideogram-editor/commit/${value.commit}`);
  await textInput(page).fill('This draft should not survive reload');
  await page.reload(); await expect(button(page, 'render-text')).toBeEnabled();
  await expect(textInput(page)).toHaveValue('A little room\nto create.'); await expect(page.getByTestId('preview-canvas')).toBeHidden();
});

test('keyboard edits change real pixels and each completed worker closes', async ({ page, guard }) => {
  await page.goto('./');
  await textInput(page).fill('First public preview');
  const first = await render(page);
  await expect.poll(() => guard.workers.size).toBe(0);
  await textInput(page).focus();
  await textInput(page).press('ControlOrMeta+A'); await textInput(page).pressSequentially('A different line');
  await expect(button(page, 'download-png')).toBeDisabled();
  await button(page, 'render-text').focus(); await page.keyboard.press('Enter');
  await expect(button(page, 'download-png')).toBeEnabled();
  expect((await pixels(page)).sha256).not.toBe(first.sha256);
  await expect.poll(() => guard.workers.size).toBe(0); expect(guard.createdWorkers()).toBe(2);
});

test('each bundled font renders its intended text and styles change pixels', async ({ page, guard }) => {
  await page.goto('./');
  for (const [font, text, label] of [['NotoSans', 'A line of text', 'Noto Sans'], ['NotoSansArabic', 'مرحبا', 'Noto Sans Arabic'], ['NotoSansCJKsc', '你好', 'Noto Sans CJK SC'], ['NotoSansSymbols2', '★', 'Noto Sans Symbols 2']]) {
    await select(page, 'preview-font').selectOption(font); await textInput(page).fill(text);
    await expect(select(page, 'preview-font')).toHaveValue(font);
    await expect(select(page, 'preview-font').getByRole('option', { selected: true, includeHidden: true })).toHaveText(label);
    await render(page); await expect.poll(() => guard.workers.size).toBe(0);
  }
  await select(page, 'preview-font').selectOption('NotoSans'); await textInput(page).fill('Style preview');
  const first = await render(page);
  await page.getByTestId('preview-size').getByRole('spinbutton').fill('72');
  await page.getByTestId('preview-color').getByRole('textbox').fill('#b42318');
  await select(page, 'preview-align').selectOption('center'); await select(page, 'preview-direction').selectOption('ltr');
  expect((await render(page)).sha256).not.toBe(first.sha256); await expect.poll(() => guard.workers.size).toBe(0);
});

test('appearance and density persist and all nine control presentations pass axe', async ({ page, browserName }, info) => {
  await page.goto('./'); await render(page); await page.evaluate(axe.source);
  const incomplete: unknown[] = [];
  for (const appearance of ['auto', 'light', 'dark']) for (const density of ['comfortable', 'compact', 'spacious']) {
    await select(page, 'appearance').selectOption(appearance); await select(page, 'density').selectOption(density);
    await expect(page.locator('html')).toHaveAttribute('data-en-appearance', appearance);
    await expect(page.locator('html')).toHaveAttribute('data-en-theme', density === 'compact' ? 'spectrum-inspired' : `spectrum-inspired-${density}`);
    if (browserName === 'chromium' && density === 'comfortable' && appearance !== 'auto') {
      const image = await page.screenshot({ path: info.outputPath(`supplemental-${appearance}.png`), fullPage: true, animations: 'allow', caret: 'initial', scale: 'css' });
      expect(image.byteLength).toBeLessThanOrEqual(8 * 1024 * 1024);
      await info.attach(`supplemental-${appearance}`, { contentType: 'image/png', body: image });
    }
    const result = await page.evaluate(async () => {
      const instance = (window as unknown as { axe: typeof axe }).axe;
      return instance.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } });
    });
    await info.attach(`axe-${appearance}-${density}`, { contentType: 'application/json', body: Buffer.from(JSON.stringify(result)) });
    incomplete.push({ appearance, density, incomplete: result.incomplete });
    expect(result.violations).toEqual([]);
  }
  await info.attach('manual-review-still-required', { contentType: 'application/json', body: Buffer.from(JSON.stringify({ scope: 'Automated Pages controls only; incomplete rules and manual accessibility remain unapproved', states: incomplete })) });
  await page.reload(); await expect(select(page, 'appearance')).toHaveValue('dark'); await expect(select(page, 'density')).toHaveValue('spacious');
});

test('cancel during font loading prevents publication and reset clears the canvas', async ({ page, guard }) => {
  await page.goto('./');
  let release!: () => void, observed!: () => void;
  const blocked = new Promise<void>(resolve => { observed = resolve; }), proceed = new Promise<void>(resolve => { release = resolve; });
  await page.route(/\.(?:ttf|otf)(?:\?|$)/, async route => { observed(); await proceed; await route.fallback().catch(() => {}); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await button(page, 'render-text').click(); await Promise.race([blocked, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(Error('Font request was not observed')), 15_000); })]);
    clearTimeout(timer);
    await button(page, 'cancel-render').click(); release();
    await expect(button(page, 'render-text')).toBeEnabled(); await expect(page.getByTestId('preview-canvas')).toBeHidden();
    await expect(page.getByTestId('preview-error')).toBeHidden(); expect(guard.workers.size).toBe(0);
  } finally { clearTimeout(timer); release(); await page.unroute(/\.(?:ttf|otf)(?:\?|$)/); }
  await render(page); await button(page, 'reset-preview').click();
  await expect(page.getByTestId('preview-canvas')).toBeHidden(); await expect(button(page, 'download-png')).toBeDisabled();
  await expect.poll(() => guard.workers.size).toBe(0);
});

test('missing glyph feedback preserves the draft and releases failed work', async ({ page, guard }) => {
  await page.goto('./'); const unsupported = 'Keep this draft \u{10ffff}';
  await textInput(page).fill(unsupported); await button(page, 'render-text').click();
  await expect(page.getByTestId('preview-error')).toContainText('TEXT_MISSING_GLYPHS');
  await expect(page.getByTestId('preview-error')).toContainText('U+10FFFF'); await expect(textInput(page)).toHaveValue(unsupported);
  await expect(button(page, 'download-png')).toBeDisabled(); await expect.poll(() => guard.workers.size).toBe(0);
  await textInput(page).fill('Recovered text'); await render(page); await expect.poll(() => guard.workers.size).toBe(0);
});

test('invalid style admission preserves the draft and previously rendered pixels', async ({ page, guard }) => {
  await page.goto('./'); const first = await render(page), workersBefore = guard.createdWorkers();
  const color = page.getByTestId('preview-color').getByRole('textbox'); await color.fill('nothex');
  await button(page, 'render-text').click(); await expect(page.getByTestId('preview-error')).toContainText('six hexadecimal digits');
  await expect(color).toHaveValue('nothex'); expect(await pixels(page)).toEqual(first);
  await expect(button(page, 'download-png')).toBeDisabled(); expect(guard.createdWorkers()).toBe(workersBefore);
  await color.fill('#194ECA');
  const size = page.getByTestId('preview-size').getByRole('spinbutton'); await size.fill('');
  await button(page, 'render-text').click(); await expect(page.getByTestId('preview-error')).toContainText('12 to 160');
  await expect(size).toHaveValue(''); expect(await pixels(page)).toEqual(first); expect(guard.createdWorkers()).toBe(workersBefore);
  await size.fill('48'); await render(page);
});

test('cancelling an active native worker refuses stale publication and can recover', async ({ page, context, guard }) => {
  await page.goto('./');
  let release!: () => void, observed!: () => void, timer: ReturnType<typeof setTimeout> | undefined;
  const blocked = new Promise<void>(resolve => { observed = resolve; }), proceed = new Promise<void>(resolve => { release = resolve; });
  const pattern = /\/ideogram-editor\/assets\/[^/]+\.wasm(?:\?|$)/;
  await context.route(pattern, async route => { observed(); await proceed; await route.fallback().catch(() => {}); });
  try {
    await button(page, 'render-text').click();
    await Promise.race([blocked, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(Error('Native worker WASM request was not observed')), 15_000); })]);
    clearTimeout(timer); expect(guard.createdWorkers()).toBe(1); expect(guard.workers.size).toBe(1);
    await button(page, 'cancel-render').click(); release();
    await expect.poll(() => guard.workers.size).toBe(0); await expect(button(page, 'render-text')).toBeEnabled();
    await expect(page.getByTestId('preview-canvas')).toBeHidden(); await expect(page.getByTestId('preview-error')).toBeHidden();
  } finally { clearTimeout(timer); release(); await context.unroute(pattern); }
  await render(page); await expect.poll(() => guard.workers.size).toBe(0); expect(guard.createdWorkers()).toBe(2);
});

test('narrow viewport keeps controls reachable and the canvas within the page', async ({ page, browserName }) => {
  await page.setViewportSize({ width: 360, height: 780 }); await page.goto('./');
  await textInput(page).fill('Small screen'); await render(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const bounds = await page.getByTestId('preview-canvas').boundingBox(); expect(bounds).not.toBeNull();
  expect(bounds!.width).toBeLessThanOrEqual(360); expect(bounds!.x).toBeGreaterThanOrEqual(0);
  await expect(select(page, 'appearance')).toHaveValue('auto');
  await select(page, 'appearance').focus(); await expect(select(page, 'appearance')).toBeFocused();
  // Use the demonstrated native typeahead route in Firefox; customizable
  // pickers in Chromium/WebKit use their open, navigate and commit sequence.
  if (browserName === 'firefox') { await page.keyboard.press('l'); await page.keyboard.press('Enter'); }
  else { await page.keyboard.press('Space'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); }
  await expect(select(page, 'appearance')).toHaveValue('light');
  await expect(select(page, 'appearance').getByRole('option', { selected: true, includeHidden: true })).toHaveText('Light');
  await expect(page.locator('html')).toHaveAttribute('data-en-appearance', 'light');
  await button(page, 'reset-preview').focus(); await page.keyboard.press('Enter'); await expect(page.getByTestId('preview-canvas')).toBeHidden();
});

test('PNG download decodes to the exact currently displayed canvas', async ({ page }, info) => {
  await page.goto('./'); await textInput(page).fill('Actual canvas download'); const expected = await render(page);
  const waiting = page.waitForEvent('download'); await button(page, 'download-png').click(); const download = await waiting;
  expect(await download.failure()).toBeNull(); expect(download.suggestedFilename()).toMatch(/\.png$/);
  const path = info.outputPath('preview.png'); await download.saveAs(path);
  expect((await stat(path)).size).toBeLessThanOrEqual(16 * 1024 * 1024);
  const bytes = await readFile(path); expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const actual = await page.evaluate(async encoded => {
    const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    try {
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(n => n.toString(16).padStart(2, '0')).join('');
      return { width: canvas.width, height: canvas.height, sha256 };
    } finally { bitmap.close(); }
  }, bytes.toString('base64'));
  expect(actual).toEqual({ width: expected.width, height: expected.height, sha256: expected.sha256 });
  await expect(button(page, 'download-png')).toBeEnabled();
  // Retain the real native encoder result; control only delivery of its public
  // callback so a UI edit/reset can exercise the asynchronous stale-result guard.
  // This is an adversarial scheduling test, not a browser timing measurement.
  await page.getByTestId('preview-canvas').evaluate(node => {
    type Hook = { ready: boolean; unblocked: boolean; release?: () => void; restore: () => void };
    const canvas = node as HTMLCanvasElement & { __pagesPendingBlob?: Hook }, original = canvas.toBlob;
    const hook: Hook = { ready: false, unblocked: false, restore: () => { canvas.toBlob = original; } };
    canvas.__pagesPendingBlob = hook;
    canvas.toBlob = (callback, type, quality) => original.call(canvas, blob => {
      hook.ready = true;
      const deliver = () => { hook.restore(); callback(blob); };
      if (hook.unblocked) deliver(); else hook.release = deliver;
    }, type, quality);
  });
  const staleDownloads: string[] = []; page.on('download', value => staleDownloads.push(value.suggestedFilename()));
  try {
    await button(page, 'download-png').click();
    await expect.poll(() => page.getByTestId('preview-canvas').evaluate(node =>
      (node as HTMLCanvasElement & { __pagesPendingBlob?: { ready: boolean } }).__pagesPendingBlob?.ready)).toBe(true);
    await textInput(page).fill('A new draft cannot export the old render'); await expect(button(page, 'download-png')).toBeDisabled();
    await button(page, 'reset-preview').click(); await expect(page.getByTestId('preview-canvas')).toBeHidden();
  } finally {
    await page.getByTestId('preview-canvas').evaluate(node => {
      const canvas = node as HTMLCanvasElement & { __pagesPendingBlob?: { unblocked: boolean; release?: () => void; restore: () => void } };
      const hook = canvas.__pagesPendingBlob;
      if (hook) { hook.unblocked = true; hook.restore(); hook.release?.(); delete canvas.__pagesPendingBlob; }
    });
  }
  await expect(button(page, 'render-text')).toBeEnabled(); await expect(button(page, 'download-png')).toBeDisabled();
  expect(staleDownloads).toEqual([]);
});
