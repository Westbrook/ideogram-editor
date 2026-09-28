import {defineConfig} from '@playwright/test';
import {resolve} from 'node:path';
const receipt=resolve(process.env.EDITOR_RECEIPT!);
export default defineConfig({testDir:'.',testMatch:'composition-save.spec.ts',workers:1,retries:0,timeout:180000,expect:{timeout:15000},outputDir:resolve(receipt,'browser'),reporter:[['list'],['json',{outputFile:resolve(receipt,'browser.json')}]],use:{actionTimeout:15000,browserName:'chromium',viewport:{width:1440,height:1000},trace:'off',screenshot:'off'}});
