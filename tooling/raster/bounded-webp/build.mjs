import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const producer = dirname(fileURLToPath(import.meta.url));
const root = resolve(producer, '../../..');
const version = '1.6.0-ideogram.1';
const vendor = join(root, 'vendor/raster/bounded-webp', version);
const artifactDir = join(vendor, 'darwin-arm64');
const artifactName = 'libideogram-webp.1.dylib';
const sourceName = 'libwebp-1.6.0.tar.gz';
const sourceHash = 'sha256:e4ab7009bf0629fd11982d4c2aa83964cf244cffba7347ecd39019a9e38c4564';
const hash = b => 'sha256:' + createHash('sha256').update(b).digest('hex');
const fileIdentity = p => { const bytes = readFileSync(p); return {bytes:bytes.length, hash:hash(bytes)}; };
const run = (cmd, args, cwd = root) => {
  const out = spawnSync(cmd, args, {cwd, encoding:'utf8', env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL:'C', ZERO_AR_DATE:'1', TMPDIR:cwd===root?realpathSync(tmpdir()):cwd}});
  if (out.status !== 0) throw new Error(`${cmd} ${args.join(' ')}\n${out.stdout ?? ''}${out.stderr ?? ''}`);
  return out.stdout.trim();
};
assert.equal(process.platform, 'darwin');
assert.equal(process.arch, 'arm64');
assert.equal(process.versions.node, '26.10.0');
assert.equal(hash(readFileSync(join(vendor, sourceName))), sourceHash);
const clang = run('/usr/bin/xcrun', ['--find','clang']);
const sdk = run('/usr/bin/xcrun', ['--sdk','macosx','--show-sdk-path']);
const compiler = run(clang, ['--version']);
const sdkVersion = run('/usr/bin/xcrun', ['--sdk','macosx','--show-sdk-version']);
const sources = [
  ...['alpha','buffer','frame','idec','io','quant','tree','vp8','vp8l','webp'].map(n => `src/dec/${n}_dec.c`),
  ...['alpha_processing','cpu','dec','dec_clip_tables','filters','lossless','rescaler','upsampling','yuv',
      'alpha_processing_neon','dec_neon','filters_neon','lossless_neon','rescaler_neon','upsampling_neon','yuv_neon'].map(n => `src/dsp/${n}.c`),
  ...['bit_reader','color_cache','filters','huffman','quant_levels_dec','rescaler','random','thread'].map(n => `src/utils/${n}_utils.c`),
  'src/utils/palette.c', 'src/utils/utils.c'
].sort();
const compileFlags = ['-O2','-DNDEBUG','-std=c11','-arch','arm64','-mmacosx-version-min=14.0',
  '-isysroot','<SDK>','-fPIC','-fvisibility=hidden','-DWEBP_EXTERN=extern __attribute__((visibility("hidden")))',
  '-UWEBP_USE_THREAD','-UHAVE_CONFIG_H','-Isource','-Iproducer'];
const linkFlags = ['-dynamiclib','-arch','arm64','-mmacosx-version-min=14.0','-isysroot','<SDK>',
  '-Wl,-exported_symbols_list,producer/exports.txt',
  '-Wl,-install_name,@rpath/libideogram-webp.1.dylib','-Wl,-current_version,1.0.0','-Wl,-compatibility_version,1.0.0'];
const inputNames = ['allocator-redirect.h','bounded-webp.c','bounded-webp.h','exports.txt','allocator-test.c','build.mjs','color.c','color.h','color-test.c','README.txt','verify.py','verify-seal.mjs'];
const workspace = mkdtempSync(join(realpathSync(tmpdir()), 'ie-bounded-webp-'));
try {
  function build(name) {
    const dir = join(workspace, name);
    mkdirSync(join(dir,'producer'),{recursive:true}); mkdirSync(join(dir,'objects'));
    run('/usr/bin/tar',['xzf',join(vendor,sourceName),'-C',dir]);
    run('/bin/mv',[join(dir,'libwebp-1.6.0'),join(dir,'source')]);
    for (const input of inputNames) cpSync(join(producer,input),join(dir,'producer',input));
    const commands = [];
    const objects = [];
    const allocatorImports = [];
    for (const [i,source] of [...sources,'producer/bounded-webp.c','producer/color.c'].entries()) {
      const upstream = source.startsWith('src/');
      const args = [...compileFlags.map(v=>v==='<SDK>'?sdk:v),
        ...(upstream?['-include','producer/allocator-redirect.h']:[]),
        '-c',upstream?'source/'+source:source,'-o',`objects/${i}.o`];
      run(clang,args,dir); commands.push(args.map(v=>v===sdk?'<SDK>':v));
      const object = `objects/${i}.o`; objects.push(object);
      const imported = run('/usr/bin/nm',['-u',object],dir).split('\n').map(l=>l.trim()).filter(Boolean);
      const forbidden = imported.filter(s=>/_(malloc|calloc|realloc|free|aligned_alloc|posix_memalign|mmap|vm_allocate|pthread_create|pthread_mutex_lock|dlopen)$/.test(s));
      if (upstream) assert.deepEqual(forbidden,[],`Unbounded allocator or thread import in ${source}`);
      allocatorImports.push({source, imports:imported.filter(s=>/alloc|free|mmap|pthread|IEWebPBounded/.test(s))});
    }
    const args = [...linkFlags.map(v=>v==='<SDK>'?sdk:v),...objects,'-o',artifactName];
    run(clang,args,dir); commands.push(args.map(v=>v===sdk?'<SDK>':v));
    const exports = run('/usr/bin/nm',['-gU',artifactName],dir).split('\n').map(s=>s.trim().split(/\s+/).at(-1)).filter(Boolean).sort();
    const intended = readFileSync(join(producer,'exports.txt'),'utf8').trim().split('\n').sort();
    assert.deepEqual(exports,intended,'Only the IE wrapper ABI may be exported');
    const imports = run('/usr/bin/nm',['-u',artifactName],dir).split('\n').map(s=>s.trim()).filter(Boolean).sort();
    assert(!imports.some(s=>/WebP|VP8|pthread|dlopen|vm_allocate/.test(s)), 'No external codec, thread or dynamic-loader dependency');
    const dependencies = run('/usr/bin/otool',['-L',artifactName],dir).split('\n').slice(1).map(s=>s.trim());
    assert.equal(dependencies.length,2,'Only install identity and libSystem dependency');
    assert(dependencies[1].startsWith('/usr/lib/libSystem.B.dylib '));
    const allocationSourceCalls = [];
    for (const source of sources) {
      const text = readFileSync(join(dir,'source',source),'utf8');
      text.split('\n').forEach((line,index)=> {
        if (/\b(malloc|calloc|realloc|free|alloca|aligned_alloc|posix_memalign|mmap)\s*\(/.test(line)) allocationSourceCalls.push({source,line:index+1,text:line.trim()});
      });
    }
    const members = sources.map(path=>({path,...fileIdentity(join(dir,'source',path))}));
    return {dir,artifact:readFileSync(join(dir,artifactName)),commands,exports,imports,dependencies,allocatorImports,allocationSourceCalls,members};
  }
  const first = build('first');
  const allocatorTestArgs = [...compileFlags.map(v=>v==='<SDK>'?sdk:v),
    'producer/allocator-test.c',...sources.map((_,i)=>`objects/${i}.o`),'-o','allocator-test'];
  run(clang,allocatorTestArgs,first.dir);
  assert.equal(run(join(first.dir,'allocator-test'),[],first.dir),'allocator invariants passed');
  const diagnostic = spawnSync(join(first.dir,'allocator-test'),[join(root,'tests/raster/fixtures/max-webp-lossless.webp')],{encoding:'utf8'});
  assert.equal(diagnostic.status,0,diagnostic.stderr);
  writeFileSync(join(root,'artifacts/bounded-webp-allocation-diagnostic.txt'),diagnostic.stderr);
  const colorTestArgs = [...compileFlags.map(v=>v==='<SDK>'?sdk:v),'producer/color-test.c','-o','color-test'];
  run(clang,colorTestArgs,first.dir);
  assert.equal(run(join(first.dir,'color-test'),[],first.dir),'color lifetime invariants passed');
  if (process.argv.includes('--diagnostic')) {
    run(clang,[...compileFlags.map(v=>v==='<SDK>'?sdk:v),'-DIE_WEBP_TEST_ALLOCATIONS','-c','producer/bounded-webp.c','-o','objects/diagnostic.o'],first.dir);
    const debugLibrary = join(root,'artifacts/libideogram-webp-debug.dylib');
    run(clang,[...linkFlags.map(v=>v==='<SDK>'?sdk:v),...sources.map((_,i)=>`objects/${i}.o`),'objects/diagnostic.o',`objects/${sources.length+1}.o`,'-o',debugLibrary],first.dir);
    const probe = spawnSync('python3',[join(producer,'verify.py'),'oracle-first'],{encoding:'utf8',env:{...process.env,BOUNDED_WEBP_LIBRARY:debugLibrary}});
    writeFileSync(join(root,'artifacts/bounded-webp-dylib-diagnostic.txt'),probe.stderr+probe.stdout);
  }
  const second = build('second');
  assert(first.artifact.equals(second.artifact), 'Two clean builds must be byte-identical');
  const manifest = {
    schemaVersion:1, name:'ideogram-bounded-webp', version, platform:'darwin',arch:'arm64',abiVersion:1,
    source:{url:'https://storage.googleapis.com/downloads.webmproject.org/releases/webp/'+sourceName,
      file:sourceName,...fileIdentity(join(vendor,sourceName)),upstreamVersion:'1.6.0',modifiedSourceFiles:[],
      license:'BSD-3-Clause', additionalPatentGrant:'PATENTS'},
    build:{compiler,sdkVersion,minimumMacOS:'14.0',compilerBinary:fileIdentity(clang),
      environment:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LC_ALL:'C',ZERO_AR_DATE:'1',TMPDIR:'<BUILD_DIRECTORY>'},
      compileFlags,linkFlags,commands:first.commands,threading:'disabled',simd:'arm64 NEON',
      allocationPolicy:'All upstream C translation units substitute malloc/calloc/realloc/free after libc declarations. Each live block charges its exact anonymous mmap length rounded to 16 KiB including its aligned header, plus 64 bytes per block, before mapping. mmap/munmap avoid unbounded malloc-cache reuse. Runtime OS pages must divide 16 KiB. Realloc charges both old and new until copy/free. Calls are serialized; the cap belongs to one decoder lifetime. External input/output, the 64 KiB stack input chunk, kernel mapping metadata and process/runtime memory require separate accounting. Color conversion has a separate 96 KiB stack scratch buffer and fixed-profile CMM allocation reserve.'},
    notices:['COPYING','PATENTS','AUTHORS'].map(path=>({path,...fileIdentity(join(first.dir,'source',path))})),
    producerInputs:inputNames.map(path=>({path,...fileIdentity(join(producer,path))})),
    compiledUpstreamMembers:first.members,artifact:{path:'darwin-arm64/'+artifactName,bytes:first.artifact.length,hash:hash(first.artifact)},
    exports:first.exports,imports:first.imports,dependencies:first.dependencies,
    allocatorImports:first.allocatorImports,allocationSourceCalls:first.allocationSourceCalls,
    allocatorSelfTest:{status:'passed',command:allocatorTestArgs.map(v=>v===sdk?'<SDK>':v)},
    colorSelfTest:{status:'passed',command:colorTestArgs.map(v=>v===sdk?'<SDK>':v)},
    reproduction:{method:'Two fresh extraction and compile directories; exact byte comparison including Mach-O code signature. No normalization.',byteIdentical:true}
  };
  const manifestText=JSON.stringify(manifest,null,2)+'\n';
  const mode=process.argv[2]??'--verify';
  assert(['--verify','--adopt'].includes(mode),'Use --verify or --adopt');
  if(mode==='--adopt') {
    mkdirSync(artifactDir,{recursive:true});
    writeFileSync(join(artifactDir,artifactName),first.artifact);
    for(const notice of ['COPYING','PATENTS','AUTHORS']) cpSync(join(first.dir,'source',notice),join(vendor,notice));
    writeFileSync(join(vendor,'manifest.json'),manifestText);
    const identity={abiVersion:1,version,platform:'darwin',arch:'arm64',
      path:relative(root,join(artifactDir,artifactName)),bytes:first.artifact.length,hash:hash(first.artifact),
      sourceHash,manifestHash:hash(manifestText),producerHash:hash(JSON.stringify(manifest.producerInputs))};
    writeFileSync(join(root,'server/raster/webp-identity.ts'),
      '// Generated by tooling/raster/bounded-webp/build.mjs --adopt; do not edit.\nexport const BOUNDED_WEBP = '+JSON.stringify(identity,null,2)+' as const;\n');
  } else {
    assert(first.artifact.equals(readFileSync(join(artifactDir,artifactName))),'Rebuilt native artifact differs from sealed artifact');
    assert.equal(manifestText,readFileSync(join(vendor,'manifest.json'),'utf8'),'Producer/source/toolchain identity differs from seal');
  }
  console.log(JSON.stringify({status:'passed',mode,artifact:manifest.artifact,source:manifest.source.file,
    sourceHash:manifest.source.hash,compiledSources:sources.length,byteIdentical:true,exports:first.exports,manifestHash:hash(manifestText)},null,2));
} finally { rmSync(workspace,{recursive:true,force:true}); }
