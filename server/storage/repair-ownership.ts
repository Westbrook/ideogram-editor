import type { DatabaseSync } from 'node:sqlite';
import type { Asset } from '../../src/protocol/assets.js';
import type { BlobRef } from '../../src/protocol/store.js';
import { canonical, hashBytes } from './canonical.js';
import { StoreError } from './errors.js';

// SQL checks length before SQLite materializes a retained string. The caller's
// shared request loan covers parsed rows and canonical comparison scratch; no
// unbounded .all() result escapes the one-row ownership walk.
const JSON_BYTES = 262144;
const bounded = (column: string, bytes = JSON_BYTES) => `CASE WHEN length(CAST(${column} AS BLOB))<=${bytes} THEN ${column} ELSE NULL END`;
const text = (value: unknown): string => { if (value === null) throw new StoreError('CAPACITY'); return String(value); };

/** A hash shared by a different retained asset is not authority to resurrect an
 * unowned asset. Every admitted owner has a typed edge to this exact asset. */
export function repairOwnership(db: DatabaseSync, asset: Asset, ref: BlobRef): { owner: string; binding: string } {
  const root = (owner: string) => db.prepare('SELECT 1 FROM roots WHERE owner=? AND hash=? AND media_type=?').get(owner, ref.hash, ref.mediaType);
  const bind = (owner: string, evidence: unknown) => ({ owner, binding: hashBytes(canonical({ owner, assetId: asset.id, ref, evidence })) });
  const own = 'asset:' + asset.id;
  if (root(own)) return bind(own, { kind: 'independent-asset-root' });
  const document = (id: string) => {
    const row = db.prepare(`SELECT ${bounded('json')} AS json FROM documents WHERE id=? AND NOT EXISTS(SELECT 1 FROM candidate_document_tombstones WHERE document_id=?)`).get(id, id);
    return row ? text(row.json) : null;
  };
  let checked = 0;
  for (const row of db.prepare(`SELECT ${bounded('owner', 1024)} AS owner FROM roots WHERE hash=? AND media_type=? ORDER BY owner`).iterate(ref.hash, ref.mediaType)) {
    if (++checked > 128) throw new StoreError('CAPACITY');
    const owner = text(row.owner);
    if (owner.startsWith('history-command:')) {
      const id = owner.slice('history-command:'.length), command = db.prepare(`SELECT ${bounded('canonical')} AS canonical FROM commands WHERE id=? AND json_extract(receipt,'$.status')='accepted'`).get(id);
      if (!command) continue;
      const c = JSON.parse(text(command.canonical)).command, doc = typeof c.documentId === 'string' ? document(c.documentId) : null;
      if (!doc) continue;
      const registered = db.prepare(`SELECT ${bounded('json')} AS json FROM events_v2 WHERE command_id=? AND json_extract(json,'$.type')='AssetRegistered' AND json_extract(json,'$.payload.asset.id')=? LIMIT 1`).get(id, asset.id);
      if (registered && canonical(JSON.parse(text(registered.json)).payload.asset) === canonical(asset)) return bind(owner, { kind: 'registered-document-asset', command: text(command.canonical), event: text(registered.json), document: doc });
      if (c.body.type === 'ImportAsset' && c.body.assetId === asset.id) return bind(owner, { kind: 'accepted-import-edge', command: text(command.canonical), document: doc });
    } else if (owner.startsWith('request-mask:')) {
      const parts = owner.split(':');
      if (parts.length === 3 && parts[2] === asset.id) { const doc = document(parts[1]); if (doc) return bind(owner, { kind: 'document-request-mask', document: doc }); }
    } else if (owner.startsWith('candidate:') || owner === 'candidate-prepared:' + asset.id) {
      const rows = owner.startsWith('candidate:')
        ? db.prepare(`SELECT ${bounded('json')} AS json,document_id FROM candidates WHERE id=?`).iterate(owner.slice('candidate:'.length))
        : db.prepare(`SELECT ${bounded('json')} AS json,document_id FROM candidates WHERE json_extract(json,'$.preparedAssetId')=? ORDER BY id LIMIT 129`).iterate(asset.id);
      let candidates = 0;
      for (const candidate of rows) {
        if (++candidates > 128) throw new StoreError('CAPACITY');
        const value = JSON.parse(text(candidate.json)), doc = document(String(candidate.document_id));
        if (doc && value.safety === 'safe' && (owner.startsWith('candidate:') ? value.encodedAssetId === asset.id : value.preparedAssetId === asset.id)) return bind(owner, { kind: 'live-candidate-asset', candidate: text(candidate.json), document: doc });
      }
    } else if (owner.startsWith('namespace:')) {
      const id = owner.slice('namespace:'.length), namespace = db.prepare(`SELECT document_id,${bounded('source')} AS source FROM portable_namespaces WHERE id=?`).get(id);
      if (!namespace) continue;
      const doc = document(String(namespace.document_id)), entry = db.prepare(`SELECT ${bounded('json', 65536)} AS json FROM portable_rows WHERE namespace=? AND kind='asset' AND id=?`).get(id, asset.id);
      if (doc && entry && canonical(JSON.parse(text(entry.json))) === canonical(asset)) return bind(owner, { kind: 'imported-namespace-asset', namespace: text(namespace.source), asset: text(entry.json), document: doc });
    } else if (owner.startsWith('ui:')) {
      const parts = owner.split(':'); if (parts.length !== 5) continue;
      const ui = db.prepare(`SELECT ${bounded('json', 65536)} AS json FROM ui_checkpoints WHERE client_id=? AND session_id=?`).get(parts[1], parts[2]);
      if (!ui) continue;
      const draft = JSON.parse(text(ui.json)).drafts.find((d: { id: string; generation: string; assetId: string }) => d.id === parts[3] && d.generation === parts[4] && d.assetId === asset.id);
      if (draft && (draft.documentId === null || document(draft.documentId))) return bind(owner, { kind: 'live-ui-draft', draft });
    }
  }
  throw new StoreError('NOT_FOUND');
}
