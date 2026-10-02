import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, parse, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';

// Only these executable snapshots are admitted. Parent commits and unrelated
// blobs are not copied, even when the source checkout has private Git objects.
const code = ['server', 'src', 'tooling', 'tsconfig.server.json'];
const withTests = ['server', 'src', 'tests', 'tooling', 'tsconfig.server.json'];
export const historyRequirements = [
  ['7ef07dda92279cc632d82e18d008c74ff99ee851', code],
  ['e1a0092eeb0022c445bb348d0602fa0a727c3aee', code],
  ['e8b9f1a379becd97365242cc0a3b1c9d703bcfcb', code],
  ['dfa383d56d21bc9c7bb40248db8a503fe33e6e46', code],
  ['7388d1e625a6ac2c563bc64cca6318d264649acc', code],
  ['92e5247ed3279f25292f8e312661bf3b12deffe7', code],
  ['d84c1de55709bbd957222cac854905c41583a4e4', code],
  ['dcd5f11dbd57cd7ed00c8ddf410857ce4700440e', withTests],
  ['d4ed76148999978565ca8b37d27612f5b3faa591', withTests],
  ['4b2c82ccc41dd72c3f83480f23481b7b62135d23', withTests],
  ['ecbcc79e9fa8e89acf84c2bb02831b780582ed88', withTests],
  ['d3b8e5f5ec4568547f21a2826792450367144a17', withTests],
  ['d3c6046a44d29d89ccdcb219cc37d40f02bad84f', withTests],
  ['9764b03ae889ae2fe2cf5d38e9e8e66bd6cf2eb4', withTests],
  ['086c9a677512f1faae98f9e947084ffb93c09431', withTests],
  ['5650326b623d4aa2080772307708aa9f1854aa52', withTests],
  ['8901d923f309125c5bc19605efe76a871a7ee1df', code],
].map(([commit, paths]) => ({ commit, paths }));

export const fixtureRequirements = [
  ['evidence/p1b6-correction/original-review/drop-transaction-prefix.zip', 23385, 'a0dcad5ba6fe2fbb76149cc898aa6981d6bcdaae38fde2e81cae0954bc017ddd'],
  ['evidence/p1b6-correction/original-review/hostile-duplicate-event-id.zip', 25163, 'c6e2adf81f2372c97cac0e4703fa184ac6c9f10866b5000219baba5769fe2c26'],
  ['evidence/p1b6-correction/original-review/hostile-split-one-command.zip', 25146, 'e6f642af807db51f74d402467f818bb05227edee910bb440442a774361fe620b'],
  ['evidence/p1b6-linkage-correction/original-review/format2-domain-revision-hidden-by-tail.zip', 28469, 'c43bb855a4fadc6410ec1801103fb2f361281cb49d653d56fe43e788105c153c'],
  ['evidence/p1b6-linkage-correction/original-review/revision-tail-control-2.zip', 28467, '23ef675fb48394f2396e233c2e9326a801f46e33acfa6d8ea8206dae3630a94e'],
  ['evidence/p1b6-linkage-correction/original-review/revision-tail-control-null.zip', 28468, '9770d1a9ace1cc6f5e2993ce77d9f7ff1910029cd59237623e70d0fa7a326283'],
  ['artifacts/p27-evidence/fal-public-lora-example/provider-example.safetensors', 85299896, 'bd0b96a2fcc3141400ebeffd8585b2d3c4c0d475b10e1468ba5c40acad748bc5'],
].map(([path, bytes, sha256]) => ({ path, bytes, sha256 }));
export const defaultPacket = 'artifacts/qualification-container-inputs';
export const adapterSourceURL = 'https://v3b.fal.media/files/b/0a9dc89d/NkZw9CyYSB3ojbDx2a2s5_ideogram_v4_lora.safetensors';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const gitEnv = () => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' });
const git = (root, args, input) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'pack.threads=1', '-C', root, ...args], { env: gitEnv(), input, maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });

function safePath(path) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) throw Error(`Unsafe input path: ${path}`);
  return path;
}
async function regularPath(root, path) {
  safePath(path);
  for (const [index, part] of path.split('/').entries()) {
    const prefix = path.split('/').slice(0, index + 1).join('/');
    const info = await lstat(join(root, prefix));
    if (info.isSymbolicLink() || (index === path.split('/').length - 1 ? !info.isFile() : !info.isDirectory())) throw Error(`Input must be a regular file with real parent directories: ${path} (${part})`);
  }
  return join(root, path);
}
async function digest(path) {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(path)) { hash.update(chunk); bytes += chunk.length; }
  return { bytes, sha256: hash.digest('hex') };
}
export async function verifyAdapterFixture({ root = resolve('.'), path: requested } = {}) {
  const expected = fixtureRequirements.find(item => item.path.endsWith('/provider-example.safetensors'));
  const absolute = requested ? resolve(root, requested) : resolve(root, expected.path);
  const checkRoot = requested ? parse(absolute).root : resolve(root);
  const path = await regularPath(checkRoot, relative(checkRoot, absolute));
  const actual = await digest(path);
  if (!same(actual, { bytes: expected.bytes, sha256: expected.sha256 })) throw Error('Adapter fixture seal mismatch');
  return { path, ...actual };
}
export async function copySealedFile({ source, destination, expected }) {
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  if (!same(await digest(destination), { bytes: expected.bytes, sha256: expected.sha256 })) throw Error(`Copied fixture seal mismatch: ${expected.path}`);
  await chmod(destination, 0o444);
}
async function absentDestination(root, path) {
  safePath(path);
  if (!(await lstat(root)).isDirectory()) throw Error('Installation root must be a real directory');
  const parts = path.split('/');
  for (let index = 0; index < parts.length; index++) {
    let info;
    try { info = await lstat(join(root, ...parts.slice(0, index + 1))); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (index === parts.length - 1) throw Error(`Refusing to overwrite existing fixture: ${path}`);
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error(`Fixture destination parent must be a real directory: ${path}`);
  }
}
function validateRequirements(history, fixtures) {
  if (!history.length || !fixtures.length) throw Error('Input requirements cannot be empty');
  if (new Set(history.map(item => item.commit)).size !== history.length || new Set(fixtures.map(item => item.path)).size !== fixtures.length) throw Error('Duplicate input requirement');
  for (const item of history) {
    if (!/^[a-f0-9]{40}$/.test(item.commit) || !item.paths?.length) throw Error('Invalid historical commit requirement');
    item.paths.forEach(safePath);
  }
  for (const item of fixtures) {
    safePath(item.path);
    if (!Number.isSafeInteger(item.bytes) || item.bytes < 0 || !/^[a-f0-9]{64}$/.test(item.sha256)) throw Error('Invalid fixture seal');
  }
}
function objectsFor(root, history) {
  const objects = new Set();
  for (const { commit, paths } of history) {
    if (git(root, ['cat-file', '-t', commit]).toString().trim() !== 'commit') throw Error(`Historical input is not a commit: ${commit}`);
    objects.add(commit);
    objects.add(git(root, ['rev-parse', `${commit}^{tree}`]).toString().trim());
    // git archive walks sibling directory trees while resolving pathspecs.
    // Retain their directory metadata, never their unrelated file contents.
    const allEntries = git(root, ['ls-tree', '-r', '-t', '-z', commit]).toString().split('\0').filter(Boolean);
    for (const record of allEntries) {
      const tree = /^040000 tree ([a-f0-9]{40})\t/.exec(record);
      if (tree) objects.add(tree[1]);
    }
    // Include ancestor .gitattributes so git archive semantics are preserved.
    const records = git(root, ['ls-tree', '-r', '-t', '-z', commit, '--', ...paths, '.gitattributes']).toString().split('\0').filter(Boolean);
    for (const record of records) {
      const match = /^(\d+) (blob|tree) ([a-f0-9]{40})\t/.exec(record);
      if (!match || match[1] === '160000') throw Error(`Unsupported historical tree entry: ${record}`);
      objects.add(match[3]);
    }
  }
  return [...objects].sort();
}
async function writePack(root, objects, destination) {
  const child = spawn('git', ['-c', 'pack.threads=1', '-C', root, 'pack-objects', '--stdout', '--no-reuse-delta'], { env: gitEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  let errorText = ''; child.stderr.on('data', chunk => { errorText += chunk.toString(); });
  const ended = new Promise((res, rej) => { child.on('error', rej); child.on('close', (code, signal) => code === 0 ? res() : rej(Error(`Git input pack failed (${code}, ${signal}): ${errorText}`))); });
  child.stdin.end(objects.join('\n') + '\n');
  await Promise.all([pipeline(child.stdout, createWriteStream(destination, { flags: 'wx', mode: 0o444 })), ended]);
}
async function inventory(root, prefix = '') {
  const result = [];
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await inventory(root, path));
    else if (entry.isFile()) result.push(path);
    else throw Error(`Unexpected packet entry: ${path}`);
  }
  return result.sort();
}
async function openPacketHistory(packet, directory, manifest) {
  git(directory, ['init', '--quiet', '--template=', '--initial-branch=qualification-inputs']);
  await writeFile(join(directory, '.git/shallow'), manifest.history.requirements.map(item => item.commit).join('\n') + '\n');
  const pack = join(directory, '.git/objects/pack/inputs.pack');
  await copyFile(join(packet, 'history.pack'), pack, constants.COPYFILE_EXCL);
  // This deliberately partial tree omits unrelated blobs. index-pack checks
  // packed object identities; full connectivity checks would demand the very
  // private objects excluded by this protocol. The exact selected closure and
  // every requested archive are independently checked immediately below.
  git(directory, ['index-pack', pack]);
  verifyHistory(directory, manifest);
}
function verifyHistory(directory, manifest) {
  const objects = git(directory, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname)']).toString().trim().split('\n').sort();
  if (!same(objects, manifest.history.objects)) throw Error('Historical pack object inventory does not match seal');
  if (!same(objectsFor(directory, manifest.history.requirements), objects)) throw Error('Historical pack contains unrelated or missing objects');
  for (const requirement of manifest.history.requirements) {
    const archive = git(directory, ['archive', requirement.commit, ...requirement.paths]);
    if (!same({ bytes: archive.length, sha256: sha256(archive) }, requirement.archive)) throw Error(`Historical archive changed: ${requirement.commit}`);
  }
}

export async function prepareInputs({ root = resolve('.'), output = join(root, defaultPacket), adapterFixture, history = historyRequirements, fixtures = fixtureRequirements } = {}) {
  validateRequirements(history, fixtures);
  root = resolve(root); output = resolve(output);
  try { await lstat(output); throw Error(`Refusing to replace an existing input packet: ${output}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(dirname(output), { recursive: true });
  const staging = await mkdtemp(join(dirname(output), '.qualification-inputs-'));
  try {
    const sealedFixtures = [];
    for (const fixture of fixtures) {
      const source = adapterFixture && fixture.path.endsWith('/provider-example.safetensors') ? resolve(adapterFixture) : await regularPath(root, fixture.path);
      if (!(await lstat(source)).isFile()) throw Error(`Fixture is not a regular file: ${fixture.path}`);
      const actual = await digest(source);
      if (!same(actual, { bytes: fixture.bytes, sha256: fixture.sha256 })) throw Error(`Fixture seal mismatch: ${fixture.path}`);
      const path = `fixtures/${fixture.path}`;
      await mkdir(dirname(join(staging, path)), { recursive: true });
      await copySealedFile({ source, destination: join(staging, path), expected: fixture });
      sealedFixtures.push({ ...fixture, packetPath: path });
    }
    const objects = objectsFor(root, history);
    await writePack(root, objects, join(staging, 'history.pack'));
    const requirements = history.map(requirement => {
      const archive = git(root, ['archive', requirement.commit, ...requirement.paths]);
      return { ...requirement, archive: { bytes: archive.length, sha256: sha256(archive) } };
    });
    const manifest = { kind: 'qualification-container-inputs-1', qualification: false,
      scope: 'Selected historical executable sources, directory tree metadata, and exact local test fixtures only. Tree metadata retains historical names and object IDs. No Git configuration, remotes, credentials, parent history, or unrelated blob contents.',
      history: { path: 'history.pack', ...await digest(join(staging, 'history.pack')), objects, requirements }, fixtures: sealedFixtures };
    await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o444 });
    await verifyInputs({ packet: staging, history, fixtures });
    await rename(staging, output);
    return { output, ...await digest(join(output, 'manifest.json')), commits: history.length, objects: objects.length, fixtures: fixtures.length, qualification: false };
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}

export async function verifyInputs({ packet = resolve(defaultPacket), history = historyRequirements, fixtures = fixtureRequirements } = {}) {
  validateRequirements(history, fixtures); packet = resolve(packet);
  const bytes = await readFile(await regularPath(packet, 'manifest.json'));
  const manifest = JSON.parse(bytes);
  if (manifest.kind !== 'qualification-container-inputs-1' || manifest.qualification !== false || manifest.history?.path !== 'history.pack') throw Error('Unsupported input packet');
  const recorded = manifest.history.requirements?.map(({ commit, paths }) => ({ commit, paths }));
  if (!same(recorded, history) || !same(manifest.fixtures, fixtures.map(item => ({ ...item, packetPath: `fixtures/${item.path}` })))) throw Error('Packet requirements differ from pinned input closure');
  const expectedPaths = ['manifest.json', 'history.pack', ...manifest.fixtures.map(item => item.packetPath)].sort();
  if (!same(await inventory(packet), expectedPaths)) throw Error('Packet contains missing or unlisted files');
  for (const item of [manifest.history, ...manifest.fixtures.map(item => ({ ...item, path: item.packetPath }))]) {
    if (!same(await digest(await regularPath(packet, item.path)), { bytes: item.bytes, sha256: item.sha256 })) throw Error(`Packet file seal mismatch: ${item.path}`);
  }
  const temporary = await mkdtemp(join(tmpdir(), 'qualification-input-verification-'));
  try { await openPacketHistory(packet, temporary, manifest); } finally { await rm(temporary, { recursive: true, force: true }); }
  return { manifest, manifestSha256: sha256(bytes), qualification: false };
}

export async function installInputs({ root = resolve('.'), packet = join(root, defaultPacket), history = historyRequirements, fixtures = fixtureRequirements } = {}) {
  root = resolve(root);
  const result = await verifyInputs({ packet, history, fixtures });
  // Installation is only for a copied source tree, never an owned checkout.
  try { await lstat(join(root, '.git')); throw Error('Refusing to install over an existing Git checkout'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const fixture of fixtures) await absentDestination(root, fixture.path);
  await openPacketHistory(packet, root, result.manifest);
  for (const fixture of result.manifest.fixtures) {
    await mkdir(dirname(join(root, fixture.path)), { recursive: true });
    await copySealedFile({ source: await regularPath(packet, fixture.packetPath), destination: join(root, fixture.path), expected: fixture });
  }
  return { manifestSha256: result.manifestSha256, commits: history.length, fixtures: fixtures.length, qualification: false };
}

export async function verifyInstalledInputs({ root = resolve('.'), packet = join(root, defaultPacket), history = historyRequirements, fixtures = fixtureRequirements } = {}) {
  root = resolve(root);
  const result = await verifyInputs({ packet, history, fixtures });
  if (!(await lstat(join(root, '.git'))).isDirectory()) throw Error('Installed Git metadata must be a real directory');
  verifyHistory(root, result.manifest);
  const gitFiles = [];
  for (const path of await inventory(join(root, '.git'))) gitFiles.push({ path, ...await digest(await regularPath(join(root, '.git'), path)) });
  const installedFixtures = [];
  for (const fixture of fixtures) {
    const actual = await digest(await regularPath(root, fixture.path));
    if (!same(actual, { bytes: fixture.bytes, sha256: fixture.sha256 })) throw Error(`Installed fixture seal mismatch: ${fixture.path}`);
    installedFixtures.push({ path: fixture.path, ...actual });
  }
  return { manifest: result.manifest, manifestSha256: result.manifestSha256,
    installed: { gitFiles, gitSha256: sha256(JSON.stringify(gitFiles)), fixtures: installedFixtures }, qualification: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [operation, ...args] = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = ({ '--root': 'root', '--output': 'output', '--packet': 'packet', '--adapter-fixture': 'adapterFixture' })[args[index]];
    if (!key || !args[index + 1] || options[key] !== undefined) throw Error('Usage: inputs.mjs prepare|verify|install [--root path] [--output path] [--packet path] [--adapter-fixture path]');
    options[key] = resolve(args[index + 1]);
  }
  const operationFn = ({ prepare: prepareInputs, verify: verifyInputs, install: installInputs, 'verify-installed': verifyInstalledInputs })[operation];
  if (!operationFn) throw Error('Choose prepare, verify, install, or verify-installed');
  const result = await operationFn(options);
  if (operation === 'verify' || operation === 'verify-installed') delete result.manifest;
  console.log(JSON.stringify(result, null, 2));
}
