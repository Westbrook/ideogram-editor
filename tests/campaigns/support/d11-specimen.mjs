import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { VERSION as rolldownVersion } from 'rolldown';
import { parseSync } from 'rolldown/utils';
import { analyzeD11Observation } from '../../../tooling/qualification/campaigns/browser-d11.mjs';
import { deriveD11StaticDocument } from '../../../tooling/qualification/campaigns/browser-d11-build.mjs';
import { deriveD11Roles } from '../../../tooling/qualification/campaigns/browser-d11-roles.mjs';
import { D11_ROLE_CONTEXT, prepareD11RegistrationContract, verifyD11RegistrationContract } from '../../../tooling/qualification/campaigns/browser-d11-registration.mjs';

const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(sortKeys(value));
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]));
}
const source = (path, bytes) => ({ path, rawBytes: Buffer.byteLength(bytes), sha256: hash(bytes) });
const prelude = 'globalThis.bootstrapObserved=true;';
const compiledStatic = [
  "import { readFile } from 'node:fs/promises';",
  "import { join } from 'node:path';",
  'export const BOOTSTRAP_PRELUDE = `' + prelude + '`;',
  'export async function loadStatic(directory) {',
  'const files = new Map();',
  "let html = await readFile(join(directory, 'index.html'), 'utf8');",
  'const resources = [];',
  "html = html.replace(/<script\\b[^>]*\\bsrc=[^>]*><\\/script>|<link\\b[^>]*>/gi, tag => { resources.push(tag); return ''; });",
  "html = html.replace(/<\\/head>/i, `<template id=\"ie-resources\">${resources.join('')}</template></head>`);",
  'html = html.replace(/<head(?:\\s[^>]*)?>/i, match => `${match}<script>${BOOTSTRAP_PRELUDE}</script>`);',
  "files.set('/', { bytes: Buffer.from(html), type: 'text/html; charset=utf-8' });",
  'return files;',
  '}',
].join('\n');
const inputPaths = { buildEvidence: 'dist/app/build-evidence.json', manifest: 'dist/app/.vite/manifest.json',
  lock: 'package-lock.json', textManifest: 'vendor/text/manifest.json', textProfile: 'src/text/profile.json',
  staticSource: 'server/static.ts', staticModule: 'dist/local/server/static.js', index: 'dist/app/index.html' };
const pathOrder = (left, right) => left.path.localeCompare(right.path);
const fileOrder = (left, right) => left.file.localeCompare(right.file);
function emitted(file, kind, bytes, { modules = [], sources = [], authoringFont = false } = {}) {
  const gzipBytes = gzipSync(bytes).length;
  return { file, kind, rawBytes: Buffer.byteLength(bytes), sha256: hash(bytes), gzipBytes, computedGzipBytes: gzipBytes,
    modules, sources, authoringFont };
}

let registrationInputs, initialization;
/** Explicit test setup only: importing this module reads no files and registers
 * no tests. The authentic vendored contract cannot be replaced with invented
 * archive/member bytes; all subsequent packet construction is in memory. */
export function initializeD11Specimen() {
  initialization ??= (async () => {
    const repo = resolve(fileURLToPath(new URL('../../../', import.meta.url))), reads = new Map();
    const read = async (path, maximum) => {
      if (reads.has(path)) {
        const cached = reads.get(path);
        if (cached.bytes.length > maximum) throw Error('D11 test input exceeds its bound');
        return cached;
      }
      const handle = await open(join(repo, path), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size > maximum) throw Error('D11 test input must be a bounded ordinary file');
        const bytes = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!bytesRead) throw Error('D11 test input shortened while reading');
          offset += bytesRead;
        }
        const after = await handle.stat();
        if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => before[key] !== after[key])) throw Error('D11 test input changed while reading');
        const value = { bytes }; reads.set(path, value); return value;
      } finally { await handle.close(); }
    };
    const contract = await prepareD11RegistrationContract({ repo, read });
    const lock = JSON.parse((await read('package-lock.json', 16 * 1048576)).bytes.toString('utf8'));
    const verified = verifyD11RegistrationContract(contract, { lock });
    const names = ['@en-reve/elements', '@en-reve/primitives'];
    registrationInputs = { contract, inputs: verified.inputs,
      dependencies: Object.fromEntries(names.map(name => [name, lock.packages[''].dependencies[name]])),
      packages: Object.fromEntries(names.map(name => ['node_modules/' + name, lock.packages['node_modules/' + name]])) };
  })();
  return initialization;
}

// Tiny in-memory source and emitted bytes exercise retained-evidence integrity
// only. They are not editor builds, qualification fixtures, or browser evidence.
function specimen({ fixtureSeal = hash('fixture') } = {}) {
  if (!registrationInputs) throw Error('Call initializeD11Specimen() from explicit test setup first');
  const index = '<!doctype html><head><script src="/assets/main.js"></script><link rel="stylesheet" href="/assets/ui.css"></head><body></body>';
  const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]), font = Buffer.from('authoring font specimen');
  const profile = { engine: { wasm: { bytes: wasm.length, sha256: hash(wasm).slice(7) } },
    fonts: [{ file: 'fonts/authoring.ttf', bytes: font.length, sha256: hash(font).slice(7) }] };
  const lock = { lockfileVersion: 3, packages: { '': { name: 'd11-verification-specimen', version: '1.0.0', dependencies: structuredClone(registrationInputs.dependencies) },
    ...structuredClone(registrationInputs.packages),
    'node_modules/rolldown': { version: rolldownVersion }, 'node_modules/example': { version: '1.0.0' },
    'node_modules/other': { version: '1.0.0' }, 'node_modules/other/node_modules/example': { version: '2.0.0' } } };
  const manifest = { 'index.html': { file: 'assets/main.js', isEntry: true, dynamicImports: ['src/ui/shell.ts', 'src/ui/feature.ts'], css: ['assets/ui.css'] },
    'src/ui/shell.ts': { file: 'assets/shell.js', src: 'src/ui/shell.ts', isDynamicEntry: true, imports: ['src/ui/editor.ts'], dynamicImports: ['src/ui/panels.ts'] },
    'src/ui/editor.ts': { file: 'assets/editor.js', src: 'src/ui/editor.ts' },
    'src/ui/panels.ts': { file: 'assets/panels.js', src: 'src/ui/panels.ts', isDynamicEntry: true },
    'src/ui/feature.ts': { file: 'assets/feature.js', src: 'src/ui/feature.ts', isDynamicEntry: true },
    'vendor/text/fonts/authoring.ttf': { file: 'assets/authoring.ttf', src: 'vendor/text/fonts/authoring.ttf' } };
  const shell = [
    'import { LitElement, html } from "lit";',
    'import { createElementScope } from "@en-reve/elements/element-scope.js";',
    'import { Editor } from "./editor.js";',
    'const editor = new Editor();',
    'const scope = createElementScope({ document, registry: "auto" });',
    'class Shell extends LitElement {',
    'render() { return html`<en-button @click=${() => this.launch("open")}>Open</en-button>`; }',
    'async launch(action) { await editor.run(action, async () => { await this.showPanel(); }); }',
    'async showPanel() { const panels = await import("./panels.js"); return panels; }',
    '}',
    'scope.register([{ tagName: "test-shell", elementClass: Shell }]);',
    'export async function mount() { const shell = scope.createElement("test-shell"); document.body.append(shell); await shell.updateComplete; }',
  ].join('\n');
  const sourceText = { 'index.html': index, 'vite.app.config.ts': 'export default {};', 'tsconfig.json': '{}', 'tsconfig.app.json': '{}',
    'package.json': '{"name":"d11-verification-specimen","type":"module"}', 'package-lock.json': JSON.stringify(lock),
    '.progress-report/project.json': '{}', 'tooling/build-evidence.ts': 'export const schema = 1;',
    'vendor/text/manifest.json': JSON.stringify(profile), 'src/text/profile.json': JSON.stringify(profile),
    'src/main.ts': 'function openFeature() { return import("./ui/feature.js"); } const { mount } = await import("./ui/shell.js"); const ready = mount(); await ready;',
    'src/ui/shell.ts': shell, 'src/ui/editor.ts': 'export class Editor { async run(action, callback) { await callback(); } }',
    'src/ui/panels.ts': 'export const panels = [];',
    'src/ui/feature.ts': 'export const feature = 1;', 'src/text/worker.ts': 'export const worker = 1;',
    'tooling/theme/ui.css': '@font-face{font-family:ui;src:url("./ui.woff2")}body{font-family:ui}' };
  const outputText = { 'assets/main.js': 'function openFeature() { return import("./feature.js"); } const { mount } = await import("./shell.js"); const ready = mount(); await ready;',
    'assets/shell.js': shell, 'assets/editor.js': sourceText['src/ui/editor.ts'], 'assets/panels.js': sourceText['src/ui/panels.ts'],
    'assets/feature.js': 'export function text() { return new Worker(new URL("/assets/worker.js", import.meta.url), { type: "module" }); }',
    'assets/worker.js': 'const wasm = new URL("/assets/text.wasm", location.href);',
    'assets/ui.css': sourceText['tooling/theme/ui.css'] };
  const files = [emitted('assets/main.js', 'js', outputText['assets/main.js'], { modules: ['src/main.ts'], sources: ['src/main.ts'] }),
    ...['shell', 'editor', 'panels'].map(name => emitted(`assets/${name}.js`, 'js', outputText[`assets/${name}.js`],
      { modules: [`src/ui/${name}.ts`], sources: [`src/ui/${name}.ts`] })),
    emitted('assets/feature.js', 'js', outputText['assets/feature.js'], { modules: ['src/ui/feature.ts'], sources: ['src/ui/feature.ts'] }),
    emitted('assets/worker.js', 'js', outputText['assets/worker.js'], { modules: ['src/text/worker.ts'], sources: ['src/text/worker.ts'] }),
    emitted('assets/ui.css', 'css', outputText['assets/ui.css']), emitted('assets/ui.woff2', 'font', Buffer.from('UI font specimen')),
    emitted('assets/text.wasm', 'wasm', wasm),
    emitted('assets/authoring.ttf', 'font', font, { sources: ['vendor/text/fonts/authoring.ttf'], authoringFont: true })];
  const sourceInputs = Object.entries(sourceText).map(([path, bytes]) => source(path, bytes)).sort(pathOrder);
  const evidence = { schema: 1, capture: { phase: 'writeBundle', finalized: true }, toolchain: { node: '26.10.0', npm: '12.1.0' },
    sourceInputs: sourceInputs.map(row => ({ path: row.path, bytes: row.rawBytes, sha256: row.sha256.slice(7) })),
    outputs: files.map(row => ({ file: row.file, bytes: row.rawBytes, sha256: row.sha256.slice(7), gzipBytes: row.gzipBytes,
      modules: [...row.modules], imports: row.file === 'assets/shell.js' ? ['assets/editor.js'] : [], entry: row.file === 'assets/main.js' })) };
  const retainedInputs = { buildEvidence: JSON.stringify(evidence), manifest: JSON.stringify(manifest), lock: JSON.stringify(lock),
    textManifest: JSON.stringify(profile), textProfile: JSON.stringify(profile), staticSource: compiledStatic, staticModule: compiledStatic, index };
  const inputs = Object.fromEntries(Object.entries(retainedInputs).map(([name, text]) => [name, source(inputPaths[name], text)]));
  const derived = deriveD11StaticDocument({ staticModule: compiledStatic, index });
  files.push(emitted('index.html', 'other', index, { sources: ['index.html'] }), derived.bootstrap);
  files.sort(fileOrder);
  const roleContext = structuredClone(D11_ROLE_CONTEXT);
  const roleInputs = { sourceTextByPath: Object.fromEntries(Object.entries(sourceText).filter(([path]) => /\.(?:[cm]?[jt]sx?|css|json)$/.test(path))),
    registrationContract: structuredClone(registrationInputs.contract),
    outputTextByFile: { ...outputText, 'inline:bootstrap': prelude }, parser: { name: 'rolldown', version: rolldownVersion } };
  const roles = deriveD11Roles({ manifest, files, ...roleInputs, roleContext, parser: { ...roleInputs.parser, parseSync } });
  const build = { kind: 'perf-d11-build-1', files, ...derived, roleInputs, roleContext, roles, retainedInputs, inputs, sourceInputs,
    dynamicFeatures: [{ id: 'src/ui/feature.ts', entryFile: 'assets/feature.js', files: ['assets/feature.js'] },
      { id: 'src/ui/panels.ts', entryFile: 'assets/panels.js', files: ['assets/panels.js'] },
      { id: 'src/ui/shell.ts', entryFile: 'assets/shell.js', files: ['assets/editor.js', 'assets/shell.js'] }],
    textWasmHash: hash(wasm), duplicateVersions: [{ package: 'example', versions: ['1.0.0', '2.0.0'] }],
    duplicateVersionsScope: 'package-lock-all-packages; installed or bundled execution is not implied',
    gzip: { algorithm: 'gzip', level: 'zlib-default', source: 'fresh Node gzipSync bytes' },
    toolchain: { node: '26.10.0', npm: '12.1.0', zlib: process.versions.zlib, built: { node: '26.10.0', npm: '12.1.0' } },
    sourceAttribution: 'Synthetic integrity specimen' };
  const execution = row => ({ file: row.file, sha256: row.sha256, rawBytes: row.rawBytes, owner: 'page', executedFunctions: 1, newlyEvaluated: true });
  const resource = row => ({ id: row.file, file: row.file, kind: row.kind, role: row.kind === 'font' ? 'ui-font' : row.kind,
    sha256: row.sha256, rawBytes: row.rawBytes, gzipBytes: row.gzipBytes, owner: 'page', verified: true, method: 'GET',
    networkTransferBytes: row.rawBytes + 300,
    timing: { transferSize: row.rawBytes + 300, encodedBodySize: row.rawBytes, decodedBodySize: row.rawBytes } });
  const document = { id: 'document:' + derived.document.sha256, kind: 'other', role: 'document', ...derived.document,
    owner: 'page', verified: true, method: 'GET', networkTransferBytes: derived.document.rawBytes + 300,
    timing: { transferSize: derived.document.rawBytes + 300, encodedBodySize: derived.document.rawBytes, decodedBodySize: derived.document.rawBytes } };
  const observation = { id: 'cold:1', cache: 'cold', scope: 'startup', startedBeforeNavigation: true,
    collection: { complete: true, realms: ['page'], recordLimit: 20000 }, cachePolicy: { httpCacheDisabledByRouting: false },
    instrumentation: 'precise-coverage-byte-audit', timingSamplesReusable: false, fixtureSeal,
    browserProfile: { observed: true, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
    evaluated: ['assets/main.js', 'assets/shell.js', 'assets/editor.js', 'assets/panels.js', 'inline:bootstrap'].map(file => execution(files.find(row => row.file === file))),
    resources: [...['assets/main.js', 'assets/shell.js', 'assets/editor.js', 'assets/panels.js', 'assets/ui.css', 'assets/ui.woff2'].map(file => resource(files.find(row => row.file === file))), document],
    authoringFontIdentities: [], fonts: { observed: true, status: 'loaded', faces: [] }, missing: [] };
  const buildFiles = files.filter(row => row.file !== 'inline:bootstrap').map(row => ({ path: 'dist/app/' + row.file, bytes: row.rawBytes, sha256: row.sha256 }));
  for (const row of [inputs.buildEvidence, inputs.manifest, inputs.staticModule]) buildFiles.push({ path: row.path, bytes: row.rawBytes, sha256: row.sha256 });
  const sourceFiles = [...sourceInputs, inputs.staticSource, source('vendor/text/fonts/authoring.ttf', font), ...registrationInputs.inputs]
    .map(row => ({ path: row.path, bytes: row.rawBytes, sha256: row.sha256.slice(7) })).sort(pathOrder);
  const state = { payload: { observation, build }, returnedD11: null,
    options: { buildFiles, sourceFiles, fixtureSeal } };
  refresh(state);
  return state;
}

// Simulate edits that also update the self-reported hashes and summaries. The
// independently retained receipt identities must still reject altered inputs.
function refresh(state) {
  const { sha256: _old, ...identity } = state.payload.build;
  state.payload.build.sha256 = hash(canonical(identity));
  state.payload.observation.buildSha256 = state.payload.build.sha256;
  state.payload.result = analyzeD11Observation(state.payload.observation, state.payload.build);
  const bytes = Buffer.from(JSON.stringify(state.payload));
  state.returnedD11 = { ...structuredClone(state.payload.result), artifact: { path: '/retained/group/d11-byte-audit-1.json',
    sha256: hash(bytes), byteLength: String(bytes.length) },
    evaluatedModuleCount: state.payload.observation.evaluated.length, resourceCount: state.payload.observation.resources.length };
}

export { hash as d11Hash, inputPaths as d11InputPaths, specimen as d11Specimen, refresh as refreshD11Specimen };
