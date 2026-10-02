// STAGED SOURCE. Promotion target: tooling/qualification/campaigns/browser-lifecycle-counters.mjs.
// Read-only witnesses; no fixture constants, writer construction, or product mutation.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {projectLifecycleComposition, LIFECYCLE_COMPOSITION_NAMES} from './browser-lifecycle-composition.mjs';
import { createTextResourceObserver } from './browser-text-resources.mjs';
import { readPhaseSnapshot } from './browser-phase-snapshot.mjs';

const MiB = 1048576, ROW_LIMIT = 4096, BYTE_LIMIT = 32 * MiB;
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const natural = value => Number.isSafeInteger(value) && value >= 0;
const check = (value, message) => assert(value, 'LIFECYCLE_COUNTERS: ' + message);
const errorCode = error => /^[A-Z][A-Z0-9_:-]{0,95}$/.test(error?.code ?? '') ? error.code : 'OBSERVER_PROOF_FAILED';
const names = new Set(['R21EventUtf8Bytes', 'R21CommandUtf8Bytes', 'R21InlineBinaryOrDataUris', 'R25ActiveRequests', 'R25PendingEntries', 'R35CurrentFontFaces', 'R35SingleFontBytes', 'R35CurrentFontSetBytes', 'R35FontShapingCpuBytes', 'R35GlyphGpuBytes', 'R35SilentFontSubstitutionCount', 'R38DerivedSnapshotBytes', 'R38IssueBytes', 'R38RawPageBytes', 'R38MaterializedRawInspectionBytes', 'R38TextCaptionWorkspaceBytes', 'R38RawTruncationOrFalseCompletenessCount']);

/** Typed production validation is essential: a base64 regex alone cannot prove
 * the absence of binary payloads. Never return user-provided string contents. */
export function inspectLifecycleEnvelope(bytes, { kind, parseCommand, validateEvent }) {
  check(bytes instanceof Uint8Array, 'actual bytes required');
  const result = { kind, byteLength: bytes.byteLength, sha256: hash(bytes), typed: false, inlineViolations: 0 };
  if (bytes.byteLength > 65536) return result;
  let value;
  try {
    if (kind === 'command') { value = parseCommand(bytes); result.commandId = value.command.commandId; result.type = value.command.body.type; }
    else { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); validateEvent(value); result.commandId = value.commandId; result.workspaceSeq = value.workspaceSeq; result.type = value.type; }
    result.typed = true;
  } catch { return result; }
  const walk = (item, key = '', depth = 0) => {
    check(depth <= 64, 'typed envelope nesting exceeds observer bound');
    if (typeof item === 'string') {
      if (/data:[^\s,]{1,256}[;,]/i.test(item) || /^(?:base64|binaryData|inlineBytes|imageData)$/i.test(key)) result.inlineViolations++;
    } else if (Array.isArray(item)) item.forEach(v => walk(v, key, depth + 1));
    else if (item && typeof item === 'object') for (const [k, v] of Object.entries(item)) walk(v, k, depth + 1);
  };
  walk(value); return result;
}

export function lifecycleQueueCounts(jobs) {
  const ids = new Set(), attempts = new Set(); let active = 0, pending = 0;
  for (const job of jobs) {
    check(typeof job.id === 'string' && !ids.has(job.id) && Array.isArray(job.attempts), 'invalid queue job'); ids.add(job.id);
    if (job.local !== 'locally-cancelled' && job.attempts.some(a => a.state === 'not-started')) pending++;
    for (const attempt of job.attempts) { check(typeof attempt.id === 'string' && !attempts.has(attempt.id) && typeof attempt.hold === 'boolean', 'invalid queue attempt'); attempts.add(attempt.id); if (attempt.hold) active++; }
  }
  return { active, pending, jobs: jobs.length };
}

/** Complete append-only journal replay catches peaks invisible at endpoints. */
export function replayLifecycleQueue({ before, after, records, fromSeq, toSeq }) {
  const state = new Map(before.map(job => [job.id, job]));
  check(state.size === before.length, 'duplicate baseline queue job');
  let seq = BigInt(fromSeq), maximum = lifecycleQueueCounts(before);
  const observations = [{ seq: String(seq), ...maximum }];
  for (const record of records) {
    check(BigInt(record.seq) === ++seq, 'queue journal gap');
    const value = record.value;
    check(['job', 'session'].includes(value.family) && typeof value.event === 'string' && typeof value.epoch === 'string', 'invalid queue journal family');
    if (value.family === 'job') state.set(value.value.id, value.value);
    const counts = lifecycleQueueCounts([...state.values()]);
    maximum = { active: Math.max(maximum.active, counts.active), pending: Math.max(maximum.pending, counts.pending), jobs: Math.max(maximum.jobs, counts.jobs) };
    observations.push({ seq: String(seq), ...counts, family: value.family, event: value.event, sha256: record.sha256 });
  }
  check(seq === BigInt(toSeq), 'incomplete queue journal range');
  const ordered = jobs => [...jobs].sort((a, b) => a.id.localeCompare(b.id));
  assert.equal(canonical(ordered([...state.values()])), canonical(ordered(after)), 'Queue journal does not reproduce the final authoritative projection');
  return { maximum, observations, complete: true };
}

/** Called only with fully proved, typed TextSource records. Font file bytes are
 * deduplicated separately from face identity; every current text layer counts. */
export function lifecycleFontUnion(sources) {
  const faces = new Set(), files = new Map(); let singleBytes = 0;
  for (const source of sources) for (const font of source.text.fonts) {
    const bytes = Number(font.bytes.byteLength); check(natural(bytes), 'invalid font length');
    faces.add(font.bytes.hash + ':' + font.faceIndex + ':' + font.parserProfile);
    if (files.has(font.bytes.hash)) check(files.get(font.bytes.hash) === bytes, 'conflicting font lengths');
    files.set(font.bytes.hash, bytes); singleBytes = Math.max(singleBytes, bytes);
  }
  return { faces: faces.size, singleBytes, setBytes: [...files.values()].reduce((sum, bytes) => sum + bytes, 0), files: [...files].map(([sha256, byteLength]) => ({ sha256, byteLength })) };
}

/** Actual producer snapshots are lower bounds, never complete physical peaks. */
export function lifecycleAllocationObservations(samples) {
  const max = key => samples.filter(s => natural(s[key])).reduce((n, s) => Math.max(n, s[key]), -1);
  return { fontShapingCpuBytes: max('fontShapingCpuBytes'), glyphGpuBytes: max('glyphGpuBytes'), captionWorkspaceBytes: max('captionWorkspaceBytes'), complete: false };
}

export async function createLifecycleCounters({ page, root, repo = process.cwd(), output, cell, fixtureIdentity, processIdentity, rendererOwnershipProof = null, executableIdentity, journal, signal }) {
  check(page && root && output && typeof cell?.id === 'string', 'owned page/root/output/cell required');
  const required = new Set((cell.requiredMeasurements ?? []).map(v => typeof v === 'string' ? v : v.name).filter(name => names.has(name)));
  const load = path => import(pathToFileURL(resolve(repo, 'dist/local', path)).href);
  const [{ DatabaseSync }, { Objects }, files, validators, history, textValidation, commandValidation] = await Promise.all([
    import('node:sqlite'), load('server/storage/objects.js'), load('server/storage/files.js'), load('src/protocol/validate.js'),
    load('src/protocol/history-validation.js'), load('server/text/validation.js'), load('server/storage/canonical.js'),
  ]);
  files.assertComponents(root);
  for (const directory of [root, join(root, 'objects'), join(root, 'objects', 'sha256'), join(root, 'staging')]) files.assertPrivate(directory, true);
  files.assertPrivate(join(root, 'metadata.sqlite'), false);
  const db = new DatabaseSync(join(root, 'metadata.sqlite'), { readOnly: true, allowExtension: false, timeout: 250 });
  let closed = false, cycle = null;
  const pending = new Set(), requestBindings = new WeakMap(), fontProofs = new Map(), sourceCache = new Map();
  const checkOpen = () => { signal?.throwIfAborted(); check(!closed, 'collector closed'); };
  const objects = new Objects(root, checkOpen, () => { throw Error('LIFECYCLE_COUNTERS_READ_ONLY'); });
  const schema = db.prepare("SELECT name,type,sql FROM sqlite_master WHERE name IN ('commands','events_v2','queue_journal','queue_jobs','documents','meta','events_v2_immutable_update','events_v2_immutable_delete','queue_journal_update','queue_journal_delete') ORDER BY name").all();
  const build = [];
  for (const relative of ['server/storage/database.js', 'server/storage/queue.js', 'server/storage/canonical.js', 'src/protocol/validate.js', 'src/protocol/history-validation.js', 'server/text/validation.js']) {
    const bytes = await readFile(resolve(repo, 'dist/local', relative)); build.push({ path: 'dist/local/' + relative, bytes: bytes.length, sha256: hash(bytes) });
  }
  const binding = { database: join(root, 'metadata.sqlite'), readOnly: true, userVersion: db.prepare('PRAGMA user_version').get().user_version, schema, schemaSha256: hash(canonical(schema)), build, nodeVersion: process.version };
  const envelope = bytes => inspectLifecycleEnvelope(bytes, { kind: 'command', parseCommand: commandValidation.parseCommand });
  const issue = (owner, code) => { if (owner && !owner.issues.includes(code)) owner.issues.push(code); };
  const recordRequest = request => {
    if (!cycle) return;
    const owner = cycle;
    try {
      const url = new URL(request.url());
      if (url.origin !== new URL(page.url()).origin || request.method() !== 'POST' || !(/^\/api\/v1\/commands$/.test(url.pathname) || /^\/api\/v1\/assets\/staging\/[^/]+\/finalize$/.test(url.pathname))) return;
      if (owner.requests.length >= ROW_LIMIT) { issue(owner, 'command-observer-row-bound'); return; }
      const bytes = request.postDataBuffer(); check(bytes, 'command request has no observed bytes');
      const witness = { ...envelope(bytes), index: owner.requests.length, observedMs: performance.now(), route: url.pathname.endsWith('/finalize') ? 'asset-finalize' : 'commands', response: null };
      owner.requests.push(witness); requestBindings.set(request, { owner, witness });
    } catch { issue(owner, 'command-observation-failed'); }
  };
  const recordResponse = response => {
    const match = requestBindings.get(response.request()); if (!match) return;
    const work = (async () => {
      try {
        const length = Number(response.headers()['content-length']);
        check(natural(length) && length <= 65536, 'bounded response Content-Length required');
        const bytes = await response.body(); check(bytes.length === length, 'response byte length mismatch');
        const body = JSON.parse(bytes.toString('utf8')), receipt = body.receipt ?? body;
        match.witness.response = { status: response.status(), byteLength: bytes.length, sha256: hash(bytes), observedMs: performance.now(),
          commandId: typeof receipt.commandId === 'string' ? receipt.commandId : null, receiptStatus: ['accepted', 'rejected'].includes(receipt.status) ? receipt.status : null };
      } catch { issue(match.owner, 'command-response-observation-incomplete'); }
    })(); pending.add(work); work.finally(() => pending.delete(work));
  };
  page.on('request', recordRequest); page.on('response', recordResponse);

  function tableRows(query, parameters, byteColumn = 'json') {
    const statement = db.prepare(query), rows = []; let bytes = 0;
    for (const row of statement.iterate(...parameters)) {
      check(rows.length < ROW_LIMIT, 'journal observer row bound');
      bytes += Buffer.byteLength(String(row[byteColumn] ?? ''), 'utf8'); check(bytes <= BYTE_LIMIT, 'journal observer byte bound'); rows.push(row);
    }
    return rows;
  }
  function bracket(documentId, after) {
    checkOpen(); db.exec('BEGIN');
    try {
      const value = {
        atMs: performance.now(), writerEpoch: String(db.prepare("SELECT value FROM meta WHERE key='writerEpoch'").get().value),
        highWater: String(db.prepare("SELECT value FROM meta WHERE key='highWater'").get().value),
        commandRowid: Number(db.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM commands').get().n),
        journalSeq: String(db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM queue_journal').get().n),
        jobs: tableRows('SELECT id,json FROM queue_jobs ORDER BY id', []).map(row => { const job = JSON.parse(row.json); check(job.id === row.id, 'queue projection identity mismatch'); return job; }),
        document: JSON.parse(String(db.prepare('SELECT json FROM documents WHERE id=?').get(documentId)?.json)),
      };
      validators.document(value.document); check(value.document.id === documentId, 'document bracket mismatch');
      if (after) {
        check(value.writerEpoch === after.writerEpoch, 'writer epoch changed during cycle');
        value.commands = tableRows('SELECT rowid,id,original,receipt FROM commands WHERE rowid>? ORDER BY rowid', [after.commandRowid], 'original');
        value.events = tableRows('SELECT seq,command_id,transaction_id,json FROM events_v2 WHERE length(seq)>length(?) OR (length(seq)=length(?) AND seq>?) ORDER BY length(seq),seq', [after.highWater, after.highWater, after.highWater]);
        value.journal = tableRows('SELECT seq,json FROM queue_journal WHERE seq>? ORDER BY seq', [Number(after.journalSeq)]);
      }
      db.exec('COMMIT'); return value;
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  }
  async function publicQueue() {
    const jobs = [], cursors = new Set(); let cursor = '', counts, totalJobs;
    do {
      check(!cursors.has(cursor) && jobs.length < ROW_LIMIT, 'public queue pagination bound'); cursors.add(cursor);
      const value = await page.evaluate(async after => { const response = await fetch('/api/v1/queue' + (after ? '?after=' + encodeURIComponent(after) : ''), { headers: { 'X-App-Client': 'LP-1' } }); if (!response.ok) throw Error('QUEUE_READ'); return response.json(); }, cursor);
      if (counts) { assert.deepEqual(value.counts, counts); assert.equal(value.totalJobs, totalJobs); } else { counts = value.counts; totalJobs = value.totalJobs; }
      check(Array.isArray(value.jobs) && value.jobs.length <= 20, 'public queue page shape'); jobs.push(...value.jobs); cursor = value.nextCursor ?? '';
    } while (cursor);
    const observed = lifecycleQueueCounts(jobs); check(observed.active === counts.active && observed.jobs === totalJobs, 'public queue inventory incomplete');
    return { jobs, counts: observed, pages: cursors.size, projectionSha256: hash(canonical(jobs)) };
  }
  async function stableBracket(documentId, after) {
    const first = bracket(documentId), publicView = await publicQueue(), last = bracket(documentId, after);
    check(first.writerEpoch === last.writerEpoch && first.journalSeq === last.journalSeq && first.highWater === last.highWater && first.commandRowid === last.commandRowid, 'state changed during public cross-check');
    assert.equal(canonical(publicView.jobs), canonical(last.jobs), 'Public queue and authoritative table disagree');
    return { ...last, publicQueue: { counts: publicView.counts, pages: publicView.pages, projectionSha256: publicView.projectionSha256 } };
  }
  async function readProved(ref, maxBytes) {
    check(ref && /^sha256:[a-f0-9]{64}$/.test(ref.hash) && /^(0|[1-9][0-9]*)$/.test(ref.byteLength) && BigInt(ref.byteLength) <= BigInt(maxBytes), 'bounded content ref required');
    const token = await objects.prove(ref, checkOpen);
    try {
      const bytes = Buffer.alloc(Number(ref.byteLength));
      for (let offset = 0; offset < bytes.length; offset += MiB) Buffer.from(objects.readRange(ref, String(offset), Math.min(MiB, bytes.length - offset))).copy(bytes, offset);
      objects.proven(ref, token); check(hash(bytes) === ref.hash, 'read content hash mismatch'); return { bytes, token, ref };
    } catch (error) { objects.releaseProof(token); throw error; }
  }
  async function sourceWitness(ref) {
    const old = sourceCache.get(ref.hash);
    if (old) {
      check(canonical(old.ref) === canonical(ref), 'source identity changed');
      for (const proof of old.proofs) objects.proven(proof.ref, proof.token);
      for (const font of old.source.text.fonts) { const proof = fontProofs.get(font.bytes.hash); check(proof && canonical(proof.ref) === canonical(font.bytes), 'cached font proof missing'); objects.proven(proof.ref, proof.token); }
      return old.source;
    }
    const proofs = [];
    try {
      const raw = await readProved(ref, 65536); proofs.push(raw);
      const source = textValidation.validateSource(JSON.parse(raw.bytes.toString('utf8')));
      const layout = await readProved(source.render.layout, 8 * MiB); proofs.push(layout);
      const text = await readProved(source.text.textUtf8, 16384); proofs.push(text);
      textValidation.validateLayout(source, layout.bytes, text.bytes);
      check(textValidation.dependencyIdentity(source) === source.render.dependencyHash, 'text dependency hash mismatch');
      for (const font of source.text.fonts) {
        let proof = fontProofs.get(font.bytes.hash);
        if (proof) { check(canonical(proof.ref) === canonical(font.bytes), 'font identity changed'); objects.proven(proof.ref, proof.token); }
        else { check(fontProofs.size < 128 && BigInt(font.bytes.byteLength) <= 16n * BigInt(MiB), 'font verification bound'); const token = await objects.prove(font.bytes, checkOpen); fontProofs.set(font.bytes.hash, { ref: font.bytes, token }); }
      }
      if (sourceCache.size >= 256) { const first = sourceCache.keys().next().value; for (const proof of sourceCache.get(first).proofs) objects.releaseProof(proof.token); sourceCache.delete(first); }
      sourceCache.set(ref.hash, { ref, source, proofs: proofs.map(({ ref, token }) => ({ ref, token })) }); return source;
    } catch (error) { for (const proof of proofs) objects.releaseProof(proof.token); throw error; }
  }
  async function fontsForDocuments(documents) {
    const states = new Map();
    for (const document of documents) { validators.document(document); check(document.id === cycle.documentId && document.image, 'current document image required'); states.set(document.image.state.hash, document.image.state); }
    const witnesses = [];
    for (const ref of states.values()) {
      const raw = await readProved(ref, 65536);
      try {
        const state = JSON.parse(raw.bytes.toString('utf8')); history.imageState(state);
        const sources = [], sourceRefs = [];
        for (const layer of state.layers) if (layer.kind === 'text') { sources.push(await sourceWitness(layer.source)); sourceRefs.push({ layerId: layer.id, source: layer.source }); }
        witnesses.push({ state: ref, textLayers: sources.length, sources: sourceRefs, ...lifecycleFontUnion(sources), validatedLayoutFontReferences: true });
      } finally { objects.releaseProof(raw.token); }
    }
    return witnesses;
  }
  const compactBracket = value => ({ atMs: value.atMs, writerEpoch: value.writerEpoch, highWater: value.highWater, commandRowid: value.commandRowid, journalSeq: value.journalSeq,
    document: { id: value.document.id, revision: value.document.revision, image: value.document.image }, queue: lifecycleQueueCounts(value.jobs), queueProjectionSha256: hash(canonical(value.jobs)), publicQueue: value.publicQueue });
  async function observe({ label }) {
    check(cycle, 'cycle not started'); const startMs = performance.now();
    try {
      const observed = await readPhaseSnapshot(page, handle => {
        const phases = handle?.value, a = phases?.allocations;
        if (!a) return null;
        return { producerSchemaVersion: a.schemaVersion, fontShapingCpuBytes: a.byKind?.font?.cpuBytes + a.byKind?.text?.cpuBytes,
          glyphGpuBytes: a.byKind?.font?.gpuBytes + a.byKind?.text?.gpuBytes, captionWorkspaceBytes: a.promptBytes,
          complete: false, producerBasis: a.basis, peakScope: a.peakScope, textPeakBasis: a.text?.peakBasis,
          compositionObservations: phases?.compositionObservations ?? null };
      });
      cycle.allocations.push({ label, startMs, endMs: performance.now(), ...(observed ?? { unavailable: true }), complete: false });
    } catch { issue(cycle, 'allocation-observation-failed'); }
  }
  async function startCycle({ cycleOrdinal, documentId, fixtureIdentity: fixtureOverride, processIdentity: processOverride }) {
    checkOpen(); check(!cycle && natural(cycleOrdinal) && cycleOrdinal > 0, 'one positive cycle ordinal at a time');
    cycle = { cycleOrdinal, documentId, fixtureIdentity: fixtureOverride ?? fixtureIdentity, processIdentity: processOverride ?? processIdentity, startedMs: performance.now(), requests: [], allocations: [], issues: [] };
    try {
      if (required.has('R35FontShapingCpuBytes') || required.has('R35GlyphGpuBytes')) {
        cycle.textResources = createTextResourceObserver({ page, cell, cycleOrdinal, fixtureIdentity: cycle.fixtureIdentity, processIdentity: cycle.processIdentity, rendererOwnershipProof, executableIdentity, output, journal });
        await cycle.textResources.begin();
      }
      cycle.before = await stableBracket(documentId); await observe({ label: 'before-open' }); }
    catch (error) { issue(cycle, 'baseline-' + errorCode(error)); /* finishCycle retains the failed bracket. */ throw error; }
  }
  async function finishCycle({ failed = false } = {}) {
    check(cycle, 'cycle not started'); const owner = cycle, metrics = [], evidence = {}, missing = [];
    const add = (name, value, method, complete) => { if (required.has(name) && natural(value)) metrics.push({ name, value, unit: name.endsWith('Bytes') ? 'bytes' : name.endsWith('Count') ? 'violations' : 'count', method, complete: !failed && complete }); };
    let end, eventsComplete = false, requestComplete = false, documents = [];
    try {
      await Promise.allSettled([...pending]); await observe({ label: failed ? 'failed-cycle' : 'after-release' });
      if (owner.before) {
        try { end = await stableBracket(owner.documentId, owner.before); }
        catch { issue(owner, 'final-authoritative-bracket-incomplete'); }
      }
      if (end) {
        try {
          let seq = BigInt(owner.before.highWater);
          evidence.events = [];
          for (const row of end.events) {
            check(BigInt(row.seq) === ++seq, 'workspace event gap');
            const bytes = Buffer.from(row.json, 'utf8'), value = JSON.parse(row.json), witness = inspectLifecycleEnvelope(bytes, { kind: 'event', validateEvent: validators.event });
            evidence.events.push(witness);
            check(witness.typed && witness.workspaceSeq === row.seq && value.commandId === row.command_id && value.transactionId === row.transaction_id, 'event row binding failed');
            if (value.documentId === owner.documentId && value.payload?.document) documents.push(value.payload.document);
          }
          check(seq === BigInt(end.highWater), 'workspace range incomplete'); eventsComplete = true;
        } catch { issue(owner, 'event-range-proof-incomplete'); }
        try {
          evidence.commands = [];
          for (const row of end.commands) {
            const witness = envelope(Buffer.from(row.original, 'utf8')); evidence.commands.push({ ...witness, rowid: row.rowid });
            check(witness.typed && witness.commandId === row.id, 'stored command binding failed');
            const receipt = JSON.parse(row.receipt); evidence.commands.at(-1).receiptStatus = receipt.status;
          }
          for (const command of evidence.commands) check(owner.requests.some(r => r.commandId === command.commandId && r.sha256 === command.sha256), 'durable command missing its actual transport witness');
          for (const command of owner.requests) {
            check(command.typed && command.response && command.response.commandId === command.commandId, 'command response binding incomplete');
            const stored = db.prepare('SELECT original FROM commands WHERE id=?').get(command.commandId);
            check(stored && hash(Buffer.from(stored.original, 'utf8')) === command.sha256, 'observed command differs from durable original');
          }
          requestComplete = !owner.issues.some(code => code.startsWith('command-')) && owner.requests.length > 0;
        } catch { issue(owner, 'command-range-proof-incomplete'); }
        try {
          const records = end.journal.map(row => ({ seq: String(row.seq), value: JSON.parse(row.json), sha256: hash(row.json) }));
          evidence.queue = replayLifecycleQueue({ before: owner.before.jobs, after: end.jobs, records, fromSeq: owner.before.journalSeq, toSeq: end.journalSeq });
          add('R25ActiveRequests', evidence.queue.maximum.active, 'Every durable queue journal mutation, exact held-attempt predicate, public boundary inventories', true);
          add('R25PendingEntries', evidence.queue.maximum.pending, 'Every durable queue journal mutation, exact noncancelled/not-started admission predicate', true);
        } catch { issue(owner, 'queue-journal-proof-incomplete'); }
        if ([...required].some(name => name.startsWith('R35'))) {
          try {
            check(eventsComplete, 'complete document event range required');
            evidence.fonts = await fontsForDocuments([owner.before.document, ...documents, end.document]);
            evidence.fontByteProofs = [...fontProofs.values()].map(({ ref }) => ({ ref, verification: 'complete-production-Objects.prove-SHA256-and-current-immutable-stamp' }));
            add('R35CurrentFontFaces', Math.max(...evidence.fonts.map(v => v.faces)), 'Union of fully proved font face identities in every accepted current document image state', true);
            add('R35SingleFontBytes', Math.max(...evidence.fonts.map(v => v.singleBytes)), 'Full production Objects.prove SHA256 and immutable proof stamps, actual font bytes', true);
            add('R35CurrentFontSetBytes', Math.max(...evidence.fonts.map(v => v.setBytes)), 'Deduplicated fully proved font file bytes in each complete current document image state', true);
            add('R35SilentFontSubstitutionCount', 0, 'Every accepted TextSource and layout validated against declared font identities and actual proved layout/font/text bytes; no native-display claim', true);
          } catch { issue(owner, 'font-union-or-layout-proof-incomplete'); }
        }
      }
      const commandWitnesses = [...owner.requests, ...(evidence.commands ?? [])], eventWitnesses = evidence.events ?? [];
      if (commandWitnesses.length) add('R21CommandUtf8Bytes', Math.max(...commandWitnesses.map(v => v.byteLength)), 'Exact POST body UTF8 bytes and durable original command bytes, complete cycle bracket', requestComplete);
      if (eventWitnesses.length) add('R21EventUtf8Bytes', Math.max(...eventWitnesses.map(v => v.byteLength)), 'Exact durable canonical event JSON UTF8 bytes; JSONL framing excluded', eventsComplete);
      const inline = owner.requests.reduce((n, v) => n + v.inlineViolations, 0) + eventWitnesses.reduce((n, v) => n + v.inlineViolations, 0);
      if (commandWitnesses.length || eventWitnesses.length) add('R21InlineBinaryOrDataUris', inline, 'Production typed envelope schemas plus recursive data-URI/explicit binary-field inspection; no prompt contents retained', requestComplete && eventsComplete);
      const allocations = lifecycleAllocationObservations(owner.allocations);
      if (owner.textResources) {
        try {const result = await owner.textResources.finish({ failed }); const { proof: _proof, ...retained } = result;evidence.textResources = retained;for (const row of result.measurements) if (required.has(row.name)) metrics.push(row);for (const code of result.missing) issue(owner, code);}
        catch {issue(owner, 'text-resource-window-finalization-failed');}
      }
      if (!metrics.some(row => row.name === 'R35FontShapingCpuBytes')) add('R35FontShapingCpuBytes', allocations.fontShapingCpuBytes, 'Endpoint reservation lower bound; synchronous text resource window unavailable', false);
      if (!metrics.some(row => row.name === 'R35GlyphGpuBytes')) add('R35GlyphGpuBytes', allocations.glyphGpuBytes, 'Endpoint glyph reservation lower bound; reviewed ownership window unavailable', false);
      const composition = projectLifecycleComposition({allocations: owner.allocations, required: [...required], failed});
      evidence.composition = composition.evidence;
      for (const row of composition.measurements) if (required.has(row.name)) metrics.push(row);
      missing.push(...composition.evidence.missing);
      for (const name of required) if (!metrics.some(row => row.name === name && row.complete)) missing.push(name + ': ' + (metrics.some(row => row.name === name) ? 'actual observed lower bound; complete cycle coverage unavailable' : 'no complete actual producer or boundary proof'));
      const endedMs = performance.now();
      const artifactValue = { kind: 'lifecycle-counters-artifact-1', schemaVersion: 1, cellId: cell.id, cycleOrdinal: owner.cycleOrdinal,
        fixtureIdentity: owner.fixtureIdentity, processIdentity: owner.processIdentity, failed, startedMs: owner.startedMs, endedMs,
        clock: 'runner-monotonic', chargedObserverWork: true, binding, before: owner.before ? compactBracket(owner.before) : null, after: end ? compactBracket(end) : null,
        requests: owner.requests, allocations: owner.allocations, evidence, metrics, missing, issues: owner.issues,
        privacy: 'Only byte counts, hashes, typed identities and numeric producer witnesses; raw replay remains in the bound private SQLite/object sources',
        limits: { journalRows: ROW_LIMIT, bytesPerRange: BYTE_LIMIT, sourceCacheEntries: 256, fontProofs: 128, maximumFontBytes: 16 * MiB },
        scope: { acceptedDocumentStates: true, transientDraftFonts: evidence.textResources?.complete === true, physicalAllocations: false, nativeDisplay: false, captionCompleteness: false } };
      const bytes = Buffer.from(JSON.stringify(artifactValue, null, 2) + '\n'); check(bytes.length <= 8 * MiB, 'artifact observer bound');
      const directory = join(output, 'lifecycle-counters'); await mkdir(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, 'cycle-' + String(owner.cycleOrdinal).padStart(3, '0') + '.json'); await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
      const artifact = { path, bytes: bytes.length, sha256: hash(bytes) };
      if (LIFECYCLE_COMPOSITION_NAMES.some(name => required.has(name))) await journal?.({event: 'lifecycle-composition-observed', cellId: cell.id,
        cycleOrdinal: owner.cycleOrdinal, fixtureIdentity: owner.fixtureIdentity, processIdentity: owner.processIdentity,
        startedMs: owner.startedMs, endedMs, artifact});
      return { measurements: metrics.map(row => ({ ...row, evidence: { kind: 'lifecycle-measurement-evidence-1', cellId: cell.id, cycleOrdinal: owner.cycleOrdinal,
        processIdentity: owner.processIdentity, fixtureIdentity: owner.fixtureIdentity, coverage: row.complete ? 'complete-cycle-actions' : 'observed-partial-cycle-actions', artifact } })), missing, artifact,
        observations: { requests: owner.requests.length, events: evidence.events?.length ?? null, queueMutations: end?.journal.length ?? null, issues: owner.issues } };
    } finally { cycle = null; }
  }
  async function close() {
    if (closed) return; page.off('request', recordRequest); page.off('response', recordResponse); await Promise.allSettled([...pending]);
    for (const proof of fontProofs.values()) objects.releaseProof(proof.token);
    for (const value of sourceCache.values()) for (const proof of value.proofs) objects.releaseProof(proof.token);
    fontProofs.clear(); sourceCache.clear(); objects.close(); db.close(); closed = true;
  }
  return { startCycle, observe, finishCycle, close };
}
