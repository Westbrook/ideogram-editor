import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,chmod,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {canonical} from '../../dist/local/src/protocol/json.js';
import {runRaster,resourcePlan,hash,verifyCodecs} from '../../dist/local/server/raster/engine.js';
import {retainedTextResourcePlan,compositionResourcePlan} from '../../dist/local/server/raster/resource-plan.js';
import {rootFor} from '../store/helpers.mjs';
const base=new URL('./fixtures/',import.meta.url);
const fixture=JSON.parse(await readFile(new URL('manifest.json',base)));
const mime=n=>n.endsWith('.jpg')?'image/jpeg':n.endsWith('.webp')?'image/webp':'image/png';
async function decode(t,name){const root=await rootFor(t),directory=await mkdtemp(join(root,'job-')),path=join(directory,name);await copyFile(new URL(name,base),path);await chmod(path,0o600);const bytes=await readFile(path);return {root,directory,result:await runRaster({type:'decode',directory,path,mediaType:mime(name),sourceAssetId:'fixture',original:{hash:hash(bytes),byteLength:String(bytes.length),mediaType:mime(name)}},async()=>{},()=>{})};}
test('actual frozen PNG/JPEG/static WebP codec inputs; independently specified uniform and literal pixels',async t=>{
 verifyCodecs();for(const name of ['hidden-alpha.png','white.jpg','white-lossy.webp','alpha-lossless.webp','alpha-lossy.webp','srgb.png']){
  const {directory,result}=await decode(t,name);const rgba=await readFile(join(directory,'pixels.rgba')),expected=fixture.fixtures.find(f=>f.name===name).expected;
  if(expected?.rgba)assert.deepEqual([...rgba],expected.rgba);if(expected?.uniform)for(let i=0;i<rgba.length;i+=4)assert.deepEqual([...rgba.subarray(i,i+4)],expected.uniform);
  const roundtrip=await sharp(join(directory,'output.png'),{ignoreIcc:true}).ensureAlpha().raw().toBuffer();assert.deepEqual(roundtrip,rgba);assert.equal(result.info.conversion.resized,false);
 }
});
test('all eight EXIF orientations normalize once with exact alpha/hidden samples retained',async t=>{
 const input=fixture.fixtures.find(f=>f.name==='hidden-alpha.png').expected.rgba;
 // Expected order is manually enumerated for source matrix A B C / D E F.
 const orders={2:[2,1,0,5,4,3],3:[5,4,3,2,1,0],4:[3,4,5,0,1,2],5:[0,3,1,4,2,5],6:[3,0,4,1,5,2],7:[5,2,4,1,3,0],8:[2,5,1,4,0,3]};
 for(const [o,order]of Object.entries(orders)){const {directory,result}=await decode(t,'orientation-'+o+'.png');assert.deepEqual([...(await readFile(join(directory,'pixels.rgba')))],order.flatMap(i=>input.slice(i*4,i*4+4)));assert.equal(result.info.conversion.orientation,+o);assert.equal(result.info.width,+o>=5?2:3);}
});
test('supported P3 converts with review data and original profile identity retained',async t=>{
 const {directory,result}=await decode(t,'p3.png');assert.equal(result.info.conversion.colorChanged,true);assert.equal(result.info.conversion.profile,'p3');assert.ok(result.files.some(f=>f.name==='profile.icc'));assert.equal(result.info.conversion.resized,false);
 // P3 unit primaries clip to the same sRGB primaries; hidden color conversion is
 // separately retained in the original encoded input, never reconstructed.
 const rgba=await readFile(join(directory,'pixels.rgba'));assert.deepEqual([...rgba.subarray(4,8)],[255,0,0,128]);assert.deepEqual([...rgba.subarray(8,12)],[0,255,0,255]);
});
test('actual malformed/animated/profile/extent inputs cannot produce usable canonical output',async t=>{
 for(const name of ['bad-crc.png','truncated.png','truncated.jpg','truncated.webp','animated.webp','animated.png','metadata-bomb.png','animated-marker.png','unknown-profile.png','oversize.png'])await assert.rejects(()=>decode(t,name),/RASTER_/);
});

test('P3 nonprimary conversion matches independent public LittleCMS C oracle, retaining alpha',async t=>{
 const oracle=JSON.parse(await readFile(new URL('color-oracle.json',base)));const {directory}=await decode(t,'p3-color.png');const expected=oracle.expectedRGB.flatMap((_,i)=>i%3===0?[...oracle.expectedRGB.slice(i,i+3),[0,128,255,64][i/3]]:[]);assert.deepEqual([...(await readFile(join(directory,'pixels.rgba')))],expected);
});

test('lossy and lossless alpha WebP match independent public decoder diagnostic including exact alpha',async t=>{
 const oracle=JSON.parse(await readFile(new URL('webp-oracle.json',base)));for(const item of oracle.fixtures){const {directory}=await decode(t,item.name);assert.deepEqual([...(await readFile(join(directory,'pixels.rgba')))],item.expectedRGBA);}
});

test('WebP extent and native allocation plan are admitted before invoking its native metadata parser',async t=>{
 for(const name of ['max-webp-lossy.webp','max-webp-lossless.webp']){
  const root=await rootFor(t),directory=await mkdtemp(join(root,'job-')),path=join(directory,name);await copyFile(new URL(name,base),path);await chmod(path,0o600);const bytes=await readFile(path);let plan;
  const before=process.memoryUsage().rss;
  await assert.rejects(runRaster({type:'decode',directory,path,mediaType:'image/webp',sourceAssetId:'fixture',original:{hash:hash(bytes),byteLength:String(bytes.length),mediaType:'image/webp'}},async p=>{plan=p;throw Error('DENIED_BEFORE_NATIVE');},()=>{}),/DENIED_BEFORE_NATIVE/);
  assert.equal(plan.width,5000);assert.equal(plan.height,5000);assert.ok(plan.cpuBytes<384*1024*1024);assert.equal(plan.allocations.rawOutput,100000000);assert.equal(plan.allocations.nativeDecoderAndColor,128*1024*1024);assert.ok(process.memoryUsage().rss-before<128*1024*1024);
 }
});

test('actual nonwhite JPEG pixels match independently installed Pillow/libjpeg-turbo golden diagnostic',async t=>{
 const oracle=JSON.parse(await readFile(new URL('jpeg-oracle.json',base)));const {directory}=await decode(t,oracle.file);assert.deepEqual([...(await readFile(join(directory,'pixels.rgba')))],oracle.expectedRGBA);
});


test('frozen export preserves historical pixel identity and records current encoder separately',async t=>{
 const {root,directory,result}=await decode(t,'hidden-alpha.png');const pipeline='cp1-f64-triangle-area-v1/sha256:'+ '1'.repeat(64);
 const pixelIdentity=hash(canonical({pipeline,width:result.info.width,height:result.info.height,tiles:result.manifest.tiles}));
 const output=await mkdtemp(join(root,'historical-export-'));const exported=await runRaster({type:'export',directory:output,input:{id:'historical',path:join(directory,'pixels.rgba'),info:{...result.info,pipeline,pixelIdentity}},dependencies:[result.info.manifest]},async()=>{},()=>{});
 assert.equal(exported.info.pipeline,pipeline);assert.equal(exported.info.pixelIdentity,pixelIdentity);assert.notEqual(exported.manifest.plan.encoder,pipeline.split('/')[1]);assert.deepEqual(await readFile(join(output,'pixels.rgba')),await readFile(join(directory,'pixels.rgba')));
});

import {appendFileSync,existsSync,statSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileRef} from '../../dist/local/server/raster/engine.js';

const scratchLimit=1024*1024;
const independentHash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
// Forward real allocations and keep only numeric observations. This does not
// assert physical RSS release or change allocator, admission or worker policy.
function observeScratch(t,active=()=>true){
 const rows=[],allocate=Buffer.alloc;
 const mock=t.mock.method(Buffer,'alloc',function(size,...args){
  const value=Reflect.apply(allocate,this,[size,...args]);
  if(active())rows.push({requested:size,backing:value.buffer.byteLength});
  return value;
 });
 return {rows,restore:()=>mock.mock.restore()};
}

for(const size of [0,1,3,1024,scratchLimit-1,scratchLimit,scratchLimit+1])test('file hashing reads every byte with bounded actual scratch for '+size+' bytes',async t=>{
 const root=await rootFor(t),path=join(root,'hash-input'),bytes=Buffer.alloc(size);
 for(let i=0;i<size;i++)bytes[i]=(i*31+(i>>>10))%251;
 await writeFile(path,bytes,{mode:0o600});const expected=independentHash(bytes),observed=observeScratch(t);let result;
 try{result=fileRef(path,'application/octet-stream',()=>{});}finally{observed.restore();}
 assert.deepEqual(result,{hash:expected,byteLength:String(size),mediaType:'application/octet-stream'});
 assert.deepEqual(observed.rows,[{requested:Math.max(1,Math.min(size,scratchLimit)),backing:Math.max(1,Math.min(size,scratchLimit))}]);
});

test('bounded file hashing includes bytes appended after the first read rather than trusting initial size',async t=>{
 const root=await rootFor(t),path=join(root,'growing-input'),first=Buffer.from([3,17,91]),extra=Buffer.from([41,201,19,7,83]);
 await writeFile(path,first,{mode:0o600});let checks=0;
 const observed=observeScratch(t);let result;
 try{result=fileRef(path,'application/octet-stream',()=>{if(++checks===1)appendFileSync(path,extra);});}finally{observed.restore();}
 assert.equal(result.byteLength,'8');assert.equal(result.hash,independentHash(Buffer.concat([first,extra])));assert.ok(checks>=3);
 assert.deepEqual(observed.rows,[{requested:3,backing:3}]);
});

async function textScratchFixture(t,width,height,change=bytes=>bytes){
 const root=await rootFor(t),directory=await mkdtemp(join(root,'text-')),path=join(root,'retained.rgba'),bytes=Buffer.alloc(width*height*4);
 for(let i=0;i<bytes.length;i+=4){bytes[i]=(i*13)%251;bytes[i+1]=(i>>>4)%251;bytes[i+2]=(i>>>8)%251;bytes[i+3]=[1,64,128,255][(i>>>2)%4];}
 const stored=change(bytes);await writeFile(path,stored,{mode:0o600});
 const source={hash:independentHash(Buffer.from('retained text source')),byteLength:'20',mediaType:'application/json'};
 return {bytes:stored,path,directory,job:{type:'text',directory,path,width,height,source,dependencies:[source]}};
}

for(const [width,height] of [[1,1],[16,16],[512,512],[513,513],[8192,1],[1,8192]])test('retained text preserves exact RGBA and output hashes with bounded copy scratch at '+width+'x'+height,async t=>{
 const f=await textScratchFixture(t,width,height);let admitted=false,admissions=0,admittedPlan;
 const observed=observeScratch(t,()=>admitted);let result;
 try{result=await runRaster(f.job,async plan=>{assert.deepEqual(observed.rows,[]);admittedPlan=structuredClone(plan);admitted=true;admissions++;},()=>{});}finally{observed.restore();}
 assert.equal(admissions,1);const requested=Math.min(f.bytes.length,scratchLimit);
 assert.deepEqual(observed.rows[0],{requested,backing:requested},'The first post-admission allocation is the real RGBA copy scratch');
 const identityTile=Math.min(width,512)*Math.min(height,512)*4;
 assert.deepEqual(observed.rows.slice(0,3),[{requested,backing:requested},{requested,backing:requested},{requested:identityTile,backing:identityTile}],'The actual copy, raw hash and shared identity tile are three distinct allocations');
 assert.deepEqual(admittedPlan,retainedTextResourcePlan(width,height));assert.deepEqual(result.plan,admittedPlan);
 assert.equal(admittedPlan.allocations.retainedTextCopy,observed.rows[0].backing);assert.equal(admittedPlan.allocations.retainedTextIdentityTile,observed.rows[2].backing);
 assert.equal(admittedPlan.allocations.pngAndHashIO,4194304,'Raw hash scratch remains covered by the unchanged common PNG/hash allowance');
 assert.equal(admittedPlan.cpuBytes,109117440+observed.rows[0].backing+observed.rows[2].backing,'Copy and tile reservations add; sequential scopes are not physical release evidence');
 assert.ok(observed.rows.every(row=>row.requested<=scratchLimit&&row.backing===row.requested));
 if(f.bytes.length<scratchLimit)assert.equal(observed.rows.some(row=>row.requested===scratchLimit),false,'Small text copies and all three output hashes must avoid full-size scratch');
 assert.deepEqual(await readFile(f.path),f.bytes);assert.deepEqual(await readFile(join(f.directory,'pixels.rgba')),f.bytes);
 for(const file of result.files){const bytes=await readFile(join(f.directory,file.name));assert.equal(file.ref.hash,independentHash(bytes));assert.equal(file.ref.byteLength,String(bytes.length));}
 assert.equal(result.manifest.plan.kind,'retained-text');assert.equal(result.info.pixels.hash,independentHash(f.bytes));
 const decoded=await sharp(join(f.directory,'output.png'),{ignoreIcc:true}).ensureAlpha().raw().toBuffer();assert.deepEqual(decoded,f.bytes);
});

for(const kind of ['truncated','extra','transparent-rgb'])test('bounded retained text scratch still rejects '+kind+' inputs on both sides of a read boundary',async t=>{
 for(const side of [16,513]){
  const f=await textScratchFixture(t,side,side,bytes=>{
   if(kind==='truncated')return bytes.subarray(0,-4);
   if(kind==='extra')return Buffer.concat([bytes,Buffer.from([1,2,3,255])]);
   const at=bytes.length-4;bytes[at]=1;bytes[at+1]=bytes[at+2]=bytes[at+3]=0;return bytes;
  });
  let admitted=false;const observed=observeScratch(t,()=>admitted);
  try{await assert.rejects(runRaster(f.job,async()=>{admitted=true;},()=>{}),kind==='transparent-rgb'?/TEXT_TRANSPARENT_RGB/:/TEXT_PIXEL_LENGTH/);}finally{observed.restore();}
  assert.equal(observed.rows[0].requested,Math.min(side*side*4,scratchLimit));assert.deepEqual(await readFile(f.path),f.bytes);
  assert.equal(existsSync(join(f.directory,'output.png')),false);assert.equal(existsSync(join(f.directory,'manifest.json')),false);
 }
});

test('bounded retained text copy preserves cancellation between actual chunks and keeps the source unchanged',async t=>{
 const f=await textScratchFixture(t,513,513),failure=Error('TEXT_COPY_CANCEL');let admitted=false,checks=0;
 const observed=observeScratch(t,()=>admitted);
 try{await assert.rejects(runRaster(f.job,async()=>{admitted=true;},()=>{if(admitted&&++checks===2)throw failure;}),error=>error===failure);}finally{observed.restore();}
 assert.equal(checks,2);assert.deepEqual(observed.rows,[{requested:scratchLimit,backing:scratchLimit}]);
 assert.equal(statSync(join(f.directory,'pixels.rgba')).size,scratchLimit);assert.deepEqual(await readFile(f.path),f.bytes);
 assert.equal(existsSync(join(f.directory,'output.png')),false);
});

test('retained text admission refusal still precedes copy scratch and output creation',async t=>{
 const f=await textScratchFixture(t,16,16),failure=Error('TEXT_COPY_DENIED');let refusing=false;
 const observed=observeScratch(t,()=>refusing);
 try{await assert.rejects(runRaster(f.job,async()=>{refusing=true;throw failure;},()=>{}),error=>error===failure);}finally{observed.restore();}
 assert.deepEqual(observed.rows,[]);assert.equal(existsSync(join(f.directory,'pixels.rgba')),false);assert.deepEqual(await readFile(f.path),f.bytes);
});


test('shared nondecode plan preserves every existing full allocation and metadata disk byte',async()=>{
 const {nonDecodeResourcePlan,ACTIVE_COMPUTE_RESERVATION_BYTES}=await import('../../dist/local/server/raster/resource-plan.js');
 const allocations={nativeDecoderAndColor:0,nativeStackAndIO:0,encodedInput:0,rawOutput:0,orientationRowsAndTiles:8388608,metadataAndProfileCopies:4194304,pngAndHashIO:4194304,workerHeapAndRuntime:83886080,concurrentBackendHeadroom:16777216,activeKernelTelemetry:65536};
 assert.equal(ACTIVE_COMPUTE_RESERVATION_BYTES,65536);
 for(const [width,height,metadata]of [[1,1,0],[16,16,0],[5000,5000,0],[8192,1,12345]]){
  const expected={width,height,rawBytes:width*height*4,allocations,cpuBytes:117506048,diskBytes:width*height*12+metadata+2097152};
  assert.deepEqual(nonDecodeResourcePlan(width,height,metadata),expected);
  assert.deepEqual(resourcePlan(width,height,false,metadata),expected);
 }
 for(const [width,height]of [[0,1],[1,0],[8193,1],[5001,5000],[1.5,1]])assert.throws(()=>nonDecodeResourcePlan(width,height),/RASTER_EXTENT/);
 // Source-evidence arithmetic only: no synthetic RSS or successful admission.
 for(const actualRSS of [349274112,346521600]){
  assert(actualRSS+64495692+134217728>536870912);
  assert(actualRSS+64495692+nonDecodeResourcePlan(16,16).cpuBytes<=536870912);
 }
});

test('retained text reserves the complete common plan plus both bounded copy and identity tile',()=>{
 const common={nativeDecoderAndColor:0,nativeStackAndIO:0,encodedInput:0,rawOutput:0,orientationRowsAndTiles:0,metadataAndProfileCopies:4194304,pngAndHashIO:4194304,workerHeapAndRuntime:83886080,concurrentBackendHeadroom:16777216,activeKernelTelemetry:65536};
 // Explicit boundary values include the byte cap, both independent tile axes,
 // the largest accepted area and narrow extents. This is reservation arithmetic,
 // not a physical-memory measurement or a claim of allocator reclamation.
 for(const [width,height,rawBytes,copy,tile,cpuBytes]of [
  [1,1,4,4,4,109117448],
  [16,16,1024,1024,1024,109119488],
  [512,511,1046528,1046528,1046528,111210496],
  [512,512,1048576,1048576,1048576,111214592],
  [513,513,1052676,1048576,1048576,111214592],
  [513,1,2052,2052,2048,109121540],
  [1,513,2052,2052,2048,109121540],
  [8192,1,32768,32768,2048,109152256],
  [1,8192,32768,32768,2048,109152256],
  [5000,5000,100000000,1048576,1048576,111214592],
 ]){
  const plan=retainedTextResourcePlan(width,height);
  assert.deepEqual(plan,{width,height,rawBytes,allocations:{...common,retainedTextCopy:copy,retainedTextIdentityTile:tile},cpuBytes,diskBytes:rawBytes*3+2097152});
  assert.equal(plan.cpuBytes,Object.values(plan.allocations).reduce((sum,value)=>sum+value,0));
  assert.equal(resourcePlan(width,height,false).cpuBytes,117506048,'Other nondecode operations keep the existing orientation workspace');
 }
 for(const [width,height]of [[0,1],[1,0],[8193,1],[1,8193],[5001,5000],[5000,5001],[1.5,1],[NaN,1],[1,Infinity]])assert.throws(()=>retainedTextResourcePlan(width,height),/RASTER_EXTENT/);
});

test('composition retains complete common allowances and the largest simultaneous source plus mask rows',()=>{
 const layers=[
  {assetId:'wide',opacity:1,mask:{assetId:'coverage'},transform:[1,0,0,1,0,0]},
  {assetId:'large',opacity:1,mask:{assetId:'rgba-mask'},transform:[1,0,0,1,0,0]},
 ];
 const inputs=[
  {id:'wide',info:{width:8192,height:1,role:'composite'}},
  {id:'coverage',info:{width:8192,height:128,role:'mask'}},
  {id:'large',info:{width:5000,height:5000,role:'composite'}},
  {id:'rgba-mask',info:{width:512,height:512,role:'composite'}},
 ];
 const ordinary=compositionResourcePlan(512,512,layers,inputs),capture=compositionResourcePlan(512,512,layers,inputs,true);
 // Independently enumerated row backings: 32,768 + 2,097,152 versus
 // 640,000 + 65,536. Different layers are streamed; each source/mask pair
 // is simultaneous. These are reservations, not measured resident memory.
 assert.equal(ordinary.allocations.retainedInputRows,2129920);
 assert.equal(ordinary.cpuBytes,119635968);assert.equal(ordinary.diskBytes,5242880);
 const {retainedInputRows,...common}=ordinary.allocations;
 assert.deepEqual(common,resourcePlan(512,512,false).allocations);
 assert.equal(capture.allocations.retainedInputRows,2129920);
 assert.equal(capture.allocations.contributionMetadata,196608);
 assert.equal(capture.cpuBytes,119832576);assert.equal(capture.diskBytes,7536640);
});

test('composition capture books passthrough, singleton and retained contribution disk without deduplication credit',()=>{
 const native={id:'native',info:{width:512,height:512,role:'composite'}};
 const layer={assetId:'native',opacity:1,mask:null,transform:[1,0,0,1,0,0]};
 const changed={...layer,opacity:.5};
 for(const [layers,cpu,disk]of [
  [[],117571584,5308416],
  [[layer],117702656,5373952],
  [[changed],117702656,5373952],
  [[layer,changed],117768192,6488064],
  [[changed,changed],117768192,7536640],
 ]){
  const plan=compositionResourcePlan(512,512,layers,[native],true);
  assert.equal(plan.cpuBytes,cpu);assert.equal(plan.diskBytes,disk);
  assert.equal(plan.allocations.contributionMetadata,(layers.length+1)*65536);
 }
 const empty=compositionResourcePlan(512,512,[],[]);
 assert.equal(empty.cpuBytes,117506048);assert.equal(empty.allocations.retainedInputRows,0);
 assert.equal('contributionMetadata'in empty.allocations,false);
 assert.equal(compositionResourcePlan(512,512,Array(100).fill(layer),[native]).allocations.retainedInputRows,65536);
 assert.throws(()=>compositionResourcePlan(512,512,Array(101).fill(layer),[native]),/RASTER_LAYERS/);
 for(const [width,height]of [[0,1],[1,0],[8193,1],[5001,5000],[1.5,1]])assert.throws(()=>compositionResourcePlan(width,height,[],[]),/RASTER_EXTENT/);
});
