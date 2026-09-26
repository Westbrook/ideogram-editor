import { closeSync, openSync, readSync, fstatSync, constants } from 'node:fs';
import { crc32, inflateSync } from 'node:zlib';
import { extent } from '../../src/raster/core.js';
import { PNG_SIGNATURE } from './png.js';
// Bound metadata before invoking the native parser. Encoded data is streamed;
// these are work reservations, not a replacement for the document envelope.
export function inspectContainer(path: string, mime: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW), length = fstatSync(fd).size;
  let metadataBytes = 0, width=0, height=0;
  const dimensions=(w:number,h:number)=>{extent(w,h);if(width&&(width!==w||height!==h))throw new Error('RASTER_FORMAT');width=w;height=h;};
  const read = (at: number, n: number) => { if (at < 0 || n < 0 || at + n > length) throw new Error('RASTER_TRUNCATED'); const b = Buffer.alloc(n); if (readSync(fd, b, 0, n, at) !== n) throw new Error('RASTER_TRUNCATED'); return b; };
  const metadata = (n: number) => { metadataBytes += n; if (metadataBytes > 4 * 1024 * 1024) throw new Error('RASTER_RESOURCES'); };
  try {
    if (mime === 'image/png') {
      if (!read(0,8).equals(PNG_SIGNATURE)) throw new Error('RASTER_FORMAT');
      let at = 8, seenIHDR = false, seenIDAT = false, endIDAT = false, seenIEND = false;
      const single = new Set<string>();
      while (at < length) {
        const header = read(at,8), n = header.readUInt32BE(), type = header.toString('ascii',4);
        if (!/^[A-Za-z]{4}$/.test(type) || n > 0x7fffffff || at + n + 12 > length) throw new Error('RASTER_TRUNCATED');
        if (['acTL','fcTL','fdAT'].includes(type)) throw new Error('RASTER_ANIMATION');
        if (!seenIHDR && type !== 'IHDR') throw new Error('RASTER_FORMAT');
        if (type !== 'IDAT') metadata(n);
        let crc = crc32(header.subarray(4)); for (let p=0;p<n;p+=65536) crc=crc32(read(at+8+p,Math.min(65536,n-p)),crc);
        if (crc !== read(at+8+n,4).readUInt32BE()) throw new Error('RASTER_CRC');
        if (['IHDR','IEND','PLTE','tRNS','iCCP','sRGB','gAMA','cHRM','eXIf'].includes(type)) { if(single.has(type)) throw new Error('RASTER_FORMAT'); single.add(type); }
        if (type === 'IHDR') { if(n!==13) throw new Error('RASTER_FORMAT'); const h=read(at+8,n); dimensions(h.readUInt32BE(),h.readUInt32BE(4)); if (![1,2,4,8].includes(h[8]) || ![0,2,3,4,6].includes(h[9]) || h[10] || h[11] || h[12]>1) throw new Error('RASTER_DEPTH'); seenIHDR=true; }
        if (type === 'IDAT') { if(endIDAT) throw new Error('RASTER_FORMAT'); seenIDAT=true; } else if(seenIDAT) endIDAT=true;
        if (type === 'gAMA' && (n!==4 || read(at+8,n).readUInt32BE()!==45455)) throw new Error('RASTER_PROFILE');
        if(type==='iCCP'||type==='zTXt'||type==='iTXt'){
          const data=read(at+8,n),zero=data.indexOf(0);if(zero<1||zero>79)throw new Error('RASTER_FORMAT');let start=zero+2,compressed=true;
          if(type==='iTXt'){if(data.length<zero+5||![0,1].includes(data[zero+1])||data[zero+2]!==0)throw new Error('RASTER_FORMAT');compressed=data[zero+1]===1;const lang=data.indexOf(0,zero+3),translated=data.indexOf(0,lang+1);if(lang<0||translated<0)throw new Error('RASTER_FORMAT');start=translated+1;}
          else if(data[zero+1]!==0)throw new Error('RASTER_FORMAT');
          if(compressed){let unpacked;try{unpacked=inflateSync(data.subarray(start),{maxOutputLength:4*1024*1024});}catch{throw new Error('RASTER_METADATA');}metadata(unpacked.length);}
        }
        if (type === 'cHRM' && (n!==32 || !read(at+8,n).equals(Buffer.from('00007a26000080840000fa00000080e8000075300000ea6000003a9800001770','hex')))) throw new Error('RASTER_PROFILE');
        if (['cICP','mDCV','cLLI'].includes(type)) throw new Error('RASTER_PROFILE');
        if (type === 'IEND') { if(n!==0 || !seenIDAT || at+12!==length) throw new Error('RASTER_FORMAT'); seenIEND=true; }
        at += n+12;
      }
      if (!seenIEND || (single.has('iCCP') && single.has('sRGB'))) throw new Error('RASTER_FORMAT');
    } else if (mime === 'image/webp') {
      const h=read(0,12);if(h.toString('ascii',0,4)!=='RIFF'||h.toString('ascii',8)!=='WEBP'||h.readUInt32LE(4)+8!==length)throw new Error('RASTER_TRUNCATED');
      let at=12, images=0;const seen=new Set<string>();
      while(at<length){const c=read(at,8),n=c.readUInt32LE(4),type=c.toString('ascii',0,4);if(at+8+n+(n%2)>length)throw new Error('RASTER_TRUNCATED');
        if(type==='ANIM'||type==='ANMF'||(type==='VP8X'&&n>=1&&(read(at+8,1)[0]&2)))throw new Error('RASTER_ANIMATION');
        if(seen.has(type))throw new Error('RASTER_FORMAT');seen.add(type);
        if(type==='VP8X'){if(n!==10)throw new Error('RASTER_FORMAT');const b=read(at+8,10);dimensions(1+b.readUIntLE(4,3),1+b.readUIntLE(7,3));}
        if(type==='VP8 '){if(n<10)throw new Error('RASTER_TRUNCATED');const b=read(at+8,10);if((b[0]&1)||!b.subarray(3,6).equals(Buffer.from([157,1,42])))throw new Error('RASTER_FORMAT');dimensions(b.readUInt16LE(6)&16383,b.readUInt16LE(8)&16383);}
        if(type==='VP8L'){if(n<5)throw new Error('RASTER_TRUNCATED');const b=read(at+8,5);if(b[0]!==47||(b[4]>>5)!==0)throw new Error('RASTER_FORMAT');const bits=b.readUInt32LE(1);dimensions(1+(bits&16383),1+((bits>>>14)&16383));}
        if(type==='VP8 '||type==='VP8L')images++;else metadata(n);
        at+=8+n+n%2;
      }if(at!==length||images!==1)throw new Error('RASTER_FORMAT');
    } else if (mime === 'image/jpeg') {
      if(!read(0,2).equals(Buffer.from([255,216])))throw new Error('RASTER_FORMAT');
      let at=2, ended=false, scans=0;
      while(at<length){if(read(at++,1)[0]!==255)throw new Error('RASTER_FORMAT');let marker=read(at++,1)[0];while(marker===255)marker=read(at++,1)[0];
        if(marker===217){if(at!==length)throw new Error('RASTER_FORMAT');ended=true;break;}
        if(marker===0||marker===216||(marker>=208&&marker<=215))throw new Error('RASTER_FORMAT');
        const n=read(at,2).readUInt16BE();if(n<2||at+n>length)throw new Error('RASTER_TRUNCATED');
        if(marker>=224||marker===254)metadata(n);
        if([192,193,194].includes(marker)){const h=read(at+2,6);if(h[0]!==8)throw new Error('RASTER_DEPTH');dimensions(h.readUInt16BE(3),h.readUInt16BE(1));}
        at+=n;
        if(marker===218){scans++;let found=false;
          // Entropy scanning in bounded chunks, carrying FF across boundaries.
          let ff=false;
          while(at<length&&!found){const data=read(at,Math.min(65536,length-at));for(let i=0;i<data.length;i++){
            const b=data[i];if(ff&&b!==0&&b!==255&&!(b>=208&&b<=215)){at+=i-1;found=true;break;}ff=b===255;
          }if(!found)at+=data.length;}
          if(!found)throw new Error('RASTER_TRUNCATED');
        }
      }if(!ended||!scans)throw new Error('RASTER_TRUNCATED');
    } else throw new Error('RASTER_FORMAT');
    if(!width||!height)throw new Error('RASTER_FORMAT');
    return { metadataBytes, encodedBytes: length, width, height };
  } finally { closeSync(fd); }
}
