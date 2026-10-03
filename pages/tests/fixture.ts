import { test as base, expect, type Browser, type Worker } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startStaticServer } from '../../tooling/pages/static-server.mjs';

type CompressedAsset = { path: string; encoding: string; encodedBytes: number; decodedBytes: number };
type Owner = { browser: Browser; baseURL: string; origin: string; textAssetResponses: CompressedAsset[] };
type Guard = { requests: string[]; workers: Set<Worker>; createdWorkers: () => number; compressedAssets: () => CompressedAsset[] };
export const test = base.extend<{ guard: Guard }, { pagesOwner: Owner }>({
  pagesOwner: [async ({ playwright, browserName }, use, info) => {
    const output = resolve(process.env.IE_PAGES_OUTPUT!, 'closure');
    await mkdir(output, { recursive: true, mode: 0o700 });
    await writeFile(resolve(output, `${info.project.name}-${info.workerIndex}.started.json`), JSON.stringify({ schema: 1, project: info.project.name, worker: info.workerIndex }) + '\n', { flag: 'wx', mode: 0o600 });
    if (!process.env.IE_PAGES_ARTIFACT) throw Error('IE_PAGES_ARTIFACT must identify the current run public artifact');
    const server = await startStaticServer(process.env.IE_PAGES_ARTIFACT, { compressedTextAssets: true });
    let browser: Browser | undefined;
    const closure = { schema: 1, project: info.project.name, worker: info.workerIndex, browserVersion: '', browserClosed: false, serverClosed: false, errors: [] as string[] };
    try {
      browser = await playwright[browserName].launch({ headless: true });
      closure.browserVersion = browser.version();
      await use({ browser, baseURL: server.baseURL, origin: server.origin, textAssetResponses: server.textAssetResponses });
    } finally {
      try { if (browser) { await browser.close(); closure.browserClosed = !browser.isConnected(); } else closure.browserClosed = true; }
      catch (error) { closure.errors.push(`browser: ${String(error)}`); }
      try { await server.close(); closure.serverClosed = true; }
      catch (error) { closure.errors.push(`server: ${String(error)}`); }
      await writeFile(resolve(output, `${info.project.name}-${info.workerIndex}.json`), JSON.stringify(closure, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      expect(closure.errors).toEqual([]); expect(closure.browserClosed).toBe(true); expect(closure.serverClosed).toBe(true);
    }
  }, { scope: 'worker' }],
  browser: [async ({ pagesOwner }, use) => { await use(pagesOwner.browser); }, { scope: 'worker' }],
  baseURL: async ({ pagesOwner }, use) => { await use(pagesOwner.baseURL); },
  guard: [async ({ page, context, pagesOwner }, use, info) => {
    const firstAsset = pagesOwner.textAssetResponses.length;
    const requests: string[] = [], violations: unknown[] = [], errors: string[] = [], workers = new Set<Worker>(); let created = 0;
    page.on('worker', worker => { created++; workers.add(worker); worker.on('close', () => workers.delete(worker)); });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('response', response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${response.url()}`); });
    await page.exposeBinding('__pagesCsp', (_source, event) => { violations.push(event); });
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', event => {
        const target = window as unknown as { __pagesCsp: (value: unknown) => Promise<void> };
        void target.__pagesCsp({ directive: event.effectiveDirective, blockedURI: event.blockedURI, sourceFile: event.sourceFile, line: event.lineNumber });
      });
    });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()); requests.push(request.url());
      // Local blob URLs embed their origin in the pathname, not the project path.
      const blobPrefix = `blob:${pagesOwner.origin}/`;
      const localBlob = url.protocol === 'blob:' && url.href.startsWith(blobPrefix) &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(url.href.slice(blobPrefix.length));
      const projectRequest = url.protocol === 'http:' && url.pathname.startsWith('/ideogram-editor/');
      if (url.origin !== pagesOwner.origin || !['GET', 'HEAD'].includes(request.method()) || !(localBlob || projectRequest)) {
        errors.push(`Disallowed preview request: ${request.method()} ${url.href}`); await route.abort('blockedbyclient'); return;
      }
      await route.continue();
    });
    try { await use({ requests, workers, createdWorkers: () => created, compressedAssets: () => pagesOwner.textAssetResponses.slice(firstAsset) }); }
    finally {
      // Close through documented APIs before retaining the worker observation.
      await page.close();
      await expect.poll(() => workers.size).toBe(0);
      await info.attach('preview-boundaries', { contentType: 'application/json', body: Buffer.from(JSON.stringify({ requests, violations, errors, createdWorkers: created, remainingWorkers: workers.size, compressedAssets: pagesOwner.textAssetResponses.slice(firstAsset) }, null, 2)) });
      expect(errors).toEqual([]); expect(violations).toEqual([]);
    }
  }, { auto: true }],
});
export { expect };
