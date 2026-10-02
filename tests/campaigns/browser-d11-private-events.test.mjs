import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSync } from 'rolldown/utils';
import { createRequire } from 'node:module';
import { D11_ROLE_CONTEXT } from '../../tooling/qualification/campaigns/browser-d11-registration.mjs';
import { assertD11EventCorpus, deriveD11PrivateEventBoundaries, deriveD11PrivateEventSourceProof } from '../../tooling/qualification/campaigns/browser-d11-private-events.mjs';

const require = createRequire(import.meta.url);
const parser = { name: 'rolldown', version: require('rolldown/package.json').version, parseSync };
function fixture() {
  const shell = [
    "import { LitElement, html } from 'lit';",
    "import { Commands } from './commands.js';",
    'class Shell extends LitElement {',
    'commands = new Commands(()=>this.#rows());',
    "#load(){return import('./feature.js');}",
    "#rows(){return [{id:'feature',label:'Feature',run:()=>this.#load()}];}",
    'render(){return html`<en-button @click=${()=>this.#load()}>Feature</en-button>${this.commands.render()}`;}',
    '}',
  ].join('\n');
  const commands = [
    "import { html } from 'lit'; import { repeat } from 'lit/directives/repeat.js';",
    'export class Commands {',
    '#commands; constructor(commands){this.#commands=commands;}',
    '#items(){const commands=this.#commands(); if(commands.length>32)throw Error();',
    'for(const command of commands){if(command.label.length>80)throw Error();}',
    "const query='';return query?commands.filter(command=>command.label.includes(query)):commands;}",
    '#execute(){const command=this.#items().find(row=>row.id);if(command)command.run();}',
    '#key(event){if(event.key===\'Enter\')this.#execute();}',
    'render(){const items=this.#items().map(({id,label})=>({id,label}));',
    'return html`<section @keydown=${event=>this.#key(event)}>${repeat(items,item=>item.id,item=>{return html`<en-button @click=${()=>this.#execute()}>${item.label}</en-button>`;})}</section>`;}',
    '}',
  ].join('\n');
  return {
    parser, roleContext: structuredClone(D11_ROLE_CONTEXT),
    sourceTextByPath: {'src/ui/shell.ts':shell,'src/ui/commands.ts':commands,'src/ui/feature.ts':'export const feature=1;'},
    outputTextByFile:{'assets/shell.js':"class Shell{#load(){return import('./feature.js')}}",'assets/feature.js':'export const feature=1;'},
    manifest:{'src/ui/feature.ts':{src:'src/ui/feature.ts',file:'assets/feature.js',isDynamicEntry:true}},
    files:[{file:'assets/shell.js',kind:'js',sources:['src/ui/shell.ts','src/ui/commands.ts'],modules:['src/ui/shell.ts','src/ui/commands.ts']},{file:'assets/feature.js',kind:'js',sources:['src/ui/feature.ts'],modules:['src/ui/feature.ts']}],
  };
}
const mutate = (path, from, to) => {const f=fixture();assert(f.sourceTextByPath[path].includes(from));f.sourceTextByPath[path]=f.sourceTextByPath[path].replace(from,to);return f;};
const rejected = f => {const result=deriveD11PrivateEventSourceProof(f);assert.equal(result.complete,false);assert.deepEqual(result.excludedImports,[]);return result;};

test('private source witness closes direct event and privately stored command paths',()=>{
  const proof=deriveD11PrivateEventSourceProof(fixture());assert.deepEqual(proof.missing,[]);assert.equal(proof.excludedImports.length,1);
  const item=proof.excludedImports[0];assert.equal(item.target,'assets/feature.js');assert.deepEqual(item.outputs,['assets/shell.js']);
  assert.deepEqual(item.witness.calls.map(call=>call.kind).sort(),['lit-event','private-command-event']);
  assert.deepEqual(item.witness.calls.find(call=>call.kind==='private-command-event').events,['click','keydown']);
});
test('source structure alone never grants dependency authority',()=>{
  const proof=deriveD11PrivateEventBoundaries({...fixture(),invocationContract:null});assert.equal(proof.complete,false);assert.match(proof.missing.join(' '),/invocation contract/);
});
test('legacy corpus without a private import requires no optional contract',()=>{
  const f=fixture();f.sourceTextByPath['src/ui/shell.ts']='export const shell=1;';
  assert.deepEqual(deriveD11PrivateEventBoundaries(f),{excludedImports:[],complete:true,missing:[]});
});
test('command validation cannot destructure, alias, pass or execute the row capability',()=>{
  for(const body of ['for(const {run} of commands)run();','for(const command of commands){const row=command;row.run();}','for(const command of commands)unknown(command);','for(const command of commands)command.run();'])
    rejected(mutate('src/ui/commands.ts','for(const command of commands){if(command.label.length>80)throw Error();}',body));
});
test('filter predicate cannot destructure or execute the row capability',()=>{
  for(const replacement of ['commands.filter(({run})=>run())','commands.filter(command=>command.run())','commands.filter(command=>unknown(command))'])
    rejected(mutate('src/ui/commands.ts','commands.filter(command=>command.label.includes(query))',replacement));
});
test('command display copy cannot expose run or a rest binding',()=>{
  for(const replacement of ['({id,label,run})=>({id,label,run})','({id,...rest})=>({id,rest})'])rejected(mutate('src/ui/commands.ts','({id,label})=>({id,label})',replacement));
});
test('private table producer and command callback cannot escape',()=>{
  rejected(mutate('src/ui/shell.ts','commands = new Commands(()=>this.#rows());','commands = new Commands(()=>this.#rows()); leaked=()=>this.#rows();'));
  rejected(mutate('src/ui/commands.ts','this.#commands=commands;','this.#commands=commands;commands();'));
  rejected(mutate('src/ui/commands.ts','#execute(){','#executeAlias=this.#commands; #execute(){'));
});
test('nested return in unknown render callback is not the framework render return',()=>{
  rejected(mutate('src/ui/commands.ts','repeat(items,item=>item.id,item=>{return html','unknown(items,item=>item.id,item=>{return html'));
});
test('render result extraction and callable render aliases invalidate the event sink',()=>{
  for(const suffix of ['const t=host.render();t.values[0]();','host.render(1).values[0]();','const get=host.render;get.call(host).values[0]();','const get=host.render;const alias=get;alias.call(host).values[0]();','host.render.bind(host)().values[0]();','unknown(host.render);','const {render}=host;render();']){
    const f=fixture();f.sourceTextByPath['src/activation.ts']=suffix;rejected(f);
  }
});
test('data render fields may reach a source-proved noncalling shape validator',()=>{
  const f=fixture();
  f.sourceTextByPath['src/data.ts']="import {keys} from './validate.js';function check(s){const r=s.render;keys(r,['pixels']);}";
  f.sourceTextByPath['src/validate.ts']="export function keys(v,fields){return v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===fields.length&&fields.every(k=>Object.hasOwn(v,k));}";
  assert.equal(deriveD11PrivateEventSourceProof(f).complete,true);
  f.sourceTextByPath['src/validate.ts']='export function keys(v,fields){v();}';rejected(f);
});
test('source and emitted target census reject an extra import or output alias',()=>{
  const f=fixture();f.sourceTextByPath['src/ui/commands.ts']+="\nconst extra=()=>import('./feature.js');";rejected(f);
  const g=fixture();g.outputTextByFile['assets/shell.js']+="\nimport('./feature.js');";rejected(g);
});
test('imported template and callback constructor bindings must be stable',()=>{
  rejected(mutate('src/ui/shell.ts','render(){','render(html){'));
  rejected(mutate('src/ui/shell.ts','class Shell extends LitElement {','class Shell extends LitElement { broken(Commands){return new Commands();}'));
  const alternate=mutate('src/ui/commands.ts','export class Commands {','class Commands {');
  alternate.sourceTextByPath['src/ui/commands.ts']+='\nclass Other{};export {Other as Commands};';rejected(alternate);
});
test('synthetic and computed activation, eval aliases and hooks remain unproved',()=>{
  for(const source of ["document.querySelector('en-button').click();","host.dispatchEvent(new Event('click'));","const name='click';host[name]();","const name='click';const invoke=host[name];invoke();","function trigger(el,key:'safe1'|'safe2'){el[key]()}trigger(button,'click' as 'safe1');","globalThis.eval('anything');","const evaluate=eval;evaluate('anything');","globalThis.Function('anything')();","Reflect.get(host,'click')();","Shell.prototype.render=other;"]){
    assert.throws(()=>assertD11EventCorpus({sourceTextByPath:{'src/activation.ts':source},parser}));
  }
  assert.throws(()=>assertD11EventCorpus({sourceTextByPath:{'src/activation.ts':'globalThis.litHtmlPolyfillSupport=()=>{};'},parser,requiredAbsentGlobals:['litHtmlPolyfillSupport']}));
});
test('fresh bounded download anchor and explicit nonactivation notification remain permitted',()=>{
  assert.doesNotThrow(()=>assertD11EventCorpus({sourceTextByPath:{'src/download.ts':"const link=document.createElement('a');link.href='x';link.download='x';link.click(); host.dispatchEvent(new CustomEvent('ie-display-error'));"},parser}));
});
test('unknown viewport boundary does not inherit private-event proof',()=>{
  const f=fixture();f.roleContext.viewport.width=900;rejected(f);
});


test('computed data aliases do not inherit calls through distinct lexical bindings',()=>{
  const sources=[
    'class Editing { filesChanged(files){const file=files[0];return file;} withSession(owners){return Array.from(owners,file=>file.pin());} }',
    'const invoke=host[key];function action(invoke){invoke();}',
    'const invoke=host[key];{const invoke=()=>{};invoke();}',
    'const invoke=host[key];function action(){invoke();{var invoke=()=>{};}}',
    'const invoke=host[key];try{throw null;}catch(invoke){invoke();}',
    'const invoke=host[key];function action({invoke}){invoke();}',
    'const invoke=host[key];function action([invoke]){invoke();}',
    'const invoke=host[key];function action(...invoke){invoke.call(null);}',
    'const invoke=host[key];for(let invoke of callbacks){invoke();}',
    'const invoke=host[key];switch(0){case 0:let invoke=()=>{};invoke();}',
    'const invoke=host[key];const action=function invoke(){invoke();};',
  ];
  for(const source of sources)assert.doesNotThrow(()=>assertD11EventCorpus({sourceTextByPath:{'src/lexical.ts':source},parser}),source);
});

test('computed alias binding identity preserves calls, captures and unknown-scope refusals',()=>{
  const sources=[
    'const invoke=host[key];invoke();',
    'const invoke=host[key];new invoke();',
    'const invoke=host[key];invoke.method();',
    'const invoke=host[key];invoke.call(null);',
    'const invoke=host[key];invoke.apply(null,[]);',
    'const invoke=host[key];invoke.bind(null);',
    'const invoke=host[key];function nested(){invoke();}',
    'const invoke=host[key];const nested=()=>()=>invoke.method();',
    'function action(){var invoke=host[key];{var invoke;}invoke();}',
    'function action(){if(condition){var invoke=host[key];}function nested(){invoke();}}',
    'const invoke=host[key];function action(value=invoke()){var invoke;}',
    'const invoke=host[key];function action({value=invoke()}={}){var invoke;}',
    'const invoke=host[key];switch(invoke()){case 0:let invoke;}',
    'function action(){const invoke=host[key];}invoke();',
  ];
  for(const source of sources)assert.throws(()=>assertD11EventCorpus({sourceTextByPath:{'src/lexical.ts':source},parser}),/computed (?:callable has no bounded nonactivation key|alias reference has no binding)/,source);
});

test('the actual native text source distinguishes selected File data from an owner callback parameter',async()=>{
  const {readFile}=await import('node:fs/promises');
  const source=await readFile(new URL('../../src/ui/native-text.ts',import.meta.url),'utf8');
  assert.doesNotThrow(()=>assertD11EventCorpus({sourceTextByPath:{'src/ui/native-text.ts':source},parser}));
});


let retainedEventCorpus;
async function actualEventCorpus() {
  retainedEventCorpus ??= (async()=>{
    const {readFile}=await import('node:fs/promises');
    const {createHash}=await import('node:crypto');
    const {D11_APPLICATION_SOURCE_PATHS}=await import('../../tooling/qualification/campaigns/browser-d11-application-profile.mjs');
    const sourceTextByPath={};
    for(const path of D11_APPLICATION_SOURCE_PATHS){
      const bytes=await readFile(new URL('../../'+path,import.meta.url));
      assert(bytes.length<=16*1048576);const text=bytes.toString('utf8');assert(Buffer.from(text).equals(bytes));sourceTextByPath[path]=text;
    }
    const staticSource=await readFile(new URL('../../server/static.ts',import.meta.url),'utf8');
    const matches=[...staticSource.matchAll(/export const BOOTSTRAP_PRELUDE = `([^`]+)`;/g)];
    assert.equal(matches.length,1);assert(!matches[0][1].includes('${'));
    const sourceInputs=Object.entries(sourceTextByPath).map(([path,text])=>({path,rawBytes:Buffer.byteLength(text),sha256:'sha256:'+createHash('sha256').update(text).digest('hex')}));
    return {sourceTextByPath,sourceInputs,bootstrapText:matches[0][1]};
  })();
  return structuredClone(await retainedEventCorpus);
}

test('the entire actual reviewed application corpus passes the strict event census only with its exact data effect',async()=>{
  const value=await actualEventCorpus();
  const {verifyD11ApplicationProfile}=await import('../../tooling/qualification/campaigns/browser-d11-application-profile.mjs');
  const profile=verifyD11ApplicationProfile(value);
  assert.equal(profile.eventDataEffects.sites.length,1);assert.equal(profile.eventDataEffects.sites[0].calls.length,4);
  assert.throws(()=>assertD11EventCorpus({sourceTextByPath:value.sourceTextByPath,parser}),/computed data-call effects lack the reviewed corpus contract/);
  const census=assertD11EventCorpus({sourceTextByPath:value.sourceTextByPath,parser,applicationSourceProfile:profile});
  assert(census instanceof Map);assert(census.has('src/ui/request.ts'));assert(census.has('src/ui/native-text.ts'));
  assert.equal(census.size,Object.keys(value.sourceTextByPath).filter(path=>path.startsWith('src/')&&/\.[cm]?[jt]sx?$/.test(path)&&!/\.d\.[cm]?ts$/.test(path)).length);
});

test('candidate method syntax remains a provisional obligation and cannot supply final invocation authority',()=>{
  const f=fixture();f.sourceTextByPath['src/data.ts']="const operation=values[index];operation.endsWith('-v45');";
  const structural=deriveD11PrivateEventSourceProof(f);
  assert.equal(structural.complete,true);assert.equal(structural.conditionalEventDataEffects.length,1);
  assert.equal(structural.conditionalEventDataEffects[0].requirement,'reviewed-primitive-string-method');
  assert.throws(()=>assertD11EventCorpus({sourceTextByPath:f.sourceTextByPath,parser}),/computed data-call effects lack/);
  const {requirement,...site}=structural.conditionalEventDataEffects[0];
  const forged={kind:'verified-d11-application-profile-1',profile:'reviewed-d11-startup-corpus-1',inputs:[{path:site.source,sha256:site.sourceSha256}],eventDataEffects:{kind:'reviewed-d11-event-data-calls-1',sites:[{...site,effect:'request-operation-literal-string-method'}]}};
  for(const extra of [{applicationSourceProfile:forged},{applicationSourceProfile:forged,invocationContract:{applicationSourceProfile:forged}}]){
    const result=deriveD11PrivateEventBoundaries({...f,...extra});assert.equal(result.complete,false);assert.deepEqual(result.excludedImports,[]);
  }
});

test('strict computed data effect matching rejects missing, additional and altered read or call obligations',async()=>{
  const value=await actualEventCorpus();
  const {verifyD11ApplicationProfile}=await import('../../tooling/qualification/campaigns/browser-d11-application-profile.mjs');
  const original=verifyD11ApplicationProfile(value),sourceTextByPath={'src/ui/request.ts':value.sourceTextByPath['src/ui/request.ts']};
  for(const change of [
    p=>{delete p.eventDataEffects;},p=>{p.eventDataEffects.kind='other';},p=>{p.eventDataEffects.sites=[];},
    p=>{p.eventDataEffects.sites.push(structuredClone(p.eventDataEffects.sites[0]));},
    p=>{p.eventDataEffects.sites[0].effect='any-named-method';},p=>{p.eventDataEffects.sites[0].start++;},
    p=>{p.eventDataEffects.sites[0].expressionSha256='sha256:'+'0'.repeat(64);},
    p=>{p.eventDataEffects.sites[0].declaration.end++;},p=>{p.eventDataEffects.sites[0].declaration.expressionSha256='sha256:'+'0'.repeat(64);},
    p=>{p.eventDataEffects.sites[0].calls.pop();},p=>{p.eventDataEffects.sites[0].calls.push(structuredClone(p.eventDataEffects.sites[0].calls[0]));},
    p=>{p.eventDataEffects.sites[0].calls[0].start++;},p=>{p.eventDataEffects.sites[0].calls[0].expressionSha256='sha256:'+'0'.repeat(64);},
    p=>{p.eventDataEffects.sites[0].calls[0].argument='other';},p=>{p.inputs=p.inputs.filter(input=>input.path!=='src/ui/request.ts');},
  ]){
    const profile=structuredClone(original);change(profile);
    assert.throws(()=>assertD11EventCorpus({sourceTextByPath,parser,applicationSourceProfile:profile}),/computed data-call/);
  }
  assert.throws(()=>assertD11EventCorpus({sourceTextByPath:{'src/ui/request.ts':sourceTextByPath['src/ui/request.ts']+'\n'},parser,applicationSourceProfile:original}),/computed data-call source is not reviewed/);
  assert.throws(()=>assertD11EventCorpus({sourceTextByPath:{'src/empty.ts':'export const empty=1;'},parser,applicationSourceProfile:original}),/computed data-call effects differ/);
});

test('computed callees and unreviewed receiver methods remain refused before any primitive effect join',()=>{
  for(const source of [
    'host[key]();','new host[key]();','const operation=values[index];operation();','const operation=values[index];new operation();',
    'const operation=values[index];operation.call(null);','const operation=values[index];operation.apply(null,[]);','const operation=values[index];operation.bind(null);',
    "const operation=values[index];operation.startsWith('-v45');","const operation=values[index];operation.endsWith(argument);",
    "const operation=values[index];operation.endsWith('-v45',position);","const operation=values[index];operation?.endsWith('-v45');",
    "let operation=values[index];operation.endsWith('-v45');",
  ])assert.throws(()=>assertD11EventCorpus({sourceTextByPath:{'src/data.ts':source},parser}),/computed callable has no bounded nonactivation key/,source);
});



test('parenthesized render values preserve the reviewed Lit sink and still require final invocation authority',()=>{
  const parsed=parser.parseSync('src/parentheses.ts','const value=(host.render());',{lang:'ts',sourceType:'module'});
  assert.deepEqual(parsed.errors,[]);
  const wrapper=parsed.program.body[0].declarations[0].init;
  assert.equal(wrapper.type,'ParenthesizedExpression');assert.equal(wrapper.expression.type,'CallExpression');
  for(const expression of [
    '(this.commands.render())',
    '((this.commands.render()))',
    "this.panel==='export'?(this.commands?this.commands.render():html`<p>Loading</p>`):null",
    "this.panel==='storage'?(this.commands?.render()??null):null",
    '(this.ready&&(this.commands.render()))',
    '(this.commands.render() as unknown)',
  ]){
    const f=mutate('src/ui/shell.ts','${this.commands.render()}','${'+expression+'}');
    const structural=deriveD11PrivateEventSourceProof(f);
    assert.equal(structural.complete,true,JSON.stringify({expression,missing:structural.missing}));
    assert.equal(structural.excludedImports.length,1);
    const final=deriveD11PrivateEventBoundaries({...f,invocationContract:null});
    assert.equal(final.complete,false);assert.deepEqual(final.excludedImports,[]);
    assert.deepEqual(final.missing,['D11 private event proof: retained invocation contract is absent for a private target']);
  }
});

test('transparent parentheses do not admit render-result extraction or unknown consumers',()=>{
  for(const expression of [
    '(this.commands.render()).values',
    'unknown((this.commands.render()))',
    '[(this.commands.render())]',
    '({result:(this.commands.render())})',
    '(stored=this.commands.render())',
    '((this.commands.render()),null)',
    'unknown`${(this.commands.render())}`',
    '(()=>this.commands.render())()',
    '(this.commands.render()).then(consume)',
  ]){
    const result=rejected(mutate('src/ui/shell.ts','${this.commands.render()}','${'+expression+'}'));
    assert.match(result.missing.join(' '),/render result (?:has an unproved callback consumer|reaches an unreviewed template tag)/,expression);
  }
  const f=fixture();f.sourceTextByPath['src/activation.ts']='(host.render.bind(host)()).values[0]();';rejected(f);
});

test('all actual application render consumers reach the complete private structural source proof',async()=>{
  const value=await actualEventCorpus();
  const {verifyD11ApplicationProfile}=await import('../../tooling/qualification/campaigns/browser-d11-application-profile.mjs');
  const profile=verifyD11ApplicationProfile(value);
  assert.equal(profile.inputs.length,Object.keys(value.sourceTextByPath).length+1);
  // Only the output mapping is synthetic here. The complete actual source
  // corpus exercises every render sink and both real Export/Storage roots;
  // finalized-build integration separately authenticates emitted bytes.
  const source='src/ui/shell.ts',features=[['src/ui/export.ts','assets/export.js'],['src/ui/storage-library.ts','assets/storage.js']];
  const proof=deriveD11PrivateEventSourceProof({
    ...value,parser,roleContext:structuredClone(D11_ROLE_CONTEXT),
    manifest:Object.fromEntries(features.map(([src,file])=>[src,{src,file,isDynamicEntry:true}])),
    files:[{file:'assets/shell.js',kind:'js',sources:[source],modules:[source]},...features.map(([src,file])=>({file,kind:'js',sources:[src],modules:[src]}))],
    outputTextByFile:{'assets/shell.js':"class Shell{#loadExport(){return import('./export.js')}#loadStorage(){return import('./storage.js')}}",...Object.fromEntries(features.map(([,file])=>[file,'export const feature=1;']))},
  });
  assert.equal(proof.complete,true,JSON.stringify(proof.missing));assert.deepEqual(proof.missing,[]);
  assert.equal(proof.excludedImports.length,2);
  assert.deepEqual(proof.excludedImports.map(row=>row.witness.featureSource).sort(),features.map(([src])=>src).sort());
  for(const row of proof.excludedImports){
    assert.equal(row.source,source);
    assert.deepEqual(row.witness.calls.map(call=>call.kind).sort(),['lit-event','private-command-event']);
  }
  const storage=proof.excludedImports.find(row=>row.witness.featureSource==='src/ui/storage-library.ts').witness;
  assert.deepEqual(storage.calls.find(call=>call.kind==='lit-event').eventArgument,{parameter:'event',argument:'event'});
  assert.deepEqual(storage.publicAction,{commandId:'storage-library',commandLabel:'Storage library',event:'click',element:'en-button',buttonText:'Storage library'});
  assert.deepEqual(proof.excludedImports.find(row=>row.witness.featureSource==='src/ui/export.ts').witness.publicAction,
    {commandId:'export-image',commandLabel:'Export image',event:'click',element:'en-button',buttonText:'Export image'});
  assert.equal(proof.conditionalEventDataEffects.length,profile.eventDataEffects.sites.length);
});


test('emitted static import templates bind the same private target without granting invocation authority',()=>{
  const escaped='import(`./featur\\u0065.js`)';
  assert(escaped.includes(String.fromCharCode(92)+'u0065'));
  for(const expression of ["import('./feature.js')",'import(`./feature.js`)',escaped]){
    const f=fixture(),output='class Shell{#load(){return '+expression+'}}';
    f.outputTextByFile['assets/shell.js']=output;
    const proof=deriveD11PrivateEventSourceProof(f);
    assert.equal(proof.complete,true,JSON.stringify({expression,missing:proof.missing}));
    assert.equal(proof.excludedImports.length,1);
    assert.equal(proof.excludedImports[0].target,'assets/feature.js');
    assert.deepEqual(proof.excludedImports[0].witness.emitted,[{output:'assets/shell.js',start:output.indexOf(expression),end:output.indexOf(expression)+expression.length}]);
    const final=deriveD11PrivateEventBoundaries({...f,invocationContract:null});
    assert.equal(final.complete,false);assert.deepEqual(final.excludedImports,[]);
    assert.deepEqual(final.missing,['D11 private event proof: retained invocation contract is absent for a private target']);
  }
});

test('the emitted target census includes every file and refuses any computed import',()=>{
  const f=fixture();f.outputTextByFile['assets/shell.js']='class Shell{#load(){return import(`./feature.js`)}}';
  for(const [file,output] of [['assets/entry.js','import(`./shell.js`);'],['assets/other.js','class Font{import(a,b,c){return a;}}const load=()=>import(`./unrelated.js`);'],['assets/unrelated.js','export const unrelated=1;']]){
    f.files.push({file,kind:'js',sources:[],modules:[]});f.outputTextByFile[file]=output;
  }
  assert.equal(deriveD11PrivateEventSourceProof(f).complete,true);
  for(const expression of [
    'import(`./${name}.js`)','import(`./${"feature"}.js`)','import(name)',
    'import("./"+name+".js")','import(tag`./feature.js`)','import(``)',
  ]){
    const g=structuredClone({...f,parser:undefined});g.parser=parser;g.outputTextByFile['assets/other.js']=expression+';';
    const proof=rejected(g);
    assert.deepEqual(proof.missing,['D11 private event proof: computed emitted import prevents target census'],expression);
  }
});

test('emitted template support preserves strict source grammar and exact target ownership',()=>{
  const sourceTemplate=mutate('src/ui/shell.ts',"import('./feature.js')",'import(`./feature.js`)');
  assert.deepEqual(rejected(sourceTemplate).missing,['D11 private event proof: import is not an exact local source']);
  for(const expression of ['import(`./other.js`)','import(`./feature.js?query`)','import(`./feature.js#fragment`)']){
    const f=fixture();f.outputTextByFile['assets/shell.js']='class Shell{#load(){return '+expression+'}}';
    assert.deepEqual(rejected(f).missing,['D11 private event proof: private target has no unique emitted import-site binding']);
  }
  const duplicate=fixture();duplicate.outputTextByFile['assets/shell.js']+=';import(`./feature.js`);';
  assert.deepEqual(rejected(duplicate).missing,['D11 private event proof: private target has no unique emitted import-site binding']);
  const otherOwner=fixture();otherOwner.outputTextByFile['assets/shell.js']='export const shell=1;';
  otherOwner.files.push({file:'assets/other.js',kind:'js',sources:[],modules:[]});otherOwner.outputTextByFile['assets/other.js']='import(`./feature.js`);';
  assert.deepEqual(rejected(otherOwner).missing,['D11 private event proof: private target has no unique emitted import-site binding']);
});

test('a literal Lit button forwards its exact event binding without granting dependency authority',()=>{
  for(const name of ['event','clickEvent']){
    const f=mutate('src/ui/shell.ts','@click=${()=>this.#load()}','@click=${('+name+':Event)=>this.#load('+name+')}');
    const proof=deriveD11PrivateEventSourceProof(f);
    assert.equal(proof.complete,true,JSON.stringify(proof.missing));
    const witness=proof.excludedImports[0].witness;
    assert.deepEqual(witness.calls.find(call=>call.kind==='lit-event').eventArgument,{parameter:name,argument:name});
    assert.equal(Object.hasOwn(witness.calls.find(call=>call.kind==='private-command-event'),'eventArgument'),false);
    assert.deepEqual(witness.publicAction,{commandId:'feature',commandLabel:'Feature',event:'click',element:'en-button',buttonText:'Feature'});
    const final=deriveD11PrivateEventBoundaries({...f,invocationContract:null});
    assert.equal(final.complete,false);assert.deepEqual(final.excludedImports,[]);
    assert.deepEqual(final.missing,['D11 private event proof: retained invocation contract is absent for a private target']);
  }
});

test('event forwarding refuses transformed bindings, unrelated event sinks and extra private callers',()=>{
  for(const arrow of [
    '(event=other)=>this.#load(event)','(...event)=>this.#load(event)',
    '({event})=>this.#load(event)','([event])=>this.#load(event)',
    '(event,other)=>this.#load(event)','event=>this.#load(other)',
    'event=>this.#load(event.target)','event=>this.#load()',
    '()=>this.#load(event)','event=>{this.#load(event)}',
    'event=>this.#load(...event)','event=>this.#load(event,other)',
    'event=>this.#load((event))',
  ])rejected(mutate('src/ui/shell.ts','@click=${()=>this.#load()}','@click=${'+arrow+'}'));
  rejected(mutate('src/ui/shell.ts','@click=${()=>this.#load()}','@keydown=${event=>this.#load(event)}'));
  rejected(mutate('src/ui/shell.ts','<en-button @click=${()=>this.#load()}>Feature</en-button>','<button @click=${event=>this.#load(event)}>Feature</button>'));
  rejected(mutate('src/ui/shell.ts',"run:()=>this.#load()","run:event=>this.#load(event)"));
  rejected(mutate('src/ui/shell.ts','commands = new Commands(()=>this.#rows());','commands = new Commands(()=>this.#rows()); eager=this.#load(event);'));
});

test('public action identity comes from the unique literal command and literal button content',()=>{
  const f=fixture();
  f.publicAction={commandId:'export-image',commandLabel:'Export image',event:'click',element:'en-button',buttonText:'Export image'};
  const witness=deriveD11PrivateEventSourceProof(f).excludedImports[0].witness;
  assert.deepEqual(witness.publicAction,{commandId:'feature',commandLabel:'Feature',event:'click',element:'en-button',buttonText:'Feature'});
  const renamed=mutate('src/ui/shell.ts',"id:'feature',label:'Feature'","id:'other-action',label:'Other action'");
  renamed.sourceTextByPath['src/ui/shell.ts']=renamed.sourceTextByPath['src/ui/shell.ts'].replace('>Feature</en-button>','>Other action</en-button>');
  const proof=deriveD11PrivateEventSourceProof(renamed);assert.equal(proof.complete,true,JSON.stringify(proof.missing));
  assert.deepEqual(proof.excludedImports[0].witness.publicAction,{commandId:'other-action',commandLabel:'Other action',event:'click',element:'en-button',buttonText:'Other action'});
});

test('ambiguous command identities or accessible button names cannot supply action metadata',()=>{
  const specimens=[
    ["id:'feature',label:'Feature'","id:'feature',id:'other',label:'Feature'"],
    ["id:'feature',label:'Feature'","id:'feature',label:'Feature',label:'Other'"],
    ["id:'feature',label:'Feature'","id:unknownId,label:'Feature'"],
    ["id:'feature',label:'Feature'","id:'feature',label:unknownLabel"],
    ["run:()=>this.#load()}];","run:()=>this.#load()},{id:'feature',label:'Other',run:()=>0}];"],
    ['<en-button @click=','<en-button aria-label="Other" @click='],
    ['<en-button @click=','<en-button aria-labelledby="other" @click='],
    ['>Feature</en-button>','>${label}</en-button>'],
    ['}>Feature</en-button>','} title="Other">Feature</en-button>'],
  ];
  for(const [before,after] of specimens){
    const proof=deriveD11PrivateEventSourceProof(mutate('src/ui/shell.ts',before,after));
    assert.equal(proof.complete,true,JSON.stringify({before,after,missing:proof.missing}));
    assert.equal(Object.hasOwn(proof.excludedImports[0].witness,'publicAction'),false,after);
  }
});
