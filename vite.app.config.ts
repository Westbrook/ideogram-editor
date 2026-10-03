import { defineConfig } from 'vite';
import locator from './.progress-report/project.json' with { type: 'json' };
import { buildEvidence } from './tooling/build-evidence.js';

const evidence = buildEvidence(true);

export default defineConfig({
  plugins: [evidence],
  worker: { format: 'iife', plugins: evidence.api.workerPlugins },
  css: { postcss: { plugins: [] } },
  define: { __PROGRESS_REPORT_URL__: JSON.stringify(locator.reportUrl) },
  build: { outDir: 'dist/app', emptyOutDir: true, manifest: true, target: 'es2022', sourcemap: false },
});
