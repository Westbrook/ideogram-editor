import {readdirSync,lstatSync,readFileSync,readlinkSync,realpathSync,existsSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {randomUUID} from 'node:crypto';
import {digestJSON,sha256} from './core.mjs';
import {readdir,lstat,readlink,realpath} from 'node:fs/promises';
import {fileIdentity} from './evidence-volume.mjs';

export function treeIdentity(root) {
  if(!existsSync(root))return null;
  if(!lstatSync(root).isDirectory()||lstatSync(root).isSymbolicLink())throw Error(`Cache tree must be an owned directory: ${root}`);
  const files=[];
  function walk(path){
    for(const item of readdirSync(path,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      const absolute=join(path,item.name),name=relative(root,absolute);
      if(item.isDirectory()){walk(absolute);continue;}
      if(item.isSymbolicLink()){
        const target=realpathSync(absolute),rel=relative(root,target);
        if(rel.startsWith('..'))throw Error(`External dependency link: ${absolute}`);
        files.push({path:name,link:readlinkSync(absolute)});continue;
      }
      if(!item.isFile())throw Error(`Unexpected cache input: ${absolute}`);
      const before=lstatSync(absolute),bytes=readFileSync(absolute),after=lstatSync(absolute);
      if(before.ino!==after.ino||before.size!==bytes.length||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw Error(`Input changed while hashing: ${absolute}`);
      files.push({path:name,bytes:bytes.length,mode:after.mode&0o777,sha256:sha256(bytes)});
    }
  }
  walk(root);return {digest:digestJSON(files),files};
}
// Same identity schema/order as treeIdentity; all filesystem reads yield and
// regular-file hashing uses the existing held 64 KiB evidence reader.
export async function treeIdentityAsync(root) {
  let rootStat;try{rootStat=await lstat(root);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(!rootStat.isDirectory()||rootStat.isSymbolicLink())throw Error(`Cache tree must be an owned directory: ${root}`);
  const files=[];
  async function walk(path){
    for(const item of (await readdir(path,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
      const absolute=join(path,item.name),name=relative(root,absolute);
      if(item.isDirectory()){await walk(absolute);continue;}
      if(item.isSymbolicLink()){
        const target=await realpath(absolute),rel=relative(root,target);
        if(rel.startsWith('..'))throw Error(`External dependency link: ${absolute}`);
        files.push({path:name,link:await readlink(absolute)});continue;
      }
      if(!item.isFile())throw Error(`Unexpected cache input: ${absolute}`);
      const before=await lstat(absolute),identity=await fileIdentity(absolute),after=await lstat(absolute);
      if(before.ino!==after.ino||before.size!==identity.bytes||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw Error(`Input changed while hashing: ${absolute}`);
      files.push({path:name,bytes:identity.bytes,mode:after.mode&0o777,sha256:identity.sha256});
    }
  }
  await walk(root);return {digest:digestJSON(files),files};
}
// Reviewed source closures for checks that do not depend on product behavior.
// Unknown gates and build inputs stay conservative. Dependency bytes and the
// actual command/environment remain part of every key.
export function gateInputKey(gate,source,environmentIdentity) {
  const common=path=>/^package(?:-lock)?\.json$/.test(path)||path.startsWith('tooling/qualification/');
  const include=path=>{
    if(common(path))return true;
    if(gate.id==='vendor')return path.startsWith('vendor/')||path==='src/text/profile.json'||path==='tooling/toolchain.json'||/^tooling\/(?:verify-vendor|freeze-en-reve)\.py$/.test(path);
    if(gate.id==='imports')return path.startsWith('src/')||path.startsWith('tests/consumer/')||/^tsconfig.*\.json$/.test(path)||path==='tooling/verify-imports.mjs';
    if(gate.id.startsWith('build-'))return !path.startsWith('tests/')||path.startsWith('tests/consumer/');
    return true;
  };
  return digestJSON({kind:3,gate,files:source.files.filter(file=>include(file.path)),environmentIdentity});
}
export const buildOutputs=Object.freeze({'build-app':['dist/app'],'build-server':['dist/local']});
export function outputIdentity(root,gate){
  const paths=buildOutputs[gate.id]??[];
  if(!paths.length)return null;
  const trees=paths.map(path=>({path,tree:treeIdentity(join(root,path))}));
  if(trees.some(item=>!item.tree?.files.length))return null;
  return {digest:digestJSON(trees),trees};
}
export async function outputIdentityAsync(root,gate){
  const paths=buildOutputs[gate.id]??[];
  if(!paths.length)return null;
  const trees=[];
  for(const path of paths)trees.push({path,tree:await treeIdentityAsync(join(root,path))});
  if(trees.some(item=>!item.tree?.files.length))return null;
  return {digest:digestJSON(trees),trees};
}
export async function reusableAsync(entry,key,root,gate){
  if(!entry||entry.key!==key||entry.observation.outcome!=='PASS')return false;
  if(gate.files||gate.fixtureBuild||gate.completionPrerequisites)return false;
  if(buildOutputs[gate.id])return !!entry.outputs&&entry.outputs.digest===(await outputIdentityAsync(root,gate))?.digest;
  return ['typecheck','vendor','text-inputs','imports','raster-inputs'].includes(gate.id);
}
export function reusable(entry,key,root,gate){
  if(!entry||entry.key!==key||entry.observation.outcome!=='PASS')return false;
  if(gate.files||gate.fixtureBuild||gate.completionPrerequisites)return false;
  if(buildOutputs[gate.id])return !!entry.outputs&&entry.outputs.digest===outputIdentity(root,gate)?.digest;
  return ['typecheck','vendor','text-inputs','imports','raster-inputs'].includes(gate.id);
}
export function saveAtomic(path,value){mkdirSync(resolve(path,'..'),{recursive:true});const temporary=path+'.'+randomUUID()+'.tmp';writeFileSync(temporary,JSON.stringify(value,null,2)+'\n');renameSync(temporary,path);}
