#!/usr/bin/env node
// Preparation is an explicit command, never an import side effect or scored sample.
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO, setupFixture, verifyFixtureManifest, workloadDefinition } from './fixtures.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/;
const INPUT_KIND = 'perf-fixture-input-1';
const CATALOG_KIND = 'perf-fixture-catalog-1';
const MAX_JSON_BYTES = 1024 * 1024;
const usage = `Sealed performance fixtures (preparation is outside measurement)

  node tooling/qualification/campaigns/fixtures-run.mjs prepare \\
    --workload W1 --output artifacts/new-w1 --allow-heavy [--repo /subject/repo]
    [--font-corpus /sealed/fonts.json] [--official-adapter /public/example]
    [--catalog-output artifacts/new-catalog.json]

  node tooling/qualification/campaigns/fixtures-run.mjs prepare \\
    --workload WC --closure-bytes 536870912 --seed /mixed/seed.json \\
    --output artifacts/new-wc --allow-heavy

  node tooling/qualification/campaigns/fixtures-run.mjs catalog \\
    --output artifacts/new-catalog.json \\
    --fixture W1=artifacts/new-w1/fixture-input.json \\
    --fixture WC:536870912=artifacts/new-wc/fixture-input.json \\
    [--cell EXACT_CELL_ID=@W1]

prepare writes fixture-input.json containing the separately retained manifest seal.
WXn/WXs require --font-corpus. WC512/WC4G (or WC with --closure-bytes) require
an actual mixed full-history seed JSON with root, documentId and sealed archive.
catalog verifies every referenced fixture; --cell also accepts a descriptor path.
All output paths must be new. Existing evidence is never merged or overwritten.
Pass the resulting descriptor or catalog to campaigns/run.mjs --fixture-manifest.
`;

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function key(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\s\x00-\x1f]/.test(value) || ['__proto__', 'prototype', 'constructor'].includes(value)) throw Error('Invalid fixture or cell key');
  return value;
}
function assignment(value, flag) {
  const at = value.indexOf('=');
  if (at < 1 || at === value.length - 1) throw Error(`${flag} requires KEY=PATH (or --cell KEY=@FIXTURE_KEY)`);
  return [key(value.slice(0, at)), value.slice(at + 1)];
}

export function parseFixtureArguments(argv) {
  if (argv.length === 0 || (argv.length === 1 && ['--help', '-h', 'help'].includes(argv[0]))) return { command: 'help' };
  const command = argv[0];
  if (!['prepare', 'catalog'].includes(command)) throw Error('Expected prepare or catalog command; use --help');
  const allowed = command === 'prepare'
    ? new Set(['--workload', '--output', '--repo', '--font-corpus', '--official-adapter', '--seed', '--closure-bytes', '--catalog-output', '--allow-heavy'])
    : new Set(['--output', '--fixture', '--cell']);
  const options = { command }, seen = new Set(), fixtures = [], cells = [];
  for (let index = 1; index < argv.length; index++) {
    const flag = argv[index];
    if (!allowed.has(flag)) throw Error(`Unknown ${command} option: ${flag}`);
    if (seen.has(flag) && !['--fixture', '--cell'].includes(flag)) throw Error(`Duplicate option: ${flag}`);
    seen.add(flag);
    if (flag === '--allow-heavy') { options.allowHeavy = true; continue; }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw Error(`Missing value for ${flag}`);
    if (flag === '--fixture' || flag === '--cell') {
      const entries = flag === '--fixture' ? fixtures : cells, entry = assignment(value, flag);
      if (entries.some(([existing]) => existing === entry[0])) throw Error(`Duplicate ${flag} key: ${entry[0]}`);
      entries.push(entry);
    } else options[flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  if (!options.output) throw Error('--output is required');
  if (command === 'prepare') {
    if (!options.workload) throw Error('--workload is required');
    if (options.allowHeavy !== true) throw Error('prepare requires explicit --allow-heavy; heavy generation never runs implicitly');
    const definition = workloadDefinition(options.workload, options);
    if (options.closureBytes !== undefined && String(definition.closureBytes) !== options.closureBytes) throw Error('--closure-bytes must match the exact WC workload');
    if (definition.textLayers && !options.fontCorpus) throw Error('WXn/WXs require --font-corpus');
    if (definition.closureBytes && !options.seed) throw Error('WC requires --seed with an actual mixed full-history seed');
    if (!definition.closureBytes && options.seed) throw Error('--seed is only supported for WC workloads');
    if (options.officialAdapter && definition.id !== 'WA') throw Error('--official-adapter is only supported for WA');
  } else {
    if (!fixtures.length && !cells.length) throw Error('catalog requires at least one --fixture or --cell');
    options.fixtures = fixtures; options.cells = cells;
  }
  return options;
}

async function readJSON(path) {
  const target = resolve(path), before = await lstat(target);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_JSON_BYTES) throw Error('Input JSON must be an ordinary file of at most 1 MiB: ' + target);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (before.dev !== opened.dev || before.ino !== opened.ino) throw Error('Input JSON changed before reading: ' + target);
    const bytes = await handle.readFile(), after = await handle.stat(), current = await lstat(target);
    if (bytes.length !== before.size || after.size !== before.size || current.dev !== before.dev || current.ino !== before.ino || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs) throw Error('Input JSON changed while reading: ' + target);
    return JSON.parse(bytes.toString('utf8'));
  } finally { await handle.close(); }
}

// Resolve each existing ancestor before any write; do not follow an output
// symlink or create directories during validation/preparation prerequisite checks.
async function assertNewPath(path) {
  const target = resolve(path), root = parse(target).root;
  let current = root;
  const parts = relative(root, target).split(sep).filter(Boolean);
  if (!parts.length) throw Error('Output must be a new path');
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    let info;
    try { info = await lstat(current); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (info.isSymbolicLink()) throw Error('Output must not traverse a symlink: ' + current);
    if (index === parts.length - 1) throw Object.assign(Error('Output already exists: ' + target), { code: 'EEXIST' });
    if (!info.isDirectory()) throw Error('Output parent is not a directory: ' + current);
  }
  return target;
}

async function exclusiveJSON(path, value) {
  const target = await assertNewPath(path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  // Recheck after mkdir, including newly created parents.
  await assertNewPath(target);
  const handle = await open(target, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  return target;
}

export function descriptorFor(fixture) {
  const { manifestPath, seal } = fixture ?? {};
  if (!isAbsolute(manifestPath ?? '') || manifestPath !== resolve(manifestPath) || !object(seal) || seal.path !== manifestPath || !HASH.test(seal.sha256 ?? '')) throw Error('Fixture descriptor requires an absolute manifest path and its exact separately retained seal');
  return { kind: INPUT_KIND, manifestPath, seal: { path: manifestPath, sha256: seal.sha256 } };
}

export function fixtureKey(fixture) {
  const definition = workloadDefinition(fixture.workload);
  if (definition.closureBytes) {
    if (String(fixture.observed?.closureBytes) !== String(definition.closureBytes)) throw Error('Portable fixture closure size does not match its workload');
    return 'WC:' + definition.closureBytes;
  }
  return definition.id;
}

export async function readFixtureDescriptor(path) {
  const input = await readJSON(path);
  if (input.kind !== undefined && input.kind !== INPUT_KIND) throw Error('Expected a fixture-input descriptor, not a manifest or catalog');
  const descriptor = descriptorFor(input);
  if (await realpath(descriptor.manifestPath) !== descriptor.manifestPath) throw Error('Fixture manifest path must be canonical and must not traverse a symlink');
  const fixture = await verifyFixtureManifest(descriptor);
  return { descriptor, fixture };
}

export async function createFixtureCatalog({ output, fixtures = [], cells = [] }) {
  await assertNewPath(output);
  const entries = new Map(), overrides = new Map();
  for (const [name, path] of fixtures) {
    key(name);
    if (entries.has(name)) throw Error('Duplicate fixture key: ' + name);
    const { descriptor, fixture } = await readFixtureDescriptor(path);
    if (name !== fixtureKey(fixture)) throw Error(`Fixture key ${name} does not match its verified workload ${fixtureKey(fixture)}`);
    entries.set(name, descriptor);
  }
  for (const [id, source] of cells) {
    key(id);
    if (overrides.has(id)) throw Error('Duplicate cell key: ' + id);
    if (source.startsWith('@')) {
      const name = key(source.slice(1));
      if (!entries.has(name)) throw Error('Cell references an absent fixture key: ' + name);
      overrides.set(id, name);
    } else overrides.set(id, (await readFixtureDescriptor(source)).descriptor);
  }
  if (!entries.size && !overrides.size) throw Error('An empty catalog cannot select a fixture');
  const catalog = { kind: CATALOG_KIND, fixtures: Object.fromEntries(entries), ...(overrides.size ? { cells: Object.fromEntries(overrides) } : {}) };
  const catalogPath = await exclusiveJSON(output, catalog);
  return { catalogPath, catalog };
}

export async function prepareFixtureInput(options) {
  // Reuse parser validation for programmatic callers, before any filesystem IO.
  const argv = ['prepare', '--workload', options.workload ?? '', '--output', options.output ?? ''];
  for (const [name, flag] of [['repo', '--repo'], ['fontCorpus', '--font-corpus'], ['officialAdapter', '--official-adapter'], ['seed', '--seed'], ['closureBytes', '--closure-bytes'], ['catalogOutput', '--catalog-output']]) if (options[name] !== undefined) argv.push(flag, String(options[name]));
  if (options.allowHeavy === true) argv.push('--allow-heavy');
  const checked = parseFixtureArguments(argv);
  if (process.versions.node !== '26.10.0') throw Error('Fixture preparation requires the pinned Node 26.10.0 toolchain before generating any bytes');
  const output = await assertNewPath(checked.output), artifactRoot = join(await realpath(REPO), 'artifacts');
  if (!output.startsWith(artifactRoot + sep)) throw Error('Fixture output must be a new artifact directory in this checkout');
  const catalogOutput = checked.catalogOutput ? await assertNewPath(checked.catalogOutput) : undefined;
  if (catalogOutput && (catalogOutput === output || catalogOutput.startsWith(output + sep) && (dirname(catalogOutput) !== output || ['fixture-input.json', 'fixture.json', 'product-receipt.json'].includes(basename(catalogOutput))))) throw Error('Catalog output must not collide with fixture files or enter its sealed private root');
  const seed = checked.seed ? await readJSON(checked.seed) : undefined;
  if (checked.seed && (!object(seed) || !isAbsolute(seed.root ?? '') || !/^[A-Za-z0-9_-]+$/.test(seed.documentId ?? '') || !object(seed.archive) || !isAbsolute(seed.archive.path ?? '') || !/^(?:sha256:)?[a-f0-9]{64}$/.test(seed.archive.sha256 ?? '') || !/^[1-9][0-9]*$/.test(String(seed.archive.byteLength ?? '')))) throw Error('WC seed requires absolute root and archive paths, documentId, archive SHA-256 and positive byteLength');
  const prepared = await setupFixture({
    workload: checked.workload, output, allowHeavy: true,
    ...(checked.repo ? { repo: resolve(checked.repo) } : {}),
    ...(checked.fontCorpus ? { fontCorpus: resolve(checked.fontCorpus) } : {}),
    ...(checked.officialAdapter ? { officialAdapterPath: resolve(checked.officialAdapter) } : {}),
    ...(checked.closureBytes ? { closureBytes: checked.closureBytes } : {}),
    ...(seed ? { seed } : {}), signal: options.signal, onProgress: options.onProgress,
  });
  const descriptor = descriptorFor(prepared), verified = await verifyFixtureManifest(descriptor);
  const descriptorPath = await exclusiveJSON(join(output, 'fixture-input.json'), descriptor);
  let catalog;
  if (catalogOutput) catalog = await createFixtureCatalog({ output: catalogOutput, fixtures: [[fixtureKey(verified), descriptorPath]] });
  return { descriptorPath, descriptor, workload: verified.workload, ...(catalog ? { catalogPath: catalog.catalogPath } : {}) };
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const options = parseFixtureArguments(argv);
    if (options.command === 'help') { stdout.write(usage); return 0; }
    const result = options.command === 'prepare'
      ? await prepareFixtureInput({ ...options, onProgress: value => stderr.write(JSON.stringify({ preparation: value }) + '\n') })
      : await createFixtureCatalog(options);
    stdout.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  } catch (error) {
    stderr.write(JSON.stringify({ error: error?.message ?? String(error), ...(error?.fixtureReceipt ? { fixtureReceipt: error.fixtureReceipt } : {}) }) + '\n');
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
