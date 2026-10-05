import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { boundedChild } from '../../tooling/qualification/container/bounded-child.mjs';
import { ownTestRoot } from '../../tooling/qualification/owned-test-roots.mjs';
import { FIXTURE_VERSION, REPO, workloadDefinition } from '../../tooling/qualification/campaigns/fixtures.mjs';
import { selectFixtureDescriptor } from '../../tooling/qualification/campaigns/fixture-catalog.mjs';
import { createFixtureCatalog, descriptorFor, fixtureKey, main, parseFixtureArguments, prepareFixtureInput, prepareSeedInput, readFixtureDescriptor, withFixtureTermination } from '../../tooling/qualification/campaigns/fixtures-run.mjs';

async function temporary(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fixture-cli-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

// These minimal manifests exercise descriptor/seal mechanics only. No product
// fixture is generated and these tests do not constitute performance evidence.
async function descriptorFixture(root, { workload = 'W0', corpus = [], name = workload } = {}) {
  const definition = workloadDefinition(workload), observed = { ...definition, productionValidated: true };
  if (definition.closureBytes) Object.assign(observed, { closureVerified: true, features: Object.fromEntries(['original', 'candidate', 'rawCaption', 'derivedCaption', 'nativeText', 'font', 'layout', 'contribution', 'adapter'].map(key => [key, true])) });
  const manifest = { kind: 'sealed-performance-fixture', version: FIXTURE_VERSION, workload, outcome: 'prepared', observed, corpus: { files: corpus } };
  const manifestPath = join(root, name + '-fixture.json'), bytes = JSON.stringify(manifest) + '\n';
  await writeFile(manifestPath, bytes, { flag: 'wx' });
  const descriptor = descriptorFor({ manifestPath, seal: { path: manifestPath, sha256: 'sha256:' + createHash('sha256').update(bytes).digest('hex') } });
  const path = join(root, name + '-input.json');
  await writeFile(path, JSON.stringify(descriptor), { flag: 'wx' });
  return { path, descriptor, manifest };
}

test('prepare CLI has an explicit heavy gate and exact portable/native prerequisites', () => {
  const args = ['prepare', '--workload', 'W1', '--output', 'artifacts/new', '--allow-heavy'];
  assert.equal(parseFixtureArguments(args).allowHeavy, true);
  assert.equal(args.length, 6);
  for (const [more, pattern] of [
    [['prepare', '--workload', 'W1', '--output', 'artifacts/new'], /allow-heavy/],
    [['prepare', '--workload', 'WXs', '--output', 'artifacts/new', '--allow-heavy'], /font-corpus/],
    [['prepare', '--workload', 'WC', '--output', 'artifacts/new', '--allow-heavy'], /exact/],
    [['prepare', '--workload', 'WC512', '--output', 'artifacts/new', '--allow-heavy'], /seed/],
    [['prepare', '--workload', 'W1', '--output', 'artifacts/new', '--allow-heavy', '--closure-bytes', '536870912'], /closure-bytes/],
    [['prepare', '--workload', 'WC4G', '--output', 'artifacts/new', '--allow-heavy', '--seed', '/mixed.json', '--closure-bytes', '536870912'], /closure-bytes/],
  ]) assert.throws(() => parseFixtureArguments(more), pattern);
  const wc = parseFixtureArguments(['prepare', '--workload', 'WC', '--closure-bytes', '4294967296', '--seed', '/mixed.json', '--output', 'artifacts/new', '--allow-heavy']);
  assert.equal(wc.closureBytes, '4294967296');
  assert.equal(wc.seed, '/mixed.json');
});

test('parser rejects unknown, missing, duplicate and unsafe catalog arguments', () => {
  for (const args of [
    ['prepare', '--workload', 'W0', '--output'],
    ['prepare', '--workload', 'W0', '--output', 'a', '--output', 'b', '--allow-heavy'],
    ['prepare', '--workload', 'W0', '--output', 'a', '--allow-heavy', '--quiet'],
    ['catalog', '--output', 'a'],
    ['catalog', '--output', 'a', '--fixture', 'W1=x', '--fixture', 'W1=y'],
    ['catalog', '--output', 'a', '--cell', '__proto__=x'],
    ['catalog', '--output', 'a', '--fixture', 'W1='],
    ['catalog', '--output', 'a', '--allow-heavy'],
  ]) assert.throws(() => parseFixtureArguments(args));
  assert.deepEqual(parseFixtureArguments(['catalog', '--output', 'a', '--fixture', 'W1=x', '--cell', 'C8-W1=@W1']).cells, [['C8-W1', '@W1']]);
});

test('programmatic preparation also refuses implicit heavy generation before IO', async t => {
  const root = await temporary(t), output = join(root, 'must-not-exist');
  await assert.rejects(prepareFixtureInput({ workload: 'W2', output }), /allow-heavy/);
  await assert.rejects(lstat(output), { code: 'ENOENT' });
});

test('descriptor retains the exact external seal and refuses paths or fabricated identities', async t => {
  const root = await temporary(t), input = await descriptorFixture(root);
  const read = await readFixtureDescriptor(input.path);
  assert.deepEqual(read.descriptor, input.descriptor);
  assert.equal(read.fixture.workload, 'W0');
  assert.throws(() => descriptorFor({ ...input.descriptor, manifestPath: 'fixture.json' }), /absolute/);
  assert.throws(() => descriptorFor({ ...input.descriptor, seal: { ...input.descriptor.seal, path: '/other.json' } }), /exact/);
  assert.throws(() => descriptorFor({ ...input.descriptor, seal: { ...input.descriptor.seal, sha256: 'sha256:0' } }), /exact/);
  await writeFile(input.descriptor.manifestPath, JSON.stringify({ ...input.manifest, outcome: 'incomplete' }));
  await assert.rejects(readFixtureDescriptor(input.path), /changed after preparation/);
});

test('catalog creation verifies every source and maps exact portable size keys', async t => {
  const root = await temporary(t), w0 = await descriptorFixture(root), wc = await descriptorFixture(root, { workload: 'WC512' });
  assert.equal(fixtureKey({ workload: 'WC4G', observed: { closureBytes: 4294967296 } }), 'WC:4294967296');
  assert.throws(() => fixtureKey({ workload: 'WC4G', observed: { closureBytes: 536870912 } }), /closure size/);
  const output = join(root, 'catalog.json');
  const result = await createFixtureCatalog({ output, fixtures: [['W0', w0.path], ['WC:536870912', wc.path]], cells: [['C8-W0', '@W0'], ['C1-custom', w0.path]] });
  const catalog = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(result.catalogPath, output);
  assert.deepEqual(catalog.fixtures.W0, w0.descriptor);
  assert.equal(catalog.cells['C8-W0'], 'W0');
  assert.deepEqual(catalog.cells['C1-custom'], w0.descriptor);
  assert.deepEqual(selectFixtureDescriptor(catalog, { id: 'C8-W0', workload: 'W0' }), w0.descriptor);
  assert.deepEqual(selectFixtureDescriptor(catalog, { id: 'C14-copy', workload: 'WC', parameters: { closureBytes: 536870912 } }), wc.descriptor);
  assert.throws(() => selectFixtureDescriptor(catalog, { id: 'C14-copy-big', workload: 'WC', parameters: { closureBytes: 4294967296 } }), /No sealed fixture/);
});

test('catalog rejects mislabeled workloads and absent cell references without writing', async t => {
  const root = await temporary(t), input = await descriptorFixture(root);
  for (const [name, options, pattern] of [
    ['wrong', { fixtures: [['W1', input.path]] }, /does not match/],
    ['missing', { fixtures: [['W0', input.path]], cells: [['C1', '@W1']] }, /absent fixture/],
    ['duplicate', { fixtures: [['W0', input.path], ['W0', input.path]] }, /Duplicate/],
  ]) {
    const output = join(root, name + '.json');
    await assert.rejects(createFixtureCatalog({ output, ...options }), pattern);
    await assert.rejects(lstat(output), { code: 'ENOENT' });
  }
});

test('catalog refuses changed corpus bytes and keeps the output absent', async t => {
  const root = await temporary(t), source = join(root, 'source.bin');
  await writeFile(source, 'before');
  const input = await descriptorFixture(root, { corpus: [{ id: 'source', path: source, byteLength: '6', sha256: 'sha256:' + createHash('sha256').update('before').digest('hex') }] });
  await writeFile(source, 'after!');
  const output = join(root, 'catalog.json');
  await assert.rejects(createFixtureCatalog({ output, fixtures: [['W0', input.path]] }), /content changed/);
  await assert.rejects(lstat(output), { code: 'ENOENT' });
});

test('catalog never overwrites evidence or traverses output symlinks', async t => {
  const root = await temporary(t), input = await descriptorFixture(root), output = join(root, 'existing.json');
  await writeFile(output, 'retained evidence');
  await assert.rejects(createFixtureCatalog({ output, fixtures: [['W0', input.path]] }), { code: 'EEXIST' });
  assert.equal(await readFile(output, 'utf8'), 'retained evidence');
  const real = join(root, 'real'); await mkdir(real);
  const link = join(root, 'linked'); await symlink(real, link, 'dir');
  await assert.rejects(createFixtureCatalog({ output: join(link, 'catalog.json'), fixtures: [['W0', input.path]] }), /symlink/);
  await assert.rejects(lstat(join(real, 'catalog.json')), { code: 'ENOENT' });
  const descriptorLink = join(root, 'input-link.json'); await symlink(input.path, descriptorLink);
  await assert.rejects(readFixtureDescriptor(descriptorLink), /ordinary file/);
});

test('help and CLI validation are readable without starting preparation', async () => {
  let out = '', error = '';
  const streams = { stdout: { write: value => { out += value; } }, stderr: { write: value => { error += value; } } };
  assert.equal(await main(['--help'], streams), 0);
  assert.match(out, /fixture-input.json/); assert.match(out, /--allow-heavy/); assert.equal(error, '');
  assert.equal(await main(['prepare', '--workload', 'W2', '--output', 'artifacts/new'], streams), 1);
  assert.match(error, /allow-heavy/);
});


test('small mixed seed has an explicit separate command and refuses workload shortcuts', () => {
  assert.deepEqual(parseFixtureArguments(['prepare-seed', '--output', 'artifacts/new-seed', '--allow-heavy', '--official-adapter', '/sealed/weights', '--repo', '/subject']),
    {command: 'prepare-seed', output: 'artifacts/new-seed', allowHeavy: true, officialAdapter: '/sealed/weights', repo: '/subject'});
  assert.throws(() => parseFixtureArguments(['prepare-seed', '--output', 'artifacts/new-seed']), /allow-heavy/);
  for (const [flag, value] of [['--workload', 'WC512'], ['--closure-bytes', '536870912'], ['--seed', '/old/seed.json'], ['--font-corpus', '/fonts.json'], ['--catalog-output', 'artifacts/catalog.json'], ['--fixture', 'W1=x']])
    assert.throws(() => parseFixtureArguments(['prepare-seed', '--output', 'artifacts/new-seed', '--allow-heavy', flag, value]), /Unknown prepare-seed option/);
  assert.throws(() => parseFixtureArguments(['prepare-seed', '--output', 'one', '--output', 'two', '--allow-heavy']), /Duplicate/);
});

test('programmatic small seed refuses implicit heavy preparation without importing its producer or writing', async t => {
  const root = await temporary(t), output = join(root, 'absent-seed');
  await assert.rejects(prepareSeedInput({output}), /allow-heavy/);
  await assert.rejects(lstat(output), {code: 'ENOENT'});
  let out = '', error = '';
  assert.equal(await main(['prepare-seed', '--output', output], {stdout: {write: v => {out += v;}}, stderr: {write: v => {error += v;}}}), 1);
  assert.equal(out, ''); assert.match(error, /allow-heavy/);
  await assert.rejects(lstat(output), {code: 'ENOENT'});
});


// These owned children verify CLI cancellation/lifetime only. No heavy fixture,
// WC counts, product qualification or supervisor deadline result is claimed.
async function fixtureSignalChild(t, body, onEvent = () => {}, { expectedInterrupted = false } = {}) {
  const root = ownTestRoot(await realpath(await mkdtemp(join(tmpdir(), 'fixture-signal-'))));
  t.diagnostic('Owned signal control: ' + root);
  const tmp = join(root, 'tmp'); await mkdir(tmp, { mode: 0o700 });
  const path = join(root, 'child.mjs');
  await writeFile(path, `import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const root=${JSON.stringify(root)};
const cliURL=${JSON.stringify(pathToFileURL(join(REPO, 'tooling/qualification/campaigns/fixtures-run.mjs')).href)};
const writerURL=${JSON.stringify(pathToFileURL(join(REPO, 'dist/local/server/storage/writer.js')).href)};
const ownerURL=${JSON.stringify(pathToFileURL(join(REPO, 'dist/local/server/storage/ownership.js')).href)};
const emit=value=>process.stdout.write(JSON.stringify(value)+'\\n');
${body}
`, { mode: 0o600, flag: 'wx' });
  const controller = new AbortController(), events = []; let stdout = '', stderr = '', pending = '', callbackError;
  const child = await boundedChild(process.execPath, ['--import', join(REPO, 'tests/session/no-egress.mjs'), path], {
    cwd: REPO, env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp }, timeoutMs: 20000, graceMs: 5000, abortSignal: controller.signal,
    onStdout(bytes) {
      const text = bytes.toString(); stdout += text; pending += text;
      for (let newline; (newline = pending.indexOf('\n')) !== -1;) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1); if (!line) continue;
        try { const event = JSON.parse(line); events.push(event); onEvent(event, controller); }
        catch (error) { callbackError ??= error; controller.abort(error); }
      }
    },
    onStderr: bytes => { stderr += bytes.toString(); },
  });
  await writeFile(join(root, 'child-output.json'), JSON.stringify({ child, events, stdout, stderr }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  if (callbackError) throw callbackError;
  assert.equal(child.timedOut, false, stderr); assert.equal(child.interrupted, expectedInterrupted, stderr); assert.equal(pending, '');
  return { root, child, events, stderr };
}

for (const { signalName, mode } of [
  { signalName: 'SIGTERM', mode: 'direct' }, { signalName: 'SIGINT', mode: 'direct' },
  { signalName: 'SIGTERM', mode: 'duplicate' }, { signalName: 'SIGTERM', mode: 'supervisor' },
]) test(signalName + ' ' + mode + ' reaches the preparation signal and waits for actual writer closure before reporting interruption', async t => {
  const result = await fixtureSignalChild(t, `
const {withFixtureTermination}=await import(cliURL), {openWriter}=await import(writerURL), {acquireRoot}=await import(ownerURL);
const writerRoot=join(root,'writer');await mkdir(writerRoot,{mode:0o700});
let closed=false,seen;
try {
  await withFixtureTermination(async signal=>{
    const writer=await openWriter({root:writerRoot});
    try {
      await writer.protocolDefaults();
      const stopped=new Promise((_,reject)=>signal.addEventListener('abort',()=>{seen=signal.reason;reject(seen);},{once:true}));
      emit({ready:true,pid:process.pid});
      await stopped;
    } finally {
      let repeated;
      const duplicateArrival=${JSON.stringify(mode)}==='duplicate' ? new Promise(resolve=>{
        repeated=()=>{emit({repeatedSignalObserved:true});resolve();};process.once('SIGTERM',repeated);
      }) : null;
      try {
        emit({draining:true,pid:process.pid});
        if(duplicateArrival)await duplicateArrival;else await new Promise(resolve=>setTimeout(resolve,30));
        assert.equal(signal.reason,seen);
        await writer.close();
        const owner=await acquireRoot(writerRoot);owner.check();owner.close();
        closed=true;await writeFile(join(root,'cleanup.json'),JSON.stringify({closed:true,reacquired:true}),{flag:'wx'});
      } finally {if(repeated)process.off('SIGTERM',repeated);}
    }
  });
  throw Error('Interrupted preparation must not succeed');
} catch(error) {
  assert.equal(error,seen);assert.equal(error.code,'ABORT_ERR');assert.equal(error.signal,${JSON.stringify(signalName)});assert(closed);
  assert.equal(process.listenerCount('SIGTERM'),0);assert.equal(process.listenerCount('SIGINT'),0);
  emit({interrupted:true,signal:error.signal,closed});process.exitCode=1;
}`, (event, controller) => {
    if (event.ready) {
      assert(Number.isSafeInteger(event.pid) && event.pid > 0);
      if (mode === 'supervisor') controller.abort(Error('Selected actual supervisor cancellation'));
      else process.kill(event.pid, signalName);
    } else if (event.draining && mode === 'duplicate') process.kill(event.pid, signalName);
  }, { expectedInterrupted: mode === 'supervisor' });
  assert.equal(result.child.code, 1, result.stderr); assert.equal(result.child.signal, null);
  if (mode === 'supervisor') {
    assert.equal(result.child.exitObserved, true); assert.deepEqual(result.child.requestedSignals, ['SIGTERM', 'SIGKILL']);
    assert.equal(result.child.processTree, process.platform === 'linux' ? 'owned-group-and-proc-descendants' : 'owned-group');
  }
  assert.deepEqual(result.events.map(event => event.ready ? 'ready' : event.draining ? 'draining' : event.repeatedSignalObserved ? 'repeated-signal' : 'closed'),
    mode === 'duplicate' ? ['ready', 'draining', 'repeated-signal', 'closed'] : ['ready', 'draining', 'closed']);
  assert.deepEqual(result.events.at(-1), { interrupted: true, signal: signalName, closed: true });
  assert.deepEqual(JSON.parse(await readFile(join(result.root, 'cleanup.json'), 'utf8')), { closed: true, reacquired: true });
});

test('termination scope preserves successful values and original errors and removes only its own listeners', async () => {
  const term = () => {}, interrupt = () => {};
  process.on('SIGTERM', term); process.on('SIGINT', interrupt);
  const before = { term: process.listeners('SIGTERM'), interrupt: process.listeners('SIGINT') };
  try {
    assert.equal(await withFixtureTermination(async signal => { assert.equal(signal.aborted, false); return 'closed'; }), 'closed');
    const original = Error('Original producer failure after cleanup');
    await assert.rejects(withFixtureTermination(async () => { throw original; }), error => error === original);
    assert.deepEqual(process.listeners('SIGTERM'), before.term); assert.deepEqual(process.listeners('SIGINT'), before.interrupt);
  } finally { process.off('SIGTERM', term); process.off('SIGINT', interrupt); }
});

test('late OS cancellation cannot convert a resolved preparation result into success', async t => {
  const result = await fixtureSignalChild(t, `
const {withFixtureTermination}=await import(cliURL);let seen;
try {
  await withFixtureTermination(async signal=>{
    signal.addEventListener('abort',()=>{seen=signal.reason;},{once:true});
    process.kill(process.pid,'SIGTERM');
    await new Promise(resolve=>setTimeout(resolve,20));
    return {wouldOtherwiseSucceed:true};
  });
  throw Error('Late cancellation incorrectly succeeded');
} catch(error) {assert.equal(error,seen);assert.equal(error.code,'ABORT_ERR');emit({lateAbort:true});process.exitCode=1;}
`);
  assert.equal(result.child.code, 1, result.stderr); assert.equal(result.child.signal, null); assert.deepEqual(result.events, [{ lateAbort: true }]);
});

test('CLI import is inert and no-argument help leaves no owned signal handlers', async t => {
  const result = await fixtureSignalChild(t, `
const before={term:process.listenerCount('SIGTERM'),interrupt:process.listenerCount('SIGINT')};
const {main}=await import(cliURL);
assert.equal(process.listenerCount('SIGTERM'),before.term);assert.equal(process.listenerCount('SIGINT'),before.interrupt);
let stdout='',stderr='';assert.equal(await main([],{stdout:{write:value=>{stdout+=value;}},stderr:{write:value=>{stderr+=value;}}}),0);
assert.match(stdout,/Sealed performance fixtures/);assert.equal(stderr,'');
assert.equal(process.listenerCount('SIGTERM'),before.term);assert.equal(process.listenerCount('SIGINT'),before.interrupt);
emit({inert:true,help:true});
`);
  assert.equal(result.child.code, 0, result.stderr); assert.equal(result.child.signal, null); assert.deepEqual(result.events, [{ inert: true, help: true }]);
});
