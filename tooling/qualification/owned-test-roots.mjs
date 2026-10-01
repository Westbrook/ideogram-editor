import {lstatSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
const roots=new Map();
// File-process boundary follows all test and teardown hooks. This avoids deleting
// a failure root before a later cleanup hook reports an error.
export function ownTestRoot(path){
 const absolute=resolve(path),stat=lstatSync(absolute);
 if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Test root must be a newly owned directory');
 roots.set(absolute,{dev:stat.dev,ino:stat.ino});return path;
}
process.on('exit',code=>{
 for(const [path,identity] of roots){
  if(code!==0){process.stderr.write('Failed test root retained at '+path+'\n');continue;}
  try{
   const current=lstatSync(path,{throwIfNoEntry:false});if(!current)continue;
   if(current.isSymbolicLink()||current.dev!==identity.dev||current.ino!==identity.ino)throw Error('Test root ownership changed: '+path);
   rmSync(path,{recursive:true,force:true});
  }catch(error){process.stderr.write(String(error)+'\n');process.exitCode=1;}
 }
});
