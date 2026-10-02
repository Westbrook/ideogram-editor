import type {ActiveCompute} from './active-compute.js';
import {closeSync,constants,fstatSync,openSync,readSync,writeSync,fsyncSync,lstatSync} from 'node:fs';
import {sampling,coefficient,integerIdentity,linear,srgb,q8,type Pixels,type Affine} from '../../src/raster/core.js';
import {encodedExtent,importOperation,type RasterImportOperation} from '../../src/protocol/raster-import.js';

export const IMPORT_PAGE_BYTES=65536,IMPORT_PAGE_COUNT=2;
export function originalRawBytes(width:number,height:number):number {
 encodedExtent(width,height);const bytes=BigInt(width)*BigInt(height)*4n;
 if(bytes>BigInt(Number.MAX_SAFE_INTEGER))throw Error('RASTER_RESOURCES');return Number(bytes);
}
export function orientedDimensions(width:number,height:number,orientation:number){
 encodedExtent(width,height);if(!Number.isInteger(orientation)||orientation<1||orientation>8)throw Error('RASTER_ORIENTATION');
 return orientation>=5?{width:height,height:width}:{width,height};
}
function sourcePoint(x:number,y:number,width:number,height:number,orientation:number):[number,number]{
 switch(orientation){case 2:return[width-1-x,y];case 3:return[width-1-x,height-1-y];case 4:return[x,height-1-y];case 5:return[y,x];case 6:return[y,height-1-x];case 7:return[width-1-y,height-1-x];case 8:return[width-1-y,x];default:return[x,y];}
}
function stamp(value:ReturnType<typeof fstatSync>){return [value.dev,value.ino,value.size,value.mtimeMs,value.ctimeMs].join(':');}
export function writeExact(fd:number,bytes:Uint8Array,offset:number){for(let at=0;at<bytes.length;){const n=writeSync(fd,bytes,at,bytes.length-at,offset+at);if(n<=0)throw Error('RASTER_WRITE');at+=n;}}
const LINEAR=Float64Array.from({length:256},(_,i)=>linear(i/255));
/** CP1's exact accumulation order, with safepoints inside large source footprints. */
export async function importContributionRow(source:Pixels,y:number,width:number,transform:Affine,check:()=>void,active?:ActiveCompute):Promise<Uint8Array>{
 function* chunks():Generator<void,Uint8Array,void>{
 const s=sampling(transform),v=s.inverse,exact=integerIdentity(transform),out=new Uint8Array(width*4),p=new Float64Array(4);let visited=0;
 for(let x=0;x<width;x++){
  const at=x*4;if(exact){if(++visited%4096===0)yield;source.get(x-transform[4],y-transform[5],p);out.set(p,at);continue;}
  const cx=v[0]*(x+.5)+v[2]*(y+.5)+v[4],cy=v[1]*(x+.5)+v[3]*(y+.5)+v[5];let r=0,g=0,b=0,a=0;
  for(let iy=Math.max(0,Math.ceil(cy-s.supportY-.5));iy<=Math.min(source.height-1,Math.floor(cy+s.supportY-.5));iy++){
   const wy=coefficient(cy,iy,s.spanY);
   for(let ix=Math.max(0,Math.ceil(cx-s.supportX-.5));ix<=Math.min(source.width-1,Math.floor(cx+s.supportX-.5));ix++){
    if(++visited%4096===0)yield;
    const w=wy*coefficient(cx,ix,s.spanX);if(w===0)continue;source.get(ix,iy,p);const alpha=p[3]/255*w;
    r+=LINEAR[p[0]]*alpha;g+=LINEAR[p[1]]*alpha;b+=LINEAR[p[2]]*alpha;a+=alpha;
   }
  }
  out[at]=a>0?q8(srgb(r/a)):0;out[at+1]=a>0?q8(srgb(g/a)):0;out[at+2]=a>0?q8(srgb(b/a)):0;out[at+3]=q8(a);
 }
 return out;
 }
 const work=chunks();for(;;){const next=active?active.run('resample',()=>work.next()):work.next();if(next.done){check();return next.value;}check();await new Promise<void>(resolve=>setImmediate(resolve));check();}
}

/** The source is admitted disk scratch, never a source-sized JS/native surface. */
export async function transformImportFile(sourcePath:string,outputFD:number,encodedWidth:number,encodedHeight:number,orientation:number,operation:RasterImportOperation,check:()=>void,active?:ActiveCompute):Promise<void>{
 const {width,height}=orientedDimensions(encodedWidth,encodedHeight,orientation);importOperation(operation,width,height);
 const source=openSync(sourcePath,constants.O_RDONLY|constants.O_NOFOLLOW),before=fstatSync(source),pages=new Map<number,Buffer>();
 try{
  if(!before.isFile()||before.size!==originalRawBytes(encodedWidth,encodedHeight))throw Error('RASTER_LENGTH');
  const pixels:Pixels={width,height,get(x,y,into){
   if(x<0||y<0||x>=width||y>=height){into.fill(0);return;}
   const [sx,sy]=sourcePoint(x,y,encodedWidth,encodedHeight,orientation),offset=(sy*encodedWidth+sx)*4,start=Math.floor(offset/IMPORT_PAGE_BYTES)*IMPORT_PAGE_BYTES;
   let page=pages.get(start);if(!page){
    if(pages.size===IMPORT_PAGE_COUNT){const oldest=pages.keys().next().value!;page=pages.get(oldest)!;pages.delete(oldest);}else page=Buffer.alloc(Math.min(IMPORT_PAGE_BYTES,before.size));
    const length=Math.min(page.length,before.size-start);let at=0;while(at<length){const target=page,read=()=>readSync(source,target,at,length-at,start+at),n=active?active.exclude(read):read();if(!n)throw Error('RASTER_LENGTH');at+=n;}pages.set(start,page);
   }
   for(let c=0;c<4;c++)into[c]=page[offset-start+c];
  }};
  const transform:Affine=operation.kind==='crop'?[1,0,0,1,-operation.x,-operation.y]:[operation.width/width,0,0,operation.height/height,0,0];
  for(let y=0;y<operation.height;y++){check();const row=await importContributionRow(pixels,y,operation.width,transform,check,active);writeExact(outputFD,row,y*operation.width*4);if(y%16===0)await new Promise<void>(resolve=>setImmediate(resolve));}
  check();if(stamp(before)!==stamp(fstatSync(source))||stamp(before)!==stamp(lstatSync(sourcePath)))throw Error('RASTER_INPUT_CHANGED');fsyncSync(outputFD);
 }finally{pages.clear();closeSync(source);}
}
