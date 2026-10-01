import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {cpSync,existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {linuxColorIdentitySource} from './verify-seal.mjs';
import {verifyLinuxCodecsSeal} from '../linux-codecs/verify.mjs';
const root=resolve(import.meta.dirname,'../../..'),producer=import.meta.dirname,arch=process.arch;
const mode=process.argv[2]??'--verify';assert(['--adopt','--verify'].includes(mode));assert.equal(process.platform,'linux');assert(['arm64','x64'].includes(arch));assert.equal(process.versions.node,'26.10.0');
assert.match(process.env.IE_LINUX_COLOR_BUILD_IMAGE??'',/^sha256:[a-f0-9]{64}$/);
const hash=value=>'sha256:'+createHash('sha256').update(value).digest('hex');
const identify=path=>{const bytes=readFileSync(path);return {bytes:bytes.length,hash:hash(bytes)};};
const environment={PATH:'/usr/bin:/bin',LC_ALL:'C',TZ:'UTC',SOURCE_DATE_EPOCH:'0',ZERO_AR_DATE:'1'};
const run=(command,args,cwd=root,env=environment)=>{const out=spawnSync(command,args,{cwd,encoding:'utf8',env:{...env,TMPDIR:cwd}});assert.equal(out.status,0,`${command} ${args.join(' ')}\n${out.stdout??''}${out.stderr??''}`);return out.stdout.trim();};
const codec=verifyLinuxCodecsSeal(),artifactName='libideogram-linux-color.so.1',vendor=join(root,'vendor/raster/linux-color/1.0.0',`linux-${arch}`);
const names=['color.c','color.h','color-test.c','build.mjs','verify.mjs','verify-seal.mjs','README.txt','exports.map'];
const inputs=names.map(name=>({path:`tooling/raster/linux-color/${name}`,...identify(join(producer,name))}));
const sourceInputs=['tests/raster/fixtures/color-oracle.json','tooling/raster/p3.icc','tooling/raster/srgb.icc'].map(path=>({path,...identify(join(root,path))}));
const flags=['-std=c11','-O2','-fPIC','-fvisibility=hidden','-fno-ident','-ffile-prefix-map=.=.','-Wall','-Wextra','-Werror'];
const linkFlags=['-shared','-Wl,-z,defs','-Wl,-z,relro','-Wl,-z,now','-Wl,--build-id=sha1','-Wl,--version-script=exports.map',`-Wl,-soname,${artifactName}`];
const workspace=mkdtempSync(join(realpathSync(tmpdir()),'ie-linux-color-build-'));let completed=false;
try{
  const compiler='/usr/bin/gcc';
  const tools=['gcc','as','ld','nm','readelf'].map(name=>{const path=realpathSync('/usr/bin/'+name);return{name,path,...identify(path),version:run(path,['--version']).split('\n')[0]};});
  const cc1=run(compiler,['-print-prog-name=cc1']);tools.push({name:'cc1',path:cc1,...identify(cc1),version:run(compiler,['--version']).split('\n')[0]});
  function build(label){const dir=join(workspace,label);mkdirSync(dir);for(const name of ['color.c','color.h','color-test.c','exports.map'])cpSync(join(producer,name),join(dir,name));run(compiler,[...flags,...linkFlags,'color.c','-o',artifactName],dir);run(compiler,[...flags,'color-test.c','-o','color-test'],dir);assert.equal(run(join(dir,'color-test'),[],dir),'linux color lifetime invariants passed');return{dir,bytes:readFileSync(join(dir,artifactName))};}
  const first=build('first'),second=build('second');assert(first.bytes.equals(second.bytes),'Two fresh builds must be byte-identical');
  const exports=run('/usr/bin/nm',['-D','--defined-only',artifactName],first.dir).split('\n').map(line=>line.trim().split(/\s+/).at(-1)).filter(Boolean).sort();assert.deepEqual(exports,['IELinuxColorABIVersion','IELinuxColorConvertRGBA']);
  const imports=run('/usr/bin/nm',['-D','--undefined-only',artifactName],first.dir).split('\n').map(line=>line.trim().split(/\s+/).at(-1)).filter(Boolean).sort();assert(!imports.some(name=>/vips|cms|WebP|pthread|dlopen|^(malloc|calloc|realloc|free)(@|$)/.test(name)));
  const dynamic=run('/usr/bin/readelf',['-d',artifactName],first.dir),dependencies=[...dynamic.matchAll(/\(NEEDED\).*?\[(.*?)\]/g)].map(match=>match[1]).sort();const loader=arch==='arm64'?'ld-linux-aarch64.so.1':'ld-linux-x86-64.so.2';assert(dependencies.every(name=>name==='libc.so.6'||name===loader));assert(!/\((RPATH|RUNPATH)\)/.test(dynamic));
  const checks=['bridge-first','vips-first'].map(order=>JSON.parse(run(process.execPath,[join(producer,'verify.mjs'),join(first.dir,artifactName),order],root,{...environment,PATH:'/workspace/.toolchain/bin:/usr/bin:/bin'})));
  const manifest={schemaVersion:1,name:'ideogram-linux-color',version:'1.0.0',platform:'linux',arch,abiVersion:1,codecIdentity:codec.codecIdentity,
    build:{image:process.env.IE_LINUX_COLOR_BUILD_IMAGE,osRelease:readFileSync('/etc/os-release','utf8'),packages:run('/usr/bin/dpkg-query',['-W','-f=${Package}\t${Version}\t${Architecture}\n']),tools,environment:{...environment,TMPDIR:'<BUILD_DIRECTORY>'},compileFlags:flags,linkFlags},producerInputs:inputs,sourceInputs,artifact:{path:artifactName,bytes:first.bytes.length,hash:hash(first.bytes)},exports,imports,dependencies,mockLifetimes:'passed',functionalChecks:checks,reproduction:{method:'Two fresh compile directories, exact complete ELF bytes including build ID.',byteIdentical:true}};
  const text=JSON.stringify(manifest,null,2)+'\n',identity={abiVersion:1,version:'1.0.0',platform:'linux',arch,path:`vendor/raster/linux-color/1.0.0/linux-${arch}/${artifactName}`,bytes:first.bytes.length,hash:hash(first.bytes),manifestHash:hash(text),producerHash:hash(JSON.stringify(inputs)),codecIdentity:codec.codecIdentity};
  const generated=join(root,`server/raster/linux-color-${arch}-identity.ts`);
  if(mode==='--adopt'){assert(!existsSync(vendor),'Never overwrite a sealed versioned target');mkdirSync(vendor,{recursive:true});writeFileSync(join(vendor,artifactName),first.bytes);writeFileSync(join(vendor,'manifest.json'),text);writeFileSync(join(vendor,'identity.json'),JSON.stringify(identity,null,2)+'\n');writeFileSync(generated,linuxColorIdentitySource(identity));}
  else{assert(first.bytes.equals(readFileSync(join(vendor,artifactName))));assert.equal(text,readFileSync(join(vendor,'manifest.json'),'utf8'));assert.equal(linuxColorIdentitySource(identity),readFileSync(generated,'utf8'));}
  console.log(JSON.stringify({status:'passed',mode,identity,reproduction:'byte-identical',mockLifetimes:'passed',functionalChecks:checks},null,2));completed=true;
}finally{if(completed)rmSync(workspace,{recursive:true,force:true});else console.error('Retained failed producer scratch: '+workspace);}
