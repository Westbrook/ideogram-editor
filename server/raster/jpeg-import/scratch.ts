import {constants,fstatSync,lstatSync,unlinkSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {dirname} from 'node:path';
/** Scratch identity deliberately excludes mtime: the admitted color stage may
 * normalize this inode in place. Retain the FD until unlink is proved durable. */
export function removeJPEGScratch(path:string,fd:number,expected:{dev:bigint;ino:bigint}):void{
 const held=fstatSync(fd,{bigint:true});
 if(!held.isFile()||held.dev!==expected.dev||held.ino!==expected.ino||held.nlink>1n||held.mode%4096n!==384n||held.uid!==BigInt(process.geteuid!()))throw Error('RASTER_INPUT_CHANGED');
 try{
  const named=lstatSync(path,{bigint:true});
  if(!named.isFile()||named.isSymbolicLink()||named.dev!==expected.dev||named.ino!==expected.ino||named.nlink!==1n||named.mode!==held.mode||named.uid!==held.uid||named.gid!==held.gid)throw Error('RASTER_INPUT_CHANGED');
  unlinkSync(path);
 }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;if(fstatSync(fd,{bigint:true}).nlink!==0n)throw Error('RASTER_INPUT_CHANGED');}
 if(fstatSync(fd,{bigint:true}).nlink!==0n)throw Error('RASTER_INPUT_CHANGED');
 const parent=openSync(dirname(path),constants.O_RDONLY|constants.O_NOFOLLOW);try{fsyncSync(parent);}finally{closeSync(parent);}
}
