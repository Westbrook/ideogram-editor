import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, statfsSync, openSync, readSync, writeFileSync, constants, fstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonical, hashBytes, isId, parseCommand } from './canonical.js';
import { privateFile, syncDirectory, assertPrivate, inspectTree, sameFile } from './files.js';
import { StoreError } from './errors.js';
import type { Barrier } from './objects.js';

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
  if (Number(db.prepare('PRAGMA user_version').get()!.user_version) >= 3) return;
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

export function rasterSchema(db: DatabaseSync, root: string, quotaBytes?: string, fresh = false) {
  if(Number(db.prepare('PRAGMA user_version').get()!.user_version)>=4)return;
  const tables=['meta','objects','commands','events','events_v2','documents','history','checkpoints','roots','snapshots','snapshot_roots','client_bindings','read_releases','schema_migrations','staged_assets','transfer_reviews','asset_preparations','assets','asset_dependencies'];
  const size=BigInt(Number(db.prepare('PRAGMA page_count').get()!.page_count)*Number(db.prepare('PRAGMA page_size').get()!.page_size));
  const fs=statfsSync(root,{bigint:true}),required=size+(size+3n)/4n+1073741824n+67108864n;
  if(!fresh&&(fs.bavail*fs.bsize<required||(fs.blocks-fs.bavail)*10n>=fs.blocks*9n||(quotaBytes&&inspectTree(root)+required>BigInt(quotaBytes))))throw new StoreError('CAPACITY');
  const backup=fresh?null:`schema3-backup-${randomUUID()}.sqlite`,manifest:Record<string,unknown>={};
  if(backup){const path=join(root,backup);closeSync(privateFile(path));db.prepare('VACUUM INTO ?').run(path);assertPrivate(path,false);
    const saved=new DatabaseSync(path,{readOnly:true,allowExtension:false});try{if(saved.prepare('PRAGMA integrity_check').get()!.integrity_check!=='ok')throw new StoreError('CORRUPT_STORE');
      for(const table of tables){const before=digest(db,table);if(canonical(before)!==canonical(digest(saved,table)))throw new StoreError('CORRUPT_STORE');manifest[table]=before;}
    }finally{saved.close();}const fd=privateFile(path);try{fsyncSync(fd);}finally{closeSync(fd);}syncDirectory(root);
  }
  db.exec('BEGIN IMMEDIATE');try{
    db.exec(`CREATE TABLE raster_preparations (id TEXT PRIMARY KEY, hash TEXT NOT NULL, original TEXT NOT NULL, canonical TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE, phase TEXT NOT NULL) STRICT;
      CREATE TABLE raster_reviews (id TEXT PRIMARY KEY, json TEXT NOT NULL, session_hash TEXT NOT NULL, epoch TEXT NOT NULL) STRICT;`);
    db.prepare('INSERT INTO schema_migrations VALUES (4,?)').run(canonical({from:3,to:4,strategy:'additive-verified-backup-transactional-activation',backup,manifest}));
    db.exec('PRAGMA user_version=4; COMMIT');syncDirectory(root);
  }catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}
}

// Schema 5 changes persisted preparation semantics, not table layout. Schema-4
// writers must refuse this root before replay, scheduling or incrementing epoch.
// A 7388d1e schema-4 root may already contain pending approvals: preserve those
// bytes, but never claim that its rollback copy is usable by dfa383d.
export function approvalSchema(db: DatabaseSync, root: string, barrier: Barrier, quotaBytes?: string, fresh = false) {
  const capability = 'raster-pending-approval-v1';
  if (Number(db.prepare('PRAGMA user_version').get()!.user_version) >= 5) {
    const row = db.prepare('SELECT receipt FROM schema_migrations WHERE version=5').get();
    if (!row || JSON.parse(String(row.receipt)).capability !== capability) throw new StoreError('CORRUPT_STORE');
    return;
  }
  const tables = ['meta','objects','commands','events','events_v2','documents','history','checkpoints','roots',
    'snapshots','snapshot_roots','client_bindings','read_releases','schema_migrations','staged_assets','transfer_reviews',
    'asset_preparations','assets','asset_dependencies','raster_preparations','raster_reviews'];
  let approvals = 0;
  for (const row of db.prepare('SELECT * FROM raster_preparations').iterate()) {
    try {
      const request = parseCommand(Buffer.from(String(row.original)));
      if (request.command.commandId !== row.id || canonical(request) !== row.canonical ||
          hashBytes(String(row.canonical)) !== row.hash || !isId(row.operation_id) ||
          !['preparing','waiting-for-resources'].includes(String(row.phase)) ||
          !['PrepareRaster','ApproveRaster','ComposeRaster','ExportRaster'].includes(request.command.body.type)) throw new Error();
      if (request.command.body.type === 'ApproveRaster') approvals++;
    } catch { throw new StoreError('CORRUPT_STORE'); }
  }
  const compatibleExecutable = approvals ? '7388d1e625a6ac2c563bc64cca6318d264649acc' : 'dfa383d56d21bc9c7bb40248db8a503fe33e6e46';
  const backup = fresh ? null : `schema4-backup-${randomUUID()}.sqlite`;
  const manifest: Record<string, unknown> = {};
  let backupHash: string | null = null;
  let manifestFile: string | null = null;
  const fileProof = (path: string) => {
    const identity = assertPrivate(path, false), input = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const hash = createHash('sha256'), block = Buffer.alloc(1048576);
    try {
      if (!sameFile(identity, fstatSync(input))) throw new StoreError('ROOT_UNSAFE');
      for (;;) { const n = readSync(input, block); if (!n) break; hash.update(block.subarray(0,n)); }
      const after = assertPrivate(path, false);
      if (!sameFile(identity, after) || identity.size !== after.size || identity.mtimeMs !== after.mtimeMs || identity.ctimeMs !== after.ctimeMs) throw new StoreError('ROOT_UNSAFE');
    } finally { closeSync(input); }
    return { path, identity, hash: `sha256:${hash.digest('hex')}` };
  };
  const proofs: ReturnType<typeof fileProof>[] = [];
  if (backup) {
    const size = BigInt(Number(db.prepare('PRAGMA page_count').get()!.page_count) * Number(db.prepare('PRAGMA page_size').get()!.page_size));
    const fs = statfsSync(root, { bigint: true }), required = size + (size+3n)/4n + 1073741824n + 67108864n;
    if (fs.bavail*fs.bsize < required || (fs.blocks-fs.bavail)*10n >= fs.blocks*9n ||
        (quotaBytes && inspectTree(root)+required > BigInt(quotaBytes))) throw new StoreError('CAPACITY');
    barrier('approval-schema-before-backup');
    const path = join(root, backup);
    closeSync(privateFile(path));
    db.prepare('VACUUM INTO ?').run(path); assertPrivate(path, false);
    barrier('approval-schema-backup-written');
    const saved = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    try {
      if (saved.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok' ||
          saved.prepare('PRAGMA user_version').get()!.user_version !== 4) throw new StoreError('CORRUPT_STORE');
      for (const table of tables) {
        const before = digest(db, table);
        if (canonical(before) !== canonical(digest(saved, table))) throw new StoreError('CORRUPT_STORE');
        manifest[table] = before;
      }
      const sql = (database: DatabaseSync) => database.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
      if (canonical(sql(db)) !== canonical(sql(saved))) throw new StoreError('CORRUPT_STORE');
      manifest.sqlite_schema = hashBytes(canonical(sql(saved)));
    } finally { saved.close(); }
    const fd = privateFile(path); try { fsyncSync(fd); } finally { closeSync(fd); }
    const proof = fileProof(path); proofs.push(proof); backupHash = proof.hash;
    manifestFile = `${backup}.manifest.json`;
    const out = privateFile(join(root, manifestFile));
    try {
      writeFileSync(out, canonical({ schemaVersion: 1, backup, backupHash, storageVersion: 4,
        compatibleExecutable, pendingApprovals: approvals, manifest,
        retainedDirectories: ['objects','staging','uploads'],
        recovery: 'Copy the backup database and retained directories into a separate owner-only root. Use only the named compatible executable. Keep this root and all prior backups unchanged.' }));
      fsyncSync(out);
    } finally { closeSync(out); }
    proofs.push(fileProof(join(root, manifestFile)));
    syncDirectory(root);
    barrier('approval-schema-backup-verified');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    // No pending request, event, projection, receipt or root is transformed.
    for (const table of tables) if (backup && canonical(manifest[table]) !== canonical(digest(db, table))) throw new StoreError('CORRUPT_STORE');
    db.prepare('INSERT INTO schema_migrations VALUES (5,?)').run(canonical({ from:4, to:5, capability,
      strategy:'semantic-version-verified-backup-transactional-activation', backup, backupHash, manifestFile, manifest,
      rollback: backup ? { compatibleExecutable, pendingApprovals: approvals } : null }));
    db.exec('PRAGMA user_version=5');
    barrier('approval-schema-before-activation');
    for (const proof of proofs) {
      const current = fileProof(proof.path);
      if (!sameFile(current.identity, proof.identity) || current.hash !== proof.hash) throw new StoreError('CORRUPT_STORE');
    }
    db.exec('COMMIT'); syncDirectory(root);
    barrier('approval-schema-after-activation');
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}

// History, preparation and UI semantics require explicit old-writer refusal.
export function historySchema(db: DatabaseSync, root: string, barrier: Barrier, quotaBytes?: string, fresh = false) {
  const capability = 'image-history-ui-v1';
  if (Number(db.prepare('PRAGMA user_version').get()!.user_version) >= 6) {
    const row = db.prepare('SELECT receipt FROM schema_migrations WHERE version=6').get();
    if (!row || JSON.parse(String(row.receipt)).capability !== capability) throw new StoreError('CORRUPT_STORE');
    return;
  }
  const tables = ['meta','objects','commands','events','events_v2','documents','history','checkpoints','roots',
    'snapshots','snapshot_roots','client_bindings','read_releases','schema_migrations','staged_assets','transfer_reviews',
    'asset_preparations','assets','asset_dependencies','raster_preparations','raster_reviews'];
  const compatibleExecutable = '92e5247ed3279f25292f8e312661bf3b12deffe7';
  const backup = fresh ? null : `schema5-backup-${randomUUID()}.sqlite`;
  const manifest: Record<string, unknown> = {};
  let backupHash: string | null = null;
  let manifestFile: string | null = null;
  const fileProof = (path: string) => {
    const identity = assertPrivate(path, false), input = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const hash = createHash('sha256'), block = Buffer.alloc(1048576);
    try {
      if (!sameFile(identity, fstatSync(input))) throw new StoreError('ROOT_UNSAFE');
      for (;;) { const n = readSync(input, block); if (!n) break; hash.update(block.subarray(0,n)); }
      const after = assertPrivate(path, false);
      if (!sameFile(identity, after) || identity.size !== after.size || identity.mtimeMs !== after.mtimeMs || identity.ctimeMs !== after.ctimeMs) throw new StoreError('ROOT_UNSAFE');
    } finally { closeSync(input); }
    return { path, identity, hash: `sha256:${hash.digest('hex')}` };
  };
  const proofs: ReturnType<typeof fileProof>[] = [];
  if (backup) {
    const size = BigInt(Number(db.prepare('PRAGMA page_count').get()!.page_count) * Number(db.prepare('PRAGMA page_size').get()!.page_size));
    const fs = statfsSync(root, { bigint: true }), required = size + (size+3n)/4n + 1073741824n + 67108864n;
    if (fs.bavail*fs.bsize < required || (fs.blocks-fs.bavail)*10n >= fs.blocks*9n ||
        (quotaBytes && inspectTree(root)+required > BigInt(quotaBytes))) throw new StoreError('CAPACITY');
    barrier('history-schema-before-backup');
    const path = join(root, backup);
    closeSync(privateFile(path));
    db.prepare('VACUUM INTO ?').run(path); assertPrivate(path, false);
    barrier('history-schema-backup-written');
    const saved = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    try {
      if (saved.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok' ||
          saved.prepare('PRAGMA user_version').get()!.user_version !== 5) throw new StoreError('CORRUPT_STORE');
      for (const table of tables) {
        const before = digest(db, table);
        if (canonical(before) !== canonical(digest(saved, table))) throw new StoreError('CORRUPT_STORE');
        manifest[table] = before;
      }
      const sql = (database: DatabaseSync) => database.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
      if (canonical(sql(db)) !== canonical(sql(saved))) throw new StoreError('CORRUPT_STORE');
      manifest.sqlite_schema = hashBytes(canonical(sql(saved)));
    } finally { saved.close(); }
    const fd = privateFile(path); try { fsyncSync(fd); } finally { closeSync(fd); }
    const proof = fileProof(path); proofs.push(proof); backupHash = proof.hash;
    manifestFile = `${backup}.manifest.json`;
    const out = privateFile(join(root, manifestFile));
    try {
      writeFileSync(out, canonical({ schemaVersion: 1, backup, backupHash, storageVersion: 5,
        compatibleExecutable, manifest,
        retainedDirectories: ['objects','staging','uploads'],
        recovery: 'Copy the backup database and retained directories into a separate owner-only root. Use only the named compatible executable. Keep this root and all prior backups unchanged.' }));
      fsyncSync(out);
    } finally { closeSync(out); }
    proofs.push(fileProof(join(root, manifestFile)));
    syncDirectory(root);
    barrier('history-schema-backup-verified');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    // No pending request, event, projection, receipt or root is transformed.
    for (const table of tables) if (backup && canonical(manifest[table]) !== canonical(digest(db, table))) throw new StoreError('CORRUPT_STORE');
    db.prepare('INSERT INTO schema_migrations VALUES (6,?)').run(canonical({ from:5, to:6, capability,
      strategy:'semantic-version-verified-backup-transactional-activation', backup, backupHash, manifestFile, manifest,
      rollback: backup ? { compatibleExecutable,  } : null }));
    db.exec(`CREATE TABLE history_preparations (id TEXT PRIMARY KEY, hash TEXT NOT NULL, original TEXT NOT NULL, canonical TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE, phase TEXT NOT NULL, frozen TEXT NOT NULL) STRICT;
      CREATE TABLE image_previews (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, client_id TEXT NOT NULL, json TEXT NOT NULL) STRICT;
      CREATE TABLE image_edit_reviews (id TEXT PRIMARY KEY, json TEXT NOT NULL, session_hash TEXT NOT NULL, epoch TEXT NOT NULL) STRICT;
      CREATE TABLE ui_checkpoints (client_id TEXT NOT NULL, session_id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(client_id,session_id)) STRICT;
      CREATE TABLE ui_events (client_id TEXT NOT NULL, session_id TEXT NOT NULL, seq TEXT NOT NULL, recorded_at TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(client_id,session_id,seq)) STRICT;
      CREATE TABLE ui_receipts (client_id TEXT NOT NULL, id TEXT NOT NULL, hash TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(client_id,id)) STRICT;
      CREATE INDEX history_parent_branch ON history(json_extract(json,'$.parent'),json_extract(json,'$.branchId'));
      CREATE INDEX history_document_page ON history(document_id,id);
      CREATE INDEX checkpoints_document_page ON checkpoints(document_id,id);
      CREATE INDEX commands_document_layer ON commands(json_extract(canonical,'$.command.documentId'),json_extract(canonical,'$.command.body.layerId'));
      CREATE INDEX commands_document_new_layer ON commands(json_extract(canonical,'$.command.documentId'),json_extract(canonical,'$.command.body.newLayerId'));
      PRAGMA user_version=6`);
    barrier('history-schema-before-activation');
    for (const proof of proofs) {
      const current = fileProof(proof.path);
      if (!sameFile(current.identity, proof.identity) || current.hash !== proof.hash) throw new StoreError('CORRUPT_STORE');
    }
    db.exec('COMMIT'); syncDirectory(root);
    barrier('history-schema-after-activation');
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}

export function portableSchema(db: DatabaseSync, root: string, barrier: Barrier, quotaBytes?: string, fresh = false) {
  const capability = 'portable-copy-v1';
  if (Number(db.prepare('PRAGMA user_version').get()!.user_version) >= 7) {
    const row = db.prepare('SELECT receipt FROM schema_migrations WHERE version=7').get();
    if (!row || JSON.parse(String(row.receipt)).capability !== capability) throw new StoreError('CORRUPT_STORE');
    return;
  }
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(r=>String(r.name));
  const compatibleExecutable = 'd84c1de55709bbd957222cac854905c41583a4e4';
  const backup = fresh ? null : `schema6-backup-${randomUUID()}.sqlite`;
  const manifest: Record<string, unknown> = {};
  let backupHash: string | null = null;
  let manifestFile: string | null = null;
  const fileProof = (path: string) => {
    const identity = assertPrivate(path, false), input = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const hash = createHash('sha256'), block = Buffer.alloc(1048576);
    try {
      if (!sameFile(identity, fstatSync(input))) throw new StoreError('ROOT_UNSAFE');
      for (;;) { const n = readSync(input, block); if (!n) break; hash.update(block.subarray(0,n)); }
      const after = assertPrivate(path, false);
      if (!sameFile(identity, after) || identity.size !== after.size || identity.mtimeMs !== after.mtimeMs || identity.ctimeMs !== after.ctimeMs) throw new StoreError('ROOT_UNSAFE');
    } finally { closeSync(input); }
    return { path, identity, hash: `sha256:${hash.digest('hex')}` };
  };
  const proofs: ReturnType<typeof fileProof>[] = [];
  if (backup) {
    const size = BigInt(Number(db.prepare('PRAGMA page_count').get()!.page_count) * Number(db.prepare('PRAGMA page_size').get()!.page_size));
    const fs = statfsSync(root, { bigint: true }), required = size + (size+3n)/4n + 1073741824n + 67108864n;
    if (fs.bavail*fs.bsize < required || (fs.blocks-fs.bavail)*10n >= fs.blocks*9n ||
        (quotaBytes && inspectTree(root)+required > BigInt(quotaBytes))) throw new StoreError('CAPACITY');
    barrier('portable-schema-before-backup');
    const path = join(root, backup);
    closeSync(privateFile(path));
    db.prepare('VACUUM INTO ?').run(path); assertPrivate(path, false);
    barrier('portable-schema-backup-written');
    const saved = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    try {
      if (saved.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok' ||
          saved.prepare('PRAGMA user_version').get()!.user_version !== 6) throw new StoreError('CORRUPT_STORE');
      for (const table of tables) {
        const before = digest(db, table);
        if (canonical(before) !== canonical(digest(saved, table))) throw new StoreError('CORRUPT_STORE');
        manifest[table] = before;
      }
      const sql = (database: DatabaseSync) => database.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
      if (canonical(sql(db)) !== canonical(sql(saved))) throw new StoreError('CORRUPT_STORE');
      manifest.sqlite_schema = hashBytes(canonical(sql(saved)));
    } finally { saved.close(); }
    const fd = privateFile(path); try { fsyncSync(fd); } finally { closeSync(fd); }
    const proof = fileProof(path); proofs.push(proof); backupHash = proof.hash;
    manifestFile = `${backup}.manifest.json`;
    const out = privateFile(join(root, manifestFile));
    try {
      writeFileSync(out, canonical({ schemaVersion: 1, backup, backupHash, storageVersion: 6,
        compatibleExecutable, manifest,
        retainedDirectories: ['objects','staging','uploads'],
        recovery: 'Copy the backup database and retained directories into a separate owner-only root. Use only the named compatible executable. Keep this root and all prior backups unchanged.' }));
      fsyncSync(out);
    } finally { closeSync(out); }
    proofs.push(fileProof(join(root, manifestFile)));
    syncDirectory(root);
    barrier('portable-schema-backup-verified');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    // No pending request, event, projection, receipt or root is transformed.
    for (const table of tables) if (backup && canonical(manifest[table]) !== canonical(digest(db, table))) throw new StoreError('CORRUPT_STORE');
    db.prepare('INSERT INTO schema_migrations VALUES (7,?)').run(canonical({ from:6, to:7, capability,
      strategy:'semantic-version-verified-backup-transactional-activation', backup, backupHash, manifestFile, manifest,
      rollback: backup ? { compatibleExecutable,  } : null }));
    db.exec(`CREATE TABLE portable_preparations (id TEXT PRIMARY KEY,hash TEXT NOT NULL,original TEXT NOT NULL,canonical TEXT NOT NULL,operation_id TEXT NOT NULL UNIQUE,phase TEXT NOT NULL,frozen TEXT NOT NULL,confirmed_at INTEGER NOT NULL,failure TEXT) STRICT;
      CREATE TABLE portable_pins (operation_id TEXT NOT NULL,hash TEXT NOT NULL REFERENCES objects(hash),media_type TEXT NOT NULL,PRIMARY KEY(operation_id,hash)) STRICT;
      CREATE TABLE portable_bundles (id TEXT PRIMARY KEY,client_id TEXT NOT NULL,document_id TEXT NOT NULL,json TEXT NOT NULL) STRICT;
      CREATE TABLE portable_reviews (id TEXT PRIMARY KEY,client_id TEXT NOT NULL,session_hash TEXT NOT NULL,epoch TEXT NOT NULL,json TEXT NOT NULL) STRICT;
      CREATE TABLE portable_namespaces (id TEXT PRIMARY KEY,document_id TEXT NOT NULL UNIQUE,source TEXT NOT NULL) STRICT;
      CREATE TABLE portable_rows (namespace TEXT NOT NULL REFERENCES portable_namespaces(id),kind TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(namespace,kind,id)) STRICT;
      CREATE TABLE portable_quarantined_hashes (hash TEXT PRIMARY KEY,reason TEXT NOT NULL) STRICT;
      CREATE TABLE portable_cancellations (id TEXT PRIMARY KEY,reason TEXT NOT NULL) STRICT;
      CREATE TABLE portable_review_sources (id TEXT PRIMARY KEY,staging_id TEXT NOT NULL,version TEXT NOT NULL,stamp TEXT NOT NULL) STRICT;
      CREATE TABLE portable_review_maps (review_id TEXT NOT NULL,kind TEXT NOT NULL,source_id TEXT NOT NULL,local_id TEXT NOT NULL,PRIMARY KEY(review_id,kind,source_id)) STRICT;
      CREATE TABLE portable_maps (namespace TEXT NOT NULL REFERENCES portable_namespaces(id),kind TEXT NOT NULL,source_id TEXT NOT NULL,local_id TEXT NOT NULL,PRIMARY KEY(namespace,kind,source_id)) STRICT;
      PRAGMA user_version=7`);
    barrier('portable-schema-before-activation');
    for (const proof of proofs) {
      const current = fileProof(proof.path);
      if (!sameFile(current.identity, proof.identity) || current.hash !== proof.hash) throw new StoreError('CORRUPT_STORE');
    }
    db.exec('COMMIT'); syncDirectory(root);
    barrier('portable-schema-after-activation');
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}

export function portableTransactionSchema(db: DatabaseSync, root: string, barrier: Barrier, quotaBytes?: string, fresh = false) {
  const capability = 'portable-copy-v2-transaction-bounds';
  if (Number(db.prepare('PRAGMA user_version').get()!.user_version) >= 8) {
    const row = db.prepare('SELECT receipt FROM schema_migrations WHERE version=8').get();
    if (!row || JSON.parse(String(row.receipt)).capability !== capability) throw new StoreError('CORRUPT_STORE');
    return;
  }
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(r=>String(r.name));
  const compatibleExecutable = 'd4ed76148999978565ca8b37d27612f5b3faa591';
  const backup = fresh ? null : `schema7-backup-${randomUUID()}.sqlite`;
  const manifest: Record<string, unknown> = {};
  let backupHash: string | null = null;
  let manifestFile: string | null = null;
  const fileProof = (path: string) => {
    const identity = assertPrivate(path, false), input = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const hash = createHash('sha256'), block = Buffer.alloc(1048576);
    try {
      if (!sameFile(identity, fstatSync(input))) throw new StoreError('ROOT_UNSAFE');
      for (;;) { const n = readSync(input, block); if (!n) break; hash.update(block.subarray(0,n)); }
      const after = assertPrivate(path, false);
      if (!sameFile(identity, after) || identity.size !== after.size || identity.mtimeMs !== after.mtimeMs || identity.ctimeMs !== after.ctimeMs) throw new StoreError('ROOT_UNSAFE');
    } finally { closeSync(input); }
    return { path, identity, hash: `sha256:${hash.digest('hex')}` };
  };
  const proofs: ReturnType<typeof fileProof>[] = [];
  if (backup) {
    const size = BigInt(Number(db.prepare('PRAGMA page_count').get()!.page_count) * Number(db.prepare('PRAGMA page_size').get()!.page_size));
    const fs = statfsSync(root, { bigint: true }), required = size + (size+3n)/4n + 1073741824n + 67108864n;
    if (fs.bavail*fs.bsize < required || (fs.blocks-fs.bavail)*10n >= fs.blocks*9n ||
        (quotaBytes && inspectTree(root)+required > BigInt(quotaBytes))) throw new StoreError('CAPACITY');
    barrier('portable-transaction-schema-before-backup');
    const path = join(root, backup);
    closeSync(privateFile(path));
    db.prepare('VACUUM INTO ?').run(path); assertPrivate(path, false);
    barrier('portable-transaction-schema-backup-written');
    const saved = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    try {
      if (saved.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok' ||
          saved.prepare('PRAGMA user_version').get()!.user_version !== 7) throw new StoreError('CORRUPT_STORE');
      for (const table of tables) {
        const before = digest(db, table);
        if (canonical(before) !== canonical(digest(saved, table))) throw new StoreError('CORRUPT_STORE');
        manifest[table] = before;
      }
      const sql = (database: DatabaseSync) => database.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
      if (canonical(sql(db)) !== canonical(sql(saved))) throw new StoreError('CORRUPT_STORE');
      manifest.sqlite_schema = hashBytes(canonical(sql(saved)));
    } finally { saved.close(); }
    const fd = privateFile(path); try { fsyncSync(fd); } finally { closeSync(fd); }
    const proof = fileProof(path); proofs.push(proof); backupHash = proof.hash;
    manifestFile = `${backup}.manifest.json`;
    const out = privateFile(join(root, manifestFile));
    try {
      writeFileSync(out, canonical({ schemaVersion: 1, backup, backupHash, storageVersion: 7,
        compatibleExecutable, manifest,
        retainedDirectories: ['objects','staging','uploads','portable'],
        recovery: 'Copy the backup database and retained directories into a separate owner-only root. Use only the named compatible executable. Keep this root and all prior backups unchanged.' }));
      fsyncSync(out);
    } finally { closeSync(out); }
    proofs.push(fileProof(join(root, manifestFile)));
    syncDirectory(root);
    barrier('portable-transaction-schema-backup-verified');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    // No pending request, event, projection, receipt or root is transformed.
    for (const table of tables) if (backup && canonical(manifest[table]) !== canonical(digest(db, table))) throw new StoreError('CORRUPT_STORE');
    db.prepare('INSERT INTO schema_migrations VALUES (8,?)').run(canonical({ from:7, to:8, capability,
      strategy:'semantic-version-verified-backup-transactional-activation', backup, backupHash, manifestFile, manifest,
      rollback: backup ? { compatibleExecutable,  } : null }));
    db.exec('CREATE INDEX events_v2_transaction_bounds ON events_v2(transaction_id,length(seq),seq); PRAGMA user_version=8');
    barrier('portable-transaction-schema-before-activation');
    for (const proof of proofs) {
      const current = fileProof(proof.path);
      if (!sameFile(current.identity, proof.identity) || current.hash !== proof.hash) throw new StoreError('CORRUPT_STORE');
    }
    db.exec('COMMIT'); syncDirectory(root);
    barrier('portable-transaction-schema-after-activation');
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}

export function textSchema(db: DatabaseSync, root: string, barrier: Barrier, quotaBytes?: string, fresh = false) {
  const capability = 'durable-text-v1-pf3-projection4';
  if (Number(db.prepare('PRAGMA user_version').get()!.user_version) >= 9) {
    const row = db.prepare('SELECT receipt FROM schema_migrations WHERE version=9').get();
    if (!row || JSON.parse(String(row.receipt)).capability !== capability) throw new StoreError('CORRUPT_STORE');
    return;
  }
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(r=>String(r.name));
  const compatibleExecutable = 'dcd5f11dbd57cd7ed00c8ddf410857ce4700440e';
  const backup = fresh ? null : `schema8-backup-${randomUUID()}.sqlite`;
  const manifest: Record<string, unknown> = {};
  let backupHash: string | null = null;
  let manifestFile: string | null = null;
  const fileProof = (path: string) => {
    const identity = assertPrivate(path, false), input = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const hash = createHash('sha256'), block = Buffer.alloc(1048576);
    try {
      if (!sameFile(identity, fstatSync(input))) throw new StoreError('ROOT_UNSAFE');
      for (;;) { const n = readSync(input, block); if (!n) break; hash.update(block.subarray(0,n)); }
      const after = assertPrivate(path, false);
      if (!sameFile(identity, after) || identity.size !== after.size || identity.mtimeMs !== after.mtimeMs || identity.ctimeMs !== after.ctimeMs) throw new StoreError('ROOT_UNSAFE');
    } finally { closeSync(input); }
    return { path, identity, hash: `sha256:${hash.digest('hex')}` };
  };
  const proofs: ReturnType<typeof fileProof>[] = [];
  if (backup) {
    const size = BigInt(Number(db.prepare('PRAGMA page_count').get()!.page_count) * Number(db.prepare('PRAGMA page_size').get()!.page_size));
    const fs = statfsSync(root, { bigint: true }), required = size + (size+3n)/4n + 1073741824n + 67108864n;
    if (fs.bavail*fs.bsize < required || (fs.blocks-fs.bavail)*10n >= fs.blocks*9n ||
        (quotaBytes && inspectTree(root)+required > BigInt(quotaBytes))) throw new StoreError('CAPACITY');
    barrier('text-schema-before-backup');
    const path = join(root, backup);
    closeSync(privateFile(path));
    db.prepare('VACUUM INTO ?').run(path); assertPrivate(path, false);
    barrier('text-schema-backup-written');
    const saved = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    try {
      if (saved.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok' ||
          saved.prepare('PRAGMA user_version').get()!.user_version !== 8) throw new StoreError('CORRUPT_STORE');
      for (const table of tables) {
        const before = digest(db, table);
        if (canonical(before) !== canonical(digest(saved, table))) throw new StoreError('CORRUPT_STORE');
        manifest[table] = before;
      }
      const sql = (database: DatabaseSync) => database.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
      if (canonical(sql(db)) !== canonical(sql(saved))) throw new StoreError('CORRUPT_STORE');
      manifest.sqlite_schema = hashBytes(canonical(sql(saved)));
    } finally { saved.close(); }
    const fd = privateFile(path); try { fsyncSync(fd); } finally { closeSync(fd); }
    const proof = fileProof(path); proofs.push(proof); backupHash = proof.hash;
    manifestFile = `${backup}.manifest.json`;
    const out = privateFile(join(root, manifestFile));
    try {
      writeFileSync(out, canonical({ schemaVersion: 1, backup, backupHash, storageVersion: 8,
        compatibleExecutable, manifest,
        retainedDirectories: ['objects','staging','uploads','portable'],
        recovery: 'Copy the backup database and retained directories into a separate owner-only root. Use only the named compatible executable. Keep this root and all prior backups unchanged.' }));
      fsyncSync(out);
    } finally { closeSync(out); }
    proofs.push(fileProof(join(root, manifestFile)));
    syncDirectory(root);
    barrier('text-schema-backup-verified');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    // No pending request, event, projection, receipt or root is transformed.
    for (const table of tables) if (backup && canonical(manifest[table]) !== canonical(digest(db, table))) throw new StoreError('CORRUPT_STORE');
    db.prepare('INSERT INTO schema_migrations VALUES (9,?)').run(canonical({ from:8, to:9, capability,
      strategy:'semantic-version-verified-backup-transactional-activation', backup, backupHash, manifestFile, manifest,
      rollback: backup ? { compatibleExecutable,  } : null }));
    db.exec('CREATE TABLE text_admissions (id TEXT PRIMARY KEY,client_id TEXT NOT NULL,session_hash TEXT NOT NULL,epoch TEXT NOT NULL) STRICT; PRAGMA user_version=9');
    barrier('text-schema-before-activation');
    for (const proof of proofs) {
      const current = fileProof(proof.path);
      if (!sameFile(current.identity, proof.identity) || current.hash !== proof.hash) throw new StoreError('CORRUPT_STORE');
    }
    db.exec('COMMIT'); syncDirectory(root);
    barrier('text-schema-after-activation');
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}

export function maskSchema(db: DatabaseSync, root: string, barrier: Barrier, quotaBytes?: string, fresh = false) {
  const capability = 'local-masks-v1-pf4-projection5';
  if (Number(db.prepare('PRAGMA user_version').get()!.user_version) >= 10) {
    const row = db.prepare('SELECT receipt FROM schema_migrations WHERE version=10').get();
    if (!row || JSON.parse(String(row.receipt)).capability !== capability) throw new StoreError('CORRUPT_STORE');
    return;
  }
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(r=>String(r.name));
  const compatibleExecutable = '4b2c82ccc41dd72c3f83480f23481b7b62135d23';
  const backup = fresh ? null : `schema9-backup-${randomUUID()}.sqlite`;
  const manifest: Record<string, unknown> = {};
  let backupHash: string | null = null;
  let manifestFile: string | null = null;
  const fileProof = (path: string) => {
    const identity = assertPrivate(path, false), input = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const hash = createHash('sha256'), block = Buffer.alloc(1048576);
    try {
      if (!sameFile(identity, fstatSync(input))) throw new StoreError('ROOT_UNSAFE');
      for (;;) { const n = readSync(input, block); if (!n) break; hash.update(block.subarray(0,n)); }
      const after = assertPrivate(path, false);
      if (!sameFile(identity, after) || identity.size !== after.size || identity.mtimeMs !== after.mtimeMs || identity.ctimeMs !== after.ctimeMs) throw new StoreError('ROOT_UNSAFE');
    } finally { closeSync(input); }
    return { path, identity, hash: `sha256:${hash.digest('hex')}` };
  };
  const proofs: ReturnType<typeof fileProof>[] = [];
  if (backup) {
    const size = BigInt(Number(db.prepare('PRAGMA page_count').get()!.page_count) * Number(db.prepare('PRAGMA page_size').get()!.page_size));
    const fs = statfsSync(root, { bigint: true }), required = size + (size+3n)/4n + 1073741824n + 67108864n;
    if (fs.bavail*fs.bsize < required || (fs.blocks-fs.bavail)*10n >= fs.blocks*9n ||
        (quotaBytes && inspectTree(root)+required > BigInt(quotaBytes))) throw new StoreError('CAPACITY');
    barrier('mask-schema-before-backup');
    const path = join(root, backup);
    closeSync(privateFile(path));
    db.prepare('VACUUM INTO ?').run(path); assertPrivate(path, false);
    barrier('mask-schema-backup-written');
    const saved = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    try {
      if (saved.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok' ||
          saved.prepare('PRAGMA user_version').get()!.user_version !== 9) throw new StoreError('CORRUPT_STORE');
      for (const table of tables) {
        const before = digest(db, table);
        if (canonical(before) !== canonical(digest(saved, table))) throw new StoreError('CORRUPT_STORE');
        manifest[table] = before;
      }
      const sql = (database: DatabaseSync) => database.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
      if (canonical(sql(db)) !== canonical(sql(saved))) throw new StoreError('CORRUPT_STORE');
      manifest.sqlite_schema = hashBytes(canonical(sql(saved)));
    } finally { saved.close(); }
    const fd = privateFile(path); try { fsyncSync(fd); } finally { closeSync(fd); }
    const proof = fileProof(path); proofs.push(proof); backupHash = proof.hash;
    manifestFile = `${backup}.manifest.json`;
    const out = privateFile(join(root, manifestFile));
    try {
      writeFileSync(out, canonical({ schemaVersion: 1, backup, backupHash, storageVersion: 9,
        compatibleExecutable, manifest,
        retainedDirectories: ['objects','staging','uploads','portable'],
        recovery: 'Copy the backup database and retained directories into a separate owner-only root. Use only the named compatible executable. Keep this root and all prior backups unchanged.' }));
      fsyncSync(out);
    } finally { closeSync(out); }
    proofs.push(fileProof(join(root, manifestFile)));
    syncDirectory(root);
    barrier('mask-schema-backup-verified');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    // No pending request, event, projection, receipt or root is transformed.
    for (const table of tables) if (backup && canonical(manifest[table]) !== canonical(digest(db, table))) throw new StoreError('CORRUPT_STORE');
    db.prepare('INSERT INTO schema_migrations VALUES (10,?)').run(canonical({ from:9, to:10, capability,
      strategy:'semantic-version-verified-backup-transactional-activation', backup, backupHash, manifestFile, manifest,
      rollback: backup ? { compatibleExecutable,  } : null }));
    db.exec('PRAGMA user_version=10');
    barrier('mask-schema-before-activation');
    for (const proof of proofs) {
      const current = fileProof(proof.path);
      if (!sameFile(current.identity, proof.identity) || current.hash !== proof.hash) throw new StoreError('CORRUPT_STORE');
    }
    db.exec('COMMIT'); syncDirectory(root);
    barrier('mask-schema-after-activation');
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}

export function retainedMaskSchema(db: DatabaseSync, root: string, barrier: Barrier, quotaBytes?: string, fresh = false) {
  const capability = 'retained-mask-grids-v1-pf5-projection6';
  if (Number(db.prepare('PRAGMA user_version').get()!.user_version) >= 11) {
    const row = db.prepare('SELECT receipt FROM schema_migrations WHERE version=11').get();
    if (!row || JSON.parse(String(row.receipt)).capability !== capability) throw new StoreError('CORRUPT_STORE');
    return;
  }
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(r=>String(r.name));
  const compatibleExecutable = 'ecbcc79e9fa8e89acf84c2bb02831b780582ed88';
  const backup = fresh ? null : `schema10-backup-${randomUUID()}.sqlite`;
  const manifest: Record<string, unknown> = {};
  let backupHash: string | null = null;
  let manifestFile: string | null = null;
  const fileProof = (path: string) => {
    const identity = assertPrivate(path, false), input = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const hash = createHash('sha256'), block = Buffer.alloc(1048576);
    try {
      if (!sameFile(identity, fstatSync(input))) throw new StoreError('ROOT_UNSAFE');
      for (;;) { const n = readSync(input, block); if (!n) break; hash.update(block.subarray(0,n)); }
      const after = assertPrivate(path, false);
      if (!sameFile(identity, after) || identity.size !== after.size || identity.mtimeMs !== after.mtimeMs || identity.ctimeMs !== after.ctimeMs) throw new StoreError('ROOT_UNSAFE');
    } finally { closeSync(input); }
    return { path, identity, hash: `sha256:${hash.digest('hex')}` };
  };
  const proofs: ReturnType<typeof fileProof>[] = [];
  if (backup) {
    const size = BigInt(Number(db.prepare('PRAGMA page_count').get()!.page_count) * Number(db.prepare('PRAGMA page_size').get()!.page_size));
    const fs = statfsSync(root, { bigint: true }), required = size + (size+3n)/4n + 1073741824n + 67108864n;
    if (fs.bavail*fs.bsize < required || (fs.blocks-fs.bavail)*10n >= fs.blocks*9n ||
        (quotaBytes && inspectTree(root)+required > BigInt(quotaBytes))) throw new StoreError('CAPACITY');
    barrier('retained-mask-schema-before-backup');
    const path = join(root, backup);
    closeSync(privateFile(path));
    db.prepare('VACUUM INTO ?').run(path); assertPrivate(path, false);
    barrier('retained-mask-schema-backup-written');
    const saved = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    try {
      if (saved.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok' ||
          saved.prepare('PRAGMA user_version').get()!.user_version !== 10) throw new StoreError('CORRUPT_STORE');
      for (const table of tables) {
        const before = digest(db, table);
        if (canonical(before) !== canonical(digest(saved, table))) throw new StoreError('CORRUPT_STORE');
        manifest[table] = before;
      }
      const sql = (database: DatabaseSync) => database.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
      if (canonical(sql(db)) !== canonical(sql(saved))) throw new StoreError('CORRUPT_STORE');
      manifest.sqlite_schema = hashBytes(canonical(sql(saved)));
    } finally { saved.close(); }
    const fd = privateFile(path); try { fsyncSync(fd); } finally { closeSync(fd); }
    const proof = fileProof(path); proofs.push(proof); backupHash = proof.hash;
    manifestFile = `${backup}.manifest.json`;
    const out = privateFile(join(root, manifestFile));
    try {
      writeFileSync(out, canonical({ schemaVersion: 1, backup, backupHash, storageVersion: 10,
        compatibleExecutable, manifest,
        retainedDirectories: ['objects','staging','uploads','portable'],
        recovery: 'Copy the backup database and retained directories into a separate owner-only root. Use only the named compatible executable. Keep this root and all prior backups unchanged.' }));
      fsyncSync(out);
    } finally { closeSync(out); }
    proofs.push(fileProof(join(root, manifestFile)));
    syncDirectory(root);
    barrier('retained-mask-schema-backup-verified');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    // No pending request, event, projection, receipt or root is transformed.
    for (const table of tables) if (backup && canonical(manifest[table]) !== canonical(digest(db, table))) throw new StoreError('CORRUPT_STORE');
    db.prepare('INSERT INTO schema_migrations VALUES (11,?)').run(canonical({ from:10, to:11, capability,
      strategy:'semantic-version-verified-backup-transactional-activation', backup, backupHash, manifestFile, manifest,
      rollback: backup ? { compatibleExecutable,  } : null }));
    db.exec('PRAGMA user_version=11');
    barrier('retained-mask-schema-before-activation');
    for (const proof of proofs) {
      const current = fileProof(proof.path);
      if (!sameFile(current.identity, proof.identity) || current.hash !== proof.hash) throw new StoreError('CORRUPT_STORE');
    }
    db.exec('COMMIT'); syncDirectory(root);
    barrier('retained-mask-schema-after-activation');
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}

export function textPlacementSchema(db: DatabaseSync, root: string, barrier: Barrier, quotaBytes?: string, fresh = false) {
  const capability = 'text-placement-v1-pf6-projection7';
  if (Number(db.prepare('PRAGMA user_version').get()!.user_version) >= 12) {
    const row = db.prepare('SELECT receipt FROM schema_migrations WHERE version=12').get();
    if (!row || JSON.parse(String(row.receipt)).capability !== capability) throw new StoreError('CORRUPT_STORE');
    return;
  }
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(r=>String(r.name));
  const compatibleExecutable = 'd3c6046a44d29d89ccdcb219cc37d40f02bad84f';
  const backup = fresh ? null : `schema11-backup-${randomUUID()}.sqlite`;
  const manifest: Record<string, unknown> = {};
  let backupHash: string | null = null;
  let manifestFile: string | null = null;
  const fileProof = (path: string) => {
    const identity = assertPrivate(path, false), input = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const hash = createHash('sha256'), block = Buffer.alloc(1148576);
    try {
      if (!sameFile(identity, fstatSync(input))) throw new StoreError('ROOT_UNSAFE');
      for (;;) { const n = readSync(input, block); if (!n) break; hash.update(block.subarray(0,n)); }
      const after = assertPrivate(path, false);
      if (!sameFile(identity, after) || identity.size !== after.size || identity.mtimeMs !== after.mtimeMs || identity.ctimeMs !== after.ctimeMs) throw new StoreError('ROOT_UNSAFE');
    } finally { closeSync(input); }
    return { path, identity, hash: `sha256:${hash.digest('hex')}` };
  };
  const proofs: ReturnType<typeof fileProof>[] = [];
  if (backup) {
    const size = BigInt(Number(db.prepare('PRAGMA page_count').get()!.page_count) * Number(db.prepare('PRAGMA page_size').get()!.page_size));
    const fs = statfsSync(root, { bigint: true }), required = size + (size+3n)/4n + 1173741824n + 67118864n;
    if (fs.bavail*fs.bsize < required || (fs.blocks-fs.bavail)*11n >= fs.blocks*9n ||
        (quotaBytes && inspectTree(root)+required > BigInt(quotaBytes))) throw new StoreError('CAPACITY');
    barrier('text-placement-schema-before-backup');
    const path = join(root, backup);
    closeSync(privateFile(path));
    db.prepare('VACUUM INTO ?').run(path); assertPrivate(path, false);
    barrier('text-placement-schema-backup-written');
    const saved = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    try {
      if (saved.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok' ||
          saved.prepare('PRAGMA user_version').get()!.user_version !== 11) throw new StoreError('CORRUPT_STORE');
      for (const table of tables) {
        const before = digest(db, table);
        if (canonical(before) !== canonical(digest(saved, table))) throw new StoreError('CORRUPT_STORE');
        manifest[table] = before;
      }
      const sql = (database: DatabaseSync) => database.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
      if (canonical(sql(db)) !== canonical(sql(saved))) throw new StoreError('CORRUPT_STORE');
      manifest.sqlite_schema = hashBytes(canonical(sql(saved)));
    } finally { saved.close(); }
    const fd = privateFile(path); try { fsyncSync(fd); } finally { closeSync(fd); }
    const proof = fileProof(path); proofs.push(proof); backupHash = proof.hash;
    manifestFile = `${backup}.manifest.json`;
    const out = privateFile(join(root, manifestFile));
    try {
      writeFileSync(out, canonical({ schemaVersion: 1, backup, backupHash, storageVersion: 11,
        compatibleExecutable, manifest,
        retainedDirectories: ['objects','staging','uploads','portable'],
        recovery: 'Copy the backup database and retained directories into a separate owner-only root. Use only the named compatible executable. Keep this root and all prior backups unchanged.' }));
      fsyncSync(out);
    } finally { closeSync(out); }
    proofs.push(fileProof(join(root, manifestFile)));
    syncDirectory(root);
    barrier('text-placement-schema-backup-verified');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    // No pending request, event, projection, receipt or root is transformed.
    for (const table of tables) if (backup && canonical(manifest[table]) !== canonical(digest(db, table))) throw new StoreError('CORRUPT_STORE');
    db.prepare('INSERT INTO schema_migrations VALUES (12,?)').run(canonical({ from:11, to:12, capability,
      strategy:'semantic-version-verified-backup-transactional-activation', backup, backupHash, manifestFile, manifest,
      rollback: backup ? { compatibleExecutable,  } : null }));
    db.exec('PRAGMA user_version=12');
    barrier('text-placement-schema-before-activation');
    for (const proof of proofs) {
      const current = fileProof(proof.path);
      if (!sameFile(current.identity, proof.identity) || current.hash !== proof.hash) throw new StoreError('CORRUPT_STORE');
    }
    db.exec('COMMIT'); syncDirectory(root);
    barrier('text-placement-schema-after-activation');
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}

export function compositionSchema(db: DatabaseSync, root: string, barrier: Barrier, quotaBytes?: string, fresh = false) {
  const capability = 'composition-v1-pf7-projection8';
  if (Number(db.prepare('PRAGMA user_version').get()!.user_version) >= 13) {
    const row = db.prepare('SELECT receipt FROM schema_migrations WHERE version=13').get();
    if (!row || JSON.parse(String(row.receipt)).capability !== capability) throw new StoreError('CORRUPT_STORE');
    return;
  }
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(r=>String(r.name));
  const compatibleExecutable = 'd3b8e5f5ec4568547f21a2826792450367144a17';
  const backup = fresh ? null : `schema12-backup-${randomUUID()}.sqlite`;
  const manifest: Record<string, unknown> = {};
  let backupHash: string | null = null;
  let manifestFile: string | null = null;
  const fileProof = (path: string) => {
    const identity = assertPrivate(path, false), input = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const hash = createHash('sha256'), block = Buffer.alloc(1148576);
    try {
      if (!sameFile(identity, fstatSync(input))) throw new StoreError('ROOT_UNSAFE');
      for (;;) { const n = readSync(input, block); if (!n) break; hash.update(block.subarray(0,n)); }
      const after = assertPrivate(path, false);
      if (!sameFile(identity, after) || identity.size !== after.size || identity.mtimeMs !== after.mtimeMs || identity.ctimeMs !== after.ctimeMs) throw new StoreError('ROOT_UNSAFE');
    } finally { closeSync(input); }
    return { path, identity, hash: `sha256:${hash.digest('hex')}` };
  };
  const proofs: ReturnType<typeof fileProof>[] = [];
  if (backup) {
    const size = BigInt(Number(db.prepare('PRAGMA page_count').get()!.page_count) * Number(db.prepare('PRAGMA page_size').get()!.page_size));
    const fs = statfsSync(root, { bigint: true }), required = size + (size+3n)/4n + 1173741824n + 67118864n;
    if (fs.bavail*fs.bsize < required || (fs.blocks-fs.bavail)*11n >= fs.blocks*9n ||
        (quotaBytes && inspectTree(root)+required > BigInt(quotaBytes))) throw new StoreError('CAPACITY');
    barrier('composition-schema-before-backup');
    const path = join(root, backup);
    closeSync(privateFile(path));
    db.prepare('VACUUM INTO ?').run(path); assertPrivate(path, false);
    barrier('composition-schema-backup-written');
    const saved = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    try {
      if (saved.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok' ||
          saved.prepare('PRAGMA user_version').get()!.user_version !== 12) throw new StoreError('CORRUPT_STORE');
      for (const table of tables) {
        const before = digest(db, table);
        if (canonical(before) !== canonical(digest(saved, table))) throw new StoreError('CORRUPT_STORE');
        manifest[table] = before;
      }
      const sql = (database: DatabaseSync) => database.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
      if (canonical(sql(db)) !== canonical(sql(saved))) throw new StoreError('CORRUPT_STORE');
      manifest.sqlite_schema = hashBytes(canonical(sql(saved)));
    } finally { saved.close(); }
    const fd = privateFile(path); try { fsyncSync(fd); } finally { closeSync(fd); }
    const proof = fileProof(path); proofs.push(proof); backupHash = proof.hash;
    manifestFile = `${backup}.manifest.json`;
    const out = privateFile(join(root, manifestFile));
    try {
      writeFileSync(out, canonical({ schemaVersion: 1, backup, backupHash, storageVersion: 12,
        compatibleExecutable, manifest,
        retainedDirectories: ['objects','staging','uploads','portable'],
        recovery: 'Copy the backup database and retained directories into a separate owner-only root. Use only the named compatible executable. Keep this root and all prior backups unchanged.' }));
      fsyncSync(out);
    } finally { closeSync(out); }
    proofs.push(fileProof(join(root, manifestFile)));
    syncDirectory(root);
    barrier('composition-schema-backup-verified');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    // No pending request, event, projection, receipt or root is transformed.
    for (const table of tables) if (backup && canonical(manifest[table]) !== canonical(digest(db, table))) throw new StoreError('CORRUPT_STORE');
    db.prepare('INSERT INTO schema_migrations VALUES (13,?)').run(canonical({ from:12, to:13, capability,
      strategy:'semantic-version-verified-backup-transactional-activation', backup, backupHash, manifestFile, manifest,
      rollback: backup ? { compatibleExecutable,  } : null }));
    db.exec('PRAGMA user_version=13');
    barrier('composition-schema-before-activation');
    for (const proof of proofs) {
      const current = fileProof(proof.path);
      if (!sameFile(current.identity, proof.identity) || current.hash !== proof.hash) throw new StoreError('CORRUPT_STORE');
    }
    db.exec('COMMIT'); syncDirectory(root);
    barrier('composition-schema-after-activation');
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}

export function queueSchema(db: DatabaseSync, root: string, barrier: Barrier, quotaBytes?: string, fresh = false) {
  const capability = 'queue-outbox-sg1-v1';
  if (Number(db.prepare('PRAGMA user_version').get()!.user_version) >= 14) {
    const row = db.prepare('SELECT receipt FROM schema_migrations WHERE version=14').get();
    if (!row || JSON.parse(String(row.receipt)).capability !== capability) throw new StoreError('CORRUPT_STORE');
    return;
  }
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(r=>String(r.name));
  const compatibleExecutable = '92688fb71a75870f0f9ad2d48c7b95e55c2581fc';
  const backup = fresh ? null : `schema13-backup-${randomUUID()}.sqlite`;
  const manifest: Record<string, unknown> = {};
  let backupHash: string | null = null;
  let manifestFile: string | null = null;
  const fileProof = (path: string) => {
    const identity = assertPrivate(path, false), input = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const hash = createHash('sha256'), block = Buffer.alloc(1048576);
    try {
      if (!sameFile(identity, fstatSync(input))) throw new StoreError('ROOT_UNSAFE');
      for (;;) { const n = readSync(input, block); if (!n) break; hash.update(block.subarray(0,n)); }
      const after = assertPrivate(path, false);
      if (!sameFile(identity, after) || identity.size !== after.size || identity.mtimeMs !== after.mtimeMs || identity.ctimeMs !== after.ctimeMs) throw new StoreError('ROOT_UNSAFE');
    } finally { closeSync(input); }
    return { path, identity, hash: `sha256:${hash.digest('hex')}` };
  };
  const proofs: ReturnType<typeof fileProof>[] = [];
  if (backup) {
    const size = BigInt(Number(db.prepare('PRAGMA page_count').get()!.page_count) * Number(db.prepare('PRAGMA page_size').get()!.page_size));
    const fs = statfsSync(root, { bigint: true }), required = size + (size+3n)/4n + 1073741824n + 67108864n;
    if (fs.bavail*fs.bsize < required || (fs.blocks-fs.bavail)*10n >= fs.blocks*9n ||
        (quotaBytes && inspectTree(root)+required > BigInt(quotaBytes))) throw new StoreError('CAPACITY');
    barrier('queue-schema-before-backup');
    const path = join(root, backup);
    closeSync(privateFile(path));
    db.prepare('VACUUM INTO ?').run(path); assertPrivate(path, false);
    barrier('queue-schema-backup-written');
    const saved = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    try {
      if (saved.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok' ||
          saved.prepare('PRAGMA user_version').get()!.user_version !== 13) throw new StoreError('CORRUPT_STORE');
      for (const table of tables) {
        const before = digest(db, table);
        if (canonical(before) !== canonical(digest(saved, table))) throw new StoreError('CORRUPT_STORE');
        manifest[table] = before;
      }
      const sql = (database: DatabaseSync) => database.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
      if (canonical(sql(db)) !== canonical(sql(saved))) throw new StoreError('CORRUPT_STORE');
      manifest.sqlite_schema = hashBytes(canonical(sql(saved)));
    } finally { saved.close(); }
    const fd = privateFile(path); try { fsyncSync(fd); } finally { closeSync(fd); }
    const proof = fileProof(path); proofs.push(proof); backupHash = proof.hash;
    manifestFile = `${backup}.manifest.json`;
    const out = privateFile(join(root, manifestFile));
    try {
      writeFileSync(out, canonical({ schemaVersion: 1, backup, backupHash, storageVersion: 13,
        compatibleExecutable, manifest,
        retainedDirectories: ['objects','staging','uploads','portable'],
        recovery: 'Copy the backup database and retained directories into a separate owner-only root. Use only the named compatible executable. Keep this root and all prior backups unchanged.' }));
      fsyncSync(out);
    } finally { closeSync(out); }
    proofs.push(fileProof(join(root, manifestFile)));
    syncDirectory(root);
    barrier('queue-schema-backup-verified');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    // No pending request, event, projection, receipt or root is transformed.
    for (const table of tables) if (backup && canonical(manifest[table]) !== canonical(digest(db, table))) throw new StoreError('CORRUPT_STORE');
    db.prepare('INSERT INTO schema_migrations VALUES (14,?)').run(canonical({ from:13, to:14, capability,
      strategy:'semantic-version-verified-backup-transactional-activation', backup, backupHash, manifestFile, manifest,
      rollback: backup ? { compatibleExecutable,  } : null }));
    db.exec(`CREATE TABLE queue_jobs (id TEXT PRIMARY KEY, json TEXT NOT NULL) STRICT;
      CREATE TABLE spend_sessions (id TEXT PRIMARY KEY, json TEXT NOT NULL) STRICT;
      CREATE TABLE queue_outbox (attempt_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, json TEXT NOT NULL) STRICT;
      CREATE TABLE queue_journal (seq INTEGER PRIMARY KEY, json TEXT NOT NULL) STRICT;
      CREATE TRIGGER queue_journal_update BEFORE UPDATE ON queue_journal BEGIN SELECT RAISE(ABORT,'immutable'); END;
      CREATE TRIGGER queue_journal_delete BEFORE DELETE ON queue_journal BEGIN SELECT RAISE(ABORT,'immutable'); END;
      PRAGMA user_version=14;`);
    barrier('queue-schema-before-activation');
    for (const proof of proofs) {
      const current = fileProof(proof.path);
      if (!sameFile(current.identity, proof.identity) || current.hash !== proof.hash) throw new StoreError('CORRUPT_STORE');
    }
    db.exec('COMMIT'); syncDirectory(root);
    barrier('queue-schema-after-activation');
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}

export function candidateSchema(db: DatabaseSync, root: string, barrier: Barrier, quotaBytes?: string, fresh = false) {
  const capability = 'retained-candidates-v1';
  if (Number(db.prepare('PRAGMA user_version').get()!.user_version) >= 15) {
    const row = db.prepare('SELECT receipt FROM schema_migrations WHERE version=15').get();
    if (!row || JSON.parse(String(row.receipt)).capability !== capability) throw new StoreError('CORRUPT_STORE');
    return;
  }
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(r=>String(r.name));
  const compatibleExecutable = '9764b03ae889ae2fe2cf5d38e9e8e66bd6cf2eb4';
  const backup = fresh ? null : `schema14-backup-${randomUUID()}.sqlite`;
  const manifest: Record<string, unknown> = {};
  let backupHash: string | null = null;
  let manifestFile: string | null = null;
  const fileProof = (path: string) => {
    const identity = assertPrivate(path, false), input = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const hash = createHash('sha256'), block = Buffer.alloc(1048576);
    try {
      if (!sameFile(identity, fstatSync(input))) throw new StoreError('ROOT_UNSAFE');
      for (;;) { const n = readSync(input, block); if (!n) break; hash.update(block.subarray(0,n)); }
      const after = assertPrivate(path, false);
      if (!sameFile(identity, after) || identity.size !== after.size || identity.mtimeMs !== after.mtimeMs || identity.ctimeMs !== after.ctimeMs) throw new StoreError('ROOT_UNSAFE');
    } finally { closeSync(input); }
    return { path, identity, hash: `sha256:${hash.digest('hex')}` };
  };
  const proofs: ReturnType<typeof fileProof>[] = [];
  if (backup) {
    const size = BigInt(Number(db.prepare('PRAGMA page_count').get()!.page_count) * Number(db.prepare('PRAGMA page_size').get()!.page_size));
    const fs = statfsSync(root, { bigint: true }), required = size + (size+3n)/4n + 1073741824n + 67108864n;
    if (fs.bavail*fs.bsize < required || (fs.blocks-fs.bavail)*10n >= fs.blocks*9n ||
        (quotaBytes && inspectTree(root)+required > BigInt(quotaBytes))) throw new StoreError('CAPACITY');
    barrier('candidate-schema-before-backup');
    const path = join(root, backup);
    closeSync(privateFile(path));
    db.prepare('VACUUM INTO ?').run(path); assertPrivate(path, false);
    barrier('candidate-schema-backup-written');
    const saved = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    try {
      if (saved.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok' ||
          saved.prepare('PRAGMA user_version').get()!.user_version !== 14) throw new StoreError('CORRUPT_STORE');
      for (const table of tables) {
        const before = digest(db, table);
        if (canonical(before) !== canonical(digest(saved, table))) throw new StoreError('CORRUPT_STORE');
        manifest[table] = before;
      }
      const sql = (database: DatabaseSync) => database.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
      if (canonical(sql(db)) !== canonical(sql(saved))) throw new StoreError('CORRUPT_STORE');
      manifest.sqlite_schema = hashBytes(canonical(sql(saved)));
    } finally { saved.close(); }
    const fd = privateFile(path); try { fsyncSync(fd); } finally { closeSync(fd); }
    const proof = fileProof(path); proofs.push(proof); backupHash = proof.hash;
    manifestFile = `${backup}.manifest.json`;
    const out = privateFile(join(root, manifestFile));
    try {
      writeFileSync(out, canonical({ schemaVersion: 1, backup, backupHash, storageVersion: 14,
        compatibleExecutable, manifest,
        retainedDirectories: ['objects','staging','uploads','portable','backend-transport'],
        recovery: 'Copy the backup database and retained directories into a separate owner-only root. Use only the named compatible executable. Keep this root and all prior backups unchanged.' }));
      fsyncSync(out);
    } finally { closeSync(out); }
    proofs.push(fileProof(join(root, manifestFile)));
    syncDirectory(root);
    barrier('candidate-schema-backup-verified');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    // No pending request, event, projection, receipt or root is transformed.
    for (const table of tables) if (backup && canonical(manifest[table]) !== canonical(digest(db, table))) throw new StoreError('CORRUPT_STORE');
    db.prepare('INSERT INTO schema_migrations VALUES (15,?)').run(canonical({ from:14, to:15, capability,
      strategy:'semantic-version-verified-backup-transactional-activation', backup, backupHash, manifestFile, manifest,
      rollback: backup ? { compatibleExecutable,  } : null }));
    db.exec(`CREATE TABLE candidate_document_tombstones (document_id TEXT PRIMARY KEY, generation TEXT NOT NULL) STRICT;
      CREATE TABLE candidate_jobs (job_id TEXT PRIMARY KEY, json TEXT NOT NULL) STRICT;
      CREATE TABLE candidates (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, job_id TEXT NOT NULL, json TEXT NOT NULL) STRICT;
      CREATE TABLE candidate_private (id TEXT PRIMARY KEY, json TEXT NOT NULL) STRICT;
      CREATE TABLE candidate_journal (seq INTEGER PRIMARY KEY, family TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL) STRICT;
      CREATE TRIGGER candidate_journal_update BEFORE UPDATE ON candidate_journal BEGIN SELECT RAISE(ABORT,'immutable'); END;
      CREATE TRIGGER candidate_journal_delete BEFORE DELETE ON candidate_journal BEGIN SELECT RAISE(ABORT,'immutable'); END;
      PRAGMA user_version=15;`);
    barrier('candidate-schema-before-activation');
    for (const proof of proofs) {
      const current = fileProof(proof.path);
      if (!sameFile(current.identity, proof.identity) || current.hash !== proof.hash) throw new StoreError('CORRUPT_STORE');
    }
    db.exec('COMMIT'); syncDirectory(root);
    barrier('candidate-schema-after-activation');
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}

export function deletionSchema(db: DatabaseSync, root: string, barrier: Barrier, quotaBytes?: string, fresh = false) {
  const capability = 'recovery-deletion-v1';
  if (Number(db.prepare('PRAGMA user_version').get()!.user_version) >= 16) {
    const row = db.prepare('SELECT receipt FROM schema_migrations WHERE version=16').get();
    if (!row || JSON.parse(String(row.receipt)).capability !== capability) throw new StoreError('CORRUPT_STORE');
    return;
  }
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(r=>String(r.name));
  const compatibleExecutable = '086c9a677512f1faae98f9e947084ffb93c09431';
  const backup = fresh ? null : `schema15-backup-${randomUUID()}.sqlite`;
  const manifest: Record<string, unknown> = {};
  let backupHash: string | null = null;
  let manifestFile: string | null = null;
  const fileProof = (path: string) => {
    const identity = assertPrivate(path, false), input = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const hash = createHash('sha256'), block = Buffer.alloc(1048576);
    try {
      if (!sameFile(identity, fstatSync(input))) throw new StoreError('ROOT_UNSAFE');
      for (;;) { const n = readSync(input, block); if (!n) break; hash.update(block.subarray(0,n)); }
      const after = assertPrivate(path, false);
      if (!sameFile(identity, after) || identity.size !== after.size || identity.mtimeMs !== after.mtimeMs || identity.ctimeMs !== after.ctimeMs) throw new StoreError('ROOT_UNSAFE');
    } finally { closeSync(input); }
    return { path, identity, hash: `sha256:${hash.digest('hex')}` };
  };
  const proofs: ReturnType<typeof fileProof>[] = [];
  if (backup) {
    const size = BigInt(Number(db.prepare('PRAGMA page_count').get()!.page_count) * Number(db.prepare('PRAGMA page_size').get()!.page_size));
    const fs = statfsSync(root, { bigint: true }), required = size + (size+3n)/4n + 1073741824n + 67108864n;
    if (fs.bavail*fs.bsize < required || (fs.blocks-fs.bavail)*10n >= fs.blocks*9n ||
        (quotaBytes && inspectTree(root)+required > BigInt(quotaBytes))) throw new StoreError('CAPACITY');
    barrier('deletion-schema-before-backup');
    const path = join(root, backup);
    closeSync(privateFile(path));
    db.prepare('VACUUM INTO ?').run(path); assertPrivate(path, false);
    barrier('deletion-schema-backup-written');
    const saved = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    try {
      if (saved.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok' ||
          saved.prepare('PRAGMA user_version').get()!.user_version !== 15) throw new StoreError('CORRUPT_STORE');
      for (const table of tables) {
        const before = digest(db, table);
        if (canonical(before) !== canonical(digest(saved, table))) throw new StoreError('CORRUPT_STORE');
        manifest[table] = before;
      }
      const sql = (database: DatabaseSync) => database.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
      if (canonical(sql(db)) !== canonical(sql(saved))) throw new StoreError('CORRUPT_STORE');
      manifest.sqlite_schema = hashBytes(canonical(sql(saved)));
    } finally { saved.close(); }
    const fd = privateFile(path); try { fsyncSync(fd); } finally { closeSync(fd); }
    const proof = fileProof(path); proofs.push(proof); backupHash = proof.hash;
    manifestFile = `${backup}.manifest.json`;
    const out = privateFile(join(root, manifestFile));
    try {
      writeFileSync(out, canonical({ schemaVersion: 1, backup, backupHash, storageVersion: 15,
        compatibleExecutable, manifest,
        retainedDirectories: ['objects','staging','uploads','portable','backend-transport'],
        recovery: 'Copy the backup database and retained directories into a separate owner-only root. Use only the named compatible executable. Keep this root and all prior backups unchanged.' }));
      fsyncSync(out);
    } finally { closeSync(out); }
    proofs.push(fileProof(join(root, manifestFile)));
    syncDirectory(root);
    barrier('deletion-schema-backup-verified');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    // No pending request, event, projection, receipt or root is transformed.
    for (const table of tables) if (backup && canonical(manifest[table]) !== canonical(digest(db, table))) throw new StoreError('CORRUPT_STORE');
    db.prepare('INSERT INTO schema_migrations VALUES (16,?)').run(canonical({ from:15, to:16, capability,
      strategy:'semantic-version-verified-backup-transactional-activation', backup, backupHash, manifestFile, manifest,
      rollback: backup ? { compatibleExecutable,  } : null }));
    db.exec(`CREATE TABLE deletion_plans (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, client_id TEXT NOT NULL, json TEXT NOT NULL, owners TEXT NOT NULL) STRICT;
      CREATE TABLE deletion_receipts (document_id TEXT PRIMARY KEY, json TEXT NOT NULL) STRICT;
      CREATE TABLE deletion_objects (document_id TEXT NOT NULL, hash TEXT NOT NULL, byte_length TEXT NOT NULL, media_type TEXT NOT NULL, state TEXT NOT NULL, generation TEXT NOT NULL, PRIMARY KEY(document_id,hash)) STRICT;
      CREATE TABLE deletion_backup_files (path TEXT PRIMARY KEY) STRICT;
      CREATE TABLE deletion_work (path TEXT PRIMARY KEY, document_id TEXT NOT NULL) STRICT;
      CREATE TABLE deletion_files (document_id TEXT NOT NULL,path TEXT NOT NULL,bytes TEXT NOT NULL,hash TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(document_id,path)) STRICT;
      CREATE TABLE deletion_backup_pins (hash TEXT PRIMARY KEY) STRICT;
      INSERT INTO deletion_backup_pins SELECT DISTINCT hash FROM roots WHERE 0;
      PRAGMA user_version=16;`);
    if(backup){db.exec('INSERT OR IGNORE INTO deletion_backup_pins SELECT DISTINCT hash FROM roots');try{for(const name of readdirSync(join(root,'backend-transport')))db.prepare('INSERT INTO deletion_backup_files VALUES (?)').run(join(root,'backend-transport',name));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
    barrier('deletion-schema-before-activation');
    for (const proof of proofs) {
      const current = fileProof(proof.path);
      if (!sameFile(current.identity, proof.identity) || current.hash !== proof.hash) throw new StoreError('CORRUPT_STORE');
    }
    db.exec('COMMIT'); syncDirectory(root);
    barrier('deletion-schema-after-activation');
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}
