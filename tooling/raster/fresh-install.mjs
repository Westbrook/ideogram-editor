import {readFile,writeFile,mkdir,mkdtemp,cp} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {resolve,join,dirname,basename} from 'node:path';
import {tmpdir,release,cpus} from 'node:os';
import {createHash} from 'node:crypto';
const base=process.cwd(),fixture=await mkdtemp(join(tmpdir(),'p1b4-codec-install-')),npmCli=join(base,'.toolchain/npm-12.1.0/package/bin/npm-cli.js');
const receiptDirectory=join(base,'artifacts','validation','cold-codec'),receiptPath=join(receiptDirectory,basename(fixture)+'.json');
const receipt={at:new Date().toISOString(),fixture,qualification:'Pinned prebuilt codec input and isolated consumer smoke; no native source rebuild, OS sandbox, release or formal PERF qualification.',platform:process.platform,arch:process.arch,os:release(),cpu:cpus()[0].model,node:process.versions.node,commands:[]};
const run=(cmd,args)=>{const at=new Date().toISOString(),start=performance.now(),r=spawnSync(cmd,args,{cwd:fixture,env:{PATH:dirname(process.execPath)+':/usr/bin:/bin:/usr/sbin:/sbin',CI:'1',npm_config_cache:join(fixture,'.npm-cache'),npm_config_userconfig:join(fixture,'.npmrc')},encoding:'utf8',maxBuffer:32*1024*1024});receipt.commands.push({cmd:cmd===process.execPath?'pinned-node':cmd,args,at,ms:performance.now()-start,exit:r.status,stdout:r.stdout,stderr:r.stderr});if(r.status!==0)throw Error(args.join(' ')+' failed');};
try{
 for(const path of ['package.json','package-lock.json','.npmrc','tsconfig.server.json','server','src','tooling','tests/store/helpers.mjs','tests/session/no-egress.mjs','tests/raster','vendor/en-reve','vendor/text','vendor/raster'])await cp(join(base,path),join(fixture,path),{recursive:true});
 run('python3',['tooling/verify-vendor.py']);run(process.execPath,[npmCli,'ci']);run(process.execPath,[npmCli,'ls','--all','--json']);run('python3',['tooling/verify-vendor.py']);run(process.execPath,['tooling/raster/verify-inputs.mjs']);run(process.execPath,['node_modules/typescript/bin/tsc','-p','tsconfig.server.json']);run(process.execPath,['--import','./tests/session/no-egress.mjs','--test','--test-concurrency=1','tests/raster/core.test.mjs','tests/raster/codec.test.mjs']);
 receipt.dependencyLockSHA256=createHash('sha256').update(await readFile(join(fixture,'package-lock.json'))).digest('hex');receipt.status='passed';
}catch(e){receipt.status='failed';receipt.error=String(e);process.exitCode=1;}
finally{receipt.finishedAt=new Date().toISOString();await mkdir(receiptDirectory,{recursive:true,mode:0o700});await writeFile(receiptPath,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({status:receipt.status,fixture,receiptPath,error:receipt.error}));}
