import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { verifyD11RetainedBuild, verifyD11RetainedObservation } from '../../tooling/qualification/campaigns/browser-d11-verification.mjs';
import { d11Hash as hash, d11InputPaths as inputPaths, d11Specimen as specimen, refreshD11Specimen as refresh, initializeD11Specimen } from './support/d11-specimen.mjs';

before(initializeD11Specimen);

const output = (file, kind, rawBytes, gzipBytes) => ({ file, kind, rawBytes, gzipBytes, computedGzipBytes: gzipBytes,
  sha256: hash('output:' + file), modules: [], sources: [], authoringFont: false });

const verify = state => verifyD11RetainedObservation(state.payload, state.returnedD11, state.options);
function rejected(changes, { reseal = false } = {}) {
  for (const [label, change] of changes) {
    const state = specimen(); change(state);
    if (reseal) refresh(state);
    assert.throws(() => verify(state), Error, label);
  }
}

// This explicitly updated synthetic finalized specimen changes both the retained
// evidence and its independent test identity. It grants no production authority.
function virtualModuleSpecimen(modules = ['__vite-browser-external', '\0rolldown/virtual-specimen.js', 'virtual:retained-specimen']) {
  const state = specimen(), build = state.payload.build;
  const file = build.files.find(row => row.file === 'assets/worker.js');
  file.modules.push(...modules);
  const evidence = JSON.parse(build.retainedInputs.buildEvidence);
  evidence.outputs.find(row => row.file === file.file).modules = [...file.modules];
  const text = JSON.stringify(evidence), bytes = Buffer.byteLength(text), sha256 = hash(text);
  build.retainedInputs.buildEvidence = text;
  Object.assign(build.inputs.buildEvidence, { rawBytes: bytes, sha256 });
  Object.assign(state.options.buildFiles.find(row => row.path === inputPaths.buildEvidence), { bytes, sha256 });
  refresh(state);
  return state;
}

test('D11 retained replay keeps exact virtual IDs while excluding fabricated source provenance', () => {
  const baseline = specimen(), state = virtualModuleSpecimen();
  assert.deepEqual(verify(state), state.payload.result);
  const file = state.payload.build.files.find(row => row.file === 'assets/worker.js');
  assert(file.modules.includes('__vite-browser-external'));
  assert(file.modules.includes('\0rolldown/virtual-specimen.js'));
  assert.deepEqual(file.sources, ['src/text/worker.ts']);
  assert.deepEqual(state.payload.build.roles, baseline.payload.build.roles);
  for (const key of ['rawBytes', 'sha256', 'gzipBytes', 'computedGzipBytes']) assert.equal(file[key], baseline.payload.build.files.find(row => row.file === file.file)[key]);
});

test('D11 retained replay rejects lookalikes even with refreshed outer and evidence identities', () => {
  for (const id of ['__vite-browser-external:fs', '__vite-browser-external?commonjs-proxy', '__vite-browser-external/child',
    '__vite-browser-external.js', 'src/__vite-browser-external', 'missing-ordinary.js']) {
    const state = virtualModuleSpecimen([id]);
    assert.throws(() => verify(state), /D11 emitted accounting differs from retained finalized inputs/, id);
  }
});

test('D11 retained replay rejects virtual-module omission, forged source attribution and physical-name collisions', () => {
  for (const change of [
    state => { const file = state.payload.build.files.find(row => row.file === 'assets/worker.js'); file.modules = file.modules.filter(id => id !== '__vite-browser-external'); },
    state => { state.payload.build.files.find(row => row.file === 'assets/worker.js').sources.push('__vite-browser-external'); },
  ]) {
    const state = virtualModuleSpecimen(); change(state); refresh(state);
    assert.throws(() => verify(state), /D11 emitted accounting differs from retained finalized inputs/);
  }
  const state = virtualModuleSpecimen();
  state.options.sourceFiles.push({ path: '__vite-browser-external', bytes: 1, sha256: hash('x').slice(7) });
  assert.throws(() => verify(state), /virtual module conflicts with a retained physical source/);
});

test('D11 retained verification recomputes the observation against exact receipt identities', () => {
  const state = specimen();
  assert.equal(state.payload.result.status, 'PASS');
  assert.equal(state.payload.build.roles.complete, true);
  assert.deepEqual(state.payload.build.roles.missing, []);
  assert.deepEqual(verify(state), state.payload.result);
  assert.equal(state.returnedD11.evaluatedModuleCount, 5);
  assert.equal(state.returnedD11.resourceCount, 7);
});

test('D11 retained verification admits the explicit absent fixture identity', () => {
  const state = specimen({ fixtureSeal: null });
  assert.deepEqual(verify(state), state.payload.result);
});

test('D11 retained build verification supports consumers without a browser observation', () => {
  const { payload: { build }, options: { buildFiles, sourceFiles } } = specimen();
  assert.deepEqual(verifyD11RetainedBuild(build, { buildFiles, sourceFiles }), build);
});

test('D11 retained build verification rejects a resealed forged role map independently', () => {
  const state = specimen();
  state.payload.build.roles.startupFiles.push('assets/feature.js');
  refresh(state);
  const { buildFiles, sourceFiles } = state.options;
  assert.throws(() => verifyD11RetainedBuild(state.payload.build, { buildFiles, sourceFiles }), Error);
});

test('D11 build identity uses recursive sorted keys without changing array order', () => {
  const state = specimen();
  const reverseKeys = value => Array.isArray(value) ? value.map(reverseKeys) : value !== null && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseKeys(child)])) : value;
  state.payload.build = reverseKeys(state.payload.build);
  assert.deepEqual(verify(state), state.payload.result);
  state.payload.build.files.reverse();
  assert.throws(() => verify(state), Error);
});

test('D11 rejects edited retained or returned results even when the other copy is intact', () => {
  rejected([
    ['retained measurement', s => { s.payload.result.measurements[0].value++; }],
    ['retained transfer', s => { s.payload.result.transferred.networkBytes = 0; }],
    ['retained omitted measurement', s => { s.payload.result.measurements.pop(); }],
    ['returned measurement', s => { s.returnedD11.measurements[0].value++; }],
    ['returned verdict', s => { s.returnedD11.status = 'INCONCLUSIVE'; }],
    ['returned omitted failure field', s => { delete s.returnedD11.failures; }],
    ['both summary copies edited', s => { s.payload.result.measurements[0].value = 0; s.returnedD11.measurements[0].value = 0; }],
  ]);
});

test('D11 rejects count metadata that differs from the retained raw observation', () => {
  rejected([
    ['too few evaluated modules', s => { s.returnedD11.evaluatedModuleCount = 0; }],
    ['too many evaluated modules', s => { s.returnedD11.evaluatedModuleCount++; }],
    ['too few resources', s => { s.returnedD11.resourceCount--; }],
    ['fractional resource count', s => { s.returnedD11.resourceCount = 3.5; }],
    ['missing evaluated count', s => { delete s.returnedD11.evaluatedModuleCount; }],
  ]);
});

test('D11 rejects build mutations without a matching canonical build hash', () => {
  rejected([
    ['top-level build field', s => { s.payload.build.sourceAttribution += ' changed'; }],
    ['nested build field', s => { s.payload.build.gzip.level = 'changed'; }],
    ['build hash itself', s => { s.payload.build.sha256 = hash('different build'); }],
    ['observation build hash', s => { s.payload.observation.buildSha256 = hash('different build'); }],
  ]);
});

test('D11 binds every emitted asset to the receipt even after the payload is resealed', () => {
  rejected([
    ['emitted hash', s => { s.payload.build.files.find(row => row.file === 'assets/feature.js').sha256 = hash('changed emitted bytes'); }],
    ['emitted length', s => { s.payload.build.files.find(row => row.file === 'assets/feature.js').rawBytes++; }],
    ['missing emitted asset', s => { s.payload.build.files = s.payload.build.files.filter(row => row.file !== 'assets/text.wasm'); }],
    ['unreceipted emitted asset', s => { s.payload.build.files.push(output('assets/unrecorded.js', 'js', 20, 30)); }],
    ['missing receipt asset', s => { s.options.buildFiles = s.options.buildFiles.filter(row => row.path !== 'dist/app/assets/feature.js'); }],
    ['unobserved receipt asset', s => { s.options.buildFiles.push({ path: 'dist/app/assets/unrecorded.js', bytes: 20, sha256: hash('unrecorded') }); }],
  ], { reseal: true });
});

test('D11 reproduces gzip, font roles, lazy features and packages from retained metadata', () => {
  rejected([
    ['lowered startup gzip with matching resource and summary', s => {
      const file = s.payload.build.files.find(row => row.file === 'assets/main.js');
      file.gzipBytes = file.computedGzipBytes = 0;
      s.payload.observation.resources.find(row => row.file === file.file).gzipBytes = 0;
    }],
    ['lowered unfetched gzip', s => {
      const file = s.payload.build.files.find(row => row.file === 'assets/feature.js');
      file.gzipBytes = file.computedGzipBytes = 0;
    }],
    ['authoring font relabeled as UI', s => { s.payload.build.files.find(row => row.file === 'assets/authoring.ttf').authoringFont = false; }],
    ['UI font relabeled as authoring', s => { s.payload.build.files.find(row => row.file === 'assets/ui.woff2').authoringFont = true; }],
    ['omitted dynamic feature', s => { s.payload.build.dynamicFeatures = []; }],
    ['altered lazy closure', s => { s.payload.build.dynamicFeatures[0].files.push('assets/main.js'); }],
    ['erased duplicate packages', s => { s.payload.build.duplicateVersions = []; }],
    ['altered duplicate version', s => { s.payload.build.duplicateVersions[0].versions[1] = '3.0.0'; }],
    ['invented source attribution', s => { s.payload.build.files.find(row => row.file === 'assets/feature.js').sources.push('src/main.ts'); }],
    ['invented module attribution', s => { s.payload.build.files.find(row => row.file === 'assets/feature.js').modules.push('src/main.ts'); }],
  ], { reseal: true });
});

test('D11 reproduces asset roles with the exact retained parser, source and emitted text', () => {
  rejected([
    ['invented startup classification', s => { s.payload.build.roles.startupFiles.push('assets/feature.js'); }],
    ['omitted lazy classification', s => { s.payload.build.roles.lazyFeatures = []; }],
    ['omitted text engine classification', s => { s.payload.build.roles.textEngineFiles = []; }],
    ['invented UI font classification', s => { s.payload.build.roles.uiCssFontFiles.push('assets/authoring.ttf'); }],
    ['altered role completeness', s => { s.payload.build.roles.complete = false; }],
    ['different parser version', s => { s.payload.build.roleInputs.parser.version = '0.0.0'; }],
    ['different parser implementation', s => { s.payload.build.roleInputs.parser.name = 'other'; }],
    ['edited source text', s => { s.payload.build.roleInputs.sourceTextByPath['src/main.ts'] += '\n'; }],
    ['edited emitted text', s => { s.payload.build.roleInputs.outputTextByFile['assets/main.js'] += '\n'; }],
    ['edited inline bootstrap text', s => { s.payload.build.roleInputs.outputTextByFile['inline:bootstrap'] += '\n'; }],
    ['missing role source text', s => { delete s.payload.build.roleInputs.sourceTextByPath['src/main.ts']; }],
    ['missing role emitted text', s => { delete s.payload.build.roleInputs.outputTextByFile['assets/main.js']; }],
    ['unsealed role source text', s => { s.payload.build.roleInputs.sourceTextByPath['src/unrecorded.ts'] = 'export {};'; }],
    ['unsealed role output text', s => { s.payload.build.roleInputs.outputTextByFile['assets/unrecorded.js'] = 'export {};'; }],
  ], { reseal: true });
});

test('D11 binds reviewed registration archives and public members to independent source receipts', () => {
  rejected([
    ['archive bytes', s => { const row = s.payload.build.roleInputs.registrationContract.archives[0]; row.data = (row.data[0] === 'A' ? 'B' : 'A') + row.data.slice(1); }],
    ['archive digest', s => { s.payload.build.roleInputs.registrationContract.archives[0].sha256 = hash('different archive'); }],
    ['archive integrity', s => { s.payload.build.roleInputs.registrationContract.archives[0].integrity = 'sha512-' + 'A'.repeat(86) + '=='; }],
    ['reviewed member text', s => { s.payload.build.roleInputs.registrationContract.members[0].text += '\n'; }],
    ['reviewed member digest', s => { s.payload.build.roleInputs.registrationContract.members[0].sha256 = hash('different member'); }],
    ['reviewed source identity', s => { s.payload.build.roleInputs.registrationContract.sourceIdentity = '0'.repeat(64); }],
    ['metadata path', s => { s.payload.build.roleInputs.registrationContract.packagesMetadata.path = 'vendor/other/packages.json'; }],
    ['member installed path', s => { s.payload.build.roleInputs.registrationContract.members[0].installedPath = 'node_modules/other/member.js'; }],
    ['metadata whitespace with new internal identity', s => {
      const metadata = s.payload.build.roleInputs.registrationContract.packagesMetadata;
      metadata.text += '\n'; metadata.rawBytes = Buffer.byteLength(metadata.text); metadata.sha256 = hash(metadata.text);
    }],
    ['missing archive receipt', s => {
      const path = s.payload.build.roleInputs.registrationContract.archives[0].path;
      s.options.sourceFiles = s.options.sourceFiles.filter(row => row.path !== path);
    }],
    ['edited archive receipt', s => {
      const path = s.payload.build.roleInputs.registrationContract.archives[0].path;
      s.options.sourceFiles.find(row => row.path === path).bytes++;
    }],
  ], { reseal: true });
});

test('D11 requires the exact viewport, workload union and public startup boundary', () => {
  rejected([
    ['viewport width', s => { s.payload.build.roleContext.viewport.width = 800; }],
    ['viewport height', s => { s.payload.build.roleContext.viewport.height = 600; }],
    ['device scale', s => { s.payload.build.roleContext.deviceScaleFactor = 1; }],
    ['startup boundary', s => { s.payload.build.roleContext.boundary = 'module-loaded'; }],
    ['workload omission', s => { s.payload.build.roleContext.workloads.pop(); }],
    ['workload order', s => { s.payload.build.roleContext.workloads.reverse(); }],
    ['counting method', s => { s.payload.build.roleContext.counting = 'intersection'; }],
    ['extra context field', s => { s.payload.build.roleContext.extra = true; }],
    ['omitted context field', s => { delete s.payload.build.roleContext.boundary; }],
  ], { reseal: true });
});

test('D11 mismatched observed browser profile cannot retain a passing result', () => {
  const state = specimen();
  state.payload.observation.browserProfile.viewport.width = 800;
  assert.throws(() => verify(state), Error);
  refresh(state);
  assert.equal(state.payload.result.status, 'INCONCLUSIVE');
  assert.deepEqual(verify(state), state.payload.result);
});

test('D11 binds every retained metadata string before parsing or static derivation', () => {
  const changes = [];
  for (const name of Object.keys(inputPaths)) {
    changes.push([name + ' edited raw text', s => { s.payload.build.retainedInputs[name] += '\n'; }]);
    changes.push([name + ' omitted raw text', s => { delete s.payload.build.retainedInputs[name]; }]);
    changes.push([name + ' parsed object substituted', s => { s.payload.build.retainedInputs[name] = {}; }]);
  }
  changes.push(['extra raw input', s => { s.payload.build.retainedInputs.extra = '{}'; }]);
  changes.push(['extra input identity', s => { s.payload.build.inputs.extra = { ...s.payload.build.inputs.lock }; }]);
  rejected(changes, { reseal: true });
});

test('D11 requires the retained pinned build and gzip toolchain', () => {
  rejected([
    ['inventory Node version', s => { s.payload.build.toolchain.node = '26.9.0'; }],
    ['inventory npm version', s => { s.payload.build.toolchain.npm = '12.0.0'; }],
    ['inventory zlib version', s => { s.payload.build.toolchain.zlib = 'changed'; }],
    ['build Node version', s => { s.payload.build.toolchain.built.node = '26.9.0'; }],
    ['build npm version', s => { s.payload.build.toolchain.built.npm = '12.0.0'; }],
    ['missing toolchain', s => { delete s.payload.build.toolchain; }],
    ['different compression algorithm', s => { s.payload.build.gzip.algorithm = 'brotli'; }],
    ['different compression level', s => { s.payload.build.gzip.level = 'best'; }],
  ], { reseal: true });
});

test('D11 derives the inline bootstrap and served document from retained static bytes', () => {
  rejected([
    ['bootstrap metadata', s => { s.payload.build.bootstrap.gzipBytes++; s.payload.build.bootstrap.computedGzipBytes++; }],
    ['served document identity', s => { s.payload.build.document.sha256 = hash('changed served document'); }],
    ['served document bytes', s => { s.payload.build.document.rawBytes++; }],
    ['served document compression', s => { s.payload.build.document.gzipBytes++; }],
    ['missing bootstrap', s => { delete s.payload.build.bootstrap; }],
    ['missing document', s => { delete s.payload.build.document; }],
  ], { reseal: true });
});

test('D11 binds source identities and all eight named build inputs to retained receipts', () => {
  const changes = [
    ['source hash', s => { s.payload.build.sourceInputs.find(row => row.path === 'src/main.ts').sha256 = hash('changed source'); }],
    ['source length', s => { s.payload.build.sourceInputs.find(row => row.path === 'src/main.ts').rawBytes++; }],
    ['missing source receipt', s => { s.options.sourceFiles = s.options.sourceFiles.filter(row => row.path !== 'src/main.ts'); }],
    ['prefixed source receipt digest', s => { s.options.sourceFiles[0].sha256 = 'sha256:' + s.options.sourceFiles[0].sha256; }],
    ['empty build source inventory', s => { s.payload.build.sourceInputs = []; }],
  ];
  for (const name of Object.keys(inputPaths)) {
    changes.push([name + ' hash', s => { s.payload.build.inputs[name].sha256 = hash('changed ' + name); }]);
    changes.push([name + ' length', s => { s.payload.build.inputs[name].rawBytes++; }]);
    changes.push([name + ' missing', s => { delete s.payload.build.inputs[name]; }]);
  }
  rejected(changes, { reseal: true });
});

test('D11 rejects duplicate file identities before constructing lookup maps', () => {
  rejected([
    ['emitted files', s => { s.payload.build.files.push(structuredClone(s.payload.build.files[0])); }],
    ['source inputs', s => { s.payload.build.sourceInputs.push(structuredClone(s.payload.build.sourceInputs[0])); }],
    ['build receipt', s => { s.options.buildFiles.push(structuredClone(s.options.buildFiles[0])); }],
    ['source receipt', s => { s.options.sourceFiles.push(structuredClone(s.options.sourceFiles[0])); }],
  ], { reseal: true });
});

test('D11 rejects traversal and noncanonical paths in every file inventory', () => {
  const changes = [];
  for (const path of ['../outside.js', '/absolute.js', 'assets/../outside.js', 'assets//main.js', 'assets\\main.js', 'C:/outside.js']) {
    changes.push(['emitted ' + path, s => { s.payload.build.files[0].file = path; }]);
    changes.push(['source input ' + path, s => { s.payload.build.sourceInputs[0].path = path; }]);
    changes.push(['build input ' + path, s => { s.payload.build.inputs.buildEvidence.path = path; }]);
    changes.push(['build receipt ' + path, s => { s.options.buildFiles[0].path = path; }]);
    changes.push(['source receipt ' + path, s => { s.options.sourceFiles[0].path = path; }]);
  }
  rejected(changes, { reseal: true });
});

test('D11 requires the exact selected fixture seal, including null versus absent', () => {
  rejected([
    ['different observation fixture', s => { s.payload.observation.fixtureSeal = hash('different fixture'); }],
    ['different selected fixture', s => { s.options.fixtureSeal = hash('different fixture'); }],
    ['omitted observation fixture', s => { delete s.payload.observation.fixtureSeal; }],
    ['omitted selected fixture', s => { delete s.options.fixtureSeal; }],
    ['unexpected no-fixture observation', s => { s.payload.observation.fixtureSeal = null; }],
    ['unexpected no-fixture selection', s => { s.options.fixtureSeal = null; }],
  ]);
});
