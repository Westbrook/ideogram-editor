import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Receipt } from '../../src/protocol/store.js';
import { canonical, isId, isSeq } from '../storage/canonical.js';
import { keys, requireValue as ok } from '../../src/protocol/validate.js';
import { invalid, tick } from './zip.js';
import { StoreError } from '../storage/errors.js';

export type PortableTransaction = {
  schemaVersion: 1; kind: 'transaction'; sourceArchive: string | null;
  receipt: Extract<Receipt, {status: 'accepted'}>;
  eventCount: string; eventsHash: string;
};

export function defineTransactions(db: DatabaseSync) {
  db.exec(`CREATE TABLE transactions(archive TEXT NOT NULL,id TEXT NOT NULL,command_id TEXT NOT NULL,
    first_seq TEXT NOT NULL,last_seq TEXT NOT NULL,json TEXT NOT NULL,
    PRIMARY KEY(archive,id),UNIQUE(archive,command_id)) STRICT;
    CREATE INDEX portable_events_transaction ON events(tx,length(seq),seq);
    CREATE UNIQUE INDEX portable_events_identity ON events(json_extract(json,'$.eventId'));`);
}

export function transactionRecord(value: unknown): asserts value is PortableTransaction {
  const v = value as PortableTransaction;
  keys(v, ['schemaVersion','kind','sourceArchive','receipt','eventCount','eventsHash']);
  ok(v.schemaVersion === 1 && v.kind === 'transaction' &&
    (v.sourceArchive === null || /^sha256:[a-f0-9]{64}$/.test(v.sourceArchive)));
  const r = v.receipt;
  keys(r, ['status','commandId','fromSeq','toSeq','documentRevision','transactionId']);
  ok(r.status === 'accepted' && isId(r.commandId) && isId(r.transactionId) &&
    isSeq(r.fromSeq) && isSeq(r.toSeq) && BigInt(r.fromSeq) > 0n &&
    BigInt(r.toSeq) >= BigInt(r.fromSeq) &&
    (r.documentRevision === null || isSeq(r.documentRevision)) &&
    isSeq(v.eventCount) && BigInt(v.eventCount) === BigInt(r.toSeq)-BigInt(r.fromSeq)+1n &&
    /^sha256:[a-f0-9]{64}$/.test(v.eventsHash));
}

export function addTransaction(db: DatabaseSync, value: unknown) {
  transactionRecord(value);
  const r = value.receipt;
  try {
    db.prepare('INSERT INTO transactions VALUES (?,?,?,?,?,?)')
      .run(value.sourceArchive??'',r.transactionId,r.commandId,r.fromSeq,r.toSeq,canonical(value));
  } catch (error) {
    // Duplicate transaction/command identities are malformed archive data.
    // Keep actual storage errors intact for paused recovery.
    if (((error as {errcode?:number}).errcode ?? 0) % 256 === 19) invalid();
    throw error;
  }
}

// Compatibility is permitted only when this writer still owns the immutable
// original journal and receipt. Never invent a range from the archive rows.
export function captureTransactions(target: DatabaseSync, source: DatabaseSync) {
  const unavailable = () => { throw new StoreError('TRANSACTION_EVIDENCE_UNAVAILABLE', {
    kind:'fields', issues:[{path:'portable.history',code:'ORIGINAL_TRANSACTION_BOUNDS_REQUIRED_SOURCE_ARCHIVE_RETAINED'}],
  }); };
  for (const row of target.prepare('SELECT DISTINCT tx FROM events ORDER BY tx').iterate()) {
    const first = target.prepare('SELECT json FROM events WHERE tx=? ORDER BY length(seq),seq LIMIT 1').get(row.tx)!;
    const event = JSON.parse(String(first.json));
    const command = source.prepare('SELECT receipt FROM commands WHERE id=?').get(event.commandId);
    if (!command) unavailable();
    const receipt = JSON.parse(String(command!.receipt));
    if (receipt.status !== 'accepted' || receipt.transactionId !== row.tx) unavailable();
    let next = BigInt(receipt.fromSeq), count = 0n;
    const hash = createHash('sha256');
    for (const original of source.prepare('SELECT seq,command_id,json FROM events_v2 WHERE transaction_id=? ORDER BY length(seq),seq').iterate(row.tx)) {
      const retained = target.prepare('SELECT json FROM events WHERE seq=? AND tx=?').get(original.seq,row.tx);
      if (BigInt(String(original.seq)) !== next || original.command_id !== receipt.commandId ||
          !retained || retained.json !== original.json) invalid();
      hash.update(String(original.json)+'\n'); next++; count++;
    }
    if (next !== BigInt(receipt.toSeq)+1n || count !== BigInt(receipt.toSeq)-BigInt(receipt.fromSeq)+1n ||
        count !== BigInt(String(target.prepare('SELECT count(*) n FROM events WHERE tx=?').get(row.tx)!.n))) invalid();
    addTransaction(target,{schemaVersion:1,kind:'transaction',sourceArchive:null,receipt,eventCount:String(count),eventsHash:'sha256:'+hash.digest('hex')});
  }
}

// Receipt ranges come from the writer's accepted transaction, not MIN/MAX of
// whichever event rows happen to survive in an archive. This is consistency
// evidence, not an external signature or an authenticity claim.
export async function validateTransactions(db: DatabaseSync, highWater: string, check:()=>void) {
  let previousEnd = 0n;
  for (const row of db.prepare("SELECT json FROM transactions WHERE archive='' ORDER BY length(first_seq),first_seq").iterate()) {
    const record = JSON.parse(String(row.json)); transactionRecord(record);
    const r = record.receipt, end = BigInt(r.toSeq);
    if (BigInt(r.fromSeq) <= previousEnd || end > BigInt(highWater)) invalid();
    let next = BigInt(r.fromSeq), count = 0n, identity: string | undefined, revision:string|null=null;
    const hash = createHash('sha256');
    for (const row of db.prepare('SELECT seq,json FROM events WHERE tx=? ORDER BY length(seq),seq').iterate(r.transactionId)) {
      const text = String(row.json), event = JSON.parse(text);
      if (BigInt(String(row.seq)) !== next || next > end || event.workspaceSeq !== row.seq ||
          event.transactionId !== r.transactionId || event.commandId !== r.commandId) invalid();
      const key = canonical([event.correlationId,event.causationId,event.writerEpoch]);
      if (identity !== undefined && key !== identity) invalid();
      identity = key; revision=event.resultingDocumentRevision; hash.update(text+'\n'); next++; count++; check(); await tick();
    }
    if (next !== end+1n || count !== BigInt(record.eventCount) || (revision!==null&&revision!==r.documentRevision) ||
        'sha256:'+hash.digest('hex') !== record.eventsHash) invalid();
    previousEnd = end;
  }
  if (db.prepare("SELECT 1 FROM events WHERE tx NOT IN (SELECT id FROM transactions WHERE archive='') LIMIT 1").get()) invalid();
}

// Legacy survivors cannot prove the missing prefix/tail. They can still expose
// a definite interior gap or a command split across distinct transactions.
export async function validateLegacySurvivors(db:DatabaseSync,check:()=>void){
  if(db.prepare("SELECT 1 FROM events GROUP BY json_extract(json,'$.commandId') HAVING count(DISTINCT tx)>1 LIMIT 1").get())invalid();
  let transaction='',next=0n,identity='';
  db.exec('CREATE TABLE legacy_seen_transactions(id TEXT PRIMARY KEY) STRICT');
  for(const row of db.prepare('SELECT seq,tx,json FROM events ORDER BY length(seq),seq').iterate()){
    const e=JSON.parse(String(row.json)),key=canonical([e.commandId,e.correlationId,e.causationId,e.writerEpoch]);
    if(row.tx!==transaction){if(db.prepare('SELECT 1 FROM legacy_seen_transactions WHERE id=?').get(row.tx))invalid();db.prepare('INSERT INTO legacy_seen_transactions VALUES (?)').run(row.tx);transaction=String(row.tx);next=BigInt(String(row.seq));identity=key;}
    if(BigInt(String(row.seq))!==next++||key!==identity)invalid();check();await tick();
  }
}
