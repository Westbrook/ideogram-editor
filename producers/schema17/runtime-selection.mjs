/** Executed only by the explicit fresh Linux build under the original guard. */
import assert from 'node:assert/strict';
import {readFile,writeFile,lstat,realpath} from 'node:fs/promises';
import {resolve,join,sep,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const [product,output]=process.argv.slice(2);
assert([product,output].every(value=>typeof value==='string'&&isAbsolute(value)));
assert.equal(process.platform,'linux');assert(['x64','arm64'].includes(process.arch));assert.equal(process.versions.node,'26.10.0');
assert(globalThis.__storeNetworkCounters,'Preserved no-network preload required');
const root=await realpath(product);assert.equal(root,resolve(product));
const {CODECS,CODEC_ID}=await import(pathToFileURL(join(root,'dist/local/server/raster/codec-platform.js')));
const {CURRENT_RASTER_PROFILE}=await import(pathToFileURL(join(root,'dist/local/server/raster/profile-registry.js')));
assert.equal(CODECS.platform,'linux');assert.equal(CODECS.arch,process.arch);assert.equal(CURRENT_RASTER_PROFILE.platform,'linux');assert.equal(CURRENT_RASTER_PROFILE.arch,process.arch);
const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const entries=CODECS.files;assert(Array.isArray(entries)&&entries.length>0&&entries.length<=1000);
const codecFiles=[];
for(const expected of entries){
 const path=expected.path;
 assert(path.startsWith('node_modules/')&&!path.split('/').includes('..'));
 const name=join(root,path);assert.equal(await realpath(name),name);const s=await lstat(name);assert(s.isFile()&&s.nlink===1&&s.size<=64*1024**2);
 const bytes=await readFile(name);assert(bytes.length<=64*1024**2);assert.equal(bytes.length,expected.bytes);assert.equal(hash(bytes),expected.hash);
 codecFiles.push({path,hash:expected.hash,byteLength:String(expected.bytes)});
}
const trees=['dist/app','dist/local','src/text','vendor/raster','tooling/raster','node_modules/@img/colour','node_modules/sharp','node_modules/detect-libc','node_modules/semver',
 `node_modules/@img/sharp-linux-${process.arch}`,`node_modules/@img/sharp-libvips-linux-${process.arch}`,'.rollback'];
const files=['package.json','package-lock.json','vendor/text/manifest.json','node_modules/fs-ext/package.json','node_modules/fs-ext/fs-ext.js','node_modules/fs-ext/build/Release/fs_ext.node',
 'node_modules/canvaskit-wasm/package.json','node_modules/canvaskit-wasm/bin/canvaskit.js','node_modules/canvaskit-wasm/bin/canvaskit.wasm','node_modules/canvaskit-wasm/LICENSE'];
for(const path of codecFiles.map(row=>row.path))assert(trees.some(tree=>path.startsWith(tree+'/'))||files.includes(path),'Codec file omitted from selected runtime');
const effects=globalThis.__storeNetworkCounters.read();assert(Object.values(effects).every(value=>value===0));
await writeFile(output,JSON.stringify({kind:'linux-rollback-runtime-selection-1',platform:{os:'linux',arch:process.arch},node:process.versions.node,runtime:process.versions,
 profiles:{codecId:CODEC_ID,raster:CURRENT_RASTER_PROFILE},includes:[...new Set([...trees,...files])].sort(),codecFiles,effects:0})+'\n',{flag:'wx',mode:0o600});
