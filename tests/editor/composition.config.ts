import {defineConfig} from '@playwright/test';
import {resolve} from 'node:path';
const receipt=resolve(process.env.EDITOR_RECEIPT??'artifacts/p1c5/browser');
export default defineConfig({testDir:'.',testMatch:'composition.spec.ts',workers:1,expect:{timeout:15000},retries:0,timeout:90000,outputDir:resolve(receipt,'browser'),reporter:[['list'],['json',{outputFile:resolve(receipt,'browser.json')}]],use:{actionTimeout:10000,browserName:(process.env.EDITOR_BROWSER??'chromium') as 'chromium'|'firefox'|'webkit',viewport:{width:1440,height:1000},trace:'off',screenshot:'only-on-failure'}});
