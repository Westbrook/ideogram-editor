import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
const output = resolve(process.env.TEXT_RECEIPT ?? 'artifacts/p1c1/browser');
export default defineConfig({testDir:'.',testMatch:'*.spec.ts',workers:1,retries:0,timeout:60000,
  outputDir:output+'/results',reporter:[['list'],['json',{outputFile:output+'/results.json'}]],
  projects:[{name:'chromium',use:{browserName:'chromium'}},{name:'webkit',use:{browserName:'webkit'}},{name:'firefox',use:{browserName:'firefox'}}],
  use:{viewport:{width:800,height:600},trace:'off',screenshot:'only-on-failure'}});
