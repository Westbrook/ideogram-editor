// Original CC0 synthetic fixtures. This generator never calls the raster engine.
import sharp from 'sharp';
import {deflateSync,crc32} from 'node:zlib';
import {writeFileSync,readFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
const directory='tests/raster/fixtures';mkdirSync(directory,{recursive:true});
const fixture=[];
const save=(name,bytes,source,expected=null)=>{writeFileSync(directory+'/'+name,bytes,{mode:0o600});fixture.push({name,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,source,expected});};
const part=(t,b)=>{const o=Buffer.alloc(b.length+12);o.writeUInt32BE(b.length);o.write(t,4);b.copy(o,8);o.writeUInt32BE(crc32(o.subarray(4,-4)),o.length-4);return o;};
const png=(w,h,rgba,extra=[])=>{const header=Buffer.alloc(13);header.writeUInt32BE(w);header.writeUInt32BE(h,4);header[8]=8;header[9]=6;const rows=Buffer.alloc(h*(w*4+1));for(let y=0;y<h;y++)Buffer.from(rgba).copy(rows,y*(w*4+1)+1,y*w*4,(y+1)*w*4);return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),part('IHDR',header),...extra,part('IDAT',deflateSync(rows)),part('IEND',Buffer.alloc(0))]);};
save('seam-checker.png',png(520,2,Array.from({length:1040},(_,i)=>i%2?[0,0,255,255]:[255,0,0,255]).flat()),'Literal alternating red/blue cells across128 and512 boundaries.');
const pixels=[17,99,231,0,255,0,0,128,0,255,0,255,0,0,255,64,255,255,255,255,0,0,0,255];
const original=png(3,2,pixels);save('hidden-alpha.png',original,'Independent literal RGBA rows and PNG filter0/zlib framing.',{width:3,height:2,rgba:pixels});
save('white.png',png(1,1,[255,255,255,255]),'Literal white RGBA.',{width:1,height:1,rgba:[255,255,255,255]});
save('black.png',png(1,1,[0,0,0,255]),'Literal black RGBA.',{width:1,height:1,rgba:[0,0,0,255]});
save('mask.png',png(3,2,[0,0,0,255,255,255,255,255,255,255,255,128,255,255,255,0,255,255,255,255,0,0,0,255]),'Literal alpha/luminance mask.');
for(const orientation of [2,3,4,5,6,7,8]){
 const exif=Buffer.alloc(26);exif.write('II');exif.writeUInt16LE(42,2);exif.writeUInt32LE(8,4);exif.writeUInt16LE(1,8);exif.writeUInt16LE(0x112,10);exif.writeUInt16LE(3,12);exif.writeUInt32LE(1,14);exif.writeUInt16LE(orientation,18);
 save('orientation-'+orientation+'.png',png(3,2,pixels,[part('eXIf',exif)]),'Literal TIFF orientation tag '+orientation+'; original RGBA rows unchanged.');
}
const white=Buffer.alloc(16*16*4,255);
const whiteSharp=()=>sharp(white,{raw:{width:16,height:16,channels:4}});
save('white.jpg',await whiteSharp().jpeg({quality:90,chromaSubsampling:'4:4:4'}).toBuffer(),'Sharp0.35.4 mozjpeg encoder; uniform white exact diagnostic.',{width:16,height:16,uniform:[255,255,255,255]});
const jpegColor=Buffer.from(Array.from({length:16*16},(_,i)=>i%16<8?[128,64,32]:[40,160,220]).flat());
save('color.jpg',await sharp(jpegColor,{raw:{width:16,height:16,channels:3}}).jpeg({quality:90,chromaSubsampling:'4:4:4'}).toBuffer(),'Original two-color8px blocks, Sharp0.35.4 JPEG encoder; independent Pillow/libjpeg-turbo diagnostic.');
save('white-lossy.webp',await whiteSharp().webp({quality:90,lossless:false}).toBuffer(),'Sharp0.35.4 WebP1.6.0 lossy encoder; uniform white exact diagnostic.',{width:16,height:16,uniform:[255,255,255,255]});
save('alpha-lossless.webp',await sharp(Buffer.from(pixels),{raw:{width:3,height:2,channels:4}}).webp({lossless:true,effort:6}).toBuffer(),'Sharp0.35.4 WebP1.6.0 lossless encoder; alpha-zero RGB may be discarded by fixture encoder.');
save('alpha-lossy.webp',await sharp(Buffer.from(pixels),{raw:{width:3,height:2,channels:4}}).webp({quality:90,lossless:false}).toBuffer(),'Sharp0.35.4 WebP1.6.0 lossy alpha encoder.');
const animation=await sharp(Buffer.concat([white,Buffer.alloc(white.length)]),{raw:{width:16,height:32,channels:4,pageHeight:16}}).webp({lossless:true,loop:0,delay:[100,100]}).toBuffer();save('animated.webp',animation,'Real two-frame WebP generated with raw.pageHeight16.');
const actl=Buffer.alloc(8);actl.writeUInt32BE(2);save('animated-marker.png',png(3,2,pixels,[part('acTL',actl)]),'APNG animation control must reject before decoder.');
for(const name of ['srgb','p3']){const icc=readFileSync('tooling/raster/'+name+'.icc');save(name+'.png',png(3,2,pixels,[part('iCCP',Buffer.concat([Buffer.from('profile\0\0'),deflateSync(icc)]))]),'Literal RGBA and pinned libvips '+name+' ICC bytes; no fixture conversion.');}
const oracle=JSON.parse(readFileSync(directory+'/color-oracle.json'));const nonprimary=oracle.sourceRGB.flatMap((_,i)=>i%3===0?[...oracle.sourceRGB.slice(i,i+3),[0,128,255,64][i/3]]:[]);
save('p3-color.png',png(4,1,nonprimary,[part('iCCP',Buffer.concat([Buffer.from('profile\0\0'),deflateSync(readFileSync('tooling/raster/p3.icc'))]))]),'Original nonprimary P3 values; independent public LittleCMS C oracle in color-oracle.json.');
const fctl=(seq)=>{const b=Buffer.alloc(26);b.writeUInt32BE(seq);b.writeUInt32BE(1,4);b.writeUInt32BE(1,8);b.writeUInt16BE(1,20);b.writeUInt16BE(10,22);return part('fcTL',b);};
const apngBase=png(1,1,[255,0,0,255]);const frame2=Buffer.concat([Buffer.from([0,0,0,2]),deflateSync(Buffer.from([0,0,0,255,255]))]);
save('animated.png',Buffer.concat([apngBase.subarray(0,33),part('acTL',actl),fctl(0),apngBase.subarray(33,-12),fctl(1),part('fdAT',frame2),part('IEND',Buffer.alloc(0))]),'Complete original two-frame APNG with sequenced fcTL/fdAT and red/blue frames.');
save('metadata-bomb.png',png(1,1,[0,0,0,0],[part('zTXt',Buffer.concat([Buffer.from('text\0\0'),deflateSync(Buffer.alloc(5*1024*1024,65))]))]),'Compressed5MiB text exceeds the bounded parser reservation before native metadata.');
const unknown=Buffer.from(readFileSync('tooling/raster/srgb.icc'));unknown[84]^=1;save('unknown-profile.png',png(3,2,pixels,[part('iCCP',Buffer.concat([Buffer.from('profile\0\0'),deflateSync(unknown)]))]),'Valid container with unsupported exact ICC identity.');
const corrupt=Buffer.from(original);corrupt[corrupt.length-6]^=1;save('bad-crc.png',corrupt,'Single CRC byte mutation.');save('truncated.png',original.subarray(0,-7),'Missing complete IEND.');
const jpg=readFileSync(directory+'/white.jpg');save('truncated.jpg',jpg.subarray(0,-2),'Missing JPEG EOI.');
const webp=readFileSync(directory+'/white-lossy.webp');save('truncated.webp',webp.subarray(0,-2),'RIFF declared length exceeds actual.');
const over=png(1,1,[0,0,0,0]);over.writeUInt32BE(8193,16);over.writeUInt32BE(crc32(over.subarray(12,29)),29);save('oversize.png',over,'Valid IHDR CRC with unsupported8193 side; reject before decode.');
writeFileSync(directory+'/manifest.json',JSON.stringify({license:'CC0-1.0',provenance:'Synthetic original pixels authored for this repository. Sharp and libvips dependency licenses are separately retained; embedded ICC profiles come from the sealed public libvips built-in profiles.',generator:'tooling/raster/make-fixtures.mjs',fixtures:fixture},null,2)+'\n');
