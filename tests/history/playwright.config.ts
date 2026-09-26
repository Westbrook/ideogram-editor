import {defineConfig} from '@playwright/test';
import {resolve} from 'node:path';
const output=resolve(process.env.IE_HISTORY_OUTPUT??'artifacts/p1b5');
export default defineConfig({testDir:'.',testMatch:'*.spec.ts',workers:1,retries:0,timeout:60000,outputDir:resolve(output,'browser-results'),reporter:[['list'],['json',{outputFile:resolve(output,'history-browser.json')}]],use:{browserName:'chromium',trace:'off',screenshot:'only-on-failure'}});
