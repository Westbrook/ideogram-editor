import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, readFile, writeFile, mkdir, rm, realpath, chmod, symlink, link} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateHostedManifest, getHostedInputContract, admitHostedInputs, recheckHostedInputs, prepareHostedSourceInputs, recheckHostedPreparation, rebindSourceWrapper, validateHostedCliIdentity, hostedInputsMain} from '../../tooling/rollback-producer/hosted-inputs.mjs';
import {qualificationTestPlan} from '../../tooling/qualification/test.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const manifestBytes = await readFile(join(repo, 'tooling/rollback-producer/hosted-inputs.json'));
const manifest = JSON.parse(manifestBytes);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const clone = value => structuredClone(value);
const ref = path => ({path, hash: 'sha256:' + 'a'.repeat(64), byteLength: '12'});
const wrapper = version => ({kind: 'linux-rollback-source-input-1', storageVersion: version,
  originArchive: ref('/original/archive'), originManifest: ref('/original/manifest'), lineage: ref('/original/lineage'), sourceBytesModesIdentity: 'sha256:' + 'b'.repeat(64),
  ...(version === 16 ? {compatibilityContract: 'schema16-linux-raster-maintenance-1', historicalBase: '5650326b623d4aa2080772307708aa9f1854aa52', maintenancePatchHash: 'sha256:' + 'c'.repeat(64)} : {}),
  ...(version === 18 ? {capabilityHash: 'sha256:' + 'd'.repeat(64)} : {})});

async function fixture(t, placeholders = false) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ie-hosted-input-unit-')); await chmod(root, 0o700);
  t.after(() => rm(root, {recursive: true, force: true}));
  await writeFile(join(root, 'INPUTS.json'), manifestBytes, {mode: 0o600});
  if (placeholders) for (const row of manifest.files) {
    await mkdir(dirname(join(root, row.path)), {recursive: true, mode: 0o700});
    // These deliberately incomplete files must never pass source admission.
    await writeFile(join(root, row.path), '', {mode: 0o600});
  }
  return root;
}

test('the whole hosted input owner is registered with the guarded tooling inventory', () => {
  const plan = qualificationTestPlan(repo);
  assert(plan.files.includes('tests/qualification/rollback-hosted-inputs.test.mjs'));
  assert(plan.command.includes('./tests/session/no-egress.mjs'));
});

test('the fixed manifest authenticates the complete source-only closure and active producer seals', async () => {
  const contract = await getHostedInputContract();
  assert.equal(contract.manifest.hash, 'sha256:' + sha(manifestBytes));
  assert.equal(contract.fileCount, 72); assert.equal(contract.totalBytes, 219487623);
  assert.deepEqual(contract.files, manifest.files);
  assert.equal(contract.producers.length, 3);
  assert.equal(contract.producers[0].producer.seal.hash, 'sha256:b074c7a19c6167a44b4dac1b370a6411dedaf3c9406538313838df919625dc3a');
  const original = await readFile(join(repo, 'tooling/rollback-producer/schema16-original-seal.json'));
  assert.equal(sha(original), 'c330622c4b5286ec8537ab04ed4e2fa1cc5642ba4a61d4b32c6467630cb4b450');
  assert.equal(Object.isFrozen(contract.files[0]), true);
});

test('a self-declared source manifest cannot add executable authority or unknown fields', () => {
  for (const mutate of [x => x.producerAuthorityIssued = true, x => x.status = 'verified', x => x.pin = {}, x => x.sourceArchiveBytesUnchanged = false]) {
    const value = clone(manifest); mutate(value); assert.throws(() => validateHostedManifest(value));
  }
});

test('manifest membership rejects aliases, duplicates and file/directory conflicts', () => {
  for (const path of ['../outside','/absolute','origins/schema16/../outside','origins/schema16/a\\b','origins/schema16/a\nb','origins/schema16//a']) {
    const value = clone(manifest); value.files[0].path = path; assert.throws(() => validateHostedManifest(value));
  }
  const duplicate = clone(manifest); duplicate.files[1].path = duplicate.files[0].path; assert.throws(() => validateHostedManifest(duplicate));
  const conflict = clone(manifest); conflict.files[0].path = 'origins/schema16/lineage.json/extra'; assert.throws(() => validateHostedManifest(conflict));
});

test('manifest byte and count limits are checked rather than trusted', () => {
  for (const mutate of [x => x.files[0].bytes = 100 * 1024 ** 2, x => x.files[0].bytes = -1, x => x.files[0].sha256 = 'X'.repeat(64), x => x.totalBytes++, x => x.fileCount--]) {
    const value = clone(manifest); mutate(value); assert.throws(() => validateHostedManifest(value));
  }
});

for (const version of [16,17,18]) test(`schema${version} rebinding preserves all source identities and leaves its original unchanged`, () => {
  const original = wrapper(version), before = clone(original), references = {originArchive: ref('/new/archive'), originManifest: ref('/new/manifest'), lineage: ref('/new/lineage')};
  const output = rebindSourceWrapper(original, version, references);
  assert.deepEqual(original, before); assert.deepEqual(output, {...before, ...references}); assert(Object.isFrozen(output.lineage));
  assert.equal(output.sourceBytesModesIdentity, before.sourceBytesModesIdentity);
  assert.equal(Object.hasOwn(output, 'linuxExecutableQualified'), false);
});

test('rebinding refuses content changes, extra fields and family substitution', () => {
  const original = wrapper(18), good = {originArchive: ref('/new/archive'), originManifest: ref('/new/manifest'), lineage: ref('/new/lineage')};
  for (const mutate of [x => x.originArchive.hash = 'sha256:' + 'e'.repeat(64), x => x.lineage.byteLength = '13', x => x.originManifest.path = '/new/../manifest', x => x.extra = ref('/new/extra')]) {
    const changed = clone(good); mutate(changed); assert.throws(() => rebindSourceWrapper(original, 18, changed));
  }
  assert.throws(() => rebindSourceWrapper(original, 17, good));
  assert.throws(() => rebindSourceWrapper({...original, verified: true}, 18, good));
});

test('missing input members fail without creating preparation output', async t => {
  const root = await fixture(t);
  await assert.rejects(admitHostedInputs({inputRoot: root}), /membership/);
});

test('unexpected input files and empty directories are rejected', async t => {
  const root = await fixture(t, true); await writeFile(join(root, 'extra'), '', {mode: 0o600});
  await assert.rejects(admitHostedInputs({inputRoot: root}), /membership/);
  await rm(join(root, 'extra')); await mkdir(join(root, 'extra-directory'), {mode: 0o700});
  await assert.rejects(admitHostedInputs({inputRoot: root}), /Unexpected input directory/);
});

test('an exact member list with wrong bytes still fails authentication', async t => {
  const root = await fixture(t, true), first = manifest.files[0];
  await writeFile(join(root, first.path), Buffer.alloc(first.bytes), {mode: 0o600});
  await assert.rejects(admitHostedInputs({inputRoot: root}), /content differs/);
});

test('input aliases and hard-linked members cannot be admitted', async t => {
  const root = await fixture(t, true), file = join(root, manifest.files[0].path), other = join(root, manifest.files[1].path);
  await rm(file); await symlink(other, file); await assert.rejects(admitHostedInputs({inputRoot: root}), /aliases/);
  await rm(file); await link(other, file); await assert.rejects(admitHostedInputs({inputRoot: root}), /linked file/);
});

test('manifest relocation, byte tampering and public permissions fail before source use', async t => {
  const root = await fixture(t), path = join(root, 'INPUTS.json');
  await assert.rejects(admitHostedInputs({inputRoot: root, manifestPath: join(root, 'other.json')}), /fixed input-root/);
  await chmod(path, 0o644); await assert.rejects(admitHostedInputs({inputRoot: root}), /private and owned/);
  await chmod(path, 0o600); await writeFile(path, Buffer.alloc(manifestBytes.length));
  await assert.rejects(admitHostedInputs({inputRoot: root}), /content differs/);
});

test('an aborted admission cannot become a preparation grant', async t => {
  const root = await fixture(t), controller = new AbortController(); controller.abort(Error('cancelled'));
  await assert.rejects(admitHostedInputs({inputRoot: root, signal: controller.signal}), /cancelled/);
});

test('serialized or forged admissions never authorize writes or rechecks', async () => {
  const forged = {kind: 'hosted-source-input-admission-1', qualification: false};
  await assert.rejects(recheckHostedInputs(forged), /Live input admission/);
  await assert.rejects(prepareHostedSourceInputs({admission: forged, outputRoot: '/not-created'}), /Live input admission/);
});

test('a persisted preparation receipt must match its explicit hash and fixed manifest', async t => {
  const root = await fixture(t), path = join(root, 'prepared.json');
  const value = {kind: 'hosted-source-input-preparation-1', inputRoot: root, manifest: ref(join(root, 'INPUTS.json')), sources: [], qualification: false};
  const bytes = JSON.stringify(value); await writeFile(path, bytes, {mode: 0o600});
  await assert.rejects(recheckHostedPreparation({receiptPath: path, receiptSha256: '0'.repeat(64)}), /content differs/);
  await assert.rejects(recheckHostedPreparation({receiptPath: path, receiptSha256: sha(bytes)}), /manifest differs/);
});

test('the CLI rejects alternate modes, missing arguments and option injection', async () => {
  for (const args of [[], ['install'], ['prepare','--input-root','/a'], ['recheck','--receipt','/a','--shell','anything'], ['prepare','--input-root','/a','--manifest','/b','--output','/c','--extra']]) {
    await assert.rejects(hostedInputsMain(args), /fixed prepare or recheck arguments/);
  }
});

test('the CLI identity contract admits only matching nonzero real/effective IDs', () => {
  const identity = {uid: 1001, gid: 1001, euid: 1001, egid: 1001};
  const admitted = validateHostedCliIdentity(identity); assert.deepEqual(admitted, identity); assert(Object.isFrozen(admitted));
});

test('root, privileged identity mismatches and malformed CLI identity observations refuse', () => {
  for (const identity of [
    {uid: 0, gid: 0, euid: 0, egid: 0}, {uid: 1001, gid: 0, euid: 1001, egid: 0},
    {uid: 1001, gid: 1001, euid: 0, egid: 1001}, {uid: 1001, gid: 1001, euid: 1001, egid: 0},
    {uid: 1001, gid: 1001, euid: 1002, egid: 1001}, {uid: 1001, gid: 1001, euid: 1001, egid: 1002},
    {uid: -1, gid: 1001, euid: -1, egid: 1001}, {uid: 1.5, gid: 1001, euid: 1.5, egid: 1001},
    {uid: undefined, gid: 1001, euid: undefined, egid: 1001}, {uid: 1001, gid: 1001, euid: 1001, egid: 1001, privileged: false},
  ]) assert.throws(() => validateHostedCliIdentity(identity), /nonzero real\/effective/);
});

test('schema16 typed foreign-source collection preserves original bytes and rejects unrelated live references', async t => {
  const {stdout, stderr} = await promisify(execFile)('python3', ['-I','-S','-B', join(repo, 'tests/qualification/fixtures/schema16-foreign-source.py'), join(repo, 'tooling/rollback-producer/schema16')],
    {cwd: repo, env: {PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1', LANG: 'C'}, timeout: 30_000, maxBuffer: 65536});
  const result = JSON.parse(stdout); assert.equal(result.failures, 0); assert.equal(result.errors, 0); assert.equal(result.tests, 10); t.diagnostic(stderr.trim());
});
