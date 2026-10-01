import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
const output=resolve(process.env.IE_RECOVERY_OUTPUT??'artifacts/p1b2');
export default defineConfig({testDir:'.',testMatch:['consumer.spec.ts','metadata.spec.ts'],workers:1,retries:0,timeout:60000,outputDir:resolve(output,'browser-results'),
  reporter:[['list'],['json',{outputFile:resolve(output,'recovery-browser.json')}]],
  use:{browserName:'chromium',trace:'off',screenshot:'only-on-failure',viewport:{width:1000,height:700}}});
