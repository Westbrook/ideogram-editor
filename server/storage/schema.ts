import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonical } from './canonical.js';
import { privateFile, syncDirectory, assertPrivate, inspectTree } from './files.js';
import { StoreError } from './errors.js';

const tables = ['meta', 'objects', 'commands', 'events', 'documents', 'history', 'checkpoints', 'roots'];
function digest(db: DatabaseSync, table: string): { hash: string; count: string } {
  const h = createHash('sha256'); let n = 0n;
  for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).iterate()) { h.update(canonical(row) + '\n'); n++; }
  return { hash: h.digest('hex'), count: String(n) };
}
// Additive migration: the v1 events table and its immutable triggers remain as
// rollback evidence. The active v2 log is a validated copy, activated by the
// schema-version transaction. No prior row, byte identity or root is removed.
export function extendSchema(db: DatabaseSync, root: string, oldVersion: number, quotaBytes?: string): void {
  if (oldVersion >= 2) return;
  let backup: string | null = null; let manifest: Record<string, unknown> = {};
  if (oldVersion === 1) {
    const stats = statfsSync(root,{bigint:true});
    const size = BigInt(Number(db.prepare('PRAGMA page_count').get()!.page_count) * Number(db.prepare('PRAGMA page_size').get()!.page_size));
    if (stats.bavail * stats.bsize < size + (size + 3n)/4n + 1073741824n + 67108864n ||
        (stats.blocks-stats.bavail)*10n >= stats.blocks*9n ||
        (quotaBytes && (inspectTree(root) + size + (size+3n)/4n + 67108864n > BigInt(quotaBytes) || inspectTree(root)*10n >= BigInt(quotaBytes)*9n))) throw new StoreError('CAPACITY');
    backup = `schema1-backup-${randomUUID()}.sqlite`;
    const path = join(root, backup);
    // VACUUM INTO accepts an empty destination. Precreate it privately; a worker
    // must not depend on or change the process-wide umask.
    closeSync(privateFile(path));
    db.prepare('VACUUM INTO ?').run(path); assertPrivate(path, false);
    const saved = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    try {
      if (saved.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok') throw new StoreError('CORRUPT_STORE');
      for (const table of tables) {
        const before = digest(db, table);
        if (canonical(before) !== canonical(digest(saved, table))) throw new StoreError('CORRUPT_STORE');
        manifest[table] = before;
      }
    } finally { saved.close(); }
    const fd = privateFile(path); try { fsyncSync(fd); } finally { closeSync(fd); } syncDirectory(root);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE events_v2 (seq TEXT PRIMARY KEY, transaction_id TEXT NOT NULL,
      command_id TEXT NOT NULL REFERENCES commands(id) DEFERRABLE INITIALLY DEFERRED, json TEXT NOT NULL) STRICT;
      CREATE INDEX events_v2_transaction ON events_v2(transaction_id);
      CREATE INDEX events_v2_order ON events_v2(length(seq),seq);
      INSERT INTO events_v2 SELECT * FROM events;
      CREATE TRIGGER events_v2_immutable_update BEFORE UPDATE ON events_v2 BEGIN SELECT RAISE(ABORT,'immutable'); END;
      CREATE TRIGGER events_v2_immutable_delete BEFORE DELETE ON events_v2 BEGIN SELECT RAISE(ABORT,'immutable'); END;
      CREATE TABLE snapshots (id TEXT PRIMARY KEY, seq TEXT NOT NULL, descriptor TEXT NOT NULL, projection_hash TEXT NOT NULL, roots_hash TEXT NOT NULL) STRICT;
      CREATE TABLE snapshot_roots (snapshot_id TEXT NOT NULL REFERENCES snapshots(id), owner TEXT NOT NULL, hash TEXT NOT NULL REFERENCES objects(hash), media_type TEXT NOT NULL, PRIMARY KEY(snapshot_id,owner,hash)) STRICT;
      CREATE TABLE client_bindings (cookie_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, expires TEXT NOT NULL) STRICT;
      CREATE TABLE read_releases (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, epoch TEXT NOT NULL) STRICT;
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, receipt TEXT NOT NULL) STRICT;`);
    if (canonical(digest(db, 'events')) !== canonical(digest(db, 'events_v2'))) throw new StoreError('CORRUPT_STORE');
    db.prepare('INSERT INTO schema_migrations VALUES (2,?)').run(canonical({ from: oldVersion, to: 2,
      strategy: 'additive-copy-validate-transactional-activation', code: 'lp1-storage-v2', backup, manifest }));
    db.exec('PRAGMA user_version=2'); db.exec('COMMIT'); syncDirectory(root);
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}

export function assetSchema(db: DatabaseSync, root: string, quotaBytes?: string, fresh = false) {
  if (Number(db.prepare('PRAGMA user_version').get()!.user_version) === 3) return;
  const tables = ['meta','objects','commands','events','events_v2','documents','history','checkpoints','roots','snapshots','snapshot_roots','client_bindings','read_releases','schema_migrations'];
  const size = BigInt(Number(db.prepare('PRAGMA page_count').get()!.page_count) * Number(db.prepare('PRAGMA page_size').get()!.page_size));
  const stats = statfsSync(root,{bigint:true}); const required=size+(size+3n)/4n+1073741824n+67108864n;
  if(!fresh&&(stats.bavail*stats.bsize<required||(stats.blocks-stats.bavail)*10n>=stats.blocks*9n||
    (quotaBytes && inspectTree(root)+required>BigInt(quotaBytes)))) throw new StoreError('CAPACITY');
  const backup=fresh?null:`schema2-backup-${randomUUID()}.sqlite`;const manifest: Record<string,unknown>={};
  if(backup){const path=join(root,backup);closeSync(privateFile(path));
  db.prepare('VACUUM INTO ?').run(path);assertPrivate(path,false);
  const saved=new DatabaseSync(path,{readOnly:true,allowExtension:false});
  try {
    if(saved.prepare('PRAGMA integrity_check').get()!.integrity_check!=='ok')throw new StoreError('CORRUPT_STORE');
    for(const table of tables){const before=digest(db,table);if(canonical(before)!==canonical(digest(saved,table)))throw new StoreError('CORRUPT_STORE');manifest[table]=before;}
  } finally {saved.close();}
  const fd=privateFile(path);try{fsyncSync(fd);}finally{closeSync(fd);}syncDirectory(root);}
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE staged_assets (id TEXT PRIMARY KEY, json TEXT NOT NULL, created_at TEXT NOT NULL, filename TEXT NOT NULL UNIQUE) STRICT;
      CREATE INDEX staged_recoverable ON staged_assets(id) WHERE json_extract(json,'$.state')!='finalized';
      CREATE TABLE transfer_reviews (id TEXT PRIMARY KEY, json TEXT NOT NULL, session_hash TEXT NOT NULL, epoch TEXT NOT NULL) STRICT;
      CREATE TABLE asset_preparations (id TEXT PRIMARY KEY, hash TEXT NOT NULL, original TEXT NOT NULL, canonical TEXT NOT NULL,
        operation_id TEXT NOT NULL UNIQUE, staging_id TEXT NOT NULL UNIQUE, staging_version TEXT NOT NULL, phase TEXT NOT NULL) STRICT;
      CREATE TABLE assets (id TEXT PRIMARY KEY, json TEXT NOT NULL) STRICT;
      CREATE TABLE asset_dependencies (asset_id TEXT NOT NULL REFERENCES assets(id), hash TEXT NOT NULL REFERENCES objects(hash), PRIMARY KEY(asset_id,hash)) STRICT;`);
    db.prepare('INSERT INTO schema_migrations VALUES (3,?)').run(canonical({from:2,to:3,strategy:'additive-verified-backup-transactional-activation',backup,manifest}));
    db.exec('PRAGMA user_version=3; COMMIT');syncDirectory(root);
  } catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}
}
