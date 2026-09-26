import type { IncomingMessage } from 'node:http';
import { ProtocolError } from './errors.js';

import { parseControlJSON as parse, JSONError, CONTROL_BYTES } from '../src/protocol/json.js';
export { CONTROL_BYTES };
const malformed = (): never => { throw new ProtocolError('MALFORMED_REQUEST'); };
export function parseControlJSON(bytes: Uint8Array): Record<string, unknown> {
  try { return parse(bytes); } catch (e) { if (e instanceof JSONError) throw new ProtocolError(e.code); throw e; }
}

export async function readControlBytes(request: IncomingMessage): Promise<Uint8Array> {
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(request.headers['content-type'] ?? '') ||
      request.headers['content-encoding'] !== undefined) throw new ProtocolError('MEDIA_TYPE');
  const length = request.headers['content-length'];
  if (length !== undefined && (!/^(0|[1-9][0-9]*)$/.test(length))) return malformed();
  if (length !== undefined && BigInt(length) > BigInt(CONTROL_BYTES)) throw new ProtocolError('PAYLOAD_TOO_LARGE');
  const chunks: Buffer[] = [];
  let total = 0;
  // Do not destroy the socket before sending a typed 413 on a chunked overflow.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    total += chunk.length;
    if (total > CONTROL_BYTES) throw new ProtocolError('PAYLOAD_TOO_LARGE');
    chunks.push(chunk as Buffer);
  }
  if (Object.keys(request.trailers).length) return malformed();
  return Buffer.concat(chunks);
}
export async function readSessionRequest(request: IncomingMessage, bootstrap: boolean): Promise<Record<string, unknown>> {
  const body = parseControlJSON(await readControlBytes(request));
  const allowed = bootstrap ? ['protocolVersion', 'pairingToken'] : ['protocolVersion'];
  if (Object.keys(body).some(key => !allowed.includes(key))) return malformed();
  if (!Number.isInteger(body.protocolVersion)) return malformed();
  if (body.protocolVersion !== 1) throw new ProtocolError('PROTOCOL_VERSION');
  if (bootstrap && (typeof body.pairingToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.pairingToken))) return malformed();
  return body;
}
