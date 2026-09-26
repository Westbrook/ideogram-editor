import type { Document, DomainEvent } from '../protocol/store.js';

// This module deliberately has no runtime imports or effects. Replay and live
// acceptance apply exactly the same facts, with captured IDs and time.
export function reduceDocument(previous: Document | null, event: DomainEvent): Document {
  if (event.schemaVersion !== 1 || event.payloadVersion !== 1) throw new Error('Unsupported event schema');
  if (event.type === 'DocumentCreated') {
    if (previous !== null || event.resultingDocumentRevision !== '1' || event.payload.document.id !== event.documentId) throw new Error('Invalid creation');
    return event.payload.document;
  }
  if (event.type === 'CheckpointSaved') {
    if (!previous || previous.id !== event.documentId ||
        event.resultingDocumentRevision !== String(BigInt(previous.revision) + 1n) ||
        event.payload.checkpoint.documentRevision !== previous.revision ||
        event.payload.checkpoint.historyHead !== previous.historyHead) throw new Error('Invalid checkpoint');
    return { ...previous, revision: event.resultingDocumentRevision, checkpoint: event.payload.checkpoint.id };
  }
  throw new Error('Unsupported event type');
}
