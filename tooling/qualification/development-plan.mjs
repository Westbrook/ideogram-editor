import {functionalGates} from './manifest.mjs';
import {nodeGroups, requiredSuiteEnvironment, fastNodeFiles, buildFreeFastNodeFiles} from './suite-prerequisites.mjs';
import {nativeNodeBrowserFiles} from './developer-campaigns/selectors.mjs';
import {createBrowserPlan} from './container/browser-plan.mjs';

export const toolingGates = Object.freeze([
  {id:'node:tooling',command:['node','--test','--test-reporter=tap','--test-concurrency=1','tooling/test-node.test.mjs'],files:['tooling/test-node.test.mjs'],dependencies:['preflight'],timeoutMs:60_000},
  {id:'python:vendor',command:['python3','tooling/test-vendor.py'],dependencies:['vendor'],timeoutMs:300_000},
  {id:'python:reviews',command:['python3','tooling/test-review-workspaces.py'],dependencies:['preflight'],timeoutMs:60_000},
  {id:'python:archives',command:['python3','tooling/test-archive-reviews.py'],dependencies:['preflight'],timeoutMs:300_000},
]);
export function developmentPlan(root,{groups='base',browsers='none',output,workers=1,browserGroups='all',browserGrep=null,nodeFiles=null,batchEditor=false}={}) {
  if(browserGrep!==null&&(typeof browserGrep!=='string'||!browserGrep.trim()||browsers==='none'))throw Error('Browser grep requires a nonempty pattern and browser selection');
  if(browserGrep!==null)new RegExp(browserGrep);
  if(browsers==='none'&&browserGroups!=='all')throw Error('Browser families require an explicit --browsers selection');
  if(![1,2].includes(workers))throw Error('Correctness workers must be 1 or 2; timing profiles are separate');
  const all=functionalGates(root),known=new Map(all.map(gate=>[gate.id,gate]));
  const aliases={...nodeGroups,all:Object.values(nodeGroups).flat(),preflight:[],tooling:['qualification','tooling'],archives:['python:archives'],reviews:['python:reviews'],vendor:['python:vendor']};
  const names=aliases[groups]??groups.split(',');
  if(!names.length && groups!=='preflight')throw Error('Empty selection');
  const requested=new Set(names.map(name=>name.startsWith('python:')?name:`node:${name}`));
  for(const gate of toolingGates)known.set(gate.id,gate);
  for(const id of requested)if(!known.has(id))throw Error(`Unknown validation group: ${id}`);
  const focused=nodeFiles===null?null:nodeFiles.split(',');
  const eligible=new Set([...requested].flatMap(id=>known.get(id).files??[]));
  if(focused&&(!focused.length||new Set(focused).size!==focused.length||focused.some(file=>!eligible.has(file))))throw Error('Node file selection must name distinct files owned by the selected groups');
  // The formal runner remains fresh and serial. This development view removes
  // only artificial build edges and explicitly separates browser-hosted tests.
  known.get('build-app').dependencies=['imports'];
  known.get('build-app').command=['node','tooling/qualification/development-build.mjs','app'];
  known.get('build-server').dependencies=['imports'];
  const early=[],late=[],selected=[];
  for(const id of [...requested].sort((a,b)=>[...known.keys()].indexOf(a)-[...known.keys()].indexOf(b))){
    const gate=structuredClone(known.get(id));
    if(focused&&gate.files){const original=gate.files;gate.files=original.filter(file=>focused.includes(file));if(!gate.files.length)continue;gate.command=gate.command.filter(arg=>!original.includes(arg)||focused.includes(arg));}
    if(id.startsWith('python:')||['node:qualification','node:tooling'].includes(id)){selected.push(gate);continue;}
    const hosted=gate.files.filter(file=>nativeNodeBrowserFiles.includes(file)||/tests\/recovery\/(?:owner|persistent)-runner.test.mjs$/.test(file));
    const fast=gate.files.filter(file=>(fastNodeFiles.includes(file)||buildFreeFastNodeFiles.includes(file)));
    const ordinary=gate.files.filter(file=>!hosted.includes(file)&&!fast.includes(file));
    function split(files,suffix){
      const result={...gate,id:id+suffix,files,command:[...gate.command.slice(0,gate.command.indexOf('--test-concurrency=1')),'--test-concurrency=1',...files],dependencies:suffix===':fast'&&files.every(file=>buildFreeFastNodeFiles.includes(file))?['preflight']:['build-server'],requiredEnvironment:requiredSuiteEnvironment(files)};
      delete result.browserPrerequisites;delete result.fixtureBuild;
      if(id==='node:session'||suffix===':browser')result.dependencies.push('build-app');
      if(result.dependencies.includes('build-server')&&['node:raster','node:history','node:portable','node:export'].includes(id))result.dependencies.push('raster-inputs');
      if(suffix===':browser'){result.browserPrerequisites={engines:['chromium'],files};if(files.includes('tests/text-state/native.test.mjs'))result.fixtureBuild=gate.fixtureBuild;}
      return result;
    }
    if(fast.length)early.push(split(fast,':fast'));
    if(ordinary.length)selected.push(split(ordinary,''));
    if(hosted.length)late.push(split(hosted,':browser'));
  }
  for(const gate of [...early,...selected,...late])known.set(gate.id,gate);
  const required=new Set(['typecheck','preflight']);
  function add(id){if(required.has(id))return;const gate=known.get(id);if(!gate)throw Error(`Unknown dependency ${id}`);required.add(id);gate.dependencies.forEach(add);}
  [...early,...selected,...late].forEach(gate=>add(gate.id));
  let browserPlan=null;
  if(browsers!=='none'){
    const serial=createBrowserPlan({selection:browsers,scope:'features',output});
    const families=browserGroups==='all'?null:browserGroups.split(',');
    if(families && (new Set(families).size!==families.length||families.some(f=>!(batchEditor&&f==='editor-batch')&&!serial.steps.some(s=>s.family===f&&s.config))))throw Error('Unknown or duplicate browser family');
    const selected=serial.steps.filter(s=>s.config&&(!families||families.includes(s.family)||(batchEditor&&families.includes('editor-batch')&&s.family.startsWith('editor-'))));
    const editorSelection=[...new Set(selected.filter(s=>s.family.startsWith('editor-')).flatMap(s=>s.files))];
    const full=batchEditor&&editorSelection.length?createBrowserPlan({selection:browsers,scope:'features',output,batchEditor:true,editorSelection}):serial;
    const tests=full.steps.filter(s=>s.config&&(s.family==='editor-batch'&&editorSelection.length||selected.some(p=>p.id===s.id))).map(s=>structuredClone(s));
    if(browserGrep!==null)for(const step of tests)step.args.push('--grep',browserGrep);
    const fixtures=new Set(tests.flatMap(s=>s.prerequisites));
    const prerequisites=tests.every(s=>['consumer','display-image'].includes(s.family))?['imports']:['build-app','build-server','raster-inputs'];
    browserPlan={...full,steps:[...full.steps.filter(s=>fixtures.has(s.id)).map(s=>s.id==='build-consumer'?{...s,executable:'node',args:['tooling/qualification/development-build.mjs','consumer']}:s),...tests],prerequisites,requiredBrowsers:[...new Set(tests.map(s=>s.browser))]};
    browserPlan.prerequisites.forEach(add);
  }
  const needsIssuers=[...early,...selected,...late].some(g=>g.completionPrerequisites)||browserPlan?.steps.some(s=>s.config&&!['consumer','display-image','text','projection','history','raster'].includes(s.family));
  if(needsIssuers){known.set('completion-source',{id:'completion-source',command:['node','tooling/qualification/completion-issuers/index.mjs','--check-source'],dependencies:['preflight'],timeoutMs:60_000});add('completion-source');}
  if([...early,...selected,...late].some(g=>g.dependencies.includes('build-server'))||browserPlan?.prerequisites.includes('build-server')){known.set('storage-environment',{id:'storage-environment',command:['node','tooling/qualification/development-environment.mjs'],dependencies:['preflight'],timeoutMs:15_000});add('storage-environment');}
  const stages=['typecheck','preflight','completion-source','storage-environment','node:qualification','node:tooling','python:reviews','python:archives',...early.filter(gate=>!gate.dependencies.includes('build-server')).map(gate=>gate.id),'vendor','python:vendor','imports','raster-inputs','build-server',...early.filter(gate=>gate.dependencies.includes('build-server')).map(gate=>gate.id),'build-app'];
  const order=[...stages,...selected.map(gate=>gate.id),...late.map(gate=>gate.id)];
  const gates=[...new Set(order)].filter(id=>required.has(id)).map(id=>structuredClone(known.get(id)));
  const tooling=gates.find(gate=>gate.id==='node:qualification');
  if(tooling)tooling.command=tooling.command.map(arg=>arg==='--test-concurrency=1'?`--test-concurrency=${workers}`:arg);
  return {kind:'development-validation-plan-1',groups,browsers,browserGroups,browserGrep,nodeFiles,batchEditor,workers,gates,browserPlan,
    requiredBrowsers:[...new Set([...late.flatMap(gate=>gate.browserPrerequisites.engines),...(browserPlan?.requiredBrowsers??[])])],
    selectedFiles:[...early,...selected,...late].flatMap(gate=>gate.files??[]),
    scope:'Selected development correctness only. Formal P/Q3 fresh samples, native/manual and release qualification remain separate.'};
}
