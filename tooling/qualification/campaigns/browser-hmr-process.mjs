/** Explicit, isolated D05 development process. Vite and the real editor API
 * share one literal-loopback HTTP listener. No proxy or Origin rewriting. */
import {readFile, realpath, mkdtemp, lstat} from 'node:fs/promises';
import {dirname, isAbsolute, join, resolve, sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';

const [root, requestedRepo] = process.argv.slice(2);
if (!root || !requestedRepo || !isAbsolute(root) || !isAbsolute(requestedRepo) || !process.send) throw Error('D05 development child requires absolute root/repository and an IPC parent');
const repo = await realpath(requestedRepo);
process.chdir(repo);
const {createServer: createViteServer, version: viteVersion} = await import(pathToFileURL(join(repo, 'node_modules/vite/dist/node/index.js')).href);
if (viteVersion !== '8.3.1') throw Error('D05 requires pinned Vite 8.3.1');
const {startLocalServer} = await import(pathToFileURL(join(repo, 'dist/local/server/http.js')).href);
const {BOOTSTRAP_PRELUDE} = await import(pathToFileURL(join(repo, 'dist/local/server/static.js')).href);
const {assertSeparateDirectories} = await import(pathToFileURL(join(repo, 'dist/local/server/private-root.js')).href);
const cacheDirectory = await mkdtemp(join(await realpath(tmpdir()), 'ideogram-hmr-vite-cache-'));
let vite, server, closing;

async function regularSource(path) {
  try {
    if (await realpath(dirname(path)) !== dirname(path)) return false;
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink() && await realpath(path) === path;
  } catch (error) {
    // TypeScript source imports use .js specifiers. Vite resolves these to
    // their implementation; inspect that actual file rather than trusting a
    // missing .js path whose .ts target could be a symlink.
    if (error.code !== 'ENOENT' || await realpath(dirname(path)).catch(() => null) !== dirname(path)) return false;
    const suffix = path.endsWith('.mjs') ? ['.mts'] : path.endsWith('.cjs') ? ['.cts'] : path.endsWith('.js') ? ['.ts', '.tsx'] : [];
    for (const extension of suffix) {
      const candidate = path.replace(/\.[cm]?js$/, extension);
      const info = await lstat(candidate).catch(() => null);
      if (info) return info.isFile() && !info.isSymbolicLink() && await realpath(candidate) === candidate;
    }
    return false;
  }
}
async function sourceTarget(url, origin) {
  const parsed = new URL(url, origin);
  if (parsed.origin !== origin || /%(?![a-f\d]{2})/i.test(url)) return false;
  let path;
  try { path = decodeURIComponent(parsed.pathname); } catch { return false; }
  if (path.includes('\\') || path.includes('\0') || path.split('/').some(part => part === '..' || part === '.')) return false;
  if (path === '/') {
    const entries = [...parsed.searchParams];
    return entries.length === 0 || entries.length === 1 && entries[0][0] === 'progress-report';
  }
  // These are browser module graph roots, not an arbitrary file server.
  if (path === '/@vite/client' || path === '/@vite/env' || path === '/@id/__x00__vite-browser-external') return true;
  let relative = path;
  if (path.startsWith('/@fs/')) {
    const absolute = resolve(path.slice('/@fs/'.length));
    if (absolute.startsWith(cacheDirectory + sep)) return /\.(?:[cm]?js|json)$/.test(absolute) && await regularSource(absolute);
    if (!absolute.startsWith(repo + sep)) return false;
    relative = '/' + absolute.slice(repo.length + 1).split(sep).join('/');
  }
  if (!['/src/', '/node_modules/', '/vendor/text/fonts/'].some(prefix => relative.startsWith(prefix)) && relative !== '/vendor/text/manifest.json') return false;
  if (relative.split('/').some(part => part.startsWith('.') && part !== '.vite')) return false;
  return /\.(?:[cm]?js|[cm]?ts|tsx|jsx|css|json|wasm|woff2?|ttf|otf|png|jpe?g|webp|svg)(?:$)/i.test(relative) && await regularSource(join(repo, relative.slice(1)));
}

function bootstrapHTML(html) {
  const resources = [];
  html = html.replace(/<script\b[^>]*\bsrc=[^>]*><\/script>|<link\b[^>]*>/gi, tag => { resources.push(tag); return ''; });
  html = html.replace(/<\/head>/i, `<template id="ie-resources">${resources.join('')}</template></head>`);
  return html.replace(/<head(?:\s[^>]*)?>/i, match => `${match}<script>${BOOTSTRAP_PRELUDE}</script>`);
}

async function close() {
  if (closing) return closing;
  closing = (async () => {
    try { if (server) await server.close(); else await vite?.close(); }
    finally { if (process.connected) process.disconnect(); }
  })();
  return closing;
}

try {
  server = await startLocalServer({root, credentialConfigured: false, development: async ({server: httpServer, origin, nonce, hmrPath}) => {
    await assertSeparateDirectories(root, repo);
    vite = await createViteServer({
      root: repo, configFile: join(repo, 'vite.app.config.ts'), publicDir: false, cacheDir: cacheDirectory,
      mode: 'development', clearScreen: false, logLevel: 'error', appType: 'custom',
      html: {cspNonce: nonce},
      server: {middlewareMode: true, host: '127.0.0.1', cors: false, allowedHosts: ['127.0.0.1'], origin,
        headers: {}, proxy: {}, forwardConsole: false,
        hmr: {overlay: false}, ws: {server: httpServer, protocol: 'ws', host: '127.0.0.1', clientPort: Number(new URL(origin).port), path: hmrPath},
        fs: {strict: true, allow: [repo, cacheDirectory], deny: ['.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**', '**/.toolchain/**', '**/artifacts/**', '**/evidence/**', '**/server/**']},
      },
    });
    return {
      websocketToken: vite.config.webSocketToken,
      close: () => vite.close(),
      async handle(request, response) {
        if (!await sourceTarget(request.url, origin)) { response.writeHead(404); response.end(); return; }
        if (new URL(request.url, origin).pathname === '/') {
          const html = bootstrapHTML(await vite.transformIndexHtml('/', await readFile(join(repo, 'index.html'), 'utf8')));
          response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}); response.end(html); return;
        }
        await new Promise((done, reject) => {
          const cleanup = () => { response.off('finish', finished); response.off('close', finished); };
          const finished = () => { cleanup(); done(); };
          response.once('finish', finished); response.once('close', finished);
          vite.middlewares(request, response, error => {
            if (error) { cleanup(); reject(error); return; }
            if (!response.writableEnded) { response.writeHead(404); response.end(); }
          });
        });
      },
    };
  }}, {writer: {effectCounters: globalThis.__storeNetworkCounters?.shared}});
  process.on('message', message => {
    if (message === 'pair' && !closing) process.send({type: 'pair', url: server.issuePairingURL()});
    if (message === 'resources') process.send({type: 'resources', value: process.memoryUsage()});
    if (message === 'effects') process.send({type: 'effects', value: globalThis.__storeNetworkCounters?.read() ?? null});
    if (message === 'close') void close().catch(() => { process.exitCode = 1; });
  });
  process.once('disconnect', () => { void close().catch(() => { process.exitCode = 1; }); });
  process.once('SIGTERM', () => { void close().catch(() => { process.exitCode = 1; }); });
  process.once('SIGINT', () => { void close().catch(() => { process.exitCode = 1; }); });
  process.send({type: 'ready', origin: server.origin, kind: 'vite-development-server-1', viteVersion, sourceRoot: repo, cacheDirectory});
} catch (error) {
  await close();
  throw error;
}
