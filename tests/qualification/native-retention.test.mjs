import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,existsSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const networkGuard=resolve('tests/session/no-egress.mjs');
const preload=resolve('tooling/qualification/retain-producer-workspaces.mjs');
for(const failure of [false,true])test(`producer ${failure?'failure retains diagnostic':'success removes owned'} workspace`,t=>{
 const root=mkdtempSync(join(tmpdir(),'producer-retention-control-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const script=join(root,'run.mjs');writeFileSync(script,`import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import{join}from'node:path';const p=mkdtempSync(join(${JSON.stringify(root)},'ie-bounded-webp-'));console.log(p);try{writeFileSync(join(p,'diagnostic'),'retained compiler inputs');${failure?"throw Error('intentional compiler failure');":''}}finally{rmSync(p,{recursive:true,force:true});}`);
 const result=spawnSync(process.execPath,['--import',networkGuard,'--import',preload,script],{encoding:'utf8'}),path=result.stdout.trim();assert.equal(result.status,failure?1:0);assert.equal(existsSync(path),failure);
 if(failure){assert.equal(readFileSync(join(path,'diagnostic'),'utf8'),'retained compiler inputs');assert.match(result.stderr,/Failed producer workspace retained/);}
});
test('retention never intercepts pre-existing or differently named directories',t=>{
 const root=mkdtempSync(join(tmpdir(),'producer-retention-control-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const prior=mkdtempSync(join(root,'ie-bounded-webp-'));
 const result=spawnSync(process.execPath,['--import',networkGuard,'--import',preload,'--input-type=module','-e',`import{mkdtempSync,rmSync}from'node:fs';const p=mkdtempSync(${JSON.stringify(join(root,'unrelated-'))});console.log(p);rmSync(p,{recursive:true,force:true});rmSync(${JSON.stringify(prior)},{recursive:true,force:true});throw Error('intentional failure');`],{encoding:'utf8'});
 assert.equal(result.status,1);assert.equal(existsSync(result.stdout.trim()),false);assert.equal(existsSync(prior),false);assert.doesNotMatch(result.stderr,/workspace retained/);
});
