import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtemp, open, readFile, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTapCounter, summarizeLogBytes, readGateLog, LOG_READ_CHUNK_BYTES} from '../../tooling/qualification/gate-log-reader.mjs';
import {tapCounts, gateOutcome, receiptOutcome, verifyReceipt, digestJSON} from '../../tooling/qualification/core.mjs';
import {executeGate} from '../../tooling/qualification/run.mjs';
const footer = '# tests 3\n# suites 0\n# pass 2\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('streaming counters preserve column-zero last summaries across every byte split', () => {
  const bytes = Buffer.from('TAP version 13\n    # tests 999\n# tests 1\n# pass 1\n' + footer.replaceAll('\n', '\r\n') + '# fail 2\r# cancelled 1\u2028# skipped 2\u2029# todo 4');
  for (let split = 0; split <= bytes.length; split++) {
    const counter = createTapCounter(); counter.append(bytes.subarray(0, split)); counter.append(bytes.subarray(split));
    assert.deepEqual(counter.finish(), {counts: tapCounts(bytes.toString()), error: null});
  }
});
test('UTF8 whitespace, trailing whitespace chunks and leading zero counters retain their actual values', () => {
  const bytes = Buffer.from('# tests 00000000000000000000000003\u00a0\r\n# pass 3' + ' '.repeat(100000) + '\n');
  const counter = createTapCounter(); for (const byte of bytes) counter.append(Buffer.from([byte]));
  assert.deepEqual(counter.finish(), {counts: {tests: 3, pass: 3}, error: null});
});
test('a diagnostic line larger than the V8 string ceiling never accumulates into a string', () => {
  const counter = createTapCounter(), chunk = Buffer.alloc(LOG_READ_CHUNK_BYTES, 65);
  counter.append(Buffer.from('  stack: data:text/javascript;base64,'));
  for (let index = 0; index < 9600; index++) counter.append(chunk); // 600MiB logical line, one reused64KiB buffer.
  counter.append(Buffer.from('\n' + footer)); assert.deepEqual(counter.finish(), {counts: tapCounts(footer), error: null});
});
test('case progress and interruption text never invent a summary or successful completion', () => {
  const observed = summarizeLogBytes(Buffer.from('TAP version 13\nok 1 - first\nnot ok 2 - hook failed\n# Interrupted while running: tests/example.test.mjs\n'));
  assert.deepEqual(observed.counts, {}); assert.equal(observed.error, null);
  assert.equal(gateOutcome({exitCode: null, signal: 'SIGINT', interrupted: true, counts: observed.counts}, true), 'FAIL');
  assert.equal(gateOutcome({exitCode: 0, signal: null, counts: observed.counts}, true), 'INCONCLUSIVE');
  assert.equal(gateOutcome({exitCode: 0, interrupted: true, counts: {tests: 3, pass: 3}}, true), 'FAIL');
});
test('unsafe numeric footer is explicit parsing failure while unrelated comments are ignored', () => {
  const observed = summarizeLogBytes(Buffer.from('# tests 1\n# pass 1\n# fail 999999999999999999999999999999\n'));
  assert.equal(observed.counts.fail, null); assert.match(observed.error, /unsafe integer/);
  assert.equal(gateOutcome({exitCode: 0, counts: observed.counts, logError: observed.error}, true), 'FAIL');
  assert.deepEqual(summarizeLogBytes(Buffer.from('# tests 1\n# tests 999999999999999999999999999999 diagnostic\n')).counts, {tests: 1});
});
test('stable held-file scan hashes every diagnostic byte and returns actual footer counts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gate-log-reader-'));
  try {
    const path = join(root, 'raw.log'), writer = await open(path, 'wx'), digest = createHash('sha256'), chunk = Buffer.alloc(LOG_READ_CHUNK_BYTES, 65);
    let bytes = 0; const put = async value => { await writer.write(value); digest.update(value); bytes += value.length; };
    try { await put(Buffer.from('diagnostic: ')); for (let n = 0; n < 128; n++) await put(chunk); await put(Buffer.from('\n' + footer)); } finally { await writer.close(); }
    const observed = await readGateLog(path); assert.deepEqual(observed, {bytes, sha256: digest.digest('hex'), counts: tapCounts(footer), error: null});
    assert.equal((await readFile(path)).length, bytes); // This small8MiB fixture is not the retained real log.
    const alias = join(root, 'alias.log'); await symlink(path, alias); await assert.rejects(readGateLog(alias), /Regular/);
  } finally { await rm(root, {recursive: true, force: true}); }
});
test('functional verification consumes pre-read stable summaries without reading the log as a buffer', () => {
  const bytes = Buffer.from('# tests 1\n# pass 1\n'), summary = summarizeLogBytes(bytes), command = ['node', '--test', 'fixture'];
  const gate = {id: 'node:one', command, exitCode: 0, signal: null, counts: summary.counts, outcome: 'PASS', log: {path: 'one.log', bytes: summary.bytes, sha256: summary.sha256}};
  const identity = {files: [], digest: digestJSON([])}, receipt = {kind: 'qualification-functional-run-1', selected: [gate.id], plan: {gates: [{id: gate.id, command}]}, gates: [gate], identity: {before: identity, after: identity}, outcome: 'PASS'};
  assert.equal(verifyReceipt(receipt, () => assert.fail('whole-log read'), () => summary).outcome, 'PASS');
  assert.throws(() => verifyReceipt(receipt, () => assert.fail('whole-log read'), () => ({...summary, sha256: hash(Buffer.from('different'))})), /digest mismatch/);
});
test('post-child log observation failure retains the completed child result and returns a failed gate', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gate-log-failure-'));
  try {
    const observed = await executeGate({id: 'node:failed', command: [process.execPath, '--eval', 'process.exit(7)'], timeoutMs: 5000}, directory, {}, undefined, undefined, {logReader: async () => { throw Error('fixture observation failure'); }});
    assert.equal(observed.exitCode, 7); assert.equal(observed.signal, null); assert.equal(observed.outcome, 'FAIL'); assert.deepEqual(observed.counts, {}); assert.equal(observed.log.bytes, null); assert.equal(observed.log.sha256, null); assert.match(observed.logError, /fixture observation failure/);
  } finally { await rm(directory, {recursive: true, force: true}); }
});
test('post-child log observation failure cannot erase timeout metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gate-log-timeout-'));
  try {
    const observed = await executeGate({id: 'node:timed', command: [process.execPath, '--eval', 'setInterval(()=>{},1000)'], timeoutMs: 50, graceMs: 10}, directory, {}, undefined, undefined, {logReader: async () => { throw Error('fixture observation failure'); }});
    assert.equal(observed.timedOut, true); assert.equal(observed.outcome, 'FAIL'); assert.match(observed.logError, /fixture observation failure/); assert.deepEqual(observed.counts, {});
  } finally { await rm(directory, {recursive: true, force: true}); }
});
test('interrupted child facts remain distinct from unavailable footer counts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gate-log-interrupted-')), controller = new AbortController(); controller.abort('SIGINT');
  try {
    const observed = await executeGate({id: 'node:interrupted', command: [process.execPath, '--eval', 'process.exit(0)'], timeoutMs: 5000}, directory, {}, undefined, controller.signal, {logReader: async () => { throw Error('fixture observation failure'); }});
    assert.equal(observed.interrupted, true); assert.equal(observed.reason, 'SIGINT'); assert.equal(observed.exitCode, null); assert.equal(observed.outcome, 'FAIL'); assert.deepEqual(observed.counts, {}); assert.match(observed.logError, /fixture observation failure/);
  } finally { await rm(directory, {recursive: true, force: true}); }
});
test('interrupt during asynchronous replay fails the aggregate without inventing a child interruption', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gate-log-replay-interrupt-')), controller = new AbortController();
  try {
    const text = '# tests 1\n# pass 1\n', command = [process.execPath, '--eval', `process.stdout.write(${JSON.stringify(text)})`];
    const observed = await executeGate({id: 'node:finished', command, timeoutMs: 5000}, directory, {}, undefined, controller.signal, {logReader: async path => { controller.abort('SIGINT'); return readGateLog(path); }});
    assert.equal(observed.exitCode, 0); assert.equal(observed.interrupted, false); assert.equal(observed.outcome, 'PASS');
    assert.equal(receiptOutcome([observed], [observed.id], 'same', 'same', controller.signal.reason), 'FAIL');
    const identity = {files: [], digest: digestJSON([])}, receipt = {kind: 'qualification-functional-run-1', selected: [observed.id], plan: {gates: [{id: observed.id, command}]}, gates: [observed], identity: {before: identity, after: identity}, outcome: 'FAIL', interrupted: 'SIGINT'};
    const summary = await readGateLog(join(directory, observed.log.path));
    assert.equal(verifyReceipt(receipt, () => assert.fail('whole-log read'), () => summary).outcome, 'FAIL');
    assert.throws(() => verifyReceipt({...receipt, outcome: 'PASS'}, () => assert.fail('whole-log read'), () => summary), /outcome mismatch/);
  } finally { await rm(directory, {recursive: true, force: true}); }
});
