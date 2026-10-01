import {defineConfig} from '@playwright/test';
import {resolve} from 'node:path';
export default defineConfig({
  testDir:'.',testMatch:process.env.SPECTRUM_CONTROLS==='1'?'spectrum-controls.spec.ts':process.env.SPECTRUM_FOCUSED==='1'?'spectrum-alignment.spec.ts':'spectrum.spec.ts',workers:1,retries:0,maxFailures:1,timeout:90_000,
  outputDir:resolve(process.env.SPECTRUM_OUTPUT??'artifacts/spectrum-controls',process.env.SPECTRUM_CONTROLS==='1'?'focused':'full',process.env.SPECTRUM_BROWSER??'chromium','browser'),
  reporter:[['list'],['json',{outputFile:resolve(process.env.SPECTRUM_OUTPUT??'artifacts/spectrum-controls',process.env.SPECTRUM_CONTROLS==='1'?'focused':'full',process.env.SPECTRUM_BROWSER??'chromium','results.json')}]],
  use:{trace:'off',screenshot:'off'},
});
