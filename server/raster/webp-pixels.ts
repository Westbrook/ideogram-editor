import { fstatSync, readSync, writeSync } from 'node:fs';
import { extent } from '../../src/raster/core.js';

const TILE=128;
function read(fd:number,bytes:Buffer,at:number){let offset=0;while(offset<bytes.length){const n=readSync(fd,bytes,offset,bytes.length-offset,at+offset);if(!n)throw Error('RASTER_LENGTH');offset+=n;}}
function write(fd:number,bytes:Buffer,at:number){let offset=0;try{while(offset<bytes.length){const n=writeSync(fd,bytes,offset,bytes.length-offset,at+offset);if(!n)throw Error('RASTER_RESOURCES');offset+=n;}}catch(error){if(['ENOSPC','EDQUOT','EIO'].includes((error as NodeJS.ErrnoException).code??''))throw Error('RASTER_RESOURCES');throw error;}}
export function forceWebPFileAlpha(fd:number,rawBytes:number,check:()=>void):void{
  if(!Number.isSafeInteger(rawBytes)||rawBytes<=0||rawBytes%4||rawBytes>100000000||fstatSync(fd).size!==rawBytes)throw Error('RASTER_LENGTH');
  const block=Buffer.alloc(65536);for(let at=0;at<rawBytes;at+=block.length){check();const part=block.subarray(0,Math.min(block.length,rawBytes-at));read(fd,part,at);for(let x=3;x<part.length;x+=4)part[x]=255;write(fd,part,at);}
}
function sourcePoint(x:number,y:number,width:number,height:number,orientation:number):[number,number]{
  switch(orientation){case 1:return[x,y];case 2:return[width-1-x,y];case 3:return[width-1-x,height-1-y];case 4:return[x,height-1-y];case 5:return[y,x];case 6:return[y,height-1-x];case 7:return[width-1-y,height-1-x];case 8:return[width-1-y,x];default:throw Error('RASTER_ORIENTATION');}
}
/** At most two128-square tiles; transforms pixels without a full RGBA buffer. */
export function orientWebPFile(source:number,target:number,width:number,height:number,orientation:number,check:()=>void):void{
  extent(width,height);if(!Number.isInteger(orientation)||orientation<1||orientation>8)throw Error('RASTER_ORIENTATION');
  const sourceStat=fstatSync(source),targetStat=fstatSync(target);if(sourceStat.size!==width*height*4||targetStat.size!==0||sourceStat.dev===targetStat.dev&&sourceStat.ino===targetStat.ino)throw Error('RASTER_LENGTH');
  const outputWidth=orientation>=5?height:width,outputHeight=orientation>=5?width:height,input=Buffer.alloc(TILE*TILE*4),output=Buffer.alloc(TILE*TILE*4);
  for(let y=0;y<outputHeight;y+=TILE)for(let x=0;x<outputWidth;x+=TILE){check();const w=Math.min(TILE,outputWidth-x),h=Math.min(TILE,outputHeight-y),corners=[sourcePoint(x,y,width,height,orientation),sourcePoint(x+w-1,y+h-1,width,height,orientation)],left=Math.min(corners[0][0],corners[1][0]),top=Math.min(corners[0][1],corners[1][1]),sw=orientation>=5?h:w,sh=orientation>=5?w:h;
    for(let row=0;row<sh;row++)read(source,input.subarray(row*sw*4,(row+1)*sw*4),((top+row)*width+left)*4);
    for(let oy=0;oy<h;oy++)for(let ox=0;ox<w;ox++){const px=x+ox,py=y+oy,sx=orientation<5?(orientation===2||orientation===3?width-1-px:px):(orientation===7||orientation===8?width-1-py:py),sy=orientation<5?(orientation===3||orientation===4?height-1-py:py):(orientation===6||orientation===7?height-1-px:px),from=((sy-top)*sw+sx-left)*4,to=(oy*w+ox)*4;output[to]=input[from];output[to+1]=input[from+1];output[to+2]=input[from+2];output[to+3]=input[from+3];}
    for(let row=0;row<h;row++)write(target,output.subarray(row*w*4,(row+1)*w*4),((y+row)*outputWidth+x)*4);
  }
}
