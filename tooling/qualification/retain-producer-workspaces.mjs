// Opt-in preload for the immutable bounded-WebP producer. Defer only cleanup
// of matching directories created by this process; preserve them on failure.
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {basename,resolve} from 'node:path';
const make=fs.mkdtempSync,remove=fs.rmSync,owned=new Map(),pending=new Map();
fs.mkdtempSync=function(...args){
 const path=make.apply(this,args);
 if(typeof path==='string'&&basename(path).startsWith('ie-bounded-webp-')){
  const stat=fs.lstatSync(path);owned.set(resolve(path),{dev:stat.dev,ino:stat.ino});
 }
 return path;
};
fs.rmSync=function(path,options){
 const absolute=typeof path==='string'?resolve(path):null;
 if(absolute&&owned.has(absolute)&&options?.recursive===true&&options?.force===true){pending.set(absolute,options);return;}
 return remove.call(this,path,options);
};
syncBuiltinESMExports();
process.on('exit',code=>{
 for(const [path,options] of pending){
  if(code!==0){process.stderr.write('Failed producer workspace retained at '+path+'\n');continue;}
  try{
   const current=fs.lstatSync(path,{throwIfNoEntry:false}),initial=owned.get(path);
   if(!current)continue;
   if(current.isSymbolicLink()||current.dev!==initial.dev||current.ino!==initial.ino)throw Error('Workspace ownership changed: '+path);
   remove(path,options);
  }catch(error){process.stderr.write(String(error)+'\n');process.exitCode=1;}
 }
});
