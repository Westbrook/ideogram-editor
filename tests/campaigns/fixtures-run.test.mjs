import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURE_VERSION, workloadDefinition } from '../../tooling/qualification/campaigns/fixtures.mjs';
import { selectFixtureDescriptor } from '../../tooling/qualification/campaigns/fixture-catalog.mjs';
import { createFixtureCatalog, descriptorFor, fixtureKey, main, parseFixtureArguments, prepareFixtureInput, readFixtureDescriptor } from '../../tooling/qualification/campaigns/fixtures-run.mjs';

async function temporary(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fixture-cli-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

// These minimal manifests exercise descriptor/seal mechanics only. No product
// fixture is generated and these tests do not constitute performance evidence.
async function descriptorFixture(root, { workload = 'W0', corpus = [], name = workload } = {}) {
  const definition = workloadDefinition(workload), observed = { ...definition, productionValidated: true };
  if (definition.closureBytes) Object.assign(observed, { closureVerified: true, features: Object.fromEntries(['original', 'candidate', 'rawCaption', 'derivedCaption', 'nativeText', 'font', 'layout', 'contribution', 'adapter'].map(key => [key, true])) });
  const manifest = { kind: 'sealed-performance-fixture', version: FIXTURE_VERSION, workload, outcome: 'prepared', observed, corpus: { files: corpus } };
  const manifestPath = join(root, name + '-fixture.json'), bytes = JSON.stringify(manifest) + '\n';
  await writeFile(manifestPath, bytes, { flag: 'wx' });
  const descriptor = descriptorFor({ manifestPath, seal: { path: manifestPath, sha256: 'sha256:' + createHash('sha256').update(bytes).digest('hex') } });
  const path = join(root, name + '-input.json');
  await writeFile(path, JSON.stringify(descriptor), { flag: 'wx' });
  return { path, descriptor, manifest };
}

test('prepare CLI has an explicit heavy gate and exact portable/native prerequisites', () => {
  const args = ['prepare', '--workload', 'W1', '--output', 'artifacts/new', '--allow-heavy'];
  assert.equal(parseFixtureArguments(args).allowHeavy, true);
  assert.equal(args.length, 6);
  for (const [more, pattern] of [
    [['prepare', '--workload', 'W1', '--output', 'artifacts/new'], /allow-heavy/],
    [['prepare', '--workload', 'WXs', '--output', 'artifacts/new', '--allow-heavy'], /font-corpus/],
    [['prepare', '--workload', 'WC', '--output', 'artifacts/new', '--allow-heavy'], /exact/],
    [['prepare', '--workload', 'WC512', '--output', 'artifacts/new', '--allow-heavy'], /seed/],
    [['prepare', '--workload', 'W1', '--output', 'artifacts/new', '--allow-heavy', '--closure-bytes', '536870912'], /closure-bytes/],
    [['prepare', '--workload', 'WC4G', '--output', 'artifacts/new', '--allow-heavy', '--seed', '/mixed.json', '--closure-bytes', '536870912'], /closure-bytes/],
  ]) assert.throws(() => parseFixtureArguments(more), pattern);
  const wc = parseFixtureArguments(['prepare', '--workload', 'WC', '--closure-bytes', '4294967296', '--seed', '/mixed.json', '--output', 'artifacts/new', '--allow-heavy']);
  assert.equal(wc.closureBytes, '4294967296');
  assert.equal(wc.seed, '/mixed.json');
});

test('parser rejects unknown, missing, duplicate and unsafe catalog arguments', () => {
  for (const args of [
    ['prepare', '--workload', 'W0', '--output'],
    ['prepare', '--workload', 'W0', '--output', 'a', '--output', 'b', '--allow-heavy'],
    ['prepare', '--workload', 'W0', '--output', 'a', '--allow-heavy', '--quiet'],
    ['catalog', '--output', 'a'],
    ['catalog', '--output', 'a', '--fixture', 'W1=x', '--fixture', 'W1=y'],
    ['catalog', '--output', 'a', '--cell', '__proto__=x'],
    ['catalog', '--output', 'a', '--fixture', 'W1='],
    ['catalog', '--output', 'a', '--allow-heavy'],
  ]) assert.throws(() => parseFixtureArguments(args));
  assert.deepEqual(parseFixtureArguments(['catalog', '--output', 'a', '--fixture', 'W1=x', '--cell', 'C8-W1=@W1']).cells, [['C8-W1', '@W1']]);
});

test('programmatic preparation also refuses implicit heavy generation before IO', async t => {
  const root = await temporary(t), output = join(root, 'must-not-exist');
  await assert.rejects(prepareFixtureInput({ workload: 'W2', output }), /allow-heavy/);
  await assert.rejects(lstat(output), { code: 'ENOENT' });
});

test('descriptor retains the exact external seal and refuses paths or fabricated identities', async t => {
  const root = await temporary(t), input = await descriptorFixture(root);
  const read = await readFixtureDescriptor(input.path);
  assert.deepEqual(read.descriptor, input.descriptor);
  assert.equal(read.fixture.workload, 'W0');
  assert.throws(() => descriptorFor({ ...input.descriptor, manifestPath: 'fixture.json' }), /absolute/);
  assert.throws(() => descriptorFor({ ...input.descriptor, seal: { ...input.descriptor.seal, path: '/other.json' } }), /exact/);
  assert.throws(() => descriptorFor({ ...input.descriptor, seal: { ...input.descriptor.seal, sha256: 'sha256:0' } }), /exact/);
  await writeFile(input.descriptor.manifestPath, JSON.stringify({ ...input.manifest, outcome: 'incomplete' }));
  await assert.rejects(readFixtureDescriptor(input.path), /changed after preparation/);
});

test('catalog creation verifies every source and maps exact portable size keys', async t => {
  const root = await temporary(t), w0 = await descriptorFixture(root), wc = await descriptorFixture(root, { workload: 'WC512' });
  assert.equal(fixtureKey({ workload: 'WC4G', observed: { closureBytes: 4294967296 } }), 'WC:4294967296');
  assert.throws(() => fixtureKey({ workload: 'WC4G', observed: { closureBytes: 536870912 } }), /closure size/);
  const output = join(root, 'catalog.json');
  const result = await createFixtureCatalog({ output, fixtures: [['W0', w0.path], ['WC:536870912', wc.path]], cells: [['C8-W0', '@W0'], ['C1-custom', w0.path]] });
  const catalog = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(result.catalogPath, output);
  assert.deepEqual(catalog.fixtures.W0, w0.descriptor);
  assert.equal(catalog.cells['C8-W0'], 'W0');
  assert.deepEqual(catalog.cells['C1-custom'], w0.descriptor);
  assert.deepEqual(selectFixtureDescriptor(catalog, { id: 'C8-W0', workload: 'W0' }), w0.descriptor);
  assert.deepEqual(selectFixtureDescriptor(catalog, { id: 'C14-copy', workload: 'WC', parameters: { closureBytes: 536870912 } }), wc.descriptor);
  assert.throws(() => selectFixtureDescriptor(catalog, { id: 'C14-copy-big', workload: 'WC', parameters: { closureBytes: 4294967296 } }), /No sealed fixture/);
});

test('catalog rejects mislabeled workloads and absent cell references without writing', async t => {
  const root = await temporary(t), input = await descriptorFixture(root);
  for (const [name, options, pattern] of [
    ['wrong', { fixtures: [['W1', input.path]] }, /does not match/],
    ['missing', { fixtures: [['W0', input.path]], cells: [['C1', '@W1']] }, /absent fixture/],
    ['duplicate', { fixtures: [['W0', input.path], ['W0', input.path]] }, /Duplicate/],
  ]) {
    const output = join(root, name + '.json');
    await assert.rejects(createFixtureCatalog({ output, ...options }), pattern);
    await assert.rejects(lstat(output), { code: 'ENOENT' });
  }
});

test('catalog refuses changed corpus bytes and keeps the output absent', async t => {
  const root = await temporary(t), source = join(root, 'source.bin');
  await writeFile(source, 'before');
  const input = await descriptorFixture(root, { corpus: [{ id: 'source', path: source, byteLength: '6', sha256: 'sha256:' + createHash('sha256').update('before').digest('hex') }] });
  await writeFile(source, 'after!');
  const output = join(root, 'catalog.json');
  await assert.rejects(createFixtureCatalog({ output, fixtures: [['W0', input.path]] }), /content changed/);
  await assert.rejects(lstat(output), { code: 'ENOENT' });
});

test('catalog never overwrites evidence or traverses output symlinks', async t => {
  const root = await temporary(t), input = await descriptorFixture(root), output = join(root, 'existing.json');
  await writeFile(output, 'retained evidence');
  await assert.rejects(createFixtureCatalog({ output, fixtures: [['W0', input.path]] }), { code: 'EEXIST' });
  assert.equal(await readFile(output, 'utf8'), 'retained evidence');
  const real = join(root, 'real'); await mkdir(real);
  const link = join(root, 'linked'); await symlink(real, link, 'dir');
  await assert.rejects(createFixtureCatalog({ output: join(link, 'catalog.json'), fixtures: [['W0', input.path]] }), /symlink/);
  await assert.rejects(lstat(join(real, 'catalog.json')), { code: 'ENOENT' });
  const descriptorLink = join(root, 'input-link.json'); await symlink(input.path, descriptorLink);
  await assert.rejects(readFixtureDescriptor(descriptorLink), /ordinary file/);
});

test('help and CLI validation are readable without starting preparation', async () => {
  let out = '', error = '';
  const streams = { stdout: { write: value => { out += value; } }, stderr: { write: value => { error += value; } } };
  assert.equal(await main(['--help'], streams), 0);
  assert.match(out, /fixture-input.json/); assert.match(out, /--allow-heavy/); assert.equal(error, '');
  assert.equal(await main(['prepare', '--workload', 'W2', '--output', 'artifacts/new'], streams), 1);
  assert.match(error, /allow-heavy/);
});
