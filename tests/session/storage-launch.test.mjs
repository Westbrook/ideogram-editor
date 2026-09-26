import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { fork, spawn } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { startLocalServer } from '../../dist/local/server/http.js';
import { launch } from '../../dist/local/tooling/launcher.js';
import { BOOTSTRAP_PRELUDE, BOOTSTRAP_CSP } from '../../dist/local/server/static.js';
import { fixture, call, pair, tokenFrom, cookieFrom, readHeaders } from './helpers.mjs';

test('SEC06: real private root/file permissions, symlink and insecure-root rejection', async t => {
  const server = await fixture(t);
  assert.equal((await lstat(server.root)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(server.root, 'launch.json'))).mode & 0o777, 0o600);
  const insecure = join(server.directory, 'insecure');
  await mkdir(insecure, { mode: 0o755 });
  await chmod(insecure, 0o755);
  await assert.rejects(startLocalServer({ root: insecure }), /owner-only/);
  const linked = join(server.directory, 'linked');
  await symlink(server.root, linked);
  await assert.rejects(startLocalServer({ root: linked }), /owner-only/);
  await assert.rejects(startLocalServer({ root: join(linked, 'child') }), /owner-only/);
  await assert.rejects(startLocalServer({ root: `${linked}/../other` }), /owner-only/);
  const root = join(server.directory, 'file-link');
  await mkdir(root, { mode: 0o700 });
  const outside = join(server.directory, 'untouched');
  await writeFile(outside, 'original', { mode: 0o600 });
  await symlink(outside, join(root, 'launch.json'));
  await assert.rejects(startLocalServer({ root }));
  assert.equal(await readFile(outside, 'utf8'), 'original');
  const insecureFile = join(server.directory, 'file-permissions');
  await mkdir(insecureFile, { mode: 0o700 });
  await writeFile(join(insecureFile, 'launch.json'), 'original', { mode: 0o644 });
  await chmod(join(insecureFile, 'launch.json'), 0o644);
  await assert.rejects(startLocalServer({ root: insecureFile }), /owner-only/);
  assert.equal(await readFile(join(insecureFile, 'launch.json'), 'utf8'), 'original');
  await assert.rejects(startLocalServer({ root: server.root, staticDirectory: server.directory }), /must be separate/);
});

test('SEC03/06: root replacement invalidates the running boundary without modifying user data', async t => {
  const server = await fixture(t);
  const paired = await pair(server);
  const token = tokenFrom(server.issuePairingURL());
  const moved = server.root + '-old';
  await writeFile(join(server.root, 'future-job-data'), 'retained', { mode: 0o600 });
  await rename(server.root, moved);
  await mkdir(server.root, { mode: 0o700 });
  assert.equal((await call(server.origin, '/api/v1/session', { headers: readHeaders(cookieFrom(paired)) })).status, 503);
  await rename(server.root, server.root + '-replacement');
  await rename(moved, server.root);
  assert.equal((await pair(server, token)).status, 503);
  assert.throws(() => server.issuePairingURL());
  assert.equal(await readFile(join(server.root, 'future-job-data'), 'utf8'), 'retained');
});

test('SEC06: filesystem-equivalent static/private roots and either ancestor relationship are rejected', async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'ideogram-root-alias-'));
  const privateRoot = join(directory, 'PrivateData');
  const nested = join(privateRoot, 'assets');
  const sibling = join(directory, 'private-build');
  for (const path of [privateRoot, nested, sibling]) {
    await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, 'index.html'), '<html><head></head><body>fixture</body></html>', { mode: 0o600 });
    await writeFile(join(path, 'private.png'), 'PRIVATE-RASTER-SENTINEL', { mode: 0o600 });
  }
  const rejectOverlap = async (root, staticDirectory) => {
    let server;
    try {
      await assert.rejects(async () => { server = await startLocalServer({ root, staticDirectory }); }, /must be separate/);
    } finally { await server?.close(); }
  };
  await rejectOverlap(privateRoot, privateRoot);
  await rejectOverlap(privateRoot, nested);
  await rejectOverlap(nested, privateRoot);
  const identity = await lstat(privateRoot, { bigint: true });
  const alias = join(directory, 'privatedata');
  const aliased = await lstat(alias, { bigint: true }).catch(error => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (aliased && aliased.dev === identity.dev && aliased.ino === identity.ino) {
    t.diagnostic('Host supports case aliases.');
    await rejectOverlap(privateRoot, alias);
    await rejectOverlap(privateRoot, join(alias, 'assets'));
    await rejectOverlap(nested, alias);
    await rejectOverlap(alias, nested);
  } else {
    t.diagnostic('Host has no matching case alias; no case-insensitive filesystem qualification claimed.');
  }
  // Shared parents and similar name prefixes must not prohibit separate roots.
  const server = await startLocalServer({ root: privateRoot, staticDirectory: sibling });
  try { assert.equal((await call(server.origin, '/')).status, 200); }
  finally { await server.close(); }
});

test('SEC03: actual killed-process restart rejects old cookie, CSRF and unused pairing; leaves root data intact', async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'ideogram-restart-'));
  const root = join(directory, 'private');
  const children = [];
  const output = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    }
  });
  async function start() {
    const child = fork(new URL('./process-fixture.mjs', import.meta.url), [root], {
      execPath: process.execPath, execArgv: ['--import', resolve('tests/session/no-egress.mjs')],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { PATH: process.env.PATH },
    });
    children.push(child);
    child.stdout.on('data', data => output.push(data.toString()));
    child.stderr.on('data', data => output.push(data.toString()));
    const [{ origin }] = await once(child, 'message');
    const nextToken = async () => {
      const result = once(child, 'message'); child.send('pair');
      return tokenFrom((await result)[0].pairingURL);
    };
    return { child, origin, nextToken };
  }
  const first = await start();
  const initialToken = await first.nextToken();
  const paired = await pair(first, initialToken);
  const unused = await first.nextToken();
  await writeFile(join(root, 'future-job-data'), 'retained-job-placeholder', { mode: 0o600 });
  const exited = once(first.child, 'exit'); first.child.kill('SIGKILL'); await exited;
  const second = await start();
  assert.equal((await call(second.origin, '/api/v1/session', { headers: readHeaders(cookieFrom(paired)) })).status, 401);
  assert.equal((await call(second.origin, '/api/v1/session/renew', { method: 'POST', headers: { Origin: second.origin, Cookie: cookieFrom(paired), 'X-App-CSRF': paired.json.csrfToken }, body: { protocolVersion: 1 } })).status, 401);
  assert.equal((await pair(second, unused)).status, 401);
  assert.equal((await pair(second, initialToken)).status, 401);
  assert.equal((await pair(second, await second.nextToken())).status, 200);
  assert.equal(await readFile(join(root, 'future-job-data'), 'utf8'), 'retained-job-placeholder');
  // The durable writer now owns additional private files. Restart still preserves
  // prior data; its implementation layout is not part of session authentication.
  assert.ok((await readdir(root)).includes('future-job-data'));
  assert.ok((await readdir(root)).includes('launch.json'));
  for (const secret of [initialToken, unused, cookieFrom(paired), paired.json.csrfToken]) assert.ok(!output.join('').includes(secret));
});

test('SEC03/05: trusted static build and synchronous fragment-removal contract before shell resources', async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'ideogram-static-'));
  const assets = join(directory, 'assets'); await mkdir(assets);
  await writeFile(join(directory, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="/assets/app.css"><script type="module" src="/assets/app.js"></script></head><body>shell fixture</body></html>');
  await writeFile(join(assets, 'app.js'), 'export const status = "fixture";');
  await writeFile(join(assets, 'app.css'), 'body { color: black; }');
  await writeFile(join(assets, 'app.js.map'), '{"sourcesContent":["secret source"]}');
  await writeFile(join(assets, 'user.svg'), '<svg onload="alert(1)"/>');
  await writeFile(join(directory, '.env'), 'FAL_KEY=must-not-leak');
  const server = await fixture(t, { staticDirectory: directory });
  const response = await call(server.origin, '/?progress-report');
  assert.equal(response.status, 200);
  assert.ok(response.text.indexOf(BOOTSTRAP_PRELUDE) < response.text.indexOf('<link'));
  assert.ok(response.headers['content-security-policy'].includes(BOOTSTRAP_CSP));
  const flagValue = await call(server.origin, '/?progress-report=https://evil.test');
  assert.equal(flagValue.status, 200); assert.equal(flagValue.headers.location, undefined);
  assert.equal((await call(server.origin, '/?progress-report&pairingToken=invalid')).status, 400);
  for (const route of ['/assets/app.js', '/assets/app.css']) assert.equal((await call(server.origin, route)).status, 200);
  for (const route of ['/assets/app.js.map', '/assets/user.svg', '/.env']) assert.equal((await call(server.origin, route)).status, 404);
  const url = new URL(server.issuePairingURL()); url.search = '?progress-report';
  const window = {};
  let cleaned = false;
  const context = { window, addEventListener() {}, location: url, history: { state: { retained: true }, replaceState(state, _title, next) {
    assert.deepEqual(state, { retained: true }); assert.equal(next, '/?progress-report');
    assert.equal(window.__IE_PAIRING__, undefined); cleaned = true;
  } } };
  runInNewContext(BOOTSTRAP_PRELUDE, context);
  assert.equal(cleaned, true); assert.equal(window.__IE_PAIRING__, tokenFrom(url.href));
  const token = window.__IE_PAIRING__; delete window.__IE_PAIRING__;
  assert.equal((await pair(server, token)).status, 200);
  assert.equal(window.__IE_PAIRING__, undefined);
  // A malformed fragment is removed too, and never becomes a usable token.
  context.location.hash = '#pairing=bad&next=https://evil.test';
  runInNewContext(BOOTSTRAP_PRELUDE, context);
  assert.equal(window.__IE_PAIRING__, undefined);
  await symlink(join(assets, 'app.js'), join(assets, 'linked.js'));
  await assert.rejects(startLocalServer({ root: join(server.directory, 'another-root'), staticDirectory: directory }), /Unsafe browser build path/);
});

test('Launcher: private fragment goes only to browser callback; executable launch records an OS-selected origin', async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'ideogram-launch-'));
  const logs = []; const urls = [];
  const server = await launch({ root: join(directory, 'callback-root'), log: message => logs.push(message), openBrowser: async url => { urls.push(url); } });
  t.after(() => server.close());
  assert.equal(urls.length, 1); assert.match(urls[0], /\/#pairing=[A-Za-z0-9_-]{43}$/);
  assert.ok(!logs.join('').includes(tokenFrom(urls[0])));
  const first = tokenFrom(urls[0]); await server.pair();
  assert.equal((await pair(server, first)).status, 401);
  assert.equal((await pair(server, tokenFrom(urls[1]))).status, 200);
  const child = spawn(process.execPath, ['dist/local/tooling/launch.js', '--no-open', '--root', join(directory, 'cli-root')], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, FAL_KEY: 'server-env-sentinel' },
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stdout = ''; let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const origin = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.stdout.on('data', data => {
      stdout += data;
      const match = /http:\/\/127\.0\.0\.1:[0-9]+/.exec(stdout);
      if (match) resolve(match[0]);
    });
    child.once('exit', () => reject(new Error('Launcher exited before listening.')));
  });
  assert.equal((await call(origin, '/')).status, 200);
  const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit;
  assert.equal(child.exitCode, 0); assert.equal(stderr, '');
  assert.ok(!stdout.includes('pairing=')); assert.ok(!stdout.includes('server-env-sentinel'));
  const record = JSON.parse(await readFile(join(directory, 'cli-root/launch.json')));
  assert.equal(record.origin, origin);
});
