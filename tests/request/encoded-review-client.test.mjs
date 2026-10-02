import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformWithOxc } from 'vite';

// Exercise the current owned command/delivery/cancellation methods. Journal
// persistence, authenticated transport and pending projection are boundary
// doubles; checkpoint, control, response and allocation owners are real.
import { allocationsURL, modelMemoryURL, promptMemoryURL } from '../ui-model-module.mjs';
import { draftStateDependencies, jsonResponse } from '../draft-state-module.mjs';
const { draftURL, commandsURL, controlURL } = await draftStateDependencies(allocationsURL, {
  root: '.', commandsRoot: '.', memoryURL: modelMemoryURL, promptURL: promptMemoryURL,
});
const { DraftPersistence } = await import(draftURL);
const { CommandControlReads } = await import(commandsURL);
const { allocationLedger } = await import(allocationsURL);
const data = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
const source = (await transformWithOxc(await readFile('src/state/editor-client.ts', 'utf8'), 'editor-client.ts')).code
  .replace(/^import\s+[\s\S]*?\sfrom\s+["'][^"']+["'];?\n/gm, '');
const { EditorClient } = await import(data(`
import { reserveCommandWire } from ${JSON.stringify(controlURL)};
import { readOwnedJSON } from ${JSON.stringify(modelMemoryURL)};
import { COMMAND_RESULT_LIMITS } from ${JSON.stringify(commandsURL)};
const EMPTY_EXPECTED_VERSIONS={hash:'sha256:'+'0'.repeat(64),byteLength:'0',mediaType:'application/json'};
const browserPhases={resetNavigation(){},recorder:{start:()=>({end(){}})},adoptionFailed(){}};
` + source));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
const observe = promise => promise.then(value => ({ value }), error => ({ error }));
const response = jsonResponse;
const canceledReceipt = id => ({ protocolVersion: 1, kind: 'receipt', receipt: { status: 'rejected', commandId: id, code: 'INVALID_INPUT', currentRevision: '7', details: { hash: 'sha256:' + '1'.repeat(64), byteLength: '2', mediaType: 'application/json' } }, rejectionDetails: { kind: 'inline', value: { code: 'ENCODED_REBUILD_REVIEW_CANCELED' } } });

const resources = () => { const { cpuBytes, handles, activeRecords } = allocationLedger.snapshot(); return { cpuBytes, handles, activeRecords }; };
const fixtures = new Set(); let baseline;
test.beforeEach(() => { baseline = resources(); });
test.afterEach(async () => {
  const outcomes = await Promise.allSettled([...fixtures].map(fixture => fixture.close())); fixtures.clear();
  const errors = outcomes.filter(outcome => outcome.status === 'rejected').map(outcome => outcome.reason);
  if (errors.length) throw new AggregateError(errors, 'Encoded review fixture cleanup failed');
  assert.deepEqual(resources(), baseline, 'Every checkpoint, command and cancellation response owner drains');
});

function fixture() {
  const requests = [], rows = new Map(), callbacks = [], pending = new Set(), journalGate = deferred(), admission = deferred(), submitted = deferred(), terminal = deferred(), cancelEntered = deferred(), cancelReply = deferred();
  let identity = 'original-owner', initialPut = true, admitted = false, commandId, cancellationReply;
  const track = promise => { pending.add(promise); void promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise; };
  const session = { identity: () => identity, csrf: () => 'fixture-csrf', async transport(path, init = {}) {
    requests.push({ path, init, identity });
    if (path === '/api/v1/commands' && init.method === 'POST') { commandId = JSON.parse(init.body).command.commandId; submitted.resolve(commandId); return admission.promise; }
    if (path.endsWith('/cancel-candidate-review')) {
      cancelEntered.resolve();
      if (cancellationReply !== undefined) return response(cancellationReply);
      await cancelReply.promise; return response({ protocolVersion: 1, commandId: JSON.parse(init.body).commandId, status: 'canceled' });
    }
    if (path === '/api/v1/commands/' + commandId) return response(await terminal.promise);
    throw Error('Unexpected transport ' + path);
  } };
  // Keep unrelated constructor-owned document models outside this fixture. The
  // checkpoint setter, scoped command methods and response readers stay real.
  const client = Object.create(EditorClient.prototype), document = { id: 'document', revision: '7' };
  client.session = session; client.owner = 'original-owner'; client.lifecycle = 1; client.documentLifetime = 1;
  client.controlReads = new CommandControlReads();
  client.importAdmissions = new Map(); client.exportAdmissions = new Map(); client.reviewAdmissions = new Map();
  client.draftOwner = new DraftPersistence('original-session', session.transport.bind(session), session.csrf);
  client.draftOwner.checkpoint = { sessionId: 'original-session', uiSeq: '0', preferences: { documentId: document.id, tool: 'select', viewport: { x: 0, y: 0, zoom: 1 }, panels: { left: 280, right: 320, active: 'layers' }, selectedLayerIds: [] }, drafts: [], reconciledLayerIds: [] };
  client.ui = client.draftOwner.checkpoint;
  assert.equal(client.ui, client.draftOwner.checkpoint);
  Object.defineProperty(client, 'view', { get: () => ({ document }) });
  client.journal = { async put(key, value) { if (initialPut) { initialPut = false; await journalGate.promise; } rows.set(key, structuredClone(value)); } };
  client.restorePending = async () => {};
  const body = { type: 'ReviewCandidatePlacement', preparation: 'encoded-rebuild', candidateId: 'candidate', mode: 'safe-region', placement: 'new-document', newDocumentId: 'new-document', newLayerId: 'new-layer', name: 'Encoded fixture', actualOutput: null };
  const f = { client, session, requests, rows, callbacks, journalGate, admission, submitted, terminal, cancelEntered, cancelReply, body,
    owner: () => ({ session, identity: 'original-owner' }), identity(value) { identity = value; },
    start(callback, command = body) {
      return observe(track((async () => {
        const result = await client.ownedCommand(command, document, undefined, id => { callbacks.push(id); callback?.(id); });
        try { return undefined; } finally { result.release(); }
      })()));
    },
    cancel(id, owner = f.owner()) {
      return track((async () => {
        const result = await client.ownedCancelCandidateReview(id, owner);
        // Copy only assertion scalars while the actual response root is owned.
        try { return { protocolVersion: result.value.protocolVersion, commandId: result.value.commandId, status: result.value.status }; }
        finally { result.release(); }
      })());
    },
    replyCancellation(value) { cancellationReply = value; },
    admit() { if (!admitted) { admitted = true; admission.resolve(response({ protocolVersion: 1, kind: 'pending', commandId, phase: 'working' })); } },
    finish(id) { terminal.resolve(canceledReceipt(id)); },
    cancellations() { return requests.filter(row => row.path.endsWith('/cancel-candidate-review')); },
    async close() {
      journalGate.resolve(); if (commandId) f.admit(); cancelReply.resolve(); f.finish(commandId);
      try { await client.controlReads.release(); await Promise.allSettled([...pending]); }
      finally { client.ui = undefined; await client.draftOwner.dispose(); }
      assert.equal(client.reviewAdmissions.size, 0); assert.equal(client.controlReads.ownership.controlReads, 0);
    },
  };
  fixtures.add(f); return f;
}

test('original review is journaled and admitted before cancellation, without waiting for full review completion', async () => {
  const f = fixture(); let cancellation, completed = false;
  const original = f.start(id => { assert(f.rows.has('command:' + id)); cancellation = f.cancel(id, f.owner()); });
  original.then(() => { completed = true; });
  await flush(); assert.deepEqual(f.callbacks, []); assert.deepEqual(f.requests, []);
  f.journalGate.resolve(); const id = await f.submitted.promise; await flush();
  assert.deepEqual(f.callbacks, [id]); assert.equal(f.cancellations().length, 0);
  assert.deepEqual(JSON.parse(f.requests[0].init.body).command.body, f.body);
  f.admit(); await f.cancelEntered.promise; assert.equal(completed, false);
  const request = f.cancellations()[0]; assert.equal(request.path, '/api/v1/commands/' + id + '/cancel-candidate-review');
  assert.equal(request.init.method, 'POST'); assert.deepEqual(JSON.parse(request.init.body), { protocolVersion: 1, commandId: id });
  f.cancelReply.resolve(); assert.deepEqual(await cancellation, { protocolVersion: 1, commandId: id, status: 'canceled' });
  assert.equal(completed, false); f.finish(id);
  assert.match((await original).error?.message ?? '', /ENCODED_REBUILD_REVIEW_CANCELED/);
  assert.equal(f.client.reviewAdmissions.size, 0); assert.equal(f.requests.filter(row => row.path === '/api/v1/commands').length, 1);
});

test('a failed journal does not publish a cancellable original command', async () => {
  const f = fixture(), original = f.start(); f.journalGate.reject(Error('JOURNAL_QUOTA'));
  assert.match((await original).error?.message ?? '', /JOURNAL_QUOTA/);
  assert.deepEqual(f.callbacks, []); assert.deepEqual(f.requests, []); assert.equal(f.client.reviewAdmissions.size, 0);
});

for (const boundary of ['identity', 'session']) test('old ' + boundary + ' is refused after waiting for original admission', async () => {
  const f = fixture(); let cancellation;
  const original = f.start(id => { cancellation = observe(f.cancel(id, f.owner())); });
  f.journalGate.resolve(); const id = await f.submitted.promise;
  if (boundary === 'identity') f.identity('replacement-owner'); else f.client.session = { ...f.session };
  f.admit(); assert.match((await cancellation).error?.message ?? '', /CANDIDATE_REVIEW_CANCELLATION_OWNER_CHANGED/);
  assert.equal(f.cancellations().length, 0); f.finish(id); await original;
});

test('an already replaced or absent session owner is refused before transport', async () => {
  for (const identity of [null, 'replacement']) {
    const f = fixture(); f.identity(identity);
    await assert.rejects(f.cancel('retained-review-command', f.owner()), /CANDIDATE_REVIEW_CANCELLATION_OWNER_CHANGED/);
    assert.deepEqual(f.requests, []);
  }
});

test('repeated cancellation after admission stays bound to the same original command', async () => {
  const f = fixture(); let first, second;
  const original = f.start(id => { first = f.cancel(id, f.owner()); second = f.cancel(id, f.owner()); });
  f.journalGate.resolve(); const id = await f.submitted.promise; await flush(); assert.equal(f.cancellations().length, 0);
  f.admit(); await f.cancelEntered.promise; f.cancelReply.resolve(); await Promise.all([first, second]);
  f.finish(id); await original;
  await f.cancel(id, f.owner());
  assert.equal(f.cancellations().length, 3);
  assert(f.cancellations().every(row => JSON.parse(row.init.body).commandId === id));
  assert.equal(f.requests.filter(row => row.path === '/api/v1/commands').length, 1);
  assert.equal(f.client.reviewAdmissions.size, 0);
});

test('ordinary review commands create no encoded-review cancellation admission or request', async () => {
  const f = fixture(), { preparation, ...ordinary } = f.body, original = f.start(undefined, ordinary);
  f.journalGate.resolve(); const id = await f.submitted.promise;
  assert.equal(f.client.reviewAdmissions.size, 0); f.admit(); f.finish(id); await original;
  assert.equal(f.cancellations().length, 0); assert.equal(Object.hasOwn(JSON.parse(f.requests[0].init.body).command.body, 'preparation'), false);
});

test('malformed cancellation identity cannot be reported as successful release', async () => {
  const f = fixture(); f.replyCancellation({ protocolVersion: 1, commandId: 'different-original', status: 'canceled' });
  await assert.rejects(f.cancel('original-command', f.owner()), /CANDIDATE_REVIEW_CANCELLATION_UNCONFIRMED/);
});
