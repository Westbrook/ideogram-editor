import { createServer } from 'node:http';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { publicBase } from './artifact.mjs';

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };
export async function startStaticServer(output) {
  const directory = resolve(output);
  if (await realpath(directory) !== directory) throw Error('Canonical Pages artifact directory required');
  const server = createServer(async (request, response) => {
    try {
      if (!['GET', 'HEAD'].includes(request.method ?? '')) { response.writeHead(405); response.end(); return; }
      const raw = (request.url ?? '').split('?')[0];
      if (/%(?:2f|5c)/i.test(raw)) { response.writeHead(400); response.end(); return; }
      const pathname = decodeURIComponent(raw);
      if (!pathname.startsWith(publicBase)) { response.writeHead(404); response.end(); return; }
      const member = pathname.slice(publicBase.length) || 'index.html';
      if (member.includes('\\') || member.split('/').some(part => !part || part === '.' || part === '..')) { response.writeHead(404); response.end(); return; }
      const path = join(directory, member), stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || await realpath(path) !== path) { response.writeHead(404); response.end(); return; }
      const bytes = await readFile(path);
      response.writeHead(200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream', 'Content-Length': bytes.length,
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch (error) { response.writeHead(error.code === 'ENOENT' ? 404 : 400); response.end(); }
  });
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Missing static preview listener');
  return { origin: `http://127.0.0.1:${address.port}`, baseURL: `http://127.0.0.1:${address.port}${publicBase}`,
    close: () => new Promise((accept, reject) => { server.close(error => error ? reject(error) : accept()); server.closeAllConnections(); }) };
}
