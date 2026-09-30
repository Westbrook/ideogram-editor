import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'.',testMatch:'owner-runner.spec.ts',workers:1,retries:0,timeout:1000,outputDir:process.env.OWNER_RUNNER_ROOT+'/output',reporter:[['json',{outputFile:process.env.OWNER_RUNNER_JSON}]]});
