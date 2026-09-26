// Original CC0 synthetic images. Encoded bytes must match resource-inputs.json.
import sharp from 'sharp';
import{readFileSync,writeFileSync}from'node:fs';
import{createHash}from'node:crypto';
import assert from'node:assert/strict';
const manifest=JSON.parse(readFileSync('tests/raster/fixtures/resource-inputs.json'));
for(const f of manifest.fixtures){let image=sharp({create:{width:f.width,height:f.height,channels:4,background:{r:255,g:255,b:255,alpha:1}}});
 if(f.format==='png')image=image.png();
 else if(f.format==='jpeg')image=image.jpeg({quality:90,chromaSubsampling:'4:4:4',progressive:f.file.includes('progressive')});
 else image=image.webp({quality:90,lossless:f.file.includes('lossless')});
 const bytes=await image.toBuffer();assert.equal(createHash('sha256').update(bytes).digest('hex'),f.sha256,f.file);writeFileSync(f.file,bytes,{mode:0o600});
}
console.log('Nine exact resource fixtures reproduced from independent solid-white inputs.');
