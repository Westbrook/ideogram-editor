import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { assertCell, processTreeRows, interactionSession } from '../../tooling/qualification/campaigns/browser.mjs';
import { acceptedCommand, interactionPlan, publicRead, runBrowserAction, verifiedCorpusFile, validateBrowserGestures } from '../../tooling/qualification/campaigns/browser-driver.mjs';

test('RSS attribution includes real descendants once and excludes unrelated processes', () => {
  const rows = ' 1 0 10\n10 1 100\n11 10 200\n12 11 300\n20 1 400\n21 20 500\n';
  const browser = processTreeRows(rows, [10, 11]);
  assert.deepEqual(browser.map(row => row.pid), [10, 11, 12]);
  assert.equal(browser.reduce((sum, row) => sum + row.rssBytes, 0), 600 * 1024);
  assert.deepEqual(processTreeRows(rows, [20]).map(row => row.pid), [20, 21]);
  assert.deepEqual(processTreeRows(rows, [999]), []);
});

test('malformed process rows cannot masquerade as zero RSS', () => {
  for (const row of ['1 0 NaN', '1 0 -1', '0 0 12', '1 0 1.5', '1 secret 12']) assert.throws(() => processTreeRows(row, [1]));
});

test('session evidence retains actual work and cannot invent presentation, clock joins, or refresh rate', () => {
  const source = { startMs: 1, endMs: 60001, captureStoppedMs: 60011, actions: [{ kind: 'stroke', inputMs: 10, samples: [{ inputMs: 11, presentedMs: 20 }] }, { kind: 'theme', inputMs: 60005, presentedMs: 60006 }] };
  const value = interactionSession({ id: 'I-W1', operation: 'interaction.brush' }, { cache: 'warm', ordinal: 1 }, source, { artifact: { sha256: 'a'.repeat(64) } }, 'visible');
  assert.deepEqual(value.actions.map(action => action.kind), ['stroke', 'discrete']);
  assert.equal(value.actions[0].samples[0].presentedMs, null); assert.equal(value.actions[1].presentedMs, null);
  assert.equal(value.refreshHz, null); assert.equal(value.trace.attributionComplete, false); assert.deepEqual(value.activeSegments, []);
  assert.equal(value.endMs, 60001); assert.equal(value.captureStoppedMs, 60011);
  assert.equal(value.actions[1].inputMs, 60005, 'A late action stays in the receipt for the evaluator; the observation boundary is not stretched');
  assert.equal(new Set(value.actions.map(action => action.id)).size, 2);
  const native = interactionSession({ operation: 'text.interaction' }, { cache: 'cold', ordinal: 1 }, { observations: { segment: { startMs: 20, endMs: 60020 }, actions: [{ kind: 'preedit', inputMs: 40, outcome: 'failed' }], textPresentation: { staleSessionGenerationVersionRejected: null } } }, {}, 'hidden');
  assert.equal(native.actions[0].outcome, 'failed'); assert.equal(native.textPresentation.staleSessionGenerationVersionRejected, null);
  const actualInputs = interactionSession({ id: 'I-W2', operation: 'interaction.brush' }, { cache: 'warm', ordinal: 2 },
    { clock: 'browser-performance', timeOrigin: 123, startMs: 100, endMs: 60100, captureStoppedMs: 60104,
      unscoredPreparation: { startMs: 0, endMs: 99, includedInCanonicalVisit: true },
      actions: [{ kind: 'stroke', inputMs: 101, samples: [{ inputMs: 102, presentedMs: null }] }] }, {}, 'visible');
  assert.equal(actualInputs.clock, 'browser-performance'); assert.equal(actualInputs.timeOrigin, 123);
  assert.equal(actualInputs.unscoredPreparation.includedInCanonicalVisit, true);
  assert.equal(actualInputs.actions[0].samples[0].inputMs, 102); assert.equal(actualInputs.trace.attributionComplete, false);
});

test('browser samples require explicit operations and real wall clocks', () => {
  for (const cell of [{}, { operation: '../run' }, { operation: 'navigation.ready', parameters: { fakeClock: true } }, { operation: 'interaction.brush', parameters: { syntheticTime: 60000 } }]) assert.throws(() => assertCell(cell));
  assert.deepEqual(assertCell({ operation: 'queue.fault', parameters: { fakeClock: 'scheduler-history-only' } }), { fakeClock: 'scheduler-history-only' });
  assert.deepEqual(assertCell({ operation: 'navigation.ready', parameters: {} }), {});
});

test('fixed brush and interaction plans cannot silently reduce the specified work', () => {
  const plan = interactionPlan(); assert.equal(plan.length, 100);
  assert.equal(plan.filter(action => action.kind === 'stroke').length, 20);
  assert.equal(plan.filter(action => action.kind !== 'stroke').length, 80);
  assert.equal(plan.filter(action => action.kind === 'undo').length, 20);
  for (const kind of ['pan', 'zoom', 'layer', 'theme', 'density', 'split']) assert.equal(plan.filter(action => action.kind === kind).length, 10);
  for (const kind of ['pan', 'zoom', 'undo', 'theme', 'density', 'split']) {
    const family = plan.filter(action => action.kind === kind);
    assert.deepEqual(family.map(action => action.variant), family.map((_, index) => index % 2), kind + ' alternates per family rather than unrelated global parity');
  }
  for (let index = 0; index < plan.length; index += 5) {
    assert.equal(plan[index].kind, 'stroke'); assert.equal(plan[index + 1].kind, 'undo');
  }
});

test('exact sealed portable gestures cannot silently replace the release point or shorten the event count', () => {
  const gestures = Array.from({ length: 100 }, (_, stroke) => ({ id: 'stroke-' + String(stroke + 1).padStart(3, '0'), brushDiameter: 64, sampleHz: 60, samples: Array.from({ length: 120 }, (_, index) => ({ x: Math.min(index, 118), y: stroke, timeMs: index * 1000 / 60 })) }));
  assert.equal(validateBrowserGestures(gestures), gestures);
  assert.throws(() => validateBrowserGestures(gestures.slice(1)), /exactly 100/);
  const releaseChanged = structuredClone(gestures); releaseChanged[0].samples[119].x++;
  assert.throws(() => validateBrowserGestures(releaseChanged), /release/);
  const wrongTiming = structuredClone(gestures); wrongTiming[1].samples[3].timeMs++;
  assert.throws(() => validateBrowserGestures(wrongTiming), /schedule/);
});

test('unknown workflows and unavailable provider never invoke a product action', async () => {
  const page = new Proxy({}, { get() { throw Error('Unexpected page action'); } });
  for (const operation of ['invented.workflow', 'fast.workflow']) await assert.rejects(runBrowserAction({ page, cell: { operation }, fixture: {} }), error => error.code === 'CAMPAIGN_PREREQUISITE');
});

test('public witness reads cannot reach arbitrary endpoints', async () => {
  const page = { evaluate() { throw Error('Unexpected fetch'); } };
  for (const route of ['https://example.invalid', '/api/v1/session', '/api/v1/provider', '/admin', '/api/v1/assets-secret']) await assert.rejects(publicRead(page, route), /Unapproved/);
});

test('durable witness waits beyond initial pending acknowledgement and records no request payload', async () => {
  let observed = 0, action = 0;
  const page = {
    waitForResponse: async predicate => {
      const response = { request: () => ({ method: () => 'POST', postDataJSON: () => ({ command: { body: { type: 'AdoptCandidate', prompt: 'private payload' } } }) }), url: () => 'http://127.0.0.1:1234/api/v1/commands', json: async () => ({ kind: 'pending', commandId: 'command-1' }) };
      assert.equal(predicate(response), true); return response;
    },
    evaluate: async (_fn, path) => { assert.equal(path, '/api/v1/commands/command-1'); observed++; return observed === 1 ? { kind: 'pending' } : { kind: 'receipt', receipt: { commandId: 'command-1', status: 'accepted' } }; },
  };
  const receipt = await acceptedCommand(page, 'AdoptCandidate', async () => { action++; });
  assert.equal(action, 1); assert.equal(observed, 2); assert.equal(receipt.commandId, 'command-1'); assert.equal(receipt.status, 'accepted');
  assert(!JSON.stringify(receipt).includes('private payload'));
});

test('rejected durable receipts remain failures after a successful HTTP response', async () => {
  const page = { waitForResponse: async () => ({ json: async () => ({ receipt: { commandId: 'c', status: 'rejected' } }) }) };
  await assert.rejects(acceptedCommand(page, 'AdoptCandidate', async () => {}), /not accepted/);
});

test('corpus imports verify exact bytes and codec identity before exposing a file to browser', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'campaign-browser-corpus-'));
  try {
    const path = join(directory, 'fixture.bin'), bytes = Buffer.from('sealed local fixture'); await writeFile(path, bytes);
    const file = { role: 'raster-original', format: 'webp', codec: 'lossy', path, byteLength: String(bytes.length), sha256: 'sha256:' + createHash('sha256').update(bytes).digest('hex') };
    const fixture = { corpus: { files: [file] } };
    assert.equal(await verifiedCorpusFile(fixture, 'raster-original', row => row.codec === 'lossy'), path);
    await assert.rejects(verifiedCorpusFile(fixture, 'raster-original', row => row.codec === 'lossless'), /Missing sealed/);
    await writeFile(path, 'changed'); await assert.rejects(verifiedCorpusFile(fixture, 'raster-original'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
