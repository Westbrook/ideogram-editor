// Source-only staged tests. Deliberately not executed during the JPEG03 freeze.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { inspectLifecycleEnvelope, lifecycleQueueCounts, replayLifecycleQueue, lifecycleFontUnion, lifecycleAllocationObservations } from '../../tooling/qualification/campaigns/browser-lifecycle-counters.mjs';

const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const command = value => ({ protocolVersion: 1, command: { commandId: 'command', body: { type: 'SaveCheckpoint', name: value } } });
// Pure-unit validator doubles exercise observer behavior; integration MUST load
// built production validators. These are not an assertion of schema validity.
const parser = bytes => JSON.parse(Buffer.from(bytes).toString('utf8'));
const attempt = (id, state = 'not-started', hold = false) => ({ id, state, hold });
const job = (id, attempts, local = 'accepted-local-queue') => ({ id, local, attempts });
const journal = (seq, value) => ({ seq: String(seq), value: { family: 'job', event: 'ObservedActualChange', epoch: 'epoch', value }, sha256: hash(JSON.stringify(value)) });

test('UTF8 measurement uses exact bytes, retaining neither prompt nor envelope text', () => {
  const bytes = Buffer.from(JSON.stringify(command('é🖼 retained private text')));
  const result = inspectLifecycleEnvelope(bytes, { kind: 'command', parseCommand: parser });
  assert.equal(result.byteLength, bytes.length); assert.equal(result.sha256, hash(bytes)); assert.equal(result.typed, true);
  assert.equal(result.commandId, 'command'); assert.equal(result.inlineViolations, 0);
  assert(!JSON.stringify(result).includes('retained private text')); assert(!JSON.stringify(result).includes('é'));
});

test('malformed/unvalidated envelopes never provide complete zero-binary evidence', () => {
  const result = inspectLifecycleEnvelope(Buffer.from('{bad'), { kind: 'command', parseCommand: parser });
  assert.equal(result.typed, false); assert.equal(result.byteLength, 4);
  const tooLarge = inspectLifecycleEnvelope(Buffer.alloc(65537), { kind: 'command', parseCommand: () => { throw Error('must not parse'); } });
  assert.equal(tooLarge.byteLength, 65537); assert.equal(tooLarge.typed, false);
});

test('data URIs are counted without disclosing their contents or mistaking affine arrays for bytes', () => {
  const value = command('data:image/png;base64,secret'), bytes = Buffer.from(JSON.stringify(value));
  const result = inspectLifecycleEnvelope(bytes, { kind: 'command', parseCommand: parser });
  assert.equal(result.inlineViolations, 1); assert(!JSON.stringify(result).includes('secret'));
  value.command.body.name = 'ordinary'; value.command.body.transform = [1, 0, 0, 1, 0, 0];
  assert.equal(inspectLifecycleEnvelope(Buffer.from(JSON.stringify(value)), { kind: 'command', parseCommand: parser }).inlineViolations, 0);
});

test('event measurement is exact JSON UTF8 without a manufactured JSONL newline', () => {
  const bytes = Buffer.from('{"workspaceSeq":"23","commandId":"command","type":"ImageEdited"}');
  const value = inspectLifecycleEnvelope(bytes, { kind: 'event', validateEvent: event => assert.equal(event.type, 'ImageEdited') });
  assert.equal(value.byteLength, bytes.length); assert.equal(value.workspaceSeq, '23'); assert.equal(value.typed, true);
});

test('pending admission predicate excludes locally cancelled jobs but counts held attempts independently', () => {
  assert.deepEqual(lifecycleQueueCounts([
    job('queued', [attempt('one'), attempt('two', 'acknowledged', true)]),
    job('cancelled', [attempt('three')], 'locally-cancelled'),
  ]), { active: 1, pending: 1, jobs: 2 });
  assert.throws(() => lifecycleQueueCounts([job('a', [attempt('duplicate')]), job('b', [attempt('duplicate')])]));
});

test('full journal replay detects a transient active peak hidden by equal endpoints', () => {
  const before = [job('one', [attempt('a')]), job('two', [attempt('b')])];
  const one = job('one', [attempt('a', 'dispatching', true)]), two = job('two', [attempt('b', 'dispatching', true)]);
  const result = replayLifecycleQueue({ before, after: before, fromSeq: '10', toSeq: '14', records: [journal(11, one), journal(12, two), journal(13, before[0]), journal(14, before[1])] });
  assert.equal(result.maximum.active, 2); assert.equal(result.maximum.pending, 2); assert.equal(result.complete, true);
});

test('missing journal entries or unreproduced final projection cannot qualify queue peaks', () => {
  const before = [job('one', [attempt('a')])], changed = job('one', [attempt('a', 'dispatching', true)]);
  assert.throws(() => replayLifecycleQueue({ before, after: [changed], fromSeq: '1', toSeq: '3', records: [journal(3, changed)] }), /gap/);
  assert.throws(() => replayLifecycleQueue({ before, after: [changed], fromSeq: '1', toSeq: '1', records: [] }), /final authoritative/);
  assert.throws(() => replayLifecycleQueue({ before, after: before, fromSeq: '1', toSeq: '2', records: [] }), /incomplete/);
});

test('font union deduplicates actual file bytes separately from distinct face identities', () => {
  const font = (id, bytes, faceIndex = 0) => ({ bytes: { hash: id, byteLength: String(bytes) }, faceIndex, parserProfile: 'sfnt' });
  const sources = [{ text: { fonts: [font('a', 100), font('b', 300)] } }, { text: { fonts: [font('a', 100), font('a', 100, 1)] } }];
  assert.deepEqual(lifecycleFontUnion(sources), { faces: 3, singleBytes: 300, setBytes: 400, files: [{ sha256: 'a', byteLength: 100 }, { sha256: 'b', byteLength: 300 }] });
  assert.throws(() => lifecycleFontUnion([{ text: { fonts: [font('a', 100), font('a', 101)] } }]), /conflicting/);
});

test('absence of allocation samples remains missing; endpoint observations never become complete peaks', () => {
  assert.deepEqual(lifecycleAllocationObservations([]), { fontShapingCpuBytes: -1, glyphGpuBytes: -1, captionWorkspaceBytes: -1, complete: false });
  assert.deepEqual(lifecycleAllocationObservations([{ fontShapingCpuBytes: 12, glyphGpuBytes: 3, captionWorkspaceBytes: 7 }, { fontShapingCpuBytes: 8, glyphGpuBytes: 6 }]), { fontShapingCpuBytes: 12, glyphGpuBytes: 6, captionWorkspaceBytes: 7, complete: false });
});

test('staged observer does not construct a writer or expose raw command/event/queue text in its artifact', async () => {
  const source = await readFile(new URL('../../tooling/qualification/campaigns/browser-lifecycle-counters.mjs', import.meta.url), 'utf8');
  assert.match(source, /readOnly: true/); assert.doesNotMatch(source, /openWriter|new StoreDatabase|BEGIN IMMEDIATE/);
  assert.match(source, /flag: 'wx'/); assert.match(source, /failed = false/);
  assert.doesNotMatch(source, /artifactValue[\s\S]*requests:.*original:/);
});
