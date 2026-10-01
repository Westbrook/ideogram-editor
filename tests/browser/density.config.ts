import {defineConfig} from '@playwright/test';
import {resolve} from 'node:path';

const engine = process.env.DENSITY_BROWSER ?? 'chromium';
if (!['chromium', 'firefox', 'webkit'].includes(engine)) throw Error('Unsupported density browser');
process.env.SPECTRUM_BROWSER = engine;
process.env.SPECTRUM_CONTROLS = '1';
process.env.SPECTRUM_OUTPUT = resolve(process.env.DENSITY_OUTPUT ?? 'artifacts/density');
const output = resolve(process.env.SPECTRUM_OUTPUT, 'focused', engine);

export default defineConfig({
  testDir: '.', testMatch: 'density.spec.ts', workers: 1, retries: 0, maxFailures: 1, timeout: 90_000,
  outputDir: resolve(output, 'browser'),
  reporter: [['list'], ['json', {outputFile: resolve(output, 'results.json')}]],
  use: {trace: 'off', screenshot: 'off'},
});
