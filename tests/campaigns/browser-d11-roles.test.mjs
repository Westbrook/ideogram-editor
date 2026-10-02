import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSync } from 'rolldown/utils';
import { createRequire } from 'node:module';
import { deriveD11ApplicationStartup, deriveD11Roles } from '../../tooling/qualification/campaigns/browser-d11-roles.mjs';

const require = createRequire(import.meta.url);
const parser = { name: 'rolldown', version: require('rolldown/package.json').version, parseSync };
const hash = 'a'.repeat(64);
// Tiny AST/graph specimens exercise classification only; no runnable editor or
// browser observation is represented by these values.
function specimen() {
  const manifest = {
    'index.html': { file: 'assets/main.js', isEntry: true, dynamicImports: ['src/ui/shell.ts'], css: ['assets/main.css'] },
    'src/ui/shell.ts': { file: 'assets/shell.js', src: 'src/ui/shell.ts', isDynamicEntry: true, imports: ['_shared.js'], dynamicImports: ['src/ui/panels.ts'], css: ['assets/shell.css'], assets: ['assets/native.js', 'assets/authoring.ttf'] },
    '_shared.js': { file: 'assets/shared.js' },
    'src/ui/panels.ts': { file: 'assets/panels.js', src: 'src/ui/panels.ts', isDynamicEntry: true, imports: ['_shared.js'] },
  };
  const row = (file, kind, sources = [], extra = {}) => ({ file, kind, sources, modules: sources, authoringFont: false, ...extra });
  const files = [row('assets/main.js', 'js', ['src/main.ts']), row('assets/shell.js', 'js', ['src/ui/shell.ts']), row('assets/shared.js', 'js'),
    row('assets/panels.js', 'js', ['src/ui/panels.ts']), row('assets/native.js', 'js'), row('assets/runtime.js', 'js'),
    row('assets/main.css', 'css'), row('assets/shell.css', 'css'), row('assets/fonts.css', 'css'), row('assets/ui.woff2', 'font'),
    row('assets/authoring.ttf', 'font', [], { authoringFont: true }), row('assets/native.wasm', 'wasm', [], { sha256: 'sha256:' + hash, rawBytes: 8 }),
    row('inline:bootstrap', 'js')];
  const sourceTextByPath = {
    'src/main.ts': "try { const { mount } = await import('./ui/shell.js'); await mount(); } catch {}",
    'src/ui/shell.ts': "class Shell { panels() { return import('./panels.js'); } }",
    'src/ui/panels.ts': 'export const panels = [];',
    'src/text/profile.json': JSON.stringify({ engine: { wasm: { sha256: hash, bytes: 8 } } }),
  };
  const outputTextByFile = {
    'assets/main.js': "try { await preload(() => import('./shell.js')); } catch {}",
    'assets/shell.js': "import './shared.js'; class Shell { panels() { return import('./panels.js'); } text() { return new Worker(new URL('/assets/native.js', import.meta.url), { type: 'module' }); } }",
    'assets/shared.js': 'export const shared = 1;', 'assets/panels.js': "import './shared.js'; export const panels = [];",
    'assets/native.js': "import './runtime.js'; const bytes = new URL('/assets/native.wasm', location.href);",
    'assets/runtime.js': 'export const runtime = 1;',
    'assets/main.css': '@import "./fonts.css"; body{color:black}',
    'assets/fonts.css': '@font-face{font-family:ui;src:url("./ui.woff2")}',
    'assets/shell.css': '/* url("./missing.woff2") */ .shell{font-family:ui}',
    'inline:bootstrap': 'window.__PAIRING__="x";',
  };
  return { manifest, files, sourceTextByPath, outputTextByFile, parser };
}

function publicStartupSpecimen() {
  const f = specimen();
  f.roleContext = { kind: 'd11-role-context-1', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, boundary: 'document-ready-via-Open', workloads: ['W0', 'W1'], counting: 'union' };
  f.sourceTextByPath['src/main.ts'] = "try { const { mount } = await import('./ui/shell.js'); const pending = mount(); await pending; } catch {}";
  f.sourceTextByPath['src/ui/shell.ts'] = [
    "import { createElementScope } from '@en-reve/elements/element-scope.js';",
    "import { LitElement, html } from 'lit';",
    "import { EditorClient } from '../state/editor-client.js';",
    "const scope = createElementScope({ document, registry: 'auto' }); const editor = new EditorClient();",
    "class EditorShell extends LitElement {",
    "render() { return html`<en-button ?disabled=${false} @click=${()=>this.showPanel('open')}>Open</en-button>`; }",
    "showPanel(panel: string) { void editor.run('Open ' + panel, async()=>{ await this.panels(); }); }",
    "async panels() { await import('./panels.js'); }",
    "}",
    "scope.register([{ tagName: 'ie-shell', elementClass: EditorShell }]);",
    "export async function mount() { const shell = scope.createElement('ie-shell') as EditorShell; document.querySelector('#app')!.append(shell); await shell.updateComplete; }",
  ].join('\n');
  f.sourceTextByPath['src/state/editor-client.ts'] = 'export class EditorClient { async run(label: string, action: ()=>Promise<void>) { try { await action(); } catch {} } }';
  return f;
}

test('top-level try/await source import enters startup despite an emitted preload arrow', () => {
  const result = deriveD11Roles(specimen());
  assert.deepEqual(result.missing, []); assert.equal(result.complete, true);
  assert.deepEqual(result.startupFiles, ['assets/fonts.css', 'assets/main.css', 'assets/main.js', 'assets/shared.js', 'assets/shell.css', 'assets/shell.js', 'assets/ui.woff2', 'inline:bootstrap']);
  assert.deepEqual(result.lazyFeatures, [{ id: 'src/ui/panels.ts', files: ['assets/panels.js', 'assets/shared.js'] }]);
  assert.deepEqual(result.textEngineFiles, ['assets/native.js', 'assets/native.wasm', 'assets/runtime.js']);
  assert.deepEqual(result.uiCssFontFiles, ['assets/fonts.css', 'assets/main.css', 'assets/shell.css', 'assets/ui.woff2']);
});

test('function and method imports stay deferred while emitted top-level imports are eager', () => {
  const f = specimen();
  f.sourceTextByPath['src/main.ts'] = "function start() { return import('./ui/shell.js'); }";
  f.outputTextByFile['assets/main.js'] = "function start() { return import('./shell.js'); }";
  const deferred = deriveD11Roles(f);
  assert.equal(deferred.complete, true); assert(!deferred.startupFiles.includes('assets/shell.js'));
  assert(deferred.lazyFeatures.some(feature => feature.id === 'src/ui/shell.ts'));
  f.outputTextByFile['assets/main.js'] = "try { await import('./shell.js'); } catch {}";
  assert(deriveD11Roles(f).startupFiles.includes('assets/shell.js'));
});

test('dynamicEntry metadata alone never establishes a lazy role', () => {
  const f = specimen();
  f.sourceTextByPath['src/ui/shell.ts'] = 'export const shell=1;';
  f.outputTextByFile['assets/shell.js'] = f.outputTextByFile['assets/shell.js'].replace("return import('./panels.js');", 'return null;');
  const result = deriveD11Roles(f);
  assert.equal(result.complete, false); assert.equal(result.lazyFeatures.length, 0);
  assert.match(result.missing.join(' '), /lacks an AST import binding/);
});

test('WASM attribution uses exact AST URL and unique Worker graph rather than names', () => {
  const f = specimen();
  f.outputTextByFile['assets/native.js'] = "import './runtime.js'; const decoy='assets/native.wasm'; // /assets/native.wasm";
  const result = deriveD11Roles(f);
  assert.equal(result.complete, false); assert.deepEqual(result.textEngineFiles, []);
  assert.match(result.missing.join(' '), /absent or ambiguous emitted AST owners/);
  f.outputTextByFile['assets/native.js'] = "import './runtime.js'; const wasm='/assets/native.wasm';";
  f.outputTextByFile['assets/runtime.js'] = "export const duplicate='/assets/native.wasm';";
  assert.match(deriveD11Roles(f).missing.join(' '), /ambiguous emitted AST owners/);
});

test('WASM identity mismatch and computed Worker URL remain incomplete', () => {
  const f = specimen();
  f.files.find(file => file.kind === 'wasm').sha256 = 'sha256:' + 'b'.repeat(64);
  assert.match(deriveD11Roles(f).missing.join(' '), /exact sealed text WASM identity/);
  const computed = specimen();
  computed.outputTextByFile['assets/shell.js'] = computed.outputTextByFile['assets/shell.js'].replace("new URL('/assets/native.js', import.meta.url)", 'workerUrl');
  assert.match(deriveD11Roles(computed).missing.join(' '), /Worker URL has no exact emitted literal binding/);
});

test('startup authoring font bytes remain visible while their lazy-delivery invariant fails', () => {
  const f = specimen();
  f.outputTextByFile['assets/shell.css'] += '@font-face{font-family:authoring;src:url("./authoring.ttf")}';
  const result = deriveD11Roles(f);
  assert.equal(result.complete, false);
  assert(!result.uiCssFontFiles.includes('assets/authoring.ttf'));
  assert(result.startupFiles.includes('assets/authoring.ttf'));
  assert(!result.startupFiles.includes('assets/native.js'));
  assert.match(result.missing.join(' '), /lazy-delivery invariant violated: authoring font/);
});

test('lazy closures exclude the separate engine graph and omit engine-only features', () => {
  const f = specimen();
  f.manifest['_native.js'] = { file: 'assets/native.js', isDynamicEntry: true };
  f.outputTextByFile['assets/shell.js'] += "function native() { return import('./native.js'); }";
  f.outputTextByFile['assets/panels.js'] += "import './runtime.js';";
  const result = deriveD11Roles(f);
  assert.equal(result.complete, true);
  assert.deepEqual(result.lazyFeatures, [{ id: 'src/ui/panels.ts', files: ['assets/panels.js', 'assets/shared.js'] }]);
  assert(result.textEngineFiles.includes('assets/runtime.js'));
});

test('new receipts retain the complete closure and subtract only independently budgeted engine files', () => {
  const f = specimen(); f.invocationContract = null;
  f.outputTextByFile['assets/panels.js'] += "import './runtime.js';";
  const result = deriveD11Roles(f);
  assert.equal(result.complete, true);
  const feature = result.lazyFeatures.find(value => value.id === 'src/ui/panels.ts');
  assert.deepEqual(feature.closureFiles, ['assets/panels.js','assets/runtime.js','assets/shared.js']);
  assert.deepEqual(feature.files, feature.closureFiles.filter(file => !result.textEngineFiles.includes(file)));
  assert.deepEqual(result.excludedImports, []); assert.deepEqual(result.excludedWorkers, []);
});

test('ordinary uncertain imports may be startup upper bounds without losing their feature budget rows', () => {
  const f = specimen(); f.invocationContract = null;
  f.sourceTextByPath['src/ui/shell.ts'] = "export class Shell { panels() { return import('./panels.js'); } }";
  const result = deriveD11Roles(f);
  assert.equal(result.complete, true); assert(result.startupFiles.includes('assets/panels.js'));
  assert(result.lazyFeatures.some(value => value.id === 'src/ui/panels.ts'));
  assert.equal(result.startupUpperBounds.length, 1);
  assert.equal(result.startupUpperBounds[0].reason, 'unresolved-invocation-conservatively-charged');
  assert.equal(result.startupUpperBounds[0].source, 'src/ui/shell.ts');
  assert.deepEqual(result.startupUpperBounds[0].files, ['assets/panels.js','assets/shared.js']);
});

test('ordinary upper bounds cannot silently promote an engine closure or clear unrelated missing input', () => {
  const f = specimen(); f.invocationContract = null;
  f.sourceTextByPath['src/ui/shell.ts'] = "export class Shell { panels() { return import('./panels.js'); } }";
  f.outputTextByFile['assets/panels.js'] += "import './runtime.js';";
  const result = deriveD11Roles(f);
  assert.equal(result.complete, false); assert(!result.startupFiles.includes('assets/panels.js'));
  assert.match(result.missing.join(' '), /ambiguous invocation boundary/);
  assert.deepEqual(result.startupUpperBounds, []);
  const missing = specimen(); missing.invocationContract = null; delete missing.outputTextByFile['assets/shared.js'];
  assert.match(deriveD11Roles(missing).missing.join(' '), /verified AST text is absent/);
});

test('nonnull invocation profiles charge all startup-origin import sites without inferring whole-program deferral', () => {
  const f = specimen(); f.invocationContract = {};
  // This incomplete provenance cannot grant any exclusion. Charging ordinary
  // bytes requires no callback authority; the separate Worker stays missing.
  f.sourceTextByPath['src/ui/shell.ts'] = "function make(){return {go(){return import('./panels.js')}}}make().go();";
  f.outputTextByFile['assets/shell.js'] = "import './shared.js';function make(){return {go(){return import('./panels.js')}}}make().go();function text(){return new Worker(new URL('/assets/native.js',import.meta.url));}";
  const result = deriveD11Roles(f);
  assert(result.startupFiles.includes('assets/panels.js'));
  assert(result.lazyFeatures.some(value=>value.id==='src/ui/panels.ts'));
  assert(result.startupUpperBounds.some(value=>value.target==='assets/panels.js'&&value.policy==='all-startup-origin-sites'));
  assert.equal(result.complete,false); assert.deepEqual(result.excludedWorkers,[]);
});

test('startup engine overlap is retained and explicitly violates lazy delivery', () => {
  for (const statement of ["import './runtime.js';", "new Worker(new URL('/assets/native.js', import.meta.url));"]) {
    const f = specimen(); f.outputTextByFile['assets/main.js'] += statement;
    const result = deriveD11Roles(f);
    assert.equal(result.complete, false); assert(result.startupFiles.includes('assets/runtime.js'));
    assert.match(result.missing.join(' '), /lazy-delivery invariant violated: text engine/);
    assert(result.textEngineFiles.includes('assets/runtime.js'));
  }
});

test('top-level IIFEs, named bootstrap chains, aliases and local object methods are eager', () => {
  for (const main of ["(async () => { await import('./shell.js'); })();",
    "(function () { return import('./shell.js'); })();",
    "function boot() { return inner(); } function inner() { return import('./shell.js'); } boot();",
    "const boot = () => import('./shell.js'); const start = boot; start();",
    "const boot = () => import('./shell.js'); boot.call(null);",
    "const app = { start() { return import('./shell.js'); } }; app.start();"]) {
    const f = specimen(); f.sourceTextByPath['src/main.ts'] = 'export const main = 1;'; f.outputTextByFile['assets/main.js'] = main;
    const result = deriveD11Roles(f);
    assert.equal(result.complete, true, main + ': ' + result.missing.join('; '));
    assert(result.startupFiles.includes('assets/shell.js'), main);
    assert(!result.lazyFeatures.some(feature => feature.id === 'src/ui/shell.ts'), main);
  }
});

test('callbacks with unproved invocation contracts cannot claim a lazy startup boundary', () => {
  for (const main of ["dispatch(() => import('./shell.js'));",
    "function load() { return import('./shell.js'); } dispatch(load);",
    "function boot() { dispatch(() => import('./shell.js')); } boot();",
    "function factory() { return () => import('./shell.js'); } factory()();"]) {
    const f = specimen(); f.sourceTextByPath['src/main.ts'] = 'export const main = 1;'; f.outputTextByFile['assets/main.js'] = main;
    const result = deriveD11Roles(f);
    assert.equal(result.complete, false, main);
    assert.match(result.missing.join(' '), /ambiguous invocation boundary/, main);
  }
});

test('tagged callbacks and destructured callable aliases cannot silently look deferred', () => {
  for (const main of [
    "const go=()=>import('./shell.js'); const tag=(strings,callback)=>callback(); tag`${go}`;",
    "const {go}={go:()=>import('./shell.js')}; go();",
    "const [go]=[()=>import('./shell.js')]; go();",
    "const {go=()=>import('./shell.js')}={}; go();",
  ]) {
    const f = specimen(); f.sourceTextByPath['src/main.ts'] = 'export const main = 1;'; f.outputTextByFile['assets/main.js'] = main;
    const result = deriveD11Roles(f);
    assert.equal(result.complete, false, main);
    assert.match(result.missing.join(' '), /ambiguous invocation boundary/, main);
  }
});

test('constructed receivers, getter reads and computed class keys run in their owning boundary', () => {
  for (const main of [
    "class Boot { go(){return import('./shell.js')} } new Boot().go();",
    "class Boot { go(){return import('./shell.js')} } const boot=new Boot(); boot.go();",
    "const boot={get loaded(){return import('./shell.js')}}; boot.loaded;",
    "class Boot { get loaded(){return import('./shell.js')} } new Boot().loaded;",
    "class Boot { [await import('./shell.js')](){} }",
    "class Boot { [await import('./shell.js')]=1; }",
  ]) {
    const f = specimen(); f.sourceTextByPath['src/main.ts'] = 'export const main = 1;'; f.outputTextByFile['assets/main.js'] = main;
    const result = deriveD11Roles(f);
    assert.equal(result.complete, true, main + ': ' + result.missing.join('; '));
    assert(result.startupFiles.includes('assets/shell.js'), main);
  }
});

test('local inherited methods and getters retain their defining scope and startup closure', () => {
  for (const main of [
    "class Base { go(){return import('./shell.js')} } class Boot extends Base {} new Boot().go();",
    "class Base { go(){return import('./shell.js')} } class Middle extends Base {} class Boot extends Middle {} const boot=new Boot(); boot.go();",
    "class Base { get loaded(){return import('./shell.js')} } class Boot extends Base {} new Boot().loaded;",
    "class Base { static get loaded(){return import('./shell.js')} } class Boot extends Base {} Boot.loaded;",
    "class Base { go(){return import('./shell.js')} } class Boot extends Base {} function start(){const Base=class {go(){}};new Boot().go();} start();",
  ]) {
    const f = specimen(); f.sourceTextByPath['src/main.ts'] = 'export const main = 1;'; f.outputTextByFile['assets/main.js'] = main;
    const result = deriveD11Roles(f);
    assert.equal(result.complete, true, main + ': ' + result.missing.join('; '));
    assert(result.startupFiles.includes('assets/shell.js'), main);
  }
});

test('unresolved bases retain uncertainty for local overrides and factory-returned classes', () => {
  for (const main of [
    "class Boot extends unknownBase { go(){return import('./shell.js')} } new Boot();",
    "function choose(){return class {go(){return import('./shell.js')}}} class Boot extends choose() {} new Boot().go();",
    "function choose(){return class {get loaded(){return import('./shell.js')}}} const Parent=choose(); class Boot extends Parent {} new Boot().loaded;",
  ]) {
    const f = specimen(); f.sourceTextByPath['src/main.ts'] = 'export const main = 1;'; f.outputTextByFile['assets/main.js'] = main;
    const result = deriveD11Roles(f);
    assert.equal(result.complete, false, main);
    assert.match(result.missing.join(' '), /ambiguous invocation boundary/, main);
  }
});

test('worker aliases cannot borrow a separate deferred worker graph to appear lazy', () => {
  for (const main of [
    "const W=Worker; new W(new URL('/assets/native.js',import.meta.url)); await import('./shell.js');",
    "new globalThis.Worker(new URL('/assets/native.js',import.meta.url)); await import('./shell.js');",
    "new SharedWorker(new URL('/assets/native.js',import.meta.url)); await import('./shell.js');",
  ]) {
    const f = specimen(); f.sourceTextByPath['src/main.ts'] = 'export const main = 1;'; f.outputTextByFile['assets/main.js'] = main;
    const result = deriveD11Roles(f);
    assert(result.textEngineFiles.includes('assets/native.wasm'), 'The independent literal Worker graph must still bind the engine');
    assert.equal(result.complete, false, main);
    assert.match(result.missing.join(' '), /Worker constructor reference lacks a reviewed invocation binding/, main);
  }
});

function lazyCssSpecimen() {
  const f = specimen();
  f.manifest['src/ui/panels.ts'].css = ['assets/feature.css'];
  for (const [file, kind] of [['assets/feature.css', 'css'], ['assets/feature-nested.css', 'css'], ['assets/ui-copy.woff2', 'font'], ['assets/feature.png', 'other']]) {
    f.files.push({ file, kind, sources: [], modules: [], authoringFont: false });
  }
  // Equal content identities at separate emitted paths remain two artifacts.
  for (const file of f.files.filter(row => ['assets/ui.woff2', 'assets/ui-copy.woff2'].includes(row.file))) Object.assign(file, { sha256: 'sha256:' + 'b'.repeat(64), rawBytes: 5 });
  f.outputTextByFile['assets/feature.css'] = '@import "./feature-nested.css"; .feature{background:url("./feature.png")}';
  f.outputTextByFile['assets/feature-nested.css'] = '@import "./feature.css"; @font-face{font-family:shared;src:url("./ui.woff2")} @font-face{font-family:copy;src:url("./ui-copy.woff2")}';
  return f;
}

test('lazy feature CSS follows nested imports and assets while retaining shared and duplicate paths', () => {
  const result = deriveD11Roles(lazyCssSpecimen());
  assert.equal(result.complete, true, result.missing.join('; '));
  assert.deepEqual(result.lazyFeatures.find(feature => feature.id === 'src/ui/panels.ts').files,
    ['assets/feature-nested.css', 'assets/feature.css', 'assets/feature.png', 'assets/panels.js', 'assets/shared.js', 'assets/ui-copy.woff2', 'assets/ui.woff2']);
  assert(result.startupFiles.includes('assets/ui.woff2'));
  assert(!result.startupFiles.includes('assets/feature.css'));
  assert(!result.uiCssFontFiles.includes('assets/ui-copy.woff2'));
});

test('missing or ambiguous lazy CSS dependencies leave the full role proof incomplete', () => {
  for (const mutate of [
    f => { delete f.outputTextByFile['assets/feature-nested.css']; },
    f => { f.outputTextByFile['assets/feature-nested.css'] = '@import "./missing.css";'; },
    f => { f.outputTextByFile['assets/feature-nested.css'] = '@font-face{src:url("./missing.woff2")}'; },
    f => { f.outputTextByFile['assets/feature-nested.css'] = '@import "./unterminated.css'; },
  ]) {
    const f = lazyCssSpecimen(); mutate(f); const result = deriveD11Roles(f);
    assert.equal(result.complete, false);
    assert.match(result.missing.join(' '), /lazy feature.*CSS/);
  }
});

test('class static initialization, construction, and constructor method calls cannot look lazy', () => {
  for (const main of ["class Boot { static loaded = import('./shell.js'); }",
    "class Boot { static { import('./shell.js'); } }",
    "class Boot { static { this.load(); } static load() { return import('./shell.js'); } }",
    "class Boot { constructor() { import('./shell.js'); } } new Boot();",
    "class Boot { loaded = import('./shell.js'); } new Boot();",
    "class Boot { constructor() { this.load(); } load() { return import('./shell.js'); } } new Boot();",
    "class Base { constructor() { import('./shell.js'); } } class Boot extends Base {} new Boot();"]) {
    const f = specimen(); f.sourceTextByPath['src/main.ts'] = 'export const main = 1;'; f.outputTextByFile['assets/main.js'] = main;
    const result = deriveD11Roles(f);
    assert.equal(result.complete, true, main + ': ' + result.missing.join('; ')); assert(result.startupFiles.includes('assets/shell.js'), main);
  }
  const f = specimen(); f.sourceTextByPath['src/main.ts'] = 'export const main = 1;';
  f.outputTextByFile['assets/main.js'] = "class Boot { load = () => import('./shell.js'); } new Boot();";
  const result = deriveD11Roles(f); assert.equal(result.complete, true); assert(!result.startupFiles.includes('assets/shell.js'));
});

test('exported and escaping function or class values require invocation proof', () => {
  for (const main of ["export function load() { return import('./shell.js'); }",
    "function load() { return import('./shell.js'); } export { load };",
    "export class Boot { load() { return import('./shell.js'); } }",
    "class Boot { load() { return import('./shell.js'); } } register([{ elementClass: Boot }]);",
    "const load = () => import('./shell.js'); window.start = load;",
    "class Boot { loaded = import('./shell.js'); }"]) {
    const f = specimen(); f.sourceTextByPath['src/main.ts'] = 'export const main = 1;'; f.outputTextByFile['assets/main.js'] = main;
    const result = deriveD11Roles(f);
    assert.equal(result.complete, false, main); assert.match(result.missing.join(' '), /ambiguous invocation boundary/, main);
  }
});

test('missing verified source, parse errors, computed imports and ambiguous source mapping fail closed', () => {
  for (const mutate of [f => { delete f.sourceTextByPath['src/main.ts']; },
    f => { f.outputTextByFile['assets/main.js'] = 'const = ;'; },
    f => { f.outputTextByFile['assets/main.js'] = 'await import(runtimePath);'; },
    f => { f.files.find(row => row.file === 'assets/shared.js').sources.push('src/ui/shell.ts'); },
    f => { f.outputTextByFile['assets/fonts.css'] = '@font-face{src:url("./missing.woff2")}'; },
    f => { f.parser = { name: 'typescript', version: '7.0.2', parseSync }; }]) {
    const f = specimen(); mutate(f); assert.equal(deriveD11Roles(f).complete, false);
  }
});

test('classification is deterministic and leaves all supplied graph data unchanged', () => {
  const f = specimen(), before = JSON.stringify(f), result = deriveD11Roles(f);
  assert.deepEqual(deriveD11Roles(f), result); assert.equal(JSON.stringify(f), before);
});

test('the declared document-ready public Open trace positively adds the panel import', () => {
  const f = publicStartupSpecimen(), before = JSON.stringify(f), proof = deriveD11ApplicationStartup(f);
  assert.deepEqual(proof.missing, []); assert.equal(proof.complete, true);
  assert.deepEqual(proof.startupFiles, ['assets/panels.js']);
  assert.deepEqual(proof.witnesses, [{ entry: 'src/main.ts', shell: 'src/ui/shell.ts', className: 'EditorShell', editor: 'src/state/editor-client.ts', tag: 'ie-shell', exportedMount: 'mount', openMethod: 'showPanel', dispatchMethod: 'run', panelMethod: 'panels', target: 'src/ui/panels.ts' }]);
  assert.equal(JSON.stringify(f), before);
});

test('public startup proof follows bindings rather than feature or method name allowlists', () => {
  const f = publicStartupSpecimen();
  f.sourceTextByPath['src/main.ts'] = f.sourceTextByPath['src/main.ts'].replaceAll('mount', 'attachEditor');
  f.sourceTextByPath['src/ui/shell.ts'] = f.sourceTextByPath['src/ui/shell.ts'].replaceAll('mount', 'attachEditor').replaceAll('showPanel', 'requestDialog').replaceAll('this.panels', 'this.loadControls').replace('async panels()', 'async loadControls()').replaceAll('ie-shell', 'custom-editor');
  const proof = deriveD11ApplicationStartup(f); assert.equal(proof.complete, true); assert.deepEqual(proof.startupFiles, ['assets/panels.js']);
  assert.equal(proof.witnesses[0].tag, 'custom-editor'); assert.equal(proof.witnesses[0].panelMethod, 'loadControls');
});

test('a changed viewport, registration, callback dispatcher, or import trace cannot reuse the proof', () => {
  for (const mutate of [f => { f.roleContext.viewport.width = 900; },
    f => { f.roleContext.boundary = 'shell-mounted-before-input'; },
    f => { f.sourceTextByPath['src/main.ts'] = f.sourceTextByPath['src/main.ts'].replace('mount();', 'Promise.resolve();'); },
    f => { f.sourceTextByPath['src/ui/shell.ts'] = f.sourceTextByPath['src/ui/shell.ts'].replace("registry: 'auto'", "registry: foreignRegistry"); },
    f => { f.sourceTextByPath['src/ui/shell.ts'] = f.sourceTextByPath['src/ui/shell.ts'].replace('const scope =', 'let scope ='); },
    f => { f.sourceTextByPath['src/ui/shell.ts'] += '\nscope.register = substitute;'; },
    f => { f.sourceTextByPath['src/ui/shell.ts'] += '\nconst alias = scope; alias.register = substitute;'; },
    f => { f.sourceTextByPath['src/ui/shell.ts'] += '\nfunction intercept(scope: unknown) { return scope; }'; },
    f => { f.sourceTextByPath['src/ui/shell.ts'] += '\neditor.run = substitute;'; },
    f => { f.sourceTextByPath['src/ui/shell.ts'] += '\nEditorShell.prototype.showPanel = substitute;'; },
    f => { f.sourceTextByPath['src/main.ts'] += '\nfunction intercept(mount: unknown) { return mount; }'; },
    f => { f.sourceTextByPath['src/ui/shell.ts'] = f.sourceTextByPath['src/ui/shell.ts'].replace("createElement('ie-shell')", "createElement('different')"); },
    f => { f.sourceTextByPath['src/ui/shell.ts'] = f.sourceTextByPath['src/ui/shell.ts'].replace('append(shell)', 'append(other)'); },
    f => { f.sourceTextByPath['src/ui/shell.ts'] = f.sourceTextByPath['src/ui/shell.ts'].replace('>Open</en-button>', '>Other</en-button>'); },
    f => { f.sourceTextByPath['src/state/editor-client.ts'] = 'export class EditorClient { run(label: string, action: ()=>Promise<void>) { retain(action); } }'; },
    f => { f.sourceTextByPath['src/state/editor-client.ts'] = 'export class EditorClient { async run(label: string, action: ()=>Promise<void>) { action = replacement; await action(); } }'; },
    f => { f.sourceTextByPath['src/ui/shell.ts'] = f.sourceTextByPath['src/ui/shell.ts'].replace("await import('./panels.js');", "await import('./panels.js'); await import('./extra.js');"); }]) {
    const f = publicStartupSpecimen(); mutate(f); const proof = deriveD11ApplicationStartup(f);
    assert.equal(proof.complete, false); assert.deepEqual(proof.startupFiles, []);
  }
});

test('a positive application trace cannot bypass the independent registration contract', () => {
  const f = publicStartupSpecimen();
  f.sourceTextByPath['package-lock.json'] = '{"lockfileVersion":3,"packages":{}}';
  f.registrationContract = { kind: 'invented' };
  const result = deriveD11Roles(f);
  assert.equal(result.complete, false);
  assert.match(result.missing.join(' '), /registration contract could not be verified/);
  assert(!result.startupFiles.includes('assets/panels.js'));
});

// Attribution alone remains an upper bound unless the real compiler/corpus and
// all emitted bytes authenticate. Tiny specimens cannot grant that authority.
test('source-only static attributions remain conservative without authentic compiled graph authority', () => {
  for (const contract of ['legacy', null, {}]) {
    const f = specimen();
    f.sourceTextByPath['src/ui/panels.ts'] = "import './shell.js'; export const panels = [];";
    if (contract !== 'legacy') f.invocationContract = contract;
    // Caller-created graph/effect summaries must not activate the refined path.
    f.staticImportGraph = { kind: 'd11-emitted-static-graph-1', omittedSourceAttributions: [] };
    const result = deriveD11Roles(f);
    assert.equal(Object.hasOwn(result, 'staticImportGraph'), false);
    const feature = result.lazyFeatures.find(value => value.id === 'src/ui/panels.ts');
    assert(feature.files.includes('assets/shell.js'));
    assert(feature.files.includes('assets/shared.js'));
    if (contract === 'legacy' || contract === null) assert.equal(result.complete, true, result.missing.join('; '));
    else assert.equal(result.complete, false);
    if (contract && typeof contract === 'object') assert.match(result.missing.join('; '), /emitted static graph authority is unavailable/);
  }
});

test('unresolved emitted static imports and reexports cannot be a complete authenticated census', () => {
  for (const statement of ["import 'external-package';", "export * from 'https://example.invalid/external.js';", "import './missing.js';", "export { value } from './missing.js';"]) {
    const f = specimen(); f.invocationContract = {};
    f.outputTextByFile['assets/panels.js'] += '\n' + statement;
    const result = deriveD11Roles(f);
    assert.equal(result.complete, false, statement);
    assert.equal(Object.hasOwn(result, 'staticImportGraph'), false, statement);
    assert.match(result.missing.join('; '), /emitted static import is unresolved/, statement);
  }
});

test('manifest and emitted static edges each retain complete shared feature dependencies', () => {
  for (const origin of ['manifest', 'emitted', 'both']) {
    const f = specimen();
    if (origin !== 'emitted') f.manifest['src/ui/panels.ts'].imports.push('src/ui/shell.ts');
    if (origin !== 'manifest') f.outputTextByFile['assets/panels.js'] += "\nexport * from './shell.js';";
    const result = deriveD11Roles(f);
    assert.equal(result.complete, true, result.missing.join('; '));
    const feature = result.lazyFeatures.find(value => value.id === 'src/ui/panels.ts');
    assert(feature.files.includes('assets/shell.js'), origin);
    assert(feature.files.includes('assets/shared.js'), origin);
    assert.equal(feature.files.filter(file => file === 'assets/shared.js').length, 1, origin);
  }
});
