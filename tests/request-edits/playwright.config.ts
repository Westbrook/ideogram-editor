import {defineConfig} from '@playwright/test';
import {resolve} from 'node:path';

const receipt=resolve(process.env.EDITOR_RECEIPT??'artifacts/p26-request-edits');
export default defineConfig({
  testDir:'.',testMatch:'public.spec.ts',workers:1,retries:0,timeout:180000,
  expect:{timeout:15000},outputDir:resolve(receipt,'browser'),
  reporter:[['list'],['json',{outputFile:resolve(receipt,'browser.json')}]],
  use:{browserName:(process.env.EDITOR_BROWSER??'chromium') as 'chromium'|'firefox'|'webkit',
    viewport:{width:1440,height:1000},actionTimeout:15000,screenshot:'off',trace:'off'},
});
