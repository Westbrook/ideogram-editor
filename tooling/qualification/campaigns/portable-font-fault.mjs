// Explicit qualification preparation only. This module does not run a campaign,
// approve a restricted font, or publish an archive through the product writer.
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {constants, createReadStream} from 'node:fs';
import {lstat, mkdir, open, readFile, realpath, writeFile} from 'node:fs/promises';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';

export const FONT_FAULT_CONFIG = '.qualification-portable-font-fault.json';
export const FONT_FAULT_READY = '.qualification-portable-font-fault-ready.json';
const KIND = 'portable-font-negative-fixture-1', MiB = 1048576;
const DRAFT_TEXT = 'Qualification restricted-font negative draft';
const HEX = /^[a-f0-9]{64}$/, ID = /^[A-Za-z0-9_-]{1,128}$/, DECIMAL = /^(0|[1-9][0-9]*)$/;
const SOURCE_PATHS = Object.freeze([
  'src/protocol/text.ts', 'src/protocol/validate.ts', 'server/storage/writer.ts', 'server/storage/worker.ts',
  'server/storage/database.ts', 'server/storage/ui.ts', 'server/storage/portable.ts', 'server/storage/text.ts', 'server/storage/composition-memory.ts',
  'server/portable/format.ts', 'server/portable/closure.ts', 'server/portable/transactions.ts', 'server/text/font.ts',
  'dist/local/server/storage/writer.js', 'dist/local/server/storage/worker.js', 'dist/local/server/storage/database.js',
  'dist/local/server/storage/ui.js', 'dist/local/server/storage/portable.js', 'dist/local/server/storage/text.js',
  'dist/local/server/portable/format.js', 'dist/local/server/portable/closure.js', 'dist/local/server/portable/transactions.js',
  'dist/local/server/storage/composition-memory.js', 'dist/local/server/text/font.js', 'dist/local/server/text/worker.js',
  'dist/local/src/protocol/text.js', 'dist/local/src/protocol/validate.js',
]);
const HELPER_PATHS = ['portable-font-fault.mjs', 'portable-font-fault-setup.mjs'];
export const fontFaultCanonical = value => JSON.stringify(sort(value));
function sort(value) { if (Array.isArray(value)) return value.map(sort); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])); return value; }
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const bytesOf = value => Buffer.from(fontFaultCanonical(value));
const rawHash = value => String(value).replace(/^sha256:/, '');
const checkSignal = signal => signal?.throwIfAborted();
const keys = (value, expected) => { assert(value && typeof value === 'object' && !Array.isArray(value)); assert.deepEqual(Object.keys(value).sort(), [...expected].sort()); };
const equal = (a, b) => assert.equal(fontFaultCanonical(a), fontFaultCanonical(b));
const refFor = (bytes, mediaType) => ({hash: 'sha256:' + hash(bytes), byteLength: String(bytes.length), mediaType});
function ref(value) { keys(value, ['hash', 'byteLength', 'mediaType']); assert(/^sha256:[a-f0-9]{64}$/.test(value.hash)); assert(DECIMAL.test(value.byteLength) && BigInt(value.byteLength) > 0n); assert(['text/plain', 'application/octet-stream'].includes(value.mediaType)); }
function baselineValue(value) { return {...value, sealSha256: rawHash(value.sealSha256), archive: {...value.archive, sha256: rawHash(value.archive.sha256)}}; }
function baselineShape(value) {
  keys(value, ['sealSha256', 'documentId', 'archive', 'counts']); assert(HEX.test(value.sealSha256) && ID.test(value.documentId));
  keys(value.archive, ['sha256', 'byteLength']); assert(HEX.test(value.archive.sha256) && DECIMAL.test(value.archive.byteLength) && BigInt(value.archive.byteLength) > 0n);
  keys(value.counts, ['events', 'assets', 'closureBytes', 'captionVersions', ...(Object.hasOwn(value.counts, 'manifestBytes') ? ['manifestBytes'] : [])]); assert(typeof value.counts.closureBytes === 'string' && DECIMAL.test(value.counts.closureBytes));
  if (Object.hasOwn(value.counts, 'manifestBytes')) assert(typeof value.counts.manifestBytes === 'string' && DECIMAL.test(value.counts.manifestBytes));
  for (const key of ['events', 'assets', 'captionVersions']) assert(Number.isSafeInteger(value.counts[key]) && value.counts[key] >= 0);
}
function pin(value) { keys(value, ['path', 'sha256', 'byteLength']); assert(typeof value.path === 'string' && value.path && !isAbsolute(value.path) && !/[\\\x00-\x1f\x7f]/.test(value.path) && value.path.split('/').every(x => x && x !== '.' && x !== '..')); assert(HEX.test(value.sha256) && DECIMAL.test(value.byteLength)); }
function fontShape(value) {
  keys(value, ['schemaVersion', 'id', 'bytes', 'faceIndex', 'format', 'parserProfile', 'fsType', 'licenseRecord', 'origin', 'embedding']);
  assert(value.schemaVersion === 1 && value.faceIndex === 0 && value.format === 'static-ttf' && value.parserProfile === 'sfnt-static-1-freetype-canvaskit040');
  assert(value.fsType === 0 && value.origin === 'local-file' && value.embedding === 'permitted'); ref(value.bytes); ref(value.licenseRecord);
  const {id, ...body} = value; assert.equal(id, 'sha256:' + hash(bytesOf(body)));
}

/** Pure bounded admission. Actual files and source pins are checked separately.
 * `expected` binds trusted caller context; it never selects code or an oracle. */
function descriptorShape(value, expected = {}) {
  keys(value, ['kind', 'schemaVersion', 'negativeOnly', 'qualification', 'direction', 'repo', 'root', 'baseline', 'profile', 'sources', 'sourceFont', 'sourceLicense', 'mutation', 'clientId', 'sessionId', 'documentRevision', 'objects', 'alias', 'draftAsset', 'ui', 'staged', 'original', 'archive']);
  assert(value.kind === KIND && value.schemaVersion === 1 && value.negativeOnly === true && value.qualification === false);
  assert(['copy', 'import'].includes(value.direction)); baselineShape(value.baseline);
  for (const name of ['repo', 'root']) assert(typeof value[name] === 'string' && isAbsolute(value[name]) && resolve(value[name]) === value[name] && !/[\\\x00-\x1f\x7f]/.test(value[name]));
  assert(value.root !== value.repo); assert(ID.test(value.clientId) && ID.test(value.sessionId) && DECIMAL.test(value.documentRevision));
  pin(value.profile); assert.equal(value.profile.path, 'src/text/profile.json'); pin(value.sourceFont); pin(value.sourceLicense);
  assert.equal(value.sourceFont.path, 'vendor/text/fonts/NotoSans-Regular.ttf'); assert.equal(value.sourceLicense.path, 'vendor/text/notices/Noto-OFL.txt');
  assert(Array.isArray(value.sources)); const sourceNames = [...SOURCE_PATHS, ...HELPER_PATHS.map(x => 'tooling/qualification/campaigns/' + x)].sort();
  equal(value.sources.map(x => x.path), sourceNames); value.sources.forEach(pin);
  equal(value.mutation, {kind: 'sfnt-os2-fstype-2-checksum-1', actualFsType: 2, claimedFsType: 0});
  keys(value.objects, ['font', 'license', 'text', 'draft']); Object.values(value.objects).forEach(ref);
  assert(BigInt(value.objects.font.byteLength) <= 16n * BigInt(MiB)); assert(BigInt(value.objects.license.byteLength) <= 65536n);
  assert(BigInt(value.objects.text.byteLength) <= 16384n && BigInt(value.objects.draft.byteLength) <= 65536n);
  assert.equal(value.objects.font.mediaType, 'application/octet-stream');
  for (const name of ['license', 'text', 'draft']) assert.equal(value.objects[name].mediaType, 'text/plain');
  assert.equal(value.objects.font.byteLength, value.sourceFont.byteLength); assert.notEqual(rawHash(value.objects.font.hash), value.sourceFont.sha256);
  equal(value.objects.license, {hash: 'sha256:' + value.sourceLicense.sha256, byteLength: value.sourceLicense.byteLength, mediaType: 'text/plain'}); equal(value.objects.text, refFor(Buffer.from(DRAFT_TEXT), 'text/plain'));
  keys(value.alias, ['id', 'version', 'purpose', 'blob', 'dependencies', 'safety', 'availability', 'qualification', 'measuredMediaType', 'font']); fontShape(value.alias.font);
  assert(ID.test(value.alias.id) && value.alias.version === '1' && value.alias.purpose === 'font' && value.alias.safety === 'safe' && value.alias.availability === 'available' && value.alias.qualification === 'font' && value.alias.measuredMediaType === 'application/octet-stream');
  equal(value.alias.blob, value.objects.font); equal(value.alias.font.bytes, value.objects.font); equal(value.alias.font.licenseRecord, value.objects.license); equal(value.alias.dependencies, [value.objects.license]);
  equal(value.objects.draft, refFor(bytesOf({schemaVersion: 1, kind: 'text-draft-1', textUtf8: value.objects.text, style: {}, frame: {}, fonts: [value.alias.font]}), 'text/plain'));
  keys(value.draftAsset, ['id', 'version', 'purpose', 'blob', 'dependencies', 'safety', 'availability', 'qualification', 'measuredMediaType']);
  equal(value.draftAsset, {id: value.draftAsset.id, version: '1', purpose: 'caption', blob: value.objects.draft, dependencies: [], safety: 'safe', availability: 'available', qualification: 'opaque-text', measuredMediaType: 'text/plain'});
  assert(ID.test(value.draftAsset.id) && value.draftAsset.id !== value.alias.id);
  keys(value.ui, ['sessionId', 'uiSeq', 'preferences', 'drafts', 'reconciledLayerIds']);
  assert.equal(value.ui.sessionId, 'ui_' + hash(bytesOf([value.clientId, value.sessionId]))); assert.equal(value.ui.uiSeq, '1'); equal(value.ui.preferences, null); equal(value.ui.reconciledLayerIds, []);
  assert(Array.isArray(value.ui.drafts) && value.ui.drafts.length === 1); const draft = value.ui.drafts[0];
  equal(draft, {id: draft.id, generation: '1', kind: 'text', documentId: value.baseline.documentId, targetLayerId: null, expectedDocumentRevision: value.documentRevision, assetId: value.draftAsset.id, composing: false, status: 'saved-unapplied'}); assert(ID.test(draft.id));
  const originalTables = value.direction === 'copy' ? ROOT_TABLES.map(x => x[0]) : ['entities', 'events', 'transactions']; keys(value.original, originalTables);
  for (const item of Object.values(value.original)) { keys(item, ['count', 'sha256']); assert(Number.isSafeInteger(item.count) && item.count >= 0 && HEX.test(item.sha256)); }
  if (value.direction === 'copy') {
    assert.equal(value.archive, null); keys(value.staged, ['font', 'license', 'text', 'draft']);
    const stagedIds = new Set(); for (const name of ['font', 'license', 'text', 'draft']) { const item = value.staged[name]; keys(item, ['asset', 'commandId']); assert(ID.test(item.commandId) && ID.test(item.asset?.id)); assert(!stagedIds.has(item.asset.id) && item.asset.id !== value.alias.id); stagedIds.add(item.asset.id); equal(item.asset.blob, value.objects[name]); }
    equal(value.staged.draft.asset, value.draftAsset);
  } else { assert.equal(value.staged, null); keys(value.archive, ['path', 'sha256', 'byteLength']); assert(typeof value.archive.path === 'string' && value.archive.path.endsWith('/restricted-font-negative.zip') && !/[\\\x00-\x1f\x7f]/.test(value.archive.path)); assert(isAbsolute(value.archive.path) && resolve(value.archive.path) === value.archive.path && HEX.test(value.archive.sha256) && DECIMAL.test(value.archive.byteLength) && BigInt(value.archive.byteLength) > 0n); }
  for (const [key, bound] of Object.entries(expected)) { assert(['direction', 'baseline', 'root', 'repo', 'profile', 'sources'].includes(key)); equal(value[key], key === 'baseline' ? baselineValue(bound) : bound); }
  assert(Buffer.byteLength(fontFaultCanonical(value)) <= 32768); return value;
}
export function validateFontFaultDescriptor(value, expected = {}) {
  try { return descriptorShape(value, expected); } catch (error) { error.code = 'FIXTURE_REQUIRED'; throw error; }
}

export async function fontFaultPrivatePath(path, directory = false) {
  assert(isAbsolute(path) && resolve(path) === path && await realpath(path) === path, 'Fixture path must be direct and absolute');
  const stat = await lstat(path); assert(directory ? stat.isDirectory() : stat.isFile()); assert(!stat.isSymbolicLink() && (stat.mode & 0o077) === 0); if (!directory) assert.equal(stat.nlink, 1); return stat;
}
async function readBounded(path, maximum, privateFile = false) {
  const stat = privateFile ? await fontFaultPrivatePath(path) : await lstat(path); assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maximum);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { const now = await handle.stat(); assert.equal(now.ino, stat.ino); assert.equal(now.dev, stat.dev); const bytes = await handle.readFile(); assert.equal(bytes.length, stat.size); return bytes; } finally { await handle.close(); }
}
export async function fontFaultSourcePins(repo) {
  const pins = []; for (const path of SOURCE_PATHS) { const bytes = await readBounded(join(repo, path), 2 * MiB); pins.push({path, byteLength: String(bytes.length), sha256: hash(bytes)}); }
  for (const name of HELPER_PATHS) { const bytes = await readBounded(fileURLToPath(new URL(name, import.meta.url)), MiB); pins.push({path: 'tooling/qualification/campaigns/' + name, byteLength: String(bytes.length), sha256: hash(bytes)}); }
  return pins.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
export async function readFontFaultConfiguration(root) {
  await fontFaultPrivatePath(root, true); const bytes = await readBounded(join(root, FONT_FAULT_CONFIG), 65536, true), value = JSON.parse(bytes);
  keys(value, ['descriptor', 'sha256']); assert.equal(value.sha256, hash(bytesOf(value.descriptor))); validateFontFaultDescriptor(value.descriptor, {root, direction: 'copy'}); return value;
}
async function pinProfile(repo) { const path = 'src/text/profile.json', bytes = await readBounded(join(repo, path), MiB); return {value: JSON.parse(bytes), pin: {path, byteLength: String(bytes.length), sha256: hash(bytes)}}; }
export async function verifyFontFaultFiles(descriptor) {
  equal(await fontFaultSourcePins(descriptor.repo), descriptor.sources); const profile = await pinProfile(descriptor.repo); equal(profile.pin, descriptor.profile);
  const font = profile.value.fonts.find(f => f.id === 'NotoSans'); assert(font && 'vendor/text/' + font.file === descriptor.sourceFont.path && 'vendor/text/' + font.licenseFile === descriptor.sourceLicense.path);
  for (const item of [descriptor.sourceFont, descriptor.sourceLicense]) { const bytes = await readBounded(join(descriptor.repo, item.path), item === descriptor.sourceFont ? 16 * MiB : 65536); assert.equal(String(bytes.length), item.byteLength); assert.equal(hash(bytes), item.sha256); if (item === descriptor.sourceFont) equal(refFor(restrictedFont(bytes), 'application/octet-stream'), descriptor.objects.font); }
  assert.equal(font.sha256, descriptor.sourceFont.sha256); assert.equal(String(font.bytes), descriptor.sourceFont.byteLength); assert.equal(rawHash(font.licenseHash), descriptor.sourceLicense.sha256);
}
const ROOT_TABLES = Object.freeze([['events_v2', 'command_id', 'length(seq),seq'], ['commands', 'id', 'id'], ['assets', 'id', 'id'], ['asset_dependencies', 'asset_id', 'asset_id,hash'], ['documents', null, 'id'], ['history', null, 'id'], ['checkpoints', null, 'id'], ['queue_jobs', null, 'id']]);
export function fontFaultRootWitness(db, additions = {commands: [], assets: []}) {
  const out = {}; for (const [table, key, order] of ROOT_TABLES) { const excluded = key === 'command_id' || table === 'commands' ? additions.commands : key ? additions.assets : []; const where = excluded.length ? ` WHERE ${key} NOT IN (${excluded.map(() => '?').join(',')})` : ''; const h = createHash('sha256'); let count = 0; for (const row of db.prepare(`SELECT * FROM ${table}${where} ORDER BY ${order}`).iterate(...excluded)) { h.update(fontFaultCanonical(row) + '\n'); count++; } out[table] = {count, sha256: h.digest('hex')}; } return out;
}
function archiveWitness(db) { const out = {}; for (const [table, order] of [['entities', 'kind,id'], ['events', 'length(seq),seq'], ['transactions', 'archive,id']]) { let count = 0; const h = createHash('sha256'); const columns = table === 'entities' ? 'kind,id,json' : table === 'events' ? 'seq,tx,json' : 'archive,id,json'; for (const row of db.prepare(`SELECT ${columns} FROM ${table} ORDER BY ${order}`).iterate()) { h.update(fontFaultCanonical(row) + '\n'); count++; } out[table] = {count, sha256: h.digest('hex')}; } return out; }
function restrictedFont(bytes) {
  const out = Buffer.from(bytes), view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  assert(out.length >= 12); const tables = view.getUint16(4); assert(12 + tables * 16 <= out.length);
  const selected = new Map();
  for (let i = 0; i < tables; i++) {
    const at = 12 + i * 16, tag = out.toString('ascii', at, at + 4);
    if (tag !== 'OS/2' && tag !== 'head') continue;
    assert(!selected.has(tag)); const start = view.getUint32(at + 8), length = view.getUint32(at + 12);
    assert(length >= (tag === 'OS/2' ? 78 : 54) && start + length <= out.length);
    selected.set(tag, {at, start, length});
  }
  assert(selected.has('OS/2') && selected.has('head'));
  const checksum = (start, length) => { let sum = 0; for (let j = 0; j < length; j += 4) { let word = 0; for (let k = 0; k < 4; k++) word = word * 256 + (j + k < length ? out[start + j + k] : 0); sum = (sum + word) >>> 0; } return sum; };
  const os2 = selected.get('OS/2'), head = selected.get('head');
  assert.equal(view.getUint16(os2.start + 8), 0); view.setUint16(os2.start + 8, 2);
  view.setUint32(os2.at + 4, checksum(os2.start, os2.length));
  // SFNT's head directory checksum treats checkSumAdjustment as zero. After
  // directory checksums are final, restore the whole-font checksum invariant.
  view.setUint32(head.start + 8, 0); view.setUint32(head.at + 4, checksum(head.start, head.length));
  view.setUint32(head.start + 8, (0xB1B0AFBA - checksum(0, out.length)) >>> 0);
  assert.equal(checksum(0, out.length), 0xB1B0AFBA); return out;
}
function command(product, auth, body) { return {protocolVersion: 1, command: {schemaVersion: 1, commandId: randomUUID(), clientId: auth.clientId, sessionId: 'portable_font_fault', correlationId: randomUUID(), causationId: null, transactionId: randomUUID(), documentId: null, expectedDocumentRevision: null, expectedEntityVersions: product.EMPTY_EXPECTED_VERSIONS, issuedAt: new Date().toISOString(), body}}; }
async function stage(writer, product, auth, bytes, purpose, mediaType, signal) {
  const blob = refFor(bytes, mediaType), stagingId = randomUUID(); checkSignal(signal); await writer.assetCreate({protocolVersion: 1, stagingId, purpose, expectedBytes: blob.byteLength, sha256: blob.hash, mediaType}, auth);
  for (let at = 0; at < bytes.length; at += MiB) { checkSignal(signal); const chunk = bytes.subarray(at, at + MiB), token = await writer.assetBeginChunk(stagingId, String(at), chunk.length, auth); try { await writer.assetChunk(token, chunk, auth); } catch (error) { await writer.assetAbortChunk(token).catch(() => {}); throw error; } }
  const value = command(product, auth, {type: 'FinalizeStaging', stagingId, expectedSha256: blob.hash}); let receipt = await writer.assetCommand(bytesOf(value), auth);
  const deadline = Date.now() + 120000; while (!receipt) { checkSignal(signal); assert(Date.now() < deadline, 'Fixture staging did not settle'); receipt = (await writer.commandState(value.command.commandId)).record?.receipt; if (!receipt) await new Promise(r => setTimeout(r, 2)); }
  assert.equal(receipt.status, 'accepted'); const event = (await writer.events(String(BigInt(receipt.fromSeq) - 1n))).events.find(e => e.commandId === value.command.commandId); assert.equal(event?.type, 'AssetRegistered'); equal(event.payload.asset.blob, blob); return {asset: event.payload.asset, commandId: value.command.commandId};
}
async function archiveIdentity(path, signal) { const stat = await lstat(path); assert(stat.isFile() && !stat.isSymbolicLink()); const h = createHash('sha256'); let length = 0n; for await (const chunk of createReadStream(path, {flags: constants.O_RDONLY | constants.O_NOFOLLOW, highWaterMark: MiB})) { checkSignal(signal); h.update(chunk); length += BigInt(chunk.length); } assert.equal(length, BigInt(stat.size)); return {path, sha256: h.digest('hex'), byteLength: String(length)}; }
async function productExtras(repo) { const module = path => import(pathToFileURL(join(repo, 'dist/local', path)).href); const [transactions, memory] = await Promise.all([module('server/portable/transactions.js'), module('server/storage/composition-memory.js')]); return {...transactions, ...memory}; }
async function validateClosure(product, extras, db, manifest, read, check) { const memory = new extras.CompositionMemory(() => memory.bytes); try { return await product.validateClosure(db, read, check, memory, manifest.formatVersion >= 4, manifest.formatVersion >= 5, manifest.formatVersion >= 6, manifest.formatVersion >= 7, manifest.formatVersion >= 9, manifest.formatVersion >= 10, manifest.formatVersion >= 10, manifest.formatVersion >= 12, manifest.formatVersion >= 13); } finally { const owned = memory.resourceOwnership(); assert.equal(owned.loans + owned.borrowers + owned.contentReaders + owned.loanBytes + owned.borrowedBytes, 0); } }
async function readZip(zip, ref, check) { assert(BigInt(ref.byteLength) <= 8n * BigInt(MiB)); const entry = zip.entry('objects/' + rawHash(ref.hash)); assert.equal(String(entry.bytes), ref.byteLength); const chunks = []; for await (const chunk of zip.chunks(entry, check)) chunks.push(chunk); const bytes = Buffer.concat(chunks); assert.equal(hash(bytes), rawHash(ref.hash)); return bytes; }

async function buildArchive({product, extras, baseline, archive, output, blobs, alias, draftAsset, ui, signal}) {
  const check = () => checkSignal(signal); let source, target, zip, verifiedZip, verified, primaryError;
  try {
    source = product.spool(join(output, 'font-fault-source.sqlite')); target = product.spool(join(output, 'font-fault-encoded.sqlite'));
    zip = new product.ZipIndex(archive.path, source); await zip.headers(check); await zip.hashes(check); const manifest = await product.decodeRecords(zip, source, check); assert.equal(manifest.unsupported, undefined); assert.equal(manifest.complete, true);
    const document = await validateClosure(product, extras, source, manifest, ref => readZip(zip, ref, check), check); assert.equal(document.id, baseline.documentId); ui.drafts[0].expectedDocumentRevision = document.revision;
    await extras.validateTransactions(source, manifest.capturedHighWater, check); const original = archiveWitness(source);
    assert.equal(source.prepare('SELECT count(*) n FROM events').get().n, baseline.counts.events); assert.equal(source.prepare("SELECT count(*) n FROM entities WHERE kind='asset'").get().n, baseline.counts.assets);
    let closureBytes = 0n; for (const r of source.prepare('SELECT bytes FROM refs').iterate()) closureBytes += BigInt(r.bytes); assert.equal(String(closureBytes), baseline.counts.closureBytes);
    product.defineIndex(target); for (const r of source.prepare('SELECT kind,id,json FROM entities').iterate()) target.prepare('INSERT INTO entities VALUES (?,?,?,NULL)').run(r.kind, r.id, r.json);
    for (const r of source.prepare('SELECT * FROM events').iterate()) target.prepare('INSERT INTO events VALUES (?,?,?)').run(r.seq, r.tx, r.json);
    for (const r of source.prepare('SELECT hash,bytes,media FROM refs').iterate()) product.addRef(target, {hash: r.hash, byteLength: r.bytes, mediaType: r.media});
    for (const r of source.prepare('SELECT json FROM transactions').iterate()) extras.addTransaction(target, JSON.parse(r.json));
    target.prepare('INSERT OR IGNORE INTO portable_features VALUES (?)').run(manifest.formatVersion); equal(archiveWitness(target), original);
    for (const [kind, value] of [['asset', alias], ['asset', draftAsset], ['draft', ui]]) { const id = kind === 'draft' ? value.sessionId : value.id; target.prepare('INSERT INTO entities VALUES (?,?,?,NULL)').run(kind, id, fontFaultCanonical(value)); product.references(value, ref => product.addRef(target, ref)); }
    for (const {ref} of blobs.values()) product.addRef(target, ref);
    const encoded = await product.encodeRecords(target, output, manifest.sourceNamespace, manifest.capturedHighWater, check);
    const read = async ref => { const added = blobs.get(ref.hash); return added ? added.bytes : readZip(zip, ref, check); };
    equal(await validateClosure(product, extras, target, encoded, read, check), document); await extras.validateTransactions(target, encoded.capturedHighWater, check);
    const path = join(output, 'restricted-font-negative.zip');
    await product.writeZip(path, target, (async function* () {
      yield await product.fileSource('manifest.json', join(output, 'manifest.json'), check);
      for (const r of target.prepare('SELECT path FROM segments ORDER BY path').iterate()) yield await product.fileSource(r.path, join(output, r.path.replace('/', '-')), check);
      for (const r of target.prepare('SELECT hash,bytes,media FROM refs ORDER BY hash').iterate()) {
        const name = 'objects/' + rawHash(r.hash), added = blobs.get(r.hash), payload = target.prepare('SELECT json FROM payloads WHERE hash=?').get(r.hash), bytes = payload ? Buffer.from(payload.json) : added?.bytes;
        if (bytes) { assert.equal(String(bytes.length), r.bytes); assert.equal(hash(bytes), rawHash(r.hash)); yield {name, bytes: BigInt(bytes.length), sha256: hash(bytes), crc: (product.crc32(bytes) ^ 0xffffffff) >>> 0, chunks: async function* () { for (let at = 0; at < bytes.length; at += MiB) yield bytes.subarray(at, at + MiB); }}; }
        else { const entry = zip.entry(name); yield {name, bytes: entry.bytes, sha256: entry.sha256, crc: entry.crc, chunks: () => zip.chunks(entry, check)}; }
      }
    })(), check);
    verified = product.spool(join(output, 'font-fault-verified.sqlite')); verifiedZip = new product.ZipIndex(path, verified); await verifiedZip.headers(check); await verifiedZip.hashes(check); const final = await product.decodeRecords(verifiedZip, verified, check); assert.equal(final.unsupported, undefined);
    equal(await validateClosure(product, extras, verified, final, ref => readZip(verifiedZip, ref, check), check), document); await extras.validateTransactions(verified, final.capturedHighWater, check);
    for (const table of ['events', 'transactions']) equal(archiveWitness(verified)[table], original[table]);
    for (const row of source.prepare('SELECT kind,id,json FROM entities').iterate()) assert.equal(verified.prepare('SELECT json FROM entities WHERE kind=? AND id=?').get(row.kind, row.id)?.json, row.json);
    return {archive: await archiveIdentity(path, signal), original, document};
  } catch (error) { primaryError = error; throw error; }
  finally { const failures = []; for (const resource of [verifiedZip, verified, zip, target, source]) try { resource?.close(); } catch (error) { failures.push(error); } if (failures.length) throw new AggregateError([...(primaryError ? [primaryError] : []), ...failures], 'Negative archive preparation or owned cleanup failed'); }
}

/** Preparation only. The caller owns the real timed SaveCopy/PreviewBundleImport.
 * Baseline authentication/qualification remains with that caller, including WC. */
export async function preparePortableFontFault({direction, repo, output, baseline, root, archive, writer, auth, product, signal}) {
  // Invalid contracts do not acquire ownership, create output, or close the
  // caller's writer. Cancellation is likewise checked before preparation.
  checkSignal(signal);
  try {
    assert(['copy', 'import'].includes(direction)); baseline = baselineValue(baseline); baselineShape(baseline);
    for (const path of [repo, root, output]) assert(typeof path === 'string' && isAbsolute(path) && resolve(path) === path && !/[\\\x00-\x1f\x7f]/.test(path));
    const outside = (base, path) => { const rel = relative(base, path); return rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel); };
    assert(outside(root, output) && outside(output, root), 'Preparation output and owned root must be disjoint'); assert(root !== repo && output !== repo);
    assert(writer && resolve(writer.root) === root && typeof writer.close === 'function'); assert(product && auth && ID.test(auth.clientId));
    keys(archive, ['path', 'sha256', 'byteLength']); assert(typeof archive.path === 'string' && isAbsolute(archive.path) && resolve(archive.path) === archive.path && !/[\\\x00-\x1f\x7f]/.test(archive.path)); equal({sha256: rawHash(archive.sha256), byteLength: archive.byteLength}, baseline.archive);
    await fontFaultPrivatePath(root, true);
    try { await fontFaultPrivatePath(output, true); } catch (error) { if (error.code !== 'ENOENT') throw error; const parent = dirname(output); assert.equal(await realpath(parent), parent); const stat = await lstat(parent); assert(stat.isDirectory() && !stat.isSymbolicLink()); }
  } catch (error) { error.code = 'FIXTURE_REQUIRED'; throw error; }
  let owned = writer;
  const started = performance.now();
  try {
    await fontFaultPrivatePath(root, true); assert.equal(resolve(writer.root), root); await mkdir(output, {mode: 0o700, recursive: true}); await fontFaultPrivatePath(output, true); assert.notEqual(output, root);
    const identity = await archiveIdentity(resolve(archive.path), signal); equal({sha256: identity.sha256, byteLength: identity.byteLength}, baseline.archive); equal({sha256: rawHash(archive.sha256), byteLength: archive.byteLength}, baseline.archive);
    const profile = await pinProfile(repo), source = profile.value.fonts.find(f => f.id === 'NotoSans'); assert(source?.file === 'fonts/NotoSans-Regular.ttf' && source.licenseFile === 'notices/Noto-OFL.txt');
    const fontBytes = await readBounded(join(repo, 'vendor/text', source.file), 16 * MiB), license = await readBounded(join(repo, 'vendor/text', source.licenseFile), 65536); assert.equal(hash(fontBytes), source.sha256); assert.equal(String(fontBytes.length), String(source.bytes)); assert.equal(hash(license), rawHash(source.licenseHash));
    const font = restrictedFont(fontBytes), text = Buffer.from(DRAFT_TEXT), objects = {font: refFor(font, 'application/octet-stream'), license: refFor(license, 'text/plain'), text: refFor(text, 'text/plain')};
    const fontValue = {schemaVersion: 1, bytes: objects.font, faceIndex: 0, format: 'static-ttf', parserProfile: 'sfnt-static-1-freetype-canvaskit040', fsType: 0, licenseRecord: objects.license, origin: 'local-file', embedding: 'permitted'};
    const alias = {id: 'font_fault_' + randomUUID(), version: '1', purpose: 'font', blob: objects.font, dependencies: [objects.license], safety: 'safe', availability: 'available', qualification: 'font', measuredMediaType: 'application/octet-stream', font: {...fontValue, id: 'sha256:' + hash(bytesOf(fontValue))}};
    const draft = bytesOf({schemaVersion: 1, kind: 'text-draft-1', textUtf8: objects.text, style: {}, frame: {}, fonts: [alias.font]}); objects.draft = refFor(draft, 'text/plain');
    const buffers = {font, license, text, draft}, sessionId = 'font_fault_' + randomUUID(), draftId = 'draft_fault_' + randomUUID(); let staged = null, original, document;
    if (direction === 'copy') { document = await owned.document(baseline.documentId); assert(document); const db = new DatabaseSync(join(root, 'metadata.sqlite'), {readOnly: true}); try { original = fontFaultRootWitness(db); assert(!db.prepare('SELECT 1 FROM ui_checkpoints WHERE client_id=? AND session_id=?').get(auth.clientId, sessionId)); } finally { db.close(); } staged = {}; for (const name of ['font', 'license', 'text', 'draft']) staged[name] = await stage(owned, product, auth, buffers[name], name === 'font' ? 'font' : 'caption', objects[name].mediaType, signal); }
    else document = {revision: '0'}; // The decoded source supplies this before encoding.
    const draftAsset = staged?.draft.asset ?? {id: 'draft_asset_' + randomUUID(), version: '1', purpose: 'caption', blob: objects.draft, dependencies: [], safety: 'safe', availability: 'available', qualification: 'opaque-text', measuredMediaType: 'text/plain'};
    const ui = {sessionId: 'ui_' + hash(bytesOf([auth.clientId, sessionId])), uiSeq: '1', preferences: null, drafts: [{id: draftId, generation: '1', kind: 'text', documentId: baseline.documentId, targetLayerId: null, expectedDocumentRevision: document.revision, assetId: draftAsset.id, composing: false, status: 'saved-unapplied'}], reconciledLayerIds: []};
    let generated = null;
    if (direction === 'import') { const blobs = new Map(Object.entries(objects).map(([name, ref]) => [ref.hash, {ref, bytes: buffers[name]}])); const built = await buildArchive({product, extras: await productExtras(repo), baseline, archive: identity, output, blobs, alias, draftAsset, ui, signal}); generated = built.archive; original = built.original; document = built.document; }
    const descriptor = {kind: KIND, schemaVersion: 1, negativeOnly: true, qualification: false, direction, repo, root, baseline, profile: profile.pin, sources: await fontFaultSourcePins(repo), sourceFont: {path: 'vendor/text/' + source.file, sha256: hash(fontBytes), byteLength: String(fontBytes.length)}, sourceLicense: {path: 'vendor/text/' + source.licenseFile, sha256: hash(license), byteLength: String(license.length)}, mutation: {kind: 'sfnt-os2-fstype-2-checksum-1', actualFsType: 2, claimedFsType: 0}, clientId: auth.clientId, sessionId, documentRevision: document.revision, objects, alias, draftAsset, ui, staged, original, archive: generated};
    validateFontFaultDescriptor(descriptor, {direction, baseline, root, repo}); await verifyFontFaultFiles(descriptor); const seal = {descriptor, sha256: hash(bytesOf(descriptor))}, sealedBytes = bytesOf(seal), descriptorPath = join(output, 'restricted-font-descriptor.json'); await writeFile(descriptorPath, sealedBytes, {mode: 0o600, flag: 'wx'});
    if (direction === 'copy') {
      await writeFile(join(root, FONT_FAULT_CONFIG), sealedBytes, {mode: 0o600, flag: 'wx'}); await owned.close(); owned = null; checkSignal(signal);
      owned = await product.openWriter({root}, {setupModule: new URL('./portable-font-fault-setup.mjs', import.meta.url).href, ...(globalThis.__storeNetworkCounters?.shared ? {effectCounters: globalThis.__storeNetworkCounters.shared} : {})});
      await owned.protocolDefaults(); assert.equal(await owned.recoverClient(auth.sessionHash, Date.now()), auth.clientId, 'Reopened fixture retains its existing client binding'); const ready = JSON.parse(await readBounded(join(root, FONT_FAULT_READY), 32768, true)); assert.equal(ready.descriptorSha256, seal.sha256); equal(ready.original, original);
      const {status, ...saved} = ui.drafts[0]; const receipt = await owned.uiPersist(bytesOf({protocolVersion: 1, requestId: randomUUID(), sessionId, expectedUISeq: '0', body: {type: 'SaveDraft', draft: saved}}), auth); assert.equal(receipt.status, 'accepted'); const current = await owned.uiRead(sessionId, auth); equal(current.drafts, ui.drafts); assert.equal(current.uiSeq, '1'); equal(await owned.document(baseline.documentId), document);
    }
    checkSignal(signal); return {writer: owned, ...(generated ? {archive: generated} : {}), descriptor, evidence: [{kind: KIND, direction, negativeOnly: true, qualification: false, descriptor: {path: descriptorPath, sha256: hash(sealedBytes), byteLength: String(sealedBytes.length)}, descriptorSha256: seal.sha256, baseline, original, archive: generated, added: {alias: alias.id, draftAsset: draftAsset.id, draft: draftId, objects}, preparation: {durationMs: performance.now() - started, addedObjectBytes: String(Object.values(objects).reduce((n, ref) => n + BigInt(ref.byteLength), 0n)), originalArchiveBytes: baseline.archive.byteLength, generatedArchiveBytes: generated?.byteLength ?? null, timedOperationIncluded: false}, guardScope: globalThis.__storeNetworkCounters?.shared ? 'caller-store-no-network' : 'caller-owned-guard', runtimeOutcome: 'not-executed'}]};
  } catch (error) { if (owned) try { await owned.close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Negative font preparation and owned writer cleanup failed'); } throw error; }
}
