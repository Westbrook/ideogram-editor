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

function fixture(run,{beforeConfig,beforeStart,skipConfig=false}={}){
 const cwd=process.cwd(),root=realpathSync(mkdtempSync(join(tmpdir(),'ie-build-evidence-')));
 const put=(path,bytes)=>{const target=join(root,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,bytes);};
 try{
  for(const path of ['src/main.ts','index.html','vite.app.config.ts','tsconfig.json','tsconfig.app.json','package.json','package-lock.json','.progress-report/project.json','tooling/build-evidence.ts','tooling/theme/input.css','vendor/text/manifest.json'])put(path,'fixture '+path);
  // Arbitrary bounded bytes test the plugin's provenance capture only. They do
  // not satisfy the reviewed invocation contract and never claim qualification.
  for(const path of D11_INVOCATION_DEPENDENCY_PATHS)put(path,'dependency fixture '+path);
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
  const userConfig={plugins:[plugin]};
  beforeConfig?.({root,put,plugin,bundle,context,config,userConfig});
  if(!skipConfig){hook(plugin,'config',context,userConfig,{command:'build',mode:'production'});hook(plugin,'configResolved',context,config);}
  const bytes=item=>Buffer.from(item.type==='chunk'?item.code:item.source);
  const write=()=>{for(const item of Object.values(bundle))put('dist/app/'+item.fileName,bytes(item));};
  beforeStart?.({root,put,plugin,bundle,context});
  hook(plugin,'buildStart',context);
  hook(plugin,'generateBundle',context,{dir:join(root,'dist/app')},bundle,true);
  return run({root,put,plugin,bundle,context,bytes,write,finish:()=>hook(plugin,'writeBundle',context,{dir:join(root,'dist/app')},bundle)});
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
 assert.deepEqual(receipt.compilation,{schema:1,profile:'reviewed-vite-app-1',configFile:'vite.app.config.ts',configLoader:'bundle',command:'build',mode:'production',
  env:{BASE_URL:'/',MODE:'production',DEV:false,PROD:true},
  configInputs:receipt.sourceInputs.filter(input=>['.progress-report/project.json','tooling/build-evidence.ts','vite.app.config.ts'].includes(input.path)),
  inlineTransformOptions:'none',userPlugins:['consumer-build-evidence']});
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
