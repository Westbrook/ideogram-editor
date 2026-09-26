import {mkdtemp,cp,symlink,mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {openSync,closeSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {source,sha} from './linkage-identity.mjs';
const root=await mkdtemp(join(tmpdir(),'portable-linkage-reviewer-')),code=join(root,'source');await mkdir(code);
for(const path of ['package.json','src','dist/local','tests'])await cp(path,join(code,path),{recursive:true});await symlink(resolve('node_modules'),join(code,'node_modules'),'dir');
const original=resolve('evidence/p1b6-linkage-correction/original-review'),scripts=['format2-oracle.test.mjs','revision-tail-confirm.test.mjs','revision-tail-controls.test.mjs','namespace-independent.test.mjs'];
for(const name of ['reviewer-archive.mjs',...scripts,'format2-domain-revision-hidden-by-tail.zip'])await cp(join(original,name),join(root,name));
const output=join(process.env.IE_PORTABLE_EVIDENCE??'evidence/p1b6-linkage-correction','reviewer-replay');await mkdir(output,{recursive:true});
const env={...process.env,IE_RECOVERY_OUTPUT:join(root,'recovery')},facts={source:source(),startedAt:new Date().toISOString(),runs:[],qualification:false,note:'Unchanged reviewer scripts execute an isolated copy of this correction build. Their hardcoded 5dab27d labels are historical literals, not this execution target. Revision-tail scripts assume accepted inspection; corrected invalid archives reject before that helper precondition. Those nonzero harness outcomes are retained and separated from the direct corrected public tests.'};
function run(name,args){const log=join(output,name+'.txt'),fd=openSync(log,'wx'),startedAt=new Date().toISOString(),r=spawnSync(process.execPath,args,{cwd:code,env,stdio:['ignore',fd,fd]});closeSync(fd);facts.runs.push({name,args,startedAt,finishedAt:new Date().toISOString(),exit:r.status,error:r.error?.message,log});return r.status;}
assert.equal(run('browser-build',['node_modules/vite/bin/vite.js','build','--config','tests/recovery/vite.config.ts']),0);
for(const name of scripts){assert.equal(sha(await readFile(join(original,name))),sha(await readFile(join(root,name))));const exit=run(name,['--import','./tests/session/no-egress.mjs','--test','../'+name]);
 if(name.startsWith('revision-tail-')){assert.equal(exit,1);const log=await readFile(join(output,name+'.txt'),'utf8');assert(log.includes('"status":"rejected"')&&log.includes("'accepted'"),'Expected the unchanged helper to stop at corrected public rejection');facts.runs.at(-1).disposition='Expected unchanged inspection-helper assumption fails on genuine rejected archive; not a passing unchanged test. Direct public corpus tests verify preserved source/no namespace, healthy reordered receipt2, and rejection of999/null.';}
 else assert.equal(exit,0,name);
}
const browser=JSON.parse(await readFile(join(root,'namespace-browser.json'),'utf8'));assert.equal(browser.out.length,8);for(const item of browser.out){assert(item.result.error,item.fault);assert.deepEqual(item.after,item.before);}assert(browser.crossTab.first.error);assert.equal(browser.crossTab.second.cursor,browser.crossTab.winner.cursor);assert.deepEqual(browser.externalRequests,[]);
for(const entry of await readdir(root,{withFileTypes:true}))if(entry.isFile())await cp(join(root,entry.name),join(output,entry.name));
facts.finishedAt=new Date().toISOString();facts.originalScripts=await Promise.all(scripts.map(async name=>({name,sha256:sha(await readFile(join(original,name)))})));facts.structuralReadback={allEightRejectBeforePublication:true,priorGenerationsPreserved:true,crossTabWinnerPreserved:true};await writeFile(join(output,'ATTRIBUTION.json'),JSON.stringify(facts,null,2)+'\n');console.log(JSON.stringify(facts));
