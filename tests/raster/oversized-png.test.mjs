import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {readdirSync,writeFileSync,readFileSync,lstatSync,renameSync,unlinkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deflateSync} from 'node:zlib';
import sharp from 'sharp';
import {preparePNGImport} from '../../dist/local/server/raster/png-import.js';
import {chunk,PNG_SIGNATURE} from '../../dist/local/server/raster/png.js';
import {importOperation,encodedExtent} from '../../dist/local/src/protocol/raster-import.js';
import {importContributionRow} from '../../dist/local/server/raster/import-file-transform.js';

function png(width,height,samples,{color=6,depth=8,interlace=0,extra=[],compressed=null,splitIDAT=false}={}){
 const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=depth;header[9]=color;header[12]=interlace;
 const data=compressed??deflateSync(samples),idat=splitIDAT?Array.from(data,byte=>chunk('IDAT',Buffer.from([byte]))):[chunk('IDAT',data)];
 return Buffer.concat([PNG_SIGNATURE,chunk('IHDR',header),...extra.map(([type,data])=>chunk(type,data)),...idat,chunk('IEND',Buffer.alloc(0))]);
}
async function fixture(t,bytes){const directory=await mkdtemp(join(tmpdir(),'oversized-png-'));t.after(()=>rm(directory,{recursive:true,force:true}));const input=join(directory,'original.png');await writeFile(input,bytes,{mode:0o600});return {directory,input,bytes};}
async function prepare(f,operation,check=()=>{}){const plans=[];const value=await preparePNGImport(f.input,f.directory,operation,async plan=>{plans.push(plan);assert.ok(plan.cpuBytes<=512*1048576);},check);assert.deepEqual(await readFile(f.input),f.bytes);return {...value,plans,pixels:await readFile(value.raw)};}

test('oversized PNG crop preserves exact hidden RGB and original encoded bytes',async t=>{
 const row=Buffer.alloc(8193*4);row.set([13,27,91,0,77,66,55,123],row.length-8);const f=await fixture(t,png(8193,1,Buffer.concat([Buffer.from([0]),row])));
 const out=await prepare(f,{kind:'crop',x:8191,y:0,width:2,height:1});assert.deepEqual(out.pixels,Buffer.from([13,27,91,0,77,66,55,123]));
 assert.deepEqual(await sharp(await readFile(out.png),{ignoreIcc:true}).ensureAlpha().raw().toBuffer(),out.pixels);assert.equal(out.plans.length,1);assert.equal(out.plans[0].rawBytes,8);assert.equal(out.plans[0].allocations.pngRows,8193*12);assert.ok(out.plans[0].diskBytes>=8193*4+24);
 assert.equal((await readdir(f.directory)).some(name=>name.startsWith('.original-')),false);
});

test('oversized PNG deliberate CP1 minification uses transparent-zero edge samples',async t=>{
 const row=Buffer.alloc(8194*4,255),f=await fixture(t,png(8194,1,Buffer.concat([Buffer.from([0]),row]))),out=await prepare(f,{kind:'resize',width:4097,height:1});
 // Scale2 integrates a triangle over a two-pixel source span. Each exterior
 // border loses exactly1/16 coverage: round(255*15/16)=239, with no renormalization.
 const expected=Buffer.alloc(4097*4,255);expected[3]=239;expected[expected.length-1]=239;assert.deepEqual(out.pixels,expected);
 assert.equal(out.derivation.operation.width,4097);assert.deepEqual(out.inspection.encoded,{width:8194,height:1});
});

test('PNG Sub and Paeth reconstruction precede exact sample selection',async t=>{
 const filtered=Buffer.from([1,10,20,30,40,40,40,40,40,4,90,90,90,90,30,30,30,30]),f=await fixture(t,png(2,2,filtered)),out=await prepare(f,{kind:'crop',x:0,y:0,width:2,height:2});
 assert.deepEqual(out.pixels,Buffer.from([10,20,30,40,50,60,70,80,100,110,120,130,130,140,150,160]));
});

test('indexed samples, transparency and Adam7 passes retain their exact row-major positions',async t=>{
 const palette=Buffer.from([11,22,33,44,55,66,77,88,99,101,111,121]),samples=Buffer.from([0,0b00000000,0,0b01000000,0,0b10110000]);
 const f=await fixture(t,png(2,2,samples,{color:3,depth:2,interlace:1,extra:[['PLTE',palette],['tRNS',Buffer.from([0,64,128,255])]]})),out=await prepare(f,{kind:'crop',x:0,y:0,width:2,height:2});
 assert.deepEqual(out.pixels,Buffer.from([11,22,33,0,44,55,66,64,77,88,99,128,101,111,121,255]));
});

test('EXIF rotation maps crop coordinates in the displayed source grid',async t=>{
 const exif=Buffer.from('49492a0008000000010012010300010000000600000000000000','hex'),row=Buffer.alloc(8193*4);row.set([10,20,30,40,50,60,70,80],row.length-8);
 const f=await fixture(t,png(8193,1,Buffer.concat([Buffer.from([0]),row]),{extra:[['eXIf',exif]]})),out=await prepare(f,{kind:'crop',x:0,y:8191,width:1,height:2});
 assert.equal(out.inspection.orientation,6);assert.deepEqual(out.pixels,Buffer.from([10,20,30,40,50,60,70,80]));
});

test('metadata-only inspection never promotes invalid or incomplete PNG samples',async t=>{
 const f=await fixture(t,png(8193,1,Buffer.from([0,1,2,3,4])));await assert.rejects(prepare(f,{kind:'crop',x:0,y:0,width:1,height:1}),/RASTER_LENGTH/);
 assert.deepEqual(await readdir(f.directory),['original.png']);assert.deepEqual(await readFile(f.input),f.bytes);
});

test('resource refusal and cancellation remove owned scratch while preserving the original',async t=>{
 const f=await fixture(t,png(8193,1,Buffer.concat([Buffer.from([0]),Buffer.alloc(8193*4)])));
 await assert.rejects(preparePNGImport(f.input,f.directory,{kind:'crop',x:0,y:0,width:1,height:1},async()=>{throw Error('CAPACITY');},()=>{}),/CAPACITY/);
 assert.deepEqual(await readdir(f.directory),['original.png']);await writeFile(join(f.directory,'prior.png'),'previous export',{mode:0o600});
 await assert.rejects(preparePNGImport(f.input,f.directory,{kind:'crop',x:0,y:0,width:1,height:1},async()=>{},()=>{if(readdirSync(f.directory).some(name=>name.startsWith('.original-')))throw Error('CANCELED');}),/CANCELED/);
 assert.deepEqual((await readdir(f.directory)).sort(),['original.png','prior.png']);assert.deepEqual(await readFile(f.input),f.bytes);assert.equal(await readFile(join(f.directory,'prior.png'),'utf8'),'previous export');
});

test('completed PNG prepare reports scratch ownership loss and still removes its owned outputs',async t=>{
 const pixels=Buffer.from([13,27,91,0]),f=await fixture(t,png(1,1,Buffer.concat([Buffer.from([0]),pixels]))),raw=join(f.directory,'pixels.rgba'),output=join(f.directory,'output.png'),moved=join(f.directory,'retained-owned-original.rgba'),foreign=Buffer.from('foreign replacement'),iend=chunk('IEND',Buffer.alloc(0));let replaced;
 await assert.rejects(preparePNGImport(f.input,f.directory,{kind:'crop',x:0,y:0,width:1,height:1},async()=>{},()=>{
  if(replaced||!existsSync(output)||!readFileSync(output).subarray(-iend.length).equals(iend))return;
  // The final stable check sees a complete PNG, after transform has closed its
  // source. Move the owned inode and replace only its scratch pathname.
  const names=readdirSync(f.directory).filter(name=>name.startsWith('.original-'));assert.equal(names.length,1);
  const path=join(f.directory,names[0]),owned=lstatSync(path);assert.deepEqual(readFileSync(raw),pixels);
  renameSync(path,moved);writeFileSync(path,foreign,{flag:'wx',mode:0o600});const replacement=lstatSync(path);
  assert.notDeepEqual([replacement.dev,replacement.ino],[owned.dev,owned.ino]);replaced={path,owned};
 },true),error=>{
  assert.ok(error instanceof AggregateError);assert.equal(error.message,'Raster import cleanup failed');
  assert.deepEqual(error.errors.map(failure=>failure.message),['RASTER_INPUT_CHANGED']);return true;
 });
 assert.ok(replaced,'Reached the final stable check after PNG encoding');
 assert.deepEqual(await readFile(replaced.path),foreign);const retained=lstatSync(moved);assert.deepEqual([retained.dev,retained.ino],[replaced.owned.dev,replaced.owned.ino]);assert.deepEqual(await readFile(moved),pixels);
 assert.equal(existsSync(raw),false,'Cleanup attempted the still-owned raw output');assert.equal(existsSync(output),false,'Cleanup attempted the still-owned encoded output');assert.deepEqual(await readFile(f.input),f.bytes);
 // The deliberately moved original is retained evidence, distinct from the
 // foreign replacement. The fixture's final directory removal owns both.
 assert.deepEqual((await readdir(f.directory)).sort(),[replaced.path.slice(f.directory.length+1),'original.png','retained-owned-original.rgba'].sort());
});

test('completed PNG prepare tolerates already unlinked original scratch during cleanup',async t=>{
 const pixels=Buffer.from([13,27,91,0]),f=await fixture(t,png(1,1,Buffer.concat([Buffer.from([0]),pixels]))),output=join(f.directory,'output.png'),iend=chunk('IEND',Buffer.alloc(0));let removed=false;
 const result=await preparePNGImport(f.input,f.directory,{kind:'crop',x:0,y:0,width:1,height:1},async()=>{},()=>{
  if(removed||!existsSync(output)||!readFileSync(output).subarray(-iend.length).equals(iend))return;
  const names=readdirSync(f.directory).filter(name=>name.startsWith('.original-'));assert.equal(names.length,1);unlinkSync(join(f.directory,names[0]));removed=true;
 },true);
 assert.equal(removed,true);assert.deepEqual(await readFile(result.raw),pixels);assert.ok((await readFile(result.png)).subarray(-iend.length).equals(iend));assert.deepEqual(await readFile(f.input),f.bytes);
 assert.deepEqual((await readdir(f.directory)).sort(),['original.png','output.png','pixels.rgba']);
});

test('a single output pixel yields and observes cancellation during its oversized footprint',async()=>{
 let read=0,canceled=false;setImmediate(()=>{canceled=true;});
 const source={width:8193,height:2,get(_x,_y,into){read++;into.set([255,255,255,255]);}};
 await assert.rejects(importContributionRow(source,0,1,[1/8193,0,0,1/2,0,0],()=>{if(canceled)throw Error('CANCELED');}),/CANCELED/);
 assert.ok(read>0&&read<source.width*source.height);
});

test('source mutation after admission cannot publish a derived preview',async t=>{
 const f=await fixture(t,png(8193,1,Buffer.concat([Buffer.from([0]),Buffer.alloc(8193*4)])));let changed=false,admissions=0;
 await writeFile(join(f.directory,'prior.png'),'previous export',{mode:0o600});
 await assert.rejects(preparePNGImport(f.input,f.directory,{kind:'crop',x:0,y:0,width:1,height:1},async()=>{admissions++;},()=>{if(!changed&&readdirSync(f.directory).some(name=>name.startsWith('.original-'))){changed=true;writeFileSync(f.input,Buffer.from('changed'));}}),/RASTER_INPUT_CHANGED/);
 assert.equal(admissions,1);assert.equal(changed,true);assert.deepEqual((await readdir(f.directory)).sort(),['original.png','prior.png']);
 assert.deepEqual(await readFile(f.input),Buffer.from('changed'));assert.equal(await readFile(join(f.directory,'prior.png'),'utf8'),'previous export');
});

test('already truncated PNG keeps its truncation classification and publishes no preview',async t=>{
 const f=await fixture(t,png(1,1,Buffer.from([0,1,2,3,4])).subarray(0,20));let admissions=0;
 await assert.rejects(preparePNGImport(f.input,f.directory,{kind:'crop',x:0,y:0,width:1,height:1},async()=>{admissions++;},()=>{}),/RASTER_TRUNCATED/);
 assert.equal(admissions,0);assert.deepEqual(await readdir(f.directory),['original.png']);assert.deepEqual(await readFile(f.input),f.bytes);
});

test('all EXIF orientations preserve non-square sample positions',async t=>{
 const samples=Buffer.from([0,1,2,3,0,4,5,6]),orders=[[1,2,3,4,5,6],[3,2,1,6,5,4],[6,5,4,3,2,1],[4,5,6,1,2,3],[1,4,2,5,3,6],[4,1,5,2,6,3],[6,3,5,2,4,1],[3,6,2,5,1,4]];
 for(let orientation=1;orientation<=8;orientation++){
  const exif=Buffer.from('49492a0008000000010012010300010000000100000000000000','hex');exif.writeUInt16LE(orientation,18);
  const f=await fixture(t,png(3,2,samples,{color:0,extra:[['eXIf',exif]]})),out=await prepare(f,{kind:'crop',x:0,y:0,width:orientation>=5?2:3,height:orientation>=5?3:2});
  assert.deepEqual(out.pixels,Buffer.from(orders[orientation-1].flatMap(n=>[n,n,n,255])));
 }
});

for(const depth of [1,2,4])test('packed grayscale depth'+depth+' and tRNS expand exact authored values',async t=>{
 const max=(1<<depth)-1,values=Array.from({length:8/depth},(_,i)=>i%2?max:0),packed=values.reduce((b,v,i)=>b|(v<<(8-depth*(i+1))),0),f=await fixture(t,png(values.length,1,Buffer.from([0,packed]),{color:0,depth,extra:[['tRNS',Buffer.from([0,max])]]}));
 const out=await prepare(f,{kind:'crop',x:0,y:0,width:values.length,height:1});assert.deepEqual(out.pixels,Buffer.from(values.flatMap(v=>[v*255/max,v*255/max,v*255/max,v===max?0:255])));
});

test('grayscale-alpha and RGB tRNS retain hidden colors',async t=>{
 const gray=await fixture(t,png(2,1,Buffer.from([0,19,0,83,129]),{color:4})),grayOut=await prepare(gray,{kind:'crop',x:0,y:0,width:2,height:1});assert.deepEqual(grayOut.pixels,Buffer.from([19,19,19,0,83,83,83,129]));
 const rgb=await fixture(t,png(2,1,Buffer.from([0,10,20,30,11,20,30]),{color:2,extra:[['tRNS',Buffer.from([0,10,0,20,0,30])]]})),rgbOut=await prepare(rgb,{kind:'crop',x:0,y:0,width:2,height:1});assert.deepEqual(rgbOut.pixels,Buffer.from([10,20,30,0,11,20,30,255]));
});

test('all seven Adam7 passes and all five filters reconstruct a9x9 independent coordinate pattern',async t=>{
 const palette=Buffer.from([12,34,56,78,90,123,145,167,189,210,232,254]),rows=[];
 // This fixture encoder emits packed2-bit palette samples; the oracle below
 // comes from absolute(x,y), independent of pass partitioning/filter state.
 const geometry=[[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]];
 let filter=0;const paeth=(a,b,c)=>{const p=a+b-c,da=Math.abs(p-a),db=Math.abs(p-b),dc=Math.abs(p-c);return da<=db&&da<=dc?a:db<=dc?b:c;};
 for(const [x0,y0,dx,dy]of geometry){let previous=null;for(let y=y0;y<9;y+=dy){
  const values=[];for(let x=x0;x<9;x+=dx)values.push((x+3*y)%4);const plain=Buffer.alloc(Math.ceil(values.length/4));values.forEach((value,i)=>{plain[i>>2]|=value<<(6-2*(i%4));});
  const encoded=Buffer.alloc(plain.length+1),kind=filter++%5;encoded[0]=kind;for(let i=0;i<plain.length;i++){const left=i?plain[i-1]:0,up=previous?.[i]??0,corner=i?previous?.[i-1]??0:0,predictor=[0,left,up,Math.floor((left+up)/2),paeth(left,up,corner)][kind];encoded[i+1]=(plain[i]-predictor)&255;}rows.push(encoded);previous=plain;
 }}
 const f=await fixture(t,png(9,9,Buffer.concat(rows),{color:3,depth:2,interlace:1,extra:[['PLTE',palette],['tRNS',Buffer.from([0,85,170,255])]],splitIDAT:true})),out=await prepare(f,{kind:'crop',x:0,y:0,width:9,height:9}),expected=Buffer.alloc(9*9*4);
 for(let y=0;y<9;y++)for(let x=0;x<9;x++){const index=(x+3*y)%4,at=(y*9+x)*4;palette.copy(expected,at,index*3,index*3+3);expected[at+3]=index*85;}assert.deepEqual(out.pixels,expected);
});

test('valid chunk CRC cannot hide an incomplete zlib checksum or corrupted image stream',async t=>{
 const samples=Buffer.from([0,10,20,30,40]),compressed=deflateSync(samples);
 for(const data of [compressed.subarray(0,compressed.length-1),Buffer.from(compressed).map((byte,i)=>i===compressed.length-1?byte^1:byte)]){
  const f=await fixture(t,png(1,1,samples,{compressed:data,splitIDAT:true}));await assert.rejects(prepare(f,{kind:'crop',x:0,y:0,width:1,height:1}));assert.deepEqual(await readdir(f.directory),['original.png']);assert.deepEqual(await readFile(f.input),f.bytes);
 }
});

test('source geometry and explicit target bounds never silently clamp or round',()=>{
 assert.doesNotThrow(()=>encodedExtent(5001,5000));assert.doesNotThrow(()=>importOperation({kind:'crop',x:0,y:0,width:5000,height:5000},5001,5000));
 for(const op of [{kind:'resize',width:5001,height:5000},{kind:'crop',x:-1,y:0,width:1,height:1},{kind:'crop',x:0.5,y:0,width:1,height:1},{kind:'crop',x:8193,y:0,width:1,height:1},{kind:'resize',width:10,height:10,round:true}])assert.throws(()=>importOperation(op,8193,1));
 for(const dimensions of [[0,1],[2**31,1],[1,NaN]])assert.throws(()=>encodedExtent(...dimensions));
});
