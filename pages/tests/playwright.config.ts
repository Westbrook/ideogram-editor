import { defineConfig } from '@playwright/test';
import { isAbsolute, resolve } from 'node:path';

const output = process.env.IE_PAGES_OUTPUT;
if (!output || !isAbsolute(output)) throw Error('IE_PAGES_OUTPUT must be a fresh absolute directory inside the assigned evidence allocation');
export default defineConfig({
  testDir: '.', testMatch: 'preview.spec.ts', workers: 1, retries: 0, forbidOnly: true, maxFailures: 1,
  timeout: 90_000, globalTimeout: 600_000, expect: { timeout: 20_000 },
  outputDir: resolve(output, 'results'),
  reporter: [['list'], ['json', { outputFile: resolve(output, 'results.json') }]],
  projects: ['chromium', 'firefox', 'webkit'].map(name => ({ name, use: { browserName: name as 'chromium' | 'firefox' | 'webkit' } })),
  use: { viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, headless: true,
    serviceWorkers: 'block', trace: 'off', screenshot: 'off', video: 'off', acceptDownloads: true },
});
