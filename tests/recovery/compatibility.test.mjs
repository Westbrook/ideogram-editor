import {compileLegacy} from '../../tooling/qualification/legacy-compiler.mjs';
import {installSchema18Packet} from '../recovery/schema18-packet.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import {mkdtemp,realpath,cp,readdir,mkdir,readFile,writeFile,rm,symlink,lstat,readlink}from'node:fs/promises';import {tmpdir}from'node:os';import{join,resolve}from'node:path';import{DatabaseSync}from'node:sqlite';import{createHash}from'node:crypto';import{openWriter}from'../../dist/local/server/storage/writer.js';
async function inventory(root){const rows=[];async function walk(dir,rel=''){for(const name of (await readdir(dir)).sort()){const p=join(dir,name),key=rel+name,st=await lstat(p);if(st.isSymbolicLink())rows.push({path:key,link:await readlink(p)});else if(st.isDirectory())await walk(p,key+'/');else rows.push({path:key,bytes:st.size,sha256:createHash('sha256').update(await readFile(p)).digest('hex')});}}await walk(root);return rows;}
// The historical reader borrows the current managed dependency installation.
// Record a bounded observation of its provenance; do not call it a retained install.
async function externalDependency(alias,{beforeBuild=false}={}){
 const target=resolve('node_modules');if(!beforeBuild){assert((await lstat(alias)).isSymbolicLink());assert.equal(await readlink(alias),target);}
 const files=[];
 for(const path of ['package.json','package-lock.json','node_modules/typescript/package.json','node_modules/typescript/bin/tsc','node_modules/typescript/lib/tsc.js']){
  const absolutePath=resolve(path),data=await readFile(absolutePath);files.push({path,absolutePath,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')});
 }
 return {kind:'historical-reader-external-dependency-1',path:'old/node_modules',link:target,resolvedTarget:await realpath(beforeBuild?target:alias),
  provenance:'The test creates this alias to the current managed checkout dependencies for the historical compile and reader processes.',
  runtime:{execPath:process.execPath,version:process.version,versions:{...process.versions},platform:process.platform,arch:process.arch},
  observedFiles:files,dependencyContentsRetained:false,
  limits:['Only the listed files and runtime version metadata are identified; the complete installed dependency tree is not hashed or retained.',
   'The project lock describes intended dependencies and does not attest to every installed byte.',
   'This is functional historical-reader evidence, not a self-contained executable archive or a full restore qualification.']};
}
const base='086c9a677512f1faae98f9e947084ffb93c09431';
test('actual accepted 086 reader opens the verified schema15 rollback with pending job and prompt intact',async t=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'p25-rollback-')),old=join(dir,'old'),root=join(dir,'private'),rollback=join(dir,'rollback');await mkdir(old);await mkdir(root,{mode:0o700});await mkdir(rollback,{mode:0o700});
 const dependencies=await externalDependency(join(old,'node_modules'),{beforeBuild:true});compileLegacy(old,base,['server','src','tests','tooling','tsconfig.server.json']);assert.deepEqual(await externalDependency(join(old,'node_modules')),dependencies,'Legacy compilation must preserve observed dependency provenance');
 const run=(path,mode)=>JSON.parse(execFileSync(process.execPath,['--import',resolve('tests/provider/no-egress.mjs'),resolve('tests/recovery/prior-reader.mjs'),old,path,mode],{encoding:'utf8'}));const before=run(root,'create');await installSchema18Packet(root);const w=await openWriter({root});await w.close();const db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true}),receipt=JSON.parse(db.prepare('SELECT receipt FROM schema_migrations WHERE version=16').get().receipt);db.close();assert.equal(receipt.rollback.compatibleExecutable,base);assert.equal('sha256:'+createHash('sha256').update(await readFile(join(root,receipt.backup))).digest('hex'),receipt.backupHash);await cp(join(root,receipt.backup),join(rollback,'metadata.sqlite'));const manifest=JSON.parse(await readFile(join(root,receipt.manifestFile),'utf8'));for(const name of manifest.retainedDirectories)if((await readdir(root)).includes(name))await cp(join(root,name),join(rollback,name),{recursive:true});const after=run(rollback,'read');assert.deepEqual(after,before);const evidence=resolve(process.env.CANDIDATE_EVIDENCE??'artifacts/p25','rollback-'+Date.now());await mkdir(evidence,{recursive:true});
 const original=await inventory(dir),alias=join(old,'node_modules');
 assert.deepEqual(original.filter(row=>'link' in row),[{path:dependencies.path,link:dependencies.link}],'Only the known external dependency alias may be excluded');
 assert.deepEqual(await externalDependency(alias),dependencies,'Observed dependency provenance must not change during the historical build/read');
 const retained=original.filter(row=>row.path!==dependencies.path);
 await cp(dir,join(evidence,'private'),{recursive:true,dereference:false,filter:async path=>{
  const stat=await lstat(path);
  if(stat.isSymbolicLink()){
   assert.equal(path,alias,'Unexpected links must not enter retained evidence');assert.equal(await readlink(path),dependencies.link);return false;
  }
  assert(stat.isDirectory()||stat.isFile(),'Evidence may contain only regular files/directories and the declared dependency alias');return true;
 }});
 assert.deepEqual(await inventory(dir),original,'Retention must not mutate the actual historical run');
 assert.deepEqual(await inventory(join(evidence,'private')),retained,'Every regular source/build/data byte is retained without a live dependency alias');
 assert.deepEqual(await externalDependency(alias),dependencies,'Copying must preserve the observed external dependency provenance');
 // Keep the complete source inventory, including the observed alias, as metadata.
 // The separate retained inventory describes only the actual regular copied files.
 for(const [name,value] of [['inventory.json',original],['retained-inventory.json',retained],['external-dependencies.json',dependencies]]){
  await writeFile(join(evidence,name),JSON.stringify(value,null,2));assert.deepEqual(JSON.parse(await readFile(join(evidence,name),'utf8')),value);
 }
 await writeFile(join(evidence,'receipt.json'),JSON.stringify({base,receipt,before,after,retention:{sourceInventory:'inventory.json',retainedInventory:'retained-inventory.json',externalDependencies:'external-dependencies.json',excludedPaths:[dependencies.path],dependencyContentsRetained:false,archiveOrFullRestoreQualified:false}},null,2));
 t.diagnostic(JSON.stringify({base,backup:receipt.backupHash,pendingJobs:before.queue.jobs.length,evidence}));await rm(dir,{recursive:true});
});
