import {defineConfig} from '@playwright/test';
import {resolve} from 'node:path';

export default defineConfig({
 testDir:'.',testMatch:'browser.spec.ts',workers:1,retries:0,maxFailures:1,timeout:90_000,
 expect:{timeout:10_000},
 outputDir:resolve(process.env.ADAPTER_OUTPUT??'artifacts/p27-browser','chromium','browser'),
 reporter:[['list'],['json',{outputFile:resolve(process.env.ADAPTER_OUTPUT??'artifacts/p27-browser','chromium','results.json')}]],
 use:{browserName:'chromium',viewport:{width:1440,height:1000},actionTimeout:10_000,navigationTimeout:10_000,trace:'off',screenshot:'off'},
});
