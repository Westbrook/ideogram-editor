import type { DraftFence } from './history.js';
export type Preferences = {
  documentId: string | null; tool: 'select' | 'transform' | 'crop' | 'mask' | 'text';
  viewport: { x: number; y: number; zoom: number };
  panels: { left: number; right: number; active: 'layers' | 'history' | 'assets' };
  selectedLayerIds: string[];
};
export type Draft = {
  id: string; generation: string; kind: 'prompt' | 'inspector'; documentId: string;
  targetLayerId: string | null; expectedDocumentRevision: string; assetId: string;
  composing: boolean; status: 'saved-unapplied' | 'applied';
};
export type UICheckpoint = { sessionId: string; uiSeq: string; preferences: Preferences; drafts: Draft[]; reconciledLayerIds: string[] };
export type UIRequest = {
  protocolVersion: 1; requestId: string; sessionId: string; expectedUISeq: string;
  body: { type: 'SetPreferences'; preferences: Preferences }
    | { type: 'SaveDraft'; draft: Omit<Draft,'status'> }
    | { type: 'ClearDraft'; draftId: string; generation: string }
    | { type: 'FocusRequested'; target: 'canvas' | 'inspector' | 'history'; generation: string };
};
export type UIReceipt = { protocolVersion: 1; requestId: string; status: 'accepted' | 'rejected'; uiSeq: string; reason: string | null };
export type DocumentSaveStatus = { pendingCommandCount: number; draftDirty: boolean; documentChangedSinceCheckpoint: boolean; bundleOutdated: boolean };
export type { DraftFence };
