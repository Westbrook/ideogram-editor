// Fixed receipt transport only; the renderer registry remains the approval authority.
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {lstat, mkdir, mkdtemp, readFile, realpath, writeFile} from 'node:fs/promises';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {boundedChild} from './container/bounded-child.mjs';
import {copySealedFile, fixtureRequirements, prepareInputs, verifyInputs, installInputs, verifyInstalledInputs} from './container/inputs.mjs';
import {REVIEWED_RENDERER_OWNERSHIP} from './campaigns/renderer-ownership.mjs';

export const rendererReceiptOwner = 'tests/campaigns/renderer-ownership-approved.test.mjs';
const descriptorURL = new URL('./r18-ci-inputs.json', import.meta.url);
const remote = 'https://github.com/Westbrook/ideogram-editor.git';
const reviewId = 'ie-r18-6d08921-20261004';
const maximumBytes = 32 * 1024 * 1024;
const digest = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = rows => [...rows].sort((a, b) => a.path.localeCompare(b.path));
const seal = bytes => ({bytes: bytes.length, sha256: digest(bytes)});
const require = (condition, message) => { if (!condition) throw Error(message); };
const safePath = path => typeof path === 'string' && path.startsWith('artifacts/') && !path.includes('\\') && !path.includes('\0') && path.split('/').every(part => part && part !== '.' && part !== '..') && /^[A-Za-z0-9_./-]+$/.test(path);

// Pure shape/pairing admission is separately testable. Production supplies only
// the compiled literal registry and maintained fixture requirements below.
export function validateRendererReceiptDescriptor(value, reviews, fixtures) {
  require(value && same(Object.keys(value).sort(), ['commit', 'files', 'kind', 'qualification', 'repository', 'reviewId', 'totalBytes', 'tree']) && value.kind === 'r18-ci-receipt-inputs-1' && value.qualification === false && value.repository === remote && value.reviewId === reviewId, 'Fixed renderer receipt descriptor required');
  require(/^[a-f0-9]{40}$/.test(value.commit ?? '') && /^[a-f0-9]{40}$/.test(value.tree ?? ''), 'Root-issued renderer input commit and tree are required');
  require(Array.isArray(value.files) && value.files.length === 12, 'Exactly twelve renderer receipt inputs required');
  const paths = new Set(); let bytes = 0;
  for (const row of value.files) {
    require(row && same(Object.keys(row).sort(), ['bytes', 'path', 'sha256']) && safePath(row.path) && !paths.has(row.path) && Number.isSafeInteger(row.bytes) && row.bytes > 0 && /^[a-f0-9]{64}$/.test(row.sha256), 'Invalid or duplicate renderer receipt input');
    paths.add(row.path); bytes += row.bytes;
    const matches = fixtures.filter(item => item.path === row.path);
    require(matches.length === 1 && same(matches[0], row), 'Renderer receipt does not match maintained fixture seal');
  }
  require(bytes === value.totalBytes && bytes <= maximumBytes, 'Renderer receipt input bound differs');
  const matches = reviews.filter(row => row.id === reviewId);
  require(matches.length === 1, 'Exact approved renderer row is required');
  const pins = matches[0].appAllocation?.runtimeInputs;
  require(Array.isArray(pins) && pins.length === 12 && pins.every(pin => pin.role === 'correctness-receipt' && /^sha256:[a-f0-9]{64}$/.test(pin.sha256)), 'Approved renderer runtime input closure differs');
  require(same(sorted(pins.map(pin => ({path: pin.path, bytes: pin.bytes, sha256: pin.sha256.slice(7)}))), sorted(value.files)), 'Renderer descriptor differs from approved runtime receipts');
  return structuredClone(value);
}
export function rendererReceiptRequirement() {
  return validateRendererReceiptDescriptor(JSON.parse(readFileSync(descriptorURL)), REVIEWED_RENDERER_OWNERSHIP, fixtureRequirements);
}

const gitEnvironment = () => ({PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https'});
function git(root, args, maxBuffer = maximumBytes + 65536) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'credential.helper=', '-c', 'http.followRedirects=false', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-C', root, ...args],
    {env: gitEnvironment(), timeout: 120_000, maxBuffer, stdio: ['ignore', 'pipe', 'pipe']});
}
async function canonicalDirectory(path) {
  require(resolve(path) === path && await realpath(path) === path, 'Receipt directory must be canonical');
  const info = await lstat(path); require(info.isDirectory() && !info.isSymbolicLink(), 'Receipt directory must be real');
}
async function absent(path) {
  try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw Error('Refusing existing renderer receipt destination: ' + path);
}
async function parents(root, relative, create) {
  require(safePath(relative), 'Unsafe renderer receipt path');
  await canonicalDirectory(root);
  let parent = root;
  for (const part of relative.split('/').slice(0, -1)) {
    parent = join(parent, part);
    if (create) try { await mkdir(parent, {mode: 0o700}); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    try { const info = await lstat(parent); require(info.isDirectory() && !info.isSymbolicLink(), 'Renderer receipt parent must be a real directory'); }
    catch (error) { if (!create && error.code === 'ENOENT') return; throw error; }
  }
}
async function verifyFile(root, expected) {
  await parents(root, expected.path, false);
  const path = join(root, expected.path), info = await lstat(path);
  require(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size === expected.bytes, 'Renderer receipt must be an exact regular unaliased file');
  const actual = seal(await readFile(path));
  require(same(actual, {bytes: expected.bytes, sha256: expected.sha256}), 'Renderer receipt byte identity differs');
  return {path: expected.path, ...actual};
}

// Validate the actual commit object, not rev-list --parents: a shallow boundary
// can hide parents from traversal, but cannot erase them from these raw bytes.
export function validateRendererInputGit(commitBytes, treeBytes, descriptor) {
  const text = commitBytes.toString('utf8'), boundary = text.indexOf('\n\n');
  require(boundary > 0, 'Malformed renderer input commit');
  const headers = text.slice(0, boundary).split('\n');
  require(headers.filter(line => line.startsWith('tree ')).length === 1 && headers[0] === 'tree ' + descriptor.tree && !headers.some(line => line.startsWith('parent ')), 'Renderer input commit must have the exact tree and no parents');
  const raw = treeBytes.toString('utf8'); require(raw.endsWith('\0'), 'Malformed renderer input tree');
  const rows = raw.slice(0, -1).split('\0').map(line => {
    const match = /^(100644) blob ([a-f0-9]{40}) +([0-9]+)\t([^\0]+)$/.exec(line);
    require(match && safePath(match[4]), 'Renderer input tree has a nonregular or unsafe member');
    return {path: match[4], object: match[2], bytes: Number(match[3])};
  });
  require(new Set(rows.map(row => row.path)).size === rows.length && same(sorted(rows.map(({path, bytes}) => ({path, bytes}))), sorted(descriptor.files.map(({path, bytes}) => ({path, bytes})))), 'Renderer input tree membership differs');
  return rows;
}

// This transport primitive grants no approval and performs no fetch. Small real
// Git fixtures exercise the maintained prepare/install chain and copy guards.
export async function stageRendererReceiptCopies({source, packet, recipient, checkout, descriptor}) {
  await canonicalDirectory(source); await canonicalDirectory(checkout);
  require(Array.isArray(descriptor.files) && descriptor.files.length > 0 && descriptor.files.length <= 12 && descriptor.files.every(row => safePath(row.path)), 'Invalid receipt transport members');
  await absent(packet); await absent(recipient);
  for (const row of descriptor.files) { await parents(checkout, row.path, false); await absent(join(checkout, row.path)); }
  const commit = git(source, ['cat-file', 'commit', descriptor.commit], 65536);
  const tree = git(source, ['ls-tree', '-r', '-l', '-z', descriptor.commit], 65536);
  const rows = validateRendererInputGit(commit, tree, descriptor);
  for (const row of rows) {
    const expected = descriptor.files.find(item => item.path === row.path), bytes = git(source, ['cat-file', 'blob', row.object], expected.bytes + 1);
    require(same(seal(bytes), {bytes: expected.bytes, sha256: expected.sha256}), 'Fetched renderer receipt seal differs');
    await parents(source, row.path, true); await writeFile(join(source, row.path), bytes, {flag: 'wx', mode: 0o444});
  }
  const history = [{commit: descriptor.commit, paths: descriptor.files.map(row => row.path)}], fixtures = descriptor.files;
  const prepared = await prepareInputs({root: source, output: packet, history, fixtures});
  const verified = await verifyInputs({packet, history, fixtures});
  await mkdir(recipient, {mode: 0o700});
  const installed = await installInputs({root: recipient, packet, history, fixtures});
  const before = await verifyInstalledInputs({root: recipient, packet, history, fixtures});
  const copied = [];
  for (const row of fixtures) {
    await verifyFile(recipient, row); await parents(checkout, row.path, true);
    await copySealedFile({source: join(recipient, row.path), destination: join(checkout, row.path), expected: row});
    copied.push(await verifyFile(checkout, row));
  }
  const after = await verifyInstalledInputs({root: recipient, packet, history, fixtures});
  require(same(before, after), 'Installed renderer recipient changed during checkout copy');
  for (const row of fixtures) await verifyFile(checkout, row);
  require(prepared.sha256 === verified.manifestSha256 && installed.manifestSha256 === verified.manifestSha256, 'Renderer input packet joins differ');
  return {packetManifestSha256: verified.manifestSha256, recipientGitSha256: after.installed.gitSha256, copied, qualification: false};
}

async function worker(root, work) {
  const expected = rendererReceiptRequirement();
  await canonicalDirectory(root); await canonicalDirectory(work);
  require(dirname(work) === join(root, 'artifacts/validation') && /^r18-inputs-[A-Za-z0-9]+$/.test(work.slice(dirname(work).length + 1)), 'Fixed private renderer setup leaf required');
  const headBefore = git(root, ['rev-parse', '--verify', 'HEAD'], 65536).toString().trim();
  const receipt = {kind: 'fast-renderer-receipt-provisioning-1', qualification: false, expected, status: 'PENDING', work, headBefore};
  const path = join(work, 'receipt.json');
  try {
    const source = join(work, 'source'), packet = join(work, 'packet'), recipient = join(work, 'recipient');
    await mkdir(source, {mode: 0o700});
    git(source, ['init', '--quiet', '--template=']);
    git(source, ['fetch', '--no-tags', '--depth=1', '--no-recurse-submodules', expected.repository, expected.commit], 65536);
    require(git(source, ['rev-parse', '--verify', 'FETCH_HEAD'], 65536).toString().trim() === expected.commit, 'Fetched renderer commit differs');
    receipt.transport = await stageRendererReceiptCopies({source, packet, recipient, checkout: root, descriptor: expected});
    receipt.status = 'PASS';
  } catch (error) { receipt.status = 'FAIL'; receipt.error = String(error); throw error; }
  finally {
    try { receipt.headAfter = git(root, ['rev-parse', '--verify', 'HEAD'], 65536).toString().trim(); require(receipt.headAfter === headBefore, 'Renderer transport changed checkout HEAD'); }
    catch (error) { receipt.status = 'FAIL'; receipt.error ??= String(error); throw error; }
    finally { await writeFile(path, JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx', mode: 0o600}); }
  }
  const bytes = await readFile(path);
  return {kind: receipt.kind, status: 'PASS', qualification: false, expected, receipt: {path, ...seal(bytes)}, files: expected.files};
}
export async function provisionRendererReceiptChild(root) {
  root = resolve(root); rendererReceiptRequirement(); await canonicalDirectory(root);
  const output = join(root, 'artifacts/validation');
  await parents(root, 'artifacts/validation/placeholder', true);
  const work = await mkdtemp(join(output, 'r18-inputs-'));
  const stdout = [], stderr = [], abort = new AbortController(); let stdoutBytes = 0, stderrBytes = 0;
  const capture = (chunks, which) => bytes => {
    if (which === 'stdout') stdoutBytes += bytes.length; else stderrBytes += bytes.length;
    if ((which === 'stdout' ? stdoutBytes : stderrBytes) > 65536) { abort.abort('Renderer receipt child output exceeds bound'); return; }
    chunks.push(bytes);
  };
  let result, failure;
  const interrupt = signal => abort.abort('Renderer receipt supervisor received ' + signal);
  const term = () => interrupt('SIGTERM'), int = () => interrupt('SIGINT');
  process.once('SIGTERM', term); process.once('SIGINT', int);
  try {
    result = await boundedChild(process.execPath, [fileURLToPath(import.meta.url), '--worker', root, work], {
      cwd: root, env: process.env, timeoutMs: 10 * 60_000, graceMs: 5_000, abortSignal: abort.signal,
      onStdout: capture(stdout, 'stdout'), onStderr: capture(stderr, 'stderr'),
    });
  } catch (error) { failure = String(error); throw error; }
  finally {
    process.removeListener('SIGTERM', term); process.removeListener('SIGINT', int);
    await writeFile(join(work, 'child-closure.json'), JSON.stringify({kind: 'renderer-receipt-child-closure-1', qualification: false, failure: failure ?? null, result: result ?? null, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), stdoutBytes, stderrBytes}, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  }
  require(result.code === 0 && !result.signal && !result.timedOut && !result.interrupted && !abort.signal.aborted, 'Renderer receipt child did not close successfully; retained ' + work);
  const value = JSON.parse(Buffer.concat(stdout));
  require(value.status === 'PASS' && same(value.expected, rendererReceiptRequirement()) && value.receipt?.path === join(work, 'receipt.json') && same(seal(await readFile(value.receipt.path)), {bytes: value.receipt.bytes, sha256: value.receipt.sha256}), 'Renderer receipt child result differs');
  return value;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 5 && process.argv[2] === '--worker') process.stdout.write(JSON.stringify(await worker(resolve(process.argv[3]), resolve(process.argv[4]))) + '\n');
  else if (process.argv.length === 3) process.stdout.write(JSON.stringify(await provisionRendererReceiptChild(process.argv[2])) + '\n');
  else throw Error('Usage: r18-ci-inputs.mjs <owned-checkout>');
}
