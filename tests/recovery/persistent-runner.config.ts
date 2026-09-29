import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'.',testMatch:'persistent-runner.spec.ts',workers:1,retries:0,timeout:3000,outputDir:process.env.PERSISTENT_RUNNER_ROOT+'/output',reporter:[['json',{outputFile:process.env.PERSISTENT_RUNNER_ROOT+'/runner.json'}]]});
