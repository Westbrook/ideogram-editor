import{defineConfig}from'@playwright/test';
import{resolve}from'node:path';
export default defineConfig({testDir:'.',testMatch:'*.spec.ts',workers:1,retries:0,timeout:60000,outputDir:resolve(process.env.IE_RASTER_OUTPUT??'artifacts/p1b4','browser-results'),reporter:[['list'],['json',{outputFile:resolve(process.env.IE_RASTER_OUTPUT??'evidence/p1b4','browser-results.json')}]],use:{browserName:'chromium',viewport:{width:1000,height:700},trace:'off',screenshot:'only-on-failure'}});
