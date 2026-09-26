import type { Document, DomainEvent } from '../protocol/store.js';

// This module deliberately has no runtime imports or effects. Replay and live
// acceptance apply exactly the same facts, with captured IDs and time.
export function reduceDocument(previous: Document | null, event: DomainEvent): Document {
  if (event.schemaVersion !== 1 || event.payloadVersion !== 1) throw new Error('Unsupported event schema');
  if(event.type==='BundleImported'){if(previous!==null)throw new Error('Namespace collision');return event.payload.document;}
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
  if(event.type==='ImageEdited'||event.type==='HistoryNavigated'){
    const next=event.payload.document;
    if(!previous||previous.id!==event.documentId||next.id!==previous.id||next.revision!==String(BigInt(previous.revision)+1n)||next.revision!==event.resultingDocumentRevision||next.checkpoint!==previous.checkpoint)throw new Error('Invalid image transition');
    if(event.type==='ImageEdited'&&(event.payload.history.parent!==previous.historyHead||event.payload.history.id!==next.historyHead||event.payload.history.documentId!==next.id))throw new Error('Invalid history parent');
    if(event.type==='HistoryNavigated'&&event.payload.previousHead!==previous.historyHead)throw new Error('Invalid history navigation');
    return next;
  }
  throw new Error('Unsupported event type');
}
