// Trusted, data-only adaptation of the frozen WebP host and fixture contracts.
// Never import a captured module, consult its former checkout, or decode pixels.
// The proof adapter owns retained-file confinement and original-path resolution.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {basename,isAbsolute,posix} from 'node:path';
import {RESOURCE_CASES,validateResourceObservation,summarizeResourceJobs} from './webp-alpha-resource-contract.mjs';

export const ALPHA_HOST_ROLES=Object.freeze(['host-ffi','host-cleanup','color-orientation-cp1','native-resources','writer-resources','durability']);
export const ALPHA_HOST_CASES=Object.freeze({
 'host-ffi':Object.freeze(['abi-version','argument-layout','atomic-cancellation','held-descriptor','two-load-orders']),
 'host-cleanup':Object.freeze(['source-mutation','source-replacement','output-rename','output-replacement','parent-fsync-retry','active-cancellation','reservation-retained-on-failure','journal-record-retry','journal-remove-retry']),
 'color-orientation-cp1':Object.freeze(['untagged-srgb','srgb','display-p3',...Array.from({length:8},(_,i)=>'orientation-'+(i+1)),'cp1-crop','cp1-resize','pinned-overlap-parity','oversized-lossy','oversized-lossless']),
 durability:Object.freeze(['original-retention','expired-plan-rejection','exact-preview-approval','cancel-before-commit','commit-wins-cancel','same-command-retry','copy-import-recopy','restart-recovery','deletion-cleanup']),
});
export const alphaHostRoleCases=role=>{
 assert(ALPHA_HOST_ROLES.includes(role),'Unknown WebP host role');
 return ALPHA_HOST_CASES[role]??RESOURCE_CASES.map(name=>role+'-'+name);
};
const HASH=/^sha256:[a-f0-9]{64}$/;
const positive=value=>assert(Number.isSafeInteger(value)&&value>0,'Positive integer required');
const digest=data=>'sha256:'+createHash('sha256').update(data).digest('hex');
const identity=value=>({bytes:value.bytes,hash:value.hash});
const object=value=>assert(value&&typeof value==='object'&&!Array.isArray(value),'Object required');
function exact(value,keys){object(value);assert.deepEqual(Object.keys(value).sort(),[...keys].sort(),'Unexpected retained data shape');}
function reference(value){object(value);assert.equal(typeof value.path,'string');assert(value.path.length>0&&!value.path.includes('\0'));positive(value.bytes);assert.match(value.hash,HASH);return value;}
function relativeReference(value){reference(value);assert(!isAbsolute(value.path)&&!value.path.includes('\\')&&value.path.split('/').every(part=>part&&part!=='.'&&part!=='..'),'Invalid fixture-relative reference');return value;}
function retained(proof,parentHash,ref,parentPath,{json=false}={}){
 assert.match(parentHash,HASH);reference(ref);assert.equal(typeof proof?.[json?'readJSON':'get'],'function');
 const read=proof[json?'readJSON':'get'](parentHash,ref,{parentPath});
 assert(read&&Buffer.isBuffer(read.data),'Proof reader must return retained bytes');
 assert.deepEqual(identity(read),identity(ref));assert.equal(read.data.length,ref.bytes);assert.equal(digest(read.data),ref.hash);
 if(json)assert.deepEqual(read.value,JSON.parse(read.data.toString('utf8')),'Parsed proof differs from retained JSON');
 return read;
}
function zeroNetwork(counters){object(counters);assert(Object.keys(counters).length>0&&Object.values(counters).every(value=>value===0),'Actual zero network counters required');}

const spec=(id,width,height,lossless,pattern,tags)=>Object.freeze({id,width,height,lossless,
 compression:lossless?'lossless':'lossy',hasAlpha:pattern==='gradient-alpha',pattern,tags:Object.freeze(tags)});
export const ALPHA_FIXTURE_SPECS=Object.freeze([
 spec('white16x16lossless',16,16,true,'white',['white','small']),
 spec('oversized-lossless',5120,5120,true,'white',['white','oversized-area']),
 spec('oversized-lossy',5120,5120,false,'white',['white','oversized-area']),
 spec('color-lossy-alpha',33,17,false,'gradient-alpha',['color','overlap','alpha']),
 spec('color-lossless-alpha',33,17,true,'gradient-alpha',['color','overlap','alpha']),
 spec('oversized-lossy-color',8193,3,false,'gradient-alpha',['color','oversized-axis','page-crossing','alpha']),
 spec('oversized-lossless-color',8193,3,true,'gradient-alpha',['color','oversized-axis','page-crossing','alpha']),
]);
export const ALPHA_FIXTURE_ALIASES=Object.freeze({white:'white16x16lossless',white16x16lossless:'white16x16lossless',
 lossless:'oversized-lossless',oversizedLossless:'oversized-lossless',lossy:'oversized-lossy',cancellation:'oversized-lossless'});
function fixtureOptions(specification){return {quality:specification.lossless?100:91,alphaQuality:100,lossless:specification.lossless,
 nearLossless:false,smartSubsample:false,smartDeblock:false,effort:4,minSize:false,mixed:false,preset:'default',exact:true};}

function safePath(path){relativeReference({path,bytes:1,hash:'sha256:'+'0'.repeat(64)});return path;}
function verifyRetainedEncoder(candidate,record,hold){
 exact(record,['schemaVersion','kind','codecId','authority','files','profiles','packageLock','packageManifest','nodeBinary','versions','node','zlib','platform','arch','nativeBinding','nativeLibraries','options']);
 const selected={
  'darwin-arm64':['MAC','identity.ts'],
  'linux-arm64':['LINUX_ARM64','identities/linux-arm64-v1.ts'],
  'linux-x64':['LINUX_X64','identities/linux-x64-v1.ts'],
 }[candidate.platform+'-'+candidate.arch];
 assert(selected,'Unsupported retained encoder platform');const [alias,module]=selected;
 const authority=candidate.baseCodecAuthority,registryPath='server/raster/codec-platform.ts',sourcePath='server/raster/'+module;
 assert.equal(authority.platform,candidate.platform);assert.equal(authority.arch,candidate.arch);assert.match(authority.codecId,HASH);
 assert(Array.isArray(authority.inputs)&&authority.inputs.length===2);assert.deepEqual(authority.inputs.map(row=>row.path),[registryPath,sourcePath]);
 for(const row of authority.inputs)reference(row);
 const metadata=ref=>{assert(ref.bytes<=8*1024*1024,'Retained encoder metadata exceeds 8 MiB');return hold(ref).data.toString('utf8');};
 assert.equal(record.schemaVersion,1);assert.equal(record.kind,'webp-fixture-encoder-v1');
 assert(record.authority&&Array.isArray(record.authority.inputs)&&record.authority.inputs.length===2);
 const authorityInputs=record.authority.inputs;
 for(const ref of authorityInputs)exact(ref,['repositoryPath','path','bytes','hash']);
 assert.deepEqual(record.authority,{codecId:authority.codecId,platform:authority.platform,arch:authority.arch,inputs:authorityInputs});
 assert.deepEqual(authorityInputs.map(ref=>({path:ref.repositoryPath,...identity(ref)})),authority.inputs,'Retained encoder authority differs from candidate');
 const registry=metadata(authorityInputs[0]),source=metadata(authorityInputs[1]);
 // Parse the whole generated module as a constrained JSON declaration. Never
 // import it, eval it, or recover an arbitrary executable expression.
 const literal=source.match(/^(?:[ \t]*(?:\/\/[^\r\n]*)?\r?\n)*export const CODECS = (\{[\s\S]*\}) as const;\r?\nexport const CODEC_ID = (['"])(sha256:[a-f0-9]{64})\2;\r?\n?$/);
 assert(literal,'Unsupported generated codec identity source');const codecs=JSON.parse(literal[1]),codecId=literal[3];
 assert.equal(digest(JSON.stringify(codecs)),codecId,'CODECS literal differs from CODEC_ID');assert.equal(codecs.schemaVersion,1);
 assert.equal(codecId,authority.codecId);assert.equal(record.codecId,codecId);assert.equal(codecs.platform,candidate.platform);assert.equal(codecs.arch,candidate.arch);
 const moduleImport='./'+module.replace(/\.ts$/,'.js');
 assert(registry.includes(`import { CODECS as ${alias}_CODECS, CODEC_ID as ${alias}_CODEC_ID } from '${moduleImport}';`),'Retained registry omits selected codec import');
 assert(registry.includes(`{ codecs: ${alias}_CODECS, codecId: ${alias}_CODEC_ID }`),'Retained registry omits selected codec inventory entry');
 for(const key of ['node','zlib','platform','arch','versions'])assert.deepEqual(record[key],codecs[key],'Retained encoder '+key+' differs from CODECS');
 assert(Array.isArray(codecs.files)&&codecs.files.length>0&&Array.isArray(record.files));
 const expectedFiles=new Map(),actualFiles=new Map();
 for(const row of codecs.files){
  safePath(row.path);assert(row.path.startsWith('node_modules/'));assert(!expectedFiles.has(row.path),'Duplicate CODECS file');reference(row);expectedFiles.set(row.path,identity(row));
 }
 for(const ref of record.files){
  exact(ref,['repositoryPath','path','bytes','hash']);
  safePath(ref.repositoryPath);assert(!actualFiles.has(ref.repositoryPath),'Duplicate retained codec file');
  assert.deepEqual(expectedFiles.get(ref.repositoryPath),identity(ref),'Retained codec file is missing, extra, or differs');hold(ref);actualFiles.set(ref.repositoryPath,ref);
 }
 assert.deepEqual([...actualFiles.keys()].sort(),[...expectedFiles.keys()].sort(),'Retained CODECS file set differs');
 assert(codecs.profiles&&typeof codecs.profiles==='object');assert.deepEqual(Object.keys(codecs.profiles).sort(),['p3','srgb']);
 assert(Array.isArray(record.profiles)&&record.profiles.length===2);const profileNames=new Set();
 for(const ref of record.profiles){
  exact(ref,['name','repositoryPath','path','bytes','hash']);
  assert(['p3','srgb'].includes(ref.name)&&!profileNames.has(ref.name),'Unknown or duplicate retained ICC profile');profileNames.add(ref.name);
  assert.equal(ref.repositoryPath,'tooling/raster/'+ref.name+'.icc');positive(codecs.profiles[ref.name].bytes);assert.match(codecs.profiles[ref.name].hash,HASH);
  assert.deepEqual(identity(ref),identity(codecs.profiles[ref.name]));hold(ref);
 }
 assert.equal(record.packageLock?.repositoryPath,'package-lock.json');assert.equal(record.packageManifest?.repositoryPath,'package.json');
 for(const ref of [record.packageLock,record.packageManifest])exact(ref,['repositoryPath','path','bytes','hash']);
 const lock=JSON.parse(metadata(record.packageLock)),packageJSON=JSON.parse(metadata(record.packageManifest));
 assert(lock.packages&&typeof lock.packages==='object');assert(Array.isArray(codecs.packages)&&codecs.packages.length>0);
 const packages=new Set();let sharpVersion;
 for(const {name,...expected}of codecs.packages){
  safePath(name);assert(!packages.has(name),'Duplicate CODECS package');packages.add(name);
  assert.deepEqual(lock.packages['node_modules/'+name],expected,'Retained package lock differs for '+name);
  assert(actualFiles.has('node_modules/'+name+'/package.json'),'Retained package manifest missing');if(name==='sharp')sharpVersion=expected.version;
 }
 assert.equal(typeof sharpVersion,'string');assert.equal(packageJSON.dependencies?.sharp,sharpVersion);assert.equal(lock.packages['']?.dependencies?.sharp,sharpVersion);
 object(record.nodeBinary);assert.equal(record.nodeBinary.sourcePath,undefined,'Absolute executable source paths are not portable evidence');
 exact(record.nodeBinary,['executableName','path','bytes','hash',...(Object.hasOwn(record.nodeBinary,'repositoryPath')?['repositoryPath']:[])]);
 if(Object.hasOwn(record.nodeBinary,'repositoryPath'))safePath(record.nodeBinary.repositoryPath);
 safePath(record.nodeBinary.executableName);assert.equal(basename(record.nodeBinary.executableName),record.nodeBinary.executableName,'Executable name must be a basename');hold(record.nodeBinary);
 const bindings=[...actualFiles.values()].filter(ref=>ref.repositoryPath.endsWith('.node'));
 const libraries=[...actualFiles.values()].filter(ref=>/^libvips(?:-cpp)?[.-]/.test(basename(ref.repositoryPath))&&/\.(?:dylib|so(?:\.[0-9.]+)?|dll)$/.test(ref.repositoryPath));
 assert.equal(bindings.length,1);assert.equal(libraries.length,1);assert.deepEqual(record.nativeBinding,bindings[0]);assert.deepEqual(record.nativeLibraries,libraries);
 assert.deepEqual(record.options,{cache:false,concurrency:1,authorityExecution:false,installedLoader:'createRequire(repository/package.json)',preloadedCodecModules:false});
}

function verifyFixtureCode(manifest,hostClosure,driverFiles,hold){
 const prefix='artifacts/oversized-import-staging/webp/',driver=new Map(),source=new Map(),compiled=new Map();
 for(const [rows,map]of [[driverFiles,driver],[hostClosure.sourceFiles,source],[hostClosure.compiledFiles,compiled]]){
  assert(Array.isArray(rows)&&rows.length>0);for(const row of rows){safePath(row.repositoryPath);assert(!map.has(row.repositoryPath),'Duplicate accepted closure file');assert(Number.isSafeInteger(row.bytes)&&row.bytes>=0);assert.match(row.hash,HASH);map.set(row.repositoryPath,identity(row));}
 }
 const expected=[
  ...['contract.mjs','io.mjs','source.mjs','parser.mjs','encoder.mjs','generate.mjs','index.mjs'].map(name=>({role:'generator',repositoryPath:prefix+'host-campaigns-v3/fixtures/'+name})),
  ...['fixtures.mjs','common.mjs','dependencies.mjs','producer-policy.mjs','native-gate-contract.mjs'].map(name=>({role:'host-contract',repositoryPath:prefix+'host-campaigns-v3/'+name})),
  ...['artifacts/oversized-import-staging/jpeg/host-campaigns/fixtures.mjs','artifacts/oversized-import-staging/jpeg/host-campaigns/common.mjs','tooling/raster/generate-memory-fixtures.mjs'].map(repositoryPath=>({role:'adaptation-provenance',repositoryPath})),
 ];
 assert(Array.isArray(manifest.producer));assert.deepEqual(manifest.producer.map(({role,repositoryPath})=>({role,repositoryPath})),expected,'Fixture producer membership differs from frozen generator');
 for(const row of manifest.producer){
  exact(row,['role','repositoryPath','path','bytes','hash']);
  if(row.repositoryPath.startsWith(prefix))assert.deepEqual(identity(row),driver.get(row.repositoryPath.slice(prefix.length)),'Fixture producer differs from reviewed driver');
  else if(row.repositoryPath.startsWith('tooling/'))assert.deepEqual(identity(row),source.get(row.repositoryPath),'Fixture recipe differs from accepted host source');
  // The two JPEG references are expressly attribution only in the frozen
  // generator. They are held as data, never granted executable authority.
  hold(row);
 }
 assert(Array.isArray(manifest.parser)&&manifest.parser.length>0&&manifest.parser.length<=hostClosure.sourceFiles.length+hostClosure.compiledFiles.length);
 const parserModules=new Map(),parserSources=new Map(),entries={container:'dist/local/server/raster/container.js',metadata:'dist/local/server/raster/webp-metadata.js'};
 for(const row of manifest.parser){
  exact(row,['repositoryPath','role','path','bytes','hash']);safePath(row.repositoryPath);relativeReference(row);
  if(row.role==='source'){
   assert(!parserSources.has(row.repositoryPath),'Duplicate retained parser source');assert.deepEqual(identity(row),source.get(row.repositoryPath),'Parser source differs from accepted host closure');parserSources.set(row.repositoryPath,row);
  }else{
   assert(['container','metadata','dependency'].includes(row.role));assert(row.repositoryPath.startsWith('dist/local/')&&row.repositoryPath.endsWith('.js'));
   assert.equal(row.role,Object.keys(entries).find(role=>entries[role]===row.repositoryPath)??'dependency','Parser entry role differs');
   assert(!parserModules.has(row.repositoryPath),'Duplicate retained parser module');assert.deepEqual(identity(row),compiled.get(row.repositoryPath),'Parser module differs from accepted host closure');parserModules.set(row.repositoryPath,row);
  }
 }
 assert.deepEqual([...parserSources.keys()].sort(),[...parserModules.keys()].map(path=>path.slice('dist/local/'.length).replace(/\.js$/,'.ts')).sort(),'Retained parser sources do not exactly cover its modules');
 const visited=new Set();
 function visit(path){
  if(visited.has(path))return;const row=parserModules.get(path);assert(row,'Retained parser import is missing');visited.add(path);
  assert(row.bytes<=8*1024*1024,'Parser metadata exceeds 8 MiB');const text=hold(row).data.toString('utf8');
  assert(!/\bimport\s*\(/.test(text),'Unexpected dynamic import in retained parser');
  for(const match of text.matchAll(/\b(?:import|export)\s+(?:[^;]*?\s+from\s*)?['"]([^'"\n]+)['"]/g)){
   const specifier=match[1];if(specifier.startsWith('node:'))continue;assert(specifier.startsWith('.'),'Unexpected package in retained parser');
   const next=posix.normalize(posix.join(posix.dirname(path),specifier));assert(next.startsWith('dist/local/'),'Retained parser import leaves closure');visit(next);
  }
 }
 for(const path of Object.values(entries))visit(path);
 assert.deepEqual([...visited].sort(),[...parserModules.keys()].sort(),'Unreachable extra module in retained parser');for(const row of parserSources.values())hold(row);
}

// This only reads container/chunk headers. There is no codec invocation,
// entropy decoding, image-sized output allocation, or captured-code import.
function inspectEncodedFixture(data){
 const length=data.length,read=(offset,bytes)=>{
  assert(Number.isSafeInteger(offset)&&Number.isSafeInteger(bytes)&&bytes>0&&bytes<=10&&offset>=0&&offset+bytes<=length,'Truncated WebP header');
  return data.subarray(offset,offset+bytes);
 };
 assert(length>=20);assert.equal(read(0,4).toString('latin1'),'RIFF');assert.equal(read(8,4).toString('latin1'),'WEBP');assert.equal(read(4,4).readUInt32LE()+8,length);
 let at=12,width,height,canvas,flags=null,intrinsicAlpha=false,image,alphaIndex=-1,imageIndex=-1,index=0;
 const seen=new Set();
 while(at<length){
  assert(index<4,'Unexpected fixture chunks');const header=read(at,8),type=header.toString('latin1',0,4),size=header.readUInt32LE(4),end=at+8+size+size%2;
  assert(end<=length&&!seen.has(type),'Invalid or repeated WebP chunk');seen.add(type);assert(['VP8X','VP8 ','VP8L','ALPH'].includes(type),'Fixture must be untagged, static WebP');
  if(size%2)assert.equal(read(end-1,1)[0],0,'Nonzero RIFF padding');
  if(type==='VP8X'){
   assert.equal(index,0);assert.equal(size,10);const bytes=read(at+8,10);flags=bytes[0];assert.equal(flags&~16,0);assert.equal(bytes.readUIntLE(1,3),0);
   canvas={width:bytes.readUIntLE(4,3)+1,height:bytes.readUIntLE(7,3)+1};
  }else if(type==='ALPH'){
   assert(size>0);assert(flags!==null&&(flags&16)!==0);const flagsByte=read(at+8,1)[0];assert.equal(flagsByte&0xc0,0);assert((flagsByte&3)<=1);assert(((flagsByte>>>4)&3)<=1);alphaIndex=index;
  }else{
   assert(!image,'Multiple images');image={type,offset:at+8,length:size};imageIndex=index;
   if(type==='VP8 '){assert(size>=10);const bytes=read(at+8,10);assert.equal(bytes[0]&1,0);assert(bytes.subarray(3,6).equals(Buffer.from([157,1,42])));width=bytes.readUInt16LE(6)&16383;height=bytes.readUInt16LE(8)&16383;}
   else{assert(size>=5);const bytes=read(at+8,5);assert.equal(bytes[0],47);const bits=bytes.readUInt32LE(1);assert.equal(bits>>>29,0);width=(bits&16383)+1;height=((bits>>>14)&16383)+1;intrinsicAlpha=Boolean((bits>>>28)&1);}
  }
  at=end;index++;
 }
 assert.equal(at,length);assert(image&&width>0&&height>0);if(canvas)assert.deepEqual(canvas,{width,height});
 if(alphaIndex!==-1){assert.equal(image.type,'VP8 ');assert.equal(alphaIndex+1,imageIndex);}
 const hasAlpha=intrinsicAlpha||alphaIndex!==-1;if(flags!==null)assert.equal(Boolean(flags&16),hasAlpha);
 return {width,height,compression:image.type==='VP8L'?'lossless':'lossy',lossless:image.type==='VP8L',hasAlpha,
  orientation:1,icc:false,exif:false,alphaChunk:alphaIndex!==-1,descriptor:{image}};
}
function verifyProceduralSource(data,specification){
 const rowBytes=specification.width*4;assert(rowBytes<=65536);assert.equal(data.length,rowBytes*specification.height);
 // The original independent recipe is reproduced one bounded row at a time.
 const expected=Buffer.alloc(rowBytes);if(specification.pattern==='white')expected.fill(255);
 for(let y=0;y<specification.height;y++){
  if(specification.pattern!=='white')for(let x=0;x<specification.width;x++){
   const at=x*4,a=[0,1,32,127,254,255][(x+3*y)%6];
   expected[at]=a?(37*x+17*y)%256:0;expected[at+1]=a?(11*x+61*y)%256:0;expected[at+2]=a?(53*x+7*y)%256:0;expected[at+3]=a;
  }
  assert(data.subarray(y*rowBytes,(y+1)*rowBytes).equals(expected),'Raw source differs from independent procedural pixels');
 }
}

/** Read all references through the trusted capsule reader. The supplied
 * manifest is already read from proofRef; the parsed candidate is data only. */
export function extractStrictAlphaFixtures(rawFixtureManifest,proofRef,proof,{candidate:acceptedCandidate,hostClosure,driverFiles}){
 reference(proofRef);const manifest=rawFixtureManifest;
 exact(manifest,['schemaVersion','kind','status','qualification','candidateHash','sourceHash','candidate','aliases','fixtures','encoder','parser','producer','license','accounting','derivation']);
 assert.equal(manifest.schemaVersion,1);assert.equal(manifest.kind,'webp-host-fixtures-v1');assert.equal(manifest.status,'generated');assert.equal(manifest.qualification,false);
 assert.match(manifest.candidateHash,HASH);assert.match(manifest.sourceHash,HASH);assert.equal(relativeReference(manifest.candidate).hash,manifest.candidateHash);
 assert.deepEqual(manifest.aliases,ALPHA_FIXTURE_ALIASES);assert(Array.isArray(manifest.fixtures));assert.equal(manifest.fixtures.length,ALPHA_FIXTURE_SPECS.length);
 for(const key of ['license','accounting','derivation'])assert(typeof manifest[key]==='string'&&manifest[key].length>0);
 const references=new Map();
 function hold(ref){
  relativeReference(ref);const wanted=identity(ref),previous=references.get(ref.path);
  if(previous)assert.deepEqual(previous,wanted,'Conflicting fixture references');
  // Retain identities only. Opaque encoder binaries and raw source buffers
  // become collectible immediately after their individual check completes.
  const read=retained(proof,proofRef.hash,ref,proofRef.path);references.set(ref.path,wanted);return read;
 }
 assert(manifest.candidate.bytes<=8*1024*1024,'Fixture candidate metadata exceeds 8 MiB');const candidate=JSON.parse(hold(manifest.candidate).data.toString('utf8'));
 assert.deepEqual(candidate,acceptedCandidate,'Fixture candidate differs from accepted candidate');
 assert.equal(candidate.source.hash,manifest.sourceHash);assert.equal(candidate.baseCodecAuthority.codecId,manifest.encoder.codecId);
 verifyRetainedEncoder(candidate,manifest.encoder,hold);assert.equal(manifest.encoder.node,'26.10.0');
 verifyFixtureCode(manifest,hostClosure,driverFiles,hold);
 const names=new Set(),sourcePatterns=new Map();
 for(const row of manifest.fixtures){
  assert(!names.has(row.id),'Duplicate fixture');names.add(row.id);const expected=ALPHA_FIXTURE_SPECS.find(item=>item.id===row.id);assert(expected,'Unknown fixture');
  exact(row,['id','path','bytes','hash','width','height','compression','lossless','hasAlpha','orientation','icc','exif','alphaChunk','descriptor','tags','source','encoderOptions',...(expected.pattern==='white'?['independentExpected']:[])]);
  assert.equal(row.path,row.id+'.webp');for(const key of ['width','height','compression','lossless','hasAlpha'])assert.equal(row[key],expected[key],'Fixture '+row.id+' '+key);
  assert.equal(row.orientation,1);assert.equal(row.icc,false);assert.equal(row.exif,false);assert.equal(row.alphaChunk,expected.hasAlpha&&!expected.lossless);
  exact(row.descriptor,['image']);exact(row.descriptor.image,['type','offset','length']);assert.equal(row.descriptor.image.type,expected.lossless?'VP8L':'VP8 ');
  positive(row.descriptor.image.offset);positive(row.descriptor.image.length);assert(row.descriptor.image.offset>=20&&row.descriptor.image.offset+row.descriptor.image.length<=row.bytes);
  for(const [key,value]of Object.entries(inspectEncodedFixture(hold(row).data)))assert.deepEqual(row[key],value,'Stored fixture observation differs: '+row.id+' '+key);
  assert.deepEqual(row.tags,expected.tags);assert.deepEqual(row.encoderOptions,fixtureOptions(expected));
  exact(row.source,['pattern','rgbaHash','raw','png','procedure','rowBytes','maximumIOChunkBytes']);
  assert.equal(row.source.pattern,expected.pattern);assert.equal(row.source.procedure,'bounded-rgba-row-file-filter0-png-v1');
  assert.equal(row.source.rowBytes,expected.width*4);assert.equal(row.source.maximumIOChunkBytes,65536);assert.equal(row.source.raw.bytes,expected.width*expected.height*4);
  assert.match(row.source.rgbaHash,HASH);assert.equal(row.source.rgbaHash,row.source.raw.hash);assert.notEqual(row.source.png.path,row.source.raw.path);
  hold(row.source.png);
  const sourceKey=[expected.width,expected.height,expected.pattern].join(':');
  if(sourcePatterns.has(row.source.raw.path)){assert.equal(sourcePatterns.get(row.source.raw.path),sourceKey,'Shared raw source has conflicting dimensions or recipe');assert.deepEqual(references.get(row.source.raw.path),identity(row.source.raw),'Conflicting shared raw source identity');}
  else{verifyProceduralSource(hold(row.source.raw).data,expected);sourcePatterns.set(row.source.raw.path,sourceKey);}
  if(expected.pattern==='white')assert.equal(row.independentExpected,'uniform-white-rgba8');
 }
 assert.deepEqual([...names].sort(),ALPHA_FIXTURE_SPECS.map(row=>row.id).sort());
 const aliases=Object.fromEntries(Object.entries(ALPHA_FIXTURE_ALIASES).map(([alias,id])=>[alias,manifest.fixtures.find(row=>row.id===id)]));
 return {...aliases,candidateHash:manifest.candidateHash,sourceHash:manifest.sourceHash,manifestHash:proofRef.hash,manifestBytes:proofRef.bytes,
  manifestPath:proofRef.path,fixtures:manifest.fixtures,encoder:manifest.encoder,
  attributionOnly:manifest.producer.filter(row=>row.repositoryPath.startsWith('artifacts/oversized-import-staging/jpeg/')).map(row=>({...row}))};
}

/** The caller separately verifies the nine-role qualification, parent command,
 * request, compiler/loader closure, and pinned driver. This preserves all six
 * frozen host-gate rules and binds their nested observations to retained bytes. */
export function validateAlphaHostReceipts({candidate,candidateHash,qualification,receipts,receiptRefs,campaign,campaignHash,fixtures,authorizationHash,proof}){
 assert.match(candidateHash,HASH);assert.match(campaignHash,HASH);assert.match(authorizationHash,HASH);
 assert(receipts instanceof Map&&receiptRefs instanceof Map);assert.equal(fixtures.candidateHash,candidateHash);assert.equal(fixtures.sourceHash,candidate.source.hash);
 assert.equal(fixtures.manifestHash,campaign.fixtureManifest.hash);assert.equal(fixtures.manifestBytes,campaign.fixtureManifest.bytes);
 for(const owner of [qualification,campaign]){
  assert(Array.isArray(owner.evidence));assert.deepEqual(owner.evidence.filter(ref=>ALPHA_HOST_ROLES.includes(ref.role)).map(ref=>ref.role),ALPHA_HOST_ROLES);
  assert.equal(owner.candidateHash,candidateHash);assert.equal(owner.artifactHash,candidate.artifact.hash);assert.match(owner.hostSourceHash,HASH);
 }
 assert.equal(qualification.hostSourceHash,campaign.hostSourceHash);
 const original=campaign.loader.closureEvidence.original;assert.match(original.sourceHash,HASH);assert.match(original.compiledHash,HASH);
 const acceptedAuthorization=campaign.loader.candidateAuthorization;
 assert.equal(acceptedAuthorization.authorizationHash,authorizationHash);assert.equal(acceptedAuthorization.candidateHash,candidateHash);
 assert.equal(acceptedAuthorization.sourceHash,candidate.source.hash);assert.equal(acceptedAuthorization.qualified,false);
 const receiptHashes=new Set();
 for(const role of ALPHA_HOST_ROLES){
  const receipt=receipts.get(role),receiptRef=reference(receiptRefs.get(role)),qRef=qualification.evidence.find(ref=>ref.role===role),campaignRef=campaign.evidence.find(ref=>ref.role===role);
  assert.equal(receiptRef.role,role);assert.deepEqual(identity(receiptRef),identity(qRef));assert(!receiptHashes.has(receiptRef.hash),'Distinct host receipt bytes required');receiptHashes.add(receiptRef.hash);
  const heldReceipt=retained(proof,campaignHash,campaignRef,undefined,{json:true});
  assert.equal(heldReceipt.path,receiptRef.path);assert.deepEqual(identity(heldReceipt),identity(receiptRef));assert.deepEqual(heldReceipt.value,receipt,'Receipt differs from captured campaign bytes');
  assert.equal(receipt.schemaVersion,1);assert.equal(receipt.kind,'webp-advanced-'+role+'-v1');assert.equal(receipt.status,'passed');
  assert.equal(receipt.candidateHash,candidateHash);assert.equal(receipt.artifactHash,candidate.artifact.hash);assert.equal(receipt.hostSourceHash,qualification.hostSourceHash);
  assert.equal(receipt.environment.platform,candidate.platform);assert.equal(receipt.environment.arch,candidate.arch);assert.equal(receipt.environment.node,'26.10.0');
  assert.equal(receipt.qualificationIssued,false);assert.equal(receipt.candidateAuthorization.authorizationHash,authorizationHash);assert.equal(receipt.candidateAuthorization.qualified,false);
  assert.deepEqual(receipt.candidateAuthorization,acceptedAuthorization);assert.deepEqual(receipt.effectiveClosure,campaign.loader.closureEvidence);
  assert.equal(receipt.executionScope,'reviewed-candidate-only-transformed-host-closure');assert.equal(receipt.completeSourceHash,original.sourceHash);assert.equal(receipt.originalCompiledHash,original.compiledHash);
  assert(receipt.effectiveClosure&&receipt.effectiveClosure.qualified===false);zeroNetwork(receipt.networkCounters);
  const fixtureRead=retained(proof,receiptRef.hash,receipt.fixtureManifest,receiptRef.path,{json:true});assert.equal(fixtureRead.path,fixtures.manifestPath);assert.equal(fixtureRead.hash,fixtures.manifestHash);assert.equal(fixtureRead.bytes,fixtures.manifestBytes);
  // role-child appends child.logs() and role-returned logs; the frozen driver
  // can repeat the same retained log. Repeats must bind identical bytes.
  assert(Array.isArray(receipt.logs)&&receipt.logs.length>0);const logs=new Map();
  for(const log of receipt.logs){reference(log);if(logs.has(log.path))assert.deepEqual(logs.get(log.path),identity(log),'Conflicting retained host logs');else logs.set(log.path,identity(log));retained(proof,receiptRef.hash,log,receiptRef.path);}
  assert(Array.isArray(receipt.cases));assert.deepEqual(receipt.cases.map(row=>row.id),alphaHostRoleCases(role));
  for(const row of receipt.cases){assert.equal(row.status,'passed-case');positive(row.completedChecks);assert(Number.isFinite(row.elapsedMs)&&row.elapsedMs>=0);}
  assert.equal(receipt.completedCases,receipt.cases.length);assert.equal(receipt.completedChecks,receipt.cases.reduce((n,row)=>n+row.completedChecks,0));positive(receipt.completedChecks);
  if(role.endsWith('-resources')){
   assert.equal(receipt.measurement,'whole-process-rss');assert.equal(receipt.capBytes,512*1048576);assert(Array.isArray(receipt.observations)&&receipt.observations.length===RESOURCE_CASES.length);
   const jobs=receipt.observations.map((ref,index)=>{
    const read=retained(proof,receiptRef.hash,ref,receiptRef.path,{json:true});assert.deepEqual(read.value,ref.observation,'Inline resource observation differs from retained raw bytes');
    const caseName=RESOURCE_CASES[index],fixture=fixtures[caseName.includes('lossless')?'lossless':'lossy'];assert(fixture?.descriptor?.image,'Held actual fixture descriptor required');
    assert.equal(read.value.process.platform,candidate.platform);assert.equal(read.value.process.arch,candidate.arch);
    return validateResourceObservation(read.value,{role,caseName,fixture,candidateHash,artifactHash:candidate.artifact.hash,
     haloProofHash:acceptedAuthorization.haloAuthorization.proof.hash,authorizationHash});
   });
   const summary=summarizeResourceJobs(jobs);for(const [key,value]of Object.entries(summary))assert.deepEqual(receipt[key],value,'Resource aggregate differs: '+key);
  }
 }
 return receipts;
}
