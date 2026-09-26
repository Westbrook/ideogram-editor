import { createHash } from 'node:crypto';
import type { BlobRef, CommandRequest, ExpectedVersions } from '../../src/protocol/store.js';
import { parseControlJSON } from '../control-json.js';
import { ProtocolError } from '../errors.js';
import { StoreError } from './errors.js';

const bad = (): never => { throw new StoreError('MALFORMED_REQUEST'); };
export const isId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export const isSeq = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
function keys(value: unknown, names: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) bad();
}
export function validateBlob(value: unknown): asserts value is BlobRef {
  keys(value, ['hash', 'byteLength', 'mediaType']);
  if (typeof value.hash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.hash) || !isSeq(value.byteLength) ||
      typeof value.mediaType !== 'string' || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(value.mediaType) || value.mediaType.length > 128) bad();
}
function parse(bytes: Uint8Array) {
  try { return parseControlJSON(bytes); }
  catch (error) {
    if (error instanceof ProtocolError) throw new StoreError(error.code === 'PAYLOAD_TOO_LARGE' ? error.code : 'MALFORMED_REQUEST');
    throw error;
  }
}
export function parseCommand(bytes: Uint8Array): CommandRequest {
  const value = parse(bytes);
  keys(value, ['protocolVersion', 'command']);
  if (!Number.isInteger(value.protocolVersion)) bad();
  if (value.protocolVersion !== 1) throw new StoreError('PROTOCOL_VERSION');
  const c = value.command;
  keys(c, ['schemaVersion', 'commandId', 'clientId', 'sessionId', 'correlationId', 'causationId', 'transactionId',
    'documentId', 'expectedDocumentRevision', 'expectedEntityVersions', 'issuedAt', 'body']);
  if (c.schemaVersion !== 1 || !['commandId', 'clientId', 'sessionId', 'correlationId', 'transactionId'].every(k => isId(c[k])) ||
      !(c.causationId === null || isId(c.causationId)) || !(c.documentId === null || isId(c.documentId)) ||
      !(c.expectedDocumentRevision === null || isSeq(c.expectedDocumentRevision)) ||
      typeof c.issuedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(c.issuedAt) ||
      !Number.isFinite(Date.parse(c.issuedAt)) || new Date(c.issuedAt).toISOString() !== c.issuedAt) bad();
  validateBlob(c.expectedEntityVersions);
  const body = c.body as Record<string, unknown>;
  if (!body || typeof body !== 'object' || Array.isArray(body)) bad();
  if (body.type === 'NewDocument') {
    keys(body, ['type', 'width', 'height', 'color', 'depth']);
    if (!Number.isSafeInteger(body.width) || !Number.isSafeInteger(body.height) || !Number.isSafeInteger(body.depth) ||
        typeof body.color !== 'string' || body.color.length > 32) bad();
  } else if (body.type === 'SaveCheckpoint') {
    keys(body, ['type', 'name']);
    if (typeof body.name !== 'string') bad();
  } else throw new StoreError('UNSUPPORTED_COMMAND');
  return value as unknown as CommandRequest;
}
export function parseExpected(bytes: Uint8Array): ExpectedVersions {
  const value = parse(bytes);
  keys(value, ['schemaVersion', 'entities']);
  if (value.schemaVersion !== 1 || !Array.isArray(value.entities)) bad();
  const seen = new Set<string>();
  for (const entity of value.entities as unknown[]) {
    keys(entity, ['entityType', 'entityId', 'version']);
    if (entity.entityType !== 'document' || !isId(entity.entityId) || !isSeq(entity.version) || seen.has(entity.entityId)) bad();
    seen.add(entity.entityId as string);
  }
  return value as unknown as ExpectedVersions;
}
function scalarOrder(a: string, b: string): number {
  const aa = Array.from(a, ch => ch.codePointAt(0)!); const bb = Array.from(b, ch => ch.codePointAt(0)!);
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) if (aa[i] !== bb[i]) return aa[i] - bb[i];
  return aa.length - bb.length;
}
export function canonical(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') { if (!Number.isFinite(value)) return bad(); return JSON.stringify(value); }
  if (typeof value === 'string') {
    let text = '"';
    for (const ch of value) {
      const cp = ch.codePointAt(0)!;
      if (cp >= 0xd800 && cp <= 0xdfff) return bad();
      text += cp < 32 ? `\\u${cp.toString(16).padStart(4, '0')}` : ch === '"' || ch === '\\' ? `\\${ch}` : ch;
    }
    return text + '"';
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value !== 'object' || !value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return bad();
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort(scalarOrder).map(key => `${canonical(key)}:${canonical(object[key])}`).join(',')}}`;
}
export const hashBytes = (bytes: Uint8Array | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
