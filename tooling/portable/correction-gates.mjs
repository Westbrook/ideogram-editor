import {spawnSync} from 'node:child_process';
import {openSync,closeSync,writeFileSync,mkdirSync,readFileSync,cpSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {source,base} from './correction-identity.mjs';
assert.equal(process.versions.node,'26.10.0');
const directory='evidence/p1b6-correction',attempt=process.argv[2]??'01',folder=directory+'/final-attempt-'+attempt,out=directory+'/final-gates-'+attempt+'.json';mkdirSync(folder,{recursive:false});
const facts={startedAt:new Date().toISOString(),source:source(),gates:[],qualification:false};
const env={...process.env,IE_PORTABLE_EVIDENCE:resolve(folder),PATH:resolve('.toolchain/bin')+':'+process.env.PATH,IE_RECOVERY_OUTPUT:resolve('artifacts/p1b6-correction/final-recovery-'+attempt),IE_HISTORY_OUTPUT:resolve('artifacts/p1b6-correction/final-history-'+attempt)};
const npm=resolve('.toolchain/npm-12.1.0/package/bin/npm-cli.js');
const tests=readdirSync('tests/portable').filter(x=>x.endsWith('.test.mjs')).sort().map(x=>'tests/portable/'+x);
const commands=[
 ['typecheck',process.execPath,[npm,'run','typecheck']],['build',process.execPath,[npm,'run','build']],
 ['vendor',process.execPath,[npm,'run','verify:vendor']],['raster-inputs',process.execPath,[npm,'run','verify:raster']],
 ['spec','python3',['docs/spec/tools/check_spec.py']],['spec-mutations','python3',['docs/spec/tools/check_spec_mutations.py']],
 ['portable',process.execPath,['--import','./tests/session/no-egress.mjs','--test','--test-concurrency=1',...tests]],
 ['unchanged-browser-repro',process.execPath,['tooling/portable/correction-originals.mjs','browser']],
 ['unchanged-draft-repro',process.execPath,['tooling/portable/correction-originals.mjs','draft']],
 ['portable-volume',process.execPath,['--import','./tests/store/no-network.mjs','--test','tests/portable/volume-fault.mjs']],
 ...['history','raster','assets','protocol','session','store','store:volume','assets:volume'].map(name=>[name.replaceAll(':','-'),process.execPath,[npm,'run','test:'+name]]),
 ['recovery',process.execPath,[npm,'run','test:recovery']],
 ['history-browser',process.execPath,['node_modules/@playwright/test/cli.js','test','--config','tests/history/playwright.config.ts']],
 ['raster-browser',process.execPath,['tooling/portable/raster-browser.mjs']],
 ['shell',process.execPath,[npm,'run','test:shell']],['fresh-consumer',process.execPath,[npm,'run','test:consumer']],
 ['observations',process.execPath,['--import','./tests/session/no-egress.mjs','tooling/portable/correction-observe.mjs']],
 ['preservation','git',['diff','--exit-code',base,'--','docs','vendor','package-lock.json','.progress-report','evidence',':(exclude)evidence/p1b6-correction']],
 ['source-whitespace','git',['diff','--check','--','server','src','tests','tooling','package.json']],
];
for(const [name,exe,args] of commands){
 const before=source().sourceIdentity;assert.equal(before,facts.source.sourceIdentity,'Source changed during gates');
 const log=folder+'/'+name+'.txt',fd=openSync(log,'wx'),startedAt=new Date().toISOString(),start=performance.now();console.log('Starting '+name);
 const result=spawnSync(exe,args,{env,stdio:['ignore',fd,fd]});closeSync(fd);
 const entry={name,executable:exe,args,startedAt,finishedAt:new Date().toISOString(),elapsedMs:performance.now()-start,exit:result.status,error:result.error?.message,log,sourceIdentity:before,sourceAfter:source().sourceIdentity};
 facts.gates.push(entry);writeFileSync(out,JSON.stringify(facts,null,2)+'\n');console.log(name+': '+entry.exit);assert.equal(entry.sourceAfter,before,'Source changed during '+name);
 if(name==='fresh-consumer'&&result.status===0){const match=readFileSync(log,'utf8').match(/Consumer receipt: (.*)/);if(match)cpSync(match[1],folder+'/fresh-consumer-receipt.json');}
}
facts.finishedAt=new Date().toISOString();facts.finalSource=source();writeFileSync(out,JSON.stringify(facts,null,2)+'\n');if(facts.gates.some(g=>g.exit!==0))process.exitCode=1;console.log(JSON.stringify({sourceIdentity:facts.source.sourceIdentity,passed:facts.gates.filter(g=>g.exit===0).length,total:facts.gates.length}));
