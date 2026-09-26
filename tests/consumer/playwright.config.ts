import { defineConfig } from '@playwright/test';
import {resolve} from 'node:path';

export default defineConfig({
  testDir: '.',
  testMatch: 'registration.spec.ts',
  workers: 1,
  retries: 0,
  outputDir:resolve(process.env.IE_CONSUMER_OUTPUT??'test-results/consumer','browser'),
  reporter: [['list'], ['json', { outputFile:resolve(process.env.IE_CONSUMER_OUTPUT??'artifacts','consumer-browser.json') }]],
  use: { browserName: 'chromium', baseURL: 'http://127.0.0.1:4179', trace: 'retain-on-failure' },
  webServer: { command: 'node node_modules/vite/bin/vite.js preview --port 4179 --strictPort', url: 'http://127.0.0.1:4179', cwd: '../..', reuseExistingServer: false },
});
