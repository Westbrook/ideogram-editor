// Fixed internal openWriter setupModule. It runs after rebuild, before ready;
// no caller-provided code/SQL and no production method replacement is accepted.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {FONT_FAULT_READY, fontFaultCanonical, fontFaultPrivatePath, fontFaultRootWitness, readFontFaultConfiguration, verifyFontFaultFiles} from './portable-font-fault.mjs';

export async function setup(store) {
  const {descriptor: d, sha256} = await readFontFaultConfiguration(store.root);
  await verifyFontFaultFiles(d); assert.equal(d.root, store.root);
  const module = path => import(pathToFileURL(join(d.repo, 'dist/local', path)).href);
  const [{entity}, {textDraft}] = await Promise.all([module('src/protocol/validate.js'), module('src/protocol/text.js')]);
  const additions = {commands: Object.values(d.staged).map(x => x.commandId), assets: Object.values(d.staged).map(x => x.asset.id)};
  assert.equal(fontFaultCanonical(fontFaultRootWitness(store.db, additions)), fontFaultCanonical(d.original));
  assert.equal(store.document(d.baseline.documentId)?.revision, d.documentRevision);
  assert(!store.db.prepare('SELECT 1 FROM assets WHERE id=?').get(d.alias.id));
  assert(!store.db.prepare('SELECT 1 FROM ui_checkpoints WHERE client_id=? AND session_id=?').get(d.clientId, d.sessionId));
  for (const [name, value] of Object.entries(d.staged)) {
    const asset = store.assets.asset(value.asset.id); assert.equal(fontFaultCanonical(asset), fontFaultCanonical(value.asset));
    assert.equal(asset.qualification, name === 'font' ? 'pending-text' : 'opaque-text');
    const receipt = store.lookup(value.commandId); assert.equal(receipt?.receipt.status, 'accepted'); assert.equal(receipt.command.documentId, null); assert.equal(receipt.command.body.type, 'FinalizeStaging');
    const rows = store.db.prepare('SELECT json FROM events_v2 WHERE command_id=?').all(value.commandId); assert.equal(rows.length, 1); const event = JSON.parse(rows[0].json); assert.equal(event.type, 'AssetRegistered'); assert.equal(event.documentId, null); assert.equal(fontFaultCanonical(event.payload.asset), fontFaultCanonical(asset));
    await fontFaultPrivatePath(store.objects.path(d.objects[name])); store.objects.verify(d.objects[name]);
  }
  const draft = JSON.parse(Buffer.from(store.objects.verify(d.objects.draft, true)).toString('utf8')); textDraft(draft);
  assert.equal(fontFaultCanonical(draft), fontFaultCanonical({schemaVersion: 1, kind: 'text-draft-1', textUtf8: d.objects.text, style: {}, frame: {}, fonts: [d.alias.font]}));
  entity('asset', d.alias); entity('asset', d.draftAsset);
  // The bytes must carry the advertised adversarial mutation, not a caller-
  // supplied expected error. Production inspection remains for actual SaveCopy.
  // Fonts exceed the returned-metadata cap. Keep that cap intact and acquire
  // bounded owned ranges, releasing every range before reading the next one.
  const fontLength = Number(d.objects.font.byteLength);
  assert(Number.isSafeInteger(fontLength) && fontLength > 0 && fontLength <= 16 * 1024 * 1024);
  const font = Buffer.alloc(fontLength), fontHash = createHash('sha256');
  for (let offset = 0; offset < fontLength; offset += 65536) {
    const length = Math.min(65536, fontLength - offset), chunk = store.objects.readRangeOwned(d.objects.font, String(offset), length);
    try { assert.equal(chunk.bytes.byteLength, length); font.set(chunk.bytes, offset); fontHash.update(chunk.bytes); }
    finally { chunk.release(); }
  }
  assert.equal('sha256:' + fontHash.digest('hex'), d.objects.font.hash);
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength); let found = false;
  assert(font.length >= 12 && 12 + view.getUint16(4) * 16 <= font.length);
  for (let i = 0; i < view.getUint16(4); i++) { const at = 12 + i * 16; if (font.toString('ascii', at, at + 4) !== 'OS/2') continue; assert(!found); const start = view.getUint32(at + 8), length = view.getUint32(at + 12); assert(length >= 78 && start + length <= font.length); assert.equal(view.getUint16(start + 8), 2); let sum = 0; for (let j = 0; j < length; j += 4) { let word = 0; for (let k = 0; k < 4; k++) word = word * 256 + (j + k < length ? font[start + j + k] : 0); sum = (sum + word) >>> 0; } assert.equal(view.getUint32(at + 4), sum); found = true; } assert(found);
  let wholeSum = 0; for (let at = 0; at < font.length; at += 4) { let word = 0; for (let k = 0; k < 4; k++) word = word * 256 + (at + k < font.length ? font[at + k] : 0); wholeSum = (wholeSum + word) >>> 0; } assert.equal(wholeSum, 0xB1B0AFBA);
  store.db.exec('BEGIN IMMEDIATE');
  try {
    store.db.prepare('INSERT INTO assets VALUES (?,?)').run(d.alias.id, fontFaultCanonical(d.alias));
    for (const ref of [d.alias.blob, ...d.alias.dependencies]) { assert.equal(store.db.prepare('SELECT byte_length FROM objects WHERE hash=?').get(ref.hash)?.byte_length, ref.byteLength); store.db.prepare('INSERT INTO asset_dependencies VALUES (?,?)').run(d.alias.id, ref.hash); }
    assert.equal(fontFaultCanonical(fontFaultRootWitness(store.db, {commands: additions.commands, assets: [...additions.assets, d.alias.id]})), fontFaultCanonical(d.original));
    store.db.exec('COMMIT');
  } catch (error) { if (store.db.isTransaction) store.db.exec('ROLLBACK'); throw error; }
  await writeFile(join(store.root, FONT_FAULT_READY), fontFaultCanonical({kind: 'portable-font-negative-ready-1', descriptorSha256: sha256, aliasId: d.alias.id, original: d.original, qualification: false}), {mode: 0o600, flag: 'wx'});
  return async () => {};
}
