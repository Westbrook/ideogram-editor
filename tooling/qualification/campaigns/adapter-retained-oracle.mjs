// WA retained-byte observer. This module never opens a product writer, mutates
// SQLite, decodes tensor bytes, or retains a database/file reader between calls.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const CHUNK_BYTES = 1048576, METADATA_BYTES = 65536, MANIFEST_BYTES = 16 * CHUNK_BYTES;
const MAX_FILES = 100000, MAX_ROWS = 250000, MAX_TABLES = 96, MAX_OBJECT_BYTES = 16 * 1024 ** 3;
const SHA = /^sha256:[a-f0-9]{64}$/, ID = /^[A-Za-z0-9_-]{1,128}$/, DECIMAL = /^(0|[1-9][0-9]*)$/;
const MUTABLE_FILES = new Set(['metadata.sqlite', 'metadata.sqlite-wal', 'metadata.sqlite-shm', 'writer.lock']);
const REQUIRED_TABLES = ['meta', 'objects', 'roots', 'assets', 'asset_dependencies', 'documents', 'history', 'checkpoints', 'events', 'events_v2', 'commands'];
const KNOWN_TABLES = new Set((`meta objects commands events documents history checkpoints roots events_v2 snapshots snapshot_roots client_bindings read_releases schema_migrations
staged_assets transfer_reviews asset_preparations assets asset_dependencies raster_preparations raster_reviews history_preparations image_previews image_edit_reviews ui_checkpoints ui_events ui_receipts
portable_preparations portable_pins portable_bundles portable_reviews portable_namespaces portable_rows portable_quarantined_hashes portable_cancellations portable_review_sources portable_review_maps portable_maps text_admissions
queue_jobs spend_sessions queue_outbox queue_journal candidate_document_tombstones candidate_jobs candidates candidate_private candidate_journal deletion_plans deletion_receipts deletion_objects deletion_backup_files deletion_work deletion_files deletion_backup_pins candidate_adoption_evidence candidate_asset_evidence`).split(/\s+/));
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value && typeof value === 'object'
  ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
const digest = value => 'sha256:' + createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
const quote = name => '"' + name.replaceAll('"', '""') + '"';
const unchangedFile = (before, after) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => before[key] === after[key]);
const sameInode = (before, after) => before.dev === after.dev && before.ino === after.ino;
const mapDigest = map => digest([...map].sort(([left], [right]) => left.localeCompare(right)));
class CoverageError extends Error { constructor(message) { super(message); this.code = 'WA_RETAINED_COVERAGE'; } }
function requireProof(condition, message) { if (!condition) throw Object.assign(Error(message), { code: 'WA_RETAINED_MISMATCH' }); }
function bounded(condition, message) { if (!condition) throw new CoverageError(message); }
function fixturePath(root, name) {
  requireProof(typeof name === 'string' && name.length > 0 && !isAbsolute(name) && !name.includes('\\') && name.split('/').every(part => part && part !== '.' && part !== '..'), 'Unsafe sealed relative path.');
  const path = resolve(root, name); requireProof(path.startsWith(root + sep), 'Sealed file escapes its retained root.'); return path;
}
function knownImmutablePath(path) {
  return /^objects\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(path)
    || /^backend-transport\/[a-f0-9-]{36}\.(body|json)$/.test(path)
    || /^schema[0-9]+-backup-[a-f0-9-]{36}\.sqlite(?:\.manifest\.json)?$/.test(path)
    || /^(staging|uploads|raster-work|portable)\/[A-Za-z0-9_.\/-]+$/.test(path);
}

/** Every exposed count describes this observer's own handles, not product or
 * OS resources. A closed SQLite connection has no retained statement iterator. */
export async function createAdapterRetainedOracle({ repo, root, fixture, output, signal }) {
  const readers = { openFiles: 0, openDatabases: 0, openedFiles: 0, closedFiles: 0, openedDatabases: 0, closedDatabases: 0 };
  let closed = false, busy = false, baselineState = null, finalReceipt = null, ordinal = 0;
  const receipts = [], imported = new Map();
  const check = () => { signal?.throwIfAborted(); requireProof(!closed, 'Retained observer is closed.'); };
  const readerObservation = () => ({ ...readers, pendingObservation: busy, ownedReadersReleased: readers.openFiles === 0 && readers.openDatabases === 0 });

  async function fencedDirectory(path) {
    requireProof(typeof path === 'string' && isAbsolute(path) && resolve(path) === path, 'Observer requires a canonical absolute directory.');
    let current = parse(path).root;
    for (const component of relative(current, path).split(sep).filter(Boolean)) {
      current = join(current, component); const info = await lstat(current);
      requireProof(info.isDirectory() && !info.isSymbolicLink(), 'Retained directory contains a non-directory or symlink.');
    }
    requireProof(await realpath(path) === path, 'Retained directory resolves through an alias.');
  }
  async function regularFile(path) {
    await fencedDirectory(dirname(path)); const info = await lstat(path);
    requireProof(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && Number.isSafeInteger(info.size) && info.size >= 0, 'Retained input must be one ordinary bounded file.');
    return info;
  }
  async function openRead(path) {
    const before = await regularFile(path), file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    readers.openFiles++; readers.openedFiles++;
    try { requireProof(sameInode(before, await file.stat()), 'Retained input changed at reader acquisition.'); }
    catch (error) { await file.close(); readers.openFiles--; readers.closedFiles++; throw error; }
    return { file, before };
  }
  async function closeRead(file) { await file.close(); readers.openFiles--; readers.closedFiles++; }
  async function fileProof(path, expected = null, captureLimit = 0) {
    check(); const { file, before } = await openRead(path), hasher = createHash('sha256'), parts = [];
    let bytes = 0;
    try {
      bounded(before.size <= (captureLimit || MAX_OBJECT_BYTES), captureLimit ? 'A metadata or manifest input exceeds its explicit read bound.' : 'A retained file exceeds the 16 GiB observer file bound.');
      if (expected) requireProof(String(before.size) === String(expected.byteLength) && SHA.test(expected.sha256 ?? ''), 'Retained input length or seal is invalid.');
      const chunk = Buffer.alloc(CHUNK_BYTES);
      for (;;) {
        check(); const { bytesRead } = await file.read(chunk, 0, chunk.length, null); if (!bytesRead) break;
        bytes += bytesRead; requireProof(bytes <= before.size, 'Retained input grew while hashing.'); hasher.update(chunk.subarray(0, bytesRead));
        if (captureLimit) parts.push(Buffer.from(chunk.subarray(0, bytesRead)));
      }
      requireProof(bytes === before.size && unchangedFile(before, await file.stat()) && unchangedFile(before, await regularFile(path)), 'Retained input changed while hashing.');
      const value = { sha256: 'sha256:' + hasher.digest('hex'), byteLength: String(bytes) };
      if (expected) requireProof(value.sha256 === expected.sha256 && value.byteLength === String(expected.byteLength), 'Retained input content differs from its exact sealed identity.');
      return { ...value, ...(captureLimit ? { bytes: Buffer.concat(parts) } : {}) };
    } finally { await closeRead(file); }
  }
  async function treePaths(directory) {
    const paths = []; let directories = 0;
    async function walk(current, depth = 0) {
      bounded(++directories <= MAX_FILES && depth <= 64, 'Sealed tree exceeds the observer directory/depth bound.');
      check(); await fencedDirectory(current);
      const entries = await readdir(current, { withFileTypes: true });
      bounded(entries.length + paths.length <= MAX_FILES, 'Sealed tree exceeds the observer file-count bound.');
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(current, entry.name);
        requireProof(!entry.isSymbolicLink(), 'Retained tree contains a symlink.');
        if (entry.isDirectory()) await walk(path, depth + 1);
        else { requireProof(entry.isFile(), 'Retained tree contains an unsupported file type.'); paths.push(relative(directory, path).split(sep).join('/')); }
      }
    }
    await walk(directory); return paths.sort();
  }
  function addRef(refs, ref) {
    requireProof(ref && SHA.test(ref.hash ?? '') && typeof ref.byteLength === 'string' && DECIMAL.test(ref.byteLength) && typeof ref.mediaType === 'string' && ref.mediaType.length > 0 && ref.mediaType.length <= 256, 'Retained asset contains an invalid typed object reference.');
    bounded(BigInt(ref.byteLength) <= BigInt(MAX_OBJECT_BYTES), 'Referenced object exceeds the observer file bound.');
    const prior = refs.get(ref.hash); requireProof(!prior || prior.byteLength === ref.byteLength, 'One hash has conflicting retained object lengths.');
    bounded(prior || refs.size < MAX_FILES, 'Typed reference inventory exceeds the observer object-count bound.');
    refs.set(ref.hash, { hash: ref.hash, byteLength: ref.byteLength });
  }
  function assetReferences(value, refs) {
    const pending = [{ value, depth: 0 }]; let nodes = 0;
    while (pending.length) {
      const { value: next, depth } = pending.pop(); bounded(++nodes <= 8192 && depth <= 64, 'Asset metadata traversal exceeds its declared node/depth bound.');
      if (!next || typeof next !== 'object') continue;
      if (!Array.isArray(next) && Object.keys(next).sort().join(',') === 'byteLength,hash,mediaType') { addRef(refs, next); continue; }
      for (const child of Object.values(next)) pending.push({ value: child, depth: depth + 1 });
    }
  }
  async function metadataSnapshot(directory, requestedIds, missing) {
    check(); const path = join(directory, 'metadata.sqlite'), fence = await openRead(path); let db;
    try {
      // WAL/SHM bytes may change; a symlink is never accepted as an SQLite sidecar.
      for (const name of ['metadata.sqlite-wal', 'metadata.sqlite-shm']) {
        try { await regularFile(join(directory, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      db = new DatabaseSync(path, { readOnly: true, allowExtension: false, timeout: 250 }); readers.openDatabases++; readers.openedDatabases++;
      db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN;');
      requireProof(sameInode(fence.before, await regularFile(path)), 'SQLite file identity changed at snapshot acquisition.');
      const version = db.prepare('PRAGMA user_version').get().user_version;
      if (version !== 17) missing.push('The retained observer recognizes storage schema 17; another schema needs explicit coverage.');
      const schemaSize = db.prepare("SELECT count(*) AS count,max(length(type)+length(name)+length(tbl_name)+coalesce(length(CAST(sql AS BLOB)),0)) AS maximum FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get();
      bounded(schemaSize.count <= 1024 && (schemaSize.maximum ?? 0) <= METADATA_BYTES, 'SQLite schema metadata exceeds its explicit bound.');
      const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
      bounded(schema.length <= 1024 && schema.every(row => Buffer.byteLength(canonical(row)) <= METADATA_BYTES), 'SQLite schema metadata exceeds its explicit bound.');
      const tables = schema.filter(row => row.type === 'table').map(row => row.name);
      bounded(tables.length <= MAX_TABLES, 'SQLite table count exceeds its explicit bound.');
      for (const table of REQUIRED_TABLES) requireProof(tables.includes(table), 'A required retained metadata table is absent: ' + table);
      const rows = new Map(), objects = new Map(), assets = new Map(), refs = new Map(), adapterIds = [], counters = new Map(); let rowCount = 0;
      for (const table of tables) {
        check(); if (!KNOWN_TABLES.has(table)) missing.push('Unrecognized retained metadata table: ' + table);
        const columns = db.prepare('PRAGMA table_info(' + quote(table) + ')').all();
        bounded(columns.length > 0 && columns.length <= 32, 'SQLite row shape exceeds the observer column bound.');
        const size = columns.map(column => 'coalesce(length(CAST(' + quote(column.name) + ' AS BLOB)),0)').join('+');
        const summary = db.prepare('SELECT count(*) AS count,max(' + size + ') AS maximum FROM ' + quote(table)).get();
        bounded(Number.isSafeInteger(summary.count) && summary.count <= MAX_ROWS - rowCount && (summary.maximum ?? 0) <= METADATA_BYTES, 'Retained SQLite rows exceed the 250,000-row or 64 KiB row bound.');
        const tableRows = new Map(); rows.set(table, tableRows);
        for (const sourceRow of db.prepare('SELECT * FROM ' + quote(table)).iterate()) {
          check(); const row = { ...sourceRow }; rowCount++;
          bounded(Buffer.byteLength(canonical(row)) <= METADATA_BYTES, 'Canonical retained SQLite row exceeds 64 KiB.');
          if (table === 'meta' && ['writerEpoch', 'highWater'].includes(row.key)) {
            requireProof(typeof row.value === 'string' && DECIMAL.test(row.value), 'Mutable metadata counter is not an exact decimal.');
            counters.set(row.key, row.value); row.value = '<observed-monotonic-counter>';
          }
          const identity = digest(row); tableRows.set(identity, (tableRows.get(identity) ?? 0) + 1);
          if (table === 'objects') {
            requireProof(SHA.test(row.hash ?? '') && typeof row.byte_length === 'string' && DECIMAL.test(row.byte_length), 'Object catalog contains an invalid identity.');
            bounded(BigInt(row.byte_length) <= BigInt(MAX_OBJECT_BYTES) && objects.size < MAX_FILES, 'Object catalog exceeds an observer bound.');
            requireProof(!objects.has(row.hash), 'Object catalog contains duplicate identities.'); objects.set(row.hash, row.byte_length);
          }
          if (table === 'assets') {
            requireProof(typeof row.id === 'string' && ID.test(row.id) && typeof row.json === 'string', 'Asset metadata row has an invalid identity.');
            const asset = JSON.parse(row.json); requireProof(asset.id === row.id, 'Asset row and embedded identity disagree.');
            assetReferences(asset, refs);
            if (asset.qualification === 'adapter-version') { requireProof(asset.adapter?.id === row.id && asset.purpose === 'adapter', 'Adapter version binding is malformed.'); adapterIds.push(row.id); }
            if (requestedIds.has(row.id)) assets.set(row.id, { digest: digest(row.json), record: asset, refs: (() => { const found = new Map(); assetReferences(asset, found); return found; })() });
          }
        }
      }
      for (const name of ['writerEpoch', 'highWater']) requireProof(counters.has(name), 'Required monotonic metadata counter is absent.');
      // Imported adapter versions bind source asset IDs as well as BlobRefs.
      // Observe those bounded metadata bindings in this same read transaction.
      const pending = [...requestedIds], inspectedAssets = new Set();
      while (pending.length) {
        const id = pending.pop(); if (inspectedAssets.has(id)) continue;
        bounded(inspectedAssets.size < 256, 'Imported asset source closure exceeds 256 metadata records.'); inspectedAssets.add(id);
        if (!assets.has(id)) {
          const length = db.prepare('SELECT length(CAST(json AS BLOB)) AS bytes FROM assets WHERE id=?').get(id);
          requireProof(length, 'A referenced imported source asset is absent.'); bounded(length.bytes <= METADATA_BYTES, 'Imported source asset metadata exceeds 64 KiB.');
          const row = db.prepare('SELECT id,json FROM assets WHERE id=?').get(id), record = JSON.parse(row.json), refs = new Map();
          requireProof(record.id === id, 'Imported source asset identity disagrees with its row.'); assetReferences(record, refs);
          assets.set(id, { digest: digest(row.json), record, refs });
        }
        const asset = assets.get(id).record;
        for (const source of [...Object.values(asset.adapter?.sources ?? {}), ...(asset.raster?.sourceAssetIds ?? [])].filter(value => value !== null)) {
          requireProof(typeof source === 'string' && ID.test(source), 'Imported asset source identity is malformed.'); pending.push(source);
        }
      }
      for (const [hash, ref] of refs) requireProof(objects.get(hash) === ref.byteLength, 'A retained asset reference is absent from the exact object catalog.');
      for (const table of ['roots', 'asset_dependencies']) for (const row of db.prepare('SELECT hash FROM ' + quote(table)).iterate()) requireProof(objects.has(row.hash), 'A retained root or dependency has no catalog object.');
      requireProof(sameInode(fence.before, await fence.file.stat()) && sameInode(fence.before, await regularFile(path)), 'SQLite file identity changed during its read-only snapshot.');
      return { version, schemaDigest: digest(schema), rows, rowCount, objects, assets, adapterIds, counters,
        rowsDigest: digest([...rows].sort(([a], [b]) => a.localeCompare(b)).map(([table, values]) => [table, mapDigest(values)])) };
    } finally {
      try { if (db) { try { if (db.isTransaction) db.exec('ROLLBACK'); } finally { db.close(); readers.openDatabases--; readers.closedDatabases++; } } }
      finally { await closeRead(fence.file); }
    }
  }
  async function sealedMetadataSnapshot(sourceRoot, entries, missing) {
    // A readOnly WAL connection can still create sidecar files. Inspect a
    // private transient byte-identical SQL copy so the sealed source is never
    // opened by SQLite. Only our exclusively created directory is removed.
    const directory = join(output, '.wa-retained-readonly-' + randomUUID()); await mkdir(directory, { mode: 0o700 });
    try {
      for (const entry of entries) {
        const source = fixturePath(sourceRoot, entry.path), { file, before } = await openRead(source); let destination;
        try {
          requireProof(String(before.size) === String(entry.byteLength), 'Sealed SQLite source length changed before copying.');
          destination = await open(join(directory, entry.path), 'wx', 0o600);
          const hash = createHash('sha256'), buffer = Buffer.alloc(CHUNK_BYTES); let bytes = 0;
          for (;;) {
            check(); const { bytesRead } = await file.read(buffer, 0, buffer.length, null); if (!bytesRead) break;
            bytes += bytesRead; requireProof(bytes <= before.size, 'Sealed SQLite source grew while copying.'); hash.update(buffer.subarray(0, bytesRead));
            let offset = 0; while (offset < bytesRead) { const written = await destination.write(buffer, offset, bytesRead - offset, null); requireProof(written.bytesWritten > 0, 'Private SQLite copy write made no progress.'); offset += written.bytesWritten; }
          }
          await destination.sync();
          requireProof(String(bytes) === String(entry.byteLength) && 'sha256:' + hash.digest('hex') === entry.sha256 && unchangedFile(before, await file.stat()) && unchangedFile(before, await regularFile(source)), 'Sealed SQLite source changed during its bounded copy.');
        } finally { try { await destination?.close(); } finally { await closeRead(file); } }
        await fileProof(join(directory, entry.path), entry);
      }
      return await metadataSnapshot(directory, new Set(), missing);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  function preserveRows(original, current) {
    requireProof(original.version === current.version && original.schemaDigest === current.schemaDigest, 'Retained SQLite schema changed.');
    for (const [table, rows] of original.rows) {
      requireProof(current.rows.has(table), 'A retained metadata table disappeared.');
      for (const [hash, count] of rows) requireProof((current.rows.get(table).get(hash) ?? 0) >= count, 'A baseline retained metadata row was changed or removed from ' + table + '.');
    }
    for (const [name, value] of original.counters) requireProof(BigInt(current.counters.get(name)) >= BigInt(value), 'An observed metadata counter moved backwards.');
    for (const [hash, bytes] of original.objects) requireProof(current.objects.get(hash) === bytes, 'A baseline object catalog binding changed or disappeared.');
  }
  async function verifyFiles(state, missing) {
    const observed = new Map(); let corpusBytes = 0n, retainedBytes = 0n;
    for (const entry of state.immutable) {
      const proof = await fileProof(fixturePath(root, entry.path), entry); retainedBytes += BigInt(proof.byteLength);
      if (entry.path.startsWith('objects/sha256/')) observed.set(proof.sha256, proof.byteLength);
    }
    for (const [hash, bytes] of state.snapshot.objects) requireProof(observed.get(hash) === bytes, 'Complete baseline object catalog bytes were not proved.');
    for (const entry of state.corpus) { const proof = await fileProof(entry.path, entry); corpusBytes += BigInt(proof.byteLength); }
    return { observed, corpusBytes: String(corpusBytes), retainedBytes: String(retainedBytes) };
  }
  async function prepareBaseline(missing) {
    bounded(fixture?.seal && fixture?.manifestPath && fixture?.root && root && output, 'Sealed fixture, owned copy and output directory are required.');
    requireProof(SHA.test(fixture.seal.sha256 ?? '') && fixture.seal.path === fixture.manifestPath, 'Fixture manifest seal is invalid.');
    await fencedDirectory(root); await fencedDirectory(output); await fencedDirectory(fixture.root);
    requireProof(root !== fixture.root && !(root + sep).startsWith(fixture.root + sep) && !(output + sep).startsWith(fixture.root + sep), 'Observer output and working copy must not mutate the sealed source root.');
    requireProof(output !== root && !(output + sep).startsWith(root + sep), 'Observer output must remain outside the owned product root.');
    const manifestProof = await fileProof(fixture.manifestPath, null, MANIFEST_BYTES);
    requireProof(manifestProof.sha256 === fixture.seal.sha256, 'Fixture manifest differs from its separately retained seal.');
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestProof.bytes));
    requireProof(manifest.kind === 'sealed-performance-fixture' && manifest.version === 'perf-8-a3-corpus-2' && manifest.outcome === 'prepared' && manifest.observed?.productionValidated === true && manifest.workload === 'WA' && manifest.root === fixture.root && manifest.documentId === fixture.documentId, 'Fixture is not the exact completed WA source.');
    requireProof(manifest.store?.root === fixture.root && SHA.test(manifest.store?.sha256 ?? '') && Array.isArray(manifest.store.files), 'Complete sealed fixture store inventory is missing.');
    bounded(manifest.store.files.length <= MAX_FILES && Array.isArray(manifest.corpus?.files) && manifest.corpus.files.length <= MAX_FILES, 'Fixture inventory exceeds its explicit file bound.');
    requireProof(digest(JSON.stringify(manifest.store.files, null, 2) + '\n') === manifest.store.sha256, 'Fixture store inventory digest is inconsistent.');
    const immutable = [], names = new Set(), sourceSQLite = [];
    for (const entry of manifest.store.files) {
      requireProof(!names.has(entry.path), 'Sealed fixture contains duplicate file paths.'); names.add(entry.path);
      const path = fixturePath(fixture.root, entry.path); await fileProof(path, entry);
      if (MUTABLE_FILES.has(entry.path)) { if (entry.path.startsWith('metadata.sqlite')) sourceSQLite.push(entry); continue; }
      if (!knownImmutablePath(entry.path)) missing.push('An otherwise byte-verified sealed path has no reviewed immutable role: ' + entry.path);
      if (entry.path.startsWith('objects/sha256/')) requireProof(entry.path === 'objects/sha256/' + entry.sha256.slice(7, 9) + '/' + entry.sha256.slice(7), 'Sealed object path disagrees with its exact content hash.');
      if (entry.path.startsWith('backend-transport/') && entry.path.endsWith('.json')) bounded(Number(entry.byteLength) <= METADATA_BYTES, 'Retained transport sidecar exceeds 64 KiB.');
      immutable.push(entry);
    }
    requireProof(names.has('metadata.sqlite'), 'Sealed metadata database is absent.');
    requireProof(canonical(await treePaths(fixture.root)) === canonical([...names].sort()), 'Sealed source has unlisted or missing files.');
    const snapshot = await sealedMetadataSnapshot(fixture.root, sourceSQLite, missing);
    // Bind the SQLite snapshot to the same immutable source database/WAL bytes
    // verified above; no observer reader remains open during either full hash.
    for (const entry of sourceSQLite) await fileProof(fixturePath(fixture.root, entry.path), entry);
    requireProof(snapshot.adapterIds.length === 100 && manifest.definition?.metadataEntries === 100 && Array.isArray(manifest.adapterLibrary?.entries) && manifest.adapterLibrary.entries.length === 100, 'The complete sealed 100-version WA adapter library is absent.');
    requireProof(canonical([...snapshot.adapterIds].sort()) === canonical(manifest.adapterLibrary.entries.map(entry => entry.versionId).sort()), 'Sealed library versions differ from the complete retained asset inventory.');
    const corpus = manifest.corpus.files.map(entry => ({ path: entry.path, sha256: entry.sha256, byteLength: String(entry.byteLength) }));
    for (const entry of corpus) requireProof(typeof entry.path === 'string' && isAbsolute(entry.path) && SHA.test(entry.sha256 ?? '') && DECIMAL.test(entry.byteLength), 'Corpus source identity is malformed.');
    if (manifest.productReceipt) await fileProof(manifest.productReceipt.path, manifest.productReceipt);
    else missing.push('Sealed product preparation receipt is absent.');
    const state = { snapshot, immutable, corpus, missing: [...missing], fixtureSha256: fixture.seal.sha256, storeSha256: manifest.store.sha256, adapterVersions: snapshot.adapterIds.length };
    const current = await metadataSnapshot(root, new Set(), missing); preserveRows(snapshot, current); state.lastCounters = current.counters;
    const proved = await verifyFiles(state, missing); state.initialProof = proved;
    state.closureSha256 = digest({ fixture: state.fixtureSha256, store: state.storeSha256, rows: snapshot.rowsDigest, objects: mapDigest(snapshot.objects), immutable: immutable.map(entry => ({ path: entry.path, sha256: entry.sha256, byteLength: entry.byteLength })), corpus });
    return state;
  }
  async function verifyCheckpoint(ids, missing) {
    bounded(baselineState, 'A complete baseline observation must precede retained checkpoints.');
    const requested = new Set([...imported.keys(), ...ids]); bounded(requested.size <= 256, 'Imported adapter observation exceeds 256 asset identities.');
    const current = await metadataSnapshot(root, requested, missing); preserveRows(baselineState.snapshot, current);
    for (const [name, value] of baselineState.lastCounters) requireProof(BigInt(current.counters.get(name)) >= BigInt(value), 'An observed metadata counter moved backwards between checkpoints.');
    const proved = await verifyFiles(baselineState, missing), newlyObserved = new Map(imported), refs = new Map();
    for (const [id, asset] of current.assets) {
      const prior = imported.get(id); requireProof(!prior || prior.digest === asset.digest, 'An imported asset binding changed after its observed registration.');
      newlyObserved.set(id, { digest: asset.digest, refs: asset.refs });
      for (const [hash, ref] of asset.refs) { requireProof(current.objects.get(hash) === ref.byteLength, 'Imported asset dependency is absent from the exact current catalog.'); refs.set(hash, ref); }
    }
    let importedBytes = 0n;
    for (const [hash, ref] of refs) {
      if (!proved.observed.has(hash)) {
        const path = fixturePath(root, 'objects/sha256/' + hash.slice(7, 9) + '/' + hash.slice(7));
        const proof = await fileProof(path, { sha256: hash, byteLength: ref.byteLength }); proved.observed.set(hash, proof.byteLength); importedBytes += BigInt(proof.byteLength);
      }
      requireProof(proved.observed.get(hash) === ref.byteLength, 'Imported object bytes were not completely proved.');
    }
    const importedAssetBindings = [...newlyObserved].sort(([a], [b]) => a.localeCompare(b)).map(([id, value]) => ({ id, metadataSha256: value.digest,
      refs: [...value.refs.values()].sort((left, right) => left.hash.localeCompare(right.hash)).map(ref => ({ hash: ref.hash, byteLength: ref.byteLength })) }));
    bounded(Buffer.byteLength(JSON.stringify(importedAssetBindings)) <= METADATA_BYTES, 'Imported binding receipt exceeds its 64 KiB metadata bound.');
    imported.clear(); for (const [id, value] of newlyObserved) imported.set(id, value); baselineState.lastCounters = current.counters;
    return { ...proved, importedAssetBindings, importedBytes: String(importedBytes), importedObjects: refs.size, importedAssets: imported.size,
      importedBindingsSha256: digest([...imported].sort(([a], [b]) => a.localeCompare(b)).map(([id, value]) => [id, value.digest, mapDigest(value.refs)])) };
  }
  // Both public readers acquire busy before entering this shared read-only
  // transaction. The draft reader keeps that ownership while proving its blob.
  async function readImportedAssetOwned(id) {
    check();
    const path = join(root, 'metadata.sqlite'); let fence, db;
    try {
      fence = await openRead(path);
      for (const name of ['metadata.sqlite-wal', 'metadata.sqlite-shm']) { try { await regularFile(join(root, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
      db = new DatabaseSync(path, { readOnly: true, allowExtension: false, timeout: 250 }); readers.openDatabases++; readers.openedDatabases++;
      db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN;');
      const length = db.prepare('SELECT length(CAST(json AS BLOB)) AS bytes FROM assets WHERE id=?').get(id);
      requireProof(length, 'Imported asset metadata is absent.'); bounded(length.bytes <= METADATA_BYTES, 'Imported asset metadata exceeds 64 KiB.');
      const row = db.prepare('SELECT id,json FROM assets WHERE id=?').get(id), asset = JSON.parse(row.json);
      requireProof(asset.id === id && sameInode(fence.before, await fence.file.stat()) && sameInode(fence.before, await regularFile(path)), 'Imported asset or SQLite reader identity changed.');
      assetReferences(asset, new Map());
      // This bounded value is for the caller's binding assertion only. Proof
      // receipts/artifacts never include row contents, prompts or credentials.
      return asset;
    } finally {
      try { if (db) { try { if (db.isTransaction) db.exec('ROLLBACK'); } finally { db.close(); readers.openDatabases--; readers.closedDatabases++; } } }
      finally { if (fence) await closeRead(fence.file); }
    }
  }
  async function readImportedAsset(id) {
    check(); requireProof(!busy && typeof id === 'string' && ID.test(id), 'A valid imported asset ID and idle observer are required.'); busy = true;
    try { return await readImportedAssetOwned(id); } finally { busy = false; }
  }
  async function readRequestDraftReferences(assetId) {
    check(); requireProof(!busy && typeof assetId === 'string' && ID.test(assetId), 'A valid request draft asset ID and idle observer are required.'); busy = true;
    try {
      const asset = await readImportedAssetOwned(assetId), caption = asset.blob;
      requireProof(asset.purpose === 'caption' && asset.qualification === 'opaque-text' && asset.safety === 'safe' && asset.availability === 'available' &&
        caption && !Array.isArray(caption) && Object.keys(caption).sort().join(',') === 'byteLength,hash,mediaType' &&
        caption.mediaType === 'text/plain' && SHA.test(caption.hash ?? '') && typeof caption.byteLength === 'string' && DECIMAL.test(caption.byteLength), 'Request draft is not an available typed caption asset.');
      bounded(BigInt(caption.byteLength) <= BigInt(METADATA_BYTES), 'Request draft caption exceeds its 64 KiB projection bound.');
      const proof = await fileProof(fixturePath(root, 'objects/sha256/' + caption.hash.slice(7, 9) + '/' + caption.hash.slice(7)),
        { sha256: caption.hash, byteLength: caption.byteLength }, METADATA_BYTES);
      // fileProof verifies content hash, exact byte length, open-file inode and
      // path identity before these bounded bytes enter the JSON parser. Never
      // return the caption value or read/retain the referenced prompt text.
      let value;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(proof.bytes)); }
      catch { requireProof(false, 'Request draft caption is not bounded UTF-8 JSON.'); }
      const legacy = value?.kind === 'request-draft-1' && ['generate', 'instant', 'fast', 'transform', 'inpaint', 'generate-adapters', 'transform-adapters', 'inpaint-adapters'].includes(value.operation);
      const v45 = value?.kind === 'request-draft-v45-1' && ['generate-v45', 'transform-v45', 'inpaint-v45'].includes(value.operation);
      requireProof(value?.schemaVersion === 1 && (legacy || v45), 'Caption does not contain a recognized request draft family.');
      const prompt = value.prompt?.text;
      requireProof(prompt && !Array.isArray(prompt) && Object.keys(prompt).sort().join(',') === 'byteLength,hash,mediaType' &&
        SHA.test(prompt.hash ?? '') && typeof prompt.byteLength === 'string' && DECIMAL.test(prompt.byteLength) && prompt.mediaType === 'text/plain', 'Request draft prompt reference is malformed.');
      bounded(BigInt(prompt.byteLength) <= 16777216n, 'Request draft prompt reference exceeds the supported 16 MiB bound.');
      const after = await readImportedAssetOwned(assetId);
      requireProof(canonical(asset) === canonical(after), 'Request draft asset binding changed during its byte proof.');
      // This projects a recognized family's immutable reference, not full draft
      // validity; the actual accepted UI receipt and closure remain separate.
      return { assetId, kind: value.kind, schemaVersion: value.schemaVersion, caption: { hash: proof.sha256, byteLength: proof.byteLength },
        promptText: { hash: prompt.hash, byteLength: prompt.byteLength, mediaType: prompt.mediaType } };
    } finally { busy = false; }
  }
  async function observation(name, work) {
    check(); requireProof(!busy, 'Concurrent retained observations are not supported.'); busy = true;
    const startMs = performance.now(), missing = [...(baselineState?.missing ?? [])]; let status = 'PASS', value = null, error = null;
    try { value = await work(missing); if (missing.length) status = 'INCONCLUSIVE'; }
    catch (cause) {
      status = cause?.code === 'WA_RETAINED_COVERAGE' ? 'INCONCLUSIVE' : 'FAIL';
      if (status === 'INCONCLUSIVE') missing.push(cause.message);
      else error = { code: cause?.code === 'WA_RETAINED_MISMATCH' ? cause.code : 'WA_RETAINED_OBSERVATION_FAILED', message: cause?.code === 'WA_RETAINED_MISMATCH' ? cause.message : 'Retained observation failed; no content or raw database error is emitted.' };
    } finally { busy = false; }
    if (!readerObservation().ownedReadersReleased) { status = 'FAIL'; error = { code: 'WA_RETAINED_READER_LEAK', message: 'An observer-owned file or database reader was not released.' }; }
    const endMs = performance.now(), state = baselineState;
    const receipt = { kind: 'wa-retained-fixture-proof-1', ordinal: ++ordinal, name, status, complete: status === 'PASS',
      assertions: { durableFixturePreserved: status === 'PASS' ? true : status === 'FAIL' ? false : null },
      fixtureSha256: state?.fixtureSha256 ?? fixture?.seal?.sha256 ?? null, closureSha256: state?.closureSha256 ?? null,
      span: { name, startMs, endMs, durationMs: endMs - startMs, outcome: status === 'FAIL' ? 'failed' : status === 'PASS' ? 'expected' : 'unobserved', clock: 'runner-monotonic', chargedObserverWork: true },
      counts: { baselineRows: state?.snapshot.rowCount ?? null, baselineTables: state?.snapshot.rows.size ?? null, baselineObjects: state?.snapshot.objects.size ?? null, immutableFiles: state?.immutable.length ?? null, corpusFiles: state?.corpus.length ?? null, adapterVersions: state?.adapterVersions ?? null, importedAssets: value?.importedAssets ?? imported.size, importedObjects: value?.importedObjects ?? 0 },
      bytes: { retained: value?.retainedBytes ?? state?.initialProof?.retainedBytes ?? null, corpus: value?.corpusBytes ?? state?.initialProof?.corpusBytes ?? null, importedAdditional: value?.importedBytes ?? '0' },
      importedBindingsSha256: value?.importedBindingsSha256 ?? null, importedAssetBindings: value?.importedAssetBindings ?? [], readerObservation: readerObservation(), missing: [...new Set(missing)], error,
      scope: 'Every original fixture catalog object, preserved baseline metadata row, sealed immutable root file, corpus source file, and explicitly registered imported asset typed reference; additions are allowed.',
      mutableFileReplacement: { files: [...MUTABLE_FILES], metadata: 'Read-only consistent SQLite snapshot; every baseline row in every table retained, with only monotonic meta.writerEpoch/highWater value changes modeled.', sourceRead: 'Exact sealed SQLite bytes copied through 1 MiB buffers into an exclusively owned transient directory; readonly readers close before that directory is removed. The sealed original is never opened by SQLite.', writerLock: 'Writer ownership marker is mutable and is not retained product content.' },
      limits: { chunkBytes: CHUNK_BYTES, metadataBytes: METADATA_BYTES, manifestBytes: MANIFEST_BYTES, files: MAX_FILES, rows: MAX_ROWS, tables: MAX_TABLES, objectBytes: MAX_OBJECT_BYTES },
      contentsEmitted: false, tensorDecoding: false, productWriterOpened: false, observerWorkExcludedFromTiming: false };
    receipts.push(receipt);
    if (output) { await fencedDirectory(output); const path = join(output, 'wa-retained-' + String(ordinal).padStart(3, '0') + '-' + name + '.json'), serialized = JSON.stringify(receipt, null, 2) + '\n'; await writeFile(path, serialized, { flag: 'wx', mode: 0o600 }); receipt.artifact = { path, bytes: Buffer.byteLength(serialized), sha256: digest(serialized) }; }
    return receipt;
  }
  return {
    baseline() { return observation('baseline', async missing => { requireProof(!baselineState, 'Retained baseline is established only once.'); baselineState = await prepareBaseline(missing); return baselineState.initialProof; }); },
    checkpoint({ importedAssetIds = [] } = {}) { return observation('checkpoint', async missing => { requireProof(!finalReceipt, 'Retained series has already finalized.'); requireProof(Array.isArray(importedAssetIds) && importedAssetIds.every(id => typeof id === 'string' && ID.test(id)) && new Set(importedAssetIds).size === importedAssetIds.length, 'Imported asset identities are invalid or duplicated.'); return verifyCheckpoint(importedAssetIds, missing); }); },
    async completeSeries() { if (finalReceipt) return finalReceipt; finalReceipt = await observation('complete-series', missing => verifyCheckpoint([], missing)); return finalReceipt; },
    readerObservation, readImportedAsset, readRequestDraftReferences,
    close() { requireProof(!busy, 'Cannot close an active retained observation.'); closed = true; requireProof(readerObservation().ownedReadersReleased, 'Retained observer close found owned readers.'); baselineState = null; imported.clear(); return { closed: true, readerObservation: readerObservation(), observations: receipts.length }; },
  };
}
