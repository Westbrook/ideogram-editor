import type { IncomingMessage } from 'node:http';
import { ProtocolError } from './errors.js';

export const CONTROL_BYTES = 64 * 1024;
const malformed = (): never => { throw new ProtocolError('MALFORMED_REQUEST'); };

// JSON.parse alone silently accepts duplicate keys, overflow, and lone surrogates.
// Validate tokens first, including decoded property names, then use the native parser.
export function parseControlJSON(bytes: Uint8Array): Record<string, unknown> {
  if (bytes.byteLength > CONTROL_BYTES) throw new ProtocolError('PAYLOAD_TOO_LARGE');
  let source: string;
  try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return malformed(); }
  let at = 0;
  const whitespace = () => { while (/[\x20\t\n\r]/.test(source[at] ?? '\0')) at++; };
  function string(): string {
    const start = at++;
    while (at < source.length) {
      if (source[at] === '\\') { at += 2; continue; }
      if (source[at++] === '"') {
        let value: string;
        try { value = JSON.parse(source.slice(start, at)) as string; } catch { return malformed(); }
        for (const character of value) {
          const point = character.codePointAt(0)!;
          if (point >= 0xd800 && point <= 0xdfff) return malformed();
        }
        return value;
      }
    }
    return malformed();
  }
  function value(depth: number): void {
    // Session controls have no nested values; bound hostile parser recursion.
    if (depth > 64) return malformed();
    whitespace();
    const token = source[at];
    if (token === '"') { string(); return; }
    if (token === '{' || token === '[') {
      const object = token === '{';
      const end = object ? '}' : ']';
      const keys = new Set<string>();
      at++; whitespace();
      if (source[at] === end) { at++; return; }
      while (at < source.length) {
        if (object) {
          if (source[at] !== '"') return malformed();
          const key = string();
          if (keys.has(key)) return malformed();
          keys.add(key); whitespace();
          if (source[at++] !== ':') return malformed();
        }
        value(depth + 1); whitespace();
        if (source[at] === end) { at++; return; }
        if (source[at++] !== ',') return malformed();
        whitespace();
      }
      return malformed();
    }
    const literal = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(source.slice(at));
    if (!literal) return malformed();
    if (!['true', 'false', 'null'].includes(literal[0]) && !Number.isFinite(Number(literal[0]))) return malformed();
    at += literal[0].length;
  }
  value(0); whitespace();
  if (at !== source.length) return malformed();
  const result: unknown = JSON.parse(source);
  if (!result || typeof result !== 'object' || Array.isArray(result)) return malformed();
  return result as Record<string, unknown>;
}

export async function readSessionRequest(request: IncomingMessage, bootstrap: boolean): Promise<Record<string, unknown>> {
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
  const body = parseControlJSON(Buffer.concat(chunks));
  const allowed = bootstrap ? ['protocolVersion', 'pairingToken'] : ['protocolVersion'];
  if (Object.keys(body).some(key => !allowed.includes(key))) return malformed();
  if (!Number.isInteger(body.protocolVersion)) return malformed();
  if (body.protocolVersion !== 1) throw new ProtocolError('PROTOCOL_VERSION');
  if (bootstrap && (typeof body.pairingToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.pairingToken))) return malformed();
  return body;
}
