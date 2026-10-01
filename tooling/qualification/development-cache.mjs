import {readdirSync,lstatSync,readFileSync,readlinkSync,realpathSync,existsSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {randomUUID} from 'node:crypto';
import {digestJSON,sha256} from './core.mjs';

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
export function gateInputKey(gate,source,environmentIdentity) {
  // Builds never depend on test outcomes. Pure tests/fixtures remain in the key
  // of execution gates; unknown imports conservatively retain the whole graph.
  const build=gate.id.startsWith('build-');
  const files=source.files.filter(file=>!build||!file.path.startsWith('tests/')||file.path.startsWith('tests/consumer/'));
  return digestJSON({kind:2,gate,files,environmentIdentity});
}
export const buildOutputs=Object.freeze({'build-app':['dist/app'],'build-server':['dist/local']});
export function outputIdentity(root,gate){
  const paths=buildOutputs[gate.id]??[];
  if(!paths.length)return null;
  const trees=paths.map(path=>({path,tree:treeIdentity(join(root,path))}));
  if(trees.some(item=>!item.tree?.files.length))return null;
  return {digest:digestJSON(trees),trees};
}
export function reusable(entry,key,root,gate){
  if(!entry||entry.key!==key||entry.observation.outcome!=='PASS')return false;
  if(gate.files||gate.fixtureBuild||gate.completionPrerequisites)return false;
  if(buildOutputs[gate.id])return !!entry.outputs&&entry.outputs.digest===outputIdentity(root,gate)?.digest;
  return ['typecheck','vendor','imports','raster-inputs'].includes(gate.id);
}
export function saveAtomic(path,value){mkdirSync(resolve(path,'..'),{recursive:true});const temporary=path+'.'+randomUUID()+'.tmp';writeFileSync(temporary,JSON.stringify(value,null,2)+'\n');renameSync(temporary,path);}
