import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { copySealedFile, fixtureRequirements, historyRequirements, installInputs, prepareInputs, verifyAdapterFixture, verifyInputs, verifyInstalledInputs } from '../../tooling/qualification/container/inputs.mjs';
import { REVIEWED_RENDERER_OWNERSHIP } from '../../tooling/qualification/campaigns/renderer-ownership.mjs';
import {validateRendererReceiptDescriptor, validateRendererInputGit, stageRendererReceiptCopies, rendererReceiptRequirement} from '../../tooling/qualification/r18-ci-inputs.mjs';

const baselineFixtures = Object.freeze([
  ['evidence/p1b6-correction/original-review/drop-transaction-prefix.zip', 23385, 'a0dcad5ba6fe2fbb76149cc898aa6981d6bcdaae38fde2e81cae0954bc017ddd'],
  ['evidence/p1b6-correction/original-review/hostile-duplicate-event-id.zip', 25163, 'c6e2adf81f2372c97cac0e4703fa184ac6c9f10866b5000219baba5769fe2c26'],
  ['evidence/p1b6-correction/original-review/hostile-split-one-command.zip', 25146, 'e6f642af807db51f74d402467f818bb05227edee910bb440442a774361fe620b'],
  ['evidence/p1b6-linkage-correction/original-review/format2-domain-revision-hidden-by-tail.zip', 28469, 'c43bb855a4fadc6410ec1801103fb2f361281cb49d653d56fe43e788105c153c'],
  ['evidence/p1b6-linkage-correction/original-review/revision-tail-control-2.zip', 28467, '23ef675fb48394f2396e233c2e9326a801f46e33acfa6d8ea8206dae3630a94e'],
  ['evidence/p1b6-linkage-correction/original-review/revision-tail-control-null.zip', 28468, '9770d1a9ace1cc6f5e2993ce77d9f7ff1910029cd59237623e70d0fa7a326283'],
  ['artifacts/p27-evidence/fal-public-lora-example/provider-example.safetensors', 85299896, 'bd0b96a2fcc3141400ebeffd8585b2d3c4c0d475b10e1468ba5c40acad748bc5'],
].map(([path, bytes, sha256]) => Object.freeze({ path, bytes, sha256 })));

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (root, args, input) => execFileSync('git', ['-C', root, ...args], { input, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }, stdio: ['pipe', 'pipe', 'pipe'] });
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'qualification-container-inputs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'source'), output = join(directory, 'packet'), destination = join(directory, 'copied-source');
  await mkdir(join(root, 'src'), { recursive: true }); await mkdir(destination);
  await writeFile(join(root, 'src/file.txt'), 'sealed executable source\n');
  await mkdir(join(root, 'private-directory'));
  await writeFile(join(root, 'private-directory/other-secret.txt'), 'unrelated nested private object\n');
  await writeFile(join(root, 'private-unrelated.txt'), 'private Git object must not travel\n');
  git(root, ['init', '--quiet', '--template=']); git(root, ['add', '.']); git(root, ['commit', '--quiet', '-m', 'Fixture']);
  git(root, ['remote', 'add', 'origin', 'https://example.invalid/private-repository']);
  const commit = git(root, ['rev-parse', 'HEAD']).toString().trim();
  const secretObject = git(root, ['rev-parse', 'HEAD:private-unrelated.txt']).toString().trim();
  const nestedSecretObject = git(root, ['rev-parse', 'HEAD:private-directory/other-secret.txt']).toString().trim();
  await writeFile(join(root, 'fixture.zip'), 'exact fixture bytes');
  const fixtureBytes = await readFile(join(root, 'fixture.zip'));
  return { root, output, destination, secretObject, nestedSecretObject, history: [{ commit, paths: ['src'] }], fixtures: [{ path: 'fixture.zip', bytes: fixtureBytes.length, sha256: sha256(fixtureBytes) }] };
}

test('packet restores exact historical archives without private blobs, configuration or remotes', async t => {
  const options = await fixture(t);
  const prepared = await prepareInputs(options);
  assert.equal(prepared.commits, 1); assert.equal(prepared.fixtures, 1);
  const verified = await verifyInputs({ ...options, packet: options.output });
  assert(!verified.manifest.history.objects.includes(options.secretObject));
  assert(!verified.manifest.history.objects.includes(options.nestedSecretObject));
  await installInputs({ ...options, root: options.destination, packet: options.output });
  assert.deepEqual(git(options.destination, ['archive', options.history[0].commit, 'src']), git(options.root, ['archive', options.history[0].commit, 'src']));
  assert.equal(git(options.destination, ['remote']).toString(), '');
  assert.throws(() => git(options.destination, ['cat-file', '-p', options.secretObject]));
  assert(!String(await readFile(join(options.destination, '.git/config'))).includes('private-repository'));
  assert.deepEqual(await readFile(join(options.destination, 'fixture.zip')), await readFile(join(options.root, 'fixture.zip')));
});

test('preparation fails closed on missing or changed fixture bytes', async t => {
  const options = await fixture(t);
  await writeFile(join(options.root, 'fixture.zip'), 'changed');
  await assert.rejects(prepareInputs(options), /Fixture seal mismatch/);
  await assert.rejects(readFile(join(options.output, 'manifest.json')), { code: 'ENOENT' });
  await rm(join(options.root, 'fixture.zip'));
  await assert.rejects(prepareInputs(options), { code: 'ENOENT' });
});

test('packet preparation refuses an unavailable historical snapshot', async t => {
  const options = await fixture(t);
  options.history[0].commit = '0'.repeat(40);
  await assert.rejects(prepareInputs(options), /git/);
  await assert.rejects(readFile(join(options.output, 'manifest.json')), { code: 'ENOENT' });
});

test('verification rejects unlisted files and modified sealed files', async t => {
  const options = await fixture(t); await prepareInputs(options);
  await writeFile(join(options.output, 'unlisted'), 'not allowed');
  await assert.rejects(verifyInputs({ ...options, packet: options.output }), /unlisted files/);
  await rm(join(options.output, 'unlisted'));
  await chmod(join(options.output, 'fixtures/fixture.zip'), 0o644);
  await writeFile(join(options.output, 'fixtures/fixture.zip'), 'changed');
  await assert.rejects(verifyInputs({ ...options, packet: options.output }), /seal mismatch/);
});

test('verification rejects a self-consistent pack that adds an unrelated private object', async t => {
  const options = await fixture(t); await prepareInputs(options);
  const path = join(options.output, 'manifest.json'); const manifest = JSON.parse(await readFile(path));
  manifest.history.objects.push(options.secretObject); manifest.history.objects.sort();
  const pack = git(options.root, ['pack-objects', '--stdout'], manifest.history.objects.join('\n') + '\n');
  await chmod(join(options.output, 'history.pack'), 0o644); await writeFile(join(options.output, 'history.pack'), pack);
  manifest.history.bytes = pack.length; manifest.history.sha256 = sha256(pack);
  await chmod(path, 0o644); await writeFile(path, JSON.stringify(manifest));
  await assert.rejects(verifyInputs({ ...options, packet: options.output }), /unrelated or missing objects/);
});

test('installation never overwrites an owned checkout or existing fixtures', async t => {
  const options = await fixture(t); await prepareInputs(options);
  await assert.rejects(installInputs({ ...options, packet: options.output }), /existing Git checkout/);
  await writeFile(join(options.destination, 'fixture.zip'), 'retain this');
  await assert.rejects(installInputs({ ...options, root: options.destination, packet: options.output }), /overwrite existing fixture/);
  assert.equal(String(await readFile(join(options.destination, 'fixture.zip'))), 'retain this');
  await assert.rejects(prepareInputs(options), /existing input packet/);
});

test('installation refuses destination directory links before creating Git state or writing outside the copy', async t => {
  const options = await fixture(t);
  await mkdir(join(options.root, 'evidence'));
  await writeFile(join(options.root, 'evidence/fixture.zip'), await readFile(join(options.root, 'fixture.zip')));
  options.fixtures[0].path = 'evidence/fixture.zip';
  await prepareInputs(options);
  await symlink(options.root, join(options.destination, 'evidence'));
  await assert.rejects(installInputs({ ...options, root: options.destination, packet: options.output }), /destination parent/);
  await assert.rejects(readFile(join(options.destination, '.git/config')), { code: 'ENOENT' });
});

test('installation copy verifies destination bytes against the pinned seal after reading the source', async t => {
  const options = await fixture(t);
  await writeFile(join(options.root, 'fixture.zip'), 'changed after earlier verification');
  await assert.rejects(copySealedFile({ source: join(options.root, 'fixture.zip'), destination: join(options.destination, 'fixture.zip'), expected: options.fixtures[0] }), /Copied fixture seal mismatch/);
});

test('installed input verification binds actual fixture copies and Git metadata separately from the packet', async t => {
  const options = await fixture(t); await prepareInputs(options);
  const installed = { ...options, root: options.destination, packet: options.output };
  await installInputs(installed);
  const before = await verifyInstalledInputs(installed);
  assert.equal(before.installed.fixtures.length, 1);
  await writeFile(join(options.destination, '.git/description'), 'changed metadata\n');
  const after = await verifyInstalledInputs(installed);
  assert.notEqual(before.installed.gitSha256, after.installed.gitSha256);
  await chmod(join(options.destination, 'fixture.zip'), 0o644);
  await writeFile(join(options.destination, 'fixture.zip'), 'changed installed copy');
  await assert.rejects(verifyInstalledInputs(installed), /Installed fixture seal mismatch/);
  await verifyInputs({ ...options, packet: options.output });
});

test('adapter fixture admission rejects unsealed bytes and symbolic-link paths', async t => {
  const options = await fixture(t);
  const path = 'artifacts/p27-evidence/fal-public-lora-example/provider-example.safetensors';
  assert(fixtureRequirements.find(item => item.path === path), 'The exact pinned adapter fixture must remain present');
  await mkdir(join(options.root, 'artifacts/p27-evidence/fal-public-lora-example'), { recursive: true });
  await writeFile(join(options.root, path), 'not the pinned public weights');
  await assert.rejects(verifyAdapterFixture({ root: options.root }), /seal mismatch/);
  await rm(join(options.root, path));
  await symlink(join(options.root, 'fixture.zip'), join(options.root, path));
  await assert.rejects(verifyAdapterFixture({ root: options.root }), /regular file/);
});

test('closure pins every current migration snapshot, seven baseline fixtures and exact approved runtime receipts', async () => {
  assert.equal(historyRequirements.length, 17);
  assert.equal(new Set(historyRequirements.map(item => item.commit)).size, 17);
  const baselinePaths = new Set(baselineFixtures.map(item => item.path));
  assert.deepEqual(fixtureRequirements.filter(item => baselinePaths.has(item.path)), baselineFixtures);
  assert.equal(new Set(fixtureRequirements.map(item => item.path)).size, fixtureRequirements.length);
  const runtimeByPath = new Map();
  for (const review of REVIEWED_RENDERER_OWNERSHIP) for (const pin of review.appAllocation?.runtimeInputs ?? []) {
    assert.equal(pin.role, 'correctness-receipt');
    assert.match(pin.sha256, /^sha256:[a-f0-9]{64}$/);
    const row = { path: pin.path, bytes: pin.bytes, sha256: pin.sha256.slice(7) };
    assert(!baselinePaths.has(row.path), 'Approved runtime receipts must not replace baseline fixtures');
    if (runtimeByPath.has(row.path)) assert.deepEqual(row, runtimeByPath.get(row.path), 'Repeated runtime paths must carry identical fixed seals');
    runtimeByPath.set(row.path, row);
  }
  const byPath = (a, b) => a.path.localeCompare(b.path);
  assert.deepEqual(fixtureRequirements.filter(item => !baselinePaths.has(item.path)).sort(byPath), [...runtimeByPath.values()].sort(byPath));
  const consumerPaths = ['tests/assets/storage.test.mjs', 'tests/protocol/recovery.test.mjs', 'tests/raster/storage.test.mjs', 'tests/raster/schema.test.mjs', 'tests/history/schema.test.mjs', 'tests/history/returned-description.test.mjs', 'tests/history/mask-schema.test.mjs', 'tests/history/retained-mask-schema.test.mjs', 'tests/portable/schema.test.mjs', 'tests/portable/prior-writer.mjs', 'tests/text-state/prior-writer.mjs', 'tests/text-state/placement-schema.test.mjs', 'tests/composition/schema.test.mjs', 'tests/candidates/compatibility.test.mjs', 'tests/recovery/compatibility.test.mjs', 'tests/recovery/p2-schema.test.mjs'];
  const found = new Set();
  for (const path of consumerPaths) for (const match of String(await readFile(path)).matchAll(/['"]([a-f0-9]{40})['"]/g)) found.add(match[1]);
  assert.deepEqual([...found].sort(), historyRequirements.map(item => item.commit).sort());
});

function receiptDescriptorFixture() {
  const files = Array.from({length: 12}, (_, index) => ({path: `artifacts/receipts/${index}.json`, bytes: 2, sha256: sha256('{}')}));
  const descriptor = {kind: 'r18-ci-receipt-inputs-1', qualification: false, repository: 'https://github.com/Westbrook/ideogram-editor.git', reviewId: 'ie-r18-39ac936-20261004', commit: 'a'.repeat(40), tree: 'b'.repeat(40), files, totalBytes: 24};
  const reviews = [{id: descriptor.reviewId, appAllocation: {runtimeInputs: files.map(row => ({...row, role: 'correctness-receipt', sha256: 'sha256:' + row.sha256}))}}];
  return {descriptor, reviews, files};
}
test('renderer receipt provisioning requires issued identities and exact paired registry and fixture bytes', () => {
  const {descriptor, reviews, files} = receiptDescriptorFixture();
  assert.deepEqual(validateRendererReceiptDescriptor(descriptor, reviews, files), descriptor);
  assert.equal(rendererReceiptRequirement().files.length, 12, 'Production requirement must join the actual literal registry and maintained fixtures');
  for (const alter of [d => d.commit = null, d => d.tree = null, d => d.repository = 'https://example.invalid/repo', d => d.files[1] = d.files[0], d => d.files[0].path = 'artifacts/../escape', d => d.files[0].sha256 = '0'.repeat(64), d => d.totalBytes++]) {
    const changed = structuredClone(descriptor); alter(changed);
    assert.throws(() => validateRendererReceiptDescriptor(changed, reviews, files));
  }
  assert.throws(() => validateRendererReceiptDescriptor(descriptor, [], files), /approved renderer/);
  assert.throws(() => validateRendererReceiptDescriptor(descriptor, reviews, files.slice(1)), /fixture seal/);
  const changedReview = structuredClone(reviews); changedReview[0].appAllocation.runtimeInputs[0].bytes++;
  assert.throws(() => validateRendererReceiptDescriptor(descriptor, changedReview, files), /approved runtime/);
});
test('renderer Git admission checks raw parentlessness, exact tree and regular complete membership', () => {
  const {descriptor} = receiptDescriptorFixture();
  const commit = Buffer.from(`tree ${descriptor.tree}\nauthor Fixture <fixture@example.invalid> 0 +0000\ncommitter Fixture <fixture@example.invalid> 0 +0000\n\nReceipt fixture\n`);
  const listing = Buffer.from(descriptor.files.map(row => `100644 blob ${'c'.repeat(40)} ${row.bytes}\t${row.path}\0`).join(''));
  assert.equal(validateRendererInputGit(commit, listing, descriptor).length, 12);
  assert.throws(() => validateRendererInputGit(Buffer.from(commit.toString().replace('\nauthor', '\nparent ' + 'd'.repeat(40) + '\nauthor')), listing, descriptor), /no parents/);
  assert.throws(() => validateRendererInputGit(commit, listing, {...descriptor, tree: 'e'.repeat(40)}), /exact tree/);
  for (const mutate of [s => s.replace('100644', '120000'), s => s.replace('100644', '100755'), s => s.replace('artifacts/receipts/0.json', 'artifacts/../escape'), s => s.split('\0').slice(1).join('\0'), s => s + s.split('\0')[0] + '\0']) {
    assert.throws(() => validateRendererInputGit(commit, Buffer.from(mutate(listing.toString())), descriptor));
  }
});
async function rendererTransportFixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'renderer-receipt-transport-')));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const source = join(directory, 'source'), checkout = join(directory, 'checkout');
  for (const path of [source, checkout]) { await mkdir(path); git(path, ['init', '--quiet', '--template=']); }
  const path = 'artifacts/receipts/original.json', bytes = Buffer.from('{"fixture":"raw original"}\n');
  await mkdir(join(source, 'artifacts/receipts'), {recursive: true}); await writeFile(join(source, path), bytes);
  git(source, ['add', '.']); git(source, ['commit', '--quiet', '-m', 'Parentless fixture']);
  const commit = git(source, ['rev-parse', 'HEAD']).toString().trim(), tree = git(source, ['rev-parse', 'HEAD^{tree}']).toString().trim();
  // A fetched source starts with only Git objects, without a materialized tree.
  await rm(join(source, 'artifacts'), {recursive: true});
  await writeFile(join(checkout, 'sentinel.txt'), 'owned checkout retained');
  git(checkout, ['add', '.']); git(checkout, ['commit', '--quiet', '-m', 'Owned checkout']);
  return {source, checkout, packet: join(directory, 'packet'), recipient: join(directory, 'recipient'), descriptor: {commit, tree, files: [{path, bytes: bytes.length, sha256: sha256(bytes)}]}, bytes};
}
test('renderer transport verifies a real packet in a fresh recipient and copies exact bytes without installing over checkout', async t => {
  const options = await rendererTransportFixture(t), head = git(options.checkout, ['rev-parse', 'HEAD']), config = await readFile(join(options.checkout, '.git/config'));
  const result = await stageRendererReceiptCopies(options);
  assert.equal(result.qualification, false); assert.deepEqual(result.copied, options.descriptor.files);
  assert.deepEqual(await readFile(join(options.checkout, options.descriptor.files[0].path)), options.bytes);
  assert.deepEqual(git(options.checkout, ['rev-parse', 'HEAD']), head);
  assert.deepEqual(await readFile(join(options.checkout, '.git/config')), config);
  assert.deepEqual(git(options.recipient, ['cat-file', 'commit', options.descriptor.commit]), git(options.source, ['cat-file', 'commit', options.descriptor.commit]));
  assert.equal(git(options.recipient, ['remote']).toString(), '');
  await assert.rejects(stageRendererReceiptCopies({...options, packet: options.packet + '-retry', recipient: options.recipient + '-retry'}), /existing renderer receipt/);
  assert.deepEqual(await readFile(join(options.checkout, options.descriptor.files[0].path)), options.bytes);
});
test('renderer transport refuses aliased parents, changed blobs and existing recipients before checkout writes', async t => {
  for (const kind of ['alias', 'changed', 'recipient']) {
    const options = await rendererTransportFixture(t);
    if (kind === 'alias') await symlink(options.source, join(options.checkout, 'artifacts'));
    if (kind === 'changed') options.descriptor.files[0].sha256 = '0'.repeat(64);
    if (kind === 'recipient') { await mkdir(options.recipient); git(options.recipient, ['init', '--quiet', '--template=']); }
    await assert.rejects(stageRendererReceiptCopies(options), kind === 'alias' ? /real directory/ : kind === 'changed' ? /seal differs/ : /existing renderer receipt/);
    await assert.rejects(readFile(join(options.packet, 'manifest.json')), {code: 'ENOENT'});
    assert.equal(String(await readFile(join(options.checkout, 'sentinel.txt'))), 'owned checkout retained');
  }
});
