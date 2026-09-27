import {defineConfig} from '@playwright/test';
import {resolve} from 'node:path';
const receipt=resolve(process.env.EDITOR_RECEIPT??'evidence/p1c3/browser');
export default defineConfig({testDir:'.',testMatch:'authoring.spec.ts',workers:1,retries:0,timeout:90000,outputDir:resolve(receipt,'browser'),reporter:[['list'],['json',{outputFile:resolve(receipt,'browser.json')}]],use:{actionTimeout:10000,browserName:(process.env.EDITOR_BROWSER??'chromium') as 'chromium'|'firefox'|'webkit',viewport:{width:1440,height:1000},trace:'off',screenshot:'only-on-failure'}});
