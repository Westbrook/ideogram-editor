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
