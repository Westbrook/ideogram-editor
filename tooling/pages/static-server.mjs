import { createServer } from 'node:http';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { publicBase } from './artifact.mjs';
import { promisify } from 'node:util';
import { gzip, brotliCompress, constants } from 'node:zlib';
const gzipAsync = promisify(gzip), brotliAsync = promisify(brotliCompress);

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };
export async function startStaticServer(output, { compressedTextAssets = false } = {}) {
  const directory = resolve(output), textAssetResponses = [];
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
      const bytes = await readFile(path), extension = extname(path);
      // Regression mode uses real HTTP content coding, not route-fulfilled or
      // already-decoded mocks. The public artifact bytes remain untouched.
      const encoding = compressedTextAssets ? extension === '.wasm' ? 'br' : /\.(?:ttf|otf)$/.test(extension) ? 'gzip' : null : null;
      const encoded = encoding === 'gzip' ? await gzipAsync(bytes) : encoding === 'br' ? await brotliAsync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }) : bytes;
      if (encoding) {
        if (textAssetResponses.length >= 256) throw Error('Compressed asset observation bound exceeded');
        textAssetResponses.push({ path: member, encoding, encodedBytes: encoded.length, decodedBytes: bytes.length });
      }
      response.writeHead(200, { 'Content-Type': types[extension] ?? 'application/octet-stream', 'Content-Length': encoded.length,
        ...(encoding ? { 'Content-Encoding': encoding, Vary: 'Accept-Encoding' } : {}),
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(request.method === 'HEAD' ? undefined : encoded);
    } catch (error) { response.writeHead(error.code === 'ENOENT' ? 404 : 400); response.end(); }
  });
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Missing static preview listener');
  return { textAssetResponses, origin: `http://127.0.0.1:${address.port}`, baseURL: `http://127.0.0.1:${address.port}${publicBase}`,
    close: () => new Promise((accept, reject) => { server.close(error => error ? reject(error) : accept()); server.closeAllConnections(); }) };
}
