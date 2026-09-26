import { defineConfig } from '@playwright/test';
const receipt=process.env.EDITOR_RECEIPT??'artifacts/p1b7/current';
export default defineConfig({testDir:'.',testMatch:'*.spec.ts',workers:1,retries:0,timeout:90000,outputDir:'../../'+receipt+'/browser',reporter:[['list'],['json',{outputFile:receipt+'/browser.json'}]],use:{actionTimeout:10000,browserName:(process.env.EDITOR_BROWSER??'chromium') as 'chromium'|'firefox'|'webkit',viewport:{width:1440,height:1000},trace:'off',screenshot:'only-on-failure'}});
