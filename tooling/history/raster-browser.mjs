import {mkdtemp,cp,symlink,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
// Historical browser tests write fixed P1b.4 paths. Run an exact source copy
// outside the checkout and preserve its new evidence only under this milestone.
const root=await mkdtemp(join(tmpdir(),'history-raster-browser-'));
for(const path of ['package.json','src','dist/local','tests/raster'])await cp(path,join(root,path),{recursive:true});
await symlink(resolve('node_modules'),join(root,'node_modules'),'dir');
for(const args of [['node_modules/vite/bin/vite.js','build','--config','tests/raster/vite.config.ts'],['node_modules/@playwright/test/cli.js','test','--config','tests/raster/playwright.config.ts']])execFileSync(process.execPath,args,{cwd:root,stdio:'inherit'});
await mkdir('evidence/p1b5/final-raster-browser',{recursive:true});await cp(join(root,'evidence/p1b4'),'evidence/p1b5/final-raster-browser',{recursive:true});
console.log(JSON.stringify({isolatedRoot:root,qualification:'exact-source raster browser regression; shared installed dependencies, not a fresh consumer'}));
