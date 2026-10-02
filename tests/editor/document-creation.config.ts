// Run only after coordinated promotion and fresh typecheck/app/server builds.
import {defineConfig} from '@playwright/test';
import {resolve} from 'node:path';
const output=resolve(process.env.J1_OUTPUT??'artifacts/j1-browser');
export default defineConfig({testDir:'.',testMatch:'document-creation.spec.ts',workers:1,retries:0,maxFailures:1,timeout:240000,expect:{timeout:15000},outputDir:resolve(output,'browser'),reporter:[['list'],['json',{outputFile:resolve(output,'results.json')}]],use:{trace:'off',screenshot:'off'}});
