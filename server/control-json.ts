import type { IncomingMessage } from 'node:http';
import { ProtocolError } from './errors.js';
import { adapterResources } from './observability/adapter-resources.js';

import { parseControlJSON as parse, JSONError, CONTROL_BYTES } from '../src/protocol/json.js';
export { CONTROL_BYTES };
const malformed = (): never => { throw new ProtocolError('MALFORMED_REQUEST'); };
export function parseControlJSON(bytes: Uint8Array): Record<string, unknown> {
  try { return parse(bytes); } catch (e) { if (e instanceof JSONError) throw new ProtocolError(e.code); throw e; }
}

/** Keep the assembled bytes owned through the caller's last parse or asynchronous use. */
export async function consumeControlBytes<T>(request: IncomingMessage, consume: (bytes: Uint8Array) => T | Promise<T>): Promise<T> {
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(request.headers['content-type'] ?? '') ||
      request.headers['content-encoding'] !== undefined) throw new ProtocolError('MEDIA_TYPE');
  const length = request.headers['content-length'];
  if (length !== undefined && (!/^(0|[1-9][0-9]*)$/.test(length))) return malformed();
  if (length !== undefined && BigInt(length) > BigInt(CONTROL_BYTES)) throw new ProtocolError('PAYLOAD_TOO_LARGE');
  const chunks: Buffer[] = [], releases: (() => void)[] = [];
  const releaseStream = adapterResources.handle('control-http', 'read-stream');
  const releaseChunks = () => { for (const release of releases) release(); releases.length = 0; chunks.length = 0; };
  let total = 0;
  let bytes: Buffer;
  let releaseBytes: () => void;
  try {
    // Do not destroy the socket before sending a typed 413 on a chunked overflow.
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      releases.push(adapterResources.buffer('control-http', 'incoming-chunk', chunk as Buffer));
      total += chunk.length;
      if (total > CONTROL_BYTES) throw new ProtocolError('PAYLOAD_TOO_LARGE');
      chunks.push(chunk as Buffer);
    }
    if (Object.keys(request.trailers).length) return malformed();
    bytes = Buffer.concat(chunks);
    releaseBytes = adapterResources.buffer('control-http', 'body-bytes', bytes);
  } finally { releaseChunks(); releaseStream(); }
  const releaseConsumer = adapterResources.handle('control-http', 'consumer');
  try { return await consume(bytes); }
  finally { releaseBytes(); releaseConsumer(); }
}
export async function readSessionRequest(request: IncomingMessage, bootstrap: boolean): Promise<Record<string, unknown>> {
  const body = await consumeControlBytes(request, bytes => parseControlJSON(bytes));
  const allowed = bootstrap ? ['protocolVersion', 'pairingToken'] : ['protocolVersion'];
  if (Object.keys(body).some(key => !allowed.includes(key))) return malformed();
  if (!Number.isInteger(body.protocolVersion)) return malformed();
  if (body.protocolVersion !== 1) throw new ProtocolError('PROTOCOL_VERSION');
  if (bootstrap && (typeof body.pairingToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.pairingToken))) return malformed();
  return body;
}
