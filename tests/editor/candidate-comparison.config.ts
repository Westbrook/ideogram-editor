import {defineConfig} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const root=fileURLToPath(new URL('../../',import.meta.url));
const output=resolve(root,process.env.IE_CANDIDATE_COMPARISON_OUTPUT??'artifacts/candidate-comparison-browser');
export default defineConfig({
  testDir:'.',testMatch:'candidate-comparison.spec.ts',workers:1,retries:0,maxFailures:1,timeout:30_000,
  expect:{timeout:10_000},outputDir:resolve(output,'results'),
  reporter:[['list'],['json',{outputFile:resolve(output,'results.json')}]],
  projects:[{name:'chromium',use:{browserName:'chromium'}},{name:'firefox',use:{browserName:'firefox'}},{name:'webkit',use:{browserName:'webkit'}}],
  use:{viewport:{width:1280,height:900},trace:'retain-on-failure',screenshot:'only-on-failure'},
});
