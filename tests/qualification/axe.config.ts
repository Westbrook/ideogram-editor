import {defineConfig} from '@playwright/test';
import {resolve} from 'node:path';

const engine=process.env.QUALIFICATION_BROWSER??'chromium';
if(!['chromium','firefox','webkit'].includes(engine))throw Error('Unsupported qualification browser');
process.env.SPECTRUM_BROWSER=engine;
process.env.SPECTRUM_CONTROLS='1';
process.env.SPECTRUM_OUTPUT=resolve(process.env.QUALIFICATION_AXE_OUTPUT??'artifacts/qualification-axe');
const output=resolve(process.env.SPECTRUM_OUTPUT,'focused',engine);
export default defineConfig({
  testDir:'.',testMatch:['axe.spec.ts','axe-populated.spec.ts','axe-recovery.spec.ts'],workers:1,retries:0,maxFailures:1,timeout:180_000,
  outputDir:resolve(output,'browser'),
  reporter:[['list'],['json',{outputFile:resolve(output,'results.json')}]],
  use:{trace:'off',screenshot:'off'},
});
