import { request as httpRequest } from 'node:http';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLocalServer } from '../../dist/local/server/http.js';

export async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'ideogram-session-'));
  const server = await startLocalServer({ root: join(directory, 'private'), ...options });
  t.after(() => server.close());
  return { ...server, directory };
}
export function exchange(origin, path, options = {}) {
  const url = new URL(origin);
  const bytes = options.raw ?? (options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body)));
  const headers = { ...(options.body !== undefined || options.raw !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}), ...options.headers };
  const request = httpRequest({ hostname: '127.0.0.1', port: url.port, path, method: options.method ?? 'GET', headers, agent: false });
  const response = new Promise((resolve, reject) => {
    request.on('error', reject);
    request.on('response', incoming => {
      const chunks = [];
      incoming.on('data', chunk => chunks.push(chunk));
      incoming.on('error', reject);
      incoming.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: incoming.statusCode, headers: incoming.headers, text,
          json: text && incoming.headers['content-type']?.startsWith('application/json') ? JSON.parse(text) : undefined });
      });
    });
  });
  if (!options.defer) request.end(bytes);
  return { request, response };
}
export const call = (origin, path, options) => exchange(origin, path, options).response;
export const tokenFrom = url => new URL(url).hash.slice(9);
export const cookieFrom = response => response.headers['set-cookie'][0].split(';')[0];
export async function pair(server, token = tokenFrom(server.issuePairingURL())) {
  return call(server.origin, '/api/v1/session/bootstrap', { method: 'POST',
    headers: { Origin: server.origin }, body: { protocolVersion: 1, pairingToken: token } });
}
export const readHeaders = cookie => ({ Cookie: cookie, 'Sec-Fetch-Site': 'same-origin', 'X-App-Client': 'LP-1' });
export const mutationHeaders = (server, paired) => ({ Origin: server.origin, Cookie: cookieFrom(paired), 'X-App-CSRF': paired.json.csrfToken });
