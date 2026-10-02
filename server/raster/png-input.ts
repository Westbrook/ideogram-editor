import { createHash } from 'node:crypto';
import { crc32, createInflate, inflateSync } from 'node:zlib';
import { finished } from 'node:stream/promises';
import { CODECS } from './codec-platform.js';
import { PNG_SIGNATURE } from './png.js';
import { extent } from '../../src/raster/core.js';
import { encodedExtent } from '../../src/protocol/raster-import.js';

type Reader = (at: number, length: number) => Buffer;
const digest = (b: Uint8Array) => 'sha256:' + createHash('sha256').update(b).digest('hex');
const single = new Set(['IHDR','PLTE','IEND','tRNS','cHRM','gAMA','iCCP','sBIT','sRGB','bKGD','hIST','pHYs','tIME','eXIf']);
const beforePalette = new Set(['cHRM','gAMA','iCCP','sBIT','sRGB']);
const beforeImage = new Set([...beforePalette,'PLTE','tRNS','bKGD','hIST','pHYs','sPLT','eXIf']);
const bad = (code = 'RASTER_FORMAT'): never => { throw new Error(code); };
function keyword(data: Buffer): number {
  const end = data.indexOf(0);
  if (end < 1 || end > 79 || data[0] === 32 || data[end-1] === 32) bad();
  for (let i=0;i<end;i++) if (!((data[i]>=32&&data[i]<=126)||data[i]>=161) || (data[i]===32&&data[i-1]===32)) bad();
  return end;
}
function text(data: Buffer, utf8 = false) {
  if (data.includes(0)) bad('RASTER_METADATA');
  if (utf8) try { new TextDecoder('utf-8',{fatal:true}).decode(data); } catch { bad('RASTER_METADATA'); }
}
function unpack(data: Buffer, metadata: (n:number)=>void): Buffer {
  try {
    // Unlike image IDAT's documented trailing-byte allowance, compressed
    // metadata is exactly one complete zlib datastream.
    const result = inflateSync(data,{maxOutputLength:4*1024*1024,info:true}) as unknown as {buffer:Buffer;engine:{bytesWritten:number}};
    if (result.engine.bytesWritten !== data.length) bad('RASTER_METADATA');
    metadata(result.buffer.length); return result.buffer;
  } catch { return bad('RASTER_METADATA'); }
}

// PNG3 chunk ordering and payload validation precedes native metadata parsing.
// CRC reads and image inflation use 64 KiB blocks; no encoded/full-image copy.
export async function inspectPNG(read:Reader,length:number,metadata:(n:number)=>void,check:()=>void, originalMetadata=false) {
  if (!read(0,8).equals(PNG_SIGNATURE)) bad();
  const seen=new Set<string>(), palettes=new Set<string>();
  let at=8,width=0,height=0,depth=0,color=0,interlace=0,paletteEntries=0;
  let firstIDAT=0,lastIDAT=0,ended=false,iccHash:string|null=null,exifHash:string|null=null;
  while (at<length) {
    check();const header=read(at,8),n=header.readUInt32BE(),type=header.toString('latin1',4);
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type)||n>0x7fffffff||at+n+12>length) bad();
    if (['acTL','fcTL','fdAT'].includes(type)) bad('RASTER_ANIMATION');
    if (!seen.has('IHDR')&&type!=='IHDR') bad();
    if (/^[A-Z]/.test(type)&&!['IHDR','PLTE','IDAT','IEND'].includes(type)) bad();
    if (single.has(type)&&seen.has(type)) bad();
    if ((beforePalette.has(type)&&seen.has('PLTE'))||(beforeImage.has(type)&&firstIDAT)) bad();
    if (type==='PLTE'&&['tRNS','bKGD','hIST'].some(k=>seen.has(k))) bad();
    if (type!=='IDAT') metadata(n);
    let crc=crc32(header.subarray(4));
    for(let p=0;p<n;p+=65536){check();crc=crc32(read(at+8+p,Math.min(65536,n-p)),crc);}
    if(crc!==read(at+8+n,4).readUInt32BE()) bad('RASTER_CRC');
    const data=()=>read(at+8,n);
    if(type==='IHDR'){
      if(n!==13)bad();const b=data();width=b.readUInt32BE();height=b.readUInt32BE(4);(originalMetadata?encodedExtent:extent)(width,height);
      depth=b[8];color=b[9];interlace=b[12];
      if(![0,2,3,4,6].includes(color)||!(color===0||color===3?[1,2,4,8]:[8]).includes(depth)||b[10]||b[11]||interlace>1)bad('RASTER_DEPTH');
    }else if(type==='PLTE'){
      if(color===0||color===4||n===0||n%3||n>768||(color===3&&n/3>2**depth))bad();paletteEntries=n/3;
    }else if(type==='IDAT'){
      if(ended||(color===3&&!paletteEntries))bad();if(!firstIDAT)firstIDAT=at;lastIDAT=at+n+12;
    }else if(type==='IEND'){
      if(n||!firstIDAT||at+12!==length)bad();
    }else if(type==='tRNS'){
      if(color===3){if(!paletteEntries||n>paletteEntries)bad();}
      else if(n!==(color===0?2:color===2?6:-1))bad();
    }else if(type==='sRGB'){
      if(n!==1||data()[0]>3||seen.has('iCCP'))bad('RASTER_PROFILE');
    }else if(type==='gAMA'){
      if(n!==4||data().readUInt32BE()!==45455)bad('RASTER_PROFILE');
    }else if(type==='cHRM'){
      if(n!==32||!data().equals(Buffer.from('00007a26000080840000fa00000080e8000075300000ea6000003a9800001770','hex')))bad('RASTER_PROFILE');
    }else if(['cICP','mDCV','cLLI'].includes(type))bad('RASTER_PROFILE');
    else if(type==='iCCP'||type==='zTXt'||type==='iTXt'||type==='tEXt'){
      const b=data(),zero=keyword(b);
      if(type==='tEXt')text(b.subarray(zero+1));
      else if(type==='iTXt'){
        if(b.length<zero+5||![0,1].includes(b[zero+1])||b[zero+2]!==0)bad();
        const lang=b.indexOf(0,zero+3),translated=b.indexOf(0,lang+1);
        if(lang<0||translated<0||!/^([A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*)?$/.test(b.toString('latin1',zero+3,lang)))bad();
        text(b.subarray(lang+1,translated),true);
        text(b[zero+1]?unpack(b.subarray(translated+1),metadata):b.subarray(translated+1),true);
      }else{
        if(b[zero+1]!==0)bad();const inflated=unpack(b.subarray(zero+2),metadata);
        if(type==='zTXt')text(inflated);
        else{
          iccHash=digest(inflated);
          if(seen.has('sRGB')||color===0||color===4||(iccHash!==CODECS.profiles.srgb.hash&&iccHash!==CODECS.profiles.p3.hash))bad('RASTER_PROFILE');
        }
      }
    }else if(type==='sBIT'){
      const b=data(),channels=color===0?1:color===4?2:color===6?4:3;
      if(n!==channels||b.some(v=>v===0||v>(color===3?8:depth)))bad();
    }else if(type==='bKGD'){
      const b=data();if(color===3){if(!paletteEntries||n!==1||b[0]>=paletteEntries)bad();}
      else{if(n!==([0,4].includes(color)?2:6))bad();for(let i=0;i<n;i+=2)if(b.readUInt16BE(i)>=2**depth)bad();}
    }else if(type==='hIST'){
      if(!paletteEntries||n!==paletteEntries*2)bad();
    }else if(type==='pHYs'){
      if(n!==9||data()[8]>1)bad();
    }else if(type==='tIME'){
      const b=data();if(n!==7||b[2]<1||b[2]>12||b[3]<1||b[3]>31||b[4]>23||b[5]>59||b[6]>60)bad();
    }else if(type==='sPLT'){
      const b=data(),zero=keyword(b),name=b.toString('latin1',0,zero),sample=b[zero+1];
      if(palettes.has(name)||![8,16].includes(sample)||(n-zero-2)<(sample===8?6:10)||(n-zero-2)%(sample===8?6:10))bad();
      if(palettes.size>=1024)bad('RASTER_RESOURCES');palettes.add(name);
    }else if(type==='eXIf'){
      const b=data();if(n<8||!['49492a00','4d4d002a'].includes(b.subarray(0,4).toString('hex')))bad('RASTER_METADATA');
      exifHash=digest(b);
    }
    if(firstIDAT&&type!=='IDAT')ended=true;
    if(single.has(type))seen.add(type);at+=n+12;
  }
  if(!seen.has('IEND'))bad();
  if(!originalMetadata)await imageStream(read,firstIDAT,lastIDAT,width,height,depth,color,interlace,paletteEntries,check);
  return {width,height,iccHash,exifHash,depth,color,interlace,firstIDAT,lastIDAT,samplesValidated:!originalMetadata};
}

async function imageStream(read:Reader,start:number,end:number,width:number,height:number,depth:number,color:number,interlace:number,palette:number,check:()=>void){
  const channels=color===0||color===3?1:color===4?2:color===2?3:4;
  const geometry=interlace?[[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]]:[[0,0,1,1]];
  const passes=geometry.map(([x,y,dx,dy])=>({width:Math.max(0,Math.ceil((width-x)/dx)),height:Math.max(0,Math.ceil((height-y)/dy))})).filter(p=>p.width&&p.height);
  let pass=0,row=0,offset=-1,filter=0;
  // Only indexed samples require unfiltering here, to check palette references.
  // Two rows at most 8192 bytes each; native decode remains pixel authority.
  let previous=Buffer.alloc(color===3?width:0),current=Buffer.alloc(color===3?width:0);
  const consume=(b:Buffer)=>{
    check();for(let i=0;i<b.length;){
      if(pass>=passes.length)bad('RASTER_LENGTH');const p=passes[pass],rowBytes=Math.ceil(p.width*channels*depth/8);
      if(offset===-1){filter=b[i++];if(filter>4)bad('RASTER_FILTER');offset=0;}
      const count=Math.min(rowBytes-offset,b.length-i);
      if(color===3)for(let j=0;j<count;j++){
        const x=offset+j,a=x?current[x-1]:0,up=previous[x],c=x?previous[x-1]:0,v=a+up-c;
        const pa=Math.abs(v-a),pb=Math.abs(v-up),pc=Math.abs(v-c);
        current[x]=(b[i+j]+[0,a,up,Math.floor((a+up)/2),pa<=pb&&pa<=pc?a:pb<=pc?up:c][filter])&255;
        for(let bit=0;bit<8&&x*8+bit<p.width*depth;bit+=depth)if(((current[x]>>(8-depth-bit))&((1<<depth)-1))>=palette)bad('RASTER_PALETTE');
      }
      i+=count;offset+=count;
      if(offset===rowBytes){offset=-1;row++;[current,previous]=[previous,current];if(row===p.height){row=0;pass++;previous.fill(0);}}
    }
  };
  const inflater=createInflate({chunkSize:65536});let failure:Error|undefined;
  const completed=finished(inflater);void completed.catch(()=>{});
  inflater.on('error',e=>{failure=e;});inflater.on('data',(b:Buffer)=>{try{consume(b);}catch(e){failure=e as Error;inflater.destroy(failure);}});
  try{
    for(let at=start;at<end;){const n=read(at,4).readUInt32BE();for(let p=0;p<n;p+=65536){check();if(failure)throw failure;const b=read(at+8+p,Math.min(65536,n-p));await new Promise<void>((resolve,reject)=>inflater.write(b,e=>e?reject(e):resolve()));}at+=n+12;}
    inflater.end();await completed;
    if(failure)throw failure;if(pass!==passes.length||offset!==-1)bad('RASTER_LENGTH');
    // PNG3 11.2.3 allows unused trailing compressed IDAT bytes. Deliberately
    // do not require bytesWritten to equal the sum of IDAT payload lengths.
  }catch(e){if(e instanceof Error&&e.message.startsWith('RASTER_'))throw e;bad('RASTER_STREAM');}
  finally{inflater.destroy();}
}
