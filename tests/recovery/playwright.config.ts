import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'.',testMatch:'*.spec.ts',workers:1,retries:0,timeout:60000,outputDir:'../../artifacts/p1b2/browser-results',
  reporter:[['list'],['json',{outputFile:'../../artifacts/p1b2/recovery-browser.json'}]],
  use:{browserName:'chromium',trace:'off',screenshot:'only-on-failure',viewport:{width:1000,height:700}}});
