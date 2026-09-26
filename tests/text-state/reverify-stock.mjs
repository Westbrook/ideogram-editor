// Execute byte-identical stock tests/reset fixture in an owned isolated directory.
// The original P1c.1 artifact directories and services are never overwritten.
import {mkdir,copyFile,symlink,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
const repo=process.cwd(),root=resolve(process.argv[2]);
await mkdir(join(root,'tests/text'),{recursive:true});await mkdir(join(root,'tests/editor'),{recursive:true});
for(const path of ['tests/text/renderer.spec.ts','tests/text/playwright.config.ts','tests/editor/owned-opfs.ts'])await copyFile(path,join(root,path));
await writeFile(join(root,'package.json'),'{"type":"module"}');await symlink(join(repo,'dist'),join(root,'dist'));
execFileSync(join(repo,'node_modules/.bin/vite'),['build','--config','tests/text/vite.config.ts','--outDir',join(root,'artifacts/p1c1/app')],{cwd:repo,stdio:'inherit'});
execFileSync(join(repo,'node_modules/.bin/playwright'),['test','--config','tests/text/playwright.config.ts'],{cwd:root,env:{...process.env,TEXT_RECEIPT:join(root,'receipt')},stdio:'inherit'});
