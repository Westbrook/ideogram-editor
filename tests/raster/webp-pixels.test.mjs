import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {openSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import sharp from 'sharp';
import {rootFor} from '../store/helpers.mjs';
import {orientWebPFile,forceWebPFileAlpha} from '../../dist/local/server/raster/webp-pixels.js';

test('bounded file orientation matches independent Sharp for every EXIF transform across tile edges',async t=>{
 const width=259,height=137,source=Buffer.alloc(width*height*4);for(let i=0;i<source.length;i++)source[i]=(i*31+(i>>>9)*17)%256;
 const root=await rootFor(t),input=join(root,'input.rgba');await writeFile(input,source,{mode:0o600});const fd=openSync(input,'r');
 try{for(let orientation=1;orientation<=8;orientation++){const path=join(root,'output-'+orientation),out=openSync(path,'wx',0o600);try{orientWebPFile(fd,out,width,height,orientation,()=>{});}finally{closeSync(out);}
  const tagged=await sharp(source,{raw:{width,height,channels:4}}).png().withMetadata({orientation}).toBuffer();const expected=await sharp(tagged).autoOrient().raw().toBuffer();assert.deepEqual(await readFile(path),expected,`orientation${orientation}`);
 }}finally{closeSync(fd);}
});
test('bounded alpha pass preserves hidden RGB and handles a partial final block',async t=>{
 const root=await rootFor(t),path=join(root,'rgba'),bytes=Buffer.alloc(65536+12);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;await writeFile(path,bytes,{mode:0o600});const expected=Buffer.from(bytes);for(let i=3;i<expected.length;i+=4)expected[i]=255;
 const fd=openSync(path,'r+');try{forceWebPFileAlpha(fd,bytes.length,()=>{});}finally{closeSync(fd);}assert.deepEqual(await readFile(path),expected);
});
test('bounded file passes check cancellation before writes and reject malformed extents',async t=>{
 const root=await rootFor(t),path=join(root,'rgba'),outPath=join(root,'out');await writeFile(path,Buffer.alloc(16),{mode:0o600});const fd=openSync(path,'r+'),out=openSync(outPath,'wx',0o600);
 try{assert.throws(()=>forceWebPFileAlpha(fd,16,()=>{throw Error('CANCEL');}),/CANCEL/);assert.throws(()=>orientWebPFile(fd,out,2,2,6,()=>{throw Error('CANCEL');}),/CANCEL/);assert.throws(()=>orientWebPFile(fd,out,2,2,9,()=>{}),/RASTER_ORIENTATION/);assert.throws(()=>orientWebPFile(fd,fd,2,2,1,()=>{}),/RASTER_LENGTH/);assert.throws(()=>forceWebPFileAlpha(fd,20,()=>{}),/RASTER_LENGTH/);}finally{closeSync(fd);closeSync(out);}assert.equal((await readFile(outPath)).length,0);assert.deepEqual(await readFile(path),Buffer.alloc(16));
});
