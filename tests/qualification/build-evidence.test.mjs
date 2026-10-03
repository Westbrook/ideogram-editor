import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,realpathSync,renameSync,symlinkSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {gzipSync} from 'node:zlib';
import {transformWithOxc} from 'vite';
import {D11_INVOCATION_DEPENDENCY_PATHS} from '../../tooling/qualification/campaigns/browser-d11-invocation-contract.mjs';

const source=readFileSync(new URL('../../tooling/build-evidence.ts',import.meta.url),'utf8');
const transformed=await transformWithOxc(source,'tooling/build-evidence.ts');
const {buildEvidence}=await import('data:text/javascript;base64,'+Buffer.from(transformed.code).toString('base64'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const hook=(plugin,name,context,...args)=>Reflect.apply(typeof plugin[name]==='function'?plugin[name]:plugin[name].handler,context,args);

function fixture(run,{beforeConfig,beforeStart,beforeGenerate,skipConfig=false}={}){
 const cwd=process.cwd(),root=realpathSync(mkdtempSync(join(tmpdir(),'ie-build-evidence-')));
 const put=(path,bytes)=>{const target=join(root,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,bytes);};
 try{
  for(const path of ['src/main.ts','src/text/worker.ts','index.html','vite.app.config.ts','tsconfig.json','tsconfig.app.json','package.json','package-lock.json','.progress-report/project.json','tooling/build-evidence.ts','tooling/theme/input.css','vendor/text/manifest.json'])put(path,'fixture '+path);
  // Arbitrary bounded bytes test the plugin's provenance capture only. They do
  // not satisfy the reviewed invocation contract and never claim qualification.
  for(const path of D11_INVOCATION_DEPENDENCY_PATHS)put(path,'dependency fixture '+path);
  for(const path of ['node_modules/canvaskit-wasm/package.json','node_modules/canvaskit-wasm/bin/canvaskit.js','node_modules/canvaskit-wasm/bin/canvaskit.wasm'])put(path,'native fixture '+path);
  process.chdir(root);
  const plugin=buildEvidence(true),bundle={
   'assets/index-test.js':{type:'chunk',fileName:'assets/index-test.js',code:'const entry=1;',isEntry:true,imports:[],dynamicImports:['assets/lazy-test.js'],modules:{}},
   'assets/lazy-test.js':{type:'chunk',fileName:'assets/lazy-test.js',code:'const lazy=1;',isEntry:false,imports:[],dynamicImports:[],modules:{}},
   'assets/index-test.css':{type:'asset',fileName:'assets/index-test.css',source:'body{color:#000}'},
  };
  const context={error(message){throw Error(message);},emitFile(asset){bundle[asset.fileName]={...asset};return asset.fileName;}};
  const config={root,configFile:join(root,'vite.app.config.ts'),configFileDependencies:['.progress-report/project.json','tooling/build-evidence.ts','vite.app.config.ts'].map(path=>join(root,path)),
   command:'build',mode:'production',isProduction:true,isWorker:false,devtools:false,env:{BASE_URL:'/',MODE:'production',DEV:false,PROD:true},
   inlineConfig:{root:undefined,base:undefined,mode:undefined,configFile:'vite.app.config.ts',configLoader:undefined,logLevel:undefined,clearScreen:undefined,build:{},worker:{},optimizeDeps:{}}};
  // Match Vite 8.3.1's harmless compatibility mutation of the original inline
  // options, including its enumerable getter rather than only a JSON clone.
  for(const name of ['build','worker','optimizeDeps']){
   const options=config.inlineConfig[name];options.rolldownOptions=undefined;
   Object.defineProperty(options,'rollupOptions',{get(){return this.rolldownOptions;},set(value){this.rolldownOptions=value;},configurable:true,enumerable:true});
  }
  const userConfig={plugins:[plugin],worker:{format:'iife',plugins:plugin.api.workerPlugins}};
  beforeConfig?.({root,put,plugin,bundle,context,config,userConfig});
  if(!skipConfig){hook(plugin,'config',context,userConfig,{command:'build',mode:'production'});hook(plugin,'configResolved',context,config);}
  const bytes=item=>Buffer.from(item.type==='chunk'?item.code:item.source);
  const write=()=>{for(const item of Object.values(bundle))put('dist/app/'+item.fileName,bytes(item));};
  beforeStart?.({root,put,plugin,bundle,context});
  hook(plugin,'buildStart',context);
  const worker=(workerBundle,{format='iife'}={})=>{
   const workerPlugin=plugin.api.workerPlugins()[0];
   hook(workerPlugin,'configResolved',context,{...config,isWorker:true,mainConfig:config,worker:{format:'iife'}});
   hook(workerPlugin,'generateBundle',context,{format},workerBundle);
  };
  beforeGenerate?.({root,put,plugin,bundle,context,worker});
  hook(plugin,'generateBundle',context,{dir:join(root,'dist/app')},bundle,true);
  return run({root,put,plugin,bundle,context,bytes,write,worker,finish:()=>hook(plugin,'writeBundle',context,{dir:join(root,'dist/app')},bundle)});
 }finally{process.chdir(cwd);rmSync(root,{recursive:true,force:true});}
}

test('application receipt captures final preload rewrite and final HTML/manifest bytes in writeBundle',()=>fixture(f=>{
 const provisional=JSON.parse(f.bundle['build-evidence.json'].source);assert.deepEqual(provisional.capture,{phase:'generateBundle',finalized:false});
 f.bundle['assets/index-test.js'].code+='const preload=["final","rewritten"];';
 f.bundle['assets/index-test.css'].source+='html{color:#111}';
 f.bundle['index.html']={type:'asset',fileName:'index.html',source:'<!doctype html><script src="/assets/index-test.js"></script>'};
 f.bundle['.vite/manifest.json']={type:'asset',fileName:'.vite/manifest.json',source:'{"index.html":{"file":"assets/index-test.js"}}'};
 f.write();f.finish();
 const receipt=JSON.parse(readFileSync(join(f.root,'dist/app/build-evidence.json')));
 assert.deepEqual(receipt.capture,{phase:'writeBundle',finalized:true});assert.deepEqual(receipt.sourceInputs,provisional.sourceInputs);
 assert.deepEqual(receipt.dependencyInputs,provisional.dependencyInputs);
 assert.deepEqual(receipt.compilation,provisional.compilation);
 assert.deepEqual(receipt.compilation,{schema:1,profile:'reviewed-vite-app-2',configFile:'vite.app.config.ts',configLoader:'bundle',command:'build',mode:'production',
  env:{BASE_URL:'/',MODE:'production',DEV:false,PROD:true},
  configInputs:receipt.sourceInputs.filter(input=>['.progress-report/project.json','tooling/build-evidence.ts','vite.app.config.ts'].includes(input.path)),
  inlineTransformOptions:'none',userPlugins:['consumer-build-evidence'],worker:{format:'iife',userPlugins:['consumer-worker-build-evidence']}});
 assert.deepEqual(receipt.dependencyInputs.map(input=>input.path),[...D11_INVOCATION_DEPENDENCY_PATHS]);
 assert.equal(receipt.dependencyInputs.length,53);
 assert(receipt.sourceInputs.every(input=>!input.path.startsWith('node_modules/')));
 for(const input of receipt.dependencyInputs){const bytes=readFileSync(join(f.root,input.path));assert.deepEqual(input,{path:input.path,bytes:bytes.length,sha256:hash(bytes)});}
 assert.equal(f.plugin.writeBundle.order,'post');assert.equal(f.plugin.writeBundle.sequential,true);
 assert(!receipt.outputs.some(output=>output.file==='build-evidence.json'));
 assert.equal(receipt.outputs.length,Object.keys(f.bundle).length-1);
 for(const output of receipt.outputs){const bytes=f.bytes(f.bundle[output.file]);assert.equal(output.bytes,bytes.length);assert.equal(output.sha256,hash(bytes));assert.equal(output.gzipBytes,gzipSync(bytes).length);}
 assert.equal(receipt.observations.D11.startupJsRawBytes,f.bytes(f.bundle['assets/index-test.js']).length+f.bytes(f.bundle['assets/lazy-test.js']).length);
 assert(receipt.observations.D11.startupJsRawBytes>provisional.observations.D11.startupJsRawBytes);
 assert.equal(f.bundle['build-evidence.json'].source,readFileSync(join(f.root,'dist/app/build-evidence.json'),'utf8'));
}));
test('application receipt rejects disk bytes that differ from the final owned bundle',()=>fixture(f=>{
 f.write();const changed=Buffer.from(f.bytes(f.bundle['assets/index-test.js']));changed[0]^=1;f.put('dist/app/assets/index-test.js',changed);
 assert.throws(f.finish,/Final bundle differs from emitted file/);assert.equal(JSON.parse(readFileSync(join(f.root,'dist/app/build-evidence.json'))).capture.finalized,false);
}));
test('application receipt rejects source changes made after generateBundle',()=>fixture(f=>{
 f.write();f.put('src/main.ts','late unbuilt source');assert.throws(f.finish,/Application inputs changed during the build/);
 assert.equal(JSON.parse(readFileSync(join(f.root,'dist/app/build-evidence.json'))).capture.finalized,false);
}));
test('application writeBundle requires its owned output directory and receipt',()=>fixture(f=>{
 f.write();assert.throws(()=>hook(f.plugin,'writeBundle',f.context,{},f.bundle),/requires an output directory/);
 delete f.bundle['build-evidence.json'];assert.throws(f.finish,/evidence asset is missing/);
}));
test('application receipt rejects same-length dependency changes made after generateBundle',()=>fixture(f=>{
 f.write();const path=D11_INVOCATION_DEPENDENCY_PATHS[0],changed=readFileSync(join(f.root,path));changed[0]^=1;f.put(path,changed);
 assert.throws(f.finish,/Application invocation dependencies changed during the build/);
 assert.equal(JSON.parse(readFileSync(join(f.root,'dist/app/build-evidence.json'))).capture.finalized,false);
}));
test('application receipt rejects a dependency removed after generateBundle',()=>fixture(f=>{
 f.write();rmSync(join(f.root,D11_INVOCATION_DEPENDENCY_PATHS[0]));assert.throws(f.finish,{code:'ENOENT'});
 assert.equal(JSON.parse(readFileSync(join(f.root,'dist/app/build-evidence.json'))).capture.finalized,false);
}));
test('application receipt rejects a symlink replacing a dependency with identical bytes',()=>fixture(f=>{
 f.write();const path=join(f.root,D11_INVOCATION_DEPENDENCY_PATHS[0]),target=join(f.root,'dependency-original.js');
 renameSync(path,target);symlinkSync(target,path,'file');
 assert.throws(f.finish,/bounded canonical ordinary file/);
 assert.equal(JSON.parse(readFileSync(join(f.root,'dist/app/build-evidence.json'))).capture.finalized,false);
}));
test('application receipt rejects a symlinked dependency ancestor with identical bytes',()=>fixture(f=>{
 f.write();const path=join(f.root,'node_modules/lit'),target=join(f.root,'lit-original');
 renameSync(path,target);symlinkSync(target,path,'dir');
 assert.throws(f.finish,/bounded canonical ordinary file/);
 assert.equal(JSON.parse(readFileSync(join(f.root,'dist/app/build-evidence.json'))).capture.finalized,false);
}));
test('application receipt rejects dependency bytes above the member bound before capture',()=>{
 assert.throws(()=>fixture(()=>assert.fail('oversized dependency reached generateBundle'),{
  beforeStart:f=>f.put(D11_INVOCATION_DEPENDENCY_PATHS[0],Buffer.alloc(64*1024+1)),
 }),/bounded canonical ordinary file/);
});
test('application receipt captures dependency bytes exactly at the member bound',()=>fixture(f=>{
 f.write();f.finish();const receipt=JSON.parse(readFileSync(join(f.root,'dist/app/build-evidence.json')));
 assert.deepEqual(receipt.dependencyInputs[0],{path:D11_INVOCATION_DEPENDENCY_PATHS[0],bytes:64*1024,sha256:hash(Buffer.alloc(64*1024))});
},{beforeStart:f=>f.put(D11_INVOCATION_DEPENDENCY_PATHS[0],Buffer.alloc(64*1024))}));
test('application module provenance preserves nested installations for absolute and relative module IDs',()=>{
 for(const absolute of [true,false])fixture(f=>{
  const nested='node_modules/other/node_modules/lit/index.js',paths=['src/main.ts','node_modules/lit/index.js',nested];
  f.put(nested,'nested dependency fixture');
  f.bundle['assets/index-test.js'].modules=Object.fromEntries(paths.map(path=>[absolute?join(f.root,path):path,{}]));
  f.write();f.finish();const receipt=JSON.parse(readFileSync(join(f.root,'dist/app/build-evidence.json')));
  assert.deepEqual(receipt.outputs.find(output=>output.file==='assets/index-test.js').modules,paths);
 });
});
test('application module provenance retains transformed query identities for contract rejection',()=>fixture(f=>{
 const paths=['node_modules/lit/index.js','node_modules/lit/index.js?worker'];
 f.bundle['assets/index-test.js'].modules=Object.fromEntries(paths.map(path=>[join(f.root,path),{}]));
 f.write();f.finish();const receipt=JSON.parse(readFileSync(join(f.root,'dist/app/build-evidence.json')));
 assert.deepEqual(receipt.outputs.find(output=>output.file==='assets/index-test.js').modules,paths);
}));
test('application compilation rejects a build without config hook capture',()=>{
 assert.throws(()=>fixture(()=>assert.fail('missing config capture reached generateBundle'),{skipConfig:true}),/compilation configuration was not captured/);
});
test('application compilation rejects an alternate actual config even with the reviewed plugin',()=>{
 assert.throws(()=>fixture(()=>assert.fail('alternate config reached generateBundle'),{beforeConfig:f=>{
  f.put('alternate.config.ts','import {buildEvidence} from "./tooling/build-evidence.js";export default {plugins:[buildEvidence(true)]};');
  f.config.configFile=join(f.root,'alternate.config.ts');
 }}),/different or noncanonical config file or root/);
});
test('application compilation rejects a symlink at the reviewed config path',()=>{
 assert.throws(()=>fixture(()=>assert.fail('symlinked config reached generateBundle'),{beforeConfig:f=>{
  const path=join(f.root,'vite.app.config.ts'),target=join(f.root,'original.config.ts');renameSync(path,target);symlinkSync(target,path,'file');
 }}),/different or noncanonical config file or root/);
});
test('application compilation rejects another plugin with the same name and additional plugins',()=>{
 for(const plugins of [plugin=>[{...plugin}],plugin=>[plugin,{name:plugin.name}],()=>[]]){
  assert.throws(()=>fixture(()=>assert.fail('unreviewed user plugins reached generateBundle'),{beforeConfig:f=>{f.userConfig.plugins=plugins(f.plugin);}}),/sole reviewed user plugin/);
 }
});
test('application compilation rejects omitted, additional, and duplicate config dependencies',()=>{
 for(const change of [files=>files.slice(1),files=>[...files,'/extra.config.ts'],files=>[files[0],files[0],files[2]]]){
  assert.throws(()=>fixture(()=>assert.fail('different config graph reached generateBundle'),{beforeConfig:f=>{f.config.configFileDependencies=change(f.config.configFileDependencies);}}),/config dependency inventory differs/);
 }
});
test('application compilation rejects inline resolution, transform, entry and plugin overrides',()=>{
 const overrides=[
  {resolve:{alias:{lit:'./replacement.js'}}},{plugins:[{name:'consumer-build-evidence'}]},
  {define:{replacement:true}},{oxc:{target:'esnext'}},{esbuild:false},{environments:{client:{}}},
  {input:'alternate.html'},{build:{rolldownOptions:{plugins:[{name:'replacement'}]}}},
  {worker:{plugins:()=>[{name:'replacement'}]}},{optimizeDeps:{include:['replacement']}},
  {css:{postcss:{plugins:[]}}},{experimental:{renderBuiltUrl:()=>'/replacement.js'}},
  {configLoader:'native'},{configFile:false},{base:'/different/'},{mode:'development'},
 ];
 for(const override of overrides)assert.throws(()=>fixture(()=>assert.fail('inline override reached generateBundle'),{
  beforeConfig:f=>Object.assign(f.config.inlineConfig,override),
 }),/rejects inline override/);
});
test('application compilation accepts equivalent supported CLI identity and logging options',()=>fixture(f=>{
 f.write();f.finish();assert.equal(JSON.parse(readFileSync(join(f.root,'dist/app/build-evidence.json'))).compilation.inlineTransformOptions,'none');
},{beforeConfig:f=>Object.assign(f.config.inlineConfig,{root:f.root,configFile:join(f.root,'vite.app.config.ts'),configLoader:'bundle',mode:'production',base:'/',logLevel:'silent',clearScreen:false})}));
test('application compilation rejects nonproduction, worker and injected devtools configurations',()=>{
 for(const patch of [{mode:'development'},{isProduction:false},{isWorker:true},{devtools:{enabled:true}},{root:'/different-root'}]){
  assert.throws(()=>fixture(()=>assert.fail('unsupported resolved configuration reached generateBundle'),{beforeConfig:f=>Object.assign(f.config,patch)}),/reviewed production build configuration|different or noncanonical config file or root/);
 }
});
test('application compilation binds config bytes before buildStart capture',()=>{
 assert.throws(()=>fixture(()=>assert.fail('configuration drift reached generateBundle'),{beforeStart:f=>f.put('vite.app.config.ts','changed after configResolved')}),/Application compilation inputs changed during the build/);
});
test('application compilation rejects unsealed environment defines and changed defaults',()=>{
 for(const patch of [{VITE_STARTUP:'replacement'},{BASE_URL:'/different/'},{MODE:'development'},{DEV:true},{PROD:false}]){
  assert.throws(()=>fixture(()=>assert.fail('unsealed environment reached generateBundle'),{beforeConfig:f=>Object.assign(f.config.env,patch)}),/default production environment definitions/);
 }
});
test('consumer evidence does not acquire application configuration requirements',()=>{
 const plugin=buildEvidence(false),context={emitFile(){},error(message){throw Error(message);}};
 hook(plugin,'config',context,{plugins:[{name:'consumer fixture plugin'}]},{command:'build',mode:'production'});
 hook(plugin,'configResolved',context,{command:'build'});assert.doesNotThrow(()=>hook(plugin,'buildStart',context));
});
test('application development server does not acquire production configuration requirements',()=>{
 const plugin=buildEvidence(true),context={error(message){throw Error(message);}};
 hook(plugin,'config',context,{plugins:[plugin]},{command:'serve',mode:'development'});
 hook(plugin,'configResolved',context,{command:'serve'});assert.doesNotThrow(()=>hook(plugin,'buildStart',context));
});


function workerChunk(f,{file='assets/text-worker.js',code='self.postMessage(1);',modules=['src/text/worker.ts','node_modules/canvaskit-wasm/bin/canvaskit.js']}={}){
 return {type:'chunk',fileName:file,code,isEntry:true,facadeModuleId:join(f.root,'src/text/worker.ts'),imports:[],dynamicImports:[],
  modules:Object.fromEntries(modules.map(path=>[join(f.root,path),{}]))};
}
function captureWorker(f,options){
 const chunk=workerChunk(f,options);f.worker({[chunk.fileName]:chunk});
 f.bundle[chunk.fileName]={type:'asset',fileName:chunk.fileName,source:chunk.code};
 return chunk;
}
test('worker chunk provenance joins only exact final assets and preserves native loader modules',()=>fixture(f=>{
 f.write();f.finish();const receipt=JSON.parse(readFileSync(join(f.root,'dist/app/build-evidence.json')));
 const output=receipt.outputs.find(output=>output.file==='assets/text-worker.js');
 assert.equal(output.entry,false);assert.equal(output.workerBundle.schema,1);assert.equal(output.workerBundle.phase,'generateBundle');
 assert.equal(output.workerBundle.entry,'src/text/worker.ts');assert.equal(output.workerBundle.facade,'src/text/worker.ts');assert.equal(output.workerBundle.chunkEntry,true);
 assert.deepEqual(output.modules,['src/text/worker.ts','node_modules/canvaskit-wasm/bin/canvaskit.js']);
 assert.deepEqual(output.workerBundle.modules,output.modules);assert.deepEqual(output.workerBundle.imports,output.imports);
 for(const key of ['file','bytes','sha256'])assert.equal(output.workerBundle[key],output[key]);
 assert.equal(receipt.observations.D11.startupJsRawBytes,f.bytes(f.bundle['assets/index-test.js']).length+f.bytes(f.bundle['assets/lazy-test.js']).length);
 assert.equal(receipt.nativeInputs.length,3);
 for(const pin of receipt.nativeInputs){const bytes=readFileSync(join(f.root,pin.path));assert.deepEqual(pin,{path:pin.path,bytes:bytes.length,sha256:hash(bytes)});}
},{beforeGenerate:captureWorker}));
test('worker provenance rejects changed final asset bytes even when disk matches the changed root bundle',()=>fixture(f=>{
 f.bundle['assets/text-worker.js'].source+='changed';f.write();assert.throws(f.finish,/Worker bundle differs from final emitted asset/);
},{beforeGenerate:captureWorker}));
test('worker provenance refuses duplicate captures and a root chunk impersonating the worker asset',()=>fixture(f=>{
 assert.throws(()=>f.worker({'assets/text-worker.js':workerChunk(f)}),/Duplicate worker bundle output/);
 const chunk=workerChunk(f);f.bundle[chunk.fileName]=chunk;f.write();assert.throws(f.finish,/Worker bundle differs from final emitted asset/);
},{beforeGenerate:captureWorker}));
test('captured but tree-shaken worker outputs are not added to the final build',()=>fixture(f=>{
 f.write();f.finish();const receipt=JSON.parse(readFileSync(join(f.root,'dist/app/build-evidence.json')));
 assert(!receipt.outputs.some(output=>Object.hasOwn(output,'workerBundle')));
},{beforeGenerate:f=>{const chunk=workerChunk(f);f.worker({[chunk.fileName]:chunk});}}));
test('worker provenance retains nested installations and rejects modules outside the owned consumer',()=>fixture(f=>{
 const nested='node_modules/other/node_modules/canvaskit-wasm/bin/canvaskit.js';f.put(nested,'nested loader');
 captureWorker(f,{modules:['src/text/worker.ts',nested]});f.write();f.finish();
 const output=JSON.parse(readFileSync(join(f.root,'dist/app/build-evidence.json'))).outputs.find(output=>output.file==='assets/text-worker.js');
 assert(output.modules.includes(nested));assert(!output.modules.includes('node_modules/canvaskit-wasm/bin/canvaskit.js'));
 const other=workerChunk(f,{file:'assets/outside.js'});other.modules={[process.execPath]:{}};
 assert.throws(()=>f.worker({[other.fileName]:other}),/Module resolved outside the consumer/);
}));
test('worker factory and output format must match the reviewed application configuration',()=>{
 for(const patch of [undefined,{format:'iife',plugins:()=>[]},{format:'es'},{format:'iife',rolldownOptions:{}}]){
  assert.throws(()=>fixture(()=>assert.fail('unreviewed worker config accepted'),{beforeConfig:f=>{f.userConfig.worker=patch&&{plugins:f.plugin.api.workerPlugins,...patch};}}),/sole reviewed worker plugin and IIFE format/);
 }
 fixture(f=>{const chunk=workerChunk(f);assert.throws(()=>f.worker({[chunk.fileName]:chunk},{format:'es'}),/reviewed IIFE build/);});
});
test('worker capture requires its root build lifecycle and cannot reuse a preceding build map',()=>fixture(f=>{
 hook(f.plugin,'buildStart',f.context);hook(f.plugin,'generateBundle',f.context,{dir:join(f.root,'dist/app')},f.bundle,true);
 assert(!JSON.parse(f.bundle['build-evidence.json'].source).outputs.find(output=>output.file==='assets/text-worker.js').workerBundle);
 hook(f.plugin,'closeBundle',f.context);assert.throws(()=>f.worker({'assets/text-worker.js':workerChunk(f)}),/reviewed application build/);
},{beforeGenerate:captureWorker}));
test('native input seal admits the actual loader size without widening invocation member bounds',()=>fixture(f=>{
 f.write();f.finish();const receipt=JSON.parse(readFileSync(join(f.root,'dist/app/build-evidence.json')));
 assert.equal(receipt.nativeInputs.find(pin=>pin.path.endsWith('/canvaskit.js')).bytes,73594);
},{beforeStart:f=>f.put('node_modules/canvaskit-wasm/bin/canvaskit.js',Buffer.alloc(73594))}));
test('native input changes after worker capture cannot finalize even with unchanged emitted worker bytes',()=>fixture(f=>{
 const path='node_modules/canvaskit-wasm/bin/canvaskit.js',changed=readFileSync(join(f.root,path));changed[0]^=1;f.put(path,changed);f.write();
 assert.throws(f.finish,/Application native renderer inputs changed/);
},{beforeGenerate:captureWorker}));
test('native input seal rejects symlinked members and members above its separate retained-input bound',()=>{
 assert.throws(()=>fixture(()=>assert.fail('symlinked native input accepted'),{beforeStart:f=>{
  const path=join(f.root,'node_modules/canvaskit-wasm/bin/canvaskit.js'),target=join(f.root,'original-loader.js');renameSync(path,target);symlinkSync(target,path,'file');
 }}),/native renderer input is not a bounded canonical ordinary file/);
 assert.throws(()=>fixture(()=>assert.fail('oversized native input accepted'),{beforeStart:f=>f.put('node_modules/canvaskit-wasm/bin/canvaskit.wasm',Buffer.alloc(32*1024*1024+1))}),/native renderer input is not a bounded canonical ordinary file/);
});

test('worker capture rejects missing or competing actual entry chunks',()=>fixture(f=>{
 const first=workerChunk(f),second=workerChunk(f,{file:'assets/second-worker.js'});
 assert.throws(()=>f.worker({[first.fileName]:{...first,isEntry:false}}),/exactly one actual entry chunk/);
 assert.throws(()=>f.worker({[first.fileName]:first,[second.fileName]:second}),/exactly one actual entry chunk/);
}));
test('native loader mutation during worker compilation is detected before worker provenance is retained',()=>fixture(f=>{
 const chunk=workerChunk(f),path='node_modules/canvaskit-wasm/bin/canvaskit.js';
 Object.defineProperty(chunk,'code',{get(){const changed=readFileSync(join(f.root,path));changed[0]^=1;f.put(path,changed);return 'self.postMessage(1);';}});
 assert.throws(()=>f.worker({[chunk.fileName]:chunk}),/Application native renderer inputs changed/);
}));
