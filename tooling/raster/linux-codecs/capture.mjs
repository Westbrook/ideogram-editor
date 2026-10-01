import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {existsSync,lstatSync,readFileSync,readdirSync,realpathSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

export const PRODUCER_VERSION='1.0.0';
export const PRODUCER_FILES=['capture.mjs','install.mjs','verify.mjs','expected-packages.json','expected-packages-x64.json','Dockerfile','Dockerfile.dockerignore','README.txt'];
export const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
export const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
export function expectedFor(arch=process.arch){assert(['arm64','x64'].includes(arch));return JSON.parse(readFileSync(join(root,`tooling/raster/linux-codecs/expected-packages${arch==='x64'?'-x64':''}.json`)));}
export const expected=expectedFor();
export const targetFor=(arch=process.arch)=>{expectedFor(arch);return join(root,`tooling/raster/linux-codecs/${PRODUCER_VERSION}/linux-${arch}`);};
export const generatedPathFor=(arch=process.arch)=>{expectedFor(arch);return join(root,`server/raster/identities/linux-${arch}-v1.ts`);};
export const target=targetFor(),generatedPath=generatedPathFor();
const originalMacHash='sha256:41788495dc59578314b09974051b717b9a28f47d118b16d1bd204dca147be81e';
export function identitySource(codecs){return '// Generated from the separately sealed Linux '+codecs.arch+' clean npm-ci profile.\nexport const CODECS = '+JSON.stringify(codecs,null,2)+' as const;\nexport const CODEC_ID = '+JSON.stringify(hash(JSON.stringify(codecs)))+';\n';}
export function fileIdentity(path){const bytes=readFileSync(join(root,path));return {path,bytes:bytes.length,hash:hash(bytes)};}
function inside(parent,child){return child===parent||child.startsWith(parent+sep);}
function directory(path){assert(lstatSync(path).isDirectory(),`Not a plain directory: ${path}`);assert.equal(realpathSync(path),path,`Symlinked directory: ${path}`);}
function walk(path){return readdirSync(path,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en')).flatMap(entry=>{const child=join(path,entry.name),stat=lstatSync(child);assert(!stat.isSymbolicLink(),`Symlink in codec package: ${child}`);if(stat.isDirectory())return walk(child);assert(stat.isFile(),`Not a plain file: ${child}`);return [relative(root,child).split(sep).join('/')];});}
export function producerInputs(){return PRODUCER_FILES.map(name=>fileIdentity('tooling/raster/linux-codecs/'+name));}
export function validateLock(arch=process.arch){
  const expected=expectedFor(arch);
  const lock=JSON.parse(readFileSync(join(root,'package-lock.json')));
  for(const {name,...record}of expected.packages)assert.deepEqual(lock.packages['node_modules/'+name],record,`Frozen lock identity changed: ${name}`);
  const mac=JSON.parse(readFileSync(join(root,'tooling/raster/codecs.json')));
  assert.equal(hash(JSON.stringify(mac)),originalMacHash,'Original macOS codec receipt changed');
  const originalSource='// Generated once from the sealed installed inputs; changes require fixture review.\nexport const CODECS = '+JSON.stringify(mac,null,2)+' as const;\nexport const CODEC_ID = '+JSON.stringify(originalMacHash).replaceAll('"',"'")+';\n';
  assert.equal(readFileSync(join(root,'server/raster/identity.ts'),'utf8'),originalSource,'Original macOS generated identity changed');
  for(const {name,version}of expected.packages){if(name.includes('-linux-'))continue;assert.equal(mac.packages.find(p=>p.name===name)?.version,version,`Linux/mac common dependency mismatch: ${name}`);}
  return lock;
}
export function captureInstalled(){
  assert.equal(process.platform,expected.platform);assert.equal(process.arch,expected.arch);assert.equal(process.versions.node,'26.10.0');
  assert.equal(process.report.getReport().header.glibcVersionRuntime?.split('.')[0],'2','Only glibc Linux is supported');
  validateLock();directory(join(root,'node_modules'));directory(join(root,'node_modules/@img'));
  const require=createRequire(join(root,'package.json')),resolutions=[];
  for(const item of expected.packages){
    const packageRoot=join(root,'node_modules',item.name);directory(packageRoot);
    const installed=JSON.parse(readFileSync(join(packageRoot,'package.json')));assert.equal(installed.name,item.name);assert.equal(installed.version,item.version);
    const specifier=item.name.startsWith('@img/sharp-libvips-')?item.name+'/binary':item.name.startsWith('@img/sharp-linux-')?item.name+'/sharp.node':item.name;
    const actual=require.resolve(specifier);assert.equal(realpathSync(actual),actual,`Symlinked resolution: ${specifier}`);assert(inside(packageRoot,actual),`Escaped resolution: ${specifier}`);
    resolutions.push({specifier,path:relative(root,actual).split(sep).join('/')});
  }
  assert(!existsSync(join(root,'node_modules/sharp/src/build')),'Local Sharp builds are not supported');
  const fromSharp=createRequire(require.resolve('sharp'));
  for(const specifier of ['@img/colour','detect-libc','semver',`@img/sharp-linux-${process.arch}/sharp.node`])assert.equal(fromSharp.resolve(specifier),require.resolve(specifier),`Nested Sharp dependency: ${specifier}`);
  const libc=require('detect-libc');assert.equal(libc.familySync(),'glibc');
  const sharp=require('sharp');assert.equal(sharp.versions.sharp,'0.35.4');assert.equal(sharp.versions.vips,'8.18.6');assert.equal(sharp.versions.webp,'1.6.0');assert.equal(sharp.versions.lcms,'2.19.1');
  const native=require.resolve(`@img/sharp-linux-${process.arch}/sharp.node`);assert(require.cache[native],`Sharp did not load the selected native binding: ${native}`);
  const loaded=process.report.getReport().sharedObjects.filter(path=>/libvips/.test(path)).map(path=>realpathSync(path));
  const library=realpathSync(require.resolve(`@img/sharp-libvips-linux-${process.arch}/binary`));
  assert(loaded.includes(library),'Sharp did not load the selected libvips binary');
  assert.deepEqual(loaded.filter(path=>/libvips/.test(path)),[library],'Unexpected additional libvips binary');
  const profiles=JSON.parse(readFileSync(join(root,'tooling/raster/profiles.json')));
  assert.deepEqual(profiles,JSON.parse(readFileSync(join(root,'tooling/raster/codecs.json'))).profiles,'Original frozen ICC identities changed');
  for(const [name,profile]of Object.entries(profiles)){const bytes=readFileSync(join(root,'tooling/raster/'+name+'.icc'));assert.equal(bytes.length,profile.bytes);assert.equal(hash(bytes),profile.hash);}
  const files=expected.packages.flatMap(item=>walk(join(root,'node_modules',item.name))).sort().map(fileIdentity);
  return {schemaVersion:1,packages:expected.packages,platform:process.platform,arch:process.arch,node:process.versions.node,zlib:process.versions.zlib,versions:sharp.versions,files,profiles,interfaces:JSON.parse(readFileSync(join(root,'tooling/raster/codecs.json'))).interfaces,
    producer:{name:'ideogram-linux-codecs',version:PRODUCER_VERSION,libc:'glibc',expectedPackages:hash(JSON.stringify(expected.packages)),originalMacCodecIdentity:originalMacHash},resolutions};
}
export function adopt(codecs,installation){
  assert(!existsSync(target),'Versioned Linux profile already exists; create a new producer version');
  assert(!existsSync(generatedPath),'Generated Linux profile already exists; adopt a new explicit version');
  mkdirSync(target,{recursive:true});mkdirSync(dirname(generatedPath),{recursive:true});
  const receipt={schemaVersion:1,codecIdentity:hash(JSON.stringify(codecs)),producerInputs:producerInputs(),installation,
    sourceInputs:['package.json','package-lock.json','tooling/toolchain.json','tooling/bootstrap-toolchain.py','tooling/raster/codecs.json','server/raster/identity.ts','tooling/raster/profiles.json','tooling/raster/p3.icc','tooling/raster/srgb.icc'].map(fileIdentity)};
  writeFileSync(join(target,'codecs.json'),JSON.stringify(codecs,null,2)+'\n',{flag:'wx'});
  writeFileSync(join(target,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  for(const name of ['package.json','package-lock.json'])writeFileSync(join(target,name),readFileSync(join(root,name)),{flag:'wx'});
  writeFileSync(generatedPath,identitySource(codecs),{flag:'wx'});
  return receipt;
}
