import {defineConfig} from '@playwright/test';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url)),output=resolve(process.env.REQUEST_PROMPT_BROWSER_OUTPUT??'artifacts/request-prompt-refusal-browser');
const shellQuote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
export default defineConfig({
 testDir:here,testMatch:'prompt-refusal.spec.ts',workers:1,retries:0,timeout:60000,expect:{timeout:10000},
 outputDir:resolve(output,'browser'),reporter:[['list'],['json',{outputFile:resolve(output,'browser.json')}]],
 projects:['chromium','firefox','webkit'].map(browserName=>({name:browserName,use:{browserName:browserName as 'chromium'|'firefox'|'webkit'}})),
 use:{baseURL:'http://127.0.0.1:4187',viewport:{width:1440,height:1000},actionTimeout:10000,trace:'off',screenshot:'only-on-failure'},
 webServer:{command:'node node_modules/vite/bin/vite.js --config '+shellQuote(resolve(here,'prompt-refusal.vite.config.ts'))+' --host 127.0.0.1 --port 4187 --strictPort',cwd:resolve('.'),url:'http://127.0.0.1:4187',reuseExistingServer:false,timeout:60000},
});
