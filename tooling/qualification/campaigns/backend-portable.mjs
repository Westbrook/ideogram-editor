// C10 / I12C use the production writer and PF-1 reader. Fixture preparation and
// reset are explicit phases; imports consume their own presealed archive.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const MiB = 1024 * 1024;
const HASH = /^(?:sha256:)?[a-f0-9]{64}$/;
const decimal = value => /^(0|[1-9][0-9]*)$/.test(String(value));
const hashText = value => String(value).replace(/^sha256:/, '');
const failure = (code, message) => Object.assign(Error(message), { code });
const required = (condition, message) => { if (!condition) throw failure('FIXTURE_REQUIRED', message); };
const encode = value => Buffer.from(JSON.stringify(value));
const pause = () => new Promise(resolve => setTimeout(resolve, 2));
const checkSignal = signal => { if (signal?.aborted) throw signal.reason ?? failure('ABORTED', 'Portable campaign was aborted'); };
const RETAINED_SESSION = Symbol('owned-portable-warm-session');

export const PORTABLE_FAULTS = Object.freeze(['missing-closure', 'font-restriction', 'hash-mismatch', 'disk-pressure', 'interruption']);
export const PORTABLE_WORKLOADS = Object.freeze({
  WC512: { closureBytes: String(512 * MiB), events: 10000, assets: 1000, captionVersions: 1 },
  WC4G: { closureBytes: String(4 * 1024 * MiB), events: 100000, assets: 10000, captionVersions: 4096 },
});

export function safeRelative(path) {
  return typeof path === 'string' && path.length > 0 && !isAbsolute(path) && !path.includes('\\') &&
    path.split('/').every(part => part && part !== '.' && part !== '..');
}

export function validateSeal(seal, workload) {
  const expected = PORTABLE_WORKLOADS[workload];
  required(expected, `Unknown WC workload ${workload}`);
  required(seal?.schemaVersion === 1 && seal.kind === 'ideogram-wc-fixture' && seal.workload === workload, 'Expected a sealed WC fixture of the selected size');
  required(typeof seal.documentId === 'string' && /^[A-Za-z0-9_-]+$/.test(seal.documentId), 'WC document identity is missing');
  required(seal.counts?.closureBytes === expected.closureBytes && seal.counts.events === expected.events && seal.counts.assets === expected.assets,
    'WC must contain the exact measured bytes, event count, and asset count; a small fixture is not a substitute');
  required(Number.isSafeInteger(seal.counts.captionVersions) && seal.counts.captionVersions >= expected.captionVersions, 'WC caption version closure is incomplete');
  if (workload === 'WC4G') required(seal.counts.captionVersions === 4096, 'WC4G requires exactly 4096 retained reviewed caption versions');
  for (const name of ['originals', 'retainedCandidates', 'rawCaptions', 'derivedCaptions', 'editableText', 'licensedFonts', 'frozenLayouts', 'contributions', 'adapters']) {
    required(Array.isArray(seal.features?.[name]) && seal.features[name].length > 0 && seal.features[name].every(HASH.test.bind(HASH)), `WC ${name} evidence is missing`);
  }
  required(seal.archive && safeRelative(seal.archive.path) && HASH.test(seal.archive.sha256) && decimal(seal.archive.byteLength) && BigInt(seal.archive.byteLength) > 0n,
    'WC requires its own presealed archive, with full length and hash');
  required(Array.isArray(seal.files) && seal.files.length > 0, 'WC requires a complete immutable source file manifest');
  const paths = new Set();
  for (const file of seal.files) {
    required(safeRelative(file.path) && !paths.has(file.path) && HASH.test(file.sha256) && decimal(file.byteLength), 'Unsafe, duplicate, or incomplete WC file entry');
    paths.add(file.path);
  }
  required(paths.has('metadata.sqlite') && !paths.has('metadata.sqlite-wal') && !paths.has('metadata.sqlite-shm'), 'Seal a clean, closed writer root with no live SQLite WAL');
  required(seal.failureTarget === undefined || HASH.test(seal.failureTarget), 'Fault target must be a sealed object hash');
  if (seal.failureTarget) required(seal.files.some(file => file.path === 'objects/sha256/' + hashText(seal.failureTarget).slice(0, 2) + '/' + hashText(seal.failureTarget)), 'Fault target must belong to the sealed root');
  return seal;
}

export async function fileIdentity(path, signal) {
  checkSignal(signal);
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw failure('FIXTURE_IDENTITY', `Expected a regular non-symlink file: ${path}`);
  const sha = createHash('sha256'); let bytes = 0n;
  for await (const chunk of createReadStream(path, { flags: constants.O_RDONLY | constants.O_NOFOLLOW, highWaterMark: MiB })) {
    checkSignal(signal); sha.update(chunk); bytes += BigInt(chunk.length);
  }
  const after = await lstat(path);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes !== BigInt(after.size)) {
    throw failure('FIXTURE_IDENTITY', `File changed during verification: ${path}`);
  }
  return { sha256: sha.digest('hex'), byteLength: String(bytes) };
}

async function checkFile(path, identity, signal) {
  const actual = await fileIdentity(path, signal);
  assert.equal(actual.sha256, hashText(identity.sha256), `SHA-256 mismatch: ${path}`);
  assert.equal(actual.byteLength, String(identity.byteLength), `Length mismatch: ${path}`);
  return actual;
}

async function listFiles(root, directory = '') {
  const out = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw failure('FIXTURE_IDENTITY', `Symlink in WC root: ${path}`);
    if (entry.isDirectory()) out.push(...await listFiles(root, path));
    else if (entry.isFile()) out.push(path);
    else throw failure('FIXTURE_IDENTITY', `Nonregular entry in WC root: ${path}`);
  }
  return out.sort();
}

export async function loadFixture(fixture, workload, signal) {
  const declaredSeal = fixture?.portableSeal ?? fixture?.seal;
  required(fixture?.root && declaredSeal?.path && HASH.test(declaredSeal?.sha256), 'Supply a sealed WC writer root and its manifest SHA-256');
  const path = resolve(declaredSeal.path);
  const info = await lstat(path);
  required(info.isFile() && info.size <= 16 * MiB, 'WC seal must be a bounded ordinary JSON file');
  const bytes = await readFile(path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), hashText(declaredSeal.sha256), 'WC seal hash mismatch');
  const seal = validateSeal(JSON.parse(bytes), workload), root = await realpath(fixture.root);
  assert.deepEqual(await listFiles(root), seal.files.map(file => file.path).sort(), 'WC root contains missing or unsealed files');
  for (const file of seal.files) await checkFile(join(root, file.path), file, signal);
  const archive = resolve(dirname(path), seal.archive.path);
  assert(relative(dirname(path), archive) !== '..' && !relative(dirname(path), archive).startsWith('..' + sep));
  await checkFile(archive, seal.archive, signal);
  return { root, archive, seal, sealPath: path, sealIdentity: hashText(declaredSeal.sha256) };
}

async function cloneRoot(fixture, target, signal) {
  await mkdir(target, { mode: 0o700 });
  for (const file of fixture.seal.files) {
    checkSignal(signal);
    const destination = join(target, file.path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    // Reflink is optional, but hard links are forbidden: each fault/run owns bytes.
    await copyFile(join(fixture.root, file.path), destination, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
    await checkFile(destination, file, signal);
  }
}

export async function productFor(repo) {
  const module = path => import(pathToFileURL(join(repo, 'dist/local', path)).href);
  const [writer, zip, format, closure, protocol] = await Promise.all([
    module('server/storage/writer.js'), module('server/portable/zip.js'), module('server/portable/format.js'),
    module('server/portable/closure.js'), module('src/protocol/store.js'),
  ]);
  return { ...writer, ...zip, ...format, ...closure, ...protocol };
}

function command(product, auth, body, document = null) {
  return { protocolVersion: 1, command: { schemaVersion: 1, commandId: randomUUID(), clientId: auth.clientId,
    sessionId: 'wc_campaign', correlationId: randomUUID(), causationId: null, transactionId: randomUUID(),
    documentId: document?.id ?? null, expectedDocumentRevision: document?.revision ?? null,
    expectedEntityVersions: product.EMPTY_EXPECTED_VERSIONS, issuedAt: new Date().toISOString(), body } };
}

async function terminal(writer, value, auth, signal, allowWaiting = false) {
  let receipt = await writer.portableCommand(encode(value), auth);
  while (!receipt) {
    checkSignal(signal);
    const state = await writer.commandState(value.command.commandId);
    receipt = state.record?.receipt;
    if (!receipt && allowWaiting) {
      const inventory = await writer.portableInventory('', auth);
      const item = inventory.items.find(item => item.commandId === value.command.commandId);
      if (item?.phase === 'waiting-for-resources') return { waiting: item };
    }
    if (!receipt) await pause();
  }
  return receipt;
}

async function receiptEvent(writer, receipt) {
  assert.equal(receipt.status, 'accepted', JSON.stringify(receipt));
  const events = (await writer.events(String(BigInt(receipt.fromSeq) - 1n))).events;
  const event = events.find(event => event.commandId === receipt.commandId);
  assert(event, 'Accepted portable command has its durable event');
  return event;
}

async function stageArchive(writer, archive, identity, auth, signal) {
  const stagingId = randomUUID();
  await writer.assetCreate({ protocolVersion: 1, stagingId, purpose: 'bundle', expectedBytes: identity.byteLength,
    sha256: 'sha256:' + hashText(identity.sha256), mediaType: 'application/x-ideogram-project' }, auth);
  let offset = 0;
  for await (const bytes of createReadStream(archive, { highWaterMark: MiB, flags: constants.O_RDONLY | constants.O_NOFOLLOW })) {
    checkSignal(signal);
    const token = await writer.assetBeginChunk(stagingId, String(offset), bytes.length, auth);
    try { await writer.assetChunk(token, bytes, auth); } catch (error) { await writer.assetAbortChunk(token).catch(() => {}); throw error; }
    offset += bytes.length;
  }
  assert.equal(String(offset), identity.byteLength);
  return { stagingId, expectedSha256: 'sha256:' + hashText(identity.sha256) };
}

export async function verifyArchive(product, path, output, seal, signal, owned = null) {
  const db = product.spool(join(output, `archive-check-${randomUUID()}.sqlite`));
  const zip = new product.ZipIndex(path, db), check = () => checkSignal(signal);
  const ownedDatabase = owned ? new DatabaseSync(join(owned.root, 'metadata.sqlite'), { readOnly: true }) : null;
  try {
    await zip.headers(check); await zip.hashes(check);
    const manifest = await product.decodeRecords(zip, db, check);
    assert.equal(manifest.unsupported, undefined);
    assert.equal(manifest.complete, true);
    const read = async ref => {
      assert(BigInt(ref.byteLength) <= 8n * BigInt(MiB), 'Portable validation metadata is bounded');
      const parts = [];
      for await (const bytes of zip.chunks(zip.entry('objects/' + ref.hash.slice(7)), check)) parts.push(bytes);
      return Buffer.concat(parts);
    };
    const document = await product.validateClosure(db, read, check, manifest.formatVersion >= 4, manifest.formatVersion >= 5,
      manifest.formatVersion >= 6, manifest.formatVersion >= 7, manifest.formatVersion >= 9);
    assert.equal(document.id, seal.documentId, 'Archive document matches its sealed source identity');
    const assets = db.prepare("SELECT count(*) n FROM entities WHERE kind='asset'").get().n;
    const events = db.prepare('SELECT count(*) n FROM events').get().n;
    let manifestBytes = zip.entry('manifest.json').bytes;
    for (const row of db.prepare("SELECT bytes FROM zip_entries WHERE name LIKE 'records/%'").iterate()) manifestBytes += BigInt(row.bytes);
    assert(manifestBytes <= 128n * BigInt(MiB), 'WC logical manifest/index remains inside its stated 128MiB fixture envelope');
    let closureBytes = 0n;
    for (const ref of db.prepare('SELECT hash,bytes FROM refs').iterate()) {
      closureBytes += BigInt(ref.bytes);
      if (owned) {
        const hash = hashText(ref.hash);
        assert(ownedDatabase.prepare('SELECT 1 FROM roots WHERE owner=? AND hash=?').get('namespace:' + owned.namespaceId, ref.hash), 'Imported namespace owns every original closure object');
        await checkFile(join(owned.root, 'objects/sha256', hash.slice(0, 2), hash), { sha256: hash, byteLength: ref.bytes }, signal);
      }
    }
    assert.equal(events, seal.counts.events, 'Every source event is retained');
    assert.equal(assets, seal.counts.assets, 'Every source asset is retained');
    assert.equal(String(closureBytes), seal.counts.closureBytes, 'Exact WC closure byte count');
    for (const hashes of Object.values(seal.features)) for (const hash of hashes) {
      assert(db.prepare('SELECT 1 FROM refs WHERE hash=?').get('sha256:' + hashText(hash)), `Required retained feature root ${hash}`);
    }
    const { archiveFeatureEvidence } = await import('./fixture-portable.mjs');
    const typed = await archiveFeatureEvidence(db, read, { seal });
    return { documentId: document.id, events, assets, closureBytes: String(closureBytes), manifestBytes: String(manifestBytes), formatVersion: manifest.formatVersion,
      archiveEntries: db.prepare('SELECT count(*) n FROM zip_entries').get().n, fullHashesVerified: true, semanticClosureVerified: true,
      ownedClosureHashesVerified: owned !== null, typedFeaturesVerified: typed.typedFeaturesVerified, captionVersions: typed.captionVersions };
  } finally { zip.close(); db.close(); ownedDatabase?.close(); }
}

async function verifyImportedState(writer, fixture, sourceDocument, review, auth) {
  const document = await writer.document(review.documentId);
  assert(document && document.id !== sourceDocument.id);
  const mappings = {};
  for (const kind of ['layer', 'asset', 'history', 'branch', 'checkpoint']) {
    mappings[kind] = new Map(); let after = '';
    do {
      const page = await writer.bundleMapping(review.reviewId, kind, after, auth);
      for (const item of page.items) mappings[kind].set(item.sourceId, item.localId);
      after = page.next ?? '';
    } while (after);
  }
  const mapped = (kind, id) => { if (id === null) return null; const value = mappings[kind].get(id); assert(value, `Imported ${kind} mapping exists for ${id}`); return value; };
  assert.equal(document.width, sourceDocument.width); assert.equal(document.height, sourceDocument.height);
  assert.equal(document.color, sourceDocument.color); assert.equal(document.depth, sourceDocument.depth);
  assert.deepEqual(document.orderedLayerIds, sourceDocument.orderedLayerIds.map(id => mapped('layer', id)));
  assert.equal(document.historyHead, mapped('history', sourceDocument.historyHead));
  assert.equal(document.branchId, mapped('branch', sourceDocument.branchId));
  assert.equal(document.checkpoint, mapped('checkpoint', sourceDocument.checkpoint));
  if (sourceDocument.image) {
    const ref = sourceDocument.image.state, hash = hashText(ref.hash);
    const sourceState = JSON.parse(await readFile(join(fixture.root, 'objects/sha256', hash.slice(0, 2), hash), 'utf8'));
    const expected = { ...sourceState, layers: sourceState.layers.map(layer => ({ ...layer, id: mapped('layer', layer.id),
      assetId: mapped('asset', layer.assetId), mask: layer.mask ? { ...layer.mask, assetId: mapped('asset', layer.mask.assetId) } : null })) };
    if (expected.schemaVersion === 5 && expected.composition) expected.composition = { ...expected.composition,
      bindings: Object.fromEntries(Object.entries(expected.composition.bindings).map(([key, id]) => [key, mapped('layer', id)])) };
    assert.deepEqual(await writer.imageState(document.id), expected, 'Editable native text, current composition, placement, masks and order survive the reviewed namespace mapping');
    assert.equal(document.image.compositeAssetId, mapped('asset', sourceDocument.image.compositeAssetId));
  }
  return document;
}

function decodeCell(cell) {
  const operation = String(cell.operation ?? cell.id);
  const selectedDirection = cell.parameters?.direction ?? operation;
  const direction = /import/.test(selectedDirection) ? 'import' : /copy|export/.test(selectedDirection) ? 'copy' : null;
  const fault = cell.parameters?.fault ?? cell.parameters?.scenario ?? PORTABLE_FAULTS.find(name => operation.includes(name)) ?? null;
  const closureBytes = cell.parameters?.closureBytes;
  if (closureBytes !== undefined) required(['536870912', '4294967296'].includes(String(closureBytes)), 'Portable closureBytes must select exactly 512MiB or 4GiB');
  const workload = String(closureBytes) === '4294967296' || cell.workload === 'WC4G' || /4g|4GiB|stress/.test(cell.workload ?? '') ? 'WC4G' : 'WC512';
  required(direction, `Unknown portable direction: ${operation}`);
  required(!fault || PORTABLE_FAULTS.includes(fault), `Unknown portable fault: ${fault}`);
  return { direction, fault, workload };
}

async function mutantArchive(product, path, output, kind, targetHash, signal) {
  const src = product.spool(join(output, 'mutation-source.sqlite')), zip = new product.ZipIndex(path, src), check = () => checkSignal(signal);
  const destination = join(output, 'fault-input.zip');
  try {
    await zip.headers(check); await zip.hashes(check);
    const name = 'objects/' + hashText(targetHash), target = zip.entry(name);
    assert(target.bytes > 0n);
    if (kind === 'hash-mismatch') {
      await copyFile(path, destination, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
      const fd = await open(destination, 'r+');
      try { const b = Buffer.alloc(1); await fd.read(b, 0, 1, Number(target.offset)); b[0] ^= 1; await fd.write(b, 0, 1, Number(target.offset)); await fd.sync(); } finally { await fd.close(); }
    } else {
      const dst = product.spool(join(output, 'mutation-destination.sqlite'));
      try {
        await product.writeZip(destination, dst, (async function* () {
          for (const row of src.prepare('SELECT name FROM zip_entries ORDER BY length(offset),offset').iterate()) {
            if (row.name === name) continue;
            const entry = zip.entry(row.name);
            yield { ...entry, chunks: () => zip.chunks(entry, check) };
          }
        })(), check);
      } finally { dst.close(); }
    }
    return { path: destination, ...await fileIdentity(destination, signal), mutation: { kind, targetHash: 'sha256:' + hashText(targetHash) } };
  } finally { zip.close(); src.close(); }
}

async function sourceState(writer, documentId) {
  return { document: await writer.document(documentId), queue: await writer.queueView(), provider: await writer.providerView() };
}

function publicationCounts(root) {
  const db = new DatabaseSync(join(root, 'metadata.sqlite'), { readOnly: true });
  try { return { bundles: db.prepare('SELECT count(*) n FROM portable_bundles').get().n, namespaces: db.prepare('SELECT count(*) n FROM portable_namespaces').get().n }; }
  finally { db.close(); }
}

function retainedInventory(root) {
  const db = new DatabaseSync(join(root, 'metadata.sqlite'), { readOnly: true });
  try {
    const count = table => db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
    let rootedBytes = 0n;
    for (const row of db.prepare('SELECT DISTINCT o.hash,o.byte_length FROM objects o JOIN roots r ON r.hash=o.hash').iterate()) rootedBytes += BigInt(row.byte_length);
    return { bundles: count('portable_bundles'), reviews: count('portable_reviews'), stagingRecords: count('staged_assets'),
      namespaces: count('portable_namespaces'), commands: count('commands'), events: count('events_v2'), rootedBytes: String(rootedBytes) };
  } finally { db.close(); }
}

function sameCell(left, right) {
  return JSON.stringify(decodeCell(left)) === JSON.stringify(decodeCell(right));
}

/** One actual writer owner for the whole warm cohort. The first unscored prime
 * opens it; later starts use that same worker/epoch. Public retained publications
 * are measured and disclosed, never removed by SQL or filesystem shortcuts. */
export async function createPortableFixture(context, cell) {
  const selected = structuredClone(cell), identity = decodeCell(selected);
  const base = { ...context, fixture: context.fixture ? structuredClone(context.fixture) : undefined };
  const session = { id: randomUUID(), identity, initialized: false, closed: false, running: false, requiresReset: false,
    starts: 0, resets: 0, importedDocuments: new Set(), globalBefore: null, globalAfter: null, writer: undefined };
  const ensureCell = candidate => {
    if (session.closed) throw failure('CLOSED', 'Retained portable fixture is closed');
    if (!sameCell(selected, candidate)) throw failure('PORTABLE_COHORT_CHANGED', 'A retained portable writer belongs to one direction, size and fault cell');
    if (session.running) throw failure('PORTABLE_COHORT_BUSY', 'Portable warm starts and public cleanup must be serial');
  };
  async function resetCell(candidate = selected, sample) {
    ensureCell(candidate); session.running = true;
    const started = performance.now(), evidence = [], observations = [];
    try {
      checkSignal(base.signal);
      if (!session.initialized) return { status: 'pass', phases: [], assertions: ['No previous portable start requires cleanup'], observations: [], evidence: [], missing: [], sample };
      if (identity.fault && session.starts) {
        return { status: 'inconclusive', phases: [], assertions: [], observations: [], evidence: [],
          missing: ['Fault cells own one correctness start; repeating mutated or restarted state needs a separately declared recovery cell.'] };
      }
      assert(session.writer?.available, 'Retained writer remains available');
      const writer = session.writer, epoch = writer.epoch;
      for (const documentId of [...session.importedDocuments]) {
        const document = await writer.document(documentId);
        if (document) {
          const preview = command(session.product, session.auth, { type: 'PreviewDocumentDeletion', documentId, expectedRevision: document.revision });
          const previewReceipt = await writer.queueCommand(encode(preview), session.auth);
          assert.equal(previewReceipt.status, 'accepted', JSON.stringify(previewReceipt));
          const plan = (await writer.deletionView(documentId, session.auth)).plan;
          assert(plan && plan.documentId === documentId);
          assert.equal(plan.unresolvedAttempts.length, 0, 'Imported historic providers are inert and need no remote cancellation acknowledgement');
          const remove = command(session.product, session.auth, { type: 'DeleteDocument', documentId, planId: plan.id, planHash: plan.planHash,
            expectedRevision: plan.documentRevision, rootGeneration: plan.rootGeneration, acknowledgeRunningAndUncertain: false });
          const deleted = await writer.queueCommand(encode(remove), session.auth);
          assert.equal(deleted.status, 'accepted', JSON.stringify(deleted));
          evidence.push({ kind: 'public-import-reset', documentId, previewReceipt, deleteReceipt: deleted });
        }
        const collect = command(session.product, session.auth, { type: 'CollectDocumentGarbage', documentId });
        const collected = await writer.queueCommand(encode(collect), session.auth);
        assert.equal(collected.status, 'accepted', JSON.stringify(collected));
        const deletion = (await writer.deletionView(documentId, session.auth)).receipt;
        assert.equal(await writer.document(documentId), null, 'The previous imported document is absent before the next import');
        evidence.push({ kind: 'public-import-garbage-collection', documentId, receipt: collected, deletion });
        if (deletion?.status !== 'cleanup-complete') observations.push({ kind: 'retained-cleanup-pending', documentId, deletion });
        session.importedDocuments.delete(documentId);
      }
      if (identity.direction === 'copy') assert.deepEqual(await writer.document(session.fixture.seal.documentId), session.sourceDocument, 'Warm copy retains the exact WC source document');
      assert.equal(writer.epoch, epoch, 'Public reset keeps the same writer ownership and worker epoch');
      session.globalAfter = retainedInventory(session.root);
      observations.push({ kind: 'portable-global-retention', before: session.globalBefore, after: session.globalAfter,
        reason: 'Public APIs retain SaveCopy bundles, upload records, reviews, namespace tombstones and audit history; these are not silently erased between warm starts.' });
      session.requiresReset = false; session.resets++;
      const ms = performance.now() - started;
      return { status: 'pass', phases: [{ id: 'portable.public-reset', name: 'portable.public-reset', ms, durationMs: ms, status: 'pass', outcome: 'completed' }],
        assertions: ['Reset uses public commands and retains one writer epoch'], observations, evidence, missing: [],
        qualification: { status: 'inconclusive', inconclusive: true, reasons: ['Global retained publications and audit records accumulate during this cohort.'] } };
    } finally { session.running = false; }
  }
  return {
    portable: true,
    resetCell,
    async runCell(nextContext = {}, candidate = selected) {
      ensureCell(candidate);
      if (session.requiresReset) throw failure('PORTABLE_RESET_REQUIRED', 'Run public resetCell before another warm start');
      session.running = true;
      try {
        return await runCell({ ...base, ...nextContext, repo: base.repo, fixture: base.fixture, [RETAINED_SESSION]: session }, candidate);
      } finally { session.running = false; session.requiresReset = session.initialized; }
    },
    async close() {
      if (session.closed) return;
      if (session.running) throw failure('PORTABLE_COHORT_BUSY', 'Await the active portable operation before closing its owner');
      session.closed = true; const writer = session.writer; session.writer = undefined;
      await writer?.close();
    },
  };
}

function assertClosedFixtureReset(db) {
  // Relocating an active preparation or GC intent could leave absolute paths
  // pointing at the original root. A fixture is a closed, quiescent specimen.
  for (const table of ['asset_preparations', 'raster_preparations', 'history_preparations', 'portable_preparations', 'deletion_work', 'deletion_files']) {
    const exists = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table);
    if (exists) required(db.prepare(`SELECT count(*) n FROM ${table}`).get().n === 0, `WC reset requires no active ${table} rows or absolute retained cleanup paths`);
  }
}

// Uses the existing no-network writer harness: the only child is the actual
// production writer, killed at a durable preparation barrier rather than a timer.
async function crashWriter(repo, root, signal, barrierPhase) {
  const child = fork(join(repo, 'tests/store/process-fixture.mjs'), [root, JSON.stringify({ phase: barrierPhase })], {
    execArgv: ['--import', join(repo, 'tests/store/no-network.mjs')], serialization: 'advanced',
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let sequence = 0, stderr = '', exited = false;
  const waiting = new Map(), messages = new Map(), pending = new Map();
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-8192); });
  child.on('message', message => {
    if (message.id !== undefined) {
      const pair = pending.get(message.id); if (!pair) return; pending.delete(message.id);
      if (message.type === 'error') pair.reject(failure(message.code, message.message)); else pair.resolve(message.result);
    } else if (waiting.has(message.type)) { waiting.get(message.type)(message); waiting.delete(message.type); }
    else messages.set(message.type, message);
  });
  const exit = new Promise(resolve => child.once('exit', (code, signal) => {
    exited = true; for (const pair of pending.values()) pair.reject(failure('WRITER_KILLED', 'Writer exited at the injected interruption')); pending.clear(); resolve({ code, signal });
  }));
  const abort = () => child.kill('SIGKILL'); signal?.addEventListener('abort', abort, { once: true });
  const wait = type => {
    if (messages.has(type)) return Promise.resolve(messages.get(type));
    return Promise.race([new Promise(resolve => waiting.set(type, resolve)), exit.then(() => { throw failure('WRITER_EXITED', stderr); })]);
  };
  const call = (method, ...args) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); child.send({ id, method, args }, error => { if (error) { pending.delete(id); reject(error); } });
  });
  try { await Promise.race([wait('ready'), wait('startup-error').then(message => { throw failure(message.code, 'Interrupted writer startup failed'); })]); }
  catch (error) { if (!exited) child.kill('SIGKILL'); await exit; signal?.removeEventListener('abort', abort); throw error; }
  return { call, wait, async kill() { if (!exited) child.kill('SIGKILL'); const result = await exit; signal?.removeEventListener('abort', abort); return result; } };
}

export async function runCell(context, cell) {
  const phases = [], evidence = [], assertions = [], observations = [];
  const phase = async (id, fn) => {
    const start = performance.now();
    try { const result = await fn(); const ms = performance.now() - start; phases.push({ id, name: id, ms, durationMs: ms, status: 'pass', outcome: 'completed' }); return result; }
    catch (error) { const ms = performance.now() - start; phases.push({ id, name: id, ms, durationMs: ms, status: 'fail', outcome: 'failed', code: error.code ?? null }); throw error; }
  };
  let writer, copied, fixture, before, auth, product, commandValue, sourceDocument, priorPublications;
  const { repo, output, signal } = context;
  const retained = context[RETAINED_SESSION];
  try {
    const { direction, fault, workload } = decodeCell(cell);
    required(globalThis.__storeNetworkCounters?.shared, 'Run portable campaign workers with tests/store/no-network.mjs, inherited by every writer worker');
    assert(Object.values(globalThis.__storeNetworkCounters.read()).every(value => value === 0), 'No earlier network attempts');
    await mkdir(output, { recursive: true, mode: 0o700 });
    let targetRoot;
    if (retained?.initialized) {
      ({ fixture, product, sourceDocument, auth, writer } = retained); targetRoot = retained.root;
      assert(writer?.available, 'Warm portable writer owner remains live');
      assert.equal(writer.epoch, retained.epoch, 'Warm starts preserve the actual writer worker epoch');
      evidence.push({ kind: 'retained-writer-start', cohortId: retained.id, ordinal: retained.starts + 1, writerEpoch: writer.epoch, root: targetRoot });
    } else {
      fixture = await phase('fixture-seal-verify', () => loadFixture(context.fixture, workload, signal));
      product = await productFor(repo);
      if (fault) await phase('fault-baseline-full-closure-verification', () => verifyArchive(product, fixture.archive, output, fixture.seal, signal));
      const sourceDatabase = new DatabaseSync(join(fixture.root, 'metadata.sqlite'), { readOnly: true });
      try {
        if (direction === 'copy') assertClosedFixtureReset(sourceDatabase);
        sourceDocument = JSON.parse((sourceDatabase.prepare('SELECT json FROM documents WHERE id=?').get(fixture.seal.documentId) ?? sourceDatabase.prepare("SELECT json FROM portable_rows WHERE kind='document' AND id=?").get(fixture.seal.documentId))?.json ?? 'null');
      } finally { sourceDatabase.close(); }
      assert(sourceDocument, 'Sealed fixture retains its source document');
      targetRoot = join(output, 'owned-root');
      await phase('owned-root-reset', () => direction === 'copy' ? cloneRoot(fixture, targetRoot, signal) : mkdir(targetRoot, { mode: 0o700 }));
      auth = { clientId: 'wc_campaign', sessionHash: createHash('sha256').update(randomUUID()).digest('hex'), now: Date.now(), expires: Date.now() + 3_600_000 };
      writer = await product.openWriter({ root: targetRoot }, { effectCounters: globalThis.__storeNetworkCounters.shared });
      await writer.protocolDefaults(); await writer.rememberClient(auth.sessionHash, auth.clientId, auth.expires);
      if (retained) Object.assign(retained, { initialized: true, fixture, product, sourceDocument, auth, writer, root: targetRoot,
        epoch: writer.epoch, globalBefore: retainedInventory(targetRoot) });
    }
    if (retained) retained.starts++;
    evidence.push({ kind: 'fixture-seal', sha256: fixture.sealIdentity, root: fixture.root, ownedRoot: targetRoot, archive: fixture.seal.archive });
    before = await sourceState(writer, fixture.seal.documentId);
    priorPublications = publicationCounts(targetRoot);
    if (direction === 'copy') assert.deepEqual(before.document, sourceDocument, 'Sealed WC document opens through the production writer');
    else assert.equal(before.document, null, 'Import destination has no live source document; imported namespace ownership is independently verified');
    let archive = { path: fixture.archive, ...fixture.seal.archive };
    archive.path = fixture.archive;
    let stage;
    const failureTarget = fixture.seal.failureTarget ?? fixture.seal.features.originals[0];
    if (fault === 'font-restriction') {
      // A byte flip under an old font hash would only exercise hash mismatch.
      const variant = fixture.seal.faults?.[`${direction}-font-restriction`];
      required(variant && variant.failure === 'FONT_EMBEDDING_RESTRICTED' && safeRelative(variant.path) && HASH.test(variant.sha256) && decimal(variant.byteLength),
        'Font restriction requires a separately sealed coherent font-restriction specimen; corrupt bytes are not that test');
      required(direction === 'import', 'Export font restriction needs a coherent retained restricted-font writer fixture, which cannot be replaced by corrupting an accepted font');
      const path = resolve(dirname(fixture.sealPath), variant.path);
      await phase('fault-fixture-verify', () => checkFile(path, variant, signal));
      archive = { ...variant, path };
    }
    if (fault && ['missing-closure', 'hash-mismatch'].includes(fault)) {
      if (direction === 'copy') await phase('inject-owned-root-fault', async () => {
        const hash = hashText(failureTarget), path = join(targetRoot, 'objects/sha256', hash.slice(0, 2), hash);
        if (fault === 'missing-closure') await unlink(path);
        else { const fd = await open(path, 'r+'); try { const b = Buffer.alloc(1); assert.equal((await fd.read(b, 0, 1, 0)).bytesRead, 1); b[0] ^= 1; await fd.write(b, 0, 1, 0); await fd.sync(); } finally { await fd.close(); } }
        evidence.push({ kind: 'injected-owned-object-fault', fault, hash });
      });
      else archive = await phase('inject-owned-archive-fault', () => mutantArchive(product, fixture.archive, output, fault, failureTarget, signal));
    }
    if (fault === 'disk-pressure') {
      // Stage first so this is export/import admission pressure, not upload pressure.
      if (direction === 'import') stage = await phase('input-staging-before-pressure', () => stageArchive(writer, archive.path, archive, auth, signal));
      await writer.close(); writer = await product.openWriter({ root: targetRoot, quotaBytes: '1' }, { effectCounters: globalThis.__storeNetworkCounters.shared });
      observations.push({ fault: 'disk-pressure', mechanism: 'production quota reservation', quotaBytes: '1', filesystemENOSPC: false });
    }
    if (fault === 'interruption') {
      if (direction === 'import') stage = await phase('input-staging-before-interruption', () => stageArchive(writer, archive.path, archive, auth, signal));
      await writer.close(); writer = undefined;
      await phase('interrupted-preparation-and-recovery', async () => {
        const started = performance.now();
        const barrierPhase = direction === 'copy' ? 'portable-preparation-after-commit' : 'portable-import-after-proofs';
        const child = await crashWriter(repo, targetRoot, signal, barrierPhase);
        try {
          if (direction === 'import') {
            const remote = new Proxy({}, { get: (_target, method) => (...args) => child.call(method, ...args) });
            const preview = command(product, auth, { type: 'PreviewBundleImport', ...stage });
            const reviewed = await terminal(remote, preview, auth, signal);
            const event = await receiptEvent(remote, reviewed), review = await remote.bundleReview(event.payload.reviewId, auth);
            assert.equal(review.editable, true);
            commandValue = command(product, auth, { type: 'ImportBundle', reviewId: review.reviewId, reviewHash: review.reviewHash });
          } else commandValue = command(product, auth, { type: 'SaveCopy' }, before.document);
          const sent = child.call('portableCommand', encode(commandValue), auth); sent.catch(() => {});
          await child.wait('barrier');
          const effects = await child.call('effects');
          assert(Object.values(effects).every(value => value === 0), 'Interrupted writer and its worker made zero network attempts');
          const interrupted = await child.kill(); await sent.catch(() => {});
          assert.equal(interrupted.signal, 'SIGKILL');
          writer = await product.openWriter({ root: targetRoot }, { effectCounters: globalThis.__storeNetworkCounters.shared });
          assert.equal((await writer.commandState(commandValue.command.commandId)).record, null, 'No accepted receipt after interrupted preparation');
          assert.deepEqual((await sourceState(writer, fixture.seal.documentId)).document, before.document);
          assert.deepEqual(publicationCounts(targetRoot), priorPublications, 'Interrupted work published no bundle or imported namespace');
          const failureMs = performance.now() - started;
          assert(failureMs <= 30000, `Early interruption exceeded the I12C 30s cell allowance (${failureMs}ms)`);
          evidence.push({ kind: 'writer-interruption', phase: barrierPhase, signal: 'SIGKILL', commandId: commandValue.command.commandId, sourceReopened: true, networkEffects: effects, failureMs });
        } finally { await child.kill(); }
      });
      assertions.push('Durable preparation survives process interruption without a success receipt or source document loss');
    } else {
      let observedError, outcome;
      const started = performance.now();
      try {
        outcome = await phase(`project.${direction}`, async () => {
          if (direction === 'copy') {
            commandValue = command(product, auth, { type: 'SaveCopy' }, before.document);
            const receipt = await terminal(writer, commandValue, auth, signal, Boolean(fault));
            if (fault) return { receipt };
            const event = await receiptEvent(writer, receipt), bundle = event.payload.bundle;
            assert.equal(bundle.status, 'copy-ready'); assert.equal(bundle.complete, true);
            const hash = hashText(bundle.blob.hash), path = join(targetRoot, 'objects/sha256', hash.slice(0, 2), hash);
            await checkFile(path, { sha256: hash, byteLength: bundle.blob.byteLength }, signal);
            const closure = await verifyArchive(product, path, output, fixture.seal, signal);
            copied = { bundle, closure };
            return { receipt, bundle, closure };
          }
          stage ??= await stageArchive(writer, archive.path, archive, auth, signal);
          commandValue = command(product, auth, { type: 'PreviewBundleImport', ...stage });
          const previewReceipt = await terminal(writer, commandValue, auth, signal, Boolean(fault));
          if (previewReceipt.status !== 'accepted') return { receipt: previewReceipt };
          const event = await receiptEvent(writer, previewReceipt), review = await writer.bundleReview(event.payload.reviewId, auth);
          if (fault && !review.editable) return { review, receipt: previewReceipt };
          assert.equal(review.editable, true, JSON.stringify(review));
          assert.equal(review.eventCount, String(fixture.seal.counts.events));
          commandValue = command(product, auth, { type: 'ImportBundle', reviewId: review.reviewId, reviewHash: review.reviewHash });
          const receipt = await terminal(writer, commandValue, auth, signal, Boolean(fault));
          if (fault) return { receipt, review };
          const accepted = await receiptEvent(writer, receipt);
          retained?.importedDocuments.add(review.documentId);
          const document = await verifyImportedState(writer, fixture, sourceDocument, review, auth);
          assert.equal(accepted.type, 'BundleImported');
          const closure = await verifyArchive(product, archive.path, output, fixture.seal, signal, { root: targetRoot, namespaceId: review.namespaceId });
          return { receipt, review, importedDocumentId: document.id, closure };
        });
      } catch (error) { observedError = error; }
      if (fault) {
        const receipt = outcome?.receipt;
        const details = receipt?.details ? JSON.parse(Buffer.from(await writer.readMetadata(receipt.details)).toString('utf8')) : null;
        const detailCodes = details?.issues?.map(issue => issue.code) ?? [];
        const allowedDetails = {
          'missing-closure': direction === 'copy' ? ['PORTABLE_REQUIRED_OBJECT_MISSING', 'PORTABLE_MISSING_OBJECT'] : ['PORTABLE_INVALID_ARCHIVE'],
          'hash-mismatch': direction === 'copy' ? ['PORTABLE_CORRUPT_OBJECT'] : ['PORTABLE_INVALID_ARCHIVE', 'BUNDLE_SOURCE_CHANGED'],
          'disk-pressure': ['STORAGE_FULL', 'CAPACITY'],
          'font-restriction': ['FONT_EMBEDDING_RESTRICTED'],
        }[fault];
        const rejected = receipt?.status === 'rejected' && detailCodes.some(code => allowedDetails.includes(code)) ||
          receipt?.waiting?.phase === 'waiting-for-resources' && allowedDetails.includes(receipt.waiting.reason) ||
          outcome?.review?.editable === false && allowedDetails.includes(outcome.review.reason);
        const allowedErrors = fault === 'disk-pressure' ? ['STORAGE_FULL', 'CAPACITY'] : fault === 'missing-closure' && direction === 'copy' ? ['MISSING_OBJECT', 'MISSING_ASSET'] : fault === 'hash-mismatch' && direction === 'copy' ? ['CORRUPT_OBJECT'] : [];
        assert(rejected || observedError && allowedErrors.includes(observedError.code), `Fault did not yield the expected honest refusal: ${JSON.stringify({ outcome, error: observedError?.code })}`);
        if (fault === 'font-restriction') {
          assert(JSON.stringify(details).includes('FONT_EMBEDDING_RESTRICTED') || outcome?.review?.reason === 'FONT_EMBEDDING_RESTRICTED',
            'The font specimen must reach the actual embedding restriction check; a generic invalid archive is not this fault');
        }
        if (observedError && phases.at(-1)?.status === 'fail') {
          phases.at(-1).status = 'pass'; phases.at(-1).outcome = 'completed'; phases.at(-1).expectedFaultObserved = true;
        }
        const failureMs = performance.now() - started;
        assert(failureMs <= 30000, `Early failure exceeded the I12C 30s cell allowance (${failureMs}ms)`);
        observations.push({ fault, direction, failureMs, outcome, error: observedError ? { code: observedError.code, message: observedError.message } : null });
        assert.deepEqual(publicationCounts(targetRoot), priorPublications, 'Failed operation published no bundle or imported namespace');
        assertions.push('Injected fault cannot report a complete copy or atomically published import');
      } else {
        if (observedError) throw observedError;
        evidence.push({ kind: 'portable-operation', direction, ...outcome });
        assertions.push('Every archive entry hash, transaction, typed closure root, source event, and asset is verified');
      }
    }
    assert.deepEqual((await sourceState(writer, fixture.seal.documentId)).document, before.document, 'Original document preserved');
    assert.deepEqual(await writer.queueView(), before.queue, 'Historic provider jobs are not resubmitted');
    assert(Object.values(globalThis.__storeNetworkCounters.read()).every(value => value === 0), 'Zero remote calls or network attempts');
    if (!retained) { await writer.close(); writer = undefined; }
    await phase('sealed-source-preserved', async () => {
      for (const file of fixture.seal.files) await checkFile(join(fixture.root, file.path), file, signal);
      await checkFile(fixture.archive, fixture.seal.archive, signal);
    });
    assertions.push('Original sealed fixture bytes are unchanged', 'Zero provider/network effects', retained ? 'Warm starts reuse one actual writer owner and public reset' : 'Each cold operation owns an independent reset root');
    const result = { status: 'pass', phases, assertions, observations, evidence, missing: [], copied: copied ?? null };
    if (retained) {
      retained.globalAfter = retainedInventory(targetRoot);
      observations.push({ kind: 'retained-portable-cohort', cohortId: retained.id, ordinal: retained.starts, writerEpoch: writer.epoch,
        root: targetRoot, globalBefore: retained.globalBefore, globalAfter: retained.globalAfter,
        restartException: fault === 'interruption' || fault === 'disk-pressure',
        limitation: 'Publications, reviews, staged inputs and audit history remain public retained state; public cleanup cannot restore an identical global byte/count baseline.' });
      if (retained.starts > 1) result.qualification = { status: 'inconclusive', inconclusive: true,
        reasons: ['The writer is genuinely retained, but public retained global state accumulates between starts.'] };
    }
    const path = join(output, 'portable-receipt.json'); await writeFile(path, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return result;
  } catch (error) {
    return { status: error.code === 'FIXTURE_REQUIRED' || error.code === 'ENOENT' ? 'inconclusive' : 'fail', phases, assertions, observations, evidence,
      missing: error.code === 'FIXTURE_REQUIRED' || error.code === 'ENOENT' ? [error.message] : [], error: { code: error.code ?? null, message: error.message } };
  } finally {
    if (retained?.initialized) { retained.writer = writer; if (writer) retained.epoch = writer.epoch; }
    else await writer?.close().catch(() => {});
  }
}
