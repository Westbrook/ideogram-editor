import{defineConfig}from'@playwright/test';
export default defineConfig({testDir:'.',testMatch:'*.spec.ts',workers:1,retries:0,timeout:60000,outputDir:'../../artifacts/p1b4/browser-results',reporter:[['list'],['json',{outputFile:'../../evidence/p1b4/browser-results.json'}]],use:{browserName:'chromium',viewport:{width:1000,height:700},trace:'off',screenshot:'only-on-failure'}});
