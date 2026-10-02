import type { BlobRef } from './store.js';

export type StorageRepairCondition = 'missing' | 'corrupt' | 'available';
/** Physical repair is a session-fenced operation, not a document/history event. */
export type StorageRepairReview = {
  protocolVersion: 1; reviewId: string; reviewHash: string;
  assetId: string; assetVersion: string; ref: BlobRef; owner: string;
  condition: StorageRepairCondition; targetIdentity: string;
  staging: { purpose: 'text'; mediaType: 'application/octet-stream' };
  expiresAt: string;
};
export type StorageRepairRequest = {
  protocolVersion: 1; operationId: string; reviewId: string; reviewHash: string;
  stagingId: string; expectedStagingVersion: string;
};
export type StorageRepairResult = {
  protocolVersion: 1; operationId: string; status: 'restored' | 'already-available';
  assetId: string; assetVersion: string; ref: BlobRef; previousCondition: StorageRepairCondition;
};
const fail = (): never => { throw new Error('INVALID_STORAGE_REPAIR'); };
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const seq = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v);
const condition = (v: unknown): v is StorageRepairCondition => v === 'missing' || v === 'corrupt' || v === 'available';
function fields(v: unknown, names: readonly string[]): asserts v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== names.length || names.some(k => !Object.hasOwn(v, k))) fail();
}
function blob(v: unknown): asserts v is BlobRef {
  fields(v, ['hash', 'byteLength', 'mediaType']);
  if (!hash(v.hash) || !seq(v.byteLength) || typeof v.mediaType !== 'string' || v.mediaType.length > 128 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(v.mediaType)) fail();
}
export function storageRepairRequest(v: unknown): asserts v is StorageRepairRequest {
  fields(v, ['protocolVersion', 'operationId', 'reviewId', 'reviewHash', 'stagingId', 'expectedStagingVersion']);
  if (v.protocolVersion !== 1 || !id(v.operationId) || !id(v.reviewId) || !hash(v.reviewHash) || !id(v.stagingId) || !seq(v.expectedStagingVersion)) fail();
}
export function storageRepairResult(v: unknown): asserts v is StorageRepairResult {
  fields(v, ['protocolVersion', 'operationId', 'status', 'assetId', 'assetVersion', 'ref', 'previousCondition']);
  if (v.protocolVersion !== 1 || !id(v.operationId) || !id(v.assetId) || !seq(v.assetVersion) || !condition(v.previousCondition) || !['restored', 'already-available'].includes(String(v.status))) fail();
  if ((v.status === 'already-available') !== (v.previousCondition === 'available')) fail();
  blob(v.ref);
}
export function storageRepairReview(v: unknown): asserts v is StorageRepairReview {
  fields(v, ['protocolVersion', 'reviewId', 'reviewHash', 'assetId', 'assetVersion', 'ref', 'owner', 'condition', 'targetIdentity', 'staging', 'expiresAt']);
  if (v.protocolVersion !== 1 || !id(v.reviewId) || !hash(v.reviewHash) || !id(v.assetId) || !seq(v.assetVersion) || typeof v.owner !== 'string' || v.owner.length < 1 || v.owner.length > 1024 || /[\u0000-\u001f\u007f]/.test(v.owner) || !condition(v.condition) || !hash(v.targetIdentity)) fail();
  blob(v.ref); fields(v.staging, ['purpose', 'mediaType']);
  if (v.staging.purpose !== 'text' || v.staging.mediaType !== 'application/octet-stream') fail();
  if (typeof v.expiresAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v.expiresAt) || !Number.isFinite(Date.parse(v.expiresAt)) || new Date(v.expiresAt).toISOString() !== v.expiresAt) fail();
}
