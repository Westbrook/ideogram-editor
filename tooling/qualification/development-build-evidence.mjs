import {mkdir,open,lstat,realpath} from 'node:fs/promises';
import {join,resolve,isAbsolute} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {digestJSON} from './core.mjs';
import {readEvidenceJSON,evidencePath,evidenceDestination} from './evidence-volume.mjs';

const sourcePath='dist/app/build-evidence.json',retainedPath='app-build/build-evidence.json';
const requiredSources=['index.html','vite.app.config.ts','tsconfig.json','tsconfig.app.json','package.json','package-lock.json','.progress-report/project.json','tooling/build-evidence.ts','vendor/text/manifest.json'];
const nativePaths=['node_modules/canvaskit-wasm/package.json','node_modules/canvaskit-wasm/bin/canvaskit.js','node_modules/canvaskit-wasm/bin/canvaskit.wasm'];
const safe=path=>typeof path==='string'&&path.length>0&&!isAbsolute(path)&&!/[\\\x00-\x1f\x7f]/.test(path)&&!path.split('/').some(part=>!part||part==='.'||part==='..');
const appSource=path=>path.startsWith('src/')||path.startsWith('tooling/theme/')||requiredSources.includes(path);
const same=(a,b,label)=>{if(!isDeepStrictEqual(a,b))throw Error('Build evidence '+label+' differs');};
const stamp=value=>[value.dev,value.ino,value.size,value.mtimeNs,value.ctimeNs].map(String).join(':');
const pin=entry=>{
  if(!safe(entry?.path)||!Number.isSafeInteger(entry.bytes)||entry.bytes<0||!/^[a-f0-9]{64}$/.test(entry.sha256??'')||Object.hasOwn(entry,'link'))throw Error('Malformed build evidence identity');
  return {path:entry.path,bytes:entry.bytes,sha256:entry.sha256};
};
function pins(rows){
  if(!Array.isArray(rows)||!rows.length||rows.length>100_000)throw Error('Missing bounded build evidence identities');
  const values=rows.map(pin);if(new Set(values.map(row=>row.path)).size!==values.length)throw Error('Duplicate build evidence identity');
  return values.sort((a,b)=>a.path.localeCompare(b.path));
}

// Ordinary correctness evidence only. Neither selection nor retention approves
// an ownership registry row or supplies native/resource qualification.
export const needsRetainedBuildEvidence=plan=>Boolean(plan.browserPlan?.steps.some(step=>step.config&&['text','editor-native-text'].includes(step.family)));

/** Retain unchanged finalized bytes while the runner still owns its output and
 * evidence monitor. The existing final retention index covers this sidecar. */
export async function retainDevelopmentBuildEvidence({cwd,directory,source,outputs,signal}, {readJSON=readEvidenceJSON}={}){
  signal?.throwIfAborted();
  if(!isAbsolute(cwd)||resolve(cwd)!==cwd||await realpath(cwd)!==cwd||!isAbsolute(directory)||resolve(directory)!==directory||await realpath(directory)!==directory)throw Error('Canonical build retention roots required');
  if(!Array.isArray(source?.files)||source.digest!==digestJSON(source.files))throw Error('Build retention source identity differs');
  const sourceNames=new Set();
  for(const row of source.files){if(!safe(row?.path)||sourceNames.has(row.path))throw Error('Ambiguous build retention source');sourceNames.add(row.path);if(row.deleted!==true)pin(row);}
  const expectedSources=pins(source.files.filter(row=>row.deleted!==true&&appSource(row.path)));
  if(requiredSources.some(path=>!expectedSources.some(row=>row.path===path))||!expectedSources.some(row=>row.path.startsWith('src/'))||!expectedSources.some(row=>row.path.startsWith('tooling/theme/')))throw Error('Incomplete application source closure');
  if(!Array.isArray(outputs?.trees)||outputs.trees.length!==1||outputs.trees[0].path!=='dist/app'||outputs.digest!==digestJSON(outputs.trees))throw Error('Missing exact application output tree');
  const tree=outputs.trees[0].tree;
  if(!tree||tree.digest!==digestJSON(tree.files))throw Error('Application output tree identity differs');
  const builds=pins(tree.files),expected=builds.find(row=>row.path==='build-evidence.json');
  if(!expected||!builds.some(row=>row.path==='.vite/manifest.json')||!builds.some(row=>row.path==='index.html'))throw Error('Incomplete finalized application output tree');
  const original=await evidencePath(cwd,sourcePath),before=await lstat(original,{bigint:true});
  const {value,bytes,identity}=await readJSON(original,{withIdentity:true});
  same(identity,{bytes:expected.bytes,sha256:expected.sha256},'raw body');
  if(value?.schema!==1||!isDeepStrictEqual(value.capture,{phase:'writeBundle',finalized:true})||!isDeepStrictEqual(value.toolchain,{node:'26.10.0',npm:'12.1.0'}))throw Error('Finalized pinned application build required');
  same(pins(value.sourceInputs),expectedSources,'source closure');
  // Preserve the actual producer's native/config/invocation provenance. Full
  // ownership and compiler verification remain their independent later gates.
  const native=pins(value.nativeInputs);
  same(native.map(row=>row.path),[...nativePaths].sort((a,b)=>a.localeCompare(b)),'native input inventory');
  pins(value.dependencyInputs);
  if(value.compilation?.schema!==1||value.compilation.profile!=='reviewed-vite-app-2')throw Error('Missing application compilation provenance');
  same(pins(value.compilation.configInputs),expectedSources.filter(row=>['.progress-report/project.json','tooling/build-evidence.ts','vite.app.config.ts'].includes(row.path)),'compilation input closure');
  if(!Array.isArray(value.outputs)||!value.outputs.length)throw Error('Missing finalized application outputs');
  const emitted=pins(value.outputs.map(row=>({...row,path:row.file})));
  if(emitted.some(row=>row.path==='build-evidence.json'))throw Error('Self-referential build evidence output');
  const actual=builds.filter(row=>row.path!=='build-evidence.json'&&(row.path!=='.vite/manifest.json'||emitted.some(output=>output.path===row.path)));
  same(emitted,actual,'emitted output closure');
  const workers=value.outputs.filter(row=>Object.hasOwn(row,'workerBundle'));
  if(!workers.length)throw Error('Missing actual worker bundle provenance');
  for(const row of workers){
    const worker=row.workerBundle;
    if(worker?.schema!==1||worker.phase!=='generateBundle'||worker.format!=='iife'||!safe(worker.entry)||!Array.isArray(worker.modules)||!worker.modules.length||!Array.isArray(worker.imports))throw Error('Malformed actual worker bundle provenance');
    same(pin({...worker,path:worker.file}),pin({...row,path:row.file}),'worker output identity');
    same(worker.modules,row.modules,'worker module provenance');same(worker.imports,row.imports,'worker import provenance');
  }
  signal?.throwIfAborted();
  const destination=await evidenceDestination(directory,join(directory,retainedPath));
  await mkdir(join(directory,'app-build'),{mode:0o700});
  await evidenceDestination(directory,destination);
  const handle=await open(destination,'wx',0o600);
  try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
  // Retain any partial/failed file for the ordinary failure finalizer; never
  // delete or replace evidence to obtain a successful retry.
  signal?.throwIfAborted();
  same((await readEvidenceJSON(await evidencePath(directory,retainedPath),{withIdentity:true})).identity,identity,'retained raw body');
  same((await readEvidenceJSON(await evidencePath(cwd,sourcePath),{withIdentity:true})).identity,identity,'original raw body after retention');
  if(stamp(await lstat(original,{bigint:true}))!==stamp(before))throw Error('Build evidence changed during retention');
  signal?.throwIfAborted();
  return {kind:'retained-development-build-evidence-1',sourcePath,path:retainedPath,...identity,sourceDigest:source.digest,buildOutputsDigest:outputs.digest,qualification:false};
}
