import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'rolldown/utils';
import { createRequire } from 'node:module';
import { D11_ROLE_CONTEXT } from '../../tooling/qualification/campaigns/browser-d11-registration.mjs';
import { deriveD11NativePreparationClosure, deriveD11WorkerActivation } from '../../tooling/qualification/campaigns/browser-d11-worker-activation.mjs';

const require = createRequire(import.meta.url);
const parser = { name: 'rolldown', version: require('rolldown/package.json').version, parseSync };
const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const nativePath = 'src/ui/native-text.ts', clientPath = 'src/text/client.ts', durablePath = 'src/text/durable.ts', shellPath = 'src/ui/shell.ts';
let retainedSources;
async function specimen() {
  retainedSources ??= (async () => {
    const texts = {};
    async function visit(relative) {
      for (const item of await readdir(join(repo, relative), { withFileTypes: true })) {
        const path = relative + '/' + item.name;
        if (item.isDirectory()) await visit(path);
        else if (item.isFile() && /\.[cm]?[jt]sx?$/.test(path) && !/\.d\.ts$/.test(path)) texts[path] = await readFile(join(repo, path), 'utf8');
      }
    }
    await visit('src'); return texts;
  })();
  return { sourceTextByPath: { ...await retainedSources }, parser };
}

function replace(value, path, before, after) {
  assert(value.sourceTextByPath[path].includes(before), 'The actual source mutation anchor changed: ' + path);
  value.sourceTextByPath[path] = value.sourceTextByPath[path].replace(before, after);
}

// These tests inspect retained application source as data. Product modules are
// never imported or evaluated. A successful local AST closure is provisional:
// it cannot create a Worker exclusion without the authentic invocation contract.
test('native Worker activation follows the actual cold preview state gate', async () => {
  const value = await specimen(), before = JSON.stringify(value.sourceTextByPath);
  const proof = deriveD11NativePreparationClosure(value);
  assert.equal(proof.complete, true, proof.missing.join('; '));
  assert.equal(proof.source, clientPath); assert.equal(proof.workerSource, 'src/text/worker.ts');
  assert.equal(proof.witness.event.label, 'Preview text'); assert.equal(proof.witness.event.event, 'click');
  assert(proof.witness.startup.includes('Save checkpoint'));
  assert.match(proof.witness.activation, /queueMicrotask/);
  assert.match(proof.witness.activation, /eager once prepare is called/);
  assert.equal(proof.witness.sourceInputs.length, Object.keys(value.sourceTextByPath).length);
  assert.equal(JSON.stringify(value.sourceTextByPath), before);
  assert.deepEqual(deriveD11NativePreparationClosure(value), proof);
});

test('constructor, sync, restoreSession, and render cannot gain a Preview caller', async () => {
  for (const [before, after] of [
    ['this.memory=new NativeControlMemory(host);', 'this.preparePreview();this.memory=new NativeControlMemory(host);'],
    ['sync(){if(!this.available())', 'sync(){this.preparePreview();if(!this.available())'],
    ['private async restoreSession(){', 'private async restoreSession(){this.preparePreview();'],
    ['render(){', 'render(){this.preparePreview();'],
  ]) {
    const value = await specimen(); replace(value, nativePath, before, after);
    const proof = deriveD11NativePreparationClosure(value);
    assert.equal(proof.complete, false, before); assert.match(proof.missing.join('; '), /Preview.*caller/);
  }
});

test('native preview state and Apply dominance cannot be weakened by retained source changes', async () => {
  for (const [before, after] of [
    ['private preview?:Preview;', 'private preview:Preview={} as Preview;'],
    ['private async restoreSession(){', 'private async restoreSession(){this.preview={} as Preview;'],
    ['if(!this.preview||this.preview.revision!==this.revision)throw', 'if(false)throw'],
    ['this.memory=new NativeControlMemory(host);', 'this.preparation=new DurableTextPreparation(this.storage);this.memory=new NativeControlMemory(host);'],
  ]) {
    const value = await specimen(); replace(value, nativePath, before, after);
    assert.equal(deriveD11NativePreparationClosure(value).complete, false, before);
  }
});

test('renderer construction and prepare remain bound to their exact native or durable owner', async () => {
  for (const [path, before, after] of [
    [nativePath, 'this.memory=new NativeControlMemory(host);', 'this.renderer=new TextRenderer();this.renderer.prepare({} as TextRequest);this.memory=new NativeControlMemory(host);'],
    [durablePath, 'constructor(private storage:TextStorage){}', 'constructor(private storage:TextStorage){this.#renderer.prepare({} as TextRequest);}'],
    [clientPath, '#serial = 0;', '#serial = 0; #early = this.prepare({} as TextRequest);'],
    [clientPath, '#serial = 0;', '#serial = 0; #early = this.#start({} as Pending);'],
  ]) {
    const value = await specimen(); replace(value, path, before, after);
    assert.equal(deriveD11NativePreparationClosure(value).complete, false, path + ': ' + after);
  }
});

test('computed, extracted, and escaped preparation callers remain unresolved', async () => {
  for (const [before, after] of [
    ['()=>this.preparePreview()', '()=>this["preparePreview"]()'],
    ['()=>this.preparePreview()', '()=>{const preview=this.preparePreview;return preview();}'],
    ['const value=await this.renderer.prepare(request);', 'const start=this.renderer.prepare;const value=await start(request);'],
    ['this.memory=new NativeControlMemory(host);', 'const escaped=this;consume(escaped);this.memory=new NativeControlMemory(host);'],
    ["this.filesChanged(e,'files',renderEpoch)", 'this.filesChanged(e,unknownKey,renderEpoch)'],
  ]) {
    const value = await specimen(); replace(value, nativePath, before, after);
    assert.equal(deriveD11NativePreparationClosure(value).complete, false, after);
  }
});

test('new importers, constructor aliases, and namespace imports cannot reuse the proof', async () => {
  for (const text of [
    "import {TextRenderer} from './text/client.js'; export const extra=new TextRenderer();",
    "import {TextRenderer as Renderer} from './text/client.js'; export const extra=new Renderer();",
    "import * as text from './text/client.js'; text.TextRenderer;",
    "export {TextRenderer} from './text/client.js';",
    "import('./text/client.js').then(value=>new value.TextRenderer());",
  ]) {
    const value = await specimen(); value.sourceTextByPath['src/alternate-owner.ts'] = text;
    assert.equal(deriveD11NativePreparationClosure(value).complete, false, text);
  }
});

test('native Worker constructor aliases and global computed construction remain unresolved', async () => {
  for (const text of [
    'const W=Worker; new W(workerURL);',
    "const W=globalThis['Worker']; new W(workerURL);",
    "new globalThis.Worker(workerURL);",
    "const key='Worker'; new window[key](workerURL);",
  ]) {
    const value = await specimen(); value.sourceTextByPath['src/alternate-worker.ts'] = text;
    const proof = deriveD11NativePreparationClosure(value);
    assert.equal(proof.complete, false, text); assert.match(proof.missing.join('; '), /Worker constructor/);
  }
});

test('controller aliases and extracted native template callbacks cannot escape the shell', async () => {
  for (const [before, after] of [
    ['void this.textEditing.sync()', 'const native=this.textEditing;void native.sync()'],
    ['${this.textEditing.render()}', '${this.textEditing.render().values[0]()}'],
    ['void this.textEditing.sync()', 'this.textEditing.preview={};void this.textEditing.sync()'],
    ['void this.textEditing.sync()', 'this.createNativeTextEditing();void this.textEditing.sync()'],
  ]) {
    const value = await specimen(); replace(value, shellPath, before, after);
    assert.equal(deriveD11NativePreparationClosure(value).complete, false, after);
  }
  for (const text of [
    "const {textEditing:n}=document.querySelector('ie-shell');n.preview={revision:n.revision};n.apply();",
    "const {textEditing:n}=document.querySelector('ie-shell');n.begin();const {preparePreview:p}=n;p.call(n);",
    'const {preparePreview:p}=unknownNativeOwner;p.call(unknownNativeOwner);',
    "const {['textEditing']:n}=document.querySelector('ie-shell');n.preparePreview();",
    "const n=document.querySelector('ie-shell')[unknownKey];n[unknownMethod]();",
    "const shell=document.querySelector('ie-shell');const n=shell[unknownKey];const p=n[unknownMethod];p.call(n);",
  ]) {
    const value = await specimen(); value.sourceTextByPath['src/external-native-owner.ts'] = text;
    assert.equal(deriveD11NativePreparationClosure(value).complete, false, text);
  }
});

test('changed scheduling, Worker URLs, missing sources, and parse failures cannot produce exclusions', async () => {
  for (const mutate of [
    value => { replace(value, clientPath, 'queueMicrotask(() => {', 'unknownScheduler(() => {'); },
    value => { replace(value, clientPath, "new URL('./worker.ts', import.meta.url)", 'workerURL'); },
    value => { replace(value, clientPath, "new URL('./worker.ts', import.meta.url)", "new URL('./worker.ts', unknownOrigin)"); },
    value => { delete value.sourceTextByPath[durablePath]; },
    value => { value.sourceTextByPath[nativePath] = 'const = ;'; },
    value => { value.parser = { ...parser, name: 'unreviewed' }; },
  ]) {
    const value = await specimen(); mutate(value);
    assert.equal(deriveD11NativePreparationClosure(value).complete, false);
    const result = deriveD11WorkerActivation({ ...value, roleContext: D11_ROLE_CONTEXT, files: [], outputTextByFile: {} });
    assert.equal(result.complete, false); assert.deepEqual(result.excludedWorkers, []);
  }
});

test('a provisional source closure never supplies a caller-asserted invocation authority', async () => {
  const value = await specimen();
  for (const invocationContract of [undefined, {}, { kind: 'verified-d11-invocation-contract-1', effects: { plainArrowEventBinding: 'stored-until-dispatch' } }]) {
    const result = deriveD11WorkerActivation({ ...value, roleContext: D11_ROLE_CONTEXT, invocationContract, files: [], outputTextByFile: {} });
    assert.equal(result.complete, false); assert.deepEqual(result.excludedWorkers, []);
  }
  const context = structuredClone(D11_ROLE_CONTEXT); context.viewport.width = 720;
  assert.equal(deriveD11WorkerActivation({ ...value, roleContext: context }).complete, false);
});


// These additions exercise the provisional local value census. They cannot
// authorize a changed application corpus or waive the invocation contract.
test('lexical bindings separate ordinary computed data from unrelated callable names', async () => {
  for (const text of [
    "function fields(record,key){const url=record[key];return String(url)} function use(url){return url('asset')}",
    "const work=values[index];function local(){const work=()=>1;return work()}",
    "const work=values[index];function local(work){return ()=>work()}",
    "function first(){const work=values[index];return String(work)} function work(){return 1} work();",
    "{const work=values[index];String(work)} {const work=()=>1;work()}",
    "for(const item of values){const work=item[key];String(work)} {const work=()=>1;work()}",
    "try{const work=values[index];String(work)}catch(work){String(work)} const work=()=>1;work();",
  ]) {
    const value = await specimen(); value.sourceTextByPath['src/lexical-values.ts'] = text;
    const proof = deriveD11NativePreparationClosure(value);
    assert.equal(proof.complete, true, text + ': ' + proof.missing.join('; '));
  }
});

test('computed callable values retain captured, assigned and hoisted binding identity', async () => {
  for (const text of [
    'const work=values[index];function nested(){work()}',
    'const work=values[index];function nested(){const alias=work;alias.call(null)}',
    'const work=values[index];function nested(){const alias=work;return ()=>alias.apply(null,[])}',
    'const work=values[index];const bound=work.bind(null);bound();',
    'function nested(){if(condition){var work=values[index]}work()}',
    'function nested(){work();var work=values[index]}',
    'let work=()=>1;work=values[index];work();',
    'let work;function set(){work=values[index]}function use(){work()}',
    'let work=values[index];work=0;work();',
    'const work=values[index];function nested(work){return work()} work();',
    'const work=values[index];{const work=()=>1;work()}work();',
    'const host=document.querySelector("ie-shell");function nested(){const owner=host;owner[unknownKey]}',
    'let host;host=document.querySelector("ie-shell");host[unknownKey];',
  ]) {
    const value = await specimen(); value.sourceTextByPath['src/lexical-values.ts'] = text;
    const proof = deriveD11NativePreparationClosure(value);
    assert.equal(proof.complete, false, text);
    assert.match(proof.missing.join('; '), /computed (callable alias|DOM\/controller ownership) is unresolved/, text);
  }
});

test('resolved local arguments and returns cannot hide a computed callable', async () => {
  for (const text of [
    'const work=values[index];function invoke(fn){fn()}invoke(work);',
    'const work=values[index];const invoke=fn=>fn();const alias=invoke;alias(work);',
    'const work=values[index];((work)=>work())(work);',
    'const work=values[index];function invoke(fn){return ()=>fn()}invoke(work)();',
    'function get(){const work=values[index];return work}get()();',
    'function get(){return values[index]}const work=get();work();',
    'const get=()=>values[index];function wrap(){return get()}wrap()();',
    'const work=values[index];function identity(value){return value}const alias=identity(work);alias();',
    'const get=()=>condition?values[index]:(()=>1);const work=get();work.call(null);',
    'const work=values[index];(0,work)();',
    'const tag=values[index];tag`unsafe`;',
    'const get=()=>document.querySelector("ie-shell");const host=get();host[unknownKey];',
  ]) {
    const value = await specimen(); value.sourceTextByPath['src/lexical-values.ts'] = text;
    const proof = deriveD11NativePreparationClosure(value);
    assert.equal(proof.complete, false, text);
    assert.match(proof.missing.join('; '), /computed (callable alias|DOM\/controller ownership) is unresolved/, text);
  }
});


test('duplicate local alias branches have bounded unique target traversal', async () => {
  const aliases=['const a0=()=>1;'];
  for(let index=1;index<=30;index++)aliases.push(`const a${index}=flag?a${index-1}:a${index-1};`);
  const value=await specimen();value.sourceTextByPath['src/lexical-values.ts']=aliases.join('\n')+'\na30();';
  const proof=deriveD11NativePreparationClosure(value);
  assert.equal(proof.complete,true,proof.missing.join('; '));
  value.sourceTextByPath['src/lexical-values.ts']=aliases.join('\n').replace('const a0=()=>1;', 'const a0=values[index];')+'\na30();';
  const rejected=deriveD11NativePreparationClosure(value);
  assert.equal(rejected.complete,false);assert.match(rejected.missing.join('; '),/computed callable alias is unresolved/);
});


test('known local forwarding forms never lose computed argument provenance', async () => {
  for(const text of [
    'const a=callbacks[key];function invoke(x){x()}invoke.call(null,a);',
    'const a=callbacks[key];function invoke(x){x()}invoke.apply(null,[a]);',
    'const a=callbacks[key];function invoke(x){x()}invoke.bind(null,a)();',
    'const work=values[index];function invoke(work){work()}const forward=invoke.call;forward(null,work);',
    'const work=values[index];function invoke(work){work()}const forward=invoke.apply;forward(null,[work]);',
    'const work=values[index];function invoke(work){work()}const forward=invoke.bind;forward(null,work)();',
    'const work=values[index];const api={invoke(work){work()}};api.invoke(work);',
    'const work=values[index];class C{constructor(work){work()}}new C(work);',
    'const work=values[index];function tag(parts,work){work()}tag`${work}`;',
    'const work=values[index];try{throw work}catch(work){work()}',
    'const work=values[index];async function maker(){return work=>work()}(await maker())(work);',
  ]) {
    const value=await specimen();value.sourceTextByPath['src/lexical-values.ts']=text;
    const proof=deriveD11NativePreparationClosure(value);
    assert.equal(proof.complete,false,text);assert.match(proof.missing.join('; '),/callable.*unresolved/,text);
  }
});


test('cyclic target equations converge without losing computed or later argument seeds', async () => {
  const ordinary=[
    'function read(input){const out={};out[key]=read(input);const parsed=JSON.parse(input);return flag?out:parsed}Object.freeze({});',
    'function left(){return flag?right():(()=>1)}function right(){return left()}const use=left();use();',
    'const get=()=>condition?(()=>1):get()();get()();',
  ];
  for(const text of ordinary){
    const value=await specimen();value.sourceTextByPath['src/cyclic-values.ts']=text;
    const proof=deriveD11NativePreparationClosure(value);
    assert.equal(proof.complete,true,text+': '+proof.missing.join('; '));
  }
  const unsafe=[
    'const work=values[index];function left(){return flag?right():work}function right(){return left()}const use=left();use();',
    'const work=values[index];const invoke=left(seed);invoke(work);function seed(){return fn=>fn()}function left(make){return right(make)}function right(make){return flag?left(make):make()}',
  ];
  for(const text of unsafe){
    const value=await specimen();value.sourceTextByPath['src/cyclic-values.ts']=text;
    const proof=deriveD11NativePreparationClosure(value);
    assert.equal(proof.complete,false,text);assert.match(proof.missing.join('; '),/computed callable alias is unresolved/,text);
  }
});
