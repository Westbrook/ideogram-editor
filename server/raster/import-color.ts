import {fstatSync,readSync,fsyncSync} from 'node:fs';
import {openWebPColorConverter} from './webp-color.js';
import {writeExact} from './import-file-transform.js';

export const IMPORT_COLOR_PAGE_BYTES=65536;
// Account this before opening the native color bridge. It is independent of
// the decoder lease: both reservations remain live while source scratch exists.
export const IMPORT_COLOR_NATIVE_BYTES=32*1024*1024;
/** The caller owns an admitted scratch descriptor, never an original asset. */
export async function normalizeImportColorFile(fd:number,rawBytes:number,p3:Uint8Array,check:()=>void):Promise<void>{
 if(!Number.isSafeInteger(rawBytes)||rawBytes<=0||rawBytes%4)throw Error('RASTER_LENGTH');
 const before=fstatSync(fd,{bigint:true});if(!before.isFile()||before.nlink!==1n||before.size!==BigInt(rawBytes))throw Error('RASTER_INPUT_CHANGED');
 const converter=await openWebPColorConverter();if(!converter)throw Error('RASTER_CODEC_UNQUALIFIED');
 const page=Buffer.alloc(Math.min(IMPORT_COLOR_PAGE_BYTES,rawBytes));let previous=fstatSync(fd,{bigint:true});
 const unchanged=()=>{const now=fstatSync(fd,{bigint:true});if(now.dev!==previous.dev||now.ino!==previous.ino||now.size!==previous.size||now.mtimeNs!==previous.mtimeNs||now.ctimeNs!==previous.ctimeNs||now.nlink!==1n)throw Error('RASTER_INPUT_CHANGED');};
 try{
  for(let offset=0;offset<rawBytes;offset+=page.length){
   check();unchanged();const bytes=page.subarray(0,Math.min(page.length,rawBytes-offset));let at=0;
   while(at<bytes.length){const n=readSync(fd,bytes,at,bytes.length-at,offset+at);if(!n)throw Error('RASTER_LENGTH');at+=n;}
   await converter.convertInPlace(bytes,p3,check);unchanged();writeExact(fd,bytes,offset);previous=fstatSync(fd,{bigint:true});
   if(previous.dev!==before.dev||previous.ino!==before.ino||previous.size!==before.size||previous.nlink!==1n)throw Error('RASTER_INPUT_CHANGED');
   await new Promise<void>(resolve=>setImmediate(resolve));
  }
  check();unchanged();fsyncSync(fd);
 }finally{page.fill(0);converter.close();}
}
