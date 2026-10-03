import { test as base, expect, type Browser, type Worker } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startStaticServer } from '../../tooling/pages/static-server.mjs';

type Owner = { browser: Browser; baseURL: string; origin: string };
type Guard = { requests: string[]; workers: Set<Worker>; createdWorkers: () => number };
export const test = base.extend<{ guard: Guard }, { pagesOwner: Owner }>({
  pagesOwner: [async ({ playwright, browserName }, use, info) => {
    const output = resolve(process.env.IE_PAGES_OUTPUT!, 'closure');
    await mkdir(output, { recursive: true, mode: 0o700 });
    await writeFile(resolve(output, `${info.project.name}-${info.workerIndex}.started.json`), JSON.stringify({ schema: 1, project: info.project.name, worker: info.workerIndex }) + '\n', { flag: 'wx', mode: 0o600 });
    if (!process.env.IE_PAGES_ARTIFACT) throw Error('IE_PAGES_ARTIFACT must identify the current run public artifact');
    const server = await startStaticServer(process.env.IE_PAGES_ARTIFACT);
    let browser: Browser | undefined;
    const closure = { schema: 1, project: info.project.name, worker: info.workerIndex, browserVersion: '', browserClosed: false, serverClosed: false, errors: [] as string[] };
    try {
      browser = await playwright[browserName].launch({ headless: true });
      closure.browserVersion = browser.version();
      await use({ browser, baseURL: server.baseURL, origin: server.origin });
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
      if (url.origin !== pagesOwner.origin || !url.pathname.startsWith('/ideogram-editor/') || !['GET', 'HEAD'].includes(request.method())) {
        errors.push(`Disallowed preview request: ${request.method()} ${url.href}`); await route.abort('blockedbyclient'); return;
      }
      await route.continue();
    });
    try { await use({ requests, workers, createdWorkers: () => created }); }
    finally {
      // Close through documented APIs before retaining the worker observation.
      await page.close();
      await expect.poll(() => workers.size).toBe(0);
      await info.attach('preview-boundaries', { contentType: 'application/json', body: Buffer.from(JSON.stringify({ requests, violations, errors, createdWorkers: created, remainingWorkers: workers.size }, null, 2)) });
      expect(errors).toEqual([]); expect(violations).toEqual([]);
    }
  }, { auto: true }],
});
export { expect };
