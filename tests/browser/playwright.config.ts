import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.', testMatch: 'shell.spec.ts', workers: 1, retries: 0,
  outputDir: '../../test-results/shell', timeout: 30_000,
  reporter: [['list'], ['json', { outputFile: '../../artifacts/shell-browser.json' }]],
  // Session bodies/cookies are secrets: retain safe screenshots and metadata,
  // not Playwright network traces that would serialize credentials.
  use: { browserName: 'chromium', viewport: { width: 1440, height: 900 }, trace: 'off', screenshot: 'only-on-failure' },
});
