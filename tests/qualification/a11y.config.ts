import {defineConfig} from '@playwright/test';
import {resolve} from 'node:path';

// Reuse the existing controlled-origin, owned-OPFS and no-provider-effects
// browser fixture. Every invocation should use its own retained output root.
const engine=process.env.QUALIFICATION_BROWSER??'chromium';
if(!['chromium','firefox','webkit'].includes(engine))throw Error('Unsupported qualification browser');
process.env.SPECTRUM_BROWSER=engine;
process.env.SPECTRUM_CONTROLS='1';
process.env.SPECTRUM_OUTPUT=resolve(process.env.QUALIFICATION_A11Y_OUTPUT??'artifacts/qualification-a11y');
const output=resolve(process.env.SPECTRUM_OUTPUT,'focused',engine);

export default defineConfig({
  testDir:'.',testMatch:'a11y.spec.ts',workers:1,retries:0,maxFailures:1,timeout:90_000,
  outputDir:resolve(output,'browser'),
  reporter:[['list'],['json',{outputFile:resolve(output,'results.json')}]],
  use:{trace:'off',screenshot:'off'},
});
