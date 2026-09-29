/** Server-only EF-1 / TP-1 boundaries. No browser routes or submission queue. */
export const IO_CHUNK = 1024 * 1024;
export const CONNECT_DEADLINE_MS = 10_000;
export const READ_DEADLINE_MS = 30_000;
export type FailureCode = 'POLICY' | 'IDENTITY' | 'ADDRESS' | 'PEER' | 'TLS' | 'REDIRECT' |
  'CONNECT_TIMEOUT' | 'READ_TIMEOUT' | 'INTERRUPTED' | 'LENGTH' | 'HASH' | 'CAPACITY' | 'ABORTED' | 'PROVENANCE';
export class ProviderError extends Error {
  constructor(readonly code: FailureCode) { super(code); this.name = 'ProviderError'; }
}
export function refuse(code: FailureCode): never { throw new ProviderError(code); }
export type AppliedPrivacyPolicy = Readonly<{
  profileId: string; profileVersion: number; evidenceDigest: string;
  requestedStoreIO: '0'; requestedAccess: 'most-private-compatible';
  appliedLifecycleSeconds: number | null; appliedACL: string | null;
  enforcement: 'documented' | 'observed' | 'unknown'; fallbackAcknowledgementId: string | null;
}>;
export type QueueIdentity = Readonly<{ endpoint: string; requestId?: string }>;
export type QueueAction = 'submit' | 'status' | 'result' | 'cancel';
export type ProtectedBody = Readonly<{
  class: 'backend-transport'; recordId: string; attemptId: string; direction: 'request' | 'response';
  sha256: string; receivedBytes: string; completeness: 'complete' | 'partial';
  access: 'backend-only'; export: 'never';
}>;
/** Owner adapts R31 reservations, including purpose, occupancy margin and writer fencing. */
export interface TransferReservation {
  readonly purpose: 'provider-request' | 'provider-response' | 'provider-media' | 'provider-provenance';
  ensure(totalBytes: bigint): void;
  committed(totalBytes: bigint): void;
  release(): void;
}
export type TransferIdentity = Readonly<{ urlHash:string; etag:string; totalBytes:string }>;
export interface TransferSink {
  readonly owner: Readonly<{attemptId:string;direction:'request'|'response'}>;
  readonly bytes: bigint;
  readonly identity: TransferIdentity | null;
  bindIdentity(identity: TransferIdentity): void;
  recordHeaders(headers:Record<string,unknown>):void;
  bindPolicy(policy:AppliedPrivacyPolicy):void;
  prepare(totalBytes: bigint): void;
  append(bytes: Uint8Array): void;
  digest(): string;
  finish(complete: boolean, observedBytes?: bigint): ProtectedBody;
}
export type TransferReceipt = Readonly<{
  outcome: 'complete' | 'interrupted'; failure: FailureCode | null;
  status: number | null; receivedBytes: string; storedBytes: string;
  etag: string | null; declaredBytes: string | null; sha256: string;
  evidence: ProtectedBody; providerCancelled: false;
}>;
export interface CredentialProvider { queueKey(): string; }
