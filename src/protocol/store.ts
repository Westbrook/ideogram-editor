import type {QueueBody,QueueFact} from './queue.js';
import type { PortableBody, PortableFact } from './portable.js';
// Foundation commands only. The HTTP/session adapter owns authentication; these
// identities are immutable provenance, never credentials or authority.
import type { AssetBody, AssetFact } from './assets.js';
import type { HistoryBody, HistoryFact, ImageVersion } from './history.js';
import type { RasterBody } from './raster.js';
export type Seq = string;
export type BlobRef = { hash: string; byteLength: string; mediaType: string };
export type FoundationBody =
  | { type: 'NewDocument'; width: number; height: number; color: string; depth: number }
  | { type: 'SaveCheckpoint'; name: string };
export type Command = {
  schemaVersion: 1; commandId: string; clientId: string; sessionId: string;
  correlationId: string; causationId: string | null; transactionId: string;
  documentId: string | null; expectedDocumentRevision: Seq | null;
  expectedEntityVersions: BlobRef; issuedAt: string; body: FoundationBody | AssetBody | RasterBody | HistoryBody | PortableBody | QueueBody;
};
export type CommandRequest = { protocolVersion: 1; command: Command };
export type RejectionCode = 'STALE_REVISION' | 'INVALID_INPUT' | 'MISSING_ASSET' | 'CAPACITY' | 'INCOMPATIBLE';
export type Receipt =
  | { status: 'accepted'; commandId: string; fromSeq: Seq; toSeq: Seq; documentRevision: Seq | null; transactionId: string }
  | { status: 'rejected'; commandId: string; code: RejectionCode; currentRevision: Seq | null; details: BlobRef };
export type Document = {
  id: string; revision: Seq; branchId: string; width: number; height: number;
  color: 'sRGB'; depth: 8; orderedLayerIds: readonly string[]; historyHead: string;
  checkpoint: string | null; compositionVersion: string | null;
  image?: ImageVersion; redo?: string | null;
};
export type HistoryNode = {
  id: string; documentId: string; branchId: string; parent: string | null;
  forward: { before: null; after: Document }; inverse: { before: Document; after: null };
  roots: readonly BlobRef[];
};
export type Checkpoint = {
  id: string; name: string; documentId: string; documentRevision: Seq;
  historyHead: string; highWater: Seq;
  image?: ImageVersion;
};
export type DomainEvent = {
  schemaVersion: 1; payloadVersion: 1; eventId: string; workspaceSeq: Seq;
  streamId: string; streamSeq: Seq; documentId: string | null;
  resultingDocumentRevision: Seq | null; commandId: string; correlationId: string;
  causationId: string | null; transactionId: string; writerEpoch: Seq; recordedAt: string;
} & (
  | { type: 'DocumentCreated'; payload: { document: Document; history: HistoryNode } }
  | { type: 'CheckpointSaved'; payload: { checkpoint: Checkpoint } }
  | QueueFact
  | PortableFact
  | HistoryFact
  | AssetFact
);
export type ExpectedVersions = {
  schemaVersion: 1;
  entities: readonly { entityType: 'document' | 'layer'; entityId: string; version: Seq }[];
};

// Fixed typed empty precondition manifest provisioned by the HTTP service.
export const EMPTY_EXPECTED_VERSIONS: BlobRef = Object.freeze({ hash: "sha256:10584db4c85cf1d5cbd2eda3429934a693b7c26268e63be96dbdb23d6dd42069", byteLength: "33", mediaType: "application/json" });
