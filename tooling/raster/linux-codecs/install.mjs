import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {adopt,captureInstalled,hash,root,target,validateLock} from './capture.mjs';

assert.deepEqual(process.argv.slice(2),['--adopt'],'Usage: node tooling/raster/linux-codecs/install.mjs --adopt');
assert.equal(process.platform,'linux');assert(['arm64','x64'].includes(process.arch));assert.equal(process.versions.node,'26.10.0');
assert(!existsSync(target),'Linux profile version already exists');assert(!existsSync(join(root,'node_modules')),'Producer requires an empty node_modules');
const image=process.env.IE_LINUX_CODECS_BUILD_IMAGE,baseImage=process.env.IE_LINUX_CODECS_BASE_IMAGE;
const execution=process.env.IE_LINUX_CODECS_EXECUTION;assert(['native','emulated'].includes(execution),'Record native or emulated execution explicitly');
assert.match(image??'',/^sha256:[0-9a-f]{64}$/,'Exact retained builder image ID required');
assert.match(baseImage??'',/^ubuntu:24\.04@sha256:[0-9a-f]{64}$/,'Digest-pinned Ubuntu image required');
assert.equal(execFileSync('npm',['--version'],{encoding:'utf8'}).trim(),'12.1.0');validateLock();
const lockBefore=readFileSync(join(root,'package-lock.json')),packageBefore=readFileSync(join(root,'package.json'));
const output=join(root,'artifacts/linux-codecs-install');mkdirSync(output,{recursive:true});
const cache=join(output,'npm-cache');assert(!existsSync(cache),'Producer requires an empty npm cache');
const env={...process.env,SHARP_IGNORE_GLOBAL_LIBVIPS:'1',npm_config_cache:cache,npm_config_audit:'false',npm_config_fund:'false'};
delete env.NODE_PATH;delete env.NODE_OPTIONS;delete env.SHARP_FORCE_GLOBAL_LIBVIPS;
const started=new Date().toISOString();let install;
try{install=execFileSync('npm',['ci','--no-audit','--no-fund'],{cwd:root,env,encoding:'utf8',maxBuffer:32*1024*1024});writeFileSync(join(output,'npm-ci.log'),install);}
catch(error){writeFileSync(join(output,'npm-ci.log'),String(error.stdout??'')+'\n'+String(error.stderr??''));throw error;}
assert.deepEqual(readFileSync(join(root,'package-lock.json')),lockBefore,'npm ci changed package-lock');assert.deepEqual(readFileSync(join(root,'package.json')),packageBefore,'npm ci changed package.json');
const list=execFileSync('npm',['ls','--all','--json'],{cwd:root,env,encoding:'utf8',maxBuffer:32*1024*1024});writeFileSync(join(output,'npm-ls.json'),list);
const codecs=captureInstalled();
const installation={command:['npm','ci','--no-audit','--no-fund'],started,finished:new Date().toISOString(),emptyNodeModules:true,emptyCache:true,node:process.versions.node,npm:'12.1.0',platform:process.platform,arch:process.arch,libc:process.report.getReport().header.glibcVersionRuntime,
  image,baseImage,execution,packageLockHash:hash(lockBefore),packageHash:hash(packageBefore),npmCiLog:hash(install),npmLs:hash(list)};
const receipt=adopt(codecs,installation);console.log(JSON.stringify({status:'captured',target,codecIdentity:receipt.codecIdentity,files:codecs.files.length,installation}));
