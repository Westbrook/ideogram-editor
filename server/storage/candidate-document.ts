import type { BlobRef, Document, HistoryNode } from '../../src/protocol/store.js';
import type { ImageEditPreview, ImageState } from '../../src/protocol/history.js';
import { document as validateDocument } from '../../src/protocol/validate.js';

/** A separately reviewed candidate starts an independent document history. */
export function candidateDocument(
  preview: ImageEditPreview,
  state: ImageState,
  newDocumentId: string,
  historyId: string,
  branchId: string,
  lineage?: BlobRef,
): { document: Document; history: HistoryNode } {
  const document: Document = {
    id: newDocumentId,
    revision: '1',
    branchId,
    width: state.width,
    height: state.height,
    color: 'sRGB',
    depth: 8,
    orderedLayerIds: state.layers.map(layer => layer.id),
    historyHead: historyId,
    checkpoint: null,
    compositionVersion: state.composition?.id ?? null,
    image: structuredClone(preview.after),
    redo: null,
  };
  validateDocument(document);
  return {
    document,
    history: {
      id: historyId,
      documentId: newDocumentId,
      branchId,
      parent: null,
      forward: { before: null, after: structuredClone(document) },
      inverse: { before: structuredClone(document), after: null },
      roots: [structuredClone(preview.after.state), structuredClone(preview.plan), ...(lineage ? [structuredClone(lineage)] : [])],
    },
  };
}

/** Used only inside the creation builder; revision zero is never published. */
export function candidateDocumentSeed(document: Document): Document {
  const { image, redo, ...seed } = document;
  return { ...seed, revision: '0', orderedLayerIds: [], checkpoint: null, compositionVersion: null };
}
