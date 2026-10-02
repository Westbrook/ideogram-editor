// Qualification-only control of the provider fixture inside a retained LocalWriter.
// Nothing in the application imports this module or discovers these files.
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

export const QUEUE_WORKER_MODULE = new URL('./backend-queue-worker.mjs', import.meta.url).href;
export const QUEUE_CONFIG_FILE = 'qualification-queue-config.json';
export const QUEUE_READY_FILE = 'qualification-queue-ready.json';
const MAX_JSON = 65536;
const SHA = /^sha256:[a-f0-9]{64}$/;
// Deliberately plain data: worker-control imports cannot depend on the module
// that constructs the provider. A regression checks parity with fastManifest.
export const FAST_QUEUE_FIXTURE_FAMILIES = Object.freeze([
  { caseId: 'WF01', speed: 'TURBO', expansion: 'None', width: 512, height: 512, count: 1, format: 'png' },
  { caseId: 'WF02', speed: 'TURBO', expansion: 'Medium', width: 1024, height: 1024, count: 4, format: 'jpeg' },
  { caseId: 'WF03', speed: 'BALANCED', expansion: 'None', width: 2048, height: 2048, count: 1, format: 'jpeg' },
  { caseId: 'WF04', speed: 'BALANCED', expansion: 'Medium', width: 512, height: 512, count: 4, format: 'png' },
  { caseId: 'WF05', speed: 'QUALITY', expansion: 'None', width: 1024, height: 1024, count: 1, format: 'png' },
  { caseId: 'WF06', speed: 'QUALITY', expansion: 'Medium', width: 2048, height: 2048, count: 4, format: 'jpeg' },
].map(Object.freeze));

function fixtureRequired(condition, message) {
  if (!condition) throw Object.assign(Error(message), { code: 'FIXTURE_REQUIRED' });
}

/** The campaign fixture loader verifies the complete seal before this selector.
 * A valid Fast cell must carry its exact sealed image family into the worker;
 * missing input is a preparation failure, never a substitute PNG specimen. */
export function selectQueueResultFixture(context = {}, cell = context.queueFixtureCell) {
  const caseId = typeof cell === 'string' ? cell : cell?.parameters?.caseId ?? cell?.caseId;
  const manifest = FAST_QUEUE_FIXTURE_FAMILIES.find(row => row.caseId === caseId);
  if (!manifest) return null;
  const fixture = context.fixture, families = fixture?.corpus?.fast?.validFamilies;
  fixtureRequired(SHA.test(fixture?.seal?.sha256 ?? ''), caseId + ' requires a sealed Fast corpus');
  fixtureRequired(Array.isArray(families) && families.length === FAST_QUEUE_FIXTURE_FAMILIES.length && FAST_QUEUE_FIXTURE_FAMILIES.every((expected, index) => {
    const actual = families[index]; return actual && Object.keys(actual).length === Object.keys(expected).length && Object.keys(expected).every(key => actual[key] === expected[key]);
  }), caseId + ' sealed Fast family manifest does not match the six campaign cases');
  const files = Array.from({ length: manifest.count }, (_, index) => {
    const id = `wf-${manifest.width}-${manifest.format}-${index}`;
    const matches = fixture.corpus.files?.filter(file => file.id === id) ?? [];
    fixtureRequired(matches.length === 1, caseId + ' requires exactly one sealed candidate ' + id);
    const file = matches[0];
    fixtureRequired(file.role === 'fast-candidate' && file.width === manifest.width && file.height === manifest.height && file.format === manifest.format && file.index === index,
      caseId + ' candidate identity, dimensions, format, or batch index changed: ' + id);
    fixtureRequired(SHA.test(file.sha256 ?? '') && /^[1-9][0-9]*$/.test(String(file.byteLength)) && BigInt(file.byteLength) <= BigInt(Number.MAX_SAFE_INTEGER)
      && typeof file.path === 'string' && file.path.length > 0, caseId + ' candidate has no complete sealed byte identity: ' + id);
    return { id, role: file.role, path: resolve(fixture.root ?? context.repo ?? process.cwd(), file.path), byteLength: String(file.byteLength), sha256: file.sha256,
      width: file.width, height: file.height, format: file.format, index };
  });
  return { kind: 'fast-valid-result-family', caseId, manifest: { ...manifest }, fixtureSeal: fixture.seal.sha256, files };
}

export async function readPrivateJSON(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    assert(stat.isFile() && stat.nlink === 1 && (stat.mode & 0o077) === 0, 'Private regular qualification file required');
    if (process.getuid) assert.equal(stat.uid, process.getuid(), 'Qualification file owner mismatch');
    assert(stat.size > 0 && stat.size <= MAX_JSON, 'Qualification JSON size invalid');
    return JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
}

export async function writePrivateJSON(path, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  assert(bytes.length <= MAX_JSON, 'Qualification JSON exceeds control bound');
  const temporary = path + '.' + randomUUID() + '.tmp';
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { await file.writeFile(bytes); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

/** Call before openWriter. Only the selected image fixture, repository path and
 * nonce cross into the worker; environment variables and credentials do not. */
export async function prepareQueueWorker(root, context = {}) {
  const resultFixture = selectQueueResultFixture(context);
  const selected = context.fixture?.corpus?.files?.find(file => ['candidate-result', 'candidate', 'fast-fault-candidate'].includes(file.role) && Number(file.byteLength) === 8 * 1024 * 1024);
  const config = {
    schema: 'qualification-queue-worker-1', root: resolve(root), repo: resolve(context.repo ?? process.cwd()),
    diagnosticOutput: resolve(context.output ?? dirname(root)),
    nonce: randomBytes(32).toString('hex'),
    fixture: selected ? { corpus: { files: [{ role: selected.role, path: resolve(context.fixture.root ?? context.repo ?? process.cwd(), selected.path), byteLength: String(selected.byteLength), sha256: selected.sha256, width: selected.width, height: selected.height }] } } : null,
    resultFiles: resultFixture?.files ?? null, resultFixture,
  };
  await unlink(join(root, QUEUE_READY_FILE)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await writePrivateJSON(join(root, QUEUE_CONFIG_FILE), config);
  return { setupModule: QUEUE_WORKER_MODULE };
}

/** openWriter resolves only after fixture setup has published this descriptor. */
export async function connectQueueWorker(root, { signal } = {}) {
  const config = await readPrivateJSON(join(root, QUEUE_CONFIG_FILE));
  const ready = await readPrivateJSON(join(root, QUEUE_READY_FILE));
  assert.equal(config.schema, 'qualification-queue-worker-1');
  assert.equal(ready.schema, 'qualification-queue-worker-ready-1');
  assert.equal(ready.root, resolve(root));
  assert.equal(config.root, ready.root);
  assert.equal(ready.nonce, config.nonce, 'Stale worker descriptor');
  assert.match(config.nonce, /^[0-9a-f]{64}$/);
  const url = new URL(ready.origin);
  assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
  assert(url.port && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash);
  let closed = false;
  async function command(operation, args = {}) {
    signal?.throwIfAborted();
    assert(!closed, 'Qualification worker controller closed');
    const response = await fetch(url.origin + '/control', {
      method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000),
      headers: { Authorization: 'Bearer ' + config.nonce, 'Content-Type': 'application/json' },
      body: JSON.stringify({ schema: 'qualification-queue-command-1', epoch: ready.epoch, operation, args }),
    });
    const value = await response.json();
    if (!response.ok || !value.ok) throw Object.assign(Error(value.error?.message ?? 'Qualification worker command rejected'), { name: value.error?.name ?? 'Error', code: value.error?.code ?? 'FIXTURE_CONTROL' });
    return value.result;
  }
  return {
    descriptor: Object.freeze({ origin: url.origin, epoch: ready.epoch, threadId: ready.threadId, root: ready.root }),
    configure: (endpoint, options = {}) => command('configure', { endpoint, options }),
    submit: jobId => command('submit', { jobId }),
    observeStatus: (jobId, attemptId, status) => command('observeStatus', { jobId, attemptId, status }),
    readKnown: (jobId, attemptId, kind) => command('readKnown', { jobId, attemptId, kind }),
    proxyPair: (jobId, attemptId) => command('proxyPair', { jobId, attemptId }),
    tick: endpoint => command('tick', { endpoint }),
    snapshot: endpoint => command('snapshot', { endpoint }),
    cacheOwner: () => command('cacheOwner'),
    resources: () => command('resources'),
    closeNamespace: endpoint => command('closeNamespace', { endpoint }),
    setSnapshotBoundary: boundary => command('setSnapshotBoundary', { boundary }),
    resetFixture: () => command('resetFixture'),
    close: () => { closed = true; },
  };
}
