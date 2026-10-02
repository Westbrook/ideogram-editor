import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadStatic, BOOTSTRAP_PRELUDE } from '../../dist/local/server/static.js';

// Read the distributed source independently of the loader's server authority.
// The shared runner binds both to the same current build inputs.
const profileBytes = await readFile(new URL('../../src/text/profile.json', import.meta.url));
const profileRoute = '/assets/profile-aB0_-C9d.json';
const mismatch = /Browser text profile asset differs from the current renderer profile/;

async function buildFixture(t, entries = []) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'ideogram-static-profile-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'index.html'), '<!doctype html><html><head></head><body>fixture</body></html>');
  for (const [route, bytes] of entries) {
    const file = join(directory, route.replace(/^\//, ''));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
  return directory;
}

test('SEC05: exact current text profile is the sole additional JSON asset type', async t => {
  const script = Buffer.from('export const staticFixture = true;');
  const directory = await buildFixture(t, [[profileRoute, profileBytes], ['/assets/app.js', script]]);
  const files = await loadStatic(directory);
  assert.deepEqual(files.get(profileRoute), { bytes: profileBytes, type: 'application/json; charset=utf-8' });
  assert.deepEqual(files.get('/assets/app.js'), { bytes: script, type: 'text/javascript; charset=utf-8' });
  assert.ok(files.get('/').bytes.toString().includes(BOOTSTRAP_PRELUDE));
  assert.deepEqual([...files.keys()].sort(), ['/', '/assets/app.js', profileRoute].sort());
});

test('SEC05: same-length whitespace changes cannot pass by preserving the parsed profile or ID', async t => {
  const reformatted = Buffer.from(profileBytes);
  const newline = reformatted.indexOf(10);
  assert.ok(newline >= 0, 'distributed profile contains formatting whitespace');
  reformatted[newline] = 13;
  assert.equal(reformatted.length, profileBytes.length);
  assert.notDeepEqual(reformatted, profileBytes);
  assert.deepEqual(JSON.parse(reformatted.toString()), JSON.parse(profileBytes.toString()));
  const directory = await buildFixture(t, [[profileRoute, reformatted]]);
  await assert.rejects(loadStatic(directory), mismatch);
});

test('SEC05: different-size profile-shaped data fails before admission', async t => {
  const reformatted = Buffer.concat([profileBytes, Buffer.from('\n')]);
  assert.deepEqual(JSON.parse(reformatted.toString()), JSON.parse(profileBytes.toString()));
  const directory = await buildFixture(t, [[profileRoute, reformatted]]);
  await assert.rejects(loadStatic(directory), mismatch);
});

test('SEC05: a retained historical profile cannot stand in for the current profile asset', async t => {
  const retained = await readFile(new URL('../../src/text/retained-profiles/c19791ae.json', import.meta.url));
  assert.notDeepEqual(retained, profileBytes);
  const directory = await buildFixture(t, [[profileRoute, retained]]);
  await assert.rejects(loadStatic(directory), mismatch);
});

test('SEC05: exact profile bytes do not authorize nested, hidden or non-Vite JSON routes', async t => {
  const denied = [
    '/profile-aB0_-C9d.json', '/assets/nested/profile-aB0_-C9d.json',
    '/.hidden/assets/profile-aB0_-C9d.json', '/assets/.hidden/profile-aB0_-C9d.json',
    '/assets/.profile-aB0_-C9d.json', '/assets/profile.json',
    '/assets/profile-1234567.json', '/assets/profile-123456789.json',
    '/assets/profile-aB0_-C9d.json.map', '/assets/profile-aB0_-C9d.JSON',
    '/assets/profile-aB0_-C9d.json\n', '/assets/profile-aB0_-C9d.json\r\n',
    '/assets/retained-profiles/c19791ae.json',
  ];
  const directory = await buildFixture(t, denied.map(route => [route, profileBytes]));
  const files = await loadStatic(directory);
  for (const route of denied) assert.equal(files.has(route), false, route);
  assert.deepEqual([...files.keys()], ['/']);
});

test('SEC05: arbitrary JSON, build evidence, config, maps and uploaded SVG remain private', async t => {
  const denied = [
    ['/assets/config.json', '{"private":"config"}'],
    ['/build-evidence.json', '{"inputs":["private source"]}'],
    ['/assets/build-evidence.json', '{"inputs":["private source"]}'],
    ['/.vite/manifest.json', '{"private":"manifest"}'],
    ['/.env', 'FAL_KEY=must-not-leak'],
    ['/assets/app.js.map', '{"sourcesContent":["private source"]}'],
    ['/assets/user.svg', '<svg onload="alert(1)"/>'],
  ];
  const directory = await buildFixture(t, [[profileRoute, profileBytes], ...denied]);
  const files = await loadStatic(directory);
  for (const [route] of denied) assert.equal(files.has(route), false, route);
  assert.equal(files.get(profileRoute).type, 'application/json; charset=utf-8');
});

test('SEC06: profile-shaped symlinks retain the existing unsafe-build rejection', async t => {
  const directory = await buildFixture(t, [['/assets/current.data', profileBytes]]);
  await symlink(join(directory, 'assets/current.data'), join(directory, profileRoute.slice(1)));
  await assert.rejects(loadStatic(directory), /Unsafe browser build path/);
});
