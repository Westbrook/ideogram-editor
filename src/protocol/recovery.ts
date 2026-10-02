import type { BlobRef, DomainEvent, Receipt } from './store.js';
import type { LocalError, LocalErrorDetail } from './session.js';
export type ProtocolContentRef = { contentId: string; url: string; blob: BlobRef;
  encoding: 'lp1-json' | 'lp1-events-jsonl' | 'lp1-snapshot-jsonl' | 'lp1-namespace-jsonl'; recordCount: string; expiresAt: string };
export type WireValue<T> = { kind: 'inline'; value: T } | { kind: 'content-ref'; content: ProtocolContentRef };
export type RecoveryContext = { recoveryId: string; writerEpoch: string; projectionSchema: number; highWater: string; expiresAt: string };
export type SnapshotDescriptor = { protocolVersion: 1; snapshotId: string; metadataUrl: string; snapshotSeq: string; recovery: RecoveryContext; content: ProtocolContentRef };
export type CursorGap = { kind: 'cursor-gap'; requestedAfter: string; earliestAvailable: string; snapshot: SnapshotDescriptor };
export type EventBatch = { kind: 'inline'; transactionId: string; fromSeq: string; toSeq: string; events: DomainEvent[] };
export type TransactionReference = { kind: 'transaction-ref'; transactionId: string; fromSeq: string; toSeq: string; eventCount: string; recovery: RecoveryContext; content: ProtocolContentRef };
export type EventPage = { protocolVersion: 1; kind: 'batches'; recovery: RecoveryContext; nextCursor: string; more: boolean; batches: (EventBatch | TransactionReference)[] };
export type StreamEnvelope =
  | { protocolVersion: 1; kind: 'batch-part'; projectionSchema?: number; transactionId: string; fromSeq: string; toSeq: string; partIndex: number; partCount: number; events: DomainEvent[] }
  | { protocolVersion: 1; kind: 'transaction-ref'; reference: TransactionReference }
  | { protocolVersion: 1; kind: 'checkpoint'; highWater: string }
  | { protocolVersion: 1; kind: 'gap'; detail: CursorGap }
  | { protocolVersion: 1; kind: 'error'; error: LocalError };
export type SnapshotWireRecord =
  | { kind: 'header'; snapshotId: string; snapshotSeq: string; projectionSchema: number; entityCount: string }
  | { kind: 'projection-part'; entityType: string; entityId: string; entityVersion: string; partIndex: number; partCount: number; utf8Base64: string };
export type ProjectionResponse<T> = { protocolVersion: 1; entityVersion: string; projectionSchema: number; highWater: string; projection: WireValue<T> };
export type CommandResult =
  | { protocolVersion: 1; kind: 'receipt'; receipt: Receipt; rejectionDetails?: WireValue<LocalErrorDetail> }
  | { protocolVersion: 1; kind: 'pending'; commandId: string; operationId: string; phase: 'preparing' | 'waiting-for-resources'; receiptUrl: string }
  | { protocolVersion: 1; kind: 'unknown'; commandId: string };

export type PendingInventory = { protocolVersion:1; kind:'pending-inventory'; semantics:'pending-at-page-read'; writerEpoch:string; next:string|null;
  items:{commandId:string;commandHash:string;operationId:string;phase:'preparing'|'waiting-for-resources';label:string}[] };
