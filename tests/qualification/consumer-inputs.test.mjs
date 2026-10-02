import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { copyConsumerInputs } from '../../tooling/consumer-inputs.mjs';

const canvas = 'vendor/text/canvaskit-wasm-0.40.0-ideogram.3.tgz';
const enReve = 'vendor/en-reve/frozen-example/en-reve-tokens-0.1.0.tgz';
async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), 'consumer-input-copy-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const root = join(workspace, 'source'), destination = join(workspace, 'consumer');
  const files = new Map([
    ['package.json', JSON.stringify({ dependencies: { '@en-reve/tokens': 'file:' + enReve, 'canvaskit-wasm': 'file:' + canvas } })],
    ['package-lock.json', JSON.stringify({ packages: { 'node_modules/canvaskit-wasm': { resolved: 'file:' + canvas } } })],
    ['.npmrc', 'audit=false\n'], ['tsconfig.json', '{}\n'], ['vite.config.ts', '// copied fixture config\n'],
    ['tooling/toolchain.json', '{"node":"26.10.0","npm":"12.1.0"}\n'],
    ['tooling/verify-vendor.py', '# copied verification source\n'],
    ['tests/consumer/fixture/main.ts', '// copied public consumer entry\n'],
    ['tests/consumer/registration.spec.ts', '// copied registration test\n'],
    [enReve, 'owned En Reve archive bytes\n'], [canvas, 'owned CanvasKit archive bytes\n'],
    ['src/text/profile.json', '{"id":"fixture-profile"}\n'],
    ['vendor/text/manifest.json', '{"id":"fixture-profile"}\n'],
    ['vendor/text/FILES.json', JSON.stringify([{ path: canvas }, { path: 'vendor/text/manifest.json' }])],
    ['vendor/text/notices/custom-skia-LICENSE.txt', 'fixture notice\n'],
    ['vendor/text/fonts/example.ttf', 'fixture font\n'],
  ]);
  for (const [file, bytes] of files) { await mkdir(dirname(join(root, file)), { recursive: true }); await writeFile(join(root, file), bytes); }
  await mkdir(destination, { recursive: true });
  return { workspace, root, destination, files };
}

test('consumer copy retains the complete vendor/profile closure at original relative paths', async t => {
  const { root, destination, files } = await fixture(t);
  const copied = await copyConsumerInputs(root, destination);
  assert.ok(copied.includes('vendor'));
  assert.ok(copied.includes('src/text/profile.json'));
  for (const [file, bytes] of files) {
    assert.equal(await readFile(join(destination, file), 'utf8'), bytes, file);
    assert.equal(await readFile(join(root, file), 'utf8'), bytes, 'source unchanged: ' + file);
  }
  assert.equal(await readFile(join(destination, 'src/text/profile.json'), 'utf8'), await readFile(join(destination, 'vendor/text/manifest.json'), 'utf8'));
});

test('copied package and lock local archive references resolve within the isolated consumer', async t => {
  const { root, destination } = await fixture(t);
  await copyConsumerInputs(root, destination);
  const packageJSON = JSON.parse(await readFile(join(destination, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(destination, 'package-lock.json'), 'utf8'));
  const references = [...Object.values(packageJSON.dependencies), lock.packages['node_modules/canvaskit-wasm'].resolved];
  for (const reference of references) {
    assert.ok(reference.startsWith('file:vendor/'));
    const path = reference.slice(5);
    assert.equal((await stat(join(destination, path))).isFile(), true, path);
    assert.deepEqual(await readFile(join(destination, path)), await readFile(join(root, path)));
  }
  await assert.rejects(stat(join(destination, 'canvaskit-wasm-0.40.0-ideogram.3.tgz')), { code: 'ENOENT' });
});

test('missing required selected inputs fail without falling back to another checkout', async t => {
  for (const missing of ['package.json', 'vendor', 'src/text/profile.json']) {
    const { root, destination } = await fixture(t);
    await rm(join(root, missing), { recursive: true });
    await assert.rejects(copyConsumerInputs(root, destination), error => error.code === 'ENOENT' && String(error.path ?? error.message).includes(missing));
    await assert.rejects(stat(join(destination, missing)), { code: 'ENOENT' });
  }
});

test('installed dependencies, build outputs, toolchains and sibling checkout trees are not copied', async t => {
  const { workspace, root, destination } = await fixture(t);
  for (const file of ['node_modules/private-owner/marker', 'dist/app/index.html', '.toolchain/bin/node', '.git/objects/marker', 'src/state/private.ts']) {
    await mkdir(dirname(join(root, file)), { recursive: true }); await writeFile(join(root, file), 'must stay outside consumer');
  }
  const sibling = join(workspace, 'sibling');
  await mkdir(join(sibling, 'node_modules'), { recursive: true }); await mkdir(join(sibling, 'dist'));
  await writeFile(join(sibling, 'node_modules/marker'), 'sibling dependency');
  await writeFile(join(sibling, 'dist/marker'), 'sibling build');
  const copied = await copyConsumerInputs(root, destination);
  for (const path of ['node_modules', 'dist', '.toolchain', '.git', 'src/state', 'sibling']) await assert.rejects(stat(join(destination, path)), { code: 'ENOENT' });
  assert.equal(copied.some(path => ['node_modules', 'dist', '.toolchain', '.git'].includes(path)), false);
  assert.equal(await readFile(join(sibling, 'node_modules/marker'), 'utf8'), 'sibling dependency');
  assert.equal(await readFile(join(sibling, 'dist/marker'), 'utf8'), 'sibling build');
});
