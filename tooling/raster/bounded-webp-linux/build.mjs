import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const producer = dirname(fileURLToPath(import.meta.url));
const root = resolve(producer, '../../..');
const previousProducer = join(root, 'tooling/raster/bounded-webp');
const previousVendor = join(root, 'vendor/raster/bounded-webp/1.6.0-ideogram.1');
const version = '1.6.0-ideogram.2-linux';
const sourceName = 'libwebp-1.6.0.tar.gz';
const sourceHash = 'sha256:e4ab7009bf0629fd11982d4c2aa83964cf244cffba7347ecd39019a9e38c4564';
const previousManifestHash = 'sha256:35313df37b2e04891212bf8c89de85068383372ce68830cfa9e4ff3a70628453';
const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const identity = path => { const bytes = readFileSync(path); return {bytes:bytes.length,hash:hash(bytes)}; };
const check = (path, expected) => assert.deepEqual(identity(path), {bytes:expected.bytes,hash:expected.hash}, path);
const mode = process.argv[2] ?? '--verify';
assert(['--verify', '--adopt'].includes(mode), 'Use --verify or --adopt');
assert.equal(process.platform, 'linux', 'Run this producer inside the documented Linux build environment');
assert(['arm64','x64'].includes(process.arch), 'Supported producer architectures: arm64, x64');
assert.equal(process.versions.node, '26.10.0');
assert.match(process.env.IE_BOUNDED_WEBP_BUILD_IMAGE ?? '', /^sha256:[a-f0-9]{64}$/, 'Retain and supply the immutable builder image ID');
const target = `linux-${process.arch}`;
const vendor = join(root, 'vendor/raster/bounded-webp', version, target);
const artifactName = 'libideogram-webp.so.1';
const environment = {PATH:'/usr/bin:/bin',LC_ALL:'C',TZ:'UTC',SOURCE_DATE_EPOCH:'0',ZERO_AR_DATE:'1'};
const run = (command, args, cwd = root) => {
  const out = spawnSync(command, args, {cwd,encoding:'utf8',env:{...environment,TMPDIR:cwd}});
  assert.equal(out.status, 0, `${command} ${args.join(' ')}\n${out.stdout ?? ''}${out.stderr ?? ''}`);
  return out.stdout.trim();
};
const previousBytes = readFileSync(join(previousVendor,'manifest.json'));
assert.equal(hash(previousBytes), previousManifestHash, 'The macOS producer seal is an immutable source input');
const previous = JSON.parse(previousBytes);
assert.equal(hash(readFileSync(join(previousVendor,sourceName))), sourceHash);
const inheritedNames = ['allocator-redirect.h','bounded-webp.h','allocator-test.c','color.c','color.h','color-test.c'];
for (const name of inheritedNames) check(join(previousProducer,name), previous.producerInputs.find(input => input.path === name));
const sourceBefore = readFileSync(join(previousProducer,'bounded-webp.c'),'utf8');
check(join(previousProducer,'bounded-webp.c'), previous.producerInputs.find(input => input.path === 'bounded-webp.c'));
const expectedSource = sourceBefore.replace(
  '#if !defined(__APPLE__) || !defined(__aarch64__)\n#error This sealed producer is qualified only for Darwin arm64.\n#endif',
  '#if !defined(__linux__) || !(defined(__aarch64__) || defined(__x86_64__))\n#error This producer requires a separately sealed Linux arm64 or x64 build.\n#endif');
assert.notEqual(expectedSource, sourceBefore);
assert.equal(readFileSync(join(producer,'bounded-webp.c'),'utf8'), expectedSource, 'Only the reviewed local platform guard differs');

const scalar = previous.compiledUpstreamMembers.map(member => member.path).filter(path => !path.endsWith('_neon.c'));
const simd = ['alpha_processing','dec','filters','lossless','rescaler','upsampling','yuv'].map(name => `src/dsp/${name}_${process.arch === 'arm64' ? 'neon' : 'sse2'}.c`);
const sources = [...scalar,...simd].sort();
const flags = ['-O2','-DNDEBUG','-std=c11','-D_DEFAULT_SOURCE','-D_FILE_OFFSET_BITS=64',
  '-fPIC','-fvisibility=hidden','-fno-ident','-ffile-prefix-map=.=.',
  '-DWEBP_EXTERN=extern __attribute__((visibility("hidden")))',
  '-UWEBP_USE_THREAD','-UHAVE_CONFIG_H','-Isource','-Iproducer'];
const linkFlags = ['-shared','-Wl,-z,defs','-Wl,-z,relro','-Wl,-z,now',
  '-Wl,--build-id=sha1','-Wl,--version-script=producer/exports.map',`-Wl,-soname,${artifactName}`];
const localNames = ['build.mjs','bounded-webp.c','exports.map','verify.py','verify-seal.mjs','README.txt','Dockerfile','Dockerfile.dockerignore'];
const inputs = [
  ...localNames.map(name => ({path:`tooling/raster/bounded-webp-linux/${name}`,...identity(join(producer,name))})),
  ...inheritedNames.map(name => ({path:`tooling/raster/bounded-webp/${name}`,...identity(join(previousProducer,name))})),
  {path:'tooling/raster/bounded-webp/bounded-webp.c',...identity(join(previousProducer,'bounded-webp.c'))},
  {path:'vendor/raster/bounded-webp/1.6.0-ideogram.1/manifest.json',...identity(join(previousVendor,'manifest.json'))},
];
const workspace = mkdtempSync(join(realpathSync(tmpdir()),'ie-linux-webp-'));
let completed = false;
try {
  const compiler = '/usr/bin/gcc';
  const tools = ['gcc','as','ld','nm','readelf'].map(name => {
    const path = realpathSync(`/usr/bin/${name}`);
    return {name,path,...identity(path),version:run(path,['--version']).split('\n')[0]};
  });
  const cc1 = run(compiler,['-print-prog-name=cc1']);
  tools.push({name:'cc1',path:cc1,...identity(cc1),version:run(compiler,['--version']).split('\n')[0]});
  const expectedExports = previous.exports.map(name => name.slice(1)).sort();
  function build(label) {
    const dir = join(workspace,label);
    mkdirSync(join(dir,'producer'),{recursive:true}); mkdirSync(join(dir,'objects'));
    run('/usr/bin/tar',['--no-same-owner','-xzf',join(previousVendor,sourceName),'-C',dir]);
    run('/usr/bin/mv',[join(dir,'libwebp-1.6.0'),join(dir,'source')]);
    for (const name of inheritedNames) cpSync(join(previousProducer,name),join(dir,'producer',name));
    for (const name of ['bounded-webp.c','exports.map']) cpSync(join(producer,name),join(dir,'producer',name));
    const commands = [], objects = [], allocatorImports = [];
    for (const [index,source] of [...sources,'producer/bounded-webp.c','producer/color.c'].entries()) {
      const upstream = source.startsWith('src/');
      const object = `objects/${index}.o`;
      const args = [...flags,...(upstream?['-include','producer/allocator-redirect.h']:[]),'-c',upstream?'source/'+source:source,'-o',object];
      run(compiler,args,dir); commands.push(args); objects.push(object);
      const imports = run('/usr/bin/nm',['-u',object],dir).split('\n').map(line => line.trim().split(/\s+/).at(-1)).filter(Boolean).sort();
      if (upstream) assert.deepEqual(imports.filter(name => /^(malloc|calloc|realloc|free|aligned_alloc|posix_memalign|mmap|mmap64|pthread_create|pthread_mutex_lock|dlopen)$/.test(name)),[],`Unbounded allocation/thread import: ${source}`);
      allocatorImports.push({source,imports:imports.filter(name=>/alloc|free|mmap|pthread|IEWebPBounded/.test(name))});
    }
    const args = [...linkFlags,...objects,'-o',artifactName];
    run(compiler,args,dir); commands.push(args);
    const exports = run('/usr/bin/nm',['-D','--defined-only',artifactName],dir).split('\n').map(line=>line.trim().split(/\s+/).at(-1)).filter(Boolean).sort();
    assert.deepEqual(exports,expectedExports,'Only the exact nine IE wrapper symbols may be exported');
    const imports = run('/usr/bin/nm',['-D','--undefined-only',artifactName],dir).split('\n').map(line=>line.trim().split(/\s+/).at(-1)).filter(Boolean).sort();
    assert(!imports.some(name=>/WebP|VP8|pthread|dlopen|^(malloc|calloc|realloc|free)(@|$)/.test(name)), 'No external codec, heap allocator, thread, or dynamic-loader dependency');
    const dynamic = run('/usr/bin/readelf',['-d',artifactName],dir);
    const dependencies = [...dynamic.matchAll(/\(NEEDED\).*?\[(.*?)\]/g)].map(match=>match[1]).sort();
    const glibcLoader = process.arch === 'arm64' ? 'ld-linux-aarch64.so.1' : 'ld-linux-x86-64.so.2';
    assert(dependencies.includes('libc.so.6') && dependencies.every(name=>name === 'libc.so.6' || name === glibcLoader), 'Only glibc and its architecture-specific ELF loader are allowed');
    assert(!/\((RPATH|RUNPATH)\)/.test(dynamic),'No build-directory or external lookup path');
    const members = sources.map(path=>({path,...identity(join(dir,'source',path))}));
    return {dir,objects,commands,exports,imports,dependencies,allocatorImports,members,artifact:readFileSync(join(dir,artifactName))};
  }
  const first = build('first'), second = build('second');
  assert(first.artifact.equals(second.artifact),'Two clean source extractions must produce identical complete ELF bytes');
  const allocatorCommand = [...flags,'producer/allocator-test.c',...first.objects.slice(0,sources.length),'-o','allocator-test'];
  run(compiler,allocatorCommand,first.dir);
  assert.equal(run(join(first.dir,'allocator-test'),[],first.dir),'allocator invariants passed');
  const colorCommand = [...flags,'producer/color-test.c','-o','color-test'];
  run(compiler,colorCommand,first.dir);
  assert.equal(run(join(first.dir,'color-test'),[],first.dir),'color lifetime invariants passed');
  // A separate unmodified upstream decoder is a differential oracle. It is not
  // installed into the product and does not share the bounded allocator.
  mkdirSync(join(first.dir,'oracle'));
  const oracleObjects = sources.map((source,index)=> {
    const output = `oracle/${index}.o`;
    run(compiler,[...flags.filter(flag=>!flag.startsWith('-DWEBP_EXTERN=')),'-c','source/'+source,'-o',output],first.dir);
    return output;
  });
  const oracle = join(first.dir,'oracle/libwebp-oracle.so');
  run(compiler,['-shared','-Wl,-z,defs',...oracleObjects,'-o',oracle],first.dir);
  const nativeResult = JSON.parse(run('/usr/bin/python3',[join(producer,'verify.py'),join(first.dir,artifactName),oracle,root],first.dir));
  assert.equal(nativeResult.status,'passed');
  const manifest = {
    schemaVersion:1,name:'ideogram-bounded-webp',version,platform:'linux',arch:process.arch,abiVersion:1,
    source:{url:previous.source.url,file:sourceName,...identity(join(previousVendor,sourceName)),upstreamVersion:'1.6.0',modifiedSourceFiles:[],license:'BSD-3-Clause',additionalPatentGrant:'PATENTS'},
    priorProducer:{version:previous.version,manifestHash:previousManifestHash,wrapperChange:'Only Darwin platform guard replaced with Linux arm64/x64 guard.'},
    build:{image:process.env.IE_BOUNDED_WEBP_BUILD_IMAGE,osRelease:readFileSync('/etc/os-release','utf8'),
      packages:run('/usr/bin/dpkg-query',['-W','-f=${Package}\t${Version}\t${Architecture}\n']),tools,
      compilerSpecsHash:hash(run(compiler,['-dumpspecs'])),environment:{...environment,TMPDIR:'<BUILD_DIRECTORY>'},
      compileFlags:flags,linkFlags,commands:first.commands,threading:'disabled',simd:process.arch==='arm64'?'arm64 NEON':'x64 SSE2',
      allocationPolicy:previous.build.allocationPolicy},
    producerInputs:inputs,compiledUpstreamMembers:first.members,
    notices:previous.notices,artifact:{path:artifactName,bytes:first.artifact.length,hash:hash(first.artifact)},
    exports:first.exports,imports:first.imports,dependencies:first.dependencies,allocatorImports:first.allocatorImports,
    allocatorSelfTest:{status:'passed',command:allocatorCommand},colorSelfTest:{status:'passed',command:colorCommand},nativeVerification:nativeResult,
    reproduction:{method:'Two fresh extraction/compile directories; compare complete ELF bytes including GNU build ID. No normalization.',byteIdentical:true},
  };
  const manifestText = JSON.stringify(manifest,null,2)+'\n';
  const generated = {abiVersion:1,version,platform:'linux',arch:process.arch,
    path:`vendor/raster/bounded-webp/${version}/${target}/${artifactName}`,
    bytes:first.artifact.length,hash:hash(first.artifact),sourceHash,manifestHash:hash(manifestText),producerHash:hash(JSON.stringify(inputs))};
  if (mode === '--adopt') {
    assert(!existsSync(vendor),'Never overwrite an existing versioned target; use --verify or a newly reviewed version');
    mkdirSync(vendor,{recursive:true});
    writeFileSync(join(vendor,artifactName),first.artifact);
    writeFileSync(join(vendor,'manifest.json'),manifestText);
    writeFileSync(join(vendor,'identity.json'),JSON.stringify(generated,null,2)+'\n');
    cpSync(join(previousVendor,sourceName),join(vendor,sourceName));
    for (const notice of previous.notices) { check(join(previousVendor,notice.path),notice); cpSync(join(previousVendor,notice.path),join(vendor,notice.path)); }
  } else {
    assert(first.artifact.equals(readFileSync(join(vendor,artifactName))),'Rebuilt binary differs from the sealed target');
    assert.equal(manifestText,readFileSync(join(vendor,'manifest.json'),'utf8'),'Source or build environment differs from the sealed target');
    assert.deepEqual(JSON.parse(readFileSync(join(vendor,'identity.json'),'utf8')),generated);
  }
  console.log(JSON.stringify({status:'passed',mode,identity:generated,allocator:'passed',color:'passed',nativeVerification:nativeResult,reproduction:'byte-identical'},null,2));
  completed = true;
} finally {
  if (completed) rmSync(workspace,{recursive:true,force:true});
  else console.error(`Failed native build workspace retained at ${workspace}`);
}
