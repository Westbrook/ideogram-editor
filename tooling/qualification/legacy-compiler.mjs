import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,existsSync,cpSync,symlinkSync,rmSync,renameSync,openSync,closeSync,unlinkSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {treeIdentity} from './development-cache.mjs';
import {digestJSON,sha256} from './core.mjs';

const defaultPaths=['server','src','tooling','tsconfig.server.json'];
// Only immutable archived source/compiler output is cached. Every caller still
// receives its own writable directory, seed script and database. Formal runs
// omit IE_VALIDATION_LEGACY_CACHE and retain their fresh compilation behavior.
export function compileLegacy(destination,commit,paths=defaultPaths){
 const root=process.cwd(),target=resolve(destination),cacheRoot=process.env.IE_VALIDATION_LEGACY_CACHE;
 if(existsSync(target)&&readdirSync(target).length)throw Error('Legacy destination must be empty');
 const archive=execFileSync('git',['archive',commit,...paths],{maxBuffer:128*1024*1024});
 const build=directory=>{
  mkdirSync(directory,{recursive:true});writeFileSync(join(directory,'source.tar'),archive,{mode:0o600});
  execFileSync('tar',['-xf',join(directory,'source.tar'),'-C',directory]);
  symlinkSync(join(root,'node_modules'),join(directory,'node_modules'));
  writeFileSync(join(directory,'package.json'),'{"type":"module"}');
  execFileSync(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'-p',join(directory,'tsconfig.server.json')]);
 };
 if(!cacheRoot){build(target);return {mode:'fresh',commit};}
 const dependencies=treeIdentity(join(root,'node_modules')).digest;
 const identity={kind:1,archive:sha256(archive),paths,node:process.versions.node,platform:process.platform,arch:process.arch,dependencies,producer:sha256(readFileSync(new URL(import.meta.url)))};
 const key=digestJSON(identity),parent=resolve(cacheRoot),entry=join(parent,key),lockPath=entry+'.lock';mkdirSync(parent,{recursive:true});
 const selected=[...paths,'dist','package.json'];
 const inventory=directory=>selected.map(path=>({path,...(path.endsWith('.json')?{sha256:sha256(readFileSync(join(directory,path)))}:{tree:treeIdentity(join(directory,path))})}));
 let mode='reused';
 const valid=()=>{try{const manifest=JSON.parse(readFileSync(join(entry,'manifest.json')));return digestJSON(manifest.identity)===digestJSON(identity)&&digestJSON(manifest.outputs)===digestJSON(inventory(join(entry,'content')));}catch{return false;}};
 if(!valid()){
  // Conflicting producers fail before touching another owner's partial output.
  const lock=openSync(lockPath,'wx'),temporary=entry+'.'+randomUUID()+'.partial';
  try{
   if(!valid()){
    const content=join(temporary,'content');build(content);unlinkSync(join(content,'node_modules'));unlinkSync(join(content,'source.tar'));
    if(treeIdentity(join(root,'node_modules')).digest!==dependencies)throw Error('Legacy compiler dependencies changed during preparation');
    writeFileSync(join(temporary,'manifest.json'),JSON.stringify({identity,outputs:inventory(content)}));
    if(existsSync(entry))renameSync(entry,entry+'.invalid-'+randomUUID());
    renameSync(temporary,entry);mode='compiled';
   }
  }catch(error){
   if(existsSync(temporary)){const retained=entry+'.failed-'+randomUUID();renameSync(temporary,retained);console.error('Legacy preparation failed; retained '+retained);}
   throw error;
  }finally{closeSync(lock);unlinkSync(lockPath);}
 }
 if(!valid())throw Error('Legacy preparation did not verify');
 mkdirSync(target,{recursive:true});
 for(const path of selected)cpSync(join(entry,'content',path),join(target,path),{recursive:true,errorOnExist:true,force:false});
 symlinkSync(join(root,'node_modules'),join(target,'node_modules'));
 if(digestJSON(inventory(target))!==digestJSON(inventory(join(entry,'content'))))throw Error('Legacy restoration differs from cached bytes');
 const result={mode,commit,key};console.log('LEGACY_PREPARATION '+JSON.stringify(result));return result;
}
