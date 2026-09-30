import {defineConfig} from '@playwright/test';
import {resolve} from 'node:path';
const receipt=process.env.EDITOR_RECEIPT!;
export default defineConfig({testDir:'.',testMatch:'alignment.spec.ts',workers:1,retries:0,timeout:90000,expect:{timeout:15000},outputDir:resolve(receipt,'browser'),reporter:[['list'],['json',{outputFile:resolve(receipt,'browser.json')}]],use:{browserName:(process.env.EDITOR_BROWSER??'chromium') as any,viewport:{width:1440,height:1000},actionTimeout:15000,screenshot:'off',trace:'off'}});
