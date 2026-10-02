import {defineConfig} from '@playwright/test';
import {resolve} from 'node:path';
const receipt=resolve(process.env.EDITOR_RECEIPT??'artifacts/v45-generation-browser');
export default defineConfig({
 testDir:'.',testMatch:'v45-generation.spec.ts',workers:1,retries:0,timeout:120000,
 expect:{timeout:15000},outputDir:resolve(receipt,'browser'),
 reporter:[['list'],['json',{outputFile:resolve(receipt,'browser.json')}]],
 use:{browserName:(process.env.EDITOR_BROWSER??'chromium') as 'chromium'|'firefox'|'webkit',viewport:{width:1440,height:1000},actionTimeout:15000,screenshot:'off',trace:'off'}
});
