import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const platformProducer = dirname(fileURLToPath(import.meta.url));
const producer = resolve(platformProducer,'../webp-output');
const root = resolve(producer, '../../..');
const version = '1.0.0-ideogram.1';
const mode = process.argv[2] ?? '--verify';
assert(['--verify','--adopt'].includes(mode), 'Use --verify or --adopt');
assert.equal(process.versions.node, '26.10.0');
const target = `${process.platform}-${process.arch}`;
assert(['darwin-arm64','linux-arm64','linux-x64'].includes(target));
assert.equal(process.platform,'linux','This inherited producer targets Linux only');
const linux = true;
if (linux) assert.match(process.env.IE_WEBP_OUTPUT_BUILD_IMAGE ?? '', /^sha256:[a-f0-9]{64}$/, 'Retain the exact Linux builder image');
const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const identity = path => { const bytes=readFileSync(path); return {bytes:bytes.length,hash:hash(bytes)}; };
const check = (path, expected) => assert.deepEqual(identity(path), {bytes:expected.bytes,hash:expected.hash}, path);
const dependencies = JSON.parse(readFileSync(join(producer,'dependencies.json'))).profiles.find(profile => `${profile.platform}-${profile.arch}` === target);
assert(dependencies, 'A sealed decoder and converter must already exist for this target');
check(join(root,dependencies.decoder.path), dependencies.decoder);
check(join(root,dependencies.converter.path), dependencies.converter);
const vendor = join(root,'vendor/raster/webp-output',version,target);
const artifactName = linux ? 'libideogram-webp-output.so.1' : 'libideogram-webp-output.1.dylib';
const environment = {PATH:linux?'/usr/bin:/bin':'/usr/bin:/bin:/usr/sbin:/sbin',LC_ALL:'C',TZ:'UTC',SOURCE_DATE_EPOCH:'0',ZERO_AR_DATE:'1'};
const run = (command, args, cwd = root) => {
  const result=spawnSync(command,args,{cwd,encoding:'utf8',env:{...environment,TMPDIR:cwd===root?realpathSync(tmpdir()):cwd}});
  assert.equal(result.status,0,`${command} ${args.join(' ')}\n${result.stdout??''}${result.stderr??''}`);
  return result.stdout.trim();
};
const compiler = linux ? '/usr/bin/gcc' : run('/usr/bin/xcrun',['--find','clang']);
const sdk = linux ? null : run('/usr/bin/xcrun',['--sdk','macosx','--show-sdk-path']);
const sdkVersion = linux ? null : run('/usr/bin/xcrun',['--sdk','macosx','--show-sdk-version']);
const flags = ['-O2','-DNDEBUG','-std=c11','-D_FILE_OFFSET_BITS=64','-fPIC','-fvisibility=hidden','-Wall','-Wextra','-Werror',
  ...(linux?['-D_DEFAULT_SOURCE','-fno-ident']:['-arch','arm64','-mmacosx-version-min=14.0','-isysroot','<SDK>'])];
const linkFlags = linux
  ? ['-shared','-Wl,-z,defs','-Wl,-z,relro','-Wl,-z,now','-Wl,--build-id=sha1','-Wl,--version-script=producer/exports.map',`-Wl,-soname,${artifactName}`]
  : ['-dynamiclib','-arch','arm64','-mmacosx-version-min=14.0','-isysroot','<SDK>','-Wl,-exported_symbols_list,producer/exports.txt',`-Wl,-install_name,@rpath/${artifactName}`,'-Wl,-current_version,1.0.0','-Wl,-compatibility_version,1.0.0'];
const actual = args => args.map(value => value === '<SDK>' ? sdk : value);
const inputNames = ['webp-output.c','webp-output.h','bridge-test.c','exports.txt','exports.map','dependencies.json','build.mjs','verify.py','verify-seal.mjs','README.txt','NOTICE.txt'];
const producerInputs = inputNames.map(path=>({path,...identity(join(producer,path))}));
const priorManifestPath = join(root,'vendor/raster/webp-output',version,'darwin-arm64/manifest.json');
const priorManifestHash = 'sha256:44468404dc9c2ca6f7dfd6538e6753b3fc3cff2e45196299d0a560ed938abe57';
assert.equal(hash(readFileSync(priorManifestPath)),priorManifestHash,'Inherited Darwin producer remains immutable');
const priorManifest = JSON.parse(readFileSync(priorManifestPath));
assert.deepEqual(producerInputs,priorManifest.producerInputs,'Use exactly the frozen common source and producer inputs');
const platformProducerInputs = ['build.mjs','verify-seal.mjs','README.txt','bridge-test.c'].map(path=>({path,...identity(join(platformProducer,path))}));
const expectedExports = ['IEWebPOutputABIVersion','IEWebPDecodeToFile','IEWebPConvertFileRGBA'].sort();
const workspace = mkdtempSync(join(realpathSync(tmpdir()),'ie-webp-output-'));
let complete = false;
try {
  function build(label) {
    const dir=join(workspace,label); mkdirSync(join(dir,'producer'),{recursive:true});
    for (const path of inputNames) cpSync(join(producer,path),join(dir,'producer',path));
    cpSync(join(platformProducer,'bridge-test.c'),join(dir,'producer/bridge-test.c'));
    const compile=[...flags,'-c','producer/webp-output.c','-o','webp-output.o'];
    run(compiler,actual(compile),dir);
    const link=[...linkFlags,'webp-output.o','-o',artifactName]; run(compiler,actual(link),dir);
    const exports=run('/usr/bin/nm',linux?['-D','--defined-only',artifactName]:['-gU',artifactName],dir)
      .split('\n').filter(Boolean).map(line=>line.trim().split(/\s+/).at(-1).replace(linux?/^$/:/^_/,'')).sort();
    assert.deepEqual(exports,expectedExports,'Only the three transport ABI functions may be exported');
    const imports=run('/usr/bin/nm',linux?['-D','--undefined-only',artifactName]:['-u',artifactName],dir)
      .split('\n').filter(Boolean).map(line=>line.trim().split(/\s+/).at(-1)).sort();
    assert(!imports.some(name=>/WebP|VP8|pthread|dlopen|(^|_)(malloc|calloc|realloc|free)(@|$)/.test(name)), 'No decoder, converter, allocator, thread or dynamic loader dependency');
    let needed;
    if (linux) {
      const dynamic=run('/usr/bin/readelf',['-d',artifactName],dir);
      needed=[...dynamic.matchAll(/\(NEEDED\).*?\[(.*?)\]/g)].map(match=>match[1]).sort();
      const loader=process.arch==='arm64'?'ld-linux-aarch64.so.1':'ld-linux-x86-64.so.2';
      assert(needed.includes('libc.so.6') && needed.every(name=>name==='libc.so.6'||name===loader),'Only glibc and its architecture-specific ELF loader are allowed');
      assert(!/\((RPATH|RUNPATH)\)/.test(dynamic));
    } else {
      needed=run('/usr/bin/otool',['-L',artifactName],dir).split('\n').slice(1).map(line=>line.trim());
      assert.equal(needed.length,2); assert(needed[1].startsWith('/usr/lib/libSystem.B.dylib '));
    }
    return {dir,bytes:readFileSync(join(dir,artifactName)),commands:[compile,link],exports,imports,dependencies:needed};
  }
  const first=build('first'), second=build('second');
  assert(first.bytes.equals(second.bytes),'Two fresh output bridge builds must be byte-identical');
  const unitCommand=[...flags,'producer/bridge-test.c','-o','bridge-test'];
  run(compiler,actual(unitCommand),first.dir);
  assert.equal(run(join(first.dir,'bridge-test'),[],first.dir),'file output bridge invariants passed');
  const nativeVerification=JSON.parse(run(linux?'/usr/bin/python3':'/usr/bin/python3',
    [join(producer,'verify.py'),join(first.dir,artifactName),join(root,dependencies.decoder.path),root],first.dir));
  assert.equal(nativeVerification.status,'passed');
  const compilerInfo={path:realpathSync(compiler),...identity(realpathSync(compiler)),version:run(compiler,['--version'])};
  const buildEnvironment=linux
    ? {image:process.env.IE_WEBP_OUTPUT_BUILD_IMAGE,osRelease:readFileSync('/etc/os-release','utf8'),packages:run('/usr/bin/dpkg-query',['-W','-f=${Package}\t${Version}\t${Architecture}\n']),compilerSpecsHash:hash(run(compiler,['-dumpspecs']))}
    : {sdkVersion,minimumMacOS:'14.0'};
  const manifest={schemaVersion:1,name:'ideogram-webp-output',version,platform:process.platform,arch:process.arch,abiVersion:1,
    source:{path:'tooling/raster/webp-output/webp-output.c',...identity(join(producer,'webp-output.c')),role:'New repository-owned transport only; incorporates no third-party decoder/converter implementation. Existing native inputs retain their immutable licenses/notices. No new license grant is asserted.',notice:identity(join(producer,'NOTICE.txt'))},
    nativeInputs:dependencies,producerInputs,platformProducerInputs,
    priorProducer:{manifestHash:priorManifestHash,change:'Linux build recipe permits only glibc plus its matching ELF loader. Runtime C/header remain identical. Linux-only test snapshot explicitly advances mtime after a same-size write because automatic timestamp advancement within the test interval is not guaranteed by the container filesystem. This proves the stamp-change fence only; original failed tests remain preserved.'},
    build:{...buildEnvironment,compiler:compilerInfo,environment:{...environment,TMPDIR:'<BUILD_DIRECTORY>'},compileFlags:flags,linkFlags,commands:first.commands},
    artifact:{path:artifactName,bytes:first.bytes.length,hash:hash(first.bytes)},exports:first.exports,imports:first.imports,dependencies:first.dependencies,
    mappingPolicy:'One anonymous private page-rounded RGBA mapping per synchronous call; at most100000000 payload bytes. No pixel pointer escapes. All file I/O uses checked pread/pwrite requests <=65536 bytes. Output mapping is unmapped before return; failed munmap leaves the process-library lease closed. Caller separately reserves native decoder/color and runtime memory and fsyncs or removes its private output file.',
    invariants:{status:'passed',command:unitCommand},nativeVerification,
    reproduction:{method:'Two fresh compile directories; compare complete native bytes including Mach-O UUID/signature or ELF build ID. No normalization.',byteIdentical:true}};
  const manifestText=JSON.stringify(manifest,null,2)+'\n';
  const generated={abiVersion:1,version,platform:process.platform,arch:process.arch,
    path:`vendor/raster/webp-output/${version}/${target}/${artifactName}`,bytes:first.bytes.length,hash:hash(first.bytes),
    sourceHash:manifest.source.hash,manifestHash:hash(manifestText),producerHash:hash(JSON.stringify(producerInputs)),
    decoderHash:dependencies.decoder.hash,converterHash:dependencies.converter.hash,platformProducerHash:hash(JSON.stringify(platformProducerInputs))};
  if (mode==='--adopt') {
    assert(!existsSync(vendor),'Never replace a sealed target; verify it or choose a new version');
    mkdirSync(vendor,{recursive:true}); writeFileSync(join(vendor,artifactName),first.bytes);
    writeFileSync(join(vendor,'manifest.json'),manifestText);
    writeFileSync(join(vendor,'identity.json'),JSON.stringify(generated,null,2)+'\n');
    mkdirSync(join(root,'server/raster'),{recursive:true});
    writeFileSync(join(root,`server/raster/webp-output-${target}-identity.ts`),
      '// Generated from the sealed file output bridge; do not edit.\nexport const WEBP_OUTPUT_'+target.toUpperCase().replaceAll('-','_')+' = '+JSON.stringify(generated,null,2)+' as const;\n');
  } else {
    assert(first.bytes.equals(readFileSync(join(vendor,artifactName))),'Rebuilt bridge differs from its seal');
    assert.equal(manifestText,readFileSync(join(vendor,'manifest.json'),'utf8'),'Source, environment, manifest or validation differs from seal');
    assert.deepEqual(JSON.parse(readFileSync(join(vendor,'identity.json'),'utf8')),generated);
  }
  console.log(JSON.stringify({status:'passed',mode,identity:generated,invariants:'passed',nativeVerification,reproduction:'byte-identical'},null,2));
  complete=true;
} finally {
  if (complete) rmSync(workspace,{recursive:true,force:true});
  else console.error(`Failed producer workspace retained: ${workspace}`);
}
